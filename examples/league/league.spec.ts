import { afterAll, describe, expect, it } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import * as path from "node:path"

import { spawnAndWait } from "@essence-lang/fixtures/spawn"

// The example's own tests are Essence, in `Standings.es` and `Season.tests.es`.
// This checks that `essence test` finds and runs them, and exits as CI reads.
const EXAMPLE = import.meta.dirname
const ESSENCE = path.join(
	EXAMPLE,
	"..",
	"..",
	"packages",
	"cli",
	"bin",
	"essence",
)

// Bundle and result caches of this run's own, so the spec neither reads nor
// fills the user's. It runs `essence test` in the example's directory, where a
// reader's next run would replay a stored answer.
const cache = mkdtempSync(path.join(tmpdir(), "essence-league-cache-"))
const results = mkdtempSync(path.join(tmpdir(), "essence-league-results-"))

afterAll(() => {
	rmSync(cache, { recursive: true, force: true })
	rmSync(results, { recursive: true, force: true })
})

async function test(
	directory: string,
	essenceArguments: Array<string> = [],
): Promise<{ code: number | null; out: string; err: string }> {
	let run = await spawnAndWait(
		[process.execPath, ESSENCE, "test", ...essenceArguments, "--no-color"],
		{
			cwd: directory,
			env: {
				...process.env,
				ESSENCE_CLI_CACHE: cache,
				ESSENCE_RESULTS_CACHE: results,
			},
		},
	)

	return { code: run.code, out: run.stdout, err: run.stderr }
}

describe("examples/league", () => {
	// The budget `scripts/testBudget.ts` gives every spec, written out.
	it("passes its own tests", async () => {
		let { code, out } = await test(EXAMPLE)

		expect(out).toContain("Standings.es")
		expect(out).toContain("Season.tests.es")
		expect(out).toContain("calls a level score a draw")
		expect(out).toContain("is led by Riverside")
		expect(out).not.toContain("failed")
		expect(code).toBe(0)
	}, 60_000)

	it("still compiles and runs the program itself", async () => {
		let directory = mkdtempSync(path.join(tmpdir(), "essence-league-"))

		try {
			let output = path.join(directory, "league.js")
			let build = await spawnAndWait(
				[
					process.execPath,
					ESSENCE,
					"build",
					"Main.es",
					"-o",
					output,
					"-q",
				],
				{
					cwd: EXAMPLE,
					env: {
						...process.env,
						ESSENCE_CLI_CACHE: cache,
						ESSENCE_RESULTS_CACHE: results,
					},
				},
			)

			expect(build.stderr).toBe("")
			expect(build.code).toBe(0)

			let run = await spawnAndWait([process.execPath, output])

			expect(run.stderr).toBe("")
			expect(run.code).toBe(0)

			// Every claim the program makes, not its layout, which
			// `Season.tests.es` checks against `Table.render`. A Program's body is
			// not callable, so only a run can check `Main.es`.
			let printed = run.stdout

			for (let claim of [
				"Riverside lead Harbour Rovers by 1 point.",
				"They average 15/7 points a game — 2.14 to two places",
				"Biggest win: NOR 5–0 OLD, by 5 goals.",
				"Longest unbeaten run: Riverside, 7 games.",
				"Riverside v Harbour Rovers this season:",
				"If Kestrel win 2–0",
				"Riverside would still lead.",
				"3 rows would change hands.",
				"League-wide points per game: 113/84.",
			]) {
				expect(printed).toContain(claim)
			}
		} finally {
			rmSync(directory, { recursive: true, force: true })
		}
	})

	// A failing test in a directory of its own, proving the exit code on a run
	// that really failed.
	it("exits non-zero when a test fails", async () => {
		let directory = mkdtempSync(path.join(tmpdir(), "essence-failing-"))

		try {
			writeFileSync(
				path.join(directory, "Wrong.tests.es"),
				[
					"tests {",
					'\ttest "adds two and two" {',
					"\t\texpect 2::add(2)::is(5)",
					"\t}",
					"}",
					"",
				].join("\n"),
			)

			let { code, err, out } = await test(directory)

			expect(out).toContain("1 failed")
			expect(err).toContain("test-failed")
			expect(err).toContain("adds two and two")
			expect(code).toBe(1)
		} finally {
			rmSync(directory, { recursive: true, force: true })
		}
	})
})
