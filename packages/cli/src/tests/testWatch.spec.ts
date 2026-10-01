import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import {
	mkdirSync,
	mkdtempSync,
	readdirSync,
	rmSync,
	writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"

import type { TestEvent } from "@essence-lang/runtime/Testing"

import { createDependentsIndex, createSourceWatcher } from "../watcher"

// The live half of `essence test`. The affected set and the file watching are
// unit tested. The session runs as a child process, since a watch never returns.

const essence = fileURLToPath(
	new URL("../../bin/essence", import.meta.url).href,
)

let bundleCache = mkdtempSync(path.join(tmpdir(), "essence-watch-cache-"))
// A watch session reads no result cache, but its children inherit this
// environment, so the variable points somewhere harmless.
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

// A report is waited for, never slept through: a busy machine delivers directory
// events late. The generous deadline is reached only when the watcher is wrong.
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

// Under the per-test budget `scripts/testBudget.ts` sets. A deadline firing after
// the test timed out would surface as a second, unattributed error.
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

			// The signature is `mtimeMs:size`, so the text changes length, in case the save
			// lands within one millisecond.
			writeFileSync(changed, "one and a half")

			await within(DEADLINE, arrived, "the change")

			// One more debounce window, so an unchanged file has every chance to be reported
			// wrongly. This wait can only fail a wrong watcher.
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

	// The timer covers events the platform never delivers. A silent directory
	// watcher stands in for that, so these prove the timer alone. See "Watching files"
	// in DEVELOPMENT.md.
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

	// An idle tick reports nothing, or a session would rebuild forever.
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

	// The timer closes with the watchers; `poll` is short, so a tick outliving
	// `close` is caught within the wait.
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

// One session as a child process, with `--json` so its runs are readable.
// Assertions wait for a number of completed runs, never for a length of time.
type Session = {
	pid: number
	runs: () => Array<Array<TestEvent>>
	waitForRuns: (count: number) => Promise<Array<Array<TestEvent>>>
	waitForEvent: (kind: TestEvent["kind"]) => Promise<boolean>
	// Awaited, so no session outlives its test and keeps compiling. One the signal
	// does not end in time is killed, and answers null.
	stop: (signal?: NodeJS.Signals) => Promise<number | null>
}

function startSession(
	directory: string,
	extra: Array<string> = [],
	environment: Record<string, string> = {},
): Session {
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
		{
			cwd: directory,
			env: { ...process.env, ...environment },
			stdout: "pipe",
			stderr: "pipe",
		},
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

	let seen = (kind: TestEvent["kind"]) =>
		[...complete.flat(), ...current].some((event) => event.kind === kind)

	return {
		pid: child.pid,
		runs: () => complete,
		async waitForRuns(count: number): Promise<Array<Array<TestEvent>>> {
			let deadline = Date.now() + 30_000

			while (complete.length < count && Date.now() < deadline) {
				await new Promise((resolve) => setTimeout(resolve, 25))
			}

			return complete
		},
		async waitForEvent(kind: TestEvent["kind"]): Promise<boolean> {
			let deadline = Date.now() + 30_000

			while (!seen(kind) && Date.now() < deadline) {
				await new Promise((resolve) => setTimeout(resolve, 25))
			}

			return seen(kind)
		},
		async stop(signal: NodeJS.Signals = "SIGTERM"): Promise<number | null> {
			child.kill(signal)

			// `exited` rather than `exitCode`, which is null for a process a signal ended.
			let code = await Promise.race([
				child.exited,
				new Promise<null>((resolve) =>
					setTimeout(() => resolve(null), 10_000),
				),
			])

			if (code === null) {
				child.kill("SIGKILL")
				await child.exited
			}

			return code
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
		'	from "./Library.es" { double }',
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

	const spinning = [
		"implementation {",
		"\tfunction spin(_ value: Integer) -> Integer {",
		"\t\tif value::isNegative() {",
		"\t\t\t<- value",
		"\t\t}",
		"",
		"\t\t<- spin(value::add(1))",
		"\t}",
		"}",
		"",
		"tests {",
		'\ttest "spins" {',
		"\t\texpect spin(1)::is(4)",
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

					// A Module only the reader imports, so only the reader's test reruns.
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

	// A focus silences every test of the run, across files, so a change in focus
	// reruns everything.
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

	// A watching coverage run carries only what each cycle reran, and an untouched
	// file's coverage stays in the report. A `Foo.tests.es` counts nothing itself:
	// coverage is about the implementation Modules its tests reach.
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
			'\tfrom "./Second.es" { triple }',
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

	// A session ends by signal as often as by keypress: SIGHUP from a closing
	// terminal, SIGTERM from a supervisor. It stages into this test's own directory.
	for (let [signal, status] of [
		["SIGTERM", 143],
		["SIGHUP", 129],
		["SIGINT", 130],
	] as const) {
		it(`removes its staging and exits ${status} when ${signal} ends it`, async () => {
			let temporary = mkdtempSync(
				path.join(tmpdir(), "essence-watch-temporary-"),
			)
			let staged = () =>
				readdirSync(temporary).filter((name) =>
					name.startsWith("essence-test-watch-"),
				)

			try {
				await withProject(
					{ "Other.tests.es": other },
					async (directory) => {
						let session = startSession(directory, [], {
							TMPDIR: temporary,
						})
						let runs = await session.waitForRuns(1)
						let during = staged()
						let code = await session.stop(signal)

						expect(runs).toHaveLength(1)
						expect(during).toHaveLength(1)
						expect(code).toBe(status)
						expect(staged()).toEqual([])
					},
				)
			} finally {
				rmSync(temporary, { recursive: true, force: true })
			}
		}, 60_000)
	}

	// The tests run on the session's own thread, and a handler waits for it.
	// So a test that never yields leaves a signal its default action, and the
	// next session sweeps what that leaves.
	it("stops on SIGTERM while a test spins, and the next session sweeps its staging", async () => {
		let temporary = mkdtempSync(
			path.join(tmpdir(), "essence-watch-temporary-"),
		)
		let staged = () =>
			readdirSync(temporary).filter((name) =>
				name.startsWith("essence-test-watch-"),
			)

		try {
			await withProject(
				{ "Spin.tests.es": spinning },
				async (directory) => {
					let session = startSession(directory, [], {
						TMPDIR: temporary,
					})
					let started = await session.waitForEvent("test-start")
					let code = await session.stop("SIGTERM")

					expect(started).toBe(true)
					expect(code).toBe(143)
					expect(staged()).toHaveLength(1)
				},
			)

			await withProject(
				{ "Other.tests.es": other },
				async (directory) => {
					let session = startSession(directory, [], {
						TMPDIR: temporary,
					})

					try {
						expect(await session.waitForRuns(1)).toHaveLength(1)
						expect(staged()).toEqual([
							expect.stringMatching(
								new RegExp(
									`^essence-test-watch-${session.pid}-`,
								),
							),
						])
					} finally {
						await session.stop()
					}
				},
			)
		} finally {
			rmSync(temporary, { recursive: true, force: true })
		}
	}, 60_000)
})
