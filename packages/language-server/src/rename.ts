import { isStdlibDocument } from "@essence-lang/compiler/documents"
import {
	builtinMembers,
	builtinProtocols as builtinProtocolTable,
	builtinTypes as builtinTypeTable,
} from "@essence-lang/compiler/enricher/builtins"
import {
	parameterInternalName,
	patternBindings,
} from "@essence-lang/compiler/helpers"
import type { common, parser } from "@essence-lang/interfaces"

import { typedHandlerExpressions } from "./matchHandlerChildren"

// NOTE: Renaming is resolved on the Parser AST with a lexical Scope model
// that mirrors the Enricher's binding rules — `values` corresponds to the
// Enricher's `members`, `types` to its `types`.
//
// Names that resolve through Types instead of Scopes are covered by two
// additional mechanisms:
//
// - Argument labels: for invocations whose callee is a plain Identifier,
//   the callee's Function Definitions are known lexically, so labels are
//   linked to the Parameters declaring them and rename together with them.
// - Method, property and Record member names: the enriched AST knows which
//   Namespace resolved each Method Invocation and the Record Type of every
//   Lookup base, so those references are bound in a second pass over the
//   typed Program. Record Types are structural — member occurrences are
//   grouped across all Record shapes in the file that share the member and
//   are subset-related (one shape could flow into the other).

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
	// NOTE: What an `import { … }` entry binds. One entry carries its name
	// across every table it is bound in, so the kind the OTHER Module declared
	// it as is not something one file can answer — the workspace index joins the
	// entry to that Module's own Declaration, and everything reading a single
	// file's index sees the entry for what it is here: a name from elsewhere.
	| "import"

// NOTE: The text ONE edit of a rename writes, in parts: a String stands as it
// is written, and `null` is where the new name goes. Renaming an ordinary
// occurrence writes `[null]` over the Identifier it was found at, which is why
// nothing but a Pattern's shorthand binder carries any of this.
export type RenameText = Array<string | null>

export type RenameEdit = {
	// NOTE: The span the edit replaces. An EMPTY span INSERTS, which is what
	// expanding a shorthand binder does — the name it writes was not there to
	// begin with.
	position: common.Position
	text: RenameText
}

// NOTE: Where one occurrence is written, and what renaming THROUGH it writes.
//
// `edits` is what a bare Pattern binder needs and nothing else does: `{ width }`
// names two things with one Identifier — the Record's member and the local it
// binds — so renaming either end has to spell the other one out beside it.
// Renaming the local gives `{ width as w }`, renaming the member `{ w as width }`,
// and an annotated member takes its binder after the Type (`{ width: Integer as
// w }`), which is why an edit carries a Position of its own instead of reusing
// this one. Null — every other site in the index — means the new name over
// `position`.
//
// `position` is deliberately NOT widened to cover the expansion: it is the
// cursor hit test, the Document Highlight span and the Semantic Token span as
// well, and all three mean the Identifier itself.
export type RenameSite = {
	position: common.Position
	edits: Array<RenameEdit> | null
}

// NOTE: What a rename writes for one site, with the new name filled in.
// Everything that applies a rename asks here — the Server, the workspace join
// and the tests — so that an expansion can not be forgotten at one of them.
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
	definition: common.Position | null
	// NOTE: Where the name starts being resolvable. `null` means "anywhere in
	// its Scope" — builtins, and the declaration kinds the Enricher hoists
	// (Functions, Namespaces, Type Aliases), which may be used before their
	// declaration site. Constants and Variables are deliberately not hoisted,
	// so they only become visible after their declaring Statement.
	visibleFrom: common.Cursor | null
	occurrences: Array<RenameSite>
}

export type Scope = {
	parent: Scope | null
	values: Map<string, Declaration>
	types: Map<string, Declaration>
}

export type ScopeRange = {
	// NOTE: `null` covers the whole document — only the top level Scope.
	range: common.Position | null
	scope: Scope
}

// NOTE: `write` marks the occurrences that bind a value to the name — its
// declaration and any assignment to it. Everything else reads it. Only
// Document Highlight distinguishes the two; renaming touches both alike.
export type OccurrenceAccess = "read" | "write"

export type Occurrence = {
	name: string
	position: common.Position
	access: OccurrenceAccess
	// NOTE: The same field `RenameSite` carries, for the same reason — an
	// Occurrence is one site with its Declaration attached.
	edits: Array<RenameEdit> | null
	declaration: Declaration
}

export type RenameIndex = Array<Occurrence>

type RecordMemberSite = {
	names: Array<string>
	// NOTE: Whether the members are WRITTEN here. A Record literal and a Record
	// Type declaration write them, so one of those is where the member is
	// defined; a Pattern only NAMES members that are declared by the Type of
	// whatever it takes apart, so it must not claim to define them — the local
	// it binds is written at that very Position, and two Declarations sharing a
	// definition Position are one symbol to the workspace join.
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
	// NOTE: The Function Definitions each value Declaration is known to
	// hold — fed by Function Statements and by Function Values bound through
	// declarations and assignments.
	functionDefinitions: Map<Declaration, Array<parser.FunctionDefinitionNode>>
	// NOTE: Call site label → Declaration, per Function Definition. For a
	// Parameter without an explicit external name the label Declaration is
	// the Parameter's own — renaming one renames both.
	labels: Map<parser.FunctionDefinitionNode, Map<string, Declaration>>
	// NOTE: Labelled arguments are collected during the walk and resolved
	// afterwards, so that invocations of hoisted (or later-assigned)
	// Functions see their labels regardless of statement order.
	pendingLabelReferences: Array<{
		identifier: parser.IdentifierNode
		callee: Declaration
	}>
	// NOTE: Property and Method Declarations per Namespace name — the typed
	// AST identifies resolved Namespaces by name.
	namespaceMembers: Map<string, Map<string, Declaration>>
	// NOTE: Every Method and Property reference whose Namespace this file does
	// not declare, by the name the reference resolved through. A Namespace an
	// `import { … }` entry brought in has its Methods declared in another file
	// entirely, so nothing here can bind them — the workspace index joins them
	// through that entry, and a single file's index simply carries the
	// references it could not answer for.
	externalMembers: Array<ExternalMemberReference>
	// NOTE: Record member declaration sites (literals and Record Type
	// declarations) and member Lookups, grouped structurally after the walk.
	recordSites: Array<RecordMemberSite>
	recordLookups: Array<RecordMemberLookup>
	// NOTE: Every Scope with the Position it spans — lets completion find
	// the names visible at a cursor.
	scopes: Array<ScopeRange>
}

