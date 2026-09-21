import { describe, expect, it } from "bun:test"
import { spawnSync } from "node:child_process"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

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

// NOTE: THE CLAIMS ABOUT A STRING THAT NO ANSWER CAN CARRY, in the two shapes
// one of them can be made in. The first block asks what WORK a Method did — a
// String the ASCII scan accepts is searched, split and cut by the JavaScript
// intrinsics where every other String goes through the grapheme view, so the
// receiver is asked afterwards whether a view was built, and the intrinsics a
// Method must NOT reach for are COUNTED while it runs. Neither reads a clock.
//
// NOTE: The second block is for the claims that are about COMPLEXITY, which no
// single figure can carry and no count of calls can either: that a Program's
// cost grows with the length of its String rather than with the square of it,
// or does not grow with that length at all. Each is compiled once and run as a
// subprocess three times at each of its lengths, taken at its best, so a
// scheduler that stalls one run does not decide the test — and a doubling that
// reads too steep is measured a second time before it is believed.
//
// NOTE: WHAT CAN BE COUNTED IS COUNTED, and the block below it has grown at the
// timed block's expense twice over now. A drain's claim is how much TEXT it
// folds; a folded search's claim is which chunks it read. Both were timed
// against a subprocess and both are exact as counts, so both moved up — the
// only claims left on a clock are the two that no instrument can see: that a
// native search STOPS where it finds, and that one `separate` call does not
// walk its answer twice.
//
// NOTE: THERE IS NO WALL-CLOCK CEILING IN THIS FILE ANY MORE, and the shape
// above is what replaced it. One stood over two of these Programs for a long
// time — 300 ms, which had to sit eleven times over the figure it judged to
// survive a loaded machine, and could therefore only catch a regression that
// cost more than an order of magnitude. Worse, neither Program's claim was
// ABOUT its wall clock. "Does not build its pieces" and "with two cuts" say
// that a Method reaches for one intrinsic and not another, which is a fact
// about a SINGLE CALL — so those are counted below, where they are exact, and
// what stays timed is only what a count can not say.
const CHARACTERS = 10_800

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
// NOTE: AND WHAT THREE LETS THROUGH, which is a good deal more than a reader
// might take "catches a quadratic" to mean. Over a DOUBLING it admits anything
// growing slower than n^1.58, so an n^1.5 Program (2.83x a doubling) passes;
// over a QUADRUPLING it admits anything below n^0.79. The margin is deliberate
// — every figure carries a subprocess spawn and the machine is shared — and it
// is why what can be COUNTED is counted instead: a count needs no margin at all.
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
// NOTE: BOTH ROUTES ARE DRAINED, because they share no line of code: folding an
// ASCII receiver is one engine call over the whole text, where folding a
// segmented one is a call per character, and each route has its own chunk walk
// written out for that difference.
//
// NOTE: THE DRAIN IS COUNTED RATHER THAN TIMED, and that is a change from the
// first shape of this guard. It compiled two Programs, drained each in a
// subprocess at three lengths and ratioed their wall clocks — figures of 27 to
// 35 ms, of which some 22 ms is the SPAWN. The signal was therefore 5 to 13 ms,
// a machine that stalls one spawn moves the ratio further than any regression
// in these Methods could, and one run in a hundred failed exactly that way at
// load 342 with the claim perfectly true. A guard that can go red while what it
// guards is right is a bug here, and the wall clock was never what the claim
// was about: what the drain says is how much TEXT a search folds. So the text
// is counted, to the character, and the two lengths of a route must agree to
// the character as well. Measured with the folding put back the way it was, the
// old shape read ASCII 117, 631 and 2,686 ms against 28, 28 and 29; the count
// below reads 41,581,100 characters folded against 2,257,200.
const DRAIN_TURNS = 2_200
const ASCII_DRAIN_LENGTHS = [20_000, 80_000]
const VIEW_DRAIN_LENGTHS = [11_000, 44_000]

// NOTE: "ZZ" every twenty-two characters, so a drain that has eaten any number
// of them still has one within twenty-one of the front of what is LEFT. The
// positions it reads therefore cycle 0, 21, 20 … 1 over each period and sum to
// the arithmetic series 231 a period — which is what the drain adds up, and
// what makes a search that answered the wrong position, or threw, fail rather
// than win. The turns are a whole number of periods and are fewer than the
// SHORTEST receiver's characters, so every length answers the same sum.
//
// NOTE: The second period is the same text with an accent in it, which is the
// whole of what sends the drain down the grapheme route rather than the
// intrinsics — so the two routes below differ in ONE character. They are the
// same number of characters on purpose: what a turn folds is counted in
// characters, so one piece of arithmetic covers both.
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

