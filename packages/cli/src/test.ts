import { copyFile, link, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import * as path from "node:path"
import { pathToFileURL } from "node:url"

import { readProjectConfiguration } from "@essence-lang/compiler/configuration"
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

// NOTE: One entry whose whole answer a run already held, ready to be written
// back into the stream in place of running it. `tests` is what that entry
// PLANNED, which the run's `run-start` has to count as its own.
type CachedEntry = {
	inputFileName: string
	tests: number
	events: Array<TestEvent>
}

// NOTE: What a run is REPLAYING rather than running, and where each of those
// entries stands among the ones it is running. The order matters: a replayed
// entry is written into the stream exactly where it would have run, so that a
// warm run and a cold one are the same report in the same order and the same
// stream line for line. That is the whole claim a replay makes, and a reader
// comparing two runs is the one it is made to.
type ReplayOptions = {
	entries?: Array<CachedEntry>
	// NOTE: Every entry of the run by name, replayed and live alike. Empty for a
	// caller that replays nothing, which then runs what it was handed in the
	// order it was handed it — the loop this has always been.
	order?: Array<string>
}

// NOTE: What one running suite selected, per entry — how many tests it planned
// and how many its `--filter` matched. Both are facts about the selection rather
// than about the run, and both are what a result cache writes down so that a
// replay can answer them without a bundle.
type EntrySelection = {
	inputFileName: string
	planned: number
	matched: number
}

// NOTE: What a run tells every property test of it. The first two are the
// command line's — `--seed` and `--cases` — and the third is what every one of
// them has failed on before, read off the `__counterexamples__` companions
// beside the sources. It travels with the seed rather than beside it because
// what it decides is the same thing: which values a property test is asked
// about.
type PropertyOptions = {
	seed?: string
	cases?: number | null
	counterexamples?: Record<string, CorpusStore>
}

// NOTE: What a run knows about snapshots before it starts: the stored entries
// of every Module in it, and whether one that differs is to be recorded.
type SnapshotOptions = {
	stored?: Record<string, SnapshotStore>
	update?: boolean
}

// NOTE: What a run wants out of the coverage counters. The table itself is what
// `--coverage` reports, and a bundle compiled without the instrumentation has
// none — so asking costs nothing and answers with nothing, which is why it is
// passed through rather than guessed at from the events.
//
// NOTE: `byTest` is the second reading of the same counters, and only
// `essence test --mutate` asks for it — see `RunOptions.coverageByTest`. It is
// what turns "this line ran" into "these tests reach this line", which is how a
// mutant is judged by the tests that could possibly notice it. It costs the
// points each test actually touched, and nobody pays who did not ask. It lives
// beside the table rather than as a parameter of its own because it is a fact
// about the SAME counters, and a caller that wanted it and not them would be
// asking for the impossible.
type CoverageOptions = {
	byTest?: boolean
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

// NOTE: A Module's tests all arrive together, so what is claimed is the Module
// — by its path, or by the id of its first test where a compile had no path to
// give (which the CLI never does, and a spec driving one program might).
//
// NOTE: Named apart so that a result cache can write down which Modules an
// entry claimed and read them back without the bundle. What a claim is keyed by
// has to be one spelling, or a record written under one would be checked against
// the other.
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

// NOTE: Which bundle runs which Module, decided across the whole run rather
// than as the bundles arrive — so that a session re-loading ONE entry does not
// silently take a shared Module away from the entry that has been running it.
// The order is the order the entries were compiled in, which is the order they
// were named in, so the answer is the same every time it is asked.
//
// NOTE: `claimed` is what the run has already given away to entries that are
// NOT among these bundles — which is only ever an entry a result cache answered
// for, whose bundle nobody loaded. Empty for every other caller, which is the
// same walk this has always done.
export function claimRegistries(
	bundles: Array<LoadedBundle>,
	claimed: Set<string> = new Set(),
): Array<LoadedSuite> {
	return bundles.map((bundle) => ({
		...bundle,
		registry: registryOf(claimModules(bundle.modules, claimed)),
	}))
}

// NOTE: Every test the run was narrowed to, so that the refusal at the end can
// point at each of them. A skipped test's `focused` narrows nothing — it does
// not run either way — and is not what has to go.
//
// NOTE: Exported for `--mutate`, which refuses a focused baseline outright and
// names the same tests in the same words — a reader meets one refusal spelled
// once, whichever of the two runs they asked for.
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
	// NOTE: What the run wants OUT of the counters — see `CoverageOptions`. A
	// plain `true` is the whole table and nothing per test, which is what
	// `--coverage` and a watching session ask for.
	coverage: boolean | CoverageOptions = false,
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
	// NOTE: The entries this run is REPLAYING rather than running — read off a
	// result cache by whoever started the run, because a bundle reads nothing —
	// and where each of them stands among the ones it is running. They are
	// counted into the plan and written into the stream in their own place, so a
	// warm run is the cold one's report and the cold one's stream.
	replay: ReplayOptions = {},
): {
	planned: number
	focused: boolean
	matched: number
	// NOTE: What each RUNNING suite selected. A caller keeping one record per
	// entry needs both numbers per entry, and asking the registry a second time
	// would evaluate every interpolating Module's setup again to render names
	// this selection has already rendered.
	entries: Array<EntrySelection>
} {
	let counters = coverage === true || coverage !== false
	let byTest = coverage !== true && coverage !== false && coverage.byTest
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
	// NOTE: The run's own order where a caller gave one, so a replayed entry is
	// written into the stream exactly where it would have run. Where none was
	// given every replay still goes out, ahead of the suites — nothing handed
	// over may be lost for want of a place to put it — and a caller that replays
	// nothing runs what it was handed in the order it was handed it, which is
	// the loop this has always been.
	let sequence = replay.order ?? [
		...replays.keys(),
		...running.map((suite) => suite.inputFileName),
	]

	for (let inputFileName of sequence) {
		let entry = replays.get(inputFileName)

		if (entry !== undefined) {
			// NOTE: Attributed to no suite. A record is written out of a stream a
			// bundle produced, and one replayed out of a record is never written
			// again.
			//
			// NOTE: A replayed entry can not hold a focused test — nothing is
			// ever remembered out of a focused run, and a caller discards every
			// one of these the moment a live bundle turns out to hold one — so
			// nothing written here is silencing what runs around it.
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

		// NOTE: A name the caller holds that is neither replayed nor running is
		// an entry whose bundle published no tests at all, which is an answer
		// rather than an omission.
		if (suite === undefined) {
			continue
		}

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
		// NOTE: Across every bundle, because a filter names a test and the run
		// is what holds the tests — a name that matches nothing in this file
		// and something in the next one matched the run.
		matched: selected.reduce(
			(total, selection) => total + selection.matched,
			0,
		),
		entries,
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

// NOTE: `--contracts` unions with the setting — the flag asks for the goals of
// a project that never said it wanted them, and the setting asks for them every
// run — and `--no-contracts` beats both: a project that configured goals still
// needs a plain run on demand, while a broken declaration is repaired or when
// only the written tests are the question. Both flags at once is a
// contradiction the caller refuses before anything runs.
export function resolveContracts(
	options: { contracts: boolean; noContracts: boolean },
	configured: boolean,
): boolean {
	return options.noContracts ? false : options.contracts || configured
}

// NOTE: Whether a run may be answered out of the result cache AT ALL, in either
// direction. `--update` and `--coverage` are runs whose whole point is the file
// they leave behind; `--bench` measures a machine rather than asking a question
// about the code; `--seed` and `--cases` say which values a property test
// draws, and a property test is never remembered anyway. `--mutate` is here for
// a reason of its own: what it runs is a MUTANT, an entry compiled from a lie
// about the sources, and a record keyed by the bundle hash of the real ones
// would claim those tests passed against the code as written.
//
// What is NOT here is `--json` — a replay is the same events on the same lines
// — and the filters, which go into the key instead so that a narrowed run is an
// answer of its own rather than one that can never be kept.
//
// NOTE: `--watch` and the Language Server's session do not come through here
// and use none of this. A watching run already re-runs only what a save
// reached, out of bundles it is holding, and answering out of a file would be
// slower than the loop it replaced.
export function remembersResults(options: {
	update: boolean
	coverage: boolean
	bench: boolean
	mutate: boolean
	seed: string | undefined
	cases: number | null
}): boolean {
	return (
		!options.update &&
		!options.coverage &&
		!options.bench &&
		!options.mutate &&
		options.seed === undefined &&
		options.cases === null
	)
}

// NOTE: Whether an entry's own stream may be REMEMBERED, so that the next run
// over the same code, the same stores and the same filters can replay it
// instead of running it. The replay claims that these tests passed, were skipped
// or were deselected; each refusal below is a case where that claim would be
// made about a run that has to happen again.
//
// A FAILURE always re-runs: a reader working through one wants this run's
// output and this run's spans, and an entry that failed is the entry they are
// editing. A `not-focused` deselection is a run somebody NARROWED by hand, and
// what a focus silences is decided across a whole run rather than per entry — so
// nothing out of it may be replayed into a run that focuses somewhere else. A
// PROPERTY test is the one thing here that is meant to answer differently every
// time: fresh entropy is what the search is for, and freezing a hundred cases
// under a name would end it. The values it has already failed on are the
// corpus's business, and the corpus is in the key.
//
// A snapshot or a baseline WRITTEN is a run that changed the very file the key
// reads, so the record would be keyed against a disk that no longer exists.
// Recording it one run later — when the entry has compared itself against what
// it wrote and matched — is both correct and one run away.
//
// NOTE: A deselection by tag, by filter or by `bench`, and a skip, are all
// deterministic functions of the manifest and of the filters in the key, so
// they are remembered like a pass.
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

// NOTE: Which Modules of an entry the run would hand it, worked out WITHOUT the
// bundles a result cache answered for. `claimRegistries` decides this across the
// whole run in the order the entries were named, so a replayed entry has to be
// handed exactly the Modules it was handed when it was recorded — otherwise a
// Module whose owner moved would be reported twice or by nobody. A hit knows
// its own Modules because the record wrote them down and the bundle hash that
// names the record pins them; a miss has been loaded and can be asked.
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

function reportUnknownTags(
	context: CLIContext,
	suites: Array<LoadedSuite>,
	named: Array<string>,
	// NOTE: The tags of every entry the run REPLAYED, which carry no registry to
	// be asked. A record writes them down for exactly this: a tag that only the
	// cached half of a project uses is a tag the run knows, and saying otherwise
	// would make the warning fire because the cache was warm.
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

// NOTE: The one way a filter can match something and still run nothing: it
// named benchmarks, and the run is not measuring. `matched` deliberately
// counts what the FILTER matched — see `selectTests` — so the warning above
// stays quiet, and the plain tree does not list a deselection; without this
// sentence the run ends green with the reader's target never run.
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
	// NOTE: Whether the compile this run stands on emitted nothing, every entry
	// of it having been in the bundle cache already. It is the design's own
	// note at the end of the summary, and it is the difference between a fast
	// run and a fast run that also compiled the project.
	cacheWarm = false,
	// NOTE: What the run recorded as baselines, which is what a snapshot count
	// is beside it: a measurement written for the first time is a pass that
	// left something on disk, and a reader has to be told without going to look.
	baselines: BenchmarkWrites = noBenchmarkWrites,
	// NOTE: How many compiled entries the run held, which is what the count of
	// replayed ones in the fold is a share of. Zero for a session that never asks
	// the result cache — a watching one — which is what leaves the note off.
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
	// NOTE: Refused before anything runs — the two flags contradict, and a run
	// that guessed which one was meant would prove either more or less than the
	// reader asked for.
	if (context.options.contracts && context.options.noContracts) {
		context.terminal.err(
			"--contracts and --no-contracts contradict each other — say one.",
		)

		return EXIT_USAGE
	}

	let configuration = readProjectConfiguration()

	for (let problem of configuration.problems) {
		context.terminal.err(
			`  ${context.palette.warning(
				context.theme.symbols.warning,
			)} ${context.palette.muted(problem)}`,
		)
	}

	let filters = resolveFilters(context.options, configuration.test.skipTags)
	let contracts = resolveContracts(
		context.options,
		configuration.test.contracts,
	)
	let writeEvent = process.stdout.write.bind(process.stdout)
	let events: Array<TestEvent> = []
	// NOTE: The same stream a second time, bucketed by the entry that produced
	// it — which is what a record is written out of. The flat one is what the
	// report and `--json` read, in the order everything happened; a record needs
	// one entry's events alone, and the emit is the one place that knows which
	// entry an event came from.
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
	// NOTE: And the values every property test of the run has failed on before,
	// for the very same reason. They are read whether or not the run holds a
	// property test at all — a Module with no companion answers with nothing,
	// which costs one stat per file and saves asking twice.
	let corpus = await readCorpus(sources.keys())

	// NOTE: A companion that exists but could not be read is said OUT LOUD on
	// every run: the run replays nothing from it, the writer refuses to touch
	// it, and a warning nobody prints is a corpus that quietly stopped working.
	for (let entry of corpus.unreadable) {
		context.terminal.err(
			`  ${context.palette.warning(
				context.theme.symbols.warning,
			)} ${context.palette.muted(entry.problem)}`,
		)
	}
	// NOTE: One seed for the whole run, made HERE where there is one run: every
	// bundle draws from it, and every property test folds its own identity in.
	// So the replay a failure prints reproduces the run rather than the file.
	let seed = context.options.seed ?? randomSeed()

	let resultStore = remembersResults(context.options)
		? resultCacheDirectory()
		: null
	// NOTE: The entries a result cache could answer for at all — one that would
	// not compile has no answer to remember and no bundle to name one with.
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
			// NOTE: An entry that did not compile is left out of the store in
			// both directions. Its bundle may be an older run's, and what the
			// report says about it is that its tests did not run.
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

	let staging = await mkdtemp(path.join(tmpdir(), "essence-test-"))
	let restore = redirectStdout()
	let suites: Array<LoadedSuite>
	let run: TestRun = emptyRun
	let matchedNames = 0
	let selections: Array<EntrySelection> = []

	try {
		// NOTE: Each call stages into a directory of this run's own. Staging is
		// numbered WITHIN a call, so two calls into one directory would both
		// write `0/tests.mjs` — and `import()` caches by URL, so the second
		// bundle would answer with the first one's registry.
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
		// NOTE: What the run would give each entry if every bundle were here.
		// A hit reads its Modules off its record — the bundle hash that names
		// the record pins them, so what it says is what the bundle would say —
		// and a miss has just been loaded.
		let plan = planClaims(
			ordered.map((name) => ({
				inputFileName: name,
				modules:
					hits.get(name)?.modules ??
					(live.get(name)?.modules ?? []).map(moduleKeyOf),
			})),
		)
		// NOTE: A hit whose claim has MOVED is demoted and run live. It happens
		// when an entry before it in the run changed and now reaches — or no
		// longer reaches — a Module they share: the record answers for Modules
		// this run would give somebody else, or is missing ones nobody else will
		// run. Every other hit's claim is untouched by the demotion, because its
		// Modules are the same either way.
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

		// NOTE: Seeded with what the surviving hits hold, so that a live entry
		// sharing a Module with a replayed one does not take it over and report
		// the tests the replay has already reported.
		let claimHits = (): Set<string> =>
			new Set([...hits.keys()].flatMap((name) => plan.get(name) ?? []))

		suites = claimRegistries(claimBundles(), claimHits())

		// NOTE: A focus silences every other test of the run, and a replayed
		// stream would claim runs that must not happen — so one focused live
		// bundle discards every hit and everything runs. Nothing cached can be
		// focused itself: a focused run is never remembered.
		//
		// NOTE: Focus is a fact about the MANIFEST rather than about the
		// filters, so the probe hands the runtime only the one filter it depends
		// on. Asking with the run's own `--filter` would render every
		// interpolated name a second time to be told the same thing.
		if (
			hits.size > 0 &&
			suites.some(
				(suite) =>
					suite.tests.select(suite.registry, {
						bench: filters.bench,
					}).focused,
			)
		) {
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
		let { focused, matched, entries } = runSuites(
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
		// NOTE: The stream is folded up ONCE, here, and the `run-end` this
		// writes carries the counts it found. Re-reading the stream afterwards
		// would walk every `expect` of every test a second time to be told what
		// it already knows; the only thing `run-end` adds to the fold is the
		// duration measured around the loop, which is put back below.
		let duration = performance.now() - started

		// NOTE: Across the live entries AND the replayed ones, because a filter
		// names a test and the run is what holds the tests — a name that matched
		// nothing live and something in a cached entry matched the run.
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
		// NOTE: The staged links go once the bundles have been read. A Module
		// that is already loaded does not need its file any more, and the
		// bundle they were made from is the cache's and stays where it is.
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

	// NOTE: And the corpus, so the next run replays the value this one printed.
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

	// NOTE: After the stores have been written, so that a record is only ever
	// keyed against a disk that has already settled — and refused for this run
	// where a snapshot or a baseline was recorded, which is what changed it.
	//
	// NOTE: Nothing at all is remembered out of a FOCUSED run. Every entry of it
	// reports what a narrowing decided rather than what the code says, including
	// the one holding the focus, whose own stream carries no sign of it where
	// every test it holds is focused.
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
