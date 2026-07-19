import {
	createConnection,
	ProposedFeatures,
	TextDocumentSyncKind,
	TextDocuments,
} from "vscode-languageserver/node"
import { TextDocument } from "vscode-languageserver-textdocument"

import { analyse } from "./analyse"
import { toLspDiagnostic } from "./conversion"

const analysisDebounceInMilliseconds = 200

export function startServer() {
	let connection = createConnection(ProposedFeatures.all)
	let documents = new TextDocuments(TextDocument)
	let pendingAnalyses = new Map<string, ReturnType<typeof setTimeout>>()

	connection.onInitialize(() => {
		return {
			capabilities: {
				textDocumentSync: TextDocumentSyncKind.Full,
			},
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
