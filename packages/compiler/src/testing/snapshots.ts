import { mkdir, readFile, writeFile } from "node:fs/promises"
import path from "node:path"

import type { common } from "@essence-lang/interfaces"

import type { SnapshotRecord } from "./index"

// The stored half of `matches snapshot from "name"`, which the runtime never
// touches. See "Snapshots" in DEVELOPMENT.md.

// Beside the source, so a snapshot travels with its file.
export const SNAPSHOT_DIRECTORY = "__snapshots__"

export function snapshotFileOf(modulePath: string): string {
	return path.join(
		path.dirname(modulePath),
		SNAPSHOT_DIRECTORY,
		`${path.basename(modulePath)}.snap`,
	)
}

// One file's entries, keyed by the name written after `from`.
export type SnapshotStore = Record<string, string>

const HEADER = [
	"§ Snapshots recorded by `essence test`. They are read back on every run,",
	"§ so a change here is a change to what the tests assert. Rewrite them with",
	"§ `essence test --update`.",
]

const ENTRY = /^snapshot "((?:[^"\\]|\\.)*)"$/

// The `.snap` format: a header comment, then entries in name order, each a
// `snapshot "name"` line followed by its text, every line indented by one tab.
// See "Snapshots" in DEVELOPMENT.md.
export function parseSnapshotFile(text: string): SnapshotStore {
	let entries: SnapshotStore = {}
	let lines = withoutCarriageReturns(text).split("\n")
	let name: string | null = null
	let collected: Array<string> = []

	let close = () => {
		if (name !== null) {
			entries[name] = collected.join("\n")
		}

		collected = []
	}

	for (let line of lines) {
		if (name !== null && line.startsWith("\t")) {
			collected.push(line.slice(1))

			continue
		}

		let opening = ENTRY.exec(line)

		if (opening === null) {
			continue
		}

		close()
		name = unescapeName(opening[1] as string)
	}

	close()

	return entries
}

// A file whose every newline is a CRLF had its line endings rewritten by a
// tool, so those `\r`s go. A file mixing them keeps the value's own.
function withoutCarriageReturns(text: string): string {
	return text.includes("\r\n") && !/[^\r]\n/.test(text)
		? text.replaceAll("\r\n", "\n")
		: text
}

export function printSnapshotFile(entries: SnapshotStore): string {
	let names = Object.keys(entries).sort()

	return [
		...HEADER,
		"",
		...names.flatMap((name) => [
			`snapshot "${escapeName(name)}"`,
			...(entries[name] as string).split("\n").map((line) => `\t${line}`),
			"",
		]),
	].join("\n")
}

function escapeName(name: string): string {
	return name.replaceAll("\\", "\\\\").replaceAll('"', '\\"')
}

function unescapeName(name: string): string {
	return name.replaceAll(/\\(.)/g, "$1")
}

// Reading and writing snapshots, shared by the CLI and the language server.
// Rewriting a source is injected, since it goes through the formatter.

export type InlineUpdate = { position: common.Position; text: string }

export type InlineWrite = {
	text: string
	changed: boolean
	applied: number
	refusal: { message: string } | null
}

export type InlineWriter = (
	source: string,
	updates: Array<InlineUpdate>,
	documentPath: string,
) => InlineWrite

// A source a run would rewrite and its new text. The language server hands it
// to the editor, so an unsaved buffer is not written over.
export type SourceRewrite = { module: string; text: string; applied: number }

export type SnapshotWrites = {
	recorded: number
	files: number
	problems: Array<string>
	sources: Array<SourceRewrite>
}

export const noWrites: SnapshotWrites = {
	recorded: 0,
	files: 0,
	problems: [],
	sources: [],
}

// Every Module's stored snapshots, keyed by canonical path, as
// `RunOptions.snapshots` takes them. Every Module has an entry.
export async function readSnapshots(
	modules: Iterable<string>,
): Promise<Record<string, SnapshotStore>> {
	let stores: Record<string, SnapshotStore> = {}

	// Read in parallel, since the files are independent.
	await Promise.all(
		[...modules].map(async (module) => {
			stores[module] = await readSnapshotFile(snapshotFileOf(module))
		}),
	)

	return stores
}

async function readSnapshotFile(filePath: string): Promise<SnapshotStore> {
	try {
		return parseSnapshotFile(await readFile(filePath, "utf8"))
	} catch {
		return {}
	}
}

// Writes what a run recorded: companions to disk, and sources only where the
// caller asks. `matched` and `mismatched` snapshots are not written.
export async function writeSnapshots(options: {
	snapshots: Array<SnapshotRecord>
	sources: Map<string, string>
	stored: Record<string, SnapshotStore>
	// Answers the writer lazily, so a run without inline snapshots never loads
	// the formatter.
	inline: () => Promise<InlineWriter>
	writeSources?: boolean
}): Promise<SnapshotWrites> {
	let { snapshots, sources, stored, inline, writeSources = true } = options
	let written = snapshots.filter(
		(snapshot) => snapshot.status === "written" && snapshot.module !== null,
	)

	if (written.length === 0) {
		return noWrites
	}

	let modules = [
		...new Set(written.map((snapshot) => snapshot.module as string)),
	].sort()
	let problems: Array<string> = []
	let rewrites: Array<SourceRewrite> = []
	let files = 0
	let recorded = 0

	for (let module of modules) {
		let mine = written.filter((snapshot) => snapshot.module === module)
		let named = mine.filter((snapshot) => snapshot.name !== null)
		let inlined = mine.filter((snapshot) => snapshot.name === null)

		if (named.length > 0) {
			let problem = await writeStored(module, named, stored[module] ?? {})

			if (problem === null) {
				files += 1
				recorded += named.length
			} else {
				problems.push(problem)
			}
		}

		if (inlined.length === 0) {
			continue
		}

		let source = sources.get(module)

		if (source === undefined) {
			problems.push(`${module}: the source of this run is not in hand`)

			continue
		}

		let answer = (await inline())(
			source,
			inlined.flatMap((snapshot) =>
				snapshot.span === null
					? []
					: [{ position: snapshot.span, text: snapshot.text }],
			),
			module,
		)

		if (answer.refusal !== null) {
			problems.push(`${module}: ${answer.refusal.message}`)

			continue
		}

		if (!answer.changed) {
			continue
		}

		rewrites.push({ module, text: answer.text, applied: answer.applied })

		if (!writeSources) {
			files += 1
			recorded += answer.applied

			continue
		}

		try {
			await writeFile(module, answer.text, "utf8")

			files += 1
			recorded += answer.applied
		} catch (error) {
			problems.push(`${module}: ${describe(error)}`)
		}
	}

	return { recorded, files, problems, sources: rewrites }
}

// The companion written afresh: this run's entries over the ones read. An entry
// no test names is kept, since a narrowed run has not visited every test.
async function writeStored(
	module: string,
	snapshots: Array<SnapshotRecord>,
	previous: SnapshotStore,
): Promise<string | null> {
	let entries: SnapshotStore = { ...previous }

	for (let snapshot of snapshots) {
		entries[snapshot.name as string] = snapshot.text
	}

	let filePath = snapshotFileOf(module)

	try {
		await mkdir(path.dirname(filePath), { recursive: true })
		await writeFile(filePath, printSnapshotFile(entries), "utf8")

		return null
	} catch (error) {
		return `${filePath}: ${describe(error)}`
	}
}

function describe(error: unknown): string {
	return error instanceof Error ? error.message : String(error)
}
