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
			"\tTerminal.inspect(identity(identity(1)))",
			"}",
		].join("\n")

		// NOTE: The cursor sits on the `1` inside the innermost call.
		let ranges = selectionRangesOf(source, { line: 5, column: 37 })

		expect(ranges.slice(0, 4)).toEqual([
			// NOTE: The literal, then each enclosing call, then `Terminal.inspect(…)`.
			{
				start: { line: 5, column: 37 },
				end: { line: 5, column: 38 },
			},
			{
				start: { line: 5, column: 28 },
				end: { line: 5, column: 39 },
			},
			{
				start: { line: 5, column: 19 },
				end: { line: 5, column: 40 },
			},
			{
				start: { line: 5, column: 2 },
				end: { line: 5, column: 41 },
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

// NOTE: A default is a span of its own inside no body, so expanding from inside
// one has to reach it — otherwise the selection jumps straight from the name to
// the whole Declaration.
describe("Selection Ranges inside a default", () => {
	it("should widen from a name in a default out through the default", () => {
		let source = [
			"implementation {",
			"\tconstant fallback = 1",
			"",
			"\tfunction scaled(_ factor: Integer = fallback) -> Integer {",
			"\t\t<- factor",
			"\t}",
			"}",
		].join("\n")

		let ranges = selectionRangesOf(source, { line: 4, column: 40 })

		expect(ranges[0]).toEqual({
			start: { line: 4, column: 38 },
			end: { line: 4, column: 46 },
		})
	})
})

// NOTE: A Case payload's default is a span inside no body either — without the
// descent the selection jumps from the name straight to the whole Choice.
describe("Selection Ranges inside a Case payload default", () => {
	it("should widen from a name in a payload default out through the default", () => {
		let source = [
			"implementation {",
			"\tconstant none = 0",
			"",
			"\tchoice Fetch {",
			"\t\tGet { retries: Integer } = { retries = none },",
			"\t}",
			"}",
		].join("\n")

		let ranges = selectionRangesOf(source, { line: 5, column: 42 })

		expect(ranges[0]).toEqual({
			start: { line: 5, column: 42 },
			end: { line: 5, column: 46 },
		})
	})

	it("should widen from a path's step to the whole path", () => {
		let source = [
			"implementation {",
			"\ttype Maker = { town: String }",
			"\ttype Product = { maker: Maker }",
			"\tconstant products: List<Product> = []",
			"\tconstant towns = products::map(.maker.town)",
			"}",
		].join("\n")

		let ranges = selectionRangesOf(source, { line: 5, column: 41 })

		expect(ranges[0]).toEqual({
			start: { line: 5, column: 40 },
			end: { line: 5, column: 44 },
		})
		expect(ranges[1]).toEqual({
			start: { line: 5, column: 33 },
			end: { line: 5, column: 44 },
		})
	})
})

// NOTE: An arm has a Position of its own covering `as VALUE if CONDITION`, so
// it stands on the chain between what is written in it and the whole `define` —
// the same answer a Dictionary entry gets, and one a Match Handler can not give.
describe("Selection Ranges inside a define", () => {
	let source = [
		"implementation {",
		"\tfunction grade (_ score: Integer) -> String {",
		"\t\t<- define {",
		'\t\t\tas "A" if score::isGreaterThan(90)',
		'\t\t\tas "F" otherwise',
		"\t\t}",
		"\t}",
		"}",
	].join("\n")

	let arm = {
		start: { line: 4, column: 4 },
		end: { line: 4, column: 38 },
	}
	let block = {
		start: { line: 3, column: 6 },
		end: { line: 6, column: 4 },
	}

	it("should widen from a name in a condition to its arm and then the block", () => {
		let ranges = selectionRangesOf(source, { line: 4, column: 14 })
		let armIndex = ranges.findIndex(
			(range) =>
				range.start.line === arm.start.line &&
				range.start.column === arm.start.column,
		)
		let blockIndex = ranges.findIndex(
			(range) =>
				range.start.line === block.start.line &&
				range.start.column === block.start.column,
		)

		expect(ranges).toContainEqual(arm)
		expect(ranges).toContainEqual(block)
		// NOTE: Innermost first, so the arm stands in front of the block it is
		// an arm of.
		expect(armIndex).toBeLessThan(blockIndex)
	})

	it("should hand out the otherwise arm as its own range", () => {
		expect(
			selectionRangesOf(source, { line: 5, column: 8 }),
		).toContainEqual({
			start: { line: 5, column: 4 },
			end: { line: 5, column: 20 },
		})
	})
})