// NOTE: THE PART OCCURS EARLY, and that is the whole of this claim: `contains`
// is written on `firstIndex(of:)`, which is native and stops where it finds, so
// a search costs the DISTANCE to the part however long the String after it is.
// It used to be written on `split(on:)` — so a Boolean about a ten-kilobyte
// String built a String per piece and cost the whole receiver every time. The
// lengths QUADRUPLE and the turn count is fixed, so a search costing the
// distance reads flat and one building the pieces reads four times per step.
//
// NOTE: The Program prints how many of its searches answered `true`, which is
// all of them — a search that threw, or looked in the wrong place, would
// otherwise be the fastest run of all.
//
// NOTE: The REPLACEMENT Program that stood beside this one is gone rather than
// converted, and its claim is in the first block. `replaceFirst` is written on
// `firstIndex(of:)` and two `slice`s, and both the Method and the defect it
// feared — splitting the String and joining the pieces back — cost the whole
// receiver per call, because both have to BUILD the answer. So there is no
// growth between them to measure, and what does tell them apart is exactly
// which intrinsics each reaches for, which is counted.
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
//
// NOTE: A TOO-STEEP READING IS TAKEN TWICE BEFORE IT IS BELIEVED, and both of
// its lengths are measured again. Every figure here carries a subprocess spawn
// of some 22 ms, four suites share this machine, and a spawn that stalls under
// load moves a ratio of two small figures further than any regression in these
// Methods could — which is how the drain guard that used to stand beside these
// went red once, at load 342, with its claim perfectly true. A Program that
// really did grow reads steep every time it is asked, so asking twice costs a
// failing run one more minute and a passing run nothing; the second reading is
// taken as a BEST of the two, which is what every figure here already is.
function expectGrowthUnderThreshold(
	lengths: Array<number>,
	sourceFor: (length: number) => string,
	printedFor: (length: number) => string,
): void {
	let measure = (length: number) =>
		millisecondsToRun(sourceFor(length), printedFor(length))
	let measured: Array<number> = []
	let tooSteep: Array<string> = []

	for (let index = 0; index < lengths.length; index++) {
		let length = lengths[index]!

		measured.push(measure(length))

		if (index === 0) {
			continue
		}

		let grewBy = () => measured[index]! / measured[index - 1]!

		if (grewBy() < GROWTH_THRESHOLD) {
			continue
		}

		measured[index - 1] = Math.min(
			measured[index - 1]!,
			measure(lengths[index - 1]!),
		)
		measured[index] = Math.min(measured[index]!, measure(length))

		if (grewBy() >= GROWTH_THRESHOLD) {
			tooSteep.push(
				`${lengths[index - 1]} to ${length}: ${grewBy().toFixed(1)}x`,
			)

			break
		}
	}

	expect(tooSteep).toEqual([])
}

