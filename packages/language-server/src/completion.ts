import { enrichDocument, parseDocument } from "@essence/compiler/documents"
import {
	filterMostSpecificByTarget,
	flattenUnionMembers,
} from "@essence/compiler/helpers"
import {
	printCaseWithPayload,
	printSignatureSummary,
	printType,
	signaturesOf,
} from "@essence/compiler/printType"
import type { common } from "@essence/interfaces"

import { type ArgumentContext, findArgumentContext } from "./argumentContext"
import { type ImportEdit, insertImportEdit } from "./autoImport"
import {
	type CallSnippet,
	callSnippetsFor,
	qualifiedCallSnippetsFor,
} from "./callSnippets"
import { describe, documentationOf } from "./documentation"
import { typedHandlerExpressions } from "./matchHandlerChildren"
import { matchingNamespaces } from "./namespaces"
import { contains, isAtOrBefore, isSmaller } from "./positions"
import { buildProbeSource, stripNoise } from "./probe"
import {
	type Declaration,
	type DeclarationKind,
	indexProgram,
	type Scope,
	type ScopeRange,
	type SymbolSpace,
} from "./rename"
import type { WorkspaceOffer } from "./workspace"

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
// the document text up to the trigger is re-parsed with `.lspProbeMember`
// appended (and enough closing brackets to balance it back into a valid
// Program) — the enriched Program's Lookup node for that synthetic member
// carries the receiver's Type in `base.type`, at the Scope the cursor is
// actually in (its enclosing Function's Parameters, `@`, and so on).

// NOTE: Every rename Declaration kind plus `case` and `keyword` — neither is a
// lexical Declaration (a Case resolves through its Choice, never a Scope; a
// Keyword is not a name at all), so neither ever appears in the rename index,
// but both are offered and need a kind of their own.
export type CompletionKind = DeclarationKind | "case" | "keyword"

// NOTE: An Editor sorts a Completion list on `sortText` rather than on the
// order it was handed, so the ranking is carried by every entry: what is
// nearest the cursor's own Scope first, what is merely part of the language
// last.
export const completionTiers = {
	local: 1,
	member: 2,
	document: 3,
	builtin: 4,
	keyword: 5,
	// NOTE: Last, and by a rule rather than by taste: everything above is
	// already reachable where the cursor is, while accepting one of these edits
	// the file's import block as well. An offer that changes two places belongs
	// below every offer that changes one.
	workspace: 6,
} as const

export type CompletionEntry = {
	label: string
	kind: CompletionKind
	detail: string | null
	// NOTE: The description alone — a Completion list has no room for the
	// tagged sections, and Signature Help shows them the moment the call is
	// actually being written.
	documentation?: string | null
	// NOTE: The call as it must be written, in LSP snippet syntax, labels and
	// all. Null wherever no signature resolved — the normal state halfway
	// through a keystroke — and the Editor falls back to the bare name.
	snippet?: string | null
	// NOTE: Only set where a label alone would be ambiguous: the Overloads of
	// one Method share a label on purpose, so their signature tails are what
	// tell them apart.
	labelDetail?: string | null
	tier: number
	preselect?: boolean
	// NOTE: What accepting the entry changes ELSEWHERE — the `import { … }`
	// entry that makes the name resolve at all. The Editor applies these
	// together with the insertion at the cursor, in one undo step.
	additionalEdits?: Array<ImportEdit>
}

// NOTE: What a Module the document has not imported offers, and the Namespace
// Types behind the ones that are Namespaces — the second is what a Method
// Completion matches against a receiver, and it costs an enrichment per
// exporting Module, so the two are asked for separately.
export type WorkspaceCompletions = {
	offers: Array<WorkspaceOffer>
	namespaces: Array<{
		offer: WorkspaceOffer
		namespace: common.NamespaceType
	}>
}

// NOTE: Must be a valid Identifier on its own — `_` and `-` are Symbols, and
// a leading `__` is the Native Function convention, so a plain camelCase
// name is used instead.
const probeMemberName = "lspProbeMember"

