import { type common, lexer } from "@essence-lang/interfaces"

import { foreignPunctuation } from "../helpers/foreign"
import {
	characterAt,
	codePointName,
	printsAsItself,
	spelledCharacter,
} from "../helpers/terminalText"

const TokenType = lexer.TokenType
type Token = lexer.Token
type Cursor = common.Cursor

// NOTE: The Lexer's non-fatal problems — a Token it could read but that can
// never be valid, like `0xFF` or an unknown escape. They are handed to the
// caller rather than thrown, because the Token stream is intact and every later
// Token is worth reading; the parser's TokenStream turns each into a positioned
// Diagnostic. `code` picks which Diagnostic. The one fatal case, an
// unterminated String Literal, still throws, because after it there is nothing
// left to lex.
export type LexingError = {
	message: string
	position: common.Position
	code:
		| "invalid-number"
		| "invalid-escape"
		| "comment-in-hole"
		| "unbraced-unicode-escape"
		| "malformed-unicode-escape"
		| "unicode-escape-out-of-range"
		| "surrogate-unicode-escape"
	// NOTE: The rest of the report, for the one family that can not be rebuilt
	// from its code alone. A `\u{…}` can be wrong in six ways that share four
	// codes, and each Help writes the reader's own digits back at them — which
	// digits those are, and which mistake it was, are known only where the
	// escape was read. Rebuilding that from the span at the reporting site would
	// be the same analysis written a second time, in a second place, free to
	// drift. Every other code's text is still built where it is reported.
	report?: EscapeReport
}

// NOTE: What a refused `\u{…}` says under its code — the label that sits on the
// span, the Note that states the rule it broke, and the Helps, which are the
// edits that work and are withheld when none does.
export type EscapeReport = {
	label: string
	notes: Array<string>
	helps: Array<string>
}

// NOTE: A String Literal that CLOSED, built where the unterminated-String
// report asks which one it was — see `swallowedTheLinesBelow`. `spansLines` is
// the whole reason it is asked for.
export type ClosedString = {
	openedAt: Cursor
	closedAt: Cursor
	spansLines: boolean
}

// NOTE: The one fatal Lexer error — after an unterminated String there is
// nothing left to lex. It carries the two Cursors the report needs: where the
// input ran out, and where the String that never closed was opened.
export class UnterminatedStringError extends Error {
	endOfInput: Cursor
	openedAt: Cursor
	// NOTE: The String Literal that closed directly in front of this one AND
	// spanned lines, where there is one — the likelier culprit of the two. See
	// `swallowedTheLinesBelow`.
	swallower: ClosedString | null

	constructor(
		endOfInput: Cursor,
		openedAt: Cursor,
		swallower: ClosedString | null = null,
	) {
		super(
			`String Token not closed at line: ${endOfInput.line}, column: ${endOfInput.column}`,
		)
		this.endOfInput = endOfInput
		this.openedAt = openedAt
		this.swallower = swallower
	}
}

const linebreak = "\n"
const stringLiteral = '"'
const commentLiteral = "§"
const documentationLiteral = "§§"
const booleans = ["true", "false"]
const keywords = [
	"if",
	"else",
	"type",
	"constant",
	"variable",
	"function",
	"static",
	"implementation",
	"overload",
	"match",
	"case",
	"define",
	"otherwise",
	"with",
	"namespace",
	"protocol",
	"for",
	"infer",
	"choice",
	"import",
	"export",
	"from",
	"as",
	"tests",
	"test",
	"suite",
	"benchmark",
	"expect",
	"require",
	"start",
	"complete",
]
const symbols = [
	"(",
	")",
	"{",
	"}",
	"[",
	"]",
	"<",
	">",
	"|",
	"/",
	"@",
	",",
	".",
	":",
	"=",
	"-",
	"~",
	"_",
	"#",
]
const numbers = ["0", "1", "2", "3", "4", "5", "6", "7", "8", "9"]
// NOTE: `\r` is here so a file with Windows line endings lexes as its Unix
// twin — the `\n` alone is the line break, and the `\r` before it is never
// part of an Identifier, a Number or a Comment. `\uFEFF` is here for the
// same reason: a byte order mark is invisible whitespace, not the first
// letter of `implementation`.
const whitespaces = [" ", "\t", "\r", "﻿"]

// NOTE: The character codes the scan loops below compare against. Written as
// names because a bare `34` in a String scanner says nothing about which
// character it is, and taken from the same constants everything else here is,
// so the two spellings can not drift apart.
const linebreakCode = linebreak.charCodeAt(0)
const stringLiteralCode = stringLiteral.charCodeAt(0)
const commentLiteralCode = commentLiteral.charCodeAt(0)
const carriageReturnCode = "\r".charCodeAt(0)
const backslashCode = "\\".charCodeAt(0)

// NOTE: The questions the scan loops ask of every single character they read,
// answered by one table lookup on the character's code. `endsWord` is what
// STOPS an Identifier or a Number — whitespace, the line break, a Symbol, and
// the Comment and String sigils, which end an Identifier exactly as a Symbol
// does — `isDigit` is what a Number keeps, and `isSpace` is what the
// skipping loops eat.
//
// NOTE: Built from the same Arrays the constants above are, so the two
// spellings of one character class can not drift apart.
const endsWord = 1
const isDigit = 2
const isSpace = 4
// NOTE: Hexadecimal is not a spelling the language has anywhere else — there is
// no `0xFF` Number Literal, and `invalid-number` exists to say so — so this flag
// is read by the `\u` escape readers and by nothing else.
const isHexDigit = 8

const characterClasses = new Uint8Array(128)
// NOTE: Every character above 127 that belongs to a class, which is the two
// that do: `§` opens a Comment, and the byte order mark is whitespace.
// Everything else up there is a letter in a name — or half of a surrogate
// pair, which is read as the two code units it is written in, exactly as the
// cursor counts it.
const wideClasses = new Map<number, number>()

function addClass(character: string, flags: number): void {
	let code = character.charCodeAt(0)

	if (code < 128) {
		characterClasses[code]! |= flags
	} else {
		wideClasses.set(code, (wideClasses.get(code) ?? 0) | flags)
	}
}

for (let character of [
	...whitespaces,
	linebreak,
	...symbols,
	commentLiteral,
	stringLiteral,
]) {
	addClass(character, endsWord)
}

for (let character of whitespaces) {
	addClass(character, isSpace)
}

for (let character of numbers) {
	addClass(character, isDigit)
}

for (let character of [...numbers, ..."abcdefABCDEF"]) {
	addClass(character, isHexDigit)
}

function classOfCode(code: number): number {
	if (code < 128) {
		return characterClasses[code]!
	}

	return wideClasses.get(code) ?? 0
}

