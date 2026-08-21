import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import * as path from "node:path"
import { pathToFileURL } from "node:url"
import { parentPort } from "node:worker_threads"

import { compileToMemory } from "@essence-lang/compiler/embed"
import type { ModuleHost } from "@essence-lang/compiler/modules"
import type {
	entryPoints,
	Registry,
	TestEvent,
} from "@essence-lang/runtime/Testing"

import type {
	TestSite,
	TestWorkerRequest,
	TestWorkerResponse,
} from "./testProtocol"

// NOTE: The other end of the session — see `testProtocol.ts` for why a Worker
// exists at all. It compiles each entry with the tests enriched, writes the
// bundle somewhere nothing has read, imports it and drives its own runner. What
// crosses back is events, which are plain data and already rendered: a value an
// Essence Program built carries a hidden Type key that is a Symbol of the
// runtime instance that built it, and no two realms share one.
//
// NOTE: This file is a Worker ENTRY. It starts listening as soon as it is
// loaded, and it is bundled on its own beside the Server — see
// `buildServer.js` — because the Server ships as a single file with no
// `node_modules` to resolve out of.

// NOTE: How many distinct bundles one Worker will load before the session is
// told to start another. Every bundle is a Module that can never be unloaded,
// and an editing session compiles a new one on every meaningful save.
const BUNDLE_LIMIT = 128

type TestEntryPoints = typeof entryPoints
type LoadedTestBundle = { $tests?: TestEntryPoints }

let staging: string | null = null
let loaded = 0

function stagingDirectory(): string {
	if (staging === null) {
		staging = mkdtempSync(path.join(tmpdir(), "essence-lsp-tests-"))
	}

	return staging
}

// NOTE: The bundle is named after its own hash, so an edit that changed nothing
// the Compiler emits — a comment, a reformat — is a file that is already there
// and already imported, and the run costs one evaluation rather than a load.
function stage(hash: string, code: string): string {
	let directory = path.join(stagingDirectory(), hash)
	let file = path.join(directory, "tests.mjs")

	mkdirSync(directory, { recursive: true })
	writeFileSync(file, code)

	return file
}

// NOTE: An overlay always wins over disk. The buffer an Editor holds is the
// only truthful version of a file that has not been saved, and may be the only
// version of one that is not on disk at all.
function hostOf(overlays: Record<string, string>): ModuleHost {
	return {
		readFile(filePath: string): string | undefined {
			let overlay = overlays[filePath]

			if (overlay !== undefined) {
				return overlay
			}

			try {
				return readFileSync(filePath, "utf-8")
			} catch {
				return undefined
			}
		},
	}
}

function rendered(error: unknown): string {
	return error instanceof Error
		? (error.stack ?? error.message)
		: String(error)
}

// NOTE: The tests of one Module as an Editor needs them — where each one
// stands, what it is tagged, and whether it would run — read off the manifest
// the Compiler emitted rather than off anything a run produced. It is answered
// even for a run that was narrowed to one test, because a tree lists what
// exists and a narrowing is about what happens.
function sitesOf(registry: Registry, entry: string): Array<TestSite> {
	return registry.tests.map(({ entry: test }) => ({
		id: test.id,
		name: test.name,
		suitePath: test.suitePath,
		file: entry,
		range: test.position,
		keywordRange: test.keywordPosition,
		tags: test.tags,
		focused: test.focused,
		skipped: test.skipped,
	}))
}

async function runEntry(
	request: Extract<TestWorkerRequest, { kind: "run" }>,
	entry: string,
): Promise<TestWorkerResponse> {
	let answer = (
		events: Array<TestEvent>,
		sites: Array<TestSite>,
		focused: boolean,
		compiled: boolean,
		problem: string | null,
	): TestWorkerResponse => ({
		kind: "entry",
		run: request.run,
		entry,
		events,
		sites,
		focused,
		compiled,
		problem,
	})
	let bundle: string

	try {
		let emitted = await compileToMemory(entry, {
			host: hostOf(request.overlays),
			tests: true,
		})

		if (emitted.code === "") {
			// NOTE: What stopped it, said in one line. The Diagnostics
			// themselves are the analysis's to publish — out of the same
			// buffers, at the same Positions — so what is worth carrying back
			// is why there is no result rather than a second copy of the
			// squiggles.
			return answer(
				[],
				[],
				false,
				false,
				emitted.diagnostics
					.map(
						(diagnostic) =>
							`[${diagnostic.code}] ${diagnostic.message}`,
					)
					.join("; ") || "the compile stopped",
			)
		}

		bundle = stage(emitted.bundleHash, emitted.code)
	} catch (error) {
		return answer([], [], false, false, rendered(error))
	}

	try {
		let module = (await import(
			pathToFileURL(bundle).href
		)) as LoadedTestBundle
		let tests = module.$tests

		loaded += 1

		if (tests === undefined) {
			return answer([], [], false, true, null)
		}

		// NOTE: The tests of THIS Module and no others. A file two entries
		// import would otherwise have its tests reported once per importer, and
		// the session would have to decide which report to believe. An entry is
		// a file that WROTE a section, so every section is somebody's entry
		// exactly once.
		let registry = tests.registryOf(
			tests.registry().modules.filter((each) => each.module === entry),
		)
		let filters = {
			...request.filters,
			...(request.ids.length > 0 ? { ids: request.ids } : {}),
		}
		let events: Array<TestEvent> = []

		tests.run(registry, {
			// NOTE: The bundle's own bookends are dropped. One cycle may cover
			// several entries and is one run as far as a client is concerned;
			// the counts it needs travel on the notification, and every event
			// left here is about a test and carries its id.
			sink: (event) => {
				if (event.kind === "run-start" || event.kind === "run-end") {
					return
				}

				events.push(event)
			},
			filters,
		})

		return answer(
			events,
			sitesOf(registry, entry),
			tests.select(registry, request.filters).focused,
			true,
			null,
		)
	} catch (error) {
		return answer([], [], false, true, rendered(error))
	}
}

function send(message: TestWorkerResponse): void {
	parentPort?.postMessage(message)
}

async function handle(request: TestWorkerRequest): Promise<void> {
	if (request.kind === "close") {
		parentPort?.close()

		return
	}

	for (let entry of request.entries) {
		send(await runEntry(request, entry))
	}

	send({
		kind: "done",
		run: request.run,
		exhausted: loaded >= BUNDLE_LIMIT,
	})
}

// NOTE: One request at a time, in the order they arrived. A session never has
// two runs in flight — it terminates the Worker to cancel one — but a message
// arriving while the previous one is still compiling would otherwise interleave
// two Diagnostic collections, which is the very thing this Worker exists to
// keep apart.
let queue: Promise<void> = Promise.resolve()

parentPort?.on("message", (request: TestWorkerRequest) => {
	queue = queue.then(() => handle(request)).catch(() => {})
})

send({ kind: "ready" })
