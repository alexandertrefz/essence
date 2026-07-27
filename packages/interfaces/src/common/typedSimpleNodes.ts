import type {
	BooleanType,
	CaseType,
	DerivedEquatableDescriptor,
	ErrorType,
	RationalType,
	FunctionType,
	IntegerType,
	ListType,
	NamespaceType,
	NothingType,
	RecordType,
	StringType,
	Type,
} from "./index"

// #region Program & Sections

export type Program = {
	nodeType: "Program"
	imports: ImportSectionNode | null
	implementation: ImplementationSectionNode
	exports: ExportSectionNode | null
}

export type ImplementationSectionNode = {
	nodeType: "ImplementationSection"
	nodes: Array<ImplementationNode>
}

export type ImportSectionNode = {
	nodeType: "ImportSection"
	entries: Array<ImportNode>
}

// NOTE: An entry reduced to what emission needs of it: the name the other
// Module exports, the name this one binds it under, the Module it comes from
// and whether it names anything the JavaScript binds at all. The specifier as
// written is gone with the Positions — a Module is keyed by its canonical path
// from here on, and nothing downstream reports about an entry.
export type ImportNode = {
	nodeType: "Import"
	name: string
	alias: string | null
	modulePath: string | null
	runtime: boolean
}

export type ExportSectionNode = {
	nodeType: "ExportSection"
	entries: Array<ExportNode>
}

// NOTE: `modulePath` is set exactly on a re-export, which forwards a name this
// Module never bound — so emission reads it off that Module rather than out of
// its own Scope.
export type ExportNode = {
	nodeType: "Export"
	name: string
	alias: string | null
	modulePath: string | null
	runtime: boolean
}

export type ImplementationNode = ExpressionNode | StatementNode

// #endregion

// #region Expressions

export type ExpressionNode =
	| NativeFunctionInvocationNode
	| FunctionInvocationNode
	| MethodInvocationNode
	| UnionMethodInvocationNode
	| ValueNode
	| LookupNode
	| IdentifierNode
	| CombinationNode
	| MatchNode
	| ConformanceValueNode
	| CaseValueNode

// NOTE: A Case construction, reduced to its runtime essentials — the tag the
// value carries (`"CalculatorOperation#Add"`) and the payload Record it is
// built from (null for unit Cases).
export interface CaseValueNode {
	nodeType: "CaseValue"
	tag: string
	value: ExpressionNode | null
	type: CaseType | ErrorType
}

// NOTE: The value passed for a Protocol-bounded Type Parameter — rewritten
// into an object literal that maps each Protocol Method's emitted name onto
// the conforming Namespace's fulfilling Method.
export interface ConformanceValueNode {
	nodeType: "ConformanceValue"
	namespaceName: string
	methodMap: Record<string, string>
	// NOTE: The witness values for this Namespace's own `where` conditions, in
	// Generic declaration order. Empty for an unconditional conformance, which
	// the Rewriter emits as a plain method-map object literal.
	conditions: Array<ExpressionNode>
	// NOTE: Present only when this witness is a *generic* Choice's derived
	// Equatable — the Rewriter then emits `$helpers.boundChoiceIs(<descriptor>)`
	// for each mapped Method instead of the plain `choiceIs`.
	derivedDescriptor?: DerivedEquatableDescriptor
	type: Type
}

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
	// NOTE: Present only when this call is a *generic* Choice's derived
	// Equatable — the Rewriter then emits `$helpers.boundChoiceIs(<descriptor>)`
	// in place of the plain `choiceIs` member read.
	derivedDescriptor?: DerivedEquatableDescriptor
	type: Type
}

// NOTE: A Method Invocation on a Union-typed receiver — one statically
// resolved target per member Type, picked at runtime by the receiver's
// actual Type. `methodName` is already overload-mangled, and each case
// carries the hidden conformance Arguments its target requires.
export interface UnionMethodInvocationNode {
	nodeType: "UnionMethodInvocation"
	base: ExpressionNode
	cases: Array<UnionMethodDispatchCase>
	arguments: Array<ArgumentNode>
	type: Type
}

export type UnionMethodDispatchCase = {
	memberType: Type
	namespaceName: string
	methodName: string
	conformanceArguments: Array<ArgumentNode>
	// NOTE: The Arguments this branch alone is given — a contextually typed
	// Function literal compiled against THIS branch's Method — each under the
	// position in the shared Argument list it stands in for. The Rewriter emits
	// them as `dispatchMethod`'s fourth case element, and only when there are
	// any, so a dispatch passing no such literal emits what it always did.
	contextualArguments: Array<{ index: number; argument: ArgumentNode }>
	// NOTE: Present only when this branch resolves to a *generic* Choice's
	// derived Equatable — the Rewriter then emits
	// `$helpers.boundChoiceIs(<descriptor>)` for the branch's Method.
	derivedDescriptor?: DerivedEquatableDescriptor
}

export type ValueNode =
	| RecordValueNode
	| StringValueNode
	| IntegerValueNode
	| RationalValueNode
	| BooleanValueNode
	| NothingValueNode
	| FunctionValueNode
	| ListValueNode

export type RecordValueNode = {
	nodeType: "RecordValue"
	type: RecordType
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

export type RationalValueNode = {
	nodeType: "RationalValue"
	numerator: string
	denominator: string
	type: RationalType
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
	value: FunctionDefinitionNode
	type: FunctionType
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

// NOTE: `type` is only a Record Type for valid Programs — invalid
// Combinations recover with an Error Type. The Simplifier only runs on
// Programs without Error Diagnostics.
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
		literal: ExpressionNode | null
		memberLiterals: Record<string, ExpressionNode> | null
		guard: ExpressionNode | null
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
	| ProtocolDeclarationStatementNode
	| TypeAliasStatementNode
	| ConditionalStatementNode
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

export interface ProtocolDeclarationStatementNode {
	nodeType: "ProtocolDeclarationStatement"
	name: IdentifierNode
}

export interface TypeAliasStatementNode {
	nodeType: "TypeAliasStatement"
	name: IdentifierNode
	type: Type
}

export interface ConditionalStatementNode {
	nodeType: "ConditionalStatement"
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
