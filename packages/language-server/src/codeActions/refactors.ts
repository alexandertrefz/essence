import type { common, parser } from "@essence-lang/interfaces"

import { findInlayHints } from "../inlayHints"
import { overlaps, sliceOf } from "./geometry"
import type { CodeActionEntry } from "./index"
import { walk } from "./lookups"

// Refactorings no Diagnostic asks for, offered where the cursor stands. None
// is preferred.

// Applies an Inlay Hint's edit as an annotation. Only a hint whose Type can be
// written carries one; see `addTypeHint`. The title quotes the edit, not the
// label, which may name an Alias this position cannot resolve.
export function annotationActions(
	enrichedProgram: common.typed.Program,
	range: common.Position,
): Array<CodeActionEntry> {
	return findInlayHints(enrichedProgram, range)
		.flatMap((hint) => (hint.textEdit === null ? [] : [hint.textEdit]))
		.map((edit) => ({
			title: `Add explicit Type annotation '${edit.newText.trim()}'`,
			kind: "refactor.rewrite" as const,
			diagnosticCode: null,
			diagnosticPosition: null,
			isPreferred: false,
			edits: [
				...(edit.labelEdit === undefined ? [] : [edit.labelEdit]),
				{
					range: { start: edit.position, end: edit.position },
					newText: edit.newText,
				},
			],
		}))
}

// Rewrites between `{ x }` and `{ x = x }` both ways, which the formatter
// leaves to the author. Only a Record Literal's members qualify; in an update's
// key list the spellings differ.
//
// A key list's Position opens on its first key, a Literal's on its `{`, as
// `printCombination` reads them.
export function shorthandActions(
	program: parser.Program,
	lines: Array<string>,
	range: common.Position,
): Array<CodeActionEntry> {
	let literals: Array<parser.RecordValueNode> = []
	let keyLists = new Set<parser.RecordValueNode>()

	walk(program, (node) => {
		if (node.nodeType === "RecordValue") {
			literals.push(node)

			return
		}

		if (
			node.nodeType === "Combination" &&
			node.rhs.nodeType === "RecordValue" &&
			sliceOf(lines, {
				start: node.rhs.position.start,
				end: {
					line: node.rhs.position.start.line,
					column: node.rhs.position.start.column + 1,
				},
			}) !== "{"
		) {
			keyLists.add(node.rhs)
		}
	})

	let entries: Array<CodeActionEntry> = []

	for (let literal of literals) {
		if (keyLists.has(literal)) {
			continue
		}

		for (let member of Object.values(literal.members)) {
			// A path key or a braced descend has no shorthand.
			if (member.value === null || member.steps !== undefined) {
				continue
			}

			let name = member.name.content
			let span = {
				start: member.name.position.start,
				end: member.value.position.end,
			}

			if (!overlaps(span, range)) {
				continue
			}

			if (member.shorthand === true) {
				entries.push(
					shorthandAction(
						`Expand to '${name} = ${name}'`,
						member.name.position,
						`${name} = ${name}`,
					),
				)
			} else if (
				member.value.nodeType === "Identifier" &&
				member.value.content === name
			) {
				entries.push(
					shorthandAction(`Shorten to '${name}'`, span, name),
				)
			}
		}
	}

	return entries
}

function shorthandAction(
	title: string,
	range: common.Position,
	newText: string,
): CodeActionEntry {
	return {
		title,
		kind: "refactor.rewrite",
		diagnosticCode: null,
		diagnosticPosition: null,
		isPreferred: false,
		edits: [{ range, newText }],
	}
}
