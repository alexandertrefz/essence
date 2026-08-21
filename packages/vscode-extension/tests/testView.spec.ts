import { beforeEach, describe, expect, it, mock } from "bun:test"

import type { TestEvent, TestRunNotification, TestSite } from "../testModel.js"
import { suiteKey } from "../testModel.js"
import {
	createStub,
	type StubTestItem,
	type StubTestRun,
} from "./vscodeStub.js"

// NOTE: The half of the Test Explorer that calls VS Code, driven against a
// stand-in for it. What `testModel.ts` decides is covered beside this; what is
// covered here is the bookkeeping the API forces — which item was created, which
// run was ended, what was drawn on which editor — none of which an Extension
// Development Host makes easy to see, and every bit of which is wrong in ways
// nobody notices until a tree stops updating.

const stub = createStub()

mock.module("vscode", () => stub.module)

// NOTE: After the mock, because a static import would evaluate `testView.js` —
// and its `import * as vscode` — before the registration ran.
const { createTestView } = await import("../testView.js")

const FILE = "/repo/Season.tests.es"

function site(overrides: Partial<TestSite> = {}): TestSite {
	let name = overrides.name ?? "adds up"
	let suitePath = overrides.suitePath ?? []
	let file = overrides.file ?? FILE

	return {
		id: suiteKey(file, [...suitePath, name]),
		name,
		suitePath,
		file,
		range: { start: { line: 2, column: 2 }, end: { line: 6, column: 3 } },
		keywordRange: {
			start: { line: 2, column: 2 },
			end: { line: 2, column: 6 },
		},
		tags: [],
		focused: false,
		skipped: null,
		...overrides,
	}
}

function batch(
	overrides: Partial<TestRunNotification> = {},
): TestRunNotification {
	return {
		version: 2,
		run: 1,
		kind: "end",
		reason: "change",
		files: [FILE],
		ids: [],
		events: [],
		sites: [],
		counts: { passed: 0, failed: 0, skipped: 0, deselected: 0 },
		duration: 12,
		compiled: true,
		...overrides,
	}
}

function started(one: TestSite): TestEvent {
	return {
		schema: 1,
		kind: "test-start",
		id: one.id,
		name: one.name,
		suitePath: one.suitePath,
		module: one.file,
	}
}

function passed(one: TestSite): TestEvent {
	return {
		schema: 1,
		kind: "test-pass",
		id: one.id,
		name: one.name,
		duration: 4,
		expectations: 1,
	}
}

function failed(one: TestSite): TestEvent {
	return {
		schema: 1,
		kind: "test-fail",
		id: one.id,
		name: one.name,
		duration: 7,
		expectations: 1,
		failures: [
			{
				form: "expect",
				span: {
					start: { line: 4, column: 3 },
					end: { line: 4, column: 15 },
					source: "total::is(5)",
				},
				values: [],
				comparison: { kind: "is", left: "4", right: "5", diff: [] },
			},
		],
		error: null,
	}
}

type Answer = { run: number | null } | null

type View = {
	handle: (notification: TestRunNotification) => void
	runIds: (ids: Array<string>, files: Array<string>) => Promise<void>
	runFailed: () => Promise<void>
	reset: () => void
	dispose: () => void
	drawEditor: (editor: unknown) => void
	show: () => void
}

type Live = {
	view: View
	asked: Array<{ ids: Array<string>; files: Array<string> }>
	answer: (selection: {
		ids: Array<string>
		files: Array<string>
	}) => Answer | Promise<Answer>
}

// NOTE: The Server answers a request with the cycle its results will arrive
// under, and sends the `start` notification from inside the handler — so a
// spec's answer is where a start belongs, exactly as it does over the wire.
function live(
	answer: (selection: {
		ids: Array<string>
		files: Array<string>
	}) => Answer | Promise<Answer> = () => null,
): Live {
	let asked: Array<{ ids: Array<string>; files: Array<string> }> = []
	let session: Live = {
		asked,
		answer,
		view: createTestView({
			runTests: (selection: {
				ids: Array<string>
				files: Array<string>
			}) => {
				asked.push(selection)

				return Promise.resolve(session.answer(selection))
			},
		}) as View,
	}

	return session
}

function fileItem(): StubTestItem {
	let item = stub.controller.items.get(suiteKey(FILE, []))

	expect(item).toBeDefined()

	return item!
}

