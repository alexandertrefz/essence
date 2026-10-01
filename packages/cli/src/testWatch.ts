import { rm } from "node:fs/promises"
import { constants } from "node:os"
import * as path from "node:path"

import { removeStagingDirectory } from "@essence-lang/compiler/testing"
import { randomSeed, type TestEvent } from "@essence-lang/runtime/Testing"

import { EXIT_SUCCESS } from "./actions"
import type { CommandSpec } from "./commands"
import {
	type CompilationResult,
	planCompilation,
	printDiagnostics,
	runCompilation,
} from "./compile"
import type { CLIContext } from "./context"
import { discoverTestFiles } from "./discovery"
import { redirectStdout } from "./running"
import { SHOW_CURSOR } from "./terminal"
import {
	claimRegistries,
	createStagingDirectory,
	holdsFocus,
	type LoadedBundle,
	type LoadedSuite,
	loadBundles,
	printReport,
	reportUnmatchedFilter,
	resolveContracts,
	resolveFilters,
	runSuites,
	type TestFilters,
	writeCoverageReport,
} from "./test"
import {
	collectBenchmarks,
	collectCorpusChanges,
	collectCoverage,
	collectSnapshots,
	collectTestRun,
	emptyCoverage,
	readBenchmarks,
	readCorpus,
	readSnapshots,
	renderNoTests,
	writeBenchmarks,
	writeCorpus,
	writeSnapshots,
} from "./testReport"
import { createDependentsIndex, createSourceWatcher } from "./watcher"

// `essence test --watch` stays up and reruns the entries a change reached, found
// from the last compile's module graphs as `esc watch` does. A rerun replaces
// its entry's events, and the report folds every entry's, so the tree shows
// every test.

// Raw mode delivers Ctrl+C as data rather than as a signal.
const CTRL_C = String.fromCharCode(3)

function timestamp(): string {
	let now = new Date()
	let pad = (value: number) => String(value).padStart(2, "0")

	return `${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(
		now.getSeconds(),
	)}`
}

// The ids of the tests a suite claims. When a shared Module moves between
// entries, both rerun, so the loser stops reporting its tests.
function claimedIds(suite: LoadedSuite): string {
	return suite.registry.tests.map((test) => test.entry.id).join("\n")
}

