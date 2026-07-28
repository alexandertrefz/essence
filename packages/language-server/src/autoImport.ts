import * as path from "node:path"

import type { common, parser } from "@essence-lang/interfaces"

// NOTE: One edit builder for every feature that adds an `import { … }` entry —
// the Quick Fixes off an unknown name, and a Completion of something the file
// has not imported yet. All of them insert the SAME spelling in the SAME place,
// because a reader who accepts two of them in a row must not be shown a block
// that reshuffles itself between the two.
//
// The entry goes in at its canonical position — sorted by specifier, then by
// name — which is the order dispatch is defined over and the order `esfmt`
// writes the block in. Single-spaced, deliberately: aligning the `from` column
// is the Formatter's business, it recomputes the width for the whole block on
// every format, and a guess here would be undone by the next format-on-save.

export type ImportEdit = {
	// NOTE: An insertion is a zero-width Range — `start` and `end` at the same
	// Cursor — so this is the same shape a Code Action's edits already are.
	range: common.Position
	newText: string
}

export type ImportEntry = {
	// NOTE: The name the other Module publishes, never the local one.
	name: string
	alias: string | null
	specifier: string
}

// NOTE: The relative path an entry in `fromPath` would write for `toPath`,
// spelled with forward slashes on every platform — a specifier is a path in the
// source text rather than a path of the machine that reads it.
export function relativeSpecifier(fromPath: string, toPath: string): string {
	let relative = path
		.relative(path.dirname(fromPath), toPath)
		.split(path.sep)
		.join("/")

	return relative.startsWith("../") ? relative : `./${relative}`
}

// NOTE: The canonical order of an import block, matching `compareImportEntries`
// in the Formatter and the seeding order in the Compiler's linker. Compared by
// code unit rather than by locale, so every machine agrees on it.
function compareEntries(left: ImportEntry, right: ImportEntry): number {
	let keyOf = (entry: ImportEntry) => [
		entry.specifier,
		entry.name,
		entry.alias ?? "",
	]
	let leftKey = keyOf(left)
	let rightKey = keyOf(right)

	for (let index = 0; index < leftKey.length; index++) {
		if (leftKey[index] !== rightKey[index]) {
			return (leftKey[index] as string) < (rightKey[index] as string)
				? -1
				: 1
		}
	}

	return 0
}

function spellEntry(entry: ImportEntry): string {
	let local = entry.alias === null ? "" : ` as ${entry.alias}`

	return `${entry.name}${local} from "${entry.specifier}"`
}

function entryOf(node: parser.ImportNode): ImportEntry {
	return {
		name: node.name.content,
		alias: node.alias === null ? null : node.alias.content,
		specifier: node.source.path,
	}
}

function indentationOf(lines: Array<string>, line: number): string {
	return (lines[line - 1] ?? "").match(/^[ \t]*/)?.[0] ?? ""
}

function insertionAt(line: number, newText: string): ImportEdit {
	let cursor = { line, column: 1 }

	return { range: { start: cursor, end: cursor }, newText }
}

// NOTE: Null when the entry is already there — a Quick Fix that inserts a
// duplicate is worse than no Quick Fix, and the caller has no other way to know:
// a name may be imported under an alias, or through a second entry the reader
// wrote by hand while the Diagnostic it answers was still on screen.
export function insertImportEdit(
	sourceText: string,
	program: parser.Program,
	entry: ImportEntry,
): ImportEdit | null {
	let lines = sourceText.split("\n")
	let section = program.imports

	if (section === null) {
		// NOTE: Above the implementation, with a blank line after it, since
		// that is where the Parser accepts it and where every Module writes it.
		// The implementation's own line is what the block is measured against —
		// a Program may open with Comments, and inserting above those would put
		// the block before what documents it.
		let line = program.implementation.position.start.line
		let indentation = indentationOf(lines, line)

		return insertionAt(
			line,
			`${indentation}import {\n${indentation}\t${spellEntry(entry)}\n${indentation}}\n\n`,
		)
	}

	let existing = section.entries.map(entryOf)

	if (
		existing.some(
			(candidate) =>
				candidate.specifier === entry.specifier &&
				candidate.name === entry.name,
		)
	) {
		return null
	}

	if (section.entries.length === 0) {
		// NOTE: An empty block still owns two lines, so the entry goes on the
		// one after the brace rather than replacing anything.
		let line = section.position.start.line

		return insertionAt(
			line + 1,
			`${indentationOf(lines, line)}\t${spellEntry(entry)}\n`,
		)
	}

	let successor = section.entries.find(
		(candidate) => compareEntries(entry, entryOf(candidate)) < 0,
	)

	if (successor !== undefined) {
		let line = successor.position.start.line

		return insertionAt(
			line,
			`${indentationOf(lines, line)}${spellEntry(entry)}\n`,
		)
	}

	let last = section.entries[section.entries.length - 1]!
	let line = last.position.end.line

	return insertionAt(
		line + 1,
		`${indentationOf(lines, line)}${spellEntry(entry)}\n`,
	)
}
