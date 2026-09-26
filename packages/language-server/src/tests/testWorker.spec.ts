import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import * as path from "node:path"
import { fileURLToPath } from "node:url"
import { Worker } from "node:worker_threads"

import { canonicalPath } from "@essence-lang/compiler/documents"

import type { TestWorkerRequest, TestWorkerResponse } from "../testProtocol"

// NOTE: The Worker driven over its own messages without a session, so a spec
// can hand it more cycles than a debounced session would start in a test's time.

// NOTE: The Worker's `BUNDLE_LIMIT`.
const bundleLimit = 128

let root: string
let file: string

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
	let worker = new Worker(
		fileURLToPath(new URL("../testWorker.ts", import.meta.url)),
		{
			stdout: true,
			stderr: true,
			// NOTE: The Worker never removes its staging directory, so it is
			// put under `root`, which this spec does remove.
			env: { ...process.env, TMPDIR: root },
		},
	)
	let cycles: Array<Cycle> = []
	let passed = 0

	try {
		await new Promise<void>((resolve, reject) => {
			worker.on("error", reject)
			worker.on("message", (message: TestWorkerResponse) => {
				if (message.kind === "ready") {
					for (let [index, text] of sources.entries()) {
						let request: TestWorkerRequest = {
							kind: "run",
							run: index + 1,
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

						worker.postMessage(request)
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
