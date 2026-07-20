import type { common } from "../interfaces"

// NOTE: Shared Position geometry for the features that search a typed AST
// for "the smallest node containing the cursor" — Hovers, Completion's
// Scope lookup and Signature Help's enclosing invocation all need it.

// NOTE: Cursor ordering — true when `a` is at or before `b`.
export function isAtOrBefore(a: common.Cursor, b: common.Cursor): boolean {
	return a.line < b.line || (a.line === b.line && a.column <= b.column)
}

// NOTE: Compared by value — a Declaration's `definition` currently aliases
// one of its occurrence objects, but nothing enforces that.
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
