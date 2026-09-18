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

const decimalOverFractionPattern =
	/^(-?[0-9][0-9_]*)\.([0-9][0-9_]*)\/([0-9][0-9_]*)$/
const fractionOverDecimalPattern =
	/^(-?[0-9][0-9_]*)\/([0-9][0-9_]*)\.([0-9][0-9_]*)$/

// NOTE: The value the two spellings say between them, written back each way.
// Both are offered and neither is preferred: `1.5/2` is `3/4` and `0.75` alike,
// and which of them the file should read is a matter of what it is about — a
// ratio is a fraction and a price is a decimal.
//
// A value with no terminating decimal — `1.5/7` — is offered as a fraction
// alone. There is no decimal that says it, and rounding one would answer with a
// different number.
export function mixedRationalActions(
	diagnostic: common.Diagnostic & { position: common.Position },
	lines: Array<string>,
): Array<CodeActionEntry> {
	let written = sliceOf(lines, diagnostic.position)
	let value =
		rationalOf(decimalOverFractionPattern.exec(written), "decimal") ??
		rationalOf(fractionOverDecimalPattern.exec(written), "fraction")

	if (value === null) {
		return []
	}

	let decimal = decimalSpelling(value)
	let spellings = [
		`${value.numerator}/${value.denominator}`,
		...(decimal === null ? [] : [decimal]),
	]

	return spellings.map((spelling) =>
		literalAction(diagnostic, spelling, {
			range: diagnostic.position,
			newText: spelling,
		}),
	)
}

type Rational = { numerator: bigint; denominator: bigint }

// NOTE: The two mixed spellings read as one value. `A.B/C` is `AB` over
// `10^len(B) · C`, and `A/B.C` is `A · 10^len(C)` over `BC` — the same
// arithmetic either way round, with the power of ten on the side the decimal was
// written on. Reduced to lowest terms, so that what is offered back is the
// number rather than the digits it was typed as.
function rationalOf(
	written: RegExpExecArray | null,
	side: "decimal" | "fraction",
): Rational | null {
	if (written === null) {
		return null
	}

	let [whole, fraction, third] = [
		digitsOf(written[1] as string),
		digitsOf(written[2] as string),
		digitsOf(written[3] as string),
	]

	let scale = 10n ** BigInt((side === "decimal" ? fraction : third).length)
	let numerator =
		side === "decimal"
			? BigInt(`${whole}${fraction}`)
			: BigInt(whole) * scale
	let denominator =
		side === "decimal"
			? scale * BigInt(third)
			: BigInt(`${fraction}${third}`)

	if (denominator === 0n) {
		return null
	}

	let divisor = greatestCommonDivisor(
		numerator < 0n ? -numerator : numerator,
		denominator,
	)

	return {
		numerator: numerator / divisor,
		denominator: denominator / divisor,
	}
}

// NOTE: Euclid's, over a magnitude that may be zero and a denominator that is
// not — `gcd(0, d)` is `d`, which is what canonicalises every zero as `0/1`.
function greatestCommonDivisor(magnitude: bigint, denominator: bigint): bigint {
	while (denominator !== 0n) {
		;[magnitude, denominator] = [denominator, magnitude % denominator]
	}

	return magnitude
}

// NOTE: A decimal is a fraction over a power of ten, so a value has one exactly
// where its reduced denominator divides one — which is to say where it is built
// of twos and fives and nothing else. Null for every other value, since a
// rounded decimal would be a different number than the one that was written.
//
// A whole value keeps one place — `2.0/2` is written back as `1.0` rather than
// as `1`, which is an Integer and no longer the Rational the Literal was.
function decimalSpelling({ numerator, denominator }: Rational): string | null {
	let remaining = denominator
	let twos = 0
	let fives = 0

	while (remaining % 2n === 0n) {
		remaining /= 2n
		twos += 1
	}

	while (remaining % 5n === 0n) {
		remaining /= 5n
		fives += 1
	}

	if (remaining !== 1n) {
		return null
	}

	let places = Math.max(twos, fives, 1)
	let scaled = (numerator * 10n ** BigInt(places)) / denominator
	let negative = scaled < 0n
	let digits = `${negative ? -scaled : scaled}`.padStart(places + 1, "0")

	return `${negative ? "-" : ""}${digits.slice(0, -places)}.${digits.slice(-places)}`
}

function digitsOf(run: string): string {
	return run.replaceAll("_", "")
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

	return {
		title: `Insert the '${emDash}' separator`,
		kind: "quickfix",
		diagnosticCode: diagnostic.code,
		diagnosticPosition: diagnostic.position,
		isPreferred: true,
		edits: [{ range: { start, end: start }, newText: `${emDash} ` }],
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
