import type { common, enricher, parser } from "@essence-lang/interfaces"

import { type CompileMode, modeOf } from "../compileMode"
import {
	collectDiagnostics,
	primary,
	reportError,
	reportWarning,
	secondary,
} from "../diagnostics/index"
import { exampleTestsOf } from "../enricher/examples"
import { exposedMethods } from "../enricher/exposedMethods"
import {
	enrichPrograms,
	type LateNames,
	topLevelScope,
} from "../enricher/index"
import {
	invalidateNamespacesInScope,
	printableProtocolName,
} from "../enricher/resolvers"
import { countTypeDeclaration } from "../enricher/scope"
import { derivedPrintableNamespaceName } from "../helpers/conformance"
import { isDeclaration, specifierTo } from "../helpers/describe"
import { forEachHeldRecord } from "../helpers/nodes"
import { patternBindings } from "../helpers/patterns"
import { closestMatch } from "../helpers/suggest"
import { flattenUnionMembers } from "../helpers/types"
import {
	findParserChild,
	forEachParserChild,
	forEachTypedChild,
	type ParserNode,
	type TypedNode,
} from "../visitor/index"
import type { Module, ModuleGraph } from "./graph"
import { resolveSpecifier } from "./resolve"
import {
	constantStatementAt,
	readWrittenConstantTypes,
} from "./writtenConstants"

// What a top-level declaration was written as. A Variable can not be
// exported, and a Constant written without its Type binds across a cycle only
// once its Statement is enriched. Every other kind hoists.
export type DeclaredKind =
	| "constant"
	| "variable"
	| "function"
	| "namespace"
	| "type"
	| "choice"
	| "protocol"

export type Declaration = {
	kind: DeclaredKind
	position: common.Position
}

// What a Module offers its importers, keyed by the exported name with `as`
// applied. A name is exported exactly when `kinds` has it. The tables beside it
// may still be empty while a cycle hoists.
export type ExportSurface = {
	values: Record<string, common.Type>
	types: Record<string, common.Type>
	protocols: Record<string, common.ProtocolType>
	declarations: Record<string, common.Position>
	constants: Set<string>
	kinds: Record<string, DeclaredKind>
	// The names an entry forwards from another Module, whose Position in
	// `declarations` is one in that Module's file. A Position carries no file,
	// so a match against this Module's own declarations skips them.
	forwarded: Set<string>
	// Every Type the Module binds at its top level, private ones included. No
	// import reaches them. A Help about a Choice it keeps private reads them.
	moduleTypes: Record<string, common.Type>
	// The provided Methods each exported Namespace offers a host, filled only
	// in an `embed` compile once the Module's group is enriched.
	exposed?: Record<string, Array<common.ExposedMethod>>
}

export type LinkedModule = {
	module: Module
	program: common.typed.Program
	// This Module's own Diagnostics, in stage order. Each Module collects its
	// own, since `report` would drop another file's equal Diagnostic.
	diagnostics: Array<common.Diagnostic>
	surface: ExportSurface
	// Empty unless this is the Module `annotationsFor` names.
	annotations: Array<common.TypeAnnotation>
	// What the import block bound, by local name. The typed entries carry one
	// Type each and no Protocol, so the language server resolves names here.
	imported: ImportedNames
}

// The three tables a Scope holds names in, narrowed to what one import
// block put there.
export type ImportedNames = {
	values: Record<string, common.Type>
	types: Record<string, common.Type>
	protocols: Record<string, common.ProtocolType>
}

export type LinkedGraph = {
	entryPath: string
	// The graph's order, which the Module bodies run in.
	modules: Map<string, LinkedModule>
	diagnostics: Array<common.Diagnostic>
	// Each Module's top-level declarations, kept for `linkContextOf`.
	declarations: Map<string, Map<string, Declaration>>
	// Every Protocol the graph declares, by identity, which each Module's Scope
	// is linked with.
	protocols: Map<string, common.ProtocolType>
}

function emptySurface(): ExportSurface {
	return {
		values: {},
		types: {},
		protocols: {},
		declarations: {},
		constants: new Set(),
		kinds: {},
		forwarded: new Set(),
		moduleTypes: {},
	}
}

// A Pattern declares every name it binds. Linking runs before the enricher
// desugars Patterns, so the names are read off the Pattern.
function declarationsOf(
	node: parser.ImplementationNode,
): Array<{ name: parser.IdentifierNode; kind: DeclaredKind }> {
	switch (node.nodeType) {
		case "ConstantDeclarationStatement":
		case "VariableDeclarationStatement": {
			let kind =
				node.nodeType === "ConstantDeclarationStatement"
					? ("constant" as const)
					: ("variable" as const)

			if (node.name.nodeType === "Pattern") {
				return patternBindings(node.name).map((binding) => ({
					name: binding.name,
					kind,
				}))
			}

			return [{ name: node.name, kind }]
		}

		case "FunctionStatement":
		case "OverloadedFunctionStatement":
			return [{ name: node.name, kind: "function" }]

		case "NamespaceDefinitionStatement":
			return [{ name: node.name, kind: "namespace" }]

		case "TypeAliasStatement":
			return [{ name: node.name, kind: "type" }]

		case "ChoiceDeclarationStatement":
			return [{ name: node.name, kind: "choice" }]

		case "ProtocolDeclarationStatement":
			return [{ name: node.name, kind: "protocol" }]

		default:
			return []
	}
}

// Read off the AST, since collisions and kinds are needed before enrichment.
// A name's first declaration is kept, since a duplicate never reaches the
// Scope.
export function topLevelDeclarations(
	program: parser.Program,
): Map<string, Declaration> {
	let declarations = new Map<string, Declaration>()

	for (let node of program.implementation.nodes) {
		for (let declaration of declarationsOf(node)) {
			if (declarations.has(declaration.name.content)) {
				continue
			}

			declarations.set(declaration.name.content, {
				kind: declaration.kind,
				position: declaration.name.position,
			})
		}
	}

	return declarations
}

// The export block by published name. A second entry publishing a name is
// dropped rather than reported.
function exportedEntries(
	program: parser.Program,
): Map<string, parser.ExportNode> {
	let entries = new Map<string, parser.ExportNode>()

	for (let entry of program.exports?.entries ?? []) {
		let name = (entry.alias ?? entry.name).content

		if (!entries.has(name)) {
			entries.set(name, entry)
		}
	}

	return entries
}

// By specifier, name and local name, in code units. Namespace dispatch is
// seeded in this order, so reordering an import block never changes which
// Namespace a Method call resolves to. It is the order `esfmt` writes with
// `compareGroups` and `compareEntries` in `packages/formatter/src/sections.ts`,
// except that two groups for one file stay apart there.
function compareEntries(left: parser.ImportNode, right: parser.ImportNode) {
	let keyOf = (entry: parser.ImportNode) => [
		entry.source.path,
		entry.name.content,
		entry.alias === null ? "" : entry.alias.content,
	]
	let leftKey = keyOf(left)
	let rightKey = keyOf(right)

	for (let index = 0; index < leftKey.length; index++) {
		if (leftKey[index] !== rightKey[index]) {
			return (leftKey[index] as string) < (rightKey[index] as string)
				? -1
				: 1
		}
	}

	return 0
}

type ImportBinding = {
	entry: parser.ImportNode
	localName: string
	// Null when the specifier resolved to nothing, which the graph reported.
	dependencyPath: string | null
	// A `waiting` entry names a Constant of another Module of the cycle whose
	// Type is not known yet. It binds once its Statement is enriched.
	state: "pending" | "waiting" | "bound" | "refused"
	// How many tables the entry has bound, compared with `tablesOffered`.
	boundTables: number
}

