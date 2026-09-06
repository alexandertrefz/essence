import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import {
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import * as path from "node:path"

import { canonicalPath } from "@essence-lang/compiler/documents"

import { TEST_RUN_VERSION, type TestRunNotification } from "../testProtocol"
import { createTestSession, type TestSession } from "../testSession"

// NOTE: The live session, driven without an Editor: the Workspace's answers are
// handed in as functions, so what is under test is the session's own rules —
// which files a change reaches, what it re-runs, and what it tells a client.
// The Worker it starts is the real one, because compiling and running is the
// half that can not be faked and still mean anything.

const passing = [
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
	"tests {",
	'\ttest "doubles" {',
	"\t\tconstant doubled = double(2)",
	"",
	"\t\texpect doubled::is(4)",
	"\t}",
	"}",
	"",
].join("\n")

const reader = [
	"import {",
	'\tfrom "./Library.es" { double }',
	"}",
	"",
	"tests {",
	'\ttest "reads" {',
	"\t\texpect double(3)::is(6)",
	"\t}",
	"}",
	"",
].join("\n")

const tagged = [
	"tests {",
	'\tsuite "slow things" tagged slow {',
	'\t\ttest "waits" {',
	"\t\t\texpect true",
	"\t\t}",
	"\t}",
	"",
	'\ttest "is quick" {',
	"\t\texpect true",
	"\t}",
	"}",
	"",
].join("\n")

let root: string
let library: string
let readerFile: string
let taggedFile: string

beforeAll(() => {
	root = canonicalPath(mkdtempSync(path.join(tmpdir(), "essence-session-")))
	library = path.join(root, "Library.es")
	readerFile = path.join(root, "Reader.tests.es")
	taggedFile = path.join(root, "Tagged.tests.es")

	mkdirSync(root, { recursive: true })
	writeFileSync(library, passing)
	writeFileSync(readerFile, reader)
	writeFileSync(taggedFile, tagged)
})

afterAll(() => {
	rmSync(root, { recursive: true, force: true })
})

type Harness = {
	session: TestSession
	notifications: Array<TestRunNotification>
	results: Array<Array<string>>
	overlays: Record<string, string>
	problems: Array<string>
	waitForRuns: (count: number) => Promise<void>
}

function harness(
	options: { debounce?: number; files?: Array<string> } = {},
): Harness {
	let files = options.files ?? [library, readerFile]
	let notifications: Array<TestRunNotification> = []
	let results: Array<Array<string>> = []
	let overlays: Record<string, string> = {}
	let problems: Array<string> = []
	let session = createTestSession({
		onProblem: (filePath, problem) =>
			problems.push(`${filePath}: ${problem}`),
		testFiles: () => files,
		// NOTE: The Workspace answers with the file itself and everything that
		// imports it; here the one import in the fixture is spelled out.
		dependentsOf: (filePath) =>
			filePath === library ? [library, readerFile] : [filePath],
		overlays: () => overlays,
		notify: (notification) => notifications.push(notification),
		onResults: (files) => results.push(files),
		debounce: options.debounce ?? 20,
	})

	return {
		session,
		notifications,
		results,
		overlays,
		problems,
		async waitForRuns(count: number): Promise<void> {
			let deadline = Date.now() + 30_000
			let ended = () =>
				notifications.filter(
					(notification) => notification.kind === "end",
				).length

			while (ended() < count && Date.now() < deadline) {
				await new Promise((resolve) => setTimeout(resolve, 25))
			}
		},
	}
}

// NOTE: The one failure the Worker exists for. A test that loops for ever can
// not be ended from inside the run — only the Worker can be taken away — and a
// session that waited on one would never run another test, because a request
// arriving while a run is in flight is remembered rather than started.
describe("A session whose run never ends", () => {
	const endless = [
		"implementation {",
		"\tfunction forever(_ n: Integer) -> Integer {",
		"\t\t<- forever(n::add(1))",
		"\t}",
		"}",
		"",
		"tests {",
		'\ttest "never ends" {',
		"\t\texpect forever(0)::isGreaterThan(0)",
		"\t}",
		"}",
		"",
	].join("\n")

	const quick = [
		"tests {",
		'\ttest "ends" {',
		"\t\texpect true",
		"\t}",
		"}",
		"",
	].join("\n")

	it("stops it, says why, and runs the next one", async () => {
		let file = path.join(root, "Endless.tests.es")

		writeFileSync(file, endless)

		let problems: Array<string> = []
		let notifications: Array<TestRunNotification> = []
		let session = createTestSession({
			testFiles: () => [file],
			dependentsOf: (filePath) => [filePath],
			overlays: () => ({}),
			notify: (notification) => notifications.push(notification),
			onResults: () => {},
			onProblem: (_, problem) => problems.push(problem),
			debounce: 20,
			deadline: 3_000,
		})
		let ended = () =>
			notifications.filter((notification) => notification.kind === "end")
				.length
		let waitFor = async (count: number): Promise<void> => {
			let until = Date.now() + 30_000

			while (ended() < count && Date.now() < until) {
				await new Promise((resolve) => setTimeout(resolve, 25))
			}
		}

		try {
			session.run({ files: [file] })

			await waitFor(1)

			expect(problems.join("\n")).toContain("did not finish")

			// NOTE: And the session is still a session. Nothing about the run
			// that was stopped is held against the next one.
			writeFileSync(file, quick)
			session.run({ files: [file] })

			await waitFor(2)

			expect(ended()).toBe(2)
			expect(
				notifications.at(-1)?.kind === "end"
					? notifications.at(-1)?.counts.passed
					: null,
			).toBe(1)
		} finally {
			await session.dispose()
			rmSync(file, { force: true })
		}
	}, 60_000)
})

describe("A session asked to accept a snapshot", () => {
	const snapshots = [
		"tests {",
		'\ttest "renders" {',
		'\t\texpect "Lions" matches snapshot',
		"\t}",
		"}",
		"",
	].join("\n")

	it("records what the run produced and answers with the source to write", async () => {
		let file = path.join(root, "Snapshots.tests.es")

		writeFileSync(file, snapshots)

		let rewrites: Array<{ module: string; text: string }> = []
		let live = harness({ files: [file] })
		let session = createTestSession({
			testFiles: () => [file],
			dependentsOf: (filePath) => [filePath],
			overlays: () => ({}),
			notify: () => {},
			onResults: () => {},
			onRewrites: (written) => rewrites.push(...written),
			debounce: 20,
		})

		await live.session.dispose()

		try {
			session.run({ files: [file], update: true })

			let deadline = Date.now() + 30_000

			while (rewrites.length === 0 && Date.now() < deadline) {
				await new Promise((resolve) => setTimeout(resolve, 25))
			}

			expect(rewrites).toHaveLength(1)
			expect(rewrites[0]?.module).toBe(file)
			expect(rewrites[0]?.text).toContain('matches snapshot "Lions"')
			// NOTE: The SOURCE is answered rather than written: the buffer the
			// run compiled may never have been saved, and the Server turns this
			// into an edit.
			expect(readFileSync(file, "utf8")).toBe(snapshots)
		} finally {
			await session.dispose()
			rmSync(file, { force: true })
		}
	}, 60_000)

	it("leaves the disk alone on a cycle nobody asked to record", async () => {
		let file = path.join(root, "Untouched.tests.es")

		writeFileSync(file, snapshots)

		let rewrites: Array<{ module: string }> = []
		let live = harness({ files: [file] })

		await live.session.dispose()

		let session = createTestSession({
			testFiles: () => [file],
			dependentsOf: (filePath) => [filePath],
			overlays: () => ({}),
			notify: () => {},
			onResults: () => {},
			onRewrites: (written) => rewrites.push(...written),
			debounce: 20,
		})

		try {
			session.run({ files: [file] })

			await new Promise((resolve) => setTimeout(resolve, 3_000))

			expect(rewrites).toEqual([])
			expect(readFileSync(file, "utf8")).toBe(snapshots)
		} finally {
			await session.dispose()
			rmSync(file, { force: true })
		}
	}, 60_000)
})

describe("A session asked for coverage", () => {
	it("says nothing about coverage until it is asked", async () => {
		let live = harness({ files: [library] })

		try {
			live.session.runAll("open")

			await live.waitForRuns(1)

			let ended = live.notifications.filter(
				(notification) => notification.kind === "end",
			)

			expect(ended[0]?.coverage.files).toEqual([])
			expect(live.session.coverage().files).toEqual([])
		} finally {
			await live.session.dispose()
		}
	}, 60_000)

	it("carries what the counters counted, per source file", async () => {
		let live = harness({ files: [library] })

		try {
			live.session.setCoverage(true)

			await live.waitForRuns(1)

			let ended = live.notifications.filter(
				(notification) => notification.kind === "end",
			)
			let counted = ended[ended.length - 1]?.coverage.files ?? []

			expect(counted.map((file) => file.module)).toEqual([library])
			expect(counted[0]!.lines.total).toBeGreaterThan(0)
			expect(counted[0]!.lines.covered).toBeGreaterThan(0)
			expect(
				live.session.coverage().files.map((file) => file.module),
			).toEqual([library])
		} finally {
			await live.session.dispose()
		}
	}, 60_000)

	it("counts what a test file's own bundle reached in the file it tests", async () => {
		let live = harness({ files: [readerFile] })

		try {
			live.session.setCoverage(true)

			await live.waitForRuns(1)

			let ended = live.notifications.filter(
				(notification) => notification.kind === "end",
			)
			let counted = ended[ended.length - 1]?.coverage.files ?? []

			// NOTE: `Reader.tests.es` is imports and tests — what its counters
			// counted is `Library.es`, which is the whole point of reporting
			// coverage per SOURCE file rather than per entry.
			expect(counted.map((file) => file.module)).toContain(library)
		} finally {
			await live.session.dispose()
		}
	}, 60_000)

	it("throws away what it counted when the setting changes", async () => {
		let live = harness({ files: [library] })

		try {
			live.session.setCoverage(true)

			await live.waitForRuns(1)

			expect(live.session.coverage().files).not.toEqual([])

			live.session.setCoverage(false)

			expect(live.session.coverage().files).toEqual([])
		} finally {
			await live.session.dispose()
		}
	}, 60_000)
})

describe("The Language Server's test session", () => {
	it("runs every test file and reports what held", async () => {
		let live = harness()

		try {
			live.session.runAll("open")

			await live.waitForRuns(1)

			let ended = live.notifications.filter(
				(notification) => notification.kind === "end",
			)

			expect(live.problems).toEqual([])
			expect(live.notifications[0]).toMatchObject({
				version: TEST_RUN_VERSION,
				kind: "start",
				reason: "open",
				run: 1,
			})
			expect(ended[0]).toMatchObject({
				version: TEST_RUN_VERSION,
				kind: "end",
				run: 1,
				compiled: true,
				counts: { passed: 2, failed: 0, skipped: 0, deselected: 0 },
			})
			expect(
				live.session
					.records()
					.map((record) => record.name)
					.sort(),
			).toEqual(["doubles", "reads"])
		} finally {
			await live.session.dispose()
		}
	}, 60_000)

	it("re-runs only the files a change reached", async () => {
		let live = harness()

		try {
			live.session.runAll("open")

			await live.waitForRuns(1)

			live.session.changed([readerFile])

			await live.waitForRuns(2)

			let ended = live.notifications.filter(
				(notification) => notification.kind === "end",
			)

			expect(ended[1]).toMatchObject({
				kind: "end",
				reason: "change",
				files: [readerFile],
			})
			// NOTE: The library's result is still there — a re-run replaces one
			// stream rather than the picture.
			expect(
				live.session
					.records()
					.map((record) => record.name)
					.sort(),
			).toEqual(["doubles", "reads"])
		} finally {
			await live.session.dispose()
		}
	}, 60_000)

	it("re-runs the importers of a Module that changed", async () => {
		let live = harness()

		try {
			live.session.runAll("open")

			await live.waitForRuns(1)

			live.session.changed([library])

			await live.waitForRuns(2)

			let ended = live.notifications.filter(
				(notification) => notification.kind === "end",
			)

			expect([...(ended[1]?.files ?? [])].sort()).toEqual(
				[library, readerFile].sort(),
			)
		} finally {
			await live.session.dispose()
		}
	}, 60_000)

	it("answers for the unsaved buffer rather than the file", async () => {
		let live = harness()

		try {
			live.overlays[library] = passing.replace("::is(4)", "::is(5)")
			live.session.runAll("open")

			await live.waitForRuns(1)

			let failed = live.session.recordsFor(library)

			expect(failed.map((record) => record.state)).toEqual(["failed"])
			expect(live.session.diagnosticsFor(library)[0]).toMatchObject({
				code: "test-failed",
				severity: "error",
			})
		} finally {
			await live.session.dispose()
		}
	}, 60_000)

	it("records the value of every Constant a test body wrote", async () => {
		let live = harness()

		try {
			live.session.runAll("open")

			await live.waitForRuns(1)

			let probes = live.session
				.eventsFor(library)
				.filter((event) => event.kind === "probe")

			expect(probes).toHaveLength(1)
			expect(probes[0]).toMatchObject({
				value: "4",
				span: { source: "double(2)" },
			})
		} finally {
			await live.session.dispose()
		}
	}, 60_000)

	it("runs one test by id when the Editor asks for it", async () => {
		let live = harness()

		try {
			live.session.runAll("open")

			await live.waitForRuns(1)

			let [record] = live.session.recordsFor(readerFile)

			expect(record).toBeDefined()

			let run = live.session.run({ ids: [record!.id] })

			expect(run).toBe(2)

			await live.waitForRuns(2)

			let ended = live.notifications.filter(
				(notification) => notification.kind === "end",
			)

			expect(ended[1]).toMatchObject({
				reason: "request",
				files: [readerFile],
				counts: { passed: 1 },
			})
			// NOTE: What the batch was narrowed TO, so that a client merges the
			// same way the session does rather than adopting the deselection
			// every other test of that file was reported with.
			expect(ended[1]?.ids).toEqual([record!.id])
		} finally {
			await live.session.dispose()
		}
	}, 60_000)

	it("says where every test it ran stands", async () => {
		let live = harness()

		try {
			live.session.runAll("open")

			await live.waitForRuns(1)

			let [ended] = live.notifications.filter(
				(notification) => notification.kind === "end",
			)

			expect(ended?.sites.map((site) => site.name).sort()).toEqual([
				"doubles",
				"reads",
			])

			let site = ended?.sites.find((each) => each.name === "reads")

			expect(site).toMatchObject({
				file: readerFile,
				suitePath: [],
				tags: [],
				focused: false,
				skipped: null,
			})
			// NOTE: The whole item for a gutter, the keyword alone for a lens.
			expect(site?.keywordRange.start).toEqual(site!.range.start)
			expect(site?.range.end.line).toBeGreaterThan(site!.range.start.line)
			// NOTE: The same id the events spell, which is what ties the two
			// halves of a batch together.
			expect(
				ended?.events.some(
					(event) => "id" in event && event.id === site?.id,
				),
			).toBe(true)
		} finally {
			await live.session.dispose()
		}
	}, 60_000)

	it("carries a suite's tags down to the tests under it", async () => {
		let live = harness({ files: [taggedFile] })

		try {
			live.session.runAll("open")

			await live.waitForRuns(1)

			let [ended] = live.notifications.filter(
				(notification) => notification.kind === "end",
			)

			expect(
				ended?.sites.map((site) => [
					site.name,
					site.suitePath,
					site.tags,
				]),
			).toEqual([
				["waits", ["slow things"], ["slow"]],
				["is quick", [], []],
			])
		} finally {
			await live.session.dispose()
		}
	}, 60_000)

	it("leaves out the tags the client asked it to skip", async () => {
		let live = harness({ files: [taggedFile] })

		try {
			live.session.setSkipTags(["slow"])

			await live.waitForRuns(1)

			expect(
				live.session
					.recordsFor(taggedFile)
					.map((record) => [record.name, record.state]),
			).toEqual([
				["waits", "deselected"],
				["is quick", "passed"],
			])
			expect(live.notifications[0]).toMatchObject({
				kind: "start",
				reason: "settings",
			})

			// NOTE: The same tags again is not a reason to run the workspace a
			// second time — a client re-reads its whole configuration whenever
			// anything under `essence` changes.
			live.session.setSkipTags(["slow"])

			await new Promise((resolve) => setTimeout(resolve, 100))

			expect(
				live.notifications.filter(
					(notification) => notification.kind === "start",
				),
			).toHaveLength(1)
		} finally {
			await live.session.dispose()
		}
	}, 60_000)

	it("says nothing at all once it is switched off", async () => {
		let live = harness()

		try {
			live.session.setEnabled(false)
			live.session.runAll("open")
			live.session.changed([library])

			await new Promise((resolve) => setTimeout(resolve, 200))

			expect(live.notifications).toEqual([])
			expect(live.session.records()).toEqual([])
			expect(live.session.isEnabled()).toBe(false)
		} finally {
			await live.session.dispose()
		}
	}, 60_000)

	// NOTE: What a Test Explorer's Run and Refresh buttons send. Neither is
	// about a file, and a client that had to name them could only name the ones
	// it had already been told about.
	it("runs every test file for a request that names neither", async () => {
		let live = harness()

		try {
			expect(live.session.run({})).toBe(1)

			await live.waitForRuns(1)

			let ended = live.notifications.filter(
				(notification) => notification.kind === "end",
			)

			expect(ended[0]).toMatchObject({
				reason: "request",
				ids: [],
				counts: { passed: 2, failed: 0, skipped: 0, deselected: 0 },
			})
			expect([...ended[0]!.files].sort()).toEqual(
				[library, readerFile].sort(),
			)
		} finally {
			await live.session.dispose()
		}
	}, 60_000)

	it("still runs what an Editor asks for while it is switched off", async () => {
		let live = harness()

		try {
			live.session.setEnabled(false)

			expect(live.session.run({ files: [readerFile] })).toBe(1)

			await live.waitForRuns(1)

			expect(
				live.session
					.recordsFor(readerFile)
					.map((record) => record.state),
			).toEqual(["passed"])
			// NOTE: And nothing else started because of it — the setting still
			// declines the automatic half.
			live.session.changed([library])

			await new Promise((resolve) => setTimeout(resolve, 200))

			expect(
				live.notifications.filter(
					(notification) => notification.kind === "start",
				),
			).toHaveLength(1)
		} finally {
			await live.session.dispose()
		}
	}, 60_000)
})

// NOTE: The line-level narrowing, driven end to end. Two functions live in one
// Module, each reached by its own test file, so a change to one function's body
// reaches one test and not the other — which is the whole reason to re-run a few
// tests rather than every test of every file that imports what changed. This
// needs its own graph (the shared `harness` knows only `Library.es`), so the
// session is built here with the Workspace answers this graph gives.
describe("A session narrowing a change to the tests it reached", () => {
	const mathsSource = [
		"implementation {",
		"\tfunction double(_ n: Integer) -> Integer {",
		"\t\t<- n::multiply(with 2)",
		"\t}",
		"",
		"\tfunction triple(_ n: Integer) -> Integer {",
		"\t\t<- n::multiply(with 3)",
		"\t}",
		"}",
		"",
		"export {",
		"\tdouble",
		"\ttriple",
		"}",
		"",
	].join("\n")

	const doublesSource = [
		"import {",
		'\tfrom "./Maths.es" { double }',
		"}",
		"",
		"tests {",
		'\ttest "doubles" {',
		"\t\texpect double(2)::is(4)",
		"\t}",
		"}",
		"",
	].join("\n")

	const triplesSource = [
		"import {",
		'\tfrom "./Maths.es" { triple }',
		"}",
		"",
		"tests {",
		'\ttest "triples" {',
		"\t\texpect triple(2)::is(6)",
		"\t}",
		"}",
		"",
	].join("\n")

	let maths: string
	let doublesFile: string
	let triplesFile: string

	beforeAll(() => {
		maths = path.join(root, "Maths.es")
		doublesFile = path.join(root, "Doubles.tests.es")
		triplesFile = path.join(root, "Triples.tests.es")

		writeFileSync(maths, mathsSource)
		writeFileSync(doublesFile, doublesSource)
		writeFileSync(triplesFile, triplesSource)
	})

	// NOTE: The real session and Worker, wired for this graph: the two test files
	// are the entries, and a change to `Maths.es` reaches both. Mirrors `harness`,
	// which cannot be reused because its `dependentsOf` is spelled for the shared
	// fixture.
	function mathsHarness(): {
		session: TestSession
		notifications: Array<TestRunNotification>
		overlays: Record<string, string>
		problems: Array<string>
		waitForRuns: (count: number) => Promise<void>
	} {
		let notifications: Array<TestRunNotification> = []
		let overlays: Record<string, string> = {}
		let problems: Array<string> = []
		let live = createTestSession({
			onProblem: (filePath, problem) =>
				problems.push(`${filePath}: ${problem}`),
			testFiles: () => [doublesFile, triplesFile],
			dependentsOf: (filePath) =>
				filePath === maths
					? [maths, doublesFile, triplesFile]
					: [filePath],
			overlays: () => overlays,
			notify: (notification) => notifications.push(notification),
			onResults: () => {},
			debounce: 20,
		})

		return {
			session: live,
			notifications,
			overlays,
			problems,
			async waitForRuns(count: number): Promise<void> {
				let deadline = Date.now() + 30_000
				let ended = () =>
					notifications.filter(
						(notification) => notification.kind === "end",
					).length

				while (ended() < count && Date.now() < deadline) {
					await new Promise((resolve) => setTimeout(resolve, 25))
				}
			},
		}
	}

	let endNotifications = (live: ReturnType<typeof mathsHarness>) =>
		live.notifications.filter((notification) => notification.kind === "end")

	it("re-runs only the test whose reached line changed", async () => {
		let live = mathsHarness()

		try {
			// NOTE: The overlay is set BEFORE coverage is switched on, so the whole
			// run's snapshot holds the text the attribution's Positions are in.
			live.overlays[maths] = mathsSource
			live.session.setCoverage(true)

			await live.waitForRuns(1)

			let doublesId = live.session.recordsFor(doublesFile)[0]?.id
			let triplesId = live.session.recordsFor(triplesFile)[0]?.id

			expect(doublesId).toBeDefined()
			expect(triplesId).toBeDefined()

			// NOTE: An in-line edit to `double`'s body — same line count, a literal
			// changed — so nothing moved and the change can be mapped.
			live.overlays[maths] = mathsSource.replace("with 2", "with 4")
			live.session.changed([maths])

			await live.waitForRuns(2)

			let narrowed = endNotifications(live)[1]

			expect(narrowed).toMatchObject({ reason: "change" })
			expect(narrowed?.ids).toContain(doublesId)
			expect(narrowed?.ids).not.toContain(triplesId)
		} finally {
			await live.session.dispose()
		}
	}, 60_000)

	it("leaves the unaffected file's result exactly as it was", async () => {
		let live = mathsHarness()

		try {
			live.overlays[maths] = mathsSource
			live.session.setCoverage(true)

			await live.waitForRuns(1)

			live.overlays[maths] = mathsSource.replace("with 2", "with 4")
			live.session.changed([maths])

			await live.waitForRuns(2)

			// NOTE: `double` re-ran and now fails (2 doubled by four is eight), the
			// proof it was reached; `triple` was never touched, so its passing
			// result from the whole run still stands — the narrowed cycle skipped
			// it rather than reporting it deselected over its own result.
			expect(
				live.session
					.recordsFor(doublesFile)
					.map((record) => record.state),
			).toEqual(["failed"])
			expect(
				live.session
					.recordsFor(triplesFile)
					.map((record) => [record.name, record.state]),
			).toEqual([["triples", "passed"]])
		} finally {
			await live.session.dispose()
		}
	}, 60_000)

	it("runs whole for an edit that adds a line", async () => {
		let live = mathsHarness()

		try {
			live.overlays[maths] = mathsSource
			live.session.setCoverage(true)

			await live.waitForRuns(1)

			// NOTE: A line inserted moves every point below it, so the attribution's
			// coordinates no longer describe the file and there is nothing honest to
			// narrow across — the reach runs whole.
			live.overlays[maths] = mathsSource.replace(
				"implementation {\n",
				"implementation {\n\n",
			)
			live.session.changed([maths])

			await live.waitForRuns(2)

			let whole = endNotifications(live)[1]

			expect(whole).toMatchObject({ reason: "change" })
			expect(whole?.ids).toEqual([])
			expect([...(whole?.files ?? [])].sort()).toEqual(
				[doublesFile, triplesFile].sort(),
			)
		} finally {
			await live.session.dispose()
		}
	}, 60_000)

	it("keeps the coverage picture across a narrowed cycle", async () => {
		let live = mathsHarness()

		try {
			live.overlays[maths] = mathsSource
			live.session.setCoverage(true)

			await live.waitForRuns(1)

			live.overlays[maths] = mathsSource.replace("with 2", "with 4")
			live.session.changed([maths])

			await live.waitForRuns(2)

			// NOTE: A narrowed cycle counts only the tests it ran, so it carries no
			// per-file coverage — repainting the gutter grey on the cheap keystroke
			// is exactly what must not happen. What the whole run counted still
			// stands, so the module is still reported.
			expect(endNotifications(live)[1]?.coverage.files).toEqual([])
			expect(
				live.session.coverage().files.map((file) => file.module),
			).toContain(maths)
		} finally {
			await live.session.dispose()
		}
	}, 60_000)

	it("runs whole for the same edit when coverage is off", async () => {
		let live = mathsHarness()

		try {
			// NOTE: No `setCoverage` — the default. Nothing is attributed, so a
			// line has nothing to map to and the change runs whole. Narrowing rides
			// entirely on coverage.
			live.session.runAll("open")

			await live.waitForRuns(1)

			live.overlays[maths] = mathsSource.replace("with 2", "with 4")
			live.session.changed([maths])

			await live.waitForRuns(2)

			let whole = endNotifications(live)[1]

			expect(whole).toMatchObject({ reason: "change" })
			expect(whole?.ids).toEqual([])
		} finally {
			await live.session.dispose()
		}
	}, 60_000)
})

// NOTE: The same double/triple source the narrowing describe uses, reused by the
// property and focus fixtures below — two functions on different lines, so a
// change to one is a change the attribution can place on one test's ground and
// not another's.
const numbersSource = [
	"implementation {",
	"\tfunction double(_ n: Integer) -> Integer {",
	"\t\t<- n::multiply(with 2)",
	"\t}",
	"",
	"\tfunction triple(_ n: Integer) -> Integer {",
	"\t\t<- n::multiply(with 3)",
	"\t}",
	"}",
	"",
	"export {",
	"\tdouble",
	"\ttriple",
	"}",
	"",
].join("\n")

// NOTE: The real session and Worker for one source Module and its test entries,
// with coverage-driven narrowing wired the way this graph's Workspace would
// answer — a change to the source reaches every entry. Mirrors `harness`, which
// cannot be reused because its `dependentsOf` is spelled for the shared fixture.
function coverageSession(
	sourceModule: string,
	entries: Array<string>,
): {
	session: TestSession
	notifications: Array<TestRunNotification>
	overlays: Record<string, string>
	waitForRuns: (count: number) => Promise<void>
} {
	let notifications: Array<TestRunNotification> = []
	let overlays: Record<string, string> = {}
	let live = createTestSession({
		testFiles: () => entries,
		dependentsOf: (filePath) =>
			filePath === sourceModule ? [sourceModule, ...entries] : [filePath],
		overlays: () => overlays,
		notify: (notification) => notifications.push(notification),
		onResults: () => {},
		debounce: 20,
	})

	return {
		session: live,
		notifications,
		overlays,
		async waitForRuns(count: number): Promise<void> {
			let deadline = Date.now() + 30_000
			let ended = () =>
				notifications.filter(
					(notification) => notification.kind === "end",
				).length

			while (ended() < count && Date.now() < deadline) {
				await new Promise((resolve) => setTimeout(resolve, 25))
			}
		},
	}
}

// NOTE: Fix 1 — a property test draws fresh values every run, so its attribution
// is one run's sample of the lines it COULD touch, not the whole of them.
// `narrowingFor` unions in every property of the reached entries whatever the
// change touched, rather than trusting a sample to say a property was untouched.
describe("A session re-running a property whatever a change touched", () => {
	// NOTE: One entry with a property over `double` and a unit test over `triple`
	// — two tests of one file, each reaching a different line of the source.
	const mixedSource = [
		"import {",
		'\tfrom "./PropMaths.es" { double }',
		'\tfrom "./PropMaths.es" { triple }',
		"}",
		"",
		"tests {",
		'\ttest "doubling adds a number to itself" for any (n: Integer) {',
		"\t\texpect double(n)::is(n::add(n))",
		"\t}",
		"",
		'\ttest "triples" {',
		"\t\texpect triple(2)::is(6)",
		"\t}",
		"}",
		"",
	].join("\n")

	let propMaths: string
	let mixedFile: string

	beforeAll(() => {
		propMaths = path.join(root, "PropMaths.es")
		mixedFile = path.join(root, "Mixed.tests.es")

		writeFileSync(propMaths, numbersSource)
		writeFileSync(mixedFile, mixedSource)
	})

	it("re-runs a property alongside the unit test whose line changed", async () => {
		let live = coverageSession(propMaths, [mixedFile])

		try {
			live.overlays[propMaths] = numbersSource
			live.session.setCoverage(true)

			await live.waitForRuns(1)

			let unitId = live.session
				.recordsFor(mixedFile)
				.find((record) => record.name === "triples")?.id
			let propertyId = live.session
				.eventsFor(mixedFile)
				.find((event) => event.kind === "property")?.id

			expect(unitId).toBeDefined()
			expect(propertyId).toBeDefined()

			// NOTE: An in-line edit to `triple`'s body — the line only the unit
			// test reached. The property samples `double` and never touched this
			// line, yet it is re-run anyway.
			live.overlays[propMaths] = numbersSource.replace("with 3", "with 5")
			live.session.changed([propMaths])

			await live.waitForRuns(2)

			let narrowed = live.notifications
				.filter((notification) => notification.kind === "end")
				.at(1)

			expect(narrowed).toMatchObject({ reason: "change" })
			expect(narrowed?.ids).toContain(unitId)
			expect(narrowed?.ids).toContain(propertyId)
		} finally {
			await live.session.dispose()
		}
	}, 60_000)
})

// NOTE: Fix 2 — a cycle that SILENCED a live test with a focus never ran it, so
// its lines look like dead code in the attribution. `receive` refuses to build
// attribution from such a cycle (a `test-deselected` with reason "not-focused"),
// so the entry stays out of the fresh set and the next change runs whole rather
// than narrowing off the truncated picture.
describe("A session that silenced a test with a focus", () => {
	// NOTE: A focused test beside a plain sibling. While the focus stands only the
	// focused test runs, so the sibling's own lines are never counted in the one
	// cycle that ran.
	const focusedSource = [
		"import {",
		'\tfrom "./FocusMaths.es" { double }',
		'\tfrom "./FocusMaths.es" { triple }',
		"}",
		"",
		"tests {",
		'\ttest "doubles" focused {',
		"\t\texpect double(2)::is(4)",
		"\t}",
		"",
		'\ttest "triples" {',
		"\t\texpect triple(2)::is(6)",
		"\t}",
		"}",
		"",
	].join("\n")

	let focusMaths: string
	let focusedFile: string

	beforeAll(() => {
		focusMaths = path.join(root, "FocusMaths.es")
		focusedFile = path.join(root, "Focused.tests.es")

		writeFileSync(focusMaths, numbersSource)
		writeFileSync(focusedFile, focusedSource)
	})

	it("runs whole rather than narrow off a focus-truncated attribution", async () => {
		let live = coverageSession(focusMaths, [focusedFile])

		try {
			live.overlays[focusMaths] = numbersSource
			live.session.setCoverage(true)

			// NOTE: The whole cycle runs only the focused "doubles" and deselects
			// "triples" as not-focused, so no attribution is built for this entry.
			await live.waitForRuns(1)

			// NOTE: The focus took effect — "doubles" ran and "triples" was
			// silenced — which is the very condition that leaves the attribution
			// truncated. Asserted so this test can not false-pass on a source that
			// failed to compile or a focus keyword that did nothing.
			expect(
				live.session
					.recordsFor(focusedFile)
					.map((record) => [record.name, record.state]),
			).toEqual([
				["doubles", "passed"],
				["triples", "not-focused"],
			])

			// NOTE: An in-line edit to the focused test's own covered line. Were the
			// truncated attribution trusted it would narrow to "doubles" alone; the
			// fix keeps the entry out of the fresh set, so the change runs WHOLE and
			// the end notification carries no narrowing.
			live.overlays[focusMaths] = numbersSource.replace(
				"with 2",
				"with 4",
			)
			live.session.changed([focusMaths])

			await live.waitForRuns(2)

			let whole = live.notifications
				.filter((notification) => notification.kind === "end")
				.at(1)

			expect(whole).toMatchObject({ reason: "change" })
			expect(whole?.ids).toEqual([])
		} finally {
			await live.session.dispose()
		}
	}, 60_000)
})
