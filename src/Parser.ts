declare let require: (string) => any

let debugTokens = false
let debugIndividualNodes = false
let debugNodes = false

type tokenSequenceMatch = {
	foundSequence: Array<any>
	tokens: Array<IToken>
}

type parserResult = {
	foundSequence: Array<any>
	node: IASTNode | undefined
	tokens: Array<IToken>
}

type parser = (tokens: Array<IToken>) => parserResult

type nodeGenerator = (foundSequence: Array<any>) => IASTNode

import {
	IToken,
	IAST,
	ASTType,
	IASTNode,
	IStatementNode,
	ITypeNode,
	IValueNode,
	IStringLiteralNode,
	IParameterNode,
	IParameterListNode,
	IUnnamedArgumentListNode,
	INamedArgumentNode,
	INamedArgumentListNode,
	IPackageAssignmentStatementNode,
	IImportStatementNode,
	IPropertyDeclarationNode,
	IFunctionDefinitionNode,
	IFunctionInvocationNode,
	INativeFunctionInvocationNode,
	IMethodDefinitionNode,
	IReturnStatementNode,
	IDeclarationStatementNode,
	IAssignmentStatementNode,
	ITypeDefinitionStatementNode,
	IIdentifierNode,
	IExpressionNode,
	ILookupNode,
} from './Interfaces'

interface IParser {
	isOptional?: boolean
	canRepeat?: boolean
	tokenType?: string
	content?: string
	parser?: Function | Array<Function>
}

/*
	1. Parser Generators
*/

let combineMultiTokenOperators = (tokens: Array<IToken>): Array<IToken> => {
	for (let i = 0; i < tokens.length; i++) {
		let token = tokens[i]
		let nextToken = tokens[i + 1]

		if (token.content === '@') {
			if (nextToken.content === '@') {
				token.content = '@@'
				token.tokenType = 'Operator'
				tokens.splice(i + 1, 1)
			}
		}

		if (token.content === '-') {
			if (nextToken.content === '>') {
				token.content = '->'
				token.tokenType = 'Operator'
				tokens.splice(i + 1, 1)
			}
		}

		if (token.content === ':') {
			if (nextToken.content === ':') {
				token.content = '::'
				token.tokenType = 'Operator'
				tokens.splice(i + 1, 1)
			}
		}
	}

	return tokens
}

let matchToken = (token: any, tokenDefinition: any): boolean => {
	if (!tokenDefinition.isOptional && token == null) {
		return false
	}

	for (let definitionKey in tokenDefinition) {
		if (definitionKey === 'isOptional') {
			if (token == null) {
				return false
			} else {
				continue
			}
		}

		if (token[definitionKey] == null) {
			return false
		}

		for (let tokenKey in tokenDefinition[definitionKey]) {
			if (token[definitionKey] !== tokenDefinition[definitionKey]) {
				return false
			}
		}
	}

	return true
}

let matchTokenSequence = (tokens: Array<IToken>, tokenDefinitions: Array<IParser>): tokenSequenceMatch => {
	let originalTokens = tokens.slice(0)
	let hasOptionalTokens = false
	if (tokenDefinitions.length > tokens.length) {
		for (let tokenDefinition of tokenDefinitions) {
			if (tokenDefinition.isOptional) {
				hasOptionalTokens = true
				break
			}
		}

		if (!hasOptionalTokens) {
			return { foundSequence: [], tokens }
		}
	}

	let definitionIndex = 0,
		tokenIndex = 0

	for (; definitionIndex < tokenDefinitions.length; definitionIndex++) {
		let currentToken = tokens[tokenIndex],
			currentDefinition = tokenDefinitions[definitionIndex]

		if (currentDefinition.parser) {
			let parsers: Array<Function>
			if (typeof currentDefinition.parser === 'function') {
				parsers = [currentDefinition.parser]
			} else {
				parsers = currentDefinition.parser
			}

			let foundMatch = false

			for (let parser of parsers) {
				let subTokens = tokens.slice(tokenIndex)
				let { foundSequence, node, tokens: newTokens } = parser(subTokens)

				if (foundSequence.length) {
					foundMatch = true
					tokens = [...tokens.slice(0, tokenIndex), node, ...newTokens]

					if (currentDefinition.canRepeat) {
						definitionIndex--
					}
					break
				}
			}

			if (!foundMatch) {
				if (currentDefinition.isOptional) {
					tokenIndex--
				} else {
					return { foundSequence: [], tokens: originalTokens }
				}
			}
		} else {
			if (matchToken(currentToken, currentDefinition)) {
				if (currentDefinition.canRepeat) {
					definitionIndex--
				}
			} else {
				if (currentDefinition.isOptional) {
					tokenIndex--
				} else {
					return { foundSequence: [], tokens: originalTokens }
				}
			}
		}

		tokenIndex++
	}

	return { foundSequence: tokens.slice(0, tokenIndex), tokens }
}

