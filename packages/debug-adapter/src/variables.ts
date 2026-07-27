import { demangleName, isCompilerBinding } from "./names"

// NOTE: The pure half of the Variables view: which bindings a scope shows and
// under what names. The CDP traffic around it — property reads, the batched
// in-debuggee rendering — lives with the session, which owns the connection.

// NOTE: Null hides the binding. The compiler's own names never surface, a
// placeholder parameter (`_0` stands where no name was bound) has nothing to
// show, and the receiver every Method is emitted with reads back as the
// `self` the author's `@` means.
export function presentScopeVariableName(name: string): string | null {
	if (isCompilerBinding(name)) {
		return null
	}

	if (/^_\d+$/.test(name)) {
		return null
	}

	if (name === "_self") {
		return "self"
	}

	return demangleName(name)
}

// NOTE: Which of a paused frame's scopes are worth a row. The module and
// global scopes hold the bundle's own machinery — imports, the hoisted
// prelude — which the scope filter above would empty out one binding at a
// time anyway.
export function isPresentableScope(scopeType: string): boolean {
	return (
		scopeType === "local" ||
		scopeType === "block" ||
		scopeType === "closure" ||
		scopeType === "catch"
	)
}

export type RemoteObject = {
	type: string
	subtype?: string
	objectId?: string
	value?: unknown
	unserializableValue?: string
	description?: string
}

// NOTE: A live value, re-spelled as a `callFunctionOn` argument — by
// reference when it is an object, by its wire spelling when it is a bigint,
// by value otherwise.
export function toCallArgument(value: RemoteObject): object {
	if (value.objectId !== undefined) {
		return { objectId: value.objectId }
	}

	if (value.unserializableValue !== undefined) {
		return { unserializableValue: value.unserializableValue }
	}

	return { value: value.value }
}

// NOTE: What a value shows when the in-debuggee renderer answered nothing —
// it was not an Essence value, so CDP's own description is the honest line.
export function fallbackDisplay(value: RemoteObject): string {
	return value.description ?? String(value.value)
}
