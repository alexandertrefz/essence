import { describe, expect, it } from "bun:test"

import { attributionOf, coveringPoints } from "@essence-lang/compiler/testing"
import type { common } from "@essence-lang/interfaces"
import type { CoveredPoint, TestEvent } from "@essence-lang/runtime/Testing"

// The coverage-attribution join that the `--mutate` driver and the Language
// Server's live session both read. The join reads only events, so these specs
// build them by hand.

describe("The attribution table", () => {
	let at = (
		startLine: number,
		startColumn: number,
		endLine: number,
		endColumn: number,
	): common.Position => ({
		start: { line: startLine, column: startColumn },
		end: { line: endLine, column: endColumn },
	})

	// The join reads only the position. The other fields hold what the runtime
	// emits, so the fixture is a real event.
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

	it("indexes each Module's points by their position", () => {
		let events = [coverage("/A.es", [at(1, 1, 1, 5), at(2, 1, 2, 5)])]

		let table = attributionOf(events)

		expect(table.get("/A.es")?.points).toEqual([
			at(1, 1, 1, 5),
			at(2, 1, 2, 5),
		])
		expect(table.get("/A.es")?.tests).toEqual([[], []])
	})

	it("appends an id to exactly the points it names", () => {
		let events = [
			coverage("/A.es", [at(1, 1, 1, 5), at(2, 1, 2, 5), at(3, 1, 3, 5)]),
			testCoverage("t1", "/A.es", [0, 2]),
		]

		expect(attributionOf(events).get("/A.es")?.tests).toEqual([
			["t1"],
			[],
			["t1"],
		])
	})

	it("gathers every test that named a point, in the order they were met", () => {
		let events = [
			coverage("/A.es", [at(1, 1, 1, 5)]),
			testCoverage("t1", "/A.es", [0]),
			testCoverage("t2", "/A.es", [0]),
		]

		expect(attributionOf(events).get("/A.es")?.tests).toEqual([
			["t1", "t2"],
		])
	})

	// The table is keyed by the `coverage` events alone, so no row is invented
	// for an uninstrumented Module.
	it("drops a test-coverage for a Module with no coverage event", () => {
		let events = [
			coverage("/A.es", [at(1, 1, 1, 5)]),
			testCoverage("t1", "/B.es", [0]),
		]

		let table = attributionOf(events)

		expect(table.has("/B.es")).toBe(false)
		expect(table.get("/A.es")?.tests).toEqual([[]])
	})

	it("lands a test that spans two Modules in both", () => {
		let events = [
			coverage("/A.es", [at(1, 1, 1, 5)]),
			coverage("/B.es", [at(1, 1, 1, 5)]),
			testCoverage("t1", "/A.es", [0]),
			testCoverage("t1", "/B.es", [0]),
		]

		let table = attributionOf(events)

		expect(table.get("/A.es")?.tests).toEqual([["t1"]])
		expect(table.get("/B.es")?.tests).toEqual([["t1"]])
	})
})

describe("The attribution join", () => {
	let at = (
		startLine: number,
		startColumn: number,
		endLine: number,
		endColumn: number,
	): common.Position => ({
		start: { line: startLine, column: startColumn },
		end: { line: endLine, column: endColumn },
	})

	it("takes every point whose span holds the site", () => {
		let points = [at(1, 1, 9, 1), at(3, 1, 3, 20), at(20, 1, 20, 5)]

		expect(coveringPoints(points, at(3, 4, 3, 10))).toEqual([0, 1])
	})

	// A site the Simplifier trimmed differently from the counter's Node overlaps
	// rather than nests. Answering with nothing would report a tested site as
	// one no test reaches.
	it("falls back to every overlapping span", () => {
		let points = [at(1, 1, 4, 30), at(3, 1, 4, 8), at(9, 1, 9, 5)]

		expect(coveringPoints(points, at(4, 6, 5, 2))).toEqual([0, 1])
	})

	// A site that straddles two points is reached by whatever reached either.
	// Taking one point alone would leave a covering test out.
	it("takes both points a site straddles", () => {
		let points = [at(3, 1, 3, 20), at(3, 25, 4, 4)]

		expect(coveringPoints(points, at(3, 15, 3, 30))).toEqual([0, 1])
	})

	it("answers with nothing where no point comes near", () => {
		let points = [at(1, 1, 2, 4), at(9, 1, 9, 5)]

		expect(coveringPoints(points, at(5, 1, 5, 9))).toEqual([])
	})
})
