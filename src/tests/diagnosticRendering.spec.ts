import { describe, expect, test } from "bun:test"

import { Source } from "../ariadne/index"
import { primary } from "../diagnostics/index"
import { renderDiagnostic, renderDiagnostics } from "../diagnostics/render"
import type { common } from "../interfaces/index"
import { testDiagnostic } from "./diagnosticFactory"

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

// NOTE: A positioned Diagnostic always carries at least one Label — the type
// makes it so — and the Label's message is what the arrow says. These tests
// are about the layout around it, so they all use the same short one.
function diagnostic(
	severity: common.DiagnosticSeverity,
	message: string,
	position: common.Position | null,
	code: common.DiagnosticCode = "internal-error",
): common.Diagnostic {
	return testDiagnostic({
		severity,
		message,
		position,
		code,
		labels:
			position === null ? [] : [primary(position, "the offending span")],
	})
}

describe("diagnostic rendering", () => {
	test("renders an error with a position as an annotated report", () => {
		let sourceText = "constant x = 10\nx = 20\n"
		let output = renderDiagnostic(
			diagnostic(
				"error",
				"Cannot reassign Constant 'x'.",
				{
					start: { line: 2, column: 1 },
					end: { line: 2, column: 2 },
				},
				"constant-reassignment",
			),
			new Source(sourceText),
			"Test.es",
			{ color: false },
		)

		expectOutput(
			output,
			`
			[constant-reassignment]
			Error: Cannot reassign Constant 'x'.
			   ╭─┤ Test.es:2:1 │
			   │
			 2 │ x = 20
			   │ ▲
			   │ ╰── the offending span
			───╯
			`,
		)
	})

	test("renders a warning with a Warning header", () => {
		let sourceText = "constant x = 10\n"
		let output = renderDiagnostic(
			diagnostic(
				"warning",
				"Unreachable Match Case.",
				{
					start: { line: 1, column: 10 },
					end: { line: 1, column: 16 },
				},
				"unreachable-case",
			),
			new Source(sourceText),
			"Test.es",
			{ color: false },
		)

		expectOutput(
			output,
			`
			[unreachable-case]
			Warning: Unreachable Match Case.
			   ╭─┤ Test.es:1:10 │
			   │
			 1 │ constant x = 10
			   │          ───┬──
			   │             ╰──── the offending span
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

		expectOutput(
			output,
			`
			[internal-error]
			Error: Internal Compiler Error: something broke.
			`,
		)
	})

	test("renders multiple diagnostics against a shared source", () => {
		let sourceText = "constant x = 10\nx = 20\n"
		let output = renderDiagnostics(
			[
				diagnostic(
					"error",
					"Cannot reassign Constant 'x'.",
					{
						start: { line: 2, column: 1 },
						end: { line: 2, column: 2 },
					},
					"constant-reassignment",
				),
				diagnostic("error", "Missing declaration.", null),
			],
			sourceText,
			"Test.es",
			{ color: false },
		)

		expectOutput(
			output,
			`
			[constant-reassignment]
			Error: Cannot reassign Constant 'x'.
			   ╭─┤ Test.es:2:1 │
			   │
			 2 │ x = 20
			   │ ▲
			   │ ╰── the offending span
			───╯

			[internal-error]
			Error: Missing declaration.

			─── 2 errors
			`,
		)
	})

	test("summarises the counts below the reports", () => {
		let output = renderDiagnostics(
			[
				diagnostic("error", "First.", null),
				diagnostic("warning", "Second.", null),
				diagnostic("warning", "Third.", null),
			],
			"constant x = 10\n",
			"Test.es",
			{ color: false },
		)

		expect(output).toEndWith("─── 1 error, 2 warnings\n")
	})

	test("renders no summary when there is nothing to summarise", () => {
		expect(
			renderDiagnostics([], "constant x = 10\n", "Test.es", {
				color: false,
			}),
		).toBe("")
	})

	test("colors the summary counts by severity", () => {
		let output = renderDiagnostics(
			[
				diagnostic("error", "First.", null),
				diagnostic("warning", "Second.", null),
			],
			"constant x = 10\n",
			"Test.es",
		)

		expect(output).toContain("\x1b[31m1 error\x1b[0m")
		expect(output).toContain("\x1b[33m1 warning\x1b[0m")
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

	test("renders a code in the header", () => {
		let output = renderDiagnostic(
			testDiagnostic({
				severity: "error",
				message: "Match Expression does not handle every Case",
				position: {
					start: { line: 1, column: 1 },
					end: { line: 1, column: 9 },
				},
				code: "missing-case",
			}),
			new Source("constant x = 10\n"),
			"Test.es",
			{ color: false },
		)

		expect(output).toContain(
			"[missing-case]\nError: Match Expression does not handle every Case",
		)
	})

	test("renders a primary Label's message beside its span", () => {
		let output = renderDiagnostic(
			testDiagnostic({
				severity: "error",
				message: "This value does not fit Variable 'x'",
				code: "assignment-type-mismatch",
				position: {
					start: { line: 2, column: 5 },
					end: { line: 2, column: 11 },
				},
				labels: [
					{
						position: {
							start: { line: 2, column: 5 },
							end: { line: 2, column: 11 },
						},
						message: "this is a String",
						kind: "primary",
					},
				],
			}),
			new Source('variable x = 10\nx = "ten"\n'),
			"Test.es",
			{ color: false },
		)

		expectOutput(
			output,
			`
			[assignment-type-mismatch]
			Error: This value does not fit Variable 'x'
			   ╭─┤ Test.es:2:5 │
			   │
			 2 │ x = "ten"
			   │     ───┬──
			   │        ╰──── this is a String
			───╯
			`,
		)
	})

	test("renders a secondary Label pointing at the declaration", () => {
		let output = renderDiagnostic(
			testDiagnostic({
				severity: "error",
				message: "This value does not fit Variable 'x'",
				position: {
					start: { line: 2, column: 5 },
					end: { line: 2, column: 11 },
				},
				labels: [
					{
						position: {
							start: { line: 2, column: 5 },
							end: { line: 2, column: 11 },
						},
						message: "this is a String",
						kind: "primary",
					},
					{
						position: {
							start: { line: 1, column: 14 },
							end: { line: 1, column: 16 },
						},
						message: "declared as Integer here",
						kind: "secondary",
					},
				],
			}),
			new Source('variable x = 10\nx = "ten"\n'),
			"Test.es",
			{ color: false },
		)

		expect(output).toContain("declared as Integer here")
		expect(output).toContain("this is a String")
		expect(output).toContain(" 1 │ variable x = 10")
		expect(output).toContain(' 2 │ x = "ten"')
	})

	test("renders notes and helps below the source", () => {
		let output = renderDiagnostic(
			testDiagnostic({
				severity: "error",
				message: "Case '#Green' is ambiguous",
				position: {
					start: { line: 1, column: 1 },
					end: { line: 1, column: 9 },
				},
				notes: ["'Colour' declares it.", "'Traffic' declares it too."],
				helps: ["Write 'Colour.Green' instead."],
			}),
			new Source("constant x = 10\n"),
			"Test.es",
			{ color: false },
		)

		expect(output).toContain("Help: Write 'Colour.Green' instead.")
		expect(output).toContain("Note 1: 'Colour' declares it.")
		expect(output).toContain("Note 2: 'Traffic' declares it too.")
	})

	test("colors primary and secondary Labels differently", () => {
		let output = renderDiagnostic(
			testDiagnostic({
				severity: "error",
				message: "This value does not fit Variable 'x'",
				position: {
					start: { line: 2, column: 5 },
					end: { line: 2, column: 11 },
				},
				labels: [
					{
						position: {
							start: { line: 2, column: 5 },
							end: { line: 2, column: 11 },
						},
						message: "this is a String",
						kind: "primary",
					},
					{
						position: {
							start: { line: 1, column: 14 },
							end: { line: 1, column: 16 },
						},
						message: "declared as Integer here",
						kind: "secondary",
					},
				],
			}),
			new Source('variable x = 10\nx = "ten"\n'),
			"Test.es",
		)

		// NOTE: Ariadne colors a Label's underline and arrow, not its message
		// text, so the assertion is about the arrows: the primary one in the
		// severity color, the secondary one in a generated 8-bit color.
		let lines = output.split("\n")
		let primaryArrow = lines.find((line) =>
			line.includes("this is a String"),
		) as string
		let secondaryArrow = lines.find((line) =>
			line.includes("declared as Integer here"),
		) as string

		expect(primaryArrow).toContain("\x1b[31m╰\x1b[0m")
		expect(secondaryArrow).toContain("\x1b[38;5;")
		expect(secondaryArrow).not.toContain("\x1b[31m")
	})

	test("colored output styles the severity header", () => {
		let output = renderDiagnostic(
			diagnostic(
				"error",
				"Cannot reassign Constant 'x'.",
				{
					start: { line: 2, column: 1 },
					end: { line: 2, column: 2 },
				},
				"constant-reassignment",
			),
			new Source("constant x = 10\nx = 20\n"),
			"Test.es",
		)

		expect(output).toContain(
			"\x1b[38;5;115m[constant-reassignment]\x1b[0m\n\x1b[31mError\x1b[0m",
		)
	})
})
