import { describe, expect, it } from "bun:test"

import { containsErrors } from "../diagnostics/index"
import { enrich } from "../enricher/index"
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
})
