import * as path from "node:path"

import type { common, enricher, parser } from "@essence-lang/interfaces"

import {
	collectDiagnostics,
	primary,
	reportError,
	reportWarning,
	secondary,
} from "../diagnostics/index"
import { enrichPrograms, topLevelScope } from "../enricher/index"
import { invalidateNamespacesInScope } from "../enricher/resolvers"
import { patternBindings } from "../helpers/index"
import type { Module, ModuleGraph } from "./graph"

// NOTE: What a top level declaration was written as, which is what decides the
// two Diagnostics that turn on the kind rather than on the Type: a Variable can
// not be exported at all, and a Constant can not be imported across a cycle.
// Everything else — a Function, a Namespace, a Type Alias, a Choice, a Protocol —
// hoists, and hoisting is exactly what makes a cycle work.
export type DeclaredKind =
	| "constant"
	| "variable"
	| "function"
	| "namespace"
	| "type"
	| "choice"
	| "protocol"

type Declaration = {
	kind: DeclaredKind
	position: common.Position
}

// NOTE: What a Module offers the Modules that import it, keyed by the name it is
// exported UNDER — `as` is applied here, so an importer never has to know what
// the declaration was called at home.
//
// `kinds` is the export list itself: a name is exported exactly when it has an
// entry there. The tables beside it hold what the name RESOLVED to, and one of
// them may still be empty while a cycle is being hoisted — which is the
// difference between "this Module does not export that" and "it does, but not
// yet". One entry carries its name across every table it is bound in, so a
// `type Foo` and a Namespace `Foo` travel together.
export type ExportSurface = {
	values: Record<string, common.Type>
	types: Record<string, common.Type>
	protocols: Record<string, common.ProtocolType>
	declarations: Record<string, common.Position>
	constants: Set<string>
	kinds: Record<string, DeclaredKind>
}

export type LinkedModule = {
	module: Module
	program: common.typed.Program
	// NOTE: This Module's own Diagnostics, in stage order: what the graph found
	// about its specifiers, what linking found about its entries, what enrichment
	// found in its body, and what the export block and the unused entries came to
	// last. Collected per Module because the dedup key carries no file — one
	// shared collection would swallow a second Module's identical error.
	diagnostics: Array<common.Diagnostic>
	surface: ExportSurface
	// NOTE: The written annotations paired with what each resolved to — empty
	// unless this is the Module `annotationsFor` asked about. Only a Hover ever
	// wants them, and only for the file under the cursor.
	annotations: Array<common.TypeAnnotation>
}

export type LinkedGraph = {
	entryPath: string
	// NOTE: Dependency-first, the entry last — the graph's order, kept, because
	// it is the order the Module bodies run in.
	modules: Map<string, LinkedModule>
	diagnostics: Array<common.Diagnostic>
}

function emptySurface(): ExportSurface {
	return {
		values: {},
		types: {},
		protocols: {},
		declarations: {},
		constants: new Set(),
		kinds: {},
	}
}

// NOTE: A list rather than one entry, because a Declaration whose name is a
// Pattern declares as many names as the Pattern binds. This runs BEFORE the
// Enricher, so the desugar that turns those into Constants everywhere else has
// not happened yet and can not be waited for — which is exactly why the names
// are read off the Pattern here instead.
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

// NOTE: Read off the AST rather than off the Scope, because both questions it
// answers have to be answerable before anything has been enriched: whether an
// import collides with a declaration this file makes, and what kind a name was
// declared as. Only the FIRST declaration of a name is kept — a second one is a
// duplicate that never reaches Scope, so it is not what an export of that name
// would forward either.
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

// NOTE: The export block by the name each entry publishes under. A second entry
// publishing a name is dropped rather than reported: what it would collide with
// is another entry of the same block, which the Formatter writes side by side.
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

