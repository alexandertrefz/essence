import { type common, lexer, type parser } from "@essence-lang/interfaces"

// NOTE: Hand-written recursive descent parser — the compiler's parser,
// re-exported through src/parser. It builds its ASTs through the shared
// node generators in ../nodeGenerators.
import {
	collectDiagnostics,
	markDiagnostics,
	primary,
	reportError,
	rewindDiagnostics,
	secondary,
} from "../../diagnostics/index"
import * as generators from "../nodeGenerators"
import {
	describeToken,
	fail,
	ParseError,
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

// NOTE: These token types form the Identifier rule of the grammar — the
// keywords `with`, `static`, `case`, `infer`, `choice`, `import`, `export`,
// `from` and `as` are valid Identifiers. The Module keywords are on this list
// for the same reason the rest are: `from` and `as` are Argument labels the
// standard library already writes (`slice(from 1, to 3)`,
// `normalize(as #ComposedCanonical)`), so they can only ever be Keywords where
// a Module section is being read.
//
// NOTE: A Set rather than an Array, here and for the two lists below. Each is
// asked of a Token, in a loop over every Token — a scan of ten strings per
// question is what a membership test costs when it is written as one.
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
	TokenType.KeywordExpect,
	TokenType.KeywordRequire,
])

function isIdentifierToken(token: Token | undefined): boolean {
	return token !== undefined && identifierTokenTypes.has(token.type)
}

// NOTE: Every Token type an Expression can begin with — exactly the cases
// `parsePrimaryExpression` answers, and nothing else. A Token type added there
// belongs here too; one that is here and not there would make
// `parseArgument` read a label where the Expression reading was meant.
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
	TokenType.LiteralString,
	TokenType.LiteralStringStart,
	TokenType.LiteralNumber,
	TokenType.LiteralTrue,
	TokenType.LiteralFalse,
])

function startsExpression(token: Token | undefined): boolean {
	return token !== undefined && expressionStartTokenTypes.has(token.type)
}

// NOTE: Every way an Expression CARRIES ON past a Token that has already been
// read — the three postfix forms `parseExpressionLevels` loops over, plus the
// `#` that makes an Identifier the Choice half of `Choice#Case` when the two
// are written flush together. A Keyword that is also an Identifier (`expect`,
// `require`) opens its Statement form only where none of these follows it:
// `expect(true)` is a call of a Function named `expect`, `expect.first` reads a
// member off one, and `expect#Win` names a Case of one. `::` needs no case here
// — a `:` can not start an Expression, so `expect::isEmpty()` never reached the
// question.
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

// NOTE: The words that open a form of their own where they stand and are
// ordinary names everywhere else — the same rule `where` follows in a Guard.
// None of them is a Keyword, so `constant across = 1` and `matches::isEmpty()`
// are still what they say.
const ACROSS = "across"
const MATCHES = "matches"
const SNAPSHOT = "snapshot"

// NOTE: The Token types that begin a literal Matcher — `case 0`, `case 1/2`,
// `case "a"`. Everything else in Matcher position is read as a Type.
// `LiteralStringStart` is here only so an interpolated String reaches
// `parseLiteralMatcherValue`, which refuses it with a message about why a
// String with holes can not be matched — rather than the generic "expected a
// Type" a Type parse would give.
const literalMatcherTokenTypes = new Set([
	TokenType.LiteralNumber,
	TokenType.SymbolDash,
	TokenType.LiteralString,
	TokenType.LiteralStringStart,
	TokenType.LiteralTrue,
	TokenType.LiteralFalse,
])

// NOTE: Every Token type a Matcher can begin with where an assertion opens —
// a name (a Type, or the Choice half of `Choice#Case`), a `{` Pattern, a `#`
// Case, a written value, or `_`. It is what `parseAssertionStatement` asks
// before it reads the Matcher of `require MATCHER = EXPR` speculatively: an
// assertion whose subject begins with anything else — `@`, `[`, `<`, `.`,
// `match` — has no Matcher reading at all, and never pays for one.
//
// The `(` a Function-Type Matcher begins with is not here, because that
// reading never arises: `continuesExpression` makes `require (` a call of a
// Function named `require` before an assertion is considered at all, so
// `require (Integer) -> String = f` never reaches this question. A
// Function-Type Matcher can not open an assertion, and is not meant to — what
// it would prove is a shape a test already has from the Type of what it wrote.
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

// NOTE: The Token types that can begin a Statement — these are the
// resynchronisation points after a parse error. Every Keyword
// `parseImplementationNode` dispatches on belongs here: one that is missing
// is not a Statement start to the recovery, so the whole Declaration it opens
// — braces and all — is skipped without a word.
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
	TokenType.KeywordExpect,
	TokenType.KeywordRequire,
])

// NOTE: Whether two Positions are written flush against each other, with
// neither whitespace nor a line break between them. Some of the grammar reads
// several Tokens as one lexeme — `1_000`, `1/2` — and only their adjacency
// tells that apart from the same Tokens written as separate things.
// NOTE: The span a key was written across — the whole path where it is one,
// and the name alone where it is not.
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

// NOTE: Whether two written keys write the same member — the same spelling, or
// one a prefix of the other at a step boundary.
function keysClash(left: string, right: string): boolean {
	if (left === right) {
		return true
	}

	let [shorter, longer] =
		left.length < right.length ? [left, right] : [right, left]

	return longer.startsWith(`${shorter}.`)
}

function isAdjacent(left: common.Position, right: common.Position): boolean {
	return (
		left.end.line === right.start.line &&
		left.end.column === right.start.column
	)
}

// NOTE: The parser reads nesting by recursion, one call level per written
// level, so a Program that nests deeply enough would overflow the call stack
// and crash without a report. The guard refuses it with one instead, well
// before the stack runs out — 1024 levels is far past anything written by
// hand while leaving room for a machine-generated file (a serialized tree
// nests one level per node, and the budget is SHARED across Expressions,
// Types and blocks, so the per-construct headroom is what a file actually
// gets). Measured end to end, the toolchain survives nested blocks to about
// 2,000 levels and nested Lists to about 10,000 before some stage's own
// recursion gives out, so 1024 keeps a real margin under the worst of them.
const maximumNestingDepth = 1024

export type ParserOptions = {
	// NOTE: Opt-in that says the Statements about to be read stand in a test's
	// body, which is what makes `expect` and `require` legal in them. Only the
	// `@example` blocks of a `§§` Documentation block set it: what is written
	// under one is a test body, and it is parsed on its own rather than as part
	// of the file it was written in.
	insideTestBody?: boolean
	// NOTE: Opt-in that lets a Program open with `declarations { … }` — the
	// standard library sets it, every user file leaves it off so that a
	// `declarations` block there is diagnosed rather than parsed. It is also
	// what refuses both Module sections: the files that set it are one shared
	// declaration space rather than Modules, and none of them may import or
	// export.
	allowDeclarationsHeader?: boolean
}

// NOTE: One `import { … }` or `export { … }` block as it was read, with the
// side of the implementation it stood on and the Keyword's own Position. The
// node spans the whole block, which is what the Formatter and the Language
// Server need; a Diagnostic about the side a block was written on wants to
// point at the Keyword alone.
type ModuleSectionRead = {
	node: parser.ImportSectionNode | parser.ExportSectionNode
	keywordPosition: common.Position
	side: "above" | "below"
}

class DescentParser {
	protected tokens: TokenStream
	protected suppressDiagnostics: boolean
	protected allowDeclarationsHeader: boolean
	// NOTE: Parser state set from the header — `declarations` unlocks the
	// body-less native Method signatures and value-less static Properties that
	// `parseNamespaceBodyNode` produces. In `implementation` mode those branches
	// are simply never reached, so the absence of a body stays a parse error
	// exactly as before.
	protected mode: parser.Program["kind"] = "implementation"
	// NOTE: How many levels of Expressions, Types and blocks the parser is
	// currently inside — `enterNesting` counts them against
	// `maximumNestingDepth`. One shared budget, because the three recur into
	// each other and it is the call stack they share that the limit protects.
	protected nestingDepth = 0
	// NOTE: Whether the Statement being read stands in a test's own body — set
	// by `parseTest` and cleared again by every Function body written inside
	// one, which is what makes `expect` a Statement of the test and not of the
	// closure it was handed to. A `suite` body does NOT set it: the Statements
	// directly in a suite are its setup, and there is no test there for an
	// assertion to belong to.
	protected insideTestBody = false

