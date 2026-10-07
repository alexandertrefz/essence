import { afterEach, describe, expect, it, spyOn } from "bun:test"
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
	ErrorCodes,
	InsertTextFormat,
	type TextEdit,
	TextDocumentSyncKind,
	type WorkspaceEdit,
} from "vscode-languageserver"
import {
	CodeActionRequest,
	CompletionRequest,
	HoverRequest,
	LogMessageNotification,
	MessageType,
	PrepareRenameRequest,
	RenameRequest,
	SignatureHelpRequest,
	WillRenameFilesRequest,
} from "vscode-languageserver/node"

import { analyse, documentFilePath } from "../analyse"
import {
	type CodeActionEntry,
	findCodeActions,
	isRequestedKind,
} from "../codeActions"
import * as compilation from "../compilation"
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
import { applyEdits } from "./textEdits"

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

		// A Declaration dropped with the refusal would leave its name undeclared
		// at every line that reads it. See "Another language's syntax" in
		// packages/compiler/src/parser/DEVELOPMENT.md.
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

		// The same for `primes[0]`. The name stays declared, so nothing says
		// `unknown-name`. It is bound to an Error rather than the List, so nothing
		// offers `pad` for the `add` on the next line.
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

		// The base of a refused index reports nothing either. A label flush
		// against a '[' is read as the base, so `contentsOf[3, 4]` would report a
		// name nobody wrote. One written mistake gets one report.
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

		// The Validator runs whatever the Enricher found, so one run reports a
		// Type error and a Validator error together.
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

		// A report comes out in the order the lines are written, whichever stage
		// found each one.
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

		// An Editor sends an empty selection for a cursor on a squiggle, which
		// is how a Quick Fix is usually asked for.
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

	// Without its capability, no Editor asks for a feature while its handler's
	// spec keeps passing. So the announcement is asserted on its own.
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
				inlayHintProvider: { resolveProvider: true },
				linkedEditingRangeProvider: true,
				callHierarchyProvider: true,
			})
		})

		// The legend is two arrays of names that every Token indexes, so a
		// client holding an older one recolours everything past a moved entry.
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

		// Not one of the fixes is both unambiguous and
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

		// Halfway through a keystroke nothing resolves, and a callable
		// still has to insert something better than its bare name.
		it("should fall back to bare parentheses for a callable with no snippet", () => {
			let item = toLspCompletionItem(entry({ snippet: null }))

			expect(item.insertText).toBe("greet($0)")
			expect(item.insertTextFormat).toBe(InsertTextFormat.Snippet)
		})

		// `$` is an ordinary Identifier character, so an unescaped `we$rd` would
		// insert `we` followed by the Editor's `$rd` variable.
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
			// The label the Editor matches and sorts on is not snippet
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

		// The inserted call never types `(` or `,`, so the Editor is asked to
		// open the parameter hints. That holds for both inserts, and not for a
		// name only referred to.
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

		// Spelled out for shapes no fix produces: an entry reaching a second
		// file, and one carrying a command.
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

		// Attribution only. The edits were computed on the current buffer, while
		// the client's Diagnostics may belong to one a debounce older.
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

		// Every fix edits the document it was offered on, and a move edits
		// another file too, as a second key of the one map.
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

		// A path that spells the open document is the open document. Two keys
		// would apply half the action to the buffer and half to the file under it.
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

		// A text edit cannot create the file it edits. An action that writes a
		// Module sends `documentChanges` with the creation first, the protocol's
		// shape for a resource operation.
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

		// The Refactor menu asks for `refactor`, and a fix is not what the
		// reader looks for there.
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

		// A kind matches itself and everything under it, and nothing above it.
		// An Editor asking for one branch of the menu gets only that branch.
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

	// `createConnection` reads the transport off process.argv and throws when
	// none is named. A person running the Server by hand, or `essence lsp`
	// with no arguments, names none.
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

// Read off the request as it arrives, since `context.only` is what an Editor
// sends. A handler that ignored it would list Quick Fixes as refactorings.
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

			// Every kind the menu lists is a refactoring and none is a fix. It is
			// matched by prefix, since the Server offers both rewrites and moves.
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

