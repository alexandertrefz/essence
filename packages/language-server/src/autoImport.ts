import * as path from "node:path"

import type { common, parser } from "@essence-lang/interfaces"

// NOTE: One edit builder for every feature that adds an `import { … }` entry —
// the Quick Fixes off an unknown name, and a Completion of something the file
// has not imported yet. All of them insert the SAME spelling in the SAME place,
// because a reader who accepts two of them in a row must not be shown a block
// that reshuffles itself between the two.
//
// The name goes in at its canonical position — into the group of its Module,
// sorted by name, or into a new group sorted by specifier — which is the order
// dispatch is defined over and the order `esfmt` writes the block in.

export type ImportEdit = {
	// NOTE: An insertion is a zero-width Range — `start` and `end` at the same
	// Cursor — so this is the same shape a Code Action's edits already are. The
	// one edit that is not an insertion replaces a group written flat with the
	// same group written out.
	range: common.Position
	newText: string
}

type ImportEntry = {
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

// NOTE: The canonical order of the names inside a group and of the groups of
// a block, matching `compareEntries` and `compareGroups` in the Formatter and
// the seeding order in the Compiler's linker. Compared by code unit rather
// than by locale, so every machine agrees on it.
function compareStrings(left: string, right: string): number {
	if (left === right) {
		return 0
	}

	return left < right ? -1 : 1
}

function compareNames(left: ImportEntry, right: ImportEntry): number {
	return (
		compareStrings(left.name, right.name) ||
		compareStrings(left.alias ?? "", right.alias ?? "")
	)
}

function spellName(entry: ImportEntry): string {
	return entry.alias === null ? entry.name : `${entry.name} as ${entry.alias}`
}

// NOTE: A group of one name, which is how the Formatter writes one.
function spellGroup(entry: ImportEntry): string {
	return `from "${entry.specifier}" { ${spellName(entry)} }`
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

function insertionAt(
	line: number,
	newText: string,
	column: number = 1,
): ImportEdit {
	let cursor = { line, column }

	return { range: { start: cursor, end: cursor }, newText }
}

// NOTE: Whether anything but whitespace is written on `line` before `column`
// — which is what says a line of its own can not be opened there, and the
// text has to go inline instead.
function sharesLine(lines: Array<string>, line: number, column: number) {
	return /[^ \t]/.test((lines[line - 1] ?? "").slice(0, column - 1))
}

// NOTE: `spelling` placed among the members of a block or a group: on a line
// of its own above `successor`, or inline in front of it where it shares its
// line with the brace that opened the block; below `last` otherwise, and
// inline after it where the closing brace shares its line.
function insertAmong(
	lines: Array<string>,
	spelling: string,
	successor: common.Position | null,
	last: common.Position,
	closeLine: number,
): ImportEdit {
	if (successor !== null) {
		let line = successor.start.line

		if (sharesLine(lines, line, successor.start.column)) {
			return insertionAt(line, `${spelling} `, successor.start.column)
		}

		return insertionAt(line, `${indentationOf(lines, line)}${spelling}\n`)
	}

	let line = last.end.line

	if (closeLine === line) {
		return insertionAt(line, ` ${spelling}`, last.end.column)
	}

	return insertionAt(line + 1, `${indentationOf(lines, line)}${spelling}\n`)
}

// NOTE: Null when the entry is already there — a Quick Fix that inserts a
// duplicate is worse than no Quick Fix, and the caller has no other way to know:
// a name may be imported under an alias, or through a second entry the reader
// wrote by hand while the Diagnostic it answers was still on screen.
//
// The name joins the group already written for its Module where there is one,
// and opens a group of its own otherwise, at the group's canonical position.
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
			`${indentation}import {\n${indentation}\t${spellGroup(entry)}\n${indentation}}\n\n`,
		)
	}

	if (
		section.entries.some(
			(candidate) =>
				candidate.source.path === entry.specifier &&
				candidate.name.content === entry.name,
		)
	) {
		return null
	}

	let group = section.groups.find(
		(candidate) => candidate.source.path === entry.specifier,
	)

	if (group !== undefined) {
		return insertIntoGroup(lines, group, entry)
	}

	if (section.groups.length === 0) {
		let line = section.position.start.line

		// NOTE: A one-line `import {}` takes the group INSIDE its braces — an
		// insertion on the line after the statement lands outside the block,
		// and the file no longer parses.
		if (section.position.end.line === line) {
			let column = section.position.end.column - 1
			let separator =
				(lines[line - 1] ?? "")[column - 2] === "{" ? " " : ""

			return insertionAt(
				line,
				`${separator}${spellGroup(entry)} `,
				column,
			)
		}

		// NOTE: An empty block still owns two lines, so the group goes on the
		// one after the brace rather than replacing anything.
		return insertionAt(
			line + 1,
			`${indentationOf(lines, line)}\t${spellGroup(entry)}\n`,
		)
	}

	let successor = section.groups.find(
		(candidate) =>
			compareStrings(entry.specifier, candidate.source.path) < 0,
	)
	let last = section.groups[section.groups.length - 1]!

	return insertAmong(
		lines,
		spellGroup(entry),
		successor?.position ?? null,
		last.position,
		section.position.end.line,
	)
}

// NOTE: A group written flat holds one name, and gaining a second is what
// writes it out — so the whole of it is replaced with the two names one to a
// line, in order, which is what the Formatter would make of it. A group
// already written out takes the name on a line of its own at its canonical
// position, and keeps every Comment it holds.
function insertIntoGroup(
	lines: Array<string>,
	group: parser.ImportGroupNode,
	entry: ImportEntry,
): ImportEdit {
	let position = group.position

	if (
		position.start.line === position.end.line &&
		group.entries.length === 1
	) {
		let indentation = indentationOf(lines, position.start.line)
		let names = [entryOf(group.entries[0]!), entry]
			.sort(compareNames)
			.map((name) => `${indentation}\t${spellName(name)}`)

		return {
			range: position,
			newText: [
				`from "${entry.specifier}" {`,
				...names,
				`${indentation}}`,
			].join("\n"),
		}
	}

	let successor = group.entries.find(
		(candidate) => compareNames(entry, entryOf(candidate)) < 0,
	)
	let last = group.entries[group.entries.length - 1]!

	return insertAmong(
		lines,
		spellName(entry),
		successor?.position ?? null,
		last.position,
		position.end.line,
	)
}
