import { copyFile, link, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import * as path from "node:path"
import { pathToFileURL } from "node:url"
import { format } from "node:util"

import { displayPath } from "@essence-lang/compiler/diagnostics/render"
import {
	type BenchmarkStore,
	type BenchmarkWrites,
	collectBenchmarks,
	collectSnapshots,
	coverageReportFileName,
	hasCoverage,
	noBenchmarkWrites,
	noWrites,
	readBenchmarks,
	readSnapshots,
	type SnapshotStore,
	type SnapshotWrites,
	writeBenchmarks,
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

import { EXIT_FAILURE, EXIT_FOCUSED, EXIT_SUCCESS } from "./actions"
import type { CommandSpec } from "./commands"
import {
	hasFailures,
	planCompilation,
	printDiagnostics,
	runCompilation,
} from "./compile"
import { readProjectConfiguration } from "./configuration"
import type { CLIContext } from "./context"
import { discoverTestFiles } from "./discovery"
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

// NOTE: `essence test` compiles every file it was pointed at with the tests
// enriched, loads the bundles it emitted, and drives each one's own runner. The
// run happens IN THIS PROCESS: a bundle inlines a runtime of its own, and every
// value a test builds carries a hidden Type key that is a Symbol of that
// instance — so everything that touches a value has to run inside the bundle,
// and what crosses back out is events, which are plain data and already
// rendered. `$tests` is the one name this file looks up, and `registryOf` the
// one runtime function it calls, because indexing a manifest reads no value.

// NOTE: What a bundle publishes on its entry Module when any Module of its
// graph wrote a `tests { … }` block. A bundle built from sources with no tests
// in them publishes nothing, which is not an error — it is the answer.
type TestEntryPoints = typeof entryPoints

type LoadedTestBundle = { $tests?: TestEntryPoints }

// NOTE: One compiled entry and everything its bundle registered. The tests it
// RUNS are a subset — two entries that reach one Module both carry that
// Module's tests, and running them twice would report every one of them twice —
// which is what `claimRegistries` works out across the whole run.
export type LoadedBundle = {
	inputFileName: string
	tests: TestEntryPoints
	modules: Array<TestModule>
}

// NOTE: A bundle and the tests it is the one to run.
export type LoadedSuite = LoadedBundle & { registry: Registry }

// NOTE: What a run tells every property test of it. Both are the command
// line's: `--seed` and `--cases`.
export type PropertyOptions = { seed?: string; cases?: number | null }

// NOTE: What a run knows about snapshots before it starts: the stored entries
// of every Module in it, and whether one that differs is to be recorded.
export type SnapshotOptions = {
	stored?: Record<string, SnapshotStore>
	update?: boolean
}

export type TestFilters = {
	filter: string | null
	tags: Array<string>
	skipTags: Array<string>
	// NOTE: Whether the benchmarks of the run are measured. It is a FILTER
	// rather than a mode: a benchmark nobody asked to measure is deselected
	// through the same selection everything else goes through, so the report
	// says why it did not run in the place it would have run.
	bench: boolean
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

		// NOTE: A Module's tests all arrive together, so what is claimed is the
		// Module — by its path, or by the id of its first test where a compile
		// had no path to give (which the CLI never does, and a spec driving one
		// program might).
		let key = module.module ?? module.tests[0].id

		if (claimed.has(key)) {
			continue
		}

		claimed.add(key)
		kept.push(module)
	}

	return kept
}

// NOTE: Which bundle runs which Module, decided across the whole run rather
// than as the bundles arrive — so that a session re-loading ONE entry does not
// silently take a shared Module away from the entry that has been running it.
// The order is the order the entries were compiled in, which is the order they
// were named in, so the answer is the same every time it is asked.
export function claimRegistries(
	bundles: Array<LoadedBundle>,
): Array<LoadedSuite> {
	let claimed = new Set<string>()

	return bundles.map((bundle) => ({
		...bundle,
		registry: registryOf(claimModules(bundle.modules, claimed)),
	}))
}

// NOTE: Every test the run was narrowed to, so that the refusal at the end can
// point at each of them. A skipped test's `focused` narrows nothing — it does
// not run either way — and is not what has to go.
function focusedTests(suites: Array<LoadedSuite>): Array<FocusedTest> {
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

// NOTE: Bun's module resolver remembers what a directory held the first time it
// resolved anything out of it, so a file that appears there afterwards is
// invisible to `import()` — "Cannot find module", about a file plainly on disk.
// Nothing else in the CLI meets it: `esc run` SPAWNS the bundle it built, and a
// fresh process has nothing remembered. A run that loads its bundles in this
// process meets it the moment it loads a second one, and a watch session would
// meet it on every save. So every bundle a run loads is staged in a directory
// of its own, which no resolver has ever read: a hard link where the filesystem
// allows one — a bundle is content-addressed, and nobody writes to it — and a
// copy where it does not.
async function stageBundle(
	staging: string,
	bundle: string,
	index: number,
): Promise<string> {
	let directory = path.join(staging, String(index))

	await mkdir(directory, { recursive: true })

	let staged = path.join(directory, "tests.mjs")

	// NOTE: The name is taken first, and this is not tidiness. A staged bundle
	// is a HARD LINK to the cache entry, so a `copyFile` onto a staged name that
	// already exists writes THROUGH the link and overwrites the cache entry
	// itself — a content-addressed name would then answer with somebody else's
	// bundle, in this session and in every later one. Unlinking first means a
	// copy makes a file of its own whatever was there.
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

// NOTE: One run over several bundles. `all` is every bundle the run knows
// about and `running` the ones to drive — the two differ only for a watch
// session, which re-runs what a change reached and leaves the rest as they
// were, but has to decide FOCUS across every test it holds all the same.
//
// NOTE: Whether the run holds a focus is each bundle's own answer, asked of the
// bundle — the rule for what counts as focused lives in the runtime and is not
// worth a second spelling here. Once one bundle says yes, every bundle is told
// so, and the ones holding no focused test of their own deselect everything
// through the same selection that runs the rest.
export function runSuites(
	all: Array<LoadedSuite>,
	running: Array<LoadedSuite>,
	filters: TestFilters,
	// NOTE: The suite an event came out of, so a session holding one stream per
	// entry can replace the right one. Null for the run's own bookend, which
	// belongs to no bundle.
	emit: (event: TestEvent, suite: LoadedSuite | null) => void,
	// NOTE: Whether each bundle writes what its counters counted. A bundle
	// compiled without the instrumentation has none, so asking costs nothing
	// and answers with nothing — which is why the flag is passed through rather
	// than guessed at from the events.
	coverage = false,
	// NOTE: What every `matches snapshot from "name"` of the run compares
	// against, keyed by Module — read off disk here because a bundle reads
	// nothing — and whether a difference is RECORDED rather than reported.
	snapshots: SnapshotOptions = {},
	// NOTE: What every property test of the run draws from, and how many values
	// each of them runs for. The SEED is made here rather than in the runtime,
	// because one run over several bundles is one run and every bundle has to
	// draw from the same one — which is what makes the replay a report prints
	// reproduce a whole run and not just one file of it.
	properties: PropertyOptions = {},
	// NOTE: The baselines every benchmark of the run is held to, keyed by
	// Module — read off disk here, like the snapshots above, because a bundle
	// reads nothing. Whether a measurement outside its band is RECORDED rather
	// than failed is `snapshots.update`: it is one flag, and a run that accepts
	// what it produced accepts all of it.
	benchmarks: Record<string, BenchmarkStore> = {},
): { planned: number; focused: boolean; matched: number } {
	let selected = all.map((suite) =>
		suite.tests.select(suite.registry, filters),
	)
	let focused = selected.some((selection) => selection.focused)
	let runFilters: TestFilters & { focusedElsewhere?: boolean } = focused
		? { ...filters, focusedElsewhere: true }
		: filters
	// NOTE: A bundle that holds a focused test already selected correctly
	// above; one that holds none runs nothing at all once another bundle does.
	// So the count is read off the selection that was already made, rather than
	// made a second time under the wider filters.
	let planned = all.reduce((total, suite, index) => {
		let selection = selected[index]!

		if (!running.includes(suite) || (focused && !selection.focused)) {
			return total
		}

		return (
			total +
			selection.selections.filter((each) => each.state === "run").length
		)
	}, 0)

	emit({ schema: 1, kind: "run-start", tests: planned, focused }, null)

	for (let suite of running) {
		suite.tests.run(suite.registry, {
			// NOTE: One run over several bundles is still one run, so each
			// bundle's own bookends are dropped and the pair around the whole
			// of it is written by the caller.
			sink: (event) => {
				if (event.kind === "run-start" || event.kind === "run-end") {
					return
				}

				emit(event, suite)
			},
			filters: runFilters,
			coverage,
			snapshots: snapshots.stored,
			benchmarks,
			update: snapshots.update,
			seed: properties.seed,
			cases: properties.cases ?? undefined,
		})
	}

	return {
		planned,
		focused,
		// NOTE: Across every bundle, because a filter names a test and the run
		// is what holds the tests — a name that matches nothing in this file
		// and something in the next one matched the run.
		matched: selected.reduce(
			(total, selection) => total + selection.matched,
			0,
		),
	}
}

// NOTE: `--skip-tag` wins over `--tag`, and a project's configured default is a
// `--skip-tag` the command line did not have to write — except for a tag the
// command line ASKED for, which is the whole point of configuring one. A
// project that skips `slow` by default is a project where `essence test --tag
// slow` is how the nightly job runs them.
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

// NOTE: A run nobody narrowed — no filter, no tags — is what CI runs, and it is
// the run a leftover `focused` may not survive. Under any filter, focusing is
// ordinary working practice and says nothing about the branch.
function isPlainRun(filters: TestFilters, explicitSkipTags: number): boolean {
	return (
		filters.filter === null &&
		filters.tags.length === 0 &&
		explicitSkipTags === 0
	)
}

export function reportUnknownTags(
	context: CLIContext,
	suites: Array<LoadedSuite>,
	named: Array<string>,
): void {
	if (named.length === 0) {
		return
	}

	let known = new Set(
		suites.flatMap((suite) =>
			suite.registry.tests.flatMap((test) => test.entry.tags),
		),
	)

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

// NOTE: A filter that named nothing. `--tag` says so already, and a `--filter`
// that quietly reports "0 passed" is the worse half of the pair: a run that
// selected nothing looks exactly like a run where everything held — and the
// replay a failing property test prints is spelled with a `-f`.
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
		)} ${context.palette.muted(`no test name contains "${filter}"`)}`,
	)
}

// NOTE: A Module's own top-level output — a `Terminal.print` outside any test —
// is written by the bundle as it is evaluated: before any test is running, and
// with no test to attribute it to. It is not part of the report, and under
// --json stdout carries the event stream and nothing else — so for the length
// of the load and the run stdout is pointed at stderr, where the output still
// arrives and still streams. What a test itself writes never comes through
// here: the runtime captures it against the test and the report shows it with
// the failure.
//
// NOTE: `console.log` is pointed at stderr as well, and that is not belt and
// braces. `Terminal.inspect` renders a whole line and writes it through
// `console.log`, which under Bun goes to the file descriptor DIRECTLY and never
// through `process.stdout.write` — so a Module that inspects a value at its top
// level would put its rendering on stdout ahead of the first event, and a
// consumer parsing the stream a line at a time would die on it. It is written
// through `process.stderr.write` rather than through `console.error` so that
// whatever holds the two streams — a spec, a parent process — sees it where it
// sees everything else.
export function redirectStdout(): () => void {
	let original = process.stdout.write
	let log = console.log

	process.stdout.write = ((
		chunk: string | Uint8Array,
		...rest: Array<unknown>
	) =>
		(
			process.stderr.write as unknown as (
				value: string | Uint8Array,
				...args: Array<unknown>
			) => boolean
		)(chunk, ...rest)) as typeof process.stdout.write

	console.log = ((...values: Array<unknown>) => {
		process.stderr.write(`${format(...values)}\n`)
	}) as typeof console.log

	return () => {
		process.stdout.write = original
		console.log = log
	}
}

export function printReport(
	context: CLIContext,
	run: TestRun,
	sources: Map<string, string>,
	coverage: CoverageSummary = emptyCoverage,
	snapshots: SnapshotWrites = noWrites,
	// NOTE: Whether the compile this run stands on emitted nothing, every entry
	// of it having been in the bundle cache already. It is the design's own
	// note at the end of the summary, and it is the difference between a fast
	// run and a fast run that also compiled the project.
	cacheWarm = false,
	// NOTE: What the run recorded as baselines, which is what a snapshot count
	// is beside it: a measurement written for the first time is a pass that
	// left something on disk, and a reader has to be told without going to look.
	baselines: BenchmarkWrites = noBenchmarkWrites,
): void {
	let { failures, summary, tree } = renderTestReport(
		run,
		context.report,
		(module) => (module === null ? null : (sources.get(module) ?? null)),
		snapshots.recorded,
		cacheWarm,
		baselines.recorded,
	)

	if (!context.options.quiet && tree !== "") {
		context.terminal.out("")
		context.terminal.out(tree)
	}

	if (failures !== "") {
		context.terminal.err("")
		context.terminal.err(failures)
	}

	// NOTE: Between the failures and the summary line — a reader who has just
	// been told what broke reads what was reached next, and the counts stay
	// where they have always been, at the bottom.
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

// NOTE: The written half of a coverage run. Nothing is written unless a format
// was named: a table is what `--coverage` promises, and a file left in a
// project nobody asked for is litter. The directory is made on the way, and a
// failure to write is a WARNING rather than a failure of the run — the tests
// have already answered, and a full disk is not a broken test.
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

	// NOTE: Nothing counted is nothing to write. An empty tracefile is not an
	// empty report — a viewer reads it as a valid claim about zero files — and
	// a directory made for it is litter.
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
	let configuration = await readProjectConfiguration()

	for (let problem of configuration.problems) {
		context.terminal.err(
			`  ${context.palette.warning(
				context.theme.symbols.warning,
			)} ${context.palette.muted(problem)}`,
		)
	}

	let filters = resolveFilters(context.options, configuration.test.skipTags)
	let writeEvent = process.stdout.write.bind(process.stdout)
	let events: Array<TestEvent> = []
	let emit = (event: TestEvent): void => {
		events.push(event)

		if (context.options.json) {
			writeEvent(`${JSON.stringify(event)}\n`)
		}
	}

	let inputFileNames = await discoverTestFiles(
		files,
		command,
		context.programName,
		process.cwd(),
		configuration.test.exclude,
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

	// NOTE: Compile Diagnostics go to stderr whatever was asked for, including
	// under --json: they are not events, and a run that could not be compiled
	// has to say why somewhere.
	printDiagnostics(context, compilation)

	// NOTE: An entry that would not compile is LEFT OUT rather than taken as
	// the end of the run. A project where one file is half-typed is exactly the
	// project whose other twenty files are worth hearing about, and a stream
	// that stopped before its `run-start` tells a consumer nothing at all — not
	// that the run failed, not that it is over. So the broken entries are named
	// on stderr, the rest run, and the run ends non-zero because something in it
	// could not be compiled. `--watch` has always worked this way.
	let broken = compilation.outcomes.filter(
		(outcome) => !outcome.ok || outcome.outputFileName === null,
	)
	// NOTE: Warm when the emitter ran for nothing at all. A run where one entry
	// had to be compiled is not a warm one, and saying so of it would make the
	// note say nothing.
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

	// NOTE: Read before the run and handed over whole: a stored snapshot is a
	// file, and the runtime is a bundle that reads none.
	let stored = await readSnapshots(sources.keys())
	// NOTE: The same, and only where the run is measuring — a run with no
	// benchmark in it would otherwise stat a `__benchmarks__` directory per
	// Module to be told what it already knows.
	let baselines = context.options.bench
		? await readBenchmarks(sources.keys())
		: {}
	// NOTE: One seed for the whole run, made HERE where there is one run: every
	// bundle draws from it, and every property test folds its own identity in.
	// So the replay a failure prints reproduces the run rather than the file.
	let seed = context.options.seed ?? randomSeed()
	let staging = await mkdtemp(path.join(tmpdir(), "essence-test-"))
	let restore = redirectStdout()
	let suites: Array<LoadedSuite>
	let run: TestRun = emptyRun
	let matchedNames = 0

	try {
		suites = claimRegistries(
			await loadBundles(
				staging,
				compilation.outcomes.flatMap((outcome) =>
					outcome.outputFileName === null
						? []
						: [
								{
									inputFileName: outcome.inputFileName,
									bundle: outcome.outputFileName,
								},
							],
				),
			),
		)

		let started = performance.now()
		let { focused, matched } = runSuites(
			suites,
			suites,
			filters,
			emit,
			context.options.coverage,
			{ stored, update: context.options.update },
			{ seed, cases: context.options.cases },
			baselines,
		)
		// NOTE: The stream is folded up ONCE, here, and the `run-end` this
		// writes carries the counts it found. Re-reading the stream afterwards
		// would walk every `expect` of every test a second time to be told what
		// it already knows; the only thing `run-end` adds to the fold is the
		// duration measured around the loop, which is put back below.
		let duration = performance.now() - started

		matchedNames = matched
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
		// NOTE: The staged links go once the bundles have been read. A Module
		// that is already loaded does not need its file any more, and the
		// bundle they were made from is the cache's and stays where it is.
		await rm(staging, { recursive: true, force: true })
	}

	reportUnknownTags(context, suites, [
		...filters.tags,
		...context.options.skipTag,
	])
	reportUnmatchedFilter(context, filters.filter, matchedNames)

	let coverage = context.options.coverage
		? collectCoverage(events)
		: emptyCoverage
	// NOTE: Written before the report, so that what the report says was
	// recorded is what is on disk by the time a reader looks.
	let written = await writeSnapshots({
		snapshots: collectSnapshots(events),
		sources,
		stored,
		// NOTE: Reached through a dynamic import, like every other delegate the
		// command line has: `essence build` must not pay for the Formatter,
		// and a run with no inline snapshot in it does not either — which is
		// why what is handed over is the LOADER rather than what it loads.
		inline: async () =>
			(await import("@essence-lang/formatter/snapshots"))
				.writeInlineSnapshots,
	})

	// NOTE: Beside the snapshots, and before the report for the same reason —
	// what the summary says was recorded is on disk by the time a reader looks.
	// A run that measured nothing has nothing to write, so a run without
	// `--bench` never touches a baseline however it was asked to update.
	let recorded = await writeBenchmarks({
		benchmarks: collectBenchmarks(events),
		stored: baselines,
	})

	for (let problem of [...written.problems, ...recorded.problems]) {
		context.terminal.err(
			`  ${context.palette.warning(
				context.theme.symbols.warning,
			)} ${context.palette.muted(problem)}`,
		)
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
