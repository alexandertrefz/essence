import * as typed from "./typedNodes"
import * as typedSimple from "./typedSimpleNodes"

export type Cursor = {
	line: number
	column: number
}

export type Position = {
	start: Cursor
	end: Cursor
}

// What a `§§` block says about the Declaration under it. `description` is
// Markdown, and each tagged section is lifted out so it can be shown where it
// belongs.
export type Documentation = {
	description: string
	// The `@param` lines in written order. The first line documents the first
	// Parameter, and so on, so two lines may carry the same name.
	parameters: Array<DocumentationParameter>
	returns: string | null
	// The `@example` blocks, in written order, each of which a test compile
	// runs as a test of its file.
	examples: Array<DocumentationExample>
	// Null for a builtin Namespace documented in TypeScript.
	position: Position | null
}

// One `@param` line. `name` is the label it wrote, or `_`. On a resolved
// signature it is the name a Hover shows: the label, or the internal name in
// place of `_`.
export type DocumentationParameter = {
	name: string
	text: string
	// Where the tag was written, so a Diagnostic can underline it. Absent on a
	// resolved signature. See "Positions under a position key" in DEVELOPMENT.md.
	tag?: { position: Position }
}

// One `§§` line and its span, so an `@example` compiles at the lines it was
// written on.
export type DocumentationLine = {
	text: string
	position: Position
}

// One `@example` block: the lines under the tag, up to the next tag or the
// end of the block.
export type DocumentationExample = {
	lines: Array<DocumentationLine>
	position: Position
	// The `@example` line itself, for a Diagnostic about the whole block.
	tag?: { position: Position }
}

// A written Type annotation and what it resolved to. The typed tree keeps no
// Position for a resolved Type, so the language server reads these instead.
// The enricher collects them on request.
export type TypeAnnotation = {
	position: Position
	type: Type
}

// `information` is a remark about something that is not wrong, such as a tag
// only one test carries. It never fails a build.
export type DiagnosticSeverity = "error" | "warning" | "information"

// `unnecessary` greys code out rather than underlining it, for code that has
// no effect.
export type DiagnosticTag = "unnecessary" | "deprecated"

// An annotated span. A `primary` Label says what is wrong where the
// Diagnostic points. A `secondary` Label points at what that place is judged
// against, such as a declared Type or an unclosed `{`.
export type DiagnosticLabel = {
	position: Position
	message: string
	kind?: "primary" | "secondary"
	// Lower orders render first, for two Labels starting at one place.
	order?: number
}

// `code`, `notes` and `helps` are required, and a positioned Diagnostic
// carries at least one Label. An empty `notes` or `helps` says there is
// nothing more to say.
export type Diagnostic = {
	severity: DiagnosticSeverity
	// A short claim about what is wrong. Types, spans and fixes belong in
	// `labels`, `notes` and `helps`.
	message: string
	// A stable name for the kind of Diagnostic, which Quick Fixes key off, so
	// a message can be reworded freely.
	code: DiagnosticCode
	// Why the rule exists.
	notes: Array<string>
	// What to write instead.
	helps: Array<string>
	tags?: Array<DiagnosticTag>
	// The facts a mechanical Quick Fix needs, so it reads no sentence. See
	// "Diagnostic data" in DEVELOPMENT.md.
	data?: DiagnosticData
} & (
	| {
			// What the language server underlines and deduplicates on. The
			// primary Label repeats it with an explanation.
			position: Position
			labels: [DiagnosticLabel, ...Array<DiagnosticLabel>]
	  }
	// A Diagnostic without a place, such as an internal compiler error with no
	// node to blame, is the only one without Labels.
	| { position: null; labels: [] }
)

