import { availableParallelism } from "node:os"
import { Worker } from "node:worker_threads"

import { placelessDiagnostic } from "@essence-lang/compiler/diagnostics"

import {
	type CompileOutcome,
	type CompileRequest,
	compileFile,
	type StageName,
} from "./pipeline"
import {
	type CompileSession,
	createCompileSession,
	groupEntries,
} from "./session"
import type { WorkerResponse } from "./worker"

// NOTE: Booting a worker and importing the Compiler into it costs about twenty
// milliseconds of wall clock, so workers are only worth it where there is that
// much divisible work to put in front of them. How much a batch holds depends
// on what is being asked of it, and these are the crossovers measured on this
// repository's fixtures — min of five, twelve cores, warm standard library
// snapshot, empty bundle cache:
//
//   emitting    3 entries    5.0 kB   inline 168 ms   3 workers 178 ms
//               6 entries    2.4 kB   inline 201 ms   3 workers 196 ms
//               6 entries    9.4 kB   inline 233 ms   3 workers 205 ms
//              12 entries     23 kB   inline 335 ms   4 workers 271 ms
//              23 entries    133 kB   inline 663 ms   3 workers 496 ms
//   checking   12 entries    4.7 kB   inline  63 ms   3 workers  91 ms
//              23 entries    133 kB   inline 145 ms   2 workers 174 ms
//               3 entries    216 kB   inline 182 ms   3 workers 196 ms
//               6 entries    432 kB   inline 279 ms   2 workers 245 ms
//              12 entries    864 kB   inline 514 ms   2 workers 379 ms
//
// Emitting costs a fixed amount per ENTRY — one esbuild run, and the shared
// standard library prelude rewritten into each bundle — so what predicts the
// win is how many entries there are, and it arrives at about six whatever they
// weigh. Checking costs in proportion to how much source there is to enrich,
// and since the standard library stopped being enriched in every process there
// is very little left to divide: the win only arrives at a quarter of a
// megabyte of Essence, which is twice everything in this repository.
//
// NOTE: An emitting batch whose bundles are all in the cache costs what a check
// costs, and would rather have been left here — twenty-three entries take 153 ms
// on the main thread against 182 in four workers. Which of the two a build is
// can not be known before it is run: it is the hash of each linked graph that
// says so, and linking is the work itself. The cold answer is taken because the
// regret is not symmetric — 29 ms lost on a build that had nothing to do
// against 165 ms lost on one that did.
const PARALLEL_ENTRIES = 6
const PARALLEL_BYTES = 256 * 1024

// NOTE: Four, and not one per core. What a worker parallelises ends in esbuild,
// which runs threads of its own inside every one of them, so a fifth worker
// competes with the four already there rather than adding to them: twenty-three
// entries emit in 496 ms across three workers, 498 across four, 532 across six
// and 629 across eight — the eight-worker answer gives back more than the whole
// saving. Nothing about the sources moves this number either; every batch
// measured from six entries to twenty-three lands on three or four.
const MAX_WORKERS = 4

export type CompileDispatcher = {
	// NOTE: Every entry of one run, before any of them is compiled. A graph is
	// what a Module compiles as, and a graph is shared: the dispatcher has to
	// know the whole invocation to load each file once, and the whole
	// invocation is only known here.
	begin: (inputFileNames: Array<string>) => void
	compile: (
		request: CompileRequest,
		onStage?: (stage: StageName) => void,
	) => Promise<CompileOutcome>
	dispose: () => Promise<void>
	readonly size: number
}

// NOTE: The entry count is a ceiling rather than the number itself: a worker
// with no entry assigned to it is a thread booted to sit idle. What decides the
// rest is the cap above, which the measurements put ahead of anything derived
// from how much source there is.
export function defaultWorkerCount(fileCount: number): number {
	let cores = Math.max(1, availableParallelism() - 1)

	return Math.max(1, Math.min(fileCount, cores, MAX_WORKERS))
}

