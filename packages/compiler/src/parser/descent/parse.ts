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
import * as generators from "../nodeGenerators"
import { readGroup, wrapsAValue } from "./groupingParentheses"
import {
	type MisplacedDefault,
	reportMisplacedDefault,
} from "./misplacedDefaults"
import {
	expressionExpected,
	parameterLabel,
	reportRedundantLabel,
} from "./parameterNames"
import {
	refusedMatcherAfterValue,
	refusedMatcherOnExpect,
	refusedSnapshotAfterMatcher,
	refusedTestItem,
	writtenText,
} from "./testsRefusals"
import {
	describeToken,
	fail,
	ParseError,
	refusesTheText,
	TokenStream,
	type TokenStreamState,
} from "./tokenStream"
import { reportTrailingTokens } from "./trailingTokens"

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

// The Keywords that open a Statement, where recovery resynchronises.
// See "Error recovery" in DEVELOPMENT.md.
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
	// Whether a Function body being read has a Parameter that binds no name,
	// its own or an enclosing Function's. See `expressionExpected`.
	protected namelessParameter = false
	// Whether the Statement being read stands in a test's own body. A
	// Function body inside clears it, and a `suite` body, which is setup,
	// never sets it.
	protected insideTestBody = false
	// Whether the Statement being read stands anywhere in the tests section,
	// a Function body or a block written there included.
	protected insideTestsSection = false
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

			this.reportTrailingTokens(below, tests, null)

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

		this.reportTrailingTokens(below, tests, closingPosition)

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

	// Reports whatever is left once every section has been read. `closing` is
	// the implementation's `}`, null for a file of tests alone.
	protected reportTrailingTokens(
		below: Array<ModuleSectionRead>,
		tests: { position: common.Position } | null,
		closing: common.Position | null,
	): void {
		if (!this.suppressDiagnostics) {
			reportTrailingTokens(
				this.tokens.between(this.tokens.save().index, Infinity),
				{
					lastSection: below[below.length - 1]?.node.position ?? null,
					tests: tests?.position ?? null,
					implementation: closing,
				},
			)
		}
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
	// wrong side is reported and kept, unless one of its kind stands on the
	// right side. What it names is then not reported again. A
	// `declarations { … }` Program keeps its sections like any other.
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
			let isImport = section.node.nodeType === "ImportSection"
			let placed = section.side === (isImport ? "above" : "below")

			if (!placed) {
				this.reportMisplacedSection(section, implementationPosition)
			}

			if (section.node.nodeType === "ImportSection") {
				imports = placed ? section.node : (imports ?? section.node)
			} else {
				exports = placed ? section.node : (exports ?? section.node)
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
				// the Diagnostic underlines the Keyword.
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

		let nodes = this.withinTestsSection(() =>
			this.parseStatementList(() => this.parseTestsNode()),
		)
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
	// suite, or any Statement an implementation block takes.
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
		this.resynchronise(startState)

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

	// Skips to the next place a Statement can begin at the brace depth the
	// broken element started on, skipping braces the element opened.
	// See "Error recovery" in DEVELOPMENT.md.
	protected resynchronise(startState: TokenStreamState): void {
		while (true) {
			let token = this.tokens.peek()

			if (token === undefined) {
				// At the end of the input every further error is a cascade.
				this.suppressDiagnostics = true

				return
			}

			if (
				this.tokens.depth <= startState.braceDepth &&
				(token.type === TokenType.SymbolRightBrace ||
					this.isStatementStart(token, startState.index))
			) {
				return
			}

			this.tokens.next()
		}
	}

	// Whether `token` begins a Statement, for a skip from the broken element
	// at `from`. A name counts only where it opens a line below that element,
	// indented no further. See "Error recovery" in DEVELOPMENT.md.
	protected isStatementStart(token: Token, from: number): boolean {
		return (
			statementStartTokenTypes.has(token.type) ||
			(isIdentifierToken(token) &&
				!standsAfterExpression(token) &&
				this.tokens.resumesAtName(from)) ||
			(token.type === TokenType.SymbolLeftAngle &&
				this.tokens.peek(1)?.type === TokenType.SymbolDash)
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
				helps: [this.tokens.missingBracesHelp()],
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

			throw refusedTestItem(
				token,
				this.insideTestBody
					? "test-body"
					: this.insideTestsSection
						? "block"
						: "outside",
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
	// it does not begin a Statement of its own.
	protected parseOptionalRefinementPredicate(
		type: parser.TypeDeclarationNode,
	): parser.ExpressionNode | null {
		let token = this.tokens.peek()

		if (token?.type !== TokenType.Identifier || token.value !== "where") {
			return null
		}

		if (
			token.position.start.line !== type.position.end.line &&
			this.tokens.beginsOwnStatement()
		) {
			return null
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

		// A provided body binds a Pattern's names as any Method body does.
		if (body === null) {
			this.refusePatternParameters(
				parameterList.parameters,
				"Protocol requirement",
			)
		}

		this.refuseDefaultValues(
			parameterList.parameters,
			body === null ? "Protocol requirement" : "provided Method",
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

			this.refuseMatcherOnExpect(keyword, matcher, value)
			this.refuseUnusableMatcher(matcher, value)

			let matches = this.tokens.peek()

			if (
				matches?.type === TokenType.Identifier &&
				matches.value === MATCHES
			) {
				this.refuseSnapshotAfterMatcher(matcher, value)
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
			this.refuseMatcherAfterValue(keyword, following, value)
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
		value: parser.ExpressionNode,
	): void {
		if (keyword.type !== TokenType.KeywordExpect) {
			return
		}

		throw refusedMatcherOnExpect(this.sourceLines, matcher, value)
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
	protected refuseMatcherAfterValue(
		keyword: Token,
		is: Token,
		value: parser.ExpressionNode,
	): never {
		this.tokens.next()

		let matcher = this.parseMatcher(true)

		throw refusedMatcherAfterValue(this.sourceLines, keyword, is, {
			matcher,
			value,
		})
	}

	// `require MATCHER = EXPR matches snapshot`, refused after the snapshot is
	// read: this line took a value apart rather than holding one.
	protected refuseSnapshotAfterMatcher(
		matcher: parser.MatcherNode,
		value: parser.ExpressionNode,
	): never {
		let snapshot = this.parseSnapshot()

		throw refusedSnapshotAfterMatcher(this.sourceLines, snapshot, {
			matcher,
			value,
		})
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

		// Another language's habit at the head of an Expression, such as a `//`.
		// Asked only of Tokens that open no Expression, since `-` and `<` do.
		if (!startsExpression(token)) {
			let foreign = this.foreignTextAhead()

			if (foreign !== null) {
				this.refuseForeignText(foreign)
			}
		}

		// `ChoiceName#CaseName`, with the `#` flush. With a space, as in
		// `label #Case`, the name is an Argument's label before a bare Case.
		let following = this.tokens.peek(1)

		if (
			isIdentifierToken(token) &&
			following?.type === TokenType.SymbolHash &&
			token.position.end.line === following.position.start.line &&
			token.position.end.column === following.position.start.column
		) {
			return this.parseCaseValue()
		}

		// `Holder<Integer>#Full(…)`, speculative, since only the `#` after the
		// Type Arguments makes it a construction.
		if (
			isIdentifierToken(token) &&
			following?.type === TokenType.SymbolLeftAngle
		) {
			let applied = this.backtrack(() => this.parseCaseValue())

			if (applied !== null) {
				return applied
			}
		}

		// `Type ~> { … }`, speculative, since only the `~>` tells a Type from an
		// Identifier. It is tried only where a `~` stands ahead.
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
			case TokenType.SymbolLeftParen:
				return this.parseParenthesised()
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
				throw expressionExpected(this.tokens, this.namelessParameter)
		}
	}

	// The one Function literal whose annotations may be omitted, since an
	// expected signature can supply them. A `(` that can only wrap a value is
	// refused and read past. See "Grouping parentheses" in DEVELOPMENT.md.
	protected parseParenthesised(): parser.ExpressionNode {
		let grouped = wrapsAValue(this.tokens)
			? this.backtrack(() =>
					readGroup(this.tokens, () => this.parseExpression()),
				)
			: null

		if (grouped !== null) {
			return grouped
		}

		let literal = this.parseFunctionLiteral(true, false)

		this.refuseDefaultValues(literal.value.parameters, "Function literal")

		return literal
	}

	// `start x` and `complete x`. The operand takes the whole postfix chain,
	// so `complete headline(url)::retried(times 3)` completes the retried
	// future. A Method on the answer needs the answer bound first.
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

		// Only `complete` makes the body around it completing; `start` never
		// waits.
		this.completesSeen += 1

		return generators.complete(expression, position)
	}

	// `.price` or `.address.city`, read whole here so the postfix loop does not
	// read a later step as a Lookup over the path.
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

	// A path is a Function that reads members, so a call on it is refused here
	// rather than built by the postfix loop.
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
				// The untyped literal only in an Argument list, where a
				// literal reads its Types. Elsewhere the Help spells the Types
				// as holes.
				helps: [
					this.insideArgumentList
						? `Write the Function literal instead: '${this.pathFunctionLiteral(steps, spelling)}'.`
						: `Write the Function literal instead, with the Parameter and return Types a path leaves out — '${this.pathFunctionLiteral(steps, spelling, true)}', filling each '<Type>' in.`,
				],
			},
		)
	}

	// The path and its call spelled back as a Function literal over a
	// Parameter `item`, untyped where an Argument list supplies the Type.
	protected pathFunctionLiteral(
		steps: Array<parser.IdentifierNode>,
		spelling: string,
		// Writes the two Types as holes.
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

	// The Argument list at `at` spelled back where it is empty or one Token,
	// such as `(2)`, and `(…)` otherwise.
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

	// A Case value, with or without its Choice. The payload parentheses are read
	// here rather than by the postfix loop, since a Case is not a Function.
	protected parseCaseValue(): parser.CaseValueNode {
		let choice: parser.IdentifierNode | null = null
		let typeArguments: Array<parser.TypeDeclarationNode> | null = null
		let hash: Token

		if (this.tokens.peek()?.type === TokenType.SymbolHash) {
			hash = this.tokens.next()
		} else {
			choice = this.parseIdentifier()

			// `Holder<Integer>#Full(…)`: Type Arguments applied at the value, on
			// the Choice's line, as an annotation writes them.
			let leftAngleToken = this.tokens.peek()

			if (
				leftAngleToken?.type === TokenType.SymbolLeftAngle &&
				leftAngleToken.position.start.line === choice.position.end.line
			) {
				let argumentList = this.parseTypeArgumentList()
				let hashToken = this.tokens.peek()

				// The `#` must stand on the closing `>`'s line, as the bare form
				// needs its `#` flush against the name.
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

			// A Case carries one value, so a comma is refused, even a trailing
			// one. The refusal is coded so it survives the speculation that reads
			// `Optional<Integer>#Value(…)`.
			let comma = this.tokens.peek()

			if (comma?.type === TokenType.SymbolComma) {
				// The Helps differ: a trailing comma is removed, and a second value
				// is carried in one Record.
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

	// `define { as VALUE if CONDITION … as VALUE otherwise }`.
	// See "Define" in DEVELOPMENT.md.
	protected parseDefine(): parser.DefineNode {
		let keyword = this.tokens.expect(TokenType.KeywordDefine)
		let returnType = this.parseOptionalReturnType(true)

		this.enterNesting()

		try {
			let leftBrace = this.tokens.expect(TokenType.SymbolLeftBrace)
			let { arms, otherwise, recovered } = this.parseDefineArms()
			// Asked of the Token, since `parseClosingBrace` answers with a
			// Position even where the input ended inside the block.
			let closed = this.tokens.peek()?.type === TokenType.SymbolRightBrace
			let closingPosition = this.parseClosingBrace(leftBrace.position)
			let position = {
				start: keyword.position.start,
				end: closingPosition.end,
			}

			// After a recovery an `otherwise` arm may stand in skipped text, so
			// the Statement is dropped without a second report.
			if (otherwise === null && (recovered || !closed)) {
				throw new ParseError(
					"This 'define' could not be read to its end",
					position,
					null,
					{ reported: true },
				)
			}

			// Without an `otherwise` arm a `define` has nothing to answer with.
			// See "Define" in DEVELOPMENT.md.
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

	// The arm loop, with recovery to the next `as`. See "Define" in
	// DEVELOPMENT.md.
	protected parseDefineArms(): {
		arms: Array<parser.DefineArmNode>
		otherwise: parser.DefineOtherwiseNode | null
		recovered: boolean
	} {
		let arms: Array<parser.DefineArmNode> = []
		let otherwise: parser.DefineOtherwiseNode | null = null
		// Whether any arm was recovered from.
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

			// Per arm, as `parseStatementList` does per element.
			this.forgetFailuresFrom(this.speculationDepth)

			try {
				let keyword = this.tokens.expect(TokenType.KeywordAs)

				// An arm after the `otherwise` arm is reported and never
				// recorded, so the `otherwise` arm stays last.
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
				// A coded refusal is raised to the Statement loop, as a
				// speculation raises one.
				if (error instanceof ParseError && refusesTheText(error)) {
					throw error
				}

				this.recoverFromDefineArm(error, startState)
				recovered = true
			}
		}

		return { arms, otherwise, recovered }
	}

	// Reports an arm after the `otherwise` arm, which is then dropped rather
	// than thrown. See "Define" in DEVELOPMENT.md.
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

		// An arm that read nothing has nothing to skip, and only its first
		// Token is dropped.
		if (this.tokens.save().index !== startState.index) {
			this.resynchroniseToArm(startState.braceDepth)
		}

		// Guarantee progress, as `recoverFromError` does.
		if (
			this.tokens.save().index === startState.index &&
			!this.tokens.isAtEnd()
		) {
			this.tokens.next()
		}

		// A broken arm is abandoned text, like a dropped Statement.
		this.recordAbandoned(startState.index)
	}

	// Skips to the next `as` or the `define`'s `}` at the broken arm's brace
	// depth.
	protected resynchroniseToArm(targetDepth: number): void {
		while (true) {
			let token = this.tokens.peek()

			if (token === undefined) {
				// At the end of the input every further error is a cascade.
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

	// `_` is a wildcard only in Matcher position; elsewhere it marks an
	// unlabelled Parameter. `allowsWholeValueBinder` is false in a Match
	// Handler, where `@` already names the narrowed value.
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

		// A Record in Matcher position is a Pattern, which admits `name = value`
		// and binding members as well as `name: Type`.
		if (token?.type === TokenType.SymbolLeftBrace) {
			return this.parsePattern(allowsWholeValueBinder)
		}

		// `case #Add` resolves against the matched value's Union, and
		// `case CalculatorOperation#Add` names the Choice. Either may bind a
		// payload.
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

	// The payload binder of a Case Matcher: a name or a Pattern in
	// parentheses, as in `case #Rectangle({ width, height })`. Braces would
	// open the arm's block, so `case #Add { left = 0 }` stays a block.
	protected parseCaseMatcherBinding(): {
		node: parser.IdentifierNode | parser.PatternNode
		// The closing parenthesis, which ends the Matcher's span.
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

	// `name` binds the member, `name: Type` also constrains its Type, and
	// `name = value` constrains the value and binds nothing.
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

	// `as` binds a member under another name or a nested Pattern. It is a
	// binder only when a name or `{` follows, so `{ as as as }` binds a member
	// called `as` under that name.
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

	// `} as name`: one name for the whole value, alongside its members' names.
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

		// Reported and dropped rather than thrown, so the arm still parses.
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
				// Both edits, since rewriting the body alone leaves the binder.
				helps: [
					`Drop the 'as ${name.content}' and write '@' where '${name.content}' was meant.`,
				],
			},
		)

		// Recorded as abandoned, so the body's reads of the name are not
		// reported as undeclared. See "Abandoned Statements" in DEVELOPMENT.md.
		this.recordAbandonedDeclaration(name.content, name.position, false)

		return null
	}

	// Whether the `as` at the cursor opens a binder rather than being a name.
	protected binderFollows(): boolean {
		if (this.tokens.peek()?.type !== TokenType.KeywordAs) {
			return false
		}

		let next = this.tokens.peek(1)

		return (
			isIdentifierToken(next) || next?.type === TokenType.SymbolLeftBrace
		)
	}

	// A Matcher compares against a written literal only: `size = expected`
	// does not read a Constant `expected`.
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
			// An interpolated String's holes are evaluated, so it is no fixed
			// value to compare against.
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

	// `where` is recognised by content, since it is also an Argument label. A
	// Matcher is otherwise always followed by the Handler's `{`.
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

		// `{ "a" = 1 }`: a Dictionary in a Record's braces. Only a written value
		// is refused, since `{ x = ] }` also arrives here with a broken member.
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
				// The value being updated, for the key readers' Helps. Saved
				// and restored, since updates nest.
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

		// Speculated, so the key list can be read once more if it fails. A bare
		// name reads as an Expression first, so `{ base with other }` merges a
		// whole value.
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

		// Neither reading spans `{ base with port, host }`. Reading the keys
		// once more with shorthand keeps the update. The Enricher reports each
		// bare name, since only the Scope says whether it is a binding.
		let shorthandCombination = combinationOfKeys(true)

		if (shorthandCombination !== null) {
			return shorthandCombination
		}

		let rhs = this.parseExpression()

		// `{ ages with "alex" = 40 }`: a Dictionary update in a Record's braces.
		// See "Record literals and updates" in DEVELOPMENT.md.
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

	// `allowShorthand` belongs to the braces: a Record literal takes `{ x }`,
	// an update's key list does not. `opening` is the `{` the list stands in.
	// See "Record literals and updates" in DEVELOPMENT.md.
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

		// `{ x: 0 }`: another language's member separator. A Record Type and a
		// Pattern read their `:` elsewhere, so here it spells nothing.
		let colon = this.tokens.peek()

		if (colon?.type === TokenType.SymbolColon) {
			// The fix writes ' = ' from the name to the value, where the value
			// is on the same line, since a `:` stands flush against its name.
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

		// The value is a Node of its own at the name's Position, which the
		// rename index carries alongside the name.
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

	// The steps after a key's first Identifier, or null for a plain name. A
	// `{` after a dot opens a braced descend, which ends the key.
	// See "Record literals and updates" in DEVELOPMENT.md.
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

	// `server.{ port = 1, host }`: an update's member list one level down,
	// where shorthand is allowed.
	protected parseKeyGroup(
		steps: Array<parser.IdentifierNode>,
	): parser.RecordValueNode {
		// Counted, since nested descends recur through the key list rather
		// than through an Expression.
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

	// Reported rather than thrown, since an empty descend is half-written and
	// the rest of the list still reads.
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
			// Dropping the only key drops the update, so the Help names the
			// value written on its own.
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

	// A path key always spells its value. A bare path is kept under its last
	// step's name for the Enricher to report, since only the Scope knows that
	// name. Otherwise the `=` is expected, and its failure lets
	// `{ config.server with … }` read as an update.
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

	// Two keys clash when they are the same, or one is a prefix of the other
	// at a dot, as `server` and `server.port` are.
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
					// The second writing is the one to remove.
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

	// The Lexer has split the String into chunk Tokens with each hole's Tokens
	// between them, so this alternates chunks and Expressions. Positions are
	// absolute, since the holes are no separate parse.
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

			// Reached where a hole holds more than one Expression, as `{a b}`
			// does.
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

		// `1/2` is one Rational Literal only when the three Tokens are flush.
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

	// `0.75` is one Rational Literal when the Integer, the `.` and the digits
	// are flush; `1.foo` still reads a member. A decimal is only a spelling, so
	// `1.50` is `150/100`. Null where no decimal follows.
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
			// A flush Identifier after the point is a Lookup. Anything else is
			// half a decimal, such as `1.` or `1. 5`.
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

	// `1.5/2` and `1/2.5`: a Rational written both ways at once, refused once
	// its tail is read.
	protected refuseMixedRational(
		literal: common.Position,
		symbolType: lexer.TokenType,
		label: string,
		// The Literal as written, so the Help can spell the value it means.
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
		// The value as a fraction, then as a decimal where one terminates.
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

	// `.5`: a decimal missing its whole part, which arrives as a member path.
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

	// Names the operand in the Help only where it is the whole of what is
	// negated. `- tree::hasItems()` negates a call, not `tree`.
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

			// `-price`: a `-` only signs a Number Literal, so a name after it is
			// another language's prefix operator.
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

	// The digits of one Number, `_` groups joined, without a sign, since a
	// decimal's fraction takes none.
	protected parseDigitRun(): { value: string; position: common.Position } {
		let firstPart = this.tokens.expect(TokenType.LiteralNumber)

		let value = firstPart.value
		let lastPart = firstPart

		// `1_000` is one Number only when its Tokens are flush.
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

	// A List, a Dictionary or a Dictionary update, settled by the Token after
	// the first Expression: `=` makes it a key, `with` a base. Nothing is read
	// twice. `[]` is the empty List and `[=]` the empty Dictionary.
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

		// A List from here on, but a separator such as the `:` of `["a": 1]`
		// says the brackets were meant to hold entries.
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

	// `[1 = 2 = 3]`: a second `=` where a comma belongs, reported at the `=`
	// rather than as an unclosed bracket.
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

	// The rest of a Dictionary Literal after its first key. A trailing comma
	// is allowed, as in a List. `opening` is the `[` the entries stand in.
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

	// The `= value` half of an entry, with the key already read.
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

	// The near misses of an entry: `["a": 1]`, `["a" -> 1]` and
	// `["a" = 1, "b"]`. A written separator is named; otherwise the key without
	// a value is underlined.
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

	// `[ages with "kim" = 7]` sets entries and `[ages with other]` merges a
	// Dictionary, told apart by an `=` after the first Expression. There is no
	// shorthand. See "Record literals and updates" in DEVELOPMENT.md.
	protected parseDictionaryUpdate(
		leftBracket: Token,
		base: parser.ExpressionNode,
	): parser.CombinationNode {
		let withKeyword = this.tokens.expect(TokenType.KeywordWith)

		if (this.tokens.peek()?.type === TokenType.SymbolRightBracket) {
			// The label ends at the `with`, since the `]` is not at fault.
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
			// The key list spans only the keys, as a braced update's does.
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

		// `[d with a, b]`: bare names as keys. The comma says a key list was
		// meant, so the report explains that a key is a value.
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

	// `ownsDocumentation` is false for a literal in Expression position, which
	// declares nothing. `documentationHere` is keyed by line, so such a literal
	// would claim the block of the Declaration on its line.
	protected parseFunctionLiteral(
		allowsInferredTypes = false,
		ownsDocumentation = true,
	): parser.FunctionValueNode {
		let documentation = ownsDocumentation ? this.documentationHere() : null
		let parameterList = this.parseParameterList(allowsInferredTypes)
		let returnType = this.parseOptionalReturnType(allowsInferredTypes)
		let { result: block, completes } = this.parseFunctionBody(
			parameterList.parameters,
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

	protected parseFunctionBody(parameters: Array<parser.ParameterNode>) {
		let outer = this.namelessParameter

		this.namelessParameter ||= parameters.some(
			(parameter) => parameter.internalName === null,
		)

		try {
			return this.completingBody(() =>
				this.outsideTestBody(() => this.parseBlock()),
			)
		} finally {
			this.namelessParameter = outer
		}
	}

	protected parseGenericFunctionLiteral(
		ownsDocumentation = true,
	): parser.FunctionValueNode {
		let documentation = ownsDocumentation ? this.documentationHere() : null
		let genericList = this.parseGenericList()
		let parameterList = this.parseParameterList()
		let returnType = this.parseReturnType()
		let { result: block, completes } = this.parseFunctionBody(
			parameterList.parameters,
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

	// Named Functions and Methods take an optional Generic list before their
	// Parameter list.
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

	// The same list with the span of its `<…>`, or null where none was
	// written. See `FunctionDefinitionNode.genericListPosition`.
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
		// `infer` is the modifier only where a name follows, so `<infer>`
		// declares a Generic named `infer`.
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

		// A contextual `is` bounds the Type Parameter by a Protocol, as in
		// `<infer Item is Comparable>`.
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
		let leftParen = this.tokens.openParameterList(allowsInferredTypes)

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

	// The `§§` block on the lines just before the next Token.
	protected documentationHere(): common.Documentation | null {
		let token = this.tokens.peek()

		if (token === undefined) {
			return null
		}

		return this.tokens.documentationAbove(token.position.start.line)
	}

	// `allowsInferredTypes` is set only for a Function literal in Expression
	// position, where an expected signature supplies omitted annotations. A
	// default value, `= expression`, is attached last and leaves `position` alone.
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

	protected parseParameterHead(
		allowsInferredTypes = false,
	): parser.ParameterNode {
		// Only a Parameter on a line of its own carries Documentation, so the
		// first Parameter of `function greet (…)` leaves the Function's alone.
		let documentation = this.tokens.startsLine()
			? this.documentationHere()
			: null

		let annotationFollows = () =>
			this.tokens.peek()?.type === TokenType.SymbolColon

		// `(a + b) * c`: grouping parentheses read as a Parameter list. The `+`
		// is refused where it stands. See `operatorNote`.
		let following = this.foreignTextFollowing()

		if (following !== null) {
			this.refuseForeignText(following)
		}

		// A Pattern with no label, which takes its Type and label from the
		// expected signature.
		if (this.tokens.peek()?.type === TokenType.SymbolLeftBrace) {
			return this.parsePatternParameter(null, null, documentation)
		}

		if (this.tokens.peek()?.type === TokenType.SymbolUnderscore) {
			let underscore = this.tokens.next()

			// `_ { … }`: the unlabelled Pattern Parameter written out.
			if (this.tokens.peek()?.type === TokenType.SymbolLeftBrace) {
				return this.parsePatternParameter(
					null,
					underscore.position,
					documentation,
				)
			}

			// `_: Type` has neither label nor name, while `_ name: Type` has no
			// label.
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

			// A bare `_` binds no name and takes its Type from the expected
			// signature.
			if (allowsInferredTypes && !isIdentifierToken(this.tokens.peek())) {
				return generators.parameter(
					null,
					null,
					null,
					underscore.position,
					documentation,
				)
			}

			let internalName = this.parseIdentifier()

			// `_ name`, with the Type left to the expected signature.
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

		// `of { width, height }: Rectangle`: a label, then a Pattern where the
		// internal name goes.
		if (this.tokens.peek()?.type === TokenType.SymbolLeftBrace) {
			return this.parsePatternParameter(
				parameterLabel(name),
				null,
				documentation,
			)
		}

		let binder = this.tokens.peek()

		// `on _: Integer` is a label that binds no name.
		if (
			binder !== undefined &&
			(isIdentifierToken(binder) ||
				binder.type === TokenType.SymbolUnderscore)
		) {
			let internalName = isIdentifierToken(binder)
				? this.parseIdentifier()
				: (this.tokens.next(), null)

			// An unannotated Parameter takes its label from the expected
			// signature, so a written label is reported and dropped.
			if (allowsInferredTypes && !annotationFollows()) {
				let labelPosition = {
					start: name.position.start,
					end: binder.position.end,
				}

				reportRedundantLabel(
					labelPosition,
					internalName?.content ?? "_",
				)

				return generators.parameter(
					null,
					internalName,
					null,
					labelPosition,
					documentation,
				)
			}

			this.tokens.expect(TokenType.SymbolColon)

			let type = this.parseType()

			return generators.parameter(
				parameterLabel(name),
				internalName,
				type,
				{ start: name.position.start, end: type.position.end },
				documentation,
			)
		}

		// A bare `item` takes its Type and label from the expected signature,
		// so no label is recorded.
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
			parameterLabel(name),
			name,
			type,
			{ start: name.position.start, end: type.position.end },
			documentation,
		)
	}

	// The tail of a Pattern Parameter: `({ … })`, `(_ { … }: Type)` or
	// `(label { … }: Type)`. The annotation is optional where inferred Types are.
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

	// A signature without a body has nowhere to read a Pattern's bindings.
	// Refused here, since the Parameter is well-formed and only misplaced.
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

	// Refuses a default where it could never apply, and drops it once reported.
	protected refuseDefaultValues(
		parameters: Array<parser.ParameterNode>,
		place: MisplacedDefault,
	): void {
		for (let parameter of parameters) {
			if (parameter.defaultValue !== null) {
				reportMisplacedDefault(parameter.defaultValue.position, place)

				parameter.defaultValue = null
			}
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

	// Whether `label value` stands here, read off the Token after the leading
	// Identifier rather than by speculation. See "Argument labels" in
	// DEVELOPMENT.md.
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

		// A label never stands before another language's operator, as in
		// `total + tax`.
		if (this.foreignTextFollowing() !== null) {
			return false
		}

		// '#', '.' and '[' continue the Identifier when flush, and open a value
		// of their own after a space.
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

			// The Expression reading first, then the labelled one. See
			// "Argument labels" in DEVELOPMENT.md.
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

	// `|` binds loosest: `List<Item> | String` is a Union of an application
	// and `String`. Inside angle brackets, `List<Item | String>`, it is an
	// Argument.
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

		// A `<` applies the Type only on the Type's own line. On the next line it
		// may open an `overload` entry's `<infer …>` list.
		if (
			leftAngleToken?.type === TokenType.SymbolLeftAngle &&
			leftAngleToken.position.start.line === baseType.position.end.line
		) {
			let { typeArguments, position } = this.parseTypeArgumentList()

			// The Node spans `List<Item>`, from the base Type.
			return generators.genericTypeDeclaration(baseType, typeArguments, {
				start: baseType.position.start,
				end: position.end,
			})
		}

		return baseType
	}

	// `<Integer, String>`: the Arguments of an application, in an annotation
	// or in a value's `Holder<Integer>#Full`.
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

	// A Function Type's Parameter mirrors a Parameter. Its internal name only
	// documents it and may be left out, as in `_: String`.
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

	// A contextually typed Function literal may leave its return Type to the
	// expected signature or, where that leaves it Generic, to its body.
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

		// A Statement in a block does not stand in the Argument list around it.
		let outerInsideArgumentList = this.insideArgumentList

		this.insideArgumentList = false

		try {
			// `(n: Integer) => n`: an arrow written where a block belongs. Every
			// block is read here, so each `=>` is answered in the same words.
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

	// Called on entry to every reader that recurs once per written level. The
	// caller decrements `nestingDepth` in a `finally`, since a throw unwinds
	// many levels at once.
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

	// Whether the `(` at the cursor opens a Parameter list rather than a call:
	// its `)` is followed by a block's `{` or a `for any`. The `for` lets the
	// enricher refuse a test that writes both `across` and `for any`.
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

	// The `complete`s read in the body being parsed and not in a body nested
	// in it, which says whether the body is completing. A number, so `speculate`
	// can save and restore it.
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

	protected withinTestsSection<T>(parse: () => T): T {
		this.insideTestsSection = true

		try {
			return parse()
		} finally {
			this.insideTestsSection = false
		}
	}

	// Reads a Function's body, which is never part of the test it is written in.
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

	// The foreign lexeme `from` Tokens ahead of the cursor, joined from flush
	// Tokens: `=` and `=` make `==`. Joining stops after a Token like `+2` that
	// gives only part of itself, so the operand is never underlined.
	protected foreignLexeme(from = 0): {
		text: string
		position: common.Position
		// Whether the first Token gave all of itself: `+` did, `+2` did not.
		// The enricher answers an operator flush against its operand.
		whole: boolean
		// How many Tokens the lexeme spans, so a caller can read the right
		// operand of a compound assignment such as `+=`.
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

	// The verdict on the lexeme at the cursor: a habit, an operator Essence
	// lacks, or null. `left` is the Expression before it, which a compound
	// assignment's Help spells out, as in `tally = tally::add(5)`.
	protected foreignTextAhead(
		left?: parser.ExpressionNode,
	): ForeignRefusal | null {
		let lexeme = this.foreignLexeme()

		if (lexeme === null || essenceLexemes.has(lexeme.text)) {
			return null
		}

		// `["kim" => 7]`: an `=>` after a written key is a Dictionary entry.
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

	// `foreignTextAhead` asked of the Token after the cursor, by callers about
	// to read the cursor's Token as a label or Parameter name. Only a whole
	// operator Token counts, not the `+` of `+tax`.
	protected foreignTextFollowing(): ForeignRefusal | null {
		// Only an Identifier: a Symbol operator begins no Expression, and a `-`
		// may sign a Number, as in `compute(offset -1)`.
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

	// After a `,`, a closing bracket other than the list's own, or the end of
	// the input, says the list was never closed. It is reported as the list's
	// close would be, naming where the list opened.
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

	// A reading kept wherever it parses. See "Speculation" in DEVELOPMENT.md.
	protected backtrack<T>(parseAttempt: () => T): T | null {
		return this.speculate(parseAttempt, () => true)
	}

	// Tries one reading and keeps it where it parses and `keeps` agrees. A
	// thrown-away reading leaves nothing behind, and a refusal of the text is
	// re-raised. See "Speculation" in DEVELOPMENT.md.
	protected speculate<T>(
		parseAttempt: () => T,
		keeps: () => boolean,
	): T | null {
		let saved = this.tokens.save()
		let savedSuppressDiagnostics = this.suppressDiagnostics
		// A thrown-away reading must not mark the body around it completing.
		let savedCompletesSeen = this.completesSeen
		let diagnosticMark = markDiagnostics()
		let depth = this.speculationDepth

		this.speculationDepth = depth + 1

		try {
			let result = parseAttempt()

			if (keeps()) {
				// A reading that held settles its siblings and every group
				// speculated inside it.
				this.forgetFailuresFrom(depth)

				return result
			}
		} catch (error) {
			if (!(error instanceof ParseError)) {
				throw error
			}

			if (refusesTheText(error)) {
				// A reported refusal keeps its Diagnostics and the latch. See
				// "Refusals of the text" in DEVELOPMENT.md.
				if (error.reported) {
					throw error
				}

				this.suppressDiagnostics = savedSuppressDiagnostics
				this.completesSeen = savedCompletesSeen
				rewindDiagnostics(diagnosticMark)

				throw error
			}

			// Recorded before the rewind, while the stream stands where this
			// reading stopped.
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

	// Records a failure that got further than the one recorded. A tie goes to
	// the reading tried first. See "The furthest failure" in DEVELOPMENT.md.
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

	// Forgets a failure recorded at or inside the level `depth` that has just
	// resolved. See "The furthest failure" in DEVELOPMENT.md.
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

// Parse errors are reported as Diagnostics, and the parser always produces
// a Program, dropping broken Statements. See "Error recovery" in DEVELOPMENT.md.
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

// The Statements of an `@example` block, read as a test body. The caller
// blanks every other line of the file, so each Position is the one in the
// source.
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
