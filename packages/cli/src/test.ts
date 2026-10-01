import { copyFile, link, mkdir, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import * as path from "node:path"
import { pathToFileURL } from "node:url"

import { displayPath } from "@essence-lang/compiler/diagnostics/render"
import {
	type BenchmarkStore,
	type BenchmarkWrites,
	collectBenchmarks,
	collectCorpusChanges,
	collectSnapshots,
	type CorpusStore,
	coverageReportFileName,
	hasCoverage,
	noBenchmarkWrites,
	noWrites,
	readBenchmarks,
	readCorpus,
	readSnapshots,
	type SnapshotStore,
	type SnapshotWrites,
	stagingDirectoryIn,
	sweepStagingDirectories,
	writeBenchmarks,
	writeCorpus,
	writeSnapshots,
} from "@essence-lang/compiler/testing"
import {
	type entryPoints,
	randomSeed,
	type Registry,
	registryOf,
	type TestEvent,
	type TestModule,
} from "@essence-lang/runtime/Testing"

import { EXIT_FAILURE, EXIT_FOCUSED, EXIT_SUCCESS, EXIT_USAGE } from "./actions"
import type { CommandSpec } from "./commands"
import {
	hasFailures,
	planCompilation,
	printDiagnostics,
	runCompilation,
} from "./compile"
import type { CLIContext } from "./context"
import { discoverTestFiles } from "./discovery"
import {
	bundleHashOf,
	createStoreReader,
	hostKey,
	linksEffectfulRuntime,
	readResult,
	RESULTS_FORMAT,
	type ResultRecord,
	resultCacheDirectory,
	resultKey,
	writeResult,
} from "./resultCache"
import { redirectStdout } from "./running"
import {
	collectCoverage,
	collectTestRun,
	type CoverageSummary,
	emptyCoverage,
	emptyRun,
	type FocusedTest,
	renderCoverage,
	renderFocusedTests,
	renderNoTests,
	renderTestReport,
	type TestRun,
	toCoverageJson,
	toLcov,
} from "./testReport"

// `essence test` compiles every file it is pointed at with the tests enriched,
// loads the bundles and drives each one's own runner in this process. A bundle
// inlines its own runtime, and each value's hidden Type key is a Symbol of that
// instance. So values stay inside the bundle, and only events cross back out.

// What a bundle publishes on its entry Module when its graph has a `tests`
// block. A bundle without tests publishes nothing, which is not an error.
type TestEntryPoints = typeof entryPoints

type LoadedTestBundle = { $tests?: TestEntryPoints }

// One compiled entry and everything its bundle registered. Two entries that
// reach one Module both carry its tests, so `claimRegistries` picks which
// entry runs them.
export type LoadedBundle = {
	inputFileName: string
	tests: TestEntryPoints
	modules: Array<TestModule>
}

// A bundle and the tests it is the one to run.
export type LoadedSuite = LoadedBundle & { registry: Registry }

// One entry whose answer a result cache held, written into the stream in
// place of running it. `tests` is how many it planned, which `run-start` counts.
type CachedEntry = {
	inputFileName: string
	tests: number
	events: Array<TestEvent>
}

// The entries a run replays from the result cache. A replayed entry is written
// where it would have run, so a warm run reports exactly what a cold one does.
type ReplayOptions = {
	entries?: Array<CachedEntry>
	// Every entry of the run by name, replayed and live alike. Without it, the
	// replays go first and the suites follow in the order given.
	order?: Array<string>
}

// How many tests one entry planned and how many its filters matched. A result
// cache records both so a replay can answer them without a bundle.
type EntrySelection = {
	inputFileName: string
	planned: number
	matched: number
}

// What a run tells every property test: `--seed`, `--cases`, and the values
// each one failed on before, read from the `__counterexamples__` companions.
type PropertyOptions = {
	seed?: string
	cases?: number | null
	counterexamples?: Record<string, CorpusStore>
}

// The stored snapshots of every Module in a run, and whether one that differs
// is recorded.
type SnapshotOptions = {
	stored?: Record<string, SnapshotStore>
	update?: boolean
}

// What a run reads from the coverage counters. A bundle compiled without them
// answers with nothing. `byTest` also records which points each test reached,
// which `--mutate` uses to run a mutant against only the tests that reach it.
type CoverageOptions = {
	byTest?: boolean
}

export type TestFilters = {
	filter: string | null
	tags: Array<string>
	skipTags: Array<string>
	// Whether benchmarks are measured. An unmeasured benchmark is deselected like
	// any filtered test, so the report says why it did not run.
	bench: boolean
}

// The key a Module is claimed by: its path, or its first test's id when the
// compile had no path. A result cache records claims under the same key.
function moduleKeyOf(module: TestModule): string {
	return module.module ?? module.tests[0]?.id ?? ""
}

function claimModules(
	modules: Array<TestModule>,
	claimed: Set<string>,
): Array<TestModule> {
	let kept: Array<TestModule> = []

	for (let module of modules) {
		if (module.tests.length === 0) {
			continue
		}

		let key = moduleKeyOf(module)

		if (claimed.has(key)) {
			continue
		}

		claimed.add(key)
		kept.push(module)
	}

	return kept
}

// Which bundle runs which Module. It is decided across the whole run in the
// order the entries were named, so reloading one entry never moves a Module.
// `claimed` holds Modules already given to entries a result cache answered.
export function claimRegistries(
	bundles: Array<LoadedBundle>,
	claimed: Set<string> = new Set(),
): Array<LoadedSuite> {
	return bundles.map((bundle) => ({
		...bundle,
		registry: registryOf(claimModules(bundle.modules, claimed)),
	}))
}

// Every focused test, for the refusal that names them. A skipped test's
// `focused` narrows nothing. `--mutate` refuses a focused baseline with the same
// list.
export function focusedTests(suites: Array<LoadedSuite>): Array<FocusedTest> {
	return suites.flatMap((suite) =>
		suite.registry.tests
			.filter((test) => test.entry.focused && test.entry.skipped === null)
			.map((test) => ({
				module: test.module.module,
				name: test.entry.name,
				suitePath: test.entry.suitePath,
				keywordPosition: test.entry.keywordPosition,
			})),
	)
}

// A run's staging directory, named for its process. A run a signal ended
// may not reach the code that removes its directory, so every run first sweeps
// the ones whose process has stopped.
export async function createStagingDirectory(prefix: string): Promise<string> {
	await sweepStagingDirectories(tmpdir(), prefix)

	let staging = stagingDirectoryIn(tmpdir(), prefix)

	await mkdir(staging)

	return staging
}

// Each bundle is imported from a fresh directory of its own. Bun's resolver
// remembers a directory's files once it resolves from it, so a file written
// there later is "Cannot find module". `import()` also caches by URL. Cache
// entries are never written to, so a hard link is safe.
async function stageBundle(
	staging: string,
	bundle: string,
	index: number,
): Promise<string> {
	let directory = path.join(staging, String(index))

	await mkdir(directory, { recursive: true })

	let staged = path.join(directory, "tests.mjs")

	// WARNING: an existing staged name may be a hard link to a cache entry, and
	// `copyFile` onto it would overwrite that entry. Removing it first keeps the
	// cache intact.
	await rm(staged, { force: true })

	try {
		await link(bundle, staged)
	} catch {
		await copyFile(bundle, staged)
	}

	return staged
}

export async function loadBundles(
	staging: string,
	outputFileNames: Array<{ inputFileName: string; bundle: string }>,
): Promise<Array<LoadedBundle>> {
	let bundles: Array<LoadedBundle> = []
	let index = 0

	for (let { inputFileName, bundle } of outputFileNames) {
		let staged = await stageBundle(staging, bundle, index)

		index += 1

		let loaded = (await import(
			pathToFileURL(staged).href
		)) as LoadedTestBundle
		let tests = loaded.$tests

		if (tests === undefined) {
			continue
		}

		bundles.push({
			inputFileName,
			tests,
			modules: tests
				.registry()
				.modules.filter((module) => module.tests.length > 0),
		})
	}

	return bundles
}

// Whether any bundle of a run holds a focused test. Selecting can wait on a
// setup that completes something, so the bundles are asked one at a time.
export async function holdsFocus(
	suites: Array<LoadedSuite>,
	bench: boolean | undefined,
): Promise<boolean> {
	for (let suite of suites) {
		if ((await suite.tests.select(suite.registry, { bench })).focused) {
			return true
		}
	}

	return false
}

// One run over several bundles. `all` is every bundle the run knows and
// `running` the ones to drive; a watch session drives fewer but decides focus
// across all. Once one bundle holds a focused test, every other runs nothing.
export async function runSuites(
	all: Array<LoadedSuite>,
	running: Array<LoadedSuite>,
	filters: TestFilters,
	// The suite an event came from, so a session holding one stream per entry
	// replaces the right one. Null for the run's own bookends.
	emit: (event: TestEvent, suite: LoadedSuite | null) => void,
	// `true` reads the whole table and nothing per test.
	coverage: boolean | CoverageOptions = false,
	// Bundles read no files, so the stored snapshots are read here.
	snapshots: SnapshotOptions = {},
	// The caller makes the seed, so every bundle of a run draws from one seed
	// and a printed replay reproduces the whole run.
	properties: PropertyOptions = {},
	// The stored baselines, by Module. `snapshots.update` also records a
	// measurement outside its band instead of failing it.
	benchmarks: Record<string, BenchmarkStore> = {},
	// Counted into the plan and written into the stream in their own place.
	replay: ReplayOptions = {},
): Promise<{
	planned: number
	focused: boolean
	matched: number
	// Per running suite, so a caller keeping one record per entry need not
	// select again, which would rerun every interpolating Module's setup.
	entries: Array<EntrySelection>
}> {
	let counters = coverage === true || coverage !== false
	let byTest = coverage !== true && coverage !== false && coverage.byTest
	// One bundle at a time: selecting runs each interpolating Module's setup to
	// render names, and a setup that completes something is waited for.
	let selected: Array<Awaited<ReturnType<LoadedSuite["tests"]["select"]>>> =
		[]

	for (let suite of all) {
		selected.push(await suite.tests.select(suite.registry, filters))
	}
	let focused = selected.some((selection) => selection.focused)
	let runFilters: TestFilters & { focusedElsewhere?: boolean } = focused
		? { ...filters, focusedElsewhere: true }
		: filters
	// Counted from the first selection: a bundle with a focused test selected
	// correctly, and one without runs nothing once another holds one.
	let entries = all.flatMap((suite, index): Array<EntrySelection> => {
		if (!running.includes(suite)) {
			return []
		}

		let selection = selected[index]!

		return [
			{
				inputFileName: suite.inputFileName,
				planned:
					focused && !selection.focused
						? 0
						: selection.selections.filter(
								(each) => each.state === "run",
							).length,
				matched: selection.matched,
			},
		]
	})
	let replayed = replay.entries ?? []
	let planned =
		entries.reduce((total, entry) => total + entry.planned, 0) +
		replayed.reduce((total, entry) => total + entry.tests, 0)

	emit({ schema: 1, kind: "run-start", tests: planned, focused }, null)

	let replays = new Map(replayed.map((entry) => [entry.inputFileName, entry]))
	let live = new Map(running.map((suite) => [suite.inputFileName, suite]))
	// Without an order, every replay still goes out, ahead of the suites.
	let sequence = replay.order ?? [
		...replays.keys(),
		...running.map((suite) => suite.inputFileName),
	]

	for (let inputFileName of sequence) {
		let entry = replays.get(inputFileName)

		if (entry !== undefined) {
			// Attributed to no suite, so a replayed record is never written back.
			// A focused run is never recorded, so a replay never holds focus.
			emit(
				{
					schema: 1,
					kind: "results-cached",
					entry: inputFileName,
					tests: entry.tests,
				},
				null,
			)

			for (let event of entry.events) {
				emit(event, null)
			}

			continue
		}

		let suite = live.get(inputFileName)

		// An entry neither replayed nor running published no tests.
		if (suite === undefined) {
			continue
		}

		await suite.tests.run(suite.registry, {
			// Each bundle's own bookends are dropped. This function writes the
			// run's `run-start` and the caller its `run-end`.
			sink: (event) => {
				if (event.kind === "run-start" || event.kind === "run-end") {
					return
				}

				emit(event, suite)
			},
			filters: runFilters,
			coverage: counters,
			coverageByTest: byTest,
			snapshots: snapshots.stored,
			benchmarks,
			update: snapshots.update,
			seed: properties.seed,
			cases: properties.cases ?? undefined,
			counterexamples: properties.counterexamples,
		})
	}

	return {
		planned,
		focused,
		// Across every bundle: a filter that matches in any file matched the run.
		matched: selected.reduce(
			(total, selection) => total + selection.matched,
			0,
		),
		entries,
	}
}

// A project's configured skip tags join `--skip-tag`, except a tag the command
// line names with `--tag`. So `--tag slow` runs what a project skips by default.
export function resolveFilters(
	options: {
		filter: string | undefined
		tag: Array<string>
		skipTag: Array<string>
		bench?: boolean
	},
	configured: Array<string>,
): TestFilters {
	let tags = [...new Set(options.tag)]
	let skipTags = [
		...new Set([
			...options.skipTag,
			...configured.filter((tag) => !tags.includes(tag)),
		]),
	]

	return {
		filter: options.filter ?? null,
		tags,
		skipTags,
		bench: options.bench === true,
	}
}

// `--contracts` or the setting turns the generated goals on, and
// `--no-contracts` turns them off whatever the setting says. Callers refuse
// both flags at once.
export function resolveContracts(
	options: { contracts: boolean; noContracts: boolean },
	configured: boolean,
): boolean {
	return options.noContracts ? false : options.contracts || configured
}

// Whether a run may read or write the result cache at all. `--json` is
// allowed and the filters are part of the key. See "What the result cache
// remembers" in DEVELOPMENT.md.
export function remembersResults(
	options: {
		update: boolean
		coverage: boolean
		bench: boolean
		mutate: boolean
		seed: string | undefined
		cases: number | null
	},
	// The project's configured case count. A run at that count is an ordinary
	// run and is remembered like one.
	configuredCases: number | null = null,
): boolean {
	return (
		!options.update &&
		!options.coverage &&
		!options.bench &&
		!options.mutate &&
		options.seed === undefined &&
		(options.cases === null || options.cases === configuredCases)
	)
}

// Whether an entry's stream may be recorded for a later run to replay. Failures,
// property tests, focus deselections and written snapshots or baselines are
// not. See "What the result cache remembers" in DEVELOPMENT.md.
function isRemembered(events: Array<TestEvent>): boolean {
	return events.every((event) => {
		switch (event.kind) {
			case "test-fail":
			case "property":
				return false
			case "test-deselected":
				return event.reason !== "not-focused"
			case "snapshot":
			case "benchmark":
				return event.status !== "written"
			default:
				return true
		}
	})
}

// Which Modules each entry would claim, the walk `claimRegistries` makes but
// over Module keys, so entries a result cache answered need no bundle. A
// replay is valid only while its entry claims what it claimed when recorded.
function planClaims(
	entries: Array<{ inputFileName: string; modules: Array<string> }>,
): Map<string, Array<string>> {
	let claimed = new Set<string>()
	let plan = new Map<string, Array<string>>()

	for (let entry of entries) {
		let kept: Array<string> = []

		for (let key of entry.modules) {
			if (claimed.has(key)) {
				continue
			}

			claimed.add(key)
			kept.push(key)
		}

		plan.set(entry.inputFileName, kept)
	}

	return plan
}

function sameClaim(left: Array<string>, right: Array<string>): boolean {
	return (
		left.length === right.length &&
		left.every((key, index) => key === right[index])
	)
}

// A run with no filter and no tags, as CI runs it. Only such a run fails on a
// leftover focused test.
function isPlainRun(filters: TestFilters, explicitSkipTags: number): boolean {
	return (
		filters.filter === null &&
		filters.tags.length === 0 &&
		explicitSkipTags === 0
	)
}

function reportUnknownTags(
	context: CLIContext,
	suites: Array<LoadedSuite>,
	named: Array<string>,
	// The tags of every replayed entry, which a result record keeps so a warm
	// cache never makes a known tag look unknown.
	alsoKnown: Array<string> = [],
): void {
	if (named.length === 0) {
		return
	}

	let known = new Set([
		...suites.flatMap((suite) =>
			suite.registry.tests.flatMap((test) => test.entry.tags),
		),
		...alsoKnown,
	])

	for (let tag of named) {
		if (known.has(tag)) {
			continue
		}

		context.terminal.err(
			`  ${context.palette.warning(
				context.theme.symbols.warning,
			)} ${context.palette.muted(`no test carries tag "${tag}"`)}`,
		)
	}
}

// Warns about a `--filter` that matched nothing, since a run that selected
// nothing otherwise looks like one where everything passed.
export function reportUnmatchedFilter(
	context: CLIContext,
	filter: string | null,
	matched: number,
): void {
	if (filter === null || matched > 0) {
		return
	}

	context.terminal.err(
		`  ${context.palette.warning(
			context.theme.symbols.warning,
		)} ${context.palette.muted(`no test matches "${filter}"`)}`,
	)
}

// Warns about a filter that matched only benchmarks in a run that does not
// measure them. `reportUnmatchedFilter` stays quiet there, since `selectTests`
// counts what the filter matched.
function reportBenchOnlyFilter(
	context: CLIContext,
	run: TestRun,
	filter: string | null,
	bench: boolean,
): void {
	if (bench || filter === null) {
		return
	}

	let ran = run.tests.some(
		(test) => test.state === "passed" || test.state === "failed",
	)
	let benched = run.tests.some(
		(test) => test.state === "deselected" && test.reason === "bench",
	)

	if (ran || !benched) {
		return
	}

	context.terminal.err(
		`  ${context.palette.warning(
			context.theme.symbols.warning,
		)} ${context.palette.muted(
			`"${filter}" matched only benchmarks — measure them with --bench`,
		)}`,
	)
}

export function printReport(
	context: CLIContext,
	run: TestRun,
	sources: Map<string, string>,
	coverage: CoverageSummary = emptyCoverage,
	snapshots: SnapshotWrites = noWrites,
	// Whether every entry came from the bundle cache, noted in the summary.
	cacheWarm = false,
	baselines: BenchmarkWrites = noBenchmarkWrites,
	// How many entries the run compiled, the total the replayed count is shown
	// against. Zero leaves that note off, as a watch session does.
	entries = 0,
): void {
	let { failures, summary, tree } = renderTestReport(
		run,
		context.report,
		(module) => (module === null ? null : (sources.get(module) ?? null)),
		snapshots.recorded,
		cacheWarm,
		baselines.recorded,
		entries,
	)

	if (!context.options.quiet && tree !== "") {
		context.terminal.out("")
		context.terminal.out(tree)
	}

	if (failures !== "") {
		context.terminal.err("")
		context.terminal.err(failures)
	}

	// The coverage table goes between the failures and the summary line.
	let table = context.options.quiet
		? []
		: renderCoverage(coverage, context.report)

	if (table.length > 0) {
		context.terminal.out("")

		for (let line of table) {
			context.terminal.out(line)
		}
	}

	if (!context.options.quiet) {
		context.terminal.out("")
		context.terminal.out(summary)
		context.terminal.out("")
	}
}

// Writes the coverage file when a format was named. A failure to write is a
// warning, not a failed run.
export async function writeCoverageReport(
	context: CLIContext,
	coverage: CoverageSummary,
): Promise<void> {
	let format = context.options.coverageReport

	if (format === null) {
		return
	}

	let written =
		format === "lcov" ? toLcov(coverage) : toCoverageJson(coverage)

	// A viewer reads an empty tracefile as a claim about zero files, so nothing
	// counted writes nothing.
	if (!hasCoverage(coverage)) {
		return
	}

	let directory = path.resolve(context.options.coverageOut ?? "coverage")
	let fileName = path.join(directory, coverageReportFileName(format))

	try {
		await mkdir(directory, { recursive: true })
		await writeFile(fileName, written, "utf8")
	} catch (error) {
		context.terminal.err(
			`  ${context.palette.warning(
				context.theme.symbols.warning,
			)} ${context.palette.muted(
				`could not write ${displayPath(fileName)}: ${String(error)}`,
			)}`,
		)

		return
	}

	if (!context.options.json && !context.options.quiet) {
		context.terminal.out(
			` ${context.palette.muted(
				`coverage written to ${displayPath(fileName)}`,
			)}`,
		)
	}
}

export async function runTest(
	context: CLIContext,
	command: CommandSpec,
	files: Array<string>,
): Promise<number> {
	if (context.options.contracts && context.options.noContracts) {
		context.terminal.err(
			"--contracts and --no-contracts contradict each other — say one.",
		)

		return EXIT_USAGE
	}

	let { configuration } = context
	let filters = resolveFilters(context.options, configuration.test.skipTags)
	let contracts = resolveContracts(
		context.options,
		configuration.test.contracts,
	)
	let writeEvent = process.stdout.write.bind(process.stdout)
	let events: Array<TestEvent> = []
	// The same events by entry, which result records are written from. `events`
	// keeps the run's order for the report and `--json`.
	let byEntry = new Map<string, Array<TestEvent>>()
	let emit = (event: TestEvent, suite: LoadedSuite | null = null): void => {
		events.push(event)

		if (suite !== null) {
			let held = byEntry.get(suite.inputFileName)

			if (held === undefined) {
				held = []
				byEntry.set(suite.inputFileName, held)
			}

			held.push(event)
		}

		if (context.options.json) {
			writeEvent(`${JSON.stringify(event)}\n`)
		}
	}

	let inputFileNames = await discoverTestFiles(
		files,
		command,
		context.programName,
		process.cwd(),
		configuration.root,
		configuration.exclude,
		contracts,
	)

	if (inputFileNames.length === 0) {
		emit({ schema: 1, kind: "run-start", tests: 0, focused: false })
		emit({
			schema: 1,
			kind: "run-end",
			passed: 0,
			failed: 0,
			skipped: 0,
			deselected: 0,
			duration: 0,
			focused: false,
		})

		if (!context.options.json && !context.options.quiet) {
			context.terminal.out("")
			context.terminal.out(renderNoTests(files, context.report))
			context.terminal.out("")
		}

		return EXIT_SUCCESS
	}

	let plan = await planCompilation(context, command, inputFileNames, {
		emit: true,
		cacheOutput: true,
		tests: true,
		contracts,
	})
	let compilation

	try {
		compilation = await runCompilation(context, plan, {
			cacheOutput: true,
			sourcemapMode: "inline",
		})
	} finally {
		await plan.dispatcher.dispose()
	}

	// Compile Diagnostics go to stderr even under `--json`, since they are not
	// events.
	printDiagnostics(context, compilation)

	// An entry that would not compile is named on stderr and left out, the rest
	// run, and the run ends non-zero. A stream always gets its `run-start`.
	let broken = compilation.outcomes.filter(
		(outcome) => !outcome.ok || outcome.outputFileName === null,
	)
	// Warm only when no entry had to be compiled.
	let cacheWarm =
		compilation.outcomes.length > 0 &&
		compilation.outcomes.every((outcome) => outcome.cached)

	for (let outcome of broken) {
		context.terminal.err(
			`  ${context.palette.warning(
				context.theme.symbols.warning,
			)} ${context.palette.muted(
				`${displayPath(outcome.inputFileName)} did not compile — its tests did not run`,
			)}`,
		)
	}

	let sources = new Map<string, string>()

	for (let outcome of compilation.outcomes) {
		for (let module of outcome.modules) {
			sources.set(module.fileName, module.sourceText)
		}
	}

	// The stores are read here because a bundle reads no files. Baselines are
	// read only when measuring.
	let stored = await readSnapshots(sources.keys())
	let baselines = context.options.bench
		? await readBenchmarks(sources.keys())
		: {}
	let corpus = await readCorpus(sources.keys())

	// An unreadable companion is neither replayed nor rewritten, so every run
	// warns about it.
	for (let entry of corpus.unreadable) {
		context.terminal.err(
			`  ${context.palette.warning(
				context.theme.symbols.warning,
			)} ${context.palette.muted(entry.problem)}`,
		)
	}
	// One seed for the whole run, which every property test folds its own
	// identity into.
	let seed = context.options.seed ?? randomSeed()

	let resultStore = remembersResults(
		context.options,
		configuration.test.cases,
	)
		? resultCacheDirectory()
		: null
	// The entries that have a bundle.
	let loadable = compilation.outcomes.flatMap((outcome) =>
		outcome.outputFileName === null
			? []
			: [{ ...outcome, outputFileName: outcome.outputFileName }],
	)
	let ordered = loadable.map((outcome) => outcome.inputFileName)
	let bundleOf = new Map(
		loadable.map((outcome) => [
			outcome.inputFileName,
			outcome.outputFileName,
		]),
	)
	let keys = new Map<string, string>()
	let hits = new Map<string, ResultRecord>()

	if (resultStore !== null) {
		let readStores = createStoreReader()
		let host = hostKey()

		for (let outcome of loadable) {
			// An entry that did not compile neither reads nor writes the store:
			// its bundle may be an older run's.
			if (!outcome.ok) {
				continue
			}

			let key = resultKey({
				bundleHash: bundleHashOf(outcome.outputFileName),
				stores: await readStores(
					outcome.modules.map((module) => module.fileName),
				),
				filters,
				host,
			})

			keys.set(outcome.inputFileName, key)

			let held = await readResult(resultStore, key)

			if (held !== null) {
				hits.set(outcome.inputFileName, held)
			}
		}
	}

	let staging = await createStagingDirectory("essence-test-")
	let restore = redirectStdout()
	let suites: Array<LoadedSuite>
	let run: TestRun = emptyRun
	let matchedNames = 0
	let selections: Array<EntrySelection> = []

	try {
		// Each call stages into a directory of its own. Staging is numbered
		// within a call, and `import()` caches by URL, so two calls into one
		// directory would load the first bundle twice.
		let staged = 0
		let live = new Map<string, LoadedBundle>()
		let load = async (names: Array<string>): Promise<void> => {
			let loaded = await loadBundles(
				path.join(staging, String(staged)),
				names.map((name) => ({
					inputFileName: name,
					bundle: bundleOf.get(name)!,
				})),
			)

			staged += 1

			for (let bundle of loaded) {
				live.set(bundle.inputFileName, bundle)
			}
		}

		await load(ordered.filter((name) => !hits.has(name)))

		let claimBundles = (): Array<LoadedBundle> =>
			ordered.flatMap((name) => {
				let bundle = live.get(name)

				return bundle === undefined ? [] : [bundle]
			})
		// What the run would give each entry if every bundle were loaded. A hit
		// reads its Modules from its record, which its bundle hash pins.
		let plan = planClaims(
			ordered.map((name) => ({
				inputFileName: name,
				modules:
					hits.get(name)?.modules ??
					(live.get(name)?.modules ?? []).map(moduleKeyOf),
			})),
		)
		// A hit whose claim moved, because an earlier entry now reaches a shared
		// Module or no longer does, runs live. Demoting it moves no other claim.
		let moved = ordered.filter((name) => {
			let held = hits.get(name)

			return (
				held !== undefined &&
				!sameClaim(plan.get(name) ?? [], held.claimed)
			)
		})

		if (moved.length > 0) {
			for (let name of moved) {
				hits.delete(name)
			}

			await load(moved)
		}

		// The Modules the surviving hits hold, so a live entry never reports
		// tests a replay reports.
		let claimHits = (): Set<string> =>
			new Set([...hits.keys()].flatMap((name) => plan.get(name) ?? []))

		suites = claimRegistries(claimBundles(), claimHits())

		// A focused live bundle silences every other test, so it discards every
		// hit and everything runs live. Of the filters, focus depends only on
		// `bench`, so the probe passes no other.
		if (hits.size > 0 && (await holdsFocus(suites, filters.bench))) {
			let demoted = [...hits.keys()]

			hits.clear()

			await load(demoted)

			suites = claimRegistries(claimBundles())
		}

		let cached = ordered.flatMap((name): Array<CachedEntry> => {
			let held = hits.get(name)

			return held === undefined
				? []
				: [
						{
							inputFileName: name,
							tests: held.tests,
							events: held.events,
						},
					]
		})

		let started = performance.now()
		let { focused, matched, entries } = await runSuites(
			suites,
			suites,
			filters,
			emit,
			context.options.coverage,
			{ stored, update: context.options.update },
			{
				seed,
				cases: context.options.cases,
				counterexamples: corpus.stores,
			},
			baselines,
			{ entries: cached, order: ordered },
		)
		// `run-end` carries the counts of the one fold of the events, and the
		// duration measured around the run.
		let duration = performance.now() - started

		// Across live and replayed entries: a filter that matched in either
		// matched the run.
		matchedNames =
			matched +
			[...hits.values()].reduce((total, held) => total + held.matched, 0)
		selections = entries
		run = { ...collectTestRun(events), duration }

		emit({
			schema: 1,
			kind: "run-end",
			passed: run.counts.passed,
			failed: run.counts.failed,
			skipped: run.counts.skipped,
			deselected: run.counts.notFocused + run.counts.deselected,
			duration,
			focused,
		})
	} finally {
		restore()
		// A loaded Module no longer needs its staged file. The cache entry it
		// links to stays.
		await rm(staging, { recursive: true, force: true })
	}

	reportUnknownTags(
		context,
		suites,
		[...filters.tags, ...context.options.skipTag],
		[...hits.values()].flatMap((held) => held.tags),
	)
	reportUnmatchedFilter(context, filters.filter, matchedNames)
	reportBenchOnlyFilter(context, run, filters.filter, context.options.bench)

	let coverage = context.options.coverage
		? collectCoverage(events)
		: emptyCoverage
	// The stores are written before the report, so what it says was recorded
	// is on disk.
	let written = await writeSnapshots({
		snapshots: collectSnapshots(events),
		sources,
		stored,
		// A loader, so only a run that writes an inline snapshot loads the
		// Formatter.
		inline: async () =>
			(await import("@essence-lang/formatter/snapshots"))
				.writeInlineSnapshots,
	})

	// Without `--bench` nothing was measured, so `--update` writes no baseline.
	let recorded = await writeBenchmarks({
		benchmarks: collectBenchmarks(events),
		stored: baselines,
	})

	// So the next run replays the values this one failed on.
	let kept = await writeCorpus({
		corpus,
		...collectCorpusChanges(events),
	})

	for (let problem of [
		...written.problems,
		...recorded.problems,
		...kept.problems,
	]) {
		context.terminal.err(
			`  ${context.palette.warning(
				context.theme.symbols.warning,
			)} ${context.palette.muted(problem)}`,
		)
	}

	// Records are written after the stores, so their keys read a settled disk.
	// A focused run records nothing. See "What the result cache remembers" in
	// DEVELOPMENT.md.
	if (resultStore !== null && !run.focused) {
		for (let suite of suites) {
			let key = keys.get(suite.inputFileName)
			let stream = byEntry.get(suite.inputFileName) ?? []
			let selection = selections.find(
				(entry) => entry.inputFileName === suite.inputFileName,
			)

			if (
				key === undefined ||
				selection === undefined ||
				!isRemembered(stream)
			) {
				continue
			}

			// The key holds no host input, which a Module's own statements read
			// as the bundle loads.
			if (suite.tests.hasReadHostInput()) {
				continue
			}

			// The key holds nothing drawn from the machine's entropy either.
			if (suite.tests.hasDrawnEntropy()) {
				continue
			}

			// An entry whose bundle links the effectful runtime is never recorded,
			// so a warm run need not read the bundles it replays.
			if (
				await linksEffectfulRuntime(bundleOf.get(suite.inputFileName)!)
			) {
				continue
			}

			await writeResult(resultStore, key, {
				format: RESULTS_FORMAT,
				entry: suite.inputFileName,
				tags: [
					...new Set(
						suite.registry.tests.flatMap((test) => test.entry.tags),
					),
				].sort(),
				tests: selection.planned,
				matched: selection.matched,
				modules: suite.modules.map(moduleKeyOf),
				claimed: suite.registry.modules.map(moduleKeyOf),
				events: stream,
			})
		}
	}

	if (!context.options.json) {
		printReport(
			context,
			run,
			sources,
			coverage,
			written,
			cacheWarm,
			recorded,
			ordered.length,
		)
	}

	await writeCoverageReport(context, coverage)

	if (run.counts.failed > 0 || hasFailures(compilation)) {
		return EXIT_FAILURE
	}

	if (run.focused && isPlainRun(filters, context.options.skipTag.length)) {
		if (!context.options.json) {
			let rendered = renderFocusedTests(
				focusedTests(suites),
				context.report,
				(module) =>
					module === null ? null : (sources.get(module) ?? null),
			)

			context.terminal.err("")

			for (let block of rendered) {
				context.terminal.err(block)
			}
		}

		return EXIT_FOCUSED
	}

	return EXIT_SUCCESS
}
