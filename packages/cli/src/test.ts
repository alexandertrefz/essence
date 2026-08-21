import { copyFile, link, mkdir, mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import * as path from "node:path"
import { pathToFileURL } from "node:url"

import {
	type entryPoints,
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
	collectTestRun,
	emptyRun,
	type FocusedTest,
	renderFocusedTests,
	renderNoTests,
	renderTestReport,
	type TestRun,
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

type LoadedBundle = { $tests?: TestEntryPoints }

// NOTE: One compiled entry, and the tests of ITS graph that no earlier entry
// already claimed. Two entries that reach one Module both carry that Module's
// tests, and running them twice would report every one of them twice — so the
// first bundle to hold a Module runs it, and the rest leave it alone.
type LoadedSuite = {
	inputFileName: string
	tests: TestEntryPoints
	registry: Registry
}

export type TestFilters = {
	filter: string | null
	tags: Array<string>
	skipTags: Array<string>
}

function claimModules(
	registry: Registry,
	claimed: Set<string>,
): Array<TestModule> {
	let kept: Array<TestModule> = []

	for (let module of registry.modules) {
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

	try {
		await link(bundle, staged)
	} catch {
		await copyFile(bundle, staged)
	}

	return staged
}

async function loadSuites(
	staging: string,
	outputFileNames: Array<{ inputFileName: string; bundle: string }>,
): Promise<Array<LoadedSuite>> {
	let suites: Array<LoadedSuite> = []
	let claimed = new Set<string>()
	let index = 0

	for (let { inputFileName, bundle } of outputFileNames) {
		let staged = await stageBundle(staging, bundle, index)

		index += 1

		let loaded = (await import(pathToFileURL(staged).href)) as LoadedBundle
		let tests = loaded.$tests

		if (tests === undefined) {
			continue
		}

		let registry = registryOf(claimModules(tests.registry(), claimed))

		if (registry.tests.length === 0) {
			continue
		}

		suites.push({ inputFileName, tests, registry })
	}

	return suites
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

	return { filter: options.filter ?? null, tags, skipTags }
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

// NOTE: A Module's own top-level output — a `Terminal.print` outside any test —
// is written by the bundle as it is evaluated: before any test is running, and
// with no test to attribute it to. It is not part of the report, and under
// --json stdout carries the event stream and nothing else — so for the length
// of the load and the run stdout is pointed at stderr, where the output still
// arrives and still streams. What a test itself writes never comes through
// here: the runtime captures it against the test and the report shows it with
// the failure.
function redirectStdout(): () => void {
	let original = process.stdout.write

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

	return () => {
		process.stdout.write = original
	}
}

function printReport(
	context: CLIContext,
	run: TestRun,
	sources: Map<string, string>,
): void {
	let { failures, summary, tree } = renderTestReport(
		run,
		context.report,
		(module) => (module === null ? null : (sources.get(module) ?? null)),
	)

	if (!context.options.quiet && tree !== "") {
		context.terminal.out("")
		context.terminal.out(tree)
	}

	if (failures !== "") {
		context.terminal.err("")
		context.terminal.err(failures)
	}

	if (!context.options.quiet) {
		context.terminal.out("")
		context.terminal.out(summary)
		context.terminal.out("")
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

	if (hasFailures(compilation)) {
		return EXIT_FAILURE
	}

	let sources = new Map<string, string>()

	for (let outcome of compilation.outcomes) {
		for (let module of outcome.modules) {
			sources.set(module.fileName, module.sourceText)
		}
	}

	let staging = await mkdtemp(path.join(tmpdir(), "essence-test-"))
	let restore = redirectStdout()
	let suites: Array<LoadedSuite>
	let run: TestRun = emptyRun

	try {
		suites = await loadSuites(
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
		)

		// NOTE: Whether the RUN holds a focus is each bundle's own answer,
		// asked of the bundle — the rule for what counts as focused lives in
		// the runtime and is not worth a second spelling here. Once one bundle
		// says yes, every bundle is told so, and the ones holding no focused
		// test of their own deselect everything through the same selection that
		// runs the rest.
		let selected = suites.map((suite) =>
			suite.tests.select(suite.registry, filters),
		)
		let focused = selected.some((selection) => selection.focused)
		let runFilters: TestFilters & { focusedElsewhere?: boolean } = focused
			? { ...filters, focusedElsewhere: true }
			: filters
		// NOTE: A bundle that holds a focused test already selected correctly
		// above; one that holds none runs nothing at all once another bundle
		// does. So the count is read off the selection that was already made,
		// rather than made a second time under the wider filters.
		let planned = selected.reduce(
			(total, selection) =>
				total +
				(focused && !selection.focused
					? 0
					: selection.selections.filter(
							(each) => each.state === "run",
						).length),
			0,
		)

		emit({ schema: 1, kind: "run-start", tests: planned, focused })

		let started = performance.now()

		for (let suite of suites) {
			suite.tests.run(suite.registry, {
				// NOTE: One run over several bundles is still one run, so each
				// bundle's own bookends are dropped and the pair around the
				// whole of it is written here.
				sink: (event) => {
					if (
						event.kind === "run-start" ||
						event.kind === "run-end"
					) {
						return
					}

					emit(event)
				},
				filters: runFilters,
			})
		}

		// NOTE: The stream is folded up ONCE, here, and the `run-end` this
		// writes carries the counts it found. Re-reading the stream afterwards
		// would walk every `expect` of every test a second time to be told what
		// it already knows; the only thing `run-end` adds to the fold is the
		// duration measured around the loop, which is put back below.
		let duration = performance.now() - started

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

	if (!context.options.json) {
		printReport(context, run, sources)
	}

	if (run.counts.failed > 0) {
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
