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

// NOTE: What `essence test` already ANSWERED, kept under the hash of everything
// the answer is a function of. Essence is pure: a test's outcome is decided by
// the code of its Module graph, by the stores it compares against, and by which
// tests the run selected — every one of which is a file or a flag, and every one
// of which is in the key below. So an entry nothing touched does not have to be
// staged, imported and run again to be told what it said last time; its EVENT
// STREAM is replayed instead, which is the same bytes a reader and a `--json`
// consumer would have been handed.
//
// NOTE: The unit is the ENTRY — one compiled bundle — because that is the unit
// the bundle cache names and the unit a watch session re-runs. Anything finer
// would have to key a test against a graph slice nothing computes, and anything
// coarser would lose the whole project to one edit.
//
// NOTE: A sibling of `cache.ts` in shape and deliberately so: same area rules,
// same atomic write, same age-ordered prune. What it holds is the only
// difference — JSON a run wrote rather than JavaScript the emitter did.
const AREA = "results"

// NOTE: The format, in the record and in the key both. In the RECORD so that a
// file an older toolchain wrote is read as a miss rather than half-understood;
// in the KEY so that a change to what a record means retires every name spelled
// under the old meaning, rather than leaving them to be read and refused one at
// a time.
export const RESULTS_FORMAT = "essence-results-1"

// NOTE: How many answers are kept. A record is a few kilobytes of JSON where a
// bundle is a few hundred, so this store may hold four times what the bundle
// cache does and still be smaller than it. Eviction is by age rather than by
// use, exactly as next door: a record is written once under a name that can only
// mean it, and what a wrongly evicted one costs is one re-run.
const KEPT_RESULTS = 2048

// NOTE: What one entry answered, whole. `events` is that entry's stream verbatim
// and WITHOUT the run's bookends — `run-start` and `run-end` belong to the run
// rather than to a bundle, and a replay is folded into a run that writes its
// own.
export type ResultRecord = {
	format: string
	entry: string
	// NOTE: Every tag the entry's registry carries, so that `--tag nonsense` can
	// still be told it named nothing without the bundle being loaded to ask.
	tags: Array<string>
	// NOTE: How many tests the entry PLANNED under the keyed filters, which is
	// what the run's `run-start` has to count as its own — the very number the
	// selection gave the entry when it ran, written down rather than worked out
	// again from the stream by every reader.
	tests: number
	// NOTE: How many tests the entry's `--filter` matched, whatever narrowed
	// them afterwards — the count `reportUnmatchedFilter` adds up across a run.
	matched: number
	// NOTE: Every Module of this entry that HAS tests, in the order the bundle
	// reported them, and the ones this entry was the one to run. Two entries that
	// reach one Module both carry its tests and only one of them may run them,
	// which `claimRegistries` decides across the whole run — so a replay has to
	// prove it would still be handed the same Modules it was handed when it was
	// recorded. Recorded here because the bundle a hit does not load can not be
	// asked.
	modules: Array<string>
	claimed: Array<string>
	events: Array<TestEvent>
}

// NOTE: Where the answers live, or `null` when the user turned this cache off.
// One variable does both — `ESSENCE_RESULTS_CACHE=off` for a run that has to be
// live, `ESSENCE_RESULTS_CACHE=<path>` for a spec that may not touch the user's
// — which is the rule every other area follows.
export function resultCacheDirectory(): string | null {
	return isCacheDisabled(AREA) ? null : cacheDirectory(AREA)
}

function resultFile(directory: string, key: string): string {
	return path.join(directory, `${key}.json`)
}

// NOTE: Which JavaScript ran the tests. A bundle inlines its own runtime but not
// its own host, and what a host decides reaches an event: how a Number prints,
// what a `sort` does with equal keys, which `Intl` data is compiled in. Two
// hosts are two runs.
//
// NOTE: Read off `process.versions` rather than off the `Bun` global, which is
// the same string without a global this package would otherwise have to declare.
export function hostKey(): string {
	let bun = process.versions.bun

	return bun === undefined ? `node@${process.versions.node}` : `bun@${bun}`
}

// NOTE: One companion file of one Module, as text — the `.snap`, the `.bench`
// and the `.json` a Module's tests compare themselves against. A file that is
// not there is the empty string rather than an absence, so that deleting a
// stored snapshot is a different key rather than the same one.
type StorePart = { label: string; text: string }

