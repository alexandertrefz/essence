import { afterEach, describe, expect, it } from "bun:test"
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"

import {
	enrichDocument,
	isStdlibDocument,
	parseDocument,
} from "@essence/compiler/documents"
import { testDiagnostic } from "@essence/compiler/tests/diagnosticFactory"
import { fixturePath } from "@essence/fixtures"
import { STDLIB_DIRECTORY } from "@essence/stdlib"
import {
	CodeActionKind,
	CompletionItemKind,
	type Diagnostic,
	DiagnosticSeverity,
	DiagnosticTag,
	InsertTextFormat,
	TextDocumentSyncKind,
} from "vscode-languageserver"

import { analyse } from "../analyse"
import { findCodeActions } from "../codeActions"
import { type CompletionEntry, findCompletions } from "../completion"
import { toLspDiagnostic, toLspRange, toRange } from "../conversion"
import { findHover } from "../hover"
import { matchingNamespaces } from "../namespaces"
import { findRenameableOccurrence } from "../rename"
import { semanticTokenModifiers, semanticTokenTypes } from "../semanticTokens"
import {
	ensureTransportArgument,
	serverCapabilities,
	toLspCodeAction,
	toLspCompletionItem,
} from "../server"

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

	describe("toRange", () => {
		it("should convert 0-based Ranges back to 1-based Positions", () => {
			expect(
				toRange({
					start: { line: 2, character: 4 },
					end: { line: 3, character: 8 },
				}),
			).toEqual({
				start: { line: 3, column: 5 },
				end: { line: 4, column: 9 },
			})
		})

		// NOTE: An empty selection is what an Editor sends for a cursor sitting
		// on a squiggle, which is how a Quick Fix is asked for in practice.
		it("should carry an empty selection through as a zero-width Position", () => {
			let cursor = { line: 5, character: 0 }

			expect(toRange({ start: cursor, end: cursor })).toEqual({
				start: { line: 6, column: 1 },
				end: { line: 6, column: 1 },
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

	// NOTE: A capability is the only thing standing between a working feature
	// and one no Editor ever asks for — every handler below keeps passing its
	// own spec while the feature is dark. So the announcement is asserted as
	// its own fact, feature by feature.
	describe("capabilities", () => {
		it("should announce every feature the Server implements", () => {
			expect(serverCapabilities).toEqual({
				textDocumentSync: TextDocumentSyncKind.Full,
				renameProvider: { prepareProvider: true },
				definitionProvider: true,
				hoverProvider: true,
				referencesProvider: true,
				documentHighlightProvider: true,
				documentSymbolProvider: true,
				documentFormattingProvider: true,
				codeActionProvider: {
					codeActionKinds: [
						CodeActionKind.QuickFix,
						CodeActionKind.RefactorRewrite,
					],
				},
				completionProvider: {
					triggerCharacters: [".", ":", "<", "#"],
				},
				signatureHelpProvider: {
					triggerCharacters: ["(", ","],
					retriggerCharacters: [")"],
				},
				semanticTokensProvider: {
					legend: {
						tokenTypes: semanticTokenTypes,
						tokenModifiers: semanticTokenModifiers,
					},
					full: true,
				},
				foldingRangeProvider: true,
				selectionRangeProvider: true,
				inlayHintProvider: true,
				linkedEditingRangeProvider: true,
				callHierarchyProvider: true,
			})
		})

		// NOTE: The legend is handed over as two arrays of names and every
		// Token is an index into them, so a client holding an older response
		// recolours everything past an entry that moved.
		it("should carry the semantic token legend in the order the encoder uses", () => {
			expect(serverCapabilities.semanticTokensProvider).toEqual({
				legend: {
					tokenTypes: [
						"namespace",
						"type",
						"typeParameter",
						"parameter",
						"variable",
						"property",
						"function",
						"method",
						"enumMember",
					],
					tokenModifiers: [
						"declaration",
						"readonly",
						"static",
						"defaultLibrary",
					],
				},
				full: true,
			})
		})

		// NOTE: Not one of the fixes is both unambiguous and
		// semantics-preserving, so an Editor must never be told it may apply
		// them all at once.
		it("should not offer a fix-all Code Action kind", () => {
			expect(
				typeof serverCapabilities.codeActionProvider === "object"
					? serverCapabilities.codeActionProvider.codeActionKinds
					: [],
			).not.toContain(CodeActionKind.SourceFixAll)
		})
	})

	describe("toLspCompletionItem", () => {
		function entry(overrides: Partial<CompletionEntry>): CompletionEntry {
			return {
				label: "greet",
				kind: "function",
				detail: null,
				tier: 3,
				...overrides,
			}
		}

		it("should insert the call a resolved signature spells out", () => {
			let source = [
				"implementation {",
				"\tfunction greet (subject: String) -> String {",
				"\t\t<- subject",
				"\t}",
				"\t",
				"}",
			].join("\n")

			let completion = findCompletions(source, {
				line: 5,
				column: 2,
			}).find((candidate) => candidate.label === "greet")

			expect(completion).toBeDefined()

			let item = toLspCompletionItem(completion as CompletionEntry)

			expect(item.insertText).toBe("greet(subject ${1})")
			expect(item.insertTextFormat).toBe(InsertTextFormat.Snippet)
			expect(item.kind).toBe(CompletionItemKind.Function)
			expect(item.sortText).toBe("3greet")
		})

		// NOTE: Halfway through a keystroke nothing resolves, and a callable
		// still has to insert something better than its bare name.
		it("should fall back to bare parentheses for a callable with no snippet", () => {
			let item = toLspCompletionItem(entry({ snippet: null }))

			expect(item.insertText).toBe("greet($0)")
			expect(item.insertTextFormat).toBe(InsertTextFormat.Snippet)
		})

		// NOTE: `$` is an ordinary Identifier character, so the fallback is as
		// able to spell a snippet variable by accident as the resolved snippet
		// is — an unescaped `we$rd` inserts `we` followed by whatever the
		// Editor holds in `$rd`, which is the wrong name silently.
		it("should escape a snippet metacharacter in the fallback insert text", () => {
			let source = [
				"implementation {",
				"\tfunction we$rd (value: Integer) -> Integer { <- value }",
				"\t",
				"}",
			].join("\n")

			let resolved = findCompletions(source, {
				line: 3,
				column: 2,
			}).find((candidate) => candidate.label === "we$rd")

			expect(resolved?.label).toBe("we$rd")

			let item = toLspCompletionItem(
				entry({ label: "we$rd", snippet: null }),
			)

			expect(item.insertText).toBe("we\\$rd($0)")
			expect(item.insertTextFormat).toBe(InsertTextFormat.Snippet)
			// NOTE: The label the Editor matches and sorts on is not snippet
			// text, so it keeps the name as written.
			expect(item.label).toBe("we$rd")
			expect(item.filterText).toBe("we$rd")
		})

		it("should insert nothing but the label for what is referred to rather than called", () => {
			let item = toLspCompletionItem(
				entry({ label: "subject", kind: "parameter", tier: 1 }),
			)

			expect(item.insertText).toBeUndefined()
			expect(item.insertTextFormat).toBeUndefined()
			expect(item.sortText).toBe("1subject")
		})

		// NOTE: The inserted call never types `(` or `,`, so the Editor is
		// asked to open the parameter hints itself — for the resolved snippet
		// and the bare-parentheses fallback alike, and for nothing that is
		// referred to rather than called.
		it("should ask the Editor for parameter hints after inserting a call", () => {
			let hints = {
				title: "Trigger parameter hints",
				command: "editor.action.triggerParameterHints",
			}

			expect(
				toLspCompletionItem(entry({ snippet: "greet(subject ${1})" }))
					.command,
			).toEqual(hints)
			expect(
				toLspCompletionItem(entry({ snippet: null })).command,
			).toEqual(hints)
			expect(
				toLspCompletionItem(
					entry({ label: "subject", kind: "parameter", tier: 1 }),
				).command,
			).toBeUndefined()
		})

		it("should tell Overloads sharing a label apart by their signature tails", () => {
			let item = toLspCompletionItem(
				entry({
					kind: "method",
					snippet: "greet(with ${1})",
					labelDetail: "(with String) -> String",
				}),
			)

			expect(item.labelDetails).toEqual({
				detail: " (with String) -> String",
			})
			expect(item.filterText).toBe("greet")
		})

		it("should carry a preselected entry through and leave the rest unset", () => {
			expect(
				toLspCompletionItem(entry({ preselect: true })).preselect,
			).toBe(true)
			expect(toLspCompletionItem(entry({})).preselect).toBeUndefined()
		})

		it("should announce the keyword kind it now offers", () => {
			expect(
				toLspCompletionItem(entry({ label: "match", kind: "keyword" }))
					.kind,
			).toBe(CompletionItemKind.Keyword)
		})
	})

	describe("toLspCodeAction", () => {
		const source = [
			"implementation {",
			"\ttype Value = Integer | String",
			"\tconstant something: Value = 42",
			"\tconstant answer = match something -> String {",
			'\t\tcase Integer { <- "an Integer" }',
			"\t}",
			"}",
		].join("\n")

		const uri = "file:///Test.es"

		function fixFor(code: string) {
			let range = {
				start: { line: 1, column: 1 },
				end: { line: 7, column: 2 },
			}
			let action = findCodeActions(source, range).find(
				(candidate) => candidate.diagnosticCode === code,
			)

			expect(action).toBeDefined()

			return action as NonNullable<typeof action>
		}

		function paramsWith(diagnostics: Array<Diagnostic>) {
			return {
				textDocument: { uri },
				range: {
					start: { line: 0, character: 0 },
					end: { line: 6, character: 1 },
				},
				context: { diagnostics },
			}
		}

		function clientDiagnostic(
			code: string,
			range: ReturnType<typeof toLspRange>,
		): Diagnostic {
			return { code, range, message: "", source: "essence" }
		}

		it("should map the edits onto the document it was asked about", () => {
			let action = fixFor("missing-case")
			let item = toLspCodeAction(action, paramsWith([]))

			expect(item.title).toBe("Add missing Cases")
			expect(item.kind).toBe(CodeActionKind.QuickFix)
			expect(item.isPreferred).toBe(true)
			expect(item.edit?.changes?.[uri]).toEqual([
				{
					range: {
						start: { line: 5, character: 0 },
						end: { line: 5, character: 0 },
					},
					newText: "\t\tcase String {}\n",
				},
			])
		})

		// NOTE: Attribution only — the edits were computed on the buffer as it
		// is now, while the Diagnostics the client echoes back belong to a
		// buffer that is up to a debounce older.
		it("should attach only the client Diagnostic the fix answers", () => {
			let action = fixFor("missing-case")
			let item = toLspCodeAction(
				action,
				paramsWith([
					clientDiagnostic(
						"missing-case",
						toLspRange(action.diagnosticPosition),
					),
					clientDiagnostic("missing-case", {
						start: { line: 30, character: 0 },
						end: { line: 30, character: 4 },
					}),
					clientDiagnostic(
						"missing-return",
						toLspRange(action.diagnosticPosition),
					),
				]),
			)

			expect(item.diagnostics).toHaveLength(1)
			expect(item.diagnostics?.[0].range).toEqual(
				toLspRange(action.diagnosticPosition),
			)
		})

		it("should leave an action that answers no Diagnostic unattributed", () => {
			let range = {
				start: { line: 1, column: 1 },
				end: { line: 7, column: 2 },
			}
			let refactor = findCodeActions(source, range).find(
				(candidate) => candidate.kind === "refactor.rewrite",
			)

			expect(refactor).toBeDefined()

			let item = toLspCodeAction(
				refactor as NonNullable<typeof refactor>,
				paramsWith([]),
			)

			expect(item.kind).toBe(CodeActionKind.RefactorRewrite)
			expect(item.diagnostics).toBeUndefined()
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

	// NOTE: The transport is not something this Server chooses — createConnection
	// reads it off process.argv and throws when it finds none, so the invocation
	// that breaks is the one nobody automated: a person running the Server by
	// hand, and `essence lsp`, which forwards whatever the Editor passed and so
	// forwards nothing when nobody passed anything.
	describe("transport", () => {
		let originalArguments = process.argv

		afterEach(() => {
			process.argv = originalArguments
		})

		it("should fall back to stdio when no transport was named", () => {
			process.argv = ["bun", "/bin/esls"]

			ensureTransportArgument()

			expect(process.argv).toEqual(["bun", "/bin/esls", "--stdio"])
		})

		it("should fall back to stdio behind a delegating command name", () => {
			process.argv = ["bun", "/bin/essence", "lsp"]

			ensureTransportArgument()

			expect(process.argv).toEqual([
				"bun",
				"/bin/essence",
				"lsp",
				"--stdio",
			])
		})

		it("should leave a transport the Editor named alone", () => {
			for (let argument of [
				"--stdio",
				"--node-ipc",
				"--socket=6009",
				"--pipe=/tmp/essence.sock",
			]) {
				process.argv = ["bun", "/bin/essence", "lsp", argument]

				ensureTransportArgument()

				expect(process.argv).toEqual([
					"bun",
					"/bin/essence",
					"lsp",
					argument,
				])
			}
		})

		it("should leave a transport written as two tokens alone", () => {
			process.argv = ["bun", "/bin/esls", "--socket", "6009"]

			ensureTransportArgument()

			expect(process.argv).toEqual([
				"bun",
				"/bin/esls",
				"--socket",
				"6009",
			])
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

	it("should report no Diagnostics for a document in the standard library", () => {
		expect(analyse(source, stdlibPath)).toEqual([])
	})

	it("should accept a file:// URI as well as a plain path", () => {
		expect(analyse(source, `file://${stdlibPath}`)).toEqual([])
	})

	// NOTE: The same file under the spelling the Editor happens to have opened
	// the checkout with. A developer working through a symlink
	// (`~/dev/essence` → the real directory) hands the Language Server a path
	// that names this very file — compared lexically it matched nothing, and
	// the standard library became uneditable for that whole session: the
	// `declarations` header rejected, everything behind it mis-parsed, every
	// declaration a redeclaration of itself.
	it("should recognise the standard library through a symlinked checkout", () => {
		let directory = mkdtempSync(path.join(tmpdir(), "essence-symlink-"))
		let checkout = path.join(directory, "essence")

		// NOTE: The link and the path through it are derived from
		// `STDLIB_DIRECTORY` rather than spelled out, so this stays a test
		// about symlink resolution instead of a second, silent assertion about
		// where the sources happen to sit. Written out, the two halves have to
		// be kept agreeing by hand — and a mismatch does not fail loudly, it
		// just stops reaching the standard library and passes anyway.
		symlinkSync(path.dirname(STDLIB_DIRECTORY), checkout, "dir")

		try {
			let linkedPath = path.join(
				checkout,
				path.basename(STDLIB_DIRECTORY),
				"Boolean.es",
			)

			expect(isStdlibDocument(linkedPath)).toBe(true)
			expect(analyse(source, linkedPath)).toEqual([])
		} finally {
			// NOTE: The link is unlinked FIRST and on its own. A recursive
			// delete over a directory holding a link to the checkout is a
			// sentence nobody should have to trust twice.
			rmSync(checkout, { force: true })
			rmSync(directory, { recursive: true, force: true })
		}
	})

	// NOTE: On a case-insensitive filesystem — macOS' default — `sources`
	// and `SOURCES` are one directory and an Editor may hand over either
	// spelling; on a case-sensitive one they are two, and the variant is
	// genuinely not the standard library. Which of the two it is, is the
	// filesystem's answer to give rather than this comparison's to guess, so
	// the expectation is written as the filesystem's own.
	it("should recognise the standard library through a case-variant path", () => {
		let variantPath = path.join(
			path.dirname(STDLIB_DIRECTORY),
			path.basename(STDLIB_DIRECTORY).toUpperCase(),
			"Boolean.es",
		)

		expect(isStdlibDocument(variantPath)).toBe(existsSync(variantPath))
	})

	// NOTE: A standard library source that has never been saved is still a
	// standard library source — the Editor opens
	// `packages/stdlib/sources/Ordering.es` as a new file and the
	// `declarations` header has to be allowed while it is typed.
	// Canonicalising must therefore not require the file to exist.
	it("should recognise a standard library document that is not on disk yet", () => {
		expect(
			isStdlibDocument(path.join(STDLIB_DIRECTORY, "NotWrittenYet.es")),
		).toBe(true)
	})

	// NOTE: The other half of resolving paths for real: a user's own
	// `src/stdlib/Boolean.es` exists on disk and canonicalises perfectly well,
	// and is still not THIS compiler's standard library. Matching by shape
	// would tell them in their Editor that a `declarations { … }` block is
	// fine while `esc` rejects it.
	it("should still refuse a real src/stdlib in someone else's project", () => {
		let directory = mkdtempSync(path.join(tmpdir(), "essence-project-"))
		let ownPath = path.join(directory, "src", "stdlib", "Boolean.es")

		mkdirSync(path.dirname(ownPath), { recursive: true })
		writeFileSync(ownPath, source)

		try {
			expect(isStdlibDocument(ownPath)).toBe(false)
			expect(
				analyse(source, ownPath).map((diagnostic) => diagnostic.code),
			).toContain("declarations-outside-stdlib")
		} finally {
			rmSync(directory, { recursive: true, force: true })
		}
	})

	// NOTE: The permission is the standard library's alone. Lifting it for
	// every document would retire `declarations-outside-stdlib` by accident —
	// and a user's own `src/stdlib/Boolean.es` is a plausible thing to write,
	// so the Editor must not tell them a `declarations` block is fine there
	// while `esc` rejects it.
	it("should still reject a 'declarations' header anywhere else", () => {
		for (let documentPath of [
			undefined,
			fixturePath("Boolean.es"),
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
		let { program: enrichedProgram, annotations } = enrichDocument(
			program,
			stdlibPath,
			{ annotations: true },
		)

		let hoverAt = (line: number, column: number) =>
			findHover(enrichedProgram, { line, column }, program, annotations)

		expect(hoverAt(8, 4)?.content).toBe("is(_ Boolean) -> Boolean")
		expect(hoverAt(8, 4)?.documentation).toBe("Whether the two are equal.")
		// NOTE: The Parameter's own name, and the annotations either side of it.
		expect(hoverAt(8, 9)?.content).toBe("other: Boolean")
		expect(hoverAt(8, 16)?.content).toBe("Boolean")
		expect(hoverAt(8, 28)?.content).toBe("Boolean")
		expect(hoverAt(14, 4)?.content).toBe("toString() -> String")
	})

	// NOTE: What the pass above could never answer — it pairs a parsed
	// annotation with the Type it resolved to as a WHOLE, so the cursor inside
	// one got the whole thing back. The annotation index records each nested
	// Type against its own span, so `Boolean` within `List<Boolean>` is its own
	// answer.
	it("should describe the Type inside a native signature's compound annotation", () => {
		let compoundSource = [
			"declarations {",
			"\tnamespace Boolean for Boolean {",
			"\t\t§§ As a single element List.",
			"\t\ttoList() -> List<Boolean>",
			"\t}",
			"}",
		].join("\n")

		let { program } = parseDocument(compoundSource, stdlibPath)
		let { program: enrichedProgram, annotations } = enrichDocument(
			program,
			stdlibPath,
			{ annotations: true },
		)

		let hoverAt = (line: number, column: number) =>
			findHover(enrichedProgram, { line, column }, program, annotations)

		expect(hoverAt(4, 4)?.content).toBe("toList() -> List<Boolean>")
		expect(hoverAt(4, 15)?.content).toBe("List<Boolean>")
		expect(hoverAt(4, 21)?.content).toBe("Boolean")
	})

	// NOTE: Every real standard library source, analysed the way the editor
	// analyses it, is clean. The loader already throws on a Diagnostic; this
	// says the Language Server agrees with it, which it did not before — and
	// since the standard library is where the language is now written, an
	// editor that could not open it would be an editor nobody can extend it in.
	it("should report no Diagnostics for any real standard library source", () => {
		let fileNames = readdirSync(STDLIB_DIRECTORY).filter((fileName) =>
			fileName.endsWith(".es"),
		)

		expect(fileNames.length).toBeGreaterThan(0)

		for (let fileName of fileNames) {
			let filePath = path.resolve(STDLIB_DIRECTORY, fileName)

			expect([
				fileName,
				analyse(readFileSync(filePath, "utf-8"), filePath),
			]).toEqual([fileName, []])
		}
	})
})
