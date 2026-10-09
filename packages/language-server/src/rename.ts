import { isStdlibDocument } from "@essence-lang/compiler/documents"
import {
	builtinMembers,
	builtinProtocols as builtinProtocolTable,
	builtinTypes as builtinTypeTable,
} from "@essence-lang/compiler/enricher/builtins"
import {
	caseDefaults,
	isMergedLevel,
	parameterInternalName,
	patternBindings,
} from "@essence-lang/compiler/helpers"
import {
	type FieldsHolding,
	forEachParserChild,
	forEachTypedChild,
	type ParserNode,
	type TypedNode,
} from "@essence-lang/compiler/visitor"
import type { common, parser } from "@essence-lang/interfaces"

import { calledSignature, pairedParameters } from "./argumentContext"
import { methodsOf, nativeSignaturesOf } from "./namespaceMembers"
import { contains, isSamePosition, isSmaller } from "./positions"
import { groupRelatedShapes, type ShapeGroup } from "./recordShapes"
import {
	type ParserSection,
	programSections,
	typedProgramSections,
} from "./sections"

// One file's rename index: every occurrence of a name, tied to its
// Declaration. See "Renaming" in DEVELOPMENT.md.

export type SymbolSpace = "values" | "types"

export type DeclarationKind =
	| "constant"
	| "variable"
	| "function"
	| "parameter"
	| "namespace"
	| "protocol"
	| "type"
	| "generic"
	| "method"
	| "staticMethod"
	| "property"
	| "member"
	| "label"
	// What an import entry binds. The kind the other Module declared it as is
	// for the workspace join to answer.
	| "import"

// The text one edit writes, in parts: a String as written, and `null` where
// the new name goes.
type RenameText = Array<string | null>

export type RenameEdit = {
	// An empty span inserts.
	position: common.Position
	text: RenameText
}

// Where one occurrence is written. `edits` is null except at a shorthand,
// whose rename spells out the other name. See "Shorthand edits" in
// DEVELOPMENT.md.
export type RenameSite = {
	position: common.Position
	edits: Array<RenameEdit> | null
}

// What a rename writes for one site, with the new name filled in. Every
// caller that applies a rename asks here, so no caller forgets an expansion.
export function renameEdits(
	site: { position: common.Position; edits: Array<RenameEdit> | null },
	newName: string,
): Array<{ position: common.Position; newText: string }> {
	let edits = site.edits ?? [{ position: site.position, text: [null] }]

	return edits.map((edit) => ({
		position: edit.position,
		newText: edit.text.map((part) => part ?? newName).join(""),
	}))
}

export type Declaration = {
	builtin: boolean
	kind: DeclarationKind
	// A Parameter whose name is also its call site label, as in
	// `function compute(value: Integer)`. A new name must be valid as both.
	labelled?: boolean
	definition: common.Position | null
	// Where the name becomes resolvable. Null means anywhere in its Scope:
	// builtins and the kinds the Enricher hoists. Constants and Variables are
	// visible after their declaring Statement.
	visibleFrom: common.Cursor | null
	// Shared with every Declaration this one renames with, as a Method
	// does with the requirement it answers (`shareConformanceSites`).
	occurrences: Array<RenameSite>
	// Set on a Method that answers a member of a standard library
	// Protocol. No rename reaches that member, so renaming the Method alone
	// would break the conformance.
	answersBuiltin?: boolean
}

export type Scope = {
	parent: Scope | null
	values: Map<string, Declaration>
	types: Map<string, Declaration>
}

export type ScopeRange = {
	// Null covers the whole document, for the top level Scope only.
	range: common.Position | null
	scope: Scope
}

// `write` marks a declaration or an assignment; everything else reads. Rename
// treats both alike; Document Highlight and the refactorings do not.
export type OccurrenceAccess = "read" | "write"

export type Occurrence = {
	name: string
	position: common.Position
	access: OccurrenceAccess
	// As on `RenameSite`: an Occurrence is a site with its Declaration.
	edits: Array<RenameEdit> | null
	declaration: Declaration
}

export type RenameIndex = Array<Occurrence>

type RecordMemberSite = {
	names: Array<string>
	// Whether the members are written here, as in a Record literal or Type.
	// A Pattern only names them, and its binder holds the same Position, which
	// the workspace join would merge.
	declares: boolean
	members: Array<{
		name: string
		position: common.Position
		edits: Array<RenameEdit> | null
	}>
}

type RecordMemberLookup = {
	names: Array<string>
	name: string
	position: common.Position
}

type WalkContext = {
	index: RenameIndex
	// The sites of each Declaration holding more than `sitesScannedAtMost` of
	// them, by Position, so `record` finds a repeat without a scan.
	sitesByPosition: Map<Array<RenameSite>, Map<string, RenameSite>>
	// The Function Definitions each value Declaration is known to hold, from
	// Function Statements and Function Values bound by declaration or assignment.
	functionDefinitions: Map<Declaration, Array<parser.FunctionDefinitionNode>>
	// Call site label to Declaration, per Function Definition. A Parameter
	// written without an explicit label is its own label Declaration.
	labels: Map<parser.FunctionDefinitionNode, Map<string, Declaration>>
	// Labelled arguments, resolved after the walk so a hoisted or later
	// assigned Function sees its labels.
	pendingLabelReferences: Array<{
		identifier: parser.IdentifierNode
		callee: Declaration
	}>
	// Property and Method Declarations per Namespace, keyed as
	// `siteKeyOf` keys a Namespace, since two declared in bodies may share a
	// name.
	namespaceMembers: Map<string, Map<string, Declaration>>
	// The keys each Namespace name is declared under.
	namespaceKeys: Map<string, Array<string>>
	// The key of each typed Namespace by its Type, which is the object a
	// call on it resolves to. Filled as the typed pass reaches each declaration.
	namespaceTypeKeys: Map<common.Type, string>
	// The calls on a name more than one Namespace is declared under whose
	// Namespace the typed pass had not reached, bound once it has.
	namespaceMemberReferences: Array<{
		namespaceName: string
		namespaceType: common.Type
		memberName: string
		position: common.Position
	}>
	// The same per Protocol, kept apart since a Protocol and a Namespace may
	// share a name. A provided Method or a call on a bounded Type binds here.
	// Keyed as `siteKeyOf` keys a Protocol.
	protocolMembers: Map<string, Map<string, Declaration>>
	// The Protocols each Protocol declared here extends, as its `is` list
	// names them. A requirement is looked for through them as well.
	protocolExtensions: Map<string, Array<string>>
	// The key of each Protocol declared here, by the identity the typed
	// tree names it by, filled as the typed pass reaches each declaration.
	ownProtocols: Map<string, string>
	// The references a Protocol answers, bound once the typed pass has
	// met every Protocol the file declares, wherever it stands.
	protocolMemberReferences: Array<{
		identity: string
		memberName: string
		position: common.Position
	}>
	conformances: Array<ConformanceLink>
	// Method and property references whose Namespace or Protocol this file
	// does not declare, by the name they resolved through. The workspace join
	// binds those another Module declares; a builtin's stay unbound.
	externalMembers: Array<ExternalMemberReference>
	// Record member declaration sites (literals and Record Type
	// declarations) and member Lookups, grouped structurally after the walk.
	recordSites: Array<RecordMemberSite>
	recordLookups: Array<RecordMemberLookup>
	// A literal's site by the Position of its braces, and a Pattern's by each
	// member's name, so the typed pass can widen them.
	literalSites: Map<string, RecordMemberSite>
	patternSites: Map<string, RecordMemberSite>
	// The shape each typed literal writes into, where `widenLiteral` knew it.
	writtenShapes: Map<common.typed.RecordValueNode, Array<string>>
	// Every Scope with the Position it spans, for `scopeAt`.
	scopes: Array<ScopeRange>
}

type ExternalMemberReference = {
	// The name the Namespace is reachable under in this file. An aliased
	// import binds a copy of the Namespace Type under its local name.
	namespaceName: string
	memberName: string
	position: common.Position
	// Set where a Protocol this file does not declare answers the call.
	// `namespaceName` is then the Protocol's identity, which names the Module
	// that declares it, and the workspace index looks the member up there.
	protocol?: true
}

// A Method of a Namespace conforming to a Protocol, or of a Protocol extending
// one. If the Protocol holds a member of that name, the two rename together.
export type ConformanceLink = {
	declaration: Declaration
	// The Protocol the `is` clause names, keyed by `siteKeyOf`. The key may be
	// an import's local name.
	protocolName: string
	memberName: string
}

// The top level Scope the Enricher starts from, read from its builtin tables
// on use. Part of them is enriched from Essence source on first read.
const builtinValues = () => Object.entries(builtinMembers())

const builtinTypes = () => Object.keys(builtinTypeTable())

const builtinProtocols = () => Object.keys(builtinProtocolTable())

// Whether a standard library Protocol's surface holds the member, which
// is then declared where no rename reaches. `methods` is a plain object, so
// an inherited name such as `toString` is not one of its members.
export function isBuiltinProtocolMember(
	protocolName: string,
	memberName: string,
): boolean {
	let protocol = builtinProtocolTable()[protocolName]

	return protocol !== undefined && Object.hasOwn(protocol.methods, memberName)
}

const reservedWords = new Set([
	"if",
	"else",
	"type",
	"constant",
	"variable",
	"function",
	"static",
	"implementation",
	"overload",
	"match",
	"case",
	"with",
	"define",
	"namespace",
	"protocol",
	"for",
	"infer",
	"choice",
	"true",
	"false",
	// Separates a member from its binder inside a Pattern, so a binder named
	// `as` would read `{ width as as }`. Only rename targets are restricted.
	"as",
])

