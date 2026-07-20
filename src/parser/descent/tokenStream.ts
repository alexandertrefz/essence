import { reportError } from "../../diagnostics/index"
import { type common, lexer } from "../../interfaces/index"
import { Lexer } from "../../lexer/index"

const TokenType = lexer.TokenType
type Token = lexer.Token

export class ParseError extends Error {
	position: common.Position | null

	constructor(message: string, position: common.Position | null = null) {
		super(message)
		this.name = "ParseError"
		this.position = position
	}
}

// NOTE: All parse failures are routed through this single helper. The
// statement loops catch the resulting ParseError, report it as a Diagnostic
// and resynchronise.
export function fail(message: string, position?: common.Position): never {
	throw new ParseError(message, position ?? null)
}

// NOTE: The written form of every fixed-content Token type, used to phrase
// Diagnostics like `Expected ')' but found 'if'.`.
const tokenTypeLexemes: { [tokenType in lexer.TokenType]?: string } = {
	[TokenType.SymbolAt]: "@",
	[TokenType.SymbolEqual]: "=",
	[TokenType.SymbolColon]: ":",
	[TokenType.SymbolTilde]: "~",
	[TokenType.SymbolDot]: ".",
	[TokenType.SymbolComma]: ",",
	[TokenType.SymbolUnderscore]: "_",
	[TokenType.SymbolDash]: "-",
	[TokenType.SymbolPipe]: "|",
	[TokenType.SymbolSlash]: "/",
	[TokenType.SymbolLeftParen]: "(",
	[TokenType.SymbolRightParen]: ")",
	[TokenType.SymbolLeftBrace]: "{",
	[TokenType.SymbolRightBrace]: "}",
	[TokenType.SymbolLeftBracket]: "[",
	[TokenType.SymbolRightBracket]: "]",
	[TokenType.SymbolLeftAngle]: "<",
	[TokenType.SymbolRightAngle]: ">",
	[TokenType.LiteralTrue]: "true",
	[TokenType.LiteralFalse]: "false",
	[TokenType.LiteralNothing]: "nothing",
	[TokenType.KeywordType]: "type",
	[TokenType.KeywordIf]: "if",
	[TokenType.KeywordElse]: "else",
	[TokenType.KeywordStatic]: "static",
	[TokenType.KeywordConstant]: "constant",
	[TokenType.KeywordVariable]: "variable",
	[TokenType.KeywordFunction]: "function",
	[TokenType.KeywordImplementation]: "implementation",
	[TokenType.KeywordOverload]: "overload",
	[TokenType.KeywordMatch]: "match",
	[TokenType.KeywordCase]: "case",
	[TokenType.KeywordWith]: "with",
	[TokenType.KeywordNamespace]: "namespace",
	[TokenType.KeywordFor]: "for",
}

export function describeTokenType(tokenType: lexer.TokenType): string {
	let lexeme = tokenTypeLexemes[tokenType]

	if (lexeme !== undefined) {
		return `'${lexeme}'`
	}

	if (tokenType === TokenType.Identifier) {
		return "an Identifier"
	}

	if (tokenType === TokenType.LiteralNumber) {
		return "a Number"
	}

	if (tokenType === TokenType.LiteralString) {
		return "a String"
	}

	return tokenType
}

export function describeToken(token: Token): string {
	if (token.type === TokenType.LiteralString) {
		return `'"${token.value}"'`
	}

	return `'${token.value}'`
}

export type TokenStreamState = {
	index: number
	braceDepth: number
}

export class TokenStream {
	protected tokens: Array<Token>
	protected index: number
	protected braceDepth: number
	public hadLexerError: boolean

	constructor(source: string) {
		let sourceLexer = new Lexer()

		sourceLexer.ignore(TokenType.Comment)
		sourceLexer.ignore(TokenType.Linebreak)
		sourceLexer.reset(source)

		this.tokens = []
		this.index = 0
		this.braceDepth = 0
		this.hadLexerError = false

		// NOTE: The Lexer throws on unterminated String Literals — its only
		// error case. That is reported as a positioned Diagnostic here and
		// lexing stops; the parser continues on the Tokens read so far and
		// suppresses the end-of-input errors the truncation necessarily
		// causes.
		try {
			let token = sourceLexer.next()
			while (token !== undefined) {
				this.tokens.push(token)
				token = sourceLexer.next()
			}
		} catch {
			let cursor = sourceLexer.save()

			reportError("String Literal is never closed.", {
				start: cursor,
				end: cursor,
			})

			this.hadLexerError = true
		}
	}

	get depth(): number {
		return this.braceDepth
	}

	peek(offset = 0): Token | undefined {
		return this.tokens[this.index + offset]
	}

	next(): Token {
		let token = this.tokens[this.index]

		if (token === undefined) {
			fail("Unexpected end of input.", this.endPosition())
		}

		this.index++

		if (token.type === TokenType.SymbolLeftBrace) {
			this.braceDepth++
		} else if (token.type === TokenType.SymbolRightBrace) {
			this.braceDepth--
		}

		return token
	}

	expect(tokenType: lexer.TokenType): Token {
		let token = this.tokens[this.index]

		if (token === undefined) {
			fail(
				`Expected ${describeTokenType(tokenType)} but found end of input.`,
				this.endPosition(),
			)
		}

		if (token.type !== tokenType) {
			fail(
				`Expected ${describeTokenType(tokenType)} but found ${describeToken(token)}.`,
				token.position,
			)
		}

		return this.next()
	}

	save(): TokenStreamState {
		return { index: this.index, braceDepth: this.braceDepth }
	}

	restore(state: TokenStreamState) {
		this.index = state.index
		this.braceDepth = state.braceDepth
	}

	isAtEnd(): boolean {
		return this.index >= this.tokens.length
	}

	// NOTE: Used to position end-of-input Diagnostics — the end of the last
	// Token of the input, or the very start of the file when it has none.
	endPosition(): common.Position {
		let lastToken = this.tokens[this.tokens.length - 1]

		if (lastToken === undefined) {
			return {
				start: { line: 1, column: 1 },
				end: { line: 1, column: 1 },
			}
		}

		return { start: lastToken.position.end, end: lastToken.position.end }
	}
}
