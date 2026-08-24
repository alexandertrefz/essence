import { pathToFileURL } from "node:url"
import { format } from "node:util"
import { parentPort } from "node:worker_threads"

import type { CorpusStore, SnapshotStore } from "@essence-lang/compiler/testing"
import type { entryPoints, TestEvent } from "@essence-lang/runtime/Testing"

// NOTE: Where a MUTANT runs, and the one piece of machinery `--mutate` needed
// that nothing else in the CLI had. A mutation run compiles hundreds of
// bundles, and a bundle is a Module: `import()` can never unload one, so a run
// that loaded them all into the command line's own process would grow a module
// cache the length of the run and never give any of it back. The Language
// Server met this exact problem with an editing session's saves and solved it
// the same way — see `packages/language-server/src/testWorker.ts`, whose
// `BUNDLE_LIMIT` this is the sibling of.
//
// NOTE: The Worker does not COMPILE. That is the pool's, which is warm and
// parallel and already holds the Session every mutant is compiled through; what
// crosses to here is a path and what crosses back is events, which are plain
// data. A value an Essence Program built carries a hidden Type key that is a
// `Symbol` of the runtime instance that built it, so nothing but events could
// cross anyway.
//
// NOTE: This file is a Worker ENTRY: it starts listening the moment it is
// loaded, exactly as `worker.ts` beside it does.

// NOTE: How many distinct bundles one Worker loads before the driver is told to
// start another. Half the Language Server's, because a mutation run reaches the
// number in seconds rather than over an editing session, and a recycled Worker
// costs one thread boot.
const BUNDLE_LIMIT = 64

type TestEntryPoints = typeof entryPoints
type LoadedTestBundle = { $tests?: TestEntryPoints }

export type MutantWorkerRequest =
	| {
			kind: "run"
			// NOTE: Which request this answer belongs to. A driver runs one
			// mutant at a time, and the id is what makes that a fact the
			// protocol states rather than one it relies on.
			id: number
			// NOTE: A bundle emitted into a directory of its own. Bun's resolver
			// remembers what a directory held the first time it read anything
			// out of it, so a second bundle written beside the first is
			// invisible to `import()` — the mutant loop emits each one into a
			// fresh directory rather than staging a copy of it afterwards.
			bundle: string
			// NOTE: The tests that REACH the site, by id, run one at a time so
			// that the Worker stops at the first kill. Everything else in the
			// bundle is deselected by the same selection they go through.
			ids: Array<string>
			// NOTE: The run's one pinned seed, so a property test in the
			// covering set draws exactly what it drew for the baseline. Without
			// it a mutant would be judged by a different search than the one
			// that established the baseline was green.
			seed: string
			cases: number | null
			// NOTE: Read off disk by the driver, because a bundle reads nothing.
			snapshots: Record<string, SnapshotStore>
			counterexamples: Record<string, CorpusStore>
	  }
	| { kind: "close" }

export type MutantWorkerResponse =
	| { kind: "ready" }
	| {
			kind: "ran"
			id: number
			// NOTE: Everything the covering tests wrote, whole. The driver folds
			// them: a `test-fail` among them is the kill, and the first one is
			// the killer.
			events: Array<TestEvent>
			// NOTE: Why there is no answer, when there is none — a bundle that
			// would not load, a runner that threw. It is not a kill: nothing was
			// learnt about the code.
			problem: string | null
			// NOTE: Whether this Worker has loaded its last bundle. The driver
			// terminates it and boots another rather than waiting to be told
			// twice.
			exhausted: boolean
	  }

let loaded = 0

function rendered(error: unknown): string {
	return error instanceof Error
		? (error.stack ?? error.message)
		: String(error)
}

// NOTE: A mutant's Modules are evaluated as the bundle loads, and a Module's
// own top-level `Terminal.print` writes as they are. It belongs to nobody —
// there is no test running — and under `--json` the parent's stdout carries the
// event stream and nothing else, so it goes to stderr for the length of the
// run. `console.log` is pointed there too: under Bun it writes to the file
// descriptor directly and never through `process.stdout.write`.
function redirectStdout(): () => void {
	let original = process.stdout.write
	let log = console.log

	process.stdout.write = ((
		chunk: string | Uint8Array,
		...rest: Array<unknown>
	) =>
		(
			process.stderr.write as unknown as (
				value: string | Uint8Array,
				...args: Array<unknown>
			) => boolean
		)(chunk, ...rest)) as typeof process.stdout.write

	console.log = ((...values: Array<unknown>) => {
		process.stderr.write(`${format(...values)}\n`)
	}) as typeof console.log

	return () => {
		process.stdout.write = original
		console.log = log
	}
}

async function runMutant(
	request: Extract<MutantWorkerRequest, { kind: "run" }>,
): Promise<MutantWorkerResponse> {
	let answer = (
		events: Array<TestEvent>,
		problem: string | null,
	): MutantWorkerResponse => ({
		kind: "ran",
		id: request.id,
		events,
		problem,
		exhausted: loaded >= BUNDLE_LIMIT,
	})
	let restore = redirectStdout()

	try {
		let module = (await import(
			pathToFileURL(request.bundle).href
		)) as LoadedTestBundle
		let tests = module.$tests

		loaded += 1

		// NOTE: A mutant of a Module with no tests in the graph at all. It is
		// not a kill and not a failure — there was nothing to ask.
		if (tests === undefined) {
			return answer([], null)
		}

		let registry = tests.registry()
		let events: Array<TestEvent> = []

		// NOTE: One test per call, in the order the driver named them, so the
		// Worker STOPS at the first kill. Everything after a failure would be
		// evidence for a verdict already reached, and a mutant covered by
		// twenty tests is usually killed by the first.
		for (let id of request.ids) {
			let before = events.length

			tests.run(registry, {
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
				snapshots: request.snapshots,
				counterexamples: request.counterexamples,
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
		return answer([], rendered(error))
	} finally {
		restore()
	}
}

function send(message: MutantWorkerResponse): void {
	parentPort?.postMessage(message)
}

// NOTE: One request at a time, in the order they arrived. The driver never has
// two mutants in flight — a mutant is compiled, run and judged before the next
// one is compiled — and a queue is what makes that a property of this file
// rather than a promise the driver keeps.
let queue: Promise<void> = Promise.resolve()

parentPort?.on("message", (request: MutantWorkerRequest) => {
	queue = queue
		.then(async () => {
			if (request.kind === "close") {
				parentPort?.close()

				return
			}

			send(await runMutant(request))
		})
		.catch(() => {})
})

send({ kind: "ready" })
