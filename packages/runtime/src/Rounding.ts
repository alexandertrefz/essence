import { typeKeySymbol } from "./type"

// A builtin Choice. The rounding natives in `Rational.ts`, `Algebraic.ts`
// and `Transcendental.ts` read its tag. See "Builtin Choices" in
// DEVELOPMENT.md.
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

export const nearest: NearestType = { [typeKeySymbol]: "Rounding#Nearest" }
export const nearestEven: NearestEvenType = {
	[typeKeySymbol]: "Rounding#NearestEven",
}
export const down: DownType = { [typeKeySymbol]: "Rounding#Down" }
export const up: UpType = { [typeKeySymbol]: "Rounding#Up" }
export const towardZero: TowardZeroType = {
	[typeKeySymbol]: "Rounding#TowardZero",
}
