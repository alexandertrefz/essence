import { typeKeySymbol } from "./type"

// NOTE: `NumberFormat` is a builtin Choice, like `Ordering` and `Side` — its
// values carry Case tags (`"NumberFormat#Fraction"`) exactly as user-declared
// Cases do. `is`, `isNot` and `toString` are implemented in Essence
// (`src/stdlib/Rational.es`, beside the Method that takes one), so nothing but
// the tags lives here. `Rational::toString(formatAs:)` READS one, and it is a
// Method of `Rational`, so its native is in `Rational.ts`.
export type FractionType = { [typeKeySymbol]: "NumberFormat#Fraction" }
export type DecimalType = { [typeKeySymbol]: "NumberFormat#Decimal" }
export type NumberFormatType = FractionType | DecimalType

// NOTE: Shared unit instances, for the same reason `Ordering`'s are shared —
// Case equality goes by tag, so these being singletons is an optimisation.
export const fraction: FractionType = {
	[typeKeySymbol]: "NumberFormat#Fraction",
}
export const decimal: DecimalType = { [typeKeySymbol]: "NumberFormat#Decimal" }
