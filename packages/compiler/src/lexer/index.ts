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

// The Lexer's non-fatal problems: a Token it could read but that can never be
// valid, like `0xFF` or an unknown escape. The stream stays intact, and the
// parser's `TokenStream` reports each under its `code`.
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
	// The rest of the report for a `\u{…}`, whose Helps spell the reader's own
	// digits back. Which mistake it was is known only where the escape was read.
	// Every other code's text is built where it is reported.
	report?: EscapeReport
}

// What a refused `\u{…}` says under its code. The Helps are empty when no
// edit works.
export type EscapeReport = {
	label: string
	notes: Array<string>
	helps: Array<string>
}

// A String Literal that closed, for the unterminated-String report. See
// `swallowedTheLinesBelow`.
export type ClosedString = {
	openedAt: Cursor
	closedAt: Cursor
	spansLines: boolean
}

// A hole's `{`, and the quote of the first String written inside it.
export type StringHole = {
	brace: Cursor
	quote: Cursor
}

// The one fatal Lexer error, since after an unterminated String there is
// nothing left to lex. It carries where the input ran out and where the String
// was opened.
export class UnterminatedStringError extends Error {
	endOfInput: Cursor
	openedAt: Cursor
	// The String Literal that closed directly before this one and spanned
	// lines, the likelier culprit. See "Which quote is missing" in
	// DEVELOPMENT.md.
	swallower: ClosedString | null
	// The hole this String's opening quote stands in, or null outside every
	// hole. See "A quote inside a hole" in DEVELOPMENT.md.
	hole: StringHole | null

