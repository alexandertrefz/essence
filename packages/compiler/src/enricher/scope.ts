import type { enricher } from "@essence-lang/interfaces"

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

// NOTE: The Module a Scope belongs to, answered by the nearest Scope that names
// one — a child Scope inherits nothing, so the walk is what makes a Handler
// body, a Method body and the Program's top level agree on which Module they are
// in. Null for a Program that is no Module.
export function modulePathOf(scope: enricher.Scope): string | null {
	for (
		let current: enricher.Scope | null = scope;
		current !== null;
		current = current.parent
	) {
		if (current.modulePath !== undefined) {
			return current.modulePath
		}
	}

	return null
}

// NOTE: The Namespaces the Module around this Scope could have imported and did
// not, answered by the nearest Scope that knows — the same parent-chain walk
// `modulePathOf` makes, and for the same reason: a Method Invocation deep inside
// a body has to reach what the Module's top level was told. Empty for a Program
// that is no Module, which is every single file compile.
export function unimportedNamespacesOf(
	scope: enricher.Scope,
): Array<enricher.UnimportedNamespace> {
	for (
		let current: enricher.Scope | null = scope;
		current !== null;
		current = current.parent
	) {
		if (current.unimportedNamespaces !== undefined) {
			return current.unimportedNamespaces()
		}
	}

	return []
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

// NOTE: How many Types have been declared anywhere, ever. "Which refinements can
// this Scope see" is memoised per Scope, and the answer changes only when a Type
// is declared into one of the Scopes on the chain — during the hoisting rounds,
// and again while a body that writes its own `type` is enriched. ONE counter
// rather than a version per Scope compared up the chain: a Type declaration is
// rare beside a written receiver, so dropping every answer at one costs less
// than revalidating each of them, and a count that moves too often only ever
// costs a recount.
//
// Every write to a `types` table bumps it — including a DELETE, which is what a
// refinement whose predicate never resolved leaves behind, and including the
// hoist's direct writes, which deliberately go around `declareTypeInScope`.
let typeDeclarations = 0

export function typeDeclarationCount(): number {
	return typeDeclarations
}

export function countTypeDeclaration(): void {
	typeDeclarations += 1
}
