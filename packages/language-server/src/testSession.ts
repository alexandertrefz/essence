import { existsSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { Worker } from "node:worker_threads"

import {
	collectCoverage,
	collectTestRun,
	type CoverageSummary,
	emptyCoverage,
	mergeCoverage,
	type SourceRewrite,
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

// NOTE: How long one cycle — compile, load, run — is given before the Worker is
// taken away from it. A test can loop for ever, and this is the only thing that
// ends one: the Worker exists so that a run CAN be stopped, and nothing stopped
// it. Long enough that a cold compile of a large workspace is never mistaken
// for a hang, and short enough that a reader who wrote a loop by accident gets
// their session back within a cup of coffee's inattention.
const deadlineInMilliseconds = 60_000

type TestSessionOptions = {
	// NOTE: Every `.es` file the workspace knows, and — for each of them —
	// whether it wrote a `tests { … }` block and which files a change to it
	// reaches. The session asks rather than searches: the Workspace already
	// holds the parses and the edges, and a second walk would be a second
	// answer to disagree with.
	testFiles: () => Array<string>
	dependentsOf: (filePath: string) => Array<string>
	// NOTE: What the project governing one entry says about running it — the
	// tags it skips and whether its declarations are tested. Asked per entry,
	// and asked at the moment a run is built rather than held: a workspace is
	// not one project, and the file that answers this is one the reader may
	// have just edited.
	settingsFor: (filePath: string) => {
		skipTags: Array<string>
		contracts: boolean
	}
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
	// NOTE: The sources an accepted snapshot rewrote, and what each should
	// become. The Server turns them into a workspace edit rather than writing
	// them, because the buffer the run compiled may never have been saved.
	onRewrites?: (rewrites: Array<SourceRewrite>) => void
	// NOTE: Overridable so a spec can drive the Worker it wants — the real one
	// is resolved beside this file, or beside the bundled Server.
	workerPath?: string
	debounce?: number
	// NOTE: Overridable so a spec can wait a millisecond rather than a minute.
	deadline?: number
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
	run(request: {
		ids?: Array<string>
		files?: Array<string>
		update?: boolean
	}): number | null
	setEnabled(enabled: boolean): void
	isEnabled(): boolean
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
function defaultWorkerPath(): string {
	let bundled = fileURLToPath(new URL("./testWorker.js", import.meta.url))

	return existsSync(bundled)
		? bundled
		: fileURLToPath(new URL("./testWorker.ts", import.meta.url))
}

export function createTestSession(options: TestSessionOptions): TestSession {
	let workerPath = options.workerPath ?? defaultWorkerPath()
	let debounce = options.debounce ?? debounceInMilliseconds
	let deadline = options.deadline ?? deadlineInMilliseconds
	let enabled = true
	let coverageEnabled = false
	// NOTE: Laid over cycle by cycle. A cycle covers what a change reached and
	// says nothing about the rest, so what is held — and what is sent — is the
	// project's picture rather than the save's.
	let coverage: CoverageSummary = emptyCoverage
	// NOTE: One entry's attribution — which of its tests reached which points —
	// built from its last UNNARROWED cycle, so every index lines up with one
	// compile's table. `freshEntries` is which of them are trustworthy for
	// narrowing: an entry drops out the moment it runs narrowed or fails to
	// compile, and earns its place back on the next whole run. Both are empty
	// unless coverage is on; there is nothing to attribute otherwise.
	let entryAttribution = new Map<string, EntryAttribution>()
	let freshEntries = new Set<string>()
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
	// NOTE: The run in flight's own clock. Armed with the run and cleared when
	// it answers, so that a cycle that never answers ends anyway.
	let clock: ReturnType<typeof setTimeout> | null = null
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
		// NOTE: The sources this cycle would rewrite, where it was asked to
		// record what it found. Empty on every other cycle.
		rewrites: Array<SourceRewrite>
		// NOTE: Whether this cycle was asked to RECORD what it found. A cycle
		// that was runs again afterwards, so what it recorded is compared
		// against rather than left standing as something to accept.
		update: boolean
		compiled: boolean
		// NOTE: Whether THIS cycle was instrumented, captured at its start so a
		// setting toggled mid-flight does not make the run look like something
		// it was not — an uninstrumented run's entries must never be trusted as
		// attribution just because coverage was turned on while they were in
		// the air.
		coverage: boolean
		// NOTE: The open buffers as this cycle compiled them, kept so the next
		// change can be measured against the text the attribution was built on
		// — the coordinates its point Positions are in.
		snapshot: Record<string, string>
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
			// NOTE: The attribution below reads the RAW batch (it wants the
			// `test-coverage` events); everything the session STORES and sends
			// on has them stripped. They are the session's own bookkeeping —
			// the client folds them into nothing and the notification would only
			// carry their weight, one per test per Module, on every coverage
			// cycle.
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
			inFlight.events.push(...visible)
			inFlight.sites.push(...message.sites)

			// NOTE: An entry earns a fresh attribution only from an UNNARROWED
			// clean cycle under coverage — one where all of its tests ran against
			// one table. A narrowed cycle refreshes only some tests, and a failed
			// one refreshes none, so either drops the entry out of `freshEntries`
			// until a whole run settles it again. So does a cycle that SILENCED a
			// live test with a focus: the silenced test never ran, so its own
			// lines look like dead code in the attribution, and narrowing off
			// that truncated picture would skip it once the focus is lifted. The
			// snapshot is the text the table's Positions are in, kept so a later
			// change is measured against the same coordinates.
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
		// NOTE: A NARROWED cycle counts only the tests it ran, so its coverage is
		// a partial picture of every Module it touched — adopting it would repaint
		// a covered line grey on the very keystroke that was meant to be cheap. It
		// is a change WITHIN existing lines that a cycle is narrowed for (a
		// line-adding edit runs whole), so nothing MOVED: the picture the last
		// whole run left sits on the right lines, and this cycle leaves it exactly
		// as it was. Its COUNTS may be a keystroke stale — a line whose content
		// changed still wears the mark it last earned — until the next whole run
		// recomputes it, which the freshness rule makes the very next change.
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
			// NOTE: This cycle's files, and the session's Choices. See the
			// field's own NOTE in `testProtocol.ts` for why the two halves
			// travel differently.
			coverage: { files: counted.files, choices: coverage.choices },
		})
		options.onResults(run.entries)

		// NOTE: After the notification, so that the Editor has already drawn
		// what the run found by the time it is asked to apply an edit.
		if (run.rewrites.length > 0) {
			options.onRewrites?.(run.rewrites)
		}

		// NOTE: A cycle that recorded something runs again. What it recorded is
		// on disk (a companion file) or on its way into a buffer (a source), and
		// until something compares against it the results still say a snapshot
		// is waiting to be accepted — which would leave the lens standing over
		// a test whose snapshot has just been accepted.
		if (run.update) {
			for (let entry of run.entries) {
				dirty.add(entry)
			}
		}

		if (dirty.size > 0) {
			arm()
		}
	}

	function start(
		entries: Array<string>,
		reason: TestRunNotification["reason"],
		ids: Array<string>,
		update = false,
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
		// NOTE: One read of the open buffers, shared by the request the Worker
		// compiles and the attribution built from what it answers — so the text
		// an entry's table is measured in is exactly the text it ran.
		let snapshot = options.overlays()

		inFlight = {
			run,
			reason,
			entries,
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
			// NOTE: Each entry carries what the project governing IT says, read
			// here rather than in the Worker: the Worker has a filesystem but no
			// Workspace, and the settings are already answered per directory on
			// this side.
			entries: entries.map((entry) => ({
				filePath: entry,
				...options.settingsFor(entry),
			})),
			overlays: snapshot,
			// NOTE: A focus anywhere in the workspace silences everything else,
			// exactly as it does on the command line — and a Worker message
			// knows one bundle, so what the LAST run found is what the next one
			// is told. It converges after one cycle, which is one keystroke's
			// worth of being wrong about a test nobody is looking at.
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

		// NOTE: A cycle that does not answer takes the Worker with it. Nothing
		// else can end a test that loops for ever, and a session that waited on
		// one would never run another test: the request that arrives while a
		// run is in flight is remembered, not started, so ONE such test would
		// stop the session for the life of the Server. What was reported before
		// the run stopped is kept — the tests that did answer answered — and
		// the entries are told why they say nothing more.
		clock = setTimeout(() => {
			clock = null

			if (inFlight === null || inFlight.run !== run) {
				return
			}

			void worker?.terminate()
			worker = null

			for (let entry of inFlight.entries) {
				options.onProblem?.(
					entry,
					`The test run did not finish within ${Math.round(
						deadline / 1000,
					)}s and was stopped. A test that never ends — a loop with no way out — is the usual reason.`,
				)
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

			changedFiles.clear()

			// NOTE: Whatever was already waiting — an update re-run, entries a
			// run in flight deferred — is NOT this window's change, and a cycle
			// carrying any of it cannot be narrowed to this change's tests. Held
			// apart so the narrowing below only runs when the whole cycle IS the
			// reach of `changed`.
			let deferred = new Set(dirty)

			for (let entry of reached(changed)) {
				dirty.add(entry)
			}

			// NOTE: A file that stopped existing, or stopped writing tests,
			// stops being reported on.
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

			// NOTE: The tests within those files the change actually reached, or
			// null to run them whole — which is every case the attribution cannot
			// speak for. Only when the cycle is exactly the reach of this change,
			// so an unrelated deferred entry is never narrowed away.
			let ids =
				deferred.size === 0 ? narrowingFor(entries, changed) : null

			start(entries, "change", ids ?? [])
		}, debounce)
	}

	// NOTE: Which of a change's reached tests to re-run, or null for "run them
	// whole". Null whenever the attribution cannot be trusted to name the
	// complete set: coverage off (nothing is attributed), any reached entry not
	// freshly settled, or `affectedTests` refusing the change. Every rung that
	// answers "run more" is the safe one — a test whose reached lines did not
	// change cannot change its verdict, which is the same ground a whole-file
	// re-run already stands on.
	//
	// NOTE: The exception to that ground is a PROPERTY test, which draws fresh
	// values every run and reaches different lines each time — its attribution
	// is one run's sample, not the whole of what it could touch. So a narrowed
	// cycle re-runs every property of the reached entries regardless of where
	// the change fell, exactly as a whole-file run would have, rather than
	// trusting a sample to say it was untouched.
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

	// NOTE: The property tests of some entries, read off the events they last
	// emitted — a `property` event carries the id of the test it is about. They
	// re-run on every narrowed cycle, whatever the change, because their result
	// is a fact about a sample of drawn values rather than about a fixed set of
	// lines.
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

			// NOTE: Asking for neither is asking for everything — which is what
			// a Test Explorer's Run button and its Refresh send, neither of
			// which is about a file. Naming the workspace's test files here
			// rather than making the client name them is also what lets a run
			// find a file the client has never been told about, which is every
			// file whose first test was written since the last cycle.
			if (ids.length === 0 && files.length === 0) {
				return start(testFiles(), "request", [], update)
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
				update,
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
		setCoverage(next: boolean): void {
			if (next === coverageEnabled) {
				return
			}

			coverageEnabled = next
			// NOTE: What was counted under the old setting is thrown away
			// rather than kept: an instrumented compile and a plain one are
			// different bundles, and half a project's coverage laid under the
			// other half's would be a picture of neither. The attribution goes
			// with it — it is read off the same instrumented run.
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
