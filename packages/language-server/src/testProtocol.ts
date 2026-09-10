import type {
	CoverageSummary,
	SourceRewrite,
} from "@essence-lang/compiler/testing"
import type { Range, TestEvent } from "@essence-lang/runtime/Testing"

// NOTE: What the Language Server tells an Editor about a test run, and what it
// tells the Worker that performs one. Both are written down here, apart from
// the code that sends them, because they are a CONTRACT: an extension is built
// against the notification and a bundled Worker is built against the messages,
// and neither can be read out of the implementation once it ships.

// #region Where a test stands

// NOTE: One test as the Compiler found it, independently of what running it
// said. It is the half of a run an Editor needs to draw a TREE — a Test
// Explorer lists what exists, including everything a filter left out, and puts
// each item on the line it was written on.
//
// NOTE: The events carry no Position at all, on purpose: an event is about what
// happened, and a span belongs to the source. These come off the Module's own
// manifest, which is what the Compiler emitted beside the tests, so the ranges
// are the ranges the lenses and the Diagnostics use.
export type TestSite = {
	// NOTE: The structural id, exactly as every event spells it.
	id: string
	// NOTE: The name TEMPLATE. What a run reports is the RENDERING, which only
	// differs where the name interpolates — a client shows the rendering it has
	// and falls back to this, which is the only name a test that never ran has.
	name: string
	// NOTE: Which row of a table test this is, and null for the ordinary test
	// that runs once. `suitePath` already ends in the template the rows share,
	// so a client that draws a tree needs nothing else; this is what it labels
	// a row with before anything has run and worked out its name.
	row: number | null
	suitePath: Array<string>
	// NOTE: The file the test was WRITTEN in, as an absolute path.
	file: string
	// NOTE: The whole `test "…" { … }`, which is what a gutter marks, and the
	// keyword alone, which is where a lens and an Explorer item sit.
	range: Range
	keywordRange: Range
	// NOTE: The EFFECTIVE tags — the test's own and every enclosing suite's —
	// so a client filtering by tag never has to walk a suite path.
	tags: Array<string>
	focused: boolean
	skipped: string | null
	// NOTE: Whether the item was written as a `benchmark`. The session runs
	// without `--bench`, so one is reported deselected for the reason `bench` —
	// and this is what lets a client say so as a fact about the item rather than
	// as an accident of the run, and offer to measure the one somebody points
	// at. Running one BY ID measures it: the ids branch of the selection is
	// ahead of the gate, which is exactly the "Run this one" door.
	//
	// NOTE: Added without moving `TEST_RUN_VERSION`. A client built before this
	// existed reads the sites it always read and never looks here — which is the
	// same tolerance the events ask for, where a kind nobody knows is ignored
	// rather than refused.
	benchmark: boolean
}

// #endregion

// #region The custom notification

// NOTE: `essence/testRun`. Sent twice per cycle: once when a run begins, so the
// Editor can mark what is about to run, and once when it ends, carrying the
// whole event batch.
//
// NOTE: VERSIONED, and separately from the events it carries. `version` is this
// PAYLOAD's shape; every event inside carries `schema`, which is the event
// stream's. The two move independently — a new event kind is not a new payload
// — and a client that meets a `version` it does not know must ignore the
// notification rather than guess at it. A client that meets an event KIND it
// does not know must ignore that event and keep the rest.
export const TEST_RUN_NOTIFICATION = "essence/testRun"

// NOTE: The version this Server sends, so a client can name what it needs
// rather than repeating the number in a condition.
export const TEST_RUN_VERSION = 3

