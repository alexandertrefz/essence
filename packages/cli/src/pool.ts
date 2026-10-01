import { availableParallelism } from "node:os"
import { Worker } from "node:worker_threads"

import {
	type CompileMode,
	completeMode,
} from "@essence-lang/compiler/compileMode"
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
import type { WorkerRequest, WorkerResponse } from "./worker"

// When a batch is worth sending to workers: emitting by entry count, checking
// by source size. See "When compiles go to workers" in DEVELOPMENT.md.
const PARALLEL_ENTRIES = 6
const PARALLEL_BYTES = 256 * 1024

// Not one per core: esbuild runs threads of its own in every worker, so more
// workers compete rather than help.
const MAX_WORKERS = 4

export type CompileDispatcher = {
	// Every entry of one run, before any is compiled, so each shared file loads
	// once. The mode is the whole run's, since the Session is opened in it.
	begin: (inputFileNames: Array<string>, mode?: CompileMode) => void
	compile: (
		request: CompileRequest,
		onStage?: (stage: StageName) => void,
	) => Promise<CompileOutcome>
	dispose: () => Promise<void>
	readonly size: number
}

// Never more workers than entries, since an idle worker is a wasted boot, and
// never more than `MAX_WORKERS`.
export function defaultWorkerCount(fileCount: number): number {
	let cores = Math.max(1, availableParallelism() - 1)

	return Math.max(1, Math.min(fileCount, cores, MAX_WORKERS))
}

// A watch session needs no rule of its own: a rebuild nearly always wakes one
// entry, which one worker compiles.
export function shouldUseWorkers(options: {
	fileCount: number
	totalBytes: number
	emit: boolean
	jobs: number | undefined
}): boolean {
	// An explicit `--jobs` decides, so both choices can be measured.
	if (options.jobs !== undefined) {
		return options.jobs > 1
	}

	// One entry is one graph, which one worker compiles, so a worker only adds
	// its boot.
	if (options.fileCount < 2) {
		return false
	}

	return options.emit
		? options.fileCount >= PARALLEL_ENTRIES
		: options.totalBytes >= PARALLEL_BYTES
}

// The in-process dispatcher, so callers never branch on how a compile runs.
// One Session per run parses and enriches each file once.
export function createInlineDispatcher(): CompileDispatcher {
	let session: CompileSession = createCompileSession([])

	return {
		begin: (inputFileNames, mode) => {
			session = createCompileSession(inputFileNames, mode)
		},
		compile: (request, onStage) => compileFile(request, onStage, session),
		dispose: async () => {},
		size: 1,
	}
}

// A Job only ever resolves. Every failure, a dead worker included, is a failed
// `CompileOutcome`.
type Job = {
	request: CompileRequest
	onStage: ((stage: StageName) => void) | undefined
	resolve: (outcome: CompileOutcome) => void
}

// One worker and its entries. Workers share nothing, so entries whose graphs
// overlap go to one worker.
type Slot = {
	worker: Worker | null
	busy: boolean
	jobId: number | null
	entries: Array<string>
}

// A worker crash is a Compiler bug, reported as a failed compile of its file
// so the rest of the batch still finishes.
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
		cached: false,
	}
}

// Assigns the entry groups, largest first, to the least loaded slot. The
// assignment never changes a result, only how evenly the workers fill.
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

// A Worker's file in the shape the caller runs as: TypeScript source in the
// workspace, JavaScript in the published package. `moduleURL` is the caller's.
export function workerFileName(moduleURL: string, base = "worker"): string {
	return moduleURL.endsWith(".ts") ? `./${base}.ts` : `./${base}.js`
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
	// The run's mode, kept because a worker boots on its first job, after
	// `begin` has passed.
	let mode = completeMode()

	// Tells a worker its run, from `begin` for running workers and from `spawn`
	// for later ones. `WorkerRequest` requires every mode facet.
	let beginMessage = (slot: Slot): WorkerRequest => ({
		type: "begin",
		entries: slot.entries,
		...mode,
	})

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

		// A dead worker fails only its own job, as a failed compile.
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
		worker.postMessage(beginMessage(slot))

		return worker
	}

	// A file the run was not begun with is spread over the slots.
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

		// Only a working worker is ref'd, so a finished run exits at once.
		worker.ref()
		worker.postMessage({ type: "compile", id, request: job.request })
	}

	// Scanned rather than shifted: a file is pinned to its graph's slot, so a
	// busy slot must not hold up the others.
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
		begin: (inputFileNames, begun) => {
			let groups = groupEntries(inputFileNames)

			active = Math.max(1, Math.min(size, groups.length))
			assignment = assignSlots(slots, active, groups)
			mode = completeMode(begun)

			// A running worker holds the last run's Session, which a new run
			// replaces.
			for (let slot of slots) {
				slot.worker?.postMessage(beginMessage(slot))
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
