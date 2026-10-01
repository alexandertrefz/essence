import { type common, lexer, type parser } from "@essence-lang/interfaces"

// The compiler's hand-written recursive descent parser. It builds its ASTs
// through the node generators in ../nodeGenerators.
import {
	collectDiagnostics,
	inSourceOrder,
	markDiagnostics,
	primary,
	reportError,
	rewindDiagnostics,
	secondary,
} from "../../diagnostics/index"
import {
	compoundAssignmentHelps,
	foreignOperatorAccount,
	foreignPunctuationLead,
	foreignWord,
	operatorNote,
	semicolonAccount,
} from "../../helpers/foreign"
import { mixedRationalSpellings } from "../../helpers/mixedRational"
import { matcherNames } from "../../helpers/patterns"
import * as generators from "../nodeGenerators"
import {
	describeToken,
	fail,
	ParseError,
	refusesTheText,
	TokenStream,
	type TokenStreamState,
} from "./tokenStream"

const TokenType = lexer.TokenType
type Token = lexer.Token

type BlockResult = {
	body: Array<parser.ImplementationNode>
	position: common.Position
}

type NamespaceBodyNode = Parameters<
	typeof generators.namespaceDefinitionStatement
>[4][number]

// The Identifier rule of the grammar: every Keyword here is also a valid
// Identifier. See "Contextual keywords" in DEVELOPMENT.md.
const identifierTokenTypes = new Set([
	TokenType.Identifier,
	TokenType.KeywordWith,
	TokenType.KeywordStatic,
	TokenType.KeywordCase,
	TokenType.KeywordInfer,
	TokenType.KeywordChoice,
	TokenType.KeywordImport,
	TokenType.KeywordExport,
	TokenType.KeywordFrom,
	TokenType.KeywordAs,
	TokenType.KeywordTests,
	TokenType.KeywordTest,
	TokenType.KeywordSuite,
	TokenType.KeywordBenchmark,
	TokenType.KeywordExpect,
	TokenType.KeywordRequire,
	TokenType.KeywordOtherwise,
	TokenType.KeywordStart,
	TokenType.KeywordComplete,
])

function isIdentifierToken(token: Token | undefined): boolean {
	return token !== undefined && identifierTokenTypes.has(token.type)
}

// INVARIANT: exactly the Token types `parsePrimaryExpression` answers.
// An extra one would make `parseArgument` read a label where an Expression
// was meant.
const expressionStartTokenTypes = new Set([
	...identifierTokenTypes,
	TokenType.SymbolHash,
	TokenType.SymbolDot,
	TokenType.SymbolAt,
	TokenType.SymbolDash,
	TokenType.SymbolLeftBracket,
	TokenType.SymbolLeftParen,
	TokenType.SymbolLeftAngle,
	TokenType.SymbolLeftBrace,
	TokenType.KeywordMatch,
	TokenType.KeywordDefine,
	TokenType.LiteralString,
	TokenType.LiteralStringStart,
	TokenType.LiteralNumber,
	TokenType.LiteralTrue,
	TokenType.LiteralFalse,
])

function startsExpression(token: Token | undefined): boolean {
	return token !== undefined && expressionStartTokenTypes.has(token.type)
}

// Whether `following` continues an Expression past `token`: a `.`, a `(`,
// or a `#` written flush. A contextual Keyword opens its own form only where
// none follows. See "Contextual keywords" in DEVELOPMENT.md.
function continuesExpression(
	token: Token,
	following: Token | undefined,
): boolean {
	if (following === undefined) {
		return false
	}

	if (
		following.type === TokenType.SymbolDot ||
		following.type === TokenType.SymbolLeftParen
	) {
		return true
	}

	return (
		following.type === TokenType.SymbolHash &&
		isAdjacent(token.position, following.position)
	)
}

// The Token types that begin an Expression and yet only stand where one has
// ended. See "Asynchrony keywords" in DEVELOPMENT.md.
const afterExpressionTokenTypes = new Set([
	TokenType.SymbolLeftBrace,
	TokenType.SymbolDash,
	TokenType.KeywordWith,
	TokenType.KeywordOtherwise,
])

function standsAfterExpression(token: Token): boolean {
	return afterExpressionTokenTypes.has(token.type)
}

// Whether `start` or `complete` opens its prefix Expression rather than
// naming a value. The operand must begin on the same line, and not with a
// Token that only follows an Expression.
// See "Asynchrony keywords" in DEVELOPMENT.md.
function opensAsynchrony(token: Token, following: Token | undefined): boolean {
	if (
		token.type !== TokenType.KeywordStart &&
		token.type !== TokenType.KeywordComplete
	) {
		return false
	}

	if (following === undefined || standsAfterExpression(following)) {
		return false
	}

	return (
		startsExpression(following) &&
		!continuesExpression(token, following) &&
		following.position.start.line === token.position.start.line
	)
}

// Words that open a form of their own where they stand and are ordinary
// names everywhere else, as `where` is in a Guard.
const ACROSS = "across"
const ANY = "any"
const MATCHES = "matches"
const SNAPSHOT = "snapshot"

// The Token types that begin a literal Matcher, as in `case 0`, `case 1/2`
// and `case "a"`. `LiteralStringStart` is here so `parseLiteralMatcherValue`
// can say why a String with holes can not be matched.
const literalMatcherTokenTypes = new Set([
	TokenType.LiteralNumber,
	TokenType.SymbolDash,
	TokenType.LiteralString,
	TokenType.LiteralStringStart,
	TokenType.LiteralTrue,
	TokenType.LiteralFalse,
])

// Every Token type a Matcher can begin with. `parseAssertionStatement` asks
// before it tries `require MATCHER = EXPR`, so other subjects never pay for a
// Matcher reading. A `(` is absent: `require (` is a call.
const matcherStartTokenTypes = new Set([
	...identifierTokenTypes,
	...literalMatcherTokenTypes,
	TokenType.SymbolUnderscore,
	TokenType.SymbolLeftBrace,
	TokenType.SymbolHash,
])

function startsMatcher(token: Token | undefined): boolean {
	return token !== undefined && matcherStartTokenTypes.has(token.type)
}

// The Keywords that open a Statement, where recovery resynchronises. A
// Statement that begins with a name is skipped with the broken one.
// INVARIANT: every Keyword `parseImplementationNode` dispatches on is here,
// or recovery silently skips the Declaration it opens.
const statementStartTokenTypes = new Set([
	TokenType.KeywordConstant,
	TokenType.KeywordVariable,
	TokenType.KeywordFunction,
	TokenType.KeywordNamespace,
	TokenType.KeywordProtocol,
	TokenType.KeywordType,
	TokenType.KeywordIf,
	TokenType.KeywordMatch,
	TokenType.KeywordCase,
	TokenType.KeywordImplementation,
	TokenType.KeywordOverload,
	TokenType.KeywordStatic,
	TokenType.KeywordChoice,
	TokenType.KeywordTest,
	TokenType.KeywordSuite,
	TokenType.KeywordBenchmark,
	TokenType.KeywordExpect,
	TokenType.KeywordRequire,
])

// The Keywords a Declaration opens with. `overload function` and `static`
// reach their name one Token further in.
const declarationKeywordTokenTypes = new Set([
	TokenType.KeywordConstant,
	TokenType.KeywordVariable,
	TokenType.KeywordFunction,
	TokenType.KeywordNamespace,
	TokenType.KeywordProtocol,
	TokenType.KeywordType,
	TokenType.KeywordChoice,
	TokenType.KeywordOverload,
	TokenType.KeywordStatic,
])

// Whether `cursor` stands inside `span`, inclusive of both ends.
function positionHolds(span: common.Position, cursor: common.Cursor): boolean {
	let afterStart =
		cursor.line > span.start.line ||
		(cursor.line === span.start.line && cursor.column >= span.start.column)
	let beforeEnd =
		cursor.line < span.end.line ||
		(cursor.line === span.end.line && cursor.column <= span.end.column)

	return afterStart && beforeEnd
}

// The openings whose Declaration hoists, as the enricher's `isHoistable`
// decides. See "Abandoned Statements" in DEVELOPMENT.md.
const hoistableKeywordTokenTypes = new Set([
	TokenType.KeywordFunction,
	TokenType.KeywordOverload,
	TokenType.KeywordType,
	TokenType.KeywordChoice,
	TokenType.KeywordNamespace,
	TokenType.KeywordProtocol,
])

// The Parameters a dropped head declared: each name before a `:` inside the
// brackets and outside every brace, where a `{ x: Integer }` Type names members.
function abandonedParameterNames(tokens: Array<Token>): Array<string> {
	let names: Array<string> = []
	let parens = 0
	let braces = 0

	for (let [step, token] of tokens.entries()) {
		if (token.type === TokenType.SymbolLeftParen) {
			parens++
		} else if (token.type === TokenType.SymbolRightParen) {
			parens--
		} else if (token.type === TokenType.SymbolLeftBrace) {
			braces++
		} else if (token.type === TokenType.SymbolRightBrace) {
			braces--
		} else if (
			parens > 0 &&
			braces === 0 &&
			isIdentifierToken(token) &&
			tokens[step + 1]?.type === TokenType.SymbolColon
		) {
			names.push(token.value)
		}
	}

	return names
}

// Whether an abandoned run could have opened a body, the only way a `<-`
// ends up outside a Function. See `parser.Recovery.headLines`.
function abandonedRunOpensBody(tokens: Array<Token>): boolean {
	let opening = tokens[0]

	if (opening === undefined) {
		return false
	}

	return (
		opening.type === TokenType.KeywordFunction ||
		opening.type === TokenType.KeywordOverload ||
		opening.type === TokenType.KeywordStatic ||
		(isIdentifierToken(opening) &&
			tokens[1]?.type === TokenType.SymbolLeftParen)
	)
}

// The names an abandoned Statement would have declared, read off its
// Tokens. See "Abandoned Statements" in DEVELOPMENT.md.
function abandonedDeclarationNames(tokens: Array<Token>): Array<string> {
	let index = 0

	while (
		tokens[index] !== undefined &&
		declarationKeywordTokenTypes.has(tokens[index]!.type)
	) {
		index++
	}

	let name = tokens[index]

	if (!isIdentifierToken(name)) {
		return []
	}

	let parameterNames = abandonedParameterNames(tokens)

	if (index === 0) {
		return tokens[1]?.type === TokenType.SymbolLeftParen
			? [name!.value, ...parameterNames]
			: []
	}

	let opening = tokens[0]!.type
	let declaresMembers =
		opening === TokenType.KeywordNamespace ||
		opening === TokenType.KeywordProtocol ||
		opening === TokenType.KeywordChoice
	let names = [name!.value, ...parameterNames]

	if (!declaresMembers) {
		return names
	}

	// Members stand one brace in, at the body's own level. A Type's braces in
	// a signature and every block a Method body opens are deeper.
	let depth = 0

	for (let step = index + 1; step < tokens.length; step++) {
		let token = tokens[step]!

		if (token.type === TokenType.SymbolLeftBrace) {
			depth++

			continue
		}

		if (token.type === TokenType.SymbolRightBrace) {
			depth--

			continue
		}

		if (depth !== 1) {
			continue
		}

		if (
			token.type === TokenType.SymbolHash &&
			isIdentifierToken(tokens[step + 1])
		) {
			names.push(tokens[step + 1]!.value)
		}

		if (
			token.type === TokenType.KeywordStatic &&
			isIdentifierToken(tokens[step + 1])
		) {
			names.push(tokens[step + 1]!.value)
		}

		if (
			isIdentifierToken(token) &&
			tokens[step + 1]?.type === TokenType.SymbolLeftParen
		) {
			names.push(token.value)
		}
	}

	return names
}

// The span a key was written across: the whole path, or the name alone.
function keyPosition(pair: {
	name: parser.IdentifierNode
	steps: Array<parser.IdentifierNode> | null
}): common.Position {
	if (pair.steps === null) {
		return pair.name.position
	}

	return {
		start: pair.steps[0].position.start,
		end: pair.steps[pair.steps.length - 1].position.end,
	}
}

// Whether two written keys write the same member: the same spelling, or one
// a prefix of the other at a step boundary.
function keysClash(left: string, right: string): boolean {
	if (left === right) {
		return true
	}

	let [shorter, longer] =
		left.length < right.length ? [left, right] : [right, left]

	return longer.startsWith(`${shorter}.`)
}

// Whether two Positions are written flush, with nothing between them. The
// grammar reads some Token runs as one lexeme, such as `1/2`, only when flush.
function isAdjacent(left: common.Position, right: common.Position): boolean {
	return (
		left.end.line === right.start.line &&
		left.end.column === right.start.column
	)
}

// What a Dictionary entry is, in one wording for every report.
const dictionaryEntryNote =
	"An entry is 'key = value', and a Dictionary is a bracket list of them: '[\"a\" = 1, \"b\" = 2]'."

// A key's separator written the way another language writes one. Both the
// Dictionary reader and the Expression tail, which meets a `=>`, refuse it.
function dictionaryEntryRefusal(
	separator: string,
	position: common.Position,
): ForeignRefusal {
	return {
		code: "dictionary-entry-syntax",
		message: "A Dictionary entry is written with '='",
		label: `expected '=' and found '${separator}'`,
		position,
		notes: [dictionaryEntryNote],
		helps: [`Write '=' in place of '${separator}'.`],
	}
}

// Whether the Expression before a `=>` can only be a Dictionary key: a String
// or a Number. A name is left out, since `x => x` may be a Function literal.
function writtenDictionaryKey(node: parser.ExpressionNode): boolean {
	return (
		node.nodeType === "StringValue" ||
		node.nodeType === "IntegerValue" ||
		node.nodeType === "RationalValue"
	)
}

// The separator another language writes between a key and its value, `:`
// or `->`. Any other Token there is a mistake of some other kind.
function writtenSeparatorLexeme(
	found: Token,
	next: Token | undefined,
): string | null {
	if (found.type === TokenType.SymbolColon) {
		return ":"
	}

	if (
		found.type === TokenType.SymbolDash &&
		next?.type === TokenType.SymbolRightAngle &&
		isAdjacent(found.position, next.position)
	) {
		return "->"
	}

	return null
}

// A refusal of text written in another language's habit. It is coded, so it
// survives speculation. See "Refusals of the text" in DEVELOPMENT.md.
type ForeignRefusal = {
	code: common.DiagnosticCode
	message: string
	label: string
	position: common.Position
	notes: Array<string>
	helps: Array<string>
	data?: common.DiagnosticData
}

// What a Token contributes to a foreign lexeme, or null. A Symbol such as `=`
// is a Token of its own, while `+` or `;` arrives inside an Identifier.
function foreignTokenLead(token: Token): string | null {
	switch (token.type) {
		case TokenType.SymbolEqual:
			return "="
		case TokenType.SymbolLeftAngle:
			return "<"
		case TokenType.SymbolRightAngle:
			return ">"
		case TokenType.SymbolSlash:
			return "/"
		case TokenType.SymbolDash:
			return "-"
		case TokenType.SymbolPipe:
			return "|"
		case TokenType.Identifier:
			return foreignPunctuationLead(token.value)
		default:
			return null
	}
}

// The lexemes made of a habit's characters that are Essence. Asked of the
// whole joined text, so `<- value` is Essence while `a < b` is a habit.
const essenceLexemes: ReadonlySet<string> = new Set(["->", "<-", "=", "|", "~"])

// What Essence writes in place of a habit that is not an operator. All share
// the code `foreign-syntax`; the message and `essence-spelling` data differ.
function foreignSyntaxRefusal(
	text: string,
	position: common.Position,
): ForeignRefusal | null {
	if (text === "//") {
		return {
			code: "foreign-syntax",
			message: "A Comment is written with '§'",
			label: "Essence writes '§' here",
			position,
			notes: [
				"A '§' Comment runs to the end of its line, and a '§§' block above a Declaration documents it.",
			],
			helps: ["Write '§' in place of '//'."],
			data: { kind: "essence-spelling", position, spelling: "§" },
		}
	}

	if (text.startsWith("/*")) {
		return {
			code: "foreign-syntax",
			message: "A Comment is written with '§'",
			label: "Essence writes '§' here",
			position,
			// No `essence-spelling`: a `§` over the `/*` would leave its `*/`
			// standing.
			notes: [
				"There is no block Comment: a '§' runs to the end of its line, and a block is written one line at a time.",
			],
			helps: ["Write '§' at the head of each line."],
		}
	}

	if (text === "=>") {
		return {
			code: "foreign-syntax",
			message: "A Function literal has no '=>'",
			label: "the body belongs in braces",
			position,
			notes: [
				"A Function literal is its Parameter list, its answer Type and a block, and a value leaves one only through '<-'.",
			],
			// A whole annotated literal, so following the Help leaves no
			// inference refusal. `_ n` is unlabelled, so a plain call of the
			// result works.
			helps: ["Write '(_ n: Integer) -> Integer { <- n }'."],
		}
	}

	if (text === "?") {
		return {
			code: "foreign-syntax",
			message: "Essence has no conditional operator",
			label: "this begins nothing",
			position,
			notes: [
				"'define' is the conditional Expression: each arm names its value with 'as' and the condition it holds under with 'if'.",
			],
			helps: ["Write 'define { as a if c as b otherwise }'."],
		}
	}

	if (text === ";") {
		return {
			...semicolonAccount,
			position,
			data: { kind: "essence-spelling", position, spelling: "" },
		}
	}

	return null
}

// The value before the brackets spelled back, where it is a name or a path
// of names such as `box.items`. Null otherwise, and the Help then writes a
// schematic name.
function writtenReceiver(node: parser.ExpressionNode): string | null {
	switch (node.nodeType) {
		case "Identifier":
			return node.content
		case "Self":
			return "@"
		case "Lookup": {
			let base = writtenReceiver(node.base)

			return base === null ? null : `${base}.${node.member.content}`
		}
		default:
			return null
	}
}

// `primes[0]`: reading an item by its position in brackets, a habit that is a
// shape rather than a lexeme. Which Method reads an item depends on a Type the
// Parser does not know, so there is no `essence-spelling`.
function indexRefusal(
	receiver: string | null,
	key: { text: string; keyed: boolean } | null,
	position: common.Position,
): ForeignRefusal {
	// Not `value`, since `'value::value(at 0)'` reads like a rule rather
	// than a name to substitute.
	let written = receiver ?? "collection"
	let subject =
		receiver === null ? "the value it stands behind" : `'${receiver}'`
	// A written String key means a Dictionary, since a List and a String
	// are read by Integer position. The position Methods never get the key.
	let keyed = key?.keyed === true
	let at = keyed ? "0" : (key?.text ?? "0")

	return {
		code: "foreign-syntax",
		message: "A value is not indexed with brackets",
		label: "nothing reads a value with brackets",
		position,
		notes: [
			`Nothing carries an Expression on into brackets: what stands here is ${subject} and then a List of its own — two Statements, and a reading of an item in neither.`,
			"A position or a key can always name nothing, so each of these answers an Optional — and each takes a 'defaultingTo:' entry that answers a value in its place.",
		],
		helps: keyed
			? [
					`Write '${written}::value(at ${key?.text})' for a Dictionary, which is the collection a String keys.`,
					`A List and a String are read by position instead: '${written}::item(at 0)' and '${written}::character(at 0)'.`,
				]
			: [
					`Write '${written}::item(at ${at})' for a List, and '${written}::character(at ${at})' for a String.`,
					`Write '${written}::value(at ${at})' for a Dictionary, whose keys are values of its own key Type rather than positions.`,
					`A negative position counts back from the end, and 'firstItem()' and 'lastItem()' name the two ends of a List.`,
				],
	}
}

// `primes[0] = 5`: writing into a collection by position. Nothing changes a
// collection in place, so each Help reassigns the name from a Method's new
// collection. There is no `essence-spelling`, as for `indexRefusal`.
function indexWriteRefusal(
	receiver: string | null,
	key: { text: string; keyed: boolean } | null,
	value: string | null,
	position: common.Position,
): ForeignRefusal {
	let written = receiver ?? "collection"
	let keyed = key?.keyed === true
	let at = key?.text ?? "0"
	let put = value ?? "…"

	return {
		code: "foreign-syntax",
		message: "A value is not written into with brackets",
		label: "nothing writes into a value with brackets",
		position,
		notes: [
			`Nothing changes a collection in place: a Method that changes one answers a NEW collection, which is why '${written}' is written again.`,
			`A name written again is a 'variable' — a 'constant' is bound once.`,
		],
		helps: keyed
			? [
					`Write '${written} = ${written}::set(${at}, to ${put})' for a Dictionary, which is the collection a String keys.`,
					`Or '${written} = [${written} with ${at} = ${put}]', which is the same Dictionary spelled as a Literal.`,
				]
			: [
					`Write '${written} = ${written}::replace(${put}, at ${at})' for a List.`,
					`Write '${written} = ${written}::set(${at}, to ${put})' for a Dictionary, whose keys are values of its own key Type rather than positions.`,
				],
	}
}

// The value a `require` line was written over, spelled back where it is a
// name or a member path, and `…` otherwise.
function writtenValueText(value: parser.ExpressionNode): string {
	if (value.nodeType === "Identifier") {
		return value.content
	}

	if (value.nodeType === "Lookup") {
		let base = writtenValueText(value.base)

		return base === "…" ? "…" : `${base}.${value.member.content}`
	}

	return "…"
}

// The text a one-line span was read from, for a Help that spells the
// reader's text back. A String Node holds decoded escapes, so it can not.
// Empty where the span reaches past the text.
function writtenText(lines: Array<string>, position: common.Position): string {
	if (position.start.line !== position.end.line) {
		return ""
	}

	let line = lines[position.start.line - 1]

	if (line === undefined || position.end.column - 1 > line.length) {
		return ""
	}

	return line.slice(position.start.column - 1, position.end.column - 1)
}

// An Expression that can only be a value, which tells a Dictionary's key
// from a Record's member name. A name may be either. See
// `parseRecordLiteralOrCombination`.
function writesAValueKey(node: parser.ExpressionNode): boolean {
	switch (node.nodeType) {
		case "StringValue":
		case "InterpolatedStringValue":
		case "IntegerValue":
		case "RationalValue":
		case "BooleanValue":
		case "CaseValue":
		case "ListValue":
		case "DictionaryValue":
		case "RecordValue":
			return true
		default:
			return false
	}
}

// The numerator of a decimal, over a power of ten. Later stages read it as
// plain digits, so `BigInt` drops leading zeros and the sign of a zero.
function decimalNumerator(whole: string, fraction: string): string {
	let negative = whole.startsWith("-")
	let magnitude = BigInt(`${negative ? whole.slice(1) : whole}${fraction}`)

	return magnitude === 0n ? "0" : `${negative ? "-" : ""}${magnitude}`
}

// The parser recurs once per written level, so deep nesting would overflow
// the call stack. `nesting-too-deep` refuses it well before, leaving room for
// machine-generated files.
const maximumNestingDepth = 1024

export type ParserOptions = {
	// Reads the Statements as a test body, where `expect` and `require` are
	// legal. `parseTestBody` sets it for an `@example` block.
	insideTestBody?: boolean
	// Lets a Program open with `declarations { … }`. The standard library sets
	// it; in a user file the block is diagnosed.
	allowDeclarationsHeader?: boolean
}

// One `import { … }` or `export { … }` block as read, with the side of the
// implementation it stood on. A Diagnostic about the side points at the
// Keyword alone.
type ModuleSectionRead = {
	node: parser.ImportSectionNode | parser.ExportSectionNode
	keywordPosition: common.Position
	side: "above" | "below"
}

// The closing brackets. After a `,` one of these says the list is short of
// its own closing bracket. See `refuseListContinuation`.
const closingBracketTokenTypes = new Set([
	TokenType.SymbolRightParen,
	TokenType.SymbolRightBracket,
	TokenType.SymbolRightBrace,
])

// The Tokens a Statement that begins with a bare name continues with. See
// `parseOptionalRefinementPredicate`.
const STATEMENT_CONTINUATIONS = new Set([
	TokenType.SymbolEqual,
	TokenType.SymbolColon,
	TokenType.SymbolDot,
	TokenType.SymbolLeftParen,
	TokenType.SymbolLeftBracket,
])

class DescentParser {
	protected tokens: TokenStream
	protected suppressDiagnostics: boolean
	protected allowDeclarationsHeader: boolean
	// Set from the header. `declarations` unlocks body-less native Method
	// signatures and value-less static Properties in `parseNamespaceBodyNode`.
	protected mode: parser.Program["kind"] = "implementation"
	// The levels of Expressions, Types and blocks being read. One shared
	// budget, since all three recur into each other on one call stack.
	protected nestingDepth = 0
	// Whether the Statement being read stands in a test's own body. A
	// Function body inside clears it, and a `suite` body, which is setup,
	// never sets it.
	protected insideTestBody = false
	// Whether the Expression being read stands in an Argument list, the one
	// position that hands a Function literal its Types. Every block clears it,
	// so a literal's body is judged where it stands.
	protected insideArgumentList = false
	// The `config` of `{ config with … }` while the update is read, spelled for
	// a Help, or null. The key readers are far below the `with`.
	protected updatedValue: string | null = null
	// How many speculations are on the stack, which tells sibling readings of
	// one text from readings inside one of them.
	private speculationDepth = 0
	// The failure that reached furthest among the readings a speculation
	// threw away, the level it was recorded at and its Token offset.
	// See "The furthest failure" in DEVELOPMENT.md.
	private furthestFailure: ParseError | null = null
	private furthestFailureOffset = 0
	private furthestFailureDepth = 0
	// What the recovery walked past, for the Program's `Recovery`. A record's
	// `enclosing` is null while it is pending.
	// See "Abandoned Statements" in DEVELOPMENT.md.
	private abandonedDeclarations: Array<{
		name: string
		position: common.Position
		enclosing: common.Position | null
		hoistable: boolean
		atSectionLevel: boolean
	}> = []
	private abandonedLines = new Set<number>()
	// See `parser.Recovery.headLines`.
	private abandonedHeadLines = new Set<number>()

	// The source lines, for Helps that spell the reader's text back. See
	// `writtenText`.
	private sourceLines: Array<string>

	constructor(source: string, options: ParserOptions = {}) {
		this.tokens = new TokenStream(source)
		this.sourceLines = source.split("\n")
		this.allowDeclarationsHeader = options.allowDeclarationsHeader ?? false
		this.insideTestBody = options.insideTestBody ?? false

		// A Lexer error truncates the Token stream, so every end-of-input
		// error after it would be a cascade.
		this.suppressDiagnostics = this.tokens.hadLexerError
	}

	// #region Program & Sections

	parseProgram(): parser.Program {
		let above = this.parseModuleSections("above")

		// A file of nothing but tests, such as `Season.tests.es`, has no
		// implementation block. It gets an empty implementation section spanning
		// the tests block, so every Program has one shape.
		if (this.startsTestsSection()) {
			let keyword = this.peekOrFail()
			let tests = this.parseTestsSection()

			// An implementation block after the tests section is a file in the
			// wrong order. Both blocks are kept, and the Diagnostic points at the
			// tests block that moved.
			if (this.startsProgramHeader()) {
				this.reportTestsSectionAboveImplementation(keyword.position)

				return this.parseProgramBody(above, tests)
			}

			let below = this.parseModuleSections("below")
			let { imports, exports } = this.resolveModuleSections(
				[...above, ...below],
				tests.position,
			)

			this.reportTrailingTokens(
				below,
				tests.position,
				"the tests block ends here",
			)

			return generators.program(
				generators.implementationSection([], tests.position),
				tests.position,
				"tests",
				imports,
				exports,
				tests,
				this.recovery(),
			)
		}

		return this.parseProgramBody(above, null)
	}

	// Everything from the implementation block down, with the tests
	// section handed in where one was already read above it.
	protected parseProgramBody(
		above: Array<ModuleSectionRead>,
		testsAbove: parser.TestsSectionNode | null,
	): parser.Program {
		let header = this.parseProgramHeader()

		if (header === null) {
			// Without the `implementation {` header nothing can be parsed.
			let position = {
				start: { line: 1, column: 1 },
				end: { line: 1, column: 1 },
			}

			return generators.program(
				generators.implementationSection([], position),
				position,
				"implementation",
				null,
				null,
				null,
				this.recovery(),
			)
		}

		this.mode = header.kind

		let nodes = this.parseStatementList(() =>
			this.parseImplementationNode(),
		)
		let closingPosition = this.parseClosingBrace(
			header.leftBrace.position,
			true,
		)

		let implementation = generators.implementationSection(nodes, {
			start: header.keyword.position.start,
			end: closingPosition.end,
		})

		// The tests section is also read directly after the implementation
		// block, so a `tests { … }` before `export { … }` is reported as a block
		// in the wrong place. Without an export block it is in place.
		let testsAboveExports =
			testsAbove === null && this.startsTestsSection()
				? this.parseTestsSection()
				: null
		let below = this.parseModuleSections("below")
		let tests =
			testsAbove ??
			testsAboveExports ??
			(this.startsTestsSection() ? this.parseTestsSection() : null)

		if (testsAboveExports !== null) {
			let exported = below.find(
				(section) => section.node.nodeType === "ExportSection",
			)

			if (exported !== undefined) {
				this.reportTestsSectionAboveExports(
					testsAboveExports.position,
					exported.keywordPosition,
				)
			}
		}

		let { imports, exports } = this.resolveModuleSections(
			[...above, ...below],
			implementation.position,
		)

		this.reportTrailingTokens(
			below,
			tests?.position ?? closingPosition,
			tests === null
				? "the implementation block ends here"
				: "the tests block ends here",
		)

		// A Program's Position is the implementation block's span, which the
		// formatter reads. Each section carries its own span.
		return generators.program(
			implementation,
			implementation.position,
			header.kind,
			imports,
			exports,
			tests,
			this.recovery(),
		)
	}

	// Reports whatever is left once every section has been read. `endPosition`
	// is where the Program should have ended when no section follows the block.
	protected reportTrailingTokens(
		below: Array<ModuleSectionRead>,
		endPosition: common.Position,
		endDescription: string,
	): void {
		if (this.tokens.isAtEnd() || this.suppressDiagnostics) {
			return
		}

		let token = this.peekOrFail()
		let lastSection = below[below.length - 1]

		reportError(
			`Unexpected ${describeToken(token)} after the end of the Program`,
			token.position,
			{
				code: "unexpected-token",
				labels: [
					primary(token.position, "nothing may follow here"),
					secondary(
						lastSection?.node.position ?? endPosition,
						lastSection === undefined
							? endDescription
							: "the Program ends here",
					),
				],
				notes: [
					"A Program is one 'implementation { … }' block, framed by an optional 'import { … }' block above it and an optional 'tests { … }' and 'export { … }' block below it.",
				],
				// An empty `essence-spelling` asks the Quick Fix to delete the
				// primary span, as for a `;`.
				helps: [`Remove the ${describeToken(token)}.`],
				data: {
					kind: "essence-spelling",
					position: token.position,
					spelling: "",
				},
			},
		)
	}

	// Reads `import` and `export` blocks on either side of the implementation,
	// so a block on the wrong side is reported as misplaced. A second block of
	// one kind on one side is left to the trailing-Token report.
	protected parseModuleSections(
		side: ModuleSectionRead["side"],
	): Array<ModuleSectionRead> {
		let sections: Array<ModuleSectionRead> = []
		let sawImport = false
		let sawExport = false

		while (true) {
			let token = this.tokens.peek()

			if (
				token === undefined ||
				this.tokens.peek(1)?.type !== TokenType.SymbolLeftBrace
			) {
				return sections
			}

			if (token.type === TokenType.KeywordImport && !sawImport) {
				sawImport = true
				sections.push({
					node: this.parseImportSection(),
					keywordPosition: token.position,
					side,
				})
			} else if (token.type === TokenType.KeywordExport && !sawExport) {
				sawExport = true
				sections.push({
					node: this.parseExportSection(),
					keywordPosition: token.position,
					side,
				})
			} else {
				return sections
			}
		}
	}

