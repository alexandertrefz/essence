import { describe, expect, it } from "bun:test"

import { findFoldingRanges } from "../lsp/foldingRanges"
import { findSelectionRanges } from "../lsp/selectionRanges"
import { parseWithDiagnostics } from "../parser/index"

function foldingRangesOf(source: string) {
	let { program } = parseWithDiagnostics(source)

	return findFoldingRanges(program)
}

function selectionRangesOf(
	source: string,
	cursor: { line: number; column: number },
) {
	let { program } = parseWithDiagnostics(source)

	return findSelectionRanges(program, cursor)
}

describe("Folding Ranges", () => {
	it("should fold a Protocol declaration", () => {
		let source = [
			"implementation {",
			"\tprotocol Sizable {",
			"\t\tsize() -> Integer",
			"\t}",
			"}",
		].join("\n")

		let ranges = foldingRangesOf(source)

		expect(ranges).toContainEqual({ startLine: 2, endLine: 3 })
	})

	it("should fold the implementation block and a Function, stopping before the closing brace", () => {
		let source = [
			"implementation {",
			"\tfunction greet () -> String {",
			'\t\t<- "Hello"',
			"\t}",
			"}",
		].join("\n")

		let ranges = foldingRangesOf(source)

		expect(ranges).toContainEqual({ startLine: 1, endLine: 4 })
		expect(ranges).toContainEqual({ startLine: 2, endLine: 3 })
	})

	it("should not fold single line constructs", () => {
		let source = ["implementation {", "\tconstant value = 1", "}"].join(
			"\n",
		)

		let ranges = foldingRangesOf(source)

		expect(ranges).toEqual([{ startLine: 1, endLine: 2 }])
	})

	it("should fold Namespaces and each of their Methods", () => {
		let source = [
			"implementation {",
			"\tnamespace Thing for Integer {",
			"\t\tshow() -> String {",
			'\t\t\t<- "42"',
			"\t\t}",
			"\t}",
			"}",
		].join("\n")

		let ranges = foldingRangesOf(source)

		expect(ranges).toContainEqual({ startLine: 2, endLine: 5 })
		expect(ranges).toContainEqual({ startLine: 3, endLine: 4 })
	})

	it("should fold a multi line Match Expression", () => {
		let source = [
			"implementation {",
			"\ttype Value = Integer | String",
			"\tconstant something: Value = 42",
			"\tconstant answer = match something -> String {",
			'\t\tcase Integer { <- "an Integer" }',
			"\t\tcase String  { <- @ }",
			"\t}",
			"}",
		].join("\n")

		expect(foldingRangesOf(source)).toContainEqual({
			startLine: 4,
			endLine: 6,
		})
	})
})

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
})
