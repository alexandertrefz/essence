import type { common } from "@essence-lang/interfaces"

import { endOfLine, sliceOf } from "./geometry"
import type { CodeActionEntry } from "./index"

// NOTE: The Diagnostics about how a Token was WRITTEN — a String that was never
// closed, an escape the Lexer does not know, a tag that ran into its own text.
// Each of them is a handful of characters on one line, so each fix here reads
// the span back off the buffer before it writes: what these answer is a mistake
// in the very text the edit is about to land in, and a Position from an analysis
// two keystrokes old points at something else entirely.

// NOTE: The Diagnostic stands at the END OF THE INPUT — an unclosed String
// swallows every line below it, so that is where the Lexer ran out — and the
// quote that opened it is the secondary Label. The fix writes the missing quote
// where the reader forgot it: at the end of the line the String opened on, which
// is what gives the lines below it back to the Program.
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
		(label) => label.kind === "secondary",
	)?.position

	if (opening === undefined || sliceOf(lines, opening) !== '"') {
		return null
	}

	let end = endOfLine(lines, opening.start.line)

	return {
		title: "Add the missing '\"'",
		kind: "quickfix",
		diagnosticCode: diagnostic.code,
		diagnosticPosition: diagnostic.position,
		isPreferred: true,
		edits: [{ range: { start: end, end }, newText: '"' }],
	}
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

	return {
		title: `Insert the '${emDash}' separator`,
		kind: "quickfix",
		diagnosticCode: diagnostic.code,
		diagnosticPosition: diagnostic.position,
		isPreferred: true,
		edits: [{ range: { start, end: start }, newText: `${emDash} ` }],
	}
}
