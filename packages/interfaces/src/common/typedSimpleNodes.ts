import type {
	BooleanType,
	CaseType,
	DerivedEquatableDescriptor,
	ErrorType,
	RationalType,
	FunctionType,
	IntegerType,
	DictionaryType,
	ListType,
	NamespaceType,
	Position,
	RecordType,
	SharedCondition,
	StringType,
	Type,
} from "./index"

// #region Program & Sections

export type Program = {
	nodeType: "Program"
	imports: ImportSectionNode | null
	implementation: ImplementationSectionNode
	// Null in a compile that does not ask for tests.
	tests: TestsSectionNode | null
	// Null in a compile that does not ask for coverage. Only
	// `instrument-coverage` fills it.
	coverage: CoverageSectionNode | null
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

// An import entry reduced to what emission needs. A Module is keyed by its
// canonical path from here on.
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

// `modulePath` is set exactly on a re-export, whose name emission reads off
// that Module.
export type ExportNode = {
	nodeType: "Export"
	name: string
	alias: string | null
	modulePath: string | null
	runtime: boolean
}

export type ImplementationNode = ExpressionNode | StatementNode

// #endregion

// #region Tests

// The `tests { … }` block, lowered into a tree of Scopes and the flat
// manifest a runner reads. See "Lowered tests" in DEVELOPMENT.md.
export type TestsSectionNode = {
	nodeType: "TestsSection"
	// The canonical path of the Module, or null where the Program is no
	// Module.
	module: string | null
	// The instrumented points of this Module, indexed by point id. Every
	// `TestTraceNode` and every assertion names one.
	spans: Array<TestSpan>
	tests: Array<TestManifestEntry>
	nodes: Array<TestsNode>
}

// Where an instrumented point stands, and its source text, sliced once here
// since a reader of an event may not have the file.
export type TestSpan = {
	position: Position
	source: string
}

// What a runner knows about a test without running it, with every suite's
// Modifiers already applied.
export type TestManifestEntry = {
	id: string
	// The name template, such as `{scored}–{conceded} is a win`. The context
	// hands the runner the rendered name.
	name: string
	// Whether the template has a hole, recorded since a plain name may hold a
	// brace of its own.
	interpolated: boolean
	// The row of a table test, the last step of its identity, or null.
	row: number | null
	suitePath: Array<string>
	tags: Array<string>
	focused: boolean
	skipped: string | null
	// A benchmark runs only under `--bench` or when named by id.
	benchmark: boolean
	// The property's case count when the command line gives none, or null for
	// the run's own.
	cases: number | null
	// The identity without the Module path, from `relativeIdentityKey`. Files
	// stored beside the source, such as a benchmark's baseline, key on it, so
	// moving the file keeps them. A runner reads it and never derives it.
	key: string
	position: Position
	keywordPosition: Position
}

export type TestsNode =
	| ImplementationNode
	| TestEntryNode
	| TestScopeNode
	| TestRowsNode
	| TestPropertiesNode

// One test, standing inside the setup it can see. `index` is its place in
// the section's `tests`, by which the context selects it.
export interface TestEntryNode {
	nodeType: "TestEntry"
	index: number
	// The name as an Expression, only where it interpolates.
	name: ExpressionNode | null
	// A benchmark's body is timed rather than judged.
	benchmark: boolean
	body: Array<ImplementationNode>
	position?: Position
}

// A table test: one manifest entry per row, sharing one body and one name,
// which read the row under `binding`. The rows are a JavaScript Array. Row N
// is manifest entry `first + N`.
export interface TestRowsNode {
	nodeType: "TestRows"
	first: number
	binding: string
	rows: Array<ExpressionNode>
	// What a Pattern Parameter binds off the row, at the head of both the
	// name and the body.
	bindings: Array<ImplementationNode>
	// The name as an Expression, only where it interpolates. It may read the
	// row.
	name: ExpressionNode | null
	benchmark: boolean
	body: Array<ImplementationNode>
	position?: Position
}

// A property test: one manifest entry whose body runs once per generated
// case, as a closure the runtime calls with the values it drew.
export interface TestPropertiesNode {
	nodeType: "TestProperties"
	index: number
	// The name as an Expression, only where it interpolates. It is worked out
	// where the test was written, not in the body.
	name: ExpressionNode | null
	parameters: Array<TestPropertyParameter>
	body: Array<ImplementationNode>
	position?: Position
}

// One generated Parameter: the name the body binds and a report names,
// and how to draw a value for it.
export type TestPropertyParameter = { name: string; generator: TestGenerator }

// The enricher's generator with its Expressions lowered. See
// "Test generators" in DEVELOPMENT.md.
export type TestGenerator =
	| { kind: "boolean" }
	| { kind: "integer" }
	| { kind: "rational" }
	| { kind: "string" }
	| { kind: "list"; item: TestGenerator }
	// The key Type's Equatable witness, lowered to an Expression.
	| {
			kind: "dictionary"
			key: TestGenerator
			value: TestGenerator
			keyConformance?: ExpressionNode
	  }
	| { kind: "record"; members: Array<TestGeneratorMember> }
	| { kind: "case"; tag: string; members: Array<TestGeneratorMember> }
	| { kind: "union"; members: Array<TestGenerator> }
	| {
			kind: "refined"
			name: string
			base: TestGenerator
			binding: string
			checks: Array<ExpressionNode>
			narrowing: TestNarrowing
	  }
	| {
			kind: "generated"
			name: string
			binding: string
			call: ExpressionNode
			shrinkBinding: string
			shrink: ExpressionNode
	  }

export type TestGeneratorMember = { name: string; generator: TestGenerator }

export type TestNarrowing = {
	atLeast?: string
	atMost?: string
	notEqualTo?: Array<string>
	minimumLength?: number
	maximumLength?: number
}

// What a `suite` leaves behind: a Scope, emitted as a closure. `first` and
// `last` bound the half-open run of `tests` indices it holds. See
// "Lowered tests" in DEVELOPMENT.md.
export interface TestScopeNode {
	nodeType: "TestScope"
	first: number
	last: number
	nodes: Array<TestsNode>
	position?: Position
}

// #endregion

// #region Coverage

// The table of what each coverage counter in the Module means, which the
// emitted JavaScript can not say. It is emitted beside the Module.
export type CoverageSectionNode = {
	nodeType: "CoverageSection"
	points: Array<CoveragePoint>
	// Every Choice this Module declares, with its Cases, to report the Cases
	// no Module ever constructed.
	choices: Array<CoverageChoice>
}

export type CoveragePointKind = "statement" | "branch" | "case" | "construction"

// One counter. `label` names it in a report, such as `case #Postponed`, and
// `scope` names the Method or Function it stands in.
export type CoveragePoint = {
	kind: CoveragePointKind
	label: string
	scope: string
	position: Position
	// Set on a branch whose condition narrows, such as `if played::isNot(0)`
	// before a division, so a report covers both sides.
	refinement: boolean
	// The `Choice#Case` a construction point builds, else null.
	tag: string | null
}

export type CoverageChoice = {
	name: string
	// Spelled `Choice#Case`, as a construction's tag is.
	cases: Array<string>
	position: Position
}

// #endregion

// #region Expressions

// Every Expression and Statement carries the `position` of the typed node it
// came from, for source maps. A node the simplifier synthesizes, such as a
// conformance witness, has none.
export type ExpressionNode =
	| FunctionInvocationNode
	| MethodInvocationNode
	| UnionMethodInvocationNode
	| ValueNode
	| LookupNode
	| IdentifierNode
	| CombinationNode
	| MatchNode
	| DefineNode
	| ConformanceValueNode
	| CaseValueNode
	| TestTraceNode
	| CoverageCounterNode
	| IntrinsicNode
	| StartNode
	| CompleteNode

// `start expr` and `complete expr` stay nodes until the rewriter, which
// knows the context a run belongs to: the enclosing completing body's, or a
// fresh root.
export interface StartNode {
	nodeType: "Start"
	expression: ExpressionNode
	type: Type
	position?: Position
}

export interface CompleteNode {
	nodeType: "Complete"
	expression: ExpressionNode
	type: Type
	position?: Position
}

// An instrumented point: it records its value on the per-test context and
// answers with it unchanged. Assertions and `§?` value comments use it.
export interface TestTraceNode {
	nodeType: "TestTrace"
	// A `trace` belongs to the assertion that drains it. A `probe` belongs to
	// its line and is kept for the whole test.
	kind: "trace" | "probe"
	// An index into `TestsSectionNode.spans`.
	point: number
	value: ExpressionNode
	type: Type
	position?: Position
}

// Counts that control arrived here, against the Module, whether or not a test
// runs. `value` is null in Statement position. Elsewhere the counter answers
// with `value` unchanged.
export interface CoverageCounterNode {
	nodeType: "CoverageCounter"
	// An index into `CoverageSectionNode.points`.
	point: number
	value: ExpressionNode | null
	// Whether the counter runs before `value`. A `define` arm counts the path
	// taken, so it leads. A Case construction counts a value built, so it
	// follows.
	leads: boolean
	type: Type
	position?: Position
}

// A Case construction: its `Choice#Case` tag, and its payload or null.
export interface CaseValueNode {
	nodeType: "CaseValue"
	tag: string
	value: ExpressionNode | null
	type: CaseType | ErrorType
	position?: Position
}

// The witness passed for a Protocol-bounded Type Parameter, emitted as an
// object mapping each Protocol Method onto the conformer's. The fields mirror
// `ConformanceSource`.
export interface ConformanceValueNode {
	nodeType: "ConformanceValue"
	namespaceName: string
	methodMap: Record<string, string>
	providedMethods?: Record<string, string>
	curriedWith?: Record<string, number>
	// Witnesses built with this one, which carry no `providedWitnesses` or
	// `conditions` of their own.
	providedWitnesses?: Array<ConformanceValueNode>
	groupConditions?: Array<ExpressionNode>
	sharedConditions?: Array<SharedCondition>
	// Only on a witness of `providedWitnesses`: its conditions, by index into
	// the group's `conditions`, `groupConditions` and `sharedConditions`.
	conditionIndices?: Array<number>
	// The witnesses for the Namespace's own `where` conditions, in Generic
	// declaration order. Without any, the witness is a plain method-map object.
	conditions: Array<ExpressionNode>
	// Emitted as `$helpers.boundChoiceIs(<descriptor>)` for each mapped
	// Method.
	derivedDescriptor?: DerivedEquatableDescriptor
	derivedMembers?: Array<string>
	// Set only for a Choice's derived `Enumerable`, and emitted as
	// `$helpers.choiceCases(<tags>)`.
	derivedCases?: Array<string>
	type: Type
	position?: Position
}

export interface FunctionInvocationNode {
	nodeType: "FunctionInvocation"
	name: ExpressionNode
	arguments: Array<ArgumentNode>
	// Set where the call left an Argument out, so a native callee is reached
	// through its shim.
	omitsArguments?: true
	type: Type
	position?: Position
}

export interface MethodInvocationNode {
	nodeType: "MethodInvocation"
	base: IdentifierNode
	member: {
		name: string
	}
	arguments: Array<ArgumentNode>
	// Set where the call left an Argument out, so a native callee is reached
	// through its shim rather than read off the runtime module.
	omitsArguments?: true
	// Emitted as `$helpers.boundChoiceIs(<descriptor>)`.
	derivedDescriptor?: DerivedEquatableDescriptor
	// The routed members of a Record receiver, as on the typed node.
	derivedMembers?: Array<string>
	// The Protocol that provided this Method, since `base` declares none of
	// that name. The emission reads the const every conformer shares.
	providedBy?: string
	type: Type
	position?: Position
}

// A Method call on a Union-typed receiver, with one target per member Type
// that the receiver's Type picks at run time.
export interface UnionMethodInvocationNode {
	nodeType: "UnionMethodInvocation"
	base: ExpressionNode
	cases: Array<UnionMethodDispatchCase>
	arguments: Array<ArgumentNode>
	type: Type
	position?: Position
}

export type UnionMethodDispatchCase = {
	memberType: Type
	namespaceName: string
	methodName: string
	conformanceArguments: Array<ArgumentNode>
	// A Function literal Argument typed against this branch's Method, by its
	// index in the shared Argument list.
	contextualArguments: Array<{ index: number; argument: ArgumentNode }>
	// This branch's omitted Parameters, indexed with the receiver at 0. The
	// shared Argument list is what the call wrote, and each branch opens its
	// own holes.
	omittedParameterIndices: Array<number>
	derivedDescriptor?: DerivedEquatableDescriptor
	derivedMembers?: Array<string>
	// As on `MethodInvocationNode`.
	providedBy?: string
}

// A native's shim, whose body hands every Parameter on to the native. The
// `prologue` merges a Record default into its Argument, and is empty for any
// other default.
export type NativeShimNode = {
	memberName: string
	isStatic: boolean
	parameters: Array<ParameterNode>
	prologue: Array<ImplementationNode>
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
	type: RecordType
	members: Record<string, ExpressionNode>
	position?: Position
}

export type StringValueNode = {
	nodeType: "StringValue"
	value: string
	type: StringType
	position?: Position
}

// Each hole's Expression with the `Printable` witness that renders it, as
// `witness.toString(expression).value`.
export type InterpolationSegmentNode =
	| { kind: "text"; value: string }
	| {
			kind: "expression"
			expression: ExpressionNode
			witness: ExpressionNode
	  }

export type InterpolatedStringValueNode = {
	nodeType: "InterpolatedStringValue"
	segments: Array<InterpolationSegmentNode>
	type: StringType
	position?: Position
}

export type IntegerValueNode = {
	nodeType: "IntegerValue"
	value: string
	type: IntegerType
	position?: Position
}

export type RationalValueNode = {
	nodeType: "RationalValue"
	numerator: string
	denominator: string
	type: RationalType
	position?: Position
}

export type BooleanValueNode = {
	nodeType: "BooleanValue"
	value: boolean
	type: BooleanType
	position?: Position
}

export type FunctionValueNode = {
	nodeType: "FunctionValue"
	value: FunctionDefinitionNode
	type: FunctionType
	position?: Position
}

export type ListValueNode = {
	nodeType: "ListValue"
	values: Array<ExpressionNode>
	type: ListType
	position?: Position
}

export type DictionaryEntryNode = {
	key: ExpressionNode
	value: ExpressionNode
}

// The pairs in written order. The whole literal maps to one source span.
export type DictionaryValueNode = {
	nodeType: "DictionaryValue"
	entries: Array<DictionaryEntryNode>
	// The key witness as an Expression: a `ConformanceValue`, or the hidden
	// Parameter a bound arrived in. Null for the empty Dictionary.
	keyConformance: ExpressionNode | null
	type: DictionaryType
	position?: Position
}

export interface LookupNode {
	nodeType: "Lookup"
	base: ExpressionNode
	member: IdentifierNode
	type: Type
	position?: Position
	// These four are as on `common.typed.LookupNode`.
	providedBy?: string
	derivedCases?: Array<string>
	conformanceName?: string
	namespaceName?: string
}

export interface IdentifierNode {
	nodeType: "Identifier"
	name: string
	type: Type
	position?: Position
}

// The simplifier runs only on a Program without errors, so `type` is never
// an Error.
export interface CombinationNode {
	nodeType: "Combination"
	lhs: ExpressionNode
	rhs: ExpressionNode
	type: Type
	position?: Position
	// On a Dictionary update only, the witness of the base's keys.
	keyConformance?: ExpressionNode
}

export interface MatchNode {
	nodeType: "Match"
	value: ExpressionNode
	handlers: Array<MatchHandler>
	// Set by `elide-final-match-test` where the last Handler runs whenever
	// every one before it declined, so the rewriter emits it as the `else`.
	finalHandlerIsElse: boolean
	type: Type
	position?: Position
}

export type MatchHandler = {
	matcher: Type
	// A cheaper test `compile-type-tests` found for the Matcher, emitted in
	// place of `$type.isValueOfType(_self, <descriptor>)`. It is a raw
	// JavaScript boolean reading the value as `_self`.
	typeTest: ExpressionNode | null
	literal: ExpressionNode | null
	memberLiterals: Record<string, ExpressionNode> | null
	// What a Case Matcher's payload Pattern requires of a member, keyed by its
	// dotted path. It is tested after the Matcher, so reading down the path is
	// safe.
	memberTypes: Record<string, Type> | null
	// The same requirements as `compile-type-tests` compiled them, or null,
	// in which case the rewriter emits from `memberTypes`.
	memberTests: Record<string, ExpressionNode> | null
	guard: ExpressionNode | null
	body: Array<ImplementationNode>
}

// `define { … }`, which the rewriter emits as a chain of JavaScript
// conditionals ending in the `otherwise` value.
export interface DefineNode {
	nodeType: "Define"
	arms: Array<DefineArm>
	otherwise: ExpressionNode
	type: Type
	position?: Position
}

export type DefineArm = {
	value: ExpressionNode
	condition: ExpressionNode
	// As on `ConditionalStatementNode`.
	conditionIsRaw: boolean
	// Carried from the typed node. See "Narrowing records" in DEVELOPMENT.md.
	narrows: boolean
	narrowsBelow: boolean
}

// #endregion

// #region Intrinsics

// What an optimiser pass rewrites an Expression into, for the rewriter to
// emit directly. Each keeps the replaced node's `type` and `position`. See
// "Intrinsics" in DEVELOPMENT.md.
export type IntrinsicNode =
	| TagTestNode
	| TypeTestNode
	| TypeDescriptorNode
	| EssenceBooleanNode
	| RawBooleanNode
	| RawBooleanOperationNode
	| RawCompareNode
	| RawEqualsNode
	| RawArithmeticNode
	| DirectMethodNode
	| DirectRecordNode
	| DirectCaseNode
	| DirectListNode
	| SpreadCombinationNode
	| MemberOrDefaultNode
	| PooledReferenceNode
	| DispatchChainNode
	| InlineLoopNode
	| ListBuildNode
	| OmittedArgumentNode

// The `undefined` a call passes for a defaulted Parameter that something
// follows. See "Omitted Arguments" in DEVELOPMENT.md.
export type OmittedArgumentNode = {
	nodeType: "Intrinsic"
	kind: "omitted-argument"
	type: Type
	position?: Position
}

// Whether a value is a Case with this tag, as a raw JavaScript boolean. See
// "Tag tests" in DEVELOPMENT.md.
export interface TagTestNode {
	nodeType: "Intrinsic"
	kind: "tag-test"
	value: ExpressionNode
	tag: string
	negated: boolean
	optional: boolean
	type: BooleanType
	position?: Position
}

// `$type.isValueOfType(<value>, <descriptor>)`, as a raw JavaScript boolean,
// where a tag does not decide. The descriptor is an Expression so
// `pool-constants` can hoist it.
export interface TypeTestNode {
	nodeType: "Intrinsic"
	kind: "type-test"
	value: ExpressionNode
	descriptor: ExpressionNode
	type: BooleanType
	position?: Position
}

// A Type as data for `isValueOfType`, such as `{ type: "Record", … }`. It is
// no Essence value, so only a `type-test` and the pool may hold one.
export interface TypeDescriptorNode {
	nodeType: "Intrinsic"
	kind: "type-descriptor"
	descriptor: Type
	type: Type
	position?: Position
}

// A read of a value built once in a const band. See "Pooled constants" in
// DEVELOPMENT.md.
export interface PooledReferenceNode {
	nodeType: "Intrinsic"
	kind: "pooled-reference"
	key: string
	value: ExpressionNode
	type: Type
	position?: Position
}

// A raw JavaScript boolean as an Essence Boolean, choosing one of the two
// Boolean objects without allocating.
export interface EssenceBooleanNode {
	nodeType: "Intrinsic"
	kind: "essence-boolean"
	value: ExpressionNode
	type: BooleanType
	position?: Position
}

// The raw JavaScript boolean inside an Essence Boolean, `<value>.value`, the
// inverse of `essence-boolean`. A pass unwraps an `essence-boolean` rather
// than nesting the two.
export interface RawBooleanNode {
	nodeType: "Intrinsic"
	kind: "raw-boolean"
	value: ExpressionNode
	type: BooleanType
	position?: Position
}

// `!a`, `a && b` or `a || b` over raw booleans, answering a raw boolean.
// `other` is null exactly for `not`. JavaScript may skip the right operand,
// which Essence always evaluates, so `lower-scalar-operations` builds this only
// where that operand observes nothing.
export interface RawBooleanOperationNode {
	nodeType: "Intrinsic"
	kind: "raw-boolean-op"
	operator: "not" | "and" | "or"
	operand: ExpressionNode
	other: ExpressionNode | null
	type: BooleanType
	position?: Position
}

// Two Integers ordered by their bigint `.value`, as a raw boolean.
export interface RawCompareNode {
	nodeType: "Intrinsic"
	kind: "raw-compare"
	operator: "<" | ">" | "<=" | ">="
	left: ExpressionNode
	right: ExpressionNode
	type: BooleanType
	position?: Position
}

// Equality of two Integers by `===`, or of two Strings by
// `$helpers.stringEquals`, which sees canonically equivalent spellings as
// equal. A raw boolean, and `negated` works as on `tag-test`.
export interface RawEqualsNode {
	nodeType: "Intrinsic"
	kind: "raw-equals"
	scalar: "Integer" | "String"
	left: ExpressionNode
	right: ExpressionNode
	negated: boolean
	type: BooleanType
	position?: Position
}

// Integer arithmetic on the bigints, wrapped in one allocation as an ordinary
// Essence Integer.
export interface RawArithmeticNode {
	nodeType: "Intrinsic"
	kind: "raw-arithmetic"
	operator: "+" | "-" | "*"
	left: ExpressionNode
	right: ExpressionNode
	type: IntegerType
	position?: Position
}

// One Method of a witness in place of the witness, such as `Integer.toString`
// for `{ toString: Integer.toString }`. Only a site that calls exactly that
// Method, such as a String's hole, may hold one.
export interface DirectMethodNode {
	nodeType: "Intrinsic"
	kind: "direct-method"
	namespaceName: string
	memberName: string
	// Carried so this emits what the witness would have for the member.
	derivedDescriptor?: DerivedEquatableDescriptor
	type: Type
	position?: Position
}

// A Record built as the one object literal `Record.createRecord` would have
// produced.
export interface DirectRecordNode {
	nodeType: "Intrinsic"
	kind: "direct-record"
	members: Record<string, ExpressionNode>
	type: RecordType
	position?: Position
}

// A Case built in one allocation, tagged as `createCase` tags it. A Record
// literal payload is inlined into `members`, since nothing else can hold it.
// Any other `payload` is spread ahead of the tag. At most one is set.
export interface DirectCaseNode {
	nodeType: "Intrinsic"
	kind: "direct-case"
	tag: string
	members: Record<string, ExpressionNode>
	payload: ExpressionNode | null
	type: CaseType | ErrorType
	position?: Position
}

// A List built as the one object literal `List.createList` would have
// produced.
export interface DirectListNode {
	nodeType: "Intrinsic"
	kind: "direct-list"
	values: Array<ExpressionNode>
	type: ListType
	position?: Position
}

// A Method call on a Union-typed receiver as a written-out chain of tests,
// in place of `$type.dispatchMethod`. See "Dispatch chains" in
// DEVELOPMENT.md.
export interface DispatchChainNode {
	nodeType: "Intrinsic"
	kind: "dispatch-chain"
	temporaries: Array<DispatchTemporaryNode>
	receiver: ExpressionNode
	arguments: Array<ExpressionNode>
	cases: Array<DispatchChainCase>
	type: Type
	position?: Position
}

// A value the chain reads more than once, bound under a name no Program can
// spell, since an Essence name never contains `_`.
export type DispatchTemporaryNode = {
	name: string
	value: ExpressionNode
}

// One branch: the test that selects it and the call it makes.
export type DispatchChainCase = {
	// A raw boolean reading the receiver. Null where the branch is taken
	// whenever it is reached.
	test: ExpressionNode | null
	namespaceName: string
	methodName: string
	conformanceArguments: Array<ExpressionNode>
	// The rest are as on `UnionMethodDispatchCase`.
	contextualArguments: Array<{ index: number; value: ExpressionNode }>
	omittedParameterIndices: Array<number>
	derivedDescriptor?: DerivedEquatableDescriptor
	derivedMembers?: Array<string>
	// The tree-shaking walk finds the provided const only through this.
	providedBy?: string
}

// A `loop` call or a walking List Method, written out as a `while` or `for`
// with the callbacks' bodies inside. See "Inlined loops" in DEVELOPMENT.md.
export interface InlineLoopNode extends InlineLoop {
	nodeType: "Intrinsic"
	kind: "inline-loop"
	type: Type
	position?: Position
}

// A walk, shared by `InlineLoopNode` and `InlineLoopStatementNode`.
export type InlineLoop = {
	name: string
	driver: InlineLoopDriver
	// Set by `build-lists-in-place` where only the walk can reach the List it
	// threads, so it may push onto one Array.
	build?: ListBuild
}

// The step callback's Parameter the List arrives under.
export type ListBuild = {
	parameter: number
}

// The items this turn adds to the walk's Array, in place of a chain such as
// `state::append(x)::append(contentsOf ys)`. It stands only where the walk's
// answer is written.
export interface ListBuildNode {
	nodeType: "Intrinsic"
	kind: "list-build"
	additions: Array<ListBuildAddition>
	type: Type
	position?: Position
}

// One `append`, of an item or, with `contentsOf`, of a List's items.
export type ListBuildAddition = {
	contentsOf: boolean
	value: ExpressionNode
}

// A Function literal callback: the names its body reads its Arguments under,
// and the body.
export type InlineLoopCallback = {
	parameters: Array<IdentifierNode>
	body: Array<ImplementationNode>
}

// Which driver, and the Expressions it was given. Each mirrors its Essence
// driver exactly.
export type InlineLoopDriver =
	// `loop(startingWith:while:_)`, or with `until` the predicate inverted.
	| {
			kind: "condition"
			until: boolean
			seed: ExpressionNode
			predicate: InlineLoopCallback
			step: InlineLoopCallback
	  }
	// `loop(from:through:startingWith:_)`, or with `descending`
	// `loop(from:downTo:startingWith:_)`, as a `for` over bigints. The
	// up-counting one answers the seed where the end is before the start, and
	// the down-counting one always takes its first turn.
	| {
			kind: "counted"
			descending: boolean
			from: ExpressionNode
			through: ExpressionNode
			seed: ExpressionNode
			step: InlineLoopCallback
	  }
	// `loop(startingWith:step:)`, whose step answers `#Done` or `#Continue`.
	| { kind: "general"; seed: ExpressionNode; step: InlineLoopCallback }
	// `List.reduce`. `stepped` is the entry whose combiner answers a `Step`.
	| {
			kind: "fold"
			stepped: boolean
			items: ExpressionNode
			seed: ExpressionNode
			step: InlineLoopCallback
	  }
	// `List.map` and `List.everyItem(where:)`, which build an Array.
	| { kind: "map"; items: ExpressionNode; transform: InlineLoopCallback }
	| { kind: "keep"; items: ExpressionNode; check: InlineLoopCallback }

// `{ ...lhs, member: … }` in one allocation. Exactly one of `members` and
// `rhs` is set. See "Record spreads" in DEVELOPMENT.md.
export interface SpreadCombinationNode {
	nodeType: "Intrinsic"
	kind: "spread-combination"
	lhs: ExpressionNode
	members: Record<string, ExpressionNode>
	rhs: ExpressionNode | null
	// The members of `rhs`'s Type, in declaration order, set exactly when
	// `rhs` is.
	rhsMembers: Array<string> | null
	type: Type
	position?: Position
}

// One member of a Record-defaulted Parameter, as `options.retries ?? 3`. See
// "Record defaults at the callee" in DEVELOPMENT.md.
export interface MemberOrDefaultNode {
	nodeType: "Intrinsic"
	kind: "member-or-default"
	base: ExpressionNode
	// The members read off the base, outermost first, never empty. Every step
	// after the first reads through `?.`.
	path: ReadonlyArray<string>
	fallback: ExpressionNode
	optional: boolean
	type: Type
	position?: Position
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
	| TestAssertionStatementNode
	| TailCallStatementNode
	| IntrinsicStatementNode

// What `matches snapshot` compares the rendered value against. `slot` is the
// span point an update writes the recorded value into.
export type TestSnapshot = {
	name: string | null
	recorded: string | null
	slot: number
}

// `expect` or `require`, with or without a Matcher or `matches snapshot`. A
// failed `require` returns early, before the Constants its Matcher binds.
// `value` is a raw boolean where a Matcher was written, else an Essence one.
export interface TestAssertionStatementNode {
	nodeType: "TestAssertionStatement"
	form: "expect" | "require"
	// The point of the whole asserted Expression, which a failure underlines.
	point: number
	value: ExpressionNode
	// A `match` Handler's test, with no `guard` and an empty `body`.
	matcher: MatchHandler | null
	snapshot: TestSnapshot | null
	comparison: TestComparison | null
	position?: Position
}

// For an assertion whose outermost call is `is` or `isNot`, the points its
// two operands were traced at, which the runtime reads back and diffs.
export type TestComparison = {
	kind: "is" | "isNot"
	left: number
	right: number
}

export interface VariableDeclarationStatementNode {
	nodeType: "VariableDeclarationStatement"
	name: IdentifierNode
	value: ExpressionNode
	type: Type
	isConstant: boolean
	position?: Position
}

export interface VariableAssignmentStatementNode {
	nodeType: "VariableAssignmentStatement"
	name: IdentifierNode
	value: ExpressionNode
	position?: Position
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
	// The shims of native Methods that declare a default. An instance Method's
	// Parameters already start with `_self`, and names are already mangled.
	nativeShims: Array<NativeShimNode>
	type: NamespaceType
	position?: Position
}

export interface ProtocolDeclarationStatementNode {
	nodeType: "ProtocolDeclarationStatement"
	name: IdentifierNode
	identity: string
	// The provided Methods, shaped as a Namespace's are: `_self` first and
	// `Self__conformance` last. Each is emitted as a `$es_<Protocol>__<member>`
	// const.
	methods: Methods
	position?: Position
}

export interface TypeAliasStatementNode {
	nodeType: "TypeAliasStatement"
	name: IdentifierNode
	type: Type
	position?: Position
}

export interface ConditionalStatementNode {
	nodeType: "ConditionalStatement"
	condition: ExpressionNode
	// Carried from the typed node. See "Narrowing records" in DEVELOPMENT.md.
	narrows: boolean
	// False for an `if` without `else`.
	narrowsFalse: boolean
	// Set where `condition` is a raw boolean, which the rewriter then emits
	// without reading `.value`.
	conditionIsRaw: boolean
	trueBody: Array<ImplementationNode>
	falseBody: Array<ImplementationNode>
	position?: Position
}

export interface ReturnStatementNode {
	nodeType: "ReturnStatement"
	expression: ExpressionNode
	position?: Position
}

// A Return that calls its own Function, turned into a jump back to the head
// of the Function. It ends a turn rather than placing an answer, so it is no
// intrinsic. See "Self tail calls" in DEVELOPMENT.md.
export interface TailCallStatementNode {
	nodeType: "TailCallStatement"
	// The label the enclosing Function's `tailLoop` declares.
	label: string
	bindings: Array<TailCallBinding>
	assignments: Array<TailCallBinding>
	position?: Position
}

export type TailCallBinding = { name: string; value: ExpressionNode }

export interface FunctionStatementNode {
	nodeType: "FunctionStatement"
	name: IdentifierNode
	value: FunctionDefinitionNode
	position?: Position
}

// #endregion

// #region Statement intrinsics

// An intrinsic written as Statements where it stands in a Statement position.
// See "Statement intrinsics" in DEVELOPMENT.md.
export type IntrinsicStatementNode =
	| StatementMatchNode
	| HeldExpressionNode
	| InlineLoopStatementNode

// Where a lowered Expression's answer goes.
export type StatementResult =
	| { kind: "return" }
	// Declared as an uninitialised `let` before the block, since the name
	// outlives it.
	| { kind: "declaration"; name: IdentifierNode }
	| { kind: "assignment"; name: IdentifierNode }
	// The answer is dropped.
	| { kind: "discard" }

// How the matched value reaches `_self`, the name every Handler reads it
// under.
export type MatchedValueBinding =
	// `match @ -> …`, whose value already is `_self`.
	| { kind: "self" }
	// `{ const _self = <value>; … }`.
	| { kind: "block" }
	// `{ const <name> = <value>; { const _self = <name>; … } }`, for a value
	// that reads `_self`.
	| { kind: "held"; name: string }

// A `match` written as Statements: the value under a name, then a chain of
// `if`s over the Handlers. Unless `result` is `return`, a Handler breaks out
// of the block `label` names.
export interface StatementMatchNode {
	nodeType: "IntrinsicStatement"
	kind: "statement-match"
	value: ExpressionNode
	binding: MatchedValueBinding
	handlers: Array<MatchHandler>
	// As on `MatchNode`.
	finalHandlerIsElse: boolean
	result: StatementResult
	label: string
	position?: Position
}

// An Expression that holds values under names, such as a dispatch chain,
// with the names as `const`s of a block rather than an arrow's Parameters.
export interface HeldExpressionNode {
	nodeType: "IntrinsicStatement"
	kind: "held-expression"
	temporaries: Array<DispatchTemporaryNode>
	expression: ExpressionNode
	result: StatementResult
	position?: Position
}

// An inlined loop in a Statement position, written without the arrow the
// Expression form needs.
export interface InlineLoopStatementNode extends InlineLoop {
	nodeType: "IntrinsicStatement"
	kind: "inline-loop"
	result: StatementResult
	position?: Position
}

// #endregion

// #region Helpers

export interface FunctionDefinitionNode {
	nodeType: "FunctionDefinition"
	parameters: Array<ParameterNode>
	body: Array<ImplementationNode>
	returnType: Type
	// Set on a completing body, which the rewriter emits as a Function
	// returning a future that runs the body.
	completing?: true
	// The label of the loop `loop-self-tail-calls` wraps the body in. See
	// "Self tail calls" in DEVELOPMENT.md.
	tailLoop?: string
}

export interface ParameterNode {
	nodeType: "Parameter"
	externalName: IdentifierNode | null
	internalName: IdentifierNode
	// The default, emitted as a JavaScript default parameter. Both evaluate it
	// per call, only when the Argument is left out, after the Parameters before
	// it.
	defaultValue: ExpressionNode | null
}

export interface ArgumentNode {
	nodeType: "Argument"
	name: string | null
	value: ExpressionNode
}
// #endregion