// NOTE: WHERE a `\u{…}` holds a character that is not a hexadecimal digit,
// rather than whether it does. `parseInt` would not say: it reads the longest
// prefix it understands and answers for that — `parseInt("1G", 16)` is 1 — so a
// refusal built on it would quietly become a wrong character instead.
function firstNonHexDigit(digits: string): number {
	for (let offset = 0; offset < digits.length; offset++) {
		if ((classOfCode(digits.charCodeAt(offset)) & isHexDigit) === 0) {
			return offset
		}
	}

	return -1
}

// NOTE: Whether a number names a character a String can hold. The range has two
// holes: nothing above U+10FFFF is a code point at all, and the surrogates are
// the two halves UTF-16 writes an astral character in — neither names a
// character on its own, which is why `\u{D800}` is refused and `\u{1F600}`, the
// character a surrogate pair stands for, is the escape to write instead.
function isScalarValue(value: number): boolean {
	return (
		value <= highestCodePoint &&
		(value < firstSurrogate || value > lastSurrogate)
	)
}

// NOTE: A code point spelled the way this language spells it, which is what
// every rewrite Help hands back. UPPER CASE, because that is how the Unicode
// standard names a code point and how the runtime's own quoted rendering prints
// one. A Help that merely re-brackets the reader's OWN digits keeps their case
// instead — see `readUnbracedEscape`.
function bracedEscape(value: number): string {
	return `\\u{${value.toString(16).toUpperCase()}}`
}

// NOTE: The same digits with their leading zeros gone, which is what a rewrite
// of the reader's own text writes back: `\u001B` is offered as `\u{1B}` rather
// than `\u{001B}`, and a file written in lower case keeps reading that way.
function withoutLeadingZeros(digits: string): string {
	let offset = 0

	while (offset < digits.length - 1 && digits[offset] === "0") {
		offset++
	}

	return digits.slice(offset)
}

// NOTE: The character a surrogate pair spells, from the two halves UTF-16
// writes it in — the arithmetic the standard gives, written once because both
// spellings of a pair need it.
function characterOfPair(high: number, low: number): number {
	return 0x10000 + ((high - firstSurrogate) << 10) + (low - firstLowSurrogate)
}

// NOTE: The one Help a surrogate ever gets, and the reason it is written here
// rather than at each of the two places that offer it: the Quick Fix reads the
// spelling back OUT of this sentence (`literalFixes.ts`), so the sentence is the
// contract between the Lexer and the Editor and two spellings of it are two
// contracts.
function pairedCharacterHelp(high: number, low: number): string {
	return `Write the character as one escape: '${bracedEscape(
		characterOfPair(high, low),
	)}'.`
}

// NOTE: The rule every malformed `\u{…}` broke, said once. Five refusals carry
// it, and five spellings of one sentence is five chances for a reader to be told
// something slightly different about the same escape.
const unicodeEscapeRule =
	"A Unicode escape is written '\\u{…}' — one to six hexadecimal digits in braces, naming one character."

// NOTE: Said apart from the rule above, because a surrogate is the one refusal
// where the digits ARE a well-formed escape and the number itself is the
// mistake. A reader who wrote one is a reader who knows UTF-16, and what they
// need to hear is that Essence counts characters and not the units they are
// stored in.
const surrogateRule =
	"U+D800 through U+DFFF are the halves UTF-16 writes a character above U+FFFF in; a String holds characters, so an escape names one of those directly."

// NOTE: `\u{U+1B}` — a code point written the way it is NAMED rather than the
// way it is spelled. The `U+` prefix is how the standard and every chart write
// one, so it arrives inside the braces often enough to answer for itself; the
// digits behind it are the reader's own and are handed straight back.
function namedCodePointHelps(digits: string): Array<string> {
	let named =
		digits.length > 2 &&
		(digits[0] === "U" || digits[0] === "u") &&
		digits[1] === "+"
			? digits.slice(2)
			: null

	if (
		named !== null &&
		named.length <= 6 &&
		firstNonHexDigit(named) === -1 &&
		isScalarValue(Number.parseInt(named, 16))
	) {
		return [
			`Write the digits alone: '\\u{${named}}' — the 'U+' names a code point rather than spelling one.`,
		]
	}

	return [
		"Write the code point in hexadecimal: '\\u{1B}' is the escape character, '\\u{1F600}' a grinning face.",
	]
}

// NOTE: Seven digits or more, which is one or more leading zeros in every case
// a reader meant — `\u{00001B}` is the JavaScript habit padded out. The zeros
// come off where what is left names a character, and where it does not there is
// nothing to offer: the escape is wrong twice over and the Note says the rule.
function trimmedDigitHelps(digits: string): Array<string> {
	let trimmed = withoutLeadingZeros(digits)

	return trimmed.length <= 6 && isScalarValue(Number.parseInt(trimmed, 16))
		? [`Drop the leading zeros: '\\u{${trimmed}}'.`]
		: []
}

// NOTE: `\u{128512}` — the code point read off a chart in DECIMAL and written
// into an escape that reads hexadecimal. It is worth answering for because the
// mistake is invisible: every decimal digit is a hexadecimal digit too, so
// nothing about the text looks wrong and the number they name is simply too
// large. Offered CONDITIONALLY rather than as an instruction: the condition is
// written into the sentence — 'where the character numbered 128512 was meant' —
// and only the reader can say whether it holds, because which base they meant
// is the one thing the source does not record. It is the one Help of this
// family no Quick Fix applies, since applying it would decide that for them.
//
// WITHHELD JUST ABOVE THE TOP. Unicode's last plane ends at U+10FFFF, so the
// smallest escape this refusal ever sees is `\u{110000}` — the top missed by
// one, in hexadecimal, by a reader who knows exactly where it is. Asking them
// whether they meant the decimal 110,000 is noise, and the whole of the first
// plane above the last real one reads the same way: someone counting planes,
// not someone copying a decimal off a chart. Above it, `\u{128512}` has no
// reading as a boundary at all and the question is the only thing worth asking.
//
// NOTE: `isScalarValue` can not fire and stays as a belt: six digits is the
// most this reads, the smallest of them above the top is `110000`, and its
// decimal reading is 110,000 — past every surrogate and far below U+10FFFF. So
// every decimal reading that reaches here already names a character. It is kept
// because the day the digit limit moves is the day a decimal surrogate becomes
// reachable, and a Help that spells an escape the next run refuses is the one
// thing a Help may not do.
const firstPlaneAboveTheTop = 0x11ffff

function decimalReadingHelps(digits: string, value: number): Array<string> {
	if (value <= firstPlaneAboveTheTop) {
		return []
	}

	for (let offset = 0; offset < digits.length; offset++) {
		if ((classOfCode(digits.charCodeAt(offset)) & isDigit) === 0) {
			return []
		}
	}

	let decimal = Number.parseInt(digits, 10)

	return isScalarValue(decimal)
		? [
				`The digits are read as hexadecimal — write '${bracedEscape(decimal)}' where the character numbered ${decimal} was meant.`,
			]
		: []
}

