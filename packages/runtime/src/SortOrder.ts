import { typeKeySymbol } from "./type"

// NOTE: `SortOrder` is a builtin Choice, like `Rounding` — its values carry Case
// tags (`"SortOrder#Descending"`) exactly as user-declared Cases do, and `is`,
// `isNot` and `toString` are all derived from the Choice
// (`packages/standard-library/sources/List.es` declares the conformances beside
// the Method that takes one). So nothing but the tags lives here. The Methods
// that READ a SortOrder belong to the Namespace that declares them, so its tag
// is asked about by the `sort` and `isSorted` natives in `List.ts` and by
// `sort` in `Dictionary.ts`.
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
