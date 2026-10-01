import { typeKeySymbol } from "./type"

// A builtin Choice. See "Builtin Choices" in DEVELOPMENT.md.
export type LessType = { [typeKeySymbol]: "Ordering#Less" }
export type EqualType = { [typeKeySymbol]: "Ordering#Equal" }
export type GreaterType = { [typeKeySymbol]: "Ordering#Greater" }
export type OrderingType = LessType | EqualType | GreaterType

// What every native `compare` answers.
export const less: LessType = { [typeKeySymbol]: "Ordering#Less" }
export const equal: EqualType = { [typeKeySymbol]: "Ordering#Equal" }
export const greater: GreaterType = { [typeKeySymbol]: "Ordering#Greater" }
