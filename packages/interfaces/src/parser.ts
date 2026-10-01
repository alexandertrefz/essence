import type { Documentation, Position } from "./common/index"

// A name an abandoned Statement declared, and where it stood. A read the
// Declaration could not have answered is still reported.
export type AbandonedDeclaration = {
	name: string
	// Where the abandoned run begins. A Declaration that does not hoist is in
	// scope from its own line down.
	position: Position
	// The innermost block the run stands in, claimed as that block closes.
	enclosing: Position
	// Whether the run opened with a keyword whose Declaration hoists:
	// `function`, `overload`, `type`, `choice`, `namespace` or `protocol`.
	hoistable: boolean
	// Whether the run stood directly in a section block. Only there does a
	// Declaration hoist, so a `type` inside a body is hoistable but not hoisted.
	atSectionLevel: boolean
}

// What the Parser could not read, so that no later stage reports the same
// mistake again in its own words. See "Recovery" in DEVELOPMENT.md.
export type Recovery = {
	// The names an abandoned Statement would have declared, as far as its
	// Tokens say. A name missed here is read as if nothing were abandoned.
	declarations: Array<AbandonedDeclaration>
	// Every line the Parser abandoned text on. What a construct across one of
	// them lacks says nothing, since the Parser did not read it whole.
	lines: Array<number>
	// The lines of the abandoned runs that could have opened a body, the only
	// runs that can leave a `<-` standing outside a Function.
	headLines: Array<number>
}

export type Program = {
	nodeType: "Program"
	// `declarations { … }` is the standard library's form, whose Namespaces
	// may declare natives. `tests` is a file holding only a `tests { … }`
	// block. It still carries an empty `implementation` spanning that block,
	// and `kind` keeps the Formatter from writing one.
	kind: "implementation" | "declarations" | "tests"
	// Null where the file writes no import block.
	imports: ImportSectionNode | null
	implementation: ImplementationSectionNode
	// A section rather than a Statement, so a compile that does not ask for
	// tests skips it whole and never enriches it.
	tests: TestsSectionNode | null
	exports: ExportSectionNode | null
	// Absent rather than empty where the Parser abandoned nothing.
	recovery?: Recovery
	position: Position
}

// #region Sections

export type ImplementationSectionNode = {
	nodeType: "ImplementationSection"
	nodes: Array<ImplementationNode>
	position: Position
}

// The `tests { … }` block. It holds what an implementation block holds,
// plus tests and suites.
export type TestsSectionNode = {
	nodeType: "TestsSection"
	nodes: Array<TestsNode>
	position: Position
}

// What may stand in a tests section or a suite's body. `TestNode` and
// `SuiteNode` stay out of `StatementNode`, so a stage walking Statements
// never meets them.
export type TestsNode = TestNode | SuiteNode | ImplementationNode

// `test "name" MODIFIER* { … }`, or a `benchmark`, which has the same shape
// and is timed rather than judged. A table test may interpolate its row into
// the name. `keywordPosition` is the keyword alone, where a Code Lens stands.
export interface TestNode {
	nodeType: "Test"
	form: "test" | "benchmark"
	name: StringValueNode | InterpolatedStringValueNode
	modifiers: Array<TestModifierNode>
	// `across ROWS (row: Row)`, written between the Modifiers and the body.
	table: TestTableNode | null
	// `for any (a: T, b: U)`, in the same slot. The enricher refuses a test
	// that writes both.
	properties: TestPropertiesNode | null
	body: Array<ImplementationNode>
	keywordPosition: Position
	position: Position
}

// `across [ … ] (row: Row)`. The rows are a written List, because a test's
// identity carries its row's index. `parameters` is a closure's Parameter
// list, so a Pattern may take a row apart.
export interface TestTableNode {
	nodeType: "TestTable"
	value: ExpressionNode
	parameters: Array<ParameterNode>
	parameterListPosition: Position
	keywordPosition: Position
	position: Position
}

// `for any (a: Integer, b: NonEmptyList<String>)`. The runner generates each
// Parameter's value from its Type, so every Parameter must write one.
export interface TestPropertiesNode {
	nodeType: "TestProperties"
	parameters: Array<ParameterNode>
	parameterListPosition: Position
	keywordPosition: Position
	position: Position
}

