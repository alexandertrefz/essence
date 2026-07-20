import type * as common from "./common/index"

export type Scope = {
	parent: Scope | null
	members: Record<string, common.Type>
	// NOTE: Names in `members` that are not reassignable — Constants,
	// Functions, Namespaces, Parameters and `@`.
	constants: Set<string>
	types: Record<string, common.Type>
}
