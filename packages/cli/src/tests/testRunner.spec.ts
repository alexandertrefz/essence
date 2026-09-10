import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { spawnSync } from "node:child_process"
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"

import { readProjectConfiguration } from "@essence-lang/compiler/configuration"
import type { TestEvent } from "@essence-lang/runtime/Testing"

import { EXIT_FAILURE, EXIT_FOCUSED, EXIT_SUCCESS } from "../actions"
import { parseArguments, UsageError } from "../args"
import { findCommand } from "../commands"
import { createContext } from "../context"
import { discoverTestFiles, namesTests } from "../discovery"
import { run } from "../index"
import type { ReportContext } from "../report"
import { resolveContracts, resolveFilters } from "../test"
import {
	collectTestRun,
	focusedTestsDiagnostic,
	renderTestFailures,
	renderTestSummary,
	renderTestTree,
	testFailureDiagnostic,
} from "../testReport"
import { createPalette, createTheme } from "../theme"
import { capture, within, withFiles as withProject } from "./harness"

// NOTE: A bundle cache of this spec's own, and a result cache beside it. They
// are assigned rather than exported because where a cache lives is read off the
// environment every time it is asked for, and restored afterwards so that a
// suite running beside this one keeps the directories it named.
//
// NOTE: Directories rather than `off` for both, so that what these specs drive
// is what a reader's own `essence test` does — including the store a second run
// answers out of. Nothing here may reach the user's caches: a spec that filled
// one would make the next real run replay a fixture, and a spec that read one
// would answer out of a project it has never seen.
let bundleCache = mkdtempSync(path.join(tmpdir(), "essence-test-cache-"))
let resultCache = mkdtempSync(path.join(tmpdir(), "essence-test-results-"))
let previousCache: string | undefined
let previousResults: string | undefined

beforeAll(() => {
	previousCache = process.env.ESSENCE_CLI_CACHE
	previousResults = process.env.ESSENCE_RESULTS_CACHE
	process.env.ESSENCE_CLI_CACHE = bundleCache
	process.env.ESSENCE_RESULTS_CACHE = resultCache
})

afterAll(() => {
	if (previousCache === undefined) {
		delete process.env.ESSENCE_CLI_CACHE
	} else {
		process.env.ESSENCE_CLI_CACHE = previousCache
	}

	if (previousResults === undefined) {
		delete process.env.ESSENCE_RESULTS_CACHE
	} else {
		process.env.ESSENCE_RESULTS_CACHE = previousResults
	}

	rmSync(bundleCache, { recursive: true, force: true })
	rmSync(resultCache, { recursive: true, force: true })
})

const testCommand = findCommand("test") as NonNullable<
	ReturnType<typeof findCommand>
>

const reportContext: ReportContext = {
	terminal: {
		stdout: process.stdout,
		stderr: process.stderr,
		isInteractive: false,
		width: 80,
		out: () => {},
		err: () => {},
	},
	theme: createTheme(false, true),
	palette: createPalette(createTheme(false, true)),
	verbose: false,
	quiet: false,
}

// NOTE: A directory of this suite's own, so one left behind by a crash says
// which spec made it. The harness under it is the one `mutation.spec` drives.
function withFiles<Value>(
	files: Record<string, string>,
	body: (directory: string) => Promise<Value>,
): Promise<Value> {
	return withProject(files, body, "essence-tests-")
}

// NOTE: One job unless a test asks for more. What a run of this suite is about
// is what `essence test` REPORTS, and every worker it boots is a thread that
// imports the Compiler to answer the same thing the main one would have — so
// the default stays here, and the one test that is about the pool itself names
// its own.
function runTests(
	directory: string,
	essenceArguments: Array<string> = [],
	jobs = "1",
): Promise<{ code: number; out: string; err: string }> {
	return capture(() =>
		run(
			[
				"test",
				directory,
				"--jobs",
				jobs,
				"--no-color",
				...essenceArguments,
			],
			"essence",
		),
	)
}

const passing = [
	"implementation {",
	"\tfunction double(_ value: Integer) -> Integer {",
	"\t\t<- value::multiply(with 2)",
	"\t}",
	"}",
	"",
	"tests {",
	'\tsuite "double" {',
	'\t\ttest "doubles a positive number" {',
	"\t\t\texpect double(2)::is(4)",
	"\t\t}",
	"",
	'\t\ttest "is slow" tagged slow {',
	"\t\t\texpect double(1)::is(2)",
	"\t\t}",
	"",
	'\t\ttest "waits on the redesign" skipped "not written yet" {',
	"\t\t\texpect double(1)::is(2)",
	"\t\t}",
	"\t}",
	"}",
	"",
].join("\n")

// NOTE: A tests section that does not COMPILE, rather than one that fails.
const broken = [
	"tests {",
	'\ttest "asserts a String" {',
	'\t\texpect "not a Boolean"',
	"\t}",
	"}",
	"",
].join("\n")

const failing = [
	"tests {",
	'\ttest "adds two and two" {',
	"\t\texpect 2::add(2)::is(5)",
	"\t}",
	"}",
	"",
].join("\n")

// NOTE: A table test whose row is not a value of what its Parameter declares,
// and whose NAME interpolates that row. Nothing but the Enricher ever checks a
// row, and this shape of a mistyped one did not merely fail: the name asked
// `Rational::toString` how to print an Integer before the body had run at all,
// and the reduction of a pair of members it does not carry spun forever.
const interpolatedRow = [
	"implementation {}",
	"",
	"tests {",
	'\ttest "row {value}" across [',
	"\t\t{ value = 3 },",
	"\t] ({ value }: { value: Rational }) {",
	"\t\texpect value::isNot(0/1)",
	"\t}",
	"}",
	"",
].join("\n")

// NOTE: A Module another one imports from, so that two entries reach one
// tests section.
const exporting = [
	"implementation {",
	"\tfunction double(_ value: Integer) -> Integer {",
	"\t\t<- value::multiply(with 2)",
	"\t}",
	"",
	"\tconstant doubled = double(2)",
	"}",
	"",
	"export {",
	"\tdoubled",
	"}",
	"",
	"tests {",
	'\ttest "doubles a positive number" {',
	"\t\texpect double(2)::is(4)",
	"\t}",
	"}",
	"",
].join("\n")

const importing = [
	"import {",
	'\tfrom "./Rules.es" { doubled }',
	"}",
	"",
	"tests {",
	'\ttest "reads the exported value" {',
	"\t\texpect doubled::is(4)",
	"\t}",
	"}",
	"",
].join("\n")

const focused = [
	"tests {",
	'\ttest "runs" focused {',
	"\t\texpect true",
	"\t}",
	"",
	'\ttest "does not" {',
	"\t\texpect true",
	"\t}",
	"}",
	"",
].join("\n")

// NOTE: A name worked out where the test stands, so that what a report calls a
// test can be checked against what it is called when it never runs.
const interpolated = [
	"tests {",
	"\tconstant scored = 2",
	"",
	'\ttest "{scored} goals is a win" {',
	"\t\texpect scored::is(2)",
	"\t}",
	"}",
	"",
].join("\n")

// #region Discovery

describe("essence test — discovery", () => {
	it("recognises a file named after the Module it tests", () => {
		expect(namesTests("/project/Season.tests.es")).toBe(true)
		expect(namesTests("/project/Season.es")).toBe(false)
		expect(namesTests("/project/tests.es")).toBe(false)
	})

	it("finds every Module with a tests section under a directory", async () => {
		await withFiles(
			{
				"Rules.es": passing,
				"Plain.es": "implementation {}\n",
				"nested/More.tests.es": failing,
			},
			async (directory) => {
				let found = await discoverTestFiles(
					[],
					testCommand,
					"essence",
					directory,
				)

				expect(found.map((file) => path.basename(file))).toEqual([
					"Rules.es",
					"More.tests.es",
				])
			},
		)
	})

	it("never descends into node_modules or a build directory", async () => {
		await withFiles(
			{
				"Rules.es": passing,
				"node_modules/pkg/Vendor.tests.es": failing,
				"dist/Built.tests.es": failing,
			},
			async (directory) => {
				let found = await discoverTestFiles(
					[],
					testCommand,
					"essence",
					directory,
				)

				expect(found.map((file) => path.basename(file))).toEqual([
					"Rules.es",
				])
			},
		)
	})

	// NOTE: `tests` is a contextual keyword, so a walk answers by PARSING —
	// with a read of the text first, which can only rule a file out.
	it("leaves a file that merely writes the word alone", async () => {
		await withFiles(
			{
				"Named.es": "implementation {\n\tconstant tests = 1\n}\n",
				"Silent.es": "implementation {}\n",
				"Rules.es": passing,
			},
			async (directory) => {
				let found = await discoverTestFiles(
					[],
					testCommand,
					"essence",
					directory,
				)

				expect(found.map((file) => path.basename(file))).toEqual([
					"Rules.es",
				])
			},
		)
	})

	it("keeps a named file that does not parse, so the compile reports it", async () => {
		await withFiles(
			{ "Broken.es": "implementation { constant x = }\n" },
			async (directory) => {
				let broken = path.join(directory, "Broken.es")

				expect(
					await discoverTestFiles([broken], testCommand, "essence"),
				).toHaveLength(1)

				// NOTE: The same file nobody named is left alone — an unrelated
				// broken source under the working directory is not what
				// `essence test` was asked about.
				expect(
					await discoverTestFiles(
						[],
						testCommand,
						"essence",
						directory,
					),
				).toEqual([])
			},
		)
	})

	it("reads a named directory and a glob against the working directory", async () => {
		await withFiles(
			{
				"rules/Rules.es": passing,
				"rules/Plain.es": "implementation {}\n",
				"Season.tests.es": failing,
			},
			async (directory) => {
				expect(
					(
						await discoverTestFiles(
							["rules"],
							testCommand,
							"essence",
							directory,
						)
					).map((file) => path.basename(file)),
				).toEqual(["Rules.es"])

				expect(
					(
						await discoverTestFiles(
							["*.tests.es"],
							testCommand,
							"essence",
							directory,
						)
					).map((file) => path.basename(file)),
				).toEqual(["Season.tests.es"])
			},
		)
	})

	it("refuses a pattern that matches nothing", async () => {
		let discovery = discoverTestFiles(
			["no-such-directory/*.es"],
			testCommand,
			"essence",
		)

		await expect(discovery).rejects.toBeInstanceOf(UsageError)
	})
})

// #endregion

// #region Configuration

