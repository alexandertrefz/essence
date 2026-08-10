import { patternBindings } from "@essence-lang/compiler/helpers"
import {
	printCaseWithPayload,
	printSignatureSummary,
	printType,
	signaturesOf,
} from "@essence-lang/compiler/printType"
import type { common, parser } from "@essence-lang/interfaces"

import { typedHandlerExpressions } from "./matchHandlerChildren"
import { isAtOrBefore } from "./positions"

// NOTE: The outline is built from the Parser AST alone — it must work while
// the Program has Type errors. Top level Statements become symbols;
// Namespaces contribute their Properties and Methods as children, Record
// Type Aliases their members.
//
// A named construct owns the bodies it carries, so a Function declared inside
// a Function is a child of it. An unnamed block — an `if` or `else` body, a
// Match arm, a Function literal passed as an Argument — is transparent
// instead: there is no name to hang an entry on, so what it declares joins the
// enclosing entry rather than nesting a level per block, which is what keeps a
// Match of a dozen arms from burying the outline it sits in.
//
// `detail` is the one thing the Parser cannot answer. An enriched Program may
// be handed in to fill it, matched to the Parser's entries by the Position of
// their names. Without one every detail stays null and the outline is exactly
// what it is without Types — which is the whole point of the Parser-only rule.

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
	| "export"

export type DocumentSymbolEntry = {
	name: string
	kind: DocumentSymbolKind
	// NOTE: The text shown beside the name — a printed Type, a signature, or a
	// Case with its payload. Null whenever no enriched Program was given.
	detail: string | null
	// NOTE: `range` spans the whole construct, `selectionRange` just the
	// name — mirroring the LSP's DocumentSymbol.
	range: common.Position
	selectionRange: common.Position
	children: Array<DocumentSymbolEntry>
}

export function findDocumentSymbols(
	program: parser.Program,
	enrichedProgram: common.typed.Program | null = null,
): Array<DocumentSymbolEntry> {
	let symbols = symbolsOfBody(program.implementation.nodes)

	if (enrichedProgram !== null) {
		symbols = withDetails(symbols, detailsOf(enrichedProgram))
	}

	// NOTE: What this Module publishes, last and under one entry — an outline is
	// read for the declarations, and the export block is the summary of them
	// rather than one more of them. The `import { … }` block is deliberately
	// absent: it names what OTHER Modules declare, and none of it is in this
	// file to navigate to.
	let exportSection = exportSymbols(program)

	return exportSection === null ? symbols : [...symbols, exportSection]
}

// NOTE: No enriched Program is consulted for a detail here. An entry with a
// `from` clause names something no Type in this file describes, and the two
// facts worth showing — where a re-export forwards from, and what an aliased
// entry publishes locally — are both written in the entry itself.
function exportSymbols(program: parser.Program): DocumentSymbolEntry | null {
	let section = program.exports

	if (section === null) {
		return null
	}

	return {
		name: "export",
		kind: "export",
		detail: null,
		range: section.position,
		selectionRange: section.position,
		children: section.entries.map((entry) => {
			let published = entry.alias ?? entry.name

			return {
				name: published.content,
				kind: "export" as const,
				detail:
					entry.source !== null
						? `from "${entry.source.path}"`
						: entry.alias === null
							? null
							: entry.name.content,
				range: entry.position,
				selectionRange: published.position,
				children: [],
			}
		}),
	}
}

function symbolsOfBody(
	nodes: Array<parser.ImplementationNode>,
): Array<DocumentSymbolEntry> {
	return nodes.flatMap(symbolsOfNode)
}

