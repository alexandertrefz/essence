import { afterAll, describe, expect, it } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import * as path from "node:path"

import { spawnAndWait } from "@essence-lang/fixtures/spawn"

// NOTE: The showcase's own tests are Essence — `Standings.es` writes a
// `tests { … }` section and `Season.tests.es` is a file of nothing else. What
// is left here is the one thing a bun spec can say that they can not: that
// `essence test` finds them, runs them and answers with the exit code CI reads.
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

// NOTE: A bundle cache of this run's own, so that a spec compiling the example
// neither answers out of the user's cache nor fills it — and a result cache
// beside it, for the same reason and one more: this spec runs `essence test` in
// the example's OWN directory, so an answer left in the user's store would be
// replayed by the next run a reader does there by hand.
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
	// NOTE: An explicit budget rather than Bun's default 5,000 ms, as
	// `client-2048.spec.ts` gives its own twin. Spawning `essence test` over
	// the example takes 1,242 ms on an idle machine and several times that on a
	// busy one, which is the only thing the default budget ever measures — the
	// work itself is bounded and deterministic.
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

			// NOTE: Every claim this program makes, and nothing about the shape
			// around them. The table's own layout is asserted by the Essence
			// tests in `Season.tests.es`, against `Table.render` directly; what
			// is left here is `Main.es`'s own reading of the season, which is
			// written nowhere a tests section can reach — a Program's body is
			// not a Method anybody can call.
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

	// NOTE: A test that fails, in a directory of its own, so that the exit code
	// CI reads is proven against a run that really did fail rather than assumed
	// from the run that passed.
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
