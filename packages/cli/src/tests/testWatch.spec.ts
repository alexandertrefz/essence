import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"

import type { TestEvent } from "@essence-lang/runtime/Testing"

import { createDependentsIndex, createSourceWatcher } from "../watcher"

// NOTE: The live half of `essence test`. The affected-set computation and the
// file watching are unit tested here because they are what "re-run only what a
// change reached" MEANS; the session itself is driven as a child process,
// because a watch never returns and every part of it — the debounce, the
// staging, the resolver — is a property of a whole process rather than of a
// function.

const essence = fileURLToPath(
	new URL("../../bin/essence", import.meta.url).href,
)

let bundleCache = mkdtempSync(path.join(tmpdir(), "essence-watch-cache-"))
let previousCache: string | undefined

beforeAll(() => {
	previousCache = process.env.ESSENCE_CLI_CACHE
	process.env.ESSENCE_CLI_CACHE = bundleCache
})

afterAll(() => {
	if (previousCache === undefined) {
		delete process.env.ESSENCE_CLI_CACHE
	} else {
		process.env.ESSENCE_CLI_CACHE = previousCache
	}

	rmSync(bundleCache, { recursive: true, force: true })
})

describe("The affected set", () => {
	it("wakes the entry a changed file sits in the graph of", () => {
		let dependents = createDependentsIndex()

		dependents.record("/project/A.es", ["/project/A.es", "/project/Lib.es"])
		dependents.record("/project/B.es", ["/project/B.es"])

		expect(dependents.entriesFor(["/project/Lib.es"])).toEqual([
			"/project/A.es",
		])
		expect(dependents.entriesFor(["/project/B.es"])).toEqual([
			"/project/B.es",
		])
	})

	it("wakes both entries a shared Module reaches", () => {
		let dependents = createDependentsIndex()

		dependents.record("/project/A.es", ["/project/A.es", "/project/Lib.es"])
		dependents.record("/project/B.es", ["/project/B.es", "/project/Lib.es"])

		expect(dependents.entriesFor(["/project/Lib.es"]).sort()).toEqual([
			"/project/A.es",
			"/project/B.es",
		])
	})

	it("says nothing about a file no entry reaches", () => {
		let dependents = createDependentsIndex()

		dependents.record("/project/A.es", ["/project/A.es"])

		expect(dependents.entriesFor(["/project/Elsewhere.es"])).toEqual([])
	})

	it("forgets a Module an import was deleted from", () => {
		let dependents = createDependentsIndex()

		dependents.record("/project/A.es", ["/project/A.es", "/project/Lib.es"])
		dependents.record("/project/A.es", ["/project/A.es"])

		expect(dependents.entriesFor(["/project/Lib.es"])).toEqual([])
	})

	it("keeps a Module the other entry still reaches", () => {
		let dependents = createDependentsIndex()

		dependents.record("/project/A.es", ["/project/A.es", "/project/Lib.es"])
		dependents.record("/project/B.es", ["/project/B.es", "/project/Lib.es"])
		dependents.record("/project/A.es", ["/project/A.es"])

		expect(dependents.entriesFor(["/project/Lib.es"])).toEqual([
			"/project/B.es",
		])
	})

	it("names the entry itself, resolved", () => {
		let dependents = createDependentsIndex()

		dependents.record("/project/A.es", [])

		expect(dependents.files()).toEqual(["/project/A.es"])
	})
})

