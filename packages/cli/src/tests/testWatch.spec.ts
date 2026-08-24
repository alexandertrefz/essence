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
// NOTE: A watching session reads no result cache — it holds the bundles it has
// already loaded — but the sessions here are CHILD processes and inherit this
// environment, so the variable is pointed somewhere harmless all the same.
let resultCache = mkdtempSync(path.join(tmpdir(), "essence-watch-results-"))
let previousCache: string | undefined
let previousResults: string | undefined

beforeAll(() => {
	previousCache = process.env.ESSENCE_CLI_CACHE
	previousResults = process.env.ESSENCE_RESULTS_CACHE
	process.env.ESSENCE_CLI_CACHE = bundleCache
	process.env.ESSENCE_RESULTS_CACHE = resultCache
})

afterAll(() => {
	if (previousCache === undefined) {
		delete process.env.ESSENCE_CLI_CACHE
	} else {
		process.env.ESSENCE_CLI_CACHE = previousCache
	}

	if (previousResults === undefined) {
		delete process.env.ESSENCE_RESULTS_CACHE
	} else {
		process.env.ESSENCE_RESULTS_CACHE = previousResults
	}

	rmSync(bundleCache, { recursive: true, force: true })
	rmSync(resultCache, { recursive: true, force: true })
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

// NOTE: A report is WAITED FOR, never slept through. The platform delivers a
// directory event when it delivers it: on an idle machine that is a few
// milliseconds, and on one running three test suites at once it was measured
// past the 400 ms these tests once slept — so they failed while the watcher
// was right. A deadline is the only timing left, and it is generous, because
// it is only ever reached when the watcher is wrong.
function arrival(): { arrived: Promise<void>; arrive: () => void } {
	let arrive = (): void => {}
	let arrived = new Promise<void>((resolve) => {
		arrive = resolve
	})

	return { arrived, arrive }
}

function within(
	deadline: number,
	arrived: Promise<void>,
	what: string,
): Promise<void> {
	return new Promise((resolve, reject) => {
		let timer = setTimeout(() => {
			reject(new Error(`${what} did not arrive within ${deadline} ms`))
		}, deadline)

		void arrived.then(() => {
			clearTimeout(timer)
			resolve()
		})
	})
}

// NOTE: Under bun's own per-test timeout of five seconds, and deliberately so.
// A deadline that fires AFTER the test has already timed out rejects a Promise
// nobody is waiting on any more, which bun reports as an "unhandled error
// between tests" — a second failure, unattributed, for the price of one.
const DEADLINE = 4000

describe("The source watcher", () => {
	it("reports a file that changed and not the ones that did not", async () => {
		let directory = mkdtempSync(path.join(tmpdir(), "essence-watcher-"))
		let changed = path.join(directory, "Changed.es")
		let still = path.join(directory, "Still.es")

		writeFileSync(changed, "one")
		writeFileSync(still, "one")

		let seen: Array<Array<string>> = []
		let { arrived, arrive } = arrival()
		let watcher = createSourceWatcher({
			debounce: 10,
			onChange: (files) => {
				seen.push(files)
				arrive()
			},
		})

		try {
			await watcher.watch([changed, still])

			// NOTE: The signature is `mtimeMs:size`, so the text has to differ
			// in length for a save landing inside one millisecond to count.
			writeFileSync(changed, "one and a half")

			await within(DEADLINE, arrived, "the change")

			// NOTE: One more debounce window, so that a file that did NOT
			// change has had every chance to be reported wrongly. This wait
			// can only make the test fail for a watcher that is wrong, never
			// for a machine that is slow.
			await new Promise((resolve) => setTimeout(resolve, 50))

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
		let { arrived, arrive } = arrival()
		let watcher = createSourceWatcher({
			debounce: 10,
			onChange: () => {},
			onActivity: () => {
				activity += 1
				arrive()
			},
		})

		try {
			await watcher.watch([watched])
			writeFileSync(path.join(directory, "New.es"), "two")

			await within(DEADLINE, arrived, "the activity")

			expect(activity).toBeGreaterThan(0)
		} finally {
			watcher.close()
			rmSync(directory, { recursive: true, force: true })
		}
	})

	// NOTE: The timer is the fallback for an event the platform never delivers
	// — measured, not imagined; see the NOTE atop watcher.ts. A directory
	// watcher that reports nothing stands in for that platform here, so what
	// these two prove is the timer on its own.
	const silent = (): { close(): void; on(): void } => ({
		close() {},
		on() {},
	})

	it("finds a change its directory watcher never reported", async () => {
		let directory = mkdtempSync(path.join(tmpdir(), "essence-watcher-"))
		let changed = path.join(directory, "Changed.es")

		writeFileSync(changed, "one")

		let seen: Array<Array<string>> = []
		let { arrived, arrive } = arrival()
		let watcher = createSourceWatcher({
			debounce: 10,
			poll: 50,
			watchDirectory: silent,
			onChange: (files) => {
				seen.push(files)
				arrive()
			},
		})

		try {
			await watcher.watch([changed])
			writeFileSync(changed, "one and a half")

			await within(DEADLINE, arrived, "the change")

			expect(seen).toEqual([[changed]])
		} finally {
			watcher.close()
			rmSync(directory, { recursive: true, force: true })
		}
	})

	it("finds a file that appeared without its directory watcher saying so", async () => {
		let directory = mkdtempSync(path.join(tmpdir(), "essence-watcher-"))
		let watched = path.join(directory, "Watched.es")

		writeFileSync(watched, "one")

		let activity = 0
		let { arrived, arrive } = arrival()
		let watcher = createSourceWatcher({
			debounce: 10,
			poll: 50,
			watchDirectory: silent,
			onChange: () => {},
			onActivity: () => {
				activity += 1
				arrive()
			},
		})

		try {
			await watcher.watch([watched])
			writeFileSync(path.join(directory, "New.es"), "two")

			await within(DEADLINE, arrived, "the activity")

			expect(activity).toBeGreaterThan(0)
		} finally {
			watcher.close()
			rmSync(directory, { recursive: true, force: true })
		}
	})

	// NOTE: An idle tick must report nothing: a session that heard "something
	// happened" every half second would rebuild for ever.
	it("says nothing from a tick where nothing changed", async () => {
		let directory = mkdtempSync(path.join(tmpdir(), "essence-watcher-"))
		let watched = path.join(directory, "Watched.es")

		writeFileSync(watched, "one")

		let activity = 0
		let watcher = createSourceWatcher({
			debounce: 10,
			poll: 20,
			watchDirectory: silent,
			onChange: () => {},
			onActivity: () => {
				activity += 1
			},
		})

		try {
			await watcher.watch([watched])

			await new Promise((resolve) => setTimeout(resolve, 200))

			expect(activity).toBe(0)
		} finally {
			watcher.close()
			rmSync(directory, { recursive: true, force: true })
		}
	})

	// NOTE: The timer is closed with the watchers; `poll` is short here so a
	// tick that outlived `close` would be caught inside the wait.
	it("says nothing once it is closed", async () => {
		let directory = mkdtempSync(path.join(tmpdir(), "essence-watcher-"))
		let watched = path.join(directory, "Watched.es")

		writeFileSync(watched, "one")

		let seen = 0
		let watcher = createSourceWatcher({
			debounce: 10,
			poll: 20,
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

function startSession(directory: string, extra: Array<string> = []): Session {
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
			...extra,
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

	// NOTE: A watching coverage run is incremental for free — an entry nothing
	// reached keeps the events it had, coverage among them — so what is worth
	// pinning is exactly that: the cycle carries only what it re-ran, and the
	// file it did not touch is still in the picture the report draws.
	//
	// NOTE: A `Foo.tests.es` of imports and tests has nothing to count and
	// reports nothing; what a coverage run is ABOUT is the implementation
	// Modules its tests reach.
	it("counts only the files a cycle re-ran", async () => {
		const second = [
			"implementation {",
			"\tfunction triple(_ value: Integer) -> Integer {",
			"\t\t<- value::multiply(with 3)",
			"\t}",
			"}",
			"",
			"export {",
			"\ttriple",
			"}",
			"",
		].join("\n")
		const secondReader = [
			"import {",
			'\ttriple from "./Second.es"',
			"}",
			"",
			"tests {",
			'\ttest "triples" {',
			"\t\texpect triple(2)::is(6)",
			"\t}",
			"}",
			"",
		].join("\n")

		await withProject(
			{
				"Library.es": library,
				"Reader.tests.es": reader,
				"Second.es": second,
				"Second.tests.es": secondReader,
			},
			async (directory) => {
				let session = startSession(directory, ["--coverage"])

				try {
					let [first] = await session.waitForRuns(1)
					let covered = (events: Array<TestEvent>) =>
						events.flatMap((event) =>
							event.kind === "coverage" && event.module !== null
								? [path.basename(event.module)]
								: [],
						)

					expect(covered(first!).sort()).toEqual([
						"Library.es",
						"Second.es",
					])

					writeFileSync(
						path.join(directory, "Second.tests.es"),
						secondReader.replace('"triples"', '"triples it"'),
					)

					let runs = await session.waitForRuns(2)

					expect(covered(runs[1]!)).toEqual(["Second.es"])
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
