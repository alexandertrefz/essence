import type { StringType } from "./String"
import { createString } from "./String"
import { typeKeySymbol } from "./type"

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

export function and(
	originalBoolean: BooleanType,
	other: BooleanType,
): BooleanType {
	return createBoolean(originalBoolean.value && other.value)
}

export function or(
	originalBoolean: BooleanType,
	other: BooleanType,
): BooleanType {
	return createBoolean(originalBoolean.value || other.value)
}

// NOTE: `isNot`, `exclusiveOr` and `toString` are implemented in Essence — see
// `src/stdlib/Boolean.es`. `negate`, `is`, `and` and `or` stay native: they are
// the anchors the Essence half is built from, and `or` in particular would cost
// four Method calls through De Morgan where this does one `||`.
