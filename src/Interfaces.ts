/*
	Lexer
*/

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
	line: number
	column: number
}

/*
	Parser
*/

export interface IAST {
	nodes: Array<IExpressionNode | IStatementNode>
}

export type ASTType
	= 'Identifier'
	| 'Lookup'
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

export interface IIdentifierNode {
	nodeType: 'Identifier'
	content: string
}

export interface ILookupNode {
	nodeType: 'Lookup'
	base: IIdentifierNode
	member: string
}

export interface ITypeNode {
	nodeType: 'TypeDeclaration'
	name: IIdentifierNode
}

export interface IBlockNode {
	nodeType: 'Block'
	body: Array<IStatementNode>
}

export interface IValueNode {
	nodeType: 'Value'
	type: string
	value: any
	members: any
}

export interface IParameterNode {
	nodeType: 'Parameter'
	name: string
	type: ITypeNode
}

export interface IParameterListNode {
	nodeType: 'ParameterList'
	arguments: Array<IParameterNode>
}

export interface IArgumentListNode {
	nodeType: 'ArgumentList'
	arguments: Array<IExpressionNode>
}

export interface IFunctionDefinitionNode {
	nodeType: 'FunctionDefinition'
	parameters: IParameterListNode
	returnType: ITypeNode
	body: IBlockNode
	scope?: any
}

export interface IFunctionInvocationNode {
	nodeType: 'FunctionInvocation'
	name: IIdentifierNode | ILookupNode
	arguments: IArgumentListNode
}

export interface INativeFunctionInvocationNode {
	nodeType: 'NativeFunctionInvocation'
	name: IIdentifierNode
	arguments: IArgumentListNode
}

export interface IReturnStatementNode {
	nodeType: 'ReturnStatement'
	expression: IExpressionNode
}

export interface IDeclarationStatementNode {
	nodeType: 'DeclarationStatement'
	name: string
	type: ITypeNode
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
	body: Array<IStatementNode>
}

export interface IIfElseStatementNode {
	nodeType: 'IfElseStatement'
	condition: IExpressionNode
	trueBody: Array<IStatementNode>
	falseBody: Array<IStatementNode>
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

export type IASTNode
	= IExpressionNode
	| IStatementNode
	| ITypeNode
	| IParameterNode
	| IParameterListNode
	| IArgumentListNode
	| IFunctionDefinitionNode
	| IBlockNode

/* tslint:disable */
export interface IScope {
	parent: IScope | null
}
/* tslint:enable */