export type ExternalMemberReference = {
	// NOTE: The name the Namespace is reachable under HERE — an aliased import
	// binds a copy of the Namespace Type carrying its local name, which is what
	// the resolved Invocation names.
	namespaceName: string
	memberName: string
	position: common.Position
}

// NOTE: These ARE the top level Scope the Enricher starts from — derived
// from its builtin tables, never listed by hand. Builtins participate in
// resolution — so that shadowing works — but are rejected as rename targets.
// NOTE: Read on use rather than at import. Half of what the tables answer with
// is enriched from Essence source, once per process and cached — building the
// index is where that belongs, not module evaluation order.
const builtinValues = () => Object.entries(builtinMembers())

const builtinTypes = () => Object.keys(builtinTypeTable())

const builtinProtocols = () => Object.keys(builtinProtocolTable())

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
	"namespace",
	"protocol",
	"for",
	"infer",
	"choice",
	"true",
	"false",
	// NOTE: Structurally significant inside a Pattern, where it separates a
	// member from the name it binds under — renaming a binder to `as` writes
	// `{ width as as }`, or `{ as }` where the shorthand is expanded, and
	// neither says what it reads as. It only ever restricts rename TARGETS, so
	// the `import`/`export` grammar, which spells its own `as`, is untouched:
	// a member may still BE called `as` and be bound under that name.
	"as",
])

// NOTE: Anything the Lexer would not produce as a single Identifier Token —
// whitespace, Symbols, String- and Comment-Literals, a leading digit — is
// rejected, as are reserved words.
const forbiddenIdentifierCharacters = /[\s"§(){}[\]<>|/@,.:=\-~_#]/

// NOTE: The same character class in its positive form: one whole Identifier.
// Linked editing hands it to the editor so that typing a character a name
// cannot contain ends the linked edit rather than propagating something
// unparseable. Kept as a string because the editor wants a pattern, not a
// RegExp.
//
// Number literals are deliberately not covered: `_` separates digit groups
// and a leading `-` belongs to the literal, so they need a second alternative
// — the extension's language configuration spells that out for word
// selection, but renaming only ever targets Identifiers.
export const identifierPattern = '[^\\s"§(){}\\[\\]<>|/@,.:=~_#-]+'

export function isValidIdentifierName(name: string): boolean {
	return (
		name.length > 0 &&
		!forbiddenIdentifierCharacters.test(name) &&
		!/^[0-9]/.test(name) &&
		!reservedWords.has(name)
	)
}

// NOTE: The Keywords the grammar's Identifier rule reads as ordinary
// Identifiers — the Parser's `identifierTokenTypes`. The standard library
// already writes labels with them (`slice(from 1, to 3)`, `normalize(as
// #ComposedCanonical)`), so a LABEL may be renamed to any of these even though
// an ordinary binding must not be: a binding named `with` would collide with
// the `{ … with … }` Combination the moment it is read in one.
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

export function isValidLabelName(name: string): boolean {
	return isValidIdentifierName(name) || keywordIdentifiers.has(name)
}

// NOTE: REFUSED outright inside a standard library source — and with it
// Prepare Rename and Linked Editing, which both resolve through here. Not out
// of caution; a rename there is silently destructive:
//
//   • the edit reaches this document only. Every call site of a standard
//     library Method is in a file a single-document rename never sees, and the
//     Language Server has no project-wide index to find them with.
//   • the name IS the runtime binding. A body-less signature is bound to the
//     export of the same name in `@essence-lang/runtime`, so renaming
//     `exclusiveOr` to `xor` type-checks, emits ZERO Diagnostics and produces
//     a call to `undefined` at run time.
//   • renaming a Method a `is …` clause depends on breaks the conformance, and
//     the standard library loader then throws for EVERY Program compiled
//     afterwards — the Editor would have bricked the compiler.
//
// The Namespace's own NAME was already protected, since it resolves to a
// builtin; its Methods, Parameters and local Type names were not.
//
// NOTE: What stands between a mis-bound native and a broken build is the
// runtime-export cross-check in `src/tests/builtins.spec.ts` — it drives
// `nativeBindings` against the real `@essence-lang/runtime` modules in both directions,
// and it is what fails on the rename above. It is the LAST line of defence now
// that the standard library is only Essence source, and it can only speak for
// Namespaces its `runtimeModules` table names.
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

	if (occurrence === null || occurrence.declaration.builtin) {
		return null
	}

	return occurrence
}

// NOTE: Unlike renaming, finding references and highlighting are read-only —
// they work on builtins too, so this does not reject them.
export function findOccurrence(
	program: parser.Program,
	cursor: common.Cursor,
	enrichedProgram: common.typed.Program | null = null,
): Occurrence | null {
	return occurrenceAt(buildRenameIndex(program, enrichedProgram), cursor)
}

// NOTE: Every index entry resolving to the same Declaration as the one under
// the cursor. Document Highlight needs the entries rather than the
// Declaration's flat Position list, because only they carry the access.
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
	// NOTE: Handed out so the workspace index can reach the Method and Property
	// Declarations of a Namespace an importer only ever names through an entry.
	// Keyed by the Namespace's own name, which is unique within one file — two
	// Namespaces sharing a name is a duplicate the Enricher rejects, and an
	// import may not shadow a declaration either.
	namespaceMembers: Map<string, Map<string, Declaration>>
	externalMembers: Array<ExternalMemberReference>
}

