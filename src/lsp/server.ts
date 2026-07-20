import {
	createConnection,
	ErrorCodes,
	type Position,
	ProposedFeatures,
	ResponseError,
	TextDocumentSyncKind,
	TextDocuments,
} from "vscode-languageserver/node"
import { TextDocument } from "vscode-languageserver-textdocument"

import { enrich } from "../enricher"
import type { common } from "../interfaces"
import { parseWithDiagnostics } from "../parser"
import { analyse } from "./analyse"
import { toCursor, toLspDiagnostic, toLspRange } from "./conversion"
import {
	findDefinition,
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