describe("The source watcher", () => {
	it("reports a file that changed and not the ones that did not", async () => {
		let directory = mkdtempSync(path.join(tmpdir(), "essence-watcher-"))
		let changed = path.join(directory, "Changed.es")
		let still = path.join(directory, "Still.es")

		writeFileSync(changed, "one")
		writeFileSync(still, "one")

		let seen: Array<Array<string>> = []
		let watcher = createSourceWatcher({
			debounce: 10,
			onChange: (files) => seen.push(files),
		})

		try {
			await watcher.watch([changed, still])

			// NOTE: The signature is `mtimeMs:size`, so the text has to differ
			// in length for a save landing inside one millisecond to count.
			writeFileSync(changed, "one and a half")

			await new Promise((resolve) => setTimeout(resolve, 400))

			expect(seen).toEqual([[changed]])
		} finally {
			watcher.close()
			rmSync(directory, { recursive: true, force: true })
		}
	})

	it("reports activity where a file nobody watches appears", async () => {
		let directory = mkdtempSync(path.join(tmpdir(), "essence-watcher-"))
		let watched = path.join(directory, "Watched.es")

		writeFileSync(watched, "one")

		let activity = 0
		let watcher = createSourceWatcher({
			debounce: 10,
			onChange: () => {},
			onActivity: () => {
				activity += 1
			},
		})

		try {
			await watcher.watch([watched])
			writeFileSync(path.join(directory, "New.es"), "two")

			await new Promise((resolve) => setTimeout(resolve, 400))

			expect(activity).toBeGreaterThan(0)
		} finally {
			watcher.close()
			rmSync(directory, { recursive: true, force: true })
		}
	})

	it("says nothing once it is closed", async () => {
		let directory = mkdtempSync(path.join(tmpdir(), "essence-watcher-"))
		let watched = path.join(directory, "Watched.es")

		writeFileSync(watched, "one")

		let seen = 0
		let watcher = createSourceWatcher({
			debounce: 10,
			onChange: () => {
				seen += 1
			},
		})

		try {
			await watcher.watch([watched])
			watcher.close()
			writeFileSync(watched, "one and a half")

			await new Promise((resolve) => setTimeout(resolve, 300))

			expect(seen).toBe(0)
		} finally {
			rmSync(directory, { recursive: true, force: true })
		}
	})
})

// NOTE: One session driven as a child process, with `--json` so that what it
// did is readable rather than drawn. Every assertion waits for a NUMBER of
// completed runs rather than for a length of time: a compile takes as long as
// the machine takes, and a test that sleeps for it is a test that fails on a
// busy one.
type Session = {
	runs: () => Array<Array<TestEvent>>
	waitForRuns: (count: number) => Promise<Array<Array<TestEvent>>>
	// NOTE: Awaited rather than fired and forgotten. A watch session that
	// outlives its test goes on compiling in the background, and the suites
	// running after it are the ones that pay for it.
	stop: () => Promise<void>
}

function startSession(directory: string): Session {
	let child = Bun.spawn(
		[
			process.execPath,
			essence,
			"test",
			directory,
			"--watch",
			"--json",
			"--jobs",
			"1",
			"--no-color",
		],
		{ cwd: directory, stdout: "pipe", stderr: "pipe" },
	)
	let complete: Array<Array<TestEvent>> = []
	let current: Array<TestEvent> = []
	let buffered = ""
	let reader = child.stdout.getReader()

	void (async () => {
		while (true) {
			let { done, value } = await reader.read()

			if (done) {
				return
			}

			buffered += new TextDecoder().decode(value)

			let lines = buffered.split("\n")

			buffered = lines.pop() ?? ""

			for (let line of lines) {
				if (line.trim() === "") {
					continue
				}

				let event = JSON.parse(line) as TestEvent

				current.push(event)

				if (event.kind === "run-end") {
					complete.push(current)
					current = []
				}
			}
		}
	})()

	return {
		runs: () => complete,
		async waitForRuns(count: number): Promise<Array<Array<TestEvent>>> {
			let deadline = Date.now() + 30_000

			while (complete.length < count && Date.now() < deadline) {
				await new Promise((resolve) => setTimeout(resolve, 25))
			}

			return complete
		},
		async stop(): Promise<void> {
			child.kill()

			await child.exited
		},
	}
}

function namesOf(events: Array<TestEvent>): Array<string> {
	return events.flatMap((event) =>
		event.kind === "test-start" ? [event.name] : [],
	)
}