// Keyed by `kind`, since several codes share a payload. `unhandled` holds
// `spellMatcher` spellings in declaration order, and `_` for members no Matcher
// can name. `suggestion` holds the bare name, so a Case's renders as `#Add` and
// replaces only `Add`.
export type DiagnosticData =
	| { kind: "missing-case"; unhandled: Array<string> }
	| { kind: "suggestion"; suggestion: string }
	// The bare names of the Cases a value can be wrapped in, such as `Value`
	// for `Optional`. A Choice may hold one Type in several Cases, and each is
	// a different fix.
	| { kind: "holding-case"; caseNames: Array<string> }
	// The display names of the Choices that declare a bare `#Case`, in the
	// order the Helps name them. A name carries Type Arguments only where
	// another candidate applies the same Choice, and never as `<…>`.
	| { kind: "choice-candidates"; names: Array<string> }
	// The `@param` line the first undocumented Parameter is missing, with the
	// name it writes and the last `@param` line, which it goes after. Lines
	// match Parameters by order, so only the first gap can be filled.
	| { kind: "documentation-line"; parameter: string; after: Position }
	// The label a Parameter declares and the one the call wrote, each null
	// where there is none. The language server picks the edit.
	| { kind: "expected-label"; label: string | null; written: string | null }
	// The names a refused `require MATCHER = EXPR` introduced, in written
	// order. The Program holds no node for the refused Statement.
	| { kind: "introduced-names"; names: Array<string> }
	// The members a Record literal lacks, in the order its Type declares them.
	| { kind: "missing-members"; names: Array<string> }
	// A member a Record literal writes that its Type does not declare, and the
	// near miss. The Diagnostic stands at the member's value, so the fix gets a
	// name to find rather than a span.
	| { kind: "record-member"; member: string; suggestion: string }
	// Every requirement the Namespace has not written, not only the first one
	// the check met. A Method the Protocol provides is left out.
	| {
			kind: "missing-requirements"
			protocol: string
			methods: Array<string>
	  }
	// What `value::<Name>method(…)` writes between the angle brackets to pick a
	// candidate alone: a Namespace, or a Protocol for a provided Method.
	| { kind: "namespace-candidates"; names: Array<string> }
	// A Protocol something has to conform to, and the Type Parameter whose
	// declaration would carry the bound, or null where there is none.
	| {
			kind: "required-protocol"
			protocol: string
			parameter: string | null
			import?: ProtocolImport
	  }
	// A bound a Namespace's Type Parameter needs, written on the Method the
	// call stands in rather than on a declaration.
	| {
			kind: "method-bound"
			protocol: string
			parameter: string
			import?: ProtocolImport
	  }
	// A Method's `<…>` entry that names its Namespace's own Type Parameter.
	// The kind names the edit: remove the entry, or drop its `infer` and keep
	// its bound.
	| { kind: "shadowed-type-parameter"; parameter: string }
	| {
			kind: "restated-inferred-parameter"
			parameter: string
			protocol: string
	  }
	// A Declaration of another Module that this one does not import, by that
	// Module's canonical path. The language server works out the specifier.
	| {
			kind: "import-declaration"
			name: string
			modulePath: string
			// Set where the import is only the first edit the Help names, so
			// the fix is offered but not preferred.
			partial?: true
	  }
	// A misplaced Module section and the span of its block, which the Parser
	// dropped.
	| {
			kind: "section-order"
			section: "import" | "export"
			block: Position
	  }
	// A mismatch that a `complete` in front of the value fixes. `unstarted` is
	// a `Future<T>` where `T` was wanted, and `in-flight` a `Started<T>`.
	| {
			kind: "asynchrony-mismatch"
			mismatch: "unstarted" | "in-flight"
	  }
	// A `complete` before a value that is neither a Future nor a Started, which
	// dropping the word fixes wherever it stands.
	| { kind: "not-work" }
	// The Namespace declaring a static Method called as `value::make(…)`, and
	// which rewrite the signature accepts: `Namespace.make(value, …)`, or the
	// call without `value`.
	| {
			kind: "static-owner"
			namespace: string
			acceptsValue: boolean
			acceptsWithoutValue: boolean
	  }
	// The Type Parameter a `where` condition names and the Namespace does not
	// declare, as written.
	| { kind: "undeclared-parameter"; name: string }
	// The Type a `Generatable` conformance would be declared for: the
	// Parameter's own Type as written, not the member the derivation failed on.
	| { kind: "ungeneratable"; typeName: string }
	// A span written in another language's habit and Essence's spelling for
	// it, such as `constant` for `const`. An empty `spelling` deletes, as for a
	// trailing `;`. The span may be narrower than the Diagnostic's.
	| { kind: "essence-spelling"; position: Position; spelling: string }
	// A Method reached with a member's `.`: the span of the `.`, and where
	// `()` goes when none was written. Absent where the call would need an
	// Argument.
	| {
			kind: "method-with-dot"
			separator: Position
			call: Position | null
	  }

