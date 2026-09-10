import type { common, parser } from "@essence-lang/interfaces"

import { isSamePosition } from "../positions"
import type { RenameIndex } from "../rename"
import { overlaps, sliceOf } from "./geometry"
import type { CodeActionEntry } from "./index"
import { walk } from "./lookups"

// NOTE: The mirror of the `constant-reassignment` fix, offered where there is
// no Diagnostic to answer: a `variable` nothing ever assigns is a Constant that
// says it might change. The Compiler has nothing to say about that — both
// Programs are correct — so this is a rewrite rather than a fix, and it is
// never preferred: applying it to a name that IS assigned would stop the file
// compiling, and the title says which of the two keywords the reader is asking
// for rather than promising a tidy-up.
//
// What makes it safe is the rename index, which records every site that BINDS a
// value to the name — the declaration and every assignment, wherever it is
// written, a Function literal that captures the name included. One write means
// the declaration and nothing else. The index covers this document alone and
// that is enough: a Variable can not be exported at all (`export-of-variable`),
// so nothing outside the file it is declared in can ever reach it.

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
			// NOTE: A Pattern binds several names at once and each of them is a
			// Declaration of its own, so `variable` there is a keyword over a
			// list rather than over one name — a question this does not ask.
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

		// NOTE: The Statement's Position starts at its keyword, but a `§§`
		// block or a Declaration this Parser recovered from could move it —
		// replacing a span that does not read `variable` would corrupt the
		// line silently. The same reading `constantToVariableAction` makes.
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
