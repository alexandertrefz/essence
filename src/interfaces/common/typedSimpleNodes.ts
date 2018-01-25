import { Type, ArrayType } from "./index"

export type Node = ExpressionNode | StatementNode

// #region Expressions

export type ExpressionNode =
	| NativeFunctionInvocationNode
	| FunctionInvocationNode
	| ValueNode
	| LookupNode
	| IdentifierNode
	| CombinationNode

export interface NativeFunctionInvocationNode {
	nodeType: "NativeFunctionInvocation"
	name: IdentifierNode | LookupNode
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
	| NumberValueNode
	| BooleanValueNode
	| FunctionValueNode
	| ArrayValueNode

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

export type NumberValueNode = {
	nodeType: "NumberValue"
	value: string
	type: Type
}

export type BooleanValueNode = {
	nodeType: "BooleanValue"
	value: boolean
	type: Type
}

export type FunctionValueNode = {
	nodeType: "FunctionValue"
	value: FunctionDefinitionNode
	type: Type
}

export type ArrayValueNode = {
	nodeType: "ArrayValue"
	values: Array<ExpressionNode>
	type: ArrayType
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

export interface TypeDefinitionStatementNode {
	nodeType: "TypeDefinitionStatement"
	name: IdentifierNode
	properties: {
		[key: string]: Type
	}
	methods: {
		[key: string]: { method: FunctionValueNode; isStatic: boolean }
	}
	type: Type
}

export interface ChoiceStatementNode {
	nodeType: "ChoiceStatement"
	condition: ExpressionNode
	trueBody: Array<Node>
	falseBody: Array<Node>
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
	body: Array<Node>
}

export interface ParameterNode {
	nodeType: "Parameter"
	externalName: IdentifierNode | null
	internalName: IdentifierNode
}

export interface ArgumentNode {
	nodeType: "Argument"
	name: string | null
	value: ExpressionNode
}

// #endregion