type ModuleState = {
	module: Module
	scope: enricher.Scope
	declarations: Map<string, Declaration>
	exports: Map<string, parser.ExportNode>
	imports: Array<ImportBinding>
	diagnostics: Array<common.Diagnostic>
	// The written Types of the exported Constants, offered before their
	// Statements are enriched. See "Constants across a cycle" in
	// DEVELOPMENT.md.
	writtenConstantTypes: Map<string, common.Type>
	// The provided Methods each exported Namespace declared here offers a
	// host, by exported name. Set in an `embed` compile once the group is
	// enriched.
	exposed?: Record<string, Array<common.ExposedMethod>>
}

// Whether the emitted JavaScript binds a published name. Type Aliases, Choices
// and Protocols erase. It asks `values` rather than the kind, since a
// `type Rectangle` beside a `namespace Rectangle` still emits a class.
function isRuntimeName(surface: ExportSurface | null, name: string): boolean {
	return surface !== null && surface.values[name] !== undefined
}

function isWrittenValue(surface: ExportSurface | null, name: string): boolean {
	let kind = surface?.kinds[name]

	return kind === "constant" || kind === "variable"
}

// What a Hover over an entry prints. A name bound in both tables answers with
// the member, which is what it means in an expression.
function boundEntryType(
	scope: enricher.Scope,
	name: string,
): common.Type | null {
	return scope.members[name] ?? scope.types[name] ?? null
}

// The typed import and export sections, which enrichment leaves null since it
// never sees another Module's surface. An entry that did not bind is left out,
// since it was reported.
function moduleSections(
	state: ModuleState,
	surface: ExportSurface,
	surfaceFor: (filePath: string) => ExportSurface | null,
	inCycle: (filePath: string) => boolean,
): {
	imports: common.typed.ImportSectionNode | null
	exports: common.typed.ExportSectionNode | null
} {
	let importSection = state.module.program.imports
	let exportSection = state.module.program.exports

	return {
		imports:
			importSection === null
				? null
				: {
						nodeType: "ImportSection",
						entries: state.imports.flatMap((binding) => {
							if (
								binding.state !== "bound" ||
								binding.dependencyPath === null
							) {
								return []
							}

							return [
								{
									nodeType: "Import" as const,
									name: binding.entry.name.content,
									alias:
										binding.entry.alias === null
											? null
											: binding.entry.alias.content,
									source: binding.entry.source.path,
									modulePath: binding.dependencyPath,
									runtime: isRuntimeName(
										surfaceFor(binding.dependencyPath),
										binding.entry.name.content,
									),
									cyclic: inCycle(binding.dependencyPath),
									type: boundEntryType(
										state.scope,
										binding.localName,
									),
									writtenValue: isWrittenValue(
										surfaceFor(binding.dependencyPath),
										binding.entry.name.content,
									),
									position: binding.entry.position,
								},
							]
						}),
						position: importSection.position,
					},
		exports:
			exportSection === null
				? null
				: {
						nodeType: "ExportSection",
						entries: [...state.exports].flatMap(
							([publicName, entry]) => {
								if (surface.kinds[publicName] === undefined) {
									return []
								}

								return [
									{
										nodeType: "Export" as const,
										name: entry.name.content,
										alias:
											entry.alias === null
												? null
												: entry.alias.content,
										source:
											entry.source === null
												? null
												: entry.source.path,
										modulePath:
											entry.source === null
												? null
												: (state.module.resolutions.get(
														entry.source.path,
													) ?? null),
										runtime: isRuntimeName(
											surface,
											publicName,
										),
										type:
											entry.source === null
												? boundEntryType(
														state.scope,
														entry.name.content,
													)
												: null,
										...(entry.source === null &&
										surface.exposed?.[publicName] !==
											undefined
											? {
													exposed:
														surface.exposed[
															publicName
														],
												}
											: {}),
										position: entry.position,
									},
								]
							},
						),
						position: exportSection.position,
					},
	}
}

// A shallow copy carrying the local name, since an emitted Method call reads
// the Namespace Type's own `name`. Nothing else may key off that name. A copy
// under another name keeps the declared one beside it.
function underLocalName(type: common.Type, localName: string): common.Type {
	if (type.type !== "Namespace") {
		return type
	}

	let { declaredName = type.name, ...namespace } = type

	return declaredName === localName
		? { ...namespace, name: localName }
		: { ...namespace, name: localName, declaredName }
}

function bindInto(
	scope: enricher.Scope,
	localName: string,
	position: common.Position,
	surface: ExportSurface,
	exportedName: string,
): void {
	let value = surface.values[exportedName]

	if (value !== undefined) {
		scope.members[localName] = underLocalName(value, localName)
		invalidateNamespacesInScope(scope, localName, value)

		if (surface.constants.has(exportedName)) {
			scope.constants.add(localName)
		}
	}

	let type = surface.types[exportedName]

	if (type !== undefined) {
		scope.types[localName] = type
		countTypeDeclaration()
	}

	let protocol = surface.protocols[exportedName]

	if (protocol !== undefined) {
		scope.protocols[localName] = protocol
	}

	// The import entry's Position, since a Diagnostic about a use renders
	// against this Module's source.
	scope.declarations[localName] = position
}

// Binds a reported entry's name to an Error in both tables, so that its uses
// stay quiet rather than each reporting `unknown-name`. The Protocol table
// takes no Error Type, and needs none, since a Protocol always hoists in the
// first round.
function bindAsError(
	scope: enricher.Scope,
	localName: string,
	position: common.Position,
): void {
	scope.members[localName] = { type: "Error" }
	scope.types[localName] = { type: "Error" }
	countTypeDeclaration()
	scope.constants.add(localName)
	scope.declarations[localName] = position
}

function importsItself(state: ModuleState, entry: parser.ImportNode): boolean {
	let resolution = resolveSpecifier(entry.source.path, state.module.filePath)

	return resolution.kind === "rejected" && resolution.reason === "self-import"
}

function isTaken(scope: enricher.Scope, name: string): boolean {
	return (
		scope.members[name] != null ||
		scope.types[name] != null ||
		scope.protocols[name] != null
	)
}

function reportDuplicateImport(
	entry: parser.ImportNode,
	localName: string,
	firstPosition: common.Position | null,
): void {
	let local = entry.alias ?? entry.name

	reportError(`'${localName}' is already declared here`, local.position, {
		code: "duplicate-import",
		labels: [
			primary(local.position, `this binds '${localName}' a second time`),
			...(firstPosition === null
				? []
				: [secondary(firstPosition, "first declared here")]),
		],
		notes: [
			"An import binds a name in this Module exactly as a declaration does, so two of them can not share one.",
		],
		helps: [
			`Write 'as' on the entry to bind it under another name — '${entry.name.content} as …'.`,
		],
	})
}

// The name a dependency publishes a declaration under, found by its Position.
// `export { area as squareArea }` leaves `area` private, so an importer is
// told to ask for `squareArea`.
function exportedAs(
	surface: ExportSurface,
	declaration: Declaration,
): string | null {
	return (
		Object.entries(surface.declarations).find(
			([publicName, position]) =>
				!surface.forwarded.has(publicName) &&
				position.start.line === declaration.position.start.line &&
				position.start.column === declaration.position.start.column,
		)?.[0] ?? null
	)
}

