import { existsSync } from "node:fs"
import { tmpdir } from "node:os"
import { fileURLToPath } from "node:url"
import { Worker } from "node:worker_threads"

import {
	collectCoverage,
	collectTestRun,
	type CoverageSummary,
	emptyCoverage,
	mergeCoverage,
	removeStagingDirectory,
	type SourceRewrite,
	stagingDirectoryIn,
	sweepStagingDirectories,
	type TestRecord,
	testFailureDiagnostic,
} from "@essence-lang/compiler/testing"
import type { common } from "@essence-lang/interfaces"
import type { TestEvent } from "@essence-lang/runtime/Testing"

import {
	affectedTests,
	buildAttribution,
	type EntryAttribution,
} from "./affected"
import {
	TEST_RUN_VERSION,
	type TestRunNotification,
	type TestSite,
	type TestWorkerData,
	type TestWorkerRequest,
	type TestWorkerResponse,
} from "./testProtocol"

// One test session per workspace, re-running the test files a change reached.
// See "The live test session" in DEVELOPMENT.md.

// Long enough that a burst of keystrokes is one run. Longer than the analysis
// debounce, since the squiggle matters first.
const debounceInMilliseconds = 450

// How long one cycle may take before its Worker is terminated, the only way
// to end a test that loops for ever. Generous enough for a cold compile.
const deadlineInMilliseconds = 60_000

// Said of each entry a stopped cycle had not answered for. One that answered
// finished in time.
const stoppedProblem = (deadline: number): string =>
	`The test run did not finish within ${Math.round(deadline / 1000)}s and was stopped. A test that never ends — a loop with no way out — is the usual reason.`

// One staging directory per Worker, named for the Server's process.
const stagingPrefix = "essence-lsp-tests-"

type TestSessionOptions = {
	// The workspace's test files and what a change reaches, answered by the
	// Workspace's parses and edges.
	testFiles: () => Array<string>
	dependentsOf: (filePath: string) => Array<string>
	// What the project governing an entry says about running it, asked when each
	// run is built, since the reader may have just edited it.
	settingsFor: (filePath: string) => {
		skipTags: Array<string>
		contracts: boolean
	}
	// The unsaved buffers, by absolute path.
	overlays: () => Record<string, string>
	notify: (notification: TestRunNotification) => void
	// Which files have new results, for the Server to publish beside the
	// analysis's Diagnostics.
	onResults: (filePaths: Array<string>) => void
	// Why an entry could not be compiled or loaded. Not a Diagnostic: it tells a
	// file that reports nothing apart from one without tests.
	onProblem?: (filePath: string, problem: string) => void
	// Sources an accepted snapshot rewrote, which the Server applies as edits,
	// since the compiled buffer may be unsaved.
	onRewrites?: (rewrites: Array<SourceRewrite>) => void
	// Overridable so a spec can supply its own Worker.
	workerPath?: string
	debounce?: number
	// Overridable so a spec need not wait a minute.
	deadline?: number
	// Where each Worker's staging directory goes; overridable for specs.
	stagingRoot?: string
}

export type TestSession = {
	// Files that changed. Every test file they reach re-runs.
	changed(filePaths: Array<string>): void
	// Everything, as at a session start or when a folder arrives.
	runAll(reason: TestRunNotification["reason"]): void
	// What `essence/runTests` asks for. Answers with the run number, or null where
	// nothing matched.
	run(request: {
		ids?: Array<string>
		files?: Array<string>
		update?: boolean
	}): number | null
	setEnabled(enabled: boolean): void
	isEnabled(): boolean
	// How long a burst of edits is allowed to be before it costs a run.
	setDebounce(milliseconds: number): void
	// How long a run may take. Only specs move it.
	setDeadline(milliseconds: number): void
	// Whether a run counts coverage. Instrumented bundles differ, so the answer
	// arrives on the next cycle.
	setCoverage(coverage: boolean): void
	// The coverage of every cycle so far, laid over each other. Empty unless
	// asked for.
	coverage(): CoverageSummary
	// The `test-failed` Diagnostics for one file.
	diagnosticsFor(filePath: string): Array<common.Diagnostic>
	// Every test the session holds a result for, in the order they ran.
	records(): Array<TestRecord>
	recordsFor(filePath: string): Array<TestRecord>
	// One file's events, for the value hints, which read `probe` and `expect`
	// events.
	eventsFor(filePath: string): Array<TestEvent>
	dispose(): Promise<void>
}

