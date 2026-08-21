import { afterEach, describe, expect, it } from "bun:test"

import { CodeLensRequest, InlayHintRequest } from "vscode-languageserver"

import {
	type LspSession,
	makeSessionWorkspace,
	startSession,
} from "./lspSession"

// NOTE: The live test session as an Editor meets it: over the connection,
// through the debounce, with the real Worker compiling and running behind it.
// What every other spec in this package asks of a function, this asks of the
// loop — because what a client is shown is a consequence of the whole of it.

const failing = [
	"tests {",
	'\ttest "adds up" {',
	"\t\tconstant total = 2::add(2)",
	"",
	"\t\texpect total::is(5)",
	"\t}",
	"}",
	"",
].join("\n")

const passing = failing.replace("::is(5)", "::is(4)")

let live: LspSession | null = null
let disposeWorkspace: (() => void) | null = null

afterEach(async () => {
	await live?.dispose()
	disposeWorkspace?.()
	live = null
	disposeWorkspace = null
})

async function openWorkspace(
	files: Record<string, string>,
	open: string,
): Promise<{ session: LspSession; pathOf: (name: string) => string }> {
	let workspace = makeSessionWorkspace(files)
	let session = startSession()

	live = session
	disposeWorkspace = workspace.dispose

	await session.initialize([workspace.root])
	await session.open(workspace.pathOf(open), files[open]!)

	return { session, pathOf: workspace.pathOf }
}

describe("The Server's live test session", () => {
	it("pushes essence/testRun with the batch a run produced", async () => {
		let { session, pathOf } = await openWorkspace(
			{ "Season.tests.es": failing },
			"Season.tests.es",
		)
		let [ended] = await session.waitForTestRuns(1)

		expect(session.testRuns()[0]).toMatchObject({
			version: 1,
			kind: "start",
			reason: "open",
		})
		expect(ended).toMatchObject({
			version: 1,
			kind: "end",
			compiled: true,
			counts: { passed: 0, failed: 1, skipped: 0, deselected: 0 },
			files: [pathOf("Season.tests.es")],
		})
		expect(ended?.events.map((event) => event.kind)).toContain("test-fail")
	}, 60_000)

	it("publishes a failed expect as a test-failed Diagnostic", async () => {
		let { session, pathOf } = await openWorkspace(
			{ "Season.tests.es": failing },
			"Season.tests.es",
		)

		await session.waitForTestRuns(1)
		await session.settle()

		expect(session.codesFor(pathOf("Season.tests.es"))).toContain(
			"test-failed",
		)
	}, 60_000)

	it("clears the Diagnostic once the test holds again", async () => {
		let { session, pathOf } = await openWorkspace(
			{ "Season.tests.es": failing },
			"Season.tests.es",
		)

		await session.waitForTestRuns(1)
		await session.change(pathOf("Season.tests.es"), passing)
		await session.waitForTestRuns(2)
		await session.settle()

		expect(session.codesFor(pathOf("Season.tests.es"))).not.toContain(
			"test-failed",
		)
	}, 60_000)

	it("answers a Code Lens request with Run and Debug", async () => {
		let { session, pathOf } = await openWorkspace(
			{ "Season.tests.es": failing },
			"Season.tests.es",
		)
		let { result } = await session.request<
			Array<{ command: { command: string; title: string } }>
		>(CodeLensRequest.type, {
			textDocument: { uri: `file://${pathOf("Season.tests.es")}` },
		})

		expect(result.map((lens) => lens.command.title)).toEqual([
			"Run",
			"Debug",
		])
		expect(result[0]?.command.command).toBe("essence.test.run")
	}, 60_000)

	it("draws the values a run recorded as inlay hints", async () => {
		let { session, pathOf } = await openWorkspace(
			{ "Season.tests.es": failing },
			"Season.tests.es",
		)

		await session.waitForTestRuns(1)

		let { result } = await session.request<
			Array<{ label: string; kind: number }>
		>(InlayHintRequest.type, {
			textDocument: { uri: `file://${pathOf("Season.tests.es")}` },
			range: {
				start: { line: 0, character: 0 },
				end: { line: 8, character: 0 },
			},
		})

		expect(result.map((hint) => hint.label)).toContain("4")
		expect(result.map((hint) => hint.label)).toContain("4 is not 5")
	}, 60_000)

	it("re-runs on an edit that was never saved", async () => {
		let { session, pathOf } = await openWorkspace(
			{ "Season.tests.es": passing },
			"Season.tests.es",
		)

		await session.waitForTestRuns(1)
		await session.change(pathOf("Season.tests.es"), failing)

		let runs = await session.waitForTestRuns(2)

		expect(runs[1]).toMatchObject({
			reason: "change",
			counts: { failed: 1 },
		})
	}, 60_000)

	it("runs one test on essence/runTests", async () => {
		let { session, pathOf } = await openWorkspace(
			{ "Season.tests.es": passing },
			"Season.tests.es",
		)

		await session.waitForTestRuns(1)

		let { result } = await session.request<{ run: number | null }>(
			{ method: "essence/runTests" },
			{ files: [pathOf("Season.tests.es")] },
		)

		expect(result.run).toBe(2)

		let runs = await session.waitForTestRuns(2)

		expect(runs[1]).toMatchObject({ reason: "request" })
	}, 60_000)

	// NOTE: The whole round trip of a structural identity: the lens spells one
	// off the PARSE, the request carries it back, and the runtime selects by it
	// off the MANIFEST. Two spellings of an id would silently run nothing, and
	// nothing else in this suite would notice.
	it("runs the very test a lens names", async () => {
		let { session, pathOf } = await openWorkspace(
			{
				"Season.tests.es": [
					"tests {",
					'\ttest "one" { expect 2::is(3) }',
					'\ttest "two" { expect true }',
					"}",
					"",
				].join("\n"),
			},
			"Season.tests.es",
		)

		await session.waitForTestRuns(1)

		let lenses = await session.request<
			Array<{ command: { arguments: Array<{ ids: Array<string> }> } }>
		>(CodeLensRequest.type, {
			textDocument: { uri: `file://${pathOf("Season.tests.es")}` },
		})
		let second = lenses.result[2]?.command.arguments[0]

		expect(second?.ids).toHaveLength(1)

		await session.request<{ run: number | null }>(
			{ method: "essence/runTests" },
			{ ids: second?.ids, files: [pathOf("Season.tests.es")] },
		)

		let runs = await session.waitForTestRuns(2)
		let started = (runs[1]?.events ?? []).filter(
			(event) => event.kind === "test-start",
		)

		expect(started).toHaveLength(1)
		expect(started[0]).toMatchObject({ name: "two" })

		// NOTE: And the OTHER test is still reported as it was — its failure is
		// still published. A run narrowed to one test may not be read as
		// "forget the rest", which is what adopting the deselections the batch
		// also carries would do.
		await session.settle()

		expect(session.codesFor(pathOf("Season.tests.es"))).toContain(
			"test-failed",
		)
	}, 60_000)

	it("publishes what the workspace's tags say about each other", async () => {
		let { session, pathOf } = await openWorkspace(
			{
				"Season.tests.es": [
					"tests {",
					'\ttest "one" tagged network { expect true }',
					'\ttest "two" tagged network { expect true }',
					'\ttest "three" tagged netwrok { expect true }',
					"}",
					"",
				].join("\n"),
			},
			"Season.tests.es",
		)

		await session.waitForTestRuns(1)
		await session.settle()

		expect(session.codesFor(pathOf("Season.tests.es"))).toContain(
			"similar-tags",
		)
	}, 60_000)
})