describe("essence test — project configuration", () => {
	// NOTE: Every project holds sources that are not its own tests — a corpus
	// of deliberately broken files is the one this repository holds, and it is
	// what made `essence test` unrunnable at its own root. What the file itself
	// reads, and how a mistake in it is reported, is the Compiler's own spec;
	// what is here is what the COMMAND does with the answer.
	it("stays out of the directories a project excludes", async () => {
		await withFiles(
			{
				"essence.json": `{ "exclude": ["broken"] }`,
				"Rules.es": passing,
				"broken/Bad.tests.es": broken,
			},
			async (directory) => {
				let configuration = readProjectConfiguration(directory)
				let found = await discoverTestFiles(
					[],
					testCommand,
					"essence",
					directory,
					configuration.exclude,
				)

				expect(found.map((each) => path.basename(each))).toEqual([
					"Rules.es",
				])
			},
		)
	})

	// NOTE: A file asked about BY NAME is answered about. The setting narrows
	// the search, which is the half nobody asked for.
	it("still compiles an excluded file that was named", async () => {
		await withFiles(
			{
				"essence.json": `{ "exclude": ["broken"] }`,
				"broken/Bad.tests.es": broken,
			},
			async (directory) => {
				let configuration = readProjectConfiguration(directory)
				let found = await discoverTestFiles(
					[path.join(directory, "broken", "Bad.tests.es")],
					testCommand,
					"essence",
					directory,
					configuration.exclude,
				)

				expect(found).toHaveLength(1)
			},
		)
	})

	// NOTE: The whole point of configuring a default: a project that skips
	// `slow` every day is a project where the nightly job asks for it by name.
	it("lets --tag ask for a tag the project skips by default", () => {
		expect(
			resolveFilters({ filter: undefined, tag: ["slow"], skipTag: [] }, [
				"slow",
			]),
		).toEqual({
			filter: null,
			tags: ["slow"],
			skipTags: [],
			bench: false,
		})

		expect(
			resolveFilters({ filter: undefined, tag: [], skipTag: [] }, [
				"slow",
			]),
		).toEqual({
			filter: null,
			tags: [],
			skipTags: ["slow"],
			bench: false,
		})
	})

	// NOTE: And the goals are a union with the setting, which `--no-contracts`
	// beats in either direction — a project that always tests its declarations
	// still gets a plain run on demand.
	it("unions the goals with the setting, and lets one run out", () => {
		let flags = { contracts: false, noContracts: false }

		expect(resolveContracts(flags, true)).toBe(true)
		expect(resolveContracts({ ...flags, contracts: true }, false)).toBe(
			true,
		)
		expect(resolveContracts({ ...flags, noContracts: true }, true)).toBe(
			false,
		)
		expect(resolveContracts(flags, false)).toBe(false)
	})

	// NOTE: What the settings could not be read out of is a Warning with a
	// span, rendered by the renderer every other Diagnostic goes through and
	// printed ahead of the run — which happens anyway, with that setting at its
	// default. The manifest key is the one a project moving to `essence.json`
	// is most likely to still be holding.
	it("renders what it could not read, and runs the project anyway", async () => {
		await withFiles(
			{
				"essence.json": `{ "test": { "skipTags": ["slow"] } }`,
				"package.json": `{\n\t"name": "old",\n\t"essence": { "exclude": ["broken"] }\n}`,
				"Rules.es": passing,
			},
			async (directory) =>
				within(directory, async () => {
					let { code, err, out } = await runTests(directory)

					expect(err).toContain("moved-setting")
					expect(err).toContain(
						'The "essence" key of package.json has moved to essence.json',
					)
					expect(err).toContain("package.json")
					expect(out).toContain("1 passed")
					expect(out).toContain("1 deselected")
					expect(code).toBe(EXIT_SUCCESS)
				}),
		)
	})

	// NOTE: And under `--verbose`, which file the settings came from — the
	// question a project with more than one of them asks first.
	it("names the file the settings came from under --verbose", async () => {
		await withFiles(
			{ "essence.json": `{}`, "Rules.es": passing },
			async (directory) =>
				within(directory, async () => {
					let { err } = await runTests(directory, ["--verbose"])

					expect(err).toContain("settings read from")
					expect(err).toContain("essence.json")
				}),
		)
	})
})

// #endregion

// #region Arguments

describe("essence test — arguments", () => {
	it("reads the filter and both tag flags", () => {
		let invocation = parseArguments(
			[
				"test",
				"Rules.es",
				"-f",
				"leader",
				"--tag",
				"slow",
				"--tag",
				"network",
				"--skip-tag",
				"flaky",
			],
			"essence",
		)

		expect(invocation.command.name).toBe("test")
		expect(invocation.files).toEqual(["Rules.es"])
		expect(invocation.options.filter).toBe("leader")
		expect(invocation.options.tag).toEqual(["slow", "network"])
		expect(invocation.options.skipTag).toEqual(["flaky"])
	})

	it("refuses a tag that could never have been written", () => {
		expect(() =>
			parseArguments(["test", "--tag", "Slow"], "essence"),
		).toThrow(UsageError)
	})
})

// #endregion

// #region Running

describe("essence test — running", () => {
	it("runs the tests it finds and exits zero", async () => {
		await withFiles({ "Rules.es": passing }, async (directory) => {
			let { code, out } = await runTests(directory)

			expect(out).toContain("doubles a positive number")
			expect(out).toContain("skipped: not written yet")
			expect(out).toContain("2 passed")
			expect(out).toContain("1 skipped")
			expect(code).toBe(EXIT_SUCCESS)
		})
	})

	it("exits one when a test fails, and says why in a Diagnostic", async () => {
		await withFiles({ "Wrong.tests.es": failing }, async (directory) => {
			let { code, err, out } = await runTests(directory)

			expect(out).toContain("1 failed")
			expect(err).toContain("test-failed")
			expect(err).toContain("'adds two and two' failed")
			expect(err).toContain("`is` compared 4 with 5")
			expect(code).toBe(EXIT_FAILURE)
		})
	})

	// NOTE: The refusal names every test the focus was left on, as an ordinary
	// Diagnostic over the source — "which ones" is the whole question a person
	// asks when they read it.
	it("runs only the focused tests, and exits two in a plain run", async () => {
		await withFiles({ "Focus.tests.es": focused }, async (directory) => {
			let { code, err, out } = await runTests(directory)

			expect(out).toContain("1 passed")
			expect(out).toContain("1 not focused")
			expect(err).toContain("focused-tests-remain")
			expect(err).toContain("This test is still focused")
			expect(err).toContain('test "runs" focused {')
			expect(code).toBe(EXIT_FOCUSED)
		})
	})

	// NOTE: Focusing while iterating is ordinary working practice; it is only a
	// run nobody narrowed that a leftover `focused` may not survive.
	it("says nothing about focus under a filter", async () => {
		await withFiles({ "Focus.tests.es": focused }, async (directory) => {
			let { code, err } = await runTests(directory, ["-f", "runs"])

			expect(err).not.toContain("focused-tests-remain")
			expect(code).toBe(EXIT_SUCCESS)
		})
	})

	// NOTE: Three tests are not focused — the one beside the focus, and the two
	// of the other file that are not skipped — and the skipped one still
	// reports as skipped, because what a test says about itself is read before
	// what the run says about the rest.
	it("silences a whole file when another one holds the focus", async () => {
		await withFiles(
			{ "Focus.tests.es": focused, "Rules.es": passing },
			async (directory) => {
				let { code, out } = await runTests(directory)

				expect(out).toContain("1 passed")
				expect(out).toContain("3 not focused")
				expect(out).toContain("1 skipped")
				expect(code).toBe(EXIT_FOCUSED)
			},
		)
	})

	// NOTE: A test silenced by another file's focus is reported by the name it
	// would have run under, not by the template it was written as — the runtime
	// works both out the same way, which is why the CLI hands the whole run to
	// it rather than writing the deselections itself.
	it("names a silenced test the way a run would have named it", async () => {
		await withFiles(
			{
				"Focus.tests.es": focused,
				"Rendered.tests.es": interpolated,
			},
			async (directory) => {
				let { out } = await runTests(directory, ["--verbose"])

				expect(out).toContain("2 goals is a win")
				expect(out).not.toContain("{scored} goals is a win")
			},
		)
	})

	it("leaves out a tag it was told to skip, and counts it", async () => {
		await withFiles({ "Rules.es": passing }, async (directory) => {
			let { code, out } = await runTests(directory, [
				"--skip-tag",
				"slow",
			])

			expect(out).toContain("1 passed")
			expect(out).toContain("1 deselected")
			expect(code).toBe(EXIT_SUCCESS)
		})
	})

	it("runs only a tag it was asked for", async () => {
		await withFiles({ "Rules.es": passing }, async (directory) => {
			let { out } = await runTests(directory, ["--tag", "slow"])

			expect(out).toContain("is slow")
			expect(out).not.toContain("doubles a positive number")
			expect(out).toContain("1 passed")
		})
	})

	it("warns about a tag no test carries", async () => {
		await withFiles({ "Rules.es": passing }, async (directory) => {
			let { err } = await runTests(directory, ["--tag", "slwo"])

			expect(err).toContain('no test carries tag "slwo"')
		})
	})

	it("filters by a substring of the name", async () => {
		await withFiles({ "Rules.es": passing }, async (directory) => {
			let { out } = await runTests(directory, ["-f", "positive"])

			expect(out).toContain("doubles a positive number")
			expect(out).not.toContain("is slow")
			expect(out).toContain("1 passed")
		})
	})

	// NOTE: Both files are entries, and the graph of the second holds the
	// first, so both bundles carry the first Module's manifest. Running it
	// twice would report every test of every shared Module once per entry that
	// reaches it.
	it("runs a Module's tests once however many entries reach it", async () => {
		await withFiles(
			{ "Rules.es": exporting, "Rules.tests.es": importing },
			async (directory) => {
				let { code, out } = await runTests(directory)
				let occurrences = out.split("doubles a positive number").length

				expect(occurrences).toBe(2)
				expect(out).toContain("reads the exported value")
				expect(out).toContain("2 passed")
				expect(code).toBe(EXIT_SUCCESS)
			},
		)
	})

	// NOTE: The same run through the worker pool, which is what an ordinary
	// project gets — six entries reach for workers on their own, and `--jobs`
	// reaches for them at any size. A worker is opened in the run's MODE, and a
	// pool that opened its workers as builds compiled every file of a test run
	// without the section the run exists to check: a whole project reported as
	// having nothing to run, and an `unused-import` about a Type only its tests
	// read. Three entries in two graphs, so the batch is spread over two
	// workers and the shared Module still reports its tests once.
	it("runs the tests of a batch compiled in workers", async () => {
		await withFiles(
			{
				"Rules.es": exporting,
				"Rules.tests.es": importing,
				"Rendered.tests.es": interpolated,
			},
			async (directory) => {
				let { code, out } = await runTests(directory, [], "2")
				let occurrences = out.split("doubles a positive number").length

				expect(occurrences).toBe(2)
				expect(out).toContain("reads the exported value")
				expect(out).toContain("2 goals is a win")
				expect(out).toContain("3 passed")
				expect(code).toBe(EXIT_SUCCESS)
			},
		)
	})

	it("says so when there is nothing to run", async () => {
		await withFiles(
			{ "Plain.es": "implementation {}\n" },
			async (directory) => {
				let { code, out } = await runTests(directory)

				expect(out).toContain("no tests")
				expect(code).toBe(EXIT_SUCCESS)
			},
		)
	})

	// NOTE: A project with one half-typed file in it is exactly the project
	// whose other twenty files are worth hearing about, so the broken entry is
	// named and left out and the rest of the run happens. The run still ends
	// non-zero: something in it could not be compiled.
	it("reports a compile error, leaves that entry out and runs the rest", async () => {
		await withFiles(
			{
				"Broken.tests.es": broken,
				"Rules.es": passing,
			},
			async (directory) => {
				let { code, err, out } = await runTests(directory)

				expect(err).toContain("expect-not-boolean")
				expect(err).toContain("Broken.tests.es did not compile")
				expect(out).toContain("doubles a positive number")
				expect(code).toBe(EXIT_FAILURE)
			},
		)
	})

	// NOTE: Spawned rather than run in process, and on a clock. What this is
	// about is a run that FINISHES, and the hang it guards against was a
	// synchronous loop on the very thread a spec runs on — an in-process one
	// would take the whole suite down with it instead of failing, and no
	// timeout a test runner offers can interrupt a loop that never yields.
	it("finishes on a mistyped row a test name interpolates", async () => {
		await withFiles(
			{ "Rows.tests.es": interpolatedRow },
			async (directory) => {
				let binary = fileURLToPath(
					import.meta.resolve("../../bin/essence"),
				)
				let result = spawnSync(
					process.execPath,
					[binary, "test", directory, "--no-color", "--jobs", "1"],
					{
						encoding: "utf-8",
						env: { ...process.env },
						timeout: 60_000,
						// NOTE: The loop this guards against yields to
						// nothing, so the child is killed outright rather
						// than asked to stop.
						killSignal: "SIGKILL",
					},
				)

				// NOTE: A killed child is the hang itself — `status` is null
				// there, so the exit code below would pass it by.
				expect(result.signal).toBeNull()
				expect(result.stderr).toContain("table-row-type-mismatch")
				expect(result.stderr).toContain("did not compile")
				expect(result.status).toBe(EXIT_FAILURE)
			},
		)
	})

	// NOTE: The stream is bracketed whatever happened, because a consumer
	// reading it a line at a time has nothing else to tell it the run is over.
	it("brackets the event stream when an entry did not compile", async () => {
		await withFiles(
			{
				"Broken.tests.es": broken,
				"Rules.es": passing,
			},
			async (directory) => {
				let { code, out } = await runTests(directory, ["--json"])
				let events = out
					.split("\n")
					.filter((line) => line !== "")
					.map((line) => JSON.parse(line) as TestEvent)

				expect(events[0]?.kind).toBe("run-start")
				expect(events.at(-1)?.kind).toBe("run-end")
				expect(
					events.some(
						(event) =>
							event.kind === "test-pass" &&
							event.name === "doubles a positive number",
					),
				).toBe(true)
				expect(code).toBe(EXIT_FAILURE)
			},
		)
	})

	it("prints only Diagnostics under --quiet", async () => {
		await withFiles({ "Wrong.tests.es": failing }, async (directory) => {
			let { code, err, out } = await runTests(directory, ["--quiet"])

			expect(out).toBe("")
			expect(err).toContain("test-failed")
			expect(code).toBe(EXIT_FAILURE)
		})
	})
})

