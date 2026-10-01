import { mkdir, rm } from "node:fs/promises"
import * as path from "node:path"
import { Worker } from "node:worker_threads"

import type { ProjectConfiguration } from "@essence-lang/compiler/configuration"
import { canonicalPath } from "@essence-lang/compiler/documents"
import type { MutationSite } from "@essence-lang/compiler/mutation"
import { coveragePassName } from "@essence-lang/compiler/optimiser"
import {
	attributionOf,
	type CorpusStore,
	coveringPoints,
	type ModuleAttribution,
	readCorpus,
	readSnapshots,
	type SnapshotStore,
	type TestRun,
} from "@essence-lang/compiler/testing"
import { randomSeed, type TestEvent } from "@essence-lang/runtime/Testing"

import { EXIT_FAILURE, EXIT_FOCUSED, EXIT_SUCCESS, EXIT_USAGE } from "./actions"
import { optimiserOptionsFor, type OptionValues } from "./args"
import type { CommandSpec } from "./commands"
import {
	hasFailures,
	planCompilation,
	printDiagnostics,
	runCompilation,
} from "./compile"
import type { CLIContext } from "./context"
import { discoverTestFiles } from "./discovery"
import { GLOB_PATTERN } from "./inputs"
import type {
	MutantPhase,
	MutantStores,
	MutantWorkerRequest,
	MutantWorkerResponse,
} from "./mutantWorker"
import type { CompileOutcome } from "./pipeline"
import { workerFileName } from "./pool"
import { redirectStdout, rendered } from "./running"
import {
	claimRegistries,
	createStagingDirectory,
	focusedTests,
	loadBundles,
	type LoadedSuite,
	resolveContracts,
	resolveFilters,
	runSuites,
} from "./test"
import {
	collectTestRun,
	type MutantRecord,
	renderFocusedTests,
	renderMutation,
	renderNoTests,
	tallyMutants,
} from "./testReport"

// The driver of `essence test --mutate`. Coverage says a line ran; a mutation
// run says whether a bug there would be caught. See "Mutation runs" in
// DEVELOPMENT.md.

// The flags `--mutate` refuses, each with the reason it prints.
const CONTRADICTIONS: Array<[keyof OptionValues, string, string]> = [
	[
		"watch",
		"--watch",
		"a mutation run compiles the project once per mutant, which is not what a save should start",
	],
	[
		"bench",
		"--bench",
		"a benchmark measures a machine, and a mutant is not slower or faster — it is wrong",
	],
	[
		"coverage",
		"--coverage",
		"a mutation run already compiles with the counters in, and what it reports is what the tests would CATCH rather than what they reached",
	],
	[
		"update",
		"--update",
		"a mutant that changes a snapshot would be RECORDED, and the run would rewrite the project it was asked about",
	],
]

function contradiction(
	options: OptionValues,
	configuration: ProjectConfiguration,
): string | null {
	for (let [flag, name, reason] of CONTRADICTIONS) {
		if (options[flag] === true) {
			return `--mutate and ${name} contradict each other — ${reason}.`
		}
	}

	// The same refusal `essence test` makes.
	if (options.contracts && options.noContracts) {
		return "--contracts and --no-contracts contradict each other — say one."
	}

	// Without the coverage counters no test reaches any site, and the report
	// would look plausible. So it is refused, not warned about.
	if (options.withoutOptimisation.includes(coveragePassName)) {
		// Names the setting or the flag, whichever left the pass out.
		let where = configuration.build.withoutOptimisations.includes(
			coveragePassName,
		)
			? `"build.withoutOptimisations" naming ${coveragePassName}`
			: `--without-optimisation ${coveragePassName}`

		return (
			`--mutate and ${where} contradict each other — the counters are ` +
			"what say which tests reach which site, and without them every " +
			"site is one no test reaches."
		)
	}

	return null
}

// #region The attribution join

// The tests that reach a site, in the order the run met them, so reports and
// Workers see a stable list.
function coveringTests(
	site: MutationSite,
	attribution: Map<string, ModuleAttribution>,
	order: Map<string, number>,
): Array<string> {
	let held = site.module === null ? undefined : attribution.get(site.module)

	if (held === undefined) {
		return []
	}

	let found = new Set<string>()

	for (let point of coveringPoints(held.points, site.position)) {
		for (let id of held.tests[point] ?? []) {
			found.add(id)
		}
	}

	return [...found].sort(
		(left, right) =>
			(order.get(left) ?? 0) - (order.get(right) ?? 0) ||
			(left < right ? -1 : left > right ? 1 : 0),
	)
}

