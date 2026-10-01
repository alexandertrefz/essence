import { pathToFileURL } from "node:url"
import { parentPort } from "node:worker_threads"

import type { CorpusStore, SnapshotStore } from "@essence-lang/compiler/testing"
import type { entryPoints, TestEvent } from "@essence-lang/runtime/Testing"

import { redirectStdout, rendered } from "./running"

// The Worker entry a mutant runs in. `import()` never unloads a bundle, so
// mutants load into a Worker that is replaced after `BUNDLE_LIMIT` of them. It
// only runs: paths cross in and events cross out. See "The mutant Worker" in
// DEVELOPMENT.md.

// How many bundles one Worker loads before the driver replaces it.
const BUNDLE_LIMIT = 64

type TestEntryPoints = typeof entryPoints
type LoadedTestBundle = { $tests?: TestEntryPoints }

// The stores every mutant of a run compares against, read once by the driver
// and sent once per Worker.
export type MutantStores = {
	snapshots: Record<string, SnapshotStore>
	counterexamples: Record<string, CorpusStore>
}

export type MutantWorkerRequest =
	// Posted when a Worker boots. Messages are handled in order, so every
	// `run` finds the stores in place.
	| ({ kind: "init" } & MutantStores)
	| {
			kind: "run"
			// Pairs an answer with its request.
			id: number
			// A bundle emitted into a fresh directory of its own.
			bundle: string
			// The tests that reach the site, run one at a time so the Worker stops
			// at the first kill.
			ids: Array<string>
			// The run's one seed, so property tests draw what they drew for the
			// baseline.
			seed: string
			cases: number | null
	  }
	| { kind: "close" }

// Where a mutant's run came apart. `load`, `run` and `answer` (events that
// could not cross the port) count as kills. The driver itself writes `worker`
// and `timeout`.
export type MutantPhase = "load" | "run" | "answer" | "worker" | "timeout"

export type MutantWorkerResponse =
	| { kind: "ready" }
	| {
			kind: "ran"
			id: number
			// The covering tests' events. The first `test-fail` names the killer.
			events: Array<TestEvent>
			// Why there is no answer, rendered for a reader.
			problem: string | null
			// Null exactly when `problem` is.
			phase: MutantPhase | null
			// Whether the driver must replace this Worker.
			exhausted: boolean
	  }

let loaded = 0
// Set by `init`. Until then a snapshot compares against nothing, which records
// rather than falsely matches.
let stores: MutantStores = { snapshots: {}, counterexamples: {} }

async function runMutant(
	request: Extract<MutantWorkerRequest, { kind: "run" }>,
): Promise<MutantWorkerResponse> {
	let answer = (
		events: Array<TestEvent>,
		problem: string | null,
		phase: MutantPhase | null = null,
	): MutantWorkerResponse => ({
		kind: "ran",
		id: request.id,
		events,
		problem,
		phase,
		exhausted: loaded >= BUNDLE_LIMIT,
	})
	let restore = redirectStdout()
	// Tracked as the work moves, since load and run failures throw the same
	// kinds of Error.
	let phase: MutantPhase = "load"

	try {
		let module = (await import(
			pathToFileURL(request.bundle).href
		)) as LoadedTestBundle
		let tests = module.$tests

		loaded += 1
		phase = "run"

		// A graph with no tests has nothing to ask.
		if (tests === undefined) {
			return answer([], null)
		}

		let registry = tests.registry()
		let events: Array<TestEvent> = []

		// One test per call, in the driver's order, stopping at the first kill.
		for (let id of request.ids) {
			let before = events.length

			await tests.run(registry, {
				sink: (event) => {
					if (
						event.kind === "run-start" ||
						event.kind === "run-end"
					) {
						return
					}

					events.push(event)
				},
				filters: { ids: [id], bench: false },
				snapshots: stores.snapshots,
				counterexamples: stores.counterexamples,
				seed: request.seed,
				...(request.cases === null ? {} : { cases: request.cases }),
			})

			if (
				events.slice(before).some((event) => event.kind === "test-fail")
			) {
				break
			}
		}

		return answer(events, null)
	} catch (error) {
		return answer([], rendered(error), phase)
	} finally {
		restore()
	}
}

function send(message: MutantWorkerResponse): void {
	parentPort?.postMessage(message)
}

// Requests are handled one at a time, in order, whatever the driver sends.
let queue: Promise<void> = Promise.resolve()

parentPort?.on("message", (request: MutantWorkerRequest) => {
	queue = queue
		.then(async () => {
			if (request.kind === "close") {
				parentPort?.close()

				return
			}

			if (request.kind === "init") {
				stores = {
					snapshots: request.snapshots,
					counterexamples: request.counterexamples,
				}

				return
			}

			send(await runMutant(request))
		})
		// A rejection is a `postMessage` that could not carry the answer. A
		// minimal answer carrying only the problem goes instead. If that fails
		// too, the driver's timeout and `exit` listener catch it.
		.catch((error: unknown) => {
			try {
				send({
					kind: "ran",
					id: request.kind === "run" ? request.id : -1,
					events: [],
					problem: rendered(error),
					phase: "answer",
					exhausted: true,
				})
			} catch {
				// No channel is left to report on.
			}
		})
})

send({ kind: "ready" })
