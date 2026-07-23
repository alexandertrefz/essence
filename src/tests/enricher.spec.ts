import { describe, expect, it } from "bun:test"

import { builtinNamespaces, builtinProtocols } from "../enricher/builtins"
import { enrich } from "../enricher/index"
import { computeConformanceMethodMap } from "../helpers/index"
import type { common } from "../interfaces/index"
import { parse } from "../parser/index"

function enrichSource(source: string): {
	program: common.typed.Program
	diagnostics: Array<common.Diagnostic>
} {
	return enrich(parse(source))
}

function diagnosticsFor(source: string): Array<common.Diagnostic> {
	return enrichSource(source).diagnostics
}

// NOTE: The LIVE Namespace of that name — the one read from `src/stdlib/*.es`
// and handed to every Program's top level Scope. Asserting against this rather
// than against a declaration read straight out of a source file is the point:
// a test about which Namespace declares a Method has to ask what a Program can
// actually reach. Throws rather than returning `undefined`, so a renamed or
// dropped Namespace fails as a missing Namespace instead of as a missing
// Method.
function builtinNamespace(name: string): common.NamespaceType {
	let namespace = builtinNamespaces().find(
		(candidate) => candidate.name === name,
	)

	if (namespace === undefined) {
		throw new Error(`There is no builtin Namespace named '${name}'`)
	}

	return namespace
}

// NOTE: Walks the typed Program collecting every resolved Conformance —
// wherever a bounded Type Parameter was satisfied, an Invocation carries the
// `{ genericName, protocolName, source }` shape. Used to assert which Namespace
// a bound resolved to at a call site.
function collectConformances(value: unknown): Array<common.Conformance> {
	let found: Array<common.Conformance> = []
	let seen = new WeakSet<object>()

	let visit = (node: unknown) => {
		if (Array.isArray(node)) {
			for (let element of node) {
				visit(element)
			}

			return
		}

		if (node === null || typeof node !== "object") {
			return
		}

		if (seen.has(node)) {
			return
		}

		seen.add(node)

		let record = node as Record<string, unknown>

		if (
			"genericName" in record &&
			"protocolName" in record &&
			"source" in record
		) {
			found.push(record as unknown as common.Conformance)
		}

		for (let key of Object.keys(record)) {
			visit(record[key])
		}
	}

	visit(value)

	return found
}