export type TestRunNotification = {
	version: typeof TEST_RUN_VERSION
	// NOTE: Which cycle this is, counted from the session's start. The `end`
	// carrying a run number answers the `start` that carried it, and a client
	// that has already drawn a later run may drop an earlier one that arrives
	// out of order.
	run: number
	kind: "start" | "end"
	// NOTE: What asked for the run. `open` is the session starting or a folder
	// arriving, `change` an edit, `settings` a setting that changes what runs,
	// and `request` an `essence/runTests` from the Editor — which is what a Run
	// lens sends.
	reason: "open" | "change" | "settings" | "request"
	// NOTE: The files this cycle covers, as absolute paths. On a `start` they
	// are what is about to run; on an `end` they are what ran. Everything the
	// session holds for a file in this list is REPLACED by this batch — unless
	// the batch was NARROWED, see `ids`.
	files: Array<string>
	// NOTE: The tests this cycle was narrowed to, empty where it was not. What
	// it decides is how much of a file the batch replaces: a run somebody asked
	// for by id reports a deselection for every OTHER test of that file, and a
	// client that adopted those would turn "run this one" into "forget the
	// rest". The Server holds its own results the same way.
	ids: Array<string>
	// NOTE: The whole batch, in the order it happened. Empty on a `start`.
	events: Array<TestEvent>
	// NOTE: Every test of every file this cycle covers, whether it ran or not,
	// in the order they were written. Empty on a `start`, and empty for a file
	// that would not compile — which is what lets a client keep drawing the
	// tree it last had rather than emptying it on a half-typed line.
	sites: Array<TestSite>
	counts: {
		passed: number
		failed: number
		skipped: number
		deselected: number
	}
	duration: number
	// NOTE: False when a file this cycle covers could not be compiled. Its
	// Diagnostics are published the ordinary way, under its own URI; what this
	// says is that the results the client is holding for that file are the last
	// ones that ran rather than the ones the buffer would produce.
	compiled: boolean
	// NOTE: What this CYCLE counted, and what the session knows about the
	// Choices. The two halves are carried differently on purpose:
	//
	// `files` is only what this cycle recomputed, keyed by SOURCE file — which
	// is not the same set as `files` above: a `Foo.tests.es` runs the tests,
	// and what its counters counted is mostly `Foo.es`. A client showing the
	// project lays each batch over what it had, keyed by `module`, and keeps
	// the files this cycle says nothing about. Sending the whole project every
	// time would put every point of every file on the wire at every keystroke.
	//
	// `choices` is the SESSION's answer, laid over cycle by cycle and sent
	// whole, because which Cases were CONSTRUCTED is a question about the whole
	// run — a Case built only by the file that was just re-run is still a Case
	// somebody built — and it is small enough to say again. A client replaces
	// it rather than merging, so nobody works that answer out twice.
	//
	// Both empty unless the session was asked for coverage, and empty on a
	// `start`.
	coverage: CoverageSummary
}

// #endregion

// #region What the Server reads out of the client's configuration

// NOTE: The `essence.tests` section, pulled with `workspace/configuration`
// whenever the client says something under `essence` changed. It is part of
// this contract rather than of the extension's manifest because any client may
// answer it, and a client that answers nothing keeps the defaults — a session
// that is on, counts nothing, and waits `450` milliseconds.
//
// NOTE: Every one of these is a fact about the READER: whether they want their
// project run as they type, whether they want it instrumented, and how long a
// burst of keystrokes is allowed to be. What a project RUNS — the tags it
// skips, whether its declarations are tested — is a fact about the project, and
// lives in the `essence.json` the terminal reads too. `essence.tests.skipTags`
// used to be spelled here as well, which left a project with two lists to keep
// agreeing and an editor that ran something else than `essence test`.
export type TestSettings = {
	enabled?: boolean
	debounce?: number
	// NOTE: Whether a run counts what it reached. It is off by default and
	// deliberately: instrumentation makes every compile of the session a
	// different bundle from the one a build would produce, and it makes the
	// Program do more work on every keystroke. A reader who wants the gutter
	// asks for it.
	coverage?: boolean
}

// #endregion

// #region The request an Editor sends

// NOTE: `essence/runTests`. What a Code Lens's command ends up sending, and
// what a Test Explorer's "run" button sends. Answering it schedules a run and
// answers with the number the notifications will carry.
export const RUN_TESTS_REQUEST = "essence/runTests"

export type RunTestsParams = {
	// NOTE: Structural test ids — `<module>/<suite path>/<name>`, exactly as
	// every event spells them. A suite is named by the ids of the tests under
	// it rather than by a path of its own, because a suite is not a thing the
	// runner selects.
	ids?: Array<string>
	// NOTE: Whole files, as absolute paths. Given both, the union runs.
	files?: Array<string>
	// NOTE: Given NEITHER, every test file of the workspace runs. That is what
	// a Test Explorer's Run and Refresh buttons mean, and a client that had to
	// name the files instead could only name the ones it had already been told
	// about — never the file whose first test was written a moment ago.
	//
	// NOTE: `update` is what the "Accept snapshot" Code Lens sends: every
	// snapshot this run produces is RECORDED, whether it differs from what was
	// stored or was never stored at all. A `__snapshots__` companion is written
	// where it stands; a source is answered as an edit, because the buffer the
	// run compiled may never have been saved.
	update?: boolean
}

