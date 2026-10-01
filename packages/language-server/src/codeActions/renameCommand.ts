import type { common } from "@essence-lang/interfaces"

import type { CodeActionEntry } from "./index"

// Opens rename on the placeholder name an extraction wrote. No edit moves a
// cursor, so the action carries the client command `essence.renameAt`.
// Without a document path there is no offer to rename.
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
		// The protocol's zero-based Position, since the editor reads it.
		arguments: [
			documentPath,
			{ line: cursor.line - 1, character: cursor.column - 1 },
		],
	}
}
