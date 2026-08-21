import type {
	BooleanType,
	CaseType,
	Conformance,
	DerivedEquatableDescriptor,
	DispatchCase,
	Documentation,
	ErrorType,
	RationalType,
	FunctionType,
	GenericAliasType,
	IntegerType,
	ListType,
	NamespaceType,
	Position,
	ProtocolType,
	RecordType,
	StringType,
	Type,
	UnionType,
} from "./index"

// #region Program & Sections

export type Program = {
	nodeType: "Program"
	// NOTE: Null for a Program that is no Module, which is every single file
	// compile — and null out of enrichment even where the file wrote both
	// sections, because linking is what attaches them. Whether an entry names
	// something the emitted JavaScript has to bind is an answer only the
	// dependency's export surface holds, and enrichment never sees one of those.
	imports: ImportSectionNode | null
	implementation: ImplementationSectionNode
	// NOTE: Null in every compile that did not ASK for the tests — a build and a
	// run leave the parsed section behind rather than enriching it, so a test
	// costs a shipped Program nothing. Null is therefore no claim that the file
	// wrote none: the Parser's Program is what says that.
	tests: TestsSectionNode | null
	exports: ExportSectionNode | null
	position: Position
}

export type ImplementationSectionNode = {
	nodeType: "ImplementationSection"
	nodes: Array<ImplementationNode>
	position: Position
}

// NOTE: The enriched `tests { … }` block. It is a section of its own rather
// than more Statements of the implementation because only a section can be
// dropped whole — and because what stands in it is graded: an ordinary
// Statement is setup, and the two items are the things a runner registers.
export type TestsSectionNode = {
	nodeType: "TestsSection"
	nodes: Array<TestsNode>
	position: Position
}

export type TestsNode = TestNode | SuiteNode | ImplementationNode

// NOTE: What a test IS, independently of what it is called when it runs. The
// rendered name is worked out per run — an interpolated name says which row it
// ran for — so nothing durable may be keyed on it: a snapshot, a stored
// counterexample, a timing baseline and the Editor's own focus all have to
// survive a name that renders differently every time.
//
// `name` is the TEMPLATE rather than the rendering: the text as written, with
// every interpolation reduced to `{name}` where it names something and `{}`
// where it is worked out. `suitePath` holds the same for every enclosing suite,
// outermost first. A table test appends its row index to this in phase 4.
export type TestIdentity = {
	// NOTE: Null where the Program is no Module, which is every single file
	// compile — two files compiled apart have no path to tell them apart by.
	modulePath: string | null
	suitePath: Array<string>
	name: string
}

// NOTE: `skipped "reason"`, on the item itself or on a suite that covers it.
// The reason is mandatory, so a skip is a TODO the report repeats rather than
// something that rots quietly, and `position` is the Modifier it came from —
// which is an enclosing suite's wherever the test itself wrote none.
export type TestSkip = {
	reason: string
	position: Position
}

// NOTE: `test "name" MODIFIER* { … }`, with the Modifiers already read: what
// they MEAN is settled here so that nothing downstream has to know the
// vocabulary. Every one of them is EFFECTIVE — a suite's covers every test
// inside it — so `focused` and `skipped` and `tags` answer for the item as it
// will run.
export type TestNode = {
	nodeType: "Test"
	identity: TestIdentity
	// NOTE: The name as an Expression, because an interpolated one is worked
	// out where the test runs. `identity.name` is what it was WRITTEN as.
	name: StringValueNode | InterpolatedStringValueNode
	// NOTE: Its own tags and every enclosing suite's, outermost first and
	// without repeats. Where each was written stays in the Parser's tree, which
	// is what the workspace-wide tag Diagnostics read.
	tags: Array<string>
	skipped: TestSkip | null
	// NOTE: Where `focused` was written, on this item or on a suite covering
	// it, and null where it was not.
	focused: Position | null
	body: Array<ImplementationNode>
	keywordPosition: Position
	position: Position
}

// NOTE: `suite "name" MODIFIER* { … }`. It carries the same read Modifiers its
// tests do, so that an Editor can show a whole suite as skipped without
// walking into it.
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

// NOTE: `runtime` says whether this entry names something the emitted
// JavaScript binds. A Type Alias, a Protocol and a Choice erase, and a Case
// needs no binding of its own either — its tag is a String Literal — so an
// entry naming one of them must never reach an emitted ESM list, where it
// would import a name the dependency's JavaScript does not export.
//
// NOTE: `source` is the specifier exactly as it was written, for a reader;
// `modulePath` is the canonical path it resolved to, which is what code
// generation keys a Module on. It is null only where the specifier resolved to
// nothing, which is a Diagnostic the graph reported already.
export type ImportNode = {
	nodeType: "Import"
	name: string
	alias: string | null
	source: string
	modulePath: string | null
	runtime: boolean
	// NOTE: What the entry bound — the member under the local name, or the
	// Type where only a Type came across. It is what a Hover over the entry
	// prints; code generation never reads it.
	type: Type | null
	position: Position
}