// NOTE: HOW OFTEN A METHOD REACHED FOR AN INTRINSIC IT IS NOT MEANT TO REACH
// FOR, counted while the body runs. `split` and `join` are how a String is cut
// into pieces and put back together, which is what the searches and the
// replacements are not allowed to do; `segment` is the Segmenter, which an
// ASCII receiver is not allowed to need; and `toLowerCase` is a FOLDING, which
// the folded searches are allowed to do a bounded number of times and no more.
// This is the same instrument `stringWindows.spec.ts` counts the Segmenter
// with, and for the same reason: a claim that a Method does NOT do something is
// a claim about work, and a stopwatch can only ever say it was fast today.
//
// NOTE: A FOLDING IS COUNTED TWICE OVER — once as a CALL and once as the number
// of characters that call folded — because the two routes spend it differently.
// The view route folds each cluster on its own, so its callings ARE its
// characters and either number says what its chunks did; the ASCII route hands
// a whole chunk to one `toLowerCase`, so no count of its callings can tell a
// chunk of 256 from the whole receiver and only the TEXT folded says what it
// read. That is the number a drain is held to below.
//
// NOTE: Every intrinsic is put back in a `finally`, so a body that throws does
// not leave a counting wrapper standing on `String.prototype` for whatever the
// runner does next.
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

	// NOTE: THE CONVERTED CLAIM OF THE TWO PROGRAMS THIS FILE USED TO TIME.
	// `contains` is `firstIndex(of:)`, which used to be written on `split(on:)`
	// and built a String per piece to answer a Boolean; `replaceFirst` is that
	// search and the two `slice`s below it, where it used to split the receiver
	// and join the pieces back. Both defects are a `split` and a `join` that the
	// Methods now make no call to at all — which is exact, and which a ceiling
	// over the wall clock could only ever say was slow.
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

	// NOTE: And `separate`, which cut its receiver into an Array of its units
	// to slice groups out of it — where an ASCII receiver's groups are cuts of
	// its own text. The ONE join is the groups and the separator becoming the
	// answer, which is what the Method is for.
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

	// NOTE: HOW MANY TIMES A FOLDED SEARCH FOLDS, which is the claim the chunks
	// in `String.ts` make and the one no growth ratio can see: every shape of
	// chunking that reads the receiver once is linear, and only the count says
	// whether the chunks DOUBLE, whether one is wider than the part it looks
	// for, and whether the last one swallows the tail rather than leaving it to
	// a chunk of its own.
	//
	// NOTE: THE COUNT SAYS THAT OF THE ROUTE ITS RECEIVER TAKES AND OF NO OTHER,
	// which is why the case below this one asks the same question of a SEGMENTED
	// receiver. The two routes chunk by the same rules and share not one line,
	// so a count taken on an ASCII receiver holds nothing of the view route's
	// shape in place.
	//
	// NOTE: The figures are exact rather than bounded, and they are arithmetic
	// rather than observation: one folding for the part, then chunks of 1,024,
	// 2,048, 4,096 … each beginning two units back inside the one before it,
	// until what is left is no longer than the next chunk would be. Four chunks
	// reach the end of 20,000 units; 1,000 units is under twice the first chunk
	// and is folded whole, as sixteen units are. A part LONGER than half the
	// floor changes the ladder to three chunks, because a chunk is never
	// narrower than twice the part.
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

	// NOTE: THE SAME LADDER ON THE VIEW ROUTE, where a folding is a call PER
	// CHARACTER — `foldedRun` folds each cluster on its own — rather than one
	// call over a whole chunk. So the count here is the number of characters the
	// search read, and it is the chunk shape that decides it: an ASCII count can
	// not see this route at all, and the two routes share no line of code.
	//
	// NOTE: Arithmetic again, for a part of three characters and a floor of
	// sixteen: chunks of 16, 32, 64 … characters, each beginning two characters
	// back inside the one before it — `separator.length - 1`, the widest a match
	// straddling the boundary can hang over it by — and the search stops at the
	// first chunk that covers the match. A match at 1,000 is in the seventh
	// chunk, so 16 + 32 + … + 1,024 = 2,032 characters are folded and three more
	// for the part: 2,035. A part that is not there reads to the END, where the
	// last chunk SWALLOWS what is left rather than leaving it to a chunk of its
	// own: nine chunks of 16 … 4,096 are 8,176 characters, the 11,842 left over
	// are folded in one, and the part is three: 20,021. Take the tail rule away
	// and that remainder is cut in two, which costs exactly the two characters of
	// one more overlap — 20,023, which this case reads as a wrong answer.
	//
	// NOTE: The backward walk is the same ladder from the other end, so a match
	// 1,000 characters from the END costs what one 1,000 from the front costs.
	// It is asserted because the two walks are written out separately — the
	// backward one re-folds a wider chunk where the forward one folds ahead of
	// itself — so nothing the forward count says holds the backward shape.
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

	// NOTE: AND WHAT A DRAIN FOLDS, which is the claim the chunks were written
	// for: a Program that cuts a character off the front of its String every
	// turn and asks each turn where a part first stands in what is LEFT used to
	// fold the whole of that String every turn, so it read n² characters in pure
	// ASCII where the case-sensitive question beside it read n. The drain is
	// driven through the runtime here — the same Functions the compiled Program
	// calls, and the same window a `slice` hands it.
	//
	// NOTE: The arithmetic, per turn. The ASCII route folds the PART (two
	// characters) and its first chunk (1,024), and the match always stands
	// inside that chunk, so a turn folds 1,026 characters and 2,200 turns fold
	// 2,257,200 — at BOTH lengths, since neither the chunk nor the distance to
	// the match knows how long the receiver is. On the view route a chunk is 16
	// and the part is folded a character at a time: a match at 14 or nearer is
	// inside the first chunk, which is 15 of the 22 positions in a period, and
	// the other 7 are inside the second chunk of 32. A period therefore folds
	// 15 × 16 + 7 × 48 = 576 characters of receiver and 2 × 22 = 44 of part, so
	// the 100 periods of this drain fold 62,000.
	//
	// NOTE: The positions are summed and asserted beside the folding, for the
	// reason every other count here is: a search that stopped answering, or
	// answered the front of the String every time, would fold beautifully.
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

		// NOTE: Each route's expected sum is worked out from ITS OWN period, so
		// that a period changed on one side can not be judged by the other's
		// arithmetic — the two happen to be the same length today, and the
		// folding figures below lean on that, which is what the first assertion
		// says out loud rather than leaving to a reader.
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
	it("finds a part near the front of any length of String at the same cost", () => {
		expectGrowthUnderThreshold(
			CONTAINS_LENGTHS,
			containsSource,
			() => `${CONTAINS_TURNS}`,
		)
	})

	it("groups one String in time proportional to its length", () => {
		expectGrowthUnderThreshold(
			GROUPED_LENGTHS,
			groupingSource,
			printedGroupedLength,
		)
	})
})
