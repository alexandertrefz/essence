import type { Documentation, Position } from "./common/index"

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
	| CaseValueNode

// NOTE: `ChoiceName#CaseName` with an optional payload —
// `CalculatorOperation#Add({ left = 1, right = 1 })` constructs a Case,
// `CalculatorOperation#ClearAll` references a unit Case. The payload is any
// Expression of the Case's Record shape, not only a literal. A null `choice`
// is the bare form (`#Add({ … })`), resolved against the Choices in scope —
// like Namespace resolution, it asks for the prefix only on ambiguity.
export interface CaseValueNode {
	nodeType: "CaseValue"
	choice: IdentifierNode | null
	caseName: IdentifierNode
	value: ExpressionNode | null
	position: Position
}

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
	| RationalValueNode
	| BooleanValueNode
	| NothingValueNode
	| FunctionValueNode
	| ListValueNode

// NOTE: Record members keep their name as a full IdentifierNode — the
// Language Server needs the name's Position for renaming.
export interface RecordValueMemberNode {
	name: IdentifierNode
	value: ExpressionNode
}

export type RecordValueNode = {
	nodeType: "RecordValue"
	type: TypeDeclarationNode | null
	members: Record<string, RecordValueMemberNode>
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

export type RationalValueNode = {
	nodeType: "RationalValue"
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
	value: FunctionDefinitionNode
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
		matcher: MatcherNode
		// NOTE: A `where` Guard makes the Handler conditional — it can decline
		// a value its Matcher accepted, which is why a guarded Handler can
		// never count towards exhaustiveness.
		guard: ExpressionNode | null
		body: Array<ImplementationNode>
	}>
	position: Position
}

export type MatcherNode =
	| TypeDeclarationNode
	| WildcardMatcherNode
	| LiteralMatcherNode
	| RecordMatcherNode
	| CaseMatcherNode

// NOTE: `case #Add` — a bare Case Matcher resolves its name against the
// matched value's own Union, so Cases match without their Choice's name in
// scope. The prefixed form (`case CalculatorOperation#Add`) disambiguates
// when two Choices in one Union share a Case name.
export interface CaseMatcherNode {
	nodeType: "CaseMatcher"
	choice: IdentifierNode | null
	caseName: IdentifierNode
	position: Position
}

// NOTE: A Record Matcher constrains members individually — `name: Type` by
// Type, `name = value` by value. A Matcher that constrains any member by value
// is conditional in the same way `case 0` is, since it can decline a Record
// whose Types all matched.
export interface RecordMatcherNode {
	nodeType: "RecordMatcher"
	members: Record<string, RecordMatcherMemberNode>
	position: Position
}

export type RecordMatcherMemberNode =
	| { kind: "Type"; name: IdentifierNode; type: TypeDeclarationNode }
	| { kind: "Value"; name: IdentifierNode; value: LiteralMatcherValueNode }

// NOTE: `case _` carries no Type of its own — the Enricher resolves it to
// whatever the Handlers before it have not already caught.
export interface WildcardMatcherNode {
	nodeType: "WildcardMatcher"
	position: Position
}

// NOTE: `case 0` matches one *value* rather than a Type, so — like a Guard —
// it only ever covers part of its own Type.
export interface LiteralMatcherNode {
	nodeType: "LiteralMatcher"
	value: LiteralMatcherValueNode
	position: Position
}

export type LiteralMatcherValueNode =
	| StringValueNode
	| IntegerValueNode
	| RationalValueNode
	| BooleanValueNode
	| NothingValueNode

// #endregion

// #region Statements

export type StatementNode =
	| ConstantDeclarationStatementNode
	| VariableDeclarationStatementNode
	| VariableAssignmentStatementNode
	| NamespaceDefinitionStatementNode
	| ProtocolDeclarationStatementNode
	| TypeAliasStatementNode
	| ChoiceDeclarationStatementNode
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
	documentation: Documentation | null
}

export interface VariableDeclarationStatementNode {
	nodeType: "VariableDeclarationStatement"
	name: IdentifierNode
	type: TypeDeclarationNode | null
	value: ExpressionNode
	position: Position
	documentation: Documentation | null
}

export interface VariableAssignmentStatementNode {
	nodeType: "VariableAssignmentStatement"
	name: IdentifierNode
	value: ExpressionNode
	position: Position
}

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
	documentation: Documentation | null
}

export interface OverloadedStaticMethod {
	nodeType: "OverloadedStaticMethod"
	name: IdentifierNode
	methods: Array<FunctionValueNode>
	documentation: Documentation | null
}

export type NamespaceMethods = Record<
	string,
	SimpleMethod | StaticMethod | OverloadedMethod | OverloadedStaticMethod
>

export interface NamespacePropertyNode {
	name: IdentifierNode
	documentation: Documentation | null
	type: TypeDeclarationNode | null
	value: ExpressionNode
}

export interface NamespaceDefinitionStatementNode {
	nodeType: "NamespaceDefinitionStatement"
	name: IdentifierNode
	generics: Array<GenericDeclarationNode>
	targetType: TypeDeclarationNode | null
	conformsTo: Array<IdentifierNode>
	properties: Record<string, NamespacePropertyNode>
	methods: NamespaceMethods
	position: Position
	documentation: Documentation | null
}

export interface ProtocolMethodSignatureNode {
	nodeType: "ProtocolMethodSignature"
	parameters: Array<ParameterNode>
	returnType: TypeDeclarationNode
	position: Position
	documentation: Documentation | null
}

