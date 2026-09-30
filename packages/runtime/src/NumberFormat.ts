import { typeKeySymbol } from "./type"

// A builtin Choice. `Rational::toString(as:)` in `Rational.ts` reads its tag.
// See "Builtin Choices" in DEVELOPMENT.md.
export type FractionType = { [typeKeySymbol]: "NumberFormat#Fraction" }
export type DecimalType = { [typeKeySymbol]: "NumberFormat#Decimal" }
export type PercentType = { [typeKeySymbol]: "NumberFormat#Percent" }
export type ScientificType = { [typeKeySymbol]: "NumberFormat#Scientific" }
export type NumberFormatType =
	| FractionType
	| DecimalType
	| PercentType
	| ScientificType

export const fraction: FractionType = {
	[typeKeySymbol]: "NumberFormat#Fraction",
}
export const decimal: DecimalType = { [typeKeySymbol]: "NumberFormat#Decimal" }
export const percent: PercentType = { [typeKeySymbol]: "NumberFormat#Percent" }
export const scientific: ScientificType = {
	[typeKeySymbol]: "NumberFormat#Scientific",
}