export type ExportSectionNode = {
	nodeType: "ExportSection"
	entries: Array<ExportNode>
	position: Position
}

// NOTE: A `source` makes the entry a re-export, forwarding a dependency's name
// without ever binding it in this Module — so `name` is the name the OTHER
// Module publishes and `modulePath` says which one. Both are null on the
// ordinary form, which exports a declaration of this Module's own.
export type ExportNode = {
	nodeType: "Export"
	name: string
	alias: string | null
	source: string | null
	modulePath: string | null
	runtime: boolean
	// NOTE: What the entry publishes, for a Hover — null on a re-export, whose
	// declaration lives in the dependency it forwards.
	type: Type | null
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
	| CaseValueNode

// NOTE: `choice` carries the Choice's Union Type, `caseName` the CaseType —
// so the cursor can land on either half of `ChoiceName#CaseName`. It is null
// for the bare form (`#Add({ … })`). `type` is only ever a CaseType for
// valid Programs; unknown Choices or Cases recover with an Error Type.
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
	// NOTE: The Parameters this call wrote no Argument for, indexed over the
	// callee's FULL signature — the receiver Parameter included, which is the
	// list the Simplifier builds an Argument list against. Empty for every call
	// that omits nothing.
	omittedParameterIndices: Array<number>
	// NOTE: Set only when this call resolves to a *generic* Choice's derived
	// Equatable — the plan its widened runtime helper follows to compare
	// generic payloads through the hidden conformance Arguments. Absent
	// otherwise, so a non-generic Choice's call emits the plain `choiceIs`.
	derivedDescriptor?: DerivedEquatableDescriptor
	// NOTE: Set for Union-typed receivers whose Method resolves per member
	// Type — `namespace` and `overloadedMethodIndex` then hold placeholders,
	// and each case carries its own statically resolved target.
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
	// NOTE: As on a Method Invocation — the Parameters this call left out,
	// indexed over the callee's full signature.
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

export type RecordValueNode = {
	nodeType: "RecordValue"
	declaredType: RecordType | null
	type: RecordType
	members: Record<string, ExpressionNode>
	position: Position
	// NOTE: Where each member's NAME was written, on the levels a dotted key
	// was desugared into and on those alone. `{ c with server.port = 1 }` is
	// enriched as `{ c with server = { c.server with port = 1 } }`, and `port`
	// was spelled at the path's second step — a list the Language Server's
	// lexical walk never sees, since it reads the written AST, where that list
	// does not exist. Absent on a Record somebody wrote, whose keys that walk
	// already carries: a typed member is keyed by name and holds no Position of
	// its own, and inventing one for every Literal would move the shape every
	// snapshot of a typed Program compares.
	memberPositions?: Record<string, Position>
	// NOTE: Set on a level a path key built inside a Literal that is MERGED
	// into a default — an Argument written for a Record Parameter that carries
	// one, or the payload of a Case that does. `{ server.port = 1 }` is
	// enriched as `{ server = { port = 1 } }`, and the inner list is a PARTIAL
	// of the member it stands for: what it does not write is what the default
	// fills in, one level down, exactly as the outer list works one level up.
	//
	// A member written WHOLE carries no such mark and is a replacement, which
	// is the one difference between the two spellings — and the reason the mark
	// exists rather than being read off the shape.
	merged?: true
}

export type StringValueNode = {
	nodeType: "StringValue"
	value: string
	position: Position
	type: StringType
}

// NOTE: The typed form of an interpolated String. Each hole keeps its own
// enriched Expression — real Positions, so the Language Server walks the hole
// as itself — alongside the `Printable` Conformance the Enricher resolved for
// it: the same witness `List::join(with:)` threads for its items, called to
// turn the hole's value into text. The whole node is always a `String`.
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
	type: IntegerType
}

export type RationalValueNode = {
	nodeType: "RationalValue"
	numerator: string
	denominator: string
	position: Position
	type: RationalType
}

export type BooleanValueNode = {
	nodeType: "BooleanValue"
	value: boolean
	position: Position
	type: BooleanType
}

