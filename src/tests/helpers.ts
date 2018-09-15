import { lexer } from "../interfaces"
import {
	first,
	second,
	third,
	symbol,
	flatten,
	stripPosition,
	stripPositionFromArray,
	resolveOverloadedMethodName,
} from "../helpers"

const TokenType = lexer.TokenType
type Token = lexer.Token
type SimpleToken = lexer.SimpleToken

describe("Helpers", () => {
	describe("first", () => {
		it("should return the first item of an array", () => {
			expect(first([0, 1, 2, 3])).toEqual(0)
		})
	})

	describe("second", () => {
		it("should return the second item of an array", () => {
			expect(second([0, 1, 2, 3])).toEqual(1)
		})
	})

	describe("third", () => {
		it("should return the third item of an array", () => {
			expect(third([0, 1, 2, 3])).toEqual(2)
		})
	})

	describe("symbol", () => {
		it("should return a position object", () => {
			expect(symbol([{ position: { start: { line: 0, column: 0 }, end: { line: 0, column: 0 } } }])).toEqual({
				position: { start: { line: 0, column: 0 }, end: { line: 0, column: 0 } },
			})
		})
	})

	describe("flatten", () => {
		it("should flatten array of arrays", () => {
			expect(flatten([[0, 1], [2, 3]])).toEqual([0, 1, 2, 3])
		})

		it("should flatten mixed array of arrays and items", () => {
			expect(flatten([[0, 1], 2, [3, 4], 5])).toEqual([0, 1, 2, 3, 4, 5])
		})
	})

	describe("stripPosition", () => {
		it("should strip position", () => {
			let input: Token = {
				value: "",
				type: TokenType.LiteralString,
				position: {
					start: { line: 0, column: 0 },
					end: { line: 0, column: 0 },
				},
			}

			let output: SimpleToken = {
				value: "",
				type: TokenType.LiteralString,
			}

			expect(stripPosition(input)).toEqual(output)
		})
	})

	describe("stripPositionFromArray", () => {
		it("should strip position from all values", () => {
			let input: Array<Token> = [
				{
					value: "",
					type: TokenType.LiteralString,
					position: {
						start: { line: 0, column: 0 },
						end: { line: 0, column: 0 },
					},
				},
			]

			let output: Array<SimpleToken> = [
				{
					value: "",
					type: TokenType.LiteralString,
				},
			]

			expect(stripPositionFromArray(input)).toEqual(output)
		})
	})

	describe("stripPositionFromArray", () => {
		it("should strip position from all values", () => {
			let input: Array<Token> = [
				{
					value: "",
					type: TokenType.LiteralString,
					position: {
						start: { line: 0, column: 0 },
						end: { line: 0, column: 0 },
					},
				},
			]

			let output: Array<SimpleToken> = [
				{
					value: "",
					type: TokenType.LiteralString,
				},
			]

			expect(stripPositionFromArray(input)).toEqual(output)
		})
	})

	describe("stripPositionFromArray", () => {
		it("should strip position from all values", () => {
			const name = "Test"
			const index = 1

			let input = resolveOverloadedMethodName(name, index)
			let output = `${name}__overload$${index + 1}`

			expect(input).toEqual(output)
		})
	})
})
