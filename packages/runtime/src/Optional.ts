import { createString, itemText, type StringType } from "./String"
import { type AnyType, typeKeySymbol } from "./type"

// A builtin generic Choice, written in Essence in `Optional.es` apart from
// `toString`. Every native that can answer nothing builds its answer here.
// See "Builtin Choices" in DEVELOPMENT.md.
export type ValueType<Item extends AnyType> = {
	[typeKeySymbol]: "Optional#Value"
	item: Item
}

export type EmptyType = { [typeKeySymbol]: "Optional#Empty" }

export type OptionalType<Item extends AnyType> = ValueType<Item> | EmptyType

const sharedEmptyInstance: EmptyType = { [typeKeySymbol]: "Optional#Empty" }

export function createEmpty(): EmptyType {
	return sharedEmptyInstance
}

export function createValue<Item extends AnyType>(item: Item): ValueType<Item> {
	return { [typeKeySymbol]: "Optional#Value", item }
}

// Native so that a String payload is quoted, as `itemText` does inside a
// structure. The parentheses keep `#Value("Empty")` apart from `#Empty`.
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