// NOTE: One table lookup where a ladder of twenty string compares stood. A
// Symbol is always one ASCII character, so it is indexed by that character's
// code; the table doubles as the "is this a Symbol?" test, which is why there
// is no separate predicate for it any more.
const symbolTypes: Array<lexer.TokenType | undefined> = Array.from({
	length: 128,
})

symbolTypes["@".charCodeAt(0)] = TokenType.SymbolAt
symbolTypes["(".charCodeAt(0)] = TokenType.SymbolLeftParen
symbolTypes[")".charCodeAt(0)] = TokenType.SymbolRightParen
symbolTypes["{".charCodeAt(0)] = TokenType.SymbolLeftBrace
symbolTypes["}".charCodeAt(0)] = TokenType.SymbolRightBrace
symbolTypes["[".charCodeAt(0)] = TokenType.SymbolLeftBracket
symbolTypes["]".charCodeAt(0)] = TokenType.SymbolRightBracket
symbolTypes["|".charCodeAt(0)] = TokenType.SymbolPipe
symbolTypes["/".charCodeAt(0)] = TokenType.SymbolSlash
symbolTypes[",".charCodeAt(0)] = TokenType.SymbolComma
symbolTypes[".".charCodeAt(0)] = TokenType.SymbolDot
symbolTypes[":".charCodeAt(0)] = TokenType.SymbolColon
symbolTypes["=".charCodeAt(0)] = TokenType.SymbolEqual
symbolTypes["-".charCodeAt(0)] = TokenType.SymbolDash
symbolTypes[">".charCodeAt(0)] = TokenType.SymbolRightAngle
symbolTypes["<".charCodeAt(0)] = TokenType.SymbolLeftAngle
symbolTypes["_".charCodeAt(0)] = TokenType.SymbolUnderscore
symbolTypes["#".charCodeAt(0)] = TokenType.SymbolHash
symbolTypes["~".charCodeAt(0)] = TokenType.SymbolTilde

// NOTE: The Keywords and the two Boolean Literals share one table, because
// what the Identifier scanner needs is one question — "is this word something
// other than a name?" — and the two sets are disjoint. A word that is in
// neither is an Identifier, which is what `undefined` says.
const wordTypes = new Map<string, lexer.TokenType>([
	["if", TokenType.KeywordIf],
	["else", TokenType.KeywordElse],
	["type", TokenType.KeywordType],
	["variable", TokenType.KeywordVariable],
	["constant", TokenType.KeywordConstant],
	["function", TokenType.KeywordFunction],
	["implementation", TokenType.KeywordImplementation],
	["overload", TokenType.KeywordOverload],
	["match", TokenType.KeywordMatch],
	["case", TokenType.KeywordCase],
	["define", TokenType.KeywordDefine],
	["otherwise", TokenType.KeywordOtherwise],
	["with", TokenType.KeywordWith],
	["namespace", TokenType.KeywordNamespace],
	["protocol", TokenType.KeywordProtocol],
	["for", TokenType.KeywordFor],
	["infer", TokenType.KeywordInfer],
	["choice", TokenType.KeywordChoice],
	["import", TokenType.KeywordImport],
	["export", TokenType.KeywordExport],
	["from", TokenType.KeywordFrom],
	["as", TokenType.KeywordAs],
	["static", TokenType.KeywordStatic],
	["tests", TokenType.KeywordTests],
	["test", TokenType.KeywordTest],
	["suite", TokenType.KeywordSuite],
	["benchmark", TokenType.KeywordBenchmark],
	["expect", TokenType.KeywordExpect],
	["require", TokenType.KeywordRequire],
	["start", TokenType.KeywordStart],
	["complete", TokenType.KeywordComplete],
	["true", TokenType.LiteralTrue],
	["false", TokenType.LiteralFalse],
])

// NOTE: Guards the two tables above against a Keyword or Symbol that was added
// to the Arrays and forgotten here — the Lexer would silently read it as an
// Identifier, which is the kind of thing that only shows up as a mystifying
// parse error much later.
for (let keyword of keywords) {
	if (!wordTypes.has(keyword)) {
		throw new Error(`${keyword} is not a valid value for Keywords`)
	}
}

for (let boolean of booleans) {
	if (!wordTypes.has(boolean)) {
		throw new Error(`${boolean} is not a valid value for BooleanLiterals`)
	}
}

for (let symbol of symbols) {
	if (symbolTypes[symbol.charCodeAt(0)] === undefined) {
		throw new Error(`${symbol} is not a valid value for Symbols`)
	}
}

// NOTE: The escape set every String Literal understands. A backslash before
// anything else is an `invalid-escape` — reported, then read as the character
// alone so the rest of the String still lexes. `\{` and `\}` are how a literal
// brace is written now that a bare `{` opens an interpolation hole. `\u` is not
// in the table because it is the one escape that is longer than two characters
// and can be wrong in six ways of its own; `readUnicodeEscape` reads it.
const stringEscapes: { [char: string]: string } = {
	'"': '"',
	"\\": "\\",
	n: "\n",
	r: "\r",
	t: "\t",
	"{": "{",
	"}": "}",
}

// NOTE: The escape set spelled for a reader, in the order the Notes and the
// documentation spell it. One constant, because the sentence is written into
// three Diagnostics and getting a different list in two of them is exactly the
// sort of drift a reader has no way to resolve.
export const escapeSetSentence =
	"'\\\"', '\\\\', '\\n', '\\r', '\\t', '\\{', '\\}' and '\\u{…}'"

// NOTE: The highest Unicode scalar value, and the surrogate range that is not
// one. A lone surrogate is half of a UTF-16 pair and names no character on its
// own, so `\u{D800}` is refused where `\u{1F600}` — the character that pair
// stands for — is the escape to write instead.
const highestCodePoint = 0x10ffff
const firstSurrogate = 0xd800
const lastSurrogate = 0xdfff
const highSurrogateEnd = 0xdbff
const firstLowSurrogate = 0xdc00

const interpolationStartCode = "{".charCodeAt(0)
const rightBraceCode = "}".charCodeAt(0)

type ChunkTerminator = "quote" | "hole" | "eof"

