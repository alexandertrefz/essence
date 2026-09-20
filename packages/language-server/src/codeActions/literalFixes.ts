import {
	holeHoldsAnEscape,
	mixedRationalSpellings,
} from "@essence-lang/compiler/helpers"
import type { common } from "@essence-lang/interfaces"

import { endOfLine, lineAt, sliceOf } from "./geometry"
import type { CodeActionEdit, CodeActionEntry } from "./index"

// NOTE: The Diagnostics about how a Token was WRITTEN — a String that was never
// closed, an escape the Lexer does not know, a tag that ran into its own text.
// Each of them is a handful of characters on one line, so each fix here reads
// the span back off the buffer before it writes: what these answer is a mistake
// in the very text the edit is about to land in, and a Position from an analysis
// two keystrokes old points at something else entirely.

// NOTE: The String's opening quote is the first Label standing on a `"`, which
// is the one thing the two shapes of this Diagnostic share. The plain one stands
// at the END OF THE INPUT — an unclosed String swallows every line below it, so
// that is where the Lexer ran out — and carries the opening quote as its
// secondary Label. The one that names a String for SWALLOWING the lines below it
// stands on that String's opening quote itself, with the quote it closed on
// beside it. Either way the fix writes the missing quote where the reader forgot
// it: at the end of the line the String opened on, which is what gives the lines
// below it back to the Program.
//
// A String may run over line breaks, so the LINE is a reading of what was meant
// rather than the only place a quote could go. It is the reading every other one
// costs a Program: closing the String at the end of the input keeps the rest of
// the file inside it, which is the shape that was already refused.
export function closeStringAction(
	diagnostic: common.Diagnostic & { position: common.Position },
	lines: Array<string>,
): CodeActionEntry | null {
	let opening = diagnostic.labels.find(
		(label) => sliceOf(lines, label.position) === '"',
	)?.position

	if (opening === undefined) {
		return null
	}

	let end = endOfLine(lines, opening.start.line)

	// NOTE: A quote written behind an ODD run of backslashes is escaped by the
	// last of them — `"hello\` closed this way reads `"hello\"`, which is a
	// String still running — so the one edit this offers would leave the very
	// Diagnostic it answers standing. What the trailing backslash was meant to
	// be is not something the source says, so nothing is offered rather than
	// something that does not hold. An EVEN run is `\\`, a written backslash,
	// and closes as any other character does.
	if (trailingBackslashes(lineAt(lines, end.line), end.column) % 2 === 1) {
		return null
	}

	// NOTE: And a String whose `{` opened a hole is refused for the same reason
	// and withheld for the same reason: `"{\"a\": 1}"` answered this fix with
	// the very Diagnostic it was applied to, so the fix ran again and wrote a
	// third quote, and a fourth. The report says what is actually missing there
	// — the `\{` and the `\}` — and asked the same question of the same line.
	if (
		holeHoldsAnEscape(
			lineAt(lines, opening.start.line).slice(opening.start.column - 1),
		)
	) {
		return null
	}

	return {
		title: "Add the missing '\"'",
		kind: "quickfix",
		diagnosticCode: diagnostic.code,
		diagnosticPosition: diagnostic.position,
		isPreferred: true,
		edits: [{ range: { start: end, end }, newText: '"' }],
	}
}

// NOTE: How many backslashes a line ends in, counted back from `column`.
function trailingBackslashes(text: string, column: number): number {
	let count = 0

	while (text[column - 2 - count] === "\\") {
		count += 1
	}

	return count
}

// NOTE: The Diagnostic spans exactly the two characters `\c`, whatever `c` came
// out as.
const escapePattern = /^\\(.)$/

// NOTE: The two answers the Help gives, both offered and neither preferred: a
// backslash that was meant to be one is written `\\`, and a backslash that was
// never meant at all goes. Which of the two was meant is what the writer knows
// and the Lexer does not — `"C:\temp"` wants the first and `"a\q"` almost
// certainly wants the second — so an Editor must not pick one without asking.
export function invalidEscapeActions(
	diagnostic: common.Diagnostic & { position: common.Position },
	lines: Array<string>,
): Array<CodeActionEntry> {
	let escaped = escapePattern.exec(sliceOf(lines, diagnostic.position))

	if (escaped === null) {
		return []
	}

	let character = escaped[1] as string

	return [
		{
			title: "Write '\\\\' for a literal backslash",
			kind: "quickfix",
			diagnosticCode: diagnostic.code,
			diagnosticPosition: diagnostic.position,
			isPreferred: false,
			edits: [
				{
					range: diagnostic.position,
					newText: `\\\\${character}`,
				},
			],
		},
		{
			title: "Drop the backslash",
			kind: "quickfix",
			diagnosticCode: diagnostic.code,
			diagnosticPosition: diagnostic.position,
			isPreferred: false,
			edits: [{ range: diagnostic.position, newText: character }],
		},
	]
}

// NOTE: The two halves of a decimal that was written with one side empty. A
// digit run may be grouped with `_`, which is part of the spelling and stays in
// whatever is written back.
const leadingPointPattern = /^\.([0-9][0-9_]*)$/
const trailingPointPattern = /^(-?[0-9][0-9_]*)\.$/

