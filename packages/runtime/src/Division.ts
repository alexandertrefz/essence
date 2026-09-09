import { typeKeySymbol } from "./type"

// NOTE: `Division` is a builtin Choice, like `Rounding` and `SignStyle` — its
// values carry Case tags (`"Division#Euclidean"`) exactly as user-declared
// Cases do. `is`, `isNot` and `toString` are all derived from the Choice
// (`packages/standard-library/sources/Integer.es` declares the conformances
// beside the Method that takes one), so nothing but the tags lives here.
// `Integer::remainder(dividingBy:as:)` READS one and is written in Essence, so
// this Choice reaches no native at all.
export type EuclideanType = { [typeKeySymbol]: "Division#Euclidean" }
export type TruncatingType = { [typeKeySymbol]: "Division#Truncating" }
export type DivisionType = EuclideanType | TruncatingType

// NOTE: Shared unit instances, for the same reason `Ordering`'s are shared —
// Case equality goes by tag, so these being singletons is an optimisation.
export const euclidean: EuclideanType = {
	[typeKeySymbol]: "Division#Euclidean",
}
export const truncating: TruncatingType = {
	[typeKeySymbol]: "Division#Truncating",
}
