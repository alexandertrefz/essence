import { describe, expect, it } from "bun:test"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { fixturePath } from "@essence/fixtures"

import { containsErrors } from "../diagnostics/index"
import { enrich } from "../enricher/index"
import { optimise } from "../optimiser/index"
import { parseWithDiagnostics } from "../parser/index"
import { rewrite } from "../rewriter/index"
import { simplify } from "../simplifier/index"
import { validate } from "../validator/index"

// NOTE: The full pipeline minus bundling, mirroring codeGeneration.spec — the
// `loop` family and the early-stopping `reduce` are only proven once every stage
// agrees on them AND the emitted JavaScript runs. In the loop and reduce blocks
// every `Step` is READ, by the native drivers; the final block compares them
// with `::is` instead, now that the derived Equatable for a generic Choice has
// merged and the builtin `Step` earns its equality across the stdlib boundary
// exactly like a Choice a Program declares for itself.
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
	let directory = mkdtempSync(join(tmpdir(), "essence-loop-"))
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

describe("loop", () => {
	it("sums 1 through 10 with the counted loop", async () => {
		expect(
			await run(`implementation {
				constant sum = loop(from 1, through 10, startingWith 0,
					step (index, total) { <- total::add(index) })

				__print(sum::toString())
			}`),
		).toEqual(['"55"'])
	})

	it("counts down when the counted loop's start is the greater", async () => {
		// NOTE: 3, then 2, then 1 — the same direction `List.of` counts, so the
		// appended digits read "321".
		expect(
			await run(`implementation {
				constant digits = loop(from 3, through 1, startingWith "",
					step (index, acc) { <- acc::append(index::toString()) })

				__print(digits)
			}`),
		).toEqual(['"321"'])
	})

	it("visits a single value when the counted loop's ends coincide", async () => {
		expect(
			await run(`implementation {
				constant once = loop(from 7, through 7, startingWith 0,
					step (index, total) { <- total::add(index) })

				__print(once::toString())
			}`),
		).toEqual(['"7"'])
	})

	it("steps while a condition holds", async () => {
		// NOTE: 1, 2, 4, 8, … the first power of two that is not below 100.
		expect(
			await run(`implementation {
				constant doubled = loop(startingWith 1,
					while (n) { <- n::isLessThan(100) },
					step (n) { <- n::multiply(with 2) })

				__print(doubled::toString())
			}`),
		).toEqual(['"128"'])
	})

	it("returns the seed when a while condition is false at once", async () => {
		expect(
			await run(`implementation {
				constant untouched = loop(startingWith 500,
					while (n) { <- n::isLessThan(100) },
					step (n) { <- n::multiply(with 2) })

				__print(untouched::toString())
			}`),
		).toEqual(['"500"'])
	})

	it("steps until a condition holds — the negation of while", async () => {
		expect(
			await run(`implementation {
				constant doubled = loop(startingWith 1,
					until (n) { <- n::isGreaterThanOrEqualTo(100) },
					step (n) { <- n::multiply(with 2) })

				__print(doubled::toString())
			}`),
		).toEqual(['"128"'])
	})

	it("returns the seed when an until condition is true at once", async () => {
		expect(
			await run(`implementation {
				constant untouched = loop(startingWith 500,
					until (n) { <- n::isGreaterThanOrEqualTo(100) },
					step (n) { <- n::multiply(with 2) })

				__print(untouched::toString())
			}`),
		).toEqual(['"500"'])
	})

	it("finishes the general loop on the first #Done, threading a Record State", async () => {
		// NOTE: A Record State threaded with `{ state with … }`, stopping with
		// the single-payload `#Done(state.total)` shorthand rather than the full
		// `#Done({ value = … })`. Sums 1 through 5 = 15.
		expect(
			await run(`implementation {
				constant total = loop(startingWith { index = 1, total = 0 },
					step (state) {
						if state.index::isGreaterThan(5) { <- #Done(state.total) }

						<- #Continue({ state with
							index = state.index::add(1),
							total = state.total::add(state.index),
						})
					})

				__print(total::toString())
			}`),
		).toEqual(['"15"'])
	})

	it("finishes the general loop with a Result of a different Type than the State", async () => {
		// NOTE: The State is an Integer counter, the Result a String — the
		// general loop's two Type Parameters are independent.
		expect(
			await run(`implementation {
				constant word = loop(startingWith 0,
					step (count) {
						if count::isGreaterThanOrEqualTo(3) { <- #Done("done") }

						<- #Continue(count::add(1))
					})

				__print(word)
			}`),
		).toEqual(['"done"'])
	})

	// NOTE: A general loop inside another general loop's `step`, each finishing
	// with a Result of its own Type — the inner one with the Integer it counted
	// to, the outer one with a String. `<-` returns from the callback it is
	// written in, so each `#Done` belongs to its own loop, and the inner Result
	// has to survive being read where the outer one is expected: the inner walk
	// is compared as the Integer it is before the outer one stops on it.
	it("nests a general loop inside another general loop's step", async () => {
		expect(
			await run(`implementation {
				constant word = loop(startingWith 0,
					step (outer) {
						constant doubled = loop(startingWith outer,
							step (current) {
								if current::isGreaterThanOrEqualTo(outer::add(2)) {
									<- #Done(current)
								}

								<- #Continue(current::add(1))
							})

						if doubled::isGreaterThanOrEqualTo(6) { <- #Done("done") }

						<- #Continue(doubled)
					})

				__print(word)
			}`),
		).toEqual(['"done"'])
	})

	// NOTE: The callback writes its return Type here, where the bare-sigil
	// version above leaves it out. A Choice's Type Parameters are applied, never
	// inferred: the bare `#Done` is read off whatever the position expects and,
	// where nothing expects anything, off the body — but the PREFIXED spelling
	// asks for a decision, and an unannotated callback has none to give.
	it("uses the prefixed #Continue / #Done spelling in the general loop", async () => {
		expect(
			await run(`implementation {
				constant total = loop(startingWith { index = 1, total = 0 },
					step (state) -> Step<{ index: Integer, total: Integer }, Integer> {
						if state.index::isGreaterThan(3) { <- Step#Done(state.total) }

						<- Step#Continue({ state = { index = state.index::add(1), total = state.total::add(state.index) } })
					})

				__print(total::toString())
			}`),
		).toEqual(['"6"'])
	})

	// NOTE: The two spellings of the one walk, run side by side. A bare
	// construction whose payload leaves one of its Choice's Type Parameters
	// standing is refused now, and this is the shape that must never be caught by
	// that: `#Done("done")` names `Result` and says nothing about `State`, so
	// what decides `State` is the position — read a SECOND time, once the call
	// has committed and its bindings are final. The annotated twin decides the
	// same thing at the callback's own `->`, and the two walks agree, value for
	// value.
	it("agrees with itself whether the callback writes its return Type or not", async () => {
		let walk = (returnType: string, sigil: string): string =>
			`implementation {
				constant word = loop(startingWith 0, step (count)${returnType} {
					if count::isGreaterThanOrEqualTo(3) { <- ${sigil}#Done("done") }

					<- ${sigil}#Continue(count::add(1))
				})

				__print(word)
			}`

		expect(await run(walk("", ""))).toEqual(['"done"'])
		expect(
			await run(
				walk(" -> Step<Integer, String>", "Step<Integer, String>"),
			),
		).toEqual(['"done"'])
	})
})