// #endregion

// #region The event stream

// NOTE: `check` is the command a project runs to be told whether it is
// correct. A build drops the tests section, and a gate that answered about less
// than the editor does would pass a file the next step can not compile.
describe("essence check — the tests section", () => {
	it("reports what a tests section says that does not compile", async () => {
		await withFiles({ "Broken.tests.es": broken }, async (directory) => {
			let { code, err } = await capture(() =>
				run(
					[
						"check",
						path.join(directory, "Broken.tests.es"),
						"--no-color",
					],
					"essence",
				),
			)

			expect(err).toContain("expect-not-boolean")
			expect(code).toBe(EXIT_FAILURE)
		})
	})

	it("says nothing about a file whose tests are fine", async () => {
		await withFiles({ "Rules.es": passing }, async (directory) => {
			let { code } = await capture(() =>
				run(
					["check", path.join(directory, "Rules.es"), "--no-color"],
					"essence",
				),
			)

			expect(code).toBe(EXIT_SUCCESS)
		})
	})
})

describe("essence test --json", () => {
	it("writes the event stream and nothing else on stdout", async () => {
		await withFiles({ "Rules.es": passing }, async (directory) => {
			let { code, out } = await runTests(directory, ["--json"])
			let events = out
				.split("\n")
				.filter((line) => line !== "")
				.map((line) => JSON.parse(line) as TestEvent)

			expect(events.every((event) => event.schema === 1)).toBe(true)
			expect(events[0]).toEqual({
				schema: 1,
				kind: "run-start",
				tests: 2,
				focused: false,
			})
			expect(events.map((event) => event.kind)).toEqual([
				"run-start",
				"test-start",
				"expect",
				"test-pass",
				"test-start",
				"expect",
				"test-pass",
				"test-skip",
				"run-end",
			])
			expect(events.at(-1)).toMatchObject({
				kind: "run-end",
				passed: 2,
				failed: 0,
				skipped: 1,
			})
			expect(code).toBe(EXIT_SUCCESS)
		})
	})

	// NOTE: `Terminal.inspect` renders a whole line and writes it through
	// `console.log`, which does not go through `process.stdout.write` — so a
	// Module that inspects a value as it is evaluated is the one way a byte
	// that is not an event could reach stdout.
	it("keeps what a Module inspected as it loaded off stdout", async () => {
		await withFiles(
			{
				"Loud.es": [
					"implementation {",
					"\tconstant seen = Terminal.inspect(42)",
					"}",
					"",
					"tests {",
					'\ttest "holds" {',
					"\t\texpect seen::is(42)",
					"\t}",
					"}",
					"",
				].join("\n"),
			},
			async (directory) => {
				let { code, err, out } = await runTests(directory, ["--json"])
				let lines = out.split("\n").filter((line) => line !== "")

				expect(
					lines.every((line) => line.startsWith('{"schema":1,')),
				).toBe(true)
				expect(err).toContain("42")
				expect(code).toBe(EXIT_SUCCESS)
			},
		)
	})

	it("carries a failure's recorded values and the difference", async () => {
		await withFiles({ "Wrong.tests.es": failing }, async (directory) => {
			let { out } = await runTests(directory, ["--json"])
			let events = out
				.split("\n")
				.filter((line) => line !== "")
				.map((line) => JSON.parse(line) as TestEvent)
			let failure = events.find((event) => event.kind === "test-fail")

			expect(failure).toMatchObject({
				name: "adds two and two",
				failures: [
					{
						form: "expect",
						comparison: { kind: "is", left: "4", right: "5" },
					},
				],
			})
		})
	})

	// NOTE: A Module's own top-level output is written as the bundle is
	// evaluated, with no test to attribute it to — stdout is the event stream,
	// so it goes to stderr rather than into the middle of a JSON document.
	it("keeps a Module's own printing off stdout", async () => {
		await withFiles(
			{
				"Noisy.es": [
					"implementation {",
					'\tTerminal.print("hello from the Module")',
					"}",
					"",
					"tests {",
					'\ttest "runs" {',
					"\t\texpect true",
					"\t}",
					"}",
					"",
				].join("\n"),
			},
			async (directory) => {
				let binary = fileURLToPath(
					import.meta.resolve("../../bin/essence"),
				)
				let result = spawnSync(
					process.execPath,
					[binary, "test", directory, "--json", "--jobs", "1"],
					{ encoding: "utf-8", env: { ...process.env } },
				)

				for (let line of result.stdout.split("\n")) {
					if (line !== "") {
						expect(() => JSON.parse(line)).not.toThrow()
					}
				}

				expect(result.stderr).toContain("hello from the Module")
				expect(result.status).toBe(EXIT_SUCCESS)
			},
		)
	})
})

// #endregion

// #region The reporter

const events: Array<TestEvent> = [
	{ schema: 1, kind: "run-start", tests: 3, focused: false },
	{
		schema: 1,
		kind: "test-start",
		row: null,
		id: "/Standings.es/Standing/records a win",
		name: "records a win",
		suitePath: ["Standing"],
		module: "/Standings.es",
	},
	{
		schema: 1,
		kind: "test-pass",
		id: "/Standings.es/Standing/records a win",
		name: "records a win",
		duration: 1,
		expectations: 2,
	},
	{
		schema: 1,
		kind: "test-start",
		row: null,
		id: "/Standings.es/Standing/outcomeOf/calls a draw",
		name: "calls a draw",
		suitePath: ["Standing", "outcomeOf"],
		module: "/Standings.es",
	},
	{
		schema: 1,
		kind: "test-fail",
		id: "/Standings.es/Standing/outcomeOf/calls a draw",
		name: "calls a draw",
		duration: 2,
		expectations: 1,
		failures: [
			{
				form: "expect",
				span: {
					start: { line: 3, column: 3 },
					end: { line: 3, column: 20 },
					source: "left::is(right)",
				},
				values: [
					{
						point: 1,
						span: {
							start: { line: 3, column: 3 },
							end: { line: 3, column: 7 },
							source: "left",
						},
						value: "3",
					},
				],
				comparison: {
					kind: "is",
					left: "3",
					right: "2",
					diff: [],
				},
			},
		],
		error: null,
	},
	{
		schema: 1,
		kind: "test-skip",
		row: null,
		id: "/Standings.es/renders a forfeit",
		name: "renders a forfeit",
		suitePath: [],
		module: "/Standings.es",
		reason: "waiting on the Table redesign",
	},
	{
		schema: 1,
		kind: "test-deselected",
		row: null,
		id: "/Season.tests.es/the leader is clear",
		name: "the leader is clear",
		suitePath: [],
		module: "/Season.tests.es",
		reason: "not-focused",
	},
	{
		schema: 1,
		kind: "run-end",
		passed: 1,
		failed: 1,
		skipped: 1,
		deselected: 1,
		duration: 84,
		focused: false,
	},
]

