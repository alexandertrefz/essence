import type {
	BooleanType,
	CaseType,
	Conformance,
	DerivedEquatableDescriptor,
	DispatchCase,
	Documentation,
	ErrorType,
	ExposedMethod,
	RationalType,
	FunctionType,
	GenericAliasType,
	IntegerType,
	DictionaryType,
	ListType,
	NamespaceType,
	Position,
	ProtocolType,
	RecordType,
	RefinementType,
	StringType,
	Type,
	UnionType,
} from "./index"

// #region Program & Sections

export type Program = {
	nodeType: "Program"
	// Null out of the enricher, since the linker attaches both Module
	// sections. Only a dependency's export surface says what an entry binds.
	imports: ImportSectionNode | null
	implementation: ImplementationSectionNode
	// Null in a compile that does not ask for tests, so null does not mean the
	// file wrote none.
	tests: TestsSectionNode | null
	exports: ExportSectionNode | null
	position: Position
}

export type ImplementationSectionNode = {
	nodeType: "ImplementationSection"
	nodes: Array<ImplementationNode>
	position: Position
}

// The enriched `tests { … }` block. An ordinary Statement in it is setup, and
// tests and suites are what a runner registers.
export type TestsSectionNode = {
	nodeType: "TestsSection"
	nodes: Array<TestsNode>
	position: Position
}

export type TestsNode = TestNode | SuiteNode | ImplementationNode

// What a test is, apart from the name it renders when it runs, so snapshots
// and stored counterexamples can key on it. `name` is the written template,
// each hole reduced to `{name}` or `{}`. `suitePath` holds the same for every
// enclosing suite, outermost first. `testIdentityKey` appends a table row's
// index.
export type TestIdentity = {
	// Null where the Program is no Module.
	modulePath: string | null
	suitePath: Array<string>
	name: string
}

// `skipped "reason"`, on the item or on a suite covering it. `position` is
// the Modifier that set it.
export type TestSkip = {
	reason: string
	position: Position
}

// A test or benchmark with its Modifiers read. `focused`, `skipped` and
// `tags` include what every enclosing suite says.
export type TestNode = {
	nodeType: "Test"
	form: "test" | "benchmark"
	identity: TestIdentity
	// The name as an Expression, worked out where the test runs.
	name: StringValueNode | InterpolatedStringValueNode
	// Its own tags and every enclosing suite's, outermost first, without
	// repeats.
	tags: Array<string>
	skipped: TestSkip | null
	// Where `focused` was written, on this item or a suite covering it.
	focused: Position | null
	// The rows of a table test. Each row runs as a test of its own, and the
	// name is worked out with the row bound.
	table: TestTableNode | null
	properties: TestPropertiesNode | null
	// How many cases this property runs when the command line does not say.
	// Only a synthesized contract goal sets it.
	cases: number | null
	body: Array<ImplementationNode>
	keywordPosition: Position
	position: Position
}

// The rows of a table test, each typed against the Parameter's Type.
// `binding` is the name a row is bound to: the Parameter's own, or a compiler
// name where it wrote a Pattern.
export type TestTableNode = {
	nodeType: "TestTable"
	rows: Array<ExpressionNode>
	binding: string
	type: Type
	// The Constants a Pattern Parameter desugars into. They stand apart from
	// the body because the test's name reads them too.
	bindings: Array<ImplementationNode>
	position: Position
}

// The Parameters of a property test, each with the generator its Type
// calls for.
export type TestPropertiesNode = {
	nodeType: "TestProperties"
	parameters: Array<TestPropertyNode>
	position: Position
}

// One generated Parameter. `name` is what the body binds and what a
// counterexample is reported under.
export type TestPropertyNode = {
	nodeType: "TestProperty"
	name: string
	type: Type
	generator: TestGenerator
	position: Position
}

