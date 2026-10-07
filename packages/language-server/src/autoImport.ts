import * as path from "node:path"

import type { common, parser } from "@essence-lang/interfaces"

// One edit builder for every feature that adds an import entry, so all write
// the same spelling in the same place. That is where `esfmt` would write it: in
// its Module's group sorted by name, or in a new group sorted by specifier.

export type ImportEdit = {
	// An insertion is a zero-width Range. The one replacement rewrites a group
	// written flat as the same group written out.
	range: common.Position
	newText: string
}

export type ImportEntry = {
	// The name the other Module publishes, never the local one.
	name: string
	alias: string | null
	specifier: string
}

// An export entry: a bare name this Module declares, or one it forwards from
// `specifier`, which is null for a bare entry.
type ExportEntry = {
	// The name as written at home, which orders the block; an `as` renames only
	// what the entry publishes.
	name: string
	alias: string | null
	specifier: string | null
}

// The relative specifier from `fromPath` to `toPath`, with forward slashes on
// every platform.
export function relativeSpecifier(fromPath: string, toPath: string): string {
	let relative = path
		.relative(path.dirname(fromPath), toPath)
		.split(path.sep)
		.join("/")

	return relative.startsWith("../") ? relative : `./${relative}`
}

// The canonical order of names and groups, as `compareEntries` and
// `compareGroups` in the Formatter and the Compiler's linker order them. By code
// unit, so every machine agrees.
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

export function spellName(entry: ImportEntry): string {
	return entry.alias === null ? entry.name : `${entry.name} as ${entry.alias}`
}

// A group of one name, as the Formatter writes one.
function spellGroup(entry: ImportEntry): string {
	return `from "${entry.specifier}" { ${spellName(entry)} }`
}

// The specifier is handed in: an export group's entry carries its group's, and
// a bare entry none.
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

// Whether anything but whitespace precedes `column` on `line`, so the text
// must go inline.
function sharesLine(lines: Array<string>, line: number, column: number) {
	return /[^ \t]/.test((lines[line - 1] ?? "").slice(0, column - 1))
}

// `spelling` placed before `successor`, inline where `successor` shares its
// line with other text, else after `last`. A spelling of several lines holds a
// Comment, which would swallow the rest of a shared line, so it breaks the line.
function insertAmong(
	lines: Array<string>,
	spelling: string,
	successor: common.Position | null,
	last: common.Position,
	closeLine: number,
): ImportEdit {
	let inline = !spelling.includes("\n")

	if (successor !== null) {
		let line = successor.start.line
		let indentation = indentationOf(lines, line)
		let written = indentedLines(spelling, indentation)

		if (sharesLine(lines, line, successor.start.column)) {
			return insertionAt(
				line,
				inline ? `${spelling} ` : `\n${written}\n${indentation}`,
				successor.start.column,
			)
		}

		return insertionAt(line, `${written}\n`)
	}

	let line = last.end.line
	let written = indentedLines(spelling, indentationOf(lines, line))

	if (closeLine === line) {
		return insertionAt(
			line,
			inline ? ` ${spelling}` : `\n${written}`,
			last.end.column,
		)
	}

	return insertionAt(line + 1, `${written}\n`)
}

// Each line of a spelling at one indentation.
function indentedLines(spelling: string, indentation: string): string {
	return spelling
		.split("\n")
		.map((line) => `${indentation}${line}`)
		.join("\n")
}

// A name with the Comments it carries written above it.
function spellCarried(entry: ImportEntry, comments: Array<string>): string {
	return [...comments, spellName(entry)].join("\n")
}

