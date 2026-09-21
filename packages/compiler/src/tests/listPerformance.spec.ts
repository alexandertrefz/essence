import { describe, expect, it } from "bun:test"
import { spawnSync } from "node:child_process"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { containsErrors } from "../diagnostics/index"
import { enrich } from "../enricher/index"
import { optimise } from "../optimiser/index"
import { parseWithDiagnostics } from "../parser/index"
import { rewrite } from "../rewriter/index"
import { simplify } from "../simplifier/index"
import { validate } from "../validator/index"

// NOTE: The one claim about a List that is a claim about TIME rather than about
// what it answers, and the only kind a correctness test can not make. Building
// a List by appending or prepending used to copy the whole backing Array per
// turn, which is quadratic: 40,000 appends measured about a second, and 60,000
// of them about 1.6 s in a JavaScript loop doing nothing else. Sharing the tail
// makes both ends amortised O(1), and the same 60,000 measure tens of
// milliseconds. The threshold is a second — an order of magnitude above what
// the linear build costs on the slowest machine this is likely to run on, and
// well under what the quadratic one costs on the fastest.
const TURNS = 60_000
const CEILING_MILLISECONDS = 1_000

// NOTE: The same claim for the other direction — taking a List APART one item
// at a time, and reading it as it goes, which is what every walk below does.
// These are held to a RATIO rather than to a ceiling. What they claim is that a
// Program's cost grows with the length of its List rather than with the square
// of it, and that is a claim about the SHAPE of four measurements rather than
// about any one of them — so it holds on a machine under any load, where an
// absolute ceiling has to sit an order of magnitude above the linear figure to
// be safe and can then only catch a regression costing more than that. Doubling
// the length doubles a linear cost and quadruples a quadratic one, so the guard
// is three against a doubling: no linear Program reaches it and no quadratic one
// misses it. Measured on this machine at the four lengths below, subprocess
// startup inside every figure: the head/tail walk ran 30, 31, 35 and 44 ms —
// ratios of 1.0, 1.1 and 1.3 — where before the half rule it ran 47, 111, 344
// and 1274, which is 2.4, 3.1 and 3.7.
const WALK_LENGTHS = [10_000, 20_000, 40_000, 80_000]
const GROWTH_PER_DOUBLING = 3

// NOTE: Best of three at each length, because one slow run anywhere in the four
// moves a ratio twice — up at its own length and down at the next — and a guard
// that a scheduling hiccup can fail is a guard nobody trusts.
const ATTEMPTS = 3

// NOTE: A subprocess rather than an import, because what is being measured is
// the Program's own wall time and a test runner's process has already paid for
// whatever it loaded — and because a build this size allocates enough that
// leaving it in the runner's heap would be felt by whatever runs next. The
// startup Bun charges for the subprocess is inside the figure, which is the
// honest direction: it makes the measurement larger, not smaller.
function millisecondsToRun(source: string, printed: string): number {
	let parsed = parseWithDiagnostics(source)

	expect(containsErrors(parsed.diagnostics)).toBe(false)

	let enriched = enrich(parsed.program)

	expect(containsErrors(enriched.diagnostics)).toBe(false)
	expect(containsErrors(validate(enriched.program))).toBe(false)

	let javaScript = rewrite(optimise(simplify(enriched.program)))
	let directory = mkdtempSync(join(tmpdir(), "essence-list-performance-"))
	let file = join(directory, "program.ts")

	writeFileSync(file, javaScript)

	try {
		let start = performance.now()
		let result = spawnSync(process.execPath, [file], {
			encoding: "utf-8",
		})
		let elapsed = performance.now() - start

		// NOTE: The Program prints the length it answered, and it is checked
		// here — a build that threw, or one that answered a List of the wrong
		// length, would otherwise be the fastest run of all.
		expect(result.stderr).toBe("")
		expect(result.stdout.trim()).toBe(printed)

		return elapsed
	} finally {
		rmSync(directory, { recursive: true, force: true })
	}
}