function reportMissingExport(
	entry: parser.ImportNode | parser.ExportNode,
	specifier: string,
	declaration: Declaration | null,
	surface: ExportSurface,
): void {
	let source = entry.name

	if (declaration !== null) {
		let alias = exportedAs(surface, declaration)
		// The entry keeps the name this file binds, so no use of it changes.
		let local = entry.alias?.content ?? source.content
		let publishes = Object.keys(surface.kinds).length !== 0

		reportError(
			`'${source.content}' is not exported by ${specifier}`,
			source.position,
			{
				code: "not-exported",
				labels: [
					primary(
						source.position,
						"declared in that Module, but private",
					),
				],
				// The `as` rule only where the block lists the declaration
				// under another name.
				notes: [
					"A name is private unless the Module's 'export { … }' block lists it.",
					...(alias === null
						? []
						: [
								"An 'as' on an export entry renames the declaration for everyone, so a name the block lists under another one stays private under this one.",
							]),
				],
				// A declaration published under another name is asked for by
				// that name, since adding this one would publish it twice.
				helps: [
					alias !== null
						? `${specifier} exports it as '${alias}' — import that name instead: '${alias === local ? alias : `${alias} as ${local}`}'.`
						: publishes
							? `Add '${source.content}' to the 'export { … }' block of ${specifier}.`
							: `Open an 'export { … }' block in ${specifier} and list '${source.content}' in it.`,
				],
			},
		)

		return
	}

	// A near miss among the published names, such as `aera` for `area`.
	let suggestion = closestMatch(source.content, Object.keys(surface.kinds))

	reportError(
		`${specifier} declares nothing named '${source.content}'`,
		source.position,
		{
			code: "unknown-export",
			labels: [primary(source.position, "no such name in that Module")],
			notes: [
				"The name is matched against what that Module exports, under the names it exports them as — an 'as' on its export entry renames it for everyone.",
			],
			helps: [
				...(suggestion === null
					? []
					: [`Did you mean '${suggestion}'?`]),
				"Check the spelling, and that the specifier names the file you meant.",
			],
			// For the quick fix, since the editor has no export surface.
			...(suggestion === null
				? {}
				: {
						data: {
							kind: "suggestion" as const,
							suggestion,
						},
					}),
		},
	)
}

// One graph links in one `CompileMode`, which every Module of it shares.
export type LinkOptions = CompileMode & {
	// The canonical path of the one Module whose annotations Hover wants.
	annotationsFor?: string
	// The standard library's Scope has no `modulePath`, so its Choices keep
	// bare names. It must not start from `builtinMembers()`, which would load
	// the library recursively.
	scopeFor?: (module: Module) => enricher.Scope
}

export function linkModuleGraph(
	graph: ModuleGraph,
	options: LinkOptions = {},
): LinkedGraph {
	// Every Module's declarations up front, so a refused entry can tell a
	// private name from a missing one.
	let declarations = new Map<string, Map<string, Declaration>>()

	for (let [filePath, module] of graph.modules) {
		declarations.set(filePath, topLevelDeclarations(module.program))
	}

	let dependencies = new Map(
		[...graph.modules].map(([filePath, module]) => [
			filePath,
			module.dependencies,
		]),
	)
	let surfaces = new Map<string, ExportSurface>()
	let linked = new Map<string, LinkedModule>()
	let protocols = new Map<string, common.ProtocolType>()

	for (let group of graph.groups) {
		for (let result of linkGroup(
			group,
			declarations,
			dependencies,
			surfaces,
			protocols,
			options,
		)) {
			surfaces.set(result.module.filePath, result.surface)
			linked.set(result.module.filePath, result)
		}
	}

	return {
		entryPath: graph.entryPath,
		modules: linked,
		diagnostics: graph.diagnostics,
		declarations,
		protocols,
	}
}

// What linking one more Module against a linked graph needs. Keeping this
// rather than the `LinkedGraph` does not pin every typed Program.
export type LinkContext = {
	surfaces: Map<string, ExportSurface>
	declarations: Map<string, Map<string, Declaration>>
	dependencies: Map<string, Array<string>>
	protocols: Map<string, common.ProtocolType>
}

export function linkContextOf(linked: LinkedGraph): LinkContext {
	return {
		surfaces: new Map(
			[...linked.modules].map(([filePath, module]) => [
				filePath,
				module.surface,
			]),
		),
		declarations: linked.declarations,
		dependencies: new Map(
			[...linked.modules].map(([filePath, module]) => [
				filePath,
				module.module.dependencies,
			]),
		),
		protocols: linked.protocols,
	}
}

// One Module linked against dependencies linked already, as a language server
// probe is. Its own surface is dropped first, since `surfaceOf` would read it
// back.
export function linkModuleAgainst(
	module: Module,
	context: LinkContext,
	options: LinkOptions = {},
): LinkedModule {
	let declarations = new Map(context.declarations)

	declarations.set(module.filePath, topLevelDeclarations(module.program))

	let dependencies = new Map(context.dependencies)

	dependencies.set(module.filePath, module.dependencies)

	let surfaces = new Map(context.surfaces)

	surfaces.delete(module.filePath)

	// A copy, which the Module overwrites its own entries in. An entry
	// it stops declaring is kept, since the surfaces are built against it.
	return linkGroup(
		[module],
		declarations,
		dependencies,
		surfaces,
		new Map(context.protocols),
		options,
	)[0]!
}