// #endregion

// #region Where a mutant runs

type MutantRun = Extract<MutantWorkerResponse, { kind: "ran" }>

type MutantRequest = Omit<
	Extract<MutantWorkerRequest, { kind: "run" }>,
	"kind" | "id"
>

// The mutant Worker, from the driver's side. It boots on the first mutant and
// is replaced whenever it reports its last bundle loaded, since a loaded Module
// is never unloaded.
type MutantRunner = {
	// `timeout` is per mutant, in milliseconds, and required so a run can never
	// hang. See `mutantTimeout`.
	run: (request: MutantRequest, timeout: number) => Promise<MutantRun>
	dispose: () => Promise<void>
}

// How long one mutant may run, in milliseconds, since a mutation can make a
// loop endless. The multiple of the baseline allows for a loaded machine, and
// the floor for fast tests.
const MINIMUM_MUTANT_TIMEOUT = 5_000
const MUTANT_TIMEOUT_FACTOR = 10

export function mutantTimeout(baselineMilliseconds: number): number {
	return Math.max(
		MINIMUM_MUTANT_TIMEOUT,
		MUTANT_TIMEOUT_FACTOR * baselineMilliseconds,
	)
}

// Whether a Worker that answered with this phase may run the next mutant. A
// load or run failure was caught inside it. A timeout, a death or a failed
// answer was not.
function keepsWorker(phase: MutantPhase | null): boolean {
	return phase === null || phase === "load" || phase === "run"
}

function createMutantRunner(stores: MutantStores): MutantRunner {
	// This module's URL says whether the package runs as sources or as
	// published. See `workerFileName`.
	let workerURL = new URL(
		workerFileName(import.meta.url, "mutantWorker"),
		import.meta.url,
	)
	let worker: Worker | null = null
	let next = 0

	// The stores belong to the whole run, so they cross once per Worker rather
	// than once per mutant.
	let boot = (): Worker => {
		let fresh = new Worker(workerURL)

		fresh.postMessage({
			kind: "init",
			...stores,
		} satisfies MutantWorkerRequest)

		return fresh
	}

	let discard = async (held: Worker): Promise<void> => {
		if (worker === held) {
			worker = null
		}

		await held.terminate()
	}

	let stop = async (): Promise<void> => {
		let held = worker

		worker = null

		await held?.terminate()
	}

	return {
		run: async (request, timeout) => {
			let id = next

			next += 1

			let running = worker ?? boot()

			worker = running

			let answer = await new Promise<MutantRun>((resolve) => {
				let timer: ReturnType<typeof setTimeout> | null = null
				let settled = false
				// Every way out of the wait comes here, and only the first one
				// counts. It also clears the timer and the listeners.
				let settle = (run: MutantRun): void => {
					if (settled) {
						return
					}

					settled = true

					if (timer !== null) {
						clearTimeout(timer)
					}

					running.off("message", onMessage)
					running.off("error", onError)
					running.off("exit", onExit)
					resolve(run)
				}
				let failed = (problem: string, phase: MutantPhase): void => {
					settle({
						kind: "ran",
						id,
						events: [],
						problem,
						phase,
						exhausted: !keepsWorker(phase),
					})
				}
				let onMessage = (message: MutantWorkerResponse): void => {
					if (message.kind === "ran" && message.id === id) {
						settle(message)
					}
				}
				// A Worker that dies took its mutant's run with it, so the mutant
				// counts as noticed. The next mutant boots a fresh Worker.
				let onError = (error: unknown): void => {
					failed(rendered(error), "worker")
				}
				// A Worker can exit without an `error`, from a native crash or a
				// `process.exit` in a mutated Module. Without this the wait never
				// settles.
				let onExit = (code: number): void => {
					failed(
						`the mutant's Worker exited with code ${code} before it answered`,
						"worker",
					)
				}

				running.on("message", onMessage)
				running.on("error", onError)
				running.on("exit", onExit)
				timer = setTimeout(() => {
					failed(
						`the mutant did not finish within ${timeout} ms`,
						"timeout",
					)
				}, timeout)
				running.postMessage({
					kind: "run",
					id,
					...request,
				} satisfies MutantWorkerRequest)
			})

			// Only terminating stops a hung mutant. It also recycles a Worker
			// that `keepsWorker` rejects or that loaded its last bundle.
			if (answer.exhausted) {
				await discard(running)
			}

			return answer
		},
		dispose: stop,
	}
}

