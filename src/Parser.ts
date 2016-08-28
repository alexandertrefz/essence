/// <reference path="../typings/index.d.ts" />

let debugTokens = false
let debugIndividualNodes = false
let debugNodes = false


import {
	IToken,
	IAST,
	IASTNode,
	IStatementNode,
	ITypeNode,
	IValueNode,
	IParameterNode,
	IParameterListNode,
	IArgumentListNode,
	IFunctionDefinitionNode,
	IFunctionInvocationNode,
	INativeFunctionInvocationNode,
	IReturnStatementNode,
	IDeclarationStatementNode,
	IAssignmentStatementNode,
	IIdentifierNode,
	IExpressionNode,
	ILookupNode,
	IIfElseStatementNode,
} from './Interfaces'

type tokenSequenceMatch = {
	foundSequence: Array<IToken | IASTNode | null>
	tokens: Array<IToken>
}; // This semicolon is strategically placed to fix a bug in TSLint.
//    Removing it causes TSLint to declare missing commas on places
//    where no comma is missing.
//    I don't know why this semicolon fixes that bug, but it does.

type parserResult = {
	foundSequence: Array<IToken | IASTNode>
	node: IASTNode | undefined
	tokens: Array<IToken>
}

type statementParserResult = {
	foundSequence: Array<IToken | IASTNode>
	node: IStatementNode | IExpressionNode | undefined
	tokens: Array<IToken>
}

type parser = (tokens: Array<IToken>) => parserResult

type nodeGenerator = (foundSequence: Array<any>) => IASTNode

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
	}

	return tokens
}

let matchToken = (token: IToken, tokenDefinition: IParser): boolean => {
	if (!tokenDefinition.isOptional && token == null) {
		return false
	}

	for (let definitionKey in tokenDefinition) {
		if (!tokenDefinition.hasOwnProperty(definitionKey)) {
			continue
		}

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

		/* tslint:disable */
		for (let tokenKey in tokenDefinition[definitionKey]) {
			if (token[definitionKey] !== tokenDefinition[definitionKey]) {
				return false
			}
		}
		/* tslint:enable */
	}

	return true
}

let matchRepeatingParser = (tokens: Array<IToken>, tokenDefinition: IParser) => {
	let defaultResult = { nodes: [], tokens, }
	let newTokenDefinition = [Object.assign({}, tokenDefinition, { canRepeat: false, })]
	let newTokens = tokens.slice(0)

	let nodes: Array<IASTNode> = []

	while (true) {
		let foundSequence
		; ({ foundSequence, tokens: newTokens, } = matchTokenSequence(newTokens, newTokenDefinition))

		newTokens = newTokens.slice(1)

		if (foundSequence[0] !== null) {
			nodes.push(foundSequence[0])
		} else {
			if (nodes.length) {
				return { nodes, tokens: newTokens, }
			} else {
				return defaultResult
			}
		}
	}
}

let matchTokenSequence = (tokens: Array<IToken>, tokenDefinitions: Array<IParser>): tokenSequenceMatch => {
	let originalTokens = tokens.slice(0)
	let defaultResult = { foundSequence: [], tokens: originalTokens, }
	let hasOptionalTokens = false

	if (tokenDefinitions.length > tokens.length) {
		for (let tokenDefinition of tokenDefinitions) {
			if (tokenDefinition.isOptional) {
				hasOptionalTokens = true
				break
			}
		}

		if (!hasOptionalTokens) {
			return defaultResult
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

			if (currentDefinition.canRepeat) {
				let {
					nodes,
					tokens: newTokens,
				} = matchRepeatingParser(tokens.slice(tokenIndex), currentDefinition)

				if (nodes.length === 0) {
					if (!currentDefinition.isOptional) {
						return defaultResult
					} else {
						tokens = [...tokens.slice(0, tokenIndex), null as any, ...tokens.slice(tokenIndex)]
					}
				} else {
					tokens = [...tokens.slice(0, tokenIndex), nodes as any, ...newTokens]
					tokenIndex++
					continue
				}
			}

			let foundMatch = false

			for (let parser of parsers) {
				let subTokens = tokens.slice(tokenIndex)
				let { foundSequence, node, tokens: newTokens, } = parser(subTokens)

				if (node) {
					foundMatch = true
					tokens = [...tokens.slice(0, tokenIndex), node, ...newTokens]
					break
				}
			}

			if (!foundMatch) {
				if (currentDefinition.isOptional) {
					tokens = [...tokens.slice(0, tokenIndex), null as any, ...tokens.slice(tokenIndex)]
				} else {
					return defaultResult
				}
			}
		} else {
			if (!matchToken(currentToken, currentDefinition)) {
				if (currentDefinition.isOptional) {
					tokens = [...tokens.slice(0, tokenIndex), null as any, ...tokens.slice(tokenIndex)]
				} else {
					return defaultResult
				}
			}
		}

		tokenIndex++
	}

	return { foundSequence: tokens.slice(0, tokenIndex), tokens, }
}