export function indexProgram(
	program: parser.Program,
	enrichedProgram: common.typed.Program | null = null,
): ProgramIndex {
	let context: WalkContext = {
		index: [],
		functionDefinitions: new Map(),
		labels: new Map(),
		pendingLabelReferences: [],
		namespaceMembers: new Map(),
		externalMembers: [],
		recordSites: [],
		recordLookups: [],
		scopes: [],
	}

	let topLevelScope = createScope(null)

	context.scopes.push({ range: null, scope: topLevelScope })

	// NOTE: The KIND is read off the member's own Type rather than off its name.
	// It used to be read off a hard-coded list of the one builtin that was not a
	// Namespace, which left `loop` mis-kinded as a Namespace on the strength of
	// not being on it.
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

	// NOTE: Protocols share the `types` symbol space here — they are only
	// nameable in Type-like positions (bounds, conformance clauses), and the
	// Enricher keeps them apart where it matters.
	for (let name of builtinProtocols()) {
		topLevelScope.types.set(name, {
			builtin: true,
			kind: "protocol",
			definition: null,
			visibleFrom: null,
			occurrences: [],
		})
	}

	// NOTE: The two Module sections frame the body here as they do in the source:
	// an entry is in Scope before the first Statement, and an export entry reads
	// a Scope the whole implementation has been walked into.
	declareImports(program, topLevelScope, context)

	walkBody(program.implementation.nodes, topLevelScope, context, {
		hoist: true,
	})

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
					context.index,
				)
				break
			}
		}
	}

	if (enrichedProgram !== null) {
		walkTypedBody(enrichedProgram.implementation.nodes, context)
	}

	resolveRecordMembers(context)

	return {
		index: context.index,
		scopes: context.scopes,
		namespaceMembers: context.namespaceMembers,
		externalMembers: context.externalMembers,
	}
}

// NOTE: An entry binds its local name across BOTH symbol spaces through one
// Declaration — a `type Foo` and a Namespace `Foo` travel together under one
// entry, so a use of either has to reach the same Declaration and rename with
// it. Hoisted, because an entry is in scope everywhere in the file it is
// written in, whatever the kind at the other end turns out to be.
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

		// NOTE: An entry whose name this Module also declares is REFUSED by the
		// Compiler, and the declaration keeps the name — so it must not reach
		// the Scope, or a use of the name would rename with the entry instead of
		// with what it actually resolves to. The Identifier is still indexed:
		// the entry is a mistake, and a mistake is a thing a reader edits.
		if (!declared.has(local.content)) {
			scope.values.set(local.content, declaration)
			scope.types.set(local.content, declaration)
		}

		record(
			declaration,
			local.content,
			local.position,
			context.index,
			"write",
		)
	}
}

