import { describe, expect, it } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { spawnAndWait } from "@essence-lang/fixtures/spawn"
import { insensitive } from "@essence-lang/runtime/CaseSensitivity"
import { createInteger } from "@essence-lang/runtime/Integer"
import { end } from "@essence-lang/runtime/Side"
import {
	count__overload$1 as occurrencesOf,
	createString,
	firstIndex__overload$1 as firstIndex,
	firstIndex__overload$3 as firstIndexFolded,
	hasCharacterView,
	lastIndex__overload$1 as lastIndex,
	lastIndex__overload$3 as lastIndexFolded,
	separate,
	slice,
	type StringType,
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

// Claims about a String that no answer shows. The first block counts work: whether
// a Method built a character view, and how often it reached for an intrinsic it
// must not use. Counting needs no clock and no margin.
//
// The second block times only what a count cannot see: that a native search stops
// where it finds, and that one `separate` call is linear. Each Program is compiled
// once and run three times per length as a subprocess, and the best run counts.
const CHARACTERS = 10_800

// Lines of text, the shape a Program reading text handles.
const LINES = "abcdefghijklmnopqrstuvwxyz0123456789\n".repeat(300)

// A linear claim doubles its lengths and a constant one quadruples them, so
// `GROWTH_THRESHOLD` catches the next power up. It admits growth below about
// n^1.58 or n^0.79. The grouping lengths start where a quadratic cost outgrows
// the subprocess spawn, which otherwise makes every shape read flat.
const GROUPED_LENGTHS = [40_000, 80_000, 160_000, 320_000]
const GROUP_WIDTH = 3
const GROWTH_THRESHOLD = 3

// A folded first-match search costs the distance to the match, so a drain asking
// one per turn stays linear. The drain counts how many characters the searches
// fold rather than timing them. Both routes are drained, since they share no
// code. See "Searching a String" in packages/runtime/DEVELOPMENT.md.
const DRAIN_TURNS = 2_200
const ASCII_DRAIN_LENGTHS = [20_000, 80_000]
const VIEW_DRAIN_LENGTHS = [11_000, 44_000]

// "ZZ" every 22 characters keeps a match within 21 of the front of what is
// left, and the positions sum to `PERIOD_SUM` a period. The turns are whole
// periods and fewer than any receiver's characters, so every length sums alike.
// The view period's accent sends it down the grapheme route, at the same length.
const ASCII_PERIOD = "ZZcafe cafe cafe cafe "
const VIEW_PERIOD = "ZZcaf\u00e9 caf\u00e9 caf\u00e9 caf\u00e9 "
const PERIOD_SUM = 231

async function millisecondsToRun(
	source: string,
	printed: string,
): Promise<number> {
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
			let result = await spawnAndWait([process.execPath, file])

			best = Math.min(best, performance.now() - start)

			// Each Program prints a count only right answers add up to, so a
			// search that threw or answered wrongly fails.
			expect(result.stderr).toBe("")
			expect(result.stdout.trim()).toBe(printed)
		}

		return best
	} finally {
		rmSync(directory, { recursive: true, force: true })
	}
}

// The part occurs early, and `contains` is written on the native
// `firstIndex(of:)`, which stops where it finds. The lengths quadruple and the turns are fixed, so a
// search costing the distance reads flat. The Program prints how many searches
// answered `true`, so a wrong answer fails.
const CONTAINS_LENGTHS = [20_000, 80_000, 320_000]
const CONTAINS_TURNS = 2_000

function containsSource(length: number): string {
	return `implementation {
	constant text = "abcdefghij"::repeat(times ${length / 10})
	constant found = loop(from 1, through ${CONTAINS_TURNS}, startingWith 0, (
		_,
		count,
	) { <- count::add(define { as 1 if text::contains("cde") as 0 otherwise }) })

	Terminal.print(found)
}`
}

// One call per Program, so the grouping of one String is timed.
function groupingSource(length: number): string {
	return `implementation {
	constant text = "1234567890"::repeat(times ${length / 10})

	Terminal.print(text::separate(every ${GROUP_WIDTH}, with ",")::length())
}`
}

// The separator stands between the groups, so the answer is one character
// longer per group after the first. A wrong grouping fails.
function printedGroupedLength(length: number): string {
	return String(length + Math.ceil(length / GROUP_WIDTH) - 1)
}

