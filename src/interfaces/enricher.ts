import type * as common from "./common/index"

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
	// NOTE: The Type a `<-` in this Scope is expected to produce — set by
	// Function bodies and Match Handler bodies. Bare Case Expressions
	// (`<- #Less`) consult it before falling back to the scope scan.
	expectedReturnType?: common.Type
}
