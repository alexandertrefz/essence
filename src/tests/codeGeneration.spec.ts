import { describe, expect, it } from "bun:test"

import { containsErrors } from "../diagnostics/index"
import { enrich } from "../enricher/index"
import type { common } from "../interfaces/index"
import { optimise } from "../optimiser/index"
import { parseWithDiagnostics } from "../parser/index"
import { rewrite } from "../rewriter/index"
import { simplify } from "../simplifier/index"
import { validate } from "../validator/index"

// NOTE: Runs the same stages the CLI runs, minus bundling — enough to assert
// on the shape of the emitted JavaScript without touching the file system.
function generate(source: string): string {
	let parsed = parseWithDiagnostics(source)

	expect(containsErrors(parsed.diagnostics)).toBe(false)

	let enriched = enrich(parsed.program)

	expect(containsErrors(enriched.diagnostics)).toBe(false)
	expect(containsErrors(validate(enriched.program))).toBe(false)

	return rewrite(optimise(simplify(enriched.program)))
}

// NOTE: The counterpart for cases that are supposed to be rejected — returns
// whatever the first failing stage reported instead of asserting success.
function diagnosticsOf(source: string): Array<common.Diagnostic> {
	let parsed = parseWithDiagnostics(source)

	if (containsErrors(parsed.diagnostics)) {
		return parsed.diagnostics
	}

	let enriched = enrich(parsed.program)

	if (containsErrors(enriched.diagnostics)) {
		return enriched.diagnostics
	}

	return validate(enriched.program)
}

function hasCode(
	diagnostics: Array<common.Diagnostic>,
	code: common.DiagnosticCode,
): boolean {
	return diagnostics.some((diagnostic) => diagnostic.code === code)
}

