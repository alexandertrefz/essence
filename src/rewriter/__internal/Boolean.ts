import type { StringType } from "./String"

import { typeKeySymbol } from "./type"
import { createString } from "./String"

export type BooleanType = { [typeKeySymbol]: "Boolean"; value: boolean }

export function createBoolean(value: boolean): BooleanType {
	return { [typeKeySymbol]: "Boolean", value }
}

export function negate(originalBoolean: BooleanType): BooleanType {
	return createBoolean(!originalBoolean.value)
}

export function is(
	originalBoolean: BooleanType,
	other: BooleanType,
): BooleanType {
	return createBoolean(originalBoolean.value === other.value)
}

export function isnt(
	originalBoolean: BooleanType,
	other: BooleanType,
): BooleanType {
	return createBoolean(originalBoolean.value !== other.value)
}

// rome-ignore lint/suspicious/noShadowRestrictedNames:
export function toString(boolean: BooleanType): StringType {
	return createString(boolean.value.toString())
}