// One group is one hoisting pass. Entries naming a Module of the same cycle
// are offered again between hoist rounds. See "Linking a cycle" in
// DEVELOPMENT.md.
function linkGroup(
	group: Array<Module>,
	declarations: Map<string, Map<string, Declaration>>,
	dependencies: Map<string, Array<string>>,
	surfaces: Map<string, ExportSurface>,
	protocols: Map<string, common.ProtocolType>,
	options: LinkOptions,
): Array<LinkedModule> {
	let states = new Map<string, ModuleState>()
	// The Declaration, whose Position `exportedAs` matches.
	let declares = (filePath: string, name: string): Declaration | null =>
		declarations.get(filePath)?.get(name) ?? null

	for (let module of group) {
		let state: ModuleState = {
			module,
			scope:
				options.scopeFor?.(module) ??
				topLevelScope({
					modulePath: module.filePath,
					recovery: module.program.recovery,
				}),
			declarations: declarations.get(module.filePath) ?? new Map(),
			exports: exportedEntries(module.program),
			imports: [],
			diagnostics: [],
			writtenConstantTypes: new Map(),
		}

		// The builtins a fresh top level Scope binds join the registry
		// before anything of the Module's own is declared.
		for (let protocol of Object.values(state.scope.protocols)) {
			protocols.set(protocol.identity, protocol)
		}

		state.scope.protocolRegistry = protocols
		state.scope.programTop = true
		state.scope.unimportedNamespaces = () =>
			unimportedNamespacesFor(state, surfaces, dependencies)
		state.scope.protocolDeclarations = (name) =>
			protocolDeclarationsFor(
				state,
				name,
				declarations,
				dependencies,
				states,
				surfaces,
			)
		state.scope.exportedTypes = (modulePath) =>
			surfaceOf(modulePath, states, surfaces, new Set())?.types ?? null
		state.scope.moduleTypes = (modulePath) =>
			surfaceOf(modulePath, states, surfaces, new Set())?.moduleTypes ??
			null

		for (let entry of [...(module.program.imports?.entries ?? [])].sort(
			compareEntries,
		)) {
			state.imports.push({
				entry,
				localName: (entry.alias ?? entry.name).content,
				dependencyPath:
					module.resolutions.get(entry.source.path) ?? null,
				state: "pending",
				boundTables: 0,
			})
		}

		states.set(module.filePath, state)
	}

	let surfaceFor = (filePath: string): ExportSurface | null =>
		surfaceOf(filePath, states, surfaces, new Set())

	// Only another Module of a cycle reads a Constant before its Statement.
	let exportedConstantsOf = new Map(
		group.length > 1
			? [...states.values()].map(
					(state) => [state, exportedConstants(state)] as const,
				)
			: [],
	)
	// Answers whether an annotation was read that had not been before.
	let readWrittenConstants = (final: boolean): boolean => {
		let read = false

		for (let [state, statements] of exportedConstantsOf) {
			read =
				readWrittenConstantTypes(
					statements,
					state.scope,
					state.writtenConstantTypes,
					final,
				) || read
		}

		return read
	}

	let seedEach = (final: boolean): boolean => {
		let bound = false

		for (let state of states.values()) {
			let { diagnostics } = collectDiagnostics(() => {
				bound =
					seedImports(state, states, declares, surfaceFor) || bound

				if (final) {
					refuseUnboundImports(state)
				}
			})

			state.diagnostics.push(...diagnostics)
		}

		return bound
	}

	let seedRound = (final: boolean): boolean => {
		let bound = seedEach(final)

		// An annotation may name what the seeding bound, and the Constant it
		// types is offered at once.
		while (readWrittenConstants(false)) {
			bound = seedEach(final) || bound
		}

		return bound
	}

	// The hoist's last fill may complete a refinement an annotation names. An
	// annotation that still does not resolve binds its Constant as an Error.
	let settleWrittenConstants = (): void => {
		while (readWrittenConstants(true)) {
			seedEach(true)
		}
	}

	// Once before the hoist, which binds a lone Module's whole block, and then
	// between the hoist rounds for what a cycle leaves pending.
	seedRound(false)

	let annotationsIndex = [...states.values()].findIndex(
		(state) => state.module.filePath === options.annotationsFor,
	)

	let enriched = enrichPrograms(
		[...states.values()].map((state) => ({
			program: state.module.program,
			scope: state.scope,
			// Only a test compile reads it, for `@example` blocks and value
			// comments.
			source: state.module.sourceText,
		})),
		{
			...modeOf(options),
			seedRound,
			lateNames: lateNamesOf(
				states,
				declares,
				surfaceFor,
				settleWrittenConstants,
			),
			annotationsFor:
				annotationsIndex === -1 ? undefined : annotationsIndex,
		},
	)

	// Before any final surface is built, so a Module of the cycle that forwards
	// a Namespace reads what its own Module found.
	if (options.embed === true) {
		for (let state of states.values()) {
			state.exposed = exposedOf(state)
		}
	}

	return [...states.values()].map((state, index) => {
		let { diagnostics } = collectDiagnostics(() => {
			reportExportProblems(state, declares, surfaceFor)
			reportUnusedImports(
				state,
				enriched[index]!.program,
				enriched[index]!.reachedNames,
			)

			if (group.length > 1) {
				reportCyclicSideEffects(state, group)
			}
		})

		let surface = surfaceFor(state.module.filePath) ?? emptySurface()

		return {
			module: state.module,
			program: {
				...enriched[index]!.program,
				...moduleSections(
					state,
					surface,
					surfaceFor,
					(filePath) =>
						group.length > 1 &&
						filePath !== state.module.filePath &&
						states.has(filePath),
				),
			},
			diagnostics: [
				...state.module.diagnostics,
				...state.diagnostics,
				...enriched[index]!.diagnostics,
				...diagnostics,
			],
			surface,
			annotations: enriched[index]!.annotations,
			imported: importedNames(state),
		}
	})
}

// The provided Methods each Namespace this Module declares and exports offers
// a host. The declaration proved each conformance already, so nothing solved
// here is reported again.
function exposedOf(
	state: ModuleState,
): Record<string, Array<common.ExposedMethod>> {
	let exposed: Record<string, Array<common.ExposedMethod>> = {}

	collectDiagnostics(() => {
		for (let [publicName, entry] of state.exports) {
			let value =
				entry.source === null &&
				state.declarations.has(entry.name.content)
					? state.scope.members[entry.name.content]
					: undefined

			if (value?.type !== "Namespace") {
				continue
			}

			let methods = exposedMethods(value, state.scope, entry.position)

			if (methods.length > 0) {
				exposed[publicName] = methods
			}
		}
	})

	return exposed
}

// Read off the Scope, so that it reports what the Module ended up with,
// including a name a declaration of its own took.
function importedNames(state: ModuleState): ImportedNames {
	let imported: ImportedNames = { values: {}, types: {}, protocols: {} }

	for (let binding of state.imports) {
		if (binding.state !== "bound") {
			continue
		}

		let value = state.scope.members[binding.localName]
		let type = state.scope.types[binding.localName]
		let protocol = state.scope.protocols[binding.localName]

		if (value !== undefined) {
			imported.values[binding.localName] = value
		}

		if (type !== undefined) {
			imported.types[binding.localName] = type
		}

		if (protocol !== undefined) {
			imported.protocols[binding.localName] = protocol
		}
	}

	return imported
}

// The Statements of the Constants the Module declares and exports. A
// Pattern's binding has none of its own, since the annotation types the whole
// value.
function exportedConstants(
	state: ModuleState,
): Array<parser.ConstantDeclarationStatementNode> {
	let exported = new Set(
		[...state.exports.values()].flatMap((entry) =>
			entry.source === null ? [entry.name.content] : [],
		),
	)

	return state.module.program.implementation.nodes.filter(
		(node): node is parser.ConstantDeclarationStatementNode =>
			node.nodeType === "ConstantDeclarationStatement" &&
			node.name.nodeType === "Identifier" &&
			exported.has(node.name.content) &&
			state.declarations.get(node.name.content)?.position ===
				node.name.position,
	)
}

// A linked Module's final surface, or one built from the current Scope of a
// Module in the group. `visiting` stops a re-export chain that leads back into
// the group.
function surfaceOf(
	filePath: string,
	states: Map<string, ModuleState>,
	surfaces: Map<string, ExportSurface>,
	visiting: Set<string>,
): ExportSurface | null {
	let finished = surfaces.get(filePath)

	if (finished !== undefined) {
		return finished
	}

	let state = states.get(filePath)

	if (state === undefined || visiting.has(filePath)) {
		return null
	}

	visiting.add(filePath)

	let surface = emptySurface()

	for (let [publicName, entry] of state.exports) {
		if (entry.source === null) {
			let declared = state.declarations.get(entry.name.content)

			if (declared === undefined) {
				continue
			}

			surface.kinds[publicName] = declared.kind
			surface.declarations[publicName] = declared.position

			let exportedName = entry.name.content
			let written = state.writtenConstantTypes.get(exportedName)
			let value = state.scope.members[exportedName] ?? written

			if (value !== undefined) {
				surface.values[publicName] = value

				if (
					state.scope.constants.has(exportedName) ||
					written !== undefined
				) {
					surface.constants.add(publicName)
				}
			}

			let exposed = state.exposed?.[publicName]

			if (exposed !== undefined) {
				surface.exposed = { ...surface.exposed, [publicName]: exposed }
			}

			let type = state.scope.types[exportedName]

			if (type !== undefined) {
				surface.types[publicName] = type
				countTypeDeclaration()
			}

			let protocol = state.scope.protocols[exportedName]

			if (protocol !== undefined) {
				surface.protocols[publicName] = protocol
			}

			continue
		}

		let dependencyPath = state.module.resolutions.get(entry.source.path)
		let dependency =
			dependencyPath === undefined
				? null
				: surfaceOf(dependencyPath, states, surfaces, visiting)

		if (dependency === null) {
			continue
		}

		let exportedName = entry.name.content
		let kind = dependency.kinds[exportedName]

		if (kind === undefined) {
			continue
		}

		surface.kinds[publicName] = kind
		surface.forwarded.add(publicName)

		let forwardedValue = dependency.values[exportedName]

		if (forwardedValue !== undefined) {
			surface.values[publicName] = forwardedValue
		}

		let forwardedType = dependency.types[exportedName]

		if (forwardedType !== undefined) {
			surface.types[publicName] = forwardedType
			countTypeDeclaration()
		}

		let forwardedProtocol = dependency.protocols[exportedName]

		if (forwardedProtocol !== undefined) {
			surface.protocols[publicName] = forwardedProtocol
		}

		let forwardedExposed = dependency.exposed?.[exportedName]

		if (forwardedExposed !== undefined) {
			surface.exposed = {
				...surface.exposed,
				[publicName]: forwardedExposed,
			}
		}

		if (dependency.constants.has(exportedName)) {
			surface.constants.add(publicName)
		}

		let declaration = dependency.declarations[exportedName]

		if (declaration !== undefined) {
			surface.declarations[publicName] = declaration
		}
	}

	visiting.delete(filePath)
	surface.moduleTypes = state.scope.types

	return surface
}