describe("reduce(startingWith:step:)", () => {
	it("folds every item when the combiner always continues", async () => {
		expect(
			await run(`implementation {
				constant sum = [1, 2, 3, 4]::reduce(startingWith 0,
					step (total, item) { <- #Continue(total::add(item)) })

				__print(sum::toString())
			}`),
		).toEqual(['"10"'])
	})

	it("stops the fold on the first #Done and visits no later item", async () => {
		// NOTE: The accumulator counts the items the combiner has seen. It stops
		// itself at two, so the Result is 2 rather than the five it would reach
		// folding the whole List — proof no item past the #Done was visited.
		expect(
			await run(`implementation {
				constant seen = [1, 2, 3, 4, 5]::reduce(startingWith 0,
					step (count, item) {
						constant next = count::add(1)

						if next::isGreaterThanOrEqualTo(2) { <- #Done(next) }

						<- #Continue(next)
					})

				__print(seen::toString())
			}`),
		).toEqual(['"2"'])
	})

	it("returns the starting value for the empty List", async () => {
		expect(
			await run(`implementation {
				constant noNumbers: List<Integer> = []
				constant sum = noNumbers::reduce(startingWith 42,
					step (total, item) { <- #Continue(total::add(item)) })

				__print(sum::toString())
			}`),
		).toEqual(['"42"'])
	})
})