// An editor that never advertised `documentChanges` silently applies nothing
// sent in that shape. One whose `resourceOperations` omit `create` cannot take
// an action that writes a file.
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

		// The move to a new Module writes a file that is not there yet.
		expect(full.map((action) => action.title)).toContain(
			"Move 'answer' to a new Module",
		)
		expect(plain.map((action) => action.title)).not.toContain(
			"Move 'answer' to a new Module",
		)

		// Everything else reaches such a client in the shape it takes: a map of
		// files, with no resource operation.
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

	// `documentChanges` without `create` is the other half: the shape is
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

// A list of protocol TextEdits applied to a buffer. The protocol counts
// lines and characters from zero, and the applier reads one-based Cursors.
function applyLspEdits(text: string, edits: Array<TextEdit>): string {
	let cursorOf = (position: { line: number; character: number }) => ({
		line: position.line + 1,
		column: position.character + 1,
	})

	return applyEdits(
		text,
		edits.map((edit) => ({
			range: {
				start: cursorOf(edit.range.start),
				end: cursorOf(edit.range.end),
			},
			newText: edit.newText,
		})),
	)
}

// The extension's document selector sends `essence.json` here, and a project
// file is not a source, so requests over it are refused. Code Actions are the
// exception, so a Diagnostic that names its answer can apply it.
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

	// The Server has no Program to answer a Hover, a Completion or a rename
	// over a project file.
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

// `start` and `complete` over the wire: what the Server publishes, what Hover
// says about the words, and what the lightbulb offers. This exercises every
// layer between the walks and the client.
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

			// Hover positions are zero-based over the wire: the `complete` of line
			// 6 and the `start` of line 7.
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

			// The same document with the future dropped on the floor,
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

// A specifier is a path written in the source. A moving file takes every entry
// naming it out of step, and its own entries too. One edit answers both.
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

	// A directory is one request, not one per file under it, since the Server
	// asked about folders too. A folder holding no Essence answers with nothing.
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

	// A source renamed out of the language is not a move to rewrite to. The
	// Compiler refuses `"./Shared.txt"`, so writing it into dependents would add
	// text that cannot compile. A directory rename keeps its sources' names.
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

