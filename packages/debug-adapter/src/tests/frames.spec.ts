import { describe, expect, it } from "bun:test"

import { SourceMapGenerator } from "source-map"

import { type CdpCallFrame, presentFrames } from "../frames"
import { BundleMap } from "../maps"

// NOTE: A bundle whose lines 20-24 belong to `/work/App.es` and whose line 40
// belongs to nothing — the shape a real bundle has after the map was confined
// to Essence sources.
function testMap(): BundleMap {
	let generator = new SourceMapGenerator({ file: "App.js" })

	for (let line = 20; line <= 24; line++) {
		generator.addMapping({
			generated: { line, column: 0 },
			original: { line: line - 15, column: 1 },
			source: "/work/App.es",
		})
	}

	return new BundleMap(JSON.parse(generator.toString()))
}

function frame(
	name: string,
	generatedLine: number,
	index: number,
): CdpCallFrame {
	return {
		callFrameId: `frame-${index}`,
		functionName: name,
		location: { scriptId: "1", lineNumber: generatedLine, columnNumber: 0 },
	}
}

describe("presentFrames", () => {
	it("maps user frames and demangles their names", () => {
		let presented = presentFrames(
			[frame("$user_ok_3f_", 19, 0)],
			testMap(),
			"hide",
		)

		expect(presented).toHaveLength(1)
		expect(presented[0]!.name).toBe("ok?")
		expect(presented[0]!.kind).toBe("user")
		expect(presented[0]!.source).toEqual({
			source: "/work/App.es",
			line: 5,
			column: 1,
		})
	})

	it("hides glue by default and greys it out on request", () => {
		let frames = [
			frame("greet", 19, 0),
			frame("dispatchMethod", 39, 1),
			frame("greet", 21, 2),
		]

		expect(
			presentFrames(frames, testMap(), "hide").map(
				(presented) => presented.name,
			),
		).toEqual(["greet", "greet"])

		let subtle = presentFrames(frames, testMap(), "subtle")

		expect(subtle.map((presented) => presented.kind)).toEqual([
			"user",
			"glue",
			"user",
		])
	})

	it("keeps standard library frames, subtle, under their Essence names", () => {
		let presented = presentFrames(
			[frame("$es_List_sorted__overload$1", 39, 0)],
			testMap(),
			"hide",
		)

		expect(presented[0]!.kind).toBe("stdlib")
		expect(presented[0]!.name).toBe("List.sorted")
		expect(presented[0]!.source).toBeNull()
	})

	// NOTE: The match merge — one construct, two frames, and the anonymous
	// one absorbs its caller's name while keeping its own position and its
	// own call frame, whose scope chain holds the handler's bindings.
	it("collapses a match's IIFE into its caller", () => {
		let presented = presentFrames(
			[frame("", 21, 0), frame("greet", 19, 1), frame("main", 23, 2)],
			testMap(),
			"hide",
		)

		expect(presented.map((frame) => frame.name)).toEqual(["greet", "main"])
		expect(presented[0]!.callFrameIndex).toBe(0)
		expect(presented[0]!.source?.line).toBe(7)
	})

	// NOTE: A Function value handed to the standard library also arrives
	// anonymous — but it sits over glue, not over a user frame, so it is NOT
	// absorbed; it reads as `match`, the one anonymous thing user code emits
	// in place.
	it("does not absorb an anonymous frame that sits over glue", () => {
		let presented = presentFrames(
			[
				frame("", 21, 0),
				frame("$es_List_map", 39, 1),
				frame("main", 23, 2),
			],
			testMap(),
			"hide",
		)

		expect(presented.map((frame) => frame.name)).toEqual([
			"match",
			"List.map",
			"main",
		])
	})

	it("works without a map at all", () => {
		let presented = presentFrames([frame("greet", 19, 0)], null, "hide")

		expect(presented).toEqual([])
	})
})
