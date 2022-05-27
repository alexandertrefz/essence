import { Position, Type, TypeType, ListType } from "./index"

// #region Program & Sections

export type Program = {
	nodeType: "Program"
	implementation: ImplementationSectionNode
	position: Position
}

export type ImplementationSectionNode = {
	nodeType: "ImplementationSection"
	nodes: Array<ImplementationNode>
	position: Position
}

export type ImplementationNode = ExpressionNode | StatementNode

// #endregion

// #region Expressions

export type ExpressionNode =
	| NativeFunctionInvocationNode
	| MethodInvocationNode
	| FunctionInvocationNode
	| MethodLookupNode
	| ValueNode
	| LookupNode
	| IdentifierNode
	| SelfNode
	| CombinationNode

export interface NativeFunctionInvocationNode {
	nodeType: "NativeFunctionInvocation"
	name: IdentifierNode
	arguments: Array<ArgumentNode>
	position: Position
	type: Type
}

export interface MethodInvocationNode {
	nodeType: "MethodInvocation"
	name: MethodLookupNode
	arguments: Array<ArgumentNode>
	position: Position
	type: Type
	overloadedMethodIndex: number | null
}

export interface FunctionInvocationNode {
	nodeType: "FunctionInvocation"
	name: ExpressionNode
	arguments: Array<ArgumentNode>
	position: Position
	type: Type
	overloadedMethodIndex: number | null
}

export interface MethodLookupNode {
	nodeType: "MethodLookup"
	base: ExpressionNode
	member: IdentifierNode
	position: Position
	baseType: TypeType
	type: Type
}

export type ValueNode =
	| RecordValueNode
	| StringValueNode
	| IntegerValueNode
	| BooleanValueNode
	| FunctionValueNode
	| ListValueNode

export type RecordValueNode = {
	nodeType: "RecordValue"
	declaredType: Type | null
	type: Type
	members: {
		[key: string]: ExpressionNode
	}
	position: Position
}

export type StringValueNode = {
	nodeType: "StringValue"
	value: string
	position: Position
	type: Type
}

export type IntegerValueNode = {
	nodeType: "IntegerValue"
	value: string
	position: Position
	type: Type
}

export type BooleanValueNode = {
	nodeType: "BooleanValue"
	value: boolean
	position: Position
	type: Type
}

export type FunctionValueNode = {
	nodeType: "FunctionValue"
	value: FunctionDefinitionNode | GenericFunctionDefinitionNode
	position: Position
	type: Type
}

export type ListValueNode = {
	nodeType: "ListValue"
	values: Array<ExpressionNode>
	position: Position
	type: ListType
}

export interface LookupNode {
	nodeType: "Lookup"
	base: ExpressionNode
	member: IdentifierNode
	position: Position
	type: Type
}

export interface IdentifierNode {
	nodeType: "Identifier"
	content: string
	position: Position
	type: Type
}

export interface SelfNode {
	nodeType: "Self"
	position: Position
	type: Type
}

export interface CombinationNode {
	nodeType: "Combination"
	lhs: ExpressionNode
	rhs: ExpressionNode
	position: Position
	type: Type
}

// #endregion

// #region Statements

export type StatementNode =
	| ConstantDeclarationStatementNode
	| VariableDeclarationStatementNode
	| VariableAssignmentStatementNode
	| TypeDefinitionStatementNode
	| IfElseStatementNode
	| IfStatementNode
	| ReturnStatementNode
	| FunctionStatementNode

export interface ConstantDeclarationStatementNode {
	nodeType: "ConstantDeclarationStatement"
	name: IdentifierNode
	value: ExpressionNode
	position: Position
	declaredType: Type | null
	type: Type
}

export interface VariableDeclarationStatementNode {
	nodeType: "VariableDeclarationStatement"
	name: IdentifierNode
	value: ExpressionNode
	position: Position
	declaredType: Type | null
	type: Type
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

export type Method = SimpleMethod | StaticMethod | OverloadedMethod | OverloadedStaticMethod

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
	position: Position
	type: Type
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
	type: Type
}

// #endregion

// #region Helpers

export interface ParameterNode {
	nodeType: "Parameter"
	externalName: IdentifierNode | null
	internalName: IdentifierNode
	position: Position
}

export interface GenericDeclarationNode {
	nodeType: "GenericDeclaration"
	name: string
	defaultType: Type | null
	position: Position
}

export interface GenericFunctionDefinitionNode {
	nodeType: "GenericFunctionDefinition"
	generics: Array<GenericDeclarationNode>
	parameters: Array<ParameterNode>
	body: Array<ImplementationNode>
	returnType: Type
	position: Position
}

export interface FunctionDefinitionNode {
	nodeType: "FunctionDefinition"
	parameters: Array<ParameterNode>
	body: Array<ImplementationNode>
	returnType: Type
}

export interface ArgumentNode {
	nodeType: "Argument"
	name: string | null
	value: ExpressionNode
	type: Type
}

// #endregion
