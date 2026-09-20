import type { common, enricher } from "@essence-lang/interfaces"

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

// NOTE: The nearest Scope with an answer about asynchrony, which a Scope
// carrying the barrier `null` is — read outwards exactly as `modulePathOf` is,
// and for the same reason: an `if` body and a Match Handler suspend wherever the
// body holding them does.
export function completionContextIn(
	scope: enricher.Scope,
): common.Type | "top-level" | null | undefined {
	for (
		let current: enricher.Scope | null = scope;
		current !== null;
		current = current.parent
	) {
		if (current.completing !== undefined) {
			return current.completing
		}
	}

	return undefined
}

// NOTE: Whether this body ALREADY waits, which is what the Parser's `complete`
// mark says: a completing body answers with its own Future and a Program's top
// level is awaited by the emitted Module. A Parameter's default, a test name, a
// benchmark and a property body are barriers, and a body that declared anything
// else is simply not one.
//
// Not the question a report about a forgotten `complete` asks — which is why
// this is private to the file: `bodyCanWait` below is the one every reporter
// reads, and reaching for this one instead is the mistake it exists to stop.
function bodyWaits(scope: enricher.Scope): boolean {
	let context = completionContextIn(scope)

	return context === "top-level" || context?.type === "Future"
}

// NOTE: The nearest Scope that has an answer about what a `<-` is measured
// against, which a Scope carrying `null` is — a `<-` inside a Function whose own
// return Type is still being worked out has no expected Type, and the enclosing
// Function's is not it.
export function expectedReturnTypeIn(
	scope: enricher.Scope,
): common.Type | null {
	for (
		let current: enricher.Scope | null = scope;
		current !== null;
		current = current.parent
	) {
		if (current.expectedReturnType !== undefined) {
			return current.expectedReturnType
		}
	}

	return null
}

// NOTE: Whether a `complete` written HERE would STAND — the one question every
// report about a forgotten one asks, and the reason each of them can offer the
// word rather than guess. Two ways it stands: the body already waits, or it
// declares `-> Future<…>` and has simply not written its first `complete` yet,
// which is the shape every async body passes through while it is being written.
//
// That second way is the whole difference from `bodyWaits`, and it is the one a
// report meets: a body declaring `-> Future<…>` with nothing completed in it was
// told to "declare the enclosing Function '-> Future<…>'", which its author had
// already done. The Validator asks the same question off its own stack of
// enclosing bodies, in `bodyCanWait` there, and the two answer alike by
// construction — it pushes the DECLARED Type for exactly this reason.
export function bodyCanWait(scope: enricher.Scope): boolean {
	return bodyWaits(scope) || expectedReturnTypeIn(scope)?.type === "Future"
}

// NOTE: The position a barrier belongs to, for the reports that have to name it
// — read off the same Scope the walk above stops at, so the two can not disagree
// about WHICH barrier answered. Null where the context is no barrier at all.
export function completionBarrierIn(
	scope: enricher.Scope,
): enricher.CompletionBarrier | null {
	for (
		let current: enricher.Scope | null = scope;
		current !== null;
		current = current.parent
	) {
		if (current.completing !== undefined) {
			return current.completing === null
				? (current.completingBarrier ?? null)
				: null
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

// NOTE: What the Parser abandoned on the way to this Program — the same
// parent-chain walk `modulePathOf` makes, and for the same reason: a name read
// deep inside a body has to reach what the Program's top level was told.
function abandonedDeclarationsIn(
	scope: enricher.Scope,
): ReadonlyArray<enricher.AbandonedDeclaration> {
	for (
		let current: enricher.Scope | null = scope;
		current !== null;
		current = current.parent
	) {
		if (current.abandonedDeclarations !== undefined) {
			return current.abandonedDeclarations
		}
	}

	return []
}

// NOTE: Whether `cursor` stands inside `span`, inclusive of both ends.
function spanHolds(span: common.Position, cursor: common.Cursor): boolean {
	return notBefore(cursor, span.start) && notBefore(span.end, cursor)
}

function notBefore(cursor: common.Cursor, than: common.Cursor): boolean {
	return (
		cursor.line > than.line ||
		(cursor.line === than.line && cursor.column >= than.column)
	)
}

// NOTE: Whether the Parser abandoned a Declaration of this name that THIS read
// could have seen.
//
// It is the one question every "no such name" report asks before it reports.
// A Declaration the Parser dropped is a Declaration this Program was written
// with, so a read of what it bound is not a mistake the reader made — it is the
// syntax error, once more, one line further down. Answering the read as an
// Error and saying nothing is what keeps one mistake to one Diagnostic.
//
// NOTE: And the read's POSITION is what keeps it to one mistake in the other
// direction. A hoisted Declaration is in scope file-wide, so a dropped one
// silences every read of its name; anything else is in scope inside the block it
// was written in and from its own position down, so a dropped one silences
// exactly the reads it would have answered. A `total` dropped out of one
// Function's body used to silence a genuinely undeclared `total` in the next
// Function along — the syntax error hiding a mistake it did not cause, which is
// the opposite of what reporting everything in one run is for.
export function declarationWasAbandoned(
	scope: enricher.Scope,
	name: string,
	readPosition: common.Position,
): boolean {
	return abandonedDeclarationsIn(scope).some(
		(record) =>
			record.name === name &&
			(record.hoists ||
				(spanHolds(record.enclosing, readPosition.start) &&
					notBefore(readPosition.start, record.position.start))),
	)
}

// NOTE: The same question asked about a MEMBER name — a Method or a static
// Property read off a Namespace, a Protocol or a Union's Cases. It is file-wide
// and deliberately so: a member name is not lexical. A Method dropped out of a
// Namespace's body is read from OUTSIDE that body, everywhere in the file the
// Namespace reaches, so bounding the silence by where the run stood would
// answer every one of those calls as a mistake the reader made.
export function memberDeclarationWasAbandoned(
	scope: enricher.Scope,
	name: string,
): boolean {
	return abandonedDeclarationsIn(scope).some((record) => record.name === name)
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
