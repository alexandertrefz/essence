import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { spawnSync } from "node:child_process"
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"

import type { TestEvent } from "@essence-lang/runtime/Testing"

import { EXIT_FAILURE, EXIT_FOCUSED, EXIT_SUCCESS } from "../actions"
import { parseArguments, UsageError } from "../args"
import { findCommand } from "../commands"
import { readProjectConfiguration } from "../configuration"
import { createContext } from "../context"
import { discoverTestFiles, namesTests } from "../discovery"
import { run } from "../index"
import type { ReportContext } from "../report"
import { resolveFilters } from "../test"
import {
	collectTestRun,
	focusedTestsDiagnostic,
	renderTestSummary,
	renderTestTree,
	testFailureDiagnostic,
} from "../testReport"
import { createPalette, createTheme } from "../theme"

// NOTE: A bundle cache of this spec's own. It is assigned rather than exported
// because where the cache lives is read off the environment every time it is
// asked for, and restored afterwards so that a suite running beside this one
// keeps the directory it named.
let bundleCache = mkdtempSync(path.join(tmpdir(), "essence-test-cache-"))
let previousCache: string | undefined

beforeAll(() => {
	previousCache = process.env.ESSENCE_CLI_CACHE
	process.env.ESSENCE_CLI_CACHE = bundleCache
})

afterAll(() => {
	if (previousCache === undefined) {
		delete process.env.ESSENCE_CLI_CACHE
	} else {
		process.env.ESSENCE_CLI_CACHE = previousCache
	}

	rmSync(bundleCache, { recursive: true, force: true })
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

async function withFiles<Value>(
	files: Record<string, string>,
	body: (directory: string) => Promise<Value>,
): Promise<Value> {
	let directory = mkdtempSync(path.join(tmpdir(), "essence-tests-"))

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

// NOTE: Everything the CLI writes goes through `process.stdout` and
// `process.stderr`, so driving `run` from a spec means holding both for the
// length of the call — including the window in which the runner points stdout
// at stderr while a bundle is loading.
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

const failing = [
	"tests {",
	'\ttest "adds two and two" {',
	"\t\texpect 2::add(2)::is(5)",
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
	"tests {",
	'\ttest "doubles a positive number" {',
	"\t\texpect double(2)::is(4)",
	"\t}",
	"}",
	"",
	"export {",
	"\tdoubled",
	"}",
	"",
].join("\n")

const importing = [
	"import {",
	'\tdoubled from "./Rules.es"',
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
	it("reads the tags a project skips by default", async () => {
		await withFiles(
			{
				"package.json": JSON.stringify({
					essence: { test: { skipTags: ["slow"] } },
				}),
				"nested/deep/keep.txt": "",
			},
			async (directory) => {
				let configuration = await readProjectConfiguration(
					path.join(directory, "nested", "deep"),
				)

				expect(configuration.test.skipTags).toEqual(["slow"])
				expect(configuration.problems).toEqual([])
			},
		)
	})

	it("walks past a package.json with nothing to say about Essence", async () => {
		await withFiles(
			{
				"package.json": JSON.stringify({
					essence: { test: { skipTags: ["slow"] } },
				}),
				"inner/package.json": JSON.stringify({ name: "inner" }),
			},
			async (directory) => {
				let configuration = await readProjectConfiguration(
					path.join(directory, "inner"),
				)

				expect(configuration.test.skipTags).toEqual(["slow"])
			},
		)
	})

	it("reports a setting of the wrong shape rather than obeying it", async () => {
		await withFiles(
			{
				"package.json": JSON.stringify({
					essence: { test: { skipTags: "slow" } },
				}),
			},
			async (directory) => {
				let configuration = await readProjectConfiguration(directory)

				expect(configuration.test.skipTags).toEqual([])
				expect(configuration.problems).toHaveLength(1)
				expect(configuration.problems[0]).toContain(
					"essence.test.skipTags",
				)
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
		).toEqual({ filter: null, tags: ["slow"], skipTags: [] })

		expect(
			resolveFilters({ filter: undefined, tag: [], skipTag: [] }, [
				"slow",
			]),
		).toEqual({ filter: null, tags: [], skipTags: ["slow"] })
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

	it("reports a compile error and runs nothing", async () => {
		await withFiles(
			{
				"Broken.tests.es": [
					"tests {",
					'\ttest "asserts a String" {',
					'\t\texpect "not a Boolean"',
					"\t}",
					"}",
					"",
				].join("\n"),
			},
			async (directory) => {
				let { code, err, out } = await runTests(directory)

				expect(err).toContain("expect-not-boolean")
				expect(out).not.toContain("passed")
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
		id: "/Standings.es/renders a forfeit",
		name: "renders a forfeit",
		suitePath: [],
		module: "/Standings.es",
		reason: "waiting on the Table redesign",
	},
	{
		schema: 1,
		kind: "test-deselected",
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

describe("the test command's own documentation", () => {
	it("says where a project writes the tags it skips", () => {
		expect(testCommand.description.join(" ")).toContain(
			'"essence": { "test": { "skipTags": ["slow"] } }',
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