	// Which of the blocks read on either side the Program keeps. A block on the
	// wrong side is reported and dropped. A `declarations { … }` Program keeps
	// its sections like any other.
	protected resolveModuleSections(
		sections: Array<ModuleSectionRead>,
		implementationPosition: common.Position,
	): {
		imports: parser.ImportSectionNode | null
		exports: parser.ExportSectionNode | null
	} {
		let imports: parser.ImportSectionNode | null = null
		let exports: parser.ExportSectionNode | null = null

		for (let section of sections) {
			if (section.node.nodeType === "ImportSection") {
				if (section.side === "above") {
					imports = section.node
				} else {
					this.reportMisplacedSection(section, implementationPosition)
				}
			} else {
				if (section.side === "below") {
					exports = section.node
				} else {
					this.reportMisplacedSection(section, implementationPosition)
				}
			}
		}

		return { imports, exports }
	}

	protected reportMisplacedSection(
		section: ModuleSectionRead,
		implementationPosition: common.Position,
	): void {
		if (this.suppressDiagnostics) {
			return
		}

		let isImport = section.node.nodeType === "ImportSection"
		let keyword = isImport ? "import" : "export"
		let expectedSide = isImport ? "above" : "below"

		reportError(
			`The '${keyword} { … }' block belongs ${expectedSide} the implementation`,
			section.keywordPosition,
			{
				code: "misplaced-module-section",
				// The whole block's span for the Quick Fix that moves it, since
				// the Diagnostic underlines the Keyword and the section is dropped.
				data: {
					kind: "section-order",
					section: isImport ? "import" : "export",
					block: section.node.position,
				},
				labels: [
					primary(
						section.keywordPosition,
						`this block is written ${section.side} the implementation`,
					),
					secondary(
						implementationPosition,
						"the implementation block is here",
					),
				],
				notes: [
					"A Program reads top to bottom: what it imports, what it does, what it exports.",
				],
				helps: [
					`Move the '${keyword} { … }' block ${expectedSide} 'implementation { … }'.`,
				],
			},
		)
	}

	// An import block holds only groups, since every name comes from a `from`.
	protected parseImportSection(): parser.ImportSectionNode {
		let keyword = this.tokens.next()
		let leftBrace = this.tokens.next()

		let groups = this.parseStatementList(() =>
			this.parseModuleGroup((source) => this.parseImportEntry(source)),
		)
		let closingPosition = this.parseClosingBrace(leftBrace.position)

		return generators.importSection(
			groups.map((group) =>
				generators.importGroup(
					group.source,
					group.entries,
					group.position,
				),
			),
			{ start: keyword.position.start, end: closingPosition.end },
		)
	}

	// An export block lists what the Module declares bare, and what it
	// forwards in groups. A Module may export a name `from`, so a group needs
	// the specifier after it: `from "./Module.es" {`.
	protected parseExportSection(): parser.ExportSectionNode {
		let keyword = this.tokens.next()
		let leftBrace = this.tokens.next()

		let members = this.parseStatementList(
			(): parser.ExportNode | parser.ExportGroupNode => {
				if (
					this.tokens.peek()?.type === TokenType.KeywordFrom &&
					this.tokens.peek(1)?.type === TokenType.LiteralString
				) {
					let group = this.parseModuleGroup((source) =>
						this.parseExportEntry(source),
					)

					return generators.exportGroup(
						group.source,
						group.entries,
						group.position,
					)
				}

				return this.parseExportEntry(null)
			},
		)
		let closingPosition = this.parseClosingBrace(leftBrace.position)

		return generators.exportSection(members, {
			start: keyword.position.start,
			end: closingPosition.end,
		})
	}

	// `from "./Module.es" { … }`, the shape both blocks share. Every entry
	// carries the specifier it came from.
	protected parseModuleGroup<Entry>(
		parseEntry: (source: parser.ModuleSpecifierNode) => Entry,
	): {
		source: parser.ModuleSpecifierNode
		entries: Array<Entry>
		position: common.Position
	} {
		let keyword = this.tokens.expect(TokenType.KeywordFrom)
		let source = this.parseModuleSpecifier()
		let leftBrace = this.tokens.expect(TokenType.SymbolLeftBrace)

		let entries = this.parseStatementList(() => parseEntry(source))
		let closingPosition = this.parseClosingBrace(leftBrace.position)

		return {
			source,
			entries,
			position: {
				start: keyword.position.start,
				end: closingPosition.end,
			},
		}
	}

	protected parseImportEntry(
		source: parser.ModuleSpecifierNode,
	): parser.ImportNode {
		let name = this.parseIdentifier()
		let alias = this.parseOptionalAlias()

		return generators.importEntry(name, alias, source, {
			start: name.position.start,
			end: (alias ?? name).position.end,
		})
	}

	// An entry in a group is a re-export. A bare entry, with no `source`,
	// exports something this Program declares.
	protected parseExportEntry(
		source: parser.ModuleSpecifierNode | null,
	): parser.ExportNode {
		let name = this.parseIdentifier()
		let alias = this.parseOptionalAlias()

		return generators.exportEntry(name, alias, source, {
			start: name.position.start,
			end: (alias ?? name).position.end,
		})
	}

	// `as` binds the entry under a local name. It is a Keyword only here, so
	// `as as as` renames an imported `as` to `as`.
	protected parseOptionalAlias(): parser.IdentifierNode | null {
		if (this.tokens.peek()?.type !== TokenType.KeywordAs) {
			return null
		}

		this.tokens.next()

		return this.parseIdentifier()
	}

	protected parseModuleSpecifier(): parser.ModuleSpecifierNode {
		let token = this.tokens.expect(TokenType.LiteralString)

		return generators.moduleSpecifier(token.value, token.position)
	}

	protected parseProgramHeader(): {
		keyword: Token
		leftBrace: Token
		kind: parser.Program["kind"]
	} | null {
		// No Identifier begins a Program, so `declarations {` needs no Lexer
		// keyword. Outside the standard library it is reported, and the block is
		// read as an implementation section.
		let token = this.tokens.peek()

		if (
			token?.type === TokenType.Identifier &&
			token.value === "declarations" &&
			this.tokens.peek(1)?.type === TokenType.SymbolLeftBrace
		) {
			let keyword = this.tokens.next()
			let leftBrace = this.tokens.next()

			if (!this.allowDeclarationsHeader) {
				if (!this.suppressDiagnostics) {
					reportError(
						"Only the standard library may open a 'declarations' block",
						keyword.position,
						{
							code: "declarations-outside-stdlib",
							labels: [
								primary(
									keyword.position,
									"'declarations' is not allowed here",
								),
							],
							helps: [
								"Open the Program with 'implementation { … }' instead.",
							],
						},
					)
				}

				return { keyword, leftBrace, kind: "implementation" }
			}

			return { keyword, leftBrace, kind: "declarations" }
		}

		try {
			let keyword = this.tokens.expect(TokenType.KeywordImplementation)
			let leftBrace = this.tokens.expect(TokenType.SymbolLeftBrace)

			return { keyword, leftBrace, kind: "implementation" }
		} catch (error) {
			this.reportParseError(error)

			return null
		}
	}

	// #endregion

	// #region Tests

	// Whether an implementation block opens here, `declarations {` included,
	// without consuming anything.
	protected startsProgramHeader(): boolean {
		let token = this.tokens.peek()

		if (token?.type === TokenType.KeywordImplementation) {
			return this.tokens.peek(1)?.type === TokenType.SymbolLeftBrace
		}

		return (
			token?.type === TokenType.Identifier &&
			token.value === "declarations" &&
			this.tokens.peek(1)?.type === TokenType.SymbolLeftBrace
		)
	}

	protected startsTestsSection(): boolean {
		return (
			this.tokens.peek()?.type === TokenType.KeywordTests &&
			this.tokens.peek(1)?.type === TokenType.SymbolLeftBrace
		)
	}

	// `tests { … }`. The `{` is part of what is recognised, since `tests` is an
	// ordinary Identifier elsewhere.
	protected parseTestsSection(): parser.TestsSectionNode {
		let keyword = this.tokens.next()
		let leftBrace = this.tokens.next()

		let nodes = this.parseStatementList(() => this.parseTestsNode())
		let closingPosition = this.parseClosingBrace(leftBrace.position, true)

		return generators.testsSection(nodes, {
			start: keyword.position.start,
			end: closingPosition.end,
		})
	}

	// A tests section before the implementation block, which reads as a
	// tests-only file until the implementation block follows it.
	protected reportTestsSectionAboveImplementation(
		keywordPosition: common.Position,
	): void {
		if (this.suppressDiagnostics) {
			return
		}

		reportError(
			"The 'tests { … }' block belongs below the 'implementation { … }' block",
			keywordPosition,
			{
				code: "misplaced-tests-section",
				labels: [
					primary(
						keywordPosition,
						"this block is written above the implementation",
					),
				],
				notes: [
					"A Module reads top to bottom: what it imports, what it does, what it exports, what it proves.",
				],
				helps: [
					"Move the 'tests { … }' block below 'implementation { … }', and below anything the Module exports.",
				],
			},
		)
	}

	// A tests section before the `export { … }` block. It is kept, since
	// dropping it would turn one Diagnostic about order into a cascade.
	protected reportTestsSectionAboveExports(
		sectionPosition: common.Position,
		exportPosition: common.Position,
	): void {
		if (this.suppressDiagnostics) {
			return
		}

		reportError(
			"The 'tests { … }' block belongs below the 'export { … }' block",
			sectionPosition,
			{
				code: "misplaced-tests-section",
				labels: [
					primary(
						sectionPosition,
						"this block is written above what the Module hands out",
					),
					secondary(exportPosition, "the export block is here"),
				],
				notes: [
					"A Module reads top to bottom: what it imports, what it does, what it exports, what it proves.",
				],
				helps: ["Move the 'tests { … }' block below 'export { … }'."],
			},
		)
	}

	// What may stand in a tests section or a `suite`'s body: a test, a nested
	// suite, or any Statement an implementation block takes, as setup or helper.
	protected parseTestsNode(): parser.TestsNode {
		if (this.startsTestItem(this.peekOrFail())) {
			return this.parseTestItem()
		}

		return this.parseImplementationNode()
	}

	// `test`, `suite` and `benchmark` are also Identifiers, so an item opens
	// only where a String name follows: `test = 5` is an assignment.
	protected startsTestItem(token: Token): boolean {
		if (
			token.type !== TokenType.KeywordTest &&
			token.type !== TokenType.KeywordSuite &&
			token.type !== TokenType.KeywordBenchmark
		) {
			return false
		}

		let name = this.tokens.peek(1)?.type

		return (
			name === TokenType.LiteralString ||
			name === TokenType.LiteralStringStart
		)
	}

	protected parseTestItem(): parser.TestNode | parser.SuiteNode {
		if (this.tokens.peek()?.type === TokenType.KeywordSuite) {
			return this.parseSuite()
		}

		return this.parseTest()
	}

	// A test or a benchmark, which is a test whose body is timed. The enricher
	// refuses `for any` on a benchmark, so the body stays parsed while edited.
	protected parseTest(): parser.TestNode {
		let keyword =
			this.tokens.peek()?.type === TokenType.KeywordBenchmark
				? this.tokens.expect(TokenType.KeywordBenchmark)
				: this.tokens.expect(TokenType.KeywordTest)
		let form =
			keyword.type === TokenType.KeywordBenchmark
				? ("benchmark" as const)
				: ("test" as const)
		let name = this.parseTestName(form)
		let modifiers = this.parseTestModifiers()
		let table = this.startsTestTable() ? this.parseTestTable() : null
		let properties = this.startsTestProperties()
			? this.parseTestProperties()
			: null

		let outerInsideTestBody = this.insideTestBody
		this.insideTestBody = true

		try {
			let block = this.parseBlock()

			return generators.test(
				form,
				name,
				modifiers,
				table,
				properties,
				block.body,
				keyword.position,
				{ start: keyword.position.start, end: block.position.end },
			)
		} finally {
			this.insideTestBody = outerInsideTestBody
		}
	}

	// `for any` opens the form only as a pair, since `any` is an ordinary name.
	protected startsTestProperties(): boolean {
		if (this.tokens.peek()?.type !== TokenType.KeywordFor) {
			return false
		}

		let following = this.tokens.peek(1)

		return (
			following?.type === TokenType.Identifier && following.value === ANY
		)
	}

	// `for any (a: Integer, b: NonEmptyList<String>)`: the values the runner
	// generates once per case, written as a closure's Parameter list.
	protected parseTestProperties(): parser.TestPropertiesNode {
		let keyword = this.tokens.next()

		this.tokens.next()

		let parameterList = this.parseParameterList(true)

		return generators.testProperties(
			parameterList.parameters,
			parameterList.position,
			keyword.position,
			{
				start: keyword.position.start,
				end: parameterList.position.end,
			},
		)
	}

	// `across` is recognised by content, as `matches` is in an assertion.
	protected startsTestTable(): boolean {
		let token = this.tokens.peek()

		return token?.type === TokenType.Identifier && token.value === ACROSS
	}

	// `across [ … ] ({ scored, conceded }: Scoreline)`: the rows a test runs
	// for, and a closure's Parameter list naming one row inside the body.
	protected parseTestTable(): parser.TestTableNode {
		let keyword = this.tokens.next()
		let value = this.parseExpression(true)
		let parameterList = this.parseParameterList(true)

		return generators.testTable(
			value,
			parameterList.parameters,
			parameterList.position,
			keyword.position,
			{
				start: keyword.position.start,
				end: parameterList.position.end,
			},
		)
	}

	protected parseSuite(): parser.SuiteNode {
		let keyword = this.tokens.expect(TokenType.KeywordSuite)
		let name = this.parseTestName("suite")
		let modifiers = this.parseTestModifiers()

		// A suite's own Statements are shared setup, not a test body.
		let outerInsideTestBody = this.insideTestBody
		this.insideTestBody = false

		this.enterNesting()

		try {
			let leftBrace = this.tokens.expect(TokenType.SymbolLeftBrace)

			let nodes = this.parseStatementList(() => this.parseTestsNode())
			let closingPosition = this.parseClosingBrace(leftBrace.position)

			return generators.suite(name, modifiers, nodes, keyword.position, {
				start: keyword.position.start,
				end: closingPosition.end,
			})
		} finally {
			this.nestingDepth--
			this.insideTestBody = outerInsideTestBody
		}
	}

	// A name is a String Literal that says what the test proves. A table test
	// interpolates each row's values into it.
	protected parseTestName(
		item: "test" | "suite" | "benchmark" = "test",
	): parser.TestNode["name"] {
		let token = this.peekOrFail(`the name of the ${item}`)

		if (token.type === TokenType.LiteralStringStart) {
			return this.parseInterpolatedString()
		}

		if (token.type !== TokenType.LiteralString) {
			fail(
				`Expected the name of the ${item} but found ${describeToken(token)}.`,
				token.position,
				"expected a String Literal",
			)
		}

		this.tokens.next()

		return generators.stringValueNode(token.value, token.position)
	}

	// Zero or more Modifiers between the name and the body, each a name with
	// arguments. The enricher knows the vocabulary.
	// See "Test Modifiers" in DEVELOPMENT.md.
	protected parseTestModifiers(): Array<parser.TestModifierNode> {
		let modifiers: Array<parser.TestModifierNode> = []

		while (
			isIdentifierToken(this.tokens.peek()) &&
			!this.startsTestTable()
		) {
			let name = this.parseIdentifier()
			let modifierArguments: Array<parser.TestModifierArgumentNode> = []

			if (this.opensTestModifierArguments()) {
				modifierArguments.push(this.parseTestModifierArgument())

				while (this.tokens.peek()?.type === TokenType.SymbolComma) {
					this.tokens.next()
					modifierArguments.push(this.parseTestModifierArgument())
				}
			}

			let last = modifierArguments[modifierArguments.length - 1]

			modifiers.push(
				generators.testModifier(name, modifierArguments, {
					start: name.position.start,
					end: (last ?? name).position.end,
				}),
			)
		}

		return modifiers
	}

	protected opensTestModifierArguments(): boolean {
		let token = this.tokens.peek()

		if (token === undefined) {
			return false
		}

		if (literalMatcherTokenTypes.has(token.type)) {
			return true
		}

		if (!isIdentifierToken(token)) {
			return false
		}

		let following = this.tokens.peek(1)

		// `across` and `for` open where the body would, so a bare name before
		// either is an argument as before a `{`.
		return (
			following?.type === TokenType.SymbolComma ||
			following?.type === TokenType.SymbolLeftBrace ||
			following?.type === TokenType.KeywordFor ||
			(following?.type === TokenType.Identifier &&
				following.value === ACROSS)
		)
	}

	protected parseTestModifierArgument(): parser.TestModifierArgumentNode {
		let token = this.peekOrFail("a Modifier argument")

		if (isIdentifierToken(token)) {
			return this.parseIdentifier()
		}

		if (!literalMatcherTokenTypes.has(token.type)) {
			fail(
				`Expected a Modifier argument but found ${describeToken(token)}.`,
				token.position,
				"expected a name, a Number, a String or a Boolean",
			)
		}

		return this.parseLiteralMatcherValue()
	}

	// #endregion

	// The Statement loop with no block around it, which reads the whole text
	// of an `@example`.
	parseStatements(): Array<parser.ImplementationNode> {
		return this.parseStatementList(() => this.parseImplementationNode())
	}

	// #region Error Recovery

	protected reportParseError(caught: unknown): void {
		if (!(caught instanceof ParseError)) {
			throw caught
		}

		if (this.suppressDiagnostics || caught.reported) {
			return
		}

		let error = this.furthestOf(caught)

		if (error.position === null) {
			reportError(error.message, null, {
				code: error.code,
				labels: [],
				notes: error.notes,
				helps: error.helps,
				data: error.data,
			})

			return
		}

		reportError(error.message, error.position, {
			code: error.code,
			labels: [
				error.label === null
					? primary(error.position, "here")
					: primary(error.position, error.label),
				...error.labels,
			],
			notes: error.notes,
			helps: error.helps,
			data: error.data,
		})
	}

	// Which failure of one broken Statement is reported: the kept reading's,
	// or the furthest among the readings thrown away.
	// See "The furthest failure" in DEVELOPMENT.md.
	private furthestOf(caught: ParseError): ParseError {
		let recorded = this.furthestFailure

		if (
			recorded === null ||
			refusesTheText(caught) ||
			this.furthestFailureOffset <= this.tokens.offset ||
			this.furthestFailureDepth < this.speculationDepth
		) {
			return caught
		}

		this.furthestFailure = null

		return recorded
	}

	// A name-keyed part of the AST, such as a Namespace's Methods, keeps only
	// the last of a repeated name. So the duplicate is reported here, while
	// both are still in hand.
	protected reportDuplicateNames(
		entries: Array<{ name: parser.IdentifierNode }>,
		kind: string,
		code: common.DiagnosticCode,
		helps: Array<string> = [],
	): void {
		if (this.suppressDiagnostics) {
			return
		}

		let firstPositions = new Map<string, common.Position>()

		for (let entry of entries) {
			let firstPosition = firstPositions.get(entry.name.content)

			if (firstPosition === undefined) {
				firstPositions.set(entry.name.content, entry.name.position)

				continue
			}

			reportError(
				`${kind} '${entry.name.content}' is already defined`,
				entry.name.position,
				{
					code,
					labels: [
						primary(
							entry.name.position,
							"defined a second time here",
						),
						secondary(firstPosition, "first defined here"),
					],
					// The second writing is the one to remove. Callers with
					// something sharper to say pass their own Helps.
					helps:
						helps.length === 0
							? [
									`Remove the second '${entry.name.content}', or give it a name of its own.`,
								]
							: helps,
				},
			)
		}
	}

	// Parses list elements until the closing `}` or the end of the input. A
	// broken element is reported once and dropped. See "Error recovery" in
	// DEVELOPMENT.md.
	protected parseStatementList<T>(parseElement: () => T): Array<T> {
		let elements: Array<T> = []

		while (true) {
			let token = this.tokens.peek()

			if (
				token === undefined ||
				token.type === TokenType.SymbolRightBrace
			) {
				break
			}

			// Asked here, since a foreign Comment line is no element at all.
			if (this.swallowForeignComment()) {
				continue
			}

			let startState = this.tokens.save()

			// Defensive: forgets a reading thrown away for the previous element.
			// See "The furthest failure" in DEVELOPMENT.md.
			this.forgetFailuresFrom(this.speculationDepth)

			try {
				elements.push(parseElement())
			} catch (error) {
				this.recoverFromError(error, startState)
			}
		}

		return elements
	}

	// `# count the items`: a Comment in the shell's spelling, reported and
	// skipped. It needs two or more names and nothing else on the line, since
	// `# todo` is a valid bare Case.
	protected swallowForeignComment(): boolean {
		let hash = this.tokens.peek()

		if (hash?.type !== TokenType.SymbolHash) {
			return false
		}

		let line = hash.position.start.line
		let words = 0

		for (let offset = 1; ; offset++) {
			let token = this.tokens.peek(offset)

			if (token === undefined || token.position.start.line !== line) {
				break
			}

			if (!isIdentifierToken(token)) {
				return false
			}

			words++
		}

		if (words < 2) {
			return false
		}

		if (!this.suppressDiagnostics) {
			reportError("A Comment is written with '§'", hash.position, {
				code: "foreign-syntax",
				labels: [primary(hash.position, "Essence writes '§' here")],
				notes: [
					"A '§' Comment runs to the end of its line, and a '§§' block above a Declaration documents it.",
					"A '#' opens a Case, so '#count' is a value and each word behind it is read as a Statement of its own.",
				],
				helps: ["Write '§' in place of '#'."],
				data: {
					kind: "essence-spelling",
					position: hash.position,
					spelling: "§",
				},
			})
		}

		while (this.tokens.peek()?.position.start.line === line) {
			this.tokens.next()
		}

		return true
	}

	protected recoverFromError(
		error: unknown,
		startState: TokenStreamState,
	): void {
		this.reportParseError(error)
		this.resynchronise(startState.braceDepth)

		// Guarantee progress where the broken element consumed no Token and
		// resynchronisation stopped at once.
		if (
			this.tokens.save().index === startState.index &&
			!this.tokens.isAtEnd()
		) {
			this.tokens.next()
		}

		this.recordAbandoned(startState.index)
	}

	// Records what the recovery just walked past, read off its Tokens.
	// See "Abandoned Statements" in DEVELOPMENT.md.
	protected recordAbandoned(fromIndex: number): void {
		let abandoned = this.tokens.between(fromIndex, this.tokens.save().index)
		let opensBody = abandonedRunOpensBody(abandoned)

		for (let token of abandoned) {
			for (
				let line = token.position.start.line;
				line <= token.position.end.line;
				line++
			) {
				this.abandonedLines.add(line)

				if (opensBody) {
					this.abandonedHeadLines.add(line)
				}
			}
		}

		let opening = abandoned[0]

		if (opening === undefined) {
			return
		}

		let hoistable = hoistableKeywordTokenTypes.has(opening.type)

		// A Case written with a payload names itself twice, as `#Case` and as
		// `Case(`, so the names are deduplicated.
		for (let declared of new Set(abandonedDeclarationNames(abandoned))) {
			this.recordAbandonedDeclaration(
				declared,
				opening.position,
				hoistable,
			)
		}
	}

	// One name, pending the block that will claim it.
	protected recordAbandonedDeclaration(
		name: string,
		position: common.Position,
		hoistable: boolean,
	): void {
		this.abandonedDeclarations.push({
			name,
			position,
			enclosing: null,
			hoistable,
			atSectionLevel: false,
		})
	}

	// A block has just closed, so it claims every pending record inside it.
	// `section` marks a block whose own Statements hoist.
	// See "Abandoned Statements" in DEVELOPMENT.md.
	protected claimAbandonedDeclarations(
		openingPosition: common.Position | null,
		closingPosition: common.Position,
		section: boolean,
	): void {
		if (openingPosition === null) {
			return
		}

		let enclosing = {
			start: openingPosition.start,
			end: closingPosition.end,
		}

		for (let record of this.abandonedDeclarations) {
			// A pending record may stand outside this block, such as a
			// Statement dropped before a later Function's body.
			if (
				record.enclosing === null &&
				positionHolds(enclosing, record.position.start)
			) {
				record.enclosing = enclosing
				record.atSectionLevel = section
			}
		}
	}

	// The `parser.Recovery` handed to the Program, sorted so one source always
	// parses to one Program. Undefined where nothing was abandoned.
	protected recovery(): parser.Recovery | undefined {
		// A refused binder abandons a name without abandoning any text.
		if (
			this.abandonedLines.size === 0 &&
			this.abandonedDeclarations.length === 0
		) {
			return undefined
		}

		// A record no block claimed stood outside every block that closed. It
		// covers the whole file at section level.
		let wholeFile = {
			start: { line: 1, column: 1 },
			end: this.tokens.endPosition().end,
		}

		return {
			declarations: this.abandonedDeclarations
				.map((record) => ({
					name: record.name,
					position: record.position,
					enclosing: record.enclosing ?? wholeFile,
					hoistable: record.hoistable,
					atSectionLevel:
						record.enclosing === null || record.atSectionLevel,
				}))
				.sort(
					(left, right) =>
						left.position.start.line - right.position.start.line ||
						left.position.start.column -
							right.position.start.column ||
						(left.name < right.name
							? -1
							: left.name > right.name
								? 1
								: 0),
				),
			lines: [...this.abandonedLines].sort((left, right) => left - right),
			headLines: [...this.abandonedHeadLines].sort(
				(left, right) => left - right,
			),
		}
	}

	// Skips to the next Statement start or `}` at the brace depth the broken
	// element started on, skipping braces the element opened.
	protected resynchronise(targetDepth: number): void {
		while (true) {
			let token = this.tokens.peek()

			if (token === undefined) {
				// At the end of the input every further error is a cascade.
				this.suppressDiagnostics = true

				return
			}

			if (this.tokens.depth <= targetDepth) {
				if (token.type === TokenType.SymbolRightBrace) {
					return
				}

				if (this.isStatementStart(token)) {
					return
				}
			}

			this.tokens.next()
		}
	}

	protected isStatementStart(token: Token): boolean {
		if (statementStartTokenTypes.has(token.type)) {
			return true
		}

		return (
			token.type === TokenType.SymbolLeftAngle &&
			this.tokens.peek(1)?.type === TokenType.SymbolDash
		)
	}

	// Reads a block's `}`, whose `{` stands at `openingPosition`. Every block
	// closes here, so it claims abandoned Declarations. `section` marks a block
	// whose own Statements hoist.
	protected parseClosingBrace(
		openingPosition: common.Position | null = null,
		section: boolean = false,
	): common.Position {
		let token = this.tokens.peek()

		if (token !== undefined && token.type === TokenType.SymbolRightBrace) {
			this.tokens.next()
			this.claimAbandonedDeclarations(
				openingPosition,
				token.position,
				section,
			)

			return token.position
		}

		// Only the innermost torn-open block reports, since a missing `}`
		// tears open every enclosing block too.
		if (!this.suppressDiagnostics) {
			this.reportUnclosedBlock(openingPosition)

			this.suppressDiagnostics = true
		}

		let endPosition = this.tokens.endPosition()

		this.claimAbandonedDeclarations(openingPosition, endPosition, section)

		return endPosition
	}

	// Reports where the brace is missing, which is not where its absence is
	// noticed. See "Unclosed blocks" in DEVELOPMENT.md.
	protected reportUnclosedBlock(
		openingPosition: common.Position | null,
	): void {
		let outdented = this.tokens.outdentedClose()
		let endPosition = this.tokens.endPosition()

		if (outdented === null) {
			reportError("This block is never closed", endPosition, {
				code: "unclosed-block",
				labels: [
					primary(endPosition, "the input ends here"),
					...(openingPosition === null
						? []
						: [secondary(openingPosition, "opened here")]),
				],
				helps: ["Add the missing '}'."],
			})

			return
		}

		reportError("This block is never closed", outdented.opened.position, {
			code: "unclosed-block",
			labels: [
				primary(
					outdented.opened.position,
					"this block is never closed",
				),
				secondary(
					outdented.closed.position,
					"this '}' is written further out, so it closes the block around it",
				),
			],
			notes: [
				"Which block a '}' closes is counted rather than read off the indentation, so a file one brace short hands every '}' below the mistake to the block above the one it was written for — and the end of the input is where that is noticed.",
			],
			helps: ["Write the '}' where this block's Statements end."],
		})
	}

	// #endregion

	// #region Statements

	protected parseImplementationNode(): parser.ImplementationNode {
		let token = this.peekOrFail()

		switch (token.type) {
			case TokenType.KeywordConstant:
				return this.parseConstantDeclarationStatement()
			case TokenType.KeywordVariable:
				return this.parseVariableDeclarationStatement()
			case TokenType.KeywordType:
				return this.parseTypeAliasStatement()
			case TokenType.KeywordNamespace:
				return this.parseNamespaceDefinitionStatement()
			case TokenType.KeywordProtocol:
				return this.parseProtocolDeclarationStatement()
			case TokenType.KeywordIf:
				return this.parseIfStatement()
			case TokenType.KeywordFunction:
				return this.parseFunctionStatement()
		}

		// A test item outside the tests section is read to its end before it is
		// refused, so the Diagnostic is about the whole item.
		if (this.startsTestItem(token)) {
			this.parseTestItem()

			throw new ParseError(
				`A '${token.value}' may only be written in the 'tests { … }' section`,
				token.position,
				`this '${token.value}' stands outside every tests section`,
				{
					code: "test-outside-tests",
					notes: [
						"The tests section is written below the implementation block, and a 'suite' groups the tests inside it.",
					],
					helps: [
						"Move it into the file's 'tests { … }' block, or open one below the implementation.",
					],
				},
			)
		}

		// An assertion opens only where an Expression or a Matcher's `_` follows
		// and nothing continues the word as a value. `_` is let through so
		// `require _ = x` is refused where it is read.
		// See "Contextual keywords" in DEVELOPMENT.md.
		if (
			(token.type === TokenType.KeywordExpect ||
				token.type === TokenType.KeywordRequire) &&
			(startsExpression(this.tokens.peek(1)) ||
				this.tokens.peek(1)?.type === TokenType.SymbolUnderscore) &&
			!continuesExpression(token, this.tokens.peek(1))
		) {
			return this.parseAssertionStatement()
		}

		// `choice` opens a Declaration only where a name follows it.
		if (
			token.type === TokenType.KeywordChoice &&
			isIdentifierToken(this.tokens.peek(1))
		) {
			return this.parseChoiceDeclarationStatement()
		}

		// `overload function` belongs to `declarations { … }` Programs. Anywhere
		// else it is reported and still parsed, so its contents get Diagnostics.
		if (
			token.type === TokenType.KeywordOverload &&
			this.tokens.peek(1)?.type === TokenType.KeywordFunction
		) {
			if (this.mode !== "declarations" && !this.suppressDiagnostics) {
				reportError(
					"Only the standard library may write an 'overload function' block",
					token.position,
					{
						code: "overload-function-outside-stdlib",
						labels: [
							primary(
								token.position,
								"'overload function' is not allowed here",
							),
						],
						notes: [
							"Free-Function Overloads are a 'declarations { … }' form — a free Function in a Program carries one signature.",
						],
						helps: [
							"Write the Overloads as an 'overload' Method block inside a Namespace instead.",
						],
					},
				)
			}

			return this.parseOverloadedFunctionStatement()
		}

		if (
			token.type === TokenType.SymbolLeftAngle &&
			this.tokens.peek(1)?.type === TokenType.SymbolDash
		) {
			return this.parseReturnStatement()
		}

		if (
			isIdentifierToken(token) &&
			this.tokens.peek(1)?.type === TokenType.SymbolEqual
		) {
			return this.parseVariableAssignmentStatement()
		}

		this.refuseNameBehindSwallowedLines(token)

		let declaration = this.parseForeignDeclarationStatement(token)

		if (declaration !== null) {
			return declaration
		}

		let expression = this.parseExpression()

		this.refuseMemberAssignment(expression)

		return expression
	}