export async function runTestWatch(
	context: CLIContext,
	command: CommandSpec,
	files: Array<string>,
): Promise<number> {
	let { configuration, palette, terminal, theme } = context
	let filters: TestFilters = resolveFilters(
		context.options,
		configuration.test.skipTags,
	)
	let contracts = resolveContracts(
		context.options,
		configuration.test.contracts,
	)
	let writeEvent = process.stdout.write.bind(process.stdout)
	let inputFileNames = await discoverTestFiles(
		files,
		command,
		context.programName,
		process.cwd(),
		configuration.root,
		configuration.exclude,
		contracts,
	)
	let plan = await planCompilation(context, command, inputFileNames, {
		emit: true,
		cacheOutput: true,
		tests: true,
		contracts,
	})
	// One staging root per session, with a fresh directory per cycle. See
	// `stageBundle`.
	let staging = await createStagingDirectory("essence-test-watch-")

	// A signal ends the session at once, with the status a shell reports
	// for it. While the session waits, a handler removes the staging first; while
	// it compiles or runs tests, the next session's sweep does.
	let stopOnSignal = new Map(
		(["SIGINT", "SIGTERM", "SIGHUP"] as const).map((signal) => [
			signal,
			() => {
				if (process.stdin.isTTY) {
					process.stdin.setRawMode(false)
				}

				if (process.stderr.isTTY) {
					process.stderr.write(SHOW_CURSOR)
				}

				removeStagingDirectory(staging)
				process.exit(128 + constants.signals[signal])
			},
		]),
	)
	let handling = false
	let handleSignals = (handled: boolean): void => {
		if (handled === handling) {
			return
		}

		handling = handled

		for (let [signal, stop] of stopOnSignal) {
			if (handled) {
				process.on(signal, stop)
			} else {
				process.off(signal, stop)
			}
		}
	}

	let dependents = createDependentsIndex()
	let bundles = new Map<string, LoadedBundle>()
	let eventsByEntry = new Map<string, Array<TestEvent>>()
	let claims = new Map<string, string>()
	let sources = new Map<string, string>()
	let cycles = 0
	// Whether the last cycle held a focused test. When that changes, every
	// suite reruns.
	let focused = false
	let running = false
	let pending = new Set<string>()
	let searchAgain = false
	let stopped = false

	let allEvents = (): Array<TestEvent> => {
		let events: Array<TestEvent> = []

		for (let inputFileName of inputFileNames) {
			events.push(...(eventsByEntry.get(inputFileName) ?? []))
		}

		return events
	}

	// What this cycle's entries wrote, which the store writes act on. Earlier
	// cycles' writes are on disk already.
	let cycleEvents = (entries: Array<string>): Array<TestEvent> => {
		let events: Array<TestEvent> = []

		for (let inputFileName of entries) {
			events.push(...(eventsByEntry.get(inputFileName) ?? []))
		}

		return events
	}

	let footer = () => {
		terminal.out("")
		terminal.out(
			`  ${palette.faint(theme.symbols.bullet)} ${palette.muted(
				"watching for changes",
			)}  ${palette.faint("r re-run · c clear · q quit")}`,
		)
	}

	let recordGraphs = (result: CompilationResult): void => {
		for (let outcome of result.outcomes) {
			dependents.record(
				outcome.inputFileName,
				outcome.modules.map((module) => module.fileName),
			)

			for (let module of outcome.modules) {
				sources.set(module.fileName, module.sourceText)
			}
		}
	}

	let watcher = createSourceWatcher({
		onChange: (changed) => {
			let targets = dependents.entriesFor(changed)

			if (targets.length > 0) {
				void cycle(targets)
			}
		},
		// Activity no watched file accounts for may be a new source, so the
		// project is searched again.
		onActivity: () => {
			void rediscover()
		},
		onError: (directory, error) => {
			terminal.err(
				`  ${palette.warning(theme.symbols.warning)} ${palette.muted(
					`Could not watch ${directory}: ${
						error instanceof Error ? error.message : String(error)
					}`,
				)}`,
			)
		},
	})

	async function rediscover(): Promise<void> {
		if (stopped) {
			return
		}

		// Remembered, since nothing else would ever notice a file written while
		// a cycle runs.
		if (running) {
			searchAgain = true

			return
		}

		let found = await discoverTestFiles(
			files,
			command,
			context.programName,
			process.cwd(),
			configuration.root,
			configuration.exclude,
			contracts,
		)
		let added = found.filter(
			(fileName) => !inputFileNames.includes(fileName),
		)
		let removed = inputFileNames.filter(
			(fileName) => !found.includes(fileName),
		)

		if (added.length === 0 && removed.length === 0) {
			return
		}

		for (let fileName of removed) {
			bundles.delete(fileName)
			eventsByEntry.delete(fileName)
			claims.delete(fileName)
		}

		inputFileNames = found

		await cycle(added)
	}

	// One turn of the session: compile what changed, load it, run what must
	// run, and reprint the report. A change during a cycle waits for it to end.
	async function cycle(targets: Array<string>): Promise<void> {
		if (stopped) {
			return
		}

		if (running) {
			for (let target of targets) {
				pending.add(target)
			}

			return
		}

		running = true

		// A handler only runs once the thread is free, and a cycle compiles and
		// runs tests on it. So until its report, a cycle leaves each signal its
		// default action. The turn first lets a signal already caught run.
		await new Promise((resolve) => setImmediate(resolve))
		handleSignals(false)
		cycles += 1

		let started = performance.now()
		let compiled = targets.filter((target) =>
			inputFileNames.includes(target),
		)
		let compilation =
			compiled.length === 0
				? null
				: await runCompilation(
						context,
						{ ...plan, inputFileNames: compiled },
						{ cacheOutput: true, sourcemapMode: "inline" },
					)

		// A cycle that compiled nothing reuses the last cycle's bundles, so it is
		// warm.
		let cacheWarm = (compilation?.outcomes ?? []).every(
			(outcome) => outcome.cached,
		)

		if (compilation !== null) {
			recordGraphs(compilation)
			await watcher.watch([
				...inputFileNames.map((fileName) => path.resolve(fileName)),
				...dependents.files(),
			])
		}

		// stdout carries the events or the report, so what a Module prints as it
		// loads goes to stderr until the run ends.
		let restore = redirectStdout()
		let restored = false
		let broken: Array<string> = []

		try {
			let toLoad: Array<{ inputFileName: string; bundle: string }> = []

			for (let outcome of compilation?.outcomes ?? []) {
				if (!outcome.ok || outcome.outputFileName === null) {
					// An entry that would not compile keeps its last events, and
					// its Diagnostics print above the tree.
					broken.push(outcome.inputFileName)

					continue
				}

				toLoad.push({
					inputFileName: outcome.inputFileName,
					bundle: outcome.outputFileName,
				})
			}

			// One call per cycle, into the cycle's own directory. Staging is
			// numbered within a call, and `import()` caches by URL, so two calls
			// into one directory would load the first bundle twice.
			let loaded = await loadBundles(
				path.join(staging, String(cycles)),
				toLoad,
			)

			for (let { inputFileName } of toLoad) {
				let bundle = loaded.find(
					(each) => each.inputFileName === inputFileName,
				)

				if (bundle === undefined) {
					bundles.delete(inputFileName)
					eventsByEntry.delete(inputFileName)

					continue
				}

				bundles.set(inputFileName, bundle)
			}

			let suites = claimRegistries(
				inputFileNames.flatMap((fileName) => {
					let bundle = bundles.get(fileName)

					return bundle === undefined ? [] : [bundle]
				}),
			)
			// What the change reached and every suite whose claim moved, or
			// everything once the session's focus changes.
			let toRun = suites.filter(
				(suite) =>
					targets.includes(suite.inputFileName) ||
					claims.get(suite.inputFileName) !== claimedIds(suite),
			)

			for (let suite of suites) {
				claims.set(suite.inputFileName, claimedIds(suite))
			}

			let focusedNow = await holdsFocus(suites, filters.bench)

			// The kept events have no `run-start`, so focus is remembered apart.
			if (focusedNow !== focused && cycles > 1) {
				toRun = suites
			}

			focused = focusedNow

			for (let suite of toRun) {
				eventsByEntry.set(suite.inputFileName, [])
			}

			// The stores are read every cycle: another terminal or an editor may
			// change them, and a cycle must see the counterexample the last one
			// wrote.
			let stored = await readSnapshots(sources.keys())
			let baselines = context.options.bench
				? await readBenchmarks(sources.keys())
				: {}
			let corpus = await readCorpus(sources.keys())

			for (let entry of corpus.unreadable) {
				terminal.err(
					`  ${palette.warning(
						theme.symbols.warning,
					)} ${palette.muted(entry.problem)}`,
				)
			}

			let { matched } = await runSuites(
				suites,
				toRun,
				filters,
				(event, suite) => {
					if (suite !== null) {
						eventsByEntry.get(suite.inputFileName)?.push(event)
					}

					if (context.options.json) {
						writeEvent(`${JSON.stringify(event)}\n`)
					}
				},
				context.options.coverage,
				{ stored, update: context.options.update },
				// A fresh seed per cycle, so a property that fails only sometimes
				// is not hidden. `--seed` pins it.
				{
					seed: context.options.seed ?? randomSeed(),
					cases: context.options.cases,
					counterexamples: corpus.stores,
				},
				baselines,
			)

			reportUnmatchedFilter(context, filters.filter, matched)

			// Module output is done, so stdout returns to the report. What tests
			// wrote was captured by the runtime.
			restore()
			restored = true

			let duration = performance.now() - started
			// Over every entry's events, so the report and coverage describe the
			// whole project rather than the save.
			let run = { ...collectTestRun(allEvents()), duration }
			let coverage = context.options.coverage
				? collectCoverage(allEvents())
				: emptyCoverage
			// Only this cycle's events are written to the stores.
			let cycled = cycleEvents(toRun.map((suite) => suite.inputFileName))
			let written = await writeSnapshots({
				snapshots: collectSnapshots(cycled),
				sources,
				stored,
				inline: async () =>
					(await import("@essence-lang/formatter/snapshots"))
						.writeInlineSnapshots,
			})
			let kept = await writeCorpus({
				corpus,
				...collectCorpusChanges(cycled),
			})
			let recorded = await writeBenchmarks({
				benchmarks: collectBenchmarks(cycled),
				stored: baselines,
			})

			for (let problem of [
				...written.problems,
				...recorded.problems,
				...kept.problems,
			]) {
				terminal.err(
					`  ${palette.warning(
						theme.symbols.warning,
					)} ${palette.muted(problem)}`,
				)
			}

			// Compile Diagnostics go to stderr even under `--json`, since they
			// are not events.
			if (compilation !== null) {
				printDiagnostics(context, compilation)
			}

			for (let entry of broken) {
				terminal.err(
					`  ${palette.warning(
						theme.symbols.warning,
					)} ${palette.muted(
						`${entry} did not compile — showing the last run`,
					)}`,
				)
			}

			// Before the cycle says it has ended, so that a signal sent
			// on seeing that finds the handler there.
			handleSignals(true)

			if (context.options.json) {
				writeEvent(
					`${JSON.stringify({
						schema: 1,
						kind: "run-end",
						passed: run.counts.passed,
						failed: run.counts.failed,
						skipped: run.counts.skipped,
						deselected:
							run.counts.notFocused + run.counts.deselected,
						duration,
						focused: run.focused,
					})}\n`,
				)
			} else {
				// A terminal is cleared so it shows the project's state in one
				// screen. Piped output keeps every line.
				if (terminal.isInteractive) {
					terminal.stdout.write("\x1b[2J\x1b[H")
				}

				terminal.out("")
				terminal.out(
					`  ${palette.strong(
						`${context.programName} test`,
					)} ${palette.faint(theme.symbols.bullet)} ${palette.muted(
						`${inputFileNames.length} ${
							inputFileNames.length === 1 ? "file" : "files"
						}`,
					)}  ${palette.faint(timestamp())}`,
				)

				printReport(
					context,
					run,
					sources,
					coverage,
					written,
					cacheWarm,
					recorded,
				)
				footer()
			}

			// The coverage file is written under `--json` too.
			await writeCoverageReport(context, coverage)
		} finally {
			if (!restored) {
				restore()
			}

			handleSignals(true)
			running = false
		}

		if (pending.size > 0) {
			let next = [...pending]

			pending.clear()

			await cycle(next)

			return
		}

		if (searchAgain) {
			searchAgain = false

			await rediscover()
		}
	}

	if (inputFileNames.length === 0 && !context.options.json) {
		terminal.out("")
		terminal.out(renderNoTests(files, context.report))
	}

	await watcher.watch(
		inputFileNames.map((fileName) => path.resolve(fileName)),
	)
	await cycle(inputFileNames)

	return new Promise<number>((resolve) => {
		let shutdown = async () => {
			stopped = true
			watcher.close()
			restoreInput()
			await plan.dispatcher.dispose()
			await rm(staging, { recursive: true, force: true })
			terminal.out("")
			resolve(EXIT_SUCCESS)
		}

		let onKey = (chunk: Buffer) => {
			let key = chunk.toString()

			if (key === "q" || key === CTRL_C) {
				void shutdown()

				return
			}

			if (key === "r") {
				void cycle(inputFileNames)

				return
			}

			if (key === "c") {
				terminal.stdout.write("\x1b[2J\x1b[H")
				footer()
			}
		}

		let restoreInput = () => {
			if (process.stdin.isTTY) {
				process.stdin.setRawMode(false)
				process.stdin.pause()
			}

			process.stdin.off("data", onKey)
		}

		// Raw mode delivers single keypresses without return. It also delivers
		// Ctrl+C as data rather than as a signal, so `onKey` handles it.
		if (process.stdin.isTTY) {
			process.stdin.setRawMode(true)
			process.stdin.resume()
			process.stdin.on("data", onKey)
		}
	})
}
