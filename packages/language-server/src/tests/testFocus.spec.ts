import { describe, expect, it } from "bun:test"

import { parseDocument } from "@essence-lang/compiler/documents"
import type { parser } from "@essence-lang/interfaces"

import { findCodeActions } from "../codeActions"
import { focusDiagnostics } from "../testFocus"

// NOTE: What an Editor says about a `focused` left behind. The command line
// refuses a plain run that holds one; an Editor can refuse nothing, so it warns
// where the word stands and offers the one edit that answers it.

function programOf(source: string): parser.Program {
	return parseDocument(source, "/Season.tests.es").program
}

describe("The focus warning", () => {
	it("reports the Modifier of every focused test", () => {
		let diagnostics = focusDiagnostics(
			programOf(
				[
					"tests {",
					'\ttest "runs" focused {',
					"\t\texpect true",
					"\t}",
					"",
					'\ttest "does not" {',
					"\t\texpect true",
					"\t}",
					"}",
					"",
				].join("\n"),
			),
		)

		expect(diagnostics).toHaveLength(1)
		expect(diagnostics[0]!.code).toBe("focused-tests-remain")
		expect(diagnostics[0]!.severity).toBe("warning")
		expect(diagnostics[0]!.message).toBe("This test is still focused")
		expect(diagnostics[0]!.position?.start).toEqual({ line: 2, column: 14 })
	})

	it("reports a focused suite as a suite", () => {
		let diagnostics = focusDiagnostics(
			programOf(
				[
					"tests {",
					'\tsuite "Standing" focused {',
					'\t\ttest "runs" {',
					"\t\t\texpect true",
					"\t\t}",
					"\t}",
					"}",
					"",
				].join("\n"),
			),
		)

		expect(diagnostics.map((each) => each.message)).toEqual([
			"This suite is still focused",
		])
	})

	// NOTE: A focused skip narrows nothing — the test does not run either way —
	// and is not what has to go before this lands.
	it("says nothing about a focused test that is also skipped", () => {
		expect(
			focusDiagnostics(
				programOf(
					[
						"tests {",
						'\ttest "runs" focused skipped "later" {',
						"\t\texpect true",
						"\t}",
						"}",
						"",
					].join("\n"),
				),
			),
		).toEqual([])
	})

	it("says nothing about a file with no tests section", () => {
		expect(
			focusDiagnostics(programOf("implementation { constant x = 1 }")),
		).toEqual([])
	})
})

describe("Removing a focus", () => {
	const source = [
		"tests {",
		'\ttest "runs" focused {',
		"\t\texpect true",
		"\t}",
		"}",
		"",
	].join("\n")

	it("offers an edit that takes the word and the space in front of it", () => {
		let [diagnostic] = focusDiagnostics(programOf(source))
		let actions = findCodeActions(
			source,
			diagnostic!.position!,
			"/Season.tests.es",
			undefined,
			null,
			[diagnostic!],
		)
		let action = actions.find(
			(each) => each.diagnosticCode === "focused-tests-remain",
		)

		expect(action?.title).toBe("Remove 'focused'")
		expect(action?.edits).toEqual([
			{
				range: {
					start: { line: 2, column: 13 },
					end: { line: 2, column: 21 },
				},
				newText: "",
			},
		])
	})
})