// The website documents every code but the experimental test modes'. Quick
// Fixes key off these spellings, so renaming one breaks them.
export type DiagnosticCode =
	// Syntax, from the Lexer and the Parser.
	| "syntax-error"
	| "unexpected-token"
	| "unclosed-string"
	| "unclosed-block"
	| "invalid-number"
	| "mixed-rational-literal"
	| "partial-decimal-literal"
	| "invalid-escape"
	| "unbraced-unicode-escape"
	| "malformed-unicode-escape"
	| "unicode-escape-out-of-range"
	| "surrogate-unicode-escape"
	| "comment-in-hole"
	| "nesting-too-deep"
	| "redundant-parameter-label"
	| "reserved-parameter-label"
	| "shorthand-in-combination"
	| "dictionary-entry-syntax"
	| "shorthand-on-path-key"
	| "empty-path-group"
	| "path-is-members-only"
	| "default-on-function-literal"
	| "case-default-without-payload"
	| "case-payload-is-one-value"
	| "case-application-across-lines"
	| "declarations-outside-stdlib"
	| "overload-function-outside-stdlib"
	| "misplaced-module-section"
	// Habits from other languages.
	| "foreign-syntax"
	| "operator-not-supported"
	// Tests and the `tests { … }` section.
	| "misplaced-tests-section"
	| "test-outside-tests"
	| "expect-outside-test"
	| "expect-not-boolean"
	| "matcher-on-expect"
	| "matcher-after-value"
	| "wildcard-in-require"
	| "literal-in-require"
	| "snapshot-after-matcher"
	| "unknown-modifier"
	| "duplicate-modifier"
	| "malformed-modifier"
	| "skipped-without-reason"
	| "contradictory-modifiers"
	| "duplicate-test-name"
	| "test-failed"
	| "focused-tests-remain"
	| "similar-tags"
	| "lonely-tag"
	| "table-not-written"
	| "table-without-rows"
	| "table-parameters"
	| "table-row-type-mismatch"
	| "snapshot-not-printable"
	| "inline-snapshot-in-table"
	| "property-parameters"
	| "ungeneratable-type"
	| "unreachable-conformance"
	| "ungeneratable-contract"
	| "reserved-suite-name"
	| "contradictory-test-forms"
	| "benchmark-for-any"
	| "snapshot-in-property"
	| "value-comment-outside-tests"
	// Names declared twice, never declared, or not what the position wants.
	| "duplicate-variable"
	| "duplicate-type"
	| "duplicate-protocol"
	| "duplicate-case"
	| "duplicate-method"
	| "duplicate-property"
	| "duplicate-member"
	| "duplicate-type-parameter"
	| "reserved-type-name"
	| "use-before-declaration"
	| "shadowing-after-read"
	| "unknown-name"
	| "default-references-later-parameter"
	| "default-references-own-parameter"
	| "default-references-pattern-binding"
	| "unknown-type"
	| "unknown-protocol"
	| "unknown-member"
	| "type-without-members"
	| "method-called-with-dot"
	// Types: a value that does not fit where it was put.
	| "assignment-type-mismatch"
	| "argument-type-mismatch"
	| "incomplete-record-argument"
	| "argument-label-mismatch"
	| "argument-count-mismatch"
	| "default-type-mismatch"
	| "return-type-mismatch"
	| "condition-not-boolean"
	| "constant-reassignment"
	| "missing-return"
	| "infinite-recursion"
	| "recursive-type-declaration"
	| "top-level-return"
	| "not-a-function"
	| "record-annotation-not-record"
	| "path-step-not-a-record"
	| "path-key-outside-combination"
	| "path-key-without-default"
	| "path-on-computed-value"
	| "uncombinable-types"
	| "wrong-update-brackets"
	| "duplicate-key"
	| "partial-type-mismatch"
	| "wrong-type-argument-count"
	| "type-not-generic"
	| "infer-on-applied-parameter"
	| "uninferred-namespace-parameter"
	| "uninferred-type-parameter"
	| "zero-denominator"
	| "invalid-refinement-predicate"
	| "predicate-not-boolean"
	// Dispatch: which Method, in which Namespace, with which overload.
	| "no-matching-overload"
	| "ambiguous-namespace"
	| "undecided-receiver-type"
	| "unknown-method"
	| "no-namespace-for-value"
	| "not-a-namespace"
	| "picked-requirement"
	| "undispatchable-method"
	| "untyped-namespace-method"
	| "static-method-on-value"
	| "native-property-without-type"
	| "indistinguishable-default-parameter"
	| "ambiguous-overload-default"
	| "fallback-never-used"
	| "redundant-key-check"
	| "ambiguous-nesting-level"
	// Choices and their Cases.
	| "empty-choice"
	| "unknown-case"
	| "ambiguous-case"
	| "missing-payload"
	| "unexpected-payload"
	| "payload-type-mismatch"
	| "unbindable-case-payload"
	| "case-default-not-a-literal"
	| "case-default-on-generic-choice"
	| "recursive-generic-choice"
	| "indistinguishable-union-arms"
	| "undecided-type-arguments"
	// Patterns.
	| "refutable-pattern"
	| "redundant-pattern-binder"
	| "pattern-without-body"
	// Match Expressions.
	| "missing-case"
	| "unreachable-case"
	| "erased-case-conflict"
	| "empty-list-overlap"
	| "empty-dictionary-overlap"
	| "type-argument-overlap"
	| "dispatch-overlap"
	| "refinement-as-matcher"
	| "match-on-non-union"
	| "literal-match-shape"
	// Asynchrony: `start` and `complete`.
	| "complete-outside-future"
	| "unused-future"
	| "unobserved-started"
	| "needless-complete"
	| "needless-start"
	// Define Expressions.
	| "define-without-otherwise"
	| "unreachable-define-arm"
	| "define-without-answer-type"
	| "define-without-cases"
	// Protocols and conformance.
	| "protocol-as-value"
	| "namespace-as-value"
	| "protocol-as-type"
	| "unsatisfied-bound"
	| "interpolation-not-printable"
	| "redundant-interpolation-to-string"
	| "ambiguous-conformance"
	| "nonconforming-namespace"
	| "undeclared-conformance"
	| "conformance-needs-target-type"
	| "default-on-protocol-method"
	| "protocol-bound-function-value"
	| "overloaded-function-value"
	| "protocol-bound-namespace-generic"
	| "shadowed-type-parameter"
	| "restated-inferred-parameter"
	| "unknown-where-generic"
	| "conflicting-where-condition"
	| "unwitnessable-where-condition"
	| "unsatisfied-conformance-condition"
	| "where-on-protocol-extension"
	| "unwritable-provided-method"
	| "recursive-protocol"
	| "incompatible-restatement"
	| "method-not-on-protocol"
	| "provided-method-out-of-reach"
	// Inference the Compiler could not finish.
	| "uninferable-type-parameter"
	| "uninferable-parameter-type"
	| "path-without-context"
	| "uninferable-item-type"
	| "uninferable-return-type"
	| "uninferable-property-type"
	| "missing-return-type"
	// Documentation in `§§` blocks.
	| "missing-documentation-separator"
	| "unknown-documentation-parameter"
	| "misnamed-documentation-parameter"
	| "undocumented-parameter"
	| "nested-example"
	// Modules: specifiers, the files they name, and the graph.
	| "invalid-module-specifier"
	| "module-not-found"
	| "self-import"
	| "not-exported"
	| "unknown-export"
	| "duplicate-import"
	| "export-of-unknown-name"
	| "export-of-variable"
	| "cyclic-constant-import"
	| "cyclic-load-time-use"
	| "cyclic-side-effects"
	| "unused-import"
	| "dependency-has-errors"
	// Reading files and bundling the output.
	| "file-not-found"
	| "not-a-file"
	| "unreadable-file"
	| "bundle-failed"
	| "bundler-warning"
	// The project file, `essence.json`.
	| "unknown-setting"
	| "setting-shape"
	| "moved-setting"
	| "unreadable-project-file"
	// Everything else.
	| "at-outside-method"
	| "at-in-static-method"
	| "internal-error"

