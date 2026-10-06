import {
	filterMostSpecificByTarget,
	flattenUnionMembers,
	isMergedLevel,
} from "@essence-lang/compiler/helpers"
import {
	printCaseWithPayload,
	printSignatureSummary,
	printType,
	signaturesOf,
	withProtocolSpellings,
} from "@essence-lang/compiler/printType"
import {
	findTypedChild,
	forEachTypedChild,
	type TypedNode,
} from "@essence-lang/compiler/visitor"
import type { common, parser } from "@essence-lang/interfaces"

import type { DocumentAnalysis } from "./analyse"
import {
	type ArgumentContext,
	findArgumentContext,
	pairedParameters,
} from "./argumentContext"
import { type ImportEdit, insertImportEdit } from "./autoImport"
import {
	type CallSnippet,
	callSnippetsFor,
	qualifiedCallSnippetsFor,
} from "./callSnippets"
import { parseDocument } from "./compilation"
import { describe, documentationOf } from "./documentation"
import {
	moduleSectionCompletions,
	moduleSectionCursor,
} from "./importCompletion"
import { documentAnalysisOf, enrichProbe, type ModuleView } from "./moduleLink"
import { typeNamedAt } from "./namedTypes"
import {
	derivedEnumerableNamespace,
	matchingNamespaces,
	namedTypeNamespaces,
} from "./namespaces"
import { isAtOrBefore } from "./positions"
import { probeSourcesFor, stripNoise } from "./probe"
import { documentProtocolSpellings } from "./protocolSpellings"
import {
	type Declaration,
	type DeclarationKind,
	indexProgram,
	type Scope,
	scopeAt,
	type SymbolSpace,
} from "./rename"
import { typedProgramBodies, typedProgramNodes } from "./sections"
import { snippetContextAt, writtenSections } from "./snippetContext"
import {
	type ModuleSection,
	renderPlaceholders,
	type SnippetContext,
	snippetsFor,
} from "./snippets"
import type { WorkspaceOffer } from "./workspace"

// Completion's modes, told apart by the text before the cursor. A member or
// Method list reads the receiver's Type off a probe. See "Completion" in
// DEVELOPMENT.md.

// Every rename Declaration kind, plus four offered names no Scope declares.
// A snippet and a Keyword may share a label, such as `test`, and the kind's
// icon tells them apart.
export type CompletionKind =
	| DeclarationKind
	| "case"
	| "keyword"
	| "module"
	| "snippet"

// Ranks carried in `sortText`. Single digits, since `sortText` compares as
// text. See "Ranking" in DEVELOPMENT.md.
const completionTiers = {
	local: 1,
	member: 2,
	document: 3,
	builtin: 4,
	keyword: 5,
	// After the Keyword that shares its label, which is what `test` usually means.
	snippet: 6,
	// Last: accepting one of these edits the import block too.
	workspace: 7,
} as const

export type CompletionEntry = {
	label: string
	kind: CompletionKind
	detail: string | null
	// The description alone. Signature Help shows the tagged sections.
	documentation?: string | null
	// The call as written, labels and all, in LSP snippet syntax. Null where no
	// signature resolved, and the Editor inserts the bare name.
	snippet?: string | null
	// Set only where the label is ambiguous: a Method's Overloads share a label,
	// and their signature tails tell them apart.
	labelDetail?: string | null
	tier: number
	preselect?: boolean
	// The `import { … }` entry that makes the name resolve, applied in the same
	// undo step as the insertion.
	additionalEdits?: Array<ImportEdit>
	// The text accepting the entry writes, in LSP snippet syntax, where it is not
	// the label. Unlike `snippet` it makes no call.
	insertText?: string
	// The span the insertion replaces, where the Editor's word is wrong: it ends a
	// word at every `.` and `/` of a specifier.
	replaces?: common.Position
}

// What the Modules the document has not imported offer. The Namespace Types
// cost an enrichment each, so they are asked for apart. `specifiers` names
// every Module as this document would write it.
export type WorkspaceCompletions = {
	offers: Array<WorkspaceOffer>
	namespaces: Array<{
		offer: WorkspaceOffer
		namespace: common.NamespaceType
	}>
	specifiers?: Array<string>
}

// A valid Identifier: the Lexer never puts `_` or `-` inside a name.
const probeMemberName = "lspProbeMember"

// The path-key reading's own name, so a key reading is only answered by a key.
// See "Probes" in DEVELOPMENT.md.
const probeKeyName = "lspProbeKey"

