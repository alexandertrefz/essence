import { describe, expect, it } from "bun:test"
import { DiagnosticSeverity, DiagnosticTag } from "vscode-languageserver"

import { analyse } from "../lsp/analyse"
import { toLspDiagnostic, toLspRange } from "../lsp/conversion"

describe("LSP", () => {
	describe("analyse", () => {
		it("should report no Diagnostics for a valid Program", () => {
			expect(
				analyse(`implementation {
					constant name: String = "essence"
					__print(name)
				}`),
			).toEqual([])
		})

		it("should report positioned Parser Diagnostics and still analyse later statements", () => {
			let diagnostics = analyse(`implementation {
				constant x =
				constant a = undeclaredVariable
			}`)

			expect(diagnostics).toHaveLength(2)

			expect(diagnostics[0].severity).toBe("error")
			expect(diagnostics[0].message).toBe(
				"Expected an Expression but found 'constant'.",
			)
			expect(diagnostics[0].position).not.toBeNull()
			expect(diagnostics[0].position?.start.line).toBe(3)

			expect(diagnostics[1].severity).toBe("error")
			expect(diagnostics[1].message).toBe(
				"Variable 'undeclaredVariable' is not declared.",
			)
		})

		it("should report Enricher Diagnostics", () => {
			let diagnostics = analyse(`implementation {
				constant a = undeclaredVariable
			}`)

			expect(diagnostics).toHaveLength(1)
			expect(diagnostics[0].severity).toBe("error")
			expect(diagnostics[0].message).toBe(
				"Variable 'undeclaredVariable' is not declared.",
			)
			expect(diagnostics[0].position?.start.line).toBe(2)
		})

		it("should report Validator Diagnostics", () => {
			let diagnostics = analyse(`implementation {
				constant a: String = true
			}`)

			expect(diagnostics).toHaveLength(1)
			expect(diagnostics[0].severity).toBe("error")
			expect(diagnostics[0].message).toBe(
				"Wrong Assignment Value Type for Constant 'a'.",
			)
		})

		it("should not run the Validator when the Enricher reported errors", () => {
			let diagnostics = analyse(`implementation {
				constant a = undeclaredVariable
				constant b: String = true
			}`)

			expect(diagnostics).toHaveLength(1)
			expect(diagnostics[0].message).toBe(
				"Variable 'undeclaredVariable' is not declared.",
			)
		})
	})

	describe("toLspRange", () => {
		it("should convert 1-based Positions to 0-based Ranges", () => {
			expect(
				toLspRange({
					start: { line: 3, column: 5 },
					end: { line: 4, column: 9 },
				}),
			).toEqual({
				start: { line: 2, character: 4 },
				end: { line: 3, character: 8 },
			})
		})

		it("should map missing Positions to the document start", () => {
			expect(toLspRange(null)).toEqual({
				start: { line: 0, character: 0 },
				end: { line: 0, character: 1 },
			})
		})
	})

	describe("toLspDiagnostic", () => {
		it("should map error Diagnostics", () => {
			expect(
				toLspDiagnostic({
					severity: "error",
					message: "Some Error.",
					position: {
						start: { line: 1, column: 1 },
						end: { line: 1, column: 10 },
					},
				}),
			).toEqual({
				range: {
					start: { line: 0, character: 0 },
					end: { line: 0, character: 9 },
				},
				severity: DiagnosticSeverity.Error,
				message: "Some Error.",
				source: "essence",
			})
		})

		it("should map warning Diagnostics", () => {
			let diagnostic = toLspDiagnostic({
				severity: "warning",
				message: "Some Warning.",
				position: null,
			})

			expect(diagnostic.severity).toBe(DiagnosticSeverity.Warning)
			expect(diagnostic.range).toEqual({
				start: { line: 0, character: 0 },
				end: { line: 0, character: 1 },
			})
		})

		it("should carry the code and map tags", () => {
			let diagnostic = toLspDiagnostic({
				severity: "warning",
				message: "Dead code.",
				position: null,
				code: "unreachable-case",
				tags: ["unnecessary"],
			})

			expect(diagnostic.code).toBe("unreachable-case")
			expect(diagnostic.tags).toEqual([DiagnosticTag.Unnecessary])
		})

		it("should leave code and tags unset when there are none", () => {
			let diagnostic = toLspDiagnostic({
				severity: "error",
				message: "Some Error.",
				position: null,
			})

			expect(diagnostic.code).toBeUndefined()
			expect(diagnostic.tags).toBeUndefined()
		})
	})

	describe("Diagnostic codes", () => {
		it("should tag an unreachable Match case as unnecessary", () => {
			let diagnostics = analyse(
				[
					"implementation {",
					"\ttype Value = Integer | String",
					"\tconstant something: Value = 42",
					"\tconstant answer = match something -> String {",
					'\t\tcase Integer { <- "an Integer" }',
					"\t\tcase String  { <- @ }",
					'\t\tcase Boolean { <- "never" }',
					"\t}",
					"}",
				].join("\n"),
			)

			let unreachable = diagnostics.find(
				(diagnostic) => diagnostic.code === "unreachable-case",
			)

			expect(unreachable?.severity).toBe("warning")
			expect(unreachable?.tags).toEqual(["unnecessary"])
		})

		it("should code an unhandled Union member", () => {
			let diagnostics = analyse(
				[
					"implementation {",
					"\ttype Value = Integer | String",
					"\tconstant something: Value = 42",
					"\tconstant answer = match something -> String {",
					'\t\tcase Integer { <- "an Integer" }',
					"\t}",
					"}",
				].join("\n"),
			)

			expect(
				diagnostics.some(
					(diagnostic) => diagnostic.code === "missing-case",
				),
			).toBe(true)
		})

		it("should code a missing return", () => {
			let diagnostics = analyse(
				[
					"implementation {",
					"\tfunction broken () -> Integer {",
					'\t\t__print("no return")',
					"\t}",
					"}",
				].join("\n"),
			)

			expect(
				diagnostics.some(
					(diagnostic) => diagnostic.code === "missing-return",
				),
			).toBe(true)
		})
	})
})
