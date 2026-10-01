import {
	caseDefaults,
	memberExpression,
	parameterDefaults,
} from "@essence-lang/compiler/helpers"
import type { common, parser } from "@essence-lang/interfaces"

import { assertionExpressions } from "./assertionChildren"
import { defineExpressions } from "./defineArmChildren"
import { methodsOf, nativeSignaturesOf } from "./namespaceMembers"
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
		collectCases(body, tokens)
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

// A Case is named at its declaration, in a `#Case` value and in a
// `case #Case` Matcher. The `#` keeps its grammar scope as punctuation. These
// Tokens never overlap the index's, which cannot bind a Case name.
function collectCases(
	nodes: Array<parser.ImplementationNode>,
	tokens: Array<SemanticToken>,
) {
	for (let node of nodes) {
		collectCasesFromNode(node, tokens)
	}
}

// A Parameter default holds Expressions, such as the Case in `= #None`.
function collectCasesFromDefinition(
	definition: parser.FunctionDefinitionNode,
	tokens: Array<SemanticToken>,
) {
	collectCasesFromDefaults(definition.parameters, tokens)
	collectCases(definition.body, tokens)
}

function collectCasesFromDefaults(
	parameters: Array<parser.ParameterNode>,
	tokens: Array<SemanticToken>,
) {
	for (let defaultValue of parameterDefaults(parameters)) {
		collectCasesFromNode(defaultValue, tokens)
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

			// A payload default holds Case values too, such as `#Empty`.
			for (let defaultValue of caseDefaults(node.cases)) {
				collectCasesFromNode(defaultValue, tokens)
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
		// An arm holds Case values too, as in `as #Empty if …`.
		case "Define":
			for (let expression of defineExpressions(node)) {
				collectCasesFromNode(expression, tokens)
			}

			return
		case "NamespaceDefinitionStatement":
			for (let property of Object.values(node.properties)) {
				// A native static Property has no value.
				if (property.value !== null) {
					collectCasesFromNode(property.value, tokens)
				}
			}

			// An `overload` block may mix bodied Methods and native signatures; see
			// `namespaceMembers`.
			for (let member of Object.values(node.methods)) {
				for (let method of methodsOf(member)) {
					collectCasesFromDefinition(method.value, tokens)
				}

				for (let signature of nativeSignaturesOf(member)) {
					collectCasesFromDefaults(signature.parameters, tokens)
				}
			}

			return
		case "ProtocolDeclarationStatement":
			for (let member of Object.values(node.methods)) {
				let signatures =
					member.nodeType === "OverloadedProtocolMethod" ||
					member.nodeType === "OverloadedStaticProtocolMethod"
						? member.signatures
						: [member.signature]

				for (let { body } of signatures) {
					if (body !== null) {
						collectCasesFromDefinition(body.value, tokens)
					}
				}
			}

			return
		case "FunctionStatement":
			collectCasesFromDefinition(node.value, tokens)
			return
		case "OverloadedFunctionStatement":
			for (let method of node.methods) {
				if (method.nodeType === "FunctionValue") {
					collectCasesFromDefinition(method.value, tokens)
				} else {
					collectCasesFromDefaults(method.parameters, tokens)
				}
			}

			return
		case "FunctionValue":
			collectCasesFromDefinition(node.value, tokens)
			return
		case "ConstantDeclarationStatement":
		case "VariableDeclarationStatement":
		case "VariableAssignmentStatement":
			collectCasesFromNode(node.value, tokens)
			return
		case "ReturnStatement":
			collectCasesFromNode(node.expression, tokens)
			return
		case "ExpectStatement":
		case "RequireStatement":
			for (let expression of assertionExpressions(node)) {
				collectCasesFromNode(expression, tokens)
			}

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
				collectCasesFromNode(memberExpression(member), tokens)
			}

			return
		case "ListValue":
			for (let value of node.values) {
				collectCasesFromNode(value, tokens)
			}

			return
		case "DictionaryValue":
			for (let entry of node.entries) {
				collectCasesFromNode(entry.key, tokens)
				collectCasesFromNode(entry.value, tokens)
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
		case "Start":
		case "Complete":
			collectCasesFromNode(node.expression, tokens)
			return
		case "RefusedValue":
			collectCasesFromNode(node.base, tokens)
			return
		// A path holds no Case; its steps colour as members through the index.
		case "MemberPath":
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
