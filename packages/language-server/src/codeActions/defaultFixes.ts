import type { common } from "@essence-lang/interfaces"

import { defaultEqualsBefore, sliceOf } from "./geometry"
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
	// NOTE: The span is the default's VALUE, so an empty one says the buffer has
	// moved on since the Diagnostic was made and there is nothing to delete.
	if (sliceOf(lines, diagnostic.position).trim() === "") {
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
