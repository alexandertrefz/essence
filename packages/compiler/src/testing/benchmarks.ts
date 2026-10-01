import { mkdir, readFile, writeFile } from "node:fs/promises"
import path from "node:path"

import type { BenchmarkRecord } from "./index"

// The time each benchmark is held to, kept beside the source and read and
// written as snapshots are. See "Benchmark baselines" in DEVELOPMENT.md.

// Beside the source, so a baseline travels with its file.
export const BENCHMARK_DIRECTORY = "__benchmarks__"

export function benchmarkFileOf(modulePath: string): string {
	return path.join(
		path.dirname(modulePath),
		BENCHMARK_DIRECTORY,
		`${path.basename(modulePath)}.bench`,
	)
}

// One file's baselines in nanoseconds, keyed by identity without the Module
// path, with a table row's number after it.
export type BenchmarkStore = Record<string, number>

const HEADER = [
	"§ Baselines recorded by `essence test --bench`. They are read back on every",
	"§ measuring run, so a change here is a change to what the benchmarks are",
	"§ held to. Rewrite them with `essence test --bench --update`.",
]

const ENTRY = /^benchmark "((?:[^"\\]|\\.)*)"$/
const VALUE = /^\t(\d+) ns$/

// The `.bench` format: a header comment, then entries in name order, each a
// `benchmark "key"` line and one tab-indented time in whole nanoseconds.
export function parseBenchmarkFile(text: string): BenchmarkStore {
	let entries: BenchmarkStore = {}
	let key: string | null = null

	for (let line of text.split("\n")) {
		// A trailing `\r` is a line ending's, since no line holds printed text.
		let read = line.endsWith("\r") ? line.slice(0, -1) : line
		let opening = ENTRY.exec(read)

		if (opening !== null) {
			key = unescapeKey(opening[1] as string)

			continue
		}

		let value = VALUE.exec(read)

		if (key === null || value === null) {
			continue
		}

		entries[key] = Number(value[1])
		key = null
	}

	return entries
}

export function printBenchmarkFile(entries: BenchmarkStore): string {
	let keys = Object.keys(entries).sort()

	return [
		...HEADER,
		"",
		...keys.flatMap((key) => [
			`benchmark "${escapeKey(key)}"`,
			`\t${entries[key] as number} ns`,
			"",
		]),
	].join("\n")
}

function escapeKey(key: string): string {
	return key
		.replaceAll("\\", "\\\\")
		.replaceAll('"', '\\"')
		.replaceAll("\n", "\\n")
		.replaceAll("\r", "\\r")
}

function unescapeKey(key: string): string {
	return key.replaceAll(/\\(.)/g, (_, char: string) =>
		char === "n" ? "\n" : char === "r" ? "\r" : char,
	)
}

// Every Module's baselines, keyed by canonical path, as
// `RunOptions.benchmarks` takes them. Every Module has an entry.
export async function readBenchmarks(
	modules: Iterable<string>,
): Promise<Record<string, BenchmarkStore>> {
	let stores: Record<string, BenchmarkStore> = {}

	// Read in parallel.
	await Promise.all(
		[...modules].map(async (module) => {
			stores[module] = await readBenchmarkFile(benchmarkFileOf(module))
		}),
	)

	return stores
}

async function readBenchmarkFile(filePath: string): Promise<BenchmarkStore> {
	try {
		return parseBenchmarkFile(await readFile(filePath, "utf8"))
	} catch {
		return {}
	}
}

export type BenchmarkWrites = {
	recorded: number
	files: number
	problems: Array<string>
}

export const noBenchmarkWrites: BenchmarkWrites = {
	recorded: 0,
	files: 0,
	problems: [],
}

// Writes only `written` measurements, straight to disk. An `improved` one is
// news, not a baseline to move.
export async function writeBenchmarks(options: {
	benchmarks: Array<BenchmarkRecord>
	stored: Record<string, BenchmarkStore>
}): Promise<BenchmarkWrites> {
	let written = options.benchmarks.filter(
		(entry) => entry.status === "written" && entry.module !== null,
	)

	if (written.length === 0) {
		return noBenchmarkWrites
	}

	let modules = [
		...new Set(written.map((entry) => entry.module as string)),
	].sort()
	let problems: Array<string> = []
	let files = 0
	let recorded = 0

	for (let module of modules) {
		let mine = written.filter((entry) => entry.module === module)
		let problem = await writeStored(
			module,
			mine,
			options.stored[module] ?? {},
		)

		if (problem === null) {
			files += 1
			recorded += mine.length
		} else {
			problems.push(problem)
		}
	}

	return { recorded, files, problems }
}

// The companion written afresh: this run's entries over the ones read. An entry
// no benchmark names is kept, since a narrowed run has not measured everything.
async function writeStored(
	module: string,
	benchmarks: Array<BenchmarkRecord>,
	previous: BenchmarkStore,
): Promise<string | null> {
	let entries: BenchmarkStore = { ...previous }

	for (let benchmark of benchmarks) {
		entries[benchmark.key] = benchmark.nanoseconds
	}

	let filePath = benchmarkFileOf(module)

	try {
		await mkdir(path.dirname(filePath), { recursive: true })
		await writeFile(filePath, printBenchmarkFile(entries), "utf8")

		return null
	} catch (error) {
		return `${filePath}: ${describe(error)}`
	}
}

function describe(error: unknown): string {
	return error instanceof Error ? error.message : String(error)
}