describe("essence test --watch", () => {
	const library = [
		"implementation {",
		"\tfunction double(_ value: Integer) -> Integer {",
		"\t\t<- value::multiply(with 2)",
		"\t}",
		"}",
		"",
		"export {",
		"\tdouble",
		"}",
		"",
	].join("\n")

	const reader = [
		"import {",
		'	double from "./Library.es"',
		"}",
		"",
		"tests {",
		'\ttest "doubles" {',
		"\t\texpect double(2)::is(4)",
		"\t}",
		"}",
		"",
	].join("\n")

	const other = [
		"tests {",
		'\ttest "adds" {',
		"\t\texpect 2::add(2)::is(4)",
		"\t}",
		"}",
		"",
	].join("\n")

	const reader2 = [
		"tests {",
		'\ttest "subtracts" {',
		"\t\texpect 4::subtract(2)::is(2)",
		"\t}",
		"}",
		"",
	].join("\n")

	async function withProject<Value>(
		files: Record<string, string>,
		body: (directory: string) => Promise<Value>,
	): Promise<Value> {
		let directory = mkdtempSync(path.join(tmpdir(), "essence-watch-"))

		try {
			for (let [fileName, source] of Object.entries(files)) {
				let filePath = path.join(directory, fileName)

				mkdirSync(path.dirname(filePath), { recursive: true })
				writeFileSync(filePath, source)
			}

			return await body(directory)
		} finally {
			rmSync(directory, { recursive: true, force: true })
		}
	}

	it("runs everything once, then re-runs only what a change reached", async () => {
		await withProject(
			{
				"Library.es": library,
				"Reader.tests.es": reader,
				"Other.tests.es": other,
			},
			async (directory) => {
				let session = startSession(directory)

				try {
					let [first] = await session.waitForRuns(1)

					expect(first).toBeDefined()
					expect(namesOf(first!).sort()).toEqual(["adds", "doubles"])

					// NOTE: A Module only the reader imports. What has to
					// happen is that the reader's test runs again and the
					// other file's does not.
					writeFileSync(
						path.join(directory, "Library.es"),
						library.replace("with 2", "with 2 "),
					)

					let runs = await session.waitForRuns(2)

					expect(runs).toHaveLength(2)
					expect(namesOf(runs[1]!)).toEqual(["doubles"])
				} finally {
					await session.stop()
				}
			},
		)
	}, 60_000)

	it("keeps the stream going and reports a test that started failing", async () => {
		await withProject({ "Other.tests.es": other }, async (directory) => {
			let session = startSession(directory)

			try {
				await session.waitForRuns(1)

				writeFileSync(
					path.join(directory, "Other.tests.es"),
					other.replace("::is(4)", "::is(5)"),
				)

				let runs = await session.waitForRuns(2)

				expect(runs).toHaveLength(2)
				expect(
					runs[1]!.some((event) => event.kind === "test-fail"),
				).toBe(true)
				expect(runs[1]!.at(-1)).toMatchObject({
					kind: "run-end",
					failed: 1,
				})
			} finally {
				await session.stop()
			}
		})
	}, 60_000)

	// NOTE: A focus silences every other test of the RUN, across files. So the
	// answer changing is the one edit whose consequences reach further than the
	// module graph does, and everything has to run again.
	it("re-runs everything when a focus appears", async () => {
		await withProject(
			{ "Other.tests.es": other, "More.tests.es": reader2 },
			async (directory) => {
				let session = startSession(directory)

				try {
					await session.waitForRuns(1)

					writeFileSync(
						path.join(directory, "Other.tests.es"),
						other.replace('"adds" {', '"adds" focused {'),
					)

					let runs = await session.waitForRuns(2)

					expect(runs).toHaveLength(2)
					expect(
						runs[1]!.filter(
							(event) => event.kind === "test-deselected",
						),
					).toHaveLength(1)
					expect(namesOf(runs[1]!)).toEqual(["adds"])
				} finally {
					await session.stop()
				}
			},
		)
	}, 60_000)

	it("picks up a tests file written while it watches", async () => {
		await withProject({ "Other.tests.es": other }, async (directory) => {
			let session = startSession(directory)

			try {
				await session.waitForRuns(1)

				writeFileSync(
					path.join(directory, "Late.tests.es"),
					other.replace('"adds"', '"adds late"'),
				)

				let runs = await session.waitForRuns(2)

				expect(runs).toHaveLength(2)
				expect(namesOf(runs[1]!)).toEqual(["adds late"])
			} finally {
				await session.stop()
			}
		})
	}, 60_000)
})