export type UnknownType = {
	type: "Unknown"
}

export type ErrorType = {
	type: "Error"
}

export type BooleanType = {
	type: "Boolean"
}

export type StringType = {
	type: "String"
}

export type IntegerType = {
	type: "Integer"
}

export type RationalType = {
	type: "Rational"
}

// An algebraic irrational. The runtime holds the quadratic ones, `a + b·√d`,
// exactly, so they compare exactly.
export type AlgebraicType = {
	type: "Algebraic"
}

// A number that is not algebraic: a rational combination of named
// transcendental constants such as π and e. It is not Comparable, since the
// order of two such numbers can not always be decided.
export type TranscendentalType = {
	type: "Transcendental"
}

// A source of random values, which a property test's runner hands to
// `Generatable::generate`. No Essence code can build one or read what it holds.
export type RandomnessType = {
	type: "Randomness"
}

// A description of work that will answer with a `valueType`. Building one runs
// nothing, and no Essence code can read what it describes. Unlike `List`, it
// has no generic container Type, since no Expression builds an empty Future.
export type FutureType = {
	type: "Future"
	valueType: Type
}

// One run of a Future, already in flight. Each `complete` of it reads the
// same value.
export type StartedType = {
	type: "Started"
	valueType: Type
}

// `name` and `alias` are display names stamped by the Type Alias the Record
// is reached through. See "Display names" in DEVELOPMENT.md.
export type RecordType = {
	type: "Record"
	members: Record<string, Type>
	name?: string
	alias?: {
		name: string
		typeArguments: Array<Type | GenericUse>
	}
}

