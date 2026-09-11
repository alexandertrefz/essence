import type { common } from "@essence-lang/interfaces"

import type { CodeActionEntry } from "./index"

// NOTE: How an extraction hands the name it invented back to the reader. The
// edits leave a derived placeholder — `total`, `extracted` — standing where a
// name has to stand, and the one gesture that turns a placeholder into a
// question is opening rename on it. No edit can put a cursor anywhere, so the
// action carries a CLIENT command instead: `essence.renameAt` in the extension
// opens the document at this Cursor and runs the Editor's own rename.
//
// Absent when the request named no document — a test analysing a String, and
// anything else with no URI to hand back. The edits are the same either way;
// what is lost is only the offer to rename.
export function renameCommand(
	documentPath: string | undefined,
	cursor: common.Cursor,
): CodeActionEntry["command"] {
	if (documentPath === undefined) {
		return undefined
	}

	return {
		title: "Rename",
		command: "essence.renameAt",
		// NOTE: The protocol's Position — zero based on both axes — because
		// what reads it is the Editor rather than anything in this Server.
		arguments: [
			documentPath,
			{ line: cursor.line - 1, character: cursor.column - 1 },
		],
	}
}
