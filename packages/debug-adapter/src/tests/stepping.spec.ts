import { describe, expect, it } from "bun:test"

import { SourceMapGenerator } from "source-map"

import { BundleMap } from "../maps"
import { blackboxPositions } from "../stepping"

function mapWithLines(lines: Array<number>): BundleMap {
	let generator = new SourceMapGenerator({ file: "App.js" })

	for (let line of lines) {
		generator.addMapping({
			generated: { line, column: 0 },
			original: { line, column: 0 },
			source: "/work/App.es",
		})
	}

	return new BundleMap(JSON.parse(generator.toString()))
}

describe("blackboxPositions", () => {
	// NOTE: The toggles: blackboxed from the top of the file, plain across
	// each run of mapped lines, blackboxed again after. Lines here are the
	// map's 1-based ones, positions CDP's 0-based ones.
	it("wraps each run of mapped lines in toggles", () => {
		expect(blackboxPositions(mapWithLines([11, 12, 21]))).toEqual([
			{ lineNumber: 0, columnNumber: 0 },
			{ lineNumber: 10, columnNumber: 0 },
			{ lineNumber: 12, columnNumber: 0 },
			{ lineNumber: 20, columnNumber: 0 },
			{ lineNumber: 21, columnNumber: 0 },
		])
	})

	it("drops the degenerate leading pair when line one is mapped", () => {
		expect(blackboxPositions(mapWithLines([1, 2]))).toEqual([
			{ lineNumber: 2, columnNumber: 0 },
		])
	})

	it("answers nothing for an empty map", () => {
		expect(blackboxPositions(mapWithLines([]))).toEqual([])
	})
})