let sequenceParserGenerator = (parsers: Array<IParser | Function>, nodeGenerator: nodeGenerator): parser => {
	return (tokens: Array<IToken>) => {
		let sequence: Array<IParser> = []

		for (let parser of parsers) {
			if (typeof parser === 'function') {
				sequence.push({ parser })
			} else {
				sequence.push(parser)
			}
		}

		let foundSequence: Array<any>
		let node: IASTNode | undefined = undefined

		;({ foundSequence, tokens } = matchTokenSequence(tokens, sequence))

		if (foundSequence.length) {
			node = nodeGenerator(foundSequence)

			if (debugIndividualNodes) {
				console.log(require('util').inspect(node, { showHidden: false, depth: null }))
				console.log()
			}

			tokens = tokens.slice(foundSequence.length)
		}

		return {
			foundSequence, node, tokens
		}
	}
}

let choiceParserGenerator = (parsers: Array<Function>): parser => {
	return (tokens: Array<IToken>) => {
		let foundSequence: Array<any>, node: IASTNode

		for(let parser of parsers) {
			;({ foundSequence, node, tokens } = parser(tokens))

			if (node) {
				// No token slicing needed here, we are using the results of parsers that already sliced
				return {
					foundSequence, node, tokens,
				}
			}
		}

		return {
			foundSequence: [] as Array<any>, node: undefined, tokens,
		}
	}
}

/*
	2. Parsers
*/

/*
	2.1 Helpers
*/

let generateTypeNode = (type: string): ITypeNode => {
	return {
		nodeType: "TypeDeclaration",
		name: {
			nodeType: "Identifier",
			content: type
		}
	}
}

/*
	2.1.1 General Helpers
*/

let typeDeclaration = (tokens: Array<IToken>): parserResult => {
	const parser = sequenceParserGenerator(
		[
			{ parser: identifier, },
		],
		(foundSequence) => {
			return {
				nodeType: 'TypeDeclaration',
				name: foundSequence[0],
			}
		}
	)

	return parser(tokens)
}

/*
	2.1.2 Function Definition & Invocation Helpers
*/

let parameter = (tokens: Array<IToken>): parserResult => {
	const parser = sequenceParserGenerator(
		[
			{ parser: identifier, },
			{ parser: typeDeclaration, },
		],
		(foundSequence) => {
			return {
				nodeType: 'Parameter',
				name: foundSequence[0],
				type: foundSequence[1],
			}
		}
	)

	return parser(tokens)
}

let parameterList = (tokens: Array<IToken>): parserResult => {
	const parser = choiceParserGenerator(
		[
			sequenceParserGenerator(
				[
					{ tokenType: 'Delimiter', content: '(', },
					{
						isOptional: true,
						parser: sequenceParserGenerator(
							[
								{ parser: parameter, },
								{ isOptional: true, tokenType: 'Delimiter', content: ',', },
							],
							(foundSequence) => {
								return foundSequence[0]
							}
						),
					},
					{ tokenType: 'Delimiter', content: ')', },
				],
				(foundSequence) => {
					return {
						nodeType: 'ParameterList',
						arguments: foundSequence.slice(1, foundSequence.length - 1),
					}
				}
			),

			sequenceParserGenerator(
				[
					{ tokenType: 'Delimiter', content: '(', },
					{ parser: parameter, },
					{
						isOptional: true,
						canRepeat: true,
						parser: sequenceParserGenerator(
							[
								{ tokenType: 'Delimiter', content: ',', },
								{ parser: parameter, },
							],
							(foundSequence) => {
								return foundSequence[1]
							}
						),
					},
					{ isOptional: true, tokenType: 'Delimiter', content: ',', },
					{ tokenType: 'Delimiter', content: ')', },
				],
				(foundSequence) => {
					return {
						nodeType: 'ParameterList',
						arguments: foundSequence.slice(1, foundSequence.length - 1),
					}
				}
			),
		]
	)

	return parser(tokens)
}