// The `= { … }` a Case's payload shape carries: the members a construction
// may leave out, and the values that fill them. See "Case payload defaults"
// in DEVELOPMENT.md.
export type CasePayloadDefault = {
	members: ReadonlyArray<string>
	// As `Parameter.defaultNesting`, for a path key in a partial payload.
	nesting: DefaultNesting
	values: Record<string, typed.ExpressionNode> | null
}

// One Case of a Choice, a nominal Record Type. Its members read like a
// Record's, but assignability goes by its Choice and name. A Choice is the
// Union of its Cases.
export type CaseType = {
	type: "Case"
	choice: string
	name: string
	members: Record<string, Type>
	// The Type Parameters of a generic Choice, set on its declared Cases so an
	// application can substitute them into `members`.
	choiceGenerics?: Array<GenericDeclaration>
	// The Type Arguments an application bound, in declaration order, so the
	// Case prints as `<Integer, String>`.
	typeArguments?: Array<Type>
	// Set on every Case of a Choice whose Cases all lack a payload, such as
	// `Ordering`. Such a Case crosses to JavaScript as its bare name. Each Case
	// carries it, since a Case may travel without its siblings.
	unitChoice?: true
	// Never set on a Case of a generic Choice, whose Type Parameters a default
	// can not bind.
	payloadDefault?: CasePayloadDefault
}

export type GenericListType = {
	type: "GenericList"
	generics: [{ name: "ItemType"; defaultType: { type: "Unknown" } }]
}

export type ListType = {
	type: "List"
	itemType: Type
}

// The Dictionary's two slots are read, decided and substituted independently:
// `Dictionary<Unknown, Integer>` has decided its values and not its keys.
export type GenericDictionaryType = {
	type: "GenericDictionary"
	generics: [
		{ name: "KeyType"; defaultType: { type: "Unknown" } },
		{ name: "ValueType"; defaultType: { type: "Unknown" } },
	]
}

export type DictionaryType = {
	type: "Dictionary"
	keyType: Type
	valueType: Type
}

export type Parameter = {
	type: Type | GenericUse
	name: string | null
	// What the Declaration's `§§` block says about this Parameter, for
	// Signature Help.
	documentation?: string
	// Whether a call may leave this Argument out. The default itself stays on
	// the Parameter node, since a Type is compared, cached and serialized.
	hasDefault?: true
	// The members a Record default supplies, sorted, which a Record Argument
	// may leave out. A complete default also sets `hasDefault`. A partial one
	// sets only this, so the Argument is required.
	defaultMembers?: ReadonlyArray<string>
	// The members the default writes as Record literals of their own, which a
	// path key in a partial Argument may reach into.
	defaultNesting?: DefaultNesting
}

