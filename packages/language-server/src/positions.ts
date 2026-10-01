import type { common } from "@essence-lang/interfaces"

// Position geometry for finding the smallest node containing the cursor.

// Whether `a` is at or before `b`.
export function isAtOrBefore(a: common.Cursor, b: common.Cursor): boolean {
	return a.line < b.line || (a.line === b.line && a.column <= b.column)
}

// Compared by value: nothing guarantees a `definition` is one of the
// occurrence objects.
export function isSamePosition(
	a: common.Position,
	b: common.Position,
): boolean {
	return (
		a.start.line === b.start.line &&
		a.start.column === b.start.column &&
		a.end.line === b.end.line &&
		a.end.column === b.end.column
	)
}

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

// Strictly smaller. Callers decide ties, which differ between them.
export function isSmaller(a: common.Position, b: common.Position): boolean {
	let aLines = a.end.line - a.start.line
	let bLines = b.end.line - b.start.line

	if (aLines !== bLines) {
		return aLines < bLines
	}

	return a.end.column - a.start.column < b.end.column - b.start.column
}
