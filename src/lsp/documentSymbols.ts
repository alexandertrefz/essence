import type { common, parser } from "../interfaces/index"
import { isAtOrBefore } from "./positions"

// NOTE: The outline is built from the Parser AST alone — it must work while
// the Program has Type errors. Top level Statements become symbols;
// Namespaces contribute their Properties and Methods as children, Record
// Type Aliases their members.

export type DocumentSymbolKind =
	| "constant"
	| "variable"
	| "function"
	| "namespace"
	| "protocol"
	| "typeAlias"
	| "choice"
	| "case"
	| "member"
	| "method"
	| "staticMethod"
	| "property"

export type DocumentSymbolEntry = {
	name: string
	kind: DocumentSymbolKind
	// NOTE: `range` spans the whole construct, `selectionRange` just the
	// name — mirroring the LSP's DocumentSymbol.
	range: common.Position
	selectionRange: common.Position
	children: Array<DocumentSymbolEntry>
}

export function findDocumentSymbols(
	program: parser.Program,
): Array<DocumentSymbolEntry> {
	let symbols: Array<DocumentSymbolEntry> = []

	for (let node of program.implementation.nodes) {
		let symbol = symbolForStatement(node)

		if (symbol !== null) {
			symbols.push(symbol)
		}
	}

	return symbols
}

function symbolForStatement(
	node: parser.ImplementationNode,
): DocumentSymbolEntry | null {
	switch (node.nodeType) {
		case "ConstantDeclarationStatement":
			return {
				name: node.name.content,
				kind: "constant",
				range: node.position,
				selectionRange: node.name.position,
				children: [],
			}
		case "VariableDeclarationStatement":
			return {
				name: node.name.content,
				kind: "variable",
				range: node.position,
				selectionRange: node.name.position,
				children: [],
			}
		case "FunctionStatement":
			return {
				name: node.name.content,
				kind: "function",
				range: node.position,
				selectionRange: node.name.position,
				children: [],
			}
		case "TypeAliasStatement":
			return {
				name: node.name.content,
				kind: "typeAlias",
				range: node.position,
				selectionRange: node.name.position,
				children: recordTypeMembers(node.type),
			}
		case "ChoiceDeclarationStatement":
			return {
				name: node.name.content,
				kind: "choice",
				range: node.position,
				selectionRange: node.name.position,
				children: node.cases.map((choiceCase) => ({
					name: `#${choiceCase.name.content}`,
					kind: "case" as const,
					range:
						choiceCase.type === null
							? choiceCase.name.position
							: unionOfPositions(
									choiceCase.name.position,
									choiceCase.type.position,
								),
					selectionRange: choiceCase.name.position,
					children: recordTypeMembers(
						choiceCase.type ?? {
							nodeType: "RecordTypeDeclaration",
							members: {},
							position: choiceCase.name.position,
						},
					),
				})),
			}
		case "NamespaceDefinitionStatement":
			return {
				name: node.name.content,
				kind: "namespace",
				range: node.position,
				selectionRange: node.name.position,
				children: namespaceMembers(node),
			}
		case "ProtocolDeclarationStatement":
			return {
				name: node.name.content,
				kind: "protocol",
				range: node.position,
				selectionRange: node.name.position,
				children: protocolMembers(node),
			}
		default:
			return null
	}
}

function protocolMembers(
	node: parser.ProtocolDeclarationStatementNode,
): Array<DocumentSymbolEntry> {
	let members: Array<DocumentSymbolEntry> = []

	for (let member of Object.values(node.methods)) {
		let signatures =
			member.nodeType === "OverloadedProtocolMethod" ||
			member.nodeType === "OverloadedStaticProtocolMethod"
				? member.signatures
				: [member.signature]

		let isStatic =
			member.nodeType === "StaticProtocolMethod" ||
			member.nodeType === "OverloadedStaticProtocolMethod"

		let range = member.name.position

		for (let signature of signatures) {
			range = unionOfPositions(range, signature.position)
		}

		members.push({
			name: member.name.content,
			kind: isStatic ? "staticMethod" : "method",
			range,
			selectionRange: member.name.position,
			children: [],
		})
	}

	return members
}

function recordTypeMembers(
	type: parser.TypeDeclarationNode,
): Array<DocumentSymbolEntry> {
	if (type.nodeType !== "RecordTypeDeclaration") {
		return []
	}

	return Object.values(type.members).map((member) => {
		return {
			name: member.name.content,
			kind: "member" as const,
			range: unionOfPositions(member.name.position, member.type.position),
			selectionRange: member.name.position,
			children: [],
		}
	})
}

function namespaceMembers(
	node: parser.NamespaceDefinitionStatementNode,
): Array<DocumentSymbolEntry> {
	let members: Array<DocumentSymbolEntry> = []

	for (let property of Object.values(node.properties)) {
		members.push({
			name: property.name.content,
			kind: "property",
			range: unionOfPositions(
				property.name.position,
				property.value.position,
			),
			selectionRange: property.name.position,
			children: [],
		})
	}

	for (let member of Object.values(node.methods)) {
		let methods =
			member.nodeType === "OverloadedMethod" ||
			member.nodeType === "OverloadedStaticMethod"
				? member.methods
				: [member.method]

		let isStatic =
			member.nodeType === "StaticMethod" ||
			member.nodeType === "OverloadedStaticMethod"

		// NOTE: The Method wrappers carry no Position of their own — the
		// range is the span from the name to the end of the last overload.
		let range = member.name.position

		for (let method of methods) {
			range = unionOfPositions(range, method.position)
		}

		members.push({
			name: member.name.content,
			kind: isStatic ? "staticMethod" : "method",
			range,
			selectionRange: member.name.position,
			children: [],
		})
	}

	return members
}

function unionOfPositions(
	a: common.Position,
	b: common.Position,
): common.Position {
	return {
		start: isAtOrBefore(a.start, b.start) ? a.start : b.start,
		end: isAtOrBefore(a.end, b.end) ? b.end : a.end,
	}
}
