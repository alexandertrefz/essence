import { describe, expect, it } from "bun:test"
import { spawnSync } from "node:child_process"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { createInteger } from "@essence-lang/runtime/Integer"
import {
	count__overload$1 as occurrencesOf,
	createString,
	firstIndex__overload$1 as firstIndex,
	hasCharacterView,
	lastIndex__overload$1 as lastIndex,
	slice,
	split__overload$1 as split,
} from "@essence-lang/runtime/String"
import { typeKeySymbol } from "@essence-lang/runtime/type"

import { containsErrors } from "../diagnostics/index"
import { enrich } from "../enricher/index"
import { optimise } from "../optimiser/index"
import { parseWithDiagnostics } from "../parser/index"
import { rewrite } from "../rewriter/index"
import { simplify } from "../simplifier/index"
import { validate } from "../validator/index"

// NOTE: The claims about a String that are claims about WORK, and the two that
// are claims about TIME. A String the ASCII scan accepts is searched, split and
// cut by the JavaScript intrinsics, where every other String goes through the
// grapheme view — so the first block asks the receiver afterwards whether a
// view was built, which is what the two paths differ in and is decided by no
// clock at all. A guard on the view's own walk would be a guard on the
// Segmenter, which is not this package's claim.
//
// NOTE: The second block is for what only a stopwatch can say: that the whole
// Program, compiled and run, stays far under what it cost before. Each is
// compiled once, run as a subprocess three times and taken at its best, so a
// scheduler that stalls one run does not decide the test.
const CHARACTERS = 10_800

// NOTE: `contains` is written on `firstIndex(of:)`, which used to be written
// on `split(on:)` — so a Boolean about a ten-kilobyte String segmented it and
// built a String per piece. The search is native now and reads no piece.
// Measured on this machine, best of three, subprocess startup included in
// both figures: 26 ms for twenty thousand searches against 2,150 ms before.
const SEARCH_TURNS = 20_000

// NOTE: `replaceFirst` is written on `firstIndex(of:)` and two `slice`s, and
// `slice` cuts an ASCII String by the intrinsic rather than through the
// view. Measured the same way: 20 ms for five thousand replacements against
// 728 ms before, when it split the String and joined the pieces back.
const REPLACE_TURNS = 5_000

// NOTE: One ceiling for both: eleven times the slower of the two fast figures,
// 26 ms, and a third of the faster of the two slow ones, 728 ms. A machine
// several times slower than this one still passes, and each of the two
// measured well over the ceiling before this package.
//
// NOTE: `split` is NOT timed here, and that is deliberate. Its two figures are
// 57 ms and 647 ms — a factor of eleven, where the search's are a factor of
// eighty — so no ceiling can be both several times over the fast one and under
// the slow one, and the one it had sat 4.4× over its figure and failed on a
// loaded machine at 468 to 558 ms. The claim it was making is the first block's
// first case, asserted rather than timed.
const CEILING_MILLISECONDS = 300

// NOTE: How long the RUNNER may wait for either of the two timed cases, which
// is a different number from the ceiling above and does a different job. The
// ceiling judges the best of three subprocess runs; this is the patience the
// test runner has for compiling the Program and spawning it those three times.
// The runner's own default is five seconds, and on a machine running four
// suites at once that is not enough to SPAWN three processes: one run of this
// file in twenty took 8,210 ms and failed as a timeout, with the 300 ms
// assertion never reached and no claim about the Program disproved. A timeout
// that fires while the thing it guards is still true is a flake, so the
// patience is a minute and the claim is left where it is.
const RUNNER_MILLISECONDS = 60_000

// NOTE: Three hundred lines of thirty-six characters and a line break, which is
// the shape a Program reading text takes.
const LINES = "abcdefghijklmnopqrstuvwxyz0123456789\n".repeat(300)