// A tree of member names, each written as a Record literal by its default.
// `{ server: { tls: {} } }` lets a caller write `server.port` and
// `server.tls.enabled`.
export type DefaultNesting = { readonly [member: string]: DefaultNesting }

// `documentation` is optional, but `builtins.spec.ts` requires it on every
// standard library Method.
export type BaseFunction = {
	parameterTypes: Array<Parameter>
	generics: Array<GenericDeclaration>
	returnType: Type | GenericUse
	documentation?: Documentation
	// Set on a Method whose whole body is one Boolean call on `@`, maybe
	// negated, such as `List::hasItems` as `@::isEmpty()::negate()`. It is read
	// off the body, so a refinement on the alias and on its target agree.
	predicateAlias?: PredicateAlias
}

export type FunctionType = BaseFunction & {
	type: "Function"
}

export type SimpleMethodType = BaseFunction & {
	type: "SimpleMethod"
}

export type StaticMethodType = BaseFunction & {
	type: "StaticMethod"
}

// A `§§` block on `overload` documents the whole set. Each Overload may
// document itself and falls back to the set's text.
export type OverloadedStaticMethodType = {
	type: "OverloadedStaticMethod"
	overloads: Array<BaseFunction>
	documentation?: Documentation
}

export type OverloadedMethodType = {
	type: "OverloadedMethod"
	overloads: Array<BaseFunction>
	documentation?: Documentation
}

export type MethodType =
	| SimpleMethodType
	| StaticMethodType
	| OverloadedStaticMethodType
	| OverloadedMethodType

export type PrimitiveType =
	| BooleanType
	| StringType
	| IntegerType
	| RationalType
	| AlgebraicType
	| TranscendentalType
	| RandomnessType
	| FutureType
	| StartedType
	| RecordType
	| CaseType
	| ListType
	| DictionaryType
	| FunctionType
	| NamespaceType

export type NamespaceType = {
	type: "Namespace"
	targetType: Type | null
	name: string
	// The name the declaring file wrote, on the copy an import binds under
	// another `name`. A Help that asks for an edit to the Declaration reads it.
	declaredName?: string
	generics: Array<GenericDeclaration>
	properties: Record<string, Type | GenericUse>
	methods: Record<string, MethodType>
	// The identities of the Protocols its `is` clause names.
	conformsTo?: Array<string>
	// The `where` conditions of each conditional conformance, keyed by
	// the Protocol's identity, each naming its Protocol by identity too, as in
	// `{ Comparable: [{ generic: "ItemType", protocol: "Comparable" }] }`.
	// Absent for an unconditional conformance.
	conformanceConditions?: Record<
		string,
		Array<{ generic: string; protocol: string }>
	>
	// The identity of the Protocol that wrote the provided Methods, on the
	// pseudo Namespace a concrete receiver reaches them through. It tells a
	// Protocol from a Namespace at emission, since `name` is the source's.
	providedBy?: string
	// On the pseudo Namespace of a Protocol-bounded receiver, the members
	// that are provided, each under the identity of the Protocol that wrote it.
	providedMembers?: Record<string, string>
}

// Not part of `Type`, since a Protocol is only named as a bound or in an `is`
// clause. Its signatures spell `Self` as a GenericUse of that name.
export type ProtocolType = {
	type: "Protocol"
	// The declared name, which is what a reader is shown.
	name: string
	// What tells two Protocols of one name apart: the declaring Module, the
	// name, and for one declared inside a body, its Position. See
	// `protocolIdentity`.
	identity: string
	// Every requirement and provided Method, its own and those of every
	// Protocol it extends.
	methods: Record<string, MethodType>
	// Which of `methods` carry a body, and the identity of the Protocol
	// that wrote it, this one or an ancestor. A name in here is not a
	// requirement: a conformer that writes nothing still answers it.
	providedMethods?: Record<string, string>
	// For each body this Protocol wrote, the entries of its witness the
	// body reads. A witness of another Protocol may stand in for it where it
	// holds each of them under the same answer.
	providedReads?: Record<string, Array<string>>
	// Every Protocol this one extends, directly or not, by identity.
	conformsTo?: Array<string>
	documentation?: Documentation
}

// `name` and `alias` are display names. See "Display names" in
// DEVELOPMENT.md.
export type UnionType = {
	type: "UnionType"
	types: Array<Type | GenericUse>
	name?: string
	alias?: {
		name: string
		typeArguments: Array<Type | GenericUse>
	}
}

