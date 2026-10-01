import type { common } from "@essence-lang/interfaces"

import { defaultEqualsBefore, readsAsWrittenValue } from "./geometry"
import type { CodeActionEntry } from "./index"

// Removes a `= value` that parses but can never apply: on a Case without a
// payload, a Function literal's Parameter, or a Protocol requirement. The
// Parser already drops it, so the fix is preferred.
export function removeDefaultAction(
	diagnostic: common.Diagnostic & { position: common.Position },
	lines: Array<string>,
): CodeActionEntry | null {
	// The Parser dropped the value, so only the buffer can say whether the
	// span still reads as a whole value. A preferred fix applies unasked, so a
	// stale span must not be cut.
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
