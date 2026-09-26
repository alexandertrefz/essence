import { describe, expect, it } from "bun:test"

import type { CodeActionEdit } from "../codeActions"
import { applyEdits } from "./textEdits"

describe("The edit applier", () => {
	let text = "one two three"
	let first: CodeActionEdit = {
		range: { start: { line: 1, column: 1 }, end: { line: 1, column: 4 } },
		newText: "1",
	}
	let last: CodeActionEdit = {
		range: {
			start: { line: 1, column: 9 },
			end: { line: 1, column: 14 },
		},
		newText: "3",
	}

	it("applies an action's edits the same in whatever order it lists them", () => {
		expect(applyEdits(text, [first, last])).toBe("1 two 3")
		expect(applyEdits(text, [last, first])).toBe("1 two 3")
	})

	it("writes insertions at one point in the order the action lists them", () => {
		let at = last.range.start

		expect(
			applyEdits(text, [
				last,
				{ range: { start: at, end: at }, newText: "a " },
				{ range: { start: at, end: at }, newText: "b " },
			]),
		).toBe("one two a b 3")
	})

	it("refuses edits that overlap", () => {
		let across: CodeActionEdit = {
			range: {
				start: { line: 1, column: 3 },
				end: { line: 1, column: 6 },
			},
			newText: "",
		}

		expect(() => applyEdits(text, [first, across])).toThrow(
			"overlapping edits",
		)
	})
})