// NOTE: The canonical order of an import block: by specifier, then by name, then
// by the local name — never the order the entries were written in. It is the
// order `esfmt` writes the block in (`compareImportEntries`), and Namespace
// dispatch is seeded in it, so re-sorting a block can never change which
// Namespace a Method call resolves to. Compared by code unit rather than by
// locale, so every machine agrees.
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

// NOTE: How a Diagnostic names another Module: the specifier an entry in THIS
// one would write for it. A canonical path is what the Compiler keys on and is
// the one thing a report must not print — it names a place on the machine that
// compiled, so it would differ per checkout and per reader.
function specifierTo(importerPath: string, filePath: string): string {
	let relative = path
		.relative(path.dirname(importerPath), filePath)
		.split(path.sep)
		.join("/")

	return relative.startsWith("../") ? relative : `./${relative}`
}

type ImportBinding = {
	entry: parser.ImportNode
	localName: string
	// NOTE: The canonical path the entry's specifier resolved to, or null when it
	// resolved to nothing at all — the graph reported that already, and this
	// entry is left alone rather than reported about twice.
	dependencyPath: string | null
	state: "pending" | "bound" | "refused"
}

type ModuleState = {
	module: Module
	scope: enricher.Scope
	declarations: Map<string, Declaration>
	exports: Map<string, parser.ExportNode>
	imports: Array<ImportBinding>
	diagnostics: Array<common.Diagnostic>
}

// NOTE: Whether a name the surface publishes is one the emitted JavaScript
// binds. A Type Alias, a Choice and a Protocol erase — the Rewriter emits an
// empty Statement where each was declared — so an entry naming one must carry
// no ESM binding, or the bundle would import a name the dependency's JavaScript
// never exports; a Case needs none of its own either, since its tag is a String
// Literal. The question is asked of the `values` table rather than of the
// declared KIND because one name travels across every table it is bound in: a
// `type Rectangle` beside a `namespace Rectangle` is declared as a Type first
// and is a class in the emitted output all the same.
function isRuntimeName(surface: ExportSurface | null, name: string): boolean {
	return surface !== null && surface.values[name] !== undefined
}

// NOTE: The two sections as the emitted Program needs them, attached to the
// typed Program linking hands back. Enrichment leaves both null: whether an
// entry names something the JavaScript binds is read off the other Module's
// export surface, and enrichment never sees one.
//
// Only an entry that bound is carried. One that did not names something the
// Module can not reach, which is a Diagnostic already — and code generation
// never runs over a Module that reported one.
// NOTE: What a Hover over an entry prints — the member bound under the local
// name, or the Type where only a Type came across. A name bound in both tables
// answers with the member, which is what the name means in expression position.
function boundEntryType(
	scope: enricher.Scope,
	name: string,
): common.Type | null {
	return scope.members[name] ?? scope.types[name] ?? null
}

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

// NOTE: A Namespace import binds a shallow COPY carrying the local name, because
// the emitted Method call reads the Namespace Type's own `name` — an alias that
// stopped at the Scope would emit a reference to a name the bundle never binds.
// Nothing else may key off that name.
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
	}

	let protocol = surface.protocols[exportedName]

	if (protocol !== undefined) {
		scope.protocols[localName] = protocol
	}

	// NOTE: The import entry, never the declaration in the other file: a
	// Diagnostic about a use is rendered against THIS Module's source, and a
	// Position from another file would point into the wrong text entirely.
	scope.declarations[localName] = position
}

// NOTE: What is left of an entry that has been reported about: the local name
// bound to an Error, so that every use of it in this Module stays quiet. Without
// it one refused entry becomes a file's worth of `unknown-name` about a name the
// reader can see written at the top, and the one Diagnostic that says what is
// actually wrong is buried under them.
//
// Both tables, because the kind an entry was after is often exactly what could
// not be established — and an Error in a table nothing reads costs nothing,
// while a missing one costs a cascade. Protocols are left out: their slot takes
// a Protocol Type rather than a Type, and a Protocol always hoists in the first
// round, so an entry naming one is never left waiting.
function bindAsError(
	scope: enricher.Scope,
	localName: string,
	position: common.Position,
): void {
	scope.members[localName] = { type: "Error" }
	scope.types[localName] = { type: "Error" }
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

function reportMissingExport(
	source: parser.IdentifierNode,
	specifier: string,
	declared: boolean,
): void {
	if (declared) {
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
				notes: [
					"A name is private unless the Module's 'export { … }' block lists it.",
				],
				helps: [
					`Add '${source.content}' to the 'export { … }' block of ${specifier}.`,
				],
			},
		)

		return
	}

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
				"Check the spelling, and that the specifier names the file you meant.",
			],
		},
	)
}