	// A name left standing after a String that spans lines, where two forgotten
	// quotes left the count even. See "Which quote is missing" in
	// packages/compiler/src/lexer/DEVELOPMENT.md.
	protected refuseNameBehindSwallowedLines(token: Token): void {
		let previous = this.tokens.peek(-1)

		if (
			!isIdentifierToken(token) ||
			previous?.type !== TokenType.LiteralString ||
			previous.position.start.line === previous.position.end.line ||
			previous.position.end.line !== token.position.start.line
		) {
			return
		}

		let opened = previous.position.start
		let closed = {
			start: {
				line: previous.position.end.line,
				column: previous.position.end.column - 1,
			},
			end: previous.position.end,
		}

		throw new ParseError(
			"This String Literal is never closed",
			{
				start: opened,
				end: { line: opened.line, column: opened.column + 1 },
			},
			"opened here",
			{
				code: "unclosed-string",
				labels: [
					secondary(
						closed,
						"closed by this quote, which reads as the start of another String",
					),
					secondary(
						token.position,
						"and this is what that quote left standing",
					),
				],
				notes: [
					`A String Literal may span lines, and the line breaks are part of it — so the quote on line ${previous.position.end.line} closed the one opened on line ${opened.line}, and what a reader wrote to open a String of its own closed this one instead.`,
				],
				helps: [
					`Add the missing '"' at the end of line ${opened.line}.`,
				],
			},
		)
	}

	// `const price = 12`, `let count = 3`, `return n`: a Statement in another
	// language's words, reported once and read as meant, so `price` stays
	// declared. The word opens it only where the rest of that Statement follows.
	protected parseForeignDeclarationStatement(
		token: Token,
	): parser.ImplementationNode | null {
		if (token.type !== TokenType.Identifier) {
			return null
		}

		if (token.value === "return") {
			return this.parseForeignReturnStatement(token)
		}

		this.refuseForeignDeclarationBlock(token)

		let spelling =
			token.value === "const"
				? "constant"
				: token.value === "let" || token.value === "var"
					? "variable"
					: null

		// The Helps come from `foreignWord`. For `let` and `var` the fix writes
		// `variable`, which compiles either way.
		let word = foreignWord(token.value)
		// `let mut total = 0` is one habit over two words, so the fix writes
		// `variable` over both.
		let mutable =
			spelling === "variable" &&
			this.tokens.peek(1)?.value === "mut" &&
			this.declaresAName(1)

		if (
			spelling === null ||
			word === null ||
			!(mutable || this.declaresAName())
		) {
			return null
		}

		let written = mutable
			? {
					start: token.position.start,
					end: (this.tokens.peek(1) as Token).position.end,
				}
			: token.position

		this.reportForeignStatement(token, spelling, {
			message: `'${token.value}' is not how Essence declares a binding`,
			label: `Essence writes '${spelling}' here`,
			notes: [word.note],
			helps: [...word.helps],
			span: written,
		})

		// Steps over the word and reads the rest as the Statement it was meant
		// to be.
		this.tokens.next()

		if (mutable) {
			this.tokens.next()
		}

		return spelling === "constant"
			? this.parseDeclaredConstant(written)
			: this.parseDeclaredVariable(written)
	}

	// `class Money { … }`: another language's declaration block, refused as one
	// mistake. A closed block is skipped first, so its body is not reported on.
	protected refuseForeignDeclarationBlock(token: Token): void {
		let word = foreignWord(token.value)
		let brace = this.foreignBlockBraceOffset()

		if (word === null || brace === null) {
			return
		}

		let position = token.position
		// A block whose `}` never arrives is not skipped, so the missing brace
		// is still reported.
		let named = isIdentifierToken(this.tokens.peek(1))

		if (this.foreignBlockCloses(brace)) {
			this.skipBalancedBlock(brace)
		}

		throw new ParseError(
			named
				? `'${token.value}' declares nothing in Essence`
				: `'${token.value}' opens no block in Essence`,
			position,
			named
				? "this is another language's declaration"
				: "this is another language's Statement",
			{
				code: "foreign-syntax",
				notes: [word.note],
				helps: [...word.helps],
			},
		)
	}

	// The offset of the `{` in `try {`, `class Money {`, `switch (x) {` or
	// `func main() {`, all on one line, or null. The line keeps out a Record
	// literal written under a bare name.
	protected foreignBlockBraceOffset(): number | null {
		let word = this.tokens.peek()

		if (word === undefined) {
			return null
		}

		let line = word.position.start.line
		let onLine = (token: Token | undefined) =>
			token !== undefined && token.position.start.line === line
		let offset = 1

		if (isIdentifierToken(this.tokens.peek(offset))) {
			offset++
		}

		let head = this.tokens.peek(offset)?.type === TokenType.SymbolLeftParen

		if (head) {
			let depth = 0

			// A head that does not close on its line is not this shape.
			while (true) {
				let token = this.tokens.peek(offset)

				if (token === undefined || !onLine(token)) {
					return null
				}

				offset++

				if (token.type === TokenType.SymbolLeftParen) {
					depth++
				} else if (token.type === TokenType.SymbolRightParen) {
					depth--

					if (depth === 0) {
						break
					}
				}
			}

			// Steps over an answer Type between a head and its block, as in
			// `fn double(n: i32) -> i32 {`.
			while (
				onLine(this.tokens.peek(offset)) &&
				this.tokens.peek(offset)?.type !== TokenType.SymbolLeftBrace
			) {
				offset++
			}
		}

		let brace = this.tokens.peek(offset)

		return onLine(brace) && brace?.type === TokenType.SymbolLeftBrace
			? offset
			: null
	}

	// Whether the block at `braceOffset` has a closing `}` anywhere ahead.
	protected foreignBlockCloses(braceOffset: number): boolean {
		let depth = 0

		for (let offset = braceOffset; ; offset++) {
			let token = this.tokens.peek(offset)

			if (token === undefined) {
				return false
			}

			if (token.type === TokenType.SymbolLeftBrace) {
				depth++
			} else if (token.type === TokenType.SymbolRightBrace) {
				depth--

				if (depth === 0) {
					return true
				}
			}
		}
	}

	// Steps past the `}` that closes the block at `braceOffset`, so the refusal
	// resynchronises after the body rather than inside it.
	protected skipBalancedBlock(braceOffset: number): void {
		for (let step = 0; step <= braceOffset; step++) {
			this.tokens.next()
		}

		let depth = 1

		while (depth > 0 && !this.tokens.isAtEnd()) {
			let type = this.tokens.next().type

			if (type === TokenType.SymbolLeftBrace) {
				depth++
			} else if (type === TokenType.SymbolRightBrace) {
				depth--
			}
		}
	}

	// Whether a declaring word is followed by a Pattern, or by a name and an
	// `=` or `:`. Without that, `let count` is two names.
	protected declaresAName(from = 0): boolean {
		let name = this.tokens.peek(1 + from)

		if (name === undefined) {
			return false
		}

		if (name.type === TokenType.SymbolLeftBrace) {
			return true
		}

		if (!isIdentifierToken(name)) {
			return false
		}

		let following = this.tokens.peek(2 + from)?.type

		return (
			following === TokenType.SymbolEqual ||
			following === TokenType.SymbolColon
		)
	}

	protected parseForeignReturnStatement(
		token: Token,
	): parser.ReturnStatementNode | null {
		let following = this.tokens.peek(1)

		if (
			following === undefined ||
			!startsExpression(following) ||
			continuesExpression(token, following) ||
			following.position.start.line !== token.position.start.line
		) {
			return null
		}

		this.reportForeignStatement(token, "<-", {
			message: "'return' is not how Essence answers with a value",
			label: "Essence writes '<-' here",
			notes: [
				"A value leaves a Function through '<-', which is the arrow its signature writes its return Type with.",
			],
			helps: ["Write '<-' in place of 'return'."],
		})

		this.tokens.next()

		let value = this.parseExpression()

		return generators.returnStatement(value, {
			start: token.position.start,
			end: value.position.end,
		})
	}

	// Reported rather than thrown, since a throw would drop the Statement.
	protected reportForeignStatement(
		token: Token,
		spelling: string,
		account: {
			message: string
			label: string
			notes: Array<string>
			helps: Array<string>
			// What the spelling replaces where that is more than the word,
			// such as `let mut`.
			span?: common.Position
		},
	): void {
		if (this.suppressDiagnostics) {
			return
		}

		let written = account.span ?? token.position

		reportError(account.message, written, {
			code: "foreign-syntax",
			labels: [primary(written, account.label)],
			notes: account.notes,
			helps: account.helps,
			data: {
				kind: "essence-spelling",
				position: written,
				spelling,
			},
		})
	}

	// `user.name = "Ada"`: assigning a Record member. Refused at Statement level,
	// since elsewhere an `=` after an Expression separates a key from its value.
	protected refuseMemberAssignment(expression: parser.ExpressionNode): void {
		if (
			expression.nodeType !== "Lookup" ||
			this.tokens.peek()?.type !== TokenType.SymbolEqual
		) {
			return
		}

		let base =
			expression.base.nodeType === "Identifier"
				? expression.base.content
				: "value"

		throw new ParseError(
			"A Record's member can not be assigned",
			expression.position,
			"this member is read, never written",
			{
				code: "foreign-syntax",
				notes: [
					"Records are immutable: nothing changes one in place, and 'with' builds the Record that differs from it.",
				],
				helps: [
					`Write '{ ${base} with ${expression.member.content} = … }', and bind the answer.`,
				],
			},
		)
	}

	// A Function literal written as a Declaration's value gets the
	// Declaration's `§§` block, since a literal in Expression position owns none.
	protected handDocumentationDown(
		value: parser.ExpressionNode,
		documentation: common.Documentation | null,
	): void {
		if (documentation !== null && value.nodeType === "FunctionValue") {
			value.value.documentation = documentation
		}
	}

	protected parseConstantDeclarationStatement(): parser.ConstantDeclarationStatementNode {
		let keyword = this.tokens.expect(TokenType.KeywordConstant)

		return this.parseDeclaredConstant(keyword.position)
	}

	// A Constant Declaration after its Keyword. `parseForeignDeclarationStatement`
	// calls it after a `const`, so that recovers into the same Statement.
	protected parseDeclaredConstant(
		keywordPosition: common.Position,
	): parser.ConstantDeclarationStatementNode {
		let keyword = { position: keywordPosition }
		let name = this.parseDeclaredName()
		let type = this.parseOptionalDeclarationType()

		this.tokens.expect(TokenType.SymbolEqual)

		let value = this.parseExpression()
		let documentation = this.tokens.documentationAbove(
			keyword.position.start.line,
		)

		this.handDocumentationDown(value, documentation)

		return generators.constantDeclarationStatement(
			name,
			type,
			value,
			{ start: keyword.position.start, end: value.position.end },
			documentation,
		)
	}

	protected parseVariableDeclarationStatement(): parser.VariableDeclarationStatementNode {
		let keyword = this.tokens.expect(TokenType.KeywordVariable)

		return this.parseDeclaredVariable(keyword.position)
	}

	// A Variable Declaration after its Keyword, as `parseDeclaredConstant`.
	protected parseDeclaredVariable(
		keywordPosition: common.Position,
	): parser.VariableDeclarationStatementNode {
		let keyword = { position: keywordPosition }
		let name = this.parseDeclaredName()
		let type = this.parseOptionalDeclarationType()

		this.tokens.expect(TokenType.SymbolEqual)

		let value = this.parseExpression()
		let documentation = this.tokens.documentationAbove(
			keyword.position.start.line,
		)

		this.handDocumentationDown(value, documentation)

		return generators.variableDeclarationStatement(
			name,
			type,
			value,
			{ start: keyword.position.start, end: value.position.end },
			documentation,
		)
	}

	// One name, or a Pattern naming the parts of the value. Assignment takes no
	// Pattern, since `{ a, b } = x` reads like a Record literal until its `}`.
	protected parseDeclaredName(): parser.IdentifierNode | parser.PatternNode {
		if (this.tokens.peek()?.type === TokenType.SymbolLeftBrace) {
			return this.parsePattern()
		}

		return this.parseIdentifier()
	}

	protected parseVariableAssignmentStatement(): parser.VariableAssignmentStatementNode {
		let name = this.parseIdentifier()

		this.tokens.expect(TokenType.SymbolEqual)

		let value = this.parseExpression()

		return generators.variableAssignmentStatement(name, value, {
			start: name.position.start,
			end: value.position.end,
		})
	}

	protected parseTypeAliasStatement(): parser.TypeAliasStatementNode {
		let keyword = this.tokens.expect(TokenType.KeywordType)
		let name = this.parseIdentifier()
		let generics = this.parseOptionalGenericList()

		this.tokens.expect(TokenType.SymbolEqual)

		let type = this.parseType()
		let predicate = this.parseOptionalRefinementPredicate(type)

		return generators.typeAliasStatement(
			name,
			generics,
			type,
			predicate,
			{
				start: keyword.position.start,
				// Out to the predicate. The formatter places Comments by a
				// Declaration's span.
				end: predicate?.position.end ?? type.position.end,
			},
			this.tokens.documentationAbove(keyword.position.start.line),
		)
	}

	// The `where` clause of a checked refinement, recognised by content as in
	// `parseOptionalGuard`. On the next line, `where` opens the clause only if
	// no `STATEMENT_CONTINUATIONS` Token follows it on its line.
	protected parseOptionalRefinementPredicate(
		type: parser.TypeDeclarationNode,
	): parser.ExpressionNode | null {
		let token = this.tokens.peek()

		if (token?.type !== TokenType.Identifier || token.value !== "where") {
			return null
		}

		if (token.position.start.line !== type.position.end.line) {
			let after = this.tokens.peek(1)

			if (
				after === undefined ||
				after.position.start.line !== token.position.start.line ||
				STATEMENT_CONTINUATIONS.has(after.type)
			) {
				return null
			}
		}

		this.tokens.next()

		return this.parseExpression()
	}

	protected parseChoiceDeclarationStatement(): parser.ChoiceDeclarationStatementNode {
		let keyword = this.tokens.expect(TokenType.KeywordChoice)
		let name = this.parseIdentifier()
		let generics = this.parseOptionalGenericList()

		let leftBrace = this.tokens.expect(TokenType.SymbolLeftBrace)

		let cases: Array<parser.ChoiceCaseNode> = []

		if (this.tokens.peek()?.type !== TokenType.SymbolRightBrace) {
			cases.push(this.parseChoiceCase())

			while (this.tokens.peek()?.type === TokenType.SymbolComma) {
				this.tokens.next()

				if (this.tokens.peek()?.type === TokenType.SymbolRightBrace) {
					break
				}

				this.refuseListContinuation(
					TokenType.SymbolRightBrace,
					leftBrace,
				)

				cases.push(this.parseChoiceCase())
			}
		}

		let rightBrace = this.tokens.expectClosing(
			TokenType.SymbolRightBrace,
			leftBrace,
		)

		return generators.choiceDeclarationStatement(
			name,
			generics,
			cases,
			{ start: keyword.position.start, end: rightBrace.position.end },
			this.tokens.documentationAbove(keyword.position.start.line),
		)
	}

	// A payload shape may be followed by `= { … }`, the Record a construction
	// is filled from. Nothing else follows a Case, so an `=` is always read and
	// refused where there is no payload.
	protected parseChoiceCase(): parser.ChoiceCaseNode {
		let name = this.parseIdentifier()
		let type: parser.RecordTypeDeclarationNode | null = null

		if (this.tokens.peek()?.type === TokenType.SymbolLeftBrace) {
			type = this.parseRecordType()
		}

		let defaultValue: parser.ExpressionNode | null = null

		if (this.tokens.peek()?.type === TokenType.SymbolEqual) {
			this.tokens.next()

			defaultValue = this.parseExpression()

			if (type === null) {
				reportError(
					`Case '#${name.content}' carries no payload to default`,
					defaultValue.position,
					{
						code: "case-default-without-payload",
						labels: [
							primary(defaultValue.position, "this default"),
						],
						notes: [
							"A default fills members in for a construction that left them out, and a Case with no payload shape has none.",
						],
						helps: [
							`Give '#${name.content}' a payload shape, or write it on its own.`,
						],
					},
				)

				defaultValue = null
			}
		}

		return { name, type, defaultValue }
	}

	// A free `function` always carries a body. A native free Function exists
	// only as an `overload function` entry.
	protected parseFunctionStatement(): parser.FunctionStatementNode {
		let keyword = this.tokens.expect(TokenType.KeywordFunction)

		let name = this.parseIdentifier()
		let value = this.parseOptionallyGenericFunctionLiteral()

		return generators.functionStatement(name, value.value, {
			start: keyword.position.start,
			end: value.position.end,
		})
	}

	// An `overload function <name> { … }` block of a `declarations { … }`
	// Program. Each entry is a Function literal or a native signature, and its
	// index names the `__overload$N` export a call binds to.
	protected parseOverloadedFunctionStatement(): parser.OverloadedFunctionStatementNode {
		let keyword = this.tokens.expect(TokenType.KeywordOverload)
		let documentation = this.tokens.documentationAbove(
			keyword.position.start.line,
		)

		this.tokens.expect(TokenType.KeywordFunction)

		let name = this.parseIdentifier()

		let leftBrace = this.tokens.expect(TokenType.SymbolLeftBrace)

		let methods = this.parseStatementList(() =>
			this.parseMethodBodyOrSignature(),
		)

		let closingPosition = this.parseClosingBrace(leftBrace.position)

		return generators.overloadedFunctionStatement(
			name,
			methods,
			{
				start: keyword.position.start,
				end: closingPosition.end,
			},
			documentation,
		)
	}

	protected parseIfStatement():
		| parser.IfStatementNode
		| parser.IfElseStatementNode {
		let keyword = this.tokens.expect(TokenType.KeywordIf)
		let condition = this.parseExpression()
		let block = this.parseBlock()

		let ifStatement = generators.ifStatement(condition, block.body, {
			start: keyword.position.start,
			end: block.position.end,
		})

		if (this.tokens.peek()?.type !== TokenType.KeywordElse) {
			return ifStatement
		}

		this.tokens.next()

		if (this.tokens.peek()?.type === TokenType.KeywordIf) {
			let falseBody = this.parseIfStatement()

			return generators.ifElseStatementNode(ifStatement, falseBody, {
				start: ifStatement.position.start,
				end: falseBody.position.end,
			})
		}

		let falseBlock = this.parseBlock()

		return generators.ifElseStatementNode(ifStatement, falseBlock.body, {
			start: ifStatement.position.start,
			end: falseBlock.position.end,
		})
	}

	protected parseNamespaceDefinitionStatement(): parser.NamespaceDefinitionStatementNode {
		let keyword = this.tokens.expect(TokenType.KeywordNamespace)
		let name = this.parseIdentifier()
		let generics = this.parseOptionalGenericList()

		let targetType: parser.TypeDeclarationNode | null = null
		if (this.tokens.peek()?.type === TokenType.KeywordFor) {
			this.tokens.next()
			targetType = this.parseType()
		}

		let conformsTo = this.parseConformanceClauses()

		let leftBrace = this.tokens.expect(TokenType.SymbolLeftBrace)

		let body = this.parseStatementList(() => this.parseNamespaceBodyNode())
		let closingPosition = this.parseClosingBrace(leftBrace.position)

		// Properties and Methods are keyed apart, so a Property may share a
		// Method's name. Two Methods may not, even when one is `static`.
		this.reportDuplicateNames(
			body.filter((node) => node.nodeType === "NamespacePropertyNode"),
			"Property",
			"duplicate-property",
		)
		this.reportDuplicateNames(
			body.filter((node) => node.nodeType !== "NamespacePropertyNode"),
			"Method",
			"duplicate-method",
			[
				"Write both signatures inside one 'overload' block when both are meant to exist.",
			],
		)

		return generators.namespaceDefinitionStatement(
			name,
			generics,
			targetType,
			conformsTo,
			body,
			{
				start: keyword.position.start,
				end: closingPosition.end,
			},
			this.tokens.documentationAbove(keyword.position.start.line),
		)
	}

	// `is` is contextual, since `::is()` is a Method. Each conformance carries
	// its own `is`, as in `is Equatable, is Printable`.
	protected parseConformanceClauses(): Array<parser.ConformanceClauseNode> {
		let clauses: Array<parser.ConformanceClauseNode> = []

		let peeked = this.tokens.peek()
		if (!(peeked?.type === TokenType.Identifier && peeked.value === "is")) {
			return clauses
		}

		let isToken = this.tokens.next()
		clauses.push(this.parseConformanceClause(isToken))

		while (this.tokens.peek()?.type === TokenType.SymbolComma) {
			this.tokens.next()

			let next = this.tokens.peek()
			if (!(next?.type === TokenType.Identifier && next.value === "is")) {
				fail(
					"Each conformance needs its own 'is' — write 'is Equatable, is Printable'",
					next?.position,
					"expected 'is' before this Protocol",
				)
			}

			let clauseIsToken = this.tokens.next()
			clauses.push(this.parseConformanceClause(clauseIsToken))
		}

		return clauses
	}

	protected parseConformanceClause(
		isToken: Token,
	): parser.ConformanceClauseNode {
		let protocol = this.parseIdentifier()
		let conditions = this.parseOptionalWhereClause()

		let end =
			conditions.length > 0
				? conditions[conditions.length - 1].position.end
				: protocol.position.end

		return generators.conformanceClause(protocol, conditions, {
			start: isToken.position.start,
			end,
		})
	}

	// `where Generic is Protocol (, Generic is Protocol)*`, with `where`
	// recognised by content as in `parseOptionalGuard`.
	protected parseOptionalWhereClause(): Array<parser.WhereConditionNode> {
		let token = this.tokens.peek()

		if (
			!(token?.type === TokenType.Identifier && token.value === "where")
		) {
			return []
		}

		this.tokens.next()

		let conditions: Array<parser.WhereConditionNode> = [
			this.parseWhereCondition(),
		]

		while (this.tokens.peek()?.type === TokenType.SymbolComma) {
			// A comma followed by `is` separates conformance clauses, as in
			// `is A where Item is X, is B`, so it ends the condition list.
			let afterComma = this.tokens.peek(1)

			if (
				afterComma?.type === TokenType.Identifier &&
				afterComma.value === "is"
			) {
				break
			}

			this.tokens.next()
			conditions.push(this.parseWhereCondition())
		}

		return conditions
	}

	protected parseWhereCondition(): parser.WhereConditionNode {
		let generic = this.parseIdentifier()

		// A condition starting with `is` or `where` has almost certainly
		// dropped its Type Parameter's name.
		if (generic.content === "is" || generic.content === "where") {
			fail(
				`'${generic.content}' can not name a Type Parameter in a 'where' condition`,
				generic.position,
				"expected a Type Parameter name here",
			)
		}

		let isToken = this.tokens.peek()

		if (
			!(isToken?.type === TokenType.Identifier && isToken.value === "is")
		) {
			fail(
				"A 'where' condition reads 'Generic is Protocol'",
				isToken?.position,
				"expected 'is' here",
			)
		}

		this.tokens.next()

		let protocol = this.parseIdentifier()

		return generators.whereCondition(generic, protocol, {
			start: generic.position.start,
			end: protocol.position.end,
		})
	}

	protected parseNamespaceBodyNode(): NamespaceBodyNode {
		let token = this.peekOrFail()

		// An `overload` block and a static Property own no signature line to
		// read Documentation from, so theirs is read here.
		let documentation = this.tokens.documentationAbove(
			token.position.start.line,
		)

		if (token.type === TokenType.KeywordOverload) {
			this.tokens.next()

			let isStatic = false
			if (
				this.tokens.peek()?.type === TokenType.KeywordStatic &&
				isIdentifierToken(this.tokens.peek(1))
			) {
				this.tokens.next()
				isStatic = true
			}

			let name = this.parseIdentifier()

			let leftBrace = this.tokens.expect(TokenType.SymbolLeftBrace)

			if (this.mode === "declarations") {
				// In declarations mode an overload block may mix bodied and
				// body-less entries.
				let methods = this.parseStatementList(() =>
					this.parseMethodBodyOrSignature(),
				)
				let closing = this.parseClosingBrace(leftBrace.position)

				return {
					nodeType: isStatic
						? "OverloadedStaticMethodSignaturesNode"
						: "OverloadedMethodSignaturesNode",
					name,
					methods,
					position: {
						start: token.position.start,
						end: closing.end,
					},
					documentation,
				}
			}

			let methods = this.parseStatementList(() =>
				this.parseOptionallyGenericFunctionLiteral(),
			)
			let closing = this.parseClosingBrace(leftBrace.position)
			let position = {
				start: token.position.start,
				end: closing.end,
			}

			if (isStatic) {
				return {
					nodeType: "OverloadedStaticMethodNode",
					name,
					methods,
					position,
					documentation,
				}
			}

			return {
				nodeType: "OverloadedMethodNode",
				name,
				methods,
				position,
				documentation,
			}
		}

		if (
			token.type === TokenType.KeywordStatic &&
			isIdentifierToken(this.tokens.peek(1))
		) {
			this.tokens.next()

			let name = this.parseIdentifier()

			if (
				this.tokens.peek()?.type === TokenType.SymbolLeftParen ||
				this.tokens.peek()?.type === TokenType.SymbolLeftAngle
			) {
				if (this.mode === "declarations") {
					let result = this.parseMethodBodyOrSignature()

					if (result.nodeType === "NativeMethodSignature") {
						return {
							nodeType: "StaticMethodSignatureNode",
							name,
							signature: result,
						}
					}

					return {
						nodeType: "StaticMethodNode",
						name,
						method: result,
					}
				}

				return {
					nodeType: "StaticMethodNode",
					name,
					method: this.parseOptionallyGenericFunctionLiteral(),
				}
			}

			let type = this.parseOptionalDeclarationType()

			// A native static Property, `static Pi: Transcendental` without an
			// `=`, is legal only in declarations mode.
			if (
				this.mode === "declarations" &&
				this.tokens.peek()?.type !== TokenType.SymbolEqual
			) {
				return {
					nodeType: "NamespacePropertyNode",
					name,
					documentation,
					type,
					value: null,
				}
			}

			this.tokens.expect(TokenType.SymbolEqual)

			let value = this.parseExpression()

			return {
				nodeType: "NamespacePropertyNode",
				name,
				documentation,
				type,
				value,
			}
		}

		let name = this.parseIdentifier()

		if (this.mode === "declarations") {
			let result = this.parseMethodBodyOrSignature()

			if (result.nodeType === "NativeMethodSignature") {
				return {
					nodeType: "SimpleMethodSignatureNode",
					name,
					signature: result,
				}
			}

			return {
				nodeType: "SimpleMethodNode",
				name,
				method: result,
			}
		}

		return {
			nodeType: "SimpleMethodNode",
			name,
			method: this.parseOptionallyGenericFunctionLiteral(),
		}
	}

	// The `declarations`-mode Method form: a signature, then a block or nothing
	// for a native bound by name. The bodied branch builds what
	// `parseOptionallyGenericFunctionLiteral` builds.
	protected parseMethodBodyOrSignature():
		| parser.FunctionValueNode
		| parser.NativeMethodSignatureNode {
		let documentation = this.documentationHere()
		let genericList = this.parseOptionalGenericListWithPosition()
		let generics = genericList.generics
		let parameterList = this.parseParameterList()
		let returnType = this.parseReturnType()

		if (this.tokens.peek()?.type === TokenType.SymbolLeftBrace) {
			let { result: block, completes } = this.completingBody(() =>
				this.outsideTestBody(() => this.parseBlock()),
			)

			let definition =
				generics.length > 0
					? generators.genericFunctionDefinition(
							generics,
							parameterList.parameters,
							returnType,
							block.body,
							parameterList.position,
							documentation,
							completes,
							genericList.position,
						)
					: generators.functionDefinition(
							parameterList.parameters,
							returnType,
							block.body,
							parameterList.position,
							documentation,
							completes,
						)

			return generators.functionValueNode(definition, {
				start: parameterList.position.start,
				end: block.position.end,
			})
		}

		this.refusePatternParameters(parameterList.parameters, "native Method")

		return generators.nativeMethodSignature(
			generics,
			parameterList.parameters,
			returnType,
			{
				start: parameterList.position.start,
				end: returnType.position.end,
			},
			documentation,
		)
	}

	protected parseProtocolDeclarationStatement(): parser.ProtocolDeclarationStatementNode {
		let keyword = this.tokens.expect(TokenType.KeywordProtocol)
		let name = this.parseIdentifier()
		// `protocol Orderable is Comparable` reads as a conformance list. The
		// enricher refuses a `where` clause, since a Protocol has no Type
		// Parameters.
		let conformsTo = this.parseConformanceClauses()

		let leftBrace = this.tokens.expect(TokenType.SymbolLeftBrace)

		let body = this.parseStatementList(() => this.parseProtocolBodyNode())
		let closingPosition = this.parseClosingBrace(leftBrace.position)

		// A Protocol's signatures are name-keyed like a Namespace's Methods.
		this.reportDuplicateNames(body, "Method", "duplicate-method", [
			"Write both signatures inside one 'overload' block when both are meant to exist.",
		])

		return generators.protocolDeclarationStatement(
			name,
			conformsTo,
			body,
			{
				start: keyword.position.start,
				end: closingPosition.end,
			},
			this.tokens.documentationAbove(keyword.position.start.line),
		)
	}

	protected parseProtocolBodyNode(): parser.ProtocolMethods[string] {
		let token = this.peekOrFail()

		// An `overload` block owns no signature line, so its Documentation is
		// read here.
		let documentation = this.tokens.documentationAbove(
			token.position.start.line,
		)

		if (token.type === TokenType.KeywordOverload) {
			this.tokens.next()

			let isStatic = false
			if (
				this.tokens.peek()?.type === TokenType.KeywordStatic &&
				isIdentifierToken(this.tokens.peek(1))
			) {
				this.tokens.next()
				isStatic = true
			}

			let name = this.parseIdentifier()

			let leftBrace = this.tokens.expect(TokenType.SymbolLeftBrace)

			let signatures = this.parseStatementList(() =>
				this.parseProtocolMethodSignature(),
			)
			let closing = this.parseClosingBrace(leftBrace.position)
			let position = {
				start: token.position.start,
				end: closing.end,
			}

			if (isStatic) {
				return {
					nodeType: "OverloadedStaticProtocolMethod",
					name,
					signatures,
					position,
					documentation,
				}
			}

			return {
				nodeType: "OverloadedProtocolMethod",
				name,
				signatures,
				position,
				documentation,
			}
		}

		if (
			token.type === TokenType.KeywordStatic &&
			isIdentifierToken(this.tokens.peek(1))
		) {
			this.tokens.next()

			let name = this.parseIdentifier()

			return {
				nodeType: "StaticProtocolMethod",
				name,
				signature: this.parseProtocolMethodSignature(),
			}
		}

		let name = this.parseIdentifier()

		return {
			nodeType: "SimpleProtocolMethod",
			name,
			signature: this.parseProtocolMethodSignature(),
		}
	}

