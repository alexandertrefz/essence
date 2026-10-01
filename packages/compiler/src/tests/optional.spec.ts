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

// `Optional` is a nominal Choice of `#Value(item)` and `#Empty`. What that
// buys shows when a Program runs, so each claim here compiles and executes.
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

// Runs the Validator, which decides exhaustiveness.
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
		// A stored empty Optional stays apart from a missing item: two levels
		// are two levels.
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
			// `#Value(#Empty)` says an item matched and it is empty. `#Empty`
			// says no item matched.
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
		// An Optional prints and compares through its payload's conformances.
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

		// The second entry of `is` compares against a bare item, so a lookup
		// is tested without a default the item might equal.
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

		// On an `Optional<Optional<Integer>>`, `#Empty` fits both entries and
		// the whole-Optional one, declared first, wins. `#Value(3)` fits only
		// the item entry.
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

		it("collapses to a bare value with value(defaultingTo:)", async () => {
			expect(
				await run(`implementation {
					constant numbers = [3]
					constant none: List<Integer> = []

					Terminal.inspect(numbers::firstItem()::value(defaultingTo 0))
					Terminal.inspect(none::firstItem()::value(defaultingTo 0))
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

		// An empty Optional answers `false` without running the check, as
		// `List::hasItems(where:)` does.
		it("asks a question of the value, and answers false without one", async () => {
			expect(
				await run(`implementation {
					constant numbers = [3]
					constant none: List<Integer> = []

					Terminal.inspect(numbers::firstItem()::hasValue(where (item) { <- item::isOdd() }))
					Terminal.inspect(numbers::firstItem()::hasValue(where (item) { <- item::isEven() }))
					Terminal.inspect(none::firstItem()::hasValue(where (item) { <- item::isOdd() }))
				}`),
			).toEqual(["true", "false", "false"])
		})

		// `or` takes an Optional, `value(defaultingTo:)` a bare value. They are
		// two names because on a nested Optional `#Empty` would fit both.
		it("falls back to another Optional with or", async () => {
			expect(
				await run(`implementation {
					constant numbers = [3]
					constant none: List<Integer> = []

					Terminal.inspect(numbers::firstItem()::or(#Value(9)))
					Terminal.inspect(none::firstItem()::or(#Value(9)))
					Terminal.inspect(none::firstItem()::or(none::firstItem()))
					Terminal.inspect(none::firstItem()::or(#Value(1))::or(#Value(2)))
				}`),
			).toEqual([
				"Optional#Value(3)",
				"Optional#Value(9)",
				"Optional#Empty",
				"Optional#Value(1)",
			])
		})

		// The at-most-one case of `List::pair(with:)`. Essence has no tuple,
		// so the answer is a Record of `first` and `second`.
		it("pairs two Optionals, and answers empty when either is", async () => {
			expect(
				await run(`implementation {
					constant numbers = [3]
					constant words = ["a"]
					constant none: List<Integer> = []

					Terminal.inspect(numbers::firstItem()::pair(with words::firstItem()))
					Terminal.inspect(none::firstItem()::pair(with words::firstItem()))
					Terminal.inspect(numbers::firstItem()::pair(with none::firstItem()))
				}`),
			).toEqual([
				`Optional#Value({ first = 3, second = "a" })`,
				"Optional#Empty",
				"Optional#Empty",
			])
		})

		// The body builds a List literal, which names no Namespace, so
		// `Optional.es` need not import `List`.
		it("crosses to a List of at most one item", async () => {
			expect(
				await run(`implementation {
					constant numbers = [3]
					constant none: List<Integer> = []

					Terminal.inspect(numbers::firstItem()::toList())
					Terminal.inspect(none::firstItem()::toList())
					Terminal.inspect(numbers::firstItem()::toList()::length())
				}`),
			).toEqual(["[ 3 ]", "[]", "1"])
		})
	})

	// The combinators' laws, checked over every combination of `#Empty` and
	// two distinct values. Up to the payload, that is every `Optional<Integer>`.
	describe("Laws", () => {
		const domain = `constant candidates: List<Optional<Integer>> = [#Empty, #Value(1), #Value(2)]`

		it("makes or associative", async () => {
			expect(
				await run(`implementation {
					${domain}

					Terminal.inspect(candidates::hasOnlyItems(where (first) {
						<- candidates::hasOnlyItems(where (second) {
							<- candidates::hasOnlyItems(where (third) {
								<- first::or(second)::or(third)::is(first::or(second::or(third)))
							})
						})
					}))
				}`),
			).toEqual(["true"])
		})

		it("makes an empty Optional or's identity on both sides", async () => {
			expect(
				await run(`implementation {
					${domain}

					constant nothing: Optional<Integer> = #Empty

					Terminal.inspect(candidates::hasOnlyItems(where (candidate) {
						<- candidate::or(nothing)::is(candidate)::and(nothing::or(candidate)::is(candidate))
					}))
				}`),
			).toEqual(["true"])
		})

		// `or` answers the first value in the chain, so it is idempotent and
		// not commutative.
		it("makes or idempotent, and not commutative", async () => {
			expect(
				await run(`implementation {
					${domain}

					Terminal.inspect(candidates::hasOnlyItems(where (candidate) {
						<- candidate::or(candidate)::is(candidate)
					}))
					Terminal.inspect(candidates::hasOnlyItems(where (first) {
						<- candidates::hasOnlyItems(where (second) {
							<- first::or(second)::is(second::or(first))
						})
					}))
				}`),
			).toEqual(["true", "false"])
		})

		it("pairs exactly when both Optionals hold a value", async () => {
			expect(
				await run(`implementation {
					${domain}

					Terminal.inspect(candidates::hasOnlyItems(where (first) {
						<- candidates::hasOnlyItems(where (second) {
							<- first::pair(with second)::hasValue()::is(first::hasValue()::and(second::hasValue()))
						})
					}))
				}`),
			).toEqual(["true"])
		})

		// `toList` and the List's own `firstItem` are each other's inverse on
		// an Optional.
		it("crosses to a List and back with toList", async () => {
			expect(
				await run(`implementation {
					${domain}

					Terminal.inspect(candidates::hasOnlyItems(where (candidate) {
						<- candidate::toList()::firstItem()::is(candidate)
					}))
				}`),
			).toEqual(["true"])
		})

		it("asks hasValue(where:) what keep(where:) answers", async () => {
			expect(
				await run(`implementation {
					${domain}

					Terminal.inspect(candidates::hasOnlyItems(where (candidate) {
						<- candidate::hasValue(where (item) { <- item::isOdd() })
							::is(candidate::keep(where (item) { <- item::isOdd() })::hasValue())
					}))
				}`),
			).toEqual(["true"])
		})
	})

	// `allValues` answers every value or nothing, and `firstValue` tries the
	// Optionals in order. Each answers a different Type from `values`.
	describe("A List of Optionals", () => {
		const lists = [
			`constant rows: List<Optional<Integer>> = [#Value(1), #Empty, #Value(3)]`,
			`constant complete: List<Optional<Integer>> = [#Value(1), #Value(3)]`,
			`constant blanks: List<Optional<Integer>> = [#Empty, #Empty]`,
			`constant none: List<Optional<Integer>> = []`,
		].join("\n\t\t\t\t\t")

		it("drops the empties with values, and refuses them with allValues", async () => {
			expect(
				await run(`implementation {
					${lists}

					Terminal.inspect(rows::values())
					Terminal.inspect(rows::allValues())
					Terminal.inspect(complete::allValues())
					Terminal.inspect(blanks::allValues())
				}`),
			).toEqual([
				"[ 1, 3 ]",
				"Optional#Empty",
				"Optional#Value([ 1, 3 ])",
				"Optional#Empty",
			])
		})

		// The empty List holds no empty Optional, so `allValues` answers the
		// empty List, wrapped.
		it("answers the empty List wrapped, for the empty List", async () => {
			expect(
				await run(`implementation {
					${lists}

					Terminal.inspect(none::allValues())
					Terminal.inspect(none::firstValue())
				}`),
			).toEqual(["Optional#Value([])", "Optional#Empty"])
		})

		it("answers the first Optional holding a value", async () => {
			expect(
				await run(`implementation {
					${lists}

					constant late: List<Optional<Integer>> = [#Empty, #Value(7)]

					Terminal.inspect(rows::firstValue())
					Terminal.inspect(late::firstValue())
					Terminal.inspect(blanks::firstValue())
				}`),
			).toEqual([
				"Optional#Value(1)",
				"Optional#Value(7)",
				"Optional#Empty",
			])
		})

		// Every arrangement of up to three items, so an empty Optional stands
		// first, last, alone or nowhere. The laws are written on `values`, not on
		// the body's own question.
		const arrangements = `constant arrangements: List<List<Optional<Integer>>> = [
						[],
						[#Empty],
						[#Value(1)],
						[#Empty, #Empty],
						[#Empty, #Value(1)],
						[#Value(1), #Empty],
						[#Value(1), #Value(2)],
						[#Value(1), #Empty, #Value(2)],
						[#Empty, #Value(1), #Value(2)],
					]`

		it("answers every value exactly when no Optional is empty", async () => {
			expect(
				await run(`implementation {
					${arrangements}

					constant noValues: List<Integer> = []

					Terminal.inspect(arrangements::hasOnlyItems(where (items) {
						constant kept = items::values()

						if kept::length()::is(items::length()) {
							<- items::allValues()::value(defaultingTo noValues)::is(kept)
						} else {
							<- items::allValues()::isEmpty()
						}
					}))
				}`),
			).toEqual(["true"])
		})

		it("answers the first value values() would have kept", async () => {
			expect(
				await run(`implementation {
					${arrangements}

					Terminal.inspect(arrangements::hasOnlyItems(where (items) {
						<- items::firstValue()::is(items::values()::firstItem())
					}))
				}`),
			).toEqual(["true"])
		})
	})

	describe("Matching", () => {
		it("binds the payload, and a Guard can name it", async () => {
			// A Guard runs in the Handler's test, before the body's Constant
			// exists, so it reads the binding as `@.item`. See
			// `scopeLendingBindings`.
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
			// The Method meant is on the Namespace over both Cases, which
			// per-member dispatch does not search. The near miss is read off
			// the Union's own Namespaces.
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
			// The report names the receiver as written rather than an
			// `Optional#Value`, and the Parameter as `Rational` rather than
			// `ItemType`.
			let diagnostics = diagnosticsOf(`implementation {
				constant maybe: Optional<Rational> = #Empty

				Terminal.inspect(maybe::value(defaultingTo 0))
			}`)

			expect(diagnostics.map(({ code }) => code)).toEqual([
				"no-matching-overload",
			])
			expect(diagnostics[0]!.message).toBe(
				"No overload of 'value' accepts these Arguments",
			)
			expect(diagnostics[0]!.notes).toEqual([
				"'Optional::value' takes 1 Argument: Parameter 'defaultingTo' is Rational.",
			])
		})

		it("still names the member when no Namespace covers the receiver", () => {
			// Nothing covers `Integer | String`, so the report names the member
			// without the Method.
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
		// A bare `#Empty` resolves against the Choice the position asks for,
		// even where that is not the builtin `Optional`.
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