export class Lexer {
	protected data: string
	// NOTE: Where the next character to read is, as an absolute offset. The
	// Lexer used to re-slice the remaining source for every Token and thread
	// the tail through every sub-lexer, which copied the rest of the file once
	// per Token; nothing is sliced now but the text a Token actually holds.
	protected index: number
	// NOTE: The Cursor, carried as two mutable numbers rather than an object.
	// It used to be re-allocated once per CHARACTER — twice, for the characters
	// that were counted for a Token's start and its end — and only ever
	// materialises now at the two ends of a Token that is really produced.
	protected line: number
	protected column: number
	protected ignoreList: Set<string>
	// NOTE: An interpolated String lexes into several Tokens at once — its head
	// is returned, and its chunk and hole Tokens wait here to be handed out one
	// per `next()` before any more input is read. Every other Token leaves this
	// empty. `index`/`line`/`column` already sit past the whole String while
	// these drain, so a queued Token advances neither.
	protected pending: Array<Token>
	// NOTE: How many queued Tokens have been handed out — `shift()` on every
	// `next()` would re-copy the queue each time.
	protected pendingIndex: number
	// NOTE: Collected rather than thrown — see `LexingError`. The caller reads
	// them once lexing is done; `reset` starts a new input with none.
	public errors: Array<LexingError>
	// NOTE: The String Literal that closed most recently, and nothing older.
	// It is the one piece of evidence the unterminated-String report has about
	// WHICH quote is the missing one — see `swallowedTheLinesBelow` — and each
	// close overwrites it, so a plain one-line String standing between a
	// multi-line String and an unterminated one clears the claim rather than
	// letting it reach across.
	//
	// NOTE: Four numbers rather than the `ClosedString` they spell, because
	// every String in every file closes and only a file that FAILS ever asks.
	// A pair of objects per closed String is an allocation on the Lexer's
	// hottest path to answer a question almost nothing asks; the object is built
	// where it is asked for instead. A zero line means no String has closed yet,
	// which is a line number no Token has.
	protected closedStringOpenedLine: number
	protected closedStringOpenedColumn: number
	protected closedStringClosedLine: number
	protected closedStringClosedColumn: number

	constructor() {
		this.data = ""
		this.index = 0
		this.line = 1
		this.column = 1
		this.ignoreList = new Set()
		this.pending = []
		this.pendingIndex = 0
		this.errors = []
		this.closedStringOpenedLine = 0
		this.closedStringOpenedColumn = 0
		this.closedStringClosedLine = 0
		this.closedStringClosedColumn = 0
	}

	reset(data: string, state: Cursor = { line: 1, column: 1 }) {
		this.data = data
		this.index = 0
		this.line = state.line
		this.column = state.column
		this.pending = []
		this.pendingIndex = 0
		this.errors = []
		this.closedStringOpenedLine = 0
		this.closedStringOpenedColumn = 0
		this.closedStringClosedLine = 0
		this.closedStringClosedColumn = 0
	}

	next(): lexer.Token | undefined {
		if (this.pendingIndex < this.pending.length) {
			let queued = this.pending[this.pendingIndex]!

			this.pendingIndex++

			if (this.pendingIndex === this.pending.length) {
				this.pending = []
				this.pendingIndex = 0
			}

			return queued
		}

		return this.lexToken(this.pending)
	}

	save(): Cursor {
		return { line: this.line, column: this.column }
	}

	ignore(name: lexer.TokenType) {
		this.ignoreList.add(name)
	}

	// #region Scanning

	protected cursor(): Cursor {
		return { line: this.line, column: this.column }
	}

	// NOTE: The Token standing at `index`, or `undefined` at the end of the
	// input. Tokens an interpolated String produces beyond its head are
	// appended to `extra` — the caller decides where they go, which is what
	// lets a String inside an interpolation hole nest without a special case.
	protected lexToken(extra: Array<Token>): Token | undefined {
		let data = this.data

		while (true) {
			// NOTE: A run of whitespace is skipped in a loop rather than by
			// recursing once per character, and never materialises a Token.
			while (this.index < data.length) {
				let code = data.charCodeAt(this.index)

				if ((classOfCode(code) & isSpace) === 0) {
					break
				}

				this.index++
				this.column++
			}

			if (this.index >= data.length) {
				return undefined
			}

			let code = data.charCodeAt(this.index)
			// NOTE: An ignored Token takes its own errors with it, exactly as
			// it did when its whole result was thrown away — a class nobody
			// reads is a class nobody should be told about either. No ignorable
			// Token produces one today; this keeps that from being a rule
			// anything silently depends on.
			let errorMark = this.errors.length
			let token: Token

			// NOTE: An ignored class is skipped without ever being built —
			// `Linebreak` and `Comment` are the whole of the parser's ignore
			// list and together they are a large share of every file's Tokens.
			if (code === linebreakCode) {
				if (this.ignoreList.has(TokenType.Linebreak)) {
					this.index++
					this.line++
					this.column = 1

					continue
				}

				token = this.lexLinebreak()
			} else if (code === commentLiteralCode) {
				if (this.skipIgnoredComment()) {
					continue
				}

				token = this.lexComment()
			} else if (symbolTypes[code] !== undefined) {
				token = this.lexSymbol(symbolTypes[code]!)
			} else if (code === stringLiteralCode) {
				// NOTE: A String's head Token can be an ignored type only
				// never — the `Start`/`LiteralString` types are never on an
				// ignore list — so the filter below does not apply to it, and
				// its `extra` Tokens never need one either.
				return this.lexString(extra)
			} else if ((classOfCode(code) & isDigit) !== 0) {
				token = this.lexNumber()
			} else {
				token = this.lexIdentifier()
			}

			if (this.ignoreList.has(token.type)) {
				this.errors.length = errorMark

				continue
			}

			return token
		}
	}

	// NOTE: A Comment whose class is ignored is measured and stepped over
	// rather than built — but only once its type is known, because the second
	// sigil is what makes it Documentation, and Documentation is on nobody's
	// ignore list. Answers whether it was skipped.
	protected skipIgnoredComment(): boolean {
		let end = this.commentEnd()
		let isDocumentation = this.data.startsWith(
			documentationLiteral,
			this.index,
		)
		let type = isDocumentation ? TokenType.DocComment : TokenType.Comment

		if (!this.ignoreList.has(type)) {
			return false
		}

		this.column += end - this.index
		this.index = end

		return true
	}

	// NOTE: Where the Comment starting at `index` ends — at its line break,
	// which is not part of it. A `\r` ends it too, so that a Comment on a
	// Windows line ending does not carry one.
	protected commentEnd(): number {
		let data = this.data
		let end = this.index

		while (end < data.length) {
			let code = data.charCodeAt(end)

			if (code === linebreakCode || code === carriageReturnCode) {
				break
			}

			end++
		}

		return end
	}

	protected lexLinebreak(): Token {
		let start = this.index
		let startCursor = this.cursor()

		this.index++
		this.line++
		this.column = 1

		return {
			value: linebreak,
			type: TokenType.Linebreak,
			position: { start: startCursor, end: this.cursor() },
			start,
			end: this.index,
		}
	}