	// A Protocol Method is a requirement, or a provided one with a block. A
	// provided body builds the Function Definition any bodied Method builds.
	protected parseProtocolMethodSignature(): parser.ProtocolMethodSignatureNode {
		let documentation = this.documentationHere()
		let parameterList = this.parseParameterList()
		let returnType = this.parseReturnType()

		let body: parser.FunctionValueNode | null = null

		if (this.tokens.peek()?.type === TokenType.SymbolLeftBrace) {
			let { result: block, completes } = this.completingBody(() =>
				this.outsideTestBody(() => this.parseBlock()),
			)

			body = generators.functionValueNode(
				generators.functionDefinition(
					parameterList.parameters,
					returnType,
					block.body,
					parameterList.position,
					documentation,
					completes,
				),
				{
					start: parameterList.position.start,
					end: block.position.end,
				},
			)
		}

		this.refusePatternParameters(
			parameterList.parameters,
			"Protocol Method",
		)
		this.refuseDefaultValues(
			parameterList.parameters,
			"Protocol requirement",
		)

		return generators.protocolMethodSignature(
			parameterList.parameters,
			returnType,
			body,
			{
				start: parameterList.position.start,
				end: returnType.position.end,
			},
			documentation,
		)
	}

	protected parseOptionalDeclarationType(): parser.TypeDeclarationNode | null {
		if (this.tokens.peek()?.type === TokenType.SymbolColon) {
			this.tokens.next()

			return this.parseType()
		}

		return null
	}

	// `expect EXPR`, `require EXPR` and `require MATCHER = EXPR`.
	// See "Assertions" in DEVELOPMENT.md.
	protected parseAssertionStatement():
		| parser.ExpectStatementNode
		| parser.RequireStatementNode {
		let keyword = this.tokens.next()
		let matcher = this.speculateAssertionMatcher()

		if (matcher !== null) {
			this.tokens.expect(TokenType.SymbolEqual)

			let value = this.parseExpression()
			let position = {
				start: keyword.position.start,
				end: value.position.end,
			}

			this.refuseMatcherOnExpect(keyword, matcher)
			this.refuseUnusableMatcher(matcher, value)

			let matches = this.tokens.peek()

			if (
				matches?.type === TokenType.Identifier &&
				matches.value === MATCHES
			) {
				this.refuseSnapshotAfterMatcher(matcher)
			}

			this.reportAssertionOutsideTest(keyword, position)

			return generators.requireStatement(value, matcher, null, position)
		}

		let value = this.parseExpression()
		let snapshot: parser.SnapshotNode | null = null
		let end = value.position.end

		let following = this.tokens.peek()

		if (
			following?.type === TokenType.Identifier &&
			following.value === "is"
		) {
			this.refuseMatcherAfterValue(following)
		}

		if (
			following?.type === TokenType.Identifier &&
			following.value === MATCHES
		) {
			snapshot = this.parseSnapshot()
			end = snapshot.position.end
		}

		let position = { start: keyword.position.start, end }

		this.reportAssertionOutsideTest(keyword, position)

		if (keyword.type === TokenType.KeywordRequire) {
			return generators.requireStatement(value, null, snapshot, position)
		}

		return generators.expectStatement(value, null, snapshot, position)
	}

	// The Matcher of `require MATCHER = EXPR`, kept only where an `=` follows.
	// See "Assertions" in DEVELOPMENT.md.
	protected speculateAssertionMatcher(): parser.MatcherNode | null {
		if (!startsMatcher(this.tokens.peek())) {
			return null
		}

		return this.speculate(
			() => this.parseMatcher(true),
			() => this.tokens.peek()?.type === TokenType.SymbolEqual,
		)
	}

	// `expect MATCHER = EXPR`, refused after the whole Statement is read.
	protected refuseMatcherOnExpect(
		keyword: Token,
		matcher: parser.MatcherNode,
	): void {
		if (keyword.type !== TokenType.KeywordExpect) {
			return
		}

		throw new ParseError(
			"An 'expect' can not take a value apart",
			matcher.position,
			"this would introduce a name",
			{
				code: "matcher-on-expect",
				notes: [
					"An 'expect' records its result and the test carries on, so a name it introduced would stand below a line that may never have run. A 'require' ends the test where it stands, which is what makes the names it introduces safe to read.",
				],
				helps: [
					"Take the value apart with 'require': 'require #Value(item) = value'.",
					"Or compare instead: 'expect value::is(…)'.",
				],
			},
		)
	}

	// A wildcard or a literal means nothing left of `=`. A shape that binds
	// nothing, as in `require #Empty = x`, is fine.
	protected refuseUnusableMatcher(
		matcher: parser.MatcherNode,
		value: parser.ExpressionNode,
	): void {
		if (matcher.nodeType === "WildcardMatcher") {
			throw new ParseError(
				"This 'require' asks nothing of the value",
				matcher.position,
				"'_' holds for every value",
				{
					code: "wildcard-in-require",
					notes: [
						"A Matcher left of '=' both asks what the value has to be and names its parts, and '_' does neither: every value answers it, and it binds nothing.",
					],
					helps: [
						"Name the shape the value has to have — a Case, a Type, a Pattern — or drop the line.",
					],
				},
			)
		}

		if (matcher.nodeType === "LiteralMatcher") {
			throw new ParseError(
				"A written value has no parts to name",
				matcher.position,
				"this is a value, not a shape",
				{
					code: "literal-in-require",
					// The Quick Fix reads where the value ends off this Label,
					// since the Statement is dropped.
					labels: [
						secondary(value.position, "the value it asks about"),
					],
					notes: [
						"'require MATCHER = EXPR' takes a value apart by its shape — a Case, a Type, a Pattern. A written value is not a shape: what it asks is whether the two are equal, and that is what 'Equatable::is' answers.",
					],
					// Spelled from what was written, as the Quick Fix spells
					// its edit.
					helps: [
						`Compare instead: '${writtenValueText(value)}::is(${
							writtenText(this.sourceLines, matcher.position) ||
							"…"
						})'.`,
					],
				},
			)
		}
	}

	// `EXPR is MATCHER`, a form this language does not have, refused after the
	// Matcher is read. See "Assertions" in DEVELOPMENT.md.
	protected refuseMatcherAfterValue(is: Token): never {
		this.tokens.next()

		let matcher = this.parseMatcher(true)

		throw new ParseError(
			"An assertion has no 'is' form",
			{ start: is.position.start, end: matcher.position.end },
			"this Matcher stands after the value",
			{
				code: "matcher-after-value",
				notes: [
					"A name is introduced left of '=', in a Parameter, or in a Handler head — never on the right of anything.",
				],
				helps: [
					"Take the value apart with 'require': 'require #Value(item) = value'.",
					"Or compare instead: 'expect value::is(…)'.",
				],
			},
		)
	}

	// `require MATCHER = EXPR matches snapshot`, refused after the snapshot is
	// read: this line took a value apart rather than holding one.
	protected refuseSnapshotAfterMatcher(matcher: parser.MatcherNode): never {
		let snapshot = this.parseSnapshot()

		throw new ParseError(
			"A snapshot records a value, and this line took one apart",
			snapshot.position,
			"there is no value here to record",
			{
				code: "snapshot-after-matcher",
				// The Matcher's names, for the Quick Fix that records one of
				// them on a line of its own.
				data: {
					kind: "introduced-names",
					names: matcherNames(matcher),
				},
				notes: [
					"A snapshot is of the value an assertion is written over, printed as text. 'require MATCHER = EXPR' is written over a shape instead: it asks what the value has to be and names its parts, so what there is to record is one of those names.",
				],
				helps: [
					"Record the name on a line of its own: 'require #Value(item) = value' then 'expect item matches snapshot'.",
					"Or snapshot the value whole, where it is one that prints: 'expect value matches snapshot'.",
				],
			},
		)
	}

	// `matches snapshot`, inline or stored with `from`.
	// See "Assertions" in DEVELOPMENT.md.
	protected parseSnapshot(): parser.SnapshotNode {
		let matches = this.tokens.next()
		let keyword = this.peekOrFail("'snapshot'")

		if (
			keyword.type !== TokenType.Identifier ||
			keyword.value !== SNAPSHOT
		) {
			fail(
				`Expected 'snapshot' but found ${describeToken(keyword)}.`,
				keyword.position,
				"expected 'snapshot'",
			)
		}

		this.tokens.next()

		if (this.tokens.peek()?.type === TokenType.KeywordFrom) {
			this.tokens.next()

			let name = this.parseSnapshotText("the name of the snapshot")

			return generators.snapshot(
				name,
				null,
				name.position,
				keyword.position,
				{ start: matches.position.start, end: name.position.end },
			)
		}

		let token = this.tokens.peek()

		// An interpolated String goes on to `parseSnapshotText`, which
		// refuses it.
		if (
			token?.type !== TokenType.LiteralString &&
			token?.type !== TokenType.LiteralStringStart
		) {
			return generators.snapshot(
				null,
				null,
				keyword.position,
				keyword.position,
				{ start: matches.position.start, end: keyword.position.end },
			)
		}

		let recorded = this.parseSnapshotText("the recorded value")

		return generators.snapshot(
			null,
			recorded,
			recorded.position,
			keyword.position,
			{ start: matches.position.start, end: recorded.position.end },
		)
	}

	// A plain String Literal, since a recorded value or a snapshot's name
	// holds no Expressions.
	protected parseSnapshotText(what: string): parser.StringValueNode {
		let token = this.peekOrFail(what)

		if (token.type !== TokenType.LiteralString) {
			fail(
				`Expected ${what} but found ${describeToken(token)}.`,
				token.position,
				"expected a String Literal",
			)
		}

		this.tokens.next()

		return generators.stringValueNode(token.value, token.position)
	}

	// An assertion belongs to a test's own block and the blocks nested in it,
	// not to a Function literal written there.
	protected reportAssertionOutsideTest(
		keyword: Token,
		position: common.Position,
	): void {
		if (this.insideTestBody || this.suppressDiagnostics) {
			return
		}

		reportError(
			`'${keyword.value}' may only be written in a test's body`,
			position,
			{
				code: "expect-outside-test",
				labels: [
					primary(
						keyword.position,
						"this assertion belongs to no test",
					),
				],
				notes: [
					"An assertion records its result against the test that is running, so it is a Statement of a test's own block and of the blocks nested in it — never of a Function literal written there.",
				],
				helps: [
					"Move it into a 'test \"…\" { … }' block, or return the value and assert on it there.",
				],
			},
		)
	}

	protected parseReturnStatement(): parser.ReturnStatementNode {
		let leftAngle = this.tokens.expect(TokenType.SymbolLeftAngle)
		this.tokens.expect(TokenType.SymbolDash)

		let expression = this.parseExpression()

		return generators.returnStatement(expression, {
			start: leftAngle.position.start,
			end: expression.position.end,
		})
	}

	// #endregion

	// #region Expressions

	// `endsBeforeBlockParameters` is set for the rows of a table test,
	// `across [ … ] (row: Row) { … }`, where a `(` opens a Parameter list rather
	// than a call. See `stopsBeforeParameterList`.
	protected parseExpression(
		endsBeforeBlockParameters = false,
	): parser.ExpressionNode {
		this.enterNesting()

		try {
			return this.parseExpressionLevels(endsBeforeBlockParameters)
		} finally {
			this.nestingDepth--
		}
	}

	protected parseExpressionLevels(
		endsBeforeBlockParameters = false,
	): parser.ExpressionNode {
		let expression = this.parsePrimaryExpression()

		while (true) {
			let token = this.tokens.peek()
			let following = this.tokens.peek(1)

			if (
				endsBeforeBlockParameters &&
				token?.type === TokenType.SymbolLeftParen &&
				this.stopsBeforeParameterList()
			) {
				break
			}

			// The two ':' of a Method call read as '::' only when flush.
			if (
				token?.type === TokenType.SymbolColon &&
				following?.type === TokenType.SymbolColon &&
				isAdjacent(token.position, following.position)
			) {
				this.tokens.next()
				this.tokens.next()

				let namespaceSpecifier: parser.IdentifierNode | null = null
				if (this.tokens.peek()?.type === TokenType.SymbolLeftAngle) {
					let leftAngle = this.tokens.next()
					namespaceSpecifier = this.parseIdentifier()
					this.tokens.expectClosing(
						TokenType.SymbolRightAngle,
						leftAngle,
					)
				}

				let member = this.parseIdentifier()
				let argumentList = this.parseArgumentList()

				expression = generators.methodInvocation(
					expression,
					member,
					namespaceSpecifier,
					argumentList.args,
					{
						start: expression.position.start,
						end: argumentList.position.end,
					},
				)
			} else if (token?.type === TokenType.SymbolDot) {
				this.tokens.next()

				let member = this.parseIdentifier()

				expression = generators.lookup(expression, member, {
					start: expression.position.start,
					end: member.position.end,
				})
			} else if (token?.type === TokenType.SymbolLeftParen) {
				let argumentList = this.parseArgumentList()

				expression = generators.functionInvocation(
					expression,
					argumentList.args,
					{
						start: expression.position.start,
						end: argumentList.position.end,
					},
				)
			} else if (
				token?.type === TokenType.SymbolLeftBracket &&
				isAdjacent(expression.position, token.position)
			) {
				// `primes[0]`: a `[` written flush after a value is an index.
				// With a space it opens a List, as in `append(contentsOf [1, 2])`.
				let refused = this.refuseIndexBrackets(expression)

				// A `[` whose `]` never arrives is left for the unclosed List
				// to be reported.
				if (refused === null) {
					break
				}

				expression = refused
			} else {
				break
			}
		}

		// Another language's way of continuing an Expression, such as the `+`
		// of `1 + 2`, answered on the Expression's own line.
		// See "Another language's syntax" in DEVELOPMENT.md.
		let foreign = this.foreignTextAhead(expression)

		if (
			foreign !== null &&
			foreign.position.start.line === expression.position.end.line
		) {
			this.refuseCallTypeArguments(expression)

			if (!this.swallowForeignTail()) {
				this.refuseForeignText(foreign)
			}

			this.reportForeignText(foreign)
		}

		return expression
	}

	// Steps over a `;`, `//` or `/* … */` after a complete Statement, so the
	// Statement is kept. See "Another language's syntax" in DEVELOPMENT.md.
	protected swallowForeignTail(): boolean {
		let lexeme = this.foreignLexeme()

		if (lexeme === null) {
			return false
		}

		if (lexeme.text === ";") {
			if (this.tokens.peek()?.value !== ";") {
				return false
			}

			this.tokens.next()

			return true
		}

		if (lexeme.text === "//") {
			let line = lexeme.position.start.line

			while (this.tokens.peek()?.position.start.line === line) {
				this.tokens.next()
			}

			return true
		}

		if (!lexeme.text.startsWith("/*")) {
			return false
		}

		let closing = this.blockCommentLength()

		if (closing === null) {
			return false
		}

		for (let step = 0; step < closing; step++) {
			this.tokens.next()
		}

		return true
	}

	// How many Tokens the `/* … */` at the cursor spans, or null. The closing
	// `*/` arrives as a Token ending in `*`, such as `word*`, with a `/` flush.
	protected blockCommentLength(): number | null {
		for (let offset = 1; ; offset++) {
			let token = this.tokens.peek(offset)

			if (token === undefined) {
				return null
			}

			if (token.type !== TokenType.SymbolSlash) {
				continue
			}

			let previous = this.tokens.peek(offset - 1)

			if (
				previous !== undefined &&
				previous.value.endsWith("*") &&
				isAdjacent(previous.position, token.position)
			) {
				return offset + 1
			}
		}
	}

	// `primes[0]`, reported and read past into a `RefusedValue`. Null where the
	// brackets never close. See "Another language's syntax" in DEVELOPMENT.md.
	protected refuseIndexBrackets(
		expression: parser.ExpressionNode,
	): parser.RefusedValueNode | null {
		let opening = this.tokens.peek()
		let length = this.balancedBracketLength()

		if (opening === undefined || length === null) {
			return null
		}

		let key = this.writtenIndexKey(length)
		let end = expression.position.end

		// `matrix[0][1]` is one habit, so the whole run of flush brackets is
		// read past and answered once.
		while (true) {
			let bracket = this.tokens.peek()

			if (
				bracket?.type !== TokenType.SymbolLeftBracket ||
				bracket.position.start.line !== end.line ||
				bracket.position.start.column !== end.column
			) {
				break
			}

			let group = this.balancedBracketLength()

			if (group === null) {
				break
			}

			for (let step = 0; step < group; step++) {
				end = this.tokens.next().position.end
			}
		}

		let written = { start: opening.position.start, end }

		// An `=` after the brackets is a write, refused with the whole
		// Statement as `refuseMemberAssignment` does. A `==` is left to the
		// operator habits.
		if (this.foreignLexeme()?.text === "=") {
			this.refuseForeignText(
				indexWriteRefusal(
					writtenReceiver(expression),
					key,
					this.writtenAssignedValue(),
					{ start: expression.position.start, end },
				),
			)
		}

		this.reportForeignText(
			indexRefusal(writtenReceiver(expression), key, written),
		)

		return generators.refusedValue(expression, {
			start: expression.position.start,
			end,
		})
	}

	// How many Tokens the bracket group at the cursor spans, its own two
	// included, or null where its `]` never arrives.
	protected balancedBracketLength(): number | null {
		let depth = 0

		for (let offset = 0; ; offset++) {
			let token = this.tokens.peek(offset)

			if (token === undefined) {
				return null
			}

			if (token.type === TokenType.SymbolLeftBracket) {
				depth++
			} else if (token.type === TokenType.SymbolRightBracket) {
				depth--

				if (depth === 0) {
					return offset + 1
				}
			}
		}
	}

	// The one Token written between the brackets, for a Help, read rather
	// than parsed. `keyed` marks a String, which a Dictionary keys by. A String
	// holding a quote or a backslash can not be spelled back from its value.
	protected writtenIndexKey(
		length: number,
	): { text: string; keyed: boolean } | null {
		if (length !== 3) {
			return null
		}

		let written = this.tokens.peek(1) as Token

		if (
			written.type === TokenType.LiteralNumber ||
			written.type === TokenType.Identifier
		) {
			return { text: written.value, keyed: false }
		}

		if (
			written.type !== TokenType.LiteralString ||
			written.value.includes('"') ||
			written.value.includes("\\")
		) {
			return null
		}

		return { text: `"${written.value}"`, keyed: true }
	}

	// The one Token after the `=`, where it is the rest of its line, as
	// `writtenIndexKey` reads one. `at` is its offset from the cursor on the `=`.
	protected writtenAssignedValue(at = 1): string | null {
		let written = this.tokens.peek(at)
		let following = this.tokens.peek(at + 1)

		if (
			written === undefined ||
			following?.position.start.line === written.position.start.line
		) {
			return null
		}

		if (
			written.type === TokenType.LiteralNumber ||
			written.type === TokenType.Identifier
		) {
			return written.value
		}

		if (
			written.type !== TokenType.LiteralString ||
			written.value.includes('"') ||
			written.value.includes("\\")
		) {
			return null
		}

		return `"${written.value}"`
	}

	// The refusal reported rather than thrown, for the sites that read past
	// what they report.
	protected reportForeignText(refusal: ForeignRefusal): void {
		if (this.suppressDiagnostics) {
			return
		}

		reportError(refusal.message, refusal.position, {
			code: refusal.code,
			labels: [primary(refusal.position, refusal.label)],
			notes: refusal.notes,
			helps: refusal.helps,
			...(refusal.data === undefined ? {} : { data: refusal.data }),
		})
	}

	// `identity<Integer>(1)`: Type Arguments on a call. Asked before the
	// operator table, which would read the `<` as a comparison.
	protected refuseCallTypeArguments(expression: parser.ExpressionNode): void {
		if (
			expression.nodeType !== "Identifier" ||
			this.tokens.peek()?.type !== TokenType.SymbolLeftAngle
		) {
			return
		}

		let depth = 0

		// Bounded and on one line, so unbalanced angles never scan the file.
		for (let offset = 0; offset < 32; offset++) {
			let token = this.tokens.peek(offset)

			if (
				token === undefined ||
				token.position.start.line !== expression.position.end.line
			) {
				return
			}

			if (token.type === TokenType.SymbolLeftAngle) {
				depth++

				continue
			}

			if (token.type !== TokenType.SymbolRightAngle) {
				continue
			}

			depth--

			if (depth > 0) {
				continue
			}

			let following = this.tokens.peek(offset + 1)

			if (
				following?.type !== TokenType.SymbolLeftParen ||
				!isAdjacent(token.position, following.position)
			) {
				return
			}

			let position = {
				start: expression.position.end,
				end: token.position.end,
			}

			throw new ParseError(
				"A call writes no Type Arguments",
				position,
				"these are worked out from the Arguments",
				{
					code: "foreign-syntax",
					notes: [
						"Every Type Argument is inferred at the call, which is why a Generic Parameter is declared 'infer' — there is no spelling that pins one.",
						// A Note, not a Help: the parser can not tell whether
						// the Arguments decide the Type Parameter.
						"Where the Arguments do not decide one, the Type Parameter wants a place among the Parameters — a call reads it off an Argument or not at all.",
					],
					helps: [
						`Write '${expression.content}(…)' and let the Arguments decide.`,
					],
					data: {
						kind: "essence-spelling",
						position,
						spelling: "",
					},
				},
			)
		}
	}

	protected parsePrimaryExpression(): parser.ExpressionNode {
		let token = this.peekOrFail("an Expression")

		// The same question in prefix position, asked of a Token that opens
		// no Expression — a `//` at the head of a line, a `/` left over from
		// something written above it. Asked HERE rather than in the default arm
		// below, because the arms in between read Tokens this would answer for:
		// a `-` opens a negative Number and a `<` opens a generic Function
		// literal, and both are Essence wherever they stand at the head of one.
		if (!startsExpression(token)) {
			let foreign = this.foreignTextAhead()

			if (foreign !== null) {
				this.refuseForeignText(foreign)
			}
		}

		// `ChoiceName#CaseName` — recognised before the typed-Record
		// backtrack, since a `#` can never follow the Type of a typed Record
		// literal. The `#` must sit directly against the Identifier: a space
		// between them (`label #Case`) marks a bare Case value passed as a
		// labelled argument, where the Identifier is the label, not a Choice
		// prefix — so the prefixed reading requires the two to be adjacent.
		let following = this.tokens.peek(1)

		if (
			isIdentifierToken(token) &&
			following?.type === TokenType.SymbolHash &&
			token.position.end.line === following.position.start.line &&
			token.position.end.column === following.position.start.column
		) {
			return this.parseCaseValue()
		}

		// `Holder<Integer>#Full(…)` — the same construction with its Type
		// Arguments applied. Speculative, because a `<` after an Identifier opens
		// nothing else in expression position today and there is no adjacency rule
		// that could tell the two apart on sight: what makes this a construction is
		// the `#` on the far side of the Arguments, which only a parse can find.
		// A reading that does not reach one leaves nothing behind and the
		// Identifier is read as itself.
		if (
			isIdentifierToken(token) &&
			following?.type === TokenType.SymbolLeftAngle
		) {
			let applied = this.backtrack(() => this.parseCaseValue())

			if (applied !== null) {
				return applied
			}
		}

		// `Type ~> { … }` — speculative, because a Type and an Identifier
		// open the same way and only the `~>` behind the Type tells them apart.
		// The stream is asked first whether a `~` stands anywhere ahead of here:
		// the parse below can not succeed without consuming one, so a `~`-less
		// tail turns a full Type parse and its throw into an integer compare.
		if (
			(isIdentifierToken(token) ||
				token.type === TokenType.SymbolLeftBrace) &&
			this.tokens.hasTildeAhead()
		) {
			let typedRecord = this.backtrack(() =>
				this.parseTypedRecordLiteral(),
			)

			if (typedRecord !== null) {
				return typedRecord
			}
		}

		switch (token.type) {
			case TokenType.SymbolHash:
				return this.parseCaseValue()
			case TokenType.KeywordMatch:
				return this.parseMatch()
			case TokenType.KeywordDefine:
				return this.parseDefine()
			case TokenType.KeywordStart:
			case TokenType.KeywordComplete:
				if (opensAsynchrony(token, following)) {
					return this.parseStartOrComplete(token)
				}

				return this.parseIdentifier()
			case TokenType.SymbolAt:
				this.tokens.next()
				return generators.self(token.position)
			case TokenType.LiteralString:
				this.tokens.next()
				return generators.stringValueNode(token.value, token.position)
			case TokenType.LiteralStringStart:
				return this.parseInterpolatedString()
			case TokenType.SymbolDash:
			case TokenType.LiteralNumber:
				return this.parseNumberLiteral()
			case TokenType.LiteralTrue:
				this.tokens.next()
				return generators.booleanValueNode(true, token.position)
			case TokenType.LiteralFalse:
				this.tokens.next()
				return generators.booleanValueNode(false, token.position)
			case TokenType.SymbolLeftBracket:
				return this.parseListOrDictionaryLiteral()
			case TokenType.SymbolLeftParen: {
				// The only Function literal whose annotations may be
				// omitted — in expression position there can be an expected
				// signature to read them off. A Generic literal writes its own
				// Generics, so it has nothing to infer them from.
				let literal = this.parseFunctionLiteral(true, false)

				this.refuseDefaultValues(
					literal.value.parameters,
					"Function literal",
				)

				return literal
			}
			case TokenType.SymbolLeftAngle: {
				let literal = this.parseGenericFunctionLiteral(false)

				this.refuseDefaultValues(
					literal.value.parameters,
					"Function literal",
				)

				return literal
			}
			case TokenType.SymbolLeftBrace:
				return this.parseRecordLiteralOrCombination()
			case TokenType.SymbolDot:
				return this.parseMemberPath()
			case TokenType.Identifier:
			case TokenType.KeywordWith:
			case TokenType.KeywordStatic:
			case TokenType.KeywordCase:
			case TokenType.KeywordInfer:
			case TokenType.KeywordChoice:
			case TokenType.KeywordImport:
			case TokenType.KeywordExport:
			case TokenType.KeywordFrom:
			case TokenType.KeywordAs:
			case TokenType.KeywordTests:
			case TokenType.KeywordTest:
			case TokenType.KeywordSuite:
			case TokenType.KeywordBenchmark:
			case TokenType.KeywordExpect:
			case TokenType.KeywordRequire:
			case TokenType.KeywordOtherwise:
				return this.parseIdentifier()
			default:
				fail(
					`Expected an Expression but found ${describeToken(token)}.`,
					token.position,
				)
		}
	}

	// `start x` and `complete x`. The operand is read by the FULL
	// Expression reading rather than by the primary one, so the whole postfix
	// chain behind the Keyword belongs to it: `complete headline(url)::retried
	// (times 3)` completes the retried future, and a Method call on what was
	// waited for is written by binding the answer first — `constant answer =
	// complete x`, then `answer::m()`. Essence has no grouping parentheses, so
	// `(complete x)` is a syntax error rather than the other way to say it. That
	// is the same shape a prefix Keyword takes in every language that has one,
	// and the only reading that makes the everyday call — a future built by a
	// call and completed — need no parentheses at all.
	//
	// Which means the loop in `parseExpressionLevels` has nothing left to
	// attach when this returns: the recursive reading consumed the chain. So a
	// `start` reached from there behaves as a primary Expression that happens to
	// be greedy, and `expressionStartTokenTypes` stays exactly what its NOTE
	// says it is — the cases this switch answers.
	//
	// Reached only through `opensAsynchrony`, which has already found the
	// Expression the operand is read from. A word with nothing behind it is a
	// name — `constant held = complete` reads the value `complete`, and it is
	// the Enricher that answers for a name nothing declared.
	protected parseStartOrComplete(
		keyword: Token,
	): parser.StartNode | parser.CompleteNode {
		this.tokens.next()

		let expression = this.parseExpression()
		let position = {
			start: keyword.position.start,
			end: expression.position.end,
		}

		if (keyword.type === TokenType.KeywordStart) {
			return generators.start(expression, position)
		}

		// Counted for the body being parsed — `start` is not, because it
		// never waits and so never asks anything of the body it stands in.
		this.completesSeen += 1

		return generators.complete(expression, position)
	}

	// `.price`, `.address.city` — the whole chain is consumed here rather
	// than left to the postfix loop, which would otherwise read the second step
	// as a Lookup over the path and build a Node the language has no meaning
	// for. Nothing but a member name may follow a step's '.', so the loop needs
	// no adjacency rule of its own: a path reads its tail exactly the way a
	// Lookup chain reads its own.
	protected parseMemberPath(): parser.MemberPathNode {
		let dot = this.tokens.expect(TokenType.SymbolDot)

		this.refusePartialDecimal(dot)

		let steps = [this.parseIdentifier()]

		while (this.tokens.peek()?.type === TokenType.SymbolDot) {
			this.tokens.next()
			steps.push(this.parseIdentifier())
		}

		this.refusePathPostfix(steps)

		return generators.memberPath(steps, {
			start: dot.position.start,
			end: steps[steps.length - 1].position.end,
		})
	}

	// A path stands for a Function that READS members, so a call attached
	// to it has nothing to attach to. Refused here rather than left to the
	// postfix loop: the loop would build an Invocation over the path and every
	// message from there on would be about the call rather than about the path
	// that can not carry one.
	protected refusePathPostfix(steps: Array<parser.IdentifierNode>): void {
		let token = this.tokens.peek()

		if (token === undefined) {
			return
		}

		let following = this.tokens.peek(1)
		let spelling =
			token.type === TokenType.SymbolLeftParen
				? "("
				: token.type === TokenType.SymbolColon &&
					  following?.type === TokenType.SymbolColon &&
					  isAdjacent(token.position, following.position)
					? "::"
					: null

		if (spelling === null) {
			return
		}

		throw new ParseError(
			"A member path reads members and nothing else",
			token.position,
			`'${spelling}' can not follow a path`,
			{
				code: "path-is-members-only",
				notes: [
					"A path is the Function that reads those members off its Argument, so there is nothing here for a call to be made on.",
				],
				// The untyped literal only where a literal READS its
				// Types — an Argument list, and nowhere else. Written into a
				// Declaration or a return, `(_ item) { … }` is refused for
				// having no Parameter Type, which is a second report rather
				// than an answer, so there the Types are spelled as the holes
				// they are. Exactly what `path-without-context` says about the
				// same literal in the same positions.
				helps: [
					this.insideArgumentList
						? `Write the Function literal instead: '${this.pathFunctionLiteral(steps, spelling)}'.`
						: `Write the Function literal instead, with the Parameter and return Types a path leaves out — '${this.pathFunctionLiteral(steps, spelling, true)}', filling each '<Type>' in.`,
				],
			},
		)
	}

