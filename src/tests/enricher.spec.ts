import { describe, expect, it } from "bun:test"

import { enrich } from "../enricher/index"
import { namespace as algebraicNamespace } from "../enricher/types/Algebraic"
import { namespace as booleanNamespace } from "../enricher/types/Boolean"
import { namespace as integerNamespace } from "../enricher/types/Integer"
import { namespace as nothingNamespace } from "../enricher/types/Nothing"
import { namespace as numberNamespace } from "../enricher/types/Number"
import { namespace as orderingNamespace } from "../enricher/types/Ordering"
import { Comparable, Equatable, Printable } from "../enricher/types/Protocols"
import { namespace as rationalNamespace } from "../enricher/types/Rational"
import { namespace as recordNamespace } from "../enricher/types/Record"
import { namespace as stringNamespace } from "../enricher/types/String"
import { namespace as transcendentalNamespace } from "../enricher/types/Transcendental"
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
								<- value::multiplyWith(2)
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

		it("should reject a Conformance Clause on a generic Namespace", () => {
			let diagnostics = diagnosticsFor(`implementation {
				protocol Showable {
					toString() -> String
				}

				namespace ListShowable<infer Item> for List<Item> is Showable {
					toString() -> String {
						<- "list"
					}
				}
			}`)

			expect(diagnostics).toHaveLength(1)
			expect(diagnostics[0].message).toBe(
				"A generic Namespace can not declare Protocol conformance",
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
		// NOTE: The safety net for the hand written builtin signatures — every
		// declared conformance must actually be fulfilled, via the same helper
		// that drives conformance checking and conformance-value codegen.
		describe("Conformance of builtin Namespaces", () => {
			const protocols: Record<string, common.ProtocolType> = {
				Equatable,
				Printable,
				Comparable,
			}

			const namespaces = [
				stringNamespace,
				booleanNamespace,
				integerNamespace,
				rationalNamespace,
				numberNamespace,
				recordNamespace,
				nothingNamespace,
				orderingNamespace,
			]

			for (const namespace of namespaces) {
				it(`${namespace.name} fulfills its declared conformances`, () => {
					expect(namespace.conformsTo).toBeDefined()
					expect(namespace.conformsTo!.length).toBeGreaterThan(0)

					for (const protocolName of namespace.conformsTo ?? []) {
						const protocol = protocols[protocolName]

						expect(protocol).toBeDefined()

						const result = computeConformanceMethodMap(
							protocol,
							namespace,
							namespace.targetType!,
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
					constant char: String | Nothing = "hi"::characterAt(0)
					constant loud: String = "hi"::uppercased()::trimmed()
					constant begins: Boolean = "hi"::startsWith("h")
					constant at: Integer | Nothing = "hello"::firstIndexOf("l")
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
			let integerLessThan = integerNamespace.methods
				.isLessThan as common.OverloadedMethodType
			let acceptedKinds = integerLessThan.overloads.map(
				(overload) => overload.parameterTypes[1].type.type,
			)

			expect(acceptedKinds).not.toContain("Algebraic")
			expect(acceptedKinds).not.toContain("Transcendental")

			expect(algebraicNamespace.methods.isLessThan).toBeUndefined()
			expect(transcendentalNamespace.methods.isLessThan).toBeUndefined()
			expect(numberNamespace.methods.isLessThan).toBeDefined()
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
				constant doubled = number::multiplyWith(2)
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
				constant quotient = 10::divideBy(0)
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
				constant bad = value::multiplyWith(2)
			}`)

			expect(
				diagnostics.some(
					(diagnostic) =>
						diagnostic.message ===
						"No Method named 'multiplyWith' for Boolean",
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
