import type { BooleanType } from "./Boolean"
import type { ListType } from "./List"

import { createBoolean } from "./Boolean"
import { createList } from "./List"
import { typeKeySymbol } from "./type"

export type StringType = { [typeKeySymbol]: "String"; value: string }

export function createString(value: string): StringType {
	return { [typeKeySymbol]: "String", value }
}

export function isEmpty(originalString: StringType): BooleanType {
	return createBoolean(originalString.value.length === 0)
}

export function hasAnyContent(originalString: StringType): BooleanType {
	return createBoolean(originalString.value.length !== 0)
}

export function is(
	originalString: StringType,
	otherString: StringType,
): BooleanType {
	return createBoolean(originalString.value === otherString.value)
}

export function isNot(
	originalString: StringType,
	otherString: StringType,
): BooleanType {
	return createBoolean(originalString.value !== otherString.value)
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

export function splitOn(
	originalString: StringType,
	splitterString: StringType,
): ListType<StringType> {
	return createList(
		originalString.value
			.split(splitterString.value)
			.map((chunk) => createString(chunk)),
	)
}

export function contains(
	originalString: StringType,
	otherString: StringType,
): BooleanType {
	return createBoolean(originalString.value.includes(otherString.value))
}

export function doesNotContain(
	originalString: StringType,
	otherString: StringType,
): BooleanType {
	return createBoolean(!originalString.value.includes(otherString.value))
}
