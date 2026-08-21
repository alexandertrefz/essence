import type { TestEvent } from "@essence-lang/runtime/Testing"

// NOTE: What the Language Server tells an Editor about a test run, and what it
// tells the Worker that performs one. Both are written down here, apart from
// the code that sends them, because they are a CONTRACT: an extension is built
// against the notification and a bundled Worker is built against the messages,
// and neither can be read out of the implementation once it ships.

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

export type TestRunNotification = {
	version: 1
	// NOTE: Which cycle this is, counted from the session's start. The `end`
	// carrying a run number answers the `start` that carried it, and a client
	// that has already drawn a later run may drop an earlier one that arrives
	// out of order.
	run: number
	kind: "start" | "end"
	// NOTE: What asked for the run. `open` is the session starting or a folder
	// arriving, `change` an edit, and `request` an `essence/runTests` from the
	// Editor — which is what a Run lens sends.
	reason: "open" | "change" | "request"
	// NOTE: The files this cycle covers, as absolute paths. On a `start` they
	// are what is about to run; on an `end` they are what ran. Everything the
	// session holds for a file in this list is REPLACED by this batch.
	files: Array<string>
	// NOTE: The whole batch, in the order it happened. Empty on a `start`.
	events: Array<TestEvent>
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
export type TestWorkerRequest =
	| {
			kind: "run"
			run: number
			// NOTE: The entry files to compile and run. Each runs the tests of
			// its OWN Module and no others: an entry is a file that wrote a
			// `tests { … }` block, and a file two entries import runs its tests
			// under its own name once.
			entries: Array<string>
			// NOTE: The unsaved buffers, by absolute path. The Worker reads
			// these before it reads disk, which is what makes the session
			// answer for the file as it is being typed rather than as it was
			// last saved.
			overlays: Record<string, string>
			filters: {
				filter?: string | null
				tags?: Array<string>
				skipTags?: Array<string>
				focusedElsewhere?: boolean
			}
			// NOTE: Run only these tests, by structural id. Empty runs whatever
			// the filters select.
			ids: Array<string>
	  }
	| { kind: "close" }

export type TestWorkerResponse =
	| { kind: "ready" }
	| {
			kind: "entry"
			run: number
			entry: string
			events: Array<TestEvent>
			// NOTE: Whether this entry holds a focused test, so the session can
			// tell every other entry so on the next cycle — focus is decided
			// across a whole run and one Worker message knows one bundle.
			focused: boolean
			compiled: boolean
			// NOTE: What went wrong, rendered, where the entry could not be
			// compiled or its bundle would not load. Diagnostics are not sent:
			// the Server's own analysis publishes those, from the same buffers.
			problem: string | null
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