function children(item: StubTestItem): Array<StubTestItem> {
	let all: Array<StubTestItem> = []

	item.children.forEach((child) => all.push(child))

	return all
}

function profileNamed(label: string) {
	return stub.controller.profiles.find((profile) => profile.label === label)
}

beforeEach(() => {
	stub.reset()
})

describe("the tree it builds", () => {
	it("puts a file, its suites and its tests where they were written", () => {
		let session = live()
		let quick = site({ name: "is quick", tags: ["fast"] })
		let slow = site({ name: "waits", suitePath: ["slow"] })

		session.view.handle(
			batch({
				sites: [quick, slow],
				events: [started(quick), passed(quick)],
			}),
		)

		let file = fileItem()

		expect(file.label).toBe("Season.tests.es")
		expect(file.uri?.fsPath).toBe(FILE)

		let [first, suite] = children(file)

		// NOTE: The order they were written in, which the Explorer only keeps
		// because it is told to — it sorts by label otherwise.
		expect(first!.label).toBe("is quick")
		expect(first!.sortText! < suite!.sortText!).toBe(true)
		// NOTE: One-based Compiler Positions, zero-based VS Code ones.
		expect(first!.range).toMatchObject({ startLine: 1, endLine: 5 })
		expect(first!.tags.map((tag) => tag.id)).toEqual(["fast"])

		expect(suite!.label).toBe("slow")
		expect(suite!.range).toBeUndefined()
		expect(children(suite!).map((each) => each.label)).toEqual(["waits"])
	})

	// NOTE: The identity is structural, so an edit that MOVES a test is the
	// same test — keeping its item keeps its state, its selection and whether
	// its suite was expanded.
	it("keeps the item a test already had when the file is read again", () => {
		let session = live()
		let one = site()

		session.view.handle(batch({ sites: [one] }))

		let before = children(fileItem())[0]!

		session.view.handle(
			batch({
				run: 2,
				sites: [
					site({
						range: { ...one.range, start: { line: 9, column: 2 } },
					}),
				],
			}),
		)

		let after = children(fileItem())[0]!

		expect(after).toBe(before)
		expect(after.range).toMatchObject({ startLine: 8 })
	})

	it("says why a test that will not run is there", () => {
		let session = live()

		session.view.handle(
			batch({
				sites: [site({ skipped: "the network is not here" })],
			}),
		)

		expect(children(fileItem())[0]!.description).toBe(
			"skipped — the network is not here",
		)
	})

	it("drops a file the file system says is gone", () => {
		let session = live()

		session.view.handle(batch({ sites: [site()] }))

		expect(stub.controller.items.size).toBe(1)

		for (let listener of stub.deletions) {
			listener({
				fsPath: FILE,
				scheme: "file",
				toString: () => FILE,
			})
		}

		expect(stub.controller.items.size).toBe(0)
	})

	it("ignores a payload version it was not built for, and says so", () => {
		let session = live()

		session.view.handle(batch({ version: 99, sites: [site()] }))

		expect(stub.controller.items.size).toBe(0)
		expect(stub.channel.lines.join("\n")).toContain("payload version 99")
	})
})

describe("what it tells VS Code a run found", () => {
	it("reports a state and a duration per test", () => {
		let session = live()
		let ok = site({ name: "adds up" })
		let bad = site({ name: "subtracts" })
		let out = site({ name: "waits" })

		session.view.handle(
			batch({
				sites: [ok, bad, out],
				events: [
					started(ok),
					passed(ok),
					started(bad),
					failed(bad),
					{
						schema: 1,
						kind: "test-skip",
						id: out.id,
						name: out.name,
						suitePath: [],
						module: FILE,
						reason: "no network here",
					},
				],
			}),
		)

		let [run] = stub.runs as Array<StubTestRun>

		expect(run!.passedTests).toEqual([{ id: ok.id, duration: 4 }])
		expect(run!.skippedTests).toEqual([out.id])
		expect(run!.failedTests[0]!.id).toBe(bad.id)
		expect(run!.failedTests[0]!.duration).toBe(7)
		expect(run!.ends).toBe(1)
	})

	// NOTE: `expected`/`actual` are what VS Code draws as a diff, and they are
	// a claim only an `is` makes.
	it("hands over the two sides of an is, and where to say it", () => {
		let session = live()
		let bad = site()

		session.view.handle(
			batch({ sites: [bad], events: [started(bad), failed(bad)] }),
		)

		let [message] = stub.runs[0]!.failedTests[0]!.messages

		expect(message!.expected).toBe("5")
		expect(message!.actual).toBe("4")
		expect(message!.location?.uri.fsPath).toBe(FILE)
		expect(message!.location?.range).toMatchObject({ startLine: 3 })
	})

	// NOTE: The Test Results panel is a terminal, and text carrying only
	// newlines staircases down it.
	it("puts what a test printed under that test, for a terminal", () => {
		let session = live()
		let one = site()

		session.view.handle(
			batch({
				sites: [one],
				events: [
					started(one),
					{
						schema: 1,
						kind: "output",
						id: one.id,
						stream: "output",
						text: "one\ntwo\n",
					},
					passed(one),
				],
			}),
		)

		expect(stub.runs[0]!.outputChunks).toEqual([
			{ id: one.id, text: "one\r\ntwo\r\n" },
		])
	})

	it("writes one line per cycle to the output channel", () => {
		let session = live()

		session.view.handle(batch({ run: 3, sites: [site()] }))

		expect(stub.channel.lines.at(-1)).toContain("run 3 (change)")
	})
})

