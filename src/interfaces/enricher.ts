import type * as common from "./common/index"

export type Scope = {
	parent: Scope | null
	members: Record<string, common.Type>
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
