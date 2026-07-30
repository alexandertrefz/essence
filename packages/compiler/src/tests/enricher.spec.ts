import { describe, expect, it } from "bun:test"

import type { common } from "@essence-lang/interfaces"

import { builtinNamespaces, builtinProtocols } from "../enricher/builtins"
import { enrich } from "../enricher/index"
import { derivedEquatableNamespace } from "../enricher/resolvers"
import { computeConformanceMethodMap } from "../helpers/index"
import { parse } from "../parser/index"
import { printType } from "../printType"

function enrichSource(source: string): {
	program: common.typed.Program
	diagnostics: Array<common.Diagnostic>
} {
	return enrich(parse(source))
}

function diagnosticsFor(source: string): Array<common.Diagnostic> {
	return enrichSource(source).diagnostics
}

// NOTE: The characters a Diagnostic's Position covers — which is the text a
// Quick Fix replaces with the suggestion the same Diagnostic carries. Spelling
// them out is the only way to assert that a `#Case` span stops short of the
// sigil without counting columns by hand. Single line spans only; every
// Diagnostic asked this reports on one name.
function underlinedText(source: string, diagnostic: common.Diagnostic): string {
	let position = diagnostic.position

	if (position === null) {
		throw new Error("Diagnostic has no Position.")
	}

	return source
		.split("\n")
		[position.start.line - 1].slice(
			position.start.column - 1,
			position.end.column - 1,
		)
}

// NOTE: The typed Expression a Program's LAST Constant was declared from —
// which is how a test asks what a call resolved to: which Namespace won, which
// Overload, which dispatch branches, and what the Arguments were typed as. The
// Program is required to enrich cleanly, so a test that means to assert on a
// resolution can not silently assert on a failed one instead.
function lastConstantValue(source: string): common.typed.ExpressionNode {
	let { program, diagnostics } = enrichSource(source)

	expect(diagnostics).toEqual([])

	let constants = program.implementation.nodes.filter(
		(node) => node.nodeType === "ConstantDeclarationStatement",
	)

	return constants[constants.length - 1].value
}

function lastConstantMethodInvocation(
	source: string,
): common.typed.MethodInvocationNode {
	let value = lastConstantValue(source)

	expect(value.nodeType).toBe("MethodInvocation")

	if (value.nodeType !== "MethodInvocation") {
		throw new Error("Last Constant is not a MethodInvocation.")
	}

	return value
}

function lastConstantFunctionInvocation(
	source: string,
): common.typed.FunctionInvocationNode {
	let value = lastConstantValue(source)

	expect(value.nodeType).toBe("FunctionInvocation")

	if (value.nodeType !== "FunctionInvocation") {
		throw new Error("Last Constant is not a FunctionInvocation.")
	}

	return value
}

// NOTE: The Type an applied `Optional<ItemType>` enriches to. It is no longer
// the Union `ItemType | Nothing` an Alias expanded to, but the Union of the two
// Cases the `Optional` Choice declares — each carrying the Type Arguments the
// application bound, under the applied spelling as the display alias. Written
// once here because the shape is long and says nothing a test is about; what a
// test is about is the item Type threaded through it.
function optionalOf(itemType: common.Type): common.Type {
	return {
		type: "UnionType",
		alias: { name: "Optional", typeArguments: [itemType] },
		types: [
			{
				type: "Case",
				choice: "Optional",
				name: "Value",
				members: { item: itemType },
				typeArguments: [itemType],
			},
			{
				type: "Case",
				choice: "Optional",
				name: "Empty",
				members: {},
				typeArguments: [itemType],
			},
		],
	}
}

// NOTE: The LIVE Namespace of that name — the one read from `packages/stdlib/sources/*.es`
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