// Each step is held to the ratio. The walk stops at the first step too steep,
// before a quadratic Program runs long enough to time out. A steep step
// is measured again before it is believed, since a stalled spawn can skew two
// small figures. A real regression reads steep every time.
async function expectGrowthUnderThreshold(
	lengths: Array<number>,
	sourceFor: (length: number) => string,
	printedFor: (length: number) => string,
): Promise<void> {
	let measure = (length: number) =>
		millisecondsToRun(sourceFor(length), printedFor(length))
	let measured: Array<number> = []
	let tooSteep: Array<string> = []

	for (let index = 0; index < lengths.length; index++) {
		let length = lengths[index]!

		measured.push(await measure(length))

		if (index === 0) {
			continue
		}

		let grewBy = () => measured[index]! / measured[index - 1]!

		if (grewBy() < GROWTH_THRESHOLD) {
			continue
		}

		measured[index - 1] = Math.min(
			measured[index - 1]!,
			await measure(lengths[index - 1]!),
		)
		measured[index] = Math.min(measured[index]!, await measure(length))

		if (grewBy() >= GROWTH_THRESHOLD) {
			tooSteep.push(
				`${lengths[index - 1]} to ${length}: ${grewBy().toFixed(1)}x`,
			)

			break
		}
	}

	expect(tooSteep).toEqual([])
}

// How often a Method reached for an intrinsic while its body ran. The searches
// and replacements must not `split` or `join`, an ASCII receiver must not
// `segment`, and a folded search folds a bounded amount. A folding is counted as
// calls and as characters, since the ASCII route folds a whole chunk in one call.
// Each intrinsic is restored in a `finally`. The runtime's `stringWindows.spec.ts`
// counts the Segmenter the same way.
type IntrinsicCalls = {
	split: number
	join: number
	segment: number
	folds: number
	folded: number
}

function intrinsicCalls(body: () => void): IntrinsicCalls {
	let calls: IntrinsicCalls = {
		split: 0,
		join: 0,
		segment: 0,
		folds: 0,
		folded: 0,
	}
	let watched: Array<[object, string, keyof IntrinsicCalls]> = [
		[String.prototype, "split", "split"],
		[Array.prototype, "join", "join"],
		[Intl.Segmenter.prototype, "segment", "segment"],
		[String.prototype, "toLowerCase", "folds"],
	]
	let originals = watched.map(
		([holder, name]) => (holder as Record<string, unknown>)[name],
	)

	watched.forEach(([holder, name, counted], index) => {
		let original = originals[index] as (
			this: unknown,
			...args: Array<unknown>
		) => unknown

		;(holder as Record<string, unknown>)[name] = function (
			this: unknown,
			...args: Array<unknown>
		) {
			calls[counted]++

			if (counted === "folds") {
				calls.folded += (this as { length: number }).length
			}

			return original.apply(this, args)
		}
	})

	try {
		body()
	} finally {
		watched.forEach(([holder, name], index) => {
			;(holder as Record<string, unknown>)[name] = originals[index]
		})
	}

	return calls
}

function position(answer: ReturnType<typeof firstIndex>): number {
	return answer[typeKeySymbol] === "Optional#Empty"
		? -1
		: Number(answer.item.value)
}