// How many tables a surface offers a name. A rise tells a bound entry that its
// dependency has since published another half of the name.
function tablesOffered(surface: ExportSurface, exportedName: string): number {
	return (
		(surface.values[exportedName] === undefined ? 0 : 1) +
		(surface.types[exportedName] === undefined ? 0 : 1) +
		(surface.protocols[exportedName] === undefined ? 0 : 1)
	)
}

// Binds every entry that can be bound now, and answers whether any was. A
// bound entry is offered a growing surface again. See "Linking a cycle" in
// DEVELOPMENT.md.
function seedImports(
	state: ModuleState,
	states: Map<string, ModuleState>,
	declares: (filePath: string, name: string) => Declaration | null,
	surfaceFor: (filePath: string) => ExportSurface | null,
	// The entries to offer, where not every one is.
	only?: ReadonlySet<ImportBinding>,
): boolean {
	let bound = false

	for (let binding of state.imports) {
		if (
			binding.state === "refused" ||
			(only !== undefined && !only.has(binding))
		) {
			continue
		}

		let { entry, localName, dependencyPath } = binding
		let rebinding = binding.state === "bound"

		// The graph reported a Module it could not load on its specifier. The
		// entry waits for the final round, so a loaded entry binds the name
		// first. A self-import asks for the Module's own names, so none binds.
		if (dependencyPath === null) {
			if (importsItself(state, entry)) {
				binding.state = "refused"
			}

			continue
		}

		// A bound entry is asked again only while its dependency is in the
		// group and a table is still missing, so the rounds terminate.
		if (
			rebinding &&
			(!states.has(dependencyPath) || binding.boundTables >= 3)
		) {
			continue
		}

		// A collision with a declaration of this Module is found on the AST, so
		// it is reported before hoisting. Refusing the entry keeps it to one
		// Diagnostic.
		if (
			!rebinding &&
			(state.declarations.has(localName) ||
				isTaken(state.scope, localName))
		) {
			reportDuplicateImport(
				entry,
				localName,
				state.declarations.get(localName)?.position ??
					state.scope.declarations[localName] ??
					null,
			)
			binding.state = "refused"

			continue
		}

		let surface = surfaceFor(dependencyPath)

		if (surface === null) {
			continue
		}

		let exportedName = entry.name.content
		let kind = surface.kinds[exportedName]

		if (kind === undefined) {
			if (rebinding) {
				continue
			}

			reportMissingExport(
				entry,
				entry.source.path,
				declares(dependencyPath, exportedName),
				surface,
			)
			bindAsError(state.scope, localName, entry.name.position)
			binding.state = "refused"

			continue
		}

		let tables = tablesOffered(surface, exportedName)

		// A Constant does not hoist. One from a Module of the cycle that offers
		// no written Type binds once the in-order enrichment reaches it.
		if (tables === 0 && kind === "constant" && states.has(dependencyPath)) {
			binding.state = "waiting"

			continue
		}

		if (tables === 0 || tables <= binding.boundTables) {
			continue
		}

		bindInto(
			state.scope,
			localName,
			(entry.alias ?? entry.name).position,
			surface,
			exportedName,
		)
		binding.state = "bound"
		binding.boundTables = tables
		bound = true
	}

	return bound
}

// Counts the surfaces built to bind waiting Constants, for a spec that holds
// that work to one per Constant.
export const lateBindingWork = { surfaces: 0 }

// A waiting entry, with the Module of the group that declares its Constant
// and the name the Constant is declared under there.
type HeldEntry = {
	state: ModuleState
	binding: ImportBinding
	declaring: ModuleState | null
	declaredName: string
}

// The Module of the group that declares what `filePath` exports as `name`. A
// Module forwarding the name is passed through.
function declaringModule(
	states: Map<string, ModuleState>,
	filePath: string,
	name: string,
): { state: ModuleState; name: string } | null {
	let seen = new Set<string>()
	let path: string | undefined = filePath
	let exported = name

	while (path !== undefined && !seen.has(path)) {
		seen.add(path)

		let state = states.get(path)
		let entry = state?.exports.get(exported)

		if (state === undefined || entry === undefined) {
			return null
		}

		if (entry.source === null) {
			return { state, name: entry.name.content }
		}

		exported = entry.name.content
		path = state.module.resolutions.get(entry.source.path)
	}

	return null
}

// Read once `begin` has bound what the hoist left, after which an entry only
// ever stops waiting. Kept by importer and by declaring Module.
function heldEntries(states: Map<string, ModuleState>): {
	byImporter: Map<ModuleState, Array<HeldEntry>>
	byDeclaring: Map<ModuleState, Array<HeldEntry>>
} {
	let byImporter = new Map<ModuleState, Array<HeldEntry>>()
	let byDeclaring = new Map<ModuleState, Array<HeldEntry>>()

	for (let state of states.values()) {
		for (let binding of state.imports) {
			if (
				binding.state !== "waiting" ||
				binding.dependencyPath === null
			) {
				continue
			}

			let declared = declaringModule(
				states,
				binding.dependencyPath,
				binding.entry.name.content,
			)
			let held: HeldEntry = {
				state,
				binding,
				declaring: declared?.state ?? null,
				declaredName: declared?.name ?? binding.entry.name.content,
			}

			byImporter.set(state, [...(byImporter.get(state) ?? []), held])

			if (held.declaring !== null) {
				byDeclaring.set(held.declaring, [
					...(byDeclaring.get(held.declaring) ?? []),
					held,
				])
			}
		}
	}

	return { byImporter, byDeclaring }
}

