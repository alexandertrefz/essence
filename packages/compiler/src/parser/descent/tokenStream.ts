import { type common, lexer } from "@essence-lang/interfaces"

import {
	primary,
	reportError,
	reportWarning,
	secondary,
} from "../../diagnostics/index"
import {
	type ParameterListOwner,
	receiverWords,
	writtenReceiverAccount,
} from "../../helpers/foreign"
import { holeHoldsAnEscape } from "../../helpers/stringHoles"
import {
	escapeSetSentence,
	Lexer,
	type StringHole,
	UnterminatedStringError,
} from "../../lexer/index"
import {
	type DocumentationLine,
	type DocumentationProblem,
	parseDocumentation,
} from "../documentation"

const TokenType = lexer.TokenType
type Token = lexer.Token

// Not an `Error` subclass: speculation throws and catches one on every
// backtrack, and capturing a stack trace per throw is costly. The parser
// always catches it and reports the Diagnostic its fields describe.
export class ParseError {
	name = "ParseError"
	message: string
	position: common.Position | null
	// What belongs under the arrow at `position`, such as "expected ':'".
	// `message` is the whole sentence, which the renderer places elsewhere.
	label: string | null
	// The Labels beside the primary one, in the order they render. Only a
	// refusal about a relationship between two spans sets them.
	labels: Array<common.DiagnosticLabel>
	// A generic "expected X, found Y" reports as `syntax-error`. A refusal
	// with a kind of its own carries its code and context here for the loop
	// that reports it.
	code: common.DiagnosticCode
	notes: Array<string>
	helps: Array<string>
	// What a Quick Fix needs of the refusal. A refused Statement is dropped,
	// so what the Parser saw of it, such as the names a Matcher introduced,
	// survives only here.
	data: common.DiagnosticData | undefined
	// Whether a recovery loop has already reported this failure. Such a loop
	// reports what it recovered from, then finds that what it recovered into
	// can not be built. `reportParseError` then stays quiet.
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

// The codes a speculation gives back when it rewinds, since they are about
// the reading rather than the text. See "Refusals of the text" in
// DEVELOPMENT.md.
const rewoundCodes: Set<common.DiagnosticCode> = new Set([
	"syntax-error",
	"nesting-too-deep",
])

// Whether a ParseError is a verdict about the text, standing whichever
// reading is taken, rather than one reading saying it was not the one written.
// A failure already reported is always one.
export function refusesTheText(error: ParseError): boolean {
	return error.reported || !rewoundCodes.has(error.code)
}

// The plain parse failure, a `syntax-error` with nothing to add. A
// failure that carries a code, a second Label, notes, Helps or Quick Fix data
// throws its ParseError directly. The statement loops catch either, report it
// as a Diagnostic and resynchronise.
export function fail(
	message: string,
	position?: common.Position,
	label?: string,
): never {
	throw new ParseError(message, position ?? null, label ?? null)
}

// The written form of every fixed-content Token type, for Diagnostics like
// `Expected ')' but found 'if'.`.
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

// Reported here rather than by `parseDocumentation`, which stays a pure
// function of its lines. Here `backtrack` rewinds the report along with a
// Declaration that turned out to be something else.
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

// The span of the one character a quote or a brace Cursor stands on, since a
// zero-width span renders as an arrow at nothing.
function characterAt(cursor: common.Cursor): common.Position {
	return {
		start: cursor,
		end: { line: cursor.line, column: cursor.column + 1 },
	}
}

// The hole's `{` and its first quote are the two places an edit fixes, so
// the report labels both. See "A quote inside a hole" in
// packages/compiler/src/lexer/DEVELOPMENT.md.
function reportQuoteInHole(position: common.Position, hole: StringHole): void {
	reportError("This String Literal is never closed", position, {
		code: "unclosed-string",
		labels: [
			primary(position, "the input ends here"),
			secondary(characterAt(hole.brace), "this '{' opens a hole"),
			secondary(
				characterAt(hole.quote),
				"and this quote opens a String inside it",
			),
		],
		notes: [
			"A '{' inside a String opens a hole, which holds an Expression — so a quote written inside it opens a String of its own.",
		],
		helps: [
			"Write '\\{' for a brace that stands for itself.",
			"Or end the hole with a '}' in front of that quote, where it holds an Expression.",
		],
	})
}

// What was written from a cursor to the end of its line. The Quick Fix for
// an unclosed String asks `holeHoldsAnEscape` about the same line.
function lineFrom(source: string, cursor: common.Cursor): string {
	return (source.split("\n")[cursor.line - 1] ?? "").slice(cursor.column - 1)
}

// The Tokens a Statement that begins with a bare name continues with. See
// `beginsOwnStatement`.
const STATEMENT_CONTINUATIONS = new Set([
	TokenType.SymbolEqual,
	TokenType.SymbolColon,
	TokenType.SymbolDot,
	TokenType.SymbolLeftParen,
	TokenType.SymbolLeftBracket,
])

// Words that continue a Declaration's head on the line below it, as `is`
// does under `namespace Checks for Integer`.
const headContinuations = new Set(["is", "where"])

// Another language's operator starts with punctuation or a mathematical or
// modifier symbol, as `&&`, `+` and `^` do. The Lexer reads it as an
// Identifier, while a name such as `$total` or `π` starts otherwise.
const operatorStart = /^[\p{P}\p{Sm}\p{Sk}]/u

export type TokenStreamState = {
	index: number
	braceDepth: number
}

export class TokenStream {
	protected tokens: Array<Token>
	protected index: number
	protected braceDepth: number
	public hadLexerError: boolean
	// The index of the next `~` from every position. Only `Type ~> { … }`
	// holds a `~`, and the parser speculates on it for every Identifier in
	// Expression position. Where no `~` follows, `parseTypedRecordLiteral` can
	// not succeed.
	protected nextTilde: Int32Array
	// Documentation Comments stay out of the Token array, so lookaheads and
	// backtracks by Token index need not step over them. A Comment ends at its
	// line break, so keying by line holds at most one per line.
	protected documentationLines: Map<number, Token>
	protected source: string
	// Split on the first recovery that compares indentation.
	protected sourceLines: Array<string> | null = null

