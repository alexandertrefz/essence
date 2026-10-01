import type { common, parser } from "@essence-lang/interfaces"

import {
	collectDiagnostics,
	placelessDiagnostic,
	primary,
	reportError,
} from "../diagnostics/index"
import { parseDocument } from "../documents"
import type { ModuleHost } from "./host"
import {
	canonicalPath,
	resolveSpecifier,
	type SpecifierRejection,
	type SpecifierResolution,
	type SpecifierResolver,
} from "./resolve"

// One file, parsed once, named by its canonical path. `sourceText` travels
// with it because an unsaved document can not be read back to render an
// excerpt.
export type Module = {
	filePath: string
	sourceText: string
	program: parser.Program
	// Its parse and resolution Diagnostics. Each Module collects its own, since
	// `report` would drop another file's equal Diagnostic as a duplicate.
	diagnostics: Array<common.Diagnostic>
	// Canonical paths, in the order the entries first name them. A re-export
	// is a dependency too.
	dependencies: Array<string>
	// Keyed by the specifier as written, so an entry finds its Module without
	// resolving again. A specifier that named no Module is absent.
	resolutions: Map<string, string>
}

export type ModuleGraph = {
	entryPath: string
	// In insertion order, dependencies first and the entry last. A cycle has no
	// order inside it.
	modules: Map<string, Module>
	// The same Modules as strongly connected components. A cycle is one group,
	// which is enriched as a whole.
	groups: Array<Array<Module>>
	// What belongs to no Module, which is an entry that could not be read.
	diagnostics: Array<common.Diagnostic>
}

// A refusal's Help depends on the specifier's section and the names under it.
type WrittenSpecifier = {
	source: parser.ModuleSpecifierNode
	section: "import" | "export"
	names: Array<string>
}

// One specifier per group, imports first, in written order.
function specifiersOf(program: parser.Program): Array<WrittenSpecifier> {
	return [
		...(program.imports?.groups ?? []).map((group) => ({
			source: group.source,
			section: "import" as const,
			names: group.entries.map((entry) => entry.name.content),
		})),
		...(program.exports?.groups ?? []).map((group) => ({
			source: group.source,
			section: "export" as const,
			names: group.entries.map((entry) => entry.name.content),
		})),
	]
}

// Files Essence can not import. The interop runs the other way, so the Help
// for one says to embed the Program rather than to rename the file.
const javaScriptExtensions = [
	".js",
	".mjs",
	".cjs",
	".jsx",
	".ts",
	".mts",
	".cts",
	".tsx",
]

// `Write '<specifier>.es'` is offered only where this finds no extension,
// since `./data.json.es` is nobody's file.
function extensionOf(specifier: string): string | null {
	let name = specifier.slice(specifier.lastIndexOf("/") + 1)
	let dot = name.lastIndexOf(".")

	return dot <= 0 ? null : name.slice(dot)
}

