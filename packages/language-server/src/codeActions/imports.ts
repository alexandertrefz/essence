import type { common, parser } from "@essence-lang/interfaces"

import { isSamePosition } from "../positions"
import { removeLinesEdit } from "./geometry"
import type { CodeActionEdit, CodeActionEntry } from "./index"

// NOTE: Every `unused-import` in the document answered at once, as the one
// SOURCE action this Server offers. There is deliberately no fix-all beside it:
// a bulk action has to be both unambiguous and semantics-preserving, and
// removing an entry nothing reads is the only rewrite here that is both — every
// other fix is applied by hand and read before it is accepted.
//
// Sorting is not its job, whatever the LSP kind is called. The Formatter sorts
// an import block and it is the only thing that may, since a Code Action writing
// a second ordering beside it would be two answers to one question.
//
// The Warnings are read from the whole document rather than from the requested
// range: a `source.*` action stands for the document, and an Editor asks for it
// from the Source Action menu rather than from a lightbulb over one line.

export function organizeImportActions(
	program: parser.Program,
	lines: Array<string>,
	diagnostics: Array<common.Diagnostic>,
): Array<CodeActionEntry> {
	// NOTE: The Positions rather than the Diagnostics — what is asked of them
	// below is only which entry each one names.
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
		// NOTE: The Warning points at the LOCAL name, which is the alias where
		// there is one — the same reading `removeImportAction` makes of one
		// entry, so the two can not come to disagree about which entry a
		// Warning names.
		let removed = group.entries.filter((entry) =>
			unused.some((position) =>
				isSamePosition((entry.alias ?? entry.name).position, position),
			),
		)

		if (removed.length === 0) {
			continue
		}

		// NOTE: A group with nothing left in it goes whole — `from "./A.es" {}`
		// imports nothing and says so on two lines — and as ONE deletion rather
		// than one per entry, or the lines the group is written on would be
		// deleted by the entries standing on them and by the group around them
		// both.
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
			// NOTE: Null although this answers Warnings — SEVERAL of them, and
			// the pair names one. What the pair is for is finding the client's
			// own Diagnostic to retire once the action lands, and a source
			// action is not offered against any one of them.
			diagnosticCode: null,
			diagnosticPosition: null,
			// NOTE: Nor preferred, for the same reason: `isPreferred` picks
			// between the actions offered on one span, and this one is offered
			// on none.
			isPreferred: false,
			edits,
		},
	]
}