// `suite "name" MODIFIER* { … }`, a group of tests sharing a scope. Its
// Modifiers cover every test inside it.
export interface SuiteNode {
	nodeType: "Suite"
	name: StringValueNode | InterpolatedStringValueNode
	modifiers: Array<TestModifierNode>
	nodes: Array<TestsNode>
	keywordPosition: Position
	position: Position
}

// A Modifier of a test or suite, such as `skipped "waiting"`, `focused` or
// `tagged slow, network`. The Parser reads any name and its arguments, and
// the enricher knows what each name means.
export interface TestModifierNode {
	nodeType: "TestModifier"
	name: IdentifierNode
	arguments: Array<TestModifierArgumentNode>
	position: Position
}

// A literal or a bare name, never an Expression, since an Expression may
// begin with the `{` that opens the test's body.
export type TestModifierArgumentNode =
	| IdentifierNode
	| StringValueNode
	| IntegerValueNode
	| RationalValueNode
	| BooleanValueNode

// `import { … }`, written above the implementation. `groups` holds one group
// per dependency as written, and `entries` the same names flat in written
// order, which is how resolution reads them.
export type ImportSectionNode = {
	nodeType: "ImportSection"
	groups: Array<ImportGroupNode>
	entries: Array<ImportNode>
	position: Position
}

// `from "./Module.es" { … }`. Each entry inside carries the same `source`.
export type ImportGroupNode = {
	nodeType: "ImportGroup"
	source: ModuleSpecifierNode
	entries: Array<ImportNode>
	position: Position
}

// `name as alias`. `name` is always the exported name, and `alias` is null
// where the entry binds that name.
export type ImportNode = {
	nodeType: "Import"
	name: IdentifierNode
	alias: IdentifierNode | null
	source: ModuleSpecifierNode
	position: Position
}

// `export { … }`, written after the implementation. A name the Module
// declares is written bare, and a name it forwards from a dependency stands in
// a group. `entries` holds both kinds flat, in written order.
export type ExportSectionNode = {
	nodeType: "ExportSection"
	groups: Array<ExportGroupNode>
	entries: Array<ExportNode>
	position: Position
}

// `from "./Module.es" { … }` in an export block, forwarding names from one
// dependency.
export type ExportGroupNode = {
	nodeType: "ExportGroup"
	source: ModuleSpecifierNode
	entries: Array<ExportNode>
	position: Position
}

// A `source` makes the entry forward a dependency's name without binding it
// here. Null exports something this Program declares.
export type ExportNode = {
	nodeType: "Export"
	name: IdentifierNode
	alias: IdentifierNode | null
	source: ModuleSpecifierNode | null
	position: Position
}

// The String a `from` clause carries, exactly as written. Resolution decides
// what it names.
export type ModuleSpecifierNode = {
	nodeType: "ModuleSpecifier"
	path: string
	position: Position
}

// #endregion

export type ImplementationNode = ExpressionNode | StatementNode

// #region Expressions

export type ExpressionNode =
	| MethodInvocationNode
	| FunctionInvocationNode
	| ValueNode
	| LookupNode
	| MemberPathNode
	| SelfNode
	| IdentifierNode
	| CombinationNode
	| MatchNode
	| DefineNode
	| CaseValueNode
	| StartNode
	| CompleteNode
	| RefusedValueNode

// What is left of an Expression written in another language's syntax, such
// as `primes[0]`. The Statement around it survives, so `first` in
// `constant first = primes[0]` is declared and typed `Error`, which no reader
// reports on. See "Refused values" in DEVELOPMENT.md.
export interface RefusedValueNode {
	nodeType: "RefusedValue"
	// What was written before the refused text. What stood inside the
	// brackets is not kept.
	base: ExpressionNode
	position: Position
}

// `start expr` puts a Future in flight and answers its `Started`, and
// `complete expr` waits for a Future or a `Started`. The operand is the whole
// postfix chain. See "Start and complete" in DEVELOPMENT.md.
export interface StartNode {
	nodeType: "Start"
	expression: ExpressionNode
	position: Position
}

export interface CompleteNode {
	nodeType: "Complete"
	expression: ExpressionNode
	position: Position
}

