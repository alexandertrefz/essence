import { mkdir, mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import * as path from "node:path"
import { Worker } from "node:worker_threads"

import { canonicalPath } from "@essence-lang/compiler/documents"
import type { MutationSite } from "@essence-lang/compiler/mutation"
import {
	type CorpusStore,
	readCorpus,
	readSnapshots,
	type SnapshotStore,
} from "@essence-lang/compiler/testing"
import type { common } from "@essence-lang/interfaces"
import { randomSeed, type TestEvent } from "@essence-lang/runtime/Testing"

import { EXIT_FAILURE, EXIT_SUCCESS, EXIT_USAGE } from "./actions"
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
import type { MutantWorkerRequest, MutantWorkerResponse } from "./mutantWorker"
import type { CompileOutcome } from "./pipeline"
import {
	claimRegistries,
	loadBundles,
	type LoadedSuite,
	redirectStdout,
	resolveFilters,
	runSuites,
} from "./test"
import {
	collectTestRun,
	type MutantRecord,
	renderMutation,
	renderNoTests,
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
	[
		"contracts",
		"--contracts",
		"a goal is generated from a declaration, so a mutant of the declaration is a mutant of its own test",
	],
]

function contradiction(options: OptionValues): string | null {
	for (let [flag, name, reason] of CONTRADICTIONS) {
		if (options[flag] === true) {
			return `--mutate and ${name} contradict each other — ${reason}.`
		}
	}

	return null
}

// #region The attribution join

// NOTE: One Module's coverage table as the join reads it: where each point
// stands, and which tests touched it. Both are indexed the same way, which is
// how a `test-coverage` event names points — by index into the `coverage`
// event's own table.
export type ModuleAttribution = {
	points: Array<common.Position>
	tests: Array<Array<string>>
}

export function attributionOf(
	events: Array<TestEvent>,
): Map<string, ModuleAttribution> {
	let byModule = new Map<string, ModuleAttribution>()

	for (let event of events) {
		if (event.kind !== "coverage" || event.module === null) {
			continue
		}

		byModule.set(event.module, {
			points: event.points.map((point) => point.position),
			tests: event.points.map(() => []),
		})
	}

	for (let event of events) {
		if (event.kind !== "test-coverage" || event.module === null) {
			continue
		}

		let held = byModule.get(event.module)

		if (held === undefined) {
			continue
		}

		for (let point of event.points) {
			held.tests[point]?.push(event.id)
		}
	}

	return byModule
}

function before(left: common.Cursor, right: common.Cursor): boolean {
	return (
		left.line < right.line ||
		(left.line === right.line && left.column < right.column)
	)
}

function holds(outer: common.Position, inner: common.Position): boolean {
	return !before(inner.start, outer.start) && !before(outer.end, inner.end)
}

function overlaps(left: common.Position, right: common.Position): boolean {
	return !before(left.end, right.start) && !before(right.end, left.start)
}

// NOTE: How wide a span is, as a number that orders the way a reader would: a
// span of fewer LINES is always the narrower one, and columns decide a tie.
// Only compared against another span of the same file, so the scale is
// arbitrary and only the order matters.
function width(position: common.Position): number {
	return (
		(position.end.line - position.start.line) * 1_000_000 +
		(position.end.column - position.start.column)
	)
}

// NOTE: Which points of a Module's table stand over a site. Every point whose
// span HOLDS the site is one — a site inside a Statement inside a branch inside
// a Method body is covered by each of them, and a test that reached any of them
// reached the site.
//
// NOTE: The fallback is the SMALLEST overlapping span, and it is not a nicety:
// a point's span is the span of the Node the instrumentation stood in front of,
// and a site inside a Statement that spans several lines is held by it — but a
// site standing in a Method's Parameter default, or in a Node whose Position the
// Simplifier trimmed differently, may only overlap. Answering with nothing there
// would report a well-tested site as UNCOVERED, which is the one wrong answer
// worth writing a fallback for.
export function coveringPoints(
	points: Array<common.Position>,
	position: common.Position,
): Array<number> {
	let containing = points.flatMap((point, index) =>
		holds(point, position) ? [index] : [],
	)

	if (containing.length > 0) {
		return containing
	}

	let best: number | null = null

	points.forEach((point, index) => {
		if (!overlaps(point, position)) {
			return
		}

		if (
			best === null ||
			width(point) < width(points[best] as common.Position)
		) {
			best = index
		}
	})

	return best === null ? [] : [best]
}

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
	run: (request: MutantRequest) => Promise<MutantRun>
	dispose: () => Promise<void>
}

// NOTE: The Worker is booted as whatever this module is running as — the
// TypeScript source under Bun in the workspace, the compiled JavaScript in the
// published package, where no `mutantWorker.ts` exists to boot. The same
// question `workerFileName` answers for the compile pool, asked again here
// because it is about THIS file's own extension.
export function mutantWorkerFileName(moduleURL: string): string {
	return moduleURL.endsWith(".ts") ? "./mutantWorker.ts" : "./mutantWorker.js"
}

