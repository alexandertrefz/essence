import {
	enrichDocument,
	isStdlibDocument,
	parseDocument,
} from "@essence/compiler/documents"
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
	DidChangeWatchedFilesNotification,
	DocumentHighlightKind,
	type DocumentSymbol,
	ErrorCodes,
	FileChangeType,
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
	type TextEdit,
	TextDocumentSyncKind,
	TextDocuments,
	type WorkspaceSymbol as LspWorkspaceSymbol,
} from "vscode-languageserver/node"

import { analyseDocument, documentFilePath } from "./analyse"
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
import {
	createWorkspace,
	type WorkspaceOccurrence,
	type WorkspaceSymbolEntry,
} from "./workspace"

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
		// NOTE: Announced although every entry is complete when it is handed
		// over: a client that knows the Server resolves may send back an item it
		// trimmed for the wire, and the round trip is what returns it intact.
		resolveProvider: true,
	},
	// NOTE: Answered from the workspace index, which is why this could not be
	// announced before Modules — a symbol worth finding across files is a symbol
	// files can share, and until an entry could carry one, none could.
	workspaceSymbolProvider: true,
	workspace: {
		workspaceFolders: {
			supported: true,
			changeNotifications: true,
		},
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

// NOTE: vscode-languageserver reads the transport off process.argv and throws
// if it finds none. Editors always pass one, but a person starting the Server
// by hand — or `essence lsp` — passes nothing, and stdio is the transport this
// Server documents itself as speaking, so name it instead of failing. A
// transport the client did ask for still wins: createConnection stops at the
// first one it recognises, and this is appended behind it.
const transportArguments = ["--node-ipc", "--stdio", "--socket", "--pipe"]

export function ensureTransportArgument() {
	let isTransport = (argument: string) =>
		transportArguments.includes(argument.split("=")[0]!)

	if (!process.argv.slice(2).some(isTransport)) {
		process.argv.push("--stdio")
	}
}

export function startServer() {
	ensureTransportArgument()

	let connection = createConnection(ProposedFeatures.all)
	let documents = new TextDocuments(TextDocument)
	let pendingAnalyses = new Map<string, ReturnType<typeof setTimeout>>()
	// NOTE: An open document by its canonical path, which is what the workspace
	// and the Module graph both key on. Maintained alongside `documents` rather
	// than searched for on every read: the graph asks for a file once per Module
	// per analysis, and an Editor's unsaved buffer must win every one of them.
	let openPaths = new Map<string, string>()
	let workspace = createWorkspace({
		openDocument: (filePath) => {
			let uri = openPaths.get(filePath)
			let document = uri === undefined ? undefined : documents.get(uri)

			return document === undefined
				? undefined
				: { text: document.getText(), version: document.version }
		},
	})
	// NOTE: Which URIs this Server has published Diagnostics to, by the document
	// whose analysis produced them. Publishing a dependency's Diagnostics means
	// owning them: nothing else will clear a squiggle in a file nobody has open,
	// so a URI that drops out of an analysis is sent an explicitly empty set —
	// unless another open document still reports on it.
	let publishedByEntry = new Map<string, Set<string>>()

	// NOTE: The standard library is read, hoisted, enriched and validated once
	// per process. Doing it here — while the client is still setting up —
	// means the first Hover does not pay for it, and a Diagnostic in the
	// library itself surfaces at startup rather than on a keystroke.
	// NOTE: The folders come from the client and from nowhere else. This Server
	// ships as a single bundled file inside the VS Code extension, so a path
	// relative to its own location names somewhere inside the extension rather
	// than anywhere in the workspace.
	connection.onInitialize((params) => {
		loadStdlib()
		workspace.setFolders(
			params.workspaceFolders?.map((folder) =>
				documentFilePath(folder.uri),
			) ??
				(params.rootUri === null || params.rootUri === undefined
					? []
					: [documentFilePath(params.rootUri)]),
		)

		return { capabilities: serverCapabilities }
	})

	connection.onInitialized(() => {
		// NOTE: A file changing on disk is the half of the workspace the
		// document events can not see — a branch switch, a file another tool
		// wrote, a Module deleted. Registered dynamically because the glob is
		// the Server's business rather than the extension manifest's.
		connection.client
			.register(DidChangeWatchedFilesNotification.type, {
				watchers: [{ globPattern: "**/*.es" }],
			})
			.catch(() => {})

		connection.workspace.onDidChangeWorkspaceFolders((event) => {
			let folders = new Set(workspace.folders())

			for (let removed of event.removed) {
				folders.delete(documentFilePath(removed.uri))
			}

			for (let added of event.added) {
				folders.add(documentFilePath(added.uri))
			}

			workspace.setFolders([...folders])
		})
	})

	connection.onDidChangeWatchedFiles((params) => {
		for (let change of params.changes) {
			let filePath = documentFilePath(change.uri)

			if (change.type === FileChangeType.Deleted) {
				workspace.removed(filePath)
			} else {
				workspace.changed(filePath)
			}
		}

		// NOTE: A file changing on disk changes the graph every open document
		// sits in, and an analysis is the only thing that ever publishes: the
		// Diagnostics an importer owns for a dependency nobody has open are
		// cleared by that importer being analysed again, which no keystroke is
		// going to ask for. Every open document, rather than the importers of
		// what changed, because a file that did not exist a moment ago is
		// exactly what an unresolved import was waiting for.
		for (let document of documents.all()) {
			scheduleAnalysis(document.uri)
		}
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

		// NOTE: A Module is enriched against the whole graph it reaches, or
		// every name an entry brought in resolves to nothing and every Method
		// dispatching through an imported Namespace stays unbound. The exception
		// is Hover, which needs the Type annotations collected as enrichment
		// runs, and the graph does not collect them — so a Hover over a written
		// Type inside a Module still reads the file on its own.
		if (
			options.annotations !== true &&
			(program.imports !== null || program.exports !== null)
		) {
			enrichedProgram = workspace.enrichedOf(documentFilePath(uri))
		}

		if (enrichedProgram !== null) {
			return { program, enrichedProgram, annotations }
		}

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

	// NOTE: The workspace's answer where there is one, the document's own where
	// there is not — an untitled buffer, or a file outside every folder, is
	// still one file whose names rename among themselves. The standard library
	// refusal is checked first for the reason it exists in `rename.ts`: a rename
	// there is silently destructive, and the workspace has no idea.
	function workspaceSymbolAt(
		uri: string,
		position: Position,
		options: { localOnly?: boolean } = {},
	) {
		if (isStdlibDocument(uri)) {
			return null
		}

		return workspace.symbolAt(
			documentFilePath(uri),
			toCursor(position),
			options,
		)
	}

	// NOTE: The occurrence a rename would be anchored at, as the workspace sees
	// it — the Identifier under the cursor, which for a Method dispatching
	// through an imported Namespace is in no local Scope at all and is still
	// what the reader is pointing at.
	function renameAnchorAt(uri: string, position: Position) {
		let symbol = workspaceSymbolAt(uri, position)

		if (symbol === null) {
			return null
		}

		let filePath = documentFilePath(uri)
		let cursor = toCursor(position)
		let here = symbol.occurrences.find(
			(entry) =>
				entry.filePath === filePath &&
				entry.position.start.line === cursor.line &&
				entry.position.start.column <= cursor.column &&
				cursor.column <= entry.position.end.column,
		)

		return here === undefined ? null : { symbol, position: here.position }
	}

	connection.onPrepareRename((params) => {
		let anchor = renameAnchorAt(params.textDocument.uri, params.position)
		let occurrence =
			anchor === null
				? renameableOccurrenceAt(
						params.textDocument.uri,
						params.position,
					)
				: null

		if (anchor === null && occurrence === null) {
			return null
		}

		let folders = workspace.folders()

		// NOTE: Refused rather than half-applied. A declaration outside every
		// workspace folder is one whose other occurrences this Server was never
		// asked to index, so renaming it would rewrite the uses it happens to
		// have found and leave the rest naming something that no longer exists.
		if (
			anchor !== null &&
			folders.length > 0 &&
			anchor.symbol.filePath !== null &&
			!workspace.isInWorkspace(anchor.symbol.filePath)
		) {
			return new ResponseError(
				ErrorCodes.InvalidRequest,
				`'${anchor.symbol.name}' is declared outside this workspace, so its other uses can not be found.`,
			)
		}

		return anchor === null
			? {
					range: toLspRange(occurrence!.position),
					placeholder: occurrence!.name,
				}
			: {
					range: toLspRange(anchor.position),
					placeholder: anchor.symbol.name,
				}
	})

	connection.onRenameRequest((params) => {
		if (!isValidIdentifierName(params.newName)) {
			return new ResponseError(
				ErrorCodes.InvalidParams,
				`'${params.newName}' is not a valid Identifier.`,
			)
		}

		let anchor = renameAnchorAt(params.textDocument.uri, params.position)
		let occurrence =
			anchor === null
				? renameableOccurrenceAt(
						params.textDocument.uri,
						params.position,
					)
				: null

		if (anchor === null && occurrence === null) {
			return null
		}

		let occurrences: Array<WorkspaceOccurrence> =
			anchor?.symbol.occurrences ??
			occurrence!.declaration.occurrences.map((position) => ({
				filePath: documentFilePath(params.textDocument.uri),
				position,
				access: "read" as const,
			}))
		let changes: Record<string, Array<TextEdit>> = {}

		for (let entry of occurrences) {
			// NOTE: The URI the request came in under wins for the document it
			// names, so the edit lands on the buffer the Editor is holding
			// rather than on a second spelling of the same path.
			let uri =
				entry.filePath === documentFilePath(params.textDocument.uri)
					? params.textDocument.uri
					: uriOf(entry.filePath)
			let edits = changes[uri]

			if (edits === undefined) {
				edits = []
				changes[uri] = edits
			}

			edits.push({
				range: toLspRange(entry.position),
				newText: params.newName,
			})
		}

		return { changes }
	})

	connection.onWorkspaceSymbol((params) =>
		workspace.symbols(params.query).map(toLspWorkspaceSymbol),
	)

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

	// NOTE: Every file, not only this one — a name an entry carries is one
	// symbol, and half its uses being findable is the failure mode References
	// exists to prevent.
	connection.onReferences((params) => {
		let symbol = workspaceSymbolAt(params.textDocument.uri, params.position)

		if (symbol === null) {
			let occurrence = occurrenceAt(
				params.textDocument.uri,
				params.position,
			)

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
				.map((position) => ({
					uri: params.textDocument.uri,
					range: toLspRange(position),
				}))
		}

		let definition = symbol.definition

		return symbol.occurrences
			.filter(
				(entry) =>
					params.context.includeDeclaration ||
					definition === null ||
					entry.filePath !== symbol.filePath ||
					!isSamePosition(entry.position, definition),
			)
			.map((entry) => ({
				uri: uriOf(entry.filePath),
				range: toLspRange(entry.position),
			}))
	})

	// NOTE: The same join, restricted to this one file — Document Highlight is
	// per-file by protocol and fires on every cursor move, so it must not be the
	// request that enriches a workspace. What the join still buys here is the
	// two Module sections: highlighting a name in the body lights up the entry
	// that brought it in.
	connection.onDocumentHighlight((params) => {
		let symbol = workspaceSymbolAt(
			params.textDocument.uri,
			params.position,
			{ localOnly: true },
		)

		if (symbol === null) {
			return null
		}

		let filePath = documentFilePath(params.textDocument.uri)
		let occurrences = symbol.occurrences.filter(
			(entry) => entry.filePath === filePath,
		)

		if (occurrences.length === 0) {
			return null
		}

		return occurrences.map((entry) => ({
			range: toLspRange(entry.position),
			kind:
				entry.access === "write"
					? DocumentHighlightKind.Write
					: DocumentHighlightKind.Read,
		}))
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

		let result = findFormattingEdits(
			document.getText(),
			params.textDocument.uri,
		)

		// NOTE: An `unsafe` refusal means the formatter distrusted its own
		// output and kept the file as it was — a formatter bug, which the CLI
		// reports loudly and the editor should not swallow. The warning names
		// the component, not an executable: the user may have arrived here
		// through `essence format`, `esfmt` or Format Document alike.
		if (result.warning !== null) {
			connection.window.showWarningMessage(
				`${result.warning} The file was left unchanged; this is a bug in the Essence formatter.`,
			)
		}

		return result.edits
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
			workspace,
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

		// NOTE: The offers cost a walk of what the workspace publishes, which is
		// read off parses; the Namespace half enriches the Modules that publish
		// one, and only those. A document outside every folder gets neither, and
		// the list is exactly what it was before there were Modules.
		let filePath = documentFilePath(params.textDocument.uri)
		let inWorkspace = workspace.isInWorkspace(filePath)

		let entries = findCompletions(
			document.getText(),
			toCursor(params.position),
			params.textDocument.uri,
			inWorkspace
				? {
						offers: workspace.offersFor(filePath),
						namespaces: workspace.namespaceOffersFor(filePath),
					}
				: { offers: [], namespaces: [] },
		)

		return entries.map(toLspCompletionItem)
	})

	// NOTE: Every entry is complete when it is handed over — the detail, the
	// documentation and the import edit are all computed against the buffer the
	// request was answered on, and a second pass over a buffer that has moved on
	// would be worse than no pass at all.
	connection.onCompletionResolve((item) => item)

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

	// NOTE: A URI is cleared only once NO open document's analysis still reports
	// on it. Two importers of one broken Module both publish its Diagnostics,
	// and closing one of them must not wipe the squiggles the other is still
	// answering for.
	function claimedElsewhere(entryUri: string, targetUri: string): boolean {
		for (let [otherUri, published] of publishedByEntry) {
			if (otherUri !== entryUri && published.has(targetUri)) {
				return true
			}
		}

		return false
	}

	function publishAnalysis(
		entryUri: string,
		results: Map<string, Array<common.Diagnostic>>,
	) {
		for (let [targetUri, diagnostics] of results) {
			connection.sendDiagnostics({
				uri: targetUri,
				diagnostics: diagnostics.map((diagnostic) =>
					toLspDiagnostic(diagnostic, targetUri),
				),
			})
		}

		for (let staleUri of publishedByEntry.get(entryUri) ?? []) {
			if (results.has(staleUri) || claimedElsewhere(entryUri, staleUri)) {
				continue
			}

			connection.sendDiagnostics({ uri: staleUri, diagnostics: [] })
		}

		publishedByEntry.set(entryUri, new Set(results.keys()))
	}

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
				// documents are analysed strictly one at a time — the analysis
				// is synchronous, which guarantees that here.
				let analysis = analyseDocument(document.getText(), uri, {
					host: workspace.host,
				})
				let results = new Map<string, Array<common.Diagnostic>>([
					[uri, analysis.diagnostics],
				])

				// NOTE: A dependency's Diagnostics are published under ITS OWN
				// URI, which is what makes a mistake in a file nobody has open
				// visible at all. An open document reports on itself, so its own
				// entry is left to its own analysis rather than overwritten by
				// an importer's view of it.
				for (let [filePath, diagnostics] of analysis.dependencies) {
					let dependencyUri = uriOf(filePath)

					if (documents.get(dependencyUri) === undefined) {
						results.set(dependencyUri, diagnostics)
					}
				}

				publishAnalysis(uri, results)
			}, analysisDebounceInMilliseconds),
		)
	}

	// NOTE: `onDidChangeContent` also fires when a document is opened.
	documents.onDidChangeContent((event) => {
		let filePath = documentFilePath(event.document.uri)

		openPaths.set(filePath, event.document.uri)
		workspace.changed(filePath)
		scheduleAnalysis(event.document.uri)
	})

	documents.onDidClose((event) => {
		let pendingTimer = pendingAnalyses.get(event.document.uri)

		if (pendingTimer !== undefined) {
			clearTimeout(pendingTimer)
			pendingAnalyses.delete(event.document.uri)
		}

		let filePath = documentFilePath(event.document.uri)

		openPaths.delete(filePath)
		// NOTE: The buffer is gone, so what the workspace holds for it was built
		// from text that no longer exists anywhere — the file on disk is the
		// truth again.
		workspace.changed(filePath)

		// NOTE: Everything this document's analysis was publishing goes with it,
		// its own URI included — an empty set for each, unless another open
		// document still reports on it.
		publishAnalysis(event.document.uri, new Map())
		connection.sendDiagnostics({
			uri: event.document.uri,
			diagnostics: [],
		})
		publishedByEntry.delete(event.document.uri)
	})

	documents.listen(connection)
	connection.listen()
}

