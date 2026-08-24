import { mkdir, readFile, writeFile } from "node:fs/promises"
import path from "node:path"

import type { BenchmarkRecord } from "./index"

// NOTE: The STORED half of a benchmark — the time each measurement is held to,
// and the file it lives in. The runtime never touches any of this: a bundle may
// be running in a browser, so whoever starts a run reads the file and hands the
// baselines over, and writes back whatever the run says it recorded. Snapshots
// next door work exactly this way, and for exactly this reason.

// NOTE: Beside the source rather than in one directory at the root of the
// project, so that a baseline travels with the file it belongs to — a file that
// moves takes what its benchmarks cost with it, and a file that is deleted
// leaves nothing behind that nothing names.
export const BENCHMARK_DIRECTORY = "__benchmarks__"

export function benchmarkFileOf(modulePath: string): string {
	return path.join(
		path.dirname(modulePath),
		BENCHMARK_DIRECTORY,
		`${path.basename(modulePath)}.bench`,
	)
}

// NOTE: One file's baselines, keyed by the entry a measurement is written under
// — the identity without the Module path, and with a table row's number behind
// it. Nanoseconds, which is the unit the runtime answers in.
export type BenchmarkStore = Record<string, number>

const HEADER = [
	"§ Baselines recorded by `essence test --bench`. They are read back on every",
	"§ measuring run, so a change here is a change to what the benchmarks are",
	"§ held to. Rewrite them with `essence test --bench --update`.",
]

const ENTRY = /^benchmark "((?:[^"\\]|\\.)*)"$/
const VALUE = /^\t(\d+) ns$/

// NOTE: THE FORMAT, and the whole of it:
//
//   • Lines above the first entry are a comment, and are written afresh every
//     time the file is written.
//   • An entry opens with `benchmark "key"` at the left margin. The key is
//     written the way a String Literal is, so a quote or a backslash in one
//     escapes.
//   • One tab-indented line follows it, holding the time of a single run in
//     whole nanoseconds. Nothing else belongs to an entry: unlike a snapshot,
//     what is recorded here is a number rather than whatever a value printed.
//   • Entries are written in name order, so that recording one twice writes the
//     same bytes and a diff shows what changed rather than what moved.
//
// It is `.bench` beside the source rather than a `.es` file for the same reason
// a snapshot is `.snap`: nothing here is Essence, and a reader looking at a
// number should not have to read past an escaping to find it.
export function parseBenchmarkFile(text: string): BenchmarkStore {
	let entries: BenchmarkStore = {}
	let key: string | null = null

	for (let line of text.split("\n")) {
		// NOTE: A `\r` at the end of a line is always the line ending's here.
		// Unlike a snapshot, no line of this format holds text a value put
		// there — a key is written escaped on one line, and a value is digits —
		// so there is nothing a carriage return could belong to.
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
	return key.replaceAll("\\", "\\\\").replaceAll('"', '\\"')
}

function unescapeKey(key: string): string {
	return key.replaceAll(/\\(.)/g, "$1")
}

// NOTE: The baselines of every Module of the run, keyed by the Module's
// canonical path — the shape the runtime's `RunOptions.benchmarks` takes. A
// Module with no companion file has an empty entry rather than none, so that
// naming one is always a lookup and never a question about the disk.
export async function readBenchmarks(
	modules: Iterable<string>,
): Promise<Record<string, BenchmarkStore>> {
	let stores: Record<string, BenchmarkStore> = {}

	for (let module of modules) {
		stores[module] = await readBenchmarkFile(benchmarkFileOf(module))
	}

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

// NOTE: Everything a run recorded, written where it belongs. Only a `written`
// measurement is one: a `matched` one changed nothing, an `improved` one is
// news the report carries and a baseline nobody asked to move, and a
// `regressed` one is the failure.
//
// A `__benchmarks__` companion is written straight to disk. Nothing edits one
// by hand and no Editor holds it open — which is the whole difference between
// this and a snapshot, half of which are written back into a source.
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

// NOTE: The whole companion file is written afresh, entries in name order — the
// ones this run recorded laid over the ones it read. An entry no benchmark
// names any more is KEPT: a run narrowed by `--filter` or by a tag has not
// measured everything, and deleting what it did not visit would lose a baseline
// for the price of a filter.
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
