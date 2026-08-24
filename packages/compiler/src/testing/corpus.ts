import { mkdir, readFile, rm, writeFile } from "node:fs/promises"
import path from "node:path"

import type {
	CorpusStore,
	StoredCounterexample,
	TestEvent,
} from "@essence-lang/runtime/Testing"

// NOTE: The store's shape is the RUNTIME's, re-exported here rather than
// spelled again — unlike `SnapshotStore`, which is one alias of `Record<string,
// string>` and costs nothing to write twice. What a counterexample looks like is
// nested and typed, and two spellings of it would drift apart in silence.
export type {
	CorpusStore,
	StoredCounterexample,
	StoredValue,
} from "@essence-lang/runtime/Testing"

// NOTE: The STORED half of a property test — every value it has ever failed on,
// kept so that the next run asks about them before it draws anything. It is the
// same arrangement `matches snapshot` has next door, for the same reason: the
// runtime never touches a file, so whoever starts a run reads the entries and
// hands them over, and writes back whatever the run said about them.
//
// NOTE: What makes this worth keeping at all is that a random search does not
// find the same value twice. A seed would replay the case the search STARTED
// from rather than the one it shrank to, and the printed counterexample does
// not read back — so the only durable answer is the shrunk value written down
// as data, which is what `encode` in the runtime's `Generators` answers with.

// NOTE: Beside the source and a sibling of `__snapshots__`, so that a
// counterexample travels with the file it belongs to — a file that moves takes
// the values that broke it with it, and a file that is deleted leaves nothing
// behind that nothing names.
export const CORPUS_DIRECTORY = "__counterexamples__"

export function corpusFileOf(modulePath: string): string {
	return path.join(
		path.dirname(modulePath),
		CORPUS_DIRECTORY,
		`${path.basename(modulePath)}.json`,
	)
}

// NOTE: The one version this file has. A file written by a later Compiler is
// read as empty rather than half-understood: a corpus is an optimisation on top
// of a search that still works without it, so the worst a wrong version can
// cost is the values it held.
export const CORPUS_SCHEMA = 1

// NOTE: How many failing values one test keeps. Ten is enough that a property
// with several distinct bugs holds a case for each, and few enough that a suite
// re-running its whole corpus still runs while a reader waits. Beyond it the
// oldest go: a value that has been re-run and held on every run for ten
// failures is a value the search is no longer learning anything from.
export const CORPUS_LIMIT = 10

export type CorpusFile = { schema: number; entries: CorpusStore }

// NOTE: THE FORMAT, and the whole of it: JSON, one object of entries keyed by
// the test's identity without its Module step, each holding its
// counterexamples newest FIRST. It is JSON rather than the `.snap` format
// beside it because what is stored is DATA rather than text a value printed —
// nested, typed and never read by eye — and JSON is the one spelling of that
// nobody has to learn.
//
// It is printed with tab indentation and its keys in name order so that
// recording one twice writes the same bytes: a diff then shows what changed
// rather than what moved.
// NOTE: Null for a file that is not a corpus at all — mangled JSON, a merge
// conflict, the wrong schema. It is an answer rather than an empty store
// because the two must never be confused: an empty store is a file the next
// write may lay a value over, and a mangled one is a file the next write must
// LEAVE, or ten stored regressions vanish because one merge went wrong.
export function parseCorpusFile(text: string): CorpusStore | null {
	let parsed: unknown

	try {
		parsed = JSON.parse(text)
	} catch {
		return null
	}

	if (!isObject(parsed)) {
		return null
	}

	let file = parsed as Partial<CorpusFile>

	if (file.schema !== CORPUS_SCHEMA || !isObject(file.entries)) {
		return null
	}

	let entries: CorpusStore = {}

	for (let [key, stored] of Object.entries(file.entries)) {
		let kept = readCounterexamples(stored)

		// NOTE: A key whose every entry was refused is left out rather than
		// written back empty: an entry nothing can read is an entry nothing can
		// replay, and the next write is what takes it off the disk.
		if (kept.length > 0) {
			entries[key] = kept
		}
	}

	return entries
}

