import { describe, expect, it } from "bun:test"

import type { common } from "@essence-lang/interfaces"
import type { CoveredPoint, TestEvent } from "@essence-lang/runtime/Testing"

import {
	affectedTests,
	buildAttribution,
	changedRange,
	type EntryAttribution,
} from "../affected"

// `affected.ts` is a function of its arguments, so hand-built events and buffers
// are all these specs need. See "Narrowing a cycle" in
// packages/language-server/DEVELOPMENT.md.

describe("The attribution the session folds out of a run", () => {
	let at = (
		startLine: number,
		startColumn: number,
		endLine: number,
		endColumn: number,
	): common.Position => ({
		start: { line: startLine, column: startColumn },
		end: { line: endLine, column: endColumn },
	})

	let point = (position: common.Position): CoveredPoint => ({
		kind: "statement",
		label: "",
		scope: "",
		position,
		refinement: false,
		tag: null,
		count: 0,
	})

	let coverage = (
		module: string,
		positions: Array<common.Position>,
	): TestEvent => ({
		schema: 1,
		kind: "coverage",
		module,
		points: positions.map(point),
		choices: [],
	})

	let testCoverage = (
		id: string,
		module: string,
		points: Array<number>,
	): TestEvent => ({ schema: 1, kind: "test-coverage", id, module, points })

	let ids = (
		module: Map<string, { tests: Array<Set<string>> }>,
		key: string,
	) => module.get(key)?.tests.map((set) => [...set])

	it("lands a test in exactly the points it names", () => {
		let events = [
			coverage("/A.es", [at(1, 1, 1, 5), at(2, 1, 2, 5), at(3, 1, 3, 5)]),
			testCoverage("t1", "/A.es", [0, 2]),
		]

		let table = buildAttribution(events)

		expect(table.get("/A.es")?.points).toHaveLength(3)
		expect(ids(table, "/A.es")).toEqual([["t1"], [], ["t1"]])
	})

	// The table is keyed by the `coverage` events alone.
	it("drops a test-coverage for a Module with no coverage event", () => {
		let events = [
			coverage("/A.es", [at(1, 1, 1, 5)]),
			testCoverage("t1", "/B.es", [0]),
		]

		let table = buildAttribution(events)

		expect(table.has("/B.es")).toBe(false)
		expect(ids(table, "/A.es")).toEqual([[]])
	})

	it("lands a test that spans two Modules in both", () => {
		let events = [
			coverage("/A.es", [at(1, 1, 1, 5)]),
			coverage("/B.es", [at(1, 1, 1, 5)]),
			testCoverage("t1", "/A.es", [0]),
			testCoverage("t1", "/B.es", [0]),
		]

		let table = buildAttribution(events)

		expect(ids(table, "/A.es")).toEqual([["t1"]])
		expect(ids(table, "/B.es")).toEqual([["t1"]])
	})
})

describe("The span a change touched", () => {
	it("returns the span from the first differing line to the last", () => {
		let oldText = ["alpha", "beta", "gamma"].join("\n")
		let newText = ["alpha", "BETA", "gamma"].join("\n")

		// Lines count from 1 and the end line is included. The end column is one
		// past the old line's last character.
		expect(changedRange(oldText, newText)).toEqual({
			start: { line: 2, column: 1 },
			end: { line: 2, column: 5 },
		})
	})

	it("returns null for identical text", () => {
		let text = ["alpha", "beta"].join("\n")

		expect(changedRange(text, text)).toBeNull()
	})

	// An added line moves every later point, so the stored table no longer
	// describes the file.
	it("refuses an edit that adds a line", () => {
		let oldText = ["alpha", "beta"].join("\n")
		let newText = ["alpha", "beta", "gamma"].join("\n")

		expect(changedRange(oldText, newText)).toBeNull()
	})

	it("refuses an edit that removes a line", () => {
		let oldText = ["alpha", "beta", "gamma"].join("\n")
		let newText = ["alpha", "gamma"].join("\n")

		expect(changedRange(oldText, newText)).toBeNull()
	})

	// A wider span reaches more tests, which is the safe way to be wrong. Line 3
	// never changed and is inside the span.
	it("bounds a scattered in-line edit into one span", () => {
		let oldText = ["a", "b", "c", "d", "e"].join("\n")
		let newText = ["a", "B", "c", "D", "e"].join("\n")

		expect(changedRange(oldText, newText)).toEqual({
			start: { line: 2, column: 1 },
			end: { line: 4, column: 2 },
		})
	})
})