describe("the test reporter", () => {
	it("folds the event stream back into one record per test", () => {
		let run = collectTestRun(events)

		expect(run.counts).toEqual({
			passed: 1,
			failed: 1,
			skipped: 1,
			notFocused: 1,
			deselected: 0,
		})
		expect(run.duration).toBe(84)
		expect(run.tests.map((test) => test.state)).toEqual([
			"passed",
			"failed",
			"skipped",
			"not-focused",
		])
	})

	it("writes the tree the design asks for", () => {
		expect(
			[
				...renderTestTree(collectTestRun(events), reportContext),
				"",
				renderTestSummary(collectTestRun(events), reportContext),
			].join("\n"),
		).toMatchSnapshot()
	})

	// NOTE: The design's own tail on the summary line. It is about the COMPILE
	// and the duration beside it is about the run, so a reader is only told it
	// where it is true of every entry — which the runner works out and the
	// report is handed.
	it("notes a warm compile cache, and only when it was one", () => {
		let run = collectTestRun(events)

		expect(renderTestSummary(run, reportContext, 0, true)).toContain(
			"compile cache warm",
		)
		expect(renderTestSummary(run, reportContext, 0, false)).not.toContain(
			"compile cache",
		)
		expect(renderTestSummary(run, reportContext)).not.toContain(
			"compile cache",
		)
	})

	// NOTE: The kind the command line writes when it replays an entry it already
	// held the answer for. It says nothing about any test — the events after it
	// are that entry's own — so the fold counts it and changes nothing else.
	it("counts a replayed entry without disturbing the tests it stands for", () => {
		let plain = collectTestRun(events)
		let replayed = collectTestRun([
			events[0]!,
			{
				schema: 1,
				kind: "results-cached",
				entry: "/Season.tests.es",
				tests: 2,
			},
			...events.slice(1),
		])

		expect(plain.cached).toBe(0)
		expect(replayed.cached).toBe(1)
		expect(replayed.counts).toEqual(plain.counts)
		expect(replayed.tests.map((test) => test.id)).toEqual(
			plain.tests.map((test) => test.id),
		)
	})

	it("notes replayed entries as a share of the run's own", () => {
		let run = { ...collectTestRun(events), cached: 2 }

		expect(renderTestSummary(run, reportContext, 0, false, 0, 3)).toContain(
			"2 of 3 entries cached",
		)
		// NOTE: Both notes at once is the ordinary second run of a project: it
		// compiled nothing and it ran only what had moved.
		expect(renderTestSummary(run, reportContext, 0, true, 0, 3)).toContain(
			"compile cache warm",
		)
		// NOTE: A run that asked the cache nothing says nothing. `entries` is
		// zero for a watching session, which never reads this store at all.
		expect(
			renderTestSummary(run, reportContext, 0, false, 0, 0),
		).not.toContain("cached")
		expect(
			renderTestSummary(
				collectTestRun(events),
				reportContext,
				0,
				false,
				0,
				3,
			),
		).not.toContain("cached")
	})

	it("lists what was deselected only when asked", () => {
		let verbose = renderTestTree(collectTestRun(events), {
			...reportContext,
			verbose: true,
		})

		expect(verbose.join("\n")).toContain("not focused")
		expect(
			renderTestTree(collectTestRun(events), reportContext).join("\n"),
		).not.toContain("not focused")
	})

	it("builds a Diagnostic with a Label per recorded value", () => {
		let run = collectTestRun(events)
		let failed = run.tests.find((test) => test.state === "failed")!
		let diagnostic = testFailureDiagnostic(failed, failed.failures[0])!

		expect(diagnostic.code).toBe("test-failed")
		expect(diagnostic.message).toBe(
			"'Standing › outcomeOf › calls a draw' failed",
		)
		expect(diagnostic.labels.map((label) => label.message)).toEqual([
			"this expect failed",
			"3",
		])
		expect(diagnostic.notes).toEqual(["`is` compared 3 with 2"])
	})

	// NOTE: A table test whose name interpolates nothing renders the same text
	// for every row, under a heading that already says it — so the row says
	// which row it is instead, in the tree and in the Diagnostic alike.
	it("names the row a name did not name", () => {
		let rows: Array<TestEvent> = [
			{
				schema: 1,
				kind: "test-start",
				id: "/Rows.es/three rows/0",
				name: "three rows",
				suitePath: ["three rows"],
				module: "/Rows.es",
				row: 0,
			},
			{
				schema: 1,
				kind: "test-start",
				id: "/Rows.es/three rows/1",
				name: "three rows",
				suitePath: ["three rows"],
				module: "/Rows.es",
				row: 1,
			},
			{
				schema: 1,
				kind: "test-fail",
				id: "/Rows.es/three rows/1",
				name: "three rows",
				duration: 1,
				expectations: 1,
				failures: [
					{
						form: "expect",
						span: {
							start: { line: 3, column: 3 },
							end: { line: 3, column: 9 },
							source: "n::is(1)",
						},
						values: [],
						comparison: null,
					},
				],
				error: null,
			},
		]
		let run = collectTestRun(rows)
		let failed = run.tests.find((test) => test.state === "failed")!

		expect(renderTestTree(run, reportContext).join("\n")).toContain("row 2")
		expect(testFailureDiagnostic(failed, failed.failures[0])!.message).toBe(
			"'three rows' (row 2) failed",
		)
	})

	// NOTE: "A hundred cases held" is as much an answer as a counterexample is,
	// and it is the only thing that tells a property test apart in the tree.
	it("says how many cases a property test ran", () => {
		let run = collectTestRun([
			{
				schema: 1,
				kind: "test-start",
				id: "/Props.es/commutes",
				name: "commutes",
				suitePath: [],
				module: "/Props.es",
				row: null,
			},
			{
				schema: 1,
				kind: "property",
				id: "/Props.es/commutes",
				name: "commutes",
				module: "/Props.es",
				key: "commutes",
				cases: 100,
				requested: 100,
				seed: "deadbeef",
				shrinks: 0,
				counterexample: null,
				replayed: 0,
				stale: [],
				fromCorpus: false,
				encoded: null,
			},
			{
				schema: 1,
				kind: "test-pass",
				id: "/Props.es/commutes",
				name: "commutes",
				duration: 1,
				expectations: 100,
			},
		])

		expect(renderTestTree(run, reportContext).join("\n")).toContain(
			"(100 cases)",
		)
	})

	// NOTE: The frames name a bundle in a temporary directory and the files of
	// the runner that staged it — a path that will not exist by the time
	// anybody reads the report. The message says what happened; `--verbose`
	// keeps the rest, because a Compiler bug is reported out of it.
	it("shows a thrown error without its JavaScript frames", () => {
		let run = collectTestRun([
			{
				schema: 1,
				kind: "test-start",
				id: "/Threw.es/stops",
				name: "stops",
				suitePath: [],
				module: "/Threw.es",
				row: null,
			},
			{
				schema: 1,
				kind: "test-fail",
				id: "/Threw.es/stops",
				name: "stops",
				duration: 1,
				expectations: 0,
				failures: [],
				error: [
					"RangeError: Maximum call stack size exceeded",
					"    at runOne (/tmp/essence-test-Vh0pbQ/0/tests.mjs:679:11)",
					"    at runTests (/tmp/essence-test-Vh0pbQ/0/tests.mjs:12:3)",
				].join("\n"),
			},
		])
		let quiet = renderTestFailures(run, reportContext, () => null).join(
			"\n",
		)
		let loud = renderTestFailures(
			run,
			{ ...reportContext, verbose: true },
			() => null,
		).join("\n")

		expect(quiet).toContain("RangeError: Maximum call stack size exceeded")
		expect(quiet).not.toContain("tests.mjs")
		expect(loud).toContain("tests.mjs")
	})

	it("names every test a focus was left on", () => {
		let diagnostic = focusedTestsDiagnostic([
			{
				module: "/Standings.es",
				name: "records a win",
				suitePath: ["Standing"],
				keywordPosition: {
					start: { line: 3, column: 2 },
					end: { line: 3, column: 6 },
				},
			},
			{
				module: "/Standings.es",
				name: "calls a draw",
				suitePath: [],
				keywordPosition: {
					start: { line: 9, column: 2 },
					end: { line: 9, column: 6 },
				},
			},
		])!

		expect(diagnostic.code).toBe("focused-tests-remain")
		expect(diagnostic.message).toBe("These tests are still focused")
		expect(diagnostic.labels.map((label) => label.kind)).toEqual([
			"primary",
			"secondary",
		])
		expect(diagnostic.helps).toHaveLength(1)
	})

	// NOTE: A value whose rendering is its own source explains nothing, and a
	// difference over two scalars is what the note above it already said.
	it("drops a Label that only repeats what is written there", () => {
		let run = collectTestRun(events)
		let failed = run.tests.find((test) => test.state === "failed")!
		let diagnostic = testFailureDiagnostic(failed, {
			...failed.failures[0],
			values: [
				{
					point: 2,
					span: {
						start: { line: 3, column: 15 },
						end: { line: 3, column: 16 },
						source: "2",
					},
					value: "2",
				},
			],
		})!

		expect(diagnostic.labels).toHaveLength(1)
	})

	// NOTE: The reporting half of a benchmark, driven off events rather than off
	// a clock — what a measurement looks like in the tree, in the failures and
	// in the tally is the report's business, and asserting it against a real one
	// would be asserting something about this machine today.
	function measured(
		status: "written" | "matched" | "regressed" | "improved",
		nanoseconds: number,
		baseline: number | null,
	): Array<TestEvent> {
		return [
			{
				schema: 1,
				kind: "test-start",
				id: "/Sorting.es/sorts",
				name: "sorts ten thousand rows",
				suitePath: [],
				module: "/Sorting.es",
				row: null,
			},
			{
				schema: 1,
				kind: "benchmark",
				id: "/Sorting.es/sorts",
				name: "sorts ten thousand rows",
				module: "/Sorting.es",
				key: "sorts ten thousand rows",
				nanoseconds,
				iterations: 64,
				samples: 7,
				baseline,
				ratio: baseline === null ? null : nanoseconds / baseline,
				status,
			},
			status === "regressed"
				? {
						schema: 1,
						kind: "test-fail",
						id: "/Sorting.es/sorts",
						name: "sorts ten thousand rows",
						duration: 1,
						expectations: 1,
						failures: [],
						error: null,
					}
				: {
						schema: 1,
						kind: "test-pass",
						id: "/Sorting.es/sorts",
						name: "sorts ten thousand rows",
						duration: 1,
						expectations: 1,
					},
		]
	}

	it("says what a benchmark measured, in the unit it reads in", () => {
		let run = collectTestRun(measured("written", 1_230_000, null))

		expect(renderTestTree(run, reportContext).join("\n")).toContain(
			"1.23 ms",
		)
	})

	it("says how much faster a benchmark got, and how to record it", () => {
		let run = collectTestRun(measured("improved", 1_000_000, 1_400_000))

		expect(renderTestTree(run, reportContext).join("\n")).toContain(
			"1.4× faster — record it with --bench --update",
		)
	})

	it("says how far a benchmark ran away from its baseline", () => {
		let run = collectTestRun(measured("regressed", 2_100_000, 1_500_000))
		let failures = renderTestFailures(run, reportContext, () => null).join(
			"\n",
		)

		expect(run.counts.failed).toBe(1)
		expect(failures).toContain(
			"1.4× slower than its baseline (2.10 ms, was 1.50 ms)",
		)
		expect(failures).toContain(
			"If the new time is right, record it: essence test --bench --update",
		)
	})

	it("counts the baselines a run wrote", () => {
		let run = collectTestRun(measured("written", 1_000_000, null))

		expect(renderTestSummary(run, reportContext, 0, false, 1)).toContain(
			"1 baseline written",
		)
		expect(renderTestSummary(run, reportContext)).not.toContain(
			"baseline written",
		)
	})

	it("says why a benchmark nobody asked to measure did not run", () => {
		let run = collectTestRun([
			{
				schema: 1,
				kind: "test-deselected",
				id: "/Sorting.es/sorts",
				name: "sorts ten thousand rows",
				suitePath: [],
				module: "/Sorting.es",
				reason: "bench",
				row: null,
			},
		])

		expect(
			renderTestTree(run, { ...reportContext, verbose: true }).join("\n"),
		).toContain("only with --bench")
	})
})

// #endregion

// #region Coverage

// NOTE: A file with something to miss in it: an `else` no test enters, an arm
// no value takes and a Case nothing builds.
const covered = [
	"implementation {",
	"\tchoice Fixture {",
	"\t\tPlayed,",
	"\t\tPostponed,",
	"\t}",
	"",
	"\tfunction points(_ fixture: Fixture) -> Integer {",
	"\t\t<- match fixture -> Integer {",
	"\t\t\tcase #Played { <- 3 }",
	"\t\t\tcase #Postponed { <- 0 }",
	"\t\t}",
	"\t}",
	"",
	"\tfunction share(_ total: Integer, over played: Integer) -> Integer {",
	"\t\tif played::isNot(0) {",
	"\t\t\t<- total",
	"\t\t} else {",
	"\t\t\t<- 0",
	"\t\t}",
	"\t}",
	"}",
	"",
	"tests {",
	'\ttest "counts a played fixture" {',
	"\t\texpect points(#Played)::is(3)",
	"\t}",
	"",
	'\ttest "shares nothing over no games" {',
	"\t\texpect share(10, over 0)::is(0)",
	"\t}",
	"}",
	"",
].join("\n")

