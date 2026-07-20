import type { common } from "../interfaces"

// NOTE: Shared Position geometry for the features that search a typed AST
// for "the smallest node containing the cursor".

export function contains(
	range: common.Position,
	cursor: common.Cursor,
): boolean {
	let afterStart =
		cursor.line > range.start.line ||
		(cursor.line === range.start.line &&
			cursor.column >= range.start.column)

	let beforeEnd =
		cursor.line < range.end.line ||
		(cursor.line === range.end.line && cursor.column <= range.end.column)

	return afterStart && beforeEnd
}

// NOTE: Strictly smaller — ties are left to the caller, since callers differ
// on whether a tie should keep the first or the latest candidate.
export function isSmaller(a: common.Position, b: common.Position): boolean {
	let aLines = a.end.line - a.start.line
	let bLines = b.end.line - b.start.line

	if (aLines !== bLines) {
		return aLines < bLines
	}

	return a.end.column - a.start.column < b.end.column - b.start.column
}
