import { createString, itemText, type StringType } from "./String"
import { type AnyType, typeKeySymbol } from "./type"

// NOTE: `Optional` is a builtin generic Choice, like `Step` — its values carry
// Case tags (`"Optional#Value"`, `"Optional#Empty"`) exactly as user-declared
// Cases do. Every Method of the covering Namespace but one is written in
// Essence (`packages/standard-library/sources/Optional.es`); what else lives
// here are the Types the generated native contract renders a fallible
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

// NOTE: The one Method here, and native for one reason: an Essence body renders
// the payload through a hole, and a hole renders a String BARE. So the entry
// could not say the rule `itemText` holds — a String is quoted inside a
// structure — and `#Value("a")` printed as `Value(a)`, which `#Value("")` and
// `#Empty` then both read as a word and a pair of parentheses.
//
// NOTE: The `#` sigil is left out, as `Ordering` prints `Less`. A rendering
// names the Case; it does not quote the Expression that builds it. The
// parentheses stay: without them `#Value("Empty")` and `#Empty` read alike.
// biome-ignore lint/suspicious/noShadowRestrictedNames: This is a runtime function
export function toString<Item extends AnyType>(
	optional: OptionalType<Item>,
	conformance: {
		toString: (value: Item) => StringType
	},
): StringType {
	return optional[typeKeySymbol] === "Optional#Empty"
		? createString("Empty")
		: createString(`Value(${itemText(optional.item, conformance)})`)
}