// The Worker is source beside this file in the repository and a bundle beside
// the Server in the extension, which `buildServer.js` writes.
function defaultWorkerPath(): string {
	let bundled = fileURLToPath(new URL("./testWorker.js", import.meta.url))

	return existsSync(bundled)
		? bundled
		: fileURLToPath(new URL("./testWorker.ts", import.meta.url))
}

// What deferred requests ask for, folded together. `whole` outranks `ids`.
type PendingRequest = {
	entries: Set<string>
	ids: Set<string>
	whole: boolean
	update: boolean
	requested: boolean
	// The number the cycle taking these will carry, fixed when the first was
	// deferred. Null until something waits.
	run: number | null
}

function freshPending(): PendingRequest {
	return {
		entries: new Set(),
		ids: new Set(),
		whole: false,
		update: false,
		requested: false,
		run: null,
	}
}

export function createTestSession(options: TestSessionOptions): TestSession {
	let workerPath = options.workerPath ?? defaultWorkerPath()
	let debounce = options.debounce ?? debounceInMilliseconds
	let deadline = options.deadline ?? deadlineInMilliseconds
	let stagingRoot = options.stagingRoot ?? tmpdir()
	let sweeping = sweepStagingDirectories(stagingRoot, stagingPrefix)
	let enabled = true
	let coverageEnabled = false
	// Laid over cycle by cycle, since a cycle covers only what a change reached.
	let coverage: CoverageSummary = emptyCoverage
	// Each entry's attribution, from its last whole cycle, and which entries are
	// fresh enough to narrow by. See "Narrowing a cycle" in DEVELOPMENT.md.
	let entryAttribution = new Map<string, EntryAttribution>()
	let freshEntries = new Set<string>()
	let disposed = false
	let worker: Worker | null = null
	let runCounter = 0
	// One stream per entry file, replaced when that entry runs again.
	let eventsByEntry = new Map<string, Array<TestEvent>>()
	let focusedEntries = new Set<string>()
	let dirty = new Set<string>()
	// The files that changed, kept raw until the window fires, since working out
	// what they reached reads the workspace's parses.
	let changedFiles = new Set<string>()
	// A request that arrived while a run was in flight, remembered whole: its
	// tests, whether it accepts snapshots, and that it was a request.
	let pending = freshPending()
	let timer: ReturnType<typeof setTimeout> | null = null
	// The running cycle's deadline, cleared when it answers.
	let clock: ReturnType<typeof setTimeout> | null = null
	let inFlight: {
		run: number
		reason: TestRunNotification["reason"]
		entries: Array<string>
		// The entries the Worker has not answered for yet.
		waiting: Set<string>
		// The tests this run was narrowed to, which decides whether a batch replaces
		// a file's results or merges into them.
		ids: Array<string>
		started: number
		events: Array<TestEvent>
		// Where every test of this cycle stands, for a client drawing a tree.
		sites: Array<TestSite>
		// The sources this cycle would rewrite, when it records.
		rewrites: Array<SourceRewrite>
		// Whether this cycle records what it found. A recording cycle runs again, so
		// its results compare against what it recorded.
		update: boolean
		compiled: boolean
		// Whether this cycle was instrumented, fixed at its start, so toggling
		// coverage mid-run never makes it count as attribution.
		coverage: boolean
		// The open buffers this cycle compiled: the text its attribution's Positions
		// are in.
		snapshot: Record<string, string>
	} | null = null

	function testFiles(): Array<string> {
		return options.testFiles()
	}

	// The test files a change reached: itself if it writes tests, else every test
	// file importing it.
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

		let staging = stagingDirectoryIn(stagingRoot, stagingPrefix)
		let started = new Worker(workerPath, {
			// The Worker's stdout stays apart from the Server's, which speaks LSP over
			// stdio.
			stdout: true,
			stderr: true,
			workerData: { staging } satisfies TestWorkerData,
		})

		started.on("message", (message: TestWorkerResponse) => {
			receive(message)
		})
		started.on("error", () => {
			// A dead Worker takes the run with it. The next request starts another, so
			// one that fails to start is not restarted for ever.
			worker = null
			finish(false)
		})
		// However it ended: closed, crashed, or terminated.
		started.on("exit", () => {
			removeStagingDirectory(staging)
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

			// A narrowed run replaces only the tests it ran; its deselections would erase
			// the others. `test-coverage` events feed the attribution and are not stored
			// or sent.
			let visible = message.events.filter(
				(event) => event.kind !== "test-coverage",
			)
			let narrowed = inFlight.ids
			let events =
				narrowed.length === 0
					? visible
					: [
							...(eventsByEntry.get(message.entry) ?? []).filter(
								(event) =>
									!("id" in event) ||
									!narrowed.includes(event.id),
							),
							...visible.filter(
								(event) =>
									"id" in event &&
									narrowed.includes(event.id),
							),
						]

			eventsByEntry.set(message.entry, events)
			inFlight.waiting.delete(message.entry)
			inFlight.events.push(...visible)
			inFlight.sites.push(...message.sites)

			// Only a clean, whole cycle under coverage builds an entry's
			// attribution, with the text its Positions are in. See "Narrowing a
			// cycle" in DEVELOPMENT.md.
			let silenced = visible.some(
				(event) =>
					event.kind === "test-deselected" &&
					event.reason === "not-focused",
			)

			if (
				inFlight.coverage &&
				message.compiled &&
				inFlight.ids.length === 0 &&
				!silenced
			) {
				let byModule = buildAttribution(message.events)
				let text = new Map<string, string>()

				for (let module of byModule.keys()) {
					let source = inFlight.snapshot[module]

					if (source !== undefined) {
						text.set(module, source)
					}
				}

				entryAttribution.set(message.entry, {
					entry: message.entry,
					byModule,
					text,
				})
				freshEntries.add(message.entry)
			} else {
				freshEntries.delete(message.entry)
			}

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

			inFlight.rewrites.push(...message.rewrites)

			return
		}

		if (message.kind === "done" && message.run === inFlight.run) {
			finish(message.exhausted)
		}
	}

	function finish(exhausted: boolean): void {
		let run = inFlight

		inFlight = null

		if (clock !== null) {
			clearTimeout(clock)
			clock = null
		}

		if (run === null) {
			return
		}

		if (exhausted) {
			void worker?.terminate()
			worker = null
		}

		let folded = collectTestRun(run.events)
		// A narrowed cycle's coverage is not adopted. See "Coverage" in
		// DEVELOPMENT.md.
		let narrowedCycle = run.ids.length > 0
		let counted =
			coverageEnabled && !narrowedCycle
				? collectCoverage(run.events)
				: emptyCoverage

		if (!coverageEnabled) {
			coverage = emptyCoverage
		} else if (!narrowedCycle) {
			coverage = mergeCoverage(coverage, counted)
		}

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
			// This cycle's files and the session's Choices. `coverage` in
			// `testProtocol.ts` says why they travel differently.
			coverage: { files: counted.files, choices: coverage.choices },
		})
		options.onResults(run.entries)

		// After the notification, so the Editor has drawn the results before it
		// applies an edit.
		if (run.rewrites.length > 0) {
			options.onRewrites?.(run.rewrites)
		}

		// A cycle that recorded runs again, so its results compare against what it
		// recorded and the lens goes.
		if (run.update) {
			for (let entry of run.entries) {
				dirty.add(entry)
			}
		}

		if (dirty.size > 0) {
			arm()
		}
	}

	// The number a cycle carries: the one it was promised while it waited, if
	// any.
	function numberFor(reserved: number | null): number {
		if (reserved !== null) {
			return reserved
		}

		runCounter += 1

		return runCounter
	}

	// Ends a promised cycle that will never run, so a client waiting on its
	// number stops waiting.
	function endPromise(run: number): void {
		options.notify({
			version: TEST_RUN_VERSION,
			run,
			kind: "end",
			reason: "request",
			files: [],
			ids: [],
			events: [],
			sites: [],
			counts: { passed: 0, failed: 0, skipped: 0, deselected: 0 },
			duration: 0,
			compiled: true,
			// The session's Choices all the same: `choices` replaces what the client
			// holds, while `files` is laid over it.
			coverage: { files: [], choices: coverage.choices },
		})
	}

	function start(
		entries: Array<string>,
		reason: TestRunNotification["reason"],
		ids: Array<string>,
		update = false,
		// The number a deferred request was answered with, or null.
		reserved: number | null = null,
	): number | null {
		if (disposed || entries.length === 0) {
			return null
		}

		// A switched-off session runs nothing by itself, but still runs what an
		// Editor asks for.
		if (!enabled && reason !== "request") {
			return null
		}

		if (inFlight !== null) {
			// A run is going, so the request is folded into `dirty` and `pending` and
			// runs next. Terminating would discard a compile about to answer.
			for (let entry of entries) {
				dirty.add(entry)
				pending.entries.add(entry)
			}

			if (ids.length === 0) {
				pending.whole = true
			} else {
				for (let id of ids) {
					pending.ids.add(id)
				}
			}

			pending.update ||= update
			pending.requested ||= reason === "request"
			// Answered with the number of the cycle that will run it, so the gesture
			// receives its own batch. Fixed once per pending cycle.
			pending.run ??= numberFor(reserved)

			return pending.run
		}

		let run = numberFor(reserved)
		// One read of the open buffers, for the Worker and the attribution alike.
		let snapshot = options.overlays()

		inFlight = {
			run,
			reason,
			entries,
			waiting: new Set(entries),
			ids,
			started: Date.now(),
			events: [],
			sites: [],
			rewrites: [],
			update,
			compiled: true,
			coverage: coverageEnabled,
			snapshot,
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
			// Each entry carries its own project's settings. The Worker has no Workspace.
			entries: entries.map((entry) => ({
				filePath: entry,
				...options.settingsFor(entry),
			})),
			overlays: snapshot,
			// A focus elsewhere silences these tests, as on the command line. The Worker
			// learns it from the last cycle, so it converges after one.
			filters: {
				focusedElsewhere: [...focusedEntries].some(
					(each) => !entries.includes(each),
				),
			},
			ids,
			update,
			coverage: coverageEnabled,
		}

		ensureWorker().postMessage(request)

		// A cycle that does not answer takes the Worker with it; nothing else ends a
		// looping test. What it reported is kept.
		clock = setTimeout(() => {
			clock = null

			if (inFlight === null || inFlight.run !== run) {
				return
			}

			void worker?.terminate()
			worker = null

			for (let entry of inFlight.waiting) {
				options.onProblem?.(entry, stoppedProblem(deadline))
			}

			finish(false)
		}, deadline)

		return run
	}

	function arm(): void {
		if (timer !== null) {
			clearTimeout(timer)
		}

		timer = setTimeout(() => {
			timer = null

			let known = new Set(testFiles())
			let changed = [...changedFiles]
			let waiting = pending

			changedFiles.clear()
			pending = freshPending()

			// What was already waiting is not this window's change, and a cycle carrying
			// any of it is never narrowed.
			let deferred = new Set(dirty)

			for (let entry of reached(changed)) {
				dirty.add(entry)
			}

			// A file that stopped existing or writing tests stops being reported on.
			for (let entry of eventsByEntry.keys()) {
				if (!known.has(entry)) {
					eventsByEntry.delete(entry)
					focusedEntries.delete(entry)
					entryAttribution.delete(entry)
					freshEntries.delete(entry)
				}
			}

			let entries = [...dirty].filter((entry) => known.has(entry))

			dirty.clear()

			// The reached tests, or null to run the files whole. Only when the cycle is
			// exactly this change's reach.
			let ids =
				deferred.size === 0 ? narrowingFor(entries, changed) : null

			// The request's own narrowing, only where the cycle is exactly what it asked
			// for, so no joined entry runs narrowed to tests it lacks.
			let asked =
				waiting.requested &&
				!waiting.whole &&
				waiting.ids.size > 0 &&
				entries.length === waiting.entries.size &&
				entries.every((entry) => waiting.entries.has(entry))
					? [...waiting.ids]
					: null

			// The number the deferred request was answered with.
			let started = start(
				entries,
				waiting.requested ? "request" : "change",
				asked ?? ids ?? [],
				waiting.update,
				waiting.run,
			)

			// A promised cycle with nothing left to run still ends its number.
			if (started === null && waiting.requested && waiting.run !== null) {
				endPromise(waiting.run)
			}
		}, debounce)
	}

	// Which reached tests to re-run, or null to run them whole. See "Narrowing a
	// cycle" in DEVELOPMENT.md.
	function narrowingFor(
		entries: Array<string>,
		changed: Array<string>,
	): Array<string> | null {
		if (!coverageEnabled || entries.length === 0) {
			return null
		}

		let attributions: Array<EntryAttribution> = []

		for (let entry of entries) {
			let attribution = entryAttribution.get(entry)

			if (!freshEntries.has(entry) || attribution === undefined) {
				return null
			}

			attributions.push(attribution)
		}

		let overlays = options.overlays()
		let affected = affectedTests(
			attributions,
			changed,
			(file) => overlays[file],
			(entry, file) => options.dependentsOf(file).includes(entry),
		)

		if (affected === null) {
			return null
		}

		let properties = propertyIdsOf(entries)

		return properties.length === 0
			? affected
			: [...new Set([...affected, ...properties])]
	}

	// The property tests of some entries, read off their last `property` events.
	// A narrowed cycle runs them all, since each run draws new values.
	function propertyIdsOf(entries: Array<string>): Array<string> {
		let ids: Array<string> = []

		for (let entry of entries) {
			for (let event of eventsByEntry.get(entry) ?? []) {
				if (event.kind === "property") {
					ids.push(event.id)
				}
			}
		}

		return ids
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
			update?: boolean
		}): number | null {
			let ids = request.ids ?? []
			let files = request.files ?? []
			let update = request.update ?? false

			// Asking for neither means every test file, as a Test Explorer's Run and
			// Refresh do. It also finds files the client has never heard of.
			if (ids.length === 0 && files.length === 0) {
				return start(testFiles(), "request", [], update)
			}

			let known = new Set(testFiles())
			let entries = new Set(
				files.filter((filePath) => known.has(filePath)),
			)

			// An id's first step names its Module, escaped, so the file is read off the
			// results rather than out of the id.
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
				// Files without ids run whole.
				entries.size > 0 && ids.length === 0 ? [] : ids,
				update,
			)
		},
		setEnabled(next: boolean): void {
			if (enabled === next) {
				return
			}

			enabled = next

			if (!enabled) {
				// Including a deferred request's cycle, so its number is ended.
				if (pending.requested && pending.run !== null) {
					endPromise(pending.run)
				}

				dirty.clear()
				pending = freshPending()

				if (timer !== null) {
					clearTimeout(timer)
					timer = null
				}

				if (clock !== null) {
					clearTimeout(clock)
					clock = null
				}

				eventsByEntry.clear()
				focusedEntries.clear()
				entryAttribution.clear()
				freshEntries.clear()
				inFlight = null
				void worker?.terminate()
				worker = null

				return
			}

			this.runAll("open")
		},
		isEnabled: () => enabled,
		setDebounce(milliseconds: number): void {
			debounce = Math.max(0, milliseconds)
		},
		setDeadline(milliseconds: number): void {
			deadline = Math.max(1, milliseconds)
		},
		setCoverage(next: boolean): void {
			if (next === coverageEnabled) {
				return
			}

			coverageEnabled = next
			// Switching discards what was counted and the attribution: instrumented and
			// plain bundles differ.
			coverage = emptyCoverage
			entryAttribution.clear()
			freshEntries.clear()

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

			if (clock !== null) {
				clearTimeout(clock)
				clock = null
			}

			inFlight = null

			await worker?.terminate()

			worker = null

			await sweeping
		},
	}

	// A record belongs to the file its test was written in, the events'
	// `module`, not to the entry that ran it.
	function recordsOf(filePath: string): Array<TestRecord> {
		return collectTestRun(eventsByEntry.get(filePath) ?? []).tests.filter(
			(record) => record.module === null || record.module === filePath,
		)
	}
}
