import { common, lexer } from "../interfaces"
import { Token as NearleyToken } from "nearley"
import { createIsHelper, orHelper } from "./helpers"

const TokenType = lexer.TokenType
type Token = lexer.Token
type Position = common.Position
type Cursor = common.Cursor

type SubLexingResult = {
	input: string
	token: Token
	cursor: Cursor
}

type LexingResult = {
	input: string
	token: Token | undefined
	cursor: Cursor
}

const linebreak = "\n"
const stringLiteral = '"'
const commentLiteral = "§"
const booleans = ["true", "false"]
const keywords = ["if", "else", "type", "constant", "variable", "function", "static"]
const symbols = ["(", ")", "{", "}", "[", "]", "<", ">", "|", "@", ",", ".", ":", "=", "-", "~", "_"]
const numbers = ["0", "1", "2", "3", "4", "5", "6", "7", "8", "9"]
const whitespaces = [" ", "\t"]

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

const isEOF = (input: string, index: number): boolean => input.length - 1 === index

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

const lexString = (input: string, cursor: Cursor): SubLexingResult => {
	let token: Token = {
		value: "",
		type: TokenType.LiteralString,
		position: {
			start: cursor,
			end: cursor,
		},
	}

	let inputSliced = false
	let balance = 0
	let balanceWasChanged = false

	for (let i = 0; i < input.length; i++) {
		token.value += input[i]

		cursor = moveCursor(input[i], cursor)

		if (token.value.startsWith(stringLiteral) && token.value.length === 1) {
			balanceWasChanged = true
			balance++
			continue
		}

		if (token.value.endsWith(stringLiteral)) {
			balance--
		}

		if (balanceWasChanged && balance === 0) {
			token.value = token.value.slice(1, token.value.length - 1)
			input = input.slice(i + 1)
			inputSliced = true
			break
		}
	}

	if (!inputSliced) {
		throw new Error(`String Token not closed at line: ${cursor.line}, column: ${cursor.column}`)
	}

	token.position.end = cursor

	return {
		input,
		token,
		cursor,
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

		if (isLinebreak(currentChar)) {
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

	return {
		input,
		token,
		cursor,
	}
}

const lexNumber = (input: string, cursor: Cursor): SubLexingResult => {
	let token: Token = {
		value: "",
		type: TokenType.LiteralNumber,
		position: {
			start: cursor,
			end: cursor,
		},
	}

	let i: number

	for (i = 0; i < input.length; i++) {
		let currentChar = input[i]

		if (orHelper([isLinebreak, isSymbol, isCommentLiteral], currentChar)) {
			i-- // Fix Index for the token slice
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

	return {
		input,
		token,
		cursor,
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

		if (orHelper([isSymbol, isLinebreak, isWhitespace], currentChar)) {
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

const lexToken = (input: string, cursor: Cursor, ignoreList: Array<string>): LexingResult => {
	let token: Token | undefined = undefined

	if (input.length === 0) {
		return {
			input,
			cursor,
			token: undefined,
		}
	}

	let firstChar = input[0]

	if (isWhitespace(firstChar)) {
		return lexToken(input.slice(1), moveCursor(firstChar, cursor), ignoreList)
	}

	if (isLinebreak(firstChar)) {
		;({ input, token, cursor } = lexLinebreak(input, cursor))
	} else if (isSymbol(firstChar)) {
		;({ input, token, cursor } = lexSymbol(input, cursor))
	} else if (isCommentLiteral(firstChar)) {
		;({ input, token, cursor } = lexComment(input, cursor))
	} else if (isStringLiteral(firstChar)) {
		;({ input, token, cursor } = lexString(input, cursor))
	} else if (isNumberLiteral(firstChar)) {
		;({ input, token, cursor } = lexNumber(input, cursor))
	} else {
		;({ input, token, cursor } = lexIdentifier(input, cursor))

		if (isKeyword(token.value)) {
			token.type = getKeywordType(token.value)
		} else if (isBooleanLiteral(token.value)) {
			token.type = getBooleanType(token.value)
		}
	}

	if (ignoreList.includes(token.type)) {
		return lexToken(input, cursor, ignoreList)
	}

	return {
		input,
		token,
		cursor,
	}
}

export class Lexer {
	protected data: string
	protected index: number
	protected state: Cursor
	protected ignoreList: Array<string>

	constructor() {
		this.data = ""
		this.index = 0
		this.state = { line: 1, column: 1 }
		this.ignoreList = []
	}

	reset(data: string, state: Cursor = { line: 1, column: 1 }) {
		this.data = data
		this.index = 0
		this.state = state
	}

	next(): lexer.Token | undefined {
		const data = this.data.slice(this.index)

		const { input, token, cursor } = lexToken(data, this.state, this.ignoreList)

		this.state = cursor
		this.index = this.data.length - input.length

		return token
	}

	save() {
		return this.state
	}

	// TODO: Implement formatError
	formatError(token: NearleyToken) {
		return ""
		// nb. this gets called after consuming the offending token,
		// so the culprit is index-1
		// var buffer = this.buffer;
		// if (typeof buffer === 'string') {
		// 	var nextLineBreak = buffer.indexOf('\n', this.index);
		// 	if (nextLineBreak === -1) nextLineBreak = buffer.length;
		// 	var line = buffer.substring(this.lastLineBreak, nextLineBreak)
		// 	var col = this.index - this.lastLineBreak;
		// 	message += " at line " + this.line + " col " + col + ":\n\n";
		// 	message += "  " + line + "\n"
		// 	message += "  " + Array(col).join(" ") + "^"
		// 	return message;
		// } else {
		// 	return message + " at index " + (this.index - 1);
		// }
	}

	has(name: string) {
		return name in TokenType
	}

	ignore(name: lexer.TokenType) {
		this.ignoreList.push(name)
	}
}
