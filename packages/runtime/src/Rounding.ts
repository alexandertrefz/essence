import { typeKeySymbol } from "./type"

// NOTE: `Rounding` is a builtin Choice, like `Side` and `NumberFormat` — its
// values carry Case tags (`"Rounding#Nearest"`) exactly as user-declared Cases
// do. `is`, `isNot` and `toString` are implemented in Essence
// (`packages/stdlib/sources/Rational.es`, beside the Method that takes one), so
// nothing but the tags lives here. `Rational::round(toward:)` READS one, and it
// is written in Essence too — this Choice reaches no native at all, unlike
// `Side`, whose `String::trim(at:)` is one.
export type NearestType = { [typeKeySymbol]: "Rounding#Nearest" }
export type DownType = { [typeKeySymbol]: "Rounding#Down" }
export type UpType = { [typeKeySymbol]: "Rounding#Up" }
export type TowardZeroType = { [typeKeySymbol]: "Rounding#TowardZero" }
export type RoundingType = NearestType | DownType | UpType | TowardZeroType

// NOTE: Shared unit instances, for the same reason `Ordering`'s are shared —
// Case equality goes by tag, so these being singletons is an optimisation.
export const nearest: NearestType = { [typeKeySymbol]: "Rounding#Nearest" }
export const down: DownType = { [typeKeySymbol]: "Rounding#Down" }
export const up: UpType = { [typeKeySymbol]: "Rounding#Up" }
export const towardZero: TowardZeroType = {
	[typeKeySymbol]: "Rounding#TowardZero",
}