// How to build a value of one Type and shrink a failing one, as data, so one
// interpreter in the test runtime owns both. See "Test generators" in
// DEVELOPMENT.md.
export type TestGenerator =
	| { kind: "boolean" }
	| { kind: "integer" }
	| { kind: "rational" }
	| { kind: "string" }
	| { kind: "list"; item: TestGenerator }
	// Keys and values drawn independently. Duplicate keys collapse as in
	// `Dictionary.of`, under `keyConformance`, the key Type's own Equatable
	// witness. It is absent only for a bare `Dictionary`.
	| {
			kind: "dictionary"
			key: TestGenerator
			value: TestGenerator
			keyConformance?: Conformance
	  }
	| { kind: "record"; members: Array<TestGeneratorMember> }
	// `tag` is the `Choice#Case` spelling a Case value carries at run time.
	| { kind: "case"; tag: string; members: Array<TestGeneratorMember> }
	| { kind: "union"; members: Array<TestGenerator> }
	// A refinement. `checks` are its conjuncts as Boolean Expressions of
	// `binding`, and they always decide. `narrowing` only lets the generator
	// build common values rather than draw and discard them.
	| {
			kind: "refined"
			name: string
			base: TestGenerator
			binding: string
			checks: Array<ExpressionNode>
			narrowing: TestNarrowing
	  }
	// A Namespace's own `Generatable` conformance, as the calls
	// `Team.generate(from <binding>)` and `<shrinkBinding>::<Team>shrink()`. The
	// call names the Namespace, since another may write its own `shrink`.
	| {
			kind: "generated"
			name: string
			binding: string
			call: ExpressionNode
			shrinkBinding: string
			shrink: ExpressionNode
	  }

export type TestGeneratorMember = { name: string; generator: TestGenerator }

// What a recognised predicate says about the values worth drawing. An
// Integer bound is spelled in digits, since a JSON number can not hold every
// bigint.
export type TestNarrowing = {
	atLeast?: string
	atMost?: string
	notEqualTo?: Array<string>
	// Lists and Strings, counted in items and in characters.
	minimumLength?: number
	maximumLength?: number
}

// `suite "name" MODIFIER* { … }`, with its Modifiers read as a test's are.
export type SuiteNode = {
	nodeType: "Suite"
	identity: TestIdentity
	name: StringValueNode | InterpolatedStringValueNode
	tags: Array<string>
	skipped: TestSkip | null
	focused: Position | null
	nodes: Array<TestsNode>
	keywordPosition: Position
	position: Position
}

export type ImportSectionNode = {
	nodeType: "ImportSection"
	entries: Array<ImportNode>
	position: Position
}

// `runtime` says whether the emitted JavaScript binds this name. A Type
// Alias, a Protocol, a Choice and a Case do not. `source` is the specifier as
// written, and `modulePath` the canonical path it resolved to, if any.
export type ImportNode = {
	nodeType: "Import"
	name: string
	alias: string | null
	source: string
	modulePath: string | null
	runtime: boolean
	// Whether `modulePath` is in this Module's import cycle, whose Module
	// bodies run in an order the source does not state.
	cyclic: boolean
	// What the entry bound, the member or else the Type, for a Hover.
	type: Type | null
	// Whether the name is a Constant or a Variable, whose value its own Module
	// wrote and validated.
	writtenValue: boolean
	position: Position
}

export type ExportSectionNode = {
	nodeType: "ExportSection"
	entries: Array<ExportNode>
	position: Position
}

// A `source` makes the entry forward the name another Module publishes,
// which `modulePath` names. Both are null for a declaration of this Module.
export type ExportNode = {
	nodeType: "Export"
	name: string
	alias: string | null
	source: string | null
	modulePath: string | null
	runtime: boolean
	// What the entry publishes, for a Hover. Null on a re-export.
	type: Type | null
	// The provided Methods a Namespace declared here offers a host, set only
	// in an `embed` compile.
	exposed?: Array<ExposedMethod>
	position: Position
}

export type ImplementationNode = ExpressionNode | StatementNode

// #endregion

// #region Expressions

export type ExpressionNode =
	| MethodInvocationNode
	| FunctionInvocationNode
	| ValueNode
	| LookupNode
	| IdentifierNode
	| SelfNode
	| CombinationNode
	| MatchNode
	| DefineNode
	| CaseValueNode
	| StartNode
	| CompleteNode
	| RefusedValueNode

// A value the Parser refused, such as `primes[0]`, or a Namespace the enricher
// refused as a value. It is typed as an Error, so no reader of it reports
// again. See "Refused values" in DEVELOPMENT.md.
export interface RefusedValueNode {
	nodeType: "RefusedValue"
	base: ExpressionNode
	position: Position
	type: ErrorType
}

