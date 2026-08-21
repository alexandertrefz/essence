import { existsSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { Worker } from "node:worker_threads"

import {
	collectCoverage,
	collectTestRun,
	type CoverageSummary,
	emptyCoverage,
	mergeCoverage,
	type TestRecord,
	testFailureDiagnostic,
} from "@essence-lang/compiler/testing"
import type { common } from "@essence-lang/interfaces"
import type { TestEvent } from "@essence-lang/runtime/Testing"

import {
	TEST_RUN_VERSION,
	type TestRunNotification,
	type TestSite,
	type TestWorkerRequest,
	type TestWorkerResponse,
} from "./testProtocol"

// NOTE: One test session per workspace. It watches what the analysis already
// watches — the files an Editor opens and the ones that change on disk — works
// out which test files a change REACHED, and re-runs those and nothing else.
//
// NOTE: What it holds is one event stream per entry file, and a re-run replaces
// one of them. Everything a reader is shown — the Diagnostics, the Inlay Hints,
// the notification — is the fold of all of them, so a file that has not been
// touched keeps saying what it last said instead of going blank while its
// neighbour is edited.

// NOTE: Long enough that a burst of keystrokes is one run and short enough that
// stopping to think produces one. Deliberately behind the analysis debounce:
// what a reader wants first is the squiggle, and a test run is the expensive
// thing to be wrong about.
const debounceInMilliseconds = 450

export type TestSessionOptions = {
	// NOTE: Every `.es` file the workspace knows, and — for each of them —
	// whether it wrote a `tests { … }` block and which files a change to it
	// reaches. The session asks rather than searches: the Workspace already
	// holds the parses and the edges, and a second walk would be a second
	// answer to disagree with.
	testFiles: () => Array<string>
	dependentsOf: (filePath: string) => Array<string>
	// NOTE: The unsaved buffers, by absolute path.
	overlays: () => Record<string, string>
	notify: (notification: TestRunNotification) => void
	// NOTE: Which files have new results, so the Server can publish the
	// Diagnostics for them again — a failed `expect` is published beside the
	// analysis's own Diagnostics for that file, and only the analysis knows
	// what those are.
	onResults: (filePaths: Array<string>) => void
	// NOTE: An entry that could not be compiled or whose bundle would not
	// load, rendered. It is not a Diagnostic — the analysis publishes those out
	// of the same buffers — it is the session saying why it has nothing to
	// report, which otherwise looks exactly like a file with no tests in it.
	onProblem?: (filePath: string, problem: string) => void
	// NOTE: Overridable so a spec can drive the Worker it wants — the real one
	// is resolved beside this file, or beside the bundled Server.
	workerPath?: string
	debounce?: number
}

export type TestSession = {
	// NOTE: Files that changed. What re-runs is every test file the change
	// reached, which is the file itself when it wrote tests and every test file
	// that imports it otherwise.
	changed(filePaths: Array<string>): void
	// NOTE: Everything, which is what a session start and a folder arriving
	// mean.
	runAll(reason: TestRunNotification["reason"]): void
	// NOTE: What `essence/runTests` asks for. Answers with the run number the
	// notifications will carry, or null where there was nothing to run.
	run(request: { ids?: Array<string>; files?: Array<string> }): number | null
	setEnabled(enabled: boolean): void
	isEnabled(): boolean
	// NOTE: Tags no run of this session selects. It is the client's setting
	// rather than a filter of its own: an Editor running a project's tests on
	// every keystroke is exactly where "not the slow ones" is worth saying.
	setSkipTags(tags: Array<string>): void
	// NOTE: How long a burst of edits is allowed to be before it costs a run.
	setDebounce(milliseconds: number): void
	// NOTE: Whether a run counts what it reached. Turning it on compiles every
	// entry again — an instrumented bundle is different bytes — so the answer
	// arrives on the next cycle rather than at once.
	setCoverage(coverage: boolean): void
	// NOTE: What every cycle so far counted, laid over each other in the order
	// they arrived. Empty where the session was never asked for coverage.
	coverage(): CoverageSummary
	// NOTE: The `test-failed` Diagnostics for one file, for the Server to
	// publish beside the analysis's.
	diagnosticsFor(filePath: string): Array<common.Diagnostic>
	// NOTE: Every test the session holds a result for, in the order they ran.
	records(): Array<TestRecord>
	recordsFor(filePath: string): Array<TestRecord>
	// NOTE: The events of one file, for a consumer that wants more than the
	// fold — the Inlay Hints read the `probe` and `expect` events directly.
	eventsFor(filePath: string): Array<TestEvent>
	dispose(): Promise<void>
}

// NOTE: The Worker lives beside this file as source in the repository, and
// beside the Server as a bundle in the extension. `buildServer.js` writes the
// second; nothing writes the first, because Bun and Node both run the source.
export function defaultWorkerPath(): string {
	let bundled = fileURLToPath(new URL("./testWorker.js", import.meta.url))

	return existsSync(bundled)
		? bundled
		: fileURLToPath(new URL("./testWorker.ts", import.meta.url))
}

export function createTestSession(options: TestSessionOptions): TestSession {
	let workerPath = options.workerPath ?? defaultWorkerPath()
	let debounce = options.debounce ?? debounceInMilliseconds
	let skipTags: Array<string> = []
	let enabled = true
	let coverageEnabled = false
	// NOTE: Laid over cycle by cycle. A cycle covers what a change reached and
	// says nothing about the rest, so what is held — and what is sent — is the
	// project's picture rather than the save's.
	let coverage: CoverageSummary = emptyCoverage
	let disposed = false
	let worker: Worker | null = null
	let runCounter = 0
	// NOTE: One stream per entry file, replaced whole when that entry runs
	// again.
	let eventsByEntry = new Map<string, Array<TestEvent>>()
	let focusedEntries = new Set<string>()
	let dirty = new Set<string>()
	// NOTE: The files that changed, kept RAW until the window fires. Working out
	// which test files a change reached means reading the workspace's parses,
	// and a keystroke may not pay for that — the whole point of the debounce is
	// that a burst costs one answer rather than one per character.
	let changedFiles = new Set<string>()
	let timer: ReturnType<typeof setTimeout> | null = null
	let inFlight: {
		run: number
		reason: TestRunNotification["reason"]
		entries: Array<string>
		// NOTE: The tests this run was narrowed to, if any. What it decides is
		// whether a batch REPLACES a file's results or is merged into them.
		ids: Array<string>
		started: number
		events: Array<TestEvent>
		// NOTE: Where every test of every entry of this cycle stands. It is
		// accumulated rather than held between runs: nothing on this side reads
		// it, and a client that draws a tree is the thing that has to remember
		// one.
		sites: Array<TestSite>
		compiled: boolean
	} | null = null

	function testFiles(): Array<string> {
		return options.testFiles()
	}

	// NOTE: The test files a change reached. A file that wrote tests reaches
	// itself; anything else reaches every test file that imports it, which is
	// exactly what the Workspace's dependents answer.
	function reached(filePaths: Array<string>): Array<string> {
		let known = new Set(testFiles())
		let entries = new Set<string>()

		for (let filePath of filePaths) {
			for (let dependent of options.dependentsOf(filePath)) {
				if (known.has(dependent)) {
					entries.add(dependent)
				}
			}
		}

		return [...entries]
	}

	function ensureWorker(): Worker {
		if (worker !== null) {
			return worker
		}

		let started = new Worker(workerPath, {
			// NOTE: The Worker's own stdout, kept out of the Server's. The
			// Server speaks LSP over stdio, and one `Terminal.print` from a
			// Program being tested would corrupt the connection.
			stdout: true,
			stderr: true,
		})

		started.on("message", (message: TestWorkerResponse) => {
			receive(message)
		})
		started.on("error", () => {
			// NOTE: A Worker that died takes the run with it. The session
			// starts another on the next request rather than at once: a Worker
			// that fails to start would otherwise be started again forever.
			worker = null
			finish(false)
		})
		started.unref()
		worker = started

		return started
	}

	function receive(message: TestWorkerResponse): void {
		if (inFlight === null || disposed) {
			return
		}

		if (message.kind === "entry") {
			if (message.run !== inFlight.run) {
				return
			}

			// NOTE: A run somebody NARROWED to a few tests replaces those tests
			// and leaves the rest of the file saying what it last said. The
			// batch carries a deselection for every test that did not run, and
			// adopting those would turn "run this one" into "forget the others"
			// — which is not what a Run lens above one test means.
			let narrowed = inFlight.ids
			let events =
				narrowed.length === 0
					? message.events
					: [
							...(eventsByEntry.get(message.entry) ?? []).filter(
								(event) =>
									!("id" in event) ||
									!narrowed.includes(event.id),
							),
							...message.events.filter(
								(event) =>
									"id" in event &&
									narrowed.includes(event.id),
							),
						]

			eventsByEntry.set(message.entry, events)
			inFlight.events.push(...message.events)
			inFlight.sites.push(...message.sites)

			if (message.focused) {
				focusedEntries.add(message.entry)
			} else {
				focusedEntries.delete(message.entry)
			}

			if (!message.compiled) {
				inFlight.compiled = false
			}

			if (message.problem !== null) {
				options.onProblem?.(message.entry, message.problem)
			}

			return
		}

		if (message.kind === "done" && message.run === inFlight.run) {
			finish(message.exhausted)
		}
	}

	function finish(exhausted: boolean): void {
		let run = inFlight

		inFlight = null

		if (run === null) {
			return
		}

		if (exhausted) {
			void worker?.terminate()
			worker = null
		}

		let folded = collectTestRun(run.events)
		let counted = coverageEnabled
			? collectCoverage(run.events)
			: emptyCoverage

		coverage = coverageEnabled
			? mergeCoverage(coverage, counted)
			: emptyCoverage

		options.notify({
			version: TEST_RUN_VERSION,
			run: run.run,
			kind: "end",
			reason: run.reason,
			files: run.entries,
			ids: run.ids,
			events: run.events,
			sites: run.sites,
			counts: {
				passed: folded.counts.passed,
				failed: folded.counts.failed,
				skipped: folded.counts.skipped,
				deselected: folded.counts.notFocused + folded.counts.deselected,
			},
			duration: Date.now() - run.started,
			compiled: run.compiled,
			// NOTE: This cycle's files, and the session's Choices. See the
			// field's own NOTE in `testProtocol.ts` for why the two halves
			// travel differently.
			coverage: { files: counted.files, choices: coverage.choices },
		})
		options.onResults(run.entries)

		if (dirty.size > 0) {
			arm()
		}
	}

	function start(
		entries: Array<string>,
		reason: TestRunNotification["reason"],
		ids: Array<string>,
	): number | null {
		if (disposed || entries.length === 0) {
			return null
		}

		// NOTE: A session switched off stops running tests BY ITSELF. What the
		// setting declines is the automatic half — compiling and running a
		// project on every keystroke — and an Editor that asked for a run in so
		// many words has asked for exactly the thing that is not automatic. A
		// Run lens that quietly did nothing would be the worse reading of a
		// setting called `enabled`.
		if (!enabled && reason !== "request") {
			return null
		}

		if (inFlight !== null) {
			// NOTE: A run is already going. Cancelling it means terminating the
			// Worker, which throws away a compile that is nearly always about
			// to answer the same question — so the entries are remembered and
			// taken as soon as it is done.
			for (let entry of entries) {
				dirty.add(entry)
			}

			return inFlight.run
		}

		runCounter += 1

		let run = runCounter

		inFlight = {
			run,
			reason,
			entries,
			ids,
			started: Date.now(),
			events: [],
			sites: [],
			compiled: true,
		}

		options.notify({
			version: TEST_RUN_VERSION,
			run,
			kind: "start",
			reason,
			files: entries,
			ids,
			events: [],
			sites: [],
			counts: { passed: 0, failed: 0, skipped: 0, deselected: 0 },
			duration: 0,
			compiled: true,
			coverage: emptyCoverage,
		})

		let request: TestWorkerRequest = {
			kind: "run",
			run,
			entries,
			overlays: options.overlays(),
			// NOTE: A focus anywhere in the workspace silences everything else,
			// exactly as it does on the command line — and a Worker message
			// knows one bundle, so what the LAST run found is what the next one
			// is told. It converges after one cycle, which is one keystroke's
			// worth of being wrong about a test nobody is looking at.
			filters: {
				skipTags,
				focusedElsewhere: [...focusedEntries].some(
					(each) => !entries.includes(each),
				),
			},
			ids,
			coverage: coverageEnabled,
		}

		ensureWorker().postMessage(request)

		return run
	}

	function arm(): void {
		if (timer !== null) {
			clearTimeout(timer)
		}

		timer = setTimeout(() => {
			timer = null

			let known = new Set(testFiles())

			for (let entry of reached([...changedFiles])) {
				dirty.add(entry)
			}

			changedFiles.clear()

			// NOTE: A file that stopped existing, or stopped writing tests,
			// stops being reported on.
			for (let entry of eventsByEntry.keys()) {
				if (!known.has(entry)) {
					eventsByEntry.delete(entry)
					focusedEntries.delete(entry)
				}
			}

			let entries = [...dirty].filter((entry) => known.has(entry))

			dirty.clear()
			start(entries, "change", [])
		}, debounce)
	}

	return {
		changed(filePaths: Array<string>): void {
			if (!enabled || disposed) {
				return
			}

			for (let filePath of filePaths) {
				changedFiles.add(filePath)
			}

			arm()
		},
		runAll(reason: TestRunNotification["reason"]): void {
			start(testFiles(), reason, [])
		},
		run(request: {
			ids?: Array<string>
			files?: Array<string>
		}): number | null {
			let ids = request.ids ?? []
			let files = request.files ?? []

			// NOTE: Asking for neither is asking for everything — which is what
			// a Test Explorer's Run button and its Refresh send, neither of
			// which is about a file. Naming the workspace's test files here
			// rather than making the client name them is also what lets a run
			// find a file the client has never been told about, which is every
			// file whose first test was written since the last cycle.
			if (ids.length === 0 && files.length === 0) {
				return start(testFiles(), "request", [])
			}

			let known = new Set(testFiles())
			let entries = new Set(
				files.filter((filePath) => known.has(filePath)),
			)

			// NOTE: An id spells the Module it belongs to as its first step,
			// escaped — so the file a test lives in is read off the results
			// rather than out of the id, which is a name and not a path.
			for (let id of ids) {
				for (let [entry, events] of eventsByEntry) {
					if (
						events.some((event) => "id" in event && event.id === id)
					) {
						entries.add(entry)
					}
				}
			}

			return start(
				[...entries],
				"request",
				// NOTE: Files without ids run whole.
				entries.size > 0 && ids.length === 0 ? [] : ids,
			)
		},
		setEnabled(next: boolean): void {
			if (enabled === next) {
				return
			}

			enabled = next

			if (!enabled) {
				dirty.clear()

				if (timer !== null) {
					clearTimeout(timer)
					timer = null
				}

				eventsByEntry.clear()
				focusedEntries.clear()
				inFlight = null
				void worker?.terminate()
				worker = null

				return
			}

			this.runAll("open")
		},
		isEnabled: () => enabled,
		setSkipTags(tags: Array<string>): void {
			// NOTE: Sorted before the comparison, so that a client re-reading
			// its configuration and answering with the same tags in another
			// order does not re-run the whole workspace.
			let next = [...tags].sort()

			if (next.join("\u0000") === [...skipTags].sort().join("\u0000")) {
				return
			}

			skipTags = next

			// NOTE: What runs changed, so everything runs again — a test the
			// old tags left out has no result at all, and a client would go on
			// drawing the deselection it was last told about.
			this.runAll("settings")
		},
		setDebounce(milliseconds: number): void {
			debounce = Math.max(0, milliseconds)
		},
		setCoverage(next: boolean): void {
			if (next === coverageEnabled) {
				return
			}

			coverageEnabled = next
			// NOTE: What was counted under the old setting is thrown away
			// rather than kept: an instrumented compile and a plain one are
			// different bundles, and half a project's coverage laid under the
			// other half's would be a picture of neither.
			coverage = emptyCoverage

			this.runAll("settings")
		},
		coverage(): CoverageSummary {
			return coverage
		},
		diagnosticsFor(filePath: string): Array<common.Diagnostic> {
			let diagnostics: Array<common.Diagnostic> = []

			for (let record of recordsOf(filePath)) {
				for (let failure of record.failures) {
					let diagnostic = testFailureDiagnostic(record, failure)

					if (diagnostic !== null) {
						diagnostics.push(diagnostic)
					}
				}
			}

			return diagnostics
		},
		records(): Array<TestRecord> {
			return [...eventsByEntry.values()].flatMap(
				(events) => collectTestRun(events).tests,
			)
		},
		recordsFor: recordsOf,
		eventsFor: (filePath: string) => eventsByEntry.get(filePath) ?? [],
		async dispose(): Promise<void> {
			disposed = true

			if (timer !== null) {
				clearTimeout(timer)
				timer = null
			}

			inFlight = null

			await worker?.terminate()

			worker = null
		},
	}

	// NOTE: A record belongs to the file its test was WRITTEN in, which is what
	// the events carry as `module` — not to the entry that ran it. The two are
	// the same file today and the distinction costs nothing to keep.
	function recordsOf(filePath: string): Array<TestRecord> {
		return collectTestRun(eventsByEntry.get(filePath) ?? []).tests.filter(
			(record) => record.module === null || record.module === filePath,
		)
	}
}
