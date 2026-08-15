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
// at a time. `remove(at 0)` on a List built by prepending shrinks the front run
// by one and shares both runs, so a whole drain moves no items at all; the
// composition it replaced sliced and rejoined the List at every step, which is
// quadratic the way the copying builds were. Measured on this machine, best of
// five, subprocess startup included in both figures: 24 ms for the drain of a
// twenty thousand item List, against 497 ms for the same Program before the
// native. The ceiling is 300 — an order of magnitude above the linear drain, so
// a far slower machine still passes, and well below what the quadratic one
// costs on a fast one.
const DRAIN_TURNS = 20_000
const DRAIN_CEILING_MILLISECONDS = 300

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
	constant built = loop(from 1, through ${TURNS}, startingWith [0], step (
		index,
		list,
	) { <- list::${method}(index) })

	Terminal.print(built::length())
}`
}

// NOTE: The List is built by prepending, so every item of it lives in the front
// run — and then it is emptied from that end, one item per turn, which is where
// the front run pays for itself. The seed carries one item that is never
// removed, so the drain runs out of turns rather than out of items and the
// printed length is one.
function drainingSource(step: string): string {
	return `implementation {
	constant built = loop(from 1, through ${DRAIN_TURNS}, startingWith [0], step (
		index,
		list,
	) { <- list::prepend(index) })

	constant drained = loop(from 1, through ${DRAIN_TURNS}, startingWith built, step (
		_,
		list,
	) { <- list::${step} })

	Terminal.print(drained::length())
}`
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

	it("drains twenty thousand items from the front in well under the quadratic time", () => {
		expect(
			millisecondsToRun(drainingSource("remove(at 0)"), "1"),
		).toBeLessThan(DRAIN_CEILING_MILLISECONDS)
	})

	// NOTE: The same drain through the stdlib Method rather than the native, and
	// a guard on a SECOND thing: `removeFirst()` is `@::slice(from 1, to
	// @::length())`, so it is only as cheap as the shrinking window `slice`
	// answers with stays cheap to ask the length of. A `length` that trimmed its
	// receiver would copy the whole front run at every turn and this would be
	// quadratic again while the one above stayed fast — 103 ms against 25 on
	// this machine, best of five, when that was measured.
	it("drains twenty thousand items through removeFirst just as fast", () => {
		expect(
			millisecondsToRun(drainingSource("removeFirst()"), "1"),
		).toBeLessThan(DRAIN_CEILING_MILLISECONDS)
	})
})
