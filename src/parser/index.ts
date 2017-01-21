import { lexer, parser } from '../interfaces'

type IToken = lexer.IToken

type IASTNode                      = parser.IASTNode
type IExpressionNode               = parser.IExpressionNode
type IStatementNode                = parser.IStatementNode
type ITypeDeclarationNode          = parser.ITypeDeclarationNode
type IIdentifierNode               = parser.IIdentifierNode
type IBlockNode                    = parser.IBlockNode
type IFunctionDefinitionNode       = parser.IFunctionDefinitionNode
type ITypePropertyNode             = parser.ITypePropertyNode
type ITypeMethodNode               = parser.ITypeMethodNode
type IKeyValuePairNode             = parser.IKeyValuePairNode
type IParameterNode                = parser.IParameterNode
type IParameterListNode            = parser.IParameterListNode
type IArgumentListNode             = parser.IArgumentListNode
type ITypeConstructorNode          = parser.ITypeConstructorNode
type IValueNode                    = parser.IValueNode
type IPartialLookupNode            = parser.IPartialLookupNode
type IPartialMethodLookupNode      = parser.IPartialMethodLookupNode
type INativeLookupNode             = parser.INativeLookupNode
type INativeFunctionInvocationNode = parser.INativeFunctionInvocationNode
type IPartialMethodInvocationNode  = parser.IPartialMethodInvocationNode
type IFunctionInvocationNode       = parser.IFunctionInvocationNode
type ILookupNode                   = parser.ILookupNode
type IMethodInvocationNode         = parser.IMethodInvocationNode
type IMethodLookupNode             = parser.IMethodLookupNode
type IReturnStatementNode          = parser.IReturnStatementNode
type ITypeDefinitionStatementNode  = parser.ITypeDefinitionStatementNode
type IDeclarationStatementNode     = parser.IDeclarationStatementNode
type IAssignmentStatementNode      = parser.IAssignmentStatementNode
type IIfStatementNode              = parser.IIfStatementNode
type IIfElseStatementNode          = parser.IIfElseStatementNode

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

let matchToken = (token: IToken, tokenDefinition: IParser): boolean => {
	if (token == null) {
		if (tokenDefinition.isOptional) {
			return true
		} else {
			return false
		}
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

		for (let tokenKey in tokenDefinition[definitionKey]) {
			if (token[definitionKey] !== tokenDefinition[definitionKey]) {
				return false
			}
		}
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
	let defaultResult = { foundSequence: [] as Array<IToken>, tokens: originalTokens, }
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
					if (!currentDefinition.canRepeat) {
						tokens = [...tokens.slice(0, tokenIndex), null as any, ...tokens.slice(tokenIndex)]
					}
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

let suffix = (prefix: IParser | parser, suffix: IParser | parser, nodeGenerator: nodeGenerator): parser => {
	return sequence([prefix, suffix], nodeGenerator)
}

let optionalChainSuffix = (prefix: parser, suffix: parser, wrappedGenerator: (node: IASTNode) => nodeGenerator) => {
	return (tokens: Array<IToken>): parserResult => {
		let { tokens: newTokens, node, foundSequence } = prefix(tokens)

		if (node !== undefined) {
			let parserNode = node
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

let oneOrMoreChainSuffix = (prefix: parser, suffix: parser, wrappedGenerator: (node: IASTNode) => nodeGenerator) => {
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

/* Unused as of now
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

//*/

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

// TODO: Fix infinite recursion that happens when this is used (repro: block)
/*
let many1 = (parser: IParser | Function): IParser => {
	if (typeof parser === 'function') {
		parser = { parser }
	}

	parser.canRepeat = true

	return parser
}
*/

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

let linebreak = tokenHelper('Linebreak')('\n')

let optionalLinebreak = optional(linebreak)

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
				name: foundSequence[0],
				position: foundSequence[0].position,
			}
		}
	)

	/* Use simpleTypeDeclaration for now, as complexTypeDeclaration is buggy

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
			let parameter = ''

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

	// */
	return simpleTypeDeclaration(tokens)
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
			let nodes = foundSequence[2]

			if (nodes === null) {
				nodes = []
			}

			return {
				nodeType: 'Block',
				nodes,
				position: foundSequence[0].position,
			}
		}
	)

	return parser(tokens)
}

let typeProperty = (tokens: Array<IToken>): parserResult => {
	const parser = sequence(
		[ identifier, typeDeclaration, optionalLinebreak ],

		(foundSequence: [IIdentifierNode, ITypeDeclarationNode]): ITypePropertyNode => {
			return {
				nodeType: 'TypeProperty',
				name: foundSequence[0].content,
				type: foundSequence[1],
				position: foundSequence[0].position,
			}
		}
	)

	return parser(tokens)
}

