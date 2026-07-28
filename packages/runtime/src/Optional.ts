import { type AnyType, typeKeySymbol } from "./type"

// NOTE: `Optional` is a builtin generic Choice, like `Step` — its values carry
// Case tags (`"Optional#Value"`, `"Optional#Empty"`) exactly as user-declared
// Cases do. Every Method of the covering Namespace is written in Essence
// (`packages/stdlib/sources/Optional.es`), so nothing here is a Method; what
// lives here are the Types the generated native contract renders a fallible
// signature against, and the two constructors the natives ANSWER with.
//
// Unlike `Step`, this module carries constructors: a `Step` is built by the
// `step` callback a loop driver is handed, in Essence, while an Optional is
// built by the natives themselves — every one that can come back empty.
export type ValueType<Item extends AnyType> = {
	[typeKeySymbol]: "Optional#Value"
	item: Item
}

export type EmptyType = { [typeKeySymbol]: "Optional#Empty" }

export type OptionalType<Item extends AnyType> = ValueType<Item> | EmptyType

// NOTE: Shared, for the same reason `Ordering`'s Cases are — `#Empty` carries
// nothing, Case equality goes by tag, and a native answering "no value" is the
// commonest thing a native does.
const sharedEmptyInstance: EmptyType = { [typeKeySymbol]: "Optional#Empty" }

export function createEmpty(): EmptyType {
	return sharedEmptyInstance
}

export function createValue<Item extends AnyType>(item: Item): ValueType<Item> {
	return { [typeKeySymbol]: "Optional#Value", item }
}