// `Choice#Case`, with an optional payload of any Expression. A null `choice`
// is the bare form `#Add({ … })`, resolved against the Choices in scope and
// asking for the prefix only when two of them fit.
export interface CaseValueNode {
	nodeType: "CaseValue"
	choice: IdentifierNode | null
	// `Holder<Integer>#Full({ … })`. A Choice's Type Parameters are applied,
	// never inferred, so this spelling applies them where the position does
	// not. Null where none were written.
	typeArguments: Array<TypeDeclarationNode> | null
	caseName: IdentifierNode
	value: ExpressionNode | null
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
	| InterpolatedStringValueNode
	| IntegerValueNode
	| RationalValueNode
	| BooleanValueNode
	| FunctionValueNode
	| ListValueNode
	| DictionaryValueNode

export interface RecordValueMemberNode {
	name: IdentifierNode
	// Null exactly where `group` is set.
	value: ExpressionNode | null
	// Set where the member is written as a bare name, `{ x }` for
	// `{ x = x }`. The name and the value then share one Position, so a rename
	// of either expands the member. See "Absent rather than false" in
	// DEVELOPMENT.md.
	shorthand?: true
	// Every step of a dotted key such as `server.tls.enabled = true`, the
	// first included. `members` keys such a member by its dotted spelling, so
	// two paths sharing a prefix do not collide.
	steps?: Array<IdentifierNode>
	// A member list written against the value `steps` reaches, as in
	// `server.{ port = 1, host = "db" }`.
	group?: RecordValueNode
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

// A String with at least one `{ … }` hole. `segments` alternates text, which
// may be empty, with each hole's Expression, and starts and ends with text.
// The Lexer has already decoded the escapes in the text.
export type InterpolationSegmentNode =
	| { kind: "text"; value: string }
	| { kind: "expression"; expression: ExpressionNode }

export type InterpolatedStringValueNode = {
	nodeType: "InterpolatedStringValue"
	segments: Array<InterpolationSegmentNode>
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

// One `key = value` of a Dictionary. A Dictionary's key is a value rather
// than a name, so neither half is renamed with anything.
export type DictionaryEntryNode = {
	key: ExpressionNode
	value: ExpressionNode
	position: Position
}

// `["alex" = 39, "sam" = 25]`, or `[=]` for the empty one. The entries keep
// their written order, which is the Dictionary's order, and two written keys
// may be one value.
export type DictionaryValueNode = {
	nodeType: "DictionaryValue"
	entries: Array<DictionaryEntryNode>
	position: Position
}

export interface LookupNode {
	nodeType: "Lookup"
	base: ExpressionNode
	member: IdentifierNode
	position: Position
}

// `.price` or `.address.city`, written where a Function of one Parameter is
// expected. The enricher turns it into the Function that reads those members,
// whose Lookups take the steps' Positions.
export interface MemberPathNode {
	nodeType: "MemberPath"
	steps: Array<IdentifierNode>
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
	// Set where the update is written in brackets, `[ages with "kim" = 7]`.
	// A whole-value update has the same shape in both spellings, so only this
	// tells them apart.
	brackets?: true
	// Set where the right side is a bare key list, as in
	// `{ config with port = 1 }`, rather than a whole value such as
	// `[ages with ["kim" = 7]]`. Both build the same node kind.
	bare?: true
	position: Position
}

export interface MatchNode {
	nodeType: "Match"
	returnType: TypeDeclarationNode
	value: ExpressionNode
	handlers: Array<{
		matcher: MatcherNode
		// A `where` Guard may decline a value its Matcher accepted, so a
		// guarded Handler never counts towards exhaustiveness.
		guard: ExpressionNode | null
		body: Array<ImplementationNode>
	}>
	position: Position
}

// `define { as "A" if score::isGreaterThan(90) … as "F" otherwise }`. It
// answers with the first arm whose Condition holds, else with `otherwise`.
// An arm is one Expression in the `define`'s own Scope, and binds nothing.
// `otherwise` is a field of its own, so every node has exactly one, last.
export interface DefineNode {
	nodeType: "Define"
	returnType: TypeDeclarationNode | null
	arms: Array<DefineArmNode>
	otherwise: DefineOtherwiseNode
	position: Position
}

// Spans from `as` to the end of the Condition.
export interface DefineArmNode {
	value: ExpressionNode
	condition: ExpressionNode
	position: Position
}

export interface DefineOtherwiseNode {
	value: ExpressionNode
	position: Position
}

export type MatcherNode =
	| TypeDeclarationNode
	| WildcardMatcherNode
	| LiteralMatcherNode
	| PatternNode
	| CaseMatcherNode

// `case #Add` resolves against the matched value's own Union. The prefixed
// `case Calculator#Add` tells apart two Choices that share a Case name.
// `binding` names what the constructor takes, so `case #Value(item)` mirrors
// `#Value(5)`, and a Pattern there takes the payload apart. `@` stays the
// matched value narrowed to this Matcher.
export interface CaseMatcherNode {
	nodeType: "CaseMatcher"
	choice: IdentifierNode | null
	caseName: IdentifierNode
	binding: IdentifierNode | PatternNode | null
	position: Position
}

// A Pattern takes a value apart in a Matcher, a Case payload binder, a
// Parameter or a Declaration. `name: Type` binds and constrains by Type, and
// `{ x }` is that form with its Type elided. `name = value` constrains without
// binding, so it may decline a value and is refused where nothing can decline.
export interface PatternNode {
	nodeType: "Pattern"
	members: Record<string, PatternMemberNode>
	// `} as name`, one name for the whole value beside the names its members
	// bind. Refused at the top level of a Matcher, where `@` names the value.
	binder: IdentifierNode | null
	position: Position
}

// `position` spans the whole member, such as `width: Integer as w`.
export type PatternMemberNode =
	| {
			kind: "Type"
			name: IdentifierNode
			// Null in the elided form `{ x }`, which takes the Type from the
			// value being taken apart.
			type: TypeDeclarationNode | null
			// What `as` names: another name or a nested Pattern. Null binds the
			// member under its own name.
			binder: PatternBinderNode | null
			position: Position
	  }
	| {
			kind: "Value"
			name: IdentifierNode
			value: LiteralMatcherValueNode
			position: Position
	  }

// A nested Pattern, as in `{ origin as { x, y } }`, needs no syntax of its
// own.
export type PatternBinderNode = IdentifierNode | PatternNode

// `case _`, which the enricher types as whatever the Handlers before it have
// not caught.
export interface WildcardMatcherNode {
	nodeType: "WildcardMatcher"
	position: Position
}

// `case 0` matches one value, so like a Guard it covers only part of its
// Type.
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
	| OverloadedFunctionStatementNode
	| ExpectStatementNode
	| RequireStatementNode

// `expect EXPR`, a Statement rather than a call, so a failure can report the
// value of every sub-expression. `matcher` is always null on an `expect`, and
// only `require` writes one. Both stand only in a test's body.
export interface ExpectStatementNode {
	nodeType: "ExpectStatement"
	value: ExpressionNode
	matcher: MatcherNode | null
	// `matches snapshot`. An assertion carries at most one of `matcher` and
	// `snapshot`.
	snapshot: SnapshotNode | null
	position: Position
}

// What `matches snapshot` compares against. `name` is set for a stored
// snapshot, `matches snapshot from "season-report"`, and null for an inline
// one. `value` is null until `essence test` records one.
export interface SnapshotNode {
	nodeType: "Snapshot"
	name: StringValueNode | null
	value: StringValueNode | null
	// Where the recorded value stands, or the keyword's span where none is
	// written yet. An update of the snapshot writes here.
	valuePosition: Position
	keywordPosition: Position
	position: Position
}

// `require EXPR` or `require MATCHER = EXPR`. A failing `require` ends the
// test, so a test may take an Optional or a Choice apart with it. The Matcher
// is the one `match` uses, written where a Declaration's name stands.
export interface RequireStatementNode {
	nodeType: "RequireStatement"
	value: ExpressionNode
	matcher: MatcherNode | null
	snapshot: SnapshotNode | null
	position: Position
}

// `name` is a Pattern where the Declaration takes the value apart, as in
// `constant { accepted, refused } = list::partition(where …)`. The Pattern may
// not constrain a member by value, since a Declaration can not decline.
export interface ConstantDeclarationStatementNode {
	nodeType: "ConstantDeclarationStatement"
	name: IdentifierNode | PatternNode
	type: TypeDeclarationNode | null
	value: ExpressionNode
	position: Position
	documentation: Documentation | null
}

export interface VariableDeclarationStatementNode {
	nodeType: "VariableDeclarationStatement"
	name: IdentifierNode | PatternNode
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

// `position` spans the whole `overload name { … }` block, so the editor can
// tell when a cursor stands in an empty group.
export interface OverloadedMethod {
	nodeType: "OverloadedMethod"
	name: IdentifierNode
	methods: Array<FunctionValueNode>
	position: Position
	documentation: Documentation | null
}

export interface OverloadedStaticMethod {
	nodeType: "OverloadedStaticMethod"
	name: IdentifierNode
	methods: Array<FunctionValueNode>
	position: Position
	documentation: Documentation | null
}

// A native Method's signature without a body, which only a
// `declarations { … }` Program may write.
export interface NativeMethodSignatureNode {
	nodeType: "NativeMethodSignature"
	generics: Array<GenericDeclarationNode>
	parameters: Array<ParameterNode>
	returnType: TypeDeclarationNode
	position: Position
	documentation: Documentation | null
}

export interface SimpleMethodSignature {
	nodeType: "SimpleMethodSignature"
	name: IdentifierNode
	signature: NativeMethodSignatureNode
}

export interface StaticMethodSignature {
	nodeType: "StaticMethodSignature"
	name: IdentifierNode
	signature: NativeMethodSignatureNode
}

// An `overload` block in a `declarations { … }` Program may mix entries with
// bodies and native signatures.
export interface OverloadedMethodSignatures {
	nodeType: "OverloadedMethodSignatures"
	name: IdentifierNode
	methods: Array<FunctionValueNode | NativeMethodSignatureNode>
	position: Position
	documentation: Documentation | null
}

export interface OverloadedStaticMethodSignatures {
	nodeType: "OverloadedStaticMethodSignatures"
	name: IdentifierNode
	methods: Array<FunctionValueNode | NativeMethodSignatureNode>
	position: Position
	documentation: Documentation | null
}

export type NamespaceMethods = Record<
	string,
	| SimpleMethod
	| StaticMethod
	| OverloadedMethod
	| OverloadedStaticMethod
	| SimpleMethodSignature
	| StaticMethodSignature
	| OverloadedMethodSignatures
	| OverloadedStaticMethodSignatures
>

// `value` is null only for a native static Property in a
// `declarations { … }` Program, such as `static Pi: Transcendental`.
export interface NamespacePropertyNode {
	name: IdentifierNode
	documentation: Documentation | null
	type: TypeDeclarationNode | null
	value: ExpressionNode | null
}

export interface NamespaceDefinitionStatementNode {
	nodeType: "NamespaceDefinitionStatement"
	name: IdentifierNode
	generics: Array<GenericDeclarationNode>
	targetType: TypeDeclarationNode | null
	conformsTo: Array<ConformanceClauseNode>
	properties: Record<string, NamespacePropertyNode>
	methods: NamespaceMethods
	position: Position
	documentation: Documentation | null
}

// One `is Protocol where …` clause of a Namespace conformance list.
// The `where` conditions are empty for an unconditional conformance.
export interface ConformanceClauseNode {
	nodeType: "ConformanceClause"
	protocol: IdentifierNode
	conditions: Array<WhereConditionNode>
	position: Position
}

// One `Generic is Protocol` condition of a `where` clause. `generic` names
// one of the Namespace's own Type Parameters.
export interface WhereConditionNode {
	nodeType: "WhereCondition"
	generic: IdentifierNode
	protocol: IdentifierNode
	position: Position
}

export interface ProtocolMethodSignatureNode {
	nodeType: "ProtocolMethodSignature"
	parameters: Array<ParameterNode>
	returnType: TypeDeclarationNode
	// The body of a provided Method, and null for a requirement. It shares
	// this signature's Parameter and return Type nodes, so the two can not
	// drift.
	body: FunctionValueNode | null
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
	position: Position
	documentation: Documentation | null
}

export interface OverloadedStaticProtocolMethod {
	nodeType: "OverloadedStaticProtocolMethod"
	name: IdentifierNode
	signatures: Array<ProtocolMethodSignatureNode>
	position: Position
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
	// The Protocols this one extends, in the `is A, is B` list a Namespace
	// conformance uses. The enricher refuses a `where` here, since a Protocol
	// has no Type Parameters.
	conformsTo: Array<ConformanceClauseNode>
	methods: ProtocolMethods
	position: Position
	documentation: Documentation | null
}

// A Case's payload is a Record shape, or null for a unit Case.
export interface ChoiceCaseNode {
	name: IdentifierNode
	type: RecordTypeDeclarationNode | null
	// The `= { … }` after a payload shape, which fills in the members a
	// construction leaves out. Any Expression parses here, and the enricher
	// decides what a default may say.
	defaultValue: ExpressionNode | null
}

export interface ChoiceDeclarationStatementNode {
	nodeType: "ChoiceDeclarationStatement"
	name: IdentifierNode
	generics: Array<GenericDeclarationNode>
	cases: Array<ChoiceCaseNode>
	position: Position
	documentation: Documentation | null
}

export interface TypeAliasStatementNode {
	nodeType: "TypeAliasStatement"
	name: IdentifierNode
	generics: Array<GenericDeclarationNode>
	type: TypeDeclarationNode
	// The `where` of a refinement, as in
	// `type NonZeroInteger = Integer where @::isNot(0)`, where `@` is the
	// value refined. Any Expression parses here, and the enricher decides.
	predicate: ExpressionNode | null
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

// `overload function name { … }`, which only a `declarations { … }` Program
// may write. An entry's index picks the `__overload$N` name it is emitted
// under.
export interface OverloadedFunctionStatementNode {
	nodeType: "OverloadedFunctionStatement"
	name: IdentifierNode
	methods: Array<FunctionValueNode | NativeMethodSignatureNode>
	position: Position
	documentation: Documentation | null
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
	// The Protocol bound of `<infer Item is Comparable>`.
	constraint: IdentifierNode | null
	position: Position
}

export interface IdentifierTypeDeclarationNode {
	nodeType: "IdentifierTypeDeclaration"
	type: IdentifierNode
	position: Position
}

export interface RecordTypeMemberNode {
	name: IdentifierNode
	type: TypeDeclarationNode
}

export interface RecordTypeDeclarationNode {
	nodeType: "RecordTypeDeclaration"
	members: Record<string, RecordTypeMemberNode>
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

// `returnType` is null only for a Function literal that omits its
// `-> Type`, which then comes from the expected signature or the body.
export interface FunctionDefinitionNode {
	nodeType: "FunctionDefinition"
	parameters: Array<ParameterNode>
	generics: Array<GenericDeclarationNode>
	returnType: TypeDeclarationNode | null
	body: Array<ImplementationNode>
	documentation: Documentation | null
	// The Parameter list's span. Its end is where an Inlay Hint shows an
	// inferred return Type.
	parameterListPosition: Position
	// The whole `<…>`, absent where none is written. An edit removing the
	// last entry removes this span.
	genericListPosition?: Position
	// Set where the body writes a `complete` of its own, outside any Function
	// literal in it. Such a completing body declares `-> Future<T>`, and its
	// `<-` answers with `T`. See "Start and complete" in DEVELOPMENT.md.
	completing?: true
}

// `internalName` is null for `_: Type`, which binds nothing, and a Pattern in
// `area(of { width, height }: Rectangle)`. `type` and `externalName` are null
// in `(item) { … }`, which takes both from the expected signature.
// `position` leaves out `defaultValue`, because an inlay hint inserts an
// inferred Type at `position.end`.
export interface ParameterNode {
	nodeType: "Parameter"
	externalName: IdentifierNode | null
	internalName: IdentifierNode | PatternNode | null
	type: TypeDeclarationNode | null
	defaultValue: ExpressionNode | null
	position: Position
	documentation: Documentation | null
}

export interface ArgumentNode {
	nodeType: "Argument"
	name: IdentifierNode | null
	value: ExpressionNode
}
// #endregion