let typeMethod = (tokens: Array<IToken>): parserResult => {
	const parser = suffix(
		identifier,
		functionDefinition,

		(foundSequence: [IIdentifierNode, IFunctionDefinitionNode]): ITypeMethodNode => {
			return {
				nodeType: 'TypeMethod',
				name: foundSequence[0].content,
				func: foundSequence[1],
				position: foundSequence[0].position,
			}
		}
	)

	return parser(tokens)
}

let keyValuePair = (tokens: Array<IToken>): parserResult => {
	const parser = sequence(
		[
			identifier,
			delimiter('='),
			expression,
			optional(delimiter(',')),
			optionalLinebreak,
		],
		(foundSequence: [IIdentifierNode, IToken, IExpressionNode, IToken]): IKeyValuePairNode => {
			return {
				nodeType: 'KeyValuePair',
				key: foundSequence[0],
				value: foundSequence[2],
				position: foundSequence[0].position,
			}
		}
	)

	return parser(tokens)
}

/*
	2.1.2 Function Definition & Invocation Helpers
*/

let parameter = (tokens: Array<IToken>): parserResult => {
	const parser = suffix(
		identifier,
		typeDeclaration,

		(foundSequence: [IIdentifierNode, ITypeDeclarationNode]): IParameterNode => {
			return {
				nodeType: 'Parameter',
				name: foundSequence[0].content,
				type: foundSequence[1],
				position: foundSequence[0].position,
			}
		}
	)

	return parser(tokens)
}

let parameterList = (tokens: Array<IToken>): parserResult => {
	const parameterWithOptionalTrailingComma = suffix(
		parameter,
		optional(delimiter(',')),

		(foundSequence: [IParameterNode]): IParameterNode => {
			return foundSequence[0]
		}
	)

	const parameterWithPrecedingComma = suffix(
		delimiter(','),
		parameter,

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
				position: foundSequence[0].position,
			}
		}
	)

	const twoOrMoreParameters = sequence(
		[
			delimiter('('),
			parameter,
			parameterWithPrecedingComma,
			many(parameterWithPrecedingComma),
			optional(delimiter(',')),
			delimiter(')'),
		],
		(foundSequence: [IToken, IParameterNode, IParameterNode, IParameterNode[] | null]): IParameterListNode => {
			let parameters = foundSequence[3]

			if (parameters !== null) {
				parameters = [foundSequence[1], foundSequence[2], ...parameters]
			} else {
				parameters = [foundSequence[1], foundSequence[2]]
			}

			return {
				nodeType: 'ParameterList',
				parameters,
				position: foundSequence[0].position,
			}
		}
	)

	const parser = choice(zeroOrOneParameter, twoOrMoreParameters)

	return parser(tokens)
}

let argumentList = (tokens: Array<IToken>): parserResult => {
	const expressionWithOptionalTrailingComma = suffix(
		expression,
		optional(delimiter(',')),

		(foundSequence: [IExpressionNode]): IExpressionNode => {
			return foundSequence[0]
		}
	)

	const expressionWithPrecedingComma = suffix(
		delimiter(','),
		expression,

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
				position: foundSequence[0].position,
			}
		}
	)

	const twoOrMoreArguments = sequence(
		[
			delimiter('('),
			expression,
			expressionWithPrecedingComma,
			many(expressionWithPrecedingComma),
			optional(delimiter(',')),
			delimiter(')'),
		],
		(foundSequence: [IToken, IExpressionNode, IExpressionNode, IExpressionNode[] | null]): IArgumentListNode => {
			let args = foundSequence[3]

			if (args !== null) {
				args = [foundSequence[1], foundSequence[2], ...args]
			} else {
				args = [foundSequence[1], foundSequence[2]]
			}

			return {
				nodeType: 'ArgumentList',
				arguments: args,
				position: foundSequence[0].position,
			}
		}
	)

	const parser = choice(zeroOrOneArgument, twoOrMoreArguments)

	return parser(tokens)
}

/*
	2.2 Expressions
*/

/*
	2.2.1 Values (Literals and Type Constructors)
*/