function createMutantRunner(): MutantRunner {
	let workerURL = new URL(
		mutantWorkerFileName(import.meta.url),
		import.meta.url,
	)
	let worker: Worker | null = null
	let next = 0

	let stop = async (): Promise<void> => {
		let held = worker

		worker = null

		await held?.terminate()
	}

	return {
		run: async (request) => {
			let id = next

			next += 1

			let running = worker ?? new Worker(workerURL)

			worker = running

			let answer = await new Promise<MutantRun>((resolve) => {
				let onMessage = (message: MutantWorkerResponse): void => {
					if (message.kind !== "ran" || message.id !== id) {
						return
					}

					running.off("message", onMessage)
					running.off("error", onError)
					resolve(message)
				}
				// NOTE: A Worker that dies takes its mutant with it, and the
				// mutant is answered as one nothing could be learnt from
				// rather than as a kill. A crash is not evidence about the
				// tests.
				let onError = (error: unknown): void => {
					running.off("message", onMessage)
					running.off("error", onError)
					worker = null
					resolve({
						kind: "ran",
						id,
						events: [],
						problem:
							error instanceof Error
								? (error.stack ?? error.message)
								: String(error),
						exhausted: true,
					})
				}

				running.on("message", onMessage)
				running.on("error", onError)
				running.postMessage({
					kind: "run",
					id,
					...request,
				} satisfies MutantWorkerRequest)
			})

			if (answer.exhausted) {
				await stop()
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
// one the reader pointed at", and the head is what they pointed at.
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
		let magic = pattern.search(/[*?[{]/)
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

export async function runMutation(
	context: CLIContext,
	command: CommandSpec,
	files: Array<string>,
): Promise<number> {
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

	let writeEvent = process.stdout.write.bind(process.stdout)
	let emit = (event: TestEvent): void => {
		if (context.options.json) {
			writeEvent(`${JSON.stringify(event)}\n`)
		}
	}
	let filters = resolveFilters(context.options, configuration.test.skipTags)
	let inputFileNames = await discoverTestFiles(
		files,
		command,
		context.programName,
		process.cwd(),
		configuration.test.exclude,
	)

	if (inputFileNames.length === 0) {
		emit({
			schema: 1,
			kind: "mutation-end",
			sites: 0,
			killed: 0,
			survived: 0,
			uncovered: 0,
			invalid: 0,
		})

		if (!context.options.json && !context.options.quiet) {
			context.terminal.out("")
			context.terminal.out(renderNoTests(files, context.report))
			context.terminal.out("")
		}

		return EXIT_SUCCESS
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
	let plan = await planCompilation(instrumented, command, inputFileNames, {
		emit: true,
		cacheOutput: true,
		tests: true,
		enumerateMutations: true,
	})
	let staging = await mkdtemp(path.join(tmpdir(), "essence-mutate-"))
	let runner = createMutantRunner()

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

			return EXIT_FAILURE
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
		// NOTE: ONE seed for the baseline and for every mutant of the run. See
		// the note at the top of the file: it is what makes a property test in
		// the covering set answer the same question of the mutant that it
		// answered of the code.
		let seed = context.options.seed ?? randomSeed()
		let events: Array<TestEvent> = []
		let restore = redirectStdout()
		let suites: Array<LoadedSuite>

		try {
			let bundles = await loadBundles(
				path.join(staging, "baseline"),
				compilation.outcomes.map((outcome) => ({
					inputFileName: outcome.inputFileName,
					bundle: outcome.outputFileName as string,
				})),
			)

			suites = claimRegistries(bundles)

			runSuites(
				suites,
				suites,
				filters,
				(event) => events.push(event),
				true,
				{ stored },
				{ seed, cases: context.options.cases, counterexamples },
				{},
				{},
				true,
			)
		} finally {
			restore()
		}

		let baseline = collectTestRun(events)

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

			return EXIT_FAILURE
		}

		let attribution = attributionOf(events)
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
				break
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
					stored,
					counterexamples,
				}),
			)
		}

		let counts = {
			sites: mutants.length,
			killed: mutants.filter((each) => each.status === "killed").length,
			survived: mutants.filter((each) => each.status === "survived")
				.length,
			uncovered: mutants.filter((each) => each.status === "uncovered")
				.length,
			invalid: mutants.filter((each) => each.status === "invalid").length,
		}

		emit({ schema: 1, kind: "mutation-end", ...counts })

		// NOTE: Skipped under `--json` exactly as the test report is: stdout
		// carries the event stream and nothing else.
		if (!context.options.json && !context.options.quiet) {
			for (let line of renderMutation(
				mutants,
				context.report,
				(module) =>
					module === null ? null : (sources.get(module) ?? null),
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
		await runner.dispose()
		await plan.dispatcher.dispose()
		await rm(staging, { recursive: true, force: true })
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
	stored: Record<string, SnapshotStore>
	counterexamples: Record<string, CorpusStore>
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

		let answer = await work.runner.run({
			bundle: outcome.outputFileName,
			ids,
			seed: work.seed,
			cases: work.context.options.cases,
			snapshots: work.stored,
			counterexamples: work.counterexamples,
		})

		if (answer.problem !== null) {
			return verdict("invalid")
		}

		let failure = answer.events.find((event) => event.kind === "test-fail")

		if (failure !== undefined && failure.kind === "test-fail") {
			return verdict("killed", failure.id)
		}
	}

	return verdict("survived")
}

// #endregion