// NOTE: `separate` makes a claim no single figure can carry: ONE call groups a
// String in time proportional to its length. It used to walk the characters
// backwards and `unshift` each group onto the front of its answer, which moves
// every group already standing there — quadratic inside a single call, and the
// only String Method that was. So this is held to GROWTH, the way the List
// spec's walks are: doubling the length doubles a linear cost and quadruples a
// quadratic one, and three against a doubling is reached by no linear Program
// and missed by no quadratic one.
//
// NOTE: THE THRESHOLD IS THE SAME THREE FOR EVERY GROWTH CASE HERE and the
// LADDER is what each one claims. A case claiming its cost grows no faster than
// its receiver doubles its lengths, where three catches the quadratic it fears;
// a case claiming its cost does not grow with the receiver AT ALL quadruples
// them, where three catches the linear one. Reading which claim a case makes is
// therefore reading its ladder.
//
// NOTE: The lengths start where the quadratic term OUTGROWS THE SPAWN, which is
// the whole of what makes this guard able to see its own defect. The subprocess
// costs some 22 ms whatever it runs and the grouping costs 0.2 ms at 40,000
// characters, so at any shorter length BOTH shapes read as the spawn and both
// read as flat. Measured with the Method put back the way it was: 37, 75 and
// 251 ms — caught at the second doubling at 3.3x — against 22, 22, 23 and 24 ms
// as it stands, which is 1.0, 1.1 and 1.0. The spawn inside every figure is also
// why a quadratic Program reads under four here: it dilutes the shortest lengths
// most, so the ratios CLIMB towards four rather than starting there, and the
// guard is written to keep asking until one of them arrives.
const GROUPED_LENGTHS = [40_000, 80_000, 160_000, 320_000]
const GROUP_WIDTH = 3
const GROWTH_THRESHOLD = 3

// NOTE: A FOLDED FIRST-MATCH SEARCH COSTS THE DISTANCE TO THE MATCH, which is
// what the case-sensitive search beside it has always cost and what the folded
// one did not: it lower-cased the WHOLE receiver and then searched, so a drain
// asking `firstIndex(of:, comparing #Insensitive)` per turn read the rest of
// its String every turn — the same n² the copying was, and in pure ASCII, where
// the same drain asking the case-sensitive question was linear.
//
// NOTE: The lengths QUADRUPLE and the turn count is FIXED, so the Program asks
// exactly as many searches at every length and only the receiver grows. A
// search costing the distance therefore reads FLAT and one reading the whole
// receiver reads four times per step, which is what the threshold catches.
//
// NOTE: BOTH ROUTES ARE DRAINED, and the ASCII one needs eight times the turns
// to make its claim. Folding an ASCII receiver is one engine call over the
// whole text, where folding a segmented one is a call per character — so at the
// same turn count the ASCII defect hides inside the subprocess spawn and the
// guard could not see it. Measured end to end, best of three, with the folding
// put back the way it was: ASCII 117, 631 and 2,686 ms against 28, 28 and 29 as
// it stands; the view route 143, 519 and 2,017 against 27, 28 and 35.
const ASCII_SEARCH_LENGTHS = [20_000, 80_000, 320_000]
const ASCII_SEARCH_TURNS = 17_600
const VIEW_SEARCH_LENGTHS = [11_000, 44_000, 176_000]
const VIEW_SEARCH_TURNS = 2_200

// NOTE: "ZZ" every twenty-two characters, so a drain that has eaten any number
// of them still has one within twenty-one of the front of what is LEFT. The
// positions it reads therefore cycle 0, 21, 20 … 1 over each period and sum to
// the arithmetic series 231 a period — which is what the Program prints, and
// what makes a search that answered the wrong position, or threw, fail rather
// than win. The turns are a whole number of periods and are fewer than the
// SHORTEST receiver's characters, so every length prints the same sum.
//
// NOTE: The second period is the same text with an accent in it, which is the
// whole of what sends the drain down the grapheme route rather than the
// intrinsics — so the two cases below differ in ONE character.
const ASCII_PERIOD = "ZZcafe cafe cafe cafe "
const VIEW_PERIOD = "ZZcaf\u00e9 caf\u00e9 caf\u00e9 caf\u00e9 "
const PERIOD_SUM = 231

