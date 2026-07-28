import { readFileSync } from "node:fs"

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
import { optimise } from "@essence-lang/compiler/optimiser"
import { simplify } from "@essence-lang/compiler/simplifier"
import type { common } from "@essence-lang/interfaces"

// NOTE: One invocation's Modules, read once, parsed once and linked once.
// `esc check src/*.es` hands every file it was given as an entry, and with
// Modules a file is routinely both an entry and somebody else's dependency:
// loaded per entry it would be type checked as many times as it is reached, and
// its Diagnostics counted as many times. A Session is what makes "once" true —
// every entry's graph is merged into one set of Modules, and each connected
// piece of that set is linked exactly once, for whichever entry asks first.

// NOTE: A Module of one connected piece of the invocation's Modules. Linking
// runs over a piece as a whole because that is the unit `linkModuleGraph`
// works in, and pieces share nothing: linking two of them separately answers
// exactly what linking their union would have.
type Component = {
	// NOTE: The order the graphs were loaded in, which is dependency-first —
	// every Module ahead of the ones that import it, a cycle grouped whole.
	groups: Array<Array<Module>>
	modules: Map<string, Module>
	linked: Map<string, LinkedModule> | null
}

export type SessionRead =
	| { filePath: string; sourceText: string }
	| { filePath: string; error: unknown }

export type CompileSession = {
	// NOTE: The entry's own text, and the error the filesystem gave if there is
	// none. The graph reports an unreadable DEPENDENCY as `module-not-found`;
	// an unreadable entry is the CLI's own to report, because it is the file
	// the caller named on the command line.
	read: (fileName: string) => SessionRead
	// NOTE: Everything the entry reaches, dependency-first with the entry last —
	// which is both the order the Module bodies run in and the order their
	// Diagnostics read best in.
	modules: (fileName: string) => Array<Module>
	linked: (fileName: string) => Array<LinkedModule>
	// NOTE: Simplifying is not something a Program survives twice: the
	// Simplifier writes an overloaded Method's mangled name onto the typed Node
	// it read it off, so a second pass mangles the mangled name and the emitted
	// call names a Method nothing declares. One typed Program is reached by
	// every entry that imports it, so each is put through once — keyed by the
	// Program itself, because that is what may not be simplified twice.
	simplify: (program: common.typed.Program) => common.typedSimple.Program
	optimise: (
		program: common.typedSimple.Program,
	) => common.typedSimple.Program
}

// NOTE: Reached over the edges the graph itself resolved, so that an entry that
// is somebody else's dependency compiles the Modules IT reaches and no more.
// Filtering the component's own order rather than collecting during the walk
// keeps the answer dependency-first, and leaves the entry last: anything after
// it in that order is not something it depends on.
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

export function createCompileSession(
	entryFileNames: Array<string>,
): CompileSession {
	let texts = new Map<string, string>()
	let errors = new Map<string, unknown>()

	// NOTE: One read per file for the whole invocation, and the reason a read
	// failed kept rather than thrown away — `esc` distinguishes a missing file
	// from a directory from an unreadable one, and the graph's host answers
	// `undefined` to all three.
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
		common.typedSimple.Program
	>()

	// NOTE: A group already held is a group already parsed: a Strongly
	// Connected Component is the same set of Modules in every graph that
	// reaches any of it, so recognising one member is recognising the group.
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

	// NOTE: Which Modules belong together, answered from what was actually
	// loaded rather than guessed at: everything one entry reaches is connected
	// through that entry, so a load is one union and the pieces fall out of the
	// overlaps between loads.
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

			// NOTE: A standard library source is not a Module and can not be
			// imported as one, so it never enters a graph — `esc check` on one
			// reads it as the single declaration space it is.
			if (isStdlibDocument(entryPath) || modules.has(entryPath)) {
				continue
			}

			loads.push(mergeGraph(entryPath))
		}

		assignComponents(loads)
	}

	// NOTE: A file the Session was never told about — nothing the CLI does
	// today, since a run is planned before anything is compiled. It gets a
	// piece of its own rather than an empty answer, which costs a second
	// enrichment of whatever it shares with an entry and never a wrong one.
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

	// NOTE: A whole piece at once, entries and dependencies alike, because
	// linking is what a Module's imports are bound by and a piece is what is
	// connected. The `entryPath` handed over is only carried through: what a
	// bundle spells its Modules against is the entry the CALLER asked for, and
	// one piece answers for as many entries as it holds.
	let linkComponent = (component: Component): Map<string, LinkedModule> => {
		if (component.linked === null) {
			component.linked = linkModuleGraph({
				entryPath: component.groups[0]![0]!.filePath,
				modules: component.modules,
				groups: component.groups,
				diagnostics: [],
			}).modules
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

		simplify: (
			program: common.typed.Program,
		): common.typedSimple.Program => {
			let result = simplified.get(program)

			if (result === undefined) {
				result = simplify(program)
				simplified.set(program, result)
			}

			return result
		},

		optimise: (
			program: common.typedSimple.Program,
		): common.typedSimple.Program => {
			let result = optimised.get(program)

			if (result === undefined) {
				result = optimise(program)
				optimised.set(program, result)
			}

			return result
		},
	}
}

// NOTE: Every `from "…"` a file spells, read out of its text rather than off a
// parsed Program. This answers a SCHEDULING question and only ever that one:
// which entries a worker should be given together, so that the graphs they load
// overlap. A wrong answer costs a Module parsed in two workers — never a
// Diagnostic, never a resolution — and the parent pays no parse of its own for
// files it is not going to compile.
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

// NOTE: The entries of an invocation, gathered into the sets whose graphs are
// going to overlap — one hop deep, which catches the two shapes a batch
// actually has: an entry that imports another entry, and two entries importing
// a third file. Workers share nothing, so entries of one set landing in one
// worker is what keeps a shared Module from being enriched in several of them.
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
