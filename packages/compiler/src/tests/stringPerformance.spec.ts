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

// NOTE: The claims about a String that are claims about TIME, on the shape of
// `listPerformance.spec.ts`: each Program is compiled, run as a subprocess and
// timed by the wall, startup included, against a ceiling several times what
// the fast path costs and well under what the slow one cost. Every figure
// below is this harness's own, best of three, taken with the runtime before
// this package and after it.
//
// NOTE: The receiver is a 10,800-character ASCII String, because ASCII is
// what a fast path is FOR: a String the ASCII scan accepts is searched, split
// and cut by the JavaScript intrinsics, where every other String goes through
// the grapheme view. A guard on the view's own walk would be a guard on the
// Segmenter, which is not this package's claim.
const CHARACTERS = 10_800

// NOTE: `contains` is written on `firstIndex(of:)`, which used to be written
// on `split(on:)` — so a Boolean about a ten-kilobyte String segmented it and
// built a String per piece. The search is native now and reads no piece.
// Measured on this machine, best of three, subprocess startup included in
// both figures: 26 ms for twenty thousand searches against 2,150 ms before.
const SEARCH_TURNS = 20_000

// NOTE: A split of two ASCII Strings is the intrinsic's split, and the walk
// over the grapheme view it replaced compared the separator at every one of
// the receiver's positions. Measured the same way: 57 ms for five thousand
// splits of three hundred lines against 647 ms before.
const SPLIT_TURNS = 5_000

// NOTE: `replaceFirst` is written on `firstIndex(of:)` and two `slice`s, and
// `slice` cuts an ASCII String by the intrinsic rather than through the
// view. Measured the same way: 20 ms for five thousand replacements against
// 728 ms before, when it split the String and joined the pieces back.
const REPLACE_TURNS = 5_000

// NOTE: One ceiling for all three: five times the slowest of the three fast
// figures, 57 ms, and half the fastest of the three slow ones, 647 ms. A
// machine several times slower than this one still passes, and each of the
// three measured over the ceiling before this package — the search well over
// an order of magnitude over it.
const CEILING_MILLISECONDS = 300

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
		let start = performance.now()
		let result = spawnSync(process.execPath, [file], {
			encoding: "utf-8",
		})
		let elapsed = performance.now() - start

		// NOTE: Each Program prints a count that only the right answers add
		// up to, and it is checked here — a search that threw, or answered
		// the wrong position, would otherwise be the fastest run of all.
		expect(result.stderr).toBe("")
		expect(result.stdout.trim()).toBe(printed)

		return elapsed
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

// NOTE: Three hundred lines of thirty-six characters and a line break, split
// at the break — the shape a Program reading text takes — and the pieces
// counted: a trailing break leaves a final empty piece, so 301 per turn.
function splittingSource(): string {
	return `implementation {
	constant text = "abcdefghijklmnopqrstuvwxyz0123456789\\n"::repeat(times 300)
	constant pieces = loop(from 1, through ${SPLIT_TURNS}, startingWith 0, step (
		_,
		count,
	) { <- count::add(text::split(on "\\n")::length()) })

	Terminal.print(pieces)
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

describe("String performance", () => {
	it("searches a ten kilobyte String twenty thousand times without building its pieces", () => {
		expect(millisecondsToRun(searchingSource(), "0")).toBeLessThan(
			CEILING_MILLISECONDS,
		)
	})

	it("splits three hundred lines five thousand times through the intrinsic", () => {
		expect(
			millisecondsToRun(splittingSource(), `${SPLIT_TURNS * 301}`),
		).toBeLessThan(CEILING_MILLISECONDS)
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
