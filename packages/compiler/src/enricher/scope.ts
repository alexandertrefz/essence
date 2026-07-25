import type { enricher } from "@essence/interfaces"

// NOTE: A Scope map with NO prototype — `Object.create(null)` rather than `{}`.
// The maps are keyed by names a Program writes, and `{}` inherits
// `Object.prototype`, so a plain index read for `toString`, `valueOf` or
// `constructor` answers with a JavaScript function nobody declared: an
// undeclared name resolves, and a declared one reports as a redeclaration.
// Taking the prototype away is what makes every read on these maps — here, in
// the Enricher's duplicate checks, and anywhere else — answer about
// declarations only, rather than each of them having to remember
// `Object.hasOwn`.
export function scopeMap<Value>(
	entries?: Record<string, Value>,
): Record<string, Value> {
	let map: Record<string, Value> = Object.create(null)

	return entries === undefined ? map : Object.assign(map, entries)
}

// NOTE: A fresh child Scope nested under `parent`, with every map empty — the
// shape every block, body and Handler needs before it seeds its own bindings.
// `overrides` pre-populates the few fields a caller wants set (a seeded `types`
// or `members` map, an `expectedReturnType`) without restating the empty maps.
// A seeded map arrives as an ordinary object literal from its caller, so it is
// re-homed onto a prototype-less one here.
export function childScope(
	parent: enricher.Scope,
	overrides: Partial<enricher.Scope> = {},
): enricher.Scope {
	return {
		...overrides,
		parent,
		members: scopeMap(overrides.members),
		declarations: scopeMap(overrides.declarations),
		constants: overrides.constants ?? new Set(),
		types: scopeMap(overrides.types),
		protocols: scopeMap(overrides.protocols),
	}
}