let typeConstructor = (tokens: Array<IToken>): parserResult => {
	type namedTypeConstructorSequence = [IIdentifierNode, IToken, IToken | null, Array<IKeyValuePairNode> | null]

	const anonymousTypeConstructor = sequence(
		[
			delimiter('{'),
			optionalLinebreak,
			many(keyValuePair),
			optionalLinebreak,
			delimiter('}'),
			optionalLinebreak,
		],
		(foundSequence: [IToken, IToken, Array<IKeyValuePairNode> | null]): ITypeConstructorNode => {
			let members = foundSequence[2]

			if (members === null) {
				members = []
			}

			return {
				nodeType: 'TypeConstructor',
				type: null,
				members,
				position: foundSequence[0].position,
			}
		}
	)

	const namedTypeConstructor = sequence(
		[
			identifier,
			delimiter('{'),
			optionalLinebreak,
			many(keyValuePair),
			optionalLinebreak,
			delimiter('}'),
			optionalLinebreak,
		],
		(foundSequence: namedTypeConstructorSequence): ITypeConstructorNode => {
			let members = foundSequence[3]

			if (members === null) {
				members = []
			}

			return {
				nodeType: 'TypeConstructor',
				type: foundSequence[0],
				members,
				position: foundSequence[0].position,
			}
		}
	)

	return choice(anonymousTypeConstructor, namedTypeConstructor)(tokens)
}

let value = (tokens: Array<IToken>): parserResult => {
	const parser = choice(
		decorate(
			functionDefinition,

			(foundSequence: [IFunctionDefinitionNode]): IValueNode => {
				return {
					nodeType: 'Value',
					type: 'Function',
					value: foundSequence[0],
					members: {},
					position: foundSequence[0].position,
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
					position: foundSequence[0].position,
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
					position: foundSequence[0].position,
				}
			}
		),

		decorate(
			{ tokenType: 'Number' },

			(foundSequence): IValueNode => {
				return {
					nodeType: 'Value',
					type: 'Number',
					value: foundSequence[0].content,
					members: {},
					position: foundSequence[0].position,
				}
			}
		),

		decorate(
			typeConstructor,

			([typeConstructor]: [ITypeConstructorNode]): IValueNode => {
				let members = {}
				let type: string | null = null
				typeConstructor.members.map((keyValuePair) => {
					members[keyValuePair.key.content] = keyValuePair.value
				})

				if (typeConstructor.type !== null) {
					type = typeConstructor.type.content
				}

				return {
					nodeType: 'Value',
					type,
					value: null,
					members,
					position: typeConstructor.position,
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
				position: foundSequence[0].position,
			}
		}
	)

	return parser(tokens)
}

let partialLookup = (tokens: Array<IToken>): parserResult => {
	const parser = suffix(
		delimiter('.'),
		identifier,

		(foundSequence: [IToken, IIdentifierNode]): IPartialLookupNode => {
			return {
				nodeType: 'PartialLookup',
				identifier: foundSequence[1],
				position: foundSequence[0].position,
			}
		}
	)

	return parser(tokens)
}

let partialMethodLookup = (tokens: Array<IToken>): parserResult => {
	const parser = suffix(
		operator('::'),
		identifier,

		(foundSequence: [IToken, IIdentifierNode]): IPartialMethodLookupNode => {
			return {
				nodeType: 'PartialMethodLookup',
				identifier: foundSequence[1],
				position: foundSequence[0].position,
			}
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
				position: foundSequence[0].position,
			}
		}
	)

	return parser(tokens)
}

let functionInvocation = (tokens: Array<IToken>): parserResult => {
	const parser = suffix(
		argumentList,
		optionalLinebreak,

		(foundSequence: [IArgumentListNode]): IArgumentListNode => {
			return foundSequence[0]
		}
	)

	return parser(tokens)
}

