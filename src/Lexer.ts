/// <reference path="../typings/index.d.ts" />

import { lexer } from './interfaces'

type IToken   = lexer.IToken
type Position = lexer.Position

type LexingResult = {
	input: string
	token: IToken
	position: Position
}

const stringLiteral   = '\''
const numberLiterals  = ['0', '1', '2', '3', '4', '5', '6', '7', '8', '9']
const booleanLiterals = ['true', 'false']
const commentLiteral  = '§'
const keywords        = ['let', 'if', 'else', 'type']
const delimiters      = ['@', '(', ')', '{', '}', ',', '.', ':', '=', '-', '>', '<', '_']

let handlePosition = (char: string, position: Position): Position => {
	position = {
		line: position.line,
		column: position.column,
	}

	if (char === '\n') {
		position.column = 1
		position.line++
	} else {
		position.column++
	}

	return position
}

let lexString = (input: string, position: Position): LexingResult => {
	let token: IToken = {
		content: '',
		tokenType: 'String',
		position,
	}

	let inputSliced = false
	let balance = 0
	let balanceWasChanged = false

	for (let i = 0; i < input.length; i++) {
		token.content += input[i]

		position = handlePosition(input[i], position)

		if (token.content.startsWith(stringLiteral) && token.content.length === 1) {
			balanceWasChanged = true
			balance++
			continue
		}

		if (token.content.endsWith(stringLiteral)) {
			balance--
		}

		if (balanceWasChanged && balance === 0) {
			token.content = token.content.slice(1, token.content.length - 1)
			input = input.slice(i)
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

let lexComment = (input: string, position: Position): LexingResult => {
	let token: IToken = {
		content: '',
		tokenType: null,
		position,
	}

	let i: number

	for (i = 0; i < input.length; i++) {
		token.content += input[i]

		position = handlePosition(input[i], position)

		if (token.content.endsWith('\n') || i + 1 === input.length) {
			token.tokenType = 'Comment'
			break
		}
	}

	input = input.slice(i)

	return {
		input,
		token,
		position,
	}
}

let lexNumber = (input: string, position: Position): LexingResult => {
	let token: IToken = {
		content: '',
		tokenType: 'Number',
		position: {
			line: position.line,
			column: position.column - 1
		}
	}

	let i = 0
	let foundDot = false

	while (!!~numberLiterals.indexOf(input[i]) || !!~['_', '.'].indexOf(input[i])) {
		if (input[i] === '.') {
			if (foundDot) {
				i--
				break
			} else {
				foundDot = true
			}
		}

		if (input[i] !== '_') {
			token.content += input[i]
		}

		position = handlePosition(input[i], position)
		i++
	}

	input = input.slice(i)

	return {
		input,
		token,
		position,
	}
}

let lexKeyword = (token: IToken): IToken => {
	if (~keywords.indexOf(token.content)) {
		token.tokenType = 'Keyword'
	}

	return token
}

let lexBoolean = (token: IToken): IToken => {
	if (~booleanLiterals.indexOf(token.content)) {
		token.tokenType = 'Boolean'
	}

	return token
}

let lexToken = (input: string, position: Position): LexingResult => {
	let token: IToken = {
		content: '',
		tokenType: null,
		position,
	}

	let i: number

	for (i = 0; i < input.length; i++) {
		token.content += input[i]

		// special handling for linebreaks requires us
		// to handle it before handling linenumbers potentially
		if (input[i] === '\n') {
			if (token.content.startsWith('\n')) {
				position = handlePosition(input[i], position)
				token.tokenType = 'Linebreak'
				break
			} else {
				i--
				token.content = token.content.slice(0, -1)
				token.tokenType = 'Identifier'
				break
			}
		}

		position = handlePosition(input[i], position)

		if (!!~delimiters.indexOf(token.content)) {
			token.tokenType = 'Delimiter'
			break
		}

		if (i > 0 && !!~delimiters.indexOf(input[i])) {
			i--
			token.content = token.content.slice(0, -1)
			token.tokenType = 'Identifier'
			break
		}

		if (token.content.startsWith(commentLiteral)) {
			; ({ input, token, position } = lexComment(input, position))
			break
		}

		if (token.content.startsWith(stringLiteral)) {
			; ({ input, token, position } = lexString(input, position))
			break
		}

		if (!!~numberLiterals.indexOf(token.content[0])) {
			; ({ input, token, position } = lexNumber(input, position))
			break
		}

		if (input[i] === ' ' || input[i] === '\t') {
			if (token.content === input[i]) {
				token.content = ''
				i--
				input = input.slice(1)
			} else {
				token.content = token.content.slice(0, token.content.length - 1)
				token.tokenType = 'Identifier'
				break
			}
		}
	}

	// Handle EOF
	if (token.tokenType === null) {
		token.tokenType = 'Identifier'
	}

	// Check if we found a keyword or boolean
	if (token.tokenType === 'Identifier') {
		token = lexKeyword(token)
		token = lexBoolean(token)
	}

	input = input.slice(i + 1)

	return {
		input,
		token,
		position,
	}
}

export let lex = (input: string, position: Position = { line: 1, column: 1, }): Array<IToken> => {
	let tokens: Array<IToken> = []

	while (input) {
		let token: IToken

		; ({ input, token, position, } = lexToken(input, position))

		// Dont save comments since they are useless in parsing
		if (token.tokenType === 'Comment') {
			continue
		}

		// ignore multiple linebreaks
		if (token.content === '\n') {
			if (tokens.length && tokens[tokens.length - 1].tokenType === 'Linebreak') {
				continue
			}
		}

		// Dont save empty tokens since they are useless in parsing
		if (token.content === '') {
			// Except Strings, as they may legally be empty
			if (token.tokenType !== 'String') {
				continue
			}
		}

		tokens.push(token)
	}

	return tokens
}
