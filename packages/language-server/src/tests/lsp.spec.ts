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
} from "@essence-lang/compiler/documents"
import { testDiagnostic } from "@essence-lang/compiler/tests/diagnosticFactory"
import { fixturePath } from "@essence-lang/fixtures"
import { STDLIB_DIRECTORY } from "@essence-lang/standard-library"
import {
	type CodeAction,
	CodeActionKind,
	CompletionItemKind,
	type Diagnostic,
	DiagnosticSeverity,
	DiagnosticTag,
	InsertTextFormat,
	type TextEdit,
	TextDocumentSyncKind,
	type WorkspaceEdit,
} from "vscode-languageserver"
import {
	CodeActionRequest,
	HoverRequest,
	WillRenameFilesRequest,
} from "vscode-languageserver/node"

import { analyse, documentFilePath } from "../analyse"
import {
	type CodeActionEntry,
	findCodeActions,
	isRequestedKind,
} from "../codeActions"
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
	uriOf,
} from "../server"
import {
	type LspSession,
	makeSessionWorkspace,
	startSession,
} from "./lspSession"

describe("LSP", () => {
	describe("analyse", () => {
		it("should report no Diagnostics for a valid Program", () => {
			expect(
				analyse(`implementation {
					constant name: String = "essence"
					Terminal.inspect(name)
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

		// NOTE: The Compiler stops after the Parser, so what a habit written
		// BEHIND a Statement costs is only ever visible here: a Declaration
		// dropped with the refusal leaves its name undeclared, and the editor
		// answers that at every line that reads it. The Parser reads past a ';'
		// and a Comment for exactly this reason — see `swallowForeignTail`.
		it("should keep the Statement a ';' or a Comment was written behind", () => {
			expect(
				analyse(`implementation {
					constant price = 250;
					Terminal.print(price)
					Terminal.print(price::add(1))
				}`).map((diagnostic) => diagnostic.message),
			).toEqual(["A Statement does not end with ';'"])

			expect(
				analyse(`implementation {
					constant price = 250 // the price
					Terminal.print(price)
					Terminal.print(price::add(1))
				}`).map((diagnostic) => diagnostic.message),
			).toEqual(["A Comment is written with '§'"])

			expect(
				analyse(`implementation {
					constant price = 250 /* the price */
					Terminal.print(price)
					Terminal.print(price::add(1))
				}`).map((diagnostic) => diagnostic.message),
			).toEqual(["A Comment is written with '§'"])
		})

		// NOTE: The same property for `primes[0]`, and visible in the same one
		// place: an `essence check` stops after the Parser, so a cascade a
		// refused index set off would be the editor's alone to show. Both
		// halves are pinned — the name is still DECLARED, so nothing says
		// `unknown-name` about it, and what it is bound to is an Error rather
		// than the List in front of the brackets, so nothing offers `pad` for
		// the `add` written on the line below.
		it("should keep the Declaration an index was written in, and type it Error", () => {
			expect(
				analyse(`implementation {
					constant primes = [2, 3, 5]
					constant first = primes[0]
					Terminal.print(first::add(1))
					Terminal.print(first)
				}`).map((diagnostic) => diagnostic.message),
			).toEqual(["A value is not indexed with brackets"])
		})

		// NOTE: And nothing the BASE of a refused index has to say is said
		// either. What stands in front of the brackets is decided by where the
		// Parser cut the Expression: a label written flush against a '[' is
		// read as the value the brackets index, so `contentsOf[3, 4]` reported
		// `'contentsOf' is not declared` about a name nobody wrote as a name. A
		// base whose own report would have been true is silenced with it — one
		// written mistake, one report.
		it("should say nothing about the value a refused index stands behind", () => {
			expect(
				analyse(`implementation {
					constant readings = [1, 2]
					Terminal.inspect(readings::append(contentsOf[3, 4]))
				}`).map((diagnostic) => diagnostic.message),
			).toEqual(["A value is not indexed with brackets"])

			expect(
				analyse(`implementation {
					Terminal.inspect(undeclared[0])
				}`).map((diagnostic) => diagnostic.message),
			).toEqual(["A value is not indexed with brackets"])
		})

		// NOTE: The Validator runs whatever the Enricher found, so a Type error
		// and a Validator error in one file are one run's worth of report. It
		// used to take two: the Enricher's Diagnostic hid the Validator's, and
		// the second only appeared once the first was fixed.
		it("should run the Validator when the Enricher reported errors", () => {
			let diagnostics = analyse(`implementation {
				constant a = undeclaredVariable
				constant b: String = true
			}`)

			expect(diagnostics.map((diagnostic) => diagnostic.code)).toEqual([
				"unknown-name",
				"assignment-type-mismatch",
			])
		})

		// NOTE: The order a report comes out in is the order the lines are
		// written, whichever stage found each of them — a Validator Diagnostic
		// above a syntax error where that is where they stand.
		it("should report every stage in file order", () => {
			let diagnostics = analyse(`implementation {
				constant a: String = true
				constant b = (
			}`)

			expect(
				diagnostics.map((diagnostic) => [
					diagnostic.code,
					diagnostic.position?.start.line,
				]),
			).toEqual([
				["assignment-type-mismatch", 2],
				["syntax-error", 4],
			])
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
						CodeActionKind.RefactorExtract,
						CodeActionKind.RefactorInline,
						CodeActionKind.RefactorMove,
						CodeActionKind.SourceOrganizeImports,
					],
				},
				completionProvider: {
					triggerCharacters: [".", ":", "<", "#"],
					resolveProvider: true,
				},
				workspaceSymbolProvider: true,
				workspace: {
					workspaceFolders: {
						supported: true,
						changeNotifications: true,
					},
					fileOperations: {
						willRename: {
							filters: [
								{
									scheme: "file",
									pattern: {
										glob: "**/*.es",
										matches: "file",
									},
								},
								{
									scheme: "file",
									pattern: {
										glob: "**/.*/**/*.es",
										matches: "file",
									},
								},
								{
									scheme: "file",
									pattern: { glob: "**", matches: "folder" },
								},
								{
									scheme: "file",
									pattern: {
										glob: "**/.*/**",
										matches: "folder",
									},
								},
							],
						},
					},
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
				codeLensProvider: { resolveProvider: false },
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

		// NOTE: Spelled out rather than found, for the shapes no fix produces
		// yet — an entry reaching a second file, and one carrying a command.
		const span = {
			start: { line: 2, column: 2 },
			end: { line: 2, column: 6 },
		}

		function entryWith(
			overrides: Partial<CodeActionEntry>,
		): CodeActionEntry {
			return {
				title: "Extract the Expression",
				kind: "refactor.rewrite",
				diagnosticCode: null,
				diagnosticPosition: null,
				isPreferred: false,
				edits: [],
				...overrides,
			}
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

		// NOTE: Every fix edits the document it was offered on, and a
		// refactoring that moves something does not — which the protocol says
		// as a second key of the one map.
		it("should group the edits of an action by the file each belongs to", () => {
			let other = "/Other.es"
			let item = toLspCodeAction(
				entryWith({
					edits: [
						{ range: span, newText: "here" },
						{ range: span, newText: "there", filePath: other },
					],
				}),
				paramsWith([]),
			)

			expect(Object.keys(item.edit?.changes ?? {})).toEqual([
				uri,
				uriOf(other),
			])
			expect(item.edit?.changes?.[uriOf(other)]).toEqual([
				{ range: toLspRange(span), newText: "there" },
			])
		})

		// NOTE: A path that spells the open document IS the open document. Two
		// keys to the one file would have the Editor apply half the action to a
		// buffer it is holding and half to the file under it.
		it("should keep an edit naming the open file under the URI it came in under", () => {
			let item = toLspCodeAction(
				entryWith({
					edits: [
						{ range: span, newText: "here" },
						{
							range: span,
							newText: "there",
							filePath: documentFilePath(uri),
						},
					],
				}),
				paramsWith([]),
			)

			expect(Object.keys(item.edit?.changes ?? {})).toEqual([uri])
			expect(item.edit?.changes?.[uri]).toHaveLength(2)
		})

		// NOTE: A text edit can not create the file it edits, so the one action
		// that writes a Module hands its edits over as `documentChanges` with
		// the creation in front of them — the shape the protocol says a
		// resource operation in, and the only one an Editor will apply.
		it("should ask for a file that does not exist yet to be created", () => {
			let written = "/Written.es"
			let item = toLspCodeAction(
				entryWith({
					kind: "refactor.move",
					edits: [
						{ range: span, newText: "" },
						{
							range: {
								start: { line: 1, column: 1 },
								end: { line: 1, column: 1 },
							},
							newText: "implementation {}\n",
							filePath: written,
							createFile: true,
						},
					],
				}),
				paramsWith([]),
			)

			expect(item.kind).toBe(CodeActionKind.RefactorMove)
			expect(item.edit?.changes).toBeUndefined()
			expect(item.edit?.documentChanges).toEqual([
				{ kind: "create", uri: uriOf(written) },
				{
					textDocument: { uri, version: null },
					edits: [{ range: toLspRange(span), newText: "" }],
				},
				{
					textDocument: { uri: uriOf(written), version: null },
					edits: [
						{
							range: toLspRange({
								start: { line: 1, column: 1 },
								end: { line: 1, column: 1 },
							}),
							newText: "implementation {}\n",
						},
					],
				},
			])
		})

		it("should hand a client command through untouched", () => {
			let command = {
				title: "Rename the extracted Constant",
				command: "essence.startRename",
				arguments: [uri, 2],
			}

			let item = toLspCodeAction(entryWith({ command }), paramsWith([]))

			expect(item.command).toEqual(command)
		})

		it("should carry no command for an action that asked for none", () => {
			let item = toLspCodeAction(entryWith({}), paramsWith([]))

			expect(item.command).toBeUndefined()
		})
	})

	describe("isRequestedKind", () => {
		it("should keep every kind for a request that named none", () => {
			expect(isRequestedKind("quickfix", undefined)).toBe(true)
			expect(isRequestedKind("refactor.rewrite", undefined)).toBe(true)
			expect(isRequestedKind("quickfix", [])).toBe(true)
		})

		// NOTE: The Refactor menu is the request that asks for `refactor`, and
		// a fix listed in it is a fix the reader went looking for a rewrite in.
		it("should keep the refactors and drop the fixes for a refactor request", () => {
			expect(isRequestedKind("refactor.rewrite", ["refactor"])).toBe(true)
			expect(isRequestedKind("quickfix", ["refactor"])).toBe(false)
		})

		it("should keep the fixes and drop the refactors for a quickfix request", () => {
			expect(isRequestedKind("quickfix", ["quickfix"])).toBe(true)
			expect(isRequestedKind("refactor.rewrite", ["quickfix"])).toBe(
				false,
			)
		})

		// NOTE: A kind matches itself and everything under it, and nothing
		// above it — an Editor asking for one branch of the menu must not be
		// handed the whole of `refactor`.
		it("should read a requested kind as itself and what it holds", () => {
			expect(
				isRequestedKind("refactor.rewrite", ["refactor.rewrite"]),
			).toBe(true)
			expect(
				isRequestedKind("refactor.rewrite", ["refactor.extract"]),
			).toBe(false)
			expect(isRequestedKind("quickfix", ["quick"])).toBe(false)
		})

		it("should keep a kind any one of the requested kinds holds", () => {
			expect(
				isRequestedKind("refactor.rewrite", ["quickfix", "refactor"]),
			).toBe(true)
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
					'\t\tTerminal.inspect("no return")',
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

// NOTE: Read off the request as it arrives rather than only out of the pure
// filter beside it: `context.only` is what an Editor sends, and a handler that
// never looks at it passes every spec it has while the Refactor menu lists the
// Quick Fixes.
describe("Code Actions asked for one kind", () => {
	const source = [
		"implementation {",
		"\ttype Value = Integer | String",
		"\tconstant something: Value = 42",
		"\tconstant answer = match something -> String {",
		'\t\tcase Integer { <- "an Integer" }',
		"\t}",
		"}",
	].join("\n")

	async function kindsFor(
		session: LspSession,
		uri: string,
		only?: Array<string>,
	): Promise<Array<string | undefined>> {
		let { result } = await session.request<Array<CodeAction>>(
			CodeActionRequest.type,
			{
				textDocument: { uri },
				range: {
					start: { line: 0, character: 0 },
					end: { line: 6, character: 1 },
				},
				context: { diagnostics: [], only },
			},
		)

		return result.map((action) => action.kind)
	}

	it("should answer with nothing but the kinds the request named", async () => {
		let files = makeSessionWorkspace({ "Test.es": source })
		let session = startSession()

		try {
			await session.initialize([files.root])
			await session.open(files.pathOf("Test.es"), source)
			await session.settle()

			let uri = uriOf(files.pathOf("Test.es"))
			let everything = await kindsFor(session, uri)

			expect(everything).toContain(CodeActionKind.QuickFix)
			expect(everything).toContain(CodeActionKind.RefactorRewrite)

			let refactors = await kindsFor(session, uri, [
				CodeActionKind.Refactor,
			])

			// NOTE: Every kind the menu lists is one of the refactorings and
			// none of them is a fix — which is the whole of what `only` asks
			// for. Spelled as a prefix rather than as one kind, because the
			// Server offers more than one of them: a Type annotation written
			// out is a rewrite, a Declaration sent to another Module is a move.
			expect(refactors.length).toBeGreaterThan(0)
			expect(
				refactors.every((kind) =>
					kind?.startsWith(CodeActionKind.Refactor),
				),
			).toBe(true)
			expect(refactors).toContain(CodeActionKind.RefactorMove)

			let fixes = await kindsFor(session, uri, [CodeActionKind.QuickFix])

			expect(fixes.length).toBeGreaterThan(0)
			expect(fixes).toEqual(fixes.map(() => CodeActionKind.QuickFix))
		} finally {
			await session.dispose()
			files.dispose()
		}
	})
})

// NOTE: What a client can APPLY is not what the Server can compute, and the
// protocol says both shapes of a Workspace Edit are the client's to allow: an
// editor that never advertised `documentChanges` silently applies nothing when
// it is sent one, and one whose `resourceOperations` omit `create` can not be
// handed an action that writes a file. VS Code advertises both, so none of this
// is about VS Code — it is about the editors on the roadmap.
describe("Code Actions for a client that can apply less", () => {
	const source = [
		"implementation {",
		"\tconstant answer = 42",
		"}",
		"",
		"export {",
		"\tanswer",
		"}",
		"",
	].join("\n")

	async function actionsFor(
		session: LspSession,
		uri: string,
	): Promise<Array<CodeAction>> {
		let { result } = await session.request<Array<CodeAction>>(
			CodeActionRequest.type,
			{
				textDocument: { uri },
				range: {
					start: { line: 1, character: 10 },
					end: { line: 1, character: 16 },
				},
				context: { diagnostics: [] },
			},
		)

		return result
	}

	async function inSession(
		workspace: object | undefined,
	): Promise<Array<CodeAction>> {
		let files = makeSessionWorkspace({ "Main.es": source })
		let session = startSession()

		try {
			if (workspace === undefined) {
				await session.initialize([files.root])
			} else {
				await session.initialize([files.root], workspace)
			}

			await session.open(files.pathOf("Main.es"), source)
			await session.settle()

			return await actionsFor(session, uriOf(files.pathOf("Main.es")))
		} finally {
			await session.dispose()
			files.dispose()
		}
	}

	it("withholds the action that creates a file, and answers changes", async () => {
		let full = await inSession(undefined)
		let plain = await inSession({ workspaceFolders: true })

		// NOTE: The move to a NEW Module is the one action in this Server that
		// writes a file that is not there yet.
		expect(full.map((action) => action.title)).toContain(
			"Move 'answer' to a new Module",
		)
		expect(plain.map((action) => action.title)).not.toContain(
			"Move 'answer' to a new Module",
		)

		// NOTE: And everything that is left reaches such a client in the shape
		// it does take — a map of files, and no resource operation beside it.
		expect(plain.length).toBeGreaterThan(0)
		expect(
			plain.every(
				(action) =>
					action.edit === undefined ||
					(action.edit.changes !== undefined &&
						action.edit.documentChanges === undefined),
			),
		).toBe(true)
	})

	// NOTE: `documentChanges` without `create` is the other half: the shape is
	// allowed, the operation is not.
	it("withholds the creation from a client that only edits documents", async () => {
		let edits = await inSession({
			workspaceFolders: true,
			workspaceEdit: { documentChanges: true },
		})

		expect(edits.map((action) => action.title)).not.toContain(
			"Move 'answer' to a new Module",
		)
	})
})

// NOTE: A list of protocol TextEdits applied to a buffer. The protocol counts
// lines and characters from zero and requires the edits not to overlap, so they
// are applied from the back and nothing has to be shifted.
function applyLspEdits(text: string, edits: Array<TextEdit>): string {
	let lines = text.split("\n")
	let offsetOf = (position: { line: number; character: number }): number => {
		let offset = 0

		for (let line = 0; line < position.line; line++) {
			offset += (lines[line] as string).length + 1
		}

		return offset + position.character
	}

	let sorted = [...edits].sort(
		(a, b) => offsetOf(b.range.start) - offsetOf(a.range.start),
	)
	let written = text

	for (let edit of sorted) {
		written =
			written.slice(0, offsetOf(edit.range.start)) +
			edit.newText +
			written.slice(offsetOf(edit.range.end))
	}

	return written
}

// NOTE: `essence.json` reaches this Server because the extension's document
// selector names it, and every request over it is refused — a project file is
// not a source. Code Actions are the one exception: a Diagnostic that names its
// own answer and will not apply it is a squiggle that reads as the editor being
// broken.
describe("Code Actions on the project file", () => {
	async function actionsFor(
		session: LspSession,
		uri: string,
		line: number,
	): Promise<Array<CodeAction>> {
		let { result } = await session.request<Array<CodeAction>>(
			CodeActionRequest.type,
			{
				textDocument: { uri },
				range: {
					start: { line, character: 0 },
					end: { line, character: 40 },
				},
				context: { diagnostics: [] },
			},
		)

		return result
	}

	it("should offer the spelling a misspelt setting was reaching for", async () => {
		let project = ["{", '\t"excludes": ["build"]', "}", ""].join("\n")
		let files = makeSessionWorkspace({ "essence.json": project })
		let session = startSession()

		try {
			await session.initialize([files.root])
			await session.open(files.pathOf("essence.json"), project, "jsonc")
			await session.settle()

			expect(session.codesFor(files.pathOf("essence.json"))).toEqual([
				"unknown-setting",
			])

			let [action] = await actionsFor(
				session,
				uriOf(files.pathOf("essence.json")),
				1,
			)

			expect(action.title).toBe('Change to "exclude"')
			expect(action.kind).toBe(CodeActionKind.QuickFix)
			expect(action.isPreferred).toBe(true)

			let edits =
				action.edit?.changes?.[uriOf(files.pathOf("essence.json"))]

			expect(edits).toEqual([
				{
					range: {
						start: { line: 1, character: 1 },
						end: { line: 1, character: 11 },
					},
					newText: '"exclude"',
				},
			])
		} finally {
			await session.dispose()
			files.dispose()
		}
	})

	it("should offer to move a setting that has moved", async () => {
		let project = [
			"{",
			'\t"test": {',
			'\t\t"exclude": ["build"]',
			"\t}",
			"}",
			"",
		].join("\n")
		let files = makeSessionWorkspace({ "essence.json": project })
		let session = startSession()

		try {
			await session.initialize([files.root])
			await session.open(files.pathOf("essence.json"), project, "jsonc")
			await session.settle()

			let [action] = await actionsFor(
				session,
				uriOf(files.pathOf("essence.json")),
				2,
			)

			expect(action.title).toBe('Move it to "exclude"')

			let edits =
				action.edit?.changes?.[uriOf(files.pathOf("essence.json"))] ??
				[]

			expect(applyLspEdits(project, edits)).toBe(
				["{", '\t"exclude": [', '\t\t"build"', "\t]", "}", ""].join(
					"\n",
				),
			)
		} finally {
			await session.dispose()
			files.dispose()
		}
	})

	// NOTE: Nothing else about a project file changed — the Server still has no
	// Program to answer a Hover, a Completion or a rename over one.
	it("should still refuse every other request over a project file", async () => {
		let project = ["{", '\t"excludes": ["build"]', "}", ""].join("\n")
		let files = makeSessionWorkspace({ "essence.json": project })
		let session = startSession()

		try {
			await session.initialize([files.root])
			await session.open(files.pathOf("essence.json"), project, "jsonc")
			await session.settle()

			let { result } = await session.request<unknown>(HoverRequest.type, {
				textDocument: {
					uri: uriOf(files.pathOf("essence.json")),
				},
				position: { line: 1, character: 3 },
			})

			expect(result).toBeNull()
		} finally {
			await session.dispose()
			files.dispose()
		}
	})
})

// NOTE: The two Keywords over the wire, on a document an editor opened: what the
// Server publishes about it, what it says about the words themselves, and what
// the lightbulb offers where the Compiler has something to say. Every layer
// between the walks and the client is what this exercises — the analysis, the
// Hover, the Code Action conversion.
describe("A document that starts and completes work", () => {
	const source = [
		"implementation {",
		"\tfunction doubled(_ value: Integer) -> Future<Integer> {",
		"\t\t<- complete Async.deferred(() { <- value })",
		"\t}",
		"",
		"\tconstant answer = complete doubled(21)",
		"\tconstant running = start doubled(21)",
		"",
		"\tTerminal.inspect(answer)",
		"\tTerminal.inspect(complete running)",
		"}",
		"",
	].join("\n")

	it("should publish nothing, answer the Keywords and fix a dropped future", async () => {
		let files = makeSessionWorkspace({ "Async.es": source })
		let session = startSession()

		try {
			await session.initialize([files.root])
			await session.open(files.pathOf("Async.es"), source)
			await session.settle()

			let uri = uriOf(files.pathOf("Async.es"))

			expect(session.diagnosticsFor(files.pathOf("Async.es"))).toEqual([])

			// NOTE: The Hover positions are zero based over the wire — the
			// `complete` of line 6 and the `start` of line 7.
			let hoverAt = async (line: number, character: number) => {
				let { result } = await session.request<{
					contents: { value: string }
				}>(HoverRequest.type, {
					textDocument: { uri },
					position: { line, character },
				})

				return result?.contents.value
			}

			expect(await hoverAt(5, 19)).toContain("Integer")
			expect(await hoverAt(6, 20)).toContain("Started<Integer>")

			// NOTE: The same document with the future dropped on the floor,
			// which is the Error the two words answer.
			let dropped = source
				.replace(
					"\tconstant answer = complete doubled(21)",
					"\tdoubled(21)",
				)
				.replace("\tTerminal.inspect(answer)", "\tTerminal.inspect(1)")

			await session.change(files.pathOf("Async.es"), dropped)
			await session.settle()

			expect(session.codesFor(files.pathOf("Async.es"))).toContain(
				"unused-future",
			)

			let { result } = await session.request<Array<CodeAction>>(
				CodeActionRequest.type,
				{
					textDocument: { uri },
					range: {
						start: { line: 5, character: 1 },
						end: { line: 5, character: 12 },
					},
					context: {
						diagnostics: [],
						only: [CodeActionKind.QuickFix],
					},
				},
			)

			expect(result.map((action) => action.title)).toEqual([
				"Wait for it with 'complete'",
				"Put it in flight with 'start'",
			])
		} finally {
			await session.dispose()
			files.dispose()
		}
	})
})

// NOTE: A specifier is a path written in the source, so a file that moves takes
// every entry naming it out of step — and takes its own entries out of step too,
// since they were written from where it used to be. Both are answered before the
// move happens, in one edit with it.
describe("A file about to be renamed", () => {
	const shared = [
		"implementation {",
		"\tconstant base = 1",
		"}",
		"",
		"export {",
		"\tbase",
		"}",
		"",
	].join("\n")

	async function willRename(
		session: LspSession,
		moves: Array<{ from: string; to: string }>,
	): Promise<Record<string, Array<TextEdit>>> {
		let { result } = await session.request<WorkspaceEdit | null>(
			WillRenameFilesRequest.type,
			{
				files: moves.map((move) => ({
					oldUri: uriOf(move.from),
					newUri: uriOf(move.to),
				})),
			},
		)

		return result?.changes ?? {}
	}

	it("should rewrite the entries naming it and the ones it wrote itself", async () => {
		let files = makeSessionWorkspace({
			"Shared.es": shared,
			"A.es": [
				"import {",
				'\tfrom "./Shared.es" { base }',
				"}",
				"",
				"implementation {",
				"\tconstant doubled = base::multiply(with 2)",
				"}",
				"",
				"export {",
				"\tdoubled",
				"}",
				"",
			].join("\n"),
			"Main.es": [
				"import {",
				'\tfrom "./A.es" { doubled }',
				"}",
				"",
				"implementation {",
				"\tTerminal.inspect(doubled::toString())",
				"}",
				"",
			].join("\n"),
		})
		let session = startSession()

		try {
			await session.initialize([files.root])
			await session.settle()

			let changes = await willRename(session, [
				{ from: files.pathOf("A.es"), to: files.pathOf("lib/A.es") },
			])

			expect(Object.keys(changes).sort()).toEqual(
				[
					uriOf(files.pathOf("A.es")),
					uriOf(files.pathOf("Main.es")),
				].sort(),
			)
			expect(changes[uriOf(files.pathOf("A.es"))]).toEqual([
				{
					range: {
						start: { line: 1, character: 6 },
						end: { line: 1, character: 19 },
					},
					newText: '"../Shared.es"',
				},
			])
			expect(changes[uriOf(files.pathOf("Main.es"))]).toEqual([
				{
					range: {
						start: { line: 1, character: 6 },
						end: { line: 1, character: 14 },
					},
					newText: '"./lib/A.es"',
				},
			])
		} finally {
			await session.dispose()
			files.dispose()
		}
	})

	// NOTE: A directory is ONE request about the directory rather than one per
	// file under it, and the client sends it because the Server asked about
	// folders as well. A folder holding no Essence answers with nothing.
	it("should answer for every source under a directory that moves", async () => {
		let files = makeSessionWorkspace({
			"Shared.es": shared,
			"lib/Helper.es": [
				"import {",
				'\tfrom "../Shared.es" { base }',
				"}",
				"",
				"implementation {",
				"\tconstant doubled = base::multiply(with 2)",
				"}",
				"",
				"export {",
				"\tdoubled",
				"}",
				"",
			].join("\n"),
			"Main.es": [
				"import {",
				'\tfrom "./lib/Helper.es" { doubled }',
				"}",
				"",
				"implementation {",
				"\tTerminal.inspect(doubled::toString())",
				"}",
				"",
			].join("\n"),
		})
		let session = startSession()

		try {
			await session.initialize([files.root])
			await session.settle()

			let changes = await willRename(session, [
				{ from: files.pathOf("lib"), to: files.pathOf("deep/lib") },
			])

			expect(
				changes[uriOf(files.pathOf("lib/Helper.es"))]?.map(
					(edit) => edit.newText,
				),
			).toEqual(['"../../Shared.es"'])
			expect(
				changes[uriOf(files.pathOf("Main.es"))]?.map(
					(edit) => edit.newText,
				),
			).toEqual(['"./deep/lib/Helper.es"'])

			expect(
				await willRename(session, [
					{
						from: files.pathOf("elsewhere"),
						to: files.pathOf("moved"),
					},
				]),
			).toEqual({})
		} finally {
			await session.dispose()
			files.dispose()
		}
	})

	// NOTE: A source renamed OUT of the language is not a move to rewrite to.
	// `"./Shared.txt"` is a specifier the Compiler refuses outright, so writing
	// it into every dependent would be the Server volunteering text that can
	// not compile and putting it in the reader's undo stack. The import was
	// going to dangle either way; what is left is the Diagnostic that says so.
	//
	// A DIRECTORY rename is not one of these — its new path is a directory, and
	// the sources beneath it keep their own names — which the test above, where
	// `lib` becomes `deep/lib`, is what holds.
	it("should answer nothing for a rename that leaves the language", async () => {
		let files = makeSessionWorkspace({
			"Shared.es": shared,
			"Main.es": [
				"import {",
				'\tfrom "./Shared.es" { base }',
				"}",
				"",
				"implementation {",
				"\tTerminal.inspect(base::toString())",
				"}",
				"",
			].join("\n"),
		})
		let session = startSession()

		try {
			await session.initialize([files.root])
			await session.settle()

			expect(
				await willRename(session, [
					{
						from: files.pathOf("Shared.es"),
						to: files.pathOf("Shared.txt"),
					},
				]),
			).toEqual({})
		} finally {
			await session.dispose()
			files.dispose()
		}
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
	// `packages/standard-library/sources/Ordering.es` as a new file and the
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
			"\tTerminal.inspect(greeting)",
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
