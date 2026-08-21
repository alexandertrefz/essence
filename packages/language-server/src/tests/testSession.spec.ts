import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import * as path from "node:path"

import { canonicalPath } from "@essence-lang/compiler/documents"

import type { TestRunNotification } from "../testProtocol"
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
	"tests {",
	'\ttest "doubles" {',
	"\t\tconstant doubled = double(2)",
	"",
	"\t\texpect doubled::is(4)",
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
	'\tdouble from "./Library.es"',
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
				version: 2,
				kind: "start",
				reason: "open",
				run: 1,
			})
			expect(ended[0]).toMatchObject({
				version: 2,
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
})
