import type { common, parser } from "@essence-lang/interfaces"

import { isSamePosition } from "../positions"
import { sliceOf } from "./geometry"
import type { CodeActionEntry } from "./index"
import { walk } from "./lookups"

// Shorthands an update's key list does not take, unlike a Record Literal's
// `{ port }`. Each fix writes the value the shorthand would stand for, as its
// Diagnostic's Help says, and is preferred.

const namePattern = /^[A-Za-z_][A-Za-z0-9_]*$/

// Only a Record update gets the fix, which the AST tells apart: it keeps its
// key list, while a refused Dictionary update leaves no Node. A Dictionary key
// is a value, so `a = a` would mean something else.
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

// A path key's value is named by its last step, the binding a reader writing
// `{ config with server.port }` meant. It is read off the buffer, where the
// Diagnostic underlines the steps.
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

	// The Help names the binding only where the Scope holds one, and the fix
	// writes what the Help names.
	if (!diagnostic.helps.includes(`Write '${written} = ${last}'.`)) {
		return null
	}

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
