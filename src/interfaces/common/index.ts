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

// NOTE: What a `§§` block above a Declaration says about it. `description` is
// Markdown, as the Language Server hands it to the Editor unchanged; the
// tagged sections are lifted out of it so that each can be shown where it
// belongs — a Parameter's text next to that Parameter rather than in one
// undifferentiated blob.
export type Documentation = {
	description: string
	parameters: Record<string, string>
	returns: string | null
	// NOTE: Null for the hand written builtin Namespaces — they document
	// themselves in TypeScript rather than in a `§§` block, so there is no
	// Essence source to point back at.
	position: Position | null
}

export type DiagnosticSeverity = "error" | "warning"

// NOTE: `unnecessary` renders the code greyed out rather than underlined —
// for Diagnostics about code that has no effect instead of code that is
// wrong.
export type DiagnosticTag = "unnecessary" | "deprecated"

// NOTE: An annotated span. A `primary` Label says what is wrong at the place
// the Diagnostic is about; a `secondary` Label points at the declaration that
// place is being judged against — the Type it was declared with, the `{` that
// was never closed — and is what turns a claim into an explanation.
export type DiagnosticLabel = {
	position: Position
	// NOTE: Required. A Label with no message is the bare underline this whole
	// shape exists to replace.
	message: string
	kind?: "primary" | "secondary"
	// NOTE: Lower orders render first. Only worth setting when two Labels
	// start at the same place and the natural order reads backwards.
	order?: number
}

// NOTE: The required fields are the point of this type. `code`, `notes` and
// `helps` are not optional, and a positioned Diagnostic must carry at least
// one Label — the type system, rather than discipline, is what keeps the next
// Diagnostic anyone adds from being a bare sentence over an unannotated
// excerpt. An empty `notes` or `helps` array is a deliberate "there is
// nothing more to say"; a missing one is an oversight, and the two must not
// look alike at a call site. Widening any of this back is how the output
// quietly rots.
export type Diagnostic = {
	severity: DiagnosticSeverity
	// NOTE: A short claim about what is wrong. The Types, the spans and the
	// suggested fix belong in `labels`, `notes` and `helps` — a message that
	// carries them itself renders as one long line above an unannotated
	// source excerpt, which is the shape this exists to avoid.
	message: string
	// NOTE: A stable identifier for the kind of Diagnostic, independent of
	// the message wording — what a Language Server client keys Quick Fixes
	// off, and what lets a message be reworded without breaking them. Every
	// one of them is documented in `docs/diagnostics.md`.
	code: DiagnosticCode
	// NOTE: Context — why the rule exists, what the alternatives were.
	notes: Array<string>
	// NOTE: Action — what to write instead.
	helps: Array<string>
	// NOTE: Situational metadata. Optional because its absence is
	// unambiguous — unlike a missing Label, it costs the reader nothing.
	tags?: Array<DiagnosticTag>
} & (
	| {
			// NOTE: THE place the Diagnostic is about — what the Language
			// Server underlines and what deduplication keys off. The primary
			// Label repeats it with an explanation attached.
			position: Position
			labels: [DiagnosticLabel, ...Array<DiagnosticLabel>]
	  }
	// NOTE: Only a placeless Diagnostic may have no Labels — an Internal
	// Compiler Error with no Node to blame, or a duplicate declaration of a
	// name the Compiler itself declared. The union is what makes that the
	// sole exemption.
	| { position: null; labels: [] }
)