// Null when the entry exists already, perhaps under an alias or in a second
// entry, since a duplicate is worse than no fix. The name joins its Module's
// group, or opens one at the canonical position. `comments` go above a name
// that joins a group, as a moved entry carries them.
export function insertImportEdit(
	sourceText: string,
	program: parser.Program,
	entry: ImportEntry,
	comments: Array<string> = [],
): ImportEdit | null {
	let lines = sourceText.split("\n")
	let section = program.imports

	if (section === null) {
		// Above the implementation, followed by a blank line, measured from the
		// implementation's own line so leading comments stay above the block.
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
		return insertIntoGroup(
			lines,
			group,
			entry,
			spellCarried(entry, comments),
		)
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

// Several entries, from one Module or several, as when a moved Declaration
// takes along the names it reads. Separate calls would each be computed
// against text the others had not landed in. Entries imported already are left
// out, and the edits are listed in the order their text should appear.
export function insertImportsEdits(
	sourceText: string,
	program: parser.Program,
	entries: Array<ImportEntry>,
): Array<ImportEdit> {
	let lines = sourceText.split("\n")
	let section = program.imports
	let fresh = entries.filter(
		(entry) =>
			section === null ||
			!section.entries.some(
				(candidate) =>
					candidate.source.path === entry.specifier &&
					candidate.name.content === entry.name &&
					(candidate.alias?.content ?? null) === entry.alias,
			),
	)

	if (fresh.length === 0) {
		return []
	}

	if (section === null) {
		let line = program.implementation.position.start.line

		return [
			insertionAt(
				line,
				`${importBlock(fresh, indentationOf(lines, line))}\n`,
			),
		]
	}

	return groupsOf(fresh).map((group) => {
		let spelling = group.map(spellName).join(" ")
		let first = group[0] as ImportEntry
		let written = section.groups.find(
			(candidate) => candidate.source.path === first.specifier,
		)

		if (written !== undefined) {
			return insertIntoGroup(lines, written, first, spelling)
		}

		let opened = `from "${first.specifier}" { ${spelling} }`

		if (section.groups.length === 0) {
			return insertIntoEmptyBlock(lines, section, opened)
		}

		let successor = section.groups.find(
			(candidate) =>
				compareStrings(first.specifier, candidate.source.path) < 0,
		)
		let last = section.groups[
			section.groups.length - 1
		] as parser.ImportGroupNode

		return insertAmong(
			lines,
			opened,
			successor?.position ?? null,
			last.position,
			section.position.end.line,
		)
	})
}

// A whole import block, each Module's names written as one group on one line.
// The Formatter rewrites a group of several.
export function importBlock(
	entries: Array<ImportEntry>,
	indentation: string,
): string {
	let written = groupsOf(entries).map(
		(group) =>
			`${indentation}\tfrom "${(group[0] as ImportEntry).specifier}" { ${group
				.map(spellName)
				.join(" ")} }`,
	)

	return `${indentation}import {\n${written.join("\n")}\n${indentation}}\n`
}

// The entries by Module, each group sorted by name and the groups by
// specifier, as the Formatter orders them.
function groupsOf(entries: Array<ImportEntry>): Array<Array<ImportEntry>> {
	let bySpecifier = new Map<string, Array<ImportEntry>>()

	for (let entry of entries) {
		let group = bySpecifier.get(entry.specifier) ?? []

		if (
			!group.some(
				(other) =>
					other.name === entry.name && other.alias === entry.alias,
			)
		) {
			group.push(entry)
		}

		bySpecifier.set(entry.specifier, group)
	}

	return [...bySpecifier.keys()]
		.sort(compareStrings)
		.map((specifier) =>
			(bySpecifier.get(specifier) as Array<ImportEntry>).sort(
				compareNames,
			),
		)
}

// The export block's side of the builder, null when the name is published
// already. Ordered as the Formatter orders it: bare names by name first, then
// forwarded ones by specifier.
export function insertExportEdit(
	sourceText: string,
	program: parser.Program,
	entry: ExportEntry,
	// An entry the caller removes in the same edit, so publishing its name again
	// is no collision. Its place still counts, so the two edits meet end to end.
	replacing: parser.ExportNode | null = null,
	// Written above a name that joins a group, as for `insertImportEdit`.
	comments: Array<string> = [],
): ImportEdit | null {
	let lines = sourceText.split("\n")
	let section = program.exports
	// The shape of an import entry, so one comparison orders both blocks. A bare
	// entry's empty specifier is never written.
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

	// Matched on the published name, an entry's alias where it has one.
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
		let joining = { ...sorted, specifier: group.source.path }

		return insertIntoGroup(
			lines,
			group,
			joining,
			spellCarried(joining, comments),
		)
	}

	// Bare names stand before every group, so the block ends on its last group
	// where it has one, which either shape falls back to.
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

// The first group a new one for `specifier` goes before. A function, since a
// closure would lose that `specifier` is a String.
function laterGroup(
	groups: Array<parser.ExportGroupNode>,
	specifier: string,
): parser.ExportGroupNode | undefined {
	return groups.find(
		(candidate) => compareStrings(specifier, candidate.source.path) < 0,
	)
}

// Below the implementation, after a blank line. Inserted at the end of the
// implementation's last line, which may be the file's last line, and before
// any `tests` block.
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

// A block without members, where the member goes inside the braces.
function insertIntoEmptyBlock(
	lines: Array<string>,
	section: parser.ImportSectionNode | parser.ExportSectionNode,
	spelling: string,
): ImportEdit {
	let line = section.position.start.line

	// A one-line `import {}` takes the member inside its braces; a new line after
	// it would land outside the block.
	if (section.position.end.line === line) {
		let column = section.position.end.column - 1
		let separator = (lines[line - 1] ?? "")[column - 2] === "{" ? " " : ""

		return insertionAt(line, `${separator}${spelling} `, column)
	}

	// An empty block spans two lines; the member goes on the one after the brace.
	return insertionAt(line + 1, `${indentationOf(lines, line)}\t${spelling}\n`)
}

// A flat group of one name gaining a second is rewritten with one name to a
// line, as the Formatter would. A written-out group takes the name on its own
// line and keeps its comments. `spelling` may be a sorted run of names, or a
// name with Comments above it, which rewrites any flat group.
function insertIntoGroup(
	lines: Array<string>,
	group: parser.ImportGroupNode | parser.ExportGroupNode,
	entry: ImportEntry,
	spelling: string = spellName(entry),
): ImportEdit {
	let position = group.position

	if (
		position.start.line === position.end.line &&
		(group.entries.length === 1 || spelling.includes("\n"))
	) {
		let indentation = indentationOf(lines, position.start.line)
		let names = [
			...group.entries.map((node) => {
				let written = entryOf(node, entry.specifier)

				return { entry: written, spelling: spellName(written) }
			}),
			{ entry, spelling },
		]
			.sort((left, right) => compareNames(left.entry, right.entry))
			.map((name) => indentedLines(name.spelling, `${indentation}\t`))

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
