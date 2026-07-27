import { describe, expect, it } from "bun:test"

import { SourceMapGenerator } from "source-map"

import { planBreakpoints } from "../breakpoints"
import { BundleMap } from "../maps"

// NOTE: A hand-built map standing in for a compiled bundle: two statements of
// `/work/App.es` — lines 3 and 5 — landing on generated lines 10 and 12, and
// a runtime line that maps to nothing.
function testMap(): BundleMap {
	let generator = new SourceMapGenerator({ file: "App.js" })

	generator.addMapping({
		generated: { line: 10, column: 0 },
		original: { line: 3, column: 1 },
		source: "/work/App.es",
	})
	generator.addMapping({
		generated: { line: 12, column: 0 },
		original: { line: 5, column: 1 },
		source: "/work/App.es",
	})
	generator.setSourceContent("/work/App.es", "source text")

	return new BundleMap(JSON.parse(generator.toString()))
}

describe("planBreakpoints", () => {
	it("lands a mapped line on its generated position", () => {
		let [plan] = planBreakpoints(testMap(), "/work/App.es", [3])

		expect(plan!.verified).toBe(true)
		expect(plan!.line).toBe(3)
		// NOTE: 0-based, CDP's convention — the map spoke 1-based line 10.
		expect(plan!.generated).toEqual({ line: 9, column: 0 })
	})

	// NOTE: A breakpoint on a blank line slides forward to the next
	// statement, and the answered line says so.
	it("slides an unmapped line to the next statement", () => {
		let [plan] = planBreakpoints(testMap(), "/work/App.es", [4])

		expect(plan!.verified).toBe(true)
		expect(plan!.line).toBe(5)
		expect(plan!.generated).toEqual({ line: 11, column: 0 })
	})

	it("refuses a file the program does not contain", () => {
		let [plan] = planBreakpoints(testMap(), "/elsewhere/Other.es", [1])

		expect(plan!.verified).toBe(false)
		expect(plan!.message).toContain("not part of the launched program")
	})

	it("refuses everything without a map, and says why", () => {
		let plans = planBreakpoints(null, "/work/App.es", [3, 5])

		expect(plans.map((plan) => plan.verified)).toEqual([false, false])
		expect(plans[0]!.message).toContain("no source map")
	})

	it("answers in request order", () => {
		let plans = planBreakpoints(testMap(), "/work/App.es", [5, 3])

		expect(plans.map((plan) => plan.requestedLine)).toEqual([5, 3])
		expect(plans.map((plan) => plan.line)).toEqual([5, 3])
	})
})