// NOTE: Every Diagnostic carries one, and `docs/diagnostics.md` documents
// every one of these — a code with no entry there is a code nobody can look
// up. Spellings are stable API: reword a message freely, but renaming a code
// breaks the Quick Fixes and the suppressions that are keyed off it.
export type DiagnosticCode =
	// Syntax — the Lexer and the Parser.
	| "syntax-error"
	| "unexpected-token"
	| "unclosed-string"
	| "unclosed-block"
	| "redundant-parameter-label"
	| "declarations-outside-stdlib"
	// Names — declared twice, never declared, or not what the position wants.
	| "duplicate-variable"
	| "duplicate-type"
	| "duplicate-protocol"
	| "duplicate-case"
	| "reserved-type-name"
	| "unknown-name"
	| "unknown-type"
	| "unknown-protocol"
	| "unknown-native-function"
	| "unknown-member"
	| "type-without-members"
	// Types — a value that does not fit where it was put.
	| "assignment-type-mismatch"
	| "argument-type-mismatch"
	| "argument-count-mismatch"
	| "return-type-mismatch"
	| "condition-not-boolean"
	| "constant-reassignment"
	| "missing-return"
	| "top-level-return"
	| "not-a-function"
	| "record-annotation-not-record"
	| "uncombinable-types"
	| "partial-type-mismatch"
	| "wrong-type-argument-count"
	| "type-not-generic"
	| "zero-denominator"
	// Dispatch — which Method, in which Namespace, with which overload.
	| "no-matching-overload"
	| "ambiguous-namespace"
	| "unknown-method"
	| "no-namespace-for-value"
	| "undispatchable-method"
	| "untyped-namespace-method"
	| "native-property-without-type"
	// Choices and their Cases.
	| "empty-choice"
	| "unknown-case"
	| "ambiguous-case"
	| "missing-payload"
	| "unexpected-payload"
	| "payload-type-mismatch"
	// Match Expressions.
	| "missing-case"
	| "unreachable-case"
	| "match-on-non-union"
	// Protocols and conformance.
	| "protocol-as-value"
	| "protocol-as-type"
	| "unsatisfied-bound"
	| "ambiguous-conformance"
	| "nonconforming-namespace"
	| "conformance-needs-target-type"
	| "protocol-bound-function-value"
	| "protocol-bound-namespace-generic"
	| "unknown-where-generic"
	| "conflicting-where-condition"
	| "unwitnessable-where-condition"
	| "unsatisfied-conformance-condition"
	// Inference — what the Compiler could not work out on its own.
	| "uninferable-type-parameter"
	| "uninferable-parameter-type"
	| "uninferable-return-type"
	| "missing-return-type"
	// The Compiler as a program — reading files, bundling the output.
	| "file-not-found"
	| "not-a-file"
	| "unreadable-file"
	| "bundle-failed"
	| "bundler-warning"
	// Everything else.
	| "at-outside-method"
	| "internal-error"

export type UnknownType = {
	type: "Unknown"
}

export type ErrorType = {
	type: "Error"
}

