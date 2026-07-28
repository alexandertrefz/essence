import { typeKeySymbol } from "./type"

// NOTE: `Case` is a builtin Choice, like `Side` — its values carry Case tags
// (`"Case#Sensitive"`) exactly as user-declared Cases do, and `is`, `isNot` and
// `toString` are implemented in Essence (`packages/stdlib/sources/String.es`, beside the
// comparison Methods that take a Case). Nothing but the tags lives here. Unlike
// `Side`, no native Method READS a Case — `is` and `compare`'s case-folding
// Overloads are Essence — so a user's `Case#Insensitive` is built by
// `$type.createCase`, and these singletons exist only for symmetry with the
// other builtin Choices.
export type SensitiveType = { [typeKeySymbol]: "Case#Sensitive" }
export type InsensitiveType = { [typeKeySymbol]: "Case#Insensitive" }
export type CaseType = SensitiveType | InsensitiveType

export const sensitive: SensitiveType = { [typeKeySymbol]: "Case#Sensitive" }
export const insensitive: InsensitiveType = {
	[typeKeySymbol]: "Case#Insensitive",
}
