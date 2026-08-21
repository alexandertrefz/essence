import { describe, expect, it } from "bun:test"

import { parseDocument } from "@essence-lang/compiler/documents"
import { testIdentityKey } from "@essence-lang/compiler/enricher/tests"

import { findTestLenses } from "../codeLenses"
import { findValueHints } from "../testHints"

// NOTE: The two things drawn beside a test that a run does not have to have
// happened for — the lenses, which are read off the parse — and the one thing
// that does: the values a run recorded.

function lensesOf(source: string) {
	return findTestLenses(
		parseDocument(source, "/Season.tests.es").program,
		"/Season.tests.es",
	)
}

describe("Test lenses", () => {
	const nested = [
		"tests {",
		'\tsuite "the season" {',
		'\t\ttest "counts a win" {',
		"\t\t\texpect true",
		"\t\t}",
		"",
		'\t\ttest "counts a draw" {',
		"\t\t\texpect true",
		"\t\t}",
		"\t}",
		"",
		'\ttest "adds up" {',
		"\t\texpect true",
		"\t}",
		"}",
		"",
	].join("\n")

	it("offers Run and Debug above every test", () => {
		let lenses = lensesOf(nested).filter(
			(lens) => lens.arguments.ids.length === 1,
		)

		expect(lenses.map((lens) => lens.title)).toEqual([
			"Run",
			"Debug",
			"Run",
			"Debug",
			"Run",
			"Debug",
		])
		expect(new Set(lenses.map((lens) => lens.command))).toEqual(
			new Set(["essence.test.run", "essence.test.debug"]),
		)
	})

	it("spells an id exactly as the Enricher does", () => {
		let [lens] = lensesOf(nested)

		expect(lens?.arguments.ids).toEqual([
			testIdentityKey({
				modulePath: "/Season.tests.es",
				suitePath: ["the season"],
				name: "counts a win",
			}),
		])
	})

	it("offers a suite the ids of every test under it", () => {
		let suite = lensesOf(nested).find(
			(lens) => lens.arguments.title === "the season",
		)

		expect(suite?.arguments.ids).toHaveLength(2)
	})

	it("sits on the keyword rather than on the whole item", () => {
		let [lens] = lensesOf(nested)

		expect(lens?.position).toMatchObject({
			start: { line: 3, column: 3 },
			end: { line: 3, column: 7 },
		})
	})

	it("names a test by its TEMPLATE, holes and all", () => {
		let [lens] = lensesOf(
			'tests {\n\ttest "{scored}–{conceded} is a win" {\n\t\texpect true\n\t}\n}\n',
		)

		expect(lens?.arguments.title).toBe("{scored}–{conceded} is a win")
	})

	it("offers nothing above a suite holding no test", () => {
		expect(lensesOf('tests {\n\tsuite "empty" {\n\t}\n}\n')).toEqual([])
	})

	// NOTE: A row of a table test is a test in its own right and carries its
	// row number, so the lens above the whole table names every one of them.
	it("names one id per row of a table test", () => {
		let lenses = lensesOf(
			[
				"tests {",
				'\ttest "{n} doubled" across [1, 2, 3] (n: Integer) {',
				"\t\texpect true",
				"\t}",
				"}",
				"",
			].join("\n"),
		)

		expect(lenses[0]?.arguments.ids).toEqual([
			testIdentityKey(
				{
					modulePath: "/Season.tests.es",
					suitePath: [],
					name: "{n} doubled",
				},
				0,
			),
			testIdentityKey(
				{
					modulePath: "/Season.tests.es",
					suitePath: [],
					name: "{n} doubled",
				},
				1,
			),
			testIdentityKey(
				{
					modulePath: "/Season.tests.es",
					suitePath: [],
					name: "{n} doubled",
				},
				2,
			),
		])
	})

	it("offers Accept snapshot only where a run left one pending", () => {
		let source = [
			"tests {",
			'	test "renders" {',
			"		expect true",
			"	}",
			"",
			'	test "settles" {',
			"		expect true",
			"	}",
			"}",
			"",
		].join("\n")
		let pending = new Set([
			testIdentityKey({
				modulePath: "/Season.tests.es",
				suitePath: [],
				name: "renders",
			}),
		])
		let lenses = findTestLenses(
			parseDocument(source, "/Season.tests.es").program,
			"/Season.tests.es",
			pending,
		)

		expect(
			lenses
				.filter((lens) => lens.title === "Accept snapshot")
				.map((lens) => lens.arguments.title),
		).toEqual(["renders"])
		expect(
			lenses.find((lens) => lens.title === "Accept snapshot")?.command,
		).toBe("essence.test.acceptSnapshot")
	})

	it("offers a suite an Accept snapshot when a test under it has one", () => {
		let pending = new Set([
			testIdentityKey({
				modulePath: "/Season.tests.es",
				suitePath: ["the season"],
				name: "counts a win",
			}),
		])
		let lenses = findTestLenses(
			parseDocument(nested, "/Season.tests.es").program,
			"/Season.tests.es",
			pending,
		)

		expect(
			lenses
				.filter((lens) => lens.title === "Accept snapshot")
				.map((lens) => lens.arguments.title),
		).toEqual(["counts a win", "the season"])
	})

	it("offers nothing for a file with no tests section", () => {
		expect(lensesOf("implementation {\n\tconstant x = 1\n}\n")).toEqual([])
	})
})

