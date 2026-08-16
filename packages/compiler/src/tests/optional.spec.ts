import { describe, expect, it } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import type { common } from "@essence-lang/interfaces"

import { containsErrors } from "../diagnostics/index"
import { enrich } from "../enricher/index"
import { optimise } from "../optimiser/index"
import { parseWithDiagnostics } from "../parser/index"
import { rewrite } from "../rewriter/index"
import { simplify } from "../simplifier/index"
import { validate } from "../validator/index"

// NOTE: `Optional` is a nominal Choice — `#Value(item)` or `#Empty` — and what
// that buys is not visible in a Type error: it is visible when a Program RUNS.
// Every claim in this file is one an `ItemType | Nothing` Union could not make,
// so each one compiles AND executes rather than only type-checking.
function generate(source: string): string {
	let parsed = parseWithDiagnostics(source)

	expect(containsErrors(parsed.diagnostics)).toBe(false)

	let enriched = enrich(parsed.program)

	expect(containsErrors(enriched.diagnostics)).toBe(false)
	expect(containsErrors(validate(enriched.program))).toBe(false)

	return rewrite(optimise(simplify(enriched.program)))
}

async function run(source: string): Promise<Array<string>> {
	let js = generate(source)
	let directory = mkdtempSync(join(tmpdir(), "essence-optional-"))
	let file = join(directory, "program.ts")

	writeFileSync(file, js)

	let output: Array<string> = []
	let originalLog = console.log

	console.log = (...args: Array<unknown>) => {
		output.push(args.map((argument) => String(argument)).join(" "))
	}

	try {
		await import(file)
	} finally {
		console.log = originalLog
		rmSync(directory, { recursive: true, force: true })
	}

	return output
}

// NOTE: Exhaustiveness is the Validator's answer, not the Enricher's, so this
// runs the stage that decides it rather than stopping at enrichment.
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