// NOTE: What the implementation declares at its top level, off the Parser AST —
// asked before anything is walked, which is the only moment an import entry can
// be told from a declaration of the same name.
function topLevelNames(program: parser.Program): Set<string> {
	let names = new Set<string>()

	for (let node of program.implementation.nodes) {
		switch (node.nodeType) {
			// NOTE: A Pattern declares as many names as it binds, and every one
			// of them is a name an import could collide with.
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

// NOTE: Only the side of an entry that names something THIS file holds. The
// public name an entry publishes under — the `alias` of `area as measure`, and
// a re-export's name, which is the dependency's — is a workspace-wide symbol
// rather than a local one, so it is joined by the workspace index and left
// unbound here. An unaliased entry's single Identifier is both at once, and it
// is recorded here as the local occurrence it also is.
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
	// NOTE: Identifiers never span lines, and `end.column` is exclusive —
	// it is still included here so that renaming works with the cursor
	// directly behind the Identifier.
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

function record(
	declaration: Declaration,
	name: string,
	position: common.Position,
	index: RenameIndex,
	access: OccurrenceAccess = "read",
	// NOTE: See `RenameSite.edits` — null is "write the new name here", which
	// is what every site but a Pattern's shorthand binder means.
	edits: Array<RenameEdit> | null = null,
) {
	// NOTE: One Position is one occurrence OF ONE DECLARATION. A Pattern's
	// shorthand binder is reached twice for the member it names — once from the
	// Pattern itself, and once through the Lookup the Enricher desugared it
	// into, whose member Identifier carries that very span — and two entries
	// would write their edits twice, the second over text the first had already
	// rewritten. The entry that knows how to rewrite itself wins.
	//
	// Two DECLARATIONS at one Position stay two, which is the whole point of
	// the shorthand: the member and the local it binds are different symbols
	// written with one Identifier.
	let existing = declaration.occurrences.find(
		(site) =>
			site.position.start.line === position.start.line &&
			site.position.start.column === position.start.column &&
			site.position.end.line === position.end.line &&
			site.position.end.column === position.end.column,
	)

	if (existing !== undefined) {
		existing.edits ??= edits

		return
	}

	declaration.occurrences.push({ position, edits })

	index.push({
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
	// NOTE: `null` for the kinds that hoist — see `Declaration.visibleFrom`.
	// Only set when the Declaration is created: a re-declaration is an error
	// the Enricher reports, and the first one is what use sites bound to.
	visibleFrom: common.Cursor | null = null,
	// NOTE: How the declaring occurrence is REWRITTEN — see `RenameSite.edits`.
	// A Pattern's shorthand binder is the one declaration whose name can not
	// simply be overwritten.
	edits: Array<RenameEdit> | null = null,
): Declaration {
	// NOTE: Re-declarations share the first Declaration — the Enricher
	// reports the duplicate; grouping the occurrences is harmless here.
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
		context.index,
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
): Declaration | null {
	let declaration = lookup(scope, space, identifier.content)

	// NOTE: Undeclared names are not recorded — the Enricher reports them.
	if (declaration !== null) {
		record(
			declaration,
			identifier.content,
			identifier.position,
			context.index,
			access,
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

// NOTE: Mirrors the Enricher's `hoistDeclarations`, minus the speculative
// resolution — for renaming, binding a use site to an un-hoistable
// declaration is what the user means anyway.
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

// NOTE: Approximates the Position a Body of Statements spans, for scoping
// completion — Bodies carry no Position of their own, only their contained
// nodes do.
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

function walkBody(
	nodes: Array<parser.ImplementationNode>,
	scope: Scope,
	context: WalkContext,
	{ hoist }: { hoist: boolean },
) {
	// NOTE: Only the top level hoists — nested bodies bind in order, exactly
	// like the Enricher.
	if (hoist) {
		hoistDeclarations(nodes, scope)
	}

	for (let node of nodes) {
		walkNode(node, scope, context)
	}
}

function walkNode(
	node: parser.ImplementationNode,
	scope: Scope,
	context: WalkContext,
) {
	switch (node.nodeType) {
		case "ConstantDeclarationStatement":
		case "VariableDeclarationStatement": {
			if (node.type !== null) {
				walkTypeDeclaration(node.type, scope, context)
			}

			walkNode(node.value, scope, context)

			let kind =
				node.nodeType === "ConstantDeclarationStatement"
					? ("constant" as const)
					: ("variable" as const)

			// NOTE: A Pattern declares every name it binds, and none of them is
			// the Declaration's — so there is no one Declaration for a Function
			// value to be linked to either.
			if (node.name.nodeType === "Pattern") {
				declarePattern(
					node.name,
					scope,
					context,
					kind,
					// NOTE: Visible only after the whole Statement — the value
					// is resolved in the Scope as it was before the
					// declaration, so no name it binds can refer to itself.
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
				// NOTE: Visible only after the whole Statement — the value is
				// resolved in the Scope as it was before the declaration, so
				// the name cannot refer to itself.
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

			walkNode(node.value, scope, context)

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
			walkFunctionDefinition(node.value, scope, context, node.position)
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

			// NOTE: An `overload function` block mixes bodied Function literals
			// with body-less native signatures, exactly as an `overload` Method
			// block in declarations mode does — only the bodied entries hold a
			// definition to link and walk.
			for (let method of node.methods) {
				if (method.nodeType === "FunctionValue") {
					linkFunctionDefinition(declaration, method.value, context)
					walkFunctionDefinition(
						method.value,
						scope,
						context,
						method.position,
					)
				} else {
					walkNativeSignature(method, scope, context)
				}
			}

			return
		}
		case "NamespaceDefinitionStatement":
			walkNamespaceDefinition(node, scope, context)
			return
		case "ProtocolDeclarationStatement":
			walkProtocolDeclaration(node, scope, context)
			return
		case "ChoiceDeclarationStatement": {
			declareInScope(scope, "types", node.name, "type", context)

			// NOTE: A generic Choice's Type Parameters bind across every Case's
			// payload the way a Type Alias's do — `State` in `#Continue { state:
			// State }` resolves to the header's declaration, so renaming either
			// end moves both, and `scopeWithGenerics` records the header
			// occurrences (and any bound or default) for Semantic Tokens too.
			let choiceScope = scopeWithGenerics(node.generics, scope, context)

			// NOTE: Case names resolve through their Choice, never through a
			// Scope — only the member Types inside the payload declarations
			// hold renameable references.
			for (let choiceCase of node.cases) {
				if (choiceCase.type !== null) {
					walkTypeDeclaration(choiceCase.type, choiceScope, context)
				}
			}

			return
		}
		case "TypeAliasStatement": {
			declareInScope(scope, "types", node.name, "type", context)

			let aliasScope = scopeWithGenerics(node.generics, scope, context)

			walkTypeDeclaration(node.type, aliasScope, context)
			return
		}
		case "IfStatement": {
			walkNode(node.condition, scope, context)

			let bodyScope = childScope(
				scope,
				rangeOfBody(node.body, node.position),
				context,
			)

			walkBody(node.body, bodyScope, context, { hoist: false })
			return
		}
		case "IfElseStatement": {
			walkNode(node.condition, scope, context)

			let trueScope = childScope(
				scope,
				rangeOfBody(node.trueBody, node.position),
				context,
			)
			let falseScope = childScope(
				scope,
				rangeOfBody(node.falseBody, node.position),
				context,
			)

			walkBody(node.trueBody, trueScope, context, { hoist: false })
			walkBody(node.falseBody, falseScope, context, { hoist: false })
			return
		}
		case "ReturnStatement":
			walkNode(node.expression, scope, context)
			return
		case "Identifier":
			reference(scope, "values", node, context)
			return
		case "MethodInvocation":
			walkNode(node.base, scope, context)

			if (node.namespaceSpecifier !== null) {
				reference(scope, "values", node.namespaceSpecifier, context)
			}

			walkArguments(node.arguments, scope, context)
			return
		case "FunctionInvocation": {
			let callee: Declaration | null = null

			if (node.name.nodeType === "Identifier") {
				callee = reference(scope, "values", node.name, context)
			} else {
				walkNode(node.name, scope, context)
			}

			for (let argument of node.arguments) {
				if (argument.name !== null && callee !== null) {
					context.pendingLabelReferences.push({
						identifier: argument.name,
						callee,
					})
				}

				walkNode(argument.value, scope, context)
			}

			return
		}
		case "Lookup":
			// NOTE: The member resolves through the base's Type — skipped.
			walkNode(node.base, scope, context)
			return
		case "CaseValue":
			// NOTE: The Case's name resolves through the Choice — only the
			// (optional) Choice prefix is a Type reference of its own, along with
			// the Type Arguments a value-position application writes.
			if (node.choice !== null) {
				reference(scope, "types", node.choice, context)
			}

			for (let argument of node.typeArguments ?? []) {
				walkTypeDeclaration(argument, scope, context)
			}

			if (node.value !== null) {
				walkNode(node.value, scope, context)
			}

			return
		case "Combination":
			walkNode(node.lhs, scope, context)
			walkNode(node.rhs, scope, context)
			return
		case "Match":
			walkNode(node.value, scope, context)
			walkTypeDeclaration(node.returnType, scope, context)

			for (let handler of node.handlers) {
				// NOTE: Neither a wildcard nor a literal Matcher names a Type,
				// so neither holds a reference that a rename could have to
				// touch. A Pattern is walked below instead, inside the Scope it
				// binds into — its members are names as well as Types.
				if (handler.matcher.nodeType === "Pattern") {
					// NOTE: Nothing here: the Pattern's Types and its bindings
					// both belong to the Handler's own Scope, which does not
					// exist yet.
				} else if (handler.matcher.nodeType === "CaseMatcher") {
					// NOTE: The Case's name resolves through the matched
					// value's Type — only a prefixed Choice name is an
					// ordinary Type reference.
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
					walkTypeDeclaration(handler.matcher, scope, context)
				}

				// NOTE: The Handler's Scope spans its Matcher onwards rather
				// than only its body, because a payload binding is written in
				// the Matcher and read in the Guard as well as in the body. ONE
				// Scope holds it for all three: two Declarations of the same
				// name at the same Position would be two Declarations, and a
				// rename would only reach the half it was started from.
				let handlerScope = childScope(
					scope,
					{
						start: handler.matcher.position.start,
						end: rangeOfBody(handler.body, node.position).end,
					},
					context,
				)

				// NOTE: Declared BEFORE the Guard and the body are walked, so
				// a use in either binds to it — which is the whole reason the
				// Handler's Scope starts at its Matcher.
				if (handler.matcher.nodeType === "Pattern") {
					declarePattern(
						handler.matcher,
						handlerScope,
						context,
						"constant",
					)
				} else if (
					handler.matcher.nodeType === "CaseMatcher" &&
					handler.matcher.binding !== null
				) {
					if (handler.matcher.binding.nodeType === "Pattern") {
						declarePattern(
							handler.matcher.binding,
							handlerScope,
							context,
							"constant",
						)
					} else {
						declareInScope(
							handlerScope,
							"values",
							handler.matcher.binding,
							"constant",
							context,
						)
					}
				}

				if (handler.guard !== null) {
					walkNode(handler.guard, handlerScope, context)
				}

				walkBody(handler.body, handlerScope, context, {
					hoist: false,
				})
			}

			return
		case "RecordValue":
			if (node.type !== null) {
				walkTypeDeclaration(node.type, scope, context)
			}

			registerRecordSite(Object.values(node.members), context)

			for (let member of Object.values(node.members)) {
				walkNode(member.value, scope, context)
			}

			return
		case "ListValue":
			for (let value of node.values) {
				walkNode(value, scope, context)
			}

			return
		case "InterpolatedStringValue":
			for (let segment of node.segments) {
				if (segment.kind === "expression") {
					walkNode(segment.expression, scope, context)
				}
			}

			return
		case "FunctionValue":
			walkFunctionDefinition(node.value, scope, context, node.position)
			return
		case "Self":
		case "StringValue":
		case "IntegerValue":
		case "RationalValue":
		case "BooleanValue":
			return
	}
}

function walkArguments(
	nodeArguments: Array<parser.ArgumentNode>,
	scope: Scope,
	context: WalkContext,
) {
	// NOTE: Labels of Method and native invocations resolve through Types —
	// only their values are walked.
	for (let argument of nodeArguments) {
		walkNode(argument.value, scope, context)
	}
}

function childScope(
	parent: Scope,
	range: common.Position,
	context: WalkContext,
): Scope {
	let scope = createScope(parent)

	context.scopes.push({ range, scope })

	return scope
}

function scopeWithGenerics(
	generics: Array<parser.GenericDeclarationNode>,
	scope: Scope,
	context: WalkContext,
): Scope {
	let genericScope = createScope(scope)

	for (let generic of generics) {
		// NOTE: Default Types and Protocol bounds resolve in the outer Scope,
		// exactly like the Enricher's `resolveGenericDeclarations`.
		if (generic.defaultType !== null) {
			walkTypeDeclaration(generic.defaultType, scope, context)
		}

		if (generic.constraint !== null) {
			reference(scope, "types", generic.constraint, context)
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

function walkFunctionDefinition(
	definition: parser.FunctionDefinitionNode,
	scope: Scope,
	context: WalkContext,
	// NOTE: The wrapping FunctionStatement or FunctionValue's Position — it
	// spans the whole Definition including the body's braces, unlike the
	// body's own Statements, which can be empty or dropped by error recovery
	// while the cursor sits inside an incomplete Statement.
	range: common.Position,
) {
	let functionScope = scopeWithGenerics(definition.generics, scope, context)

	context.scopes.push({
		range,
		scope: functionScope,
	})

	let labels = new Map<string, Declaration>()

	context.labels.set(definition, labels)

	for (let parameter of definition.parameters) {
		walkTypeDeclaration(parameter.type, functionScope, context)

		// NOTE: `_: Type` declares neither a Parameter name nor a call site
		// label, so it holds no symbol a rename could reach.
		if (parameter.internalName === null) {
			continue
		}

		// NOTE: A Pattern where the internal name goes brings in as many names
		// as it binds and none of them is the Parameter's own, so there is no
		// symbol for a label to share. An explicit label is still its own, and
		// is recorded below exactly as it would be beside a written name.
		if (parameter.internalName.nodeType === "Pattern") {
			declarePattern(
				parameter.internalName,
				functionScope,
				context,
				"parameter",
			)

			if (parameter.externalName !== null) {
				let labelDeclaration: Declaration = {
					builtin: false,
					kind: "label",
					definition: parameter.externalName.position,
					visibleFrom: null,
					occurrences: [],
				}

				record(
					labelDeclaration,
					parameter.externalName.content,
					parameter.externalName.position,
					context.index,
					"write",
				)
				labels.set(parameter.externalName.content, labelDeclaration)
			}

			continue
		}

		if (parameter.externalName === null) {
			// NOTE: `_` — explicitly label-less.
			declareInScope(
				functionScope,
				"values",
				parameter.internalName,
				"parameter",
				context,
				parameter.internalName.position.end,
			)
		} else if (parameter.externalName === parameter.internalName) {
			// NOTE: The Parser reuses the same Identifier node when the
			// internal name doubles as the call site label — one symbol, so
			// call site labels rename together with the Parameter.
			let declaration = declareInScope(
				functionScope,
				"values",
				parameter.internalName,
				"parameter",
				context,
				parameter.internalName.position.end,
			)

			labels.set(parameter.internalName.content, declaration)
		} else {
			// NOTE: An explicit external name is its own symbol — renaming
			// it never touches the internal Parameter name, and vice versa.
			let labelDeclaration: Declaration = {
				builtin: false,
				kind: "label",
				definition: parameter.externalName.position,
				visibleFrom: null,
				occurrences: [],
			}

			record(
				labelDeclaration,
				parameter.externalName.content,
				parameter.externalName.position,
				context.index,
				"write",
			)
			labels.set(parameter.externalName.content, labelDeclaration)

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

	walkTypeDeclaration(definition.returnType, functionScope, context)
	walkBody(definition.body, functionScope, context, { hoist: false })
}

function walkProtocolDeclaration(
	node: parser.ProtocolDeclarationStatementNode,
	scope: Scope,
	context: WalkContext,
) {
	declareInScope(scope, "types", node.name, "protocol", context)

	// NOTE: `Self` is visible inside the signatures — builtin, so it colours
	// like a Type Parameter but can not be renamed.
	let selfScope = createScope(scope)

	selfScope.types.set("Self", {
		builtin: true,
		kind: "generic",
		definition: null,
		visibleFrom: null,
		occurrences: [],
	})

	for (let member of Object.values(node.methods)) {
		// NOTE: Standalone Declarations — a Protocol Method's use sites
		// resolve through conformance values, which the index does not link
		// (yet); the name still declares, colours and folds like a Method.
		let declaration: Declaration = {
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

		record(
			declaration,
			member.name.content,
			member.name.position,
			context.index,
			"write",
		)

		let signatures =
			member.nodeType === "OverloadedProtocolMethod" ||
			member.nodeType === "OverloadedStaticProtocolMethod"
				? member.signatures
				: [member.signature]

		for (let signature of signatures) {
			for (let parameter of signature.parameters) {
				walkTypeDeclaration(parameter.type, selfScope, context)
			}

			walkTypeDeclaration(signature.returnType, selfScope, context)
		}
	}
}

function walkNamespaceDefinition(
	node: parser.NamespaceDefinitionStatementNode,
	scope: Scope,
	context: WalkContext,
) {
	declareInScope(scope, "values", node.name, "namespace", context)

	// NOTE: The Namespace's own Type Parameters are in scope for the `where`
	// conditions (and for the target Type and Methods below), so the Generic
	// scope is built first — a `where Item is Comparable` condition then binds
	// `Item` to the Generic's declaration, and renaming either end moves both.
	let genericScope = scopeWithGenerics(node.generics, scope, context)

	// NOTE: A clause's Protocol resolves in the outer Scope, its `where`
	// conditions' LHS Generic through the Namespace's own Type Parameters, and
	// each condition's RHS Protocol in the outer Scope again.
	for (let clause of node.conformsTo) {
		reference(scope, "types", clause.protocol, context)

		for (let condition of clause.conditions) {
			reference(genericScope, "types", condition.generic, context)
			reference(scope, "types", condition.protocol, context)
		}
	}

	// NOTE: Property and Method names are declared as Namespace member
	// symbols — the typed pass binds their use sites, which resolve through
	// the Namespace's Type. Same-named Namespaces share one member map.
	let memberDeclarations = context.namespaceMembers.get(node.name.content)

	if (memberDeclarations === undefined) {
		memberDeclarations = new Map()
		context.namespaceMembers.set(node.name.content, memberDeclarations)
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
			context.index,
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
			context.index,
			"write",
		)
	}

	if (node.targetType !== null) {
		walkTypeDeclaration(node.targetType, genericScope, context)
	}

	// NOTE: Properties resolve in the outer Scope — Namespace Generics are
	// only visible to the target Type and the Methods, like in the Enricher.
	for (let property of Object.values(node.properties)) {
		if (property.type !== null) {
			walkTypeDeclaration(property.type, scope, context)
		}

		// NOTE: A native static Property has no value to walk.
		if (property.value !== null) {
			walkNode(property.value, scope, context)
		}
	}

	for (let member of Object.values(node.methods)) {
		// NOTE: A body-less native signature has no Function definition to
		// walk, but it still WRITES Type names (`Boolean`, `List<Item>`,
		// `Ordering`) and Parameter names. Skipping it left every one of them
		// outside the index — uncoloured by Semantic Tokens, invisible to
		// Document Highlight and to `go to definition` — which went unnoticed
		// while no document containing one could be opened at all. The
		// standard library is nothing but these signatures.
		//
		// NOTE: Their names are indexed, NOT made renameable in practice:
		// `renameableOccurrenceAt` refuses outright inside a standard library
		// source (see `server.ts`), which is the only place a native signature
		// can appear. Indexing is what colours and highlights them.
		let nativeSignatures: Array<parser.NativeMethodSignatureNode> = []

		if (
			member.nodeType === "SimpleMethodSignature" ||
			member.nodeType === "StaticMethodSignature"
		) {
			nativeSignatures = [member.signature]
		} else if (
			member.nodeType === "OverloadedMethodSignatures" ||
			member.nodeType === "OverloadedStaticMethodSignatures"
		) {
			nativeSignatures = member.methods.filter(
				(entry): entry is parser.NativeMethodSignatureNode =>
					entry.nodeType === "NativeMethodSignature",
			)
		}

		for (let signature of nativeSignatures) {
			walkNativeSignature(signature, genericScope, context)
		}

		// NOTE: Only bodied Methods have a Function definition to walk.
		let methods: Array<parser.FunctionValueNode> = []

		if (
			member.nodeType === "SimpleMethod" ||
			member.nodeType === "StaticMethod"
		) {
			methods = [member.method]
		} else if (
			member.nodeType === "OverloadedMethod" ||
			member.nodeType === "OverloadedStaticMethod"
		) {
			methods = member.methods
		} else if (
			member.nodeType === "OverloadedMethodSignatures" ||
			member.nodeType === "OverloadedStaticMethodSignatures"
		) {
			methods = member.methods.filter(
				(entry): entry is parser.FunctionValueNode =>
					entry.nodeType === "FunctionValue",
			)
		}

		for (let method of methods) {
			walkFunctionDefinition(
				method.value,
				genericScope,
				context,
				method.position,
			)
		}
	}
}

function walkNativeSignature(
	signature: parser.NativeMethodSignatureNode,
	scope: Scope,
	context: WalkContext,
) {
	let signatureScope = scopeWithGenerics(signature.generics, scope, context)

	for (let parameter of signature.parameters) {
		walkTypeDeclaration(parameter.type, signatureScope, context)

		// NOTE: A Parameter of a body-less signature binds nothing —
		// there is no body to read it — so it is recorded as a
		// standalone Declaration rather than declared in a Scope,
		// exactly as a Protocol signature's would be.
		// NOTE: The Parser reuses ONE Identifier Node when the internal
		// name doubles as the call site label, so the pair is deduped
		// by identity rather than by name.
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
				context.index,
				"write",
			)
		}
	}

	walkTypeDeclaration(signature.returnType, signatureScope, context)
}

// NOTE: Null for an annotation a contextually typed Function literal omitted —
// there is no Type written down, so there is no name in it to rename.
function walkTypeDeclaration(
	node: parser.TypeDeclarationNode | null,
	scope: Scope,
	context: WalkContext,
) {
	if (node === null) {
		return
	}

	switch (node.nodeType) {
		case "IdentifierTypeDeclaration":
			reference(scope, "types", node.type, context)
			return
		case "RecordTypeDeclaration":
			registerRecordSite(Object.values(node.members), context)

			for (let member of Object.values(node.members)) {
				walkTypeDeclaration(member.type, scope, context)
			}

			return
		case "UnionTypeDeclaration":
			for (let type of node.types) {
				walkTypeDeclaration(type, scope, context)
			}

			return
		case "FunctionTypeDeclaration":
			for (let parameter of node.parameterTypes) {
				walkTypeDeclaration(parameter.type, scope, context)
			}

			walkTypeDeclaration(node.returnType, scope, context)
			return
		case "GenericTypeDeclaration":
			walkTypeDeclaration(node.baseType, scope, context)

			for (let generic of node.generics) {
				walkTypeDeclaration(generic, scope, context)
			}

			return
	}
}

/******************/
/* Record members */
/******************/

function registerRecordSite(
	members: Array<parser.RecordValueMemberNode | parser.RecordTypeMemberNode>,
	context: WalkContext,
) {
	if (members.length === 0) {
		return
	}

	context.recordSites.push({
		names: members.map((member) => member.name.content),
		declares: true,
		members: members.map((member) => ({
			name: member.name.content,
			position: member.name.position,
			edits: null,
		})),
	})
}

// NOTE: A Pattern NAMES members that something else declares — the Type of
// whatever it takes apart — so it joins the member group without claiming to
// define anything. That distinction is load-bearing rather than tidy: a bare
// `{ width }` writes the member and the local it binds at ONE Position, and the
// workspace keys a Declaration by its definition Position, so a Pattern
// claiming to define the member would collapse the two into one symbol and
// rename both at once, across every file.
//
// Each member also carries how renaming THROUGH it is written: a shorthand
// binder has to spell the other end out beside the new name, because one
// Identifier is standing for both.
function registerPatternSite(
	pattern: parser.PatternNode,
	context: WalkContext,
) {
	let members = Object.values(pattern.members)

	if (members.length > 0) {
		context.recordSites.push({
			names: members.map((member) => member.name.content),
			declares: false,
			members: members.map((member) => ({
				name: member.name.content,
				position: member.name.position,
				edits: memberRenameEdits(member),
			})),
		})
	}

	for (let member of members) {
		if (member.kind === "Type" && member.binder?.nodeType === "Pattern") {
			registerPatternSite(member.binder, context)
		}
	}
}

// NOTE: What renaming the MEMBER writes at a Pattern member. Only a shorthand
// binder needs anything: `{ width }` becomes `{ newName as width }`, so that
// the body reading `width` still reads the member it was bound from. Every
// other spelling already writes the two names apart, and the member's own span
// is simply overwritten.
function memberRenameEdits(
	member: parser.PatternMemberNode,
): Array<RenameEdit> | null {
	if (member.kind !== "Type" || member.binder !== null) {
		return null
	}

	// NOTE: The binder goes AFTER the Type, because the grammar is
	// `Identifier ":" Type "as" Binder`. Writing it straight after the name
	// instead produced `{ breadth as width: Integer }`, which is not a Pattern
	// at all — a plain rename turned a clean file into a syntax error.
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

// NOTE: What renaming the LOCAL writes at a Pattern member — the mirror of
// `memberRenameEdits`. `{ width }` becomes `{ width as newName }`; an annotated
// `{ width: Integer }` takes its binder AFTER the Type, so the edit inserts at
// an empty span there rather than overwriting the member's name. A member that
// already writes its binder needs nothing: that binder IS the local.
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

// NOTE: Every name a Pattern brings into scope, declared where the author wrote
// it, plus the Type references its annotated members make. `patternBindings`
// decides WHICH names, so the Enricher and this index can never disagree about
// what a Pattern binds.
function declarePattern(
	pattern: parser.PatternNode,
	scope: Scope,
	context: WalkContext,
	kind: DeclarationKind,
	// NOTE: Where the names start being resolvable, exactly as an ordinary
	// Declaration passes it — a Pattern's bindings are Constants and Variables
	// and do not hoist, so a Declaration hands the end of its own Statement and
	// Completion stops offering them above it. A Matcher's and a Parameter's are
	// visible throughout the Scope they were made for, which is what null means.
	visibleFrom: common.Cursor | null = null,
) {
	registerPatternSite(pattern, context)
	walkPatternTypes(pattern, scope, context)

	for (let binding of patternBindings(pattern)) {
		declareInScope(
			scope,
			"values",
			binding.name,
			kind,
			context,
			visibleFrom,
			editsForBinding(pattern, binding.name),
		)
	}
}

// NOTE: Every Type a Pattern names, at every depth. Written as its own walk
// because a nested Pattern's annotation is a Type reference like any other: one
// left out of the index is one a rename leaves behind, turning a clean file into
// `unknown-type` — and it would get no definition and no Semantic Token either.
function walkPatternTypes(
	pattern: parser.PatternNode,
	scope: Scope,
	context: WalkContext,
) {
	for (let member of Object.values(pattern.members)) {
		if (member.kind !== "Type") {
			continue
		}

		if (member.type !== null) {
			walkTypeDeclaration(member.type, scope, context)
		}

		if (member.binder?.nodeType === "Pattern") {
			walkPatternTypes(member.binder, scope, context)
		}
	}
}

// NOTE: The rewrite a binding's own declaration site needs, found by the
// Identifier the binding was read under — a shorthand member is the only one
// that needs any, and it is the only one whose `name` node IS the member's.
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

// NOTE: Record Types are structural — there is no single declaration a
// member belongs to. Member occurrences are grouped across all Record
// shapes that are subset-related (one could flow into the other), so a
// rename touches every site that could observe the member. Two unrelated
// but identically shaped Records rename together — with structural typing
// they are the same Type.
function resolveRecordMembers(context: WalkContext) {
	let shapes = [
		...context.recordSites.map((site) => new Set(site.names)),
		...context.recordLookups.map((lookupSite) => new Set(lookupSite.names)),
	]

	let parents = shapes.map((_, shapeIndex) => shapeIndex)

	function findRoot(shapeIndex: number): number {
		while (parents[shapeIndex] !== shapeIndex) {
			parents[shapeIndex] = parents[parents[shapeIndex]]
			shapeIndex = parents[shapeIndex]
		}

		return shapeIndex
	}

	function isSubset(a: Set<string>, b: Set<string>): boolean {
		for (let name of a) {
			if (!b.has(name)) {
				return false
			}
		}

		return true
	}

	for (let i = 0; i < shapes.length; i++) {
		for (let j = i + 1; j < shapes.length; j++) {
			if (shapes[i].size === 0 || shapes[j].size === 0) {
				continue
			}

			if (
				isSubset(shapes[i], shapes[j]) ||
				isSubset(shapes[j], shapes[i])
			) {
				parents[findRoot(i)] = findRoot(j)
			}
		}
	}

	let declarations = new Map<string, Declaration>()

	function declarationFor(shapeIndex: number, name: string): Declaration {
		let key = `${findRoot(shapeIndex)} ${name}`
		let declaration = declarations.get(key)

		if (declaration === undefined) {
			declaration = {
				builtin: false,
				kind: "member",
				definition: null,
				visibleFrom: null,
				occurrences: [],
			}
			declarations.set(key, declaration)
		}

		return declaration
	}

	// NOTE: Declaration sites first, so `definition` points at one of them
	// instead of at a Lookup. A Pattern's site is not one of them — it names
	// members something else declares, and taking a definition Position from it
	// would be taking the one its own local binding already occupies.
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
				context.index,
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

		record(declaration, lookupSite.name, lookupSite.position, context.index)
	})
}

/**************/
/* Typed pass */
/**************/

function bindNamespaceMember(
	namespaceName: string,
	memberName: string,
	position: common.Position,
	context: WalkContext,
) {
	// NOTE: Builtin Namespaces have no source declaration — their members
	// stay unbound and are therefore not renameable.
	let declaration = context.namespaceMembers
		.get(namespaceName)
		?.get(memberName)

	if (declaration !== undefined) {
		record(declaration, memberName, position, context.index)

		return
	}

	// NOTE: An imported Namespace lands here too, and unlike a builtin it DOES
	// have a source declaration — in the Module that wrote it. Kept so the
	// workspace index can bind it there; a single file's index has no way to
	// tell the two apart and does not have to.
	context.externalMembers.push({ namespaceName, memberName, position })
}

function walkTypedBody(
	nodes: Array<common.typed.ImplementationNode>,
	context: WalkContext,
) {
	for (let node of nodes) {
		walkTypedNode(node, context)
	}
}

function walkTypedArguments(
	nodeArguments: Array<common.typed.ArgumentNode>,
	context: WalkContext,
) {
	for (let argument of nodeArguments) {
		walkTypedNode(argument.value, context)
	}
}

function walkTypedNode(
	node: common.typed.ImplementationNode,
	context: WalkContext,
) {
	switch (node.nodeType) {
		case "ConstantDeclarationStatement":
		case "VariableDeclarationStatement":
		case "VariableAssignmentStatement":
			walkTypedNode(node.value, context)
			return
		case "FunctionStatement":
			walkTypedBody(node.value.body, context)
			return
		case "NamespaceDefinitionStatement":
			for (let property of Object.values(node.properties)) {
				walkTypedNode(property.value, context)
			}

			for (let member of Object.values(node.methods)) {
				let methods =
					member.nodeType === "OverloadedMethod" ||
					member.nodeType === "OverloadedStaticMethod"
						? member.methods
						: [member.method]

				for (let method of methods) {
					walkTypedBody(method.value.body, context)
				}
			}

			return
		case "IfStatement":
			walkTypedNode(node.condition, context)
			walkTypedBody(node.body, context)
			return
		case "IfElseStatement":
			walkTypedNode(node.condition, context)
			walkTypedBody(node.trueBody, context)
			walkTypedBody(node.falseBody, context)
			return
		case "ReturnStatement":
			walkTypedNode(node.expression, context)
			return
		case "MethodInvocation":
			bindNamespaceMember(
				node.namespace.name,
				node.member.name,
				node.member.position,
				context,
			)
			walkTypedNode(node.base, context)
			walkTypedArguments(node.arguments, context)
			return
		case "FunctionInvocation":
			walkTypedNode(node.name, context)
			walkTypedArguments(node.arguments, context)
			return
		case "Lookup": {
			walkTypedNode(node.base, context)

			let baseType = node.base.type

			if (baseType.type === "Namespace") {
				bindNamespaceMember(
					baseType.name,
					node.member.content,
					node.member.position,
					context,
				)
			} else if (baseType.type === "Record") {
				context.recordLookups.push({
					names: Object.keys(baseType.members),
					name: node.member.content,
					position: node.member.position,
				})
			}

			return
		}
		case "Combination":
			walkTypedNode(node.lhs, context)
			walkTypedNode(node.rhs, context)
			return
		case "Match":
			walkTypedNode(node.value, context)

			for (let handler of node.handlers) {
				for (let expression of typedHandlerExpressions(handler)) {
					walkTypedNode(expression, context)
				}

				walkTypedBody(handler.body, context)
			}

			return
		case "RecordValue":
			for (let member of Object.values(node.members)) {
				walkTypedNode(member, context)
			}

			return
		case "ListValue":
			for (let value of node.values) {
				walkTypedNode(value, context)
			}

			return
		case "InterpolatedStringValue":
			for (let segment of node.segments) {
				if (segment.kind === "expression") {
					walkTypedNode(segment.expression, context)
				}
			}

			return
		case "FunctionValue":
			walkTypedBody(node.value.body, context)
			return
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
