import type { common, parser } from "@essence-lang/interfaces"

import { commaAfter, commaBefore, sliceOf } from "./geometry"
import type { CodeActionEntry } from "./index"
import { findCaseValueOfPayload, findDictionaryEntry } from "./lookups"

// NOTE: The Diagnostics a written VALUE carries — a payload handed to a Case
// that holds none, a key written twice in one bracket list. Both are answered by
// taking something out, and in both the span that goes is wider than the one the
// Diagnostic underlines, which is why each starts from the Node rather than from
// the Position.

// NOTE: The Diagnostic names the payload, and what goes is the payload TOGETHER
// with the parentheses around it — `#Done(1)` becomes `#Done`, which is the only
// spelling a unit Case has. The construction's own Position is what reaches the
// closing bracket, since a Position runs one past what it ends on.
//
// The blanks between the name and the bracket go too, so that `#Done (1)` is
// left as `#Done` rather than as `#Done ` — nothing here leaves trailing space
// behind.
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

	// NOTE: Read back off the buffer, as every edit here is: a span that does
	// not open on a bracket and close on one is a stale analysis pointing at
	// something the reader has since rewritten.
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

// NOTE: The Diagnostic names the KEY and the whole entry is what has to go —
// a key deleted on its own would leave `= 2` standing. The separator beside it
// goes too, or the list is left with a comma against a bracket: the one in
// FRONT wherever there is one, which is every duplicate, since a key written
// twice always has the first one above it. The one AFTER is what a list whose
// only entry is somehow a duplicate would take, and it costs one line to be
// right about a shape nobody has to think about again.
//
// The whitespace between the entry and its comma goes with the comma, which is
// what carries a list written over several lines: the line the entry stood on
// is left empty rather than left holding a stray comma.
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
