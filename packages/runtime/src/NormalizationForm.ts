import { typeKeySymbol } from "./type"

// A builtin Choice. `normalize(as:)` in `String.ts` reads its tag, and these
// instances go unread. See "Builtin Choices" in DEVELOPMENT.md.
export type ComposedCanonicalType = {
	[typeKeySymbol]: "NormalizationForm#ComposedCanonical"
}
export type DecomposedCanonicalType = {
	[typeKeySymbol]: "NormalizationForm#DecomposedCanonical"
}
export type ComposedCompatibilityType = {
	[typeKeySymbol]: "NormalizationForm#ComposedCompatibility"
}
export type DecomposedCompatibilityType = {
	[typeKeySymbol]: "NormalizationForm#DecomposedCompatibility"
}
export type NormalizationFormType =
	| ComposedCanonicalType
	| DecomposedCanonicalType
	| ComposedCompatibilityType
	| DecomposedCompatibilityType

export const composedCanonical: ComposedCanonicalType = {
	[typeKeySymbol]: "NormalizationForm#ComposedCanonical",
}
export const decomposedCanonical: DecomposedCanonicalType = {
	[typeKeySymbol]: "NormalizationForm#DecomposedCanonical",
}
export const composedCompatibility: ComposedCompatibilityType = {
	[typeKeySymbol]: "NormalizationForm#ComposedCompatibility",
}
export const decomposedCompatibility: DecomposedCompatibilityType = {
	[typeKeySymbol]: "NormalizationForm#DecomposedCompatibility",
}