export function linkModuleGraph(
	graph: ModuleGraph,
	options: {
		// NOTE: The canonical path of the one Module whose written annotations
		// are wanted alongside its typed Program — the Hover seam.
		annotationsFor?: string
		// NOTE: The Scope each Module is linked into, when the default is wrong.
		// Two things make it wrong for the standard library. It must carry NO
		// `modulePath`, because that is what names a Choice
		// `<modulePath>#<Name>` — and a builtin Choice is named by its bare name,
		// which the runtime switches on. And it must not start from
		// `builtinMembers()`, which `topLevelScope` reads: the standard library
		// IS the builtins, and asking for them while loading them is unbounded
		// recursion, since the cache is only filled once the load returns.
		scopeFor?: (module: Module) => enricher.Scope
	} = {},
): LinkedGraph {
	// NOTE: Every Module's declarations up front, because a Diagnostic about an
	// entry has to tell "that Module does not export this" from "that Module has
	// no such name" — and the second question is about a file the entry's own
	// Module knows nothing else about.
	let declarations = new Map<string, Map<string, Declaration>>()

	for (let [filePath, module] of graph.modules) {
		declarations.set(filePath, topLevelDeclarations(module.program))
	}

	let surfaces = new Map<string, ExportSurface>()
	let linked = new Map<string, LinkedModule>()

	for (let group of graph.groups) {
		for (let result of linkGroup(
			group,
			declarations,
			surfaces,
			options.annotationsFor,
			options.scopeFor,
		)) {
			surfaces.set(result.module.filePath, result.surface)
			linked.set(result.module.filePath, result)
		}
	}

	return {
		entryPath: graph.entryPath,
		modules: linked,
		diagnostics: graph.diagnostics,
	}
}

