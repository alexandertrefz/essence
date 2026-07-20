// NOTE: Hand-written recursive descent parser — the default parser of the
// compiler, re-exported through src/parser. It reuses the node generators,
// keeping its ASTs identical to the ones the nearley parser produced.
import { collectDiagnostics, reportError } from "../../diagnostics/index"
import { type common, lexer, type parser } from "../../interfaces/index"
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
>[3][number]

// NOTE: These token types form the Identifier rule of the grammar — the
// keywords `with`, `static`, `case` and `infer` are valid Identifiers.
const identifierTokenTypes = [
	TokenType.Identifier,
	TokenType.KeywordWith,
	TokenType.KeywordStatic,
	TokenType.KeywordCase,
	TokenType.KeywordInfer,
]

function isIdentifierToken(token: Token | undefined): boolean {
	return token !== undefined && identifierTokenTypes.includes(token.type)
}

// NOTE: The Token types that begin a literal Matcher — `case 0`, `case 1/2`,
// `case "a"`. Everything else in Matcher position is read as a Type.
const literalMatcherTokenTypes = [
	TokenType.LiteralNumber,
	TokenType.SymbolDash,
	TokenType.LiteralString,
	TokenType.LiteralTrue,
	TokenType.LiteralFalse,
	TokenType.LiteralNothing,
]

// NOTE: The Token types that can begin a Statement — these are the
// resynchronisation points after a parse error.
const statementStartTokenTypes = [
	TokenType.KeywordConstant,
	TokenType.KeywordVariable,
	TokenType.KeywordFunction,
	TokenType.KeywordNamespace,
	TokenType.KeywordType,
	TokenType.KeywordIf,
	TokenType.KeywordMatch,
	TokenType.KeywordCase,
	TokenType.KeywordImplementation,
	TokenType.KeywordOverload,
	TokenType.KeywordStatic,
]

class DescentParser {
	protected tokens: TokenStream
	protected suppressDiagnostics: boolean

	constructor(source: string) {
		this.tokens = new TokenStream(source)

		// NOTE: A Lexer error truncates the Token stream, so every
		// end-of-input error after it would only be a cascade of the already
		// reported problem.
		this.suppressDiagnostics = this.tokens.hadLexerError
	}

	// #region Program & Sections

