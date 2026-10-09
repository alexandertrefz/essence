import type {
	CoverageSummary,
	SourceRewrite,
} from "@essence-lang/compiler/testing"
import type { Range, TestEvent } from "@essence-lang/runtime/Testing"

// What the Language Server tells an Editor about a test run, and what it tells
// the Worker that performs one. Extensions and bundled Workers are built
// against these shapes, so they are a contract.

// #region Where a test stands

// One test as the Compiler found it, whatever running it said, for a client
// drawing a tree. Its ranges come from the Module's manifest, the same ranges
// the lenses and Diagnostics use; events carry no Position.
export type TestSite = {
	// The structural id, exactly as every event spells it.
	id: string
	// The name template. A run reports the rendering, which differs only where
	// the name interpolates; a test that never ran has only this.
	name: string
	// Which row of a table test this is, or null for an ordinary test. A client
	// labels a row with it before anything has run.
	row: number | null
	suitePath: Array<string>
	// The file the test was written in, as an absolute path.
	file: string
	// The whole `test "…" { … }`, which a gutter marks, and the keyword alone,
	// where a lens and an Explorer item sit.
	range: Range
	keywordRange: Range
	// The effective tags, the test's own and every enclosing suite's.
	tags: Array<string>
	focused: boolean
	skipped: string | null
	// Whether the item is a `benchmark`. The session runs without `--bench`, so
	// one reports deselected for `bench`; running it by id measures it. A client
	// that predates this field ignores it, as it ignores an unknown event.
	benchmark: boolean
}

// #endregion

// #region The custom notification

// `essence/testRun`, sent when a cycle starts and when it ends with the whole
// batch. `version` is the payload's shape, `schema` each event's. A client
// ignores a notification of an unknown version and an event of an unknown kind.
export const TEST_RUN_NOTIFICATION = "essence/testRun"

// The version this Server sends.
export const TEST_RUN_VERSION = 3

export type TestRunNotification = {
	version: typeof TEST_RUN_VERSION
	// The cycle's number, counted from the session's start. The `end` answers the
	// `start` with its number; a client may drop a run older than one it drew.
	run: number
	kind: "start" | "end"
	// What asked for the run: `open` at session start or a new folder, `change`
	// an edit, `settings` a setting, `request` an `essence/runTests`.
	reason: "open" | "change" | "settings" | "request"
	// The files this cycle covers, as absolute paths: about to run on a `start`,
	// run on an `end`. The batch replaces a file's results unless narrowed.
	files: Array<string>
	// The tests this cycle was narrowed to, or empty. A narrowed batch replaces
	// only these tests; its deselections of the others are not adopted.
	ids: Array<string>
	// The whole batch, in the order it happened. Empty on a `start`.
	events: Array<TestEvent>
	// Every test of every covered file, in written order, run or not. Empty on a
	// `start`, and for a file that would not compile, so a client keeps its tree.
	sites: Array<TestSite>
	counts: {
		passed: number
		failed: number
		skipped: number
		deselected: number
	}
	duration: number
	// False when a covered file would not compile. The results a client holds for
	// it are then the last ones that ran.
	compiled: boolean
	// `files` is what this cycle counted, keyed by source file, for a client to
	// lay over what it has. `choices` is the session's whole answer about which
	// Cases were constructed, which a client replaces. Empty unless asked for.
	coverage: CoverageSummary
}

// #endregion

// #region What the Server reads out of the client's configuration

// The `essence.tests` settings, pulled through `workspace/configuration`.
// Without an answer: on, no coverage, a `450` millisecond debounce. What a
// project runs comes from its `essence.json`, as for `essence test`.
export type TestSettings = {
	enabled?: boolean
	debounce?: number
	// Whether a run counts coverage. Off by default: an instrumented bundle differs
	// from the build's and does more work per keystroke.
	coverage?: boolean
}

// #endregion

// #region The request an Editor sends

// `essence/runTests`, sent by a lens's command and a Test Explorer's run
// button. It schedules a run and answers with the run number.
export const RUN_TESTS_REQUEST = "essence/runTests"

export type RunTestsParams = {
	// Structural test ids, `<module>/<suite path>/<name>`, as events spell them. A
	// suite is named by the ids of its tests.
	ids?: Array<string>
	// Whole files, as absolute paths. Given both, the union runs.
	files?: Array<string>
	// Given neither, every test file of the workspace runs, including files the
	// client has not heard of. `update` records every snapshot the run produces:
	// a `__snapshots__` companion is written, a source answered as an edit.
	update?: boolean
}

export type RunTestsResult = {
	// The number of the cycle that will run this request, or null where the
	// session is off or nothing matched. A request deferred behind a running cycle
	// gets the deferred cycle's number, which may end after a cycle started later.
	run: number | null
}

// #endregion

// #region What the Worker is told, and what it answers

// One entry of a run: the file and its own project's settings, since a
// workspace may hold several projects.
export type TestEntry = {
	// The file to compile and run. It runs its own Module's tests only.
	filePath: string
	// The tags this entry's project skips, `test.skipTags` of its `essence.json`.
	skipTags: Array<string>
	// Whether this entry also tests its declarations' goals, as
	// `essence test --contracts` does. It changes the emitted bytes.
	contracts: boolean
}

// What the Worker is started with. `staging` is where it writes its bundles,
// created on first use and removed when the Worker ends.
export type TestWorkerData = {
	staging: string
	// How long esbuild's service outlives the last run, in milliseconds. The
	// Worker has its own default; only specs pass one.
	bundlerGrace?: number
}

export type TestWorkerRequest =
	| {
			kind: "run"
			run: number
			// The entries, each with its project's settings; see `TestEntry`.
			entries: Array<TestEntry>
			// The unsaved buffers, by absolute path, read before disk.
			overlays: Record<string, string>
			// What every entry is selected by. Skipped tags ride on each entry.
			filters: {
				filter?: string | null
				tags?: Array<string>
				focusedElsewhere?: boolean
			}
			// Only these tests, by structural id. Empty runs what the filters select.
			ids: Array<string>
			// Whether every snapshot is recorded. A source comes back as `rewrites`;
			// companion files are written in place.
			update: boolean
			// Whether to instrument and count coverage. It changes the emitted bytes, so
			// the bundles are compiled anew.
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
			// Every test of the entry from its manifest, run or not. Empty where it would
			// not compile.
			sites: Array<TestSite>
			// Whether the entry holds a focused test, which the session passes to the
			// other entries next cycle.
			focused: boolean
			compiled: boolean
			// Why the entry could not be compiled or loaded. Diagnostics are not sent;
			// the analysis publishes them.
			problem: string | null
			// The sources an accepted snapshot would rewrite, which the Server applies as
			// edits.
			rewrites: Array<SourceRewrite>
	  }
	| {
			kind: "done"
			run: number
			// The Worker holds as many bundles as it will, since none can be unloaded.
			// The session starts a new Worker.
			exhausted: boolean
	  }

// #endregion