export type NothingType = {
	type: "Nothing"
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

// NOTE: A real algebraic irrational — the quadratic slice `a + b·√d` for now,
// designed to grow to the full set (roots of integer polynomials) without a
// semantic change. Exactly comparable; conforms to Comparable.
export type AlgebraicType = {
	type: "Algebraic"
}

// NOTE: A number that is provably NOT algebraic — rational combinations of π
// for now. Equality is canonical-form equality; deliberately does NOT conform
// to Comparable (deciding `Ordering#Equal` is undecidable in general), though
// the `Number` Namespace hand-writes total cross-member comparisons.
export type TranscendentalType = {
	type: "Transcendental"
}

export type RecordType = {
	type: "Record"
	members: Record<string, Type>
}

// NOTE: One Case of a Choice — a *nominal* Record Type: its members are
// accessed like any Record's, but assignability goes by (choice, name)
// identity rather than by structure. A `choice` declaration manufactures one
// CaseType per Case and names the Union of them.
export type CaseType = {
	type: "Case"
	choice: string
	name: string
	members: Record<string, Type>
}

export type GenericListType = {
	type: "GenericList"
	generics: [{ name: "ItemType"; defaultType: { type: "Unknown" } }]
}

export type ListType = {
	type: "List"
	itemType: Type
}

export type Parameter = {
	type: Type | GenericUse
	name: string | null
	// NOTE: What the Declaration's `§§` block says about this Parameter, so
	// Signature Help can describe the Argument being typed rather than the
	// call as a whole.
	documentation?: string
}

// NOTE: `documentation` is optional in the type, but every builtin Namespace
// Method declared in `src/stdlib/*.es` does carry it — the completion gate in
// builtins.spec.ts fails on any Method that ships without documentation.
export type BaseFunction = {
	parameterTypes: Array<Parameter>
	generics: Array<GenericDeclaration>
	returnType: Type | GenericUse
	documentation?: Documentation
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

// NOTE: The Overloaded kinds are not `BaseFunction`s, so a `§§` block above
// the `overload` keyword documents the set as a whole — each Overload
// separately documents itself, and falls back to the set's text.
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
	| NothingType
	| BooleanType
	| StringType
	| IntegerType
	| RationalType
	| AlgebraicType
	| TranscendentalType
	| RecordType
	| CaseType
	| ListType
	| FunctionType
	| NamespaceType

export type NamespaceType = {
	type: "Namespace"
	targetType: Type | null
	name: string
	generics: Array<GenericDeclaration>
	properties: Record<string, Type | GenericUse>
	methods: Record<string, MethodType>
	// NOTE: Names of the Protocols this Namespace declares conformance to via
	// its `is` clause. Optional so the hand written builtin Namespaces stay
	// valid until they conform.
	conformsTo?: Array<string>
	// NOTE: The `where` conditions of each conditional conformance, keyed by
	// Protocol name — `{ Comparable: [{ generic: "ItemType", protocol:
	// "Comparable" }] }`. Absent for an unconditional conformance. A sibling
	// of `conformsTo` so the builtin tables' plain `conformsTo` stays valid.
	conformanceConditions?: Record<
		string,
		Array<{ generic: string; protocol: string }>
	>
}

// NOTE: Deliberately NOT part of `Type` — a Protocol is not a Type. It is
// only nameable as a Generic bound (`<infer T is Comparable>`) and in a
// Namespace conformance clause (`is Comparable`), which keeps it out of
// every Type position structurally. `Self` appears in its signatures as a
// GenericUse named "Self".
export type ProtocolType = {
	type: "Protocol"
	name: string
	methods: Record<string, MethodType>
	documentation?: Documentation
}

// NOTE: `name` is set on the Union a `choice` declaration creates (and on
// builtins like `Ordering` and `Number`, and non-generic Type Aliases) —
// assignability ignores it entirely, it only gives Diagnostics and Hovers a
// readable name for the Union.
// `alias` is its parameterized sibling, set on the Union an applied Generic
// Alias produces (`Optional<Integer>`). Its Type Arguments are real Types, so
// generic substitution rewrites them alongside the members and the applied
// spelling stays accurate — a plain string name would go stale instead.
// Equally ignored by assignability.
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
	// NOTE: The Protocol bound of `<infer Item is Comparable>` — null when
	// the Type Parameter is unbounded. Optional so the hand written builtin
	// Namespaces stay valid.
	constraint?: string | null
}

export type GenericUse = {
	type: "GenericUse"
	name: GenericName
	// NOTE: Set on the GenericUse registered for a bounded Type Parameter —
	// Method calls on values of this Type resolve through the Protocol.
	constraint?: string
}

// NOTE: The unapplied form of a generic Type Alias — use sites apply Type
// Arguments (`Maybe<Rational>`), which substitutes them into `aliasedType`.
export type GenericAliasType = {
	type: "GenericAlias"
	name: string
	generics: Array<GenericDeclaration>
	aliasedType: Type
}

// NOTE: How a bounded Type Parameter's Protocol requirement is fulfilled at
// one invocation. A `namespace` source packages the conforming Namespace's
// Methods into a conformance value at the call site; a `parameter` source
// forwards the enclosing bounded Function's own conformance parameter.
export type ConformanceSource =
	| {
			kind: "namespace"
			name: string
			methodMap: Record<string, string>
			// NOTE: The recursively solved conformances for this Namespace's
			// own `where` conditions, ordered by its Generic declaration order
			// so they line up with the fulfilling Methods' hidden trailing
			// conformance Parameters. Empty for an unconditional conformance.
			conditions: Array<Conformance>
	  }
	| { kind: "parameter"; name: string }

export type Conformance = {
	genericName: string
	protocolName: string
	source: ConformanceSource
}

// NOTE: One branch of a Method Invocation on a Union-typed receiver. The
// Method is resolved statically for every member Type of the Union — the
// branch to run is picked at runtime by the receiver's actual Type, but each
// branch's Namespace, overload and conformances are fixed at compile time.
export type DispatchCase = {
	memberType: Type
	namespaceName: string
	overloadedMethodIndex: number | null
	conformances: Array<Conformance>
}

export type Type =
	| UnknownType
	| ErrorType
	| PrimitiveType
	| UnionType
	| MethodType
	| GenericListType
	| GenericAliasType
	| GenericUse

export { typed, typedSimple }
