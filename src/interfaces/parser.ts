import type { Position, Type } from "./common"

export type Program = {
	nodeType: "Program"
	implementation: ImplementationSectionNode
	position: Position
}

// #region Sections

export type ImplementationSectionNode = {
	nodeType: "ImplementationSection"
	nodes: Array<ImplementationNode>
	position: Position
}

// #endregion

export type ImplementationNode = ExpressionNode | StatementNode

// #region Expressions

export type ExpressionNode =
	| NativeFunctionInvocationNode
	| MethodInvocationNode
	| FunctionInvocationNode
	| ValueNode
	| LookupNode
	| SelfNode
	| IdentifierNode
	| CombinationNode
	| MatchNode

export interface NativeFunctionInvocationNode {
	nodeType: "NativeFunctionInvocation"
	name: IdentifierNode
	arguments: Array<ArgumentNode>
	position: Position
}

export interface MethodInvocationNode {
	nodeType: "MethodInvocation"
	base: ExpressionNode
	member: IdentifierNode
	namespaceSpecifier: IdentifierNode | null
	arguments: Array<ArgumentNode>
	position: Position
}

export interface FunctionInvocationNode {
	nodeType: "FunctionInvocation"
	name: ExpressionNode
	arguments: Array<ArgumentNode>
	position: Position
}

export type ValueNode =
	| RecordValueNode
	| StringValueNode
	| IntegerValueNode
	| FractionValueNode
	| BooleanValueNode
	| NothingValueNode
	| FunctionValueNode
	| ListValueNode

export type RecordValueNode = {
	nodeType: "RecordValue"
	type: TypeDeclarationNode | null
	members: Record<string, ExpressionNode>
	position: Position
}

export type StringValueNode = {
	nodeType: "StringValue"
	value: string
	position: Position
}

export type IntegerValueNode = {
	nodeType: "IntegerValue"
	value: string
	position: Position
}

export type FractionValueNode = {
	nodeType: "FractionValue"
	numerator: string
	denominator: string
	position: Position
}

export type BooleanValueNode = {
	nodeType: "BooleanValue"
	value: boolean
	position: Position
}

export type NothingValueNode = {
	nodeType: "NothingValue"
	position: Position
}

export type FunctionValueNode = {
	nodeType: "FunctionValue"
	value: FunctionDefinitionNode | GenericFunctionDefinitionNode
	position: Position
}

export type ListValueNode = {
	nodeType: "ListValue"
	values: Array<ExpressionNode>
	position: Position
}

export interface LookupNode {
	nodeType: "Lookup"
	base: ExpressionNode
	member: IdentifierNode
	position: Position
}

export interface SelfNode {
	nodeType: "Self"
	position: Position
}

export interface IdentifierNode {
	nodeType: "Identifier"
	content: string
	position: Position
}

export interface CombinationNode {
	nodeType: "Combination"
	lhs: ExpressionNode
	rhs: ExpressionNode
	position: Position
}

export interface MatchNode {
	nodeType: "Match"
	returnType: TypeDeclarationNode
	value: ExpressionNode
	handlers: Array<{
		matcher: TypeDeclarationNode
		body: Array<ImplementationNode>
	}>
	position: Position
}

// #endregion

// #region Statements

export type StatementNode =
	| ConstantDeclarationStatementNode
	| VariableDeclarationStatementNode
	| VariableAssignmentStatementNode
	| NamespaceDefinitionStatementNode
	| TypeAliasStatementNode
	| IfElseStatementNode
	| IfStatementNode
	| ReturnStatementNode
	| FunctionStatementNode

export interface ConstantDeclarationStatementNode {
	nodeType: "ConstantDeclarationStatement"
	name: IdentifierNode
	type: TypeDeclarationNode | null
	value: ExpressionNode
	position: Position
}