	// The path and the call written on it, spelled back as the Function
	// literal that CAN carry one. Every word of it is the reader's own but
	// `item`, which names the Parameter — and that Parameter is left UNTYPED on
	// purpose: a literal handed to a Method reads its Parameter's Type off the
	// Argument it is passed, so there is nothing to write there and nothing to
	// get wrong. The `(_ item: SomeType) { <- item.price::rounded() }` this used
	// to print named a Type nothing declares and a Method the standard library
	// has not got, and it printed them at a reader who had written neither.
	protected pathFunctionLiteral(
		steps: Array<parser.IdentifierNode>,
		spelling: string,
		// With the two Types written as holes, for a position that hands
		// a literal neither of them.
		typed = false,
	): string {
		let path = steps.map((step) => step.content).join(".")
		let called = spelling === "::" ? this.tokens.peek(2) : null
		let call =
			spelling === "("
				? this.writtenCallArguments(0)
				: called !== undefined &&
					  called !== null &&
					  isIdentifierToken(called)
					? `::${called.value}${this.writtenCallArguments(3)}`
					: "::…()"

		return typed
			? `(_ item: <Type>) -> <Type> { <- item.${path}${call} }`
			: `(_ item) { <- item.${path}${call} }`
	}

	// The Argument list at `at`, where it is empty or holds ONE Token a
	// Help can print back — `()`, `(2)`, `(other)`. Everything longer is an
	// Expression of the reader's own, and `…` says theirs goes here rather than
	// printing half of it back at them.
	protected writtenCallArguments(at: number): string {
		if (this.tokens.peek(at)?.type !== TokenType.SymbolLeftParen) {
			return "(…)"
		}

		let written = this.tokens.peek(at + 1)

		if (written?.type === TokenType.SymbolRightParen) {
			return "()"
		}

		if (
			written !== undefined &&
			(written.type === TokenType.LiteralNumber ||
				written.type === TokenType.Identifier) &&
			this.tokens.peek(at + 2)?.type === TokenType.SymbolRightParen
		) {
			return `(${written.value})`
		}

		return "(…)"
	}

	// The payload parens are part of the construction syntax — they are
	// consumed here rather than left to the invocation postfix loop, because a
	// Case is a value, not a Function. Empty parens construct a unit Case.
	// Without a leading Identifier this parses the bare form (`#Add({ … })`).
	protected parseCaseValue(): parser.CaseValueNode {
		let choice: parser.IdentifierNode | null = null
		let typeArguments: Array<parser.TypeDeclarationNode> | null = null
		let hash: Token

		if (this.tokens.peek()?.type === TokenType.SymbolHash) {
			hash = this.tokens.next()
		} else {
			choice = this.parseIdentifier()

			// `Holder<Integer>#Full(…)` — the Choice's Type Arguments
			// applied at the value, which is the other half of how a construction
			// is decided. The same list an annotation writes, read by the same
			// parse, so `Holder<List<Integer>>#Full` needs nothing of its own —
			// and held to the same one-line rule, for the same reason: a `<` that
			// opens the NEXT line begins something of its own, and an application
			// is always written on one line.
			let leftAngleToken = this.tokens.peek()

			if (
				leftAngleToken?.type === TokenType.SymbolLeftAngle &&
				leftAngleToken.position.start.line === choice.position.end.line
			) {
				let argumentList = this.parseTypeArgumentList()
				let hashToken = this.tokens.peek()

				// And the `#` is held to the closing `>`'s line, for the
				// reason the `<` is held to the Choice's: a construction is
				// written on one line. Without it the applied form escaped the
				// adjacency the bare one is held to — `Box#Full` reaches this
				// parse only when the `#` sits directly against the name, so that
				// a `label #Case` Argument stays readable, and an application in
				// between must not be the way around it.
				if (
					hashToken?.type === TokenType.SymbolHash &&
					hashToken.position.start.line !==
						argumentList.position.end.line
				) {
					throw new ParseError(
						"A Case is applied on the line its Type Arguments close on",
						hashToken.position,
						"this '#' is on a line of its own",
						{
							code: "case-application-across-lines",
							notes: [
								"The bare form is held to the same rule: 'Box#Full' is one construction only where the '#' sits against the name.",
							],
							helps: [
								"Write the '#' and its Case on the line the '>' closes on.",
							],
						},
					)
				}

				typeArguments = argumentList.typeArguments
			}

			hash = this.tokens.expect(TokenType.SymbolHash)
		}

		let caseName = this.parseIdentifier()
		let value: parser.ExpressionNode | null = null
		let end = caseName.position.end

		if (this.tokens.peek()?.type === TokenType.SymbolLeftParen) {
			let leftParen = this.tokens.next()

			if (this.tokens.peek()?.type !== TokenType.SymbolRightParen) {
				value = this.parseExpression()
			}

			// A coded refusal rather than the generic one, because this
			// reading is SPECULATIVE where the Case carries Type Arguments —
			// only the `#` past the `>` tells `Optional<Integer>#Value(…)` from
			// a comparison chain — and `speculate` gives a `syntax-error` back
			// and rewinds. The rewound reading then re-read the Choice as a call
			// receiver and refused the `#` instead, which named the wrong
			// character on the wrong line. A code the rewind does not swallow is
			// what keeps the refusal where the mistake is.
			//
			// And it is a refusal rather than an allowance because a Case
			// payload is ONE value: every construct that takes a trailing comma
			// is a LIST, and a separator with nothing to separate would read as
			// though a second value could follow. Several values are carried as
			// one Record.
			let comma = this.tokens.peek()

			if (comma?.type === TokenType.SymbolComma) {
				// Two shapes arrive at this one refusal and they want
				// different edits. A comma with the `)` behind it is a
				// separator with nothing to separate, and dropping it is the
				// whole fix. A comma with another value behind it is a SECOND
				// payload, and dropping it would leave two values written flush
				// against each other — so only that one is answered with the
				// Record, spelled with the Case the reader wrote. Both used to
				// be told to drop the comma AND to write `#Rectangle`, which is
				// a Case nothing in the file declares.
				let trailing =
					this.tokens.peek(1)?.type === TokenType.SymbolRightParen

				throw new ParseError(
					"A Case carries one value",
					comma.position,
					trailing
						? "nothing follows this ','"
						: "a second value follows this ','",
					{
						code: "case-payload-is-one-value",
						notes: [
							"The parentheses of a Case hold the single value it carries, not a list.",
						],
						helps: trailing
							? ["Drop the ','."]
							: [
									`Carry the values as one Record: '#${caseName.content}({ … })', with a member for each of them.`,
								],
					},
				)
			}

			end = this.tokens.expectClosing(
				TokenType.SymbolRightParen,
				leftParen,
			).position.end
		}

		return generators.caseValueNode(
			choice,
			typeArguments,
			caseName,
			value,
			{
				start: choice?.position.start ?? hash.position.start,
				end,
			},
		)
	}

	protected parseMatch(): parser.MatchNode {
		let keyword = this.tokens.expect(TokenType.KeywordMatch)
		let value = this.parseExpression()
		let returnType = this.parseReturnType()

		let leftBrace = this.tokens.expect(TokenType.SymbolLeftBrace)

		let handlers = this.parseStatementList(() => {
			this.tokens.expect(TokenType.KeywordCase)

			let matcher = this.parseMatcher()
			let guard = this.parseOptionalGuard()
			let block = this.parseBlock()

			return { matcher, guard, body: block.body }
		})

		let closingPosition = this.parseClosingBrace(leftBrace.position)

		return generators.match(value, returnType, handlers, {
			start: keyword.position.start,
			end: closingPosition.end,
		})
	}

	// `define { as VALUE if CONDITION … as VALUE otherwise }`. The arms
	// are told apart by their `as` and by nothing else, not by the lines they
	// stand on, and that is enough because an Expression ends at the first
	// Token that can not carry it on. Neither `if` nor `otherwise` is one of
	// the three that can, so `as 0 if x::isZero()` and `as 10 otherwise` each
	// read to their end without a lookahead.
	//
	// Which is also what lets `otherwise` be a name — it is on
	// `identifierTokenTypes` — without the two readings ever meeting. An arm's
	// value stops at the word whatever the word is, so `as otherwise otherwise`
	// answers with the value called `otherwise` and ends where the loop reads
	// the terminator, and `as otherwise if flag` is that same value under a
	// Condition. The arm loop decides by the Token it finds AFTER the value,
	// and a name in value position is never that Token.
	//
	// The arrow is optional, and a `define` that writes none leaves its
	// answer Type to its arms.
	protected parseDefine(): parser.DefineNode {
		let keyword = this.tokens.expect(TokenType.KeywordDefine)
		let returnType = this.parseOptionalReturnType(true)

		this.enterNesting()

		try {
			let leftBrace = this.tokens.expect(TokenType.SymbolLeftBrace)
			let { arms, otherwise, recovered } = this.parseDefineArms()
			// Read BEFORE the brace is taken, because a `define` whose
			// block the input ended inside of is one whose arms were not read to
			// their end either — and that is the difference between "there is no
			// `otherwise` arm" and "this Parser never got to where one would
			// stand". `parseClosingBrace` answers with a Position either way, so
			// the question has to be asked of the Token.
			let closed = this.tokens.peek()?.type === TokenType.SymbolRightBrace
			let closingPosition = this.parseClosingBrace(leftBrace.position)
			let position = {
				start: keyword.position.start,
				end: closingPosition.end,
			}

			// A totality refusal is only worth making when the arms were
			// read CLEANLY. An arm loop that recovered skipped text on its way to
			// the next `as`, and an `otherwise` arm standing in what it skipped is
			// an arm that was written — so its absence proves nothing, and saying
			// "every value here has a condition on it" of a block that visibly
			// ends in `otherwise` is a refusal for a mistake nobody made. The same
			// holds for a block the input ended inside of, and for a `define`
			// nested past the depth budget, whose `nesting-too-deep` is recovered
			// from like any other broken arm.
			//
			// The `define` still can not be built — there is no arm to answer
			// with — so the Statement it stands in is dropped, as a broken
			// Statement always is. What went wrong has been reported already, by
			// the loop that recovered from it, and the throw says so rather than
			// adding a second account of one mistake.
			if (otherwise === null && (recovered || !closed)) {
				throw new ParseError(
					"This 'define' could not be read to its end",
					position,
					null,
					{ reported: true },
				)
			}

			// Refused here rather than represented as an absent arm: a
			// `define` answers with a value wherever it stands, and one whose
			// every value has a Condition on it has nothing to answer with when
			// they all decline. The Node has no shape for that, which is what
			// makes every `define` downstream total by construction.
			//
			// Coded, which is what makes the refusal SURVIVE a
			// speculation — `refusesTheText` reads the code, and the generic
			// `syntax-error` this used to carry is one of the two a speculation
			// gives back. A `define` missing its `otherwise` arm is a verdict
			// about text that was written: no other reading of those braces is
			// going to find the arm that is not there. `{ found = define { as 1
			// if flag } }` used to be answered with "Expected 'with' but found
			// '='", which is the Dictionary reading behind the Record one
			// speaking for text the Record reading had already judged.
			//
			// An EMPTY block is the same refusal about different text, so
			// it is told apart in the label and in the help rather than given a
			// code of its own. "Every value here has a condition on it" is a
			// remark about the values that were written, and a `define { }`
			// wrote none — it is short of every arm, not of the last one.
			if (otherwise === null) {
				let empty = arms.length === 0

				throw new ParseError(
					"This 'define' has no 'otherwise' arm",
					position,
					empty
						? "there are no arms here at all"
						: "every value here has a condition on it",
					{
						code: "define-without-otherwise",
						notes: [
							"A 'define' answers with a value wherever it stands, so one of its arms has to be the one that always holds.",
						],
						helps: [
							empty
								? "Write an arm: 'as <value> otherwise'."
								: "Write the last arm as 'as <value> otherwise'.",
						],
					},
				)
			}

			return generators.define(returnType, arms, otherwise, position)
		} finally {
			this.nestingDepth--
		}
	}

	// Its own loop rather than `parseStatementList`, because the
	// resynchronisation that one does scans for a Statement start and an `as`
	// is not one — a broken arm would swallow every arm below it, and a
	// `define` that lost its `otherwise` that way would be refused for a
	// mistake nobody made. So a broken arm is skipped up to the next `as` at
	// this `define`'s own brace depth, and the arms below it are read.
	protected parseDefineArms(): {
		arms: Array<parser.DefineArmNode>
		otherwise: parser.DefineOtherwiseNode | null
		recovered: boolean
	} {
		let arms: Array<parser.DefineArmNode> = []
		let otherwise: parser.DefineOtherwiseNode | null = null
		// Whether any arm was recovered from, which is what says how much
		// the arms below it are worth as evidence — see `parseDefine`.
		let recovered = false

		while (true) {
			let token = this.tokens.peek()

			if (
				token === undefined ||
				token.type === TokenType.SymbolRightBrace
			) {
				break
			}

			let startState = this.tokens.save()

			// Per arm, for the reason `parseStatementList` does it per
			// element — an arm that was read is a group of readings resolving.
			this.forgetFailuresFrom(this.speculationDepth)

			try {
				let keyword = this.tokens.expect(TokenType.KeywordAs)

				// Whether this arm stands below the `otherwise` one, which
				// is decided before it is read and answered for once it has
				// been — see `reportUnreachableArm`. Never RECORDING it is what
				// keeps the Node's "the `otherwise` arm is last" invariant.
				let unreachable = otherwise !== null
				let value = this.parseExpression()
				let follower = this.peekOrFail("'if' or 'otherwise'")

				if (follower.type === TokenType.KeywordOtherwise) {
					this.tokens.next()

					let position = {
						start: keyword.position.start,
						end: follower.position.end,
					}

					if (unreachable) {
						this.reportUnreachableArm(position)
					} else {
						otherwise = { value, position }
					}
				} else if (follower.type === TokenType.KeywordIf) {
					this.tokens.next()

					let condition = this.parseExpression()
					let position = {
						start: keyword.position.start,
						end: condition.position.end,
					}

					if (unreachable) {
						this.reportUnreachableArm(position)
					} else {
						arms.push({ value, condition, position })
					}
				} else {
					fail(
						`Expected 'if' or 'otherwise' but found ${describeToken(follower)}.`,
						follower.position,
						"expected 'if' or 'otherwise'",
					)
				}
			} catch (error) {
				// A CODED refusal is a verdict about the text and not a
				// reading that failed — see `refusesTheText` — so it is raised
				// to the Statement loop that reports such things, exactly as a
				// speculation raises one, rather than being reported here and
				// recovered from as a broken arm.
				if (error instanceof ParseError && refusesTheText(error)) {
					throw error
				}

				this.recoverFromDefineArm(error, startState)
				recovered = true
			}
		}

		return { arms, otherwise, recovered }
	}

	// Reported and DROPPED rather than thrown, which is the one refusal
	// the arm loop answers for itself. The arm reads perfectly well — what is
	// wrong with it is where it stands — so the text below it is still text this
	// Parser can read, and a thrown refusal would take the whole Statement the
	// `define` stands in with it: every use of the Constant it declares then
	// names nothing, which is a great many Diagnostics for one misplaced arm.
	//
	// Reported once the arm has been READ, so the span is the whole arm
	// rather than the `as` that opens it. That is what the reader has to move or
	// delete, and it is the only record of the arm's extent there is: an
	// unreachable arm is never put on the Node, so nothing downstream — an
	// Editor's Quick Fix above all — could work out where it ends. An arm that
	// broke while being read reports what broke instead, which is the more
	// pressing of the two things wrong with it.
	protected reportUnreachableArm(position: common.Position): void {
		this.reportParseError(
			new ParseError(
				"This arm stands below the 'otherwise' arm",
				position,
				"nothing here can ever be reached",
				{
					code: "unreachable-define-arm",
					notes: [
						"The 'otherwise' arm is the one that always holds, so a 'define' answers there whenever it gets that far.",
					],
					helps: [
						"Move this arm above the 'otherwise' arm, or delete it.",
					],
				},
			),
		)
	}

	protected recoverFromDefineArm(
		error: unknown,
		startState: TokenStreamState,
	): void {
		this.reportParseError(error)

		// Only an arm that READ something has leftovers to skip. One that
		// failed on its very first Token — a `{` where an `as` belongs — read
		// nothing, so there is nothing between here and the next arm, and
		// scanning for one would step INTO whatever that Token opens and skip
		// every arm below it, the `define`'s own `}`, and the block it stands
		// in. Dropping the one Token is the whole of the recovery there, and it
		// is what the progress guarantee below does anyway.
		if (this.tokens.save().index !== startState.index) {
			this.resynchroniseToArm(startState.braceDepth)
		}

		// Guarantee progress, for the reason `recoverFromError` does —
		// an arm that consumed no Token and resynchronised to where it started
		// would be read again forever.
		if (
			this.tokens.save().index === startState.index &&
			!this.tokens.isAtEnd()
		) {
			this.tokens.next()
		}

		// An arm is text the Parser abandoned exactly as a Statement is,
		// and it costs the stages behind it the same thing: a `define` that lost
		// an arm was not written without cases. It declares nothing, so the
		// lines are the whole of what this leaves behind.
		this.recordAbandoned(startState.index)
	}

	// Skips to the next arm's `as`, or to the `}` that closes the
	// `define`, at the brace depth the broken arm started on — braces the
	// broken arm opened itself are skipped over entirely, as they are for a
	// Statement.
	protected resynchroniseToArm(targetDepth: number): void {
		while (true) {
			let token = this.tokens.peek()

			if (token === undefined) {
				// Every further error would be a cascade of the one just
				// reported, as it is for a Statement that ran into the end of
				// the input.
				this.suppressDiagnostics = true

				return
			}

			if (
				this.tokens.depth <= targetDepth &&
				(token.type === TokenType.SymbolRightBrace ||
					token.type === TokenType.KeywordAs)
			) {
				return
			}

			this.tokens.next()
		}
	}

	// `_` is a wildcard only here — everywhere else it marks a labelless
	// Parameter — so it is recognised in Matcher position rather than in
	// `parseType`, where it would make `_` look like a Type name.
	//
	// `allowsWholeValueBinder` is false in a Match Handler, where `@` is the
	// scrutinee narrowed to the Matcher and a `} as name` would be a second
	// name for it. An assertion has no `@`, and its subject is often a computed
	// value with no name at all — `require { name } as row = rows::item(at 1)`
	// — so there the binder is the only way to hold onto the whole of what was
	// taken apart.
	protected parseMatcher(allowsWholeValueBinder = false): parser.MatcherNode {
		let token = this.tokens.peek()

		if (token?.type === TokenType.SymbolUnderscore) {
			this.tokens.next()

			return generators.wildcardMatcher(token.position)
		}

		if (token !== undefined && literalMatcherTokenTypes.has(token.type)) {
			let value = this.parseLiteralMatcherValue()

			return generators.literalMatcher(value, value.position)
		}

		// A Record in Matcher position is always a Pattern rather than a
		// Record Type, because only the Pattern form admits `name = value`
		// members alongside `name: Type` ones — and a bare `name`, which binds.
		//
		// No whole-value binder here: `@` is the scrutinee narrowed to this
		// Matcher, so `} as name` would be a second name for what already has
		// one.
		if (token?.type === TokenType.SymbolLeftBrace) {
			return this.parsePattern(allowsWholeValueBinder)
		}

		// `case #Add` — the bare form resolves against the matched
		// value's own Union; `case CalculatorOperation#Add` is the prefixed
		// form for when that is ambiguous. Either may carry a payload binder,
		// `case #Value(item)`, parsed by `parseCaseMatcherBinding` below.
		if (token?.type === TokenType.SymbolHash) {
			this.tokens.next()

			let caseName = this.parseIdentifier()
			let binding = this.parseCaseMatcherBinding()

			return generators.caseMatcher(
				null,
				caseName,
				binding?.node ?? null,
				{
					start: token.position.start,
					end: binding?.end ?? caseName.position.end,
				},
			)
		}

		if (
			isIdentifierToken(token) &&
			this.tokens.peek(1)?.type === TokenType.SymbolHash
		) {
			let choice = this.parseIdentifier()

			this.tokens.expect(TokenType.SymbolHash)

			let caseName = this.parseIdentifier()
			let binding = this.parseCaseMatcherBinding()

			return generators.caseMatcher(
				choice,
				caseName,
				binding?.node ?? null,
				{
					start: choice.position.start,
					end: binding?.end ?? caseName.position.end,
				},
			)
		}

		return this.parseType()
	}

	// The payload binder of a Case Matcher — `case #Value(item)`. It names
	// what the CONSTRUCTOR takes, so the parens hold either one name or a
	// Pattern that takes apart what the constructor was handed:
	// `case #Rectangle({ width, height })`.
	//
	// Braces after the Case name are NOT a second spelling of this. After a
	// Matcher a `{` opens the arm's own block, and `{ left = 0 }` IS a block —
	// one holding a variable assignment. So `case #Add { left = 0 }` has two
	// readings that are both valid Programs, and no lookahead settles which was
	// written. The parens have no such problem, which is why the payload Pattern
	// lives in them.
	//
	// A Case Matcher is the only Matcher that takes a binder. `@` already
	// answers for every Matcher kind — the scrutinee, narrowed — so this adds a
	// second name rather than redefining the one that exists. That is also why a
	// Pattern in Matcher position carries no whole-value binder of its own,
	// while one in a payload does: what the constructor took is not `@`.
	protected parseCaseMatcherBinding(): {
		node: parser.IdentifierNode | parser.PatternNode
		// Where the binder ends, which is the closing paren rather than
		// the name inside it. A Matcher's span is what a failed assertion draws
		// its underline from, and one that stopped at the name left the `)`
		// standing bare beyond it.
		end: common.Cursor
	} | null {
		if (this.tokens.peek()?.type !== TokenType.SymbolLeftParen) {
			return null
		}

		let leftParen = this.tokens.expect(TokenType.SymbolLeftParen)

		let binding =
			this.tokens.peek()?.type === TokenType.SymbolLeftBrace
				? this.parsePattern()
				: this.parseIdentifier()

		let closing = this.tokens.expectClosing(
			TokenType.SymbolRightParen,
			leftParen,
		)

		return { node: binding, end: closing.position.end }
	}

	// A Pattern names the parts of a value, in every position that takes
	// one apart: a Matcher, a Case payload, a Parameter and a Declaration.
	// `allowsBinder` is false only at the top level of a Matcher, where `@`
	// already names the whole value.
	protected parsePattern(allowsBinder = true): parser.PatternNode {
		let leftBrace = this.tokens.expect(TokenType.SymbolLeftBrace)

		let members: Array<[string, parser.PatternMemberNode]> = []

		if (this.tokens.peek()?.type !== TokenType.SymbolRightBrace) {
			members.push(this.parsePatternMember())

			while (this.tokens.peek()?.type === TokenType.SymbolComma) {
				this.tokens.next()

				if (this.tokens.peek()?.type === TokenType.SymbolRightBrace) {
					break
				}

				this.refuseListContinuation(
					TokenType.SymbolRightBrace,
					leftBrace,
				)

				members.push(this.parsePatternMember())
			}
		}

		let rightBrace = this.tokens.expectClosing(
			TokenType.SymbolRightBrace,
			leftBrace,
		)

		this.reportDuplicateNames(
			members.map(([, member]) => member),
			"Member",
			"duplicate-member",
		)

		let binder = this.parseWholeValueBinder(allowsBinder)

		return generators.pattern(Object.fromEntries(members), binder, {
			start: leftBrace.position.start,
			end: (binder ?? rightBrace).position.end,
		})
	}

	// `name` binds the member under its own name; `name: Type` binds it
	// and constrains the Type as well; `name = value` constrains the value and
	// binds nothing, because the value is written right there. The bare form is
	// the annotated one with its Type elided, which is the same relation
	// `(item)` has to `(_ item: Type)`.
	protected parsePatternMember(): [string, parser.PatternMemberNode] {
		let name = this.parseIdentifier()

		if (this.tokens.peek()?.type === TokenType.SymbolEqual) {
			this.tokens.next()

			let value = this.parseLiteralMatcherValue()

			return [
				name.content,
				generators.patternValueMember(name, value, {
					start: name.position.start,
					end: value.position.end,
				}),
			]
		}

		let type: parser.TypeDeclarationNode | null = null

		if (this.tokens.peek()?.type === TokenType.SymbolColon) {
			this.tokens.next()

			type = this.parseType()
		}

		let binder = this.parseMemberBinder()

		return [
			name.content,
			generators.patternTypeMember(name, type, binder, {
				start: name.position.start,
				end: (binder ?? type ?? name).position.end,
			}),
		]
	}

	// `as` binds a member under another name, or takes it apart further —
	// a binder is a name or another Pattern, which is the whole of nesting.
	//
	// `as` is an ordinary Identifier everywhere it is not a Keyword (the Module
	// grammar says the same about its own use of it), so a member may be CALLED
	// `as`. Two Tokens settle it: an `as` is the binder only when a name or a
	// `{` follows. `{ as }` binds a member called `as`; `{ as as as }` binds
	// that member under that name; `{ as as }` ends the member at the first
	// `as` and reports the stray one.
	protected parseMemberBinder(): parser.PatternBinderNode | null {
		if (!this.binderFollows()) {
			return null
		}

		this.tokens.expect(TokenType.KeywordAs)

		if (this.tokens.peek()?.type === TokenType.SymbolLeftBrace) {
			return this.parsePattern()
		}

		return this.parseIdentifier()
	}

	// `} as name` — one name for the whole value, alongside the names its
	// members bind. Never a nested Pattern: the Pattern that would take it apart
	// is the one this is written on.
	protected parseWholeValueBinder(
		allowsBinder: boolean,
	): parser.IdentifierNode | null {
		if (
			this.tokens.peek()?.type !== TokenType.KeywordAs ||
			!isIdentifierToken(this.tokens.peek(1))
		) {
			return null
		}

		let keyword = this.tokens.next()
		let name = this.parseIdentifier()

		if (allowsBinder) {
			return name
		}

		// Reported and then dropped, rather than failed on, so that one
		// redundant binder does not cascade into a parse failure for the arm.
		let position = { start: keyword.position.start, end: name.position.end }

		reportError(
			"A Matcher's Pattern can not name the whole value",
			position,
			{
				code: "redundant-pattern-binder",
				labels: [primary(position, "'@' already names it")],
				notes: [
					"Inside an arm, '@' is the scrutinee narrowed to what the Matcher established — which is exactly what this would name a second time.",
				],
				// BOTH edits, because the binder is what is refused and
				// rewriting the body alone leaves it standing. The Quick Fix has
				// always made the pair of edits; the Help named only one.
				helps: [
					`Drop the 'as ${name.content}' and write '@' where '${name.content}' was meant.`,
				],
			},
		)

		// Recorded as ABANDONED, which is what it is: the binder was
		// written, it was refused, and the body below goes on reading the name
		// it would have bound. Without this the arm reported a second time —
		// `unknown-name '<name>'`, once per read — for a name the reader DID
		// declare, which is this mistake said again in words about a different
		// one. `declarationWasAbandoned` is the question every "no such name"
		// report already asks.
		//
		// The binder is written BEFORE the arm's own `{`, so the block
		// that claims it is the MATCH block rather than the arm. That is wider
		// than the binder ever was: a read of the same name in a SIBLING arm is
		// silenced too. It is deliberate — the alternative is teaching the claim
		// about a block that has not been opened yet — and the cost is one arm's
		// worth of over-silence inside one Match Expression, not the file.
		this.recordAbandonedDeclaration(name.content, name.position, false)

		return null
	}

	// Whether the `as` at the cursor opens a binder rather than being a
	// name in its own right. Two Tokens, no backtracking.
	protected binderFollows(): boolean {
		if (this.tokens.peek()?.type !== TokenType.KeywordAs) {
			return false
		}

		let next = this.tokens.peek(1)

		return (
			isIdentifierToken(next) || next?.type === TokenType.SymbolLeftBrace
		)
	}

	// A Matcher compares against a written literal and nothing else —
	// `size = expected` does not read the Constant `expected`, because a
	// Matcher is a pattern rather than an Expression. Anything else after `=`
	// is a parse error here rather than something quietly stood in for.
	protected parseLiteralMatcherValue(): parser.LiteralMatcherValueNode {
		let token = this.peekOrFail()

		switch (token.type) {
			case TokenType.SymbolDash:
			case TokenType.LiteralNumber:
				return this.parseNumberLiteral()
			case TokenType.LiteralString:
				this.tokens.next()
				return generators.stringValueNode(token.value, token.position)
			case TokenType.LiteralTrue:
				this.tokens.next()
				return generators.booleanValueNode(true, token.position)
			case TokenType.LiteralFalse:
				this.tokens.next()
				return generators.booleanValueNode(false, token.position)
			// An interpolated String is not a compile-time literal — its
			// holes are evaluated — so it can never be the fixed value a `case`
			// compares against. Refused with its own message rather than the
			// generic one, since "found an interpolated String" alone does not
			// say why a String would be turned away here.
			case TokenType.LiteralStringStart:
				fail(
					"An interpolated String can not be matched against — a Matcher compares one written literal, and a hole is evaluated.",
					token.position,
					"write a plain String Literal here",
				)
			default:
				fail(
					`Expected a literal value but found ${describeToken(token)}.`,
					token.position,
					"expected a Number, a String or a Boolean",
				)
		}
	}

	// `where` is not a Keyword — it is an ordinary Identifier used as an
	// Argument label elsewhere (`removeEvery(where …)`), so it is recognised
	// by content. That is unambiguous here because a Matcher is otherwise
	// always followed by the Handler's opening brace.
	protected parseOptionalGuard(): parser.ExpressionNode | null {
		let token = this.tokens.peek()

		if (
			token !== undefined &&
			token.type === TokenType.Identifier &&
			token.value === "where"
		) {
			this.tokens.next()

			return this.parseExpression()
		}

		return null
	}

	// #endregion

	// #region Literals

	protected parseTypedRecordLiteral(): parser.RecordValueNode {
		let type = this.parseType()

		this.tokens.expect(TokenType.SymbolTilde)
		this.tokens.expect(TokenType.SymbolRightAngle)

		let record = this.parseAnonymousRecordLiteral()

		return generators.recordValueNode(type, record.members, {
			start: type.position.start,
			end: record.position.end,
		})
	}

	protected parseAnonymousRecordLiteral(): parser.RecordValueNode {
		let leftBrace = this.tokens.expect(TokenType.SymbolLeftBrace)

		if (this.tokens.peek()?.type === TokenType.SymbolRightBrace) {
			let rightBrace = this.tokens.next()

			return generators.recordValueNode(
				null,
				{},
				{
					start: leftBrace.position.start,
					end: rightBrace.position.end,
				},
			)
		}

		let keyValuePairList = this.parseKeyValuePairList(true, leftBrace)
		let rightBrace = this.tokens.expectClosing(
			TokenType.SymbolRightBrace,
			leftBrace,
		)

		return generators.recordValueNode(null, keyValuePairList.data, {
			start: leftBrace.position.start,
			end: rightBrace.position.end,
		})
	}