// `start expr`, typed as the `Started<Value>` of the operand's
// `Future<Value>`. It suspends nothing, so it may stand anywhere.
export interface StartNode {
	nodeType: "Start"
	expression: ExpressionNode
	position: Position
	type: Type
}

// `complete expr`, typed as the `Value` its operand answers with. It suspends
// the body it stands in, which makes that a completing body.
export interface CompleteNode {
	nodeType: "Complete"
	expression: ExpressionNode
	position: Position
	type: Type
}

// `choice` carries the Choice's Union Type and `caseName` the CaseType, so a
// cursor may land on either half. `choice` is null for the bare form. An
// unknown Choice or Case types the node as an Error.
export interface CaseValueNode {
	nodeType: "CaseValue"
	choice: IdentifierNode | null
	caseName: IdentifierNode
	value: ExpressionNode | null
	position: Position
	type: CaseType | ErrorType
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
	conformances: Array<Conformance>
	// The Parameters this call wrote no Argument for, indexed over the
	// callee's full signature, receiver included.
	omittedParameterIndices: Array<number>
	// Set only where the call resolves to a generic Choice's derived
	// Equatable.
	derivedDescriptor?: DerivedEquatableDescriptor
	// Set only where the receiver is a Record with a declared member that
	// does not compare or print structurally. It lists the routed members in
	// declaration order, matching the hidden trailing conformance Arguments.
	derivedMembers?: Array<string>
	// Set where a Union-typed receiver resolves per member Type. `namespace`
	// and `overloadedMethodIndex` then hold placeholders.
	dispatch: Array<DispatchCase> | null
}