// Characters that end an Identifier Token in the Lexer.
const forbiddenIdentifierCharacters = /[\s"§(){}[\]<>|/@,.:=\-~_#]/

// One whole Identifier, as a pattern String for linked editing. Number
// literals are not covered, since rename only targets Identifiers.
export const identifierPattern = '[^\\s"§(){}\\[\\]<>|/@,.:=~_#-]+'

export function isValidIdentifierName(name: string): boolean {
	return (
		name.length > 0 &&
		!forbiddenIdentifierCharacters.test(name) &&
		!/^[0-9]/.test(name) &&
		!reservedWords.has(name)
	)
}

// Keywords the Parser's `identifierTokenTypes` admits as Identifiers. A label
// may take them, as in `slice(from 1, to 3)`, though a binding named `with`
// would collide with a Combination.
const keywordIdentifiers = new Set([
	"with",
	"static",
	"case",
	"infer",
	"choice",
	"import",
	"export",
	"from",
	"as",
])

// Valid names everywhere but in a label, where `compute(start 1)` parses as a
// `start` of `1` (`opensAsynchrony`).
const prefixKeywords = new Set(["start", "complete"])

export function isValidLabelName(name: string): boolean {
	if (prefixKeywords.has(name)) {
		return false
	}

	return isValidIdentifierName(name) || keywordIdentifiers.has(name)
}

// A name valid both as a binding and as a label, for a Parameter whose name
// is its label.
export function isValidBindingLabelName(name: string): boolean {
	return isValidIdentifierName(name) && !prefixKeywords.has(name)
}

// Refuses inside a standard library source, and so do Prepare Rename and
// Linked Editing. See "No renaming inside the standard library" in
// DEVELOPMENT.md.
export function findRenameableOccurrence(
	program: parser.Program,
	cursor: common.Cursor,
	enrichedProgram: common.typed.Program | null = null,
	documentPath?: string,
): Occurrence | null {
	if (isStdlibDocument(documentPath)) {
		return null
	}

	let occurrence = findOccurrence(program, cursor, enrichedProgram)

	if (
		occurrence === null ||
		occurrence.declaration.builtin ||
		occurrence.declaration.answersBuiltin === true
	) {
		return null
	}

	return occurrence
}

// Accepts builtins, since references and highlighting only read.
export function findOccurrence(
	program: parser.Program,
	cursor: common.Cursor,
	enrichedProgram: common.typed.Program | null = null,
): Occurrence | null {
	return occurrenceAt(buildRenameIndex(program, enrichedProgram), cursor)
}

// Every index entry of the Declaration under the cursor. Only the entries
// carry the access Document Highlight shows.
export function findOccurrences(
	program: parser.Program,
	cursor: common.Cursor,
	enrichedProgram: common.typed.Program | null = null,
): Array<Occurrence> {
	let index = buildRenameIndex(program, enrichedProgram)
	let occurrence = occurrenceAt(index, cursor)

	if (occurrence === null) {
		return []
	}

	return index.filter((entry) => entry.declaration === occurrence.declaration)
}

export function findDefinition(
	program: parser.Program,
	cursor: common.Cursor,
	enrichedProgram: common.typed.Program | null = null,
): common.Position | null {
	let occurrence = occurrenceAt(
		buildRenameIndex(program, enrichedProgram),
		cursor,
	)

	return occurrence?.declaration.definition ?? null
}

export function buildRenameIndex(
	program: parser.Program,
	enrichedProgram: common.typed.Program | null = null,
): RenameIndex {
	return indexProgram(program, enrichedProgram).index
}

export type ProgramIndex = {
	index: RenameIndex
	scopes: Array<ScopeRange>
	// Lets the workspace join reach the members of a Namespace an importer
	// names. A top level Namespace, the only kind an entry names, is keyed by
	// its own name, which is unique there.
	namespaceMembers: Map<string, Map<string, Declaration>>
	// The same, for the Methods a Protocol declares, reached through the
	// entry that imports the Protocol or by its identity.
	protocolMembers: Map<string, Map<string, Declaration>>
	protocolExtensions: Map<string, Array<string>>
	externalMembers: Array<ExternalMemberReference>
	// Every link, including those this file resolves. The workspace join
	// resolves them all again, so another Module's Protocol joins the same way.
	conformances: Array<ConformanceLink>
	// The Record member Declarations, by the shapes that relate them, so the
	// workspace join relates them to another Module's.
	recordMembers: Array<ShapeGroup<Declaration>>
}

export function indexProgram(
	program: parser.Program,
	enrichedProgram: common.typed.Program | null = null,
): ProgramIndex {
	let context: WalkContext = {
		index: [],
		sitesByPosition: new Map(),
		functionDefinitions: new Map(),
		labels: new Map(),
		pendingLabelReferences: [],
		namespaceMembers: new Map(),
		namespaceKeys: new Map(),
		namespaceTypeKeys: new Map(),
		namespaceMemberReferences: [],
		protocolMembers: new Map(),
		protocolExtensions: new Map(),
		ownProtocols: new Map(),
		protocolMemberReferences: [],
		conformances: [],
		externalMembers: [],
		recordSites: [],
		recordLookups: [],
		literalSites: new Map(),
		patternSites: new Map(),
		writtenShapes: new Map(),
		scopes: [],
	}

	let topLevelScope = createScope(null)

	context.scopes.push({ range: null, scope: topLevelScope })

	for (let [name, member] of builtinValues()) {
		topLevelScope.values.set(name, {
			builtin: true,
			kind: member.type === "Namespace" ? "namespace" : "function",
			definition: null,
			visibleFrom: null,
			occurrences: [],
		})
	}

	for (let name of builtinTypes()) {
		topLevelScope.types.set(name, {
			builtin: true,
			kind: "type",
			definition: null,
			visibleFrom: null,
			occurrences: [],
		})
	}

	// Protocols share the `types` space, since only Type positions name them.
	for (let name of builtinProtocols()) {
		topLevelScope.types.set(name, {
			builtin: true,
			kind: "protocol",
			definition: null,
			visibleFrom: null,
			occurrences: [],
		})
	}

	// Imports are in Scope before the first Statement, and exports read the
	// Scope after the whole implementation.
	declareImports(program, topLevelScope, context)

	walkSections(program, { scope: topLevelScope, context })

	referenceExports(program, topLevelScope, context)

	for (let { identifier, callee } of context.pendingLabelReferences) {
		for (let definition of context.functionDefinitions.get(callee) ?? []) {
			let labelDeclaration = context.labels
				.get(definition)
				?.get(identifier.content)

			if (labelDeclaration !== undefined) {
				record(
					labelDeclaration,
					identifier.content,
					identifier.position,
					context,
				)
				break
			}
		}
	}

	if (enrichedProgram !== null) {
		for (let section of typedProgramSections(enrichedProgram)) {
			for (let node of [...section.head, ...section.nodes]) {
				walkTypedNode(node, context)
			}
		}
	}

	bindNamespaceMembers(context)

	bindProtocolMembers(context)

	let recordMembers = resolveRecordMembers(context)

	shareConformanceSites(context)

	return {
		index: context.index,
		scopes: context.scopes,
		namespaceMembers: context.namespaceMembers,
		protocolMembers: context.protocolMembers,
		protocolExtensions: context.protocolExtensions,
		externalMembers: context.externalMembers,
		conformances: context.conformances,
		recordMembers,
	}
}

// The innermost Scope a Cursor stands in.
export function scopeAt(
	scopes: Array<ScopeRange>,
	cursor: common.Cursor,
): Scope {
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

// An entry binds its local name in both spaces through one hoisted
// Declaration, since a Type and a Namespace of one name travel together.
function declareImports(
	program: parser.Program,
	scope: Scope,
	context: WalkContext,
) {
	let declared = topLevelNames(program)

	for (let entry of program.imports?.entries ?? []) {
		let local = entry.alias ?? entry.name
		let declaration: Declaration = {
			builtin: false,
			kind: "import",
			definition: local.position,
			visibleFrom: null,
			occurrences: [],
		}

		// The Compiler refuses an entry whose name this Module declares, and
		// uses resolve to the declaration. The entry's Identifier is still
		// indexed, so the mistake can be renamed.
		if (!declared.has(local.content)) {
			scope.values.set(local.content, declaration)
			scope.types.set(local.content, declaration)
		}

		record(declaration, local.content, local.position, context, "write")
	}
}

// What the implementation declares at its top level, asked before the walk.
// The tests section is a child Scope, whose names shadow an entry.
export function topLevelNames(program: parser.Program): Set<string> {
	let names = new Set<string>()

	for (let node of program.implementation.nodes) {
		switch (node.nodeType) {
			case "ConstantDeclarationStatement":
			case "VariableDeclarationStatement":
				if (node.name.nodeType === "Pattern") {
					for (let binding of patternBindings(node.name)) {
						names.add(binding.name.content)
					}
				} else {
					names.add(node.name.content)
				}
				break
			case "FunctionStatement":
			case "OverloadedFunctionStatement":
			case "NamespaceDefinitionStatement":
			case "TypeAliasStatement":
			case "ChoiceDeclarationStatement":
			case "ProtocolDeclarationStatement":
				names.add(node.name.content)
				break
		}
	}

	return names
}

// Binds the local side of each export entry. A re-export's name, and a public
// name such as the alias of `area as measure`, are for the workspace join.
function referenceExports(
	program: parser.Program,
	scope: Scope,
	context: WalkContext,
) {
	for (let entry of program.exports?.entries ?? []) {
		if (entry.source !== null) {
			continue
		}

		if (reference(scope, "values", entry.name, context) === null) {
			reference(scope, "types", entry.name, context)
		}
	}
}

export function occurrenceAt(
	index: RenameIndex,
	cursor: common.Cursor,
): Occurrence | null {
	// `end.column` is exclusive, but a cursor directly behind the Identifier
	// still counts. Identifiers never span lines.
	for (let occurrence of index) {
		if (
			occurrence.position.start.line === cursor.line &&
			occurrence.position.start.column <= cursor.column &&
			cursor.column <= occurrence.position.end.column
		) {
			return occurrence
		}
	}

	return null
}

/***********/
/* Scoping */
/***********/

function createScope(parent: Scope | null): Scope {
	return { parent, values: new Map(), types: new Map() }
}

function lookup(
	scope: Scope,
	space: SymbolSpace,
	name: string,
): Declaration | null {
	let searchScope: Scope | null = scope

	while (searchScope !== null) {
		let declaration = searchScope[space].get(name)

		if (declaration !== undefined) {
			return declaration
		}

		searchScope = searchScope.parent
	}

	return null
}

const sitesScannedAtMost = 16

function positionKey(position: common.Position): string {
	return `${position.start.line}:${position.start.column}:${position.end.line}:${position.end.column}`
}

function siteAt(
	sites: Array<RenameSite>,
	position: common.Position,
	context: WalkContext,
): RenameSite | undefined {
	if (sites.length <= sitesScannedAtMost) {
		return sites.find((site) => isSamePosition(site.position, position))
	}

	let byPosition = context.sitesByPosition.get(sites)

	if (byPosition === undefined) {
		byPosition = new Map(
			sites.map((site) => [positionKey(site.position), site]),
		)
		context.sitesByPosition.set(sites, byPosition)
	}

	return byPosition.get(positionKey(position))
}

function record(
	declaration: Declaration,
	name: string,
	position: common.Position,
	context: WalkContext,
	access: OccurrenceAccess = "read",
	// See `RenameSite.edits`.
	edits: Array<RenameEdit> | null = null,
) {
	// One Position is one occurrence of one Declaration, or a rename would
	// write it twice. A shorthand binder is reached twice for its member, from
	// the Pattern and from its desugared Lookup; the entry with edits wins.
	let existing = siteAt(declaration.occurrences, position, context)

	if (existing !== undefined) {
		existing.edits ??= edits

		return
	}

	let site: RenameSite = { position, edits }

	declaration.occurrences.push(site)
	context.sitesByPosition
		.get(declaration.occurrences)
		?.set(positionKey(position), site)

	context.index.push({
		name,
		position,
		access,
		edits,
		declaration,
	})
}

function declareInScope(
	scope: Scope,
	space: SymbolSpace,
	identifier: parser.IdentifierNode,
	kind: DeclarationKind,
	context: WalkContext,
	// Null for the kinds that hoist. Set only when the Declaration is created.
	visibleFrom: common.Cursor | null = null,
	// See `RenameSite.edits`.
	edits: Array<RenameEdit> | null = null,
): Declaration {
	// A re-declaration shares the first Declaration; the Enricher reports it.
	let declaration = scope[space].get(identifier.content)

	if (declaration === undefined) {
		declaration = {
			builtin: false,
			kind,
			definition: null,
			visibleFrom,
			occurrences: [],
		}
		scope[space].set(identifier.content, declaration)
	}

	declaration.definition ??= identifier.position

	record(
		declaration,
		identifier.content,
		identifier.position,
		context,
		"write",
		edits,
	)

	return declaration
}

function reference(
	scope: Scope,
	space: SymbolSpace,
	identifier: parser.IdentifierNode,
	context: WalkContext,
	access: OccurrenceAccess = "read",
	// See `RenameSite.edits`.
	edits: Array<RenameEdit> | null = null,
): Declaration | null {
	let declaration = lookup(scope, space, identifier.content)

	// The Enricher reports an undeclared name.
	if (declaration !== null) {
		record(
			declaration,
			identifier.content,
			identifier.position,
			context,
			access,
			edits,
		)
	}

	return declaration
}

function linkFunctionDefinition(
	declaration: Declaration,
	definition: parser.FunctionDefinitionNode,
	context: WalkContext,
) {
	let definitions = context.functionDefinitions.get(declaration)

	if (definitions === undefined) {
		definitions = []
		context.functionDefinitions.set(declaration, definitions)
	}

	definitions.push(definition)
}

// Mirrors the Enricher's `hoistDeclarations` without its speculative
// resolution: binding a use to the declaration is what a rename means anyway.
function hoistDeclarations(
	nodes: Array<parser.ImplementationNode>,
	scope: Scope,
) {
	for (let node of nodes) {
		if (
			node.nodeType === "TypeAliasStatement" ||
			node.nodeType === "ChoiceDeclarationStatement"
		) {
			if (!scope.types.has(node.name.content)) {
				scope.types.set(node.name.content, {
					builtin: false,
					kind: "type",
					definition: null,
					visibleFrom: null,
					occurrences: [],
				})
			}
		} else if (node.nodeType === "ProtocolDeclarationStatement") {
			if (!scope.types.has(node.name.content)) {
				scope.types.set(node.name.content, {
					builtin: false,
					kind: "protocol",
					definition: null,
					visibleFrom: null,
					occurrences: [],
				})
			}
		} else if (
			node.nodeType === "FunctionStatement" ||
			node.nodeType === "OverloadedFunctionStatement" ||
			node.nodeType === "NamespaceDefinitionStatement"
		) {
			if (!scope.values.has(node.name.content)) {
				scope.values.set(node.name.content, {
					builtin: false,
					kind:
						node.nodeType === "NamespaceDefinitionStatement"
							? "namespace"
							: "function",
					definition: null,
					visibleFrom: null,
					occurrences: [],
				})
			}
		}
	}
}

// The span of a Body's Statements, since a Body has no Position of its own.
function rangeOfBody(
	nodes: Array<parser.ImplementationNode>,
	fallback: common.Position,
): common.Position {
	if (nodes.length === 0) {
		return fallback
	}

	return {
		start: nodes[0].position.start,
		end: nodes[nodes.length - 1].position.end,
	}
}

/***********/
/* Walkers */
/***********/

// What the parser walk carries to every node: the Scope its names resolve
// in, and the index it fills.
type Walk = {
	scope: Scope
	context: WalkContext
}

function inScope(walk: Walk, scope: Scope): Walk {
	return { scope, context: walk.context }
}

// Every body a Program holds, each in its own Scope. Sections arrive
// outermost first, so a parent's Scope always exists. As in the Enricher, a
// test's body binds in order and every other Section hoists.
function walkSections(program: parser.Program, topLevel: Walk) {
	let walks = new Map<ParserSection, Walk>()

	for (let section of programSections(program)) {
		let parent =
			section.parent === null
				? topLevel
				: (walks.get(section.parent) ?? topLevel)
		let walk =
			section.parent === null
				? topLevel
				: childWalk(parent, section.position)

		walks.set(section, walk)

		// The head reads the enclosing Scope: a table's rows are written
		// outside the body.
		for (let node of section.head) {
			walkNode(node, parent)
		}

		declareTestParameters(section.parameters, walk)

		walkBody(section.nodes, walk, {
			hoist: section.kind !== "test",
		})
	}
}

// The row Parameter of `across [ … ] (row: Row)` and the generated
// Parameters of `for any (a: T, b: U)`. Read like a closure's Parameters,
// without labels, since nothing calls a test.
function declareTestParameters(
	parameters: Array<parser.ParameterNode>,
	walk: Walk,
) {
	for (let parameter of parameters) {
		walkTypeDeclaration(parameter.type, walk)

		if (parameter.defaultValue !== null) {
			walkNode(parameter.defaultValue, walk)
		}

		if (parameter.internalName === null) {
			continue
		}

		if (parameter.internalName.nodeType === "Pattern") {
			declarePattern(parameter.internalName, walk, "parameter")

			continue
		}

		// Visible throughout the Section: a table test's name, written before
		// the body, reads the row.
		declareInScope(
			walk.scope,
			"values",
			parameter.internalName,
			"parameter",
			walk.context,
		)
	}
}

function walkBody(
	nodes: Array<parser.ImplementationNode>,
	walk: Walk,
	{ hoist }: { hoist: boolean },
) {
	// Nested bodies bind in order, as in the Enricher.
	if (hoist) {
		hoistDeclarations(nodes, walk.scope)
	}

	for (let node of nodes) {
		walkNode(node, walk)
	}
}

// A kind that opens a Scope or binds a name has a case of its own, and every
// other kind descends through `forEachParserChild`. See "The parser walk" in
// DEVELOPMENT.md.
function walkNode(node: ParserNode, walk: Walk) {
	let { scope, context } = walk

	switch (node.nodeType) {
		case "ConstantDeclarationStatement":
		case "VariableDeclarationStatement": {
			if (node.type !== null) {
				walkTypeDeclaration(node.type, walk)
			}

			walkNode(node.value, walk)

			let kind =
				node.nodeType === "ConstantDeclarationStatement"
					? ("constant" as const)
					: ("variable" as const)

			// A Pattern declares each name it binds, so no single Declaration
			// links to a Function value.
			if (node.name.nodeType === "Pattern") {
				declarePattern(
					node.name,
					walk,
					kind,
					// Visible after the whole Statement, so the value cannot read
					// a name it binds.
					node.position.end,
				)

				return
			}

			let declaration = declareInScope(
				scope,
				"values",
				node.name,
				kind,
				context,
				// Visible after the whole Statement, so the value cannot read
				// the name.
				node.position.end,
			)

			if (node.value.nodeType === "FunctionValue") {
				linkFunctionDefinition(declaration, node.value.value, context)
			}

			return
		}
		case "VariableAssignmentStatement": {
			let declaration = reference(
				scope,
				"values",
				node.name,
				context,
				"write",
			)

			walkNode(node.value, walk)

			if (
				declaration !== null &&
				node.value.nodeType === "FunctionValue"
			) {
				linkFunctionDefinition(declaration, node.value.value, context)
			}

			return
		}
		case "FunctionStatement": {
			let declaration = declareInScope(
				scope,
				"values",
				node.name,
				"function",
				context,
			)

			linkFunctionDefinition(declaration, node.value, context)
			walkFunctionDefinition(node.value, walk, node.position)
			return
		}
		case "OverloadedFunctionStatement": {
			let declaration = declareInScope(
				scope,
				"values",
				node.name,
				"function",
				context,
			)

			// An `overload function` block may mix bodied Functions with native
			// signatures; only a bodied one has a definition to link.
			for (let method of node.methods) {
				if (method.nodeType === "FunctionValue") {
					linkFunctionDefinition(declaration, method.value, context)
					walkFunctionDefinition(method.value, walk, method.position)
				} else {
					walkNativeSignature(method, walk)
				}
			}

			return
		}
		case "NamespaceDefinitionStatement":
			walkNamespaceDefinition(node, walk)
			return
		case "ProtocolDeclarationStatement":
			walkProtocolDeclaration(node, walk)
			return
		case "ChoiceDeclarationStatement": {
			declareInScope(scope, "types", node.name, "type", context)

			// A generic Choice's Type Parameters bind across every Case's
			// payload, as a Type Alias's do.
			let choiceWalk = inScope(
				walk,
				scopeWithGenerics(node.generics, walk),
			)

			// A Case name resolves through its Choice; only the payload's Types
			// hold references.
			for (let choiceCase of node.cases) {
				if (choiceCase.type !== null) {
					walkTypeDeclaration(choiceCase.type, choiceWalk)
				}
			}

			// A payload default names values in the enclosing Scope, since a
			// Choice opens no frame for values.
			for (let defaultValue of caseDefaults(node.cases)) {
				walkNode(defaultValue, walk)
			}

			return
		}
		case "TypeAliasStatement":
			walkTypeAlias(node, walk)
			return
		case "IfStatement": {
			walkNode(node.condition, walk)

			let bodyWalk = childWalk(
				walk,
				rangeOfBody(node.body, node.position),
			)

			walkBody(node.body, bodyWalk, { hoist: false })
			return
		}
		case "IfElseStatement": {
			walkNode(node.condition, walk)

			let trueWalk = childWalk(
				walk,
				rangeOfBody(node.trueBody, node.position),
			)
			let falseWalk = childWalk(
				walk,
				rangeOfBody(node.falseBody, node.position),
			)

			walkBody(node.trueBody, trueWalk, { hoist: false })
			walkBody(node.falseBody, falseWalk, { hoist: false })
			return
		}
		// `require MATCHER = EXPR` binds into the enclosing block, visible
		// after the Statement, since a failed `require` ends the test.
		case "ExpectStatement":
		case "RequireStatement": {
			walkNode(node.value, walk)

			if (node.matcher === null) {
				return
			}

			// Read as a Match Handler's Matcher: only a prefixed Choice name is
			// a Type reference.
			if (node.matcher.nodeType === "Pattern") {
				declarePattern(
					node.matcher,
					walk,
					"constant",
					node.position.end,
				)
			} else if (node.matcher.nodeType === "CaseMatcher") {
				if (node.matcher.choice !== null) {
					reference(scope, "types", node.matcher.choice, context)
				}

				if (node.matcher.binding?.nodeType === "Pattern") {
					declarePattern(
						node.matcher.binding,
						walk,
						"constant",
						node.position.end,
					)
				} else if (node.matcher.binding !== null) {
					declareInScope(
						scope,
						"values",
						node.matcher.binding,
						"constant",
						context,
						node.position.end,
					)
				}
			} else if (
				node.matcher.nodeType !== "WildcardMatcher" &&
				node.matcher.nodeType !== "LiteralMatcher"
			) {
				walkTypeDeclaration(node.matcher, walk)
			}

			return
		}
		case "Identifier":
			reference(scope, "values", node, context)
			return
		case "FunctionInvocation": {
			let callee: Declaration | null = null

			if (node.name.nodeType === "Identifier") {
				callee = reference(scope, "values", node.name, context)
			} else {
				walkNode(node.name, walk)
			}

			for (let argument of node.arguments) {
				if (argument.name !== null && callee !== null) {
					context.pendingLabelReferences.push({
						identifier: argument.name,
						callee,
					})
				}

				walkNode(argument, walk)
			}

			return
		}
		case "Match":
			walkNode(node.value, walk)
			walkTypeDeclaration(node.returnType, walk)

			for (let handler of node.handlers) {
				if (handler.matcher.nodeType === "Pattern") {
					// Declared in the Handler's Scope, which does not exist yet.
				} else if (handler.matcher.nodeType === "CaseMatcher") {
					// The Case resolves through the matched value's Type; only a
					// prefixed Choice name is a Type reference.
					if (handler.matcher.choice !== null) {
						reference(
							scope,
							"types",
							handler.matcher.choice,
							context,
						)
					}
				} else if (
					handler.matcher.nodeType !== "WildcardMatcher" &&
					handler.matcher.nodeType !== "LiteralMatcher"
				) {
					walkTypeDeclaration(handler.matcher, walk)
				}

				// One Scope from the Matcher on, since a binding written in the
				// Matcher is read in the Guard and the body alike.
				let handlerWalk = childWalk(walk, {
					start: handler.matcher.position.start,
					end: rangeOfBody(handler.body, node.position).end,
				})

				// Declared before the Guard and the body are walked.
				if (handler.matcher.nodeType === "Pattern") {
					declarePattern(handler.matcher, handlerWalk, "constant")
				} else if (
					handler.matcher.nodeType === "CaseMatcher" &&
					handler.matcher.binding !== null
				) {
					if (handler.matcher.binding.nodeType === "Pattern") {
						declarePattern(
							handler.matcher.binding,
							handlerWalk,
							"constant",
						)
					} else {
						declareInScope(
							handlerWalk.scope,
							"values",
							handler.matcher.binding,
							"constant",
							context,
						)
					}
				}

				if (handler.guard !== null) {
					walkNode(handler.guard, handlerWalk)
				}

				walkBody(handler.body, handlerWalk, { hoist: false })
			}

			return
		// The Type first, so the members it declares are the definitions the
		// literal's members join.
		case "RecordValue": {
			let { members } = node

			walkTypeDeclaration(node.type, walk)
			registerRecordSite(Object.values(members), context, node.position)
			forEachParserChild(
				node,
				(child, memberWalk, field, key) => {
					if (field !== "type") {
						walkRecordMember(
							members[key!],
							child,
							memberWalk,
							field,
						)
					}
				},
				walk,
			)
			return
		}
		case "FunctionValue":
			walkFunctionDefinition(node.value, walk, node.position)
			return
		case "RecordTypeDeclaration":
			registerRecordSite(Object.values(node.members), context)
			break
	}

	walkChildren(node, walk)
}

// The kinds `walkNode` walks by a case of its own. A Record literal is not
// among them, since its members reach `walkChild`.
export const walkedKinds = [
	"ConstantDeclarationStatement",
	"VariableDeclarationStatement",
	"VariableAssignmentStatement",
	"FunctionStatement",
	"OverloadedFunctionStatement",
	"NamespaceDefinitionStatement",
	"ProtocolDeclarationStatement",
	"ChoiceDeclarationStatement",
	"TypeAliasStatement",
	"IfStatement",
	"IfElseStatement",
	"ExpectStatement",
	"RequireStatement",
	"Identifier",
	"FunctionInvocation",
	"Match",
	"FunctionValue",
] as const

type WalkedKind = (typeof walkedKinds)[number]

type ReachedNode = Exclude<ParserNode, { nodeType: WalkedKind }>

type ReachedKind = ReachedNode["nodeType"]

// How `walkChild` reads an Identifier: as a value, as a Type, or as no name a
// Scope holds. See "The parser walk" in DEVELOPMENT.md.
type IdentifierRole = "value" | "type" | "unscoped"

// Every field of a reached kind whose visit can hand `walkChild` an
// Identifier. Read off the union of kinds at once, which costs the type
// checker far less than reading it kind by kind.
type IdentifierField = FieldsHolding<ReachedNode, parser.IdentifierNode>

type IdentifierRoles = {
	[Kind in IdentifierField["kind"]]: Record<
		Extract<Extract<IdentifierField, { kind: Kind }>["field"], string>,
		IdentifierRole
	>
}

// The role of every field that can hand `walkChild` an Identifier, per kind.
// The type checker refuses a kind or a field left out.
export const identifierRoles: IdentifierRoles = {
	ImplementationSection: { nodes: "value" },
	TestsSection: { nodes: "value" },
	Test: { body: "value" },
	Suite: { nodes: "value" },
	TestTable: { value: "value" },
	TestModifier: { name: "unscoped", arguments: "unscoped" },
	Import: { name: "unscoped", alias: "unscoped" },
	Export: { name: "unscoped", alias: "unscoped" },
	MethodInvocation: {
		base: "value",
		namespaceSpecifier: "value",
		member: "unscoped",
	},
	RecordValue: { name: "unscoped", steps: "unscoped", value: "value" },
	InterpolatedStringValue: { expression: "value" },
	ListValue: { values: "value" },
	DictionaryValue: { key: "value", value: "value" },
	Lookup: { base: "value", member: "unscoped" },
	MemberPath: { steps: "unscoped" },
	Combination: { lhs: "value", rhs: "value" },
	Define: { value: "value", condition: "value" },
	CaseValue: { choice: "type", caseName: "unscoped", value: "value" },
	Start: { expression: "value" },
	Complete: { expression: "value" },
	RefusedValue: { base: "value" },
	CaseMatcher: { choice: "type", caseName: "unscoped", binding: "unscoped" },
	Pattern: { name: "unscoped", binder: "unscoped" },
	SimpleMethod: { name: "unscoped" },
	StaticMethod: { name: "unscoped" },
	OverloadedMethod: { name: "unscoped" },
	OverloadedStaticMethod: { name: "unscoped" },
	SimpleMethodSignature: { name: "unscoped" },
	StaticMethodSignature: { name: "unscoped" },
	OverloadedMethodSignatures: { name: "unscoped" },
	OverloadedStaticMethodSignatures: { name: "unscoped" },
	ConformanceClause: { protocol: "type" },
	WhereCondition: { generic: "type", protocol: "type" },
	SimpleProtocolMethod: { name: "unscoped" },
	StaticProtocolMethod: { name: "unscoped" },
	OverloadedProtocolMethod: { name: "unscoped" },
	OverloadedStaticProtocolMethod: { name: "unscoped" },
	ReturnStatement: { expression: "value" },
	GenericDeclarationNode: { name: "unscoped", constraint: "type" },
	IdentifierTypeDeclaration: { type: "type" },
	RecordTypeDeclaration: { name: "unscoped" },
	FunctionTypeParameter: { externalName: "unscoped" },
	FunctionDefinition: { body: "value" },
	Parameter: {
		externalName: "unscoped",
		internalName: "unscoped",
		defaultValue: "value",
	},
	Argument: { name: "unscoped", value: "value" },
}

type RoleOfField = Partial<Record<string, IdentifierRole>>

// One visit per kind, built once, so a walk allocates none per node.
const childVisits: Partial<
	Record<ReachedKind, (child: ParserNode, walk: Walk, field: string) => void>
> = Object.fromEntries(
	Object.entries(identifierRoles).map(
		([kind, roles]: [string, RoleOfField]) => [
			kind,
			(child: ParserNode, walk: Walk, field: string) =>
				walkChild(child, walk, roles[field]),
		],
	),
)

// A kind with no field that holds an Identifier.
function walkChildNode(child: ParserNode, walk: Walk) {
	walkChild(child, walk, undefined)
}

function walkChildren(node: ReachedNode, walk: Walk) {
	forEachParserChild(node, childVisits[node.nodeType] ?? walkChildNode, walk)
}

const recordMemberRoles: RoleOfField = identifierRoles.RecordValue

// A child of a Record literal's member. A shorthand member's value shares the
// member's Position, so it is referenced with edits that spell the member out.
function walkRecordMember(
	member: parser.RecordValueMemberNode,
	child: ParserNode,
	walk: Walk,
	field: string,
) {
	if (
		field === "value" &&
		child.nodeType === "Identifier" &&
		member.shorthand === true
	) {
		reference(
			walk.scope,
			"values",
			child,
			walk.context,
			"read",
			shorthandValueEdits(member),
		)
	} else {
		walkChild(child, walk, recordMemberRoles[field])
	}
}

// A child reached through `forEachParserChild`. An Identifier there is read
// as the role of the field holding it says.
function walkChild(
	child: ParserNode,
	walk: Walk,
	role: IdentifierRole | undefined,
) {
	if (child.nodeType !== "Identifier") {
		walkNode(child, walk)
	} else if (role === "type") {
		reference(walk.scope, "types", child, walk.context)
	} else if (role === "value") {
		reference(walk.scope, "values", child, walk.context)
	}
}

function childWalk(walk: Walk, range: common.Position): Walk {
	let scope = createScope(walk.scope)

	walk.context.scopes.push({ range, scope })

	return inScope(walk, scope)
}

function scopeWithGenerics(
	generics: Array<parser.GenericDeclarationNode>,
	walk: Walk,
	// The enclosing Namespace's Type Parameters. A Method's `<…>` entry naming
	// one bounds it for that Method, so it is a use, not a declaration.
	enclosing: Set<string> = new Set(),
): Scope {
	let { scope, context } = walk
	let genericScope = createScope(scope)

	for (let generic of generics) {
		// Defaults and bounds resolve in the outer Scope, as in the Enricher's
		// `resolveGenericDeclarations`.
		if (generic.defaultType !== null) {
			walkTypeDeclaration(generic.defaultType, walk)
		}

		if (generic.constraint !== null) {
			reference(scope, "types", generic.constraint, context)
		}

		if (enclosing.has(generic.name.content)) {
			reference(scope, "types", generic.name, context)

			continue
		}

		declareInScope(
			genericScope,
			"types",
			generic.name,
			"generic",
			context,
			generic.name.position.end,
		)
	}

	return genericScope
}

// An explicit label is a symbol of its own, apart from the name.
function declareLabel(
	label: parser.IdentifierNode,
	labels: Map<string, Declaration>,
	context: WalkContext,
) {
	let declaration: Declaration = {
		builtin: false,
		kind: "label",
		definition: label.position,
		visibleFrom: null,
		occurrences: [],
	}

	record(declaration, label.content, label.position, context, "write")
	labels.set(label.content, declaration)
}

function walkFunctionDefinition(
	definition: parser.FunctionDefinitionNode,
	walk: Walk,
	// The wrapping node's Position, which spans the braces. The body's
	// Statements may be empty, or dropped by error recovery mid-edit.
	range: common.Position,
	// A Namespace Method's enclosing Type Parameters; see `scopeWithGenerics`.
	enclosing: Set<string> = new Set(),
) {
	let { context } = walk
	let functionScope = scopeWithGenerics(definition.generics, walk, enclosing)
	let functionWalk = inScope(walk, functionScope)

	context.scopes.push({
		range,
		scope: functionScope,
	})

	let labels = new Map<string, Declaration>()

	context.labels.set(definition, labels)

	for (let parameter of definition.parameters) {
		walkTypeDeclaration(parameter.type, functionWalk)

		// Walked before its Parameter is declared, as the Enricher scopes it: a
		// default sees `@`, the Parameters to its left and the enclosing Scope.
		if (parameter.defaultValue !== null) {
			walkNode(parameter.defaultValue, functionWalk)
		}

		// `_: Type` declares neither a name nor a label, and `on _: Type` only
		// its label.
		if (parameter.internalName === null) {
			if (parameter.externalName !== null) {
				declareLabel(parameter.externalName, labels, context)
			}

			continue
		}

		// A Pattern binds names, none of them the Parameter's, so a label has
		// no symbol to share. An explicit label is still recorded.
		if (parameter.internalName.nodeType === "Pattern") {
			declarePattern(parameter.internalName, functionWalk, "parameter")

			if (parameter.externalName !== null) {
				declareLabel(parameter.externalName, labels, context)
			}

			continue
		}

		if (parameter.externalName === null) {
			// `_`, explicitly without a label.
			declareInScope(
				functionScope,
				"values",
				parameter.internalName,
				"parameter",
				context,
				parameter.internalName.position.end,
			)
		} else if (parameter.externalName === parameter.internalName) {
			// The Parser reuses one Identifier node for a name that is also its
			// label, so the labels rename with the Parameter.
			let declaration = declareInScope(
				functionScope,
				"values",
				parameter.internalName,
				"parameter",
				context,
				parameter.internalName.position.end,
			)

			declaration.labelled = true
			labels.set(parameter.internalName.content, declaration)
		} else {
			declareLabel(parameter.externalName, labels, context)
			declareInScope(
				functionScope,
				"values",
				parameter.internalName,
				"parameter",
				context,
				parameter.internalName.position.end,
			)
		}
	}

	walkTypeDeclaration(definition.returnType, functionWalk)
	walkBody(definition.body, functionWalk, { hoist: false })
}

function walkProtocolDeclaration(
	node: parser.ProtocolDeclarationStatementNode,
	walk: Walk,
) {
	let { scope, context } = walk
	let key = siteKeyOf(
		node.name.content,
		declareInScope(scope, "types", node.name, "protocol", context),
		"types",
		context,
	)

	// Each extended Protocol is a reference, which its rename moves.
	let extended = node.conformsTo.map((clause) =>
		protocolReference(clause.protocol, scope, context),
	)
	let extensions = context.protocolExtensions.get(key)

	if (extensions === undefined) {
		extensions = []
		context.protocolExtensions.set(key, extensions)
	}

	extensions.push(...extended)

	// `Self` is visible inside the signatures, coloured as a Type Parameter
	// and builtin, so never renamed.
	let selfScope = createScope(scope)

	selfScope.types.set("Self", {
		builtin: true,
		kind: "generic",
		definition: null,
		visibleFrom: null,
		occurrences: [],
	})

	let selfWalk = inScope(walk, selfScope)

	// The table a call the Protocol resolved binds to. A call on a conformer
	// binds to its own Method, which joins this one through `conformances`.
	let memberDeclarations = context.protocolMembers.get(key)

	if (memberDeclarations === undefined) {
		memberDeclarations = new Map()
		context.protocolMembers.set(key, memberDeclarations)
	}

	for (let member of Object.values(node.methods)) {
		let declaration = memberDeclarations.get(member.name.content)

		if (declaration === undefined) {
			declaration = {
				builtin: false,
				kind:
					member.nodeType === "StaticProtocolMethod" ||
					member.nodeType === "OverloadedStaticProtocolMethod"
						? "staticMethod"
						: "method",
				definition: member.name.position,
				visibleFrom: null,
				occurrences: [],
			}
			memberDeclarations.set(member.name.content, declaration)
		}

		record(
			declaration,
			member.name.content,
			member.name.position,
			context,
			"write",
		)

		linkConformances(declaration, member.name.content, extended, context)

		let signatures =
			member.nodeType === "OverloadedProtocolMethod" ||
			member.nodeType === "OverloadedStaticProtocolMethod"
				? member.signatures
				: [member.signature]

		for (let signature of signatures) {
			// A provided Method is walked as a Function Definition. A
			// requirement has only its annotations to walk.
			if (signature.body !== null) {
				walkFunctionDefinition(
					signature.body.value,
					selfWalk,
					signature.body.position,
				)

				continue
			}

			for (let parameter of signature.parameters) {
				walkTypeDeclaration(parameter.type, selfWalk)
			}

			walkTypeDeclaration(signature.returnType, selfWalk)
		}
	}
}

function walkNamespaceDefinition(
	node: parser.NamespaceDefinitionStatementNode,
	walk: Walk,
) {
	let { scope, context } = walk
	let key = siteKeyOf(
		node.name.content,
		declareInScope(scope, "values", node.name, "namespace", context),
		"values",
		context,
	)
	let keys = context.namespaceKeys.get(node.name.content) ?? []

	if (!keys.includes(key)) {
		context.namespaceKeys.set(node.name.content, [...keys, key])
	}

	// Built first, so `Item` in `where Item is Comparable` binds to the
	// Namespace's Type Parameter.
	let genericScope = scopeWithGenerics(node.generics, walk)
	let genericWalk = inScope(walk, genericScope)
	// The names a Method's `<…>` may not re-declare; see `scopeWithGenerics`.
	let declared = new Set(node.generics.map((generic) => generic.name.content))

	// A clause's Protocols resolve in the outer Scope, and a condition's
	// Generic through the Namespace's Type Parameters.
	let conformed: Array<string> = []

	for (let clause of node.conformsTo) {
		conformed.push(protocolReference(clause.protocol, scope, context))

		for (let condition of clause.conditions) {
			reference(genericScope, "types", condition.generic, context)
			reference(scope, "types", condition.protocol, context)
		}
	}

	// The typed pass binds uses of these members, which resolve through the
	// Namespace's Type. Same-named Namespaces of one Scope share the map.
	let memberDeclarations = context.namespaceMembers.get(key)

	if (memberDeclarations === undefined) {
		memberDeclarations = new Map()
		context.namespaceMembers.set(key, memberDeclarations)
	}

	for (let member of Object.values(node.properties)) {
		let declaration = memberDeclarations.get(member.name.content)

		if (declaration === undefined) {
			declaration = {
				builtin: false,
				kind: "property",
				definition: member.name.position,
				visibleFrom: null,
				occurrences: [],
			}
			memberDeclarations.set(member.name.content, declaration)
		}

		record(
			declaration,
			member.name.content,
			member.name.position,
			context,
			"write",
		)
	}

	for (let member of Object.values(node.methods)) {
		let declaration = memberDeclarations.get(member.name.content)

		if (declaration === undefined) {
			declaration = {
				builtin: false,
				kind:
					member.nodeType === "StaticMethod" ||
					member.nodeType === "OverloadedStaticMethod"
						? "staticMethod"
						: "method",
				definition: member.name.position,
				visibleFrom: null,
				occurrences: [],
			}
			memberDeclarations.set(member.name.content, declaration)
		}

		record(
			declaration,
			member.name.content,
			member.name.position,
			context,
			"write",
		)

		linkConformances(declaration, member.name.content, conformed, context)
	}

	if (node.targetType !== null) {
		walkTypeDeclaration(node.targetType, genericWalk)
	}

	// Properties resolve in the outer Scope: as in the Enricher, the
	// Namespace's Type Parameters reach only the target Type and the Methods.
	for (let property of Object.values(node.properties)) {
		if (property.type !== null) {
			walkTypeDeclaration(property.type, walk)
		}

		// A native static Property has no value to walk.
		if (property.value !== null) {
			walkNode(property.value, walk)
		}
	}

	for (let member of Object.values(node.methods)) {
		// A native signature writes Type and Parameter names, indexed for
		// Semantic Tokens, highlighting and go-to-definition.
		for (let signature of nativeSignaturesOf(member)) {
			walkNativeSignature(signature, genericWalk, declared)
		}

		for (let method of methodsOf(member)) {
			walkFunctionDefinition(
				method.value,
				genericWalk,
				method.position,
				declared,
			)
		}
	}
}

function walkNativeSignature(
	signature: parser.NativeMethodSignatureNode,
	walk: Walk,
	enclosing: Set<string> = new Set(),
) {
	let { context } = walk
	let signatureWalk = inScope(
		walk,
		scopeWithGenerics(signature.generics, walk, enclosing),
	)

	for (let parameter of signature.parameters) {
		walkTypeDeclaration(parameter.type, signatureWalk)

		if (parameter.defaultValue !== null) {
			walkNode(parameter.defaultValue, signatureWalk)
		}

		// Without a body nothing reads the Parameter, so it is a standalone
		// Declaration. A name that is also its label is one Identifier node.
		let identifiers = new Set(
			[parameter.externalName, parameterInternalName(parameter)].filter(
				(identifier) => identifier !== null,
			),
		)

		for (let identifier of identifiers) {
			record(
				{
					builtin: false,
					kind: "parameter",
					definition: identifier.position,
					visibleFrom: null,
					occurrences: [],
				},
				identifier.content,
				identifier.position,
				context,
				"write",
			)
		}
	}

	walkTypeDeclaration(signature.returnType, signatureWalk)
}

// A refinement's predicate reads names as any Expression does, so the
// Constant a predicate's Argument names keeps that read.
function walkTypeAlias(node: parser.TypeAliasStatementNode, walk: Walk) {
	declareInScope(walk.scope, "types", node.name, "type", walk.context)

	let aliasWalk = inScope(walk, scopeWithGenerics(node.generics, walk))

	walkTypeDeclaration(node.type, aliasWalk)

	if (node.predicate !== null) {
		walkNode(node.predicate, aliasWalk)
	}
}

// Null where a contextually typed Function literal omitted an annotation.
function walkTypeDeclaration(
	node: parser.TypeDeclarationNode | null,
	walk: Walk,
) {
	if (node !== null) {
		walkNode(node, walk)
	}
}

/******************/
/* Record members */
/******************/

function registerRecordSite(
	members: Array<parser.RecordValueMemberNode | parser.RecordTypeMemberNode>,
	context: WalkContext,
	// A literal's braces, which the typed tree finds it by.
	literal: common.Position | null = null,
) {
	if (members.length === 0) {
		return
	}

	let site: RecordMemberSite = {
		names: members.map((member) => member.name.content),
		declares: true,
		members: members.map((member) => ({
			name: member.name.content,
			position: member.name.position,
			edits: shorthandMemberEdits(member),
		})),
	}

	context.recordSites.push(site)

	if (literal !== null) {
		context.literalSites.set(positionKey(literal), site)
	}
}

// The keys of an update the Enricher wrote out of a path key. In
// `{ c with server.port = 1 }`, `port` keys an inner Record the written AST
// lacks, so only `memberPositions` records it. The site's shape is the whole
// Record updated.
function registerPathKeySite(
	node: common.typed.CombinationNode,
	context: WalkContext,
) {
	let { rhs } = node

	if (
		rhs.nodeType !== "RecordValue" ||
		rhs.memberPositions === undefined ||
		node.lhs.type.type !== "Record"
	) {
		return
	}

	let positions = rhs.memberPositions
	let members = Object.keys(positions)

	if (members.length === 0) {
		return
	}

	context.recordSites.push({
		names: Object.keys(node.lhs.type.members),
		declares: false,
		members: members.map((name) => ({
			name,
			position: positions[name],
			edits: barePathKeyEdits(rhs.members[name], positions[name]),
		})),
	})
}

// The path keys of a Literal merged into a default, an Argument or a Case
// payload, as `registerPathKeySite` records an update's. The shape is the
// level's own keys and the Record it writes into, where `widenLiteral` knew it.
function registerMergedKeySite(
	node: common.typed.RecordValueNode,
	context: WalkContext,
) {
	let positions = node.memberPositions

	if (
		positions === undefined ||
		(node.merged !== true &&
			!Object.values(node.members).some(isMergedLevel))
	) {
		return
	}

	let members = Object.keys(positions)

	if (members.length === 0) {
		return
	}

	context.recordSites.push({
		names: [...members, ...(context.writtenShapes.get(node) ?? [])],
		declares: false,
		members: members.map((name) => ({
			name,
			position: positions[name],
			edits: barePathKeyEdits(node.members[name], positions[name]),
		})),
	})
}

// A bare path key's last step is also the value it reads, at one Position.
// Renaming the member keeps the value: `server.port` becomes
// `server.newName = port`.
function barePathKeyEdits(
	value: common.typed.ExpressionNode | undefined,
	position: common.Position,
): Array<RenameEdit> | null {
	if (
		value?.nodeType !== "Identifier" ||
		!isSamePosition(value.position, position)
	) {
		return null
	}

	return [{ position, text: [null, ` = ${value.content}`] }]
}

// Renaming the member at a shorthand Record Literal member keeps the value:
// `{ width }` becomes `{ newName = width }`.
function shorthandMemberEdits(
	member: parser.RecordValueMemberNode | parser.RecordTypeMemberNode,
): Array<RenameEdit> | null {
	if (!("shorthand" in member) || member.shorthand !== true) {
		return null
	}

	// The first step of a bare path key, as in the refused
	// `{ c with server.port, name = 1 }`, is no value. `barePathKeyEdits` keeps
	// the last.
	if ("steps" in member && member.steps !== undefined) {
		return null
	}

	return [
		{
			position: member.name.position,
			text: [null, ` = ${member.name.content}`],
		},
	]
}

// Renaming the value at a shorthand Record Literal member keeps the member:
// `{ width }` becomes `{ width = newName }`. A bare path key's value stands at
// its last step, so `server.port` becomes `server.port = newName`.
function shorthandValueEdits(
	member: parser.RecordValueMemberNode,
): Array<RenameEdit> | null {
	if (member.shorthand !== true) {
		return null
	}

	let key = member.steps?.at(-1) ?? member.name

	return [{ position: key.position, text: [`${key.content} = `, null] }]
}

// A Pattern joins the member groups without declaring. `{ width }` writes the
// member and its local at one Position, which keys a workspace Declaration.
function registerPatternSite(
	pattern: parser.PatternNode,
	context: WalkContext,
) {
	let members = Object.values(pattern.members)

	if (members.length > 0) {
		let site: RecordMemberSite = {
			names: members.map((member) => member.name.content),
			declares: false,
			members: members.map((member) => ({
				name: member.name.content,
				position: member.name.position,
				edits: memberRenameEdits(member),
			})),
		}

		context.recordSites.push(site)

		for (let member of members) {
			context.patternSites.set(positionKey(member.name.position), site)
		}
	}

	for (let member of members) {
		if (member.kind === "Type" && member.binder?.nodeType === "Pattern") {
			registerPatternSite(member.binder, context)
		}
	}
}

// Renaming the member at a shorthand Pattern member keeps the local:
// `{ width }` becomes `{ newName as width }`.
function memberRenameEdits(
	member: parser.PatternMemberNode,
): Array<RenameEdit> | null {
	if (member.kind !== "Type" || member.binder !== null) {
		return null
	}

	// The binder goes after the Type: `Identifier ":" Type "as" Binder`.
	if (member.type !== null) {
		return [
			{ position: member.name.position, text: [null] },
			{
				position: {
					start: member.type.position.end,
					end: member.type.position.end,
				},
				text: [` as ${member.name.content}`],
			},
		]
	}

	return [
		{
			position: member.name.position,
			text: [null, ` as ${member.name.content}`],
		},
	]
}

// Renaming the local at a shorthand Pattern member keeps the member:
// `{ width }` becomes `{ width as newName }`, the binder after any Type.
function binderRenameEdits(
	member: Extract<parser.PatternMemberNode, { kind: "Type" }>,
): Array<RenameEdit> | null {
	if (member.binder !== null) {
		return null
	}

	if (member.type !== null) {
		return [
			{
				position: {
					start: member.type.position.end,
					end: member.type.position.end,
				},
				text: [" as ", null],
			},
		]
	}

	return [
		{
			position: member.name.position,
			text: [`${member.name.content} as `, null],
		},
	]
}

// Every name a Pattern binds and every Type it names. `patternBindings`
// decides the names, for the Enricher too.
function declarePattern(
	pattern: parser.PatternNode,
	walk: Walk,
	kind: DeclarationKind,
	// The end of a declaring Statement. Null for a Matcher's or a Parameter's
	// bindings, visible throughout their Scope.
	visibleFrom: common.Cursor | null = null,
) {
	registerPatternSite(pattern, walk.context)
	// Reaches only the Types the Pattern names, since its names are binders.
	walkNode(pattern, walk)

	for (let binding of patternBindings(pattern)) {
		declareInScope(
			walk.scope,
			"values",
			binding.name,
			kind,
			walk.context,
			visibleFrom,
			editsForBinding(pattern, binding.name),
		)
	}
}

// The edits at a binding's declaring site, which only a shorthand member
// needs. Its binding's Identifier is the member's own `name` node.
function editsForBinding(
	pattern: parser.PatternNode,
	name: parser.IdentifierNode,
): Array<RenameEdit> | null {
	for (let member of Object.values(pattern.members)) {
		if (member.kind !== "Type") {
			continue
		}

		if (member.name === name && member.binder === null) {
			return binderRenameEdits(member)
		}

		if (member.binder?.nodeType === "Pattern") {
			let nested = editsForBinding(member.binder, name)

			if (nested !== null) {
				return nested
			}
		}
	}

	return null
}

// A literal writing part of a Record, as an update, a default or a payload
// does, takes the shape of the Record it writes into. Its own keys alone could
// relate two Types that share them.
function widenLiteral(
	value: common.typed.ExpressionNode | null,
	type: common.Type | common.GenericUse,
	context: WalkContext,
) {
	if (
		value?.nodeType !== "RecordValue" ||
		(type.type !== "Record" && type.type !== "Case")
	) {
		return
	}

	let site = context.literalSites.get(positionKey(value.position))

	// A positional payload's wrapper stands at the Position of the literal it
	// wraps, and its key is the Case's member, which the literal lacks.
	if (
		site !== undefined &&
		Object.keys(value.members).every((name) => site.names.includes(name))
	) {
		widenSite(site, type)
	}

	context.writtenShapes.set(value, Object.keys(type.members))

	for (let [name, member] of Object.entries(value.members)) {
		let memberType = type.members[name]

		if (memberType !== undefined) {
			widenLiteral(member, memberType, context)
		}
	}
}

// A literal Argument merged into a default writes part of its Parameter's
// Record. Pairing goes by label, as the Compiler's does.
function widenArguments(
	node:
		| common.typed.FunctionInvocationNode
		| common.typed.MethodInvocationNode,
	context: WalkContext,
) {
	let call = calledSignature(node)

	if (call === null) {
		return
	}

	let paired = pairedParameters(node.arguments, call.parameters)

	for (let [index, argument] of node.arguments.entries()) {
		let parameter = call.parameters[paired[index] ?? index]

		if (parameter !== undefined) {
			widenLiteral(argument.value, parameter.type, context)
		}
	}
}

function widenSite(
	site: RecordMemberSite,
	type: common.RecordType | common.CaseType,
) {
	site.names = [...new Set([...site.names, ...Object.keys(type.members)])]
}

// Groups member occurrences across the Record shapes related by subset, so
// a rename reaches every site that could observe the member. Identically
// shaped Records are one structural Type and rename together.
function resolveRecordMembers(
	context: WalkContext,
): Array<ShapeGroup<Declaration>> {
	let shapes = [
		...context.recordSites.map((site) => new Set(site.names)),
		...context.recordLookups.map((lookupSite) => new Set(lookupSite.names)),
	]
	let roots = groupRelatedShapes(shapes)
	let groups = new Map<number, ShapeGroup<Declaration>>()

	for (let [shapeIndex, root] of roots.entries()) {
		let group = groups.get(root)

		if (group === undefined) {
			group = { shapes: [], members: new Map() }
			groups.set(root, group)
		}

		group.shapes.push(shapes[shapeIndex])
	}

	function declarationFor(shapeIndex: number, name: string): Declaration {
		let { members } = groups.get(roots[shapeIndex])!
		let declaration = members.get(name)

		if (declaration === undefined) {
			declaration = {
				builtin: false,
				kind: "member",
				definition: null,
				visibleFrom: null,
				occurrences: [],
			}
			members.set(name, declaration)
		}

		return declaration
	}

	// Declaring sites first, so `definition` is one of them rather than a
	// Lookup. A Pattern's site does not declare; see `registerPatternSite`.
	context.recordSites.forEach((site, siteIndex) => {
		for (let member of site.members) {
			let declaration = declarationFor(siteIndex, member.name)

			if (site.declares) {
				declaration.definition ??= member.position
			}

			record(
				declaration,
				member.name,
				member.position,
				context,
				site.declares ? "write" : "read",
				member.edits,
			)
		}
	})

	context.recordLookups.forEach((lookupSite, lookupIndex) => {
		let declaration = declarationFor(
			context.recordSites.length + lookupIndex,
			lookupSite.name,
		)

		record(declaration, lookupSite.name, lookupSite.position, context)
	})

	return [...groups.values()].filter((group) => group.members.size > 0)
}

/****************/
/* Conformances */
/****************/

function linkConformances(
	declaration: Declaration,
	memberName: string,
	protocolNames: Array<string>,
	context: WalkContext,
) {
	for (let protocolName of protocolNames) {
		context.conformances.push({ declaration, protocolName, memberName })
	}
}

// A Protocol named in an `is` list, resolved where the list is written
// and keyed by `siteKeyOf`.
function protocolReference(
	identifier: parser.IdentifierNode,
	scope: Scope,
	context: WalkContext,
): string {
	return siteKeyOf(
		identifier.content,
		reference(scope, "types", identifier, context),
		"types",
		context,
	)
}

// A top level Protocol or Namespace is keyed by its name, as other files
// name it. One declared in a body adds its Position, since names may repeat.
function siteKeyOf(
	name: string,
	declaration: Declaration | null,
	space: SymbolSpace,
	context: WalkContext,
): string {
	let definition = declaration?.definition ?? null
	let topLevel = context.scopes.find((entry) => entry.range === null)

	if (
		definition === null ||
		topLevel?.scope[space].get(name) === declaration
	) {
		return name
	}

	return nestedKey(name, definition)
}

function nestedKey(name: string, definition: common.Position): string {
	return `${name}@${definition.start.line}:${definition.start.column}`
}

// Undefined where the Protocol, or the one it extends that holds the
// member, is not declared in this file. The workspace index follows the chain
// there.
function protocolMember(
	context: WalkContext,
	protocolName: string,
	memberName: string,
	visited: Set<string> = new Set(),
): Declaration | undefined {
	if (visited.has(protocolName)) {
		return undefined
	}

	visited.add(protocolName)

	let member = context.protocolMembers.get(protocolName)?.get(memberName)

	if (member !== undefined) {
		return member
	}

	for (let extended of context.protocolExtensions.get(protocolName) ?? []) {
		let found = protocolMember(context, extended, memberName, visited)

		if (found !== undefined) {
			return found
		}
	}

	return undefined
}

// Whether the member is one a standard library Protocol declares, reached
// through the Protocols this file declares.
function holdsBuiltinMember(
	context: WalkContext,
	protocolName: string,
	memberName: string,
	visited: Set<string> = new Set(),
): boolean {
	if (visited.has(protocolName)) {
		return false
	}

	visited.add(protocolName)

	let binding = context.scopes
		.find((entry) => entry.range === null)
		?.scope.types.get(protocolName)

	if (binding?.builtin === true) {
		return isBuiltinProtocolMember(protocolName, memberName)
	}

	return (context.protocolExtensions.get(protocolName) ?? []).some(
		(extended) =>
			holdsBuiltinMember(context, extended, memberName, visited),
	)
}

// The linked Declarations share one list of sites, so a rename, a
// reference search or a linked edit started at any of them reaches all. They
// share `answersBuiltin` too. Each keeps its own definition, which is where a
// call bound to it still leads.
function shareConformanceSites(context: WalkContext) {
	let parents = new Map<Declaration, Declaration>()

	let findRoot = (declaration: Declaration): Declaration => {
		let parent = parents.get(declaration)

		if (parent === undefined || parent === declaration) {
			return declaration
		}

		let root = findRoot(parent)

		parents.set(declaration, root)

		return root
	}

	for (let link of context.conformances) {
		let member = protocolMember(context, link.protocolName, link.memberName)

		if (member === undefined) {
			if (
				holdsBuiltinMember(context, link.protocolName, link.memberName)
			) {
				link.declaration.answersBuiltin = true
			}

			continue
		}

		let left = findRoot(link.declaration)
		let right = findRoot(member)

		if (left !== right) {
			parents.set(left, right)
		}
	}

	let groups = new Map<Declaration, Array<Declaration>>()

	for (let declaration of parents.keys()) {
		let root = findRoot(declaration)
		let group = groups.get(root) ?? [root]

		group.push(declaration)
		groups.set(root, group)
	}

	for (let group of groups.values()) {
		let sites = [...new Set(group.flatMap((member) => member.occurrences))]

		sites.sort(
			(a, b) =>
				a.position.start.line - b.position.start.line ||
				a.position.start.column - b.position.start.column,
		)

		let answersBuiltin = group.some(
			(member) => member.answersBuiltin === true,
		)

		for (let member of group) {
			member.occurrences = sites

			if (answersBuiltin) {
				member.answersBuiltin = true
			}
		}
	}
}

/**************/
/* Typed pass */
/**************/

function bindNamespaceMember(
	namespaceName: string,
	namespaceType: common.Type,
	memberName: string,
	position: common.Position,
	context: WalkContext,
	// Set where a Protocol answers the call, to its identity: the writer
	// of a provided body, or a bounded receiver's bound. The Invocation names a
	// Namespace without the member, such as `Value__conformance`.
	protocolIdentity: string | undefined = undefined,
) {
	if (protocolIdentity !== undefined) {
		context.protocolMemberReferences.push({
			identity: protocolIdentity,
			memberName,
			position,
		})

		return
	}

	let keys = context.namespaceKeys.get(namespaceName) ?? [namespaceName]
	let key =
		keys.length === 1
			? keys[0]!
			: context.namespaceTypeKeys.get(namespaceType)

	if (key === undefined) {
		context.namespaceMemberReferences.push({
			namespaceName,
			namespaceType,
			memberName,
			position,
		})

		return
	}

	bindKeyedMember(key, namespaceName, memberName, position, context)
}

// The calls whose Namespace the typed pass reached after them. One whose
// Type no declaration here holds is taken to name the top level Namespace of
// its name.
function bindNamespaceMembers(context: WalkContext) {
	for (let {
		namespaceName,
		namespaceType,
		memberName,
		position,
	} of context.namespaceMemberReferences) {
		bindKeyedMember(
			context.namespaceTypeKeys.get(namespaceType) ?? namespaceName,
			namespaceName,
			memberName,
			position,
			context,
		)
	}
}

function bindKeyedMember(
	key: string,
	namespaceName: string,
	memberName: string,
	position: common.Position,
	context: WalkContext,
) {
	// Builtin Namespaces have no source declaration, so their members stay
	// unbound and are not renameable.
	let declaration = context.namespaceMembers.get(key)?.get(memberName)

	if (declaration !== undefined) {
		record(declaration, memberName, position, context)

		return
	}

	// Possibly an imported Namespace's member, which the workspace join binds
	// in the Module that declares it.
	context.externalMembers.push({ namespaceName, memberName, position })
}

// A reference to a member of a Protocol this file declares is bound
// here. Any other Protocol's, a builtin's included, goes to the workspace
// index by identity, which leaves a builtin's unbound.
function bindProtocolMembers(context: WalkContext) {
	for (let {
		identity,
		memberName,
		position,
	} of context.protocolMemberReferences) {
		let ownProtocol = context.ownProtocols.get(identity)
		let declaration =
			ownProtocol === undefined
				? undefined
				: protocolMember(context, ownProtocol, memberName)

		if (declaration !== undefined) {
			record(declaration, memberName, position, context)
		} else {
			context.externalMembers.push({
				namespaceName: identity,
				memberName,
				position,
				protocol: true,
			})
		}
	}
}

// The key `siteKeyOf` gives a Protocol, read off the part of its identity
// after the Module path.
export function protocolIdentityKey(identity: string): string {
	return identity.slice(identity.lastIndexOf("#") + 1)
}

function boundProtocol(type: common.Type | null): string | undefined {
	return type?.type === "GenericUse" ? type.constraint : undefined
}

// The typed pass. A kind that binds a member does so before its children
// are walked, and a Lookup after its base, which is written first.
function walkTypedNode(node: TypedNode, context: WalkContext) {
	switch (node.nodeType) {
		case "NamespaceDefinitionStatement": {
			let keys = context.namespaceKeys.get(node.name.content) ?? []
			let nested = nestedKey(node.name.content, node.name.position)

			context.namespaceTypeKeys.set(
				node.type,
				keys.includes(nested) ? nested : node.name.content,
			)
			break
		}
		case "ProtocolDeclarationStatement":
			context.ownProtocols.set(
				node.protocolType.identity,
				protocolIdentityKey(node.protocolType.identity),
			)
			break
		case "FunctionInvocation":
			widenArguments(node, context)
			break
		case "MethodInvocation":
			widenArguments(node, context)
			bindNamespaceMember(
				node.namespace.name,
				node.namespace.type,
				node.member.name,
				node.member.position,
				context,
				// As in the Hover, a bounded receiver resolves per member
				// through the witness. A requirement belongs to the bound or a
				// Protocol it extends.
				node.namespace.type.providedBy ??
					node.namespace.type.providedMembers?.[node.member.name] ??
					boundProtocol(node.namespace.type.targetType),
			)
			break
		case "Lookup":
			forEachTypedChild(node, walkTypedNode, context)
			bindLookupMember(node, context)
			return
		case "Combination":
			registerPathKeySite(node, context)
			widenLiteral(node.rhs, node.lhs.type, context)
			break
		case "Parameter":
			widenLiteral(node.defaultValue, node.type, context)
			break
		case "CaseValue":
			widenLiteral(node.value, node.type, context)
			break
		case "ChoiceDeclarationStatement":
			for (let { defaultValue, type } of node.cases) {
				widenLiteral(defaultValue, type, context)
			}
			break
		case "RecordValue":
			registerMergedKeySite(node, context)
			break
	}

	forEachTypedChild(node, walkTypedNode, context)
}

function bindLookupMember(node: common.typed.LookupNode, context: WalkContext) {
	let baseType = node.base.type

	if (baseType.type === "Namespace") {
		bindNamespaceMember(
			baseType.name,
			baseType,
			node.member.content,
			node.member.position,
			context,
			// As for a MethodInvocation: `Number.isLessThan` names the
			// conforming Namespace, but the declaration is the Protocol's.
			node.providedBy,
		)
	} else if (baseType.type === "GenericUse") {
		// `Value.empty()` on a bounded Type Parameter reads a static member of
		// its bound.
		let bound = boundProtocol(baseType)

		if (bound !== undefined) {
			bindNamespaceMember(
				bound,
				baseType,
				node.member.content,
				node.member.position,
				context,
				node.providedBy ?? bound,
			)
		}
	} else if (baseType.type === "Record" || baseType.type === "Case") {
		// A Pattern's member is read through the Lookup its desugar writes.
		let pattern = context.patternSites.get(
			positionKey(node.member.position),
		)

		if (pattern !== undefined) {
			widenSite(pattern, baseType)
		}

		// A Case's payload members read like a Record's.
		context.recordLookups.push({
			names: Object.keys(baseType.members),
			name: node.member.content,
			position: node.member.position,
		})
	}
}