describe("Enricher", () => {
	describe("Diagnostics", () => {
		it("should report no Diagnostics for a valid Program", () => {
			expect(
				diagnosticsFor(`implementation {
					constant name = "essence"
					__print(name)
				}`),
			).toEqual([])
		})

		it("should report undeclared Variables", () => {
			let diagnostics = diagnosticsFor(`implementation {
				constant a = undeclaredVariable
			}`)

			expect(diagnostics).toHaveLength(1)
			expect(diagnostics[0].severity).toBe("error")
			expect(diagnostics[0].message).toBe(
				"'undeclaredVariable' is not declared",
			)
			expect(diagnostics[0].position?.start.line).toBe(2)
		})

		it("should report undeclared Types", () => {
			let diagnostics = diagnosticsFor(`implementation {
				constant a: UndeclaredType = "value"
			}`)

			expect(diagnostics).toHaveLength(1)
			expect(diagnostics[0].message).toBe(
				"Type 'UndeclaredType' is not declared",
			)
		})

		it("should report redeclared Variables", () => {
			let diagnostics = diagnosticsFor(`implementation {
				constant a = "first"
				constant a = "second"
			}`)

			expect(diagnostics).toHaveLength(1)
			expect(diagnostics[0].message).toBe(
				"Variable 'a' is already declared",
			)
			expect(diagnostics[0].position?.start.line).toBe(3)
		})

		it("should report redeclared Types", () => {
			let diagnostics = diagnosticsFor(`implementation {
				type Name = String
				type Name = Boolean
			}`)

			expect(diagnostics).toHaveLength(1)
			expect(diagnostics[0].message).toBe(
				"Type 'Name' is already declared",
			)
		})

		it("should report Method Invocations without a matching Namespace method", () => {
			let diagnostics = diagnosticsFor(`implementation {
				constant a = "value"::undeclaredMethod()
			}`)

			expect(diagnostics).toHaveLength(1)
			expect(diagnostics[0].code).toBe("unknown-method")
		})

		it("should report Method Invocations whose arguments match no overload", () => {
			let diagnostics = diagnosticsFor(`implementation {
				constant a = "value"::prepend()
			}`)

			expect(diagnostics).toHaveLength(1)
			expect(diagnostics[0].code).toBe("no-matching-overload")
		})

		it("should accept Method Invocations with matching argument labels", () => {
			expect(
				diagnosticsFor(`implementation {
					constant a = [1]::append(contentsOf [2])
				}`),
			).toEqual([])
		})

		it("should report Method Invocations with wrong argument labels", () => {
			let diagnostics = diagnosticsFor(`implementation {
				constant a = [1]::append(wrongLabel [2])
			}`)

			expect(diagnostics).toHaveLength(1)
			expect(diagnostics[0].code).toBe("no-matching-overload")
		})

		it("should report Combinations of non-Record Types", () => {
			let diagnostics = diagnosticsFor(`implementation {
				constant a = { "value" with name = "x" }
			}`)

			expect(diagnostics).toHaveLength(1)
			expect(diagnostics[0].message).toBe("Strings can not be combined")
		})

		it("should report Combinations whose right hand side is not a Partial", () => {
			let diagnostics = diagnosticsFor(`implementation {
				constant a = { name = "x" }
				constant b = { age = 5 }
				constant c = { a with b }
			}`)

			expect(diagnostics).toHaveLength(1)
			expect(diagnostics[0].message).toBe(
				"This is not a Partial of the value it updates",
			)
		})

		it("should report non-Record Type Annotations on Record Literals", () => {
			let diagnostics = diagnosticsFor(`implementation {
				constant a = String ~> { name = "x" }
			}`)

			expect(
				diagnostics.map((diagnostic) => diagnostic.message),
			).toContain("A Record Literal must be annotated with a Record Type")
		})

		it("should report @-Expressions outside of Methods", () => {
			let diagnostics = diagnosticsFor(`implementation {
				constant a = @
			}`)

			expect(diagnostics).toHaveLength(1)
			expect(diagnostics[0].message).toBe(
				"There is no '@' here to refer to",
			)
		})

		it("should report Lookups on Types without members", () => {
			let diagnostics = diagnosticsFor(`implementation {
				constant a = "value"
				constant b = a.member
			}`)

			expect(diagnostics).toHaveLength(1)
			expect(diagnostics[0].message).toBe(
				"This value has no members to look up",
			)
		})

		it("should report missing Record members", () => {
			let diagnostics = diagnosticsFor(`implementation {
				constant a = { name = "x" }
				constant b = a.age
			}`)

			expect(diagnostics).toHaveLength(1)
			expect(diagnostics[0].message).toBe(
				"{ name: String } has no member 'age'",
			)
		})

		it("should report all independent errors of a Program", () => {
			let diagnostics = diagnosticsFor(`implementation {
				constant a = undeclaredVariable
				constant b: UndeclaredType = "value"
				constant c = "value"::undeclaredMethod()
			}`)

			expect(diagnostics.map((diagnostic) => diagnostic.code)).toEqual([
				"unknown-name",
				"unknown-type",
				"unknown-method",
			])
		})

		it("should not report follow-up errors on Error Types", () => {
			let diagnostics = diagnosticsFor(`implementation {
				constant a = undeclaredVariable
				constant b = a::someMethod()
				constant c = a.someMember
				constant d = { a with name = "x" }
			}`)

			expect(diagnostics).toHaveLength(1)
			expect(diagnostics[0].message).toBe(
				"'undeclaredVariable' is not declared",
			)
		})

		it("should still enrich statements after a broken statement", () => {
			let { program, diagnostics } = enrichSource(`implementation {
				constant a = undeclaredVariable
				constant b = "value"
			}`)

			expect(diagnostics).toHaveLength(1)
			expect(program.implementation.nodes).toHaveLength(2)
		})
	})

	describe("Constant Reassignment", () => {
		it("should allow reassigning Variables", () => {
			expect(
				diagnosticsFor(`implementation {
					variable a = "first"
					a = "second"
				}`),
			).toEqual([])
		})

		it("should report reassigned Constants", () => {
			let diagnostics = diagnosticsFor(`implementation {
				constant a = "first"
				a = "second"
			}`)

			expect(diagnostics).toHaveLength(1)
			expect(diagnostics[0].message).toBe("'a' can not be reassigned")
			expect(diagnostics[0].position?.start.line).toBe(3)
		})

		it("should report reassigned Functions", () => {
			let diagnostics = diagnosticsFor(`implementation {
				function getName () -> String {
					<- "essence"
				}

				getName = "value"
			}`)

			expect(
				diagnostics.map((diagnostic) => diagnostic.message),
			).toContain("'getName' can not be reassigned")
		})

		it("should report reassigned Parameters", () => {
			let diagnostics = diagnosticsFor(`implementation {
				function greet (_ name: String) -> String {
					name = "other"
					<- name
				}
			}`)

			expect(diagnostics).toHaveLength(1)
			expect(diagnostics[0].message).toBe("'name' can not be reassigned")
		})

		it("should allow reassigning outer Variables from inner scopes", () => {
			expect(
				diagnosticsFor(`implementation {
					variable a = "first"

					if true {
						a = "second"
					}
				}`),
			).toEqual([])
		})
	})

	describe("Declaration Hoisting", () => {
		it("should allow using Functions before their declaration", () => {
			expect(
				diagnosticsFor(`implementation {
					constant greeting = getGreeting()

					function getGreeting () -> String {
						<- "hello"
					}
				}`),
			).toEqual([])
		})

		it("should allow mutually recursive Functions", () => {
			expect(
				diagnosticsFor(`implementation {
					function isEven (_ value: Integer) -> Boolean {
						if value::is(0) {
							<- true
						}

						<- isOdd(value::subtract(1))
					}

					function isOdd (_ value: Integer) -> Boolean {
						if value::is(0) {
							<- false
						}

						<- isEven(value::subtract(1))
					}

					__print(isEven(4))
				}`),
			).toEqual([])
		})

		it("should allow using Type Aliases before their declaration", () => {
			expect(
				diagnosticsFor(`implementation {
					type Names = List<Name>
					type Name = String

					constant names: Names = ["essence"]
				}`),
			).toEqual([])
		})

		it("should allow Namespaces before their target Type Alias", () => {
			expect(
				diagnosticsFor(`implementation {
					namespace Person for Person {
						createWith (_ name: String) -> Person {
							<- { name = name }
						}
					}

					type Person = { name: String }

					constant person = Person.createWith("essence")
				}`),
			).toEqual([])
		})

		it("should not hoist Constants", () => {
			let diagnostics = diagnosticsFor(`implementation {
				constant a = b
				constant b = "value"
			}`)

			expect(diagnostics).toHaveLength(1)
			expect(diagnostics[0].message).toBe("'b' is not declared")
		})

		it("should leave Namespaces referencing later Variables to in-order enrichment", () => {
			let diagnostics = diagnosticsFor(`implementation {
				namespace Config {
					static defaultName () -> String {
						<- fallbackName
					}
				}

				constant fallbackName = "essence"
			}`)

			expect(diagnostics).toHaveLength(1)
			expect(diagnostics[0].message).toBe(
				"'fallbackName' is not declared",
			)
		})

		it("should still report duplicate hoisted declarations", () => {
			let diagnostics = diagnosticsFor(`implementation {
				type Name = String
				type Name = Boolean
			}`)

			expect(diagnostics).toHaveLength(1)
			expect(diagnostics[0].message).toBe(
				"Type 'Name' is already declared",
			)
			expect(diagnostics[0].position?.start.line).toBe(3)
		})
	})

	describe("Generic Inference", () => {
		function typeOfFirstConstant(source: string): common.Type {
			let { program, diagnostics } = enrichSource(source)

			expect(diagnostics).toEqual([])

			for (let node of program.implementation.nodes) {
				if (node.nodeType === "ConstantDeclarationStatement") {
					return node.type
				}
			}

			throw new Error("No ConstantDeclarationStatement found.")
		}

		it("should infer List item Types through Method Invocations", () => {
			expect(
				typeOfFirstConstant(`implementation {
					constant first = [1, 2]::firstItem()
				}`),
			).toEqual({
				type: "UnionType",
				alias: {
					name: "Optional",
					typeArguments: [{ type: "Integer" }],
				},
				types: [{ type: "Integer" }, { type: "Nothing" }],
			})
		})

		it("should infer map's result Type from the callback's return", () => {
			// NOTE: `Result` occurs only in the callback's return position and
			// in `map`'s own return — the case 0.5b unblocked. The callback is
			// contextually typed, so `n` needs no annotation.
			expect(
				typeOfFirstConstant(`implementation {
					constant texts = [1, 2]::map((n) { <- n::toString() })
				}`),
			).toEqual({ type: "List", itemType: { type: "String" } })
		})

		it("should infer reduce's result Type from the starting value", () => {
			// NOTE: `Result` binds from `startingWith` before the callback is
			// checked, so both `total` and `n` are contextually typed.
			expect(
				typeOfFirstConstant(`implementation {
					constant total = [1, 2, 3]::reduce(
						startingWith 0,
						(total, n) { <- total::add(n) },
					)
				}`),
			).toEqual({ type: "Integer" })
		})

		it("should carry the item Type into map's callback body", () => {
			// NOTE: `isGreaterThan` only resolves if `n` typed as Integer, so
			// a broken item-Type substitution fails outright here.
			expect(
				typeOfFirstConstant(`implementation {
					constant flags = [1, 2]::map((n) { <- n::isGreaterThan(1) })
				}`),
			).toEqual({ type: "List", itemType: { type: "Boolean" } })
		})

		it("should find an item with the firstItem check overload", () => {
			expect(
				typeOfFirstConstant(`implementation {
					constant found = [1, 2]::firstItem(where (n) { <- n::isGreaterThan(1) })
				}`),
			).toEqual({
				type: "UnionType",
				alias: {
					name: "Optional",
					typeArguments: [{ type: "Integer" }],
				},
				types: [{ type: "Integer" }, { type: "Nothing" }],
			})
		})

		it("should substitute the receiver's item Type into List returns", () => {
			expect(
				typeOfFirstConstant(`implementation {
					constant shorter = ["a", "b"]::removeFirst()
				}`),
			).toEqual({ type: "List", itemType: { type: "String" } })
		})

		it("should infer Namespace Generics from the receiver", () => {
			expect(
				typeOfFirstConstant(`implementation {
					namespace Wrapper<infer Item> for List<Item> {
						firstAgain() -> Item | Nothing {
							<- @::firstItem()
						}
					}

					constant first = ["x"]::firstAgain()
				}`),
			).toEqual({
				type: "UnionType",
				types: [{ type: "String" }, { type: "Nothing" }],
			})
		})

		it("should bind Method Generics from Function Argument return Types", () => {
			expect(
				typeOfFirstConstant(`implementation {
					namespace Mapper<infer Item> for List<Item> {
						transformFirst<infer Target>(
							_ transform: (_ item: Item) -> Target,
							fallback fallbackValue: Target,
						) -> Target {
							<- match @::firstItem() -> Target {
								case Nothing { <- fallbackValue }
								case Item { <- transform(@) }
							}
						}
					}

					constant first = [1]::transformFirst(
						(_ item: Integer) -> String { <- item::toString() },
						fallback "none",
					)
				}`),
			).toEqual({ type: "String" })
		})

		it("should check Function Argument parameters against bound Generics", () => {
			let diagnostics = diagnosticsFor(`implementation {
				namespace Mapper<infer Item> for List<Item> {
					transformFirst<infer Target>(
						_ transform: (_ item: Item) -> Target,
						fallback fallbackValue: Target,
					) -> Target {
						<- fallbackValue
					}
				}

				constant first = [1]::transformFirst(
					(_ item: String) -> String { <- item },
					fallback "none",
				)
			}`)

			expect(diagnostics).toHaveLength(1)
			expect(diagnostics[0].code).toBe("no-matching-overload")
		})

		// NOTE: A Function literal in Argument position may leave its
		// annotations out and take them from the parameter it is being passed
		// to. An unannotated Parameter takes its label from there too, which
		// is why `(item)` and `(_ item)` mean the same thing here and neither
		// spelling has to know that `removeEvery`'s callback is labelless.
		describe("Contextual Function literals", () => {
			it("infers a Parameter Type from the expected signature", () => {
				expect(
					typeOfFirstConstant(`implementation {
						constant kept = [1, 2, 3]::removeEvery(
							where (item) { <- item::isGreaterThan(2) },
						)
					}`),
				).toEqual({ type: "List", itemType: { type: "Integer" } })
			})

			it("reads the same written either way", () => {
				expect(
					typeOfFirstConstant(`implementation {
						constant kept = [1, 2, 3]::removeEvery(
							where (_ item) { <- item::isGreaterThan(2) },
						)
					}`),
				).toEqual({ type: "List", itemType: { type: "Integer" } })
			})

			it("still accepts a written return Type", () => {
				expect(
					typeOfFirstConstant(`implementation {
						constant kept = [1, 2, 3]::removeEvery(
							where (item) -> Boolean { <- item::isGreaterThan(2) },
						)
					}`),
				).toEqual({ type: "List", itemType: { type: "Integer" } })
			})

			it("types the body with the inferred Parameter", () => {
				// NOTE: `isGreaterThan` only resolves if `item` is an Integer,
				// so this fails outright rather than subtly if the inferred
				// Type never reaches the body's Scope.
				expect(
					diagnosticsFor(`implementation {
						constant kept = ["a"]::removeEvery(
							where (item) { <- item::isGreaterThan(2) },
						)
					}`).map((diagnostic) => diagnostic.message),
				).toContain("No Method named 'isGreaterThan' for this value")
			})

			it("reports a literal with nothing to infer from", () => {
				let diagnostics = diagnosticsFor(`implementation {
					constant standalone = (x) { <- x }
				}`)

				// NOTE: One Diagnostic, not two — the return Type could not be
				// inferred either, but only because the Parameter it depends
				// on could not be, which is what the reported message says.
				expect(
					diagnostics.map((diagnostic) => diagnostic.message),
				).toEqual(["The Type of Parameter 'x' could not be inferred"])
			})

			it("reports an omitted return Type outside Argument position", () => {
				// NOTE: The body could answer this one — every Parameter is
				// written — but a Type read off a body that nothing else
				// constrains is what makes a Program hard to follow. Only an
				// Argument, whose Type is written down elsewhere, may omit it.
				expect(
					diagnosticsFor(`implementation {
						constant describe = (_ value: Integer) { <- value::toString() }
					}`).map((diagnostic) => diagnostic.message),
				).toEqual(["This Function must write its return Type"])
			})

			it("reports more Parameters than the expected signature takes", () => {
				expect(
					diagnosticsFor(`implementation {
						constant kept = [1, 2]::removeEvery(
							where (a, b) { <- true },
						)
					}`).map((diagnostic) => diagnostic.message),
				).toContain("The Type of Parameter 'b' could not be inferred")
			})

			it("binds a Generic from an inferred return Type", () => {
				// NOTE: The hard case, and the one `map` needs. `Item` is
				// bound by the receiver, which types the Parameter; nothing
				// binds `Target` but this literal's own body, so the body is
				// what `Target` is read off — String here, which then decides
				// the Type of the whole invocation.
				expect(
					typeOfFirstConstant(`implementation {
						namespace Mapper<infer Item> for List<Item> {
							transformFirst<infer Target>(
								_ transform: (_ item: Item) -> Target,
								fallback fallbackValue: Target,
							) -> Target {
								<- fallbackValue
							}
						}

						constant first = [1]::transformFirst(
							(item) { <- item::toString() },
							fallback "none",
						)
					}`),
				).toEqual({ type: "String" })
			})

			it("unions the Types of several returns", () => {
				expect(
					typeOfFirstConstant(`implementation {
						namespace Mapper<infer Item> for List<Item> {
							transformFirst<infer Target>(
								_ transform: (_ item: Item) -> Target,
							) -> Target {
								<- transform(1)
							}
						}

						constant maybeDouble = [1]::transformFirst((value) {
							if value::isGreaterThan(0) {
								<- value::multiply(with 2)
							}

							<- nothing
						})
					}`),
				).toEqual({
					type: "UnionType",
					types: [{ type: "Integer" }, { type: "Nothing" }],
				})
			})

			it("infers the Parameter while the return Type is written", () => {
				expect(
					typeOfFirstConstant(`implementation {
						namespace Mapper<infer Item> for List<Item> {
							transformFirst<infer Target>(
								_ transform: (_ item: Item) -> Target,
								fallback fallbackValue: Target,
							) -> Target {
								<- fallbackValue
							}
						}

						constant first = [1]::transformFirst(
							(item) -> String { <- item::toString() },
							fallback "none",
						)
					}`),
				).toEqual({ type: "String" })
			})
		})

		it("should infer Generic Functions from their Arguments", () => {
			expect(
				typeOfFirstConstant(`implementation {
					function identity <infer T>(_ value: T) -> T {
						<- value
					}

					constant a = identity(5)
				}`),
			).toEqual({ type: "Integer" })
		})

		it("should report conflicting later occurrences as mismatches", () => {
			let diagnostics = diagnosticsFor(`implementation {
				constant a = [1, 2]::append("x")
			}`)

			expect(diagnostics).toHaveLength(1)
			expect(diagnostics[0].code).toBe("no-matching-overload")
		})

		it("should report Type Parameters that can not be inferred", () => {
			let diagnostics = diagnosticsFor(`implementation {
				function broken <infer T>() -> T {
					<- "value"
				}

				constant a = broken()
			}`)

			expect(
				diagnostics.map((diagnostic) => diagnostic.message),
			).toContain("Type Parameter 'T' could not be inferred")
		})

		it("should apply defaults for unbound plain Generics", () => {
			expect(
				typeOfFirstConstant(`implementation {
					function fallback <T = String>() -> T {
						<- "value"
					}

					constant a = fallback()
				}`),
			).toEqual({ type: "String" })
		})

		it("should expand applied Generic Type Aliases", () => {
			let { program, diagnostics } = enrichSource(`implementation {
				type Maybe<Value> = Value | Nothing

				constant a: Maybe<Rational> = 1/2
			}`)

			expect(diagnostics).toEqual([])

			let constant = program.implementation.nodes[1]

			expect(constant.nodeType).toBe("ConstantDeclarationStatement")

			if (constant.nodeType === "ConstantDeclarationStatement") {
				// NOTE: The applied spelling sticks around as the Union's
				// display alias — assignability ignores it.
				expect(constant.declaredType).toEqual({
					type: "UnionType",
					alias: {
						name: "Maybe",
						typeArguments: [{ type: "Rational" }],
					},
					types: [{ type: "Rational" }, { type: "Nothing" }],
				})
			}
		})

		it("should apply Generic Type Alias defaults", () => {
			expect(
				diagnosticsFor(`implementation {
					type Fallback<Value = String> = Value | Nothing

					constant a: Fallback = "value"
				}`),
			).toEqual([])
		})

		it("should report Generic Type Aliases applied with too many Type Arguments", () => {
			let diagnostics = diagnosticsFor(`implementation {
				type Maybe<Value> = Value | Nothing

				constant a: Maybe<Rational, Integer> = 1/2
			}`)

			expect(diagnostics).toHaveLength(1)
			expect(diagnostics[0].message).toBe(
				"Type 'Maybe' was given the wrong number of Type Arguments",
			)
			expect(diagnostics[0].position?.start.line).toBe(4)
		})

		it("should report Generic Type Aliases used without Type Arguments", () => {
			let diagnostics = diagnosticsFor(`implementation {
				type Maybe<Value> = Value | Nothing

				constant a: Maybe = 1/2
			}`)

			expect(diagnostics).toHaveLength(1)
			expect(diagnostics[0].message).toBe(
				"Type 'Maybe' was given the wrong number of Type Arguments",
			)
		})

		it("should match Generic Namespaces through applied Alias targets", () => {
			expect(
				typeOfFirstConstant(`implementation {
					type Maybe<Value> = Value | Nothing

					namespace Maybe<infer Value> for Maybe<Value> {
						withDefault(_ fallbackValue: Value) -> Value {
							<- match @ -> Value {
								case Nothing { <- fallbackValue }
								case Value { <- @ }
							}
						}
					}

					constant first = [1, 2]::firstItem()::withDefault(0)
				}`),
			).toEqual({ type: "Integer" })
		})
	})

	describe("Protocols", () => {
		it("should accept a well-formed Protocol declaration", () => {
			expect(
				diagnosticsFor(`implementation {
					protocol Matchable {
						is(_ other: Self) -> Boolean
						isNot(_ other: Self) -> Boolean
					}
				}`),
			).toEqual([])
		})

		it("should accept static and overloaded Protocol Method Signatures", () => {
			expect(
				diagnosticsFor(`implementation {
					protocol Creatable {
						static create() -> Self

						overload combine {
							(_ other: Self) -> Self
							(_ others: List<Self>) -> Self
						}
					}
				}`),
			).toEqual([])
		})

		it("should report duplicate Protocol declarations", () => {
			let diagnostics = diagnosticsFor(`implementation {
				protocol Showable {
					toString() -> String
				}

				protocol Showable {
					toString() -> String
				}
			}`)

			expect(diagnostics).toHaveLength(1)
			expect(diagnostics[0].severity).toBe("error")
			expect(diagnostics[0].message).toBe(
				"Protocol 'Showable' is already declared",
			)
		})

		it("should reject a Protocol used as a Type annotation", () => {
			let diagnostics = diagnosticsFor(`implementation {
				protocol Showable {
					toString() -> String
				}

				constant value: Showable = "text"
			}`)

			expect(diagnostics).toHaveLength(1)
			expect(diagnostics[0].message).toBe(
				"Protocol 'Showable' can not be used as a Type",
			)
		})

		it("should reject a Protocol used as a Union member", () => {
			let diagnostics = diagnosticsFor(`implementation {
				protocol Showable {
					toString() -> String
				}

				constant value: Showable | Nothing = nothing
			}`)

			expect(diagnostics).toHaveLength(1)
			expect(diagnostics[0].message).toBe(
				"Protocol 'Showable' can not be used as a Type",
			)
		})

		it("should reject a Protocol used as a Match Case", () => {
			let diagnostics = diagnosticsFor(`implementation {
				protocol Showable {
					toString() -> String
				}

				variable value: Integer | Nothing = 1

				constant result = match value -> Integer {
					case Showable { <- 0 }
					case Integer { <- @ }
					case Nothing { <- 0 }
				}
			}`)

			expect(
				diagnostics.some(
					(diagnostic) =>
						diagnostic.message ===
						"Protocol 'Showable' can not be used as a Type",
				),
			).toBe(true)
		})

		it("should reject a Protocol used as a value", () => {
			let diagnostics = diagnosticsFor(`implementation {
				protocol Showable {
					toString() -> String
				}

				constant value = Showable
			}`)

			expect(diagnostics).toHaveLength(1)
			expect(diagnostics[0].message).toBe(
				"Protocol 'Showable' can not be used as a value",
			)
		})

		it("should reserve Self as a Generic name", () => {
			let diagnostics = diagnosticsFor(`implementation {
				function identity <Self>(_ value: Self) -> Self {
					<- value
				}
			}`)

			expect(diagnostics).toHaveLength(1)
			expect(diagnostics[0].message).toBe(
				"'Self' is a reserved Type name",
			)
		})

		it("should reserve Self as a Type Alias name", () => {
			let diagnostics = diagnosticsFor(`implementation {
				type Self = String
			}`)

			expect(diagnostics).toHaveLength(1)
			expect(diagnostics[0].message).toBe(
				"'Self' is a reserved Type name",
			)
		})
	})

	describe("Protocol Conformance", () => {
		it("should accept a conforming Namespace", () => {
			expect(
				diagnosticsFor(`implementation {
					protocol Matchable {
						is(_ other: Self) -> Boolean
					}

					type Vector = { x: Number, y: Number }

					namespace VectorMatchable for Vector is Matchable {
						is(_ other: Vector) -> Boolean {
							<- true
						}
					}
				}`),
			).toEqual([])
		})

		it("should accept conformance to a Protocol declared below the Namespace", () => {
			expect(
				diagnosticsFor(`implementation {
					type Vector = { x: Number, y: Number }

					namespace VectorMatchable for Vector is Matchable {
						is(_ other: Vector) -> Boolean {
							<- true
						}
					}

					protocol Matchable {
						is(_ other: Self) -> Boolean
					}
				}`),
			).toEqual([])
		})

		it("should accept an overloaded Method fulfilling a simple requirement", () => {
			expect(
				diagnosticsFor(`implementation {
					protocol Showable {
						toString() -> String
					}

					type Vector = { x: Number, y: Number }

					namespace VectorShowable for Vector is Showable {
						overload toString {
							() -> String {
								<- "vector"
							}

							(_ prefix: String) -> String {
								<- prefix
							}
						}
					}
				}`),
			).toEqual([])
		})

		it("should report a missing Method", () => {
			let diagnostics = diagnosticsFor(`implementation {
				protocol Matchable {
					is(_ other: Self) -> Boolean
				}

				type Vector = { x: Number, y: Number }

				namespace VectorMatchable for Vector is Matchable {}
			}`)

			expect(diagnostics).toHaveLength(1)
			expect(diagnostics[0].message).toBe(
				"Namespace 'VectorMatchable' does not conform to 'Matchable'",
			)
		})

		it("should report a mismatched Method signature", () => {
			let diagnostics = diagnosticsFor(`implementation {
				protocol Showable {
					toString() -> String
				}

				type Vector = { x: Number, y: Number }

				namespace VectorShowable for Vector is Showable {
					toString() -> Boolean {
						<- true
					}
				}
			}`)

			expect(diagnostics).toHaveLength(1)
			expect(diagnostics[0].message).toBe(
				"Namespace 'VectorShowable' does not conform to 'Showable'",
			)
		})

		it("should report an undeclared Protocol in a Conformance Clause", () => {
			let diagnostics = diagnosticsFor(`implementation {
				type Vector = { x: Number, y: Number }

				namespace VectorMatchable for Vector is Undeclared {}
			}`)

			expect(diagnostics).toHaveLength(1)
			expect(diagnostics[0].message).toBe(
				"Protocol 'Undeclared' is not declared",
			)
		})

		it("should reject a Conformance Clause on an untyped Namespace", () => {
			let diagnostics = diagnosticsFor(`implementation {
				protocol Showable {
					toString() -> String
				}

				namespace Helpers is Showable {}
			}`)

			expect(diagnostics).toHaveLength(1)
			expect(diagnostics[0].message).toBe(
				"Only a Namespace with a target Type can conform to a Protocol",
			)
		})

		it("should accept a Conformance Clause on a generic Namespace", () => {
			expect(
				diagnosticsFor(`implementation {
					protocol Showable {
						toString() -> String
					}

					namespace ListShowable<infer Item> for List<Item> is Showable {
						toString() -> String {
							<- "list"
						}
					}
				}`),
			).toEqual([])
		})

		it("should resolve a generic Namespace's conformance at a bounded call site", () => {
			let { program, diagnostics } = enrichSource(`implementation {
				function areEqual <infer Value is Equatable>(_ a: Value, _ b: Value) -> Boolean {
					<- a::is(b)
				}

				constant result: Boolean = areEqual([1, 2], [3, 4])
			}`)

			expect(diagnostics).toEqual([])

			// NOTE: `List is Equatable` is CONDITIONAL — a List is equatable
			// exactly when its items are — so the bounded `Value` is solved by
			// List's own conformance carrying Integer's as its condition, and
			// the nested one is collected here alongside it. The generic the
			// call site had to fill is `Value`; that one is List's.
			let namespaceSources = collectConformances(program).filter(
				(conformance) =>
					conformance.protocolName === "Equatable" &&
					conformance.source.kind === "namespace",
			)

			expect(namespaceSources.length).toBeGreaterThan(0)

			let outer = namespaceSources.find(
				(conformance) => conformance.genericName === "Value",
			)

			expect(outer).toBeDefined()

			if (outer !== undefined && outer.source.kind === "namespace") {
				expect(outer.source.name).toBe("List")
				expect(outer.source.conditions).toHaveLength(1)
				expect(outer.source.conditions[0].source.kind).toBe("namespace")

				if (outer.source.conditions[0].source.kind === "namespace") {
					expect(outer.source.conditions[0].source.name).toBe(
						"Integer",
					)
				}
			}
		})

		it("should prefer a concrete Namespace over the generic blanket", () => {
			let { program, diagnostics } = enrichSource(`implementation {
				namespace IntegerListEquatable for List<Integer> is Equatable {
					is(_ other: List<Integer>) -> Boolean { <- true }
					isNot(_ other: List<Integer>) -> Boolean { <- false }
				}

				function areEqual <infer Value is Equatable>(_ a: Value, _ b: Value) -> Boolean {
					<- a::is(b)
				}

				constant result: Boolean = areEqual([1, 2], [3, 4])
			}`)

			expect(diagnostics).toEqual([])

			let namespaceSources = collectConformances(program).filter(
				(conformance) =>
					conformance.protocolName === "Equatable" &&
					conformance.source.kind === "namespace",
			)

			expect(namespaceSources.length).toBeGreaterThan(0)
			expect(
				namespaceSources.every(
					(conformance) =>
						conformance.source.kind === "namespace" &&
						conformance.source.name === "IntegerListEquatable",
				),
			).toBe(true)
		})

		it("should report a Method that needs a condition", () => {
			let diagnostics = diagnosticsFor(`implementation {
				protocol Orderable {
					compareTo(_ other: Self) -> Ordering
				}

				namespace ListOrderable<infer Item> for List<Item> is Orderable {
					compareTo <infer Item is Comparable>(_ other: List<Item>) -> Ordering {
						<- Ordering#Equal
					}
				}
			}`)

			expect(diagnostics).toHaveLength(1)
			expect(diagnostics[0].code).toBe("nonconforming-namespace")
			expect(diagnostics[0].labels[0]?.message).toBe(
				"Method 'compareTo' needs 'Item is Comparable'",
			)
		})

		it("should check static Method requirements", () => {
			expect(
				diagnosticsFor(`implementation {
					protocol Creatable {
						static create() -> Self
					}

					type Vector = { x: Number, y: Number }

					namespace VectorCreatable for Vector is Creatable {
						static create() -> Vector {
							<- { x = 0, y = 0 }
						}
					}
				}`),
			).toEqual([])
		})

		it("should reject a simple Method fulfilling a static requirement", () => {
			let diagnostics = diagnosticsFor(`implementation {
				protocol Creatable {
					static create() -> Self
				}

				type Vector = { x: Number, y: Number }

				namespace VectorCreatable for Vector is Creatable {
					create() -> Vector {
						<- { x = 0, y = 0 }
					}
				}
			}`)

			expect(diagnostics).toHaveLength(1)
			expect(diagnostics[0].message).toBe(
				"Namespace 'VectorCreatable' does not conform to 'Creatable'",
			)
		})
	})

	describe("Conditional Conformance", () => {
		it("should accept a conditional clause whose body uses the bound", () => {
			expect(
				diagnosticsFor(`implementation {
					namespace Wrapper<infer Item> for { value: Item }
						is Comparable where Item is Comparable
					{
						compareTo(_ other: { value: Item }) -> Ordering {
							<- @.value::compareTo(other.value)
						}
					}
				}`),
			).toEqual([])
		})

		it("should help toward a where clause on a needs-condition Method", () => {
			let diagnostics = diagnosticsFor(`implementation {
				protocol Orderable {
					compareTo(_ other: Self) -> Ordering
				}

				namespace ListOrderable<infer Item> for List<Item> is Orderable {
					compareTo <infer Item is Comparable>(_ other: List<Item>) -> Ordering {
						<- Ordering#Equal
					}
				}
			}`)

			expect(diagnostics).toHaveLength(1)
			expect(diagnostics[0].code).toBe("nonconforming-namespace")
			expect(diagnostics[0].helps).toContain(
				"Add 'where Item is Comparable' to this conformance.",
			)
		})

		it("should reject a where condition naming an unknown Generic", () => {
			let diagnostics = diagnosticsFor(`implementation {
				namespace Wrapper<infer Item> for { value: Item }
					is Comparable where Other is Comparable
				{
					compareTo(_ other: { value: Item }) -> Ordering {
						<- Ordering#Equal
					}
				}
			}`)

			expect(diagnostics).toHaveLength(1)
			expect(diagnostics[0].code).toBe("unknown-where-generic")
			expect(diagnostics[0].message).toBe(
				"'Other' is not a Type Parameter of this Namespace",
			)
		})

		it("should reject a where condition on a Generic the target Type never mentions", () => {
			// NOTE: Regression — a phantom Generic's condition can never be
			// witnessed at a use site, so before this Diagnostic the hidden
			// conformance Parameter arrived as `undefined` and crashed.
			let diagnostics = diagnosticsFor(`implementation {
				namespace Weird<infer Ghost, infer Item> for { value: Item }
					is Comparable where Ghost is Comparable, Item is Comparable
				{
					compareTo(_ other: { value: Item }) -> Ordering {
						<- @.value::compareTo(other.value)
					}
				}
			}`)

			expect(diagnostics).toHaveLength(1)
			expect(diagnostics[0].code).toBe("unwitnessable-where-condition")
			expect(diagnostics[0].message).toBe(
				"'Ghost' does not appear in this Namespace's target Type",
			)
		})

		it("should reject a Generic bound twice in one clause", () => {
			let diagnostics = diagnosticsFor(`implementation {
				namespace Wrapper<infer Item> for { value: Item }
					is Comparable where Item is Comparable, Item is Equatable
				{
					compareTo(_ other: { value: Item }) -> Ordering {
						<- @.value::compareTo(other.value)
					}
				}
			}`)

			expect(
				diagnostics.some(
					(diagnostic) =>
						diagnostic.code === "conflicting-where-condition",
				),
			).toBe(true)
		})

		it("should solve a conditional conformance at a use site", () => {
			let { program, diagnostics } = enrichSource(`implementation {
				constant ordered: List<Integer> = [3, 1, 2]::sorted()
			}`)

			expect(diagnostics).toEqual([])

			let comparable = collectConformances(program).filter(
				(conformance) => conformance.protocolName === "Comparable",
			)

			expect(comparable.length).toBeGreaterThan(0)
			expect(
				comparable.some(
					(conformance) =>
						conformance.source.kind === "namespace" &&
						conformance.source.name === "Integer",
				),
			).toBe(true)
		})

		it("should nest witness conditions ordered by the candidate's Generics", () => {
			let { program, diagnostics } = enrichSource(`implementation {
				constant ordered = [[1, 2], [3]]::sorted()
			}`)

			expect(diagnostics).toEqual([])

			let outer = collectConformances(program).find(
				(conformance) =>
					conformance.protocolName === "Comparable" &&
					conformance.source.kind === "namespace" &&
					conformance.source.name === "List",
			)

			expect(outer).toBeDefined()

			if (outer !== undefined && outer.source.kind === "namespace") {
				expect(outer.source.conditions).toHaveLength(1)
				expect(outer.source.conditions[0].source.kind).toBe("namespace")

				if (outer.source.conditions[0].source.kind === "namespace") {
					expect(outer.source.conditions[0].source.name).toBe(
						"Integer",
					)
				}
			}
		})

		it("should report a two-level because-chain for a nested failure", () => {
			let diagnostics = diagnosticsFor(`implementation {
				constant ordered = [[true], [false]]::sorted()
			}`)

			let failure = diagnostics.find(
				(diagnostic) =>
					diagnostic.code === "unsatisfied-conformance-condition",
			)

			expect(failure).toBeDefined()
			expect(failure!.notes.length).toBeGreaterThanOrEqual(2)
			expect(failure!.notes[0]).toContain("does not conform")
			expect(
				failure!.notes.some((note) =>
					note.includes("Boolean does not conform"),
				),
			).toBe(true)
		})

		it("should demand a witness for a direct compareTo call", () => {
			let { program, diagnostics } = enrichSource(`implementation {
				constant order = [1, 2]::compareTo([1, 3])
			}`)

			expect(diagnostics).toEqual([])

			let comparable = collectConformances(program).filter(
				(conformance) => conformance.protocolName === "Comparable",
			)

			expect(comparable.length).toBeGreaterThan(0)
		})

		it("should reject a List of a non-Comparable Type", () => {
			// NOTE: Boolean conforms only to Equatable and Printable — sorting a
			// List of them has no item ordering to lean on. (Transcendental,
			// which the plan first named here, in fact conforms to Comparable
			// through the covering `Number` Namespace, so it is not a negative.)
			let diagnostics = diagnosticsFor(`implementation {
				constant sorted = [true, false]::sorted()
			}`)

			expect(
				diagnostics.some((diagnostic) =>
					diagnostic.message.includes("does not conform"),
				),
			).toBe(true)
		})
	})

	describe("Namespace Generic Merge", () => {
		// NOTE: A Namespace Generic reaches a Method only when that Method's
		// resolved signature mentions it — anything else would be a Type
		// Parameter no call site could ever bind.
		function methodTypeFor(
			source: string,
			namespaceName: string,
			methodName: string,
		): common.MethodType {
			let { program, diagnostics } = enrichSource(source)

			expect(diagnostics).toEqual([])

			for (let node of program.implementation.nodes) {
				if (
					node.nodeType === "NamespaceDefinitionStatement" &&
					node.type.name === namespaceName
				) {
					let method = node.type.methods[methodName]

					expect(method).toBeDefined()

					return method!
				}
			}

			throw new Error(`No Namespace '${namespaceName}' in the Program`)
		}

		function genericsOf(method: common.MethodType) {
			expect(method.type === "SimpleMethod").toBe(true)

			return (method as common.SimpleMethodType).generics
		}

		it("should prune a Namespace Generic a Method never mentions", () => {
			let method = methodTypeFor(
				`implementation {
					namespace Tags<infer Item> for Integer {
						describe() -> String {
							<- "tag"
						}
					}
				}`,
				"Tags",
				"describe",
			)

			expect(genericsOf(method)).toEqual([])
		})

		it("should keep a Namespace Generic the injected self Parameter mentions", () => {
			let method = methodTypeFor(
				`implementation {
					namespace Boxes<infer Item> for List<Item> {
						describe() -> String {
							<- "box"
						}
					}
				}`,
				"Boxes",
				"describe",
			)

			expect(genericsOf(method)).toEqual([
				{
					name: "Item",
					infer: true,
					defaultType: null,
					constraint: null,
				},
			])
		})

		it("should let a same-named Method Generic shadow the Namespace one", () => {
			let method = methodTypeFor(
				`implementation {
					namespace Tags<infer Item> for Integer {
						ranked<infer Item is Comparable>(_ items: List<Item>) -> List<Item> {
							<- items
						}
					}
				}`,
				"Tags",
				"ranked",
			)

			// NOTE: Exactly one entry, and it is the METHOD's — its bound is
			// what the signature was resolved under.
			expect(genericsOf(method)).toEqual([
				{
					name: "Item",
					infer: true,
					defaultType: null,
					constraint: "Comparable",
				},
			])
		})

		it("should keep the Namespace Generics ahead of the Method's own", () => {
			let method = methodTypeFor(
				`implementation {
					namespace Boxes<infer Item> for List<Item> {
						pair<infer Other>(_ other: Other) -> Boolean {
							<- true
						}
					}
				}`,
				"Boxes",
				"pair",
			)

			expect(genericsOf(method).map((generic) => generic.name)).toEqual([
				"Item",
				"Other",
			])
		})

		it("should prune per Overload", () => {
			let method = methodTypeFor(
				`implementation {
					namespace Tags<infer Item> for Integer {
						overload static make {
							(_ item: Item) -> Boolean {
								<- true
							}

							(_ count: Integer) -> Boolean {
								<- true
							}
						}
					}
				}`,
				"Tags",
				"make",
			)

			expect(method.type).toBe("OverloadedStaticMethod")
			expect(
				(method as common.OverloadedStaticMethodType).overloads.map(
					(overload) =>
						overload.generics.map((generic) => generic.name),
				),
			).toEqual([["Item"], []])
		})

		describe("Nested mentions", () => {
			// NOTE: One case per Type shape the walk has to see through — a
			// missed shape would silently prune a Generic that IS used, leaving
			// it unbindable at the call site.
			const cases: Array<[string, string]> = [
				["the return Type alone", "produce() -> Item | Nothing"],
				["a List item Type", "collect(_ items: List<Item>) -> Boolean"],
				[
					"a Record member",
					"unwrap(_ box: { value: Item }) -> Boolean",
				],
				["a Union member", "store(_ maybe: Item | Nothing) -> Boolean"],
				[
					"a Function Parameter Type",
					"apply(_ transform: (_: Item) -> Boolean) -> Boolean",
				],
				[
					"a Function return Type",
					"lazily(_ make: () -> Item) -> Boolean",
				],
				[
					"a Generic Alias application",
					"hold(_ maybe: Maybe<Item>) -> Boolean",
				],
			]

			for (let [name, signature] of cases) {
				it(`should keep a Namespace Generic used in ${name}`, () => {
					let returnsUnion = signature.includes("-> Item | Nothing")

					let method = methodTypeFor(
						`implementation {
							type Maybe<Value> = Value | Nothing

							namespace Tags<infer Item> for Integer {
								${signature} {
									<- ${returnsUnion ? "nothing" : "true"}
								}
							}
						}`,
						"Tags",
						signature.slice(0, signature.indexOf("(")),
					)

					expect(
						genericsOf(method).map((generic) => generic.name),
					).toEqual(["Item"])
				})
			}
		})

		it("should still bound a conditional conformance's fulfilling Method", () => {
			// NOTE: Guards the interaction with the conditional-conformance
			// Generic weaving: `compareTo` uses `Item`, so it survives pruning
			// and keeps its retrofitted bound — which is what makes the hidden
			// conformance Parameter emitted for it.
			let source = `implementation {
				namespace Boxes<infer Item> for { value: Item }
					is Comparable where Item is Comparable
				{
					compareTo(_ other: { value: Item }) -> Ordering {
						<- @.value::compareTo(other.value)
					}

					static describe() -> String {
						<- "box"
					}
				}
			}`

			expect(
				genericsOf(methodTypeFor(source, "Boxes", "compareTo")),
			).toEqual([
				{
					name: "Item",
					infer: true,
					defaultType: null,
					constraint: "Comparable",
				},
			])

			// NOTE: And the typed Node agrees — its leading Generic is the same
			// bounded `Item`, so `simplifyFunctionDefinition` emits exactly one
			// hidden conformance Parameter, first.
			let { program } = enrichSource(source)

			let namespaceNode = program.implementation.nodes.find(
				(node) => node.nodeType === "NamespaceDefinitionStatement",
			) as common.typed.NamespaceDefinitionStatementNode

			let compareTo = namespaceNode.methods.compareTo

			expect(compareTo?.nodeType).toBe("SimpleMethod")
			expect(
				(compareTo as common.typed.SimpleMethod).method.value.generics,
			).toMatchObject([{ name: "Item", constraint: "Comparable" }])

			// NOTE: A Method that does not fulfil the conformance carries
			// neither the Generic nor its hidden Parameter.
			let describe = namespaceNode.methods.describe

			expect(
				(describe as common.typed.StaticMethod).method.value.generics,
			).toEqual([])
		})

		it("should retain a bound Generic on a fulfilling Method that never mentions it", () => {
			// NOTE: The exception to the merge rule. A `where` bound is
			// witnessed by `$type.boundConformance`, which curries a witness
			// onto EVERY fulfilling Method whatever its signature mentions —
			// so a fulfilling Method keeps the bound Namespace Generic even
			// when nothing in its signature names it, and both views say so.
			let source = `implementation {
				protocol Nameable {
					static nameOf() -> String
				}

				namespace Bags<infer Item> for List<Item>
					is Nameable where Item is Comparable
				{
					static nameOf() -> String {
						<- "bag"
					}
				}
			}`

			let method = methodTypeFor(source, "Bags", "nameOf")

			expect(method.type).toBe("StaticMethod")
			expect((method as common.StaticMethodType).generics).toEqual([
				{
					name: "Item",
					infer: true,
					defaultType: null,
					constraint: "Comparable",
				},
			])

			let { program } = enrichSource(source)

			let namespaceNode = program.implementation.nodes.find(
				(node) => node.nodeType === "NamespaceDefinitionStatement",
			) as common.typed.NamespaceDefinitionStatementNode

			expect(
				(namespaceNode.methods.nameOf as common.typed.StaticMethod)
					.method.value.generics,
			).toMatchObject([{ name: "Item", constraint: "Comparable" }])
		})

		it("should retain a bound Generic on every Overload of a fulfilling Method", () => {
			// NOTE: Regression guard. Pruning per Overload while the
			// conformance witness is curried per Method let one Overload emit a
			// hidden conformance Parameter its Type never declared — the
			// Argument then landed in the wrong slot at runtime.
			let source = `implementation {
				protocol Nameable {
					static nameOf() -> String
				}

				namespace Bags<infer Item> for { items: List<Item> }
					is Nameable where Item is Comparable
				{
					overload static nameOf {
						() -> String {
							<- "bag"
						}

						(_ item: Item) -> String {
							<- "item"
						}

						<infer Other is Comparable>(_ a: Other, _ b: Other) -> String {
							<- a::compareTo(b)::toString()
						}
					}
				}
			}`

			let method = methodTypeFor(source, "Bags", "nameOf")

			expect(method.type).toBe("OverloadedStaticMethod")
			expect(
				(method as common.OverloadedStaticMethodType).overloads.map(
					(overload) =>
						overload.generics.map(
							(generic) =>
								`${generic.name}:${generic.constraint}`,
						),
				),
			).toEqual([
				["Item:Comparable"],
				["Item:Comparable"],
				["Item:Comparable", "Other:Comparable"],
			])

			let { program } = enrichSource(source)

			let namespaceNode = program.implementation.nodes.find(
				(node) => node.nodeType === "NamespaceDefinitionStatement",
			) as common.typed.NamespaceDefinitionStatementNode

			// NOTE: The typed Node's Overloads carry the SAME leading bounded
			// `Item` — one hidden conformance Parameter each, first.
			expect(
				(
					namespaceNode.methods
						.nameOf as common.typed.OverloadedStaticMethod
				).methods.map((overload) =>
					overload.value.generics.map(
						(generic) => `${generic.name}:${generic.constraint}`,
					),
				),
			).toEqual([
				["Item:Comparable"],
				["Item:Comparable"],
				["Item:Comparable", "Other:Comparable"],
			])
		})

		it("should still reject a call that can not bind a retained bound Generic", () => {
			// NOTE: The other half of the same regression — with `Item`
			// retained, a static call that binds nothing is the compile error
			// it has always been, rather than a miscompile.
			let diagnostics = diagnosticsFor(`implementation {
				protocol Nameable {
					static nameOf() -> String
				}

				namespace Bags<infer Item> for { items: List<Item> }
					is Nameable where Item is Comparable
				{
					overload static nameOf {
						() -> String {
							<- "bag"
						}

						<infer Other is Comparable>(_ a: Other, _ b: Other) -> String {
							<- a::compareTo(b)::toString()
						}
					}
				}

				__print(Bags.nameOf("a", "b"))
			}`)

			expect(diagnostics.map((diagnostic) => diagnostic.code)).toEqual([
				"uninferable-type-parameter",
			])
		})
	})

	describe("Protocol Bounds", () => {
		const printableSetup = `
			protocol Showable {
				toString() -> String
			}

			type Vector = { x: Number, y: Number }

			namespace VectorShowable for Vector is Showable {
				toString() -> String {
					<- "vector"
				}
			}
		`

		it("should resolve Methods through a Protocol bound and pass the bound at the call site", () => {
			expect(
				diagnosticsFor(`implementation {
					${printableSetup}

					function describeValue <infer Value is Showable>(_ value: Value) -> String {
						<- value::toString()
					}

					constant text: String = describeValue({ x = 1, y = 2 })
				}`),
			).toEqual([])
		})

		it("should resolve Self Parameters through a Protocol bound", () => {
			expect(
				diagnosticsFor(`implementation {
					protocol Matchable {
						is(_ other: Self) -> Boolean
					}

					type Vector = { x: Number, y: Number }

					namespace VectorMatchable for Vector is Matchable {
						is(_ other: Vector) -> Boolean {
							<- true
						}
					}

					function areEqual <infer Value is Matchable>(_ a: Value, _ b: Value) -> Boolean {
						<- a::is(b)
					}

					constant result: Boolean = areEqual({ x = 1, y = 2 }, { x = 3, y = 4 })
				}`),
			).toEqual([])
		})

		it("should reject a mismatched Argument for a Self Parameter", () => {
			let diagnostics = diagnosticsFor(`implementation {
				protocol Matchable {
					is(_ other: Self) -> Boolean
				}

				function areEqual <infer Value is Matchable>(_ a: Value, _ b: Value) -> Boolean {
					<- a::is(1)
				}
			}`)

			expect(
				diagnostics.some(
					(diagnostic) => diagnostic.code === "no-matching-overload",
				),
			).toBe(true)
		})

		it("should not resolve Methods on an unbounded Type Parameter", () => {
			let diagnostics = diagnosticsFor(`implementation {
				function describeValue <infer Value>(_ value: Value) -> String {
					<- value::toString()
				}
			}`)

			expect(diagnostics.length).toBeGreaterThan(0)
			expect(diagnostics[0].code).toBe("no-namespace-for-value")
		})

		it("should report a binding without a conforming Namespace", () => {
			let diagnostics = diagnosticsFor(`implementation {
				protocol Showable {
					toString() -> String
				}

				function describeValue <infer Value is Showable>(_ value: Value) -> String {
					<- value::toString()
				}

				constant text = describeValue(true)
			}`)

			expect(diagnostics).toHaveLength(1)
			expect(diagnostics[0].message).toBe(
				"Boolean does not conform to 'Showable'",
			)
		})

		it("should forward a bound between bounded Functions", () => {
			expect(
				diagnosticsFor(`implementation {
					${printableSetup}

					function inner <infer Value is Showable>(_ value: Value) -> String {
						<- value::toString()
					}

					function outer <infer Item is Showable>(_ item: Item) -> String {
						<- inner(item)
					}

					constant text: String = outer({ x = 1, y = 2 })
				}`),
			).toEqual([])
		})

		it("should reject forwarding a Type Parameter without the required bound", () => {
			let diagnostics = diagnosticsFor(`implementation {
				protocol Showable {
					toString() -> String
				}

				protocol Matchable {
					is(_ other: Self) -> Boolean
				}

				function inner <infer Value is Showable>(_ value: Value) -> String {
					<- value::toString()
				}

				function outer <infer Item is Matchable>(_ item: Item) -> String {
					<- inner(item)
				}
			}`)

			expect(diagnostics).toHaveLength(1)
			expect(diagnostics[0].message).toBe(
				"Type Parameter 'Item' does not conform to 'Showable'",
			)
		})

		it("should report ambiguous conforming Namespaces", () => {
			let diagnostics = diagnosticsFor(`implementation {
				${printableSetup}

				namespace VectorShowableToo for Vector is Showable {
					toString() -> String {
						<- "vector, too"
					}
				}

				function describeValue <infer Value is Showable>(_ value: Value) -> String {
					<- value::toString()
				}

				constant text = describeValue({ x = 1, y = 2 })
			}`)

			expect(diagnostics).toHaveLength(1)
			expect(diagnostics[0].code).toBe("ambiguous-conformance")
			expect(diagnostics[0].message).toContain("Showable")
		})

		it("should prefer the exact target over a covering Union target", () => {
			expect(
				diagnosticsFor(`implementation {
					${printableSetup}

					namespace MaybeVectorShowable for Vector | Nothing is Showable {
						toString() -> String {
							<- "maybe a vector"
						}
					}

					function describeValue <infer Value is Showable>(_ value: Value) -> String {
						<- value::toString()
					}

					constant vector: Vector = { x = 1, y = 2 }
					constant text: String = describeValue(vector)
				}`),
			).toEqual([])
		})

		it("should reject an unknown Protocol in a bound", () => {
			let diagnostics = diagnosticsFor(`implementation {
				function describeValue <infer Value is Undeclared>(_ value: Value) -> String {
					<- ""
				}
			}`)

			expect(diagnostics).toHaveLength(1)
			expect(diagnostics[0].message).toBe(
				"Protocol 'Undeclared' is not declared",
			)
		})

		it("should reject bounds on Namespace Type Parameters", () => {
			let diagnostics = diagnosticsFor(`implementation {
				protocol Showable {
					toString() -> String
				}

				namespace Wrapper<infer Item is Showable> for List<Item> {
					firstText() -> String {
						<- ""
					}
				}
			}`)

			expect(diagnostics).toHaveLength(1)
			expect(diagnostics[0].message).toBe(
				"A Namespace's Type Parameters can not carry Protocol bounds",
			)
		})
	})

	describe("Builtin Protocols", () => {
		// NOTE: The safety net for the builtin signatures — every declared
		// conformance must actually be fulfilled, via the same helper that
		// drives conformance checking and conformance-value codegen.
		//
		// NOTE: Driven from the ACCESSORS rather than from the TypeScript
		// tables, so it keeps testing whatever is live. A Namespace declared in
		// Essence is checked at load, but only the one that is loaded — reading
		// the tables directly would leave this asserting a property of objects
		// no compilation touches as the conversion moves them across.
		describe("Conformance of builtin Namespaces", () => {
			const protocols = builtinProtocols()
			const namespaces = builtinNamespaces().filter(
				(namespace) => (namespace.conformsTo ?? []).length > 0,
			)

			it("finds Namespaces that declare a conformance", () => {
				expect(namespaces.length).toBeGreaterThan(0)
			})

			for (const namespace of namespaces) {
				it(`${namespace.name} fulfills its declared conformances`, () => {
					expect(namespace.conformsTo).toBeDefined()
					expect(namespace.conformsTo!.length).toBeGreaterThan(0)

					for (const protocolName of namespace.conformsTo ?? []) {
						const protocol = protocols[protocolName]

						expect(protocol).toBeDefined()

						// NOTE: A conditional conformance (List's Comparable)
						// only holds under the `where` conditions it declares —
						// supply them as assumptions, exactly as the Enricher's
						// declaration-side check does.
						const assumptions = new Map(
							(
								namespace.conformanceConditions?.[
									protocolName
								] ?? []
							).map((condition) => [
								condition.generic,
								condition.protocol,
							]),
						)

						const result = computeConformanceMethodMap(
							protocol,
							namespace,
							namespace.targetType!,
							assumptions,
						)

						expect(result.kind).toBe("conforms")
					}
				})
			}
		})

		it("should order Integers with compareTo and match the Ordering exhaustively", () => {
			expect(
				diagnosticsFor(`implementation {
					constant ordering = 5::compareTo(7)

					constant description = match ordering -> String {
						case #Less    { <- "smaller" }
						case #Equal   { <- "same" }
						case #Greater { <- "bigger" }
					}
				}`),
			).toEqual([])
		})

		it("should satisfy builtin Protocol bounds with builtin Types", () => {
			expect(
				diagnosticsFor(`implementation {
					function describeValue <infer Value is Printable>(_ value: Value) -> String {
						<- value::toString()
					}

					__print(describeValue(5))
					__print(describeValue(1/2))
					__print(describeValue("text"))
					__print(describeValue(true))
					__print(describeValue(nothing))
					__print(describeValue({ x = 1 }))
					__print(describeValue(Ordering#Less))
				}`),
			).toEqual([])
		})

		it("should order values through a Comparable bound", () => {
			expect(
				diagnosticsFor(`implementation {
					function smaller <infer Item is Comparable>(_ a: Item, _ b: Item) -> Item {
						<- match a::compareTo(b) -> Item {
							case #Less    { <- a }
							case #Equal   { <- a }
							case #Greater { <- b }
						}
					}

					constant smallerInteger: Integer = smaller(5, 3)
					constant smallerRational: Rational = smaller(1/2, 1/3)
					constant smallerString: String = smaller("a", "b")
				}`),
			).toEqual([])
		})

		it("should sort a List of Strings, now that String is Comparable", () => {
			// NOTE: `sortedBy` needs no Protocol bound — the comparator does —
			// but the annotation only holds if `compareTo` resolves on a
			// String, which it does now that String conforms to Comparable.
			expect(
				diagnosticsFor(`implementation {
					constant ordered: List<String> = ["b", "a"]::sortedBy(
						(first, second) { <- first::compareTo(second) },
					)
				}`),
			).toEqual([])
		})

		it("should type the everyday String Methods", () => {
			expect(
				diagnosticsFor(`implementation {
					constant count: Integer = "hi"::length()
					constant chars: List<String> = "hi"::characters()
					constant char: String | Nothing = "hi"::character(at 0)
					constant loud: String = "hi"::uppercased()::trimmed()
					constant begins: Boolean = "hi"::starts(with "h")
					constant at: Integer | Nothing = "hello"::firstIndex(of "l")
					constant padded: String = "7"::paddedAtStart(to 3, with "0")
				}`),
			).toEqual([])
		})

		it("should compare Nothing and Orderings with Equatable methods", () => {
			expect(
				diagnosticsFor(`implementation {
					constant nothingSame: Boolean = nothing::is(nothing)
					constant orderingSame: Boolean = Ordering#Less::is(Ordering#Less)
					constant orderingText: String = Ordering#Greater::toString()
				}`),
			).toEqual([])
		})

		it("should satisfy bounds with the Number Union through its covering Namespace", () => {
			expect(
				diagnosticsFor(`implementation {
					function describeValue <infer Value is Printable>(_ value: Value) -> String {
						<- value::toString()
					}

					function smaller <infer Item is Comparable>(_ a: Item, _ b: Item) -> Item {
						<- match a::compareTo(b) -> Item {
							case #Less    { <- a }
							case #Equal   { <- a }
							case #Greater { <- b }
						}
					}

					constant number: Number = 5
					constant other: Number = 1/2

					constant text = describeValue(number)
					constant smallest: Number = smaller(number, other)
					constant same: Boolean = number::is(other)
				}`),
			).toEqual([])
		})

		it("should let a concrete Record conformance beat the builtin Record Namespace", () => {
			expect(
				diagnosticsFor(`implementation {
					type Vector = { x: Number, y: Number }

					namespace VectorPrintable for Vector is Printable {
						toString() -> String {
							<- "a vector"
						}
					}

					function describeValue <infer Value is Printable>(_ value: Value) -> String {
						<- value::toString()
					}

					constant text: String = describeValue({ x = 1, y = 2 })
				}`),
			).toEqual([])
		})

		it("should resolve Methods on a Union-typed Ordering receiver", () => {
			expect(
				diagnosticsFor(`implementation {
					constant text: String = 5::compareTo(7)::toString()
					constant same: Boolean = 5::compareTo(7)::is(Ordering#Less)
				}`),
			).toEqual([])
		})

		// NOTE: The ordering family lives only on the covering Number
		// Namespace, so a mixed-kind comparison resolves through it — the
		// member Namespaces declare no cross-kind `isLessThan` of their own.
		it("should compare across Number kinds through the Number Namespace", () => {
			expect(
				diagnosticsFor(`implementation {
					constant belowPi: Boolean = 3::isLessThan(Number.PI)
					constant orderedPis: Boolean = Number.PI::isGreaterThan(Number.TAU)
					constant rootVsHalf = match 2::squareRoot() -> Boolean {
						case Algebraic { <- @::isLessThanOrEqualTo(3/2) }
						case Integer   { <- false }
						case Nothing   { <- false }
					}
				}`),
			).toEqual([])
		})

		it("should span the numeric tower for Integer::add", () => {
			// NOTE: The Transcendental annotation only type-checks if
			// `1::add(π)` resolves to the new overload. The match narrows √2
			// to an Algebraic and adds an Integer to it — the other new
			// overload — with `toString` keeping the handler's return a String
			// so the test turns on resolution, not on the result Type.
			expect(
				diagnosticsFor(`implementation {
					constant withPi: Transcendental = 1::add(Number.PI)
					constant withRoot: String = match 2::squareRoot() -> String {
						case Algebraic { <- 1::add(@)::toString() }
						case Integer   { <- @::toString() }
						case Nothing   { <- "none" }
					}
				}`),
			).toEqual([])
		})

		// NOTE: Cross-kind comparison lives only on Number. Integer and
		// Rational keep the same-kind `isLessThan` they always had, but it was
		// deliberately not widened to the irrationals, and the irrationals
		// declare no comparison of their own — deciding a Transcendental
		// ordering in general is undecidable, so the claim is made once by
		// Number. This guards against a well-meaning re-addition to a member.
		it("keeps cross-kind comparison off the member Namespaces", () => {
			// NOTE: The argument Types Integer::isLessThan accepts — no
			// Algebraic or Transcendental among them.
			let integerLessThan = builtinNamespace("Integer").methods
				.isLessThan as common.OverloadedMethodType
			let acceptedKinds = integerLessThan.overloads.map(
				(overload) => overload.parameterTypes[1].type.type,
			)

			expect(acceptedKinds).not.toContain("Algebraic")
			expect(acceptedKinds).not.toContain("Transcendental")

			expect(
				builtinNamespace("Algebraic").methods.isLessThan,
			).toBeUndefined()
			expect(
				builtinNamespace("Transcendental").methods.isLessThan,
			).toBeUndefined()
			expect(builtinNamespace("Number").methods.isLessThan).toBeDefined()
		})

		it("should not allow redeclaring a builtin Protocol", () => {
			let diagnostics = diagnosticsFor(`implementation {
				protocol Printable {
					toString() -> String
				}
			}`)

			expect(diagnostics).toHaveLength(1)
			expect(diagnostics[0].message).toBe(
				"Protocol 'Printable' is already declared",
			)
		})
	})

	describe("Union Method Dispatch", () => {
		function lastConstantValue(
			source: string,
		): common.typed.MethodInvocationNode {
			let { program, diagnostics } = enrichSource(source)

			expect(diagnostics).toEqual([])

			let constants = program.implementation.nodes.filter(
				(node) => node.nodeType === "ConstantDeclarationStatement",
			)
			let value = constants[constants.length - 1].value

			expect(value.nodeType).toBe("MethodInvocation")

			if (value.nodeType !== "MethodInvocation") {
				throw new Error("Last Constant is not a MethodInvocation.")
			}

			return value
		}

		it("should dispatch a Number receiver to every member Namespace", () => {
			let invocation = lastConstantValue(`implementation {
				constant number: Number = 5
				constant doubled = number::multiply(with 2)
			}`)

			expect(invocation.namespace.name).toBe("")
			expect(invocation.dispatch).not.toBeNull()
			expect(
				invocation.dispatch?.map(
					(dispatchCase) => dispatchCase.namespaceName,
				),
			).toEqual(["Integer", "Rational", "Algebraic", "Transcendental"])
			expect(invocation.type).toEqual({
				type: "UnionType",
				types: [
					{ type: "Integer" },
					{ type: "Rational" },
					{ type: "Algebraic" },
					{ type: "Transcendental" },
				],
			})
		})

		it("should collapse identical branch return Types", () => {
			let invocation = lastConstantValue(`implementation {
				constant value: Integer | Boolean = 5
				constant text = value::toString()
			}`)

			expect(invocation.dispatch).not.toBeNull()
			expect(invocation.type).toEqual({ type: "String" })
		})

		it("should keep a Namespace covering the whole Union ahead of dispatch", () => {
			let invocation = lastConstantValue(`implementation {
				constant ordering = 5::compareTo(7)
				constant same = ordering::is(Ordering#Less)
			}`)

			expect(invocation.namespace.name).toBe("Ordering")
			expect(invocation.dispatch).toBeNull()
			expect(invocation.type).toEqual({ type: "Boolean" })
		})

		it("should dispatch across unrelated member Namespaces", () => {
			let invocation = lastConstantValue(`implementation {
				constant quotient = 10::divide(by 0)
				constant text = quotient::toString()
			}`)

			expect(invocation.dispatch).not.toBeNull()
			expect(invocation.type).toEqual({ type: "String" })
		})

		it("should union distinct branch return Types through user Namespaces", () => {
			let invocation = lastConstantValue(`implementation {
				namespace IntegerTag for Integer {
					tag() -> String {
						<- "integer"
					}
				}

				namespace BooleanTag for Boolean {
					tag() -> Integer {
						<- 1
					}
				}

				constant value: Integer | Boolean = 5
				constant tagged = value::tag()
			}`)

			expect(
				invocation.dispatch?.map(
					(dispatchCase) => dispatchCase.namespaceName,
				),
			).toEqual(["IntegerTag", "BooleanTag"])
			expect(invocation.type).toEqual({
				type: "UnionType",
				types: [{ type: "String" }, { type: "Integer" }],
			})
		})

		it("should reject the call when a member Type lacks the Method", () => {
			let diagnostics = diagnosticsFor(`implementation {
				constant value: Integer | Boolean = 5
				constant bad = value::multiply(with 2)
			}`)

			expect(
				diagnostics.some(
					(diagnostic) =>
						diagnostic.message ===
						"No Method named 'multiply' for Boolean",
				),
			).toBe(true)
		})

		it("should reject the call when a member Type rejects the Arguments", () => {
			let diagnostics = diagnosticsFor(`implementation {
				namespace IntegerTag for Integer {
					tag(_ flag: Integer) -> String {
						<- "integer"
					}
				}

				namespace BooleanTag for Boolean {
					tag(_ flag: Boolean) -> String {
						<- "boolean"
					}
				}

				constant value: Integer | Boolean = 5
				constant bad = value::tag(1)
			}`)

			expect(
				diagnostics.some(
					(diagnostic) =>
						diagnostic.message ===
						"No overload of 'tag' accepts these Arguments for Boolean",
				),
			).toBe(true)
		})

		it("should reject ambiguous resolution for a member Type", () => {
			let diagnostics = diagnosticsFor(`implementation {
				namespace TagA for Integer {
					tag() -> String {
						<- "a"
					}
				}

				namespace TagB for Integer {
					tag() -> String {
						<- "b"
					}
				}

				namespace BooleanTag for Boolean {
					tag() -> String {
						<- "boolean"
					}
				}

				constant value: Integer | Boolean = 5
				constant bad = value::tag()
			}`)

			expect(
				diagnostics.some(
					(diagnostic) =>
						diagnostic.message ===
						"'tag' is provided by more than one Namespace for Integer",
				),
			).toBe(true)
		})

		it("should dispatch a bounded Type Parameter member through its conformance", () => {
			expect(
				diagnosticsFor(`implementation {
					function firstText <infer Item is Printable>(_ items: List<Item>) -> String {
						<- items::firstItem()::toString()
					}

					constant text: String = firstText([1, 2])
				}`),
			).toEqual([])
		})

		it("should prefer the more specific member Namespace inside a dispatch", () => {
			let invocation = lastConstantValue(`implementation {
				namespace IntegerTag for Integer {
					tag() -> String {
						<- "integer"
					}
				}

				namespace EitherTag for Integer | Boolean {
					tag() -> String {
						<- "either"
					}
				}

				namespace StringTag for String {
					tag() -> String {
						<- "string"
					}
				}

				constant value: Integer | String = 5
				constant tagged = value::tag()
			}`)

			expect(
				invocation.dispatch?.map(
					(dispatchCase) => dispatchCase.namespaceName,
				),
			).toEqual(["IntegerTag", "StringTag"])
		})
	})

	describe("Method Target Specificity", () => {
		function lastConstantValue(
			source: string,
		): common.typed.MethodInvocationNode {
			let { program, diagnostics } = enrichSource(source)

			expect(diagnostics).toEqual([])

			let constants = program.implementation.nodes.filter(
				(node) => node.nodeType === "ConstantDeclarationStatement",
			)
			let value = constants[constants.length - 1].value

			expect(value.nodeType).toBe("MethodInvocation")

			if (value.nodeType !== "MethodInvocation") {
				throw new Error("Last Constant is not a MethodInvocation.")
			}

			return value
		}

		it("should prefer the Namespace with the strictly more specific target Type", () => {
			let invocation = lastConstantValue(`implementation {
				namespace IntegerTag for Integer {
					tag() -> String {
						<- "integer"
					}
				}

				namespace EitherTag for Integer | Boolean {
					tag() -> Integer {
						<- 1
					}
				}

				constant tagged = 5::tag()
			}`)

			expect(invocation.namespace.name).toBe("IntegerTag")
			expect(invocation.type).toEqual({ type: "String" })
		})

		it("should resolve a Union receiver through the covering Namespace", () => {
			let invocation = lastConstantValue(`implementation {
				namespace IntegerTag for Integer {
					tag() -> String {
						<- "integer"
					}
				}

				namespace EitherTag for Integer | Boolean {
					tag() -> Integer {
						<- 1
					}
				}

				constant value: Integer | Boolean = 5
				constant tagged = value::tag()
			}`)

			expect(invocation.namespace.name).toBe("EitherTag")
			expect(invocation.dispatch).toBeNull()
			expect(invocation.type).toEqual({ type: "Integer" })
		})

		it("should route single-member receivers past the Number Namespace", () => {
			let invocation = lastConstantValue(`implementation {
				constant same = 5::is(3)
			}`)

			expect(invocation.namespace.name).toBe("Integer")
		})

		it("should resolve mixed-member comparisons through the Number Namespace", () => {
			let invocation = lastConstantValue(`implementation {
				constant same = 1::is(1/1)
			}`)

			expect(invocation.namespace.name).toBe("Number")
			expect(invocation.type).toEqual({ type: "Boolean" })
		})

		it("should order mixed members through the Number Namespace", () => {
			expect(
				diagnosticsFor(`implementation {
					constant ordered = match 5::compareTo(1/2) -> String {
						case #Less    { <- "smaller" }
						case #Equal   { <- "same" }
						case #Greater { <- "bigger" }
					}
				}`),
			).toEqual([])
		})
	})
})
