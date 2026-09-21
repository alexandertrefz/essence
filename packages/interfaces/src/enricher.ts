import type * as common from "./common/index"

// NOTE: A Namespace another Module in the graph exports and this one has not
// imported, under the name that Module exports it as, with the specifier an
// import of it would write. A Namespace has to be imported before a Method can
// dispatch through it, so this is the useful half of "no such Method": which
// Namespace that was never brought in declares the Method being asked for.
export type UnimportedNamespace = {
	name: string
	specifier: string
	namespace: common.NamespaceType
}

// NOTE: One Declaration the Parser dropped, as the Enricher consults it — the
// Parser's own record (`parser.AbandonedDeclaration`) with its two halves of
// hoisting already decided. `hoists` is what says the silence is file-wide
// rather than bounded by `enclosing` and `position`; see `topLevelScope`, which
// is where the language rule behind it is written down.
export type AbandonedDeclaration = {
	name: string
	position: common.Position
	enclosing: common.Position
	hoists: boolean
}

// NOTE: The four positions a `complete` can not be written in, each because of
// something about WHEN the position runs rather than about the word. A
// Parameter's default is filled in by the callee before its own asynchrony
// begins; a test's name is rendered once, before the run, so `--filter` matches
// what a reader sees; a benchmark body is timed over many runs; and a property
// body runs once per generated value. Named so a report can say the one that
// applies.
export type CompletionBarrier =
	| "parameter-default"
	| "test-name"
	| "benchmark-body"
	| "property-body"