	protected parseRecordLiteralOrCombination():
		| parser.RecordValueNode
		| parser.CombinationNode {
		let leftBrace = this.tokens.expect(TokenType.SymbolLeftBrace)

		if (this.tokens.peek()?.type === TokenType.SymbolRightBrace) {
			let rightBrace = this.tokens.next()

			return generators.recordValueNode(
				null,
				{},
				{
					start: leftBrace.position.start,
					end: rightBrace.position.end,
				},
			)
		}

		let record = this.backtrack(() => {
			let keyValuePairList = this.parseKeyValuePairList(true, leftBrace)
			let rightBrace = this.tokens.expectClosing(
				TokenType.SymbolRightBrace,
				leftBrace,
			)

			return generators.recordValueNode(null, keyValuePairList.data, {
				start: leftBrace.position.start,
				end: rightBrace.position.end,
			})
		})

		if (record !== null) {
			return record
		}

		let lhs = this.parseExpression()

		// `{ "a" = 1 }` — a Dictionary written in a Record's braces. Only
		// a WRITTEN VALUE is refused here, and never a name: `{ x = ] }` also
		// reaches this line, because a member whose value does not parse throws
		// the whole Record reading away, and `x` there is a member name whose
		// value is broken rather than a key that is a value. What a value key
		// spells is a Dictionary and nothing else, so it is reported here,
		// where what was written is still in hand, rather than as "expected
		// 'with'" about a Token nobody meant.
		if (
			this.tokens.peek()?.type === TokenType.SymbolEqual &&
			writesAValueKey(lhs)
		) {
			throw new ParseError(
				"A key that is a value belongs to a Dictionary",
				lhs.position,
				"this key is a value, not a member name",
				{
					code: "syntax-error",
					notes: [
						"Braces write a Record, whose keys are the member names it declares. A key that is a value is a Dictionary's, and a Dictionary is written in brackets.",
					],
					helps: [
						"Write it in brackets: '[\"a\" = 1]'.",
						"Or name the member, if a Record is what was meant: '{ a = 1 }'.",
					],
				},
			)
		}

		this.tokens.expect(TokenType.KeywordWith)

		let combinationOfKeys = (allowShorthand: boolean) =>
			this.backtrack(() => {
				// The value being updated, spelled, for the key readers
				// below — a descend that updates nothing is answered by naming
				// it, and the key list is several readers deep from here. Saved
				// and put back, because an update nests inside an update.
				let outer = this.updatedValue
				this.updatedValue = writtenReceiver(lhs)

				try {
					let keyValuePairList = this.parseKeyValuePairList(
						allowShorthand,
						leftBrace,
					)
					let rightBrace = this.tokens.expectClosing(
						TokenType.SymbolRightBrace,
						leftBrace,
					)

					return generators.combination(
						lhs,
						generators.recordValueNode(
							null,
							keyValuePairList.data,
							keyValuePairList.position,
						),
						{
							start: leftBrace.position.start,
							end: rightBrace.position.end,
						},
						{ bare: true },
					)
				} finally {
					this.updatedValue = outer
				}
			})

		let keyValuePairCombination = combinationOfKeys(false)

		if (keyValuePairCombination !== null) {
			return keyValuePairCombination
		}

		// The Expression reading is speculated too, so the key list can
		// be read ONE more time below when it fails. Order is what keeps
		// `{ base with other }` meaning what it has always meant — a whole
		// value merged in — because a bare name reads as an Expression here
		// before it is ever offered the shorthand.
		let expressionCombination = this.backtrack(() => {
			let rhs = this.parseExpression()
			let rightBrace = this.tokens.expectClosing(
				TokenType.SymbolRightBrace,
				leftBrace,
			)

			return generators.combination(lhs, rhs, {
				start: leftBrace.position.start,
				end: rightBrace.position.end,
			})
		})

		if (expressionCombination !== null) {
			return expressionCombination
		}

		// Neither reading spans this. `{ base with port, host }` is the
		// shape that lands here, and left alone it reports
		// `Expected '}' but found ','` — a message about the comma rather than
		// about the rule the author was tripped by. Reading the key list once
		// more WITH shorthand says which rule that is; it costs nothing a user
		// can measure, since it runs only where two readings have already been
		// thrown away.
		let shorthandCombination = combinationOfKeys(true)

		if (shorthandCombination !== null) {
			this.reportShorthandInCombination(shorthandCombination)

			return shorthandCombination
		}

		let rhs = this.parseExpression()

		// `{ ages with "alex" = 40 }` — a Dictionary update written in a
		// Record's braces, which is the same mistake the head of a braced
		// literal catches one Token earlier and it is caught by the same test:
		// a key that is a WRITTEN VALUE with an `=` behind it spells a
		// Dictionary and nothing else. Left alone this reports
		// `Expected '}' but found '='` about a Token nobody meant, which is
		// exactly what the check above exists to prevent — it just never ran
		// here, because the `with` had already been read past.
		//
		// It is reported after the three readings have been thrown away rather
		// than before them, so a Record update still reads as one: `port` is a
		// member name and no value, and `{ base with other }` is an Expression
		// the first two readings claim.
		if (
			this.tokens.peek()?.type === TokenType.SymbolEqual &&
			writesAValueKey(rhs)
		) {
			throw new ParseError(
				"A key that is a value belongs to a Dictionary",
				rhs.position,
				"this key is a value, not a member name",
				{
					code: "wrong-update-brackets",
					notes: [
						"Braces update a Record, whose keys are the member names it declares. A key that is a value is a Dictionary's, and a Dictionary is updated in brackets.",
					],
					helps: [
						"Write the update in brackets: '[base with \"a\" = 1]'.",
						"Or name the member, if a Record is what was meant: '{ base with a = 1 }'.",
					],
				},
			)
		}

		let rightBrace = this.tokens.expectClosing(
			TokenType.SymbolRightBrace,
			leftBrace,
		)

		return generators.combination(lhs, rhs, {
			start: leftBrace.position.start,
			end: rightBrace.position.end,
		})
	}

	// One Diagnostic per bare name, on a Combination the third reading
	// recovered. The recovered key list is kept — it is what the author meant,
	// and the Language Server goes on offering completions and colour inside a
	// file the Compiler has already refused.
	protected reportShorthandInCombination(
		combination: parser.CombinationNode,
	): void {
		if (
			this.suppressDiagnostics ||
			combination.rhs.nodeType !== "RecordValue"
		) {
			return
		}

		// EVERY bare key, gathered before the first report is written.
		// One Diagnostic is raised per name, but the Record each of them offers
		// to merge has to hold them all: `{ config with port, host }` answered
		// the `port` report with `'{ base with { port } }'`, and a reader who
		// followed it dropped `host` on the floor without being told.
		let bare = Object.values(combination.rhs.members).filter(
			(member) => member.shorthand === true && member.steps === undefined,
		)
		let base = writtenReceiver(combination.lhs) ?? "…"
		let merged = `'{ ${base} with { ${bare.map((member) => member.name.content).join(", ")} } }'`

		for (let member of bare) {
			// A bare PATH key was already refused as it was read, with
			// the message that explains why no reading rescues it — there is
			// no `a.b = a.b` for it to have meant.
			let name = member.name.content

			reportError(
				"A bare member name is not a key in an update",
				member.name.position,
				{
					code: "shorthand-in-combination",
					labels: [
						primary(
							member.name.position,
							"this names no value to set",
						),
					],
					notes: [
						"An update's key list always spells its values, because a bare name after 'with' is already the value being merged in.",
					],
					helps: [
						`Write '${name} = ${name}'.`,
						`Or merge a whole Record: ${merged}.`,
					],
				},
			)
		}
	}

	// `allowShorthand` is a property of the BRACES, not of the member —
	// a Record literal's member list takes `{ x }` for `{ x = x }`, and a
	// Combination's key list does not, because a bare name after `with` is
	// already the whole value being merged in. The one flag is what keeps
	// `{ base with other }` from silently turning into "set member `other`".
	//
	// A Dictionary's key list has no shorthand at all, in a literal or in
	// an update — `["a" = 1]` writes a key that is a VALUE, and a bare name
	// there is that value and not short for anything. See
	// `parseDictionaryUpdate`.
	// `opening` is the `{` this list stands in, carried down so that a
	// member the reader never began is answered with the bracket the braces are
	// short of — see `refuseListContinuation`.
	protected parseKeyValuePairList(
		allowShorthand: boolean,
		opening: Token,
	): ReturnType<typeof generators.buildKeyValuePairList> {
		let pairs = [this.parseKeyValuePair(allowShorthand)]

		while (this.tokens.peek()?.type === TokenType.SymbolComma) {
			this.tokens.next()

			if (this.tokens.peek()?.type === TokenType.SymbolRightBrace) {
				break
			}

			this.refuseListContinuation(TokenType.SymbolRightBrace, opening)

			pairs.push(this.parseKeyValuePair(allowShorthand))
		}

		this.reportClashingMemberKeys(pairs)

		return generators.buildKeyValuePairList(
			pairs.slice(0, -1),
			pairs[pairs.length - 1],
		)
	}

	protected parseKeyValuePair(
		allowShorthand: boolean,
	): ReturnType<typeof generators.keyValuePair> {
		let name = this.parseIdentifier()
		let path = this.parseKeyPath(name)

		if (path !== null) {
			if (path.group !== null) {
				return generators.keyGroupPair(
					name,
					path.group,
					{
						start: name.position.start,
						end: path.group.position.end,
					},
					path.steps,
				)
			}

			return this.parsePathKeyValue(name, path.steps, allowShorthand)
		}

		// `{ x: 0 }` — a member written with the separator every other
		// language writes an object's with. Refused HERE, where the name and the
		// `:` are both in hand, rather than left to the readings above: the
		// shorthand below would claim `x` as a member of its own and the reading
		// would fall apart one Token later, on a `}` that is nowhere near the
		// mistake.
		//
		// A `:` in braces is Essence in two other places, and neither
		// reaches this: a Record TYPE (`{ x: Integer }`) is read by
		// `parseRecordType`, and a Pattern's Type annotation (`{ x: Integer }` in
		// `constant { x: Integer } = point`) by `parsePatternMember`. This is the
		// key list of a Record LITERAL, where a `:` spells nothing at all.
		let colon = this.tokens.peek()

		if (colon?.type === TokenType.SymbolColon) {
			// The span a fix writes over runs from the name to the value,
			// and what it writes is ' = ' — a `:` is written flush against its
			// name and an `=` is written with a blank either side, so rewriting
			// the Token alone would leave `{ x= 0 }` for the Formatter to tidy.
			// Only where the value stands on the same line: a span across a line
			// break would pull the two together.
			let value = this.tokens.peek(1)
			let rewritten =
				value !== undefined &&
				value.position.start.line === colon.position.start.line
					? {
							position: {
								start: name.position.end,
								end: value.position.start,
							},
							spelling: " = ",
						}
					: { position: colon.position, spelling: "=" }

			throw new ParseError(
				"A Record member is written with '='",
				colon.position,
				"Essence writes '=' here",
				{
					code: "foreign-syntax",
					notes: [
						"A ':' in braces annotates a Type instead — '{ x: Integer }' is the Record Type whose member 'x' is an Integer.",
					],
					helps: [`Write '${name.content} = …'.`],
					data: { kind: "essence-spelling", ...rewritten },
				},
			)
		}

		// The value is a Node of its own at the name's Position rather
		// than the name Node itself — two Declarations at one Position is
		// exactly what the shorthand is, and the rename index is built to
		// carry both.
		if (
			allowShorthand &&
			this.tokens.peek()?.type !== TokenType.SymbolEqual
		) {
			return generators.keyValuePair(
				name,
				generators.identifier(name.content, name.position),
				name.position,
				true,
			)
		}

		this.tokens.expect(TokenType.SymbolEqual)

		let value = this.parseExpression()

		return generators.keyValuePair(name, value, {
			start: name.position.start,
			end: value.position.end,
		})
	}

	// The steps after a key's first Identifier, or null where the key is
	// a plain name — which is what tells the two apart everywhere below. Every
	// key position reads a path, a plain Record Literal's included: this is
	// the one key list the Parser has, read for a Record Literal, for the
	// members of a `with` and for a default alike, so it can not tell from
	// here which of them it is inside of. What a path key needs is a value
	// already under it to reach into, and that is what the Enricher refuses it
	// for — `path-key-outside-combination` — with the whole Record in hand.
	//
	// One Token of lookahead settles `.{`: after a step's dot, a `{` opens a
	// braced descend and an Identifier continues the path. A member name is
	// never `{`, so there is nothing to be ambiguous about — and a descend ends
	// the key, since it already writes every member the key reaches.
	protected parseKeyPath(name: parser.IdentifierNode): {
		steps: Array<parser.IdentifierNode>
		group: parser.RecordValueNode | null
	} | null {
		if (this.tokens.peek()?.type !== TokenType.SymbolDot) {
			return null
		}

		let steps = [name]

		while (this.tokens.peek()?.type === TokenType.SymbolDot) {
			this.tokens.next()

			if (this.tokens.peek()?.type === TokenType.SymbolLeftBrace) {
				return { steps, group: this.parseKeyGroup(steps) }
			}

			steps.push(this.parseIdentifier())
		}

		return { steps, group: null }
	}

	// `server.{ port = 1, host }` — the member list of an update written
	// one level down. Shorthand is allowed inside it, where it is refused after
	// a `with`: a bare name there could be the whole value being merged, and
	// inside a descend there is no such reading to lose.
	protected parseKeyGroup(
		steps: Array<parser.IdentifierNode>,
	): parser.RecordValueNode {
		// Counted, because a descend holding a descend recurs through
		// the key list rather than through an Expression — so without this the
		// only nesting in the language the depth guard did not bound.
		this.enterNesting()

		try {
			return this.parseKeyGroupInterior(steps)
		} finally {
			this.nestingDepth--
		}
	}

	protected parseKeyGroupInterior(
		steps: Array<parser.IdentifierNode>,
	): parser.RecordValueNode {
		let leftBrace = this.tokens.expect(TokenType.SymbolLeftBrace)

		if (this.tokens.peek()?.type === TokenType.SymbolRightBrace) {
			let rightBrace = this.tokens.next()
			let position = {
				start: steps[0].position.start,
				end: rightBrace.position.end,
			}

			this.reportEmptyPathGroup(steps, position)

			return generators.recordValueNode(
				null,
				{},
				{
					start: leftBrace.position.start,
					end: rightBrace.position.end,
				},
			)
		}

		let keyValuePairList = this.parseKeyValuePairList(true, leftBrace)
		let rightBrace = this.tokens.expectClosing(
			TokenType.SymbolRightBrace,
			leftBrace,
		)

		return generators.recordValueNode(null, keyValuePairList.data, {
			start: leftBrace.position.start,
			end: rightBrace.position.end,
		})
	}

	// Reported and recovered rather than failed on: an empty descend is a
	// half-written one, and the rest of the list is still worth reading.
	protected reportEmptyPathGroup(
		steps: Array<parser.IdentifierNode>,
		position: common.Position,
	): void {
		if (this.suppressDiagnostics) {
			return
		}

		let spelling = steps.map((step) => step.content).join(".")

		reportError("This descend updates nothing", position, {
			code: "empty-path-group",
			labels: [primary(position, "no member is written here")],
			notes: [
				`An update writes the members it names, so a descend with none in it says to leave '${spelling}' exactly as it is.`,
			],
			// "or drop the key" was one Help and it was a dead end where
			// the key is the ONLY one: `{ config with server.{ } }` dropped down
			// to `{ config with }`, which is a syntax error. The second clause
			// says what to do there, and names the value the update was written
			// on — dropping the last key drops the update, and the value on its
			// own is what it was going to answer anyway.
			helps:
				this.updatedValue === null
					? [
							"Write the members to update inside it, or drop the key.",
						]
					: [
							"Write the members to update inside it.",
							`Or drop the key — and where it is the only one, drop the update with it and write '${this.updatedValue}' on its own.`,
						],
		})
	}

	// A path key always spells its value. Where the key ENDED without
	// one — a `,` or the closing brace stands where the `=` was — the member is
	// recovered under the name of its last step so the rest of the list can be
	// read, and refused with the one message that fits: no reading rescues a
	// bare path, since there is no `a.b = a.b` for it to have meant. Anything
	// else after the key falls through to the `=` this expects, whose failure
	// is what lets `{ config.server with … }` be read as the Combination it is.
	protected parsePathKeyValue(
		name: parser.IdentifierNode,
		steps: Array<parser.IdentifierNode>,
		allowShorthand: boolean,
	): ReturnType<typeof generators.keyValuePair> {
		let last = steps[steps.length - 1]
		let following = this.tokens.peek()?.type

		if (
			allowShorthand &&
			(following === TokenType.SymbolComma ||
				following === TokenType.SymbolRightBrace)
		) {
			this.reportShorthandOnPathKey(steps)

			return generators.keyValuePair(
				name,
				generators.identifier(last.content, last.position),
				{ start: name.position.start, end: last.position.end },
				true,
				steps,
			)
		}

		this.tokens.expect(TokenType.SymbolEqual)

		let value = this.parseExpression()

		return generators.keyValuePair(
			name,
			value,
			{ start: name.position.start, end: value.position.end },
			false,
			steps,
		)
	}

	protected reportShorthandOnPathKey(
		steps: Array<parser.IdentifierNode>,
	): void {
		if (this.suppressDiagnostics) {
			return
		}

		let last = steps[steps.length - 1]
		let position = {
			start: steps[0].position.start,
			end: last.position.end,
		}
		let spelling = steps.map((step) => step.content).join(".")

		reportError("A path key names no binding", position, {
			code: "shorthand-on-path-key",
			labels: [primary(position, "this reaches into a value to set")],
			notes: [
				"A bare name is a member and its own value; a path is neither, because the value it would set is not the name it reaches through.",
			],
			helps: [`Write '${spelling} = ${last.content}'.`],
		})
	}

	// Two keys clash when they are the same, or when one is a PREFIX of
	// the other at a step boundary: `server = s` sets the whole Record and
	// `server.port = 1` reaches into it, so writing both says two things about
	// `server` and only one of them can survive a Record keyed by name.
	// `serverPort` is not a prefix of `server` — the boundary is the dot, not
	// the characters.
	protected reportClashingMemberKeys(
		pairs: Array<ReturnType<typeof generators.keyValuePair>>,
	): void {
		if (this.suppressDiagnostics) {
			return
		}

		let seen: Array<{ key: string; position: common.Position }> = []

		for (let pair of pairs) {
			let key = generators.keyOf(pair)
			let position = keyPosition(pair)
			let clash = seen.find((entry) => keysClash(entry.key, key))

			if (clash === undefined) {
				seen.push({ key, position })

				continue
			}

			if (clash.key === key) {
				reportError(`Member '${key}' is already defined`, position, {
					code: "duplicate-member",
					labels: [
						primary(position, "defined a second time here"),
						secondary(clash.position, "first defined here"),
					],
					// The edit the two Labels spell out between them,
					// said rather than left to be worked out — and the second
					// writing is the one that goes, because the Record a reader
					// gets is the one the first key made.
					helps: [
						`Remove the second '${key}', or give it a name of its own.`,
					],
				})

				continue
			}

			let shared = clash.key.length < key.length ? clash.key : key

			reportError(
				`Member '${key}' and '${clash.key}' both write '${shared}'`,
				position,
				{
					code: "duplicate-member",
					labels: [
						primary(position, `this writes '${shared}'`),
						secondary(clash.position, "and so does this"),
					],
					notes: [
						"An update writes each member once, so a key that sets a whole Record and a path that reaches into it can not both stand.",
					],
					helps: [
						`Set '${shared}' as a whole, or reach into it with paths — not both.`,
					],
				},
			)
		}
	}

	// The Lexer has already split the interpolated String into its chunk
	// Tokens (`Start`/`Middle`/`End`) with each hole's own Tokens lexed in
	// place between them, so this reads as an ordinary alternation: a chunk, a
	// hole parsed by the full Expression grammar, a chunk, and so on, ending on
	// the `End` chunk. Positions come out absolute because the holes were never
	// a separate parse.
	protected parseInterpolatedString(): parser.InterpolatedStringValueNode {
		let start = this.tokens.expect(TokenType.LiteralStringStart)

		let segments: Array<parser.InterpolationSegmentNode> = [
			{ kind: "text", value: start.value },
		]
		let endToken = start

		while (true) {
			segments.push({
				kind: "expression",
				expression: this.parseExpression(),
			})

			let chunk = this.peekOrFail("the rest of the interpolated String")

			if (chunk.type === TokenType.LiteralStringEnd) {
				this.tokens.next()
				segments.push({ kind: "text", value: chunk.value })
				endToken = chunk
				break
			}

			if (chunk.type === TokenType.LiteralStringMiddle) {
				this.tokens.next()
				segments.push({ kind: "text", value: chunk.value })
				continue
			}

			// Unreachable for a String the Lexer produced — every hole it
			// opens it closes with a `Middle` or `End` chunk — but the grammar
			// says so rather than trusting it to.
			fail(
				`Expected the rest of the interpolated String but found ${describeToken(chunk)}.`,
				chunk.position,
			)
		}

		return generators.interpolatedStringValueNode(segments, {
			start: start.position.start,
			end: endToken.position.end,
		})
	}

	protected parseNumberLiteral():
		| parser.IntegerValueNode
		| parser.RationalValueNode {
		let numerator = this.parseInteger()

		// `1/2` is one Rational Literal because the three Tokens are
		// written flush — a `/` that stands apart from the Integer above it
		// belongs to whatever was meant on its own line, and joining it here
		// would silently turn that Integer into a Rational instead.
		let slash = this.tokens.peek()
		let denominatorStart = this.tokens.peek(1)

		if (
			slash?.type === TokenType.SymbolSlash &&
			denominatorStart !== undefined &&
			isAdjacent(numerator.position, slash.position) &&
			isAdjacent(slash.position, denominatorStart.position)
		) {
			this.tokens.next()

			let denominator = this.parseInteger()
			let position = {
				start: numerator.position.start,
				end: denominator.position.end,
			}

			this.refuseMixedRational(
				position,
				TokenType.SymbolDot,
				"'.' can not follow a fraction",
				(tail) => `${numerator.value}/${denominator.value}.${tail}`,
			)

			return generators.rationalValueNode(
				numerator.value,
				denominator.value,
				position,
			)
		}

		let decimal = this.parseDecimalTail(numerator)

		if (decimal !== null) {
			return decimal
		}

		return generators.integerValueNode(numerator.value, numerator.position)
	}

	// `0.75` is one Rational Literal for the reason `3/4` is — the
	// Integer, the `.` and the digits behind it are written flush, and a `.`
	// that stands apart from either side is the member access it has always
	// been. So `1.foo` still reads a member off an Integer, and `1 . 5` is
	// still two things with a broken `.` between them. Answers `null` where
	// what follows is not a decimal at all, so the Integer stands on its own.
	//
	// There is no scale — `1.50` is `150/100`, which the runtime reduces
	// on read, so `1.50 is 1.5`. A decimal is a way of WRITING a Rational and
	// not a Type of its own, and a Rational has no memory of how it was
	// written.
	protected parseDecimalTail(whole: {
		value: string
		position: common.Position
	}): parser.RationalValueNode | null {
		let dot = this.tokens.peek()

		if (
			dot?.type !== TokenType.SymbolDot ||
			!isAdjacent(whole.position, dot.position)
		) {
			return null
		}

		let following = this.tokens.peek(1)
		let flush =
			following !== undefined &&
			isAdjacent(dot.position, following.position)

		if (!flush || following?.type !== TokenType.LiteralNumber) {
			// A flush Identifier behind the point is the Lookup it was
			// before decimals existed — `1.foo` reads a member. Everything
			// else is half a decimal: `1.` at the end of a line, `1. 5` with
			// the digits pushed off the point.
			if (flush && isIdentifierToken(following)) {
				return null
			}

			throw new ParseError(
				"A decimal Literal has digits on both sides of the dot",
				{ start: whole.position.start, end: dot.position.end },
				"no digits stand flush behind the point",
				{
					code: "partial-decimal-literal",
					notes: [
						"A decimal Literal joins an Integer, a '.' and the digits behind it, all three written flush — so a '.' written flush against an Integer is the point of a decimal rather than a member access, and there is no reading of it with one side empty.",
					],
					helps: [
						"Write the digits behind the point: '1.0'.",
						"Or drop the '.' — a whole Number is written on its own.",
					],
				},
			)
		}

		this.tokens.next()

		let fraction = this.parseDigitRun()
		let position = {
			start: whole.position.start,
			end: fraction.position.end,
		}

		this.refuseMixedRational(
			position,
			TokenType.SymbolSlash,
			"'/' can not follow a decimal",
			(tail) => `${whole.value}.${fraction.value}/${tail}`,
		)

		return generators.rationalValueNode(
			decimalNumerator(whole.value, fraction.value),
			(10n ** BigInt(fraction.value.length)).toString(),
			position,
		)
	}

	// `1.5/2` and `1/2.5` — a Rational written both ways at once. The
	// tail is READ before it is refused, the way an `expect` Matcher is: what
	// is dropped is then the whole Literal, rather than a tail of it left
	// behind to be read again as a Statement of its own.
	protected refuseMixedRational(
		literal: common.Position,
		symbolType: lexer.TokenType,
		label: string,
		// The two digit runs already read, so that the Help can say what
		// the Literal MEANS. `'3/4' or '0.75'` was printed whatever was
		// written, and `2.5/3` — five sixths — was answered with a Help that
		// changed the number while the Quick Fix beside it offered `5/6`.
		written: (tail: string) => string,
	): void {
		let symbol = this.tokens.peek()
		let tailStart = this.tokens.peek(1)

		if (
			symbol?.type !== symbolType ||
			tailStart?.type !== TokenType.LiteralNumber ||
			!isAdjacent(literal, symbol.position) ||
			!isAdjacent(symbol.position, tailStart.position)
		) {
			return
		}

		this.tokens.next()

		let tail = this.parseDigitRun()
		// The value the two spellings say between them, the fraction
		// first. A value with no terminating decimal — `1.5/7` — has only the
		// one, and the Help offers only the one: a rounded decimal would be a
		// different number than the one that was written.
		let spellings = mixedRationalSpellings(written(tail.value))

		throw new ParseError(
			"A Rational Literal is a fraction or a decimal, not both",
			{ start: literal.start, end: tail.position.end },
			label,
			{
				code: "mixed-rational-literal",
				notes: [
					"A fraction and a decimal are two spellings of one Rational — '3/4' and '0.75' are the same value — so a Literal written both ways says the same thing twice, and leaves it to the reader which parts belong to which.",
				],
				helps:
					spellings.length === 0
						? [
								"Write the fraction, or the decimal — one Rational is spelled one way or the other.",
							]
						: [
								spellings.length === 1
									? `Write it as '${spellings[0]}', which is the value the two spellings say between them.`
									: `Write it as '${spellings[0]}' — or as '${spellings[1]}', which is the same value written the other way.`,
							],
			},
		)
	}

	// `.5` — the half of a decimal that is missing its whole part. It
	// arrives here because a `.` opens a member path, and the message a path
	// gives ("expected an Identifier") is about the wrong thing entirely: the
	// digits are not a member name that came out wrong, they are the Literal's
	// own fractional part.
	protected refusePartialDecimal(dot: Token): void {
		let digits = this.tokens.peek()

		if (
			digits?.type !== TokenType.LiteralNumber ||
			!isAdjacent(dot.position, digits.position)
		) {
			return
		}

		let fraction = this.parseDigitRun()

		throw new ParseError(
			"A decimal Literal has digits on both sides of the dot",
			{ start: dot.position.start, end: fraction.position.end },
			"nothing stands before the point",
			{
				code: "partial-decimal-literal",
				notes: [
					"A '.' that opens an Expression is a member path — '.price' reads a member off the value it is handed — and digits can not name a member, so this is a decimal missing its whole part rather than a path.",
				],
				helps: ["Write the digits before the point: '0.5'."],
			},
		)
	}

	// The name behind a `-` is offered as the thing to negate only where
	// it is the WHOLE of what was being negated. `-price` is `price::negate()`,
	// but `- tree::hasItems()` negates a call, and naming its receiver offers
	// an edit that negates something else entirely. What tells the two apart is
	// the Token behind the name: the four that carry an Expression on.
	protected negationHelp(operand: Token): string {
		let carriesOn = this.tokens.peek(1)?.type

		if (
			carriesOn === TokenType.SymbolDot ||
			carriesOn === TokenType.SymbolColon ||
			carriesOn === TokenType.SymbolLeftParen ||
			carriesOn === TokenType.SymbolLeftBracket
		) {
			return "A value is negated with '::negate()' written on it."
		}

		return `Write '${operand.value}::negate()'.`
	}

	protected parseInteger(): { value: string; position: common.Position } {
		let dash: Token | null = null
		if (this.tokens.peek()?.type === TokenType.SymbolDash) {
			dash = this.tokens.next()

			// `-price` — a `-` signs a Number Literal and negates nothing,
			// so a name behind one is the prefix operator another language
			// writes. Answered here because this is where the sign is read: the
			// Expression parser reaches a `-` only as the head of a Number, and
			// what follows it is this rule's to judge.
			let operand = this.tokens.peek()

			if (operand !== undefined && isIdentifierToken(operand)) {
				throw new ParseError(
					"Essence has no '-' operator",
					dash.position,
					"a '-' only signs a Number Literal",
					{
						code: "operator-not-supported",
						notes: [operatorNote],
						helps: [this.negationHelp(operand)],
					},
				)
			}
		}

		let digits = this.parseDigitRun()

		if (dash === null) {
			return digits
		}

		return {
			value: `-${digits.value}`,
			position: {
				start: dash.position.start,
				end: digits.position.end,
			},
		}
	}

	// The digits of one Number, `_` groups joined. Split out of
	// `parseInteger` because a decimal has TWO runs and only the first of them
	// may carry a sign — `0.-5` is not a Number, and reading the fractional
	// part with `parseInteger` is what would have made it one.
	protected parseDigitRun(): { value: string; position: common.Position } {
		let firstPart = this.tokens.expect(TokenType.LiteralNumber)

		let value = firstPart.value
		let lastPart = firstPart

		// `1_000` is one Number only because its Tokens are written
		// flush against one another. The same Tokens with anything between
		// them are separate things — a line that begins `_ 2` is a Statement
		// of its own (a broken one), not the tail of the Number above it.
		while (true) {
			let underscore = this.tokens.peek()
			let part = this.tokens.peek(1)

			if (
				underscore?.type !== TokenType.SymbolUnderscore ||
				part?.type !== TokenType.LiteralNumber ||
				!isAdjacent(lastPart.position, underscore.position) ||
				!isAdjacent(underscore.position, part.position)
			) {
				break
			}

			this.tokens.next()
			this.tokens.next()

			value += part.value
			lastPart = part
		}

		return {
			value,
			position: {
				start: firstPart.position.start,
				end: lastPart.position.end,
			},
		}
	}