describe("the marks it draws", () => {
	it("draws on an Essence editor and leaves every other one alone", () => {
		let session = live()
		let essence = stub.editor(FILE)
		let other = stub.editor("/repo/notes.md", "markdown")
		let bad = site()

		session.view.handle(
			batch({ sites: [bad], events: [started(bad), failed(bad)] }),
		)

		let drawn = [...essence.drawn.values()].filter(
			(ranges) => ranges.length > 0,
		)

		// NOTE: The test's own lines, and the line of the `expect` that failed.
		expect(drawn).toHaveLength(2)
		expect(other.drawn.size).toBe(0)
	})

	it("draws an editor that has only just become visible", () => {
		let session = live()
		let one = site()

		session.view.handle(
			batch({ sites: [one], events: [started(one), passed(one)] }),
		)

		let late = stub.editor(FILE)

		expect(late.drawn.size).toBe(0)

		session.view.drawEditor(late)

		expect(
			[...late.drawn.values()].filter((ranges) => ranges.length > 0),
		).toHaveLength(1)
	})
})

describe("the profiles it offers", () => {
	it("offers Run, Debug and one profile per tag anything carries", () => {
		let session = live()

		expect(
			stub.controller.profiles.map((profile) => profile.label),
		).toEqual(["Run", "Debug"])

		session.view.handle(
			batch({ sites: [site({ tags: ["slow", "network"] })] }),
		)

		expect(
			stub.controller.profiles
				.map((profile) => profile.label)
				.filter((label) => label.startsWith("Run ")),
		).toEqual(["Run network", "Run slow"])

		// NOTE: VS Code offers a profile whether or not anything would run
		// under it, so a tag nothing carries any more must stop offering one.
		session.view.handle(batch({ run: 2, sites: [site()] }))

		expect(profileNamed("Run slow")!.disposals).toBe(1)
	})

	it("asks for the whole workspace when nothing in particular is selected", async () => {
		let session = live()

		await stub.controller.refreshHandler!()
		await profileNamed("Run")!.run({ include: undefined }, undefined)

		expect(session.asked).toEqual([
			{ ids: [], files: [] },
			{ ids: [], files: [] },
		])
	})

	it("asks for a file as a file and a test as an id", async () => {
		let session = live()
		let one = site()

		session.view.handle(batch({ sites: [one] }))

		let file = fileItem()

		await profileNamed("Run")!.run({ include: [file] }, undefined)
		await profileNamed("Run")!.run({ include: children(file) }, undefined)

		expect(session.asked).toEqual([
			{ ids: [], files: [FILE] },
			{ ids: [one.id], files: [] },
		])
	})

	it("refuses to debug, names what to run instead and copies it", async () => {
		let session = live()
		let one = site()

		stub.answerMessageWith("Copy command")
		session.view.handle(batch({ sites: [one] }))

		await profileNamed("Debug")!.run(
			{ include: children(fileItem()) },
			undefined,
		)
		// NOTE: The message is answered on a Promise the handler does not
		// await — it ends the run either way.
		await Promise.resolve()

		expect(stub.messages.at(-1)!.text).toContain(
			'essence test Season.tests.es --filter "adds up"',
		)
		expect(stub.clipboard).toEqual([
			'essence test Season.tests.es --filter "adds up"',
		])
		expect(session.asked).toEqual([])
	})
})