function millisecondsToRun(source: string, printed: string): number {
	let parsed = parseWithDiagnostics(source)

	expect(containsErrors(parsed.diagnostics)).toBe(false)

	let enriched = enrich(parsed.program)

	expect(containsErrors(enriched.diagnostics)).toBe(false)
	expect(containsErrors(validate(enriched.program))).toBe(false)

	let javaScript = rewrite(optimise(simplify(enriched.program)))
	let directory = mkdtempSync(join(tmpdir(), "essence-string-performance-"))
	let file = join(directory, "program.ts")

	writeFileSync(file, javaScript)

	try {
		let best = Number.POSITIVE_INFINITY

		for (let attempt = 0; attempt < 3; attempt++) {
			let start = performance.now()
			let result = spawnSync(process.execPath, [file], {
				encoding: "utf-8",
			})

			best = Math.min(best, performance.now() - start)

			// NOTE: Each Program prints a count that only the right answers
			// add up to, and it is checked here — a search that threw, or
			// answered the wrong position, would otherwise be the fastest run
			// of all.
			expect(result.stderr).toBe("")
			expect(result.stdout.trim()).toBe(printed)
		}

		return best
	} finally {
		rmSync(directory, { recursive: true, force: true })
	}
}

// NOTE: The part is absent, so every search walks the whole String before it
// answers, and the count the Program prints is what `contains` answered
// summed over the turns: zero, when every answer was `false`.
function searchingSource(): string {
	return `implementation {
	constant text = "abcdefghij"::repeat(times ${CHARACTERS / 10})
	constant found = loop(from 1, through ${SEARCH_TURNS}, startingWith 0, (
		_,
		count,
	) { <- count::add(define { as 1 if text::contains("zzz") as 0 otherwise }) })

	Terminal.print(found)
}`
}

// NOTE: The part occurs early, so the search is short and the two cuts are
// what the turn costs; replacing three characters by one leaves a String two
// characters shorter, which is what the printed sum checks.
function replacingSource(): string {
	return `implementation {
	constant text = "abcdefghij"::repeat(times ${CHARACTERS / 10})
	constant characters = loop(from 1, through ${REPLACE_TURNS}, startingWith 0, (
		_,
		count,
	) { <- count::add(text::replaceFirst("hij", with "X")::length()) })

	Terminal.print(characters)
}`
}

// NOTE: One call per Program, so what is timed is the grouping of ONE String
// rather than a drain over many — the defect was inside a single call.
function groupingSource(length: number): string {
	return `implementation {
	constant text = "1234567890"::repeat(times ${length / 10})

	Terminal.print(text::separate(every ${GROUP_WIDTH}, with ",")::length())
}`
}

// NOTE: The separator goes BETWEEN the groups, so the answer is as long as the
// receiver plus one character for every group after the first. Checked for the
// reason every other printed answer here is: a call that threw, or grouped the
// wrong way, would otherwise be the fastest run of all.
function printedGroupedLength(length: number): string {
	return String(length + Math.ceil(length / GROUP_WIDTH) - 1)
}

// NOTE: Every doubling held to the same ratio rather than the whole span held to
// one, and the walk STOPS at the first doubling that is too steep — which is
// what keeps a failure quick, since the length after the one that caught a
// quadratic Program is the one that would run for long enough to be killed by
// the runner and report a timeout instead of its growth.
function expectGrowthUnderThreshold(
	lengths: Array<number>,
	sourceFor: (length: number) => string,
	printedFor: (length: number) => string,
): void {
	let measured: Array<number> = []
	let tooSteep: Array<string> = []

	for (let index = 0; index < lengths.length; index++) {
		let length = lengths[index]!

		measured.push(millisecondsToRun(sourceFor(length), printedFor(length)))

		if (index === 0) {
			continue
		}

		let grewBy = measured[index]! / measured[index - 1]!

		if (grewBy >= GROWTH_THRESHOLD) {
			tooSteep.push(
				`${lengths[index - 1]} to ${length}: ${grewBy.toFixed(1)}x`,
			)

			break
		}
	}

	expect(tooSteep).toEqual([])
}

// NOTE: The seed is CUT before it is put in the State, so that the walk carries
// a String where the Literal proves a NonEmptyString — which is the Type the
// drain really has, since it cuts a character off every turn and the Type has
// to hold on the last one too.
//
// NOTE: A counted drain rather than one that runs until its String is empty,
// and the count is what makes the lengths comparable: the same searches are
// asked whatever the receiver is. A drain running to empty would ask more
// questions of a longer String and could not tell a search that GREW from a
// drain that simply ran longer — and, as the List spec found, a defect that
// answers the wrong length hangs such a drain, and a suite that hangs says
// nothing at all.
function searchDrainSource(
	period: string,
	turns: number,
	length: number,
): string {
	return `implementation {
	constant text = "${period}"::repeat(times ${Math.floor(length / period.length)})
	constant summed = loop(from 1, through ${turns}, startingWith {
		rest = text::slice(from 0),
		total = 0,
	}, (_, state) {
		<- {
			rest = state.rest::slice(from 1),
			total = state.total::add(
				state.rest::firstIndex(of "zz", comparing #Insensitive)::value(defaultingTo 0),
			),
		}
	})

	Terminal.print(summed.total)
}`
}

