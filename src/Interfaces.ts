/*
	Lexer
*/

export type Position = {
	line: number
	column: number
}

export type TokenType
	= null
	| 'Delimiter'
	| 'Identifier'
	| 'Keyword'
	| 'Operator'
	| 'String'
	| 'Comment'
	| 'Linebreak'
	| 'Boolean'
	| 'Number'

export interface IToken {
	content: string
	tokenType: TokenType
	position: Position
}

/*
	Parser
*/

export interface IIdentifierNode {
	nodeType: 'Identifier'
	content: string
	position: Position
}

export interface IPartialLookupNode {
	nodeType: 'PartialLookup'
	identifier: IIdentifierNode
	position: Position
}

export interface ILookupNode {
	nodeType: 'Lookup'
	base: IExpressionNode
	member: string
	position: Position
}

export interface IPartialMethodLookupNode {
	nodeType: 'PartialMethodLookup'
	identifier: IIdentifierNode
	position: Position
}

export interface IMethodLookupNode {
	nodeType: 'MethodLookup'
	base: IExpressionNode
	member: string
	position: Position
}

export interface INativeLookupNode {
	nodeType: 'NativeLookup'
	base: IIdentifierNode | INativeLookupNode
	member: string
	position: Position
}

export interface ITypeDeclarationNode {
	nodeType: 'TypeDeclaration'
	name: string
	position: Position
}

export interface IBlockNode {
	nodeType: 'Block'
	nodes: Array<IStatementNode>
	position: Position
}

export interface IKeyValuePairNode {
	nodeType: 'KeyValuePair'
	key: string
	value: IExpressionNode
	position: Position
}

export interface ITypeConstructorNode {
	nodeType: 'TypeConstructor'
	type: string | null
	members: Array<IKeyValuePairNode>
	position: Position
}

export interface IValueNode {
	nodeType: 'Value'
	type: string | null
	value: IFunctionDefinitionNode | boolean | string | null
	members: {
		[key: string]: IValueNode
	}
	position: Position
}

export interface IParameterNode {
	nodeType: 'Parameter'
	name: string
	type: ITypeDeclarationNode
	position: Position
}

export interface IParameterListNode {
	nodeType: 'ParameterList'
	parameters: Array<IParameterNode>
	position: Position
}

export interface IArgumentListNode {
	nodeType: 'ArgumentList'
	arguments: Array<IExpressionNode>
	position: Position
}

export interface IFunctionDefinitionNode {
	nodeType: 'FunctionDefinition'
	parameters: Array<IParameterNode>
	returnType: ITypeDeclarationNode
	body: IBlockNode
	scope?: any
	position: Position
}

export interface IFunctionInvocationNode {
	nodeType: 'FunctionInvocation'
	name: IExpressionNode
	arguments: Array<IExpressionNode>
	position: Position
}

export interface INativeFunctionInvocationNode {
	nodeType: 'NativeFunctionInvocation'
	name: IIdentifierNode | INativeLookupNode
	arguments: Array<IExpressionNode>
	position: Position
}

export interface IPartialMethodInvocationNode {
	nodeType: 'PartialMethodInvocation'
	member: IIdentifierNode
	arguments: IArgumentListNode
	position: Position
}

export interface IMethodInvocationNode {
	nodeType: 'MethodInvocation'
	name: IMethodLookupNode
	arguments: Array<IExpressionNode>
	position: Position
}

export interface IReturnStatementNode {
	nodeType: 'ReturnStatement'
	expression: IExpressionNode
	position: Position
}

export interface IDeclarationStatementNode {
	nodeType: 'DeclarationStatement'
	name: string
	type: ITypeDeclarationNode | null
	value: IExpressionNode
	position: Position
}

export interface IAssignmentStatementNode {
	nodeType: 'AssignmentStatement'
	name: string
	value: IExpressionNode
	position: Position
}

export interface IIfStatementNode {
	nodeType: 'IfStatement'
	condition: IExpressionNode
	body: IBlockNode
	position: Position
}

export interface IIfElseStatementNode {
	nodeType: 'IfElseStatement'
	condition: IExpressionNode
	trueBody: IBlockNode
	falseBody: IBlockNode
	position: Position
}

export interface ITypeDefinitionStatementNode {
	nodeType: 'TypeDefinitionStatement'
	name: IIdentifierNode
	properties: {
		[key: string]: ITypeDeclarationNode
	}
	members: {
		[key: string]: IValueNode
	}
	position: Position
}

export interface ITypePropertyNode {
	nodeType: 'TypeProperty'
	name: string
	type: ITypeDeclarationNode
	position: Position
}

export interface ITypeMethodNode {
	nodeType: 'TypeMethod'
	name: string
	func: IFunctionDefinitionNode
	position: Position
}

export type IExpressionNode
	= IValueNode
	| IIdentifierNode
	| ILookupNode
	| IMethodLookupNode
	| IFunctionInvocationNode
	| INativeFunctionInvocationNode
	| IMethodInvocationNode

export type IStatementNode
	= IDeclarationStatementNode
	| IAssignmentStatementNode
	| IReturnStatementNode
	| IIfStatementNode
	| IIfElseStatementNode
	| ITypeDefinitionStatementNode

export type IASTNode
	= IExpressionNode
	| IStatementNode
	| ITypeDeclarationNode
	| IParameterNode
	| IParameterListNode
	| IArgumentListNode
	| IFunctionDefinitionNode
	| IBlockNode
	| ITypePropertyNode
	| ITypeMethodNode
	| INativeLookupNode
	| IKeyValuePairNode
	| ITypeConstructorNode
	| IPartialLookupNode
	| IPartialMethodLookupNode
	| IPartialMethodInvocationNode

export interface IScope {
	parent: IScope | null
	[key: string]: any
}

export interface INativeScope {
	[key: string]: any
}
