import { demangleName, isCompilerBinding } from "./names"

// The pure half of the Variables view: which bindings a scope shows and under
// what names. The session does the CDP traffic.

// Null hides the binding: a compiler name, or a placeholder parameter such as
// `_0` for an unnamed one. The emitted receiver `_self` reads as `self`.
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

// Which of a paused frame's scopes get a row. The module and global scopes
// hold the bundle's imports and prelude, none of which the author wrote.
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
	className?: string
	objectId?: string
	value?: unknown
	unserializableValue?: string
	description?: string
}

// A live value as a `callFunctionOn` argument: by reference for an object, by
// its unserializable spelling for a bigint, by value otherwise.
export function toCallArgument(value: RemoteObject): object {
	if (value.objectId !== undefined) {
		return { objectId: value.objectId }
	}

	if (value.unserializableValue !== undefined) {
		return { unserializableValue: value.unserializableValue }
	}

	return { value: value.value }
}

// What a value that is not an Essence value shows: CDP's own description.
export function fallbackDisplay(value: RemoteObject): string {
	return value.description ?? String(value.value)
}
