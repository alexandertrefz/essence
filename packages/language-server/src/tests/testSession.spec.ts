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

let root: string
let library: string
let readerFile: string

beforeAll(() => {
	root = canonicalPath(mkdtempSync(path.join(tmpdir(), "essence-session-")))
	library = path.join(root, "Library.es")
	readerFile = path.join(root, "Reader.tests.es")

	mkdirSync(root, { recursive: true })
	writeFileSync(library, passing)
	writeFileSync(readerFile, reader)
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

function harness(options: { debounce?: number } = {}): Harness {
	let notifications: Array<TestRunNotification> = []
	let results: Array<Array<string>> = []
	let overlays: Record<string, string> = {}
	let problems: Array<string> = []
	let session = createTestSession({
		onProblem: (filePath, problem) =>
			problems.push(`${filePath}: ${problem}`),
		testFiles: () => [library, readerFile],
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
				version: 1,
				kind: "start",
				reason: "open",
				run: 1,
			})
			expect(ended[0]).toMatchObject({
				version: 1,
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
