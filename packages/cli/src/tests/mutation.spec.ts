import { describe, expect, it } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"

import type { common } from "@essence-lang/interfaces"
import type { TestEvent } from "@essence-lang/runtime/Testing"

import { EXIT_FAILURE, EXIT_SUCCESS, EXIT_USAGE } from "../actions"
import { run } from "../index"
import { coveringPoints, isInScope, mutationScope } from "../mutate"
import { remembersResults } from "../test"

// NOTE: What `essence test --mutate` ANSWERS, driven the way `testRunner.spec`
// drives the rest of the runner: a throwaway project on disk and the command
// line's own entry point over it. A mutation run is real compiles and real
// runs, so every fixture here is tiny on purpose — the question each of them
// asks is about one operator, one status or one flag.

async function withFiles<Value>(
	files: Record<string, string>,
	body: (directory: string) => Promise<Value>,
): Promise<Value> {
	let directory = mkdtempSync(path.join(tmpdir(), "essence-mutation-"))

	try {
		for (let [fileName, source] of Object.entries(files)) {
			let filePath = path.join(directory, fileName)

			mkdirSync(path.dirname(filePath), { recursive: true })
			writeFileSync(filePath, source)
		}

		return await body(directory)
	} finally {
		rmSync(directory, { recursive: true, force: true })
	}
}

async function capture(
	invoke: () => Promise<number>,
): Promise<{ code: number; out: string; err: string }> {
	let out = ""
	let err = ""
	let writeOut = process.stdout.write
	let writeErr = process.stderr.write

	process.stdout.write = ((chunk: string): boolean => {
		out += chunk

		return true
	}) as typeof process.stdout.write
	process.stderr.write = ((chunk: string): boolean => {
		err += chunk

		return true
	}) as typeof process.stderr.write

	try {
		return { code: await invoke(), out, err }
	} finally {
		process.stdout.write = writeOut
		process.stderr.write = writeErr
	}
}

// NOTE: One job and one pinned seed, always. The seed is what makes a property
// test in a covering set answer the same question twice, and one job keeps the
// compile in this process — a worker would answer the same and boot a second
// copy of the Compiler to do it.
function mutate(
	directory: string,
	essenceArguments: Array<string> = [],
): Promise<{ code: number; out: string; err: string }> {
	return capture(() =>
		run(
			[
				"test",
				directory,
				"--mutate",
				"--jobs",
				"1",
				"--no-color",
				"--seed",
				"1234abcd",
				...essenceArguments,
			],
			"essence",
		),
	)
}

function eventsOf(out: string): Array<TestEvent> {
	return out
		.split("\n")
		.filter((line) => line !== "")
		.map((line) => JSON.parse(line) as TestEvent)
}

function mutants(out: string): Array<Extract<TestEvent, { kind: "mutant" }>> {
	return eventsOf(out).flatMap((event) =>
		event.kind === "mutant" ? [event] : [],
	)
}

function tally(out: string): Extract<TestEvent, { kind: "mutation-end" }> {
	let end = eventsOf(out).find((event) => event.kind === "mutation-end")

	expect(end).toBeDefined()

	return end as Extract<TestEvent, { kind: "mutation-end" }>
}

// NOTE: The threshold and the comparison on two lines of their own, so that the
// four-per-line cap leaves both operators with room. A fixture where the cap
// decides which mutants exist would be a spec about the cap.
function threshold(assertions: Array<string>): string {
	return [
		"implementation {",
		"	function passes(_ score: Integer) -> Boolean {",
		"		constant limit = 50",
		"",
		"		<- score::isGreaterThan(limit)",
		"	}",
		"}",
		"",
		"tests {",
		'	test "grades a score" {',
		...assertions.map((assertion) => `		${assertion}`),
		"	}",
		"}",
		"",
	].join("\n")
}

const WEAK = threshold(["expect passes(90)"])
const SHARP = threshold([
	"expect passes(90)",
	"expect passes(51)",
	"expect passes(50)::is(false)",
])

