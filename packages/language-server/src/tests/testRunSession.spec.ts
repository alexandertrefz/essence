import { afterEach, describe, expect, it } from "bun:test"

import { CodeLensRequest, InlayHintRequest } from "vscode-languageserver"

import { TEST_RUN_VERSION } from "../testProtocol"
import {
	type LspSession,
	makeSessionWorkspace,
	startSession,
} from "./lspSession"

// The live test session as an Editor meets it: over the connection, through the
// debounce, with the real Worker behind it. What a client is shown follows from
// the whole loop.

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
			version: TEST_RUN_VERSION,
			kind: "start",
			reason: "open",
		})
		expect(ended).toMatchObject({
			version: TEST_RUN_VERSION,
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

	// A file writing neither Module section publishes from its own entry, which
	// must run for every batch that reached the file, cached or not. See "The
	// analysis loop" in packages/language-server/DEVELOPMENT.md.
	it("publishes a test-failed Diagnostic for a dependency that writes neither section", async () => {
		let sectionless = [
			"implementation {",
			"\tconstant used = 1",
			"}",
			"",
			failing,
		].join("\n")
		let { session, pathOf } = await openWorkspace(
			{
				"Season.tests.es": sectionless,
				"Main.es": `import {\n\tfrom "./Season.tests.es" { used }\n}\n\nimplementation {\n\tconstant seen = 1\n}\n`,
			},
			"Main.es",
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
		// For the clear rather than for a length of time. The run's end arrives
		// before the republish that drops its findings, so a fixed wait races the
		// analysis. See `waitForCodeToClear`.
		await session.waitForCodeToClear(
			pathOf("Season.tests.es"),
			"test-failed",
		)

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

		// For the run that saw the edit, not the second run to end. Opening a
		// file ends two runs of the same text, and on a slow machine both can end
		// before the edit lands. See `waitForTestRunWhere`.
		let run = await session.waitForTestRunWhere(
			"reporting the edit's failure",
			(ended) => ended.counts.failed > 0,
		)

		expect(run).toMatchObject({
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

		expect(result.run).not.toBeNull()

		// Waited for by the number the request answered with, not by its place
		// among ended runs. Opening a file ends two runs of the same text, and on
		// a slow machine the second to end is the session's own.
		let ended = await session.waitForTestRun(result.run as number)

		expect(ended).toMatchObject({ reason: "request" })
	}, 60_000)

	// The ordering a loaded machine falls into, forced: the request goes out
	// once the edit's cycle has started. It is deferred, and answers with the
	// number of the cycle that will run it, which ties the gesture to its results.
	it("answers a request that landed mid-cycle with the cycle that runs it", async () => {
		let { session, pathOf } = await openWorkspace(
			{ "Season.tests.es": passing },
			"Season.tests.es",
		)

		await session.waitForTestRuns(1)
		await session.change(pathOf("Season.tests.es"), failing)

		let flying = await session.waitForRunInFlight()

		let { result } = await session.request<{ run: number | null }>(
			{ method: "essence/runTests" },
			{ files: [pathOf("Season.tests.es")] },
		)

		expect(result.run).not.toBeNull()
		expect(result.run).not.toBe(flying)
		// The request was deferred. A request run at once writes its `start`
		// before its response on the same stream. A number no `start` has named
		// yet belongs to a cycle still to come.
		expect(
			session
				.testRuns()
				.filter((notification) => notification.kind === "start")
				.map((notification) => notification.run),
		).not.toContain(result.run as number)

		let ended = await session.waitForTestRun(result.run as number)

		expect(ended).toMatchObject({
			reason: "request",
			files: [pathOf("Season.tests.es")],
		})
	}, 60_000)

	// The lens spells a test's identity off the parse, the request carries it
	// back, and the runtime selects by it off the manifest. Two spellings of an
	// id would silently run nothing.
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

		let ask = async () => {
			let { result } = await session.request<{ run: number | null }>(
				{ method: "essence/runTests" },
				{ ids: second?.ids, files: [pathOf("Season.tests.es")] },
			)

			expect(result.run).not.toBeNull()

			// Waited for by the number the request answered with, since a run the
			// session starts itself may end in between.
			return session.waitForTestRun(result.run as number)
		}

		// Once, however loaded the machine is. A request landing mid-run is kept
		// whole, and the next cycle runs as that request.
		let ended = await ask()

		expect(ended.ids).toHaveLength(1)

		let started = ended.events.filter(
			(event) => event.kind === "test-start",
		)

		expect(started).toHaveLength(1)
		expect(started[0]).toMatchObject({ name: "two" })

		// The other test's failure stays published. A run narrowed to one test
		// leaves the rest of the file's results as they were.
		await session.settle()

		expect(session.codesFor(pathOf("Season.tests.es"))).toContain(
			"test-failed",
		)
	}, 60_000)

	// A file's tags are a fact about the whole workspace, so its list can move
	// while its text sits still. A section-less file's own entry runs for every
	// batch that reached it, cached or not.
	it("re-publishes a section-less dependency when another file's tags move", async () => {
		let tagged = (tag: string) =>
			[
				"tests {",
				`\ttest "one" tagged ${tag} { expect true }`,
				`\ttest "two" tagged ${tag} { expect true }`,
				"}",
				"",
			].join("\n")
		let main = (tag: string) =>
			[
				"import {",
				'\tfrom "./Season.tests.es" { used }',
				"}",
				"",
				"implementation {",
				"\tconstant seen = 1",
				"}",
				"",
				tagged(tag),
			].join("\n")
		let { session, pathOf } = await openWorkspace(
			{
				"Season.tests.es": [
					"implementation {",
					"\tconstant used = 1",
					"}",
					"",
					"tests {",
					'\ttest "three" tagged netwrok { expect true }',
					"}",
					"",
				].join("\n"),
				"Main.es": main("slow"),
			},
			"Main.es",
		)

		await session.waitForTestRuns(1)
		await session.settle()

		expect(session.codesFor(pathOf("Season.tests.es"))).not.toContain(
			"similar-tags",
		)

		// In the importer, so the section-less file's analysis stays cached and
		// only the workspace's other tags move.
		await session.change(pathOf("Main.es"), main("network"))
		await session.settle()

		expect(session.codesFor(pathOf("Season.tests.es"))).toContain(
			"similar-tags",
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

	// Under `test.contracts`, a file declaring a Namespace has tests: the goals
	// its declarations promise, as a synthesized `contracts` suite. Nothing here
	// writes a `tests { … }` block.
	const namespaceSource = [
		"implementation {",
		"\tnamespace Measures for Integer {",
		"\t\tdoubled() -> Integer {",
		"\t\t\t<- @::multiply(with 2)",
		"\t\t}",
		"\t}",
		"}",
		"",
	].join("\n")

	it("makes an entry of a Namespace where the project asks for contracts", async () => {
		let { session, pathOf } = await openWorkspace(
			{
				"essence.json": JSON.stringify({
					test: { contracts: true },
				}),
				"Measures.es": namespaceSource,
			},
			"Measures.es",
		)
		let [ended] = await session.waitForTestRuns(1)

		expect(ended?.files).toEqual([pathOf("Measures.es")])
		expect(ended?.sites.map((site) => site.suitePath.join("/"))).toEqual([
			"contracts",
		])
		expect(ended?.counts.passed).toBe(1)
	}, 60_000)

	// The project decides. Under a project that said nothing, the same file is
	// no entry, so no Namespace's goals compile unasked.
	it("leaves the same Namespace alone where the project did not ask", async () => {
		let { session, pathOf } = await openWorkspace(
			{
				"essence.json": "{}",
				"Measures.es": namespaceSource,
				"Season.tests.es": passing,
			},
			"Measures.es",
		)
		let [ended] = await session.waitForTestRuns(1)

		expect(ended?.files).toEqual([pathOf("Season.tests.es")])
	}, 60_000)
})
