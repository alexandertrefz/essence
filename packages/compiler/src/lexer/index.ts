import { type common, lexer } from "@essence-lang/interfaces"

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
	code: "invalid-number" | "invalid-escape" | "comment-in-hole"
}

// NOTE: The one fatal Lexer error — after an unterminated String there is
// nothing left to lex. It carries the two Cursors the report needs: where the
// input ran out, and where the String that never closed was opened.
export class UnterminatedStringError extends Error {
	endOfInput: Cursor
	openedAt: Cursor

	constructor(endOfInput: Cursor, openedAt: Cursor) {
		super(
			`String Token not closed at line: ${endOfInput.line}, column: ${endOfInput.column}`,
		)
		this.endOfInput = endOfInput
		this.openedAt = openedAt
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
// part of an Identifier, a Number or a Comment. `﻿` is here for the
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
// does — `isDigit` is what a Number keeps, and `isWhitespace` is what the
// skipping loops eat.
//
// NOTE: Built from the same Arrays the constants above are, so the two
// spellings of one character class can not drift apart.
const endsWord = 1
const isDigit = 2
const isSpace = 4

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

function classOfCode(code: number): number {
	if (code < 128) {
		return characterClasses[code]!
	}

	return wideClasses.get(code) ?? 0
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
// brace is written now that a bare `{` opens an interpolation hole.
const stringEscapes: { [char: string]: string } = {
	'"': '"',
	"\\": "\\",
	n: "\n",
	r: "\r",
	t: "\t",
	"{": "{",
	"}": "}",
}

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

	constructor() {
		this.data = ""
		this.index = 0
		this.line = 1
		this.column = 1
		this.ignoreList = new Set()
		this.pending = []
		this.pendingIndex = 0
		this.errors = []
	}

	reset(data: string, state: Cursor = { line: 1, column: 1 }) {
		this.data = data
		this.index = 0
		this.line = state.line
		this.column = state.column
		this.pending = []
		this.pendingIndex = 0
		this.errors = []
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

			if ((characterClass & isDigit) === 0 && digitsEnd === -1) {
				digitsEnd = end
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

	// NOTE: A String Literal reads as one `LiteralString` Token when it holds no
	// `{…}` hole, exactly as before. A hole makes it interpolated: the text before
	// the first hole becomes a `LiteralStringStart` Token, each hole's own Tokens
	// are lexed in place (by driving `lexToken`, so a nested String, Record or even
	// a nested interpolation inside a hole needs no special case), the text between
	// holes becomes `LiteralStringMiddle` and the text after the last hole becomes
	// `LiteralStringEnd`. The head Token is returned; the rest are appended to
	// `extra`, which the Lexer drains before it lexes anything more.
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
				break
			}
		}

		return head
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
					this.errors.push({
						message: `'\\${escaped}' is not a valid escape`,
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

	protected throwUnterminatedString(cursor: Cursor, openedAt: Cursor): never {
		throw new UnterminatedStringError(cursor, openedAt)
	}

	// #endregion
}
