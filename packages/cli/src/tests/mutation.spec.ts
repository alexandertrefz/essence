import { describe, expect, it } from "bun:test"

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

// NOTE: What `essence test --mutate` ANSWERS, driven the way `testRunner.spec`
// drives the rest of the runner: a throwaway project on disk and the command
// line's own entry point over it. A mutation run is real compiles and real
// runs, so every fixture here is tiny on purpose — the question each of them
// asks is about one operator, one status or one flag.

// NOTE: A directory of this suite's own, so one left behind by a crash says
// which spec made it. The harness under it is the one `testRunner.spec` drives.
function withFiles<Value>(
	files: Record<string, string>,
	body: (directory: string) => Promise<Value>,
): Promise<Value> {
	return withProject(files, body, "essence-mutation-")
}

// NOTE: One job and one pinned seed, always. The seed is what makes a property
// test in a covering set answer the same question twice, and one job keeps the
// compile in this process — a worker would answer the same and boot a second
// copy of the Compiler to do it. Spelled apart from `mutate` because the run
// that reaches past the entry point needs exactly the same command line.
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

// NOTE: The same run, with the seam only a spec may reach. `runMutation`'s
// internals are not an Option and not an environment variable — see
// `MutationInternals` — so a spec that needs a timeout measured in
// milliseconds rather than in seconds goes through the entry point the command
// line goes through and hands them over on the way.
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

