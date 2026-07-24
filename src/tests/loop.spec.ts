import { describe, expect, it } from "bun:test"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { containsErrors } from "../diagnostics/index"
import { enrich } from "../enricher/index"
import { optimise } from "../optimiser/index"
import { parseWithDiagnostics } from "../parser/index"
import { rewrite } from "../rewriter/index"
import { simplify } from "../simplifier/index"
import { validate } from "../validator/index"

// NOTE: The full pipeline minus bundling, mirroring codeGeneration.spec — the
// `loop` family and the early-stopping `reduce` are only proven once every stage
// agrees on them AND the emitted JavaScript runs. Every `Step` here is READ, by
// the native drivers, and never compared with `::is`: the derived Equatable for
// a generic Choice is a separate slice, so a `Step` has no equality yet.
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

	it("uses the prefixed #Continue / #Done spelling in the general loop", async () => {
		expect(
			await run(`implementation {
				constant total = loop(startingWith { index = 1, total = 0 },
					step (state) {
						if state.index::isGreaterThan(3) { <- Step#Done(state.total) }

						<- Step#Continue({ state = { index = state.index::add(1), total = state.total::add(state.index) } })
					})

				__print(total::toString())
			}`),
		).toEqual(['"6"'])
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

describe("testFiles/Loops.es", () => {
	it("compiles and runs the loop showcase end to end", async () => {
		let source = readFileSync(
			join(import.meta.dir, "../..", "testFiles/Loops.es"),
			{ encoding: "utf-8" },
		)

		expect(await run(source)).toEqual([
			'"55"',
			'"15"',
			'"128"',
			'"128"',
			'"2"',
		])
	})
})
