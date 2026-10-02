import type { common, parser } from "@essence-lang/interfaces"

// The hidden trailing Parameter a Protocol-bounded Type Parameter adds to an
// emitted Function, which a call inside it forwards as its own witness. The
// Enricher, Simplifier, Validator and native-table generator must agree on it.
// The Lexer reads `_` as a Symbol, so no written Identifier collides with it.
export function conformanceParameterName(genericName: string): string {
	return `${genericName}__conformance`
}

// A name no source can write, derived from a Position, such as the Constant a
// Pattern or a `require` holds its value in. `_` is a Symbol to the Lexer and
// `$` keeps it apart from `_self`. A Position rather than a counter, so the body
// read twice for return inference mints the same name.
export function synthesizedName(
	kind: string,
	position: common.Position,
): string {
	return `$${kind}_${position.start.line}_${position.start.column}`
}

// Whether `synthesizedName` made the name, whatever its kind. The hover and the
// debug adapter both ask here.
export function isSynthesizedName(name: string): boolean {
	return /^\$[a-z]+_\d+_\d+$/.test(name)
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
