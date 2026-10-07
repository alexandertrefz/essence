import * as path from "node:path"
import { pathToFileURL } from "node:url"

import {
	parseProjectConfiguration,
	PROJECT_FILE_NAME,
	skippedDirectories,
} from "@essence-lang/compiler/configuration"
import { isStdlibDocument } from "@essence-lang/compiler/documents"
import { loadStdlib } from "@essence-lang/compiler/enricher/stdlib"
import type { common, parser } from "@essence-lang/interfaces"
import type { TestEvent } from "@essence-lang/runtime/Testing"
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
	type InlayHint,
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
	type WorkspaceEdit,
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
import {
	type CodeActionEntry,
	findCodeActions,
	isRequestedKind,
} from "./codeActions"
import { projectFileActions } from "./codeActions/projectFile"
import { findTestLenses } from "./codeLenses"
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
import { importRewrites } from "./fileRename"
import { findFoldingRanges } from "./foldingRanges"
import { findFormattingEdits } from "./formatting"
import { findHover } from "./hover"
import {
	findInlayHints,
	type InlayHint as InlayHintEntry,
	type InlayHintEdit,
} from "./inlayHints"
import { isSamePosition } from "./positions"
import {
	findDefinition,
	findOccurrence,
	findOccurrences,
	findRenameableOccurrence,
	identifierPattern,
	isValidBindingLabelName,
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
import { focusDiagnostics } from "./testFocus"
import { findValueHints } from "./testHints"
import {
	RUN_TESTS_REQUEST,
	type RunTestsParams,
	type RunTestsResult,
	TEST_RUN_NOTIFICATION,
	type TestSettings,
} from "./testProtocol"
import { createTestSession } from "./testSession"
import { tagDiagnostics } from "./testTags"
import {
	createWorkspace,
	type WorkspaceOccurrence,
	type WorkspaceSymbolEntry,
} from "./workspace"

const analysisDebounceInMilliseconds = 200

// Answered once no analysis window or sweep is pending, after every publish on
// the way there. See "Waiting for idle" in DEVELOPMENT.md.
export const IDLE_REQUEST = "essence/idle"

// One macrotask, so a `$/cancelRequest` sent behind the request is read
// first. See "Where the Server suspends" in DEVELOPMENT.md.
function yieldToConnection(): Promise<void> {
	return new Promise((resolve) => {
		setImmediate(resolve)
	})
}

// Module level so a spec can read what the Server advertises. A capability
// that stops being announced disables its feature while its handler still works.
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
	// No `resolveProvider`: every action carries its edits already. No
	// `source.fixAll`: removing unused imports is the one fix safe in bulk, and
	// `source.organizeImports` is that fix.
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
		// Announced although every entry is complete: a client may send back an
		// item it trimmed for the wire, and resolving returns it intact.
		resolveProvider: true,
	},
	workspaceSymbolProvider: true,
	workspace: {
		workspaceFolders: {
			supported: true,
			changeNotifications: true,
		},
		// Asked before a file moves, so the imports naming it change in the
		// same edit. Renaming a folder is one request, hence the folder globs.
		// The client's minimatch `*` and `**` skip dot segments, and
		// `FileOperationPatternOptions` carries only `ignoreCase`. So each glob
		// has a twin for a path with a dot segment.
		fileOperations: {
			willRename: {
				filters: [
					{
						scheme: "file",
						pattern: { glob: "**/*.es", matches: "file" },
					},
					{
						scheme: "file",
						pattern: { glob: "**/.*/**/*.es", matches: "file" },
					},
					{
						scheme: "file",
						pattern: { glob: "**", matches: "folder" },
					},
					{
						scheme: "file",
						pattern: { glob: "**/.*/**", matches: "folder" },
					},
				],
			},
		},
	},
	signatureHelpProvider: {
		triggerCharacters: ["(", ","],
		// Closing a nested call puts the cursor back inside the outer one.
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
	// Run and Debug above every `test` and `suite`. No resolve: a lens carries
	// its command and the ids of the tests under it.
	codeLensProvider: { resolveProvider: false },
	// A Type Hint's edit is spelled on resolve, for a client that can take it
	// then. See "Inlay Hints" in DEVELOPMENT.md.
	inlayHintProvider: { resolveProvider: true },
	linkedEditingRangeProvider: true,
	callHierarchyProvider: true,
}

// vscode-languageserver throws when process.argv names no transport, and
// `essence lsp` passes none. `--stdio` is appended only when no transport is
// named.
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

