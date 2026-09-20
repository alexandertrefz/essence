import type { common, parser } from "@essence-lang/interfaces"

import { findInlayHints } from "../inlayHints"
import { overlaps, sliceOf } from "./geometry"
import type { CodeActionEntry } from "./index"
import { walk } from "./lookups"

// NOTE: The Code Actions no Diagnostic asks for. Each is offered on code the
// Compiler has nothing to say about, on the strength of where the cursor
// stands — which is why every one of them reads the range it was given and
// none of them is ever preferred.

// NOTE: An Inlay Hint already IS this edit — it sits where the annotation
// would be written and reads as the annotation would read. Offering it as a
// refactor makes the hint applicable rather than only visible, and adds no
// inference of its own.
//
// Only the hints that carry an edit. A hint whose Type can not be written down
// shows what was inferred and offers nothing — see `typeHint` — and the ones
// this used to offer regardless were the worst edits in the editor: `: List<
// Unknown>` and `: NonEmptyList<Error>` added `unknown-type` on top of whatever
// was already wrong, and a Function Type stopped the file parsing outright.
//
// NOTE: The EDIT's own text, in the title as well as in the edit. A hint's
// LABEL may name an Alias this position can not resolve — `: Result<Integer,
// Problem>` in a file that imported no `Problem` — and the edit behind it
// spells the shape instead, so a title quoting the label would promise one
// annotation and write another.
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
				{
					range: { start: edit.position, end: edit.position },
					newText: edit.newText,
				},
			],
		}))
}

// NOTE: The Formatter never rewrites between `{ x }` and `{ x = x }` — the
// spelling is the author's — so the rewrite is offered here instead, in both
// directions, on a Record LITERAL's members only.
//
// An update's key list is excluded, because there the two spellings are not the
// same thing: `{ base with x }` merges the VALUE `x`, and a shorthand there is
// refused outright. The key list is told apart from a braced right-hand side
// the one way it can be — a Literal's Position opens on its own `{`, and a key
// list's opens on its first key — which is the same reading `printCombination`
// makes.
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
			// NOTE: A path key names no binding and a braced descend holds no
			// value at all, so neither has a shorthand to offer or to expand.
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