describe("essence test --coverage", () => {
	it("reports nothing about coverage unless it was asked", async () => {
		await withFiles({ "Fixture.es": covered }, async (directory) => {
			let { out } = await runTests(directory)

			expect(out).not.toContain("Not taken")
		})
	})

	it("writes the table, with a row per file", async () => {
		await withFiles({ "Fixture.es": covered }, async (directory) => {
			let { code, out } = await runTests(directory, ["--coverage"])

			expect(code).toBe(EXIT_SUCCESS)
			expect(out).toContain("File")
			expect(out).toContain("Lines")
			expect(out).toContain("Branches")
			expect(out).toContain("Cases")
			expect(out).toContain("Not taken")
			expect(out).toContain("Fixture.es")
		})
	})

	it("names the arm no value took and the branch nothing entered", async () => {
		await withFiles({ "Fixture.es": covered }, async (directory) => {
			let { out } = await runTests(directory, ["--coverage"])

			expect(out).toContain("points › case #Postponed")
			expect(out).toContain("share › if")
		})
	})

	it("says which Case of a Choice no test ever built", async () => {
		await withFiles({ "Fixture.es": covered }, async (directory) => {
			let { out } = await runTests(directory, ["--coverage"])

			expect(out).toContain(
				"Choice Fixture: #Postponed never constructed by a test",
			)
			expect(out).not.toContain("#Played never constructed")
		})
	})

	it("keeps the event stream alone on stdout under --json", async () => {
		await withFiles({ "Fixture.es": covered }, async (directory) => {
			let { out } = await runTests(directory, ["--coverage", "--json"])
			let events = out
				.trim()
				.split("\n")
				.map((line) => JSON.parse(line) as TestEvent)
			let coverage = events.filter((event) => event.kind === "coverage")

			expect(coverage).toHaveLength(1)
			expect(out).not.toContain("Not taken")
		})
	})

	it("writes lcov where it was asked to", async () => {
		await withFiles({ "Fixture.es": covered }, async (directory) => {
			let out = path.join(directory, "reports")

			await runTests(directory, [
				"--coverage-report",
				"lcov",
				"--coverage-out",
				out,
			])

			let written = readFileSync(path.join(out, "lcov.info"), "utf8")

			expect(written).toContain("SF:")
			expect(written).toContain("Fixture.es")
			expect(written).toContain("BRDA:")
			expect(written).toContain("end_of_record")
		})
	})

	it("writes json where it was asked to, in the Compiler's vocabulary", async () => {
		await withFiles({ "Fixture.es": covered }, async (directory) => {
			let out = path.join(directory, "reports")

			await runTests(directory, [
				"--coverage-report",
				"json",
				"--coverage-out",
				out,
			])

			let written = JSON.parse(
				readFileSync(path.join(out, "coverage.json"), "utf8"),
			) as {
				schema: number
				files: Array<{ missed: Array<{ label: string }> }>
				choices: Array<{ name: string }>
			}

			expect(written.schema).toBe(1)
			expect(
				written.files.flatMap((file) =>
					file.missed.map((missed) => missed.label),
				),
			).toContain("case #Postponed")
			expect(written.choices.map((choice) => choice.name)).toEqual([
				"Fixture",
			])
		})
	})

	it("writes no file for a run that counted nothing", async () => {
		// NOTE: A `Foo.tests.es` of imports and tests has nothing to count, so
		// there is nothing to write — and an empty tracefile is not an empty
		// report: a viewer reads it as a valid claim about zero files.
		await withFiles(
			{ "Bare.tests.es": failing.replace("5", "4") },
			async (directory) => {
				let out = path.join(directory, "reports")

				await runTests(directory, [
					"--coverage-report",
					"lcov",
					"--coverage-out",
					out,
				])

				expect(existsSync(path.join(out, "lcov.info"))).toBe(false)
			},
		)
	})

	it("refuses a place to write with nothing to write there", () => {
		expect(() =>
			parseArguments(["test", "--coverage", "--coverage-out", "reports"]),
		).toThrow(UsageError)
	})

	it("refuses a format it does not know", () => {
		expect(() =>
			parseArguments(["test", "--coverage-report", "cobertura"]),
		).toThrow(UsageError)
	})

	it("asks for coverage the moment a report is named", () => {
		expect(
			parseArguments(["test", "--coverage-report", "lcov"]).options
				.coverage,
		).toBe(true)
	})
})

// #endregion

describe("essence test — snapshots", () => {
	const snapshots = [
		"implementation {",
		"\tfunction greeting(_ name: String) -> String {",
		'\t\t<- "Hello, {name}"',
		"\t}",
		"}",
		"",
		"tests {",
		'\ttest "renders inline" {',
		'\t\texpect greeting("Lions") matches snapshot',
		"\t}",
		"",
		'\ttest "renders a stored one" {',
		'\t\texpect greeting("Tigers") matches snapshot from "tigers"',
		"\t}",
		"}",
		"",
	].join("\n")

	it("records what the first run produced, and passes", async () => {
		await withFiles({ "Greeting.es": snapshots }, async (directory) => {
			let { code, out } = await runTests(directory)

			expect(code).toBe(EXIT_SUCCESS)
			expect(out).toContain("2 passed")
			expect(out).toContain("2 snapshots written")

			expect(
				readFileSync(path.join(directory, "Greeting.es"), "utf8"),
			).toContain('matches snapshot "Hello, Lions"')

			expect(
				readFileSync(
					path.join(directory, "__snapshots__", "Greeting.es.snap"),
					"utf8",
				),
			).toContain("Hello, Tigers")
		})
	})

	it("matches what it recorded on the run after", async () => {
		await withFiles({ "Greeting.es": snapshots }, async (directory) => {
			await runTests(directory)

			let { code, out } = await runTests(directory)

			expect(code).toBe(EXIT_SUCCESS)
			expect(out).toContain("2 passed")
			expect(out).not.toContain("snapshot written")
		})
	})

	it("fails on a difference and says how to accept it", async () => {
		await withFiles(
			{
				"Greeting.es": snapshots.replace(
					"matches snapshot\n",
					'matches snapshot "Hello, Foxes"\n',
				),
			},
			async (directory) => {
				let { code, err } = await runTests(directory)

				expect(code).toBe(EXIT_FAILURE)
				expect(err).toContain("test-failed")
				expect(err).toContain("- Hello, Foxes")
				expect(err).toContain("+ Hello, Lions")
				expect(err).toContain("essence test --update")
			},
		)
	})

	it("records a difference when it is asked to", async () => {
		await withFiles(
			{
				"Greeting.es": snapshots.replace(
					"matches snapshot\n",
					'matches snapshot "Hello, Foxes"\n',
				),
			},
			async (directory) => {
				let { code } = await runTests(directory, ["--update"])

				expect(code).toBe(EXIT_SUCCESS)
				expect(
					readFileSync(path.join(directory, "Greeting.es"), "utf8"),
				).toContain('matches snapshot "Hello, Lions"')
			},
		)
	})

	// NOTE: A stored entry no run visited is KEPT — a run narrowed by a filter
	// has not asked about every test, and deleting what it did not ask about
	// would lose a snapshot for the price of a `-f`.
	it("keeps a stored entry a narrowed run never visited", async () => {
		await withFiles({ "Greeting.es": snapshots }, async (directory) => {
			await runTests(directory)
			await runTests(directory, ["--filter", "inline", "--update"])

			expect(
				readFileSync(
					path.join(directory, "__snapshots__", "Greeting.es.snap"),
					"utf8",
				),
			).toContain("Hello, Tigers")
		})
	})
})

// NOTE: What a property test looks like from the command line: the report a
// failure prints, the replay it names, and the two flags that pin a run.
describe("essence test — property tests", () => {
	const properties = [
		"implementation {",
		"\tfunction double(_ value: Integer) -> Integer {",
		"\t\t<- value::add(value)",
		"\t}",
		"}",
		"",
		"tests {",
		'\ttest "add commutes" for any (a: Integer, b: Integer) {',
		"\t\texpect a::add(b)::is(b::add(a))",
		"\t}",
		"",
		'\ttest "doubling stays small" for any (n: Integer) {',
		"\t\texpect double(n)::isLessThan(1000)",
		"\t}",
		"}",
		"",
	].join("\n")

	it("reports the counterexample it shrank to, and how to draw it again", async () => {
		await withFiles({ "Doubling.es": properties }, async (directory) => {
			let { code, out, err } = await runTests(directory, [
				"--seed",
				"deadbeef",
			])

			expect(code).toBe(EXIT_FAILURE)
			expect(out).toContain("✓ add commutes")
			expect(out).toContain("✗ doubling stays small")
			expect(err).toContain("shrunk to: n = 500")
			expect(err).toContain(
				'essence test --seed deadbeef -f "doubling stays small"',
			)
		})
	})

	// NOTE: THE claim `--seed` makes: the command a failure printed reproduces
	// the failure, filter and all.
	//
	// NOTE: A directory each rather than two runs in one. What is claimed here
	// is that the SEED draws the value — and a run that read the
	// `__counterexamples__` the run before it wrote would answer the same thing
	// without drawing anything at all.
	it("draws the same counterexample for the same seed", async () => {
		let whole = await withFiles(
			{ "Doubling.es": properties },
			(directory) => runTests(directory, ["--seed", "deadbeef"]),
		)
		let alone = await withFiles(
			{ "Doubling.es": properties },
			(directory) =>
				runTests(directory, [
					"--seed",
					"deadbeef",
					"--filter",
					"doubling stays small",
				]),
		)

		expect(alone.err).toContain("shrunk to: n = 500")
		expect(whole.err).toContain("shrunk to: n = 500")
	})

	it("runs as many cases as --cases asks for", async () => {
		await withFiles({ "Doubling.es": properties }, async (directory) => {
			let { out } = await runTests(directory, [
				"--seed",
				"deadbeef",
				"--cases",
				"3",
				"--filter",
				"add commutes",
				"--json",
			])
			let events = out
				.split("\n")
				.filter((line) => line.length > 0)
				.map((line) => JSON.parse(line) as TestEvent)
			let [property] = events.filter((event) => event.kind === "property")

			expect((property as { cases: number }).cases).toBe(3)
		})
	})

	it("carries the seed on every property event", async () => {
		await withFiles({ "Doubling.es": properties }, async (directory) => {
			let { out } = await runTests(directory, [
				"--seed",
				"c0ffee",
				"--json",
			])
			let seeds = out
				.split("\n")
				.filter((line) => line.length > 0)
				.map((line) => JSON.parse(line) as TestEvent)
				.filter((event) => event.kind === "property")
				.map((event) => (event as { seed: string }).seed)

			expect(seeds).toEqual(["c0ffee", "c0ffee"])
		})
	})

	it("refuses a case count that is not a whole number", () => {
		expect(() =>
			parseArguments(["test", "--cases", "banana"], "essence"),
		).toThrow(UsageError)
		expect(() =>
			parseArguments(["test", "--cases", "0"], "essence"),
		).toThrow(UsageError)
	})

	it("reads both flags off the command line", () => {
		let { options } = parseArguments(
			["test", "--seed", "beef", "--cases", "7"],
			"essence",
		)

		expect(options.seed).toBe("beef")
		expect(options.cases).toBe(7)
	})
})

