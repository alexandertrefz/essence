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
const identifierTokenTypes = [
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
]

function isIdentifierToken(token: Token | undefined): boolean {
	return token !== undefined && identifierTokenTypes.includes(token.type)
}

// NOTE: The Token types that begin a literal Matcher — `case 0`, `case 1/2`,
// `case "a"`. Everything else in Matcher position is read as a Type.
// `LiteralStringStart` is here only so an interpolated String reaches
// `parseLiteralMatcherValue`, which refuses it with a message about why a
// String with holes can not be matched — rather than the generic "expected a
// Type" a Type parse would give.
const literalMatcherTokenTypes = [
	TokenType.LiteralNumber,
	TokenType.SymbolDash,
	TokenType.LiteralString,
	TokenType.LiteralStringStart,
	TokenType.LiteralTrue,
	TokenType.LiteralFalse,
]

// NOTE: The Token types that can begin a Statement — these are the
// resynchronisation points after a parse error. Every Keyword
// `parseImplementationNode` dispatches on belongs here: one that is missing
// is not a Statement start to the recovery, so the whole Declaration it opens
// — braces and all — is skipped without a word.
const statementStartTokenTypes = [
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
]

// NOTE: Whether two Positions are written flush against each other, with
// neither whitespace nor a line break between them. Some of the grammar reads
// several Tokens as one lexeme — `1_000`, `1/2` — and only their adjacency
// tells that apart from the same Tokens written as separate things.
function isAdjacent(left: common.Position, right: common.Position): boolean {
	return (
		left.end.line === right.start.line &&
		left.end.column === right.start.column
	)
}

