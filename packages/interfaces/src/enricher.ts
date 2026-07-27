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
	// NOTE: Set on a static Method's body Scope, where `@` means nothing: a
	// static Method is called on the Namespace and is emitted without the
	// receiver Parameter `@` lowers to. It is a BARRIER rather than the mere
	// absence of a binding — an enclosing `@` must not answer through it —
	// while a Match Handler nested inside still binds its own `@` and wins,
	// because that binding sits closer to the use.
	isStaticMethodBody?: boolean
}
