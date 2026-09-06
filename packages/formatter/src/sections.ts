import type { parser } from "@essence-lang/interfaces"

import type { SectionSpan } from "./trivia"

// NOTE: The canonical order of a Module section is more than a Formatter's
// preference: dispatch over imported Namespaces is defined to follow this same
// order — sorted, never written — so re-sorting a block can never change which
// Namespace a Method call resolves to.
//
// Compared by code unit rather than by locale, because every machine that
// formats or compiles the file has to agree on the result.
function compareStrings(left: string, right: string): number {
	if (left === right) {
		return 0
	}

	return left < right ? -1 : 1
}

function compareKeys(left: Array<string>, right: Array<string>): number {
	for (let index = 0; index < left.length; index++) {
		let order = compareStrings(
			left[index] as string,
			right[index] as string,
		)

		if (order !== 0) {
			return order
		}
	}

	return 0
}

// NOTE: The local name an entry binds under, which is what tells two entries
// naming the same thing from the same file apart. Only `as` can produce that
// pair, and it is a Diagnostic — but the Formatter still has to write it the
// same way every time.
function localName(entry: parser.ImportNode | parser.ExportNode): string {
	return entry.alias === null ? "" : entry.alias.content
}

// NOTE: The order of the names inside one group, and of the bare names of an
// export block: by the exported name, then by the local one.
export function compareEntries(
	left: parser.ImportNode | parser.ExportNode,
	right: parser.ImportNode | parser.ExportNode,
): number {
	return compareKeys(
		[left.name.content, localName(left)],
		[right.name.content, localName(right)],
	)
}

// NOTE: What a group is ordered by: its specifier, and the names inside it —
// the shape of a group node, and of what the printer holds while it lays one
// out.
type GroupHead = {
	source: parser.ModuleSpecifierNode
	entries: Array<{ name: parser.IdentifierNode }>
}

// NOTE: Groups are ordered by specifier. Two groups written for one file are
// left as two — merging them would have to decide which of them keeps its
// Comments — and stand next to each other, ordered by the first name in each,
// which is where a reader finds them to fold together.
//
// Asked of groups whose entries are already in order, since that first name
// is what they are compared on.
export function compareGroups(left: GroupHead, right: GroupHead): number {
	return compareKeys(
		[left.source.path, left.entries[0]?.name.content ?? ""],
		[right.source.path, right.entries[0]?.name.content ?? ""],
	)
}

// NOTE: Every group with its names in order, and the groups in order among
// themselves.
export function sortedGroups<
	Group extends parser.ImportGroupNode | parser.ExportGroupNode,
>(groups: Array<Group>): Array<Group> {
	return groups
		.map(
			(group): Group => ({
				...group,
				entries: [...group.entries].sort(compareEntries),
			}),
		)
		.sort(compareGroups)
}

// NOTE: The same Program with both Module sections in canonical order. Sorting
// a block is the one thing the Formatter is allowed to reorder, and the gate
// that compares the AST before and after formatting reads the entry lists in
// order — so both sides are brought into canonical order before they are
// compared, rather than the reordering being waved through wholesale.
//
// `entries` is rebuilt from the sorted groups, because it is the flat list in
// written order and the written order is what the sort changes. What a Module
// declares itself comes first in an export block, then what it forwards — a
// re-export names another file rather than anything in this one, so the two
// read as separate lists even though they share a block.
export function canonicalSections(program: parser.Program): parser.Program {
	let imports = program.imports
	let exports = program.exports

	if (imports !== null) {
		let groups = sortedGroups(imports.groups)

		imports = {
			...imports,
			groups,
			entries: groups.flatMap((group) => group.entries),
		}
	}

	if (exports !== null) {
		let groups = sortedGroups(exports.groups)
		let bare = exports.entries
			.filter((entry) => entry.source === null)
			.sort(compareEntries)

		exports = {
			...exports,
			groups,
			entries: [...bare, ...groups.flatMap((group) => group.entries)],
		}
	}

	return { ...program, imports, exports }
}

// NOTE: Read off the Program as it was written, never off a canonicalised copy:
// the anchor comparison groups each entry with the Comments around it by the
// same written order the trivia cursor walks.
//
// An entry is keyed by the specifier of its group, and a bare export entry by
// nothing, so that a Comment moving from the `Optional` of one group to the
// `Optional` of another is still a Comment that moved.
export function sectionSpans(program: parser.Program): Array<SectionSpan> {
	let spans: Array<SectionSpan> = []

	for (let section of [program.imports, program.exports]) {
		if (section === null) {
			continue
		}

		spans.push({
			position: section.position,
			groups: section.groups.map((group) => group.position),
			entries: section.entries.map((entry) => ({
				position: entry.position,
				key: entry.source === null ? "" : entry.source.path,
			})),
		})
	}

	return spans
}