// #endregion

// #region The run

type MutantStatus = MutantRecord["status"]

// The Modules a run mutates, from the paths on the command line; none means
// every Module. A glob scopes to its literal head, so `src/*.es` scopes to
// `src`. Paths are canonical, like the Module paths they are compared with.
export function mutationScope(
	patterns: Array<string>,
	workingDirectory: string,
): Array<string> {
	return patterns.map((pattern) => {
		let magic = pattern.search(GLOB_PATTERN)
		let literal =
			magic === -1
				? pattern
				: pattern.slice(0, pattern.lastIndexOf("/", magic) + 1)

		return canonicalPath(
			path.resolve(workingDirectory, literal === "" ? "." : literal),
		)
	})
}

export function isInScope(module: string, scope: Array<string>): boolean {
	return (
		scope.length === 0 ||
		scope.some(
			(each) =>
				module === each || module.startsWith(`${each}${path.sep}`),
		)
	)
}

// Every site in scope, once per Module, ordered by file name and then site id.
// A Module two entries reach yields the same sites twice, so repeats are dropped.
export function collectSites(
	outcomes: Array<CompileOutcome>,
	scope: Array<string>,
): Array<MutationSite> {
	let byModule = new Map<string, Map<number, MutationSite>>()

	for (let outcome of outcomes) {
		for (let site of outcome.mutations ?? []) {
			if (site.module === null || !isInScope(site.module, scope)) {
				continue
			}

			let held = byModule.get(site.module)

			if (held === undefined) {
				held = new Map()
				byModule.set(site.module, held)
			}

			if (!held.has(site.id)) {
				held.set(site.id, site)
			}
		}
	}

	return [...byModule.keys()]
		.sort()
		.flatMap((module) =>
			[...byModule.get(module)!.values()].sort(
				(left, right) => left.id - right.id,
			),
		)
}

// What a spec may change and a user may not. A spec that proves a hang is
// caught needs a wait under `MINIMUM_MUTANT_TIMEOUT`.
export type MutationInternals = {
	timeoutFor?: (baselineMilliseconds: number) => number
}

