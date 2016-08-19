/*
	Lexer
*/

export type TokenType
	= null
	| 'Delimiter'
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
	nodes: Array<IASTNode>
}

export type ASTType
	= undefined
	| 'Identifier'
	| 'Lookup'
	| 'Value'
	| 'PackageAssignmentStatement'
	| 'ImportStatement'
	| 'TypeDefinitionStatement'
	| 'MethodDefinition'
	| 'TypeDeclaration'
	| 'PropertyDeclaration'
	| 'DeclarationStatement'
	| 'AssignmentStatement'
	| 'Parameter'
	| 'ParameterList'
	| 'UnnamedArgument'
	| 'UnnamedArgumentList'
	| 'NamedArgument'
	| 'NamedArgumentList'
	| 'FunctionDefinition'
	| 'FunctionInvocation'
	| 'NativeFunctionInvocation'
	| 'StringLiteral'
	| 'ReturnStatement'

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

export interface IValueNode {
	nodeType: 'Value'
	type: string
	value: any
	members: any
}

export interface IStringLiteralNode {
	nodeType: 'StringLiteral'
	content: string
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

export interface IUnnamedArgumentListNode {
	nodeType: 'UnnamedArgumentList'
	arguments: Array<IExpressionNode>
}

export interface INamedArgumentNode {
	nodeType: 'NamedArgument'
	name: string
	value: IExpressionNode
}

export interface INamedArgumentListNode {
	nodeType: 'NamedArgumentList'
	arguments: Array<INamedArgumentNode>
}

export interface IPackageAssignmentStatementNode {
	nodeType: 'PackageAssignmentStatement'
	name: string
}

export interface IImportStatementNode {
	nodeType: 'ImportStatement'
}

export interface IPropertyDeclarationNode {
	nodeType: 'PropertyDeclaration'
	name: string
	type: ITypeNode
}

export interface IFunctionDefinitionNode {
	nodeType: 'FunctionDefinition'
	parameters: IParameterListNode
	returnType: ITypeNode
	body: Array<IStatementNode>
	scope?: any
}

export interface IFunctionInvocationNode {
	nodeType: 'FunctionInvocation'
	name: IIdentifierNode | ILookupNode
	arguments: IUnnamedArgumentListNode | INamedArgumentListNode
}

export interface INativeFunctionInvocationNode {
	nodeType: 'NativeFunctionInvocation'
	name: IIdentifierNode
	arguments: IUnnamedArgumentListNode
}

export interface IMethodDefinitionNode {
	nodeType: 'MethodDefinition'
	name: string
	function: IFunctionDefinitionNode
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

export interface ITypeDefinitionStatementNode {
	nodeType: 'TypeDefinitionStatement'
	name: string
	properties: Array<IPropertyDeclarationNode>
	methods: Array<IMethodDefinitionNode>
}

export type IExpressionNode
	= IValueNode
	| IIdentifierNode
	| ILookupNode
	| IFunctionInvocationNode
	| INativeFunctionInvocationNode

export type IStatementNode
	= IPackageAssignmentStatementNode
	| IImportStatementNode
	| IDeclarationStatementNode
	| IAssignmentStatementNode
	| ITypeDefinitionStatementNode
	| IReturnStatementNode

export type IASTNode
	= IExpressionNode
	| IStatementNode
	| ITypeNode
	| IStringLiteralNode
	| IParameterNode
	| IParameterListNode
	| IUnnamedArgumentListNode
	| INamedArgumentNode
	| INamedArgumentListNode
	| IPropertyDeclarationNode
	| IMethodDefinitionNode
	| IFunctionDefinitionNode
