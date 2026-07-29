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

// NOTE: One file, parsed once, named by the one canonical spelling of its path.
// `sourceText` travels with the Module because every Diagnostic rendered against
// it needs the exact text it was parsed from — a Module the Language Server
// holds unsaved can not be read back off disk to render an excerpt.
export type Module = {
	filePath: string
	sourceText: string
	program: parser.Program
	// NOTE: This Module's parse Diagnostics and the resolution Diagnostics of
	// its own entries, and nothing else. Collected per Module because the dedup
	// key is severity, code, message and Position with no file: one shared
	// collection would silently swallow a second Module's identical error at the
	// same line.
	diagnostics: Array<common.Diagnostic>
	// NOTE: Canonical paths, in the order the entries first name them. Both
	// sections contribute — a facade whose only mention of a Module is a
	// re-export still depends on it.
	dependencies: Array<string>
	// NOTE: Keyed by the specifier exactly as it was written, so an Import or
	// Export entry finds the Module it names without resolving a second time. A
	// specifier that named no Module at all is absent.
	resolutions: Map<string, string>
}

export type ModuleGraph = {
	entryPath: string
	// NOTE: Dependency-first — insertion order IS the order, and the entry comes
	// last, because everything reachable is something it depends on. Every
	// Module a Module names is ahead of it, except across a cycle, where the
	// group is the unit and the order inside it is not something the source
	// states.
	modules: Map<string, Module>
	// NOTE: The same Modules, grouped into Strongly Connected Components. A group
	// holds more than one Module exactly when those Modules import each other,
	// and that group is what the single hoisting pass has to run over as a whole
	// — nothing inside a cycle can be enriched before the rest of it.
	groups: Array<Array<Module>>
	// NOTE: What belongs to no Module: the entry itself could not be read. Every
	// other Diagnostic here is positioned in some Module's own source and lives
	// on that Module.
	diagnostics: Array<common.Diagnostic>
}

// NOTE: Both sections, imports first, in written order. An Export entry carries
// a specifier only when it is a re-export.
function specifiersOf(
	program: parser.Program,
): Array<parser.ModuleSpecifierNode> {
	let imports = program.imports?.entries.map((entry) => entry.source) ?? []
	let reExports =
		program.exports?.entries.flatMap((entry) =>
			entry.source === null ? [] : [entry.source],
		) ?? []

	return [...imports, ...reExports]
}

function reportRejection(
	reason: SpecifierRejection,
	source: parser.ModuleSpecifierNode,
): void {
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
						"Write the path from this Module to the file, beginning with './' or '../'.",
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
					helps: [
						specifier.endsWith(".es")
							? `Write './${specifier}' if the file sits beside this one.`
							: "Write the path from this Module to the file, beginning with './' or '../'.",
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
					helps: [
						specifier.endsWith("/")
							? "Name the file itself, ending in '.es'."
							: `Write '${specifier}.es'.`,
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
				helps: [
					"Remove the entry — the name it asks for is a builtin.",
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
				helps: [
					"Remove the entry, or point it at the Module that declares the name.",
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

// NOTE: One resolution per distinct specifier text, but one Diagnostic per
// ENTRY — two entries naming the same unreachable Module are two mistakes to
// underline, and Diagnostics dedup by Position, so each is reported once.
function resolveDependencies(
	module: Module,
	readModule: (filePath: string) => Module | null,
	resolveFor: SpecifierResolver,
): Array<Module> {
	let resolutions = new Map<string, SpecifierResolution>()
	let dependencies: Array<Module> = []
	let named = new Set<string>()

	for (let source of specifiersOf(module.program)) {
		let resolution = resolutions.get(source.path)

		if (resolution === undefined) {
			resolution = resolveFor(source.path, module.filePath)
			resolutions.set(source.path, resolution)
		}

		if (resolution.kind === "rejected") {
			reportRejection(resolution.reason, source)

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

// NOTE: Tarjan's algorithm, over the edges each Module resolved. An SCC is only
// closed once every Module reachable from it has been, so the groups come out
// dependency-first — which is both the order they have to be enriched in and
// the order their bodies run in. That holds per root and across roots, so
// several roots may be given: an entry Program reaches every Module that
// matters to it, but a collection loaded as a whole — the standard library —
// has files nothing imports, and visiting only the first would drop them.
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
				// NOTE: A dependency that is done and off the stack belongs to a
				// group of its own that is already closed — it is reachable from
				// here, but this Module is not reachable from it, so it says
				// nothing about where this group ends.
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

			// NOTE: Reversed, so a group reads in the order the cycle was walked
			// in — the Module that was reached first ahead of the ones it
			// reached — rather than in the order the stack unwound.
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

// NOTE: Every file reachable from the entry, parsed once and ordered. The host
// is asked for each file exactly once, so a Module reached from two importers is
// one Module, and a diamond is not read twice.
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
		// NOTE: The one placeless Diagnostic this stage reports. There is no
		// source to point into: the file the caller named is the file that could
		// not be read.
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

// NOTE: A work list rather than a recursive descent, so that a Module's entries
// are resolved inside its OWN Diagnostic collection. Resolving a dependency's
// entries from inside its importer's collection would nest the two, and
// per-Module collection is what keeps two Modules' identical errors from
// deduplicating against each other.
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

// NOTE: A graph over Programs that are already parsed and already in memory,
// with a resolver of the caller's choosing — the standard library, which is read
// and parsed by its own package before the Compiler ever sees it, resolves a
// specifier against that set by name rather than against the file system.
// EVERY entry is a root: a collection loaded as a whole has files nothing
// imports, and `Print.es` is exactly that. Nothing reaches it, so a graph rooted
// at one entry would leave `__print` out of the language.
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
