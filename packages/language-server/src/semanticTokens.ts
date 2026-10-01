import {
	forEachParserChild,
	type ParserNode,
} from "@essence-lang/compiler/visitor"
import type { common, parser } from "@essence-lang/interfaces"

import { type DeclarationKind, indexProgram, type ProgramIndex } from "./rename"
import { programBodies } from "./sections"

// Semantic Tokens classify Identifiers by what they resolve to, mostly as a
// projection of the rename index. An unresolved name gets no Token, leaving
// the TextMate grammar's reading. Case names come from the Parser AST.

type SemanticTokenType =
	| "namespace"
	| "type"
	| "typeParameter"
	| "parameter"
	| "variable"
	| "property"
	| "function"
	| "method"
	| "enumMember"

type SemanticTokenModifier =
	| "declaration"
	| "readonly"
	| "static"
	| "defaultLibrary"

// The legend the server hands the client; Tokens carry indices into it. New
// entries go at the end, or a client holding the old legend recolours tokens.
export const semanticTokenTypes: Array<SemanticTokenType> = [
	"namespace",
	"type",
	"typeParameter",
	"parameter",
	"variable",
	"property",
	"function",
	"method",
	"enumMember",
]

export const semanticTokenModifiers: Array<SemanticTokenModifier> = [
	"declaration",
	"readonly",
	"static",
	"defaultLibrary",
]

type SemanticToken = {
	line: number
	column: number
	length: number
	type: SemanticTokenType
	modifiers: Array<SemanticTokenModifier>
}

// `import` gets no Token: one file's index cannot say what the other Module
// declared, so the TextMate grammar's reading stands.
const tokenTypes: Record<DeclarationKind, SemanticTokenType | null> = {
	import: null,
	constant: "variable",
	variable: "variable",
	function: "function",
	parameter: "parameter",
	namespace: "namespace",
	protocol: "type",
	type: "type",
	generic: "typeParameter",
	method: "method",
	staticMethod: "method",
	property: "property",
	member: "property",
	label: "parameter",
}

// What cannot be reassigned is `readonly`: Constants, Functions, Namespaces,
// Parameters and `@`.
const readonlyKinds = new Set<DeclarationKind>([
	"constant",
	"function",
	"namespace",
	"protocol",
	"parameter",
	"type",
	"generic",
	"method",
	"staticMethod",
	"label",
])

// `programIndex` is the document's own index where the caller holds one;
// building one rebuilds the builtin Scope, on every keystroke.
export function findSemanticTokens(
	program: parser.Program,
	enrichedProgram: common.typed.Program | null = null,
	programIndex: ProgramIndex | null = null,
): Array<SemanticToken> {
	let { index } = programIndex ?? indexProgram(program, enrichedProgram)
	let tokens: Array<SemanticToken> = []

	// Every body the Program holds, test bodies included.
	for (let body of programBodies(program)) {
		for (let node of body) {
			collectCases(node, tokens)
		}
	}

	for (let occurrence of index) {
		let { position, declaration } = occurrence
		let type = tokenTypes[declaration.kind]

		if (type === null) {
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

		// Tells a name the standard library gave from one the user wrote. The index
		// holds builtins for shadowing, though no rename targets them.
		if (declaration.builtin) {
			modifiers.push("defaultLibrary")
		}

		pushToken(tokens, position, type, modifiers)
	}

	return sortTokens(tokens)
}

// Identifiers never span lines; a multi-line Position would corrupt every
// later Token.
function pushToken(
	tokens: Array<SemanticToken>,
	position: common.Position,
	type: SemanticTokenType,
	modifiers: Array<SemanticTokenModifier>,
) {
	if (position.start.line !== position.end.line) {
		return
	}

	tokens.push({
		line: position.start.line,
		column: position.start.column,
		length: position.end.column - position.start.column,
		type,
		modifiers,
	})
}

// A Case is named at its declaration, in a `#Case` value and in a Case
// Matcher, as in `case #Case` and `require #Case(item) = …`. The `#` keeps its
// grammar scope as punctuation. These Tokens never overlap the index's, which
// cannot bind a Case name.
function collectCases(node: ParserNode, tokens: Array<SemanticToken>) {
	switch (node.nodeType) {
		case "ChoiceDeclarationStatement":
			for (let choiceCase of node.cases) {
				pushToken(tokens, choiceCase.name.position, "enumMember", [
					"declaration",
				])
			}

			break
		case "CaseValue":
		case "CaseMatcher":
			pushToken(tokens, node.caseName.position, "enumMember", [])
			break
	}

	forEachParserChild(node, collectCases, tokens)
}

// The protocol forbids overlapping Tokens, and a member of two same-named
// Namespaces is indexed twice, so repeats of a Position are dropped.
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

// Flat quintuples relative to the previous Token: line delta, column delta
// on the same line, length, Type index, Modifier bits.
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