describe("Code Generation", () => {
	describe("Match", () => {
		// NOTE: Regression test — the Handlers used to be folded into the
		// if/else cascade in a way that only kept the first and the last, so
		// every Match with more than two Handlers silently dropped the ones in
		// between and fell through to `undefined`.
		it("emits every Handler of a Match", () => {
			let generated = generate(`
				implementation {
					variable value: Integer | Fraction | String | Nothing = nothing

					__print(match value -> String {
						case Integer  { <- "handled integer" }
						case Fraction { <- "handled fraction" }
						case String   { <- "handled string" }
						case Nothing  { <- "handled nothing" }
					})
				}
			`)

			expect(generated).toContain("handled integer")
			expect(generated).toContain("handled fraction")
			expect(generated).toContain("handled string")
			expect(generated).toContain("handled nothing")
		})

		it("nests the Handlers so that each one is the alternate of the last", () => {
			let generated = generate(`
				implementation {
					variable value: Integer | Fraction | Nothing = nothing

					__print(match value -> String {
						case Integer  { <- "a" }
						case Fraction { <- "b" }
						case Nothing  { <- "c" }
					})
				}
			`)

			// NOTE: Three Handlers produce one `if` plus two `else` branches.
			expect(generated.split("else").length - 1).toBe(2)
		})

		// NOTE: Regression test — a Union Matcher used to be serialised with
		// `Object.entries`, which turned its member list into `{ 0: …, 1: … }`
		// and left the runtime Type check calling Array Methods on an Object.
		it("serialises the member list of a Union Matcher as an Array", () => {
			let generated = generate(`
				implementation {
					variable value: Integer | Fraction | Nothing = nothing

					__print(match value -> String {
						case Integer | Fraction { <- "number" }
						case Nothing            { <- "nothing" }
					})
				}
			`)

			expect(generated).toContain("types: [")
			expect(generated).not.toContain("types: {")
		})

		it("emits a wildcard Handler alongside the Handlers before it", () => {
			let generated = generate(`
				implementation {
					variable value: Integer | Fraction | Nothing = nothing

					__print(match value -> String {
						case Nothing { <- "handled nothing" }
						case _       { <- "handled the rest" }
					})
				}
			`)

			expect(generated).toContain("handled nothing")
			expect(generated).toContain("handled the rest")
		})
	})

	describe("Match Wildcards", () => {
		// NOTE: The point of resolving a wildcard to the still-unhandled
		// members rather than to Unknown — `@` has to keep a Type precise
		// enough to call Methods on and to return where a member Type is
		// expected.
		it("narrows @ inside a wildcard to the unhandled members", () => {
			expect(() =>
				generate(`
					implementation {
						variable value: Integer | Nothing = 5

						__print(match value -> Integer {
							case Nothing { <- 0 }
							case _       { <- @::multiplyWith(2) }
						})
					}
				`),
			).not.toThrow()
		})

		it("accepts a wildcard as the only Handler", () => {
			expect(() =>
				generate(`
					implementation {
						variable value: Integer | Nothing = 5

						__print(match value -> String {
							case _ { <- "anything" }
						})
					}
				`),
			).not.toThrow()
		})
	})

	describe("Match Literals and Guards", () => {
		it("compares by value for a literal Matcher", () => {
			let generated = generate(`
				implementation {
					variable value: Integer | Nothing = 0

					__print(match value -> String {
						case 0       { <- "zero" }
						case Integer { <- "other" }
						case Nothing { <- "nothing" }
					})
				}
			`)

			// NOTE: A literal Matcher is a value comparison, not a Type check
			// — `anyIs` is already false across differing Types, so it needs
			// no `isValueOfType` in front of it.
			expect(generated).toContain("anyIs")
		})

		it("ands a Guard onto the check its Matcher produced", () => {
			let generated = generate(`
				implementation {
					variable value: Integer | Nothing = 1

					__print(match value -> String {
						case Integer where @::isGreaterThan(0) { <- "positive" }
						case Integer                           { <- "other" }
						case Nothing                           { <- "nothing" }
					})
				}
			`)

			expect(generated).toContain("&&")
		})

		// NOTE: The rule both features share — a Handler that can decline a
		// value it Type-matched cannot make the Union exhaustive.
		it("does not let a literal Matcher discharge its Type", () => {
			let diagnostics = diagnosticsOf(`
				implementation {
					variable value: Integer | Nothing = 0

					__print(match value -> String {
						case 0       { <- "zero" }
						case Nothing { <- "nothing" }
					})
				}
			`)

			expect(hasCode(diagnostics, "missing-case")).toBe(true)
		})

		it("does not let a Guard discharge its Type", () => {
			let diagnostics = diagnosticsOf(`
				implementation {
					variable value: Integer | Nothing = 1

					__print(match value -> String {
						case Integer where @::isGreaterThan(0) { <- "positive" }
						case Nothing                           { <- "nothing" }
					})
				}
			`)

			expect(hasCode(diagnostics, "missing-case")).toBe(true)
		})

		it("leaves a literal's Type in the residual of a later wildcard", () => {
			// NOTE: `case 0` catches one Integer, so `@` inside the wildcard is
			// still Integer|Nothing — calling an Integer Method on it has to
			// stay an error.
			let diagnostics = diagnosticsOf(`
				implementation {
					variable value: Integer | Nothing = 1

					__print(match value -> Integer {
						case 0 { <- 0 }
						case _ { <- @::multiplyWith(2) }
					})
				}
			`)

			expect(containsErrors(diagnostics)).toBe(true)
		})

		it("narrows the wildcard once every other Type is unconditionally handled", () => {
			expect(() =>
				generate(`
					implementation {
						variable value: Integer | Nothing = 1

						__print(match value -> Integer {
							case Nothing { <- 0 }
							case 0       { <- 0 }
							case _       { <- @::multiplyWith(2) }
						})
					}
				`),
			).not.toThrow()
		})
	})

	describe("Record Matchers", () => {
		// NOTE: Regression test — matching a Record used to fall through the
		// runtime Type check entirely, so `case { a: Integer }` compiled
		// cleanly and then never matched anything.
		it("matches a Record structurally", () => {
			let generated = generate(`
				implementation {
					variable value: { a: Integer } | Nothing = { a = 1 }

					__print(match value -> String {
						case { a: Integer } { <- "record" }
						case Nothing        { <- "nothing" }
					})
				}
			`)

			expect(generated).toContain("record")
			expect(generated).toContain("nothing")
		})

		it("compares a value-constrained member by value", () => {
			let generated = generate(`
				implementation {
					variable value: { a: Integer, b: Integer } | Nothing = { a = 6, b = 2 }

					__print(match value -> String {
						case { a = 6, b: Integer } { <- "six" }
						case { a: Integer }        { <- "record" }
						case Nothing               { <- "nothing" }
					})
				}
			`)

			expect(generated).toContain("anyIs")
		})

		it("types @ as the Record so its members can be read", () => {
			expect(() =>
				generate(`
					implementation {
						variable value: { a: Integer, b: Integer } | Nothing = { a = 6, b = 7 }

						__print(match value -> Integer {
							case { a = 6, b: Integer } { <- @.b }
							case { a: Integer }        { <- @.a }
							case Nothing               { <- 0 }
						})
					}
				`),
			).not.toThrow()
		})

		it("does not let a value-constrained Record discharge its Type", () => {
			let diagnostics = diagnosticsOf(`
				implementation {
					variable value: { a: Integer } | Nothing = { a = 6 }

					__print(match value -> String {
						case { a = 6 }  { <- "six" }
						case Nothing    { <- "nothing" }
					})
				}
			`)

			expect(hasCode(diagnostics, "missing-case")).toBe(true)
		})

		it("lets a purely Type-constrained Record discharge its Type", () => {
			expect(() =>
				generate(`
					implementation {
						variable value: { a: Integer } | Nothing = { a = 6 }

						__print(match value -> String {
							case { a: Integer } { <- "record" }
							case Nothing        { <- "nothing" }
						})
					}
				`),
			).not.toThrow()
		})
	})

	describe("Nameless Parameters", () => {
		it("gives every nameless Parameter its own emitted name", () => {
			let generated = generate(`
				implementation {
					function f(_: Integer, _: String, _: Boolean) -> Integer {
						<- 1
					}

					__print(f(1, "a", true))
				}
			`)

			// NOTE: Distinct placeholders — two Parameters sharing a name
			// would be a redeclaration in the emitted Function.
			expect(generated).toContain("_0")
			expect(generated).toContain("_1")
			expect(generated).toContain("_2")
		})

		// NOTE: The reason the form is worth having — in a Function Type there
		// is no body, so a Parameter name could never be referred to anyway.
		it("accepts a nameless Parameter in a Function Type", () => {
			expect(() =>
				generate(`
					implementation {
						function apply(_ transform: (_: Integer) -> String) -> String {
							<- transform(1)
						}

						__print(apply((_ value: Integer) -> String {
							<- value::toString()
						}))
					}
				`),
			).not.toThrow()
		})
	})

	describe("Protocols", () => {
		it("should erase Protocol declarations from the emitted JavaScript", () => {
			const code = generate(`implementation {
				protocol Showable {
					toString() -> String
				}

				__print("done")
			}`)

			expect(code).not.toContain("Showable")
			expect(code).not.toContain("toString")
		})

		it("should pass a conformance value at bounded invocations", () => {
			const code = generate(`implementation {
				protocol Showable {
					toString() -> String
				}

				type Vector = { x: Number, y: Number }

				namespace VectorShowable for Vector is Showable {
					toString() -> String {
						<- "vector"
					}
				}

				function describeValue <infer Value is Showable>(_ value: Value) -> String {
					<- value::toString()
				}

				__print(describeValue({ x = 1, y = 2 }))
			}`)

			// NOTE: The bounded Function gains a hidden trailing parameter, its
			// body dispatches through it, and the call site packages the
			// conforming Namespace's Methods into an object literal.
			expect(code).toContain("Value__conformance")
			expect(code).toContain("VectorShowable.toString")
			expect(code).toContain("Value__conformance.toString(")
		})

		it("should package builtin Namespace Methods into conformance values", () => {
			const code = generate(`implementation {
				function smaller <infer Item is Comparable>(_ a: Item, _ b: Item) -> Item {
					<- match a::compareTo(b) -> Item {
						case Less    { <- a }
						case Equal   { <- a }
						case Greater { <- b }
					}
				}

				__print(smaller(5, 3))
			}`)

			expect(code).toContain("compareTo: Integer.compareTo")
			expect(code).toContain("Item__conformance.compareTo(")
		})

		it("should forward a conformance parameter between bounded Functions", () => {
			const code = generate(`implementation {
				protocol Showable {
					toString() -> String
				}

				type Vector = { x: Number, y: Number }

				namespace VectorShowable for Vector is Showable {
					toString() -> String {
						<- "vector"
					}
				}

				function inner <infer Value is Showable>(_ value: Value) -> String {
					<- value::toString()
				}

				function outer <infer Item is Showable>(_ item: Item) -> String {
					<- inner(item)
				}

				__print(outer({ x = 1, y = 2 }))
			}`)

			expect(code).toContain("inner(item, Item__conformance)")
		})
	})

	describe("Union Method Dispatch", () => {
		it("should emit a runtime dispatch with one statically resolved target per member", () => {
			const code = generate(`implementation {
				constant value: Integer | Boolean = 5

				__print(value::toString())
			}`)

			expect(code).toContain("$type.dispatchMethod")
			expect(code).toContain("Integer.toString")
			expect(code).toContain("Boolean.toString")
		})

		it("should mangle overloaded Method names per dispatch case", () => {
			const code = generate(`implementation {
				constant number: Number = 5

				__print(number::multiplyWith(2)::toString())
			}`)

			expect(code).toContain("Integer.multiplyWith__overload$")
			expect(code).toContain("Fraction.multiplyWith__overload$")
		})

		it("should dispatch a bounded Type Parameter member through the conformance parameter", () => {
			const code = generate(`implementation {
				function firstText <infer Item is Printable>(_ items: List<Item>) -> String {
					<- items::firstItem()::toString()
				}

				__print(firstText([1, 2]))
			}`)

			expect(code).toContain("$type.dispatchMethod")
			expect(code).toContain("Nothing.toString")
			expect(code).toContain("Item__conformance.toString")
		})

		it("should order the catch-all Type Parameter case last", () => {
			const code = generate(`implementation {
				function firstText <infer Item is Printable>(_ items: List<Item>) -> String {
					<- items::firstItem()::toString()
				}

				__print(firstText([1, 2]))
			}`)

			expect(code.indexOf("Nothing.toString")).toBeGreaterThan(-1)
			expect(code.indexOf("Nothing.toString")).toBeLessThan(
				code.indexOf("Item__conformance.toString"),
			)
		})

		it("should emit member Namespaces of a user Union as call targets", () => {
			const code = generate(`implementation {
				namespace IntegerTag for Integer {
					tag() -> String {
						<- "integer"
					}
				}

				namespace BooleanTag for Boolean {
					tag() -> String {
						<- "boolean"
					}
				}

				constant value: Integer | Boolean = 5

				__print(value::tag())
			}`)

			expect(code).toContain("IntegerTag.tag")
			expect(code).toContain("BooleanTag.tag")
		})
	})
})
