import { type common, lexer } from "@essence-lang/interfaces"

import {
	primary,
	reportError,
	reportWarning,
	secondary,
} from "../../diagnostics/index"
import { Lexer, UnterminatedStringError } from "../../lexer/index"
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
// loops, which turn it into the one Diagnostic its fields describe.
export class ParseError {
	name = "ParseError"
	message: string
	position: common.Position | null
	// NOTE: What belongs under the arrow at `position` — "expected ':'" —
	// as opposed to `message`, which is the whole sentence. The renderer puts
	// them in different places, so they are kept apart here.
	label: string | null
	// NOTE: The Labels BESIDE the primary one, in the order they render. Empty
	// for almost every ParseError — a failed expectation is about one Token and
	// has nothing to point at twice — and set by the few refusals that are about
	// a relationship between two spans, where the second is what turns the claim
	// into an explanation.
	labels: Array<common.DiagnosticLabel>
	// NOTE: Almost every ParseError is the generic "expected X, found Y" and
	// reports as `syntax-error` with nothing to add. The few that are their
	// own kind of problem carry their code and context here, so the Statement
	// loop that finally reports them needs no knowledge of which failure it
	// caught.
	code: common.DiagnosticCode
	notes: Array<string>
	helps: Array<string>
	// NOTE: What a Quick Fix would need of the refusal, for the few that have
	// one. A refused Statement is DROPPED, so whatever the Parser saw of it —
	// the names a Matcher introduced, the span of a block — survives nowhere
	// else, and a fix that re-derived it would be re-reading text this Parser
	// has already read.
	data: common.DiagnosticData | undefined
	// NOTE: Whether what went wrong here has already been said. A recovery loop
	// reports the failure it recovered FROM and then discovers that what it
	// recovered INTO can not be built — the loop's own Diagnostic is the whole
	// account of that, so the throw which drops the Statement carries this and
	// `reportParseError` stays quiet rather than saying the same thing twice in
	// different words.
	reported: boolean

	constructor(
		message: string,
		position: common.Position | null = null,
		label: string | null = null,
		details: {
			code?: common.DiagnosticCode
			labels?: Array<common.DiagnosticLabel>
			notes?: Array<string>
			helps?: Array<string>
			data?: common.DiagnosticData
			reported?: boolean
		} = {},
	) {
		this.message = message
		this.position = position
		this.label = label
		this.code = details.code ?? "syntax-error"
		this.labels = details.labels ?? []
		this.notes = details.notes ?? []
		this.helps = details.helps ?? []
		this.data = details.data
		this.reported = details.reported ?? false
	}
}

// NOTE: The codes a speculation gives back when it rewinds, rather than
// letting them through to the Statement loop. `syntax-error` is the generic
// failure — "this reading was not the one written" — which is the whole point
// of speculating, and `nesting-too-deep` is about the READING rather than
// about the text: a speculation recurs a level deeper than the reading it
// stands in for, so an attempt can exhaust the depth budget where the reading
// that is kept fits inside it, and re-raising it would refuse a Program this
// Parser accepts. Every other code is a refusal of text that WAS written, and
// no other reading of that text is going to accept it.
const rewoundCodes: Set<common.DiagnosticCode> = new Set([
	"syntax-error",
	"nesting-too-deep",
])

// NOTE: Whether a ParseError is a verdict about the text — a refusal that
// stands whichever reading of the surrounding construct is taken — as opposed
// to one reading saying it was not the one written.
//
// An already REPORTED failure is one by definition: a recovery loop read the
// text, judged it, and said so. Handing that back for a second reading would
// answer for text this Parser has already spoken about.
export function refusesTheText(error: ParseError): boolean {
	return error.reported || !rewoundCodes.has(error.code)
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
	[TokenType.KeywordDefine]: "define",
	[TokenType.KeywordOtherwise]: "otherwise",
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
	[TokenType.KeywordTests]: "tests",
	[TokenType.KeywordTest]: "test",
	[TokenType.KeywordSuite]: "suite",
	[TokenType.KeywordBenchmark]: "benchmark",
	[TokenType.KeywordExpect]: "expect",
	[TokenType.KeywordRequire]: "require",
	[TokenType.KeywordStart]: "start",
	[TokenType.KeywordComplete]: "complete",
}

