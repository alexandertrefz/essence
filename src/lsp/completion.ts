import { enrich } from "../enricher/index"
import type { common } from "../interfaces/index"
import { parseWithDiagnostics } from "../parser/index"
import { type ArgumentContext, findArgumentContext } from "./argumentContext"
import { describe, documentationOf } from "./documentation"
import { matchingNamespaces } from "./namespaces"
import { contains, isAtOrBefore, isSmaller } from "./positions"
import { printSignatureSummary, printType, signaturesOf } from "./printType"
import { buildProbeSource } from "./probe"
import {
	type Declaration,
	type DeclarationKind,
	indexProgram,
	type Scope,
	type ScopeRange,
} from "./rename"

// NOTE: Completion has three modes, told apart by the text immediately
// before the cursor:
//
// - After `::` (optionally with a `<Namespace>` specifier): Methods of every
//   Namespace whose target Type matches the receiver.
// - After `.`: Members of a Record, or the properties and Methods of a
//   Namespace accessed statically.
// - Otherwise: every name visible in lexical Scope at the cursor (from the
//   same Scope model `rename.ts` builds), split into the value or the Type
//   space by what precedes the identifier being typed.
//
// Member and Method completion resolve the receiver's Type with a "probe":
// the document text up to the trigger is re-parsed with `.__lspProbe`
// appended (and enough closing brackets to balance it back into a valid
// Program) — the enriched Program's Lookup node for that synthetic member
// carries the receiver's Type in `base.type`, at the Scope the cursor is
// actually in (its enclosing Function's Parameters, `@`, and so on).

export type CompletionEntry = {
	label: string
	kind: DeclarationKind
	detail: string | null
	// NOTE: The description alone — a Completion list has no room for the
	// tagged sections, and Signature Help shows them the moment the call is
	// actually being written.
	documentation?: string | null
}

// NOTE: Must be a valid Identifier on its own — `_` and `-` are Symbols, and
// a leading `__` is the Native Function convention, so a plain camelCase
// name is used instead.
const probeMemberName = "lspProbeMember"

