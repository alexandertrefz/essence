import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import * as path from "node:path"
import { pathToFileURL } from "node:url"
import { parentPort, workerData } from "node:worker_threads"

import { stopBundler } from "@essence-lang/compiler/bundler"
import { compileToMemory } from "@essence-lang/compiler/embed"
import type { ModuleHost } from "@essence-lang/compiler/modules"
import { defaultOptimiserOptions } from "@essence-lang/compiler/optimiser"
import {
	collectSnapshots,
	readSnapshots,
	removeStagingDirectory,
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
	TestEntry,
	TestSite,
	TestWorkerData,
	TestWorkerRequest,
	TestWorkerResponse,
} from "./testProtocol"

// The Worker end of the test session. It compiles each entry, stages the
// bundle, imports it and runs it. Only rendered events cross back, since a
// value's Type key is a Symbol of one realm. `buildServer.js` bundles this
// entry on its own. See "Why a Worker" in DEVELOPMENT.md.

// How many distinct bundles one Worker loads before it asks to be replaced.
// None can be unloaded, and an editing session compiles new ones constantly.
const BUNDLE_LIMIT = 128

// How long esbuild's service outlives the last run. It keeps the memory it grew
// until it stops, so a burst of edits reuses it warm and an idle window gives
// the memory back. See "The test session's esbuild" in
// packages/vscode-extension/DEVELOPMENT.md.
const BUNDLER_GRACE_IN_MILLISECONDS = 15_000

type TestEntryPoints = typeof entryPoints
type LoadedTestBundle = { $tests?: TestEntryPoints }

let { staging, bundlerGrace = BUNDLER_GRACE_IN_MILLISECONDS } =
	workerData as TestWorkerData
// Counts down to stopping esbuild's service, from the end of the last run.
let bundlerIdle: ReturnType<typeof setTimeout> | null = null
// Keyed by staged file, as `import()` caches a Module, so a bundle run again
// does not count toward `BUNDLE_LIMIT`.
let loaded = new Set<string>()

// Descriptor 0 is the Server's LSP input. Tests, and a Module's statements run
// as its bundle loads, read an empty input instead.
let fileSystem = process.getBuiltinModule("node:fs")
let readSync = fileSystem.readSync as (...values: Array<unknown>) => number

fileSystem.readSync = ((descriptor: unknown, ...rest: Array<unknown>) =>
	descriptor === 0
		? 0
		: readSync(descriptor, ...rest)) as typeof fileSystem.readSync

// A bundle is named for its hash, so unchanged sources reuse the Module this
// Worker already imported.
function stage(hash: string, code: string): string {
	let directory = path.join(staging, hash)
	let file = path.join(directory, "tests.mjs")

	mkdirSync(directory, { recursive: true, mode: 0o700 })
	writeFileSync(file, code)

	return file
}

// An overlay wins over disk: an unsaved buffer is the file's only true
// version, and maybe its only one.
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

// The tests of one Module, read off its manifest rather than off a run, even
// for a narrowed run, since a tree lists what exists.
function sitesOf(registry: Registry, entry: string): Array<TestSite> {
	return registry.tests.map(({ entry: test }) => ({
		id: test.id,
		name: test.name,
		row: test.row,
		// The runtime's own rule: a table test's rows report under their shared
		// template.
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
	entry: TestEntry,
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
		entry: entry.filePath,
		events,
		sites,
		focused,
		compiled,
		problem,
		rewrites,
	})
	// The project's own filters under the run's, so each project of a workspace
	// runs as its author asked.
	let filters = { ...request.filters, skipTags: entry.skipTags }
	let bundle: string

	try {
		let emitted = await compileToMemory(entry.filePath, {
			host: hostOf(request.overlays),
			tests: true,
			// Part of the compile mode and so of `bundleHash`, as `tests` is: the goals
			// are a suite synthesized from unchanged sources.
			contracts: entry.contracts,
			// Part of the Optimiser's Options and so of `bundleHash`, so instrumented and
			// plain bundles never share a staged name.
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
			// What stopped it, in one line. The analysis publishes the Diagnostics.
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

		loaded.add(bundle)

		if (tests === undefined) {
			return answer([], [], false, true, null)
		}

		// This Module's tests only, so a file several entries import reports once.
		// Every section is exactly one entry's.
		let registry = tests.registryOf(
			tests
				.registry()
				.modules.filter((each) => each.module === entry.filePath),
		)
		let selection = {
			...filters,
			...(request.ids.length > 0 ? { ids: request.ids } : {}),
		}
		let events: Array<TestEvent> = []
		// The stored snapshots of every Module of the bundle, read here, since
		// only the Worker has a filesystem.
		let modules = registry.modules.flatMap((each) =>
			each.module === null ? [] : [each.module],
		)
		let stored = await readSnapshots(modules)

		await tests.run(registry, {
			// The bundle's own start and end events are dropped: one cycle may cover
			// several entries, and its counts travel on the notification.
			sink: (event) => {
				if (event.kind === "run-start" || event.kind === "run-end") {
					return
				}

				events.push(event)
			},
			filters: selection,
			// A bundle without counters answers with nothing, at no cost.
			coverage: request.coverage,
			// The same instrumented run attributes coverage to tests, one
			// `test-coverage` event per test per Module, which lets a change re-run only
			// the tests it reached.
			coverageByTest: request.coverage,
			snapshots: stored,
			update: request.update,
		})

		// Only where the run was asked to record: a session runs on every keystroke,
		// and must not change files under a reader who is typing.
		let written = request.update
			? await writeSnapshots({
					snapshots: collectSnapshots(events),
					sources: sourcesOf(request.overlays, modules),
					stored,
					inline: () => Promise.resolve(writeInlineSnapshots),
					// Companion files are written here; a source comes back as an edit, since
					// its buffer may be unsaved.
					writeSources: false,
				})
			: null

		return answer(
			events,
			sitesOf(registry, entry.filePath),
			(await tests.select(registry, filters)).focused,
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

// What each Module of the run says: its unsaved buffer or its file. A rewrite
// is spliced into the text the run compiled, or it lands on the wrong line.
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
	// No countdown runs while a request is in flight.
	if (bundlerIdle !== null) {
		clearTimeout(bundlerIdle)
		bundlerIdle = null
	}

	if (request.kind === "close") {
		removeStagingDirectory(staging)
		parentPort?.close()

		return
	}

	for (let entry of request.entries) {
		send(await runEntry(request, entry))
	}

	// Unreferenced, so the countdown never keeps the Worker alive.
	bundlerIdle = setTimeout(() => {
		bundlerIdle = null
		void stopBundler()
	}, bundlerGrace)
	bundlerIdle.unref()

	send({
		kind: "done",
		run: request.run,
		exhausted: loaded.size >= BUNDLE_LIMIT,
	})
}

// One request at a time, in arrival order. A message arriving mid-compile
// would otherwise interleave two Diagnostic collections.
let queue: Promise<void> = Promise.resolve()

parentPort?.on("message", (request: TestWorkerRequest) => {
	queue = queue.then(() => handle(request)).catch(() => {})
})

send({ kind: "ready" })
