import { Lexer } from "../lexer"
import { lexer } from "../interfaces"
import { stripPosition, stripPositionFromArray } from "../helpers"

const TokenType = lexer.TokenType
type Token = lexer.Token
type SimpleToken = lexer.SimpleToken

describe("Lexer", () => {
	it("should handle empty input", () => {
		let lexer = new Lexer()
		let input: string
		let output: undefined

		input = ""
		output = undefined

		lexer.reset(input)

		expect(lexer.next()).toEqual(output)
	})

	describe("Linebreaks", () => {
		it("should lex linebreaks", () => {
			let lexer = new Lexer()
			let input: string
			let output: SimpleToken

			input = "\n"
			output = {
				value: "\n",
				type: TokenType.Linebreak,
			}

			lexer.reset(input)

			expect(stripPosition(lexer.next())).toEqual(output)
		})

		it("should lex multiple linebreaks", () => {
			let lexer = new Lexer()
			let input: string
			let output: Array<SimpleToken>

			input = "\n\n"
			output = [
				{
					value: "\n",
					type: TokenType.Linebreak,
				},
				{
					value: "\n",
					type: TokenType.Linebreak,
				},
			]

			lexer.reset(input)

			expect(stripPositionFromArray([lexer.next(), lexer.next()])).toEqual(output)
		})

		it("should lex linebreak after other tokens", () => {
			let lexer = new Lexer()
			let input: string
			let output: Array<SimpleToken>

			input = "identifier\n"
			output = [{ value: "identifier", type: TokenType.Identifier }, { value: "\n", type: TokenType.Linebreak }]

			lexer.reset(input)

			expect(stripPositionFromArray([lexer.next(), lexer.next()])).toEqual(output)
		})
	})

	describe("Strings", () => {
		it("should lex empty strings", () => {
			let lexer = new Lexer()
			let input: string
			let output: SimpleToken

			input = '""'
			output = {
				value: "",
				type: TokenType.LiteralString,
			}

			lexer.reset(input)

			expect(stripPosition(lexer.next())).toEqual(output)
		})

		it("should lex simple strings", () => {
			let lexer = new Lexer()
			let input: string
			let output: SimpleToken

			input = '"test"'
			output = {
				value: "test",
				type: TokenType.LiteralString,
			}

			lexer.reset(input)

			expect(stripPosition(lexer.next())).toEqual(output)
		})

		it("should lex complex strings", () => {
			let lexer = new Lexer()
			let input: string
			let output: SimpleToken

			input = '"test test"'
			output = {
				value: "test test",
				type: TokenType.LiteralString,
			}

			lexer.reset(input)

			expect(stripPosition(lexer.next())).toEqual(output)
		})

		it("should not lex open strings", () => {
			let lexer = new Lexer()
			let input: string

			input = '"test'

			lexer.reset(input)

			expect(() => lexer.next()).toThrow()
		})
	})

	describe("Comments", () => {
		it("should lex comments", () => {
			let lexer = new Lexer()
			let input: string
			let output: SimpleToken

			input = "§ Comment"
			output = {
				value: "§ Comment",
				type: TokenType.Comment,
			}

			lexer.reset(input)

			expect(stripPosition(lexer.next())).toEqual(output)
		})

		it("should lex comments with a linebreak after", () => {
			let lexer = new Lexer()
			let input: string
			let output: Array<SimpleToken>

			input = "§ Comment\n"
			output = [
				{
					value: "§ Comment",
					type: TokenType.Comment,
				},
				{
					value: "\n",
					type: TokenType.Linebreak,
				},
			]

			lexer.reset(input)

			expect(stripPositionFromArray([lexer.next(), lexer.next()])).toEqual(output)
		})
	})

	describe("Identifiers", () => {
		it("should lex identifiers without whitespace", () => {
			let lexer = new Lexer()
			let input: string
			let output: SimpleToken

			input = "identifier"
			output = {
				value: "identifier",
				type: TokenType.Identifier,
			}

			lexer.reset(input)

			expect(stripPosition(lexer.next())).toEqual(output)
		})

		it("should lex identifiers with whitespace in front", () => {
			let lexer = new Lexer()
			let input: string
			let output: SimpleToken

			input = "   identifier"
			output = {
				value: "identifier",
				type: TokenType.Identifier,
			}

			lexer.reset(input)

			expect(stripPosition(lexer.next())).toEqual(output)
		})

		it("should lex identifiers with whitespace after", () => {
			let lexer = new Lexer()
			let input: string
			let output: SimpleToken

			input = "identifier  "
			output = {
				value: "identifier",
				type: TokenType.Identifier,
			}

			lexer.reset(input)

			expect(stripPosition(lexer.next())).toEqual(output)
		})

		it("should lex identifiers separated by Symbols", () => {
			let lexer = new Lexer()
			let input: string
			let output: Array<SimpleToken>

			input = "identifier.identifier2"
			output = [
				{ value: "identifier", type: TokenType.Identifier },
				{ value: ".", type: TokenType.SymbolDot },
				{ value: "identifier2", type: TokenType.Identifier },
			]

			lexer.reset(input)

			expect(stripPositionFromArray([lexer.next(), lexer.next(), lexer.next()])).toEqual(output)
		})
	})

	describe("Booleans", () => {
		it("should lex true", () => {
			let lexer = new Lexer()
			let input: string
			let output: SimpleToken

			input = "true"
			output = {
				value: "true",
				type: TokenType.LiteralTrue,
			}

			lexer.reset(input)

			expect(stripPosition(lexer.next())).toEqual(output)
		})

		it("should lex false", () => {
			let lexer = new Lexer()
			let input: string
			let output: SimpleToken

			input = "false"
			output = {
				value: "false",
				type: TokenType.LiteralFalse,
			}

			lexer.reset(input)

			expect(stripPosition(lexer.next())).toEqual(output)
		})
	})

	describe("Keywords", () => {
		it("should lex if", () => {
			let lexer = new Lexer()
			let input: string
			let output: SimpleToken

			input = "if"
			output = {
				value: "if",
				type: TokenType.KeywordIf,
			}

			lexer.reset(input)

			expect(stripPosition(lexer.next())).toEqual(output)
		})

		it("should lex else", () => {
			let lexer = new Lexer()
			let input: string
			let output: SimpleToken

			input = "else"
			output = {
				value: "else",
				type: TokenType.KeywordElse,
			}

			lexer.reset(input)

			expect(stripPosition(lexer.next())).toEqual(output)
		})

		it("should lex type", () => {
			let lexer = new Lexer()
			let input: string
			let output: SimpleToken

			input = "type"
			output = {
				value: "type",
				type: TokenType.KeywordType,
			}

			lexer.reset(input)

			expect(stripPosition(lexer.next())).toEqual(output)
		})

		it("should lex variable", () => {
			let lexer = new Lexer()
			let input: string
			let output: SimpleToken

			input = "variable"
			output = {
				value: "variable",
				type: TokenType.KeywordVariable,
			}

			lexer.reset(input)

			expect(stripPosition(lexer.next())).toEqual(output)
		})

		it("should lex constant", () => {
			let lexer = new Lexer()
			let input: string
			let output: SimpleToken

			input = "constant"
			output = {
				value: "constant",
				type: TokenType.KeywordConstant,
			}

			lexer.reset(input)

			expect(stripPosition(lexer.next())).toEqual(output)
		})

		it("should lex function", () => {
			let lexer = new Lexer()
			let input: string
			let output: SimpleToken

			input = "function"
			output = {
				value: "function",
				type: TokenType.KeywordFunction,
			}

			lexer.reset(input)

			expect(stripPosition(lexer.next())).toEqual(output)
		})

		it("should lex static", () => {
			let lexer = new Lexer()
			let input: string
			let output: SimpleToken

			input = "static"
			output = {
				value: "static",
				type: TokenType.KeywordStatic,
			}

			lexer.reset(input)

			expect(stripPosition(lexer.next())).toEqual(output)
		})

		it("should lex implementation", () => {
			let lexer = new Lexer()
			let input: string
			let output: SimpleToken

			input = "implementation"
			output = {
				value: "implementation",
				type: TokenType.KeywordImplementation,
			}

			lexer.reset(input)

			expect(stripPosition(lexer.next())).toEqual(output)
		})

		it("should lex overload", () => {
			let lexer = new Lexer()
			let input: string
			let output: SimpleToken

			input = "overload"
			output = {
				value: "overload",
				type: TokenType.KeywordOverload,
			}

			lexer.reset(input)

			expect(stripPosition(lexer.next())).toEqual(output)
		})
	})

	describe("Symbols", () => {
		it("should lex @", () => {
			let lexer = new Lexer()
			let input: string
			let output: SimpleToken

			input = "@"
			output = {
				value: "@",
				type: TokenType.SymbolAt,
			}

			lexer.reset(input)

			expect(stripPosition(lexer.next())).toEqual(output)
		})

		it("should lex |", () => {
			let lexer = new Lexer()
			let input: string
			let output: SimpleToken

			input = "|"
			output = {
				value: "|",
				type: TokenType.SymbolPipe,
			}

			lexer.reset(input)

			expect(stripPosition(lexer.next())).toEqual(output)
		})

		it("should lex (", () => {
			let lexer = new Lexer()
			let input: string
			let output: SimpleToken

			input = "("
			output = {
				value: "(",
				type: TokenType.SymbolLeftParen,
			}

			lexer.reset(input)

			expect(stripPosition(lexer.next())).toEqual(output)
		})

		it("should lex )", () => {
			let lexer = new Lexer()
			let input: string
			let output: SimpleToken

			input = ")"
			output = {
				value: ")",
				type: TokenType.SymbolRightParen,
			}

			lexer.reset(input)

			expect(stripPosition(lexer.next())).toEqual(output)
		})

		it("should lex {", () => {
			let lexer = new Lexer()
			let input: string
			let output: SimpleToken

			input = "{"
			output = {
				value: "{",
				type: TokenType.SymbolLeftBrace,
			}

			lexer.reset(input)

			expect(stripPosition(lexer.next())).toEqual(output)
		})

		it("should lex }", () => {
			let lexer = new Lexer()
			let input: string
			let output: SimpleToken

			input = "}"
			output = {
				value: "}",
				type: TokenType.SymbolRightBrace,
			}

			lexer.reset(input)

			expect(stripPosition(lexer.next())).toEqual(output)
		})

		it("should lex [", () => {
			let lexer = new Lexer()
			let input: string
			let output: SimpleToken

			input = "["
			output = {
				value: "[",
				type: TokenType.SymbolLeftBracket,
			}

			lexer.reset(input)

			expect(stripPosition(lexer.next())).toEqual(output)
		})

		it("should lex ]", () => {
			let lexer = new Lexer()
			let input: string
			let output: SimpleToken

			input = "]"
			output = {
				value: "]",
				type: TokenType.SymbolRightBracket,
			}

			lexer.reset(input)

			expect(stripPosition(lexer.next())).toEqual(output)
		})

		it("should lex ,", () => {
			let lexer = new Lexer()
			let input: string
			let output: SimpleToken

			input = ","
			output = {
				value: ",",
				type: TokenType.SymbolComma,
			}

			lexer.reset(input)

			expect(stripPosition(lexer.next())).toEqual(output)
		})

		it("should lex .", () => {
			let lexer = new Lexer()
			let input: string
			let output: SimpleToken

			input = "."
			output = {
				value: ".",
				type: TokenType.SymbolDot,
			}

			lexer.reset(input)

			expect(stripPosition(lexer.next())).toEqual(output)
		})

		it("should lex :", () => {
			let lexer = new Lexer()
			let input: string
			let output: SimpleToken

			input = ":"
			output = {
				value: ":",
				type: TokenType.SymbolColon,
			}

			lexer.reset(input)

			expect(stripPosition(lexer.next())).toEqual(output)
		})

		it("should lex =", () => {
			let lexer = new Lexer()
			let input: string
			let output: SimpleToken

			input = "="
			output = {
				value: "=",
				type: TokenType.SymbolEqual,
			}

			lexer.reset(input)

			expect(stripPosition(lexer.next())).toEqual(output)
		})

		it("should lex -", () => {
			let lexer = new Lexer()
			let input: string
			let output: SimpleToken

			input = "-"
			output = {
				value: "-",
				type: TokenType.SymbolDash,
			}

			lexer.reset(input)

			expect(stripPosition(lexer.next())).toEqual(output)
		})

		it("should lex <", () => {
			let lexer = new Lexer()
			let input: string
			let output: SimpleToken

			input = "<"
			output = {
				value: "<",
				type: TokenType.SymbolLeftAngle,
			}

			lexer.reset(input)

			expect(stripPosition(lexer.next())).toEqual(output)
		})

		it("should lex >", () => {
			let lexer = new Lexer()
			let input: string
			let output: SimpleToken

			input = ">"
			output = {
				value: ">",
				type: TokenType.SymbolRightAngle,
			}

			lexer.reset(input)

			expect(stripPosition(lexer.next())).toEqual(output)
		})

		it("should lex _", () => {
			let lexer = new Lexer()
			let input: string
			let output: SimpleToken

			input = "_"
			output = {
				value: "_",
				type: TokenType.SymbolUnderscore,
			}

			lexer.reset(input)

			expect(stripPosition(lexer.next())).toEqual(output)
		})

		it("should lex ~", () => {
			let lexer = new Lexer()
			let input: string
			let output: SimpleToken

			input = "~"
			output = {
				value: "~",
				type: TokenType.SymbolTilde,
			}

			lexer.reset(input)

			expect(stripPosition(lexer.next())).toEqual(output)
		})
	})

	describe("Numbers", () => {
		it("should lex 1", () => {
			let lexer = new Lexer()
			let input: string
			let output: SimpleToken

			input = "1"
			output = {
				value: "1",
				type: TokenType.LiteralNumber,
			}

			lexer.reset(input)

			expect(stripPosition(lexer.next())).toEqual(output)
		})

		it("should lex 1000", () => {
			let lexer = new Lexer()
			let input: string
			let output: SimpleToken

			input = "1000"
			output = {
				value: "1000",
				type: TokenType.LiteralNumber,
			}

			lexer.reset(input)

			expect(stripPosition(lexer.next())).toEqual(output)
		})

		it("should lex 1000 with a linebreak following", () => {
			let lexer = new Lexer()
			let input: string
			let output: SimpleToken

			input = "1000\n"
			output = {
				value: "1000",
				type: TokenType.LiteralNumber,
			}

			lexer.reset(input)

			expect(stripPosition(lexer.next())).toEqual(output)
		})

		it("should lex 1000 with a space following", () => {
			let lexer = new Lexer()
			let input: string
			let output: SimpleToken

			input = "1000 "
			output = {
				value: "1000",
				type: TokenType.LiteralNumber,
			}

			lexer.reset(input)

			expect(stripPosition(lexer.next())).toEqual(output)
		})
	})
})
