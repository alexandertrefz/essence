import { TextDocument } from "vscode-languageserver-textdocument"
import {
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
	ResponseError,
	type SelectionRange,
	SymbolKind,
	TextDocumentSyncKind,
	TextDocuments,
} from "vscode-languageserver/node"

import { enrich } from "../enricher/index"
import type { common } from "../interfaces/index"
import { parseWithDiagnostics } from "../parser/index"
import { analyse } from "./analyse"
import { type CompletionEntry, findCompletions } from "./completion"
import { toCursor, toLspDiagnostic, toLspRange } from "./conversion"
import {
	type DocumentSymbolEntry,
	findDocumentSymbols,
} from "./documentSymbols"
import { findFoldingRanges } from "./foldingRanges"
import { findHover } from "./hover"
import { findInlayHints } from "./inlayHints"
import { isSamePosition } from "./positions"
import {
	type DeclarationKind,
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

export function startServer() {
	let connection = createConnection(ProposedFeatures.all)
	let documents = new TextDocuments(TextDocument)
	let pendingAnalyses = new Map<string, ReturnType<typeof setTimeout>>()

	connection.onInitialize(() => {
		return {
			capabilities: {
				textDocumentSync: TextDocumentSyncKind.Full,
				renameProvider: {
					prepareProvider: true,
				},
				definitionProvider: true,
				hoverProvider: true,
				referencesProvider: true,
				documentHighlightProvider: true,
				documentSymbolProvider: true,
				completionProvider: {
					triggerCharacters: [".", ":", "<"],
				},
				signatureHelpProvider: {
					triggerCharacters: ["(", ","],
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
			},
		}
	})

	// NOTE: Requests are resolved on a fresh parse of the current document
	// state — the AST is not kept around between requests, parsing is far
	// cheaper than a rename is rare. Enrichment provides the Types that
	// bind Method and Record member references; a compiler bug in it must
	// never take down the Language Server, so those features degrade to the
	// purely lexical index instead.
	function parseAndEnrich(uri: string) {
		let document = documents.get(uri)

		if (document === undefined) {
			return null
		}

		let { program } = parseWithDiagnostics(document.getText())
		let enrichedProgram: common.typed.Program | null = null

		try {
			enrichedProgram = enrich(program).program
		} catch {}

		return { program, enrichedProgram }
	}

	function renameableOccurrenceAt(uri: string, position: Position) {
		let parsed = parseAndEnrich(uri)

		if (parsed === null) {
			return null
		}

		return findRenameableOccurrence(
			parsed.program,
			toCursor(position),
			parsed.enrichedProgram,
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
		let parsed = parseAndEnrich(params.textDocument.uri)

		if (parsed?.enrichedProgram == null) {
			return null
		}

		let hover = findHover(parsed.enrichedProgram, toCursor(params.position))

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

	connection.onDocumentSymbol((params) => {
		let document = documents.get(params.textDocument.uri)

		if (document === undefined) {
			return null
		}

		let { program } = parseWithDiagnostics(document.getText())

		return findDocumentSymbols(program).map(toLspDocumentSymbol)
	})

	connection.onFoldingRanges((params) => {
		let document = documents.get(params.textDocument.uri)

		if (document === undefined) {
			return null
		}

		let { program } = parseWithDiagnostics(document.getText())

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

		let { program } = parseWithDiagnostics(document.getText())

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
		}).map((hint) => ({
			position: {
				line: hint.position.line - 1,
				character: hint.position.column - 1,
			},
			label: hint.label,
			kind: InlayHintKind.Type,
		}))
	})

	connection.onCompletion((params) => {
		let document = documents.get(params.textDocument.uri)

		if (document === undefined) {
			return null
		}

		let entries = findCompletions(
			document.getText(),
			toCursor(params.position),
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
					diagnostics: analyse(document.getText()).map(
						toLspDiagnostic,
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
	member: SymbolKind.Field,
	method: SymbolKind.Method,
	staticMethod: SymbolKind.Method,
	property: SymbolKind.Property,
}

function toLspDocumentSymbol(entry: DocumentSymbolEntry): DocumentSymbol {
	return {
		name: entry.name,
		kind: symbolKinds[entry.kind],
		range: toLspRange(entry.range),
		selectionRange: toLspRange(entry.selectionRange),
		children: entry.children.map(toLspDocumentSymbol),
	}
}

const completionItemKinds: Record<DeclarationKind, CompletionItemKind> = {
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
}

// NOTE: The kinds that are invoked rather than referred to — completing one
// inserts its parentheses and leaves the cursor between them.
const callableKinds = new Set<DeclarationKind>([
	"function",
	"method",
	"staticMethod",
])

function toLspCompletionItem(entry: CompletionEntry): CompletionItem {
	if (!callableKinds.has(entry.kind)) {
		return {
			label: entry.label,
			kind: completionItemKinds[entry.kind],
			detail: entry.detail ?? undefined,
			documentation: toMarkdown(entry.documentation ?? null),
		}
	}

	return {
		label: entry.label,
		kind: completionItemKinds[entry.kind],
		detail: entry.detail ?? undefined,
		documentation: toMarkdown(entry.documentation ?? null),
		insertText: `${entry.label}($0)`,
		insertTextFormat: InsertTextFormat.Snippet,
	}
}
