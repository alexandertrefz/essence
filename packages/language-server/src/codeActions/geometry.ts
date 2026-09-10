import type { common } from "@essence-lang/interfaces"

import type { CodeActionEdit } from "./index"

// NOTE: The buffer read as characters rather than as Nodes — a column, a
// slice, the comma beside an Argument, the brace a body ends on. Every edit a
// Code Action offers is measured against the LIVE text the request handed in,
// and this is what does the measuring: nothing here knows what a Node is.

export function overlaps(
	position: common.Position,
	range: common.Position,
): boolean {
	return (
		!isBefore(position.end, range.start) &&
		!isBefore(range.end, position.start)
	)
}

// NOTE: The other reading of the same pair — `range` lies INSIDE `position`,
// both edges included. What a Diagnostic's span asks of a request is whether
// the two touch at all; what a selection asks of a Node is which Nodes hold
// it, and a cursor resting on a Node's first or last character is held by it.
export function containsRange(
	position: common.Position,
	range: common.Position,
): boolean {
	return (
		!isBefore(range.start, position.start) &&
		!isBefore(position.end, range.end)
	)
}

export function isBefore(a: common.Cursor, b: common.Cursor): boolean {
	return a.line < b.line || (a.line === b.line && a.column < b.column)
}

export function lineAt(lines: Array<string>, line: number): string {
	return lines[line - 1] ?? ""
}

export function indentationOf(lines: Array<string>, line: number): string {
	return lineAt(lines, line).match(/^[ \t]*/)?.[0] ?? ""
}

export function sliceOf(
	lines: Array<string>,
	position: common.Position,
): string {
	if (position.start.line === position.end.line) {
		return lineAt(lines, position.start.line).slice(
			position.start.column - 1,
			position.end.column - 1,
		)
	}

	let collected = [
		lineAt(lines, position.start.line).slice(position.start.column - 1),
	]

	for (let line = position.start.line + 1; line < position.end.line; line++) {
		collected.push(lineAt(lines, line))
	}

	collected.push(
		lineAt(lines, position.end.line).slice(0, position.end.column - 1),
	)

	return collected.join("\n")
}

// NOTE: Where the closing `}` of a construct that ends at `end` sits — the
// Position runs one past it, as every Position does.
export function closingBraceOf(end: common.Cursor): common.Cursor {
	return { line: end.line, column: end.column - 1 }
}

// NOTE: Whole lines are the unit an inserted Handler is written in, so the
// insertion goes at the start of the closing brace's line whenever nothing
// but indentation precedes it. A Match written on one line has no such point,
// and takes a line break with the arms instead.
export function insertBeforeClosingBrace(
	end: common.Cursor,
	lines: Array<string>,
	text: string,
	indentation: string,
): CodeActionEdit {
	let brace = closingBraceOf(end)
	let before = lineAt(lines, brace.line).slice(0, brace.column - 1)

	if (before.trim() === "") {
		let start = { line: brace.line, column: 1 }

		return { range: { start, end: start }, newText: text }
	}

	// NOTE: Replacing the whitespace that ran up to the brace rather than
	// inserting before it — the line break makes that whitespace trailing, and
	// no fix should leave any behind.
	let start = {
		line: brace.line,
		column: brace.column - (before.length - before.trimEnd().length),
	}

	return {
		range: { start, end: brace },
		newText: `\n${text}${indentation}`,
	}
}

// NOTE: The column the keyword before `cursor` starts at, 1-based, or null
// when the line does not read the way the Node says it does.
export function keywordBefore(
	lines: Array<string>,
	cursor: common.Cursor,
	keyword: string,
): number | null {
	let before = lineAt(lines, cursor.line).slice(0, cursor.column - 1)
	let index = before.lastIndexOf(keyword)

	return index === -1 ? null : index + 1
}

// NOTE: The Cursor one past the last character of a line — where an insertion
// that belongs at the END of what was written on it goes.
export function endOfLine(lines: Array<string>, line: number): common.Cursor {
	return { line, column: lineAt(lines, line).length + 1 }
}

// NOTE: The WHOLE LINES a Node stands on, deleted — what a list with no
// delimiters is removed by. Deleting the Node alone would leave the blank line
// it sat on behind, so the deletion runs from the start of its first line to
// the start of the line below its last.
//
// A Node on the LAST line of the document has no following line to reach into,
// so the deletion stops at the end of its own — otherwise it would end past the
// end of the document.
export function removeLinesEdit(
	lines: Array<string>,
	position: common.Position,
): CodeActionEdit {
	let start = { line: position.start.line, column: 1 }
	let end = { line: position.end.line + 1, column: 1 }

	if (end.line > lines.length) {
		end = endOfLine(lines, position.end.line)
	}

	return { range: { start, end }, newText: "" }
}

