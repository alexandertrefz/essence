import type {
	BooleanType,
	Documentation,
	FractionType,
	FunctionType,
	IntegerType,
	ListType,
	NamespaceType,
	NothingType,
	Position,
	ProtocolType,
	RecordType,
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
	declaredType: RecordType | null
	type: RecordType
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
	value: FunctionDefinitionNode
	position: Position
	type: FunctionType
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

// NOTE: `type` is only a Record Type for valid Programs — invalid
// Combinations recover with an Error Type.
export interface CombinationNode {
	nodeType: "Combination"
	lhs: ExpressionNode
	rhs: ExpressionNode
	position: Position
	type: Type
}

// NOTE: `matcher` is the Type a Handler binds `@` to. `literal` and `guard`
// are what make a Handler *conditional*: it can decline a value whose Type the
// Matcher accepted, so it covers only part of `matcher` and can never make a
// Union exhaustive on its own.
export interface MatchNode {
	nodeType: "Match"
	value: ExpressionNode
	handlers: Array<{
		matcher: Type
		literal: ExpressionNode | null
		memberLiterals: Record<string, ExpressionNode> | null
		guard: ExpressionNode | null
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
	| ProtocolDeclarationStatementNode
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
	documentation: Documentation | null
}

export interface VariableDeclarationStatementNode {
	nodeType: "VariableDeclarationStatement"
	name: IdentifierNode
	value: ExpressionNode
	position: Position
	declaredType: Type | null
	type: Type
	documentation: Documentation | null
}

export interface VariableAssignmentStatementNode {
	nodeType: "VariableAssignmentStatement"
	name: IdentifierNode
	value: ExpressionNode
	position: Position
}

export interface NamespaceProperty {
	name: IdentifierNode
	type: Type
	value: ExpressionNode
	documentation: Documentation | null
}

// NOTE: The name is kept as an Identifier of its own rather than left to the
// `Methods` record key — a key carries no Position, so without it nothing can
// tell that the cursor is on the Method's name.
export interface SimpleMethod {
	nodeType: "SimpleMethod"
	name: IdentifierNode
	method: FunctionValueNode
}

export interface StaticMethod {
	nodeType: "StaticMethod"
	name: IdentifierNode
	method: FunctionValueNode
}

export interface OverloadedMethod {
	nodeType: "OverloadedMethod"
	name: IdentifierNode
	methods: Array<FunctionValueNode>
}

export interface OverloadedStaticMethod {
	nodeType: "OverloadedStaticMethod"
	name: IdentifierNode
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
	properties: Record<string, NamespaceProperty>
	methods: Methods
	position: Position
	type: NamespaceType
	documentation: Documentation | null
}

export interface ProtocolDeclarationStatementNode {
	nodeType: "ProtocolDeclarationStatement"
	name: IdentifierNode
	protocolType: ProtocolType
	position: Position
	documentation: Documentation | null
}

export interface TypeAliasStatementNode {
	nodeType: "TypeAliasStatement"
	name: IdentifierNode
	type: Type
	position: Position
	documentation: Documentation | null
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

// NOTE: A null `internalName` is the `_: Type` form — see the Parser's
// ParameterNode. It survives into the typed tree so that nothing downstream
// mistakes the Parameter for one the body could have referenced; the
// Simplifier is where it finally gets a positional placeholder to emit.
export interface ParameterNode {
	nodeType: "Parameter"
	externalName: IdentifierNode | null
	internalName: IdentifierNode | null
	position: Position
}

export interface GenericDeclarationNode {
	nodeType: "GenericDeclaration"
	name: string
	defaultType: Type | null
	inferred: boolean
	position: Position
}

export interface FunctionDefinitionNode {
	nodeType: "FunctionDefinition"
	generics: Array<GenericDeclarationNode>
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
