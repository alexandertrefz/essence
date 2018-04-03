import { Position, Type, TypeType, ArrayType } from "./index"

export type Node = ExpressionNode | StatementNode

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
}

export interface FunctionInvocationNode {
	nodeType: "FunctionInvocation"
	name: ExpressionNode
	arguments: Array<ArgumentNode>
	position: Position
	type: Type
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
	| NumberValueNode
	| BooleanValueNode
	| FunctionValueNode
	| ArrayValueNode

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

export type NumberValueNode = {
	nodeType: "NumberValue"
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
	value: FunctionDefinitionNode
	position: Position
	type: Type
}

export type ArrayValueNode = {
	nodeType: "ArrayValue"
	values: Array<ExpressionNode>
	position: Position
	type: ArrayType
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

export interface TypeDefinitionStatementNode {
	nodeType: "TypeDefinitionStatement"
	name: IdentifierNode
	properties: {
		[key: string]: Type
	}
	methods: {
		[key: string]: {
			method: FunctionValueNode
			isStatic: boolean
		}
	}
	position: Position
	type: Type
}

export interface IfElseStatementNode {
	nodeType: "IfElseStatement"
	condition: ExpressionNode
	trueBody: Array<Node>
	falseBody: Array<Node>
	position: Position
}

export interface IfStatementNode {
	nodeType: "IfStatement"
	condition: ExpressionNode
	body: Array<Node>
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

export interface FunctionDefinitionNode {
	nodeType: "FunctionDefinition"
	parameters: Array<ParameterNode>
	body: Array<Node>
}

export interface ArgumentNode {
	nodeType: "Argument"
	name: string | null
	value: ExpressionNode
	type: Type
}

// #endregion