function reportRejection(
	reason: SpecifierRejection,
	written: WrittenSpecifier,
): void {
	let { source, section, names } = written
	let specifier = source.path
	let position = source.position

	switch (reason) {
		case "absolute":
			reportError(
				`Module specifier '${specifier}' is an absolute path`,
				position,
				{
					code: "invalid-module-specifier",
					labels: [
						primary(
							position,
							"a specifier is a path relative to this Module",
						),
					],
					notes: [
						"An absolute path names a place on the machine it was written on, so a checkout that moves stops compiling.",
					],
					helps: [
						"Write the path from this Module to the file, beginning with './' or '../' and ending in '.es'.",
					],
				},
			)

			return

		case "not-relative":
			reportError(
				`Module specifier '${specifier}' is not a relative path`,
				position,
				{
					code: "invalid-module-specifier",
					labels: [
						primary(
							position,
							"a specifier is a path relative to this Module",
						),
					],
					notes: [
						"Package specifiers are reserved: today a Module names its dependencies by where they sit relative to it, and nothing is searched for.",
					],
					// A specifier without '.es' here is a package name, so the
					// Help asks for the extension as well as the './'.
					helps: [
						specifier.endsWith(".es")
							? `Write './${specifier}' if the file sits beside this one.`
							: "Write the path from this Module to the file, beginning with './' or '../' and ending in '.es'.",
					],
				},
			)

			return

		case "missing-extension":
			reportError(
				`Module specifier '${specifier}' does not name a '.es' file`,
				position,
				{
					code: "invalid-module-specifier",
					labels: [
						primary(position, "the extension is part of the path"),
					],
					notes: [
						"A specifier is read exactly as written — no extension is appended and no directory is tried — so what it names is what is read.",
					],
					// Appending '.es' is right only for a specifier with no
					// extension. The other Helps state a fact that no quick fix
					// could read as an edit.
					helps: [
						specifier.endsWith("/")
							? "Name the file itself, ending in '.es'."
							: javaScriptExtensions.includes(
										extensionOf(specifier) ?? "",
								  )
								? "Essence imports '.es' Modules and nothing else — reach a JavaScript file from the JavaScript side instead, by embedding this Program with 'essence build --embed'."
								: extensionOf(specifier) === null
									? `Write '${specifier}.es'.`
									: "Name a '.es' Module — an import block reads no other kind of file.",
					],
				},
			)

			return

		case "standard-library":
			reportError("The standard library is not importable", position, {
				code: "invalid-module-specifier",
				labels: [
					primary(
						position,
						"this path names a standard library source",
					),
				],
				notes: [
					"The standard library is one shared declaration space rather than a graph of Modules, and everything it declares is already in scope in every Program.",
				],
				// The whole group, since an entry is a name and removing one
				// leaves the specifier and this report.
				helps: [
					`Remove the whole 'from "${specifier}" { … }' group — every name it asks for is a builtin.`,
				],
			})

			return

		case "self-import":
			reportError("A Module can not import itself", position, {
				code: "self-import",
				labels: [
					primary(
						position,
						"this path names the file it is written in",
					),
				],
				notes: [
					"Everything a Module declares is in scope inside it already, whether or not it is exported.",
				],
				// An import group asks for names already in scope, so it goes.
				// An export group publishes this Module's own names, which it
				// writes bare instead.
				helps: [
					section === "import"
						? `Remove the whole 'from "${specifier}" { … }' group — every name it asks for is in scope here already.`
						: names.length === 1
							? `Write '${names[0]}' as a bare entry: 'export { ${names[0]} }'.`
							: "Write the names as bare entries in the 'export { … }' block — this Module declares them itself.",
				],
			})

			return
	}
}

function reportMissingModule(
	source: parser.ModuleSpecifierNode,
	filePath: string,
): void {
	reportError(`No Module was found at '${source.path}'`, source.position, {
		code: "module-not-found",
		labels: [primary(source.position, "nothing could be read here")],
		notes: [`The specifier resolves to '${filePath}'.`],
		helps: [
			"Check the spelling of the path, and that the file is saved where it says.",
		],
	})
}

// One resolution per distinct specifier text, but one Diagnostic per written
// specifier, since each is a mistake to underline.
function resolveDependencies(
	module: Module,
	readModule: (filePath: string) => Module | null,
	resolveFor: SpecifierResolver,
): Array<Module> {
	let resolutions = new Map<string, SpecifierResolution>()
	let dependencies: Array<Module> = []
	let named = new Set<string>()

	for (let written of specifiersOf(module.program)) {
		let source = written.source
		let resolution = resolutions.get(source.path)

		if (resolution === undefined) {
			resolution = resolveFor(source.path, module.filePath)
			resolutions.set(source.path, resolution)
		}

		if (resolution.kind === "rejected") {
			reportRejection(resolution.reason, written)

			continue
		}

		let dependency = readModule(resolution.filePath)

		if (dependency === null) {
			reportMissingModule(source, resolution.filePath)

			continue
		}

		module.resolutions.set(source.path, dependency.filePath)

		if (!named.has(dependency.filePath)) {
			named.add(dependency.filePath)
			dependencies.push(dependency)
		}
	}

	return dependencies
}