describe("essence test --mutate", () => {
	it("names a mutant no test notices, and still exits 0", async () => {
		await withFiles({ "Grading.es": WEAK }, async (directory) => {
			let { code, out } = await mutate(directory)

			expect(out).toContain(
				"swap ::isGreaterThan for ::isGreaterThanOrEqualTo — every test still passes",
			)
			expect(out).toContain("Grading.es:5")
			expect(code).toBe(EXIT_SUCCESS)
		})
	})

	// NOTE: The other half of the claim above, and the one that says the score
	// means anything: the same code under a test that pins the boundary kills
	// every mutant of it.
	it("kills every mutant once the test pins the boundary", async () => {
		await withFiles({ "Grading.es": SHARP }, async (directory) => {
			let { code, out } = await mutate(directory)
			let counts = tally((await mutate(directory, ["--json"])).out)

			expect(counts.survived).toBe(0)
			expect(counts.killed).toBeGreaterThan(0)
			expect(out).toContain("100% caught")
			expect(code).toBe(EXIT_SUCCESS)
		})
	})

	it("makes a survivor a failure under --strict", async () => {
		await withFiles({ "Grading.es": WEAK }, async (directory) => {
			expect((await mutate(directory, ["--strict"])).code).toBe(
				EXIT_FAILURE,
			)
		})
	})

	it("leaves a green project green under --strict", async () => {
		await withFiles({ "Grading.es": SHARP }, async (directory) => {
			expect((await mutate(directory, ["--strict"])).code).toBe(
				EXIT_SUCCESS,
			)
		})
	})

	// NOTE: A site nothing reaches is never COMPILED — it is the coverage
	// report's finding wearing mutation's hat, and paying a compile and a run to
	// be told what the counters already said would be the one cost this design
	// exists to avoid. Proven by the counts: the tally names them apart, and
	// nothing outside `killed` and `survived` was ever built.
	it("reports a site no test reaches without compiling it", async () => {
		let source = [
			"implementation {",
			"	function untested(_ n: Integer) -> Integer {",
			"		<- n::add(7)",
			"	}",
			"",
			"	function used(_ n: Integer) -> Integer {",
			"		<- n::add(1)",
			"	}",
			"}",
			"",
			"tests {",
			'	test "uses one of them" {',
			"		expect used(1)::is(2)",
			"	}",
			"}",
			"",
		].join("\n")

		await withFiles({ "Halves.es": source }, async (directory) => {
			let { out } = await mutate(directory, ["--json"])
			let counts = tally(out)
			let uncovered = mutants(out).filter(
				(mutant) => mutant.status === "uncovered",
			)

			expect(counts.uncovered).toBeGreaterThan(0)
			expect(uncovered.every((mutant) => mutant.tests === 0)).toBe(true)
			expect(
				uncovered.every((mutant) => mutant.position.start.line === 3),
			).toBe(true)
			expect(counts.killed + counts.survived).toBe(
				counts.sites - counts.uncovered - counts.invalid,
			)
		})
	})

	it("honours --mutation-limit", async () => {
		await withFiles({ "Grading.es": WEAK }, async (directory) => {
			let whole = tally((await mutate(directory, ["--json"])).out)
			let limited = tally(
				(await mutate(directory, ["--json", "--mutation-limit", "2"]))
					.out,
			)

			expect(whole.killed + whole.survived).toBeGreaterThan(2)
			expect(limited.killed + limited.survived).toBe(2)
		})
	})

	// NOTE: The walker refuses a swap onto a member the Namespace does not
	// declare — see `swappableMember`. A Namespace that writes `is` and no
	// `isNot` is the plain case, and what it must never produce is a mutant
	// that emits a read of `undefined` and is counted as a kill.
	it("offers no swap onto a member the Namespace has not got", async () => {
		let source = [
			"implementation {",
			"	type Box = { size: Integer }",
			"",
			"	namespace Box for Box {",
			"		is(_ other: Box) -> Boolean {",
			"			<- @.size::isGreaterThanOrEqualTo(other.size)",
			"		}",
			"	}",
			"",
			"	function same(_ left: Box, _ right: Box) -> Boolean {",
			"		<- left::is(right)",
			"	}",
			"}",
			"",
			"tests {",
			'	test "compares boxes" {',
			"		expect same({ size = 1 }, { size = 1 })",
			"	}",
			"}",
			"",
		].join("\n")

		await withFiles({ "Boxes.es": source }, async (directory) => {
			let found = mutants((await mutate(directory, ["--json"])).out)

			expect(found.length).toBeGreaterThan(0)
			expect(
				found.some(
					(mutant) =>
						mutant.description === "swap ::is for ::isNot" &&
						mutant.position.start.line === 11,
				),
			).toBe(false)
			expect(found.every((mutant) => mutant.status !== "invalid")).toBe(
				true,
			)
		})
	})

	// NOTE: A property test in the covering set, and a fixture where EVERY case
	// it could draw kills the mutant — the test's own `n::add(1)` is in the
	// tests section, which is never mutated, so a mutated `increment` disagrees
	// with it for every Integer there is. No seed luck, and therefore no flake.
	it("lets a property test kill a mutant at the run's pinned seed", async () => {
		let source = [
			"implementation {",
			"	function increment(_ n: Integer) -> Integer {",
			"		<- n::add(1)",
			"	}",
			"}",
			"",
			"tests {",
			'	test "adds one" for any (n: Integer) {',
			"		expect increment(n)::is(n::add(1))",
			"	}",
			"}",
			"",
		].join("\n")

		await withFiles({ "Counting.es": source }, async (directory) => {
			let counts = tally((await mutate(directory, ["--json"])).out)

			expect(counts.killed).toBeGreaterThan(0)
			expect(counts.survived).toBe(0)
		})
	})

	// NOTE: THE reproducibility claim. One seed, one pinned corpus and a walk
	// that is a function of the sources: two runs are the same stream, line for
	// line, or nothing a mutation score says can be compared between runs.
	it("writes the same stream twice at one seed", async () => {
		await withFiles({ "Grading.es": WEAK }, async (directory) => {
			let first = await mutate(directory, ["--json"])
			let second = await mutate(directory, ["--json"])

			expect(first.out).toEqual(second.out)
		})
	})

	it("refuses the flags it contradicts", async () => {
		await withFiles({ "Grading.es": WEAK }, async (directory) => {
			for (let flag of [
				"--watch",
				"--bench",
				"--coverage",
				"--update",
				"--contracts",
			]) {
				let { code, err } = await mutate(directory, [flag])

				expect(code).toBe(EXIT_USAGE)
				expect(err).toContain(`--mutate and ${flag} contradict`)
			}
		})
	})

	// NOTE: A baseline that does not pass is a run with nothing to say: every
	// mutant of it would be judged by tests that already fail.
	it("refuses a baseline that does not pass", async () => {
		let source = [
			"implementation {",
			"	function passes(_ score: Integer) -> Boolean {",
			"		<- score::isGreaterThan(50)",
			"	}",
			"}",
			"",
			"tests {",
			'	test "is wrong about the boundary" {',
			"		expect passes(10)",
			"	}",
			"}",
			"",
		].join("\n")

		await withFiles({ "Grading.es": source }, async (directory) => {
			let { code, err } = await mutate(directory)

			expect(code).toBe(EXIT_FAILURE)
			expect(err).toContain("a baseline that passes")
		})
	})
})

