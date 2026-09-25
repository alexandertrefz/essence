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

// NOTE: The range with the whitespace at either end left out — what a reader
// DRAGGED over rather than what the Editor sent. A selection made by dragging
// down the left margin starts in the indentation in front of a Statement and
// ends on the line break after it, and neither is part of what a refactoring
// lifts out: a Node's Position starts at the Node.
//
// Null when nothing but whitespace was selected, which is also what a bare
// cursor is — every refactoring offered on a SELECTION asks here first, so
// "there is no selection" and "the selection holds no code" are one answer.
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

		// NOTE: Past the last character of a line is the line break, which is
		// the one blank that moves the Cursor to another line.
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

// NOTE: Whether nothing but indentation stands in front of a Cursor. A
// Statement written on a line of its own can have another one inserted above it
// by writing whole lines; one sharing its line with a `case` head or with the
// Statement before it can not, and the refactorings that write a Statement turn
// that shape away rather than reflowing somebody's line.
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

// NOTE: The mirror — whether nothing but whitespace follows. A Statement that is
// DELETED whole takes its line with it, and a line carrying a trailing Comment
// carries something a deletion has no business taking.
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

// NOTE: Where a block that has to MOVE really begins: a Comment written
// directly above it travels with it, since a note about a block that stays
// behind is a note about whatever ends up in its place. A blank line ends the
// run — a Comment held off from what is below it is about the file rather than
// about the block.
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

// NOTE: `first` through `last` as a range that covers WHOLE lines — the break
// that ends the last of them included, so what a deletion leaves behind is the
// lines around it rather than the blank line these stood on.
//
// A run that ends the document has no break after it to take, and takes the one
// in FRONT of it instead. A run that is the whole document has neither, and
// leaves the buffer empty.
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
//
// A buffer saved with CRLF line endings is split on the `\n` alone, so each
// line still carries its `\r`. That carriage return is the line ENDING rather
// than something written on the line, and an insertion that goes behind it
// moves it into the middle of the text — a String closed after one takes it in
// as a character and the file loses that line's terminator besides.
export function endOfLine(lines: Array<string>, line: number): common.Cursor {
	let text = lineAt(lines, line)

	return {
		line,
		column: (text.endsWith("\r") ? text.length - 1 : text.length) + 1,
	}
}

// NOTE: Whether a span reads as a WHOLE written value: every bracket it opens
// it closes, every String it opens it ends, and neither edge cuts a name in
// half. What this is for is the fixes that DELETE what a span covers. A span a
// column off still reads as something, `{ a = 1 ` out of `Red = { a = 1 },
// Green` or ` 4` out of `Red = 42`, and a deletion measured off one would take
// a bracket the value never owned, or half a number, with it.
//
// Comments are stepped over rather than refused: a value written over several
// lines may carry one, and what goes with the value goes with it.
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

// NOTE: Whether NEITHER edge of a span stands in the middle of a name. A span
// that has slid a column since it was reported reads as a word all the same —
// `ocused` out of `focused focused`, `firstNme` out of `person.firstNme` — and
// a fix that rewrites or deletes what a span covers has no other way of telling
// the two apart. Every edge that is not a name character is a boundary: a
// bracket, a space, a `.`, a `::`, the start of the line.
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

// NOTE: Where the `=` that introduces a default stands, with the whitespace in
// front of it, or null where the text does not read that way. A Diagnostic
// about a default underlines the VALUE, and deleting that alone would leave
// `side: Integer =` behind — what has to go is the `=` and the space that
// separated it from what it was written on.
//
// Only ever the `=` a default is written with: a comparison is a Method call in
// this language, so nothing spelled `==`, `>=` or `!=` exists here to be
// mistaken for one.
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

// NOTE: The WHOLE LINES a Node stands on, deleted — what a list with no
// delimiters is removed by. Deleting the Node alone would leave the blank line
// it sat on behind, so the deletion runs from the start of its first line to
// the start of the line below its last.
//
// Only where the Node OWNS those lines, though. The grammar puts no delimiter
// between two import entries and none between two groups, so nothing stops
// either from being written beside its neighbours — `from "./A.es" { One Two }`
// is one line holding two entries, and taking the line takes the entry that is
// still read. Where the Node shares its line the deletion is the span and the
// whitespace that separated it from what it was written beside, which leaves
// the line one entry shorter instead of leaving the block one name short.
//
// A Node on the LAST line of the document has no following line to reach into,
// so the deletion stops at the end of its own — otherwise it would end past the
// end of the document.
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

// NOTE: One member of a list written BESIDE its neighbours, taken with the
// blanks that separated it from them: the ones in FRONT where something was
// written before it on the line, and the ones BEHIND where it opened the line
// and something else closes it. One side each way, so that the member that is
// left keeps the one space it had.
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