export async function runMutation(
	context: CLIContext,
	command: CommandSpec,
	files: Array<string>,
	internals: MutationInternals = {},
): Promise<number> {
	let timeoutFor = internals.timeoutFor ?? mutantTimeout
	let { configuration } = context
	let refusal = contradiction(context.options, configuration)

	if (refusal !== null) {
		context.terminal.err(refusal)

		return EXIT_USAGE
	}

	// Bound before stdout is pointed at stderr, so a Module's own output never
	// lands in the event stream.
	let writeEvent = process.stdout.write.bind(process.stdout)
	let emit = (event: TestEvent): void => {
		if (context.options.json) {
			writeEvent(`${JSON.stringify(event)}\n`)
		}
	}
	// Every early exit writes the baseline's events, then a `mutation-end` of
	// zeros, so a stream always ends with its tally. See "Mutation runs" in
	// DEVELOPMENT.md.
	let stopEarly = (code: number, baseline: Array<TestEvent> = []): number => {
		for (let event of baseline) {
			emit(event)
		}

		emit({ schema: 1, kind: "mutation-end", ...tallyMutants([]) })

		return code
	}
	let contracts = resolveContracts(
		context.options,
		configuration.test.contracts,
	)
	let filters = resolveFilters(context.options, configuration.test.skipTags)
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
		if (!context.options.json && !context.options.quiet) {
			context.terminal.out("")
			context.terminal.out(renderNoTests(files, context.report))
			context.terminal.out("")
		}

		return stopEarly(EXIT_SUCCESS)
	}

	// The baseline always compiles with the coverage counters, which the
	// attribution join reads. It never prints a coverage report.
	let instrumented: CLIContext = {
		...context,
		options: { ...context.options, coverage: true },
	}
	// The mode the project's own `essence test` runs in, so generated goals
	// count as tests and can kill mutants.
	let plan = await planCompilation(instrumented, command, inputFileNames, {
		emit: true,
		cacheOutput: true,
		tests: true,
		contracts,
		enumerateMutations: true,
	})
	let staging = await createStagingDirectory("essence-mutate-")
	// Assigned once the baseline has run, and disposed of by the `finally`.
	let runner: MutantRunner | null = null

	try {
		let compilation = await runCompilation(instrumented, plan, {
			cacheOutput: true,
			sourcemapMode: "inline",
		})

		printDiagnostics(context, compilation)

		// The baseline must compile and pass, since every verdict rests on it.
		if (
			hasFailures(compilation) ||
			compilation.outcomes.some(
				(outcome) => outcome.outputFileName === null,
			)
		) {
			context.terminal.err(
				`  ${context.palette.error(
					context.theme.symbols.fail,
				)} the project did not compile — a mutation run needs a baseline that does`,
			)

			return stopEarly(EXIT_FAILURE)
		}

		let sources = new Map<string, string>()

		for (let outcome of compilation.outcomes) {
			for (let module of outcome.modules) {
				sources.set(module.fileName, module.sourceText)
			}
		}

		let stored: Record<string, SnapshotStore> = await readSnapshots(
			sources.keys(),
		)
		let corpus = await readCorpus(sources.keys())
		let counterexamples: Record<string, CorpusStore> = corpus.stores

		runner = createMutantRunner({ snapshots: stored, counterexamples })

		// One seed for the baseline and every mutant.
		let seed = context.options.seed ?? randomSeed()
		let events: Array<TestEvent> = []
		let restore = redirectStdout()
		let suites: Array<LoadedSuite>
		let focused: boolean

		try {
			let bundles = await loadBundles(
				path.join(staging, "baseline"),
				compilation.outcomes.map((outcome) => ({
					inputFileName: outcome.inputFileName,
					bundle: outcome.outputFileName as string,
				})),
			)

			suites = claimRegistries(bundles)
			focused = (
				await runSuites(
					suites,
					suites,
					filters,
					(event) => events.push(event),
					// Which points each test reached, for the attribution join.
					{ byTest: true },
					{ stored },
					{ seed, cases: context.options.cases, counterexamples },
				)
			).focused
		} finally {
			restore()
		}

		let baseline = collectTestRun(events)
		let sourceOf = (module: string | null): string | null =>
			module === null ? null : (sources.get(module) ?? null)

		if (baseline.counts.failed > 0) {
			context.terminal.err(
				`  ${context.palette.error(
					context.theme.symbols.fail,
				)} ${context.palette.muted(
					`${baseline.counts.failed} test${
						baseline.counts.failed === 1 ? "" : "s"
					} already fail — a mutation run needs a baseline that passes`,
				)}`,
			)

			return stopEarly(EXIT_FAILURE, events)
		}

		// A focused baseline is refused under any filter. The silenced tests
		// would leave their sites looking unreached, and the score would be wrong.
		if (focused) {
			if (!context.options.json) {
				context.terminal.err("")

				for (let block of renderFocusedTests(
					focusedTests(suites),
					context.report,
					sourceOf,
				)) {
					context.terminal.err(block)
				}
			}

			return stopEarly(EXIT_FOCUSED, events)
		}

		let { attribution, durations } = foldBaseline(baseline, events)

		// Nothing reads the baseline's events past the folds, so they are freed
		// before the mutant loop.
		events.length = 0

		// The order the run met each test. A Worker runs a covering list in this
		// order and stops at the first kill, so the named killer is stable.
		let order = new Map<string, number>()
		let entryOf = new Map<string, string>()

		for (let suite of suites) {
			for (let test of suite.registry.tests) {
				order.set(test.entry.id, order.size)
				entryOf.set(test.entry.id, suite.inputFileName)
			}
		}

		let scope = mutationScope(files, process.cwd())
		let sites = collectSites(compilation.outcomes, scope)
		let mutants: Array<MutantRecord> = []
		let compiled = 0
		// Each verdict is streamed as it is reached. The human report reads
		// `mutants` once at the end.
		let record = (mutant: MutantRecord): void => {
			mutants.push(mutant)
			emit({ schema: 1, kind: "mutant", ...mutant })
		}

		// The limit counts compiled mutants only, so every uncovered site is
		// recorded whatever the limit. Sites past it are counted as unjudged. See
		// "Mutation runs" in DEVELOPMENT.md.
		let unjudged = 0

		for (let site of sites) {
			let covering = coveringTests(site, attribution, order)

			if (covering.length === 0) {
				record(recordOf(site, "uncovered", null, 0))

				continue
			}

			if (
				context.options.mutationLimit !== null &&
				compiled >= context.options.mutationLimit
			) {
				unjudged += 1

				continue
			}

			compiled += 1

			record(
				await judge({
					site,
					covering,
					entryOf,
					plan,
					context,
					staging,
					index: compiled,
					runner,
					seed,
					durations,
					timeoutFor,
					contracts,
				}),
			)
		}

		let counts = tallyMutants(mutants, sites.length)

		emit({ schema: 1, kind: "mutation-end", ...counts })

		// Under `--json`, stdout carries only the event stream.
		if (!context.options.json && !context.options.quiet) {
			for (let line of renderMutation(
				mutants,
				context.report,
				sourceOf,
				unjudged === 0 ? null : { after: compiled, unjudged },
			)) {
				context.terminal.out(line)
			}
		}

		// A score is information, so only `--strict` fails a run with survivors.
		return context.options.strict && counts.survived > 0
			? EXIT_FAILURE
			: EXIT_SUCCESS
	} finally {
		await runner?.dispose()
		await plan.dispatcher.dispose()
		await rm(staging, { recursive: true, force: true })
	}
}

