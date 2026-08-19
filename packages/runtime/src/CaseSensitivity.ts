import { typeKeySymbol } from "./type"

// NOTE: `CaseSensitivity` is a builtin Choice, like `Side` — its values carry
// Case tags (`"CaseSensitivity#Sensitive"`) exactly as user-declared Cases do,
// and `is`, `isNot` and `toString` are all derived from the Choice
// (`packages/standard-library/sources/String.es` declares the conformances
// beside the comparison Methods that take one). Nothing but the tags lives
// here. Unlike `Side`, no native
// Method READS a CaseSensitivity — `is` and `compare`'s case-folding Overloads
// are Essence — so a user's `CaseSensitivity#Insensitive` is built by
// `$type.createCase`, and these singletons exist only for symmetry with the
// other builtin Choices.
export type SensitiveType = { [typeKeySymbol]: "CaseSensitivity#Sensitive" }
export type InsensitiveType = { [typeKeySymbol]: "CaseSensitivity#Insensitive" }
export type CaseSensitivityType = SensitiveType | InsensitiveType

export const sensitive: SensitiveType = {
	[typeKeySymbol]: "CaseSensitivity#Sensitive",
}
export const insensitive: InsensitiveType = {
	[typeKeySymbol]: "CaseSensitivity#Insensitive",
}
