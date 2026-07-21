import type { BooleanType } from "./Boolean"
import { createBoolean } from "./Boolean"
import type { StringType } from "./String"
import { createString } from "./String"
import { typeKeySymbol } from "./type"

export type LessType = { [typeKeySymbol]: "Less" }
export type EqualType = { [typeKeySymbol]: "Equal" }
export type GreaterType = { [typeKeySymbol]: "Greater" }
export type OrderingType = LessType | EqualType | GreaterType

// NOTE: Unit values, following the Nothing precedent — one shared instance
// per variant, produced via the Ordering Namespace's static properties.
export const less: LessType = { [typeKeySymbol]: "Less" }
export const equal: EqualType = { [typeKeySymbol]: "Equal" }
export const greater: GreaterType = { [typeKeySymbol]: "Greater" }

export function is(
	originalOrdering: OrderingType,
	otherOrdering: OrderingType,
): BooleanType {
	return createBoolean(
		originalOrdering[typeKeySymbol] === otherOrdering[typeKeySymbol],
	)
}

export function isNot(
	originalOrdering: OrderingType,
	otherOrdering: OrderingType,
): BooleanType {
	return createBoolean(
		originalOrdering[typeKeySymbol] !== otherOrdering[typeKeySymbol],
	)
}

export function toString(ordering: OrderingType): StringType {
	return createString(ordering[typeKeySymbol])
}
