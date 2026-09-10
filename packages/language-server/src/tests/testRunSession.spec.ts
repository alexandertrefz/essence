import { afterEach, describe, expect, it } from "bun:test"

import { CodeLensRequest, InlayHintRequest } from "vscode-languageserver"

import { TEST_RUN_VERSION } from "../testProtocol"
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

	// NOTE: A file writing NEITHER Module section is judged by an entry of its
	// own rather than by the graph that reaches it — the graph's answer for such
	// a file is dropped — so the root above it publishes nothing for it, and its
	// own entry is what carries what a run found there. It has to run for every
	// batch that reached it, cached analysis or not: an entry that does not run
	// publishes nothing, and results arriving move nothing about the source.
	//
	// The state is the ordinary one for a file whose `export` block is still
	// being written, which is a file somebody is very likely running the tests
	// of.
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
		// NOTE: For the CLEAR rather than for a length of time. The run's end
		// crosses the wire before the republish that drops what it found does,
		// so a test that waits out a fixed settle here is betting that the
		// analysis between the two fits inside it — a bet this machine wins and
		// a loaded runner loses. See `waitForCodeToClear`.
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

	// NOTE: What a file's tags say is a fact about the WHOLE workspace, so the
	// list published for one can move while its own text sits still — and a file
	// writing neither Module section has nothing but its own entry to publish it.
	// That entry has to run for every batch that reached the file, whether or
	// not its analysis is still cached, which is the difference between "nothing
	// has judged this" and "nothing ever judges this".
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

		// NOTE: In the IMPORTER, so nothing about the section-less file moves —
		// its analysis stays cached, and the only thing that changed about it is
		// what the workspace's other tags now look like.
		await session.change(pathOf("Main.es"), main("network"))
		await session.settle(800)

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

	// NOTE: A file is an entry because it has tests, and under a project that
	// asked for `test.contracts` a file declaring a Namespace HAS them: the
	// goals its declarations promise, synthesized into a `contracts` suite by
	// the compile. Nothing here wrote a `tests { … }` block at all.
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

	// NOTE: And it is the PROJECT that decides. The same file under a project
	// that said nothing is no entry at all, so a workspace that never asked for
	// the goals does not start compiling and running every Namespace it holds.
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