describe("String work", () => {
	// Only the grapheme walk builds a character view, so its absence shows
	// the ASCII route was taken. The answers are asserted too, since a wrong
	// answer builds no view either.
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

	// `contains` is `firstIndex(of:)`, and `replaceFirst` is that search and
	// two `slice`s. Neither may cut the String into pieces and join them back.
	it("searches and cuts without cutting the String into pieces", () => {
		let text = createString(LINES)
		let part = createString("z0")
		let calls = intrinsicCalls(() => {
			for (let turn = 0; turn < 100; turn++) {
				position(firstIndex(text, part))
				position(lastIndex(text, part))
				occurrencesOf(text, part)
				slice(text, createInteger(0), createInteger(25))
				slice(text, createInteger(27), createInteger(CHARACTERS))
			}
		})

		expect(calls.split).toBe(0)
		expect(calls.join).toBe(0)
		expect(calls.segment).toBe(0)
		expect(hasCharacterView(text)).toBeFalse()
	})

	// An ASCII receiver's groups are cuts of its own text. The one `join`
	// builds the answer from the groups and the separator.
	it("groups an ASCII String without building its units", () => {
		let text = createString("1234567890".repeat(200))
		let calls = intrinsicCalls(() => {
			separate(text, createInteger(3), createString(","), end)
		})

		expect(calls.split).toBe(0)
		expect(calls.segment).toBe(0)
		expect(calls.join).toBe(1)
		expect(hasCharacterView(text)).toBeFalse()
	})

	// Only the count shows the chunks double, outgrow the part, and swallow
	// the tail. One folding for the part, then chunks of 1,024, 2,048, 4,096.
	// Four chunks cover 20,000 units, and 1,000 units fold whole. A part over
	// half the floor widens the chunks, leaving three. See "Searching a String"
	// in packages/runtime/DEVELOPMENT.md.
	it("folds an ASCII receiver in chunks that double", () => {
		let absent = createString("qqq")
		let folds = (text: string, part: StringType) =>
			intrinsicCalls(() => {
				firstIndexFolded(createString(text), part, insensitive)
			}).folds

		expect(folds("cafe ".repeat(4_000), absent)).toBe(5)
		expect(folds("cafe ".repeat(200), absent)).toBe(2)
		expect(folds("Lions and tigers", absent)).toBe(2)
		expect(
			folds("cafe ".repeat(4_000), createString("q".repeat(1_200))),
		).toBe(4)
	})

	// The view route folds per character with `foldedRun`, so the count is the
	// characters read. Chunks are 16, 32, 64 and so on, and the part is three
	// characters. A match at 1,000 costs 2,032 plus 3. An absent part folds
	// 8,176, then the swallowed 11,842 tail, plus 3. The backward walk is written
	// separately, so it is asserted from the end.
	it("folds a segmented receiver in chunks that double, from either end", () => {
		let characters = 20_000
		let accents = "è".repeat(characters)
		let part = createString("qrs")
		let holding = (at: number) =>
			createString(
				`${accents.slice(0, at)}QRS${accents.slice(0, characters - at - 3)}`,
			)
		let search = (
			receiver: StringType,
			end: typeof firstIndexFolded | typeof lastIndexFolded,
		) => {
			let answer = -2
			let folds = intrinsicCalls(() => {
				answer = position(end(receiver, part, insensitive))
			}).folds

			return { answer, folds }
		}

		expect(search(holding(100), firstIndexFolded)).toEqual({
			answer: 100,
			folds: 115,
		})
		expect(search(holding(1_000), firstIndexFolded)).toEqual({
			answer: 1_000,
			folds: 2_035,
		})
		expect(search(holding(19_000), lastIndexFolded)).toEqual({
			answer: 19_000,
			folds: 2_035,
		})
		expect(search(createString(accents), firstIndexFolded)).toEqual({
			answer: -1,
			folds: 20_021,
		})
		expect(search(createString(accents), lastIndexFolded)).toEqual({
			answer: -1,
			folds: 20_021,
		})
	})

	// A drain through the runtime, as a compiled Program runs it. An ASCII turn
	// folds the part and one 1,024 chunk: 1,026 a turn at either length. On the
	// view route 15 positions of 22 fall in the first chunk of 16, and 7 in the
	// next of 32. So a period folds 576 plus 44 of part. The positions are summed
	// too, so a wrong answer cannot fold cheaply.
	it("folds the distance to its match however long the drained receiver is", () => {
		let drained = (period: string, length: number) => {
			let text = createString(
				period.repeat(Math.floor(length / period.length)),
			)
			let part = createString("zz")
			let step = createInteger(1)
			let whole = createInteger(length)
			let sum = 0
			let counted = intrinsicCalls(() => {
				let rest = text

				for (let turn = 0; turn < DRAIN_TURNS; turn++) {
					sum += position(firstIndexFolded(rest, part, insensitive))
					rest = slice(rest, step, whole)
				}
			})

			return { sum, folded: counted.folded }
		}

		// Each route's sum comes from its own period. The folding figures rely
		// on the periods having the same length, which is asserted first.
		let summedOver = (period: string) =>
			(DRAIN_TURNS / period.length) * PERIOD_SUM

		expect(VIEW_PERIOD.length).toBe(ASCII_PERIOD.length)

		for (let length of ASCII_DRAIN_LENGTHS) {
			expect(drained(ASCII_PERIOD, length)).toEqual({
				sum: summedOver(ASCII_PERIOD),
				folded: 2_257_200,
			})
		}

		for (let length of VIEW_DRAIN_LENGTHS) {
			expect(drained(VIEW_PERIOD, length)).toEqual({
				sum: summedOver(VIEW_PERIOD),
				folded: 62_000,
			})
		}
	})

	// A receiver the scan refuses goes through the view, which is remembered.
	// Otherwise the ASCII specs would pass if no view were ever built.
	it("builds the view for a receiver the ASCII scan refuses", () => {
		let text = createString(`café${LINES}`)

		split(text, createString("\n"))

		expect(hasCharacterView(text)).toBeTrue()
	})
})

describe("String performance", () => {
	it("finds a part near the front of any length of String at the same cost", async () => {
		await expectGrowthUnderThreshold(
			CONTAINS_LENGTHS,
			containsSource,
			() => `${CONTAINS_TURNS}`,
		)
	})

	it("groups one String in time proportional to its length", async () => {
		await expectGrowthUnderThreshold(
			GROUPED_LENGTHS,
			groupingSource,
			printedGroupedLength,
		)
	})
})
