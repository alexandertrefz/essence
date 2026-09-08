import { typeKeySymbol } from "./type"

// NOTE: `NumberFormat` is a builtin Choice, like `Ordering` and `Side` — its
// values carry Case tags (`"NumberFormat#Fraction"`) exactly as user-declared
// Cases do. `is`, `isNot` and `toString` are all derived from the Choice
// (`packages/standard-library/sources/Rational.es` declares the conformances beside the Method that
// takes one), so nothing but the tags lives here. `Rational::toString(as:)` READS one, and it is a
// Method of `Rational`, so its native is in `Rational.ts`.
export type FractionType = { [typeKeySymbol]: "NumberFormat#Fraction" }
export type DecimalType = { [typeKeySymbol]: "NumberFormat#Decimal" }
export type PercentType = { [typeKeySymbol]: "NumberFormat#Percent" }
export type ScientificType = { [typeKeySymbol]: "NumberFormat#Scientific" }
export type NumberFormatType =
	| FractionType
	| DecimalType
	| PercentType
	| ScientificType

// NOTE: Shared unit instances, for the same reason `Ordering`'s are shared —
// Case equality goes by tag, so these being singletons is an optimisation.
export const fraction: FractionType = {
	[typeKeySymbol]: "NumberFormat#Fraction",
}
export const decimal: DecimalType = { [typeKeySymbol]: "NumberFormat#Decimal" }
export const percent: PercentType = { [typeKeySymbol]: "NumberFormat#Percent" }
export const scientific: ScientificType = {
	[typeKeySymbol]: "NumberFormat#Scientific",
}
