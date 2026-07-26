import { enrichDocument, parseDocument } from "@essence/compiler/documents"
import { loadStdlib } from "@essence/compiler/enricher/stdlib"
import type { common } from "@essence/interfaces"
import { TextDocument } from "vscode-languageserver-textdocument"
import {
	type CallHierarchyItem as LspCallHierarchyItem,
	type CodeAction,
	CodeActionKind,
	type CodeActionParams,
	type CompletionItem,
	CompletionItemKind,
	createConnection,
	DocumentHighlightKind,
	type DocumentSymbol,
	ErrorCodes,
	InlayHintKind,
	InsertTextFormat,
	type MarkupContent,
	type Position,
	ProposedFeatures,
	type Range,
	ResponseError,
	type SelectionRange,
	type ServerCapabilities,
	SymbolKind,
	TextDocumentSyncKind,
	TextDocuments,
} from "vscode-languageserver/node"

import { analyse } from "./analyse"
import {
	type CallHierarchyItem,
	type CallHierarchyItemKind,
	findIncomingCalls,
	findOutgoingCalls,
	prepareCallHierarchy,
} from "./callHierarchy"
import { escapeSnippet } from "./callSnippets"
import { type CodeActionEntry, findCodeActions } from "./codeActions"
import {
	type CompletionEntry,
	type CompletionKind,
	findCompletions,
} from "./completion"
import { toCursor, toLspDiagnostic, toLspRange, toRange } from "./conversion"
import {
	type DocumentSymbolEntry,
	findDocumentSymbols,
} from "./documentSymbols"
import { findFoldingRanges } from "./foldingRanges"
import { findFormattingEdits } from "./formatting"
import { findHover } from "./hover"
import { findInlayHints } from "./inlayHints"
import { isSamePosition } from "./positions"
import {
	findDefinition,
	findOccurrence,
	findOccurrences,
	findRenameableOccurrence,
	identifierPattern,
	isValidIdentifierName,
} from "./rename"
import { findSelectionRanges } from "./selectionRanges"
import {
	encodeSemanticTokens,
	findSemanticTokens,
	semanticTokenModifiers,
	semanticTokenTypes,
} from "./semanticTokens"
import { findSignatureHelp } from "./signatureHelp"

const analysisDebounceInMilliseconds = 200

// NOTE: Module level rather than written into the `onInitialize` result, so
// that the answer to "what does this Server advertise" is a value a test can
// read. A capability that silently stops being announced disables its feature
// in every Editor while every handler behind it keeps passing its own spec.
export const serverCapabilities: ServerCapabilities = {
	textDocumentSync: TextDocumentSyncKind.Full,
	renameProvider: {
		prepareProvider: true,
	},
	definitionProvider: true,
	hoverProvider: true,
	referencesProvider: true,
	documentHighlightProvider: true,
	documentSymbolProvider: true,
	documentFormattingProvider: true,
	// NOTE: No `resolveProvider` — every action carries its edits already,
	// computed on the buffer as it is now. Deliberately no `source.fixAll`
	// either: not one of these fixes is both unambiguous and
	// semantics-preserving, so applying them in bulk is exactly what a reader
	// must not be able to ask for. The reasoning is written out under
	// "Why there is no fix-all" in the Diagnostics reference.
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
		// NOTE: Closing a nested call puts the cursor back inside the outer
		// one, which is a different signature than the one on screen.
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
}

