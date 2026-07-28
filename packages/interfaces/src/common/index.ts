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
	// NOTE: The `§§` line each `@param` was written on, keyed by the name it
	// wrote — what lets the Enricher underline the tag itself rather than the
	// whole block when the name matches no Parameter. Absent when the block
	// writes no `@param`, and stripped for the standard library exactly as
	// `position` is. The Position is nested under a field of that name so that
	// the Formatter's AST comparison, which drops every `position`, keeps
	// dropping this one too.
	parameterTags?: Record<string, { position: Position }>
}

// NOTE: One written Type annotation, paired with what it resolved to. The
// typed AST ERASES annotations — a resolved Type carries no Position — so
// this is the only record that a Type was written at a particular place, and
// the only way the Language Server can answer for the cursor sitting on one.
// Collected by the Enricher on request; see `src/enricher/annotations.ts`.
export type TypeAnnotation = {
	position: Position
	type: Type
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
	// NOTE: The facts a Quick Fix needs, in a form it does not have to read
	// out of a sentence. Set by the few Diagnostics whose fix is mechanical
	// and absent everywhere else — a Quick Fix keys off `code` first and only
	// then asks for the payload that code implies.
	//
	// Re-deriving these in the Language Server was rejected twice over: the
	// unhandled members of a Match are the output of the exhaustiveness
	// algorithm, which would have to be written a second time and kept in step
	// with this one, and a near miss is only recoverable from the Help that
	// names it — whose wording this file explicitly reserves the right to
	// change. A Quick Fix built on either would break silently.
	data?: DiagnosticData
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

// NOTE: Keyed by `kind` rather than by the Diagnostic's code, because several
// codes carry the same payload — every "did you mean" is one `suggestion`,
// whichever kind of name was misspelled. `unhandled` holds `describeType`
// spellings in declaration order, which is the order the Cases are written
// in; `suggestion` holds the bare name, so the Case one renders as `#Add` and
// replaces only `Add`.
export type DiagnosticData =
	| { kind: "missing-case"; unhandled: Array<string> }
	| { kind: "suggestion"; suggestion: string }

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
	| "invalid-number"
	| "invalid-escape"
	| "redundant-parameter-label"
	| "declarations-outside-stdlib"
	| "overload-function-outside-stdlib"
	| "misplaced-module-section"
	// Names — declared twice, never declared, or not what the position wants.
	| "duplicate-variable"
	| "duplicate-type"
	| "duplicate-protocol"
	| "duplicate-case"
	| "duplicate-method"
	| "duplicate-property"
	| "duplicate-member"
	| "reserved-type-name"
	| "use-before-declaration"
	| "unknown-name"
	| "unknown-type"
	| "unknown-protocol"
	| "unknown-native-function"
	| "unknown-member"
	| "type-without-members"
	// Types — a value that does not fit where it was put.
	| "assignment-type-mismatch"
	| "argument-type-mismatch"
	| "argument-label-mismatch"
	| "argument-count-mismatch"
	| "return-type-mismatch"
	| "condition-not-boolean"
	| "constant-reassignment"
	| "missing-return"
	| "infinite-recursion"
	| "recursive-type-declaration"
	| "top-level-return"
	| "not-a-function"
	| "record-annotation-not-record"
	| "uncombinable-types"
	| "partial-type-mismatch"
	| "wrong-type-argument-count"
	| "type-not-generic"
	| "infer-on-applied-parameter"
	| "uninferred-namespace-parameter"
	| "zero-denominator"
	// Dispatch — which Method, in which Namespace, with which overload.
	| "no-matching-overload"
	| "ambiguous-namespace"
	| "undecided-receiver-type"
	| "unknown-method"
	| "no-namespace-for-value"
	| "not-a-namespace"
	| "undispatchable-method"
	| "untyped-namespace-method"
	| "static-method-on-value"
	| "native-property-without-type"
	// Choices and their Cases.
	| "empty-choice"
	| "unknown-case"
	| "ambiguous-case"
	| "missing-payload"
	| "unexpected-payload"
	| "payload-type-mismatch"
	| "unbindable-case-payload"
	| "recursive-generic-choice"
	| "indistinguishable-union-arms"
	| "undecided-type-arguments"
	// Match Expressions.
	| "missing-case"
	| "unreachable-case"
	| "erased-case-conflict"
	| "empty-list-overlap"
	| "match-on-non-union"
	// Protocols and conformance.
	| "protocol-as-value"
	| "protocol-as-type"
	| "unsatisfied-bound"
	| "interpolation-not-printable"
	| "redundant-interpolation-to-string"
	| "ambiguous-conformance"
	| "nonconforming-namespace"
	| "conformance-needs-target-type"
	| "protocol-bound-function-value"
	| "overloaded-function-value"
	| "protocol-bound-namespace-generic"
	| "unknown-where-generic"
	| "conflicting-where-condition"
	| "unwitnessable-where-condition"
	| "unsatisfied-conformance-condition"
	// Inference — what the Compiler could not work out on its own.
	| "uninferable-type-parameter"
	| "uninferable-parameter-type"
	| "uninferable-item-type"
	| "uninferable-return-type"
	| "missing-return-type"
	// Documentation — the `§§` blocks above Declarations.
	| "missing-documentation-separator"
	| "unknown-documentation-parameter"
	// Modules — the specifier, the file it names, and the graph they form.
	| "invalid-module-specifier"
	| "module-not-found"
	| "self-import"
	| "not-exported"
	| "unknown-export"
	| "duplicate-import"
	| "export-of-unknown-name"
	| "export-of-variable"
	| "cyclic-constant-import"
	| "cyclic-side-effects"
	| "unused-import"
	| "dependency-has-errors"
	// The Compiler as a program — reading files, bundling the output.
	| "file-not-found"
	| "not-a-file"
	| "unreadable-file"
	| "bundle-failed"
	| "bundler-warning"
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
	// NOTE: Set on the declared Cases of a *generic* Choice — the Type
	// Parameters the Choice abstracts over, so an application can substitute
	// them into `members` and stamp the applied spelling. Absent on every
	// non-generic Choice's Cases, which keeps their identity through
	// substitution and matchTypes' `lhs === rhs` fast path.
	choiceGenerics?: Array<GenericDeclaration>
	// NOTE: Set on an *instantiated* Case — the Type Arguments an application
	// bound, in declaration order — so the Case prints its `<Integer, String>`
	// and later substitutions rewrite the spelling alongside the members. The
	// mirror of a Union alias' `typeArguments`.
	typeArguments?: Array<Type>
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
// Method declared in `packages/stdlib/sources/*.es` does carry it — the completion gate in
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
// Alias produces (`Labelled<Integer>` for a `type Labelled<T> = T | String`). Its Type Arguments are real Types, so
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

// NOTE: The compile-time plan a *generic* Choice's derived Equatable follows
// at runtime — one entry per Case tag, mapping each payload member's name to
// how that member is compared. A member mentioning no Type Parameter compares
// structurally (`eq`); a bare Type Parameter routes through the witness at
// index `i` — the payload-mentioned Type Parameters in declaration order, so
// the index lines up with the hidden conformance Arguments the same order
// produces; composites recurse. Emitted as a plain object literal the runtime
// `boundChoiceIs` interprets, so a *non-generic* Choice — which carries none —
// keeps emitting the byte-identical `choiceIs` with no descriptor at all.
export type DerivedEquatableDescriptor = Record<
	string,
	Record<string, DescriptorNode>
>

export type DescriptorNode =
	| { k: "eq" }
	| { k: "w"; i: number }
	| { k: "list"; of: DescriptorNode }
	| { k: "record"; m: Record<string, DescriptorNode> }
	| { k: "case"; m: Record<string, DescriptorNode> }
	// NOTE: A Union-typed payload member — its arms are claimed at runtime by
	// the value's `typeKeySymbol` tag, and the generic arm (`tag: null`)
	// catches everything no arm claims, so `T | Nothing` compares a Nothing
	// structurally and a `T` through its witness.
	//
	// NOTE: A tag says which KIND a value is, not which Type — every Record
	// carries "Record", every List "List" — so where two arms share one, the
	// tag alone claims the wrong values. `shape` is the arm's Type as the
	// runtime can check it (`$type.isValueOfType`, the same check a Match
	// narrows with), and it is carried by exactly the arms that need telling
	// apart: `{ code: Integer }` claims the Records that have an Integer
	// `code`, and a `T` bound to `{ name: String }` keeps the rest. Arms are
	// ordered most specific first, so an Argument that is a strict refinement
	// of a concrete arm claims its own values before that arm does.
	| {
			k: "union"
			arms: Array<{
				tag: string | null
				shape?: Type
				node: DescriptorNode
			}>
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
			// NOTE: Set only when this source is a *generic* Choice's derived
			// Equatable — the plan its widened runtime helper interprets to
			// compare generic payloads through the conditions' witnesses. Absent
			// for every written Namespace and every non-generic Choice, which
			// keeps their witness emission byte-identical.
			derivedDescriptor?: DerivedEquatableDescriptor
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
	// NOTE: The Arguments this branch alone is given, each under the position
	// in the Invocation's own Argument list it stands in for. A Function
	// literal that omitted its annotations takes them from the Method it is
	// passed to, and every branch passes it to a different Method, so ONE
	// compiled literal can not be what all of them meant — the Enricher builds
	// a typed copy per branch instead. Empty for every Argument that does not
	// react to its context, which is every Argument but such a literal, so a
	// dispatch that passes none is emitted exactly as it was before.
	contextualArguments: Array<{ index: number; argument: typed.ArgumentNode }>
	// NOTE: Set only when this branch resolves to a *generic* Choice's derived
	// Equatable — the plan its widened runtime helper follows. Absent
	// otherwise, so a non-generic Choice's dispatch branch emits the plain
	// `choiceIs` unchanged.
	derivedDescriptor?: DerivedEquatableDescriptor
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
