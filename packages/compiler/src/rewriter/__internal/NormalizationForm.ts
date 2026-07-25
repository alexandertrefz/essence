import { typeKeySymbol } from "./type"

// NOTE: `NormalizationForm` is a builtin Choice, like `Side` — its values carry
// Case tags (`"NormalizationForm#ComposedCanonical"`) exactly as user-declared
// Cases do. `is`, `isNot` and `toString` are implemented in Essence
// (`src/stdlib/String.es`, beside `normalized`, the Method that reads a form).
// The native `normalized(as:)` reads the tag to pick the `String.normalize`
// argument; a user's `NormalizationForm#…` value is built by `$type.createCase`,
// so these singletons exist for symmetry with the other builtin Choices.
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