// NOTE: What `--contracts` looks like from the command line: the goals a
// project's own declarations promise, run beside the tests it wrote and
// reported under a suite nobody typed.
describe("essence test --contracts", () => {
	const declarations = [
		"implementation {",
		"\ttype Positive = Integer where @::isGreaterThan(0)",
		"",
		"\tnamespace Counting for Integer {",
		"\t\tup() -> Positive {",
		"\t\t\t<- 1",
		"\t\t}",
		"\t}",
		"}",
		"",
		"tests {",
		'\ttest "counts" {',
		"\t\texpect 1::isGreaterThan(0)",
		"\t}",
		"}",
		"",
	].join("\n")

	// NOTE: A file with nothing but declarations in it, which a plain run does
	// not even look at — and which is exactly the file a contract run exists
	// for.
	const undocumented = [
		"implementation {",
		"\ttype Positive = Integer where @::isGreaterThan(0)",
		"",
		"\tnamespace Counting for Integer {",
		"\t\tup() -> Positive {",
		"\t\t\t<- 1",
		"\t\t}",
		"\t}",
		"}",
		"",
	].join("\n")

	it("runs the goals a Namespace's declarations promise", async () => {
		await withFiles({ "Counting.es": declarations }, async (directory) => {
			let { code, out } = await runTests(directory, ["--contracts"])

			expect(code).toBe(EXIT_SUCCESS)
			expect(out).toContain("contracts")
			expect(out).toContain("Counting::up()")
			expect(out).toContain("2 passed")
		})
	})

	it("finds a file that declares but writes no tests", async () => {
		await withFiles({ "Counting.es": undocumented }, async (directory) => {
			let plain = await runTests(directory)
			let goals = await runTests(directory, ["--contracts"])

			expect(plain.out).toContain("no tests in")
			expect(goals.code).toBe(EXIT_SUCCESS)
			expect(goals.out).toContain("Counting::up()")
		})
	})

	// NOTE: The setting is read from the nearest `package.json` walking up from
	// the working directory rather than from the directory a run was pointed
	// at, so the union is asserted where it is decided rather than through a
	// process this spec would have to move.
	it("takes the flag and the project's own setting as a union", () => {
		let flags = (contracts: boolean, noContracts = false) => ({
			contracts,
			noContracts,
		})

		expect(resolveContracts(flags(false), true)).toBe(true)
		expect(resolveContracts(flags(true), false)).toBe(true)
		expect(resolveContracts(flags(false), false)).toBe(false)
	})

	// NOTE: The way out of a configured setting — a project that always tests
	// its declarations still gets a plain run on demand.
	it("lets --no-contracts beat the setting and the flag", () => {
		expect(
			resolveContracts({ contracts: false, noContracts: true }, true),
		).toBe(false)
		expect(
			resolveContracts({ contracts: true, noContracts: true }, true),
		).toBe(false)
	})

	// NOTE: THE cache-key claim. A contract compile enriches a suite that is
	// not in the file at all, out of sources that are byte for byte the same —
	// so the graph's own hash can not tell the two bundles apart, and a plain
	// run handed the contract run's bundle would report goals nobody asked for.
	it("does not serve a contract bundle to a plain run", async () => {
		await withFiles({ "Counting.es": declarations }, async (directory) => {
			let goals = await runTests(directory, ["--contracts"])
			let plain = await runTests(directory)

			expect(goals.out).toContain("Counting::up()")
			expect(plain.out).not.toContain("Counting::up()")
			expect(plain.out).not.toContain("contracts")
			expect(plain.out).toContain("1 passed")
		})
	})

	// NOTE: Said once per Namespace, and quietly — an `information` Diagnostic
	// rather than a failure, because a Method nothing can build a goal for is
	// not a mistake anybody made.
	it("says once which Methods got no goal", async () => {
		await withFiles(
			{
				"Reading.es": [
					"implementation {",
					"\tnamespace Reading for String {",
					"\t\twith(each read: (_ text: String) -> Integer) -> Integer {",
					"\t\t\t<- read(@)",
					"\t\t}",
					"",
					"\t\tagain(each read: (_ text: String) -> Integer) -> Integer {",
					"\t\t\t<- read(@)",
					"\t\t}",
					"\t}",
					"}",
					"",
					"tests {",
					'\ttest "reads" {',
					"\t\texpect true",
					"\t}",
					"}",
					"",
				].join("\n"),
			},
			async (directory) => {
				let { code, err } = await runTests(directory, ["--contracts"])

				expect(code).toBe(EXIT_SUCCESS)
				expect(err).toContain("ungeneratable-contract")
				expect(err).toContain("2 Methods of 'Reading' got no contract")
			},
		)
	})

	it("reads the flag off the command line", () => {
		expect(
			parseArguments(["test", "--contracts"], "essence").options
				.contracts,
		).toBe(true)
		expect(parseArguments(["test"], "essence").options.contracts).toBe(
			false,
		)
	})
})

// NOTE: What a benchmark looks like from the command line. Nothing here asserts
// a TIME: the times are the machine's, and a spec that read one would be a
// scheduled flake. What is asserted is what the run WROTE, what it did with a
// baseline it was handed, and what a run that did not ask to measure says
// instead — and every baseline it is handed is written by this spec, so the
// status a measurement reaches is arithmetic rather than luck.
describe("essence test — benchmarks", () => {
	const benchmarks = [
		"implementation {",
		"\tfunction double(_ value: Integer) -> Integer {",
		"\t\t<- value::add(value)",
		"\t}",
		"}",
		"",
		"tests {",
		'\ttest "doubles" {',
		"\t\texpect double(2)::is(4)",
		"\t}",
		"",
		'\tbenchmark "doubling" {',
		"\t\texpect double(500)::is(1000)",
		"\t}",
		"}",
		"",
	].join("\n")

	function baselineFile(directory: string): string {
		return path.join(directory, "__benchmarks__", "Doubling.es.bench")
	}

	// NOTE: A baseline the spec chose rather than one a run measured, so that
	// what the next run reports is decided here. Anything a real body measures
	// is far away from both of the numbers used below.
	function recordBaseline(directory: string, nanoseconds: number): void {
		let filePath = baselineFile(directory)

		mkdirSync(path.dirname(filePath), { recursive: true })
		writeFileSync(
			filePath,
			['benchmark "doubling"', `\t${nanoseconds} ns`, ""].join("\n"),
		)
	}

	it("leaves the benchmarks out of a run that did not ask for them", async () => {
		await withFiles({ "Doubling.es": benchmarks }, async (directory) => {
			let { code, out } = await runTests(directory, ["--verbose"])

			expect(code).toBe(EXIT_SUCCESS)
			expect(out).toContain("1 passed")
			expect(out).toContain("only with --bench")
			expect(existsSync(baselineFile(directory))).toBe(false)
		})
	})

	it("measures them where it was asked, and records what it found", async () => {
		await withFiles({ "Doubling.es": benchmarks }, async (directory) => {
			let { code, out } = await runTests(directory, ["--bench"])

			expect(code).toBe(EXIT_SUCCESS)
			expect(out).toContain("2 passed")
			expect(out).toContain("1 baseline written")

			let written = readFileSync(baselineFile(directory), "utf8")

			expect(written).toContain('benchmark "doubling"')
			expect(written).toMatch(/\n\t\d+ ns\n/)
		})
	})

	it("fails a measurement that ran away from what was recorded", async () => {
		await withFiles({ "Doubling.es": benchmarks }, async (directory) => {
			recordBaseline(directory, 1)

			let { code, err } = await runTests(directory, ["--bench"])

			expect(code).toBe(EXIT_FAILURE)
			expect(err).toContain("slower than its baseline")
			expect(err).toContain("essence test --bench --update")
			expect(readFileSync(baselineFile(directory), "utf8")).toContain(
				"\t1 ns",
			)
		})
	})

	it("records a measurement outside its band when it is told to", async () => {
		await withFiles({ "Doubling.es": benchmarks }, async (directory) => {
			recordBaseline(directory, 1)

			let { code } = await runTests(directory, ["--bench", "--update"])

			expect(code).toBe(EXIT_SUCCESS)
			expect(readFileSync(baselineFile(directory), "utf8")).not.toContain(
				"\t1 ns",
			)
		})
	})

	// NOTE: The one way a filter matches something and still runs nothing:
	// it named benchmarks, and the run is not measuring. Without the sentence
	// the run ends green with the reader's target never run.
	it("says so where a filter names only benchmarks", async () => {
		await withFiles({ "Doubling.es": benchmarks }, async (directory) => {
			let { code, err } = await runTests(directory, [
				"--filter",
				"doubling",
			])

			expect(code).toBe(EXIT_SUCCESS)
			expect(err).toContain(
				'"doubling" matched only benchmarks — measure them with --bench',
			)
		})
	})

	// NOTE: No measurement writes a zero — the driver floors at a nanosecond —
	// so one can only be a hand-edited or merge-mangled file. Holding a run to
	// it would fail every later measurement as infinitely slower; it is
	// re-recorded instead.
	it("re-records a baseline of nothing rather than failing against it", async () => {
		await withFiles({ "Doubling.es": benchmarks }, async (directory) => {
			recordBaseline(directory, 0)

			let { code, out } = await runTests(directory, ["--bench"])

			expect(code).toBe(EXIT_SUCCESS)
			expect(out).toContain("1 baseline written")
			expect(readFileSync(baselineFile(directory), "utf8")).not.toContain(
				"\t0 ns",
			)
		})
	})

	// NOTE: A measurement is taken before the reported run, so a body that then
	// fails has already been measured — and a number measured off a failing
	// benchmark is not a baseline.
	it("writes no baseline for a benchmark that failed", async () => {
		let failing = benchmarks.replace(
			"expect double(500)::is(1000)",
			"expect double(500)::is(999)",
		)

		await withFiles({ "Doubling.es": failing }, async (directory) => {
			let { code } = await runTests(directory, ["--bench"])

			expect(code).toBe(EXIT_FAILURE)
			expect(existsSync(baselineFile(directory))).toBe(false)
		})
	})

	// NOTE: Faster is news rather than a problem, and the baseline stands until
	// somebody moves it — ten seconds a run is a baseline nothing on any machine
	// will fail to beat.
	it("passes a measurement that got faster, and records nothing", async () => {
		await withFiles({ "Doubling.es": benchmarks }, async (directory) => {
			recordBaseline(directory, 10_000_000_000)

			let { code, out } = await runTests(directory, ["--bench"])

			expect(code).toBe(EXIT_SUCCESS)
			expect(out).toContain("faster — record it with --bench --update")
			expect(out).not.toContain("baseline written")
			expect(readFileSync(baselineFile(directory), "utf8")).toContain(
				"\t10000000000 ns",
			)
		})
	})

	// NOTE: `--update` is one flag, and a run that did not ask to measure has
	// measured nothing — so there is nothing for it to record either way.
	it("touches no baseline in a run that is not measuring", async () => {
		await withFiles({ "Doubling.es": benchmarks }, async (directory) => {
			recordBaseline(directory, 1)

			let { code } = await runTests(directory, ["--update"])

			expect(code).toBe(EXIT_SUCCESS)
			expect(readFileSync(baselineFile(directory), "utf8")).toContain(
				"\t1 ns",
			)
		})
	})

	it("keeps a stored entry a narrowed run never measured", async () => {
		await withFiles({ "Doubling.es": benchmarks }, async (directory) => {
			await runTests(directory, ["--bench"])

			let filePath = baselineFile(directory)

			writeFileSync(
				filePath,
				`${readFileSync(filePath, "utf8")}benchmark "gone"\n\t7 ns\n`,
			)

			await runTests(directory, ["--bench", "--update"])

			expect(readFileSync(filePath, "utf8")).toContain('benchmark "gone"')
		})
	})

	it("carries the measurement on the event stream", async () => {
		await withFiles({ "Doubling.es": benchmarks }, async (directory) => {
			let { out } = await runTests(directory, ["--bench", "--json"])
			let events = out
				.split("\n")
				.filter((line) => line.length > 0)
				.map((line) => JSON.parse(line) as TestEvent)
			let [measured] = events.filter(
				(event) => event.kind === "benchmark",
			)

			expect(measured).toMatchObject({
				schema: 1,
				kind: "benchmark",
				key: "doubling",
				status: "written",
				baseline: null,
				samples: 7,
			})
		})
	})

	it("reads the flag off the command line", () => {
		expect(
			parseArguments(["test", "--bench"], "essence").options.bench,
		).toBe(true)
		expect(parseArguments(["test"], "essence").options.bench).toBe(false)
	})
})

