import { typeKeySymbol } from "./type"

// A builtin Choice. `toString(showingSign:)` reads it in Essence, so no
// native does. See "Builtin Choices" in DEVELOPMENT.md.
export type NegativeType = { [typeKeySymbol]: "SignStyle#Negative" }
export type AlwaysType = { [typeKeySymbol]: "SignStyle#Always" }
export type SignStyleType = NegativeType | AlwaysType

export const negative: NegativeType = { [typeKeySymbol]: "SignStyle#Negative" }
export const always: AlwaysType = { [typeKeySymbol]: "SignStyle#Always" }
