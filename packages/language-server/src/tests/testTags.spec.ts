import { describe, expect, it } from "bun:test"

import { parseDocument } from "@essence-lang/compiler/documents"
import { editDistance } from "@essence-lang/compiler/helpers"
import type { parser } from "@essence-lang/interfaces"

import { tagDiagnostics, tagUsages } from "../testTags"

// NOTE: The two questions a workspace can ask about its tags and one Module can
// not. Everything here is over PARSER Programs, because that is what the
// Workspace holds and because where a tag was written survives only there.

function programOf(source: string): parser.Program {
	return parseDocument(source, "/Season.tests.es").program
}

function tagged(...tests: Array<string>): parser.Program {
	return programOf(`tests {\n${tests.join("\n")}\n}\n`)
}

function codesFor(
	files: Array<{ filePath: string; program: parser.Program }>,
	filePath: string,
): Array<string> {
	return (tagDiagnostics(files).get(filePath) ?? []).map(
		(diagnostic) => diagnostic.code,
	)
}

describe("The edit distance a suggestion is measured by", () => {
	it("counts a swap of two adjacent characters as one edit", () => {
		expect(editDistance("slwo", "slow")).toBe(1)
	})

	it("counts a substitution as one edit", () => {
		expect(editDistance("slow", "slot")).toBe(1)
	})

	it("counts an insertion as one edit", () => {
		expect(editDistance("slow", "slows")).toBe(1)
	})

	it("is zero for one word twice", () => {
		expect(editDistance("network", "network")).toBe(0)
	})

	it("counts what it has to for two different words", () => {
		expect(editDistance("network", "slow")).toBeGreaterThan(2)
	})
})

describe("Tag usages", () => {
	it("counts the tests a tag is carried by, not the places it is written", () => {
		let usages = tagUsages([
			{
				filePath: "/Season.tests.es",
				program: tagged(
					'\tsuite "over the wire" tagged network {',
					'\t\ttest "one" { expect true }',
					'\t\ttest "two" { expect true }',
					"\t}",
				),
			},
		])

		expect(usages.get("network")).toMatchObject({ tests: 2 })
		expect(usages.get("network")?.sites).toHaveLength(1)
	})

	it("gives a test its own tags and every enclosing suite's", () => {
		let usages = tagUsages([
			{
				filePath: "/Season.tests.es",
				program: tagged(
					'\tsuite "over the wire" tagged network {',
					'\t\ttest "one" tagged slow { expect true }',
					"\t}",
				),
			},
		])

		expect(usages.get("network")?.tests).toBe(1)
		expect(usages.get("slow")?.tests).toBe(1)
	})

	it("counts a tag written twice on one test once", () => {
		let usages = tagUsages([
			{
				filePath: "/Season.tests.es",
				program: tagged(
					'\ttest "one" tagged slow, slow { expect true }',
				),
			},
		])

		expect(usages.get("slow")?.tests).toBe(1)
	})
})

describe("similar-tags", () => {
	it("reports two tags one typo apart, on the rarer one", () => {
		let program = tagged(
			'\ttest "one" tagged network { expect true }',
			'\ttest "two" tagged network { expect true }',
			'\ttest "three" tagged netwrok { expect true }',
		)
		let diagnostics =
			tagDiagnostics([{ filePath: "/Season.tests.es", program }]).get(
				"/Season.tests.es",
			) ?? []
		let similar = diagnostics.filter(
			(diagnostic) => diagnostic.code === "similar-tags",
		)

		expect(similar).toHaveLength(1)
		expect(similar[0]).toMatchObject({
			severity: "warning",
			data: { kind: "suggestion", suggestion: "network" },
		})
		expect(similar[0]?.message).toContain("'netwrok'")
	})

	it("underlines the tag itself, so a rename replaces the word", () => {
		let source =
			'tests {\n\ttest "one" tagged network { expect true }\n\ttest "two" tagged network { expect true }\n\ttest "three" tagged netwrok { expect true }\n}\n'
		let program = parseDocument(source, "/Season.tests.es").program
		let [similar] = (
			tagDiagnostics([{ filePath: "/Season.tests.es", program }]).get(
				"/Season.tests.es",
			) ?? []
		).filter((diagnostic) => diagnostic.code === "similar-tags")
		let line = source.split("\n")[similar!.position!.start.line - 1] ?? ""

		expect(
			line.slice(
				similar!.position!.start.column - 1,
				similar!.position!.end.column - 1,
			),
		).toBe("netwrok")
	})

	it("says nothing about two tags that are simply different", () => {
		expect(
			codesFor(
				[
					{
						filePath: "/Season.tests.es",
						program: tagged(
							'\ttest "one" tagged network { expect true }',
							'\ttest "two" tagged network { expect true }',
							'\ttest "three" tagged slow { expect true }',
							'\ttest "four" tagged slow { expect true }',
						),
					},
				],
				"/Season.tests.es",
			),
		).toEqual([])
	})

	it("finds a pair written in two different files", () => {
		let files = [
			{
				filePath: "/Season.tests.es",
				program: parseDocument(
					'tests {\n\ttest "one" tagged network { expect true }\n\ttest "two" tagged network { expect true }\n}\n',
					"/Season.tests.es",
				).program,
			},
			{
				filePath: "/Table.tests.es",
				program: parseDocument(
					'tests {\n\ttest "three" tagged netwrok { expect true }\n}\n',
					"/Table.tests.es",
				).program,
			},
		]

		expect(codesFor(files, "/Table.tests.es")).toContain("similar-tags")
		expect(codesFor(files, "/Season.tests.es")).not.toContain(
			"similar-tags",
		)
	})
})

describe("lonely-tag", () => {
	it("remarks on a tag exactly one test carries", () => {
		let program = tagged('\ttest "one" tagged flaky { expect true }')
		let [diagnostic] =
			tagDiagnostics([{ filePath: "/Season.tests.es", program }]).get(
				"/Season.tests.es",
			) ?? []

		expect(diagnostic).toMatchObject({
			code: "lonely-tag",
			severity: "information",
		})
	})

	it("says nothing about a tag two tests carry", () => {
		expect(
			codesFor(
				[
					{
						filePath: "/Season.tests.es",
						program: tagged(
							'\ttest "one" tagged flaky { expect true }',
							'\ttest "two" tagged flaky { expect true }',
						),
					},
				],
				"/Season.tests.es",
			),
		).toEqual([])
	})

	it("says nothing about a workspace with no tags at all", () => {
		expect(
			tagDiagnostics([
				{
					filePath: "/Season.tests.es",
					program: tagged('\ttest "one" { expect true }'),
				},
			]).size,
		).toBe(0)
	})
})