// NOTE: Whether the keyword is written AT `cursor` — the other half of
// `keywordBefore`, for an edit that starts where a Node says a block opens and
// has to read the buffer back before cutting it out.
export function keywordAt(
	lines: Array<string>,
	cursor: common.Cursor,
	keyword: string,
): boolean {
	let end = { line: cursor.line, column: cursor.column + keyword.length }

	return sliceOf(lines, { start: cursor, end }) === keyword
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

// NOTE: The smaller sibling of the deletion above: the blanks in FRONT of
// `cursor` on its own line, taken with whatever starts there. `test "a"
// focused {` becomes `test "a" {` rather than `test "a"  {`. Where nothing but
// whitespace precedes it, that whitespace is the line's indentation and stays
// — eating it would join the line to the one above, which is what
// `extendOverLeadingBreak` is for.
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

// NOTE: One member of a Module block deleted with the whitespace that carried
// it: the line break above it where it stands on a line of its own, and the
// blanks in front of it where it shares its line with the brace that opened the
// block. Nothing else goes with it — a member list has no delimiters, so what
// is left behind is a block one line shorter rather than a stray comma.
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

// NOTE: The first `}` at or after `cursor`, one past it — the Handler's own
// closing brace, since everything its body opened is already closed by the
// time its last Node ends.
export function closingBraceAfter(
	lines: Array<string>,
	cursor: common.Cursor,
): common.Cursor | null {
	return characterAfter(lines, cursor, "}")
}

// NOTE: And the `(` an Argument list opens on, which is the one thing between a
// Method's name and the Arguments it was called with — a call rewritten to
// reach its Namespace has to know where that bracket stands.
export function openingParenthesisAfter(
	lines: Array<string>,
	cursor: common.Cursor,
): common.Cursor | null {
	return characterAfter(lines, cursor, "(")
}

// NOTE: The first `character` at or after `cursor`, one past it. Text inside a
// `§` comment is skipped, which is the one place a bracket can appear that no
// Node accounts for.
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

// NOTE: Where the contents of a braced Literal END — the cursor just past the
// last thing written inside it, whitespace and line breaks walked back over,
// and just past the opening brace where nothing is written at all. What a
// member scaffolded into a Record Literal is written after, so that the
// Literal's own layout survives: one written on a line takes the new members
// beside it and one written over several takes them on lines of their own.
//
// A trailing `§` comment is not CONTENT, and it is the one thing on a line that
// a scaffold must never be written behind: everything after the sigil is prose,
// so a member and the separator in front of it would both be read as more of
// somebody's note and the Literal would lose its last member to it. The walk
// therefore stops where the comment opens, and what it writes lands in front of
// the note rather than inside it.
//
// Null where the span does not read as a braced Literal, as everything here
// refuses text that is not what the Node said it would be — and null again
// where the cursor the walk arrived at stands inside a comment all the same,
// which is a span that has slid since the Diagnostic was reported.
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

	// NOTE: Back on the opening brace's own line, where everything to its left
	// belongs to the Expression the Literal is written in — so the walk stops
	// at the brace rather than at the first thing it finds.
	let written = writtenBefore(lines, {
		line: position.start.line,
		column: cursor.column,
	})

	return outsideComments(lines, {
		line: position.start.line,
		column: Math.max(written.length + 1, opening.column),
	})
}

// NOTE: What was written on a line in front of a Cursor, with the trailing
// whitespace and any `§` comment left off — the text an edit is allowed to
// measure itself against.
function writtenBefore(lines: Array<string>, cursor: common.Cursor): string {
	let before = lineAt(lines, cursor.line).slice(0, cursor.column - 1)

	return before.slice(0, commentStart(before)).replace(/[ \t]+$/, "")
}

// NOTE: The Cursor, or null where a comment opened in front of it on its own
// line. The walk above already stops short of a comment, so this only ever
// answers null for a Position that no longer reads as the Node that reported it
// — a `{` the buffer now has inside a comment, say — and that is exactly the
// span a fix must not write over.
function outsideComments(
	lines: Array<string>,
	cursor: common.Cursor,
): common.Cursor | null {
	let before = lineAt(lines, cursor.line).slice(0, cursor.column - 1)

	return commentStart(before) < before.length ? null : cursor
}

// NOTE: Where the `§` that opens a comment stands on a line, or the line's
// length where none does. A `§` written inside a String is a character of the
// String rather than the start of a comment, so quoted runs are stepped over —
// `label = "a § b",` ends on the comma rather than in the middle of the String.
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

// NOTE: Where the label written immediately in front of a value stands, or null
// where the text does not read as that label. Whitespace and line breaks are
// walked through and nothing else is — a Comment between the two, a name the
// label is only the tail of — because what is measured here is rewritten next,
// and a span nobody read back is a span that could hold anything.
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

// NOTE: The mirror of `commaBefore`, for a fallback somebody wrote ahead of
// another Argument. The comma after it is what separates the two, and a `)`
// says this Argument was last. The blanks on the far side of the comma go with
// it here, so the Argument that follows keeps the one space in front of it that
// it had.
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
