import { ListType, Type } from "./index"

// #region Program & Sections

export type Program = {
	nodeType: "Program"
	implementation: ImplementationSectionNode
}

export type ImplementationSectionNode = {
	nodeType: "ImplementationSection"
	nodes: Array<ImplementationNode>
}

export type ImplementationNode = ExpressionNode | StatementNode

// #endregion

// #region Expressions

export type ExpressionNode =
	| NativeFunctionInvocationNode
	| FunctionInvocationNode
	| ValueNode
	| LookupNode
	| IdentifierNode
	| CombinationNode
	| MatchNode

export interface NativeFunctionInvocationNode {
	nodeType: "NativeFunctionInvocation"
	name: IdentifierNode
	arguments: Array<ArgumentNode>
	type: Type
}

export interface FunctionInvocationNode {
	nodeType: "FunctionInvocation"
	name: ExpressionNode
	arguments: Array<ArgumentNode>
	type: Type
}

export type ValueNode =
	| RecordValueNode
	| StringValueNode
	| IntegerValueNode
	| FractionValueNode
	| BooleanValueNode
	| FunctionValueNode
	| ListValueNode

export type RecordValueNode = {
	nodeType: "RecordValue"
	type: Type
	members: {
		[key: string]: ExpressionNode
	}
}

export type StringValueNode = {
	nodeType: "StringValue"
	value: string
	type: Type
}

export type IntegerValueNode = {
	nodeType: "IntegerValue"
	value: string
	type: Type
}

export type FractionValueNode = {
	nodeType: "FractionValue"
	numerator: string
	denominator: string
	type: Type
}

export type BooleanValueNode = {
	nodeType: "BooleanValue"
	value: boolean
	type: Type
}

export type FunctionValueNode = {
	nodeType: "FunctionValue"
	value: FunctionDefinitionNode | GenericFunctionDefinitionNode
	type: Type
}

export type ListValueNode = {
	nodeType: "ListValue"
	values: Array<ExpressionNode>
	type: ListType
}

export interface LookupNode {
	nodeType: "Lookup"
	base: ExpressionNode
	member: IdentifierNode
	type: Type
}

export interface IdentifierNode {
	nodeType: "Identifier"
	name: string
	type: Type
}

export interface CombinationNode {
	nodeType: "Combination"
	lhs: ExpressionNode
	rhs: ExpressionNode
	type: Type
}

export interface MatchNode {
	nodeType: "Match"
	value: ExpressionNode
	handlers: Array<{
		matcher: Type
		returnType: Type
		body: Array<ImplementationNode>
	}>
	type: Type
}

// #endregion

// #region Statements

export type StatementNode =
	| VariableDeclarationStatementNode
	| VariableAssignmentStatementNode
	| TypeDefinitionStatementNode
	| ChoiceStatementNode
	| ReturnStatementNode
	| FunctionStatementNode

export interface VariableDeclarationStatementNode {
	nodeType: "VariableDeclarationStatement"
	name: IdentifierNode
	value: ExpressionNode
	type: Type
	isConstant: boolean
}

export interface VariableAssignmentStatementNode {
	nodeType: "VariableAssignmentStatement"
	name: IdentifierNode
	value: ExpressionNode
}

export interface Method {
	method: FunctionValueNode
	isStatic: boolean
}

export type Methods = {
	[key: string]: Method
}

export interface TypeDefinitionStatementNode {
	nodeType: "TypeDefinitionStatement"
	name: IdentifierNode
	properties: {
		[key: string]: Type
	}
	methods: Methods
	type: Type
}

export interface ChoiceStatementNode {
	nodeType: "ChoiceStatement"
	condition: ExpressionNode
	trueBody: Array<ImplementationNode>
	falseBody: Array<ImplementationNode>
}

export interface ReturnStatementNode {
	nodeType: "ReturnStatement"
	expression: ExpressionNode
}

export interface FunctionStatementNode {
	nodeType: "FunctionStatement"
	name: IdentifierNode
	value: FunctionDefinitionNode
}

// #endregion

// #region Helpers

export interface FunctionDefinitionNode {
	nodeType: "FunctionDefinition"
	parameters: Array<ParameterNode>
	body: Array<ImplementationNode>
	returnType: Type
}

export interface GenericFunctionDefinitionNode {
	nodeType: "GenericFunctionDefinition"
	generics: Array<GenericDeclarationNode>
	parameters: Array<ParameterNode>
	body: Array<ImplementationNode>
	returnType: Type
}

export interface ParameterNode {
	nodeType: "Parameter"
	externalName: IdentifierNode | null
	internalName: IdentifierNode
}

export interface GenericDeclarationNode {
	nodeType: "GenericDeclaration"
	name: string
	defaultType: Type | null
}

export interface ArgumentNode {
	nodeType: "Argument"
	name: string | null
	value: ExpressionNode
}
// #endregion
