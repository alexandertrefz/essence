import { mkdir, readFile, writeFile } from "node:fs/promises"
import path from "node:path"

import type { common } from "@essence-lang/interfaces"

import type { SnapshotRecord } from "./index"

// NOTE: The STORED half of `matches snapshot` — the entries a
// `matches snapshot from "name"` compares against, and the file they live in.
// The runtime never touches any of this: a bundle may be running in a browser,
// so whoever starts a run reads the file and hands the entries over, and writes
// back whatever the run says it recorded.

// NOTE: Beside the source rather than in one directory at the root of the
// project, so that a snapshot travels with the file it belongs to — a file that
// moves takes its recorded output with it, and a file that is deleted leaves
// nothing behind that nothing names.
export const SNAPSHOT_DIRECTORY = "__snapshots__"

export function snapshotFileOf(modulePath: string): string {
	return path.join(
		path.dirname(modulePath),
		SNAPSHOT_DIRECTORY,
		`${path.basename(modulePath)}.snap`,
	)
}

// NOTE: One file's entries, keyed by the name written after `from`.
export type SnapshotStore = Record<string, string>

const HEADER = [
	"§ Snapshots recorded by `essence test`. They are read back on every run,",
	"§ so a change here is a change to what the tests assert. Rewrite them with",
	"§ `essence test --update`.",
]

const ENTRY = /^snapshot "((?:[^"\\]|\\.)*)"$/

// NOTE: THE FORMAT, and the whole of it:
//
//   • Lines above the first entry are a comment, and are written afresh every
//     time the file is written.
//   • An entry opens with `snapshot "name"` at the left margin. The name is
//     written the way a String Literal is, so a quote or a backslash in one
//     escapes.
//   • Every line of the entry's text follows, each with ONE leading tab —
//     including a line that is empty, which is written as a lone tab. That is
//     what makes the round trip exact: a line beginning with a tab belongs to
//     the entry and gives up one tab, and anything else ends it.
//   • Entries are written in name order, so that recording one twice writes
//     the same bytes and a diff shows what changed rather than what moved.
//
// It is `.snap` beside the source rather than a `.es` file, because nothing
// here is Essence: the text is whatever a value printed, and asking a reader to
// escape it into a Literal would be asking them to read past the escaping.
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

// NOTE: A file whose EVERY newline is a CRLF was written by a tool that
// rewrote the line endings, and its `\r`s are that tool's rather than the
// recorded value's. One that mixes them has `\r`s that a value put there — the
// format writes `\n` and only `\n` — so they are left exactly where they are.
// A value holding a CRLF inside a CRLF-rewritten file is the one case nothing
// can tell apart, and `essence test --update` is the answer to it.
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

// NOTE: Reading the stored entries a run compares against, and writing back
// whatever it recorded. It is here rather than in the command line because the
// Language Server's session does the very same thing — a snapshot accepted
// through a Code Lens has to land where `essence test --update` would put it.
//
// Rewriting a source is INJECTED rather than imported: it goes through the
// Formatter, which is a delegate both callers reach lazily.

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

// NOTE: A source a run would rewrite, and what it would become. The command
// line writes it; the Language Server hands it to the Editor as an edit, so
// that an unsaved buffer is not written round.
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

// NOTE: The stored snapshots of every Module of the run, keyed by the Module's
// canonical path — the shape the runtime's `RunOptions.snapshots` takes. A
// Module with no companion file has an empty entry rather than none, so that
// naming one is always a lookup and never a question about the disk.
export async function readSnapshots(
	modules: Iterable<string>,
): Promise<Record<string, SnapshotStore>> {
	let stores: Record<string, SnapshotStore> = {}

	// NOTE: Fanned out rather than awaited one at a time — the files are
	// independent, and a project of hundreds of Modules pays this sweep at the
	// head of every run.
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

// NOTE: Everything a run recorded, written where it belongs. A `matched`
// snapshot is not written — nothing about it changed — and a `mismatched` one
// is the failure the report already carries.
//
// A `__snapshots__` companion is written straight to disk: nothing edits one by
// hand and no Editor holds it open. A SOURCE is only written when the caller
// says so — the Language Server answers with the text instead, because the
// buffer it compiled may never have been saved.
export async function writeSnapshots(options: {
	snapshots: Array<SnapshotRecord>
	sources: Map<string, string>
	stored: Record<string, SnapshotStore>
	// NOTE: A FUNCTION that answers with the writer rather than the writer:
	// rewriting a source goes through the Formatter, which both callers reach
	// lazily, and a run with no inline snapshot in it must not load one.
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

// NOTE: The whole companion file is written afresh, entries in name order — the
// ones this run recorded laid over the ones it read. An entry no test names any
// more is KEPT: a run narrowed by `--filter` or by a tag has not visited every
// test, and deleting what it did not visit would lose a snapshot for the price
// of a filter.
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