let namedArgument = (tokens: Array<IToken>): parserResult => {
	const parser = sequenceParserGenerator(
		[
			{ parser: identifier, },
			{ tokenType: 'Delimiter', content: '=', },
			{ parser: expression, },
		],
		(foundSequence) => {
			return {
				nodeType: 'NamedArgument',
				name: foundSequence[0],
				value: foundSequence[2],
			}
		}
	)

	return parser(tokens)
}

let namedArgumentList = (tokens: Array<IToken>): parserResult => {
	const parser = sequenceParserGenerator(
		[
			{ tokenType: 'Delimiter', content: '{', },
			{ isOptional: true, parser: namedArgument, },
			{ tokenType: 'Delimiter', content: '}', },
		],
		(foundSequence) => {
			return {
				nodeType: 'NamedArgumentList',
				arguments: foundSequence.slice(1, foundSequence.length - 1),
			}
		}
	)

	return parser(tokens)
}

let unnamedArgumentList = (tokens: Array<IToken>): parserResult => {
	const parser = choiceParserGenerator(
		[
			sequenceParserGenerator(
				[
					{ tokenType: 'Delimiter', content: '(', },
					{
						isOptional: true,
						parser: sequenceParserGenerator(
							[
								{ parser: expression, },
								{ isOptional: true, tokenType: 'Delimiter', content: ',', },
							],
							(foundSequence) => {
								return foundSequence[0]
							}
						),
					},
					{ tokenType: 'Delimiter', content: ')', },
				],
				(foundSequence) => {
					return {
						nodeType: 'UnnamedArgumentList',
						arguments: foundSequence.slice(1, foundSequence.length - 1),
					}
				}
			),

			sequenceParserGenerator(
				[
					{ tokenType: 'Delimiter', content: '(', },
					{ parser: expression, },
					{
						isOptional: true,
						canRepeat: true,
						parser: sequenceParserGenerator(
							[
								{ tokenType: 'Delimiter', content: ',', },
								{ parser: expression, },
							],
							(foundSequence) => {
								return foundSequence[1]
							}
						),
					},
					{ isOptional: true, tokenType: 'Delimiter', content: ',', },
					{ tokenType: 'Delimiter', content: ')', },
				],
				(foundSequence) => {
					return {
						nodeType: 'UnnamedArgumentList',
						arguments: foundSequence.slice(1, foundSequence.length - 1),
					}
				}
			),
		]
	)

	return parser(tokens)
}

/*
	2.1.3 Type Definition Helpers
*/

let propertyDeclaration = (tokens: Array<IToken>): parserResult => {
	const parser = sequenceParserGenerator(
		[
			{ parser: identifier, },
			{ parser: typeDeclaration, },
			{ tokenType: 'Linebreak', },
		],
		(foundSequence) => {
			return {
				nodeType: 'PropertyDeclaration',
				name: foundSequence[0],
				type: foundSequence[1],
			}
		}
	)

	return parser(tokens)
}

let methodDefinition = (tokens: Array<IToken>): parserResult => {
	const parser = sequenceParserGenerator(
		[
			{ parser: identifier, },
			{ parser: functionDefinition, },
		],
		(foundSequence) => {
			return {
				nodeType: 'MethodDefinition',
				name: foundSequence[0],
				function: foundSequence[1],
			}
		}
	)

	return parser(tokens)
}

/*
	2.2 Expressions
*/

/*
	2.2.1 Literals
*/

let value = (tokens: Array<IToken>): parserResult => {
	const parser = choiceParserGenerator(
		[
			sequenceParserGenerator(
				[
					{ parser: functionDefinition },
				],
				(foundSequence) => {
					return {
						nodeType: 'Value',
						type: generateTypeNode('Function'),
						value: foundSequence[0],
						members: {},
					}
				}
			),

			sequenceParserGenerator(
				[
					{ tokenType: 'Boolean', },
				],
				(foundSequence) => {
					return {
						nodeType: 'Value',
						type: generateTypeNode('Bool'),
						value: foundSequence[0].content,
						members: {},
					}
				}
			),

			sequenceParserGenerator(
				[
					{ tokenType: 'String', },
				],
				(foundSequence) => {
					return {
						nodeType: 'Value',
						type: generateTypeNode('String'),
						value: foundSequence[0].content,
						members: {},
					}
				}
			),
		]
	)

	return parser(tokens)
}

