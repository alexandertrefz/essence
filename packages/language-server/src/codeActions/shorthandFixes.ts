import type { common, parser } from "@essence-lang/interfaces"

import { isSamePosition } from "../positions"
import { sliceOf } from "./geometry"
import type { CodeActionEntry } from "./index"
import { walk } from "./lookups"

// NOTE: The two shorthands an update's key list does not have. A Record
// Literal's member list takes `{ port }` for `{ port = port }`; a key list does
// not, because a bare name after `with` is already the whole value being merged
// in. Both fixes write the value the shorthand would have stood for, which is
// the Help each Diagnostic gives — and both are preferred, since a key list
// spells its values and there is nothing else a bare key could become.

const namePattern = /^[A-Za-z_][A-Za-z0-9_]*$/

// NOTE: Found through the AST rather than off the buffer alone, which is the
// one thing that tells the two shapes carrying this code apart. A RECORD update
// recovers its key list and keeps it — `{ base with port }` is a Combination
// whose right side is a member list — while a DICTIONARY update (`[d with a,
// b]`) is refused outright and leaves no Node behind. The expansion belongs to
// the first only: a Dictionary's key is a VALUE, so `a = a` there says something
// else entirely rather than saying what was meant the long way round.
export function expandShorthandKeyAction(
	diagnostic: common.Diagnostic & { position: common.Position },
	program: parser.Program,
	lines: Array<string>,
): CodeActionEntry | null {
	let written = sliceOf(lines, diagnostic.position)

	if (!namePattern.test(written) || !isRecordKey(program, diagnostic)) {
		return null
	}

	return {
		title: `Write '${written} = ${written}'`,
		kind: "quickfix",
		diagnosticCode: diagnostic.code,
		diagnosticPosition: diagnostic.position,
		isPreferred: true,
		edits: [
			{
				range: {
					start: diagnostic.position.end,
					end: diagnostic.position.end,
				},
				newText: ` = ${written}`,
			},
		],
	}
}

function isRecordKey(
	program: parser.Program,
	diagnostic: common.Diagnostic & { position: common.Position },
): boolean {
	let found = false

	walk(program, (node) => {
		if (
			node.nodeType !== "Combination" ||
			node.brackets === true ||
			node.rhs.nodeType !== "RecordValue"
		) {
			return
		}

		for (let member of Object.values(node.rhs.members)) {
			if (
				member.shorthand === true &&
				member.steps === undefined &&
				isSamePosition(member.name.position, diagnostic.position)
			) {
				found = true
			}
		}
	})

	return found
}

// NOTE: A path key never had a reading to recover — there is no `a.b = a.b` for
// a bare path to have been short for — so the value it sets is named by the
// LAST step, which is the binding a reader writing `{ config with server.port }`
// meant. Read off the buffer rather than off the Node, as every edit here is:
// the steps are what the Diagnostic underlines, and the last of them is the one
// that names anything.
const pathPattern = /^[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z_][A-Za-z0-9_]*)+$/

export function expandShorthandPathAction(
	diagnostic: common.Diagnostic & { position: common.Position },
	lines: Array<string>,
): CodeActionEntry | null {
	let written = sliceOf(lines, diagnostic.position)

	if (!pathPattern.test(written)) {
		return null
	}

	let last = written.slice(written.lastIndexOf(".") + 1)

	return {
		title: `Write '${written} = ${last}'`,
		kind: "quickfix",
		diagnosticCode: diagnostic.code,
		diagnosticPosition: diagnostic.position,
		isPreferred: true,
		edits: [
			{
				range: {
					start: diagnostic.position.end,
					end: diagnostic.position.end,
				},
				newText: ` = ${last}`,
			},
		],
	}
}
