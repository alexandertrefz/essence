import { common, lexer } from "../interfaces"
import { Token as NearleyToken } from "nearley"
import { createIsHelper, orHelper } from "./helpers"

const TokenType = lexer.TokenType
type Token = lexer.Token
type Position = common.Position

type SubLexingResult = {
	input: string
	token: Token
	position: Position
}

type LexingResult = {
	input: string
	token: Token | undefined
	position: Position
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

const updatePosition = (char: string, position: Position): Position => {
	position = {
		line: position.line,
		column: position.column,
	}

	if (char === "\n") {
		position.column = 1
		position.line++
	} else {
		position.column++
	}

	return position
}

const lexLinebreak = (input: string, position: Position): SubLexingResult => {
	const firstChar = input[0]

	const token: Token = {
		value: firstChar,
		type: TokenType.Linebreak,
		position,
	}

	position = updatePosition(firstChar, position)
	input = input.slice(1)

	return {
		input,
		token,
		position,
	}
}

const lexSymbol = (input: string, position: Position): SubLexingResult => {
	const firstChar = input[0]

	const token: Token = {
		value: firstChar,
		type: getSymbolType(firstChar),
		position,
	}

	position = updatePosition(firstChar, position)
	input = input.slice(1)

	return {
		input,
		token,
		position,
	}
}

const lexString = (input: string, position: Position): SubLexingResult => {
	let token: Token = {
		value: "",
		type: TokenType.LiteralString,
		position,
	}

	let inputSliced = false
	let balance = 0
	let balanceWasChanged = false

	for (let i = 0; i < input.length; i++) {
		token.value += input[i]

		position = updatePosition(input[i], position)

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
		throw new Error(`String Token not closed at line: ${position.line}, column: ${position.column}`)
	}

	return {
		input,
		token,
		position,
	}
}

const lexComment = (input: string, position: Position): SubLexingResult => {
	let token: Token = {
		value: "",
		type: TokenType.Comment,
		position,
	}

	let i: number

	for (i = 0; i < input.length; i++) {
		let currentChar = input[i]

		if (isLinebreak(currentChar)) {
			i--
			break
		}

		token.value += currentChar
		position = updatePosition(currentChar, position)

		if (isEOF(input, i)) {
			break
		}
	}

	input = input.slice(i + 1)

	return {
		input,
		token,
		position,
	}
}

const lexNumber = (input: string, position: Position): SubLexingResult => {
	let token: Token = {
		value: "",
		type: TokenType.LiteralNumber,
		position,
	}

	let i: number

	for (i = 0; i < input.length; i++) {
		let currentChar = input[i]

		if (orHelper([isLinebreak, isSymbol, isCommentLiteral], currentChar)) {
			i-- // Fix Index for the token slice
			break
		}

		token.value += currentChar
		position = updatePosition(currentChar, position)

		if (isEOF(input, i)) {
			break
		}
	}

	input = input.slice(i + 1)

	return {
		input,
		token,
		position,
	}
}

const lexIdentifier = (input: string, position: Position): SubLexingResult => {
	const token: Token = {
		value: "",
		type: TokenType.Identifier,
		position,
	}

	let i: number

	for (i = 0; i < input.length; i++) {
		let currentChar = input[i]

		if (orHelper([isSymbol, isLinebreak, isWhitespace], currentChar)) {
			i--
			break
		}

		position = updatePosition(currentChar, position)
		token.value += currentChar

		if (isEOF(input, i)) {
			break
		}
	}

	input = input.slice(i + 1)

	return {
		input,
		token,
		position,
	}
}

const lexToken = (input: string, position: Position, ignoreList: Array<string>): LexingResult => {
	let token: Token | undefined = undefined

	if (input.length === 0) {
		return {
			input,
			position,
			token: undefined,
		}
	}

	let firstChar = input[0]

	if (isWhitespace(firstChar)) {
		return lexToken(input.slice(1), updatePosition(firstChar, position), ignoreList)
	}

	if (isLinebreak(firstChar)) {
		;({ input, token, position } = lexLinebreak(input, position))
	} else if (isSymbol(firstChar)) {
		;({ input, token, position } = lexSymbol(input, position))
	} else if (isCommentLiteral(firstChar)) {
		;({ input, token, position } = lexComment(input, position))
	} else if (isStringLiteral(firstChar)) {
		;({ input, token, position } = lexString(input, position))
	} else if (isNumberLiteral(firstChar)) {
		;({ input, token, position } = lexNumber(input, position))
	} else {
		;({ input, token, position } = lexIdentifier(input, position))

		if (isKeyword(token.value)) {
			token.type = getKeywordType(token.value)
		} else if (isBooleanLiteral(token.value)) {
			token.type = getBooleanType(token.value)
		}
	}

	if (ignoreList.includes(token.type)) {
		return lexToken(input, position, ignoreList)
	}

	return {
		input,
		token,
		position,
	}
}

export class Lexer {
	protected data: string
	protected index: number
	protected state: Position
	protected ignoreList: Array<string>

	constructor() {
		this.data = ""
		this.index = 0
		this.state = { line: 1, column: 1 }
		this.ignoreList = []
	}

	reset(data: string, state: Position = { line: 1, column: 1 }) {
		this.data = data
		this.index = 0
		this.state = state
	}

	next(): lexer.Token | undefined {
		const data = this.data.slice(this.index)

		const { input, token, position } = lexToken(data, this.state, this.ignoreList)

		this.state = position
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
