import { describe, expect, it } from "bun:test"
import {
	existsSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"

import type { EncodedValue } from "@essence-lang/runtime/Generators"
import type {
	CorpusStore,
	StoredValue,
	TestEvent,
} from "@essence-lang/runtime/Testing"

import { relativeIdentityKey, testIdentityKey } from "../enricher/tests"
import {
	collectCorpusChanges,
	CORPUS_LIMIT,
	corpusFileOf,
	parseCorpusFile,
	printCorpusFile,
	readCorpus,
	writeCorpus,
} from "../testing/corpus"

// NOTE: The companion a property test's failing values live in — what it looks
// like on disk, what a run's changes do to it, and what a file nobody should
// have edited is read as. Nothing here runs a test: what a run REPORTS is the
// runtime's spec, and what is done with the report is here.

const whole = (digits: string): EncodedValue => ({
	kind: "integer",
	value: digits,
})

function values(digits: string): Array<StoredValue> {
	return [{ name: "n", data: whole(digits) }]
}

// NOTE: The body is AWAITED before the directory goes. Everything the store
// does is a file, and a `finally` that ran while the write was still in flight
// would take the file away underneath it.
async function withDirectory<Value>(
	body: (directory: string) => Promise<Value>,
): Promise<Value> {
	let directory = mkdtempSync(path.join(tmpdir(), "essence-corpus-"))

	try {
		return await body(directory)
	} finally {
		rmSync(directory, { recursive: true, force: true })
	}
}

function fileOf(directory: string): string {
	return corpusFileOf(path.join(directory, "Season.es"))
}

function propertyEvent(
	overrides: Partial<Extract<TestEvent, { kind: "property" }>> = {},
): TestEvent {
	return {
		schema: 1,
		kind: "property",
		id: "/Season.es/stays small",
		name: "stays small",
		module: "/Season.es",
		key: "stays small",
		cases: 100,
		requested: 100,
		seed: "deadbeef",
		shrinks: 0,
		counterexample: null,
		replayed: 0,
		stale: [],
		fromCorpus: false,
		encoded: null,
		...overrides,
	}
}

describe("The counterexample companion file", () => {
	it("names a file beside the source, a sibling of the snapshots", () => {
		expect(corpusFileOf("/project/Season.es")).toBe(
			path.join("/project", "__counterexamples__", "Season.es.json"),
		)
	})

	it("reads back what it wrote", () => {
		let entries: CorpusStore = {
			"stays small": [{ values: values("500") }, { values: values("7") }],
			"suite/other": [{ values: values("0") }],
		}

		expect(parseCorpusFile(printCorpusFile(entries))).toEqual(entries)
	})

	// NOTE: Byte-stable, so that recording the same thing twice writes the same
	// file and a diff shows what CHANGED rather than what moved.
	it("writes the same bytes for the same entries in any order", () => {
		let first = printCorpusFile({
			b: [{ values: values("1") }],
			a: [{ values: values("2") }],
		})
		let second = printCorpusFile({
			a: [{ values: values("2") }],
			b: [{ values: values("1") }],
		})

		expect(first).toBe(second)
		expect(first.endsWith("}\n")).toBe(true)
		expect(first).toContain('\n\t"entries": {')
	})

	// NOTE: Null rather than an empty store, and the two must never be
	// confused: an empty store is a file the next write may lay a value over,
	// and a mangled one — a merge conflict, a stray edit — is a file the next
	// write must LEAVE, or everything its bytes still hold is gone.
	it("refuses a file it can not parse", () => {
		expect(parseCorpusFile("not json at all")).toBeNull()
		expect(parseCorpusFile("[]")).toBeNull()
		expect(parseCorpusFile("")).toBeNull()
	})

	// NOTE: A corpus is an optimisation over a search that works without it, so
	// the worst a version nobody here understands can cost is the values it
	// held — but they are held, not overwritten.
	it("refuses a file of another schema", () => {
		expect(
			parseCorpusFile(
				JSON.stringify({
					schema: 2,
					entries: { a: [{ values: values("1") }] },
				}),
			),
		).toBeNull()
	})

	it("leaves out an entry that is not a List of named values", () => {
		expect(
			parseCorpusFile(
				JSON.stringify({
					schema: 1,
					entries: {
						kept: [{ values: values("1") }, { values: "nothing" }],
						gone: [{ values: [{ name: 7, data: whole("1") }] }],
						never: "not a list",
					},
				}),
			),
		).toEqual({ kept: [{ values: values("1") }] })
	})
})

describe("Reading a run's stored counterexamples", () => {
	it("answers an empty store for a Module with no companion", async () => {
		await withDirectory(async (directory) => {
			let module = path.join(directory, "Season.es")

			expect((await readCorpus([module])).stores).toEqual({
				[module]: {},
			})
		})
	})

	// NOTE: THE reason unreadable is its own answer. The run before this fix
	// read a mangled file as empty, replayed nothing — correct — and then the
	// next failing write rewrote the file whole from that emptiness, silently
	// discarding every counterexample the bytes still held.
	it("says a mangled companion out loud, and never writes over it", async () => {
		await withDirectory(async (directory) => {
			let module = path.join(directory, "Season.es")
			let mangled = "<<<<<<< HEAD not json at all"

			await writeCorpus({
				corpus: { stores: {}, unreadable: [] },
				additions: [{ module, key: "small", values: values("7") }],
				removals: [],
			})

			let filePath = fileOf(directory)

			writeFileSync(filePath, mangled)

			let reading = await readCorpus([module])

			expect(reading.stores[module]).toEqual({})
			expect(reading.unreadable).toHaveLength(1)
			expect(reading.unreadable[0]?.problem).toContain(
				"not a corpus file",
			)

			let written = await writeCorpus({
				corpus: reading,
				additions: [{ module, key: "small", values: values("9") }],
				removals: [],
			})

			expect(written.files).toBe(0)
			expect(readFileSync(filePath, "utf8")).toBe(mangled)
		})
	})

	it("answers what the companion holds", async () => {
		await withDirectory(async (directory) => {
			let module = path.join(directory, "Season.es")

			await writeCorpus({
				corpus: { stores: {}, unreadable: [] },
				additions: [
					{ module, key: "stays small", values: values("500") },
				],
				removals: [],
			})

			expect((await readCorpus([module])).stores).toEqual({
				[module]: { "stays small": [{ values: values("500") }] },
			})
		})
	})
})

describe("Writing what a run said about its corpus", () => {
	it("writes nothing where a run said nothing", async () => {
		await withDirectory(async (directory) => {
			let written = await writeCorpus({
				corpus: { stores: {}, unreadable: [] },
				additions: [],
				removals: [],
			})

			expect(written).toMatchObject({ files: 0, recorded: 0, dropped: 0 })
			expect(existsSync(fileOf(directory))).toBe(false)
		})
	})

	it("puts the newest counterexample at the front", async () => {
		await withDirectory(async (directory) => {
			let module = path.join(directory, "Season.es")

			await writeCorpus({
				corpus: { stores: {}, unreadable: [] },
				additions: [{ module, key: "small", values: values("7") }],
				removals: [],
			})
			await writeCorpus({
				corpus: await readCorpus([module]),
				additions: [{ module, key: "small", values: values("9") }],
				removals: [],
			})

			expect((await readCorpus([module])).stores[module]).toEqual({
				small: [{ values: values("9") }, { values: values("7") }],
			})
		})
	})

	// NOTE: By the DATA rather than by the printed value. A property that fails
	// on the same value on ten runs would otherwise fill its own corpus with one
	// value and push every other one out.
	it("does not store one counterexample twice", async () => {
		await withDirectory(async (directory) => {
			let module = path.join(directory, "Season.es")
			let corpus = {
				stores: {
					[module]: { small: [{ values: values("7") }] },
				},
				unreadable: [],
			}
			let written = await writeCorpus({
				corpus,
				additions: [{ module, key: "small", values: values("7") }],
				removals: [],
			})

			expect(written).toMatchObject({ files: 0, recorded: 0 })
		})
	})

	it("keeps at most the ten newest", async () => {
		await withDirectory(async (directory) => {
			let module = path.join(directory, "Season.es")

			for (let index = 0; index < CORPUS_LIMIT + 3; index++) {
				await writeCorpus({
					corpus: await readCorpus([module]),
					additions: [
						{ module, key: "small", values: values(String(index)) },
					],
					removals: [],
				})
			}

			let stored =
				(await readCorpus([module])).stores[module]?.["small"] ?? []

			expect(stored).toHaveLength(CORPUS_LIMIT)
			expect(stored[0]).toEqual({ values: values("12") })
			expect(stored.at(-1)).toEqual({ values: values("3") })
		})
	})

	// NOTE: Every index is into the list as it was READ, so they are taken from
	// the back — dropping one from the front would move every index after it.
	it("drops exactly the entries a run could not read back", async () => {
		await withDirectory(async (directory) => {
			let module = path.join(directory, "Season.es")
			let corpus = {
				stores: {
					[module]: {
						small: [
							{ values: values("1") },
							{ values: values("2") },
							{ values: values("3") },
						],
					},
				},
				unreadable: [],
			}
			let written = await writeCorpus({
				corpus,
				additions: [],
				removals: [
					{ module, key: "small", index: 0 },
					{ module, key: "small", index: 2 },
				],
			})

			expect(written).toMatchObject({ dropped: 2, files: 1 })
			expect((await readCorpus([module])).stores[module]).toEqual({
				small: [{ values: values("2") }],
			})
		})
	})

	it("takes the file away where a write leaves nothing in it", async () => {
		await withDirectory(async (directory) => {
			let module = path.join(directory, "Season.es")

			await writeCorpus({
				corpus: { stores: {}, unreadable: [] },
				additions: [{ module, key: "small", values: values("7") }],
				removals: [],
			})

			expect(existsSync(fileOf(directory))).toBe(true)

			await writeCorpus({
				corpus: await readCorpus([module]),
				additions: [],
				removals: [{ module, key: "small", index: 0 }],
			})

			expect(existsSync(fileOf(directory))).toBe(false)
			// NOTE: The FILE goes; the directory may hold another Module's
			// companion, and an empty one is not litter anybody sees.
			expect(
				existsSync(path.join(directory, "__counterexamples__")),
			).toBe(true)
		})
	})

	// NOTE: The snapshot rule, for the same reason: a run narrowed by a filter
	// or a tag has not visited every test, and deleting what it did not visit
	// would lose a regression for the price of a `-f`.
	it("keeps a key no test of this run claimed", async () => {
		await withDirectory(async (directory) => {
			let module = path.join(directory, "Season.es")
			let corpus = {
				stores: {
					[module]: { elsewhere: [{ values: values("4") }] },
				},
				unreadable: [],
			}

			await writeCorpus({
				corpus,
				additions: [{ module, key: "small", values: values("7") }],
				removals: [],
			})

			expect((await readCorpus([module])).stores[module]).toEqual({
				elsewhere: [{ values: values("4") }],
				small: [{ values: values("7") }],
			})
		})
	})

	it("writes a file a reader can open", async () => {
		await withDirectory(async (directory) => {
			await writeCorpus({
				corpus: { stores: {}, unreadable: [] },
				additions: [
					{
						module: path.join(directory, "Season.es"),
						key: "stays small",
						values: values("500"),
					},
				],
				removals: [],
			})

			expect(readFileSync(fileOf(directory), "utf8")).toBe(
				printCorpusFile({
					"stays small": [{ values: values("500") }],
				}),
			)
		})
	})
})

describe("What a run's events say about its corpus", () => {
	it("takes a written-down failure as a value to keep", () => {
		expect(
			collectCorpusChanges([
				propertyEvent({ encoded: values("500"), stale: [1] }),
			]),
		).toEqual({
			additions: [
				{
					module: "/Season.es",
					key: "stays small",
					values: values("500"),
				},
			],
			removals: [{ module: "/Season.es", key: "stays small", index: 1 }],
		})
	})

	it("says nothing about a property that held", () => {
		expect(collectCorpusChanges([propertyEvent()])).toEqual({
			additions: [],
			removals: [],
		})
	})

	// NOTE: A run driven by a spec rather than by the command line may have no
	// path for a Module at all, and a counterexample with nowhere to live is a
	// counterexample nobody can store.
	it("says nothing about a Module with no path", () => {
		expect(
			collectCorpusChanges([
				propertyEvent({
					module: null,
					encoded: values("1"),
					stale: [0],
				}),
			]),
		).toEqual({ additions: [], removals: [] })
	})
})

// NOTE: The key a stored counterexample lives under, spelled by the Compiler
// here and by the runtime in `Testing.ts` — the runtime can not import this,
// because it is inlined into a user's bundle. The two are pinned to each other
// by this string and its twin in `testing.spec.ts`.
describe("The key a counterexample is stored under", () => {
	const identity = {
		modulePath: "/Season.es",
		suitePath: ["table"],
		name: "a/b",
	}

	it("leaves the Module step off and escapes the rest", () => {
		expect(relativeIdentityKey(identity, 2)).toBe("table/a\\/b/2")
	})

	it("is the identity key without its first step", () => {
		expect(testIdentityKey(identity, 2)).toEndWith(
			`/${relativeIdentityKey(identity, 2)}`,
		)
	})
})
