import type { enricher } from "../interfaces/index"

// NOTE: A fresh child Scope nested under `parent`, with every map empty — the
// shape every block, body and Handler needs before it seeds its own bindings.
// `overrides` pre-populates the few fields a caller wants set (a seeded `types`
// or `members` map, an `expectedReturnType`) without restating the empty maps.
export function childScope(
	parent: enricher.Scope,
	overrides: Partial<enricher.Scope> = {},
): enricher.Scope {
	return {
		parent,
		members: {},
		declarations: {},
		constants: new Set(),
		types: {},
		protocols: {},
		...overrides,
	}
}
