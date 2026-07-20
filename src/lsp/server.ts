import {
	type CompletionItem,
	CompletionItemKind,
	createConnection,
	DocumentHighlightKind,
	type DocumentSymbol,
	ErrorCodes,
	type Position,
	ProposedFeatures,
	ResponseError,
	SymbolKind,
	TextDocumentSyncKind,
	TextDocuments,
} from "vscode-languageserver/node"
import { TextDocument } from "vscode-languageserver-textdocument"

import { enrich } from "../enricher"
import type { common } from "../interfaces"
import { parseWithDiagnostics } from "../parser"
import { analyse } from "./analyse"
import { type CompletionEntry, findCompletions } from "./completion"
import { toCursor, toLspDiagnostic, toLspRange } from "./conversion"
import {
	type DocumentSymbolEntry,
	findDocumentSymbols,
} from "./documentSymbols"
import { findHover } from "./hover"
import { isSamePosition } from "./positions"
import {
	type DeclarationKind,
	findDefinition,
	findOccurrence,
	findOccurrences,
	findRenameableOccurrence,
	isValidIdentifierName,
} from "./rename"

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

		return {
			range: toLspRange(hover.position),
			contents: {
				kind: "markdown" as const,
				value: `\`\`\`essence\n${hover.content}\n\`\`\``,
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

	connection.onDocumentSymbol((params) => {
		let document = documents.get(params.textDocument.uri)

		if (document === undefined) {
			return null
		}

		let { program } = parseWithDiagnostics(document.getText())

		return findDocumentSymbols(program).map(toLspDocumentSymbol)
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

const symbolKinds: Record<DocumentSymbolEntry["kind"], SymbolKind> = {
	constant: SymbolKind.Constant,
	variable: SymbolKind.Variable,
	function: SymbolKind.Function,
	namespace: SymbolKind.Namespace,
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
	type: CompletionItemKind.Interface,
	generic: CompletionItemKind.TypeParameter,
	method: CompletionItemKind.Method,
	staticMethod: CompletionItemKind.Method,
	property: CompletionItemKind.Property,
	member: CompletionItemKind.Field,
	label: CompletionItemKind.Text,
}

function toLspCompletionItem(entry: CompletionEntry): CompletionItem {
	return {
		label: entry.label,
		kind: completionItemKinds[entry.kind],
		detail: entry.detail ?? undefined,
	}
}
