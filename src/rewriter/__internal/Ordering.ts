import { typeKeySymbol } from "./type"

// NOTE: `Ordering` is the builtin Choice — its values carry Case tags
// (`"Ordering#Less"`) exactly like user-declared Cases do.
export type LessType = { [typeKeySymbol]: "Ordering#Less" }
export type EqualType = { [typeKeySymbol]: "Ordering#Equal" }
export type GreaterType = { [typeKeySymbol]: "Ordering#Greater" }
export type OrderingType = LessType | EqualType | GreaterType

// NOTE: Shared unit instances for the compare Methods — Case equality goes
// by tag, so these being singletons is an optimisation, not a semantic. The
// numeric tower and every other `compareTo` return these, so they stay native
// even though `is`, `isNot` and `toString` are implemented in Essence — see
// `src/stdlib/Ordering.es`.
export const less: LessType = { [typeKeySymbol]: "Ordering#Less" }
export const equal: EqualType = { [typeKeySymbol]: "Ordering#Equal" }
export const greater: GreaterType = { [typeKeySymbol]: "Ordering#Greater" }