	protected lexSymbol(type: lexer.TokenType): Token {
		let start = this.index
		let startCursor = this.cursor()

		this.index++
		this.column++

		return {
			value: this.data[start]!,
			type,
			position: { start: startCursor, end: this.cursor() },
			start,
			end: this.index,
		}
	}

	protected lexComment(): Token {
		let start = this.index
		let startCursor = this.cursor()
		let end = this.commentEnd()
		let value = this.data.slice(start, end)

		// NOTE: A Comment holds no line break, so its whole span is columns.
		this.column += end - start
		this.index = end

		return {
			value,
			// NOTE: Doubling the sigil turns a private note into Documentation
			// of whatever is declared below it. The distinction is made here
			// rather than by a separate scanner because the two are lexed
			// identically — only the Token type differs, and only the Parser
			// cares.
			type: value.startsWith(documentationLiteral)
				? TokenType.DocComment
				: TokenType.Comment,
			position: { start: startCursor, end: this.cursor() },
			start,
			end,
		}
	}

	// NOTE: A Number Literal is digits and nothing else — Essence has no
	// hexadecimal, binary or exponent form, so `0xFF`, `0b101` and `1e5` are all
	// wrong. The letters are read into the Literal anyway, and reported as one
	// malformed Number: stopping at the first letter instead would leave `FF`
	// behind as an Identifier Statement, which is neither what was written nor
	// anything the author could act on. The Token still carries only its leading
	// digits, so every later stage sees a well-formed Number and reports its own
	// problems rather than failing on text no Number can hold.
	//
	// NOTE: The `.` of a decimal is a Token of its own and no business of this
	// scanner's. The Parser joins `0`, `.` and `75` into one Rational Literal
	// where the three are written flush, exactly the way it joins `3`, `/` and
	// `4` — so at this level a Number Literal really is digits and nothing else.
	protected lexNumber(): Token {
		let data = this.data
		let start = this.index
		let startCursor = this.cursor()
		let end = start
		let digitsEnd = -1

		while (end < data.length) {
			let characterClass = classOfCode(data.charCodeAt(end))

			if ((characterClass & endsWord) !== 0) {
				break
			}

			if ((characterClass & isDigit) === 0) {
				// NOTE: A Number ENDS at a character another language writes an
				// operator with — `1+2` is two Numbers and a habit, not one
				// malformed Number, and `total = 1;` is a Number with a `;`
				// behind it. Neither ends a word for the Lexer, which has no
				// class but Identifier to put them in, so each is left to lex as
				// one and answered where it stands: the Parser knows whether it
				// is reading an operator or a Statement terminator, and this does
				// not.
				//
				// Everything else is read into the Literal and reported as one
				// malformed Number — see the NOTE above.
				if (foreignPunctuation.has(data[end] as string)) {
					break
				}

				if (digitsEnd === -1) {
					digitsEnd = end
				}
			}

			end++
		}

		// NOTE: No character of a Number is a line break — `endsWord` stops it
		// at one — so its whole span is columns.
		this.column += end - start
		this.index = end

		let position = { start: startCursor, end: this.cursor() }
		let token: Token = {
			value: data.slice(start, digitsEnd === -1 ? end : digitsEnd),
			type: TokenType.LiteralNumber,
			position,
			start,
			end,
		}

		if (digitsEnd !== -1) {
			this.errors.push({
				message: `'${data.slice(start, end)}' is not a valid Number`,
				position,
				code: "invalid-number",
			})
		}

		return token
	}

	protected lexIdentifier(): Token {
		let data = this.data
		let start = this.index
		let startCursor = this.cursor()
		let end = start

		// NOTE: The Comment and String sigils end an Identifier exactly as a
		// Symbol does — `name§ note` is a name and a Comment written flush
		// against each other, not an Identifier called `name§`.
		while (end < data.length) {
			if ((classOfCode(data.charCodeAt(end)) & endsWord) !== 0) {
				break
			}

			end++
		}

		// NOTE: As for a Number — an Identifier can hold no line break.
		this.column += end - start
		this.index = end

		let value = data.slice(start, end)

		return {
			value,
			type: wordTypes.get(value) ?? TokenType.Identifier,
			position: { start: startCursor, end: this.cursor() },
			start,
			end,
		}
	}

	// #endregion

	// #region Strings

	// NOTE: A String that never closes takes everything found inside it with
	// it — the bad escapes, the Comments written in its holes, the Tokens its
	// holes produced. It used to happen by itself, because all of that was
	// gathered in locals that the throw unwound past; it is undone by hand now
	// that the Lexer collects as it goes. The report is "this String Literal is
	// never closed" and nothing else: everything after the opening quote is
	// text that was never a String, so a Diagnostic about the shape of it would
	// be about a reading that did not happen.
	protected lexString(extra: Array<Token>): Token {
		let errorMark = this.errors.length
		let extraMark = extra.length

		try {
			return this.lexStringChunks(extra)
		} catch (error) {
			this.errors.length = errorMark
			extra.length = extraMark

			throw error
		}
	}