	parseProgram(): parser.Program {
		let keyword = this.parseProgramHeader()

		if (keyword === null) {
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

		let nodes = this.parseStatementList(() =>
			this.parseImplementationNode(),
		)
		let closingPosition = this.parseClosingBrace()

		if (!this.tokens.isAtEnd() && !this.suppressDiagnostics) {
			let token = this.peekOrFail()

			reportError(`Unexpected ${describeToken(token)}.`, token.position)
		}

		let implementation = generators.implementationSection(nodes, {
			start: keyword.position.start,
			end: closingPosition.end,
		})

		return generators.program(implementation, implementation.position)
	}

	protected parseProgramHeader(): Token | null {
		try {
			let keyword = this.tokens.expect(TokenType.KeywordImplementation)

			this.tokens.expect(TokenType.SymbolLeftBrace)

			return keyword
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

		if (!this.suppressDiagnostics) {
			reportError(error.message, error.position)
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

	protected parseClosingBrace(): common.Position {
		let token = this.tokens.peek()

		if (token !== undefined && token.type === TokenType.SymbolRightBrace) {
			this.tokens.next()

			return token.position
		}

		// NOTE: Only the innermost torn-open block reports — a missing `}`
		// necessarily tears open every enclosing block as well.
		if (!this.suppressDiagnostics) {
			reportError(
				"Expected '}' but found end of input.",
				this.tokens.endPosition(),
			)

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
			case TokenType.KeywordIf:
				return this.parseIfStatement()
			case TokenType.KeywordFunction:
				return this.parseFunctionStatement()
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

		return generators.typeAliasStatement(
			name,
			generics,
			type,
			{ start: keyword.position.start, end: type.position.end },
			this.tokens.documentationAbove(keyword.position.start.line),
		)
	}

	protected parseFunctionStatement(): parser.FunctionStatementNode {
		let keyword = this.tokens.expect(TokenType.KeywordFunction)
		let name = this.parseIdentifier()
		let value = this.parseOptionallyGenericFunctionLiteral()

		return generators.functionStatement(name, value.value, {
			start: keyword.position.start,
			end: value.position.end,
		})
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

		this.tokens.expect(TokenType.SymbolLeftBrace)

		let body = this.parseStatementList(() => this.parseNamespaceBodyNode())
		let closingPosition = this.parseClosingBrace()

		return generators.namespaceDefinitionStatement(
			name,
			generics,
			targetType,
			body,
			{
				start: keyword.position.start,
				end: closingPosition.end,
			},
			this.tokens.documentationAbove(keyword.position.start.line),
		)
	}

	protected parseNamespaceBodyNode(): NamespaceBodyNode {
		let token = this.peekOrFail()

		if (token.type === TokenType.KeywordOverload) {
			// NOTE: A block level `§§` documents the Overload set as a whole;
			// each Overload inside it picks up its own from its first line.
			let documentation = this.tokens.documentationAbove(
				token.position.start.line,
			)

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

			this.tokens.expect(TokenType.SymbolLeftBrace)

			let methods = this.parseStatementList(() =>
				this.parseOptionallyGenericFunctionLiteral(),
			)

			this.parseClosingBrace()

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
				return {
					nodeType: "StaticMethodNode",
					name,
					method: this.parseOptionallyGenericFunctionLiteral(),
				}
			}

			let type = this.parseOptionalDeclarationType()

			this.tokens.expect(TokenType.SymbolEqual)

			let value = this.parseExpression()

			return { nodeType: "NamespacePropertyNode", name, type, value }
		}

		let name = this.parseIdentifier()

		return {
			nodeType: "SimpleMethodNode",
			name,
			method: this.parseOptionallyGenericFunctionLiteral(),
		}
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
			case TokenType.KeywordMatch:
				return this.parseMatch()
			case TokenType.SymbolAt:
				this.tokens.next()
				return generators.self(token.position)
			case TokenType.LiteralString:
				this.tokens.next()
				return generators.stringValueNode(token.value, token.position)
			case TokenType.SymbolDash:
			case TokenType.LiteralNumber:
				return this.parseNumberLiteral()
			case TokenType.LiteralTrue:
				this.tokens.next()
				return generators.booleanValueNode(true, token.position)
			case TokenType.LiteralFalse:
				this.tokens.next()
				return generators.booleanValueNode(false, token.position)
			case TokenType.LiteralNothing:
				this.tokens.next()
				return generators.nothingValueNode(token.position)
			case TokenType.SymbolLeftBracket:
				return this.parseListLiteral()
			case TokenType.SymbolLeftParen:
				return this.parseFunctionLiteral()
			case TokenType.SymbolLeftAngle:
				return this.parseGenericFunctionLiteral()
			case TokenType.SymbolLeftBrace:
				return this.parseRecordLiteralOrCombination()
			case TokenType.Identifier:
			case TokenType.KeywordWith:
			case TokenType.KeywordStatic:
			case TokenType.KeywordCase:
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

	protected parseMatch(): parser.MatchNode {
		let keyword = this.tokens.expect(TokenType.KeywordMatch)
		let value = this.parseExpression()
		let returnType = this.parseReturnType()

		this.tokens.expect(TokenType.SymbolLeftBrace)

		let handlers = this.parseStatementList(() => {
			this.tokens.expect(TokenType.KeywordCase)

			let matcher = this.parseMatcher()
			let guard = this.parseOptionalGuard()
			let block = this.parseBlock()

			return { matcher, guard, body: block.body }
		})

		let closingPosition = this.parseClosingBrace()

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

		return this.parseType()
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
			default:
				this.tokens.next()
				return generators.nothingValueNode(token.position)
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

	protected parseNumberLiteral():
		| parser.IntegerValueNode
		| parser.FractionValueNode {
		let numerator = this.parseInteger()

		if (this.tokens.peek()?.type === TokenType.SymbolSlash) {
			this.tokens.next()

			let denominator = this.parseInteger()

			return generators.fractionValueNode(
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
		let end = firstPart.position.end

		while (
			this.tokens.peek()?.type === TokenType.SymbolUnderscore &&
			this.tokens.peek(1)?.type === TokenType.LiteralNumber
		) {
			this.tokens.next()

			let part = this.tokens.next()

			value += part.value
			end = part.position.end
		}

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

	protected parseFunctionLiteral(): parser.FunctionValueNode {
		let documentation = this.documentationHere()
		let parameterList = this.parseParameterList()
		let returnType = this.parseReturnType()
		let block = this.parseBlock()

		return generators.functionValueNode(
			generators.functionDefinition(
				parameterList.parameters,
				returnType,
				block.body,
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

		if (this.tokens.peek()?.type === TokenType.SymbolEqual) {
			this.tokens.next()

			let type = this.parseType()

			return generators.genericDeclarationNode(name, type, inferred, {
				start,
				end: type.position.end,
			})
		}

		return generators.genericDeclarationNode(name, null, inferred, {
			start,
			end: name.position.end,
		})
	}

	protected parseParameterList(): {
		parameters: Array<parser.ParameterNode>
		position: common.Position
	} {
		let leftParen = this.tokens.expect(TokenType.SymbolLeftParen)

		let parameters: Array<parser.ParameterNode> = []

		if (this.tokens.peek()?.type !== TokenType.SymbolRightParen) {
			parameters.push(this.parseParameter())

			while (this.tokens.peek()?.type === TokenType.SymbolComma) {
				this.tokens.next()

				if (this.tokens.peek()?.type === TokenType.SymbolRightParen) {
					break
				}

				parameters.push(this.parseParameter())
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

	protected parseParameter(): parser.ParameterNode {
		// NOTE: Only a Parameter written on a line of its own can carry a
		// block — otherwise the first Parameter of `function greet (…)` would
		// claim the Function's own Documentation.
		let documentation = this.tokens.startsLine()
			? this.documentationHere()
			: null

		if (this.tokens.peek()?.type === TokenType.SymbolUnderscore) {
			let underscore = this.tokens.next()

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

		if (this.tokens.peek()?.type === TokenType.SymbolLeftAngle) {
			let leftAngle = this.tokens.next()

			let generics = [this.parseType()]

			while (this.tokens.peek()?.type === TokenType.SymbolComma) {
				this.tokens.next()

				if (this.tokens.peek()?.type === TokenType.SymbolRightAngle) {
					break
				}

				generics.push(this.parseType())
			}

			let rightAngle = this.tokens.expect(TokenType.SymbolRightAngle)

			return generators.genericTypeDeclaration(baseType, generics, {
				start: leftAngle.position.start,
				end: rightAngle.position.end,
			})
		}

		return baseType
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

	// #endregion

	// #region Helpers

	protected parseBlock(): BlockResult {
		let leftBrace = this.tokens.expect(TokenType.SymbolLeftBrace)

		let body = this.parseStatementList(() => this.parseImplementationNode())
		let closingPosition = this.parseClosingBrace()

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

	protected backtrack<T>(parseAttempt: () => T): T | null {
		let saved = this.tokens.save()

		try {
			return parseAttempt()
		} catch (error) {
			if (error instanceof ParseError) {
				this.tokens.restore(saved)
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
export function parseWithDiagnostics(chunk: string): ParseResult {
	let { result, diagnostics } = collectDiagnostics(() =>
		new DescentParser(chunk).parseProgram(),
	)

	return { program: result, diagnostics }
}

export function parse(chunk: string): parser.Program {
	return parseWithDiagnostics(chunk).program
}