let expression = (tokens: Array<IToken>): expressionParserResult => {
	let identifierOrValue = decorate(
		choice(value, identifier),

		(foundSequence: [IIdentifierNode | IValueNode]): IExpressionNode => {
			return foundSequence[0]
		}
	)

	let nativeFunctionInvocation = oneOrMoreChainSuffix(
		optionalChainSuffix(
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
						member: foundSequence[0],
						position: foundSequence[0].position,
					}
				}
			}
		),
		functionInvocation,
		(node: INativeLookupNode) => {
			return (foundSequence: [IArgumentListNode]): INativeFunctionInvocationNode => {
				return {
					nodeType: 'NativeFunctionInvocation',
					name: node,
					arguments: foundSequence[0].arguments,
					position: foundSequence[0].position,
				}
			}
		}
	)

	let partialMethodInvocation = sequence(
		[
			operator('::'),
			identifier,
			functionInvocation,
		],
		(foundSequence: [IToken, IIdentifierNode, IArgumentListNode]): IPartialMethodInvocationNode => {
			return {
				nodeType: 'PartialMethodInvocation',
				member: foundSequence[1],
				arguments: foundSequence[2],
				position: foundSequence[0].position,
			}
		}
	)

	type partialExpressionSequence = [IArgumentListNode | IPartialLookupNode | IPartialMethodInvocationNode]
	type partialExpressionResult = IFunctionInvocationNode | ILookupNode | IMethodInvocationNode

	let partialExpression = optionalChainSuffix(
		choice(identifierOrValue, nativeFunctionInvocation),
		choice(functionInvocation, partialLookup, partialMethodInvocation),
		(node: IExpressionNode) => {
			return (foundSequence: partialExpressionSequence): partialExpressionResult => {
				let rightNode = foundSequence[0]

				if (rightNode.nodeType === 'ArgumentList') {
					return {
						nodeType: 'FunctionInvocation',
						name: node,
						arguments: rightNode.arguments,
						position: rightNode.position,
					}
				} else if (rightNode.nodeType === 'PartialMethodInvocation') {
					return {
						nodeType: 'MethodInvocation',
						name: {
							nodeType: 'MethodLookup',
							base: node,
							member: rightNode.member,
							position: rightNode.position,
						},
						arguments: rightNode.arguments.arguments,
						position: node.position,
					}
				} else {
					return {
						nodeType: 'Lookup',
						base: node,
						member: rightNode.identifier,
						position: rightNode.position,
					}
				}
			}
		}
	)

	// MethodLookups shall not recurse, so they are separated from the partialExpression parser
	let methodLookup = sequence(
		[
			partialExpression,
			partialMethodLookup,
		],
		(foundSequence: [IExpressionNode, IPartialMethodLookupNode]): IMethodLookupNode => {
			let leftNode = foundSequence[0]
			let rightNode = foundSequence[1]

			return {
				nodeType: 'MethodLookup',
				base: leftNode,
				member: rightNode.identifier,
				position: rightNode.position,
			}
		}
	)

	const parser = choice(
		methodLookup,
		partialExpression
	)

	return parser(tokens) as expressionParserResult
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
				position: foundSequence[0].position,
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
		Array<ITypeMethodNode | ITypePropertyNode>,
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
				position: foundSequence[0].position,
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
			delimiter('}'),
			optionalLinebreak,
		],
		(foundSequence: typeDefinitionStatementSequence): ITypeDefinitionStatementNode => {
			let body = foundSequence[5]

			let properties = body.reduce(
				(previous, current) => {
					if (current.nodeType === 'TypeProperty') {
						previous[current.name] = current.type
					}

					return previous
				},
				{}
			)

			// TODO: Implicit `self Self` Parameter at the start of the ParameterList needs to be injected
			let members = body.reduce(
				(previous, current) => {
					if (current.nodeType === 'TypeMethod') {
						previous[current.name] = {
							nodeType: 'Value',
							type: 'Method',
							value: current.func,
							members: {},
							position: current.position,
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
				position: foundSequence[0].position,
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
		([token, name, type, delim, value]: declarationSequence): IDeclarationStatementNode => {
			return {
				nodeType: 'DeclarationStatement',
				name,
				type,
				value,
				position: token.position,
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
				position: foundSequence[0].position,
			}
		}
	)

	return parser(tokens)
}

let ifStatement = (tokens: Array<IToken>): parserResult => {
	type ifStatementSequence = [
		IToken, IToken, IExpressionNode, IToken, IBlockNode
	]

	const parser = sequence(
		[ keyword('if'), delimiter('('), expression, delimiter(')'), block ],

		(foundSequence: ifStatementSequence): IIfStatementNode => {
			return {
				nodeType: 'IfStatement',
				condition: foundSequence[2],
				body: foundSequence[4],
				position: foundSequence[0].position,
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
				position: foundSequence[0].position,
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
					nodes: [foundSequence[2]],
					position: foundSequence[1].position,
				},
				position: foundSequence[0].position,
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
	const parser = choice(statement, expression)

	return parser(tokens) as programParserResult
}

/*
	3. Public Interface
*/

let parseProgram = (tokens: Array<IToken>): Array<IExpressionNode | IStatementNode> => {
	let nodes: Array<IExpressionNode | IStatementNode> = []

	tokens = combineMultiTokenOperators(tokens)

	while (tokens.length) {
		let foundSequence: Array<any>, node: IASTNode | undefined
		; ({ foundSequence, node, tokens, } = program(tokens))

		if (node) {
			nodes.push(node)
		} else {
			// TODO: Handle Error -> Syntax could be lexed but not parsed
			// TODO: How can we be helpful with this error, aside from position?
			throw new Error('Input could not be parsed fully')
		}
	}

	return nodes
}

export let parse = (tokens: Array<IToken>): Array<IExpressionNode | IStatementNode> => {
	return parseProgram(tokens)
}