// NOTE: The seed carries one item so that the walk's State is a List of
// Integers from the first turn, and the printed length is one more than the
// number of turns because of it.
function buildingSource(method: string): string {
	return `implementation {
	constant built = loop(from 1, through ${TURNS}, startingWith [0], (
		index,
		list,
	) { <- list::${method}(index) })

	Terminal.print(built::length())
}`
}

// NOTE: Every doubling held to the same ratio, rather than the whole span held
// to one — a Program that turns quadratic only past some length fails at the
// doubling where it does, and the message names it. Compiling happens outside
// the figure, since the timer starts at the spawn, so asking for the same length
// three times costs the test its own wall time and costs the measurement
// nothing.
//
// NOTE: The lengths are measured one at a time and the walk STOPS at the first
// doubling that is too steep, which is what keeps a failure quick: a quadratic
// Program is caught at twenty or forty thousand and is never asked for eighty,
// where it would run for long enough to be killed by the runner's own timeout
// and report that instead of its growth.
// NOTE: A TOO-STEEP READING IS TAKEN TWICE BEFORE IT IS BELIEVED, and both of
// its lengths are measured again — the rule `stringPerformance.spec.ts` follows,
// for its reason. Every figure here carries a subprocess spawn, several suites
// can share the machine, and a spawn that stalls under load moves a ratio of two
// small figures further than any regression in these Methods could: two of
// these cases went red at loads of 17 and 52 with their claims perfectly true.
// A Program that really did turn quadratic reads steep every time it is asked,
// so asking twice costs a failing run a few seconds and a passing run nothing.
function expectLinearGrowth(
	sourceFor: (length: number) => string,
	printedFor: (length: number) => string,
): void {
	let bestOf = (length: number) => {
		let best = Number.POSITIVE_INFINITY

		for (let attempt = 0; attempt < ATTEMPTS; attempt++) {
			best = Math.min(
				best,
				millisecondsToRun(sourceFor(length), printedFor(length)),
			)
		}

		return best
	}
	let measured: Array<number> = []
	let tooSteep: Array<string> = []

	for (let index = 0; index < WALK_LENGTHS.length; index++) {
		let length = WALK_LENGTHS[index]!

		measured.push(bestOf(length))

		if (index === 0) {
			continue
		}

		let grewBy = () => measured[index]! / measured[index - 1]!

		if (grewBy() < GROWTH_PER_DOUBLING) {
			continue
		}

		measured[index - 1] = Math.min(
			measured[index - 1]!,
			bestOf(WALK_LENGTHS[index - 1]!),
		)
		measured[index] = Math.min(measured[index]!, bestOf(length))

		if (grewBy() >= GROWTH_PER_DOUBLING) {
			tooSteep.push(
				`${WALK_LENGTHS[index - 1]} to ${length}: ${grewBy().toFixed(1)}x`,
			)

			break
		}
	}

	expect(tooSteep).toEqual([])
}

// NOTE: The List is built by prepending, so every item of it lives in the front
// run — and then it is emptied from that end, one item per turn, which is where
// the front run pays for itself. Or it is built by appending, so every item
// lives in the back run and the first step of the drain has to move them. The
// seed carries one item that is never removed, so the drain runs out of turns
// rather than out of items and the printed length is one.
function drainingSource(
	built: "prepend" | "append",
	turns: number,
	step: string,
): string {
	return `implementation {
	constant built = loop(from 1, through ${turns}, startingWith [0], (
		index,
		list,
	) { <- list::${built}(index) })

	constant drained = loop(from 1, through ${turns}, startingWith built, (
		_,
		list,
	) { <- list::${step} })

	Terminal.print(drained::length())
}`
}