	// NOTE: A String Literal reads as one `LiteralString` Token when it holds
	// no `{…}` hole. A hole makes it interpolated: the text before the first
	// hole becomes a `LiteralStringStart` Token, each hole's own Tokens are
	// lexed in place (by driving `lexToken`, so a nested String, Record or even
	// a nested interpolation inside a hole needs no special case), the text
	// between holes becomes `LiteralStringMiddle` and the text after the last
	// hole becomes `LiteralStringEnd`. The head Token is returned; the rest are
	// appended to `extra`, which the Lexer drains before it lexes anything
	// more.
	protected lexStringChunks(extra: Array<Token>): Token {
		let stringStart = this.cursor()
		let stringStartOffset = this.index

		// Consume the opening quote.
		this.index++
		this.column++

		let firstChunk = this.scanStringChunk()

		if (firstChunk.terminator === "eof") {
			this.throwUnterminatedString(this.cursor(), stringStart)
		}

		if (firstChunk.terminator === "quote") {
			this.noteClosedString(stringStart)

			return {
				value: firstChunk.value,
				type: TokenType.LiteralString,
				position: { start: stringStart, end: this.cursor() },
				start: stringStartOffset,
				end: this.index,
			}
		}

		let head: Token = {
			value: firstChunk.value,
			type: TokenType.LiteralStringStart,
			position: { start: stringStart, end: this.cursor() },
			start: stringStartOffset,
			end: this.index,
		}

		while (true) {
			// Lex the hole's own Tokens until the `}` that closes it — the one
			// `SymbolRightBrace` seen at brace depth zero. Braces of Records written
			// inside the hole balance out before that, and a nested String's braces
			// live inside its own Tokens, so neither reaches the count.
			let depth = 0

			while (true) {
				// NOTE: A Comment has no place inside a hole — it would run to the
				// end of the line and take the hole's `}` and the String's closing
				// `"` with it. It is reported and read as ending at the first `}`
				// (or the end of its line), so the String and everything after it
				// still lex.
				this.skipHoleWhitespace()

				if (
					this.index < this.data.length &&
					this.data.charCodeAt(this.index) === commentLiteralCode
				) {
					this.reportCommentInHole()

					continue
				}

				// NOTE: Snapshotted BEFORE the Token is read, because the read
				// walks over whatever whitespace stands in front of the end of
				// the input and the report is about where the String ran out,
				// not where the scan stopped.
				let beforeToken = this.cursor()
				let extraStart = extra.length
				let holeToken = this.lexToken(extra)

				if (holeToken === undefined) {
					this.throwUnterminatedString(beforeToken, stringStart)
				}

				if (
					holeToken!.type === TokenType.SymbolRightBrace &&
					depth === 0
				) {
					break
				}

				if (holeToken!.type === TokenType.SymbolLeftBrace) {
					depth++
				} else if (holeToken!.type === TokenType.SymbolRightBrace) {
					depth--
				}

				// NOTE: A nested interpolated String appended its own tail to
				// `extra` while its head was still in hand, so the head is put
				// back in front of it rather than after.
				if (extra.length > extraStart) {
					extra.splice(extraStart, 0, holeToken!)
				} else {
					extra.push(holeToken!)
				}
			}

			let chunkStart = this.cursor()
			let chunkStartOffset = this.index
			let chunk = this.scanStringChunk()

			if (chunk.terminator === "eof") {
				this.throwUnterminatedString(this.cursor(), stringStart)
			}

			extra.push({
				value: chunk.value,
				type:
					chunk.terminator === "quote"
						? TokenType.LiteralStringEnd
						: TokenType.LiteralStringMiddle,
				position: { start: chunkStart, end: this.cursor() },
				start: chunkStartOffset,
				end: this.index,
			})

			if (chunk.terminator === "quote") {
				this.noteClosedString(stringStart)

				break
			}
		}

		return head
	}

	// NOTE: Called with the String's opening Cursor the moment its closing quote
	// has been consumed, so the Lexer's own Cursor stands just past that quote
	// and the quote itself is the character in front of it. What is kept is the
	// two Cursors, as four numbers; see `closedStringOpenedLine` for why.
	protected noteClosedString(openedAt: Cursor): void {
		this.closedStringOpenedLine = openedAt.line
		this.closedStringOpenedColumn = openedAt.column
		this.closedStringClosedLine = this.line
		this.closedStringClosedColumn = this.column - 1
	}

	// NOTE: Whitespace only — a line break inside a hole is a Token like any
	// other, and is left for `lexToken` (or for the ignore list) to decide on.
	protected skipHoleWhitespace(): void {
		let data = this.data

		while (this.index < data.length) {
			if ((classOfCode(data.charCodeAt(this.index)) & isSpace) === 0) {
				break
			}

			this.index++
			this.column++
		}
	}

	protected reportCommentInHole(): void {
		let data = this.data
		let commentStart = this.cursor()
		let end = this.index

		while (end < data.length) {
			let code = data.charCodeAt(end)

			if (code === linebreakCode || code === rightBraceCode) {
				break
			}

			end++
		}

		this.column += end - this.index
		this.index = end

		this.errors.push({
			message:
				"A Comment can not be written inside an interpolation hole",
			position: { start: commentStart, end: this.cursor() },
			code: "comment-in-hole",
		})
	}

	// NOTE: Reads one run of literal String text, decoding escapes into `value`,
	// and stops at the character that ends the run: the closing `"` (`quote`), an
	// unescaped `{` opening a hole (`hole`), or the end of the input (`eof`, which
	// the caller turns into the fatal unterminated-String throw). The terminating
	// character is consumed — `index` and the Cursor sit just past it.
	//
	// NOTE: The one place text is still built up a piece at a time, and only
	// where it has to be: an escape decodes to something other than what was
	// written, so a run holding one can not be sliced out of the source whole.
	// A run without escapes — which is nearly all of them — is one slice.
	protected scanStringChunk(): {
		value: string
		terminator: ChunkTerminator
	} {
		let data = this.data
		let index = this.index
		let line = this.line
		let column = this.column
		let runStart = index
		let decoded = ""
		let hasEscape = false

		while (index < data.length) {
			let code = data.charCodeAt(index)

			if (code === stringLiteralCode || code === interpolationStartCode) {
				let run = data.slice(runStart, index)

				this.index = index + 1
				this.line = line
				this.column = column + 1

				return {
					value: hasEscape ? decoded + run : run,
					terminator: code === stringLiteralCode ? "quote" : "hole",
				}
			}

			if (code === backslashCode) {
				let escaped = data[index + 1]

				// NOTE: A backslash with nothing after it is the input running
				// out mid-String — let the loop fall through to the `eof`
				// return, which the caller reports as an unterminated String.
				if (escaped === undefined) {
					break
				}

				decoded += data.slice(runStart, index)
				hasEscape = true

				// NOTE: The one escape that is longer than two characters, and
				// the one the table above can not answer — read before the table
				// is asked, and it reports whatever it has to report itself.
				if (escaped === "u") {
					let read = this.readUnicodeEscape(index, line, column)

					decoded += read.decoded
					column = read.column
					index = read.index
					runStart = index

					continue
				}

				let escapeStart = { line, column }

				column++

				if (escaped === linebreak) {
					line++
					column = 1
				} else {
					column++
				}

				let replacement = stringEscapes[escaped]

				if (replacement === undefined) {
					// NOTE: The character is the READER'S, and this message is
					// read on a terminal — a backslash before a BEL rang the
					// bell of whoever ran the Compiler, and one before an
					// override reordered the line it was written on. Where it
					// prints as itself it is quoted as the escape it was meant
					// to be; where it does not, it is named, and the sentence
					// is built around the name rather than around `'\…'`.
					let offender = characterAt(data, index + 1)

					this.errors.push({
						message: printsAsItself(offender)
							? `'\\${offender}' is not a valid escape`
							: `A backslash before ${codePointName(offender)} is not a valid escape`,
						position: { start: escapeStart, end: { line, column } },
						code: "invalid-escape",
					})
					decoded += escaped
				} else {
					decoded += replacement
				}

				index += 2
				runStart = index

				continue
			}

			if (code === linebreakCode) {
				line++
				column = 1
			} else {
				column++
			}

			index++
		}

		let run = data.slice(runStart, index)

		this.index = index
		this.line = line
		this.column = column

		return {
			value: hasEscape ? decoded + run : run,
			terminator: "eof",
		}
	}

