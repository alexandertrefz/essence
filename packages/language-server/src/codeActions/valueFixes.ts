import type { common, parser } from "@essence-lang/interfaces"

import { commaAfter, commaBefore, sliceOf } from "./geometry"
import type { CodeActionEntry } from "./index"
import { findCaseValueOfPayload, findDictionaryEntry } from "./lookups"

// Fixes that remove part of a written value. The span removed is wider than
// the Diagnostic's, so each starts from the Node.

// Removes a payload with its parentheses and the blanks before them, so
// `#Done (1)` becomes `#Done`, the only spelling of a unit Case.
export function bareCaseAction(
	diagnostic: common.Diagnostic & { position: common.Position },
	program: parser.Program,
	lines: Array<string>,
): CodeActionEntry | null {
	let construction = findCaseValueOfPayload(program, diagnostic.position)

	if (construction === null) {
		return null
	}

	let range = {
		start: construction.caseName.position.end,
		end: construction.position.end,
	}

	// The span must still be a bracketed payload. See "Reading the buffer
	// back" in DEVELOPMENT.md.
	if (!/^[ \t]*\([\s\S]*\)$/.test(sliceOf(lines, range))) {
		return null
	}

	return {
		title: `Write '#${construction.caseName.content}' on its own`,
		kind: "quickfix",
		diagnosticCode: diagnostic.code,
		diagnosticPosition: diagnostic.position,
		isPreferred: true,
		edits: [{ range, newText: "" }],
	}
}

// Removes a duplicate key's whole entry with the comma before it, or after it
// when none precedes. The whitespace up to the comma goes too, so no line is
// left holding a stray comma.
export function removeEntryAction(
	diagnostic: common.Diagnostic & { position: common.Position },
	program: parser.Program,
	lines: Array<string>,
): CodeActionEntry | null {
	let entry = findDictionaryEntry(program, diagnostic.position)

	if (entry === null) {
		return null
	}

	let start = commaBefore(lines, entry.position.start) ?? entry.position.start
	let end =
		start === entry.position.start
			? (commaAfter(lines, entry.position.end) ?? entry.position.end)
			: entry.position.end

	return {
		title: "Remove this entry",
		kind: "quickfix",
		diagnosticCode: diagnostic.code,
		diagnosticPosition: diagnostic.position,
		isPreferred: true,
		edits: [{ range: { start, end }, newText: "" }],
	}
}
