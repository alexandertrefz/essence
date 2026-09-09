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
	StringType,
	Type,
} from "./index"

// #region Program & Sections

export type Program = {
	nodeType: "Program"
	imports: ImportSectionNode | null
	implementation: ImplementationSectionNode
	// NOTE: Null in every compile that did not ask for the tests — which is
	// every build and every run. The lowering that fills it is what turns a
	// typed `tests { … }` block into the Statements a runner registers; see
	// `TestsSectionNode`.
	tests: TestsSectionNode | null
	// NOTE: Null in every compile that did not ask for coverage, which is every
	// build and every ordinary test run. `instrument-coverage` is the only
	// thing that fills it, and it fills it with the table the counters it wrote
	// into the Program are indexed by; see `CoverageSectionNode`.
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

// #region Tests

// NOTE: The `tests { … }` block, lowered. A suite is gone as a THING by this
// point — what it contributed to a test's identity is folded into the manifest
// entry, and what it contributed as a Scope is a `TestScope` around the entries
// it held. So the tree below is a Scope tree, and the flat `tests` array beside
// it is what a runner reads.
//
// NOTE: `nodes` is emitted as ONE Function taking the per-test context. The
// setup Statements stand in it where they were written, so running it evaluates
// exactly the setup the selected test can see, afresh, every time — which is
// what "a tests-section constant is indistinguishable from fresh evaluation per
// test" says. Nothing is hoisted out and nothing is shared between two runs.
export type TestsSectionNode = {
	nodeType: "TestsSection"
	// NOTE: The canonical path of the Module the section was written in, as the
	// identities on the entries below spell it. Null where the Program is no
	// Module, which is every single-file compile.
	module: string | null
	// NOTE: The instrumented points of this Module, indexed by point id. Every
	// `TestTraceNode` and every assertion names one.
	spans: Array<TestSpan>
	tests: Array<TestManifestEntry>
	nodes: Array<TestsNode>
}

// NOTE: Where an instrumented point stands, and the source text that stands
// there. The text is sliced at lowering time because the reader of an event may
// be nowhere near the file — a `--json` consumer, an editor rendering a value
// beside a line — and slicing it twice is two chances to disagree about what
// was recorded.
export type TestSpan = {
	position: Position
	source: string
}

// NOTE: What a runner can say about a test without running it. Every Modifier
// is EFFECTIVE here — a suite's `skipped` reaches its tests — because what a
// suite MEANT was settled by the Enricher and nothing downstream knows the
// vocabulary.
export type TestManifestEntry = {
	id: string
	// NOTE: The name TEMPLATE, never the rendering: `"{scored}–{conceded} is a
	// win"`. The rendering is worked out where the test stands and reaches the
	// runner through the context.
	name: string
	// NOTE: Whether that template has a hole in it, which is the only reason a
	// runner ever evaluates a section without running a test. It is recorded
	// rather than read back off the name because a plain name may perfectly
	// well hold a brace of its own.
	interpolated: boolean
	// NOTE: Which row of a table test this entry is, and null for the ordinary
	// test that runs once. It is the last step of the identity — a row is a
	// test in its own right, and everything durable is keyed by that identity —
	// and it is what a report groups under the template the rows share.
	row: number | null
	suitePath: Array<string>
	tags: Array<string>
	focused: boolean
	skipped: string | null
	// NOTE: Whether the item was written as a `benchmark` rather than as a
	// `test`. It is what a runner reads to decide whether the entry runs at all
	// — a benchmark is timed, which is work nobody asked an ordinary run to do,
	// so it runs under `--bench` or where somebody named it by id.
	benchmark: boolean
	// NOTE: How many cases this entry's property runs where the command line
	// says nothing, and null to take the run's own count — a synthesized
	// contract goal's budget rides here so the runtime need never know where
	// an entry came from.
	cases: number | null
	// NOTE: The identity WITHOUT the Module path, spelled by
	// `relativeIdentityKey` — for a row of a table, with the row as its last
	// step. It is what everything stored BESIDE the file is keyed by (a
	// benchmark's baseline, a property test's counterexamples): the file the
	// entry belongs to is the file the companion sits next to, so spelling the
	// path into the key as well would break every entry the day the file moves.
	// Spelled ONCE, here, by the Compiler — a runner that re-derived it would
	// be a second copy of the escaping that could drift.
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

// NOTE: One test, standing where it was written — inside whatever setup it can
// see. `index` is its place in the section's `tests` array, which is how the
// context says which one to run.
export interface TestEntryNode {
	nodeType: "TestEntry"
	index: number
	// NOTE: The name as an Expression, and only where it INTERPOLATES: a plain
	// String Literal is in the manifest already, and emitting it a second time
	// would be two spellings of one thing.
	name: ExpressionNode | null
	// NOTE: Whether the item is a `benchmark`, whose body the runtime times
	// rather than judges. The key its baseline is stored under is not here —
	// it is the manifest entry's `key`, the one durable identity everything
	// beside the file shares.
	benchmark: boolean
	body: Array<ImplementationNode>
	position?: Position
}

// NOTE: A table test — one written row per entry of the manifest, all of them
// sharing ONE body and ONE name Expression, each of which reads the row under
// `binding`. The rows are a plain JavaScript Array rather than a List, because
// nothing ever holds them all at once: what the emission needs is the value of
// row N, and building a List to read one item back out of it would be work
// nobody asked for.
//
// `first` is the manifest index of row 0; row N is at `first + N`, which is
// what the context selects by.
export interface TestRowsNode {
	nodeType: "TestRows"
	first: number
	binding: string
	rows: Array<ExpressionNode>
	// NOTE: What a Pattern Parameter binds off the row. It stands at the head
	// of BOTH the name and the body, because both read the row's parts and the
	// name is worked out without the body running.
	bindings: Array<ImplementationNode>
	// NOTE: The name as an Expression, and only where it INTERPOLATES — the
	// same rule a plain test follows. It reads the row, which is why a table
	// test's name can say which row it ran for.
	name: ExpressionNode | null
	// NOTE: Whether the rows are a benchmark's — see `TestEntryNode.benchmark`.
	// Each row's baseline key is its own manifest entry's `key`, the row spelled
	// as the identity's last step.
	benchmark: boolean
	body: Array<ImplementationNode>
	position?: Position
}

// NOTE: A property test — ONE entry of the manifest and one body, run once per
// generated case rather than once. The body reads its Parameters the way a
// table's reads its row: they are the Parameters of the closure the emission
// wraps it in, and the runtime calls it with the values it drew.
export interface TestPropertiesNode {
	nodeType: "TestProperties"
	index: number
	// NOTE: The name as an Expression, and only where it INTERPOLATES. It is
	// worked out in the Scope the test was WRITTEN in rather than in the body's:
	// what a property generates is a different value every case, so a name
	// saying which one it ran for could name no test at all.
	name: ExpressionNode | null
	parameters: Array<TestPropertyParameter>
	body: Array<ImplementationNode>
	position?: Position
}

// NOTE: One generated Parameter: the name the body binds and a report names,
// and how to draw a value for it.
export type TestPropertyParameter = { name: string; generator: TestGenerator }

// NOTE: The Enricher's generator with its Expressions lowered. It is the same
// shape by design — one description of how to build a value, written once in
// `common.typed` and carried through — because the runtime interprets it and
// nothing between here and there decides anything about it.
export type TestGenerator =
	| { kind: "boolean" }
	| { kind: "integer" }
	| { kind: "rational" }
	| { kind: "string" }
	| { kind: "list"; item: TestGenerator }
	// NOTE: As on the Enricher's generator — the key Type's own Equatable
	// witness, lowered to the Expression the Rewriter emits. See
	// `common.typed.TestGenerator`.
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
	| { kind: "generated"; name: string; binding: string; call: ExpressionNode }

export type TestGeneratorMember = { name: string; generator: TestGenerator }

export type TestNarrowing = {
	atLeast?: string
	atMost?: string
	notEqualTo?: Array<string>
	minimumLength?: number
	maximumLength?: number
}

// NOTE: What a `suite` leaves behind: a Scope, so that what a suite declares is
// gone outside it and may shadow what the section declares. It is emitted as a
// closure the runtime calls, which is what JavaScript's own scoping needs to
// keep the shadow and what lets a run step over the suites it is not in.
//
// NOTE: `first` and `last` are the half-open run of `tests` indices the Scope
// holds, nested suites included. A run is ONE test, and the setup it must see
// is the setup of the section and of the suites it is written in — so a Scope
// holding no part of it is not evaluated at all. That is what keeps a suite's
// printed output from being attributed to a test written beside it, and what
// keeps a section of twenty suites from evaluating twenty setups per test.
export interface TestScopeNode {
	nodeType: "TestScope"
	first: number
	last: number
	nodes: Array<TestsNode>
	position?: Position
}

// #endregion

// #region Coverage

// NOTE: What `instrument-coverage` wrote into a Module, and the only thing that
// can say what a counter MEANT. The Program carries counter calls indexed into
// `points`; a report needs to know where each of those stands, what kind of
// thing it counts and what to call it, and none of that can be read back off
// the emitted JavaScript. So the table travels with the Module and is emitted
// beside it.
export type CoverageSectionNode = {
	nodeType: "CoverageSection"
	points: Array<CoveragePoint>
	// NOTE: Every Choice this Module DECLARES, with its Cases — the denominator
	// of "which Cases were never constructed". A construction is counted where
	// it happens, which may be any Module of the graph; what is declared is
	// known only here.
	choices: Array<CoverageChoice>
}

export type CoveragePointKind = "statement" | "branch" | "case" | "construction"

// NOTE: One counter. `label` is what a report calls it — `"else"`, `"case
// #Postponed"`, `"#Forfeited"` — and `scope` is the Namespace Method or free
// Function it stands in, so a "not taken" line reads `Standings::compute ›
// case #Postponed` without the reader going to the file.
export type CoveragePoint = {
	kind: CoveragePointKind
	label: string
	scope: string
	position: Position
	// NOTE: Set on a branch whose condition ESTABLISHED something — the
	// `if played::isNot(0)` that guards a division. Both sides of such a branch
	// are worth reporting on separately, which is what refinement coverage is.
	refinement: boolean
	// NOTE: The Case a construction point builds, spelled `Choice#Case`. Null
	// on every other kind.
	tag: string | null
}

export type CoverageChoice = {
	name: string
	// NOTE: Spelled `Choice#Case`, the way a construction's tag is, so the two
	// are compared without either side taking a spelling apart.
	cases: Array<string>
	position: Position
}

// #endregion

// #region Expressions

// NOTE: Every Expression and Statement carries the `position` of the typed
// node it was simplified from, so code generation can map what it emits back
// onto the source. It is optional because the Simplifier also synthesizes
// nodes no source was written for — a unit-returning function's trailing
// Return, a conformance witness — and those stay unset, which emits no
// mapping.
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

// NOTE: An instrumented point: record what stands here, then answer with it.
// Wrapping an Expression in one changes nothing about what the Expression
// evaluates to, which is the whole discipline — the recording is a side effect
// on the per-test context and never a value anything reads.
//
// NOTE: It is a Node of the Simplifier's own rather than an intrinsic, because
// intrinsics stand for shapes an Optimiser pass DECIDED and this stands for
// something the source asked for. `expect` and `require` are its first
// consumers; the `§?` value comment is the third and coverage counters are the
// next, and they record at points of their own against the same table.
export interface TestTraceNode {
	nodeType: "TestTrace"
	// NOTE: Which buffer the recording lands in. A `trace` belongs to the
	// assertion that evaluated it and is DRAINED by it, so a report says what
	// that assertion was built from; a `probe` belongs to the line it was
	// written on and is kept for the whole test, because a value comment asks
	// a question no assertion asked.
	kind: "trace" | "probe"
	// NOTE: Indexes the Module's span table — see `TestsSectionNode.spans`.
	point: number
	value: ExpressionNode
	type: Type
	position?: Position
}

// NOTE: A coverage counter — "control arrived here", counted. It is the same
// idea as a trace and deliberately not the same Node: a trace records a VALUE
// against a per-test context and is read by the assertion that drained it, and
// a counter records that control arrived, against the Module, whether a test is
// running or not. The two tables are separate for the same reason.
//
// NOTE: `value` is null in Statement position, where the counter stands on its
// own. It is set where a counter has to answer with something — a Choice Case
// built inside an Expression, an arm of a `define` — and what is emitted answers
// with the very value it was handed, so putting an Expression behind one changes
// nothing about what it evaluates to.
export interface CoverageCounterNode {
	nodeType: "CoverageCounter"
	// NOTE: Indexes the Module's coverage table — see `CoverageSectionNode`.
	point: number
	value: ExpressionNode | null
	// NOTE: Whether the counter runs BEFORE the value it answers with, which is
	// the difference between counting that a path was TAKEN and counting that a
	// value was BUILT. A `define` arm's counter leads: the arm is counted on the
	// way in, exactly as the Statement in front of an `if` body counts its
	// branch on the way in, so an answer that threw while it was built was still
	// the arm the ladder chose. A Case construction's does not: what that point
	// claims is that a Case was built, and a payload that threw halfway built
	// none. A counter with no value never reads this — one standing on its own
	// is already in front of what it counts.
	leads: boolean
	type: Type
	position?: Position
}

// NOTE: A Case construction, reduced to its runtime essentials — the tag the
// value carries (`"CalculatorOperation#Add"`) and the payload Record it is
// built from (null for unit Cases).
export interface CaseValueNode {
	nodeType: "CaseValue"
	tag: string
	value: ExpressionNode | null
	type: CaseType | ErrorType
	position?: Position
}

// NOTE: The value passed for a Protocol-bounded Type Parameter — rewritten
// into an object literal that maps each Protocol Method's emitted name onto
// the conforming Namespace's fulfilling Method.
export interface ConformanceValueNode {
	nodeType: "ConformanceValue"
	namespaceName: string
	methodMap: Record<string, string>
	// NOTE: As on the ConformanceSource — the Protocol's provided Methods this
	// conformer does not override, each under the Protocol that wrote the body.
	// The Rewriter curries the finished witness onto each of them.
	providedMethods?: Record<string, string>
	// NOTE: The witness values for this Namespace's own `where` conditions, in
	// Generic declaration order. Empty for an unconditional conformance, which
	// the Rewriter emits as a plain method-map object literal.
	conditions: Array<ExpressionNode>
	// NOTE: Present only when this witness is a *generic* Choice's derived
	// Equatable — the Rewriter then emits `$helpers.boundChoiceIs(<descriptor>)`
	// for each mapped Method instead of the plain `choiceIs`.
	derivedDescriptor?: DerivedEquatableDescriptor
	type: Type
	position?: Position
}

export interface FunctionInvocationNode {
	nodeType: "FunctionInvocation"
	name: ExpressionNode
	arguments: Array<ArgumentNode>
	// NOTE: As on a Method Invocation — set only when the call left an Argument
	// out, and read only to route a native callee through its shim.
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
	// NOTE: Present only when this call left an Argument out. It decides ONE
	// thing at emission: whether a native callee is reached through the shim
	// that holds its defaults or read straight off the runtime module. A call
	// that writes every Argument carries nothing here and emits exactly what it
	// always did.
	omitsArguments?: true
	// NOTE: Present only when this call is a *generic* Choice's derived
	// Equatable — the Rewriter then emits `$helpers.boundChoiceIs(<descriptor>)`
	// in place of the plain `choiceIs` member read.
	derivedDescriptor?: DerivedEquatableDescriptor
	// NOTE: The Protocol that PROVIDED this Method, when one did. `base`/
	// `namespaceName` is the Namespace whose conformance put the Method in
	// reach — `Integer` for `5::isNot(3)` — and that Namespace declares no
	// Method of the name, so this is what sends the emission to the one const
	// every conformer shares. It is a flag rather than a name comparison
	// because a Program may declare `protocol Integer` beside the standard
	// library's `Integer` Namespace, and a name alone can not say which
	// answered.
	providedBy?: string
	type: Type
	position?: Position
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
	position?: Position
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
	// NOTE: Which of THIS branch's Parameters the call wrote no Argument for,
	// indexed over its callee's whole signature with the receiver at 0. Per
	// branch because every branch resolves to a different Method and they need
	// not agree: `v::m(to 3)` against a branch declaring `(_ a: Integer = 1, to
	// b: Integer)` omits Parameter 1, and against a branch declaring `(to b:
	// Integer)` omits nothing. The shared Argument list is therefore what the
	// call WROTE, and the holes are opened per branch where the call is made.
	omittedParameterIndices: Array<number>
	// NOTE: Present only when this branch resolves to a *generic* Choice's
	// derived Equatable — the Rewriter then emits
	// `$helpers.boundChoiceIs(<descriptor>)` for the branch's Method.
	derivedDescriptor?: DerivedEquatableDescriptor
	// NOTE: The Protocol that provided this branch's Method, read exactly as
	// `MethodInvocationNode.providedBy` above.
	providedBy?: string
}

// NOTE: The shim's whole body is one call handing every Parameter on to the
// native, which the Rewriter writes out — there is nothing here for the
// Optimiser or anything else to walk but the defaults themselves.
//
// NOTE: Except where a Parameter's default is a RECORD, which is merged into the
// Argument rather than replacing it: the merge is a Statement, so the shim's
// arrow grows a block and returns the call. Empty for every other shim, which is
// every shim there is today.
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

// NOTE: The interpolated String reduced to what codegen needs: the text runs,
// and for each hole its Expression paired with the `witness` its Type's
// `Printable` conformance became — a method-map object literal or a forwarded
// parameter, exactly like any other conformance Argument. The Rewriter calls
// `witness.toString(expression).value` to render each hole.
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

// NOTE: The written Dictionary, reduced to what the emitted construction needs
// — the pairs in written order and the witness their keys are compared through.
// The Positions the entries were written at are gone with everything else the
// Simplifier drops: the whole literal maps to one source span, exactly as a
// written List does.
export type DictionaryValueNode = {
	nodeType: "DictionaryValue"
	entries: Array<DictionaryEntryNode>
	// NOTE: The witness as an Expression, because that is what it is by here: a
	// resolved Namespace has become a ConformanceValue and a forwarded bound
	// has stayed the Identifier naming the hidden Parameter it arrived in.
	// `null` for the empty Dictionary, which compares nothing.
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
	// NOTE: As on the typed Node — the Protocol that provided a member read off
	// a Namespace, which is what sends the emission to the shared const rather
	// than to a member of that Namespace.
	providedBy?: string
}

export interface IdentifierNode {
	nodeType: "Identifier"
	name: string
	type: Type
	position?: Position
}

// NOTE: `type` is only a Record Type for valid Programs — invalid
// Combinations recover with an Error Type. The Simplifier only runs on
// Programs without Error Diagnostics.
export interface CombinationNode {
	nodeType: "Combination"
	lhs: ExpressionNode
	rhs: ExpressionNode
	type: Type
	position?: Position
	// NOTE: As on the typed Node — set only on a Dictionary update, holding the
	// witness the base's keys are compared through. A Record update carries
	// none, and emits the `Object.assign` it always did.
	keyConformance?: ExpressionNode
}

export interface MatchNode {
	nodeType: "Match"
	value: ExpressionNode
	handlers: Array<MatchHandler>
	// NOTE: That the LAST Handler is the one that runs when every Handler
	// before it declined — `elide-final-match-test` proved it, so the Rewriter
	// emits its body as the `else` of the chain rather than testing it and
	// following it with the fall-through that names a Compiler bug. False is
	// the Simplifier's own answer.
	finalHandlerIsElse: boolean
	type: Type
	position?: Position
}

export type MatchHandler = {
	matcher: Type
	// NOTE: What this Handler's Matcher tests, when the Optimiser has worked
	// out something cheaper than the Matcher's own descriptor —
	// `compile-type-tests` puts a raw test here and the Rewriter emits it in
	// place of `$type.isValueOfType(_self, <descriptor>)`. Null is the
	// Simplifier's own answer and the full check.
	//
	// NOTE: It is a RAW JavaScript boolean, like every intrinsic that stands in
	// a test position, and it reads the Handler's value under the name the
	// Rewriter binds it to: `_self`, which is the same Identifier `@` lowers to
	// inside the body.
	typeTest: ExpressionNode | null
	literal: ExpressionNode | null
	memberLiterals: Record<string, ExpressionNode> | null
	// NOTE: What a Case Matcher's payload Pattern requires of a member, keyed
	// by the dotted spine reaching it — ANDed behind the Matcher's own check,
	// which is what makes reading down that spine safe.
	memberTypes: Record<string, Type> | null
	// NOTE: The same requirements COMPILED, under the same keys — what
	// `compile-type-tests` leaves where it has written the check out, exactly as
	// `typeTest` is what it leaves for the Matcher's own. Null until that pass
	// runs, and the Rewriter emits from `memberTypes` in that case, so a build
	// with the Optimiser off says the same thing the slow way.
	memberTests: Record<string, ExpressionNode> | null
	guard: ExpressionNode | null
	body: Array<ImplementationNode>
}

// NOTE: `define { as … if … as … otherwise }`, simplified. It stays one
// Expression all the way to emission — the Rewriter folds the arms into a chain
// of JavaScript conditionals with the `otherwise` value at the tail — because
// every arm IS an Expression and none of them needs a Statement to be said.
// That is the whole difference from a Match, which holds Statements and is
// lowered to them.
export interface DefineNode {
	nodeType: "Define"
	arms: Array<DefineArm>
	otherwise: ExpressionNode
	type: Type
	position?: Position
}

// NOTE: The `otherwise` value is a bare Expression rather than the little
// Record the two layers above hold, because everything they carry it for — the
// span it was written across — is a question about the source that nothing
// downstream of here asks.
export type DefineArm = {
	value: ExpressionNode
	condition: ExpressionNode
	// NOTE: The same claim `ConditionalStatementNode.conditionIsRaw` makes, kept
	// per arm because each arm asks a question of its own: an Essence Boolean is
	// an object and every object is true, so the Rewriter reads the JavaScript
	// boolean out of it — unless a pass has already found the question asked in
	// JavaScript's own terms. False is the Simplifier's own answer.
	conditionIsRaw: boolean
	// NOTE: And the same claim `ConditionalStatementNode.narrows` makes, carried
	// down from the typed Node rather than worked out again: what an arm's
	// Condition established is read off the TYPED Condition, and checked
	// refinements are erased before the first Optimiser pass sees a Program.
	// Two readers ask for it — `instrument-coverage` marks the arm's point with
	// it, and `essence test --mutate` leaves an arm standing behind a doorway
	// alone — and neither of them could answer it for itself.
	narrows: boolean
	// NOTE: And its sister claim, about what this arm's Condition left the arms
	// BELOW it. Kept apart from `narrows` for the reason the typed Node keeps
	// them apart: neither implies the other. `instrument-coverage` marks the
	// `otherwise` arm's point with it, and `--mutate` reads both before it will
	// move an arm's answer anywhere.
	narrowsBelow: boolean
}

// #endregion

// #region Intrinsics

// NOTE: What an Optimiser pass rewrites an Expression INTO — one closed family
// of Nodes, each standing for a shape the Rewriter emits directly where the
// Simplifier's own Node would have gone through a runtime call. They exist only
// between `optimise` and `rewrite`: the Simplifier never produces one, so every
// stage ahead of the Optimiser can be read without them in mind, and the
// Rewriter's switch over `kind` is exhaustive, so a kind added without emission
// does not compile.
//
// NOTE: Each carries the `type` of the Node it replaced and that Node's
// `position` — the Rewriter maps Statements and outermost Expressions onto the
// source through it, and a pass that dropped it would silently unmap the line a
// debugger stops on.
//
// NOTE: A few of them answer a RAW JavaScript value rather than an Essence one
// — a `tag-test` is a JavaScript boolean, not a Boolean — because the JavaScript
// a lowering produces has to say `if (…)` and `? :` in JavaScript's own terms.
// Each says so in its own note, and each names the Node that turns one back
// into an Essence value: nothing may put a raw intrinsic where the Program
// expects a value.
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

// NOTE: The hole a call leaves where it wrote no Argument for a Parameter that
// has a default and something follows it — a later written Argument, or a
// hidden conformance Argument. It emits as the JavaScript literal `undefined`,
// which is exactly what a JavaScript default parameter fires on, and it is the
// one place `undefined` is deliberately introduced into emitted code.
//
// It never becomes a value: the parameter binding on the callee side consumes
// it before the first Statement of the body runs. `simplifyBody` exists to keep
// `undefined` from escaping as a RETURN value, and the same reasoning is why
// this is safe going the other way — an omission with nothing after it is not
// passed at all, so this Node stands only where a position has to be held open.
export type OmittedArgumentNode = {
	nodeType: "Intrinsic"
	kind: "omitted-argument"
	type: Type
	position?: Position
}

// NOTE: Whether a value is a Case carrying this tag — `value[<Type key>] ===
// "Ordering#Less"`, the whole of what the runtime asks when the answer can not
// depend on a payload.
//
// NOTE: It answers a RAW JavaScript boolean. `type` is `Boolean` because
// Boolean is what the question decides, not because this Node may stand where a
// Boolean value is expected: `essence-boolean` is what makes one of those. A
// `tag-test` belongs in a test position — a Conditional, another raw operation,
// or wrapped.
//
// NOTE: `negated` asks the opposite question rather than negating the answer:
// the emission is `!==`, so `isNot` costs exactly what `is` does.
//
// NOTE: `optional` reads the value through `?.`, and it is what makes this
// answer a question about a member that may not be THERE: a Record Matcher is
// open, so a value can reach a test carrying no such member, and `undefined`
// carries no Type key. `value?.[<Type key>] === "…"` is `Object.hasOwn(value,
// name) && <the tag comparison>` exactly — a member that is absent, and one
// found on `Object.prototype` rather than on the value, are both something that
// holds no Type key and so answer false, which is what the runtime's own
// `hasOwn` answers for them. `compile-record-members` is what sets it, and only
// where it could not prove the member is carried.
//
// NOTE: The two compose rather than conflict. `negated` with `optional` is
// `value?.[<Type key>] !== "…"`, which answers TRUE for a member that is not
// there — and that is what "is not this tag" means for one, the negation of the
// `hasOwn` and the comparison together, exactly as the affirmative form is their
// conjunction. Nothing writes the pair today; it is stated so that a reader
// reaching for it is not relying on an accident.
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

// NOTE: The general Type check, as the runtime performs it —
// `$type.isValueOfType(<value>, <descriptor>)` — where the tag does not decide
// and the descriptor has to be walked. It is what a Match Handler's Matcher
// compiles to when it can not compile to a `tag-test`, and it exists as a Node
// of its own so that the descriptor stands in an Expression position: that is
// what lets `pool-constants` hoist it, where a Type hanging off a Handler is
// reachable by nothing.
//
// NOTE: A RAW JavaScript boolean, like `tag-test`, and belongs in the same
// places.
export interface TypeTestNode {
	nodeType: "Intrinsic"
	kind: "type-test"
	value: ExpressionNode
	descriptor: ExpressionNode
	type: BooleanType
	position?: Position
}

// NOTE: One Type as the runtime's own checks read it — the object literal
// `{ type: "Record", members: { … } }` that `isValueOfType` walks. It is DATA
// rather than an Essence value: nothing may hand one to a Method or store it in
// a Variable, and `type` is `Unknown` because there is no Essence Type it has.
// Only a `type-test` and the pool may hold one.
export interface TypeDescriptorNode {
	nodeType: "Intrinsic"
	kind: "type-descriptor"
	descriptor: Type
	type: Type
	position?: Position
}

// NOTE: A read of a value the Program builds ONCE, in a const band of its own,
// instead of building it again at each site that wants it. `key` is what makes
// two of them one — a canonical spelling of the value, so that the same literal
// written in twenty places is one object — and `value` is what the band
// declares. The NAME is not here: it is decided per emitted Module, where the
// standard library's pooled constants and the Program's own meet and have to be
// told apart.
//
// NOTE: What may be pooled is decided by `pool-constants` and rests on the same
// property interning does: every Essence value is immutable and no operator
// asks whether two values are the SAME value, so one shared value is
// indistinguishable from many equal ones.
export interface PooledReferenceNode {
	nodeType: "Intrinsic"
	kind: "pooled-reference"
	key: string
	value: ExpressionNode
	type: Type
	position?: Position
}

// NOTE: A raw JavaScript boolean as an Essence Boolean — `<test> ?
// Boolean.trueInstance : Boolean.falseInstance`, which is `createBoolean`
// written out at the site. There are exactly two Boolean objects and these are
// they, so this allocates nothing.
export interface EssenceBooleanNode {
	nodeType: "Intrinsic"
	kind: "essence-boolean"
	value: ExpressionNode
	type: BooleanType
	position?: Position
}

// NOTE: The JavaScript boolean inside an Essence Boolean — `<value>.value` —
// which is the exact inverse of `essence-boolean` and the read every emitted
// condition already performs. It is what lets a lowered operation take an
// ordinary Boolean-valued Expression as an operand: `raw-boolean-op` works in
// JavaScript's terms, and this is how a value gets into them.
//
// NOTE: A RAW JavaScript boolean, and the one Node that may be handed one that
// is not: a pass never nests the two, because it unwraps an `essence-boolean`
// rather than reading `.value` off the object it would have built.
export interface RawBooleanNode {
	nodeType: "Intrinsic"
	kind: "raw-boolean"
	value: ExpressionNode
	type: BooleanType
	position?: Position
}

// NOTE: JavaScript's own logic over RAW booleans — `!a`, `a && b`, `a || b`.
// Both operands are raw and so is the answer, so a chain of them is one
// JavaScript expression with no Essence value built in the middle.
//
// NOTE: `other` is null exactly for `not`, which is why `and` and `or` may not
// be built with an operand that could observe anything: JavaScript's `&&` and
// `||` do not evaluate their right-hand side when the left decides, and Essence
// evaluates every Argument before the call. `lower-scalar-operations` is what
// answers that question, and it keeps the call where the answer is no.
export interface RawBooleanOperationNode {
	nodeType: "Intrinsic"
	kind: "raw-boolean-op"
	operator: "not" | "and" | "or"
	operand: ExpressionNode
	other: ExpressionNode | null
	type: BooleanType
	position?: Position
}

// NOTE: Two Integers ordered by their `.value` — `<left>.value < <right>.value`
// — where the bigint each holds IS the number, so JavaScript's own comparison
// decides exactly what `Integer.compare` decides.
//
// NOTE: A RAW JavaScript boolean, like `tag-test`.
export interface RawCompareNode {
	nodeType: "Intrinsic"
	kind: "raw-compare"
	operator: "<" | ">" | "<=" | ">="
	left: ExpressionNode
	right: ExpressionNode
	type: BooleanType
	position?: Position
}

// NOTE: Two values of ONE scalar kind compared for equality, decided the way
// that kind is decided: an Integer holds a bigint and `===` answers it, while a
// String holds a JavaScript string whose canonically equivalent spellings `===`
// does NOT see — so `$helpers.stringEquals` answers that one, which is the same
// normalising comparison the runtime's universal equality performs.
//
// NOTE: A RAW JavaScript boolean. `negated` asks the opposite question rather
// than negating an answer, exactly as `tag-test` does.
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

// NOTE: Exact arithmetic over two Integers, built in one allocation — the
// branded object literal `Integer.createInteger` would have made, around the
// bigint operation it would have been handed. The ARITHMETIC is raw; the answer
// is an ordinary Essence Integer and stands wherever one does.
export interface RawArithmeticNode {
	nodeType: "Intrinsic"
	kind: "raw-arithmetic"
	operator: "+" | "-" | "*"
	left: ExpressionNode
	right: ExpressionNode
	type: IntegerType
	position?: Position
}

// NOTE: The Function ONE Method of a conformance witness resolves to, standing
// where the witness stood — `Integer.toString` in place of
// `{ toString: Integer.toString }`, at a site that was only ever going to read
// `toString` off it and call it.
//
// NOTE: It is not a witness and not an Essence value: it is a Function
// reference, so only an emission site that CALLS exactly one Method of the
// witness it replaces may hold one. An interpolated String's hole is such a
// site; a witness passed as an Argument is not, because the callee decides
// which of its Methods to read.
export interface DirectMethodNode {
	nodeType: "Intrinsic"
	kind: "direct-method"
	namespaceName: string
	memberName: string
	// NOTE: Carried so that this emits exactly what the witness would have
	// emitted for the same member — a *generic* Choice's derived Equatable
	// widens to the descriptor-driven helper, and the one function that decides
	// that is the one this is emitted through.
	derivedDescriptor?: DerivedEquatableDescriptor
	type: Type
	position?: Position
}

// NOTE: A Record built in one allocation: the branded object literal
// `Record.createRecord` would have built from a literal it was handed — the
// literal, the call and the copy the call makes, replaced by the literal the
// copy was going to produce.
export interface DirectRecordNode {
	nodeType: "Intrinsic"
	kind: "direct-record"
	members: Record<string, ExpressionNode>
	type: RecordType
	position?: Position
}

// NOTE: A Case built in one allocation, the tag riding on the hidden Type key
// exactly as `createCase` stamps it.
//
// A payload written as a Record literal is inlined: `members` is the literal's
// own members, and the Record that would have been built and then copied never
// exists. That is sound because a Record literal is compiler-fresh — nothing
// else holds the value it makes — so no other name can see the object the Case
// is now built out of.
//
// A payload that is any OTHER Expression can be aliased, and is spread ahead of
// the tag instead, which is what `createCase` does with it. Exactly one of the
// two is ever set: `members` is empty for a spread payload and for a unit Case,
// which carries no payload at all.
export interface DirectCaseNode {
	nodeType: "Intrinsic"
	kind: "direct-case"
	tag: string
	members: Record<string, ExpressionNode>
	payload: ExpressionNode | null
	type: CaseType | ErrorType
	position?: Position
}

// NOTE: A List built in one allocation — the branded object literal
// `List.createList` would have wrapped the array in, around the same array
// literal it would have been handed.
export interface DirectListNode {
	nodeType: "Intrinsic"
	kind: "direct-list"
	values: Array<ExpressionNode>
	type: ListType
	position?: Position
}

// NOTE: A Method Invocation on a Union-typed receiver, decided where it is
// written rather than searched for at run time. `$type.dispatchMethod` was
// handed the receiver, an array of the shared Arguments and an array holding a
// Type descriptor, a Method, its conformance Arguments and its own Arguments
// per member Type — and it walked that array asking `isValueOfType` of each
// descriptor until one accepted. Every part of it is something the Compiler
// knows: which Methods, in which order, and — through `residual.ts` — what each
// of those descriptor checks reduces to. So the chain is written out, and what
// is left at each branch is the question that branch actually turns on.
//
// NOTE: The receiver and the shared Arguments are evaluated ONCE, before any
// case is tried, exactly as building that array evaluated them. `temporaries`
// holds the ones that have to be BOUND to manage it, in the order they are
// evaluated; `receiver` and `arguments` are what the branches read, which is
// those names, or the Expression itself where what was written is a name
// already and reading it again is reading the same binding.
//
// NOTE: A case's OWN Arguments — the conformance witnesses its Method requires,
// and the Function literals the Enricher compiled against it — are built inside
// the branch that uses them, where the dispatch built every branch's before
// choosing one. That is a change in WHEN they are built, and it is invisible
// for one reason only: both are pure. `compile-union-dispatch` proves it per
// case and leaves the Invocation alone where it can not.
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

// NOTE: One Expression held under a name for the length of the chain, because
// the chain reads it more than once — the receiver is read by every test and by
// the branch that answers, and a shared Argument by every branch. The name is
// the Optimiser's and unspellable in Essence: the Lexer reads `_` as a Symbol,
// so no name a Program can write contains one.
export type DispatchTemporaryNode = {
	name: string
	value: ExpressionNode
}

// NOTE: One branch — the test that selects it and the call it makes, which is
// the Method the Compiler resolved for this member Type, given the receiver,
// the shared Arguments this branch does not override, and its own hidden
// conformance Arguments.
export type DispatchChainCase = {
	// NOTE: A RAW JavaScript boolean, the same kind of test a Match Handler
	// carries and built from the same residual, reading the receiver. Null means
	// the branch is taken whenever it is REACHED: either its check accepts every
	// value that can arrive, or it is the last branch of a Union the Enricher
	// covered case by case.
	test: ExpressionNode | null
	namespaceName: string
	methodName: string
	conformanceArguments: Array<ExpressionNode>
	// NOTE: The Arguments this branch alone is given, each under the position in
	// the shared Argument list it stands in for — a Function literal compiled
	// against THIS branch's Method, which means something different in every
	// branch because its Parameter Types came from the branch.
	contextualArguments: Array<{ index: number; value: ExpressionNode }>
	// NOTE: As on the dispatch case this was built from — the Parameters THIS
	// branch's callee takes its defaults for, opened as holes in the branch's
	// own Argument list rather than in the shared one.
	omittedParameterIndices: Array<number>
	// NOTE: Present only when this branch resolves to a *generic* Choice's
	// derived Equatable, exactly as it is on the dispatch case it was built
	// from — the one function that spells a Method reference reads it.
	derivedDescriptor?: DerivedEquatableDescriptor
	// NOTE: The Protocol that PROVIDED this branch's Method, carried over from
	// the dispatch case this branch was built from. `namespaceName` is the
	// Namespace whose conformance offered it, so it is this that names the
	// const — and the tree-shaking walk reads it here to draw the edge to that
	// const, which nothing else in a compiled chain names.
	providedBy?: string
}

// NOTE: A call of the `loop` family or of one of List's walking Methods, with
// the walk written out where it stands and the callbacks' bodies written into
// it. Essence has no loop Statement — a walk is a driver Function handed
// callbacks — so every turn of every loop called two or three closures and built
// the values they threaded between them. The driver is a `while` or a `for`; the
// callbacks are their bodies; and none of it needs a Function once the Compiler
// can see which driver it is and what the callbacks are.
//
// NOTE: `name` is the prefix every name this loop binds is spelled from —
// `$loop_0_state`, `$loop_0_items`, and the label `$loop_0` the walk is left
// through. Numbered across the whole Program, so that a loop inlined inside
// another loop's body can not declare the name that one is threading its State
// under. Unspellable in Essence: the Lexer reads `_` as a Symbol, so no name a
// Program can write holds one.
//
// NOTE: What is NOT here is a rename. A callback's Parameters are bound as the
// `const`s of a block around its body, which is exactly the Scope the closure
// gave them — the body reads its Parameters and the enclosing Scope through the
// same names, in the same order, and a Parameter that shadows an outer binding
// shadows it for exactly the length of the block. See `optimisations.md`.
export interface InlineLoopNode extends InlineLoop {
	nodeType: "Intrinsic"
	kind: "inline-loop"
	type: Type
	position?: Position
}

// NOTE: The loop itself, shared by the Expression form above and the Statement
// form below — one description of a walk, emitted into whichever of the two
// positions it stands in.
export type InlineLoop = {
	name: string
	driver: InlineLoopDriver
	// NOTE: Set by `build-lists-in-place`, and absent on every walk that pass
	// declined or never saw. It is a PROOF rather than a description: the walk
	// threads a List no one but the walk can reach, so the walk may hold one
	// Array and push onto it where it rebuilt a List per turn.
	build?: ListBuild
}

// NOTE: What the proof says, which is the one thing the emission can not work
// out for itself: WHICH Parameter of the step callback the accumulator arrives
// under. The rest of the plan is in the body — every answer that writes the
// State is a `list-build` by the time the pass is done, and there is no other
// mention of the Parameter left for the emission to bind.
export type ListBuild = {
	parameter: number
}

// NOTE: The State of a walk that builds its List in place, rebuilt: the items
// THIS turn adds to the Array the walk owns. It stands exactly where the
// rebuilding chain stood — `state::append(x)::append(contentsOf ys)` is the two
// additions in that order, and the bare `state` a branch that changes nothing
// answers with is none of them.
//
// NOTE: It can only stand where an inlined walk's answer is WRITTEN, which is
// the only position `build-lists-in-place` puts one in. The Rewriter reads it
// there through the walk's own target and refuses it anywhere else: there is no
// Expression that means "the Array so far" without saying whether the walk is
// finished with it, and boxing one mid-walk would hand away an Array the next
// turn still pushes onto.
export interface ListBuildNode {
	nodeType: "Intrinsic"
	kind: "list-build"
	additions: Array<ListBuildAddition>
	type: Type
	position?: Position
}

// NOTE: One `append`. `contentsOf` is which Overload it was — one item added,
// or a whole List's items — and it decides which of the two pushes is emitted.
export type ListBuildAddition = {
	contentsOf: boolean
	value: ExpressionNode
}

// NOTE: One callback, reduced to what inlining needs of it: the names its body
// reads its Arguments under, and the body. A Function literal is the only thing
// that can become one — a Function-valued name is whatever was bound to it, and
// the call stays a call.
export type InlineLoopCallback = {
	parameters: Array<IdentifierNode>
	body: Array<ImplementationNode>
}

// NOTE: WHICH walk, and the Expressions it was given. Each mirrors one driver
// exactly — the predicate is checked before each step because `loop__overload$1`
// checks it before each step, the counted entry counts down when `from` is the
// greater because `loop__overload$3` does — and each is emitted in the order the
// call evaluated its Arguments.
export type InlineLoopDriver =
	// NOTE: `loop(startingWith:while:_)` and its `until` sibling, which is
	// the same driver with the predicate read the other way round.
	| {
			kind: "condition"
			until: boolean
			seed: ExpressionNode
			predicate: InlineLoopCallback
			step: InlineLoopCallback
	  }
	// NOTE: `loop(from:through:startingWith:_)` and `loop(from:downTo:startingWith:_)`,
	// each written in Essence on the `while` driver and threading a
	// `{ index, carried }` Record through it. Inlined it is a `for` over the
	// bigint the Integers hold, and neither the Record nor the Essence driver is
	// reached at all. `descending` is which entry it is, and it decides the step
	// and the test while compiling rather than from the bounds at run time: the
	// up-counting entry answers the seed where the end is behind the start, and
	// the down-counting one always takes its first turn.
	| {
			kind: "counted"
			descending: boolean
			from: ExpressionNode
			through: ExpressionNode
			seed: ExpressionNode
			step: InlineLoopCallback
	  }
	// NOTE: `loop(startingWith:step:)`, whose step answers with a `Step` —
	// `#Done` stops the walk with its value, `#Continue` carries the next State.
	| { kind: "general"; seed: ExpressionNode; step: InlineLoopCallback }
	// NOTE: `List.reduce`, both entries. `stepped` is the early-stopping one,
	// whose combiner answers with a `Step` exactly as the general loop's does.
	| {
			kind: "fold"
			stepped: boolean
			items: ExpressionNode
			seed: ExpressionNode
			step: InlineLoopCallback
	  }
	// NOTE: `List.map` and `List.everyItem` — a walk that builds an Array and
	// wraps it, with the callback deciding what goes in it.
	| { kind: "map"; items: ExpressionNode; transform: InlineLoopCallback }
	| { kind: "keep"; items: ExpressionNode; check: InlineLoopCallback }

// NOTE: Two Records combined in one allocation — `{ ...lhs, member: … }`, where
// `Object.assign({}, lhs, rhs)` built an empty object and copied both into it.
// The hidden Type key rides along on the spread of `lhs`, which carries it like
// any other of its own keys.
//
// The right-hand side is written out MEMBER BY MEMBER when it is a Record
// literal, which is what `{ base with x = 1 }` spells and the Record it would
// have built never exists. Any other right-hand side — a name, a call — is
// PROJECTED to the members its static Type names, one read each. As with a
// Case's payload, exactly one of `members` and `rhs` is set.
//
// NOTE: Projected rather than spread whole, because Record assignability is
// WIDTH subtyping: a value typed `{ port: Integer }` is admitted wherever that
// shape is asked for, and nothing says it does not also carry a `tls` of its
// own. Spread whole, `{ server with partial }` copied that `tls` over the one
// the answer's Type declares — a String sitting in a Boolean member, past the
// checker and into a value the rest of the Program computes on. A read per
// declared member takes exactly what the Type promised and nothing else.
export interface SpreadCombinationNode {
	nodeType: "Intrinsic"
	kind: "spread-combination"
	lhs: ExpressionNode
	members: Record<string, ExpressionNode>
	rhs: ExpressionNode | null
	// NOTE: The members of `rhs`'s Type, in declaration order — non-null
	// exactly when `rhs` is. Names, read off the Type once here, rather than a
	// Type the emitter reads again later: a pass after this one may replace the
	// right-hand side Expression (`pool-constants` does), and what is projected
	// has to stay the set the Enricher checked.
	rhsMembers: Array<string> | null
	type: Type
	position?: Position
}

// NOTE: One member of the Record a callee rebuilds a Record-defaulted Parameter
// into — the Argument's own value where the caller wrote it, and the default's
// where it did not:
//
//   options.retries ?? 3
//
// `??` is the absence test because `undefined` is never an Essence value:
// `Optional` is a Choice whose `#Empty` is a Case instance, and the one place
// `undefined` is deliberately written into emitted code is the hole a call
// leaves for an omitted Argument. So the only way a member can be missing is
// that nobody wrote it.
//
// `optional` reads the BASE through `?.` and is set exactly where the whole
// Argument may be absent — a COMPLETE default, whose Parameter carries
// `hasDefault` and whose omitted Argument arrives as `undefined`. A PARTIAL
// default leaves the Argument required, so the base is always a Record and the
// read is plain.
//
// NOTE: The fallback is evaluated only where the caller left THAT member out,
// which is the per-call, only-when-needed semantics the language promises a
// default — and it is why a Record default written as a literal is lowered
// member by member rather than built whole and merged.
export interface MemberOrDefaultNode {
	nodeType: "Intrinsic"
	kind: "member-or-default"
	base: ExpressionNode
	// NOTE: The members read off the base, outermost first, never empty. One
	// step is the ordinary case; a longer path is a member the default writes as
	// a Record Literal of its own and the callee therefore rebuilds one level
	// further in, so that a path key in the Argument merges into it. Every step
	// past the first reads optionally whatever `optional` says: a level the
	// Argument left out is a level that is not there.
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
	| IntrinsicStatementNode

// NOTE: `expect EXPR` / `require EXPR`, and both `is MATCHER` forms. What
// differs between the two words is one thing: a failed `require` ends the test
// where it stands, which is emitted as an early return in front of the
// Constants its Matcher binds.
//
// NOTE: `value` is what has to hold. It is a RAW JavaScript boolean where a
// Matcher was written — a Matcher's test is a chain of `&&`s, not an Essence
// value — and an Essence Boolean otherwise, which the Rewriter unwraps. The
// `matcher` says which of the two it is looking at.
// NOTE: What `matches snapshot` compares against, once the value itself is an
// ordinary Expression of the assertion — the rendered String. `name` is written
// for a STORED snapshot, kept in the file's `__snapshots__` companion; an inline
// one carries its text in the source, and `recorded` is null until a run has
// written one.
//
// `slot` is a point of the Module's own span table, standing where a recorded
// value stands or would stand — which is what lets `essence test --update` and
// the Editor's "Accept snapshot" write one back without the Compiler.
export type TestSnapshot = {
	name: string | null
	recorded: string | null
	slot: number
}

export interface TestAssertionStatementNode {
	nodeType: "TestAssertionStatement"
	form: "expect" | "require"
	// NOTE: The point the whole asserted Expression stands at, so a failure
	// underlines what was written rather than the keyword.
	point: number
	value: ExpressionNode
	// NOTE: The test half of one `match` Handler — the same shape, so the same
	// emission answers both. `guard` is always null and `body` always empty: an
	// assertion has no arm to fall through to, and what a Guard would say is
	// another `expect` on the next line.
	matcher: MatchHandler | null
	snapshot: TestSnapshot | null
	comparison: TestComparison | null
	position?: Position
}

// NOTE: What the lowering noticed about an assertion whose top-level call is
// `Equatable::is`/`::isNot` — the two operands, named by the points they were
// traced at. The runtime resolves them out of the trace buffer and diffs them,
// so the structural difference is a consequence of the general trace mechanism
// rather than a second capture beside it.
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
	// NOTE: The native Methods that declare a default, each with the frame the
	// Compiler synthesizes for it — see `NativeShimNode` on the typed side. The
	// receiver `_self` is already unshifted onto an instance Method's
	// Parameters, and the name is already `__overload$N`-mangled, exactly as a
	// bodied Method's are.
	nativeShims: Array<NativeShimNode>
	type: NamespaceType
	position?: Position
}

export interface ProtocolDeclarationStatementNode {
	nodeType: "ProtocolDeclarationStatement"
	name: IdentifierNode
	// NOTE: The provided Methods, with `_self` already unshifted onto each and
	// the hidden `Self__conformance` Parameter already appended by the bounded
	// Generic rail — exactly the shape a Namespace's Methods arrive in, which
	// is what lets the Rewriter emit one `$es_<Protocol>__<member>` const per
	// provided Method through the very code that emits an Essence Method.
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
	// NOTE: That the condition ESTABLISHED something — see the typed
	// `IfElseStatementNode`, which is where the Enricher records it. Carried
	// through simplification because `instrument-coverage` reads it and
	// checked refinements are erased before any pass runs.
	narrows: boolean
	// NOTE: And its sister claim, about what the condition established for the
	// branch it answered `false` in. Kept apart from `narrows` for the reason
	// the typed Node keeps them apart: neither implies the other.
	// `instrument-coverage` marks the `else` half's point with it, and
	// `essence test --mutate` reads both before it will swap two bodies.
	//
	// An `if` with no `else` carries `false` here, and that is the honest
	// answer rather than a stand-in: there is no false body, so nothing was
	// ever read under the complement.
	narrowsFalse: boolean
	// NOTE: That `condition` is a RAW JavaScript boolean rather than an Essence
	// Boolean, so the Rewriter emits it as the `if`'s question instead of
	// reading `.value` off it — `lower-matches-to-statements` sets it where the
	// question was lowered to one already. False is the Simplifier's own answer
	// and the ordinary read.
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

export interface FunctionStatementNode {
	nodeType: "FunctionStatement"
	name: IdentifierNode
	value: FunctionDefinitionNode
	position?: Position
}

// #endregion

// #region Statement intrinsics

// NOTE: The Statement half of the intrinsic family, and it exists for one
// reason: JavaScript can say things in a Statement that it can not say in an
// Expression. A Match is an Expression in Essence and its Handlers are
// Statements, so the Rewriter wrapped one in a Function and CALLED it — the
// only Expression that may hold Statements — and a compiled Union dispatch that
// has to hold a value under a name did the same with an arrow, because `let` is
// not an Expression either. Where such an Expression stands in a Statement
// position, none of that is needed: the Statements can simply be written.
//
// NOTE: `lower-matches-to-statements` is the one pass that produces these, and
// what it needs to know is where the ANSWER goes — which is what `result` says.
// Nothing downstream may move one into an Expression position: these are
// Statements, and a Statement is not an Expression here as it is not one in
// JavaScript.
export type IntrinsicStatementNode =
	| StatementMatchNode
	| HeldExpressionNode
	| InlineLoopStatementNode

// NOTE: Where a lowered Expression's answer goes, which is the whole of what the
// Statement position it stood in decides.
export type StatementResult =
	// NOTE: A Return Statement's Expression. Nothing is held and nothing is
	// assigned: a Handler's own Return IS the enclosing Function's Return, which
	// is what the wrapper's Return was standing in for.
	| { kind: "return" }
	// NOTE: A Variable Declaration's initialiser. The declaration is emitted
	// BEFORE the block and left uninitialised, because the name has to outlive
	// the block that computes it — which is also why it is emitted as a `let`
	// where the source said `constant`. Nothing assigns it twice.
	| { kind: "declaration"; name: IdentifierNode }
	// NOTE: An assignment's right-hand side. The name is already bound, so only
	// the assignment is emitted.
	| { kind: "assignment"; name: IdentifierNode }
	// NOTE: A Statement written for its effects. The answer goes nowhere, so
	// what a Handler answered is evaluated and dropped — and where answering it
	// observes nothing, `lower-matches-to-statements` has already taken the
	// Return Statement away.
	| { kind: "discard" }

// NOTE: How the matched value reaches `_self`, the name every Handler reads it
// under — `@` inside a Handler body is that name, and so is the value a
// compiled Type test reads.
export type MatchedValueBinding =
	// NOTE: The value IS `_self` already: the Match's scrutinee is the enclosing
	// Method's receiver, written `match @ -> …`. Nothing is bound and no block
	// is needed at all.
	| { kind: "self" }
	// NOTE: `{ const _self = <value>; … }`. The block is what shadows an
	// enclosing `_self` for the length of the chain, exactly as the wrapper's
	// Parameter did.
	| { kind: "block" }
	// NOTE: `{ const <name> = <value>; { const _self = <name>; … } }`. The value
	// READS `_self` — `match @.item -> …` — and a `const _self` is hoisted over
	// its own initialiser, so reading the enclosing one from the same block is a
	// `ReferenceError`. The read happens in a Scope of its own first.
	| { kind: "held"; name: string }

// NOTE: A Match written as the Statements it always was: the value under a
// name, a chain of `if`s over the Handlers' tests, and each Handler's body where
// the Function body was. The wrapper is gone, and with it the closure a Match
// allocated per evaluation.
//
// NOTE: A Handler's Return Statement means "this is the Match's answer", which
// under the wrapper was a JavaScript Return. It still is where `result` is
// `return`; for every other result the Rewriter writes the answer where it goes
// and leaves the chain — `label` is the labelled block it breaks out of, and it
// is emitted only where something breaks.
export interface StatementMatchNode {
	nodeType: "IntrinsicStatement"
	kind: "statement-match"
	value: ExpressionNode
	binding: MatchedValueBinding
	handlers: Array<MatchHandler>
	// NOTE: The same claim `MatchNode` carries, and `elide-final-match-test`
	// makes it here as well — the pass reads a lowered Match as it reads one
	// that was left alone.
	finalHandlerIsElse: boolean
	result: StatementResult
	label: string
	position?: Position
}

// NOTE: An Expression that has to hold values under names, written as the
// Statements that hold them. A compiled Union dispatch is the one thing that
// does: it evaluates the receiver and the shared Arguments once, before any
// test, and every branch then READS them — which in an Expression position
// costs an arrow called at once with them. In a Statement position the names
// are `const`s of a block, and the arrow is gone.
export interface HeldExpressionNode {
	nodeType: "IntrinsicStatement"
	kind: "held-expression"
	temporaries: Array<DispatchTemporaryNode>
	expression: ExpressionNode
	result: StatementResult
	position?: Position
}

// NOTE: An inlined loop where the Statement position it stands in can simply
// hold it. The Expression form has to wrap the walk in an arrow and call it,
// because a `while` is not an Expression; here the Statements are written where
// they are, and `result` says where the walk's answer goes — exactly as it does
// for a lowered Match.
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
}

export interface ParameterNode {
	nodeType: "Parameter"
	externalName: IdentifierNode | null
	internalName: IdentifierNode
	// NOTE: The simplified `= expression`, lowered by the Rewriter into a
	// JavaScript default parameter — whose semantics are, term for term, the
	// ones the language declares: evaluated per call, only when the Argument
	// was left out, left to right, able to read the Parameters before it.
	defaultValue: ExpressionNode | null
}

export interface ArgumentNode {
	nodeType: "Argument"
	name: string | null
	value: ExpressionNode
}
// #endregion