	// One pair of brackets writes three things — a List, a Dictionary and
	// a Dictionary update — and which of them it is, is settled by ONE Token of
	// lookahead past the first Expression rather than by speculation: an `=`
	// after it makes the Expression a KEY, a `with` after it makes it a BASE,
	// and a comma or a `]` leaves it the item it has always been. Nothing is
	// ever read twice, so an error inside a long literal is reported where it
	// stands instead of surfacing as "not a List either".
	//
	// The empty pair is decided before anything is read at all: `[]` is the
	// empty List and `[=]` the empty Dictionary, and the `=` is what tells them
	// apart because neither holds anything else to tell them apart by.
	protected parseListOrDictionaryLiteral():
		| parser.ListValueNode
		| parser.DictionaryValueNode
		| parser.CombinationNode {
		let leftBracket = this.tokens.expect(TokenType.SymbolLeftBracket)

		if (this.tokens.peek()?.type === TokenType.SymbolEqual) {
			this.tokens.next()

			let rightBracket = this.tokens.expectClosing(
				TokenType.SymbolRightBracket,
				leftBracket,
			)

			return generators.dictionaryValueNode([], {
				start: leftBracket.position.start,
				end: rightBracket.position.end,
			})
		}

		if (this.tokens.peek()?.type === TokenType.SymbolRightBracket) {
			let rightBracket = this.tokens.next()

			return generators.listValueNode([], {
				start: leftBracket.position.start,
				end: rightBracket.position.end,
			})
		}

		let first = this.parseExpression()

		if (this.tokens.peek()?.type === TokenType.SymbolEqual) {
			let entries = this.parseDictionaryEntries(first, leftBracket)

			this.refuseTrailingEntrySeparator()

			let rightBracket = this.tokens.expectClosing(
				TokenType.SymbolRightBracket,
				leftBracket,
			)

			return generators.dictionaryValueNode(entries, {
				start: leftBracket.position.start,
				end: rightBracket.position.end,
			})
		}

		if (this.tokens.peek()?.type === TokenType.KeywordWith) {
			return this.parseDictionaryUpdate(leftBracket, first)
		}

		// The reading is a List from here on, and it stays one — but a
		// separator standing where the `]` belongs says the brackets were meant
		// to hold entries, and `["a": 1]` reported as "expected ']'" sends the
		// reader after the bracket rather than after the colon.
		let afterFirst = this.tokens.peek()

		if (
			afterFirst !== undefined &&
			writtenSeparatorLexeme(afterFirst, this.tokens.peek(1)) !== null
		) {
			this.refuseDictionaryEntry(first)
		}

		let values: Array<parser.ExpressionNode> = [first]

		while (this.tokens.peek()?.type === TokenType.SymbolComma) {
			this.tokens.next()

			if (this.tokens.peek()?.type === TokenType.SymbolRightBracket) {
				break
			}

			this.refuseListContinuation(
				TokenType.SymbolRightBracket,
				leftBracket,
			)

			values.push(this.parseExpression())
		}

		let rightBracket = this.tokens.expectClosing(
			TokenType.SymbolRightBracket,
			leftBracket,
		)

		return generators.listValueNode(values, {
			start: leftBracket.position.start,
			end: rightBracket.position.end,
		})
	}

	// `[1 = 2 = 3]` — a second `=` where the comma between two entries
	// belongs. The entry list read exactly what was written and stopped, so
	// what is left is a bracket that did not close, and that is what a reader
	// would be told about. The `=` is the Token the mistake is at.
	protected refuseTrailingEntrySeparator(): void {
		let found = this.tokens.peek()

		if (found?.type !== TokenType.SymbolEqual) {
			return
		}

		throw new ParseError(
			"A Dictionary's entries are separated by commas",
			found.position,
			"this entry already has its value",
			{
				code: "dictionary-entry-syntax",
				notes: [
					"An entry is 'key = value', and a bracket list holds one after another: '[1 = 2, 3 = 4]'.",
				],
				helps: ["Write a comma before the next key."],
			},
		)
	}

	// The rest of a Dictionary Literal, entered with the first key
	// already read and the `=` still ahead. A trailing comma is allowed exactly
	// where a List allows one, and for the same reason: a list of things laid
	// out one to a line grows by a line rather than by a line and an edit above
	// it.
	// And the `[` these entries stand in, for the same reason.
	protected parseDictionaryEntries(
		firstKey: parser.ExpressionNode,
		opening: Token,
	): Array<parser.DictionaryEntryNode> {
		let entries = [this.parseDictionaryEntry(firstKey)]

		while (this.tokens.peek()?.type === TokenType.SymbolComma) {
			this.tokens.next()

			if (this.tokens.peek()?.type === TokenType.SymbolRightBracket) {
				break
			}

			this.refuseListContinuation(TokenType.SymbolRightBracket, opening)

			entries.push(this.parseDictionaryEntry(this.parseExpression()))
		}

		return entries
	}

	// The `= value` half, read with the key already in hand — which is
	// what lets the `=` be expected here rather than guessed at: every caller
	// arrives having seen one, or having read a key that has to be followed by
	// one, and the refusal below reports at the Token the reader is standing on.
	protected parseDictionaryEntry(
		key: parser.ExpressionNode,
	): parser.DictionaryEntryNode {
		if (this.tokens.peek()?.type !== TokenType.SymbolEqual) {
			this.refuseDictionaryEntry(key)
		}

		this.tokens.next()

		let value = this.parseExpression()

		return {
			key,
			value,
			position: { start: key.position.start, end: value.position.end },
		}
	}

	// The near misses of an entry, which are the shapes a reader who
	// knows another language's dictionary writes: `["a": 1]`, `["a" -> 1]` and
	// `["a" = 1, "b"]`. None of them is a reading this Parser has, so left
	// alone every one of them is reported as the `]` or the `=` that did not
	// come — a message about a bracket, in a line whose mistake is the
	// separator between a key and its value.
	//
	// The separator is named where one was written, because that is the edit:
	// `:` becomes `=`. Where nothing at all follows the key, the key is what is
	// underlined, because the missing half is its value.
	protected refuseDictionaryEntry(key: parser.ExpressionNode): never {
		let found = this.tokens.peek()
		let separator =
			found === undefined
				? null
				: writtenSeparatorLexeme(found, this.tokens.peek(1))

		if (found !== undefined && separator !== null) {
			this.refuseForeignText(
				dictionaryEntryRefusal(separator, found.position),
			)
		}

		throw new ParseError(
			"A Dictionary entry is written with '='",
			key.position,
			"this key is written with no value",
			{
				code: "dictionary-entry-syntax",
				notes: [dictionaryEntryNote],
				helps: ["Write the value the key holds: 'key = value'."],
			},
		)
	}

	// `[ages with "kim" = 7]` and `[ages with other]` — the two halves of
	// the update form, told apart by ONE Token past the Expression after the
	// `with`, exactly as the literal itself is: an `=` makes it the first key,
	// and anything else leaves it the whole Dictionary being merged in.
	//
	// There is no SHORTHAND here and there is not going to be one. A bare
	// name after a Record's `with` is already the whole value being merged
	// (`{ config with other }`), and the same name after a Dictionary's `with`
	// is the same thing — so `[d with a]` merges `a` and never means
	// `[d with a = a]`. A Dictionary's key is a VALUE rather than a name, and
	// there is nothing for a name to be short for. See
	// `parseKeyValuePairList`'s `allowShorthand`, which is the braced half of
	// this rule.
	protected parseDictionaryUpdate(
		leftBracket: Token,
		base: parser.ExpressionNode,
	): parser.CombinationNode {
		let withKeyword = this.tokens.expect(TokenType.KeywordWith)

		if (this.tokens.peek()?.type === TokenType.SymbolRightBracket) {
			// The label ends at the `with` and not at the `]` behind it.
			// What the reader is being told about is the keyword and the
			// nothing after it, and underlining the bracket too reads as a
			// claim about the bracket — which is the one Token here that is
			// exactly where it belongs.
			throw new ParseError(
				"An update says what it changes",
				withKeyword.position,
				"nothing follows this 'with'",
				{
					code: "syntax-error",
					notes: [
						"A Dictionary update writes either the entries it sets — '[ages with \"kim\" = 7]' — or a whole Dictionary to merge in — '[ages with other]'.",
					],
					helps: [
						"Write the entries the update sets, or the Dictionary it merges in.",
						"Or drop the update and write the Dictionary on its own.",
					],
				},
			)
		}

		let first = this.parseExpression()

		if (this.tokens.peek()?.type === TokenType.SymbolEqual) {
			let entries = this.parseDictionaryEntries(first, leftBracket)
			// The key list spans the keys and nothing else — the brackets
			// belong to the Combination, which is the Node they open and close.
			// Exactly what a braced update's key list spans; see
			// `buildKeyValuePairList`.
			let keys = generators.dictionaryValueNode(entries, {
				start: entries[0].position.start,
				end: entries[entries.length - 1].position.end,
			})

			this.refuseTrailingEntrySeparator()

			let rightBracket = this.tokens.expectClosing(
				TokenType.SymbolRightBracket,
				leftBracket,
			)

			return generators.combination(
				base,
				keys,
				{
					start: leftBracket.position.start,
					end: rightBracket.position.end,
				},
				{ brackets: true, bare: true },
			)
		}

		// `[d with a, b]` — a comma-separated list of bare names, which is
		// the shorthand this form does not have and is never going to. Reported
		// here rather than left as "expected ']'" for the reason the braced
		// half reports `shorthand-in-combination`: the comma says the author
		// meant a key list, and what they have to be told is that a key is a
		// value and there is nothing for a name to be short for.
		if (this.tokens.peek()?.type === TokenType.SymbolComma) {
			throw new ParseError(
				"A bare name is not a key in an update",
				first.position,
				"this names no value to set",
				{
					code: "shorthand-in-combination",
					notes: [
						"A Dictionary update writes either the entries it sets — '[ages with \"kim\" = 7]' — or ONE whole Dictionary to merge in — '[ages with other]'.",
						"A key is a value rather than a name, so there is nothing for a bare name to be short for.",
					],
					helps: [
						"Write each entry: '[d with a = 1, b = 2]'.",
						"Or merge one whole Dictionary: '[d with other]'.",
					],
				},
			)
		}

		let rightBracket = this.tokens.expectClosing(
			TokenType.SymbolRightBracket,
			leftBracket,
		)

		return generators.combination(
			base,
			first,
			{
				start: leftBracket.position.start,
				end: rightBracket.position.end,
			},
			{ brackets: true },
		)
	}

	// `ownsDocumentation` is false for a literal in EXPRESSION position.
	// Such a literal is anonymous: it declares nothing, so no `§§` block is
	// written about it, and the block above it belongs to whatever Declaration
	// the expression sits inside. `documentationHere` is keyed by line alone,
	// so a literal sharing that Declaration's line would otherwise claim it —
	// which is how a Parameter's default `(_ item: ItemType) -> Boolean { … }`
	// took the Method's block, and had the Method's `@param` lines checked
	// against the literal's own Parameters. `parseParameterHead` keeps the same
	// rule off a Parameter, through `startsLine`.
	protected parseFunctionLiteral(
		allowsInferredTypes = false,
		ownsDocumentation = true,
	): parser.FunctionValueNode {
		let documentation = ownsDocumentation ? this.documentationHere() : null
		let parameterList = this.parseParameterList(allowsInferredTypes)
		let returnType = this.parseOptionalReturnType(allowsInferredTypes)
		let { result: block, completes } = this.completingBody(() =>
			this.outsideTestBody(() => this.parseBlock()),
		)

		return generators.functionValueNode(
			generators.functionDefinition(
				parameterList.parameters,
				returnType,
				block.body,
				parameterList.position,
				documentation,
				completes,
			),
			{
				start: parameterList.position.start,
				end: block.position.end,
			},
		)
	}

	protected parseGenericFunctionLiteral(
		ownsDocumentation = true,
	): parser.FunctionValueNode {
		let documentation = ownsDocumentation ? this.documentationHere() : null
		let genericList = this.parseGenericList()
		let parameterList = this.parseParameterList()
		let returnType = this.parseReturnType()
		let { result: block, completes } = this.completingBody(() =>
			this.outsideTestBody(() => this.parseBlock()),
		)

		return generators.functionValueNode(
			generators.genericFunctionDefinition(
				genericList.generics,
				parameterList.parameters,
				returnType,
				block.body,
				parameterList.position,
				documentation,
				completes,
				genericList.position,
			),
			{
				start: parameterList.position.start,
				end: block.position.end,
			},
		)
	}

	// Named Functions and Methods take an optional Generic list before
	// their parameter list — anonymous Function literals in expression
	// position are dispatched by their first Token instead (see
	// `parsePrimaryExpression`).
	protected parseOptionallyGenericFunctionLiteral(): parser.FunctionValueNode {
		if (this.tokens.peek()?.type === TokenType.SymbolLeftAngle) {
			return this.parseGenericFunctionLiteral()
		}

		return this.parseFunctionLiteral()
	}

	// #endregion

	// #region Functions

	protected parseOptionalGenericList(): Array<parser.GenericDeclarationNode> {
		return this.parseOptionalGenericListWithPosition().generics
	}

	// The same list, with the span of the `<…>` the entries were written
	// in — null where none was. Only a Method keeps it (see
	// `FunctionDefinitionNode.genericListPosition`); the readers that take the
	// entries alone go through `parseOptionalGenericList` above.
	protected parseOptionalGenericListWithPosition(): {
		generics: Array<parser.GenericDeclarationNode>
		position: common.Position | null
	} {
		if (this.tokens.peek()?.type === TokenType.SymbolLeftAngle) {
			return this.parseGenericList()
		}

		return { generics: [], position: null }
	}

	protected parseGenericList(): {
		generics: Array<parser.GenericDeclarationNode>
		position: common.Position
	} {
		let leftAngle = this.tokens.expect(TokenType.SymbolLeftAngle)

		let generics = [this.parseGenericDeclaration()]

		while (this.tokens.peek()?.type === TokenType.SymbolComma) {
			this.tokens.next()

			if (this.tokens.peek()?.type === TokenType.SymbolRightAngle) {
				break
			}

			this.refuseListContinuation(TokenType.SymbolRightAngle, leftAngle)

			generics.push(this.parseGenericDeclaration())
		}

		let rightAngle = this.tokens.expectClosing(
			TokenType.SymbolRightAngle,
			leftAngle,
		)

		return {
			generics,
			position: {
				start: leftAngle.position.start,
				end: rightAngle.position.end,
			},
		}
	}

	protected parseGenericDeclaration(): parser.GenericDeclarationNode {
		// `infer` is a valid Identifier, so it only acts as the modifier
		// when it is followed by the actual Generic name — `<infer>` declares
		// a Generic named `infer`.
		let inferred = false
		let inferKeyword: Token | null = null

		if (
			this.tokens.peek()?.type === TokenType.KeywordInfer &&
			isIdentifierToken(this.tokens.peek(1))
		) {
			inferKeyword = this.tokens.next()
			inferred = true
		}

		let name = this.parseIdentifier()
		let start = inferKeyword?.position.start ?? name.position.start

		// `is` is contextual — `<infer Item is Comparable>` bounds the
		// Type Parameter by a Protocol.
		let constraint: parser.IdentifierNode | null = null
		let peeked = this.tokens.peek()
		if (
			peeked?.type === TokenType.Identifier &&
			peeked.value === "is" &&
			isIdentifierToken(this.tokens.peek(1))
		) {
			this.tokens.next()
			constraint = this.parseIdentifier()
		}

		if (this.tokens.peek()?.type === TokenType.SymbolEqual) {
			this.tokens.next()

			let type = this.parseType()

			return generators.genericDeclarationNode(
				name,
				type,
				inferred,
				constraint,
				{
					start,
					end: type.position.end,
				},
			)
		}

		return generators.genericDeclarationNode(
			name,
			null,
			inferred,
			constraint,
			{
				start,
				end: constraint?.position.end ?? name.position.end,
			},
		)
	}

	protected parseParameterList(allowsInferredTypes = false): {
		parameters: Array<parser.ParameterNode>
		position: common.Position
	} {
		let leftParen = this.tokens.expect(TokenType.SymbolLeftParen)

		let parameters: Array<parser.ParameterNode> = []

		if (this.tokens.peek()?.type !== TokenType.SymbolRightParen) {
			parameters.push(this.parseParameter(allowsInferredTypes))

			while (this.tokens.peek()?.type === TokenType.SymbolComma) {
				this.tokens.next()

				if (this.tokens.peek()?.type === TokenType.SymbolRightParen) {
					break
				}

				this.refuseListContinuation(
					TokenType.SymbolRightParen,
					leftParen,
				)

				parameters.push(this.parseParameter(allowsInferredTypes))
			}
		}

		let rightParen = this.tokens.expectClosing(
			TokenType.SymbolRightParen,
			leftParen,
		)

		return {
			parameters,
			position: {
				start: leftParen.position.start,
				end: rightParen.position.end,
			},
		}
	}

	// The `§§` block above whatever is about to be parsed. Every
	// Declaration sits on the line of its own first Token, so no Declaration
	// needs to hand its Documentation down to the signature it owns.
	protected documentationHere(): common.Documentation | null {
		let token = this.tokens.peek()

		if (token === undefined) {
			return null
		}

		return this.tokens.documentationAbove(token.position.start.line)
	}

	// `allowsInferredTypes` is set only for a Function literal in
	// expression position, where an omitted annotation has an expected
	// signature to be read off. Every Declaration parses its annotations, so a
	// null Type can not reach a named Function or a Method.
	// The `= expression` a caller may leave out, read after everything
	// else the Parameter writes. There is nothing to disambiguate here:
	// Essence has no infix operators at all, so nothing continues an
	// expression past a top-level `,` or `)`, and any comma inside the default
	// sits within a `(…)`, `[…]`, `{…}` or `<…>` the sub-parser already
	// balances.
	//
	// It is attached to the finished Parameter rather than threaded through
	// the nine places one is built, and it deliberately leaves `position`
	// alone — see the NOTE on `ParameterNode`.
	protected parseParameter(
		allowsInferredTypes = false,
	): parser.ParameterNode {
		let parameter = this.parseParameterHead(allowsInferredTypes)

		if (this.tokens.peek()?.type === TokenType.SymbolEqual) {
			this.tokens.next()

			parameter.defaultValue = this.parseExpression()
		}

		return parameter
	}

	// `start` and `complete` can not be a Parameter's LABEL. A label
	// stands exactly where the two words open their prefix Expression, so
	// `compute(start 1)` is a `start` of `1` and never an Argument labelled
	// `start` — a Parameter asking for one could not be written at a call at
	// all, and every call would report a label the caller had already written.
	// Refused here, where the signature is read, so the Declaration is what
	// answers for it.
	//
	// The label is dropped and the Parameter keeps its name, the way a
	// `redundant-parameter-label` does: one reserved word is no reason to
	// refuse the whole Declaration and cascade through its body.
	protected parameterLabel(
		name: parser.IdentifierNode,
	): parser.IdentifierNode | null {
		if (name.content !== "start" && name.content !== "complete") {
			return name
		}

		reportError(
			`A Parameter's label can not be spelled '${name.content}'`,
			name.position,
			{
				code: "reserved-parameter-label",
				labels: [
					primary(name.position, "this word opens an Expression"),
				],
				notes: [
					`An Argument written '${name.content} value' reads as a '${name.content}' of the value, so no call could pass this Parameter by name.`,
				],
				helps: [
					"Name the label another word.",
					"Or write '_' in its place, so the Parameter takes no label at all.",
				],
			},
		)

		return null
	}

	protected parseParameterHead(
		allowsInferredTypes = false,
	): parser.ParameterNode {
		// Only a Parameter written on a line of its own can carry a
		// block — otherwise the first Parameter of `function greet (…)` would
		// claim the Function's own Documentation.
		let documentation = this.tokens.startsLine()
			? this.documentationHere()
			: null

		let annotationFollows = () =>
			this.tokens.peek()?.type === TokenType.SymbolColon

		// `(a + b) * c` — the parentheses a reader wrote to GROUP, read
		// here as the Parameter list of a Function literal, `a` as a label and
		// `+` as the name it labels. What came of that was
		// `redundant-parameter-label` about a Parameter nobody wrote, and then
		// a `syntax-error` at the `b` behind it. The `+` is refused instead,
		// where it stands, with the note that says there are no grouping
		// parentheses either — see `operatorNote`.
		let following = this.foreignTextFollowing()

		if (following !== null) {
			this.refuseForeignText(following)
		}

		// A leading `{` — a Pattern standing where the internal name goes,
		// with no label written. Like a bare `item`, it takes both its Type and
		// its label from the expected signature.
		if (this.tokens.peek()?.type === TokenType.SymbolLeftBrace) {
			return this.parsePatternParameter(null, null, documentation)
		}

		if (this.tokens.peek()?.type === TokenType.SymbolUnderscore) {
			let underscore = this.tokens.next()

			// `_ { … }` — the labelless Pattern Parameter written out,
			// which is what a named Function needs, since it parses its
			// annotations rather than reading them off a signature.
			if (this.tokens.peek()?.type === TokenType.SymbolLeftBrace) {
				return this.parsePatternParameter(
					null,
					underscore.position,
					documentation,
				)
			}

			// A bare `_` — binds no name and takes its Type from the
			// expected signature, the contextual counterpart of `_: Type`.
			if (allowsInferredTypes && !isIdentifierToken(this.tokens.peek())) {
				return generators.parameter(
					null,
					null,
					null,
					underscore.position,
					documentation,
				)
			}

			// `_: Type` stops at the `_` — it drops the label *and* the
			// name, leaving a Parameter the body has no way to refer to. `_
			// name: Type` only drops the label.
			if (this.tokens.peek()?.type === TokenType.SymbolColon) {
				this.tokens.next()

				let type = this.parseType()

				return generators.parameter(
					null,
					null,
					type,
					{
						start: underscore.position.start,
						end: type.position.end,
					},
					documentation,
				)
			}

			let internalName = this.parseIdentifier()

			// `_ name` — the same Parameter `_ name: Type` declares,
			// with the Type left to the expected signature.
			if (allowsInferredTypes && !annotationFollows()) {
				return generators.parameter(
					null,
					internalName,
					null,
					{
						start: underscore.position.start,
						end: internalName.position.end,
					},
					documentation,
				)
			}

			this.tokens.expect(TokenType.SymbolColon)

			let type = this.parseType()

			return generators.parameter(
				null,
				internalName,
				type,
				{ start: underscore.position.start, end: type.position.end },
				documentation,
			)
		}

		let name = this.parseIdentifier()

		// `of { width, height }: Rectangle` — a label, then a Pattern where
		// the internal name goes. The label is what the caller writes, so the
		// call site is untouched by anything the Pattern says.
		if (this.tokens.peek()?.type === TokenType.SymbolLeftBrace) {
			return this.parsePatternParameter(
				this.parameterLabel(name),
				null,
				documentation,
			)
		}

		if (isIdentifierToken(this.tokens.peek())) {
			let internalName = this.parseIdentifier()

			// A written label is only meaningful next to a written Type
			// — an unannotated Parameter takes its label from the expected
			// signature, so there would be nothing for this one to agree with.
			// The label is dropped and parsing continues, so that one mistaken
			// label does not cascade into a parse failure for the whole
			// literal.
			if (allowsInferredTypes && !annotationFollows()) {
				let labelPosition = {
					start: name.position.start,
					end: internalName.position.end,
				}

				reportError(
					"A Parameter without a Type can not carry a label",
					labelPosition,
					{
						code: "redundant-parameter-label",
						labels: [primary(labelPosition, "two names, no Type")],
						notes: [
							"Such a Parameter takes its label from the expected Function Type.",
						],
						helps: [`Write only '${internalName.content}'.`],
					},
				)

				return generators.parameter(
					null,
					internalName,
					null,
					{
						start: name.position.start,
						end: internalName.position.end,
					},
					documentation,
				)
			}

			this.tokens.expect(TokenType.SymbolColon)

			let type = this.parseType()

			return generators.parameter(
				this.parameterLabel(name),
				internalName,
				type,
				{ start: name.position.start, end: type.position.end },
				documentation,
			)
		}

		// A bare `item` — both the Type and the label come from the
		// expected signature, which is why no external name is recorded. This
		// is the one place a lone Identifier does not mean `name: Type`'s
		// label-and-name, and it is why the annotated and unannotated forms of
		// a lambda can not be mixed within one Parameter.
		if (allowsInferredTypes && !annotationFollows()) {
			return generators.parameter(
				null,
				name,
				null,
				name.position,
				documentation,
			)
		}

		this.tokens.expect(TokenType.SymbolColon)

		let type = this.parseType()

		return generators.parameter(
			this.parameterLabel(name),
			name,
			type,
			{ start: name.position.start, end: type.position.end },
			documentation,
		)
	}

	// The tail of every Pattern Parameter, shared by its three spellings —
	// `({ … })`, `(_ { … }: Type)` and `(label { … }: Type)`. The annotation is
	// optional for the same reason a bare `item`'s is: a Function literal in
	// Argument position has an expected signature to read it off.
	protected parsePatternParameter(
		externalName: parser.IdentifierNode | null,
		underscorePosition: common.Position | null,
		documentation: common.Documentation | null,
	): parser.ParameterNode {
		let pattern = this.parsePattern()

		let type =
			this.tokens.peek()?.type === TokenType.SymbolColon
				? (this.tokens.next(), this.parseType())
				: null

		return generators.parameter(
			externalName,
			pattern,
			type,
			{
				start:
					externalName?.position.start ??
					underscorePosition?.start ??
					pattern.position.start,
				end: (type ?? pattern).position.end,
			},
			documentation,
		)
	}

	// A signature with no body has nothing for a Pattern's bindings to be
	// read in — a native Method ends at its return Type and a Protocol Method
	// never had a block. Refused here rather than in the Enricher, because the
	// Parameter is well-formed and only its POSITION is wrong.
	protected refusePatternParameters(
		parameters: Array<parser.ParameterNode>,
		kind: string,
	): void {
		for (let parameter of parameters) {
			if (parameter.internalName?.nodeType !== "Pattern") {
				continue
			}

			let position = parameter.internalName.position

			reportError(`A ${kind} can not take a Parameter apart`, position, {
				code: "pattern-without-body",
				labels: [primary(position, "no body to bind these in")],
				notes: [
					`A ${kind} declares what a call looks like and nothing about how it is carried out, so a Pattern here would name parts for nobody to read.`,
				],
				helps: ["Write one name, and take it apart where it is used."],
			})
		}
	}

	// The two positions where a Parameter is well-formed but a default on
	// it could never fire, refused here for the same reason
	// `refusePatternParameters` is: the Parameter parses, only its POSITION is
	// wrong. The default is dropped once reported, so that one misplaced `=`
	// does not cascade into everything downstream that reads it.
	protected refuseDefaultValues(
		parameters: Array<parser.ParameterNode>,
		kind: "Function literal" | "Protocol requirement",
	): void {
		for (let parameter of parameters) {
			if (parameter.defaultValue === null) {
				continue
			}

			let position = parameter.defaultValue.position

			if (kind === "Protocol requirement") {
				reportError(
					"A Protocol requirement can not carry a default",
					position,
					{
						code: "default-on-protocol-requirement",
						labels: [primary(position, "this default")],
						notes: [
							"A requirement says which calls a conforming Type must answer; a default is part of how one of them answers, which is each Namespace's own.",
						],
						helps: [
							"Declare the requirement without the default, and write the default on the fulfilling Method.",
						],
					},
				)
			} else {
				reportError(
					"A Function literal can not carry a default",
					position,
					{
						code: "default-on-function-literal",
						labels: [primary(position, "this default")],
						notes: [
							"A Function literal is called through the Function Type it was written for, which fixes how many Arguments every call passes, so a default here could never be reached.",
							// A Note rather than the Help it used to be.
							// "Write the default on the named Function or
							// Method this value is passed to" is an edit in
							// somebody else's Declaration, and often in nobody's
							// at all: a literal handed to `map` is passed to a
							// Method of the standard library, and a literal
							// bound to a name is passed to nothing yet. What is
							// true of every one of them is the rule, and the
							// rule is what this says.
							"A default belongs to a named Function or Method, whose Parameter list is part of the Declaration a call is resolved against.",
						],
						// The same edit the Quick Fix makes. The two used
						// to disagree — the fix took the default out and the
						// Help sent the reader somewhere else entirely.
						helps: ["Remove the default."],
					},
				)
			}

			parameter.defaultValue = null
		}
	}

	protected parseArgumentList(): {
		args: Array<parser.ArgumentNode>
		position: common.Position
	} {
		let leftParen = this.tokens.expect(TokenType.SymbolLeftParen)

		let args: Array<parser.ArgumentNode> = []

		if (this.tokens.peek()?.type !== TokenType.SymbolRightParen) {
			args.push(this.parseArgument(leftParen))

			while (this.tokens.peek()?.type === TokenType.SymbolComma) {
				this.tokens.next()

				if (this.tokens.peek()?.type === TokenType.SymbolRightParen) {
					break
				}

				this.refuseListContinuation(
					TokenType.SymbolRightParen,
					leftParen,
				)

				args.push(this.parseArgument(leftParen))
			}
		}

		let rightParen = this.tokens.expectClosing(
			TokenType.SymbolRightParen,
			leftParen,
		)

		return {
			args,
			position: {
				start: leftParen.position.start,
				end: rightParen.position.end,
			},
		}
	}

	// Whether `label value` is what stands here, read off the Token AFTER
	// the leading Identifier instead of by parsing an Expression and finding
	// that it did not span the argument. Labelled arguments are the norm in
	// Essence, and the speculation below costs three or four throws for each
	// one of them — the label alone is an Expression, so the reading that is
	// tried first always fails, after `parsePrimaryExpression` has itself
	// speculated a typed Record literal and a Case construction on the way.
	//
	// This decides only what the speculation would have decided anyway, which
	// is what keeps every Diagnostic where it was. The Expression reading takes
	// the leading Identifier and continues it, and only three Token types
	// continue one: `.`, `(`, and `::` — plus a `#` written FLUSH against the
	// Identifier, which makes `Choice#Case`. Everything else that could stand
	// there either begins a value of its own, and then the label reading is the
	// only one that can span the argument, or ends the argument, and then the
	// Expression is the Identifier alone. So: labelled exactly when the next
	// Token begins an Expression, minus the two that continue the Identifier
	// instead.
	//
	// `#` is the parser's adjacency rule, and the standard library leans
	// on it everywhere — `normalize(as #ComposedCanonical)` is a bare Case
	// passed under the label `as`, and `Ordering#Less` is a Choice prefix. The
	// space between them is the whole difference.
	//
	// `<` stays speculative. It continues the Identifier as
	// `Holder<Integer>#Full(…)` and it also opens a Generic Function literal
	// that could be a labelled argument's value, and only a parse can tell
	// which — `parsePrimaryExpression` says the same thing about the same `<`.
	//
	// `start` and `complete` are never read as a label, whichever Token
	// stands behind them. Where the Keyword form opens, the two readings span
	// the same two Tokens — the label reading takes the word and the value, the
	// Keyword reading the word and the Expression — and the Keyword wins, so
	// that `Terminal.print(complete headline(url))` is the wait it reads as.
	// Where it does not open, the word is a NAME and what follows is read off
	// it: `compute(start .price)` is the member path of a value called `start`,
	// not an Argument labelled with a word no call could write.
	//
	// The reservation itself is made where the signature is read —
	// `parseParameterHead` refuses either word as a Parameter's label — so
	// there is no Declaration left for a label spelled with one to fit.
	protected argumentIsLabelled(): boolean {
		let token = this.tokens.peek()!
		let following = this.tokens.peek(1)

		if (
			token.type === TokenType.KeywordStart ||
			token.type === TokenType.KeywordComplete
		) {
			return false
		}

		if (
			!startsExpression(following) ||
			following!.type === TokenType.SymbolLeftParen ||
			following!.type === TokenType.SymbolLeftAngle
		) {
			return false
		}

		// A label never stands in front of another language's operator.
		// `Terminal.print(total + tax)` read `total` as one and `+ tax` as its
		// value, and what came of that was `Expected ')' but found 'tax'` — the
		// Argument list complaining about text that was never an Argument's.
		// Read as an Expression instead, the `+` is met where the Expression
		// ENDS, which is where the operator table answers for it.
		if (this.foreignTextFollowing() !== null) {
			return false
		}

		// '#', '.' and '[' all continue the Identifier when they are
		// written flush against it — `Choice#Case`, `order.isPaid` and the
		// `primes[0]` that is refused as an index — and each opens an Expression
		// of its own when a space stands between: `label #Case` passes a bare
		// Case, `label .price` a member path, `contentsOf [1, 2]` a List. The
		// space is the whole difference, and it is the same rule the prefixed
		// Case construction is read by.
		//
		// The `[` is here so that `Terminal.print(primes[0])` is answered
		// about the index rather than about the Argument it is not: read as a
		// label, `primes` labelled a List and the report was
		// `argument-label-mismatch` about a label nobody wrote. Read as an
		// Expression, the brackets are met where the Expression ENDS, which is
		// where they are refused and named.
		if (
			following!.type === TokenType.SymbolHash ||
			following!.type === TokenType.SymbolDot ||
			following!.type === TokenType.SymbolLeftBracket
		) {
			return !isAdjacent(token.position, following!.position)
		}

		return true
	}

