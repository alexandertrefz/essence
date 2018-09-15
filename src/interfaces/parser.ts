import { Position } from "./common"

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
	| MethodLookupNode
	| ValueNode
	| LookupNode
	| SelfNode
	| IdentifierNode
	| CombinationNode

export interface NativeFunctionInvocationNode {
	nodeType: "NativeFunctionInvocation"
	name: IdentifierNode
	arguments: Array<ArgumentNode>
	position: Position
}

export interface MethodInvocationNode {
	nodeType: "MethodInvocation"
	name: MethodLookupNode
	arguments: Array<ArgumentNode>
	position: Position
}

export interface FunctionInvocationNode {
	nodeType: "FunctionInvocation"
	name: ExpressionNode
	arguments: Array<ArgumentNode>
	position: Position
}

export interface MethodLookupNode {
	nodeType: "MethodLookup"
	base: ExpressionNode
	member: IdentifierNode
	position: Position
}

export type ValueNode =
	| RecordValueNode
	| StringValueNode
	| NumberValueNode
	| BooleanValueNode
	| FunctionValueNode
	| ArrayValueNode

export type RecordValueNode = {
	nodeType: "RecordValue"
	type: TypeDeclarationNode | null
	members: {
		[key: string]: ExpressionNode
	}
	position: Position
}

export type StringValueNode = {
	nodeType: "StringValue"
	value: string
	position: Position
}

export type NumberValueNode = {
	nodeType: "NumberValue"
	value: string
	position: Position
}
export type BooleanValueNode = {
	nodeType: "BooleanValue"
	value: boolean
	position: Position
}

export type FunctionValueNode = {
	nodeType: "FunctionValue"
	value: FunctionDefinitionNode
	position: Position
}

export type ArrayValueNode = {
	nodeType: "ArrayValue"
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

export interface Method {
	method: FunctionValueNode
	isStatic: boolean
	isOverloaded: false
}

export interface OverloadedMethod {
	methods: Array<FunctionValueNode>
	isStatic: boolean
	isOverloaded: true
}

export type Methods = {
	[key: string]: Method | OverloadedMethod
}

export interface TypeDefinitionStatementNode {
	nodeType: "TypeDefinitionStatement"
	name: IdentifierNode
	properties: {
		[key: string]: TypeDeclarationNode
	}
	methods: Methods
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

export type TypeDeclarationNode = IdentifierTypeDeclarationNode | ArrayTypeDeclarationNode

export interface IdentifierTypeDeclarationNode {
	nodeType: "IdentifierTypeDeclaration"
	type: IdentifierNode
	position: Position
}

export interface ArrayTypeDeclarationNode {
	nodeType: "ArrayTypeDeclaration"
	type: TypeDeclarationNode
	position: Position
}

export interface FunctionDefinitionNode {
	nodeType: "FunctionDefinition"
	parameters: Array<ParameterNode>
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