// Tarjan's algorithm, which closes a group only after everything it reaches.
// So the groups come out dependency-first, the order of enrichment and of
// running. Several roots reach files nothing imports.
function groupModules(
	roots: Array<Module>,
	loaded: Map<string, Module>,
): Array<Array<Module>> {
	let indices = new Map<string, number>()
	let lowLinks = new Map<string, number>()
	let stack: Array<Module> = []
	let stacked = new Set<string>()
	let groups: Array<Array<Module>> = []
	let nextIndex = 0

	let visit = (module: Module): void => {
		indices.set(module.filePath, nextIndex)
		lowLinks.set(module.filePath, nextIndex)
		nextIndex += 1
		stack.push(module)
		stacked.add(module.filePath)

		for (let dependencyPath of module.dependencies) {
			let dependency = loaded.get(dependencyPath)

			if (dependency === undefined) {
				continue
			}

			if (indices.has(dependencyPath)) {
				// One off the stack belongs to a closed group, which can not
				// reach this Module.
				if (stacked.has(dependencyPath)) {
					lowLinks.set(
						module.filePath,
						Math.min(
							lowLinks.get(module.filePath)!,
							indices.get(dependencyPath)!,
						),
					)
				}
			} else {
				visit(dependency)
				lowLinks.set(
					module.filePath,
					Math.min(
						lowLinks.get(module.filePath)!,
						lowLinks.get(dependencyPath)!,
					),
				)
			}
		}

		if (lowLinks.get(module.filePath) === indices.get(module.filePath)) {
			let group: Array<Module> = []

			while (true) {
				let member = stack.pop()!

				stacked.delete(member.filePath)
				group.push(member)

				if (member.filePath === module.filePath) {
					break
				}
			}

			// Reversed, so the Module reached first comes first.
			groups.push(group.reverse())
		}
	}

	for (let root of roots) {
		if (!indices.has(root.filePath)) {
			visit(root)
		}
	}

	return groups
}

// Every file reachable from the entry, parsed once and ordered. The host is
// asked for each file once, so a Module two importers reach is one Module.
export function loadModuleGraph(
	entryPath: string,
	host: ModuleHost,
): ModuleGraph {
	let entry = canonicalPath(entryPath)
	let loaded = new Map<string, Module>()
	let unreadable = new Set<string>()

	let readModule = (filePath: string): Module | null => {
		let module = loaded.get(filePath)

		if (module !== undefined) {
			return module
		}

		if (unreadable.has(filePath)) {
			return null
		}

		let sourceText = host.readFile(filePath)

		if (sourceText === undefined) {
			unreadable.add(filePath)

			return null
		}

		let document = parseDocument(sourceText, filePath)

		module = {
			filePath,
			sourceText,
			program: document.program,
			diagnostics: [...document.diagnostics],
			dependencies: [],
			resolutions: new Map(),
		}

		loaded.set(filePath, module)

		return module
	}

	let entryModule = readModule(entry)

	if (entryModule === null) {
		// Placeless, since the file to point into is the one that could not be
		// read.
		return {
			entryPath: entry,
			modules: new Map(),
			groups: [],
			diagnostics: [
				placelessDiagnostic(
					"error",
					`No Module was found at '${entry}'`,
					"module-not-found",
				),
			],
		}
	}

	resolveAll([entryModule], readModule, resolveSpecifier)

	let groups = groupModules([entryModule], loaded)

	return {
		entryPath: entry,
		modules: new Map(
			groups.flat().map((module) => [module.filePath, module]),
		),
		groups,
		diagnostics: [],
	}
}

// A work list rather than recursion, so each Module's entries resolve in its
// own collection rather than nested in its importer's.
function resolveAll(
	roots: Array<Module>,
	readModule: (filePath: string) => Module | null,
	resolveFor: SpecifierResolver,
): void {
	let pending = [...roots]
	let resolved = new Set<string>()

	while (pending.length > 0) {
		let module = pending.shift()!

		if (resolved.has(module.filePath)) {
			continue
		}

		resolved.add(module.filePath)

		let { result, diagnostics } = collectDiagnostics(() =>
			resolveDependencies(module, readModule, resolveFor),
		)

		module.dependencies = result.map((dependency) => dependency.filePath)
		module.diagnostics.push(...diagnostics)
		pending.push(...result)
	}
}

// A graph over Programs already parsed and in memory, as the standard library
// is, with the caller's resolver. Every entry is a root, since some files,
// such as `Prelude.es`, are imported by nothing.
export function loadModuleGraphOver(
	entries: Array<{
		filePath: string
		sourceText: string
		program: parser.Program
		diagnostics: Array<common.Diagnostic>
	}>,
	resolveFor: SpecifierResolver,
): ModuleGraph {
	let loaded = new Map<string, Module>(
		entries.map((entry) => [
			entry.filePath,
			{
				filePath: entry.filePath,
				sourceText: entry.sourceText,
				program: entry.program,
				diagnostics: [...entry.diagnostics],
				dependencies: [],
				resolutions: new Map(),
			},
		]),
	)

	let roots = entries.map((entry) => loaded.get(entry.filePath)!)

	resolveAll(roots, (filePath) => loaded.get(filePath) ?? null, resolveFor)

	let groups = groupModules(roots, loaded)

	return {
		entryPath: roots[0]?.filePath ?? "",
		modules: new Map(
			groups.flat().map((module) => [module.filePath, module]),
		),
		groups,
		diagnostics: [],
	}
}
