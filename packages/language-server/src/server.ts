import { pathToFileURL } from "node:url"

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
import { findFoldingRanges } from "./foldingRanges"
import { findFormattingEdits } from "./formatting"
import { findHover } from "./hover"
import { findInlayHints, type InlayHint as InlayHintEntry } from "./inlayHints"
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

// NOTE: One turn of the event loop before a request does anything expensive,
// and it is what makes a Cancellation observable at all: `$/cancelRequest` is a
// message on the same connection, and a handler that runs straight through from
// the moment it is called reads its token before that message was ever read off
// the socket. A macrotask, deliberately — a microtask runs before any I/O, so
// yielding to one would prove nothing.
//
// This is the only place a REQUEST suspends. Every stage of the Compiler
// collects its Diagnostics into module level state, which is safe exactly as
// long as no two collections interleave: a handler may suspend BEFORE it starts
// compiling and never inside. The debounced analysis is a timer callback that
// runs to completion, so it can not interleave either.
//
// The workspace sweep suspends as well, and for the same reason this does: it
// analyses one root per callback and hands the loop back between two of them
// (see `armSweepChunk`), so a request that arrives during it waits for the root
// being analysed rather than for the whole project. Between two roots and never
// inside one — whole analyses interleave with whole handlers, which is exactly
// what the collector allows.
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
	// NOTE: Run and Debug above every `test` and every `suite`. No resolve: a
	// lens carries its command and its arguments already, because what it needs
	// is the ids of the tests under it and those are read off the same parse the
	// lens itself was.
	codeLensProvider: { resolveProvider: false },
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
	// NOTE: ONE timer for every file waiting to be analysed, rather than one
	// each, so that a burst of keystrokes and a branch switch that touched forty
	// files both come out as a single window — and inside that window the
	// entries are analysed in an order that makes their graphs overlap instead
	// of repeat (see `analysisOrder`).
	//
	// The DEADLINE is per file all the same, and the timer is armed for the
	// earliest of them. One timer that every keystroke restarts is a file that
	// never gets analysed while another one is being typed in: at one keystroke
	// per debounce, which is ordinary typing, the file the reader is not in
	// waits for them to stop, and nothing bounds how long that is.
	//
	// NOTE: What is pending is the file that CHANGED, not the analysis that will
	// cover it — the unit of analysis is a ROOT of the workspace's dependency
	// graph, and which roots reach a changed file is worked out when the window
	// fires. That walk reads the entries of every file whose text moved, which
	// means parsing them, and a parse per keystroke is the cost this whole cache
	// exists to remove.
	let pendingChanges = new Map<string, number>()
	// NOTE: The deadline of a whole-workspace sweep — every root rather than the
	// ones reaching a change. Null when none is waiting. It has no file of its
	// own to be pending for, because what it covers is not a change: it is the
	// answer to "what does this project say", asked at startup and whenever the
	// set of folders moves.
	let pendingSweep: number | null = null
	let analysisTimer: ReturnType<typeof setTimeout> | null = null
	// NOTE: What a sweep that has STARTED still owes, biggest graph first — one
	// entry per callback rather than every root inside one. A project shaped like
	// forty test files over one library is forty roots and therefore forty links,
	// and the count is inherent: each of those files is a graph of its own. What
	// is not inherent is doing them all without letting go — every request the
	// Editor sends while that ran waited for the last of them, and the first
	// thing an Editor does with a workspace it just opened is ask about the
	// document it restored.
	//
	// So the queue is drained a root at a time (see `armSweepChunk`), and what
	// a Hover arriving mid-sweep waits for is one more root rather than all of
	// them.
	let sweepQueue: Array<string> = []
	// NOTE: What the queued entries are expected to cover, walked once when the
	// queue is built — the order the queue runs in is read off it, and so is the
	// coverage each entry is asked about the moment it has run.
	let sweepReaches = new Map<string, Set<string>>()
	// NOTE: Which half of the sweep the queue is holding: its entries, or the
	// files those entries were supposed to judge and did not. The second half
	// RUNS once the first has drained, exactly as `analyseBatch` runs its
	// fallbacks once every entry of a batch has — a file one root could not read
	// is often one the root beside it can, and the root beside it is still
	// queued. A fallback per entry instead would publish an entry's worth of
	// second opinions about files the entry after it settles, and the sweep would
	// cost more than the single callback it replaced, which is the one thing this
	// may not do.
	//
	// WHICH files they are is a different question and is asked earlier, entry by
	// entry — see `sweepUncovered`.
	let sweepPhase: "entries" | "fallbacks" = "entries"
	// NOTE: What the queue's entries were supposed to judge and did not, each of
	// them recorded by the callback of the entry that was supposed to — see
	// `uncoveredIn` for why it can not be asked at the end.
	let sweepUncovered = new Set<string>()
	// NOTE: The URIs the sweep's entries have stopped reporting on, held until
	// the queue is empty — the same rule `analyseBatch` follows, over a batch
	// that now spans callbacks. Deliberately not cleared when a sweep REPLACES
	// another: what the abandoned one let go is still owed a clear, and the queue
	// taking over is what will finally give it one.
	let sweepDropped = new Set<string>()
	// NOTE: The focus the sweep started with, carried by every one of its
	// callbacks. A batch collects the annotations of ONE Module and a root once
	// analysed is never re-linked to collect them again, so the file a keystroke
	// landed in has to be named to the whole queue or to none of it.
	let sweepFocus: string | undefined
	let sweepChunk: ReturnType<typeof setImmediate> | null = null
	// NOTE: The file the last keystroke landed in, which is the one a Hover is
	// about to be asked over — see `annotationsFor`. Deliberately not the first
	// entry of `pendingChanges`: that is whichever file opened the window, so a
	// burst crossing files would collect the annotations for the file the reader
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
		// NOTE: The Editor types the `tests { … }` section. A build drops it, so
		// nothing else would ever tell a writer that an assertion is not a
		// Boolean or that a name inside a test body does not exist — an editor
		// that says nothing about a section is an editor claiming it is
		// correct. Running the tests is a different question, and a session
		// that compiles and instruments them is still a Workspace of its own.
		tests: true,
	})
	// NOTE: Which URIs this Server has published Diagnostics to, by the ENTRY
	// whose analysis produced them — a root of the workspace's dependency graph,
	// a file analysed on its own because the root above it could not be read, or
	// an open document no root will ever reach. Keyed by canonical path rather
	// than by URI, since most entries are files nothing has open and so have no
	// document URI to be named by.
	//
	// Publishing a file's Diagnostics means owning them: nothing else will clear
	// a squiggle in a file nobody has open, so a URI that drops out of an
	// analysis is sent an explicitly empty set — unless another entry still
	// reports on it.
	let publishedByEntry = new Map<string, Set<string>>()
	// NOTE: The list each URI was last SENT, so an unchanged one is not sent
	// again. Kept by URI rather than by entry because two roots can both reach
	// one dependency, and what the client holds for it is one list.
	let publishedContent = new Map<string, string>()
	// NOTE: Whether Type Hints are served — the client's
	// `essence.inlayHints.enabled`. True until a client says otherwise, so an
	// editor that answers no configuration requests keeps the Hints it always
	// had.
	let inlayHintsEnabled = true
	let clientSupportsConfiguration = false
	// NOTE: The live test session. It compiles and runs in a Worker of its own,
	// so everything the Server does with it is bookkeeping: which files changed,
	// what to publish, what to draw. Off by a setting, because running a
	// project's tests on every keystroke is a thing a reader must be able to
	// decline.
	let session = createTestSession({
		testFiles,
		dependentsOf: (filePath) => workspace.dependentsOf(filePath),
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
			// NOTE: A connection that has gone away THROWS rather than
			// rejecting, and a run finishing after an Editor closed is an
			// ordinary end to a session rather than a failure — so the throw is
			// swallowed here, where the alternative is an unhandled error that
			// takes the rest of the shutdown with it.
			try {
				void connection
					.sendNotification(TEST_RUN_NOTIFICATION, notification)
					.catch(() => {})
			} catch {}
		},
		// NOTE: New results mean new `test-failed` Diagnostics, and those are
		// published BESIDE the analysis's own — one list per URI is what the
		// protocol has, so the two are merged where the analysis publishes.
		//
		// NOTE: Through the entries that report on those files rather than
		// through the files themselves, because that is who owns their URIs.
		// The analyses are cache reads whenever nothing is pending — a run
		// finishing moves no source — and misses whenever this lands inside a
		// window a keystroke opened, since that keystroke dropped the whole
		// component's enrichment.
		//
		// NOTE: With the focus the Server is holding, for that second case: an
		// entry analysed without it collects the annotations of the wrong
		// Module, and a root once analysed is never re-linked to collect them
		// again — the Hover the reader is about to ask for would pay for a link
		// of its own.
		onResults: (filePaths) => {
			analyseBatch(entriesFor([...filePaths]), analysisFocus ?? undefined)

			connection.languages.inlayHint.refresh().catch(() => {})
		},
		onProblem: (filePath, problem) => {
			connection.console.log(
				`essence: the test session could not run ${filePath}: ${problem}`,
			)
		},
		// NOTE: An accepted snapshot is applied as an EDIT rather than written
		// to disk: the run compiled whatever the buffer says, and a buffer with
		// unsaved work in it would be overwritten by a write. The whole
		// document is replaced, because what the Formatter answered with is a
		// whole file.
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

	// NOTE: A range that covers whatever the document holds. An open one is
	// measured; one nothing has opened is replaced from its start to a line
	// number nothing can exceed, which is what the protocol says a client must
	// clamp.
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

	// NOTE: Every file of the workspace that WROTE a `tests { … }` block, read
	// off the parses the Workspace already holds. A file is an entry because of
	// what it says rather than because of what it is called: `Foo.tests.es` is a
	// convention and a section is the fact.
	function testFiles(): Array<string> {
		return [...workspace.knownFiles()].filter(
			(filePath) => workspace.programOf(filePath)?.tests != null,
		)
	}

	// NOTE: What the tags of the WHOLE workspace say about each other, which no
	// compile can answer: `tagged netwrok` is well-formed inside its own Module.
	// Recomputed when a file changes and cached in between, because it is asked
	// once per publish and once per lightbulb.
	let tags: Map<string, Array<common.Diagnostic>> | null = null

	function tagDiagnosticsFor(filePath: string): Array<common.Diagnostic> {
		// NOTE: Gated on the setting although it runs nothing, because it walks
		// every parse in the workspace to answer — and a reader who declined
		// the live session declined the Server going through the project on its
		// own account.
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

	// NOTE: Everything the test session has to say about a file: the failed
	// assertions of its last run, and what its tags say about the workspace's.
	// Published BESIDE the analysis's own Diagnostics, because the protocol has
	// one list per URI and the second sender would otherwise clear the first.
	//
	// NOTE: Not gated on the setting, unlike the tags below. What a session
	// that is switched off holds is nothing — being switched off empties it —
	// so the only failures here are the ones a run somebody ASKED for found,
	// and hiding those would be hiding the answer to the question.
	function testDiagnosticsFor(filePath: string): Array<common.Diagnostic> {
		let program = workspace.programOf(filePath)

		return [
			...session.diagnosticsFor(filePath),
			// NOTE: Ungated, unlike the tags: what a `focused` does is refuse a
			// plain run at the command line, and a reader who switched the live
			// session off still wants to be told before that happens. It costs
			// a walk of one parse the workspace is holding anyway.
			...(program === null ? [] : focusDiagnostics(program)),
			...tagDiagnosticsFor(filePath),
		]
	}

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

			// NOTE: The live test session, which a reader must be able to
			// decline: it compiles and runs a project's tests on every edit,
			// and a project where that is too much work is a project where
			// this has to be off rather than merely quiet. The whole section
			// is pulled at once — four settings that are one decision, and
			// four round trips to answer it would be four.
			let readTestSettings = () =>
				connection.workspace
					.getConfiguration("essence.tests")
					.then((tests: TestSettings | null | undefined) => {
						session.setSkipTags(
							Array.isArray(tests?.skipTags)
								? tests.skipTags.filter(
										(tag) => typeof tag === "string",
									)
								: [],
						)

						if (typeof tests?.debounce === "number") {
							session.setDebounce(tests.debounce)
						}

						// NOTE: Off unless it was asked for. Counting what a
						// run reached compiles a different bundle and makes
						// the Program do more work on every keystroke, so it
						// is the reader who decides it is worth that.
						session.setCoverage(tests?.coverage === true)

						// NOTE: Last, so that a session being switched ON runs
						// with the tags and the delay it was just told about
						// rather than with the ones it started with.
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

		// NOTE: Started once the client has finished initialising, rather than
		// in `onInitialize`: the first thing it does is walk the workspace for
		// files that write tests, and a client is entitled to a prompt answer
		// to its initialize request.
		session.runAll("open")

		// NOTE: The whole project, analysed from the files nothing imports, so
		// that the Problems panel lists what the workspace holds rather than
		// what happens to be open. Debounced like everything else, so a client
		// that opens six documents on restore pays for one window rather than
		// seven.
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
			// NOTE: A folder arriving brings a project's worth of files nothing
			// has ever analysed, and a folder leaving takes the owners of every
			// squiggle in it — both are answered by working the roots out again
			// from scratch.
			scheduleSweep()
		})
	})

	// NOTE: The Run and Debug lenses. Read off the PARSE — nothing has to have
	// run for a test to be worth offering to run — so a file opened in a
	// session that is still starting up already carries them.
	//
	// NOTE: Offered while the session is switched off, too. What that setting
	// declines is compiling and running a project on every keystroke; pressing
	// Run is the gesture it promises to keep, and a Run lens is where a reader
	// presses it.
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

	// NOTE: The tests of this file whose last run left a snapshot to accept —
	// one nothing had recorded, or one that differs from what was stored. It is
	// read off the session's own records, so a file nothing has run yet offers
	// no such lens, which is right: there is nothing to accept.
	function pendingSnapshots(filePath: string): ReadonlySet<string> {
		let pending = new Set<string>()

		for (let record of session.recordsFor(filePath)) {
			// NOTE: `written` counts as pending here, and it does not on the
			// command line: an ordinary cycle of the session records NOTHING,
			// so a snapshot nothing had stored is one the reader still has to
			// accept. A cycle that DID record re-runs what it recorded, so
			// what was accepted reports as matched on the cycle after and the
			// lens goes.
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

	// NOTE: What a lens's command ends up sending, and what a Test Explorer's
	// run button sends. It answers with the run number the notifications will
	// carry, so a client can tie what it asked for to what arrives.
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

	connection.onShutdown(() => {
		// NOTE: The window goes with the client. An analysis is scheduled for
		// every file a closing Editor hands back to disk, and one that fires
		// after the connection is gone publishes into nothing — a throw out of a
		// timer callback is the process.
		if (analysisTimer !== null) {
			clearTimeout(analysisTimer)
			analysisTimer = null
		}

		// NOTE: And the sweep in flight with it. It is a queue rather than one
		// callback now, so a shutdown that lands in the middle of one has a
		// callback armed and a project's worth of roots still to publish for a
		// client that has gone.
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

		void session.dispose()
	})

	connection.onDidChangeWatchedFiles((params) => {
		let changed: Array<string> = []

		for (let change of params.changes) {
			let filePath = documentFilePath(change.uri)

			changed.push(filePath)

			if (change.type === FileChangeType.Deleted) {
				workspace.removed(filePath)
			} else {
				workspace.changed(filePath)
			}
		}

		tags = null
		session.changed(changed)

		// NOTE: A file changing on disk changes the graphs it sits in, and an
		// analysis is the only thing that ever publishes: the Diagnostics an
		// entry owns for a file beneath it are cleared by that entry being
		// analysed again, which no keystroke is going to ask for.
		//
		// The roots REACHING what changed, rather than every root, and that
		// covers a file that did not exist a moment ago as well: the importer
		// waiting for it recorded an edge to it by the specifier it wrote, while
		// the file was still missing, so the walk finds that importer's root the
		// moment the file appears.
		//
		// NOTE: N files changed is not N analyses. They go through the same
		// debounce every keystroke does, so a checkout switching branches under
		// the Editor coalesces into one window — and inside it one root's
		// analysis fills the cache for every Module of its graph, which the
		// roots beside it then read.
		scheduleAnalysis(changed)
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
			anchorAtRoot(filePath, options.cancellation)

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

	// NOTE: A request that has to compile pays for the graph the WINDOW behind it
	// is going to link anyway, rather than for the smaller one this document
	// would need on its own. Both would be paid: the Editor asks for Semantic
	// Tokens, Code Actions and a Hover inside the same 200 ms in which the
	// analysis of the root above this file is already due, and the root's graph
	// holds this document — so the document's own link is work that the link
	// after it repeats. Anchored here, the window that follows is a cache read.
	//
	// Only when this file's own analysis is NOT cached, which is the only case
	// where a request was going to compile at all — a Hover in a settled
	// workspace still costs nothing. Any root reaching the file will do, since
	// each of their graphs holds it, and the first is taken: `rootsReaching` is
	// sorted, so which one that is does not depend on the order the Editor
	// happened to ask in.
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

	// NOTE: Whether a request is still worth answering, checked after the one
	// suspension a REQUEST makes (see `yieldToConnection`, which the workspace
	// sweep suspends beside it — between two roots and never inside one, which
	// is why the two of them can be in flight at once). Two ways it stops being
	// worth answering: the Editor cancelled it, or the document moved on. A
	// request is answered on the version it named or not at all — its Positions
	// belong to that version, and an answer measured against a later one points
	// at whatever moved into their place.
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
			// that was found. The two shorthands are not: `{ width }` names
			// two things with ONE Identifier — a Pattern's binds the Record's
			// member and a local, a Record Literal's writes the member and
			// reads a value — so renaming either end has to spell the other out
			// beside it. `renameEdits` is where that is decided, once, for
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
			documents.get(params.textDocument.uri)?.getText() ?? null,
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
			tagDiagnosticsFor(documentFilePath(params.textDocument.uri)),
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

		let range = {
			start: toCursor(params.range.start),
			end: toCursor(params.range.end),
		}
		let document = documents.get(params.textDocument.uri)
		// NOTE: What the last run RECORDED, beside the Types the source left
		// out. Two kinds of ghost text with two sources: one is read off the
		// typed Program and is true of the code, the other is read off the
		// events and is true of one run.
		let values =
			document === undefined
				? []
				: findValueHints(
						session.eventsFor(
							documentFilePath(params.textDocument.uri),
						),
						document.getText(),
						range,
					)
		let parsed = parseAndEnrich(params.textDocument.uri, {
			cancellation: token,
		})

		if (parsed?.enrichedProgram == null) {
			return values.map(toLspInlayHint)
		}

		return [
			...findInlayHints(parsed.enrichedProgram, range),
			...values,
		].map(toLspInlayHint)
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
						specifiers: workspace.specifiersFor(filePath),
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

	// NOTE: A URI is cleared only once NO other entry's analysis still reports
	// on it. Two roots whose graphs both reach one broken Module both publish
	// its Diagnostics, and retiring one of them must not wipe the squiggles the
	// other is still answering for. Asked without an exception too, for a URI
	// whose owner has just gone: nobody left is what makes it clearable.
	function claimedElsewhere(targetUri: string, exceptPath?: string): boolean {
		for (let [entryPath, published] of publishedByEntry) {
			if (entryPath !== exceptPath && published.has(targetUri)) {
				return true
			}
		}

		return false
	}

	// NOTE: Where a file's Diagnostics go: the document's own URI while
	// something has it open, so the Editor ties them to the buffer it is
	// showing, and the path's own URI otherwise — which is what makes a mistake
	// in a file nobody opened visible in the Problems panel at all.
	function uriFor(filePath: string): string {
		return openPaths.get(filePath) ?? uriOf(filePath)
	}

	// NOTE: Only what CHANGED goes over the wire. Refreshing a file whose
	// meaning moved is the point of analysing the root above it; re-sending it
	// the same list it already has is a message and a client-side rebuild for a
	// file the reader is not even in, and a workspace-wide analysis produces one
	// of those per file it holds.
	//
	// NOTE: The `version` is the buffer the list was computed against, which is
	// what lets a client throw away a publish that raced a keystroke — the one
	// window a debounce widens. Absent for a file nobody has open: there is no
	// version to name, and its content came off disk.
	function publish(uri: string, diagnostics: Array<common.Diagnostic>): void {
		let sent = diagnostics.map((diagnostic) =>
			toLspDiagnostic(diagnostic, uri),
		)
		let signature = JSON.stringify(sent)

		if (publishedContent.get(uri) === signature) {
			return
		}

		publishedContent.set(uri, signature)
		// NOTE: A connection that has gone away fails BOTH ways — it throws
		// where it has been closed or disposed, and the write itself rejects
		// where the pipe went first — and every publish here is inside a
		// callback of the analysis loop, where either one is the process rather
		// than a failed request. A sweep sends one of these per file in the
		// workspace, so an Editor quitting mid-sweep is the ordinary way to
		// reach the second. Exactly as `notify` handles it.
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

	// NOTE: A URI this entry has stopped reporting on is not cleared here but
	// COLLECTED, and cleared by `retireEntries` once every analysis of the batch
	// has published — or, for a sweep and for whatever fires while one is in
	// flight, once its queue has emptied, which is the same moment reached over
	// more callbacks. The two are the same question asked at different moments,
	// and only the later one has an answer: an entry that drops a file has
	// usually dropped it TO somebody — a Module promoted to a root of its own
	// owns what it used to be lent — and which of them runs first is decided by
	// reach, which is to say by nothing that knows about hand-overs.
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

	// NOTE: Everything an entry's graph is expected to cover — the entry and its
	// transitive dependencies, read off the parses the Workspace already holds.
	// Two things ride on it: the order a batch runs in, and which files a batch
	// was supposed to have judged.
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

	// NOTE: What each entry of a batch is expected to cover, walked ONCE for the
	// two things that read it — the order the batch runs in, and which of those
	// files it turned out to have judged. Each is a transitive walk per entry,
	// and a batch is every root that reaches an edited Module.
	function reachesOf(filePaths: Iterable<string>): Map<string, Set<string>> {
		return new Map(
			[...filePaths].map((filePath) => [filePath, reachOf(filePath)]),
		)
	}

	// NOTE: The entries whose graphs reach the most files first. One analysis
	// fills the cache for every Module its graph touched, so analysing a
	// dependency BEFORE the file importing it links the same Modules twice —
	// once as a graph of their own, and once again inside the larger one.
	//
	// No root's graph holds another root, so for a batch of roots this settles
	// nothing and costs nothing beyond the walk above. It is the coverage
	// fallback below whose entries overlap: one of them standing above another
	// in the same broken graph is the ordinary case, and analysing that one
	// first is what keeps the rest to a cache read.
	function analysisOrder(reaches: Map<string, Set<string>>): Array<string> {
		return [...reaches.keys()].sort(
			(left, right) => reaches.get(right)!.size - reaches.get(left)!.size,
		)
	}

	// NOTE: An open document no root's graph will ever reach: a standard library
	// source, which the Workspace deliberately holds nothing for, and a buffer
	// outside the workspace folders, which no discovery walk finds. Those are
	// entries of their own — analysed on their own, exactly as every open
	// document used to be, because nothing else is ever going to report on them.
	function needsOwnEntry(filePath: string): boolean {
		return (
			!workspace.knownFiles().has(filePath) ||
			workspace.programOf(filePath) === null
		)
	}

	// NOTE: What has to be analysed to cover a set of changed files. Three
	// kinds, and each of them is a file nothing else in the batch answers for:
	//
	//   • the roots of the graphs REACHING them, and never all the roots — one
	//     that reaches none of them was judged against text that did not move;
	//   • every root nothing has ever analysed, which is how a file PROMOTED to
	//     one is found. A root is made by an in-edge going away — an import
	//     deleted, an importer deleted — so a promoted root reaches nothing that
	//     changed: it is what stopped being reached. Nothing would ever schedule
	//     it, while the analysis of the file that let it go clears everything it
	//     used to own, and a broken Module would go quiet while still broken;
	//   • an open document no root will ever reach whose graph holds one of the
	//     changed files. A buffer outside the workspace folders is nobody's
	//     dependency and no discovery walk finds it, so no root is ever going to
	//     refresh it when what it imports moves.
	function entriesFor(filePaths: Array<string>): Array<string> {
		let entries = new Set(workspace.rootsReaching(filePaths))
		let changed = new Set(filePaths)
		// NOTE: Except the roots a sweep in flight still owes an analysis to.
		// Every one of those has published nothing yet, so the scan below would
		// read the whole remaining sweep as newly promoted and pull it into this
		// batch — which is the one callback the chunking exists to break up, and
		// the file the reader is typing in would wait behind the rest of the
		// project again. They are not forgotten: they are queued, and the queue
		// drops whatever this batch analyses (see `analyseBatch`).
		let queued = new Set(sweepQueue)

		// NOTE: By whether it has ever PUBLISHED rather than by whether its
		// analysis is cached. `invalidateEnrichment` drops the whole UNDIRECTED
		// component, so after one keystroke every root that merely shares a
		// dependency with the edited file reports as unanalysed — and scheduling
		// those is the fan-out this whole batch is shaped to avoid. An entry is
		// kept for as long as its file is a root (see `retireEntries`), so what
		// this finds is only ever a root that has never been one.
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

	// NOTE: Every root of the workspace, which between them cover every file of
	// it. This is what makes the Problems panel the project's rather than the
	// open documents': once the roots have been analysed every file has
	// Diagnostics, and the Server publishes all of them.
	function everyEntry(): Array<string> {
		let entries = new Set(workspace.roots())

		for (let filePath of openPaths.keys()) {
			if (needsOwnEntry(filePath)) {
				entries.add(filePath)
			}
		}

		return [...entries]
	}

	// NOTE: One batch of analyses, start to finish, inside one timer callback.
	// Three steps, in this order and for this reason:
	//
	//   • the entries, biggest graph first, each of them filling the cache for
	//     every Module it reached;
	//   • then whatever they were supposed to cover and did not — a root that
	//     threw, a graph that could not read one of its Modules, a dependency
	//     writing neither section. Without this a broken root hides every file
	//     beneath it, and every one of those files used to analyse itself;
	//   • then everything the batch stopped reporting on: the entries that
	//     answer for nothing any more, and the URIs the surviving ones let go.
	//     Both are cleared AFTER every analysis has published, so a file
	//     changing hands is never briefly clear — and after a sweep in flight
	//     has emptied its queue too, since mid-queue the root taking a file over
	//     is usually one of the roots still waiting for a callback (see
	//     `retireEntries`).
	//
	// This is the path a CHANGE takes, and it stays one callback on purpose: it
	// is the roots reaching the file the reader is typing in, and the answer they
	// produce is the one the Editor is waiting for. A whole-workspace sweep is
	// the same three steps spread over a callback each — see `startSweep`.
	function analyseBatch(entries: Array<string>, focus?: string): void {
		let reaches = reachesOf(entries)
		// NOTE: The URIs the batch's entries stopped reporting on, cleared once
		// at the end rather than as each entry finds them — see
		// `publishAnalysis`.
		let dropped = new Set<string>()
		let analysed = new Set<string>()

		for (let entryPath of analysisOrder(reaches)) {
			analyseAndPublish(entryPath, focus, dropped)
			analysed.add(entryPath)
		}

		for (let uncovered of analysisOrder(reachesOf(uncoveredBy(reaches)))) {
			// NOTE: An entry that ran meanwhile may have covered it after all —
			// the fallbacks are worked out once, before any of them runs, and
			// one of them standing above another is the ordinary case.
			if (!needsOwnAnalysis(uncovered)) {
				continue
			}

			analyseAndPublish(uncovered, focus, dropped)
			analysed.add(uncovered)
		}

		// NOTE: An entry a sweep still owed and this batch has just run is owed
		// no longer. Analysing it again would be a cache read, and publishing it
		// again would be a second message for a list that did not move — the
		// dedup would swallow it, but the queue is what the change batch is
		// deliberately not doing all at once, and leaving a done root in it says
		// the opposite.
		if (sweepQueue.length > 0) {
			sweepQueue = sweepQueue.filter(
				(entryPath) => !analysed.has(entryPath),
			)
		}

		retireEntries(dropped)
	}

	// NOTE: A whole-workspace sweep, QUEUED rather than run. Everything a batch
	// does, in the same order and for the same reasons — the entries biggest
	// graph first, then whatever they were supposed to cover and did not, then
	// what the whole of it stopped reporting on — with the loop handed back
	// between two entries.
	//
	// It REPLACES whatever a previous sweep had left, because that is what asks
	// for one: the folders moved, and the roots the old queue held are the roots
	// of a workspace that is not this one.
	function startSweep(focus: string | undefined): void {
		sweepReaches = reachesOf(everyEntry())
		sweepQueue = analysisOrder(sweepReaches)
		sweepUncovered = new Set()
		sweepPhase = "entries"
		sweepFocus = focus

		armSweepChunk()
	}

	// NOTE: The next entry of the sweep, one macrotask from now. A macrotask
	// deliberately, and for the same reason `yieldToConnection` is one: a
	// microtask runs before any I/O, so a sweep that yielded to one would still
	// be a sweep nothing can interrupt. `setImmediate` runs after the loop has
	// been through its poll, which is where the request the Editor is waiting on
	// is read and answered.
	//
	// At most one is ever armed. A batch firing mid-sweep does not arm another —
	// it has its own timer, it runs to completion, and the callback already
	// waiting picks up whatever it left in the queue.
	function armSweepChunk(): void {
		if (sweepChunk !== null) {
			return
		}

		sweepChunk = setImmediate(() => {
			sweepChunk = null
			runSweepChunk()
		})
	}

	// NOTE: One entry of the sweep, start to finish. Analysing a root is
	// synchronous and atomic — it publishes before it returns — so the sweep is
	// interruptible between two entries and never inside one, which is the whole
	// safety argument: the Compiler collects its Diagnostics into module level
	// state, and what may not interleave is two COMPILATIONS. A request handler
	// suspends before it compiles and never after (see `yieldToConnection`), so
	// whole units interleaving is exactly what is allowed.
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

			// NOTE: Retirement once, at the end, rather than after every entry.
			// It is the cheaper of the two — it works the roots out again and
			// walks everything published — and it is the only correct one:
			// retiring an entry before the entry taking its files over has run
			// is the flicker the whole hand-over rule exists to prevent, and
			// mid-sweep the entry taking over is usually still in the queue.
			retireEntries(sweepDropped)
			sweepDropped.clear()
			sweepFocus = undefined

			return
		}

		if (sweepPhase === "entries") {
			analyseAndPublish(entryPath, sweepFocus, sweepDropped)

			// NOTE: What this entry was supposed to judge and did not, collected
			// now and analysed once the queue's entries have all run — a file one
			// root could not read is often one the root beside it can, and the
			// root beside it is still queued.
			for (let filePath of uncoveredIn(
				sweepReaches.get(entryPath) ?? [],
			)) {
				sweepUncovered.add(filePath)
			}
		} else if (needsOwnAnalysis(entryPath)) {
			// NOTE: A fallback worked out before the queue reached it may have
			// been covered since — by a later entry of the sweep, or by a change
			// batch that ran between two of these callbacks. Asked again for the
			// same reason `analyseBatch` asks.
			analyseAndPublish(entryPath, sweepFocus, sweepDropped)
		}

		armSweepChunk()
	}

	// NOTE: The files these entries were supposed to judge and did not, which is
	// "the closest to root we can actually analyse" — the fallback that keeps
	// one unreadable file from hiding a whole project beneath it. A file the
	// Workspace holds nothing for is left out: a specifier naming a file that is
	// not there records an edge all the same, and there is no text to judge at
	// the end of it.
	//
	// Two shapes reach it. A root the Compiler threw on, or a graph that could
	// not read one of its Modules, is the one it was written for. The other is
	// ordinary and permanent: a dependency writing NEITHER Module section is
	// judged as itself rather than as part of anybody's graph (see
	// `analyseGraphFrom`), so the graph that reached it leaves this cache
	// holding nothing for it, and analysing it here is how it gets an answer of
	// its own — which is the answer every request over it reads.
	function uncoveredBy(reaches: Map<string, Set<string>>): Array<string> {
		let uncovered = new Set<string>()

		for (let reached of reaches.values()) {
			for (let filePath of uncoveredIn(reached)) {
				uncovered.add(filePath)
			}
		}

		return [...uncovered]
	}

	// NOTE: The same question about ONE entry's reach, which is how a sweep asks
	// it: right after the entry ran, rather than once the whole queue has. What
	// this reads is whether an analysis is CACHED, and a keystroke landing
	// between two entries of a sweep drops the enrichment of a whole undirected
	// component — so asked at the end of a queue that a reader typed into, every
	// file the sweep already judged answers "uncovered" and the sweep would
	// re-analyse the project one file at a time. Asked while the entry that was
	// supposed to cover it has only just returned, the answer means what it says.
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

	// NOTE: Whether this file still needs an entry of its OWN in a batch that
	// reached it. Two reasons it does, and they are not the same reason. Nothing
	// has judged it — a root the Compiler threw on, a graph that could not read
	// one of its Modules — or no graph ever judges it, because it writes neither
	// Module section and is enriched as a Program of its own.
	//
	// The second stays true however recently it was analysed, which is why this
	// is not simply `isAnalysed`: its entry is what OWNS its URI, and an entry
	// that does not run publishes nothing — not its Diagnostics and not the
	// `test-failed` ones a run beside it has just produced. Running it is a
	// cache read when nothing about the file moved, and the dedup keeps the
	// wire quiet.
	function needsOwnAnalysis(filePath: string): boolean {
		return (
			!workspace.isAnalysed(filePath) || !workspace.isModuleFile(filePath)
		)
	}

	// NOTE: An entry stops owning what it published once it has stopped being
	// one: a root something now imports, a coverage fallback whose root can be
	// read again, a file that was deleted. It is retired only when somebody else
	// answers for its own URI or there is nothing left to answer about, because
	// the alternative is a file whose squiggles vanish while it is still broken
	// — its Diagnostics came off disk, and they are true whether or not anything
	// has it open.
	//
	// Run AFTER the batch's analyses, so the new owner's publish precedes the
	// old one's clear: the dedup then keeps the wire quiet rather than sending a
	// list and its erasure. `dropped` is the other half of the same rule — the
	// URIs the surviving entries stopped reporting on, held back for exactly as
	// long, and cleared here only if nobody took them over.
	//
	// A sweep runs this once, after its LAST entry rather than after each of
	// them, for that same reason: mid-queue the entry taking a file over is
	// usually one of the roots still waiting to be analysed. Which is also why a
	// batch that fires MID-sweep hands its orphans to that same moment rather
	// than clearing them itself — see below.
	function retireEntries(dropped: Set<string>): void {
		let roots = new Set(workspace.roots())
		let retiring = new Set<string>()

		for (let entryPath of publishedByEntry.keys()) {
			// NOTE: A current root answers for its whole graph, and an open
			// document no root reaches answers for itself for as long as it is
			// open. Nothing else is going to publish for either.
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

		// NOTE: Every retirement is recorded before any of them publishes, so
		// that two entries owning each other's URIs do not each conclude the
		// other is still answering. What survives is what the entries left over
		// own.
		for (let entryPath of retiring) {
			for (let targetUri of publishedByEntry.get(entryPath) ?? []) {
				orphaned.add(targetUri)
			}

			publishedByEntry.delete(entryPath)
		}

		// NOTE: And held rather than made while a sweep still has a callback
		// armed, because what `claimedElsewhere` reads is what has PUBLISHED and
		// mid-queue that is a fraction of the project. A keystroke that takes a
		// dependency away from the file it is in orphans that dependency's URI
		// while the root taking it over is one of the roots still waiting for a
		// callback — and clearing it there is the flicker this whole rule exists
		// to prevent, a squiggle going out and coming back a project's worth of
		// roots later. Handed to the sweep's own set, it is decided once at the
		// end of the queue, which is the moment the question has an answer.
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

	// NOTE: The files whose Diagnostics a change may have moved. Which roots
	// have to run to answer for them is worked out when the window fires — see
	// `pendingChanges`.
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

	// NOTE: Every root of the workspace, once the window fires — and then a
	// callback each, rather than all of them in the one that fired (see
	// `startSweep`). What a sweep covers is not a change, which is why it names
	// no file: it is the whole project, asked for at startup and whenever the
	// folders move.
	function scheduleSweep() {
		pendingSweep = Date.now() + analysisDebounceInMilliseconds
		armAnalysis()
	}

	// NOTE: Everything pending is flushed together once the FIRST of them is due,
	// rather than each at its own deadline. Both halves of that matter: waiting
	// for the earliest is what stops a document from being held back by an edit
	// somewhere else, and flushing the rest with it is what keeps a batch to one
	// link per graph root instead of splitting a fan-out into one window each.
	// A document still being typed in pays at most one extra analysis per other
	// document that came due, and its own debounce starts again from there.
	//
	// NOTE: A window that comes due mid-sweep is answered ahead of what the
	// sweep has left, because the sweep gives the loop back between two of its
	// entries and a timer that is due is what the loop reaches first. That is the
	// order this Server wants: the file the reader is typing in must not wait for
	// a project it is not part of.
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

				// NOTE: A sweep subsumes whatever changed alongside it — every
				// root covers every file, the changed ones included.
				if (sweeping) {
					startSweep(focus)
				} else {
					analyseBatch(entriesFor(changed), focus)
				}
			},
			Math.max(0, due - Date.now()),
		)
	}

	function analyseAndPublish(
		filePath: string,
		focus: string | undefined,
		dropped: Set<string>,
	) {
		// NOTE: The Diagnostics collector is module-level state, so entries are
		// analysed strictly one at a time — every call here runs to completion
		// inside the callback that made it, whether that is a change batch or one
		// entry of a sweep, and it is the reason a request may only suspend
		// before it compiles anything (see `yieldToConnection`).
		//
		// NOTE: Through the Workspace, so that this WRITES the cache every
		// request reads: one analysis fills the entry for this file and for
		// every other Module of its graph, and a Hover that already paid for one
		// finds it here rather than paying again.
		let uri = openPaths.get(filePath)
		let document = uri === undefined ? undefined : documents.get(uri)
		let analysis = workspace.analysisOf(filePath, { annotationsFor: focus })

		// NOTE: The fallback is not a fast path for anything — it is the answer
		// for the documents the Workspace deliberately holds nothing for: a
		// standard library source, and a buffer whose path can not be read. Both
		// were always analysed on their own. A file nobody has open that the
		// Workspace holds nothing for is not a file at all, and there is nothing
		// to say about it.
		if (analysis === null) {
			if (uri === undefined || document === undefined) {
				return
			}

			analysis = analyseDocument(document.getText(), uri, {
				host: workspace.host,
				// NOTE: As the Workspace itself has it — a document it holds
				// nothing for still has its `tests { … }` block typed.
				tests: true,
			})
		}

		// NOTE: Under each file's OWN URI, dependencies included and whether or
		// not anything has them open. A Module's Diagnostics depend on that
		// Module and on what it reaches and on nothing else, so what the root
		// that happened to load the graph says about a file is exactly what the
		// file would say about itself — which is what lets one analysis speak
		// for a whole project.
		let results = new Map<string, Array<common.Diagnostic>>([
			[
				uriFor(filePath),
				[...analysis.diagnostics, ...testDiagnosticsFor(filePath)],
			],
		])

		for (let [dependencyPath, diagnostics] of analysis.dependencies) {
			// NOTE: Except a dependency writing NEITHER Module section, whose
			// own answer is not this one. The graph enriches such a file under a
			// Module path and the Workspace drops what it made of it — so the
			// list here is a second opinion about a file that has its own, the
			// two can differ, and publishing both is a Problems panel that
			// changes twice per keystroke in the importer. `uncoveredBy` sends
			// it to an entry of its own, which is where its own answer comes
			// from and what every request over it reads.
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

	// NOTE: `onDidChangeContent` also fires when a document is opened.
	documents.onDidChangeContent((event) => {
		let filePath = documentFilePath(event.document.uri)

		openPaths.set(filePath, event.document.uri)
		workspace.changed(filePath)
		tags = null
		scheduleAnalysis([filePath], filePath)
		// NOTE: On the UNSAVED buffer, exactly as the analysis is. What a
		// reader is looking at is what the session answers for; a file on disk
		// nobody has open is answered for out of the file.
		session.changed([filePath])
	})

	documents.onDidClose((event) => {
		let filePath = documentFilePath(event.document.uri)

		openPaths.delete(filePath)
		// NOTE: The buffer is gone, so what the workspace holds for it was built
		// from text that no longer exists anywhere — the file on disk is the
		// truth again.
		workspace.changed(filePath)

		// NOTE: Nothing is cleared, and that is the change: what this file's
		// Diagnostics say is still true the moment its buffer goes, because they
		// are what the file on disk says. The Problems panel reports on a
		// workspace rather than on a set of tabs, so a Module closed while
		// broken keeps its squiggles.
		//
		// What has to happen is that the roots reaching it run again, against
		// the file rather than against the buffer — nothing else will ask them
		// to, since no keystroke is going to land in a file the reader just
		// closed. A closed document that no root reaches owned its own
		// Diagnostics and is retired by the same batch.
		scheduleAnalysis([filePath])
	})

	documents.listen(connection)
	connection.listen()
}

// NOTE: The inverse of the decoding `documentFilePath` does. Each segment is
// encoded on its own so that the separators survive — a file named `a b.es`
// becomes `a%20b.es`, and the client matches the URI it handed over.
// NOTE: Accepting a TYPE Hint writes its own label at its own position, which
// the protocol asks for as an edit — and an insertion is an empty Range there
// rather than a Position of its own. A VALUE Hint has nothing to accept: what a
// test recorded is a fact about one run, not something the source could have
// said, so it carries no edit and is offered as a Parameter Hint, which is the
// kind Editors draw quietly.
export function toLspInlayHint(hint: InlayHintEntry): InlayHint {
	let position = {
		line: hint.position.line - 1,
		character: hint.position.column - 1,
	}

	if (hint.textEdit === null) {
		return {
			position,
			label: hint.label,
			kind: InlayHintKind.Parameter,
			paddingLeft: true,
		}
	}

	let insertion = {
		line: hint.textEdit.position.line - 1,
		character: hint.textEdit.position.column - 1,
	}

	return {
		position,
		label: hint.label,
		kind: InlayHintKind.Type,
		textEdits: [
			{
				range: { start: insertion, end: insertion },
				newText: hint.textEdit.newText,
			},
		],
	}
}

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
	module: CompletionItemKind.File,
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
		//
		// NOTE: An entry that names what it replaces is handed over as a text
		// edit, which is the one form that carries a range. The Editor then
		// filters it on the text of that range rather than on its own word.
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
