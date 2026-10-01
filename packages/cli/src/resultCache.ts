import { createHash, type Hash } from "node:crypto"
import { readdir, readFile, rm, stat } from "node:fs/promises"
import * as path from "node:path"

import {
	cacheDirectory,
	isCacheDisabled,
	writeAtomic,
} from "@essence-lang/compiler/cache"
import {
	benchmarkFileOf,
	corpusFileOf,
	snapshotFileOf,
} from "@essence-lang/compiler/testing"
import type { TestEvent } from "@essence-lang/runtime/Testing"

// What `essence test` already answered, one record per entry, keyed by
// everything the answer depends on. See "The result key" in DEVELOPMENT.md.
const AREA = "results"

// In the record, so a file an older toolchain wrote reads as a miss. In the key,
// so a change of meaning retires every older name at once.
export const RESULTS_FORMAT = "essence-results-2"

// Records are small, so this store keeps more entries than the bundle cache.
const KEPT_RESULTS = 2048

// What one entry answered. `events` is its stream verbatim, without the run's
// `run-start` and `run-end`.
export type ResultRecord = {
	format: string
	entry: string
	// So an unknown `--tag` is reported without loading the bundle.
	tags: Array<string>
	// How many tests the entry planned under the keyed filters, which
	// `run-start` counts.
	tests: number
	// How many tests the entry's `--filter` matched, before anything else
	// narrowed them.
	matched: number
	// The entry's Modules that have tests, in bundle order, and the ones it
	// claimed. A replay is valid only while it would claim the same ones.
	modules: Array<string>
	claimed: Array<string>
	events: Array<TestEvent>
}

// Where the answers live, or `null` when `ESSENCE_RESULTS_CACHE=off`. A path
// in the same variable moves the store.
export function resultCacheDirectory(): string | null {
	return isCacheDisabled(AREA) ? null : cacheDirectory(AREA)
}

function resultFile(directory: string, key: string): string {
	return path.join(directory, `${key}.json`)
}

// Which JavaScript host ran the tests. A bundle inlines its runtime but not its
// host, and the host decides things events show, such as how a Number prints.
export function hostKey(): string {
	let bun = process.versions.bun

	return bun === undefined ? `node@${process.versions.node}` : `bun@${bun}`
}

// One companion store of one Module, as text. A missing file is the empty
// string, so deleting a store changes the key.
type StorePart = { label: string; text: string }

const STORE_KINDS: Array<[kind: string, fileOf: (module: string) => string]> = [
	["snapshots", snapshotFileOf],
	["benchmarks", benchmarkFileOf],
	["counterexamples", corpusFileOf],
]

type StoreReader = (modules: Iterable<string>) => Promise<Array<StorePart>>

// Reads each companion once per run, however many entries reach its Module.
export function createStoreReader(): StoreReader {
	let read = new Map<string, Promise<string>>()

	let textOf = (file: string): Promise<string> => {
		let held = read.get(file)

		if (held === undefined) {
			held = readFile(file, "utf8").catch(() => "")
			read.set(file, held)
		}

		return held
	}

	return async (modules) => {
		let parts: Array<StorePart> = []

		// Sorted, so one set of Modules always mixes the same bytes.
		for (let module of [...modules].sort()) {
			for (let [kind, fileOf] of STORE_KINDS) {
				parts.push({
					// The base name only, so two checkouts of a project share keys.
					// The bundle hash already covers the Modules.
					label: `${path.basename(module)}:${kind}`,
					text: await textOf(fileOf(module)),
				})
			}
		}

		return parts
	}
}

// The filters a run narrowed itself to. They join the key, so a narrowed run
// is remembered as an answer of its own.
export type KeyedFilters = {
	filter: string | null
	tags: Array<string>
	skipTags: Array<string>
	bench: boolean
}

export type ResultKeyParts = {
	// The bundle cache's key, which covers everything about the code.
	bundleHash: string
	stores: Array<StorePart>
	filters: KeyedFilters
	host: string
}

// Length-prefixed, so no two sequences of parts spell the same bytes.
function mix(hash: Hash, text: string): void {
	hash.update(`${text.length}:${text}`)
}

