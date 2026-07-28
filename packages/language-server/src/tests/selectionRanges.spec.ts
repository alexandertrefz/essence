import { describe, expect, it } from "bun:test"

import { parseWithDiagnostics } from "@essence-lang/compiler/parser"

import { findSelectionRanges } from "../selectionRanges"

function selectionRangesOf(
	source: string,
	cursor: { line: number; column: number },
) {
	let { program } = parseWithDiagnostics(source)

	return findSelectionRanges(program, cursor)
}

describe("Selection Ranges", () => {
	it("should widen from the Identifier out to the implementation block", () => {
		let source = [
			"implementation {",
			"\tconstant greeting = value",
			"}",
		].join("\n")

		let ranges = selectionRangesOf(source, { line: 2, column: 22 })

		// NOTE: Innermost first — the Identifier, then the Statement, then the
		// implementation block.
		expect(ranges[0].start).toEqual({ line: 2, column: 22 })
		expect(ranges[0].end).toEqual({ line: 2, column: 27 })
		expect(ranges[ranges.length - 1].start.line).toBe(1)
		expect(ranges[ranges.length - 1].end.line).toBe(3)
	})

	it("should step through nested invocations innermost first", () => {
		let source = [
			"implementation {",
			"\tfunction identity (_ value: Integer) -> Integer {",
			"\t\t<- value",
			"\t}",
			"\t__print(identity(identity(1)))",
			"}",
		].join("\n")

		// NOTE: The cursor sits on the `1` inside the innermost call.
		let ranges = selectionRangesOf(source, { line: 5, column: 28 })

		expect(ranges.slice(0, 4)).toEqual([
			// NOTE: The literal, then each enclosing call, then `__print(…)`.
			{
				start: { line: 5, column: 28 },
				end: { line: 5, column: 29 },
			},
			{
				start: { line: 5, column: 19 },
				end: { line: 5, column: 30 },
			},
			{
				start: { line: 5, column: 10 },
				end: { line: 5, column: 31 },
			},
			{
				start: { line: 5, column: 2 },
				end: { line: 5, column: 32 },
			},
		])

		// NOTE: Widening ends at the implementation block.
		expect(ranges[ranges.length - 1]).toEqual({
			start: { line: 1, column: 1 },
			end: { line: 6, column: 2 },
		})
	})

	it("should return nothing outside the implementation block", () => {
		let source = ["implementation {", "\tconstant value = 1", "}"].join(
			"\n",
		)

		expect(selectionRangesOf(source, { line: 4, column: 1 })).toEqual([])
	})

	describe("inside a Match Handler", () => {
		let source = [
			"implementation {",
			"\ttype Point = { x: Integer, y: Integer }",
			"",
			"\tfunction describe (_ value: Integer | Point) -> String {",
			"\t\t<- match value -> String {",
			'\t\t\tcase 0 { <- "zero" }',
			'\t\t\tcase Integer where @::isNegative() { <- "negative" }',
			'\t\t\tcase Integer { <- "positive" }',
			'\t\t\tcase { x = 0, y: Integer } { <- "the y axis" }',
			'\t\t\tcase { x: Integer, y: Integer } { <- "elsewhere" }',
			"\t\t}",
			"\t}",
			"}",
		].join("\n")

		// NOTE: The Match is the next range out in both cases — a Handler has
		// no Position of its own to widen to.
		it("should start at the Guard the cursor is in", () => {
			let ranges = selectionRangesOf(source, { line: 7, column: 30 })

			expect(ranges[0]).toEqual({
				start: { line: 7, column: 23 },
				end: { line: 7, column: 38 },
			})
			expect(ranges[1].start).toEqual({ line: 5, column: 6 })
		})

		it("should start at a Record Matcher's member literal", () => {
			let ranges = selectionRangesOf(source, { line: 9, column: 15 })

			expect(ranges[0]).toEqual({
				start: { line: 9, column: 15 },
				end: { line: 9, column: 16 },
			})
			expect(ranges[1].start).toEqual({ line: 5, column: 6 })
		})

		it("should start at the body Statement for an ordinary Case", () => {
			let ranges = selectionRangesOf(source, { line: 8, column: 26 })

			expect(ranges[0]).toEqual({
				start: { line: 8, column: 22 },
				end: { line: 8, column: 32 },
			})
			expect(ranges[ranges.length - 1]).toEqual({
				start: { line: 1, column: 1 },
				end: { line: 13, column: 2 },
			})
		})
	})
})
