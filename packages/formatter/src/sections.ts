import type { parser } from "@essence/interfaces"

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

export function compareImportEntries(
	left: parser.ImportNode,
	right: parser.ImportNode,
): number {
	return compareKeys(
		[left.source.path, left.name.content, localName(left)],
		[right.source.path, right.name.content, localName(right)],
	)
}

// NOTE: What a Module declares itself comes first, then what it forwards — a
// re-export names another file rather than anything in this one, so the two read
// as separate lists even though they share a block. That is what the leading
// key says, and it is the only reason it is there.
export function compareExportEntries(
	left: parser.ExportNode,
	right: parser.ExportNode,
): number {
	return compareKeys(exportKey(left), exportKey(right))
}

function exportKey(entry: parser.ExportNode): Array<string> {
	return entry.source === null
		? ["0", "", entry.name.content, localName(entry)]
		: ["1", entry.source.path, entry.name.content, localName(entry)]
}

// NOTE: The same Program with both Module sections in canonical order. Sorting
// a block is the one thing the Formatter is allowed to reorder, and the gate
// that compares the AST before and after formatting reads the entry lists in
// order — so both sides are brought into canonical order before they are
// compared, rather than the reordering being waved through wholesale.
export function canonicalSections(program: parser.Program): parser.Program {
	return {
		...program,
		imports:
			program.imports === null
				? null
				: {
						...program.imports,
						entries: [...program.imports.entries].sort(
							compareImportEntries,
						),
					},
		exports:
			program.exports === null
				? null
				: {
						...program.exports,
						entries: [...program.exports.entries].sort(
							compareExportEntries,
						),
					},
	}
}

// NOTE: Read off the Program as it was written, never off a canonicalised copy:
// the anchor comparison groups each entry with the Comments around it by the
// same written order the trivia cursor walks.
export function sectionSpans(program: parser.Program): Array<SectionSpan> {
	let spans: Array<SectionSpan> = []

	for (let section of [program.imports, program.exports]) {
		if (section === null) {
			continue
		}

		spans.push({
			position: section.position,
			entries: section.entries.map((entry) => entry.position),
		})
	}

	return spans
}