// NOTE: The walk's State is a Record of what is left and what has been added
// up, so that one source stands for every shape of walk — the body is the whole
// of the difference between them.
function walkingSource(length: number, walk: string): string {
	return `implementation {
	constant items = List.of(integersFrom 1, through ${length})

	constant total = loop(startingWith { rest = items, sum = 0 }, step (state) {
		<- ${walk}
	})

	Terminal.print(total)
}`
}

// NOTE: The sum each walk prints, checked for the reason the drains' length is:
// a build that threw, or one that added up the wrong items, would otherwise be
// the fastest run of all. The two full walks add up every item; the two-ended
// one stops at the middle and adds up the first half.
function printedSumFor(name: string, length: number): string {
	if (name === "both ends") {
		let half = length / 2

		return String((half * (half + 1)) / 2)
	}

	return String((length * (length + 1)) / 2)
}

describe("List performance", () => {
	it("appends sixty thousand items in under a second", () => {
		expect(
			millisecondsToRun(buildingSource("append"), `${TURNS + 1}`),
		).toBeLessThan(CEILING_MILLISECONDS)
	})

	it("prepends sixty thousand items in under a second", () => {
		expect(
			millisecondsToRun(buildingSource("prepend"), `${TURNS + 1}`),
		).toBeLessThan(CEILING_MILLISECONDS)
	})

	// NOTE: The four drains, each held to its growth rather than to a ceiling.
	// `remove(at 0)` on a prepend-built List shrinks the front run by one and
	// shares both runs; on an append-built one the box upgrades itself once and
	// the rest of the drain is windows. Both used to slice and rejoin the List at
	// every step, which is quadratic the way the copying builds were.
	for (let [built, step] of [
		["prepend", "remove(at 0)"],
		["prepend", "removeFirst()"],
		["append", "remove(at 0)"],
		["append", "removeFirst()"],
	] as const) {
		it(`drains a ${built}-built List through ${step} in linear time`, () => {
			expectLinearGrowth(
				(length) => drainingSource(built, length, step),
				() => "1",
			)
		})
	}

	// NOTE: THE CANONICAL FUNCTIONAL WALK — take the head, go on with the tail —
	// which is `item(at 0)` on a box `slice` has just answered a window for.
	// Reading one item of that window used to copy the whole of it, so the walk
	// moved n−k items a turn and was quadratic while the drains beside it, which
	// read nothing, were flat. The half rule in `List.ts` is what this holds.
	for (let [name, walk] of [
		[
			"head/tail",
			`match state.rest::firstItem() -> Step<{ rest: List<Integer>, sum: Integer }, Integer> {
			case #Empty { <- #Done(state.sum) }
			case #Value(head) {
				<- #Continue({
					rest = state.rest::removeFirst(),
					sum = state.sum::add(head),
				})
			}
		}`,
		],
		[
			"init/last",
			`match state.rest::lastItem() -> Step<{ rest: List<Integer>, sum: Integer }, Integer> {
			case #Empty { <- #Done(state.sum) }
			case #Value(tail) {
				<- #Continue({
					rest = state.rest::removeLast(),
					sum = state.sum::add(tail),
				})
			}
		}`,
		],
		[
			// NOTE: Both ends a turn, which is a palindrome check's shape. The
			// window it asks for holds NEITHER end of the box it is cut from,
			// and could be shared by nobody until such a box learned to move its
			// seam into the middle of the window.
			"both ends",
			`match state.rest::firstItem() -> Step<{ rest: List<Integer>, sum: Integer }, Integer> {
			case #Empty { <- #Done(state.sum) }
			case #Value(head) {
				if state.rest::length()::isLessThan(2) {
					<- #Done(state.sum::add(head))
				} else {
					<- #Continue({
						rest = state.rest::removeFirst()::removeLast(),
						sum = state.sum::add(head),
					})
				}
			}
		}`,
		],
	] as const) {
		it(`walks a List ${name} in linear time`, () => {
			expectLinearGrowth(
				(length) => walkingSource(length, walk),
				(length) => printedSumFor(name, length),
			)
		})
	}
})
