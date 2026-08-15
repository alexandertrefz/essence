import type { common, parser } from "@essence-lang/interfaces"

import { type DeclarationKind, indexProgram, type ProgramIndex } from "./rename"

// NOTE: Semantic Tokens classify Identifiers by what they actually resolve
// to, which the TextMate grammar cannot do — it has no way to tell a
// Namespace from a Type from a Constant. Every Occurrence the rename index
// already collects carries its Declaration's kind, so this is mostly a
// projection of that index rather than a separate walk.
//
// Identifiers the Enricher cannot resolve are absent from the index and get
// no Token, leaving the TextMate grammar's guess in place.
//
// Case names are the one construct the index cannot answer for — they resolve
// through their Choice instead of through a Scope, so nothing ever binds them
// to a Declaration. They are collected from the Parser AST instead.

export type SemanticTokenType =
	| "namespace"
	| "type"
	| "typeParameter"
	| "parameter"
	| "variable"
	| "property"
	| "function"
	| "method"
	| "enumMember"

export type SemanticTokenModifier =
	| "declaration"
	| "readonly"
	| "static"
	| "defaultLibrary"

// NOTE: These two arrays ARE the legend the server hands the client — a Token
// carries indices into them, never names. New entries therefore go at the END:
// inserting one anywhere else silently recolours every Token past it in
// editors that are still holding a response encoded against the old legend.
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

export type SemanticToken = {
	line: number
	column: number
	length: number
	type: SemanticTokenType
	modifiers: Array<SemanticTokenModifier>
}

// NOTE: `import` carries no Token of its own. What an entry binds is whatever
// the exporting Module declared — a Type, a Namespace, a Function — and one
// file's index can not say which, so colouring it as any one of them would be
// wrong wherever the guess missed. Nothing is emitted instead, and the
// TextMate grammar's own reading of the name stands, exactly as it does for
// every Identifier the Enricher could not resolve.
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

// NOTE: Everything that cannot be reassigned is `readonly` — the Enricher
// treats Constants, Functions, Namespaces, Parameters and `@` as constant.
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

// NOTE: `programIndex` is the document's own index where the caller holds one.
// Building it rebuilds the whole builtin top level Scope — every builtin value
// and Type as fresh Declarations, because the walk records occurrences onto
// them — and this request fires on every keystroke over the whole file.
export function findSemanticTokens(
	program: parser.Program,
	enrichedProgram: common.typed.Program | null = null,
	programIndex: ProgramIndex | null = null,
): Array<SemanticToken> {
	let { index } = programIndex ?? indexProgram(program, enrichedProgram)
	let tokens: Array<SemanticToken> = []

	collectCases(program.implementation.nodes, tokens)

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

		// NOTE: What separates a name the standard library gave the user from
		// one the user wrote. Builtins reach here because the index has to hold
		// them for shadowing to resolve, even though it rejects them as rename
		// targets.
		if (declaration.builtin) {
			modifiers.push("defaultLibrary")
		}

		pushToken(tokens, position, type, modifiers)
	}

	return sortTokens(tokens)
}

// NOTE: Identifiers never span lines — a multi-line Position would be a
// Parser bug, and encoding it would corrupt every following Token.
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

// NOTE: The three places a Case is named: its declaration, the `#Case` value
// that constructs it and the `case #Case` Matcher. The `#` sigil is not part
// of the name's Position and deliberately keeps its grammar scope — a Case
// reads the same at its declaration, where no sigil is written at all, and the
// sigil is punctuation the way `::` and `.` are.
//
// These Tokens are merged into the same list the index fills before it is
// sorted, which is what keeps the encoding well formed: nothing here can
// collide with an indexed Position, because a Case name is precisely what the
// index cannot bind. The `Choice` prefix of a qualified Case is a Type
// reference the index does hold, and it sits before the `#`.
function collectCases(
	nodes: Array<parser.ImplementationNode>,
	tokens: Array<SemanticToken>,
) {
	for (let node of nodes) {
		collectCasesFromNode(node, tokens)
	}
}

