import { describe, expect, it } from "bun:test"
import { existsSync, mkdirSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"

import type { TestEvent } from "@essence-lang/runtime/Testing"

import {
	EXIT_FAILURE,
	EXIT_FOCUSED,
	EXIT_SUCCESS,
	EXIT_USAGE,
} from "../actions"
import { emptyOptions, parseArguments } from "../args"
import { createContext } from "../context"
import { run } from "../index"
import {
	isInScope,
	type MutationInternals,
	mutantTimeout,
	mutationScope,
	runMutation,
} from "../mutate"
import type { ReportContext } from "../report"
import { remembersResults } from "../test"
import { type MutantRecord, renderMutation } from "../testReport"
import { capture, within, withFiles as withProject } from "./harness"

// What `essence test --mutate` answers, driven like `testRunner.spec`: a
// throwaway project and the command's own entry point. Mutation runs are real
// compiles and runs, so each fixture is tiny and asks about one thing.

// A directory of this suite's own, so one a crash leaves names its spec. The
// harness under it is the one `testRunner.spec` drives.
function withFiles<Value>(
	files: Record<string, string>,
	body: (directory: string) => Promise<Value>,
): Promise<Value> {
	return withProject(files, body, "essence-mutation-")
}

// One job and one pinned seed, always: the seed makes property tests answer the
// same twice, and one job keeps compiles in process. The run that passes
// internals needs the same command line.
function argumentsFor(
	directory: string,
	essenceArguments: Array<string>,
): Array<string> {
	return [
		"test",
		directory,
		"--mutate",
		"--jobs",
		"1",
		"--no-color",
		"--seed",
		"1234abcd",
		...essenceArguments,
	]
}

function mutate(
	directory: string,
	essenceArguments: Array<string> = [],
): Promise<{ code: number; out: string; err: string }> {
	return capture(() =>
		run(argumentsFor(directory, essenceArguments), "essence"),
	)
}

// The same run, passing `MutationInternals`, so a spec can use a timeout in
// milliseconds.
function mutateWith(
	directory: string,
	internals: MutationInternals,
	essenceArguments: Array<string> = [],
): Promise<{ code: number; out: string; err: string }> {
	return capture(() => {
		let invocation = parseArguments(
			argumentsFor(directory, essenceArguments),
			"essence",
		)

		return runMutation(
			createContext(invocation.options, "essence"),
			invocation.command,
			invocation.files,
			internals,
		)
	})
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

// How many mutants were built and judged, which `--mutation-limit` caps. `sites`
// counts every site found.
function judged(counts: Extract<TestEvent, { kind: "mutation-end" }>): number {
	return counts.killed + counts.survived + counts.hung
}

// The threshold and the comparison stand on lines of their own, so the per-line
// cap never decides which mutants exist.
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

// Two Functions, one tested. No test reaches a site in `untested`, so they are
// never compiled, and `--mutation-limit` leaves them as they are.
const UNCOVERED = [
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

// A Namespace Method without a written test whose refined return Type every
// mutant breaks for every receiver. Only its declaration's goal reaches it, and
// the goal's answer is certain.
const DECLARED = [
	"implementation {",
	"	type Tally = { count: Integer }",
	"",
	"	namespace Tally for Tally {",
	"		floor() -> NonNegativeInteger {",
	"			<- 0",
	"		}",
	"	}",
	"",
	"	function used(_ n: Integer) -> Integer {",
	"		<- n::add(1)",
	"	}",
	"}",
	"",
	"tests {",
	'	test "uses the function" {',
	"		expect used(1)::is(2)",
	"	}",
	"}",
	"",
].join("\n")

// A fixture with a mutant that provably never ends: rotating `::isLessThan` in
// a `loop` spins forever, with no stack to overflow. `twice` is judged after it,
// so killed verdicts there prove the Worker was replaced.
const SPINNING = [
	"implementation {",
	"	function settle(_ n: Integer) -> Integer {",
	"		<- loop(",
	"			startingWith n,",
	"			while (each) { <- each::isLessThan(0) },",
	"			(each) { <- each },",
	"		)",
	"	}",
	"",
	"	function twice(_ n: Integer) -> Integer {",
	"		<- n::multiply(with 2)",
	"	}",
	"}",
	"",
	"tests {",
	'	test "settles where it starts" {',
	"		expect settle(1)::is(1)",
	"	}",
	"",
	'	test "doubles what it is handed" {',
	"		expect twice(3)::is(6)",
	"	}",
	"}",
	"",
].join("\n")

// Long enough that no finishing mutant is called hung, short enough that the
// suite pays for the hang once. Only the recorded status is asserted.
const SPIN_TIMEOUT = { timeoutFor: (): number => 2_000 }

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

	// The same code under a test that pins the boundary kills every mutant.
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

	// A site nothing reaches is never compiled. The tally counts these apart, and
	// nothing outside `killed` and `survived` was built.
	it("reports a site no test reaches without compiling it", async () => {
		await withFiles({ "Halves.es": UNCOVERED }, async (directory) => {
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
			expect(counts.killed + counts.survived + counts.hung).toBe(
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

			expect(judged(whole)).toBeGreaterThan(2)
			expect(judged(limited)).toBe(2)
			// The limit stops judging but finds the same sites, so a consumer subtracts to
			// get the unjudged ones.
			expect(limited.sites).toBe(whole.sites)
		})
	})

	// An uncovered site costs neither a compile nor a run, so the limit never hides
	// one.
	it("records every uncovered site whatever the limit", async () => {
		await withFiles({ "Halves.es": UNCOVERED }, async (directory) => {
			let whole = tally((await mutate(directory, ["--json"])).out)
			let limited = (
				await mutate(directory, ["--json", "--mutation-limit", "1"])
			).out

			expect(whole.uncovered).toBeGreaterThan(0)
			expect(tally(limited).uncovered).toBe(whole.uncovered)
			expect(judged(tally(limited))).toBe(1)
			expect(
				mutants(limited).filter(
					(mutant) => mutant.status === "uncovered",
				).length,
			).toBe(whole.uncovered)
		})
	})

	// A mutant compares against the snapshots on disk, which reach each Worker as it
	// boots. Without them a mutant would record its own snapshot and survive.
	it("judges a mutant against the snapshots on disk", async () => {
		let source = [
			"implementation {",
			"	function label(_ n: Integer) -> String {",
			"		if n::isGreaterThan(1) {",
			'			<- "many"',
			"		} else {",
			'			<- "one"',
			"		}",
			"	}",
			"}",
			"",
			"tests {",
			'	test "labels a count" {',
			'		expect label(2) matches snapshot from "label"',
			"	}",
			"}",
			"",
		].join("\n")

		await withFiles({ "Label.es": source }, async (directory) => {
			// One plain run first: an unrecorded snapshot is written rather than compared.
			await capture(() =>
				run(
					["test", directory, "--jobs", "1", "--no-color"],
					"essence",
				),
			)

			let killed = mutants(
				(await mutate(directory, ["--json"])).out,
			).filter((mutant) => mutant.status === "killed")

			expect(killed.length).toBeGreaterThan(0)
			expect(
				killed.every((mutant) =>
					mutant.killedBy?.endsWith("labels a count"),
				),
			).toBe(true)
		})
	})

	// A score taken over a sample must say so: the sample is the file order.
	it("says so where the limit stopped the judging", async () => {
		await withFiles({ "Grading.es": WEAK }, async (directory) => {
			let { out } = await mutate(directory, ["--mutation-limit", "2"])

			expect(out).toContain("limit reached after 2 mutants")
			expect(out).toContain("left unjudged")
		})
	})

	// The walker never swaps onto a member the Namespace does not declare, see
	// `swappableMember`, so no mutant reads `undefined` and counts as a kill.
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

	// A property test covers the site, and every case kills the mutant, since the
	// tests section is never mutated. No seed luck is involved.
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

	// A mutant that never returns is stopped, recorded as `hung`, and the run goes
	// on. This test waits out `SPIN_TIMEOUT` within the budget
	// `scripts/testBudget.ts` gives every spec.
	it("stops a mutant that never comes back, and goes on", async () => {
		await withFiles({ "Spinning.es": SPINNING }, async (directory) => {
			let { code, out } = await mutateWith(directory, SPIN_TIMEOUT, [
				"--json",
			])
			let found = mutants(out)
			let hung = found.findIndex((mutant) => mutant.status === "hung")

			expect(found[hung]?.description).toBe(
				"swap ::isLessThan for ::isGreaterThan",
			)
			expect(tally(out).hung).toBe(1)
			// A mutant judged after the terminated one was killed by a replacement Worker.
			expect(
				found
					.slice(hung + 1)
					.some((mutant) => mutant.status === "killed"),
			).toBe(true)
			expect(code).toBe(EXIT_SUCCESS)
		})
	}, 60_000)

	// One seed, one corpus and a walk that depends only on the sources: two runs
	// write the same stream, line for line.
	it("writes the same stream twice at one seed", async () => {
		await withFiles({ "Grading.es": WEAK }, async (directory) => {
			let first = await mutate(directory, ["--json"])
			let second = await mutate(directory, ["--json"])

			expect(first.out).toEqual(second.out)
		})
	})

	it("refuses the flags it contradicts", async () => {
		await withFiles({ "Grading.es": WEAK }, async (directory) => {
			for (let flag of ["--watch", "--bench", "--coverage", "--update"]) {
				let { code, err } = await mutate(directory, [flag])

				expect(code).toBe(EXIT_USAGE)
				expect(err).toContain(`--mutate and ${flag} contradict`)
			}
		})
	})

	// Without the coverage counters every site would look unreached, so this is
	// refused.
	it("refuses to be asked for a run with the counters off", async () => {
		await withFiles({ "Grading.es": WEAK }, async (directory) => {
			let { code, err } = await mutate(directory, [
				"--without-optimisation",
				"instrument-coverage",
			])

			expect(code).toBe(EXIT_USAGE)
			expect(err).toContain(
				"--mutate and --without-optimisation instrument-coverage contradict",
			)
		})
	})

	// The same refusal when the project left the pass out, naming the setting
	// rather than a flag nobody typed.
	it("refuses the pass the project leaves out, and says where", async () => {
		await withFiles(
			{
				"Grading.es": WEAK,
				"essence.json": `{ "build": { "withoutOptimisations": ["instrument-coverage"] } }`,
			},
			async (directory) =>
				within(directory, async () => {
					let { code, err } = await mutate(directory)

					expect(code).toBe(EXIT_USAGE)
					expect(err).toContain(
						'--mutate and "build.withoutOptimisations" naming instrument-coverage contradict',
					)
				}),
		)
	})

	it("refuses --contracts beside --no-contracts", async () => {
		await withFiles({ "Grading.es": WEAK }, async (directory) => {
			let { code, err } = await mutate(directory, [
				"--contracts",
				"--no-contracts",
			])

			expect(code).toBe(EXIT_USAGE)
			expect(err).toContain("--contracts and --no-contracts contradict")
		})
	})

	// A focused baseline is refused before any mutant compiles: silenced tests would
	// leave their sites looking unreached.
	it("refuses a focused baseline", async () => {
		let source = [
			"implementation {",
			"	function passes(_ score: Integer) -> Boolean {",
			"		<- score::isGreaterThan(50)",
			"	}",
			"}",
			"",
			"tests {",
			'	test "grades a score" focused {',
			"		expect passes(90)",
			"	}",
			"",
			'	test "grades another" {',
			"		expect passes(10)::is(false)",
			"	}",
			"}",
			"",
		].join("\n")

		await withFiles({ "Grading.es": source }, async (directory) => {
			let { code, err, out } = await mutate(directory)

			expect(code).toBe(EXIT_FOCUSED)
			expect(err).toContain("grades a score")
			expect(out).not.toContain("mutants")
		})
	})

	// A failing baseline is refused, since its tests already fail.
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

		// Under `--json` the stream still ends with a tally, after the baseline's events.
		await withFiles({ "Grading.es": source }, async (directory) => {
			let { code, out } = await mutate(directory, ["--json"])
			let events = eventsOf(out)

			expect(code).toBe(EXIT_FAILURE)
			expect(events.some((event) => event.kind === "test-fail")).toBe(
				true,
			)
			expect(events[events.length - 1]?.kind).toBe("mutation-end")
			expect(tally(out).sites).toBe(0)
		})
	})

	// The baseline runs as the project's own `essence test`, goals included, and
	// goals kill mutants. `Tally::floor` has no written test, so only its goal
	// reaches it.
	it("lets a generated goal kill a mutant", async () => {
		await withFiles({ "Tally.es": DECLARED }, async (directory) => {
			let { out } = await mutate(directory, ["--json", "--contracts"])
			let killed = mutants(out).find(
				(mutant) => mutant.description === "swap 0 for -1",
			)

			expect(killed?.status).toBe("killed")
			expect(killed?.killedBy).toContain("contracts/Tally::floor()")
		})
	})

	// The setting turns goals on without the flag. It is read from the nearest
	// essence.json above the working directory, so the run starts in the project.
	it("honours a configured project's goals", async () => {
		await withFiles({ "Tally.es": DECLARED }, async (directory) => {
			await withFiles(
				{
					"Tally.es": DECLARED,
					"essence.json": `{ "test": { "contracts": true } }`,
				},
				async (configured) =>
					within(configured, async () => {
						let killed = mutants(
							(await mutate(configured, ["--json"])).out,
						).find(
							(mutant) => mutant.description === "swap 0 for -1",
						)

						expect(killed?.status).toBe("killed")
					}),
			)

			// `--no-contracts` beats the setting, so the goal-only site is unreached again.
			let plain = mutants(
				(await mutate(directory, ["--json", "--no-contracts"])).out,
			).find((mutant) => mutant.description === "swap 0 for -1")

			expect(plain?.status).toBe("uncovered")
		})
	})

	// A run a signal ends never removes its staging, so the next run sweeps every
	// directory whose process stopped. No process has the name written here.
	it("sweeps the staging a stopped run left behind", async () => {
		let left = path.join(
			tmpdir(),
			`essence-mutate-${2 ** 31 - 2}-left-by-${process.pid}`,
		)

		mkdirSync(path.join(left, "baseline"), { recursive: true })

		try {
			await withFiles({ "Grading.es": SHARP }, async (directory) => {
				let { code } = await mutate(directory)

				expect(code).toBe(EXIT_SUCCESS)
				expect(existsSync(left)).toBe(false)
			})
		} finally {
			rmSync(left, { recursive: true, force: true })
		}
	})
})