	// NOTE: `\u{1F600}` — one to six hexadecimal digits in braces, naming ONE
	// Unicode scalar value, decoded here into the character it names. It is read
	// by hand rather than looked up in `stringEscapes` because it is the only
	// escape whose spelling runs past two characters and because every part of
	// it can be wrong on its own: the braces can be missing, hold nothing, hold
	// something that is not a digit, hold too many of them, or hold a number
	// that names no character.
	//
	// NOTE: A refused escape contributes NO character. There is none it could
	// contribute — it named none — and the two other readings are worse: the
	// digits kept as text would put `1B` into a value whose author wrote an
	// escape, and a replacement character would put one there that nothing in
	// the file asked for.
	//
	// NOTE: WHERE THE SCAN STOPS is the whole of the recovery. Looking for the
	// closing brace, it stops at the characters that end the reading of the
	// literal itself — the closing quote, the backslash that opens the next
	// escape, a line break, and the `{` that opens a hole — and it does not
	// consume them. So an escape that was never closed takes nothing with it:
	// the quote still closes the String, the `{` still opens its hole, and a
	// String that really is unclosed is still reported about its own quote.
	protected readUnicodeEscape(
		start: number,
		line: number,
		column: number,
	): { index: number; column: number; decoded: string } {
		let data = this.data
		let opening = start + 2

		if (data.charCodeAt(opening) !== interpolationStartCode) {
			return this.readUnbracedEscape(start, line, column)
		}

		let scan = opening + 1

		while (scan < data.length) {
			let code = data.charCodeAt(scan)

			if (code === rightBraceCode) {
				break
			}

			if (
				code === stringLiteralCode ||
				code === backslashCode ||
				code === linebreakCode ||
				code === carriageReturnCode ||
				code === interpolationStartCode
			) {
				break
			}

			scan++
		}

		let digits = data.slice(opening + 1, scan)

		if (scan >= data.length || data.charCodeAt(scan) !== rightBraceCode) {
			return this.refuseUnclosedEscape(start, scan, line, column, digits)
		}

		let end = scan + 1
		let offending = firstNonHexDigit(digits)

		if (digits.length === 0) {
			return this.refuseEscape(
				start,
				end,
				line,
				column,
				"malformed-unicode-escape",
				"'\\u{}' names no code point",
				{
					label: "nothing stands between the braces",
					notes: [unicodeEscapeRule],
					helps: [
						"Write the code point's hexadecimal digits between the braces: '\\u{1B}' is the escape character.",
					],
				},
			)
		}

		if (offending !== -1) {
			return this.refuseEscape(
				start,
				end,
				line,
				column,
				"malformed-unicode-escape",
				`${spelledCharacter(characterAt(digits, offending))} is not a hexadecimal digit`,
				{
					label: "a code point is written in hexadecimal",
					notes: [unicodeEscapeRule],
					helps: namedCodePointHelps(digits),
				},
			)
		}

		if (digits.length > 6) {
			return this.refuseEscape(
				start,
				end,
				line,
				column,
				"malformed-unicode-escape",
				`'\\u{${digits}}' has ${digits.length} digits`,
				{
					label: "a code point takes at most six digits",
					notes: [unicodeEscapeRule],
					helps: trimmedDigitHelps(digits),
				},
			)
		}

		let value = Number.parseInt(digits, 16)

		if (value > highestCodePoint) {
			return this.refuseEscape(
				start,
				end,
				line,
				column,
				"unicode-escape-out-of-range",
				`U+${digits.toUpperCase()} is above the highest character`,
				{
					label: "no character has this code point",
					notes: [
						"The highest Unicode code point is U+10FFFF, so '\\u{10FFFF}' is the largest escape there is.",
					],
					helps: decimalReadingHelps(digits, value),
				},
			)
		}

		if (value >= firstSurrogate && value <= lastSurrogate) {
			// NOTE: A high half with its low half directly behind it is ONE
			// mistake and is refused as one: the report spans both escapes, the
			// reading resumes past both, and the Help — which the Quick Fix
			// applies to the span it underlines — rewrites the whole of what it
			// answers. Reported a half at a time, following that Help left the
			// second half standing and the reader was refused all over again.
			let pair =
				value <= highSurrogateEnd ? this.lowSurrogateBehind(end) : null

			if (pair !== null) {
				return this.refuseEscape(
					start,
					pair.end,
					line,
					column,
					"surrogate-unicode-escape",
					`U+${digits.toUpperCase()} and U+${pair.value.toString(16).toUpperCase()} are the two halves of one character`,
					{
						label: "one character, written as the units it is stored in",
						notes: [surrogateRule],
						helps: [pairedCharacterHelp(value, pair.value)],
					},
				)
			}

			return this.refuseEscape(
				start,
				end,
				line,
				column,
				"surrogate-unicode-escape",
				`U+${digits.toUpperCase()} is a surrogate, which names no character`,
				{
					label: "this is half of a character, not one",
					notes: [surrogateRule],
					helps: [],
				},
			)
		}

		return {
			index: end,
			column: column + (end - start),
			decoded: String.fromCodePoint(value),
		}
	}

	// NOTE: `\u001B` and `\u1B` — the JavaScript and JSON habit, which writes the
	// digits with no braces around them. It is a habit rather than a slip, so it
	// is answered the way the rest of them are (`helpers/foreign.ts`): with the
	// Essence spelling of the very character the reader wrote.
	//
	// WHICH digits those are is the whole of the care here. JavaScript's `\u`
	// takes exactly four, so `ABC` is `A` followed by `BC` there, and a Help
	// that offered `\u{41BC}` would hand back a String its reader never meant.
	// Four are taken where four or more are written, all of them where fewer are,
	// and where a `}` stands directly behind them the `{` alone was lost, so the
	// whole of `\u1B}` is rewritten.
	//
	// The shape that is neither is the SURROGATE PAIR — `\uD83D\uDE00`, how
	// JavaScript writes an astral character. Neither half names a character, so
	// neither half has a rewrite of its own; the two together do, and that one
	// escape is what the Help offers.
	protected readUnbracedEscape(
		start: number,
		line: number,
		column: number,
	): { index: number; column: number; decoded: string } {
		let data = this.data
		let runStart = start + 2
		let runEnd = runStart

		while (
			runEnd < data.length &&
			(classOfCode(data.charCodeAt(runEnd)) & isHexDigit) !== 0
		) {
			runEnd++
		}

		let written = data.slice(runStart, runEnd)
		let closed =
			written.length >= 1 &&
			written.length <= 6 &&
			data.charCodeAt(runEnd) === rightBraceCode
		let taken = closed
			? written
			: written.length >= 4
				? written.slice(0, 4)
				: written
		let end = closed ? runEnd + 1 : runStart + taken.length
		let helps: Array<string> = []

		if (taken.length === 0) {
			helps.push(
				"Write the code point's hexadecimal digits in braces: '\\u{1B}' is the escape character.",
			)
		} else {
			let value = Number.parseInt(taken, 16)
			let pair =
				closed || value < firstSurrogate || value > highSurrogateEnd
					? null
					: this.lowSurrogateBehind(end)

			if (pair !== null) {
				end = pair.end
				helps.push(pairedCharacterHelp(value, pair.value))
			} else if (isScalarValue(value)) {
				helps.push(
					`Write it in braces: '\\u{${withoutLeadingZeros(taken)}}'.`,
				)
			}
		}

		return this.refuseEscape(
			start,
			end,
			line,
			column,
			"unbraced-unicode-escape",
			taken.length === 0
				? "'\\u' is missing the braces around its code point"
				: `'\\u${taken}' is missing the braces around its code point`,
			{
				label: "a code point is written in braces",
				notes: [unicodeEscapeRule],
				helps,
			},
		)
	}