export function startServer() {
	let connection = createConnection(ProposedFeatures.all)
	let documents = new TextDocuments(TextDocument)
	let pendingAnalyses = new Map<string, ReturnType<typeof setTimeout>>()

	// NOTE: The standard library is read, hoisted, enriched and validated once
	// per process. Doing it here — while the client is still setting up —
	// means the first Hover does not pay for it, and a Diagnostic in the
	// library itself surfaces at startup rather than on a keystroke.
	connection.onInitialize(() => {
		loadStdlib()

		return { capabilities: serverCapabilities }
	})

	// NOTE: Requests are resolved on a fresh parse of the current document
	// state — the AST is not kept around between requests, parsing is far
	// cheaper than a rename is rare. Enrichment provides the Types that
	// bind Method and Record member references; a compiler bug in it must
	// never take down the Language Server, so those features degrade to the
	// purely lexical index instead.
	function parseAndEnrich(
		uri: string,
		options: { annotations?: boolean } = {},
	) {
		let document = documents.get(uri)

		if (document === undefined) {
			return null
		}

		let { program } = parseDocument(document.getText(), uri)
		let enrichedProgram: common.typed.Program | null = null
		// NOTE: Only Hover asks for these. Every other request enriches without
		// a collector and pays nothing for it.
		let annotations: Array<common.TypeAnnotation> = []

		try {
			let enriched = enrichDocument(program, uri, options)

			enrichedProgram = enriched.program
			annotations = enriched.annotations
		} catch {}

		return { program, enrichedProgram, annotations }
	}

	// NOTE: The `uri` is what lets `findRenameableOccurrence` refuse inside a
	// standard library source — see the NOTE on it, which is where the reason
	// lives.
	function renameableOccurrenceAt(uri: string, position: Position) {
		let parsed = parseAndEnrich(uri)

		if (parsed === null) {
			return null
		}

		return findRenameableOccurrence(
			parsed.program,
			toCursor(position),
			parsed.enrichedProgram,
			uri,
		)
	}

	function occurrenceAt(uri: string, position: Position) {
		let parsed = parseAndEnrich(uri)

		if (parsed === null) {
			return null
		}

		return findOccurrence(
			parsed.program,
			toCursor(position),
			parsed.enrichedProgram,
		)
	}

	connection.onPrepareRename((params) => {
		let occurrence = renameableOccurrenceAt(
			params.textDocument.uri,
			params.position,
		)

		if (occurrence === null) {
			return null
		}

		return {
			range: toLspRange(occurrence.position),
			placeholder: occurrence.name,
		}
	})

	connection.onRenameRequest((params) => {
		if (!isValidIdentifierName(params.newName)) {
			return new ResponseError(
				ErrorCodes.InvalidParams,
				`'${params.newName}' is not a valid Identifier.`,
			)
		}

		let occurrence = renameableOccurrenceAt(
			params.textDocument.uri,
			params.position,
		)

		if (occurrence === null) {
			return null
		}

		return {
			changes: {
				[params.textDocument.uri]:
					occurrence.declaration.occurrences.map((position) => {
						return {
							range: toLspRange(position),
							newText: params.newName,
						}
					}),
			},
		}
	})

	connection.onDefinition((params) => {
		let parsed = parseAndEnrich(params.textDocument.uri)

		if (parsed === null) {
			return null
		}

		let definition = findDefinition(
			parsed.program,
			toCursor(params.position),
			parsed.enrichedProgram,
		)

		if (definition === null) {
			return null
		}

		return {
			uri: params.textDocument.uri,
			range: toLspRange(definition),
		}
	})

	connection.onHover((params) => {
		let parsed = parseAndEnrich(params.textDocument.uri, {
			annotations: true,
		})

		if (parsed?.enrichedProgram == null) {
			return null
		}

		let hover = findHover(
			parsed.enrichedProgram,
			toCursor(params.position),
			parsed.program,
			parsed.annotations,
		)

		if (hover === null) {
			return null
		}

		// NOTE: The signature goes in a code fence so the Editor highlights
		// it; the Documentation below the rule is Markdown as written.
		let signature = `\`\`\`essence\n${hover.content}\n\`\`\``

		return {
			range: toLspRange(hover.position),
			contents: {
				kind: "markdown" as const,
				value:
					hover.documentation === null
						? signature
						: `${signature}\n\n---\n\n${hover.documentation}`,
			},
		}
	})

	connection.onReferences((params) => {
		let occurrence = occurrenceAt(params.textDocument.uri, params.position)

		if (occurrence === null) {
			return null
		}

		let definition = occurrence.declaration.definition

		return occurrence.declaration.occurrences
			.filter(
				(position) =>
					params.context.includeDeclaration ||
					definition === null ||
					!isSamePosition(position, definition),
			)
			.map((position) => {
				return {
					uri: params.textDocument.uri,
					range: toLspRange(position),
				}
			})
	})

	connection.onDocumentHighlight((params) => {
		let parsed = parseAndEnrich(params.textDocument.uri)

		if (parsed === null) {
			return null
		}

		// NOTE: Highlighting is the one feature that cares whether an
		// occurrence binds the name or reads it, so it goes back to the index
		// entries rather than the Declaration's flat Position list.
		let occurrences = findOccurrences(
			parsed.program,
			toCursor(params.position),
			parsed.enrichedProgram,
		)

		if (occurrences.length === 0) {
			return null
		}

		return occurrences.map((entry) => {
			return {
				range: toLspRange(entry.position),
				kind:
					entry.access === "write"
						? DocumentHighlightKind.Write
						: DocumentHighlightKind.Read,
			}
		})
	})

	connection.languages.semanticTokens.on((params) => {
		let parsed = parseAndEnrich(params.textDocument.uri)

		if (parsed === null) {
			return { data: [] }
		}

		return {
			data: encodeSemanticTokens(
				findSemanticTokens(parsed.program, parsed.enrichedProgram),
			),
		}
	})

	connection.languages.onLinkedEditingRange((params) => {
		// NOTE: Editing one occurrence updates the rest as they are typed, so
		// this is deliberately restricted to what renaming would accept —
		// Builtins are excluded, since typing over `__print` must not look
		// like it is renaming it.
		let occurrence = renameableOccurrenceAt(
			params.textDocument.uri,
			params.position,
		)

		if (occurrence === null) {
			return null
		}

		return {
			ranges: occurrence.declaration.occurrences.map(toLspRange),
			// NOTE: Typing a character an Identifier cannot contain ends the
			// linked edit instead of propagating something unparseable.
			wordPattern: identifierPattern,
		}
	})

	connection.languages.callHierarchy.onPrepare((params) => {
		let parsed = parseAndEnrich(params.textDocument.uri)

		if (parsed === null) {
			return null
		}

		let item = prepareCallHierarchy(
			parsed.program,
			toCursor(params.position),
			parsed.enrichedProgram,
		)

		if (item === null) {
			return null
		}

		return [toLspCallHierarchyItem(item, params.textDocument.uri)]
	})

	// NOTE: An Item round-trips its uri and its selectionRange, so the
	// Declaration it names is resolved again from a fresh parse — nothing is
	// kept between the prepare and the expansion that follows it.
	connection.languages.callHierarchy.onIncomingCalls((params) => {
		let parsed = parseAndEnrich(params.item.uri)

		if (parsed === null) {
			return null
		}

		return findIncomingCalls(
			parsed.program,
			toCursor(params.item.selectionRange.start),
			parsed.enrichedProgram,
		).map((entry) => ({
			from: toLspCallHierarchyItem(entry.item, params.item.uri),
			fromRanges: entry.ranges.map(toLspRange),
		}))
	})

	connection.languages.callHierarchy.onOutgoingCalls((params) => {
		let parsed = parseAndEnrich(params.item.uri)

		if (parsed === null) {
			return null
		}

		return findOutgoingCalls(
			parsed.program,
			toCursor(params.item.selectionRange.start),
			parsed.enrichedProgram,
		).map((entry) => ({
			to: toLspCallHierarchyItem(entry.item, params.item.uri),
			fromRanges: entry.ranges.map(toLspRange),
		}))
	})

	// NOTE: The outline enriches so that entries can carry their Types, and
	// degrades to the Parser's answer alone when enrichment throws — the whole
	// point of building it off the Parser AST is that it survives a Program
	// that does not type check.
	connection.onDocumentSymbol((params) => {
		let parsed = parseAndEnrich(params.textDocument.uri)

		if (parsed === null) {
			return null
		}

		return findDocumentSymbols(parsed.program, parsed.enrichedProgram).map(
			toLspDocumentSymbol,
		)
	})

	connection.onDocumentFormatting((params) => {
		let document = documents.get(params.textDocument.uri)

		if (document === undefined) {
			return null
		}

		return findFormattingEdits(document.getText(), params.textDocument.uri)
	})

	connection.onCodeAction((params) => {
		let document = documents.get(params.textDocument.uri)

		if (document === undefined) {
			return null
		}

		return findCodeActions(
			document.getText(),
			toRange(params.range),
			params.textDocument.uri,
		).map((entry) => toLspCodeAction(entry, params))
	})

	connection.onFoldingRanges((params) => {
		let document = documents.get(params.textDocument.uri)

		if (document === undefined) {
			return null
		}

		let { program } = parseDocument(
			document.getText(),
			params.textDocument.uri,
		)

		return findFoldingRanges(program).map((range) => ({
			startLine: range.startLine - 1,
			endLine: range.endLine - 1,
		}))
	})

	connection.onSelectionRanges((params) => {
		let document = documents.get(params.textDocument.uri)

		if (document === undefined) {
			return null
		}

		let { program } = parseDocument(
			document.getText(),
			params.textDocument.uri,
		)

		return params.positions.map((position) => {
			let chain = findSelectionRanges(program, toCursor(position))

			// NOTE: The protocol nests the chain outwards through `parent`.
			let range: SelectionRange | undefined

			for (let selection of chain) {
				range = { range: toLspRange(selection), parent: range }
			}

			return range ?? { range: { start: position, end: position } }
		})
	})

	connection.languages.inlayHint.on((params) => {
		let parsed = parseAndEnrich(params.textDocument.uri)

		if (parsed?.enrichedProgram == null) {
			return null
		}

		return findInlayHints(parsed.enrichedProgram, {
			start: toCursor(params.range.start),
			end: toCursor(params.range.end),
		}).map((hint) => {
			// NOTE: Accepting a Hint writes its own label at its own position,
			// which the protocol asks for as an edit — and an insertion is an
			// empty Range there rather than a Position of its own.
			let insertion = {
				line: hint.textEdit.position.line - 1,
				character: hint.textEdit.position.column - 1,
			}

			return {
				position: {
					line: hint.position.line - 1,
					character: hint.position.column - 1,
				},
				label: hint.label,
				kind: InlayHintKind.Type,
				textEdits: [
					{
						range: { start: insertion, end: insertion },
						newText: hint.textEdit.newText,
					},
				],
			}
		})
	})

	connection.onCompletion((params) => {
		let document = documents.get(params.textDocument.uri)

		if (document === undefined) {
			return null
		}

		let entries = findCompletions(
			document.getText(),
			toCursor(params.position),
			params.textDocument.uri,
		)

		return entries.map(toLspCompletionItem)
	})

	connection.onSignatureHelp((params) => {
		let document = documents.get(params.textDocument.uri)

		if (document === undefined) {
			return null
		}

		let help = findSignatureHelp(
			document.getText(),
			toCursor(params.position),
			params.textDocument.uri,
		)

		if (help === null) {
			return null
		}

		// NOTE: Parameters are handed over as offset ranges into the label
		// rather than as text — the protocol resolves a text label by
		// searching the signature for it, which always finds the first of two
		// identically printed Parameters.
		return {
			signatures: help.signatures.map((signature) => ({
				label: signature.label,
				documentation: toMarkdown(signature.documentation),
				parameters: signature.parameters.map((parameter) => ({
					label: parameter.range,
					documentation: toMarkdown(parameter.documentation),
				})),
			})),
			activeSignature: help.activeSignature,
			activeParameter: help.activeParameter,
		}
	})

	function scheduleAnalysis(uri: string) {
		let pendingTimer = pendingAnalyses.get(uri)

		if (pendingTimer !== undefined) {
			clearTimeout(pendingTimer)
		}

		pendingAnalyses.set(
			uri,
			setTimeout(() => {
				pendingAnalyses.delete(uri)

				let document = documents.get(uri)

				if (document === undefined) {
					return
				}

				// NOTE: The Diagnostics collector is module-level state, so
				// documents are analysed strictly one at a time — `analyse`
				// is synchronous, which guarantees that here.
				connection.sendDiagnostics({
					uri,
					diagnostics: analyse(document.getText(), uri).map(
						(diagnostic) => toLspDiagnostic(diagnostic, uri),
					),
				})
			}, analysisDebounceInMilliseconds),
		)
	}

	// NOTE: `onDidChangeContent` also fires when a document is opened.
	documents.onDidChangeContent((event) => {
		scheduleAnalysis(event.document.uri)
	})

	documents.onDidClose((event) => {
		let pendingTimer = pendingAnalyses.get(event.document.uri)

		if (pendingTimer !== undefined) {
			clearTimeout(pendingTimer)
			pendingAnalyses.delete(event.document.uri)
		}

		connection.sendDiagnostics({
			uri: event.document.uri,
			diagnostics: [],
		})
	})

	documents.listen(connection)
	connection.listen()
}

