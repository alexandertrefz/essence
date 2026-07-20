import type { common, parser } from "../interfaces"
import { type DeclarationKind, indexProgram } from "./rename"

// NOTE: Semantic Tokens classify Identifiers by what they actually resolve
// to, which the TextMate grammar cannot do — it has no way to tell a
// Namespace from a Type from a Constant. Every Occurrence the rename index
// already collects carries its Declaration's kind, so this is a projection of
// that index rather than a separate walk.
//
// Identifiers the Enricher cannot resolve are absent from the index and get
// no Token, leaving the TextMate grammar's guess in place.

export type SemanticTokenType =
	| "namespace"
	| "type"
	| "typeParameter"
	| "parameter"
	| "variable"
	| "property"
	| "function"
	| "method"

export type SemanticTokenModifier = "declaration" | "readonly" | "static"

// NOTE: The order here is the protocol's legend — Tokens are encoded as
// indices into it, so it must stay in sync with `tokenTypeIndices`.
export const semanticTokenTypes: Array<SemanticTokenType> = [
	"namespace",
	"type",
	"typeParameter",
	"parameter",
	"variable",
	"property",
	"function",
	"method",
]

export const semanticTokenModifiers: Array<SemanticTokenModifier> = [
	"declaration",
	"readonly",
	"static",
]

export type SemanticToken = {
	line: number
	column: number
	length: number
	type: SemanticTokenType
	modifiers: Array<SemanticTokenModifier>
}

const tokenTypes: Record<DeclarationKind, SemanticTokenType> = {
	constant: "variable",
	variable: "variable",
	function: "function",
	parameter: "parameter",
	namespace: "namespace",
	type: "type",
	generic: "typeParameter",
	method: "method",
	staticMethod: "method",
	property: "property",
	member: "property",
	label: "parameter",
}

// NOTE: Everything that cannot be reassigned is `readonly` — the Enricher
// treats Constants, Functions, Namespaces, Parameters and `@` as constant.
const readonlyKinds = new Set<DeclarationKind>([
	"constant",
	"function",
	"namespace",
	"parameter",
	"type",
	"generic",
	"method",
	"staticMethod",
	"label",
])

export function findSemanticTokens(
	program: parser.Program,
	enrichedProgram: common.typed.Program | null = null,
): Array<SemanticToken> {
	let { index } = indexProgram(program, enrichedProgram)
	let tokens: Array<SemanticToken> = []

	for (let occurrence of index) {
		let { position, declaration } = occurrence

		// NOTE: Identifiers never span lines — a multi-line Position would be
		// a Parser bug, and encoding it would corrupt every following Token.
		if (position.start.line !== position.end.line) {
			continue
		}

		let modifiers: Array<SemanticTokenModifier> = []

		if (
			declaration.definition !== null &&
			declaration.definition.start.line === position.start.line &&
			declaration.definition.start.column === position.start.column
		) {
			modifiers.push("declaration")
		}

		if (readonlyKinds.has(declaration.kind)) {
			modifiers.push("readonly")
		}

		if (declaration.kind === "staticMethod") {
			modifiers.push("static")
		}

		tokens.push({
			line: position.start.line,
			column: position.start.column,
			length: position.end.column - position.start.column,
			type: tokenTypes[declaration.kind],
			modifiers,
		})
	}

	return sortTokens(tokens)
}

// NOTE: The protocol forbids overlapping Tokens, and the index can hold the
// same Identifier twice — a Parameter whose internal name doubles as its call
// site label is one symbol recorded once, but a Namespace member declared in
// two same-named Namespaces is not. Sorting then dropping repeats of a
// Position keeps the encoding well formed.
function sortTokens(tokens: Array<SemanticToken>): Array<SemanticToken> {
	let sorted = [...tokens].sort(
		(a, b) => a.line - b.line || a.column - b.column,
	)

	return sorted.filter((token, tokenIndex) => {
		let previous = sorted[tokenIndex - 1]

		return (
			previous === undefined ||
			previous.line !== token.line ||
			previous.column !== token.column
		)
	})
}

// NOTE: The protocol encodes Tokens as flat quintuples relative to the
// previous Token: line delta, column delta (relative to the previous Token
// only when on the same line), length, Type index, and a Modifier bit set.
export function encodeSemanticTokens(
	tokens: Array<SemanticToken>,
): Array<number> {
	let data: Array<number> = []
	let previousLine = 1
	let previousColumn = 1

	for (let token of tokens) {
		let lineDelta = token.line - previousLine
		let columnDelta =
			lineDelta === 0 ? token.column - previousColumn : token.column - 1

		data.push(
			lineDelta,
			columnDelta,
			token.length,
			semanticTokenTypes.indexOf(token.type),
			encodeModifiers(token.modifiers),
		)

		previousLine = token.line
		previousColumn = token.column
	}

	return data
}

function encodeModifiers(modifiers: Array<SemanticTokenModifier>): number {
	let bits = 0

	for (let modifier of modifiers) {
		bits |= 1 << semanticTokenModifiers.indexOf(modifier)
	}

	return bits
}
