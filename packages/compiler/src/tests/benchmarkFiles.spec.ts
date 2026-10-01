import { describe, expect, it } from "bun:test"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { mkdirSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"

import {
	benchmarkFileOf,
	parseBenchmarkFile,
	printBenchmarkFile,
	readBenchmarks,
	writeBenchmarks,
} from "../testing/benchmarks"
import { type BenchmarkRecord, collectBenchmarks } from "../testing/index"

// Where a measurement is kept between two runs, and what survives the round
// trip. `snapshotFiles.spec.ts` asks the same questions of the snapshot file.

function record(
	overrides: Partial<BenchmarkRecord> & { key: string },
): BenchmarkRecord {
	return {
		id: `/${overrides.key}`,
		module: null,
		nanoseconds: 1234,
		iterations: 8,
		samples: 7,
		baseline: null,
		ratio: null,
		status: "written",
		...overrides,
	}
}

async function withDirectory<Value>(
	body: (directory: string) => Promise<Value>,
): Promise<Value> {
	let directory = mkdtempSync(path.join(tmpdir(), "essence-benchmarks-"))

	try {
		return await body(directory)
	} finally {
		rmSync(directory, { recursive: true, force: true })
	}
}

describe("The benchmark companion file", () => {
	it("names a file beside the source it belongs to", () => {
		expect(benchmarkFileOf("/project/Season.es")).toBe(
			path.join("/project", "__benchmarks__", "Season.es.bench"),
		)
	})

	it("reads back what it wrote", () => {
		let entries = { "ranks the table": 1234567, sorting: 42 }

		expect(parseBenchmarkFile(printBenchmarkFile(entries))).toEqual(entries)
	})

	it("writes the entries in name order", () => {
		let written = printBenchmarkFile({ b: 2, a: 1 })

		expect(written.indexOf('benchmark "a"')).toBeLessThan(
			written.indexOf('benchmark "b"'),
		)
	})

	it("escapes a quote in a key and reads it back", () => {
		let entries = { 'a "quoted" key': 7, "a \\ key": 8 }

		expect(parseBenchmarkFile(printBenchmarkFile(entries))).toEqual(entries)
	})

	// The format is one entry per line, so a line break in a key escapes the
	// way it does in a String Literal.
	it("escapes a line break in a key and reads it back", () => {
		let entries = { "first\nsecond": 7, "returns\rcarried": 8 }
		let written = printBenchmarkFile(entries)

		expect(written).toContain('benchmark "first\\nsecond"')
		expect(parseBenchmarkFile(written)).toEqual(entries)
	})

	it("reads a row's numbered entry as the key it is", () => {
		let entries = {
			"sorts {size} rows/0": 10,
			"sorts {size} rows/1": 20,
		}

		expect(parseBenchmarkFile(printBenchmarkFile(entries))).toEqual(entries)
	})

	it("reads a file whose line endings were rewritten", () => {
		let entries = { sorting: 42 }
		let rewritten = printBenchmarkFile(entries).replaceAll("\n", "\r\n")

		expect(parseBenchmarkFile(rewritten)).toEqual(entries)
	})

	it("answers with nothing for a file that says nothing", () => {
		expect(parseBenchmarkFile("")).toEqual({})
		expect(parseBenchmarkFile("§ just a comment\n")).toEqual({})
	})

	// A hand-edited file is read for whatever it still says rather than
	// refused. What is lost is a baseline, which the next run records again.
	it("steps over an entry with no time under it", () => {
		expect(
			parseBenchmarkFile(
				['benchmark "broken"', 'benchmark "kept"', "\t9 ns", ""].join(
					"\n",
				),
			),
		).toEqual({ kept: 9 })
	})
})

describe("Reading and writing what a run measured", () => {
	it("answers with an empty store for a Module with no companion", async () => {
		await withDirectory(async (directory) => {
			let module = path.join(directory, "Season.es")

			expect(await readBenchmarks([module])).toEqual({ [module]: {} })
		})
	})

	it("writes what a run recorded, and reads it back", async () => {
		await withDirectory(async (directory) => {
			let module = path.join(directory, "Season.es")
			let written = await writeBenchmarks({
				benchmarks: [
					record({ key: "sorting", module, nanoseconds: 4321 }),
				],
				stored: {},
			})

			expect(written).toEqual({ recorded: 1, files: 1, problems: [] })
			expect(await readBenchmarks([module])).toEqual({
				[module]: { sorting: 4321 },
			})
		})
	})

	// A run narrowed by a filter has not measured everything, so the
	// baselines it did not visit stay.
	it("lays what it recorded over what it read, keeping the rest", async () => {
		await withDirectory(async (directory) => {
			let module = path.join(directory, "Season.es")

			await writeBenchmarks({
				benchmarks: [
					record({ key: "sorting", module, nanoseconds: 10 }),
					record({ key: "ranking", module, nanoseconds: 20 }),
				],
				stored: {},
			})

			let stored = await readBenchmarks([module])

			await writeBenchmarks({
				benchmarks: [
					record({ key: "sorting", module, nanoseconds: 30 }),
				],
				stored,
			})

			expect(await readBenchmarks([module])).toEqual({
				[module]: { sorting: 30, ranking: 20 },
			})
		})
	})

	// Only a `written` measurement moves a baseline. An improved one is news
	// for the report, and a regressed one is the failure.
	it("writes nothing for a measurement that was not recorded", async () => {
		await withDirectory(async (directory) => {
			let module = path.join(directory, "Season.es")
			let written = await writeBenchmarks({
				benchmarks: [
					record({ key: "matched", module, status: "matched" }),
					record({ key: "improved", module, status: "improved" }),
					record({ key: "regressed", module, status: "regressed" }),
				],
				stored: {},
			})

			expect(written).toEqual({ recorded: 0, files: 0, problems: [] })
			expect(await readBenchmarks([module])).toEqual({ [module]: {} })
		})
	})

	it("says so where a file could not be written", async () => {
		await withDirectory(async (directory) => {
			// A file stands where the companion directory has to go, so the
			// filesystem refuses without depending on permissions.
			let module = path.join(directory, "Season.es")

			mkdirSync(path.dirname(benchmarkFileOf(module)), {
				recursive: true,
			})
			rmSync(path.dirname(benchmarkFileOf(module)), { recursive: true })
			writeFileSync(path.dirname(benchmarkFileOf(module)), "not a folder")

			let written = await writeBenchmarks({
				benchmarks: [record({ key: "sorting", module })],
				stored: {},
			})

			expect(written.files).toBe(0)
			expect(written.problems).toHaveLength(1)
			expect(written.problems[0]).toContain("Season.es.bench")
		})
	})

	it("holds a hand-written file to the format it prints", async () => {
		await withDirectory(async (directory) => {
			let module = path.join(directory, "Season.es")
			let filePath = benchmarkFileOf(module)

			mkdirSync(path.dirname(filePath), { recursive: true })
			writeFileSync(
				filePath,
				['benchmark "sorting"', "\t99 ns", ""].join("\n"),
			)

			expect(await readBenchmarks([module])).toEqual({
				[module]: { sorting: 99 },
			})

			await writeBenchmarks({
				benchmarks: [
					record({ key: "sorting", module, nanoseconds: 100 }),
				],
				stored: await readBenchmarks([module]),
			})

			expect(readFileSync(filePath, "utf8")).toContain("\t100 ns")
		})
	})
})

// What the fold hands the writer: a measurement whose test then failed is
// not a baseline.
describe("Collecting what a run measured", () => {
	const measured = {
		schema: 1 as const,
		kind: "benchmark" as const,
		id: "/bench",
		name: "doubling",
		module: "/Doubling.es",
		key: "doubling",
		nanoseconds: 1234,
		iterations: 8,
		samples: 7,
		baseline: null,
		ratio: null,
		status: "written" as const,
	}

	it("keeps a measurement whose test passed", () => {
		expect(
			collectBenchmarks([
				measured,
				{
					schema: 1,
					kind: "test-pass",
					id: "/bench",
					name: "doubling",
					duration: 1,
					expectations: 1,
				},
			]).map((record) => record.key),
		).toEqual(["doubling"])
	})

	it("drops a measurement whose test then failed", () => {
		expect(
			collectBenchmarks([
				measured,
				{
					schema: 1,
					kind: "test-fail",
					id: "/bench",
					name: "doubling",
					duration: 1,
					expectations: 1,
					failures: [],
					error: "it threw after the measurement",
				},
			]),
		).toEqual([])
	})
})
