import { describe, expect, it } from "bun:test"
import { spawnSync } from "node:child_process"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { createInteger } from "@essence-lang/runtime/Integer"
import {
	count as occurrencesOf,
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

// NOTE: Three hundred lines of thirty-six characters and a line break, which is
// the shape a Program reading text takes.
const LINES = "abcdefghijklmnopqrstuvwxyz0123456789\n".repeat(300)

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
	constant found = loop(from 1, through ${SEARCH_TURNS}, startingWith 0, step (
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
	constant characters = loop(from 1, through ${REPLACE_TURNS}, startingWith 0, step (
		_,
		count,
	) { <- count::add(text::replaceFirst("hij", with "X")::length()) })

	Terminal.print(characters)
}`
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
	it("searches a ten kilobyte String twenty thousand times without building its pieces", () => {
		expect(millisecondsToRun(searchingSource(), "0")).toBeLessThan(
			CEILING_MILLISECONDS,
		)
	})

	it("replaces the first occurrence five thousand times with two cuts", () => {
		expect(
			millisecondsToRun(
				replacingSource(),
				`${REPLACE_TURNS * (CHARACTERS - 2)}`,
			),
		).toBeLessThan(CEILING_MILLISECONDS)
	})
})