// The Constants each Module of a group waits for, read by the in-order
// enrichment. See "Constants across a cycle" in DEVELOPMENT.md.
function lateNamesOf(
	states: Map<string, ModuleState>,
	declares: (filePath: string, name: string) => Declaration | null,
	surfaceFor: (filePath: string) => ExportSurface | null,
	begin: () => void,
): LateNames {
	let ordered = [...states.values()]
	let held: ReturnType<typeof heldEntries> | null = null
	let waiting = (entries: Array<HeldEntry> | undefined) =>
		(entries ?? []).filter(({ binding }) => binding.state === "waiting")
	let waitingIn = (state: ModuleState) =>
		waiting((held ??= heldEntries(states)).byImporter.get(state))
	let inCollection = (state: ModuleState, work: () => void): void => {
		state.diagnostics.push(...collectDiagnostics(work).diagnostics)
	}
	// The group's order follows the entry, and a Module's path does not.
	let byPath = (left: number, right: number) =>
		ordered[left]!.module.filePath < ordered[right]!.module.filePath
			? -1
			: 1
	let refuseHeld = (entry: HeldEntry): void => {
		bindAsError(
			entry.state.scope,
			entry.binding.localName,
			entry.binding.entry.name.position,
		)
		entry.binding.state = "refused"
	}

	return {
		begin,
		waiting: (index) =>
			new Set(
				waitingIn(ordered[index]!).map(
					({ binding }) => binding.localName,
				),
			),
		rebind: (index, node) => {
			let declared = new Set(
				declarationsOf(node)
					.filter(({ kind }) => kind === "constant")
					.map(({ name }) => name.content),
			)
			let woken = waiting(
				(held ??= heldEntries(states)).byDeclaring.get(ordered[index]!),
			).filter(({ declaredName }) => declared.has(declaredName))
			let surfaces = new Map<string, ExportSurface | null>()
			let surfaceOnce = (filePath: string): ExportSurface | null => {
				if (!surfaces.has(filePath)) {
					lateBindingWork.surfaces++
					surfaces.set(filePath, surfaceFor(filePath))
				}

				return surfaces.get(filePath) ?? null
			}

			for (let state of new Set(woken.map((entry) => entry.state))) {
				let only = new Set(
					woken
						.filter((entry) => entry.state === state)
						.map((entry) => entry.binding),
				)

				inCollection(state, () =>
					seedImports(state, states, declares, surfaceOnce, only),
				)
			}
		},
		refuse: (reads) => {
			let entryAt = (index: number): HeldEntry =>
				waitingIn(ordered[index]!).find(
					({ binding }) =>
						binding.localName === reads.get(index)!.content,
				)!
			let waitsOn = (index: number): number => {
				let declaring = entryAt(index).declaring

				return declaring === null ? -1 : ordered.indexOf(declaring)
			}
			let stalled = [...reads.keys()].sort(byPath)

			// A declaring Module that has finished never bound the Constant,
			// and reported why itself.
			let lost = stalled.find((index) => !reads.has(waitsOn(index)))

			if (lost !== undefined) {
				refuseHeld(entryAt(lost))

				return
			}

			// Every wait leads to another stalled Module, so following them
			// closes a cycle. Its Module first by path is refused.
			let seen = new Set<number>()
			let at = stalled[0]!

			while (!seen.has(at)) {
				seen.add(at)
				at = waitsOn(at)
			}

			let members = [at]

			for (let next = waitsOn(at); next !== at; next = waitsOn(next)) {
				members.push(next)
			}

			let refused = members.sort(byPath)[0]!
			let entry = entryAt(refused)

			inCollection(entry.state, () =>
				reportCyclicConstantImport(
					entry,
					reads.get(refused)!,
					specifierTo(
						entry.state.module.filePath,
						entry.declaring!.module.filePath,
					),
				),
			)
			refuseHeld(entry)
		},
		settle: () => {
			for (let state of ordered) {
				waitingIn(state).forEach(refuseHeld)
			}
		},
	}
}

// An entry still pending names an export that never resolved, which its own
// Module reported, or a Module that was never loaded. Its name is bound as an
// Error once every loaded entry has bound, unless something holds it.
function refuseUnboundImports(state: ModuleState): void {
	for (let binding of state.imports) {
		if (binding.state !== "pending") {
			continue
		}

		binding.state = "refused"

		if (
			!state.declarations.has(binding.localName) &&
			!isTaken(state.scope, binding.localName)
		) {
			bindAsError(
				state.scope,
				binding.localName,
				binding.entry.name.position,
			)
		}
	}
}

// Every Module of the cycle waits for a Constant another has not reached.
// `declaring` spells the Module that declares it, which a forwarding Module
// may stand in front of. The first Help annotates the Constant where its
// Statement declares it by name without a Type.
function reportCyclicConstantImport(
	{ binding: { entry }, declaring: declaringState, declaredName }: HeldEntry,
	read: parser.IdentifierNode,
	declaring: string,
): void {
	let declared = declaringState?.declarations.get(declaredName)
	let statement =
		declaringState !== null && declared?.kind === "constant"
			? constantStatementAt(
					declaringState.module.program,
					declared.position,
				)
			: null
	let annotate =
		statement?.type === null
			? [
					`Annotate '${declaredName}' with its Type in ${declaring}: 'constant ${declaredName}: Type = …'.`,
				]
			: []

	reportError(
		`Constant '${entry.name.content}' is read before ${declaring} declares it`,
		read.position,
		{
			code: "cyclic-constant-import",
			labels: [
				primary(
					read.position,
					`this needs the Type of '${entry.name.content}'`,
				),
				secondary(
					entry.name.position,
					"imported from a Module of this cycle",
				),
			],
			notes: [
				`${entry.source.path} imports this Module back, directly or through further Modules.`,
				`A Constant does not hoist, and one written without its Type takes its value's, known only once its Module has been read down to it. ${declaring} reads a Constant of this cycle before it has declared '${declaredName}', and that Constant waits on this Module's code from this Statement on.`,
			],
			helps: [
				...annotate,
				`${annotate.length === 0 ? "Declare" : "Or declare"} '${declaredName}' above the Statements of ${declaring} that read a Constant of this cycle, or move it into a Module outside the cycle.`,
			],
		},
	)
}

// Whether anything in the Module, Function bodies and tests included, assigns
// to `name`.
function isAssignedIn(module: Module, name: string): boolean {
	let assigns = (node: ParserNode): true | undefined =>
		node.nodeType === "VariableAssignmentStatement" &&
		node.name.content === name
			? true
			: findParserChild(node, assigns)

	return (
		assigns(module.program.implementation) === true ||
		(module.program.tests !== null &&
			assigns(module.program.tests) === true)
	)
}

// An entry naming nothing this Module declares, and an exported Variable. A
// re-export is checked against its Module as an import is.
function reportExportProblems(
	state: ModuleState,
	declares: (filePath: string, name: string) => Declaration | null,
	surfaceFor: (filePath: string) => ExportSurface | null,
): void {
	for (let entry of state.exports.values()) {
		if (entry.source !== null) {
			let dependencyPath = state.module.resolutions.get(entry.source.path)

			if (dependencyPath === undefined) {
				continue
			}

			let surface = surfaceFor(dependencyPath)

			if (
				surface !== null &&
				surface.kinds[entry.name.content] === undefined
			) {
				reportMissingExport(
					entry,
					entry.source.path,
					declares(dependencyPath, entry.name.content),
					surface,
				)
			}

			continue
		}

		let declared = state.declarations.get(entry.name.content)

		if (declared === undefined) {
			let forwardableFrom =
				[...state.module.resolutions].find(
					([, dependencyPath]) =>
						surfaceFor(dependencyPath)?.kinds[
							entry.name.content
						] !== undefined,
				)?.[0] ?? null

			reportError(
				`'${entry.name.content}' is not declared in this Module`,
				entry.name.position,
				{
					code: "export-of-unknown-name",
					labels: [
						primary(
							entry.name.position,
							"nothing here declares this name",
						),
					],
					notes: [
						"An entry with no 'from' clause exports something this Module's implementation declares.",
					],
					// Forwarding is offered only where a dependency exports the
					// name, and then with its specifier.
					helps: [
						forwardableFrom === null
							? `Declare '${entry.name.content}' in this Module, or remove the entry.`
							: `Forward it from the Module that declares it: 'from "${forwardableFrom}" { ${entry.name.content} }'.`,
					],
				},
			)

			continue
		}

		if (declared.kind === "variable") {
			reportError(
				`Variable '${entry.name.content}' can not be exported`,
				entry.name.position,
				{
					code: "export-of-variable",
					labels: [
						primary(entry.name.position, "this is a Variable"),
						secondary(declared.position, "declared here"),
					],
					notes: [
						"A Variable another Module can read is state two files share and neither owns — which of them last wrote it is not something either one states.",
					],
					// "Declare it as a Constant" is withheld where the Module
					// assigns to the name, whose `constant-reassignment` Help
					// asks for the `variable` back. The quick fix reads this
					// text.
					helps: isAssignedIn(state.module, entry.name.content)
						? ["Export a Function that answers with its value."]
						: [
								"Declare it as a Constant, or export a Function that answers with its value.",
							],
				},
			)
		}
	}
}

