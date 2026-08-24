import { describe, expect, it } from "bun:test"
import {
	mkdirSync,
	mkdtempSync,
	readdirSync,
	rmSync,
	writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"

import type { TestEvent } from "@essence-lang/runtime/Testing"

import {
	bundleHashOf,
	createStoreReader,
	hostKey,
	type KeyedFilters,
	prune,
	readRecord,
	readResult,
	RESULTS_FORMAT,
	type ResultKeyParts,
	type ResultRecord,
	resultCacheDirectory,
	resultKey,
	writeResult,
} from "../resultCache"

// NOTE: Every spec here works in a directory of its own and never asks
// `resultCacheDirectory` where the store is unless that is what it is about —
// the one place the environment is read is the pair of tests that prove the
// override works, and both of them put it back.
function withDirectory<Value>(body: (directory: string) => Value): Value {
	let directory = mkdtempSync(path.join(tmpdir(), "essence-results-"))

	try {
		return body(directory)
	} finally {
		rmSync(directory, { recursive: true, force: true })
	}
}

async function withDirectoryAsync<Value>(
	body: (directory: string) => Promise<Value>,
): Promise<Value> {
	let directory = mkdtempSync(path.join(tmpdir(), "essence-results-"))

	try {
		return await body(directory)
	} finally {
		rmSync(directory, { recursive: true, force: true })
	}
}

const plainFilters: KeyedFilters = {
	filter: null,
	tags: [],
	skipTags: [],
	bench: false,
}

const baseParts: ResultKeyParts = {
	bundleHash: "0123456789abcdef",
	stores: [
		{ label: "Standings.es:snapshots", text: "" },
		{ label: "Standings.es:benchmarks", text: "" },
		{ label: "Standings.es:counterexamples", text: "" },
	],
	filters: plainFilters,
	host: "bun@1.4.0",
}

function keyWith(changes: Partial<ResultKeyParts>): string {
	return resultKey({ ...baseParts, ...changes })
}

const passed: Array<TestEvent> = [
	{
		schema: 1,
		kind: "test-start",
		id: "/Standings.es/holds",
		name: "holds",
		suitePath: [],
		module: "/Standings.es",
		row: null,
	},
	{
		schema: 1,
		kind: "test-pass",
		id: "/Standings.es/holds",
		name: "holds",
		duration: 1,
		expectations: 1,
	},
]

const record: ResultRecord = {
	format: RESULTS_FORMAT,
	entry: "/Standings.tests.es",
	tags: ["slow"],
	tests: 1,
	matched: 1,
	modules: ["/Standings.es"],
	claimed: ["/Standings.es"],
	events: passed,
}

describe("the result cache's key", () => {
	it("names the same run the same way twice", () => {
		expect(keyWith({})).toBe(keyWith({}))
	})

	// NOTE: The bundle key is the whole of what the key says about CODE — it
	// already digests every Module of the graph, the Compiler, the standard
	// library and the Optimiser Options — so a change to a source or to a
	// dependency's source reaches this key through that one string.
	it("changes when the bundle it stands for changes", () => {
		expect(keyWith({ bundleHash: "fedcba9876543210" })).not.toBe(
			keyWith({}),
		)
	})

	it("changes when a stored snapshot changes", () => {
		let changed = baseParts.stores.map((part) =>
			part.label.endsWith(":snapshots")
				? { ...part, text: "the recorded text" }
				: part,
		)

		expect(keyWith({ stores: changed })).not.toBe(keyWith({}))
	})

	it("changes when a baseline or a counterexample changes", () => {
		for (let kind of [":benchmarks", ":counterexamples"]) {
			let changed = baseParts.stores.map((part) =>
				part.label.endsWith(kind) ? { ...part, text: "{}" } : part,
			)

			expect(keyWith({ stores: changed })).not.toBe(keyWith({}))
		}
	})

	it("changes with every filter the run resolved", () => {
		let variants: Array<KeyedFilters> = [
			{ ...plainFilters, filter: "leader" },
			{ ...plainFilters, tags: ["slow"] },
			{ ...plainFilters, skipTags: ["slow"] },
			{ ...plainFilters, bench: true },
		]
		let keys = variants.map((filters) => keyWith({ filters }))

		expect(new Set([...keys, keyWith({})]).size).toBe(keys.length + 1)
	})

	// NOTE: A tag named twice and a tag named in another order are the same run,
	// because `resolveFilters` has already made them one — so the key must not
	// pretend they are two and lose the entry.
	it("reads a tag set as a set", () => {
		expect(
			keyWith({
				filters: { ...plainFilters, tags: ["b", "a", "a"] },
			}),
		).toBe(keyWith({ filters: { ...plainFilters, tags: ["a", "b"] } }))
	})

	// NOTE: The counted lists are what makes this true. Without them one tag and
	// one skipped tag would mix the same bytes as two tags and none.
	it("does not confuse a tag with a skipped one", () => {
		expect(
			keyWith({ filters: { ...plainFilters, tags: ["a", "b"] } }),
		).not.toBe(
			keyWith({
				filters: { ...plainFilters, tags: ["a"], skipTags: ["b"] },
			}),
		)
	})

	it("changes with the host that would run the tests", () => {
		expect(keyWith({ host: "node@24.0.0" })).not.toBe(keyWith({}))
	})

	it("says which host this process is", () => {
		expect(hostKey()).toMatch(/^(bun|node)@/)
	})
})

describe("the companion stores a key reads", () => {
	it("reads all three beside a Module, and nothing for the ones absent", async () => {
		await withDirectoryAsync(async (directory) => {
			let module = path.join(directory, "Standings.es")

			mkdirSync(path.join(directory, "__snapshots__"), {
				recursive: true,
			})
			writeFileSync(
				path.join(directory, "__snapshots__", "Standings.es.snap"),
				"the table\n",
			)

			let parts = await createStoreReader()([module])

			expect(parts.map((part) => part.label)).toEqual([
				"Standings.es:snapshots",
				"Standings.es:benchmarks",
				"Standings.es:counterexamples",
			])
			expect(parts[0]!.text).toBe("the table\n")
			expect(parts[1]!.text).toBe("")
			expect(parts[2]!.text).toBe("")
		})
	})

	// NOTE: The order is the Modules' sorted, so two entries reaching one set of
	// Modules mix the same bytes whichever order their graphs reported them in.
	it("sorts the Modules it was handed", async () => {
		await withDirectoryAsync(async (directory) => {
			let read = createStoreReader()
			let modules = [
				path.join(directory, "Season.es"),
				path.join(directory, "Standings.es"),
			]
			let forwards = await read(modules)
			let backwards = await read([...modules].reverse())

			expect(backwards).toEqual(forwards)
		})
	})

	it("reads one Module's companions once however often it is asked", async () => {
		await withDirectoryAsync(async (directory) => {
			let read = createStoreReader()
			let module = path.join(directory, "Standings.es")

			expect((await read([module]))[0]!.text).toBe("")

			mkdirSync(path.join(directory, "__snapshots__"), {
				recursive: true,
			})
			writeFileSync(
				path.join(directory, "__snapshots__", "Standings.es.snap"),
				"written after the first read\n",
			)

			// NOTE: One run reads a companion once. What lands beside a Module
			// while the run is deciding its keys is the NEXT run's business —
			// which is also what keeps every entry of one run keyed against one
			// picture of the disk.
			expect((await read([module]))[0]!.text).toBe("")
		})
	})
})

describe("the bundle hash a record is keyed from", () => {
	it("reads the name off a cache entry and off a scratch bundle alike", () => {
		expect(bundleHashOf("/cache/cli/abc123.mjs")).toBe("abc123")
		expect(bundleHashOf("/cache/cli/abc123.run.mjs")).toBe("abc123")
	})
})

describe("a stored record", () => {
	it("reads back what was written", () => {
		expect(readRecord(JSON.stringify(record))).toEqual(record)
	})

	it("refuses anything that is not one", () => {
		let refused = [
			"",
			"not json",
			"[]",
			"null",
			JSON.stringify({ ...record, format: "essence-results-0" }),
			JSON.stringify({ ...record, tests: "1" }),
			JSON.stringify({ ...record, tags: [1] }),
			JSON.stringify({ ...record, claimed: null }),
			JSON.stringify({ ...record, events: [{ schema: 1 }] }),
			JSON.stringify({ ...record, events: "none" }),
		]

		for (let text of refused) {
			expect(readRecord(text)).toBeNull()
		}
	})

	// NOTE: The stream is versioned apart from the payload, so a record holding a
	// kind this build has never heard of is a record it may still replay — the
	// same tolerance every consumer of the stream is asked for.
	it("keeps an event kind it does not know", () => {
		let unknown = readRecord(
			JSON.stringify({
				...record,
				events: [...passed, { schema: 1, kind: "something-later" }],
			}),
		)

		expect(unknown?.events).toHaveLength(3)
	})
})

describe("the result store", () => {
	it("writes a record and reads it back", async () => {
		await withDirectoryAsync(async (directory) => {
			await writeResult(directory, "key-one", record)

			expect(await readResult(directory, "key-one")).toEqual(record)
		})
	})

	it("answers nothing for a name it does not hold", async () => {
		await withDirectoryAsync(async (directory) => {
			expect(await readResult(directory, "key-two")).toBeNull()
		})
	})

	it("answers nothing for a file it can not read back", async () => {
		await withDirectoryAsync(async (directory) => {
			writeFileSync(path.join(directory, "key-three.json"), "{ broken")

			expect(await readResult(directory, "key-three")).toBeNull()
		})
	})

	// NOTE: The name is the hash of everything the answer depends on, so a file
	// already there answers the same question — whichever run wrote it first.
	it("does not rewrite a name it already holds", async () => {
		await withDirectoryAsync(async (directory) => {
			await writeResult(directory, "key-four", record)
			await writeResult(directory, "key-four", { ...record, tests: 99 })

			expect((await readResult(directory, "key-four"))?.tests).toBe(1)
		})
	})

	it("keeps the store to the size it was given, and keeps the newest write", async () => {
		await withDirectoryAsync(async (directory) => {
			for (let index = 0; index < 6; index += 1) {
				writeFileSync(
					path.join(directory, `old-${index}.json`),
					JSON.stringify(record),
				)
			}

			let keep = path.join(directory, "new.json")

			writeFileSync(keep, JSON.stringify(record))
			await prune(directory, keep, 3)

			let left = readdirSync(directory)

			expect(left).toHaveLength(3)
			expect(left).toContain("new.json")
		})
	})

	it("leaves a store under its limit alone", async () => {
		await withDirectoryAsync(async (directory) => {
			writeFileSync(
				path.join(directory, "one.json"),
				JSON.stringify(record),
			)

			let keep = path.join(directory, "two.json")

			writeFileSync(keep, JSON.stringify(record))
			await prune(directory, keep, 8)

			expect(readdirSync(directory)).toHaveLength(2)
		})
	})
})

describe("where the result store lives", () => {
	function withVariable<Value>(value: string | undefined, body: () => Value) {
		let previous = process.env.ESSENCE_RESULTS_CACHE

		if (value === undefined) {
			delete process.env.ESSENCE_RESULTS_CACHE
		} else {
			process.env.ESSENCE_RESULTS_CACHE = value
		}

		try {
			return body()
		} finally {
			if (previous === undefined) {
				delete process.env.ESSENCE_RESULTS_CACHE
			} else {
				process.env.ESSENCE_RESULTS_CACHE = previous
			}
		}
	}

	it("goes where the variable says", () => {
		withDirectory((directory) => {
			withVariable(directory, () => {
				expect(resultCacheDirectory()).toBe(directory)
			})
		})
	})

	it("is off where the variable says a disabling word", () => {
		for (let word of ["0", "off", "false", "no", "OFF"]) {
			withVariable(word, () => {
				expect(resultCacheDirectory()).toBeNull()
			})
		}
	})

	it("has a place of its own where nothing was said", () => {
		withVariable(undefined, () => {
			expect(resultCacheDirectory()).toContain(`${path.sep}results`)
		})
	})
})