export type GenericName = string

export type GenericDeclaration = {
	name: GenericName
	infer: boolean
	defaultType: Type | null
	// The identity of the Protocol bound of `<infer Item is Comparable>`,
	// null when the Type Parameter is unbounded or its bound named no Protocol.
	constraint?: string | null
	// The Namespace whose conformance gives this witness, for a Protocol pick
	// that chose it. Other conformances of the Type in Scope are not asked.
	witnessFrom?: string
}

export type GenericUse = {
	type: "GenericUse"
	name: GenericName
	// The identity of the bound of a bounded Type Parameter. Method
	// calls on values of this Type resolve through the Protocol.
	constraint?: string
	// Set instead where the written bound names no Protocol, which is
	// reported at the declaration, so nothing asks the Parameter again.
	refusedBound?: true
}

// A generic Type Alias before a use site applies Type Arguments, as in
// `Maybe<Rational>`, which substitutes them into `aliasedType`.
export type GenericAliasType = {
	type: "GenericAlias"
	name: string
	generics: Array<GenericDeclaration>
	aliasedType: Type
}

// One leaf of a refinement's predicate: a Method call on the refined value,
// resolved and stored as a key. See "Predicate conjuncts" in DEVELOPMENT.md.
export type PredicateConjunct = {
	namespaceName: string
	methodName: string
	args: Array<string | boolean>
	negated: boolean
	spelling?: PredicateSpelling
}

export type PredicateSpelling = {
	methodName: string
	args: Array<PredicateSpellingArgument>
}

// One Argument as written, with its label where it had one, so a Diagnostic
// prints a call the reader can write back.
export type PredicateSpellingArgument =
	| string
	| boolean
	| { label: string; value: string | boolean }

// What a Method's body asks, as a template whose slots the call site fills.
// See "Predicate aliases" in DEVELOPMENT.md.
export type PredicateAlias = {
	namespaceName: string | null
	methodName: string
	args: Array<PredicateAliasArgument>
	negated: boolean
}

// A scalar spelled as a conjunct's Arguments are, or the index of a forwarded
// Parameter among the Arguments a caller writes.
export type PredicateAliasArgument =
	| { kind: "Literal"; value: string | boolean }
	| { kind: "Parameter"; index: number }

// A base Type and the predicate its values are proven to satisfy, such as
// `type NonZeroInteger = Integer where @::isNot(0)`. `conjuncts` is null until
// the predicate resolves. See "Refinements" in DEVELOPMENT.md.
export type RefinementType = {
	type: "Refinement"
	name: string
	base: Type
	conjuncts: Array<PredicateConjunct> | null
	typeArguments?: Array<Type>
	// Set on the conjunction a written receiver proves where no declared
	// refinement covers it. No reader declared it, so a report names its base.
	receiverConjunction?: true
}

// How a generic Choice's derived `is` compares each payload member, per Case
// tag. See "Derived equality descriptors" in DEVELOPMENT.md.
export type DerivedEquatableDescriptor = Record<
	string,
	Record<string, DescriptorNode>
>

export type DescriptorNode =
	| { k: "eq" }
	| { k: "w"; i: number }
	| { k: "list"; of: DescriptorNode }
	// Keys and values separately, since either may be the Type Parameter.
	| { k: "dictionary"; key: DescriptorNode; value: DescriptorNode }
	| { k: "record"; m: Record<string, DescriptorNode> }
	| { k: "case"; m: Record<string, DescriptorNode> }
	// A Union-typed member, whose arm is picked by the value's tag and, where
	// two arms share a tag, by `shape`.
	| {
			k: "union"
			arms: Array<{
				tag: string | null
				shape?: Type
				node: DescriptorNode
			}>
	  }

