import type { common } from "@essence-lang/interfaces"

import { defaultEqualsBefore, readsAsWrittenValue } from "./geometry"
import type { CodeActionEntry } from "./index"

// NOTE: The three places a `= value` parses and can never fire — a Case with no
// payload to fill in, a Function literal called through a Type that fixes its
// Argument count, and a Protocol requirement, which says which calls a Type must
// answer rather than how one of them answers. All three are the same edit, and
// all three are preferred: the Parser DROPS the default once it has reported, so
// removing it is what makes the source say what the Program already means.
export function removeDefaultAction(
	diagnostic: common.Diagnostic & { position: common.Position },
	lines: Array<string>,
): CodeActionEntry | null {
	// NOTE: The span is the default's VALUE, and the Parser drops that value the
	// moment it reports — a Case left `defaultValue: null`, a Parameter the
	// same — so there is no Node left to measure the deletion off and the
	// buffer is the only witness there is. What it is asked is whether the span
	// still reads as a WHOLE value: a span one keystroke stale reads as
	// something wherever it lands, and `= { a = 1 ` taken out of `Red = { a = 1
	// }, Green` leaves `Red}` behind. All three codes this answers are
	// preferred, so an Editor applies the edit without asking and this is what
	// stands between a stale span and somebody's Choice.
	if (!readsAsWrittenValue(lines, diagnostic.position)) {
		return null
	}

	let start = defaultEqualsBefore(lines, diagnostic.position.start)

	if (start === null) {
		return null
	}

	return {
		title: "Remove the default",
		kind: "quickfix",
		diagnosticCode: diagnostic.code,
		diagnosticPosition: diagnostic.position,
		isPreferred: true,
		edits: [
			{ range: { start, end: diagnostic.position.end }, newText: "" },
		],
	}
}
