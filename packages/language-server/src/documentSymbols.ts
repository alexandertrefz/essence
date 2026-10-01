import { patternBindings } from "@essence-lang/compiler/helpers"
import {
	printCaseWithPayload,
	printSignatureSummary,
	printType,
	signaturesOf,
	withProtocolSpellings,
} from "@essence-lang/compiler/printType"
import {
	forEachParserChild,
	forEachTypedChild,
	type ParserNode,
	type TypedNode,
} from "@essence-lang/compiler/visitor"
import type { common, parser } from "@essence-lang/interfaces"

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
	let symbols: Array<DocumentSymbolEntry> = []

	collectSymbols(program.implementation, symbols)

	// The tests, read off the Parser too. A test or suite is named by a String,
	// shown as written.
	if (program.tests !== null) {
		collectSymbols(program.tests, symbols)
	}

	if (enrichedProgram !== null) {
		symbols = withDetails(
			symbols,
			withProtocolSpellings(
				protocolSpellings(enrichedProgram, imported),
				() => detailsOf(enrichedProgram),
			),
		)
	}

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

// Each entry `node` declares joins `into`. A named construct collects what it
// holds as its own children, and any other node is transparent.
function collectSymbols(
	node: ParserNode,
	into: Array<DocumentSymbolEntry>,
): void {
	switch (node.nodeType) {
		case "ConstantDeclarationStatement":
		case "VariableDeclarationStatement":
			into.push(declarationSymbol(node))
			return
		case "FunctionStatement":
		case "OverloadedFunctionStatement":
			into.push(owning(node, entry(node.name, "function", node.position)))
			return
		case "TypeAliasStatement":
			into.push(
				owning(
					node,
					entry(
						node.name,
						"typeAlias",
						node.position,
						recordTypeMembers(node.type),
					),
				),
			)
			return
		case "ChoiceDeclarationStatement":
			into.push(choiceSymbol(node))
			return
		case "NamespaceDefinitionStatement":
			into.push(namespaceSymbol(node))
			return
		case "ProtocolDeclarationStatement":
			into.push(protocolSymbol(node))
			return
		case "Test":
		case "Suite":
			into.push(
				owning(node, {
					name: writtenName(node.name),
					kind: node.nodeType === "Test" ? "test" : "suite",
					detail: modifierDetail(node.modifiers),
					range: node.position,
					selectionRange: node.name.position,
					children: [],
				}),
			)
			return
	}

	forEachParserChild(node, collectSymbols, into)
}

// The entry, with what `node` holds as its children.
function owning(
	node: ParserNode,
	symbol: DocumentSymbolEntry,
): DocumentSymbolEntry {
	forEachParserChild(node, collectSymbols, symbol.children)

	return symbol
}

function entry(
	name: parser.IdentifierNode,
	kind: DocumentSymbolKind,
	range: common.Position,
	children: Array<DocumentSymbolEntry> = [],
): DocumentSymbolEntry {
	return {
		name: name.content,
		kind,
		detail: null,
		range,
		selectionRange: name.position,
		children,
	}
}

// A Declaration whose name is a Pattern is one entry, titled by what it binds,
// with a child per bound name.
function declarationSymbol(
	node:
		| parser.ConstantDeclarationStatementNode
		| parser.VariableDeclarationStatementNode,
): DocumentSymbolEntry {
	let kind: DocumentSymbolKind =
		node.nodeType === "ConstantDeclarationStatement"
			? "constant"
			: "variable"

	if (node.name.nodeType !== "Pattern") {
		return owning(node, entry(node.name, kind, node.position))
	}

	let bindings = patternBindings(node.name)

	return owning(node, {
		name: `{ ${bindings.map((binding) => binding.name.content).join(", ")} }`,
		kind,
		detail: null,
		range: node.position,
		selectionRange: node.name.position,
		children: bindings.map((binding) => ({
			name: binding.name.content,
			kind,
			detail: null,
			range: binding.name.position,
			selectionRange: binding.name.position,
			children: [],
		})),
	})
}

