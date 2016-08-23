/// <reference path="../typings/index.d.ts" />
let assert = require('assert')
let Lexer = require('../lib/Lexer').Lexer

// TODO: Investigate why the typescript compiler does not emit,
//       if we import the interfaces file
export type TokenType
	= null
	| 'Delimiter'
	| 'Identifier'
	| 'Keyword'
	| 'Operator'
	| 'String'
	| 'Comment'
	| 'Linebreak'
	| 'Boolean'
	| 'Number'

export interface IToken {
	content: string
	tokenType: TokenType
	line: number
	column: number
}

describe('Lexer', () => {
	describe('strings', () => {
		it('should lex empty strings', () => {
			let input: string
			let output: Array<IToken>

			input = '\'\''
			output = [
				{
					content: '',
					tokenType: 'String',
					line: 1,
					column: 2
				}
			]

			assert.deepEqual(Lexer.lex(input), output)
		})

		it('should lex simple strings', () => {
			let input: string
			let output: Array<IToken>

			input = '\'test\''
			output = [
				{
					content: 'test',
					tokenType: 'String',
					line: 1,
					column: 2
				}
			]

			assert.deepEqual(Lexer.lex(input), output)
		})

		it('should lex complex strings', () => {
			let input: string
			let output: Array<IToken>

			input = '\'test test\''
			output = [
				{
					content: 'test test',
					tokenType: 'String',
					line: 1,
					column: 2
				}
			]

			assert.deepEqual(Lexer.lex(input), output)
		})
	})

	describe('booleans', () => {
		it('should lex true', () => {
			let input: string
			let output: Array<IToken>

			input = 'true'
			output = [
				{
					content: 'true',
					tokenType: 'Boolean',
					line: 1,
					column: 1
				}
			]

			assert.deepEqual(Lexer.lex(input), output)
		})

		it('should lex false', () => {
			let input: string
			let output: Array<IToken>

			input = 'false'
			output = [
				{
					content: 'false',
					tokenType: 'Boolean',
					line: 1,
					column: 1
				}
			]

			assert.deepEqual(Lexer.lex(input), output)
		})
	})

	describe('comments', () => {
		it('should lex comments', () => {
			let input: string
			let output: Array<IToken>

			input = '§ Comment'
			output = []

			assert.deepEqual(Lexer.lex(input), output)
		})
	})

	describe('keywords', () => {
		it('should lex package', () => {
			let input: string
			let output: Array<IToken>

			input = 'package'
			output = [
				{
					content: 'package',
					tokenType: 'Keyword',
					line: 1,
					column: 1
				}
			]

			assert.deepEqual(Lexer.lex(input), output)
		})

		it('should lex import', () => {
			let input: string
			let output: Array<IToken>

			input = 'import'
			output = [
				{
					content: 'import',
					tokenType: 'Keyword',
					line: 1,
					column: 1
				}
			]

			assert.deepEqual(Lexer.lex(input), output)
		})

		it('should lex as', () => {
			let input: string
			let output: Array<IToken>

			input = 'as'
			output = [
				{
					content: 'as',
					tokenType: 'Keyword',
					line: 1,
					column: 1
				}
			]

			assert.deepEqual(Lexer.lex(input), output)
		})

		it('should lex type', () => {
			let input: string
			let output: Array<IToken>

			input = 'type'
			output = [
				{
					content: 'type',
					tokenType: 'Keyword',
					line: 1,
					column: 1
				}
			]

			assert.deepEqual(Lexer.lex(input), output)
		})

		it('should lex interface', () => {
			let input: string
			let output: Array<IToken>

			input = 'interface'
			output = [
				{
					content: 'interface',
					tokenType: 'Keyword',
					line: 1,
					column: 1
				}
			]

			assert.deepEqual(Lexer.lex(input), output)
		})

		it('should lex let', () => {
			let input: string
			let output: Array<IToken>

			input = 'let'
			output = [
				{
					content: 'let',
					tokenType: 'Keyword',
					line: 1,
					column: 1
				}
			]

			assert.deepEqual(Lexer.lex(input), output)
		})

		it('should lex each', () => {
			let input: string
			let output: Array<IToken>

			input = 'each'
			output = [
				{
					content: 'each',
					tokenType: 'Keyword',
					line: 1,
					column: 1
				}
			]

			assert.deepEqual(Lexer.lex(input), output)
		})

		it('should lex in', () => {
			let input: string
			let output: Array<IToken>

			input = 'in'
			output = [
				{
					content: 'in',
					tokenType: 'Keyword',
					line: 1,
					column: 1
				}
			]

			assert.deepEqual(Lexer.lex(input), output)
		})

		it('should lex do', () => {
			let input: string
			let output: Array<IToken>

			input = 'do'
			output = [
				{
					content: 'do',
					tokenType: 'Keyword',
					line: 1,
					column: 1
				}
			]

			assert.deepEqual(Lexer.lex(input), output)
		})

		it('should lex end', () => {
			let input: string
			let output: Array<IToken>

			input = 'end'
			output = [
				{
					content: 'end',
					tokenType: 'Keyword',
					line: 1,
					column: 1
				}
			]

			assert.deepEqual(Lexer.lex(input), output)
		})

		it('should lex return', () => {
			let input: string
			let output: Array<IToken>

			input = 'return'
			output = [
				{
					content: 'return',
					tokenType: 'Keyword',
					line: 1,
					column: 1
				}
			]

			assert.deepEqual(Lexer.lex(input), output)
		})

		it('should lex if', () => {
			let input: string
			let output: Array<IToken>

			input = 'if'
			output = [
				{
					content: 'if',
					tokenType: 'Keyword',
					line: 1,
					column: 1
				}
			]

			assert.deepEqual(Lexer.lex(input), output)
		})

		it('should lex then', () => {
			let input: string
			let output: Array<IToken>

			input = 'then'
			output = [
				{
					content: 'then',
					tokenType: 'Keyword',
					line: 1,
					column: 1
				}
			]

			assert.deepEqual(Lexer.lex(input), output)
		})

		it('should lex else', () => {
			let input: string
			let output: Array<IToken>

			input = 'else'
			output = [
				{
					content: 'else',
					tokenType: 'Keyword',
					line: 1,
					column: 1
				}
			]

			assert.deepEqual(Lexer.lex(input), output)
		})
	})

	describe('delimiters', () => {
		it('should lex @', () => {
			let input: string
			let output: Array<IToken>

			input = '@'
			output = [
				{
					content: '@',
					tokenType: 'Delimiter',
					line: 1,
					column: 1
				}
			]

			assert.deepEqual(Lexer.lex(input), output)
		})

		it('should lex (', () => {
			let input: string
			let output: Array<IToken>

			input = '('
			output = [
				{
					content: '(',
					tokenType: 'Delimiter',
					line: 1,
					column: 1
				}
			]

			assert.deepEqual(Lexer.lex(input), output)
		})

		it('should lex )', () => {
			let input: string
			let output: Array<IToken>

			input = ')'
			output = [
				{
					content: ')',
					tokenType: 'Delimiter',
					line: 1,
					column: 1
				}
			]

			assert.deepEqual(Lexer.lex(input), output)
		})

		it('should lex {', () => {
			let input: string
			let output: Array<IToken>

			input = '{'
			output = [
				{
					content: '{',
					tokenType: 'Delimiter',
					line: 1,
					column: 1
				}
			]

			assert.deepEqual(Lexer.lex(input), output)
		})

		it('should lex }', () => {
			let input: string
			let output: Array<IToken>

			input = '}'
			output = [
				{
					content: '}',
					tokenType: 'Delimiter',
					line: 1,
					column: 1
				}
			]

			assert.deepEqual(Lexer.lex(input), output)
		})

		it('should lex [', () => {
			let input: string
			let output: Array<IToken>

			input = '['
			output = [
				{
					content: '[',
					tokenType: 'Delimiter',
					line: 1,
					column: 1
				}
			]

			assert.deepEqual(Lexer.lex(input), output)
		})

		it('should lex ]', () => {
			let input: string
			let output: Array<IToken>

			input = ']'
			output = [
				{
					content: ']',
					tokenType: 'Delimiter',
					line: 1,
					column: 1
				}
			]

			assert.deepEqual(Lexer.lex(input), output)
		})

		it('should lex <', () => {
			let input: string
			let output: Array<IToken>

			input = '<'
			output = [
				{
					content: '<',
					tokenType: 'Delimiter',
					line: 1,
					column: 1
				}
			]

			assert.deepEqual(Lexer.lex(input), output)
		})

		it('should lex >', () => {
			let input: string
			let output: Array<IToken>

			input = '>'
			output = [
				{
					content: '>',
					tokenType: 'Delimiter',
					line: 1,
					column: 1
				}
			]

			assert.deepEqual(Lexer.lex(input), output)
		})

		it('should lex ,', () => {
			let input: string
			let output: Array<IToken>

			input = ','
			output = [
				{
					content: ',',
					tokenType: 'Delimiter',
					line: 1,
					column: 1
				}
			]

			assert.deepEqual(Lexer.lex(input), output)
		})

		it('should lex .', () => {
			let input: string
			let output: Array<IToken>

			input = '.'
			output = [
				{
					content: '.',
					tokenType: 'Delimiter',
					line: 1,
					column: 1
				}
			]

			assert.deepEqual(Lexer.lex(input), output)
		})

		it('should lex :', () => {
			let input: string
			let output: Array<IToken>

			input = ':'
			output = [
				{
					content: ':',
					tokenType: 'Delimiter',
					line: 1,
					column: 1
				}
			]

			assert.deepEqual(Lexer.lex(input), output)
		})

		it('should lex !', () => {
			let input: string
			let output: Array<IToken>

			input = '!'
			output = [
				{
					content: '!',
					tokenType: 'Delimiter',
					line: 1,
					column: 1
				}
			]

			assert.deepEqual(Lexer.lex(input), output)
		})

		it('should lex =', () => {
			let input: string
			let output: Array<IToken>

			input = '='
			output = [
				{
					content: '=',
					tokenType: 'Delimiter',
					line: 1,
					column: 1
				}
			]

			assert.deepEqual(Lexer.lex(input), output)
		})

		it('should lex |', () => {
			let input: string
			let output: Array<IToken>

			input = '|'
			output = [
				{
					content: '|',
					tokenType: 'Delimiter',
					line: 1,
					column: 1
				}
			]

			assert.deepEqual(Lexer.lex(input), output)
		})

		it('should lex &', () => {
			let input: string
			let output: Array<IToken>

			input = '&'
			output = [
				{
					content: '&',
					tokenType: 'Delimiter',
					line: 1,
					column: 1
				}
			]

			assert.deepEqual(Lexer.lex(input), output)
		})

		it('should lex #', () => {
			let input: string
			let output: Array<IToken>

			input = '#'
			output = [
				{
					content: '#',
					tokenType: 'Delimiter',
					line: 1,
					column: 1
				}
			]

			assert.deepEqual(Lexer.lex(input), output)
		})

		it('should lex -', () => {
			let input: string
			let output: Array<IToken>

			input = '-'
			output = [
				{
					content: '-',
					tokenType: 'Delimiter',
					line: 1,
					column: 1
				}
			]

			assert.deepEqual(Lexer.lex(input), output)
		})

		it('should lex +', () => {
			let input: string
			let output: Array<IToken>

			input = '+'
			output = [
				{
					content: '+',
					tokenType: 'Delimiter',
					line: 1,
					column: 1
				}
			]

			assert.deepEqual(Lexer.lex(input), output)
		})

		it('should lex *', () => {
			let input: string
			let output: Array<IToken>

			input = '*'
			output = [
				{
					content: '*',
					tokenType: 'Delimiter',
					line: 1,
					column: 1
				}
			]

			assert.deepEqual(Lexer.lex(input), output)
		})

		it('should lex /', () => {
			let input: string
			let output: Array<IToken>

			input = '/'
			output = [
				{
					content: '/',
					tokenType: 'Delimiter',
					line: 1,
					column: 1
				}
			]

			assert.deepEqual(Lexer.lex(input), output)
		})
	})
})