export type RunTestsResult = {
	// NOTE: The cycle the results will arrive under, or null where the session
	// is off or nothing matched.
	run: number | null
}

// #endregion

// #region What the Worker is told, and what it answers

// NOTE: The session compiles and runs in a Worker rather than in the Server.
// Three reasons, in order of how badly each one bites:
//
// 1. A Program writes to `process.stdout`, and the Server's stdout IS the LSP
//    protocol stream. One `Terminal.print` outside a test would corrupt the
//    connection.
// 2. Every Compiler stage collects Diagnostics into module-level state, which
//    is safe exactly as long as no two collections interleave. A test compile
//    suspends inside itself — the bundler is asynchronous — so running one
//    beside the Server's own analysis is the one thing that discipline forbids.
// 3. A test can loop forever. A Worker can be terminated; a Server cannot
//    interrupt itself.

// NOTE: What one entry of a run is: the file, and what the project governing
// THAT file says about running it. Per entry rather than per run because a
// workspace is not one project — two folders are two of them, and a folder
// holds a nested project as easily as none — and the Worker compiles and runs
// the entries one at a time anyway, so carrying a list per run would only be a
// way of getting the second project wrong.
export type TestEntry = {
	// NOTE: The file to compile and run. It runs the tests of its OWN Module
	// and no others: a file two entries import runs its tests under its own
	// name once.
	filePath: string
	// NOTE: The tags this entry's project skips — `test.skipTags` of the
	// `essence.json` governing it, which is the same list `essence test` obeys.
	skipTags: Array<string>
	// NOTE: Whether this entry also tests what its own declarations promise, as
	// `essence test --contracts` does for one run. It changes the emitted bytes
	// — the goals are a suite synthesized into the section — so it is part of
	// the compile rather than of the selection.
	contracts: boolean
}

export type TestWorkerRequest =
	| {
			kind: "run"
			run: number
			// NOTE: The entries to compile and run, each with the settings of
			// the project it belongs to — see `TestEntry`.
			entries: Array<TestEntry>
			// NOTE: The unsaved buffers, by absolute path. The Worker reads
			// these before it reads disk, which is what makes the session
			// answer for the file as it is being typed rather than as it was
			// last saved.
			overlays: Record<string, string>
			// NOTE: What every entry of this run is selected by. The tags one
			// SKIPS is not among them: that is the project's answer rather than
			// the run's, and it rides on the entry.
			filters: {
				filter?: string | null
				tags?: Array<string>
				focusedElsewhere?: boolean
			}
			// NOTE: Run only these tests, by structural id. Empty runs whatever
			// the filters select.
			ids: Array<string>
			// NOTE: Whether every snapshot this run produces is RECORDED —
			// what the Editor's "Accept snapshot" asks for. A source it would
			// rewrite comes back as `rewrites`; the companion files are
			// written where the Worker stands.
			update: boolean
			// NOTE: Whether to compile with the instrumentation pass on and
			// count what the run reaches. It changes the emitted bytes, so a
			// session that turns it on compiles bundles of its own rather than
			// re-using the ones it already staged.
			coverage: boolean
	  }
	| { kind: "close" }

export type TestWorkerResponse =
	| { kind: "ready" }
	| {
			kind: "entry"
			run: number
			entry: string
			events: Array<TestEvent>
			// NOTE: Every test this entry holds, off the compiled Module's own
			// manifest, whether it ran or not. Empty where the entry would not
			// compile, for the same reason `events` is.
			sites: Array<TestSite>
			// NOTE: Whether this entry holds a focused test, so the session can
			// tell every other entry so on the next cycle — focus is decided
			// across a whole run and one Worker message knows one bundle.
			focused: boolean
			compiled: boolean
			// NOTE: What went wrong, rendered, where the entry could not be
			// compiled or its bundle would not load. Diagnostics are not sent:
			// the Server's own analysis publishes those, from the same buffers.
			problem: string | null
			// NOTE: The sources an accepted snapshot would rewrite, and what
			// each would become. Empty unless the run was asked to record —
			// the Server turns each into a workspace edit, so that an unsaved
			// buffer is edited rather than written round.
			rewrites: Array<SourceRewrite>
	  }
	| {
			kind: "done"
			run: number
			// NOTE: The Worker has loaded as many distinct bundles as it is
			// willing to hold. Every bundle a session compiles is a Module that
			// can never be unloaded, so a long editing session would grow
			// without bound; the session starts a new Worker instead.
			exhausted: boolean
	  }

// #endregion
