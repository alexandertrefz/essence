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

// NOTE: An entry of an `export { … }` block, which holds two shapes where an
// import block holds one: a bare name is something this Module declares, and a
// name written under a `from` is one it forwards without ever binding.
// `specifier` is what tells them apart — the Module the name comes FROM, and
// null for the ordinary entry.
type ExportEntry = {
	// NOTE: The name as it is written at home, which is what the block is
	// ordered by — an `as` renames what the entry PUBLISHES and leaves where it
	// stands alone.
	name: string
	alias: string | null
	specifier: string | null
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

// NOTE: The specifier is handed in rather than read off the entry, because the
// entry of an export group carries the same one its group does and an entry
// written bare carries none at all.
function entryOf(
	node: parser.ImportNode | parser.ExportNode,
	specifier: string,
): ImportEntry {
	return {
		name: node.name.content,
		alias: node.alias === null ? null : node.alias.content,
		specifier,
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
		return insertIntoEmptyBlock(lines, section, spellGroup(entry))
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

// NOTE: SEVERAL names taken from ONE Module, written in as one edit. A
// Declaration moved into another Module takes with it every name it reads that
// the Module it left publishes, and the target has to import all of them — one
// call per name would compute each insertion against a text none of the others
// had landed in, and two names sorting into the same slot would be two edits at
// one Cursor.
//
// Names already imported from that Module are left out, as `insertImportEdit`
// leaves them out: an entry written twice is `duplicate-import`.
export function insertImportsEdit(
	sourceText: string,
	program: parser.Program,
	request: { names: Array<string>; specifier: string },
): ImportEdit | null {
	let lines = sourceText.split("\n")
	let section = program.imports
	let wanted = [...new Set(request.names)].sort(compareStrings)

	if (wanted.length === 0) {
		return null
	}

	if (section === null) {
		let line = program.implementation.position.start.line
		let indentation = indentationOf(lines, line)

		return insertionAt(
			line,
			`${indentation}import {\n${indentation}\t${spellNames(
				wanted,
				request.specifier,
			)}\n${indentation}}\n\n`,
		)
	}

	let missing = wanted.filter(
		(name) =>
			!section.entries.some(
				(candidate) =>
					candidate.source.path === request.specifier &&
					candidate.name.content === name,
			),
	)

	if (missing.length === 0) {
		return null
	}

	let group = section.groups.find(
		(candidate) => candidate.source.path === request.specifier,
	)

	if (group !== undefined) {
		return insertIntoGroup(
			lines,
			group,
			{
				name: missing[0] as string,
				alias: null,
				specifier: request.specifier,
			},
			missing.join(" "),
		)
	}

	let spelling = spellNames(missing, request.specifier)

	if (section.groups.length === 0) {
		return insertIntoEmptyBlock(lines, section, spelling)
	}

	let successor = section.groups.find(
		(candidate) =>
			compareStrings(request.specifier, candidate.source.path) < 0,
	)
	let last = section.groups[
		section.groups.length - 1
	] as parser.ImportGroupNode

	return insertAmong(
		lines,
		spelling,
		successor?.position ?? null,
		last.position,
		section.position.end.line,
	)
}

// NOTE: The group a run of names is written as, on one line. The Formatter
// writes a group of two or more names one to a line, so a group of several
// written here is one it rewrites.
export function spellNames(names: Array<string>, specifier: string): string {
	return `from "${specifier}" { ${names.join(" ")} }`
}

// NOTE: The `export { … }` block's side of the same builder, and null for the
// same reason: a name this Module already publishes must not be published a
// second time, whichever of the two shapes carries it.
//
// The canonical order is the Formatter's — what the Module declares itself
// first, by name, then what it forwards, by specifier — because a reader who
// accepts this and then formats the file has to be shown the same block twice.
export function insertExportEdit(
	sourceText: string,
	program: parser.Program,
	entry: ExportEntry,
	// NOTE: An entry the caller takes away in the same breath — the one shape in
	// which a name the block already publishes is no collision, because the edit
	// that publishes it a second time is paired with the edit that removes the
	// first. Its place in the block is left standing all the same: what follows
	// it is where the new member goes, and the two edits then meet end to end
	// rather than overlapping.
	replacing: parser.ExportNode | null = null,
): ImportEdit | null {
	let lines = sourceText.split("\n")
	let section = program.exports
	// NOTE: The same shape an import entry has, so that one comparison orders
	// both blocks — a bare entry carries no specifier and never needs the empty
	// one this gives it, since nothing spells a bare entry with its Module.
	let sorted: ImportEntry = {
		name: entry.name,
		alias: entry.alias,
		specifier: entry.specifier ?? "",
	}
	let spelling =
		entry.specifier === null ? spellName(sorted) : spellGroup(sorted)

	if (section === null) {
		return openExportBlock(lines, program, spelling)
	}

	// NOTE: Matched on the name the block PUBLISHES — an entry's alias where it
	// carries one — since that is the name a second entry would collide with,
	// whether it forwards the same thing or something else entirely.
	if (
		section.entries.some(
			(candidate) =>
				candidate !== replacing &&
				(candidate.alias ?? candidate.name).content ===
					(entry.alias ?? entry.name),
		)
	) {
		return null
	}

	let group =
		entry.specifier === null
			? undefined
			: section.groups.find(
					(candidate) => candidate.source.path === entry.specifier,
				)

	if (group !== undefined) {
		return insertIntoGroup(lines, group, {
			...sorted,
			specifier: group.source.path,
		})
	}

	// NOTE: A bare name goes among the bare names and in front of every group;
	// a forwarded one goes among the groups, which stand after all of them. So
	// the member the block ends on is the last group where there is one, and
	// that is what either shape falls back to when nothing follows it.
	let bare = section.entries.filter((candidate) => candidate.source === null)
	let successor =
		entry.specifier === null
			? ((
					bare.find(
						(candidate) =>
							compareNames(sorted, entryOf(candidate, "")) < 0,
					) ?? section.groups[0]
				)?.position ?? null)
			: (laterGroup(section.groups, entry.specifier)?.position ?? null)
	let last =
		(section.groups[section.groups.length - 1] ?? bare[bare.length - 1])
			?.position ?? null

	if (last === null) {
		return insertIntoEmptyBlock(lines, section, spelling)
	}

	return insertAmong(
		lines,
		spelling,
		successor,
		last,
		section.position.end.line,
	)
}

// NOTE: The first group of the block a new one for `specifier` belongs in front
// of. Written out rather than inlined because the search reads `specifier` in a
// closure, where its being a String rather than null is no longer in hand.
function laterGroup(
	groups: Array<parser.ExportGroupNode>,
	specifier: string,
): parser.ExportGroupNode | undefined {
	return groups.find(
		(candidate) => compareStrings(specifier, candidate.source.path) < 0,
	)
}

// NOTE: Below the implementation, with a blank line between them, since that is
// where the Parser reads the block and where the Formatter writes it. The
// insertion goes at the END of the implementation's last line rather than at the
// start of the line under it: a file whose last line is that closing brace has
// no line under it to insert at, and a `tests { … }` block that does stand there
// belongs below the export block rather than above it.
function openExportBlock(
	lines: Array<string>,
	program: parser.Program,
	spelling: string,
): ImportEdit {
	let line = program.implementation.position.end.line
	let indentation = indentationOf(
		lines,
		program.implementation.position.start.line,
	)

	return insertionAt(
		line,
		`\n\n${indentation}export {\n${indentation}\t${spelling}\n${indentation}}`,
		(lines[line - 1] ?? "").length + 1,
	)
}

// NOTE: A block with no members of its own, which is the one shape that has
// nowhere to insert BESIDE — the member goes inside the braces rather than
// beside anything, and where the braces stand decides how.
function insertIntoEmptyBlock(
	lines: Array<string>,
	section: parser.ImportSectionNode | parser.ExportSectionNode,
	spelling: string,
): ImportEdit {
	let line = section.position.start.line

	// NOTE: A one-line `import {}` takes the member INSIDE its braces — an
	// insertion on the line after the statement lands outside the block, and
	// the file no longer parses.
	if (section.position.end.line === line) {
		let column = section.position.end.column - 1
		let separator = (lines[line - 1] ?? "")[column - 2] === "{" ? " " : ""

		return insertionAt(line, `${separator}${spelling} `, column)
	}

	// NOTE: An empty block still owns two lines, so the member goes on the one
	// after the brace rather than replacing anything.
	return insertionAt(line + 1, `${indentationOf(lines, line)}\t${spelling}\n`)
}

// NOTE: A group written flat holds one name, and gaining a second is what
// writes it out — so the whole of it is replaced with the two names one to a
// line, in order, which is what the Formatter would make of it. A group
// already written out takes the name on a line of its own at its canonical
// position, and keeps every Comment it holds.
// NOTE: `spelling` is what actually goes in, and it is the entry's own name
// unless the caller is writing SEVERAL at once — a Declaration moved into
// another Module may take more than one name from the one it left, and each
// placed on its own would be several edits computed against a text none of the
// others had landed in. They go in as one run, sorted where the caller sorted
// them and placed by the first of them.
function insertIntoGroup(
	lines: Array<string>,
	group: parser.ImportGroupNode | parser.ExportGroupNode,
	entry: ImportEntry,
	spelling: string = spellName(entry),
): ImportEdit {
	let position = group.position

	if (
		position.start.line === position.end.line &&
		group.entries.length === 1
	) {
		let indentation = indentationOf(lines, position.start.line)
		let written = entryOf(group.entries[0]!, entry.specifier)
		let names = (
			compareNames(written, entry) < 0
				? [spellName(written), spelling]
				: [spelling, spellName(written)]
		).map((name) => `${indentation}\t${name}`)

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
		(candidate) =>
			compareNames(entry, entryOf(candidate, entry.specifier)) < 0,
	)
	let last = group.entries[group.entries.length - 1]!

	return insertAmong(
		lines,
		spelling,
		successor?.position ?? null,
		last.position,
		position.end.line,
	)
}
