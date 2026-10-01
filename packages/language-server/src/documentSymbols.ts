import {
	memberExpression,
	patternBindings,
} from "@essence-lang/compiler/helpers"
import {
	printCaseWithPayload,
	printSignatureSummary,
	printType,
	signaturesOf,
	withProtocolSpellings,
} from "@essence-lang/compiler/printType"
import type { common, parser } from "@essence-lang/interfaces"

import { typedAssertionExpressions } from "./assertionChildren"
import { defineExpressions } from "./defineArmChildren"
import { typedHandlerExpressions } from "./matchHandlerChildren"
import { isAtOrBefore } from "./positions"
import { protocolSpellings } from "./protocolSpellings"
import { typedProgramBodies } from "./sections"

// The outline, built from the Parser AST so it works despite Type errors. A
// named construct owns the bodies it carries; an unnamed block is transparent.
// An enriched Program, matched by name Position, fills in `detail`.

type DocumentSymbolKind =
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
	| "test"
	| "suite"

export type DocumentSymbolEntry = {
	name: string
	kind: DocumentSymbolKind
	// The text beside the name: a printed Type, a signature, or a Case with its
	// payload. Null without an enriched Program.
	detail: string | null
	// `range` spans the whole construct, `selectionRange` the name.
	range: common.Position
	selectionRange: common.Position
	children: Array<DocumentSymbolEntry>
}

export function findDocumentSymbols(
	program: parser.Program,
	enrichedProgram: common.typed.Program | null = null,
	// The Protocols the import block bound, so a detail spells a bound as the
	// document does.
	imported: Record<string, common.ProtocolType> = {},
): Array<DocumentSymbolEntry> {
	let symbols = symbolsOfBody(program.implementation.nodes)

	if (enrichedProgram !== null) {
		symbols = withDetails(
			symbols,
			withProtocolSpellings(
				protocolSpellings(enrichedProgram, imported),
				() => detailsOf(enrichedProgram),
			),
		)
	}

	// The tests, read off the Parser too. A test or suite is named by a String,
	// shown as written.
	symbols = [...symbols, ...testsSymbols(program)]

	// What this Module publishes, last and under one entry. The import block is
	// absent: nothing it names is in this file.
	let exportSection = exportSymbols(program)

	return exportSection === null ? symbols : [...symbols, exportSection]
}

// No enriched Program is read for these: an entry's re-export source and its
// alias are written in the entry itself.
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

function testsSymbols(program: parser.Program): Array<DocumentSymbolEntry> {
	return program.tests === null ? [] : testsNodeSymbols(program.tests.nodes)
}

function testsNodeSymbols(
	nodes: Array<parser.TestsNode>,
): Array<DocumentSymbolEntry> {
	return nodes.flatMap((node) => {
		if (node.nodeType === "Test") {
			return [
				{
					name: writtenName(node.name),
					kind: "test" as const,
					detail: modifierDetail(node.modifiers),
					range: node.position,
					selectionRange: node.name.position,
					children: symbolsOfBody(node.body),
				},
			]
		}

		if (node.nodeType === "Suite") {
			return [
				{
					name: writtenName(node.name),
					kind: "suite" as const,
					detail: modifierDetail(node.modifiers),
					range: node.position,
					selectionRange: node.name.position,
					children: testsNodeSymbols(node.nodes),
				},
			]
		}

		return symbolsOfNode(node)
	})
}

// The name as written, braces and all, rather than a rendering nothing has
// run.
function writtenName(
	node: parser.StringValueNode | parser.InterpolatedStringValueNode,
): string {
	if (node.nodeType === "StringValue") {
		return node.value
	}

	return node.segments
		.map((segment) =>
			segment.kind === "text"
				? segment.value
				: segment.expression.nodeType === "Identifier"
					? `{${segment.expression.content}}`
					: "{…}",
		)
		.join("")
}

// The Modifiers as written, as the detail, which tells a skipped test from a
// focused one.
function modifierDetail(
	modifiers: Array<parser.TestModifierNode>,
): string | null {
	return modifiers.length === 0
		? null
		: modifiers.map((modifier) => modifier.name.content).join(" ")
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
		// An arm declares nothing, but a Function literal among its values outlines
		// as any other.
		case "Define":
			return defineExpressions(node).flatMap(symbolsOfNode)
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
		case "Start":
		case "Complete":
			return symbolsOfNode(node.expression)
		case "RefusedValue":
			return symbolsOfNode(node.base)
		case "Combination":
			return [...symbolsOfNode(node.lhs), ...symbolsOfNode(node.rhs)]
		case "RecordValue":
			return Object.values(node.members).flatMap((member) =>
				symbolsOfNode(memberExpression(member)),
			)
		case "ListValue":
			return node.values.flatMap(symbolsOfNode)
		case "DictionaryValue":
			return node.entries.flatMap((entry) => [
				...symbolsOfNode(entry.key),
				...symbolsOfNode(entry.value),
			])
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

// A Declaration whose name is a Pattern is one entry, titled by what it binds,
// with a child per bound name.
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
			// A Pattern names no one thing, so each bound name gets an entry.
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
				// A native signature declares nothing to outline.
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
		let children: Array<DocumentSymbolEntry> = []

		for (let signature of signatures) {
			// A provided Method's symbol spans its block too, so the outline selects it.
			range = unionOfPositions(
				range,
				signature.body?.position ?? signature.position,
			)

			if (signature.body !== null) {
				children.push(...symbolsOfBody(signature.body.value.body))
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
				// A native static Property has no value, so its range is its name.
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

		// The range runs from the name to the end of the last Overload.
		let range = member.name.position
		let children: Array<DocumentSymbolEntry> = []

		for (let method of methods) {
			range = unionOfPositions(range, method.position)

			// A native signature declares nothing to outline.
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

// Keyed by the start of the name, the one Position the Parser and the Enricher
// agree on for every entry.
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

	// The tests section's bodies too, so their Constants show Types.
	for (let body of typedProgramBodies(program)) {
		collectDetails(body, details)
	}

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
		case "ProtocolDeclarationStatement":
			for (let member of Object.values(node.methods)) {
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
		case "ExpectStatement":
		case "RequireStatement":
			for (let expression of typedAssertionExpressions(node)) {
				collectDetail(expression, details)
			}

			return
		case "Match":
			collectDetail(node.value, details)

			for (let handler of node.handlers) {
				// Reaches what a Guard or Matcher literal declares, as the Parser walk does.
				for (let expression of typedHandlerExpressions(handler)) {
					collectDetail(expression, details)
				}

				collectDetails(handler.body, details)
			}

			return
		// Reaches what an arm's value declares, as the Parser walk does.
		case "Define":
			for (let expression of defineExpressions(node)) {
				collectDetail(expression, details)
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
		case "Start":
		case "Complete":
			collectDetail(node.expression, details)
			return
		case "RefusedValue":
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
		case "DictionaryValue":
			for (let entry of node.entries) {
				collectDetail(entry.key, details)
				collectDetail(entry.value, details)
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

// A Type that failed to infer gets no detail; its Diagnostic explains it.
function typeDetail(type: common.Type): string | null {
	return type.type === "Error" ? null : printType(type)
}

// Without the name, which stands beside it. Overloads past the first are
// counted, since a detail is one line.
function signatureDetail(type: common.Type): string | null {
	let signatures = signaturesOf(type)

	return signatures === null ? null : printSignatureSummary(signatures)
}
