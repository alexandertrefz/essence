import { describe, expect, it } from "bun:test"
import { readdirSync, readFileSync } from "node:fs"
import path from "node:path"

import { DiagnosticSeverity, DiagnosticTag } from "vscode-languageserver"

import { enrichDocument, parseDocument } from "../documents"
import { STDLIB_DIRECTORY } from "../enricher/stdlib"
import { analyse } from "../lsp/analyse"
import { findCompletions } from "../lsp/completion"
import { toLspDiagnostic, toLspRange } from "../lsp/conversion"
import { findHover } from "../lsp/hover"
import { matchingNamespaces } from "../lsp/namespaces"
import { findRenameableOccurrence } from "../lsp/rename"
import { testDiagnostic } from "./diagnosticFactory"

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
				"'undeclaredVariable' is not declared",
			)
		})

		it("should report Enricher Diagnostics", () => {
			let diagnostics = analyse(`implementation {
				constant a = undeclaredVariable
			}`)

			expect(diagnostics).toHaveLength(1)
			expect(diagnostics[0].severity).toBe("error")
			expect(diagnostics[0].message).toBe(
				"'undeclaredVariable' is not declared",
			)
			expect(diagnostics[0].position?.start.line).toBe(2)
		})

		it("should report Validator Diagnostics", () => {
			let diagnostics = analyse(`implementation {
				constant a: String = true
			}`)

			expect(diagnostics).toHaveLength(1)
			expect(diagnostics[0].severity).toBe("error")
			expect(diagnostics[0].code).toBe("assignment-type-mismatch")
		})

		it("should not run the Validator when the Enricher reported errors", () => {
			let diagnostics = analyse(`implementation {
				constant a = undeclaredVariable
				constant b: String = true
			}`)

			expect(diagnostics).toHaveLength(1)
			expect(diagnostics[0].message).toBe(
				"'undeclaredVariable' is not declared",
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
				toLspDiagnostic(
					testDiagnostic({
						severity: "error",
						message: "Some Error.",
						position: {
							start: { line: 1, column: 1 },
							end: { line: 1, column: 10 },
						},
					}),
					"file:///Test.es",
				),
			).toEqual({
				range: {
					start: { line: 0, character: 0 },
					end: { line: 0, character: 9 },
				},
				severity: DiagnosticSeverity.Error,
				message: "Some Error.",
				source: "essence",
				code: "internal-error",
				tags: undefined,
			})
		})

		it("should map warning Diagnostics", () => {
			let diagnostic = toLspDiagnostic(
				testDiagnostic({
					severity: "warning",
					message: "Some Warning.",
					position: null,
				}),
				"file:///Test.es",
			)

			expect(diagnostic.severity).toBe(DiagnosticSeverity.Warning)
			expect(diagnostic.range).toEqual({
				start: { line: 0, character: 0 },
				end: { line: 0, character: 1 },
			})
		})

		it("should carry the code and map tags", () => {
			let diagnostic = toLspDiagnostic(
				testDiagnostic({
					severity: "warning",
					message: "Dead code.",
					position: null,
					code: "unreachable-case",
					tags: ["unnecessary"],
				}),
				"file:///Test.es",
			)

			expect(diagnostic.code).toBe("unreachable-case")
			expect(diagnostic.tags).toEqual([DiagnosticTag.Unnecessary])
		})

		it("should leave tags and related information unset when there are none", () => {
			let diagnostic = toLspDiagnostic(
				testDiagnostic({
					severity: "error",
					message: "Some Error.",
					position: null,
				}),
				"file:///Test.es",
			)

			expect(diagnostic.tags).toBeUndefined()
			expect(diagnostic.relatedInformation).toBeUndefined()
		})

		it("should fold the primary Label, Notes and Helps into the message", () => {
			let position = {
				start: { line: 1, column: 1 },
				end: { line: 1, column: 2 },
			}
			let diagnostic = toLspDiagnostic(
				testDiagnostic({
					severity: "error",
					message: "This value does not fit Variable 'x'",
					position,
					code: "assignment-type-mismatch",
					labels: [
						{
							position,
							message: "this is a String",
							kind: "primary",
						},
					],
					notes: ["'x' is declared as Integer."],
					helps: ["Convert it first."],
				}),
				"file:///Test.es",
			)

			expect(diagnostic.message).toBe(
				[
					"This value does not fit Variable 'x': this is a String",
					"Note: 'x' is declared as Integer.",
					"Help: Convert it first.",
				].join("\n"),
			)
		})

		it("should map secondary Labels to related information", () => {
			let valuePosition = {
				start: { line: 3, column: 9 },
				end: { line: 3, column: 14 },
			}
			let declarationPosition = {
				start: { line: 1, column: 10 },
				end: { line: 1, column: 15 },
			}
			let diagnostic = toLspDiagnostic(
				testDiagnostic({
					severity: "error",
					message: "This value does not fit Variable 'count'",
					position: valuePosition,
					code: "assignment-type-mismatch",
					labels: [
						{
							position: valuePosition,
							message: "this is a String",
							kind: "primary",
						},
						{
							position: declarationPosition,
							message: "declared as Integer here",
							kind: "secondary",
						},
					],
				}),
				"file:///Test.es",
			)

			expect(diagnostic.relatedInformation).toEqual([
				{
					location: {
						uri: "file:///Test.es",
						range: {
							start: { line: 0, character: 9 },
							end: { line: 0, character: 14 },
						},
					},
					message: "declared as Integer here",
				},
			])
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

// NOTE: A standard library source is an ordinary `.es` file that two rules do
// not apply to — it may open with `declarations { … }`, and its declarations
// are already in the builtin tables because the loader read this very file to
// put them there. Both are keyed off WHERE the document lives, so the Language
// Server has to be told. Without it a stdlib file lights up with five errors,
// one of them a bogus syntax error that wrecks the AST every other feature
// runs on. String, Integer and Rational are hundreds of hand transcribed
// Methods each; the editor has to work inside them.
describe("LSP in a standard library source", () => {
	const source = [
		"declarations {",
		"\t§§ Two truth values.",
		"\tnamespace Boolean for Boolean is Equatable, is Printable {",
		"\t\t§§ The opposite truth value.",
		"\t\tnegate() -> Boolean",
		"",
		"\t\t§§ Whether the two are equal.",
		"\t\tis(_ other: Boolean) -> Boolean",
		"",
		"\t\t§§ Whether the two differ.",
		"\t\tisNot(_ other: Boolean) -> Boolean",
		"",
		"\t\t§§ As a String.",
		"\t\ttoString() -> String",
		"\t}",
		"}",
	].join("\n")

	// NOTE: THE standard library — the one this compiler loads — not any
	// directory that happens to be spelled `src/stdlib`. Essence is a language;
	// a user's own project may well have one of those.
	const stdlibPath = path.join(STDLIB_DIRECTORY, "Boolean.es")

	it("should report no Diagnostics for a document under src/stdlib", () => {
		expect(analyse(source, stdlibPath)).toEqual([])
	})

	it("should accept a file:// URI as well as a plain path", () => {
		expect(analyse(source, `file://${stdlibPath}`)).toEqual([])
	})

	// NOTE: The permission is the standard library's alone. Lifting it for
	// every document would retire `declarations-outside-stdlib` by accident —
	// and a user's own `src/stdlib/Boolean.es` is a plausible thing to write,
	// so the Editor must not tell them a `declarations` block is fine there
	// while `esc` rejects it.
	it("should still reject a 'declarations' header anywhere else", () => {
		for (let documentPath of [
			undefined,
			path.join(STDLIB_DIRECTORY, "../../testFiles/Boolean.es"),
			"/somewhere/essence/src/stdlib/Boolean.es",
			"/somewhere/stdlib/Boolean.es",
		]) {
			expect(
				analyse(source, documentPath).map(
					(diagnostic) => diagnostic.code,
				),
			).toContain("declarations-outside-stdlib")
		}
	})

	// NOTE: The self-collision. The loader put this file's `Boolean` into the
	// builtin Scope; enriched against the untouched tables the document
	// redeclares itself, and every Namespace it declares reports twice over.
	it("should not report a Namespace as a redeclaration of itself", () => {
		expect(
			analyse(source, undefined).map((diagnostic) => diagnostic.code),
		).toContain("duplicate-variable")

		expect(
			analyse(source, stdlibPath).map((diagnostic) => diagnostic.code),
		).not.toContain("duplicate-variable")
	})

	it("should answer Hover and Completion inside the document", () => {
		let { program } = parseDocument(source, stdlibPath)
		let { program: enrichedProgram } = enrichDocument(program, stdlibPath)

		expect(
			findHover(enrichedProgram, { line: 3, column: 12 })?.content,
		).toBe("namespace Boolean for Boolean is Equatable, is Printable")

		let withPartialType = [
			"declarations {",
			"\tnamespace Boxes for List<String> {",
			"\t\t§§ How many.",
			"\t\tcount() -> Inte",
			"\t}",
			"}",
		].join("\n")

		expect(
			findCompletions(
				withPartialType,
				{ line: 4, column: 18 },
				stdlibPath,
			).map((entry) => entry.label),
		).toContain("Integer")
	})

	// NOTE: A rename inside a standard library source is silently destructive
	// — the edit reaches this document only, while the name is the binding a
	// runtime export answers to and a `is …` clause may depend on. Renaming
	// `exclusiveOr` to `xor` type-checks, emits no Diagnostic and produces a
	// call to `undefined`; renaming `is` breaks the Equatable conformance and
	// the loader throws for every Program compiled afterwards.
	it("should refuse to rename anything in a standard library source", () => {
		let { program } = parseDocument(source, stdlibPath)
		let { program: enrichedProgram } = enrichDocument(program, stdlibPath)

		// NOTE: Every kind the document holds — the Namespace name (already
		// protected, since it resolves to a builtin), a conformance Method, a
		// plain native Method, and a Parameter.
		for (let cursor of [
			{ line: 3, column: 12 },
			{ line: 8, column: 4 },
			{ line: 14, column: 4 },
			{ line: 8, column: 9 },
		]) {
			expect(
				findRenameableOccurrence(
					program,
					cursor,
					enrichedProgram,
					stdlibPath,
				),
			).toBeNull()
		}
	})

	// NOTE: The guard is keyed off the path and must not touch anything else —
	// renaming in an ordinary document still works.
	it("should still rename in an ordinary document", () => {
		let ordinary = [
			"implementation {",
			'\tconstant greeting = "hello"',
			"\t__print(greeting)",
			"}",
		].join("\n")

		let { program } = parseDocument(ordinary)
		let { program: enrichedProgram } = enrichDocument(program)

		let occurrence = findRenameableOccurrence(
			program,
			{ line: 2, column: 12 },
			enrichedProgram,
			"/somewhere/essence/testFiles/Greeting.es",
		)

		expect(occurrence?.name).toBe("greeting")
		expect(occurrence?.declaration.occurrences).toHaveLength(2)
	})

	// NOTE: A standard library document declares the very Namespaces the
	// builtin table holds, so both would match a receiver and every signature
	// would be listed twice. Completion dedupes by Method name and hides it;
	// Signature Help does not, and an Overload set would double entry for
	// entry.
	it("should not list the document's own Namespace twice", () => {
		expect(
			matchingNamespaces(source, { type: "Boolean" }, null, stdlibPath)
				.map((namespace) => namespace.name)
				.filter((name) => name === "Boolean"),
		).toEqual(["Boolean"])
	})

	// NOTE: A body-less native signature has NO typed Node — the Enricher
	// drops it, since there is no body to emit — so Hover, which reads the
	// typed tree, answered every question inside one of these files with the
	// enclosing Namespace. The standard library is nothing but these
	// signatures.
	it("should describe a body-less signature, its Parameters and its annotations", () => {
		let { program } = parseDocument(source, stdlibPath)
		let { program: enrichedProgram } = enrichDocument(program, stdlibPath)

		let hoverAt = (line: number, column: number) =>
			findHover(enrichedProgram, { line, column }, program)

		expect(hoverAt(8, 4)?.content).toBe("is(_ Boolean) -> Boolean")
		expect(hoverAt(8, 4)?.documentation).toBe("Whether the two are equal.")
		// NOTE: The Parameter's own name, and the annotations either side of it.
		expect(hoverAt(8, 9)?.content).toBe("other: Boolean")
		expect(hoverAt(8, 16)?.content).toBe("Boolean")
		expect(hoverAt(8, 28)?.content).toBe("Boolean")
		expect(hoverAt(14, 4)?.content).toBe("toString() -> String")
	})

	// NOTE: Every real standard library source, analysed the way the editor
	// analyses it, is clean. The loader already throws on a Diagnostic; this
	// says the Language Server agrees with it, which it did not before — and
	// since the standard library is where the language is now written, an
	// editor that could not open it would be an editor nobody can extend it in.
	it("should report no Diagnostics for any real standard library source", () => {
		let directory = path.resolve(import.meta.dirname, "../stdlib")

		let fileNames = readdirSync(directory).filter((fileName) =>
			fileName.endsWith(".es"),
		)

		expect(fileNames.length).toBeGreaterThan(0)

		for (let fileName of fileNames) {
			let filePath = path.resolve(directory, fileName)

			expect([
				fileName,
				analyse(readFileSync(filePath, "utf-8"), filePath),
			]).toEqual([fileName, []])
		}
	})
})