// NOTE: The failing-example corpus from the command line: what a failure leaves
// on disk, and what the run after it does with what it found.
describe("essence test — the failing-example corpus", () => {
	// NOTE: A property NO value satisfies, so that nothing below depends on
	// which one was drawn. The shrink walks an Integer towards zero and every
	// candidate still fails, so the stored value is `0` at any seed.
	const broken = [
		"tests {",
		'\ttest "is never itself" for any (n: Integer) {',
		"\t\texpect n::isNot(n)",
		"\t}",
		"}",
		"",
	].join("\n")

	const held = [
		"tests {",
		'\ttest "is never itself" for any (n: Integer) {',
		"\t\texpect n::is(n)",
		"\t}",
		"}",
		"",
	].join("\n")

	// NOTE: The same test over a Parameter of another Type, which is what makes
	// every stored value of it unreadable — the change a corpus has to survive
	// by dropping what it holds rather than by replaying it as something else.
	const retyped = [
		"tests {",
		'\ttest "is never itself" for any (n: String) {',
		"\t\texpect n::is(n)",
		"\t}",
		"}",
		"",
	].join("\n")

	function corpusPath(directory: string): string {
		return path.join(directory, "__counterexamples__", "Numbers.es.json")
	}

	function propertyEvents(out: string): Array<Record<string, unknown>> {
		return out
			.split("\n")
			.filter((line) => line.length > 0)
			.map((line) => JSON.parse(line) as TestEvent)
			.filter((event) => event.kind === "property") as unknown as Array<
			Record<string, unknown>
		>
	}

	it("writes down the value a failure shrank to", async () => {
		await withFiles({ "Numbers.es": broken }, async (directory) => {
			let { code } = await runTests(directory)

			expect(code).toBe(EXIT_FAILURE)

			let stored = JSON.parse(
				readFileSync(corpusPath(directory), "utf8"),
			) as {
				schema: number
				entries: Record<string, Array<{ values: Array<unknown> }>>
			}

			expect(stored.schema).toBe(1)
			expect(stored.entries["is never itself"]).toEqual([
				{
					values: [
						{ name: "n", data: { kind: "integer", value: "0" } },
					],
				},
			])
		})
	})

	it("writes nothing down for a property that held", async () => {
		await withFiles({ "Numbers.es": held }, async (directory) => {
			let { code } = await runTests(directory)

			expect(code).toBe(EXIT_SUCCESS)
			expect(existsSync(corpusPath(directory))).toBe(false)
		})
	})

	// NOTE: THE claim the corpus makes. The second run does not go looking: it
	// asks about the value the first run found, finds it still failing, and
	// reports that rather than a fresh case.
	it("replays what it stored before it draws anything", async () => {
		await withFiles({ "Numbers.es": broken }, async (directory) => {
			await runTests(directory)

			let second = await runTests(directory, ["--json"])
			let [property] = propertyEvents(second.out)

			expect(second.code).toBe(EXIT_FAILURE)
			expect(property).toMatchObject({
				cases: 0,
				replayed: 1,
				fromCorpus: true,
				stale: [],
			})
		})
	})

	it("says a failure came from a stored counterexample", async () => {
		await withFiles({ "Numbers.es": broken }, async (directory) => {
			await runTests(directory)

			let { err } = await runTests(directory)

			expect(err).toContain(
				"failed on a stored counterexample (1 re-run)",
			)
			expect(err).toContain("n = 0")
		})
	})

	// NOTE: A stored value that now holds is KEPT and re-run for ever: what it
	// is worth is exactly that it goes on being asked, and a run that dropped
	// it the moment it passed would drop it the moment it mattered.
	it("keeps re-running a stored value once the code is fixed", async () => {
		await withFiles({ "Numbers.es": broken }, async (directory) => {
			await runTests(directory)
			writeFileSync(path.join(directory, "Numbers.es"), held)

			let { code, out } = await runTests(directory, ["--json"])
			let [property] = propertyEvents(out)

			expect(code).toBe(EXIT_SUCCESS)
			expect(property).toMatchObject({
				replayed: 1,
				fromCorpus: false,
				counterexample: null,
			})
			expect(existsSync(corpusPath(directory))).toBe(true)
		})
	})

	it("counts the replays beside the cases in the tree", async () => {
		await withFiles({ "Numbers.es": broken }, async (directory) => {
			await runTests(directory)
			writeFileSync(path.join(directory, "Numbers.es"), held)

			expect((await runTests(directory)).out).toContain(
				"(100 cases · 1 replayed)",
			)
		})
	})

	// NOTE: The Type moved under the entry. It is not a counterexample and not
	// a failure — it is an entry nothing can read, and the run that met it is
	// what takes it off the disk.
	it("drops an entry the Types no longer read back", async () => {
		await withFiles({ "Numbers.es": broken }, async (directory) => {
			await runTests(directory)
			writeFileSync(path.join(directory, "Numbers.es"), retyped)

			let { code, out } = await runTests(directory, ["--json"])
			let [property] = propertyEvents(out)

			expect(code).toBe(EXIT_SUCCESS)
			expect(property).toMatchObject({ replayed: 0, stale: [0] })
			expect(existsSync(corpusPath(directory))).toBe(false)
		})
	})
})