// NOTE: `.5` has ONE answer — a decimal missing its whole part is a decimal
// whose whole part is zero, and no other reading of it exists. `1.` has two,
// which the Diagnostic's own Helps give in order: the digits behind the point
// were forgotten, or the point was. They differ in the Type the Literal ends up
// with — `1.0` is a Rational and `1` is an Integer — so neither is preferred and
// the reader picks.
export function partialDecimalActions(
	diagnostic: common.Diagnostic & { position: common.Position },
	lines: Array<string>,
): Array<CodeActionEntry> {
	let written = sliceOf(lines, diagnostic.position)
	let leading = leadingPointPattern.exec(written)

	if (leading !== null) {
		return [
			literalAction(
				diagnostic,
				`0${written}`,
				{
					range: {
						start: diagnostic.position.start,
						end: diagnostic.position.start,
					},
					newText: "0",
				},
				true,
			),
		]
	}

	let trailing = trailingPointPattern.exec(written)

	if (trailing === null) {
		return []
	}

	// NOTE: The point is the last character of the span, and the Position runs
	// one past it, as every Position does.
	let point = {
		line: diagnostic.position.end.line,
		column: diagnostic.position.end.column - 1,
	}

	return [
		literalAction(diagnostic, `${written}0`, {
			range: {
				start: diagnostic.position.end,
				end: diagnostic.position.end,
			},
			newText: "0",
		}),
		literalAction(diagnostic, trailing[1] as string, {
			range: { start: point, end: diagnostic.position.end },
			newText: "",
		}),
	]
}

// NOTE: The value the two spellings say between them, written back each way.
// Both are offered and neither is preferred: `1.5/2` is `3/4` and `0.75` alike,
// and which of them the file should read is a matter of what it is about — a
// ratio is a fraction and a price is a decimal.
//
// The arithmetic is the Compiler's — see `mixedRationalSpellings` — because the
// Help printed on this Diagnostic offers the same two spellings, and a Help and
// a fix that disagree about a number are worse than either of them alone.
export function mixedRationalActions(
	diagnostic: common.Diagnostic & { position: common.Position },
	lines: Array<string>,
): Array<CodeActionEntry> {
	return mixedRationalSpellings(sliceOf(lines, diagnostic.position)).map(
		(spelling) =>
			literalAction(diagnostic, spelling, {
				range: diagnostic.position,
				newText: spelling,
			}),
	)
}

// NOTE: One shape for every Literal rewritten in place: the title names the
// spelling the reader will be left with, which is the only thing that tells two
// of them apart in a list. Preferred only where the offer stands alone — where
// two spellings are offered, choosing between them is what a Diagnostic can not
// do for anyone.
function literalAction(
	diagnostic: common.Diagnostic & { position: common.Position },
	spelling: string,
	edit: CodeActionEdit,
	isPreferred: boolean = false,
): CodeActionEntry {
	return {
		title: `Write it as '${spelling}'`,
		kind: "quickfix",
		diagnosticCode: diagnostic.code,
		diagnosticPosition: diagnostic.position,
		isPreferred,
		edits: [edit],
	}
}

const emDash = "—"

// NOTE: The Diagnostic underlines the TEXT rather than the tag it ran into —
// the em-dash is missing exactly where the text begins — so the separator is
// written in front of it and not one character of what was typed is retyped.
//
// The space after the dash is part of the separator: `@param subject —who` reads
// as a dash against a word rather than as a tag and its description, and the
// Formatter has no say over the inside of a Comment.
export function documentationSeparatorAction(
	diagnostic: common.Diagnostic & { position: common.Position },
	lines: Array<string>,
): CodeActionEntry | null {
	let written = sliceOf(lines, diagnostic.position)

	// NOTE: The span opens on the first character of the text, so leading
	// whitespace or a dash already standing there says the buffer has moved on
	// since the Diagnostic was made.
	if (written === "" || /^\s/.test(written) || written.startsWith(emDash)) {
		return null
	}

	let start = diagnostic.position.start
	// NOTE: JSDoc writes `@param name - text`, and the hyphen is ITS separator
	// — so a fix that only inserts the em dash left `@param _ — - the number`,
	// with both languages' punctuation standing in one line. The run is
	// REPLACED where one was written: it is the same separator, spelled the way
	// the reader's last language spells it. A hyphen inside the text is left
	// alone; only a run at the head of it is one of these.
	let separator = /^[-–]\s+/.exec(written)?.[0] ?? ""
	let end = {
		line: start.line,
		column: start.column + separator.length,
	}

	return {
		title: `Insert the '${emDash}' separator`,
		kind: "quickfix",
		diagnosticCode: diagnostic.code,
		diagnosticPosition: diagnostic.position,
		isPreferred: true,
		edits: [{ range: { start, end }, newText: `${emDash} ` }],
	}
}

// NOTE: A value comment is `§?` written at the end of a Statement, and the
// Diagnostic spans the whole Comment — the two characters and everything the
// reader wrote behind them.
const valueComment = "§?"

// NOTE: The two characters at the front, and nothing else: what a reader wrote
// behind them is a Comment either way, and is left exactly as it was. Preferred,
// because the other answer the Help gives — ask it of a Statement inside the
// `tests { … }` block — is a move rather than an edit, and moving a Statement is
// not something a span can say how to do.
export function ordinaryCommentAction(
	diagnostic: common.Diagnostic & { position: common.Position },
	lines: Array<string>,
): CodeActionEntry | null {
	let sigil = {
		start: diagnostic.position.start,
		end: {
			line: diagnostic.position.start.line,
			column: diagnostic.position.start.column + valueComment.length,
		},
	}

	if (sliceOf(lines, sigil) !== valueComment) {
		return null
	}

	return {
		title: "Write an ordinary '§' Comment",
		kind: "quickfix",
		diagnosticCode: diagnostic.code,
		diagnosticPosition: diagnostic.position,
		isPreferred: true,
		edits: [{ range: sigil, newText: "§" }],
	}
}
