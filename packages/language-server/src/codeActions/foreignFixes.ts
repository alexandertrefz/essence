import type { common } from "@essence-lang/interfaces"

import { sliceOf } from "./geometry"
import type { CodeActionEntry } from "./index"

// NOTE: The fixes for text that is not Essence — a JavaScript habit written
// where its Essence spelling belongs, and a Method reached with the separator
// another language reaches one with. Both are answered by writing over a span
// the Compiler measured, which is why neither starts from a Node: a refused
// Statement is DROPPED, so the Program a fix reads holds nothing standing where
// the habit was written.

// NOTE: One span, one spelling — see `essence-spelling`. The habit itself is
// read back off the buffer for the title alone, so that the reader is offered
// the edit in the words they wrote it in.
export function essenceSpellingAction(
	diagnostic: common.Diagnostic & { position: common.Position },
	lines: Array<string>,
): CodeActionEntry | null {
	if (diagnostic.data?.kind !== "essence-spelling") {
		return null
	}

	let { position, spelling } = diagnostic.data
	let written = sliceOf(lines, position).trim()

	// NOTE: Read back off the buffer, as every edit here is: a span holding
	// nothing is a stale analysis pointing at text the reader has since
	// rewritten, and a deletion of it would take whatever now stands there.
	if (written === "") {
		return null
	}

	return {
		// NOTE: The title names the SPELLING and the edit writes the spacing
		// around it — `{ x: 0 }` is answered with "Write '=' instead of ':'" and
		// rewritten as `{ x = 0 }`, since an `=` is written with a blank either
		// side and a `:` is not.
		title:
			spelling === ""
				? `Remove the '${written}'`
				: `Write '${spelling.trim()}' instead of '${written}'`,
		kind: "quickfix",
		diagnosticCode: diagnostic.code,
		diagnosticPosition: diagnostic.position,
		isPreferred: true,
		edits: [{ range: position, newText: spelling }],
	}
}

// NOTE: `names.length` — the `.` becomes `::`, and the `()` a read never wrote
// is written behind the member. TWO edits rather than one for exactly that
// reason: the call's own parentheses are what tells a Method that was read from
// one that was called, and only the first of them needs growing.
export function methodSeparatorAction(
	diagnostic: common.Diagnostic & { position: common.Position },
	lines: Array<string>,
): CodeActionEntry | null {
	if (diagnostic.data?.kind !== "method-with-dot") {
		return null
	}

	let { separator, call } = diagnostic.data

	// NOTE: The separator is everything between the base and the member, so what
	// stands there is one `.` and whatever blanks were written around it.
	// Anything else is a buffer that has moved on since the analysis.
	if (sliceOf(lines, separator).trim() !== ".") {
		return null
	}

	return {
		title: "Call it with '::'",
		kind: "quickfix",
		diagnosticCode: diagnostic.code,
		diagnosticPosition: diagnostic.position,
		isPreferred: true,
		edits: [
			{ range: separator, newText: "::" },
			...(call === null ? [] : [{ range: call, newText: "()" }]),
		],
	}
}