function choiceSymbol(
	node: parser.ChoiceDeclarationStatementNode,
): DocumentSymbolEntry {
	let cases = node.cases.map((choiceCase) => ({
		name: `#${choiceCase.name.content}`,
		kind: "case" as const,
		detail: null,
		// The range runs to the end of the payload default, which may declare an
		// entry of its own.
		range: unionOfPositions(
			choiceCase.name.position,
			choiceCase.defaultValue?.position ??
				choiceCase.type?.position ??
				choiceCase.name.position,
		),
		selectionRange: choiceCase.name.position,
		children:
			choiceCase.type === null ? [] : recordTypeMembers(choiceCase.type),
	}))
	let symbol = entry(node.name, "choice", node.position, cases)

	forEachParserChild(node, (child, _state, _field, key, container) => {
		collectSymbols(
			child,
			container === "cases"
				? cases[key as number].children
				: symbol.children,
		)
	})

	return symbol
}

// Each property and Method collects what its own value, defaults and bodies
// declare.
function namespaceSymbol(
	node: parser.NamespaceDefinitionStatementNode,
): DocumentSymbolEntry {
	let properties = new Map<string, DocumentSymbolEntry>()
	let methods = new Map<string, DocumentSymbolEntry>()

	for (let [key, property] of Object.entries(node.properties)) {
		properties.set(key, {
			name: property.name.content,
			kind: "property",
			detail: null,
			range: unionOfPositions(
				property.name.position,
				// A native static Property has no value, so its range is its name.
				property.value?.position ?? property.name.position,
			),
			selectionRange: property.name.position,
			children: [],
		})
	}

	for (let [key, member] of Object.entries(node.methods)) {
		let overloads =
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

		for (let overload of overloads) {
			range = unionOfPositions(range, overload.position)
		}

		methods.set(key, {
			name: member.name.content,
			kind: isStatic ? "staticMethod" : "method",
			detail: null,
			range,
			selectionRange: member.name.position,
			children: [],
		})
	}

	let symbol = entry(node.name, "namespace", node.position, [
		...properties.values(),
		...methods.values(),
	])

	forEachParserChild(node, (child, _state, field, key, container) => {
		let owner =
			container === "properties"
				? properties.get(key as string)
				: field === "methods"
					? methods.get(key as string)
					: symbol

		collectSymbols(child, (owner ?? symbol).children)
	})

	return symbol
}

function protocolSymbol(
	node: parser.ProtocolDeclarationStatementNode,
): DocumentSymbolEntry {
	let members = new Map<string, DocumentSymbolEntry>()

	for (let [key, member] of Object.entries(node.methods)) {
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
			// A provided Method's symbol spans its block too, so the outline selects it.
			range = unionOfPositions(
				range,
				signature.body?.position ?? signature.position,
			)
		}

		members.set(key, {
			name: member.name.content,
			kind: isStatic ? "staticMethod" : "method",
			detail: null,
			range,
			selectionRange: member.name.position,
			children: [],
		})
	}

	let symbol = entry(node.name, "protocol", node.position, [
		...members.values(),
	])

	forEachParserChild(node, (child, _state, field, key) => {
		let owner = field === "methods" ? members.get(key as string) : symbol

		collectSymbols(child, (owner ?? symbol).children)
	})

	return symbol
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
	// A test or suite keeps its Modifiers, since no Type stands at its name.
	return symbols.map((symbol) => ({
		...symbol,
		detail:
			details.get(cursorKey(symbol.selectionRange.start)) ??
			symbol.detail,
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
		for (let node of body) {
			collectDetails(node, details)
		}
	}

	return details
}

function collectDetails(node: TypedNode, details: Details): void {
	switch (node.nodeType) {
		case "ConstantDeclarationStatement":
		case "VariableDeclarationStatement":
			record(details, node.name.position.start, typeDetail(node.type))
			break
		case "FunctionStatement":
			record(
				details,
				node.name.position.start,
				signatureDetail(node.type),
			)
			break
		case "NamespaceDefinitionStatement":
			recordMemberDetails(node, details)
			break
		case "ChoiceDeclarationStatement":
			for (let choiceCase of node.cases) {
				record(
					details,
					choiceCase.name.position.start,
					printCaseWithPayload(choiceCase.type),
				)
			}

			break
	}

	forEachTypedChild(node, collectDetails, details)
}

function recordMemberDetails(
	node: common.typed.NamespaceDefinitionStatementNode,
	details: Details,
) {
	for (let property of Object.values(node.properties)) {
		record(details, property.name.position.start, typeDetail(property.type))
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
