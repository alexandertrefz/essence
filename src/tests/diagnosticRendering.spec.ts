import { describe, expect, test } from "bun:test"

import { Source } from "../ariadne/index"
import { renderDiagnostic, renderDiagnostics } from "../diagnostics/render"
import type { common } from "../interfaces/index"

function removeTrailing(text: string): string {
	let lines = text.split("\n")

	if (lines[lines.length - 1] === "") {
		lines.pop()
	}

	return `${lines.map((line) => line.trimEnd()).join("\n")}\n`
}

function dedent(text: string): string {
	let lines = text.split("\n")

	if (lines.length > 0 && lines[0].trim() === "") {
		lines.shift()
	}
	while (lines.length > 0 && lines[lines.length - 1].trim() === "") {
		lines.pop()
	}

	let tabCounts = lines
		.filter((line) => line.trim() !== "")
		.map((line) => (line.match(/^\t*/) as RegExpMatchArray)[0].length)
	let minimumTabs = tabCounts.length > 0 ? Math.min(...tabCounts) : 0

	return `${lines.map((line) => line.slice(minimumTabs).trimEnd()).join("\n")}\n`
}

function expectOutput(actual: string, expected: string): void {
	expect(removeTrailing(actual)).toBe(dedent(expected))
}

function diagnostic(
	severity: common.DiagnosticSeverity,
	message: string,
	position: common.Position | null,
): common.Diagnostic {
	return { severity, message, position }
}

describe("diagnostic rendering", () => {
	test("renders an error with a position as an annotated report", () => {
		let sourceText = "constant x = 10\nx = 20\n"
		let output = renderDiagnostic(
			diagnostic("error", "Cannot reassign Constant 'x'.", {
				start: { line: 2, column: 1 },
				end: { line: 2, column: 2 },
			}),
			new Source(sourceText),
			"Test.es",
			{ color: false },
		)

		expectOutput(
			output,
			`
			Error: Cannot reassign Constant 'x'.
			   ╭─┤ Test.es:2:1 │
			   │
			 2 │ x = 20
			   │ ─
			───╯
			`,
		)
	})

	test("renders a warning with a Warning header", () => {
		let sourceText = "constant x = 10\n"
		let output = renderDiagnostic(
			diagnostic("warning", "Unreachable Match Case.", {
				start: { line: 1, column: 10 },
				end: { line: 1, column: 16 },
			}),
			new Source(sourceText),
			"Test.es",
			{ color: false },
		)

		expectOutput(
			output,
			`
			Warning: Unreachable Match Case.
			   ╭─┤ Test.es:1:10 │
			   │
			 1 │ constant x = 10
			   │          ──────
			───╯
			`,
		)
	})

	test("renders a diagnostic without a position as a bare message", () => {
		let output = renderDiagnostic(
			diagnostic(
				"error",
				"Internal Compiler Error: something broke.",
				null,
			),
			new Source("constant x = 10\n"),
			"Test.es",
			{ color: false },
		)

		expectOutput(output, "Error: Internal Compiler Error: something broke.")
	})

	test("renders multiple diagnostics against a shared source", () => {
		let sourceText = "constant x = 10\nx = 20\n"
		let output = renderDiagnostics(
			[
				diagnostic("error", "Cannot reassign Constant 'x'.", {
					start: { line: 2, column: 1 },
					end: { line: 2, column: 2 },
				}),
				diagnostic("error", "Missing declaration.", null),
			],
			sourceText,
			"Test.es",
			{ color: false },
		)

		expectOutput(
			output,
			`
			Error: Cannot reassign Constant 'x'.
			   ╭─┤ Test.es:2:1 │
			   │
			 2 │ x = 20
			   │ ─
			───╯
			Error: Missing declaration.
			`,
		)
	})

	test("clamps out-of-range positions instead of crashing", () => {
		let output = renderDiagnostic(
			diagnostic("error", "Something at the very end.", {
				start: { line: 99, column: 99 },
				end: { line: 99, column: 120 },
			}),
			new Source("constant x = 10\n"),
			"Test.es",
			{ color: false },
		)

		expect(output).toContain("Error: Something at the very end.")
	})

	test("colored output styles the severity header", () => {
		let output = renderDiagnostic(
			diagnostic("error", "Cannot reassign Constant 'x'.", {
				start: { line: 2, column: 1 },
				end: { line: 2, column: 2 },
			}),
			new Source("constant x = 10\nx = 20\n"),
			"Test.es",
		)

		expect(output).toContain("\x1b[31mError\x1b[0m")
	})
})
