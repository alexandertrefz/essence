import { describe, expect, it } from "bun:test"

import { parseWithDiagnostics } from "@essence/compiler/parser"

import { findFoldingRanges } from "../foldingRanges"

function foldingRangesOf(source: string) {
	let { program } = parseWithDiagnostics(source)

	return findFoldingRanges(program)
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

	it("should fold a generic Choice declaration", () => {
		let source = [
			"implementation {",
			"\tchoice Box<Value> {",
			"\t\tHolding { value: Value },",
			"\t\tEmpty,",
			"\t}",
			"}",
		].join("\n")

		let ranges = foldingRangesOf(source)

		expect(ranges).toContainEqual({ startLine: 2, endLine: 4 })
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

	it("should fold a Guard spelled across several lines", () => {
		let source = [
			"implementation {",
			"\tconstant amount: Integer | String = 4",
			"\tconstant label = match amount -> String {",
			"\t\tcase Integer where @::isBetween(",
			"\t\t\t1,",
			"\t\t\tand 10,",
			'\t\t) { <- "small" }',
			'\t\tcase Integer { <- "big" }',
			"\t\tcase String { <- @ }",
			"\t}",
			"}",
		].join("\n")

		expect(foldingRangesOf(source)).toContainEqual({
			startLine: 4,
			endLine: 6,
		})
	})
})
