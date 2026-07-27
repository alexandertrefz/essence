import { type common, lexer } from "@essence/interfaces"

import { primary, reportError, reportWarning } from "../../diagnostics/index"
import { Lexer } from "../../lexer/index"
import {
	type DocumentationLine,
	type DocumentationProblem,
	parseDocumentation,
} from "../documentation"

const TokenType = lexer.TokenType
type Token = lexer.Token

// NOTE: Deliberately not an `Error` subclass. Speculative parsing throws and
// catches this on every backtrack, and capturing a stack trace per throw is
// the single most expensive thing the parser does. Nothing outside the parser
// ever sees a ParseError — it is caught by `backtrack` or by the Statement
// loops, which read only `message`, `position` and `label`.
export class ParseError {
	name = "ParseError"
	message: string
	position: common.Position | null
	// NOTE: What belongs under the arrow at `position` — "expected ':'" —
	// as opposed to `message`, which is the whole sentence. The renderer puts
	// them in different places, so they are kept apart here.
	label: string | null

	constructor(
		message: string,
		position: common.Position | null = null,
		label: string | null = null,
	) {
		this.message = message
		this.position = position
		this.label = label
	}
}

// NOTE: All parse failures are routed through this single helper. The
// statement loops catch the resulting ParseError, report it as a Diagnostic
// and resynchronise.
export function fail(
	message: string,
	position?: common.Position,
	label?: string,
): never {
	throw new ParseError(message, position ?? null, label ?? null)
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
	[TokenType.SymbolHash]: "#",
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
	[TokenType.KeywordProtocol]: "protocol",
	[TokenType.KeywordFor]: "for",
	[TokenType.KeywordInfer]: "infer",
	[TokenType.KeywordChoice]: "choice",
	[TokenType.KeywordImport]: "import",
	[TokenType.KeywordExport]: "export",
	[TokenType.KeywordFrom]: "from",
	[TokenType.KeywordAs]: "as",
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

	if (
		tokenType === TokenType.LiteralStringStart ||
		tokenType === TokenType.LiteralStringMiddle ||
		tokenType === TokenType.LiteralStringEnd
	) {
		return "an interpolated String"
	}

	return tokenType
}

export function describeToken(token: Token): string {
	if (token.type === TokenType.LiteralString) {
		return `'"${token.value}"'`
	}

	if (
		token.type === TokenType.LiteralStringStart ||
		token.type === TokenType.LiteralStringMiddle ||
		token.type === TokenType.LiteralStringEnd
	) {
		return "an interpolated String"
	}

	return `'${token.value}'`
}