// NOTE: Mirrors `forbiddenIdentifierCharacters` in rename.ts — anything the
// Lexer would not produce as part of a single Identifier Token.
const identifierTail = /[^\s"§(){}[\]<>|/@,.:=~_-]*$/
const identifierCharacter = /[^\s"§(){}[\]<>|/@,.:=~_-]/
// NOTE: A whole `is` Token rather than the tail of an Identifier — `axis`
// ends in the same two characters and means nothing of the sort.
const trailingIsPattern = /(?:^|[\s"§(){}[\]<>|/@,.:=~_-])is$/
const methodTriggerPattern = /::(?:<([^>]*)>)?[^\s"§(){}[\]<>|/@,.:=~_-]*$/
const memberTriggerPattern = /\.[^\s"§(){}[\]<>|/@,.:=~_-]*$/
// NOTE: A Namespace specifier that is still being typed — the closing `>` is
// missing, so `methodTriggerPattern` cannot match it yet.
const specifierTriggerPattern = /::<[^\s"§(){}[\]<>|/@,.:=~_-]*$/
// NOTE: A Case reference being typed — the `#` sigil, optionally preceded by a
// Choice name specifier (`Colour#`), and the Case name so far. The character
// class also excludes `#` itself, so the specifier is a clean Identifier and
// the trigger locks onto the final `#`.
const caseTriggerPattern =
	/([^\s"§(){}[\]<>|/@,.:=~_#-]*)#[^\s"§(){}[\]<>|/@,.:=~_#-]*$/
// NOTE: A valid Case name that no real Choice is expected to declare — the
// stand-in a probe writes where the in-progress `#name` was, so the document
// parses and its expected Type and Choices in scope can be read back.
const probeCaseName = "LspProbeCase"

// NOTE: The Keywords `parseImplementationNode` dispatches a Statement on,
// plus the two that open a block of their own — `static` inside a Namespace
// body and `implementation` around the whole Program.
const statementKeywords = [
	"constant",
	"variable",
	"function",
	"if",
	"match",
	"namespace",
	"protocol",
	"type",
	"choice",
	"overload",
	"static",
	"implementation",
]

// NOTE: What `parsePrimaryExpression` accepts as the start of an Expression —
// every other Keyword it reads there is an Identifier in disguise.
const expressionKeywords = ["match", "true", "false", "nothing"]

export function findCompletions(
	documentText: string,
	cursor: common.Cursor,
	documentPath?: string,
	workspace: WorkspaceCompletions = { offers: [], namespaces: [] },
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

		let base = resolveProbedBase(headText, documentPath)

		if (base === null) {
			return []
		}

		if (specifierMatch !== null) {
			return specifierCompletions(documentText, base.type, documentPath)
		}

		return methodMatch !== null
			? methodCompletions(
					documentText,
					base.type,
					methodMatch[1] ?? null,
					documentPath,
					workspace.namespaces,
				)
			: memberCompletions(base.type, base.program)
	}

	// NOTE: A `#` offers Cases rather than Scope names — the two never share a
	// position, so this is checked before the Scope fallback and only when no
	// `::` or `.` trigger claimed the cursor first.
	let caseMatch = caseTriggerPattern.exec(beforeCursor)

	if (caseMatch !== null) {
		return caseCompletions(
			lines,
			cursor,
			beforeCursor,
			currentLine,
			caseMatch.index,
			caseMatch[1] ?? "",
			documentPath,
		)
	}

	let headText = [...lines.slice(0, cursor.line - 1), beforeCursor].join("\n")
	let space = detectSymbolSpace(headText)

	// NOTE: Record member names and Argument labels are offered *alongside*
	// the names in Scope — both are valid at those positions, since a member
	// is written `name = value` and a labelled Argument `label value`.
	//
	// NOTE: Keywords are offered here and nowhere else — after a `.`, a `::`
	// or a `#` the language allows nothing but a name — and only in the value
	// space, since no Keyword names a Type.
	return [
		...contextualCompletions(lines, cursor, documentPath),
		...scopeCompletions(
			documentText,
			cursor,
			space,
			documentPath,
			workspace.offers,
		),
		...(space === "values" ? keywordCompletions(headText) : []),
	]
}

/*******************************/
/* Record members and labels   */
/*******************************/

function contextualCompletions(
	lines: Array<string>,
	cursor: common.Cursor,
	documentPath?: string,
): Array<CompletionEntry> {
	let headText = [
		...lines.slice(0, cursor.line - 1),
		(lines[cursor.line - 1] ?? "").slice(0, cursor.column - 1),
	].join("\n")

	let context: ArgumentContext | null = null

	try {
		let { program } = parseDocument(
			buildProbeSource(headText),
			documentPath,
		)
		let { program: enrichedProgram } = enrichDocument(program, documentPath)

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
				tier: completionTiers.member,
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
			tier: completionTiers.member,
		}))
}

/*********************************/
/* Probing for the receiver Type */
/*********************************/

// NOTE: The enriched probe Program is handed back alongside the Type it
// resolved — a Namespace Type carries no `§§` documentation for its
// Properties, only the declaration Node does, and the probe already holds
// every declaration above the cursor.
type ProbedBase = {
	type: common.Type
	program: common.typed.Program
}

function resolveProbedBase(
	headText: string,
	documentPath?: string,
): ProbedBase | null {
	let probeSource = buildProbeSource(headText, `.${probeMemberName}`)

	try {
		let { program } = parseDocument(probeSource, documentPath)
		let { program: enrichedProgram } = enrichDocument(program, documentPath)
		let baseType =
			findProbeLookup(enrichedProgram.implementation.nodes)?.base.type ??
			null

		return baseType === null
			? null
			: { type: baseType, program: enrichedProgram }
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
				// NOTE: The Matcher and its Guard come before the body in the
				// source, so they are searched first — the probe is looked for
				// where it was typed.
				for (let expression of typedHandlerExpressions(handler)) {
					let expressionFound = findProbeLookupInNode(expression)

					if (expressionFound !== null) {
						return expressionFound
					}
				}

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
		case "InterpolatedStringValue": {
			for (let segment of node.segments) {
				if (segment.kind !== "expression") {
					continue
				}

				let found = findProbeLookupInNode(segment.expression)

				if (found !== null) {
					return found
				}
			}

			return null
		}
		case "FunctionValue":
			return findProbeLookup(node.value.body)
		case "CaseValue":
			return node.value === null
				? null
				: findProbeLookupInNode(node.value)
		case "TypeAliasStatement":
		case "ChoiceDeclarationStatement":
		case "Identifier":
		case "Self":
		case "StringValue":
		case "IntegerValue":
		case "RationalValue":
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

function memberCompletions(
	baseType: common.Type,
	program: common.typed.Program,
): Array<CompletionEntry> {
	if (baseType.type === "Record") {
		return Object.entries(baseType.members).map(([name, type]) => ({
			label: name,
			kind: "member" as const,
			detail: printType(type),
			tier: completionTiers.member,
		}))
	}

	if (baseType.type === "Namespace") {
		let documented = namespacePropertyDocumentation(program, baseType.name)
		let entries: Array<CompletionEntry> = []

		for (let [name, type] of Object.entries(baseType.properties)) {
			entries.push({
				label: name,
				kind: "property",
				detail: printType(type),
				documentation: documented.get(name) ?? null,
				tier: completionTiers.member,
			})
		}

		for (let [name, method] of Object.entries(baseType.methods)) {
			entries.push(
				...callableEntries({
					name,
					kind: methodDeclarationKind(method),
					snippets: qualifiedCallSnippetsFor(name, method),
					detail: printType(method),
					documentation: describe(documentationOf(method)) || null,
					tier: completionTiers.member,
				}),
			)
		}

		return entries
	}

	return []
}

// NOTE: The `§§` block above each Property, keyed by name. A Namespace Type
// keeps only the Property's Type, so this reads the declaration Node instead —
// the probe stops at the cursor, and a Namespace whose members are being
// looked up is necessarily declared above it.
function namespacePropertyDocumentation(
	program: common.typed.Program,
	name: string,
): Map<string, string> {
	let documented = new Map<string, string>()

	function visitBody(nodes: Array<common.typed.ImplementationNode>) {
		for (let node of nodes) {
			if (node.nodeType === "NamespaceDefinitionStatement") {
				if (node.name.content !== name) {
					continue
				}

				for (let [propertyName, property] of Object.entries(
					node.properties,
				)) {
					let description = describe(property.documentation)

					if (description !== "") {
						documented.set(propertyName, description)
					}
				}
			} else if (node.nodeType === "IfStatement") {
				visitBody(node.body)
			} else if (node.nodeType === "IfElseStatement") {
				visitBody(node.trueBody)
				visitBody(node.falseBody)
			} else if (node.nodeType === "FunctionStatement") {
				visitBody(node.value.body)
			}
		}
	}

	visitBody(program.implementation.nodes)

	return documented
}

// NOTE: One entry PER OVERLOAD, all sharing a label — the Overloads of a
// Method differ in exactly the Argument labels the snippet inserts, so a
// single "primary" entry would write the wrong call half the time. The
// signature tail in `labelDetail` is what tells them apart in the list. With
// no signature at all — a half-enriched document, which is the normal state
// while typing — the bare entry is kept and the Editor completes the name.
function callableEntries({
	name,
	kind,
	snippets,
	detail,
	documentation,
	tier,
}: {
	name: string
	kind: CompletionKind
	snippets: Array<CallSnippet> | null
	detail: string | null
	documentation: string | null
	tier: number
}): Array<CompletionEntry> {
	if (snippets === null) {
		return [
			{
				label: name,
				kind,
				detail,
				documentation,
				snippet: null,
				labelDetail: null,
				tier,
			},
		]
	}

	return snippets.map((entry) => ({
		label: name,
		kind,
		detail: entry.signature,
		documentation,
		snippet: entry.snippet,
		labelDetail: snippets.length > 1 ? entry.signature : null,
		tier,
	}))
}

function methodDeclarationKind(method: common.MethodType): DeclarationKind {
	return isStaticMethod(method) ? "staticMethod" : "method"
}

// NOTE: Static Methods take no receiver — they are not invocable through `::`,
// only through `.` on the Namespace itself.
function isStaticMethod(method: common.MethodType): boolean {
	return (
		method.type === "StaticMethod" ||
		method.type === "OverloadedStaticMethod"
	)
}

/*********************/
/* Method completion */
/*********************/

// NOTE: Overlapping Namespaces declare the same Method name — a user
// `for List<Integer>` beside the builtin `for List<ItemType>` — and the one
// listed first is not the one the call resolves to: the Enricher dispatches to
// the most specific target. Completion runs the same shared order per Method
// name so the signature it shows is the signature that will be invoked. A tie
// is left as it is found, the way the Enricher leaves it to be reported.
function mostSpecificMethod(
	namespaces: Array<common.NamespaceType>,
	name: string,
): common.MethodType | undefined {
	let declaring = namespaces.filter((namespace) => {
		let method = namespace.methods[name]

		return method !== undefined && !isStaticMethod(method)
	})

	return filterMostSpecificByTarget(declaring, (namespace) => namespace)[0]
		?.methods[name]
}

function methodCompletions(
	documentText: string,
	baseType: common.Type,
	specifierName: string | null,
	documentPath?: string,
	workspaceNamespaces: Array<{
		offer: WorkspaceOffer
		namespace: common.NamespaceType
	}> = [],
): Array<CompletionEntry> {
	// NOTE: The Namespaces in scope are offered first and the unimported ones
	// after them, so a Method that resolves today wins the name over one that
	// would need an entry added — the same first-wins dedupe, ordered by what
	// costs the reader least.
	let offers = new Map(
		workspaceNamespaces.map(({ offer, namespace }) => [
			namespace.name,
			offer,
		]),
	)
	let inScope = matchingNamespaces(
		documentText,
		baseType,
		specifierName,
		documentPath,
	)
	let namespaces = [
		...inScope,
		...matchingNamespaces(
			documentText,
			baseType,
			specifierName,
			documentPath,
			workspaceNamespaces.map((candidate) => candidate.namespace),
		).filter((namespace) => offers.has(namespace.name)),
	]
	let seen = new Set<string>()
	let entries: Array<CompletionEntry> = []

	for (let namespace of namespaces) {
		let offer = offers.get(namespace.name)
		let importEdit =
			offer === undefined ? null : importEditFor(documentText, offer)

		for (let [name, method] of Object.entries(namespace.methods)) {
			if (isStaticMethod(method)) {
				continue
			}

			if (seen.has(name)) {
				continue
			}

			seen.add(name)

			let resolved = mostSpecificMethod(namespaces, name) ?? method

			entries.push(
				...callableEntries({
					name,
					kind: "method",
					snippets: callSnippetsFor(name, resolved),
					detail:
						offer === undefined
							? printInvokedSignature(resolved)
							: `${printInvokedSignature(resolved)} — ${offer.specifier}`,
					documentation: describe(documentationOf(resolved)) || null,
					tier:
						offer === undefined
							? completionTiers.member
							: completionTiers.workspace,
				}).map((entry) =>
					importEdit === null
						? entry
						: { ...entry, additionalEdits: [importEdit] },
				),
			)
		}
	}

	return entries
}

// NOTE: Built against the document as it is now, like every other edit this
// Server hands out. Null where the block already holds the entry, which is what
// an offer whose name is somehow already bound would produce — the offer is not
// dropped for it, since the Method IS reachable once the entry is there.
function importEditFor(
	documentText: string,
	offer: WorkspaceOffer,
): ImportEdit | null {
	let { program } = parseDocument(documentText)

	return insertImportEdit(documentText, program, {
		name: offer.name,
		alias: null,
		specifier: offer.specifier,
	})
}

// NOTE: Inside `::<…>` only Namespaces that could actually disambiguate the
// call are useful — the same set `::` itself draws its Methods from.
function specifierCompletions(
	documentText: string,
	baseType: common.Type,
	documentPath?: string,
): Array<CompletionEntry> {
	let seen = new Set<string>()
	let entries: Array<CompletionEntry> = []

	for (let namespace of matchingNamespaces(
		documentText,
		baseType,
		null,
		documentPath,
	)) {
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
			tier: completionTiers.member,
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

/*******************/
/* Case completion */
/*******************/

// NOTE: `#` completion offers the Cases a Case reference could name at the
// cursor. An annotated position (`constant step: Step<Integer, String> = #…`, a
// labelled Argument, a Function's return at `<-`) pins the Choice down to one
// applied Union — its Cases come back instantiated, so the payload detail shows
// the concrete Types. With no such expectation the scan mirrors the Enricher's
// `findCaseTypesInScope`: every Choice in scope offers its declared Cases,
// generic ones (Generic Aliases) included. A written prefix (`Colour#`) narrows
// that scan to the one Choice.
function caseCompletions(
	lines: Array<string>,
	cursor: common.Cursor,
	beforeCursor: string,
	currentLine: string,
	matchIndex: number,
	choicePrefix: string,
	documentPath?: string,
): Array<CompletionEntry> {
	// NOTE: The in-progress `#name` is swapped for a synthetic Case reference so
	// the whole document parses — later Choice declarations stay in view, and
	// the expected Type at the `#` and the Choices in scope both read off one
	// enriched Program.
	let probeLine =
		beforeCursor.slice(0, matchIndex) +
		choicePrefix +
		`#${probeCaseName}` +
		currentLine.slice(cursor.column - 1)
	let probeText = [
		...lines.slice(0, cursor.line - 1),
		probeLine,
		...lines.slice(cursor.line),
	].join("\n")

	let enrichedProgram: common.typed.Program | null = null

	try {
		let { program } = parseDocument(probeText, documentPath)
		enrichedProgram = enrichDocument(program, documentPath).program
	} catch {
		return []
	}

	let { expected, choices } = analyseCaseProbe(enrichedProgram)

	let expectedCases =
		expected !== null && expected.type === "UnionType"
			? flattenUnionMembers(expected).filter(
					(member): member is common.CaseType =>
						member.type === "Case",
				)
			: []

	// NOTE: An expectation names ONE Choice, so the list is complete and
	// ordered as the Choice declared it — the first Case is preselected, which
	// the prefix-less scan over every Choice in scope has no basis for.
	if (expectedCases.length > 0) {
		return caseEntries(expectedCases, true)
	}

	if (choicePrefix !== "") {
		return caseEntries(choices.get(choicePrefix) ?? [])
	}

	return caseEntries([...choices.values()].flat())
}

function caseEntries(
	caseTypes: Array<common.CaseType>,
	preselectFirst = false,
): Array<CompletionEntry> {
	let seen = new Set<string>()
	let entries: Array<CompletionEntry> = []

	for (let caseType of caseTypes) {
		let key = `${caseType.choice}#${caseType.name}`

		if (seen.has(key)) {
			continue
		}

		seen.add(key)

		// NOTE: The `#` is already typed, so the label is the bare Case name —
		// selecting it completes `#name`. The detail spells the payload out, and
		// its `Choice#Case` head tells apart two Choices that share a Case name
		// in the prefix-less scan.
		entries.push({
			label: caseType.name,
			kind: "case",
			detail: printCaseWithPayload(caseType),
			tier: completionTiers.member,
			preselect: preselectFirst && entries.length === 0,
		})
	}

	return entries
}

// NOTE: One pass over the probe's enriched Program: it threads the expected
// Type down to the synthetic Case reference (mirroring `argumentContext`, plus
// a Function's return Type at a `<-`) and, along the way, records every Choice
// declaration's Cases. The expected Type is only meaningful once it reaches the
// probe, so `expected` stays `undefined` until then.
function analyseCaseProbe(program: common.typed.Program): {
	expected: common.Type | null
	choices: Map<string, Array<common.CaseType>>
} {
	let expected: common.Type | null | undefined = undefined
	let choices = new Map<string, Array<common.CaseType>>()

	function visitBody(
		nodes: Array<common.typed.ImplementationNode>,
		expectedType: common.Type | null,
	) {
		for (let node of nodes) {
			visitNode(node, expectedType)
		}
	}

	function visitFunction(definition: common.typed.FunctionDefinitionNode) {
		visitBody(definition.body, definition.returnType)
	}

	function visitArguments(
		nodeArguments: Array<common.typed.ArgumentNode>,
		parameterTypes: common.BaseFunction["parameterTypes"] | null,
	) {
		nodeArguments.forEach((argument, index) => {
			let parameterType = parameterTypes?.[index]?.type ?? null

			visitNode(
				argument.value,
				parameterType !== null && parameterType.type !== "GenericUse"
					? parameterType
					: null,
			)
		})
	}

	function visitNode(
		node: common.typed.ImplementationNode,
		expectedType: common.Type | null,
	) {
		switch (node.nodeType) {
			case "ChoiceDeclarationStatement":
				if (!choices.has(node.name.content)) {
					choices.set(
						node.name.content,
						node.cases.map((choiceCase) => choiceCase.type),
					)
				}

				return
			case "CaseValue":
				if (node.caseName.content === probeCaseName) {
					expected = expectedType
				}

				if (node.value !== null) {
					visitNode(
						node.value,
						node.type.type === "Case"
							? { type: "Record", members: node.type.members }
							: null,
					)
				}

				return
			case "ConstantDeclarationStatement":
			case "VariableDeclarationStatement":
				visitNode(node.value, node.declaredType ?? node.type)
				return
			case "VariableAssignmentStatement":
				visitNode(node.value, null)
				return
			case "FunctionStatement":
				visitFunction(node.value)
				return
			case "FunctionValue":
				visitFunction(node.value)
				return
			case "NamespaceDefinitionStatement":
				for (let property of Object.values(node.properties)) {
					visitNode(property.value, null)
				}

				for (let member of Object.values(node.methods)) {
					let methods =
						member.nodeType === "OverloadedMethod" ||
						member.nodeType === "OverloadedStaticMethod"
							? member.methods
							: [member.method]

					for (let method of methods) {
						visitFunction(method.value)
					}
				}

				return
			case "IfStatement":
				visitNode(node.condition, null)
				visitBody(node.body, null)
				return
			case "IfElseStatement":
				visitNode(node.condition, null)
				visitBody(node.trueBody, null)
				visitBody(node.falseBody, null)
				return
			case "ReturnStatement":
				visitNode(node.expression, expectedType)
				return
			case "FunctionInvocation": {
				let calleeType = node.name.type

				visitNode(node.name, null)
				visitArguments(
					node.arguments,
					calleeType.type === "Function"
						? calleeType.parameterTypes
						: null,
				)
				return
			}
			case "MethodInvocation":
				visitNode(node.base, null)
				visitArguments(node.arguments, null)
				return
			case "NativeFunctionInvocation":
				visitArguments(node.arguments, null)
				return
			case "Lookup":
				visitNode(node.base, null)
				return
			case "Combination":
				visitNode(node.lhs, expectedType)
				visitNode(node.rhs, expectedType)
				return
			case "Match":
				visitNode(node.value, null)

				for (let handler of node.handlers) {
					for (let expression of typedHandlerExpressions(handler)) {
						visitNode(expression, null)
					}

					visitBody(handler.body, expectedType)
				}

				return
			case "RecordValue":
				for (let member of Object.values(node.members)) {
					visitNode(member, null)
				}

				return
			case "ListValue": {
				let itemType =
					expectedType?.type === "List" ? expectedType.itemType : null

				for (let value of node.values) {
					visitNode(value, itemType)
				}

				return
			}
			case "InterpolatedStringValue":
				for (let segment of node.segments) {
					if (segment.kind === "expression") {
						visitNode(segment.expression, null)
					}
				}

				return
			case "TypeAliasStatement":
			case "ProtocolDeclarationStatement":
			case "Identifier":
			case "Self":
			case "StringValue":
			case "IntegerValue":
			case "RationalValue":
			case "BooleanValue":
			case "NothingValue":
				return
		}
	}

	visitBody(program.implementation.nodes, null)

	return { expected: expected ?? null, choices }
}

/********************/
/* Scope completion */
/********************/

// NOTE: Which symbol space an offer belongs in, by what the other Module
// declared it as. A Type Alias, a Choice and a Protocol are only nameable where
// a Type is; everything else is a value. A name bound in both tables at home —
// a `type Foo` beside a `namespace Foo` — is one entry either way, so offering
// it in one space is enough to bring the other along.
const offerSpaces: Record<DeclarationKind, SymbolSpace> = {
	constant: "values",
	variable: "values",
	function: "values",
	parameter: "values",
	namespace: "values",
	protocol: "types",
	type: "types",
	generic: "types",
	method: "values",
	staticMethod: "values",
	property: "values",
	member: "values",
	label: "values",
	import: "values",
}

function scopeCompletions(
	documentText: string,
	cursor: common.Cursor,
	space: SymbolSpace,
	documentPath?: string,
	offers: Array<WorkspaceOffer> = [],
): Array<CompletionEntry> {
	let { program } = parseDocument(documentText, documentPath)
	let enrichedProgram: common.typed.Program | null = null

	try {
		enrichedProgram = enrichDocument(program, documentPath).program
	} catch {}

	let { scopes } = indexProgram(program, enrichedProgram)
	let scope = scopeAt(scopes, cursor)
	let described =
		enrichedProgram === null
			? new Map<string, DeclarationInfo>()
			: describeDeclarations(enrichedProgram)
	let entries = new Map<string, Array<CompletionEntry>>()

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

			if (entries.has(name)) {
				continue
			}

			// NOTE: The rename index is lexical and knows no Types; the
			// enriched Program has the Types but no Scopes. A Declaration's
			// name Position is what joins the two, and both sides read the
			// same Parser Positions, so the key is exact rather than a range
			// search.
			let info =
				declaration.definition === null
					? null
					: (described.get(positionKey(declaration.definition)) ??
						null)

			// NOTE: Only the top level Scope has no parent, and it holds the
			// builtins beside the document's own top level Declarations — so
			// the depth tells a local apart from a document-wide name, and
			// `builtin` tells the two halves of the top level apart.
			let tier = declaration.builtin
				? completionTiers.builtin
				: searchScope.parent === null
					? completionTiers.document
					: completionTiers.local

			entries.set(name, scopeEntries(name, declaration, info, tier))
		}

		searchScope = searchScope.parent
	}

	// NOTE: After the whole Scope chain, and only for names nothing in it
	// already answers with — an offer that shadows something reachable would
	// insert an entry the Compiler refuses as a duplicate.
	for (let offer of offers) {
		if (entries.has(offer.name) || offerSpaces[offer.kind] !== space) {
			continue
		}

		let edit = insertImportEdit(documentText, program, {
			name: offer.name,
			alias: null,
			specifier: offer.specifier,
		})

		entries.set(offer.name, [
			{
				label: offer.name,
				kind: offer.kind,
				detail: `from ${offer.specifier}`,
				tier: completionTiers.workspace,
				...(edit === null ? {} : { additionalEdits: [edit] }),
			},
		])
	}

	return [...entries.values()].flat()
}

function scopeEntries(
	label: string,
	declaration: Declaration,
	info: DeclarationInfo | null,
	tier: number,
): Array<CompletionEntry> {
	// NOTE: Only a `function` Declaration is invoked by writing its name — a
	// Constant or a Parameter may hold a Function Value just as well, but
	// there the name is as often passed on as it is called, so nothing is
	// inserted for it.
	let snippets =
		declaration.kind === "function" && info?.type != null
			? callSnippetsFor(label, info.type)
			: null

	return callableEntries({
		name: label,
		kind: declaration.kind,
		snippets,
		detail: declarationDetail(label, info?.type ?? null),
		documentation: info?.documentation ?? null,
		tier,
	})
}

// NOTE: A Namespace and a Choice both print as their own name, which the label
// beside the detail already says. A Namespace's target Type is what a single
// line can add instead; a Choice has nothing to add, so it stays bare.
function declarationDetail(
	label: string,
	type: common.Type | null,
): string | null {
	if (type === null) {
		return null
	}

	if (type.type === "Namespace") {
		return type.targetType === null
			? null
			: `for ${printType(type.targetType)}`
	}

	let printed = printType(type)

	return printed === label ? null : printed
}

type DeclarationInfo = {
	type: common.Type | null
	documentation: string | null
}

// NOTE: Every Declaration the enriched Program can say something about, keyed
// by where its name was written. Kept deliberately close to the rename index's
// own idea of a Declaration: the same Statements, plus the Parameters that
// only a Function's inner Scope offers.
function describeDeclarations(
	program: common.typed.Program,
): Map<string, DeclarationInfo> {
	let described = new Map<string, DeclarationInfo>()

	function describeAt(position: common.Position, info: DeclarationInfo) {
		described.set(positionKey(position), info)
	}

	function visitFunction(
		definition: common.typed.FunctionDefinitionNode,
		documentation: common.Documentation | null,
	) {
		for (let parameter of definition.parameters) {
			let name =
				parameter.externalName?.content ??
				parameter.internalName?.content
			let info: DeclarationInfo = {
				type:
					parameter.internalName?.type ??
					parameter.externalName?.type ??
					null,
				// NOTE: A Parameter's `@param` text lives on the enclosing
				// callable's `§§` block, under the name the call site writes.
				documentation:
					name === undefined
						? null
						: (documentation?.parameters[name] ?? null),
			}

			if (parameter.externalName !== null) {
				describeAt(parameter.externalName.position, info)
			}

			if (parameter.internalName !== null) {
				describeAt(parameter.internalName.position, info)
			}
		}

		visitBody(definition.body)
	}

	function visitBody(nodes: Array<common.typed.ImplementationNode>) {
		for (let node of nodes) {
			visitNode(node)
		}
	}

	function visitArguments(nodeArguments: Array<common.typed.ArgumentNode>) {
		for (let argument of nodeArguments) {
			visitNode(argument.value)
		}
	}

	function visitNode(node: common.typed.ImplementationNode) {
		switch (node.nodeType) {
			case "ConstantDeclarationStatement":
			case "VariableDeclarationStatement":
				describeAt(node.name.position, {
					type: node.declaredType ?? node.type,
					documentation: describe(node.documentation) || null,
				})
				visitNode(node.value)
				return
			case "FunctionStatement": {
				let documentation = documentationOf(node.type)

				describeAt(node.name.position, {
					type: node.type,
					documentation: describe(documentation) || null,
				})
				visitFunction(node.value, documentation)
				return
			}
			case "NamespaceDefinitionStatement":
				describeAt(node.name.position, {
					type: node.type,
					documentation: describe(node.documentation) || null,
				})

				for (let property of Object.values(node.properties)) {
					visitNode(property.value)
				}

				for (let member of Object.values(node.methods)) {
					let methods =
						member.nodeType === "OverloadedMethod" ||
						member.nodeType === "OverloadedStaticMethod"
							? member.methods
							: [member.method]

					for (let method of methods) {
						visitFunction(
							method.value,
							documentationOf(method.type),
						)
					}
				}

				return
			case "ChoiceDeclarationStatement":
			case "TypeAliasStatement":
				describeAt(node.name.position, {
					type: node.type,
					documentation: describe(node.documentation) || null,
				})
				return
			case "ProtocolDeclarationStatement":
				describeAt(node.name.position, {
					type: null,
					documentation:
						describe(node.protocolType.documentation ?? null) ||
						null,
				})
				return
			case "FunctionValue":
				visitFunction(node.value, null)
				return
			case "VariableAssignmentStatement":
				visitNode(node.value)
				return
			case "ReturnStatement":
				visitNode(node.expression)
				return
			case "IfStatement":
				visitNode(node.condition)
				visitBody(node.body)
				return
			case "IfElseStatement":
				visitNode(node.condition)
				visitBody(node.trueBody)
				visitBody(node.falseBody)
				return
			case "FunctionInvocation":
				visitNode(node.name)
				visitArguments(node.arguments)
				return
			case "MethodInvocation":
				visitNode(node.base)
				visitArguments(node.arguments)
				return
			case "NativeFunctionInvocation":
				visitArguments(node.arguments)
				return
			case "Lookup":
				visitNode(node.base)
				return
			case "Combination":
				visitNode(node.lhs)
				visitNode(node.rhs)
				return
			case "Match":
				visitNode(node.value)

				for (let handler of node.handlers) {
					for (let expression of typedHandlerExpressions(handler)) {
						visitNode(expression)
					}

					visitBody(handler.body)
				}

				return
			case "RecordValue":
				for (let member of Object.values(node.members)) {
					visitNode(member)
				}

				return
			case "ListValue":
				for (let value of node.values) {
					visitNode(value)
				}

				return
			case "InterpolatedStringValue":
				for (let segment of node.segments) {
					if (segment.kind === "expression") {
						visitNode(segment.expression)
					}
				}

				return
			case "CaseValue":
				if (node.value !== null) {
					visitNode(node.value)
				}

				return
			case "Identifier":
			case "Self":
			case "StringValue":
			case "IntegerValue":
			case "RationalValue":
			case "BooleanValue":
			case "NothingValue":
				return
		}
	}

	visitBody(program.implementation.nodes)

	return described
}

function positionKey(position: common.Position): string {
	return `${position.start.line}:${position.start.column}`
}

/**********************/
/* Reading the cursor  */
/**********************/

// NOTE: The Parser only ever reads a Type after one of these: a `:`
// annotation, a `->` return, a `<` Generic application, an `is` bound or
// conformance clause, or a `|` — `parseType` is the only place a Pipe is
// consumed at all, so one can never be anything else.
//
// A trailing `,` says nothing on its own, since it separates Arguments as
// readily as Type Arguments; the bracket it sits inside decides. A Generic
// DECLARATION list (`<infer Value is Comparable>`) is read as one too, so a
// comma there offers Types where the Parser wants a Type Parameter — the same
// approximation a bare `<` has always made.
function detectSymbolSpace(headText: string): SymbolSpace {
	let stripped = stripNoise(headText)
	let trimmed = lastLineOf(stripped).replace(identifierTail, "").trimEnd()

	if (
		trimmed.endsWith(":") ||
		trimmed.endsWith("->") ||
		trimmed.endsWith("<") ||
		trimmed.endsWith("|") ||
		trailingIsPattern.test(trimmed)
	) {
		return "types"
	}

	if (trimmed.endsWith(",") && innermostOpener(stripped) === "<") {
		return "types"
	}

	return "values"
}

// NOTE: The bracket the cursor is innermost inside. A `<` counts as one only
// where the Parser reads it as a bracket — a Generic application or a Generic
// list opens directly against the name it belongs to, so a `<` with anything
// else before it is the `<-` of a return or the `::<` of a Namespace
// specifier. For the same reason a `>` closes only a `<` that was counted,
// leaving the `>` of a `->` alone.
function innermostOpener(text: string): string | null {
	let stack: Array<string> = []
	let previous = ""

	for (let character of text) {
		if (character === "(" || character === "[" || character === "{") {
			stack.push(character)
		} else if (
			character === ")" ||
			character === "]" ||
			character === "}"
		) {
			stack.pop()
		} else if (character === "<" && identifierCharacter.test(previous)) {
			stack.push(character)
		} else if (character === ">" && stack[stack.length - 1] === "<") {
			stack.pop()
		}

		previous = character
	}

	return stack[stack.length - 1] ?? null
}

// NOTE: Statement start is read off the text alone — nothing but a block
// boundary before the cursor on its line. Everything else is inside an
// Expression: the value half of a declaration, an Argument, a `<-`.
//
// NOTE: No legality analysis happens here. `static` is only meaningful in a
// Namespace body, `overload` only in a `declarations` Program, `implementation`
// only at the very top, and none of that is checked. A Keyword offered where it
// will not parse costs one Parser Diagnostic on the next keystroke; the
// alternative is a second, approximate model of where each Keyword may stand,
// which would be wrong in subtler ways.
function keywordCompletions(headText: string): Array<CompletionEntry> {
	let trimmed = lastLineOf(stripNoise(headText))
		.replace(identifierTail, "")
		.trimEnd()
	let atStatementStart =
		trimmed === "" || trimmed.endsWith("{") || trimmed.endsWith("}")

	return (atStatementStart ? statementKeywords : expressionKeywords).map(
		(keyword) => ({
			label: keyword,
			kind: "keyword" as const,
			detail: null,
			tier: completionTiers.keyword,
		}),
	)
}

function lastLineOf(text: string): string {
	return text.slice(text.lastIndexOf("\n") + 1)
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