function describeTokenType(tokenType: lexer.TokenType): string {
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

// NOTE: The span of the one character a quote Cursor stands on. Every Label in
// the unclosed-String report points at a `"`, and a zero-width span renders as
// an arrow at nothing.
function quoteAt(cursor: common.Cursor): common.Position {
	return {
		start: cursor,
		end: { line: cursor.line, column: cursor.column + 1 },
	}
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
	// NOTE: Where the next `~` is, from every position. `Type ~> { … }` is the
	// one construction in the grammar that a `~` can be part of, and it is the
	// one the parser speculates on for every Identifier it reads in Expression
	// position — a full Type parse, thrown away on the `~` that is not there.
	// A speculation can only consume Tokens FORWARD from where it starts, so a
	// position with no `~` after it is a position where that parse can not
	// succeed, whatever else stands there. That is the whole test, and it is
	// deliberately no sharper: neither the `>` following the `~` nor the two
	// being written flush is required by `parseTypedRecordLiteral`, so a guard
	// that asked for either would refuse a Program this parser accepts.
	protected nextTilde: Int32Array
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
		} catch (error) {
			if (!(error instanceof UnterminatedStringError)) {
				throw error
			}

			this.reportUnterminatedString(error, source)

			this.hadLexerError = true
		}

		// NOTE: A malformed Number Literal or a bad escape does not truncate the
		// stream — the Token is there, it just can not hold the text that was
		// written — so both are reported without setting `hadLexerError`: every
		// Diagnostic after them is about a Statement that was read in full.
		for (let error of sourceLexer.errors) {
			if (error.code === "comment-in-hole") {
				reportError(error.message, error.position, {
					code: "comment-in-hole",
					labels: [
						primary(
							error.position,
							"this Comment would swallow the rest of the String",
						),
					],
					notes: [
						"A Comment runs to the end of its line — inside a hole it would take the hole's '}' and the String's closing '\"' with it.",
					],
					helps: [
						"Move the Comment out of the String — behind the closing '\"' works.",
					],
				})

				continue
			}

			if (error.code === "invalid-escape") {
				reportError(error.message, error.position, {
					code: "invalid-escape",
					labels: [
						primary(error.position, "this escape is not known"),
					],
					notes: [
						"A String understands '\\\"', '\\\\', '\\n', '\\r', '\\t', '\\{' and '\\}'; every other backslash is an error.",
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
					"A Number is written in the digits '0' through '9', grouped with '_' where that helps, with a fractional part written behind a '.' — 1_000_000, 19.99.",
				],
				helps: [
					"Essence has no hexadecimal, binary or exponent form; write the value in digits.",
				],
			})
		}

		// NOTE: One backward pass, and one entry past the end so that a query at
		// the end of the stream is answered without a bounds test.
		this.nextTilde = new Int32Array(this.tokens.length + 1)
		this.nextTilde[this.tokens.length] = this.tokens.length

		for (let index = this.tokens.length - 1; index >= 0; index--) {
			this.nextTilde[index] =
				this.tokens[index]?.type === TokenType.SymbolTilde
					? index
					: this.nextTilde[index + 1]!
		}
	}

	// NOTE: The one fatal Lexer error, which stops the Token stream where it
	// stands — and the one Diagnostic the Parser reports before it has read a
	// Token.
	protected reportUnterminatedString(
		error: UnterminatedStringError,
		source: string,
	): void {
		// NOTE: `endOfInput` is where the Lexer STOPPED — one line past the
		// last one when the file ends in a newline, where a label has no text
		// to point at and renders dangling. Clamped to just after the last
		// visible character, the way `endPosition()` keeps the parser's own
		// end-of-input Diagnostics on real content. Counted character by
		// character as the Lexer counts, so the two spellings of one column can
		// not drift.
		let endOfContent = { line: 1, column: 1 }

		for (let character of source.trimEnd()) {
			endOfContent =
				character === "\n"
					? { line: endOfContent.line + 1, column: 1 }
					: {
							line: endOfContent.line,
							column: endOfContent.column + 1,
						}
		}

		let position = { start: endOfContent, end: endOfContent }
		let swallower = error.swallower

		if (swallower === null) {
			reportError("This String Literal is never closed", position, {
				code: "unclosed-string",
				labels: [
					primary(position, "the input ends here"),
					secondary(quoteAt(error.openedAt), "opened here"),
				],
				helps: ["Add the missing '\"'."],
			})

			return
		}

		// NOTE: The likelier reading of two — see `swallowedTheLinesBelow` in
		// the Lexer, which decides between them and says why. The String NAMED
		// here is the one that SPANS LINES, because that is the '"' a reader has
		// to write; the quote it closed on and the end of the input are both
		// still pointed at, so the reading this one was chosen over stands on
		// the page rather than only in the Lexer.
		//
		// NOTE: The Position is the opening quote rather than the end of the
		// input, which is the one place this parts company with
		// `unclosed-block`: what an Editor jumps to, and what `essence check`
		// prints as `file:line:column`, is then the line the missing '"' belongs
		// on. The plain case keeps the end of the input, where the String really
		// does run out.
		//
		// NOTE: The opening quote is the FIRST Label standing on a `"`, which is
		// the shape the `unclosed-string` Quick Fix reads the String's start off
		// — see `closeStringAction`. It writes the quote at the end of that
		// Label's line, so the swapped report moves the fix with it.
		reportError(
			"This String Literal is never closed",
			quoteAt(swallower.openedAt),
			{
				code: "unclosed-string",
				labels: [
					primary(quoteAt(swallower.openedAt), "opened here"),
					secondary(
						quoteAt(swallower.closedAt),
						"closed by this quote, which reads as the start of another String",
					),
					secondary(position, "and the input ends inside that one"),
				],
				notes: [
					`A String Literal may span lines, and the line breaks are part of it — so the quote on line ${swallower.closedAt.line} closed the one opened on line ${swallower.openedAt.line}, and the String that quote was written to open is the one that ran to the end of the input.`,
					`One '"' is missing either way. It is reported against the String that spans lines, because a String written to span them is not usually followed, on the line it closes, by a second one that never closes at all.`,
				],
				helps: [
					`Add the missing '"' at the end of line ${swallower.openedAt.line}.`,
					`Or, if line ${swallower.openedAt.line} was meant to carry the lines below it, add it at the end of the input instead.`,
				],
			},
		)
	}

	// NOTE: Whether a `Type ~> { … }` can begin here at all — see `nextTilde`.
	hasTildeAhead(): boolean {
		return this.nextTilde[this.index]! < this.tokens.length
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

	// NOTE: The Token that CLOSES a bracketed construction, expected where the
	// construction has stopped growing. It differs from a plain `expect` in one
	// thing: the Label beside the primary one, which says where the bracket it
	// would close was opened. A bracket left open is noticed at the first Token
	// that can not carry its contents on, and that Token is usually nowhere
	// near the mistake — the reader is told "expected ')'" about a line that
	// holds no parenthesis at all, and has to find the opening one by counting.
	//
	// NOTE: "opened here" rather than "this '(' is never closed", which is what
	// it looks like from the inside and is not what this knows. The `)` may
	// stand two Tokens further on, with a stray `+` in front of it: the bracket
	// is open AT THIS TOKEN, which is the whole of the claim, and it is the same
	// claim `parseClosingBrace` and the unclosed-String report make in the same
	// words.
	//
	// NOTE: And only where the two stand on different LINES. A bracket and the
	// Token that would not close it written on one line are both under the
	// reader's eye already, and a second arrow at a character they can see is
	// noise: `print(1 + 2)` is answered with "expected ')'" at the `+` and
	// nothing else, exactly as it always was. What nobody finds by looking is
	// the bracket opened four lines up.
	expectClosing(tokenType: lexer.TokenType, opening: Token): Token {
		let token = this.tokens[this.index]

		if (token !== undefined && token.type === tokenType) {
			return this.next()
		}

		this.failClosing(tokenType, opening)
	}

	// NOTE: The failure `expectClosing` raises, thrown by hand where a reading
	// has already decided that the closing Token is not there — an Argument
	// whose Expression stopped short of the bracket is the case in point, and
	// it must fail in the SAME words the Argument list's own close would, or
	// which of the two readings is reported becomes visible to the reader.
	failClosing(tokenType: lexer.TokenType, opening: Token): never {
		let token = this.tokens[this.index]
		let position = token?.position ?? this.endPosition()
		let found = token === undefined ? "end of input" : describeToken(token)

		throw new ParseError(
			`Expected ${describeTokenType(tokenType)} but found ${found}.`,
			position,
			`expected ${describeTokenType(tokenType)}`,
			{
				labels:
					opening.position.start.line === position.start.line
						? []
						: [secondary(opening.position, "opened here")],
			},
		)
	}

	// NOTE: How far into the Token array the reading has got — the measure
	// furthest-failure tracking compares two readings by. A number rather than
	// `save()`, which allocates a state object, because this is asked on the
	// failure path of every speculation.
	get offset(): number {
		return this.index
	}

	save(): TokenStreamState {
		return { index: this.index, braceDepth: this.braceDepth }
	}

	// NOTE: The Tokens between two saved offsets, which is what a recovery reads
	// to learn what it just walked past — see `Recovery`. Absolute indices
	// rather than a `peek` offset, because the reading has already moved on by
	// the time the question is asked.
	between(from: number, to: number): Array<Token> {
		return this.tokens.slice(
			Math.max(from, 0),
			Math.min(to, this.tokens.length),
		)
	}

	restore(state: TokenStreamState) {
		this.index = state.index
		this.braceDepth = state.braceDepth
	}

	isAtEnd(): boolean {
		return this.index >= this.tokens.length
	}

	// NOTE: The block a file that runs out of braces most likely left open, and
	// the `}` that closed it instead. Which block a `}` closes is decided by
	// COUNTING, so a file one brace short hands every `}` below the mistake to
	// the block above the one it was written for — and the report then comes out
	// at the end of the input, about the outermost block, which is the one place
	// the mistake is not.
	//
	// Indentation is what a reader meant and what the counting ignores. A `}`
	// written further OUT than the line that opened the block it just closed is
	// a `}` meant for a block further out, so the block it took the brace from
	// is the one that never got its own. The FIRST such pair is the answer: a
	// file short of two braces is short of the innermost one first.
	//
	// Asked only where a block really is unclosed, so a file that merely writes
	// a `}` where an author would not is never measured by this at all.
	outdentedClose(): { opened: Token; closed: Token } | null {
		let stack: Array<{ brace: Token; indent: number }> = []
		let lineStart = new Map<number, number>()

		for (let token of this.tokens) {
			let line = token.position.start.line

			if (!lineStart.has(line)) {
				lineStart.set(line, token.position.start.column)
			}

			if (token.type === TokenType.SymbolLeftBrace) {
				stack.push({
					brace: token,
					indent: lineStart.get(line) as number,
				})

				continue
			}

			if (token.type !== TokenType.SymbolRightBrace) {
				continue
			}

			let opened = stack.pop()

			if (
				opened !== undefined &&
				token.position.start.column < opened.indent
			) {
				return { opened: opened.brace, closed: token }
			}
		}

		return null
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
