import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import * as path from "node:path"

import { randomSeed, type TestEvent } from "@essence-lang/runtime/Testing"

import { EXIT_SUCCESS } from "./actions"
import type { CommandSpec } from "./commands"
import {
	type CompilationResult,
	planCompilation,
	printDiagnostics,
	runCompilation,
} from "./compile"
import { readProjectConfiguration } from "./configuration"
import type { CLIContext } from "./context"
import { discoverTestFiles } from "./discovery"
import {
	claimRegistries,
	type LoadedBundle,
	type LoadedSuite,
	loadBundles,
	printReport,
	redirectStdout,
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

// NOTE: `essence test --watch` stays up and re-runs only what a change reached.
// The unit of a re-run is an ENTRY: a compiled bundle and the tests of the
// Modules it claimed. What a save reaches is worked out from the module graphs
// the last compile reported, exactly as `esc watch` works out what to rebuild —
// so editing a Module re-runs the tests of every file that imports it and not
// the whole project.
//
// NOTE: Each entry's events are kept apart, and a re-run REPLACES that entry's
// stream. The report is the whole picture folded back up out of all of them, so
// the tree on screen after a save says what every test holds and not only what
// just ran.

// NOTE: Raw mode delivers Ctrl+C as data rather than as a signal.
const CTRL_C = String.fromCharCode(3)

function timestamp(): string {
	let now = new Date()
	let pad = (value: number) => String(value).padStart(2, "0")

	return `${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(
		now.getSeconds(),
	)}`
}

// NOTE: The tests a suite is the one to run, as ids — what a claim CHANGING
// looks like. A shared Module moving from one entry to another has to re-run
// both, or the one that lost it goes on reporting tests it no longer runs.
function claimedIds(suite: LoadedSuite): string {
	return suite.registry.tests.map((test) => test.entry.id).join("\n")
}

export async function runTestWatch(
	context: CLIContext,
	command: CommandSpec,
	files: Array<string>,
): Promise<number> {
	let { palette, terminal, theme } = context
	let configuration = await readProjectConfiguration()

	for (let problem of configuration.problems) {
		terminal.err(
			`  ${palette.warning(theme.symbols.warning)} ${palette.muted(
				problem,
			)}`,
		)
	}

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
		configuration.test.exclude,
		contracts,
	)
	let plan = await planCompilation(context, command, inputFileNames, {
		emit: true,
		cacheOutput: true,
		tests: true,
		contracts,
	})
	// NOTE: One staging root for the whole session, with a directory per cycle
	// inside it. Bun's resolver remembers what a directory held the first time
	// it read anything out of it, so a re-run whose bundle changed has to be
	// staged somewhere nothing has ever looked — see `stageBundle`.
	let staging = await mkdtemp(path.join(tmpdir(), "essence-test-watch-"))
	let dependents = createDependentsIndex()
	let bundles = new Map<string, LoadedBundle>()
	let eventsByEntry = new Map<string, Array<TestEvent>>()
	let claims = new Map<string, string>()
	let sources = new Map<string, string>()
	let cycles = 0
	// NOTE: Whether the run as a whole held a focused test at the end of the
	// last cycle. A focus silences every other test of the run, so the answer
	// changing means every suite is reporting the wrong thing and all of them
	// have to run again.
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

	// NOTE: What THIS cycle's entries wrote, which is what a snapshot write
	// acts on — everything else is on disk from an earlier cycle already.
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
		// NOTE: Something happened in a watched directory that no watched file
		// accounts for, which is what a NEW source looks like from here. The
		// project is searched again, and a file that now writes tests joins the
		// session where it stands.
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

		// NOTE: Remembered rather than dropped. A file written while a cycle is
		// in flight would otherwise be noticed by nothing ever again: the
		// activity that would have found it has already happened.
		if (running) {
			searchAgain = true

			return
		}

		let found = await discoverTestFiles(
			files,
			command,
			context.programName,
			process.cwd(),
			configuration.test.exclude,
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

	// NOTE: One turn of the session: compile what changed, load what it emitted,
	// run what has to run, and reprint the whole picture. A change arriving
	// while one is in flight is remembered and taken as soon as it finishes,
	// rather than interleaved with it — a run is synchronous and the bundles it
	// drives are being replaced underneath.
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

		// NOTE: A cycle that compiled nothing is warm by default: the entries it
		// re-ran are the ones a change reached, and where a change reached none
		// of them the bundles are exactly the ones the last cycle loaded.
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

		// NOTE: stdout is the event stream's under --json and the report's
		// otherwise, and neither may carry what a Module writes as it is
		// evaluated — a `Terminal.print` outside any test, before any test is
		// running. It is pointed at stderr for the length of the load and the
		// run, where the output still arrives.
		let restore = redirectStdout()
		let restored = false
		let broken: Array<string> = []

		try {
			let toLoad: Array<{ inputFileName: string; bundle: string }> = []

			for (let outcome of compilation?.outcomes ?? []) {
				if (!outcome.ok || outcome.outputFileName === null) {
					// NOTE: An entry that would not compile keeps the events of
					// the last run that did. What it reports is stale and says
					// so — the Diagnostics are printed above the tree — and
					// throwing them away would leave the reader with nothing at
					// all about a file they are in the middle of editing.
					broken.push(outcome.inputFileName)

					continue
				}

				toLoad.push({
					inputFileName: outcome.inputFileName,
					bundle: outcome.outputFileName,
				})
			}

			// NOTE: One call for the whole cycle, into a directory of this
			// cycle's own. Staging is numbered WITHIN a call, so loading two
			// bundles through two calls would stage both as `0/tests.mjs` —
			// and `import()` caches by URL, so the second would answer with
			// the first bundle's registry and its entry would look empty.
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
			// NOTE: Everything the change reached, plus every suite whose claim
			// moved — and, once the focus of the run has changed, everything:
			// what `focused` silences is decided across the whole session, so a
			// suite that was deselected under the old answer is reporting the
			// wrong thing under the new one.
			let toRun = suites.filter(
				(suite) =>
					targets.includes(suite.inputFileName) ||
					claims.get(suite.inputFileName) !== claimedIds(suite),
			)

			for (let suite of suites) {
				claims.set(suite.inputFileName, claimedIds(suite))
			}

			let focusedNow = suites.some(
				(suite) => suite.tests.select(suite.registry, filters).focused,
			)

			// NOTE: Remembered rather than read back off the events. The
			// streams kept here carry no `run-start`, on purpose — one cycle is
			// one run and its bookends are written once, around the whole of it
			// — so the events could not answer this question.
			if (focusedNow !== focused && cycles > 1) {
				toRun = suites
			}

			focused = focusedNow

			for (let suite of toRun) {
				eventsByEntry.set(suite.inputFileName, [])
			}

			// NOTE: Read afresh every cycle. A watching session is exactly the
			// one that sees a `__snapshots__` file change under it — a
			// `--update` run in another terminal, an editor's "Accept
			// snapshot" — and the entries it compares against have to be the
			// ones on disk now.
			let stored = await readSnapshots(sources.keys())
			// NOTE: And the baselines, afresh and for the same reason — a
			// `--bench --update` in another terminal moves them under a
			// watching session.
			let baselines = context.options.bench
				? await readBenchmarks(sources.keys())
				: {}
			// NOTE: The corpus too, and it matters more here than it does for
			// a snapshot: a watching session is what WRITES a counterexample
			// down, and the cycle after a failure has to see the value the
			// cycle before it recorded.
			let corpus = await readCorpus(sources.keys())

			for (let entry of corpus.unreadable) {
				terminal.err(
					`  ${palette.warning(
						theme.symbols.warning,
					)} ${palette.muted(entry.problem)}`,
				)
			}

			let { matched } = runSuites(
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
				// NOTE: A seed per CYCLE rather than per session: a watching
				// run is a fresh run of everything a save reached, and drawing
				// the very values the last cycle drew would hide a property
				// that only fails sometimes. `--seed` pins it where a reader
				// asked for the same values every time.
				{
					seed: context.options.seed ?? randomSeed(),
					cases: context.options.cases,
					counterexamples: corpus.stores,
				},
				baselines,
			)

			reportUnmatchedFilter(context, filters.filter, matched)

			// NOTE: Everything a Module wrote as it was evaluated has been
			// written by now, so stdout goes back to being the report's before
			// the report is written. What a test itself wrote never came
			// through there: the runtime captured it against the test.
			restore()
			restored = true

			let duration = performance.now() - started
			// NOTE: Over EVERY entry's stream, not just this cycle's. An entry
			// nothing reached keeps the events it had, coverage among them, so
			// the picture is of the project rather than of the save — which is
			// what makes a watching coverage report incremental without
			// anything here merging anything.
			let run = { ...collectTestRun(allEvents()), duration }
			let coverage = context.options.coverage
				? collectCoverage(allEvents())
				: emptyCoverage
			// NOTE: This cycle's OWN events, bound once for the three
			// collectors below — what an entry nothing reached recorded two
			// saves ago is on disk already, and three copies of this filter
			// would be three module lists that could drift apart.
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

			// NOTE: Compile Diagnostics go to stderr whatever was asked for,
			// including under --json: they are not events, and a file that
			// stopped compiling has to say so somewhere or the reader is
			// looking at a report that quietly stopped moving.
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
				// NOTE: Cleared and reprinted rather than appended to. What a
				// watching reader wants is the state of the project now, in one
				// screen, rather than a log they have to scroll back through to
				// find the run before this one. Only where a terminal is
				// attached: piped output is read by something that keeps every
				// line.
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

			// NOTE: Outside the branch above, because writing a report is not
			// something the terminal decides: a job piping `--json` out of a
			// watching session asked for the file exactly as a job reading the
			// table did.
			await writeCoverageReport(context, coverage)
		} finally {
			if (!restored) {
				restore()
			}

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

		// NOTE: Raw mode is what makes single keypresses arrive without the
		// reader pressing return. It also means Ctrl+C is delivered as data
		// rather than as a signal, so it is handled by hand above.
		if (process.stdin.isTTY) {
			process.stdin.setRawMode(true)
			process.stdin.resume()
			process.stdin.on("data", onKey)
		}

		process.on("SIGINT", () => {
			void shutdown()
		})
	})
}