describe("The attribution join", () => {
	let at = (
		startLine: number,
		startColumn: number,
		endLine: number,
		endColumn: number,
	): common.Position => ({
		start: { line: startLine, column: startColumn },
		end: { line: endLine, column: endColumn },
	})

	it("takes every point whose span holds the site", () => {
		let points = [at(1, 1, 9, 1), at(3, 1, 3, 20), at(20, 1, 20, 5)]

		expect(coveringPoints(points, at(3, 4, 3, 10))).toEqual([0, 1])
	})

	// NOTE: The fallback, and the reason it is the SMALLEST overlap: a site the
	// Simplifier trimmed differently from the Node the counter stands in front
	// of overlaps rather than nests, and answering with nothing would report a
	// well-tested site as one no test reaches.
	it("falls back to the smallest overlapping span", () => {
		let points = [at(1, 1, 4, 30), at(3, 1, 4, 8), at(9, 1, 9, 5)]

		expect(coveringPoints(points, at(4, 6, 5, 2))).toEqual([1])
	})

	it("answers with nothing where no point comes near", () => {
		let points = [at(1, 1, 2, 4), at(9, 1, 9, 5)]

		expect(coveringPoints(points, at(5, 1, 5, 9))).toEqual([])
	})
})

describe("The mutation scope", () => {
	it("mutates everything where nothing was named", () => {
		expect(isInScope("/project/src/Standings.es", [])).toBe(true)
	})

	it("keeps a named file and nothing beside it", () => {
		let scope = mutationScope(["src/Standings.es"], "/project")

		expect(isInScope("/project/src/Standings.es", scope)).toBe(true)
		expect(isInScope("/project/src/Season.es", scope)).toBe(false)
	})

	it("keeps everything under a named directory", () => {
		let scope = mutationScope(["src"], "/project")

		expect(isInScope("/project/src/Standings.es", scope)).toBe(true)
		expect(isInScope("/project/other/Season.es", scope)).toBe(false)
	})

	// NOTE: A glob is read down to its literal head rather than expanded a
	// second time — what is being answered is "is this Module one the reader
	// pointed at", and the head is what they pointed at.
	it("reads a glob down to the directory it names", () => {
		let scope = mutationScope(["src/*.es"], "/project")

		expect(isInScope("/project/src/Standings.es", scope)).toBe(true)
		expect(isInScope("/project/other/Season.es", scope)).toBe(false)
	})
})

describe("The result cache", () => {
	let options = (
		overrides: Partial<Parameters<typeof remembersResults>[0]> = {},
	): Parameters<typeof remembersResults>[0] => ({
		update: false,
		coverage: false,
		bench: false,
		mutate: false,
		seed: undefined,
		cases: null,
		...overrides,
	})

	it("remembers an ordinary run", () => {
		expect(remembersResults(options())).toBe(true)
	})

	// NOTE: What a mutation run RUNS is a mutant — an entry compiled from a lie
	// about the sources — and a record keyed by the bundle hash of the real ones
	// would claim those tests passed against the code as written.
	it("remembers nothing out of a mutation run", () => {
		expect(remembersResults(options({ mutate: true }))).toBe(false)
	})

	it("remembers nothing out of the runs that write files", () => {
		expect(remembersResults(options({ update: true }))).toBe(false)
		expect(remembersResults(options({ coverage: true }))).toBe(false)
		expect(remembersResults(options({ bench: true }))).toBe(false)
	})

	it("remembers nothing out of a run that says which values to draw", () => {
		expect(remembersResults(options({ seed: "1234abcd" }))).toBe(false)
		expect(remembersResults(options({ cases: 10 }))).toBe(false)
	})
})
