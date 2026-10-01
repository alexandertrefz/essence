import type { parser } from "@essence-lang/interfaces"

// The hidden trailing Parameter a Protocol-bounded Type Parameter adds to an
// emitted Function, which a call inside it forwards as its own witness. The
// Enricher, Simplifier, Validator and native-table generator must agree on it.
// The Lexer reads `_` as a Symbol, so no written Identifier collides with it.
export function conformanceParameterName(genericName: string): string {
	return `${genericName}__conformance`
}

// A name the Compiler made up: the Constant a Pattern holds its value in, or the
// internal name of a Parameter a Pattern takes apart. No Identifier holds a `_`,
// and the `$` keeps it clear of the Rewriter's `_self`. The hover and the debug
// adapter both ask here.
export function isSynthesizedName(name: string): boolean {
	return /^\$(pattern|parameter)_\d+_\d+$/.test(name)
}

// The one name a Parameter's body reads it under, or null where the internal
// name is a Pattern. A caller describing a Parameter falls back to its label.
export function parameterInternalName(
	parameter: parser.ParameterNode,
): parser.IdentifierNode | null {
	return parameter.internalName?.nodeType === "Identifier"
		? parameter.internalName
		: null
}