let sequenceParserGenerator = (parsers: Array<IParser | Function>, nodeGenerator: nodeGenerator): parser => {
	return (tokens: Array<IToken>) => {
		let sequence: Array<IParser> = []

		for (let parser of parsers) {
			if (typeof parser === 'function') {
				sequence.push({ parser, })
			} else {
				sequence.push(parser)
			}
		}

		let foundSequence: Array<any>
		let node: IASTNode | undefined = undefined

		; ({ foundSequence, tokens, } = matchTokenSequence(tokens, sequence))

		if (foundSequence.length) {
			node = nodeGenerator(foundSequence)

			if (debugIndividualNodes) {
				console.log(require('util').inspect(node, { showHidden: false, depth: null, }))
				console.log()
			}

			tokens = tokens.slice(foundSequence.length)
		}

		return {
			foundSequence, node, tokens,
		}
	}
}

let choiceParserGenerator = (parsers: Array<Function>): parser => {
	return (tokens: Array<IToken>) => {
		let foundSequence: Array<any>, node: IASTNode

		for (let parser of parsers) {
			; ({ foundSequence, node, tokens, } = parser(tokens))

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

/*
	2.1.1 General Helpers
*/

let typeDeclaration = (tokens: Array<IToken>): parserResult => {
	const parser = sequenceParserGenerator(
		[
			{ parser: identifier, },
		],
		(foundSequence: [IIdentifierNode]): ITypeNode => {
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
		(foundSequence: [IIdentifierNode, ITypeNode]): IParameterNode => {
			return {
				nodeType: 'Parameter',
				name: foundSequence[0].content,
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
							(foundSequence: [IParameterNode]): IParameterNode => {
								return foundSequence[0]
							}
						),
					},
					{ tokenType: 'Delimiter', content: ')', },
				],
				(foundSequence: [IToken, IParameterNode | null]): IParameterListNode => {
					let parameter = foundSequence[1]
					let args: Array<IParameterNode> = []

					if (parameter !== null) {
						args.push(parameter)
					}

					return {
						nodeType: 'ParameterList',
						arguments: args,
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
							(foundSequence: [IToken, IParameterNode]): IParameterNode => {
								return foundSequence[1]
							}
						),
					},
					{ isOptional: true, tokenType: 'Delimiter', content: ',', },
					{ tokenType: 'Delimiter', content: ')', },
				],
				(foundSequence: [IToken, IParameterNode, IParameterNode[] | null]): IParameterListNode => {
					let parameters = foundSequence[2]
					let args: Array<IParameterNode> = []

					if (parameters !== null) {
						args = [foundSequence[1], ...parameters]
					} else {
						args = [foundSequence[1]]
					}

					return {
						nodeType: 'ParameterList',
						arguments: args,
					}
				}
			),
		]
	)

	return parser(tokens)
}

