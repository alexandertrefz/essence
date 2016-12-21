/// <reference path="../typings/index.d.ts" />

import { IToken, } from './Interfaces'

type position = {
	column: number
	line: number
}

type lexingResult = {
	line: number
	column: number
	input: string
	token: IToken
}

const stringLiteral   = '\''
const booleanLiterals = ['true', 'false']
const commentLiteral  = '§'
const keywords        = ['let', 'if', 'else', 'type']
const delimiters      = ['@', '(', ')', '{', '}', ',', '.', ':', '=', '-', '>', '<', '_']

let handleLineNumberAndCollumn = (char: string, line: number, column: number): position => {
	if (char === '\n') {
		column = 1
		line++
	} else {
		column++
	}

	return {
		line,
		column,
	}
}

let lexString = (input: string, line: number, column: number): lexingResult => {
	let token: IToken = {
		content: '',
		tokenType: 'String',
		line,
		column,
	}

	let inputSliced = false
	let balance = 0
	let balanceWasChanged = false

	for (let i = 0; i < input.length; i++) {
		token.content += input[i]

		; ({ line, column, } = handleLineNumberAndCollumn(input[i], line, column))

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
		throw new Error(`String Token not closed at line: ${line}, column: ${column}`)
	}

	return {
		input,
		line,
		column,
		token,
	}
}

let lexComment = (input: string, line: number, column: number): lexingResult => {
	let token: IToken = {
		content: '',
		tokenType: null,
		line,
		column,
	}

	let i: number

	for (i = 0; i < input.length; i++) {
		token.content += input[i]

		; ({ line, column, } = handleLineNumberAndCollumn(input[i], line, column))

		if (token.content.endsWith('\n') || i + 1 === input.length) {
			token.tokenType = 'Comment'
			break
		}
	}

	input = input.slice(i)

	return {
		input,
		line,
		column,
		token,
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

let lexToken = (input: string, line: number, column: number): lexingResult => {
	let token: IToken = {
		content: '',
		tokenType: null,
		line,
		column,
	}

	let i: number

	for (i = 0; i < input.length; i++) {
		token.content += input[i]

		// special handling for linebreaks requires us
		// to handle it before handling linenumbers potentially
		if (input[i] === '\n') {
			if (token.content.startsWith('\n')) {
				; ({ line, column, } = handleLineNumberAndCollumn(input[i], line, column))
				token.tokenType = 'Linebreak'
				break
			} else {
				i--
				token.content = token.content.slice(0, -1)
				token.tokenType = 'Identifier'
				break
			}
		}

		; ({ line, column, } = handleLineNumberAndCollumn(input[i], line, column))

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
			; ({ input, line, column, token, } = lexComment(input, line, column))
			break
		}

		if (token.content.startsWith(stringLiteral)) {
			; ({ input, line, column, token, } = lexString(input, line, column))
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
		line,
		column,
		token,
	}
}

export let lex = (input: string, line: number = 1, column: number = 1): Array<IToken> => {
	let tokens: IToken[] = []

	while (input) {
		let token: IToken

		; ({ input, line, column, token, } = lexToken(input, line, column))

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
