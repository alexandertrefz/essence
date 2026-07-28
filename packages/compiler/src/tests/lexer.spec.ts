import { describe, expect, it } from "bun:test"

import { lexer } from "@essence-lang/interfaces"

import { stripPosition, stripPositionFromArray } from "../helpers/index"
import { Lexer } from "../lexer/index"

const TokenType = lexer.TokenType
type SimpleToken = lexer.SimpleToken

describe("Lexer", () => {
	it("should handle empty input", () => {
		let lexer = new Lexer()
		let input: string
		let output: undefined

		input = ""
		output = undefined

		lexer.reset(input)

		expect<ReturnType<typeof lexer.next>>(lexer.next()).toEqual(output)
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

			expect(
				stripPositionFromArray([lexer.next(), lexer.next()]),
			).toEqual(output)
		})

		it("should lex linebreak after other tokens", () => {
			let lexer = new Lexer()
			let input: string
			let output: Array<SimpleToken>

			input = "identifier\n"
			output = [
				{ value: "identifier", type: TokenType.Identifier },
				{ value: "\n", type: TokenType.Linebreak },
			]

			lexer.reset(input)

			expect(
				stripPositionFromArray([lexer.next(), lexer.next()]),
			).toEqual(output)
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

		it("should decode escapes into the value", () => {
			let lexer = new Lexer()

			lexer.reset('"a\\nb\\t\\"c\\\\d"')

			expect(stripPosition(lexer.next())).toEqual({
				value: 'a\nb\t"c\\d',
				type: TokenType.LiteralString,
			})
			expect(lexer.errors).toEqual([])
		})

		it("should report an unknown escape but keep lexing", () => {
			let lexer = new Lexer()

			lexer.reset('"bad \\q here"')

			expect(stripPosition(lexer.next())).toEqual({
				value: "bad q here",
				type: TokenType.LiteralString,
			})
			expect(lexer.errors).toHaveLength(1)
			expect(lexer.errors[0].code).toBe("invalid-escape")
		})

		it("should read an escaped brace as a literal brace, not a hole", () => {
			let lexer = new Lexer()

			lexer.reset('"a \\{ b \\} c"')

			expect(stripPosition(lexer.next())).toEqual({
				value: "a { b } c",
				type: TokenType.LiteralString,
			})
		})

		it("should split a hole into Start/Expression/End tokens", () => {
			let lexer = new Lexer()

			lexer.reset('"Hello, {name}!"')

			expect(
				stripPositionFromArray([
					lexer.next(),
					lexer.next(),
					lexer.next(),
				]),
			).toEqual([
				{ value: "Hello, ", type: TokenType.LiteralStringStart },
				{ value: "name", type: TokenType.Identifier },
				{ value: "!", type: TokenType.LiteralStringEnd },
			])
		})

		it("should mark chunks between holes as Middle", () => {
			let lexer = new Lexer()

			lexer.reset('"{a} and {b}"')

			expect(
				stripPositionFromArray([
					lexer.next(),
					lexer.next(),
					lexer.next(),
					lexer.next(),
					lexer.next(),
				]),
			).toEqual([
				{ value: "", type: TokenType.LiteralStringStart },
				{ value: "a", type: TokenType.Identifier },
				{ value: " and ", type: TokenType.LiteralStringMiddle },
				{ value: "b", type: TokenType.Identifier },
				{ value: "", type: TokenType.LiteralStringEnd },
			])
		})

		it("should balance Record braces inside a hole against the hole's own", () => {
			let lexer = new Lexer()

			lexer.reset('"outer { {a = 1} } end"')

			expect(
				stripPositionFromArray([
					lexer.next(),
					lexer.next(),
					lexer.next(),
					lexer.next(),
					lexer.next(),
					lexer.next(),
					lexer.next(),
				]),
			).toEqual([
				{ value: "outer ", type: TokenType.LiteralStringStart },
				{ value: "{", type: TokenType.SymbolLeftBrace },
				{ value: "a", type: TokenType.Identifier },
				{ value: "=", type: TokenType.SymbolEqual },
				{ value: "1", type: TokenType.LiteralNumber },
				{ value: "}", type: TokenType.SymbolRightBrace },
				{ value: " end", type: TokenType.LiteralStringEnd },
			])
			expect(lexer.next()).toBeUndefined()
		})

		it("should lex a String nested inside a hole", () => {
			let lexer = new Lexer()

			lexer.reset('"outer {"inner {x}"} done"')

			expect(
				stripPositionFromArray([
					lexer.next(),
					lexer.next(),
					lexer.next(),
					lexer.next(),
					lexer.next(),
				]),
			).toEqual([
				{ value: "outer ", type: TokenType.LiteralStringStart },
				{ value: "inner ", type: TokenType.LiteralStringStart },
				{ value: "x", type: TokenType.Identifier },
				{ value: "", type: TokenType.LiteralStringEnd },
				{ value: " done", type: TokenType.LiteralStringEnd },
			])
		})

		it("should throw on a hole that is never closed", () => {
			let lexer = new Lexer()

			lexer.reset('"open {x')

			expect(() => {
				lexer.next()
				lexer.next()
				lexer.next()
			}).toThrow()
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

			expect(
				stripPositionFromArray([lexer.next(), lexer.next()]),
			).toEqual(output)
		})

		it("should lex a doubled sigil as a Documentation Comment", () => {
			let lexer = new Lexer()

			lexer.reset("§§ Documentation")

			expect(stripPosition(lexer.next())).toEqual({
				value: "§§ Documentation",
				type: TokenType.DocComment,
			})
		})

		it("should still lex a spaced out sigil as an ordinary Comment", () => {
			let lexer = new Lexer()

			lexer.reset("§ § not documentation")

			expect(stripPosition(lexer.next())).toEqual({
				value: "§ § not documentation",
				type: TokenType.Comment,
			})
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

			expect(
				stripPositionFromArray([
					lexer.next(),
					lexer.next(),
					lexer.next(),
				]),
			).toEqual(output)
		})

		it("should end an identifier at a Comment written against it", () => {
			let lexer = new Lexer()
			let input: string
			let output: Array<SimpleToken>

			input = "y§ doubled later"
			output = [
				{ value: "y", type: TokenType.Identifier },
				{ value: "§ doubled later", type: TokenType.Comment },
			]

			lexer.reset(input)

			expect(
				stripPositionFromArray([lexer.next(), lexer.next()]),
			).toEqual(output)
		})

		it("should end a Keyword at a Comment written against it", () => {
			let lexer = new Lexer()
			let input: string
			let output: Array<SimpleToken>

			input = "else§ note"
			output = [
				{ value: "else", type: TokenType.KeywordElse },
				{ value: "§ note", type: TokenType.Comment },
			]

			lexer.reset(input)

			expect(
				stripPositionFromArray([lexer.next(), lexer.next()]),
			).toEqual(output)
		})

		it("should end an identifier at a String written against it", () => {
			let lexer = new Lexer()
			let input: string
			let output: Array<SimpleToken>

			input = 'name"text"'
			output = [
				{ value: "name", type: TokenType.Identifier },
				{ value: "text", type: TokenType.LiteralString },
			]

			lexer.reset(input)

			expect(
				stripPositionFromArray([lexer.next(), lexer.next()]),
			).toEqual(output)
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

		it("should lex match", () => {
			let lexer = new Lexer()
			let input: string
			let output: SimpleToken

			input = "match"
			output = {
				value: "match",
				type: TokenType.KeywordMatch,
			}

			lexer.reset(input)

			expect(stripPosition(lexer.next())).toEqual(output)
		})

		it("should lex case", () => {
			let lexer = new Lexer()
			let input: string
			let output: SimpleToken

			input = "case"
			output = {
				value: "case",
				type: TokenType.KeywordCase,
			}

			lexer.reset(input)

			expect(stripPosition(lexer.next())).toEqual(output)
		})

		it("should lex with", () => {
			let lexer = new Lexer()
			let input: string
			let output: SimpleToken

			input = "with"
			output = {
				value: "with",
				type: TokenType.KeywordWith,
			}

			lexer.reset(input)

			expect(stripPosition(lexer.next())).toEqual(output)
		})

		it("should lex protocol", () => {
			let lexer = new Lexer()
			let input: string
			let output: SimpleToken

			input = "protocol"
			output = {
				value: "protocol",
				type: TokenType.KeywordProtocol,
			}

			lexer.reset(input)

			expect(stripPosition(lexer.next())).toEqual(output)
		})

		it("should lex is as an Identifier", () => {
			let lexer = new Lexer()
			let input: string
			let output: SimpleToken

			input = "is"
			output = {
				value: "is",
				type: TokenType.Identifier,
			}

			lexer.reset(input)

			expect(stripPosition(lexer.next())).toEqual(output)
		})

		it("should lex import", () => {
			let lexer = new Lexer()
			let input: string
			let output: SimpleToken

			input = "import"
			output = {
				value: "import",
				type: TokenType.KeywordImport,
			}

			lexer.reset(input)

			expect(stripPosition(lexer.next())).toEqual(output)
		})

		it("should lex export", () => {
			let lexer = new Lexer()
			let input: string
			let output: SimpleToken

			input = "export"
			output = {
				value: "export",
				type: TokenType.KeywordExport,
			}

			lexer.reset(input)

			expect(stripPosition(lexer.next())).toEqual(output)
		})

		it("should lex from", () => {
			let lexer = new Lexer()
			let input: string
			let output: SimpleToken

			input = "from"
			output = {
				value: "from",
				type: TokenType.KeywordFrom,
			}

			lexer.reset(input)

			expect(stripPosition(lexer.next())).toEqual(output)
		})

		it("should lex as", () => {
			let lexer = new Lexer()
			let input: string
			let output: SimpleToken

			input = "as"
			output = {
				value: "as",
				type: TokenType.KeywordAs,
			}

			lexer.reset(input)

			expect(stripPosition(lexer.next())).toEqual(output)
		})

		// NOTE: The four Module Keywords are contextual — `from` and `as` are
		// Argument labels the standard library writes, so the Lexer hands them
		// over as Keywords and the Parser reads them as Identifiers everywhere a
		// Module section is not being parsed.
		it("should lex a Module Keyword written as an Argument label", () => {
			let lexer = new Lexer()
			let input: string
			let output: Array<SimpleToken>

			input = "slice(from 1)"
			output = [
				{ value: "slice", type: TokenType.Identifier },
				{ value: "(", type: TokenType.SymbolLeftParen },
				{ value: "from", type: TokenType.KeywordFrom },
				{ value: "1", type: TokenType.LiteralNumber },
				{ value: ")", type: TokenType.SymbolRightParen },
			]

			lexer.reset(input)

			expect(
				stripPositionFromArray([
					lexer.next(),
					lexer.next(),
					lexer.next(),
					lexer.next(),
					lexer.next(),
				]),
			).toEqual(output)
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

		it("should lex a valid Number without reporting an error", () => {
			let lexer = new Lexer()

			lexer.reset("1000")
			lexer.next()

			expect(lexer.errors).toEqual([])
		})

		// NOTE: Essence has no hexadecimal, binary or exponent form, so each of
		// these is a Number Literal holding something no Number can hold. They
		// used to be taken as written — `0xFF` became 255 — or to reach the
		// Rewriter and fail there, with no position to point at.
		for (let malformed of ["0xFF", "0b101", "0o17", "1e5", "12abc"]) {
			it(`should report ${malformed} as an invalid Number`, () => {
				let lexer = new Lexer()

				lexer.reset(malformed)

				let token = lexer.next()

				expect(token?.type).toBe(TokenType.LiteralNumber)
				expect(lexer.errors).toHaveLength(1)
				expect(lexer.errors[0].message).toBe(
					`'${malformed}' is not a valid Number`,
				)
				expect(lexer.errors[0].position).toEqual({
					start: { line: 1, column: 1 },
					end: { line: 1, column: malformed.length + 1 },
				})
			})
		}

		it("should keep only the digits of an invalid Number", () => {
			let lexer = new Lexer()

			lexer.reset("12abc")

			expect(lexer.next()?.value).toBe("12")
		})

		it("should not leave the letters of an invalid Number behind", () => {
			let lexer = new Lexer()

			lexer.reset("0xFF")
			lexer.next()

			expect(lexer.next()).toBeUndefined()
		})

		it("should end a Number at a String written against it", () => {
			let lexer = new Lexer()

			lexer.reset('5"text"')

			expect(
				stripPositionFromArray([lexer.next(), lexer.next()]),
			).toEqual([
				{ value: "5", type: TokenType.LiteralNumber },
				{ value: "text", type: TokenType.LiteralString },
			])
			expect(lexer.errors).toEqual([])
		})

		it("should forget the errors of the previous input on reset", () => {
			let lexer = new Lexer()

			lexer.reset("1e5")
			lexer.next()

			lexer.reset("5")
			lexer.next()

			expect(lexer.errors).toEqual([])
		})
	})
})
