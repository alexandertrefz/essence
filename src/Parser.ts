/// <reference path="../typings/index.d.ts" />

let debugTokens = false
let debugIndividualNodes = false
let debugNodes = false

import {
	IToken,
	IASTNode,
	IStatementNode,
	ITypeDeclarationNode,
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
	INativeLookupNode,
	IIfStatementNode,
	IIfElseStatementNode,
	IBlockNode,
	ITypeDefinitionStatementNode,
	ITypePropertyNode,
	ITypeMethodNode,
} from './Interfaces'

type tokenSequenceMatch = {
	foundSequence: Array<IToken | IASTNode | null>
	tokens: Array<IToken>
}

type parserResult = {
	foundSequence: Array<IToken | IASTNode>
	node: IASTNode | undefined
	tokens: Array<IToken>
}

type expressionParserResult = {
	foundSequence: Array<IToken | IASTNode>
	node: IExpressionNode | undefined
	tokens: Array<IToken>
}

type statementParserResult = {
	foundSequence: Array<IToken | IASTNode>
	node: IStatementNode | undefined
	tokens: Array<IToken>
}

type programParserResult = {
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

		if (token.content === '_') {
			if (nextToken.content === '_') {
				token.content = '__'
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

		if (token.content === '<') {
			if (nextToken.content === '-') {
				token.content = '<-'
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
				let { node, tokens: newTokens, } = parser(subTokens)

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

let sequence = (parsers: Array<IParser | Function>, nodeGenerator: nodeGenerator): parser => {
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

let decorate = (parser: IParser | Function, nodeGenerator: nodeGenerator): parser => {
	return sequence([parser], nodeGenerator)
}

let choice = (...parsers: Array<Function>): parser => {
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

let optionalSuffix = (prefix: parser, suffix: parser, wrappedGenerator: (node: IASTNode) => nodeGenerator) => {
	return (tokens: Array<IToken>): parserResult => {
		let { tokens: newTokens, node, foundSequence } = prefix(tokens)

		if (node !== undefined) {
			let parserNode = node // satisfy typescript
			const rightHandSide = decorate(suffix, (foundSequence) => {
				return wrappedGenerator(parserNode)(foundSequence)
			})

			while (true) {
				let {
					foundSequence: secondarySequence,
					node: secondaryNode,
					tokens: secondaryTokens,
				} = rightHandSide(newTokens)

				if (secondaryNode) {
					foundSequence = [...foundSequence, ...secondarySequence]
					newTokens = secondaryTokens
					parserNode = secondaryNode
				} else {
					return { foundSequence, node: parserNode, tokens: newTokens, }
				}
			}
		} else {
			return { foundSequence, node, tokens: newTokens, }
		}
	}
}

let oneOrMoreSuffix = (prefix: parser, suffix: parser, wrappedGenerator: (node: IASTNode) => nodeGenerator) => {
	return (tokens: Array<IToken>): parserResult => {
		let { tokens: newTokens, node, foundSequence } = prefix(tokens)

		if (node !== undefined) {
			let parserNode = node // satisfy typescript
			const rightHandSide = decorate(suffix, (foundSequence) => {
				return wrappedGenerator(parserNode)(foundSequence)
			})
			let foundSuffix = false

			while (true) {
				let {
					foundSequence: secondarySequence,
					node: secondaryNode,
					tokens: secondaryTokens,
				} = rightHandSide(newTokens)

				if (secondaryNode) {
					foundSuffix = true
					foundSequence = [...foundSequence, ...secondarySequence]
					newTokens = secondaryTokens
					parserNode = secondaryNode
				} else {
					if (foundSuffix) {
						return { foundSequence, node: parserNode, tokens: newTokens, }
					} else {
						return { foundSequence: [] as Array<any>, node: undefined, tokens, }
					}
				}
			}
		} else {
			return { foundSequence: [] as Array<any>, node: undefined, tokens, }
		}
	}
}

let chainLeft = (parser: parser, separator: IParser, wrappedGenerator: (node: IASTNode) => nodeGenerator) => {
	return (tokens: Array<IToken>): parserResult => {
		let { tokens: newTokens, node, foundSequence } = parser(tokens)

		if (node !== undefined) {
			let parserNode = node // satisfy typescript
			const rightHandSide = sequence([separator, parser], (foundSequence) => {
				return wrappedGenerator(parserNode)(foundSequence)
			})

			while (true) {
				let {
					foundSequence: secondarySequence,
					node: secondaryNode,
					tokens: secondaryTokens,
				} = rightHandSide(newTokens)

				if (secondaryNode) {
					foundSequence = [...foundSequence, ...secondarySequence]
					newTokens = secondaryTokens
					parserNode = secondaryNode
				} else {
					return { foundSequence, node: parserNode, tokens: newTokens, }
				}
			}
		} else {
			return { foundSequence, node, tokens: newTokens, }
		}
	}
}

let tokenHelper = (tokenType: string): (content: string) => IParser => {
	return (content: string): IParser => {
		return {
			tokenType,
			content,
		}
	}
}

let optional = (parser: IParser | Function): IParser => {
	if (typeof parser === 'function') {
		parser = { parser }
	}

	parser.isOptional = true
	return parser
}

let many1 = (parser: IParser | Function): IParser => {
	if (typeof parser === 'function') {
		parser = { parser }
	}

	parser.canRepeat = true

	return parser
}

let many = (parser: IParser | Function): IParser => {
	if (typeof parser === 'function') {
		parser = { parser }
	}

	parser.isOptional = true
	parser.canRepeat = true

	return parser
}

/*
	2. Parsers
*/

let operator = tokenHelper('Operator')

let delimiter = tokenHelper('Delimiter')

let keyword = tokenHelper('Keyword')

let linebreak = () => { return tokenHelper('Linebreak')('\n') }

let optionalLinebreak = optional(linebreak())

/*
	2.1 Helpers
*/

/*
	2.1.1 General Helpers
*/

let typeDeclaration = (tokens: Array<IToken>): parserResult => {
	type shortComplexTypeDeclarationSequence = [
		IToken, ITypeDeclarationNode | null, IToken,
		IToken,
		ITypeDeclarationNode
	]

	type longComplexTypeDeclarationSequence = [
		IToken, ITypeDeclarationNode, ITypeDeclarationNode[] | null, IToken,
		IToken,
		ITypeDeclarationNode
	]

	const simpleTypeDeclaration = decorate(
		identifier,

		(foundSequence: [IIdentifierNode]): ITypeDeclarationNode => {
			return {
				nodeType: 'TypeDeclaration',
				name: foundSequence[0].content,
			}
		}
	)

	let complexTypeDeclaration

	const generateTypeDeclarationParser = () => {
		return choice(simpleTypeDeclaration, complexTypeDeclaration)
	}

	const typeDeclarationWithOptionalTrailingComma = sequence(
		[ generateTypeDeclarationParser(), optional(delimiter(',')) ],

		(foundSequence: [ITypeDeclarationNode]): ITypeDeclarationNode => {
			return foundSequence[0]
		}
	)

	const typeDeclarationWithPrecedingComma = sequence(
		[ delimiter(','), generateTypeDeclarationParser() ],

		(foundSequence: [IToken, ITypeDeclarationNode]): ITypeDeclarationNode => {
			return foundSequence[1]
		}
	)

	const zeroOrOneTypeDeclaration = sequence(
		[
			delimiter('('),
			optional(typeDeclarationWithOptionalTrailingComma),
			delimiter(')'),
			operator('->'),
			simpleTypeDeclaration,
		],
		(foundSequence: shortComplexTypeDeclarationSequence): ITypeDeclarationNode => {
			let optionalParameter = foundSequence[1]
			let returnType = foundSequence[4].name
			let parameter: string = ''

			if (optionalParameter !== null) {
				parameter = optionalParameter.name
			}

			return {
				nodeType: 'TypeDeclaration',
				name: `(${parameter}) -> ${returnType}`,
			}
		}
	)

	const oneOrMoreTypeDeclaration = sequence(
		[
			delimiter('('),
			typeDeclaration,
			many(typeDeclarationWithPrecedingComma),
			delimiter(')'),
			operator('->'),
			simpleTypeDeclaration,
		],
		(foundSequence: longComplexTypeDeclarationSequence): ITypeDeclarationNode => {
			let returnType = foundSequence[5].name
			let parameters = [foundSequence[1]]
			let possibleParameters = foundSequence[2]

			if (possibleParameters !== null) {
				parameters = [...parameters, ...possibleParameters]
			}

			let params = parameters.reduce((name, node) => `${name},${node.name}`, '').slice(1)

			return {
				nodeType: 'TypeDeclaration',
				name: `(${params}) -> ${returnType}`,
			}
		}
	)

	complexTypeDeclaration = choice(zeroOrOneTypeDeclaration, oneOrMoreTypeDeclaration)

	return generateTypeDeclarationParser()(tokens)
}

let block = (tokens: Array<IToken>): parserResult => {
	const parser = sequence(
		[
			delimiter('{'),
			optionalLinebreak,
			many(statement),
			delimiter('}'),
			optionalLinebreak,
		],
		(foundSequence: [IToken, IToken, IStatementNode[] | null]): IBlockNode => {
			let body = foundSequence[2]

			if (body === null) {
				body = []
			}

			return {
				nodeType: 'Block',
				body,
			}
		}
	)

	return parser(tokens)
}

let typeProperty = (tokens: Array<IToken>): parserResult => {
	const parser = sequence(
		[ identifier, typeDeclaration ],

		(foundSequence: [IIdentifierNode, ITypeDeclarationNode]): ITypePropertyNode => {
			return {
				nodeType: 'TypeProperty',
				name: foundSequence[0].content,
				type: foundSequence[1],
			}
		}
	)

	return parser(tokens)
}

let typeMethod = (tokens: Array<IToken>): parserResult => {
	const parser = sequence(
		[ identifier, functionDefinition ],

		(foundSequence: [IIdentifierNode, IFunctionDefinitionNode]): ITypeMethodNode => {
			return {
				nodeType: 'TypeMethod',
				name: foundSequence[0].content,
				func: foundSequence[1],
			}
		}
	)

	return parser(tokens)
}

/*
	2.1.2 Function Definition & Invocation Helpers
*/

let parameter = (tokens: Array<IToken>): parserResult => {
	const parser = sequence(
		[ identifier, typeDeclaration ],

		(foundSequence: [IIdentifierNode, ITypeDeclarationNode]): IParameterNode => {
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
	const parameterWithOptionalTrailingComma = sequence(
		[ parameter, optional(delimiter(',')) ],

		(foundSequence: [IParameterNode]): IParameterNode => {
			return foundSequence[0]
		}
	)

	const parameterWithPrecedingComma = sequence(
		[ delimiter(','), parameter ],

		(foundSequence: [IToken, IParameterNode]): IParameterNode => {
			return foundSequence[1]
		}
	)

	const zeroOrOneParameter = sequence(
		[ delimiter('('), optional(parameterWithOptionalTrailingComma), delimiter(')') ],

		(foundSequence: [IToken, IParameterNode | null]): IParameterListNode => {
			let parameter = foundSequence[1]
			let parameters: Array<IParameterNode>

			if (parameter !== null) {
				parameters = [parameter]
			} else {
				parameters = []
			}

			return {
				nodeType: 'ParameterList',
				parameters,
			}
		}
	)

	const oneOrMoreParameters = sequence(
		[
			delimiter('('),
			parameter,
			many(parameterWithPrecedingComma),
			optional(delimiter(',')),
			delimiter(')'),
		],
		(foundSequence: [IToken, IParameterNode, IParameterNode[] | null]): IParameterListNode => {
			let parameters = foundSequence[2]

			if (parameters !== null) {
				parameters = [foundSequence[1], ...parameters]
			} else {
				parameters = [foundSequence[1]]
			}

			return {
				nodeType: 'ParameterList',
				parameters,
			}
		}
	)

	const parser = choice(zeroOrOneParameter, oneOrMoreParameters)

	return parser(tokens)
}

let argumentList = (tokens: Array<IToken>): parserResult => {
	const expressionWithOptionalTrailingComma = sequence(
		[ expression, optional(delimiter(',')) ],

		(foundSequence: [IExpressionNode]): IExpressionNode => {
			return foundSequence[0]
		}
	)

	const expressionWithPrecedingComma = sequence(
		[ delimiter(','), expression ],

		(foundSequence: [IToken, IExpressionNode]): IExpressionNode => {
			return foundSequence[1]
		}
	)

	const zeroOrOneArgument = sequence(
		[ delimiter('('), optional(expressionWithOptionalTrailingComma), delimiter(')') ],

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
	)

	const oneOrMoreArguments = sequence(
		[
			delimiter('('),
			expression,
			many(expressionWithPrecedingComma),
			optional(delimiter(',')),
			delimiter(')'),
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
	)

	const parser = choice(zeroOrOneArgument, oneOrMoreArguments)

	return parser(tokens)
}

/*
	2.2 Expressions
*/

/*
	2.2.1 Literals
*/

let value = (tokens: Array<IToken>): parserResult => {
	const parser = choice(
		decorate(
			functionDefinition,

			(foundSequence): IValueNode => {
				return {
					nodeType: 'Value',
					type: 'Function',
					value: foundSequence[0],
					members: {},
				}
			}
		),

		decorate(
			{ tokenType: 'Boolean' },

			(foundSequence): IValueNode => {
				let value = foundSequence[0].content === 'true'

				return {
					nodeType: 'Value',
					type: 'Bool',
					value,
					members: {},
				}
			}
		),

		decorate(
			{ tokenType: 'String' },

			(foundSequence): IValueNode => {
				return {
					nodeType: 'Value',
					type: 'String',
					value: foundSequence[0].content,
					members: {},
				}
			}
		),
	)

	return parser(tokens)
}

/*
	2.2.2 General
*/

let identifier = (tokens: Array<IToken>): parserResult => {
	const parser = decorate(
		{ tokenType: 'Identifier' },

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
	const parser = sequence(
		[ delimiter('.'), identifier ],

		(foundSequence: [IToken, IIdentifierNode]): IIdentifierNode => {
			return foundSequence[1]
		}
	)

	return parser(tokens)
}

let functionDefinition = (tokens: Array<IToken>): parserResult => {
	type functionDefinitionSequence = [IParameterListNode, IToken, ITypeDeclarationNode, IBlockNode]

	const parser = sequence(
		[
			parameterList,
			operator('->'),
			typeDeclaration,
			block,
		],
		(foundSequence: functionDefinitionSequence): IFunctionDefinitionNode => {
			return {
				nodeType: 'FunctionDefinition',
				parameters: foundSequence[0].parameters,
				returnType: foundSequence[2],
				body: foundSequence[3],
			}
		}
	)

	return parser(tokens)
}

let functionInvocation = (tokens: Array<IToken>): parserResult => {
	const parser = sequence(
		[ argumentList, optionalLinebreak ],

		(foundSequence: [IArgumentListNode]): IArgumentListNode => {
			return foundSequence[0]
		}
	)

	return parser(tokens)
}

let expression = (tokens: Array<IToken>): expressionParserResult => {
	let identifierOrValue = decorate(
		choice(identifier, value),

		(foundSequence: [IIdentifierNode | IValueNode]): IExpressionNode => {
			return foundSequence[0]
		}
	)

	type argumentListOrIdentifier = [IArgumentListNode | IIdentifierNode]

	let nativeLookup = optionalSuffix(
		sequence(
			[operator('__'), identifier],
			(foundSequence) => { return foundSequence[1] }
		),
		sequence(
			[delimiter('.'), identifier],
			(foundSequence) => { return foundSequence[1] }
		),
		(node: IIdentifierNode | INativeLookupNode) => {
			return (foundSequence: [IIdentifierNode]): INativeLookupNode => {
				return {
					nodeType: 'NativeLookup',
					base: node,
					member: foundSequence[0].content,
				}
			}
		}
	)

	let nativeFunctionInvocation = oneOrMoreSuffix(
		nativeLookup,
		functionInvocation,
		(node: INativeLookupNode) => {
			return (foundSequence: [IArgumentListNode]): INativeFunctionInvocationNode => {
				return {
					nodeType: 'NativeFunctionInvocation',
					name: node,
					arguments: foundSequence[0].arguments,
				}
			}
		}
	)

	let expressionOrFunctionInvocation = optionalSuffix(
		choice(identifierOrValue, nativeFunctionInvocation),
		choice(functionInvocation, lookup),
		(node: IExpressionNode) => {
			return (foundSequence: argumentListOrIdentifier): IFunctionInvocationNode | ILookupNode => {
				let rightNode = foundSequence[0]
				if (rightNode.nodeType === 'ArgumentList') {
					return {
						nodeType: 'FunctionInvocation',
						name: node,
						arguments: rightNode.arguments,
					}
				} else {
					return {
						nodeType: 'Lookup',
						base: node,
						member: rightNode.content,
					}
				}
			}
		}
	)

	return choice(expressionOrFunctionInvocation)(tokens) as expressionParserResult
}

/*
	2.3 Statements
*/

let returnStatement = (tokens: Array<IToken>): parserResult => {
	const parser = sequence(
		[ operator('<-'), expression, optionalLinebreak ],

		(foundSequence: [IToken, IExpressionNode]): IReturnStatementNode => {
			return {
				nodeType: 'ReturnStatement',
				expression: foundSequence[1],
			}
		}
	)

	return parser(tokens)
}

let typeDefinitionStatement = (tokens: Array<IToken>): parserResult => {
	type emptyTypeDefinitionStatementSequence = [
		IToken, IIdentifierNode, IToken, IToken, IToken, IToken, IToken
	]

	type typeDefinitionStatementSequence = [
		IToken, IIdentifierNode, IToken, IToken, IToken,
		Array<ITypeMethodNode | ITypePropertyNode> | null,
		IToken, IToken, IToken
	]

	const emptyTypeDefinition = sequence(
		[
			keyword('type'),
			identifier,
			optionalLinebreak,
			delimiter('{'),
			optionalLinebreak,
			delimiter('}'),
			optionalLinebreak,
		],
		(foundSequence: emptyTypeDefinitionStatementSequence): ITypeDefinitionStatementNode => {
			return {
				nodeType: 'TypeDefinitionStatement',
				name: foundSequence[1],
				properties: {},
				members: {},
			}
		}
	)

	const typeDefinition = sequence(
		[
			keyword('type'),
			identifier,
			optionalLinebreak,
			delimiter('{'),
			optionalLinebreak,
			many(choice(typeProperty, typeMethod)),
			optionalLinebreak,
			delimiter('}'),
			optionalLinebreak,
		],
		(foundSequence: typeDefinitionStatementSequence): ITypeDefinitionStatementNode => {
			let body = foundSequence[5]

			if (body === null) {
				body = []
			}

			let properties = body.reduce(
				(previous, current) => {
					if (current.nodeType === 'TypeProperty') {
						previous[current.name] = current.type
					}

					return previous
				},
				{}
			)

			let members = body.reduce(
				(previous, current) => {
					if (current.nodeType === 'TypeMethod') {
						previous[current.name] = {
							nodeType: 'Value',
							type: 'Method',
							value: current.func,
							members: {},
						}
					}

					return previous
				},
				{}
			)

			return {
				nodeType: 'TypeDefinitionStatement',
				name: foundSequence[1],
				properties,
				members,
			}
		}
	)

	return choice(emptyTypeDefinition, typeDefinition)(tokens)
}

let declarationStatement = (tokens: Array<IToken>): parserResult => {
	type declarationSequence = [
		IToken,
		IIdentifierNode,
		ITypeDeclarationNode | null,
		IToken,
		IExpressionNode
	]

	const parser = sequence(
		[
			keyword('let'),
			identifier,
			optional(typeDeclaration),
			delimiter('='),
			expression,
			optionalLinebreak,
		],
		(foundSequence: declarationSequence): IDeclarationStatementNode => {
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
	const parser = sequence(
		[
			identifier,
			delimiter('='),
			expression,
			optionalLinebreak,
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

let ifStatement = (tokens: Array<IToken>): parserResult => {
	type ifStatementSequence = [
		IToken, IExpressionNode, IBlockNode
	]

	const parser = sequence(
		[ keyword('if'), expression, block ],

		(foundSequence: ifStatementSequence): IIfStatementNode => {
			return {
				nodeType: 'IfStatement',
				condition: foundSequence[1],
				body: foundSequence[2],
			}
		}
	)

	return parser(tokens)
}

let ifElseStatement = (tokens: Array<IToken>): parserResult => {
	type ifElseStatementSequence = [
		IIfStatementNode,
		IToken, IBlockNode
	]

	type ifElseIfStatementSequence = [
		IIfStatementNode,
		IToken, IIfStatementNode | IIfElseStatementNode
	]

	const ifElseStatementParser = sequence(
		[ ifStatement, keyword('else'), block ],

		(foundSequence: ifElseStatementSequence): IIfElseStatementNode => {
			return {
				nodeType: 'IfElseStatement',
				condition: foundSequence[0].condition,
				trueBody: foundSequence[0].body,
				falseBody: foundSequence[2],
			}
		}
	)

	const ifElseIfStatementParser = sequence(
		[ ifStatement, keyword('else'), choice(ifElseStatement, ifStatement) ],

		(foundSequence: ifElseIfStatementSequence): IIfElseStatementNode => {
			return {
				nodeType: 'IfElseStatement',
				condition: foundSequence[0].condition,
				trueBody: foundSequence[0].body,
				falseBody: {
					nodeType: 'Block',
					body: [foundSequence[2]],
				},
			}
		}
	)

	const parser = choice(
		ifElseIfStatementParser,
		ifElseStatementParser,
		ifStatement,
	)

	return parser(tokens)
}

let statement = (tokens: Array<IToken>): statementParserResult => {
	const parser = choice(
		typeDefinitionStatement,
		declarationStatement,
		assignmentStatement,
		ifElseStatement,
		ifStatement,
		returnStatement,
	)

	return parser(tokens) as statementParserResult
}

let program = (tokens: Array<IToken>): programParserResult => {
	const parser = choice(expression, statement)

	return parser(tokens) as programParserResult
}

/*
	3. Public Interface
*/

let parseProgram = (tokens: Array<IToken>): Array<IExpressionNode | IStatementNode> => {
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
		; ({ foundSequence, node, tokens, } = program(tokens))

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

	return nodes
}

export let parse = (tokens: Array<IToken>): Array<IExpressionNode | IStatementNode> => {
	return parseProgram(tokens)
}