// The Server picks the rule a new name must satisfy from the joined symbol.
// A Parameter whose name doubles as its label must reach it marked as one.
describe("A rename asked of the Server", () => {
	const source = [
		"implementation {",
		"\tconstant result = compute(seed 1)",
		"",
		"\tfunction compute (seed: Integer) -> Integer {",
		"\t\t<- seed",
		"\t}",
		"",
		"\tconstant scaled = scale(by 2)",
		"",
		"\tfunction scale (by factor: Integer) -> Integer {",
		"\t\t<- factor",
		"\t}",
		"}",
		"",
	].join("\n")

	// The lines a rename rewrote, or the error it was refused with.
	async function renameEach(
		requests: Array<{ at: string; newName: string }>,
	): Promise<Array<{ lines: Array<number> } | { refused: object }>> {
		let files = makeSessionWorkspace({ "Main.es": source })
		let session = startSession()
		let lines = source.split("\n")

		try {
			await session.initialize([files.root])
			await session.open(files.pathOf("Main.es"), source)
			await session.settle()

			let answers: Array<{ lines: Array<number> } | { refused: object }> =
				[]

			for (let { at, newName } of requests) {
				let line = lines.findIndex((text) => text.includes(at))

				try {
					let { result } = await session.request<WorkspaceEdit>(
						RenameRequest.type,
						{
							textDocument: {
								uri: uriOf(files.pathOf("Main.es")),
							},
							position: {
								line,
								character: lines[line]!.indexOf(at),
							},
							newName,
						},
					)

					answers.push({
						lines: Object.values(result.changes ?? {})
							.flat()
							.map((edit) => edit.range.start.line)
							.sort((left, right) => left - right),
					})
				} catch (error) {
					let { code, message } = error as {
						code: number
						message: string
					}

					answers.push({ refused: { code, message } })
				}
			}

			return answers
		} finally {
			await session.dispose()
			files.dispose()
		}
	}

	it("should refuse a prefix Keyword for a Parameter that doubles as its label, as for a label", async () => {
		expect(
			await renameEach([
				{ at: "seed:", newName: "start" },
				{ at: "seed:", newName: "complete" },
				{ at: "by factor", newName: "start" },
			]),
		).toEqual([
			{
				refused: {
					code: ErrorCodes.InvalidParams,
					message: "'start' is not a valid Identifier.",
				},
			},
			{
				refused: {
					code: ErrorCodes.InvalidParams,
					message: "'complete' is not a valid Identifier.",
				},
			},
			{
				refused: {
					code: ErrorCodes.InvalidParams,
					message: "'start' is not a valid Identifier.",
				},
			},
		])
	})

	it("should accept a name valid as both, and a prefix Keyword behind a label of its own", async () => {
		expect(
			await renameEach([
				{ at: "seed:", newName: "amount" },
				{ at: "factor:", newName: "start" },
			]),
		).toEqual([{ lines: [1, 3, 4] }, { lines: [9, 10] }])
	})

	// The conformer is inside the workspace and its requirement is not,
	// so renaming the one would rename the other in a file nothing indexed.
	it("should refuse a Method whose requirement is declared outside the workspace", async () => {
		let bag = [
			"import {",
			'\tfrom "../lib/Sizable.es" { Sizable }',
			"}",
			"",
			"implementation {",
			"\ttype Bag = { count: Integer }",
			"",
			"\tnamespace Bags for Bag is Sizable {",
			"\t\tsize() -> Integer {",
			"\t\t\t<- @.count",
			"\t\t}",
			"\t}",
			"}",
			"",
		].join("\n")
		let files = makeSessionWorkspace({
			"lib/Sizable.es": [
				"implementation {",
				"\tprotocol Sizable {",
				"\t\tsize() -> Integer",
				"\t}",
				"}",
				"",
				"export {",
				"\tSizable",
				"}",
				"",
			].join("\n"),
			"app/Bag.es": bag,
		})
		let session = startSession()

		try {
			await session.initialize([files.pathOf("app")])
			await session.open(files.pathOf("app/Bag.es"), bag)
			await session.settle()

			let prepare = (line: number, needle: string) =>
				session
					.request(PrepareRenameRequest.type, {
						textDocument: {
							uri: uriOf(files.pathOf("app/Bag.es")),
						},
						position: {
							line,
							character: bag.split("\n")[line]!.indexOf(needle),
						},
					})
					.then(
						() => "accepted",
						(error: { code: number; message: string }) => ({
							code: error.code,
							message: error.message,
						}),
					)

			expect(await prepare(8, "size")).toEqual({
				code: ErrorCodes.InvalidRequest,
				message:
					"'size' is declared outside this workspace, so its other uses can not be found.",
			})
			expect(await prepare(7, "Bags")).toBe("accepted")
		} finally {
			await session.dispose()
			files.dispose()
		}
	})

	// `Boxes` reaches `toString` through a Protocol another Module
	// declares, and `describe` is that Protocol's own. `Equatable` does not
	// declare `toString`.
	it("should refuse a Method that answers a standard library Protocol's member", async () => {
		let showable = [
			"implementation {",
			"\tprotocol Showable is Printable {",
			"\t\tdescribe() -> String",
			"\t}",
			"}",
			"",
			"export {",
			"\tShowable",
			"}",
			"",
		].join("\n")
		let bag = [
			"import {",
			'\tfrom "./Showable.es" { Showable }',
			"}",
			"",
			"implementation {",
			"\ttype Bag = { count: Integer }",
			"",
			"\tnamespace Bags for Bag is Printable {",
			"\t\ttoString() -> String {",
			'\t\t\t<- "bag"',
			"\t\t}",
			"\t}",
			"",
			"\ttype Box = { count: Integer }",
			"",
			"\tnamespace Boxes for Box is Showable {",
			"\t\ttoString() -> String {",
			'\t\t\t<- "box"',
			"\t\t}",
			"",
			"\t\tdescribe() -> String {",
			'\t\t\t<- "a box"',
			"\t\t}",
			"\t}",
			"",
			"\ttype Crate = { count: Integer }",
			"",
			"\tnamespace Crates for Crate is Equatable {",
			"\t\tis(_ other: Crate) -> Boolean {",
			"\t\t\t<- @.count::is(other.count)",
			"\t\t}",
			"",
			"\t\ttoString() -> String {",
			'\t\t\t<- "crate"',
			"\t\t}",
			"\t}",
			"}",
			"",
		].join("\n")
		let files = makeSessionWorkspace({
			"Showable.es": showable,
			"Bag.es": bag,
		})
		let session = startSession()

		try {
			await session.initialize([files.root])
			await session.open(files.pathOf("Bag.es"), bag)
			await session.settle()

			let prepare = (line: number, needle: string) =>
				session
					.request(PrepareRenameRequest.type, {
						textDocument: {
							uri: uriOf(files.pathOf("Bag.es")),
						},
						position: {
							line,
							character: bag.split("\n")[line]!.indexOf(needle),
						},
					})
					.then(
						() => "accepted",
						(error: { code: number; message: string }) => ({
							code: error.code,
							message: error.message,
						}),
					)
			let refused = {
				code: ErrorCodes.InvalidRequest,
				message:
					"'toString' is declared outside this workspace, so its other uses can not be found.",
			}

			expect(await prepare(8, "toString")).toEqual(refused)
			expect(await prepare(16, "toString")).toEqual(refused)
			expect(await prepare(20, "describe")).toBe("accepted")
			expect(await prepare(32, "toString")).toBe("accepted")
		} finally {
			await session.dispose()
			files.dispose()
		}
	})
})