/*
	2.2.2 General
*/

let identifier = (tokens: Array<IToken>): parserResult => {
	const parser = sequenceParserGenerator(
		[
			{ tokenType: 'Identifier', },
		],
		(foundSequence) => {
			return {
				nodeType: 'Identifier',
				content: foundSequence[0].content,
			}
		}
	)

	return parser(tokens)
}

let lookup = (tokens: Array<IToken>): parserResult => {
	const parser = sequenceParserGenerator(
		[
			{
				parser: choiceParserGenerator([
					identifier,
				]),
			},
			{ tokenType: 'Delimiter', content: '.', },
			{ parser: identifier, },
		],
		(foundSequence) => {
			return {
				nodeType: 'Lookup',
				base: foundSequence[0],
				member: foundSequence[2],
			}
		}
	)

	return parser(tokens)
}

let functionDefinition = (tokens: Array<IToken>): parserResult => {
	const parser = sequenceParserGenerator(
		[
			{ parser: parameterList, },
			{ tokenType: 'Operator', content: '->', },
			{ parser: typeDeclaration, },
			{ tokenType: 'Linebreak', },
			{ isOptional: true, canRepeat: true, parser: statement, },
			{ tokenType: 'Keyword', content: 'end', },
			{ tokenType: 'Linebreak', },
		],
		(foundSequence) => {
			return {
				nodeType: 'FunctionDefinition',
				parameters: foundSequence[0],
				returnType: foundSequence[2],
				body: foundSequence.slice(4, foundSequence.length - 2),
			}
		}
	)

	return parser(tokens)
}

let namedFunctionInvocation = (tokens: Array<IToken>): parserResult => {
	const parser = sequenceParserGenerator(
		[
			{
				parser: choiceParserGenerator([
					lookup,
					identifier,
				]),
			},
			{ parser: namedArgumentList, },
			{ isOptional: true, tokenType: 'Linebreak', },
		],
		(foundSequence) => {
			return {
				nodeType: 'FunctionInvocation',
				name: foundSequence[0],
				arguments: foundSequence[1],
			}
		}
	)

	return parser(tokens)
}

let unnamedFunctionInvocation = (tokens: Array<IToken>): parserResult => {
	const parser = sequenceParserGenerator(
		[
			{
				parser: choiceParserGenerator([
					lookup,
					identifier,
				]),
			},
			{ parser: unnamedArgumentList, },
			{ isOptional: true, tokenType: 'Linebreak', },
		],
		(foundSequence) => {
			return {
				nodeType: 'FunctionInvocation',
				name: foundSequence[0],
				arguments: foundSequence[1],
			}
		}
	)

	return parser(tokens)
}

let nativeFunctionInvocation = (tokens: Array<IToken>): parserResult => {
	const parser = sequenceParserGenerator(
		[
			{ tokenType: 'Operator', content: '@@', },
			{
				parser: choiceParserGenerator([
					lookup,
					identifier,
				]),
			},
			{ parser: unnamedArgumentList, },
			{ isOptional: true, tokenType: 'Linebreak', },
		],
		(foundSequence) => {
			return {
				nodeType: 'NativeFunctionInvocation',
				name: foundSequence[1],
				arguments: foundSequence[2],
			}
		}
	)

	return parser(tokens)
}

let expression = (tokens: Array<IToken>): parserResult => {
	const parser = choiceParserGenerator(
		[
			namedFunctionInvocation,
			unnamedFunctionInvocation,
			nativeFunctionInvocation,
			lookup,
			identifier,
			value,
		]
	)

	return parser(tokens)
}

/*
	2.3 Statements
*/

let packageAssignmentStatement = (tokens: Array<IToken>): parserResult => {
	const parser = sequenceParserGenerator(
		[
			{ tokenType: 'Keyword', content: 'package', },
			{ tokenType: 'String', },
			{ tokenType: 'Linebreak', },
		],
		(foundSequence) => {
			return {
				nodeType: 'PackageAssignmentStatement',
				name: foundSequence[1].content,
			}
		}
	)

	return parser(tokens)
}

