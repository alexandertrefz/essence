import type { common, parser } from "@essence-lang/interfaces"

import { isSamePosition } from "../positions"
import type { RenameIndex } from "../rename"
import { overlaps, sliceOf } from "./geometry"
import type { CodeActionEntry } from "./index"
import { walk } from "./lookups"

// Declares a `variable` that nothing assigns as a Constant. Both Programs are
// correct, so this is a rewrite, never preferred, rather than a fix.
//
// The rename index records every write to the name, captures included, so one
// write means only the declaration. A Variable cannot be exported, so this
// document's index is enough.

const variableKeyword = "variable"

export function constantActions(
	program: parser.Program,
	index: () => RenameIndex,
	lines: Array<string>,
	range: common.Position,
): Array<CodeActionEntry> {
	let entries: Array<CodeActionEntry> = []

	walk(program, (node) => {
		if (
			node.nodeType !== "VariableDeclarationStatement" ||
			// A Pattern's `variable` covers several names, so it is skipped.
			node.name.nodeType !== "Identifier" ||
			!overlaps(node.position, range)
		) {
			return
		}

		let keyword = {
			start: node.position.start,
			end: {
				line: node.position.start.line,
				column: node.position.start.column + variableKeyword.length,
			},
		}

		// A `§§` block or a recovered Declaration could move the keyword, so
		// the span must read `variable`, as in `constantToVariableAction`.
		if (sliceOf(lines, keyword) !== variableKeyword) {
			return
		}

		let name = node.name
		let declared = index().find(
			(occurrence) =>
				occurrence.access === "write" &&
				isSamePosition(occurrence.position, name.position),
		)

		if (declared === undefined) {
			return
		}

		let writes = index().filter(
			(occurrence) =>
				occurrence.access === "write" &&
				occurrence.declaration === declared.declaration,
		)

		if (writes.length !== 1) {
			return
		}

		entries.push({
			title: `Declare '${name.content}' as a Constant`,
			kind: "refactor.rewrite",
			diagnosticCode: null,
			diagnosticPosition: null,
			isPreferred: false,
			edits: [{ range: keyword, newText: "constant" }],
		})
	})

	return entries
}