	// NOTE: The second half of a surrogate pair standing DIRECTLY behind the
	// first, in either spelling: `\uDE00`, which is how JavaScript writes one,
	// and `\u{DE00}`, which is how a reader who has been told the rule once
	// writes the same mistake out the long way. Both are read here because the
	// two halves need not agree with each other — `\uD83D\u{DE00}` is what
	// rewriting a pair one half at a time leaves behind — and each of the four
	// arrangements is one character written in two escapes just as much as the
	// matching pair is.
	//
	// `end` matters as much as `value`: the caller refuses the WHOLE pair under
	// one Diagnostic and resumes past it, so the half found here is never read
	// again as an escape of its own and the rewrite the Help spells replaces all
	// of what the report underlines. Refusing the halves separately was a
	// preferred Quick Fix that left its own refusal standing.
	//
	// The unbraced form takes exactly FOUR digits, as JavaScript's `\u` does;
	// the braced form takes one to six and its closing brace.
	protected lowSurrogateBehind(
		index: number,
	): { value: number; end: number } | null {
		let data = this.data

		if (
			data.charCodeAt(index) !== backslashCode ||
			data[index + 1] !== "u"
		) {
			return null
		}

		let braced = data.charCodeAt(index + 2) === interpolationStartCode
		let digitStart = braced ? index + 3 : index + 2
		let limit = digitStart + (braced ? 6 : 4)
		let scan = digitStart

		while (
			scan < data.length &&
			scan < limit &&
			(classOfCode(data.charCodeAt(scan)) & isHexDigit) !== 0
		) {
			scan++
		}

		if (
			braced
				? scan === digitStart ||
					data.charCodeAt(scan) !== rightBraceCode
				: scan - digitStart < 4
		) {
			return null
		}

		let value = Number.parseInt(data.slice(digitStart, scan), 16)

		return value >= firstLowSurrogate && value <= lastSurrogate
			? { value, end: braced ? scan + 1 : scan }
			: null
	}

	// NOTE: `\u{1B` — the escape was opened and the reading ran into something
	// that ends the literal. The span covers what was read and stops short of
	// that character, which is what leaves the closing quote and any hole below
	// it to be read as themselves.
	protected refuseUnclosedEscape(
		start: number,
		end: number,
		line: number,
		column: number,
		digits: string,
	): { index: number; column: number; decoded: string } {
		let closing =
			digits.length === 0
				? "Write the code point's hexadecimal digits and a closing '}': '\\u{1B}'."
				: digits.length <= 6 &&
					  firstNonHexDigit(digits) === -1 &&
					  isScalarValue(Number.parseInt(digits, 16))
					? `Close it with a '}': '\\u{${digits}}'.`
					: null

		return this.refuseEscape(
			start,
			end,
			line,
			column,
			"malformed-unicode-escape",
			"this '\\u{' is never closed",
			{
				label: "no '}' closes this escape",
				notes: [unicodeEscapeRule],
				helps: closing === null ? [] : [closing],
			},
		)
	}

	// NOTE: One refusal of a `\u{…}` — four codes and six shapes, but one SPAN
	// and one recovery: the report covers the escape exactly as far as it was
	// read, the reading resumes at `end`, and the String is given no character.
	// Every one of them sits on a single line, because a line break is one of the
	// characters the scan stops at.
	protected refuseEscape(
		start: number,
		end: number,
		line: number,
		column: number,
		code: LexingError["code"],
		message: string,
		report: EscapeReport,
	): { index: number; column: number; decoded: string } {
		let endColumn = column + (end - start)

		this.errors.push({
			message,
			position: {
				start: { line, column },
				end: { line, column: endColumn },
			},
			code,
			report,
		})

		return { index: end, column: endColumn, decoded: "" }
	}

	protected throwUnterminatedString(cursor: Cursor, openedAt: Cursor): never {
		throw new UnterminatedStringError(
			cursor,
			openedAt,
			this.swallowedTheLinesBelow(openedAt),
		)
	}

	// NOTE: WHICH quote is the missing one. A String Literal in Essence may span
	// lines and the line breaks are part of it, so a String opened on line 2 and
	// closed on line 3 is a String the language has, and the one the input ended
	// inside of is — strictly — the one that was left open. Strictly is not
	// helpful: the file below says the same thing twice, and the reader is
	// pointed at a quote they wrote on purpose.
	//
	//     constant greeting = "Hello
	//     constant name = "Ada"
	//
	// Exactly one '"' is missing under either reading. Under the first, the one
	// at the end of line 1; the quote in front of `Ada` closes nothing, it opens
	// `"Ada"`. Under the second, the author wrote a String holding a line of
	// their own source, left `Ada` standing bare behind it, and then opened a
	// String they never closed. The first is what people write; the second is
	// not a file anybody has.
	//
	// So: a String that SPANNED LINES and closed on the very line the unclosed
	// one opens on is named as the culprit instead. Both readings are in the
	// report either way — the reader is shown the quote that closed it and told
	// what the other reading would mean — because this is a judgement about
	// which mistake is likelier and not something the Lexer can know.
	//
	// The narrowing is two-sided on purpose. What is kept is the String that
	// closed DIRECTLY in front of this one and no older one — each close
	// overwrites the four numbers — so a one-line String written between the two
	// clears the claim; and the two quotes have to share a line, so an unclosed
	// String further down the file is reported about itself.
	protected swallowedTheLinesBelow(openedAt: Cursor): ClosedString | null {
		if (
			this.closedStringClosedLine <= this.closedStringOpenedLine ||
			this.closedStringClosedLine !== openedAt.line
		) {
			return null
		}

		return {
			openedAt: {
				line: this.closedStringOpenedLine,
				column: this.closedStringOpenedColumn,
			},
			closedAt: {
				line: this.closedStringClosedLine,
				column: this.closedStringClosedColumn,
			},
			spansLines: true,
		}
	}

	// #endregion
}