	constructor(source: string, options: ParserOptions = {}) {
		this.tokens = new TokenStream(source)
		this.allowDeclarationsHeader = options.allowDeclarationsHeader ?? false
		this.insideTestBody = options.insideTestBody ?? false

		// NOTE: A Lexer error truncates the Token stream, so every
		// end-of-input error after it would only be a cascade of the already
		// reported problem.
		this.suppressDiagnostics = this.tokens.hadLexerError
	}

	// #region Program & Sections

	parseProgram(): parser.Program {
		let above = this.parseModuleSections("above")

		// NOTE: A file that is nothing but tests — the `Season.tests.es`
		// convention — writes its imports and a `tests { … }` block and no
		// implementation block at all. It still carries an implementation
		// section, empty and spanning the tests block, so that every stage
		// reading a Program's Statements reads one shape.
		if (this.startsTestsSection()) {
			let tests = this.parseTestsSection()
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
			)
		}

		let header = this.parseProgramHeader()

		if (header === null) {
			// NOTE: Without the `implementation {` header nothing can be
			// parsed — an empty Program is returned alongside the Diagnostic.
			let position = {
				start: { line: 1, column: 1 },
				end: { line: 1, column: 1 },
			}

			return generators.program(
				generators.implementationSection([], position),
				position,
			)
		}

		this.mode = header.kind

		let nodes = this.parseStatementList(() =>
			this.parseImplementationNode(),
		)
		let closingPosition = this.parseClosingBrace(header.leftBrace.position)

		let implementation = generators.implementationSection(nodes, {
			start: header.keyword.position.start,
			end: closingPosition.end,
		})

		// NOTE: The tests section is read where it belongs, directly under the
		// implementation block — and once more below the Module sections, so
		// that a `tests { … }` written under `export { … }` is diagnosed as the
		// block in the wrong place rather than as a Token where the Program was
		// supposed to have ended.
		let tests = this.startsTestsSection() ? this.parseTestsSection() : null
		let below = this.parseModuleSections("below")

		if (tests === null && this.startsTestsSection()) {
			tests = this.parseMisplacedTestsSection(implementation.position)
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

		// NOTE: A Program's Position stays the implementation block's own span,
		// sections or none — the Formatter reads it as the block it writes
		// `implementation {` and its closing brace for, and each section carries
		// its own span for whoever needs the file's full extent.
		return generators.program(
			implementation,
			implementation.position,
			header.kind,
			imports,
			exports,
			tests,
		)
	}