// NOTE: A watch session is not a case of its own. It used to be — warm workers
// were worth booting once and reusing — but a rebuild wakes only the entries
// whose graph the changed file sits in, which is nearly always one, and one
// entry has no second worker to give work to. Measured over a three-file watch,
// a rebuild takes 75 ms on the main thread and 76 ms in a warm worker.
export function shouldUseWorkers(options: {
	fileCount: number
	totalBytes: number
	emit: boolean
	jobs: number | undefined
}): boolean {
	// NOTE: An explicit `--jobs` is an answer rather than a hint — one job stays
	// here, more than one goes to workers whatever the batch looks like.
	// Otherwise there is no way to measure the choice made below against the one
	// it did not make.
	if (options.jobs !== undefined) {
		return options.jobs > 1
	}

	// NOTE: One entry is one graph and a graph is compiled by one worker, so
	// there is nothing for a second to do and the boot is paid for nothing. This
	// is what the byte threshold here used to be about: a single large file was
	// sent to a worker so that the main thread stayed free to draw the spinner,
	// which cost 30% of a check of that file and 12% of a build of it to keep an
	// animation moving.
	if (options.fileCount < 2) {
		return false
	}

	return options.emit
		? options.fileCount >= PARALLEL_ENTRIES
		: options.totalBytes >= PARALLEL_BYTES
}

// NOTE: The in-process dispatcher. It exists so that callers never branch on
// how a compilation is going to run — `--jobs 1` and a one-file build take the
// same path through the command implementations as a parallel build does.
//
// One Session per run, which is what makes a file that is both an entry and a
// dependency parsed and enriched exactly once in process.
export function createInlineDispatcher(): CompileDispatcher {
	let session: CompileSession = createCompileSession([])

	return {
		begin: (inputFileNames) => {
			session = createCompileSession(inputFileNames)
		},
		compile: (request, onStage) => compileFile(request, onStage, session),
		dispose: async () => {},
		size: 1,
	}
}

// NOTE: A Job only ever resolves. Every failure — including a worker dying
// mid-compilation — is expressed as a failed CompileOutcome, so that callers
// have exactly one shape to handle.
type Job = {
	request: CompileRequest
	onStage: ((stage: StageName) => void) | undefined
	resolve: (outcome: CompileOutcome) => void
}

// NOTE: One worker and the entries it was given. Workers share nothing, so a
// Module two of them reach is read and enriched in each — an accepted cost, and
// the reason the entries whose graphs overlap are handed to one of them.
type Slot = {
	worker: Worker | null
	busy: boolean
	jobId: number | null
	entries: Array<string>
}

// NOTE: A worker crash is a Compiler bug, and is reported the same way the
// in-process path reports one — as a failed compilation of the file that was
// being worked on, so that the surrounding batch still finishes and still
// reports every other file.
function workerFailure(
	request: CompileRequest,
	error: unknown,
): CompileOutcome {
	return {
		inputFileName: request.inputFileName,
		outputFileName: request.outputFileName,
		ok: false,
		sourceText: "",
		modules: [],
		diagnostics: [
			placelessDiagnostic(
				"error",
				`Internal Compiler error: ${
					error instanceof Error ? error.message : String(error)
				}`,
				"internal-error",
			),
		],
		timings: [],
		duration: 0,
		bytes: null,
		gzipBytes: null,
		failedStage: null,
		stack: error instanceof Error ? (error.stack ?? null) : null,
	}
}

// NOTE: The entry sets, largest first, into the least loaded slot. Which slot a
// set lands in decides nothing about the answer — only how much reading two
// workers do twice — so the greedy pass is chosen for how evenly it fills them.
function assignSlots(
	slots: Array<Slot>,
	active: number,
	groups: Array<Array<string>>,
): Map<string, number> {
	let assignment = new Map<string, number>()
	let counts: Array<number> = Array.from({ length: active }, () => 0)

	for (let slot of slots) {
		slot.entries = []
	}

	for (let group of [...groups].sort(
		(left, right) => right.length - left.length,
	)) {
		let index = counts.indexOf(Math.min(...counts))

		for (let fileName of group) {
			assignment.set(fileName, index)
			slots[index]?.entries.push(fileName)
		}

		counts[index] = (counts[index] as number) + group.length
	}

	return assignment
}

// NOTE: The worker is booted as whatever this module is running as — the
// TypeScript source under Bun in the workspace, the compiled JavaScript in the
// published package, where no `worker.ts` exists to boot. Exported for the
// spec: which file that is is a pure question, the Worker around it is not.
export function workerFileName(moduleURL: string): string {
	return moduleURL.endsWith(".ts") ? "./worker.ts" : "./worker.js"
}

