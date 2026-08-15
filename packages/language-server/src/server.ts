import { isStdlibDocument } from "@essence-lang/compiler/documents"
import { loadStdlib } from "@essence-lang/compiler/enricher/stdlib"
import type { common, parser } from "@essence-lang/interfaces"
import { TextDocument } from "vscode-languageserver-textdocument"
import {
	type CallHierarchyItem as LspCallHierarchyItem,
	type CancellationToken,
	type CodeAction,
	CodeActionKind,
	type CodeActionParams,
	type CompletionItem,
	CompletionItemKind,
	type Connection,
	createConnection,
	DidChangeConfigurationNotification,
	DidChangeWatchedFilesNotification,
	DocumentHighlightKind,
	type DocumentSymbol,
	ErrorCodes,
	FileChangeType,
	InlayHintKind,
	InsertTextFormat,
	LSPErrorCodes,
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

import {
	analyseDocument,
	type Cancellation,
	documentFilePath,
	isCancelled,
} from "./analyse"
import {
	type CallHierarchyItem,
	type CallHierarchyItemKind,
	findIncomingCalls,
	findOutgoingCalls,
	prepareCallHierarchy,
} from "./callHierarchy"
import { escapeSnippet } from "./callSnippets"
import { type CodeActionEntry, findCodeActions } from "./codeActions"
import { enrichDocument, parseDocument } from "./compilation"
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
	isValidLabelName,
	renameEdits,
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

// NOTE: One turn of the event loop before a request does anything expensive,
// and it is what makes a Cancellation observable at all: `$/cancelRequest` is a
// message on the same connection, and a handler that runs straight through from
// the moment it is called reads its token before that message was ever read off
// the socket. A macrotask, deliberately — a microtask runs before any I/O, so
// yielding to one would prove nothing.
//
// This is the ONLY place this Server suspends. Every stage of the Compiler
// collects its Diagnostics into module level state, which is safe exactly as
// long as no two collections interleave: a handler may suspend BEFORE it starts
// compiling and never inside. The debounced analysis is a timer callback that
// runs to completion, so it can not interleave either.
function yieldToConnection(): Promise<void> {
	return new Promise((resolve) => {
		setImmediate(resolve)
	})
}

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

function defaultConnection(): Connection {
	ensureTransportArgument()

	return createConnection(ProposedFeatures.all)
}

// NOTE: The connection is injectable for one reason: what this Server costs is
// a property of the whole request loop — the debounce, the document store, the
// order the Editor asks in — and a test that calls the handlers' insides
// measures something else. A harness hands in a connection over a pair of
// in-memory pipes and drives the real thing. Every other caller passes nothing
// and gets stdio, which is what `esls` speaks.
export function startServer(options: { connection?: Connection } = {}) {
	let connection = options.connection ?? defaultConnection()
	let documents = new TextDocuments(TextDocument)
	// NOTE: ONE timer for every document waiting to be analysed, rather than one
	// each, so that a burst of keystrokes and a branch switch that touched forty
	// files both come out as a single window — and inside that window the
	// documents are analysed in an order that makes their graphs overlap instead
	// of repeat (see `analysisOrder`).
	//
	// The DEADLINE is per document all the same, and the timer is armed for the
	// earliest of them. One timer that every keystroke restarts is a document
	// that never gets analysed while another one is being typed in: at one
	// keystroke per debounce, which is ordinary typing, the file the reader is
	// not in waits for them to stop, and nothing bounds how long that is.
	let pendingAnalyses = new Map<string, number>()
	let analysisTimer: ReturnType<typeof setTimeout> | null = null
	// NOTE: The document the last keystroke landed in, which is the one a Hover is
	// about to be asked over — see `annotationsFor`. Deliberately not the first
	// entry of `pendingAnalyses`: that is whichever document opened the window, so
	// a burst crossing files would collect the annotations for the file the reader
	// has already left, and the Hover that follows would pay for its own link.
	let analysisFocus: string | null = null
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
	// NOTE: The list each URI was last SENT, so an unchanged one is not sent
	// again. Kept by URI rather than by entry because two open documents can both
	// report on one dependency, and what the client holds for it is one list.
	let publishedContent = new Map<string, string>()
	// NOTE: Whether Type Hints are served — the client's
	// `essence.inlayHints.enabled`. True until a client says otherwise, so an
	// editor that answers no configuration requests keeps the Hints it always
	// had.
	let inlayHintsEnabled = true
	let clientSupportsConfiguration = false

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
		clientSupportsConfiguration =
			params.capabilities.workspace?.configuration === true
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

		// NOTE: The one setting this Server reads. Pulled rather than taken off
		// the notification — the notification only says that something under
		// `essence` changed, not what it is now — and pulled again on every
		// change, with a refresh so open editors drop or regain their Hints
		// without waiting for an edit to invalidate them.
		if (clientSupportsConfiguration) {
			let readInlayHintSetting = () =>
				connection.workspace
					.getConfiguration("essence.inlayHints.enabled")
					.then((enabled) => {
						if (inlayHintsEnabled === (enabled !== false)) {
							return
						}

						inlayHintsEnabled = enabled !== false
						connection.languages.inlayHint.refresh().catch(() => {})
					})
					.catch(() => {})

			connection.client
				.register(DidChangeConfigurationNotification.type, {
					section: "essence",
				})
				.catch(() => {})
			connection.onDidChangeConfiguration(() => {
				readInlayHintSetting()
			})
			readInlayHintSetting()
		}

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
		//
		// NOTE: N documents scheduled is not N analyses. They go through the
		// same debounce every keystroke does, so a checkout switching branches
		// under the Editor coalesces into one window — and inside it the first
		// document that runs fills the cache for every other Module of its
		// component, which the rest then read.
		for (let document of documents.all()) {
			scheduleAnalysis(document.uri)
		}
	})

	// NOTE: Every request that answers ABOUT a document comes through here, and
	// what it gets is the Workspace's cache entry for that document at its
	// current version — the parse, the typed Program, the rename index and, for
	// Hover, the written annotations. A request arriving before the debounced
	// analysis has run for this version computes the entry itself; the analysis
	// that follows then reads it. Whoever asks first pays, once.
	//
	// NOTE: The fallback below is not a fast path for anything — it is the
	// answer for the documents the Workspace deliberately holds nothing for: a
	// standard library source, which is enriched with its own declarations
	// subtracted back out of the builtin tables, and a buffer whose path can not
	// be read. Both were always analysed on their own.
	function parseAndEnrich(
		uri: string,
		options: { annotations?: boolean; cancellation?: Cancellation } = {},
	) {
		let document = documents.get(uri)

		if (document === undefined) {
			return null
		}

		let filePath = documentFilePath(uri)

		if (workspace.programOf(filePath) !== null) {
			let cached = workspace.documentOf(filePath, {
				cancellation: options.cancellation,
			})

			// NOTE: Abandoned. The Workspace holds this file, so the fallback
			// below is not what it wants answering with — nothing is.
			if (cached === null) {
				return null
			}

			return {
				program: cached.program,
				enrichedProgram: cached.enrichedProgram,
				index: cached.index,
				// NOTE: Only Hover asks for these, and collecting them for a
				// Module of a component whose analysis was anchored elsewhere
				// costs one more link — so they are asked for and not merely
				// read.
				annotations:
					options.annotations === true
						? workspace.annotationsOf(filePath, {
								cancellation: options.cancellation,
							})
						: [],
			}
		}

		let { program } = parseDocument(document.getText(), uri)
		let enrichedProgram: common.typed.Program | null = null
		let annotations: Array<common.TypeAnnotation> = []

		try {
			let enriched = enrichDocument(program, uri, {
				annotations: options.annotations,
			})

			enrichedProgram = enriched.program
			annotations = enriched.annotations
		} catch {}

		return { program, enrichedProgram, annotations, index: null }
	}

	// NOTE: Whether a request is still worth answering, checked after the one
	// suspension this Server makes. Two ways it stops being worth answering: the
	// Editor cancelled it, or the document moved on. A request is answered on
	// the version it named or not at all — its Positions belong to that version,
	// and an answer measured against a later one points at whatever moved into
	// their place.
	async function isCurrent(
		uri: string,
		token: CancellationToken,
	): Promise<boolean> {
		let version = documents.get(uri)?.version

		await yieldToConnection()

		return !isCancelled(token) && documents.get(uri)?.version === version
	}

	// NOTE: The protocol's own answer for a request nobody is waiting for any
	// more, and the two reasons `isCurrent` refuses for are two different codes.
	// `RequestCancelled` says the Editor asked for this to stop; `ContentModified`
	// says the document moved on underneath it. Clients act on the difference —
	// vscode-languageclient returns the request's default value for
	// `ContentModified` and THROWS a CancellationError for a `RequestCancelled`
	// whose own token was never cancelled, which is exactly the version case.
	//
	// The token is asked again rather than remembered: it answers the same
	// question `isCurrent` asked of it, and a cancelled request is cancelled
	// whatever else also happened to it.
	function abandoned(token: CancellationToken) {
		return isCancelled(token)
			? new ResponseError(
					LSPErrorCodes.RequestCancelled,
					"This request was cancelled.",
				)
			: new ResponseError(
					LSPErrorCodes.ContentModified,
					"The document moved on before this request was answered.",
				)
	}

	// NOTE: The Parser AST alone, for the requests that need no Types. Read from
	// the same cache as everything else so that a Folding Range and a Hover over
	// one document are two readers of one parse.
	function parsedOf(uri: string): parser.Program | null {
		let document = documents.get(uri)

		if (document === undefined) {
			return null
		}

		return (
			workspace.programOf(documentFilePath(uri)) ??
			parseDocument(document.getText(), uri).program
		)
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

	function occurrencesAt(uri: string, position: Position) {
		let parsed = parseAndEnrich(uri)

		if (parsed === null) {
			return []
		}

		return findOccurrences(
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

	connection.onPrepareRename(async (params, token) => {
		if (!(await isCurrent(params.textDocument.uri, token))) {
			return abandoned(token)
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

	connection.onRenameRequest(async (params, token) => {
		if (!(await isCurrent(params.textDocument.uri, token))) {
			return abandoned(token)
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

		// NOTE: What counts as a valid new name depends on what is renamed: a
		// LABEL lives in the grammar's Identifier rule, which reads Keywords
		// like `with` and `from` as ordinary Identifiers — the standard
		// library's own labels are spelled with them.
		let kind = anchor?.symbol.kind ?? occurrence!.declaration.kind
		let isValidNewName =
			kind === "label" ? isValidLabelName : isValidIdentifierName

		if (!isValidNewName(params.newName)) {
			return new ResponseError(
				ErrorCodes.InvalidParams,
				`'${params.newName}' is not a valid Identifier.`,
			)
		}

		let occurrences: Array<WorkspaceOccurrence> =
			anchor?.symbol.occurrences ??
			occurrence!.declaration.occurrences.map((site) => ({
				filePath: documentFilePath(params.textDocument.uri),
				position: site.position,
				edits: site.edits,
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

			// NOTE: Most sites are the new name written over the Identifier
			// that was found. A Pattern's shorthand binder is not: `{ width }`
			// names the Record's member and the local it binds with ONE
			// Identifier, so renaming either end has to spell the other out
			// beside it — `renameEdits` is where that is decided, once, for
			// every caller.
			edits.push(
				...renameEdits(
					{ position: entry.position, edits: entry.edits ?? null },
					params.newName,
				).map((edit) => ({
					range: toLspRange(edit.position),
					newText: edit.newText,
				})),
			)
		}

		return { changes }
	})

	connection.onWorkspaceSymbol((params) =>
		workspace.symbols(params.query).map(toLspWorkspaceSymbol),
	)

	connection.onDefinition(async (params, token) => {
		if (!(await isCurrent(params.textDocument.uri, token))) {
			return abandoned(token)
		}

		// NOTE: The workspace join answers first, because the local index
		// stops at the import entry — the entry IS this file's declaration of
		// the name, and a reader asking from it (or from any use bound through
		// it) is pointing at the declaration in whichever Module writes it.
		let symbol = workspaceSymbolAt(params.textDocument.uri, params.position)

		if (
			symbol !== null &&
			symbol.filePath !== null &&
			symbol.definition !== null
		) {
			return {
				uri: uriOf(symbol.filePath),
				range: toLspRange(symbol.definition),
			}
		}

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

	connection.onHover(async (params, token) => {
		if (!(await isCurrent(params.textDocument.uri, token))) {
			return abandoned(token)
		}

		let parsed = parseAndEnrich(params.textDocument.uri, {
			annotations: true,
			cancellation: token,
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
	connection.onReferences(async (params, token) => {
		if (!(await isCurrent(params.textDocument.uri, token))) {
			return abandoned(token)
		}

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
					(site) =>
						params.context.includeDeclaration ||
						definition === null ||
						!isSamePosition(site.position, definition),
				)
				.map((site) => ({
					uri: params.textDocument.uri,
					range: toLspRange(site.position),
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
	connection.onDocumentHighlight(async (params, token) => {
		if (!(await isCurrent(params.textDocument.uri, token))) {
			return abandoned(token)
		}

		let symbol = workspaceSymbolAt(
			params.textDocument.uri,
			params.position,
			{ localOnly: true },
		)

		// NOTE: The same fallback References takes — a builtin has no workspace
		// symbol, but highlighting is read-only and works on builtins too, and
		// `findOccurrences` keeps the access each entry carries.
		if (symbol === null) {
			let occurrences = occurrencesAt(
				params.textDocument.uri,
				params.position,
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

	// NOTE: Not debounced, and deliberately: once the whole request is a read of
	// the analysis cache, coalescing it would only delay a highlight that costs
	// nothing to draw. What it does need is the abandonment above — an Editor
	// asks for these on every keystroke and cancels the ones it overtook.
	connection.languages.semanticTokens.on(async (params, token) => {
		if (!(await isCurrent(params.textDocument.uri, token))) {
			return abandoned(token)
		}

		let parsed = parseAndEnrich(params.textDocument.uri, {
			cancellation: token,
		})

		if (parsed === null) {
			return { data: [] }
		}

		return {
			data: encodeSemanticTokens(
				findSemanticTokens(
					parsed.program,
					parsed.enrichedProgram,
					parsed.index,
				),
			),
		}
	})

	connection.languages.onLinkedEditingRange(async (params, token) => {
		if (!(await isCurrent(params.textDocument.uri, token))) {
			return abandoned(token)
		}

		// NOTE: Editing one occurrence updates the rest as they are typed, so
		// this is deliberately restricted to what renaming would accept —
		// Builtins are excluded, since typing over `Terminal` must not look
		// like it is renaming it.
		let occurrence = renameableOccurrenceAt(
			params.textDocument.uri,
			params.position,
		)

		if (occurrence === null) {
			return null
		}

		// NOTE: Linked editing propagates the SAME text to every range, so a
		// symbol with a site that needs different text can not be offered —
		// which is exactly a Pattern's shorthand binder: typing over `width` in
		// `{ width }` has to leave the member behind as `{ width as … }`, and
		// no amount of propagating one word does that. Renaming still works;
		// this is the one capability that can not express the expansion, which
		// is what the restriction above already anticipated.
		if (
			occurrence.declaration.occurrences.some(
				(site) => site.edits !== null,
			)
		) {
			return null
		}

		return {
			ranges: occurrence.declaration.occurrences.map((site) =>
				toLspRange(site.position),
			),
			// NOTE: Typing a character an Identifier cannot contain ends the
			// linked edit instead of propagating something unparseable.
			wordPattern: identifierPattern,
		}
	})

	connection.languages.callHierarchy.onPrepare(async (params, token) => {
		if (!(await isCurrent(params.textDocument.uri, token))) {
			return abandoned(token)
		}

		let parsed = parseAndEnrich(params.textDocument.uri, {
			cancellation: token,
		})

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
	connection.languages.callHierarchy.onIncomingCalls(
		async (params, token) => {
			if (!(await isCurrent(params.item.uri, token))) {
				return abandoned(token)
			}

			let parsed = parseAndEnrich(params.item.uri, {
				cancellation: token,
			})

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
		},
	)

	connection.languages.callHierarchy.onOutgoingCalls(
		async (params, token) => {
			if (!(await isCurrent(params.item.uri, token))) {
				return abandoned(token)
			}

			let parsed = parseAndEnrich(params.item.uri, {
				cancellation: token,
			})

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
		},
	)

	// NOTE: The outline enriches so that entries can carry their Types, and
	// degrades to the Parser's answer alone when enrichment throws — the whole
	// point of building it off the Parser AST is that it survives a Program
	// that does not type check.
	connection.onDocumentSymbol(async (params, token) => {
		if (!(await isCurrent(params.textDocument.uri, token))) {
			return abandoned(token)
		}

		let parsed = parseAndEnrich(params.textDocument.uri, {
			cancellation: token,
		})

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

	connection.onCodeAction(async (params, token) => {
		if (!(await isCurrent(params.textDocument.uri, token))) {
			return abandoned(token)
		}

		let document = documents.get(params.textDocument.uri)

		if (document === undefined) {
			return null
		}

		// NOTE: The same analysis the Diagnostics were published from, which is
		// what a quick fix is an answer to — half of what a Code Action offers
		// IS a Diagnostic, so reading them from anywhere else would let the
		// lightbulb disagree with the squiggle it is offered on.
		let analysis = workspace.analysisOf(
			documentFilePath(params.textDocument.uri),
			{ cancellation: token },
		)

		// NOTE: Checked rather than inferred from the null: `findCodeActions`
		// runs the pipeline itself when it is handed nothing, which is right for
		// a document the Workspace holds none of and exactly wrong for a request
		// that was abandoned halfway.
		if (isCancelled(token)) {
			return abandoned(token)
		}

		return findCodeActions(
			document.getText(),
			toRange(params.range),
			params.textDocument.uri,
			workspace,
			analysis,
		).map((entry) => toLspCodeAction(entry, params))
	})

	connection.onFoldingRanges((params) => {
		let program = parsedOf(params.textDocument.uri)

		if (program === null) {
			return null
		}

		return findFoldingRanges(program).map((range) => ({
			startLine: range.startLine - 1,
			endLine: range.endLine - 1,
		}))
	})

	connection.onSelectionRanges((params) => {
		let program = parsedOf(params.textDocument.uri)

		if (program === null) {
			return null
		}

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

	// NOTE: Not debounced either, for the same reason Semantic Tokens are not.
	connection.languages.inlayHint.on(async (params, token) => {
		if (!inlayHintsEnabled) {
			return null
		}

		if (!(await isCurrent(params.textDocument.uri, token))) {
			return abandoned(token)
		}

		let parsed = parseAndEnrich(params.textDocument.uri, {
			cancellation: token,
		})

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

	connection.onCompletion(async (params, token) => {
		if (!(await isCurrent(params.textDocument.uri, token))) {
			return abandoned(token)
		}

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
			// NOTE: The unmodified document, which every one of the three
			// listings below the probe used to derive again for itself.
			workspace.documentOf(filePath),
		)

		return entries.map(toLspCompletionItem)
	})

	// NOTE: Every entry is complete when it is handed over — the detail, the
	// documentation and the import edit are all computed against the buffer the
	// request was answered on, and a second pass over a buffer that has moved on
	// would be worse than no pass at all.
	connection.onCompletionResolve((item) => item)

	connection.onSignatureHelp(async (params, token) => {
		if (!(await isCurrent(params.textDocument.uri, token))) {
			return abandoned(token)
		}

		let document = documents.get(params.textDocument.uri)

		if (document === undefined) {
			return null
		}

		let help = findSignatureHelp(
			document.getText(),
			toCursor(params.position),
			params.textDocument.uri,
			workspace.documentOf(documentFilePath(params.textDocument.uri)),
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

	// NOTE: Only what CHANGED goes over the wire. Refreshing a dependent whose
	// meaning moved is the point of expanding a batch to them; re-sending it the
	// same list it already has is a message and a client-side rebuild for a file
	// the reader is not even in, and a keystroke in a Module several open files
	// import produces one of those per file.
	//
	// NOTE: The `version` is the buffer the list was computed against, which is
	// what lets a client throw away a publish that raced a keystroke — the one
	// window a debounce widens. Absent for a dependency nobody has open: there is
	// no version to name, and its content came off disk.
	function publish(uri: string, diagnostics: Array<common.Diagnostic>): void {
		let sent = diagnostics.map((diagnostic) =>
			toLspDiagnostic(diagnostic, uri),
		)
		let signature = JSON.stringify(sent)

		if (publishedContent.get(uri) === signature) {
			return
		}

		publishedContent.set(uri, signature)
		connection.sendDiagnostics({
			uri,
			version: documents.get(uri)?.version,
			diagnostics: sent,
		})
	}

	function publishAnalysis(
		entryUri: string,
		results: Map<string, Array<common.Diagnostic>>,
	) {
		for (let [targetUri, diagnostics] of results) {
			publish(targetUri, diagnostics)
		}

		for (let staleUri of publishedByEntry.get(entryUri) ?? []) {
			if (results.has(staleUri) || claimedElsewhere(entryUri, staleUri)) {
				continue
			}

			publish(staleUri, [])
		}

		publishedByEntry.set(entryUri, new Set(results.keys()))
	}

	// NOTE: The documents whose graph reaches the most others first. One analysis
	// fills the cache for every Module its graph touched, so analysing a
	// dependency BEFORE the file importing it links the same Modules twice —
	// once as a graph of their own, and once again inside the larger one. The
	// order is what makes a batch cost one link per graph ROOT rather than one
	// per document — a document nothing else in the batch imports pays for its
	// own link and every document below it in that graph reads the result. Read
	// off the parses, which are cached.
	function analysisOrder(uris: Array<string>): Array<string> {
		let reachOf = (uri: string): number => {
			let reached = new Set<string>()
			let pending = [documentFilePath(uri)]

			while (pending.length > 0) {
				let current = pending.shift()!

				for (let dependency of workspace
					.dependenciesOf(current)
					.values()) {
					if (reached.has(dependency)) {
						continue
					}

					reached.add(dependency)
					pending.push(dependency)
				}
			}

			return reached.size
		}
		let reach = new Map(uris.map((uri) => [uri, reachOf(uri)]))

		return [...uris].sort(
			(left, right) => reach.get(right)! - reach.get(left)!,
		)
	}

	// NOTE: Every open document that IMPORTS what changed, because an edit to a
	// Module changes what its dependents mean — their published Diagnostics go
	// stale with it, and nothing else will ever refresh them, since no keystroke
	// is going to land in those files.
	//
	// Dependents rather than the whole undirected component, which is the only
	// set that is both sufficient and paid for. A file that merely shares a
	// dependency with the edited one imports nothing from it, so its Diagnostics
	// provably can not have moved — and it is its own graph root, whose link no
	// other document's graph subsumes. Expanding to the component therefore cost
	// one link per open sibling: thirty tabs on one shared Module, thirty links,
	// on the keystroke path.
	//
	// Expanded when the window FIRES rather than when the keystroke arrives: the
	// walk reads the file's entries, which means parsing it, and a parse per
	// keystroke is the cost this whole cache exists to remove.
	function withOpenDependents(uris: Array<string>): Array<string> {
		let expanded = new Set(uris)

		for (let uri of uris) {
			for (let filePath of workspace.dependentsOf(
				documentFilePath(uri),
			)) {
				let openUri = openPaths.get(filePath)

				if (openUri !== undefined && documents.get(openUri)) {
					expanded.add(openUri)
				}
			}
		}

		return [...expanded]
	}

	function scheduleAnalysis(uri: string) {
		pendingAnalyses.set(uri, Date.now() + analysisDebounceInMilliseconds)
		analysisFocus = uri
		armAnalysis()
	}

	// NOTE: Everything pending is flushed together once the FIRST of them is due,
	// rather than each at its own deadline. Both halves of that matter: waiting
	// for the earliest is what stops a document from being held back by an edit
	// somewhere else, and flushing the rest with it is what keeps a batch to one
	// link per graph root instead of splitting a fan-out into one window each.
	// A document still being typed in pays at most one extra analysis per other
	// document that came due, and its own debounce starts again from there.
	function armAnalysis() {
		if (analysisTimer !== null) {
			clearTimeout(analysisTimer)
			analysisTimer = null
		}

		if (pendingAnalyses.size === 0) {
			return
		}

		let due = Infinity

		for (let deadline of pendingAnalyses.values()) {
			due = Math.min(due, deadline)
		}

		analysisTimer = setTimeout(
			() => {
				analysisTimer = null

				let focus = analysisFocus ?? undefined
				let scheduled = analysisOrder(
					withOpenDependents([...pendingAnalyses.keys()]),
				)

				pendingAnalyses.clear()
				analysisFocus = null

				for (let scheduledUri of scheduled) {
					analyseAndPublish(scheduledUri, focus)
				}
			},
			Math.max(0, due - Date.now()),
		)
	}

	function analyseAndPublish(uri: string, focus?: string) {
		let document = documents.get(uri)

		if (document === undefined) {
			return
		}

		// NOTE: The Diagnostics collector is module-level state, so documents
		// are analysed strictly one at a time — every batched analysis runs to
		// completion inside one timer callback, which guarantees that, and it is
		// the reason a request may only suspend before it compiles anything (see
		// `yieldToConnection`).
		//
		// NOTE: Through the Workspace, so that this WRITES the cache every
		// request reads: one analysis fills the entry for this document and for
		// every other Module of its graph, and a Hover that already paid for one
		// finds it here rather than paying again. A document the Workspace holds
		// nothing for — a standard library source — is analysed on its own,
		// exactly as it was.
		let analysis =
			workspace.analysisOf(documentFilePath(uri), {
				annotationsFor:
					focus === undefined ? undefined : documentFilePath(focus),
			}) ??
			analyseDocument(document.getText(), uri, {
				host: workspace.host,
			})
		let results = new Map<string, Array<common.Diagnostic>>([
			[uri, analysis.diagnostics],
		])

		// NOTE: A dependency's Diagnostics are published under ITS OWN URI,
		// which is what makes a mistake in a file nobody has open visible at
		// all. An open document reports on itself, so its own entry is left to
		// its own analysis rather than overwritten by an importer's view of it.
		for (let [filePath, diagnostics] of analysis.dependencies) {
			let dependencyUri = uriOf(filePath)

			if (documents.get(dependencyUri) === undefined) {
				results.set(dependencyUri, diagnostics)
			}
		}

		publishAnalysis(uri, results)
	}

	// NOTE: `onDidChangeContent` also fires when a document is opened.
	documents.onDidChangeContent((event) => {
		let filePath = documentFilePath(event.document.uri)

		openPaths.set(filePath, event.document.uri)
		workspace.changed(filePath)
		scheduleAnalysis(event.document.uri)
	})

	documents.onDidClose((event) => {
		pendingAnalyses.delete(event.document.uri)

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
		publish(event.document.uri, [])
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