describe("The mutant timeout", () => {
	// Nothing here waits: the timeout is a pure function of the baseline's duration.
	it("never waits less than five seconds", () => {
		expect(mutantTimeout(0)).toBe(5_000)
		expect(mutantTimeout(120)).toBe(5_000)
	})

	it("waits ten times a slow baseline", () => {
		expect(mutantTimeout(900)).toBe(9_000)
		expect(mutantTimeout(4_000)).toBe(40_000)
	})
})

describe("The mutation report", () => {
	let reportContext = (verbose: boolean): ReportContext =>
		createContext({ ...emptyOptions, noColor: true, verbose }, "essence")
			.report
	let mutant = (
		status: MutantRecord["status"],
		description = "swap ::isLessThan for ::isGreaterThan",
	): MutantRecord => ({
		module: "Spinning.es",
		position: {
			start: { line: 5, column: 1 },
			end: { line: 5, column: 9 },
		},
		operator: "comparison",
		description,
		status,
		killedBy: null,
		tests: 1,
	})
	let rendered = (mutants: Array<MutantRecord>, verbose = false): string =>
		renderMutation(mutants, reportContext(verbose), () => null).join("\n")

	// A hang counts as caught, so three killed and one hung of four judged scores
	// fully.
	it("counts a hung mutant as caught", () => {
		expect(
			rendered([
				mutant("killed"),
				mutant("killed"),
				mutant("killed"),
				mutant("hung"),
			]),
		).toContain("100% caught")
	})

	it("names the hung ones only where there were any", () => {
		expect(rendered([mutant("killed"), mutant("hung")])).toContain("1 hung")
		expect(rendered([mutant("killed")])).not.toContain("hung")
	})

	// Only this line says which site hung.
	it("names where a mutant hung under --verbose", () => {
		expect(rendered([mutant("hung")], true)).toContain(
			"the run never came back, and was stopped",
		)
		expect(rendered([mutant("hung")])).not.toContain("never came back")
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

	// A glob scopes to its literal head rather than being expanded again.
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

	// A mutation run runs mutants, so it never uses the result cache, keyed by the
	// real sources.
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

	// A run at the project's configured case count is ordinary and remembered.
	// `--cases` marks a one-off.
	it("remembers a run whose case count is the project's own", () => {
		expect(remembersResults(options({ cases: 200 }), 200)).toBe(true)
		expect(remembersResults(options({ cases: 10 }), 200)).toBe(false)
	})
})