function toMarkdown(documentation: string | null): MarkupContent | undefined {
	if (documentation === null) {
		return undefined
	}

	return { kind: "markdown", value: documentation }
}

const symbolKinds: Record<DocumentSymbolEntry["kind"], SymbolKind> = {
	constant: SymbolKind.Constant,
	variable: SymbolKind.Variable,
	function: SymbolKind.Function,
	namespace: SymbolKind.Namespace,
	protocol: SymbolKind.Interface,
	typeAlias: SymbolKind.Interface,
	choice: SymbolKind.Enum,
	case: SymbolKind.EnumMember,
	member: SymbolKind.Field,
	method: SymbolKind.Method,
	staticMethod: SymbolKind.Method,
	property: SymbolKind.Property,
}

function toLspDocumentSymbol(entry: DocumentSymbolEntry): DocumentSymbol {
	return {
		name: entry.name,
		kind: symbolKinds[entry.kind],
		detail: entry.detail ?? undefined,
		range: toLspRange(entry.range),
		selectionRange: toLspRange(entry.selectionRange),
		children: entry.children.map(toLspDocumentSymbol),
	}
}

const callHierarchyKinds: Record<CallHierarchyItemKind, SymbolKind> = {
	function: SymbolKind.Function,
	method: SymbolKind.Method,
	staticMethod: SymbolKind.Method,
	property: SymbolKind.Property,
	implementation: SymbolKind.Module,
}

