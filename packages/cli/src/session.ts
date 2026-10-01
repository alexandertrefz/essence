import { readFileSync } from "node:fs"

import type { CompileMode } from "@essence-lang/compiler/compileMode"
import { isStdlibDocument } from "@essence-lang/compiler/documents"
import {
	canonicalPath,
	type LinkedModule,
	linkModuleGraph,
	loadModuleGraph,
	type Module,
	type ModuleHost,
	resolveSpecifier,
} from "@essence-lang/compiler/modules"
import {
	defaultOptimiserOptions,
	optimise,
	type OptimiserOptions,
	optimiserOptionsKey,
} from "@essence-lang/compiler/optimiser"
import {
	simplify,
	type SimplifyOptions,
} from "@essence-lang/compiler/simplifier"
import type { common } from "@essence-lang/interfaces"

// One invocation's Modules, read, parsed and linked once. A file is often both
// an entry and another's dependency. So every entry's graph merges into one set,
// and each connected piece is linked once.

// A Module of one connected piece of the invocation's Modules. Pieces share
// nothing, so linking each apart answers what linking their union would.
type Component = {
	// Dependency-first: every Module ahead of its importers, a cycle grouped whole.
	groups: Array<Array<Module>>
	modules: Map<string, Module>
	linked: Map<string, LinkedModule> | null
}

type SessionRead =
	| { filePath: string; sourceText: string }
	| { filePath: string; error: unknown }

export type CompileSession = {
	// The entry's text, or the filesystem's error. The graph reports an unreadable
	// dependency as `module-not-found`, and the CLI reports an unreadable entry.
	read: (fileName: string) => SessionRead
	// Everything the entry reaches, dependency-first with the entry last, the order
	// the Module bodies run in.
	modules: (fileName: string) => Array<Module>
	linked: (fileName: string) => Array<LinkedModule>
	// Each typed Program is simplified once and answers with the same simplified
	// Program, which `optimise` keys its cache on.
	simplify: (
		program: common.typed.Program,
		options?: SimplifyOptions,
	) => common.typedSimple.Program
	// Optimising is pure, so this cache only saves repeating work. It is keyed by
	// the Options too, so one build never gets another's passes.
	optimise: (
		program: common.typedSimple.Program,
		options?: OptimiserOptions,
	) => common.typedSimple.Program
}

// The Modules an entry reaches over the graph's own edges. Filtering the
// component's order keeps them dependency-first with the entry last.
function reachableModules(
	component: Component,
	entryPath: string,
): Array<Module> {
	let seen = new Set<string>()

	let walk = (filePath: string): void => {
		if (seen.has(filePath)) {
			return
		}

		seen.add(filePath)

		for (let dependency of component.modules.get(filePath)?.dependencies ??
			[]) {
			walk(dependency)
		}
	}

	walk(entryPath)

	return component.groups.flat().filter((module) => seen.has(module.filePath))
}

