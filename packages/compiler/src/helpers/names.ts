import type { parser } from "@essence-lang/interfaces"

// NOTE: The hidden trailing Parameter a Protocol-bounded Type Parameter adds to
// an emitted Function, and the name a call site inside that Function forwards
// as its own witness. Four stages spell it — the Enricher when it solves a
// witness, the Simplifier when it emits the Parameter, the Validator when it
// checks that the one resolves to the other, and the native-table generator —
// and a Program only runs while all four agree, so they say it once.
//
// NOTE: `_` is a Symbol to the Lexer, so no user identifier can contain one and
// this name can not collide with anything written in a Program.
export function conformanceParameterName(genericName: string): string {
	return `${genericName}__conformance`
}

// NOTE: A name the COMPILER made up rather than the author — the Constant a
// Pattern holds its value in while it reads the members off, and the internal
// name a Parameter taken apart by one is given. Unspellable in Essence on
// purpose: the Lexer reads `_` as a Symbol, so no Identifier holds one, and the
// `$` keeps it clear of the Rewriter's own `_self`.
//
// Asked in three places that can none of them see the Enricher's own flag: a
// Hover reads a typed Identifier, the debug adapter reads a JavaScript binding
// name, and a Diagnostic reads whatever the Validator was handed. They must
// agree, so they agree here.
export function isSynthesizedName(name: string): boolean {
	return /^\$(pattern|parameter)_\d+_\d+$/.test(name)
}

// NOTE: The name a Parameter's body reads it under, where that is ONE name. A
// Parameter whose internal name is a Pattern has none: it brings in as many
// names as the Pattern binds, and no one of them is what the Parameter is
// called. Everything that documents, labels or describes a Parameter asks here,
// and falls back to the label — which a Pattern never replaces.
export function parameterInternalName(
	parameter: parser.ParameterNode,
): parser.IdentifierNode | null {
	return parameter.internalName?.nodeType === "Identifier"
		? parameter.internalName
		: null
}