// Every name the Module reads, from both trees and collected generously. See
// "Unused imports" in DEVELOPMENT.md.
function usedNames(
	module: Module,
	program: common.typed.Program,
	// Names a conformance was reached through without being written. See
	// `collectReachedNames`.
	reachedNames: Set<string>,
	// The Module's own, binding each import under its local name.
	scope: enricher.Scope,
): Set<string> {
	let names = new Set(reachedNames)
	let identities = new Set<string>()
	// A bare Case by `choice#name` where the typed tree resolved it. Otherwise
	// by its name alone.
	let bareCases = new Set<string>()
	let bareCaseNames = new Set<string>()
	let byName = false
	// The Choices a call printed through the derive.
	let printedChoices = new Set<string>()
	// The refinements a narrowing gave a binding, by name.
	let narrowedRefinements = new Set<string>()

	// A bare Case with no Choice expected resolves through the Choices in
	// Scope. One the position resolved counts too, which only quiets the
	// warning.
	let noteBareCase = (
		caseName: string,
		type: common.Type | undefined,
	): void => {
		if (type?.type === "Case") {
			bareCases.add(`${type.choice}#${type.name}`)
		} else if (byName || type !== undefined) {
			bareCaseNames.add(caseName)
		}
	}

	let visitParsed = (node: ParserNode): void => {
		if (node.nodeType === "Identifier") {
			names.add(node.content)
		} else if (node.nodeType === "CaseValue" && node.choice === null) {
			noteBareCase(node.caseName.content, undefined)
		}

		forEachParserChild(node, visitParsed)
	}

	// A Union receiver's branch or a conformance witness names a Namespace. A
	// provided Method needs its Protocol in Scope, though the call names only
	// the conforming Namespace.
	let noteRecord = (value: object): boolean => {
		let record = value as Record<string, unknown>

		if (typeof record["namespaceName"] === "string") {
			names.add(record["namespaceName"])
		}

		if (typeof record["providedBy"] === "string") {
			identities.add(record["providedBy"])
		}

		if (
			record["kind"] === "namespace" &&
			typeof record["name"] === "string"
		) {
			names.add(record["name"])
		}

		return true
	}

	// A resolved Type's name is not a use, or an import whose Type only flows
	// through would never be reported. So the walk reads no Type but the
	// Namespace a call resolved to.
	let visitTyped = (node: TypedNode, narrowed: boolean): void => {
		// A narrowed binding, or `@`, reads the refinement a narrowing chose.
		if (
			narrowed &&
			(node.nodeType === "Identifier" || node.nodeType === "Self") &&
			node.type.type === "Refinement"
		) {
			narrowedRefinements.add(node.type.name)
		}

		if (node.nodeType === "Identifier") {
			names.add(node.content)
		} else if (node.nodeType === "MethodInvocation") {
			names.add(node.namespace.name)

			if (node.namespace.type.providedBy !== undefined) {
				identities.add(node.namespace.type.providedBy)
			}

			// The derive answers only where a Namespace declared the Choice
			// `is Printable`, and the call names neither.
			if (node.namespace.name === derivedPrintableNamespaceName) {
				for (let member of casesOf(node.base.type)) {
					printedChoices.add(member.choice)
				}
			}

			// A branch types its Function literal Arguments anew.
			for (let branch of node.dispatch ?? []) {
				for (let contextual of branch.contextualArguments) {
					visitTyped(contextual.argument, narrowed)
				}
			}
		} else if (node.nodeType === "CaseValue" && node.choice === null) {
			noteBareCase(node.caseName.content, node.type)
		}

		noteRecord(node)
		forEachHeldRecord(node, noteRecord)
		forEachTypedChild(node, visitTyped, narrowed || narrowsInside(node))
	}

	visitParsed(module.program.implementation)
	visitTyped(program, false)
	// The parser's tests section and `@example` blocks, which only a test
	// compile types. Parsed here, so an import an example needs counts.
	byName = program.tests === null

	if (module.program.tests !== null) {
		visitParsed(module.program.tests)
	}

	if (byName) {
		let examples = collectDiagnostics(() =>
			exampleTestsOf(module.program, module.sourceText),
		).result

		for (let example of examples) {
			visitParsed(example)
		}

		// Nothing typed the tests or the examples, so a conformance they reach
		// without writing a name goes unseen.
		if (module.program.tests !== null || examples.length > 0) {
			for (let name of conformanceReachableNames(scope)) {
				names.add(name)
			}
		}
	}

	for (let [name, protocol] of Object.entries(scope.protocols)) {
		if (identities.has(protocol.identity)) {
			names.add(name)
		}
	}

	for (let [name, type] of Object.entries(scope.types)) {
		if (
			casesOf(type).some(
				(member) =>
					bareCases.has(`${member.choice}#${member.name}`) ||
					bareCaseNames.has(member.name),
			)
		) {
			names.add(name)
		}

		// A narrowing establishes only a refinement declared in Scope.
		let refinement = type.type === "GenericAlias" ? type.aliasedType : type

		if (
			refinement.type === "Refinement" &&
			narrowedRefinements.has(refinement.name)
		) {
			names.add(name)
		}
	}

	for (let [name, value] of Object.entries(scope.members)) {
		if (
			value.type === "Namespace" &&
			value.targetType !== null &&
			value.conformsTo?.includes(printableProtocolName) === true &&
			casesOf(value.targetType).some((member) =>
				printedChoices.has(member.choice),
			)
		) {
			names.add(name)
		}
	}

	return names
}

// Whether a binding may be narrowed somewhere inside a node. A Match narrows
// `@` and its bindings through its Matchers and Guards, which leave no record.
function narrowsInside(node: TypedNode): boolean {
	switch (node.nodeType) {
		case "IfStatement":
			return node.narrows
		case "IfElseStatement":
			return node.narrows || node.narrowsFalse
		case "Define":
			return node.arms.some((arm) => arm.narrows || arm.narrowsBelow)
		case "Match":
			return true
		default:
			return false
	}
}

// The names in Scope a conformance can be reached through without being
// written: a Protocol, a Namespace, a Choice and a refinement.
function conformanceReachableNames(scope: enricher.Scope): Array<string> {
	let namespaces = Object.entries(scope.members).filter(
		([, value]) => value.type === "Namespace",
	)
	let types = Object.entries(scope.types).filter(([, type]) => {
		let body = type.type === "GenericAlias" ? type.aliasedType : type

		return casesOf(type).length > 0 || body.type === "Refinement"
	})

	return [
		...Object.keys(scope.protocols),
		...namespaces.map(([name]) => name),
		...types.map(([name]) => name),
	]
}

// The Cases a Type declares: a Choice's, a generic Choice's through its
// Generic Alias, or a lone Case.
function casesOf(type: common.Type): Array<common.CaseType> {
	let body = type.type === "GenericAlias" ? type.aliasedType : type
	let members = body.type === "UnionType" ? flattenUnionMembers(body) : [body]

	return members.filter((member) => member.type === "Case")
}