// NOTE: How many mutants were actually BUILT and asked, which is what a
// `--mutation-limit` caps — `sites` counts what the walker found, and the
// remainder between the two is what a limit left alone.
function judged(counts: Extract<TestEvent, { kind: "mutation-end" }>): number {
	return counts.killed + counts.survived + counts.hung
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

// NOTE: Two Functions, one of them tested. Every site in `untested` is one no
// test reaches, which is what makes this the fixture for both claims about
// them: that they are never compiled, and that a `--mutation-limit` leaves them
// exactly where they were.
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

// NOTE: A Namespace Method with no written test at all, whose declared return
// Type is a refinement a mutant of its body breaks for EVERY receiver. So the
// only thing that reaches it is the goal its own declaration promises, and what
// the goal answers is a fact rather than a draw.
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

// NOTE: A fixture where one mutant PROVABLY never ends. `loop(startingWith:
// while:_)` is the language's whole answer to iteration and the Optimiser
// writes it out as a real `while`, so the mutant that rotates `::isLessThan`
// into `::isGreaterThan` spins on a State the step never changes — no stack to
// overflow, no error to catch, and nothing but a timeout that ends it.
//
// NOTE: `twice` is here for the half of the claim the hang can not make on its
// own: its mutants are judged AFTER the hung one, so a run that reports them
// killed is a run whose Worker was terminated and replaced. A driver that
// terminated the thread and forgot to boot another would report them as
// anything but killed.
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

// NOTE: Long enough that nothing which actually finishes is ever called hung —
// a mutant of this fixture runs one assertion, and two seconds is a machine
// under load's worth of headroom over that — and short enough that the suite
// pays for the hang once and in full. Nothing here asserts on a clock: what is
// checked is the STATUS the run recorded and that the run went on afterwards.
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
			// NOTE: What the limit stopped is JUDGING, and it unfinds nothing:
			// the walker kept the same sites either way, and the remainder
			// between them and what was judged is what a consumer subtracts.
			expect(limited.sites).toBe(whole.sites)
		})
	})

	// NOTE: A site nothing reaches costs neither a compile nor a run, so a
	// limit — which is what a reader buys their way out of those with — has
	// nothing to say about it. Leaving them out would report a project as
	// having fewer untested lines the harder its run was narrowed, which is the
	// number moving for a reason nobody could act on.
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

	// NOTE: A mutant compares itself against the snapshots ON DISK, which the
	// driver reads once and hands to each Worker as it boots. A Worker that
	// never got them would find nothing to compare against, RECORD the mutant's
	// own answer as a first snapshot, pass, and report a survivor — so this is
	// the claim that says the stores crossed at all.
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
			// NOTE: One plain run first, because a snapshot nothing has recorded
			// is written rather than compared — which is the very answer this
			// spec has to tell apart from a store that never arrived.
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

	// NOTE: A reader comparing two scores has to be told that one of them was
	// taken over a sample — the sample is the file order, and a project's
	// hardest lines may all be in the last file.
	it("says so where the limit stopped the judging", async () => {
		await withFiles({ "Grading.es": WEAK }, async (directory) => {
			let { out } = await mutate(directory, ["--mutation-limit", "2"])

			expect(out).toContain("limit reached after 2 mutants")
			expect(out).toContain("left unjudged")
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

	// NOTE: The safety claim the whole feature rests on. A mutation tool that
	// can wait for ever is a tool that can hang a job for ever, which is worse
	// than no tool — so a mutant that does not come back is STOPPED, recorded
	// as `hung`, and the run goes on.
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
			// NOTE: The recycling, said as a fact about the ANSWERS rather than
			// about the threads: a mutant judged after the terminated one can
			// only have been killed by a Worker that was booted to replace it.
			expect(
				found
					.slice(hung + 1)
					.some((mutant) => mutant.status === "killed"),
			).toBe(true)
			expect(code).toBe(EXIT_SUCCESS)
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
			for (let flag of ["--watch", "--bench", "--coverage", "--update"]) {
				let { code, err } = await mutate(directory, [flag])

				expect(code).toBe(EXIT_USAGE)
				expect(err).toContain(`--mutate and ${flag} contradict`)
			}
		})
	})

	// NOTE: The one combination that would leave a run compiling, running and
	// reporting while answering about nothing at all — no counters, no table,
	// and every site in the project reported as one no test reaches.
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

	// NOTE: And the same refusal when the PROJECT is what left the pass out,
	// named where it was written — the reason is the counters rather than which
	// of the two spelled it, and a refusal naming a flag nobody typed would
	// send its reader looking through a command line that does not hold it.
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

	// NOTE: A focus silences most of the suite, and this run reads what RAN to
	// learn which tests reach which site — so a focused baseline reports every
	// site the silenced tests cover as one no test reaches, and takes a score
	// over whatever the focus left. Refused before a mutant is compiled.
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

		// NOTE: And under --json the stream says the same thing rather than
		// nothing. A consumer reading it used to get an empty file and an exit
		// code: no tally to end on, and no word about which test failed.
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

	// NOTE: The baseline is what the project's own `essence test` runs, goals
	// and all. A generated goal is a test like any other — it reaches sites and
	// it kills mutants — and a run that left it out would report a project that
	// tests its declarations as testing less than it does. `Tally::floor` has no
	// written test at all, so the only thing that reaches it is its own goal.
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

	// NOTE: And the setting says it without the flag, which is what a project
	// that always tests its declarations has written down. Read out of the
	// nearest essence.json, which is found from the working directory — so the
	// working directory is what has to move.
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

			// NOTE: And `--no-contracts` beats the setting, exactly as it does
			// for `essence test`: the site nothing but a goal reaches is a site
			// no test reaches again.
			let plain = mutants(
				(await mutate(directory, ["--json", "--no-contracts"])).out,
			).find((mutant) => mutant.description === "swap 0 for -1")

			expect(plain?.status).toBe("uncovered")
		})
	})
})

describe("The mutant timeout", () => {
	// NOTE: Nothing here waits for anything. The wait is a pure function of what
	// the same tests took while the code still told the truth, and that is the
	// only part of it a spec can assert without becoming a spec about a machine.
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

	// NOTE: A hang is a failure a reader would notice as surely as a red test,
	// so it counts for the tests rather than against them — three killed and one
	// hung out of four judged is a suite that caught everything.
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

	// NOTE: Which site stopped answering is the one thing the summary line can
	// not say, and it is what a reader chasing a hang needs first.
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

	// NOTE: A project that wrote down how many values a property draws did not
	// ask for a one-off run — `--cases` is what says that — so its ordinary run
	// is remembered like anybody else's. A standing setting that turned the
	// store off for ever would be a project paying for every run of it twice.
	it("remembers a run whose case count is the project's own", () => {
		expect(remembersResults(options({ cases: 200 }), 200)).toBe(true)
		expect(remembersResults(options({ cases: 10 }), 200)).toBe(false)
	})
})
