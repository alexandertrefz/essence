import type {
	BooleanType,
	FractionType,
	FunctionType,
	GenericFunctionType,
	IntegerType,
	ListType,
	NamespaceType,
	NothingType,
	StringType,
	Type,
} from "./index"

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
	| MethodInvocationNode
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

export interface MethodInvocationNode {
	nodeType: "MethodInvocation"
	base: IdentifierNode
	member: {
		name: string
	}
	arguments: Array<ArgumentNode>
	type: Type
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
	type: Type
	members: Record<string, ExpressionNode>
}

export type StringValueNode = {
	nodeType: "StringValue"
	value: string
	type: StringType
}

export type IntegerValueNode = {
	nodeType: "IntegerValue"
	value: string
	type: IntegerType
}

export type FractionValueNode = {
	nodeType: "FractionValue"
	numerator: string
	denominator: string
	type: FractionType
}

export type BooleanValueNode = {
	nodeType: "BooleanValue"
	value: boolean
	type: BooleanType
}

export type NothingValueNode = {
	nodeType: "NothingValue"
	type: NothingType
}

export type FunctionValueNode = {
	nodeType: "FunctionValue"
	value: FunctionDefinitionNode | GenericFunctionDefinitionNode
	type: FunctionType | GenericFunctionType
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
	| NamespaceDefinitionStatementNode
	| TypeAliasStatementNode
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

export type Methods = Record<string, Method>

export interface NamespaceDefinitionStatementNode {
	nodeType: "NamespaceDefinitionStatement"
	name: IdentifierNode
	properties: Record<string, ExpressionNode>
	methods: Methods
	type: NamespaceType
}

export interface TypeAliasStatementNode {
	nodeType: "TypeAliasStatement"
	name: IdentifierNode
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
