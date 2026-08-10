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

// NOTE: `extraTokens` and `errors` carry the tail of a String that interpolated
// into several Tokens — the head Token rides in `token`, its `Start`/`Middle`/
// `End` chunk Tokens and the holes' own Tokens follow in `extraTokens`, and any
// bad escapes it held in `errors`. Every non-String Token leaves both empty, so
// the ordinary path is untouched.
type SubLexingResult = {
	input: string
	token: Token
	cursor: Cursor
	error?: LexingError
	extraTokens?: Array<Token>
	errors?: Array<LexingError>
}

type LexingResult = {
	input: string
	token: Token | undefined
	cursor: Cursor
	error?: LexingError
	extraTokens?: Array<Token>
	errors?: Array<LexingError>
}

const createIsHelper = (tester: string | Array<string>) => {
	if (typeof tester === "string") {
		return (input: string): boolean => tester === input
	}

	// NOTE: The candidate set is fixed at construction, so membership is a
	// Set lookup rather than a scan of the Array on every character lexed.
	let candidates = new Set(tester)

	return (input: string): boolean => candidates.has(input)
}

const orHelper = (
	funcs: Array<(input: string) => boolean>,
	input: string,
): boolean => {
	for (let func of funcs) {
		if (func(input)) {
			return true
		}
	}

	return false
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
// part of an Identifier, a Number or a Comment. `\uFEFF` is here for the
// same reason: a byte order mark is invisible whitespace, not the first
// letter of `implementation`.
const whitespaces = [" ", "\t", "\r", "\uFEFF"]

const isWhitespace = createIsHelper(whitespaces)
const isLinebreak = createIsHelper(linebreak)
const isSymbol = createIsHelper(symbols)
const isKeyword = createIsHelper(keywords)
const isBooleanLiteral = createIsHelper(booleans)
const isStringLiteral = createIsHelper(stringLiteral)
const isNumberLiteral = createIsHelper(numbers)
const isCommentLiteral = createIsHelper(commentLiteral)

const getBooleanType = (value: string) => {
	if (value === "true") {
		return TokenType.LiteralTrue
	} else {
		// Pleasing istanbul here
		/* istanbul ignore else */
		if (value === "false") {
			return TokenType.LiteralFalse
		} else {
			throw new Error(`${value} is not a valid value for BooleanLiterals`)
		}
	}
}

const getKeywordType = (value: string) => {
	if (value === "if") {
		return TokenType.KeywordIf
	} else if (value === "else") {
		return TokenType.KeywordElse
	} else if (value === "type") {
		return TokenType.KeywordType
	} else if (value === "variable") {
		return TokenType.KeywordVariable
	} else if (value === "constant") {
		return TokenType.KeywordConstant
	} else if (value === "function") {
		return TokenType.KeywordFunction
	} else if (value === "implementation") {
		return TokenType.KeywordImplementation
	} else if (value === "overload") {
		return TokenType.KeywordOverload
	} else if (value === "match") {
		return TokenType.KeywordMatch
	} else if (value === "case") {
		return TokenType.KeywordCase
	} else if (value === "with") {
		return TokenType.KeywordWith
	} else if (value === "namespace") {
		return TokenType.KeywordNamespace
	} else if (value === "protocol") {
		return TokenType.KeywordProtocol
	} else if (value === "for") {
		return TokenType.KeywordFor
	} else if (value === "infer") {
		return TokenType.KeywordInfer
	} else if (value === "choice") {
		return TokenType.KeywordChoice
	} else if (value === "import") {
		return TokenType.KeywordImport
	} else if (value === "export") {
		return TokenType.KeywordExport
	} else if (value === "from") {
		return TokenType.KeywordFrom
	} else if (value === "as") {
		return TokenType.KeywordAs
	} else {
		// Pleasing istanbul here
		/* istanbul ignore else */
		if (value === "static") {
			return TokenType.KeywordStatic
		} else {
			throw new Error(`${value} is not a valid value for Keywords`)
		}
	}
}

const getSymbolType = (value: string) => {
	if (value === "@") {
		return TokenType.SymbolAt
	} else if (value === "(") {
		return TokenType.SymbolLeftParen
	} else if (value === ")") {
		return TokenType.SymbolRightParen
	} else if (value === "{") {
		return TokenType.SymbolLeftBrace
	} else if (value === "}") {
		return TokenType.SymbolRightBrace
	} else if (value === "[") {
		return TokenType.SymbolLeftBracket
	} else if (value === "]") {
		return TokenType.SymbolRightBracket
	} else if (value === "|") {
		return TokenType.SymbolPipe
	} else if (value === "/") {
		return TokenType.SymbolSlash
	} else if (value === ",") {
		return TokenType.SymbolComma
	} else if (value === ".") {
		return TokenType.SymbolDot
	} else if (value === ":") {
		return TokenType.SymbolColon
	} else if (value === "=") {
		return TokenType.SymbolEqual
	} else if (value === "-") {
		return TokenType.SymbolDash
	} else if (value === ">") {
		return TokenType.SymbolRightAngle
	} else if (value === "<") {
		return TokenType.SymbolLeftAngle
	} else if (value === "_") {
		return TokenType.SymbolUnderscore
	} else if (value === "#") {
		return TokenType.SymbolHash
	} else {
		// Pleasing istanbul here
		/* istanbul ignore else */
		if (value === "~") {
			return TokenType.SymbolTilde
		} else {
			throw new Error(`${value} is not a valid value for Symbols`)
		}
	}
}

const isEOF = (input: string, index: number): boolean =>
	input.length - 1 === index

const moveCursor = (char: string, cursor: Cursor): Cursor => {
	cursor = {
		line: cursor.line,
		column: cursor.column,
	}

	if (char === "\n") {
		cursor.column = 1
		cursor.line++
	} else {
		cursor.column++
	}

	return cursor
}

const lexLinebreak = (input: string, cursor: Cursor): SubLexingResult => {
	const firstChar = input[0]

	const startCursor = cursor
	const endCurser = moveCursor(firstChar, cursor)

	const token: Token = {
		value: firstChar,
		type: TokenType.Linebreak,
		position: {
			start: startCursor,
			end: endCurser,
		},
	}

	cursor = moveCursor(firstChar, cursor)
	input = input.slice(1)

	return {
		input,
		token,
		cursor: endCurser,
	}
}

const lexSymbol = (input: string, cursor: Cursor): SubLexingResult => {
	const firstChar = input[0]

	const startCursor = cursor
	const endCurser = moveCursor(firstChar, cursor)

	const token: Token = {
		value: firstChar,
		type: getSymbolType(firstChar),
		position: {
			start: startCursor,
			end: endCurser,
		},
	}

	cursor = moveCursor(firstChar, cursor)
	input = input.slice(1)

	return {
		input,
		token,
		cursor: endCurser,
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

const interpolationStart = "{"

type ChunkTerminator = "quote" | "hole" | "eof"

type ChunkResult = {
	value: string
	input: string
	cursor: Cursor
	terminator: ChunkTerminator
	errors: Array<LexingError>
}

// NOTE: Reads one run of literal String text, decoding escapes into `value`,
// and stops at the character that ends the run: the closing `"` (`quote`), an
// unescaped `{` opening a hole (`hole`), or the end of the input (`eof`, which
// the caller turns into the fatal unterminated-String throw). The terminating
// character is consumed — the returned `input`/`cursor` sit just past it.
const scanStringChunk = (input: string, cursor: Cursor): ChunkResult => {
	let value = ""
	let errors: Array<LexingError> = []

	for (let i = 0; i < input.length; i++) {
		let char = input[i]

		if (char === stringLiteral) {
			return {
				value,
				input: input.slice(i + 1),
				cursor: moveCursor(char, cursor),
				terminator: "quote",
				errors,
			}
		}

		if (char === interpolationStart) {
			return {
				value,
				input: input.slice(i + 1),
				cursor: moveCursor(char, cursor),
				terminator: "hole",
				errors,
			}
		}

		if (char === "\\") {
			let escaped = input[i + 1]

			// NOTE: A backslash with nothing after it is the input running out
			// mid-String — let the loop fall through to the `eof` return, which
			// the caller reports as an unterminated String.
			if (escaped === undefined) {
				break
			}

			let escapeStart = cursor
			cursor = moveCursor(char, cursor)
			cursor = moveCursor(escaped, cursor)

			let decoded = stringEscapes[escaped]

			if (decoded === undefined) {
				errors.push({
					message: `'\\${escaped}' is not a valid escape`,
					position: { start: escapeStart, end: cursor },
					code: "invalid-escape",
				})
				value += escaped
			} else {
				value += decoded
			}

			i++
			continue
		}

		value += char
		cursor = moveCursor(char, cursor)
	}

	return { value, input: "", cursor, terminator: "eof", errors }
}

const throwUnterminatedString = (cursor: Cursor, openedAt: Cursor): never => {
	throw new UnterminatedStringError(cursor, openedAt)
}

// NOTE: A String Literal reads as one `LiteralString` Token when it holds no
// `{…}` hole, exactly as before. A hole makes it interpolated: the text before
// the first hole becomes a `LiteralStringStart` Token, each hole's own Tokens
// are lexed in place (by driving `lexToken`, so a nested String, Record or even
// a nested interpolation inside a hole needs no special case), the text between
// holes becomes `LiteralStringMiddle` and the text after the last hole becomes
// `LiteralStringEnd`. The head Token rides in `token`; the rest follow in
// `extraTokens`, which the Lexer drains before it lexes anything more.
const lexString = (
	input: string,
	cursor: Cursor,
	ignoreList: Array<string>,
): SubLexingResult => {
	let stringStart = cursor

	// Consume the opening quote.
	cursor = moveCursor(input[0], cursor)
	input = input.slice(1)

	let firstChunk = scanStringChunk(input, cursor)
	input = firstChunk.input
	cursor = firstChunk.cursor

	if (firstChunk.terminator === "eof") {
		throwUnterminatedString(cursor, stringStart)
	}

	if (firstChunk.terminator === "quote") {
		return {
			input,
			token: {
				value: firstChunk.value,
				type: TokenType.LiteralString,
				position: { start: stringStart, end: cursor },
			},
			cursor,
			errors:
				firstChunk.errors.length > 0 ? firstChunk.errors : undefined,
		}
	}

	let tokens: Array<Token> = [
		{
			value: firstChunk.value,
			type: TokenType.LiteralStringStart,
			position: { start: stringStart, end: cursor },
		},
	]
	let errors: Array<LexingError> = [...firstChunk.errors]

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
			while (input.length > 0 && isWhitespace(input[0])) {
				cursor = moveCursor(input[0], cursor)
				input = input.slice(1)
			}

			if (isCommentLiteral(input[0])) {
				let commentStart = cursor
				let commentLength = 0

				while (
					commentLength < input.length &&
					!isLinebreak(input[commentLength]) &&
					input[commentLength] !== "}"
				) {
					cursor = moveCursor(input[commentLength], cursor)
					commentLength++
				}

				errors.push({
					message:
						"A Comment can not be written inside an interpolation hole",
					position: { start: commentStart, end: cursor },
					code: "comment-in-hole",
				})

				input = input.slice(commentLength)

				continue
			}

			let holeResult = lexToken(input, cursor, ignoreList)

			if (holeResult.token === undefined) {
				throwUnterminatedString(cursor, stringStart)
				return { input, token: tokens[0], cursor }
			}

			input = holeResult.input
			cursor = holeResult.cursor

			if (holeResult.error !== undefined) {
				errors.push(holeResult.error)
			}
			if (holeResult.errors !== undefined) {
				errors.push(...holeResult.errors)
			}

			if (
				holeResult.token.type === TokenType.SymbolRightBrace &&
				depth === 0
			) {
				break
			}

			if (holeResult.token.type === TokenType.SymbolLeftBrace) {
				depth++
			} else if (holeResult.token.type === TokenType.SymbolRightBrace) {
				depth--
			}

			tokens.push(holeResult.token)

			if (holeResult.extraTokens !== undefined) {
				tokens.push(...holeResult.extraTokens)
			}
		}

		let chunkStart = cursor
		let chunk = scanStringChunk(input, cursor)
		input = chunk.input
		cursor = chunk.cursor
		errors.push(...chunk.errors)

		if (chunk.terminator === "eof") {
			throwUnterminatedString(cursor, stringStart)
		}

		if (chunk.terminator === "quote") {
			tokens.push({
				value: chunk.value,
				type: TokenType.LiteralStringEnd,
				position: { start: chunkStart, end: cursor },
			})
			break
		}

		tokens.push({
			value: chunk.value,
			type: TokenType.LiteralStringMiddle,
			position: { start: chunkStart, end: cursor },
		})
	}

	return {
		input,
		token: tokens[0],
		cursor,
		extraTokens: tokens.slice(1),
		errors: errors.length > 0 ? errors : undefined,
	}
}

const lexComment = (input: string, cursor: Cursor): SubLexingResult => {
	let token: Token = {
		value: "",
		type: TokenType.Comment,
		position: {
			start: cursor,
			end: cursor,
		},
	}

	let i: number

	for (i = 0; i < input.length; i++) {
		let currentChar = input[i]

		if (isLinebreak(currentChar) || currentChar === "\r") {
			i--
			break
		}

		token.value += currentChar
		cursor = moveCursor(currentChar, cursor)

		if (isEOF(input, i)) {
			break
		}
	}

	input = input.slice(i + 1)
	token.position.end = cursor

	// NOTE: Doubling the sigil turns a private note into Documentation of
	// whatever is declared below it. The distinction is made here rather than
	// by a separate sub-lexer because the two are lexed identically — only the
	// Token type differs, and only the Parser cares.
	if (token.value.startsWith(documentationLiteral)) {
		token.type = TokenType.DocComment
	}

	return {
		input,
		token,
		cursor,
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
const lexNumber = (input: string, cursor: Cursor): SubLexingResult => {
	let token: Token = {
		value: "",
		type: TokenType.LiteralNumber,
		position: {
			start: cursor,
			end: cursor,
		},
	}

	let lexeme = ""
	let sawNonDigit = false
	let i: number

	for (i = 0; i < input.length; i++) {
		let currentChar = input[i]

		if (
			orHelper(
				[
					isLinebreak,
					isSymbol,
					isCommentLiteral,
					isStringLiteral,
					isWhitespace,
				],
				currentChar,
			)
		) {
			i-- // Fix Index for the token slice
			break
		}

		if (isNumberLiteral(currentChar)) {
			if (!sawNonDigit) {
				token.value += currentChar
			}
		} else {
			sawNonDigit = true
		}

		lexeme += currentChar
		cursor = moveCursor(currentChar, cursor)

		if (isEOF(input, i)) {
			break
		}
	}

	input = input.slice(i + 1)
	token.position.end = cursor

	if (!sawNonDigit) {
		return {
			input,
			token,
			cursor,
		}
	}

	return {
		input,
		token,
		cursor,
		error: {
			message: `'${lexeme}' is not a valid Number`,
			position: token.position,
			code: "invalid-number",
		},
	}
}

const lexIdentifier = (input: string, cursor: Cursor): SubLexingResult => {
	const token: Token = {
		value: "",
		type: TokenType.Identifier,
		position: {
			start: cursor,
			end: cursor,
		},
	}

	let i: number

	for (i = 0; i < input.length; i++) {
		let currentChar = input[i]

		// NOTE: The Comment and String sigils end an Identifier exactly as a
		// Symbol does — `name§ note` is a name and a Comment written flush
		// against each other, not an Identifier called `name§`.
		if (
			orHelper(
				[
					isSymbol,
					isLinebreak,
					isWhitespace,
					isCommentLiteral,
					isStringLiteral,
				],
				currentChar,
			)
		) {
			i--
			break
		}

		cursor = moveCursor(currentChar, cursor)
		token.value += currentChar

		if (isEOF(input, i)) {
			break
		}
	}

	input = input.slice(i + 1)
	token.position.end = cursor

	return {
		input,
		token,
		cursor,
	}
}

const lexToken = (
	input: string,
	cursor: Cursor,
	ignoreList: Array<string>,
): LexingResult => {
	let token: Token | undefined
	let error: LexingError | undefined
	let extraTokens: Array<Token> | undefined
	let errors: Array<LexingError> | undefined

	if (input.length === 0) {
		return {
			input,
			cursor,
			token: undefined,
		}
	}

	let firstChar = input[0]

	if (isWhitespace(firstChar)) {
		return lexToken(
			input.slice(1),
			moveCursor(firstChar, cursor),
			ignoreList,
		)
	}

	if (isLinebreak(firstChar)) {
		;({ input, token, cursor } = lexLinebreak(input, cursor))
	} else if (isSymbol(firstChar)) {
		;({ input, token, cursor } = lexSymbol(input, cursor))
	} else if (isCommentLiteral(firstChar)) {
		;({ input, token, cursor } = lexComment(input, cursor))
	} else if (isStringLiteral(firstChar)) {
		;({ input, token, cursor, extraTokens, errors } = lexString(
			input,
			cursor,
			ignoreList,
		))
	} else if (isNumberLiteral(firstChar)) {
		;({ input, token, cursor, error } = lexNumber(input, cursor))
	} else {
		;({ input, token, cursor } = lexIdentifier(input, cursor))

		if (isKeyword(token.value)) {
			token.type = getKeywordType(token.value)
		} else if (isBooleanLiteral(token.value)) {
			token.type = getBooleanType(token.value)
		}
	}

	// NOTE: A String's head Token can be an ignored type only never — the
	// `Start`/`LiteralString` types are never on an ignore list — so its
	// `extraTokens` never need the ignore filter here either.
	if (ignoreList.includes(token.type)) {
		return lexToken(input, cursor, ignoreList)
	}

	return {
		input,
		token,
		cursor,
		error,
		extraTokens,
		errors,
	}
}

export class Lexer {
	protected data: string
	protected index: number
	protected state: Cursor
	protected ignoreList: Array<string>
	// NOTE: An interpolated String lexes into several Tokens at once — its head
	// is returned, and its chunk and hole Tokens wait here to be handed out one
	// per `next()` before any more input is read. Every other Token leaves this
	// empty. `index`/`state` already sit past the whole String while these
	// drain, so a queued Token advances neither.
	protected pending: Array<Token>
	// NOTE: Collected rather than thrown — see `LexingError`. The caller reads
	// them once lexing is done; `reset` starts a new input with none.
	public errors: Array<LexingError>

	constructor() {
		this.data = ""
		this.index = 0
		this.state = { line: 1, column: 1 }
		this.ignoreList = []
		this.pending = []
		this.errors = []
	}

	reset(data: string, state: Cursor = { line: 1, column: 1 }) {
		this.data = data
		this.index = 0
		this.state = state
		this.pending = []
		this.errors = []
	}

	next(): lexer.Token | undefined {
		let queued = this.pending.shift()

		if (queued !== undefined) {
			return queued
		}

		const data = this.data.slice(this.index)

		const { input, token, cursor, error, extraTokens, errors } = lexToken(
			data,
			this.state,
			this.ignoreList,
		)

		if (error !== undefined) {
			this.errors.push(error)
		}

		if (errors !== undefined) {
			this.errors.push(...errors)
		}

		if (extraTokens !== undefined) {
			this.pending.push(...extraTokens)
		}

		this.state = cursor
		this.index = this.data.length - input.length

		return token
	}

	save() {
		return this.state
	}

	ignore(name: lexer.TokenType) {
		this.ignoreList.push(name)
	}
}