// NOTE: Every Case construction in a typed subtree, in the order it was built —
// how a test asks what a Case a Program never spelled the Type Arguments of was
// finally decided as. A `GenericUse` left in `typeArguments` is a Type Parameter
// nothing decided, which is exactly what such an assertion is about.
function collectCaseTypes(value: unknown): Array<common.Type> {
	let found: Array<common.Type> = []

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

		let record = node as Record<string, unknown>

		if (record.nodeType === "CaseValue") {
			found.push(record.type as common.Type)
		}

		for (let key of Object.keys(record)) {
			if (key === "position" || key === "type") {
				continue
			}

			visit(record[key])
		}
	}

	visit(value)

	return found
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

		// NOTE: The Help and the `data` must name the same thing — the Help is
		// what the reader is told and the `data` is what a Quick Fix writes,
		// and a fix that inserts a different name than the Diagnostic offered
		// is worse than no fix at all.
		it("should carry a near miss as data as well as a Help", () => {
			let diagnostics = diagnosticsFor(`implementation {
				constant a = "value"::lenth()
			}`)

			expect(diagnostics[0].code).toBe("unknown-method")
			expect(diagnostics[0].helps).toEqual(["Did you mean 'length'?"])
			expect(diagnostics[0].data).toEqual({
				kind: "suggestion",
				suggestion: "length",
			})
		})

		it("should carry no data when nothing is close enough to suggest", () => {
			let diagnostics = diagnosticsFor(`implementation {
				constant a = "value"::undeclaredMethod()
			}`)

			expect(diagnostics[0].helps).toEqual([])
			expect(diagnostics[0].data).toBeUndefined()
		})

		// NOTE: The bare name, so the Case Quick Fix replaces exactly what the
		// Diagnostic underlines — the `#` belongs to the Help's rendering.
		it("should carry an unknown Case's near miss without its sigil", () => {
			let diagnostics = diagnosticsFor(`implementation {
				choice Operation { Add, Subtract }
				constant chosen = Operation#Ad
			}`)

			expect(diagnostics[0].code).toBe("unknown-case")
			expect(diagnostics[0].helps).toEqual(["Did you mean '#Add'?"])
			expect(diagnostics[0].data).toEqual({
				kind: "suggestion",
				suggestion: "Add",
			})
		})

		// NOTE: The bare form is the spelling this codebase prefers, so it is
		// the one a near miss matters most for — and it is reported from its
		// own site, which once offered nothing while the documentation
		// promised a Quick Fix for every unknown Case.
		it("should carry a bare Case reference's near miss", () => {
			let source = `implementation {
				choice Operation { Add, Subtract }
				constant chosen: Operation = #Ad
			}`
			let diagnostics = diagnosticsFor(source)

			expect(diagnostics[0].code).toBe("unknown-case")
			expect(diagnostics[0].helps).toEqual(["Did you mean '#Add'?"])
			expect(diagnostics[0].data).toEqual({
				kind: "suggestion",
				suggestion: "Add",
			})
			expect(underlinedText(source, diagnostics[0])).toBe("Ad")
		})

		it("should carry no data for a bare Case nothing is close to", () => {
			let diagnostics = diagnosticsFor(`implementation {
				choice Operation { Add, Subtract }
				constant chosen: Operation = #Zzzzzzzz
			}`)

			expect(diagnostics[0].code).toBe("unknown-case")
			expect(diagnostics[0].helps).toEqual([])
			expect(diagnostics[0].data).toBeUndefined()
		})

		it("should carry a bare Case Matcher's near miss", () => {
			let source = `implementation {
				choice Operation { Add, Subtract }
				constant chosen: Operation = Operation#Add

				match chosen -> {} {
					case #Ad { <- {} }
					case _ { <- {} }
				}
			}`
			let diagnostics = diagnosticsFor(source)

			expect(diagnostics[0].code).toBe("unknown-case")
			expect(diagnostics[0].helps).toEqual(["Did you mean '#Add'?"])
			expect(diagnostics[0].data).toEqual({
				kind: "suggestion",
				suggestion: "Add",
			})
			expect(underlinedText(source, diagnostics[0])).toBe("Ad")
		})

		it("should carry no data for a Case Matcher nothing is close to", () => {
			let diagnostics = diagnosticsFor(`implementation {
				choice Operation { Add, Subtract }
				constant chosen: Operation = Operation#Add

				match chosen -> {} {
					case #Zzzzzzzz { <- {} }
					case _ { <- {} }
				}
			}`)

			expect(diagnostics[0].code).toBe("unknown-case")
			expect(diagnostics[0].helps).toEqual([])
			expect(diagnostics[0].data).toBeUndefined()
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

	describe("String Interpolation", () => {
		it("should accept a Printable hole and type the whole as String", () => {
			let { program, diagnostics } = enrichSource(`implementation {
				constant count = 3
				constant message = "count: {count}"
			}`)

			expect(diagnostics).toEqual([])

			let declaration = program.implementation.nodes[1]
			expect(declaration.nodeType).toBe("ConstantDeclarationStatement")

			if (declaration.nodeType === "ConstantDeclarationStatement") {
				expect(declaration.value.nodeType).toBe(
					"InterpolatedStringValue",
				)
				expect(declaration.value.type).toEqual({ type: "String" })
			}
		})

		// NOTE: A Function is the hole this reaches for because the answer of a
		// fallible call is no longer one. `3::squareRoot()` used to be an
		// `Integer | Algebraic | Nothing`, a bare Union belonging to no
		// Namespace and so conforming to nothing; `Optional<ItemType>` is a
		// Choice with a Namespace that conforms to `Printable` exactly when its
		// payload does, so the same call interpolates cleanly today. A Function
		// conforms to nothing at all, whatever it returns.
		it("should refuse a hole that is not Printable", () => {
			let diagnostics = diagnosticsFor(`implementation {
				constant greet = (subject: String) -> String { <- subject }
				constant message = "greeting: {greet}"
			}`)

			expect(diagnostics).toHaveLength(1)
			expect(diagnostics[0].code).toBe("interpolation-not-printable")
			expect(diagnostics[0].message).toBe(
				"(subject: String) -> String can not be interpolated into a String",
			)
		})

		it("should accept an Optional hole whose payload is Printable", () => {
			expect(
				diagnosticsFor(`implementation {
					constant maybe = 3::squareRoot()
					constant message = "root: {maybe}"
				}`),
			).toEqual([])
		})

		it("should refuse an Optional hole whose payload is not Printable", () => {
			// NOTE: The conditional half of the conformance — the Optional
			// itself is the same Type as the one accepted above, and it is the
			// payload that decides. A List of Functions is the shortest way to
			// hand `firstItem` a payload nothing can print.
			let diagnostics = diagnosticsFor(`implementation {
				constant greet = (subject: String) -> String { <- subject }
				constant maybe = [greet]::firstItem()
				constant message = "greeting: {maybe}"
			}`)

			expect(diagnostics).toHaveLength(1)
			expect(diagnostics[0].code).toBe("interpolation-not-printable")
			expect(diagnostics[0].message).toBe(
				"Optional<(subject: String) -> String> can not be interpolated into a String",
			)
		})

		it("should still enrich the Statements around a bad hole", () => {
			let { program, diagnostics } = enrichSource(`implementation {
				constant greet = (subject: String) -> String { <- subject }
				constant message = "greeting: {greet}"
				constant after = 5
			}`)

			expect(diagnostics).toHaveLength(1)
			expect(program.implementation.nodes).toHaveLength(3)
		})

		it("should warn about a 'toString' the hole would call itself", () => {
			let source = `implementation {
				constant count = 3
				constant message = "count: {count::toString()}"
			}`
			let diagnostics = diagnosticsFor(source)

			expect(diagnostics).toHaveLength(1)
			expect(diagnostics[0].code).toBe(
				"redundant-interpolation-to-string",
			)
			expect(diagnostics[0].severity).toBe("warning")
			// NOTE: The span is the call alone — the receiver stays, and the
			// greyed-out range is exactly what the Quick Fix deletes.
			expect(underlinedText(source, diagnostics[0])).toBe("::toString()")
			expect(diagnostics[0].tags).toEqual(["unnecessary"])
		})

		it("should warn about a 'toString' on a String, which is its own representation", () => {
			let diagnostics = diagnosticsFor(`implementation {
				constant name = "Ada"
				constant message = "hello, {name::toString()}"
			}`)

			expect(diagnostics).toHaveLength(1)
			expect(diagnostics[0].code).toBe(
				"redundant-interpolation-to-string",
			)
		})

		it("should underline only the last call of a chained receiver", () => {
			let source = `implementation {
				constant words = ["a", "b"]
				constant message = "words: {words::length()::toString()}"
			}`
			let diagnostics = diagnosticsFor(source)

			expect(diagnostics).toHaveLength(1)
			expect(underlinedText(source, diagnostics[0])).toBe("::toString()")
		})

		it("should accept a 'toString' that takes an Argument", () => {
			// NOTE: `Rational.toString(formatAs:)` picks a form the hole would
			// not have — dropping the call would change the String.
			expect(
				diagnosticsFor(`implementation {
					constant message = "half: {1/2::toString(formatAs NumberFormat#Decimal)}"
				}`),
			).toEqual([])
		})

		it("should accept a 'toString' on a receiver that is not Printable itself", () => {
			// NOTE: A bare structural Union belongs to no Namespace, so nothing
			// makes it conform — the Method resolves per member and the explicit
			// call is the only spelling that works.
			expect(
				diagnosticsFor(`implementation {
					constant value: Integer | String = 1
					constant message = "value: {value::toString()}"
				}`),
			).toEqual([])
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
			).toEqual(optionalOf({ type: "Integer" }))
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
			).toEqual(optionalOf({ type: "Integer" }))
		})

		it("should substitute the receiver's item Type into List returns", () => {
			expect(
				typeOfFirstConstant(`implementation {
					constant shorter = ["a", "b"]::removeFirst()
				}`),
			).toEqual({ type: "List", itemType: { type: "String" } })
		})

		it("should infer Namespace Generics from the receiver", () => {
			// NOTE: `firstAgain` hands `firstItem`'s answer straight back, so
			// its return Type is written as the `Optional<Item>` that answer IS
			// — the Choice does not widen into an `Item | Nothing` the way the
			// Alias used to expand into one. What is asserted is unchanged: the
			// `Item` the Namespace abstracts over was bound to String by the
			// receiver alone.
			expect(
				typeOfFirstConstant(`implementation {
					namespace Wrapper<infer Item> for List<Item> {
						firstAgain() -> Optional<Item> {
							<- @::firstItem()
						}
					}

					constant first = ["x"]::firstAgain()
				}`),
			).toEqual(optionalOf({ type: "String" }))
		})

		it("terminates inference for a generic reduce-step folding into an Optional", () => {
			// NOTE: The exact shape `List.firstItem(where:)` is written in — a
			// Namespace generic in `ItemType` folding with `reduce`'s
			// early-stopping entry into an `Optional<ItemType>` Result. `reduce`'s
			// own Namespace Generic is ALSO `ItemType`, so binding it off the
			// receiver records `ItemType := ItemType`; treated as still open to
			// binding, matching that self-reference against the members of the
			// bound `Optional<ItemType>` Result — `Optional#Empty`, or the
			// `ItemType` the `Optional#Value` Case carries as its payload — sent
			// inference into an endless loop. `isOpenBindable` pins it as opaque,
			// so this terminates and the fold's Result is `Optional<Integer>`.
			expect(
				typeOfFirstConstant(`implementation {
					namespace Finder<infer ItemType> for List<ItemType> {
						firstMatch(where check: (_: ItemType) -> Boolean) -> Optional<ItemType> {
							constant start: Optional<ItemType> = #Empty

							<- @::reduce(startingWith start, step (found, item) {
								if check(item) { <- #Done(#Value(item)) }

								<- #Continue(found)
							})
						}
					}

					constant found = [1, 2, 3]::firstMatch(where (n) { <- n::isGreaterThan(1) })
				}`),
			).toEqual(optionalOf({ type: "Integer" }))
		})

		it("freshens callee Generics so a same-named caller Generic can not collide", () => {
			// NOTE: `myCount`'s `State` and the general `loop`'s own `State` share a
			// spelling, and the Record threaded as the loop's State MENTIONS it. By
			// name alone the callee's bindable `State` and the caller's opaque
			// `State` are one symbol, so binding `State := { carried: State }` used
			// to substitute the name into itself until the stack died — a caught
			// `internal-error`, a crash uncaught. Freshening the callee's Generics
			// to unique names for the match keeps the two distinct, so this resolves
			// cleanly with no Diagnostics at all.
			expect(
				diagnosticsFor(`implementation {
					function myCount<State>(
						startingWith state: State,
						step advance: (_: State) -> State,
					) -> State {
						<- loop(startingWith { carried = state }, step (current) {
							<- #Done(current.carried)
						})
					}
				}`),
			).toEqual([])
		})

		// NOTE: The same collision one rail over — this time between a CHOICE's
		// own Type Parameters and the caller's. `Step`'s first Parameter is
		// spelled `State`, and so is `myCount`'s, and the payload handed to
		// `#Done` is Typed as the caller's: matched by name, that payload bound
		// `Step`'s `State` to the whole `{ value: Result }` Record and left
		// `Result` — the Parameter it was there to decide — bound by nothing at
		// all. The construction's own match freshens too now, so the `Done`
		// carries the caller's `State` as its Result and the loop finishes with
		// it.
		it("freshens a Choice's own Generics against a same-named caller Generic", () => {
			let { program, diagnostics } = enrichSource(`implementation {
				function myCount<State>(
					startingWith state: State,
					step advance: (_: State) -> State,
				) -> State {
					<- loop(startingWith { carried = state }, step (current) {
						<- #Done(current.carried)
					})
				}
			}`)

			expect(diagnostics).toEqual([])
			expect(collectCaseTypes(program)).toEqual([
				{
					type: "Case",
					choice: "Step",
					name: "Done",
					members: { value: { type: "GenericUse", name: "State" } },
					typeArguments: [
						{
							type: "Record",
							members: {
								carried: { type: "GenericUse", name: "State" },
							},
						},
						{ type: "GenericUse", name: "State" },
					],
				},
			])
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
								case #Empty { <- fallbackValue }
								case #Value(item) { <- transform(item) }
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
				// NOTE: Two returns of unrelated Types — an Integer and a
				// String — is all this needs; what it is about is that the
				// literal's return Type is read as the Union of every return
				// its body makes, not off the first one the walk reaches.
				expect(
					typeOfFirstConstant(`implementation {
						namespace Mapper<infer Item> for List<Item> {
							transformFirst<infer Target>(
								_ transform: (_ item: Item) -> Target,
							) -> Target {
								<- transform(1)
							}
						}

						constant doubledOrLabel = [1]::transformFirst((value) {
							if value::isGreaterThan(0) {
								<- value::multiply(with 2)
							}

							<- "none"
						})
					}`),
				).toEqual({
					type: "UnionType",
					types: [{ type: "Integer" }, { type: "String" }],
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

			// NOTE: Resolution probes EVERY Namespace declaring the Method,
			// including the ones it goes on to reject — an unannotated literal
			// matches whatever Parameter Type it is probed against, so each
			// probe resolves it differently. Only the winning Namespace's
			// resolution may reach the literal's body: it decides which
			// Namespace `item::toString()` is looked up in, and the receiver
			// the Rewriter actually passes is the winner's.
			it("types the literal by the Namespace that won, not the last probed", () => {
				let source = `implementation {
					namespace IntApplier for Integer {
						apply(_ transform: (_ item: Integer) -> String) -> String {
							<- transform(@)
						}
					}

					namespace NumApplier for Number {
						apply(_ transform: (_ item: Boolean) -> String) -> String {
							<- transform(true)
						}
					}

					constant applied = 1::apply((item) { <- item::toString() })
				}`

				expect(diagnosticsFor(source)).toEqual([])

				let invocation = lastConstantMethodInvocation(source)

				expect(invocation.namespace.name).toBe("IntApplier")

				let literal = invocation.arguments[0].value

				expect(literal.nodeType).toBe("FunctionValue")

				if (literal.nodeType !== "FunctionValue") {
					throw new Error("The Argument is not a Function literal.")
				}

				expect(literal.value.parameters[0].internalName?.type).toEqual({
					type: "Integer",
				})

				let body = literal.value.body[0]

				expect(body.nodeType).toBe("ReturnStatement")

				if (body.nodeType !== "ReturnStatement") {
					throw new Error("The literal does not return.")
				}

				expect(body.expression.nodeType).toBe("MethodInvocation")

				if (body.expression.nodeType !== "MethodInvocation") {
					throw new Error("The literal does not return a call.")
				}

				expect(body.expression.namespace.name).toBe("Integer")
			})

			it("keeps the literal typed when resolution stays ambiguous", () => {
				// NOTE: No winner to read the literal's Types off, so the last
				// probe's stand in — the Invocation fails either way, and a
				// literal left with nothing recorded would report its
				// Parameters as uninferable on top of the real Diagnostic.
				expect(
					diagnosticsFor(`implementation {
						namespace FirstApplier for Integer {
							apply(_ transform: (_ item: Integer) -> String) -> String {
								<- transform(@)
							}
						}

						namespace SecondApplier for Integer {
							apply(_ transform: (_ item: Integer) -> String) -> String {
								<- transform(@)
							}
						}

						constant applied = 1::apply((item) { <- item::toString() })
					}`).map((diagnostic) => diagnostic.code),
				).toEqual(["ambiguous-namespace"])
			})

			// NOTE: A callee with no Type Parameters infers nothing, which is
			// why its Arguments used to be handed straight back — and a literal
			// that omitted its annotations was told it had nothing to infer
			// from, in the very Argument position the Diagnostic's own Note
			// names as the one place that works. The identical literal passed
			// to a non-Generic METHOD always resolved, because Method
			// resolution matches its Arguments on every path.
			it("takes its Parameter Type from a non-Generic free Function", () => {
				expect(
					typeOfFirstConstant(`implementation {
						function apply(_ transform: (_ item: Integer) -> Integer) -> Integer {
							<- transform(1)
						}

						constant applied = apply((item) { <- item::add(1) })
					}`),
				).toEqual({ type: "Integer" })
			})

			it("takes its return Type from a non-Generic free Function", () => {
				// NOTE: The Parameter is written out, so only the omitted
				// `-> Type` is left to come from the expected signature.
				expect(
					diagnosticsFor(`implementation {
						function apply(_ transform: (_ item: Integer) -> Integer) -> Integer {
							<- transform(1)
						}

						constant applied = apply((_ item: Integer) { <- item::add(1) })
					}`),
				).toEqual([])
			})

			it("types the body with a non-Generic free Function's Parameter", () => {
				// NOTE: `isGreaterThan` only resolves for an Integer, so a
				// Parameter Type that never reaches the body fails outright
				// here rather than subtly.
				expect(
					diagnosticsFor(`implementation {
						function describe(_ transform: (_ item: String) -> String) -> String {
							<- transform("a")
						}

						constant described = describe((item) { <- item::isGreaterThan(2) })
					}`).map((diagnostic) => diagnostic.message),
				).toContain("No Method named 'isGreaterThan' for this value")
			})

			it("threads the expected Types past a labelled Parameter", () => {
				// NOTE: Two Parameters, the literal in front of the plain one —
				// every Argument is asked for its Type against the Parameter it
				// was written for, not just the first.
				expect(
					typeOfFirstConstant(`implementation {
						function combine(
							with combiner: (_ left: Integer, _ right: Integer) -> String,
							and seed: Integer,
						) -> String {
							<- combiner(seed, seed)
						}

						constant joined = combine(
							with (left, right) { <- left::add(right)::toString() },
							and 3,
						)
					}`),
				).toEqual({ type: "String" })
			})

			// NOTE: The same, past an Argument that does not fit: matching a
			// GENERIC free Function stopped at the first mismatch, so the
			// literal behind it was left with no context and reported as
			// uninferable — burying the Argument mismatch the Validator was
			// about to report under a Diagnostic about a literal that is
			// written perfectly well.
			it("keeps its context behind a mismatching Argument", () => {
				expect(
					diagnosticsFor(`implementation {
						function apply<infer Item>(
							_ value: Item,
							_ label: String,
							_ transform: (_ item: Integer) -> Integer,
						) -> Integer {
							<- transform(1)
						}

						constant applied = apply(1, 2, (item) { <- item::add(1) })
					}`),
				).toEqual([])
			})

			// NOTE: A callback's return position is the call's to decide, and a
			// call decides it AFTER it has matched: nothing but this literal's
			// own body binds `Result`, so while the literal is being matched its
			// position still reads `Progress<State, Result>` and the body is all
			// there is to read a return Type off. A body decides only what its
			// payloads happen to mention — `#Stopped("done")` names `Result` and
			// leaves `State` standing as the Choice's own Parameter — so the
			// position is read a second time once the call has committed and its
			// bindings are final, and THAT is what the body is enriched against.
			it("decides a Case in the callback's return by the committed Overload", () => {
				let stepped = collectCaseTypes(
					lastConstantMethodInvocation(`implementation {
						choice Progress<State, Result> {
							Going { state: State },
							Stopped { value: Result },
						}

						namespace Runner for Integer {
							overload walk {
								(
									startingWith state: String,
									step advance: (_ current: String) -> Progress<String, String>,
								) -> String {
									<- state
								}
								<infer State, infer Result>(
									startingWith state: State,
									step advance: (_ current: State) -> Progress<State, Result>,
								) -> Optional<Result> {
									<- #Empty
								}
							}
						}

						constant walked = 1::walk(startingWith 0, step (count) {
							if count::isGreaterThan(2) { <- #Stopped("done") }

							<- #Going(count::add(1))
						})
					}`),
				)

				// NOTE: `Integer` from the committed Overload's bindings and
				// `String` from the payload — neither the `State` the match was
				// still carrying, nor the `Progress<String, String>` the Overload
				// that lost would have decided.
				expect(stepped).toEqual([
					{
						type: "Case",
						choice: "Progress",
						name: "Stopped",
						members: { value: { type: "String" } },
						typeArguments: [
							{ type: "Integer" },
							{ type: "String" },
						],
					},
					{
						type: "Case",
						choice: "Progress",
						name: "Going",
						members: { state: { type: "Integer" } },
						typeArguments: [
							{ type: "Integer" },
							{ type: "String" },
						],
					},
				])
			})

			// NOTE: The same shape as the standard library spells it, which is
			// where every Program meets it: `loop`'s general entry declares its
			// `step` as `(_: State) -> Step<State, Result>`, and a `#Done` in
			// that callback is the construction the whole rail is about.
			it("decides a Case in a stdlib callback the same way", () => {
				expect(
					collectCaseTypes(
						lastConstantFunctionInvocation(`implementation {
							constant word = loop(startingWith 0, step (count) {
								if count::isGreaterThanOrEqualTo(3) { <- #Done("done") }

								<- #Continue(count::add(1))
							})
						}`),
					).map((type) =>
						type.type === "Case" ? type.typeArguments : type,
					),
				).toEqual([
					[{ type: "Integer" }, { type: "String" }],
					[{ type: "Integer" }, { type: "String" }],
				])
			})

			// NOTE: A callback inside a callback is decided by ITS own call —
			// `<-` returns from the literal it is written in, never from the walk
			// around it, so the inner `loop`'s `#Done` carries the inner Result
			// and the outer one's carries the outer's.
			it("decides a nested callback by its own call", () => {
				expect(
					collectCaseTypes(
						lastConstantFunctionInvocation(`implementation {
							constant word = loop(startingWith 0, step (outer) {
								constant inner = loop(startingWith outer, step (current) {
									if current::isGreaterThan(5) { <- #Done(current) }

									<- #Continue(current::add(1))
								})

								if inner::isGreaterThan(2) { <- #Done("stop") }

								<- #Continue(inner)
							})
						}`),
					).map((type) =>
						type.type === "Case" ? type.typeArguments : type,
					),
				).toEqual([
					[{ type: "Integer" }, { type: "Integer" }],
					[{ type: "Integer" }, { type: "Integer" }],
					[{ type: "Integer" }, { type: "String" }],
					[{ type: "Integer" }, { type: "String" }],
				])
			})

			// NOTE: The Type Parameter of the Namespace a callback is written
			// INSIDE is a decision — a generic one — and the position it makes
			// is a real one. This is `List.firstItem(where:)` spelled out: the
			// fold's `Result` is bound by the annotated seed, so `reduce` hands
			// the callback a `Step<Optional<Item>, Optional<Item>>`, and the
			// `#Done(…)` in it is decided by that rather than by the one
			// Parameter its own payload happens to mention.
			//
			// NOTE: The `#Value(item)` inside that `#Done` is the same question
			// one level down, and it is there because `Optional` is a Choice: a
			// Method answering an `Optional<Item>` hands back a Case it built,
			// never a bare `item` that widened into a Union. Both it and the
			// `#Empty` seed print terse — `Optional#Value` — because their one
			// Type Argument is still the unbound `Item`, which is exactly what
			// `caseHeader` leaves out.
			it("decides a Case in a callback by the enclosing Namespace's Type Parameter", () => {
				let { program, diagnostics } = enrichSource(`implementation {
					namespace Finder<infer Item> for List<Item> {
						firstMatch(where check: (_ item: Item) -> Boolean) -> Optional<Item> {
							constant start: Optional<Item> = #Empty

							<- @::reduce(startingWith start, step (found, item) {
								if check(item) { <- #Done(#Value(item)) }

								<- #Continue(found)
							})
						}
					}

					constant found = [1, 2, 3]::firstMatch(where (item) { <- item::isGreaterThan(1) })
				}`)

				expect(diagnostics).toEqual([])
				expect(collectCaseTypes(program).map(printType)).toEqual([
					"Optional#Empty",
					"Step<Optional<Item>, Optional<Item>>#Done",
					"Optional#Value",
					"Step<Optional<Item>, Optional<Item>>#Continue",
				])
			})

			// NOTE: What a Diagnostic from inside a callback body names is the
			// committed Overload's reading of it. The Overload that lost takes a
			// `Boolean` there and would have reported that Booleans have no
			// `add` at all; the one that won hands the call the Integer
			// signatures `add` actually offers.
			it("reports from inside a callback in the committed Overload's Types", () => {
				let diagnostics = diagnosticsFor(`implementation {
					namespace Runner for Integer {
						overload run {
							(seed first: Boolean, step advance: (_ current: Boolean) -> Boolean) -> Boolean {
								<- first
							}
							(seed first: Integer, step advance: (_ current: Integer) -> Integer) -> Integer {
								<- first
							}
						}
					}

					constant ran = 1::run(seed 1, step (current) { <- current::add("x") })
				}`)

				expect(
					diagnostics.map((diagnostic) => diagnostic.message),
				).toEqual(["No overload of 'add' accepts these Arguments"])
				expect(diagnostics[0].notes[0]).toBe(
					"'Integer::add' takes 1 Argument: Parameter 1 is Integer.",
				)
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

		// NOTE: An Error Type matches everything — that is what keeps a
		// reported mistake from being reported again at every Type it flows
		// through — but matching a Type Parameter binds nothing, so the
		// Invocation would go on to announce that it could not infer it. The
		// Diagnostic points at the enclosing call rather than at the Argument
		// that actually failed, which is the cascade poison Types exist to
		// prevent.
		it("should not report uninferable Type Parameters for an Error Argument", () => {
			// NOTE: Two generic Namespaces with the same target, so the
			// specificity order can not break the tie and the Argument really
			// is an Error — a concrete Namespace beside the stdlib's generic
			// one would simply win and leave nothing to cascade from.
			expect(
				diagnosticsFor(`implementation {
					namespace AnyList<infer ItemType> for List<ItemType> {
						firstItem() -> Integer {
							<- 0
						}
					}

					__print([1, 2, 3]::firstItem())
				}`).map((diagnostic) => diagnostic.code),
			).toEqual(["ambiguous-namespace"])
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
				type Tagged<Value> = Value | String

				constant a: Tagged<Rational> = 1/2
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
						name: "Tagged",
						typeArguments: [{ type: "Rational" }],
					},
					types: [{ type: "Rational" }, { type: "String" }],
				})
			}
		})

		it("should apply Generic Type Alias defaults", () => {
			expect(
				diagnosticsFor(`implementation {
					type Fallback<Value = String> = Value | Boolean

					constant a: Fallback = "value"
				}`),
			).toEqual([])
		})

		it("should report Generic Type Aliases applied with too many Type Arguments", () => {
			let diagnostics = diagnosticsFor(`implementation {
				type Tagged<Value> = Value | String

				constant a: Tagged<Rational, Integer> = 1/2
			}`)

			expect(diagnostics).toHaveLength(1)
			expect(diagnostics[0].message).toBe(
				"Type 'Tagged' was given the wrong number of Type Arguments",
			)
			expect(diagnostics[0].position?.start.line).toBe(4)
		})

		it("should report Generic Type Aliases used without Type Arguments", () => {
			let diagnostics = diagnosticsFor(`implementation {
				type Tagged<Value> = Value | String

				constant a: Tagged = 1/2
			}`)

			expect(diagnostics).toHaveLength(1)
			expect(diagnostics[0].message).toBe(
				"Type 'Tagged' was given the wrong number of Type Arguments",
			)
		})

		// NOTE: The receiver is a Function's declared `Tagged<Integer>` rather
		// than a `firstItem()` — the stdlib no longer produces a bare Union of
		// this shape at all. `Optional` is a Choice now, so `[1, 2]::firstItem()`
		// is a Union of `Optional#Value` and `Optional#Empty`, and matching THAT
		// against `Tagged<Value>` binds `Value := Optional#Value` and asks
		// `unwrapped` to take one. What this is about is a Namespace whose
		// target is an APPLIED Alias, which a hand-written `Tagged` still is —
		// the second member is a plain String, because the Alias is here to be
		// applied, not to mean "missing".
		it("should match Generic Namespaces through applied Alias targets", () => {
			expect(
				typeOfFirstConstant(`implementation {
					type Tagged<Value> = Value | String

					namespace Tagged<infer Value> for Tagged<Value> {
						unwrapped(_ fallbackValue: Value) -> Value {
							<- match @ -> Value {
								case String { <- fallbackValue }
								case Value { <- @ }
							}
						}
					}

					function taggedOne() -> Tagged<Integer> {
						<- 1
					}

					constant first = taggedOne()::unwrapped(0)
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

				constant value: Showable | Boolean = true
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

				variable value: Integer | Boolean = 1

				constant result = match value -> Integer {
					case Showable { <- 0 }
					case Integer { <- @ }
					case Boolean { <- 0 }
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

		it("should report a concrete covering Union against the generic blanket", () => {
			// NOTE: The one shape the specificity order leaves ambiguous where
			// concreteness alone used to decide it: a Namespace for
			// `List<Integer> | String` covers the binding without spelling it
			// out, and `List<ItemType>` covers it without being concrete, so
			// neither target is narrower than the other. Naming the Union in
			// full is what makes it a real choice, and a hand written
			// `for List<Integer>` still wins outright.
			let diagnostics = diagnosticsFor(`implementation {
				namespace WideListEquatable for List<Integer> | String is Equatable {
					is(_ other: List<Integer> | String) -> Boolean { <- true }
					isNot(_ other: List<Integer> | String) -> Boolean { <- false }
				}

				function areEqual <infer Value is Equatable>(_ a: Value, _ b: Value) -> Boolean {
					<- a::is(b)
				}

				constant result: Boolean = areEqual([1, 2], [3, 4])
			}`)

			expect(diagnostics.map((diagnostic) => diagnostic.code)).toContain(
				"ambiguous-conformance",
			)
		})

		it("should report a Method that needs a condition", () => {
			let diagnostics = diagnosticsFor(`implementation {
				protocol Orderable {
					compare(to other: Self) -> Ordering
				}

				namespace ListOrderable<infer Item> for List<Item> is Orderable {
					compare <infer Item is Comparable>(to other: List<Item>) -> Ordering {
						<- Ordering#Equal
					}
				}
			}`)

			expect(diagnostics).toHaveLength(1)
			expect(diagnostics[0].code).toBe("nonconforming-namespace")
			expect(diagnostics[0].labels[0]?.message).toBe(
				"Method 'compare' needs 'Item is Comparable'",
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
						compare(to other: { value: Item }) -> Ordering {
							<- @.value::compare(to other.value)
						}
					}
				}`),
			).toEqual([])
		})

		it("should help toward a where clause on a needs-condition Method", () => {
			let diagnostics = diagnosticsFor(`implementation {
				protocol Orderable {
					compare(to other: Self) -> Ordering
				}

				namespace ListOrderable<infer Item> for List<Item> is Orderable {
					compare <infer Item is Comparable>(to other: List<Item>) -> Ordering {
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
					compare(to other: { value: Item }) -> Ordering {
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
					compare(to other: { value: Item }) -> Ordering {
						<- @.value::compare(to other.value)
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
					compare(to other: { value: Item }) -> Ordering {
						<- @.value::compare(to other.value)
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
				constant ordered: List<Integer> = [3, 1, 2]::sort()
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
				constant ordered = [[1, 2], [3]]::sort()
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
				constant ordered = [[true], [false]]::sort()
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

		it("should demand a witness for a direct compare call", () => {
			let { program, diagnostics } = enrichSource(`implementation {
				constant order = [1, 2]::compare(to [1, 3])
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
				constant sorted = [true, false]::sort()
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
				["the return Type alone", "produce() -> Item | String"],
				["a List item Type", "collect(_ items: List<Item>) -> Boolean"],
				[
					"a Record member",
					"unwrap(_ box: { value: Item }) -> Boolean",
				],
				["a Union member", "store(_ tagged: Item | String) -> Boolean"],
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
					"hold(_ tagged: Tagged<Item>) -> Boolean",
				],
			]

			for (let [name, signature] of cases) {
				it(`should keep a Namespace Generic used in ${name}`, () => {
					let returnsUnion = signature.includes("-> Item | String")

					let method = methodTypeFor(
						`implementation {
							type Tagged<Value> = Value | String

							namespace Tags<infer Item> for Integer {
								${signature} {
									<- ${returnsUnion ? '"tag"' : "true"}
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
			// Generic weaving: `compare` uses `Item`, so it survives pruning
			// and keeps its retrofitted bound — which is what makes the hidden
			// conformance Parameter emitted for it.
			let source = `implementation {
				namespace Boxes<infer Item> for { value: Item }
					is Comparable where Item is Comparable
				{
					compare(to other: { value: Item }) -> Ordering {
						<- @.value::compare(to other.value)
					}

					static describe() -> String {
						<- "box"
					}
				}
			}`

			expect(
				genericsOf(methodTypeFor(source, "Boxes", "compare")),
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

			let compare = namespaceNode.methods.compare

			expect(compare?.nodeType).toBe("SimpleMethod")
			expect(
				(compare as common.typed.SimpleMethod).method.value.generics,
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
							<- a::compare(to b)::toString()
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
							<- a::compare(to b)::toString()
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

					namespace WideVectorShowable for Vector | Boolean is Showable {
						toString() -> String {
							<- "a vector, or else a Boolean"
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

		// NOTE: Without `infer` the Parameter is opaque and binds to nothing, so
		// the target Type matches no receiver and the Namespace is never found —
		// which no Diagnostic used to say. A generic Choice made the silence
		// dangerous: nothing declared `is`, so the DERIVED equality answered it,
		// and a Namespace that wrote the Method by hand was contradicted without
		// a word. Refused at the declaration, which is upstream of all of that.
		it("should reject Namespace Type Parameters written without 'infer'", () => {
			let diagnostics = diagnosticsFor(`implementation {
				namespace Wrapper<Item> for List<Item> {
					firstText() -> String {
						<- ""
					}
				}
			}`)

			expect(diagnostics).toHaveLength(1)
			expect(diagnostics[0].code).toBe("uninferred-namespace-parameter")
			expect(diagnostics[0].message).toBe(
				"A Namespace's Type Parameters must be inferred",
			)
			expect(diagnostics[0].helps).toEqual([
				"Declare it as 'infer Item'.",
			])
		})

		// NOTE: Bounds decide which Overload a call selects, so the SAME
		// Overload set resolves the same way whichever order its entries were
		// written in — an Overload whose bound the Argument can not satisfy is
		// no candidate while another one takes the Argument. Each pair below is
		// the same call against the same two entries, swapped, and the entry
		// that accepts a Boolean is the one selected either way.
		describe("Overload selection", () => {
			const boundedFirst = `
				<infer Value is Showable>(_ value: Value) -> String {
					<- value::toString()
				}
				(_ value: Boolean) -> String {
					<- "boolean"
				}
			`

			const boundedSecond = `
				(_ value: Boolean) -> String {
					<- "boolean"
				}
				<infer Value is Showable>(_ value: Value) -> String {
					<- value::toString()
				}
			`

			function methodCall(overloads: string): string {
				return `implementation {
					${printableSetup}

					type Box = { size: Integer }

					namespace BoxNamespace for Box {
						overload render {
							${overloads}
						}
					}

					constant box: Box = { size = 1 }
					constant text: String = box::render(true)
				}`
			}

			// NOTE: `for {}` throughout this block — a Namespace that declares
			// nothing but STATIC Methods is never reached through a receiver,
			// so its target is beside the point and the unit Record is the
			// shortest Type to write that no other Namespace in these sources
			// also targets.
			function staticCall(overloads: string): string {
				return `implementation {
					${printableSetup}

					namespace Renderer for {} {
						overload static render {
							${overloads}
						}
					}

					constant text: String = Renderer.render(true)
				}`
			}

			it("should pass over a bounded Method Overload the Argument can not satisfy", () => {
				expect(
					lastConstantMethodInvocation(methodCall(boundedFirst))
						.overloadedMethodIndex,
				).toBe(1)
			})

			it("should select that same Method Overload with the entries swapped", () => {
				expect(
					lastConstantMethodInvocation(methodCall(boundedSecond))
						.overloadedMethodIndex,
				).toBe(0)
			})

			it("should pass over a bounded static Overload the Argument can not satisfy", () => {
				expect(
					lastConstantFunctionInvocation(staticCall(boundedFirst))
						.overloadedMethodIndex,
				).toBe(1)
			})

			it("should select that same static Overload with the entries swapped", () => {
				expect(
					lastConstantFunctionInvocation(staticCall(boundedSecond))
						.overloadedMethodIndex,
				).toBe(0)
			})

			// NOTE: Selecting an Overload solves its bounds, and that solve is
			// what the call carries — the Overload that wins is not solved a
			// second time on the way out.
			it("should carry the conformances the selected Overload was probed with", () => {
				let invocation =
					lastConstantFunctionInvocation(`implementation {
					${printableSetup}

					namespace Renderer for {} {
						overload static render {
							(_ value: Boolean) -> String {
								<- "boolean"
							}
							<infer Value is Showable>(_ value: Value) -> String {
								<- value::toString()
							}
						}
					}

					constant vector: Vector = { x = 1, y = 2 }
					constant text: String = Renderer.render(vector)
				}`)

				expect(invocation.overloadedMethodIndex).toBe(1)
				expect(invocation.conformances).toHaveLength(1)
				expect(invocation.conformances[0].genericName).toBe("Value")
				expect(invocation.conformances[0].protocolName).toBe("Showable")
				expect(
					invocation.conformances[0].source.kind === "namespace" &&
						invocation.conformances[0].source.name,
				).toBe("VectorShowable")
			})

			// NOTE: No candidate's bounds hold, so the call keeps the first
			// matching candidate's own Diagnostic — which bound failed and how
			// to satisfy it — rather than a bare "no overload accepts these
			// Arguments" about Arguments that were accepted.
			it("should report the first matching Overload's bound when no Overload's bounds hold", () => {
				let diagnostics = diagnosticsFor(`implementation {
					protocol Showable {
						toString() -> String
					}

					protocol Matchable {
						is(_ other: Self) -> Boolean
					}

					namespace Renderer for {} {
						overload static render {
							<infer Value is Showable>(_ value: Value) -> String {
								<- value::toString()
							}
							<infer Item is Matchable>(_ value: Item) -> String {
								<- "matchable"
							}
						}
					}

					constant text = Renderer.render(true)
				}`)

				expect(diagnostics).toHaveLength(1)
				expect(diagnostics[0].code).toBe("unsatisfied-bound")
				expect(diagnostics[0].message).toBe(
					"Boolean does not conform to 'Showable'",
				)
				// NOTE: The kept Diagnostic whole, Note and Help included —
				// telling the reader how to satisfy the bound is the entire
				// reason it is kept over "no Overload accepts these Arguments",
				// so a report stripped down to its code would pass a test that
				// only asked for the code.
				expect(diagnostics[0].notes).toEqual([
					"No Namespace in scope makes Boolean conform to 'Showable'.",
				])
				expect(diagnostics[0].helps).toEqual([
					"Declare a Namespace 'for Boolean is Showable'.",
				])
			})

			// NOTE: A candidate whose bound could not be DECIDED must not drop
			// out silently — the ambiguity is the reason the call fails, and
			// probing is what would otherwise swallow the report.
			it("should report an ambiguous conformance that failed the only matching Overload", () => {
				let diagnostics = diagnosticsFor(`implementation {
					${printableSetup}

					namespace VectorShowableToo for Vector is Showable {
						toString() -> String {
							<- "vector, too"
						}
					}

					namespace Renderer for {} {
						overload static render {
							<infer Value is Showable>(_ value: Value) -> String {
								<- value::toString()
							}
							(_ value: Boolean) -> String {
								<- "boolean"
							}
						}
					}

					constant vector: Vector = { x = 1, y = 2 }
					constant text = Renderer.render(vector)
				}`)

				expect(diagnostics).toHaveLength(1)
				expect(diagnostics[0].code).toBe("ambiguous-conformance")
				expect(diagnostics[0].message).toBe(
					"More than one Namespace makes { x: Number, y: Number } conform to 'Showable'",
				)
				expect(diagnostics[0].notes).toEqual([
					"'VectorShowable' conforms to 'Showable'.",
					"'VectorShowableToo' conforms to 'Showable'.",
				])
			})

			it("should still report no matching Overload when the Arguments match none", () => {
				let diagnostics = diagnosticsFor(`implementation {
					${printableSetup}

					namespace Renderer for {} {
						overload static render {
							<infer Value is Showable>(_ value: Value) -> String {
								<- value::toString()
							}
							(_ value: Boolean, _ other: Boolean) -> String {
								<- "boolean"
							}
						}
					}

					constant text = Renderer.render()
				}`)

				expect(diagnostics).toHaveLength(1)
				expect(diagnostics[0].code).toBe("no-matching-overload")
				expect(diagnostics[0].message).toBe(
					"No overload accepts these Arguments",
				)
				// NOTE: Every candidate, in the order they are written — a call
				// that matched none is told what it could have passed, which is
				// what the `::` twin has always said and what this site
				// promised without saying it.
				expect(diagnostics[0].notes).toEqual([
					"'Renderer.render' takes 1 Argument: Parameter 1 is Value.",
					"'Renderer.render' takes 2 Arguments: Parameter 1 is Boolean, Parameter 2 is Boolean.",
				])
				expect(diagnostics[0].helps).toEqual([])
			})

			// NOTE: One entry is the shape a reader is likeliest to meet — an
			// `overload` block being grown, or a call that simply passed the
			// wrong thing — and "no overload accepts these Arguments" about a
			// block with a single entry says nothing at all without the Note
			// spelling that entry out.
			it("should list the one signature a single entry Overload block declares", () => {
				let diagnostics = diagnosticsFor(`implementation {
					namespace Renderer for {} {
						overload static render {
							(_ value: Boolean) -> String {
								<- "boolean"
							}
						}
					}

					constant text = Renderer.render("nope")
				}`)

				expect(diagnostics).toHaveLength(1)
				expect(diagnostics[0].code).toBe("no-matching-overload")
				expect(diagnostics[0].notes).toEqual([
					"'Renderer.render' takes 1 Argument: Parameter 1 is Boolean.",
				])
			})

			// NOTE: A Namespace Generic is not something a caller wrote, so a
			// Note that spells one leaves them to work out what it stands for.
			// The signature is read off the Namespace SPECIALIZED against this
			// receiver instead — `List<Integer>` is told its `prepend` takes an
			// Integer.
			it("should spell a Namespace Generic as the receiver decided it", () => {
				let diagnostics = diagnosticsFor(`implementation {
					constant list = [1, 2]::prepend("nope")
				}`)

				expect(diagnostics).toHaveLength(1)
				expect(diagnostics[0].code).toBe("no-matching-overload")
				expect(diagnostics[0].notes).toEqual([
					"'List::prepend' takes 1 Argument: Parameter 1 is Integer.",
					"'List::prepend' takes 1 Argument: Parameter 'contentsOf' is List<Integer>.",
				])
			})

			// NOTE: The free-Function half of the same site, which only the
			// standard library can declare — and the half whose Notes carry the
			// most, since an `overload function`'s entries are told apart by
			// their Argument LABELS rather than by a receiver.
			it("should name a free Function's Overloads by the labels they read", () => {
				let diagnostics = diagnosticsFor(`implementation {
					constant state = loop(startingWith 1)
				}`)

				expect(diagnostics).toHaveLength(1)
				expect(diagnostics[0].code).toBe("no-matching-overload")
				expect(diagnostics[0].notes).toEqual([
					"'loop' takes 3 Arguments: Parameter 'startingWith' is State, Parameter 'while' is (_: State) -> Boolean, Parameter 'step' is (_: State) -> State.",
					"'loop' takes 3 Arguments: Parameter 'startingWith' is State, Parameter 'until' is (_: State) -> Boolean, Parameter 'step' is (_: State) -> State.",
					"'loop' takes 4 Arguments: Parameter 'from' is Integer, Parameter 'through' is Integer, Parameter 'startingWith' is State, Parameter 'step' is (_: Integer, _: State) -> State.",
					"'loop' takes 2 Arguments: Parameter 'startingWith' is State, Parameter 'step' is (_: State) -> Step<State, Result>.",
				])
			})

			// NOTE: Reaching past a candidate whose bound failed means typing the
			// Arguments against the candidates behind it, and an unannotated
			// Function literal reports from inside its own body when the Parameter
			// it is read against is not a signature at all. The literal below is
			// read against an `Integer` Parameter on the way to the Overload that
			// takes it — a candidate that loses says nothing.
			it("should keep the Arguments of a losing Overload from reporting", () => {
				expect(
					lastConstantMethodInvocation(`implementation {
					${printableSetup}

					namespace IntegerRunner for Integer {
						overload run {
							<infer Value is Showable>(_ value: Value, _ transform: (_ x: Integer) -> Integer) -> String {
								<- value::toString()
							}
							(_ value: Boolean, _ transform: Integer) -> String {
								<- "integer"
							}
							(_ value: Boolean, _ transform: (_ x: Integer) -> Integer) -> String {
								<- "function"
							}
						}
					}

					constant text: String = 1::run(true, (x) { <- x })
				}`).overloadedMethodIndex,
				).toBe(2)
			})

			// NOTE: The same, one stage out: a Namespace that loses the specificity
			// filter still probes its Overloads, and the Arguments it typed on the
			// way are not the call's news either.
			it("should keep the Arguments of a losing Namespace's Overloads from reporting", () => {
				expect(
					diagnosticsFor(`implementation {
					${printableSetup}

					namespace WideRunner for Integer | String {
						overload run {
							<infer Value is Showable>(_ value: Value, _ transform: (_ x: Integer) -> Integer) -> String {
								<- value::toString()
							}
							(_ value: Boolean, _ transform: Integer) -> String {
								<- "integer"
							}
						}
					}

					namespace NarrowRunner for Integer {
						run(_ value: Boolean, _ transform: (_ x: Integer) -> Integer) -> String {
							<- "narrow"
						}
					}

					constant text = 1::run(true, (x) { <- x })
				}`),
				).toEqual([])
			})

			// NOTE: The other flavour of the same order-dependence, and not a bound
			// failing: a prefixed Case construction read against `Holder<Item>` can
			// not decide its Type Arguments from a Parameter Type that mentions the
			// call's own unsolved Type Parameter, so it types as Error — which
			// matches anything and leaves `Item` unbound, so the bound never fails.
			// The generic candidate is passed over for the one that decides the
			// construction, whichever order the two are written in.
			function construction(overloads: string): string {
				return `implementation {
					choice Holder<Item is Equatable> {
						Bare,
						Full { value: Item },
					}

					namespace Takers for {} {
						overload static take {
							${overloads}
						}
					}

					constant text: String = Takers.take(Holder#Full(1))
				}`
			}

			const genericFirst = `
				<infer Item is Equatable>(_ holder: Holder<Item>) -> String {
					<- "generic"
				}
				(_ holder: Holder<Integer>) -> String {
					<- "integer"
				}
			`

			const genericSecond = `
				(_ holder: Holder<Integer>) -> String {
					<- "integer"
				}
				<infer Item is Equatable>(_ holder: Holder<Item>) -> String {
					<- "generic"
				}
			`

			it("should pass over an Overload no Argument can decide the Type Arguments of", () => {
				expect(
					lastConstantFunctionInvocation(construction(genericFirst))
						.overloadedMethodIndex,
				).toBe(1)
			})

			it("should select that same Overload with the entries swapped", () => {
				expect(
					lastConstantFunctionInvocation(construction(genericSecond))
						.overloadedMethodIndex,
				).toBe(0)
			})
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

						let result = computeConformanceMethodMap(
							protocol,
							namespace,
							namespace.targetType!,
							assumptions,
						)

						// NOTE: A Choice DECLARES `is Equatable` and writes
						// neither Method — the derive fulfills it. Checking the
						// derived Namespace instead of accepting the miss is
						// the point: the conformance still has to hold, it just
						// holds through Methods nobody wrote. The Scope only
						// has to resolve the Choice's name back to the Choice,
						// which is the target Type itself.
						if (result.kind !== "conforms") {
							const derived = derivedEquatableNamespace(
								namespace.targetType!,
								{
									parent: null,
									members: {},
									declarations: {},
									constants: new Set(),
									types: {
										[namespace.name]: namespace.targetType!,
									},
									protocols: {},
								},
							)

							expect(derived).not.toBeNull()

							result = computeConformanceMethodMap(
								protocol,
								derived!,
								namespace.targetType!,
								assumptions,
							)
						}

						expect(result.kind).toBe("conforms")
					}
				})
			}
		})

		it("should order Integers with compare and match the Ordering exhaustively", () => {
			expect(
				diagnosticsFor(`implementation {
					constant ordering = 5::compare(to 7)

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
					__print(describeValue({}))
					__print(describeValue({ x = 1 }))
					__print(describeValue(Ordering#Less))
				}`),
			).toEqual([])
		})

		it("should order values through a Comparable bound", () => {
			expect(
				diagnosticsFor(`implementation {
					function smaller <infer Item is Comparable>(_ a: Item, _ b: Item) -> Item {
						<- match a::compare(to b) -> Item {
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
			// NOTE: `sort__overload$2` needs no Protocol bound — the comparator does —
			// but the annotation only holds if `compare` resolves on a
			// String, which it does now that String conforms to Comparable.
			expect(
				diagnosticsFor(`implementation {
					constant ordered: List<String> = ["b", "a"]::sort(by 
						(first, second) { <- first::compare(to second) },
					)
				}`),
			).toEqual([])
		})

		it("should type the everyday String Methods", () => {
			expect(
				diagnosticsFor(`implementation {
					constant count: Integer = "hi"::length()
					constant chars: List<String> = "hi"::characters()
					constant char: Optional<String> = "hi"::character(at 0)
					constant loud: String = "hi"::uppercase()::trim()
					constant begins: Boolean = "hi"::starts(with "h")
					constant at: Optional<Integer> = "hello"::firstIndex(of "l")
					constant padded: String = "7"::pad(to 3, with "0")
				}`),
			).toEqual([])
		})

		// NOTE: The unit Record stands where `nothing` used to — a Function
		// that answers nothing useful answers `{}` now, so `{}` is the value an
		// `is` has to keep working on. It reaches Equatable through the builtin
		// Record Namespace like any other Record.
		it("should compare unit Records and Orderings with Equatable methods", () => {
			expect(
				diagnosticsFor(`implementation {
					constant unitSame: Boolean = {}::is({})
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
						<- match a::compare(to b) -> Item {
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
					constant text: String = 5::compare(to 7)::toString()
					constant same: Boolean = 5::compare(to 7)::is(Ordering#Less)
				}`),
			).toEqual([])
		})

		// NOTE: The ordering family lives only on the covering Number
		// Namespace, so a mixed-kind comparison resolves through it — the
		// member Namespaces declare no cross-kind `isLessThan` of their own.
		//
		// NOTE: `squareRoot` answers an `Optional<Integer | Algebraic>`, which
		// takes two matches to take apart rather than one: the outer one names
		// the Cases of the Optional and binds the payload, the inner one
		// narrows that payload's Union. The kinds are what this is about, and
		// they are still both reached.
		it("should compare across Number kinds through the Number Namespace", () => {
			expect(
				diagnosticsFor(`implementation {
					constant belowPi: Boolean = 3::isLessThan(Number.PI)
					constant orderedPis: Boolean = Number.PI::isGreaterThan(Number.TAU)
					constant rootVsHalf = match 2::squareRoot() -> Boolean {
						case #Value(root) {
							<- match root -> Boolean {
								case Algebraic { <- @::isLessThanOrEqualTo(3/2) }
								case Integer   { <- false }
							}
						}
						case #Empty { <- false }
					}
				}`),
			).toEqual([])
		})

		it("should span the numeric tower for Integer::add", () => {
			// NOTE: The Transcendental annotation only type-checks if
			// `1::add(π)` resolves to the new overload. The match unwraps the
			// `Optional` √2 comes back in and then narrows the payload to an
			// Algebraic, and adds an Integer to it — the other new overload —
			// with `toString` keeping the handler's return a String so the test
			// turns on resolution, not on the result Type.
			expect(
				diagnosticsFor(`implementation {
					constant withPi: Transcendental = 1::add(Number.PI)
					constant withRoot: String = match 2::squareRoot() -> String {
						case #Value(root) {
							<- match root -> String {
								case Algebraic { <- 1::add(@)::toString() }
								case Integer   { <- @::toString() }
							}
						}
						case #Empty { <- "none" }
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
		it("should dispatch a Number receiver to every member Namespace", () => {
			let invocation = lastConstantMethodInvocation(`implementation {
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
			let invocation = lastConstantMethodInvocation(`implementation {
				constant value: Integer | Boolean = 5
				constant text = value::toString()
			}`)

			expect(invocation.dispatch).not.toBeNull()
			expect(invocation.type).toEqual({ type: "String" })
		})

		// NOTE: `toString` rather than `is` — `Ordering` no longer WRITES an
		// `is`, it derives one, and a derived Method would make this pass for
		// the wrong reason. `toString` is a Method the covering Namespace
		// actually declares, which is what this is about.
		it("should keep a Namespace covering the whole Union ahead of dispatch", () => {
			let invocation = lastConstantMethodInvocation(`implementation {
				constant ordering = 5::compare(to 7)
				constant text = ordering::toString()
			}`)

			expect(invocation.namespace.name).toBe("Ordering")
			expect(invocation.dispatch).toBeNull()
			expect(invocation.type).toEqual({ type: "String" })
		})

		// NOTE: The Union is written out rather than read off `10::divide(by 0)`,
		// which used to answer a `Rational | Nothing`. That call answers an
		// `Optional<Rational>` today, and `Optional` has a Namespace covering
		// the whole of it — so it resolves the way `Ordering` does above, with
		// no dispatch at all, which is the case this one is NOT about. Two
		// Namespaces that know nothing of each other, each declaring `toString`
		// for one member, is what a dispatch has to be built out of, and
		// `Rational | String` is the shortest pair of those left to write.
		it("should dispatch across unrelated member Namespaces", () => {
			let invocation = lastConstantMethodInvocation(`implementation {
				constant quotient: Rational | String = 1/2
				constant text = quotient::toString()
			}`)

			expect(invocation.namespace.name).toBe("")
			expect(
				invocation.dispatch?.map(
					(dispatchCase) => dispatchCase.namespaceName,
				),
			).toEqual(["Rational", "String"])
			expect(invocation.type).toEqual({ type: "String" })
		})

		it("should union distinct branch return Types through user Namespaces", () => {
			let invocation = lastConstantMethodInvocation(`implementation {
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

		// NOTE: The Union is written out rather than read off a `firstItem()`,
		// which used to answer an `Item | Nothing`. That call answers an
		// `Optional<Item>` today — one Type with a Namespace covering it, which
		// resolves without a dispatch at all and so says nothing about the
		// member-by-member lookup this is about. The test below covers that
		// half. What matters here is the `Item` member: it is a Type Parameter,
		// so the only thing that can answer `toString` for it is the bound.
		it("should dispatch a bounded Type Parameter member through its conformance", () => {
			expect(
				diagnosticsFor(`implementation {
					function textOrLabel <infer Item is Printable>(_ value: Item | String) -> String {
						<- value::toString()
					}

					constant text: String = textOrLabel(1)
				}`),
			).toEqual([])
		})

		// NOTE: The other half — an `Optional` conforms to `Printable` only
		// when its payload does, and the payload here is a Type Parameter
		// nothing has decided. The bound is the whole of what makes the call
		// legal: the same body with `is Printable` dropped reports that 'Item'
		// does not conform to it, which is the conformance the Optional's own
		// is conditional on.
		it("should satisfy a conditional conformance from a Type Parameter's bound", () => {
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
			let invocation = lastConstantMethodInvocation(`implementation {
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

		// NOTE: Record matching is OPEN at runtime — a `{ width, height }`
		// value matches the branch for `{ width }` — so the branch for the
		// more specific Record has to be tried first or it can never be
		// reached. Such a Union arrives here because applying a Generic Alias
		// rebuilds it without the subsumption pass that would have collapsed
		// the two members.
		function dispatchOrderOf(alias: string): Array<string> | undefined {
			let invocation = lastConstantMethodInvocation(`implementation {
				type Mixed<Extra> = ${alias}

				namespace Square for { width: Integer } {
					describe() -> String {
						<- "square"
					}
				}

				namespace Flag for Boolean {
					describe() -> String {
						<- "flag"
					}
				}

				namespace Rect for { width: Integer, height: Integer } {
					describe() -> String {
						<- "rect"
					}
				}

				constant shape: Mixed<{ width: Integer, height: Integer }> = { width = 1, height = 2 }
				constant described = shape::describe()
			}`)

			return invocation.dispatch?.map(
				(dispatchCase) => dispatchCase.namespaceName,
			)
		}

		it("should order a more specific Record member ahead of an open one", () => {
			expect(
				dispatchOrderOf("{ width: Integer } | Boolean | Extra"),
			).toEqual(["Rect", "Square", "Flag"])
		})

		// NOTE: The same Union, written with its incomparable member moved.
		// Sorting with a partial order only compared the pairs the sort
		// happened to reach, so `Boolean` standing between the two Records was
		// enough to leave them in declaration order — and the Program printed
		// something else.
		it("should order the same members the same way however they are spelled", () => {
			expect(
				dispatchOrderOf("{ width: Integer } | Extra | Boolean"),
			).toEqual(dispatchOrderOf("{ width: Integer } | Boolean | Extra"))
		})
	})

	describe("Method Target Specificity", () => {
		it("should prefer the Namespace with the strictly more specific target Type", () => {
			let invocation = lastConstantMethodInvocation(`implementation {
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
			let invocation = lastConstantMethodInvocation(`implementation {
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
			let invocation = lastConstantMethodInvocation(`implementation {
				constant same = 5::is(3)
			}`)

			expect(invocation.namespace.name).toBe("Integer")
		})

		it("should resolve mixed-member comparisons through the Number Namespace", () => {
			let invocation = lastConstantMethodInvocation(`implementation {
				constant same = 1::is(1/1)
			}`)

			expect(invocation.namespace.name).toBe("Number")
			expect(invocation.type).toEqual({ type: "Boolean" })
		})

		it("should order mixed members through the Number Namespace", () => {
			expect(
				diagnosticsFor(`implementation {
					constant ordered = match 5::compare(to 1/2) -> String {
						case #Less    { <- "smaller" }
						case #Equal   { <- "same" }
						case #Greater { <- "bigger" }
					}
				}`),
			).toEqual([])
		})

		it("should prefer a concrete target over a generic one", () => {
			// NOTE: `firstItem` is the stdlib's, declared for every
			// `List<ItemType>` — a Namespace naming the item Type outright is
			// the more specific of the two and answers the call.
			let invocation = lastConstantMethodInvocation(`implementation {
				namespace IntegerList for List<Integer> {
					firstItem() -> Integer {
						<- 0
					}
				}

				constant first = [1, 2, 3]::firstItem()
			}`)

			expect(invocation.namespace.name).toBe("IntegerList")
			expect(invocation.type).toEqual({ type: "Integer" })
		})

		it("should prefer a nested generic target over a flat one", () => {
			// NOTE: Both targets are generic, so neither is concrete — the
			// deeper structure is what decides: `List<List<ItemType>>` covers
			// only nested Lists, while `List<ItemType>` covers those too. Both
			// spell their Generic `ItemType`, which is the case the alpha-rename
			// in the comparison exists for: without it the two capture each
			// other and read as covering one another.
			let invocation = lastConstantMethodInvocation(`implementation {
				namespace FlatTag<infer ItemType> for List<ItemType> {
					tag() -> String {
						<- "flat"
					}
				}

				namespace NestedTag<infer ItemType> for List<List<ItemType>> {
					tag() -> Integer {
						<- 1
					}
				}

				constant tagged = [[1], [2]]::tag()
			}`)

			expect(invocation.namespace.name).toBe("NestedTag")
			expect(invocation.type).toEqual({ type: "Integer" })
		})

		it("should keep two identically targeted generic Namespaces ambiguous", () => {
			expect(
				diagnosticsFor(`implementation {
					namespace FirstTag<infer ItemType> for List<ItemType> {
						tag() -> String {
							<- "first"
						}
					}

					namespace SecondTag<infer Item> for List<Item> {
						tag() -> String {
							<- "second"
						}
					}

					constant tagged = [1, 2]::tag()
				}`).map((diagnostic) => diagnostic.code),
			).toEqual(["ambiguous-namespace"])
		})

		// NOTE: An empty List Literal is a `List<Unknown>`, and an Unknown fits
		// anything and is fit by anything — so every List target covers it, in
		// both directions, and the order above would answer the call with the
		// nested Namespace on the strength of a Type nothing has decided. The
		// refusal comes BEFORE the order is asked, which is also what stops the
		// winner's own `ItemType` from being reported uninferable: a Type
		// Parameter of a Namespace the program never picked.
		describe("An undecided receiver", () => {
			let overlappingNamespaces = `namespace FlatTag<infer ItemType> for List<ItemType> {
					tag() -> String {
						<- "flat"
					}
				}

				namespace NestedTag<infer ItemType> for List<List<ItemType>> {
					tag() -> Integer {
						<- 1
					}
				}`

			it("should refuse a call more than one Namespace matches", () => {
				expect(
					diagnosticsFor(`implementation {
				${overlappingNamespaces}

				constant tagged = []::tag()
			}`).map((diagnostic) => diagnostic.code),
				).toEqual(["undecided-receiver-type"])
			})

			it("should point at the receiver and name what matched it", () => {
				let source = `implementation {
				${overlappingNamespaces}

				constant tagged = []::tag()
			}`
				let diagnostic = diagnosticsFor(source)[0]

				expect(diagnostic.message).toBe(
					"'tag' is called on a value whose Type is not fully known here",
				)
				expect(underlinedText(source, diagnostic)).toBe("[]")
				expect(diagnostic.labels[0]?.message).toBe(
					"this is a List<Unknown>",
				)
				expect(diagnostic.labels[1]?.kind).toBe("secondary")
				expect(diagnostic.labels[1]?.message).toBe(
					"'tag' is looked up in its Namespaces",
				)
				expect(diagnostic.notes).toContain("'FlatTag' declares 'tag'.")
				expect(diagnostic.notes).toContain(
					"'NestedTag' declares 'tag'.",
				)
				expect(diagnostic.helps).toEqual([
					"Annotate what the receiver comes from — 'constant items: List<Integer> = []' — so its Type is decided before the call.",
				])
			})

			it("should resolve once the receiver is annotated", () => {
				let invocation = lastConstantMethodInvocation(`implementation {
				${overlappingNamespaces}

				constant empty: List<Integer> = []
				constant tagged = empty::tag()
			}`)

				expect(invocation.namespace.name).toBe("FlatTag")
				expect(invocation.type).toEqual({ type: "String" })
			})

			it("should leave a lone matching Namespace alone", () => {
				// NOTE: Nothing was decided by the Unknown where there was
				// nothing to decide between — the call has the one Namespace to
				// go to whatever the receiver turns out to hold.
				let invocation = lastConstantMethodInvocation(`implementation {
				namespace IntegerList for List<Integer> {
					tag() -> String {
						<- "integers"
					}
				}

				constant tagged = []::tag()
			}`)

				expect(invocation.namespace.name).toBe("IntegerList")
				expect(invocation.type).toEqual({ type: "String" })
			})

			it("should refuse an undecided member of a Union receiver", () => {
				// NOTE: Per-member dispatch reaches the same order, so it
				// refuses on the same terms — one member of the Union the
				// callback's two returns build is the `List<Unknown>` both
				// Namespaces match, and the refusal comes before the Integer
				// member is ever asked for the `tag` it does not have.
				//
				// The Union is built by a callback rather than read off
				// `[[]]::firstItem()`, which used to answer one. That call
				// answers an `Optional<List<Unknown>>` today, and the undecided
				// List is the PAYLOAD of an `Optional#Value` member rather than
				// a member itself, so no member of it is undecided at all.
				let diagnostics = diagnosticsFor(`implementation {
				${overlappingNamespaces}

				namespace Picker for Integer {
					pick<infer Result>(_ choose: (_ value: Integer) -> Result) -> Result {
						<- choose(@)
					}
				}

				constant tagged = 1::pick((value) {
					if value::isGreaterThan(0) { <- [] }

					<- value
				})::tag()
			}`)

				expect(
					diagnostics.map((diagnostic) => diagnostic.code),
				).toEqual(["undecided-receiver-type"])
				expect(diagnostics[0].notes).toContain(
					"List<Unknown> is a member of this Union.",
				)
			})
		})
	})

	// NOTE: A static Method is called on its Namespace and takes no receiver.
	// Both halves of that are load-bearing for what the Rewriter emits: the
	// call passes only the written Arguments, and the definition is emitted
	// without the `_self` Parameter `@` compiles to.
	describe("Documentation", () => {
		it("should report a '@param' naming no Parameter", () => {
			let diagnostics = diagnosticsFor(`implementation {
				§§ Greets.
				§§ @param subjekt — who to greet
				function greet(subject: String) -> String { <- subject }
			}`)

			expect(diagnostics).toHaveLength(1)
			expect(diagnostics[0].severity).toBe("warning")
			expect(diagnostics[0].code).toBe("unknown-documentation-parameter")
			expect(diagnostics[0].labels[0]?.message).toBe(
				"no Parameter is named 'subjekt'",
			)
			expect(diagnostics[0].helps).toEqual(["Did you mean 'subject'?"])
			// NOTE: The name alone is underlined, rather than the whole block
			// or the whole Comment.
			expect(diagnostics[0].position).toEqual({
				start: { line: 3, column: 15 },
				end: { line: 3, column: 22 },
			})
		})

		it("should take either name a Parameter is written with", () => {
			expect(
				diagnosticsFor(`implementation {
					§§ Greets.
					§§ @param subject — who to greet
					function greet(_ subject: String) -> String { <- subject }
				}`),
			).toEqual([])

			expect(
				diagnosticsFor(`implementation {
					§§ Greets.
					§§ @param to — who to greet
					function greet(to subject: String) -> String { <- subject }
				}`),
			).toEqual([])
		})

		it("should let an overload block name a Parameter of any Overload", () => {
			expect(
				diagnosticsFor(`implementation {
					namespace Ladder for Integer {
						§§ Climbs.
						§§ @param count — how far
						overload climb {
							(_ count: Integer) -> Integer { <- @ }
							() -> Integer { <- @ }
						}
					}
				}`),
			).toEqual([])
		})

		it("should report an overload block naming no Overload's Parameter", () => {
			let diagnostics = diagnosticsFor(`implementation {
				namespace Ladder for Integer {
					§§ Climbs.
					§§ @param hight — how far
					overload climb {
						(_ height: Integer) -> Integer { <- @ }
						() -> Integer { <- @ }
					}
				}
			}`)

			expect(diagnostics).toHaveLength(1)
			expect(diagnostics[0].code).toBe("unknown-documentation-parameter")
			expect(diagnostics[0].helps).toEqual(["Did you mean 'height'?"])
			expect(diagnostics[0].notes).toHaveLength(2)
		})

		it("should report a '@param' on a Declaration that holds no Function", () => {
			let diagnostics = diagnosticsFor(`implementation {
				§§ The default.
				§§ @param subject — who to greet
				constant fallback = "Hello"
			}`)

			expect(diagnostics).toHaveLength(1)
			expect(diagnostics[0].code).toBe("unknown-documentation-parameter")
			expect(diagnostics[0].labels[0]?.message).toBe(
				"what this documents takes no Parameters",
			)
			expect(diagnostics[0].helps).toEqual([
				"Remove the tag — there is no Parameter for it to describe.",
			])
		})

		it("should read a Declaration's '@param' against the Function it holds", () => {
			// NOTE: The block sits above the `constant`, and the Parameters it
			// can be describing are the held Function's.
			expect(
				diagnosticsFor(`implementation {
					§§ Greets.
					§§ @param subject — who to greet
					constant greet = (subject: String) -> String { <- subject }
				}`),
			).toEqual([])

			expect(
				diagnosticsFor(`implementation {
					§§ Greets.
					§§ @param subjekt — who to greet
					constant greet = (subject: String) -> String { <- subject }
				}`),
			).toHaveLength(1)
		})

		it("should not keep a Function it warns about out of Scope", () => {
			// NOTE: Hoisting kept a speculative resolution only when it
			// reported nothing at all, and every Diagnostic reachable from it
			// used to be an error. A Warning about the `§§` block above a
			// Function would leave that Function unhoisted, so every call
			// ABOVE it reported `unknown-name` — a typo in a Comment breaking
			// the Program underneath it.
			let diagnostics = diagnosticsFor(`implementation {
				constant greeting = greet(subject "World")

				§§ Greets.
				§§ @param subjekt — who to greet
				function greet(subject: String) -> String { <- subject }
			}`)

			expect(diagnostics).toHaveLength(1)
			expect(diagnostics[0].code).toBe("unknown-documentation-parameter")
		})

		it("should leave a Declaration whose Parameters it cannot see unchecked", () => {
			// NOTE: `alias` is function-valued, but its Parameters survive only
			// in a resolved Type, which keeps no internal names — so a `@param`
			// here cannot be told from a typo. Reporting it said "takes no
			// Parameters" about a Declaration whose Hover showed them.
			expect(
				diagnosticsFor(`implementation {
					function greet(_ subject: String) -> String { <- subject }

					§§ The greeting to use.
					§§ @param subject — who to greet
					constant alias = greet
				}`),
			).toEqual([])
		})

		it("should report nothing for the Documentation of a builtin", () => {
			// NOTE: A builtin Namespace documents itself in TypeScript and the
			// standard library's Positions are stripped as it loads, so there
			// is no `§§` line to point at and nothing to check.
			expect(
				diagnosticsFor(`implementation {
					constant length = "abc"::length()
				}`),
			).toEqual([])
		})
	})

	describe("Static Methods", () => {
		it("should reject a static Method called on a value", () => {
			let diagnostics = diagnosticsFor(`implementation {
				namespace Maker for Integer {
					static make(_ base: Integer) -> Integer {
						<- base
					}
				}

				constant made = 5::make(7)
			}`)

			expect(diagnostics).toHaveLength(1)
			expect(diagnostics[0].code).toBe("static-method-on-value")
			expect(diagnostics[0].message).toBe("'make' is a static Method")
		})

		// NOTE: `Integer.parse` — the Invocation type-checked against the
		// written Arguments alone while the Simplifier prepended the receiver
		// anyway, so every runtime Argument landed one place too far right and
		// the Program answered with the receiver instead of erroring.
		it("should reject a builtin static Method called on a value", () => {
			expect(
				diagnosticsFor(`implementation {
					constant weird = 999::parse("42")
				}`).map((diagnostic) => diagnostic.code),
			).toEqual(["static-method-on-value"])
		})

		it("should reject an overloaded static Method called on a value", () => {
			expect(
				diagnosticsFor(`implementation {
					namespace Maker for Integer {
						overload static make {
							(_ base: Integer) -> Integer {
								<- base
							}

							(_ base: String) -> Integer {
								<- 0
							}
						}
					}

					constant made = 5::make(7)
				}`).map((diagnostic) => diagnostic.code),
			).toEqual(["static-method-on-value"])
		})

		it("should reject a static Method called on a member of a Union", () => {
			expect(
				diagnosticsFor(`implementation {
					namespace IntegerTag for Integer {
						static tag() -> String {
							<- "integer"
						}
					}

					namespace StringTag for String {
						tag() -> String {
							<- "string"
						}
					}

					constant value: Integer | String = 5
					constant tagged = value::tag()
				}`).map((diagnostic) => diagnostic.code),
			).toEqual(["static-method-on-value"])
		})

		it("should still resolve the same Method called on its Namespace", () => {
			let { program, diagnostics } = enrichSource(`implementation {
				namespace Maker for Integer {
					static make(_ base: Integer) -> Integer {
						<- base
					}
				}

				constant made = Maker.make(7)
			}`)

			expect(diagnostics).toEqual([])

			let constants = program.implementation.nodes.filter(
				(node) => node.nodeType === "ConstantDeclarationStatement",
			)

			expect(constants[constants.length - 1].type).toEqual({
				type: "Integer",
			})
		})

		// NOTE: An instance Method of the same Namespace binds `@` right
		// beside it, which is exactly why this is an easy mistake — and why
		// the Scope has to refuse `@` rather than merely leave it undeclared.
		it("should reject '@' in a static Method body", () => {
			let diagnostics = diagnosticsFor(`implementation {
				namespace Maker for Integer {
					static make() -> Integer {
						<- @::add(1)
					}

					doubled() -> Integer {
						<- @::multiply(with 2)
					}
				}
			}`)

			expect(diagnostics).toHaveLength(1)
			expect(diagnostics[0].code).toBe("at-in-static-method")
			expect(diagnostics[0].message).toBe(
				"There is no '@' in a static Method",
			)
			expect(diagnostics[0].position?.start.line).toBe(4)
		})

		it("should reject '@' in an overloaded static Method body", () => {
			expect(
				diagnosticsFor(`implementation {
					namespace Maker for Integer {
						overload static make {
							() -> Integer {
								<- @
							}

							(_ base: Integer) -> Integer {
								<- base
							}
						}
					}
				}`).map((diagnostic) => diagnostic.code),
			).toEqual(["at-in-static-method"])
		})

		// NOTE: A Match Handler binds its own `@` — the value that matched —
		// and is emitted as a Function taking it, so it keeps working inside a
		// static Method. Only the receiver `@` is gone.
		it("should keep '@' bound in a Match Handler inside a static Method", () => {
			expect(
				diagnosticsFor(`implementation {
					namespace Maker for Integer {
						static describe(_ value: Integer | Boolean) -> String {
							<- match value -> String {
								case Integer { <- @::toString() }
								case Boolean { <- "boolean" }
							}
						}
					}
				}`),
			).toEqual([])
		})

		it("should keep '@' bound in the instance Methods beside it", () => {
			expect(
				diagnosticsFor(`implementation {
					namespace Maker for Integer {
						static make() -> Integer {
							<- 1
						}

						doubled() -> Integer {
							<- @::multiply(with 2)
						}
					}
				}`),
			).toEqual([])
		})
	})

	// NOTE: A Module's Choices are identified by its canonical path, and every
	// rail that reaches a Choice BY NAME has to keep working: the Type Scope is
	// keyed by the name the declaration wrote, so a lookup that went looking for
	// the identity would find nothing — and answering nothing is not a
	// Diagnostic anywhere, it is a Choice that silently stops deriving its
	// equality or resolving its Cases.
	describe("Module Identity", () => {
		function diagnosticsForModule(
			source: string,
		): Array<common.Diagnostic> {
			return enrich(parse(source), {
				modulePath: "/modules/Choices.es",
			}).diagnostics
		}

		it("should resolve a Choice's Cases named, bare and matched", () => {
			expect(
				diagnosticsForModule(`implementation {
					choice Colour {
						Red,
						Green { shade: Integer },
					}

					constant named: Colour = Colour#Red
					constant bare: Colour = #Green({ shade = 1 })

					__print(match named -> String {
						case #Red { <- "red" }
						case Colour#Green { <- @.shade::toString() }
					})
				}`),
			).toEqual([])
		})

		it("should derive a Choice's equality from a Module's own Choice", () => {
			expect(
				diagnosticsForModule(`implementation {
					choice Colour {
						Red,
						Green,
					}

					constant red: Colour = #Red
					constant same = red::is(#Green)

					__print(same::toString())
				}`),
			).toEqual([])
		})

		it("should derive a generic Choice's equality through its Generic Alias", () => {
			expect(
				diagnosticsForModule(`implementation {
					choice Box<Value> {
						Empty,
						Full { value: Value },
					}

					constant full: Box<Integer> = Box<Integer>#Full({ value = 1 })
					constant same = full::is(Box<Integer>#Empty)

					__print(same::toString())
				}`),
			).toEqual([])
		})

		it("should reach a Module's Choice through a Type Alias of it", () => {
			expect(
				diagnosticsForModule(`implementation {
					choice Colour {
						Red,
						Green,
					}

					type Shade = Colour

					constant red: Shade = Shade#Red

					__print(match red -> String {
						case #Red { <- "red" }
						case #Green { <- "green" }
					})
				}`),
			).toEqual([])
		})

		it("should dispatch a Namespace declared for a Module's Choice", () => {
			expect(
				diagnosticsForModule(`implementation {
					choice Colour {
						Red,
						Green,
					}

					namespace Named for Colour {
						name() -> String {
							<- match @ -> String {
								case #Red { <- "red" }
								case #Green { <- "green" }
							}
						}
					}

					constant red: Colour = #Red

					__print(red::name())
				}`),
			).toEqual([])
		})

		it("should identify a Choice by its Module while naming it as written", () => {
			let { program, diagnostics } = enrich(
				parse(`implementation {
					choice Colour {
						Red,
					}
				}`),
				{ modulePath: "/modules/Colour.es" },
			)

			expect(diagnostics).toEqual([])

			let declaration = program.implementation.nodes[0]

			if (declaration.nodeType !== "ChoiceDeclarationStatement") {
				throw new Error("The Program declares no Choice.")
			}

			expect(declaration.cases[0].type.choice).toBe(
				"/modules/Colour.es#Colour",
			)
			expect(printType(declaration.type)).toBe("Colour")
		})
	})

	// NOTE: What a `where` clause on a Type Alias declares — the Type it
	// resolves to, the canonical conjuncts it is compared by, and every shape it
	// is refused for. Assignability between two of them is pinned in
	// `typeMatching.spec.ts`; this is about the Declaration.
	describe("Checked refinements", () => {
		function refinementOf(source: string): common.RefinementType {
			let { program, diagnostics } = enrichSource(source)

			expect(diagnostics).toEqual([])

			let aliases = program.implementation.nodes.filter(
				(node) => node.nodeType === "TypeAliasStatement",
			)
			let type = aliases[aliases.length - 1].type

			expect(type.type).toBe("Refinement")

			if (type.type !== "Refinement") {
				throw new Error("The last Type Alias is not a refinement.")
			}

			return type
		}

		function aliasOf(source: string): common.typed.TypeAliasStatementNode {
			let { program } = enrichSource(source)
			let aliases = program.implementation.nodes.filter(
				(node) => node.nodeType === "TypeAliasStatement",
			)

			return aliases[aliases.length - 1]
		}

		// NOTE: A GENERIC refined Alias resolves to a Generic Alias wrapping the
		// refinement — the wrapper is what applies the Type Arguments, the
		// refinement is what carries the evidence — so its refinement is one
		// level in.
		function genericRefinementOf(source: string): common.RefinementType {
			let { program, diagnostics } = enrichSource(source)

			expect(diagnostics).toEqual([])

			let aliases = program.implementation.nodes.filter(
				(node) => node.nodeType === "TypeAliasStatement",
			)
			let type = aliases[aliases.length - 1].type

			expect(type.type).toBe("GenericAlias")

			if (
				type.type !== "GenericAlias" ||
				type.aliasedType.type !== "Refinement"
			) {
				throw new Error(
					"The last Type Alias is not a generic refinement.",
				)
			}

			return type.aliasedType
		}

		it("should resolve a predicate to a refinement of its base", () => {
			let refinement = refinementOf(
				"implementation { type NonZero = Integer where @::isNot(0) }",
			)

			expect(refinement.name).toBe("NonZero")
			expect(refinement.base).toEqual({ type: "Integer" })
			expect(refinement.conjuncts).toEqual([
				{
					namespaceName: "Integer",
					methodName: "isNot",
					overloadIndex: null,
					args: ["0"],
				},
			])
		})

		it("should refine a String and an applied List", () => {
			expect(
				refinementOf(
					"implementation { type NonEmptyString = String where @::hasAnyContent() }",
				).base,
			).toEqual({ type: "String" })

			expect(
				refinementOf(
					"implementation { type NonEmptyStrings = List<String> where @::hasItems() }",
				).base,
			).toEqual({ type: "List", itemType: { type: "String" } })
		})

		// NOTE: The conjunct set of a generic refinement is the point of the whole
		// design: `hasItems` asks nothing about the items, so the key holds no Type
		// Argument at all and `NonEmptyList<String>` differs from `NonEmptyList<Integer>`
		// by its BASE — which `matchTypes` already compares.
		it("should refine a generic applied List, keying the conjunct without the Argument", () => {
			let refinement = genericRefinementOf(
				"implementation { type NonEmptyList<Item> = List<Item> where @::hasItems() }",
			)

			expect(refinement.name).toBe("NonEmptyList")
			expect(refinement.base).toEqual({
				type: "List",
				itemType: { type: "GenericUse", name: "Item" },
			})
			expect(refinement.conjuncts).toEqual([
				{
					namespaceName: "List",
					methodName: "hasItems",
					overloadIndex: null,
					args: [],
				},
			])
		})

		// NOTE: A use site applies its Arguments through the wrapper, which
		// substitutes them into the base and stamps the applied spelling. The
		// conjuncts come along BY REFERENCE — the same array the Declaration
		// resolved, because a predicate that says nothing about the items has
		// nothing to substitute.
		it("should apply a generic refinement's Arguments into its base", () => {
			let { program, diagnostics } = enrichSource(`implementation {
				type NonEmptyList<Item> = List<Item> where @::hasItems()

				function lengthOf(_ items: NonEmptyList<String>) -> Integer {
					<- items::length()
				}
			}`)

			expect(diagnostics).toEqual([])

			let alias = program.implementation.nodes[0]
			let declared = program.implementation.nodes[1]

			if (
				alias.nodeType !== "TypeAliasStatement" ||
				alias.type.type !== "GenericAlias" ||
				alias.type.aliasedType.type !== "Refinement" ||
				declared.nodeType !== "FunctionStatement" ||
				declared.type.type !== "Function"
			) {
				throw new Error("The Program is not the shape under test.")
			}

			let applied = declared.type.parameterTypes[0].type

			expect(applied.type).toBe("Refinement")

			if (applied.type !== "Refinement") {
				throw new Error("The Parameter is not a refinement.")
			}

			expect(applied.base).toEqual({
				type: "List",
				itemType: { type: "String" },
			})
			expect(applied.typeArguments).toEqual([{ type: "String" }])
			expect(applied.conjuncts).toBe(alias.type.aliasedType.conjuncts)
			expect(printType(applied)).toBe("NonEmptyList<String>")
		})

		// NOTE: `isBetween` is declared once over the whole numeric tower, so an
		// Integer's is answered by `Number` — and the conjunct records the
		// Namespace that ANSWERED, because that is what makes two conjuncts the
		// same question.
		it("should key a conjunct by the Namespace that answered it", () => {
			expect(
				refinementOf(
					"implementation { type Digit = Integer where @::isBetween(0, and 9) }",
				).conjuncts,
			).toEqual([
				{
					namespaceName: "Number",
					methodName: "isBetween",
					overloadIndex: null,
					args: ["0", "9"],
				},
			])
		})

		it("should flatten a conjunction into a canonical conjunct set", () => {
			let straight = refinementOf(
				"implementation { type SmallOdd = Integer where @::isOdd()::and(@::isLessThan(10)) }",
			)
			let mirrored = refinementOf(
				"implementation { type SmallOdd = Integer where @::isLessThan(10)::and(@::isOdd()) }",
			)

			expect(straight.conjuncts).toHaveLength(2)
			expect(straight.conjuncts).toEqual(mirrored.conjuncts)
		})

		it("should carry the enriched predicate on the typed Node", () => {
			let alias = aliasOf(
				"implementation { type NonZero = Integer where @::isNot(0) }",
			)

			expect(alias.predicate?.nodeType).toBe("MethodInvocation")
			expect(alias.predicate?.type).toEqual({ type: "Boolean" })
		})

		// NOTE: A generic Alias too, which takes reading `@` off the base INSIDE
		// the wrapper: read off the wrapper it was a Type taking Arguments, and the
		// Language Server got an Error where the Compiler had a Boolean.
		it("should carry the enriched predicate of a generic Alias too", () => {
			let alias = aliasOf(
				"implementation { type NonEmptyList<Item> = List<Item> where @::hasItems() }",
			)

			expect(alias.predicate?.nodeType).toBe("MethodInvocation")
			expect(alias.predicate?.type).toEqual({ type: "Boolean" })
		})

		it("should leave an unrefined Alias without a predicate", () => {
			expect(
				aliasOf("implementation { type Small = Integer }").predicate,
			).toBeNull()
		})

		// NOTE: Poison recovery — a refused clause leaves the Alias meaning its
		// base, so everything naming it stays about itself. What is asserted here
		// is the underlined text of each refusal, which is the span an Editor
		// puts the squiggle under.
		describe("refusals", () => {
			function refusal(source: string): {
				code: string
				underlined: string
			} {
				let diagnostics = diagnosticsFor(source)

				expect(diagnostics).toHaveLength(1)

				return {
					code: diagnostics[0].code,
					underlined: underlinedText(source, diagnostics[0]),
				}
			}

			// NOTE: A generic Alias is refined like any other, and an
			// item-dependent predicate needs no rule of its own — `Item` is
			// opaque while the clause is read, so `@::contains(0)` is refused
			// for the Argument it passes. Which is what keeps the conjuncts
			// item-agnostic without anything checking that they are.
			it("should refuse an item-dependent predicate as the Argument mistake it is", () => {
				expect(
					refusal(
						"implementation { type Containing<Item> = List<Item> where @::contains(0) }",
					),
				).toEqual({
					code: "no-matching-overload",
					underlined: "@::contains(0)",
				})
			})

			it("should refuse a base outside Integer, String and an applied List", () => {
				expect(
					refusal(
						"implementation { type Yes = Boolean where @::is(true) }",
					),
				).toEqual({
					code: "invalid-refinement-predicate",
					underlined: "Boolean",
				})

				expect(
					refusal(
						"implementation { type Weird = Integer | String where @::isNot(0) }",
					),
				).toEqual({
					code: "invalid-refinement-predicate",
					underlined: "Integer | String",
				})

				expect(
					refusal(
						"implementation { type Several = List where @::hasItems() }",
					),
				).toEqual({
					code: "invalid-refinement-predicate",
					underlined: "List",
				})
			})

			it("should refuse a receiver that is not '@'", () => {
				expect(
					refusal(
						`implementation { type Named = Integer where "essence"::hasAnyContent() }`,
					),
				).toEqual({
					code: "invalid-refinement-predicate",
					underlined: `"essence"`,
				})
			})

			it("should refuse a chained receiver", () => {
				expect(
					refusal(
						"implementation { type Trimmed = String where @::trim()::hasAnyContent() }",
					),
				).toEqual({
					code: "invalid-refinement-predicate",
					underlined: "@::trim()",
				})
			})

			it("should refuse an Argument that is not a literal", () => {
				expect(
					refusal(
						"implementation { constant limit = 3\ntype Bounded = Integer where @::isLessThan(limit) }",
					),
				).toEqual({
					code: "invalid-refinement-predicate",
					underlined: "limit",
				})
			})

			it("should refuse a predicate that is not a Boolean", () => {
				expect(
					refusal(
						"implementation { type Sized = Integer where @::absolute() }",
					),
				).toEqual({
					code: "predicate-not-boolean",
					underlined: "@::absolute()",
				})

				expect(
					refusal("implementation { type Bare = Integer where @ }"),
				).toEqual({
					code: "predicate-not-boolean",
					underlined: "@",
				})
			})

			// NOTE: A poisoned base says nothing about the clause, so the clause
			// says nothing back — one Diagnostic about the name that is missing,
			// and no second one about a Type nobody wrote.
			it("should stay silent about a base that is already an Error", () => {
				expect(
					diagnosticsFor(
						"implementation { type Refined = Nope where @::isNot(0) }",
					).map((diagnostic) => diagnostic.code),
				).toEqual(["unknown-type"])

				expect(
					diagnosticsFor(
						"implementation { type Refined = Refined where @::isNot(0) }",
					).map((diagnostic) => diagnostic.code),
				).toEqual(["recursive-type-declaration"])
			})

			// NOTE: And a predicate that could not be typed is a Diagnostic about
			// the Method it named, never a second one about the clause holding it.
			it("should stay silent about a predicate that did not type", () => {
				expect(
					diagnosticsFor(
						"implementation { type Refined = Integer where @::nope(0) }",
					).map((diagnostic) => diagnostic.code),
				).toEqual(["unknown-method"])
			})

			it("should leave a refused Alias meaning its base", () => {
				let { program } = enrichSource(
					"implementation { type Sized = Integer where @::absolute() }",
				)

				expect(program.implementation.nodes[0].nodeType).toBe(
					"TypeAliasStatement",
				)

				let alias = program.implementation
					.nodes[0] as common.typed.TypeAliasStatementNode

				expect(alias.type).toEqual({ type: "Integer" })
			})
		})

		// NOTE: A refined receiver keeps every Method its base answers — the
		// bucketing that makes it so is pinned in `resolvers.spec.ts`, and this is
		// the Declaration reaching it — and it flows into its base for free, which
		// is what makes a body written against the base compile unchanged.
		it("should answer a base's Methods on a refined value", () => {
			expect(
				diagnosticsFor(`implementation {
					type NonZero = Integer where @::isNot(0)

					function doubled(_ n: NonZero) -> Integer {
						<- n::multiply(with 2)
					}

					function forgotten(_ n: NonZero) -> Integer {
						<- n
					}
				}`),
			).toEqual([])
		})

		// NOTE: The refusal is reported ONCE. A refined Alias is resolved by
		// hoisting and its predicate is enriched a second time for the typed Node,
		// so there are two readings of one clause and only one of them may speak.
		it("should report a refusal exactly once", () => {
			expect(
				diagnosticsFor(
					"implementation { type Yes = Boolean where @::is(true) }",
				),
			).toHaveLength(1)
		})

		// NOTE: A refined Alias and the Namespace answering its predicate may
		// name each other — the Alias asks `isProper`, and a signature next to
		// `isProper` takes a `Proper` — which no single hoisting round can
		// resolve in one breath. The Alias hoists with its predicate unread and
		// the conjuncts are written into the shared object once the Namespace
		// arrives; these pin that the pair resolves, in either order, and that
		// what the signatures bound really is the refinement rather than a
		// poisoned base.
		describe("self-answering Namespaces", () => {
			function selfAnswering(body: string, aliasFirst: boolean): string {
				let alias = "type Proper = String where @::isProper()"
				let namespace = `namespace Naming for String {
					isProper() -> Boolean {
						<- @::hasAnyContent()
					}

					greet(_ name: Proper) -> String {
						<- "Hello, "::append(name)
					}
				}`

				return `implementation {
					${aliasFirst ? alias : namespace}

					${aliasFirst ? namespace : alias}

					${body}
				}`
			}

			it("should let a Namespace answer the predicate its own signatures name", () => {
				expect(
					diagnosticsFor(
						selfAnswering(
							`constant raw = "Ada"

							if raw::isProper() {
								constant greeting = raw::greet(raw)
							}`,
							true,
						),
					),
				).toEqual([])
			})

			it("should resolve the pair written in either order", () => {
				expect(diagnosticsFor(selfAnswering("", false))).toEqual([])
			})

			// NOTE: The proof that the signature holds the REFINEMENT — a
			// clause that failed would poison the Alias to String, and this
			// call would then pass without a word.
			it("should still demand the evidence the signature names", () => {
				let diagnostics = diagnosticsFor(
					selfAnswering(
						`constant raw = "Ada"

						constant greeting = raw::greet(raw)`,
						true,
					),
				)

				expect(
					diagnostics.map((diagnostic) => diagnostic.code),
				).toEqual(["no-matching-overload"])
			})
		})
	})

	// NOTE: What makes a doorway writable — an `if` whose condition asks a
	// declared refinement's question narrows the binding it asked it of. Nothing
	// here reaches the typed tree: a narrowing is a shadow declaration in an
	// Enricher Scope, and what it is worth is the resolution it changes.
	describe("Refinement flow narrowing", () => {
		// NOTE: The Types every use of a name is enriched to, in the order a walk
		// over the Program finds them — which is how a test asks what a branch
		// narrowed a binding to without reaching through the Statements around it
		// by hand. Reflective on purpose: what the narrowed use happens to sit
		// inside is not what any assertion below is about.
		function readTypesOf(source: string, name: string): Array<string> {
			let { program, diagnostics } = enrichSource(source)

			expect(diagnostics).toEqual([])

			let types: Array<string> = []
			let seen = new Set<object>()

			let walk = (value: unknown): void => {
				if (
					value === null ||
					typeof value !== "object" ||
					seen.has(value)
				) {
					return
				}

				seen.add(value)

				if (Array.isArray(value)) {
					for (let item of value) {
						walk(item)
					}

					return
				}

				let record = value as Record<string, unknown>

				if (
					record.nodeType === "Identifier" &&
					record.content === name
				) {
					types.push(printType(record.type as common.Type))
				}

				for (let child of Object.values(record)) {
					walk(child)
				}
			}

			walk(program)

			return types
		}

		// NOTE: Every source below puts the use it is about LAST, so this is the
		// narrowed one.
		function narrowedTypeOf(source: string, name: string): string {
			let types = readTypesOf(source, name)

			if (types.length === 0) {
				throw new Error(`Nothing named '${name}' is read anywhere.`)
			}

			return types[types.length - 1]
		}

		it("should narrow a Constant the condition proved the predicate of", () => {
			expect(
				narrowedTypeOf(
					`implementation {
						constant d = 3

						if d::isNot(0) {
							__print(d)
						}
					}`,
					"d",
				),
			).toBe("NonZeroInteger")
		})

		// NOTE: The narrowing is worth exactly what it lets a Program write, which
		// is the call a bare Integer is refused by — asserted end to end in
		// `codeGeneration.spec.ts`, where the Validator that refuses it runs.
		it("should let a narrowed Constant reach a refined Parameter", () => {
			expect(
				diagnosticsFor(`implementation {
					function doubled(_ n: NonZeroInteger) -> Integer {
						<- n::multiply(with 2)
					}

					constant d = 3

					if d::isNot(0) {
						__print(doubled(d))
					}
				}`),
			).toEqual([])
		})

		// NOTE: A Variable proven something about can be written to inside the very
		// branch the narrowing would hold over, so the evidence would be about a
		// value that is gone.
		it("should not narrow a Variable", () => {
			expect(
				narrowedTypeOf(
					`implementation {
						variable d = 3

						if d::isNot(0) {
							__print(d)
						}
					}`,
					"d",
				),
			).toBe("Integer")
		})

		// NOTE: Two questions about the same value are not the same question. A
		// refinement is established by the predicate it DECLARES and by nothing
		// that merely implies it — `isGreaterThan(0)` does imply `isNot(0)`, and
		// the Compiler has no way to know that.
		it("should not narrow on a differently spelled predicate", () => {
			expect(
				narrowedTypeOf(
					`implementation {
						constant d = 3

						if d::isGreaterThan(0) {
							__print(d)
						}
					}`,
					"d",
				),
			).toBe("Integer")
		})

		it("should not narrow a Constant the condition says nothing about", () => {
			expect(
				narrowedTypeOf(
					`implementation {
						constant d = 3
						constant e = 4

						if e::isNot(0) {
							__print(d)
						}
					}`,
					"d",
				),
			).toBe("Integer")
		})

		// NOTE: Set INCLUSION — a condition proving two things establishes a
		// refinement asking for one of them.
		it("should establish a refinement a conjunction includes", () => {
			expect(
				narrowedTypeOf(
					`implementation {
						constant d = 3

						if d::isNot(0)::and(d::isLessThan(10)) {
							__print(d)
						}
					}`,
					"d",
				),
			).toBe("NonZeroInteger")
		})

		// NOTE: And where several qualify, the one proving the MOST wins — it is
		// the one that forgets the least.
		it("should prefer the refinement proving the most", () => {
			expect(
				narrowedTypeOf(
					`implementation {
						type SmallNonZero = Integer where @::isNot(0)::and(@::isLessThan(10))

						constant d = 3

						if d::isNot(0)::and(d::isLessThan(10)) {
							__print(d)
						}
					}`,
					"d",
				),
			).toBe("SmallNonZero")
		})

		// NOTE: A conjunction proves things about each binding it names, and each
		// of them narrows on its own.
		it("should narrow both bindings a conjunction names", () => {
			let source = `implementation {
				type NonEmptyString = String where @::hasAnyContent()

				constant d = 3
				constant s = "essence"

				if d::isNot(0)::and(s::hasAnyContent()) {
					__print(s)
					__print(d)
				}
			}`

			expect(narrowedTypeOf(source, "d")).toBe("NonZeroInteger")
			expect(narrowedTypeOf(source, "s")).toBe("NonEmptyString")
		})

		// NOTE: The complement table — the handful of Method pairs the standard
		// library declares as each other's opposites, which is what makes an `else`
		// narrow.
		describe("the else branch", () => {
			it("should narrow through isNot where the condition asked is", () => {
				expect(
					narrowedTypeOf(
						`implementation {
							constant d = 3

							if d::is(0) {
								__print(0)
							} else {
								__print(d)
							}
						}`,
						"d",
					),
				).toBe("NonZeroInteger")
			})

			it("should narrow through is where the condition asked isNot", () => {
				expect(
					narrowedTypeOf(
						`implementation {
							type Zero = Integer where @::is(0)

							constant d = 3

							if d::isNot(0) {
								__print(0)
							} else {
								__print(d)
							}
						}`,
						"d",
					),
				).toBe("Zero")
			})

			it("should narrow a String through hasAnyContent", () => {
				expect(
					narrowedTypeOf(
						`implementation {
							type NonEmptyString = String where @::hasAnyContent()

							constant s = "essence"

							if s::isEmpty() {
								__print(0)
							} else {
								__print(s)
							}
						}`,
						"s",
					),
				).toBe("NonEmptyString")
			})

			it("should narrow a List through hasItems", () => {
				expect(
					narrowedTypeOf(
						`implementation {
							type NonEmptyStrings = List<String> where @::hasItems()

							constant items = ["a", "b"]

							if items::isEmpty() {
								__print(0)
							} else {
								__print(items)
							}
						}`,
						"items",
					),
				).toBe("NonEmptyStrings")
			})

			// NOTE: A conjunction answering `false` says that ONE of its questions
			// failed and nothing about which.
			it("should not narrow through a conjunction", () => {
				expect(
					narrowedTypeOf(
						`implementation {
							constant d = 3

							if d::is(0)::and(d::isLessThan(10)) {
								__print(0)
							} else {
								__print(d)
							}
						}`,
						"d",
					),
				).toBe("Integer")
			})

			// NOTE: Including one whose OTHER half proves nothing readable. The true
			// branch may read a conjunction leaf by leaf and ignore the rest, because
			// each leaf it reads really is proven; the false branch may not, and a
			// count of the conjuncts that came back could not tell the two apart.
			it("should not narrow through a conjunction it read half of", () => {
				expect(
					narrowedTypeOf(
						`implementation {
							constant d = 3
							constant flag = true

							if d::is(0)::and(flag) {
								__print(0)
							} else {
								__print(d)
							}
						}`,
						"d",
					),
				).toBe("Integer")
			})

			it("should not narrow through a Method with no declared opposite", () => {
				expect(
					narrowedTypeOf(
						`implementation {
							type Small = Integer where @::isLessThan(10)

							constant d = 3

							if d::isGreaterThanOrEqualTo(10) {
								__print(0)
							} else {
								__print(d)
							}
						}`,
						"d",
					),
				).toBe("Integer")
			})

			// NOTE: An `else if` needs nothing of its own — the nested If lives in
			// the `falseBody` Array and is enriched in the Scope the complement was
			// declared in, so every branch below it inherits the narrowing.
			it("should carry the narrowing into an else-if chain", () => {
				let source = `implementation {
					constant d = 3

					if d::is(0) {
						__print(0)
					} else if d::isLessThan(0) {
						__print(d)
					} else {
						__print(d)
					}
				}`

				// NOTE: The nested condition's own receiver, then both of its
				// branches — the outer condition's receiver is the Integer before
				// any of it, and is not among these three.
				expect(readTypesOf(source, "d").slice(-3)).toEqual([
					"NonZeroInteger",
					"NonZeroInteger",
					"NonZeroInteger",
				])
			})
		})

		// NOTE: The shadow lives in a WRAPPER Scope of its own, so a body that
		// re-declares the very name the condition narrowed is told nothing — the
		// declaration it would collide with is one nobody wrote.
		it("should leave a body free to re-declare the narrowed name", () => {
			let source = `implementation {
				constant d = 3

				if d::isNot(0) {
					constant d = 1

					__print(d)
				}
			}`

			expect(diagnosticsFor(source)).toEqual([])
			expect(narrowedTypeOf(source, "d")).toBe("Integer")
		})

		// NOTE: A shadow that forgets something the binding's Type already carries
		// is no narrowing at all.
		it("should not forget evidence the binding's Type already carries", () => {
			let source = `implementation {
				type Odd = Integer where @::isOdd()

				function keeps(_ n: NonZeroInteger) -> Integer {
					if n::isOdd() {
						<- n::multiply(with 2)
					}

					<- 0
				}
			}`

			expect(readTypesOf(source, "n").slice(-1)).toEqual([
				"NonZeroInteger",
			])
		})

		// NOTE: And evidence a Type already carries counts towards what the branch
		// proves, which is what lets a condition ADD to it.
		it("should add the condition's evidence to what the Type carries", () => {
			let source = `implementation {
				type SmallNonZero = Integer where @::isNot(0)::and(@::isLessThan(10))

				function adds(_ n: NonZeroInteger) -> Integer {
					if n::isLessThan(10) {
						<- n::multiply(with 2)
					}

					<- 0
				}
			}`

			expect(readTypesOf(source, "n").slice(-1)).toEqual(["SmallNonZero"])
		})

		// NOTE: A Guard proves things about `@` exactly as a condition proves them
		// about a Constant, and it runs before any Statement of the Handler — the
		// Matcher's own check is ANDed in front of it — so what it proves holds
		// throughout the body.
		it("should narrow '@' by a Match Handler's Guard", () => {
			let value = lastConstantValue(`implementation {
				constant value: Integer | String = 3

				constant narrowed = match value -> Integer {
					case Integer where @::isNot(0) {
						<- @
					}

					case _ {
						<- 0
					}
				}
			}`)

			if (value.nodeType !== "Match") {
				throw new Error("Last Constant is not a Match.")
			}

			// NOTE: Navigated rather than searched, because a Handler holds TWO
			// `@`s — its Guard's and its body's — and only the body's is the one
			// the Guard narrowed.
			let returned = value.handlers[0].body[0]

			if (returned.nodeType !== "ReturnStatement") {
				throw new Error("The first Handler does not return.")
			}

			expect(printType(returned.expression.type)).toBe("NonZeroInteger")
		})

		it("should leave '@' alone where a Guard proves nothing declared", () => {
			let value = lastConstantValue(`implementation {
				constant value: Integer | String = 3

				constant narrowed = match value -> Integer {
					case Integer where @::isGreaterThan(0) {
						<- @
					}

					case _ {
						<- 0
					}
				}
			}`)

			if (value.nodeType !== "Match") {
				throw new Error("Last Constant is not a Match.")
			}

			let returned = value.handlers[0].body[0]

			if (returned.nodeType !== "ReturnStatement") {
				throw new Error("The first Handler does not return.")
			}

			expect(printType(returned.expression.type)).toBe("Integer")
		})

		// NOTE: An Error matches everything in both directions, so a poisoned
		// binding would qualify for whichever refinement is declared first and walk
		// out of the branch better typed than it went in.
		it("should not narrow a binding whose Type is poisoned", () => {
			let { program, diagnostics } = enrichSource(`implementation {
				type NonEmptyStrings = List<String> where @::hasItems()

				constant items = [nope]

				if items::hasItems() {
					__print(items)
				}
			}`)

			expect(diagnostics.map((diagnostic) => diagnostic.code)).toEqual([
				"unknown-name",
				"uninferable-type-parameter",
			])

			let branch = program.implementation.nodes.find(
				(node) => node.nodeType === "IfStatement",
			)

			if (branch?.nodeType !== "IfStatement") {
				throw new Error("The Program has no IfStatement.")
			}

			let printed = branch.body[0]

			if (printed.nodeType !== "NativeFunctionInvocation") {
				throw new Error("The branch does not print.")
			}

			expect(printType(printed.arguments[0].value.type)).toBe(
				"List<Error>",
			)
		})

		// NOTE: A refinement over a base the binding is not of establishes nothing,
		// however the predicate is spelled.
		it("should not narrow across bases", () => {
			expect(
				narrowedTypeOf(
					`implementation {
						type NonEmptyString = String where @::hasAnyContent()

						constant items = ["a", "b"]

						if items::hasItems() {
							__print(items)
						}
					}`,
					"items",
				),
			).toBe("List<String>")
		})

		// NOTE: A GENERIC refined Alias stands for nothing until something decides
		// its Type Arguments, and a branch has exactly one thing to decide them
		// FROM: the receiver the question was asked of. So the candidate is worked
		// out per binding — the declared base unified against the receiver's Type —
		// and everything below it is the rule every other refinement is established
		// by, asked of the refinement that unification built.
		describe("a generic refinement", () => {
			const NON_EMPTY =
				"type NonEmptyList<Item> = List<Item> where @::hasItems()"

			it("should narrow a List to the Alias applied to its items", () => {
				expect(
					narrowedTypeOf(
						`implementation {
							${NON_EMPTY}

							constant items = ["a", "b"]

							if items::hasItems() {
								__print(items)
							}
						}`,
						"items",
					),
				).toBe("NonEmptyList<String>")
			})

			// NOTE: The Arguments are worked out from the receiver whatever they are
			// — a List of Lists decides `Item` as the inner List, and the spelling
			// says so.
			it("should narrow a List of Lists to the Alias applied to them", () => {
				expect(
					narrowedTypeOf(
						`implementation {
							${NON_EMPTY}

							constant items = [["a"], ["b"]]

							if items::hasItems() {
								__print(items)
							}
						}`,
						"items",
					),
				).toBe("NonEmptyList<List<String>>")
			})

			// NOTE: The narrowing is worth what it lets a Program write, and what it
			// lets a Program write is a call nothing spelled the Type of: the
			// Parameter says `NonEmptyList<String>` and the branch worked that out from
			// a `List<String>`. Asserted end to end in `codeGeneration.spec.ts`,
			// where the Validator that refuses it outside the branch runs.
			it("should let a narrowed List reach a refined Parameter", () => {
				expect(
					diagnosticsFor(`implementation {
						${NON_EMPTY}

						function firstOf(_ items: NonEmptyList<String>) -> String {
							<- items::item(at 0)::otherwise("")
						}

						constant items = ["a", "b"]

						if items::hasItems() {
							__print(firstOf(items))
						}
					}`),
				).toEqual([])
			})

			// NOTE: The complement table is about the Method pair alone, so the
			// `else` of an `isEmpty` establishes the instantiated refinement for the
			// same reason the true branch of a `hasItems` does — one shared helper
			// asks both.
			it("should narrow the else branch of isEmpty", () => {
				expect(
					narrowedTypeOf(
						`implementation {
							${NON_EMPTY}

							constant items = ["a", "b"]

							if items::isEmpty() {
								__print(0)
							} else {
								__print(items)
							}
						}`,
						"items",
					),
				).toBe("NonEmptyList<String>")
			})

			// NOTE: And a Match Handler's Guard, through the same helper again.
			it("should narrow '@' by a Match Handler's Guard", () => {
				let value = lastConstantValue(`implementation {
					${NON_EMPTY}

					constant value: List<String> | String = ["a"]

					constant narrowed = match value -> Integer {
						case List<String> where @::hasItems() {
							<- @::length()
						}

						case _ {
							<- 0
						}
					}
				}`)

				if (value.nodeType !== "Match") {
					throw new Error("Last Constant is not a Match.")
				}

				let returned = value.handlers[0].body[0]

				if (
					returned.nodeType !== "ReturnStatement" ||
					returned.expression.nodeType !== "MethodInvocation"
				) {
					throw new Error("The first Handler does not return a call.")
				}

				expect(printType(returned.expression.base.type)).toBe(
					"NonEmptyList<String>",
				)
			})

			it("should not narrow a Variable", () => {
				expect(
					narrowedTypeOf(
						`implementation {
							${NON_EMPTY}

							variable items = ["a", "b"]

							if items::hasItems() {
								__print(items)
							}
						}`,
						"items",
					),
				).toBe("List<String>")
			})

			// NOTE: A unification that leaves a Parameter undecided is no candidate:
			// `B` appears nowhere in the base, so no receiver could ever decide it,
			// and a refinement whose base nobody decided would put a Type nobody
			// wrote into the branch.
			it("should not narrow where the receiver decides only some Parameters", () => {
				expect(
					narrowedTypeOf(
						`implementation {
							type Pairish<A, B> = List<A> where @::hasItems()

							constant items = ["a", "b"]

							if items::hasItems() {
								__print(items)
							}
						}`,
						"items",
					),
				).toBe("List<String>")
			})

			// NOTE: A receiver whose items are the enclosing Function's own Type
			// Parameter decides `Item` as that Parameter, which is a decision like
			// any other — the branch inside a generic Function narrows exactly as one
			// outside it does. It reads terse because every Argument is a Parameter,
			// the way an unapplied Case header does.
			it("should narrow a List whose items are a Type Parameter", () => {
				expect(
					narrowedTypeOf(
						`implementation {
							${NON_EMPTY}

							function probe<Item>(_ items: List<Item>) -> Integer {
								if items::hasItems() {
									__print(items)
								}

								<- 0
							}
						}`,
						"items",
					),
				).toBe("NonEmptyList")
			})
		})
	})

	// NOTE: The doorway nobody has to write — a Match on a bare Integer or String
	// takes the VALUE apart, and its Cases are evidence in both directions:
	// reaching the Case for the rest proves the value is none of the values named
	// above it, and a Case that NAMES a value proves that. The Matcher itself is
	// untouched throughout, which is what leaves the Rewriter the Match it always
	// had.
	describe("Refinement match narrowing", () => {
		function handlersOf(
			source: string,
		): common.typed.MatchNode["handlers"] {
			let value = lastConstantValue(source)

			if (value.nodeType !== "Match") {
				throw new Error("Last Constant is not a Match.")
			}

			return value.handlers
		}

		// NOTE: The Type `@` has where the Handler ANSWERS, read off the value it
		// returns rather than searched for — a Handler can hold more than one `@`,
		// and a Guard's is not the body's.
		function selfTypesOf(source: string): Array<string> {
			return handlersOf(source).map((handler) => {
				let returned = handler.body[0]

				if (returned.nodeType !== "ReturnStatement") {
					throw new Error("A Handler does not return.")
				}

				return printType(returned.expression.type)
			})
		}

		let zero = "type Zero = Integer where @::is(0)"

		it("should narrow '@' to the values the Cases above did not name", () => {
			expect(
				selfTypesOf(`implementation {
					constant n = 3

					constant answer = match n -> Integer {
						case 0 { <- 0 }

						case _ { <- @ }
					}
				}`),
			).toEqual(["Integer", "NonZeroInteger"])
		})

		it("should narrow '@' to the value its own Case named", () => {
			expect(
				selfTypesOf(`implementation {
					${zero}

					constant n = 3

					constant answer = match n -> Integer {
						case 0 { <- @ }

						case _ { <- 0 }
					}
				}`),
			).toEqual(["Zero", "Integer"])
		})

		// NOTE: Every Case above contributes, so a refinement asking about two values
		// is established by the two Cases that named them — and set INCLUSION means a
		// refinement asking about one of them is established too.
		it("should read every value the Cases above named", () => {
			expect(
				selfTypesOf(`implementation {
					type NotZeroOrOne = Integer where @::isNot(0)::and(@::isNot(1))

					constant n = 3

					constant answer = match n -> Integer {
						case 0 { <- 0 }

						case 1 { <- 1 }

						case _ { <- @ }
					}
				}`).at(-1),
			).toBe("NotZeroOrOne")
		})

		it("should narrow a String Case by the String it named", () => {
			expect(
				selfTypesOf(`implementation {
					type NotBlank = String where @::isNot("")

					constant text = "essence"

					constant answer = match text -> String {
						case "" { <- "" }

						case _ { <- @ }
					}
				}`),
			).toEqual(["String", "NotBlank"])
		})

		// NOTE: The evidence is read off the Matchers alone, so it holds whatever the
		// Validator makes of the Match's shape — a Guarded value Case is refused
		// there, and it hands nothing down here either. Asked of a Union, where such
		// a Case is legal and the Handlers below it really do see the value it named.
		it("should not read a value a Guarded Case named", () => {
			expect(
				selfTypesOf(`implementation {
					constant flag = true
					constant value: Integer | String = 3

					constant answer = match value -> Integer {
						case 0 where flag { <- 0 }

						case Integer { <- @ }

						case String { <- 0 }
					}
				}`).at(1),
			).toBe("Integer")
		})

		// NOTE: A Guard runs AFTER the Matcher matched, not instead of it, so what the
		// Handler's own Case named still holds inside its body.
		it("should keep the value its own Guarded Case named", () => {
			expect(
				selfTypesOf(`implementation {
					${zero}

					constant flag = true
					constant value: Integer | String = 3

					constant answer = match value -> Integer {
						case 0 where flag { <- @ }

						case Integer { <- 0 }

						case String { <- 0 }
					}
				}`).at(0),
			).toBe("Zero")
		})

		// NOTE: Nothing about the Match itself changes — the Matcher is the Type the
		// runtime check is emitted from, and evidence is not a runtime question. This
		// is the invariant that leaves the Rewriter needing no change at all.
		it("should leave every Matcher as it was", () => {
			expect(
				handlersOf(`implementation {
					${zero}

					constant n = 3

					constant answer = match n -> Integer {
						case 0 { <- @ }

						case _ { <- @ }
					}
				}`).map((handler) => printType(handler.matcher)),
			).toEqual(["Integer", "Integer"])
		})

		// NOTE: Two questions about the same value are not the same question. A String
		// that is not the empty one HAS content, and the Compiler has no way to know
		// that — the same rule an `if` narrows by.
		it("should not narrow on a differently spelled predicate", () => {
			expect(
				selfTypesOf(`implementation {
					type NonEmptyString = String where @::hasAnyContent()

					constant text = "essence"

					constant answer = match text -> String {
						case "" { <- "" }

						case _ { <- @ }
					}
				}`).at(-1),
			).toBe("String")
		})

		// NOTE: A Boolean is no refinable base, and a Case naming one of its two
		// values proves nothing anything could be declared by.
		it("should read no evidence out of a Boolean Case", () => {
			expect(
				selfTypesOf(`implementation {
					constant value: Boolean | Integer = true

					constant answer = match value -> Integer {
						case true { <- 0 }

						case Integer { <- @ }

						case Boolean { <- 1 }
					}
				}`).at(1),
			).toBe("Integer")
		})
	})

	// NOTE: A value written DOWN needs no branch in front of it — its predicate is
	// decided while compiling. What the Enricher does with that is choose an
	// Overload by it, which is what these assert; the Statements a Program writes
	// one into are the Validator's, and `validator.spec.ts` asserts those.
	describe("Refinement literal admission", () => {
		// NOTE: Two entries under one name, told apart by exactly the evidence the
		// first one demands — so which one answered says whether the Argument was
		// admitted, with no Diagnostic and no narrowing anywhere in the source.
		function scaled(argument: string): string {
			return `implementation {
				type NonZero = Integer where @::isNot(0)

				namespace Scaling for Integer {
					overload scaled {
						(by other: NonZero) -> String {
							<- "refined"
						}

						(by other: Integer) -> String {
							<- "base"
						}
					}
				}

				constant scaledValue = 3::scaled(by ${argument})
			}`
		}

		it("should admit a written value the predicate holds of", () => {
			expect(
				lastConstantMethodInvocation(scaled("2")).overloadedMethodIndex,
			).toBe(0)
		})

		it("should not admit a written value the predicate refuses", () => {
			expect(
				lastConstantMethodInvocation(scaled("0")).overloadedMethodIndex,
			).toBe(1)
		})

		// NOTE: The evaluator reads a value that is WRITTEN. A name is a value the
		// Program computes, however plainly it was computed a line above — deciding
		// that would need an interpreter, which is what the allowlist exists not to
		// be.
		it("should not admit a value the Program computes", () => {
			expect(
				lastConstantMethodInvocation(`implementation {
					type NonZero = Integer where @::isNot(0)

					namespace Scaling for Integer {
						overload scaled {
							(by other: NonZero) -> String {
								<- "refined"
							}

							(by other: Integer) -> String {
								<- "base"
							}
						}
					}

					constant two = 2

					constant scaledValue = 3::scaled(by two)
				}`).overloadedMethodIndex,
			).toBe(1)
		})

		// NOTE: The whole reason admission answers a POSITION rather than writing
		// the refinement onto the Node: the first entry here admits the Argument it
		// is asked about and loses anyway, on the Argument after it. Nothing it
		// admitted may reach the entry that wins — and nothing does, because there
		// was never anywhere to leave it.
		it("should leave nothing behind on a Node a losing candidate admitted", () => {
			let invocation = lastConstantMethodInvocation(`implementation {
				type NonZero = Integer where @::isNot(0)

				namespace Scaling for Integer {
					overload scaled {
						(by other: NonZero, and extra: String) -> String {
							<- "refined"
						}

						(by other: Integer, and extra: Integer) -> String {
							<- "base"
						}
					}
				}

				constant scaledValue = 3::scaled(by 2, and 5)
			}`)

			expect(invocation.overloadedMethodIndex).toBe(1)
			expect(
				invocation.arguments.map((argument) =>
					printType(argument.type),
				),
			).toEqual(["Integer", "Integer"])
			expect(
				invocation.arguments.map((argument) =>
					printType(argument.value.type),
				),
			).toEqual(["Integer", "Integer"])
		})
	})
})
