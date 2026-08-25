import { beforeEach, describe, expect, it, mock } from "bun:test"

import type {
	CoveragePoint,
	CoverageSummary,
	TestEvent,
	TestRunNotification,
	TestSite,
} from "../testModel.js"
import { suiteKey, TEST_RUN_VERSION } from "../testModel.js"
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
		version: TEST_RUN_VERSION,
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
		row: null,
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
	acceptSnapshots: (ids: Array<string>, files: Array<string>) => Promise<void>
	runFailed: () => Promise<void>
	reset: () => void
	dispose: () => void
	drawEditor: (editor: unknown) => void
	show: () => void
}

type Live = {
	view: View
	asked: Array<{
		ids: Array<string>
		files: Array<string>
		update?: boolean
	}>
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
	let asked: Array<{
		ids: Array<string>
		files: Array<string>
		update?: boolean
	}> = []
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

// NOTE: A gutter icon is an SVG baked into a data URI, and its fill is the
// only thing that tells one square from another — which is exactly what a reader
// goes by.
function colourOf(decoration: { options: Record<string, unknown> }): string {
	let icon = decoration.options.gutterIconPath as
		| { fsPath: string }
		| undefined

	if (icon === undefined) {
		return ""
	}

	let svg = Buffer.from(icon.fsPath.split(",")[1] ?? "", "base64").toString()

	return /fill="(#[0-9a-f]{6})"/.exec(svg)?.[1] ?? ""
}

// NOTE: The lines drawn on one editor, by the colour they were drawn in; VS
// Code's lines, so 0-based.
function drawnByColour(editor: {
	drawn: Map<unknown, Array<unknown>>
}): Map<string, Array<number>> {
	let byColour = new Map<string, Array<number>>()

	for (let [type, ranges] of editor.drawn) {
		if (ranges.length === 0) {
			continue
		}

		let colour = colourOf(type as { options: Record<string, unknown> })

		byColour.set(
			colour,
			ranges.map((range) => (range as { startLine: number }).startLine),
		)
	}

	return byColour
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
						row: null,
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

// NOTE: A source file the counters counted: one line that ran and one that did
// not, both sides of a branch with only one taken, an arm nothing took, and a
// Choice with a Case nobody built.
const SOURCE = "/repo/Season.es"

function point(overrides: Partial<CoveragePoint>): CoveragePoint {
	return {
		kind: "statement",
		label: "",
		scope: "",
		position: {
			start: { line: 1, column: 1 },
			end: { line: 1, column: 9 },
		},
		refinement: false,
		tag: null,
		count: 0,
		...overrides,
	}
}

function atLine(line: number, overrides: Partial<CoveragePoint>) {
	return point({
		...overrides,
		position: {
			start: { line, column: 1 },
			end: { line, column: 9 },
		},
	})
}

function coverage(): CoverageSummary {
	return {
		files: [
			{
				module: SOURCE,
				lines: { covered: 1, total: 2 },
				branches: { covered: 1, total: 2 },
				cases: { covered: 0, total: 1 },
				missed: [
					{
						kind: "branch",
						scope: "share",
						label: "else",
						refinement: true,
						position: {
							start: { line: 5, column: 1 },
							end: { line: 5, column: 9 },
						},
					},
				],
				points: [
					atLine(3, { count: 2 }),
					atLine(4, { count: 0 }),
					atLine(5, { kind: "branch", label: "if", count: 2 }),
					atLine(5, {
						kind: "branch",
						label: "else",
						count: 0,
						refinement: true,
					}),
					atLine(9, {
						kind: "case",
						label: "case #Postponed",
						scope: "Standings::points",
						count: 0,
					}),
				],
			},
		],
		choices: [
			{
				name: "Fixture",
				module: SOURCE,
				position: {
					start: { line: 2, column: 1 },
					end: { line: 6, column: 2 },
				},
				cases: [
					{ tag: "Fixture#Played", constructed: true },
					{ tag: "Fixture#Forfeited", constructed: false },
				],
			},
		],
	}
}

describe("the coverage it draws", () => {
	it("attaches what each file counted to the run", () => {
		let session = live()

		session.view.handle(batch({ sites: [site()], coverage: coverage() }))

		let [attached] = stub.runs[0]!.coverages

		expect(attached?.uri.fsPath).toBe(SOURCE)
		expect(attached?.statementCoverage).toEqual({ covered: 1, total: 2 })
		expect(attached?.branchCoverage).toEqual({ covered: 1, total: 2 })
		// NOTE: One Match arm and two Cases of a Choice, of which the arm was
		// never taken and one Case never built.
		expect(attached?.declarationCoverage).toEqual({ covered: 1, total: 3 })
	})

	it("attributes a counted run to the coverage profile", () => {
		let session = live()

		session.view.handle(batch({ sites: [site()], coverage: coverage() }))

		let request = stub.runs[0]!.request as { profile?: { label: string } }

		expect(request.profile?.label).toBe("Run with Coverage")
	})

	it("attaches nothing to a run that counted nothing", () => {
		let session = live()

		session.view.handle(batch({ sites: [site()] }))

		expect(stub.runs[0]!.coverages).toEqual([])
		expect(
			(stub.runs[0]!.request as { profile?: unknown }).profile,
		).toBeUndefined()
	})

	it("answers the detail with a statement per line and its branches", async () => {
		let session = live()

		session.view.handle(batch({ sites: [site()], coverage: coverage() }))

		let profile = profileNamed("Run with Coverage")!
		let details = (await (
			profile as unknown as {
				loadDetailedCoverage: (
					run: unknown,
					file: unknown,
				) => Promise<Array<Record<string, unknown>>>
			}
		).loadDetailedCoverage(null, { uri: { fsPath: SOURCE } })) as Array<{
			kind: string
			executed: number
			name?: string
			location: { line: number }
			branches?: Array<{ label: string; executed: number }>
		}>
		let statements = details.filter((each) => each.kind === "statement")

		expect(
			statements.map((each) => [each.location.line, each.executed]),
		).toEqual([
			[2, 2],
			[3, 0],
			[4, 2],
			[8, 0],
		])
		expect(
			statements[2]!.branches?.map((branch) => [
				branch.label,
				branch.executed,
			]),
		).toEqual([
			["if", 2],
			["else", 0],
		])
	})

	it("answers a Match arm and a Choice Case as declarations", async () => {
		let session = live()

		session.view.handle(batch({ sites: [site()], coverage: coverage() }))

		let profile = profileNamed("Run with Coverage")!
		let details = (await (
			profile as unknown as {
				loadDetailedCoverage: (
					run: unknown,
					file: unknown,
				) => Promise<Array<Record<string, unknown>>>
			}
		).loadDetailedCoverage(null, { uri: { fsPath: SOURCE } })) as Array<{
			kind: string
			name?: string
			executed: number
		}>

		expect(
			details
				.filter((each) => each.kind === "declaration")
				.map((each) => [each.name, each.executed]),
		).toEqual([
			["Standings::points › case #Postponed", 0],
			["Fixture#Played", 1],
			["Fixture#Forfeited", 0],
		])
	})

	// NOTE: Three colours down the gutter, one per line the counters know
	// about — green where the tests ran it, grey where nothing did, amber where
	// it ran but not whole. VS Code's lines are 0-based.
	it("marks every counted line in the gutter by what ran on it", () => {
		let session = live()
		let editor = stub.editor(SOURCE)

		session.view.handle(batch({ sites: [site()], coverage: coverage() }))

		let drawn = drawnByColour(editor)

		expect(drawn.get("#3fb950")).toEqual([2])
		expect(drawn.get("#8b949e")).toEqual([3, 8])
		expect(drawn.get("#d29922")).toEqual([4])
	})

	it("takes the marks down when the counting is turned off", () => {
		let session = live()
		let editor = stub.editor(SOURCE)

		session.view.handle(batch({ sites: [site()], coverage: coverage() }))
		session.view.handle(
			batch({
				run: 2,
				reason: "settings",
				sites: [site()],
				coverage: { files: [], choices: [] },
			}),
		)

		expect(drawnByColour(editor).size).toBe(0)
	})

	it("says what it counted in the output channel", () => {
		let session = live()

		session.view.handle(batch({ sites: [site()], coverage: coverage() }))

		expect(stub.channel.lines.join("\n")).toContain("50% lines")
		expect(stub.channel.lines.join("\n")).toContain("0/1 cases")
		expect(stub.channel.lines.join("\n")).toContain("1 never constructed")
	})

	it("turns the setting on when a reader runs with coverage", async () => {
		let session = live(() => ({ run: 4 }))
		let profile = profileNamed("Run with Coverage")!

		await profile.run({ include: undefined }, undefined)

		expect(stub.settings["essence.tests.coverage"]).toBe(true)
		expect(stub.updates.map((update) => update.key)).toEqual(["coverage"])
		expect(session.asked).toHaveLength(1)
	})

	it("leaves a setting that is already on alone", async () => {
		let session = live(() => ({ run: 4 }))

		stub.settings["essence.tests.coverage"] = true

		await profileNamed("Run with Coverage")!.run(
			{ include: undefined },
			undefined,
		)

		expect(stub.updates).toEqual([])
		expect(session.asked).toHaveLength(1)
	})
})

describe("the profiles it offers", () => {
	it("offers Run, Debug, coverage and one profile per tag anything carries", () => {
		let session = live()

		expect(
			stub.controller.profiles.map((profile) => profile.label),
		).toEqual(["Run", "Debug", "Run with Coverage"])

		session.view.handle(
			batch({ sites: [site({ tags: ["slow", "network"] })] }),
		)

		expect(
			stub.controller.profiles
				.map((profile) => profile.label)
				.filter(
					(label) =>
						label.startsWith("Run ") &&
						label !== "Run with Coverage",
				),
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

	// NOTE: Debugging is not a test run: it launches the `essence` debug type
	// over a bundle compiled WITH the file's tests section, and asks the Server
	// for nothing at all.
	it("debugs a test by launching a session over the file it is in", async () => {
		let session = live()
		let one = site()

		session.view.handle(batch({ sites: [one] }))

		await profileNamed("Debug")!.run(
			{ include: children(fileItem()) },
			undefined,
		)

		expect(
			stub.debugSessions.map((started) => started.configuration),
		).toEqual([
			{
				type: "essence",
				request: "launch",
				name: "adds up",
				program: FILE,
				tests: [one.id],
			},
		])
		expect(session.asked).toEqual([])
	})

	// NOTE: A session that would not start is the end of the walk: whatever
	// stopped it would stop the next one, and a reader watching debuggers open
	// one after another for a reason nobody explained is worse than a line in
	// the channel.
	it("stops where a session would not start, and says so", async () => {
		let session = live()
		let one = site()

		stub.refuseDebugStart()
		session.view.handle(batch({ sites: [one] }))

		await profileNamed("Debug")!.run(
			{ include: children(fileItem()) },
			undefined,
		)

		expect(stub.debugSessions).toHaveLength(1)
		expect(stub.channel.lines.join("\n")).toContain(
			"the debug session did not start",
		)
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

	// NOTE: "Accept snapshot" is an ordinary run, asked to RECORD what it finds.
	// The Server does the writing — a companion file where it stands, a source
	// as an edit — so all this end has to do is say so.
	it("asks for a run that records what it finds", async () => {
		let session = live()
		let one = site({ name: "renders" })

		session.view.handle(batch({ sites: [one] }))
		session.answer = () => ({ run: 9 })

		await session.view.acceptSnapshots([one.id], [FILE])

		expect(session.asked.at(-1)).toEqual({
			ids: [one.id],
			files: [],
			update: true,
		})
	})

	it("accepts a whole file where it knows no id", async () => {
		let session = live(() => ({ run: 3 }))

		await session.view.acceptSnapshots([], [FILE])

		expect(session.asked.at(-1)).toEqual({
			ids: [],
			files: [FILE],
			update: true,
		})
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
