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
import { uriOf } from "../server"
import { startServer } from "../server"
import {
	TEST_RUN_NOTIFICATION,
	type TestRunNotification,
} from "../testProtocol"

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
	let testRuns: Array<TestRunNotification> = []
	let watchers: Array<{ stop: () => void }> = []

	// NOTE: The custom notification the test session pushes. Kept as a log
	// rather than as a latest-value, because what a client pays for is every
	// one of them and a run is two: a `start` and an `end`.
	client.onNotification(TEST_RUN_NOTIFICATION, (notification) => {
		testRuns.push(notification as TestRunNotification)
	})
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
		testRuns: () => testRuns,
		// NOTE: Waits for a NUMBER of finished runs rather than for a length of
		// time: a compile takes as long as the machine takes.
		//
		// NOTE: The deadline THROWS, and it is the whole budget every caller's
		// own `it` was given rather than half of it. Handing back the runs that
		// did arrive made a starved worker read as a false claim about the
		// Server — the caller asserted on a short list and named the behaviour
		// it was checking — and a deadline under the test's own only took the
		// report away from bun's timeout, which says how long the test actually
		// ran. Every caller here waits for a count it positively expects, so
		// nothing uses the timeout to prove an absence.
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
		publishCount: () => publishCount,
		publishesSince: (mark: number) => publishLog.slice(mark),
		publishMark: () => publishLog.length,
		// NOTE: Waits until the Server has linked COUNT graphs since a mark,
		// rather than for a length of time — what a link costs is a fact about
		// the machine, and what a test wants to say is "once the analysis has
		// started". The tally is a module-level counter inside this process, so
		// unlike a publish there is no wire between the fact and the reading of
		// it.
		//
		// Polled on a macrotask deliberately: the analysis loop hands the event
		// loop back between two of its callbacks (see `armSweepChunk`), so a poll
		// that is itself a macrotask wakes up once per callback and sees the
		// Server one whole analysis at a time. A microtask would spin between two
		// of them and see nothing move.
		// The deadline throws, for the reason `waitForTestRuns` above gives.
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
		// NOTE: The most graphs the Server linked inside ONE turn of the event
		// loop, watched from the moment this is called until it is stopped. What
		// a test that types mid-sweep wants to say is that the change batch took
		// the roots reaching the change and not the ones the queue still owes,
		// and the fact that distinguishes those two is the SHAPE of the work
		// rather than its amount: a chunked sweep advances the tally by one root
		// per callback, and a batch that swallowed the queue advances it by a
		// project's worth inside a single one. Read that way the reading is a
		// fact about the loop rather than about how fast a link is — the total
		// at any given instant is the drain rate racing the debounce, and that
		// one moves with the machine.
		//
		// Polled on a macrotask for the reason `waitForLinks` is, and it reads
		// two in the turn a due window fires in: timers run before the check
		// phase, so the batch's link and the sweep's next root land between the
		// same two polls.
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
		// NOTE: The same kind of wait over the WIRE rather than over the tally:
		// what a test that has just typed something waits for is the answer to
		// what it typed, and everything else arriving is the Server doing its
		// other work beside it. The mark is where to start looking, since the
		// file has usually been published for already.
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
		// NOTE: Waits for a Diagnostic to be GONE from a file, for a test that
		// has just made the thing it reported true again. The wait is over the
		// state rather than over a length of time on purpose: a run's results
		// and the republish that carries them are two callbacks — `notify` puts
		// the run's end on the wire and `onResults` re-analyses and publishes
		// after it (see `server.ts`) — so a test that has seen the end has not
		// yet seen the publish, and how long the analysis between them takes is
		// a fact about the machine. A sleep long enough for this Mac is not
		// long enough for a starved two-core runner, and it fails there as a
		// stale list rather than as a slow one.
		//
		// The deadline THROWS, for the reason `waitForTestRuns` gives: a
		// Diagnostic that never clears is the failure this is watching for, and
		// it should be reported as itself rather than as the assertion after it.
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
		// NOTE: Long enough for the analysis debounce to have fired and its
		// Diagnostics to have crossed the pipe — everything after it is a
		// measurement of a Server that has caught up, which is the state an
		// Editor spends its time in.
		settle: (milliseconds = 400) =>
			new Promise<void>((resolve) => setTimeout(resolve, milliseconds)),
		// NOTE: Every document is closed first, which is what hands each of them
		// back to disk the way a closing Editor does — and closing SCHEDULES an
		// analysis rather than cancelling one, since what a file on disk says is
		// still true once its buffer is gone. What cancels the window is the
		// shutdown request below: a debounced analysis firing after the
		// connection has gone publishes into nothing, and a throw out of a timer
		// callback is the process (see `connection.onShutdown`).
		//
		// The connections are disposed and the pipes deliberately are NOT.
		// `createConnection` installs `process.exit` on its input stream's `end`
		// and `close` — right for a Server whose Editor went away, and fatal
		// here, where closing a pipe would take the test runner with it. A
		// PassThrough holds nothing open on its own.
		dispose: async () => {
			// NOTE: Every watcher stopped first. A poll that re-arms itself on
			// `setImmediate` holds the loop open for as long as it runs, and a
			// test that threw before it stopped its own would leave the runner
			// spinning rather than reporting the failure.
			for (let watcher of watchers) {
				watcher.stop()
			}

			for (let filePath of versions.keys()) {
				await close(filePath)
			}

			// NOTE: The shutdown request rather than merely dropping the pipes:
			// it is what stops the test session's Worker, and a Worker left
			// running keeps compiling for a Server nobody is listening to.
			await client.sendRequest(ShutdownRequest.type).catch(() => {})
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