// A standard library source may open with `declarations { … }`, and its
// declarations are already in the builtin tables the loader filled from it.
// Both depend on where the document lives, so the Server is told its path.
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

	// The standard library this compiler loads, not any directory spelled
	// `src/stdlib`, which a user's project may have.
	const stdlibPath = path.join(STDLIB_DIRECTORY, "Boolean.es")

	it("should report no Diagnostics for a document in the standard library", () => {
		expect(analyse(source, stdlibPath)).toEqual([])
	})

	it("should accept a file:// URI as well as a plain path", () => {
		expect(analyse(source, `file://${stdlibPath}`)).toEqual([])
	})

	// The same file through a symlinked checkout, as an Editor may open it. The
	// path is resolved before it is compared, or the standard library could not
	// be edited through the link.
	it("should recognise the standard library through a symlinked checkout", () => {
		let directory = mkdtempSync(path.join(tmpdir(), "essence-symlink-"))
		let checkout = path.join(directory, "essence")

		// The link and the path through it derive from `STDLIB_DIRECTORY`, so
		// the spec tests symlink resolution and not where the sources sit.
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
			// The link is removed first and on its own, so the recursive delete
			// never runs over a link to the checkout.
			rmSync(checkout, { force: true })
			rmSync(directory, { recursive: true, force: true })
		}
	})

	// On a case-insensitive filesystem, macOS' default, `sources` and `SOURCES`
	// are one directory, and on a case-sensitive one they are two. The
	// expectation asks the filesystem which.
	it("should recognise the standard library through a case-variant path", () => {
		let variantPath = path.join(
			path.dirname(STDLIB_DIRECTORY),
			path.basename(STDLIB_DIRECTORY).toUpperCase(),
			"Boolean.es",
		)

		expect(isStdlibDocument(variantPath)).toBe(existsSync(variantPath))
	})

	// A standard library source never saved is still one, and its
	// `declarations` header must be allowed while it is typed. Canonicalising
	// must not require the file to exist.
	it("should recognise a standard library document that is not on disk yet", () => {
		expect(
			isStdlibDocument(path.join(STDLIB_DIRECTORY, "NotWrittenYet.es")),
		).toBe(true)
	})

	// A user's own `src/stdlib/Boolean.es` canonicalises fine and is still not
	// this compiler's standard library. Matching by shape would accept a
	// `declarations { … }` block the Compiler rejects.
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

	// The permission is the standard library's alone. Lifting it everywhere
	// would retire `declarations-outside-stdlib`.
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

	// The loader put this file's `Boolean` into the builtin Scope. Against the
	// untouched tables the document would redeclare itself.
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

	// A rename inside a standard library source is silently destructive. See
	// "No renaming inside the standard library" in
	// packages/language-server/DEVELOPMENT.md.
	it("should refuse to rename anything in a standard library source", () => {
		let { program } = parseDocument(source, stdlibPath)
		let { program: enrichedProgram } = enrichDocument(program, stdlibPath)

		// Every kind the document holds: the Namespace name, a conformance
		// Method, a plain native Method and a Parameter.
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

	// The guard is keyed off the path, so renaming in an ordinary document
	// still works.
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

	// A standard library document declares the Namespaces the builtin table
	// holds, so both match a receiver. Signature Help would list every Overload
	// twice.
	it("should not list the document's own Namespace twice", () => {
		expect(
			matchingNamespaces(source, { type: "Boolean" }, null, stdlibPath)
				.map((namespace) => namespace.name)
				.filter((name) => name === "Boolean"),
		).toEqual(["Boolean"])
	})

	// A body-less native signature has no typed Node. See "What the typed tree
	// lacks" in packages/language-server/DEVELOPMENT.md.
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
		// The Parameter's own name, and the annotations either side of it.
		expect(hoverAt(8, 9)?.content).toBe("other: Boolean")
		expect(hoverAt(8, 16)?.content).toBe("Boolean")
		expect(hoverAt(8, 28)?.content).toBe("Boolean")
		expect(hoverAt(14, 4)?.content).toBe("toString() -> String")
	})

	// The annotation index records each nested Type against its own span, so
	// `Boolean` within `List<Boolean>` answers on its own.
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

	// Every real standard library source, analysed as the editor analyses it,
	// is clean, as the loader requires.
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

