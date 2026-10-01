import type { common } from "@essence-lang/interfaces"

import type { CodeActionEdit } from "./index"

// The buffer read as characters rather than Nodes: columns, slices, the comma
// beside an Argument, a body's closing brace. Every edit is measured against
// the live text here.

export function overlaps(
	position: common.Position,
	range: common.Position,
): boolean {
	return (
		!isBefore(position.end, range.start) &&
		!isBefore(range.end, position.start)
	)
}

// Whether `range` lies inside `position`, both edges included, so a cursor on
// a Node's first or last character is held by it.
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

// The range without whitespace at either end, such as the indentation and
// line break a margin drag selects. Null when only whitespace, or nothing,
// was selected.
export function trimmedRange(
	lines: Array<string>,
	range: common.Position,
): common.Position | null {
	let start = range.start
	let end = range.end

	while (isBefore(start, end)) {
		let character = lineAt(lines, start.line)[start.column - 1]

		if (character !== undefined && !isBlank(character)) {
			break
		}

		// Past a line's last character is its line break.
		start =
			character === undefined
				? { line: start.line + 1, column: 1 }
				: { line: start.line, column: start.column + 1 }
	}

	while (isBefore(start, end)) {
		let character =
			end.column === 1
				? undefined
				: lineAt(lines, end.line)[end.column - 2]

		if (character !== undefined && !isBlank(character)) {
			break
		}

		end =
			end.column === 1
				? {
						line: end.line - 1,
						column: lineAt(lines, end.line - 1).length + 1,
					}
				: { line: end.line, column: end.column - 1 }
	}

	return isBefore(start, end) ? { start, end } : null
}

function isBlank(character: string): boolean {
	return character === " " || character === "\t"
}

// Whether only indentation precedes a Cursor, so whole lines can be written
// before it.
export function opensItsLine(
	lines: Array<string>,
	cursor: common.Cursor,
): boolean {
	return (
		lineAt(lines, cursor.line)
			.slice(0, cursor.column - 1)
			.trim() === ""
	)
}

// Whether only whitespace follows a Cursor, so deleting the line takes
// nothing else, such as a trailing Comment.
export function closesItsLine(
	lines: Array<string>,
	cursor: common.Cursor,
): boolean {
	return (
		lineAt(lines, cursor.line)
			.slice(cursor.column - 1)
			.trim() === ""
	)
}

export function lineAt(lines: Array<string>, line: number): string {
	return lines[line - 1] ?? ""
}

export function indentationOf(lines: Array<string>, line: number): string {
	return lineAt(lines, line).match(/^[ \t]*/)?.[0] ?? ""
}

// Where a moving block begins, counting the Comment lines directly before it.
// A blank line ends the run, since such a Comment is about the file.
export function commentRunAbove(lines: Array<string>, line: number): number {
	let first = line

	while (
		first > 1 &&
		lineAt(lines, first - 1)
			.trimStart()
			.startsWith("§")
	) {
		first -= 1
	}

	return first
}

// Whole lines `first` to `last` with the last one's line break, so no blank
// line is left. At the end of the document the break before them goes instead.
export function wholeLines(
	lines: Array<string>,
	first: number,
	last: number,
): common.Position {
	if (last < lines.length) {
		return {
			start: { line: first, column: 1 },
			end: { line: last + 1, column: 1 },
		}
	}

	let end = { line: last, column: lineAt(lines, last).length + 1 }

	if (first === 1) {
		return { start: { line: 1, column: 1 }, end }
	}

	return {
		start: { line: first - 1, column: lineAt(lines, first - 1).length + 1 },
		end,
	}
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

// The closing `}` of a construct ending at `end`, one column before it.
export function closingBraceOf(end: common.Cursor): common.Cursor {
	return { line: end.line, column: end.column - 1 }
}

// Inserts whole lines at the start of the closing brace's line. A brace that
// shares its line gets a line break written before it.
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

	// The whitespace before the brace is replaced, or it would trail.
	let start = {
		line: brace.line,
		column: brace.column - (before.length - before.trimEnd().length),
	}

	return {
		range: { start, end: brace },
		newText: `\n${text}${indentation}`,
	}
}

// The column the keyword before `cursor` starts at, 1-based, or null
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

// The Cursor one past a line's last character, for an insertion at its end.
// A CRLF line keeps its `\r` after the split on `\n`, so the Cursor stops
// before it.
export function endOfLine(lines: Array<string>, line: number): common.Cursor {
	let text = lineAt(lines, line)

	return {
		line,
		column: (text.endsWith("\r") ? text.length - 1 : text.length) + 1,
	}
}

