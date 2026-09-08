import { typeKeySymbol } from "./type"

// NOTE: `Rounding` is a builtin Choice, like `Side` and `NumberFormat` — its
// values carry Case tags (`"Rounding#Nearest"`) exactly as user-declared Cases
// do. `is`, `isNot` and `toString` are all derived from the Choice
// (`packages/standard-library/sources/Rational.es` declares the conformances beside the Method
// that takes one), so nothing but the tags lives here. The Essence body of
// `Rational::round(toward:)` READS one; the `toPlaces` entries of
// `Rational::toString` are natives that take one, and so are the irrationals'
// `approximate(toPlaces:toward:)` and `round(toward:)`. So this Choice does
// reach `Rational.ts`, `Algebraic.ts` and `Transcendental.ts`, the way `Side`
// reaches `String::trim(at:)`.
export type NearestType = { [typeKeySymbol]: "Rounding#Nearest" }
export type NearestEvenType = { [typeKeySymbol]: "Rounding#NearestEven" }
export type DownType = { [typeKeySymbol]: "Rounding#Down" }
export type UpType = { [typeKeySymbol]: "Rounding#Up" }
export type TowardZeroType = { [typeKeySymbol]: "Rounding#TowardZero" }
export type RoundingType =
	| NearestType
	| NearestEvenType
	| DownType
	| UpType
	| TowardZeroType

// NOTE: Shared unit instances, for the same reason `Ordering`'s are shared —
// Case equality goes by tag, so these being singletons is an optimisation.
export const nearest: NearestType = { [typeKeySymbol]: "Rounding#Nearest" }
export const nearestEven: NearestEvenType = {
	[typeKeySymbol]: "Rounding#NearestEven",
}
export const down: DownType = { [typeKeySymbol]: "Rounding#Down" }
export const up: UpType = { [typeKeySymbol]: "Rounding#Up" }
export const towardZero: TowardZeroType = {
	[typeKeySymbol]: "Rounding#TowardZero",
}