function toLspCallHierarchyItem(
	item: CallHierarchyItem,
	uri: string,
): LspCallHierarchyItem {
	return {
		name: item.name,
		kind: callHierarchyKinds[item.kind],
		detail: item.container ?? undefined,
		uri,
		range: toLspRange(item.range),
		selectionRange: toLspRange(item.selectionRange),
	}
}

// NOTE: The edits were computed on the current buffer, so the client's own
// Diagnostics are used for nothing but attribution — matched by code and
// overlapping range so the Editor can tie the fix to the squiggle it is
// offered on, and retire it once applied.
export function toLspCodeAction(
	entry: CodeActionEntry,
	params: CodeActionParams,
): CodeAction {
	let position = entry.diagnosticPosition

	return {
		title: entry.title,
		kind:
			entry.kind === "quickfix"
				? CodeActionKind.QuickFix
				: CodeActionKind.RefactorRewrite,
		isPreferred: entry.isPreferred,
		diagnostics:
			position === null
				? undefined
				: params.context.diagnostics.filter(
						(diagnostic) =>
							diagnostic.code === entry.diagnosticCode &&
							rangesOverlap(
								diagnostic.range,
								toLspRange(position),
							),
					),
		edit: {
			changes: {
				[params.textDocument.uri]: entry.edits.map((edit) => ({
					range: toLspRange(edit.range),
					newText: edit.newText,
				})),
			},
		},
	}
}

