import { describe, expect, it } from "bun:test"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { fixturePath } from "@essence-lang/fixtures"

import { containsErrors } from "../diagnostics/index"
import { enrich } from "../enricher/index"
import { optimise } from "../optimiser/index"
import { parseWithDiagnostics } from "../parser/index"
import { rewrite } from "../rewriter/index"
import { simplify } from "../simplifier/index"
import { validate } from "../validator/index"

// The full pipeline minus bundling, and the emitted JavaScript runs.
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

	// Both outputs into one buffer in writing order: `Terminal.inspect` goes
	// through `console.log`, and `Terminal.print` writes to the stream.
	let written = ""
	let originalLog = console.log
	let originalOut = process.stdout.write

	console.log = (...args: Array<unknown>) => {
		written += `${args.map((argument) => String(argument)).join(" ")}\n`
	}

	process.stdout.write = ((chunk: unknown) => {
		written += String(chunk)

		return true
	}) as typeof process.stdout.write

	try {
		await import(file)
	} finally {
		console.log = originalLog
		process.stdout.write = originalOut
		rmSync(directory, { recursive: true, force: true })
	}

	return written === "" ? [] : written.replace(/\n$/, "").split("\n")
}

describe("loop", () => {
	it("sums 1 through 10 with the counted loop", async () => {
		expect(
			await run(`implementation {
				constant sum = loop(from 1, through 10, startingWith 0,
					(index, total) { <- total::add(index) })

				Terminal.inspect(sum::toString())
			}`),
		).toEqual(['"55"'])
	})

	it("answers the seed when the counted loop's end is below its start", async () => {
		// `through` only counts up, as in `List.of`, so this body never runs.
		expect(
			await run(`implementation {
				constant untouched = loop(from 10, through 1, startingWith 42,
					(index, total) { <- total::add(index) })

				Terminal.inspect(untouched::toString())
			}`),
		).toEqual(['"42"'])
	})

	it("counts down through the end the downTo entry names", async () => {
		// 3, then 2, then 1, as `List.of(downTo:)` counts.
		expect(
			await run(`implementation {
				constant digits = loop(from 3, downTo 1, startingWith "",
					(index, acc) { <- acc::append(index::toString()) })

				Terminal.inspect(digits)
			}`),
		).toEqual(['"321"'])
	})

	it("always takes the first turn of a down count", async () => {
		// The first Integer is always seen, as `List.of(integersFrom:downTo:)`
		// promises in its Type.
		expect(
			await run(`implementation {
				constant digits = loop(from 3, downTo 9, startingWith "",
					(index, acc) { <- acc::append(index::toString()) })

				Terminal.inspect(digits)
			}`),
		).toEqual(['"3"'])
	})

	it("visits a single value when the counted loop's ends coincide", async () => {
		expect(
			await run(`implementation {
				constant once = loop(from 7, through 7, startingWith 0,
					(index, total) { <- total::add(index) })

				Terminal.inspect(once::toString())
			}`),
		).toEqual(['"7"'])
	})

	it("steps while a condition holds", async () => {
		// The first power of two that is not below 100.
		expect(
			await run(`implementation {
				constant doubled = loop(startingWith 1,
					while (n) { <- n::isLessThan(100) },
					(n) { <- n::multiply(with 2) })

				Terminal.inspect(doubled::toString())
			}`),
		).toEqual(['"128"'])
	})

	it("returns the seed when a while condition is false at once", async () => {
		expect(
			await run(`implementation {
				constant untouched = loop(startingWith 500,
					while (n) { <- n::isLessThan(100) },
					(n) { <- n::multiply(with 2) })

				Terminal.inspect(untouched::toString())
			}`),
		).toEqual(['"500"'])
	})

	it("steps until a condition holds — the negation of while", async () => {
		expect(
			await run(`implementation {
				constant doubled = loop(startingWith 1,
					until (n) { <- n::isGreaterThanOrEqualTo(100) },
					(n) { <- n::multiply(with 2) })

				Terminal.inspect(doubled::toString())
			}`),
		).toEqual(['"128"'])
	})

	it("returns the seed when an until condition is true at once", async () => {
		expect(
			await run(`implementation {
				constant untouched = loop(startingWith 500,
					until (n) { <- n::isGreaterThanOrEqualTo(100) },
					(n) { <- n::multiply(with 2) })

				Terminal.inspect(untouched::toString())
			}`),
		).toEqual(['"500"'])
	})

	it("finishes the general loop on the first #Done, threading a Record State", async () => {
		// Stops with the single-member shorthand `#Done(state.total)` rather
		// than `#Done({ value = … })`.
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

				Terminal.inspect(total::toString())
			}`),
		).toEqual(['"15"'])
	})

	it("finishes the general loop with a Result of a different Type than the State", async () => {
		// The general loop's State and Result Type Parameters are independent.
		expect(
			await run(`implementation {
				constant word = loop(startingWith 0,
					step (count) {
						if count::isGreaterThanOrEqualTo(3) { <- #Done("done") }

						<- #Continue(count::add(1))
					})

				Terminal.inspect(word)
			}`),
		).toEqual(['"done"'])
	})

	// Each `#Done` belongs to the loop whose callback it is written in. The
	// inner Result is an Integer, the outer a String.
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

				Terminal.inspect(word)
			}`),
		).toEqual(['"done"'])
	})

	// A prefixed Case without Type Arguments reads them off the position, so
	// the callback must write its return Type.
	it("uses the prefixed #Continue / #Done spelling in the general loop", async () => {
		expect(
			await run(`implementation {
				constant total = loop(startingWith { index = 1, total = 0 },
					step (state) -> Step<{ index: Integer, total: Integer }, Integer> {
						if state.index::isGreaterThan(3) { <- Step#Done(state.total) }

						<- Step#Continue({ state = { index = state.index::add(1), total = state.total::add(state.index) } })
					})

				Terminal.inspect(total::toString())
			}`),
		).toEqual(['"6"'])
	})

	// `#Done("done")` decides `Result` but not `State`, so the position decides
	// `State` once the call has committed. See "Instantiating a generic Case
	// from its payload" in packages/compiler/src/enricher/DEVELOPMENT.md.
	it("agrees with itself whether the callback writes its return Type or not", async () => {
		let walk = (returnType: string, sigil: string): string =>
			`implementation {
				constant word = loop(startingWith 0, step (count)${returnType} {
					if count::isGreaterThanOrEqualTo(3) { <- ${sigil}#Done("done") }

					<- ${sigil}#Continue(count::add(1))
				})

				Terminal.inspect(word)
			}`

		expect(await run(walk("", ""))).toEqual(['"done"'])
		expect(
			await run(
				walk(" -> Step<Integer, String>", "Step<Integer, String>"),
			),
		).toEqual(['"done"'])
	})
})

// The counted entries whose body answers a `Step` are told apart from the
// others by the `step` label alone. An Overload is not chosen by a callback's
// answer Type.
describe("a counted loop whose body answers a Step", () => {
	it("leaves the count on the first #Done", async () => {
		// 15 is the first total past ten. The whole count would reach 5050.
		expect(
			await run(`implementation {
				constant total = loop(from 1, through 100, startingWith 0,
					step (index, running) {
						constant next = running::add(index)

						if next::isGreaterThan(10) { <- #Done(next) }

						<- #Continue(next)
					})

				Terminal.inspect(total::toString())
			}`),
		).toEqual(['"15"'])
	})

	it("answers the State the last step carried when the count runs out", async () => {
		expect(
			await run(`implementation {
				constant total = loop(from 1, through 4, startingWith 0,
					step (index, running) { <- #Continue(running::add(index)) })

				Terminal.inspect(total::toString())
			}`),
		).toEqual(['"10"'])
	})

	it("answers the seed for a range that runs no turns", async () => {
		expect(
			await run(`implementation {
				constant untouched = loop(from 5, through 1, startingWith 42,
					step (index, running) { <- #Continue(running::add(index)) })

				constant excluded = loop(from 0, upTo 0, startingWith 7,
					step (index, running) { <- #Continue(running::add(index)) })

				Terminal.inspect(untouched::toString())
				Terminal.inspect(excluded::toString())
			}`),
		).toEqual(['"42"', '"7"'])
	})

	it("stops before an excluded end", async () => {
		expect(
			await run(`implementation {
				constant total = loop(from 0, upTo 5, startingWith 0,
					step (index, running) { <- #Continue(running::add(index)) })

				Terminal.inspect(total::toString())
			}`),
		).toEqual(['"10"'])
	})

	it("counts down, and takes its first turn whatever the end is", async () => {
		expect(
			await run(`implementation {
				constant digits = loop(from 5, downTo 1, startingWith "",
					step (index, gathered) {
						constant next = gathered::append(index::toString())

						if next::length()::is(3) { <- #Done(next) }

						<- #Continue(next)
					})

				constant whole = loop(from 3, downTo 1, startingWith "",
					step (index, gathered) {
						<- #Continue(gathered::append(index::toString()))
					})

				constant inverted = loop(from 3, downTo 9, startingWith "",
					step (index, gathered) {
						<- #Continue(gathered::append(index::toString()))
					})

				Terminal.inspect(digits)
				Terminal.inspect(whole)
				Terminal.inspect(inverted)
			}`),
		).toEqual(['"543"', '"321"', '"3"'])
	})

	// The same Arguments under the same labels reach two entries, told apart
	// by the `step` label.
	it("is a different entry from the positional body under the same labels", async () => {
		expect(
			await run(`implementation {
				constant counted = loop(from 1, through 3, startingWith 0,
					(index, running) { <- running::add(index) })

				constant stepped = loop(from 1, through 3, startingWith 0,
					step (index, running) {
						if index::is(2) { <- #Done(running) }

						<- #Continue(running::add(index))
					})

				Terminal.inspect(counted::toString())
				Terminal.inspect(stepped::toString())
			}`),
		).toEqual(['"6"', '"1"'])
	})
})

// Every counted entry has an Essence body in `Loop.es` and a `for` the
// Optimiser writes at the call. `inline-loops` inlines only a callback written
// at the call, so a named body reaches the Essence one.
describe("the counted entries answer alike inlined and not", () => {
	it("agrees on the up count, the down count and the empty range", async () => {
		expect(
			await run(`implementation {
				constant add = (_ index: Integer, _ total: Integer) -> Integer {
					<- total::add(index)
				}

				Terminal.inspect(loop(from 1, through 4, startingWith 0, add)::toString())
				Terminal.inspect(loop(from 4, through 1, startingWith 0, add)::toString())
				Terminal.inspect(loop(from 4, downTo 1, startingWith 0, add)::toString())
				Terminal.inspect(loop(from 1, downTo 4, startingWith 0, add)::toString())
				Terminal.inspect(loop(from 0, upTo 4, startingWith 0, add)::toString())

				Terminal.inspect(loop(from 1, through 4, startingWith 0,
					(index, total) { <- total::add(index) })::toString())
				Terminal.inspect(loop(from 4, through 1, startingWith 0,
					(index, total) { <- total::add(index) })::toString())
				Terminal.inspect(loop(from 4, downTo 1, startingWith 0,
					(index, total) { <- total::add(index) })::toString())
				Terminal.inspect(loop(from 1, downTo 4, startingWith 0,
					(index, total) { <- total::add(index) })::toString())
				Terminal.inspect(loop(from 0, upTo 4, startingWith 0,
					(index, total) { <- total::add(index) })::toString())
			}`),
		).toEqual([
			'"10"',
			'"0"',
			'"10"',
			'"1"',
			'"6"',
			'"10"',
			'"0"',
			'"10"',
			'"1"',
			'"6"',
		])
	})

	// The Step-answering counted entries are written on the general driver,
	// so a named body runs their Essence.
	it("answers alike where a Step body is bound to a name", async () => {
		expect(
			await run(`implementation {
				constant stop = (_ index: Integer, _ total: Integer)
					-> Step<Integer, Integer> {
					constant next = total::add(index)

					if next::isGreaterThan(10) { <- #Done(next) }

					<- #Continue(next)
				}

				Terminal.inspect(loop(from 1, through 100, startingWith 0, step stop)::toString())
				Terminal.inspect(loop(from 1, upTo 100, startingWith 0, step stop)::toString())
				Terminal.inspect(loop(from 100, downTo 1, startingWith 0, step stop)::toString())
			}`),
		).toEqual(['"15"', '"15"', '"100"'])
	})
})

describe("reduce(startingWith:step:)", () => {
	it("folds every item when the combiner always continues", async () => {
		expect(
			await run(`implementation {
				constant sum = [1, 2, 3, 4]::reduce(startingWith 0,
					step (total, item) { <- #Continue(total::add(item)) })

				Terminal.inspect(sum::toString())
			}`),
		).toEqual(['"10"'])
	})

	it("stops the fold on the first #Done and visits no later item", async () => {
		// The accumulator counts the items seen and stops at two, not five.
		expect(
			await run(`implementation {
				constant seen = [1, 2, 3, 4, 5]::reduce(startingWith 0,
					step (count, item) {
						constant next = count::add(1)

						if next::isGreaterThanOrEqualTo(2) { <- #Done(next) }

						<- #Continue(next)
					})

				Terminal.inspect(seen::toString())
			}`),
		).toEqual(['"2"'])
	})

	it("returns the starting value for the empty List", async () => {
		expect(
			await run(`implementation {
				constant noNumbers: List<Integer> = []
				constant sum = noNumbers::reduce(startingWith 42,
					step (total, item) { <- #Continue(total::add(item)) })

				Terminal.inspect(sum::toString())
			}`),
		).toEqual(['"42"'])
	})
})

// The builtin generic `Step` compared by its derived Equatable. Its Alias
// lives in the standard library's scope rather than the Program's.
describe("a Step compares by its derived Equality", () => {
	it("holds two #Done payloads equal, and a #Done apart from a #Continue", async () => {
		expect(
			await run(`implementation {
				constant a: Step<Integer, Integer> = #Done(5)
				constant b: Step<Integer, Integer> = #Done(5)
				constant c: Step<Integer, Integer> = #Done(6)
				constant going: Step<Integer, Integer> = #Continue(5)

				Terminal.inspect(a::is(b)::toString())
				Terminal.inspect(a::is(c)::toString())
				Terminal.inspect(a::is(going)::toString())
				Terminal.inspect(a::isNot(going)::toString())
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

				Terminal.inspect(here::is(same)::toString())
				Terminal.inspect(here::is(moved)::toString())
				Terminal.inspect(here::is(stopped)::toString())
			}`),
		).toEqual(['"true"', '"false"', '"false"'])
	})

	it("satisfies an Equatable bound, so a List of Steps can be searched", async () => {
		expect(
			await run(`implementation {
				constant steps: List<Step<Integer, Integer>> = [#Continue(1), #Done(2)]

				Terminal.inspect(steps::contains(#Done(2))::toString())
				Terminal.inspect(steps::contains(#Done(9))::toString())
				Terminal.inspect(steps::contains(#Continue(1))::toString())
			}`),
		).toEqual(['"true"', '"false"', '"true"'])
	})

	// A generic payload compares through its own witness, here Rational's.
	it("compares a Rational payload by its own equality, not by structure", async () => {
		expect(
			await run(`implementation {
				constant half: Step<Integer, Rational> = #Done(1/2)
				constant twoQuarters: Step<Integer, Rational> = #Done(2/4)

				Terminal.inspect(half::is(twoQuarters)::toString())
				Terminal.inspect(half::isNot(twoQuarters)::toString())
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
			"55",
			"321",
			"15",
			"128",
			"128",
			"15",
			"2",
		])
	})
})