export interface FunctionInvocationNode {
	nodeType: "FunctionInvocation"
	name: ExpressionNode
	arguments: Array<ArgumentNode>
	position: Position
	type: Type
	overloadedMethodIndex: number | null
	conformances: Array<Conformance>
	// The Parameters this call left out, indexed over the full signature.
	omittedParameterIndices: Array<number>
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

export type RecordValueNode = {
	nodeType: "RecordValue"
	declaredType: RecordType | null
	type: RecordType
	members: Record<string, ExpressionNode>
	position: Position
	// Where each member's name was written, set only on a level a dotted key
	// desugars into. `{ c with server.port = 1 }` becomes
	// `{ c with server = { c.server with port = 1 } }`.
	memberPositions?: Record<string, Position>
	// Set on a level a path key builds inside a literal merged into a default.
	// What it does not write, the default fills in. A member written whole
	// replaces instead.
	merged?: true
}

// A written value is typed as a refinement of its kind only as a Method
// receiver, so `4::squareRoot()` reaches `NonNegativeInteger`. Elsewhere it
// keeps its kind. Integer, Rational, List and Dictionary values work alike.
export type StringValueNode = {
	nodeType: "StringValue"
	value: string
	position: Position
	type: StringType | RefinementType
}

// Each hole keeps its Expression and the `Printable` Conformance that turns
// its value into text.
export type InterpolationSegmentNode =
	| { kind: "text"; value: string }
	| {
			kind: "expression"
			expression: ExpressionNode
			conformance: Conformance
	  }

export type InterpolatedStringValueNode = {
	nodeType: "InterpolatedStringValue"
	segments: Array<InterpolationSegmentNode>
	position: Position
	type: StringType
}

export type IntegerValueNode = {
	nodeType: "IntegerValue"
	value: string
	position: Position
	type: IntegerType | RefinementType
}

export type RationalValueNode = {
	nodeType: "RationalValue"
	numerator: string
	denominator: string
	position: Position
	type: RationalType | RefinementType
}

// Never refined, since no `where` clause may be written on a Boolean.
export type BooleanValueNode = {
	nodeType: "BooleanValue"
	value: boolean
	position: Position
	type: BooleanType
}

// `synthesized` marks a Function literal desugared from a member path such
// as `.price`, so the language server does not show its invented names.
export type FunctionValueNode = {
	nodeType: "FunctionValue"
	value: FunctionDefinitionNode
	position: Position
	type: FunctionType
	synthesized?: "path"
}

export type ListValueNode = {
	nodeType: "ListValue"
	values: Array<ExpressionNode>
	position: Position
	type: ListType | RefinementType
}

export type DictionaryEntryNode = {
	key: ExpressionNode
	value: ExpressionNode
	position: Position
}

export type DictionaryValueNode = {
	nodeType: "DictionaryValue"
	entries: Array<DictionaryEntryNode>
	position: Position
	type: DictionaryType | RefinementType
	// The Equatable witness the keys are compared through. Null for the empty
	// Dictionary and for an unsatisfied bound. An update's key list has none,
	// since the base's witness stands on the `Combination`.
	keyConformance: Conformance | null
}

export interface LookupNode {
	nodeType: "Lookup"
	base: ExpressionNode
	member: IdentifierNode
	position: Position
	type: Type
	// The Protocol that provided this member, so the rewriter reads the const
	// every conformer shares.
	providedBy?: string
	// The Case tags, in declaration order, of a derived `Enumerable::cases`,
	// which no Method answers.
	derivedCases?: Array<string>
	// The hidden conformance Parameter the member is read off, where the base
	// is a bounded Type Parameter: `T.cases()` becomes `T__conformance.cases()`.
	conformanceName?: string
	// The Namespace the member is read off, where it differs from the name
	// the base wrote, as in `Colour.cases()` with `namespace Colours for Colour`.
	namespaceName?: string
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

// An invalid Combination is typed as an Error.
export interface CombinationNode {
	nodeType: "Combination"
	lhs: ExpressionNode
	rhs: ExpressionNode
	position: Position
	type: Type
	// On a Dictionary update only, the Equatable witness of the base's key
	// Type.
	keyConformance?: Conformance
}

// `matcher` is the Type a Handler binds `@` to. `literal`, `memberLiterals`,
// `memberTypes` and `guard` let a Handler decline a value of that Type, so it
// can not make a Union exhaustive alone. `typedHandlerExpressions` walks them.
export interface MatchNode {
	nodeType: "Match"
	value: ExpressionNode
	handlers: Array<{
		matcher: Type
		// Where the Matcher, such as `case Integer`, was written.
		matcherPosition: Position
		literal: ExpressionNode | null
		memberLiterals: Record<string, ExpressionNode> | null
		// What a Case Matcher's payload Pattern requires of a member, keyed
		// by its dotted path from the matched value. It stays out of `matcher`,
		// which says only which Case the arm is. A narrowed `matcher` would tell
		// the validator the Case is only partly covered.
		memberTypes: Record<string, Type> | null
		guard: ExpressionNode | null
		body: Array<ImplementationNode>
	}>
	position: Position
	type: Type
}

// `define { as … if … as … otherwise }`, typed. `type` is the declared answer
// Type where one was written, else the Union of what the arms answer.
export interface DefineNode {
	nodeType: "Define"
	arms: Array<DefineArm>
	otherwise: DefineOtherwiseArm
	position: Position
	type: Type
	// Set where its arrow wrote the Type, which the arms are then held to as a
	// declared one.
	declared?: true
}

export type DefineArm = {
	value: ExpressionNode
	condition: ExpressionNode
	// Whether the Condition narrows something for this arm's value. See
	// "Narrowing records" in DEVELOPMENT.md.
	narrows: boolean
	// Whether its failing narrows something for the later arms.
	narrowsBelow: boolean
	position: Position
}

export type DefineOtherwiseArm = {
	value: ExpressionNode
	position: Position
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
	| ChoiceDeclarationStatementNode
	| IfElseStatementNode
	| IfStatementNode
	| ReturnStatementNode
	| FunctionStatementNode
	| ExpectStatementNode
	| RequireStatementNode

// The test half of a `match` Handler, without a Guard or a body, for
// `require MATCHER = EXPR`.
export interface AssertionMatcherNode {
	matcher: Type
	// Where the Matcher, such as `#Value(row)`, was written.
	matcherPosition: Position
	literal: ExpressionNode | null
	memberLiterals: Record<string, ExpressionNode> | null
	memberTypes: Record<string, Type> | null
}

// `expect EXPR`. A failure is recorded and the test carries on. `matcher` is
// always null here.
export interface ExpectStatementNode {
	nodeType: "ExpectStatement"
	value: ExpressionNode
	matcher: AssertionMatcherNode | null
	snapshot: SnapshotNode | null
	position: Position
}

// What `matches snapshot` records: the asserted value rendered through
// `Printable`. `name` is set for a stored snapshot. `recorded` is an inline
// snapshot's text, null until the first run writes one.
export interface SnapshotNode {
	nodeType: "Snapshot"
	name: string | null
	recorded: string | null
	// Where an update writes: the recorded value, or the keyword where none
	// stands.
	valuePosition: Position
	position: Position
}

// A failing `require` ends the test, so the Constants its Matcher binds
// follow it. Where a Matcher was written, `value` names a synthesized Constant
// in front of it, so the value is computed once.
export interface RequireStatementNode {
	nodeType: "RequireStatement"
	value: ExpressionNode
	matcher: AssertionMatcherNode | null
	snapshot: SnapshotNode | null
	position: Position
}

// `synthesized` marks a Constant no source wrote: a Pattern's `base`, a
// `binding` it desugars into, or the `subject` of `require MATCHER = EXPR`,
// whose value a failure reports. Its Position is borrowed from what the author
// wrote, so the debugger can still step over it.
export interface ConstantDeclarationStatementNode {
	nodeType: "ConstantDeclarationStatement"
	name: IdentifierNode
	value: ExpressionNode
	position: Position
	headPosition: Position
	declaredType: Type | null
	type: Type
	documentation: Documentation | null
	synthesized?: "base" | "binding" | "subject"
}

// `synthesized` is as on a Constant, but only a `binding`: a Pattern's base
// is a Constant even under `variable`.
export interface VariableDeclarationStatementNode {
	nodeType: "VariableDeclarationStatement"
	name: IdentifierNode
	value: ExpressionNode
	position: Position
	headPosition: Position
	declaredType: Type | null
	type: Type
	documentation: Documentation | null
	synthesized?: "binding"
}

export interface VariableAssignmentStatementNode {
	nodeType: "VariableAssignmentStatement"
	name: IdentifierNode
	value: ExpressionNode
	// Where the Variable was declared, for the validator, which has no Scope.
	// Null for a builtin or an undeclared name.
	declarationPosition: Position | null
	// Set where the name can be no Variable at all, as a Function or a
	// Namespace, which the enricher reported. The validator then judges no
	// value against it. A written Constant's value is still judged.
	refused?: true
	position: Position
}

export interface NamespaceProperty {
	name: IdentifierNode
	type: Type
	value: ExpressionNode
	documentation: Documentation | null
}

// `name` keeps the Position the `Methods` key lacks.
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

// `overloadIndices` gives each entry of `methods` its index in the Method
// Type's `overloads`, which also holds native Overloads that have no body.
// INVARIANT: the `__overload$N` suffix comes from that index, which call
// sites resolve against, never from a position in `methods`.
export interface OverloadedMethod {
	nodeType: "OverloadedMethod"
	name: IdentifierNode
	methods: Array<FunctionValueNode>
	overloadIndices: Array<number>
}

export interface OverloadedStaticMethod {
	nodeType: "OverloadedStaticMethod"
	name: IdentifierNode
	methods: Array<FunctionValueNode>
	overloadIndices: Array<number>
}

export type Methods = Record<
	string,
	SimpleMethod | StaticMethod | OverloadedMethod | OverloadedStaticMethod
>

export interface NamespaceDefinitionStatementNode {
	nodeType: "NamespaceDefinitionStatement"
	name: IdentifierNode
	targetType: Type | null
	// The Type Parameters with Positions, which `type.generics` lacks.
	generics: Array<GenericDeclarationNode>
	conformsTo: Array<{
		name: string
		position: Position
		conditions: Array<{
			generic: string
			genericPosition: Position
			protocol: string
			protocolPosition: Position
		}>
	}>
	properties: Record<string, NamespaceProperty>
	methods: Methods
	// The native Methods of this Namespace that declare a default.
	nativeShims: Array<NativeShimNode>
	position: Position
	headPosition: Position
	type: NamespaceType
	documentation: Documentation | null
}

// The frame a native Method's default is evaluated in, which a call that
// leaves the Argument out goes through. See "A native that declares a default"
// in packages/standard-library/DEVELOPMENT.md.
export interface NativeShimNode {
	nodeType: "NativeShim"
	memberName: string
	// The entry's index in an `overload` block, or null.
	overloadIndex: number | null
	isStatic: boolean
	parameters: Array<ParameterNode>
	// The bounded Type Parameters, in declaration order, whose witnesses the
	// shim takes after the written Arguments and hands on.
	conformances: Array<string>
}

export interface ProtocolDeclarationStatementNode {
	nodeType: "ProtocolDeclarationStatement"
	name: IdentifierNode
	protocolType: ProtocolType
	// The Protocols this one extends, as written, with Positions.
	conformsTo: Array<{ name: string; position: Position }>
	// The provided Methods' bodies. `@` is `Self` bounded by this Protocol, so
	// a body calls only what the Protocol holds, through its witness.
	methods: Methods
	position: Position
	headPosition: Position
	documentation: Documentation | null
}

export interface TypeAliasStatementNode {
	nodeType: "TypeAliasStatement"
	name: IdentifierNode
	generics: Array<GenericDeclarationNode>
	type: Type
	// A refinement's predicate, typed with `@` as the base, for the language
	// server. The Type keeps only its conjuncts. Null for an ordinary Alias and
	// for a refused clause.
	predicate: ExpressionNode | null
	position: Position
	documentation: Documentation | null
}

// `type` is what the Choice's name means in Type position. It is the named
// Union of its Cases, or for a generic Choice a Generic Alias over that Union.
export interface ChoiceDeclarationStatementNode {
	nodeType: "ChoiceDeclarationStatement"
	name: IdentifierNode
	generics: Array<GenericDeclarationNode>
	// `defaultValue` is the enriched `= { … }` of a Case's payload shape.
	cases: Array<{
		name: IdentifierNode
		type: CaseType
		defaultValue: ExpressionNode | null
	}>
	type: UnionType | GenericAliasType
	position: Position
	headPosition: Position
	documentation: Documentation | null
}

// `narrows` and `narrowsFalse` say whether the condition narrows a binding
// where it holds and where it fails. See "Narrowing records" in
// DEVELOPMENT.md.
export interface IfElseStatementNode {
	nodeType: "IfElseStatement"
	condition: ExpressionNode
	narrows: boolean
	narrowsFalse: boolean
	trueBody: Array<ImplementationNode>
	falseBody: Array<ImplementationNode>
	position: Position
}

export interface IfStatementNode {
	nodeType: "IfStatement"
	condition: ExpressionNode
	narrows: boolean
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
	headPosition: Position
	type: Type
}

// #endregion

// #region Helpers

// A null `internalName` is the `_: Type` form, which the simplifier gives a
// placeholder name.
export interface ParameterNode {
	nodeType: "Parameter"
	externalName: IdentifierNode | null
	internalName: IdentifierNode | null
	position: Position
	// The Parameter's Type, which `_: Options` has without a name. The
	// simplifier rebuilds a Record-defaulted Parameter from it.
	type: Type
	// Set only where no `: Type` was written and the expected signature gave
	// one, for an Inlay Hint.
	inferredType: Type | null
	// The enriched default, which the simplifier lowers into a JavaScript
	// default parameter.
	defaultValue: ExpressionNode | null
}

export interface GenericDeclarationNode {
	nodeType: "GenericDeclaration"
	name: string
	defaultType: Type | null
	inferred: boolean
	// The bound as written, or its identity on a Namespace Generic that
	// carries a woven bound and on a provided Method's `Self`.
	constraint: string | null
	// How the file names a woven bound's Protocol, for a Help that
	// writes the bound.
	spelling?: string
	position: Position
}

export interface FunctionDefinitionNode {
	nodeType: "FunctionDefinition"
	generics: Array<GenericDeclarationNode>
	parameters: Array<ParameterNode>
	body: Array<ImplementationNode>
	returnType: Type
	// Set only where no `-> Type` was written, as a Parameter's
	// `inferredType` is.
	inferredReturnType: Type | null
	// The return Type an expected signature declared for an omitted one, its
	// Type Parameters left open. A `<-` names only the members it declares.
	returnShape?: Type
	// Where an omitted `-> Type` would have gone, for the Inlay Hint.
	parameterListPosition: Position
	// The signature from its `<` or `(` to the end of the return annotation,
	// which Hover anchors to.
	headPosition: Position
	// Set where the body writes a `complete` of its own. The enricher reports
	// `complete-outside-future` unless the declared return Type is a `Future`.
	// The rewriter emits a Function returning `$future.of(async ($ctx) => …)`.
	completing?: true
}

export interface ArgumentNode {
	nodeType: "Argument"
	name: string | null
	value: ExpressionNode
	type: Type
}
// #endregion
