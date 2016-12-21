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

export type ASTType
	= 'Identifier'
	| 'Lookup'
	| 'NativeLookup'
	| 'Value'
	| 'TypeDeclaration'
	| 'DeclarationStatement'
	| 'AssignmentStatement'
	| 'Parameter'
	| 'ParameterList'
	| 'ArgumentList'
	| 'FunctionDefinition'
	| 'FunctionInvocation'
	| 'NativeFunctionInvocation'
	| 'ReturnStatement'
	| 'IfStatement'
	| 'IfElseStatement'
	| 'Block'
	| 'TypeDefinitionStatement'
	| 'TypeProperty'
	| 'TypeMethod'

export interface IIdentifierNode {
	nodeType: 'Identifier'
	content: string
}

export interface ILookupNode {
	nodeType: 'Lookup'
	base: IExpressionNode
	member: string
}

export interface INativeLookupNode {
	nodeType: 'NativeLookup'
	base: IIdentifierNode | INativeLookupNode
	member: string
}

export interface ITypeDeclarationNode {
	nodeType: 'TypeDeclaration'
	name: string
}

export interface IBlockNode {
	nodeType: 'Block'
	nodes: Array<IStatementNode>
}

export interface IValueNode {
	nodeType: 'Value'
	type: string
	value: any
	members: {
		[key: string]: IValueNode
	}
}

export interface IParameterNode {
	nodeType: 'Parameter'
	name: string
	type: ITypeDeclarationNode
}

export interface IParameterListNode {
	nodeType: 'ParameterList'
	parameters: Array<IParameterNode>
}

export interface IArgumentListNode {
	nodeType: 'ArgumentList'
	arguments: Array<IExpressionNode>
}

export interface IFunctionDefinitionNode {
	nodeType: 'FunctionDefinition'
	parameters: Array<IParameterNode>
	returnType: ITypeDeclarationNode
	body: IBlockNode
	scope?: any
}

export interface IFunctionInvocationNode {
	nodeType: 'FunctionInvocation'
	name: IExpressionNode
	arguments: Array<IExpressionNode>
}

export interface INativeFunctionInvocationNode {
	nodeType: 'NativeFunctionInvocation'
	name: IIdentifierNode | INativeLookupNode
	arguments: Array<IExpressionNode>
}

export interface IReturnStatementNode {
	nodeType: 'ReturnStatement'
	expression: IExpressionNode
}

export interface IDeclarationStatementNode {
	nodeType: 'DeclarationStatement'
	name: string
	type: ITypeDeclarationNode | null
	value: IExpressionNode
}

export interface IAssignmentStatementNode {
	nodeType: 'AssignmentStatement'
	name: string
	value: IExpressionNode
}

export interface IIfStatementNode {
	nodeType: 'IfStatement'
	condition: IExpressionNode
	body: IBlockNode
}

export interface IIfElseStatementNode {
	nodeType: 'IfElseStatement'
	condition: IExpressionNode
	trueBody: IBlockNode
	falseBody: IBlockNode
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
}

export interface ITypePropertyNode {
	nodeType: 'TypeProperty'
	name: string
	type: ITypeDeclarationNode
}

export interface ITypeMethodNode {
	nodeType: 'TypeMethod'
	name: string
	func: IFunctionDefinitionNode
}

export type IExpressionNode
	= IValueNode
	| IIdentifierNode
	| ILookupNode
	| IFunctionInvocationNode
	| INativeFunctionInvocationNode

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

/* tslint:disable */
export interface IScope {
	parent: IScope | null
	[key: string]: any
}

export interface INativeScope {
	[key: string]: any
}
/* tslint:enable */