	constructor(
		endOfInput: Cursor,
		openedAt: Cursor,
		swallower: ClosedString | null = null,
		hole: StringHole | null = null,
	) {
		super(
			`String Token not closed at line: ${endOfInput.line}, column: ${endOfInput.column}`,
		)
		this.endOfInput = endOfInput
		this.openedAt = openedAt
		this.swallower = swallower
		this.hole = hole
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
// `\r` is whitespace so a file with Windows line endings lexes as its Unix
// twin: `\n` alone is the line break. A byte order mark, `\uFEFF`, is
// whitespace too, not the first letter of `implementation`.
const whitespaces = [" ", "\t", "\r", "﻿"]

// The character codes the scan loops compare against, taken from the
// character constants so the two spellings can not drift apart.
const linebreakCode = linebreak.charCodeAt(0)
const stringLiteralCode = stringLiteral.charCodeAt(0)
const commentLiteralCode = commentLiteral.charCodeAt(0)
const carriageReturnCode = "\r".charCodeAt(0)
const backslashCode = "\\".charCodeAt(0)

// Character class flags, answered by one table lookup per character.
// `endsWord` stops an Identifier or a Number: whitespace, the line break, a
// Symbol, and the Comment and String sigils. `isSpace` is what skipping eats.
const endsWord = 1
const isDigit = 2
const isSpace = 4
// Only the `\u` escape readers read this flag, since there is no `0xFF`
// Number Literal.
const isHexDigit = 8

const characterClasses = new Uint8Array(128)
// The characters above 127 that belong to a class: `§` and the byte order
// mark. Every other one is part of a name, a surrogate half included, read as
// the code unit the cursor counts.
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

// Where a `\u{…}` holds a character that is not a hexadecimal digit, or -1.
// `parseInt` can not tell: it reads the longest prefix it understands, so
// `parseInt("1G", 16)` is 1.
function firstNonHexDigit(digits: string): number {
	for (let offset = 0; offset < digits.length; offset++) {
		if ((classOfCode(digits.charCodeAt(offset)) & isHexDigit) === 0) {
			return offset
		}
	}

	return -1
}

// Whether a number names a character a String can hold. Neither a number
// past `highestCodePoint` nor a surrogate, half of a UTF-16 pair, does.
function isScalarValue(value: number): boolean {
	return (
		value <= highestCodePoint &&
		(value < firstSurrogate || value > lastSurrogate)
	)
}

// A code point in upper case, as Unicode names one and as the runtime's
// quoted printer writes it. A Help that only re-brackets the reader's own
// digits keeps their case instead, as `readUnbracedEscape` does.
function bracedEscape(value: number): string {
	return `\\u{${value.toString(16).toUpperCase()}}`
}

// The digits without leading zeros, as a rewrite of the reader's own text
// writes them back: `\u001B` becomes `\u{1B}`. Their case is kept.
function withoutLeadingZeros(digits: string): string {
	let offset = 0

	while (offset < digits.length - 1 && digits[offset] === "0") {
		offset++
	}

	return digits.slice(offset)
}

// The character a surrogate pair spells, by the arithmetic Unicode gives.
function characterOfPair(high: number, low: number): number {
	return 0x10000 + ((high - firstSurrogate) << 10) + (low - firstLowSurrogate)
}

// The Help a surrogate pair gets. The Quick Fix reads the spelling back out
// of this sentence, so it is written in one place.
// See "Reports and Helps" in DEVELOPMENT.md.
function pairedCharacterHelp(high: number, low: number): string {
	return `Write the character as one escape: '${bracedEscape(
		characterOfPair(high, low),
	)}'.`
}

// The rule every malformed `\u{…}` broke, written once so every refusal
// states it in the same words.
const unicodeEscapeRule =
	"A Unicode escape is written '\\u{…}' — one to six hexadecimal digits in braces, naming one character."

// A surrogate's digits are a well-formed escape, and the number itself is
// the mistake, so it has a rule of its own.
const surrogateRule =
	"U+D800 through U+DFFF are the halves UTF-16 writes a character above U+FFFF in; a String holds characters, so an escape names one of those directly."

// `\u{U+1B}`: a code point written as it is named rather than spelled. The
// Help hands the reader's digits back without the `U+`.
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

// Seven digits or more are leading zeros in every case a reader meant, as in
// `\u{000001B}`. The zeros come off where what is left names a character.
function trimmedDigitHelps(digits: string): Array<string> {
	let trimmed = withoutLeadingZeros(digits)

	return trimmed.length <= 6 && isScalarValue(Number.parseInt(trimmed, 16))
		? [`Drop the leading zeros: '\\u{${trimmed}}'.`]
		: []
}

// `\u{128512}`: a code point read off a chart in decimal. The Help offers
// the decimal reading on a condition, and is withheld up to this code point.
// See "Decimal digits" in DEVELOPMENT.md.
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

// A Symbol is one ASCII character, so the table is indexed by its code. It
// doubles as the test for whether a character is a Symbol.
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

// The Keywords and the Boolean Literals share one table, since the
// Identifier scanner asks only whether a word is something other than a name.
// A word in neither is an Identifier.
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

// Guards `wordTypes` and `symbolTypes` against a Keyword or Symbol added to
// the Arrays and forgotten in the tables, which would silently lex as an
// Identifier.
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

// The escape set every String Literal understands. A backslash before
// anything else is an `invalid-escape`, read as the character alone so the
// rest of the String still lexes. `readUnicodeEscape` reads `\u`.
const stringEscapes: { [char: string]: string } = {
	'"': '"',
	"\\": "\\",
	n: "\n",
	r: "\r",
	t: "\t",
	"{": "{",
	"}": "}",
}

// The escape set spelled for a reader, in the order the documentation
// spells it, so every Diagnostic lists the same set.
export const escapeSetSentence =
	"'\\\"', '\\\\', '\\n', '\\r', '\\t', '\\{', '\\}' and '\\u{…}'"

// The highest Unicode scalar value, and the surrogate range, which holds
// none.
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
	// The offset of the next character to read. Only the text a Token holds
	// is ever sliced.
	protected index: number
	// The Cursor as two mutable numbers, so it becomes an object only at the
	// ends of a Token that is produced.
	protected line: number
	protected column: number
	protected ignoreList: Set<string>
	// An interpolated String lexes into several Tokens at once. Its head is
	// returned, and the rest wait here for later `next()` calls. `index`, `line`
	// and `column` already stand past the whole String.
	protected pending: Array<Token>
	// How many queued Tokens have been handed out, since `shift()` would
	// re-copy the queue each time.
	protected pendingIndex: number
	// Collected rather than thrown. The caller reads them once lexing is done.
	public errors: Array<LexingError>
	// The String Literal that closed most recently, for `swallowedTheLinesBelow`.
	// Four numbers rather than a `ClosedString`, since every String closes and
	// only a failing file asks. A zero line means none has closed yet.
	protected closedStringOpenedLine: number
	protected closedStringOpenedColumn: number
	protected closedStringClosedLine: number
	protected closedStringClosedColumn: number
	// Every hole being read, innermost last. A quote is recorded once a String
	// opens inside the hole.
	protected openHoles: Array<{ brace: Cursor; quote: Cursor | null }>

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
		this.openHoles = []
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
		this.openHoles = []
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

	// The Token standing at `index`, or `undefined` at the end of the input.
	// An interpolated String appends the Tokens after its head to `extra`, so
	// a String inside a hole nests without a special case.
	protected lexToken(extra: Array<Token>): Token | undefined {
		let data = this.data

		while (true) {
			// Whitespace never becomes a Token.
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
			// An ignored Token takes its errors with it: nobody should be told
			// about a class nobody reads.
			let errorMark = this.errors.length
			let token: Token

			// An ignored line break or Comment is skipped without being built,
			// since they are a large share of every file's Tokens.
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
				// String Tokens are never ignored, so they skip the ignore
				// filter.
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

	// Steps over a Comment whose type is ignored, and answers whether it did.
	// The type depends on the second sigil, which makes it a `DocComment`.
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

	// Where the Comment starting at `index` ends. A `\r` ends it too, so a
	// Comment on a Windows line ending does not carry one.
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

		// A Comment holds no line break, so its whole span is columns.
		this.column += end - start
		this.index = end

		return {
			value,
			// Doubling the sigil turns a private note into Documentation.
			// The two lex identically, and only the Token type differs.
			type: value.startsWith(documentationLiteral)
				? TokenType.DocComment
				: TokenType.Comment,
			position: { start: startCursor, end: this.cursor() },
			start,
			end,
		}
	}

	// A Number Literal is digits only, so `0xFF` and `1e5` are wrong. Letters
	// are read into the Literal and reported as one malformed Number, while the
	// Token keeps only the leading digits. See "Number Literals" in DEVELOPMENT.md.
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
				// A Number ends at a character another language writes an
				// operator with, such as the `+` of `1+2`. The Parser answers it
				// where it stands.
				if (foreignPunctuation.has(data[end] as string)) {
					break
				}

				if (digitsEnd === -1) {
					digitsEnd = end
				}
			}

			end++
		}

