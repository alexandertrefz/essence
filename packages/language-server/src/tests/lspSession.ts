import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import * as path from "node:path"
import { PassThrough } from "node:stream"

import { canonicalPath } from "@essence-lang/compiler/documents"
import {
	type CancellationToken,
	CancellationTokenSource,
	createConnection,
	createProtocolConnection,
	type Diagnostic,
	DidChangeTextDocumentNotification,
	DidChangeWatchedFilesNotification,
	DidCloseTextDocumentNotification,
	DidOpenTextDocumentNotification,
	InitializedNotification,
	InitializeRequest,
	type ProtocolConnection,
	PublishDiagnosticsNotification,
	RegistrationRequest,
	UnregistrationRequest,
} from "vscode-languageserver/node"

import { compilationCounts, resetCompilationCounts } from "../compilation"
import { uriOf } from "../server"
import { startServer } from "../server"

// NOTE: The real Server, driven the way an Editor drives it: over a connection,
// through the document store, past the debounce, one request at a time. Every
// other test in this package calls a request's insides directly, which is the
// right way to check WHAT it answers and no way at all to check what it COSTS —
// the costs live in the loop around them.
//
// In-process rather than over a spawned stdio process for one reason: the
// counters. `compilationCounts` is a module-level tally inside this process, and
// a child process can not be asked for it without inventing a protocol to ask
// with.

export type SessionRequestResult<Result> = {
	result: Result
	// NOTE: What answering the request compiled. The debounce is what makes this
	// readable at all: nothing runs between two awaits unless a timer fired, and
	// the harness decides when timers fire.
	compilations: CompilationTally
	milliseconds: number
}

export type CompilationTally = {
	parses: number
	enrichments: number
	graphs: number
	links: number
	total: number
}

export type LspSession = ReturnType<typeof startSession>

function tallyOf(before: CompilationTally): CompilationTally {
	let parses = compilationCounts.parses - before.parses
	let enrichments = compilationCounts.enrichments - before.enrichments
	let graphs = compilationCounts.graphs - before.graphs
	let links = compilationCounts.links - before.links

	return {
		parses,
		enrichments,
		graphs,
		links,
		total: parses + enrichments + graphs + links,
	}
}

function currentTally(): CompilationTally {
	return {
		parses: compilationCounts.parses,
		enrichments: compilationCounts.enrichments,
		graphs: compilationCounts.graphs,
		links: compilationCounts.links,
		total: 0,
	}
}

