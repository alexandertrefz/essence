import { typeKeySymbol } from "./type"

// A builtin Choice. `isInsensitive` in `String.ts` reads its tag, and these
// instances go unread. See "Builtin Choices" in DEVELOPMENT.md.
export type SensitiveType = { [typeKeySymbol]: "CaseSensitivity#Sensitive" }
export type InsensitiveType = { [typeKeySymbol]: "CaseSensitivity#Insensitive" }
export type CaseSensitivityType = SensitiveType | InsensitiveType

export const sensitive: SensitiveType = {
	[typeKeySymbol]: "CaseSensitivity#Sensitive",
}
export const insensitive: InsensitiveType = {
	[typeKeySymbol]: "CaseSensitivity#Insensitive",
}