// The compile mode belongs to the whole invocation. Linked components are cached
// under it, so a Session answers for one mode only. See `CompileMode`.
export function createCompileSession(
	entryFileNames: Array<string>,
	mode: CompileMode = {},
): CompileSession {
	let texts = new Map<string, string>()
	let errors = new Map<string, unknown>()

	// One read per file per invocation, keeping why a read failed. The graph's
	// host answers `undefined` for a missing file, a directory or an unreadable one.
	let host: ModuleHost = {
		readFile(filePath: string): string | undefined {
			let text = texts.get(filePath)

			if (text !== undefined || errors.has(filePath)) {
				return text
			}

			try {
				text = readFileSync(filePath, "utf8")
				texts.set(filePath, text)

				return text
			} catch (error) {
				errors.set(filePath, error)

				return undefined
			}
		},
	}

	let components = new Map<string, Component>()
	let groups: Array<Array<Module>> = []
	let modules = new Map<string, Module>()
	let loaded = false
	let simplified = new WeakMap<
		common.typed.Program,
		common.typedSimple.Program
	>()
	let optimised = new WeakMap<
		common.typedSimple.Program,
		Map<string, common.typedSimple.Program>
	>()

	// A Strongly Connected Component is the same in every graph that reaches it,
	// so a group with one member held is already parsed.
	let mergeGraph = (entryPath: string): Array<string> => {
		let graph = loadModuleGraph(entryPath, host)
		let touched: Array<string> = []

		for (let group of graph.groups) {
			for (let module of group) {
				touched.push(module.filePath)
			}

			if (modules.has(group[0]!.filePath)) {
				continue
			}

			for (let module of group) {
				modules.set(module.filePath, module)
			}

			groups.push(group)
		}

		return touched
	}

	// Which Modules belong together, from what was loaded: everything one entry
	// reaches is connected, so the pieces fall out of the overlaps between loads.
	let assignComponents = (loads: Array<Array<string>>): void => {
		let parents = new Map<string, string>()

		let find = (filePath: string): string => {
			let parent = parents.get(filePath)

			if (parent === undefined || parent === filePath) {
				parents.set(filePath, filePath)

				return filePath
			}

			let root = find(parent)

			parents.set(filePath, root)

			return root
		}

		let union = (left: string, right: string): void => {
			let leftRoot = find(left)
			let rightRoot = find(right)

			if (leftRoot !== rightRoot) {
				parents.set(leftRoot, rightRoot)
			}
		}

		for (let load of loads) {
			let first = load[0]

			if (first === undefined) {
				continue
			}

			for (let filePath of load) {
				union(first, filePath)
			}
		}

		let built = new Map<string, Component>()

		for (let group of groups) {
			let root = find(group[0]!.filePath)
			let component = built.get(root)

			if (component === undefined) {
				component = { groups: [], modules: new Map(), linked: null }
				built.set(root, component)
			}

			component.groups.push(group)

			for (let module of group) {
				component.modules.set(module.filePath, module)
				components.set(module.filePath, component)
			}
		}
	}

	let load = (): void => {
		if (loaded) {
			return
		}

		loaded = true

		let loads: Array<Array<string>> = []

		for (let fileName of entryFileNames) {
			let entryPath = canonicalPath(fileName)

			// A standard library source is not a Module, so it never enters a graph.
			if (isStdlibDocument(entryPath) || modules.has(entryPath)) {
				continue
			}

			loads.push(mergeGraph(entryPath))
		}

		assignComponents(loads)
	}

	// A file the Session was not begun with gets a piece of its own. That may enrich
	// a shared Module twice, but never answers wrongly.
	let loadComponent = (entryPath: string): Component | undefined => {
		let graph = loadModuleGraph(entryPath, host)

		if (graph.modules.size === 0) {
			return undefined
		}

		let component: Component = {
			groups: [...graph.groups],
			modules: new Map(graph.modules),
			linked: null,
		}

		for (let filePath of graph.modules.keys()) {
			if (!components.has(filePath)) {
				components.set(filePath, component)
			}
		}

		return component
	}

	let componentFor = (filePath: string): Component | undefined => {
		load()

		return components.get(filePath) ?? loadComponent(filePath)
	}

	// Links a whole piece at once, since linking binds imports. The `entryPath` is
	// only carried through: bundles name their Modules against the caller's entry.
	let linkComponent = (component: Component): Map<string, LinkedModule> => {
		if (component.linked === null) {
			component.linked = linkModuleGraph(
				{
					entryPath: component.groups[0]![0]!.filePath,
					modules: component.modules,
					groups: component.groups,
					diagnostics: [],
				},
				mode,
			).modules
		}

		return component.linked
	}

	return {
		read: (fileName: string): SessionRead => {
			let filePath = canonicalPath(fileName)
			let sourceText = host.readFile(filePath)

			return sourceText === undefined
				? { filePath, error: errors.get(filePath) }
				: { filePath, sourceText }
		},

		modules: (fileName: string): Array<Module> => {
			let filePath = canonicalPath(fileName)
			let component = componentFor(filePath)

			return component === undefined
				? []
				: reachableModules(component, filePath)
		},

		linked: (fileName: string): Array<LinkedModule> => {
			let filePath = canonicalPath(fileName)
			let component = componentFor(filePath)

			if (component === undefined) {
				return []
			}

			let linked = linkComponent(component)

			return reachableModules(component, filePath).flatMap((module) => {
				let result = linked.get(module.filePath)

				return result === undefined ? [] : [result]
			})
		},

		// Keyed by Program alone: the only option is the Module's source text, which is
		// fixed for the Program parsed from it.
		simplify: (
			program: common.typed.Program,
			options?: SimplifyOptions,
		): common.typedSimple.Program => {
			let result = simplified.get(program)

			if (result === undefined) {
				result = simplify(program, options)
				simplified.set(program, result)
			}

			return result
		},

		optimise: (
			program: common.typedSimple.Program,
			options: OptimiserOptions = defaultOptimiserOptions,
		): common.typedSimple.Program => {
			let byOptions = optimised.get(program)

			if (byOptions === undefined) {
				byOptions = new Map()
				optimised.set(program, byOptions)
			}

			let key = optimiserOptionsKey(options)
			let result = byOptions.get(key)

			if (result === undefined) {
				result = optimise(program, options)
				byOptions.set(key, result)
			}

			return result
		},
	}
}

// Every `from "…"` a file spells, read from its text rather than parsed. It only
// decides which entries share a worker, so a wrong answer costs a duplicate parse.
const SPECIFIER_PATTERN = /\bfrom\s*"([^"\n]*\.es)"/g

function writtenDependencies(filePath: string): Array<string> {
	let sourceText: string

	try {
		sourceText = readFileSync(filePath, "utf8")
	} catch {
		return []
	}

	let dependencies: Array<string> = []

	for (let match of sourceText.matchAll(SPECIFIER_PATTERN)) {
		let resolution = resolveSpecifier(match[1] as string, filePath)

		if (resolution.kind === "module") {
			dependencies.push(resolution.filePath)
		}
	}

	return dependencies
}

// The entries grouped by overlapping graphs, one import deep: an entry importing
// another, or two entries importing a third file. A group goes to one worker.
export function groupEntries(fileNames: Array<string>): Array<Array<string>> {
	let parents = new Map<string, string>()

	let find = (filePath: string): string => {
		let parent = parents.get(filePath)

		if (parent === undefined || parent === filePath) {
			parents.set(filePath, filePath)

			return filePath
		}

		let root = find(parent)

		parents.set(filePath, root)

		return root
	}

	let union = (left: string, right: string): void => {
		let leftRoot = find(left)
		let rightRoot = find(right)

		if (leftRoot !== rightRoot) {
			parents.set(leftRoot, rightRoot)
		}
	}

	let entryPaths = new Map<string, string>()

	for (let fileName of fileNames) {
		let filePath = canonicalPath(fileName)

		entryPaths.set(fileName, filePath)
		find(filePath)

		for (let dependency of writtenDependencies(filePath)) {
			union(filePath, dependency)
		}
	}

	let grouped = new Map<string, Array<string>>()

	for (let [fileName, filePath] of entryPaths) {
		let root = find(filePath)
		let group = grouped.get(root)

		if (group === undefined) {
			grouped.set(root, [fileName])
		} else {
			group.push(fileName)
		}
	}

	return [...grouped.values()]
}