function reportUnusedImports(
	state: ModuleState,
	program: common.typed.Program,
	reachedNames: Set<string>,
): void {
	let bound = state.imports.filter((binding) => binding.state === "bound")

	// Silent where the parser abandoned lines, which may have read an import.
	// A dropped Pattern binder loses no line.
	if (
		bound.length === 0 ||
		(state.module.program.recovery?.lines.length ?? 0) > 0
	) {
		return
	}

	let used = usedNames(state.module, program, reachedNames, state.scope)

	for (let binding of bound) {
		if (used.has(binding.localName)) {
			continue
		}

		let local = binding.entry.alias ?? binding.entry.name

		reportWarning(
			`'${binding.localName}' is imported and never used`,
			local.position,
			{
				code: "unused-import",
				labels: [primary(local.position, "nothing reads this name")],
				notes: unusedImportNotes(state.scope, binding.localName),
				helps: ["Remove the entry."],
				tags: ["unnecessary"],
			},
		)
	}
}

// What else counts as a use, for each kind the name binds that a file may use
// without spelling it. A Constant, a Function or any other Type is used only
// where it is written, which the label says already.
function unusedImportNotes(scope: enricher.Scope, name: string): Array<string> {
	let type = scope.types[name]
	let body = type?.type === "GenericAlias" ? type.aliasedType : type

	return [
		...(scope.protocols[name] === undefined
			? []
			: [
					"A Protocol counts as used where this file names it or calls a Method it provides.",
				]),
		...(scope.members[name]?.type === "Namespace"
			? [
					"A Namespace counts as used when a Method dispatches through it, even where the call never spells its name.",
				]
			: []),
		...(type === undefined || casesOf(type).length === 0
			? []
			: isDeclaration(type)
				? [
						"A Choice counts as used where this file names it, writes one of its Cases, or reaches a conformance it derives.",
					]
				: [
						"An Alias of a Choice counts as used where this file names it or writes one of its Cases.",
					]),
		...(body?.type === "Refinement"
			? [
					"A refinement counts as used where this file names it, or where a narrowing proves it of a value.",
				]
			: []),
	]
}

// The body's first Statement that is not a declaration. Inside a cycle, the
// order such Statements run in is not stated.
function sideEffectIn(module: Module): parser.ImplementationNode | null {
	for (let node of module.program.implementation.nodes) {
		if (declarationsOf(node).length === 0) {
			return node
		}
	}

	return null
}

function reportCyclicSideEffects(
	state: ModuleState,
	group: Array<Module>,
): void {
	let node = sideEffectIn(state.module)

	if (node === null) {
		return
	}

	let others = group
		.filter((module) => module.filePath !== state.module.filePath)
		.map((module) => specifierTo(state.module.filePath, module.filePath))

	reportWarning(
		"This Statement runs in an order the cycle does not state",
		node.position,
		{
			code: "cyclic-side-effects",
			labels: [
				primary(node.position, "this runs when the Module body runs"),
			],
			notes: [
				`This Module is in a cycle with ${others.join(", ")}.`,
				"A Module body runs once, on first import. Inside a cycle there is no first — whichever Module is reached first runs first, and that is decided by the entry point rather than by any of them.",
			],
			helps: [
				"Break the cycle, or move the Statement into a Module outside it.",
			],
		},
	)
}

// Namespaces that the Modules this one reaches export, and that no name here
// reaches. A Module the import block names comes first, under the specifier it
// wrote. One reached only through another, as a re-export's source is, follows
// in path order. An unknown Method's Help offers to import one.
function unimportedNamespacesFor(
	state: ModuleState,
	surfaces: Map<string, ExportSurface>,
	dependencies: Map<string, Array<string>>,
): Array<enricher.UnimportedNamespace> {
	let candidates: Array<enricher.UnimportedNamespace> = []
	let seen = new Set<string>([state.module.filePath])
	let reached = [...state.module.resolutions.values()]
	let transitive: Array<string> = []

	while (reached.length > 0) {
		for (let next of dependencies.get(reached.pop()!) ?? []) {
			if (!transitive.includes(next)) {
				transitive.push(next)
				reached.push(next)
			}
		}
	}

	let modules: Array<[string, string]> = [
		...state.module.resolutions,
		...transitive
			.sort()
			.map((modulePath): [string, string] => [
				specifierTo(state.module.filePath, modulePath),
				modulePath,
			]),
	]

	for (let [specifier, dependencyPath] of modules) {
		let surface = surfaces.get(dependencyPath)

		if (surface === undefined || seen.has(dependencyPath)) {
			continue
		}

		seen.add(dependencyPath)

		for (let [name, value] of Object.entries(surface.values)) {
			if (value.type !== "Namespace" || isTaken(state.scope, name)) {
				continue
			}

			candidates.push({
				name,
				specifier,
				modulePath: dependencyPath,
				namespace: value,
			})
		}
	}

	return candidates
}

// The reachable Modules that declare a Protocol of this name, private ones too,
// or publish one under it. Ordered by path, so Diagnostics do not depend on the
// entry.
function protocolDeclarationsFor(
	state: ModuleState,
	name: string,
	declarations: Map<string, Map<string, Declaration>>,
	dependencies: Map<string, Array<string>>,
	states: Map<string, ModuleState>,
	surfaces: Map<string, ExportSurface>,
): Array<enricher.ProtocolDeclaration> {
	let reached = new Set<string>()
	let pending = [...state.module.dependencies]

	while (pending.length > 0) {
		let modulePath = pending.pop()!

		if (!reached.has(modulePath)) {
			reached.add(modulePath)
			pending.push(...(dependencies.get(modulePath) ?? []))
		}
	}

	let found: Array<enricher.ProtocolDeclaration> = []

	for (let modulePath of [...reached].sort()) {
		let local = declarations.get(modulePath)

		if (local === undefined || modulePath === state.module.filePath) {
			continue
		}

		let published = publishedProtocols(
			local,
			surfaces.get(modulePath) ?? null,
			states.get(modulePath) ?? null,
		)

		if (published === null) {
			continue
		}

		if (local.get(name)?.kind === "protocol") {
			found.push({
				modulePath,
				declares: true,
				exportedAs: publishedName(name, published.get(name) ?? []),
			})
		} else if (
			[...published.values()].some((names) => names.includes(name))
		) {
			found.push({ modulePath, declares: false, exportedAs: name })
		}
	}

	return found
}

// The public names of each Protocol a Module declares. A surface is matched on
// Position, since a standard library Protocol's identity carries no path. Null
// for a Module neither linked nor being linked.
function publishedProtocols(
	local: Map<string, Declaration>,
	surface: ExportSurface | null,
	state: ModuleState | null,
): Map<string, Array<string>> | null {
	let published = new Map<string, Array<string>>()
	let add = (declaredName: string, publicName: string) =>
		published.set(declaredName, [
			...(published.get(declaredName) ?? []),
			publicName,
		])

	if (surface !== null) {
		for (let [publicName, kind] of Object.entries(surface.kinds)) {
			let position = surface.declarations[publicName]
			let declared = [...local].find(
				([, declaration]) =>
					kind === "protocol" &&
					!surface.forwarded.has(publicName) &&
					declaration.kind === "protocol" &&
					position !== undefined &&
					declaration.position.start.line === position.start.line &&
					declaration.position.start.column === position.start.column,
			)

			if (declared !== undefined) {
				add(declared[0], publicName)
			}
		}

		return published
	}

	if (state === null) {
		return null
	}

	for (let [publicName, entry] of state.exports) {
		if (
			entry.source === null &&
			local.get(entry.name.content)?.kind === "protocol"
		) {
			add(entry.name.content, publicName)
		}
	}

	return published
}

// The name an import is told to use: the declared name where it is published,
// otherwise the first public name.
function publishedName(
	declaredName: string,
	publicNames: Array<string>,
): string | null {
	return publicNames.includes(declaredName)
		? declaredName
		: (publicNames[0] ?? null)
}