// What the run needs from the baseline: which tests reach which point, and how
// long each test took.
function foldBaseline(
	baseline: TestRun,
	events: Array<TestEvent>,
): {
	attribution: Map<string, ModuleAttribution>
	durations: Map<string, number>
} {
	return {
		attribution: attributionOf(events),
		durations: new Map(
			baseline.tests.map((test) => [test.id, test.duration]),
		),
	}
}

// A site and its verdict, as the event and the report read it.
function recordOf(
	site: MutationSite,
	status: MutantStatus,
	killedBy: string | null,
	tests: number,
): MutantRecord {
	return {
		module: site.module,
		position: site.position,
		operator: site.operator,
		description: site.description,
		status,
		killedBy,
		tests,
	}
}

// Compiles and runs one mutant. Every entry holding a covering test is
// recompiled with the mutation and runs its own share of the covering tests.
async function judge(work: {
	site: MutationSite
	covering: Array<string>
	entryOf: Map<string, string>
	plan: Awaited<ReturnType<typeof planCompilation>>
	context: CLIContext
	staging: string
	index: number
	runner: MutantRunner
	seed: string
	// Each covering test's baseline duration, which the mutant's wait is
	// measured against.
	durations: Map<string, number>
	timeoutFor: (baselineMilliseconds: number) => number
	// Must match the baseline, whose covering tests may be generated goals.
	contracts: boolean
}): Promise<MutantRecord> {
	let byEntry = new Map<string, Array<string>>()

	for (let id of work.covering) {
		let entry = work.entryOf.get(id)

		if (entry === undefined) {
			continue
		}

		let held = byEntry.get(entry)

		if (held === undefined) {
			byEntry.set(entry, [id])
		} else {
			held.push(id)
		}
	}

	let verdict = (
		status: MutantStatus,
		killedBy: string | null = null,
	): MutantRecord =>
		recordOf(work.site, status, killedBy, work.covering.length)
	let step = 0

	for (let [entry, ids] of byEntry) {
		// A fresh directory per mutant, emitted into directly, for the reason
		// `stageBundle` stages test bundles.
		let directory = path.join(
			work.staging,
			"mutants",
			`${work.index}-${step}`,
		)

		step += 1

		await mkdir(directory, { recursive: true })

		let outcome = await work.plan.dispatcher.compile({
			inputFileName: entry,
			outputFileName: path.join(directory, "mutant.mjs"),
			minify: false,
			sourcemap: false,
			// Without the coverage counters, which only the baseline needs.
			optimisation: optimiserOptionsFor(work.context.options),
			tests: true,
			contracts: work.contracts,
			mutation: {
				module: work.site.module as string,
				site: work.site.id,
			},
		})

		// A mutant that does not compile is invalid, not killed: the tests never
		// saw it.
		if (!outcome.ok || outcome.outputFileName === null) {
			return verdict("invalid")
		}

		let answer = await work.runner.run(
			{
				bundle: outcome.outputFileName,
				ids,
				seed: work.seed,
				cases: work.context.options.cases,
			},
			work.timeoutFor(
				ids.reduce(
					(total, id) => total + (work.durations.get(id) ?? 0),
					0,
				),
			),
		)

		// A hung mutant counts as caught, since a run that never ends is
		// noticed. Any other problem, such as a failed load or a dead Worker, is
		// a kill with no killer to name.
		if (answer.phase !== null) {
			return verdict(answer.phase === "timeout" ? "hung" : "killed")
		}

		let failure = answer.events.find((event) => event.kind === "test-fail")

		if (failure !== undefined && failure.kind === "test-fail") {
			return verdict("killed", failure.id)
		}
	}

	return verdict("survived")
}

// #endregion