// NOTE: Only the shape a replay needs — a List of named values. What is INSIDE
// each of them is the generator's business: `decode` is what says whether the
// data still describes a value of the Type, and it answers nothing rather than
// throwing wherever it does not.
function readCounterexamples(stored: unknown): Array<StoredCounterexample> {
	if (!Array.isArray(stored)) {
		return []
	}

	return stored.flatMap((entry): Array<StoredCounterexample> => {
		if (!isObject(entry) || !Array.isArray(entry.values)) {
			return []
		}

		let values = entry.values as Array<unknown>
		let named = values.every(
			(value) =>
				isObject(value) &&
				typeof value.name === "string" &&
				isObject(value.data),
		)

		return named ? [entry as StoredCounterexample] : []
	})
}

export function printCorpusFile(entries: CorpusStore): string {
	let sorted: CorpusStore = {}

	for (let key of Object.keys(entries).sort()) {
		sorted[key] = entries[key] as Array<StoredCounterexample>
	}

	return `${JSON.stringify(
		{ schema: CORPUS_SCHEMA, entries: sorted },
		null,
		"\t",
	)}\n`
}

function isObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value)
}

// NOTE: The stored counterexamples of every Module of the run, keyed by the
// Module's canonical path — the shape the runtime's `RunOptions.counterexamples`
// takes. A Module with no companion file has an empty entry rather than none,
// so that looking one up is always a lookup and never a question about the
// disk.
// NOTE: What a read found, in two halves: the stores a run consults, and the
// Modules whose companion EXISTS but could not be read — which the run treats
// as holding nothing, and the writer refuses to touch. A missing file is an
// empty store, not an unreadable one: absence is the ordinary state of a
// Module nothing has failed in.
export type CorpusReading = {
	stores: Record<string, CorpusStore>
	unreadable: Array<{ module: string; problem: string }>
}

export async function readCorpus(
	modules: Iterable<string>,
): Promise<CorpusReading> {
	let stores: Record<string, CorpusStore> = {}
	let unreadable: Array<{ module: string; problem: string }> = []

	for (let module of modules) {
		let filePath = corpusFileOf(module)
		let text: string

		try {
			text = await readFile(filePath, "utf8")
		} catch (error) {
			stores[module] = {}

			// NOTE: Only absence is ordinary. A file that is there and cannot
			// be read is a file the writer must not rewrite from nothing.
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
				unreadable.push({
					module,
					problem: `${filePath}: ${describe(error)}`,
				})
			}

			continue
		}

		let parsed = parseCorpusFile(text)

		if (parsed === null) {
			stores[module] = {}
			unreadable.push({
				module,
				problem: `${filePath}: not a corpus file — fix it or delete it; nothing stored there is replayed, and nothing will be written over it`,
			})

			continue
		}

		stores[module] = parsed
	}

	return { stores, unreadable }
}

// NOTE: One counterexample to write down, under the Module and key the run
// said it belongs to.
export type CorpusAddition = {
	module: string
	key: string
	values: StoredCounterexample["values"]
}

// NOTE: One entry the run could no longer read back, by its index in the list
// as it was READ — which is why every removal of a key is applied before any
// addition to it, and why nothing else may reorder a list in between.
export type CorpusRemoval = { module: string; key: string; index: number }

export type CorpusChanges = {
	additions: Array<CorpusAddition>
	removals: Array<CorpusRemoval>
}

export type CorpusWrites = {
	recorded: number
	dropped: number
	files: number
	problems: Array<string>
}

export const noCorpusWrites: CorpusWrites = {
	recorded: 0,
	dropped: 0,
	files: 0,
	problems: [],
}

// NOTE: Everything a run said about the values it failed on, read out of the
// event stream. A failure that could be written down is a value to keep; an
// entry the generators no longer read back is one to drop. Both are on the
// `property` event, which carries the Module and the key so that nothing out
// here has to take an identity apart.
export function collectCorpusChanges(events: Array<TestEvent>): CorpusChanges {
	let additions: Array<CorpusAddition> = []
	let removals: Array<CorpusRemoval> = []

	for (let event of events) {
		if (event.kind !== "property" || event.module === null) {
			continue
		}

		for (let index of event.stale) {
			removals.push({ module: event.module, key: event.key, index })
		}

		if (event.encoded !== null) {
			additions.push({
				module: event.module,
				key: event.key,
				values: event.encoded,
			})
		}
	}

	return { additions, removals }
}