describe("The tests a change reached", () => {
	let pt = (
		line: number,
		count: number,
		kind: CoveredPoint["kind"] = "statement",
	): CoveredPoint => ({
		kind,
		label: "",
		scope: "",
		position: { start: { line, column: 1 }, end: { line, column: 200 } },
		refinement: false,
		tag: null,
		count,
	})

	let entryFor = (
		entry: string,
		points: Array<CoveredPoint>,
		tests: Array<Array<string>>,
		text: string,
		loaded: Array<number> = [],
		module = "/M.es",
	): EntryAttribution => ({
		entry,
		byModule: new Map([
			[
				module,
				{
					points,
					tests: tests.map((each) => new Set(each)),
					loaded: new Set(loaded),
				},
			],
		]),
		text: new Map([[module, text]]),
	})

	const oldText = ["fn", "doubled", "between", "tripled", "end"].join("\n")
	const line2Edited = ["fn", "DOUBLED!", "between", "tripled", "end"].join(
		"\n",
	)
	const line4Edited = ["fn", "doubled", "between", "TRIPLED!", "end"].join(
		"\n",
	)
	const lineAdded = [
		"fn",
		"doubled",
		"EXTRA",
		"between",
		"tripled",
		"end",
	].join("\n")

	// Test "a" reaches line 2 and test "b" reaches line 4, both in one Module.
	let attr = entryFor("/E.es", [pt(2, 1), pt(4, 1)], [["a"], ["b"]], oldText)

	it("returns just the test whose reached line changed", () => {
		expect(
			affectedTests(
				[attr],
				["/M.es"],
				() => line2Edited,
				() => true,
			),
		).toEqual(["a"])
	})

	it("selects the other test when the other line changes", () => {
		expect(
			affectedTests(
				[attr],
				["/M.es"],
				() => line4Edited,
				() => true,
			),
		).toEqual(["b"])
	})

	it("runs whole for an edit that adds a line", () => {
		expect(
			affectedTests(
				[attr],
				["/M.es"],
				() => lineAdded,
				() => true,
			),
		).toBeNull()
	})

	// A point reached at load, such as a top-level Constant, feeds tests whose
	// spans never touched it. An edit there can change a test the attribution
	// cannot name.
	it("runs whole for an edit to a line reached only at load", () => {
		let loaded = entryFor("/E.es", [pt(2, 3)], [[]], oldText)

		expect(
			affectedTests(
				[loaded],
				["/M.es"],
				() => line2Edited,
				() => true,
			),
		).toBeNull()
	})

	// A helper called by a top-level Constant at load and by test "a" directly.
	// Narrowing to "a" would leave every test that read the load-time result
	// stale.
	it("runs whole for a point reached at load even when a test also reached it", () => {
		let shared = entryFor("/E.es", [pt(2, 4)], [["a"]], oldText, [0])

		expect(
			affectedTests(
				[shared],
				["/M.es"],
				() => line2Edited,
				() => true,
			),
		).toBeNull()
	})

	// A dead point narrows to nothing, and an empty result runs whole rather
	// than running no test.
	it("runs whole for an edit to a line nothing reached", () => {
		let dead = entryFor("/E.es", [pt(2, 0)], [[]], oldText)

		expect(
			affectedTests(
				[dead],
				["/M.es"],
				() => line2Edited,
				() => true,
			),
		).toBeNull()
	})

	it("runs whole when nothing changed", () => {
		expect(
			affectedTests(
				[attr],
				["/M.es"],
				() => oldText,
				() => true,
			),
		).toBeNull()
	})

	it("ignores a changed file the entry does not reach", () => {
		// `reaches` answers false, so the file is not this entry's concern and
		// nothing is left to narrow to.
		expect(
			affectedTests(
				[attr],
				["/Other.es"],
				() => "x",
				() => false,
			),
		).toBeNull()

		// An unreached change does not veto the narrowing the edit to /M.es
		// produces.
		expect(
			affectedTests(
				[attr],
				["/M.es", "/Other.es"],
				(file) => (file === "/M.es" ? line2Edited : "x"),
				() => false,
			),
		).toEqual(["a"])
	})

	it("runs whole for a changed file it reaches but does not hold", () => {
		expect(
			affectedTests(
				[attr],
				["/Other.es"],
				() => "x",
				() => true,
			),
		).toBeNull()
	})

	it("runs whole for a reached file it kept no snapshot of", () => {
		let noSnapshot: EntryAttribution = {
			entry: "/E.es",
			byModule: new Map([
				[
					"/Other.es",
					{
						points: [pt(2, 1)],
						tests: [new Set(["a"])],
						loaded: new Set<number>(),
					},
				],
			]),
			text: new Map(),
		}

		expect(
			affectedTests(
				[noSnapshot],
				["/Other.es"],
				() => "x",
				() => true,
			),
		).toBeNull()
	})

	it("unions the tests two entries each reached", () => {
		let doubles = entryFor("/E1.es", [pt(2, 1)], [["a"]], oldText)
		let triples = entryFor("/E2.es", [pt(2, 1)], [["b"]], oldText)

		expect(
			affectedTests(
				[doubles, triples],
				["/M.es"],
				() => line2Edited,
				() => true,
			)?.sort(),
		).toEqual(["a", "b"])
	})
})