// NOTE: The untested combination once WP4 and WP6 both merged — the builtin,
// generic `Step` compared with its DERIVED Equatable. Every value here is a
// `Step<State, Result>` instantiation, and every comparison routes through the
// widened `boundChoiceIs` descriptor computed for a GenericAlias that lives in
// the stdlib scope rather than the Program's — the one thing neither slice
// could prove alone, since WP6 deliberately never wrote `::is` on a `Step`.
describe("a Step compares by its derived Equality", () => {
	it("holds two #Done payloads equal, and a #Done apart from a #Continue", async () => {
		expect(
			await run(`implementation {
				constant a: Step<Integer, Integer> = #Done(5)
				constant b: Step<Integer, Integer> = #Done(5)
				constant c: Step<Integer, Integer> = #Done(6)
				constant going: Step<Integer, Integer> = #Continue(5)

				__print(a::is(b)::toString())
				__print(a::is(c)::toString())
				__print(a::is(going)::toString())
				__print(a::isNot(going)::toString())
			}`),
		).toEqual(['"true"', '"false"', '"false"', '"true"'])
	})

	it("compares a #Continue that threads a Record State member by member", async () => {
		expect(
			await run(`implementation {
				constant here: Step<{ index: Integer, total: Integer }, Integer> =
					#Continue({ index = 1, total = 0 })
				constant same: Step<{ index: Integer, total: Integer }, Integer> =
					#Continue({ index = 1, total = 0 })
				constant moved: Step<{ index: Integer, total: Integer }, Integer> =
					#Continue({ index = 2, total = 0 })
				constant stopped: Step<{ index: Integer, total: Integer }, Integer> = #Done(9)

				__print(here::is(same)::toString())
				__print(here::is(moved)::toString())
				__print(here::is(stopped)::toString())
			}`),
		).toEqual(['"true"', '"false"', '"false"'])
	})

	it("satisfies an Equatable bound, so a List of Steps can be searched", async () => {
		expect(
			await run(`implementation {
				constant steps: List<Step<Integer, Integer>> = [#Continue(1), #Done(2)]

				__print(steps::contains(#Done(2))::toString())
				__print(steps::contains(#Done(9))::toString())
				__print(steps::contains(#Continue(1))::toString())
			}`),
		).toEqual(['"true"', '"false"', '"true"'])
	})

	// NOTE: The point of routing a generic payload through a witness rather than
	// the flat structural comparison — `1/2` and `2/4` are equal by Rational's
	// own `is`, and only the Rational witness threaded into `Step`'s descriptor
	// carries that across the stdlib boundary.
	it("compares a Rational payload by its own equality, not by structure", async () => {
		expect(
			await run(`implementation {
				constant half: Step<Integer, Rational> = #Done(1/2)
				constant twoQuarters: Step<Integer, Rational> = #Done(2/4)

				__print(half::is(twoQuarters)::toString())
				__print(half::isNot(twoQuarters)::toString())
			}`),
		).toEqual(['"true"', '"false"'])
	})
})

describe("Loops.es", () => {
	it("compiles and runs the loop showcase end to end", async () => {
		let source = readFileSync(fixturePath("Loops.es"), {
			encoding: "utf-8",
		})

		expect(await run(source)).toEqual([
			'"55"',
			'"15"',
			'"128"',
			'"128"',
			'"2"',
		])
	})
})