export function resultKey(parts: ResultKeyParts): string {
	let hash = createHash("sha256")

	mix(hash, RESULTS_FORMAT)
	mix(hash, parts.host)
	mix(hash, parts.bundleHash)
	mix(hash, parts.filters.filter ?? "")
	mix(hash, parts.filters.bench ? "bench" : "plain")

	// Each list is preceded by its length, so two tags and no skipped ones
	// never mix like one of each. The stores are counted the same way.
	for (let named of [parts.filters.tags, parts.filters.skipTags]) {
		let sorted = [...new Set(named)].sort()

		mix(hash, String(sorted.length))

		for (let tag of sorted) {
			mix(hash, tag)
		}
	}

	mix(hash, String(parts.stores.length))

	for (let part of parts.stores) {
		mix(hash, part.label)
		mix(hash, part.text)
	}

	return hash.digest("hex")
}

// The runtime modules that reach the world, as esbuild labels them in a bundle:
// by path from the runtime directory. Every test bundle links `Terminal` and
// `Randomness`, so those report their use at run time instead.
const EFFECTFUL_RUNTIME_LABELS = ["// Http.ts"]

// Any label at all. A minified bundle has none, and then what it links cannot
// be seen.
const RUNTIME_LABEL = /^\/\/ [\w./-]+\.ts$/m

// Whether this bundle links a runtime module that reaches the world. A bundle
// that cannot be read, or whose labels cannot be seen, counts as linking one.
export async function linksEffectfulRuntime(
	bundleFileName: string,
): Promise<boolean> {
	let text: string

	try {
		text = await readFile(bundleFileName, "utf8")
	} catch {
		return true
	}

	if (!RUNTIME_LABEL.test(text)) {
		return true
	}

	return EFFECTFUL_RUNTIME_LABELS.some((label) =>
		text.split("\n").includes(label),
	)
}

// The bundle cache's key, read off the bundle's file name: `<key>.mjs` or the
// scratch `<key>.run.mjs`. So the two caches never disagree about it.
export function bundleHashOf(outputFileName: string): string {
	let name = path.basename(outputFileName)
	let dot = name.indexOf(".")

	return dot === -1 ? name : name.slice(0, dot)
}

// A record of any other shape reads as a miss, so a foreign file costs at most
// the run it would have saved.
export function readRecord(text: string): ResultRecord | null {
	let parsed: unknown

	try {
		parsed = JSON.parse(text)
	} catch {
		return null
	}

	if (typeof parsed !== "object" || parsed === null) {
		return null
	}

	let record = parsed as Partial<ResultRecord>

	if (
		record.format !== RESULTS_FORMAT ||
		typeof record.entry !== "string" ||
		typeof record.tests !== "number" ||
		typeof record.matched !== "number" ||
		!isStringList(record.tags) ||
		!isStringList(record.modules) ||
		!isStringList(record.claimed) ||
		!Array.isArray(record.events) ||
		!record.events.every(isEvent)
	) {
		return null
	}

	return record as ResultRecord
}

function isStringList(value: unknown): value is Array<string> {
	return (
		Array.isArray(value) && value.every((item) => typeof item === "string")
	)
}

// Only that it is an event with a `kind`. A kind this build does not know may
// still be replayed.
function isEvent(value: unknown): value is TestEvent {
	return (
		typeof value === "object" &&
		value !== null &&
		typeof (value as { kind?: unknown }).kind === "string"
	)
}

export async function readResult(
	directory: string,
	key: string,
): Promise<ResultRecord | null> {
	try {
		return readRecord(await readFile(resultFile(directory, key), "utf8"))
	} catch {
		// Any failure is a miss.
		return null
	}
}

// Written atomically and never replaced: a file under the same key answers the
// same question.
export async function writeResult(
	directory: string,
	key: string,
	record: ResultRecord,
): Promise<void> {
	let file = resultFile(directory, key)

	try {
		if (await writeAtomic(file, `${JSON.stringify(record)}\n`)) {
			await prune(directory, file)
		}
	} catch {
		// A failure to remember only costs the next run its shortcut.
	}
}

// Runs only after a write, so a hit reads no directory. Failures are ignored,
// since a stale record only costs disk.
export async function prune(
	directory: string,
	keep: string,
	keptResults = KEPT_RESULTS,
): Promise<void> {
	try {
		let records = (await readdir(directory))
			.filter((name) => name.endsWith(".json"))
			.map((name) => path.join(directory, name))
			.filter((file) => file !== keep)

		if (records.length < keptResults) {
			return
		}

		let dated = await Promise.all(
			records.map(async (file) => ({
				file,
				modified: (await stat(file)).mtimeMs,
			})),
		)

		dated.sort((left, right) => right.modified - left.modified)

		for (let { file } of dated.slice(keptResults - 1)) {
			await rm(file, { force: true })
		}
	} catch {
		// A failed prune only costs disk.
	}
}
