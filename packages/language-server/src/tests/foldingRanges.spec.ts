import { describe, expect, it } from "bun:test"
import { readFileSync } from "node:fs"

import {
	type ParserOptions,
	parseWithDiagnostics,
} from "@essence-lang/compiler/parser"
import { fixturePath } from "@essence-lang/fixtures"

import { findFoldingRanges } from "../foldingRanges"

function foldingRangesOf(source: string, options?: ParserOptions) {
	let { program } = parseWithDiagnostics(source, options)

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

	it("should fold a multi line Case payload", () => {
		let source = [
			"implementation {",
			"\tchoice Shape {",
			"\t\tRect { width: Integer, height: Integer },",
			"\t}",
			"\tconstant shape: Shape = #Rect({",
			"\t\twidth = 3,",
			"\t\theight = 4,",
			"\t})",
			"}",
		].join("\n")

		expect(foldingRangesOf(source)).toContainEqual({
			startLine: 5,
			endLine: 7,
		})
	})

	it("should fold an overload function block and its bodied entries", () => {
		let source = [
			"declarations {",
			"\toverload function double {",
			"\t\t(_ value: Integer) -> Integer",
			"",
			"\t\t(over values: Integer) -> Integer {",
			"\t\t\t<- values",
			"\t\t}",
			"\t}",
			"}",
		].join("\n")

		let ranges = foldingRangesOf(source, { allowDeclarationsHeader: true })

		expect(ranges).toContainEqual({ startLine: 2, endLine: 7 })
		expect(ranges).toContainEqual({ startLine: 5, endLine: 6 })
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

describe("Folding the Module sections", () => {
	it("should fold an import block and an export block", () => {
		let ranges = foldingRangesOf(
			[
				"import {",
				'\tfrom "./Geometry.es" { Rectangle }',
				'\tfrom "./Bounds.es" { Box }',
				"}",
				"implementation {",
				"\tconstant one = 1",
				"}",
				"export {",
				"\tone",
				"}",
			].join("\n"),
		)

		expect(ranges).toContainEqual({ startLine: 1, endLine: 3 })
		expect(ranges).toContainEqual({ startLine: 8, endLine: 9 })
	})

	// A group written out folds on its own; one written flat has no
	// lines to fold.
	it("should fold a group written out over lines", () => {
		let ranges = foldingRangesOf(
			[
				"import {",
				'\tfrom "./Geometry.es" {',
				"\t\tCircle",
				"\t\tRectangle",
				"\t}",
				'\tfrom "./Bounds.es" { Box }',
				"}",
				"implementation {",
				"\tconstant one = 1",
				"}",
			].join("\n"),
		)

		expect(ranges).toContainEqual({ startLine: 1, endLine: 6 })
		expect(ranges).toContainEqual({ startLine: 2, endLine: 4 })
		expect(ranges.filter((range) => range.startLine === 6)).toEqual([])
	})

	it("should leave a Program that writes neither section alone", () => {
		let ranges = foldingRangesOf(
			["implementation {", "\tconstant one = 1", "}"].join("\n"),
		)

		expect(ranges).toEqual([{ startLine: 1, endLine: 2 }])
	})
})

// A payload default may itself be written across lines, and it folds the
// way the same literal folds inside a body.
describe("Folding Ranges inside a Case payload default", () => {
	it("should fold a List literal written as a payload default's member", () => {
		let source = [
			"implementation {",
			"\tchoice Fetch {",
			"\t\tGet { tags: List<String> } = {",
			"\t\t\ttags = [",
			'\t\t\t\t"a",',
			"\t\t\t],",
			"\t\t},",
			"\t}",
			"}",
		].join("\n")

		expect(foldingRangesOf(source)).toContainEqual({
			startLine: 4,
			endLine: 5,
		})
	})
})

describe("Folding a define", () => {
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

	it("should fold the block, stopping before the closing brace", () => {
		expect(foldingRangesOf(source)).toContainEqual({
			startLine: 3,
			endLine: 5,
		})
	})

	// An arm has a Position of its own, but only braces fold: the block, the
	// Function around it and the implementation.
	it("should hand out no range for an arm of its own", () => {
		expect(foldingRangesOf(source)).toHaveLength(3)
	})

	it("should fold a Record literal written as an arm's value", () => {
		let source = [
			"implementation {",
			"\tconstant chosen = define {",
			"\t\tas {",
			'\t\t\tname = "Ada",',
			"\t\t} if true",
			'\t\tas { name = "nobody" } otherwise',
			"\t}",
			"}",
		].join("\n")

		expect(foldingRangesOf(source)).toContainEqual({
			startLine: 3,
			endLine: 4,
		})
	})
})

// Neither Keyword folds, since each is written on the line its operand starts
// on. A call written under one folds like any other.
describe("Folding Ranges under start and complete", () => {
	it("should fold a call written across lines under the Keyword", () => {
		let source = [
			"implementation {",
			"\tfunction doubled(_ value: Integer) -> Future<Integer> {",
			"\t\t<- complete Async.deferred(() { <- value })",
			"\t}",
			"",
			"\tconstant answer = complete doubled(",
			"\t\t21,",
			"\t)",
			"}",
		].join("\n")

		expect(foldingRangesOf(source)).toContainEqual({
			startLine: 6,
			endLine: 7,
		})
	})
})

describe("Folding Ranges inside a refused value", () => {
	it("should fold a List written across lines in front of the brackets", () => {
		let source = [
			"implementation {",
			"\tconstant first = [",
			"\t\t2,",
			"\t\t3,",
			"\t][0]",
			"}",
		].join("\n")

		expect(foldingRangesOf(source)).toContainEqual({
			startLine: 2,
			endLine: 4,
		})
	})
})

describe("Folding Ranges inside a Method's default", () => {
	it("should fold a Record literal written as a Namespace Method's default", () => {
		let source = [
			"implementation {",
			"\ttype Options = { size: Integer, label: String }",
			"",
			"\tnamespace Box for Integer {",
			"\t\tdescribe(options: Options = {",
			"\t\t\tsize = 1,",
			'\t\t\tlabel = "box",',
			"\t\t}) -> String {",
			"\t\t\t<- options.label",
			"\t\t}",
			"\t}",
			"}",
		].join("\n")

		expect(foldingRangesOf(source)).toContainEqual({
			startLine: 5,
			endLine: 7,
		})
	})

	it("should fold a Record literal written as a native signature's default", () => {
		let source = [
			"declarations {",
			"\ttype Options = { size: Integer, label: String }",
			"",
			"\tnamespace Box for Integer {",
			"\t\tdescribe(options: Options = {",
			"\t\t\tsize = 1,",
			'\t\t\tlabel = "box",',
			"\t\t}) -> String",
			"\t}",
			"}",
		].join("\n")

		let ranges = foldingRangesOf(source, { allowDeclarationsHeader: true })

		expect(ranges).toContainEqual({ startLine: 5, endLine: 7 })
	})
})

describe("Folding Ranges inside a refinement predicate", () => {
	it("should fold a call written across lines", () => {
		let source = [
			"implementation {",
			"\ttype Small = Integer",
			"\t\twhere @::isGreaterThan(",
			"\t\t\t0,",
			"\t\t)",
			"}",
		].join("\n")

		expect(foldingRangesOf(source)).toContainEqual({
			startLine: 3,
			endLine: 4,
		})
	})
})

// Every Node over the same lines as an earlier one adds no fold, so each
// fixture's folds are distinct, and their number is pinned.
describe("Folding Ranges across the fixtures", () => {
	const foldCounts: Record<string, number> = {
		"Choice.es": 15,
		"ConditionalConformance.es": 3,
		"DecimalLiterals.es": 1,
		"Define.es": 11,
		"Dictionary.es": 24,
		"DictionaryBenchmarks.es": 74,
		"Documentation.es": 11,
		"Event.es": 10,
		"Everyday.es": 1,
		"Future.es": 9,
		"FutureCombinators.es": 15,
		"GenericChoice.es": 15,
		"Generics.es": 6,
		"HelloWorld.es": 4,
		"Inference.es": 18,
		"Interpolation.es": 1,
		"Irrational.es": 4,
		"List.es": 12,
		"Loops.es": 16,
		"Match.es": 7,
		"Maybe.es": 16,
		"Namespace.es": 11,
		"NestedRecords.es": 15,
		"Number.es": 2,
		"Patterns.es": 25,
		"Protocols.es": 18,
		"Refinements.es": 41,
		"Result.es": 7,
		"StdlibExhaustive.es": 1320,
		"String.es": 2,
		"Tests.es": 44,
		"Tree.es": 10,
		"modules/A.es": 5,
		"modules/B.es": 6,
		"modules/Geometry.es": 8,
		"modules/Main.es": 8,
		"modules/math/Math.es": 3,
	}

	it("should fold each span of lines once, as many times as before", () => {
		for (let [name, count] of Object.entries(foldCounts)) {
			let ranges = foldingRangesOf(
				readFileSync(fixturePath(name), "utf-8"),
			)
			let spans = new Set(
				ranges.map((range) => `${range.startLine}:${range.endLine}`),
			)

			expect({ name, folds: ranges.length, spans: spans.size }).toEqual({
				name,
				folds: count,
				spans: count,
			})
		}
	})
})
