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
	ShutdownRequest,
	UnregistrationRequest,
} from "vscode-languageserver/node"

import { compilationCounts, resetCompilationCounts } from "../compilation"
import { IDLE_REQUEST, uriOf } from "../server"
import { startServer } from "../server"
import {
	TEST_RUN_NOTIFICATION,
	type TestRunNotification,
} from "../testProtocol"

// The real Server, driven as an Editor drives it: over a connection, through
// the document store and the debounce. Other specs check what a request answers,
// and this harness checks what it costs. It runs in-process, since
// `compilationCounts` is a module-level tally a child process could not report.

export type SessionRequestResult<Result> = {
	result: Result
	// What answering the request compiled. Nothing runs between two awaits
	// unless a timer fires, and the harness decides when timers fire.
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
	// Every publish as it came over the wire, not only the latest per URI. A
	// publish that changes nothing leaves no trace in the state, but a client
	// still pays for it.
	let publishLog: Array<{ uri: string; version?: number }> = []
	let testRuns: Array<TestRunNotification> = []
	let watchers: Array<{ stop: () => void }> = []

	// The test session's notifications, kept as a log since a run sends a
	// `start` and an `end`.
	client.onNotification(TEST_RUN_NOTIFICATION, (notification) => {
		testRuns.push(notification as TestRunNotification)
	})
	// The Server registers its watcher and configuration listener dynamically.
	// A registration is a request, and an unanswered one keeps the first
	// `Promise.all` a spec writes from settling.
	client.onRequest(RegistrationRequest.type, () => undefined)
	client.onRequest(UnregistrationRequest.type, () => undefined)
	client.onNotification(PublishDiagnosticsNotification.type, (params) => {
		published.set(params.uri, params.diagnostics)
		publishLog.push({ uri: params.uri, version: params.version })
		publishCount += 1
	})
	client.listen()

	// The capabilities a client advertises decide what the Server may send it.
	// The default is VS Code's: either shape of Workspace Edit, and file
	// creation. A spec about a less capable editor hands over its whole
	// `workspace` block.
	async function initialize(
		folders: Array<string>,
		workspace: object = {
			workspaceFolders: true,
			// False on purpose: the Server must keep its Inlay Hints for a client
			// that answers no configuration request, and it saves a round trip.
			configuration: false,
			workspaceEdit: {
				documentChanges: true,
				resourceOperations: ["create", "rename", "delete"],
			},
		},
	): Promise<void> {
		await client.sendRequest(InitializeRequest.type, {
			processId: null,
			rootUri: null,
			capabilities: { workspace },
			workspaceFolders: folders.map((folder) => ({
				uri: uriOf(folder),
				name: path.basename(folder),
			})),
		})

		await client.sendNotification(InitializedNotification.type, {})
	}

	// The language id is the client's. The extension's document selector names
	// `essence.json` too, so the Server can report on a project file.
	async function open(
		filePath: string,
		text: string,
		languageId = "essence",
	): Promise<void> {
		versions.set(filePath, 1)

		await client.sendNotification(DidOpenTextDocumentNotification.type, {
			textDocument: {
				uri: uriOf(filePath),
				languageId,
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

	// A request and what it cost. The tally is read around the await, so the
	// cost includes everything the request made the Server do. It is sent by
	// method name, so one function sends any request.
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
		testRuns: () => testRuns,
		// Waits for a number of finished runs rather than a length of time. The
		// deadline throws and spends the caller's whole budget. A short list would
		// make a starved Worker read as a false claim about the Server.
		waitForTestRuns: async (count: number, timeout = 60_000) => {
			let deadline = Date.now() + timeout
			let ended = () =>
				testRuns.filter((run) => run.kind === "end").length

			while (ended() < count && Date.now() < deadline) {
				await new Promise((resolve) => setTimeout(resolve, 25))
			}

			if (ended() < count) {
				throw new Error(
					`only ${ended()} of ${count} test runs ended within ${timeout} ms`,
				)
			}

			return testRuns.filter((run) => run.kind === "end")
		},
		// The finished run the Server answered a request with, found by its
		// number. A session also runs on its own account, so the second run to
		// end may not be this request's. The deadline throws.
		waitForTestRun: async (run: number, timeout = 60_000) => {
			let deadline = Date.now() + timeout
			let ended = () =>
				testRuns.find(
					(notification) =>
						notification.kind === "end" && notification.run === run,
				)

			while (ended() === undefined && Date.now() < deadline) {
				await new Promise((resolve) => setTimeout(resolve, 25))
			}

			let found = ended()

			if (found === undefined) {
				throw new Error(
					`test run ${run} did not end within ${timeout} ms`,
				)
			}

			return found
		},
		// The run of a cycle in flight, which a request must land in to be
		// deferred. A spec waits for it rather than sleeping, since a compile
		// takes as long as the machine takes. The deadline throws.
		waitForRunInFlight: async (timeout = 60_000) => {
			let deadline = Date.now() + timeout
			let flying = () => {
				let ended = new Set(
					testRuns
						.filter((notification) => notification.kind === "end")
						.map((notification) => notification.run),
				)

				return testRuns.find(
					(notification) =>
						notification.kind === "start" &&
						!ended.has(notification.run),
				)?.run
			}

			while (flying() === undefined && Date.now() < deadline) {
				await new Promise((resolve) => setTimeout(resolve, 5))
			}

			let found = flying()

			if (found === undefined) {
				throw new Error(
					`no test run was in flight within ${timeout} ms`,
				)
			}

			return found
		},
		// A run nobody numbered, found by what it says. Opening a file ends two
		// runs of the same text, so the second run to end may predate an edit.
		// The deadline throws.
		waitForTestRunWhere: async (
			description: string,
			matches: (run: TestRunNotification) => boolean,
			timeout = 60_000,
		) => {
			let deadline = Date.now() + timeout
			let ended = () =>
				testRuns.find(
					(notification) =>
						notification.kind === "end" && matches(notification),
				)

			while (ended() === undefined && Date.now() < deadline) {
				await new Promise((resolve) => setTimeout(resolve, 25))
			}

			let found = ended()

			if (found === undefined) {
				throw new Error(
					`no test run ${description} ended within ${timeout} ms`,
				)
			}

			return found
		},
		publishCount: () => publishCount,
		publishesSince: (mark: number) => publishLog.slice(mark),
		publishMark: () => publishLog.length,
		// Waits until the Server has linked `count` graphs since a mark. It polls
		// on a macrotask, since the analysis loop yields between callbacks (see
		// `armSweepChunk`) and a microtask would see nothing move. The deadline
		// throws.
		waitForLinks: async (
			before: CompilationTally,
			count: number,
			timeout = 60_000,
		) => {
			let deadline = Date.now() + timeout

			while (
				compilationCounts.links - before.links < count &&
				Date.now() < deadline
			) {
				await new Promise<void>((resolve) => {
					setImmediate(resolve)
				})
			}

			let linked = compilationCounts.links - before.links

			if (linked < count) {
				throw new Error(
					`only ${linked} of ${count} graphs were linked within ${timeout} ms`,
				)
			}

			return linked
		},
		// The most graphs the Server linked inside one turn of the event loop. A
		// chunked sweep links one root per callback, and a batch that swallowed
		// the queue links many in one. It polls on a macrotask like `waitForLinks`,
		// and reads two when a due window fires, since timers run before the check
		// phase.
		watchLinkBursts: () => {
			let most = 0
			let previous = compilationCounts.links
			let watching = true
			let watch = async () => {
				while (watching) {
					await new Promise<void>((resolve) => {
						setImmediate(resolve)
					})

					let now = compilationCounts.links

					most = Math.max(most, now - previous)
					previous = now
				}
			}

			void watch()

			let watcher = {
				most: () => most,
				stop: () => {
					watching = false
				},
			}

			watchers.push(watcher)

			return watcher
		},
		// Waits over the wire for the answer to what a spec just typed. The mark
		// is where to start looking, since the file has usually been published
		// before.
		waitForPublishOf: async (
			filePath: string,
			mark: number,
			timeout = 30_000,
		) => {
			let uri = uriOf(filePath)
			let deadline = Date.now() + timeout
			let arrived = () =>
				publishLog.slice(mark).some((entry) => entry.uri === uri)

			while (!arrived() && Date.now() < deadline) {
				await new Promise<void>((resolve) => {
					setImmediate(resolve)
				})
			}

			return arrived()
		},
		// Waits for a Diagnostic to be gone from a file. `notify` sends a run's
		// end before `onResults` republishes, and the analysis between them takes
		// as long as the machine does. The deadline throws.
		waitForCodeToClear: async (
			filePath: string,
			code: string,
			timeout = 30_000,
		) => {
			let uri = uriOf(filePath)
			let deadline = Date.now() + timeout
			let present = () =>
				(published.get(uri) ?? []).some(
					(diagnostic) => diagnostic.code === code,
				)

			while (present() && Date.now() < deadline) {
				await new Promise<void>((resolve) => {
					setImmediate(resolve)
				})
			}

			if (present()) {
				throw new Error(
					`\`${code}\` was still published for ${path.basename(filePath)} after ${timeout} ms`,
				)
			}
		},
		resetCounts: resetCompilationCounts,
		counts: currentTally,
		tallySince: tallyOf,
		// Waits until the Server has caught up and every Diagnostic has crossed
		// the pipe, since the idle answer is written behind the last publish. It
		// proves no absence over time.
		settle: async () => {
			await client.sendRequest(IDLE_REQUEST)
		},
		// Closing a document schedules an analysis, and the shutdown request
		// cancels the window. The pipes stay open, since `createConnection` exits
		// the process when its input ends, which would end the test runner.
		dispose: async () => {
			// A poll that re-arms itself on `setImmediate` holds the loop open, so
			// a spec that threw before stopping its own would leave the runner
			// spinning.
			for (let watcher of watchers) {
				watcher.stop()
			}

			for (let filePath of versions.keys()) {
				await close(filePath)
			}

			// The shutdown request stops the test session's Worker, which would
			// otherwise keep compiling for nobody.
			await client.sendRequest(ShutdownRequest.type).catch(() => {})
			await new Promise<void>((resolve) => setTimeout(resolve, 50))

			client.dispose()
			server.dispose()
		},
	}
}

// A workspace is a directory of files, as `workspace.spec.ts` builds one,
// since which path a specifier resolves to is a fact about a filesystem.
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
