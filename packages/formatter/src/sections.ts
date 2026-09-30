import type { parser } from "@essence-lang/interfaces"

import type { SectionSpan } from "./trivia"

// By code unit rather than by locale, so that every machine agrees.
// See "Module sections" in DEVELOPMENT.md.
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

// Tells apart two entries that name one thing from one file, which only `as`
// can write. They still have to come out in the same order every time.
function localName(entry: parser.ImportNode | parser.ExportNode): string {
	return entry.alias === null ? "" : entry.alias.content
}

// The order of the names in a group, and of the bare names of an export
// block.
export function compareEntries(
	left: parser.ImportNode | parser.ExportNode,
	right: parser.ImportNode | parser.ExportNode,
): number {
	return compareKeys(
		[left.name.content, localName(left)],
		[right.name.content, localName(right)],
	)
}

// A group node, or what the Printer holds while it lays one out.
type GroupHead = {
	source: parser.ModuleSpecifierNode
	entries: Array<{ name: parser.IdentifierNode }>
}

// Two groups for one file stay two, ordered by their first names, so their
// entries have to be sorted first.
export function compareGroups(left: GroupHead, right: GroupHead): number {
	return compareKeys(
		[left.source.path, left.entries[0]?.name.content ?? ""],
		[right.source.path, right.entries[0]?.name.content ?? ""],
	)
}

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

// Rebuilds the flat `entries` list too, which is in written order. An export
// block lists what the Module declares before what it forwards.
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

// Read off the Program as written, never off a sorted copy. The key tells an
// entry from its namesake in another group. See "Comment anchors" in
// DEVELOPMENT.md.
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