	// NOTE: Whatever is left once every section has been read. `endPosition` is
	// where the Program was supposed to have ended — the last section's own
	// span where there was one, and the block's closing brace where there was
	// not.
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
			},
		)
	}

	// NOTE: Both blocks are read on BOTH sides of the implementation, in either
	// order — a block written on the wrong side is parsed where it stands rather
	// than left to cascade into "Expected 'implementation'" or "nothing may
	// follow here", which say nothing about what the author got wrong. A second
	// block of the same kind on one side is left to those two Diagnostics, which
	// is where it belongs: it is not a section in the wrong place, it is a Token
	// where the Program was supposed to have ended.
	//
	// The `{` is part of what is recognised, because all four Module Keywords are
	// ordinary Identifiers everywhere else.
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

	// NOTE: Which of the blocks read on either side the Program keeps, and which
	// are refused. A refused block is dropped rather than carried along broken:
	// every later stage may read the sections a Program has as the sections it
	// meant. A `declarations { … }` Program carries them on the same terms as
	// any other — the standard library's files are Modules too, each importing
	// what it uses from its siblings.
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

	protected parseImportSection(): parser.ImportSectionNode {
		let keyword = this.tokens.next()
		let leftBrace = this.tokens.next()

		let entries = this.parseStatementList(() => this.parseImportEntry())
		let closingPosition = this.parseClosingBrace(leftBrace.position)

		return generators.importSection(entries, {
			start: keyword.position.start,
			end: closingPosition.end,
		})
	}

	protected parseExportSection(): parser.ExportSectionNode {
		let keyword = this.tokens.next()
		let leftBrace = this.tokens.next()

		let entries = this.parseStatementList(() => this.parseExportEntry())
		let closingPosition = this.parseClosingBrace(leftBrace.position)

		return generators.exportSection(entries, {
			start: keyword.position.start,
			end: closingPosition.end,
		})
	}

	protected parseImportEntry(): parser.ImportNode {
		let name = this.parseIdentifier()
		let alias = this.parseOptionalAlias()

		this.tokens.expect(TokenType.KeywordFrom)

		let source = this.parseModuleSpecifier()

		return generators.importEntry(name, alias, source, {
			start: name.position.start,
			end: source.position.end,
		})
	}

	// NOTE: The `from` clause is what makes an entry a re-export, and it is
	// optional — a plain name exports something this Program declares. Once
	// `from` is read the specifier is required, so a `from` with nothing after it
	// is a Diagnostic rather than a second entry that happens to be named `from`.
	protected parseExportEntry(): parser.ExportNode {
		let name = this.parseIdentifier()
		let alias = this.parseOptionalAlias()
		let end = (alias ?? name).position.end
		let source: parser.ModuleSpecifierNode | null = null

		if (this.tokens.peek()?.type === TokenType.KeywordFrom) {
			this.tokens.next()

			source = this.parseModuleSpecifier()
			end = source.position.end
		}

		return generators.exportEntry(name, alias, source, {
			start: name.position.start,
			end,
		})
	}

	// NOTE: `as` binds the entry under a local name of the author's choosing. It
	// is only a Keyword here — everywhere else it is an ordinary Identifier, an
	// Argument label included — so an entry may itself be named `as`, and
	// `as as from "./Module.es"` renames the imported `as` to `as`.
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
		// NOTE: A bare Identifier can never begin a Program today, so
		// `declarations {` is unambiguous — no Lexer keyword is needed. Only the
		// standard library is allowed to open one; anywhere else it is a tailored
		// Diagnostic, after which the block is parsed as an implementation
		// section so its contents still produce Diagnostics.
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

	protected startsTestsSection(): boolean {
		return (
			this.tokens.peek()?.type === TokenType.KeywordTests &&
			this.tokens.peek(1)?.type === TokenType.SymbolLeftBrace
		)
	}

	// NOTE: `tests { … }`. Like the Module sections, the `{` is part of what is
	// recognised, because `tests` is an ordinary Identifier everywhere else —
	// `constant tests = […]` is still a Declaration of a name.
	protected parseTestsSection(): parser.TestsSectionNode {
		let keyword = this.tokens.next()
		let leftBrace = this.tokens.next()

		let nodes = this.parseStatementList(() => this.parseTestsNode())
		let closingPosition = this.parseClosingBrace(leftBrace.position)

		return generators.testsSection(nodes, {
			start: keyword.position.start,
			end: closingPosition.end,
		})
	}

	// NOTE: A tests section written BELOW the `export { … }` block. It is read
	// where it stands and kept — the Program it describes is the one the author
	// meant, and dropping it would turn one Diagnostic about an order into a
	// cascade of "unknown name" about everything inside it.
	protected parseMisplacedTestsSection(
		implementationPosition: common.Position,
	): parser.TestsSectionNode {
		let keyword = this.peekOrFail()
		let section = this.parseTestsSection()

		if (!this.suppressDiagnostics) {
			reportError(
				"The 'tests { … }' block belongs above the 'export { … }' block",
				keyword.position,
				{
					code: "misplaced-tests-section",
					labels: [
						primary(
							keyword.position,
							"this block is written below what the Program ends with",
						),
						secondary(
							implementationPosition,
							"the implementation block is here",
						),
					],
					notes: [
						"A Program reads top to bottom: what it imports, what it does, what it proves, what it exports.",
					],
					helps: [
						"Move the 'tests { … }' block above 'export { … }'.",
					],
				},
			)
		}

		return section
	}

	// NOTE: What may stand in a tests section, and in a `suite`'s body: a test,
	// a nested suite, or any Statement an implementation block takes — a
	// `constant` written here is setup, a `function` is a helper.
	protected parseTestsNode(): parser.TestsNode {
		if (this.startsTestItem(this.peekOrFail())) {
			return this.parseTestItem()
		}

		return this.parseImplementationNode()
	}

	// NOTE: `test` and `suite` are ordinary Identifiers as well, so what opens
	// an item is the Keyword AND the name that must follow it — `test = 5`
	// stays an assignment to a variable called `test`.
	protected startsTestItem(token: Token): boolean {
		if (
			token.type !== TokenType.KeywordTest &&
			token.type !== TokenType.KeywordSuite
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

	protected parseTest(): parser.TestNode {
		let keyword = this.tokens.expect(TokenType.KeywordTest)
		let name = this.parseTestName()
		let modifiers = this.parseTestModifiers()
		let table = this.startsTestTable() ? this.parseTestTable() : null

		let outerInsideTestBody = this.insideTestBody
		this.insideTestBody = true

		try {
			let block = this.parseBlock()

			return generators.test(
				name,
				modifiers,
				table,
				block.body,
				keyword.position,
				{ start: keyword.position.start, end: block.position.end },
			)
		} finally {
			this.insideTestBody = outerInsideTestBody
		}
	}

	// NOTE: `across` is recognised by content, the way `matches` is in an
	// assertion: it opens the one form that stands between a test's Modifiers
	// and its body, and everywhere else it is an ordinary name.
	protected startsTestTable(): boolean {
		let token = this.tokens.peek()

		return token?.type === TokenType.Identifier && token.value === ACROSS
	}

	// NOTE: `across [ … ] ({ scored, conceded }: Scoreline)` — the rows a test
	// runs for, and what one row is called inside the body. The parameter list
	// is a closure's, so a row can be taken apart by a Pattern and annotated
	// with the Type that lets a bare Case in a row resolve.
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
		let name = this.parseTestName()
		let modifiers = this.parseTestModifiers()

		// NOTE: A suite's own body is not a test body — the Statements directly
		// in it are the setup its tests share, and an assertion written among
		// them belongs to no test.
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

	// NOTE: A name is a String Literal so that it can say what the test proves
	// rather than name it like a Function — and an interpolated one, because a
	// table test names each row out of the row's own values.
	protected parseTestName(): parser.TestNode["name"] {
		let token = this.peekOrFail("the name of the test")

		if (token.type === TokenType.LiteralStringStart) {
			return this.parseInterpolatedString()
		}

		if (token.type !== TokenType.LiteralString) {
			fail(
				`Expected the name of the test but found ${describeToken(token)}.`,
				token.position,
				"expected a String Literal",
			)
		}

		this.tokens.next()

		return generators.stringValueNode(token.value, token.position)
	}

	// NOTE: Zero or more Modifiers, written between the name and the body the
	// way trailing labelled Arguments are written after a call's own. The
	// grammar is a name and the arguments that follow it; what a name MEANS is
	// left to the stage that knows the vocabulary, so `within 2s` or
	// `retries 3` land later as vocabulary rather than as parser work.
	//
	// NOTE: A literal always belongs to the Modifier in front of it — there is
	// nothing else it could be. A bare name is the one shape a Modifier and its
	// own argument share, and it is read as an argument only where a comma or
	// the body follows it: in `tagged slow { … }` the body settles it, in
	// `tagged slow, network` the comma does, and in `focused tagged slow` the
	// name in the middle is left to be the Modifier it is. What no lookahead
	// can settle — one bare argument with another Modifier behind it, as in
	// `tagged slow focused` — reads as three Modifiers, which the stage that
	// knows the vocabulary can say something useful about; a greedy reading
	// would swallow `focused` instead and say nothing.
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

		// NOTE: `tagged slow across [ … ]` — the table opens the same way the
		// body does, so a bare name in front of one is that Modifier's own
		// argument for exactly the reason it is in front of a `{`.
		return (
			following?.type === TokenType.SymbolComma ||
			following?.type === TokenType.SymbolLeftBrace ||
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

	// NOTE: The list loop with nothing around it — no block, no braces, no
	// Program. `parseStatementList` stops at a `}` or at the end of the input,
	// and an example has neither, so what it reads is everything the text
	// holds.
	parseStatements(): Array<parser.ImplementationNode> {
		return this.parseStatementList(() => this.parseImplementationNode())
	}

	// #region Error Recovery

	protected reportParseError(error: unknown): void {
		if (!(error instanceof ParseError)) {
			throw error
		}

		if (this.suppressDiagnostics) {
			return
		}

		if (error.position === null) {
			reportError(error.message, null, {
				code: error.code,
				labels: [],
				notes: error.notes,
				helps: error.helps,
			})

			return
		}

		reportError(error.message, error.position, {
			code: error.code,
			labels:
				error.label === null
					? [primary(error.position, "here")]
					: [primary(error.position, error.label)],
			notes: error.notes,
			helps: error.helps,
		})
	}

	// NOTE: Several parts of the AST hold their members in a name-keyed
	// Record — a Namespace's Methods, a Record's members — where a repeated
	// name can not be represented at all: building the Record drops the
	// earlier definition, and with it whatever Expression it held. No later
	// stage ever sees the first one, so the duplicate is reported here, where
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
					helps,
				},
			)
		}
	}

	// NOTE: Parses list elements until the closing `}` (or the end of the
	// input), reporting a single Diagnostic per broken element and
	// resynchronising afterwards. Broken elements are DROPPED from the AST —
	// the Enricher already tolerates missing declarations through its
	// ErrorType poison machinery, so no error nodes are invented.
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

			let startState = this.tokens.save()

			try {
				elements.push(parseElement())
			} catch (error) {
				this.recoverFromError(error, startState)
			}
		}

		return elements
	}

	protected recoverFromError(
		error: unknown,
		startState: TokenStreamState,
	): void {
		this.reportParseError(error)
		this.resynchronise(startState.braceDepth)

		// NOTE: Guarantee progress — when the broken element consumed no
		// Token and resynchronisation stopped immediately, the enclosing loop
		// would otherwise retry the same Token forever.
		if (
			this.tokens.save().index === startState.index &&
			!this.tokens.isAtEnd()
		) {
			this.tokens.next()
		}
	}

	// NOTE: Skips ahead to the next Token that can begin a Statement (or to
	// the closing `}`) at the brace depth the broken element started on —
	// braces opened by the broken element itself are skipped over entirely.
	protected resynchronise(targetDepth: number): void {
		while (true) {
			let token = this.tokens.peek()

			if (token === undefined) {
				// NOTE: Resynchronisation hit the end of the input — every
				// further error would be a cascade of the one just reported.
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

	// NOTE: `openingPosition` is where the `{` this closes was written. The
	// end of the input is where a missing `}` is *noticed*; the `{` is where
	// the mistake is, and pointing at both is the difference between "there
	// is a brace missing somewhere" and "this block was never closed".
	protected parseClosingBrace(
		openingPosition: common.Position | null = null,
	): common.Position {
		let token = this.tokens.peek()

		if (token !== undefined && token.type === TokenType.SymbolRightBrace) {
			this.tokens.next()

			return token.position
		}

		// NOTE: Only the innermost torn-open block reports — a missing `}`
		// necessarily tears open every enclosing block as well.
		if (!this.suppressDiagnostics) {
			let endPosition = this.tokens.endPosition()

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

			this.suppressDiagnostics = true
		}

		return this.tokens.endPosition()
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

		// NOTE: A `test` or a `suite` is an item of the tests section, and
		// reached here only where one was written outside it. It is read to its
		// end before it is refused, so the Diagnostic is about the item rather
		// than about the first Token inside a block nobody expected.
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

		// NOTE: `expect` and `require` are Identifiers as well, so an assertion
		// is only read where what follows the Keyword could not be the Keyword
		// itself, read as a value: `expect = 5` stays an assignment,
		// `expect::isEmpty()` and `expect.first` stay reads of a value called
		// `expect`, and `expect(true)` a call of a Function called `expect`.
		//
		// What may follow is an Expression, or the `_` that only a Matcher can
		// begin with — `require _ = x` is refused where it is read, and a `_`
		// that never reached the assertion would be refused as a stray Token
		// instead.
		if (
			(token.type === TokenType.KeywordExpect ||
				token.type === TokenType.KeywordRequire) &&
			(startsExpression(this.tokens.peek(1)) ||
				this.tokens.peek(1)?.type === TokenType.SymbolUnderscore) &&
			!continuesExpression(token, this.tokens.peek(1))
		) {
			return this.parseAssertionStatement()
		}

		// NOTE: `choice` is a valid Identifier, so it only opens a Choice
		// Declaration when the Choice's name follows — `choice = 5` stays an
		// assignment to a variable named `choice`.
		if (
			token.type === TokenType.KeywordChoice &&
			isIdentifierToken(this.tokens.peek(1))
		) {
			return this.parseChoiceDeclarationStatement()
		}

		// NOTE: `overload function …` is a free-Function Overload block, only
		// meaningful in a `declarations { … }` Program — the standard library's
		// alone. Anywhere else it is a tailored Diagnostic, after which the block
		// is parsed anyway so its contents still produce Diagnostics; without
		// that the form read as an Expression and measured a bare "Expected an
		// Expression but found 'overload'" plus a cascade off the block's `{`.
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

		return this.parseExpression()
	}

	// NOTE: A `§§` block above a Declaration documents whatever the Declaration
	// holds, so a Function literal written as the value is handed the block —
	// the Enricher already reads the block's `@param` lines against that
	// literal's Parameters. It is handed down rather than picked up, because a
	// literal in expression position owns no block of its own: reading one off
	// the line above it made this work only where the literal shared the
	// Declaration's line.
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

	// NOTE: What a Declaration declares — one name, or a Pattern naming the
	// parts of the value. The Keyword in front is what makes this unambiguous:
	// a keyword-less `{ a, b } = x` could not be told from the Record Literal
	// `{ a = 1 }` written as a Statement until its closing brace, which is why
	// assignment position takes no Pattern.
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
				// NOTE: Out to the predicate, not to the Type — the Statement
				// stands for the whole of `Integer where @::isNot(0)`. The
				// formatter reads a declaration's own span to decide which
				// Comments sit above it and which trail it, so a clause left
				// outside the Node would put a Comment written after it above
				// the NEXT declaration.
				end: predicate?.position.end ?? type.position.end,
			},
			this.tokens.documentationAbove(keyword.position.start.line),
		)
	}

	// NOTE: The `where` clause of a checked refinement. `where` is not a
	// Keyword — it is an ordinary Identifier used as an Argument label
	// (`removeEvery(where …)`) and as a Namespace's conformance conditions — so
	// it is recognised by content, exactly as `parseOptionalGuard` does it.
	//
	// NOTE: Only when the `where` sits on the SAME line as the Type it refines,
	// which is the rule `parseGenericType` keeps for its `<` and for the same
	// reason: linebreak Tokens are discarded, so a clause opening the NEXT line
	// is indistinguishable from one continuing this Type. `type Handler = Reader`
	// followed by a Statement that begins with the name `where` would otherwise
	// have its Type read as a refinement of the line above it. A refinement is
	// always written on one line, so this refuses nothing a Declaration means.
	protected parseOptionalRefinementPredicate(
		type: parser.TypeDeclarationNode,
	): parser.ExpressionNode | null {
		let token = this.tokens.peek()

		if (
			token?.type !== TokenType.Identifier ||
			token.value !== "where" ||
			token.position.start.line !== type.position.end.line
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

		this.tokens.expect(TokenType.SymbolLeftBrace)

		let cases: Array<parser.ChoiceCaseNode> = []

		if (this.tokens.peek()?.type !== TokenType.SymbolRightBrace) {
			cases.push(this.parseChoiceCase())

			while (this.tokens.peek()?.type === TokenType.SymbolComma) {
				this.tokens.next()

				if (this.tokens.peek()?.type === TokenType.SymbolRightBrace) {
					break
				}

				cases.push(this.parseChoiceCase())
			}
		}

		let rightBrace = this.tokens.expect(TokenType.SymbolRightBrace)

		return generators.choiceDeclarationStatement(
			name,
			generics,
			cases,
			{ start: keyword.position.start, end: rightBrace.position.end },
			this.tokens.documentationAbove(keyword.position.start.line),
		)
	}

	// NOTE: A payload shape may be followed by `= { … }`, the Record a
	// construction is filled out of. Nothing else may ever follow a Case, so
	// the `=` is read unconditionally and refused where there is no payload to
	// default — which says what is wrong instead of leaving the Expression to
	// fail as a Case name the list never closed.
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

	// NOTE: A free `function` always carries a body, in every mode. A native
	// free Function exists only as an `overload function` entry — the
	// body-less non-overloaded form left with `__print`, the last declaration
	// that used it — so a signature with no block gets the plain "Expected
	// '{'" the missing body is.
	protected parseFunctionStatement(): parser.FunctionStatementNode {
		let keyword = this.tokens.expect(TokenType.KeywordFunction)

		let name = this.parseIdentifier()
		let value = this.parseOptionallyGenericFunctionLiteral()

		return generators.functionStatement(name, value.value, {
			start: keyword.position.start,
			end: value.position.end,
		})
	}

	// NOTE: An `overload function <name> { … }` block — the free-Function
	// counterpart of an `overload` Method block, and, like the body-less
	// signature form, only meaningful in a `declarations { … }` Program. Each
	// entry is a Function literal or a native signature, mixed freely; the
	// written order is load-bearing, because the index names the `__overload$N`
	// export a call site binds to. Outside declarations mode this runs only as
	// recovery, after `parseImplementationNode` has already refused the form.
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

		// NOTE: Properties and Methods are built into two separate name-keyed
		// Records, so a Property may share its name with a Method — but not
		// with another Property, and a Method not with another Method, not
		// even when one of the two is `static`.
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

	// NOTE: `is` is contextual, not a keyword — `::is()` Method calls rely on
	// it lexing as an ordinary Identifier. Each conformance carries its own
	// `is` (`is Equatable, is Printable`); the comma separates clauses, so a
	// bare Protocol name after a comma is a mistake with a tailored Diagnostic.
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

	// NOTE: `where Generic is Protocol (, Generic is Protocol)*`, contextual
	// `where` (no lexer change — modelled on `parseOptionalGuard`). Written for
	// reuse: it takes no Namespace-specific input, so a future function-generics
	// `where` calls it verbatim.
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
			// NOTE: Comma disambiguation — a comma followed by `is` ends the
			// condition list, because that comma separates conformance clauses
			// (`is A where Item is X, is B`), not conditions. It is left
			// unconsumed for `parseConformanceClauses` to pick up.
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

		// NOTE: `is`/`where` name real Identifiers, but a `where` condition
		// whose LHS is literally one of them is almost certainly a dropped
		// name rather than a Type Parameter called `is` — diagnosed here.
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

		// NOTE: A Method takes its Documentation from its own signature line,
		// which is the same line — but an `overload` block and a static
		// Property own no signature, so theirs is read here.
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
				// NOTE: An overload block may MIX bodied and body-less entries in
				// declarations mode — each is a Function literal or a native
				// signature, whichever the entry's own body decides.
				let methods = this.parseStatementList(() =>
					this.parseMethodBodyOrSignature(),
				)

				this.parseClosingBrace(leftBrace.position)

				return {
					nodeType: isStatic
						? "OverloadedStaticMethodSignaturesNode"
						: "OverloadedMethodSignaturesNode",
					name,
					methods,
					documentation,
				}
			}

			let methods = this.parseStatementList(() =>
				this.parseOptionallyGenericFunctionLiteral(),
			)

			this.parseClosingBrace(leftBrace.position)

			if (isStatic) {
				return {
					nodeType: "OverloadedStaticMethodNode",
					name,
					methods,
					documentation,
				}
			}

			return {
				nodeType: "OverloadedMethodNode",
				name,
				methods,
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

			// NOTE: A native static Property — `static Pi: Transcendental` with
			// no `=` — is legal only in declarations mode. Everywhere else the
			// missing `=` stays a parse error, produced by the `expect` below.
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

	// NOTE: The `declarations`-mode Method form — an optional Generic list, a
	// Parameter list and a return Type, then either a block (a bodied Method,
	// implemented in Essence) or nothing (a body-less native signature bound to
	// the runtime by name). The bodied branch reproduces exactly what
	// `parseOptionallyGenericFunctionLiteral` builds, so a bodied Method in a
	// declarations Program parses identically to one anywhere else.
	protected parseMethodBodyOrSignature():
		| parser.FunctionValueNode
		| parser.NativeMethodSignatureNode {
		let documentation = this.documentationHere()
		let generics = this.parseOptionalGenericList()
		let parameterList = this.parseParameterList()
		let returnType = this.parseReturnType()

		if (this.tokens.peek()?.type === TokenType.SymbolLeftBrace) {
			let block = this.outsideTestBody(() => this.parseBlock())

			let definition =
				generics.length > 0
					? generators.genericFunctionDefinition(
							generics,
							parameterList.parameters,
							returnType,
							block.body,
							parameterList.position,
							documentation,
						)
					: generators.functionDefinition(
							parameterList.parameters,
							returnType,
							block.body,
							parameterList.position,
							documentation,
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
		// NOTE: The extension list reads exactly as a Namespace's conformance
		// list does, through the very same parse — `protocol Orderable is
		// Comparable` says of the Protocol what a conformance clause says of a
		// Type. A `where` clause parses here and is refused at the Enricher,
		// which is where the Diagnostic can say that a Protocol has no Type
		// Parameters for one to bound.
		let conformsTo = this.parseConformanceClauses()

		let leftBrace = this.tokens.expect(TokenType.SymbolLeftBrace)

		let body = this.parseStatementList(() => this.parseProtocolBodyNode())
		let closingPosition = this.parseClosingBrace(leftBrace.position)

		// NOTE: A Protocol's signatures are name-keyed exactly as a
		// Namespace's Methods are, and lose the first definition the same way.
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

		// NOTE: A signature takes its Documentation from its own line — an
		// `overload` block owns no signature line, so its Documentation is
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

			this.parseClosingBrace(leftBrace.position)

			if (isStatic) {
				return {
					nodeType: "OverloadedStaticProtocolMethod",
					name,
					signatures,
					documentation,
				}
			}

			return {
				nodeType: "OverloadedProtocolMethod",
				name,
				signatures,
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

	// NOTE: A Protocol Method is a requirement or a PROVIDED one, and the brace
	// after the return Type is the whole of the difference. The provided branch
	// builds the same Function Definition the bodied `declarations` Method form
	// builds, over the very Parameter and return Type Nodes the signature keeps
	// — so a provided Method is enriched and emitted by the code every other
	// bodied Method goes through.
	protected parseProtocolMethodSignature(): parser.ProtocolMethodSignatureNode {
		let documentation = this.documentationHere()
		let parameterList = this.parseParameterList()
		let returnType = this.parseReturnType()

		let body: parser.FunctionValueNode | null = null

		if (this.tokens.peek()?.type === TokenType.SymbolLeftBrace) {
			let block = this.outsideTestBody(() => this.parseBlock())

			body = generators.functionValueNode(
				generators.functionDefinition(
					parameterList.parameters,
					returnType,
					block.body,
					parameterList.position,
					documentation,
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

	// NOTE: `expect EXPR`, `require EXPR` and `require MATCHER = EXPR` — one
	// method, because the two Keywords differ in what a failure does and in
	// nothing else the grammar can see. `expect` judges a Boolean; `require`
	// judges a Boolean or takes a value apart.
	//
	// The Matcher stands where a Declaration's name stands, and for the reason
	// every other binding site has it there: a name is introduced left of `=`,
	// in a Parameter, or in a Handler head — never on the right of anything.
	// `expect` has no such form at all, because it records its result and the
	// test carries on: a name it introduced would stand below a line that may
	// never have run.
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
			this.refuseUnusableMatcher(matcher)

			let matches = this.tokens.peek()

			if (
				matches?.type === TokenType.Identifier &&
				matches.value === MATCHES
			) {
				this.refuseSnapshotAfterMatcher()
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

	// NOTE: The Matcher of `require MATCHER = EXPR`, read speculatively. A
	// Matcher and an Expression begin alike — `{ team, points }` and
	// `#Value(second)` are both — and a Matcher holds what no Expression can
	// (`points: Integer`, `} as whole`), so one reading can not stand for both
	// and be reinterpreted afterwards. The Matcher is read first and kept only
	// where the `=` behind it says that is what was written; where it is not,
	// the reading is given back whole and the Expression is read instead.
	//
	// `startsMatcher` is what keeps an assertion whose subject can not be a
	// Matcher from speculating at all.
	protected speculateAssertionMatcher(): parser.MatcherNode | null {
		if (!startsMatcher(this.tokens.peek())) {
			return null
		}

		return this.speculate(
			() => this.parseMatcher(true),
			() => this.tokens.peek()?.type === TokenType.SymbolEqual,
		)
	}

	// NOTE: `expect MATCHER = EXPR` — the form `require` has, written on the
	// Keyword that can not have it. Read to the end of the Expression before
	// it is refused, so what is dropped is the whole Statement rather than a
	// tail of it read again as one of its own.
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

	// NOTE: The two Matchers that can not mean anything left of `=`. Every
	// other one may stand there, whether it binds or not: `require #Empty = x`
	// and `require Integer = x` name a shape and bind nothing, which is what a
	// test asks when the shape is the whole of what it is proving.
	protected refuseUnusableMatcher(matcher: parser.MatcherNode): void {
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
					notes: [
						"'require MATCHER = EXPR' takes a value apart by its shape — a Case, a Type, a Pattern. A written value is not a shape: what it asks is whether the two are equal, and that is what 'Equatable::is' answers.",
					],
					helps: ["Compare instead: 'require x::is(3)'."],
				},
			)
		}
	}

	// NOTE: `EXPR is MATCHER` — the form a writer reaches for who has met a
	// Matcher behind an `is` somewhere else, recognised here only to say that
	// this language has no such form. `is` is not a Keyword: it is the
	// Equatable Method every value already has (`a::is(b)`), which is exactly
	// why a Matcher written behind it reads as a comparison that USES the name
	// it is declaring. The Matcher is read to its end before the report, so
	// the Diagnostic underlines the whole of what was written and the
	// Statement dropped is the whole Statement.
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

	// NOTE: `require MATCHER = EXPR matches snapshot` — a snapshot asked of
	// the one assertion form that has no value to give it. A snapshot records
	// a value; this line took one apart, and what came of that is the names it
	// introduced. Recording one of them is a Statement of its own, written
	// below: `expect item matches snapshot`.
	//
	// The snapshot is read to its end before the report, so the Diagnostic
	// underlines the whole of what was written and no tail of it is read again
	// as a Statement of its own.
	protected refuseSnapshotAfterMatcher(): never {
		let snapshot = this.parseSnapshot()

		throw new ParseError(
			"A snapshot records a value, and this line took one apart",
			snapshot.position,
			"there is no value here to record",
			{
				code: "snapshot-after-matcher",
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

	// NOTE: `matches snapshot` and the two shapes a snapshot takes. An INLINE
	// one carries its recorded text in the source, written there by the first
	// run — `matches snapshot` alone is one that has never run. A STORED one
	// names an entry of `__snapshots__/<File>.es.snap` and says so with `from`,
	// which is what keeps the two apart: the text of an inline snapshot is a
	// String Literal, and so is the name of a stored one.
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

		// NOTE: An interpolated String reaches `parseSnapshotText`, which
		// refuses it with a message about why — left alone it would read as a
		// Statement of its own on the line below an empty snapshot, which is
		// two readings of one line and no Diagnostic about either.
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

	// NOTE: A plain String Literal — an interpolated one holds Expressions,
	// and neither a recorded value nor the name of a stored snapshot is
	// something a run works out.
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

	// NOTE: An assertion belongs to a test — to the test's own block and to
	// every block nested inside it, and to nothing else. A Function literal
	// written in a test body is the boundary: its body runs wherever it is
	// handed to, which is not something the test can answer for.
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

	// NOTE: `endsBeforeBlockParameters` is set for the one Expression that is
	// followed by a parameter list — the rows of a table test, written
	// `across [ … ] (row: Row) { … }`. A `(` there would otherwise be read as a
	// call of what stands in front of it, and `[ … ](row: Row)` is a call
	// nobody wrote. See `stopsBeforeParameterList`.
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

			// NOTE: The two ':' of a Method call are one lexeme — only written
			// flush against each other do they read as '::', the same adjacency
			// rule every other multi-Token lexeme gets.
			if (
				token?.type === TokenType.SymbolColon &&
				following?.type === TokenType.SymbolColon &&
				isAdjacent(token.position, following.position)
			) {
				this.tokens.next()
				this.tokens.next()

				let namespaceSpecifier: parser.IdentifierNode | null = null
				if (this.tokens.peek()?.type === TokenType.SymbolLeftAngle) {
					this.tokens.next()
					namespaceSpecifier = this.parseIdentifier()
					this.tokens.expect(TokenType.SymbolRightAngle)
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
			} else {
				break
			}
		}

		return expression
	}

	protected parsePrimaryExpression(): parser.ExpressionNode {
		let token = this.peekOrFail("an Expression")

		// NOTE: `ChoiceName#CaseName` — recognised before the typed-Record
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

		// NOTE: `Holder<Integer>#Full(…)` — the same construction with its Type
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

		// NOTE: `Type ~> { … }` — speculative, because a Type and an Identifier
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
				return this.parseListLiteral()
			case TokenType.SymbolLeftParen: {
				// NOTE: The only Function literal whose annotations may be
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
			case TokenType.KeywordExpect:
			case TokenType.KeywordRequire:
				return this.parseIdentifier()
			default:
				fail(
					`Expected an Expression but found ${describeToken(token)}.`,
					token.position,
				)
		}
	}

	// NOTE: `.price`, `.address.city` — the whole chain is consumed here rather
	// than left to the postfix loop, which would otherwise read the second step
	// as a Lookup over the path and build a Node the language has no meaning
	// for. Nothing but a member name may follow a step's '.', so the loop needs
	// no adjacency rule of its own: a path reads its tail exactly the way a
	// Lookup chain reads its own.
	protected parseMemberPath(): parser.MemberPathNode {
		let dot = this.tokens.expect(TokenType.SymbolDot)
		let steps = [this.parseIdentifier()]

		while (this.tokens.peek()?.type === TokenType.SymbolDot) {
			this.tokens.next()
			steps.push(this.parseIdentifier())
		}

		this.refusePathPostfix()

		return generators.memberPath(steps, {
			start: dot.position.start,
			end: steps[steps.length - 1].position.end,
		})
	}

	// NOTE: A path stands for a Function that READS members, so a call attached
	// to it has nothing to attach to. Refused here rather than left to the
	// postfix loop: the loop would build an Invocation over the path and every
	// message from there on would be about the call rather than about the path
	// that can not carry one.
	protected refusePathPostfix(): void {
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
				helps: [
					"Write the Function literal instead: '(_ item: SomeType) { <- item.price::rounded() }'.",
				],
			},
		)
	}

	// NOTE: The payload parens are part of the construction syntax — they are
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

			// NOTE: `Holder<Integer>#Full(…)` — the Choice's Type Arguments
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

				// NOTE: And the `#` is held to the closing `>`'s line, for the
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
					fail(
						"Expected '#' on the line its Type Arguments close on.",
						hashToken.position,
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
			this.tokens.next()

			if (this.tokens.peek()?.type !== TokenType.SymbolRightParen) {
				value = this.parseExpression()
			}

			end = this.tokens.expect(TokenType.SymbolRightParen).position.end
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

	// NOTE: `_` is a wildcard only here — everywhere else it marks a labelless
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

		// NOTE: A Record in Matcher position is always a Pattern rather than a
		// Record Type, because only the Pattern form admits `name = value`
		// members alongside `name: Type` ones — and a bare `name`, which binds.
		//
		// No whole-value binder here: `@` is the scrutinee narrowed to this
		// Matcher, so `} as name` would be a second name for what already has
		// one.
		if (token?.type === TokenType.SymbolLeftBrace) {
			return this.parsePattern(allowsWholeValueBinder)
		}

		// NOTE: `case #Add` — the bare form resolves against the matched
		// value's own Union; `case CalculatorOperation#Add` is the prefixed
		// form for when that is ambiguous. Either may carry a payload binder,
		// `case #Value(item)`, parsed by `parseCaseMatcherBinding` below.
		if (token?.type === TokenType.SymbolHash) {
			this.tokens.next()

			let caseName = this.parseIdentifier()
			let binding = this.parseCaseMatcherBinding()

			return generators.caseMatcher(null, caseName, binding, {
				start: token.position.start,
				end: (binding ?? caseName).position.end,
			})
		}

		if (
			isIdentifierToken(token) &&
			this.tokens.peek(1)?.type === TokenType.SymbolHash
		) {
			let choice = this.parseIdentifier()

			this.tokens.expect(TokenType.SymbolHash)

			let caseName = this.parseIdentifier()
			let binding = this.parseCaseMatcherBinding()

			return generators.caseMatcher(choice, caseName, binding, {
				start: choice.position.start,
				end: (binding ?? caseName).position.end,
			})
		}

		return this.parseType()
	}

	// NOTE: The payload binder of a Case Matcher — `case #Value(item)`. It names
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
	// NOTE: A Case Matcher is the only Matcher that takes a binder. `@` already
	// answers for every Matcher kind — the scrutinee, narrowed — so this adds a
	// second name rather than redefining the one that exists. That is also why a
	// Pattern in Matcher position carries no whole-value binder of its own,
	// while one in a payload does: what the constructor took is not `@`.
	protected parseCaseMatcherBinding():
		| parser.IdentifierNode
		| parser.PatternNode
		| null {
		if (this.tokens.peek()?.type !== TokenType.SymbolLeftParen) {
			return null
		}

		this.tokens.expect(TokenType.SymbolLeftParen)

		let binding =
			this.tokens.peek()?.type === TokenType.SymbolLeftBrace
				? this.parsePattern()
				: this.parseIdentifier()

		this.tokens.expect(TokenType.SymbolRightParen)

		return binding
	}

	// NOTE: A Pattern names the parts of a value, in every position that takes
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

				members.push(this.parsePatternMember())
			}
		}

		let rightBrace = this.tokens.expect(TokenType.SymbolRightBrace)

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

	// NOTE: `name` binds the member under its own name; `name: Type` binds it
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

	// NOTE: `as` binds a member under another name, or takes it apart further —
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

	// NOTE: `} as name` — one name for the whole value, alongside the names its
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

		// NOTE: Reported and then dropped, rather than failed on, so that one
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
				helps: [`Write '@' where '${name.content}' was meant.`],
			},
		)

		return null
	}

	// NOTE: Whether the `as` at the cursor opens a binder rather than being a
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

	// NOTE: A Matcher compares against a written literal and nothing else —
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
			// NOTE: An interpolated String is not a compile-time literal — its
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

	// NOTE: `where` is not a Keyword — it is an ordinary Identifier used as an
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

		let keyValuePairList = this.parseKeyValuePairList(true)
		let rightBrace = this.tokens.expect(TokenType.SymbolRightBrace)

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
			let keyValuePairList = this.parseKeyValuePairList(true)
			let rightBrace = this.tokens.expect(TokenType.SymbolRightBrace)

			return generators.recordValueNode(null, keyValuePairList.data, {
				start: leftBrace.position.start,
				end: rightBrace.position.end,
			})
		})

		if (record !== null) {
			return record
		}

		let lhs = this.parseExpression()

		this.tokens.expect(TokenType.KeywordWith)

		let combinationOfKeys = (allowShorthand: boolean) =>
			this.backtrack(() => {
				let keyValuePairList =
					this.parseKeyValuePairList(allowShorthand)
				let rightBrace = this.tokens.expect(TokenType.SymbolRightBrace)

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
				)
			})

		let keyValuePairCombination = combinationOfKeys(false)

		if (keyValuePairCombination !== null) {
			return keyValuePairCombination
		}

		// NOTE: The Expression reading is speculated too, so the key list can
		// be read ONE more time below when it fails. Order is what keeps
		// `{ base with other }` meaning what it has always meant — a whole
		// value merged in — because a bare name reads as an Expression here
		// before it is ever offered the shorthand.
		let expressionCombination = this.backtrack(() => {
			let rhs = this.parseExpression()
			let rightBrace = this.tokens.expect(TokenType.SymbolRightBrace)

			return generators.combination(lhs, rhs, {
				start: leftBrace.position.start,
				end: rightBrace.position.end,
			})
		})

		if (expressionCombination !== null) {
			return expressionCombination
		}

		// NOTE: Neither reading spans this. `{ base with port, host }` is the
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
		let rightBrace = this.tokens.expect(TokenType.SymbolRightBrace)

		return generators.combination(lhs, rhs, {
			start: leftBrace.position.start,
			end: rightBrace.position.end,
		})
	}

	// NOTE: One Diagnostic per bare name, on a Combination the third reading
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

		for (let member of Object.values(combination.rhs.members)) {
			// NOTE: A bare PATH key was already refused as it was read, with
			// the message that explains why no reading rescues it — there is
			// no `a.b = a.b` for it to have meant.
			if (member.shorthand !== true || member.steps !== undefined) {
				continue
			}

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
						`Or merge a whole Record: '{ base with { ${name} } }'.`,
					],
				},
			)
		}
	}

	// NOTE: `allowShorthand` is a property of the BRACES, not of the member —
	// a Record literal's member list takes `{ x }` for `{ x = x }`, and a
	// Combination's key list does not, because a bare name after `with` is
	// already the whole value being merged in. The one flag is what keeps
	// `{ base with other }` from silently turning into "set member `other`".
	protected parseKeyValuePairList(
		allowShorthand: boolean,
	): ReturnType<typeof generators.buildKeyValuePairList> {
		let pairs = [this.parseKeyValuePair(allowShorthand)]

		while (this.tokens.peek()?.type === TokenType.SymbolComma) {
			this.tokens.next()

			if (this.tokens.peek()?.type === TokenType.SymbolRightBrace) {
				break
			}

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

		// NOTE: The value is a Node of its own at the name's Position rather
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

	// NOTE: The steps after a key's first Identifier, or null where the key is
	// a plain name — which is what tells the two apart everywhere below. Every
	// key position reads a path, a plain Record Literal's included: refusing it
	// here would put the refusal inside the speculative first reading of
	// `parseRecordLiteralOrCombination`, where it is rewound, and the author
	// would be told 'Expected with' instead of what a path key is.
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

	// NOTE: `server.{ port = 1, host }` — the member list of an update written
	// one level down. Shorthand is allowed inside it, where it is refused after
	// a `with`: a bare name there could be the whole value being merged, and
	// inside a descend there is no such reading to lose.
	protected parseKeyGroup(
		steps: Array<parser.IdentifierNode>,
	): parser.RecordValueNode {
		// NOTE: Counted, because a descend holding a descend recurs through
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

		let keyValuePairList = this.parseKeyValuePairList(true)
		let rightBrace = this.tokens.expect(TokenType.SymbolRightBrace)

		return generators.recordValueNode(null, keyValuePairList.data, {
			start: leftBrace.position.start,
			end: rightBrace.position.end,
		})
	}

	// NOTE: Reported and recovered rather than failed on: an empty descend is a
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
			helps: ["Write the members to update inside it, or drop the key."],
		})
	}

	// NOTE: A path key always spells its value. Where the key ENDED without
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

	// NOTE: Two keys clash when they are the same, or when one is a PREFIX of
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

	// NOTE: The Lexer has already split the interpolated String into its chunk
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

			// NOTE: Unreachable for a String the Lexer produced — every hole it
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

		// NOTE: `1/2` is one Rational Literal because the three Tokens are
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

			return generators.rationalValueNode(
				numerator.value,
				denominator.value,
				{
					start: numerator.position.start,
					end: denominator.position.end,
				},
			)
		}

		return generators.integerValueNode(numerator.value, numerator.position)
	}

	protected parseInteger(): { value: string; position: common.Position } {
		let dash: Token | null = null
		if (this.tokens.peek()?.type === TokenType.SymbolDash) {
			dash = this.tokens.next()
		}

		let firstPart = this.tokens.expect(TokenType.LiteralNumber)

		let value = firstPart.value
		let lastPart = firstPart

		// NOTE: `1_000` is one Number only because its Tokens are written
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

		let end = lastPart.position.end
		let start = firstPart.position.start
		if (dash !== null) {
			value = `-${value}`
			start = dash.position.start
		}

		return { value, position: { start, end } }
	}

	protected parseListLiteral(): parser.ListValueNode {
		let leftBracket = this.tokens.expect(TokenType.SymbolLeftBracket)

		let values: Array<parser.ExpressionNode> = []

		if (this.tokens.peek()?.type !== TokenType.SymbolRightBracket) {
			values.push(this.parseExpression())

			while (this.tokens.peek()?.type === TokenType.SymbolComma) {
				this.tokens.next()

				if (this.tokens.peek()?.type === TokenType.SymbolRightBracket) {
					break
				}

				values.push(this.parseExpression())
			}
		}

		let rightBracket = this.tokens.expect(TokenType.SymbolRightBracket)

		return generators.listValueNode(values, {
			start: leftBracket.position.start,
			end: rightBracket.position.end,
		})
	}

	// NOTE: `ownsDocumentation` is false for a literal in EXPRESSION position.
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
		let block = this.outsideTestBody(() => this.parseBlock())

		return generators.functionValueNode(
			generators.functionDefinition(
				parameterList.parameters,
				returnType,
				block.body,
				parameterList.position,
				documentation,
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
		let block = this.outsideTestBody(() => this.parseBlock())

		return generators.functionValueNode(
			generators.genericFunctionDefinition(
				genericList.generics,
				parameterList.parameters,
				returnType,
				block.body,
				parameterList.position,
				documentation,
			),
			{
				start: parameterList.position.start,
				end: block.position.end,
			},
		)
	}

	// NOTE: Named Functions and Methods take an optional Generic list before
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
		if (this.tokens.peek()?.type === TokenType.SymbolLeftAngle) {
			return this.parseGenericList().generics
		}

		return []
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

			generics.push(this.parseGenericDeclaration())
		}

		let rightAngle = this.tokens.expect(TokenType.SymbolRightAngle)

		return {
			generics,
			position: {
				start: leftAngle.position.start,
				end: rightAngle.position.end,
			},
		}
	}

	protected parseGenericDeclaration(): parser.GenericDeclarationNode {
		// NOTE: `infer` is a valid Identifier, so it only acts as the modifier
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

		// NOTE: `is` is contextual — `<infer Item is Comparable>` bounds the
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

				parameters.push(this.parseParameter(allowsInferredTypes))
			}
		}

		let rightParen = this.tokens.expect(TokenType.SymbolRightParen)

		return {
			parameters,
			position: {
				start: leftParen.position.start,
				end: rightParen.position.end,
			},
		}
	}

	// NOTE: The `§§` block above whatever is about to be parsed. Every
	// Declaration sits on the line of its own first Token, so no Declaration
	// needs to hand its Documentation down to the signature it owns.
	protected documentationHere(): common.Documentation | null {
		let token = this.tokens.peek()

		if (token === undefined) {
			return null
		}

		return this.tokens.documentationAbove(token.position.start.line)
	}

	// NOTE: `allowsInferredTypes` is set only for a Function literal in
	// expression position, where an omitted annotation has an expected
	// signature to be read off. Every Declaration parses its annotations, so a
	// null Type can not reach a named Function or a Method.
	// NOTE: The `= expression` a caller may leave out, read after everything
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

	protected parseParameterHead(
		allowsInferredTypes = false,
	): parser.ParameterNode {
		// NOTE: Only a Parameter written on a line of its own can carry a
		// block — otherwise the first Parameter of `function greet (…)` would
		// claim the Function's own Documentation.
		let documentation = this.tokens.startsLine()
			? this.documentationHere()
			: null

		let annotationFollows = () =>
			this.tokens.peek()?.type === TokenType.SymbolColon

		// NOTE: A leading `{` — a Pattern standing where the internal name goes,
		// with no label written. Like a bare `item`, it takes both its Type and
		// its label from the expected signature.
		if (this.tokens.peek()?.type === TokenType.SymbolLeftBrace) {
			return this.parsePatternParameter(null, null, documentation)
		}

		if (this.tokens.peek()?.type === TokenType.SymbolUnderscore) {
			let underscore = this.tokens.next()

			// NOTE: `_ { … }` — the labelless Pattern Parameter written out,
			// which is what a named Function needs, since it parses its
			// annotations rather than reading them off a signature.
			if (this.tokens.peek()?.type === TokenType.SymbolLeftBrace) {
				return this.parsePatternParameter(
					null,
					underscore.position,
					documentation,
				)
			}

			// NOTE: A bare `_` — binds no name and takes its Type from the
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

			// NOTE: `_: Type` stops at the `_` — it drops the label *and* the
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

			// NOTE: `_ name` — the same Parameter `_ name: Type` declares,
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

		// NOTE: `of { width, height }: Rectangle` — a label, then a Pattern where
		// the internal name goes. The label is what the caller writes, so the
		// call site is untouched by anything the Pattern says.
		if (this.tokens.peek()?.type === TokenType.SymbolLeftBrace) {
			return this.parsePatternParameter(name, null, documentation)
		}

		if (isIdentifierToken(this.tokens.peek())) {
			let internalName = this.parseIdentifier()

			// NOTE: A written label is only meaningful next to a written Type
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
				name,
				internalName,
				type,
				{ start: name.position.start, end: type.position.end },
				documentation,
			)
		}

		// NOTE: A bare `item` — both the Type and the label come from the
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
			name,
			name,
			type,
			{ start: name.position.start, end: type.position.end },
			documentation,
		)
	}

	// NOTE: The tail of every Pattern Parameter, shared by its three spellings —
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

	// NOTE: A signature with no body has nothing for a Pattern's bindings to be
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

	// NOTE: The two positions where a Parameter is well-formed but a default on
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
						],
						helps: [
							"Write the default on the named Function or Method this value is passed to.",
						],
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
			args.push(this.parseArgument())

			while (this.tokens.peek()?.type === TokenType.SymbolComma) {
				this.tokens.next()

				if (this.tokens.peek()?.type === TokenType.SymbolRightParen) {
					break
				}

				args.push(this.parseArgument())
			}
		}

		let rightParen = this.tokens.expect(TokenType.SymbolRightParen)

		return {
			args,
			position: {
				start: leftParen.position.start,
				end: rightParen.position.end,
			},
		}
	}

	// NOTE: Whether `label value` is what stands here, read off the Token AFTER
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
	// NOTE: `#` is the parser's adjacency rule, and the standard library leans
	// on it everywhere — `normalize(as #ComposedCanonical)` is a bare Case
	// passed under the label `as`, and `Ordering#Less` is a Choice prefix. The
	// space between them is the whole difference.
	//
	// NOTE: `<` stays speculative. It continues the Identifier as
	// `Holder<Integer>#Full(…)` and it also opens a Generic Function literal
	// that could be a labelled argument's value, and only a parse can tell
	// which — `parsePrimaryExpression` says the same thing about the same `<`.
	protected argumentIsLabelled(): boolean {
		let following = this.tokens.peek(1)

		if (
			!startsExpression(following) ||
			following!.type === TokenType.SymbolLeftParen ||
			following!.type === TokenType.SymbolLeftAngle
		) {
			return false
		}

		// NOTE: '#' and '.' both continue the Identifier when they are written
		// flush against it — `Choice#Case` and `order.isPaid` — and both open an
		// Expression of their own when a space stands between: `label #Case`
		// passes a bare Case, `label .price` passes a member path. The space is
		// the whole difference, and it is the same rule the prefixed Case
		// construction is read by.
		if (
			following!.type === TokenType.SymbolHash ||
			following!.type === TokenType.SymbolDot
		) {
			return !isAdjacent(
				this.tokens.peek()!.position,
				following!.position,
			)
		}

		return true
	}

	protected parseArgument(): parser.ArgumentNode {
		if (isIdentifierToken(this.tokens.peek())) {
			if (this.argumentIsLabelled()) {
				let name = this.parseIdentifier()
				let value = this.parseExpression()

				return generators.argument(name, value)
			}

			// NOTE: An Identifier can start both a plain Expression argument
			// and a labelled argument, so we try the Expression reading first
			// and fall back to the labelled reading — exactly one of the two
			// can reach the end of the argument.
			let unlabelledArgument = this.backtrack(() => {
				let value = this.parseExpression()
				let next = this.tokens.peek()?.type

				if (
					next !== TokenType.SymbolComma &&
					next !== TokenType.SymbolRightParen
				) {
					fail("Expression does not span the whole argument.")
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

	// NOTE: `|` binds loosest, so a Union is parsed on top of Generic
	// application — `List<Item> | Nothing` is a Union of `List<Item>` and
	// `Nothing`, not a Generic over a Union. A Union is still reachable as a
	// Generic argument (`List<Item | Nothing>`), where the angle brackets
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

		// NOTE: A `<` continues the base Type as a generic application
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

			// NOTE: From the base Type, not from the `<` — the Node stands for
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

	// NOTE: `<Integer, String>` — the Arguments of an application, wherever one
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

			typeArguments.push(this.parseType())
		}

		let rightAngle = this.tokens.expect(TokenType.SymbolRightAngle)

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

				parameterTypes.push(this.parseFunctionTypeParameter())
			}
		}

		this.tokens.expect(TokenType.SymbolRightParen)

		let returnType = this.parseReturnType()

		return generators.functionTypeDeclaration(parameterTypes, returnType, {
			start: leftParen.position.start,
			end: returnType.position.end,
		})
	}

	// NOTE: Function Type parameters mirror the parameter grammar — the
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

			pairs.push(this.parseKeyTypePair())
		}

		let rightBrace = this.tokens.expect(TokenType.SymbolRightBrace)

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

	// NOTE: A contextually typed Function literal may go straight from its
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

		try {
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
		}
	}

	// NOTE: Called on the way into every parsing method that recurs once per
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

	// NOTE: Reads a Function's body, which is never part of the test whose
	// body it was written in — every Function block goes through here so that
	// the one rule is stated in one place rather than at each of the four
	// spellings a Function has.
	// NOTE: Whether the `(` the reader is standing on opens a parameter list
	// rather than a call: it does exactly when the `)` that closes it is
	// followed by the `{` of a block. Parentheses are the only thing counted —
	// they nest inside every other bracket and every other bracket nests inside
	// them, so a `)` at depth zero is the one that closes this `(` whatever
	// stands in between.
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

			return (
				this.tokens.peek(offset + 1)?.type === TokenType.SymbolLeftBrace
			)
		}
	}

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

	// NOTE: A reading kept wherever it parsed at all — the same text is often
	// read twice (a typed Record Literal, then a Record Literal), and the
	// first reading that holds together is the one that was written.
	protected backtrack<T>(parseAttempt: () => T): T | null {
		return this.speculate(parseAttempt, () => true)
	}

	// NOTE: A speculation that is thrown away must leave nothing behind — not
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
	protected speculate<T>(
		parseAttempt: () => T,
		keeps: () => boolean,
	): T | null {
		let saved = this.tokens.save()
		let savedSuppressDiagnostics = this.suppressDiagnostics
		let diagnosticMark = markDiagnostics()

		try {
			let result = parseAttempt()

			if (keeps()) {
				return result
			}
		} catch (error) {
			if (!(error instanceof ParseError)) {
				throw error
			}
		}

		this.tokens.restore(saved)
		this.suppressDiagnostics = savedSuppressDiagnostics
		rewindDiagnostics(diagnosticMark)

		return null
	}

	// #endregion
}

export type ParseResult = {
	program: parser.Program
	diagnostics: Array<common.Diagnostic>
}

// NOTE: Parse errors are reported as Diagnostics rather than thrown — the
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

	return { program: result, diagnostics }
}

export function parse(chunk: string, options?: ParserOptions): parser.Program {
	return parseWithDiagnostics(chunk, options).program
}

// NOTE: A bare run of Statements rather than a Program — what an `@example`
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