// NOTE: `synthesized` marks a Function literal no source wrote — a member path
// (`.price`), which the Enricher desugars into exactly the literal an author
// could have written instead. Everything downstream of enrichment is meant to
// see an ordinary literal and does; what asks is the Language Server, because
// the Parameter and the name the body reads it under stand at spans the author
// filled with a path and answering over them would name `_0`.
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
	type: ListType
}

export interface LookupNode {
	nodeType: "Lookup"
	base: ExpressionNode
	member: IdentifierNode
	position: Position
	type: Type
	// NOTE: The Protocol that PROVIDED this member, where the base is a
	// Namespace and the name is one a conformance put in reach rather than one
	// the Namespace declares. `Number.isLessThan(a, b)` reads the one const
	// every conformer shares, so the Rewriter has to be told that the member is
	// not a member of the Namespace it is written on.
	providedBy?: string
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
//
// A Handler owns Expressions outside `body`: `literal`, every value in
// `memberLiterals`, and `guard`. A walker that visits only `body` goes blind
// inside `case 1 where …` — `typedHandlerExpressions` in the Language Server's
// `matchHandlerChildren` returns exactly those, in source order.
export interface MatchNode {
	nodeType: "Match"
	value: ExpressionNode
	handlers: Array<{
		matcher: Type
		// NOTE: Where the Matcher was written — `case Integer`, not the whole
		// Handler and not the whole Match. What a Diagnostic about one
		// Handler underlines, and what an editor greys out when the Handler
		// turns out to be dead.
		matcherPosition: Position
		literal: ExpressionNode | null
		memberLiterals: Record<string, ExpressionNode> | null
		// NOTE: What a Case Matcher's payload Pattern requires OF a member,
		// keyed by the dotted spine that reaches it from the matched value.
		// `matcher` describes the ARM — which Case this is — and everything
		// that can make the Handler DECLINE a value the arm accepted lives
		// beside it, exactly as `memberLiterals` does: writing a narrowing into
		// `matcher` instead would tell the Validator the Case is only partly
		// covered AND that the Handler is dead, which are both wrong.
		//
		// Only a Case Matcher needs it. A Pattern in Matcher position IS its
		// own Record Type, so what it requires of a nested member is already in
		// `matcher` and is tested by the same walk.
		memberTypes: Record<string, Type> | null
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
	| ChoiceDeclarationStatementNode
	| IfElseStatementNode
	| IfStatementNode
	| ReturnStatementNode
	| FunctionStatementNode
	| ExpectStatementNode
	| RequireStatementNode

// NOTE: The test half of one `match` Handler, field for field — `matcher` is
// what the value has to BE, and everything that can still decline a value of
// that Type stands beside it. Written out here rather than shared with
// `MatchNode` because an assertion has no arm to fall through to and no body of
// its own, and because a Handler's `guard` has no spelling in an assertion:
// what a Guard would say is another `expect` on the next line.
export interface AssertionMatcherNode {
	matcher: Type
	// NOTE: Where the Matcher was written — the `#Value(row)` of
	// `require #Value(row) = rows::firstItem()`, not the whole assertion —
	// which is what a Diagnostic about the Matcher underlines.
	matcherPosition: Position
	literal: ExpressionNode | null
	memberLiterals: Record<string, ExpressionNode> | null
	// NOTE: What a Case Matcher's payload Pattern requires OF a member, keyed
	// by the dotted spine that reaches it from the asserted value.
	memberTypes: Record<string, Type> | null
}

// NOTE: `expect EXPR`. An `expect` records its result and the test carries on,
// so one test can report several failures at once — and so it can introduce no
// names, which is why `matcher` is always null here and written only by
// `require MATCHER = EXPR`.
export interface ExpectStatementNode {
	nodeType: "ExpectStatement"
	value: ExpressionNode
	matcher: AssertionMatcherNode | null
	position: Position
}

// NOTE: The same shape as `expect` — what differs is what a failure does: a
// `require` ends the test where it stands. That is what makes it the way a
// test takes an Optional or a Choice apart, so the Constants its Matcher binds
// ARE written after it, and everything below reads them.
//
// `value` is a name rather than the asserted Expression wherever a Matcher was
// written: the Matcher's test reads the value as many times as it has parts,
// and a Method Invocation taken apart must run once. The synthesized Constant
// holding it is the Statement written in front of this one, exactly as a
// Pattern Declaration's base is.
export interface RequireStatementNode {
	nodeType: "RequireStatement"
	value: ExpressionNode
	matcher: AssertionMatcherNode | null
	position: Position
}

// NOTE: `synthesized` marks a Constant no source wrote — the base a Pattern
// Declaration reads its members off, and the Constants a Pattern's bindings
// desugar into. It carries a borrowed Position so that Hover, Completion and
// go-to-definition answer over the binder the author DID write; everything
// that reports on a Statement in its own right asks this first. The Simplifier
// keeps that Position even for a base Constant — an unmapped Statement reads
// as Compiler glue to the Debug Adapter, which answers a Step Over there with
// a step OUT and abandons the rest of the body.
export interface ConstantDeclarationStatementNode {
	nodeType: "ConstantDeclarationStatement"
	name: IdentifierNode
	value: ExpressionNode
	position: Position
	headPosition: Position
	declaredType: Type | null
	type: Type
	documentation: Documentation | null
	synthesized?: "base" | "binding"
}

// NOTE: `synthesized` means the same here as on a Constant — a Statement no
// source wrote. Only `"binding"` occurs: a Pattern's base is always a Constant,
// even under `variable`, because the value it holds is evaluated once and never
// assigned to again; only the names the Pattern binds follow the Declaration's
// own keyword.
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
	// NOTE: Where the assigned Variable was declared, carried over from the
	// Scope the Enricher resolved the name in — the Validator, which is what
	// rejects a mismatched value, no longer has that Scope. Null when the
	// Variable is a builtin or was never declared at all.
	declarationPosition: Position | null
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

// NOTE: `overloadIndices` says where each entry of `methods` sits in the
// Method TYPE's `overloads` array — parallel to `methods`, one entry each.
// The two are usually the identity, and differ exactly when the Method Type
// holds Overloads this Node does not: a `declarations { … }` block may bind
// some Overloads to the runtime and write others in Essence, and only the
// latter have a body to enrich or emit.
//
// INVARIANT: the `__overload$N` suffix is ALWAYS derived from the position in
// the Method Type's `overloads` array, never from a position in `methods`.
// A call site resolves its `overloadedMethodIndex` against the full Type, so
// an Overload emitted under a filtered index would answer to a name nobody
// calls — and would overwrite the native runtime export that legitimately
// owns that name.
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
	// NOTE: The Namespace's own Type Parameters, carried as typed Nodes so that
	// the cursor can land on one. `type.generics` says the same thing without
	// Positions, which is why both exist.
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
	// NOTE: The native Methods of this Namespace that declare a default, and
	// nothing else — a native has no body to enrich, so these carry their
	// Parameter list alone. See `NativeShimNode`.
	nativeShims: Array<NativeShimNode>
	position: Position
	headPosition: Position
	type: NamespaceType
	documentation: Documentation | null
}

// NOTE: A native Method that declares a default needs a FRAME for the default to
// be evaluated in, and the native calling convention has nowhere to put one: a
// native takes exactly the Parameters its declaration does, with no default and
// no rest Parameter, and `nativeArity` pins that under `tsc` while
// `builtins.spec.ts` checks the runtime export's own `.length` against it — a
// JavaScript default parameter stops `Function.length`, so the native can not
// carry one. Asking the runtime to implement the default instead would spell one
// default twice, once in `.es` as documentation and once in `.ts` as behaviour,
// with nothing checking that they agree.
//
// So the Compiler synthesizes the frame: a top-level const beside the prelude's
// Essence-implemented members that takes the default and hands everything on to
// the native.
//
//   const $es_String_trim = (_self, side = "BothEnds") => String.trim(_self, side)
//
// ONLY a call site that actually leaves an Argument out names it. A call that
// writes every Argument emits byte-identically to what it always did — a direct
// read off the imported runtime module, tree-shakeable exactly as before — and
// the generated native contract does not change at all. The Essence-side default
// stays the single source of truth, and the runtime never learns that defaults
// exist.
export interface NativeShimNode {
	nodeType: "NativeShim"
	memberName: string
	// NOTE: The entry's slot in an `overload` block, which is what the emitted
	// name is mangled with — the Simplifier does the mangling, here as
	// everywhere. Null for a Method that is not overloaded.
	overloadIndex: number | null
	isStatic: boolean
	parameters: Array<ParameterNode>
}

export interface ProtocolDeclarationStatementNode {
	nodeType: "ProtocolDeclarationStatement"
	name: IdentifierNode
	protocolType: ProtocolType
	// NOTE: The Protocols this one extends, as written — one entry per `is`
	// clause, so the cursor can land on an ancestor's name. `protocolType`
	// carries the transitive set without Positions.
	conformsTo: Array<{ name: string; position: Position }>
	// NOTE: The PROVIDED Methods' bodies, enriched. `@` is typed as `Self`
	// bounded by this Protocol, so the body may only call what the Protocol's
	// own surface holds, and the hidden conformance Parameter the bound emits
	// is what the calls inside dispatch through. A Protocol with no provided
	// Method carries an empty record and emits nothing at all.
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
	// NOTE: A checked refinement's predicate, enriched — `@::isNot(0)` with `@`
	// typed as the base. This is the ONE place the typed Expression is kept: the
	// Type carries the conjunct KEYS the Compiler compares, and keeping the
	// Expression out of it is what keeps `conformanceKey` and its memo keys the
	// size they were. Null for every ordinary Alias, and for a refinement whose
	// clause was refused — a Diagnostic said so, and the Alias means its base.
	//
	// NOTE: Nothing downstream of the Enricher reads it — a Type Alias erases to
	// nothing at all, so the simplified mirror carries no predicate — it is here
	// for the Language Server, which reads the typed tree to answer about the
	// text a reader's cursor sits on.
	predicate: ExpressionNode | null
	position: Position
	documentation: Documentation | null
}

// NOTE: Each Case keeps its name as a typed Identifier of its own (typed as
// its CaseType), so the cursor can land on it. `type` is what the Choice's name
// resolves to in Type position — the named Union of all Cases for a plain
// Choice, or the Generic Alias over the anonymous Union of them for a generic
// one.
export interface ChoiceDeclarationStatementNode {
	nodeType: "ChoiceDeclarationStatement"
	name: IdentifierNode
	// NOTE: As on a Namespace — the Type Parameters as typed Nodes, so the
	// cursor can land on one. `type` carries them without Positions.
	generics: Array<GenericDeclarationNode>
	// NOTE: `defaultValue` is the enriched `= { … }` a Case's payload shape may
	// carry — the Expression itself, so the Validator walks it and a Language
	// Server that reads the typed tree finds it where the Parser's is.
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

// NOTE: `narrows` says that the condition ESTABLISHED something — that the true
// branch is a doorway, entered with a binding refined to a Type the code above
// it does not have. It is recorded by the Enricher, which is the only stage that
// knows: what a branch narrows is read off the typed condition, and checked
// refinements are erased before the Optimiser sees a Program at all. Coverage
// reads it, so that "the guarded path and the fallback were each reached" is a
// question a report can ask of the branches where it means something.
export interface IfElseStatementNode {
	nodeType: "IfElseStatement"
	condition: ExpressionNode
	narrows: boolean
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

// NOTE: A null `internalName` is the `_: Type` form — see the Parser's
// ParameterNode. It survives into the typed tree so that nothing downstream
// mistakes the Parameter for one the body could have referenced; the
// Simplifier is where it finally gets a positional placeholder to emit.
export interface ParameterNode {
	nodeType: "Parameter"
	externalName: IdentifierNode | null
	internalName: IdentifierNode | null
	position: Position
	// NOTE: What the Parameter is bound to. `internalName` carries it too, but
	// only where the source wrote one — `_: Options` binds no name and still has
	// a Type, and the Simplifier needs it to rebuild a Record-defaulted
	// Parameter member by member at the callee's entry.
	type: Type
	// NOTE: Set only when the Parameter wrote no `: Type` and took one from
	// the expected signature. Null means the Type is written in the source,
	// where showing it again would be noise.
	inferredType: Type | null
	// NOTE: The enriched `= expression`. It is here rather than only on the
	// Parser's node because the Simplifier lowers it into a JavaScript default
	// parameter, and because the Language Server's typed walkers — rename,
	// call hierarchy — have to be able to reach a Method Invocation written
	// inside one.
	defaultValue: ExpressionNode | null
}

export interface GenericDeclarationNode {
	nodeType: "GenericDeclaration"
	name: string
	defaultType: Type | null
	inferred: boolean
	constraint: string | null
	position: Position
}

export interface FunctionDefinitionNode {
	nodeType: "FunctionDefinition"
	generics: Array<GenericDeclarationNode>
	parameters: Array<ParameterNode>
	body: Array<ImplementationNode>
	returnType: Type
	// NOTE: Set only when no `-> Type` was written, mirroring a Parameter's
	// `inferredType`. `returnType` is the Type either way; this says whether
	// the source shows it.
	inferredReturnType: Type | null
	// NOTE: Where an omitted `-> Type` would have gone, for the Inlay Hint.
	parameterListPosition: Position
	// NOTE: The signature as written — from the Type Parameter list, or the `(`
	// where there is none, to the end of the return annotation. What Hover
	// anchors a Method or a Function literal to, so that the cursor on a blank
	// line in its body is answered by nothing rather than by the whole thing.
	headPosition: Position
}

export interface ArgumentNode {
	nodeType: "Argument"
	name: string | null
	value: ExpressionNode
	type: Type
}
// #endregion
