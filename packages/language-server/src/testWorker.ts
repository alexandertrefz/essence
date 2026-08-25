import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import * as path from "node:path"
import { pathToFileURL } from "node:url"
import { parentPort } from "node:worker_threads"

import { compileToMemory } from "@essence-lang/compiler/embed"
import type { ModuleHost } from "@essence-lang/compiler/modules"
import { defaultOptimiserOptions } from "@essence-lang/compiler/optimiser"
import {
	collectSnapshots,
	readSnapshots,
	type SourceRewrite,
	writeSnapshots,
} from "@essence-lang/compiler/testing"
import { writeInlineSnapshots } from "@essence-lang/formatter/snapshots"
import {
	type entryPoints,
	pathOf,
	type Registry,
	type TestEvent,
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
		row: test.row,
		// NOTE: Through the runtime's own rule rather than a second copy of it
		// — the rows of a table test are reported under the template they
		// share, and the events say so too.
		suitePath: pathOf(test),
		file: entry,
		range: test.position,
		keywordRange: test.keywordPosition,
		tags: test.tags,
		focused: test.focused,
		skipped: test.skipped,
		benchmark: test.benchmark,
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
		rewrites: Array<SourceRewrite> = [],
	): TestWorkerResponse => ({
		kind: "entry",
		run: request.run,
		entry,
		events,
		sites,
		focused,
		compiled,
		problem,
		rewrites,
	})
	let bundle: string

	try {
		let emitted = await compileToMemory(entry, {
			host: hostOf(request.overlays),
			tests: true,
			// NOTE: The instrumentation is part of the Optimiser's Options, so
			// it is part of `bundleHash` — an instrumented bundle and a plain
			// one never share a staged name, and turning the setting on or off
			// mid-session compiles rather than answering out of what is
			// already loaded.
			...(request.coverage
				? {
						optimisation: {
							...defaultOptimiserOptions,
							coverage: true,
						},
					}
				: {}),
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
		// NOTE: The stored entries of every Module this bundle holds, read off
		// disk here — the Worker is the only end of the session with a
		// filesystem, and the bundle it drives has none at all.
		let modules = registry.modules.flatMap((each) =>
			each.module === null ? [] : [each.module],
		)
		let stored = await readSnapshots(modules)

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
			// NOTE: A bundle with no counters in it answers with nothing, so
			// asking costs a run that was not instrumented exactly nothing.
			coverage: request.coverage,
			// NOTE: Attribution — which test touched which point — rides on the
			// same instrumented run, so a session that counts also learns which
			// tests reach which lines, at the cost of one `test-coverage` event
			// per test per Module it touched. It is what lets a change re-run the
			// tests it reached rather than every test of the file. Free when
			// coverage is off, because then there are no counters to attribute.
			coverageByTest: request.coverage,
			snapshots: stored,
			update: request.update,
		})

		// NOTE: Only where the run was ASKED to record. Every other cycle
		// leaves the disk alone: a session runs on every keystroke, and a
		// snapshot written by one would be a file changing under a reader who
		// was only typing.
		let written = request.update
			? await writeSnapshots({
					snapshots: collectSnapshots(events),
					sources: sourcesOf(request.overlays, modules),
					stored,
					inline: () => Promise.resolve(writeInlineSnapshots),
					// NOTE: The companion files are written here; a SOURCE
					// comes back as an edit, because the buffer that produced
					// it may never have been saved.
					writeSources: false,
				})
			: null

		return answer(
			events,
			sitesOf(registry, entry),
			tests.select(registry, request.filters).focused,
			true,
			written === null || written.problems.length === 0
				? null
				: written.problems.join("; "),
			written?.sources ?? [],
		)
	} catch (error) {
		return answer([], [], false, true, rendered(error))
	}
}

// NOTE: What each Module of the run SAYS, which is the unsaved buffer where
// there is one and the file otherwise. A rewrite is spliced into the text the
// run was compiled from, and compiling one text while rewriting another is how
// a recorded value lands on the wrong line.
function sourcesOf(
	overlays: Record<string, string>,
	modules: Array<string>,
): Map<string, string> {
	let sources = new Map<string, string>()

	for (let module of modules) {
		let overlay = overlays[module]

		if (overlay !== undefined) {
			sources.set(module, overlay)

			continue
		}

		try {
			sources.set(module, readFileSync(module, "utf8"))
		} catch {}
	}

	return sources
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
