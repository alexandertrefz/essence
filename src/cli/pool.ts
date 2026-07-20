import { availableParallelism } from "node:os"
import { Worker } from "node:worker_threads"

import {
	type CompileOutcome,
	type CompileRequest,
	compileFile,
	type StageName,
} from "./pipeline"
import type { WorkerResponse } from "./worker"

// NOTE: Booting a worker and importing the Compiler into it costs roughly as
// much as compiling a small file, so workers are not always the faster choice.
// They are used when there is something to gain: several files to compile at
// once, a file large enough that the main thread would visibly stall, or a
// watch session, where the same warm workers are reused for every rebuild.
const MAX_WORKERS = 8
const LARGE_SOURCE_BYTES = 12 * 1024

export type CompileDispatcher = {
	compile: (
		request: CompileRequest,
		onStage?: (stage: StageName) => void,
	) => Promise<CompileOutcome>
	dispose: () => Promise<void>
	readonly size: number
}

export function defaultWorkerCount(fileCount: number): number {
	let cores = Math.max(1, availableParallelism() - 1)

	return Math.max(1, Math.min(fileCount, cores, MAX_WORKERS))
}

export function shouldUseWorkers(options: {
	fileCount: number
	totalBytes: number
	watch: boolean
	jobs: number | undefined
}): boolean {
	if (options.jobs === 1) {
		return false
	}

	return (
		options.fileCount > 1 ||
		options.watch ||
		options.totalBytes >= LARGE_SOURCE_BYTES
	)
}

// NOTE: The in-process dispatcher. It exists so that callers never branch on
// how a compilation is going to run — `--jobs 1` and a one-file build take the
// same path through the command implementations as a parallel build does.
export function createInlineDispatcher(): CompileDispatcher {
	return {
		compile: (request, onStage) => compileFile(request, onStage),
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

type Entry = {
	worker: Worker
	busy: boolean
	jobId: number | null
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
		diagnostics: [
			{
				severity: "error",
				message: `Internal Compiler error: ${
					error instanceof Error ? error.message : String(error)
				}`,
				position: null,
				code: "internal-error",
			},
		],
		timings: [],
		duration: 0,
		bytes: null,
		gzipBytes: null,
		failedStage: null,
		stack: error instanceof Error ? (error.stack ?? null) : null,
	}
}

export function createWorkerPool(size: number): CompileDispatcher {
	let workerURL = new URL("./worker.ts", import.meta.url)
	let entries: Array<Entry> = []
	let queue: Array<Job> = []
	let inFlight = new Map<number, Job>()
	let nextId = 0
	let disposed = false

	let spawn = (): Entry => {
		let worker = new Worker(workerURL)
		let entry: Entry = { worker, busy: false, jobId: null }

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
			entry.busy = false
			entry.jobId = null

			job?.resolve(message.outcome as CompileOutcome)
			pump()
		})

		// NOTE: A worker that dies takes its own job with it — and only its
		// own. The job it was running is completed as a failed compilation
		// rather than rejected, so that one dead worker reports one broken
		// file instead of failing every file that happened to be in flight.
		worker.on("error", (error) => {
			let id = entry.jobId

			if (id !== null) {
				let job = inFlight.get(id)

				inFlight.delete(id)
				job?.resolve(workerFailure(job.request, error))
			}

			entry.busy = false
			entry.jobId = null
			entries = entries.filter((candidate) => candidate !== entry)

			if (!disposed) {
				pump()
			}
		})

		worker.unref()
		entries.push(entry)

		return entry
	}

	let pump = (): void => {
		while (queue.length > 0) {
			let entry =
				entries.find((candidate) => !candidate.busy) ??
				(entries.length < size ? spawn() : undefined)

			if (entry === undefined) {
				return
			}

			let job = queue.shift() as Job
			let id = nextId++

			entry.busy = true
			entry.jobId = id
			inFlight.set(id, job)

			// NOTE: A worker is ref'd only while it is working, so that a
			// finished run exits immediately instead of waiting on idle
			// threads that will never receive another job.
			entry.worker.ref()
			entry.worker.postMessage({
				type: "compile",
				id,
				request: job.request,
			})
		}

		for (let entry of entries) {
			if (!entry.busy) {
				entry.worker.unref()
			}
		}
	}

	return {
		compile: (request, onStage) =>
			new Promise<CompileOutcome>((resolve) => {
				queue.push({ request, onStage, resolve })
				pump()
			}),
		dispose: async () => {
			disposed = true
			await Promise.all(entries.map((entry) => entry.worker.terminate()))
			entries = []
		},
		get size() {
			return size
		},
	}
}