function rangesOverlap(a: Range, b: Range): boolean {
	return (
		!isBeforePosition(a.end, b.start) && !isBeforePosition(b.end, a.start)
	)
}

function isBeforePosition(a: Position, b: Position): boolean {
	return a.line < b.line || (a.line === b.line && a.character < b.character)
}

const completionItemKinds: Record<CompletionKind, CompletionItemKind> = {
	constant: CompletionItemKind.Constant,
	variable: CompletionItemKind.Variable,
	function: CompletionItemKind.Function,
	parameter: CompletionItemKind.Variable,
	namespace: CompletionItemKind.Module,
	protocol: CompletionItemKind.Interface,
	type: CompletionItemKind.Interface,
	generic: CompletionItemKind.TypeParameter,
	method: CompletionItemKind.Method,
	staticMethod: CompletionItemKind.Method,
	property: CompletionItemKind.Property,
	member: CompletionItemKind.Field,
	label: CompletionItemKind.Text,
	case: CompletionItemKind.EnumMember,
	keyword: CompletionItemKind.Keyword,
}

// NOTE: The kinds that are invoked rather than referred to. This is only the
// fallback now — an entry whose signature resolved carries the call written
// out, labels and all, and this inserts the bare parentheses for the ones
// halfway through a keystroke where nothing resolved yet.
const callableKinds = new Set<CompletionKind>([
	"function",
	"method",
	"staticMethod",
])

export function toLspCompletionItem(entry: CompletionEntry): CompletionItem {
	let callable = entry.snippet != null
	let fallback = !callable && callableKinds.has(entry.kind)

	return {
		label: entry.label,
		kind: completionItemKinds[entry.kind],
		detail: entry.detail ?? undefined,
		documentation: toMarkdown(entry.documentation ?? null),
		// NOTE: Overloads deliberately share a label, so the Editor is told to
		// filter every one of them on it; `labelDetails` is what tells them
		// apart in the list.
		labelDetails:
			entry.labelDetail == null
				? undefined
				: { detail: ` ${entry.labelDetail}` },
		filterText: entry.label,
		sortText: `${entry.tier}${entry.label}`,
		preselect: entry.preselect === true ? true : undefined,
		// NOTE: The fallback is snippet-formatted too, so the label goes
		// through the same escape the resolved snippet is built with — `$` is
		// an ordinary Identifier character, and an unescaped one in `we$rd`
		// reads as the snippet variable `$rd` and writes the wrong name.
		insertText: callable
			? (entry.snippet ?? undefined)
			: fallback
				? `${escapeSnippet(entry.label)}($0)`
				: undefined,
		insertTextFormat:
			callable || fallback ? InsertTextFormat.Snippet : undefined,
	}
}