// The Workspace holds nothing for a standard library source, so a request
// over one enriches the document itself. A Compiler throw there degrades the
// answer, and the throw has to reach the Server's log.
describe("A Compiler throw while a request enriches a document", () => {
	const source = [
		"implementation {",
		"\tconstant answer = 42",
		"\tconstant doubled = ans",
		"}",
		"",
	].join("\n")
	const stdlibPath = path.join(STDLIB_DIRECTORY, "Boolean.es")

	function loggedErrors(session: LspSession): Array<string> {
		let errors: Array<string> = []

		session.client.onNotification(LogMessageNotification.type, (params) => {
			if (params.type === MessageType.Error) {
				errors.push(params.message)
			}
		})

		return errors
	}

	// Every enrichment through the Server's compilation seam throws while
	// `run` is in flight and only then, so opening and settling the document
	// are untouched.
	async function withEnrichmentThrowing<Result>(
		session: LspSession,
		run: () => Promise<Result>,
	): Promise<{ result: Result; errors: Array<string> }> {
		let errors = loggedErrors(session)
		let enrichment = spyOn(
			compilation,
			"enrichDocument",
		).mockImplementation(() => {
			throw new Error("the enrichment exploded")
		})

		try {
			return { result: await run(), errors }
		} finally {
			enrichment.mockRestore()
		}
	}

	// Only the enrichment of the document's own text throws. The probes
	// written from it enrich as usual, so a request that reads both still
	// types what it probes.
	async function withDocumentEnrichmentThrowing<Result>(
		session: LspSession,
		documentText: string,
		run: () => Promise<Result>,
	): Promise<{ result: Result; errors: Array<string> }> {
		let errors = loggedErrors(session)
		let parse = compilation.parseDocument
		let enrich = compilation.enrichDocument
		let documentPrograms = new Set<unknown>()
		let parsing = spyOn(compilation, "parseDocument").mockImplementation(
			(text, documentPath) => {
				let parsed = parse(text, documentPath)

				if (text === documentText) {
					documentPrograms.add(parsed.program)
				}

				return parsed
			},
		)
		let enrichment = spyOn(
			compilation,
			"enrichDocument",
		).mockImplementation((program, documentPath, options) => {
			if (documentPrograms.has(program)) {
				throw new Error("the enrichment exploded")
			}

			return enrich(program, documentPath, options)
		})

		try {
			return { result: await run(), errors }
		} finally {
			enrichment.mockRestore()
			parsing.mockRestore()
		}
	}

	it("should log the throw and still answer a Hover", async () => {
		let session = startSession()

		try {
			await session.initialize([])
			await session.open(stdlibPath, source)
			await session.settle()

			let { result, errors } = await withEnrichmentThrowing(
				session,
				async () =>
					(
						await session.request<unknown>(HoverRequest.type, {
							textDocument: { uri: uriOf(stdlibPath) },
							position: { line: 1, character: 11 },
						})
					).result,
			)

			expect(result).toBeNull()
			expect(errors).toHaveLength(1)
			expect(errors[0]).toContain(stdlibPath)
			expect(errors[0]).toContain("the enrichment exploded")
			expect(errors[0]).toMatch(/\n\s+at /)
		} finally {
			await session.dispose()
		}
	})

	it("should log the throw and still offer the names in Scope", async () => {
		let session = startSession()

		try {
			await session.initialize([])
			await session.open(stdlibPath, source)
			await session.settle()

			let { result, errors } = await withEnrichmentThrowing(
				session,
				async () =>
					(
						await session.request<Array<{ label: string }>>(
							CompletionRequest.type,
							{
								textDocument: { uri: uriOf(stdlibPath) },
								position: { line: 2, character: 23 },
							},
						)
					).result,
			)

			expect(result.map((item) => item.label)).toContain("answer")
			expect(errors).toHaveLength(1)
			expect(errors[0]).toContain(stdlibPath)
			expect(errors[0]).toContain("the enrichment exploded")
			expect(errors[0]).toMatch(/\n\s+at /)
		} finally {
			await session.dispose()
		}
	})

	// Every probe throws as well, so nothing types `person` and the list
	// is empty. The request answers all the same.
	it("should log the throw and still answer a member completion", async () => {
		let text = [
			"implementation {",
			'\tconstant person = { name = "Ada" }',
			"\tconstant greeting = person.",
			"}",
			"",
		].join("\n")
		let session = startSession()

		try {
			await session.initialize([])
			await session.open(stdlibPath, text)
			await session.settle()

			let { result, errors } = await withEnrichmentThrowing(
				session,
				async () =>
					(
						await session.request<Array<{ label: string }>>(
							CompletionRequest.type,
							{
								textDocument: { uri: uriOf(stdlibPath) },
								position: { line: 2, character: 28 },
							},
						)
					).result,
			)

			expect(result).toEqual([])
			expect(errors).toHaveLength(1)
			expect(errors[0]).toContain(stdlibPath)
			expect(errors[0]).toContain("the enrichment exploded")
		} finally {
			await session.dispose()
		}
	})

	// The call's Arguments match no Overload yet, so Signature Help lists what
	// every Namespace for the receiver offers. That reads the document's own
	// Namespaces and Protocols.
	it("should log the throw once and still answer a Signature Help", async () => {
		let text = [
			"implementation {",
			'\tconstant greeting = "Hello"::append(',
			"}",
			"",
		].join("\n")
		let session = startSession()

		try {
			await session.initialize([])
			await session.open(stdlibPath, text)
			await session.settle()

			let { result, errors } = await withDocumentEnrichmentThrowing(
				session,
				text,
				async () =>
					(
						await session.request<{
							signatures: Array<{ label: string }>
						} | null>(SignatureHelpRequest.type, {
							textDocument: { uri: uriOf(stdlibPath) },
							position: { line: 1, character: 37 },
						})
					).result,
			)

			expect(
				result?.signatures.map((signature) => signature.label),
			).toEqual(["append(_ String) -> String"])
			expect(errors).toHaveLength(1)
			expect(errors[0]).toContain(stdlibPath)
			expect(errors[0]).toContain("the enrichment exploded")
		} finally {
			await session.dispose()
		}
	})

	it("should log the throw once and still offer a receiver's Methods", async () => {
		let text = [
			"implementation {",
			'\tconstant greeting = "Hello"::',
			"}",
			"",
		].join("\n")
		let session = startSession()

		try {
			await session.initialize([])
			await session.open(stdlibPath, text)
			await session.settle()

			let { result, errors } = await withDocumentEnrichmentThrowing(
				session,
				text,
				async () =>
					(
						await session.request<Array<{ label: string }>>(
							CompletionRequest.type,
							{
								textDocument: { uri: uriOf(stdlibPath) },
								position: { line: 1, character: 30 },
							},
						)
					).result,
			)

			expect(result.map((item) => item.label)).toContain("append")
			expect(errors).toHaveLength(1)
			expect(errors[0]).toContain(stdlibPath)
			expect(errors[0]).toContain("the enrichment exploded")
		} finally {
			await session.dispose()
		}
	})
})
