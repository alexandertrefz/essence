import { afterAll, describe, expect, it } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import * as path from "node:path"

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
// neither answers out of the user's cache nor fills it.
const cache = mkdtempSync(path.join(tmpdir(), "essence-league-cache-"))

afterAll(() => {
	rmSync(cache, { recursive: true, force: true })
})

function test(
	directory: string,
	essenceArguments: Array<string> = [],
): { code: number; out: string; err: string } {
	let run = Bun.spawnSync(
		[process.execPath, ESSENCE, "test", ...essenceArguments, "--no-color"],
		{
			cwd: directory,
			env: { ...process.env, ESSENCE_CLI_CACHE: cache },
			stdout: "pipe",
			stderr: "pipe",
		},
	)

	return {
		code: run.exitCode,
		out: run.stdout.toString(),
		err: run.stderr.toString(),
	}
}

describe("examples/league", () => {
	it("passes its own tests", () => {
		let { code, out } = test(EXAMPLE)

		expect(out).toContain("Standings.es")
		expect(out).toContain("Season.tests.es")
		expect(out).toContain("calls a level score a draw")
		expect(out).toContain("is led by Riverside")
		expect(out).not.toContain("failed")
		expect(code).toBe(0)
	})

	it("still compiles and runs the program itself", () => {
		let directory = mkdtempSync(path.join(tmpdir(), "essence-league-"))

		try {
			let output = path.join(directory, "league.js")
			let build = Bun.spawnSync(
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
					env: { ...process.env, ESSENCE_CLI_CACHE: cache },
					stdout: "pipe",
					stderr: "pipe",
				},
			)

			expect(build.stderr.toString()).toBe("")
			expect(build.exitCode).toBe(0)

			let run = Bun.spawnSync([process.execPath, output], {
				stdout: "pipe",
				stderr: "pipe",
			})

			expect(run.stderr.toString()).toBe("")
			expect(run.exitCode).toBe(0)

			// NOTE: Every claim this program makes, and nothing about the shape
			// around them. The table's own layout is asserted by the Essence
			// tests in `Season.tests.es`, against `Table.render` directly; what
			// is left here is `Main.es`'s own reading of the season, which is
			// written nowhere a tests section can reach — a Program's body is
			// not a Method anybody can call.
			let printed = run.stdout.toString()

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
	it("exits non-zero when a test fails", () => {
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

			let { code, err, out } = test(directory)

			expect(out).toContain("1 failed")
			expect(err).toContain("test-failed")
			expect(err).toContain("adds two and two")
			expect(code).toBe(1)
		} finally {
			rmSync(directory, { recursive: true, force: true })
		}
	})
})