// Whether a span reads as a whole value: its brackets and Strings balanced and
// neither edge inside a name. A deletion of a stale span could otherwise take
// half a number or a stray bracket. Comments are stepped over.
export function readsAsWrittenValue(
	lines: Array<string>,
	position: common.Position,
): boolean {
	let text = sliceOf(lines, position)

	if (text.trim() === "" || !isWordBounded(lines, position)) {
		return false
	}

	let opened: Array<string> = []
	let quoted = false

	for (let index = 0; index < text.length; index++) {
		let character = text[index]

		if (quoted) {
			if (character === "\\") {
				index += 1
			} else if (character === '"') {
				quoted = false
			}
		} else if (character === '"') {
			quoted = true
		} else if (character === "§") {
			let breakAt = text.indexOf("\n", index)

			index = breakAt === -1 ? text.length : breakAt
		} else if (closerOf[character as string] !== undefined) {
			opened.push(closerOf[character as string] as string)
		} else if (character === opened.at(-1)) {
			opened.pop()
		} else if (
			character === ")" ||
			character === "]" ||
			character === "}"
		) {
			return false
		}
	}

	return !quoted && opened.length === 0
}

const closerOf: Record<string, string> = { "(": ")", "[": "]", "{": "}" }

// Whether neither edge of a span stands inside a name, which a span shifted
// by a column would, as `ocused` out of `focused focused`.
export function isWordBounded(
	lines: Array<string>,
	position: common.Position,
): boolean {
	let opening = lineAt(lines, position.start.line)
	let closing = lineAt(lines, position.end.line)

	return !(
		(isNameCharacter(opening[position.start.column - 2]) &&
			isNameCharacter(opening[position.start.column - 1])) ||
		(isNameCharacter(closing[position.end.column - 2]) &&
			isNameCharacter(closing[position.end.column - 1]))
	)
}

function isNameCharacter(character: string | undefined): boolean {
	return character !== undefined && /[A-Za-z0-9_]/.test(character)
}