export function startSession() {
	let clientToServer = new PassThrough()
	let serverToClient = new PassThrough()

	let server = createConnection(clientToServer, serverToClient)

	startServer({ connection: server })

	let client: ProtocolConnection = createProtocolConnection(
		serverToClient,
		clientToServer,
	)
	let published = new Map<string, Array<Diagnostic>>()
	let publishCount = 0
	let versions = new Map<string, number>()
	// NOTE: Every publish as it came over the wire, rather than only the latest
	// per URI. What a Server sends that changes nothing is invisible in the state
	// it leaves behind, and it is exactly what a client pays for.
	let publishLog: Array<{ uri: string; version?: number }> = []

	// NOTE: The Server registers its watcher and its configuration listener
	// dynamically, and a registration is a REQUEST — unanswered, it stays
	// pending for the whole session and the first `Promise.all` a test writes
	// never settles.
	client.onRequest(RegistrationRequest.type, () => undefined)
	client.onRequest(UnregistrationRequest.type, () => undefined)
	client.onNotification(PublishDiagnosticsNotification.type, (params) => {
		published.set(params.uri, params.diagnostics)
		publishLog.push({ uri: params.uri, version: params.version })
		publishCount += 1
	})
	client.listen()

	async function initialize(folders: Array<string>): Promise<void> {
		await client.sendRequest(InitializeRequest.type, {
			processId: null,
			rootUri: null,
			capabilities: {
				workspace: {
					workspaceFolders: true,
					// NOTE: False on purpose: a client that answers no
					// configuration request is the case the Server has to keep
					// its Inlay Hints under, and it is one less round trip
					// between a keystroke and a measurement.
					configuration: false,
				},
			},
			workspaceFolders: folders.map((folder) => ({
				uri: uriOf(folder),
				name: path.basename(folder),
			})),
		})

		await client.sendNotification(InitializedNotification.type, {})
	}

	async function open(filePath: string, text: string): Promise<void> {
		versions.set(filePath, 1)

		await client.sendNotification(DidOpenTextDocumentNotification.type, {
			textDocument: {
				uri: uriOf(filePath),
				languageId: "essence",
				version: 1,
				text,
			},
		})
	}

	async function change(filePath: string, text: string): Promise<void> {
		let version = (versions.get(filePath) ?? 1) + 1

		versions.set(filePath, version)

		await client.sendNotification(DidChangeTextDocumentNotification.type, {
			textDocument: { uri: uriOf(filePath), version },
			contentChanges: [{ text }],
		})
	}

	async function close(filePath: string): Promise<void> {
		await client.sendNotification(DidCloseTextDocumentNotification.type, {
			textDocument: { uri: uriOf(filePath) },
		})
	}

	async function watchedFileChanged(
		changes: Array<{ filePath: string; type: 1 | 2 | 3 }>,
	): Promise<void> {
		await client.sendNotification(DidChangeWatchedFilesNotification.type, {
			changes: changes.map((change) => ({
				uri: uriOf(change.filePath),
				type: change.type,
			})),
		})
	}

	// NOTE: A request and what it cost, which is the whole point of the harness.
	// The tally is read around the await rather than inside the handler: what a
	// request costs includes everything it made the Server do, cache misses in
	// other files included.
	// NOTE: Sent by method name rather than by request type. The typed overloads
	// pin the parameters to the exact request, which is what a handler wants and
	// the opposite of what a harness wants — one function that sends any of them
	// and hands back what came over the wire.
	async function request<Result>(
		type: { method: string },
		params: object,
		token?: CancellationToken,
	): Promise<SessionRequestResult<Result>> {
		let before = currentTally()
		let started = performance.now()
		let result =
			token === undefined
				? await client.sendRequest<Result>(type.method, params)
				: await client.sendRequest<Result>(type.method, params, token)

		return {
			result,
			compilations: tallyOf(before),
			milliseconds: performance.now() - started,
		}
	}

	return {
		client,
		initialize,
		open,
		change,
		close,
		watchedFileChanged,
		request,
		cancellationSource: () => new CancellationTokenSource(),
		diagnosticsFor: (filePath: string) => published.get(uriOf(filePath)),
		codesFor: (filePath: string) =>
			(published.get(uriOf(filePath)) ?? []).map(
				(diagnostic) => diagnostic.code,
			),
		publishCount: () => publishCount,
		publishesSince: (mark: number) => publishLog.slice(mark),
		publishMark: () => publishLog.length,
		resetCounts: resetCompilationCounts,
		counts: currentTally,
		tallySince: tallyOf,
		// NOTE: Long enough for the analysis debounce to have fired and its
		// Diagnostics to have crossed the pipe — everything after it is a
		// measurement of a Server that has caught up, which is the state an
		// Editor spends its time in.
		settle: (milliseconds = 400) =>
			new Promise<void>((resolve) => setTimeout(resolve, milliseconds)),
		// NOTE: Every document is closed first, which is what cancels the
		// analyses still pending for them — a debounced analysis that fires
		// after the connection is gone throws where nothing can catch it.
		//
		// The connections are disposed and the pipes deliberately are NOT.
		// `createConnection` installs `process.exit` on its input stream's `end`
		// and `close` — right for a Server whose Editor went away, and fatal
		// here, where closing a pipe would take the test runner with it. A
		// PassThrough holds nothing open on its own.
		dispose: async () => {
			for (let filePath of versions.keys()) {
				await close(filePath)
			}

			await new Promise<void>((resolve) => setTimeout(resolve, 50))

			client.dispose()
			server.dispose()
		},
	}
}

// NOTE: A workspace is a directory of files, the way `workspace.spec.ts` builds
// one — which specifier resolves to which path is a fact about a filesystem, and
// an in-memory host would leave exactly that untested.
export function makeSessionWorkspace(files: Record<string, string>): {
	root: string
	pathOf: (name: string) => string
	dispose: () => void
} {
	let root = canonicalPath(mkdtempSync(path.join(tmpdir(), "essence-lsp-")))

	for (let [name, contents] of Object.entries(files)) {
		let filePath = path.join(root, name)

		mkdirSync(path.dirname(filePath), { recursive: true })
		writeFileSync(filePath, contents)
	}

	return {
		root,
		pathOf: (name: string) => canonicalPath(path.join(root, name)),
		dispose: () => rmSync(root, { recursive: true, force: true }),
	}
}