// NOTE: What a second `essence test` over an untouched project does. The claim
// a replay makes is that these tests ran and said this, so every spec here is
// about one of the two halves of that claim: what makes a run answerable out of
// the store, and what makes an answer in the store no longer this run's.
describe("essence test — the result cache", () => {
	// NOTE: A Module with no tests of its own, so that touching it moves what
	// another entry ANSWERS without moving which entry claims what.
	const library = [
		"implementation {",
		"\tfunction triple(_ value: Integer) -> Integer {",
		"\t\t<- value::multiply(with 3)",
		"\t}",
		"}",
		"",
		"export {",
		"\ttriple",
		"}",
		"",
	].join("\n")

	const usesLibrary = [
		"import {",
		'\tfrom "./Library.es" { triple }',
		"}",
		"",
		"tests {",
		'\ttest "triples" {',
		"\t\texpect triple(2)::is(6)",
		"\t}",
		"}",
		"",
	].join("\n")

	const standalone = [
		"tests {",
		'\ttest "holds on its own" {',
		"\t\texpect true",
		"\t}",
		"}",
		"",
	].join("\n")

	const property = [
		"tests {",
		'\ttest "is itself" for any (n: Integer) {',
		"\t\texpect n::is(n)",
		"\t}",
		"}",
		"",
	].join("\n")

	const snapshotting = [
		"implementation {",
		"\tfunction greeting(_ name: String) -> String {",
		'\t\t<- "Hello, {name}"',
		"\t}",
		"}",
		"",
		"tests {",
		'\ttest "renders a stored one" {',
		'\t\texpect greeting("Tigers") matches snapshot from "tigers"',
		"\t}",
		"}",
		"",
	].join("\n")

	// NOTE: A store of this spec's own, so that counting what is in it counts
	// only what this spec put there. The variable is read every time the store
	// is asked for, so setting it here reaches the run below.
	async function withResults<Value>(
		body: (store: string) => Promise<Value>,
	): Promise<Value> {
		let store = mkdtempSync(path.join(tmpdir(), "essence-result-store-"))
		let previous = process.env.ESSENCE_RESULTS_CACHE

		process.env.ESSENCE_RESULTS_CACHE = store

		try {
			return await body(store)
		} finally {
			if (previous === undefined) {
				delete process.env.ESSENCE_RESULTS_CACHE
			} else {
				process.env.ESSENCE_RESULTS_CACHE = previous
			}

			rmSync(store, { recursive: true, force: true })
		}
	}

	function records(store: string): Array<string> {
		return readdirSync(store).filter((name) => name.endsWith(".json"))
	}

	function bundles(): Array<string> {
		return readdirSync(bundleCache).filter((name) => name.endsWith(".mjs"))
	}

	// NOTE: The honest proof that a replayed entry is never loaded. A bundle is
	// content-addressed, so its name is a function of the sources and not of what
	// is inside the file — poison the bytes and a run that still passes is a run
	// that never imported them. Only this fixture's bundles are touched: every
	// spec compiles out of a directory of its own, so no other name can collide.
	function poison(before: Array<string>): number {
		let written = bundles().filter((name) => !before.includes(name))

		for (let name of written) {
			writeFileSync(
				path.join(bundleCache, name),
				'throw new Error("this bundle was imported")\n',
			)
		}

		return written.length
	}

	function events(out: string): Array<TestEvent> {
		return out
			.split("\n")
			.filter((line) => line !== "")
			.map((line) => JSON.parse(line) as TestEvent)
	}

	// NOTE: The report without its tally, which is the one line a warm run and a
	// cold one are meant to differ on — the duration is the run's own and the
	// note beside it is what says the run was warm.
	function tree(out: string): string {
		return out
			.split("\n")
			.filter((line) => !line.includes("passed"))
			.join("\n")
	}

	it("remembers one record per entry the first run answered", async () => {
		await withResults(async (store) => {
			await withFiles(
				{
					"Library.es": library,
					"Uses.tests.es": usesLibrary,
					"Standalone.tests.es": standalone,
				},
				async (directory) => {
					let { code, out } = await runTests(directory)

					expect(code).toBe(EXIT_SUCCESS)
					expect(out).toContain("2 passed")
					expect(out).not.toContain("entries cached")
					expect(records(store)).toHaveLength(2)
				},
			)
		})
	})

	it("replays them on the run after, without loading a bundle", async () => {
		await withResults(async () => {
			await withFiles(
				{
					"Library.es": library,
					"Uses.tests.es": usesLibrary,
					"Standalone.tests.es": standalone,
				},
				async (directory) => {
					let before = bundles()

					await runTests(directory)

					expect(poison(before)).toBe(2)

					let { code, out } = await runTests(directory)

					expect(code).toBe(EXIT_SUCCESS)
					expect(out).toContain("2 passed")
					expect(out).toContain("2 of 2 entries cached")
					expect(out).toContain("triples")
					expect(out).toContain("holds on its own")
				},
			)
		})
	})

	// NOTE: The whole point of keying on the graph rather than on the entry: a
	// Module with no tests of its own still decides what the tests that reach it
	// answer, so touching it has to reach the entry that imports it and nothing
	// else.
	it("re-runs the entry a touched dependency reaches, and only it", async () => {
		await withResults(async () => {
			await withFiles(
				{
					"Library.es": library,
					"Uses.tests.es": usesLibrary,
					"Standalone.tests.es": standalone,
				},
				async (directory) => {
					await runTests(directory)

					writeFileSync(
						path.join(directory, "Library.es"),
						library.replace("with 3", "with 4"),
					)

					let { code, out } = await runTests(directory)

					expect(code).toBe(EXIT_FAILURE)
					expect(out).toContain("1 of 2 entries cached")
					expect(out).toContain("1 failed")
					expect(out).toContain("1 passed")
				},
			)
		})
	})

	it("never remembers an entry that failed", async () => {
		await withResults(async (store) => {
			await withFiles(
				{ "Wrong.tests.es": failing },
				async (directory) => {
					expect((await runTests(directory)).code).toBe(EXIT_FAILURE)
					expect(records(store)).toHaveLength(0)

					let { code, out } = await runTests(directory)

					expect(code).toBe(EXIT_FAILURE)
					expect(out).not.toContain("entries cached")
				},
			)
		})
	})

	// NOTE: Fresh entropy every run is what a property test IS. Freezing a
	// hundred cases under a name would end its search, and the values it has
	// already failed on are the corpus's business rather than this store's.
	it("never remembers an entry holding a property test", async () => {
		await withResults(async (store) => {
			await withFiles(
				{
					"Numbers.tests.es": property,
					"Standalone.tests.es": standalone,
				},
				async (directory) => {
					expect((await runTests(directory)).code).toBe(EXIT_SUCCESS)
					expect(records(store)).toHaveLength(1)

					let { out } = await runTests(directory)

					expect(out).toContain("1 of 2 entries cached")
				},
			)
		})
	})

	// NOTE: A first run WRITES the file the key reads, so a record of it would
	// be keyed against a disk that no longer exists. One run later the entry has
	// compared itself against what it wrote and matched, and that run is the one
	// worth keeping.
	it("waits a run out where a snapshot was recorded", async () => {
		await withResults(async (store) => {
			await withFiles(
				{ "Greeting.tests.es": snapshotting },
				async (directory) => {
					let first = await runTests(directory)

					expect(first.out).toContain("1 snapshot written")
					expect(records(store)).toHaveLength(0)

					let second = await runTests(directory)

					expect(second.out).not.toContain("entries cached")
					expect(records(store)).toHaveLength(1)

					let third = await runTests(directory)

					expect(third.code).toBe(EXIT_SUCCESS)
					expect(third.out).toContain("1 of 1 entry cached")
				},
			)
		})
	})

	// NOTE: A stored snapshot is in the key, so accepting one by hand is a
	// different question and not the same one answered again.
	it("re-runs an entry whose stored snapshot changed", async () => {
		await withResults(async () => {
			await withFiles(
				{ "Greeting.tests.es": snapshotting },
				async (directory) => {
					await runTests(directory)
					await runTests(directory)

					let stored = path.join(
						directory,
						"__snapshots__",
						"Greeting.tests.es.snap",
					)

					writeFileSync(
						stored,
						readFileSync(stored, "utf8").replace(
							"Hello, Tigers",
							"Hello, Foxes",
						),
					)

					let { code, out } = await runTests(directory)

					expect(out).not.toContain("entries cached")
					expect(code).toBe(EXIT_FAILURE)
				},
			)
		})
	})

	// NOTE: Each of these is a run whose answer is not the question this store
	// asks — one that writes the files the key reads, one that measures a
	// machine, one that says which values a property draws. None of them may
	// read the store either: a replay would leave the run without the very thing
	// it was asked for.
	it("is inert under the flags that mean something else", async () => {
		for (let flags of [
			["--update"],
			["--coverage"],
			["--seed", "abcdef"],
			["--cases", "10"],
			["--bench"],
		]) {
			await withResults(async (store) => {
				await withFiles(
					{ "Standalone.tests.es": standalone },
					async (directory) => {
						await runTests(directory, flags)

						expect(records(store)).toHaveLength(0)

						await runTests(directory)
						expect(records(store)).toHaveLength(1)

						let { out } = await runTests(directory, flags)

						expect(out).not.toContain("entries cached")
					},
				)
			})
		}
	})

	// NOTE: A focus silences every other test of the run, so a replayed stream
	// would claim runs that must not happen. One focused live bundle discards
	// every hit and everything runs — and nothing at all is remembered out of it.
	it("discards every hit once a live entry turns out to be focused", async () => {
		await withResults(async (store) => {
			await withFiles(
				{ "Standalone.tests.es": standalone },
				async (directory) => {
					await runTests(directory)

					expect(records(store)).toHaveLength(1)

					writeFileSync(
						path.join(directory, "Focus.tests.es"),
						focused,
					)

					let { code, out } = await runTests(directory)

					expect(code).toBe(EXIT_FOCUSED)
					expect(out).not.toContain("entries cached")
					expect(out).toContain("1 passed")
					expect(out).toContain("2 not focused")
					// NOTE: Nothing new was written: a focused run reports what a
					// narrowing decided rather than what the code says.
					expect(records(store)).toHaveLength(1)
				},
			)
		})
	})

	// NOTE: Two entries reaching one Module WITH tests, which is the arrangement
	// `claimRegistries` exists for: only one of them may run that Module, and
	// which one is decided across the whole run in the order the entries were
	// named. A replayed entry is a bundle nobody loaded, so the claim it was
	// recorded under is checked against the claim this run would give it.
	const shared = [
		"implementation {",
		"\tconstant answer = 42",
		"}",
		"",
		"export {",
		"\tanswer",
		"}",
		"",
		"tests {",
		'\ttest "the shared Module holds" {',
		"\t\texpect true",
		"\t}",
		"}",
		"",
	].join("\n")

	const reader = [
		"import {",
		'\tfrom "./Shared.es" { answer }',
		"}",
		"",
		"tests {",
		'\ttest "reads the shared value" {',
		"\t\texpect answer::is(42)",
		"\t}",
		"}",
		"",
	].join("\n")

	const alone = [
		"tests {",
		'\ttest "reads the shared value" {',
		"\t\texpect 42::is(42)",
		"\t}",
		"}",
		"",
	].join("\n")

	it("keeps a shared Module with the entry that was running it", async () => {
		await withResults(async () => {
			await withFiles(
				{ "Shared.es": shared, "Reader.tests.es": reader },
				async (directory) => {
					await runTests(directory)

					// NOTE: Only the entry that CLAIMED the shared Module moves.
					// The other one is replayed, and what it claimed — nothing —
					// is what this run would give it too.
					writeFileSync(
						path.join(directory, "Reader.tests.es"),
						reader.replace("::is(42)", "::isNot(0)"),
					)

					let { code, out } = await runTests(directory)

					expect(code).toBe(EXIT_SUCCESS)
					expect(out).toContain("1 of 2 entries cached")
					expect(out).toContain("2 passed")
					expect(out).toContain("the shared Module holds")
				},
			)
		})
	})

	// NOTE: The case a replay would otherwise lose a whole Module to. The entry
	// that had been running the shared tests stops reaching it, so the run hands
	// them to the entry whose record says it runs nothing — and a record read
	// back under a claim that has moved is refused rather than replayed.
	it("re-runs a replayed entry whose claim has moved", async () => {
		await withResults(async () => {
			await withFiles(
				{ "Shared.es": shared, "Reader.tests.es": reader },
				async (directory) => {
					await runTests(directory)
					await runTests(directory)

					writeFileSync(
						path.join(directory, "Reader.tests.es"),
						alone,
					)

					let { code, out } = await runTests(directory)

					expect(code).toBe(EXIT_SUCCESS)
					expect(out).toContain("2 passed")
					expect(out).toContain("the shared Module holds")
					expect(out).toContain("reads the shared value")
					expect(out).not.toContain("entries cached")
				},
			)
		})
	})

	// NOTE: A tag only the replayed half of a project carries is a tag the run
	// knows. Warning about it would make the warning fire because the cache was
	// warm, which is the one thing it must never mean.
	it("knows the tags of an entry it replayed", async () => {
		await withResults(async () => {
			await withFiles({ "Rules.es": passing }, async (directory) => {
				await runTests(directory, ["--skip-tag", "slow"])

				let { err, out } = await runTests(directory, [
					"--skip-tag",
					"slow",
				])

				expect(out).toContain("1 of 1 entry cached")
				expect(err).not.toContain("no test carries tag")
			})
		})
	})

	// NOTE: The filters are in the key rather than a reason to refuse the store,
	// so a narrowed run is an answer of its own beside the whole one.
	it("keeps a narrowed run apart from the run it narrowed", async () => {
		await withResults(async (store) => {
			await withFiles({ "Rules.es": passing }, async (directory) => {
				await runTests(directory)
				await runTests(directory, ["--tag", "slow"])

				expect(records(store)).toHaveLength(2)

				let { out } = await runTests(directory, ["--tag", "slow"])

				expect(out).toContain("1 of 1 entry cached")
				expect(out).toContain("is slow")
			})
		})
	})

	// NOTE: What a replay CLAIMS is that these tests ran and said this, so the
	// report of a warm run has to be the report of the cold one it stands in for
	// — the same files in the same order, every test where it was. Only the tally
	// differs, which is where the run says so. Nothing in the tree is timed
	// except a benchmark's measurement, and measuring is one of the runs this
	// store is inert under.
	it("reads exactly as the run it stands in for", async () => {
		await withResults(async () => {
			await withFiles(
				{
					"Numbers.tests.es": property,
					"Standalone.tests.es": standalone,
					"Shared.es": shared,
					"Reader.tests.es": reader,
				},
				async (directory) => {
					let cold = await runTests(directory)
					let warm = await runTests(directory)

					expect(warm.out).toContain("3 of 4 entries cached")
					expect(tree(warm.out)).toBe(tree(cold.out))
				},
			)
		})
	})

	it("replays into the stream one event per line", async () => {
		await withResults(async () => {
			await withFiles(
				{ "Standalone.tests.es": standalone },
				async (directory) => {
					await runTests(directory, ["--json"])

					let { code, out } = await runTests(directory, ["--json"])
					let stream = events(out)

					expect(
						out
							.split("\n")
							.filter((line) => line !== "")
							.every((line) => line.startsWith('{"schema":1,')),
					).toBe(true)
					expect(stream.map((event) => event.kind)).toEqual([
						"run-start",
						"results-cached",
						"test-start",
						"expect",
						"test-pass",
						"run-end",
					])
					expect(stream[0]).toMatchObject({ tests: 1 })
					expect(stream[1]).toMatchObject({ tests: 1 })
					expect(stream.at(-1)).toMatchObject({
						passed: 1,
						failed: 0,
					})
					expect(code).toBe(EXIT_SUCCESS)
				},
			)
		})
	})

	it("is off where the variable says a disabling word", async () => {
		await withResults(async (store) => {
			await withFiles(
				{ "Standalone.tests.es": standalone },
				async (directory) => {
					await runTests(directory)

					expect(records(store)).toHaveLength(1)

					process.env.ESSENCE_RESULTS_CACHE = "off"

					let { code, out } = await runTests(directory)

					expect(code).toBe(EXIT_SUCCESS)
					expect(out).toContain("1 passed")
					expect(out).not.toContain("entries cached")
				},
			)
		})
	})
})

describe("the test command's own documentation", () => {
	it("says where a project writes the tags it skips", () => {
		expect(testCommand.description.join(" ")).toContain(
			'"essence": { "test": { "skipTags": ["slow"] } }',
		)
	})

	// NOTE: `optimisations.md` documents `--no-optimise --coverage` and turning
	// `instrument-coverage` off by name, and --coverage is a flag of this
	// command alone — so both documented combinations have to be spellable
	// here.
	it("takes the two flags that turn the Optimiser down", () => {
		expect(testCommand.options.map((option) => option.name)).toEqual(
			expect.arrayContaining(["no-optimise", "without-optimisation"]),
		)
	})

	it("is reachable under both names the binary is installed as", () => {
		let context = createContext(
			parseArguments(["test"], "essence").options,
			"essence",
		)

		expect(context.programName).toBe("essence")
		expect(findCommand("t")?.name).toBe("test")
	})
})
