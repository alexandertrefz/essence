import type { BooleanType } from "./Boolean"
import { createBoolean } from "./Boolean"
import type { StringType } from "./String"
import { createString } from "./String"
import { typeKeySymbol } from "./type"

// NOTE: `Ordering` is the builtin Choice — its values carry Case tags
// (`"Ordering#Less"`) exactly like user-declared Cases do.
export type LessType = { [typeKeySymbol]: "Ordering#Less" }
export type EqualType = { [typeKeySymbol]: "Ordering#Equal" }
export type GreaterType = { [typeKeySymbol]: "Ordering#Greater" }
export type OrderingType = LessType | EqualType | GreaterType

// NOTE: Shared unit instances for the compare Methods — Case equality goes
// by tag, so these being singletons is an optimisation, not a semantic.
export const less: LessType = { [typeKeySymbol]: "Ordering#Less" }
export const equal: EqualType = { [typeKeySymbol]: "Ordering#Equal" }
export const greater: GreaterType = { [typeKeySymbol]: "Ordering#Greater" }

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
	// NOTE: The tag is `Ordering#Less` — printed without the Choice prefix.
	return createString(ordering[typeKeySymbol].split("#")[1])
}