export interface VariableDeclarationStatementNode {
	nodeType: "VariableDeclarationStatement"
	name: IdentifierNode
	type: TypeDeclarationNode | null
	value: ExpressionNode
	position: Position
}

export interface VariableAssignmentStatementNode {
	nodeType: "VariableAssignmentStatement"
	name: IdentifierNode
	value: ExpressionNode
	position: Position
}

export interface SimpleMethod {
	nodeType: "SimpleMethod"
	method: FunctionValueNode
}

export interface StaticMethod {
	nodeType: "StaticMethod"
	method: FunctionValueNode
}

export interface OverloadedMethod {
	nodeType: "OverloadedMethod"
	methods: Array<FunctionValueNode>
}

export interface OverloadedStaticMethod {
	nodeType: "OverloadedStaticMethod"
	methods: Array<FunctionValueNode>
}

export type NamespaceMethods = Record<
	string,
	SimpleMethod | StaticMethod | OverloadedMethod | OverloadedStaticMethod
>

export interface NamespaceDefinitionStatementNode {
	nodeType: "NamespaceDefinitionStatement"
	name: IdentifierNode
	targetType: TypeDeclarationNode | null
	properties: Record<
		string,
		{ type: TypeDeclarationNode | null; value: ExpressionNode }
	>
	methods: NamespaceMethods
	position: Position
}

export interface TypeAliasStatementNode {
	nodeType: "TypeAliasStatement"
	name: IdentifierNode
	type: TypeDeclarationNode
	position: Position
}

export interface IfElseStatementNode {
	nodeType: "IfElseStatement"
	condition: ExpressionNode
	trueBody: Array<ImplementationNode>
	falseBody: Array<ImplementationNode>
	position: Position
}

export interface IfStatementNode {
	nodeType: "IfStatement"
	condition: ExpressionNode
	body: Array<ImplementationNode>
	position: Position
}

export interface ReturnStatementNode {
	nodeType: "ReturnStatement"
	expression: ExpressionNode
	position: Position
}

export interface FunctionStatementNode {
	nodeType: "FunctionStatement"
	name: IdentifierNode
	value: FunctionDefinitionNode
	position: Position
}

// #endregion

// #region Helpers

export type TypeDeclarationNode =
	| IdentifierTypeDeclarationNode
	| RecordTypeDeclarationNode
	| UnionTypeDeclarationNode

export interface GenericDeclarationNode {
	nodeType: "GenericDeclarationNode"
	name: IdentifierNode
	defaultType: TypeDeclarationNode | null
	position: Position
}

export interface IdentifierTypeDeclarationNode {
	nodeType: "IdentifierTypeDeclaration"
	type: IdentifierNode
	position: Position
}

export interface RecordTypeDeclarationNode {
	nodeType: "RecordTypeDeclaration"
	members: Record<string, TypeDeclarationNode>
	position: Position
}

export interface ListTypeDeclarationNode {
	nodeType: "ListTypeDeclaration"
	type: TypeDeclarationNode
	position: Position
}

export interface UnionTypeDeclarationNode {
	nodeType: "UnionTypeDeclaration"
	types: Array<TypeDeclarationNode>
	position: Position
}

export interface FunctionDefinitionNode {
	nodeType: "FunctionDefinition"
	parameters: Array<ParameterNode>
	returnType: TypeDeclarationNode
	body: Array<ImplementationNode>
}

export interface GenericFunctionDefinitionNode {
	nodeType: "GenericFunctionDefinition"
	parameters: Array<ParameterNode>
	generics: Array<GenericDeclarationNode>
	returnType: TypeDeclarationNode
	body: Array<ImplementationNode>
}

export interface ParameterNode {
	nodeType: "Parameter"
	externalName: IdentifierNode | null
	internalName: IdentifierNode
	type: TypeDeclarationNode
	position: Position
}

export interface ArgumentNode {
	nodeType: "Argument"
	name: IdentifierNode | null
	value: ExpressionNode
}
// #endregion