// NOTE: A deletion that starts at the first non-whitespace of its line takes
// the preceding line break and the indentation with it; one that does not
// (`case Integer { … } case String { … }` on one line) stays where it is.
export function extendOverLeadingBreak(
	lines: Array<string>,
	cursor: common.Cursor,
): common.Cursor {
	let before = lineAt(lines, cursor.line).slice(0, cursor.column - 1)

	if (before.trim() !== "" || cursor.line === 1) {
		return cursor
	}

	return {
		line: cursor.line - 1,
		column: lineAt(lines, cursor.line - 1).length + 1,
	}
}

// NOTE: The first `}` at or after `cursor`, one past it — the Handler's own
// closing brace, since everything its body opened is already closed by the
// time its last Node ends. Text inside a `§` comment is skipped, which is the
// one place a brace can appear that no Node accounts for.
export function closingBraceAfter(
	lines: Array<string>,
	cursor: common.Cursor,
): common.Cursor | null {
	for (let line = cursor.line; line <= lines.length; line++) {
		let text = lineAt(lines, line)
		let from = line === cursor.line ? cursor.column - 1 : 0
		let comment = text.indexOf("§", from)
		let searchable = comment === -1 ? text : text.slice(0, comment)
		let index = searchable.indexOf("}", from)

		if (index !== -1) {
			return { line, column: index + 2 }
		}
	}

	return null
}

// NOTE: Where the comma separating this Argument from the one before it stands,
// or null where nothing but the opening bracket does. Whitespace and line breaks
// are walked through, and nothing else is: the first thing that is neither is
// either that comma or the bracket.
export function commaBefore(
	lines: Array<string>,
	start: common.Cursor,
): common.Cursor | null {
	let cursor = start

	while (true) {
		let line = lineAt(lines, cursor.line)
		let before = line.slice(0, cursor.column - 1).replace(/[ \t]+$/, "")

		if (before.endsWith(",")) {
			return { line: cursor.line, column: before.length }
		}

		if (before !== "" || cursor.line === 1) {
			return null
		}

		cursor = {
			line: cursor.line - 1,
			column: lineAt(lines, cursor.line - 1).length + 1,
		}
	}
}

// NOTE: The mirror, for a fallback somebody wrote ahead of another Argument. The
// comma after it is what separates the two, and a `)` says this Argument was
// last. The blanks on the far side of the comma go with it here, so the
// Argument that follows keeps the one space in front of it that it had.
export function commaAfter(
	lines: Array<string>,
	end: common.Cursor,
): common.Cursor | null {
	let cursor = end

	while (true) {
		let line = lineAt(lines, cursor.line)
		let after = line.slice(cursor.column - 1).replace(/^[ \t]+/, "")

		if (after.startsWith(",")) {
			let rest = after.slice(1).replace(/^[ \t]+/, "")

			return {
				line: cursor.line,
				column: line.length - rest.length + 1,
			}
		}

		if (after !== "" || cursor.line === lines.length) {
			return null
		}

		cursor = { line: cursor.line + 1, column: 1 }
	}
}

// NOTE: The opening bracket and the horizontal space beside it. The PADDING is
// part of each spelling — `{ config with port = 1 }` pads and `[ages with "kim"
// = 7]` does not, which is the rule a Literal of each is printed by — so it is
// swapped along with the bracket rather than left standing beside the other one.
//
// An update laid out over several lines has NOTHING after its opening bracket.
// The break under it is layout rather than padding, so it stays where it is and
// the swap is the one character.
export function openingBracketEdit(
	lines: Array<string>,
	start: common.Cursor,
	bracket: "[" | "{",
): CodeActionEdit {
	let line = lineAt(lines, start.line)
	let column = start.column + 1

	if (line.slice(start.column).trim() === "") {
		return {
			range: { start, end: { line: start.line, column } },
			newText: bracket,
		}
	}

	while (line[column - 1] === " " || line[column - 1] === "\t") {
		column += 1
	}

	return {
		range: { start, end: { line: start.line, column } },
		newText: bracket === "{" ? "{ " : "[",
	}
}

// NOTE: And the other end. `end` runs one past the bracket, as every Position
// does — and where nothing but space stands before it on its line, that space is
// the INDENTATION of a closing line rather than the padding, so it is left where
// it is and no padding is written back.
export function closingBracketEdit(
	lines: Array<string>,
	end: common.Cursor,
	bracket: "]" | "}",
): CodeActionEdit {
	let line = lineAt(lines, end.line)
	let column = end.column - 1

	if (line.slice(0, end.column - 2).trim() === "") {
		return {
			range: { start: { line: end.line, column }, end },
			newText: bracket,
		}
	}

	while (
		column > 1 &&
		(line[column - 2] === " " || line[column - 2] === "\t")
	) {
		column -= 1
	}

	return {
		range: { start: { line: end.line, column }, end },
		newText: bracket === "}" ? " }" : "]",
	}
}