// The connection is injectable so a spec can drive the real request loop over
// in-memory pipes. Every other caller gets stdio.
export function startServer(options: { connection?: Connection } = {}) {
	let connection = options.connection ?? defaultConnection()
	let documents = new TextDocuments(TextDocument)
	// Changed files by analysis deadline. One timer serves them all, armed for
	// the earliest deadline. See "The debounce window" in DEVELOPMENT.md.
	let pendingChanges = new Map<string, number>()
	// The deadline of a sweep over every entry, or null when none is waiting.
	let pendingSweep: number | null = null
	let analysisTimer: ReturnType<typeof setTimeout> | null = null
	// The entries a started sweep still owes, one per callback. See "The
	// workspace sweep" in DEVELOPMENT.md.
	let sweepQueue: Array<string> = []
	// The reach of each queued entry, which orders the queue and names what
	// each entry should have covered.
	let sweepReaches = new Map<string, Set<string>>()
	// Whether the queue holds entries or the fallbacks they left uncovered.
	let sweepPhase: "entries" | "fallbacks" = "entries"
	// The files the queue's entries should have judged and did not, collected
	// right after each entry runs.
	let sweepUncovered = new Set<string>()
	// URIs the sweep's entries stopped reporting on, cleared once the queue
	// empties. A replacing sweep inherits them.
	let sweepDropped = new Set<string>()
	// The focus the sweep started with. A root is linked once, so the focus is
	// named to every callback of the queue.
	let sweepFocus: string | undefined
	let sweepChunk: ReturnType<typeof setImmediate> | null = null
	// Callers of `essence/idle` waiting for the loop to go quiet.
	let idleWaiters: Array<() => void> = []
	// The file the last keystroke landed in, whose annotations the next Hover
	// reads. See "The debounce window" in DEVELOPMENT.md.
	let analysisFocus: string | null = null
	// Open documents by canonical path, the key of the Workspace and the Module
	// graph. An unsaved buffer wins over the file on disk.
	let openPaths = new Map<string, string>()
	// Open `essence.json` buffers, kept apart from `openPaths`, whose every
	// entry is treated as Essence source. See "Project files" in DEVELOPMENT.md.
	let openProjectFiles = new Map<string, string>()
	let workspace = createWorkspace({
		openDocument: (filePath) => {
			let uri = openPaths.get(filePath)
			let document = uri === undefined ? undefined : documents.get(uri)

			return document === undefined
				? undefined
				: { text: document.getText(), version: document.version }
		},
		// A build drops the `tests` section, so only the editor reports its type
		// errors. The test session runs the tests in its Worker.
		tests: true,
	})
	// The URIs each entry published to, keyed by the entry's canonical path.
	// See "Who owns a published list" in DEVELOPMENT.md.
	let publishedByEntry = new Map<string, Set<string>>()
	// The list each URI was last sent, so an unchanged one is not sent again.
	let publishedContent = new Map<string, string>()
	// The URIs the project files' problems were last published to. A file
	// whose problems went away is owed an empty list.
	let publishedConfiguration = new Set<string>()
	// The client's `essence.inlayHints.enabled`. True until a client says
	// otherwise.
	let inlayHintsEnabled = true
	let clientSupportsConfiguration = false
	// What the client can apply. Every client takes `changes`; only one that
	// said so takes `documentChanges` and resource operations. A client sent a
	// shape it never advertised applies nothing.
	let clientSupportsDocumentChanges = false
	let clientCreatesFiles = false
	let clientResolvesHintEdits = false
	// The live test session, which compiles and runs in a Worker of its own.
	let session = createTestSession({
		testFiles,
		dependentsOf: (filePath) => workspace.dependentsOf(filePath),
		// Asked per file, since each `essence.json` of the workspace governs its
		// own files' skipped tags and contract tests.
		settingsFor: (filePath) => {
			let { skipTags, contracts } =
				workspace.configurationFor(filePath).test

			return { skipTags, contracts }
		},
		overlays: () => {
			let overlays: Record<string, string> = {}

			for (let [filePath, uri] of openPaths) {
				let document = documents.get(uri)

				if (document !== undefined) {
					overlays[filePath] = document.getText()
				}
			}

			return overlays
		},
		notify: (notification) => {
			// A connection that has gone away throws, and a run may finish
			// after the Editor closed. Swallowing it keeps the shutdown going.
			try {
				void connection
					.sendNotification(TEST_RUN_NOTIFICATION, notification)
					.catch(() => {})
			} catch {}
		},
		// New `test-failed` Diagnostics join the analysis's own list, so the
		// entries owning those files publish again, with the held focus. See
		// "The analysis loop" in DEVELOPMENT.md.
		onResults: (filePaths) => {
			analyseBatch(entriesFor([...filePaths]), analysisFocus ?? undefined)

			connection.languages.inlayHint.refresh().catch(() => {})
		},
		onProblem: (filePath, problem) => {
			connection.console.log(
				`essence: the test session could not run ${filePath}: ${problem}`,
			)
		},
		// An accepted snapshot is applied as an edit, since writing the file
		// would lose unsaved work in its buffer. The Formatter answers with a
		// whole file, so the whole document is replaced.
		onRewrites: (rewrites) => {
			for (let rewrite of rewrites) {
				let uri =
					openPaths.get(rewrite.module) ??
					pathToFileURL(rewrite.module).href

				connection.workspace
					.applyEdit({
						label: "Accept snapshot",
						edit: {
							changes: {
								[uri]: [
									{
										range: wholeDocument(uri),
										newText: rewrite.text,
									},
								],
							},
						},
					})
					.catch(() => {})
			}
		},
	})

	// A range over the whole document. For one nothing has open it ends on a
	// line past any end, which the protocol says a client clamps.
	function wholeDocument(uri: string): {
		start: { line: number; character: number }
		end: { line: number; character: number }
	} {
		let document = documents.get(uri)

		return {
			start: { line: 0, character: 0 },
			end:
				document === undefined
					? { line: Number.MAX_SAFE_INTEGER, character: 0 }
					: document.positionAt(document.getText().length),
		}
	}

	// Every file that writes a `tests` block, whatever its name. Under a
	// project's `test.contracts`, also every file declaring a Namespace, whose
	// goals the compile turns into a suite (`contractSuite`).
	function testFiles(): Array<string> {
		return [...workspace.knownFiles()].filter((filePath) => {
			let program = workspace.programOf(filePath)

			if (program === null) {
				return false
			}

			if (program.tests != null) {
				return true
			}

			return (
				workspace.configurationFor(filePath).test.contracts &&
				program.implementation.nodes.some(
					(node) => node.nodeType === "NamespaceDefinitionStatement",
				)
			)
		})
	}

	// What the tags of the whole workspace say about each other, which no single
	// compile sees. Cached until a file changes.
	let tags: Map<string, Array<common.Diagnostic>> | null = null

	function tagDiagnosticsFor(filePath: string): Array<common.Diagnostic> {
		// Gated on the setting because it walks every parse in the workspace,
		// which a reader who declined the live session declined.
		if (!session.isEnabled()) {
			return []
		}

		if (tags === null) {
			tags = tagDiagnostics(
				testFiles().flatMap((each) => {
					let program = workspace.programOf(each)

					return program === null ? [] : [{ filePath: each, program }]
				}),
			)
		}

		return tags.get(filePath) ?? []
	}

	// What the test session says about a file, joined to the analysis's list.
	// The failures stay when the session is off: switching it off empties it,
	// so what is left came from a run somebody asked for.
	function testDiagnosticsFor(filePath: string): Array<common.Diagnostic> {
		let program = workspace.programOf(filePath)

		return [
			...session.diagnosticsFor(filePath),
			// Ungated: a `focused` test makes a plain command-line run refuse,
			// which the reader wants to know with the session off too.
			...(program === null ? [] : focusDiagnostics(program)),
			...tagDiagnosticsFor(filePath),
		]
	}

	// Loads the standard library while the client sets up, so the first Hover
	// does not pay for it. The folders come only from the client: the Server
	// ships bundled inside the extension, so its own location names nothing.
	connection.onInitialize((params) => {
		loadStdlib()
		clientSupportsConfiguration =
			params.capabilities.workspace?.configuration === true

		let workspaceEdit = params.capabilities.workspace?.workspaceEdit

		clientSupportsDocumentChanges = workspaceEdit?.documentChanges === true
		clientCreatesFiles =
			clientSupportsDocumentChanges &&
			(workspaceEdit?.resourceOperations ?? []).includes("create")
		clientResolvesHintEdits = (
			params.capabilities.textDocument?.inlayHint?.resolveSupport
				?.properties ?? []
		).includes("textEdits")

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
		// Sources change on disk without a document event, for example on a
		// branch switch. `essence.json` moves which files are sources. A
		// `package.json` is watched only to report an `essence` key it still has.
		connection.client
			.register(DidChangeWatchedFilesNotification.type, {
				watchers: [
					{ globPattern: "**/*.es" },
					{ globPattern: `**/${PROJECT_FILE_NAME}` },
					{ globPattern: "**/package.json" },
				],
			})
			.catch(() => {})

		// Pulled on every change, since the notification only says something
		// under `essence` changed. A changed setting refreshes the Hints.
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

			// The whole `essence.tests` section in one request. The tags a run
			// skips belong to the project, so they come from its `essence.json`.
			let readTestSettings = () =>
				connection.workspace
					.getConfiguration("essence.tests")
					.then((tests: TestSettings | null | undefined) => {
						if (typeof tests?.debounce === "number") {
							session.setDebounce(tests.debounce)
						}

						// Off unless asked for: counting coverage compiles a
						// different bundle that does more work per run.
						session.setCoverage(tests?.coverage === true)

						// Last, so a session switched on runs with the debounce
						// just read.
						session.setEnabled(tests?.enabled !== false)
					})
					.catch(() => {})

			connection.client
				.register(DidChangeConfigurationNotification.type, {
					section: "essence",
				})
				.catch(() => {})
			connection.onDidChangeConfiguration(() => {
				readInlayHintSetting()
				readTestSettings()
			})
			readInlayHintSetting()
			readTestSettings()
		}

		// First, since the project files configure the walk and the run.
		publishConfiguration()

		// Here rather than in `onInitialize`, which is owed a prompt answer:
		// the first run walks the workspace for test files.
		session.runAll("open")

		// The whole project, so the Problems panel lists every file. Debounced,
		// so the documents a client restores cost one window.
		scheduleSweep()

		connection.workspace.onDidChangeWorkspaceFolders((event) => {
			let folders = new Set(workspace.folders())

			for (let removed of event.removed) {
				folders.delete(documentFilePath(removed.uri))
			}

			for (let added of event.added) {
				folders.add(documentFilePath(added.uri))
			}

			workspace.setFolders([...folders])
			tags = null
			session.runAll("open")
			// A folder arriving brings files nothing analysed, and one leaving
			// takes the owners of its squiggles, so every entry runs again.
			scheduleSweep()
		})
	})

	// The Run and Debug lenses, read off the parse so they show before any run.
	// Offered with the session off too: that setting declines running on every
	// keystroke, not running when asked.
	connection.onCodeLens((params) => {
		let program = parsedOf(params.textDocument.uri)

		if (program === null) {
			return null
		}

		let filePath = documentFilePath(params.textDocument.uri)

		return findTestLenses(
			program,
			filePath,
			pendingSnapshots(filePath),
		).map((lens) => ({
			range: toLspRange(lens.position),
			command: {
				title: lens.title,
				command: lens.command,
				arguments: [lens.arguments],
			},
		}))
	})

	// The tests of this file whose last run left a new or differing snapshot
	// to accept. A file nothing has run offers none.
	function pendingSnapshots(filePath: string): ReadonlySet<string> {
		let pending = new Set<string>()

		for (let record of session.recordsFor(filePath)) {
			// `written` counts as pending, unlike on the command line: a session
			// cycle records nothing. Once accepted, the snapshot matches on the
			// next cycle and the lens goes.
			if (
				record.snapshots.some(
					(snapshot) => snapshot.status !== "matched",
				)
			) {
				pending.add(record.id)
			}
		}

		return pending
	}

	// Sent by a lens's command and by a Test Explorer. The answer is the run
	// number the notifications will carry.
	connection.onRequest(
		RUN_TESTS_REQUEST,
		(params: RunTestsParams): RunTestsResult => ({
			run: session.run({
				ids: params.ids,
				files: params.files,
				update: params.update,
			}),
		}),
	)

	// Idle when neither the window nor a sweep callback is armed. See "Waiting
	// for idle" in DEVELOPMENT.md.
	function isIdle(): boolean {
		return analysisTimer === null && sweepChunk === null
	}

	// The waiters are taken before they are told, so one that asks again waits
	// for the next quiet moment.
	function answerIdle(): void {
		if (!isIdle() || idleWaiters.length === 0) {
			return
		}

		let waiters = idleWaiters

		idleWaiters = []

		for (let waiter of waiters) {
			waiter()
		}
	}

	connection.onRequest(IDLE_REQUEST, (): null | Promise<null> => {
		if (isIdle()) {
			return null
		}

		return new Promise((resolve) => {
			idleWaiters.push(() => {
				resolve(null)
			})
		})
	})

	connection.onShutdown(() => {
		// A closing Editor schedules an analysis per closed file, and one firing
		// after the connection is gone would throw from a timer.
		if (analysisTimer !== null) {
			clearTimeout(analysisTimer)
			analysisTimer = null
		}

		// The sweep in flight goes too.
		if (sweepChunk !== null) {
			clearImmediate(sweepChunk)
			sweepChunk = null
		}

		pendingChanges.clear()
		pendingSweep = null
		sweepQueue = []
		sweepReaches = new Map()
		sweepUncovered.clear()
		sweepDropped.clear()

		// A waiter left in the list would wait for a cancelled callback.
		answerIdle()

		void session.dispose()
	})

	// A file named `essence.json`, wherever it sits. The file watcher asks the
	// narrower `isProjectFile`.
	function isProjectDocument(filePath: string): boolean {
		return path.basename(filePath) === PROJECT_FILE_NAME
	}

	// A file of this name outside `skippedDirectories`. An install rewrites
	// many manifests in `node_modules`, and the settings walk never reads there.
	function isConfigured(filePath: string, name: string): boolean {
		if (path.basename(filePath) !== name) {
			return false
		}

		return !path
			.dirname(filePath)
			.split(path.sep)
			.some((segment) => skippedDirectories.has(segment))
	}

	function isProjectFile(filePath: string): boolean {
		return isConfigured(filePath, PROJECT_FILE_NAME)
	}

	// A `package.json`, read only to report an `essence` key in it.
	function isManifest(filePath: string): boolean {
		return isConfigured(filePath, "package.json")
	}

	connection.onDidChangeWatchedFiles((params) => {
		let changed: Array<string> = []
		let projectFileChanged = false
		let manifestChanged = false

		for (let change of params.changes) {
			let filePath = documentFilePath(change.uri)

			if (isProjectFile(filePath)) {
				projectFileChanged = true

				continue
			}

			if (isManifest(filePath)) {
				manifestChanged = true

				continue
			}

			changed.push(filePath)

			if (change.type === FileChangeType.Deleted) {
				workspace.removed(filePath)
			} else {
				workspace.changed(filePath)
			}
		}

		// A project file draws the boundary every cached answer assumes, so the
		// whole project is worked out again. The sweep and the run also cover the
		// `.es` files of this notification.
		if (projectFileChanged) {
			workspace.setFolders(workspace.folders())
			tags = null
			publishConfiguration()
			session.runAll("open")
			scheduleSweep()

			return
		}

		// A manifest moves no boundary: the settings are read again to find the
		// `essence` key, and its Diagnostic is published.
		if (manifestChanged) {
			workspace.forgetConfiguration()
			publishConfiguration()
		}

		if (changed.length === 0) {
			return
		}

		tags = null
		session.changed(changed)

		// The same debounce as a keystroke, so a branch switch is one window. An
		// importer records an edge to a missing file, so a file appearing reaches
		// the root that waited for it.
		scheduleAnalysis(changed)
	})

	// The import edits a move needs so the workspace still means the same.
	// The Workspace holds the open buffer where there is one.
	connection.workspace.onWillRenameFiles((params) => {
		let rewrites = importRewrites(
			workspace,
			params.files.map((file) => ({
				oldPath: documentFilePath(file.oldUri),
				newPath: documentFilePath(file.newUri),
			})),
		)

		if (rewrites.length === 0) {
			return null
		}

		let changes: Record<string, Array<TextEdit>> = {}

		for (let rewrite of rewrites) {
			changes[uriOf(rewrite.filePath)] = rewrite.edits.map((edit) => ({
				range: toLspRange(edit.range),
				newText: edit.newText,
			}))
		}

		return { changes }
	})

	// The open document behind a request, if it is Essence source. The
	// extension forwards `essence.json` for its Diagnostics, and no request may
	// parse one as Essence.
	function sourceDocument(uri: string): TextDocument | undefined {
		let document = documents.get(uri)

		if (
			document === undefined ||
			isProjectDocument(documentFilePath(uri))
		) {
			return undefined
		}

		return document
	}

	// The Workspace's cache entry for a document at its current version.
	// Whoever asks first, request or analysis, computes it. A standard library
	// source or an unreadable buffer, which the Workspace holds nothing for, is
	// enriched alone.
	function parseAndEnrich(
		uri: string,
		options: { annotations?: boolean; cancellation?: Cancellation } = {},
	) {
		let document = sourceDocument(uri)

		if (document === undefined) {
			return null
		}

		let filePath = documentFilePath(uri)

		if (workspace.programOf(filePath) !== null) {
			anchorAtRoot(filePath, options.cancellation)

			let cached = workspace.documentOf(filePath, {
				cancellation: options.cancellation,
			})

			// Cancelled. The Workspace holds this file, so no fallback answers.
			if (cached === null) {
				return null
			}

			return {
				program: cached.program,
				enrichedProgram: cached.enrichedProgram,
				index: cached.index,
				module: cached.module,
				// Only Hover asks for these. Collecting them for a Module whose
				// analysis was anchored elsewhere costs one more link.
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
		} catch (error) {
			logInternalError(filePath, error)
		}

		return {
			program,
			enrichedProgram,
			annotations,
			index: null,
			module: null,
		}
	}

	// Logs a Compiler throw that a request answers around without the typed
	// Program. A stack's first line carries the message.
	function logInternalError(filePath: string, error: unknown): void {
		connection.console.error(
			`essence: the Compiler threw while enriching ${filePath}: ${
				error instanceof Error
					? (error.stack ?? error.message)
					: String(error)
			}`,
		)
	}

	// A request that must compile links a root above the file, the graph the
	// next window links anyway, so that window is a cache read. `rootsReaching`
	// is sorted, so the root taken does not depend on request order.
	function anchorAtRoot(filePath: string, cancellation?: Cancellation): void {
		if (workspace.isAnalysed(filePath)) {
			return
		}

		let [root] = workspace.rootsReaching([filePath])

		if (root === undefined || root === filePath) {
			return
		}

		workspace.analysisOf(root, {
			annotationsFor: filePath,
			cancellation,
		})
	}

	// Whether a request is still worth answering after its one suspension: not
	// cancelled, and its document still at the version whose Positions it named.
	async function isCurrent(
		uri: string,
		token: CancellationToken,
	): Promise<boolean> {
		let version = documents.get(uri)?.version

		await yieldToConnection()

		return !isCancelled(token) && documents.get(uri)?.version === version
	}

	// Clients treat the two codes differently. vscode-languageclient returns the
	// default for `ContentModified`. It throws for a `RequestCancelled` whose
	// token was never cancelled, which is the moved-version case.
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

	// The Parser AST alone, from the same cache the typed requests read.
	function parsedOf(uri: string): parser.Program | null {
		let document = sourceDocument(uri)

		if (document === undefined) {
			return null
		}

		return (
			workspace.programOf(documentFilePath(uri)) ??
			parseDocument(document.getText(), uri).program
		)
	}

	// The `uri` lets `findRenameableOccurrence` refuse inside a standard
	// library source.
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

	// A standard library source is refused first, as in `rename.ts`: renaming
	// there would silently break the library.
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

	// The workspace occurrence under the cursor. A Method dispatched through an
	// imported Namespace is in no local Scope, and is still what a rename means.
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

		// Refused rather than half-applied: uses of a declaration outside every
		// folder are not indexed. That covers a conformer's Method whose
		// requirement is declared outside, and the standard library.
		if (
			anchor !== null &&
			(anchor.symbol.answersBuiltin === true ||
				(folders.length > 0 &&
					[anchor.symbol.filePath, ...anchor.symbol.declaredIn].some(
						(filePath) =>
							filePath !== null &&
							!workspace.isInWorkspace(filePath),
					)))
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

		// A label may be a Keyword such as `with`. A Parameter whose name is its
		// label must be valid as both: `compute(start 1)` parses as a `start` of
		// `1`.
		let symbol = anchor?.symbol ?? occurrence!.declaration
		let kind = symbol.kind
		let isValidNewName =
			kind === "label"
				? isValidLabelName
				: symbol.labelled === true
					? isValidBindingLabelName
					: isValidIdentifierName

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
			// The request's own URI wins for its document, so the edit lands on
			// the buffer rather than on a second spelling of the path.
			let uri =
				entry.filePath === documentFilePath(params.textDocument.uri)
					? params.textDocument.uri
					: uriOf(entry.filePath)
			let edits = changes[uri]

			if (edits === undefined) {
				edits = []
				changes[uri] = edits
			}

			// `renameEdits` spells out the other half of a `{ width }` shorthand,
			// whose one Identifier names both a member and a local.
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

		// The workspace answers first: the local index stops at the import
		// entry, and the reader means the declaration in the Module writing it.
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
			sourceDocument(params.textDocument.uri)?.getText() ?? null,
			parsed.module?.imported.protocols,
		)

		if (hover === null) {
			return null
		}

		// A code fence, so the Editor highlights the signature. The
		// Documentation after the rule is Markdown as written.
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

	// Across every file, since an imported name is one symbol.
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

	// Restricted to this file, since it fires on every cursor move. A name in
	// the body still lights up the import entry that brought it in.
	connection.onDocumentHighlight(async (params, token) => {
		if (!(await isCurrent(params.textDocument.uri, token))) {
			return abandoned(token)
		}

		let symbol = workspaceSymbolAt(
			params.textDocument.uri,
			params.position,
			{ localOnly: true },
		)

		// A builtin has no workspace symbol, but highlighting it is harmless.
		// `findOccurrences` keeps each site's access.
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

	// Not debounced: it reads the analysis cache. An Editor asks on every
	// keystroke and cancels what it overtook, which `isCurrent` honours.
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

		// Restricted to what renaming accepts, so typing over `Terminal` does
		// not look like renaming a builtin.
		let occurrence = renameableOccurrenceAt(
			params.textDocument.uri,
			params.position,
		)

		if (occurrence === null) {
			return null
		}

		// Linked editing writes the same text to every range, so a site that
		// needs other text, such as the shorthand `{ width }`, rules it out.
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
			// Typing a character an Identifier cannot contain ends the
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

	// An Item's Declaration is resolved again from its uri and selectionRange.
	// Nothing is kept between the prepare and the expansion.
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

	// Entries carry their Types where enrichment succeeded. Built off the
	// Parser AST, the outline survives a Program that does not type check.
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

		return findDocumentSymbols(
			parsed.program,
			parsed.enrichedProgram,
			parsed.module?.imported.protocols,
		).map(toLspDocumentSymbol)
	})

	connection.onDocumentFormatting((params) => {
		let document = sourceDocument(params.textDocument.uri)

		if (document === undefined) {
			return null
		}

		let result = findFormattingEdits(
			document.getText(),
			params.textDocument.uri,
		)

		// An `unsafe` refusal is a formatter bug, so the reader is told. The
		// warning names the formatter, not an executable.
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

		let filePath = documentFilePath(params.textDocument.uri)

		// The one request a project file answers, ahead of `sourceDocument`,
		// which refuses it.
		if (isProjectDocument(filePath)) {
			let buffer = documents.get(params.textDocument.uri)

			return buffer === undefined
				? null
				: offered(
						projectFileActions(
							buffer.getText(),
							filePath,
							toRange(params.range),
						),
						params,
					)
		}

		let document = sourceDocument(params.textDocument.uri)

		if (document === undefined) {
			return null
		}

		// The analysis the Diagnostics were published from, so the lightbulb
		// agrees with the squiggle it is offered on.
		let analysis = workspace.analysisOf(filePath, { cancellation: token })

		// Checked, not inferred from a null: `findCodeActions` handed nothing
		// runs the pipeline itself, which a cancelled request must not do.
		if (isCancelled(token)) {
			return abandoned(token)
		}

		return offered(
			findCodeActions(
				document.getText(),
				toRange(params.range),
				params.textDocument.uri,
				workspace,
				analysis,
				tagDiagnosticsFor(filePath),
				params.context.only,
			),
			params,
		)
	})

	// The entries of the kinds the request asked for, as CodeActions. A
	// project file's lightbulb obeys the same `only` filter as a source's.
	function offered(
		entries: Array<CodeActionEntry>,
		params: CodeActionParams,
	): Array<CodeAction> {
		return entries
			.filter(
				(entry) =>
					isRequestedKind(entry.kind, params.context.only) &&
					// Withheld from a client that cannot create files: a text
					// edit cannot create the file it edits, so it would do nothing.
					(clientCreatesFiles ||
						!entry.edits.some((edit) => edit.createFile === true)),
			)
			.map((entry) =>
				toLspCodeAction(entry, params, clientSupportsDocumentChanges),
			)
	}

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

			// The protocol nests the chain outwards through `parent`.
			let range: SelectionRange | undefined

			for (let selection of chain) {
				range = { range: toLspRange(selection), parent: range }
			}

			return range ?? { range: { start: position, end: position } }
		})
	})

	// Not debounced: it reads the analysis cache.
	connection.languages.inlayHint.on(async (params, token) => {
		let uri = params.textDocument.uri

		if (!inlayHintsEnabled) {
			return null
		}

		if (!(await isCurrent(uri, token))) {
			return abandoned(token)
		}

		return inlayHintsOf(toRange(params.range), sourceDocument(uri), {
			events: session.eventsFor(documentFilePath(uri)),
			parsed: parseAndEnrich(uri, { cancellation: token }),
			spelled: !clientResolvesHintEdits,
		})
	})

	// Against the buffer the Hint was made from. A Hint without `data` has
	// nothing to spell, and one whose buffer moved keeps what it was sent.
	connection.languages.inlayHint.resolve(async (hint, token) => {
		let data = inlayHintDataOf(hint)

		if (
			data === null ||
			sourceDocument(data.uri)?.version !== data.version ||
			!(await isCurrent(data.uri, token))
		) {
			return hint
		}

		return resolveInlayHint(
			hint,
			parseAndEnrich(data.uri, { cancellation: token })?.enrichedProgram,
		)
	})

	connection.onCompletion(async (params, token) => {
		if (!(await isCurrent(params.textDocument.uri, token))) {
			return abandoned(token)
		}

		let document = sourceDocument(params.textDocument.uri)

		if (document === undefined) {
			return null
		}

		// Offers from other Modules are read off parses; the Namespace offers
		// enrich the Modules that export one. A document outside every folder
		// gets neither.
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
						specifiers: workspace.specifiersFor(filePath),
					}
				: { offers: [], namespaces: [] },
			// `findCompletions` derives an analysis itself only where this is null.
			workspace.documentOf(filePath),
			(error) => logInternalError(filePath, error),
		)

		return entries.map(toLspCompletionItem)
	})

	// Every entry is complete, computed against the buffer the request saw. A
	// second pass over a buffer that has moved on could only be wrong.
	connection.onCompletionResolve((item) => item)

	connection.onSignatureHelp(async (params, token) => {
		if (!(await isCurrent(params.textDocument.uri, token))) {
			return abandoned(token)
		}

		let document = sourceDocument(params.textDocument.uri)

		if (document === undefined) {
			return null
		}

		let filePath = documentFilePath(params.textDocument.uri)
		let help = findSignatureHelp(
			document.getText(),
			toCursor(params.position),
			params.textDocument.uri,
			workspace.documentOf(filePath),
			(error) => logInternalError(filePath, error),
		)

		if (help === null) {
			return null
		}

		// Parameters are offset ranges into the label. A text label is found by
		// searching, which picks the first of two identically printed Parameters.
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

	// Whether an entry other than `exceptPath` still reports on the URI. See
	// "Who owns a published list" in DEVELOPMENT.md.
	function claimedElsewhere(targetUri: string, exceptPath?: string): boolean {
		for (let [entryPath, published] of publishedByEntry) {
			if (entryPath !== exceptPath && published.has(targetUri)) {
				return true
			}
		}

		return false
	}

	// The open document's URI, so the Editor ties the list to its buffer, or
	// the path's URI for a file nobody has open.
	function uriFor(filePath: string): string {
		return openPaths.get(filePath) ?? uriOf(filePath)
	}

	// Sends a list only when it changed. The `version` names the buffer it was
	// computed against, so a client can drop a list that raced a keystroke.
	function publish(uri: string, diagnostics: Array<common.Diagnostic>): void {
		let sent = diagnostics.map((diagnostic) =>
			toLspDiagnostic(diagnostic, uri),
		)
		let signature = JSON.stringify(sent)

		if (publishedContent.get(uri) === signature) {
			return
		}

		publishedContent.set(uri, signature)
		// A connection that has gone away throws when closed and rejects when
		// the pipe went first. Inside an analysis callback, either would end the
		// process.
		try {
			void connection
				.sendDiagnostics({
					uri,
					version: documents.get(uri)?.version,
					diagnostics: sent,
				})
				.catch(() => {})
		} catch {}
	}

	// A URI this entry stopped reporting on is collected in `dropped`, for
	// `retireEntries` to clear. See "Who owns a published list" in DEVELOPMENT.md.
	function publishAnalysis(
		entryPath: string,
		results: Map<string, Array<common.Diagnostic>>,
		dropped: Set<string>,
	) {
		for (let [targetUri, diagnostics] of results) {
			publish(targetUri, diagnostics)
		}

		for (let staleUri of publishedByEntry.get(entryPath) ?? []) {
			if (results.has(staleUri)) {
				continue
			}

			dropped.add(staleUri)
		}

		publishedByEntry.set(entryPath, new Set(results.keys()))
	}

	// Publishes each project file's problems on that file, including a stale
	// `essence` key in a `package.json`. See "Project files" in DEVELOPMENT.md.
	function publishConfiguration(): void {
		let byUri = new Map<string, Array<common.Diagnostic>>()

		for (let problem of workspace.configurationProblems()) {
			byUri.set(
				configurationUriFor(problem.filePath),
				problem.diagnostics,
			)
		}

		for (let [filePath, uri] of openProjectFiles) {
			let document = documents.get(uri)

			if (document === undefined) {
				continue
			}

			byUri.set(
				uri,
				parseProjectConfiguration(
					document.getText(),
					filePath,
				).problems.flatMap((each) => each.diagnostics),
			)
		}

		for (let [uri, diagnostics] of byUri) {
			publish(uri, diagnostics)
		}

		// A file whose problems went away is owed an empty list.
		for (let uri of publishedConfiguration) {
			if (!byUri.has(uri)) {
				publish(uri, [])
			}
		}

		publishedConfiguration = new Set(byUri.keys())
	}

	// `uriFor` for a project file, so it is never published under two URIs.
	function configurationUriFor(filePath: string): string {
		return openProjectFiles.get(filePath) ?? uriOf(filePath)
	}

	// The entry and its transitive dependencies, read off the parses the
	// Workspace holds: what the entry's graph should cover.
	function reachOf(filePath: string): Set<string> {
		let reached = new Set<string>([filePath])
		let pending = [filePath]

		while (pending.length > 0) {
			let current = pending.shift()!

			for (let dependency of workspace.dependenciesOf(current).values()) {
				if (reached.has(dependency)) {
					continue
				}

				reached.add(dependency)
				pending.push(dependency)
			}
		}

		return reached
	}

	// Each entry's reach, walked once for both the order and the coverage check.
	function reachesOf(filePaths: Iterable<string>): Map<string, Set<string>> {
		return new Map(
			[...filePaths].map((filePath) => [filePath, reachOf(filePath)]),
		)
	}

	// The entries reaching the most files first, so an overlapping smaller
	// graph is a cache read. See "Batches" in DEVELOPMENT.md.
	function analysisOrder(reaches: Map<string, Set<string>>): Array<string> {
		return [...reaches.keys()].sort(
			(left, right) => reaches.get(right)!.size - reaches.get(left)!.size,
		)
	}

	// A file no root's graph reaches: a standard library source, or a buffer
	// outside the workspace folders. An open one is an entry of its own.
	function needsOwnEntry(filePath: string): boolean {
		return (
			!workspace.knownFiles().has(filePath) ||
			workspace.programOf(filePath) === null
		)
	}

	// The entries that cover a set of changed files. See "The debounce window"
	// in DEVELOPMENT.md.
	function entriesFor(filePaths: Array<string>): Array<string> {
		let entries = new Set(workspace.rootsReaching(filePaths))
		let changed = new Set(filePaths)
		// A sweep's queued roots have not published yet and would all look new.
		let queued = new Set(sweepQueue)

		// A root that has never published is new. The cache cannot tell, since
		// an edit drops the enrichment of its whole undirected component.
		for (let root of workspace.roots()) {
			if (!publishedByEntry.has(root) && !queued.has(root)) {
				entries.add(root)
			}
		}

		for (let filePath of openPaths.keys()) {
			if (!needsOwnEntry(filePath)) {
				continue
			}

			for (let reached of reachOf(filePath)) {
				if (changed.has(reached)) {
					entries.add(filePath)
					break
				}
			}
		}

		return [...entries]
	}

	// Every root, which between them cover every file, and every open document
	// that needs an entry of its own.
	function everyEntry(): Array<string> {
		let entries = new Set(workspace.roots())

		for (let filePath of openPaths.keys()) {
			if (needsOwnEntry(filePath)) {
				entries.add(filePath)
			}
		}

		return [...entries]
	}

	// The entries, then the fallbacks, then the hand-over, in one callback. See
	// "Batches" in DEVELOPMENT.md.
	function analyseBatch(entries: Array<string>, focus?: string): void {
		let reaches = reachesOf(entries)
		// The URIs the entries stopped reporting on, for `retireEntries`.
		let dropped = new Set<string>()
		let analysed = new Set<string>()

		for (let entryPath of analysisOrder(reaches)) {
			analyseAndPublish(entryPath, focus, dropped)
			analysed.add(entryPath)
		}

		for (let uncovered of analysisOrder(reachesOf(uncoveredBy(reaches)))) {
			// A fallback that ran earlier may have covered it.
			if (!needsOwnAnalysis(uncovered)) {
				continue
			}

			analyseAndPublish(uncovered, focus, dropped)
			analysed.add(uncovered)
		}

		// A sweep no longer owes what this batch analysed.
		if (sweepQueue.length > 0) {
			sweepQueue = sweepQueue.filter(
				(entryPath) => !analysed.has(entryPath),
			)
		}

		retireEntries(dropped)
	}

	// Queues a batch over every entry, replacing what a previous sweep left.
	// See "The workspace sweep" in DEVELOPMENT.md.
	function startSweep(focus: string | undefined): void {
		sweepReaches = reachesOf(everyEntry())
		sweepQueue = analysisOrder(sweepReaches)
		sweepUncovered = new Set()
		sweepPhase = "entries"
		sweepFocus = focus

		armSweepChunk()
	}

	// Arms the next entry of the sweep one macrotask away, after the loop has
	// read waiting requests. At most one is armed.
	function armSweepChunk(): void {
		if (sweepChunk !== null) {
			return
		}

		sweepChunk = setImmediate(() => {
			sweepChunk = null
			runSweepChunk()
		})
	}

	// One entry of the sweep, start to finish, so no compilation interleaves.
	// See "Where the Server suspends" in DEVELOPMENT.md.
	function runSweepChunk(): void {
		let entryPath = sweepQueue.shift()

		if (entryPath === undefined) {
			if (sweepPhase === "entries") {
				sweepPhase = "fallbacks"
				sweepQueue = analysisOrder(reachesOf(sweepUncovered))
				sweepReaches = new Map()
				sweepUncovered = new Set()

				armSweepChunk()

				return
			}

			// Retired once, at the end: mid-sweep, the entry taking a file over is
			// usually still queued.
			retireEntries(sweepDropped)
			sweepDropped.clear()
			sweepFocus = undefined
			publishConfiguration()
			// After the last publish. A window armed mid-sweep keeps this a no-op.
			answerIdle()

			return
		}

		if (sweepPhase === "entries") {
			analyseAndPublish(entryPath, sweepFocus, sweepDropped)

			// Collected now and analysed once every entry has run, since a later
			// root may read what this one could not.
			for (let filePath of uncoveredIn(
				sweepReaches.get(entryPath) ?? [],
			)) {
				sweepUncovered.add(filePath)
			}
		} else if (needsOwnAnalysis(entryPath)) {
			// A later entry or a change batch may have covered it since it was
			// queued.
			analyseAndPublish(entryPath, sweepFocus, sweepDropped)
		}

		armSweepChunk()
	}

	// The files these entries should have judged and did not: the fallbacks.
	// See "Batches" in DEVELOPMENT.md.
	function uncoveredBy(reaches: Map<string, Set<string>>): Array<string> {
		let uncovered = new Set<string>()

		for (let reached of reaches.values()) {
			for (let filePath of uncoveredIn(reached)) {
				uncovered.add(filePath)
			}
		}

		return [...uncovered]
	}

	// The same question about one entry's reach. It reads the cache, so it is
	// only true right after the entry ran. A file the Workspace cannot read is
	// left out: there is no text to judge.
	function uncoveredIn(reached: Iterable<string>): Array<string> {
		let uncovered: Array<string> = []

		for (let filePath of reached) {
			if (
				!needsOwnAnalysis(filePath) ||
				workspace.programOf(filePath) === null
			) {
				continue
			}

			uncovered.push(filePath)
		}

		return uncovered
	}

	// Whether a file needs its own entry: nothing judged it, or it writes
	// neither Module section. The second holds even when cached, since only its
	// own entry publishes its list.
	function needsOwnAnalysis(filePath: string): boolean {
		return (
			!workspace.isAnalysed(filePath) || !workspace.isModuleFile(filePath)
		)
	}

	// Retires the entries that stopped being entries and clears what nobody
	// claims, after every analysis has published. See "Who owns a published
	// list" in DEVELOPMENT.md.
	function retireEntries(dropped: Set<string>): void {
		let roots = new Set(workspace.roots())
		let retiring = new Set<string>()

		for (let entryPath of publishedByEntry.keys()) {
			// A current root, or an open document no root reaches, stays.
			if (
				roots.has(entryPath) ||
				(openPaths.has(entryPath) && needsOwnEntry(entryPath))
			) {
				continue
			}

			if (
				claimedElsewhere(uriFor(entryPath), entryPath) ||
				!workspace.knownFiles().has(entryPath) ||
				workspace.programOf(entryPath) === null
			) {
				retiring.add(entryPath)
			}
		}

		let orphaned = new Set(dropped)

		// Every retirement is recorded before anything is cleared, so two
		// entries owning each other's URIs do not each count on the other.
		for (let entryPath of retiring) {
			for (let targetUri of publishedByEntry.get(entryPath) ?? []) {
				orphaned.add(targetUri)
			}

			publishedByEntry.delete(entryPath)
		}

		// Mid-sweep, the new owner of an orphan may still be queued, so the
		// sweep decides at its end.
		if (sweepChunk !== null) {
			for (let targetUri of orphaned) {
				sweepDropped.add(targetUri)
			}

			return
		}

		for (let targetUri of orphaned) {
			if (claimedElsewhere(targetUri)) {
				continue
			}

			publish(targetUri, [])
		}
	}

	// Records changed files for the next window, which works out the entries.
	function scheduleAnalysis(filePaths: Iterable<string>, focus?: string) {
		let deadline = Date.now() + analysisDebounceInMilliseconds

		for (let filePath of filePaths) {
			pendingChanges.set(filePath, deadline)
		}

		if (focus !== undefined) {
			analysisFocus = focus
		}

		armAnalysis()
	}

	// Asks the next window for a sweep over every entry.
	function scheduleSweep() {
		pendingSweep = Date.now() + analysisDebounceInMilliseconds
		armAnalysis()
	}

	// Arms the one timer for the earliest deadline; everything pending runs
	// together. See "The debounce window" in DEVELOPMENT.md.
	function armAnalysis() {
		if (analysisTimer !== null) {
			clearTimeout(analysisTimer)
			analysisTimer = null
		}

		if (pendingChanges.size === 0 && pendingSweep === null) {
			return
		}

		let due = pendingSweep ?? Infinity

		for (let deadline of pendingChanges.values()) {
			due = Math.min(due, deadline)
		}

		analysisTimer = setTimeout(
			() => {
				analysisTimer = null

				let focus = analysisFocus ?? undefined
				let changed = [...pendingChanges.keys()]
				let sweeping = pendingSweep !== null

				pendingChanges.clear()
				pendingSweep = null
				analysisFocus = null

				// A sweep covers every changed file too.
				if (sweeping) {
					startSweep(focus)
				} else {
					analyseBatch(entriesFor(changed), focus)
				}

				// A no-op after arming a sweep, which answers when it drains.
				answerIdle()
			},
			Math.max(0, due - Date.now()),
		)
	}

	function analyseAndPublish(
		filePath: string,
		focus: string | undefined,
		dropped: Set<string>,
	) {
		// Through the Workspace, so the analysis fills the cache every request
		// reads, for every Module of the graph.
		let uri = openPaths.get(filePath)
		let document = uri === undefined ? undefined : documents.get(uri)
		let analysis = workspace.analysisOf(filePath, { annotationsFor: focus })

		// The Workspace holds nothing for a standard library source or an
		// unreadable path. An open one is analysed alone; a closed one has nothing
		// to say.
		if (analysis === null) {
			if (uri === undefined || document === undefined) {
				return
			}

			analysis = analyseDocument(document.getText(), uri, {
				host: workspace.host,
				// As in the Workspace, the `tests` block is typed too.
				tests: true,
			})
		}

		// Every file's list under its own URI, dependencies included. See "The
		// analysis loop" in DEVELOPMENT.md.
		let results = new Map<string, Array<common.Diagnostic>>([
			[
				uriFor(filePath),
				[...analysis.diagnostics, ...testDiagnosticsFor(filePath)],
			],
		])

		for (let [dependencyPath, diagnostics] of analysis.dependencies) {
			// A dependency writing neither Module section publishes from its own
			// entry; the graph's list for it is a second opinion.
			if (!workspace.isModuleFile(dependencyPath)) {
				continue
			}

			results.set(uriFor(dependencyPath), [
				...diagnostics,
				...testDiagnosticsFor(dependencyPath),
			])
		}

		publishAnalysis(filePath, results, dropped)
	}

	// `onDidChangeContent` also fires when a document is opened.
	documents.onDidChangeContent((event) => {
		let filePath = documentFilePath(event.document.uri)

		// A project file is kept out of `openPaths` and reported on per
		// keystroke. See "Project files" in DEVELOPMENT.md.
		if (isProjectDocument(filePath)) {
			openProjectFiles.set(filePath, event.document.uri)
			publishConfiguration()

			return
		}

		openPaths.set(filePath, event.document.uri)
		workspace.changed(filePath)
		tags = null
		scheduleAnalysis([filePath], filePath)
		// The session runs on the unsaved buffer, as the analysis does.
		session.changed([filePath])
	})

	documents.onDidClose((event) => {
		let filePath = documentFilePath(event.document.uri)

		// The file on disk answers for a closed project file again.
		if (openProjectFiles.delete(filePath)) {
			publishConfiguration()

			return
		}

		openPaths.delete(filePath)
		// What the Workspace held came from the buffer; the file is the truth
		// again.
		workspace.changed(filePath)

		// Nothing is cleared; the roots reaching the file run again against the
		// disk. A closed document no root reaches is retired by the same batch.
		scheduleAnalysis([filePath])
	})

	documents.listen(connection)
	connection.listen()
}

// Where an unspelled Type Hint was made, which its resolve reads back.
type InlayHintData = { uri: string; version: number }

// A client hands `data` back as it pleases, so its shape is checked.
function inlayHintDataOf(hint: InlayHint): InlayHintData | null {
	let data: unknown = hint.data

	if (data == null || typeof data !== "object") {
		return null
	}

	let { uri, version } = data as Partial<InlayHintData>

	return typeof uri === "string" && typeof version === "number"
		? { uri, version }
		: null
}

// The Type Hints of a range and the values the last test run recorded there.
// An unspelled request leaves each Type Hint's edit to `resolveInlayHint`.
function inlayHintsOf(
	range: common.Position,
	document: TextDocument | undefined,
	sources: {
		events: Array<TestEvent>
		parsed: { enrichedProgram: common.typed.Program | null } | null
		spelled: boolean
	},
): Array<InlayHint> {
	if (document === undefined) {
		return []
	}

	let data: InlayHintData = { uri: document.uri, version: document.version }
	let program = sources.parsed?.enrichedProgram

	return [
		...(program == null
			? []
			: findInlayHints(program, range, sources.spelled)),
		...findValueHints(sources.events, document.getText(), range),
	].map((hint) => toLspInlayHint(hint, data))
}

// Finds the Hint again on its own line, which spells that line only, and
// takes its edit. A Hint the Program no longer makes keeps none.
export function resolveInlayHint(
	hint: InlayHint,
	program: common.typed.Program | null | undefined,
): InlayHint {
	if (program == null) {
		return hint
	}

	let cursor = toCursor(hint.position)
	let spelled = findInlayHints(program, { start: cursor, end: cursor }).find(
		(entry) =>
			entry.position.line === cursor.line &&
			entry.position.column === cursor.column &&
			entry.label === hint.label,
	)
	let textEdits =
		spelled === undefined ? undefined : toLspInlayHint(spelled).textEdits

	return textEdits === undefined ? hint : { ...hint, textEdits }
}

// A Type Hint carries the edit that writes it, an insertion at an empty
// Range, and before it any label a Function literal's Parameter needs. An
// unspelled one carries `data` instead. A value Hint records one run and has
// nothing to accept, so it is a Parameter Hint, which Editors draw quietly.
export function toLspInlayHint(
	hint: InlayHintEntry,
	data: InlayHintData | null = null,
): InlayHint {
	let position = {
		line: hint.position.line - 1,
		character: hint.position.column - 1,
	}

	if (hint.kind === "value") {
		return {
			position,
			label: hint.label,
			kind: InlayHintKind.Parameter,
			paddingLeft: true,
		}
	}

	return {
		position,
		label: hint.label,
		kind: InlayHintKind.Type,
		...(hint.textEdit === null
			? {}
			: { textEdits: inlayHintEditsOf(hint.textEdit) }),
		...(hint.unspelled === true && data !== null ? { data } : {}),
	}
}

function inlayHintEditsOf(edit: InlayHintEdit): Array<TextEdit> {
	let insertion = {
		line: edit.position.line - 1,
		character: edit.position.column - 1,
	}

	return [
		...(edit.labelEdit === undefined
			? []
			: [
					{
						range: toLspRange(edit.labelEdit.range),
						newText: edit.labelEdit.newText,
					},
				]),
		{ range: { start: insertion, end: insertion }, newText: edit.newText },
	]
}

// The inverse of `documentFilePath`. Each segment is encoded on its own, so
// the separators survive and `a b.es` becomes `a%20b.es`.
export function uriOf(filePath: string): string {
	return `file://${filePath.split("/").map(encodeURIComponent).join("/")}`
}

// The outline's kinds, so the outline and the symbol search agree.
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
	test: SymbolKind.Event,
	suite: SymbolKind.Module,
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

// An identity, whose Record Type requires a row for every kind. The list in
// `serverCapabilities` must hold the same kinds, or an Editor never asks.
const codeActionKinds: Record<CodeActionEntry["kind"], CodeActionKind> = {
	quickfix: CodeActionKind.QuickFix,
	"refactor.rewrite": CodeActionKind.RefactorRewrite,
	"refactor.extract": CodeActionKind.RefactorExtract,
	"refactor.inline": CodeActionKind.RefactorInline,
	"refactor.move": CodeActionKind.RefactorMove,
	"source.organizeImports": CodeActionKind.SourceOrganizeImports,
}

// The client's Diagnostics serve only attribution, matched by code and
// overlapping range, so the Editor ties the fix to its squiggle.
export function toLspCodeAction(
	entry: CodeActionEntry,
	params: CodeActionParams,
	// False answers with `changes`, which every client takes. True by default
	// for the specs, which assert on the richer shape.
	documentChanges = true,
): CodeAction {
	let position = entry.diagnosticPosition

	return {
		title: entry.title,
		kind: codeActionKinds[entry.kind],
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
		edit: workspaceEditOf(entry, params, documentChanges),
		// Runs in the Editor after the edits land, as when an extraction opens
		// rename on the name it invented.
		command: entry.command,
	}
}

// `changes`, unless the action creates a file: only `documentChanges` carries
// a create operation. Then every edit goes that way, creations first, so a
// file exists before its edits apply.
function workspaceEditOf(
	entry: CodeActionEntry,
	params: CodeActionParams,
	documentChanges: boolean,
): WorkspaceEdit {
	let changes = changesOf(entry, params)
	let created = entry.edits.filter((edit) => edit.createFile === true)

	// `offered` already withheld a file-creating action from a client without
	// `documentChanges`.
	if (created.length === 0 || !documentChanges) {
		return { changes }
	}

	return {
		documentChanges: [
			...created.map((edit) => ({
				kind: "create" as const,
				uri: uriOf(edit.filePath as string),
			})),
			...Object.entries(changes).map(([uri, edits]) => ({
				// Null: a created file has no version, and naming one for the
				// others would refuse the whole edit if any changed meanwhile.
				textDocument: { uri, version: null },
				edits,
			})),
		],
	}
}

// One key per file, since a move edits two Modules. The request's own URI
// wins for its document, as in `onRenameRequest`, so edits land on the buffer.
function changesOf(
	entry: CodeActionEntry,
	params: CodeActionParams,
): Record<string, Array<TextEdit>> {
	let changes: Record<string, Array<TextEdit>> = {}

	for (let edit of entry.edits) {
		let uri =
			edit.filePath === undefined ||
			edit.filePath === documentFilePath(params.textDocument.uri)
				? params.textDocument.uri
				: uriOf(edit.filePath)
		let edits = changes[uri]

		if (edits === undefined) {
			edits = []
			changes[uri] = edits
		}

		edits.push({ range: toLspRange(edit.range), newText: edit.newText })
	}

	return changes
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
	module: CompletionItemKind.File,
	snippet: CompletionItemKind.Snippet,
}

// The kinds that are invoked. An entry whose signature resolved carries its
// call as a snippet; for one that did not, bare parentheses are inserted.
const callableKinds = new Set<CompletionKind>([
	"function",
	"method",
	"staticMethod",
])

export function toLspCompletionItem(entry: CompletionEntry): CompletionItem {
	let callable = entry.snippet != null
	let fallback = !callable && callableKinds.has(entry.kind)
	let insertText = callable
		? entry.snippet
		: fallback
			? `${escapeSnippet(entry.label)}($0)`
			: (entry.insertText ?? null)

	return {
		label: entry.label,
		kind: completionItemKinds[entry.kind],
		detail: entry.detail ?? undefined,
		documentation: toMarkdown(entry.documentation ?? null),
		// Overloads share a label to filter on; `labelDetails` tells them apart.
		labelDetails:
			entry.labelDetail == null
				? undefined
				: { detail: ` ${entry.labelDetail}` },
		filterText: entry.label,
		sortText: `${entry.tier}${entry.label}`,
		preselect: entry.preselect === true ? true : undefined,
		// The fallback's label is escaped too: `$` is an Identifier character,
		// and `we$rd` would read as the snippet variable `$rd`. An entry naming
		// what it replaces becomes a text edit, the one form with a range.
		insertText:
			insertText === null || entry.replaces !== undefined
				? undefined
				: insertText,
		textEdit:
			entry.replaces === undefined
				? undefined
				: {
						range: toLspRange(entry.replaces),
						newText: insertText ?? entry.label,
					},
		insertTextFormat:
			insertText === null ? undefined : InsertTextFormat.Snippet,
		// A snippet's parentheses are never typed, so Signature Help is
		// triggered explicitly.
		command:
			callable || fallback
				? {
						title: "Trigger parameter hints",
						command: "editor.action.triggerParameterHints",
					}
				: undefined,
		// The `import { … }` entry that makes the name resolve, applied in
		// the same undo step as the insertion at the cursor.
		additionalTextEdits: entry.additionalEdits?.map((edit) => ({
			range: toLspRange(edit.range),
			newText: edit.newText,
		})),
	}
}