// NOTE: The changes a run reported, laid over the entries it read. A new
// counterexample goes at the FRONT — the most recent failure is the one most
// worth asking about first — and one the file already holds is not written
// twice, because a property that fails on the same value on ten runs would
// otherwise fill its own corpus with one value.
//
// NOTE: A key the file holds that no test of this run claimed is KEPT, exactly
// as an unvisited snapshot is. A run narrowed by `--filter` or by a tag has not
// visited every test, and deleting what it did not visit would lose a
// regression for the price of a filter. Only an entry the run READ and could
// not decode is dropped, because that is a fact about the entry rather than
// about which tests ran.
export async function writeCorpus(options: {
	corpus: CorpusReading
	additions: Array<CorpusAddition>
	removals: Array<CorpusRemoval>
}): Promise<CorpusWrites> {
	let { corpus, additions, removals } = options
	let modules = [
		...new Set([
			...additions.map((addition) => addition.module),
			...removals.map((removal) => removal.module),
		]),
	].sort()

	if (modules.length === 0) {
		return noCorpusWrites
	}

	// NOTE: A companion the read could not make sense of is never written
	// over: the store this run held for it was EMPTY, and laying one new value
	// over empty would rewrite the file whole — every counterexample a mangled
	// file still holds in its bytes, gone for one merge conflict. The file
	// stays as it is until somebody fixes or deletes it, and the read is what
	// already said so out loud.
	let unreadable = new Set(corpus.unreadable.map((entry) => entry.module))

	let problems: Array<string> = []
	let recorded = 0
	let dropped = 0
	let files = 0

	for (let module of modules) {
		if (unreadable.has(module)) {
			continue
		}

		let entries = layOver(
			corpus.stores[module] ?? {},
			additions.filter((addition) => addition.module === module),
			removals.filter((removal) => removal.module === module),
		)

		if (entries.changed === 0) {
			continue
		}

		let problem = await writeStored(module, entries.store)

		if (problem !== null) {
			problems.push(problem)

			continue
		}

		files += 1
		recorded += entries.recorded
		dropped += entries.dropped
	}

	return { recorded, dropped, files, problems }
}

function layOver(
	previous: CorpusStore,
	additions: Array<CorpusAddition>,
	removals: Array<CorpusRemoval>,
): { store: CorpusStore; recorded: number; dropped: number; changed: number } {
	let store: CorpusStore = {}

	for (let [key, stored] of Object.entries(previous)) {
		store[key] = [...stored]
	}

	let dropped = 0
	let recorded = 0

	// NOTE: The removals first, and from the back — every index is into the
	// list as it was read, and taking one out from the front would move every
	// index after it.
	for (let key of new Set(removals.map((removal) => removal.key))) {
		let indices = removals
			.filter((removal) => removal.key === key)
			.map((removal) => removal.index)
			.sort((left, right) => right - left)
		let stored = store[key]

		if (stored === undefined) {
			continue
		}

		for (let index of indices) {
			if (index >= 0 && index < stored.length) {
				stored.splice(index, 1)
				dropped += 1
			}
		}

		if (stored.length === 0) {
			delete store[key]
		}
	}

	for (let addition of additions) {
		let stored = store[addition.key] ?? []
		let written = JSON.stringify(addition.values)

		// NOTE: By the DATA rather than by the printed value. Two values that
		// write down the same way are one value, and two that do not are two
		// however alike they read.
		if (stored.some((entry) => JSON.stringify(entry.values) === written)) {
			continue
		}

		store[addition.key] = [{ values: addition.values }, ...stored].slice(
			0,
			CORPUS_LIMIT,
		)
		recorded += 1
	}

	return { store, recorded, dropped, changed: recorded + dropped }
}

// NOTE: The whole companion file written afresh, or taken away where the write
// left nothing in it. Only the FILE goes: the directory may hold a companion of
// another Module, and a directory left empty is not litter anybody sees.
async function writeStored(
	module: string,
	entries: CorpusStore,
): Promise<string | null> {
	let filePath = corpusFileOf(module)

	try {
		if (Object.keys(entries).length === 0) {
			await rm(filePath, { force: true })

			return null
		}

		await mkdir(path.dirname(filePath), { recursive: true })
		await writeFile(filePath, printCorpusFile(entries), "utf8")

		return null
	} catch (error) {
		return `${filePath}: ${describe(error)}`
	}
}

function describe(error: unknown): string {
	return error instanceof Error ? error.message : String(error)
}
