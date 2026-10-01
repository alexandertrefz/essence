import type { common, parser } from "@essence-lang/interfaces"

import { isSamePosition } from "../positions"
import { isBefore, removeLinesEdit } from "./geometry"
import type { CodeActionEdit, CodeActionEntry } from "./index"

// Every `unused-import` in the document answered at once, as the Server's only
// source action. No other fix is safe to apply in bulk, so there is no fix-all.
// The formatter alone sorts an import block.
//
// A `source.*` action stands for the whole document, so the Warnings are read
// from all of it rather than from the requested range.

export function organizeImportActions(
	program: parser.Program,
	lines: Array<string>,
	diagnostics: Array<common.Diagnostic>,
): Array<CodeActionEntry> {
	// Only the Positions matter: they name the entries.
	let unused = diagnostics.flatMap((diagnostic) =>
		diagnostic.code === "unused-import" && diagnostic.position !== null
			? [diagnostic.position]
			: [],
	)

	if (unused.length === 0) {
		return []
	}

	let edits: Array<CodeActionEdit> = []

	for (let group of program.imports?.groups ?? []) {
		// The Warning points at the local name, the alias where there is one,
		// as `removeImportAction` reads it.
		let removed = group.entries.filter((entry) =>
			unused.some((position) =>
				isSamePosition((entry.alias ?? entry.name).position, position),
			),
		)

		if (removed.length === 0) {
			continue
		}

		// A group left empty goes whole, as one deletion, so no line is
		// deleted by both an entry and its group.
		edits.push(
			...(removed.length === group.entries.length
				? [removeLinesEdit(lines, group.position)]
				: removed.map((entry) =>
						removeLinesEdit(lines, entry.position),
					)),
		)
	}

	if (edits.length === 0) {
		return []
	}

	return [
		{
			title: "Remove the unused imports",
			kind: "source.organizeImports",
			// Null: the pair names one Diagnostic for the client to retire,
			// and this answers several.
			diagnosticCode: null,
			diagnosticPosition: null,
			// `isPreferred` chooses among actions on one span, and this one
			// has none.
			isPreferred: false,
			edits: merged(lines, edits),
		},
	]
}

// Deletions of entries on one line share the blanks between them, and an
// editor refuses overlapping ranges. Since every edit deletes, ranges that meet
// are folded into their union.
function merged(
	lines: Array<string>,
	edits: Array<CodeActionEdit>,
): Array<CodeActionEdit> {
	let sorted = [...edits].sort((left, right) =>
		isBefore(left.range.start, right.range.start) ? -1 : 1,
	)
	let folded: Array<CodeActionEdit> = []

	for (let edit of sorted) {
		let last = folded.at(-1)

		if (last === undefined || isBefore(last.range.end, edit.range.start)) {
			folded.push({ ...edit, range: { ...edit.range } })

			continue
		}

		if (isBefore(last.range.end, edit.range.end)) {
			last.range.end = edit.range.end
		}
	}

	// A fold covering everything on one line takes the line, as each of its
	// deletions would alone.
	return folded.map((edit) =>
		edit.range.start.line === edit.range.end.line
			? removeLinesEdit(lines, edit.range)
			: edit,
	)
}