// NOTE: One group is one hoisting pass. For a lone Module every dependency is
// linked already and its whole import block is seeded before anything is
// resolved; for a cycle the entries naming a Module of the same group can not be,
// because the declaration they name has not been hoisted yet — so they are
// offered again between the hoist rounds, which is what lets a Function in one
// Module take a Type declared in another that takes something back.
function linkGroup(
	group: Array<Module>,
	declarations: Map<string, Map<string, Declaration>>,
	surfaces: Map<string, ExportSurface>,
	annotationsFor?: string,
	scopeFor?: (module: Module) => enricher.Scope,
): Array<LinkedModule> {
	let states = new Map<string, ModuleState>()
	let declares = (filePath: string, name: string): boolean =>
		declarations.get(filePath)?.has(name) ?? false

	for (let module of group) {
		let state: ModuleState = {
			module,
			scope:
				scopeFor?.(module) ??
				topLevelScope({ modulePath: module.filePath }),
			declarations: declarations.get(module.filePath) ?? new Map(),
			exports: exportedEntries(module.program),
			imports: [],
			diagnostics: [],
		}

		state.scope.unimportedNamespaces = () =>
			unimportedNamespacesFor(state, surfaces)

		for (let entry of [...(module.program.imports?.entries ?? [])].sort(
			compareEntries,
		)) {
			state.imports.push({
				entry,
				localName: (entry.alias ?? entry.name).content,
				dependencyPath:
					module.resolutions.get(entry.source.path) ?? null,
				state: "pending",
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

	// NOTE: Once before the hoist, so a lone Module — whose dependencies are all
	// linked and final — has its whole block in Scope before a single declaration
	// is resolved, and again from inside the hoist for the entries only a cycle
	// leaves pending.
	seedRound(false)

	let annotationsIndex = [...states.values()].findIndex(
		(state) => state.module.filePath === annotationsFor,
	)

	let enriched = enrichPrograms(
		[...states.values()].map((state) => ({
			program: state.module.program,
			scope: state.scope,
		})),
		{
			seedRound,
			annotationsFor:
				annotationsIndex === -1 ? undefined : annotationsIndex,
		},
	)

	return [...states.values()].map((state, index) => {
		let { diagnostics } = collectDiagnostics(() => {
			reportExportProblems(state, declares, surfaceFor)
			reportUnusedImports(state, enriched[index]!.program)

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
		}
	})
}

// NOTE: The surface of a Module already linked is final and simply read back; a
// Module of the group being linked is asked to build one out of whatever its
// Scope holds right now, which is what the seeding between the hoist rounds
// consults. `visiting` closes a re-export chain that leads back into the group —
// two facades forwarding each other's names is a cycle like any other, and
// forwarding what is not there yet is what an unfinished group looks like.
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

		let forwardedValue = dependency.values[exportedName]

		if (forwardedValue !== undefined) {
			surface.values[publicName] = forwardedValue
		}

		let forwardedType = dependency.types[exportedName]

		if (forwardedType !== undefined) {
			surface.types[publicName] = forwardedType
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

// NOTE: Every entry that can be bound now, bound. Answers whether anything new
// was — which is what keeps the hoist rounds going through a cycle. An entry that
// names something the dependency does not export is reported and refused on the
// first pass: that answer can not change, because an export list is read off the
// AST rather than resolved.
function seedImports(
	state: ModuleState,
	states: Map<string, ModuleState>,
	declares: (filePath: string, name: string) => boolean,
	surfaceFor: (filePath: string) => ExportSurface | null,
): boolean {
	let bound = false

	for (let binding of state.imports) {
		if (binding.state !== "pending") {
			continue
		}

		let { entry, localName, dependencyPath } = binding

		if (dependencyPath === null) {
			binding.state = "refused"

			continue
		}

		// NOTE: This Module's own declarations are read off the AST rather than
		// off the Scope, so a collision with one is reported on the FIRST pass —
		// before hoisting has put it in Scope, and before the import could shadow
		// it. Refusing the entry is what keeps the report to one Diagnostic: the
		// local declaration then lands in an empty slot and is not a duplicate of
		// anything.
		if (
			state.declarations.has(localName) ||
			isTaken(state.scope, localName)
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
			binding.state = "refused"

			continue
		}

		let exportedName = entry.name.content
		let kind = surface.kinds[exportedName]

		if (kind === undefined) {
			reportMissingExport(
				entry.name,
				entry.source.path,
				declares(dependencyPath, exportedName),
			)
			bindAsError(state.scope, localName, entry.name.position)
			binding.state = "refused"

			continue
		}

		// NOTE: A Constant does not hoist, so across a cycle there is no moment
		// at which its value exists and the importer has not run — the emitted
		// ESM binding is in its temporal dead zone. Reported here rather than
		// left to the runtime, and the name is bound as an Error so that the
		// Module reads as one mistake instead of one per use.
		if (kind === "constant" && states.has(dependencyPath)) {
			reportCyclicConstantImport(entry)
			bindAsError(state.scope, localName, entry.name.position)
			binding.state = "refused"

			continue
		}

		if (
			surface.values[exportedName] === undefined &&
			surface.types[exportedName] === undefined &&
			surface.protocols[exportedName] === undefined
		) {
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
		bound = true
	}

	return bound
}

// NOTE: What is still pending once the rounds are over names something that IS
// exported and never resolved — the Module declaring it reported why, so nothing
// is said here a second time. The name is seeded as an Error for the same reason
// a cyclic Constant is.
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

// NOTE: Both mistakes an export block can make on its own: a name this Module
// never declared, and a Variable — mutable state one Module writes and another
// reads is not something a `from` clause can express. A re-export is checked
// against the Module it forwards from, under the same two codes an import is.
function reportExportProblems(
	state: ModuleState,
	declares: (filePath: string, name: string) => boolean,
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
				)
			}

			continue
		}

		let declared = state.declarations.get(entry.name.content)

		if (declared === undefined) {
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
					helps: [
						`Write '${entry.name.content} from "…"' to forward it from the Module that declares it.`,
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
					helps: [
						"Declare it as a Constant, or export a Function that answers with its value.",
					],
				},
			)
		}
	}
}

// NOTE: Every name this Module's body reads, over-collected on purpose. An
// `unused-import` Warning that fires on a name the Module does use is worse than
// one that stays silent, so a Method name that happens to be spelled like an
// import counts as a use — while every shape that genuinely IS one is covered.
//
// Two trees, because neither alone holds the answer. The written one carries the
// Type positions: an imported Type named in an annotation resolves to a Type
// object and leaves no Identifier in the typed tree at all. The typed one carries
// implicit dispatch: `rect::area()` never spells `RectangleMeasurable`, and the
// only trace of it is the Namespace name on the resolved Invocation — which is
// the LOCAL name, because a Namespace import binds a copy carrying it.
function usedNames(module: Module, program: common.typed.Program): Set<string> {
	let names = new Set<string>()

	let visit = (node: unknown): void => {
		if (Array.isArray(node)) {
			for (let entry of node) {
				visit(entry)
			}

			return
		}

		if (node === null || typeof node !== "object") {
			return
		}

		let record = node as Record<string, unknown>

		if (
			record["nodeType"] === "Identifier" &&
			typeof record["content"] === "string"
		) {
			names.add(record["content"])
		}

		if (record["nodeType"] === "MethodInvocation") {
			let namespace = record["namespace"] as
				| Record<string, unknown>
				| undefined

			if (typeof namespace?.["name"] === "string") {
				names.add(namespace["name"])
			}
		}

		// NOTE: A Union receiver's per-member branch, and a Protocol conformance
		// witness — the two shapes that name a Namespace without an Invocation of
		// their own to hang it off.
		if (typeof record["namespaceName"] === "string") {
			names.add(record["namespaceName"])
		}

		if (
			record["kind"] === "namespace" &&
			typeof record["name"] === "string"
		) {
			names.add(record["name"])
		}

		for (let value of Object.values(record)) {
			visit(value)
		}
	}

	visit(module.program.implementation)
	visit(program)

	return names
}

function reportUnusedImports(
	state: ModuleState,
	program: common.typed.Program,
): void {
	let bound = state.imports.filter((binding) => binding.state === "bound")

	if (bound.length === 0) {
		return
	}

	let used = usedNames(state.module, program)

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
				notes: [
					"A Namespace counts as used when a Method dispatches through it, even where the call never spells its name.",
				],
				helps: ["Remove the entry."],
				tags: ["unnecessary"],
			},
		)
	}
}

// NOTE: The first thing this Module's body does that is not a declaration. A
// hoisted declaration is in place before any body runs, and a Constant or
// Variable is only reachable from another Module through an import, which
// `cyclic-constant-import` answers for — everything else is a Statement that
// simply happens, and inside a cycle the order those happen in is not something
// the source states.
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

// NOTE: The Namespaces this Module's dependencies export and it has not brought
// in, which is what turns "no such Method" into "you did not import the Namespace
// that declares it". Only the dependencies it ALREADY names are asked: their
// specifiers are written in the file, so the help names a path the reader can
// see, and the Quick Fix has one to insert.
//
// "Not brought in" is "not reachable by that name here" — a local declaration of
// the name shadows the offer as surely as an import of it satisfies it.
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

			candidates.push({ name, specifier, namespace: value })
		}
	}

	return candidates
}