function symbolsOfNode(
	node: parser.ImplementationNode,
): Array<DocumentSymbolEntry> {
	let symbol = symbolForStatement(node)

	if (symbol !== null) {
		return [symbol]
	}

	switch (node.nodeType) {
		case "VariableAssignmentStatement":
			return symbolsOfNode(node.value)
		case "ReturnStatement":
			return symbolsOfNode(node.expression)
		case "IfStatement":
			return [
				...symbolsOfNode(node.condition),
				...symbolsOfBody(node.body),
			]
		case "IfElseStatement":
			return [
				...symbolsOfNode(node.condition),
				...symbolsOfBody(node.trueBody),
				...symbolsOfBody(node.falseBody),
			]
		case "Match":
			return [
				...symbolsOfNode(node.value),
				...node.handlers.flatMap((handler) => [
					...(handler.guard === null
						? []
						: symbolsOfNode(handler.guard)),
					...symbolsOfBody(handler.body),
				]),
			]
		case "FunctionValue":
			return symbolsOfBody(node.value.body)
		case "FunctionInvocation":
			return [
				...symbolsOfNode(node.name),
				...symbolsOfArguments(node.arguments),
			]
		case "MethodInvocation":
			return [
				...symbolsOfNode(node.base),
				...symbolsOfArguments(node.arguments),
			]
		case "Lookup":
			return symbolsOfNode(node.base)
		case "Combination":
			return [...symbolsOfNode(node.lhs), ...symbolsOfNode(node.rhs)]
		case "RecordValue":
			return Object.values(node.members).flatMap((member) =>
				symbolsOfNode(member.value),
			)
		case "ListValue":
			return node.values.flatMap(symbolsOfNode)
		case "InterpolatedStringValue":
			return node.segments.flatMap((segment) =>
				segment.kind === "expression"
					? symbolsOfNode(segment.expression)
					: [],
			)
		case "CaseValue":
			return node.value === null ? [] : symbolsOfNode(node.value)
		default:
			return []
	}
}

function symbolsOfArguments(
	nodeArguments: Array<parser.ArgumentNode>,
): Array<DocumentSymbolEntry> {
	return nodeArguments.flatMap((argument) => symbolsOfNode(argument.value))
}

// NOTE: A Declaration whose name is a Pattern is ONE Statement binding several
// names, and the outline says both: the entry stands for the Statement and is
// titled by what the Pattern binds, with a child per name so that a reader
// looking for `matching` finds it where the outline is searched.
function patternSymbols(
	node:
		| parser.ConstantDeclarationStatementNode
		| parser.VariableDeclarationStatementNode,
	pattern: parser.PatternNode,
	kind: "constant" | "variable",
): DocumentSymbolEntry {
	let bindings = patternBindings(pattern)

	return {
		name: `{ ${bindings.map((binding) => binding.name.content).join(", ")} }`,
		kind,
		detail: null,
		range: node.position,
		selectionRange: pattern.position,
		children: [
			...bindings.map((binding) => ({
				name: binding.name.content,
				kind,
				detail: null,
				range: binding.name.position,
				selectionRange: binding.name.position,
				children: [],
			})),
			...symbolsOfNode(node.value),
		],
	}
}