describe("Value hints", () => {
	const source = [
		"tests {",
		'\ttest "reads" {',
		"\t\tconstant doubled = double(2)",
		"",
		"\t\texpect doubled::is(5)",
		"\t}",
		"}",
		"",
	].join("\n")

	const span = (line: number, source: string) => ({
		start: { line, column: 3 },
		end: { line, column: 3 + source.length },
		source,
	})

	it("draws a probed value at the end of its line", () => {
		let [hint] = findValueHints(
			[
				{
					schema: 1,
					kind: "probe",
					id: "/a",
					point: 0,
					span: span(3, "double(2)"),
					value: "4",
				},
			],
			source,
		)

		expect(hint).toMatchObject({
			kind: "value",
			label: "4",
			textEdit: null,
			position: { line: 3 },
		})
		expect(hint?.position.column).toBe(
			(source.split("\n")[2]?.length ?? 0) + 1,
		)
	})

	it("draws what a failed comparison held", () => {
		let [hint] = findValueHints(
			[
				{
					schema: 1,
					kind: "expect",
					id: "/a",
					form: "expect",
					passed: false,
					span: span(5, "doubled::is(5)"),
					values: [],
					comparison: {
						kind: "is",
						left: "4",
						right: "5",
						diff: [],
					},
				},
			],
			source,
		)

		expect(hint?.label).toBe("4 is not 5")
	})

	it("draws nothing for an assertion that held", () => {
		expect(
			findValueHints(
				[
					{
						schema: 1,
						kind: "expect",
						id: "/a",
						form: "expect",
						passed: true,
						span: span(5, "doubled::is(4)"),
						values: [],
						comparison: null,
					},
				],
				source,
			),
		).toEqual([])
	})

	it("keeps one answer per line, the last one recorded", () => {
		let hints = findValueHints(
			[
				{
					schema: 1,
					kind: "probe",
					id: "/a",
					point: 0,
					span: span(3, "double(2)"),
					value: "4",
				},
				{
					schema: 1,
					kind: "probe",
					id: "/b",
					point: 0,
					span: span(3, "double(2)"),
					value: "6",
				},
			],
			source,
		)

		expect(hints).toHaveLength(1)
		expect(hints[0]?.label).toBe("6")
	})

	it("clips a value too long to sit in a margin", () => {
		let [hint] = findValueHints(
			[
				{
					schema: 1,
					kind: "probe",
					id: "/a",
					point: 0,
					span: span(3, "double(2)"),
					value: "x".repeat(200),
				},
			],
			source,
		)

		expect(hint?.label).toHaveLength(60)
		expect(hint?.label.endsWith("…")).toBe(true)
	})

	it("answers only for the range it was asked about", () => {
		expect(
			findValueHints(
				[
					{
						schema: 1,
						kind: "probe",
						id: "/a",
						point: 0,
						span: span(3, "double(2)"),
						value: "4",
					},
				],
				source,
				{ start: { line: 5, column: 1 }, end: { line: 7, column: 1 } },
			),
		).toEqual([])
	})
})
