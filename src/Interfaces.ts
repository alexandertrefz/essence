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
	| 'StringLiteral'
	| 'BooleanLiteral'
	| 'ReturnStatement'

export interface IASTNode {
	nodeType: ASTType
}

export interface IExpressionNode extends IASTNode {

}

export interface IStatementNode extends IASTNode {

}

export interface IIdentifierNode extends IExpressionNode {
	nodeType: 'Identifier'
	content: string
}

export interface ILookupNode extends IExpressionNode {
	nodeType: 'Lookup'
	base: IExpressionNode
	member: IIdentifierNode
}

export interface ITypeNode extends IASTNode {
	nodeType: 'TypeDeclaration'
	name: IIdentifierNode
}

export interface IStringLiteralNode extends IASTNode {
	nodeType: 'StringLiteral'
	content: string
}

export interface IBooleanLiteralNode extends IASTNode {
	nodeType: 'BooleanLiteral'
	content: boolean
}

export interface IParameterNode extends IASTNode {
	nodeType: 'Parameter'
	name: IIdentifierNode
	type: ITypeNode
}

export interface IParameterListNode extends IASTNode {
	nodeType: 'ParameterList'
	arguments: Array<IParameterNode>
}

export interface IUnnamedArgumentListNode extends IASTNode {
	nodeType: 'UnnamedArgumentList'
	arguments: Array<IExpressionNode>
}

export interface INamedArgumentNode extends IASTNode {
	nodeType: 'NamedArgument'
	name: IIdentifierNode
	value: IExpressionNode
}

export interface INamedArgumentListNode extends IASTNode {
	nodeType: 'NamedArgumentList'
	arguments: Array<INamedArgumentNode>
}

export interface IPackageAssignmentStatementNode extends IStatementNode {
	nodeType: 'PackageAssignmentStatement'
	name: IStringLiteralNode
}

export interface IImportStatementNode extends IStatementNode {
	nodeType: 'ImportStatement'
}

export interface IPropertyDeclarationNode extends IASTNode {
	nodeType: 'PropertyDeclaration'
	name: IIdentifierNode
	type: ITypeNode
}

export interface IFunctionDefinitionNode extends IASTNode {
	nodeType: 'FunctionDefinition'
	parameters: IParameterListNode
	returnType: ITypeNode
	body: Array<IStatementNode>
}

export interface IFunctionInvocationNode extends IASTNode {
	nodeType: 'FunctionInvocation'
	name: IIdentifierNode
	arguments: IUnnamedArgumentListNode | INamedArgumentListNode
}

export interface IMethodDefinitionNode extends IASTNode {
	nodeType: 'MethodDefinition'
	name: IIdentifierNode
	function: IFunctionDefinitionNode
}

export interface IReturnStatementNode extends IStatementNode {
	nodeType: 'ReturnStatement'
	expression: IExpressionNode
}

export interface IDeclarationStatementNode extends IStatementNode {
	nodeType: 'DeclarationStatement'
	name: IIdentifierNode
	type: ITypeNode
	value: IExpressionNode
}

export interface IAssignmentStatementNode extends IStatementNode {
	nodeType: 'AssignmentStatement'
	name: IIdentifierNode
	value: IExpressionNode
}

export interface ITypeDefinitionStatementNode extends IStatementNode {
	nodeType: 'TypeDefinitionStatement'
	name: IIdentifierNode
	properties: Array<IPropertyDeclarationNode>
	methods: Array<IMethodDefinitionNode>
}
