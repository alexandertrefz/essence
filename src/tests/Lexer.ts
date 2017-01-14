/// <reference path="../../typings/index.d.ts" />

import { lex } from '../Lexer'
import { lexer } from '../Interfaces'

type TokenType = lexer.TokenType
type IToken = lexer.IToken

type ISimpleToken = {
	tokenType: TokenType
	content: string
}

let stripPositionFromArray = (tokens: IToken[]): ISimpleToken[] => {
	return tokens.map((value) => {
		return stripPosition(value)
	})
}

let stripPosition = (token: IToken): ISimpleToken => {
	let tokenCopy = JSON.parse(JSON.stringify(token))
	delete tokenCopy.position
	return tokenCopy
}

describe('Lexer', () => {
	describe('stripPosition', () => {
		it('should strip line and column', () => {
			let input: IToken = {
				content: '',
				tokenType: 'String',
				position: {
					line: 1,
					column: 2,
				}
			}

			let output = {
				content: '',
				tokenType: 'String',
			}

			expect(stripPosition(input)).toEqual(output)
		})
	})

	describe('stripPositionFromArray', () => {
		it('should strip line and column from all values', () => {
			let input: IToken[] = [{
				content: '',
				tokenType: 'String',
				position: {
					line: 1,
					column: 2,
				}
			}]

			let output = [{
				content: '',
				tokenType: 'String',
			}]

			expect(stripPositionFromArray(input)).toEqual(output)
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

			expect(stripPositionFromArray(lex(input))).toEqual(output)
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

			expect(stripPositionFromArray(lex(input))).toEqual(output)
		})

		it('should lex linebreak after other tokens', () => {
			let input: string
			let output: Array<ISimpleToken>

			input = 'identifier\n'
			output = [
				{ content: 'identifier', tokenType: 'Identifier', },
				{ content: '\n', tokenType: 'Linebreak', },
			]

			expect(stripPositionFromArray(lex(input))).toEqual(output)
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

			expect(stripPositionFromArray(lex(input))).toEqual(output)
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

			expect(stripPositionFromArray(lex(input))).toEqual(output)
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

			expect(stripPositionFromArray(lex(input))).toEqual(output)
		})

		it('should not lex open strings', () => {
			let input: string

			input = '\'test'

			expect(() => lex(input)).toThrow()
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

			expect(stripPositionFromArray(lex(input))).toEqual(output)
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

			expect(stripPositionFromArray(lex(input))).toEqual(output)
		})
	})

	describe('numbers', () => {
		it('should lex simple numbers', () => {
			let input: string
			let output: Array<ISimpleToken>

			input = '1'
			output = [
				{
					content: '1',
					tokenType: 'Number',
				},
			]

			expect(stripPositionFromArray(lex(input))).toEqual(output)

			input = '123'
			output = [
				{
					content: '123',
					tokenType: 'Number',
				},
			]

			expect(stripPositionFromArray(lex(input))).toEqual(output)
		})

		it('should lex simple numbers with underscores', () => {
			let input: string
			let output: Array<ISimpleToken>

			input = '1_000'
			output = [
				{
					content: '1000',
					tokenType: 'Number',
				},
			]

			expect(stripPositionFromArray(lex(input))).toEqual(output)
		})

		it('should lex float numbers', () => {
			let input: string
			let output: Array<ISimpleToken>

			input = '1.5'
			output = [
				{
					content: '1.5',
					tokenType: 'Number',
				},
			]

			expect(stripPositionFromArray(lex(input))).toEqual(output)
		})

		it('should lex float numbers with underscores', () => {
			let input: string
			let output: Array<ISimpleToken>

			input = '1_000.5'
			output = [
				{
					content: '1000.5',
					tokenType: 'Number',
				},
			]

			expect(stripPositionFromArray(lex(input))).toEqual(output)
		})

		it('should not lex numbers with multiple dots', () => {
			let input: string
			let output: Array<ISimpleToken>

			input = '1.000.5'
			output = [
				{
					content: '1.000',
					tokenType: 'Number',
				},
				{
					content: '.',
					tokenType: 'Delimiter',
				},
				{
					content: '5',
					tokenType: 'Number',
				},
			]

			expect(stripPositionFromArray(lex(input))).toEqual(output)
		})
	})

	describe('comments', () => {
		it('should lex comments', () => {
			let input: string
			let output: Array<ISimpleToken>

			input = '§ Comment'
			output = []

			expect(stripPositionFromArray(lex(input))).toEqual(output)
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

			expect(stripPositionFromArray(lex(input))).toEqual(output)
		})

		it('should lex identifiers with whitespace in front', () => {
			let input: string
			let output: Array<ISimpleToken>

			input = '   identifier'
			output = [
				{ content: 'identifier', tokenType: 'Identifier', },
			]

			expect(stripPositionFromArray(lex(input))).toEqual(output)
		})

		it('should lex identifiers with whitespace after', () => {
			let input: string
			let output: Array<ISimpleToken>

			input = 'identifier  '
			output = [
				{ content: 'identifier', tokenType: 'Identifier', },
			]

			expect(stripPositionFromArray(lex(input))).toEqual(output)
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

			expect(stripPositionFromArray(lex(input))).toEqual(output)
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

			expect(stripPositionFromArray(lex(input))).toEqual(output)
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

			expect(stripPositionFromArray(lex(input))).toEqual(output)
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

			expect(stripPositionFromArray(lex(input))).toEqual(output)
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

			expect(stripPositionFromArray(lex(input))).toEqual(output)
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

			expect(stripPositionFromArray(lex(input))).toEqual(output)
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

			expect(stripPositionFromArray(lex(input))).toEqual(output)
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

			expect(stripPositionFromArray(lex(input))).toEqual(output)
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

			expect(stripPositionFromArray(lex(input))).toEqual(output)
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

			expect(stripPositionFromArray(lex(input))).toEqual(output)
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

			expect(stripPositionFromArray(lex(input))).toEqual(output)
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

			expect(stripPositionFromArray(lex(input))).toEqual(output)
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

			expect(stripPositionFromArray(lex(input))).toEqual(output)
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

			expect(stripPositionFromArray(lex(input))).toEqual(output)
		})

		it('should lex <', () => {
			let input: string
			let output: Array<ISimpleToken>

			input = '<'
			output = [
				{
					content: '<',
					tokenType: 'Delimiter',
				},
			]

			expect(stripPositionFromArray(lex(input))).toEqual(output)
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

			expect(stripPositionFromArray(lex(input))).toEqual(output)
		})

		it('should lex _', () => {
			let input: string
			let output: Array<ISimpleToken>

			input = '_'
			output = [
				{
					content: '_',
					tokenType: 'Delimiter',
				},
			]

			expect(stripPositionFromArray(lex(input))).toEqual(output)
		})
	})
})