// NOTE: The inverse of the decoding `documentFilePath` does. Each segment is
// encoded on its own so that the separators survive — a file named `a b.es`
// becomes `a%20b.es`, and the client matches the URI it handed over.
export function uriOf(filePath: string): string {
	return `file://${filePath.split("/").map(encodeURIComponent).join("/")}`
}

// NOTE: A workspace symbol IS a document symbol whose document is not open, so
// it renders under the same kinds — there is one table, and the outline and the
// search can not disagree about what a Namespace looks like.
function toLspWorkspaceSymbol(entry: WorkspaceSymbolEntry): LspWorkspaceSymbol {
	return {
		name: entry.name,
		kind: symbolKinds[entry.kind],
		containerName: entry.container ?? undefined,
		location: {
			uri: uriOf(entry.filePath),
			range: toLspRange(entry.selectionRange),
		},
	}
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
	export: SymbolKind.Key,
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
	import: CompletionItemKind.Reference,
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
		// NOTE: Accepting a callable inserts the call's parentheses and commas
		// as snippet text, so the trigger characters Signature Help listens
		// for are never typed — without this nudge the parameter hints only
		// ever appear for a call written out by hand.
		command:
			callable || fallback
				? {
						title: "Trigger parameter hints",
						command: "editor.action.triggerParameterHints",
					}
				: undefined,
		// NOTE: The `import { … }` entry that makes the name resolve, applied in
		// the same undo step as the insertion at the cursor.
		additionalTextEdits: entry.additionalEdits?.map((edit) => ({
			range: toLspRange(edit.range),
			newText: edit.newText,
		})),
	}
}
