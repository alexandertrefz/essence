import { mkdir, readFile, rm, writeFile } from "node:fs/promises"
import path from "node:path"

import type {
	CorpusStore,
	StoredCounterexample,
	TestEvent,
} from "@essence-lang/runtime/Testing"

// The runtime's store shape, re-exported, since a nested Type spelled twice
// drifts.
export type {
	CorpusStore,
	StoredCounterexample,
	StoredValue,
} from "@essence-lang/runtime/Testing"

// The values a property test has failed on, replayed before anything is drawn,
// kept beside the source so they travel with their file. See "The
// failing-example corpus" in DEVELOPMENT.md.
export const CORPUS_DIRECTORY = "__counterexamples__"

export function corpusFileOf(modulePath: string): string {
	return path.join(
		path.dirname(modulePath),
		CORPUS_DIRECTORY,
		`${path.basename(modulePath)}.json`,
	)
}

// A file with another schema reads as no corpus, since a corpus only speeds up
// a search.
export const CORPUS_SCHEMA = 1

// How many failing values one test keeps. The oldest go first.
export const CORPUS_LIMIT = 10

// The format: JSON entries keyed by the test's identity without its Module
// step, each newest first.
export type CorpusFile = { schema: number; entries: CorpusStore }

// Null for a file that is not a corpus, which must be left alone rather than
// written over as an empty store would be.
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

		// A key with no readable entry is left out, and the next write drops it.
		if (kept.length > 0) {
			entries[key] = kept
		}
	}

	return entries
}

// Only the shape a replay needs. The runtime's `decode` judges what is inside.
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

// Tabs and sorted keys, so the same corpus writes the same bytes.
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

// The stores a run consults, and the Modules whose file exists but can not be
// read, which the writer leaves alone. A missing file is an empty store.
type CorpusReading = {
	stores: Record<string, CorpusStore>
	unreadable: Array<{ module: string; problem: string }>
}

// Every Module's stored counterexamples, keyed by canonical path, as
// `RunOptions.counterexamples` takes them. Every Module has an entry.
export async function readCorpus(
	modules: Iterable<string>,
): Promise<CorpusReading> {
	let stores: Record<string, CorpusStore> = {}
	let unreadable: Array<{ module: string; problem: string }> = []

	// Read in parallel. The unreadable list is sorted, so runs report in one order.
	await Promise.all(
		[...modules].map(async (module) => {
			let filePath = corpusFileOf(module)
			let text: string

			try {
				text = await readFile(filePath, "utf8")
			} catch (error) {
				stores[module] = {}

				// Only absence is ordinary. A file that can not be read must not be rewritten.
				if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
					unreadable.push({
						module,
						problem: `${filePath}: ${describe(error)}`,
					})
				}

				return
			}

			let parsed = parseCorpusFile(text)

			if (parsed === null) {
				stores[module] = {}
				unreadable.push({
					module,
					problem: `${filePath}: not a corpus file — fix it or delete it; nothing stored there is replayed, and nothing will be written over it`,
				})

				return
			}

			stores[module] = parsed
		}),
	)

	unreadable.sort((left, right) => left.module.localeCompare(right.module))

	return { stores, unreadable }
}

// One counterexample to write down, under its Module and key.
export type CorpusAddition = {
	module: string
	key: string
	values: StoredCounterexample["values"]
}

// An entry the run could not read back, by its index in the list as read. So
// removals apply before additions.
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

// The corpus changes a run reported on its `property` events.
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

// Lays a run's changes over what it read. See "The failing-example corpus" in
// DEVELOPMENT.md.
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

	// An unreadable companion is never written over, since this run held it empty.
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

	// Removals first, from the back, since indices are into the list as read.
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

		// Compared by data, not by printed value.
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

// The companion written afresh, or removed when empty. The directory stays.
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