// NOTE: Mirrors `forbiddenIdentifierCharacters` in rename.ts — anything the
// Lexer would not produce as part of a single Identifier Token.
const identifierTail = /[^\s"§(){}[\]<>|/@,.:=~_-]*$/
const methodTriggerPattern = /::(?:<([^>]*)>)?[^\s"§(){}[\]<>|/@,.:=~_-]*$/
const memberTriggerPattern = /\.[^\s"§(){}[\]<>|/@,.:=~_-]*$/
// NOTE: A Namespace specifier that is still being typed — the closing `>` is
// missing, so `methodTriggerPattern` cannot match it yet.
const specifierTriggerPattern = /::<[^\s"§(){}[\]<>|/@,.:=~_-]*$/

export function findCompletions(
	documentText: string,
	cursor: common.Cursor,
): Array<CompletionEntry> {
	let lines = documentText.split("\n")
	let currentLine = lines[cursor.line - 1] ?? ""
	let beforeCursor = currentLine.slice(0, cursor.column - 1)

	let specifierMatch = specifierTriggerPattern.exec(beforeCursor)
	let methodMatch =
		specifierMatch === null ? methodTriggerPattern.exec(beforeCursor) : null
	let memberMatch =
		specifierMatch === null && methodMatch === null
			? memberTriggerPattern.exec(beforeCursor)
			: null
	let match = specifierMatch ?? methodMatch ?? memberMatch

	if (match !== null) {
		let headText = [
			...lines.slice(0, cursor.line - 1),
			beforeCursor.slice(0, match.index),
		].join("\n")

		let baseType = resolveProbedBaseType(headText)

		if (baseType === null) {
			return []
		}

		if (specifierMatch !== null) {
			return specifierCompletions(documentText, baseType)
		}

		return methodMatch !== null
			? methodCompletions(documentText, baseType, methodMatch[1] ?? null)
			: memberCompletions(baseType)
	}

	// NOTE: Record member names and Argument labels are offered *alongside*
	// the names in Scope — both are valid at those positions, since a member
	// is written `name = value` and a labelled Argument `label value`.
	return [
		...contextualCompletions(lines, cursor),
		...scopeCompletions(documentText, cursor, beforeCursor),
	]
}

/*******************************/
/* Record members and labels   */
/*******************************/

function contextualCompletions(
	lines: Array<string>,
	cursor: common.Cursor,
): Array<CompletionEntry> {
	let headText = [
		...lines.slice(0, cursor.line - 1),
		(lines[cursor.line - 1] ?? "").slice(0, cursor.column - 1),
	].join("\n")

	let context: ArgumentContext | null = null

	try {
		let { program } = parseWithDiagnostics(buildProbeSource(headText))
		let { program: enrichedProgram } = enrich(program)

		context = findArgumentContext(enrichedProgram, cursor)
	} catch {
		return []
	}

	if (context === null) {
		return []
	}

	if (context.kind === "record") {
		return Object.entries(context.memberTypes)
			.filter(([name]) => !context.presentMembers.includes(name))
			.map(([name, type]) => ({
				label: name,
				kind: "member" as const,
				detail: printType(type),
			}))
	}

	return context.parameters
		.filter(
			(parameter): parameter is { name: string; type: common.Type } =>
				parameter.name !== null &&
				!context.usedLabels.includes(parameter.name),
		)
		.map((parameter) => ({
			label: parameter.name,
			kind: "label" as const,
			detail: printType(parameter.type),
		}))
}

/*********************************/
/* Probing for the receiver Type */
/*********************************/

function resolveProbedBaseType(headText: string): common.Type | null {
	let probeSource = buildProbeSource(headText, `.${probeMemberName}`)

	try {
		let { program } = parseWithDiagnostics(probeSource)
		let { program: enrichedProgram } = enrich(program)

		return (
			findProbeLookup(enrichedProgram.implementation.nodes)?.base.type ??
			null
		)
	} catch {
		return null
	}
}

function findProbeLookup(
	nodes: Array<common.typed.ImplementationNode>,
): common.typed.LookupNode | null {
	for (let node of nodes) {
		let found = findProbeLookupInNode(node)

		if (found !== null) {
			return found
		}
	}

	return null
}

function findProbeLookupInNode(
	node: common.typed.ImplementationNode,
): common.typed.LookupNode | null {
	switch (node.nodeType) {
		case "ConstantDeclarationStatement":
		case "VariableDeclarationStatement":
		case "VariableAssignmentStatement":
			return findProbeLookupInNode(node.value)
		case "FunctionStatement":
			return findProbeLookup(node.value.body)
		case "NamespaceDefinitionStatement": {
			for (let property of Object.values(node.properties)) {
				let found = findProbeLookupInNode(property.value)

				if (found !== null) {
					return found
				}
			}

			for (let member of Object.values(node.methods)) {
				let methods =
					member.nodeType === "OverloadedMethod" ||
					member.nodeType === "OverloadedStaticMethod"
						? member.methods
						: [member.method]

				for (let method of methods) {
					let found = findProbeLookup(method.value.body)

					if (found !== null) {
						return found
					}
				}
			}

			return null
		}
		case "IfStatement": {
			let found = findProbeLookupInNode(node.condition)

			return found ?? findProbeLookup(node.body)
		}
		case "IfElseStatement": {
			let found = findProbeLookupInNode(node.condition)

			return (
				found ??
				findProbeLookup(node.trueBody) ??
				findProbeLookup(node.falseBody)
			)
		}
		case "ReturnStatement":
			return findProbeLookupInNode(node.expression)
		case "ProtocolDeclarationStatement":
			return null
		case "NativeFunctionInvocation":
			return findProbeLookupInArguments(node.arguments)
		case "MethodInvocation":
			return (
				findProbeLookupInNode(node.base) ??
				findProbeLookupInArguments(node.arguments)
			)
		case "FunctionInvocation":
			return (
				findProbeLookupInNode(node.name) ??
				findProbeLookupInArguments(node.arguments)
			)
		case "Lookup":
			if (node.member.content === probeMemberName) {
				return node
			}

			return findProbeLookupInNode(node.base)
		case "Combination":
			return (
				findProbeLookupInNode(node.lhs) ??
				findProbeLookupInNode(node.rhs)
			)
		case "Match": {
			let found = findProbeLookupInNode(node.value)

			if (found !== null) {
				return found
			}

			for (let handler of node.handlers) {
				let handlerFound = findProbeLookup(handler.body)

				if (handlerFound !== null) {
					return handlerFound
				}
			}

			return null
		}
		case "RecordValue": {
			for (let member of Object.values(node.members)) {
				let found = findProbeLookupInNode(member)

				if (found !== null) {
					return found
				}
			}

			return null
		}
		case "ListValue": {
			for (let value of node.values) {
				let found = findProbeLookupInNode(value)

				if (found !== null) {
					return found
				}
			}

			return null
		}
		case "FunctionValue":
			return findProbeLookup(node.value.body)
		case "TypeAliasStatement":
		case "Identifier":
		case "Self":
		case "StringValue":
		case "IntegerValue":
		case "FractionValue":
		case "BooleanValue":
		case "NothingValue":
			return null
	}
}

function findProbeLookupInArguments(
	nodeArguments: Array<common.typed.ArgumentNode>,
): common.typed.LookupNode | null {
	for (let argument of nodeArguments) {
		let found = findProbeLookupInNode(argument.value)

		if (found !== null) {
			return found
		}
	}

	return null
}

/*********************/
/* Member completion */
/*********************/

function memberCompletions(baseType: common.Type): Array<CompletionEntry> {
	if (baseType.type === "Record") {
		return Object.entries(baseType.members).map(([name, type]) => ({
			label: name,
			kind: "member" as const,
			detail: printType(type),
		}))
	}

	if (baseType.type === "Namespace") {
		let entries: Array<CompletionEntry> = []

		for (let [name, type] of Object.entries(baseType.properties)) {
			entries.push({
				label: name,
				kind: "property",
				detail: printType(type),
			})
		}

		for (let [name, method] of Object.entries(baseType.methods)) {
			entries.push({
				label: name,
				kind: methodDeclarationKind(method),
				detail: printType(method),
				documentation: describe(documentationOf(method)) || null,
			})
		}

		return entries
	}

	return []
}

function methodDeclarationKind(method: common.MethodType): DeclarationKind {
	return method.type === "StaticMethod" ||
		method.type === "OverloadedStaticMethod"
		? "staticMethod"
		: "method"
}

/*********************/
/* Method completion */
/*********************/

function methodCompletions(
	documentText: string,
	baseType: common.Type,
	specifierName: string | null,
): Array<CompletionEntry> {
	let namespaces = matchingNamespaces(documentText, baseType, specifierName)
	let seen = new Set<string>()
	let entries: Array<CompletionEntry> = []

	for (let namespace of namespaces) {
		for (let [name, method] of Object.entries(namespace.methods)) {
			// NOTE: Static Methods take no receiver — they are not invocable
			// through `::`, only through `.` on the Namespace itself.
			if (
				method.type === "StaticMethod" ||
				method.type === "OverloadedStaticMethod"
			) {
				continue
			}

			if (seen.has(name)) {
				continue
			}

			seen.add(name)

			entries.push({
				label: name,
				kind: "method",
				detail: printInvokedSignature(method),
				documentation: describe(documentationOf(method)) || null,
			})
		}
	}

	return entries
}

// NOTE: Inside `::<…>` only Namespaces that could actually disambiguate the
// call are useful — the same set `::` itself draws its Methods from.
function specifierCompletions(
	documentText: string,
	baseType: common.Type,
): Array<CompletionEntry> {
	let seen = new Set<string>()
	let entries: Array<CompletionEntry> = []

	for (let namespace of matchingNamespaces(documentText, baseType, null)) {
		if (namespace.name === "" || seen.has(namespace.name)) {
			continue
		}

		seen.add(namespace.name)

		entries.push({
			label: namespace.name,
			kind: "namespace",
			detail:
				namespace.targetType === null
					? null
					: printType(namespace.targetType),
		})
	}

	return entries
}

// NOTE: A Completion's detail is a single line next to its label, so an
// Overload set shows its first signature and counts the rest — Signature Help
// and the Hover are where every Overload is spelled out.
function printInvokedSignature(method: common.MethodType): string {
	return printSignatureSummary(signaturesOf(method) ?? [])
}

/********************/
/* Scope completion */
/********************/

function scopeCompletions(
	documentText: string,
	cursor: common.Cursor,
	beforeCursor: string,
): Array<CompletionEntry> {
	let { program } = parseWithDiagnostics(documentText)
	let enrichedProgram: common.typed.Program | null = null

	try {
		enrichedProgram = enrich(program).program
	} catch {}

	let { scopes } = indexProgram(program, enrichedProgram)
	let scope = scopeAt(scopes, cursor)
	let space = detectSymbolSpace(beforeCursor)
	let entries = new Map<string, Declaration>()

	let searchScope: Scope | null = scope

	while (searchScope !== null) {
		for (let [name, declaration] of searchScope[space]) {
			// NOTE: Constants and Variables do not hoist, so they must not be
			// offered before their declaring Statement — accepting them would
			// produce a Program the Enricher rejects. Skipping an invisible
			// inner Declaration also lets an outer one of the same name
			// through, which is exactly what resolves at that point.
			if (
				declaration.visibleFrom !== null &&
				!isAtOrBefore(declaration.visibleFrom, cursor)
			) {
				continue
			}

			if (!entries.has(name)) {
				entries.set(name, declaration)
			}
		}

		searchScope = searchScope.parent
	}

	return [...entries].map(([label, declaration]) => ({
		label,
		kind: declaration.kind,
		detail: null,
	}))
}

function detectSymbolSpace(beforeCursor: string): "values" | "types" {
	let trimmed = beforeCursor.replace(identifierTail, "").trimEnd()

	if (
		trimmed.endsWith(":") ||
		trimmed.endsWith("->") ||
		trimmed.endsWith("<")
	) {
		return "types"
	}

	return "values"
}

function scopeAt(scopes: Array<ScopeRange>, cursor: common.Cursor): Scope {
	let best: ScopeRange | null = null

	for (let candidate of scopes) {
		if (candidate.range !== null && !contains(candidate.range, cursor)) {
			continue
		}

		if (
			best === null ||
			best.range === null ||
			(candidate.range !== null && isSmaller(candidate.range, best.range))
		) {
			best = candidate
		}
	}

	return (best ?? scopes[0]).scope
}
