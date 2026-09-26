import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import * as path from "node:path"
import { fileURLToPath } from "node:url"
import { Worker } from "node:worker_threads"

import { canonicalPath } from "@essence-lang/compiler/documents"
import { spawnAndWait } from "@essence-lang/fixtures/spawn"

import type {
	TestWorkerData,
	TestWorkerRequest,
	TestWorkerResponse,
} from "../testProtocol"

// NOTE: The Worker driven over its own messages without a session, so a spec
// can hand it more cycles than a debounced session would start in a test's time.

// NOTE: The Worker's `BUNDLE_LIMIT`.
const bundleLimit = 128

const workerPath = fileURLToPath(new URL("../testWorker.ts", import.meta.url))

let root: string
let file: string
let workers = 0

function source(value: number): string {
	return [
		"tests {",
		'\ttest "holds" {',
		`\t\texpect ${value}::is(${value})`,
		"\t}",
		"}",
		"",
	].join("\n")
}

function runRequest(run: number, text: string): TestWorkerRequest {
	return {
		kind: "run",
		run,
		entries: [
			{
				filePath: file,
				skipTags: [],
				contracts: false,
			},
		],
		overlays: { [file]: text },
		filters: {},
		ids: [],
		update: false,
		coverage: false,
	}
}

// NOTE: Under `root`, which this spec removes. A session names one per Worker
// the same way.
function stagingDirectory(): string {
	workers += 1

	return path.join(root, `staging-${workers}`)
}

beforeAll(() => {
	root = canonicalPath(mkdtempSync(path.join(tmpdir(), "essence-worker-")))
	file = path.join(root, "Probe.tests.es")

	writeFileSync(file, source(0))
})

afterAll(() => {
	rmSync(root, { recursive: true, force: true })
})

type Cycle = { exhausted: boolean; passed: number }

// NOTE: One run per source, each handing the Worker the whole buffer of the
// same file. The Worker answers them in the order they were sent.
async function runEach(sources: Array<string>): Promise<Array<Cycle>> {
	let worker = new Worker(workerPath, {
		stdout: true,
		stderr: true,
		workerData: { staging: stagingDirectory() } satisfies TestWorkerData,
	})
	let cycles: Array<Cycle> = []
	let passed = 0

	try {
		await new Promise<void>((resolve, reject) => {
			worker.on("error", reject)
			worker.on("message", (message: TestWorkerResponse) => {
				if (message.kind === "ready") {
					for (let [index, text] of sources.entries()) {
						worker.postMessage(runRequest(index + 1, text))
					}
				} else if (message.kind === "entry") {
					passed += message.events.filter(
						(event) => event.kind === "test-pass",
					).length
				} else {
					cycles.push({ exhausted: message.exhausted, passed })
					passed = 0

					if (cycles.length === sources.length) {
						resolve()
					}
				}
			})
		})
	} finally {
		await worker.terminate()
	}

	return cycles
}

describe("The test Worker's bundle limit", () => {
	it("does not count a bundle it runs again", async () => {
		let cycles = await runEach(
			Array.from({ length: bundleLimit + 1 }, () => source(1)),
		)

		expect(cycles.filter((cycle) => cycle.passed !== 1)).toEqual([])
		expect(cycles.findIndex((cycle) => cycle.exhausted)).toBe(-1)
	})

	it("asks to be replaced once it has loaded its limit of distinct bundles", async () => {
		let cycles = await runEach(
			Array.from({ length: bundleLimit }, (_, index) => source(index)),
		)

		expect(cycles.filter((cycle) => cycle.passed !== 1)).toEqual([])
		expect(cycles.findIndex((cycle) => cycle.exhausted)).toBe(
			bundleLimit - 1,
		)
	})
})

describe("The test Worker's staging directory", () => {
	it("stages in the directory it was handed and removes it once told to close", async () => {
		let staging = stagingDirectory()
		let worker = new Worker(workerPath, {
			stdout: true,
			stderr: true,
			workerData: { staging } satisfies TestWorkerData,
		})
		let stagedWhileRunning = false

		try {
			await new Promise<void>((resolve, reject) => {
				worker.on("error", reject)
				worker.on("exit", () => resolve())
				worker.on("message", (message: TestWorkerResponse) => {
					if (message.kind === "ready") {
						worker.postMessage(runRequest(1, source(1)))
					} else if (message.kind === "done") {
						stagedWhileRunning = existsSync(staging)
						worker.postMessage({
							kind: "close",
						} satisfies TestWorkerRequest)
					}
				})
			})
		} finally {
			await worker.terminate()
		}

		expect(stagedWhileRunning).toBe(true)
		expect(existsSync(staging)).toBe(false)
	})
})

// NOTE: In a child of its own, because a process's input is the one thing a
// spec can not choose for itself. Over stdio it is the Server's LSP stream.
describe("The test Worker's input", () => {
	const readsAtLoad = [
		"implementation {",
		'\tconstant team = Terminal.readLine()::value(defaultingTo "nobody")',
		"}",
		"",
		"tests {",
		'\ttest "read {team}" {',
		'\t\texpect team::is("nobody")',
		"\t}",
		"}",
		"",
	].join("\n")

	it("hands a Module that reads as it loads an empty input, whatever its process was piped", async () => {
		let driver = [
			'let { Worker } = await import("node:worker_threads")',
			`let worker = new Worker(${JSON.stringify(workerPath)}, {`,
			"\tstdout: true,",
			"\tstderr: true,",
			`\tworkerData: ${JSON.stringify({ staging: stagingDirectory() })},`,
			"})",
			'worker.on("message", (message) => {',
			'\tif (message.kind === "ready") {',
			`\t\tworker.postMessage(${JSON.stringify(runRequest(1, readsAtLoad))})`,
			'\t} else if (message.kind === "entry") {',
			"\t\tconsole.log(JSON.stringify(message.events.flatMap((event) =>",
			'\t\t\tevent.kind === "test-pass" || event.kind === "test-fail"',
			"\t\t\t\t? [`${event.kind} ${event.name}`]",
			"\t\t\t\t: [],",
			"\t\t)))",
			'\t} else if (message.kind === "done") {',
			"\t\tvoid worker.terminate()",
			"\t}",
			"})",
		].join("\n")
		let result = await spawnAndWait([process.execPath, "--eval", driver], {
			input: "Tigers\n",
			deadline: 30_000,
		})

		expect(result.stdout.trim()).toBe(
			JSON.stringify(["test-pass read nobody"]),
		)
		expect(result.code).toBe(0)
	}, 40_000)
})
