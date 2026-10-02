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
import { enrichPrograms, topLevelScope } from "../enricher/index"
import {
	invalidateNamespacesInScope,
	printableProtocolName,
} from "../enricher/resolvers"
import { countTypeDeclaration } from "../enricher/scope"
import { derivedPrintableNamespaceName } from "../helpers/conformance"
import { specifierTo } from "../helpers/describe"
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

// What a top-level declaration was written as. A Variable can not be
// exported, and a Constant can not be imported across a cycle. Every other
// kind hoists.
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
function topLevelDeclarations(
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
	state: "pending" | "bound" | "refused"
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
}

// Whether the emitted JavaScript binds a published name. Type Aliases, Choices
// and Protocols erase. It asks `values` rather than the kind, since a
// `type Rectangle` beside a `namespace Rectangle` still emits a class.
function isRuntimeName(surface: ExportSurface | null, name: string): boolean {
	return surface !== null && surface.values[name] !== undefined
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
									type: boundEntryType(
										state.scope,
										binding.localName,
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
// the Namespace Type's own `name`. Nothing else may key off that name.
function underLocalName(type: common.Type, localName: string): common.Type {
	return type.type === "Namespace" ? { ...type, name: localName } : type
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
	source: parser.IdentifierNode,
	specifier: string,
	declaration: Declaration | null,
	surface: ExportSurface,
): void {
	if (declaration !== null) {
		let alias = exportedAs(surface, declaration)
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
						? `${specifier} exports it as '${alias}' — import that name instead.`
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
		}

		// The builtins a fresh top level Scope binds join the registry
		// before anything of the Module's own is declared.
		for (let protocol of Object.values(state.scope.protocols)) {
			protocols.set(protocol.identity, protocol)
		}

		state.scope.protocolRegistry = protocols
		state.scope.programTop = true
		state.scope.unimportedNamespaces = () =>
			unimportedNamespacesFor(state, surfaces)
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

	let seedRound = (final: boolean): boolean => {
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
			annotationsFor:
				annotationsIndex === -1 ? undefined : annotationsIndex,
		},
	)

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
				...moduleSections(state, surface, surfaceFor),
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
			let value = state.scope.members[exportedName]

			if (value !== undefined) {
				surface.values[publicName] = value

				if (state.scope.constants.has(exportedName)) {
					surface.constants.add(publicName)
				}
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

		if (dependency.constants.has(exportedName)) {
			surface.constants.add(publicName)
		}

		let declaration = dependency.declarations[exportedName]

		if (declaration !== undefined) {
			surface.declarations[publicName] = declaration
		}
	}

	visiting.delete(filePath)

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
): boolean {
	let bound = false

	for (let binding of state.imports) {
		if (binding.state === "refused") {
			continue
		}

		let { entry, localName, dependencyPath } = binding
		let rebinding = binding.state === "bound"

		if (dependencyPath === null) {
			binding.state = "refused"

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
			if (!rebinding) {
				binding.state = "refused"
			}

			continue
		}

		let exportedName = entry.name.content
		let kind = surface.kinds[exportedName]

		if (kind === undefined) {
			if (rebinding) {
				continue
			}

			reportMissingExport(
				entry.name,
				entry.source.path,
				declares(dependencyPath, exportedName),
				surface,
			)
			bindAsError(state.scope, localName, entry.name.position)
			binding.state = "refused"

			continue
		}

		// A Constant does not hoist, so across a cycle its ESM binding may be
		// read in its temporal dead zone.
		if (kind === "constant" && states.has(dependencyPath)) {
			reportCyclicConstantImport(entry)
			bindAsError(state.scope, localName, entry.name.position)
			binding.state = "refused"

			continue
		}

		let tables = tablesOffered(surface, exportedName)

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

// An entry still pending names an export that never resolved, which its own
// Module reported. Its name is bound as an Error.
function refuseUnboundImports(state: ModuleState): void {
	for (let binding of state.imports) {
		if (binding.state !== "pending") {
			continue
		}

		binding.state = "refused"

		if (!isTaken(state.scope, binding.localName)) {
			bindAsError(
				state.scope,
				binding.localName,
				binding.entry.name.position,
			)
		}
	}
}

function reportCyclicConstantImport(entry: parser.ImportNode): void {
	reportError(
		`Constant '${entry.name.content}' is imported across a cycle`,
		entry.name.position,
		{
			code: "cyclic-constant-import",
			labels: [
				primary(
					entry.name.position,
					"this Constant is not readable here",
				),
			],
			notes: [
				`${entry.source.path} imports this Module back, directly or through further Modules.`,
				"A Function, a Type Alias, a Choice, a Protocol and a Namespace are all hoisted, so a cycle can name any of them. A Constant is not: its value exists only once its Module's body has run, and inside a cycle which body runs first is not something the source states.",
			],
			helps: [
				"Move the Constant into a Module outside the cycle, or expose it as a Function.",
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
					entry.name,
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
		let isProtocol =
			state.scope.protocols[binding.localName] !== undefined &&
			state.scope.members[binding.localName] === undefined

		reportWarning(
			`'${binding.localName}' is imported and never used`,
			local.position,
			{
				code: "unused-import",
				labels: [primary(local.position, "nothing reads this name")],
				notes: [
					isProtocol
						? "A Protocol counts as used where this file names it or calls a Method it provides."
						: "A Namespace counts as used when a Method dispatches through it, even where the call never spells its name.",
				],
				helps: ["Remove the entry."],
				tags: ["unnecessary"],
			},
		)
	}
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

// Namespaces that dependencies the Module already names export, and that no
// name here reaches. An unknown Method's Help offers to import one.
function unimportedNamespacesFor(
	state: ModuleState,
	surfaces: Map<string, ExportSurface>,
): Array<enricher.UnimportedNamespace> {
	let candidates: Array<enricher.UnimportedNamespace> = []
	let seen = new Set<string>()

	for (let [specifier, dependencyPath] of state.module.resolutions) {
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