		// `endsWord` stops a Number at a line break, so its span is columns.
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

		// The Comment and String sigils end an Identifier as a Symbol does:
		// `name§ note` is a name and a Comment, not an Identifier `name§`.
		while (end < data.length) {
			if ((classOfCode(data.charCodeAt(end)) & endsWord) !== 0) {
				break
			}

			end++
		}

		// An Identifier holds no line break, so its span is columns.
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

	// A String that never closes takes the errors and hole Tokens found inside
	// it along. Everything after its opening quote was never a String, so the
	// only report is that it is never closed.
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

	// A String Literal without a `{…}` hole is one `LiteralString` Token. A
	// hole makes it interpolated: `LiteralStringStart`, each hole's Tokens from
	// `lexToken`, `LiteralStringMiddle` between holes, and `LiteralStringEnd`.
	// The head is returned and the rest go to `extra`.
	protected lexStringChunks(extra: Array<Token>): Token {
		let stringStart = this.cursor()
		let stringStartOffset = this.index
		let hole = this.openHoles.at(-1) ?? null

		this.index++
		this.column++

		let firstChunk = this.scanStringChunk()

		if (firstChunk.terminator === "eof") {
			this.throwUnterminatedString(this.cursor(), stringStart, hole)
		}

		if (firstChunk.terminator === "quote") {
			this.noteClosedString(stringStart, hole)

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
			// The hole ends at the first `SymbolRightBrace` at depth zero. A
			// nested String's braces live inside its own Tokens, so they never
			// reach the count.
			let depth = 0

			this.openHoles.push({
				brace: { line: this.line, column: this.column - 1 },
				quote: null,
			})

			while (true) {
				// A Comment in a hole would run to the end of its line, past the
				// hole's `}` and the closing quote. It is reported and read as
				// ending at the first `}`, so the String still lexes.
				this.skipHoleWhitespace()

				if (
					this.index < this.data.length &&
					this.data.charCodeAt(this.index) === commentLiteralCode
				) {
					this.reportCommentInHole()

					continue
				}

				// Taken before the read, which walks over trailing whitespace;
				// the report is about where the String ran out.
				let beforeToken = this.cursor()
				let extraStart = extra.length
				let holeToken = this.lexToken(extra)

				if (holeToken === undefined) {
					this.throwUnterminatedString(beforeToken, stringStart, hole)
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

				// A nested interpolated String appended its tail to `extra`
				// already, so its head goes in front of that tail.
				if (extra.length > extraStart) {
					extra.splice(extraStart, 0, holeToken!)
				} else {
					extra.push(holeToken!)
				}
			}

			this.openHoles.pop()

			let chunkStart = this.cursor()
			let chunkStartOffset = this.index
			let chunk = this.scanStringChunk()

			if (chunk.terminator === "eof") {
				this.throwUnterminatedString(this.cursor(), stringStart, hole)
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
				this.noteClosedString(stringStart, hole)

				break
			}
		}

		return head
	}

	// Called once the closing quote is consumed, so the quote is the
	// character before the Lexer's Cursor.
	protected noteClosedString(
		openedAt: Cursor,
		hole: { quote: Cursor | null } | null,
	): void {
		// A String in a hole that closes on a later line opened at the quote
		// meant to close the String around it. See "A quote inside a hole" in
		// DEVELOPMENT.md.
		if (hole !== null && this.line !== openedAt.line) {
			hole.quote ??= openedAt
		}

		this.closedStringOpenedLine = openedAt.line
		this.closedStringOpenedColumn = openedAt.column
		this.closedStringClosedLine = this.line
		this.closedStringClosedColumn = this.column - 1
	}

	// Whitespace only. A line break inside a hole is a Token like any other,
	// left to `lexToken` and the ignore list.
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

	// Reads one run of String text, decoding escapes. It ends past a closing
	// `"` or an unescaped `{` that opens a hole, or at the end of the input.
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

				// A backslash with nothing after it is the input running out
				// mid-String, which the caller reports as unterminated.
				if (escaped === undefined) {
					break
				}

				decoded += data.slice(runStart, index)
				hasEscape = true

				// `\u` is the one escape longer than two characters, and
				// `readUnicodeEscape` reports its own problems.
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
					// The message is read on a terminal, where a control or
					// override character would act. A character that does not
					// print as itself is named instead of quoted.
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

	// `\u{1F600}`: one to six hexadecimal digits in braces, naming one Unicode
	// scalar value. A refused escape contributes no character, and the scan stops
	// before what ends the literal. See "Unicode escapes" in DEVELOPMENT.md.
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
			// A high half directly followed by its low half is one mistake,
			// refused as one, so the Help rewrites the whole span it underlines.
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

	// `\u001B` and `\u1B`, the JavaScript and JSON habit without braces. The
	// Help spells the character the reader wrote, taking digits as JavaScript
	// does. See "Unbraced escapes" in DEVELOPMENT.md.
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

	// The low half of a surrogate pair directly at `index`, in either
	// spelling, since the halves of `\uD83D\u{DE00}` need not agree. The caller
	// resumes at `end`. See "Unbraced escapes" in DEVELOPMENT.md.
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

	// `\u{1B`: the reading ran into something that ends the literal. The span
	// stops short of that character, so a closing quote or hole still reads.
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

	// One refusal of a `\u{…}`. The report covers the escape as far as it was
	// read, and the reading resumes at `end`. The scan stops at a line break,
	// so the span is on one line.
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

	protected throwUnterminatedString(
		cursor: Cursor,
		openedAt: Cursor,
		hole: { brace: Cursor; quote: Cursor | null } | null,
	): never {
		throw new UnterminatedStringError(
			cursor,
			openedAt,
			this.swallowedTheLinesBelow(openedAt),
			hole === null
				? null
				: { brace: hole.brace, quote: hole.quote ?? openedAt },
		)
	}

	// The String that spanned lines and closed on the line where the unclosed
	// one opens, the likelier one to be missing its quote.
	// See "Which quote is missing" in DEVELOPMENT.md.
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
