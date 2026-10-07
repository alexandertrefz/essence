import {
	holeHoldsAnEscape,
	mixedRationalSpellings,
} from "@essence-lang/compiler/helpers"
import type { common } from "@essence-lang/interfaces"

import { endOfLine, lineAt, sliceOf } from "./geometry"
import type { CodeActionEdit, CodeActionEntry } from "./index"

// Fixes for how a Token was written: an unclosed String, an unknown escape, a
// tag run into its text. Each reads its few characters back off the buffer
// before writing.

// Closes a String at the end of the line it opened on, which gives the
// following lines back to the Program. Both shapes of this Diagnostic carry
// the opening quote as a Label.
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

	// After an odd run of backslashes the quote would be escaped, as in
	// `"hello\"`, so nothing is offered. An even run is written backslashes.
	if (trailingBackslashes(lineAt(lines, end.line), end.column) % 2 === 1) {
		return null
	}

	// A hole holding an escape, as in `"{\"a\": 1}"`, would leave the String
	// unclosed after this fix too. Its report asks for `\{` and `\}` instead.
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

// A quote standing in a hole opens a String of its own, so a quote at the end
// of the line would open one more. The report labels the hole's `{`. Only the
// reader knows whether it stands for itself or the hole lacks its `}`.
export function unclosedHoleActions(
	diagnostic: common.Diagnostic & { position: common.Position },
	lines: Array<string>,
): Array<CodeActionEntry> | null {
	let labelOn = (character: string) =>
		diagnostic.labels.find(
			(label) => sliceOf(lines, label.position) === character,
		)?.position.start

	let brace = labelOn("{")
	let quote = labelOn('"')

	if (brace === undefined || quote === undefined) {
		return null
	}

	let insertion = (at: common.Cursor, newText: string, title: string) => ({
		title,
		kind: "quickfix" as const,
		diagnosticCode: diagnostic.code,
		diagnosticPosition: diagnostic.position,
		isPreferred: false,
		edits: [{ range: { start: at, end: at }, newText }],
	})

	return [
		insertion(brace, "\\", "Write '\\{' for the brace"),
		insertion(quote, "}", "End the hole in front of the quote"),
	]
}

// How many backslashes a line ends in, counted back from `column`.
function trailingBackslashes(text: string, column: number): number {
	let count = 0

	while (text[column - 2 - count] === "\\") {
		count += 1
	}

	return count
}

// The Diagnostic spans exactly the two characters `\c`.
const escapePattern = /^\\(.)$/

// Writes `\\` for a meant backslash, or drops it. Neither is preferred:
// `"C:\temp"` wants the first and `"a\q"` likely the second.
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

// The `\u{…}` rewrite the Lexer's `readUnicodeEscape` spells in the Help. See
// "Reading a Help" in DEVELOPMENT.md. The Help for digits read as decimal is
// not offered, since only the reader knows whether they were meant so.
const unicodeRewritePattern =
	/^(?:Write it in braces|Write the character as one escape|Drop the leading zeros|Close it with a '\}'|Write the digits alone): '(\\u\{[0-9A-Fa-f]{1,6}\})'/

export function unicodeEscapeActions(
	diagnostic: common.Diagnostic & { position: common.Position },
): Array<CodeActionEntry> {
	return diagnostic.helps.flatMap((help) => {
		let rewrite = unicodeRewritePattern.exec(help)

		if (rewrite === null) {
			return []
		}

		let spelling = rewrite[1] as string

		return [
			literalAction(
				diagnostic,
				spelling,
				{ range: diagnostic.position, newText: spelling },
				true,
			),
		]
	})
}

// A decimal with one side empty. A `_` grouping digits is kept.
const leadingPointPattern = /^\.([0-9][0-9_]*)$/
const trailingPointPattern = /^(-?[0-9][0-9_]*)\.$/

// `.5` becomes `0.5`, preferred. `1.` becomes `1.0` or `1`, a Rational or an
// Integer, so neither of those is preferred.
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

	// The point is the span's last character; a Position ends one past it.
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

// `1.5/2` written as `3/4` or `0.75`, neither preferred. The arithmetic is
// `mixedRationalSpellings`, which the Help uses too, so the two agree.
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

// A Literal rewritten in place, titled with the spelling it leaves. Preferred
// only when it is the sole offer.
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

// Writes the separator before the text the Diagnostic underlines, with a
// space after it, since the formatter does not touch a Comment's inside.
export function documentationSeparatorAction(
	diagnostic: common.Diagnostic & { position: common.Position },
	lines: Array<string>,
): CodeActionEntry | null {
	let written = sliceOf(lines, diagnostic.position)

	// Leading whitespace or a separator means the buffer has moved on.
	if (written === "" || /^\s/.test(written) || written.startsWith(emDash)) {
		return null
	}

	let start = diagnostic.position.start
	// A leading hyphen or en dash is JSDoc's separator, so it is replaced
	// rather than kept beside the new one.
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

// A value comment is `§?` at a Statement's end; the Diagnostic spans all of
// it.
const valueComment = "§?"

// Replaces only the `§?`. Preferred, since the Help's other answer, moving
// the Statement into `tests { … }`, is no edit.
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