export type ParserOptions = {
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

	constructor(source: string, options: ParserOptions = {}) {
		this.tokens = new TokenStream(source)
		this.allowDeclarationsHeader = options.allowDeclarationsHeader ?? false

		// NOTE: A Lexer error truncates the Token stream, so every
		// end-of-input error after it would only be a cascade of the already
		// reported problem.
		this.suppressDiagnostics = this.tokens.hadLexerError
	}

	// #region Program & Sections

	parseProgram(): parser.Program {
		let above = this.parseModuleSections("above")
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

		let below = this.parseModuleSections("below")
		let { imports, exports } = this.resolveModuleSections(
			[...above, ...below],
			implementation.position,
		)

		if (!this.tokens.isAtEnd() && !this.suppressDiagnostics) {
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
							lastSection?.node.position ?? closingPosition,
							lastSection === undefined
								? "the implementation block ends here"
								: "the Program ends here",
						),
					],
					notes: [
						"A Program is one 'implementation { … }' block, framed by an optional 'import { … }' block above it and an optional 'export { … }' block below it.",
					],
				},
			)
		}

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

	// NOTE: `parseNativeSigilName` rather than `parseIdentifier`, because
	// `__print` lexes as two Underscore Symbols and an Identifier rather than as
	// one name — a name a Program can DECLARE has to be a name its sections can
	// spell, or the standard library's one free Function could never be exported.
	protected parseImportEntry(): parser.ImportNode {
		let name = this.parseNativeSigilName()
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
		let name = this.parseNativeSigilName()
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
				code: "syntax-error",
				labels: [],
			})

			return
		}

		reportError(error.message, error.position, {
			code: "syntax-error",
			labels:
				error.label === null
					? [primary(error.position, "here")]
					: [primary(error.position, error.label)],
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
		if (statementStartTokenTypes.includes(token.type)) {
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

	protected parseConstantDeclarationStatement(): parser.ConstantDeclarationStatementNode {
		let keyword = this.tokens.expect(TokenType.KeywordConstant)
		let name = this.parseIdentifier()
		let type = this.parseOptionalDeclarationType()

		this.tokens.expect(TokenType.SymbolEqual)

		let value = this.parseExpression()

		return generators.constantDeclarationStatement(
			name,
			type,
			value,
			{ start: keyword.position.start, end: value.position.end },
			this.tokens.documentationAbove(keyword.position.start.line),
		)
	}

	protected parseVariableDeclarationStatement(): parser.VariableDeclarationStatementNode {
		let keyword = this.tokens.expect(TokenType.KeywordVariable)
		let name = this.parseIdentifier()
		let type = this.parseOptionalDeclarationType()

		this.tokens.expect(TokenType.SymbolEqual)

		let value = this.parseExpression()

		return generators.variableDeclarationStatement(
			name,
			type,
			value,
			{ start: keyword.position.start, end: value.position.end },
			this.tokens.documentationAbove(keyword.position.start.line),
		)
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

	protected parseChoiceCase(): parser.ChoiceCaseNode {
		let name = this.parseIdentifier()
		let type: parser.RecordTypeDeclarationNode | null = null

		if (this.tokens.peek()?.type === TokenType.SymbolLeftBrace) {
			type = this.parseRecordType()
		}

		return { name, type }
	}

	protected parseFunctionStatement():
		| parser.FunctionStatementNode
		| parser.NativeFunctionStatementNode {
		let keyword = this.tokens.expect(TokenType.KeywordFunction)

		// NOTE: A `declarations { … }` Program's free `function` may be body-less
		// — a native signature bound to a runtime export by name — exactly as a
		// Namespace Method may. `parseMethodBodyOrSignature` decides which by
		// whether a block follows; the bodied branch it returns is identical to
		// what `parseOptionallyGenericFunctionLiteral` builds for a user Program.
		if (this.mode === "declarations") {
			// NOTE: `__` is the sigil for a native free Function bound to the
			// runtime — `__print` lexes as `_ _ print`, so the declaration name
			// is reassembled the same way `parseNativeFunctionInvocation` does at
			// the call site. It is the one free Function whose name a Program can
			// not spell as a bare Identifier.
			let name = this.parseNativeSigilName()
			let documentation = this.tokens.documentationAbove(
				keyword.position.start.line,
			)
			let result = this.parseMethodBodyOrSignature()

			if (result.nodeType === "NativeMethodSignature") {
				return generators.nativeFunctionStatement(
					name,
					result,
					{
						start: keyword.position.start,
						end: result.position.end,
					},
					documentation,
				)
			}

			return generators.functionStatement(name, result.value, {
				start: keyword.position.start,
				end: result.position.end,
			})
		}

		let name = this.parseIdentifier()
		let value = this.parseOptionallyGenericFunctionLiteral()

		return generators.functionStatement(name, value.value, {
			start: keyword.position.start,
			end: value.position.end,
		})
	}

	// NOTE: A free-Function declaration name, allowing the `__` native sigil that
	// `parseNativeFunctionInvocation` accepts at the call site — `__print` lexes
	// as two Underscore Symbols and an Identifier, so the `__`-prefixed name is
	// reassembled here rather than lexed whole. Without the sigil it is an
	// ordinary Identifier.
	protected parseNativeSigilName(): parser.IdentifierNode {
		if (
			this.tokens.peek()?.type === TokenType.SymbolUnderscore &&
			this.tokens.peek(1)?.type === TokenType.SymbolUnderscore
		) {
			let firstUnderscore = this.tokens.next()
			this.tokens.next()

			let name = this.parseIdentifier()

			return {
				nodeType: "Identifier",
				content: `__${name.content}`,
				position: {
					start: firstUnderscore.position.start,
					end: name.position.end,
				},
			}
		}

		return this.parseIdentifier()
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
			let block = this.parseBlock()

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

	protected parseProtocolMethodSignature(): parser.ProtocolMethodSignatureNode {
		let documentation = this.documentationHere()
		let parameterList = this.parseParameterList()
		let returnType = this.parseReturnType()

		return generators.protocolMethodSignature(
			parameterList.parameters,
			returnType,
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

	protected parseExpression(): parser.ExpressionNode {
		let expression = this.parsePrimaryExpression()

		while (true) {
			let token = this.tokens.peek()

			if (
				token?.type === TokenType.SymbolColon &&
				this.tokens.peek(1)?.type === TokenType.SymbolColon
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

		if (
			isIdentifierToken(token) ||
			token.type === TokenType.SymbolLeftBrace
		) {
			let typedRecord = this.backtrack(() =>
				this.parseTypedRecordLiteral(),
			)

			if (typedRecord !== null) {
				return typedRecord
			}
		}

		switch (token.type) {
			case TokenType.SymbolUnderscore:
				return this.parseNativeFunctionInvocation()
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
			case TokenType.SymbolLeftParen:
				// NOTE: The only Function literal whose annotations may be
				// omitted — in expression position there can be an expected
				// signature to read them off. A Generic literal writes its own
				// Generics, so it has nothing to infer them from.
				return this.parseFunctionLiteral(true)
			case TokenType.SymbolLeftAngle:
				return this.parseGenericFunctionLiteral()
			case TokenType.SymbolLeftBrace:
				return this.parseRecordLiteralOrCombination()
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
				return this.parseIdentifier()
			default:
				fail(
					`Expected an Expression but found ${describeToken(token)}.`,
					token.position,
				)
		}
	}

	protected parseNativeFunctionInvocation(): parser.NativeFunctionInvocationNode {
		let firstUnderscore = this.tokens.expect(TokenType.SymbolUnderscore)
		this.tokens.expect(TokenType.SymbolUnderscore)

		let name = this.parseIdentifier()
		let argumentList = this.parseArgumentList()

		return generators.nativeFunctionInvocation(name, argumentList.args, {
			start: firstUnderscore.position.start,
			end: argumentList.position.end,
		})
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
	protected parseMatcher(): parser.MatcherNode {
		let token = this.tokens.peek()

		if (token?.type === TokenType.SymbolUnderscore) {
			this.tokens.next()

			return generators.wildcardMatcher(token.position)
		}

		if (
			token !== undefined &&
			literalMatcherTokenTypes.includes(token.type)
		) {
			let value = this.parseLiteralMatcherValue()

			return generators.literalMatcher(value, value.position)
		}

		// NOTE: A Record in Matcher position is always a Record Matcher rather
		// than a Record Type, because only the Matcher form admits
		// `name = value` members alongside `name: Type` ones.
		if (token?.type === TokenType.SymbolLeftBrace) {
			return this.parseRecordMatcher()
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

	// NOTE: The payload binder of a Case Matcher — `case #Value(item)`. Parens
	// bind a NAME; braces are left free for the payload pattern form
	// (`case #Add { left = 0 }`), which constrains a shape instead. The two can
	// not be confused at the token level, which is the whole reason for the
	// split.
	//
	// NOTE: A Case Matcher is the only Matcher that takes one. `@` already
	// answers for every Matcher kind — the scrutinee, narrowed — so this adds a
	// second name rather than redefining the one that exists.
	protected parseCaseMatcherBinding(): parser.IdentifierNode | null {
		if (this.tokens.peek()?.type !== TokenType.SymbolLeftParen) {
			return null
		}

		this.tokens.expect(TokenType.SymbolLeftParen)

		let binding = this.parseIdentifier()

		this.tokens.expect(TokenType.SymbolRightParen)

		return binding
	}

	protected parseRecordMatcher(): parser.RecordMatcherNode {
		let leftBrace = this.tokens.expect(TokenType.SymbolLeftBrace)

		if (this.tokens.peek()?.type === TokenType.SymbolRightBrace) {
			let rightBrace = this.tokens.next()

			return generators.recordMatcher(
				{},
				{
					start: leftBrace.position.start,
					end: rightBrace.position.end,
				},
			)
		}

		let members = [this.parseRecordMatcherMember()]

		while (this.tokens.peek()?.type === TokenType.SymbolComma) {
			this.tokens.next()

			if (this.tokens.peek()?.type === TokenType.SymbolRightBrace) {
				break
			}

			members.push(this.parseRecordMatcherMember())
		}

		let rightBrace = this.tokens.expect(TokenType.SymbolRightBrace)

		this.reportDuplicateNames(
			members.map(([, member]) => member),
			"Member",
			"duplicate-member",
		)

		return generators.recordMatcher(Object.fromEntries(members), {
			start: leftBrace.position.start,
			end: rightBrace.position.end,
		})
	}

	// NOTE: `name: Type` constrains a member by Type, `name = value` by value.
	// The two mix freely inside one Matcher.
	protected parseRecordMatcherMember(): [
		string,
		parser.RecordMatcherMemberNode,
	] {
		let name = this.parseIdentifier()

		if (this.tokens.peek()?.type === TokenType.SymbolEqual) {
			this.tokens.next()

			return [
				name.content,
				{ kind: "Value", name, value: this.parseLiteralMatcherValue() },
			]
		}

		this.tokens.expect(TokenType.SymbolColon)

		return [name.content, { kind: "Type", name, type: this.parseType() }]
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

		let keyValuePairList = this.parseKeyValuePairList()
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
			let keyValuePairList = this.parseKeyValuePairList()
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

		let keyValuePairCombination = this.backtrack(() => {
			let keyValuePairList = this.parseKeyValuePairList()
			this.tokens.expect(TokenType.SymbolRightBrace)

			return generators.combination(
				lhs,
				generators.recordValueNode(
					null,
					keyValuePairList.data,
					keyValuePairList.position,
				),
				{
					start: lhs.position.start,
					end: keyValuePairList.position.end,
				},
			)
		})

		if (keyValuePairCombination !== null) {
			return keyValuePairCombination
		}

		let rhs = this.parseExpression()
		this.tokens.expect(TokenType.SymbolRightBrace)

		return generators.combination(lhs, rhs, {
			start: lhs.position.start,
			end: rhs.position.end,
		})
	}

	protected parseKeyValuePairList(): ReturnType<
		typeof generators.buildKeyValuePairList
	> {
		let pairs = [this.parseKeyValuePair()]

		while (this.tokens.peek()?.type === TokenType.SymbolComma) {
			this.tokens.next()

			if (this.tokens.peek()?.type === TokenType.SymbolRightBrace) {
				break
			}

			pairs.push(this.parseKeyValuePair())
		}

		this.reportDuplicateNames(pairs, "Member", "duplicate-member")

		return generators.buildKeyValuePairList(
			pairs.slice(0, -1),
			pairs[pairs.length - 1],
		)
	}

	protected parseKeyValuePair(): ReturnType<typeof generators.keyValuePair> {
		let name = this.parseIdentifier()

		this.tokens.expect(TokenType.SymbolEqual)

		let value = this.parseExpression()

		return generators.keyValuePair(name, value, {
			start: name.position.start,
			end: value.position.end,
		})
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

	protected parseFunctionLiteral(
		allowsInferredTypes = false,
	): parser.FunctionValueNode {
		let documentation = this.documentationHere()
		let parameterList = this.parseParameterList(allowsInferredTypes)
		let returnType = this.parseOptionalReturnType(allowsInferredTypes)
		let block = this.parseBlock()

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

	protected parseGenericFunctionLiteral(): parser.FunctionValueNode {
		let documentation = this.documentationHere()
		let genericList = this.parseGenericList()
		let parameterList = this.parseParameterList()
		let returnType = this.parseReturnType()
		let block = this.parseBlock()

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
	protected parseParameter(
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

		if (this.tokens.peek()?.type === TokenType.SymbolUnderscore) {
			let underscore = this.tokens.next()

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

	protected parseArgument(): parser.ArgumentNode {
		if (isIdentifierToken(this.tokens.peek())) {
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
		let leftBrace = this.tokens.expect(TokenType.SymbolLeftBrace)

		let body = this.parseStatementList(() => this.parseImplementationNode())
		let closingPosition = this.parseClosingBrace(leftBrace.position)

		return {
			body,
			position: {
				start: leftBrace.position.start,
				end: closingPosition.end,
			},
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

	// NOTE: A speculation that is thrown away must leave nothing behind — not
	// the Tokens it read and not the Diagnostics it reported, which are about
	// a shape the Program was never in. The same text is often read twice
	// (a typed Record Literal, then a Record Literal), and only the reading
	// that is kept gets to report on it.
	protected backtrack<T>(parseAttempt: () => T): T | null {
		let saved = this.tokens.save()
		let diagnosticMark = markDiagnostics()

		try {
			return parseAttempt()
		} catch (error) {
			if (error instanceof ParseError) {
				this.tokens.restore(saved)
				rewindDiagnostics(diagnosticMark)

				return null
			}

			throw error
		}
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
