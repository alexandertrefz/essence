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

// NOTE: Every Expression and Statement carries the `position` of the typed
// node it was simplified from, so code generation can map what it emits back
// onto the source. It is optional because the Simplifier also synthesizes
// nodes no source was written for — a Nothing-returning function's trailing
// Return, a conformance witness — and those stay unset, which emits no
// mapping.
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
	| IntrinsicNode

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

export interface NativeFunctionInvocationNode {
	nodeType: "NativeFunctionInvocation"
	name: IdentifierNode
	arguments: Array<ArgumentNode>
	type: Type
	position?: Position
}

export interface FunctionInvocationNode {
	nodeType: "FunctionInvocation"
	name: ExpressionNode
	arguments: Array<ArgumentNode>
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
	// NOTE: Present only when this call is a *generic* Choice's derived
	// Equatable — the Rewriter then emits `$helpers.boundChoiceIs(<descriptor>)`
	// in place of the plain `choiceIs` member read.
	derivedDescriptor?: DerivedEquatableDescriptor
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
	// NOTE: Present only when this branch resolves to a *generic* Choice's
	// derived Equatable — the Rewriter then emits
	// `$helpers.boundChoiceIs(<descriptor>)` for the branch's Method.
	derivedDescriptor?: DerivedEquatableDescriptor
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

export interface LookupNode {
	nodeType: "Lookup"
	base: ExpressionNode
	member: IdentifierNode
	type: Type
	position?: Position
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
	guard: ExpressionNode | null
	body: Array<ImplementationNode>
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
	| PooledReferenceNode

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
export interface TagTestNode {
	nodeType: "Intrinsic"
	kind: "tag-test"
	value: ExpressionNode
	tag: string
	negated: boolean
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

// NOTE: Two Records combined in one allocation — `{ ...lhs, member: … }`, where
// `Object.assign({}, lhs, rhs)` built an empty object and copied both into it.
// The hidden Type key rides along on the spread of `lhs`, which carries it like
// any other of its own keys.
//
// The right-hand side is written out MEMBER BY MEMBER when it is a Record
// literal, which is what `{ base with x = 1 }` spells and the Record it would
// have built never exists. Any other right-hand side — a name, a call — is
// spread as a whole. As with a Case's payload, exactly one of the two is set.
export interface SpreadCombinationNode {
	nodeType: "Intrinsic"
	kind: "spread-combination"
	lhs: ExpressionNode
	members: Record<string, ExpressionNode>
	rhs: ExpressionNode | null
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
	type: NamespaceType
	position?: Position
}

export interface ProtocolDeclarationStatementNode {
	nodeType: "ProtocolDeclarationStatement"
	name: IdentifierNode
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