export interface SimpleProtocolMethod {
	nodeType: "SimpleProtocolMethod"
	name: IdentifierNode
	signature: ProtocolMethodSignatureNode
}

export interface StaticProtocolMethod {
	nodeType: "StaticProtocolMethod"
	name: IdentifierNode
	signature: ProtocolMethodSignatureNode
}

export interface OverloadedProtocolMethod {
	nodeType: "OverloadedProtocolMethod"
	name: IdentifierNode
	signatures: Array<ProtocolMethodSignatureNode>
	documentation: Documentation | null
}

export interface OverloadedStaticProtocolMethod {
	nodeType: "OverloadedStaticProtocolMethod"
	name: IdentifierNode
	signatures: Array<ProtocolMethodSignatureNode>
	documentation: Documentation | null
}

export type ProtocolMethods = Record<
	string,
	| SimpleProtocolMethod
	| StaticProtocolMethod
	| OverloadedProtocolMethod
	| OverloadedStaticProtocolMethod
>

export interface ProtocolDeclarationStatementNode {
	nodeType: "ProtocolDeclarationStatement"
	name: IdentifierNode
	methods: ProtocolMethods
	position: Position
	documentation: Documentation | null
}

// NOTE: A Case's payload is always declared as a Record shape (or nothing at
// all for a unit Case) — every payload member is named at the declaration, so
// no wrapper property is ever needed to reach it.
export interface ChoiceCaseNode {
	name: IdentifierNode
	type: RecordTypeDeclarationNode | null
}

export interface ChoiceDeclarationStatementNode {
	nodeType: "ChoiceDeclarationStatement"
	name: IdentifierNode
	cases: Array<ChoiceCaseNode>
	position: Position
	documentation: Documentation | null
}

export interface TypeAliasStatementNode {
	nodeType: "TypeAliasStatement"
	name: IdentifierNode
	generics: Array<GenericDeclarationNode>
	type: TypeDeclarationNode
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
}

// #endregion

// #region Helpers

export type TypeDeclarationNode =
	| UngenericTypeDeclarationNode
	| GenericTypeDeclarationNode

export type UngenericTypeDeclarationNode =
	| IdentifierTypeDeclarationNode
	| RecordTypeDeclarationNode
	| UnionTypeDeclarationNode
	| FunctionTypeDeclarationNode

export interface GenericDeclarationNode {
	nodeType: "GenericDeclarationNode"
	name: IdentifierNode
	defaultType: TypeDeclarationNode | null
	inferred: boolean
	// NOTE: The Protocol bound of `<infer Item is Comparable>` — null when
	// the Type Parameter is unbounded.
	constraint: IdentifierNode | null
	position: Position
}

export interface IdentifierTypeDeclarationNode {
	nodeType: "IdentifierTypeDeclaration"
	type: IdentifierNode
	position: Position
}

// NOTE: Record Type members keep their name as a full IdentifierNode — the
// Language Server needs the name's Position for renaming.
export interface RecordTypeMemberNode {
	name: IdentifierNode
	type: TypeDeclarationNode
}

export interface RecordTypeDeclarationNode {
	nodeType: "RecordTypeDeclaration"
	members: Record<string, RecordTypeMemberNode>
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

export interface FunctionTypeParameterNode {
	nodeType: "FunctionTypeParameter"
	externalName: IdentifierNode | null
	type: TypeDeclarationNode
	position: Position
}

export interface FunctionTypeDeclarationNode {
	nodeType: "FunctionTypeDeclaration"
	parameterTypes: Array<FunctionTypeParameterNode>
	returnType: TypeDeclarationNode
	position: Position
}

export interface GenericTypeDeclarationNode {
	nodeType: "GenericTypeDeclaration"
	baseType: UngenericTypeDeclarationNode
	generics: Array<TypeDeclarationNode>
	position: Position
}

// NOTE: `returnType` is null for a Function literal in Argument position that
// omitted its `-> Type` — the Type comes from the expected signature, or from
// the body when the expected signature leaves it Generic. Only
// `parseFunctionLiteral` reached from expression position can produce a null;
// every Declaration still parses its annotation.
export interface FunctionDefinitionNode {
	nodeType: "FunctionDefinition"
	parameters: Array<ParameterNode>
	generics: Array<GenericDeclarationNode>
	returnType: TypeDeclarationNode | null
	body: Array<ImplementationNode>
	documentation: Documentation | null
	// NOTE: Where an omitted `-> Type` would have been written — the end of
	// the Parameter list. Carried so that an Inlay Hint for an inferred return
	// Type has somewhere to sit.
	parameterListPosition: Position
}

// NOTE: `internalName` is null for `_: Type`, which binds no name at all —
// the Parameter is positional and unreferenceable. That is what Function Types
// (where a name could never be referred to) and deliberately ignored
// Parameters need. `_ name: Type` still binds `name`, it only drops the label.
//
// `type` is null for an unannotated Parameter of a contextually typed Function
// literal. Such a Parameter takes both its Type *and* its label from the
// expected signature, which is why `externalName` is null alongside it — in
// `(item) { … }` there is no label to read off the source, and writing one
// would have nothing to agree with.
export interface ParameterNode {
	nodeType: "Parameter"
	externalName: IdentifierNode | null
	internalName: IdentifierNode | null
	type: TypeDeclarationNode | null
	position: Position
	documentation: Documentation | null
}

export interface ArgumentNode {
	nodeType: "Argument"
	name: IdentifierNode | null
	value: ExpressionNode
}
// #endregion
