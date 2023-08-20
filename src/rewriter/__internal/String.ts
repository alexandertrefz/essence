import type { BooleanType } from "./Boolean"
import type { ListType } from "./List"

import { typeKeySymbol } from "./type"
import * as $Boolean from "./Boolean"
import * as $List from "./List"

export type StringType = { [typeKeySymbol]: "String"; value: string }

export function createString(value: string): StringType {
	return { [typeKeySymbol]: "String", value }
}

export function isEmpty(originalString: StringType): BooleanType {
	return $Boolean.createBoolean(originalString.value.length === 0)
}

export function hasContent(originalString: StringType): BooleanType {
	return $Boolean.createBoolean(originalString.value.length !== 0)
}

export function is(
	originalString: StringType,
	otherString: StringType,
): BooleanType {
	return $Boolean.createBoolean(originalString.value === otherString.value)
}

export function isnt(
	originalString: StringType,
	otherString: StringType,
): BooleanType {
	return $Boolean.createBoolean(originalString.value !== otherString.value)
}

export function prepend(
	originalString: StringType,
	otherString: StringType,
): StringType {
	return createString(otherString.value + originalString.value)
}

export function append(
	originalString: StringType,
	otherString: StringType,
): StringType {
	return createString(originalString.value + otherString.value)
}

export function split(
	originalString: StringType,
	splitterString: StringType,
): ListType<StringType> {
	return $List.createList(
		originalString.value
			.split(splitterString.value)
			.map((chunk) => createString(chunk)),
	)
}

export function contains(
	originalString: StringType,
	otherString: StringType,
): BooleanType {
	return $Boolean.createBoolean(
		originalString.value.includes(otherString.value),
	)
}