let typeDefinitionStatement = (tokens: Array<IToken>): parserResult => {
	const parser = sequenceParserGenerator(
		[
			{ tokenType: 'Keyword', content: 'type', },
			{ parser: identifier, },
			{ tokenType: 'Linebreak', },
			{
				isOptional: true,
				canRepeat: true,
				parser: choiceParserGenerator([
					propertyDeclaration,
					methodDefinition,
				]),
			},
			{ tokenType: 'Keyword', content: 'end', },
			{ tokenType: 'Linebreak', },
		],
		(foundSequence) => {
			let propertyFilter = (node: IASTNode) => {
				return node.nodeType === 'PropertyDeclaration'
			}

			let methodFilter = (node: IASTNode) => {
				return node.nodeType === 'MethodDefinition'
			}


			return {
				nodeType: 'TypeDefinitionStatement',
				name: <IIdentifierNode>(foundSequence[1]),
				properties: (<IPropertyDeclarationNode[]>foundSequence).filter(propertyFilter),
				methods: (<IMethodDefinitionNode[]>foundSequence).filter(methodFilter),
			}
		}
	)

	return parser(tokens)
}

let importStatement = (tokens: Array<IToken>): parserResult => {
	const parser = sequenceParserGenerator(
		[
			{ tokenType: 'Keyword', content: 'import', },
			{ tokenType: 'String', },
			{ tokenType: 'Keyword', content: 'as', },
			{ parser: identifier, },
			{ tokenType: 'Linebreak', },
		],
		(foundSequence) => {
			return {
				nodeType: 'ImportStatement',
			}
		}
	)

	return parser(tokens)
}

let returnStatement = (tokens: Array<IToken>): parserResult => {
	const parser = sequenceParserGenerator(
		[
			{ tokenType: 'Keyword', content: 'return' },
			{ parser: expression },
			{ isOptional: true, tokenType: 'Linebreak' },
		],
		(foundSequence) => {
			return {
				nodeType: 'ReturnStatement',
				expression: foundSequence[1],
			}
		}
	)

	return parser(tokens)
}

let declarationStatement = (tokens: Array<IToken>): parserResult => {
	const parser = sequenceParserGenerator(
		[
			{ tokenType: 'Keyword', content: 'let', },
			{ parser: identifier, },
			{ parser: typeDeclaration, },
			{ tokenType: 'Delimiter', content: '=', },
			{ parser: expression, },
			{ isOptional: true, tokenType: 'Linebreak', },
		],
		(foundSequence) => {
			return {
				nodeType: 'DeclarationStatement',
				name: foundSequence[1],
				type: foundSequence[2],
				value: foundSequence[4],
			}
		}
	)

	return parser(tokens)
}

let assignmentStatement = (tokens: Array<IToken>): parserResult => {
	const parser = sequenceParserGenerator(
		[
			{ parser: identifier, },
			{ tokenType: 'Delimiter', content: '=', },
			{ parser: expression, },
			{ isOptional: true, tokenType: 'Linebreak', },
		],
		(foundSequence) => {
			return {
				nodeType: 'AssignmentStatement',
				name: foundSequence[0],
				value: foundSequence[2],
			}
		}
	)

	return parser(tokens)
}

let statement = (tokens: Array<IToken>): parserResult => {
	const parser = choiceParserGenerator(
		[
			packageAssignmentStatement,
			importStatement,
			typeDefinitionStatement,
			declarationStatement,
			assignmentStatement,
			returnStatement,
			expression,
		]
	)

	return parser(tokens)
}

/*
	3. Public Interface
*/

let parseProgram = (tokens: Array<IToken>): IAST => {
	let nodes: Array<IASTNode> = []

	tokens = combineMultiTokenOperators(tokens)

	if (debugTokens) {
		console.log(tokens.length)
		console.log(tokens)
		console.log()
		console.log()
	}

	// Handle rest of the program
	while (tokens.length) {
		let foundSequence: Array<any>, node: IASTNode | undefined
		;({ foundSequence, node, tokens, } = statement(tokens))

		if (node) {
			nodes.push(node)
		} else {
			// TODO: Handle Error -> Syntax could be lexed but not parsed
			// TODO: How can we be helpful with this error, aside from line & column?
			break
		}
	}

	if (debugNodes) {
		console.log(nodes.length)
		console.log(nodes)
		console.log()
		console.log()
	}

	return {
		nodes,
	}
}

export let parse = (tokens: Array<IToken>): IAST => {
	return parseProgram(tokens)
}