import { TokenType, IToken, } from './Interfaces'

export class Lexer {
	static stringLiteral   = '\''
	static numberLiterals  = ['0', '1', '2', '3', '4', '5', '6', '7', '8', '9']
	static booleanLiterals = ['true', 'false']
	static commentLiteral  = '§'
	static keywords        = ['package', 'import', 'as', 'type', 'interface', 'let', 'each', 'in', 'do', 'end', 'return']
	static delimiters      = ['@', '(', ')', '{', '}', '[', ']', '<', '>', ',', '.', ':', '!', '=', '|', '&', '#', '-', '+', '*', '/']

	static _handleLineNumberAndCollumn(char: string, line: number, column: number) {
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

	static _lexString(input: string, line: number, column: number) {
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

			;({ line, column } = Lexer._handleLineNumberAndCollumn(input[i], line, column))

			if (token.content.startsWith(Lexer.stringLiteral) && token.content.length === 1) {
				balanceWasChanged = true
				balance++
				continue
			}

			if (token.content.endsWith(Lexer.stringLiteral)) {
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

	static _lexComment(input: string, line: number, column: number) {
		let token: IToken = {
			content: '',
			tokenType: null,
			line,
			column,
		}

		let i:number

		for (i = 0; i < input.length; i++) {
			token.content += input[i]

			;({ line, column } = Lexer._handleLineNumberAndCollumn(input[i], line, column))

			if (token.content.endsWith('\n')) {
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

	static _lexKeyword(token: IToken) {
		if (~Lexer.keywords.indexOf(token.content)) {
			token.tokenType = 'Keyword'
		}

		return token
	}

	static _lexToken(input: string, line: number, column: number) {
		let token: IToken = {
			content: '',
			tokenType: null,
			line,
			column,
		}

		let i:number

		for (i = 0; i < input.length; i++) {
			token.content += input[i]

			// special handling for linebreaks requires us
			// to handle it before handling linenumbers potentially
			if (input[i] === '\n') {
				if (token.content.startsWith('\n')) {
					;({ line, column } = Lexer._handleLineNumberAndCollumn(input[i], line, column))
					token.tokenType = 'Linebreak'
					break
				} else {
					i--
					token.content = token.content.slice(0, -1)
					token.tokenType = 'Identifier'
					break
				}
			}

			;({ line, column } = Lexer._handleLineNumberAndCollumn(input[i], line, column))

			if (!!~Lexer.delimiters.indexOf(token.content)) {
				token.tokenType = 'Delimiter'
				break
			}

			if (i > 0 && !!~Lexer.delimiters.indexOf(input[i])) {
				i--
				token.content = token.content.slice(0, -1)
				token.tokenType = 'Identifier'
				break
			}

			if (token.content.startsWith(Lexer.commentLiteral)) {
				;({ input, line, column, token } = Lexer._lexComment(input, line, column))
				break
			}

			if (token.content.startsWith(Lexer.stringLiteral)) {
				;({ input, line, column, token } = Lexer._lexString(input, line, column))
				break
			}

			if (input[i] === ' ' || input[i] === '\t') {
				if (token.content.startsWith(' ') || token.content.startsWith('\t')) {
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

		// Check if we found a boolean
		if (token.tokenType === 'Identifier' && !!~Lexer.booleanLiterals.indexOf(token.content)) {
			token.tokenType = 'Boolean'
		}

		// Check if we found a keyword
		if (token.tokenType === 'Identifier') {
			token = Lexer._lexKeyword(token)
		}

		input = input.slice(i + 1)

		return {
			input,
			line,
			column,
			token,
		}
	}

	static _cleanTokenEnd(token: IToken) {
		// Ensure that the line-number stays correct
		let i = 0
		while (token.content[i] === ' ' || token.content[i] === '\n' || token.content[i] === '\t') {
			;({
				line: token.line,
				column: token.column
			} = Lexer._handleLineNumberAndCollumn(token.content[i], token.line, token.column))

			i++
		}

		// Trim whitespace and linebreaks
		token.content = token.content.replace(/^\s+|\s+$/g, '')

		return token
	}

	static lex(input: string, line = 1, column = 1) {
		let tokens: IToken[] = []

		while (input) {
			let token: IToken

			;({ input, line, column, token } = Lexer._lexToken(input, line, column))

			// Dont save comments since they are useless in parsing
			if (token.tokenType === 'Comment') {
				continue
			}

			// Keep linebreaks since they are needed for parsing
			if (token.content !== '\n') {
				token = Lexer._cleanTokenEnd(token)
			} else {
				// we can clean up multiple in a row however
				if (tokens[tokens.length - 1].content === '\n') {
					continue
				}
			}
			// Dont save empty tokens since they are useless in parsing
			if (token.content === '') {
				continue
			}

			tokens.push(token)
		}

		return tokens
	}
}
