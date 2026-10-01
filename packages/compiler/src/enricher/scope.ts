import type { common, enricher } from "@essence-lang/interfaces"

// A Scope map without a prototype, so a read answers about declarations only.
// On a `{}`, a name such as `toString` would find an inherited function.
export function scopeMap<Value>(
	entries?: Record<string, Value>,
): Record<string, Value> {
	let map: Record<string, Value> = Object.create(null)

	return entries === undefined ? map : Object.assign(map, entries)
}

// The Module a Scope belongs to, from the nearest Scope that names one. Null
// for a Program that is no Module.
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

// The nearest Scope's answer about asynchrony; a barrier is `null`. An `if`
// body or a Match Handler suspends wherever its enclosing body does.
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

// Whether this body already waits: a completing body answers with its own
// Future, and the emitted Module awaits a Program's top level. A report about
// a forgotten `complete` asks `bodyCanWait` instead, so this stays private.
function bodyWaits(scope: enricher.Scope): boolean {
	let context = completionContextIn(scope)

	return context === "top-level" || context?.type === "Future"
}

// What a `<-` is measured against, from the nearest Scope that says. `null`
// stops the walk: while a Function's return Type is inferred, the enclosing
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

// Whether a `complete` written here would stand: the body already waits, or
// it declares `-> Future<…>` and has no `complete` yet. Every report about a
// forgotten `complete` asks this. The validator's `bodyCanWait` answers alike,
// from the declared Types it pushes.
export function bodyCanWait(scope: enricher.Scope): boolean {
	return bodyWaits(scope) || expectedReturnTypeIn(scope)?.type === "Future"
}

// The barrier that answered, for the reports that name it. It is read off the
// Scope `completionContextIn` stops at, so the two agree. Null where the
// context is no barrier.
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

// The Namespaces the Module could have imported and did not, from the nearest
// Scope that knows. Empty for a Program that is no Module.
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

// The registry of every Protocol the compile declared, from the nearest
// Scope that carries one.
export function protocolRegistryOf(
	scope: enricher.Scope,
): Map<string, common.ProtocolType> | null {
	for (
		let current: enricher.Scope | null = scope;
		current !== null;
		current = current.parent
	) {
		if (current.protocolRegistry !== undefined) {
			return current.protocolRegistry
		}
	}

	return null
}

export function registerProtocol(
	scope: enricher.Scope,
	protocol: common.ProtocolType,
): void {
	protocolRegistryOf(scope)?.set(protocol.identity, protocol)
}

// A registry holding the Protocols a new top level Scope already binds,
// which are the builtins.
export function protocolRegistryFor(
	protocols: Record<string, common.ProtocolType>,
): Map<string, common.ProtocolType> {
	return new Map(
		Object.values(protocols).map((protocol) => [
			protocol.identity,
			protocol,
		]),
	)
}

// The Modules this one reaches that declare a Protocol of this name, asked
// of the nearest Scope that knows. Empty for a Program that is no Module.
export function protocolDeclarationsOf(
	scope: enricher.Scope,
	name: string,
): Array<enricher.ProtocolDeclaration> {
	for (
		let current: enricher.Scope | null = scope;
		current !== null;
		current = current.parent
	) {
		if (current.protocolDeclarations !== undefined) {
			return current.protocolDeclarations(name)
		}
	}

	return []
}

// Whether the Module's own Scope, which an import binds into, binds this
// name already, so that an import under it would be refused. False for a
// Program that is no Module.
export function moduleBindsName(scope: enricher.Scope, name: string): boolean {
	for (
		let current: enricher.Scope | null = scope;
		current !== null;
		current = current.parent
	) {
		if (current.protocolDeclarations !== undefined) {
			return (
				Object.hasOwn(current.members, name) ||
				Object.hasOwn(current.types, name) ||
				Object.hasOwn(current.protocols, name)
			)
		}
	}

	return false
}

// The Declarations the parser abandoned in this Program, from the nearest
// Scope that knows.
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

// Whether `cursor` stands inside `span`, inclusive of both ends.
function spanHolds(span: common.Position, cursor: common.Cursor): boolean {
	return notBefore(cursor, span.start) && notBefore(span.end, cursor)
}

function notBefore(cursor: common.Cursor, than: common.Cursor): boolean {
	return (
		cursor.line > than.line ||
		(cursor.line === than.line && cursor.column >= than.column)
	)
}

// Whether the parser abandoned a Declaration of this name that this read
// could have seen. Every "no such name" report asks first, so a syntax error is
// reported once. A hoisted Declaration covers the file; any other covers its
// block from its own position on, so it silences only the reads it would answer.
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

// The same question about a member name, such as a Method read off a
// Namespace. It covers the whole file, because a member name is not lexical: a
// dropped Method is read from outside its Namespace's body.
export function memberDeclarationWasAbandoned(
	scope: enricher.Scope,
	name: string,
): boolean {
	return abandonedDeclarationsIn(scope).some((record) => record.name === name)
}

// A fresh child Scope under `parent`. A map passed in `overrides` arrives as
// an ordinary object, so it is copied onto a map without a prototype.
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

// How many Types have been declared, ever. Answers about which refinements a
// Scope sees are dropped when it moves. Declaring, poisoning or deleting a
// Type bumps it, and so does filling in a hoisted predicate. One counter is
// cheaper than a version per Scope, since declarations are rare.
let typeDeclarations = 0

export function typeDeclarationCount(): number {
	return typeDeclarations
}

export function countTypeDeclaration(): void {
	typeDeclarations += 1
}
