import { mkdir, mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import * as path from "node:path"
import { Worker } from "node:worker_threads"

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
import { readProjectConfiguration } from "./configuration"
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

// NOTE: `essence test --mutate` — the driver of the design's §12. Coverage says
// a line RAN; this says a bug there would be CAUGHT.
//
// The shape of a run is three movements. A BASELINE compile with the counters
// in and every Module asked what lies it admits, run once with each test saying
// which points IT touched. An ATTRIBUTION join, which turns "this line ran"
// into "these tests reach this site" by position. And then, per site, one
// deliberate lie compiled through the same warm Session the baseline was
// compiled through, run against ONLY the tests that reach it.
//
// NOTE: The run is pinned to ONE seed, made once and handed to the baseline and
// to every mutant alike. It is what makes the answer reproducible in the one
// place a mutation run could otherwise be a coin toss: a property test in the
// covering set draws exactly the values it drew when the baseline was declared
// green, so a mutant it kills is a mutant it kills every time. The corpus rides
// with it and is read once — the values a property has failed on before are
// replayed first, so a mutant that reintroduces a bug the corpus remembers is
// killed by the very case that caught it the first time.

// NOTE: What `--mutate` may not be asked alongside, and why each is a
// contradiction rather than a combination. Refused before anything runs, the
// way `--contracts` and `--no-contracts` are.
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

function contradiction(options: OptionValues): string | null {
	for (let [flag, name, reason] of CONTRADICTIONS) {
		if (options[flag] === true) {
			return `--mutate and ${name} contradict each other — ${reason}.`
		}
	}

	// NOTE: The same refusal `essence test` makes, made here too, because this
	// run resolves contracts exactly as that one does and a run that guessed
	// which of the two was meant would prove either more or less than the
	// reader asked for.
	if (options.contracts && options.noContracts) {
		return "--contracts and --no-contracts contradict each other — say one."
	}

	// NOTE: Turning the instrumentation pass OFF is the one way to leave a
	// mutation run compiling, running and reporting while quietly answering
	// about nothing: no counters means no coverage table, no table means no
	// test reaches any site, and every site in the project comes back as one no
	// test reaches. Refused rather than warned about, because the report it
	// would print is a plausible one.
	if (options.withoutOptimisation.includes(coveragePassName)) {
		return (
			`--mutate and --without-optimisation ${coveragePassName} contradict ` +
			"each other — the counters are what say which tests reach which " +
			"site, and without them every site is one no test reaches."
		)
	}

	return null
}

// #region The attribution join

// NOTE: The tests that reach a site, in the order the RUN met them, so that a
// report names the same killer twice and a Worker is handed the same list.
export function coveringTests(
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

// NOTE: The recycled Worker, from this side. It boots on the first mutant, and
// it is TERMINATED and replaced whenever it says it has loaded its last bundle
// — which is the whole reason it exists: every bundle a run loads is a Module
// that can never be unloaded, and a run compiles hundreds of them.
type MutantRunner = {
	// NOTE: `timeout` is per mutant, in milliseconds, and it is not optional:
	// a run that could wait forever is a run that can hang a CI job forever,
	// which is worse than no mutation report at all. What the number is, is
	// `mutantTimeout`'s business.
	run: (request: MutantRequest, timeout: number) => Promise<MutantRun>
	dispose: () => Promise<void>
}

// NOTE: How long ONE mutant may run before the driver stops waiting. A mutant
// is a deliberate lie, and one of the lies this walker tells — a comparison
// rotated, a literal nudged, an `if` turned inside out — is exactly the shape
// that turns a terminating loop into a loop with no end. So the wait is bounded
// by what the same tests took when they were green: ten times that, because a
// machine under load is slower than a machine that is not and a false HUNG
// would be a lie about the tests, and never less than five seconds, because ten
// times a millisecond is not a timeout, it is a coin toss.
const MINIMUM_MUTANT_TIMEOUT = 5_000
const MUTANT_TIMEOUT_FACTOR = 10

export function mutantTimeout(baselineMilliseconds: number): number {
	return Math.max(
		MINIMUM_MUTANT_TIMEOUT,
		MUTANT_TIMEOUT_FACTOR * baselineMilliseconds,
	)
}

// NOTE: Whether the Worker that answered this way is still worth keeping. One
// that crashed on a bundle caught its own error and is as good as it was; one
// that was TERMINATED mid-spin, one that died, and one whose port would not
// carry an answer are each a thread the next mutant may not be handed.
function keepsWorker(phase: MutantPhase | null): boolean {
	return phase === null || phase === "load" || phase === "run"
}

function createMutantRunner(stores: MutantStores): MutantRunner {
	// NOTE: Asked of THIS module's own URL, because that is what says whether
	// the package is running as sources or as what was published — see
	// `workerFileName`, which the compile pool asks the same question of.
	let workerURL = new URL(
		workerFileName(import.meta.url, "mutantWorker"),
		import.meta.url,
	)
	let worker: Worker | null = null
	let next = 0

	// NOTE: The stores cross ONCE per thread rather than once per mutant. They
	// belong to the run — every mutant of it compares itself against the same
	// snapshots and replays the same counterexamples — and a Worker recycles
	// every sixty-four bundles, so a project with a large `__snapshots__` was
	// paying a structured clone of the whole of it per compile.
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
				// NOTE: Every way out of the wait goes through here, and it
				// answers ONCE: a Worker that dies a moment after it was given
				// up on, or one whose message arrives as the timer fires, must
				// not resolve a Promise that is already resolved and must not
				// leave a timer behind that outlives the run.
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
				// NOTE: A Worker that dies takes its mutant with it, and what
				// died was the mutant's own run — so it is answered as a
				// mutant the world noticed rather than as one nothing could be
				// learnt from. The thread is dropped either way, so the next
				// mutant boots a fresh one.
				let onError = (error: unknown): void => {
					failed(rendered(error), "worker")
				}
				// NOTE: The listener without which this whole Promise could
				// never settle. A Worker can go away without ever raising an
				// `error` — a native crash, a `process.exit` inside a mutated
				// Module's top level — and the driver was left waiting on a
				// thread that no longer exists.
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

			// NOTE: A hung mutant is still SPINNING, and terminating it is the
			// only thing that stops it. The same call recycles the Worker for
			// every other answer that leaves one unfit — see `keepsWorker` —
			// and for the ordinary case of a Worker that has loaded its last
			// bundle.
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

// NOTE: Which MODULES a run mutates, which the paths on the command line scope
// and the tests they select do not: `essence test --mutate src/Standings.es`
// asks about the lies THAT file admits, and runs whatever tests reach them.
// Nothing named means every Module the run compiled.
//
// NOTE: A glob is read down to its literal head — `src/*.es` scopes to `src` —
// rather than expanded a second time. What is being answered is "is this Module
// one the reader pointed at", and the head is what they pointed at. WHAT counts
// as a glob character is the resolver's own answer, imported rather than
// restated: a second spelling that disagreed about `]` or `}` would scope a run
// to a directory nobody named.
//
// NOTE: CANONICAL, because the other side of the comparison is: a Module names
// itself by the path the graph resolved, symlinks followed and casing as the
// filesystem stores it. On a Mac a temporary directory is `/var/…` lexically and
// `/private/var/…` really, and one un-canonicalised side is enough to scope a
// whole run down to nothing.
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

// NOTE: Every site the run holds, once per Module and in one order — file name,
// then the walk's own numbering. A Module two entries reach is enumerated under
// each of them and the two lists are identical, so the second is dropped rather
// than believed.
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

// NOTE: What a SPEC may reach in and change, and nothing a command line can
// say. The per-mutant timeout is minutes long by design, and a spec that proves
// a hang is caught has to be able to ask for one that is not — so the seam is a
// parameter of this Function rather than an Option or an environment variable,
// which are both promises to a user that nobody wants to keep.
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
	let refusal = contradiction(context.options)

	if (refusal !== null) {
		context.terminal.err(refusal)

		return EXIT_USAGE
	}

	let configuration = await readProjectConfiguration()

	for (let problem of configuration.problems) {
		context.terminal.err(
			`  ${context.palette.warning(
				context.theme.symbols.warning,
			)} ${context.palette.muted(problem)}`,
		)
	}

	// NOTE: BOUND before anything redirects it. The baseline is run with stdout
	// pointed at stderr — a mutated Module's own top-level output belongs to
	// nobody and may not land in the middle of the stream — and this is the
	// reference to the real one.
	let writeEvent = process.stdout.write.bind(process.stdout)
	let emit = (event: TestEvent): void => {
		if (context.options.json) {
			writeEvent(`${JSON.stringify(event)}\n`)
		}
	}
	// NOTE: Every way out that is not the report, answered the same way: the
	// stream ends with a `mutation-end` whatever happened, so a consumer reading
	// it is never left waiting for a tally that is not coming. What it carries
	// where the run learnt nothing is zeros, and the baseline's own events go
	// out ahead of it — a red baseline under `--json` used to write an empty
	// stream and exit 1, which told a reader nothing about which test failed.
	//
	// NOTE: The baseline's events are replayed HERE rather than streamed as
	// they happen, and that is the reproducibility claim keeping its shape: a
	// `test-pass` carries a duration, and a duration is a fact about a machine.
	// Two runs at one seed write the same stream, and a run that streamed its
	// baseline live would not.
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
		configuration.test.exclude,
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

	// NOTE: The baseline compiles with the counters IN, whatever the command
	// line said about coverage — the attribution join reads them, and a site no
	// counter stands over is a site no test can be shown to reach. It is not a
	// coverage report and never prints one; `--coverage` is refused beside
	// `--mutate` for exactly that reason.
	let instrumented: CLIContext = {
		...context,
		options: { ...context.options, coverage: true },
	}
	// NOTE: The mode the project's own `essence test` runs in, goals and all —
	// see `resolveContracts`. A generated goal is a test like any other: it
	// reaches sites, it kills mutants, and a run that left it out would report a
	// project that tests its declarations as testing less than it does. The
	// run's one pinned seed is what keeps the goals answering the same question
	// of every mutant that they answered of the code.
	let plan = await planCompilation(instrumented, command, inputFileNames, {
		emit: true,
		cacheOutput: true,
		tests: true,
		contracts,
		enumerateMutations: true,
	})
	let staging = await mkdtemp(path.join(tmpdir(), "essence-mutate-"))
	// NOTE: Built once the stores it hands its Workers are known, which is after
	// the baseline compiled — so it is a name declared here and assigned there,
	// because the `finally` below is what disposes of it however the run ends.
	let runner: MutantRunner | null = null

	try {
		let compilation = await runCompilation(instrumented, plan, {
			cacheOutput: true,
			sourcemapMode: "inline",
		})

		printDiagnostics(context, compilation)

		// NOTE: The baseline must be GREEN, and a compile that stopped is the
		// first way it can fail to be. Everything a mutation run says rests on
		// "these tests pass over this code" — a project where they do not is a
		// project with a question to answer before this one.
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

		// NOTE: ONE seed for the baseline and for every mutant of the run. See
		// the note at the top of the file: it is what makes a property test in
		// the covering set answer the same question of the mutant that it
		// answered of the code.
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
			focused = runSuites(
				suites,
				suites,
				filters,
				(event) => events.push(event),
				// NOTE: The counters, AND what each test touched of them —
				// which is the whole of what turns "this line ran" into "these
				// tests reach this site".
				{ byTest: true },
				{ stored },
				{ seed, cases: context.options.cases, counterexamples },
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

		// NOTE: A focused baseline is REFUSED, and not for the reason `essence
		// test` refuses one at the end of a plain run. A focus silences most of
		// the suite, and this run reads what ran to learn which tests reach
		// which site — so every site the silenced tests cover comes back as one
		// no test reaches, and the score is taken over whatever the focus left.
		// It is a wrong answer rather than a warning, so it is refused before a
		// single mutant is compiled, and it is refused under any filter: a
		// filter is a narrowing the reader asked for, and a leftover `focused`
		// is one nobody did.
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

		// NOTE: And the stream is DROPPED here, which is the last moment
		// anything needs it: the early exits above replay it, and everything
		// past this point reads the folds instead. A green suite's baseline is
		// several events per test, and the loop it is standing in front of
		// compiles and loads hundreds of Modules.
		events.length = 0

		// NOTE: The order the RUN met each test, which is what makes a covering
		// set a list rather than a set: the Worker runs them in it and stops at
		// the first kill, so the killer a report names is the same one twice.
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
		// NOTE: Written as each mutant is judged rather than at the end, so a
		// consumer watching a long run learns what it learns when it is learnt
		// — the same discipline the test stream keeps. The list beside it is
		// what the human report reads, which is written once at the end.
		let record = (mutant: MutantRecord): void => {
			mutants.push(mutant)
			emit({ schema: 1, kind: "mutant", ...mutant })
		}

		// NOTE: The limit caps what is JUDGED and nothing else. A mutant costs a
		// compile and a run, which is what a reader narrowing a large project is
		// buying their way out of; a site no test reaches costs neither, and
		// leaving those out under a limit would report a project as having fewer
		// untested lines the harder its run was narrowed. So an uncovered site
		// is recorded whatever the limit, in the walk's own order, and the limit
		// is counted against the mutants that were actually built.
		//
		// NOTE: A site past the limit is neither judged nor DROPPED. `sites`
		// counts every site the walker kept, and the five statuses under it
		// count what became of the ones that were looked at — so what the limit
		// left alone is the remainder, which a consumer subtracts and the human
		// report is told outright.
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

		// NOTE: Skipped under `--json` exactly as the test report is: stdout
		// carries the event stream and nothing else.
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

		// NOTE: Exit 0 by default, because a mutation score is INFORMATION: a
		// project learning what its tests would catch has not failed by being
		// told. `--strict` is what a job holding a project to its score asks
		// for.
		return context.options.strict && counts.survived > 0
			? EXIT_FAILURE
			: EXIT_SUCCESS
	} finally {
		await runner?.dispose()
		await plan.dispatcher.dispose()
		await rm(staging, { recursive: true, force: true })
	}
}

// NOTE: The baseline's stream read down to the three things the rest of the run
// needs from it — which tests there were, which of them reach which point, and
// how long each of them took while the code still told the truth. Spelled apart
// so the events themselves are unreferenced the moment it answers.
function foldBaseline(
	baseline: TestRun,
	events: Array<TestEvent>,
): {
	attribution: Map<string, ModuleAttribution>
	durations: Map<string, number>
} {
	return {
		attribution: attributionOf(events),
		// NOTE: Read off the FOLD rather than off the events a second time,
		// because the fold has already answered it.
		durations: new Map(
			baseline.tests.map((test) => [test.id, test.duration]),
		),
	}
}

// NOTE: A site and what became of it, in the shape the event and the report
// both read — see `MutantRecord`, which is the one place those fields are
// spelled.
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

// NOTE: One mutant, compiled and asked. Every entry holding a covering test is
// recompiled with the lie in it — usually one, and more only where two entries
// both reach the mutated Module and both test it — and each is run against its
// own share of the covering set.
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
	// NOTE: What each covering test took in the BASELINE, which is what this
	// mutant's own wait is measured against — see `mutantTimeout`.
	durations: Map<string, number>
	timeoutFor: (baselineMilliseconds: number) => number
	// NOTE: Whether the goals a Namespace's declarations promise are compiled
	// into the mutant as well. It has to be the baseline's own answer: a
	// covering set holding a generated goal is a covering set that names a test
	// which is not in a bundle compiled without them.
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
		// NOTE: A directory per bundle. Bun's resolver remembers what a
		// directory held the first time it read anything out of it, so a second
		// bundle written beside the first would be invisible to the `import()`
		// that runs it — the same trap `stageBundle` exists for, answered here
		// by emitting where nothing has looked rather than by copying
		// afterwards.
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
			// NOTE: WITHOUT the counters. The baseline's are what said which
			// tests reach this site, and the answer is already in hand — a
			// mutant counts nothing, and instrumenting hundreds of bundles
			// would pay for a table nobody reads.
			optimisation: optimiserOptionsFor(work.context.options),
			tests: true,
			contracts: work.contracts,
			mutation: {
				module: work.site.module as string,
				site: work.site.id,
			},
		})

		// NOTE: A mutant that would not compile is INVALID rather than killed.
		// It is the walker's own shortfall — a swap it could not prove sound —
		// and counting it as a kill would credit the tests for catching
		// something they never saw.
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

		// NOTE: A mutant that never came back is CAUGHT. A run that does not end
		// is a failure anybody would notice — the loop that no longer stops is
		// exactly what a rotated comparison or a nudged bound turns a good one
		// into — so it counts for the tests rather than against them.
		//
		// NOTE: Every other problem is a KILL. A bundle that would not load, a
		// runner that threw, a Worker that died: a program that comes apart is a
		// program the world notices, and `invalid` means one thing only, which
		// is that the mutant did not COMPILE. There is no killer to name.
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