// Characters that end an Identifier Token (`forbiddenIdentifierCharacters`),
// less `#`.
const identifierTail = /[^\s"§(){}[\]<>|/@,.:=~_-]*$/
const identifierCharacter = /[^\s"§(){}[\]<>|/@,.:=~_-]/
// A whole `is` Token, not the tail of `axis`.
const trailingIsPattern = /(?:^|[\s"§(){}[\]<>|/@,.:=~_-])is$/
const methodTriggerPattern = /::(?:<([^>]*)>)?[^\s"§(){}[\]<>|/@,.:=~_-]*$/
const memberTriggerPattern = /\.[^\s"§(){}[\]<>|/@,.:=~_-]*$/
// A base that could name a Type. `#` also ends this word, so the Case of
// `Colour#Red` reads as its own word.
const namedBaseTail = /[^\s"§(){}[\]<>|/@,.:=~_#-]*$/
// A Namespace specifier still being typed, before its `>`.
const specifierTriggerPattern = /::<[^\s"§(){}[\]<>|/@,.:=~_-]*$/
// A Case reference being typed: an optional Choice name, the `#`, and the
// Case name so far. The class excludes `#`, so the match takes the last one.
const caseTriggerPattern =
	/([^\s"§(){}[\]<>|/@,.:=~_#-]*)#[^\s"§(){}[\]<>|/@,.:=~_#-]*$/
// The stand-in a probe writes for the `#name` being typed.
const probeCaseName = "LspProbeCase"

// The Keywords that start a Statement, plus `static` inside a Namespace body
// and `implementation` around the Program.
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

// What `parsePrimaryExpression` accepts as the start of an Expression. `as` and
// `otherwise` continue an arm, never start one, so they are left out. `start`
// and `complete` are offered, since accepting either writes the same word.
const expressionKeywords = [
	"match",
	"define",
	"start",
	"complete",
	"true",
	"false",
]

export function findCompletions(
	documentText: string,
	cursor: common.Cursor,
	documentPath?: string,
	workspace: WorkspaceCompletions = { offers: [], namespaces: [] },
	analysis: DocumentAnalysis | null = null,
	// Told of a Compiler throw the list is answered around, for the log.
	onInternalError: (error: unknown) => void = () => {},
): Array<CompletionEntry> {
	return withProtocolSpellings(documentProtocolSpellings(analysis), () =>
		completionsAt(
			documentText,
			cursor,
			documentPath,
			workspace,
			analysis,
			onInternalError,
		),
	)
}

function completionsAt(
	documentText: string,
	cursor: common.Cursor,
	documentPath: string | undefined,
	workspace: WorkspaceCompletions,
	analysis: DocumentAnalysis | null,
	onInternalError: (error: unknown) => void,
): Array<CompletionEntry> {
	let lines = documentText.split("\n")
	let currentLine = lines[cursor.line - 1] ?? ""
	let beforeCursor = currentLine.slice(0, cursor.column - 1)

	// The Module sections first and alone: nothing the other modes offer is an
	// answer inside an `import { … }` block.
	let sectionCursor = moduleSectionCursor(lines, cursor)

	if (sectionCursor !== null) {
		return [
			...moduleSectionCompletions(
				sectionCursor,
				lines,
				cursor,
				parseDocument(documentText, documentPath).program,
				workspace.specifiers ?? [],
				workspace.offers,
			),
			// Only where a group is written. Inside a group's braces the answer is the
			// Module's exports, and inside a specifier the workspace's files.
			...(sectionCursor.at === "members"
				? snippetCompletions({
						context: sectionCursor.section,
						written: new Set<ModuleSection>(),
					})
				: []),
		]
	}

	// The Workspace hands in an open document's analysis; anything else derives it
	// here. A Module is linked, so imported names reach the probes.
	let document =
		analysis ??
		documentAnalysisOf(documentText, documentPath, onInternalError)
	// What every probe is linked against. Null where the document is no Module.
	let moduleView = document?.module ?? null

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

		// `::` probes a Method call and `.` a Lookup: a value proves more about
		// itself where a Method is looked up on it. See "Probes" in DEVELOPMENT.md.
		let suffix =
			memberMatch === null
				? `::${probeMemberName}()`
				: `.${probeMemberName}`

		// The path-key reading first, and only after a `.`.
		let base =
			(memberMatch === null
				? null
				: resolveProbedBase(
						headText,
						documentPath,
						`.${probeKeyName} = 0`,
						moduleView,
					)) ??
			resolveProbedBase(headText, documentPath, suffix, moduleView)

		// With the rest of the document behind the probe, the only reading that
		// sees a declaration after the cursor. Asked only where the others found
		// nothing or an Error.
		if (base === null || base.type.type === "Error") {
			let tailText = [
				currentLine.slice(cursor.column - 1),
				...lines.slice(cursor.line),
			].join("\n")

			base =
				probeReading(
					`${headText}${suffix}${tailText}`,
					documentPath,
					moduleView,
				) ?? base
		}

		// A base naming a Type, such as a Choice without a Namespace or a bounded
		// Type Parameter, resolved by name in the Type space.
		let namedType =
			memberMatch !== null &&
			(base === null || base.type.type === "Error")
				? namedTypeBase(headText, cursor, base, document)
				: null

		base = namedType ?? base

		if (base === null) {
			return []
		}

		if (specifierMatch !== null) {
			return specifierCompletions(
				documentText,
				base.type,
				documentPath,
				document,
			)
		}

		return methodMatch !== null
			? methodCompletions(
					documentText,
					base.type,
					methodMatch[1] ?? null,
					documentPath,
					workspace.namespaces,
					document,
				)
			: memberCompletions(
					base.type,
					base.program,
					namedType !== null,
					documentText,
					documentPath,
					document,
				)
	}

	// A `#` offers Cases, never Scope names, when no `::` or `.` claimed the
	// cursor.
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
			moduleView,
		)
	}

	let headText = [...lines.slice(0, cursor.line - 1), beforeCursor].join("\n")
	let space = detectSymbolSpace(headText)

	// Built first, since it lists exactly the names in reach. A member with a
	// binding of its name in reach is whole, as in `{ port }`.
	let scopeEntries = scopeCompletions(
		documentText,
		cursor,
		space,
		documentPath,
		workspace.offers,
		document,
	)

	// Record members and argument labels join the names in Scope. Keywords and
	// snippets come only here, and only in the value space.
	return [
		...contextualCompletions(
			lines,
			cursor,
			documentPath,
			moduleView,
			space === "values" ? bindingsInReach(scopeEntries) : new Set(),
		),
		...scopeEntries,
		...(space === "values"
			? [
					...keywordCompletions(headText),
					...snippetCompletions(
						snippetContextOf(
							documentText,
							documentPath,
							document,
							headText,
							cursor,
						),
					),
				]
			: []),
	]
}

// The value names a bare Identifier resolves to at the cursor, as a shorthand
// member reads them. A workspace offer is not in reach.
function bindingsInReach(entries: Array<CompletionEntry>): Set<string> {
	let bindingKinds = new Set<CompletionKind>([
		"constant",
		"variable",
		"parameter",
		"function",
		"import",
	])

	return new Set(
		entries
			.filter(
				(entry) =>
					bindingKinds.has(entry.kind) &&
					entry.tier !== completionTiers.workspace,
			)
			.map((entry) => entry.label),
	)
}

/*******************************/
/* Record members and labels   */
/*******************************/

function contextualCompletions(
	lines: Array<string>,
	cursor: common.Cursor,
	documentPath: string | undefined,
	moduleView: ModuleView | null,
	// See `bindingsInReach`. Empty says nothing about shorthands; the offers are
	// the same either way.
	bindings: Set<string> = new Set(),
): Array<CompletionEntry> {
	let headText = [
		...lines.slice(0, cursor.line - 1),
		(lines[cursor.line - 1] ?? "").slice(0, cursor.column - 1),
	].join("\n")

	let context: ArgumentContext | null = null

	for (let probeSource of probeSourcesFor(headText)) {
		// The probe types the `tests` block too, so an Argument inside a test body
		// has a Node.
		let enrichedProgram = enrichProbe(probeSource, documentPath, moduleView)

		if (enrichedProgram === null) {
			continue
		}

		try {
			context = findArgumentContext(enrichedProgram, cursor, lines)
		} catch {
			continue
		}

		if (context !== null) {
			break
		}
	}

	if (context === null) {
		return []
	}

	if (context.kind === "record") {
		// A member with a binding of its name in reach says so, since the bare
		// name is the whole member. `context.shorthand` is false in an update's
		// key list (`shorthand-in-combination`). A defaulted member ranks lower.
		return Object.entries(context.memberTypes)
			.filter(([name]) => !context.presentMembers.includes(name))
			.map(([name, type]) => {
				let omittable = context.omittableMembers.includes(name)

				return {
					label: name,
					kind: "member" as const,
					detail: omittable
						? `${printType(type)} (may be left out)`
						: context.shorthand && bindings.has(name)
							? `${printType(type)} (or '${name}' alone)`
							: printType(type),
					tier: omittable
						? completionTiers.member + 1
						: completionTiers.member,
				}
			})
	}

	// A label the call may leave out is marked so and ranks lower.
	return context.parameters
		.filter(
			(
				parameter,
			): parameter is {
				name: string
				type: common.Type
				hasDefault?: true
			} =>
				parameter.name !== null &&
				!context.usedLabels.includes(parameter.name),
		)
		.map((parameter) => ({
			label: parameter.name,
			kind: "label" as const,
			detail: parameter.hasDefault
				? `${printType(parameter.type)} (may be left out)`
				: printType(parameter.type),
			tier: parameter.hasDefault
				? completionTiers.member + 1
				: completionTiers.member,
		}))
}

/*********************************/
/* Probing for the receiver Type */
/*********************************/

// Hands back the probe's Program with the Type: a Property's `§§`
// documentation is on its declaration Node, not on the Namespace Type.
type ProbedBase = {
	type: common.Type
	program: common.typed.Program
}

function resolveProbedBase(
	headText: string,
	documentPath: string | undefined,
	suffix: string,
	moduleView: ModuleView | null,
): ProbedBase | null {
	for (let probeSource of probeSourcesFor(headText, suffix)) {
		let reading = probeReading(probeSource, documentPath, moduleView)

		if (reading !== null) {
			return reading
		}
	}

	return null
}

// One probe, enriched, and the Type its made-up member was looked up on. Null
// where the source does not parse or holds no probe, and the next reading runs.
function probeReading(
	probeSource: string,
	documentPath: string | undefined,
	moduleView: ModuleView | null,
): ProbedBase | null {
	let enrichedProgram = enrichProbe(probeSource, documentPath, moduleView)

	if (enrichedProgram === null) {
		return null
	}

	try {
		let baseType = findProbeReceiver(typedProgramNodes(enrichedProgram))

		return baseType === null
			? null
			: { type: baseType, program: enrichedProgram }
	} catch {
		// A reading that throws is no reading; the next one may answer.
		return null
	}
}

// The base of a `.` resolved by name in the Type space, after the probes found
// no value. The document's own Program is read first, then the probe's, which
// covers a document whose unclosed block leaves the cursor in no Scope.
function namedTypeBase(
	headText: string,
	cursor: common.Cursor,
	probed: ProbedBase | null,
	document: DocumentAnalysis | null,
): ProbedBase | null {
	let name = namedBaseIn(headText)

	if (name === null) {
		return null
	}

	for (let program of [
		document?.enrichedProgram ?? null,
		probed?.program ?? null,
	]) {
		if (program === null) {
			continue
		}

		let type = typeNamedAt(
			name,
			cursor,
			program,
			document?.module?.imported ?? null,
		)

		if (type !== null) {
			return { type, program }
		}
	}

	return null
}

// The bare Identifier a `.` stands on, or null for a member, a call or a Case,
// which never name a Type.
function namedBaseIn(headText: string): string | null {
	let name = namedBaseTail.exec(headText)?.[0] ?? ""

	if (name === "") {
		return null
	}

	let before = headText[headText.length - name.length - 1] ?? ""

	return before === "." || before === ":" || before === "#" ? null : name
}

// The Type the probe's made-up member was looked up on, from the first node
// that holds the probe.
function findProbeReceiver(
	nodes: Array<common.typed.ImplementationNode>,
): common.Type | null {
	for (let node of nodes) {
		let found = probeReceiverIn(node)

		if (found !== undefined) {
			return found
		}
	}

	return null
}

// Answers where `node` is the probe or reads a path key, and otherwise lets
// the shared visitor search its children.
function probeReceiverIn(node: TypedNode): common.Type | undefined {
	switch (node.nodeType) {
		// The receiver's Type, as Method resolution reads it. A Method's
		// Arguments get no path-key reading: the probe cuts the call short, so
		// no signature resolves.
		case "MethodInvocation":
			if (node.member.name === probeMemberName) {
				return node.base.type
			}

			break
		// A leading `.|` probes as `.lspProbeMember`, which the Enricher desugars into
		// a Lookup chain on the position's Parameter Type. So `.maker.|` needs no
		// branch of its own.
		case "Lookup":
			if (node.member.content === probeMemberName) {
				return node.base.type
			}

			break
		case "FunctionInvocation": {
			let found = findProbeKeyInArguments(
				node.arguments,
				node.name.type.type === "Function"
					? node.name.type.parameterTypes
					: null,
			)

			if (found !== null) {
				return found
			}

			break
		}
		// A path key has no Lookup: the probe is a key of the level the Enricher
		// wrote out, whose updated value owns the members. Read before the
		// operands.
		case "Combination":
			if (
				node.rhs.nodeType === "RecordValue" &&
				node.rhs.memberPositions?.[probeKeyName] !== undefined
			) {
				return node.lhs.type
			}

			break
		// A payload merges into the Case's default, so a path key in one reaches into
		// the Case's Record, as an Argument's does into its Parameter's.
		case "CaseValue": {
			let found =
				node.value !== null && node.type.type === "Case"
					? findProbeKeyInMerged(node.value, {
							type: "Record",
							members: node.type.members,
						})
					: null

			if (found !== null) {
				return found
			}

			break
		}
	}

	return findTypedChild(node, probeReceiverIn)
}

// The Record a path key inside a merged Literal reaches into: the Parameter's
// or Case's Type, one member deeper per level. Only levels a path key built
// are descended; a member written whole replaces its value.
function findProbeKeyInMerged(
	value: common.typed.ExpressionNode,
	into: common.Type,
): common.Type | null {
	if (value.nodeType !== "RecordValue" || into.type !== "Record") {
		return null
	}

	for (let [name, member] of Object.entries(value.members)) {
		// `Object.hasOwn` first, so a member named like an `Object.prototype` key
		// finds no JavaScript function.
		if (!isMergedLevel(member) || !Object.hasOwn(into.members, name)) {
			continue
		}

		let declaredType = into.members[name]!

		if (member.memberPositions?.[probeKeyName] !== undefined) {
			return declaredType
		}

		let found = findProbeKeyInMerged(member, declaredType)

		if (found !== null) {
			return found
		}
	}

	return null
}

// The same for one call's Arguments, each paired by label with its Parameter
// through `pairedParameters`.
function findProbeKeyInArguments(
	nodeArguments: Array<common.typed.ArgumentNode>,
	parameterTypes: common.BaseFunction["parameterTypes"] | null,
): common.Type | null {
	if (parameterTypes === null) {
		return null
	}

	let parameterForArgument = pairedParameters(nodeArguments, parameterTypes)

	for (let [argumentIndex, argument] of nodeArguments.entries()) {
		let parameter =
			parameterTypes[parameterForArgument[argumentIndex] ?? argumentIndex]

		if (parameter === undefined || parameter.type.type === "GenericUse") {
			continue
		}

		let found = findProbeKeyInMerged(argument.value, parameter.type)

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
	// Whether the base spelled a Type rather than a value: `Colour.` and `red.`
	// have one Type, and only the first reaches a static.
	namesType: boolean,
	documentText: string,
	documentPath?: string,
	document: DocumentAnalysis | null = null,
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
		let documented = namespacePropertyDocumentation(program, baseType)
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

		// And the Case listing the Enricher derives for a Choice whose Cases carry no
		// payload, such as `Side.cases()`, after everything written.
		let methods = {
			...baseType.methods,
			...derivedEnumerableNamespace(baseType)?.methods,
		}

		for (let [name, method] of Object.entries(methods)) {
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

	// And a base naming a Type: a Choice whose `cases` is derived, or a bounded
	// Type Parameter whose members are its bound's.
	if (!namesType) {
		return []
	}

	let entries: Array<CompletionEntry> = []

	for (let namespace of namedTypeNamespaces(
		baseType,
		documentText,
		documentPath,
		document,
	)) {
		for (let [name, method] of Object.entries(namespace.methods)) {
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
	}

	return entries
}

// The `§§` block of each Property by name, read off the declaration Node,
// since a Namespace Type keeps only the Property's Type. A Namespace may stand
// in any body, and is told from another of its name by its Type.
function namespacePropertyDocumentation(
	program: common.typed.Program,
	namespace: common.NamespaceType,
): Map<string, string> {
	let documented = new Map<string, string>()

	function visit(node: TypedNode) {
		if (
			node.nodeType === "NamespaceDefinitionStatement" &&
			node.type === namespace
		) {
			for (let [propertyName, property] of Object.entries(
				node.properties,
			)) {
				let description = describe(property.documentation)

				if (description !== "") {
					documented.set(propertyName, description)
				}
			}
		}

		forEachTypedChild(node, visit)
	}

	for (let body of typedProgramBodies(program)) {
		for (let node of body) {
			visit(node)
		}
	}

	return documented
}

// One entry per Overload, sharing a label: Overloads differ in the labels the
// snippet writes, and `labelDetail` tells them apart. Without a signature the
// bare entry completes the name.
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

// Static Methods take no receiver, so `::` never offers them.
function isStaticMethod(method: common.MethodType): boolean {
	return (
		method.type === "StaticMethod" ||
		method.type === "OverloadedStaticMethod"
	)
}

/*********************/
/* Method completion */
/*********************/

// Overlapping Namespaces may declare one Method name, and the Enricher calls
// the most specific. Completion orders them the same way, so the shown
// signature is the one called. A tie stays as found.
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
	document: DocumentAnalysis | null = null,
): Array<CompletionEntry> {
	// The Namespaces in Scope first, so a Method that resolves today wins its name
	// over one that needs an import.
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
		[],
		document,
	)
	let namespaces = [
		...inScope,
		...matchingNamespaces(
			documentText,
			baseType,
			specifierName,
			documentPath,
			workspaceNamespaces.map((candidate) => candidate.namespace),
			document,
		).filter((namespace) => offers.has(namespace.name)),
	]
	let seen = new Set<string>()
	let entries: Array<CompletionEntry> = []
	// One lazy parse for every offer's import edit, since all are built against
	// the same document.
	let importProgram: parser.Program | null = null

	for (let namespace of namespaces) {
		let offer = offers.get(namespace.name)

		if (offer !== undefined && importProgram === null) {
			importProgram = parseDocument(documentText).program
		}

		let importEdit =
			offer === undefined
				? null
				: importEditFor(documentText, importProgram!, offer)

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

// Built against the current document. Null where the block holds the entry
// already; the offer stays, since the Method is reachable.
function importEditFor(
	documentText: string,
	program: parser.Program,
	offer: WorkspaceOffer,
): ImportEdit | null {
	return insertImportEdit(documentText, program, {
		name: offer.name,
		alias: null,
		specifier: offer.specifier,
	})
}

// Inside `::<…>`, only the Namespaces `::` draws its Methods from.
function specifierCompletions(
	documentText: string,
	baseType: common.Type,
	documentPath?: string,
	document: DocumentAnalysis | null = null,
): Array<CompletionEntry> {
	let seen = new Set<string>()
	let entries: Array<CompletionEntry> = []

	for (let namespace of matchingNamespaces(
		documentText,
		baseType,
		null,
		documentPath,
		[],
		document,
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

// A detail is one line, so an Overload set shows its first signature and
// counts the rest.
function printInvokedSignature(method: common.MethodType): string {
	return printSignatureSummary(signaturesOf(method) ?? [])
}

/*******************/
/* Case completion */
/*******************/

// The Cases a `#` reference could name. An annotated position pins one applied
// Choice, whose Cases come back instantiated. Otherwise every Choice in Scope
// offers its Cases, as in `findCaseTypesInScope`, narrowed by a written prefix.
function caseCompletions(
	lines: Array<string>,
	cursor: common.Cursor,
	beforeCursor: string,
	currentLine: string,
	matchIndex: number,
	choicePrefix: string,
	documentPath: string | undefined,
	moduleView: ModuleView | null,
): Array<CompletionEntry> {
	// `#name` is swapped for a made-up Case so the whole document parses and one
	// enriched Program answers the expected Type and the Choices in Scope.
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

	let enrichedProgram = enrichProbe(probeText, documentPath, moduleView)

	if (enrichedProgram === null) {
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

	// An expectation names one Choice, so its Cases come in declared order and the
	// first is preselected.
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

		// The `#` is typed already, so the label is the bare Case name. The detail's
		// `Choice#Case` head tells apart two Choices sharing a Case name.
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

// One pass over the probe's Program. It threads the expected Type down to the
// made-up Case, as `argumentContext` does and through a `<-` return, and
// records every Choice's Cases. `expected` stays `undefined` until the probe.
function analyseCaseProbe(program: common.typed.Program): {
	expected: common.Type | null
	choices: Map<string, Array<common.CaseType>>
} {
	let expected: common.Type | null | undefined = undefined
	let choices = new Map<string, Array<common.CaseType>>()

	// The children in `field` are read against `expectedType`; the rest against
	// nothing.
	function visitExpecting(
		node: TypedNode,
		field: string,
		expectedType: common.Type | null,
	) {
		forEachTypedChild(node, (child, _state, childField) =>
			visitNode(child, childField === field ? expectedType : null),
		)
	}

	function visitNode(node: TypedNode, expectedType: common.Type | null) {
		switch (node.nodeType) {
			case "ChoiceDeclarationStatement":
				if (!choices.has(node.name.content)) {
					choices.set(
						node.name.content,
						node.cases.map((choiceCase) => choiceCase.type),
					)
				}

				// Read against the payload member it fills, so `= { item = #| }` offers its
				// Choice.
				forEachTypedChild(node, (child, _state, field, key) =>
					visitNode(
						child,
						field === "defaultValue"
							? {
									type: "Record",
									members:
										node.cases[key as number]!.type.members,
								}
							: null,
					),
				)

				return
			case "CaseValue":
				if (node.caseName.content === probeCaseName) {
					expected = expectedType
				}

				visitExpecting(
					node,
					"value",
					node.type.type === "Case"
						? { type: "Record", members: node.type.members }
						: null,
				)
				return
			case "ConstantDeclarationStatement":
			case "VariableDeclarationStatement":
				visitExpecting(node, "value", node.declaredType ?? node.type)
				return
			// A default is read against its own Parameter's Type, so `= #|` offers its
			// Choice.
			case "Parameter":
				visitExpecting(
					node,
					"defaultValue",
					node.internalName?.type ?? node.externalName?.type ?? null,
				)
				return
			case "FunctionDefinition":
				visitExpecting(node, "body", node.returnType)
				return
			// A `<-` in either branch returns what the body around the `if` returns.
			// The Condition, like a Guard, is read against nothing.
			case "IfStatement":
			case "IfElseStatement":
				forEachTypedChild(node, (child, _state, field) =>
					visitNode(
						child,
						field === "condition" ? null : expectedType,
					),
				)
				return
			// An Argument is read against what its Parameter expects, and each half of
			// an update against the whole.
			case "ReturnStatement":
			case "Argument":
			case "Combination":
				forEachTypedChild(node, visitNode, expectedType)
				return
			case "FunctionInvocation": {
				let calleeType = node.name.type
				let parameterTypes =
					calleeType.type === "Function"
						? calleeType.parameterTypes
						: null
				// A call that leaves an Argument out pairs the rest by label.
				let parameterForArgument = pairedParameters(
					node.arguments,
					parameterTypes,
				)

				forEachTypedChild(node, (child, _state, field, key) => {
					let index = key as number
					let parameterType =
						field === "arguments"
							? (parameterTypes?.[
									parameterForArgument[index] ?? index
								]?.type ?? null)
							: null

					visitNode(
						child,
						parameterType !== null &&
							parameterType.type !== "GenericUse"
							? parameterType
							: null,
					)
				})
				return
			}
			// A Handler's body answers the whole `match`. A Guard and a Matcher's
			// literals are read against nothing.
			case "Match":
				visitExpecting(node, "body", expectedType)
				return
			// Every arm answers the whole `define`, so each is read against the
			// expected Type. A Condition, like a Guard, is a Boolean and is read
			// against none.
			case "Define":
				visitExpecting(node, "value", expectedType)
				return
			// Each member against the Type the position expects of it, as a List's items
			// are: a half-typed `#Sta` has an Error for its own Type.
			case "RecordValue":
				forEachTypedChild(node, (member, _state, _field, name) =>
					visitNode(
						member,
						expectedType?.type === "Record"
							? (expectedType.members[name as string] ?? null)
							: null,
					),
				)
				return
			case "ListValue":
				visitExpecting(
					node,
					"values",
					expectedType?.type === "List"
						? expectedType.itemType
						: null,
				)
				return
			// Each half against its slot: a key against the key Type, a value against
			// the value Type.
			case "DictionaryValue": {
				let dictionary =
					expectedType?.type === "Dictionary" ? expectedType : null

				forEachTypedChild(node, (child, _state, field) =>
					visitNode(
						child,
						field === "key"
							? (dictionary?.keyType ?? null)
							: (dictionary?.valueType ?? null),
					),
				)
				return
			}
		}

		forEachTypedChild(node, visitNode, null)
	}

	for (let body of typedProgramBodies(program)) {
		for (let node of body) {
			visitNode(node, null)
		}
	}

	return { expected: expected ?? null, choices }
}

/********************/
/* Scope completion */
/********************/

// The symbol space of an offer, by what the other Module declared it as. A
// name bound in both spaces is one entry, offered in one.
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
	document: DocumentAnalysis | null = null,
): Array<CompletionEntry> {
	// The unmodified document's analysis. Null only where its text does not
	// parse.
	let program =
		document?.program ?? parseDocument(documentText, documentPath).program
	let enrichedProgram = document?.enrichedProgram ?? null
	let { scopes } = document?.index ?? indexProgram(program, enrichedProgram)
	let scope = scopeAt(scopes, cursor)
	let described =
		enrichedProgram === null
			? new Map<string, DeclarationInfo>()
			: describeDeclarations(enrichedProgram)
	let entries = new Map<string, Array<CompletionEntry>>()

	let searchScope: Scope | null = scope

	while (searchScope !== null) {
		for (let [name, declaration] of searchScope[space]) {
			// Constants and Variables do not hoist, so they are offered only after their
			// declaring Statement. An outer one of the same name then resolves instead.
			if (
				declaration.visibleFrom !== null &&
				!isAtOrBefore(declaration.visibleFrom, cursor)
			) {
				continue
			}

			if (entries.has(name)) {
				continue
			}

			// A Declaration's name Position joins the lexical index to the typed
			// Program; both read the same Parser Positions.
			let info =
				declaration.definition === null
					? null
					: (described.get(positionKey(declaration.definition)) ??
						null)

			// Only the top level Scope has no parent. Depth tells a local from a
			// document-wide name, and `builtin` splits the top level.
			let tier = declaration.builtin
				? completionTiers.builtin
				: searchScope.parent === null
					? completionTiers.document
					: completionTiers.local

			entries.set(name, scopeEntries(name, declaration, info, tier))
		}

		searchScope = searchScope.parent
	}

	// Only names nothing in the Scope chain answers: an offer that shadows one
	// would add an import the Compiler refuses as a duplicate.
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
	// Only a `function` is completed as a call. A Constant holding a Function is
	// as often passed on as called.
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

// A Namespace's detail is its target Type. A Choice has nothing a detail
// could add to its name.
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

// Every Declaration the enriched Program can describe, keyed by its name's
// Position: the rename index's Statements, plus Function Parameters.
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
		for (let [index, parameter] of definition.parameters.entries()) {
			let info: DeclarationInfo = {
				type:
					parameter.internalName?.type ??
					parameter.externalName?.type ??
					null,
				// A Parameter's `@param` text is on the callable's `§§` block, at the
				// Parameter's line.
				documentation: documentation?.parameters[index]?.text ?? null,
			}

			if (parameter.externalName !== null) {
				describeAt(parameter.externalName.position, info)
			}

			if (parameter.internalName !== null) {
				describeAt(parameter.internalName.position, info)
			}
		}

		forEachTypedChild(definition, visitNode)
	}

	function visitNode(node: TypedNode) {
		switch (node.nodeType) {
			case "ConstantDeclarationStatement":
			case "VariableDeclarationStatement":
				describeAt(node.name.position, {
					type: node.declaredType ?? node.type,
					documentation: describe(node.documentation) || null,
				})
				break
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
				break
			// Each Method's own `§§` block documents its Parameters.
			case "SimpleMethod":
			case "StaticMethod":
			case "OverloadedMethod":
			case "OverloadedStaticMethod":
				forEachTypedChild(node, (child) => {
					if (child.nodeType === "FunctionValue") {
						visitFunction(child.value, documentationOf(child.type))
					} else {
						visitNode(child)
					}
				})
				return
			case "ChoiceDeclarationStatement":
			case "TypeAliasStatement":
				describeAt(node.name.position, {
					type: node.type,
					documentation: describe(node.documentation) || null,
				})
				break
			case "ProtocolDeclarationStatement":
				describeAt(node.name.position, {
					type: null,
					documentation:
						describe(node.protocolType.documentation ?? null) ||
						null,
				})
				break
			case "FunctionValue":
				visitFunction(node.value, null)
				return
		}

		forEachTypedChild(node, visitNode)
	}

	for (let body of typedProgramBodies(program)) {
		for (let node of body) {
			visitNode(node)
		}
	}

	return described
}

function positionKey(position: common.Position): string {
	return `${position.start.line}:${position.start.column}`
}

/**********************/
/* Reading the cursor  */
/**********************/

// The Parser reads a Type only after one of these: `:`, `->`, a Generic `<`,
// `is`, or `|`, which only `parseType` consumes. A `,` defers to its bracket,
// and a Generic declaration list counts as an application.
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

// The bracket the cursor is innermost in. A `<` counts only directly after a
// name, so `<-` and `::<` do not, and a `>` closes only a counted `<`.
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

// A Statement starts where only a block boundary precedes the cursor on its
// line.
function isAtStatementStart(headText: string): boolean {
	let trimmed = lastLineOf(stripNoise(headText))
		.replace(identifierTail, "")
		.trimEnd()

	return trimmed === "" || trimmed.endsWith("{") || trimmed.endsWith("}")
}

// No check of where each Keyword is legal. One offered where it will not
// parse costs a Parser Diagnostic; a second model of the grammar would be
// wrong in subtler ways. `start` and `complete` may open a Statement.
function keywordCompletions(headText: string): Array<CompletionEntry> {
	return (
		isAtStatementStart(headText)
			? [...statementKeywords, "start", "complete"]
			: expressionKeywords
	).map((keyword) => ({
		label: keyword,
		kind: "keyword" as const,
		detail: null,
		tier: completionTiers.keyword,
	}))
}

// The snippets do check, through `snippetContextAt`. A wrong Keyword is one
// word to delete; a wrong snippet is lines of scaffold in the wrong block.
function snippetCompletions(scope: {
	context: SnippetContext
	written: Set<ModuleSection>
}): Array<CompletionEntry> {
	return snippetsFor(scope.context)
		.filter(
			(snippet) =>
				!(snippet.writes ?? []).some((section) =>
					scope.written.has(section),
				),
		)
		.map((snippet) => ({
			label: snippet.prefix,
			kind: "snippet" as const,
			detail: snippet.description,
			// The head of the body, so the list shows what a prefix expands to.
			labelDetail: renderPlaceholders(snippet.body[0] ?? ""),
			insertText: snippet.body.join("\n"),
			tier: completionTiers.snippet,
		}))
}

// The document's own Program, handed in by `findCompletions` unless its text
// does not parse.
function snippetContextOf(
	documentText: string,
	documentPath: string | undefined,
	document: DocumentAnalysis | null,
	headText: string,
	cursor: common.Cursor,
): { context: SnippetContext; written: Set<ModuleSection> } {
	let atStatementStart = isAtStatementStart(headText)

	try {
		let program =
			document?.program ??
			parseDocument(documentText, documentPath).program

		return {
			context: snippetContextAt(program, cursor, atStatementStart),
			written: writtenSections(program),
		}
	} catch {
		return {
			context: snippetContextAt(null, cursor, atStatementStart),
			written: writtenSections(null),
		}
	}
}

function lastLineOf(text: string): string {
	return text.slice(text.lastIndexOf("\n") + 1)
}