function printedDrainSum(turns: number): string {
	return String((turns / ASCII_PERIOD.length) * PERIOD_SUM)
}

function position(answer: ReturnType<typeof firstIndex>): number {
	return answer[typeKeySymbol] === "Optional#Empty"
		? -1
		: Number(answer.item.value)
}

describe("String work", () => {
	// NOTE: The receiver is asked afterwards whether it has a character view,
	// which only the walk builds — so this is the whole of "the ASCII path was
	// taken", and it is a fact about the run rather than a reading off a
	// clock. The answers are asserted beside it, because a fast path that
	// answered the wrong thing would build no view either.
	it("splits an ASCII String without building its character view", () => {
		let text = createString(LINES)
		let pieces = split(text, createString("\n"))

		expect(pieces.value).toHaveLength(301)
		expect(pieces.value[0]!.value).toBe(
			"abcdefghijklmnopqrstuvwxyz0123456789",
		)
		expect(pieces.value[300]!.value).toBe("")
		expect(hasCharacterView(text)).toBeFalse()
	})

	it("searches an ASCII String without building its character view", () => {
		let text = createString(LINES)

		expect(position(firstIndex(text, createString("z0")))).toBe(25)
		expect(position(firstIndex(text, createString("zzz")))).toBe(-1)
		expect(position(lastIndex(text, createString("z0")))).toBe(11_088)
		expect(Number(occurrencesOf(text, createString("z0")).value)).toBe(300)
		expect(hasCharacterView(text)).toBeFalse()
	})

	it("cuts an ASCII String without building its character view", () => {
		let text = createString(LINES)

		expect(slice(text, createInteger(0), createInteger(10)).value).toBe(
			"abcdefghij",
		)
		expect(hasCharacterView(text)).toBeFalse()
	})

	// NOTE: The other side of the claim — a receiver the scan refuses goes
	// through the view, and the view is remembered on it. Without this the
	// three cases above would pass just as well if nothing built a view ever.
	it("builds the view for a receiver the ASCII scan refuses", () => {
		let text = createString(`café${LINES}`)

		split(text, createString("\n"))

		expect(hasCharacterView(text)).toBeTrue()
	})
})

describe("String performance", () => {
	it(
		"searches a ten kilobyte String twenty thousand times without building its pieces",
		() => {
			expect(millisecondsToRun(searchingSource(), "0")).toBeLessThan(
				CEILING_MILLISECONDS,
			)
		},
		RUNNER_MILLISECONDS,
	)

	it(
		"replaces the first occurrence five thousand times with two cuts",
		() => {
			expect(
				millisecondsToRun(
					replacingSource(),
					`${REPLACE_TURNS * (CHARACTERS - 2)}`,
				),
			).toBeLessThan(CEILING_MILLISECONDS)
		},
		RUNNER_MILLISECONDS,
	)

	for (let [route, period, lengths, turns] of [
		[
			"an ASCII receiver",
			ASCII_PERIOD,
			ASCII_SEARCH_LENGTHS,
			ASCII_SEARCH_TURNS,
		],
		[
			"a segmented receiver",
			VIEW_PERIOD,
			VIEW_SEARCH_LENGTHS,
			VIEW_SEARCH_TURNS,
		],
	] as const) {
		it(
			`finds a folded match in ${route} at the cost of the distance to it`,
			() => {
				expectGrowthUnderThreshold(
					lengths,
					(length) => searchDrainSource(period, turns, length),
					() => printedDrainSum(turns),
				)
			},
			RUNNER_MILLISECONDS,
		)
	}

	it(
		"groups one String in time proportional to its length",
		() => {
			expectGrowthUnderThreshold(
				GROUPED_LENGTHS,
				groupingSource,
				printedGroupedLength,
			)
		},
		RUNNER_MILLISECONDS,
	)
})
