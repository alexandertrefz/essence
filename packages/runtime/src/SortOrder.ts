import { typeKeySymbol } from "./type"

// A builtin Choice. `sort` and `isSorted` in `List.ts` and `sort` in
// `Dictionary.ts` read its tag. See "Builtin Choices" in DEVELOPMENT.md.
export type AscendingType = { [typeKeySymbol]: "SortOrder#Ascending" }
export type DescendingType = { [typeKeySymbol]: "SortOrder#Descending" }
export type SortOrderType = AscendingType | DescendingType

export const ascending: AscendingType = {
	[typeKeySymbol]: "SortOrder#Ascending",
}
export const descending: DescendingType = {
	[typeKeySymbol]: "SortOrder#Descending",
}
