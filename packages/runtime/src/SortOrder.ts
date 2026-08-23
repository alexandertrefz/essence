import { typeKeySymbol } from "./type"

// NOTE: `SortOrder` is a builtin Choice, like `Rounding` — its values carry Case
// tags (`"SortOrder#Descending"`) exactly as user-declared Cases do, and `is`,
// `isNot` and `toString` are all derived from the Choice
// (`packages/standard-library/sources/List.es` declares the conformances beside
// the Method that takes one). So nothing but the tags lives here. The Method
// that READS a SortOrder belongs to the Namespace that declares it, which makes
// `List.sort__overload$1`'s native the one place the tag is asked about.
export type AscendingType = { [typeKeySymbol]: "SortOrder#Ascending" }
export type DescendingType = { [typeKeySymbol]: "SortOrder#Descending" }
export type SortOrderType = AscendingType | DescendingType

// NOTE: Shared unit instances, for the same reason `Ordering`'s are shared —
// Case equality goes by tag, so these being singletons is an optimisation.
export const ascending: AscendingType = {
	[typeKeySymbol]: "SortOrder#Ascending",
}
export const descending: DescendingType = {
	[typeKeySymbol]: "SortOrder#Descending",
}