// NOTE: Reported here rather than by `parseDocumentation`, which stays a pure
// function of the lines it is handed. This is the point where a Diagnostic
// collection exists to report into, and where `backtrack` will rewind anything
// a speculative parse reported — a Declaration that turned out to be something
// else takes its Documentation's Diagnostics with it.
function reportMissingSeparator(problem: DocumentationProblem): void {
	let head = problem.name === null ? "@returns" : `@param ${problem.name}`

	reportWarning(
		`This '@${problem.tag}' tag is not separated from its text`,
		problem.position,
		{
			code: "missing-documentation-separator",
			labels: [primary(problem.position, "an em-dash belongs here")],
			notes: [
				"A tag carrying its text on its own line separates the two with an em-dash — that is where the description begins, and how an Editor renders the tag back. A tag that leaves its text to the lines below it needs no separator.",
				"The text is lifted into the Documentation either way; what is missing is the separator, not the description.",
			],
			helps: [`Write '${head} —' before the text.`],
		},
	)
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
	// NOTE: Documentation Comments are kept out of the Token array entirely
	// and indexed by the line they sit on. The parser has many fixed offset
	// lookaheads and backtracks by Token index, all of which would have to
	// learn to step over them; keying by line costs none of that, and a
	// Comment always ends at its line break, so one line holds at most one.
	protected documentationLines: Map<number, Token>

	constructor(source: string) {
		let sourceLexer = new Lexer()

		sourceLexer.ignore(TokenType.Comment)
		sourceLexer.ignore(TokenType.Linebreak)
		sourceLexer.reset(source)

		this.tokens = []
		this.index = 0
		this.braceDepth = 0
		this.hadLexerError = false
		this.documentationLines = new Map()

		// NOTE: The Lexer throws on unterminated String Literals — its only
		// error case. That is reported as a positioned Diagnostic here and
		// lexing stops; the parser continues on the Tokens read so far and
		// suppresses the end-of-input errors the truncation necessarily
		// causes.
		try {
			let token = sourceLexer.next()
			while (token !== undefined) {
				if (token.type === TokenType.DocComment) {
					this.documentationLines.set(
						token.position.start.line,
						token,
					)
				} else {
					this.tokens.push(token)
				}

				token = sourceLexer.next()
			}
		} catch {
			let cursor = sourceLexer.save()
			let position = { start: cursor, end: cursor }

			reportError("This String Literal is never closed", position, {
				code: "unclosed-string",
				labels: [primary(position, "the input ends here")],
				helps: ["Add the missing '\"'."],
			})

			this.hadLexerError = true
		}

		// NOTE: A malformed Number Literal or a bad escape does not truncate the
		// stream — the Token is there, it just can not hold the text that was
		// written — so both are reported without setting `hadLexerError`: every
		// Diagnostic after them is about a Statement that was read in full.
		for (let error of sourceLexer.errors) {
			if (error.code === "invalid-escape") {
				reportError(error.message, error.position, {
					code: "invalid-escape",
					labels: [
						primary(error.position, "this escape is not known"),
					],
					notes: [
						"A String understands '\\\"', '\\\\', '\\n', '\\t', '\\{' and '\\}'; every other backslash is an error.",
					],
					helps: [
						"Write '\\\\' for a literal backslash, or drop the backslash to keep the character as itself.",
					],
				})

				continue
			}

			reportError(error.message, error.position, {
				code: "invalid-number",
				labels: [primary(error.position, "this is not a Number")],
				notes: [
					"A Number is written in decimal digits, grouped with '_' where that helps — 1_000_000.",
				],
				helps: [
					"Essence has no hexadecimal, binary or exponent form; write the value in digits.",
				],
			})
		}
	}

	get depth(): number {
		return this.braceDepth
	}

	// NOTE: Whether the next Token opens a line of its own. A Declaration may
	// share its line with the signature it owns — `function greet (…)` is one
	// line and one Declaration — but a Parameter sitting on that same line is
	// a smaller thing than what the block above it documents, and must not
	// claim it.
	startsLine(): boolean {
		let token = this.peek()

		if (token === undefined) {
			return false
		}

		let previous = this.tokens[this.index - 1]

		return (
			previous === undefined ||
			previous.position.end.line < token.position.start.line
		)
	}

	// NOTE: The run of `§§` Comments directly above `line`. Any gap ends the
	// run — a blank line or an ordinary `§` Comment in between means the block
	// was written about something else, so it documents nothing.
	documentationAbove(line: number): common.Documentation | null {
		let lines: Array<DocumentationLine> = []
		let start: common.Cursor | null = null
		let end: common.Cursor | null = null

		for (
			let current = line - 1;
			this.documentationLines.has(current);
			current--
		) {
			let token = this.documentationLines.get(current) as Token

			lines.unshift({ text: token.value, position: token.position })
			start = token.position.start
			end ??= token.position.end
		}

		if (start === null || end === null) {
			return null
		}

		let { documentation, problems } = parseDocumentation(lines, {
			start,
			end,
		})

		for (let problem of problems) {
			reportMissingSeparator(problem)
		}

		return documentation
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
				`expected ${describeTokenType(tokenType)}`,
			)
		}

		if (token.type !== tokenType) {
			fail(
				`Expected ${describeTokenType(tokenType)} but found ${describeToken(token)}.`,
				token.position,
				`expected ${describeTokenType(tokenType)}`,
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
