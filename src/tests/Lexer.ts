/// <reference path="../../typings/index.d.ts" />

import { Lexer, } from '../Lexer'
import { TokenType, IToken, } from '../Interfaces'

type ISimpleToken = {
	tokenType: TokenType
	content: string
}

let stripNumbersFromArray = (tokens: IToken[]): ISimpleToken[] => {
	return tokens.map((value) => {
		return stripNumbers(value)
	})
}

let stripNumbers = (token: IToken): ISimpleToken => {
	return {
		tokenType: token.tokenType,
		content: token.content,
	}
}

describe('Lexer', () => {
	describe('stripNumbers', () => {
		it('should strip line and column', () => {
			let input: IToken = {
				content: '',
				tokenType: 'String',
				line: 1,
				column: 2,
			}

			let output = {
				content: '',
				tokenType: 'String',
			}

			expect(stripNumbers(input)).toEqual(output)
		})
	})

	describe('stripNumbersFromArray', () => {
		it('should strip line and column from all values', () => {
			let input: IToken[] = [{
				content: '',
				tokenType: 'String',
				line: 1,
				column: 2,
			}]

			let output = [{
				content: '',
				tokenType: 'String',
			}]

			expect(stripNumbersFromArray(input)).toEqual(output)
		})
	})

	describe('linebreaks', () => {
		it('should lex linebreaks', () => {
			let input: string
			let output: Array<ISimpleToken>

			input = '\n\n'
			output = [
				{
					content: '\n',
					tokenType: 'Linebreak',
				},
			]

			expect(stripNumbersFromArray(Lexer.lex(input))).toEqual(output)
		})

		it('should lex multiple linebreaks as one', () => {
			let input: string
			let output: Array<ISimpleToken>

			input = '\n\n'
			output = [
				{
					content: '\n',
					tokenType: 'Linebreak',
				},
			]

			expect(stripNumbersFromArray(Lexer.lex(input))).toEqual(output)
		})

		it('should lex linebreak after other tokens', () => {
			let input: string
			let output: Array<ISimpleToken>

			input = 'identifier\n'
			output = [
				{ content: 'identifier', tokenType: 'Identifier', },
				{ content: '\n', tokenType: 'Linebreak', },
			]

			expect(stripNumbersFromArray(Lexer.lex(input))).toEqual(output)
		})
	})

	describe('strings', () => {
		it('should lex empty strings', () => {
			let input: string
			let output: Array<ISimpleToken>

			input = '\'\''
			output = [
				{
					content: '',
					tokenType: 'String',
				},
			]

			expect(stripNumbersFromArray(Lexer.lex(input))).toEqual(output)
		})

		it('should lex simple strings', () => {
			let input: string
			let output: Array<ISimpleToken>

			input = '\'test\''
			output = [
				{
					content: 'test',
					tokenType: 'String',
				},
			]

			expect(stripNumbersFromArray(Lexer.lex(input))).toEqual(output)
		})

		it('should lex complex strings', () => {
			let input: string
			let output: Array<ISimpleToken>

			input = '\'test test\''
			output = [
				{
					content: 'test test',
					tokenType: 'String',
				},
			]

			expect(stripNumbersFromArray(Lexer.lex(input))).toEqual(output)
		})

		it('should not lex open strings', () => {
			let input: string

			input = '\'test'

			expect(() => Lexer.lex(input)).toThrow()
		})
	})

	describe('booleans', () => {
		it('should lex true', () => {
			let input: string
			let output: Array<ISimpleToken>

			input = 'true'
			output = [
				{
					content: 'true',
					tokenType: 'Boolean',
				},
			]

			expect(stripNumbersFromArray(Lexer.lex(input))).toEqual(output)
		})

		it('should lex false', () => {
			let input: string
			let output: Array<ISimpleToken>

			input = 'false'
			output = [
				{
					content: 'false',
					tokenType: 'Boolean',
				},
			]

			expect(stripNumbersFromArray(Lexer.lex(input))).toEqual(output)
		})
	})

	describe('comments', () => {
		it('should lex comments', () => {
			let input: string
			let output: Array<ISimpleToken>

			input = '§ Comment'
			output = []

			expect(stripNumbersFromArray(Lexer.lex(input))).toEqual(output)
		})
	})

	describe('identifiers', () => {
		it('should lex identifiers without whitespace', () => {
			let input: string
			let output: Array<ISimpleToken>

			input = 'identifier'
			output = [
				{ content: 'identifier', tokenType: 'Identifier', },
			]

			expect(stripNumbersFromArray(Lexer.lex(input))).toEqual(output)
		})

		it('should lex identifiers with whitespace in front', () => {
			let input: string
			let output: Array<ISimpleToken>

			input = '   identifier'
			output = [
				{ content: 'identifier', tokenType: 'Identifier', },
			]

			expect(stripNumbersFromArray(Lexer.lex(input))).toEqual(output)
		})

		it('should lex identifiers with whitespace after', () => {
			let input: string
			let output: Array<ISimpleToken>

			input = 'identifier  '
			output = [
				{ content: 'identifier', tokenType: 'Identifier', },
			]

			expect(stripNumbersFromArray(Lexer.lex(input))).toEqual(output)
		})

		it('should lex identifiers separated by delimiters', () => {
			let input: string
			let output: Array<ISimpleToken>

			input = 'identifier.identifier2'
			output = [
				{ content: 'identifier', tokenType: 'Identifier', },
				{ content: '.', tokenType: 'Delimiter', },
				{ content: 'identifier2', tokenType: 'Identifier', },
			]

			expect(stripNumbersFromArray(Lexer.lex(input))).toEqual(output)
		})
	})

	describe('keywords', () => {
		it('should lex let', () => {
			let input: string
			let output: Array<ISimpleToken>

			input = 'let'
			output = [
				{
					content: 'let',
					tokenType: 'Keyword',
				},
			]

			expect(stripNumbersFromArray(Lexer.lex(input))).toEqual(output)
		})

		it('should lex return', () => {
			let input: string
			let output: Array<ISimpleToken>

			input = 'return'
			output = [
				{
					content: 'return',
					tokenType: 'Keyword',
				},
			]

			expect(stripNumbersFromArray(Lexer.lex(input))).toEqual(output)
		})

		it('should lex if', () => {
			let input: string
			let output: Array<ISimpleToken>

			input = 'if'
			output = [
				{
					content: 'if',
					tokenType: 'Keyword',
				},
			]

			expect(stripNumbersFromArray(Lexer.lex(input))).toEqual(output)
		})

		it('should lex else', () => {
			let input: string
			let output: Array<ISimpleToken>

			input = 'else'
			output = [
				{
					content: 'else',
					tokenType: 'Keyword',
				},
			]

			expect(stripNumbersFromArray(Lexer.lex(input))).toEqual(output)
		})
	})

	describe('delimiters', () => {
		it('should lex @', () => {
			let input: string
			let output: Array<ISimpleToken>

			input = '@'
			output = [
				{
					content: '@',
					tokenType: 'Delimiter',
				},
			]

			expect(stripNumbersFromArray(Lexer.lex(input))).toEqual(output)
		})

		it('should lex (', () => {
			let input: string
			let output: Array<ISimpleToken>

			input = '('
			output = [
				{
					content: '(',
					tokenType: 'Delimiter',
				},
			]

			expect(stripNumbersFromArray(Lexer.lex(input))).toEqual(output)
		})

		it('should lex )', () => {
			let input: string
			let output: Array<ISimpleToken>

			input = ')'
			output = [
				{
					content: ')',
					tokenType: 'Delimiter',
				},
			]

			expect(stripNumbersFromArray(Lexer.lex(input))).toEqual(output)
		})

		it('should lex {', () => {
			let input: string
			let output: Array<ISimpleToken>

			input = '{'
			output = [
				{
					content: '{',
					tokenType: 'Delimiter',
				},
			]

			expect(stripNumbersFromArray(Lexer.lex(input))).toEqual(output)
		})

		it('should lex }', () => {
			let input: string
			let output: Array<ISimpleToken>

			input = '}'
			output = [
				{
					content: '}',
					tokenType: 'Delimiter',
				},
			]

			expect(stripNumbersFromArray(Lexer.lex(input))).toEqual(output)
		})

		it('should lex ,', () => {
			let input: string
			let output: Array<ISimpleToken>

			input = ','
			output = [
				{
					content: ',',
					tokenType: 'Delimiter',
				},
			]

			expect(stripNumbersFromArray(Lexer.lex(input))).toEqual(output)
		})

		it('should lex .', () => {
			let input: string
			let output: Array<ISimpleToken>

			input = '.'
			output = [
				{
					content: '.',
					tokenType: 'Delimiter',
				},
			]

			expect(stripNumbersFromArray(Lexer.lex(input))).toEqual(output)
		})

		it('should lex :', () => {
			let input: string
			let output: Array<ISimpleToken>

			input = ':'
			output = [
				{
					content: ':',
					tokenType: 'Delimiter',
				},
			]

			expect(stripNumbersFromArray(Lexer.lex(input))).toEqual(output)
		})

		it('should lex =', () => {
			let input: string
			let output: Array<ISimpleToken>

			input = '='
			output = [
				{
					content: '=',
					tokenType: 'Delimiter',
				},
			]

			expect(stripNumbersFromArray(Lexer.lex(input))).toEqual(output)
		})

		it('should lex -', () => {
			let input: string
			let output: Array<ISimpleToken>

			input = '-'
			output = [
				{
					content: '-',
					tokenType: 'Delimiter',
				},
			]

			expect(stripNumbersFromArray(Lexer.lex(input))).toEqual(output)
		})

		it('should lex >', () => {
			let input: string
			let output: Array<ISimpleToken>

			input = '>'
			output = [
				{
					content: '>',
					tokenType: 'Delimiter',
				},
			]

			expect(stripNumbersFromArray(Lexer.lex(input))).toEqual(output)
		})
	})
})