function collectCasesFromNode(
	node: parser.ImplementationNode,
	tokens: Array<SemanticToken>,
) {
	switch (node.nodeType) {
		case "ChoiceDeclarationStatement":
			for (let choiceCase of node.cases) {
				pushToken(tokens, choiceCase.name.position, "enumMember", [
					"declaration",
				])
			}

			return
		case "CaseValue":
			pushToken(tokens, node.caseName.position, "enumMember", [])

			if (node.value !== null) {
				collectCasesFromNode(node.value, tokens)
			}

			return
		case "Match":
			collectCasesFromNode(node.value, tokens)

			for (let handler of node.handlers) {
				if (handler.matcher.nodeType === "CaseMatcher") {
					pushToken(
						tokens,
						handler.matcher.caseName.position,
						"enumMember",
						[],
					)
				}

				if (handler.guard !== null) {
					collectCasesFromNode(handler.guard, tokens)
				}

				collectCases(handler.body, tokens)
			}

			return
		case "NamespaceDefinitionStatement":
			for (let property of Object.values(node.properties)) {
				// NOTE: A native static Property has no value.
				if (property.value !== null) {
					collectCasesFromNode(property.value, tokens)
				}
			}

			for (let member of Object.values(node.methods)) {
				if (
					member.nodeType === "SimpleMethod" ||
					member.nodeType === "StaticMethod"
				) {
					collectCases(member.method.value.body, tokens)
				} else if (
					member.nodeType === "OverloadedMethod" ||
					member.nodeType === "OverloadedStaticMethod"
				) {
					for (let method of member.methods) {
						collectCases(method.value.body, tokens)
					}
				} else if (
					member.nodeType === "OverloadedMethodSignatures" ||
					member.nodeType === "OverloadedStaticMethodSignatures"
				) {
					// NOTE: An `overload` block in declarations mode mixes
					// bodied Methods with body-less native signatures.
					for (let method of member.methods) {
						if (method.nodeType === "FunctionValue") {
							collectCases(method.value.body, tokens)
						}
					}
				}
			}

			return
		case "FunctionStatement":
			collectCases(node.value.body, tokens)
			return
		case "OverloadedFunctionStatement":
			for (let method of node.methods) {
				if (method.nodeType === "FunctionValue") {
					collectCases(method.value.body, tokens)
				}
			}

			return
		case "FunctionValue":
			collectCases(node.value.body, tokens)
			return
		case "ConstantDeclarationStatement":
		case "VariableDeclarationStatement":
		case "VariableAssignmentStatement":
			collectCasesFromNode(node.value, tokens)
			return
		case "ReturnStatement":
			collectCasesFromNode(node.expression, tokens)
			return
		case "IfStatement":
			collectCasesFromNode(node.condition, tokens)
			collectCases(node.body, tokens)
			return
		case "IfElseStatement":
			collectCasesFromNode(node.condition, tokens)
			collectCases(node.trueBody, tokens)
			collectCases(node.falseBody, tokens)
			return
		case "MethodInvocation":
			collectCasesFromNode(node.base, tokens)
			collectCasesFromArguments(node.arguments, tokens)
			return
		case "FunctionInvocation":
			collectCasesFromNode(node.name, tokens)
			collectCasesFromArguments(node.arguments, tokens)
			return
		case "RecordValue":
			for (let member of Object.values(node.members)) {
				collectCasesFromNode(member.value, tokens)
			}

			return
		case "ListValue":
			for (let value of node.values) {
				collectCasesFromNode(value, tokens)
			}

			return
		case "InterpolatedStringValue":
			for (let segment of node.segments) {
				if (segment.kind === "expression") {
					collectCasesFromNode(segment.expression, tokens)
				}
			}

			return
		case "Combination":
			collectCasesFromNode(node.lhs, tokens)
			collectCasesFromNode(node.rhs, tokens)
			return
		case "Lookup":
			collectCasesFromNode(node.base, tokens)
			return
		case "ProtocolDeclarationStatement":
		case "TypeAliasStatement":
		case "Identifier":
		case "Self":
		case "StringValue":
		case "IntegerValue":
		case "RationalValue":
		case "BooleanValue":
			return
	}
}

function collectCasesFromArguments(
	nodeArguments: Array<parser.ArgumentNode>,
	tokens: Array<SemanticToken>,
) {
	for (let argument of nodeArguments) {
		collectCasesFromNode(argument.value, tokens)
	}
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