export function createWorkerPool(size: number): CompileDispatcher {
	let workerURL = new URL(workerFileName(import.meta.url), import.meta.url)
	let slots: Array<Slot> = Array.from({ length: size }, () => ({
		worker: null,
		busy: false,
		jobId: null,
		entries: [],
	}))
	let assignment = new Map<string, number>()
	let queue: Array<Job> = []
	let inFlight = new Map<number, Job>()
	let active = size
	let nextId = 0
	let nextSlot = 0
	let disposed = false

	let spawn = (slot: Slot): Worker => {
		let worker = new Worker(workerURL)

		slot.worker = worker

		worker.on("message", (message: WorkerResponse) => {
			if (message.type === "progress") {
				inFlight.get(message.id)?.onStage?.(message.stage as StageName)

				return
			}

			if (message.type !== "result") {
				return
			}

			let job = inFlight.get(message.id)

			inFlight.delete(message.id)
			slot.busy = false
			slot.jobId = null

			job?.resolve(message.outcome as CompileOutcome)
			pump()
		})

		// NOTE: A worker that dies takes its own job with it — and only its
		// own. The job it was running is completed as a failed compilation
		// rather than rejected, so that one dead worker reports one broken
		// file instead of failing every file that happened to be in flight.
		worker.on("error", (error) => {
			let id = slot.jobId

			if (id !== null) {
				let job = inFlight.get(id)

				inFlight.delete(id)
				job?.resolve(workerFailure(job.request, error))
			}

			slot.busy = false
			slot.jobId = null
			slot.worker = null

			if (!disposed) {
				pump()
			}
		})

		worker.unref()
		worker.postMessage({ type: "begin", entries: slot.entries })

		return worker
	}

	// NOTE: A file the run was not planned with — nothing the CLI does today —
	// is spread over the slots rather than piled onto the first one.
	let slotIndexFor = (fileName: string): number => {
		let index = assignment.get(fileName)

		if (index !== undefined) {
			return index
		}

		index = nextSlot % active
		nextSlot += 1
		assignment.set(fileName, index)

		return index
	}

	let dispatch = (slot: Slot, job: Job): void => {
		let id = nextId++
		let worker = slot.worker ?? spawn(slot)

		slot.busy = true
		slot.jobId = id
		inFlight.set(id, job)

		// NOTE: A worker is ref'd only while it is working, so that a
		// finished run exits immediately instead of waiting on idle
		// threads that will never receive another job.
		worker.ref()
		worker.postMessage({ type: "compile", id, request: job.request })
	}

	// NOTE: The queue is scanned rather than shifted, because a file is pinned
	// to the slot holding the rest of its graph: taking only the head would let
	// one busy slot hold up every other slot's work.
	let pump = (): void => {
		while (queue.length > 0) {
			let index = queue.findIndex(
				(job) => !slots[slotIndexFor(job.request.inputFileName)]!.busy,
			)

			if (index === -1) {
				break
			}

			let job = queue.splice(index, 1)[0] as Job

			dispatch(
				slots[slotIndexFor(job.request.inputFileName)] as Slot,
				job,
			)
		}

		for (let slot of slots) {
			if (!slot.busy) {
				slot.worker?.unref()
			}
		}
	}

	return {
		begin: (inputFileNames) => {
			let groups = groupEntries(inputFileNames)

			active = Math.max(1, Math.min(size, groups.length))
			assignment = assignSlots(slots, active, groups)

			// NOTE: A worker that already ran carries the Session of the
			// previous run — a watch rebuild is a new run over new files, and
			// the graph it holds is the one that just changed.
			for (let slot of slots) {
				slot.worker?.postMessage({
					type: "begin",
					entries: slot.entries,
				})
			}
		},
		compile: (request, onStage) =>
			new Promise<CompileOutcome>((resolve) => {
				queue.push({ request, onStage, resolve })
				pump()
			}),
		dispose: async () => {
			disposed = true
			await Promise.all(
				slots.map(
					(slot) => slot.worker?.terminate() ?? Promise.resolve(),
				),
			)

			for (let slot of slots) {
				slot.worker = null
			}
		},
		get size() {
			return active
		},
	}
}