function symbolForStatement(
	node: parser.ImplementationNode,
): DocumentSymbolEntry | null {
	switch (node.nodeType) {
		case "ConstantDeclarationStatement":
			// NOTE: A Pattern names no one thing, so the outline lists what it
			// BINDS — one entry per name, which is what a reader is looking for
			// when they open the outline to find where `matching` comes from.
			if (node.name.nodeType === "Pattern") {
				return patternSymbols(node, node.name, "constant")
			}

			return {
				name: node.name.content,
				kind: "constant",
				detail: null,
				range: node.position,
				selectionRange: node.name.position,
				children: symbolsOfNode(node.value),
			}
		case "VariableDeclarationStatement":
			if (node.name.nodeType === "Pattern") {
				return patternSymbols(node, node.name, "variable")
			}

			return {
				name: node.name.content,
				kind: "variable",
				detail: null,
				range: node.position,
				selectionRange: node.name.position,
				children: symbolsOfNode(node.value),
			}
		case "FunctionStatement":
			return {
				name: node.name.content,
				kind: "function",
				detail: null,
				range: node.position,
				selectionRange: node.name.position,
				children: symbolsOfBody(node.value.body),
			}
		case "OverloadedFunctionStatement":
			return {
				name: node.name.content,
				kind: "function",
				detail: null,
				range: node.position,
				selectionRange: node.name.position,
				// NOTE: A body-less native signature declares nothing to
				// outline — only the bodied entries do.
				children: node.methods.flatMap((method) =>
					method.nodeType === "FunctionValue"
						? symbolsOfBody(method.value.body)
						: [],
				),
			}
		case "TypeAliasStatement":
			return {
				name: node.name.content,
				kind: "typeAlias",
				detail: null,
				range: node.position,
				selectionRange: node.name.position,
				children: recordTypeMembers(node.type),
			}
		case "ChoiceDeclarationStatement":
			return {
				name: node.name.content,
				kind: "choice",
				detail: null,
				range: node.position,
				selectionRange: node.name.position,
				children: node.cases.map((choiceCase) => ({
					name: `#${choiceCase.name.content}`,
					kind: "case" as const,
					detail: null,
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
				detail: null,
				range: node.position,
				selectionRange: node.name.position,
				children: namespaceMembers(node),
			}
		case "ProtocolDeclarationStatement":
			return {
				name: node.name.content,
				kind: "protocol",
				detail: null,
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
			detail: null,
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
			detail: null,
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
			detail: null,
			range: unionOfPositions(
				property.name.position,
				// NOTE: A native static Property has no value to span to — its
				// range is then just its name.
				property.value?.position ?? property.name.position,
			),
			selectionRange: property.name.position,
			children:
				property.value === null ? [] : symbolsOfNode(property.value),
		})
	}

	for (let member of Object.values(node.methods)) {
		let methods =
			member.nodeType === "OverloadedMethod" ||
			member.nodeType === "OverloadedStaticMethod" ||
			member.nodeType === "OverloadedMethodSignatures" ||
			member.nodeType === "OverloadedStaticMethodSignatures"
				? member.methods
				: member.nodeType === "SimpleMethodSignature" ||
					  member.nodeType === "StaticMethodSignature"
					? [member.signature]
					: [member.method]

		let isStatic =
			member.nodeType === "StaticMethod" ||
			member.nodeType === "OverloadedStaticMethod" ||
			member.nodeType === "StaticMethodSignature" ||
			member.nodeType === "OverloadedStaticMethodSignatures"

		// NOTE: The Method wrappers carry no Position of their own — the
		// range is the span from the name to the end of the last overload.
		let range = member.name.position
		let children: Array<DocumentSymbolEntry> = []

		for (let method of methods) {
			range = unionOfPositions(range, method.position)

			// NOTE: A body-less native signature declares nothing to outline.
			if (method.nodeType === "FunctionValue") {
				children.push(...symbolsOfBody(method.value.body))
			}
		}

		members.push({
			name: member.name.content,
			kind: isStatic ? "staticMethod" : "method",
			detail: null,
			range,
			selectionRange: member.name.position,
			children,
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

/***********/
/* Details */
/***********/

// NOTE: Keyed by the start of the name, which is the one Position the Parser
// and the Enricher are guaranteed to agree on for every entry the outline
// shows — a Namespace Method's wrapper has no Position at all, and a Case's
// span depends on whether it declared a payload.
type Details = Map<string, string>

function withDetails(
	symbols: Array<DocumentSymbolEntry>,
	details: Details,
): Array<DocumentSymbolEntry> {
	return symbols.map((symbol) => ({
		...symbol,
		detail: details.get(cursorKey(symbol.selectionRange.start)) ?? null,
		children: withDetails(symbol.children, details),
	}))
}

function cursorKey(cursor: common.Cursor): string {
	return `${cursor.line}:${cursor.column}`
}

function detailsOf(program: common.typed.Program): Details {
	let details: Details = new Map()

	collectDetails(program.implementation.nodes, details)

	return details
}

function collectDetails(
	nodes: Array<common.typed.ImplementationNode>,
	details: Details,
) {
	for (let node of nodes) {
		collectDetail(node, details)
	}
}

function collectDetail(
	node: common.typed.ImplementationNode,
	details: Details,
) {
	switch (node.nodeType) {
		case "ConstantDeclarationStatement":
		case "VariableDeclarationStatement":
			record(details, node.name.position.start, typeDetail(node.type))
			collectDetail(node.value, details)
			return
		case "VariableAssignmentStatement":
			collectDetail(node.value, details)
			return
		case "FunctionStatement":
			record(
				details,
				node.name.position.start,
				signatureDetail(node.type),
			)
			collectDetails(node.value.body, details)
			return
		case "NamespaceDefinitionStatement":
			for (let property of Object.values(node.properties)) {
				record(
					details,
					property.name.position.start,
					typeDetail(property.type),
				)
				collectDetail(property.value, details)
			}

			for (let [name, member] of Object.entries(node.methods)) {
				let methodType = node.type.methods[name]

				if (methodType !== undefined) {
					record(
						details,
						member.name.position.start,
						signatureDetail(methodType),
					)
				}

				let methods =
					member.nodeType === "OverloadedMethod" ||
					member.nodeType === "OverloadedStaticMethod"
						? member.methods
						: [member.method]

				for (let method of methods) {
					collectDetails(method.value.body, details)
				}
			}

			return
		case "ChoiceDeclarationStatement":
			for (let choiceCase of node.cases) {
				record(
					details,
					choiceCase.name.position.start,
					printCaseWithPayload(choiceCase.type),
				)
			}

			return
		case "IfStatement":
			collectDetail(node.condition, details)
			collectDetails(node.body, details)
			return
		case "IfElseStatement":
			collectDetail(node.condition, details)
			collectDetails(node.trueBody, details)
			collectDetails(node.falseBody, details)
			return
		case "ReturnStatement":
			collectDetail(node.expression, details)
			return
		case "Match":
			collectDetail(node.value, details)

			for (let handler of node.handlers) {
				// NOTE: The Parser walk above outlines whatever a Guard or a
				// Matcher literal declares, so this one has to reach the same
				// Nodes — otherwise those entries are the only ones in the
				// outline with no Type beside them.
				for (let expression of typedHandlerExpressions(handler)) {
					collectDetail(expression, details)
				}

				collectDetails(handler.body, details)
			}

			return
		case "FunctionValue":
			collectDetails(node.value.body, details)
			return
		case "FunctionInvocation":
			collectDetail(node.name, details)
			collectArgumentDetails(node.arguments, details)
			return
		case "MethodInvocation":
			collectDetail(node.base, details)
			collectArgumentDetails(node.arguments, details)
			return
		case "Lookup":
			collectDetail(node.base, details)
			return
		case "Combination":
			collectDetail(node.lhs, details)
			collectDetail(node.rhs, details)
			return
		case "RecordValue":
			for (let member of Object.values(node.members)) {
				collectDetail(member, details)
			}

			return
		case "ListValue":
			for (let value of node.values) {
				collectDetail(value, details)
			}

			return
		case "InterpolatedStringValue":
			for (let segment of node.segments) {
				if (segment.kind === "expression") {
					collectDetail(segment.expression, details)
				}
			}

			return
		case "CaseValue":
			if (node.value !== null) {
				collectDetail(node.value, details)
			}

			return
		default:
			return
	}
}

function collectArgumentDetails(
	nodeArguments: Array<common.typed.ArgumentNode>,
	details: Details,
) {
	for (let argument of nodeArguments) {
		collectDetail(argument.value, details)
	}
}

function record(
	details: Details,
	cursor: common.Cursor,
	detail: string | null,
) {
	if (detail !== null) {
		details.set(cursorKey(cursor), detail)
	}
}

// NOTE: A Type that failed to infer is left without a detail rather than
// labelled `Error` — the Diagnostic already says so, in the place that can
// explain it.
function typeDetail(type: common.Type): string | null {
	return type.type === "Error" ? null : printType(type)
}

// NOTE: Nameless, since the name is right beside it in the outline. Overloads
// past the first are counted rather than spelled out — a detail is one line.
function signatureDetail(type: common.Type): string | null {
	let signatures = signaturesOf(type)

	return signatures === null ? null : printSignatureSummary(signatures)
}
