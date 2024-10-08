import type {
	BooleanType,
	FractionType,
	FunctionType,
	GenericFunctionType,
	IntegerType,
	ListType,
	NamespaceType,
	NothingType,
	Position,
	StringType,
	Type,
} from "./index"

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
	| ValueNode
	| LookupNode
	| IdentifierNode
	| SelfNode
	| CombinationNode
	| MatchNode

export interface NativeFunctionInvocationNode {
	nodeType: "NativeFunctionInvocation"
	name: IdentifierNode
	arguments: Array<ArgumentNode>
	position: Position
	type: Type
}

export interface MethodInvocationNode {
	nodeType: "MethodInvocation"
	base: ExpressionNode
	member: {
		name: string
		position: Position
	}
	arguments: Array<ArgumentNode>
	position: Position
	namespace: {
		name: string
		type: NamespaceType
	}
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
	declaredType: Type | null
	type: Type
	members: Record<string, ExpressionNode>
	position: Position
}

export type StringValueNode = {
	nodeType: "StringValue"
	value: string
	position: Position
	type: StringType
}

export type IntegerValueNode = {
	nodeType: "IntegerValue"
	value: string
	position: Position
	type: IntegerType
}

export type FractionValueNode = {
	nodeType: "FractionValue"
	numerator: string
	denominator: string
	position: Position
	type: FractionType
}

export type BooleanValueNode = {
	nodeType: "BooleanValue"
	value: boolean
	position: Position
	type: BooleanType
}

export type NothingValueNode = {
	nodeType: "NothingValue"
	position: Position
	type: NothingType
}

export type FunctionValueNode = {
	nodeType: "FunctionValue"
	value: FunctionDefinitionNode | GenericFunctionDefinitionNode
	position: Position
	type: FunctionType | GenericFunctionType
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

export interface MatchNode {
	nodeType: "Match"
	value: ExpressionNode
	handlers: Array<{
		matcher: Type
		body: Array<ImplementationNode>
	}>
	position: Position
	type: Type
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

export type Methods = Record<
	string,
	SimpleMethod | StaticMethod | OverloadedMethod | OverloadedStaticMethod
>

export interface NamespaceDefinitionStatementNode {
	nodeType: "NamespaceDefinitionStatement"
	name: IdentifierNode
	targetType: Type | null
	properties: Record<string, { type: Type; value: ExpressionNode }>
	methods: Methods
	position: Position
	type: NamespaceType
}

export interface TypeAliasStatementNode {
	nodeType: "TypeAliasStatement"
	name: IdentifierNode
	type: Type
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