export type Scope = {
	parent: Scope | null
	members: Record<string, common.Type>
	// NOTE: Where each name in `members` was declared, so that a Diagnostic
	// about a use can point back at the declaration it is judged against.
	// Names declared by the Compiler itself — the builtin Namespaces, `@` —
	// have no Essence source to point at and are absent here.
	declarations: Record<string, common.Position>
	// NOTE: Names in `members` that are not reassignable — Constants,
	// Functions, Namespaces, Parameters and `@`.
	constants: Set<string>
	// NOTE: What each Constant this Scope declares was given, as the Enricher
	// typed it. Present on a Program's TOP LEVEL Scope alone — a child Scope is
	// built fresh and carries none — because the one reader wants a value that
	// stands wherever the Module does: a Case payload default, which is baked
	// into the Case Type as data and spliced into every construction of it.
	//
	// Written as each Declaration is enriched, so it holds exactly the Constants
	// ABOVE the Statement asking. That is the whole of the ordering rule a
	// payload default lives by, and it is the same rule the emitted Module lives
	// by: a Constant does not hoist.
	//
	// A reader must ask `findDeclaringScope` first and consult the Scope it
	// answers — reading THIS map after resolving a name somewhere else would
	// read past a binding that shadows the Constant.
	constantValues?: Record<string, common.typed.ExpressionNode>
	types: Record<string, common.Type>
	// NOTE: Protocols live beside `types` rather than in them — a Protocol is
	// not a Type, and keeping the maps apart is what lets Type positions
	// reject Protocol names with a dedicated Diagnostic.
	protocols: Record<string, common.ProtocolType>
	// NOTE: The canonical path of the Module whose declarations this Scope
	// holds, which is what a Choice declared in it takes its nominal identity
	// from. Absent — the default — for a Program that is no Module: the standard
	// library and a single file compile name their Choices by name alone. Read
	// through the parent chain, so every body Scope answers with the Module
	// around it.
	modulePath?: string
	// NOTE: Asked on demand rather than handed over as an Array, because only a
	// Diagnostic ever reads it: building the answer walks every dependency's
	// export surface, and a Program with no mistake in it would pay for that per
	// Module and never look. Absent for a Program that is no Module, and read
	// through the parent chain like `modulePath`.
	unimportedNamespaces?: () => Array<UnimportedNamespace>
	// NOTE: The Type a `<-` in this Scope is expected to produce — set by
	// Function bodies and Match Handler bodies. Bare Case Expressions
	// (`<- #Less`) consult it before falling back to the scope scan. Null is a
	// BARRIER rather than the mere absence of one: the search walks outwards,
	// and a Scope whose `<-` belongs to a Function that has no expected return
	// Type yet must not answer with the enclosing Function's.
	expectedReturnType?: common.Type | null
	// NOTE: Whether a `complete` may be written in this Scope, and what it is
	// held to where it may. A Function body Scope carries the Type its
	// Declaration wrote — a completing body's `Future<T>`, and whatever a body
	// that suspends nothing wrote where the word turns up in one anyway; a
	// Program's top level carries `"top-level"`, where a `complete` is the
	// top-level `await` the emitted Module is allowed; and `null` is a position
	// that suspends nothing at all and can not be made to — a Parameter's
	// default, which the emitted callee fills in before its own asynchrony
	// begins, and a test body, whose runner does not await what it runs yet.
	//
	// It is read by walking outwards, like `expectedReturnType`, so a Match
	// Handler and an `if` body inside a completing body answer with that body's
	// Type — and, like it, `null` is a BARRIER rather than a missing answer.
	completing?: common.Type | "top-level" | null
	// NOTE: WHICH barrier a `completing: null` is, set on the same Scope and
	// meaningless anywhere else. There are four of them and they are four
	// different mistakes — a report that listed all four left the reader to work
	// out which one they were in, and the edit that answers each is its own.
	completingBarrier?: CompletionBarrier
	// NOTE: The Namespace this Scope is INSIDE, set on the Scope a Namespace
	// declares its own name into and read through the parent chain — so every
	// signature, property and Method body under it answers with it.
	//
	// Nothing resolves through this: a Namespace's statics are reached as
	// `Namespace.name` inside the Namespace exactly as outside it, and a Method
	// through `@::`. It exists so that a name which resolved to NOTHING can be
	// asked whether the Namespace around it declares one — which is the whole of
	// what `noon` needed to be told, and what it was told `loop` instead.
	namespace?: { name: string; type: common.NamespaceType }
	// NOTE: The Namespace Method whose BODY this Scope is, set on that body's
	// own Scope and read through the parent chain. One Diagnostic reads it: a
	// bound a Namespace's Type Parameter wants can be answered by a `where` on a
	// conformance only when the Method asking fulfils that conformance, and this
	// is what says which Method is asking. Absent everywhere else, including in
	// a Method's signature — the question is only ever asked from a body.
	methodName?: string
	// NOTE: Set on a static Method's body Scope, where `@` means nothing: a
	// static Method is called on the Namespace and is emitted without the
	// receiver Parameter `@` lowers to. It is a BARRIER rather than the mere
	// absence of a binding — an enclosing `@` must not answer through it —
	// while a Match Handler nested inside still binds its own `@` and wins,
	// because that binding sits closer to the use.
	isStaticMethodBody?: boolean
	// NOTE: Set on a Match Handler's body Scope, which is the other thing that
	// binds `@` — the value matched rather than a receiver. Nothing resolves
	// through this either: it exists so that a report about a name which
	// resolved to nothing can say WHICH of the two `@` is here, and offer the
	// one edit that reaches the receiver again from inside a Handler.
	isMatchHandlerBody?: boolean
	// NOTE: The Protocol whose provided Method this Scope is the body of. A
	// provided Method is emitted ONCE, above every Program that reaches it, so
	// a name the Program itself declares — a Constant, a Function, a Namespace
	// — is not in scope where the body lands however plainly it is in scope
	// where the body is written. It is a BARRIER rather than a missing
	// binding: the name resolves, and resolves to something the emitted const
	// can not see, so the walk has to notice that it CROSSED this Scope.
	//
	// Read by the name walk only, and only to report — the Type the name
	// resolves to still stands, so one out-of-reach name reports once instead
	// of cascading through everything written around it.
	providedMethodOf?: string
	// NOTE: The names the emitted PRELUDE binds — every builtin and every
	// standard library Namespace — set on the top level Scope, where they are
	// seeded, and read by nothing but the check above. It has to be recorded
	// separately because the Program's own declarations land in the same
	// `members` table, by design, and a hoisted one leaves no entry in
	// `declarations` to be told apart by.
	//
	// Absent throughout the standard library's OWN load, which is what says
	// "this compilation IS the prelude" — there, a provided Method's body may
	// name whatever its file imports, because all of it is emitted above the
	// Program too.
	preludeNames?: ReadonlySet<string>
	// NOTE: The names a Statement the Parser ABANDONED would have declared, and
	// the text each one's silence covers — see `parser.Recovery` and
	// `declarationWasAbandoned`. Set on the top level Scope and read through the
	// parent chain, by the reports about a name that resolved to nothing and by
	// nothing else: a name whose Declaration was dropped resolves to an Error,
	// silently, so that one syntax error is answered once rather than again at
	// every line that reads what it took away.
	//
	// Absent — the default — for every Program that parsed, which is nearly all
	// of them.
	abandonedDeclarations?: ReadonlyArray<AbandonedDeclaration>
	// NOTE: The names a Parameter's `= expression` default may NOT read, and
	// where each one is written. A default may read `@`, the Parameters to its
	// left and everything the Declaration is written inside; what is barred is
	// the Parameter it is written on, every Parameter after it, and every name a
	// Pattern in the list binds.
	//
	// It is a BARRIER rather than a fallback for names that resolved to nothing,
	// because an outer binding of the same name makes them resolve — and
	// resolve to the wrong thing. `constant x = 5` above `function f(_ x:
	// Integer = x)` types the default as the Constant and emits `(x = x)`, which
	// is the Parameter reading itself out of its own temporal dead zone; the
	// same holds for a Parameter one position to the right, and for a Pattern
	// binding, which is a Constant at the head of the BODY and does not exist
	// while the Parameter list is still being bound.
	//
	// Consulted at the Scope that carries it, ahead of that Scope's own members
	// and behind every Scope inside it — so a Function literal written in a
	// default still sees it, and a binding the literal declares of the same name
	// still shadows it.
	//
	// Set only for the span of one default's enrichment. `index` is the
	// Parameter that default belongs to, which is what tells "the Parameter this
	// is written on" from "one that comes later".
	parameterDefaultBarrier?: {
		names: ReadonlyMap<string, BarredParameterName>
		index: number
	}
	// NOTE: Names that stand for a member of `@` rather than for a binding of
	// their own — what a Matcher's Pattern and payload bindings lend their
	// Guard. A use resolves into the Lookup the author could have written
	// instead, because a Guard is emitted into the Handler's TEST and runs
	// before any Statement of the body: the Constant the body reads the same
	// name through does not exist yet. Reading `@` there is safe regardless,
	// since the Matcher's own check is ANDed in front of the Guard and
	// short-circuits it.
	//
	// `path` is the whole spine from `@` down, so a nested Pattern binding
	// (`case #Going({ state as { index, total } })`) lends `@.state.total`
	// rather than only its last step. A Pattern's `as` binder lends the empty
	// path, which is `@` itself.
	//
	// Only ever consulted on the Scope that DECLARES the name, so an inner
	// binding of the same name shadows the alias like any other.
	selfMemberAliases?: Record<
		string,
		{
			path: Array<string>
			// NOTE: Where each step of `path` was WRITTEN. The Lookup a use
			// lowers to is indexed by the Language Server, so a step given the
			// USE's span instead would be read as an occurrence of that member
			// there — and renaming the member would overwrite the Guard's text.
			stepPositions: Array<common.Position>
			selfType: common.Type
		}
	>
}

// NOTE: One name a Parameter list binds, as a default is allowed to see it.
// `kind` is what the report is about: a Parameter is declared at `index` and is
// either the one the default is written on or one still to come, while a Pattern
// binding is a Constant at the head of the body whatever position it was written
// at.
export type BarredParameterName = {
	kind: "parameter" | "pattern"
	index: number
	position: common.Position
}