let argumentList = (tokens: Array<IToken>): parserResult => {
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
							(foundSequence: [IExpressionNode]): IExpressionNode => {
								return foundSequence[0]
							}
						),
					},
					{ tokenType: 'Delimiter', content: ')', },
				],
				(foundSequence: [IToken, IExpressionNode | null, IToken]): IArgumentListNode => {
					let argument = foundSequence[1]
					let args: Array<IExpressionNode> = []

					if (argument !== null) {
						args.push(argument)
					}

					return {
						nodeType: 'ArgumentList',
						arguments: args,
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
							(foundSequence: [IToken, IExpressionNode]): IExpressionNode => {
								return foundSequence[1]
							}
						),
					},
					{ isOptional: true, tokenType: 'Delimiter', content: ',', },
					{ tokenType: 'Delimiter', content: ')', },
				],
				(foundSequence: [IToken, IExpressionNode, IExpressionNode[] | null]): IArgumentListNode => {
					let args: Array<IExpressionNode>
					let secondaryArguments = foundSequence[2]

					if (secondaryArguments !== null) {
						args = [foundSequence[1], ...secondaryArguments]
					} else {
						args = [foundSequence[1]]
					}

					return {
						nodeType: 'ArgumentList',
						arguments: args,
					}
				}
			),
		]
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
					{ parser: functionDefinition, },
				],
				(foundSequence): IValueNode => {
					return {
						nodeType: 'Value',
						type: 'Function',
						value: foundSequence[0],
						members: {},
					}
				}
			),

			sequenceParserGenerator(
				[
					{ tokenType: 'Boolean', },
				],
				(foundSequence): IValueNode => {
					return {
						nodeType: 'Value',
						type: 'Bool',
						value: foundSequence[0].content,
						members: {},
					}
				}
			),

			sequenceParserGenerator(
				[
					{ tokenType: 'String', },
				],
				(foundSequence): IValueNode => {
					return {
						nodeType: 'Value',
						type: 'String',
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
		(foundSequence: [IToken]): IIdentifierNode => {
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
			{ parser: identifier, },
			{ tokenType: 'Delimiter', content: '.', },
			{ parser: identifier, },
		],
		(foundSequence: [IIdentifierNode, IToken, IIdentifierNode]): ILookupNode => {
			return {
				nodeType: 'Lookup',
				base: foundSequence[0],
				member: foundSequence[2].content,
			}
		}
	)

	return parser(tokens)
}

let functionDefinition = (tokens: Array<IToken>): parserResult => {
	type functionDefinitionSequence
		= [IParameterListNode, IToken, ITypeNode, IToken, IToken,
		IStatementNode[] | null,
		IToken, IToken]

	const parser = sequenceParserGenerator(
		[
			{ parser: parameterList, },
			{ tokenType: 'Operator', content: '->', },
			{ parser: typeDeclaration, },
			{ tokenType: 'Delimiter', content: '{' },
			{ isOptional: true, tokenType: 'Linebreak', },
			{ isOptional: true, canRepeat: true, parser: statement, },
			{ tokenType: 'Delimiter', content: '}' },
			{ isOptional: true, tokenType: 'Linebreak', },
		],
		(foundSequence: functionDefinitionSequence): IFunctionDefinitionNode => {
			let possibleBody = foundSequence[5]
			let body: Array<IStatementNode>

			if (possibleBody !== null) {
				body = possibleBody
			} else {
				body = []
			}

			return {
				nodeType: 'FunctionDefinition',
				parameters: foundSequence[0],
				returnType: foundSequence[2],
				body,
			}
		}
	)

	return parser(tokens)
}

let functionInvocation = (tokens: Array<IToken>): parserResult => {
	const parser = sequenceParserGenerator(
		[
			{
				parser: choiceParserGenerator([
					lookup,
					identifier,
				]),
			},
			{ parser: argumentList, },
			{ isOptional: true, tokenType: 'Linebreak', },
		],
		(foundSequence: [IIdentifierNode | ILookupNode, IArgumentListNode]): IFunctionInvocationNode => {
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
			{ parser: identifier, },
			{ parser: argumentList, },
			{ isOptional: true, tokenType: 'Linebreak', },
		],
		(foundSequence: [IToken, IIdentifierNode, IArgumentListNode]): INativeFunctionInvocationNode => {
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
			functionInvocation,
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
let returnStatement = (tokens: Array<IToken>): parserResult => {
	const parser = sequenceParserGenerator(
		[
			{ tokenType: 'Keyword', content: 'return', },
			{ parser: expression, },
			{ isOptional: true, tokenType: 'Linebreak', },
		],
		(foundSequence: [IToken, IExpressionNode]): IReturnStatementNode => {
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
		(foundSequence: [IToken, IIdentifierNode, ITypeNode, IToken, IExpressionNode]): IDeclarationStatementNode => {
			return {
				nodeType: 'DeclarationStatement',
				name: foundSequence[1].content,
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
		(foundSequence: [IIdentifierNode, IToken, IExpressionNode]): IAssignmentStatementNode => {
			return {
				nodeType: 'AssignmentStatement',
				name: foundSequence[0].content,
				value: foundSequence[2],
			}
		}
	)

	return parser(tokens)
}

let ifElseStatement = (tokens: Array<IToken>): parserResult => {
	type ifStatementSequence = [IToken, IExpressionNode, IToken, IToken, IToken, IStatementNode[] | null]
	type ifElseStatementSequence = [
			IToken, IExpressionNode, IToken, IToken,
			IStatementNode[] | null,
			IToken, IToken, IToken, IToken,
			IStatementNode[] | null,
			IToken, IToken, IToken
		]
	const parser = choiceParserGenerator(
		[
			sequenceParserGenerator(
				[
					{ tokenType: 'Keyword', content: 'if', },
					{ parser: expression, },
					{ tokenType: 'Delimiter', content: '{', },
					{ isOptional: true, tokenType: 'Linebreak', },
					{ isOptional: true, canRepeat: true, parser: statement, },
					{ tokenType: 'Delimiter', content: '}', },
					{ tokenType: 'Keyword', content: 'else', },
					{ tokenType: 'Delimiter', content: '{', },
					{ isOptional: true, tokenType: 'Linebreak', },
					{ isOptional: true, canRepeat: true, parser: statement, },
					{ isOptional: true, tokenType: 'Linebreak', },
					{ tokenType: 'Delimiter', content: '}', },
					{ isOptional: true, tokenType: 'Linebreak', },
				],
				(foundSequence: ifElseStatementSequence): IIfElseStatementNode => {
					let trueBody: Array<IStatementNode>
					let possibleTrueBody = foundSequence[4]

					let falseBody: Array<IStatementNode>
					let possibleFalseBody = foundSequence[9]

					if (possibleTrueBody !== null) {
						trueBody = possibleTrueBody
					} else {
						trueBody = []
					}

					if (possibleFalseBody !== null) {
						falseBody = possibleFalseBody
					} else {
						falseBody = []
					}

					return {
						nodeType: 'IfElseStatement',
						condition: foundSequence[1],
						trueBody,
						falseBody,
					}
				}
			),

			sequenceParserGenerator(
				[
					{ tokenType: 'Keyword', content: 'if', },
					{ parser: expression, },
					{ tokenType: 'Delimiter', content: '{', },
					{ isOptional: true, tokenType: 'Linebreak', },
					{ isOptional: true, canRepeat: true, parser: statement, },
					{ tokenType: 'Delimiter', content: '}', },
					{ isOptional: true, tokenType: 'Linebreak', },
				],
				(foundSequence: ifStatementSequence): IIfElseStatementNode => {
					let trueBody: Array<IStatementNode>
					let possibleTrueBody = foundSequence[5]

					if (possibleTrueBody !== null) {
						trueBody = possibleTrueBody
					} else {
						trueBody = []
					}

					return {
						nodeType: 'IfElseStatement',
						condition: foundSequence[1],
						trueBody,
						falseBody: [],
					}
				}
			),
		]
	)

	return parser(tokens)
}

let statement = (tokens: Array<IToken>): statementParserResult => {
	const parser = choiceParserGenerator(
		[
			declarationStatement,
			assignmentStatement,
			ifElseStatement,
			returnStatement,
			expression,
		]
	)

	return parser(tokens) as statementParserResult
}

/*
	3. Public Interface
*/

let parseProgram = (tokens: Array<IToken>): IAST => {
	let nodes: Array<IExpressionNode | IStatementNode> = []

	tokens = combineMultiTokenOperators(tokens)

	if (debugTokens) {
		console.log(tokens.length)
		console.log(tokens)
		console.log()
		console.log()
	}

	while (tokens.length) {
		let foundSequence: Array<any>, node: IASTNode | undefined
		; ({ foundSequence, node, tokens, } = statement(tokens))

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
