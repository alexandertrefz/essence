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

// NOTE: `Result` is `Optional` with a reason attached — `#Value(item)` or
// `#Failure(reason)` — and what the second Case buys is not visible in a Type
// error: it is visible when a Program RUNS. So every claim here compiles AND
// executes, exactly as `optional.spec.ts` does for the carrier this one
// mirrors.
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
	let directory = mkdtempSync(join(tmpdir(), "essence-result-"))
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

// NOTE: Both Cases carry a payload, so a receiver is declared rather than
// written bare: a `#Value(3)` on its own decides the value Type and says
// nothing about the failure Type.
const CARRIERS = `constant fine: Result<Integer, String>  = #Value(3)
					constant wrong: Result<Integer, String> = #Failure("gone")`

describe("Result", () => {
	describe("Conformance", () => {
		it("prints each Case through its own payload's toString", async () => {
			expect(
				await run(`implementation {
					${CARRIERS}

					constant text: Result<String, String> = #Value("a")

					Terminal.inspect(fine::toString())
					Terminal.inspect(wrong::toString())
					Terminal.inspect(text::toString())
					Terminal.inspect("{fine}")
				}`),
			).toEqual([
				`"Value(3)"`,
				`"Failure(\\"gone\\")"`,
				`"Value(\\"a\\")"`,
				`"Value(3)"`,
			])
		})

		it("compares whole Results through both payloads' own is", async () => {
			expect(
				await run(`implementation {
					${CARRIERS}

					Terminal.inspect(fine::is(#Value(3)))
					Terminal.inspect(fine::is(#Value(1)))
					Terminal.inspect(fine::is(#Failure("gone")))
					Terminal.inspect(wrong::is(#Failure("gone")))
					Terminal.inspect(wrong::is(#Failure("other")))
					Terminal.inspect(fine::isNot(wrong))
				}`),
			).toEqual(["true", "false", "false", "true", "false", "true"])
		})

		// NOTE: The second entry of `is`, and the reason it takes the VALUE
		// rather than the reason: one Expression then tests an answer. A failed
		// Result is never a bare value, whatever the value is.
		it("compares against a bare value, which a failure never is", async () => {
			expect(
				await run(`implementation {
					${CARRIERS}

					constant sameKind: Result<String, String> = #Failure("gone")

					Terminal.inspect(fine::is(3))
					Terminal.inspect(fine::is(1))
					Terminal.inspect(wrong::is(3))
					Terminal.inspect(fine::isNot(1))
					Terminal.inspect(wrong::isNot(3))
					Terminal.inspect(sameKind::is("gone"))
				}`),
			).toEqual(["true", "false", "false", "true", "true", "false"])
		})

		// NOTE: The outer-question caveat `Optional::is` carries, one Type
		// along: the whole-Result entry is declared first, so an Argument that
		// fits both readings asks about the RECEIVER.
		it("reads a Result of Results at the outer level first", async () => {
			expect(
				await run(`implementation {
					constant nested: Result<Result<Integer, String>, String> = #Value(#Value(3))
					constant outer: Result<Result<Integer, String>, String>  = #Failure("outer")

					Terminal.inspect(nested::is(#Value(#Value(3))))
					Terminal.inspect(outer::is(#Failure("outer")))
					Terminal.inspect(nested::is(#Failure("outer")))
				}`),
			).toEqual(["true", "true", "false"])
		})

		it("is searchable by value in a List", async () => {
			expect(
				await run(`implementation {
					constant rows: List<Result<Integer, String>> = [
						#Failure("gone"),
						#Value(7),
					]

					Terminal.inspect(rows::firstIndex(of #Value(7)))
					Terminal.inspect(rows::contains(#Failure("gone")))
					Terminal.inspect(rows::contains(#Value(9)))
				}`),
			).toEqual(["Optional#Value(1)", "true", "false"])
		})
	})

	describe("The Namespace", () => {
		it("answers hasValue and hasFailed without a Match", async () => {
			expect(
				await run(`implementation {
					${CARRIERS}

					Terminal.inspect(fine::hasValue())
					Terminal.inspect(fine::hasFailed())
					Terminal.inspect(wrong::hasValue())
					Terminal.inspect(wrong::hasFailed())
				}`),
			).toEqual(["true", "false", "false", "true"])
		})

		// NOTE: The quantified entry, which answers `false` on a failure
		// without running the check — the same rule `Optional::hasValue(where:)`
		// keeps for the Case that holds nothing.
		it("asks a question of the value, and answers false without one", async () => {
			expect(
				await run(`implementation {
					${CARRIERS}

					Terminal.inspect(fine::hasValue(where (item) { <- item::isOdd() }))
					Terminal.inspect(fine::hasValue(where (item) { <- item::isEven() }))
					Terminal.inspect(wrong::hasValue(where (item) { <- item::isOdd() }))
				}`),
			).toEqual(["true", "false", "false"])
		})

		it("reads either Case out as an Optional", async () => {
			expect(
				await run(`implementation {
					${CARRIERS}

					Terminal.inspect(fine::value())
					Terminal.inspect(wrong::value())
					Terminal.inspect(fine::reason())
					Terminal.inspect(wrong::reason())
				}`),
			).toEqual([
				"Optional#Value(3)",
				"Optional#Empty",
				"Optional#Empty",
				`Optional#Value("gone")`,
			])
		})

		it("collapses to a bare value with value(defaultingTo:)", async () => {
			expect(
				await run(`implementation {
					${CARRIERS}

					Terminal.inspect(fine::value(defaultingTo 0))
					Terminal.inspect(wrong::value(defaultingTo 0))
				}`),
			).toEqual(["3", "0"])
		})

		it("maps the value and carries the reason through", async () => {
			expect(
				await run(`implementation {
					${CARRIERS}

					Terminal.inspect(fine::map((item) { <- item::multiply(with 10) }))
					Terminal.inspect(wrong::map((item) { <- item::multiply(with 10) }))
				}`),
			).toEqual(["Result#Value(30)", `Result#Failure("gone")`])
		})

		// NOTE: The other direction, and the reason the Method is
		// `mapFailure` rather than `mapError`: the Case is `#Failure`, and this
		// language has no errors to name.
		it("maps the reason and carries the value through", async () => {
			expect(
				await run(`implementation {
					${CARRIERS}

					Terminal.inspect(wrong::mapFailure((reason) { <- reason::length() }))
					Terminal.inspect(fine::mapFailure((reason) { <- reason::length() }))
				}`),
			).toEqual(["Result#Failure(4)", "Result#Value(3)"])
		})

		// NOTE: The step is written INLINE at each call rather than bound to a
		// Constant above them. A Method Generic that appears only in the
		// callback's return Type is solved from a Function literal and not
		// from a Function value, on `Optional::andThen` exactly as here, so a
		// named step reads as `no-matching-overload`.
		it("chains with andThen without nesting the answer", async () => {
			const step = `(item) -> Result<Integer, String> {
							if item::isOdd() {
								<- #Value(item::add(1))
							} else {
								<- #Failure("even")
							}
						}`

			expect(
				await run(`implementation {
					${CARRIERS}

					Terminal.inspect(fine::andThen(${step}))
					Terminal.inspect(wrong::andThen(${step}))
					Terminal.inspect(fine::andThen(${step})::andThen(${step}))
				}`),
			).toEqual([
				"Result#Value(4)",
				`Result#Failure("gone")`,
				`Result#Failure("even")`,
			])
		})

		// NOTE: `recover` is the one Method here that answers a BARE value off
		// a failure, which is what a caller holding a reason it can repair
		// wants. The value Case never runs the transform.
		it("recovers a bare value out of the reason", async () => {
			expect(
				await run(`implementation {
					${CARRIERS}

					Terminal.inspect(wrong::recover(with (reason) { <- reason::length() }))
					Terminal.inspect(fine::recover(with (reason) { <- reason::length() }))
				}`),
			).toEqual(["4", "3"])
		})

		// NOTE: The `keep` an Optional has, with the second Argument a Result
		// needs: refusing a value here has to say why.
		it("keeps a value that passes, and fails with the given reason", async () => {
			expect(
				await run(`implementation {
					${CARRIERS}

					Terminal.inspect(fine::keep(where (item) { <- item::isOdd() }, failingWith "even"))
					Terminal.inspect(fine::keep(where (item) { <- item::isEven() }, failingWith "odd"))
					Terminal.inspect(wrong::keep(where (item) { <- item::isOdd() }, failingWith "even"))
				}`),
			).toEqual([
				"Result#Value(3)",
				`Result#Failure("odd")`,
				`Result#Failure("gone")`,
			])
		})

		it("falls back to another Result with or", async () => {
			expect(
				await run(`implementation {
					${CARRIERS}

					constant other: Result<Integer, String> = #Failure("other")

					Terminal.inspect(fine::or(wrong))
					Terminal.inspect(wrong::or(fine))
					Terminal.inspect(wrong::or(other))
				}`),
			).toEqual([
				"Result#Value(3)",
				"Result#Value(3)",
				`Result#Failure("other")`,
			])
		})

		it("crosses to a List of at most one item", async () => {
			expect(
				await run(`implementation {
					${CARRIERS}

					Terminal.inspect(fine::toList())
					Terminal.inspect(wrong::toList())
					Terminal.inspect(fine::toList()::length())
				}`),
			).toEqual(["[ 3 ]", "[]", "1"])
		})

		it("collapses one level with flatten, and only one", async () => {
			expect(
				await run(`implementation {
					constant nested: Result<Result<Integer, String>, String> = #Value(#Value(3))
					constant inner: Result<Result<Integer, String>, String>  = #Value(#Failure("inner"))
					constant outer: Result<Result<Integer, String>, String>  = #Failure("outer")

					Terminal.inspect(nested::flatten())
					Terminal.inspect(inner::flatten())
					Terminal.inspect(outer::flatten())
				}`),
			).toEqual([
				"Result#Value(3)",
				`Result#Failure("inner")`,
				`Result#Failure("outer")`,
			])
		})
	})

	// NOTE: The bridge each way. `Optional::toResult` supplies the reason an
	// Optional never had, and `Result::value()` drops it again — which is the
	// pair of signatures that makes `Optional.es` and `Result.es` name each
	// other, and the second cycle the standard library's graph allows.
	describe("Crossing from an Optional", () => {
		it("supplies the reason an Optional never had", async () => {
			expect(
				await run(`implementation {
					constant numbers = [3]
					constant none: List<Integer> = []

					Terminal.inspect(numbers::firstItem()::toResult(failingWith "no items"))
					Terminal.inspect(none::firstItem()::toResult(failingWith "no items"))
				}`),
			).toEqual(["Result#Value(3)", `Result#Failure("no items")`])
		})

		it("crosses back through value, and drops the reason", async () => {
			expect(
				await run(`implementation {
					constant candidates: List<Optional<Integer>> = [#Empty, #Value(1), #Value(2)]

					Terminal.inspect(candidates::hasOnlyItems(where (candidate) {
						<- candidate::toResult(failingWith "gone")::value()::is(candidate)
					}))
				}`),
			).toEqual(["true"])
		})
	})

	// NOTE: The laws, checked over every combination of a small domain rather
	// than over sampled ones — two values and two reasons is the whole of what
	// a `Result<Integer, String>` can be up to the payloads, so an exhaustive
	// answer is available and is stronger than a sampled one.
	describe("Laws", () => {
		const domain = `constant candidates: List<Result<Integer, String>> = [
						#Value(1),
						#Value(2),
						#Failure("a"),
						#Failure("b"),
					]`

		it("leaves a Result alone when map is handed the value itself", async () => {
			expect(
				await run(`implementation {
					${domain}

					Terminal.inspect(candidates::hasOnlyItems(where (candidate) {
						<- candidate::map((item) { <- item })::is(candidate)
					}))
				}`),
			).toEqual(["true"])
		})

		// NOTE: The composition law, which is what says `map` is about the
		// value alone: mapping twice is mapping once with the two transforms
		// composed, on both Cases.
		it("composes two maps into one", async () => {
			expect(
				await run(`implementation {
					${domain}

					Terminal.inspect(candidates::hasOnlyItems(where (candidate) {
						<- candidate
							::map((item) { <- item::add(1) })
							::map((item) { <- item::multiply(with 2) })
							::is(candidate::map((item) { <- item::add(1)::multiply(with 2) }))
					}))
				}`),
			).toEqual(["true"])
		})

		it("leaves a Result alone when mapFailure is handed the reason itself", async () => {
			expect(
				await run(`implementation {
					${domain}

					Terminal.inspect(candidates::hasOnlyItems(where (candidate) {
						<- candidate::mapFailure((reason) { <- reason })::is(candidate)
					}))
				}`),
			).toEqual(["true"])
		})

		// NOTE: The two steps are free Functions, and each call writes the
		// literal that forwards to one — a Method Generic appearing only in
		// the callback's return Type is solved from a Function literal and not
		// from a Function value.
		const steps = `function first(_ item: Integer) -> Result<Integer, String> {
						<- #Value(item::add(1))
					}

					function second(_ item: Integer) -> Result<Integer, String> {
						if item::isEven() {
							<- #Value(item)
						} else {
							<- #Failure("odd")
						}
					}`

		it("makes andThen associative", async () => {
			expect(
				await run(`implementation {
					${domain}

					${steps}

					Terminal.inspect(candidates::hasOnlyItems(where (candidate) {
						<- candidate
							::andThen((item) -> Result<Integer, String> { <- first(item) })
							::andThen((item) -> Result<Integer, String> { <- second(item) })
							::is(candidate::andThen((item) -> Result<Integer, String> {
								<- first(item)::andThen((next) -> Result<Integer, String> {
									<- second(next)
								})
							}))
					}))
				}`),
			).toEqual(["true"])
		})

		it("makes a value andThen's identity on both sides", async () => {
			expect(
				await run(`implementation {
					${domain}

					function wrap(_ item: Integer) -> Result<Integer, String> {
						<- #Value(item)
					}

					Terminal.inspect(candidates::hasOnlyItems(where (candidate) {
						<- candidate
							::andThen((item) -> Result<Integer, String> { <- wrap(item) })
							::is(candidate)
					}))
					Terminal.inspect([1, 2]::hasOnlyItems(where (item) {
						<- wrap(item)
							::andThen((next) -> Result<Integer, String> { <- wrap(next) })
							::is(wrap(item))
					}))
				}`),
			).toEqual(["true", "true"])
		})

		it("makes or associative, idempotent, and not commutative", async () => {
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
					Terminal.inspect(candidates::hasOnlyItems(where (candidate) {
						<- candidate::or(candidate)::is(candidate)
					}))
					Terminal.inspect(candidates::hasOnlyItems(where (first) {
						<- candidates::hasOnlyItems(where (second) {
							<- first::or(second)::is(second::or(first))
						})
					}))
				}`),
			).toEqual(["true", "true", "false"])
		})

		it("asks hasValue(where:) what keep answers", async () => {
			expect(
				await run(`implementation {
					${domain}

					Terminal.inspect(candidates::hasOnlyItems(where (candidate) {
						<- candidate::hasValue(where (item) { <- item::isOdd() })
							::is(candidate
								::keep(where (item) { <- item::isOdd() }, failingWith "even")
								::hasValue())
					}))
				}`),
			).toEqual(["true"])
		})

		// NOTE: The round trip. `toList` and the List's own `firstItem` are
		// each other's inverse on the value, which is what makes `toList` a
		// bridge rather than a lossy rendering.
		it("crosses to a List and back with toList", async () => {
			expect(
				await run(`implementation {
					${domain}

					Terminal.inspect(candidates::hasOnlyItems(where (candidate) {
						<- candidate::toList()::firstItem()::is(candidate::value())
					}))
				}`),
			).toEqual(["true"])
		})
	})

	// NOTE: The Namespace a List of Results reaches, which is the half the
	// corpus actually needed: the quote-server checks a List of lines and
	// wants every reason, not the first one.
	describe("A List of Results", () => {
		const lists = [
			`constant rows: List<Result<Integer, String>> = [#Value(1), #Failure("a"), #Value(3), #Failure("b")]`,
			`constant complete: List<Result<Integer, String>> = [#Value(1), #Value(3)]`,
			`constant broken: List<Result<Integer, String>> = [#Failure("a"), #Failure("b")]`,
			`constant none: List<Result<Integer, String>> = []`,
		].join("\n\t\t\t\t\t")

		it("reads the two Cases apart, in order", async () => {
			expect(
				await run(`implementation {
					${lists}

					Terminal.inspect(rows::values())
					Terminal.inspect(rows::reasons())
					Terminal.inspect(rows::partition())
					Terminal.inspect(none::partition())
				}`),
			).toEqual([
				"[ 1, 3 ]",
				`[ "a", "b" ]`,
				`{ values = [ 1, 3 ], reasons = [ "a", "b" ] }`,
				"{ values = [], reasons = [] }",
			])
		})

		// NOTE: THE decision this Namespace exists for. A single failure
		// decides the answer, and every reason is kept — applicative
		// validation, not a short circuit.
		it("accumulates every reason with allValues", async () => {
			expect(
				await run(`implementation {
					${lists}

					Terminal.inspect(complete::allValues())
					Terminal.inspect(rows::allValues())
					Terminal.inspect(broken::allValues())
				}`),
			).toEqual([
				"Result#Value([ 1, 3 ])",
				`Result#Failure([ "a", "b" ])`,
				`Result#Failure([ "a", "b" ])`,
			])
		})

		// NOTE: The empty List has no failed Result in it, so every value it
		// holds is present and the answer is a value: the empty List, wrapped.
		// A failure there would name a reason nothing gave.
		it("answers the empty List wrapped, for the empty List", async () => {
			expect(
				await run(`implementation {
					${lists}

					Terminal.inspect(none::allValues())
					Terminal.inspect(none::values())
					Terminal.inspect(none::reasons())
				}`),
			).toEqual(["Result#Value([])", "[]", "[]"])
		})

		// NOTE: The `NonEmptyList` the answer promises is spent at the use
		// site: the reasons come back with the proof, so `firstItem()` answers
		// an item rather than an Optional. This is the spelling the `§§` block
		// on `allValues` names for a caller that wants only the first.
		it("answers the reasons with the proof that there is one", async () => {
			expect(
				await run(`implementation {
					${lists}

					Terminal.inspect(rows::allValues()::reason()::map((reasons) {
						<- reasons::firstItem()
					}))
					Terminal.inspect(complete::allValues()::reason()::map((reasons) {
						<- reasons::firstItem()
					}))
				}`),
			).toEqual([`Optional#Value("a")`, "Optional#Empty"])
		})

		// NOTE: Both laws are checked over every arrangement of up to three
		// items, which is where a failure can stand first, last, alone or not
		// at all. They are written on `values` and `reasons` rather than on
		// the body's own question, so a body rewritten another way is still
		// held to them.
		const arrangements = `constant arrangements: List<List<Result<Integer, String>>> = [
						[],
						[#Failure("a")],
						[#Value(1)],
						[#Failure("a"), #Failure("b")],
						[#Failure("a"), #Value(1)],
						[#Value(1), #Failure("a")],
						[#Value(1), #Value(2)],
						[#Value(1), #Failure("a"), #Value(2)],
						[#Failure("a"), #Value(1), #Value(2)],
					]`

		it("answers every value exactly when nothing failed", async () => {
			expect(
				await run(`implementation {
					${arrangements}

					constant noValues: List<Integer> = []

					Terminal.inspect(arrangements::hasOnlyItems(where (items) {
						constant kept = items::values()

						if kept::length()::is(items::length()) {
							<- items::allValues()::value(defaultingTo noValues)::is(kept)
						} else {
							<- items::allValues()::hasFailed()
						}
					}))
				}`),
			).toEqual(["true"])
		})

		it("answers every reason reasons() found, in the same order", async () => {
			expect(
				await run(`implementation {
					${arrangements}

					constant noReasons: List<String> = []

					Terminal.inspect(arrangements::hasOnlyItems(where (items) {
						<- items::allValues()
							::reason()
							::map((reasons) -> List<String> { <- reasons })
							::value(defaultingTo noReasons)
							::is(items::reasons())
					}))
				}`),
			).toEqual(["true"])
		})

		// NOTE: The two halves cover the receiver exactly once, which is what
		// separates `partition` from two unrelated walks.
		it("splits every item into exactly one half", async () => {
			expect(
				await run(`implementation {
					${arrangements}

					Terminal.inspect(arrangements::hasOnlyItems(where (items) {
						constant halves = items::partition()

						<- halves.values
							::length()
							::add(halves.reasons::length())
							::is(items::length())
					}))
				}`),
			).toEqual(["true"])
		})
	})

	describe("Matching", () => {
		it("binds either payload, and a Guard can name it", async () => {
			expect(
				await run(`implementation {
					${CARRIERS}

					Terminal.inspect(match wrong -> String {
						case #Value(item) where item::isOdd() { <- "odd {item}" }
						case #Value(item)                     { <- "even {item}" }
						case #Failure(reason)                 { <- "failed: {reason}" }
					})
				}`),
			).toEqual([`"failed: gone"`])
		})

		it("is exhaustive over the two Cases and nothing more", () => {
			expect(
				diagnosticsOf(`implementation {
					constant fine: Result<Integer, String> = #Value(3)

					Terminal.inspect(match fine -> Integer {
						case #Value(item) { <- item }
					})
				}`).map(({ code }) => code),
			).toContain("missing-case")
		})

		// NOTE: `#Value` is declared by two builtin Choices now, so a position
		// that decides neither is `ambiguous-case` rather than a silent choice
		// of whichever the Compiler met first. Both Choices are named in the
		// Diagnostic's helps, which is what makes it actionable.
		it("refuses a bare #Value that nothing decides", () => {
			let diagnostics = diagnosticsOf(`implementation {
				constant carried = #Value(3)
			}`)

			expect(diagnostics.map(({ code }) => code)).toContain(
				"ambiguous-case",
			)
			expect(diagnostics.flatMap(({ helps }) => helps)).toContain(
				"Write 'Result#Value' to pick 'Result'.",
			)
		})

		// NOTE: The other half of that rule: a position that DOES decide is
		// decided, and a bare `#Value` there resolves against the Choice the
		// position asked for.
		it("takes the Choice the position names", async () => {
			expect(
				await run(`implementation {
					constant carried: Result<Integer, String> = #Value(3)
					constant held: Optional<Integer>          = #Value(3)

					Terminal.inspect(carried)
					Terminal.inspect(held)
				}`),
			).toEqual(["Result#Value(3)", "Optional#Value(3)"])
		})
	})
})
