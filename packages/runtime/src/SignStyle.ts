import { typeKeySymbol } from "./type"

// NOTE: `SignStyle` is a builtin Choice, like `Rounding` and `NumberFormat` —
// its values carry Case tags (`"SignStyle#Always"`) exactly as user-declared
// Cases do. `is`, `isNot` and `toString` are all derived from the Choice
// (`packages/standard-library/sources/Rational.es` declares the conformances beside the Method
// that takes one), so nothing but the tags lives here. `Integer::toString(showingSign:)` and its
// Rational sibling READ one, and both are written in Essence, so this Choice
// reaches no native at all.
export type NegativeType = { [typeKeySymbol]: "SignStyle#Negative" }
export type AlwaysType = { [typeKeySymbol]: "SignStyle#Always" }
export type SignStyleType = NegativeType | AlwaysType

// NOTE: Shared unit instances, for the same reason `Ordering`'s are shared —
// Case equality goes by tag, so these being singletons is an optimisation.
export const negative: NegativeType = { [typeKeySymbol]: "SignStyle#Negative" }
export const always: AlwaysType = { [typeKeySymbol]: "SignStyle#Always" }