	protected parseArgument(opening: Token): parser.ArgumentNode {
		let outerInsideArgumentList = this.insideArgumentList

		this.insideArgumentList = true

		try {
			return this.parseArgumentValue(opening)
		} finally {
			this.insideArgumentList = outerInsideArgumentList
		}
	}

	protected parseArgumentValue(opening: Token): parser.ArgumentNode {
		if (isIdentifierToken(this.tokens.peek())) {
			if (this.argumentIsLabelled()) {
				let name = this.parseIdentifier()
				let value = this.parseExpression()

				return generators.argument(name, value)
			}

			// An Identifier can start both a plain Expression argument
			// and a labelled argument, so we try the Expression reading first
			// and fall back to the labelled reading — exactly one of the two
			// can reach the end of the argument.
			//
			// The failure is phrased as the Argument list's own close
			// would phrase it — "Expected ')' but found 'X'" at the Token the
			// Expression stopped in front of — rather than as a remark about
			// the reading ("Expression does not span the whole argument"). It
			// used to be neither reported nor positioned, because the labelled
			// reading below always answered for the text; furthest-failure
			// tracking reports it wherever this reading got FURTHER than that
			// one, and a call missing its `)` is exactly when it does.
			let unlabelledArgument = this.backtrack(() => {
				let value = this.parseExpression()
				let next = this.tokens.peek()?.type

				if (
					next !== TokenType.SymbolComma &&
					next !== TokenType.SymbolRightParen
				) {
					this.tokens.failClosing(TokenType.SymbolRightParen, opening)
				}

				return generators.argument(null, value)
			})

			if (unlabelledArgument !== null) {
				return unlabelledArgument
			}

			let name = this.parseIdentifier()
			let value = this.parseExpression()

			return generators.argument(name, value)
		}

		return generators.argument(null, this.parseExpression())
	}

	// #endregion

	// #region Types

	// `|` binds loosest, so a Union is parsed on top of Generic
	// application — `List<Item> | String` is a Union of `List<Item>` and
	// `String`, not a Generic over a Union. A Union is still reachable as a
	// Generic argument (`List<Item | String>`), where the angle brackets
	// delimit it.
	protected parseType(): parser.TypeDeclarationNode {
		this.enterNesting()

		try {
			let firstType = this.parseGenericType()

			if (this.tokens.peek()?.type === TokenType.SymbolPipe) {
				let types = [firstType]

				while (this.tokens.peek()?.type === TokenType.SymbolPipe) {
					this.tokens.next()
					types.push(this.parseGenericType())
				}

				return generators.unionTypeDeclaration(types, {
					start: firstType.position.start,
					end: types[types.length - 1].position.end,
				})
			}

			return firstType
		} finally {
			this.nestingDepth--
		}
	}

	protected parseGenericType(): parser.TypeDeclarationNode {
		let baseType = this.parseSimpleType()

		let leftAngleToken = this.tokens.peek()

		// A `<` continues the base Type as a generic application
		// (`List<Integer>`) ONLY when it sits on the SAME line as the Type it
		// applies to. A `<` that opens the NEXT line begins a new declaration —
		// the next entry of an `overload` block leading with its own `<infer …>`
		// clause is the case in point: a body-less entry returning a bare Generic
		// (`… -> Result`) sits directly above the next entry's `<`, and reading
		// the two as `Result<infer …>` would swallow that clause. A Type
		// application is always written on one line, so this rejects nothing a
		// declaration means to say.
		if (
			leftAngleToken?.type === TokenType.SymbolLeftAngle &&
			leftAngleToken.position.start.line === baseType.position.end.line
		) {
			let { typeArguments, position } = this.parseTypeArgumentList()

			// From the base Type, not from the `<` — the Node stands for
			// `List<Item>`, so that is what it spans. Starting at the bracket
			// would leave `List` inside no Node at all, which is what made the
			// Editor underline the Arguments alone while naming the whole
			// application.
			return generators.genericTypeDeclaration(baseType, typeArguments, {
				start: baseType.position.start,
				end: position.end,
			})
		}

		return baseType
	}

	// `<Integer, String>` — the Arguments of an application, wherever one
	// is written. An annotation's `Holder<Integer>` and a value's
	// `Holder<Integer>#Full` are the same list, so they are the same parse.
	protected parseTypeArgumentList(): {
		typeArguments: Array<parser.TypeDeclarationNode>
		position: common.Position
	} {
		let leftAngle = this.tokens.expect(TokenType.SymbolLeftAngle)

		let typeArguments = [this.parseType()]

		while (this.tokens.peek()?.type === TokenType.SymbolComma) {
			this.tokens.next()

			if (this.tokens.peek()?.type === TokenType.SymbolRightAngle) {
				break
			}

			this.refuseListContinuation(TokenType.SymbolRightAngle, leftAngle)

			typeArguments.push(this.parseType())
		}

		let rightAngle = this.tokens.expectClosing(
			TokenType.SymbolRightAngle,
			leftAngle,
		)

		return {
			typeArguments,
			position: {
				start: leftAngle.position.start,
				end: rightAngle.position.end,
			},
		}
	}

	protected parseSimpleType():
		| parser.IdentifierTypeDeclarationNode
		| parser.RecordTypeDeclarationNode
		| parser.FunctionTypeDeclarationNode {
		let token = this.peekOrFail("a Type")

		if (isIdentifierToken(token)) {
			let name = this.parseIdentifier()

			return generators.identifierTypeDeclaration(name, name.position)
		}

		if (token.type === TokenType.SymbolLeftBrace) {
			return this.parseRecordType()
		}

		if (token.type === TokenType.SymbolLeftParen) {
			return this.parseFunctionType()
		}

		fail(
			`Expected a Type but found ${describeToken(token)}.`,
			token.position,
		)
	}

	protected parseFunctionType(): parser.FunctionTypeDeclarationNode {
		let leftParen = this.tokens.expect(TokenType.SymbolLeftParen)

		let parameterTypes: Array<parser.FunctionTypeParameterNode> = []

		if (this.tokens.peek()?.type !== TokenType.SymbolRightParen) {
			parameterTypes.push(this.parseFunctionTypeParameter())

			while (this.tokens.peek()?.type === TokenType.SymbolComma) {
				this.tokens.next()

				if (this.tokens.peek()?.type === TokenType.SymbolRightParen) {
					break
				}

				this.refuseListContinuation(
					TokenType.SymbolRightParen,
					leftParen,
				)

				parameterTypes.push(this.parseFunctionTypeParameter())
			}
		}

		this.tokens.expectClosing(TokenType.SymbolRightParen, leftParen)

		let returnType = this.parseReturnType()

		return generators.functionTypeDeclaration(parameterTypes, returnType, {
			start: leftParen.position.start,
			end: returnType.position.end,
		})
	}

	// Function Type parameters mirror the parameter grammar — the
	// internal name only documents the parameter and may be omitted entirely
	// (`_: String`), while the external name is part of the call syntax.
	protected parseFunctionTypeParameter(): parser.FunctionTypeParameterNode {
		if (this.tokens.peek()?.type === TokenType.SymbolUnderscore) {
			let underscore = this.tokens.next()

			if (isIdentifierToken(this.tokens.peek())) {
				this.parseIdentifier()
			}

			this.tokens.expect(TokenType.SymbolColon)

			let type = this.parseType()

			return generators.functionTypeParameter(null, type, {
				start: underscore.position.start,
				end: type.position.end,
			})
		}

		let name = this.parseIdentifier()

		if (isIdentifierToken(this.tokens.peek())) {
			this.parseIdentifier()
		}

		this.tokens.expect(TokenType.SymbolColon)

		let type = this.parseType()

		return generators.functionTypeParameter(name, type, {
			start: name.position.start,
			end: type.position.end,
		})
	}

	protected parseRecordType(): parser.RecordTypeDeclarationNode {
		let leftBrace = this.tokens.expect(TokenType.SymbolLeftBrace)

		if (this.tokens.peek()?.type === TokenType.SymbolRightBrace) {
			let rightBrace = this.tokens.next()

			return generators.recordTypeDeclaration(
				{},
				{
					start: leftBrace.position.start,
					end: rightBrace.position.end,
				},
			)
		}

		let pairs = [this.parseKeyTypePair()]

		while (this.tokens.peek()?.type === TokenType.SymbolComma) {
			this.tokens.next()

			if (this.tokens.peek()?.type === TokenType.SymbolRightBrace) {
				break
			}

			this.refuseListContinuation(TokenType.SymbolRightBrace, leftBrace)

			pairs.push(this.parseKeyTypePair())
		}

		let rightBrace = this.tokens.expectClosing(
			TokenType.SymbolRightBrace,
			leftBrace,
		)

		this.reportDuplicateNames(pairs, "Member", "duplicate-member")

		return generators.recordTypeDeclaration(
			generators.buildKeyTypePairList(
				pairs.slice(0, -1),
				pairs[pairs.length - 1],
			).data,
			{
				start: leftBrace.position.start,
				end: rightBrace.position.end,
			},
		)
	}

	protected parseKeyTypePair(): ReturnType<typeof generators.keyTypePair> {
		let name = this.parseIdentifier()

		this.tokens.expect(TokenType.SymbolColon)

		let type = this.parseType()

		return generators.keyTypePair(name, type, {
			start: name.position.start,
			end: type.position.end,
		})
	}

	protected parseReturnType(): parser.TypeDeclarationNode {
		this.tokens.expect(TokenType.SymbolDash)
		this.tokens.expect(TokenType.SymbolRightAngle)

		return this.parseType()
	}

	// A contextually typed Function literal may go straight from its
	// Parameter list to its block, leaving the return Type to the expected
	// signature — or, where that leaves it Generic, to its own body.
	protected parseOptionalReturnType(
		allowsInferredTypes: boolean,
	): parser.TypeDeclarationNode | null {
		if (
			allowsInferredTypes &&
			this.tokens.peek()?.type !== TokenType.SymbolDash
		) {
			return null
		}

		return this.parseReturnType()
	}

	// #endregion

	// #region Helpers

	protected parseBlock(): BlockResult {
		this.enterNesting()

		// A block is a position of its own — what a Statement inside one
		// is written into says nothing about the Argument list the block itself
		// may stand in.
		let outerInsideArgumentList = this.insideArgumentList

		this.insideArgumentList = false

		try {
			// `(n: Integer) => n` — the one habit that is written where a
			// BLOCK belongs, which is why it is answered here rather than beside
			// the operators: the Parameter list read cleanly and what follows it
			// is an arrow no construction of this language has. Every block goes
			// through here, so the `=>` of a Function literal, of an `if` and of a
			// `match` arm are all answered in the same words.
			let arrow = this.foreignLexeme()
			let refusal =
				arrow?.text === "=>"
					? foreignSyntaxRefusal(arrow.text, arrow.position)
					: null

			if (refusal !== null) {
				this.refuseForeignText(refusal)
			}

			let leftBrace = this.tokens.expect(TokenType.SymbolLeftBrace)

			let body = this.parseStatementList(() =>
				this.parseImplementationNode(),
			)
			let closingPosition = this.parseClosingBrace(leftBrace.position)

			return {
				body,
				position: {
					start: leftBrace.position.start,
					end: closingPosition.end,
				},
			}
		} finally {
			this.nestingDepth--
			this.insideArgumentList = outerInsideArgumentList
		}
	}

	// Called on the way into every parsing method that recurs once per
	// written nesting level — `parseExpression`, `parseType` and `parseBlock`
	// reach each other through everything between them, and a key list's braced
	// descend is the one nesting that reaches none of the three. Counting the
	// four bounds the whole descent. The caller decrements in a `finally`: a throw
	// unwinds any number of levels at once, and the count has to unwind with
	// them.
	protected enterNesting(): void {
		if (this.nestingDepth >= maximumNestingDepth) {
			let position =
				this.tokens.peek()?.position ?? this.tokens.endPosition()

			throw new ParseError(
				"This code is nested too deeply",
				position,
				`the ${maximumNestingDepth}th level of nesting starts here`,
				{
					code: "nesting-too-deep",
					notes: [
						`The parser reads nesting by recursion, so there is a depth at which it would run out of call stack mid-read and crash without a report — it refuses at ${maximumNestingDepth} levels instead, with one.`,
					],
					helps: [
						"Break the nesting up: name intermediate values as Constants, or intermediate Types as Type Aliases.",
					],
				},
			)
		}

		this.nestingDepth++
	}

	// Whether the `(` the reader is standing on opens a parameter list
	// rather than a call: it does exactly when the `)` that closes it is
	// followed by the `{` of a block, or by the `for` of a `for any (…)`.
	// Parentheses are the only thing counted — they nest inside every other
	// bracket and every other bracket nests inside them, so a `)` at depth zero
	// is the one that closes this `(` whatever stands in between.
	//
	// The `for` is what lets a test writing BOTH `across` and `for any`
	// parse at all. It can not mean anything — a body runs written rows or
	// generated values, never both — and the Enricher says exactly that. Reading
	// it as a call instead would report a syntax error about a colon, which
	// tells a reader nothing about what they wrote.
	protected stopsBeforeParameterList(): boolean {
		let depth = 0

		for (let offset = 0; ; offset++) {
			let token = this.tokens.peek(offset)

			if (token === undefined) {
				return false
			}

			if (token.type === TokenType.SymbolLeftParen) {
				depth++

				continue
			}

			if (token.type !== TokenType.SymbolRightParen) {
				continue
			}

			depth--

			if (depth > 0) {
				continue
			}

			let following = this.tokens.peek(offset + 1)?.type

			return (
				following === TokenType.SymbolLeftBrace ||
				following === TokenType.KeywordFor
			)
		}
	}

	// How many `complete`s have been read inside the body being parsed and
	// not claimed by a body nested in it — which is all a Function needs to know
	// to say whether it is a COMPLETING body. Every body parse resets the count
	// and restores the enclosing one behind it, so a `complete` written in a
	// Function literal is counted by that literal and by nothing around it,
	// which is exactly where the language draws the line.
	//
	// A counter rather than a stack of frames, because the only question
	// asked of it is "was there one?" of the body being closed, and because a
	// single number is what `speculate` can save and restore — a reading that is
	// thrown away must leave no mark on the body it was attempted inside.
	private completesSeen = 0

	protected completingBody<T>(parse: () => T): {
		result: T
		completes: boolean
	} {
		let outer = this.completesSeen
		this.completesSeen = 0

		try {
			let result = parse()

			return { result, completes: this.completesSeen > 0 }
		} finally {
			this.completesSeen = outer
		}
	}

	// Reads a Function's body, which is never part of the test whose
	// body it was written in — every Function block goes through here so that
	// the one rule is stated in one place rather than at each of the four
	// spellings a Function has.
	protected outsideTestBody<T>(parse: () => T): T {
		let outerInsideTestBody = this.insideTestBody
		this.insideTestBody = false

		try {
			return parse()
		} finally {
			this.insideTestBody = outerInsideTestBody
		}
	}

	protected parseIdentifier(): parser.IdentifierNode {
		let token = this.peekOrFail("an Identifier")

		if (!isIdentifierToken(token)) {
			fail(
				`Expected an Identifier but found ${describeToken(token)}.`,
				token.position,
			)
		}

		this.tokens.next()

		return generators.identifier(token.value, token.position)
	}

	protected peekOrFail(expected?: string): Token {
		let token = this.tokens.peek()

		if (token === undefined) {
			fail(
				expected === undefined
					? "Unexpected end of input."
					: `Expected ${expected} but found end of input.`,
				this.tokens.endPosition(),
			)
		}

		return token
	}

	// The foreign lexeme standing at the cursor, joined back out of the
	// Tokens it was split into — `=` and `=` written flush are the `==` a reader
	// wrote, and `!` and `=` are their `!=`. Only ADJACENT Tokens are joined, and
	// only behind one whose whole value was taken: `+2` contributes its `+` and
	// stops there, so what is underlined is the operator and never the operand.
	//
	// Null where nothing at the cursor is made of these characters, which is the
	// answer for every Program that is not written in another language.
	//
	// `from` is how far ahead of the cursor to read, and everything but
	// `argumentIsLabelled` reads at the cursor itself. That one has to ask about
	// the Token BEHIND the one it is deciding, because what it decides is
	// whether the name in front of an operator is a label.
	protected foreignLexeme(from = 0): {
		text: string
		position: common.Position
		// Whether the first Token gave the whole of itself to the lexeme.
		// `+` did and `+2` did not, which is the difference between an operator
		// standing between two values and one written flush against its
		// operand — and the second is answered by the Enricher, which has the
		// operand in hand and can name it.
		whole: boolean
		// How many Tokens the lexeme was glued out of, so that a caller
		// can read what stands BEHIND it — the right operand of a compound
		// assignment, which `+=` hides two Tokens deep.
		tokens: number
	} | null {
		let first = this.tokens.peek(from)

		if (first === undefined) {
			return null
		}

		let lead = foreignTokenLead(first)

		if (lead === null) {
			return null
		}

		let text = lead
		let end = {
			line: first.position.start.line,
			column: first.position.start.column + lead.length,
		}
		let whole = lead.length === first.value.length
		let wholeFirst = whole
		let consumed = 1

		for (let offset = from + 1; whole; offset++) {
			let token = this.tokens.peek(offset)

			if (token === undefined || token.position.start.line !== end.line) {
				break
			}

			if (token.position.start.column !== end.column) {
				break
			}

			let next = foreignTokenLead(token)

			if (next === null) {
				break
			}

			text += next
			end = { line: end.line, column: end.column + next.length }
			whole = next.length === token.value.length
			consumed++
		}

		return {
			text,
			position: { start: first.position.start, end },
			whole: wholeFirst,
			tokens: consumed,
		}
	}

	// The verdict on the lexeme at the cursor: a habit with its own shape,
	// an operator this language deliberately has none of, or nothing at all.
	// Essence's own lexemes are answered `null` here rather than excluded Token by
	// Token, which is what keeps `match x -> T` and `<- value` whole while leaving
	// `a - b` and `a < b` refused.
	//
	// `left` is the Expression the operator was written BEHIND, where the
	// caller has read one. It is what a compound assignment's Help is spelled
	// out of — `tally += 5` is short for `tally = tally::add(5)`, and a Help
	// that names neither `tally` nor `5` sends a reader to two undeclared names
	// and an amount they never wrote.
	protected foreignTextAhead(
		left?: parser.ExpressionNode,
	): ForeignRefusal | null {
		let lexeme = this.foreignLexeme()

		if (lexeme === null || essenceLexemes.has(lexeme.text)) {
			return null
		}

		// `["kim" => 7]` — the one `=>` that is not a Function literal's
		// arrow. Answered before the table, which would hand a reader writing a
		// Dictionary a Function literal to write instead.
		if (
			lexeme.text === "=>" &&
			left !== undefined &&
			writtenDictionaryKey(left)
		) {
			return dictionaryEntryRefusal("=>", lexeme.position)
		}

		let syntax = foreignSyntaxRefusal(lexeme.text, lexeme.position)

		if (syntax !== null) {
			return syntax
		}

		let account = foreignOperatorAccount(lexeme.text)

		if (account === null) {
			return null
		}

		let target = left === undefined ? null : writtenReceiver(left)
		let compound =
			target === null
				? null
				: compoundAssignmentHelps(
						lexeme.text,
						target,
						this.writtenAssignedValue(lexeme.tokens),
					)

		return {
			...account,
			...(compound === null ? {} : { helps: [...compound] }),
			position: lexeme.position,
		}
	}

	// The verdict on the Token standing BEHIND the cursor — the same
	// question as `foreignTextAhead`, asked one Token early. Its two callers are
	// about to read the Token at the cursor as a NAME, and a name is never what
	// stands in front of one of these: `Terminal.print(total + tax)` read
	// `total` as an Argument's label, and `constant x = (a + b) * c` read `a` as
	// a Parameter's.
	//
	// The operator has to be the whole of the Token it opens. `+` between two
	// values is one, and the `+` of `+tax` is not: that one arrives glued to its
	// operand, and the Enricher answers it with the operand in hand and names
	// it.
	protected foreignTextFollowing(): ForeignRefusal | null {
		// Only an Identifier, and that is the whole of the narrowing. The
		// Symbols an operator is made of — `=`, `<`, `>`, `/`, `|` — begin no
		// Expression, so neither caller ever reached this question for one. A
		// `-` DOES begin one, and is left alone on purpose: `compute(offset -1)`
		// is a labelled Argument carrying a negative Number, and there is no
		// telling that from a subtraction without reading what follows the sign.
		if (this.tokens.peek(1)?.type !== TokenType.Identifier) {
			return null
		}

		let lexeme = this.foreignLexeme(1)

		if (
			lexeme === null ||
			!lexeme.whole ||
			essenceLexemes.has(lexeme.text)
		) {
			return null
		}

		let syntax = foreignSyntaxRefusal(lexeme.text, lexeme.position)

		if (syntax !== null) {
			return syntax
		}

		let account = foreignOperatorAccount(lexeme.text)

		return account === null
			? null
			: { ...account, position: lexeme.position }
	}

	// What stands after a `,` in a list — the next member, this list's own
	// closing bracket, which is the trailing comma a reader writes on purpose,
	// or a mistake. The mistake this answers is the third: a bracket that closes
	// SOMETHING ELSE, which says the list was never closed and that the bracket
	// standing here belongs to whatever holds it.
	//
	// The list's own opener is in hand here and nowhere the member readers can
	// reach, so without this the report came out of `parseIdentifier` — "Expected
	// an Identifier but found ')'", about a member nobody was writing, with no
	// word about the `{` it is short of. The same file WITHOUT the trailing comma
	// was answered "Expected '}' but found ')'" and the brace was named, because
	// the reader that closes the list is the one that met the `)`. The comma was
	// the whole difference.
	//
	// Only the brackets, and the end of the input. Everything else that can not
	// begin a member is text the member readers say more about than this could.
	protected refuseListContinuation(
		closing: lexer.TokenType,
		opening: Token,
	): void {
		let token = this.tokens.peek()

		if (
			token !== undefined &&
			(token.type === closing ||
				!closingBracketTokenTypes.has(token.type))
		) {
			return
		}

		this.tokens.failClosing(closing, opening)
	}

	protected refuseForeignText(refusal: ForeignRefusal): never {
		throw new ParseError(refusal.message, refusal.position, refusal.label, {
			code: refusal.code,
			notes: refusal.notes,
			helps: refusal.helps,
			data: refusal.data,
		})
	}

	// A reading kept wherever it parsed at all — the same text is often
	// read twice (a typed Record Literal, then a Record Literal), and the
	// first reading that holds together is the one that was written.
	protected backtrack<T>(parseAttempt: () => T): T | null {
		return this.speculate(parseAttempt, () => true)
	}

	// A speculation that is thrown away must leave nothing behind — not
	// the Tokens it read, not the Diagnostics it reported, which are about a
	// shape the Program was never in, and not the suppression latch an attempt
	// that ran to the end of the input left set: rewinding the Diagnostics
	// while the latch survived is how a broken file once parsed in silence.
	// Only the reading that is kept gets to report on the text.
	//
	// `keeps` is what a reading that SUCCEEDED is still judged by, asked with
	// the stream standing behind it: the Matcher of `require MATCHER = EXPR`
	// is told from an Expression by the `=` behind it and by nothing inside
	// it, so text that read as a Matcher was not necessarily written as one.
	//
	// A CODED refusal is not a failed reading — see `refusesTheText`. It
	// is a verdict about text that was written, and no other reading of that
	// text is going to ACCEPT it: `.5` is half a decimal wherever it stands.
	// The readings a speculation would hand it back to either refuse it in the
	// same words, as every one that reads its member values with the Expression
	// parser does, or fail on it in worse ones — a Record Matcher reads its
	// member values as written literals, and a `.` is no literal at all, so it
	// says only "Expected a literal value". So a coded refusal is re-raised to
	// the Statement loop that reports it, instead of being given back for a
	// second reading to answer for it: `{ x = .5 }` used to be answered with
	// "Expected 'with' but found '='".
	//
	// What the re-raise leaves behind is the mirror of what a rewind leaves:
	//
	//   - The Tokens stay where the refusal stood. A refusal site reads what it
	//     is refusing before it throws — the digits behind a `.`, the fraction
	//     behind a `1.5/`, the `::` behind a member path — on purpose, so that
	//     no tail of it is read again as a Statement of its own. Rewinding to
	//     the start of the speculation would hand that tail back to
	//     resynchronisation.
	//
	//     Those are the refusals that reach here at all. Of the rest,
	//     `nesting-too-deep` is given back by name, being about the reading
	//     rather than about the text, and every other one is raised in a
	//     Statement position — a Matcher behind an `is`, a snapshot behind a
	//     Matcher, a `test` outside a tests section — where the Statement loop
	//     it stands in reports and resynchronises it before any enclosing
	//     speculation hears of it.
	//   - The suppression latch is RESTORED, which is what a rewind does and
	//     the whole of what this has to do: a re-raise leaves the state a
	//     rewind leaves, the Tokens excepted. The attempt can not have set it —
	//     the latch goes up where the input has ENDED, and every coded refusal
	//     peeks a Token before it throws — so this is the mirror of the line
	//     below rather than a hazard of its own. Restored, it still holds
	//     wherever it was already set before the speculation: there the refusal
	//     is a cascade of a Diagnostic that has been reported.
	//   - The Diagnostics are REWOUND. What the abandoned reading reported on
	//     the way to the refusal is still about a shape the Program was never
	//     in, and the Statement holding them is dropped whole. The refusal
	//     itself travels in the ParseError rather than in the collection, so
	//     it is untouched by this — leaving exactly one Diagnostic for it.
	protected speculate<T>(
		parseAttempt: () => T,
		keeps: () => boolean,
	): T | null {
		let saved = this.tokens.save()
		let savedSuppressDiagnostics = this.suppressDiagnostics
		// And the `complete` count with them, for the reason the
		// Diagnostics are rewound: a reading that is thrown away must not leave
		// the body around it marked as completing on the strength of a word it
		// read in a shape the Program was never in.
		let savedCompletesSeen = this.completesSeen
		let diagnosticMark = markDiagnostics()
		let depth = this.speculationDepth

		this.speculationDepth = depth + 1

		try {
			let result = parseAttempt()

			if (keeps()) {
				// A reading that HELD answers for the readings tried
				// beside it — they were about text this one has now spanned —
				// and for every group speculated inside it, which resolved on
				// the way.
				this.forgetFailuresFrom(depth)

				return result
			}
		} catch (error) {
			if (!(error instanceof ParseError)) {
				throw error
			}

			if (refusesTheText(error)) {
				// A REPORTED refusal keeps both, which is the one place
				// the two paragraphs above do not hold. Its account travels in
				// the Diagnostic collection rather than in the ParseError —
				// the loop that made it recovered and read on, so there was
				// nothing left to throw — and rewinding would leave the
				// Statement dropped with nothing said about why. It is also
				// the one refusal that does NOT peek a Token before it throws,
				// so the latch may be one the attempt itself set over an input
				// that has ended, and restoring it would ask every enclosing
				// block to report a cascade of that.
				if (error.reported) {
					throw error
				}

				this.suppressDiagnostics = savedSuppressDiagnostics
				this.completesSeen = savedCompletesSeen
				rewindDiagnostics(diagnosticMark)

				throw error
			}

			// Recorded BEFORE the rewind below, which is the only moment
			// the stream still stands where this reading stopped. A reading
			// that `keeps` turned down is not recorded — it read the text to
			// its end, and what it failed is a test of the text AROUND it.
			this.noteFurthestFailure(error, depth)
		} finally {
			this.speculationDepth = depth
		}

		this.tokens.restore(saved)
		this.suppressDiagnostics = savedSuppressDiagnostics
		this.completesSeen = savedCompletesSeen
		rewindDiagnostics(diagnosticMark)

		return null
	}

	// Kept where it got further than whatever stands here already. Ties go
	// to the reading tried FIRST, which is the order the alternatives are
	// written in — a Record Literal before a Record update, an Argument's
	// Expression before its label — and that order is itself a judgement about
	// which reading the text is likelier to have been written as.
	//
	// A `nesting-too-deep` is kept like any other, though `rewoundCodes`
	// gives it back for a reason — an attempt recurs a level deeper than the
	// reading it stands in for, so it can exhaust the budget where the reading
	// that is kept fits inside it, and RE-RAISING it would refuse a Program this
	// Parser accepts. Recording it refuses nothing: a reading that holds clears
	// the record on its way out, so only a Statement that is being dropped
	// anyway can ever be answered with one. And for that Statement it is the
	// true account — `{ x = <a thousand brackets> }` is text that really is
	// nested too deeply, and leaving it out answered that with "Expected 'with'"
	// at the first member, which is the very thing this mechanism is here to
	// stop.
	private noteFurthestFailure(error: ParseError, depth: number): void {
		let offset = this.tokens.offset

		if (
			this.furthestFailure !== null &&
			offset <= this.furthestFailureOffset
		) {
			return
		}

		this.furthestFailure = error
		this.furthestFailureOffset = offset
		this.furthestFailureDepth = depth
	}

	// Forgets a recorded failure once nothing is left that it could be an
	// alternative READING of — either because a sibling reading held, or because
	// the Statement loop has moved on to the next element. `depth` is the level
	// that has resolved: a failure recorded AT it was a reading of the text that
	// is now settled, one recorded INSIDE it belongs to a group that resolved on
	// the way, and one recorded outside it is still a live alternative of the
	// construction this text stands in.
	private forgetFailuresFrom(depth: number): void {
		if (
			this.furthestFailure !== null &&
			this.furthestFailureDepth >= depth
		) {
			this.furthestFailure = null
		}
	}

	// #endregion
}

export type ParseResult = {
	program: parser.Program
	diagnostics: Array<common.Diagnostic>
}

// Parse errors are reported as Diagnostics rather than thrown — the
// parser recovers and always produces a Program (broken Statements are
// dropped). `parseWithDiagnostics` is the full form the compiler driver
// uses; `parse` is the convenience form for callers that only need the AST.
export function parseWithDiagnostics(
	chunk: string,
	options?: ParserOptions,
): ParseResult {
	let { result, diagnostics } = collectDiagnostics(() =>
		new DescentParser(chunk, options).parseProgram(),
	)

	return { program: result, diagnostics: inSourceOrder(diagnostics) }
}

export function parse(chunk: string, options?: ParserOptions): parser.Program {
	return parseWithDiagnostics(chunk, options).program
}

// A bare run of Statements rather than a Program — what an `@example`
// block holds. It is parsed from a text the caller built, in which every line
// but the example's own is blank and each of the example's stands at the column
// it stands at in the file: so every Position the parse produces is the
// Position it has in the source, and a Diagnostic about an example underlines
// the `§§` line it was written on.
//
// `insideTestBody` is set, because what an example holds IS a test body — an
// example that asserts nothing proves nothing, and `expect` is how it does.
export function parseTestBody(
	chunk: string,
	options: ParserOptions = {},
): {
	body: Array<parser.ImplementationNode>
	diagnostics: Array<common.Diagnostic>
} {
	let { result, diagnostics } = collectDiagnostics(() => {
		let parser = new DescentParser(chunk, {
			...options,
			insideTestBody: true,
		})

		return parser.parseStatements()
	})

	return { body: result, diagnostics }
}