// How one call fulfils a bounded Type Parameter's Protocol. A `namespace`
// source packs the conforming Namespace's Methods into a conformance value,
// and a `parameter` source forwards the enclosing Function's own.
export type ConformanceSource =
	| {
			kind: "namespace"
			name: string
			methodMap: Record<string, string>
			// The provided Methods this conformer does not override, each
			// under the identity of the Protocol whose body answers it. Absent
			// where there are none, so such a witness is a plain object.
			providedMethods?: Record<string, string>
			// For a provided Method whose body reads more than this witness
			// holds, the witness it is curried with. Index 0 is this one, and n is
			// the n-th of `providedWitnesses`.
			curriedWith?: Record<string, number>
			// This conformer's witnesses for the Protocols whose bodies
			// `curriedWith` sends elsewhere, built together with this one.
			providedWitnesses?: Array<ProvidedWitness>
			// The conditions those witnesses take that `conditions` does
			// not hold, so the group solves and builds each condition once.
			groupConditions?: Array<Conformance>
			// The conditions those witnesses take that the group of one of
			// `conditions` or `groupConditions` builds, taken from that group.
			sharedConditions?: Array<SharedCondition>
			// The solved conformances for the Namespace's own `where`
			// conditions, in Generic declaration order, which is the order of
			// the Methods' hidden trailing conformance Parameters.
			conditions: Array<Conformance>
			// Set only for a generic Choice's derived Equatable.
			derivedDescriptor?: DerivedEquatableDescriptor
			// Set only for a Record with a declared member that does not compare
			// or print structurally: the routed member names, in declaration
			// order, matching `conditions`.
			derivedMembers?: Array<string>
			// Set only for a Choice's derived `Enumerable`: the Case tags its
			// Method answers with.
			derivedCases?: Array<string>
	  }
	| { kind: "parameter"; name: string }

// One more witness of a `namespace` source's conformer, for the Protocol
// that wrote a body the source runs. Its `curriedWith` counts as the source's
// does.
export type ProvidedWitness = {
	// The identity of the Protocol the witness is for.
	protocolName: string
	// The Namespace its map reads off: the source's, or the one a Choice
	// derives, with the plan a generic Choice's equality follows.
	name: string
	derivedDescriptor?: DerivedEquatableDescriptor
	methodMap: Record<string, string>
	providedMethods?: Record<string, string>
	curriedWith?: Record<string, number>
	// The conditions curried onto its map, by index into the source's
	// `conditions`, then its `groupConditions`, then its `sharedConditions`.
	conditionIndices: Array<number>
}

// A witness another condition's group builds: that condition's index,
// and the witness's in its group, where 0 is the one the group answers with.
export type SharedCondition = {
	condition: number
	witness: number
}

// The import a bound's fix writes as well, where the file binds no name
// for the Protocol: its declared name and its Module's canonical path.
export type ProtocolImport = {
	name: string
	modulePath: string
}

export type Conformance = {
	genericName: string
	// The identity of the Protocol the witness is for.
	protocolName: string
	source: ConformanceSource
}

// A provided Method an exported Namespace offers a JavaScript host. `type`
// pins `Self` to the Namespace's target, and `conformance` is the witness the
// body is handed.
export type ExposedMethod = {
	name: string
	// The identity of the Protocol whose body answers.
	providedBy: string
	type: SimpleMethodType
	conformance: Conformance
}

// One branch of a Method call on a Union-typed receiver. The receiver's Type
// picks the branch at run time, and each branch is resolved at compile time.
export type DispatchCase = {
	memberType: Type
	namespaceName: string
	overloadedMethodIndex: number | null
	conformances: Array<Conformance>
	// Whether the branch's Method takes a witness Parameter, whatever the call
	// passes, so the validator never treats two such branches as one call. A
	// call that passes too few is refused already, so this is a second guard.
	takesWitnesses: boolean
	// Per branch, since the branches' Methods need not agree on what may be
	// left out.
	omittedParameterIndices: Array<number>
	// A typed copy, per branch, of each Function literal Argument that takes
	// its annotations from the Method it is passed to, by Argument index.
	contextualArguments: Array<{ index: number; argument: typed.ArgumentNode }>
	derivedDescriptor?: DerivedEquatableDescriptor
	derivedMembers?: Array<string>
	// The Protocol that provided this branch's Method, since `namespaceName`
	// declares no Method of that name.
	providedBy?: string
}

export type Type =
	| UnknownType
	| ErrorType
	| PrimitiveType
	| UnionType
	| MethodType
	| GenericListType
	| GenericDictionaryType
	| GenericAliasType
	| GenericUse
	| RefinementType

export { typed, typedSimple }