// Where the `=` before a default's value starts, with its leading whitespace,
// or null. Essence has no `==` or `>=` to mistake for it.
export function defaultEqualsBefore(
	lines: Array<string>,
	start: common.Cursor,
): common.Cursor | null {
	let cursor = start

	while (true) {
		let before = lineAt(lines, cursor.line)
			.slice(0, cursor.column - 1)
			.replace(/[ \t]+$/, "")

		if (before.endsWith("=")) {
			let kept = before.slice(0, -1).replace(/[ \t]+$/, "")

			return { line: cursor.line, column: kept.length + 1 }
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

// Deletes the whole lines a Node stands on, so no blank line is left. A Node
// sharing its line, as in `from "./A.es" { One Two }`, loses only its span and
// one side's whitespace. On the document's last line the deletion stops at its
// end.
export function removeLinesEdit(
	lines: Array<string>,
	position: common.Position,
): CodeActionEdit {
	if (
		!opensItsLine(lines, position.start) ||
		!closesItsLine(lines, position.end)
	) {
		return removeFromItsLineEdit(lines, position)
	}

	let start = { line: position.start.line, column: 1 }
	let end = { line: position.end.line + 1, column: 1 }

	if (end.line > lines.length) {
		end = {
			line: position.end.line,
			column: lineAt(lines, end.line - 1).length + 1,
		}
	}

	return { range: { start, end }, newText: "" }
}

// A member written beside its neighbours, taken with the blanks before it.
// Where it opens the line, the blanks after it go instead.
function removeFromItsLineEdit(
	lines: Array<string>,
	position: common.Position,
): CodeActionEdit {
	if (!opensItsLine(lines, position.start)) {
		return {
			range: {
				start: extendOverLeadingSpace(lines, position.start),
				end: position.end,
			},
			newText: "",
		}
	}

	let after = lineAt(lines, position.end.line).slice(position.end.column - 1)

	return {
		range: {
			start: position.start,
			end: {
				line: position.end.line,
				column:
					position.end.column +
					(after.length - after.replace(/^[ \t]+/, "").length),
			},
		},
		newText: "",
	}
}

// Whether the keyword is written at `cursor`.
export function keywordAt(
	lines: Array<string>,
	cursor: common.Cursor,
	keyword: string,
): boolean {
	let end = { line: cursor.line, column: cursor.column + keyword.length }

	return sliceOf(lines, { start: cursor, end }) === keyword
}

// A deletion starting at its line's first non-blank also takes the preceding
// line break and indentation; one starting mid-line does not.
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

// Extends a deletion over the blanks before `cursor`, so `test "a" focused {`
// becomes `test "a" {`. A line's indentation stays.
export function extendOverLeadingSpace(
	lines: Array<string>,
	cursor: common.Cursor,
): common.Cursor {
	let before = lineAt(lines, cursor.line).slice(0, cursor.column - 1)
	let trimmed = before.replace(/[ \t]+$/, "")

	return trimmed === ""
		? cursor
		: { line: cursor.line, column: trimmed.length + 1 }
}

// Deletes one member of a Module block with the line break before it, or the
// blanks before it where it shares a line.
export function removeMemberEdit(
	lines: Array<string>,
	position: common.Position,
): CodeActionEdit {
	let before = lineAt(lines, position.start.line).slice(
		0,
		position.start.column - 1,
	)
	let start =
		before.trim() === ""
			? extendOverLeadingBreak(lines, position.start)
			: {
					line: position.start.line,
					column:
						position.start.column -
						(before.length - before.trimEnd().length),
				}

	return { range: { start, end: position.end }, newText: "" }
}

// The first `}` at or after `cursor`, one past it. After a Handler's last
// Node this is the Handler's own brace.
export function closingBraceAfter(
	lines: Array<string>,
	cursor: common.Cursor,
): common.Cursor | null {
	return characterAfter(lines, cursor, "}")
}

// The first `(` at or after `cursor`, one past it, where a call's Arguments
// open.
export function openingParenthesisAfter(
	lines: Array<string>,
	cursor: common.Cursor,
): common.Cursor | null {
	return characterAfter(lines, cursor, "(")
}

// The first `character` at or after `cursor`, one past it, skipping `§`
// comments, where no Node accounts for a bracket.
function characterAfter(
	lines: Array<string>,
	cursor: common.Cursor,
	character: string,
): common.Cursor | null {
	for (let line = cursor.line; line <= lines.length; line++) {
		let text = lineAt(lines, line)
		let from = line === cursor.line ? cursor.column - 1 : 0
		let comment = text.indexOf("§", from)
		let searchable = comment === -1 ? text : text.slice(0, comment)
		let index = searchable.indexOf(character, from)

		if (index !== -1) {
			return { line, column: index + 2 }
		}
	}

	return null
}

// The comma before an Argument, walking back over whitespace and line breaks,
// or null where the opening bracket comes first.
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

// Just past the last thing written inside a braced Literal, or past its
// opening brace when empty, where scaffolded members go. A trailing `§`
// comment is not content, since a member written after it would be prose.
// Null where the span is not a braced Literal, or ends inside a comment.
export function endOfContents(
	lines: Array<string>,
	position: common.Position,
): common.Cursor | null {
	let brace = closingBraceOf(position.end)
	let opening = {
		line: position.start.line,
		column: position.start.column + 1,
	}

	if (
		sliceOf(lines, { start: position.start, end: opening }) !== "{" ||
		sliceOf(lines, { start: brace, end: position.end }) !== "}"
	) {
		return null
	}

	let cursor = brace

	while (cursor.line > position.start.line) {
		let written = writtenBefore(lines, cursor)

		if (written !== "") {
			return outsideComments(lines, {
				line: cursor.line,
				column: written.length + 1,
			})
		}

		cursor = {
			line: cursor.line - 1,
			column: lineAt(lines, cursor.line - 1).length + 1,
		}
	}

	// On the opening brace's line, text before the brace belongs to the
	// enclosing Expression, so the walk stops at the brace.
	let written = writtenBefore(lines, {
		line: position.start.line,
		column: cursor.column,
	})

	return outsideComments(lines, {
		line: position.start.line,
		column: Math.max(written.length + 1, opening.column),
	})
}

// What a line holds before a Cursor, without a `§` comment or trailing
// whitespace.
function writtenBefore(lines: Array<string>, cursor: common.Cursor): string {
	let before = lineAt(lines, cursor.line).slice(0, cursor.column - 1)

	return before.slice(0, commentStart(before)).replace(/[ \t]+$/, "")
}

// The Cursor, or null where a comment opens before it on its line, which only
// a stale Position can give.
function outsideComments(
	lines: Array<string>,
	cursor: common.Cursor,
): common.Cursor | null {
	let before = lineAt(lines, cursor.line).slice(0, cursor.column - 1)

	return commentStart(before) < before.length ? null : cursor
}

// Where a line's `§` comment opens, or the line's length. A `§` inside a
// String, as in `label = "a § b",`, opens none.
function commentStart(text: string): number {
	let quoted = false

	for (let index = 0; index < text.length; index++) {
		let character = text[index]

		if (quoted && character === "\\") {
			index += 1
		} else if (character === '"') {
			quoted = !quoted
		} else if (character === "§" && !quoted) {
			return index
		}
	}

	return text.length
}

// The label written directly before a value, across whitespace and line
// breaks only, or null. A Comment between them, or a longer name ending in the
// label, gives null.
export function labelBefore(
	lines: Array<string>,
	start: common.Cursor,
	label: string,
): common.Position | null {
	let cursor = start

	while (true) {
		let line = lineAt(lines, cursor.line)
		let before = line.slice(0, cursor.column - 1).replace(/[ \t]+$/, "")

		if (before !== "") {
			let column = before.length - label.length + 1

			if (
				!before.endsWith(label) ||
				/[A-Za-z0-9_]/.test(line[column - 2] ?? "")
			) {
				return null
			}

			return {
				start: { line: cursor.line, column },
				end: { line: cursor.line, column: before.length + 1 },
			}
		}

		if (cursor.line === 1) {
			return null
		}

		cursor = {
			line: cursor.line - 1,
			column: lineAt(lines, cursor.line - 1).length + 1,
		}
	}
}

// The comma after an Argument and the blanks after it, or null where the
// Argument was last.
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

// Swaps an opening bracket with its padding, since `{ config with port = 1 }`
// pads and `[ages with "kim" = 7]` does not. A bracket ending its line has no
// padding to swap.
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

// Swaps a closing bracket with its padding. A bracket that opens its line
// keeps its indentation.
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
