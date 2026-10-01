import { typeKeySymbol } from "./type"

// A builtin Choice. `Integer::remainder(dividingBy:as:)` reads it in Essence,
// so no native does. See "Builtin Choices" in DEVELOPMENT.md.
export type EuclideanType = { [typeKeySymbol]: "Division#Euclidean" }
export type TruncatingType = { [typeKeySymbol]: "Division#Truncating" }
export type DivisionType = EuclideanType | TruncatingType

export const euclidean: EuclideanType = {
	[typeKeySymbol]: "Division#Euclidean",
}
export const truncating: TruncatingType = {
	[typeKeySymbol]: "Division#Truncating",
}
