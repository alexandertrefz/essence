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

// NOTE: A subprocess rather than an import, because what is being measured is
// the Program's own wall time and a test runner's process has already paid for
// whatever it loaded — and because a build this size allocates enough that
// leaving it in the runner's heap would be felt by whatever runs next. The
// startup Bun charges for the subprocess is inside the figure, which is the
// honest direction: it makes the measurement larger, not smaller.
function millisecondsToRun(source: string): number {
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

		// NOTE: The Program prints the length it built, and it is checked here
		// — a build that threw, or one that answered a List of the wrong
		// length, would otherwise be the fastest run of all.
		expect(result.stderr).toBe("")
		expect(result.stdout.trim()).toBe(`${TURNS + 1}`)

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

describe("List performance", () => {
	it("appends sixty thousand items in under a second", () => {
		expect(millisecondsToRun(buildingSource("append"))).toBeLessThan(
			CEILING_MILLISECONDS,
		)
	})

	it("prepends sixty thousand items in under a second", () => {
		expect(millisecondsToRun(buildingSource("prepend"))).toBeLessThan(
			CEILING_MILLISECONDS,
		)
	})
})