const STORE_KINDS: Array<[kind: string, fileOf: (module: string) => string]> = [
	["snapshots", snapshotFileOf],
	["benchmarks", benchmarkFileOf],
	["counterexamples", corpusFileOf],
]

type StoreReader = (modules: Iterable<string>) => Promise<Array<StorePart>>

// NOTE: Reads each companion ONCE per run however many entries reach the Module
// it belongs to. A project where twenty test files import one Module would
// otherwise read that Module's three companions twenty times to mix the same
// three strings into twenty keys.
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

		// NOTE: Sorted, so that the same set of Modules reached from two entries
		// mixes the same bytes — the rule `hashGraph` follows next door, for the
		// same reason.
		for (let module of [...modules].sort()) {
			for (let [kind, fileOf] of STORE_KINDS) {
				parts.push({
					// NOTE: The BASE NAME rather than the path. The paths are in
					// the bundle hash already, which is mixed in beside this, and
					// naming them again would make the same project keyed twice
					// under two checkouts.
					label: `${path.basename(module)}:${kind}`,
					text: await textOf(fileOf(module)),
				})
			}
		}

		return parts
	}
}

// NOTE: What a run NARROWED itself to, as the key sees it. The filters are in
// the key rather than a reason to refuse the cache, so that a project whose
// configuration skips `slow` by default caches its ordinary run — and so that
// `--tag slow` is an answer of its own rather than a run that can never be
// remembered.
export type KeyedFilters = {
	filter: string | null
	tags: Array<string>
	skipTags: Array<string>
	bench: boolean
}

export type ResultKeyParts = {
	// NOTE: The bundle cache's own key, which already digests the whole Module
	// graph's content, the Compiler's sources, the standard library, the runtime
	// and the Optimiser Options. Everything about the CODE is in this one string,
	// which is why nothing about the code is spelled again below.
	bundleHash: string
	stores: Array<StorePart>
	filters: KeyedFilters
	host: string
}

// NOTE: Length-prefixed and counted, exactly as `embed/hash.ts` mixes, so that
// no two different sequences of parts can spell the same bytes.
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

	// NOTE: The count before the list, and the same for the stores below.
	// Length-prefixing makes one part unambiguous; a count is what makes a LIST
	// of them unambiguous, since a run with two tags and none skipped would
	// otherwise mix the same bytes as one with one of each.
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

// NOTE: The name the bundle cache wrote this entry under, read back off the file
// it handed over. A cache entry is `<key>.mjs` and a scratch bundle — what an
// emit with something to say produces — is `<key>.run.mjs`; both are named by the
// same hash, and the hash is what this needs. Taking it off the file rather than
// hashing the graph a second time is what keeps the two from ever disagreeing.
export function bundleHashOf(outputFileName: string): string {
	let name = path.basename(outputFileName)
	let dot = name.indexOf(".")

	return dot === -1 ? name : name.slice(0, dot)
}

// NOTE: A record whose shape is anything but this one is read as a MISS. A
// cache is an optimisation on top of a run that still works without it, so the
// worst a file from another toolchain can cost is the run it would have saved —
// and refusing it here is what makes that true.
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

// NOTE: Only that it IS an event, by the two fields every one of them carries.
// What is inside a kind is the stream's business and never this file's — the
// stream is versioned separately from the payload, and a record holding a kind
// this build has never heard of is a record it may still replay.
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
		// NOTE: No file, an unreadable directory, a half-written name — every one
		// of them means the same thing here, which is that there is nothing to
		// read. Running the tests is always available and always correct.
		return null
	}
}

// NOTE: Written through the atomic rename every other store uses, and NOT
// replaced: the name is the hash of everything the answer depends on, so a file
// already sitting there is an answer to the same question. Whichever run got
// there first wrote it, and the durations in it are as true as this one's.
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
		// NOTE: A failure to remember is not a failure of the run. The tests have
		// already answered; a read-only cache directory or a full disk costs the
		// next run its shortcut and nothing else.
	}
}

// NOTE: Only ever after a write, so a run that found what it came for touches no
// directory at all. Failure is ignored throughout: a record that outlives its
// welcome costs disk rather than correctness.
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
		// NOTE: Nothing pruned is nothing wrong.
	}
}
