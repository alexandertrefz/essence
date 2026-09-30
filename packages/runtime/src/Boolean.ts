import { equal, greater, less, type OrderingType } from "./Ordering"
import { typeKeySymbol } from "./type"

export type BooleanType = { [typeKeySymbol]: "Boolean"; value: boolean }

// Two shared Boolean values, so a comparison or a predicate allocates nothing.
// Essence can ask only whether two values are equal, never whether they are
// the same object. They are not frozen: no runtime value is, since freezing
// would slow every read.
export const trueInstance: BooleanType = {
	[typeKeySymbol]: "Boolean",
	value: true,
}

export const falseInstance: BooleanType = {
	[typeKeySymbol]: "Boolean",
	value: false,
}

export function createBoolean(value: boolean): BooleanType {
	return value ? trueInstance : falseInstance
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

// `false` sorts before `true`.
export function compare(
	originalBoolean: BooleanType,
	other: BooleanType,
): OrderingType {
	if (originalBoolean.value === other.value) {
		return equal
	}

	return originalBoolean.value ? greater : less
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

// `exclusiveOr` and `toString` are written in Essence in `Boolean.es`, and
// `isNot` comes from `Equatable`. The natives here are what those bodies call.