	constructor(source: string) {
		this.source = source

		let sourceLexer = new Lexer()

		sourceLexer.ignore(TokenType.Comment)
		sourceLexer.ignore(TokenType.Linebreak)
		sourceLexer.reset(source)

		this.tokens = []
		this.index = 0
		this.braceDepth = 0
		this.hadLexerError = false
		this.documentationLines = new Map()

		// An unterminated String Literal is the one mistake the Lexer throws
		// on. Lexing stops there, and the parser reads the Tokens so far with
		// end-of-input errors suppressed. The Lexer collects other mistakes.
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

		// A collected mistake does not truncate the stream, so it leaves
		// `hadLexerError` unset: every later Diagnostic is about a Statement that
		// was read in full.
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
						`A String understands ${escapeSetSentence}; every other backslash is an error.`,
					],
					helps: [
						"Write '\\\\' for a literal backslash, or drop the backslash to keep the character as itself.",
					],
				})

				continue
			}

			// The `\u{…}` escapes arrive with their Label, Notes and Helps
			// written where the escape was read. See `LexingError.report`.
			if (error.report !== undefined) {
				reportError(error.message, error.position, {
					code: error.code,
					labels: [primary(error.position, error.report.label)],
					notes: error.report.notes,
					helps: error.report.helps,
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

		// One entry past the end answers a query at the end of the stream
		// without a bounds test.
		this.nextTilde = new Int32Array(this.tokens.length + 1)
		this.nextTilde[this.tokens.length] = this.tokens.length

		for (let index = this.tokens.length - 1; index >= 0; index--) {
			this.nextTilde[index] =
				this.tokens[index]?.type === TokenType.SymbolTilde
					? index
					: this.nextTilde[index + 1]!
		}
	}

	// The one fatal Lexer error, which stops the Token stream. See "Which
	// quote is missing" in packages/compiler/src/lexer/DEVELOPMENT.md.
	protected reportUnterminatedString(
		error: UnterminatedStringError,
		source: string,
	): void {
		// The Lexer stops one line past the last when the file ends in a
		// newline, where a Label renders dangling. So the report stands just
		// after the last visible character, counted as the Lexer counts columns.
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

		// `"a } b { c"`: a quote in the hole opened a String of its own, so a
		// quote added to any line inside the hole opens one more.
		if (error.hole !== null) {
			reportQuoteInHole(position, error.hole)

			return
		}

		if (swallower === null) {
			// `"{\"a\": 1}"`: the `{` opened a hole, so a missing quote is
			// not the problem. See `holeHoldsAnEscape`.
			if (holeHoldsAnEscape(lineFrom(source, error.openedAt))) {
				reportError("This String Literal is never closed", position, {
					code: "unclosed-string",
					labels: [
						primary(position, "the input ends here"),
						secondary(
							characterAt(error.openedAt),
							"opened here, and a '{' inside it opens a hole",
						),
					],
					notes: [
						"A '{' inside a String opens a hole, which holds an Expression — so the text between the braces is read as one, and a quote written inside it opens a String of its own.",
					],
					helps: [
						"Write '\\{' and '\\}' for the braces that stand for themselves.",
					],
				})

				return
			}

			// The quote belongs where the Quick Fix writes it, not at the end
			// of the input, where it would close a String holding every line.
			reportError("This String Literal is never closed", position, {
				code: "unclosed-string",
				labels: [
					primary(position, "the input ends here"),
					secondary(characterAt(error.openedAt), "opened here"),
				],
				helps: [
					`Add the missing '"' at the end of line ${error.openedAt.line}.`,
				],
			})

			return
		}

		// The report names the String that spans lines and stands on its
		// opening quote, the first Label on a `"`, which `closeStringAction`
		// reads.
		reportError(
			"This String Literal is never closed",
			characterAt(swallower.openedAt),
			{
				code: "unclosed-string",
				labels: [
					primary(characterAt(swallower.openedAt), "opened here"),
					secondary(
						characterAt(swallower.closedAt),
						"closed by this quote, which reads as the start of another String",
					),
					secondary(position, "and the input ends inside that one"),
				],
				notes: [
					`A String Literal may span lines, and the line breaks are part of it — so the quote on line ${swallower.closedAt.line} closed the one opened on line ${swallower.openedAt.line}, and the String that quote was written to open is the one that ran to the end of the input.`,
					// The other reading is a Note rather than a Help. A quote at
					// the end of the input reaches no Program, since the quotes in
					// the swallowed lines close that String early again.
					`One '"' is missing either way, and where it goes decides which String is which: at the end of line ${swallower.openedAt.line} the lines below are Statements, and at the end of the input they are text. It is reported against the String that spans lines, because a String written to span them is not usually followed, on the line it closes, by a second one that never closes at all.`,
				],
				helps: [
					`Add the missing '"' at the end of line ${swallower.openedAt.line}.`,
				],
			},
		)
	}

	// Whether a `Type ~> { … }` can begin here at all. See `nextTilde`.
	hasTildeAhead(): boolean {
		return this.nextTilde[this.index]! < this.tokens.length
	}

	get depth(): number {
		return this.braceDepth
	}

	// Whether the next Token opens a line of its own. A Parameter on its
	// Declaration's line must not claim the Documentation written for the
	// Declaration.
	startsLine(): boolean {
		return this.opensLine(this.index)
	}

	// Whether the Token at the absolute `index` is the first on its line.
	opensLine(index: number): boolean {
		let token = this.tokens[index]

		if (token === undefined) {
			return false
		}

		let previous = this.tokens[index - 1]

		return (
			previous === undefined ||
			previous.position.end.line < token.position.start.line
		)
	}

	// Whether the name at the cursor, opening its line, begins a Statement of
	// its own. It does where nothing follows it on its line, or where a Token
	// that continues a bare name does, as in `where = 1`.
	beginsOwnStatement(): boolean {
		let token = this.peek()
		let after = this.peek(1)

		return (
			token !== undefined &&
			(after === undefined ||
				after.position.start.line !== token.position.start.line ||
				STATEMENT_CONTINUATIONS.has(after.type))
		)
	}

	// Whether a skip from the broken element at the absolute `from` stops at
	// the name at the cursor. See "Error recovery" in DEVELOPMENT.md.
	resumesAtName(from: number): boolean {
		let opening = this.tokens[from]
		let token = this.peek()

		if (
			opening === undefined ||
			token === undefined ||
			this.index <= from ||
			!this.opensLine(from) ||
			!this.startsLine() ||
			operatorStart.test(token.value) ||
			(headContinuations.has(token.value) && !this.beginsOwnStatement())
		) {
			return false
		}

		return this.indentationOf(opening).startsWith(this.indentationOf(token))
	}

	// The whitespace before `token` on its line, which opens with `token`.
	protected indentationOf(token: Token): string {
		this.sourceLines ??= this.source.split("\n")

		return (this.sourceLines[token.position.start.line - 1] ?? "").slice(
			0,
			token.position.start.column - 1,
		)
	}

	// The run of `§§` Comments on the lines just before `line`. A blank line
	// or an ordinary `§` Comment ends the run, since the block beyond it
	// documents something else.
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

	// The `(` of a Parameter list, read past a receiver written as its first
	// Parameter, as in `double(self)`. The receiver is reported and dropped, so
	// the Method keeps its other Parameters. A Function literal's inferred
	// Parameter may be named `self`, so there the word is read as written.
	openParameterList(allowsInferredTypes: boolean): Token {
		let leftParen = this.expect(TokenType.SymbolLeftParen)
		let word = this.peek()
		let after = this.peek(1)?.type

		if (
			allowsInferredTypes ||
			word?.type !== TokenType.Identifier ||
			!receiverWords.has(word.value) ||
			(after !== TokenType.SymbolRightParen &&
				after !== TokenType.SymbolComma)
		) {
			return leftParen
		}

		this.next()

		// A following `,` and the space after it go with the word.
		let end =
			after === TokenType.SymbolComma
				? (this.next(),
					this.peek()?.position.start ?? word.position.end)
				: word.position.end
		let removed = { start: word.position.start, end }
		let account = writtenReceiverAccount(
			word.value,
			this.parameterListOwner(this.tokens.indexOf(leftParen)),
		)

		reportError(account.message, word.position, {
			code: account.code,
			labels: [primary(word.position, account.label)],
			notes: account.notes,
			helps: account.helps,
			data: { kind: "essence-spelling", position: removed, spelling: "" },
		})

		return leftParen
	}

	// Whose Parameter list opens at `index`. The Token before its name and any
	// Type Parameters says: `function` or `static`, else an instance Method's or
	// a Protocol requirement's head.
	private parameterListOwner(index: number): ParameterListOwner {
		let at = index - 1

		if (this.tokens[at]?.type === TokenType.SymbolRightAngle) {
			for (let depth = 0; at >= 0; at--) {
				let type = this.tokens[at].type

				depth +=
					type === TokenType.SymbolRightAngle
						? 1
						: type === TokenType.SymbolLeftAngle
							? -1
							: 0

				if (depth === 0) {
					break
				}
			}

			at--
		}

		let keyword = this.tokens[at - 1]?.type

		return keyword === TokenType.KeywordFunction
			? "Function"
			: keyword === TokenType.KeywordStatic
				? "static Method"
				: "Method"
	}

	// The Token that closes a bracketed construction. Unlike `expect`, a
	// failure also points at the opening bracket, since the Token that fails is
	// often far from the mistake. See "Closing brackets" in DEVELOPMENT.md.
	expectClosing(tokenType: lexer.TokenType, opening: Token): Token {
		let token = this.tokens[this.index]

		if (token !== undefined && token.type === tokenType) {
			return this.next()
		}

		this.failClosing(tokenType, opening)
	}

	// The failure `expectClosing` raises, thrown by a reading that has
	// already decided the closing Token is missing. It uses the same words, so
	// the reader can not tell which reading reported it.
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

	// How far into the Token array the reading has got, which is how the
	// furthest failure compares readings. A number, since `save()` allocates and
	// this is asked on every failed speculation.
	get offset(): number {
		return this.index
	}

	save(): TokenStreamState {
		return { index: this.index, braceDepth: this.braceDepth }
	}

	// The Tokens between two saved offsets, which a recovery reads to learn
	// what it walked past. Absolute indices, because the reading has already
	// moved on when it asks.
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

	// The block a file short of a brace most likely left open, and the `}`
	// that closed it instead. That is the first `}` written further out than
	// the line that opened its block. See "Unclosed blocks" in DEVELOPMENT.md.
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

	// The Help for a file that ends with blocks open. Every one of them needs
	// its `}`, so a count above one is named rather than met one report at a time.
	missingBracesHelp(): string {
		let open = 0

		for (let token of this.tokens) {
			if (token.type === TokenType.SymbolLeftBrace) {
				open++
			} else if (token.type === TokenType.SymbolRightBrace) {
				open--
			}
		}

		return open > 1
			? `Add a '}' for each of the ${open} blocks still open.`
			: "Add the missing '}'."
	}

	// Where end-of-input Diagnostics stand: the end of the last Token, or
	// the start of a file that has none.
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