describe("the runs it keeps", () => {
	it("shows a run it asked for as the run the results arrive in", async () => {
		let session = live()
		let one = site()

		session.view.handle(batch({ sites: [one] }))

		let asked = stub.runs.length

		session.answer = () => {
			// NOTE: The Server sends the `start` from inside the request
			// handler, so it routinely arrives before the answer naming the
			// cycle it belongs to.
			session.view.handle(
				batch({ kind: "start", run: 7, reason: "request" }),
			)

			return { run: 7 }
		}

		await session.view.runIds([one.id], [FILE])

		// NOTE: One run for the gesture, and the notification adopted it rather
		// than opening a second.
		expect(stub.runs).toHaveLength(asked + 1)

		let run = stub.runs.at(-1)!

		// NOTE: Once where the gesture was made, and again when the cycle said
		// what it covers.
		expect(run.enqueuedTests).toEqual([one.id, one.id])

		session.view.handle(
			batch({
				run: 7,
				reason: "request",
				ids: [one.id],
				sites: [one],
				events: [started(one), passed(one)],
			}),
		)

		expect(run.passedTests).toEqual([{ id: one.id, duration: 4 }])
		expect(run.ends).toBe(1)
	})

	// NOTE: A request made while a cycle is already going is answered with THAT
	// cycle's number. Registering over the run already showing it would leave
	// that one spinning with nothing left holding it.
	it("ends the run it displaces when a request joins a cycle", async () => {
		let session = live()

		session.view.handle(batch({ kind: "start", run: 4, reason: "change" }))

		let joined = stub.runs.at(-1)!

		session.answer = () => ({ run: 4 })

		await session.view.runIds([], [FILE])

		expect(joined.ends).toBe(1)
		expect(stub.runs.at(-1)).not.toBe(joined)
		expect(stub.runs.at(-1)!.ends).toBe(0)
	})

	// NOTE: A cycle that never ended — a Worker died, the session was switched
	// off — would leave VS Code spinning forever.
	it("ends an older cycle when a newer one starts", () => {
		let session = live()

		session.view.handle(batch({ kind: "start", run: 1 }))

		let stale = stub.runs.at(-1)!

		session.view.handle(batch({ kind: "start", run: 2 }))

		expect(stale.ends).toBe(1)
	})

	it("answers nothing when nothing ran", async () => {
		let session = live()

		await session.view.runIds([], [FILE])

		expect(stub.runs.at(-1)!.ends).toBe(1)
		expect(stub.channel.lines.join("\n")).toContain("nothing ran")
	})
})

describe("re-running what failed", () => {
	it("runs the failures by id rather than the files they are in", async () => {
		let session = live()
		let ok = site({ name: "adds up" })
		let bad = site({ name: "subtracts" })

		session.answer = () => ({ run: 2 })
		session.view.handle(
			batch({
				sites: [ok, bad],
				events: [started(ok), passed(ok), started(bad), failed(bad)],
			}),
		)

		await session.view.runFailed()

		expect(session.asked).toEqual([{ ids: [bad.id], files: [] }])
	})

	it("says so when nothing has failed", async () => {
		let session = live()

		session.view.handle(batch({ sites: [site()] }))

		await session.view.runFailed()

		expect(session.asked).toEqual([])
		expect(stub.messages.at(-1)!.text).toContain("no test has failed")
	})
})

describe("starting over", () => {
	it("empties the tree, ends what is open and stops offering tags", () => {
		let session = live()

		session.view.handle(batch({ kind: "start", run: 1 }))
		session.view.handle(batch({ sites: [site({ tags: ["slow"] })] }))

		let open = stub.runs[0]!

		session.view.reset()

		expect(stub.controller.items.size).toBe(0)
		expect(profileNamed("Run slow")!.disposals).toBe(1)
		expect(open.ends).toBeGreaterThan(0)
	})

	it("gives back everything it took", () => {
		let session = live()

		session.view.dispose()

		expect(stub.controller.disposals).toBe(1)
		expect(stub.channel.disposals).toBe(1)
		expect(
			stub.decorations.every((decoration) => decoration.disposals === 1),
		).toBe(true)
		expect(
			stub.controller.profiles.every(
				(profile) => profile.disposals === 1,
			),
		).toBe(true)
	})
})