describe("Optional", () => {
	describe("Nesting", () => {
		// NOTE: THE reason the Choice exists. A `List<Optional<Integer>>` that
		// holds an empty Optional used to be indistinguishable from a List with
		// nothing at that position, because `Integer | Nothing | Nothing` is
		// `Integer | Nothing`. Two levels are now two levels.
		const stored = `constant stored: List<Optional<Integer>> = [#Empty, #Value(7)]`

		it("keeps a stored empty apart from a missing item", async () => {
			expect(
				await run(`implementation {
					${stored}

					Terminal.inspect(stored::firstItem())
					Terminal.inspect(stored::item(at 9))
				}`),
			).toEqual(["Optional#Value(Optional#Empty)", "Optional#Empty"])
		})

		it("carries two levels through firstItem", async () => {
			expect(
				await run(`implementation {
					${stored}

					Terminal.inspect(stored::lastItem())
				}`),
			).toEqual(["Optional#Value(Optional#Value(7))"])
		})

		it("collapses one level with flatten, and only one", async () => {
			expect(
				await run(`implementation {
					${stored}

					Terminal.inspect(stored::firstItem()::flatten())
					Terminal.inspect(stored::lastItem()::flatten())
					Terminal.inspect(stored::item(at 9)::flatten())
				}`),
			).toEqual(["Optional#Empty", "Optional#Value(7)", "Optional#Empty"])
		})

		it("lets firstItem(where:) say it found an empty one", async () => {
			// NOTE: The ambiguity `List.es` used to carry a paragraph about:
			// `#Value(#Empty)` is "an item matched, and it is empty", while
			// `#Empty` would be "no item matched". They are different values.
			expect(
				await run(`implementation {
					${stored}

					Terminal.inspect(stored::firstItem(where (item) { <- item::isEmpty() }))
					Terminal.inspect(stored::firstItem(where (item) { <- item::is(#Value(9)) }))
				}`),
			).toEqual(["Optional#Value(Optional#Empty)", "Optional#Empty"])
		})
	})

	describe("Conformance", () => {
		// NOTE: An `ItemType | Nothing` belonged to no Namespace at all, which
		// is why the golden harness carried a `showMaybe` beside `show`. These
		// are the conformances that deleted it.
		it("prints through the payload's own toString", async () => {
			expect(
				await run(`implementation {
					constant numbers = [3, 1]
					constant none: List<Integer> = []

					Terminal.inspect(numbers::firstItem()::toString())
					Terminal.inspect(none::firstItem()::toString())
					Terminal.inspect("{numbers::firstItem()}")
				}`),
			).toEqual([`"Value(3)"`, `"Empty"`, `"Value(3)"`])
		})

		it("compares whole Optionals through the payload's own is", async () => {
			expect(
				await run(`implementation {
					constant numbers = [3, 1]
					constant none: List<Integer> = []

					Terminal.inspect(numbers::firstItem()::is(#Value(3)))
					Terminal.inspect(numbers::firstItem()::is(#Value(1)))
					Terminal.inspect(numbers::firstItem()::is(#Empty))
					Terminal.inspect(none::firstItem()::is(#Empty))
					Terminal.inspect(numbers::firstItem()::isNot(none::firstItem()))
				}`),
			).toEqual(["true", "false", "false", "true", "true"])
		})

		// NOTE: The second entry of `is`: against a bare item, an Optional IS
		// that item wrapped, or it is not — and an empty one never is. This is
		// what lets a lookup be tested without collapsing it through a
		// default the item might genuinely equal.
		it("compares against a bare item, which an empty Optional never is", async () => {
			expect(
				await run(`implementation {
					constant codes = ["a", "b"]

					Terminal.inspect(codes::item(at 1)::is("b"))
					Terminal.inspect(codes::item(at 1)::is("a"))
					Terminal.inspect(codes::item(at 9)::is("a"))
					Terminal.inspect(codes::item(at 1)::isNot("b"))
					Terminal.inspect(codes::item(at 9)::isNot("a"))
				}`),
			).toEqual(["true", "false", "false", "false", "true"])
		})

		// NOTE: On an `Optional<Optional<Integer>>` the Argument `#Empty` fits
		// both entries, and the whole-Optional one is declared first so that
		// it wins: `is(#Empty)` asks whether the RECEIVER is empty, never
		// whether a missing payload is. `#Value(3)` fits only the item entry,
		// so it reads at the inner level. Both are what the words say.
		it("reads a nested Optional at the outer level first", async () => {
			expect(
				await run(`implementation {
					constant stored: List<Optional<Integer>> = [#Empty, #Value(3)]

					Terminal.inspect(stored::firstItem()::is(#Empty))
					Terminal.inspect(stored::item(at 9)::is(#Empty))
					Terminal.inspect(stored::firstItem()::is(#Value(#Empty)))
					Terminal.inspect(stored::lastItem()::is(#Value(3)))
					Terminal.inspect(stored::lastItem()::is(#Value(#Value(3))))
					Terminal.inspect(stored::item(at 9)::isNot(#Empty))
				}`),
			).toEqual(["false", "true", "true", "true", "true", "false"])
		})

		it("is searchable by value in a List", async () => {
			expect(
				await run(`implementation {
					constant stored: List<Optional<Integer>> = [#Empty, #Value(7)]

					Terminal.inspect(stored::firstIndex(of #Empty))
					Terminal.inspect(stored::firstIndex(of #Value(7)))
					Terminal.inspect(stored::contains(#Value(9)))
				}`),
			).toEqual(["Optional#Value(0)", "Optional#Value(1)", "false"])
		})
	})

	describe("The Namespace", () => {
		it("maps and keeps without taking the Optional apart", async () => {
			expect(
				await run(`implementation {
					constant numbers = [3, 1]
					constant none: List<Integer> = []

					Terminal.inspect(numbers::firstItem()::map((n) { <- n::multiply(with 10) }))
					Terminal.inspect(none::firstItem()::map((n) { <- n::multiply(with 10) }))
					Terminal.inspect(numbers::firstItem()::keep(where (n) { <- n::isOdd() }))
					Terminal.inspect(numbers::firstItem()::keep(where (n) { <- n::isEven() }))
				}`),
			).toEqual([
				"Optional#Value(30)",
				"Optional#Empty",
				"Optional#Value(3)",
				"Optional#Empty",
			])
		})

		it("collapses to a bare value with value(withDefault:)", async () => {
			expect(
				await run(`implementation {
					constant numbers = [3]
					constant none: List<Integer> = []

					Terminal.inspect(numbers::firstItem()::value(withDefault 0))
					Terminal.inspect(none::firstItem()::value(withDefault 0))
				}`),
			).toEqual(["3", "0"])
		})

		it("answers hasValue and isEmpty without a Match", async () => {
			expect(
				await run(`implementation {
					constant numbers = [3]
					constant none: List<Integer> = []

					Terminal.inspect(numbers::firstItem()::hasValue())
					Terminal.inspect(numbers::firstItem()::isEmpty())
					Terminal.inspect(none::firstItem()::hasValue())
					Terminal.inspect(none::firstItem()::isEmpty())
				}`),
			).toEqual(["true", "false", "false", "true"])
		})
	})

	describe("Matching", () => {
		it("binds the payload, and a Guard can name it", async () => {
			// NOTE: The Guard resolves the binding into the `@.item` it stands
			// for — a Guard runs in the Handler's test, before the body's
			// constant exists. See `enrichCaseMatcherBinding`.
			expect(
				await run(`implementation {
					constant stored: List<Optional<Integer>> = [#Empty, #Value(7)]

					Terminal.inspect(match stored::lastItem() -> String {
						case #Value(inner) where inner::hasValue() {
							<- "found {inner}"
						}
						case #Value(inner) { <- "found an empty one" }
						case #Empty        { <- "found nothing" }
					})
				}`),
			).toEqual([`"found Value(7)"`])
		})

		it("offers a near miss from the covering Namespace on a typo", () => {
			// NOTE: A mistyped Method on an Optional falls to per-member
			// dispatch — no Case declares the name — and the Method it meant is
			// on the Namespace over BOTH Cases, which is the one place that
			// dispatch does not look. The near miss is read off the Union's own
			// Namespaces for exactly that reason.
			let diagnostics = diagnosticsOf(`implementation {
				constant numbers = [3]

				Terminal.inspect(numbers::firstItem()::hasValu())
			}`)

			expect(diagnostics.map(({ code }) => code)).toContain(
				"unknown-method",
			)
			expect(diagnostics.flatMap(({ helps }) => helps)).toContain(
				"Did you mean 'hasValue'?",
			)
		})

		it("names the receiver as written when the Arguments are wrong", () => {
			// NOTE: `otherwise` is declared on the Namespace covering BOTH
			// Cases, so a rejected Argument falls through to per-member
			// dispatch — which is a second chance, not the failure worth
			// reporting. Reporting the member said `for Optional#Value`, a Case
			// the writer never mentioned, and spelled the Parameter as the
			// Namespace's own `ItemType`.
			let diagnostics = diagnosticsOf(`implementation {
				constant maybe: Optional<Rational> = #Empty

				Terminal.inspect(maybe::value(withDefault 0))
			}`)

			expect(diagnostics.map(({ code }) => code)).toEqual([
				"no-matching-overload",
			])
			expect(diagnostics[0]!.message).toBe(
				"No overload of 'value' accepts these Arguments",
			)
			expect(diagnostics[0]!.notes).toEqual([
				"'Optional::value' takes 1 Argument: Parameter 'withDefault' is Rational.",
			])
		})

		it("still names the member when no Namespace covers the receiver", () => {
			// NOTE: The other side of the same rail. Nothing covers
			// `Integer | String`, so the failure really is "this member has no
			// such Method" and naming the member is the whole point.
			let diagnostics = diagnosticsOf(`implementation {
				constant mixed: Integer | String = 1

				Terminal.inspect(mixed::isEven())
			}`)

			expect(diagnostics.map(({ code }) => code)).toEqual([
				"unknown-method",
			])
			expect(diagnostics[0]!.message).toBe(
				"No Method named 'isEven' for String",
			)
		})

		it("is exhaustive over the two Cases and nothing more", () => {
			expect(
				diagnosticsOf(`implementation {
					constant numbers = [3]

					Terminal.inspect(match numbers::firstItem() -> Integer {
						case #Value(item) { <- item }
					})
				}`).map(({ code }) => code),
			).toContain("missing-case")
		})
	})

	describe("Bare Case resolution", () => {
		// NOTE: `Optional` is the first BUILTIN Choice whose Case names a
		// Program is likely to reuse. A bare `#Empty` has to keep resolving
		// against the Choice the position asks for, not against Optional
		// because it is builtin.
		it("prefers the Choice the position names over the builtin", async () => {
			expect(
				await run(`implementation {
					choice Box<Value> {
						Full { value: Value },
						Empty,
					}

					constant boxed: Box<Integer> = #Empty
					constant missing: Optional<Integer> = #Empty

					Terminal.inspect(boxed)
					Terminal.inspect(missing)
				}`),
			).toEqual(["Box#Empty", "Optional#Empty"])
		})
	})
})
