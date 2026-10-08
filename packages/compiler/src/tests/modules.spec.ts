import { describe, expect, it } from "bun:test"
import {
	mkdirSync,
	mkdtempSync,
	realpathSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import * as path from "node:path"

import { fixturePath } from "@essence-lang/fixtures"
import type { common } from "@essence-lang/interfaces"
import { STDLIB_DIRECTORY } from "@essence-lang/standard-library"

import { analyseLinkedModules } from "../analysis"
import { bundle, type ModuleSources } from "../bundler/index"
import { containsErrors } from "../diagnostics/index"
import { emitToMemory } from "../embed/index"
import { loadModuleGraph, type Module } from "../modules/graph"
import { diskModuleHost, type ModuleHost } from "../modules/host"
import {
	lateBindingWork,
	type LinkedGraph,
	linkModuleGraph,
	type LinkedModule,
} from "../modules/link"
import { canonicalPath, resolveSpecifier } from "../modules/resolve"
import { defaultOptimiserOptions, optimise } from "../optimiser/index"
import { rewriteModules } from "../rewriter/index"
import { simplify } from "../simplifier/index"
import { validate } from "../validator/index"
import { compiles } from "./followedHelps"

// A project written into a directory of its own and removed again, so each
// spec shows where its files sit.
//
// The directory is canonicalised first: on macOS `mkdtempSync` answers under
// `/var/folders/…`, a symlink to `/private/var/folders/…`, which the resolver
// answers in.
function withProject<T>(
	files: Record<string, string>,
	work: (directory: string) => T,
): T {
	let directory = mkdtempSync(path.join(tmpdir(), "essence-modules-"))

	try {
		return work(writeProject(directory, files))
	} finally {
		rmSync(directory, { recursive: true, force: true })
	}
}

// The same for specs that build, awaiting the work before the directory is
// removed, since esbuild reads the sources asynchronously.
async function withBuiltProject<T>(
	files: Record<string, string>,
	work: (directory: string) => Promise<T>,
): Promise<T> {
	let directory = mkdtempSync(path.join(tmpdir(), "essence-modules-"))

	try {
		return await work(writeProject(directory, files))
	} finally {
		rmSync(directory, { recursive: true, force: true })
	}
}

function writeProject(
	directory: string,
	files: Record<string, string>,
): string {
	for (let [name, source] of Object.entries(files)) {
		let filePath = path.join(directory, name)

		mkdirSync(path.dirname(filePath), { recursive: true })
		writeFileSync(filePath, source)
	}

	return realpathSync.native(directory)
}

// A host of files not on disk, as the Language Server has for unsaved
// documents. It records what it was asked for, so single reads show.
function memoryHost(files: Record<string, string>): ModuleHost & {
	reads: Array<string>
} {
	let reads: Array<string> = []

	return {
		reads,
		readFile(filePath: string): string | undefined {
			reads.push(filePath)

			return files[filePath]
		},
	}
}

function moduleProgram(nodes: string = ""): string {
	return `implementation {\n${nodes}\n}\n`
}

function relativePathsOf(directory: string, filePaths: Array<string>) {
	return filePaths.map((filePath) => path.relative(directory, filePath))
}

function moduleNamesOf(directory: string, modules: Array<Module>) {
	return relativePathsOf(
		directory,
		modules.map((module) => module.filePath),
	)
}

function groupNamesOf(directory: string, groups: Array<Array<Module>>) {
	return groups.map((group) => moduleNamesOf(directory, group))
}

function moduleAt(
	directory: string,
	graph: { modules: Map<string, Module> },
	name: string,
): Module {
	let module = graph.modules.get(path.join(directory, name))

	if (module === undefined) {
		throw new Error(`no Module '${name}' in the graph`)
	}

	return module
}

describe("Module Resolution", () => {
	it("resolves a relative specifier against the importer's directory", () => {
		withProject({ "src/Main.es": moduleProgram() }, (directory) => {
			expect(
				resolveSpecifier(
					"./Geometry.es",
					path.join(directory, "src", "Main.es"),
				),
			).toEqual({
				kind: "module",
				filePath: path.join(directory, "src", "Geometry.es"),
			})
		})
	})

	// A specifier may leave the importer's directory. There is no root it may
	// not leave.
	it("resolves a specifier that leaves the importer's directory", () => {
		withProject({ "src/Main.es": moduleProgram() }, (directory) => {
			expect(
				resolveSpecifier(
					"../math/Math.es",
					path.join(directory, "src", "Main.es"),
				),
			).toEqual({
				kind: "module",
				filePath: path.join(directory, "math", "Math.es"),
			})
		})
	})

	// The Language Server resolves against unsaved documents, so resolution
	// does not ask whether the file exists. Reading it is the host's job.
	it("resolves a specifier naming a file that is not on disk", () => {
		withProject({ "Main.es": moduleProgram() }, (directory) => {
			expect(
				resolveSpecifier(
					"./Unsaved.es",
					path.join(directory, "Main.es"),
				),
			).toEqual({
				kind: "module",
				filePath: path.join(directory, "Unsaved.es"),
			})
		})
	})

	it("rejects a bare specifier", () => {
		expect(resolveSpecifier("Geometry.es", "/project/Main.es")).toEqual({
			kind: "rejected",
			reason: "not-relative",
		})
		expect(
			resolveSpecifier("geometry/Geometry.es", "/project/Main.es"),
		).toEqual({ kind: "rejected", reason: "not-relative" })
	})

	it("rejects an absolute specifier", () => {
		expect(
			resolveSpecifier("/project/Geometry.es", "/project/Main.es"),
		).toEqual({ kind: "rejected", reason: "absolute" })
	})

	it("rejects a specifier without the '.es' extension", () => {
		expect(resolveSpecifier("./Geometry", "/project/Main.es")).toEqual({
			kind: "rejected",
			reason: "missing-extension",
		})
		expect(resolveSpecifier("./geometry/", "/project/Main.es")).toEqual({
			kind: "rejected",
			reason: "missing-extension",
		})
	})

	it("rejects a specifier that names the importer", () => {
		withProject({ "src/Main.es": moduleProgram() }, (directory) => {
			let importer = path.join(directory, "src", "Main.es")

			expect(resolveSpecifier("./Main.es", importer)).toEqual({
				kind: "rejected",
				reason: "self-import",
			})

			// The same file spelled the long way round. A self-import is
			// decided by the file the path lands on.
			expect(resolveSpecifier("../src/Main.es", importer)).toEqual({
				kind: "rejected",
				reason: "self-import",
			})
		})
	})

	// Derived from `STDLIB_DIRECTORY`, so the spec holds under both layouts
	// that constant answers for: a checkout and the bundled extension.
	it("rejects a specifier naming a standard library source", () => {
		withProject({ "Main.es": moduleProgram() }, (directory) => {
			let importer = path.join(directory, "Main.es")
			let specifier = path.relative(
				directory,
				path.join(STDLIB_DIRECTORY, "Boolean.es"),
			)

			expect(resolveSpecifier(specifier, importer)).toEqual({
				kind: "rejected",
				reason: "standard-library",
			})
		})
	})

	// One file reached through a symlink and directly is one Module, so its
	// Types stay interchangeable.
	it("answers with one path for a file reached through a symlink", () => {
		withProject(
			{
				"Main.es": moduleProgram(),
				"real/Geometry.es": moduleProgram(),
			},
			(directory) => {
				let importer = path.join(directory, "Main.es")

				symlinkSync(
					path.join(directory, "real"),
					path.join(directory, "link"),
					"dir",
				)

				expect(
					resolveSpecifier("./link/Geometry.es", importer),
				).toEqual(resolveSpecifier("./real/Geometry.es", importer))
			},
		)
	})
})

describe("Module Graph", () => {
	// Dependencies first, the entry last, since a Module is enriched only
	// after everything it imports.
	it("orders a chain of Modules dependency first", () => {
		withProject(
			{
				"Main.es": `import {
	from "./Geometry.es" { Rectangle }
}

${moduleProgram()}`,
				"Geometry.es": `import {
	from "./math/Math.es" { PI }
}

${moduleProgram()}`,
				"math/Math.es": moduleProgram(),
			},
			(directory) => {
				let graph = loadModuleGraph(
					path.join(directory, "Main.es"),
					diskModuleHost,
				)

				expect(
					relativePathsOf(directory, [...graph.modules.keys()]),
				).toEqual([
					path.join("math", "Math.es"),
					"Geometry.es",
					"Main.es",
				])
				expect(graph.entryPath).toBe(path.join(directory, "Main.es"))
				expect(graph.diagnostics).toEqual([])

				// A chain is one Module per group.
				expect(groupNamesOf(directory, graph.groups)).toEqual([
					[path.join("math", "Math.es")],
					["Geometry.es"],
					["Main.es"],
				])
			},
		)
	})

	// A re-export is a dependency. A facade names the Module it forwards from
	// only in its `export` section.
	it("takes a dependency from an export section's 'from' entry", () => {
		withProject(
			{
				"Main.es": `import {
	from "./Facade.es" { Rectangle }
}

${moduleProgram()}`,
				"Facade.es": `${moduleProgram()}
export {
	from "./Geometry.es" { Rectangle }
}
`,
				"Geometry.es": moduleProgram(),
			},
			(directory) => {
				let graph = loadModuleGraph(
					path.join(directory, "Main.es"),
					diskModuleHost,
				)

				expect(
					relativePathsOf(directory, [...graph.modules.keys()]),
				).toEqual(["Geometry.es", "Facade.es", "Main.es"])
				expect(
					relativePathsOf(
						directory,
						moduleAt(directory, graph, "Facade.es").dependencies,
					),
				).toEqual(["Geometry.es"])
			},
		)
	})

	// Keyed by the canonical path, a diamond binds one Module, so its body runs
	// once and its Types are shared.
	it("reads a Module two importers name exactly once", () => {
		let directory = canonicalPath(
			path.join(tmpdir(), `essence-diamond-${process.pid}`),
		)
		let filePath = (name: string) => path.join(directory, name)
		let host = memoryHost({
			[filePath("Main.es")]: `import {
	from "./Left.es" { Rectangle }
	from "./Right.es" { Circle }
}

${moduleProgram()}`,
			[filePath("Left.es")]: `import {
	from "./Shape.es" { Shape }
}

${moduleProgram()}`,
			[filePath("Right.es")]: `import {
	from "./Shape.es" { Shape }
}

${moduleProgram()}`,
			[filePath("Shape.es")]: moduleProgram(),
		})

		let graph = loadModuleGraph(filePath("Main.es"), host)

		expect(relativePathsOf(directory, [...graph.modules.keys()])).toEqual([
			"Shape.es",
			"Left.es",
			"Right.es",
			"Main.es",
		])
		expect(relativePathsOf(directory, host.reads).sort()).toEqual([
			"Left.es",
			"Main.es",
			"Right.es",
			"Shape.es",
		])
	})

	// Two entries naming one Module are one dependency and one entry in the
	// resolution table, keyed by the specifier as written.
	it("names a Module once however many entries mention it", () => {
		withProject(
			{
				"Main.es": `import {
	from "./Geometry.es" { Rectangle }
	from "./Geometry.es" { Circle }
}

${moduleProgram()}
export {
	from "./Geometry.es" { Square }
}
`,
				"Geometry.es": moduleProgram(),
			},
			(directory) => {
				let graph = loadModuleGraph(
					path.join(directory, "Main.es"),
					diskModuleHost,
				)
				let main = moduleAt(directory, graph, "Main.es")

				expect(relativePathsOf(directory, main.dependencies)).toEqual([
					"Geometry.es",
				])
				expect([...main.resolutions]).toEqual([
					["./Geometry.es", path.join(directory, "Geometry.es")],
				])
			},
		)
	})

	// A cycle is one group, because the hoisting pass must see all of it at
	// once. The source states no order inside it.
	it("groups a cycle into one Strongly Connected Component", () => {
		withProject(
			{
				"A.es": `import {
	from "./B.es" { b }
}

${moduleProgram()}`,
				"B.es": `import {
	from "./A.es" { a }
	from "./Leaf.es" { leaf }
}

${moduleProgram()}`,
				"Leaf.es": moduleProgram(),
			},
			(directory) => {
				let graph = loadModuleGraph(
					path.join(directory, "A.es"),
					diskModuleHost,
				)

				expect(groupNamesOf(directory, graph.groups)).toEqual([
					["Leaf.es"],
					["A.es", "B.es"],
				])

				// The flattened order is the groups in order.
				expect(
					relativePathsOf(directory, [...graph.modules.keys()]),
				).toEqual(["Leaf.es", "A.es", "B.es"])
			},
		)
	})

	it("closes a cycle that reaches back through a third Module", () => {
		withProject(
			{
				"A.es": `import {
	from "./B.es" { b }
}

${moduleProgram()}`,
				"B.es": `import {
	from "./C.es" { c }
}

${moduleProgram()}`,
				"C.es": `import {
	from "./A.es" { a }
}

${moduleProgram()}`,
			},
			(directory) => {
				let graph = loadModuleGraph(
					path.join(directory, "A.es"),
					diskModuleHost,
				)

				expect(groupNamesOf(directory, graph.groups)).toEqual([
					["A.es", "B.es", "C.es"],
				])
			},
		)
	})

	// Per Module, because the deduplication key holds no file. Two Modules
	// with the same mistake on the same line make two Diagnostics.
	it("keeps each Module's parse Diagnostics on that Module", () => {
		withProject(
			{
				"Main.es": `import {
	from "./Broken.es" { broken }
}

implementation {
	constant x = 0xFF
}
`,
				"Broken.es": `implementation {
	constant y = 0xFF
}
`,
			},
			(directory) => {
				let graph = loadModuleGraph(
					path.join(directory, "Main.es"),
					diskModuleHost,
				)

				for (let name of ["Main.es", "Broken.es"]) {
					let module = moduleAt(directory, graph, name)

					expect([
						name,
						module.diagnostics.map((diagnostic) => diagnostic.code),
					]).toEqual([name, ["invalid-number"]])
				}

				// A report about a dependency renders against the dependency's
				// own text, which travels with the Module.
				expect(
					moduleAt(directory, graph, "Broken.es").sourceText,
				).toContain("constant y")
			},
		)
	})

	it("reports a specifier that names no Module against the entry that wrote it", () => {
		withProject(
			{
				"Main.es": `import {
	from "./Gone.es" {
		Rectangle
		Circle
	}
	from "./Gone.es" { Square }
}

${moduleProgram()}`,
			},
			(directory) => {
				let graph = loadModuleGraph(
					path.join(directory, "Main.es"),
					diskModuleHost,
				)
				let diagnostics = moduleAt(
					directory,
					graph,
					"Main.es",
				).diagnostics

				// One Diagnostic per specifier written, each underlining its own.
				expect(
					diagnostics.map((diagnostic) => diagnostic.code),
				).toEqual(["module-not-found", "module-not-found"])
				expect(diagnostics[0].message).toBe(
					"No Module was found at './Gone.es'",
				)
				expect(diagnostics[0].position).toEqual({
					start: { line: 2, column: 7 },
					end: { line: 2, column: 18 },
				})
				expect(diagnostics[0].labels).toHaveLength(1)
				expect(diagnostics[0].labels[0]?.kind).toBe("primary")
				expect(diagnostics[0].notes[0]).toContain(
					path.join(directory, "Gone.es"),
				)
				expect(diagnostics[1].position?.start.line).toBe(6)
			},
		)
	})

	it("reports every kind of specifier the resolver refuses", () => {
		withProject(
			{
				"Main.es": `import {
	from "Geometry.es" { Bare }
	from "/project/Geometry.es" { Absolute }
	from "./Geometry" { Extensionless }
	from "./Main.es" { Own }
}

${moduleProgram()}`,
			},
			(directory) => {
				let graph = loadModuleGraph(
					path.join(directory, "Main.es"),
					diskModuleHost,
				)
				let diagnostics = moduleAt(
					directory,
					graph,
					"Main.es",
				).diagnostics

				expect(
					diagnostics.map((diagnostic) => [
						diagnostic.code,
						diagnostic.message,
					]),
				).toEqual([
					[
						"invalid-module-specifier",
						"Module specifier 'Geometry.es' is not a relative path",
					],
					[
						"invalid-module-specifier",
						"Module specifier '/project/Geometry.es' is an absolute path",
					],
					[
						"invalid-module-specifier",
						"Module specifier './Geometry' does not name a '.es' file",
					],
					["self-import", "A Module can not import itself"],
				])

				for (let diagnostic of diagnostics) {
					expect(diagnostic.labels).toHaveLength(1)
					expect(diagnostic.notes).not.toEqual([])
					expect(diagnostic.helps).not.toEqual([])
				}

				// A refused specifier is not an edge, so nothing else loads.
				expect(
					moduleAt(directory, graph, "Main.es").dependencies,
				).toEqual([])
				expect(graph.modules.size).toBe(1)
			},
		)
	})

	// A specifier that already carries another extension gets no edit, since
	// './clock.js.es' is no file. `moduleSpecifierActions` reads the fix out of
	// the Help text.
	it("offers an extension only where appending one could be right", () => {
		let helpFor = (specifier: string): string =>
			withProject(
				{
					"Main.es": `import {\n\tfrom "${specifier}" { Name }\n}\n\n${moduleProgram()}`,
				},
				(directory) =>
					moduleAt(
						directory,
						loadModuleGraph(
							path.join(directory, "Main.es"),
							diskModuleHost,
						),
						"Main.es",
					).diagnostics[0]?.helps[0] as string,
			)

		expect(helpFor("./Geometry")).toBe("Write './Geometry.es'.")

		for (let specifier of ["./clock.js", "./clock.mjs", "./clock.ts"]) {
			expect(helpFor(specifier)).toBe(
				"Essence imports '.es' Modules and nothing else — reach a JavaScript file from the JavaScript side instead, by embedding this Program with 'essence build --embed'.",
			)
		}

		expect(helpFor("./data.json")).toBe(
			"Name a '.es' Module — an import block reads no other kind of file.",
		)
		expect(helpFor("./shapes/")).toBe(
			"Name the file itself, ending in '.es'.",
		)

		// A package specifier is told both halves at once, so one edit leads
		// to `module-not-found` rather than a second refusal.
		expect(helpFor("lodash")).toBe(
			"Write the path from this Module to the file, beginning with './' or '../' and ending in '.es'.",
		)
	})

	// The specifier is the one mistake, so the names under it are bound to
	// Error and their uses stay quiet. A name the Module declares itself keeps
	// its own meaning.
	it("reports a refused or missing specifier once, not at each use", () => {
		// A missing Module's Note names where its specifier resolves, so the
		// graph is analysed without `analysedAt`'s check that no path shows.
		let codesIn = (main: string) =>
			withProject({ "Main.es": main }, (directory) =>
				codesOf(
					analyseLinkedModules([
						...linkProject(directory, "Main.es").modules.values(),
					])?.get(path.join(directory, "Main.es")) ?? [],
				),
			)
		let importing = (specifier: string, body: string) => `import {
	from "${specifier}" { area }
}

implementation {
${body}
}
`

		for (let [specifier, code] of [
			["Geometry.es", "invalid-module-specifier"],
			["./Missing.es", "module-not-found"],
		] as const) {
			expect(
				codesIn(importing(specifier, "\tTerminal.print(area(2))")),
			).toEqual([code])
		}

		expect(
			codesIn(
				importing(
					"Geometry.es",
					"\tconstant area = 4\n\n\tTerminal.print(area::add(1))",
				),
			),
		).toEqual(["invalid-module-specifier"])
	})

	// An entry that loaded binds first, whichever line it is written on, so a
	// missing Module beside it changes nothing about what the name means.
	it("lets a loaded entry keep a name an unloaded one also asks for", () => {
		let reportsIn = (first: string, second: string) =>
			withProject(
				{
					"Main.es": `import {
	from "${first}" { helper }
	from "${second}" { helper }
}

implementation {
	constant answer: String = helper()
}
`,
					"Library.es": `implementation {
	function helper() -> Integer {
		<- 1
	}
}

export {
	helper
}
`,
				},
				(directory) =>
					codesOf(
						analyseLinkedModules([
							...linkProject(
								directory,
								"Main.es",
							).modules.values(),
						])?.get(path.join(directory, "Main.es")) ?? [],
					),
			)

		for (let [first, second] of [
			["./Aaa.es", "./Library.es"],
			["./Library.es", "./Zzz.es"],
		]) {
			expect(reportsIn(first as string, second as string)).toEqual(
				expect.arrayContaining([
					"module-not-found",
					"assignment-type-mismatch",
				]),
			)
			expect(reportsIn(first as string, second as string)).not.toContain(
				"duplicate-import",
			)
		}
	})

	// A Module's own names are in scope already, so a self-import binds none
	// of them, and a name the Module never declares is still unknown.
	it("leaves a name a self-import asks for unbound", () => {
		expect(
			withProject(
				{
					"Main.es": `import {
	from "./Main.es" { helper }
}

implementation {
	Terminal.print(helper())
}
`,
				},
				(directory) =>
					codesOf(analysedAt(directory, "Main.es", "Main.es")),
			),
		).toEqual(["self-import", "unknown-name"])
	})

	it("compiles with the specifier each Help writes", () => {
		let geometry = `implementation {
	function area(_ side: Integer) -> Integer {
		<- side::multiply(with side)
	}
}

export {
	area
}
`
		let importing = (specifier: string) => `import {
	from "${specifier}" { area }
}

implementation {
	Terminal.print(area(2))
}
`

		expect(
			compiles({
				"Main.es": importing("Geometry.es"),
				"Geometry.es": geometry,
			}),
		).toBe(false)
		expect(
			compiles({
				"Main.es": importing("./Geometry.es"),
				"Geometry.es": geometry,
			}),
		).toBe(true)
		expect(
			compiles({
				"Main.es": importing("./shapes/Geometry.es"),
				"shapes/Geometry.es": geometry,
			}),
		).toBe(true)
	})

	// These are reported on the specifier, and deleting one name leaves the
	// same group, so the Help names the group. An export group's Module
	// declares its names, so the edit there differs.
	it("asks for the whole group where the group is what is wrong", () => {
		let helpFor = (source: string): string =>
			withProject(
				{ "Main.es": source },
				(directory) =>
					moduleAt(
						directory,
						loadModuleGraph(
							path.join(directory, "Main.es"),
							diskModuleHost,
						),
						"Main.es",
					).diagnostics[0]?.helps[0] as string,
			)

		expect(
			helpFor(
				`import {\n\tfrom "./Main.es" { area }\n}\n\n${moduleProgram("\tfunction area() -> Integer {\n\t\t<- 1\n\t}")}`,
			),
		).toBe(
			`Remove the whole 'from "./Main.es" { … }' group — every name it asks for is in scope here already.`,
		)

		expect(
			helpFor(`implementation {
	function area(_ side: Integer) -> Integer {
		<- side::multiply(with side)
	}
}

export {
	from "./Main.es" { area }
}
`),
		).toBe(`Write 'area' as a bare entry: 'export { area }'.`)
	})

	// An entry that renames the Module's own name leaves uses of the new name,
	// which the Module's own name replaces once the group goes.
	it("names the Module's own name a self-import renamed", () => {
		let main = (
			imports: string,
			call: string,
		) => `${imports}implementation {
	function helper() -> Integer {
		<- 1
	}

	Terminal.print(${call}())
}
`
		let helps = withProject(
			{
				"Main.es": main(
					`import {\n\tfrom "./Main.es" { helper as h }\n}\n\n`,
					"h",
				),
			},
			(directory) =>
				moduleAt(
					directory,
					loadModuleGraph(
						path.join(directory, "Main.es"),
						diskModuleHost,
					),
					"Main.es",
				).diagnostics[0]?.helps,
		)

		expect(helps).toEqual([
			`Remove the whole 'from "./Main.es" { … }' group — every name it asks for is in scope here already, so write 'helper' in place of 'h'.`,
		])
		expect(compiles({ "Main.es": main("", "helper") })).toBe(true)
	})

	// A name the Module never declares is not in scope here either, so the Help
	// says which ones. Removing the group leaves their uses unknown.
	it("names what a self-import asks for that the Module never declares", () => {
		let main = (imports: string) => `${imports}implementation {
	function area(_ side: Integer) -> Integer {
		<- side
	}

	Terminal.print(area(helper()))
}
`
		let helps = withProject(
			{
				"Main.es": main(
					`import {\n\tfrom "./Main.es" { area helper }\n}\n\n`,
				),
			},
			(directory) =>
				moduleAt(
					directory,
					loadModuleGraph(
						path.join(directory, "Main.es"),
						diskModuleHost,
					),
					"Main.es",
				).diagnostics[0]?.helps,
		)

		expect(helps).toEqual([
			`Remove the whole 'from "./Main.es" { … }' group — a Module's own names are in scope here already, and 'helper' is declared nowhere in it.`,
		])
		expect(
			withProject({ "Main.es": main("") }, (directory) =>
				codesOf(analysedAt(directory, "Main.es", "Main.es")),
			),
		).toEqual(["unknown-name"])
	})

	it("compiles with the group removed or written bare", () => {
		let area = `implementation {
	function area(_ side: Integer) -> Integer {
		<- side::multiply(with side)
	}

	Terminal.print(area(2))
}
`

		expect(compiles({ "Main.es": `import {\n}\n\n${area}` })).toBe(true)
		expect(compiles({ "Main.es": `${area}\nexport {\n\tarea\n}\n` })).toBe(
			true,
		)
	})

	it("reports a specifier naming the standard library", () => {
		withProject({ "Main.es": moduleProgram() }, (directory) => {
			let specifier = path
				.relative(directory, path.join(STDLIB_DIRECTORY, "Boolean.es"))
				.split(path.sep)
				.join("/")

			writeFileSync(
				path.join(directory, "Main.es"),
				`import {\n\tfrom "${specifier}" { Boolean }\n}\n\n${moduleProgram()}`,
			)

			let graph = loadModuleGraph(
				path.join(directory, "Main.es"),
				diskModuleHost,
			)
			let diagnostics = moduleAt(directory, graph, "Main.es").diagnostics

			expect(diagnostics.map((diagnostic) => diagnostic.code)).toEqual([
				"invalid-module-specifier",
			])
			// Deleting the one name would leave `from "…" { }` and the same
			// report.
			expect(diagnostics[0].helps[0]).toBe(
				`Remove the whole 'from "${specifier}" { … }' group — every name it asks for is a builtin.`,
			)
			expect(diagnostics[0].message).toBe(
				"The standard library is not importable",
			)
			expect(graph.modules.size).toBe(1)
		})
	})

	// An unreadable entry has no Program to point into, so the report has no
	// Position and the graph is empty.
	it("reports an unreadable entry without a Position", () => {
		withProject({}, (directory) => {
			let graph = loadModuleGraph(
				path.join(directory, "Gone.es"),
				diskModuleHost,
			)

			expect(graph.modules.size).toBe(0)
			expect(graph.groups).toEqual([])
			expect(
				graph.diagnostics.map((diagnostic) => diagnostic.code),
			).toEqual(["module-not-found"])
			expect(graph.diagnostics[0].position).toBeNull()
			expect(graph.diagnostics[0].labels).toEqual([])
		})
	})

	// The graph is keyed by the canonical path, so a symlinked spelling of a
	// file is the same Module.
	it("binds one Module for a file reached through a symlink", () => {
		withProject(
			{
				"Main.es": `import {
	from "./real/Geometry.es" { Rectangle }
	from "./link/Geometry.es" { Circle }
}

${moduleProgram()}`,
				"real/Geometry.es": moduleProgram(),
			},
			(directory) => {
				let link = path.join(directory, "link")

				symlinkSync(path.join(directory, "real"), link, "dir")

				try {
					let graph = loadModuleGraph(
						path.join(directory, "Main.es"),
						diskModuleHost,
					)

					expect(
						relativePathsOf(directory, [...graph.modules.keys()]),
					).toEqual([path.join("real", "Geometry.es"), "Main.es"])

					// Each entry finds the one Module under the specifier it wrote.
					expect([
						...moduleAt(directory, graph, "Main.es").resolutions,
					]).toEqual([
						[
							"./real/Geometry.es",
							path.join(directory, "real", "Geometry.es"),
						],
						[
							"./link/Geometry.es",
							path.join(directory, "real", "Geometry.es"),
						],
					])
				} finally {
					// The link is removed on its own, before the recursive removal
					// of its directory.
					rmSync(link, { force: true })
				}
			},
		)
	})

	// A graph whose files exist only in an Editor, as for the Language Server.
	// Nothing touches disk.
	it("loads a graph entirely from a host that reads no files", () => {
		let directory = canonicalPath(
			path.join(tmpdir(), `essence-unsaved-${process.pid}`),
		)
		let host = memoryHost({
			[path.join(directory, "Main.es")]: `import {
	from "./Geometry.es" { Rectangle }
}

${moduleProgram()}`,
			[path.join(directory, "Geometry.es")]: moduleProgram(),
		})

		let graph = loadModuleGraph(path.join(directory, "Main.es"), host)

		expect(relativePathsOf(directory, [...graph.modules.keys()])).toEqual([
			"Geometry.es",
			"Main.es",
		])
		expect(
			[...graph.modules.values()].every(
				(module) => module.diagnostics.length === 0,
			),
		).toBe(true)
	})
})

// The whole stage: entry in, one linked Module per file out. The graph and the
// linker are never used apart.
function linkProject(directory: string, entry: string) {
	return linkModuleGraph(
		loadModuleGraph(path.join(directory, entry), diskModuleHost),
	)
}

function linkedAt(
	directory: string,
	linked: { modules: Map<string, LinkedModule> },
	name: string,
): LinkedModule {
	let module = linked.modules.get(path.join(directory, name))

	if (module === undefined) {
		throw new Error(`no Module '${name}' in the linked graph`)
	}

	expectNoPathShown(module.diagnostics, directory)

	return module
}

// One Module's Diagnostics once the whole graph is analysed, the Validator
// included.
function analysedAt(
	directory: string,
	entry: string,
	name: string,
): Array<common.Diagnostic> {
	let analyses = analyseLinkedModules([
		...linkProject(directory, entry).modules.values(),
	])
	let diagnostics = analyses?.get(path.join(directory, name)) ?? []

	expectNoPathShown(diagnostics, directory)

	return diagnostics
}

// A Protocol's identity carries its Module's path, which neither a message
// nor a fix may show. `data.modulePath` holds the canonical path on purpose.
function expectNoPathShown(
	diagnostics: Array<common.Diagnostic>,
	directory: string,
): void {
	for (let diagnostic of diagnostics) {
		let data: Record<string, unknown> = { ...diagnostic.data }

		expect(
			JSON.stringify([
				diagnostic.message,
				diagnostic.labels.map((label) => label.message),
				diagnostic.notes,
				diagnostic.helps,
				data["protocol"],
				data["names"],
				data["parameter"],
			]),
		).not.toContain(directory)
	}
}

function codesOf(diagnostics: Array<common.Diagnostic>) {
	return diagnostics.map((diagnostic) => diagnostic.code)
}

function reportsOf(diagnostics: Array<common.Diagnostic>) {
	return diagnostics.map((diagnostic) => [
		diagnostic.code,
		diagnostic.message,
	])
}

describe("Module Linking", () => {
	// One entry carries its name across every table, so a `type Shape` and a
	// Namespace `Shape` travel together off one import.
	it("reads an export surface off the Module's own declarations", () => {
		withProject(
			{
				"Geometry.es": `implementation {
	type Rectangle = { width: Integer }

	namespace Rectangle for Rectangle {
		static of(width: Integer) -> Rectangle {
			<- { width = width }
		}
	}

	protocol Sized {
		size() -> Integer
	}

	constant ORIGIN = 0

	function widen(_ shape: Rectangle) -> Rectangle {
		<- Rectangle.of(width shape.width::add(1))
	}
}

export {
	ORIGIN
	Rectangle
	Sized
	widen
}
`,
			},
			(directory) => {
				let { surface } = linkedAt(
					directory,
					linkProject(directory, "Geometry.es"),
					"Geometry.es",
				)

				expect(surface.kinds).toEqual({
					ORIGIN: "constant",
					Rectangle: "type",
					Sized: "protocol",
					widen: "function",
				})
				expect(Object.keys(surface.values).sort()).toEqual([
					"ORIGIN",
					"Rectangle",
					"widen",
				])
				expect(Object.keys(surface.types)).toEqual(["Rectangle"])
				expect(Object.keys(surface.protocols)).toEqual(["Sized"])
				expect(surface.values["Rectangle"]?.type).toBe("Namespace")
				expect([...surface.constants].sort()).toEqual([
					"ORIGIN",
					"Rectangle",
					"widen",
				])
			},
		)
	})

	// Private by default. `hidden` is declared and reachable inside its own
	// Module and nowhere else, which is the whole of the visibility rule.
	it("keeps a declaration the export block does not list out of the surface", () => {
		withProject(
			{
				"Library.es": `implementation {
	function shown() -> Integer {
		<- 1
	}

	function hidden() -> Integer {
		<- 2
	}
}

export {
	shown
}
`,
			},
			(directory) => {
				expect(
					Object.keys(
						linkedAt(
							directory,
							linkProject(directory, "Library.es"),
							"Library.es",
						).surface.kinds,
					),
				).toEqual(["shown"])
			},
		)
	})

	it("applies an 'as' on the export side and on the import side", () => {
		withProject(
			{
				"Main.es": `import {
	from "./Geometry.es" { measure as area }
}

implementation {
	Terminal.inspect(area(3)::toString())
}
`,
				"Geometry.es": `implementation {
	function widthOf(_ width: Integer) -> Integer {
		<- width
	}
}

export {
	widthOf as measure
}
`,
			},
			(directory) => {
				let linked = linkProject(directory, "Main.es")

				expect(
					Object.keys(
						linkedAt(directory, linked, "Geometry.es").surface
							.kinds,
					),
				).toEqual(["measure"])

				let main = linkedAt(directory, linked, "Main.es")

				expect(main.diagnostics).toEqual([])
			},
		)
	})

	// A facade does not bind what it forwards, and a chain of them answers with
	// the declaring Module's own Type.
	it("forwards a name through a chain of re-exports", () => {
		withProject(
			{
				"Main.es": `import {
	from "./Facade.es" { Shape }
}

implementation {
	function widthOf(_ shape: Shape) -> Integer {
		<- shape.width
	}

	Terminal.inspect(widthOf({ width = 2 })::toString())
}
`,
				"Facade.es": `implementation {}

export {
	from "./Inner.es" { Rectangle as Shape }
}
`,
				"Inner.es": `implementation {
	type Rectangle = { width: Integer }
}

export {
	Rectangle
}
`,
			},
			(directory) => {
				let linked = linkProject(directory, "Main.es")

				expect(
					linkedAt(directory, linked, "Facade.es").surface.kinds,
				).toEqual({ Shape: "type" })
				expect(
					linkedAt(directory, linked, "Main.es").diagnostics,
				).toEqual([])
			},
		)
	})

	it("refuses an import of a name the dependency keeps private", () => {
		withProject(
			{
				"Main.es": `import {
	from "./Library.es" { hidden }
	from "./Library.es" { absent }
}

implementation {}
`,
				"Library.es": `implementation {
	function hidden() -> Integer {
		<- 1
	}
}

export {}
`,
			},
			(directory) => {
				expect(
					reportsOf(
						linkedAt(
							directory,
							linkProject(directory, "Main.es"),
							"Main.es",
						).diagnostics,
					),
				).toEqual([
					// `absent` first, although `hidden` was written first: the
					// entries are read in canonical order.
					[
						"unknown-export",
						"./Library.es declares nothing named 'absent'",
					],
					[
						"not-exported",
						"'hidden' is not exported by ./Library.es",
					],
				])
			},
		)
	})

	// A declaration published under another name is asked for by that name. A
	// Module publishing nothing has no block to add to. Any other name is a near
	// miss against the real exports.
	it("answers a refused entry from the dependency's own surface", () => {
		let library = (exports: string) =>
			`implementation {
	function area(_ side: Integer) -> Integer {
		<- side::multiply(with side)
	}
}
${exports}`

		let helpsFor = (exports: string, name: string): Array<string> =>
			withProject(
				{
					"Main.es": `import {\n\tfrom "./Library.es" { ${name} }\n}\n\nimplementation {}\n`,
					"Library.es": library(exports),
				},
				(directory) =>
					linkedAt(
						directory,
						linkProject(directory, "Main.es"),
						"Main.es",
					).diagnostics[0]?.helps as Array<string>,
			)

		expect(
			helpsFor("\nexport {\n\tarea as squareArea\n}\n", "area"),
		).toEqual([
			"./Library.es exports it as 'squareArea' — import that name instead: 'squareArea as area'.",
		])
		expect(
			helpsFor("\nexport {\n\tarea as squareArea\n}\n", "area as tile"),
		).toEqual([
			"./Library.es exports it as 'squareArea' — import that name instead: 'squareArea as tile'.",
		])

		expect(helpsFor("\nexport {}\n", "area")).toEqual([
			"Open an 'export { … }' block in ./Library.es and list 'area' in it.",
		])

		expect(helpsFor("\nexport {\n\tarea\n}\n", "aera")).toEqual([
			"Did you mean 'area'?",
			"Check the spelling, and that the specifier names the file you meant.",
		])
	})

	it("compiles once the name is listed in an export block", () => {
		let library = (exports: string) => `implementation {
	function area(_ side: Integer) -> Integer {
		<- side::multiply(with side)
	}

	function perimeter(_ side: Integer) -> Integer {
		<- side::multiply(with 4)
	}
}
${exports}`
		let main = `import {
	from "./Library.es" { area }
}

implementation {
	Terminal.print(area(2))
}
`

		for (let exports of ["", "\nexport {\n\tperimeter\n}\n"]) {
			expect(
				compiles({ "Main.es": main, "Library.es": library(exports) }),
			).toBe(false)
		}

		expect(
			compiles({
				"Main.es": main,
				"Library.es": library("\nexport {\n\tarea\n\tperimeter\n}\n"),
			}),
		).toBe(true)
		expect(
			compiles({
				"Main.es": main,
				"Library.es": library("\nexport {\n\tarea\n}\n"),
			}),
		).toBe(true)
	})

	// The entry keeps the name this file reads, so no use of it changes.
	it("compiles once a renamed export is imported under the file's name", () => {
		let library = `implementation {
	function area(_ side: Integer) -> Integer {
		<- side::multiply(with side)
	}
}

export {
	area as squareArea
}
`
		let main = (entry: string) => `import {
	from "./Library.es" { ${entry} }
}

implementation {
	Terminal.print(area(2))
}
`

		expect(
			compiles({ "Main.es": main("area"), "Library.es": library }),
		).toBe(false)
		expect(
			compiles({
				"Main.es": main("squareArea as area"),
				"Library.es": library,
			}),
		).toBe(true)
	})

	// Where the block lists the declaration under another name, the Note
	// states the `as` rule.
	it("names the 'as' rule in the not-exported Note", () => {
		withProject(
			{
				"Main.es": `import {\n\tfrom "./Library.es" { area }\n}\n\nimplementation {}\n`,
				"Library.es": `implementation {
	function area(_ side: Integer) -> Integer {
		<- side::multiply(with side)
	}
}

export {
	area as squareArea
}
`,
			},
			(directory) => {
				expect(
					linkedAt(
						directory,
						linkProject(directory, "Main.es"),
						"Main.es",
					).diagnostics[0]?.notes,
				).toEqual([
					"A name is private unless the Module's 'export { … }' block lists it.",
					"An 'as' on an export entry renames the declaration for everyone, so a name the block lists under another one stays private under this one.",
				])
			},
		)
	})

	// `B.es` declares `perimeter` at the Position `A.es` declares `area`
	// at, and `A.es` forwards the one while keeping the other private.
	it("does not take a forwarded declaration for a private one at its Position", () => {
		withProject(
			{
				"Main.es": `import {\n\tfrom "./A.es" { area }\n}\n\nimplementation {}\n`,
				"A.es": `implementation {
	function area() -> Integer {
		<- 1
	}
}

export {
	from "./B.es" { perimeter }
}
`,
				"B.es": `implementation {
	function perimeter() -> Integer {
		<- 4
	}
}

export {
	perimeter
}
`,
			},
			(directory) => {
				let refusal = linkedAt(
					directory,
					linkProject(directory, "Main.es"),
					"Main.es",
				).diagnostics[0]

				expect(refusal?.code).toBe("not-exported")
				expect(refusal?.helps).toEqual([
					"Add 'area' to the 'export { … }' block of ./A.es.",
				])
				expect(refusal?.notes).toEqual([
					"A name is private unless the Module's 'export { … }' block lists it.",
				])
			},
		)
	})

	// All three collisions are one mistake, a taken name, so one Diagnostic.
	// The entry gives way, so whatever held the name keeps its meaning.
	it("refuses an import that shadows a builtin, a declaration or another import", () => {
		withProject(
			{
				"Main.es": `import {
	from "./Library.es" { String }
	from "./Library.es" { local }
	from "./Library.es" { first }
	from "./Library.es" { second as first }
}

implementation {
	function local() -> Integer {
		<- 0
	}

	Terminal.inspect(local()::toString())
	Terminal.inspect("literal"::append(""))
}
`,
				"Library.es": `implementation {
	function String() -> Integer {
		<- 1
	}

	function local() -> Integer {
		<- 2
	}

	function first() -> Integer {
		<- 3
	}

	function second() -> Integer {
		<- 4
	}
}

export {
	String
	first
	local
	second
}
`,
			},
			(directory) => {
				let main = linkedAt(
					directory,
					linkProject(directory, "Main.es"),
					"Main.es",
				)

				expect(codesOf(main.diagnostics)).toEqual([
					"duplicate-import",
					"duplicate-import",
					"duplicate-import",
					"unused-import",
				])
				expect(
					main.diagnostics
						.filter(
							(diagnostic) =>
								diagnostic.code === "duplicate-import",
						)
						.map((diagnostic) => diagnostic.message),
				).toEqual([
					"'String' is already declared here",
					"'local' is already declared here",
					// The entry read later loses: `first` binds, and `second as
					// first` collides with it.
					"'first' is already declared here",
				])
			},
		)
	})

	it("compiles once the entry binds another name with 'as'", () => {
		let library = `implementation {
	function area(_ side: Integer) -> Integer {
		<- side::multiply(with side)
	}
}

export {
	area
}
`
		let main = (entry: string) => `import {
	from "./Library.es" { ${entry} }
}

implementation {
	constant area = 4

	Terminal.print(area)
	Terminal.print(tileArea(2))
}
`

		expect(
			compiles({
				"Main.es": main("area as tileArea"),
				"Library.es": library,
			}),
		).toBe(true)
	})

	// A Method call is emitted under the Namespace's name, so an aliased import
	// binds a copy of the Namespace Type under the local name.
	it("binds an aliased Namespace under the name the import gave it", () => {
		withProject(
			{
				"Main.es": `import {
	from "./Geometry.es" { Measurable as Sizing }
	from "./Geometry.es" { Rectangle }
}

implementation {
	function areaOf(_ shape: Rectangle) -> Integer {
		<- shape::area()
	}

	Terminal.inspect(areaOf({ width = 2, height = 3 })::toString())
}
`,
				"Geometry.es": `implementation {
	type Rectangle = { width: Integer, height: Integer }

	namespace Measurable for Rectangle {
		area() -> Integer {
			<- @.width::multiply(with @.height)
		}
	}
}

export {
	Measurable
	Rectangle
}
`,
			},
			(directory) => {
				let linked = linkProject(directory, "Main.es")
				let main = linkedAt(directory, linked, "Main.es")

				expect(main.diagnostics).toEqual([])

				let namespaceNames = new Set<string>()
				let visit = (node: unknown): void => {
					if (node === null || typeof node !== "object") {
						return
					}

					let record = node as Record<string, unknown>

					if (record["nodeType"] === "MethodInvocation") {
						namespaceNames.add(
							(record["namespace"] as Record<string, unknown>)[
								"name"
							] as string,
						)
					}

					for (let value of Object.values(record)) {
						visit(value)
					}
				}

				visit(main.program)

				expect(namespaceNames).toContain("Sizing")
				expect(namespaceNames).not.toContain("Measurable")
				expect(
					linkedAt(directory, linked, "Geometry.es").surface.values[
						"Measurable"
					],
				).toMatchObject({ type: "Namespace", name: "Measurable" })
			},
		)
	})

	// Neither Module can go first, so one hoisting pass over the group binds
	// the entries as their declarations come up.
	it("enriches a cycle of hoistable declarations in one pass", () => {
		withProject(
			{
				"A.es": `import {
	from "./B.es" { halved }
}

implementation {
	type Amount = { cents: Integer }

	function doubled(_ amount: Amount) -> Amount {
		<- { cents = amount.cents::multiply(with 2) }
	}

	function averaged(_ amount: Amount) -> Amount {
		<- halved(doubled(amount))
	}
}

export {
	Amount
	averaged
	doubled
}
`,
				"B.es": `import {
	from "./A.es" { Amount }
	from "./A.es" { doubled }
}

implementation {
	function halved(_ amount: Amount) -> Amount {
		<- { cents = amount.cents::divide(by 2)::round(toward #TowardZero) }
	}

	function quadrupled(_ amount: Amount) -> Amount {
		<- doubled(doubled(amount))
	}
}

export {
	halved
	quadrupled
}
`,
			},
			(directory) => {
				let linked = linkProject(directory, "A.es")

				for (let name of ["A.es", "B.es"]) {
					expect([
						name,
						linkedAt(directory, linked, name).diagnostics,
					]).toEqual([name, []])
				}

				expect(
					linkedAt(directory, linked, "B.es").surface.kinds,
				).toEqual({ halved: "function", quadrupled: "function" })
			},
		)
	})

	// A refinement's `type` and `namespace` share one name and hoist in
	// different rounds, so an imported entry must bind both. `marked()` exists
	// only on `Balanced`, so the answer shows it.
	it("binds both halves of a name imported across a cycle", () => {
		withProject(
			{
				"A.es": `import {
	from "./C.es" { Tag }
}

implementation {
	type Marker = { tag: Tag }

	namespace Sizes for Integer {
		isBalanced() -> Boolean {
			<- @::isGreaterThan(0)
		}
	}
}

export {
	Marker
	Sizes
}
`,
				"B.es": `import {
	from "./A.es" { Marker }
	from "./A.es" { Sizes }
}

implementation {
	type Balanced = Integer where @::isBalanced()

	namespace Balanced for Balanced {
		marked() -> Marker {
			<- { tag = "balanced" }
		}
	}
}

export {
	Balanced
}
`,
				"C.es": `import {
	from "./B.es" { Balanced }
}

implementation {
	type Tag = String

	function tagOf(_ value: Balanced) -> Tag {
		<- value::marked().tag
	}
}

export {
	Tag
	tagOf
}
`,
			},
			(directory) => {
				let linked = linkProject(directory, "A.es")

				for (let name of ["A.es", "B.es", "C.es"]) {
					expect([
						name,
						reportsOf(
							linkedAt(directory, linked, name).diagnostics,
						),
					]).toEqual([name, []])
				}
			},
		)
	})

	// `Fits` is read once `Fitting` is bound in `B.es`, and reading it
	// checks the `5` against `Small`, whose predicate is still unread then.
	it("fills a predicate across a cycle that waits on another one", () => {
		withProject(
			{
				"A.es": `import {
	from "./B.es" { Fits }
}

implementation {
	type Small = Integer where @::isLessThan(10)

	namespace Fitting for Integer {
		fits(_ limit: Small) -> Boolean {
			<- @::isLessThan(limit)
		}
	}

	function checked(_ value: Fits) -> Integer {
		<- value
	}
}

export {
	Fitting
	checked
}
`,
				"B.es": `import {
	from "./A.es" { Fitting }
}

implementation {
	type Fits = Integer where @::fits(5)
}

export {
	Fits
}
`,
			},
			(directory) => {
				let linked = linkProject(directory, "A.es")

				for (let name of ["A.es", "B.es"]) {
					expect([
						name,
						reportsOf(
							linkedAt(directory, linked, name).diagnostics,
						),
					]).toEqual([name, []])
				}
			},
		)
	})

	// `Five` is read through the body of `fitsFive`, which waits on
	// `Small`. `Greeter` waits on `Five`, so it hoists only if the round that
	// fills `Small` is followed by one that reads the body again.
	it("hoists a declaration across a cycle that waits on a predicate read through a Method body", () => {
		withProject(
			{
				"A.es": `import {
	from "./B.es" { Five }
}

implementation {
	function greeting() -> Integer {
		<- Greeter.hello
	}

	type Small = Integer where @::isLessThan(10)

	namespace Fitting for Integer {
		fits(_ limit: Small) -> Boolean {
			<- @::isLessThan(limit)
		}

		fitsFive() -> Boolean {
			<- @::fits(5)
		}
	}

	function checked(_ value: Five) -> Integer {
		<- value
	}

	namespace Greeter {
		static hello = checked(3)
	}
}

export {
	Fitting
	greeting
}
`,
				"B.es": `import {
	from "./A.es" { Fitting }
}

implementation {
	type Five = Integer where @::fitsFive()
}

export {
	Five
}
`,
			},
			(directory) => {
				let linked = linkProject(directory, "A.es")

				for (let name of ["A.es", "B.es"]) {
					expect([
						name,
						reportsOf(
							linkedAt(directory, linked, name).diagnostics,
						),
					]).toEqual([name, []])
				}
			},
		)
	})

	// A Constant does not hoist, so across a cycle its emitted binding would be
	// read in its temporal dead zone.
	// Each Module reads the other's Constant inside a body that runs once both
	// have loaded. The bundle runs from either entry.
	it("reads a Constant across a cycle inside the bodies of both Modules", async () => {
		let files = {
			"A.es": `import {
	from "./B.es" { SCALE }
}

implementation {
	constant OFFSET = 10

	function scaled(_ value: Integer) -> Integer {
		<- value::multiply(with SCALE)
	}
}

export {
	OFFSET
	scaled
}
`,
			"B.es": `import {
	from "./A.es" { OFFSET scaled }
}

implementation {
	constant SCALE = 3

	function shifted(_ value: Integer) -> Integer {
		<- scaled(value)::add(OFFSET)
	}
}

export {
	SCALE
	shifted
}
`,
		}

		for (let [first, second] of [
			["A.es", "B.es"],
			["B.es", "A.es"],
		]) {
			await withBuiltProject(
				{
					...files,
					"Main.es": `import {
	from "./${first}" { ${first === "A.es" ? "scaled" : "shifted"} }
	from "./${second}" { ${second === "A.es" ? "scaled" : "shifted"} }
}

implementation {
	Terminal.print(scaled(2))
	Terminal.print(shifted(2))
}
`,
				},
				async (directory) => {
					expect(
						await runBundle(
							generateModules(linkProject(directory, "Main.es")),
							directory,
						),
					).toEqual(["6", "16"])
				},
			)
		}
	})

	// `A.es` waits for `SCALE`, which `B.es` declares below a body waiting
	// for `OFFSET`, which `A.es` declares below the first wait.
	const waitingCycle = (scale: string) => ({
		"A.es": `import {
	from "./B.es" { SCALE }
}

implementation {
	function scaled(_ value: Integer) -> Integer {
		<- value::multiply(with SCALE)
	}

	constant OFFSET = 10
}

export {
	OFFSET
	scaled
}
`,
		"B.es": `import {
	from "./A.es" { OFFSET scaled }
}

implementation {
${scale}
}

export {
	SCALE
	shifted
}
`,
		"Main.es": `import {
	from "./A.es" { scaled }
	from "./B.es" { shifted }
}

implementation {
	Terminal.print(scaled(2))
	Terminal.print(shifted(2))
}
`,
	})

	it("refuses a Constant every Module of a cycle waits for", async () => {
		withProject(
			waitingCycle(`	function shifted(_ value: Integer) -> Integer {
		<- scaled(value)::add(OFFSET)
	}

	constant SCALE = 3`),
			(directory) => {
				let linked = linkProject(directory, "Main.es")
				let a = linkedAt(directory, linked, "A.es")
				let [refusal] = a.diagnostics

				expect(reportsOf(a.diagnostics)).toEqual([
					[
						"cyclic-constant-import",
						"Constant 'SCALE' is read before ./B.es declares it",
					],
				])
				expect(
					refusal?.labels.map((label) => [
						label.position.start.line,
						label.message,
					]),
				).toEqual([
					[7, "this needs the Type of 'SCALE'"],
					[2, "imported from a Module of this cycle"],
				])
				expect(refusal?.helps).toEqual([
					"Annotate 'SCALE' with its Type in ./B.es: 'constant SCALE: Type = …'.",
					"Or declare 'SCALE' above the Statements of ./B.es that read a Constant of this cycle, or move it into a Module outside the cycle.",
				])
				// The name is bound as an Error, so `B.es` reads on.
				expect(linkedAt(directory, linked, "B.es").diagnostics).toEqual(
					[],
				)
			},
		)

		// Each Help followed.
		for (let scale of [
			`	function shifted(_ value: Integer) -> Integer {
		<- scaled(value)::add(OFFSET)
	}

	constant SCALE: Integer = 3`,
			`	constant SCALE = 3

	function shifted(_ value: Integer) -> Integer {
		<- scaled(value)::add(OFFSET)
	}`,
		]) {
			await withBuiltProject(waitingCycle(scale), async (directory) => {
				expect(
					await runBundle(
						generateModules(linkProject(directory, "Main.es")),
						directory,
					),
				).toEqual(["6", "16"])
			})
		}
	})

	// Imports the Modules of the cycle in `order`.
	const mainOf = (order: Array<string>) => `import {
${order.map((name) => `	from "./${name}" { ${name === "A.es" ? "f" : "g"} }`).join("\n")}
}

implementation {
	Terminal.print(f())
	Terminal.print(g())
}
`

	// Each Module reads the other's Constant in a Function written above its
	// own Constant. Only a Constant written without its Type waits.
	const mutualCycle = (
		a: string,
		k: string,
		main: string = mainOf(["A.es", "B.es"]),
	) => ({
		"A.es": `import {
	from "./B.es" { k }
}

implementation {
	function f() -> Integer {
		<- k
	}

	${a}
}

export {
	a
	f
}
`,
		"B.es": `import {
	from "./A.es" { a }
}

implementation {
	function g() -> Integer {
		<- a
	}

	${k}
}

export {
	g
	k
}
`,
		"Main.es": main,
	})

	it("binds a Constant written with its Type across a cycle before its Statement", async () => {
		for (let [a, k] of [
			["constant a = 1", "constant k: Integer = 2"],
			["constant a: Integer = 1", "constant k = 2"],
			["constant a: Integer = 1", "constant k: Integer = 2"],
		] as const) {
			// The same Diagnostics, none, from every entry.
			withProject(mutualCycle(a, k), (directory) => {
				for (let entry of ["Main.es", "A.es", "B.es"]) {
					let linked = linkProject(directory, entry)

					for (let name of ["A.es", "B.es"]) {
						expect([
							entry,
							name,
							reportsOf(analysedAt(directory, entry, name)),
						]).toEqual([entry, name, []])
						expect(
							linkedAt(directory, linked, name).diagnostics,
						).toEqual([])
					}
				}
			})

			// The entry imports the Modules of the cycle in either order.
			for (let order of [
				["A.es", "B.es"],
				["B.es", "A.es"],
			]) {
				await withBuiltProject(
					mutualCycle(a, k, mainOf(order)),
					async (directory) => {
						expect(
							await runBundle(
								generateModules(
									linkProject(directory, "Main.es"),
								),
								directory,
							),
						).toEqual(["2", "1"])
					},
				)
			}

			// A bundle entered at a Module of the cycle loads both and reads
			// neither Constant while they load.
			for (let entry of ["A.es", "B.es"]) {
				await withBuiltProject(mutualCycle(a, k), async (directory) => {
					expect(
						await runBundle(
							generateModules(linkProject(directory, entry)),
							directory,
						),
					).toEqual([])
				})
			}
		}
	})

	it("refuses a Constant written without its Type that a cycle waits for, from every entry", async () => {
		withProject(
			mutualCycle("constant a = 1", "constant k = 2"),
			(directory) => {
				for (let entry of ["Main.es", "A.es", "B.es"]) {
					let linked = linkProject(directory, entry)
					let { diagnostics } = linkedAt(directory, linked, "A.es")

					expect([entry, reportsOf(diagnostics)]).toEqual([
						entry,
						[
							[
								"cyclic-constant-import",
								"Constant 'k' is read before ./B.es declares it",
							],
						],
					])
					expect(diagnostics[0]?.helps).toEqual([
						"Annotate 'k' with its Type in ./B.es: 'constant k: Type = …'.",
						"Or declare 'k' above the Statements of ./B.es that read a Constant of this cycle, or move it into a Module outside the cycle.",
					])
					expect(
						linkedAt(directory, linked, "B.es").diagnostics,
					).toEqual([])
				}
			},
		)

		// The first Help followed.
		expect(
			compiles(mutualCycle("constant a = 1", "constant k: Integer = 2")),
		).toBe(true)
		await withBuiltProject(
			mutualCycle("constant a = 1", "constant k: Integer = 2"),
			async (directory) => {
				expect(
					await runBundle(
						generateModules(linkProject(directory, "Main.es")),
						directory,
					),
				).toEqual(["2", "1"])
			},
		)
	})

	// The refinement is the Type `A.es` reads, and `B.es` still checks its value
	// against it.
	it("checks a Constant written with a refinement across a cycle against it", async () => {
		let refined = (value: string) =>
			mutualCycle(
				"constant a = 1",
				`constant k: PositiveInteger = ${value}`,
			)
		let halving = (files: Record<string, string>) => ({
			...files,
			"A.es": files["A.es"]!.replace(
				`	function f() -> Integer {
		<- k
	}`,
				`	function halved(_ value: PositiveInteger) -> Integer {
		<- value::quotient(dividingBy 2)
	}

	function f() -> Integer {
		<- halved(k)
	}`,
			),
		})

		await withBuiltProject(halving(refined("4")), async (directory) => {
			expect(
				await runBundle(
					generateModules(linkProject(directory, "Main.es")),
					directory,
				),
			).toEqual(["2", "1"])
		})

		withProject(halving(refined("0")), (directory) => {
			for (let entry of ["Main.es", "A.es", "B.es"]) {
				expect([
					entry,
					codesOf(analysedAt(directory, entry, "A.es")),
					codesOf(analysedAt(directory, entry, "B.es")),
				]).toEqual([
					entry,
					["dependency-has-errors"],
					["assignment-type-mismatch"],
				])
			}
		})
	})

	// The Union reads the predicates of `Small` and `Big`, which the hoist
	// fills only after its last seeding.
	it("binds a Constant whose written Type needs the hoist's last fill", async () => {
		let files = mutualCycle(
			"constant a = 1",
			`type Small = Integer where @::isLessThan(10)

	type Big = Integer where @::isGreaterThan(100)

	constant s: Small = 3

	constant k: Small | Big = s`,
		)

		files["A.es"] = files["A.es"]
			.replace("function f() -> Integer {", "function f() -> Boolean {")
			.replace("<- k\n", "<- k::isLessThan(50)\n")

		await withBuiltProject(files, async (directory) => {
			expect(
				await runBundle(
					generateModules(linkProject(directory, "Main.es")),
					directory,
				),
			).toEqual(["true", "1"])
		})
	})

	// `k` binds as an Error once the hoist is over, so only `B.es` reports the
	// annotation and `A.es` reads on.
	it("reports a written Type that does not resolve once, where it is written", () => {
		for (let [k, code] of [
			["constant k: Nope = 2", "unknown-type"],
			[
				`choice Tree {
		Leaf,
		Node { child: Tree },
	}

	constant k: Tree = #Leaf`,
				"recursive-type-declaration",
			],
		] as const) {
			withProject(mutualCycle("constant a = 1", k), (directory) => {
				for (let entry of ["Main.es", "A.es", "B.es"]) {
					expect([
						entry,
						codesOf(analysedAt(directory, entry, "A.es")),
						codesOf(analysedAt(directory, entry, "B.es")),
					]).toEqual([entry, ["dependency-has-errors"], [code]])
				}
			})
		}
	})

	// The Constant is marked as one before its Statement binds it.
	it("refuses an assignment to a Constant written with its Type in another Module of the cycle", () => {
		let files = mutualCycle("constant a = 1", "constant k: Integer = 2")

		files["A.es"] = files["A.es"].replace("<- k\n", "k = 3\n\n\t\t<- k\n")

		withProject(files, (directory) => {
			for (let entry of ["Main.es", "A.es", "B.es"]) {
				expect([
					entry,
					codesOf(analysedAt(directory, entry, "A.es")),
				]).toEqual([entry, ["constant-reassignment"]])
			}
		})
	})

	// The annotation types the whole value, so `k` itself has none.
	it("refuses a Constant a cycle waits for that a Pattern written with a Type binds", () => {
		withProject(
			mutualCycle(
				"constant a = 1",
				"constant { k }: { k: Integer } = { k = 2 }",
			),
			(directory) => {
				let { diagnostics } = linkedAt(
					directory,
					linkProject(directory, "Main.es"),
					"A.es",
				)

				expect(reportsOf(diagnostics)).toEqual([
					[
						"cyclic-constant-import",
						"Constant 'k' is read before ./B.es declares it",
					],
				])
				expect(diagnostics[0]?.helps).toEqual([
					"Declare 'k' above the Statements of ./B.es that read a Constant of this cycle, or move it into a Module outside the cycle.",
				])
			},
		)
	})

	// `Size` hoists in `A.es`, and `B.es` binds it in the seeding that follows,
	// so the annotation of `k` resolves only once that seeding has run.
	it("binds a Constant whose written Type another Module of the cycle declares", async () => {
		let files = mutualCycle(
			"constant a = 1",
			"constant k: Size = { width = 3, height = 4 }",
		)

		files["A.es"] = files["A.es"]
			.replace("<- k\n", "<- k.width\n")
			.replace(
				"constant a = 1",
				"type Size = { width: Integer, height: Integer }\n\n\tconstant a = 1",
			)
			.replace("export {\n\ta\n\tf\n", "export {\n\ta\n\tf\n\tSize\n")
		files["B.es"] = files["B.es"].replace("{ a }", "{ a Size }")

		await withBuiltProject(files, async (directory) => {
			expect(
				await runBundle(
					generateModules(linkProject(directory, "Main.es")),
					directory,
				),
			).toEqual(["3", "1"])
		})
	})

	// `k` is known before `B.es` has run, but a read while `A.es` loads may come
	// first.
	it("refuses a read of a Constant written with its Type while a Module of its cycle loads", () => {
		let files = mutualCycle("constant a = 1", "constant k: Integer = 2")

		files["A.es"] = files["A.es"]
			.replace(
				"constant a = 1",
				"constant a = 1\n\n\tconstant early = k::add(1)",
			)
			.replace("export {\n\ta\n", "export {\n\ta\n\tearly\n")

		withProject(files, (directory) => {
			for (let entry of ["Main.es", "A.es", "B.es"]) {
				expect([
					entry,
					codesOf(analysedAt(directory, entry, "A.es")),
				]).toEqual([entry, ["cyclic-load-time-use"]])
			}
		})
	})

	// `A.es` waits for `B.es`, which waits with `C.es` on each other. Only that
	// pair can not go on, so the refusal lands in one of them.
	it("refuses a wait where the waiting Modules close a cycle", () => {
		withProject(
			{
				"A.es": `import {
	from "./B.es" { k }
}

implementation {
	function f() -> Integer {
		<- k
	}
}

export {
	f
}
`,
				"B.es": `import {
	from "./A.es" { f }
	from "./C.es" { c }
}

implementation {
	function g() -> Integer {
		<- c::add(f())
	}

	constant b = 1
	constant k = 2
}

export {
	b
	g
	k
}
`,
				"C.es": `import {
	from "./B.es" { b }
}

implementation {
	function h() -> Integer {
		<- b
	}

	constant c = 3
}

export {
	c
	h
}
`,
			},
			(directory) => {
				let linked = linkProject(directory, "A.es")

				expect(
					["A.es", "B.es", "C.es"].map((name) =>
						reportsOf(
							linkedAt(directory, linked, name).diagnostics,
						),
					),
				).toEqual([
					[],
					[
						[
							"cyclic-constant-import",
							"Constant 'c' is read before ./C.es declares it",
						],
					],
					[],
				])
			},
		)
	})

	// `F.es` only forwards `k`, so the wait is on `B.es`, which declares it.
	// `F.es` finishing first says nothing about `k`.
	const forwardedWait = (b: string) => ({
		"A.es": `import {
	from "./F.es" { k }
}

implementation {
	function useK() -> Integer {
		<- k::add(1)
	}

	constant a = 1
}

export {
	a
	useK
}
`,
		"B.es": `import {
	from "./A.es" { a useK }
}

implementation {
${b}
}

export {
	k
	useA
}
`,
		"F.es": `implementation {
}

export {
	from "./B.es" {
		k
	}
}
`,
		"Main.es": `import {
	from "./A.es" { useK }
	from "./B.es" { useA }
}

implementation {
	Terminal.print(useK())
	Terminal.print(useA())
}
`,
	})

	it("refuses a wait through a forwarding Module at the Module declaring the Constant", async () => {
		withProject(
			forwardedWait(`	function useA() -> Integer {
		<- a::add(useK())
	}

	constant k = 2`),
			(directory) => {
				let a = linkedAt(
					directory,
					linkProject(directory, "Main.es"),
					"A.es",
				)

				expect(reportsOf(a.diagnostics)).toEqual([
					[
						"cyclic-constant-import",
						"Constant 'k' is read before ./B.es declares it",
					],
				])
				expect(a.diagnostics[0]?.helps).toEqual([
					"Annotate 'k' with its Type in ./B.es: 'constant k: Type = …'.",
					"Or declare 'k' above the Statements of ./B.es that read a Constant of this cycle, or move it into a Module outside the cycle.",
				])
			},
		)

		// Each Help followed.
		for (let b of [
			`	function useA() -> Integer {
		<- a::add(useK())
	}

	constant k: Integer = 2`,
			`	constant k = 2

	function useA() -> Integer {
		<- a::add(useK())
	}`,
		]) {
			await withBuiltProject(forwardedWait(b), async (directory) => {
				expect(
					await runBundle(
						generateModules(linkProject(directory, "Main.es")),
						directory,
					),
				).toEqual(["3", "4"])
			})
		}
	})

	// In `A.es` a Parameter, a default's earlier Parameter, a local Constant, a
	// binder, a label, a member and a field are all spelled `k`. None reads
	// `B.es`'s `k`, so `constant a` binds.
	it("waits only for a read of the Constant, not for a name spelled like it", async () => {
		let files = {
			"A.es": `import {
	from "./B.es" { k }
}

implementation {
	type R = { k: Integer }

	function twice(k: Integer, by factor: Integer = k) -> Integer {
		<- k::multiply(with factor)
	}

	function local(_ r: R) -> Integer {
		constant k = r.k

		<- twice(k k)
	}

	function unwrapped(_ value: Optional<Integer>) -> Integer {
		<- match value -> Integer {
			case #Value(k) { <- k }
			case #Empty    { <- 0 }
		}
	}

	constant a = 1

	function useK() -> Integer {
		<- local({ k = k })::add(unwrapped(#Empty))
	}
}

export {
	a
	useK
}
`,
			"B.es": `import {
	from "./A.es" { a }
}

implementation {
	function useA() -> Integer {
		<- a
	}

	constant k = 2
}

export {
	k
	useA
}
`,
		}

		withProject(files, (directory) => {
			expect(
				linkedAt(directory, linkProject(directory, "B.es"), "A.es")
					.diagnostics,
			).toEqual([])
		})

		await withBuiltProject(
			{
				...files,
				"Main.es": `import {
	from "./A.es" { useK }
	from "./B.es" { useA }
}

implementation {
	Terminal.print(useK())
	Terminal.print(useA())
}
`,
			},
			async (directory) => {
				expect(
					await runBundle(
						generateModules(linkProject(directory, "Main.es")),
						directory,
					),
				).toEqual(["4", "1"])
			},
		)
	})

	// `k _: Integer` writes a label and binds no name, so the body's `k` still
	// reads `B.es`'s Constant and waits for it.
	it("waits for a read of the Constant past a label that binds no name", async () => {
		let files = {
			"A.es": `import {
	from "./B.es" { k }
}

implementation {
	constant a = 1

	function useK(k _: Integer) -> Integer {
		<- k
	}
}

export {
	a
	useK
}
`,
			"B.es": `import {
	from "./A.es" { a }
}

implementation {
	function useA() -> Integer {
		<- a
	}

	constant k = 2
}

export {
	k
	useA
}
`,
		}

		withProject(files, (directory) => {
			expect(
				linkedAt(directory, linkProject(directory, "B.es"), "A.es")
					.diagnostics,
			).toEqual([])
		})

		await withBuiltProject(
			{
				...files,
				"Main.es": `import {
	from "./A.es" { useK }
	from "./B.es" { useA }
}

implementation {
	Terminal.print(useK(k 7))
	Terminal.print(useA())
}
`,
			},
			async (directory) => {
				expect(
					await runBundle(
						generateModules(linkProject(directory, "Main.es")),
						directory,
					),
				).toEqual(["2", "1"])
			},
		)
	})

	// Which Module of a cycle loads first follows the entry, and the refusal
	// does not.
	it("refuses the same wait from every entry", () => {
		withProject(
			{
				"A.es": `import {
	from "./B.es" { k }
}

implementation {
	function f() -> Integer {
		<- k
	}
}

export {
	f
}
`,
				"B.es": `import {
	from "./A.es" { f }
	from "./C.es" { c }
}

implementation {
	function g() -> Integer {
		<- c::add(f())
	}

	constant b = 1
	constant k = 2
}

export {
	b
	g
	k
}
`,
				"C.es": `import {
	from "./B.es" { b }
}

implementation {
	function h() -> Integer {
		<- b
	}

	constant c = 3
}

export {
	c
	h
}
`,
			},
			(directory) => {
				let reported = ["A.es", "B.es", "C.es"].map((entry) => {
					let linked = linkProject(directory, entry)

					return ["A.es", "B.es", "C.es"].map((name) =>
						reportsOf(
							linkedAt(directory, linked, name).diagnostics,
						),
					)
				})

				expect(reported[1]).toEqual(reported[0])
				expect(reported[2]).toEqual(reported[0])
			},
		)
	})

	// Each Module writes Functions reading the next Module's Constants, then
	// its own. A Statement binds only the entries waiting for what it
	// declares, so one surface is built per Constant.
	it("binds waiting Constants with one surface per Constant", () => {
		let modules = 6
		let constants = 10
		let files: Record<string, string> = {}

		for (let index = 0; index < modules; index++) {
			let next = (index + 1) % modules
			let names = (module: number) =>
				Array.from(
					{ length: constants },
					(_, item) => `c${module}k${item}`,
				)
			let functions = names(next).map(
				(name, item) =>
					`\tfunction f${index}k${item}() -> Integer {\n\t\t<- ${name}\n\t}\n`,
			)
			let declared = names(index).map(
				(name, item) => `\tconstant ${name} = ${item}\n`,
			)
			let body =
				index === modules - 1
					? [...declared, ...functions]
					: [...functions, ...declared]

			files[`M${index}.es`] =
				`import {\n\tfrom "./M${next}.es" { ${names(next).join(" ")} }\n}\n\n` +
				`implementation {\n${body.join("\n")}}\n\nexport {\n\t${names(index).join("\n\t")}\n}\n`
		}

		withProject(files, (directory) => {
			lateBindingWork.surfaces = 0

			let linked = linkProject(directory, "M0.es")

			expect(
				[...linked.modules.values()].flatMap(
					(module) => module.diagnostics,
				),
			).toEqual([])
			expect(lateBindingWork.surfaces).toBeLessThanOrEqual(
				modules * constants,
			)
		})
	})

	// The Constant's own Module reports its value. The reader waits for it and
	// binds the Error quietly.
	it("binds a Constant of the cycle whose value is broken without a report", () => {
		withProject(
			{
				"A.es": `import {
	from "./B.es" { SCALE }
}

implementation {
	function scaled(_ value: Integer) -> Integer {
		<- value::multiply(with SCALE)
	}
}

export {
	scaled
}
`,
				"B.es": `import {
	from "./A.es" { scaled }
}

implementation {
	constant SCALE = nowhere

	function shifted(_ value: Integer) -> Integer {
		<- scaled(value)
	}
}

export {
	SCALE
	shifted
}
`,
			},
			(directory) => {
				let linked = linkProject(directory, "A.es")

				expect(linkedAt(directory, linked, "A.es").diagnostics).toEqual(
					[],
				)
				expect(
					codesOf(linkedAt(directory, linked, "B.es").diagnostics),
				).toEqual(["unknown-name"])
			},
		)
	})

	// The same Constant imported from outside a cycle is ordinary.
	it("allows a Constant imported down a chain", () => {
		withProject(
			{
				"Main.es": `import {
	from "./Settings.es" { SCALE }
}

implementation {
	Terminal.inspect(SCALE::toString())
}
`,
				"Settings.es": `implementation {
	constant SCALE = 3
}

export {
	SCALE
}
`,
			},
			(directory) => {
				expect(
					linkedAt(
						directory,
						linkProject(directory, "Main.es"),
						"Main.es",
					).diagnostics,
				).toEqual([])
			},
		)
	})

	it("warns about a Statement that runs inside a cycle", () => {
		withProject(
			{
				"A.es": `import {
	from "./B.es" { fromB }
}

implementation {
	function fromA() -> Integer {
		<- 1
	}

	Terminal.inspect(fromB()::toString())
}

export {
	fromA
}
`,
				"B.es": `import {
	from "./A.es" { fromA }
}

implementation {
	function fromB() -> Integer {
		<- fromA()
	}
}

export {
	fromB
}
`,
			},
			(directory) => {
				let linked = linkProject(directory, "A.es")
				let a = linkedAt(directory, linked, "A.es")

				expect(codesOf(a.diagnostics)).toEqual(["cyclic-side-effects"])
				expect(a.diagnostics[0]?.severity).toBe("warning")
				expect(a.diagnostics[0]?.notes[0]).toContain("./B.es")

				// `B.es` only declares, so no order of its own shows.
				expect(linkedAt(directory, linked, "B.es").diagnostics).toEqual(
					[],
				)
			},
		)
	})

	it("warns about an import nothing reads", () => {
		withProject(
			{
				"Main.es": `import {
	from "./Library.es" { kept }
	from "./Library.es" { unread }
}

implementation {
	Terminal.inspect(kept()::toString())
}
`,
				"Library.es": `implementation {
	function kept() -> Integer {
		<- 1
	}

	function unread() -> Integer {
		<- 2
	}
}

export {
	kept
	unread
}
`,
			},
			(directory) => {
				let main = linkedAt(
					directory,
					linkProject(directory, "Main.es"),
					"Main.es",
				)

				expect(reportsOf(main.diagnostics)).toEqual([
					["unused-import", "'unread' is imported and never used"],
				])
				expect(main.diagnostics[0]?.severity).toBe("warning")
				expect(main.diagnostics[0]?.tags).toEqual(["unnecessary"])
			},
		)
	})

	// Silent about a Module the Parser did not read whole, since a dropped
	// Statement may be the one that reads the import.
	it("says nothing about an import when the Parser dropped a Statement", () => {
		withProject(
			{
				"Main.es": `import {
	from "./Library.es" { kept }
}

implementation {
	constant shown = kept()::toString(
}
`,
				"Library.es": `implementation {
	function kept() -> Integer {
		<- 1
	}
}

export {
	kept
}
`,
			},
			(directory) => {
				let main = linkedAt(
					directory,
					linkProject(directory, "Main.es"),
					"Main.es",
				)

				expect(
					main.diagnostics.map((diagnostic) => diagnostic.code),
				).toEqual(["syntax-error"])
			},
		)
	})

	// A refused Pattern binder abandons only a name, and no line goes missing, so
	// imports are still counted.
	it("still counts an import in a Module that only dropped a binder", () => {
		withProject(
			{
				"Main.es": `import {
	from "./Library.es" {
		kept
		unread
	}
}

implementation {
	constant point: { x: Integer } | String = { x = 1 }

	constant read = match point -> Integer {
		case { x } as whole { <- x }
		case String { <- 0 }
	}

	Terminal.inspect(kept()::toString())
}
`,
				"Library.es": `implementation {
	function kept() -> Integer {
		<- 1
	}

	function unread() -> Integer {
		<- 2
	}
}

export {
	kept
	unread
}
`,
			},
			(directory) => {
				let main = linkedAt(
					directory,
					linkProject(directory, "Main.es"),
					"Main.es",
				)

				expect(
					main.diagnostics.map((diagnostic) => diagnostic.code),
				).toEqual(["redundant-pattern-binder", "unused-import"])
			},
		)
	})

	// A Namespace used only through `shape::area()` appears in no Identifier, only
	// on the resolved Invocation, which counts as a use.
	it("counts implicit dispatch as a use of an imported Namespace", () => {
		withProject(
			{
				"Main.es": `import {
	from "./Geometry.es" { Measurable }
	from "./Geometry.es" { Rectangle }
}

implementation {
	function areaOf(_ shape: Rectangle) -> Integer {
		<- shape::area()
	}

	Terminal.inspect(areaOf({ width = 2, height = 3 })::toString())
}
`,
				"Geometry.es": `implementation {
	type Rectangle = { width: Integer, height: Integer }

	namespace Measurable for Rectangle {
		area() -> Integer {
			<- @.width::multiply(with @.height)
		}
	}
}

export {
	Measurable
	Rectangle
}
`,
			},
			(directory) => {
				expect(
					linkedAt(
						directory,
						linkProject(directory, "Main.es"),
						"Main.es",
					).diagnostics,
				).toEqual([])
			},
		)
	})

	// A Type used only in an annotation leaves no Identifier in the typed tree, so
	// the written tree is read as well.
	it("counts an annotation as a use of an imported Type", () => {
		withProject(
			{
				"Main.es": `import {
	from "./Geometry.es" { Rectangle }
}

implementation {
	function widthOf(_ shape: Rectangle) -> Integer {
		<- shape.width
	}

	Terminal.inspect(widthOf({ width = 2 })::toString())
}
`,
				"Geometry.es": `implementation {
	type Rectangle = { width: Integer }
}

export {
	Rectangle
}
`,
			},
			(directory) => {
				expect(
					linkedAt(
						directory,
						linkProject(directory, "Main.es"),
						"Main.es",
					).diagnostics,
				).toEqual([])
			},
		)
	})

	// `Problem` reaches the file only as a Type Argument, but `::is` derives its
	// Equatable through this Module's Scope. Removing the import would break the
	// file, so it counts as a use.
	it("counts a Type reached only as a Type Argument as a use", () => {
		withProject(
			{
				"Main.es": `import {
	from "./Parsing.es" {
		Problem
		parse
	}
}

implementation {
	constant outcome = parse("abc")

	Terminal.inspect(outcome::is(#Failure(#NotANumber))::toString())
}
`,
				"Parsing.es": `implementation {
	choice Problem {
		NotANumber,
		OutOfRange,
	}

	function parse(_ text: String) -> Result<Integer, Problem> {
		if text::hasItems() {
			<- #Value(text::length())
		} else {
			<- #Failure(#NotANumber)
		}
	}
}

export {
	Problem
	parse
}
`,
			},
			(directory) => {
				expect(
					linkedAt(
						directory,
						linkProject(directory, "Main.es"),
						"Main.es",
					).diagnostics,
				).toEqual([])
			},
		)
	})

	// A Type import nothing in the file reads is still reported.
	it("still warns about a Type import nothing reaches", () => {
		withProject(
			{
				"Main.es": `import {
	from "./Shapes.es" {
		Colour
		louder
	}
}

implementation {
	Terminal.inspect(louder("hi"))
}
`,
				"Shapes.es": `implementation {
	choice Colour {
		Red,
		Green,
	}

	function louder(_ text: String) -> String {
		<- text::uppercase()
	}
}

export {
	Colour
	louder
}
`,
			},
			(directory) => {
				expect(
					reportsOf(
						linkedAt(
							directory,
							linkProject(directory, "Main.es"),
							"Main.es",
						).diagnostics,
					),
				).toEqual([
					["unused-import", "'Colour' is imported and never used"],
				])
			},
		)
	})

	// A bare Case with no Choice expected resolves through the Choices in
	// Scope, so removing the entry would leave `#Hearts` an `unknown-case`.
	it("counts a bare Case as a use of the Choice it resolves through", () => {
		withProject(
			{
				"Main.es": `import {
	from "./Cards.es" {
		Suit
		paint
	}
}

implementation {
	constant chosen = #Hearts

	Terminal.print(paint(chosen))
}
`,
				"Cards.es": `implementation {
	choice Suit {
		Hearts,
		Spades,
	}

	function paint(_ suit: Suit) -> String {
		<- match suit -> String {
			case #Hearts { <- "red" }
			case #Spades { <- "black" }
		}
	}
}

export {
	Suit
	paint
}
`,
			},
			(directory) => {
				expect(
					linkedAt(
						directory,
						linkProject(directory, "Main.es"),
						"Main.es",
					).diagnostics,
				).toEqual([])
			},
		)
	})

	// A compile that leaves the tests out never types them, so a bare Case only
	// a test writes is counted by its name.
	it("counts a bare Case only a test writes as a use, in a compile without the tests", () => {
		withProject(
			{
				"Main.es": `import {
	from "./Cards.es" { Suit }
}

implementation {
	function always() -> Integer {
		<- 1
	}
}

tests {
	test "a bare Case in a test" {
		constant chosen = #Hearts

		expect always()::is(1)
	}
}
`,
				"Cards.es": `implementation {
	choice Suit {
		Hearts,
		Spades,
	}
}

export {
	Suit
}
`,
			},
			(directory) => {
				expect(
					linkedAt(
						directory,
						linkProject(directory, "Main.es"),
						"Main.es",
					).diagnostics,
				).toEqual([])
			},
		)
	})

	// An `@example` is a test, so what it reads is read, though a compile
	// without the tests never parses it as code.
	it("counts what an @example reads as a use, in a compile without the tests", () => {
		withProject(
			{
				"Main.es": `import {
	from "./Cards.es" { Suit paint }
}

implementation {
	§§ @example
	§§   expect paint(Suit#Hearts)::is("red")
	function always() -> Integer {
		<- 1
	}
}
`,
				"Cards.es": `implementation {
	choice Suit {
		Hearts,
		Spades,
	}

	function paint(_ suit: Suit) -> String {
		<- "red"
	}
}

export {
	Suit
	paint
}
`,
			},
			(directory) => {
				expect(
					linkedAt(
						directory,
						linkProject(directory, "Main.es"),
						"Main.es",
					).diagnostics,
				).toEqual([])
			},
		)
	})

	// The test compares two Rows, which asks `Outcome` for its derived
	// `Equatable` without naming it. A compile that leaves the tests out never
	// sees that, so it counts every Choice in Scope.
	it("counts a Choice only a test reaches through a conformance as a use, in a compile without the tests", () => {
		withProject(
			{
				"Main.es": `import {
	from "./Lib.es" {
		Outcome
		rowOf
		unread
		win
	}
}

implementation {}

tests {
	test "compares two rows" {
		expect rowOf(win())::is(rowOf(win()))
	}
}
`,
				"Lib.es": `implementation {
	choice Outcome {
		Win,
		Loss,
	}

	type Row = { form: List<Outcome> }

	function rowOf(_ outcome: Outcome) -> Row {
		<- { form = [outcome] }
	}

	function win() -> Outcome {
		<- #Win
	}

	function unread() -> Integer {
		<- 0
	}
}

export {
	Outcome
	rowOf
	unread
	win
}
`,
			},
			(directory) => {
				let graph = () =>
					loadModuleGraph(
						path.join(directory, "Main.es"),
						diskModuleHost,
					)
				let reports = (linked: {
					modules: Map<string, LinkedModule>
				}) =>
					reportsOf(
						linkedAt(directory, linked, "Main.es").diagnostics,
					)
				let unread = [
					["unused-import", "'unread' is imported and never used"],
				]

				expect(reports(linkModuleGraph(graph()))).toEqual(unread)
				expect(
					reports(linkModuleGraph(graph(), { tests: true })),
				).toEqual(unread)
			},
		)
	})

	// The questions an asserted value is asked for its Help reach a Choice's
	// derive, and nothing the file wrote did, so its import stays unused.
	it("counts no use for the questions a refused assertion is asked", () => {
		withProject(
			{
				"Main.es": `import {
	from "./Library.es" { Colour favourite }
}

implementation {
	constant mine = favourite()
}

tests {
	test "colour" {
		expect mine
	}
}
`,
				"Library.es": `implementation {
	choice Colour {
		Red,
		Green,
	}

	function favourite() -> Colour {
		<- #Red
	}
}

export {
	Colour
	favourite
}
`,
			},
			(directory) => {
				expect(
					codesOf(
						linkedAt(
							directory,
							linkModuleGraph(
								loadModuleGraph(
									path.join(directory, "Main.es"),
									diskModuleHost,
								),
								{ tests: true },
							),
							"Main.es",
						).diagnostics,
					),
				).toContain("unused-import")
			},
		)
	})

	// A Choice prints through the derive only where a Namespace declared it
	// `is Printable`, and the call names neither.
	it("counts the Namespace that lets a Choice print as a use", () => {
		withProject(
			{
				"Main.es": `import {
	from "./Cards.es" { Suit SuitShow pick }
}

implementation {
	Terminal.print(pick()::toString())
}
`,
				"Cards.es": `implementation {
	choice Suit {
		Hearts,
		Spades,
	}

	namespace SuitShow for Suit is Printable {
	}

	function pick() -> Suit {
		<- Suit#Spades
	}
}

export {
	Suit
	SuitShow
	pick
}
`,
			},
			(directory) => {
				expect(
					linkedAt(
						directory,
						linkProject(directory, "Main.es"),
						"Main.es",
					).diagnostics,
				).toEqual([])
			},
		)
	})

	// Each branch of `shape::area()` runs off its own Namespace, which only the
	// dispatch names.
	it("counts each Namespace a Union receiver dispatches through as a use", () => {
		withProject(
			{
				"Main.es": `import {
	from "./Shapes.es" {
		Circle
		Square
		CircleArea
		SquareArea
	}
}

implementation {
	function areaOf(_ shape: Circle | Square) -> Integer {
		<- shape::area()
	}

	constant square: Square = { side = 3 }

	Terminal.print(areaOf(square))
}
`,
				"Shapes.es": `implementation {
	type Circle = { radius: Integer }

	type Square = { side: Integer }

	namespace CircleArea for Circle {
		area() -> Integer {
			<- @.radius::multiply(with @.radius)::multiply(with 3)
		}
	}

	namespace SquareArea for Square {
		area() -> Integer {
			<- @.side::multiply(with @.side)
		}
	}
}

export {
	Circle
	Square
	CircleArea
	SquareArea
}
`,
			},
			(directory) => {
				expect(
					linkedAt(
						directory,
						linkProject(directory, "Main.es"),
						"Main.es",
					).diagnostics,
				).toEqual([])
			},
		)
	})

	// Each branch types the Function literal anew, so `each::area()` runs off
	// `CircleArea` only in the copy the `Circle` branch holds.
	it("counts a Namespace only a dispatch branch's Function literal calls as a use", () => {
		withProject(
			{
				"Main.es": `import {
	from "./Shapes.es" {
		Circle
		Square
		CircleArea
		SquareArea
		CircleTools
		SquareTools
	}
}

implementation {
	function areaOf(_ shape: Circle | Square) -> Integer {
		<- shape::measured(by (each) { <- each::area() })
	}

	constant square: Square = { side = 3 }

	Terminal.print(areaOf(square))
}
`,
				"Shapes.es": `implementation {
	type Circle = { radius: Integer }

	type Square = { side: Integer }

	namespace CircleArea for Circle {
		area() -> Integer {
			<- @.radius::multiply(with @.radius)::multiply(with 3)
		}
	}

	namespace SquareArea for Square {
		area() -> Integer {
			<- @.side::multiply(with @.side)
		}
	}

	namespace CircleTools for Circle {
		measured(by measure: (_ circle: Circle) -> Integer) -> Integer {
			<- measure(@)
		}
	}

	namespace SquareTools for Square {
		measured(by measure: (_ square: Square) -> Integer) -> Integer {
			<- measure(@)
		}
	}
}

export {
	Circle
	Square
	CircleArea
	SquareArea
	CircleTools
	SquareTools
}
`,
			},
			(directory) => {
				expect(
					linkedAt(
						directory,
						linkProject(directory, "Main.es"),
						"Main.es",
					).diagnostics,
				).toEqual([])
			},
		)
	})

	// A Type whose values only flow through the file is no use. Nothing derives a
	// conformance off `Standing`, so removing the entry compiles.
	it("warns about a Type import whose values only flow through", () => {
		withProject(
			{
				"Main.es": `import {
	from "./Standings.es" {
		Standing
		make
	}
}

implementation {
	constant standing = make()

	Terminal.inspect(standing.points::toString())
}
`,
				"Standings.es": `implementation {
	type Standing = { points: Integer }

	function make() -> Standing {
		<- { points = 0 }
	}
}

export {
	Standing
	make
}
`,
			},
			(directory) => {
				expect(
					reportsOf(
						linkedAt(
							directory,
							linkProject(directory, "Main.es"),
							"Main.es",
						).diagnostics,
					),
				).toEqual([
					["unused-import", "'Standing' is imported and never used"],
				])
			},
		)
	})

	// The refinement's predicate names `Parity` inside the Type of `n`, but
	// nothing here calls it, so removing the entry compiles.
	it("warns about a Namespace import only a refinement's predicate names", () => {
		withProject(
			{
				"Main.es": `import {
	from "./Parity.es" {
		Even
		Parity
		halved
	}
}

implementation {
	function passOn(_ n: Even) -> Integer {
		<- halved(n)
	}
}

export {
	passOn
}
`,
				"Parity.es": `implementation {
	namespace Parity for Integer {
		isTwice() -> Boolean {
			<- @::remainder(dividingBy 2)::is(0)
		}
	}

	type Even = Integer where @::isTwice()

	function halved(_ n: Even) -> Integer {
		<- n::divide(by 2)::round(toward #TowardZero)
	}
}

export {
	Parity
	Even
	halved
}
`,
			},
			(directory) => {
				expect(
					reportsOf(
						linkedAt(
							directory,
							linkProject(directory, "Main.es"),
							"Main.es",
						).diagnostics,
					),
				).toEqual([
					["unused-import", "'Parity' is imported and never used"],
				])
			},
		)
	})

	// `isWrapped` asks `isTwice`, so its Method Type carries a predicate alias
	// naming `Parity`. The call names only `Wrapper`.
	it("warns about a Namespace import only a predicate alias names", () => {
		withProject(
			{
				"Main.es": `import {
	from "./Parity.es" {
		Parity
		Wrapper
	}
}

implementation {
	function check(_ n: Integer) -> Boolean {
		<- n::isWrapped()
	}

	Terminal.print(check(4))
}
`,
				"Parity.es": `implementation {
	namespace Parity for Integer {
		isTwice() -> Boolean {
			<- @::remainder(dividingBy 2)::is(0)
		}
	}

	namespace Wrapper for Integer {
		isWrapped() -> Boolean {
			<- @::isTwice()
		}
	}
}

export {
	Parity
	Wrapper
}
`,
			},
			(directory) => {
				expect(
					reportsOf(
						linkedAt(
							directory,
							linkProject(directory, "Main.es"),
							"Main.es",
						).diagnostics,
					),
				).toEqual([
					["unused-import", "'Parity' is imported and never used"],
				])
			},
		)
	})

	// The `if` narrows `n` only to a refinement declared in Scope, so without
	// `Even` the call is an `argument-type-mismatch`.
	it("counts a refinement Alias a narrowing establishes as a use", () => {
		withProject(
			{
				"Main.es": `import {
	from "./Parity.es" {
		Even
		Parity
		halved
	}
}

implementation {
	function halvedOrZero(_ n: Integer) -> Integer {
		if n::isTwice() {
			<- halved(n)
		}

		<- 0
	}

	Terminal.print(halvedOrZero(4))
}
`,
				"Parity.es": `implementation {
	namespace Parity for Integer {
		isTwice() -> Boolean {
			<- @::remainder(dividingBy 2)::is(0)
		}
	}

	type Even = Integer where @::isTwice()

	function halved(_ n: Even) -> Integer {
		<- n::divide(by 2)::round(toward #TowardZero)
	}
}

export {
	Parity
	Even
	halved
}
`,
			},
			(directory) => {
				expect(
					linkedAt(
						directory,
						linkProject(directory, "Main.es"),
						"Main.es",
					).diagnostics,
				).toEqual([])
			},
		)
	})

	// An imported generic refinement asks a written List about the `Item` it
	// decides. Inside the Function `Item` is opaque, so `["a"]` proves nothing.
	it("refuses a written List an imported refinement can not prove over an opaque Type Parameter", () => {
		withProject(
			{
				"Main.es": `import {
	from "./Filled.es" { Filled }
}

implementation {
	function countOf<infer Item>(_ items: Filled<Item>) -> Integer {
		constant first: Item = items::firstItem()
		constant own: Filled<Item> = [first]
		constant strings: Filled<Item> = ["a"]

		<- own::length()::add(strings::length())
	}

	Terminal.print(countOf([1, 2]))
}
`,
				"Filled.es": `implementation {
	type Filled<Item> = List<Item> where @::hasItems()
}

export {
	Filled
}
`,
			},
			(directory) => {
				let main = analysedAt(directory, "Main.es", "Main.es")

				expect(reportsOf(main)).toEqual([
					[
						"assignment-type-mismatch",
						"This value does not fit the declared Type of Constant 'strings'",
					],
				])
			},
		)
	})

	// A refined value the evaluator can not read decides the inferred `Item`
	// by its own Type, from another Module as from its own.
	it("admits an imported refined value into an inferred Parameter's written List", async () => {
		await withBuiltProject(
			{
				"Main.es": `import {
	from "./Rows.es" { nested }
}

implementation {
	constant proven: NonEmptyList<Integer> = [7, 8]

	Terminal.inspect(nested([proven, [9]]))
}
`,
				"Rows.es": `implementation {
	function nested<infer Item>(_ rows: List<NonEmptyList<Item>>) -> Integer {
		<- rows::length()
	}
}

export {
	nested
}
`,
			},
			async (directory) => {
				let sources = generateModules(
					linkModuleGraph(
						loadModuleGraph(
							path.join(directory, "Main.es"),
							diskModuleHost,
						),
					),
				)

				expect(await runBundle(sources, directory)).toEqual(["2"])
			},
		)
	})

	// A written member answers an imported refinement as a written value does,
	// in a Record, a payload and a List item alike.
	const refinedShapes = `implementation {
	type Rule = (_ n: Integer) -> Integer
	type Counted = { count: NonZeroInteger }

	choice Single {
		Full { count: NonZeroInteger },
		Empty,
	}

	function use(_ settings: Counted) -> Integer {
		<- settings.count
	}

	function apply(_ settings: { rules: NonEmptyList<Rule> }) -> Integer {
		<- settings.rules::firstItem()(3)
	}

	function fullCount(_ single: Single) -> Integer {
		<- match single -> Integer {
			case #Full(count) { <- count }
			case #Empty { <- 0 }
		}
	}
}

export {
	Counted
	Rule
	Single
	apply
	fullCount
	use
}
`

	it("admits a written member into an imported refined Record or payload", async () => {
		await withBuiltProject(
			{
				"Main.es": `import {
	from "./Shapes.es" {
		Counted
		Single
		apply
		fullCount
		use
	}
}

implementation {
	constant someRule = (_ n: Integer) -> Integer { <- n::add(1) }
	constant declared: Counted = { count = 2 }
	constant listed: List<Counted> = [{ count = 7 }]

	Terminal.print(use({ count = 1 }))
	Terminal.print(declared.count)
	Terminal.print(apply({ rules = [someRule] }))
	Terminal.print(listed::length())
	Terminal.print(fullCount(Single#Full(11)))
	Terminal.print(fullCount(#Full({ count = 12 })))
}
`,
				"Shapes.es": refinedShapes,
			},
			async (directory) => {
				let sources = generateModules(
					linkModuleGraph(
						loadModuleGraph(
							path.join(directory, "Main.es"),
							diskModuleHost,
						),
					),
				)

				expect(await runBundle(sources, directory)).toEqual([
					"1",
					"2",
					"4",
					"1",
					"11",
					"12",
				])
			},
		)
	})

	// An imported Choice's payload proves nothing about the enclosing
	// Function's own `Item`, which a caller decides.
	it("refuses a written payload as evidence about an enclosing Type Parameter", () => {
		withProject(
			{
				"Main.es": `import {
	from "./Boxes.es" { Box }
}

implementation {
	function wrap<infer Item>(_ x: Item) -> Box<Item> {
		<- #Full([1])
	}

	constant b: Box<String> = wrap("a")
}
`,
				"Boxes.es": `implementation {
	choice Box<Item> {
		Full { items: NonEmptyList<Item> },
		Empty,
	}
}

export {
	Box
}
`,
			},
			(directory) => {
				expect(
					reportsOf(analysedAt(directory, "Main.es", "Main.es")),
				).toEqual([
					[
						"payload-type-mismatch",
						"This payload does not fit Case '#Full'",
					],
				])
			},
		)
	})

	it("refuses a written member an imported refinement's predicate refuses", () => {
		withProject(
			{
				"Main.es": `import {
	from "./Shapes.es" {
		Single
		fullCount
		use
	}
}

implementation {
	Terminal.print(use({ count = 0 }))
	Terminal.print(fullCount(#Full({ count = 0 })))
}
`,
				"Shapes.es": refinedShapes,
			},
			(directory) => {
				expect(
					reportsOf(analysedAt(directory, "Main.es", "Main.es")),
				).toEqual([
					[
						"argument-type-mismatch",
						"This Argument does not fit Parameter 1",
					],
					[
						"payload-type-mismatch",
						"This payload does not fit Case '#Full'",
					],
				])
			},
		)
	})

	// A path key into an imported Function's default is asked as its merge
	// reads it.
	it("admits a written member a path key reaches into an imported default", async () => {
		await withBuiltProject(
			{
				"Main.es": `import {
	from "./Config.es" { configure }
}

implementation {
	Terminal.print(configure({ server.port = 8080, retries = 1 }))
}
`,
				"Config.es": `implementation {
	type Server = { port: PositiveInteger, host: String }
	type Settings = { server: Server, retries: NonNegativeInteger }

	function configure(_ settings: Settings = { server = { port = 80, host = "a" }, retries = 0 }) -> Integer {
		<- settings.server.port
	}
}

export {
	configure
}
`,
			},
			async (directory) => {
				let sources = generateModules(
					linkModuleGraph(
						loadModuleGraph(
							path.join(directory, "Main.es"),
							diskModuleHost,
						),
					),
				)

				expect(await runBundle(sources, directory)).toEqual(["8080"])
			},
		)
	})

	// An imported Namespace is no value either, and the Help reads a member the
	// declaring Module wrote.
	it("refuses an imported Namespace used as a value", () => {
		withProject(
			{
				"Main.es": `import {
	from "./Time.es" { Clock }
}

implementation {
	constant clock = Clock

	Terminal.inspect(Clock)
	Terminal.inspect(Clock.now())
}
`,
				"Time.es": `implementation {
	namespace Clock for Integer {
		static now() -> Integer {
			<- 7
		}
	}
}

export {
	Clock
}
`,
			},
			(directory) => {
				let main = analysedAt(directory, "Main.es", "Main.es")

				expect(reportsOf(main)).toEqual([
					[
						"namespace-as-value",
						"Namespace 'Clock' can not be used as a value",
					],
					[
						"namespace-as-value",
						"Namespace 'Clock' can not be used as a value",
					],
				])
				expect(main.flatMap((diagnostic) => diagnostic.helps)).toEqual([
					"Read a member off it, as in 'Clock.now'.",
					"Read a member off it, as in 'Clock.now'.",
				])
			},
		)
	})

	it("refuses an export of a Variable and of a name the Module does not declare", () => {
		withProject(
			{
				"Main.es": `implementation {
	variable counter = 0

	Terminal.inspect(counter::toString())
}

export {
	counter
	nowhere
}
`,
			},
			(directory) => {
				expect(
					reportsOf(
						linkedAt(
							directory,
							linkProject(directory, "Main.es"),
							"Main.es",
						).diagnostics,
					),
				).toEqual([
					[
						"export-of-variable",
						"Variable 'counter' can not be exported",
					],
					[
						"export-of-unknown-name",
						"'nowhere' is not declared in this Module",
					],
				])
			},
		)
	})

	// Where the Variable is assigned, making it a Constant would only bring
	// `constant-reassignment`, so the clause and its fix are withheld.
	it("withholds the Constant Help where the Variable is assigned", () => {
		let helpsFor = (body: string): Array<string> =>
			withProject(
				{
					"Main.es": `implementation {\n\tvariable counter = 0\n\n${body}}\n\nexport {\n\tcounter\n}\n`,
				},
				(directory) =>
					linkedAt(
						directory,
						linkProject(directory, "Main.es"),
						"Main.es",
					).diagnostics[0]?.helps as Array<string>,
			)

		expect(helpsFor("\tTerminal.inspect(counter::toString())\n")).toEqual([
			"Declare it as a Constant, or export a Function that answers with its value.",
		])

		// An assignment inside a Function body counts too.
		expect(
			helpsFor(
				"\tfunction bump() -> Integer {\n\t\tcounter = counter::add(1)\n\t\t<- counter\n\t}\n",
			),
		).toEqual(["Export a Function that answers with its value."])
	})

	// A test that assigns the Variable would meet `constant-reassignment` too.
	it("withholds the Constant Help where only a test assigns the Variable", () => {
		withProject(
			{
				"Main.es": `implementation {
	variable counter = 0

	function read() -> Integer {
		<- counter
	}
}

export {
	counter
	read
}

tests {
	test "assigns the Variable" {
		counter = 1

		expect read()::is(1)
	}
}
`,
			},
			(directory) => {
				let diagnostics = linkedAt(
					directory,
					linkProject(directory, "Main.es"),
					"Main.es",
				).diagnostics

				expect(codesOf(diagnostics)).toEqual(["export-of-variable"])
				expect(diagnostics[0]?.helps).toEqual([
					"Export a Function that answers with its value.",
				])
			},
		)
	})

	// Forwarding is offered only where a dependency has the name, and then the
	// specifier is spelled out.
	it("offers forwarding only where a dependency has the name", () => {
		withProject(
			{
				"Main.es": `import {
	from "./Money.es" { Money }
}

implementation {
	function doubled(_ price: Money) -> Money {
		<- { cents = price.cents::multiply(with 2) }
	}
}

export {
	doubled
	Money
	nowhere
}
`,
				"Money.es": `implementation {
	type Money = { cents: Integer }
}

export {
	Money
}
`,
			},
			(directory) => {
				let diagnostics = linkedAt(
					directory,
					linkProject(directory, "Main.es"),
					"Main.es",
				).diagnostics

				expect(codesOf(diagnostics)).toEqual([
					"export-of-unknown-name",
					"export-of-unknown-name",
				])

				expect(diagnostics[0]?.helps).toEqual([
					`Forward it from the Module that declares it: 'from "./Money.es" { Money }'.`,
				])

				// No Module in reach declares it, so forwarding would name
				// a file that does not exist.
				expect(diagnostics[1]?.helps).toEqual([
					"Declare 'nowhere' in this Module, or remove the entry.",
				])
			},
		)
	})

	// The canonical order, by specifier and then by name, is the order the
	// formatter writes. The searched Namespaces listing shows it.
	it("seeds imported Namespaces in canonical order, not written order", () => {
		withProject(
			{
				"Main.es": `import {
	from "./Zulu.es" { Zulu }
	from "./Alpha.es" { Alpha }
}

implementation {
	Terminal.inspect(2::missing()::toString())
}
`,
				"Alpha.es": `implementation {
	namespace Alpha for Integer {
		alpha() -> Integer {
			<- @
		}
	}
}

export {
	Alpha
}
`,
				"Zulu.es": `implementation {
	namespace Zulu for Integer {
		zulu() -> Integer {
			<- @
		}
	}
}

export {
	Zulu
}
`,
			},
			(directory) => {
				let main = linkedAt(
					directory,
					linkProject(directory, "Main.es"),
					"Main.es",
				)
				let unknownMethod = main.diagnostics.find(
					(diagnostic) => diagnostic.code === "unknown-method",
				)

				// The builtins come first, and `Alpha` precedes `Zulu` although `Zulu` was
				// written first. A written `2` proves itself non-zero and positive, so the
				// refined Namespaces are searched too.
				expect(unknownMethod?.notes[0]).toContain(
					"'Integer', 'NonZeroInteger', 'NonNegativeInteger', 'PositiveInteger', 'Scalar', 'Number', 'Alpha', 'Zulu'",
				)
			},
		)
	})

	// Without the import the report would read like a typo. The Help names the
	// Module, and the auto-import Quick Fix keys off it.
	it("names the unimported Namespace and its Module in the no-such-Method help", () => {
		withProject(
			{
				"Main.es": `import {
	from "./Geometry.es" { Rectangle }
}

implementation {
	function areaOf(_ shape: Rectangle) -> Integer {
		<- shape::area()
	}

	Terminal.inspect(areaOf({ width = 2, height = 3 })::toString())
}
`,
				"Geometry.es": `implementation {
	type Rectangle = { width: Integer, height: Integer }

	namespace Measurable for Rectangle {
		area() -> Integer {
			<- @.width::multiply(with @.height)
		}
	}
}

export {
	Measurable
	Rectangle
}
`,
			},
			(directory) => {
				let main = linkedAt(
					directory,
					linkProject(directory, "Main.es"),
					"Main.es",
				)

				expect(codesOf(main.diagnostics)).toEqual(["unknown-method"])
				expect(main.diagnostics[0]?.helps).toContain(
					"'Measurable' in ./Geometry.es declares 'area' for Rectangle — import it.",
				)
			},
		)
	})

	// Every JavaScript object answers `valueOf`, and a Namespace that
	// declares no such Method must not be offered as the one that does.
	it("names no unimported Namespace for a Method none of them declares", () => {
		withProject(
			{
				"Main.es": `import {
	from "./Geometry.es" { Rectangle }
}

implementation {
	constant shape: Rectangle = { width = 2, height = 3 }

	Terminal.inspect(shape::valueOf())
}
`,
				"Geometry.es": `implementation {
	type Rectangle = { width: Integer, height: Integer }

	namespace Measurable for Rectangle {
		area() -> Integer {
			<- @.width::multiply(with @.height)
		}
	}
}

export {
	Measurable
	Rectangle
}
`,
			},
			(directory) => {
				let main = linkedAt(
					directory,
					linkProject(directory, "Main.es"),
					"Main.es",
				)

				expect(codesOf(main.diagnostics)).toEqual(["unknown-method"])
				expect(
					main.diagnostics[0]?.helps.filter((help) =>
						help.endsWith("— import it."),
					),
				).toEqual([])
			},
		)
	})

	// The imported Namespace beside it resolves, so only the undeclared name
	// is reported, and at the specifier rather than the receiver.
	it("reports a specifier nothing declares where it is written", () => {
		withProject(
			{
				"Main.es": `import {
	from "./Shout.es" { Shout }
}

implementation {
	Terminal.print(5::<Shout>loud())
	Terminal.print(5::<Nope>loud())
}
`,
				"Shout.es": `implementation {
	namespace Shout for Integer {
		loud() -> String {
			<- @::toString()::append("!")
		}
	}
}

export {
	Shout
}
`,
			},
			(directory) => {
				let main = linkedAt(
					directory,
					linkProject(directory, "Main.es"),
					"Main.es",
				)

				expect(reportsOf(main.diagnostics)).toEqual([
					["unknown-name", "'Nope' is not declared"],
				])
				expect(main.diagnostics[0]?.position?.start).toEqual({
					line: 7,
					column: 21,
				})
			},
		)
	})

	// Nothing else writes `loud`, so dropping the specifier would not help.
	it("names what an imported Namespace a specifier names targets", () => {
		withProject(
			{
				"Main.es": `import {
	from "./Shout.es" { Shout }
}

implementation {
	Terminal.print(5::<Shout>loud())
}
`,
				"Shout.es": `implementation {
	namespace Shout for String {
		loud() -> String {
			<- @::append("!")
		}
	}
}

export {
	Shout
}
`,
			},
			(directory) => {
				let main = linkedAt(
					directory,
					linkProject(directory, "Main.es"),
					"Main.es",
				)

				expect(
					main.diagnostics.map((diagnostic) => [
						diagnostic.code,
						diagnostic.notes,
						diagnostic.helps,
					]),
				).toEqual([
					[
						"no-namespace-for-value",
						[
							"'Shout' targets String, which a PositiveInteger is not.",
						],
						[],
					],
				])
			},
		)
	})

	it("reports a pick of an imported Protocol's requirement", () => {
		withProject(
			{
				"Main.es": `import {
	from "./Sized.es" {
		Shelf
		Shelves
		Sized
	}
}

implementation {
	constant shelf: Shelf = { books = 0 }

	Terminal.print(shelf::<Sized>size())
}
`,
				"Aliased.es": `import {
	from "./Sized.es" {
		Shelf
		Shelves
		Sized as Measure
	}
}

implementation {
	constant shelf: Shelf = { books = 0 }

	Terminal.print(shelf::<Measure>size())
}
`,
				"Sized.es": `implementation {
	protocol Sized {
		size() -> Integer

		isEmpty() -> Boolean {
			<- @::size()::is(0)
		}
	}

	type Shelf = { books: Integer }

	namespace Shelves for Shelf is Sized {
		size() -> Integer {
			<- @.books
		}
	}
}

export {
	Shelf
	Shelves
	Sized
}
`,
			},
			(directory) => {
				let main = linkedAt(
					directory,
					linkProject(directory, "Main.es"),
					"Main.es",
				)
				let picked = main.diagnostics.filter(
					(diagnostic) => diagnostic.code === "picked-requirement",
				)

				expect(picked.map((diagnostic) => diagnostic.message)).toEqual([
					"'Sized' has no body for 'size'",
				])
				expect(picked[0]?.helps).toEqual([
					"Drop the pick, or pick the Namespace that writes 'size': '::<Shelves>size()'.",
				])

				// The pick is named as this Module spells it.
				let aliased = linkedAt(
					directory,
					linkProject(directory, "Aliased.es"),
					"Aliased.es",
				).diagnostics.filter(
					(diagnostic) => diagnostic.code === "picked-requirement",
				)

				expect(
					aliased.map((diagnostic) => [
						diagnostic.message,
						diagnostic.labels.map((label) => label.message),
					]),
				).toEqual([
					[
						"'Measure' has no body for 'size'",
						[
							"this picks 'Measure'",
							"'Measure' declares this without a body",
						],
					],
				])
			},
		)
	})

	it("offers the import of a Namespace a specifier names but the Module does not import", () => {
		withProject(
			{
				"Main.es": `import {
	from "./Shout.es" { quiet }
}

implementation {
	Terminal.print(quiet)
	Terminal.print(5::<Shout>loud())
}
`,
				"Shout.es": `implementation {
	constant quiet = "shh"

	namespace Shout for Integer {
		loud() -> String {
			<- @::toString()::append("!")
		}
	}
}

export {
	quiet
	Shout
}
`,
			},
			(directory) => {
				let main = linkedAt(
					directory,
					linkProject(directory, "Main.es"),
					"Main.es",
				)

				expect(main.diagnostics.map((d) => [d.code, d.helps])).toEqual([
					[
						"unknown-name",
						[
							"'Shout' in ./Shout.es is a Namespace — import it.",
							"Or drop the Namespace specifier.",
						],
					],
				])
			},
		)
	})

	// A single file compile has no graph, so no Help names a Namespace to import.
	it("says nothing about unimported Namespaces where there is no graph", () => {
		withProject(
			{
				"Main.es": `implementation {
	type Rectangle = { width: Integer, height: Integer }

	function areaOf(_ shape: Rectangle) -> Integer {
		<- shape::area()
	}
}
`,
			},
			(directory) => {
				expect(
					linkedAt(
						directory,
						linkProject(directory, "Main.es"),
						"Main.es",
					).diagnostics[0]?.helps,
				).toEqual([])
			},
		)
	})

	// `Main.es` binds no name for either Protocol, so the registry is the
	// only way back to them from an identity.
	it("registers a private Protocol and a nested one by their identities", () => {
		withProject(
			{
				"Main.es": `import {
	from "./Sized.es" { unit }
}

implementation {
	Terminal.inspect(unit)
}
`,
				"Sized.es": `implementation {
	protocol Sized {
		size() -> Integer
	}

	function tagged() -> Integer {
		protocol Sized {
			count() -> Integer
		}

		<- 1
	}

	constant unit = 1
}

export {
	unit
}
`,
			},
			(directory) => {
				let { protocols } = linkProject(directory, "Main.es")
				let sizedPath = path.join(directory, "Sized.es")
				let topLevel = protocols.get(`${sizedPath}#Sized`)
				let nested = protocols.get(`${sizedPath}#Sized@7:12`)

				expect(Object.keys(topLevel?.methods ?? {})).toEqual(["size"])
				expect(Object.keys(nested?.methods ?? {})).toEqual(["count"])
				expect(nested?.identity).toBe(`${sizedPath}#Sized@7:12`)
				expect(protocols.get("Equatable")?.identity).toBe("Equatable")
			},
		)
	})

	// `measure` is bounded by `Sized`, and `IntegerSized` is what makes an
	// Integer conform to it.
	const sizedModule = `implementation {
	protocol Sized {
		size() -> Integer
	}

	namespace IntegerSized for Integer is Sized {
		size() -> Integer {
			<- @
		}
	}

	function measure <infer Item is Sized>(_ item: Item) -> Integer {
		<- item::size()
	}
}

export {
	IntegerSized
	Sized
	measure
}
`

	// `measure`'s bound is the Protocol `Sized.es` resolved, so `Main.es`
	// needs the Namespace that conforms to it and no name for the Protocol.
	it("calls a Function bounded by a Protocol the calling Module never imported", async () => {
		await withBuiltProject(
			{
				"Main.es": `import {
	from "./Sized.es" {
		IntegerSized
		measure
	}
}

implementation {
	Terminal.inspect(measure(3))
}
`,
				"Sized.es": sizedModule,
			},
			async (directory) => {
				expect(
					await runBundle(
						generateModules(linkProject(directory, "Main.es")),
						directory,
					),
				).toEqual(["3"])
			},
		)
	})

	// The Case's Type Arguments bind the Namespace's `Item` through the
	// Namespace's own target, so `Main.es` needs no name for `Slot`.
	it("dispatches a Case of a Choice the calling Module never imported", async () => {
		await withBuiltProject(
			{
				"Main.es": `import {
	from "./Slot.es" {
		Slots
		StringDefaults
		StringSlot
		empty
	}
}

implementation {
	namespace Numbers for Integer {
		value() -> Integer {
			<- @
		}
	}

	function show(_ slot: StringSlot | Integer) -> String | Integer {
		<- slot::value()
	}

	Terminal.inspect(show(empty))
	Terminal.inspect(show(3))
}
`,
				"Slot.es": `implementation {
	protocol Defaultable {
		static default() -> Self
	}

	namespace StringDefaults for String is Defaultable {
		static default() -> String {
			<- "none"
		}
	}

	choice Slot<Item is Defaultable> {
		Full { item: Item },
		Empty,
	}

	namespace Slots<infer Item> for Slot<Item> {
		value() -> Item {
			<- match @ -> Item {
				case #Full { <- @.item }
				case #Empty { <- Item.default() }
			}
		}
	}

	type StringSlot = Slot<String>

	constant empty: StringSlot = #Empty
}

export {
	Slots
	StringDefaults
	StringSlot
	empty
}
`,
			},
			async (directory) => {
				expect(
					await runBundle(
						generateModules(linkProject(directory, "Main.es")),
						directory,
					),
				).toEqual(['"none"', "3"])
			},
		)
	})

	// The applied target `Pair<Integer, String>` takes the Case's
	// `Pair<PositiveInteger, String>`, though not the other way round.
	it("dispatches a Case whose Type Argument the Namespace's target widens", async () => {
		await withBuiltProject(
			{
				"Main.es": `import {
	from "./Lib.es" {
		StringNames
		Targets
		Value
		value
	}
}

implementation {
	namespace Flags for Boolean {
		label() -> String {
			<- "flag"
		}
	}

	function show(_ input: Value | Boolean) -> String {
		<- input::label()
	}

	Terminal.print(show(value))
	Terminal.print(value::label())
}
`,
				"Lib.es": `implementation {
	protocol Named {
		static label() -> String
	}

	namespace StringNames for String is Named {
		static label() -> String {
			<- "string"
		}
	}

	choice Pair<A, B> { Both { a: A, b: B }, Neither }

	namespace Targets<infer Item> for Pair<Integer, Item> {
		label<Item is Named>() -> String {
			<- Item.label()
		}
	}

	type Value = Pair<PositiveInteger, String>

	constant value: Value = #Neither
}

export {
	StringNames
	Targets
	Value
	value
}
`,
			},
			async (directory) => {
				expect(
					await runBundle(
						generateModules(linkProject(directory, "Main.es")),
						directory,
					),
				).toEqual(["string", "string"])
			},
		)
	})

	// The Type Parameter sits inside the target's Type Argument, as in
	// `Box<List<Item>>`, and binds there.
	it("dispatches a Case whose Namespace nests its Type Parameter", async () => {
		await withBuiltProject(
			{
				"Main.es": `import {
	from "./Box.es" {
		Boxes
		Options
		StringDefaults
		StringListBox
		StringOptionBox
		empty
		emptyOption
	}
}

implementation {
	namespace Numbers for Integer {
		fallback() -> Integer {
			<- @
		}

		other() -> Integer {
			<- @
		}
	}

	function show(_ box: StringListBox | Integer) -> String | Integer {
		<- box::fallback()
	}

	function option(_ box: StringOptionBox | Integer) -> String | Integer {
		<- box::other()
	}

	Terminal.inspect(show(empty))
	Terminal.inspect(option(emptyOption))
}
`,
				"Box.es": `implementation {
	protocol Defaultable {
		static default() -> Self
	}

	namespace StringDefaults for String is Defaultable {
		static default() -> String {
			<- "none"
		}
	}

	choice Box<Item> {
		Full { item: Item },
		Empty,
	}

	namespace Boxes<infer Item> for Box<List<Item>> {
		fallback<Item is Defaultable>() -> Item {
			<- Item.default()
		}
	}

	namespace Options<infer Item> for Box<Optional<Item>> {
		other<Item is Defaultable>() -> Item {
			<- Item.default()
		}
	}

	type StringListBox = Box<List<String>>
	type StringOptionBox = Box<Optional<String>>

	constant empty: StringListBox = #Empty
	constant emptyOption: StringOptionBox = #Empty
}

export {
	Boxes
	Options
	StringDefaults
	StringListBox
	StringOptionBox
	empty
	emptyOption
}
`,
			},
			async (directory) => {
				expect(
					await runBundle(
						generateModules(linkProject(directory, "Main.es")),
						directory,
					),
				).toEqual(['"none"', '"none"'])
			},
		)
	})

	// The Type Arguments bind `Item` through `Tags`' own target, so `Main.es`
	// needs no name for `Tag`, called directly as dispatched.
	it("binds a Type Parameter a receiver's Type Arguments decide in a Module that never imported its Choice", async () => {
		await withBuiltProject(
			{
				"Main.es": `import {
	from "./Tag.es" {
		Tags
		StringDefaults
		StringTag
		on
	}
}

implementation {
	namespace Flags for Boolean {
		fallback() -> Boolean {
			<- @
		}
	}

	function show(_ value: StringTag | Boolean) -> String | Boolean {
		<- value::fallback()
	}

	Terminal.inspect(on::fallback())
	Terminal.inspect(show(on))
	Terminal.inspect(on::wrap("a"))
}
`,
				"Tag.es": `implementation {
	protocol Defaultable {
		static default() -> Self
	}

	namespace StringDefaults for String is Defaultable {
		static default() -> String {
			<- "none"
		}
	}

	choice Tag<Item> {
		On,
		Off,
	}

	namespace Tags<infer Item> for Tag<Item> {
		fallback<Item is Defaultable>() -> Item {
			<- Item.default()
		}

		wrap(_ x: Item) -> List<Item> {
			<- [x]
		}
	}

	type StringTag = Tag<String>

	constant on: StringTag = #On
}

export {
	StringDefaults
	StringTag
	Tags
	on
}
`,
			},
			async (directory) => {
				expect(
					await runBundle(
						generateModules(linkProject(directory, "Main.es")),
						directory,
					),
				).toEqual(['"none"', '"none"', '[ "a" ]'])
			},
		)
	})

	// `Main.es` names no `Tag`, and `Lists` targets another application of it,
	// so neither the direct call nor the dispatch reaches `Lists`.
	it("runs no Namespace for another application of a Choice the calling Module never imported", () => {
		withProject(
			{
				"Main.es": `import {
	from "./Tag.es" {
		IntegerTag
		Lists
		on
	}
}

implementation {
	namespace Flags for Boolean {
		describe() -> String {
			<- "flag"
		}
	}

	function show(_ value: IntegerTag | Boolean) -> String {
		<- value::describe()
	}

	Terminal.print(show(on))
	Terminal.print(on::describe())
}
`,
				"Tag.es": `implementation {
	choice Tag<Item> {
		On,
		Off,
	}

	namespace Lists for Tag<List<Integer>> {
		describe() -> String {
			<- "list tag"
		}
	}

	type IntegerTag = Tag<Integer>

	constant on: IntegerTag = #On
}

export {
	IntegerTag
	Lists
	on
}
`,
			},
			(directory) => {
				expect(
					codesOf(analysedAt(directory, "Main.es", "Main.es")),
				).toEqual(["unused-import", "unknown-method", "unknown-method"])
			},
		)
	})

	// `Main.es` imports Aliases of `Pair` alone. Its phantom `B` is read off
	// `Pair`'s own Module, so `Mixed` turns `Sames` away and `Same` does not.
	it("reads a phantom Type Argument of a Choice the calling Module never imported", async () => {
		let project = (body: string) => ({
			"Main.es": `import {
	from "./Pairs.es" {
		IntegerNames
		Mixed
		Same
		Sames
	}
}

implementation {
${body}
}
`,
			"Pairs.es": `implementation {
	protocol Named {
		static label() -> String
	}

	namespace IntegerNames for Integer is Named {
		static label() -> String {
			<- "integer"
		}
	}

	choice Pair<A, B> {
		Left { a: A },
		Neither,
	}

	namespace Sames<infer Item> for Pair<Item, Item> {
		label<Item is Named>() -> String {
			<- Item.label()
		}
	}

	type Same<T> = Pair<T, T>
	type Mixed = Pair<Integer, String>
}

export {
	IntegerNames
	Mixed
	Same
	Sames
}
`,
		})

		withProject(
			project(
				"\tTerminal.inspect(Same<Integer>#Left({ a = 1 })::label())\n\tTerminal.inspect(Mixed#Left({ a = 2 })::label())",
			),
			(directory) => {
				expect(
					codesOf(analysedAt(directory, "Main.es", "Main.es")),
				).toEqual(["no-namespace-for-value"])
			},
		)
		await withBuiltProject(
			project(
				"\tconstant mixed: Mixed = #Neither\n\tTerminal.inspect(Same<Integer>#Left({ a = 1 })::label())\n\tTerminal.inspect(Same<Integer>#Neither::label())\n\tTerminal.inspect(mixed)",
			),
			async (directory) => {
				expect(
					await runBundle(
						generateModules(linkProject(directory, "Main.es")),
						directory,
					),
				).toEqual(['"integer"', '"integer"', "Pair#Neither"])
			},
		)
	})

	// The conformance is read as a `::` call reads the Namespace, with `Pair`'s
	// phantom `B` read off its own Module.
	it("refuses a conformance a phantom Type Argument turns away in a Module that never imported its Choice", async () => {
		let project = (body: string) => ({
			"Main.es": `import {
	from "./Pairs.es" {
		Labelled
		Mixed
		Same
		Sames
	}
}

implementation {
	function describe<infer T is Labelled>(_ value: T) -> String {
		<- value::label()
	}

${body}
}
`,
			"Pairs.es": `implementation {
	protocol Labelled {
		label() -> String
	}

	choice Pair<A, B> {
		Left { a: A },
		Neither,
	}

	namespace Sames<infer Item> for Pair<Item, Item> is Labelled {
		label() -> String {
			<- "same"
		}
	}

	type Same<T> = Pair<T, T>
	type Mixed = Pair<Integer, String>
}

export {
	Labelled
	Mixed
	Same
	Sames
}
`,
		})

		withProject(
			project(
				"\tTerminal.inspect(describe(Same<Integer>#Left({ a = 1 })))\n\tTerminal.inspect(describe(Mixed#Left({ a = 2 })))",
			),
			(directory) => {
				expect(
					codesOf(analysedAt(directory, "Main.es", "Main.es")),
				).toEqual(["unsatisfied-bound"])
			},
		)
		await withBuiltProject(
			project(
				"\tconstant mixed: Mixed = #Neither\n\tTerminal.inspect(describe(Same<Integer>#Left({ a = 1 })))\n\tTerminal.inspect(mixed)",
			),
			async (directory) => {
				expect(
					await runBundle(
						generateModules(linkProject(directory, "Main.es")),
						directory,
					),
				).toEqual(['"same"', "Pair#Neither"])
			},
		)
	})

	// The body is emitted once, where the Protocol is declared, and binds the
	// Pattern there.
	it("runs a provided Method that takes its Parameter apart from another Module", async () => {
		await withBuiltProject(
			{
				"Main.es": `import {
	from "./Measured.es" {
		Measured
	}
}

implementation {
	type Plan = { factor: Integer }

	namespace Plans for Plan is Measured {
		scale() -> Integer {
			<- @.factor
		}
	}

	function measured <infer Item is Measured>(_ item: Item) -> Integer {
		<- item::area(of { width = 4, height = 1 })
	}

	constant plan: Plan = { factor = 10 }

	Terminal.inspect(plan::area(of { width = 2, height = 3 }))
	Terminal.inspect(measured(plan))
}
`,
				"Measured.es": `implementation {
	type Size = { width: Integer, height: Integer }

	protocol Measured {
		scale() -> Integer

		area(of { width, height }: Size) -> Integer {
			<- width::multiply(with height)::multiply(with @::scale())
		}
	}
}

export {
	Measured
	Size
}
`,
			},
			async (directory) => {
				expect(
					await runBundle(
						generateModules(linkProject(directory, "Main.es")),
						directory,
					),
				).toEqual(["60", "40"])
			},
		)
	})

	it("calls a Function bounded by a Protocol its Module keeps private", async () => {
		await withBuiltProject(
			{
				"Main.es": `import {
	from "./Sized.es" {
		IntegerSized
		measure
	}
}

implementation {
	Terminal.inspect(measure(3))
}
`,
				"Sized.es": sizedModule.replace("\tSized\n", ""),
			},
			async (directory) => {
				expect(
					await runBundle(
						generateModules(linkProject(directory, "Main.es")),
						directory,
					),
				).toEqual(["3"])
			},
		)
	})

	// `Big`'s body asks for `extra`, which a witness for `Sized` does not
	// hold, and neither Protocol is imported where the witness is built.
	it("runs another Module's provided body with its own Protocol's witness", async () => {
		await withBuiltProject(
			{
				"Main.es": `import {
	from "./Sized.es" {
		IntegerBig
		gauge
	}
}

implementation {
	Terminal.inspect(gauge(3))
}
`,
				"Sized.es": `implementation {
	protocol Sized {
		size() -> Integer
		describe() -> String
	}

	protocol Big is Sized {
		extra() -> Integer

		describe() -> String {
			<- "big {@::extra()}"
		}
	}

	namespace IntegerBig for Integer is Big {
		size() -> Integer {
			<- @
		}

		extra() -> Integer {
			<- 7
		}
	}

	function gauge <infer Item is Sized>(_ item: Item) -> String {
		<- item::describe()
	}
}

export {
	IntegerBig
	gauge
}
`,
			},
			async (directory) => {
				expect(
					await runBundle(
						generateModules(linkProject(directory, "Main.es")),
						directory,
					),
				).toEqual(['"big 7"'])
			},
		)
	})

	// `Ranked`'s body hands the `Self` its Function literal is given to
	// `sort`, which reads `compare` off the witness, and `Sized` holds none.
	it("runs another Module's provided body whose Function literal sorts its `Self`", async () => {
		await withBuiltProject(
			{
				"Main.es": `import {
	from "./Sized.es" { gauge }
	from "./Boxes.es" {
		Boxes
		box
	}
}

implementation {
	Terminal.inspect(gauge(box(3)))
}
`,
				"Sized.es": `implementation {
	protocol Sized {
		visit(_ f: (_: Self) -> String) -> String
		describe() -> String
	}

	function gauge <infer Item is Sized>(_ item: Item) -> String {
		<- item::describe()
	}
}

export {
	Sized
	gauge
}
`,
				"Ranked.es": `implementation {
	protocol Ranked is Comparable {
		visit(_ f: (_: Self) -> String) -> String

		describe() -> String {
			<- @::visit((item) {
				constant sorted = [item, item]::sort()

				<- "sorted {sorted::length()}"
			})
		}
	}
}

export {
	Ranked
}
`,
				"Boxes.es": `import {
	from "./Ranked.es" { Ranked }
	from "./Sized.es" { Sized }
}

implementation {
	type Box = { n: Integer }

	namespace Boxes for Box is Sized, is Ranked {
		visit(_ f: (_: Box) -> String) -> String {
			<- f(@)
		}

		compare(to other: Box) -> Ordering {
			<- @.n::compare(to other.n)
		}
	}

	function box(_ n: Integer) -> Box {
		<- { n }
	}
}

export {
	Box
	Boxes
	box
}
`,
			},
			async (directory) => {
				expect(
					await runBundle(
						generateModules(linkProject(directory, "Main.es")),
						directory,
					),
				).toEqual(['"sorted 2"'])
			},
		)
	})

	// `B.es` restates the `z` of `A.es`'s Protocol with another Type and is
	// refused there. `Main.es` is judged on its own, so what that breaks in it
	// is reported in it, with a Note naming the refusal.
	const restatingModules = {
		"A.es": `implementation {
	protocol A {
		z() -> String

		y() -> String {
			<- "y{@::z()}"
		}
	}

	function relay <infer T is A>(_ t: T) -> String {
		<- t::y()
	}
}

export {
	A
	relay
}
`,
		"B.es": `import {
	from "./A.es" { A as Base }
}

implementation {
	protocol B is Base {
		z() -> Integer
	}
}

export {
	B
}
`,
	}

	it("reports what another Module's refused restatement breaks at a bounded call", () => {
		withProject(
			{
				...restatingModules,
				"Main.es": `import {
	from "./A.es" { relay }
	from "./B.es" { B }
}

implementation {
	namespace IntegerB for Integer is B {
		z() -> Integer {
			<- 7
		}
	}

	function hand <infer T is B>(_ t: T) -> String {
		<- relay(t)
	}

	Terminal.print(relay(3))
	Terminal.print(hand(3))
}
`,
			},
			(directory) => {
				let main = analysedAt(directory, "Main.es", "Main.es")

				expect(reportsOf(main)).toEqual([
					["dependency-has-errors", "./B.es has errors of its own"],
					[
						"nonconforming-namespace",
						"Namespace 'IntegerB' does not conform to 'A'",
					],
					[
						"nonconforming-namespace",
						"Namespace 'IntegerB' does not conform to 'B'",
					],
				])
				expect(
					main.slice(1).map((diagnostic) => diagnostic.notes),
				).toEqual([
					[
						"'B' restates 'z' with a signature 'A' does not accept, and is refused where B.es declares it.",
					],
					[
						"'y' runs the body 'A' provides, which reads 'z': at Integer 'IntegerB' answers it with an Integer, where 'A' answers a String.",
						"'B' restates 'z' with a signature 'A' does not accept, and is refused where B.es declares it.",
					],
				])
				expect(main.flatMap((diagnostic) => diagnostic.helps)).toEqual([
					"Open ./B.es — its own Diagnostics say what is wrong there.",
				])
			},
		)
	})

	it("reports what another Module's refused restatement breaks at a provided Method's call", () => {
		withProject(
			{
				...restatingModules,
				"Main.es": `import {
	from "./A.es" { A }
	from "./B.es" { B }
}

implementation {
	namespace IntegerB for Integer is B {
		z() -> Integer {
			<- 7
		}
	}

	Terminal.print(3::y())
}
`,
			},
			(directory) => {
				let main = analysedAt(directory, "Main.es", "Main.es")

				expect(reportsOf(main)).toEqual([
					["dependency-has-errors", "./B.es has errors of its own"],
					[
						"nonconforming-namespace",
						"Namespace 'IntegerB' does not conform to 'A'",
					],
				])
				expect(main[1]!.notes).toEqual([
					"'B' restates 'z' with a signature 'A' does not accept, and is refused where B.es declares it.",
				])
			},
		)
	})

	// A block on the wrong side of the implementation is the one mistake. It
	// is kept, so the names it imports or exports are not reported again.
	it("reports a misplaced block once, not each name it lists", () => {
		withProject(
			{
				"Library.es": `export {
	greeting
	shout
}

implementation {
	constant greeting = "hi"

	function shout(_ text: String) -> String {
		<- text::append("!")
	}
}
`,
				"Main.es": `implementation {
	Terminal.print(shout(greeting))
}

import {
	from "./Library.es" {
		greeting
		shout
	}
}
`,
			},
			(directory) => {
				expect(
					codesOf(analysedAt(directory, "Main.es", "Main.es")),
				).toEqual(["misplaced-module-section", "dependency-has-errors"])
				expect(
					codesOf(analysedAt(directory, "Main.es", "Library.es")),
				).toEqual(["misplaced-module-section"])
			},
		)
	})

	// A refused `::` call still reached the Namespaces declaring its Method,
	// which dispatch spells nowhere. Their imports are used. An import nothing
	// reaches is still reported.
	it("counts the Namespaces a refused call reached as used", () => {
		let namespace = (name: string, body: string) => `implementation {
	namespace ${name} for Integer {
		${body}
	}
}

export {
	${name}
}
`

		withProject(
			{
				"Doubling.es": namespace(
					"Doubling",
					"twice() -> Integer {\n\t\t\t<- @::multiply(with 2)\n\t\t}",
				),
				"Twicing.es": namespace(
					"Twicing",
					"twice() -> Integer {\n\t\t\t<- @::add(@)\n\t\t}",
				),
				"Checks.es": namespace(
					"Checks",
					"static small(_ n: Integer) -> Boolean {\n\t\t\t<- n::isLessThan(10)\n\t\t}",
				),
				"Unread.es": namespace(
					"Unread",
					"never() -> Integer {\n\t\t\t<- 0\n\t\t}",
				),
				"Main.es": `import {
	from "./Checks.es" { Checks }
	from "./Doubling.es" { Doubling as Doubler }
	from "./Twicing.es" { Twicing }
	from "./Unread.es" { Unread }
}

implementation {
	type Small = Integer where @::small(@)

	Terminal.print(5::twice())
}
`,
			},
			(directory) => {
				expect(
					reportsOf(analysedAt(directory, "Main.es", "Main.es")),
				).toEqual([
					["unused-import", "'Unread' is imported and never used"],
					["static-method-on-value", "'small' is a static Method"],
					[
						"ambiguous-namespace",
						"'twice' is provided by more than one Namespace",
					],
				])
			},
		)
	})

	// A Function refused as a value is reported where the exporting Module
	// wrote it. An importer reading the Constant, a member of it or a static
	// Property, under any name, writes no new value. A Function's own name is
	// still written as a value where it is read.
	it("reports a value another Module refused where it was written", () => {
		withProject(
			{
				"Lib.es": `implementation {
	function shown<infer Item is Printable>(_ item: Item) -> String {
		<- item::toString()
	}

	constant added = Integer.add
	constant record = { rule = Integer.add }

	namespace Holder for Integer {
		static held = Integer.add
	}
}

export {
	shown
	added
	record
	Holder
}
`,
				"Mid.es": `implementation {
	constant unrelated = 1
}

export {
	unrelated
	from "./Lib.es" { added }
}
`,
				"Main.es": `import {
	from "./Lib.es" {
		shown
		added as plus
		record
		Holder
	}
	from "./Mid.es" { added }
}

implementation {
	Terminal.inspect(plus)
	Terminal.inspect(record.rule)
	Terminal.inspect(Holder.held)
	Terminal.inspect(added)
	Terminal.inspect(shown)
}
`,
			},
			(directory) => {
				expect(
					reportsOf(analysedAt(directory, "Main.es", "Main.es")),
				).toEqual([
					["dependency-has-errors", "./Lib.es has errors of its own"],
					["dependency-has-errors", "./Mid.es has errors of its own"],
					[
						"protocol-bound-function-value",
						"A Function with Protocol-bound Type Parameters can not be used as a value",
					],
				])
				expect(
					codesOf(analysedAt(directory, "Main.es", "Lib.es")),
				).toEqual([
					"overloaded-function-value",
					"overloaded-function-value",
					"overloaded-function-value",
				])
			},
		)
	})

	// `Halved` provides a `z` answering a Number, and `Counted` one answering an
	// Integer. `Main.es` hands a value bounded by an extension of either or both
	// to a bound on `Halved`.
	const apartProtocols = (
		extension: string,
		name: string,
	) => `implementation {
	protocol Halved {
		h() -> Integer

		z() -> Number {
			<- @::h()::add(1/2)
		}
	}

	protocol Counted {
		v() -> Integer

		z() -> Integer {
			<- @::v()
		}
	}

	${extension}

	function viaHalved <infer T is Halved>(_ t: T) -> Number {
		<- t::z()
	}
}

export {
	Counted
	Halved
	${name}
	viaHalved
}
`

	const apartMain = (
		names: Array<string>,
		conformances: string,
		extending: string,
		written: string = "",
	) => `import {
	from "./Protocols.es" {
		${names.join("\n\t\t")}
	}
}

implementation {
	namespace IntegerN for Integer is ${conformances} {
		${written}h() -> Integer {
			<- 20
		}

		v() -> Integer {
			<- 30
		}
	}

	function hand <infer T is ${extending}>(_ t: T) -> Number {
		<- viaHalved(t)
	}

	Terminal.print("{viaHalved(3)} {hand(3)}")
}
`

	const apartShapes = [
		{
			shape: "an extension taking the other's entry",
			extension: "protocol Both is Counted, is Halved {}",
			names: ["Both", "Halved", "viaHalved"],
			conformances: "Halved, is Both",
			extending: "Both",
		},
		{
			shape: "an extension taking the other's entry, clauses swapped",
			extension: "protocol Both is Halved, is Counted {}",
			names: ["Both", "Halved", "viaHalved"],
			conformances: "Halved, is Both",
			extending: "Both",
		},
		{
			shape: "an extension restating the Method as a requirement",
			extension: `protocol Whole is Halved {
		z() -> Integer
	}`,
			names: ["Counted", "Whole", "viaHalved"],
			conformances: "Whole, is Counted",
			extending: "Whole",
		},
	]

	for (let {
		shape,
		extension,
		names,
		conformances,
		extending,
	} of apartShapes) {
		it(`refuses a Namespace answering a Method with two bodies through ${shape}`, () => {
			withProject(
				{
					"Protocols.es": apartProtocols(extension, extending),
					"Main.es": apartMain(names, conformances, extending),
				},
				(directory) => {
					let main = analysedAt(directory, "Main.es", "Main.es")

					expect(
						main.map((diagnostic) => [
							diagnostic.code,
							diagnostic.message,
							diagnostic.position?.start.line,
							diagnostic.labels.map((label) => label.message),
						]),
					).toEqual([
						[
							"nonconforming-namespace",
							`Namespace 'IntegerN' does not conform to '${extending}'`,
							10,
							[
								`Method 'z' runs one body for '${extending}' and another for 'Halved'`,
							],
						],
					])
					expect(main[0]!.notes).toEqual([
						`'z' runs the body 'Counted' provides for '${extending}', and the body 'Halved' provides for 'Halved'.`,
						`A value bounded by '${extending}' can be handed to a bound on 'Halved', and a bound runs one body.`,
					])
					expect(main[0]!.helps).toEqual([
						`Write 'z' in 'IntegerN' as '${extending}' declares it, so one Method answers both.`,
					])
				},
			)
		})

		it(`runs the Method the Namespace writes for both through ${shape}`, async () => {
			await withBuiltProject(
				{
					"Protocols.es": apartProtocols(extension, extending),
					"Main.es": apartMain(
						names,
						conformances,
						extending,
						`z() -> Integer {
			<- 7
		}

		`,
					),
				},
				async (directory) => {
					expect(
						await runBundle(
							generateModules(linkProject(directory, "Main.es")),
							directory,
						),
					).toEqual(["7 7"])
				},
			)
		})
	}

	// `Other.es` declares a `Sized` of its own, which the graph reaches
	// from `Entry.es` and which is no concern of `measure`'s bound.
	it("resolves a bound alike whichever entry the graph was loaded from", () => {
		withProject(
			{
				"Entry.es": `import {
	from "./Other.es" { Sized }
	from "./Main.es" { run }
}

implementation {
	Terminal.inspect(run())
}
`,
				"Main.es": `import {
	from "./Sized.es" {
		IntegerSized
		measure
	}
}

implementation {
	function run() -> Integer {
		<- measure(3)
	}
}

export {
	run
}
`,
				"Other.es": `implementation {
	protocol Sized {
		size() -> Integer
	}
}

export {
	Sized
}
`,
				"Sized.es": sizedModule,
			},
			(directory) => {
				let answersFrom = (entry: string) =>
					analysedAt(directory, entry, "Main.es").map(
						(diagnostic) => [
							diagnostic.code,
							diagnostic.helps,
							diagnostic.data,
						],
					)

				expect(answersFrom("Entry.es")).toEqual([])
				expect(answersFrom("Main.es")).toEqual([])
			},
		)
	})

	// A `where` condition is solved in the caller's Scope under the
	// Protocol its Namespace resolved, so `Main.es` needs `IntegerWeighed` and
	// no name for `Weighed`.
	it("calls a Function whose conformance has a condition the caller never names", async () => {
		await withBuiltProject(
			{
				"Main.es": `import {
	from "./Sized.es" {
		IntegerWeighed
		ListSized
		measure
	}
}

implementation {
	Terminal.inspect(measure([1, 2]))
}
`,
				"Sized.es": `implementation {
	protocol Weighed {
		weight() -> Integer
	}

	protocol Sized {
		size() -> Integer
	}

	namespace IntegerWeighed for Integer is Weighed {
		weight() -> Integer {
			<- @
		}
	}

	namespace ListSized<infer ItemType> for List<ItemType>
		is Sized where ItemType is Weighed
	{
		size() -> Integer {
			<- 2
		}
	}

	function measure <infer Item is Sized>(_ item: Item) -> Integer {
		<- item::size()
	}
}

export {
	IntegerWeighed
	ListSized
	Sized
	Weighed
	measure
}
`,
			},
			async (directory) => {
				expect(
					await runBundle(
						generateModules(linkProject(directory, "Main.es")),
						directory,
					),
				).toEqual(["2"])
			},
		)
	})

	// `IntegerSized` is what the call needs, and `Main.es` names the Module
	// that exports it, so importing it is the edit rather than a second Namespace.
	it("offers the import of a Namespace that makes a refused bound hold", () => {
		withProject(
			{
				"Main.es": `import {
	from "./Sized.es" { measure }
}

implementation {
	Terminal.inspect(measure(3))
}
`,
				"Sized.es": sizedModule,
			},
			(directory) => {
				let refusal = analysedAt(directory, "Main.es", "Main.es").find(
					(diagnostic) => diagnostic.code === "unsatisfied-bound",
				)

				expect(refusal?.helps).toEqual([
					"'IntegerSized' in ./Sized.es makes Integer conform to 'Sized' — import it.",
				])
				expect(refusal?.data).toEqual({
					kind: "import-declaration",
					name: "IntegerSized",
					modulePath: path.join(directory, "Sized.es"),
				})
			},
		)
	})

	// The call is refused for want of `IntegerWeighed`, and `ListSized` is
	// the Namespace it would conform through, so its entry is not one to remove.
	it("counts the Namespace a refused call would have used", () => {
		withProject(
			{
				"Main.es": `import {
	from "./Sized.es" {
		ListSized
		measure
	}
}

implementation {
	Terminal.inspect(measure([1, 2]))
}
`,
				"Sized.es": `implementation {
	protocol Weighed {
		weight() -> Integer
	}

	protocol Sized {
		size() -> Integer
	}

	namespace IntegerWeighed for Integer is Weighed {
		weight() -> Integer {
			<- @
		}
	}

	namespace ListSized<infer ItemType> for List<ItemType>
		is Sized where ItemType is Weighed
	{
		size() -> Integer {
			<- 2
		}
	}

	function measure <infer Item is Sized>(_ item: Item) -> Integer {
		<- item::size()
	}
}

export {
	IntegerWeighed
	ListSized
	measure
}
`,
			},
			(directory) => {
				expect(
					codesOf(analysedAt(directory, "Main.es", "Main.es")),
				).toEqual(["unsatisfied-conformance-condition"])
			},
		)
	})

	it("says what counts as a use of an imported Protocol", () => {
		withProject(
			{
				"Main.es": `import {
	from "./Sized.es" { Sized }
}

implementation {
	Terminal.inspect(3)
}
`,
				"Sized.es": sizedModule,
			},
			(directory) => {
				let [unused] = analysedAt(directory, "Main.es", "Main.es")

				expect(unused?.code).toBe("unused-import")
				expect(unused?.notes).toEqual([
					"A Protocol counts as used where this file names it or calls a Method it provides.",
				])
			},
		)
	})

	// Only a Namespace is used through a dispatch. A Choice, an Alias of one
	// and a refinement have uses of their own a file need not spell. A
	// Constant, a Function or a Record Alias is used only where it is written.
	it("says what counts as a use of each kind of import", () => {
		withProject(
			{
				"Main.es": `import {
	from "./Kinds.es" {
		Clock
		Colour
		Flipped
		greet
		one
		Point
		Small
	}
}

implementation {
	Terminal.inspect(3)
}
`,
				"Kinds.es": `implementation {
	constant one = 1

	function greet() -> String {
		<- "hi"
	}

	namespace Clock {
		static now() -> Integer {
			<- 1
		}
	}

	choice Colour { Red, Green }

	choice Pair<A, B> { First { value: A }, Second { value: B } }

	type Flipped<A, B> = Pair<B, A>

	type Small = Integer where @::isLessThan(10)

	type Point = { x: Integer }
}

export {
	Clock
	Colour
	Flipped
	greet
	one
	Pair
	Point
	Small
}
`,
			},
			(directory) => {
				expect(
					analysedAt(directory, "Main.es", "Main.es").map(
						(diagnostic) => [diagnostic.message, diagnostic.notes],
					),
				).toEqual([
					[
						"'Clock' is imported and never used",
						[
							"A Namespace counts as used when a Method dispatches through it, even where the call never spells its name.",
						],
					],
					[
						"'Colour' is imported and never used",
						[
							"A Choice counts as used where this file names it, writes one of its Cases, or reaches a conformance it derives.",
						],
					],
					[
						"'Flipped' is imported and never used",
						[
							"An Alias of a Choice counts as used where this file names it or writes one of its Cases.",
						],
					],
					["'greet' is imported and never used", []],
					["'one' is imported and never used", []],
					["'Point' is imported and never used", []],
					[
						"'Small' is imported and never used",
						[
							"A refinement counts as used where this file names it, or where a narrowing proves it of a value.",
						],
					],
				])
			},
		)
	})

	// `Main.es` declares the bound itself without importing `Sized`, which
	// is `unknown-protocol` there. The refused bound asks nothing of the call.
	it("stays quiet at a call to a Function whose bound its own Module refused", () => {
		withProject(
			{
				"Main.es": `import {
	from "./Sized.es" { IntegerSized }
}

implementation {
	function measure <infer Item is Sized>(_ item: Item) -> Integer {
		<- 1
	}

	Terminal.inspect(measure(3))
}
`,
				"Sized.es": sizedModule,
			},
			(directory) => {
				expect(
					codesOf(analysedAt(directory, "Main.es", "Main.es")),
				).toEqual(["unused-import", "unknown-protocol"])
			},
		)
	})

	// `outer`'s own bound is refused where it is written, so its `Item`
	// asks nothing of `measure`, directly or through the `where` of `ListSized`.
	it("stays quiet at a call made with a Type Parameter whose bound was refused", () => {
		withProject(
			{
				"Main.es": `import {
	from "./Sized.es" {
		ListSized
		Sized
		measure
	}
}

implementation {
	function outer <infer Item is Sizd>(_ item: Item) -> Integer {
		<- measure(item)::add(measure([item]))
	}

	Terminal.inspect(outer(3))
}
`,
				"Sized.es": sizedModule
					.replace(
						"\tfunction measure",
						`\tnamespace ListSized<infer ItemType> for List<ItemType>
\t\tis Sized where ItemType is Sized
\t{
\t\tsize() -> Integer {
\t\t\t<- 2
\t\t}
\t}

\tfunction measure`,
					)
					.replace(
						"\tIntegerSized\n",
						"\tIntegerSized\n\tListSized\n",
					),
			},
			(directory) => {
				expect(
					codesOf(analysedAt(directory, "Main.es", "Main.es")),
				).toEqual(["unused-import", "unknown-protocol"])
			},
		)
	})

	// A bound is resolved where it is written, so `Main.es` must import the
	// Protocol it names. The Help names the Module that declares it.
	it("names the Module that declares a Protocol a bound names unimported", () => {
		withProject(
			{
				"Main.es": `import {
	from "./Sized.es" { IntegerSized }
}

implementation {
	function measureTwice <infer Item is Sized>(_ item: Item) -> Integer {
		<- 2
	}

	Terminal.inspect(measureTwice(3))
}
`,
				"Sized.es": sizedModule,
			},
			(directory) => {
				let refusal = analysedAt(directory, "Main.es", "Main.es").find(
					(diagnostic) => diagnostic.code === "unknown-protocol",
				)

				expect(refusal?.helps).toEqual([
					"'Sized' is declared in Sized.es — import it here.",
				])
			},
		)
	})

	// An import under the declared name would collide with the Type this
	// file declares.
	it("asks for a name of its own for a Protocol whose name a Type here takes", () => {
		let main = (entry: string, bound: string) => `import {
	from "./Sized.es" { ${entry} }
}

implementation {
	type Sized = { count: Integer }

	function measureTwice <infer Item is ${bound}>(_ item: Item) -> Integer {
		<- 2
	}
}

export {
	measureTwice
	Sized
}
`

		withProject(
			{
				"Main.es": main("IntegerSized", "Sized"),
				"Sized.es": sizedModule,
			},
			(directory) => {
				let refusal = analysedAt(directory, "Main.es", "Main.es").find(
					(diagnostic) => diagnostic.code === "unknown-protocol",
				)

				expect(refusal?.helps).toEqual([
					"'Sized' is declared in Sized.es — import it under a name of its own, 'Sized as …', and write that name here, since this file binds 'Sized' already.",
				])
			},
		)

		withProject(
			{
				"Main.es": main("Sized as Measured", "Measured"),
				"Sized.es": sizedModule,
			},
			(directory) => {
				expect(
					codesOf(analysedAt(directory, "Main.es", "Main.es")),
				).toEqual([])
			},
		)
	})

	// `Measure.es` bounds `measure` by a `Sized` it never imported, which
	// is its own mistake to fix. `Main.es` reaches a `Sized` in another file,
	// and a Help asking to import that one here would send the edit astray.
	it("stays quiet about a call into a dependency that refused its bound", () => {
		withProject(
			{
				"Main.es": `import {
	from "./Measure.es" { measure }
	from "./Sized.es" { IntegerSized }
}

implementation {
	Terminal.inspect(measure(3))
}
`,
				"Measure.es": `implementation {
	function measure <infer Item is Sized>(_ item: Item) -> Integer {
		<- 1
	}
}

export {
	measure
}
`,
				"Sized.es": sizedModule,
			},
			(directory) => {
				expect(
					codesOf(analysedAt(directory, "Main.es", "Measure.es")),
				).toEqual(["unknown-protocol"])
				expect(
					codesOf(analysedAt(directory, "Main.es", "Main.es")),
				).toEqual(["dependency-has-errors", "unused-import"])
			},
		)
	})

	// The same for a `where` condition: `Sized.es` names a `Weighed` it
	// never imported, and the condition it refused asks nothing of the call.
	it("stays quiet about a conformance whose condition its Module refused", () => {
		withProject(
			{
				"Main.es": `import {
	from "./Sized.es" {
		ListSized
		measure
	}
	from "./Weighed.es" { IntegerWeighed }
}

implementation {
	Terminal.inspect(measure([1, 2]))
}
`,
				"Sized.es": `implementation {
	protocol Sized {
		size() -> Integer
	}

	namespace ListSized<infer ItemType> for List<ItemType>
		is Sized where ItemType is Weighed
	{
		size() -> Integer {
			<- 2
		}
	}

	function measure <infer Item is Sized>(_ item: Item) -> Integer {
		<- item::size()
	}
}

export {
	ListSized
	Sized
	measure
}
`,
				"Weighed.es": `implementation {
	protocol Weighed {
		weight() -> Integer
	}

	namespace IntegerWeighed for Integer is Weighed {
		weight() -> Integer {
			<- @
		}
	}
}

export {
	IntegerWeighed
	Weighed
}
`,
			},
			(directory) => {
				expect(
					codesOf(analysedAt(directory, "Main.es", "Sized.es")),
				).toEqual(["unknown-protocol"])
				expect(
					codesOf(analysedAt(directory, "Main.es", "Main.es")),
				).toEqual(["dependency-has-errors", "unused-import"])
			},
		)
	})

	// `Measurable` is only how `Measure.es` spells the `Sized` that
	// `Sized.es` declares, so the conformance `Main.es` holds meets the bound.
	it("accepts a call bounded by a Protocol the callee imported under an alias", async () => {
		await withBuiltProject(
			{
				"Main.es": `import {
	from "./Measure.es" { measure }
	from "./Sized.es" { IntegerSized }
}

implementation {
	Terminal.inspect(measure(3))
}
`,
				"Measure.es": `import {
	from "./Sized.es" { Sized as Measurable }
}

implementation {
	function measure <infer Item is Measurable>(_ item: Item) -> Integer {
		<- item::size()
	}
}

export {
	measure
}
`,
				"Sized.es": sizedModule,
			},
			async (directory) => {
				expect(
					await runBundle(
						generateModules(linkProject(directory, "Main.es")),
						directory,
					),
				).toEqual(["3"])
			},
		)
	})

	// Per Module, because the deduplication key holds no file, and these files make
	// the same mistake on the same line.
	it("attributes each Module's Diagnostics to that Module", () => {
		withProject(
			{
				"Main.es": `import {
	from "./Other.es" { broken }
}

implementation {
	constant wrong = missing

	Terminal.inspect(broken()::toString())
}
`,
				"Other.es": `implementation {




	constant wrong = missing
}

export {
	broken
}
`,
			},
			(directory) => {
				let linked = linkProject(directory, "Main.es")
				let other = linkedAt(directory, linked, "Other.es")
				let main = linkedAt(directory, linked, "Main.es")

				// The same code, message and Position in both files.
				for (let module of [other, main]) {
					let unknownName = module.diagnostics.find(
						(diagnostic) => diagnostic.code === "unknown-name",
					)

					expect(unknownName?.message).toBe(
						"'missing' is not declared",
					)
					expect(unknownName?.position?.start.line).toBe(6)
				}

				expect(codesOf(other.diagnostics)).toEqual([
					"unknown-name",
					"export-of-unknown-name",
				])
				expect(codesOf(main.diagnostics)).toEqual([
					"unknown-export",
					"unknown-name",
				])
			},
		)
	})

	// An entry naming an export that could not be typed binds an Error, so its
	// uses report nothing more. The declaring Module reports the mistake.
	it("stays quiet about an import whose declaration the other Module could not type", () => {
		withProject(
			{
				"Main.es": `import {
	from "./Other.es" { broken }
}

implementation {
	Terminal.inspect(broken()::toString())
	Terminal.inspect(broken()::toString())
}
`,
				"Other.es": `implementation {
	function broken() -> Missing {
		<- 1
	}
}

export {
	broken
}
`,
			},
			(directory) => {
				let linked = linkProject(directory, "Main.es")

				expect(
					codesOf(
						linkedAt(directory, linked, "Other.es").diagnostics,
					),
				).toEqual(["unknown-type"])
				expect(
					linkedAt(directory, linked, "Main.es").diagnostics,
				).toEqual([])
			},
		)
	})

	// A facade does not compile when what it forwards does not, so a file
	// importing through it is told.
	it("reports a broken Module through a facade that re-exports it", () => {
		withProject(
			{
				"Main.es": `import {
	from "./Facade.es" { measure }
}

implementation {
	Terminal.inspect(measure(4)::toString())
}
`,
				"Facade.es": `implementation {}

export {
	from "./Measure.es" { measure }
}
`,
				"Measure.es": `implementation {
	function measure(_ amount: Integer) -> Integer {
		<- "not a Number"
	}
}

export {
	measure
}
`,
			},
			(directory) => {
				expect(
					codesOf(analysedAt(directory, "Main.es", "Measure.es")),
				).toEqual(["return-type-mismatch"])
				expect(
					reportsOf(analysedAt(directory, "Main.es", "Facade.es")),
				).toEqual([
					[
						"dependency-has-errors",
						"./Measure.es has errors of its own",
					],
				])
				expect(
					reportsOf(analysedAt(directory, "Main.es", "Main.es")),
				).toEqual([
					[
						"dependency-has-errors",
						"./Facade.es has errors of its own",
					],
				])
			},
		)
	})

	// Every file on the chain is told about the one import it can follow
	// towards the mistake, however far down the mistake is.
	it("reports a broken Module on every file of a chain of imports", () => {
		withProject(
			{
				"Main.es": `import {
	from "./Top.es" { top }
}

implementation {
	Terminal.inspect(top()::toString())
}
`,
				"Top.es": `import {
	from "./Middle.es" { middle }
}

implementation {
	function top() -> Integer {
		<- middle()
	}
}

export {
	top
}
`,
				"Middle.es": `import {
	from "./Bottom.es" { bottom }
}

implementation {
	function middle() -> Integer {
		<- bottom()
	}
}

export {
	middle
}
`,
				"Bottom.es": `implementation {
	function bottom() -> Integer {
		<- "zero"
	}
}

export {
	bottom
}
`,
			},
			(directory) => {
				expect(
					codesOf(analysedAt(directory, "Main.es", "Bottom.es")),
				).toEqual(["return-type-mismatch"])
				expect(
					["Middle.es", "Top.es", "Main.es"].map((name) =>
						reportsOf(analysedAt(directory, "Main.es", name)),
					),
				).toEqual([
					[
						[
							"dependency-has-errors",
							"./Bottom.es has errors of its own",
						],
					],
					[
						[
							"dependency-has-errors",
							"./Middle.es has errors of its own",
						],
					],
					[
						[
							"dependency-has-errors",
							"./Top.es has errors of its own",
						],
					],
				])
			},
		)
	})

	// `Loop.es` is the broken one. Its failure returns to it through `Circle.es`
	// unreported, while the file importing the cycle is told.
	it("reports a broken member of a cycle to the cycle's importers alone", () => {
		withProject(
			{
				"Main.es": `import {
	from "./Circle.es" { circled }
}

implementation {
	Terminal.inspect(circled(1)::toString())
}
`,
				"Circle.es": `import {
	from "./Loop.es" { flagged }
}

implementation {
	function circled(_ n: Integer) -> Integer {
		<- flagged(n)
	}
}

export {
	circled
}
`,
				"Loop.es": `import {
	from "./Circle.es" { circled }
}

implementation {
	constant broken: Integer = "no"

	function flagged(_ n: Integer) -> Integer {
		<- circled(n)
	}
}

export {
	broken
	flagged
}
`,
			},
			(directory) => {
				expect(
					codesOf(analysedAt(directory, "Main.es", "Loop.es")),
				).toEqual(["assignment-type-mismatch"])
				expect(
					reportsOf(analysedAt(directory, "Main.es", "Circle.es")),
				).toEqual([
					[
						"dependency-has-errors",
						"./Loop.es has errors of its own",
					],
				])
				expect(
					reportsOf(analysedAt(directory, "Main.es", "Main.es")),
				).toEqual([
					[
						"dependency-has-errors",
						"./Circle.es has errors of its own",
					],
				])
			},
		)
	})

	// `Ping.es` fails only because `Pong.es` does, so `Pong.es` is told
	// about `Broken.es` and not about `Ping.es` as well.
	it("reports a cycle member only the imports that reach a mistake past it", () => {
		withProject(
			{
				"Ping.es": `import {
	from "./Pong.es" { pong }
}

implementation {
	function ping(_ n: Integer) -> Integer {
		<- pong(n)
	}
}

export {
	ping
}
`,
				"Pong.es": `import {
	from "./Broken.es" { broken }
	from "./Ping.es" { ping }
}

implementation {
	function pong(_ n: Integer) -> Integer {
		<- broken(n)
	}

	function again(_ n: Integer) -> Integer {
		<- ping(n)
	}
}

export {
	again
	pong
}
`,
				"Broken.es": `implementation {
	function broken(_ n: Integer) -> Integer {
		<- "zero"
	}
}

export {
	broken
}
`,
			},
			(directory) => {
				expect(
					codesOf(analysedAt(directory, "Ping.es", "Broken.es")),
				).toEqual(["return-type-mismatch"])
				expect(
					reportsOf(analysedAt(directory, "Ping.es", "Pong.es")),
				).toEqual([
					[
						"dependency-has-errors",
						"./Broken.es has errors of its own",
					],
				])
				expect(
					reportsOf(analysedAt(directory, "Ping.es", "Ping.es")),
				).toEqual([
					[
						"dependency-has-errors",
						"./Pong.es has errors of its own",
					],
				])
			},
		)
	})

	// A Choice takes its identity from its Module's canonical path, which linking
	// supplies. Two files each declaring `choice Outcome` declare two Types.
	it("identifies a Choice by the Module that declares it", () => {
		withProject(
			{
				"Main.es": `import {
	from "./Other.es" { Outcome as Theirs }
}

implementation {
	choice Outcome {
		Ok
	}

	function take(_ value: Theirs) -> Boolean {
		<- true
	}

	constant mine: Outcome = #Ok

	Terminal.inspect(take(mine)::toString())
}
`,
				"Other.es": `implementation {
	choice Outcome {
		Ok
	}
}

export {
	Outcome
}
`,
			},
			(directory) => {
				let linked = linkProject(directory, "Main.es")
				let main = linkedAt(directory, linked, "Main.es")

				expect(
					linkedAt(directory, linked, "Other.es").diagnostics,
				).toEqual([])
				expect(main.diagnostics).toEqual([])

				// Same spelling, same Case, two Types. A free Function's Arguments are
				// the Validator's to check, which linking does not run.
				expect(codesOf(validate(main.program))).toEqual([
					"argument-type-mismatch",
				])
			},
		)
	})

	// A Module runs after the Modules it imports, so only its own Namespaces
	// can be reached before their Declarations.
	describe("Use before declaration", () => {
		const lib = `implementation {
	function run() -> Boolean {
		<- 4::isEvenly()
	}

	function apply(_ check: () -> Boolean) -> Boolean {
		<- check()
	}

	namespace Parity for Integer {
		isEvenly() -> Boolean {
			<- @::remainder(dividingBy 2)::is(0)
		}
	}
}

export {
	run
	apply
}
`

		it("reports a Function handed to an imported one that reaches a Namespace declared below", () => {
			withProject(
				{
					"Lib.es": lib,
					"Main.es": `import {
	from "./Lib.es" {
		apply
		run
	}
}

implementation {
	function check() -> Boolean {
		<- 3::isOddly()
	}

	Terminal.print(run())
	Terminal.print(apply(check))

	namespace Oddness for Integer {
		isOddly() -> Boolean {
			<- @::remainder(dividingBy 2)::is(1)
		}
	}
}
`,
				},
				(directory) => {
					let main = analysedAt(directory, "Main.es", "Main.es")

					expect(analysedAt(directory, "Main.es", "Lib.es")).toEqual(
						[],
					)
					expect(reportsOf(main)).toEqual([
						[
							"use-before-declaration",
							"Namespace 'Oddness' is used before it is declared",
						],
					])
					expect(main[0].labels[0]?.message).toBe(
						"this call may run a Function that reaches it",
					)
					expect(main[0].labels[0]?.position.start.line).toBe(14)
					expect(main[0].notes[1]).toBe(
						"This reaches 'Oddness' through 'check'.",
					)
				},
			)
		})

		it("reports an imported Module's own call that reaches its Namespace below", () => {
			withProject(
				{
					"Lib.es": lib.replace(
						"\tnamespace Parity",
						"\tconstant even = run()\n\n\tnamespace Parity",
					),
					"Main.es": `import {
	from "./Lib.es" { run }
}

implementation {
	Terminal.print(run())
}
`,
				},
				(directory) => {
					expect(
						reportsOf(analysedAt(directory, "Main.es", "Lib.es")),
					).toEqual([
						[
							"use-before-declaration",
							"Namespace 'Parity' is used before it is declared",
						],
					])
				},
			)
		})
	})

	// An imported name binds no Constant of this Module, and the Property
	// `base` reads nothing, so only `size` moves up with `Sizes`.
	it("moves only what the Namespace reads with it in a Module that imports", () => {
		let main = (statements: Array<string>) => `import {
	from "./Lib.es" { seed }
}

implementation {
	function useIt() -> Integer {
		<- Sizes.base
	}

	${statements.join("\n\t")}
}
`
		let sizes = "namespace Sizes {\n\t\tstatic base: Integer = size\n\t}"
		let files = (statements: Array<string>) => ({
			"Lib.es":
				"implementation {\n\tconstant seed = 4\n}\n\nexport {\n\tseed\n}\n",
			"Main.es": main(statements),
		})
		let analysed = (statements: Array<string>) =>
			withProject(files(statements), (directory) =>
				analysedAt(directory, "Main.es", "Main.es"),
			)

		expect(
			analysed([
				"constant base = useIt()",
				"Terminal.print(base)",
				"constant size = seed",
				sizes,
			]).map((diagnostic) => [diagnostic.code, diagnostic.helps]),
		).toEqual([
			[
				"use-before-declaration",
				[
					"Move the Declarations of 'size' and 'Sizes' above this Statement, in the order they are written.",
				],
			],
		])
		expect(
			codesOf(
				analysed([
					"constant size = seed",
					sizes,
					"constant base = useIt()",
					"Terminal.print(base)",
				]),
			),
		).toEqual([])
	})

	// A Module of a cycle may load before the other, so code that runs while it
	// loads must not need the other one.
	describe("Code that runs while a Module of a cycle loads", () => {
		const board = `import {
	from "./A.es" { Game }
}

implementation {
	type Board = List<Integer>

	namespace Board for Board {
		static empty: Board = [0, 0]
	}

	function count(_ game: Game) -> Integer {
		<- game.board::length()
	}
}

export {
	Board
	count
}
`

		it("refuses a Constant whose value reads a Namespace of the cycle", () => {
			withProject(
				{
					"A.es": `import {
	from "./B.es" { Board }
}

implementation {
	type Game = { board: Board }

	constant empty: Game = { board = Board.empty }
}

export {
	Game
	empty
}
`,
					"B.es": board,
				},
				(directory) => {
					let diagnostics = analysedAt(directory, "A.es", "A.es")

					expect(reportsOf(diagnostics)).toEqual([
						[
							"cyclic-load-time-use",
							"'Board' is used while this Module loads, but comes from a Module of its import cycle",
						],
					])
					expect(diagnostics[0].helps).toEqual([
						"Use it inside a Function that runs once the Modules have loaded, or break the cycle.",
					])
				},
			)
		})

		it("refuses a Statement reaching the cycle through a Function of its own", () => {
			withProject(
				{
					"A.es": `import {
	from "./B.es" { Board }
}

implementation {
	type Game = { board: Board }

	function fresh() -> Game {
		<- { board = Board.empty }
	}

	constant empty: Game = fresh()
}

export {
	Game
	empty
}
`,
					"B.es": board,
				},
				(directory) => {
					let diagnostics = analysedAt(directory, "A.es", "A.es")

					expect(codesOf(diagnostics)).toEqual([
						"cyclic-load-time-use",
					])
					expect(diagnostics[0].labels[0]?.message).toBe(
						"this call reaches it",
					)
					expect(diagnostics[0].notes[1]).toBe(
						"This uses 'Board' through 'fresh'.",
					)
				},
			)
		})

		it("refuses a call into a Module of a cycle of three", () => {
			withProject(
				{
					"A.es": `import {
	from "./B.es" { viaB }
}

implementation {
	function start() -> Integer {
		<- viaB()
	}
}

export {
	start
}
`,
					"B.es": `import {
	from "./C.es" { viaC }
}

implementation {
	function viaB() -> Integer {
		<- viaC()
	}
}

export {
	viaB
}
`,
					"C.es": `import {
	from "./A.es" { start }
}

implementation {
	function viaC() -> Integer {
		<- 3
	}

	constant early = start()
}

export {
	viaC
	early
}
`,
				},
				(directory) => {
					expect(
						codesOf(analysedAt(directory, "A.es", "C.es")),
					).toEqual(["cyclic-load-time-use"])
				},
			)
		})

		// B never suspends again, but the work it starts goes on during A's
		// `complete`, while A has not declared `Doubling` yet.
		it("refuses work started while a Module loads that later reaches the cycle", () => {
			withProject(
				{
					"A.es": `import {
	from "./B.es" { noop }
}

implementation {
	function wait() -> Future<Integer> {
		complete Async.sleep(milliseconds 30)

		<- 1
	}

	constant waited = complete wait()

	function touch() -> Integer {
		<- noop()
	}

	namespace Doubling for Integer {
		doubled() -> Integer { <- @::multiply(with 2) }
	}
}

export {
	Doubling
	touch
}
`,
					"B.es": `import {
	from "./A.es" { Doubling }
}

implementation {
	function slowly() -> Future<Integer> {
		complete Async.sleep(milliseconds 1)

		<- 3::doubled()
	}

	constant running = start slowly()

	function noop() -> Integer {
		<- 1
	}
}

export {
	noop
}
`,
				},
				(directory) => {
					let diagnostics = analysedAt(directory, "A.es", "B.es")

					expect(codesOf(diagnostics)).toEqual([
						"cyclic-load-time-use",
					])
					expect(diagnostics[0].labels[0]?.message).toBe(
						"this starts work that later reaches it",
					)
				},
			)
		})

		// `bump` reads a value its own Module sets while it loads.
		it("refuses a Function of the cycle called while a Module loads", () => {
			withProject(
				{
					"P.es": `import {
	from "./Q.es" { readEarly }
}

implementation {
	function bump(_ n: Integer) -> Integer {
		<- n::multiply(with 2)::add(1000)
	}

	function report() -> String {
		<- readEarly()
	}
}

export {
	bump
	report
}
`,
					"Q.es": `import {
	from "./P.es" { bump }
}

implementation {
	constant early: String = "{bump(3)}"

	function readEarly() -> String {
		<- early
	}
}

export {
	readEarly
}
`,
				},
				(directory) => {
					expect(
						codesOf(analysedAt(directory, "P.es", "Q.es")),
					).toEqual(["cyclic-load-time-use"])
				},
			)
		})

		// The read sits two calls deep, in a body that runs only because a
		// Constant's value calls into it.
		it("refuses a Constant of the cycle read while a Module loads through a call chain", () => {
			withProject(
				{
					"A.es": `import {
	from "./B.es" { SCALE }
}

implementation {
	function scale() -> Integer {
		<- SCALE
	}

	function doubled() -> Integer {
		<- scale()::multiply(with 2)
	}

	constant early = doubled()

	function scaled(_ value: Integer) -> Integer {
		<- value::multiply(with early)
	}
}

export {
	scaled
}
`,
					"B.es": `import {
	from "./A.es" { scaled }
}

implementation {
	constant SCALE = 3

	function shifted(_ value: Integer) -> Integer {
		<- scaled(value)
	}
}

export {
	SCALE
	shifted
}
`,
				},
				(directory) => {
					let diagnostics = analysedAt(directory, "A.es", "A.es")

					expect(reportsOf(diagnostics)).toEqual([
						[
							"cyclic-load-time-use",
							"'SCALE' is used while this Module loads, but comes from a Module of its import cycle",
						],
					])
					expect(diagnostics[0]?.notes[1]).toBe(
						"This uses 'SCALE' through 'doubled', then 'scale'.",
					)
				},
			)
		})

		// A provided Method's body is emitted apart from its Protocol's Module,
		// and here dispatches to a Namespace of the calling Module.
		it("accepts a provided Method of a Protocol of the cycle called while a Module loads", async () => {
			await withBuiltProject(
				{
					"Main.es": `import {
	from "./P.es" { describeAll }
	from "./Q.es" { early }
}

implementation {
	Terminal.print(describeAll({ count = 5 }))
	Terminal.print(early)
}
`,
					"P.es": `import {
	from "./Q.es" {
		Box
		Boxes
	}
}

implementation {
	protocol Alpha {
		size() -> Integer

		twice() -> Integer {
			<- @::size()::multiply(with 2)::add(1000)
		}

		label() -> String {
			<- "size {@::size()} and more"
		}
	}

	function describeAll(_ box: Box) -> String {
		<- box::label()
	}
}

export {
	Alpha
	describeAll
}
`,
					"Q.es": `import {
	from "./P.es" { Alpha }
}

implementation {
	type Box = { count: Integer }

	namespace Boxes for Box is Alpha {
		size() -> Integer {
			<- @.count
		}
	}

	constant box: Box = { count = 3 }
	constant early: String = "{box::twice()} / {box::label()}"
}

export {
	Box
	Boxes
	box
	early
}
`,
				},
				async (directory) => {
					expect(
						await runBundle(
							generateModules(linkProject(directory, "Main.es")),
							directory,
						),
					).toEqual(["size 5 and more", "1006 / size 3 and more"])
				},
			)
		})

		// Only Function bodies cross, and they run once both Modules loaded.
		it("runs a cycle whose load-time code never crosses it, from either entry", async () => {
			let files = {
				"A.es": `import {
	from "./B.es" { Board }
}

implementation {
	type Game = { board: Board }

	function empty() -> Game {
		<- { board = Board.empty }
	}

	function cells(_ game: Game) -> Integer {
		<- game.board::length()
	}
}

export {
	Game
	cells
	empty
}
`,
				"B.es": board,
			}

			for (let [first, second] of [
				["A.es", "B.es"],
				["B.es", "A.es"],
			]) {
				await withBuiltProject(
					{
						...files,
						"Main.es": `import {
	from "./${first}" { ${first === "A.es" ? "cells empty" : "count"} }
	from "./${second}" { ${second === "A.es" ? "cells empty" : "count"} }
}

implementation {
	Terminal.print(cells(empty()))
	Terminal.print(count(empty()))
}
`,
					},
					async (directory) => {
						expect(
							await runBundle(
								generateModules(
									linkProject(directory, "Main.es"),
								),
								directory,
							),
						).toEqual(["2", "2"])
					},
				)
			}
		})
	})

	// The Namespace has to hoist for the other Module of the cycle to bind it,
	// though its static Property reads a Constant, which never hoists.
	it("binds a Namespace across a cycle whose static Property reads a Constant", async () => {
		await withBuiltProject(
			{
				"Board.es": `import {
	from "./Game.es" {
		Game
	}
}

implementation {
	type Board = List<Integer>

	constant size = 2

	namespace Board for Board {
		static empty: Board = List.repeat(0, times size)

		filled() -> Integer {
			<- @::length()
		}
	}

	function cells(_ game: Game) -> Integer {
		<- game.board::filled()
	}
}

export {
	Board
	cells
}
`,
				"Game.es": `import {
	from "./Board.es" {
		Board
		cells
	}
}

implementation {
	type Game = { board: Board }

	function start() -> Game {
		<- { board = Board.empty }
	}

	function count() -> Integer {
		<- cells(start())
	}
}

export {
	Game
	count
	start
}
`,
				"Main.es": `import {
	from "./Game.es" {
		count
	}
}

implementation {
	Terminal.inspect(count())
}
`,
			},
			async (directory) => {
				expect(analysedAt(directory, "Main.es", "Game.es")).toEqual([])
				expect(
					await runBundle(
						generateModules(linkProject(directory, "Main.es")),
						directory,
					),
				).toEqual(["2"])
			},
		)
	})

	// The same without the annotation. `Game.es` calls a Method, which needs no
	// Type of the Property.
	describe("a Namespace whose unannotated static Property reads a Constant", () => {
		let board = `import {
	from "./Game.es" {
		Game
	}
}

implementation {
	type Board = List<Integer>

	constant size = 2

	namespace Board for Board {
		static empty = List.repeat(0, times size)

		static blank() -> Board {
			<- Board.empty
		}

		filled() -> Integer {
			<- @::length()
		}
	}

	function cells(_ game: Game) -> Integer {
		<- game.board::filled()
	}
}

export {
	Board
	cells
}
`
		let game = (board: string) => `import {
	from "./Board.es" {
		Board
		cells
	}
}

implementation {
	type Game = { board: Board }

	function start() -> Game {
		<- { board = ${board} }
	}

	function count() -> Integer {
		<- cells(start())
	}
}

export {
	Game
	count
	start
}
`
		let main = `import {
	from "./Game.es" {
		count
	}
}

implementation {
	Terminal.inspect(count())
}
`

		it("binds the Namespace across a cycle", async () => {
			await withBuiltProject(
				{
					"Board.es": board,
					"Game.es": game("Board.blank()"),
					"Main.es": main,
				},
				async (directory) => {
					expect(analysedAt(directory, "Main.es", "Game.es")).toEqual(
						[],
					)
					expect(
						await runBundle(
							generateModules(linkProject(directory, "Main.es")),
							directory,
						),
					).toEqual(["2"])
				},
			)
		})

		// Either Module of the cycle may be enriched first, so the read is
		// refused whichever the entry imports first. A Label on the Property
		// would point into `Board.es`, so the report has the read alone.
		it.each([
			["Game.es", main],
			[
				"Board.es",
				`import {
	from "./Board.es" {
		cells
	}
	from "./Game.es" {
		count
	}
}

implementation {
	Terminal.inspect(count())
}
`,
			],
		])(
			"refuses a cycle partner's read of the Property from an entry importing %s first",
			(_, entry) => {
				withProject(
					{
						"Board.es": board,
						"Game.es": game("Board.empty"),
						"Main.es": entry,
					},
					(directory) => {
						let [refusal, ...rest] = analysedAt(
							directory,
							"Main.es",
							"Game.es",
						)

						expect(rest).toEqual([])
						expect(refusal?.code).toBe("uninferable-property-type")
						expect(refusal?.labels).toHaveLength(1)
						expect(refusal?.helps).toEqual([
							"Annotate 'Board.empty' with its Type: 'static empty: Type = …'.",
						])
					},
				)
			},
		)

		it("types a Property an imported Function reads through another", async () => {
			let library = (returned: string, read: string) => `implementation {
	constant size = 4

	function show() -> ${returned} {
		<- ${read}
	}

	namespace Inner {
		static base = size
	}

	namespace Outer {
		static total = Inner.base::add(1)
	}
}

export {
	show
}
`
			let entry = `import {
	from "./Lib.es" {
		show
	}
}

implementation {
	Terminal.inspect(show())
}
`

			withProject(
				{
					"Lib.es": library("String", "Outer.total"),
					"Main.es": entry,
				},
				(directory) => {
					expect(
						codesOf(analysedAt(directory, "Main.es", "Lib.es")),
					).toEqual(["return-type-mismatch"])
				},
			)

			await withBuiltProject(
				{
					"Lib.es": library(
						"Integer",
						"Outer.total::multiply(with 3)",
					),
					"Main.es": entry,
				},
				async (directory) => {
					expect(
						await runBundle(
							generateModules(linkProject(directory, "Main.es")),
							directory,
						),
					).toEqual(["15"])
				},
			)
		})

		it("runs a Method an imported Function calls above it", async () => {
			await withBuiltProject(
				{
					"Sizes.es": `implementation {
	function early() -> Integer {
		<- Sizes.doubled()
	}

	constant size = 4

	namespace Sizes {
		static base = size

		static doubled() -> Integer {
			<- Sizes.base::multiply(with 2)
		}
	}
}

export {
	early
}
`,
					"Main.es": `import {
	from "./Sizes.es" {
		early
	}
}

implementation {
	Terminal.inspect(early())
}
`,
				},
				async (directory) => {
					expect(
						analysedAt(directory, "Main.es", "Sizes.es"),
					).toEqual([])
					expect(
						await runBundle(
							generateModules(linkProject(directory, "Main.es")),
							directory,
						),
					).toEqual(["8"])
				},
			)
		})
	})

	// The Module fixtures, with a cycle among them, linked end to end with every
	// Diagnostic stage run. They are meant to be clean.
	it("links the Module fixtures without a single Diagnostic", () => {
		let linked = linkModuleGraph(
			loadModuleGraph(fixturePath("modules", "Main.es"), diskModuleHost),
		)

		expect(
			[...linked.modules.keys()].map((filePath) =>
				path.relative(fixturePath("modules"), filePath),
			),
		).toEqual([
			"A.es",
			"B.es",
			"Geometry.es",
			path.join("math", "Math.es"),
			"Main.es",
		])

		for (let module of linked.modules.values()) {
			let diagnostics = [...module.diagnostics]

			if (!containsErrors(diagnostics)) {
				diagnostics.push(...validate(module.program))
			}

			expect([
				path.basename(module.module.filePath),
				reportsOf(diagnostics),
			]).toEqual([path.basename(module.module.filePath), []])
		}

		expect(
			Object.keys(
				linked.modules.get(fixturePath("modules", "Main.es"))!.surface
					.kinds,
			).sort(),
		).toEqual(["Rectangle", "describe"])
	})
})

// Every Module of a linked graph through the stages the CLI runs after
// linking. A Module that reported anything fails here, naming itself.
function generateModules(linked: LinkedGraph): ModuleSources {
	return rewriteModules(
		[...linked.modules.values()].map((module) => {
			let name = path.basename(module.module.filePath)
			let diagnostics = [...module.diagnostics]

			if (!containsErrors(diagnostics)) {
				diagnostics.push(...validate(module.program))
			}

			expect([name, reportsOf(diagnostics)]).toEqual([name, []])

			return {
				filePath: module.module.filePath,
				program: optimise(simplify(module.program)),
			}
		}),
		linked.entryPath,
	)
}

// Bundles the graph and imports the result, capturing both `console.log` and
// the stream, as `inspect` and `print` use one each. The bundle inlines its
// runtime.
async function runBundle(
	sources: ModuleSources,
	directory: string,
): Promise<Array<string>> {
	let file = path.join(directory, "bundle.mjs")
	let result = await bundle(sources, {
		sourceFileName: "Main.es",
		outputFileName: file,
	})

	expect(result.diagnostics).toEqual([])
	expect(result.outputs).toHaveLength(1)

	writeFileSync(file, result.outputs[0]!.contents)

	let written = ""
	let originalLog = console.log
	let originalOut = process.stdout.write

	console.log = (...args: Array<unknown>) => {
		written += `${args.map((argument) => String(argument)).join(" ")}\n`
	}

	process.stdout.write = ((chunk: unknown) => {
		written += String(chunk)

		return true
	}) as typeof process.stdout.write

	try {
		await import(file)
	} finally {
		console.log = originalLog
		process.stdout.write = originalOut
	}

	return written === "" ? [] : written.replace(/\n$/, "").split("\n")
}

// `Q.es` belongs to a cycle with `P.es`, and its Constant calls the Methods
// `P.es` provides while `Q.es` loads, before `P.es` has run.
const cyclicProvidedCall: Record<string, string> = {
	"Main.es": `import {
	from "./P.es" { describeAll }
	from "./Q.es" { early }
}

implementation {
	Terminal.print(describeAll({ count = 5 }))
	Terminal.print(early)
}
`,
	"P.es": `import {
	from "./Q.es" {
		Box
		Boxes
	}
}

implementation {
	protocol Alpha {
		size() -> Integer

		twice() -> Integer {
			<- @::size()::multiply(with 2)::add(1000)
		}

		label() -> String {
			<- "size {@::size()} and more"
		}
	}

	function describeAll(_ box: Box) -> String {
		<- box::label()
	}
}

export {
	Alpha
	describeAll
}
`,
	"Q.es": `import {
	from "./P.es" { Alpha }
}

implementation {
	type Box = { count: Integer }

	namespace Boxes for Box is Alpha {
		size() -> Integer {
			<- @.count
		}
	}

	constant box: Box = { count = 3 }
	constant early: String = "{box::twice()} / {box::label()}"
}

export {
	Box
	Boxes
	box
	early
}
`,
}

describe("Module Code Generation", () => {
	// The fixtures, with a cycle, an aliased Constant, a re-export and a Namespace
	// reached only through dispatch, compiled into one bundle and run.
	it("compiles the Module fixtures into one bundle and runs it", async () => {
		let linked = linkModuleGraph(
			loadModuleGraph(fixturePath("modules", "Main.es"), diskModuleHost),
		)
		let sources = generateModules(linked)

		// A rename travels as an ESM `as`, and the emitted name is always the
		// declaration's own.
		expect(sources.sources.get("essence:./math/Math.es")).toContain(
			"squared as square",
		)
		expect(sources.sources.get("essence:./Main.es")).toContain("PI as Pi")

		// A re-export is forwarded straight from the Module it names, so
		// `Rectangle` is never a binding of `Main.es`.
		expect(sources.sources.get("essence:./Main.es")).toContain(
			'} from "essence:./Geometry.es"',
		)

		await withBuiltProject({}, async (directory) => {
			expect(await runBundle(sources, directory)).toEqual([
				"area: 12",
				"25",
				"157",
			])
		})
	})

	// A Module whose exported names all erase still runs, ordered by a bare
	// `import "…"`.
	it("runs a Module it imports nothing bindable from", async () => {
		await withBuiltProject(
			{
				"Main.es": `import {
	from "./Dep.es" { Amount }
}

implementation {
	function total(_ amount: Amount) -> Integer {
		<- amount.cents
	}

	Terminal.inspect(total({ cents = 7 })::toString())
}
`,
				"Dep.es": `implementation {
	Terminal.inspect("Dep")

	type Amount = { cents: Integer }
}

export {
	Amount
}
`,
			},
			async (directory) => {
				let linked = linkModuleGraph(
					loadModuleGraph(
						path.join(directory, "Main.es"),
						diskModuleHost,
					),
				)
				let sources = generateModules(linked)

				expect(sources.sources.get("essence:./Main.es")).toContain(
					'import "essence:./Dep.es"',
				)

				expect(await runBundle(sources, directory)).toEqual([
					'"Dep"',
					'"7"',
				])
			},
		)
	})

	// A Protocol's provided Method is one Function for the whole graph. The
	// Module that declares the Protocol declares it, and the rest import it.
	it("emits one const for a provided Method the whole graph shares", async () => {
		await withBuiltProject(
			{
				"Main.es": `import {
	from "./Shape.es" { Shape }
	from "./Square.es" { Square }
	from "./Square.es" { Squares }
	from "./Disc.es" { Disc }
	from "./Disc.es" { Discs }
}

implementation {
	constant square: Square = { side = 3/1 }
	constant disc: Disc = { radius = 2/1 }

	Terminal.inspect(square::describe())
	Terminal.inspect(disc::describe())
}
`,
				"Shape.es": `implementation {
	protocol Shape {
		area() -> Rational

		describe() -> String {
			<- "area {@::area()}"
		}
	}
}

export {
	Shape
}
`,
				"Square.es": `import {
	from "./Shape.es" { Shape }
}

implementation {
	type Square = { side: Rational }

	namespace Squares for Square is Shape {
		area() -> Rational {
			<- @.side::multiply(with @.side)
		}
	}
}

export {
	Square
	Squares
}
`,
				"Disc.es": `import {
	from "./Shape.es" { Shape }
}

implementation {
	type Disc = { radius: Rational }

	namespace Discs for Disc is Shape {
		area() -> Rational {
			<- @.radius::multiply(with @.radius)
		}
	}
}

export {
	Disc
	Discs
}
`,
			},
			async (directory) => {
				let linked = linkModuleGraph(
					loadModuleGraph(
						path.join(directory, "Main.es"),
						diskModuleHost,
					),
				)
				let sources = generateModules(linked)
				let declarations = [...sources.sources.values()].filter(
					(source) =>
						source.includes("function $es_Shape__describe("),
				)

				expect(declarations).toHaveLength(1)
				expect(sources.sources.get("essence:./Shape.es")).toContain(
					"function $es_Shape__describe(",
				)
				expect(sources.sources.get("essence:./Main.es")).toContain(
					'import { $es_Shape__describe } from "essence:./Shape.es"',
				)
				expect(await runBundle(sources, directory)).toEqual([
					'"area 9"',
					'"area 4"',
				])
			},
		)
	})

	// `C.es` runs before `P.es`, and its witness names the provided Method as it
	// loads. The Method is a hoisted Function, so the witness holds it.
	it("names a provided Method from a Module of a cycle that runs first", async () => {
		await withBuiltProject(
			{
				"Main.es": `import {
	from "./P.es" { answer }
}

implementation {
	Terminal.inspect(answer())
}
`,
				"P.es": `import {
	from "./C.es" { run }
}

implementation {
	protocol Alpha {
		size() -> Integer

		twice() -> Integer {
			<- @::size()::multiply(with 2)
		}
	}

	function answer() -> Integer {
		<- run()
	}
}

export {
	Alpha
	answer
}
`,
				"C.es": `import {
	from "./P.es" { Alpha }
}

implementation {
	type Box = { count: Integer }

	namespace Boxes for Box is Alpha {
		size() -> Integer {
			<- @.count
		}
	}

	function doubled<infer Item is Alpha>(_ item: Item) -> Integer {
		<- item::twice()
	}

	function run() -> Integer {
		constant box: Box = { count = 3 }

		<- doubled(box)
	}
}

export {
	run
}
`,
			},
			async (directory) => {
				let sources = generateModules(
					linkModuleGraph(
						loadModuleGraph(
							path.join(directory, "Main.es"),
							diskModuleHost,
						),
					),
				)

				expect(sources.sources.get("essence:./C.es")).toContain(
					'import { $es_Alpha__twice } from "essence:./P.es"',
				)
				expect(await runBundle(sources, directory)).toEqual(["6"])
			},
		)
	})
	// `Q.es` loads before `P.es` and calls the Methods `P.es` provides while it
	// loads. A provided Method reads nothing of its Module, so it runs then.
	it("calls a provided Method while a Module of a cycle loads", async () => {
		await withBuiltProject(cyclicProvidedCall, async (directory) => {
			let sources = generateModules(
				linkModuleGraph(
					loadModuleGraph(
						path.join(directory, "Main.es"),
						diskModuleHost,
					),
				),
			)

			expect(await runBundle(sources, directory)).toEqual([
				"size 5 and more",
				"1006 / size 3 and more",
			])
		})
	})

	// Under coverage the declaring Module's counter is a hoisted Function, so
	// the early call counts into a table nothing has registered yet.
	it("counts a provided Method called while a Module of a cycle loads", async () => {
		await withBuiltProject(cyclicProvidedCall, async (directory) => {
			let emitted = await emitToMemory(path.join(directory, "Main.es"), {
				optimisation: { ...defaultOptimiserOptions, coverage: true },
			})

			expect(emitted.diagnostics).toEqual([])
			expect(emitted.sources.sources.get("essence:./P.es")).toContain(
				"function $cover(point, value)",
			)
			expect(await runBundle(emitted.sources, directory)).toEqual([
				"size 5 and more",
				"1006 / size 3 and more",
			])
		})
	})

	// A provided Method another Module imports is exported, and one nothing
	// else imports is not, so a one-Module graph exports only its own names.
	it("exports a provided Method only to a Module that imports it", async () => {
		await withBuiltProject(
			{
				"Main.es": `implementation {
	protocol Alpha {
		size() -> Integer

		twice() -> Integer {
			<- @::size()::multiply(with 2)
		}
	}

	type Box = { count: Integer }

	namespace Boxes for Box is Alpha {
		size() -> Integer {
			<- @.count
		}
	}

	constant box: Box = { count = 3 }

	Terminal.inspect(box::twice())
}
`,
			},
			async (directory) => {
				let sources = generateModules(
					linkModuleGraph(
						loadModuleGraph(
							path.join(directory, "Main.es"),
							diskModuleHost,
						),
					),
				)
				let main = sources.sources.get("essence:./Main.es")!

				expect(main).toContain("function $es_Alpha__twice(")
				expect(main).not.toContain("export")
				expect(await runBundle(sources, directory)).toEqual(["6"])
			},
		)
	})

	it("prints through a `toString` a Protocol of another Module provides", async () => {
		await withBuiltProject(
			{
				"Main.es": `import {
	from "./Named.es" { Named }
}

implementation {
	type Box = { size: Integer }

	namespace Boxes for Box is Printable, is Named {}

	constant box: Box = { size = 3 }

	Terminal.print("a {box}")
	Terminal.print(box)
}
`,
				"Named.es": `implementation {
	protocol Named {
		toString() -> String {
			<- "named"
		}
	}
}

export {
	Named
}
`,
			},
			async (directory) => {
				let sources = generateModules(
					linkModuleGraph(
						loadModuleGraph(
							path.join(directory, "Main.es"),
							diskModuleHost,
						),
					),
				)

				expect(await runBundle(sources, directory)).toEqual([
					"a named",
					"named",
				])
			},
		)
	})

	// `Big` extends `Sized` in another Module and provides nothing itself, so
	// the pick reaches the body `Sized` provides.
	it("picks a body a Protocol of another Module inherits", async () => {
		await withBuiltProject(
			{
				"Main.es": `import {
	from "./Sizes.es" { Big }
}

implementation {
	type Box = { v: Integer }

	namespace Boxes for Box is Big {
		size() -> Integer {
			<- @.v
		}

		extra() -> Integer {
			<- 1
		}
	}

	constant box: Box = { v = 3 }

	Terminal.print(box::<Big>describe())
}
`,
				"Sizes.es": `implementation {
	protocol Sized {
		size() -> Integer

		describe() -> String {
			<- "size {@::size()}"
		}
	}

	protocol Big is Sized {
		extra() -> Integer
	}
}

export {
	Big
	Sized
}
`,
			},
			async (directory) => {
				expect(
					await runBundle(
						generateModules(linkProject(directory, "Main.es")),
						directory,
					),
				).toEqual(["size 3"])
			},
		)
	})

	// The Protocols, the conformances and the calls stand in three Modules. A
	// pick says which conformance answers, so each concrete pick runs what the
	// bound beside it runs.
	it("answers a pick across Modules as the bound through the same conformance", async () => {
		await withBuiltProject(
			{
				"Protocols.es": `implementation {
	protocol Base {
		size() -> Integer

		describe() -> String {
			<- "base {@::size()}"
		}
	}

	protocol Left is Base {}

	protocol Right is Base {
		describe() -> String {
			<- "right {@::size()}"
		}
	}

	protocol Both is Left, is Right {}
}

export {
	Base
	Both
	Left
	Right
}
`,
				"Boxes.es": `import {
	from "./Protocols.es" { Both Left }
}

implementation {
	type Box = { v: Integer }

	namespace LeftBoxes for Box is Left {
		size() -> Integer {
			<- 10
		}
	}

	type Crate = { w: Integer }

	namespace Crates for Crate is Both {
		size() -> Integer {
			<- @.w
		}
	}
}

export {
	Box
	Crate
	Crates
	LeftBoxes
}
`,
				"Main.es": `import {
	from "./Protocols.es" { Both Left }
	from "./Boxes.es" { Box Crate Crates LeftBoxes }
}

implementation {
	function viaLeft<infer Item is Left>(_ item: Item) -> String {
		<- item::<Left>describe()
	}

	function viaBoth<infer Item is Both>(_ item: Item) -> String {
		<- item::<Both>describe()
	}

	constant box: Box = { v = 3 }
	constant crate: Crate = { w = 7 }

	Terminal.inspect(box::<Left>describe())
	Terminal.inspect(viaLeft(box))
	Terminal.inspect(crate::<Left>describe())
	Terminal.inspect(viaLeft(crate))
	Terminal.inspect(crate::<Both>describe())
	Terminal.inspect(viaBoth(crate))
}
`,
			},
			async (directory) => {
				expect(
					await runBundle(
						generateModules(linkProject(directory, "Main.es")),
						directory,
					),
				).toEqual([
					'"base 10"',
					'"base 10"',
					'"right 7"',
					'"right 7"',
					'"right 7"',
					'"right 7"',
				])
			},
		)
	})

	it("reaches a `constructor` a Protocol of another Module provides through a bound", async () => {
		await withBuiltProject(
			{
				"Main.es": `import {
	from "./Shown.es" {
		Shown
		Named
	}
}

implementation {
	type Box = { size: Integer }

	namespace Boxes for Box is Shown, is Named {
		describe() -> String {
			<- "box "
		}
	}

	function show<infer Item is Shown>(_ item: Item) -> String {
		<- item::describe()::append(item::constructor())
	}

	constant box: Box = { size = 3 }

	Terminal.print(show(box))
}
`,
				"Shown.es": `implementation {
	protocol Shown {
		constructor() -> String
		describe() -> String
	}

	protocol Named {
		constructor() -> String {
			<- "named"
		}
	}
}

export {
	Shown
	Named
}
`,
			},
			async (directory) => {
				let sources = generateModules(
					linkModuleGraph(
						loadModuleGraph(
							path.join(directory, "Main.es"),
							diskModuleHost,
						),
					),
				)

				expect(await runBundle(sources, directory)).toEqual([
					"box named",
				])
			},
		)
	})

	it("reads a static `constructor` off a bound of another Module's Protocol", async () => {
		await withBuiltProject(
			{
				"Main.es": `import {
	from "./Made.es" {
		Made
		Echo
		Box
		Boxes
		build
	}
}

implementation {
	function echo<infer Item is Echo>(_ item: Item) -> String {
		<- item::twice()
	}

	function local<infer Item is Made>(_ item: Item) -> String {
		<- Item.constructor()
	}

	constant box: Box = { n = 1 }

	Terminal.print(build(box))
	Terminal.print(echo(box))
	Terminal.print(local(box))
}
`,
				"Made.es": `implementation {
	protocol Made {
		static constructor() -> String
		prototype() -> String
	}

	protocol Echo is Made {
		twice() -> String {
			<- Self.constructor()::append(@::prototype())
		}
	}

	type Box = { n: Integer }

	namespace Boxes for Box is Echo {
		static constructor() -> String {
			<- "made"
		}

		prototype() -> String {
			<- "p{@.n}"
		}
	}

	function build<infer Item is Made>(_ item: Item) -> String {
		<- Item.constructor()::append(item::prototype())
	}
}

export {
	Made
	Echo
	Box
	Boxes
	build
}
`,
			},
			async (directory) => {
				let sources = generateModules(
					linkModuleGraph(
						loadModuleGraph(
							path.join(directory, "Main.es"),
							diskModuleHost,
						),
					),
				)

				expect(await runBundle(sources, directory)).toEqual([
					"madep1",
					"madep1",
					"made",
				])
			},
		)
	})

	it("solves a condition on another Module's Choice from its Type Arguments", async () => {
		await withBuiltProject(
			{
				"Main.es": `import {
	from "./Tag.es" {
		Named
		Tag
		Tags
	}
}

implementation {
	constant annotated: Tag<Integer> = Tag<Integer>#A
	constant inferred = Tag<String>#B

	Terminal.print(annotated::greet())
	Terminal.print(inferred::greet())
}
`,
				"Tag.es": `implementation {
	protocol Named {
		greet() -> String {
			<- "named"
		}
	}

	choice Tag<T> {
		A,
		B,
	}

	namespace Tags<infer T> for Tag<T> is Named where T is Equatable {}
}

export {
	Named
	Tag
	Tags
}
`,
			},
			async (directory) => {
				let sources = generateModules(
					linkModuleGraph(
						loadModuleGraph(
							path.join(directory, "Main.es"),
							diskModuleHost,
						),
					),
				)

				expect(await runBundle(sources, directory)).toEqual([
					"named",
					"named",
				])
			},
		)
	})

	it("runs a `toString` another Module's Protocol provides on a Choice", async () => {
		await withBuiltProject(
			{
				"Main.es": `import {
	from "./Named.es" { Named }
}

implementation {
	choice Colour {
		Red,
		Green,
	}

	namespace Colours for Colour is Printable, is Named {}

	constant red: Colour = #Red

	Terminal.print(red)
	Terminal.print(red::toString())
	Terminal.print("{red}")
}
`,
				"Named.es": `implementation {
	protocol Named {
		toString() -> String {
			<- "named"
		}
	}
}

export {
	Named
}
`,
			},
			async (directory) => {
				let sources = generateModules(
					linkModuleGraph(
						loadModuleGraph(
							path.join(directory, "Main.es"),
							diskModuleHost,
						),
					),
				)

				expect(await runBundle(sources, directory)).toEqual([
					"named",
					"named",
					"named",
				])
			},
		)
	})

	it("runs a Choice's derived printing where the providing conformance does not hold", async () => {
		await withBuiltProject(
			{
				"Main.es": `import {
	from "./Tag.es" {
		IntegerLoud
		Named
		Tag
		Tags
	}
}

implementation {
	constant held: Tag<Integer> = Tag<Integer>#A
	constant unheld: Tag<String> = Tag<String>#B

	Terminal.print(held)
	Terminal.print(held::toString())
	Terminal.print(unheld)
	Terminal.print(unheld::toString())
}
`,
				"Tag.es": `implementation {
	protocol Loud {
		shout() -> String
	}

	namespace IntegerLoud for Integer is Loud {
		shout() -> String {
			<- "!"
		}
	}

	protocol Named {
		toString() -> String {
			<- "named"
		}
	}

	choice Tag<T> {
		A,
		B,
	}

	namespace Tags<infer T> for Tag<T> is Printable, is Named where T is Loud {}
}

export {
	IntegerLoud
	Named
	Tag
	Tags
}
`,
			},
			async (directory) => {
				let sources = generateModules(
					linkModuleGraph(
						loadModuleGraph(
							path.join(directory, "Main.es"),
							diskModuleHost,
						),
					),
				)

				expect(await runBundle(sources, directory)).toEqual([
					"named",
					"named",
					"B",
					"B",
				])
			},
		)
	})

	// A Module body runs once, on first import, however many Modules reach it.
	// In the diamond `Shared.es` prints once, ahead of its importers.
	it("runs a Module body once however many Modules import it", async () => {
		await withBuiltProject(
			{
				"Main.es": `import {
	from "./Left.es" { left }
	from "./Right.es" { right }
}

implementation {
	Terminal.inspect("Main")
	Terminal.inspect(left()::add(right())::toString())
}
`,
				"Left.es": `import {
	from "./Shared.es" { shared }
}

implementation {
	Terminal.inspect("Left")

	function left() -> Integer {
		<- shared()
	}
}

export {
	left
}
`,
				"Right.es": `import {
	from "./Shared.es" { shared }
}

implementation {
	Terminal.inspect("Right")

	function right() -> Integer {
		<- shared()::multiply(with 2)
	}
}

export {
	right
}
`,
				"Shared.es": `implementation {
	Terminal.inspect("Shared")

	function shared() -> Integer {
		<- 21
	}
}

export {
	shared
}
`,
			},
			async (directory) => {
				let linked = linkModuleGraph(
					loadModuleGraph(
						path.join(directory, "Main.es"),
						diskModuleHost,
					),
				)

				expect(
					await runBundle(generateModules(linked), directory),
				).toEqual(['"Shared"', '"Left"', '"Right"', '"Main"', '"63"'])
			},
		)
	})

	// Two Modules each declaring `choice Colour` declare two Types, so a value
	// of one is not claimed by a check written for the other. Value tags and
	// descriptors both render against the entry's directory.
	it("keeps two Modules' same-named Choices apart at run time", async () => {
		await withBuiltProject(
			{
				"Main.es": `import {
	from "./Other.es" { Colour as Theirs }
	from "./Other.es" { theirRed }
}

implementation {
	choice Colour {
		Red,
		Green,
	}

	constant mine: Colour = #Red

	function describe(_ value: Colour | Theirs) -> String {
		<- match value -> String {
			case Colour { <- "mine" }
			case Theirs { <- "theirs" }
		}
	}

	Terminal.inspect(describe(mine))
	Terminal.inspect(describe(theirRed))
}
`,
				"Other.es": `implementation {
	choice Colour {
		Red,
		Green,
	}

	constant theirRed: Colour = #Red
}

export {
	Colour
	theirRed
}
`,
			},
			async (directory) => {
				let linked = linkModuleGraph(
					loadModuleGraph(
						path.join(directory, "Main.es"),
						diskModuleHost,
					),
				)
				let sources = generateModules(linked)

				// The tags differ by their declaring Module and name no machine path.
				expect(sources.sources.get("essence:./Main.es")).toContain(
					'$type.createCase("./Main.es#Colour#Red")',
				)
				expect(sources.sources.get("essence:./Other.es")).toContain(
					'$type.createCase("./Other.es#Colour#Red")',
				)

				expect(await runBundle(sources, directory)).toEqual([
					'"mine"',
					'"theirs"',
				])
			},
		)
	})

	// A payload default merges where the Case is built, which may be a Module
	// that never named the Choice. So the default travels on the Case Type as a
	// literal. See "Payload defaults" in packages/compiler/src/simplifier/DEVELOPMENT.md.
	it("fills a payload default in a Module that never named the Choice", async () => {
		await withBuiltProject(
			{
				"Main.es": `import {
	from "./Fetching.es" { describe }
}

implementation {
	Terminal.inspect(describe(#Get({ url = "/a" })))
	Terminal.inspect(describe(#Get({ url = "/b", retries = 3 })))
	Terminal.inspect(describe(#Blank({})))
}
`,
				"Fetching.es": `implementation {
	choice Fetch {
		Get { url: String, retries: Integer } = { retries = 0 },
		Blank { tags: List<String> } = { tags = [] },
	}

	function describe(_ fetch: Fetch) -> String {
		<- match fetch -> String {
			case #Get({ url, retries }) { <- "{url} after {retries}" }
			case #Blank({ tags })       { <- "blank {tags::length()}" }
		}
	}
}

export {
	describe
}
`,
			},
			async (directory) => {
				let linked = linkModuleGraph(
					loadModuleGraph(
						path.join(directory, "Main.es"),
						diskModuleHost,
					),
				)
				let sources = generateModules(linked)

				// The filled member is emitted into the construction, and its `0` is pooled
				// with `Main.es`'s own constants.
				let main = sources.sources.get("essence:./Main.es") as string

				expect(main).toContain(
					'import { describe } from "essence:./Fetching.es"',
				)
				expect(main).toContain(
					"const $pool_1 = Integer.createInteger(0)",
				)
				expect(main).toContain(
					'[$type.typeKeySymbol]: "./Fetching.es#Fetch#Get",\n\turl: $pool_0,\n\tretries: $pool_1',
				)

				expect(await runBundle(sources, directory)).toEqual([
					'"/a after 0"',
					'"/b after 3"',
					'"blank 0"',
				])
			},
		)
	})

	// What a path key reaches into is a fact about the default. It travels on
	// the Type to a Module merging into a default declared elsewhere.
	it("merges a path key into a default declared in another Module", async () => {
		await withBuiltProject(
			{
				"Main.es": `import {
	from "./Connecting.es" { connect }
	from "./Connecting.es" { Endpoint }
	from "./Connecting.es" { describe }
}

implementation {
	Terminal.inspect(connect(using { server.port = 1 }))

	constant bound: Endpoint = #Bound({ server.host = "far" })

	Terminal.inspect(describe(bound))
}
`,
				"Connecting.es": `implementation {
	type Server = { host: String, port: Integer }
	type Options = { retries: Integer, server: Server }

	§§ Answers the address.
	§§
	§§ @param using — how to connect.
	§§ @returns — the address.
	function connect(
		using options: Options = {
			retries = 3,
			server = { host = "near", port = 80 },
		},
	) -> String {
		<- "{options.server.host}:{options.server.port} after {options.retries}"
	}

	choice Endpoint {
		Bound { server: Server } = { server = { host = "any", port = 443 } },
	}

	§§ Answers a description of an Endpoint.
	§§
	§§ @param _ — the Endpoint to describe.
	§§ @returns — the description.
	function describe(_ endpoint: Endpoint) -> String {
		<- match endpoint -> String {
			case #Bound({ server }) { <- "{server.host}:{server.port}" }
		}
	}
}

export {
	connect
	Endpoint
	describe
}
`,
			},
			async (directory) => {
				let linked = linkModuleGraph(
					loadModuleGraph(
						path.join(directory, "Main.es"),
						diskModuleHost,
					),
				)
				let sources = generateModules(linked)

				expect(await runBundle(sources, directory)).toEqual([
					'"near:1 after 3"',
					'"far:443"',
				])
			},
		)
	})

	// A payload default may name a Constant of the Choice's own Module, baked into
	// the Case Type as its value. The constructing Module never imports it.
	it("bakes a Constant into a payload default read in another Module", async () => {
		await withBuiltProject(
			{
				"Main.es": `import {
	from "./Fetching.es" { Fetch }
}

implementation {
	constant call: Fetch = #Get({ url = "/x" })

	Terminal.inspect(call)
}
`,
				"Fetching.es": `implementation {
	constant standardHeaders: List<String> = ["Accept"]

	choice Fetch {
		Get { url: String, headers: List<String> } = { headers = standardHeaders },
	}
}

export { Fetch }
`,
			},
			async (directory) => {
				let linked = linkModuleGraph(
					loadModuleGraph(
						path.join(directory, "Main.es"),
						diskModuleHost,
					),
				)
				let sources = generateModules(linked)

				// The structural rendering prints no Module before `Fetch#Get`. The
				// baked default is the `headers` member.
				expect(await runBundle(sources, directory)).toEqual([
					'Fetch#Get { url = "/x", headers = [ "Accept" ] }',
				])
			},
		)
	})

	// A Type crosses an import edge and an Expression does not, so a default may
	// not name an imported Constant.
	it("refuses a payload default that names an imported Constant", () => {
		withProject(
			{
				"Main.es": `import {
	from "./Headers.es" { standardHeaders }
}

implementation {
	choice Fetch {
		Get { url: String, headers: List<String> } = { headers = standardHeaders },
	}
}
`,
				"Headers.es": `implementation {
	constant standardHeaders: List<String> = ["Accept"]
}

export { standardHeaders }
`,
			},
			(directory) => {
				let linked = linkModuleGraph(
					loadModuleGraph(
						path.join(directory, "Main.es"),
						diskModuleHost,
					),
				)

				expect(
					codesOf(linkedAt(directory, linked, "Main.es").diagnostics),
				).toEqual(["case-default-not-a-literal"])
			},
		)
	})
})

// A provided Method is emitted once, in the bundle's band above every
// Module, where no Namespace a Module declares or imports is bound.
describe("What a provided body reaches", () => {
	function refusalsIn(
		files: Record<string, string>,
		name: string,
	): Array<[string, string, number | undefined]> {
		return withProject(files, (directory) =>
			analysedAt(directory, "Main.es", name).map((diagnostic) => [
				diagnostic.code,
				diagnostic.message,
				diagnostic.position?.start.line,
			]),
		)
	}

	const helpersModule = `implementation {
	namespace Helpers for Integer {
		shout() -> String {
			<- "H{@}"
		}
	}
}

export {
	Helpers
}
`

	const shoutingModule = `import {
	from "./A.es" { Helpers }
}

implementation {
	protocol Shouted {
		size() -> Integer

		describe() -> String {
			<- @::size()::shout()
		}
	}
}

export {
	Shouted
}
`

	const shoutedMain = (imports: string, statements: string) => `import {
	${imports}
}

implementation {
	namespace IntegerShouted for Integer is Shouted {
		size() -> Integer {
			<- @::add(1)
		}
	}

	${statements}
}
`

	it("refuses a body calling a Method of a Namespace its Module imports or declares", () => {
		expect(
			refusalsIn(
				{
					"A.es": helpersModule,
					"B.es": shoutingModule,
					"Main.es": shoutedMain(
						'from "./B.es" { Shouted }',
						"Terminal.print(3::describe())",
					),
				},
				"B.es",
			),
		).toEqual([
			[
				"provided-method-out-of-reach",
				"'shout' can not be called from a provided Method",
				10,
			],
		])
		expect(
			refusalsIn(
				{
					"A.es": helpersModule,
					"B.es": shoutingModule,
					"Main.es": shoutedMain(
						'from "./A.es" { Helpers }\n\tfrom "./B.es" { Shouted }',
						"Terminal.print(3::describe())\n\tTerminal.print(4::shout())",
					),
				},
				"B.es",
			),
		).toEqual([
			[
				"provided-method-out-of-reach",
				"'shout' can not be called from a provided Method",
				10,
			],
		])
		expect(
			refusalsIn(
				{
					"B.es": `implementation {
	namespace Helpers for Integer {
		shout() -> String {
			<- "H{@}"
		}
	}

	protocol Shouted {
		size() -> Integer

		describe() -> String {
			<- @::size()::shout()
		}
	}
}

export {
	Shouted
}
`,
					"Main.es": shoutedMain(
						'from "./B.es" { Shouted }',
						"Terminal.print(3::describe())",
					),
				},
				"B.es",
			),
		).toEqual([
			[
				"provided-method-out-of-reach",
				"'shout' can not be called from a provided Method",
				12,
			],
		])
	})

	// `X`'s body answers `R`'s `m() -> String` with an Integer, so `Y`'s
	// is the one that fulfils it.
	const fulfillingProtocols = `protocol X {
		m() -> Integer {
			<- 7
		}
	}

	protocol R {
		m() -> String
	}

	namespace IntegerAll for Integer is X, is Y, is R {
		size() -> Integer {
			<- @::add(1)
		}
	}

	function viaR <infer T is R>(_ t: T) -> String {
		<- t::m()
	}

	Terminal.print(viaR(3))`

	const yBody = `protocol Y {
		size() -> Integer

		m() -> String {
			<- @::size()::shout()
		}
	}`

	it("refuses the body that fulfils a requirement where it calls a Namespace of its Module", () => {
		expect(
			refusalsIn(
				{
					"Main.es": `implementation {
	namespace Helpers for Integer {
		shout() -> String {
			<- "H{@}"
		}
	}

	${yBody}

	${fulfillingProtocols}
}
`,
				},
				"Main.es",
			),
		).toEqual([
			[
				"provided-method-out-of-reach",
				"'shout' can not be called from a provided Method",
				12,
			],
		])
	})

	it("refuses that body where another Module declares it", () => {
		let files = {
			"A.es": helpersModule,
			"B.es": `import {
	from "./A.es" { Helpers }
}

implementation {
	${yBody}
}

export {
	Y
}
`,
			"Main.es": `import {
	from "./B.es" { Y }
}

implementation {
	${fulfillingProtocols}
}
`,
		}

		expect(refusalsIn(files, "B.es")).toEqual([
			[
				"provided-method-out-of-reach",
				"'shout' can not be called from a provided Method",
				10,
			],
		])
		expect(refusalsIn(files, "Main.es").map(([code]) => code)).toEqual([
			"dependency-has-errors",
		])
	})

	it("refuses the body its own witness runs where it calls an imported Namespace", () => {
		expect(
			refusalsIn(
				{
					"A.es": `implementation {
	namespace Helpers for Integer {
		twice() -> Integer {
			<- @::multiply(with 2)
		}
	}
}

export {
	Helpers
}
`,
					"B.es": `import {
	from "./A.es" { Helpers }
}

implementation {
	protocol Y {
		k() -> Integer {
			<- 21::twice()
		}
	}
}

export {
	Y
}
`,
					"Main.es": `import {
	from "./B.es" { Y }
}

implementation {
	protocol X {
		k() -> Number {
			<- 7
		}
	}

	protocol S {
		k() -> Number
		describe() -> String
	}

	protocol Own {
		k() -> Integer

		describe() -> String {
			<- "own {@::k()}"
		}
	}

	namespace IntegerAll for Integer is X, is Y, is S, is Own {}

	function viaS <infer T is S>(_ t: T) -> String {
		<- "{t::k()} {t::describe()}"
	}

	Terminal.print(viaS(3))
}
`,
				},
				"B.es",
			),
		).toEqual([
			[
				"provided-method-out-of-reach",
				"'twice' can not be called from a provided Method",
				8,
			],
		])
	})

	it("refuses a body handing its witness to a Method of a generic Namespace", () => {
		expect(
			refusalsIn(
				{
					"Main.es": `implementation {
	protocol Tagged {
		tag() -> String
	}

	protocol Sized {
		describe() -> String
	}

	protocol Listed is Tagged {
		describe() -> String {
			<- [@, @]::tagAll()
		}
	}

	namespace Lists<infer Item> for List<Item> {
		tagAll<Item is Tagged>() -> String {
			<- @::map((_ i: Item) -> String { <- i::tag() })::join(with "+")
		}
	}

	namespace IntegerL for Integer is Sized, is Listed {
		tag() -> String {
			<- "t{@}"
		}
	}

	function gauge <infer T is Sized>(_ t: T) -> String {
		<- t::describe()
	}

	Terminal.print(gauge(4))
}
`,
				},
				"Main.es",
			),
		).toEqual([
			[
				"provided-method-out-of-reach",
				"'tagAll' can not be called from a provided Method",
				12,
			],
		])
	})

	it("refuses a Function literal in a body calling a Namespace of its Module", () => {
		expect(
			refusalsIn(
				{
					"B.es": `implementation {
	protocol Z {
		zv() -> Integer
	}

	namespace IntegerZ for Integer is Z {
		zv() -> Integer {
			<- @::add(100)
		}
	}

	protocol P {
		size() -> Integer

		describe() -> String {
			<- "{@::size()} {[3]::map((_ i: Integer) -> Integer { <- i::zv() })}"
		}
	}
}

export {
	P
}
`,
					"Main.es": `import {
	from "./B.es" { P }
}

implementation {
	namespace IntegerP for Integer is P {
		size() -> Integer {
			<- @::add(1)
		}
	}

	Terminal.print(3::describe())
}
`,
				},
				"B.es",
			),
		).toEqual([
			[
				"provided-method-out-of-reach",
				"'zv' can not be called from a provided Method",
				16,
			],
		])
	})

	it("refuses a body calling a Namespace another Module declares, in a cycle or not", () => {
		let a = (imports: string) => `${imports}implementation {
	namespace ShowB<infer Item> for NonEmptyList<Item> {
		show<Item is Printable>() -> String {
			<- "B{@::firstItem()}"
		}
	}
}

export {
	ShowB
}
`
		let files = (imports: string) => ({
			"A.es": a(imports),
			"B.es": `import {
	from "./A.es" { ShowB }
}

implementation {
	protocol P is Printable {
		describe() -> String {
			<- [@]::show()
		}
	}
}

export {
	P
}
`,
			"Main.es": `import {
	from "./B.es" { P }
}

implementation {
	type Box = { n: Integer }

	namespace Boxes for Box is P {
		toString() -> String {
			<- "box"
		}
	}

	constant b: Box = { n = 1 }
	Terminal.print(b::describe())
}
`,
		})
		let refusal: Array<[string, string, number]> = [
			[
				"provided-method-out-of-reach",
				"'show' can not be called from a provided Method",
				8,
			],
		]

		expect(refusalsIn(files(""), "B.es")).toEqual(refusal)
		expect(
			refusalsIn(files('import {\n\tfrom "./B.es" { P }\n}\n\n'), "B.es"),
		).toEqual(refusal)
	})

	// A Namespace a Function literal declares is a class of the literal's
	// block, so the body around it still reads the Program's of that name.
	const besideLiteral = (
		declarations: string,
		uses: string,
	) => `implementation {
	${declarations}

	protocol P {
		size() -> Integer

		describe() -> String {
			constant f = () -> String {
				namespace Helpers for String {
					whisper() -> String {
						<- "inner{@}"
					}
				}

				<- "a"::whisper()
			}

			${uses}
		}
	}

	namespace IntegerP for Integer is P {
		size() -> Integer {
			<- @::add(1)
		}
	}

	Terminal.print(3::describe())
}
`

	it("refuses a call beside a Function literal declaring a Namespace of its name", () => {
		expect(
			refusalsIn(
				{
					"Main.es": besideLiteral(
						`namespace Helpers for Integer {
		shout() -> String {
			<- "outer{@}"
		}
	}`,
						'<- "{f()}/{@::size()::shout()}"',
					),
				},
				"Main.es",
			),
		).toEqual([
			[
				"provided-method-out-of-reach",
				"'shout' can not be called from a provided Method",
				22,
			],
		])
	})

	it("refuses a witness beside a Function literal declaring a Namespace of its name", () => {
		expect(
			refusalsIn(
				{
					"Main.es": besideLiteral(
						`type Box = { n: Integer }

	namespace Helpers for Box is Printable {
		toString() -> String {
			<- "box{@.n}"
		}
	}`,
						'constant b: Box = { n = @::size() }\n\n\t\t\t<- "{f()}/{b}"',
					),
				},
				"Main.es",
			),
		).toEqual([
			[
				"provided-method-out-of-reach",
				"'Helpers' can not be reached from a provided Method",
				26,
			],
		])
	})

	it("runs a Function literal in a body calling the Namespace it declares", async () => {
		await withBuiltProject(
			{
				"Main.es": besideLiteral(
					`namespace Helpers for Integer {
		shout() -> String {
			<- "outer{@}"
		}
	}`,
					'<- "{f()}/{@::size()}"',
				),
			},
			async (directory) => {
				expect(
					await runBundle(
						generateModules(linkProject(directory, "Main.es")),
						directory,
					),
				).toEqual(["innera/4"])
			},
		)
	})

	it("runs a body that declares its Namespace, reads a Choice or builds an all-provided witness", async () => {
		await withBuiltProject(
			{
				"Main.es": `implementation {
	namespace Helpers for Integer {
		shout() -> String {
			<- "outer"
		}
	}

	choice Colour {
		Red,
		Green,
	}

	protocol Tagged {
		tag() -> String {
			<- "t"
		}
	}

	namespace IntegerTagged for Integer is Tagged {}

	protocol Sized {
		size() -> Integer

		describe() -> String {
			namespace Helpers for Integer {
				shout() -> String {
					<- "inner"
				}
			}

			constant colour = Colour#Red

			<- "{@::size()::shout()} {colour::is(Colour#Green)} {[colour]::contains(Colour#Red)} {@::size()::tag()}"
		}
	}

	namespace IntegerSized for Integer is Sized {
		size() -> Integer {
			<- @
		}
	}

	Terminal.print(3::describe())
}
`,
			},
			async (directory) => {
				expect(
					await runBundle(
						generateModules(linkProject(directory, "Main.es")),
						directory,
					),
				).toEqual(["inner false true t"])
			},
		)
	})
})

// A Protocol is known by the Module that declares it and its name. An
// import alias is only a spelling, and two Modules' `Sized` are two Protocols.
describe("Protocol identity", () => {
	const sizedModule = `implementation {
	protocol Sized {
		size() -> Integer
	}

	namespace IntegerSized for Integer is Sized {
		size() -> Integer {
			<- @
		}
	}

	function measure <infer Item is Sized>(_ item: Item) -> Integer {
		<- item::size()
	}
}

export {
	IntegerSized
	Sized
	measure
}
`

	const countedModule = `implementation {
	protocol Sized {
		count() -> Integer
	}

	namespace IntegerCounted for Integer is Sized {
		count() -> Integer {
			<- 100
		}
	}
}

export {
	IntegerCounted
	Sized
}
`

	it("tells an aliased Protocol from another of its name", async () => {
		await withBuiltProject(
			{
				"Main.es": `import {
	from "./Counted.es" {
		IntegerCounted
		Sized
	}
	from "./Sized.es" {
		IntegerSized
		Sized as Measurable
	}
}

implementation {
	function gauge <infer Item is Measurable>(_ item: Item) -> Integer {
		<- item::size()
	}

	function tally <infer Item is Sized>(_ item: Item) -> Integer {
		<- item::count()
	}

	Terminal.inspect(gauge(3))
	Terminal.inspect(tally(3))
}
`,
				"Counted.es": countedModule,
				"Sized.es": sizedModule,
			},
			async (directory) => {
				expect(
					await runBundle(
						generateModules(linkProject(directory, "Main.es")),
						directory,
					),
				).toEqual(["3", "100"])
			},
		)
	})

	it("conforms through an aliased import to that Protocol alone", async () => {
		await withBuiltProject(
			{
				"Main.es": `import {
	from "./Counted.es" {
		IntegerCounted
		Sized
	}
	from "./Sized.es" { Sized as Measurable }
}

implementation {
	namespace IntegerMeasured for Integer is Measurable {
		size() -> Integer {
			<- @
		}
	}

	function gauge <infer Item is Measurable>(_ item: Item) -> Integer {
		<- item::size()
	}

	function tally <infer Item is Sized>(_ item: Item) -> Integer {
		<- item::count()
	}

	Terminal.inspect(gauge(3))
	Terminal.inspect(tally(3))
}
`,
				"Counted.es": countedModule,
				"Sized.es": `implementation {
	protocol Sized {
		size() -> Integer
	}
}

export {
	Sized
}
`,
			},
			async (directory) => {
				expect(
					await runBundle(
						generateModules(linkProject(directory, "Main.es")),
						directory,
					),
				).toEqual(["3", "100"])
			},
		)
	})

	// `Main.es` meets `measure`'s bound only through its own `Sized`,
	// which asks for `count` where the bound's asks for `size`.
	it("refuses a call whose bound only another Protocol of its name meets", () => {
		withProject(
			{
				"Main.es": `import {
	from "./Sized.es" { measure }
}

implementation {
	protocol Sized {
		count() -> Integer
	}

	namespace IntegerCounted for Integer is Sized {
		count() -> Integer {
			<- 100
		}
	}

	Terminal.inspect(measure(3))
}
`,
				"Sized.es": sizedModule,
			},
			(directory) => {
				let refusal = analysedAt(directory, "Main.es", "Main.es").find(
					(diagnostic) => diagnostic.code === "unsatisfied-bound",
				)

				expect(refusal?.message).toBe(
					"Integer does not conform to 'Sized'",
				)
				expect(refusal?.position?.start.line).toBe(16)
				expect(refusal?.notes).toEqual([
					"No Namespace in scope makes Integer conform to 'Sized'.",
					"'Sized' here is the Protocol this file declares; the bound asks for the 'Sized' that Sized.es declares.",
					"'IntegerCounted' conforms to the 'Sized' this file declares, which is a different Protocol.",
				])
				expect(refusal?.helps).toEqual([
					"'IntegerSized' in ./Sized.es makes Integer conform to 'Sized' — import it.",
				])
				expect(refusal?.data).toEqual({
					kind: "import-declaration",
					name: "IntegerSized",
					modulePath: path.join(directory, "Sized.es"),
				})
			},
		)
	})

	it("refuses a call whose bound only a nested Protocol of its name meets", () => {
		withProject(
			{
				"Main.es": `implementation {
	protocol Sized {
		size() -> Integer
	}

	function measure <infer Item is Sized>(_ item: Item) -> Integer {
		<- item::size()
	}

	function inner() -> Integer {
		protocol Sized {
			count() -> Integer
		}

		namespace IntegerCounted for Integer is Sized {
			count() -> Integer {
				<- 100
			}
		}

		<- measure(3)
	}

	Terminal.inspect(inner())
}

export {
	inner
}
`,
			},
			(directory) => {
				let refusal = analysedAt(directory, "Main.es", "Main.es").find(
					(diagnostic) => diagnostic.code === "unsatisfied-bound",
				)

				expect(refusal?.message).toBe(
					"Integer does not conform to 'Sized'",
				)
				expect(refusal?.position?.start.line).toBe(21)
				expect(refusal?.notes).toEqual([
					"No Namespace in scope makes Integer conform to 'Sized'.",
					"'Sized' here is the Protocol this file declares on line 11; the bound asks for the 'Sized' that this file declares at its top level.",
					"'IntegerCounted' conforms to the 'Sized' this file declares on line 11, which is a different Protocol.",
				])
			},
		)
	})

	it("reaches a provided Method through a conformance written under an alias", async () => {
		await withBuiltProject(
			{
				"Main.es": `import {
	from "./Sized.es" { Sized as Measurable }
}

implementation {
	type Bag = { items: List<Integer> }

	namespace Bags for Bag is Measurable {
		size() -> Integer {
			<- @.items::length()
		}
	}

	constant bag: Bag = { items = [1, 2, 3] }

	Terminal.inspect(bag::isBig())
}
`,
				"Sized.es": `implementation {
	protocol Sized {
		size() -> Integer

		isBig() -> Boolean {
			<- @::size()::isGreaterThan(2)
		}
	}
}

export {
	Sized
}
`,
			},
			async (directory) => {
				expect(
					await runBundle(
						generateModules(linkProject(directory, "Main.es")),
						directory,
					),
				).toEqual(["true"])
			},
		)
	})

	// Two names for one Protocol offer its provided Method once.
	it("reaches a provided Method of a Protocol bound under two names", async () => {
		await withBuiltProject(
			{
				"Main.es": `import {
	from "./Sized.es" {
		Sized
		Sized as Measurable
	}
}

implementation {
	type Bag = { items: List<Integer> }

	namespace Bags for Bag is Measurable {
		size() -> Integer {
			<- @.items::length()
		}
	}

	function gauge <infer Item is Sized>(_ item: Item) -> Boolean {
		<- item::isBig()
	}

	constant bag: Bag = { items = [1, 2, 3] }

	Terminal.inspect(bag::isBig())
	Terminal.inspect(gauge(bag))
}
`,
				"Sized.es": `implementation {
	protocol Sized {
		size() -> Integer

		isBig() -> Boolean {
			<- @::size()::isGreaterThan(2)
		}
	}
}

export {
	Sized
}
`,
			},
			async (directory) => {
				expect(
					await runBundle(
						generateModules(linkProject(directory, "Main.es")),
						directory,
					),
				).toEqual(["true", "true"])
			},
		)
	})

	it("grants a Protocol an extension names under an alias", async () => {
		await withBuiltProject(
			{
				"Main.es": `import {
	from "./Sized.es" {
		Sized as Measurable
		measure
	}
}

implementation {
	protocol Big is Measurable {
		isBig() -> Boolean
	}

	namespace IntegerBig for Integer is Big {
		size() -> Integer {
			<- @
		}

		isBig() -> Boolean {
			<- @::isGreaterThan(2)
		}
	}

	Terminal.inspect(measure(3))
}
`,
				"Sized.es": sizedModule
					.replace(
						`
	namespace IntegerSized for Integer is Sized {
		size() -> Integer {
			<- @
		}
	}
`,
						"",
					)
					.replace("\tIntegerSized\n", ""),
			},
			async (directory) => {
				expect(
					await runBundle(
						generateModules(linkProject(directory, "Main.es")),
						directory,
					),
				).toEqual(["3"])
			},
		)
	})

	// `Sized.es` names `Sized` from a cycle partner, whose import is bound
	// only after the hoist has read its clauses. `Main.es` holds the Namespaces
	// through its own imports, which share what the settling writes.
	it("settles a clause and a condition naming a Protocol from a cycle partner", async () => {
		await withBuiltProject(
			{
				"Entry.es": `import {
	from "./Main.es" { run }
}

implementation {
	Terminal.inspect(run())
}
`,
				"Main.es": `import {
	from "./Sized.es" {
		IntegerSized
		ListSized
	}
}

implementation {
	protocol Sized {
		size() -> Integer
	}

	function measure <infer Item is Sized>(_ item: Item) -> Integer {
		<- item::size()
	}

	function run() -> Integer {
		<- measure(3)::add(measure([1, 2]))
	}
}

export {
	Sized
	run
}
`,
				"Sized.es": `import {
	from "./Main.es" { Sized }
}

implementation {
	namespace IntegerSized for Integer is Sized {
		size() -> Integer {
			<- @
		}
	}

	namespace ListSized<infer Item> for List<Item>
		is Sized where Item is Sized
	{
		size() -> Integer {
			<- @::length()
		}
	}
}

export {
	IntegerSized
	ListSized
}
`,
			},
			async (directory) => {
				expect(
					await runBundle(
						generateModules(linkProject(directory, "Entry.es")),
						directory,
					),
				).toEqual(["5"])
			},
		)
	})

	// `IntegerSized` is what meets `measure`'s bound, and `Main.es`'s own
	// `Sized` is no concern of it.
	it("calls a Function whose bound another Protocol of its name does not meet", async () => {
		await withBuiltProject(
			{
				"Main.es": `import {
	from "./Sized.es" {
		IntegerSized
		measure
	}
}

implementation {
	protocol Sized {
		count() -> Integer
	}

	namespace IntegerCounted for Integer is Sized {
		count() -> Integer {
			<- 100
		}
	}

	Terminal.inspect(measure(3))
	Terminal.inspect(3::count())
}
`,
				"Sized.es": sizedModule,
			},
			async (directory) => {
				expect(
					await runBundle(
						generateModules(linkProject(directory, "Main.es")),
						directory,
					),
				).toEqual(["3", "100"])
			},
		)
	})

	it("calls a Function bounded by a Protocol whose name another Module reuses", async () => {
		await withBuiltProject(
			{
				"Main.es": `import {
	from "./Other.es" { weigh }
	from "./Sized.es" {
		IntegerSized
		measure
	}
}

implementation {
	Terminal.inspect(measure(weigh()))
}
`,
				"Other.es": `implementation {
	protocol Sized {
		weight() -> Integer
	}

	function weigh() -> Integer {
		<- 3
	}
}

export {
	weigh
}
`,
				"Sized.es": sizedModule.replace("\tSized\n", ""),
			},
			async (directory) => {
				expect(
					await runBundle(
						generateModules(linkProject(directory, "Main.es")),
						directory,
					),
				).toEqual(["3"])
			},
		)
	})

	// `Main.es` and `Sized.es` import each other, which is what the one
	// Warning says; the bound needs nothing more.
	it("calls a Function bounded by a cycle partner's Protocol", async () => {
		await withBuiltProject(
			{
				"Main.es": `import {
	from "./Sized.es" {
		IntegerSized
		measure
	}
}

implementation {
	Terminal.inspect(run())

	function run() -> Integer {
		<- measure(3)
	}

	function base() -> Integer {
		<- 10
	}
}

export {
	base
	run
}
`,
				"Sized.es": `import {
	from "./Main.es" { base }
}

implementation {
	protocol Sized {
		size() -> Integer
	}

	namespace IntegerSized for Integer is Sized {
		size() -> Integer {
			<- @::add(base())
		}
	}

	function measure <infer Item is Sized>(_ item: Item) -> Integer {
		<- item::size()
	}
}

export {
	IntegerSized
	Sized
	measure
}
`,
			},
			async (directory) => {
				let linked = linkProject(directory, "Main.es")

				expect(
					codesOf(linkedAt(directory, linked, "Main.es").diagnostics),
				).toEqual(["cyclic-side-effects"])
				expect(
					codesOf(
						linkedAt(directory, linked, "Sized.es").diagnostics,
					),
				).toEqual([])
				expect(
					await runBundle(
						rewriteModules(
							[...linked.modules.values()].map((module) => ({
								filePath: module.module.filePath,
								program: optimise(simplify(module.program)),
							})),
							linked.entryPath,
						),
						directory,
					),
				).toEqual(["13"])
			},
		)
	})

	// `Item` carries the `Sized` that `SizedBox` demands, private to
	// `Box.es`, and `weigh` wants a `Weighed`. The one-bound rule is what is
	// left to say, and `Other.es`'s `Sized` has no part in it.
	it("reports a bound a Type Parameter carrying a private bound can not meet", () => {
		withProject(
			{
				"Main.es": `import {
	from "./Box.es" { SizedBox }
	from "./Other.es" { one }
	from "./Weighed.es" { weigh }
}

implementation {
	namespace Boxes<infer Item> for SizedBox<Item> {
		weighed() -> Integer {
			<- match @ -> Integer {
				case #Box({ item }) { <- weigh(item) }
			}
		}
	}

	Terminal.inspect(one())
}
`,
				"Box.es": `implementation {
	protocol Sized {
		size() -> Integer
	}

	choice SizedBox<Item is Sized> {
		Box { item: Item },
	}
}

export {
	SizedBox
}
`,
				"Other.es": `implementation {
	protocol Sized {
		other() -> Integer
	}

	function one() -> Integer {
		<- 1
	}
}

export {
	one
}
`,
				"Weighed.es": `implementation {
	protocol Weighed {
		weight() -> Integer
	}

	namespace IntegerWeighed for Integer is Weighed {
		weight() -> Integer {
			<- @
		}
	}

	function weigh <infer T is Weighed>(_ t: T) -> Integer {
		<- t::weight()
	}
}

export {
	IntegerWeighed
	Weighed
	weigh
}
`,
			},
			(directory) => {
				let main = analysedAt(directory, "Main.es", "Main.es")

				expect(reportsOf(main)).toEqual([
					[
						"unsatisfied-bound",
						"Type Parameter 'Item' does not conform to 'Weighed'",
					],
				])
				expect(main[0]?.position?.start.line).toBe(11)
				expect(main[0]?.labels.map((label) => label.message)).toEqual([
					"bound here to a Type Parameter bounded by 'Sized'",
				])
				expect(JSON.stringify(main)).not.toContain("Other.es")
				expect(main[0]?.helps).toEqual([])
			},
		)
	})

	it("refuses a condition no Namespace in the caller's Scope meets", () => {
		withProject(
			{
				"Main.es": `import {
	from "./Sized.es" {
		ListSized
		measure
	}
}

implementation {
	Terminal.inspect(measure([1, 2]))
}
`,
				"Sized.es": `implementation {
	protocol Weighed {
		weight() -> Integer
	}

	protocol Sized {
		size() -> Integer
	}

	namespace IntegerWeighed for Integer is Weighed {
		weight() -> Integer {
			<- @
		}
	}

	namespace ListSized<infer ItemType> for List<ItemType>
		is Sized where ItemType is Weighed
	{
		size() -> Integer {
			<- 2
		}
	}

	function measure <infer Item is Sized>(_ item: Item) -> Integer {
		<- item::size()
	}
}

export {
	IntegerWeighed
	ListSized
	measure
}
`,
			},
			(directory) => {
				let refusal = analysedAt(directory, "Main.es", "Main.es").find(
					(diagnostic) =>
						diagnostic.code === "unsatisfied-conformance-condition",
				)

				expect(refusal?.message).toBe(
					"List<Integer> does not conform to 'Sized'",
				)
				expect(refusal?.position?.start.line).toBe(9)
				expect(refusal?.notes).toEqual([
					"Integer does not conform to 'Weighed'.",
				])
				expect(refusal?.helps).toEqual([
					"'IntegerWeighed' in ./Sized.es makes Integer conform to 'Weighed' — import it.",
				])
				expect(refusal?.data).toEqual({
					kind: "import-declaration",
					name: "IntegerWeighed",
					modulePath: path.join(directory, "Sized.es"),
				})
			},
		)
	})

	it("keeps a nested Protocol apart from a standard library one of its name", async () => {
		await withBuiltProject(
			{
				"Main.es": `implementation {
	function inner() -> Integer {
		protocol Printable {
			count() -> Integer
		}

		namespace IntegerCounted for Integer is Printable {
			count() -> Integer {
				<- 100
			}
		}

		Terminal.print(3)

		<- 3::count()
	}

	Terminal.inspect(inner())
}
`,
			},
			async (directory) => {
				expect(
					await runBundle(
						generateModules(linkProject(directory, "Main.es")),
						directory,
					),
				).toEqual(["3", "100"])
			},
		)
	})

	// The witness `Main.es` hands `big` carries `isBig`, which `Sized`
	// provides, although `Main.es` has no name for `Sized`.
	it("hands a witness the provided Methods of a Protocol the caller never imports", async () => {
		await withBuiltProject(
			{
				"Main.es": `import {
	from "./Sized.es" {
		IntegerSized
		big
	}
}

implementation {
	Terminal.inspect(big(3))
}
`,
				"Sized.es": `implementation {
	protocol Sized {
		size() -> Integer

		isBig() -> Boolean {
			<- @::size()::isGreaterThan(2)
		}
	}

	namespace IntegerSized for Integer is Sized {
		size() -> Integer {
			<- @
		}
	}

	function big <infer Item is Sized>(_ item: Item) -> Boolean {
		<- item::isBig()
	}
}

export {
	IntegerSized
	Sized
	big
}
`,
			},
			async (directory) => {
				expect(
					await runBundle(
						generateModules(linkProject(directory, "Main.es")),
						directory,
					),
				).toEqual(["true"])
			},
		)
	})

	it("reports a Protocol imported only for a bound as unused", () => {
		withProject(
			{
				"Main.es": `import {
	from "./Sized.es" {
		IntegerSized
		Sized
		measure
	}
}

implementation {
	Terminal.inspect(measure(3))
}
`,
				"Sized.es": sizedModule,
			},
			(directory) => {
				expect(
					reportsOf(analysedAt(directory, "Main.es", "Main.es")),
				).toEqual([
					["unused-import", "'Sized' is imported and never used"],
				])
			},
		)
	})

	// `Item` is bounded by the `Sized` this file declares, which asks
	// for what the other one asks for and is still another Protocol.
	it("tells a Type Parameter's bound from another Protocol of its name", () => {
		withProject(
			{
				"Main.es": `import {
	from "./Sized.es" { measure }
}

implementation {
	protocol Sized {
		size() -> Integer
	}

	function relay <infer Item is Sized>(_ item: Item) -> Integer {
		<- measure(item)
	}
}

export {
	relay
}
`,
				"Sized.es": sizedModule,
			},
			(directory) => {
				let refusal = analysedAt(directory, "Main.es", "Main.es").find(
					(diagnostic) => diagnostic.code === "unsatisfied-bound",
				)

				expect(refusal?.message).toBe(
					"Type Parameter 'Item' does not conform to 'Sized'",
				)
				expect(refusal?.labels.map((label) => label.message)).toEqual([
					"bound here to a Type Parameter bounded by 'Sized'",
				])
				expect(refusal?.notes).toEqual([
					"'Sized' here is the Protocol this file declares; the bound asks for the 'Sized' that Sized.es declares.",
					"'Item' is bounded by 'Sized' already, and a Type Parameter carries ONE bound — a second would replace it rather than stand beside it.",
					"A Protocol that extends both is how a Parameter asks for two, and only Types this Program can declare that conformance for can satisfy it.",
				])
			},
		)
	})

	// `Sized` here is the file's own Type, so no bound written here can
	// name the Protocol `measure` asks for.
	it("tells a bound's Protocol from a Type of its name", () => {
		withProject(
			{
				"Main.es": `import {
	from "./Sized.es" { measure }
}

implementation {
	type Sized = { count: Integer }

	function relay <infer Item>(_ item: Item) -> Integer {
		<- measure(item)
	}

	Terminal.inspect(measure("abc"))
}

export {
	relay
	Sized
}
`,
				"Sized.es": sizedModule,
			},
			(directory) => {
				let refusals = analysedAt(
					directory,
					"Main.es",
					"Main.es",
				).filter(
					(diagnostic) => diagnostic.code === "unsatisfied-bound",
				)

				expect(refusals.map((refusal) => refusal.notes)).toEqual([
					[
						"'Item' carries no 'Sized' bound of its own, so it can not satisfy one.",
						"'Sized' here is a Type; the bound asks for the Protocol 'Sized' that Sized.es declares.",
					],
					[
						"No Namespace in scope makes String conform to 'Sized'.",
						"'Sized' here is a Type; the bound asks for the Protocol 'Sized' that Sized.es declares.",
					],
				])
			},
		)
	})

	it("tells a bound's Protocol from a Function of its name", () => {
		withProject(
			{
				"Main.es": `import {
	from "./Sized.es" { measure }
}

implementation {
	function Sized() -> Integer {
		<- 1
	}

	Terminal.inspect(measure("abc"))
}
`,
				"Sized.es": sizedModule,
			},
			(directory) => {
				let refusal = analysedAt(directory, "Main.es", "Main.es").find(
					(diagnostic) => diagnostic.code === "unsatisfied-bound",
				)

				expect(refusal?.notes).toEqual([
					"No Namespace in scope makes String conform to 'Sized'.",
					"'Sized' here is a Function; the bound asks for the Protocol 'Sized' that Sized.es declares.",
				])
			},
		)
	})

	// Both Modules are called `Sized.es`, so each is named by the
	// specifier this file would import it by.
	it("tells two Protocols apart whose Modules share a file name", () => {
		withProject(
			{
				"Main.es": `import {
	from "./Sized.es" { measure }
	from "./other/Sized.es" {
		IntegerCounted
		Sized
	}
}

implementation {
	Terminal.inspect(measure(3))
}
`,
				"Sized.es": sizedModule,
				"other/Sized.es": countedModule,
			},
			(directory) => {
				let refusal = analysedAt(directory, "Main.es", "Main.es").find(
					(diagnostic) => diagnostic.code === "unsatisfied-bound",
				)

				expect(refusal?.notes).toEqual([
					"No Namespace in scope makes Integer conform to 'Sized'.",
					"'Sized' here is the Protocol ./other/Sized.es declares; the bound asks for the 'Sized' that ./Sized.es declares.",
					"'IntegerCounted' conforms to the 'Sized' ./other/Sized.es declares, which is a different Protocol.",
				])
			},
		)
	})

	// The Type Parameter can take the Protocol as its bound, which is what
	// the Help writes, so no Note tells the two apart.
	it("leaves a Type Parameter of the bound's name unsaid", () => {
		withProject(
			{
				"Main.es": `import {
	from "./Sized.es" { measure }
}

implementation {
	function relay <infer Sized>(_ item: Sized) -> Integer {
		<- measure(item)
	}
}

export {
	relay
}
`,
				"Sized.es": sizedModule,
			},
			(directory) => {
				let refusal = analysedAt(directory, "Main.es", "Main.es").find(
					(diagnostic) => diagnostic.code === "unsatisfied-bound",
				)

				expect(refusal?.notes).toEqual([
					"'Sized' carries no 'Sized' bound of its own, so it can not satisfy one.",
				])
				expect(refusal?.helps[0]).toBe(
					"Declare it as '<infer Sized is Sized>'.",
				)
			},
		)
	})

	// The report spells the bound's Protocol by the alias. The file's own `Sized`
	// is no reading of it, but its conformer is still named.
	it("leaves a namesake unsaid where the report spells the bound by an alias", () => {
		withProject(
			{
				"Main.es": `import {
	from "./Sized.es" {
		Sized as Measurable
		measure
	}
}

implementation {
	protocol Sized {
		count() -> Integer
	}

	namespace IntegerCounted for Integer is Sized {
		count() -> Integer {
			<- 100
		}
	}

	Terminal.inspect(measure(3))
}
`,
				"Sized.es": sizedModule,
			},
			(directory) => {
				let refusal = analysedAt(directory, "Main.es", "Main.es").find(
					(diagnostic) => diagnostic.code === "unsatisfied-bound",
				)

				expect(refusal?.message).toBe(
					"Integer does not conform to 'Measurable'",
				)
				expect(refusal?.notes).toEqual([
					"No Namespace in scope makes Integer conform to 'Measurable'.",
					"'IntegerCounted' conforms to the 'Sized' this file declares, which is a different Protocol.",
				])
			},
		)
	})

	it("says a condition asks for a Protocol another in scope shares a name with", () => {
		withProject(
			{
				"Main.es": `import {
	from "./Sized.es" {
		ListSized
		measure
	}
}

implementation {
	protocol Weighed {
		heft() -> Integer
	}

	namespace IntegerHefty for Integer is Weighed {
		heft() -> Integer {
			<- 1
		}
	}

	Terminal.inspect(measure([1, 2]))
}
`,
				"Sized.es": `implementation {
	protocol Weighed {
		weight() -> Integer
	}

	protocol Sized {
		size() -> Integer
	}

	namespace ListSized<infer ItemType> for List<ItemType>
		is Sized where ItemType is Weighed
	{
		size() -> Integer {
			<- 2
		}
	}

	function measure <infer Item is Sized>(_ item: Item) -> Integer {
		<- item::size()
	}
}

export {
	ListSized
	measure
}
`,
			},
			(directory) => {
				let refusal = analysedAt(directory, "Main.es", "Main.es").find(
					(diagnostic) =>
						diagnostic.code === "unsatisfied-conformance-condition",
				)

				expect(refusal?.notes).toEqual([
					"Integer does not conform to 'Weighed'.",
					"'Weighed' here is the Protocol this file declares; the condition asks for the 'Weighed' that Sized.es declares.",
					"'IntegerHefty' conforms to the 'Weighed' this file declares, which is a different Protocol.",
				])
			},
		)
	})

	// `Main.es` binds no name for `Sized`, so the bound can be written
	// only beside an import of it, and the fix carries that import.
	it("carries the import a Type Parameter's bound needs", () => {
		withProject(
			{
				"Main.es": `import {
	from "./Sized.es" { measure }
}

implementation {
	function relay <infer Item>(_ item: Item) -> Integer {
		<- measure(item)
	}
}

export {
	relay
}
`,
				"Sized.es": sizedModule,
			},
			(directory) => {
				let refusal = analysedAt(directory, "Main.es", "Main.es").find(
					(diagnostic) => diagnostic.code === "unsatisfied-bound",
				)

				expect(refusal?.helps).toEqual([
					"Declare it as '<infer Item is Sized>'.",
					"'Sized' is declared in Sized.es — import it here.",
				])
				expect(refusal?.data).toEqual({
					kind: "required-protocol",
					protocol: "Sized",
					parameter: "Item",
					import: {
						name: "Sized",
						modulePath: path.join(directory, "Sized.es"),
					},
				})
			},
		)
	})

	it("asks for the export of a bound's Protocol its Module keeps private", () => {
		withProject(
			{
				"Main.es": `import {
	from "./Sized.es" { measure }
}

implementation {
	function relay <infer Item>(_ item: Item) -> Integer {
		<- measure(item)
	}
}

export {
	relay
}
`,
				"Sized.es": sizedModule.replace("\tSized\n", ""),
			},
			(directory) => {
				let refusal = analysedAt(directory, "Main.es", "Main.es").find(
					(diagnostic) => diagnostic.code === "unsatisfied-bound",
				)

				expect(refusal?.helps).toEqual([
					"Declare it as '<infer Item is Sized>'.",
					"'Sized' is declared in Sized.es, which does not export it — export it there and import it here.",
				])
				expect(refusal?.data).toBeUndefined()
			},
		)
	})

	// `Sized.es` publishes `Sized` as `Measurable`, which is the name an
	// import of it writes and so the name the bound is written with.
	it("writes a bound by the name its Protocol is exported under", async () => {
		let main = (entries: string, bound: string) => `import {
	from "./Sized.es" {
		${entries}
	}
}

implementation {
	function relay <infer Item${bound}>(_ item: Item) -> Integer {
		<- measure(item)
	}

	Terminal.inspect(relay(3))
}
`
		let sized = sizedModule.replace("\tSized\n", "\tSized as Measurable\n")

		withProject(
			{
				"Main.es": main("IntegerSized\n\t\tmeasure", ""),
				"Sized.es": sized,
			},
			(directory) => {
				let refusal = analysedAt(directory, "Main.es", "Main.es").find(
					(diagnostic) => diagnostic.code === "unsatisfied-bound",
				)

				expect(refusal?.helps).toEqual([
					"Declare it as '<infer Item is Measurable>'.",
					"'Sized' is declared in Sized.es, which exports it as 'Measurable' — import 'Measurable' here.",
				])
				expect(refusal?.data).toEqual({
					kind: "required-protocol",
					protocol: "Measurable",
					parameter: "Item",
					import: {
						name: "Measurable",
						modulePath: path.join(directory, "Sized.es"),
					},
				})
			},
		)

		withProject(
			{
				"Main.es": main("IntegerSized\n\t\tmeasure", " is Sized"),
				"Sized.es": sized,
			},
			(directory) => {
				let refusal = analysedAt(directory, "Main.es", "Main.es").find(
					(diagnostic) => diagnostic.code === "unknown-protocol",
				)

				expect(refusal?.helps).toEqual([
					"'Sized' is declared in Sized.es, which exports it as 'Measurable' — import 'Measurable' and write that name here.",
				])
			},
		)

		withProject(
			{
				"Main.es": main("IntegerSized\n\t\tmeasure", " is Measurable"),
				"Sized.es": sized,
			},
			(directory) => {
				let refusal = analysedAt(directory, "Main.es", "Main.es").find(
					(diagnostic) => diagnostic.code === "unknown-protocol",
				)

				expect(refusal?.helps).toEqual([
					"'Measurable' is exported by Sized.es — import it here.",
				])
			},
		)

		await withBuiltProject(
			{
				"Main.es": main(
					"IntegerSized\n\t\tMeasurable\n\t\tmeasure",
					" is Measurable",
				),
				"Sized.es": sized,
			},
			async (directory) => {
				expect(
					await runBundle(
						generateModules(linkProject(directory, "Main.es")),
						directory,
					),
				).toEqual(["3"])
			},
		)
	})

	// `Other.es` declares its Protocol at the Position `Sized.es` declares
	// its own at, and `Sized.es` forwards `Other` while keeping `Sized` private.
	it("does not take a forwarded Protocol for a private one declared at its Position", () => {
		withProject(
			{
				"Main.es": `import {
	from "./Sized.es" {
		IntegerSized
		measure
	}
}

implementation {
	function relay <infer Item>(_ item: Item) -> Integer {
		<- measure(item)
	}

	Terminal.inspect(relay(3))
}
`,
				"Other.es": `implementation {
	protocol Other {
		weight() -> Integer
	}
}

export {
	Other
}
`,
				"Sized.es": sizedModule.replace(
					"\tSized\n",
					'\tfrom "./Other.es" { Other }\n',
				),
			},
			(directory) => {
				let refusal = analysedAt(directory, "Main.es", "Main.es").find(
					(diagnostic) => diagnostic.code === "unsatisfied-bound",
				)

				expect(refusal?.helps).toEqual([
					"Declare it as '<infer Item is Sized>'.",
					"'Sized' is declared in Sized.es, which does not export it — export it there and import it here.",
				])
				expect(refusal?.data).toBeUndefined()
			},
		)
	})

	it("asks for a Namespace by the name its Protocol is exported under", async () => {
		let sized = sizedModule
			.replace(
				`
	namespace IntegerSized for Integer is Sized {
		size() -> Integer {
			<- @
		}
	}
`,
				"",
			)
			.replace("\tIntegerSized\n", "")
			.replace("\tSized\n", "\tSized as Measurable\n")

		withProject(
			{
				"Main.es": `import {
	from "./Sized.es" { measure }
}

implementation {
	Terminal.inspect(measure(3))
}
`,
				"Sized.es": sized,
			},
			(directory) => {
				let refusal = analysedAt(directory, "Main.es", "Main.es").find(
					(diagnostic) => diagnostic.code === "unsatisfied-bound",
				)

				expect(refusal?.helps).toEqual([
					"Declare a Namespace 'for Integer is Measurable'.",
					"'Sized' is declared in Sized.es, which exports it as 'Measurable' — import 'Measurable' here.",
				])
				expect(refusal?.data).toEqual({
					kind: "required-protocol",
					protocol: "Measurable",
					parameter: null,
					import: {
						name: "Measurable",
						modulePath: path.join(directory, "Sized.es"),
					},
				})
			},
		)

		await withBuiltProject(
			{
				"Main.es": `import {
	from "./Sized.es" {
		Measurable
		measure
	}
}

implementation {
	namespace IntegerMeasurable for Integer is Measurable {
		size() -> Integer {
			<- @
		}
	}

	Terminal.inspect(measure(3))
}
`,
				"Sized.es": sized,
			},
			async (directory) => {
				expect(
					await runBundle(
						generateModules(linkProject(directory, "Main.es")),
						directory,
					),
				).toEqual(["3"])
			},
		)
	})

	// The file's own `Sized` takes the name, so the other one can be
	// named here only under an alias, which no fix chooses.
	it("asks for an aliased import where another Protocol takes its name", () => {
		withProject(
			{
				"Main.es": `import {
	from "./Sized.es" { measure }
}

implementation {
	protocol Sized {
		count() -> Integer
	}

	function relay <infer Item>(_ item: Item) -> Integer {
		<- measure(item)
	}
}

export {
	relay
}
`,
				"Sized.es": sizedModule,
			},
			(directory) => {
				let refusal = analysedAt(directory, "Main.es", "Main.es").find(
					(diagnostic) => diagnostic.code === "unsatisfied-bound",
				)

				expect(refusal?.helps).toEqual([
					"'Sized' is declared in Sized.es — import it under a name of its own, 'Sized as …', and bound 'Item' by that name, since this file binds 'Sized' already.",
				])
				expect(refusal?.data).toBeUndefined()
			},
		)
	})

	// The file's `type Sized` takes the name an import would bind, so a
	// bound or a Namespace can name the Protocol only under an alias.
	it("asks for an aliased import where a Type of the file takes a Protocol's name", () => {
		withProject(
			{
				"Main.es": `import {
	from "./Sized.es" { measure }
}

implementation {
	type Sized = { count: Integer }

	function relay <infer Item>(_ item: Item) -> Integer {
		<- measure(item)
	}

	Terminal.inspect(measure("abc"))
}

export {
	relay
	Sized
}
`,
				"Sized.es": sizedModule,
			},
			(directory) => {
				expect(
					analysedAt(directory, "Main.es", "Main.es")
						.filter(
							(diagnostic) =>
								diagnostic.code === "unsatisfied-bound",
						)
						.map((diagnostic) => [
							diagnostic.message,
							diagnostic.helps,
							diagnostic.data,
						]),
				).toEqual([
					[
						"Type Parameter 'Item' does not conform to 'Sized'",
						[
							"'Sized' is declared in Sized.es — import it under a name of its own, 'Sized as …', and bound 'Item' by that name, since this file binds 'Sized' already.",
						],
						undefined,
					],
					[
						"String does not conform to 'Sized'",
						[
							"'Sized' is declared in Sized.es — import it under a name of its own, 'Sized as …', and write that name in a Namespace 'for String is …', since this file binds 'Sized' already.",
						],
						undefined,
					],
				])
			},
		)
	})

	it("asks for the export of a private Protocol whose name a Function takes", () => {
		withProject(
			{
				"Main.es": `import {
	from "./Sized.es" { measure }
}

implementation {
	function Sized() -> Integer {
		<- 1
	}

	function relay <infer Item>(_ item: Item) -> Integer {
		<- measure(item)
	}
}

export {
	relay
}
`,
				"Sized.es": sizedModule.replace("\tSized\n", ""),
			},
			(directory) => {
				let refusal = analysedAt(directory, "Main.es", "Main.es").find(
					(diagnostic) => diagnostic.code === "unsatisfied-bound",
				)

				expect(refusal?.helps).toEqual([
					"'Sized' is declared in Sized.es, which does not export it — export it there and import it under a name of its own, 'Sized as …', and bound 'Item' by that name, since this file binds 'Sized' already.",
				])
				expect(refusal?.data).toBeUndefined()
			},
		)
	})

	it("asks for a condition's Protocol under a name of its own where the file takes it", () => {
		withProject(
			{
				"Main.es": `import {
	from "./Sized.es" {
		ListSized
		measure
	}
}

implementation {
	type Weighed = { heft: Integer }

	Terminal.inspect(measure([1, 2]))
}

export {
	Weighed
}
`,
				"Sized.es": `implementation {
	protocol Weighed {
		weight() -> Integer
	}

	protocol Sized {
		size() -> Integer
	}

	namespace ListSized<infer ItemType> for List<ItemType>
		is Sized where ItemType is Weighed
	{
		size() -> Integer {
			<- 2
		}
	}

	function measure <infer Item is Sized>(_ item: Item) -> Integer {
		<- item::size()
	}
}

export {
	ListSized
	Weighed
	measure
}
`,
			},
			(directory) => {
				let refusal = analysedAt(directory, "Main.es", "Main.es").find(
					(diagnostic) =>
						diagnostic.code === "unsatisfied-conformance-condition",
				)

				expect(refusal?.helps).toEqual([
					"'Weighed' is declared in Sized.es — import it under a name of its own, 'Weighed as …', and write that name in a Namespace 'for Integer is …', since this file binds 'Weighed' already.",
				])
				expect(refusal?.data).toBeUndefined()
			},
		)
	})

	it("asks for a Namespace and the import of a Protocol the file can not name", () => {
		withProject(
			{
				"Main.es": `import {
	from "./Sized.es" { measure }
}

implementation {
	Terminal.inspect(measure(3))
}
`,
				"Sized.es": sizedModule
					.replace(
						`
	namespace IntegerSized for Integer is Sized {
		size() -> Integer {
			<- @
		}
	}
`,
						"",
					)
					.replace("\tIntegerSized\n", ""),
			},
			(directory) => {
				let refusal = analysedAt(directory, "Main.es", "Main.es").find(
					(diagnostic) => diagnostic.code === "unsatisfied-bound",
				)

				expect(refusal?.helps).toEqual([
					"Declare a Namespace 'for Integer is Sized'.",
					"'Sized' is declared in Sized.es — import it here.",
				])
				expect(refusal?.data).toEqual({
					kind: "required-protocol",
					protocol: "Sized",
					parameter: null,
					import: {
						name: "Sized",
						modulePath: path.join(directory, "Sized.es"),
					},
				})
			},
		)
	})

	it("names a Protocol as the calling file spells it", () => {
		withProject(
			{
				"Main.es": `import {
	from "./Sized.es" {
		Sized as Measurable
		measure
	}
}

implementation {
	Terminal.inspect(measure("text"))
}
`,
				"Sized.es": sizedModule,
			},
			(directory) => {
				let refusal = analysedAt(directory, "Main.es", "Main.es").find(
					(diagnostic) => diagnostic.code === "unsatisfied-bound",
				)

				expect(refusal?.message).toBe(
					"String does not conform to 'Measurable'",
				)
				expect(refusal?.data).toEqual({
					kind: "required-protocol",
					protocol: "Measurable",
					parameter: null,
				})
			},
		)
	})
	const providingModule = `implementation {
	protocol Sized {
		size() -> Integer

		isBig() -> Boolean {
			<- @::size()::isGreaterThan(2)
		}
	}

	namespace IntegerSized for Integer is Sized {
		size() -> Integer {
			<- @
		}
	}
}

export {
	IntegerSized
	Sized
}
`

	it("writes the bound an undispatchable call needs as the file names it", () => {
		withProject(
			{
				"Main.es": `import {
	from "./Sized.es" {
		IntegerSized
		Sized as Measurable
	}
}

implementation {
	function pick <infer A is Measurable, infer B is Measurable>(_ value: A | B) -> Integer {
		<- value::size()
	}

	Terminal.inspect(pick(3))
}
`,
				"Sized.es": providingModule,
			},
			(directory) => {
				let refusal = analysedAt(directory, "Main.es", "Main.es").find(
					(diagnostic) => diagnostic.code === "undispatchable-method",
				)

				expect(refusal?.helps).toEqual([
					"Take one Type Parameter in place of the Union — '<infer Item is Measurable>(_ value: Item)' — since Types erase before a Match runs, and a Match is the only thing that narrows.",
				])
			},
		)
	})

	it("writes the bound an erased Case asks for as the file names it", () => {
		withProject(
			{
				"Main.es": `import {
	from "./Sized.es" {
		IntegerSized
		Sized as Measurable
	}
}

implementation {
	function pick <infer A is Measurable, infer B is Measurable>(_ value: A | B) -> Integer {
		<- match value -> Integer {
			case A { <- 1 }
			case B { <- 2 }
		}
	}

	Terminal.inspect(pick(3))
}
`,
				"Sized.es": providingModule,
			},
			(directory) => {
				let refusal = analysedAt(directory, "Main.es", "Main.es").find(
					(diagnostic) => diagnostic.code === "erased-case-conflict",
				)

				expect(refusal?.helps).toEqual([
					"Take one Type Parameter in place of the Union — '<infer Item is Measurable>(_ value: Item)' — since Types erase before a Match runs, and a Match is the only thing that narrows.",
				])
			},
		)
	})

	it("writes the bound an erased Case asks for on a Namespace's Method as the file names it", () => {
		withProject(
			{
				"Main.es": `import {
	from "./Sized.es" {
		IntegerSized
		Sized as Measurable
	}
}

implementation {
	type Pair<A, B> = { first: A, second: B }

	namespace Pairs<infer A, infer B> for Pair<A, B> {
		pick<A is Measurable, B is Measurable>(_ value: A | B) -> Integer {
			<- match value -> Integer {
				case A { <- 1 }
				case B { <- 2 }
			}
		}
	}
}
`,
				"Sized.es": providingModule,
			},
			(directory) => {
				let refusal = analysedAt(directory, "Main.es", "Main.es").find(
					(diagnostic) => diagnostic.code === "erased-case-conflict",
				)

				expect(refusal?.helps).toEqual([
					"Take one Type Parameter in place of the Union — '<infer Item is Measurable>(_ value: Item)' — since Types erase before a Match runs, and a Match is the only thing that narrows.",
				])
			},
		)
	})

	it("asks for an aliased import of a Protocol whose name the file has taken", async () => {
		let main = (entries: string) => `import {
	from "./Sized.es" {
		${entries}
	}
}

implementation {
	protocol Sized {
		count() -> Integer
	}

	Terminal.inspect(3::isBig())
}
`

		withProject(
			{ "Main.es": main("IntegerSized"), "Sized.es": providingModule },
			(directory) => {
				let refusal = analysedAt(directory, "Main.es", "Main.es").find(
					(diagnostic) => diagnostic.code === "unknown-method",
				)

				expect(refusal?.helps).toEqual([
					"Import 'Sized' from ./Sized.es under a name of its own, 'Sized as …' — this value conforms to it, and the 'Sized' named here is a different Protocol.",
				])
			},
		)

		await withBuiltProject(
			{
				"Main.es": main("IntegerSized\n\t\tSized as Measured"),
				"Sized.es": providingModule,
			},
			async (directory) => {
				expect(
					await runBundle(
						generateModules(linkProject(directory, "Main.es")),
						directory,
					),
				).toEqual(["true"])
			},
		)
	})

	it("asks for an aliased import of a Protocol whose name a Type here takes", () => {
		withProject(
			{
				"Main.es": `import {
	from "./Sized.es" { IntegerSized }
}

implementation {
	type Sized = { count: Integer }

	Terminal.inspect(3::isBig())
}
`,
				"Sized.es": providingModule,
			},
			(directory) => {
				let refusal = analysedAt(directory, "Main.es", "Main.es").find(
					(diagnostic) => diagnostic.code === "unknown-method",
				)

				expect(refusal?.helps).toEqual([
					"Import 'Sized' from ./Sized.es under a name of its own, 'Sized as …' — this value conforms to it, and this file binds 'Sized' already.",
				])
			},
		)
	})

	// Whether the import needs a name of its own is asked of the name it binds,
	// `Measurable`. A Type here may take the declared name without colliding.
	it("asks for the import of a provided Method's Protocol by the name it is exported under", async () => {
		let main = (entries: string, declared: string) => `import {
	from "./Sized.es" {
		${entries}
	}
}

implementation {${declared}
	Terminal.inspect(3::isBig())
}
`
		let sized = providingModule.replace(
			"\tSized\n",
			"\tSized as Measurable\n",
		)
		let helpsFor = (declared: string) =>
			withProject(
				{
					"Main.es": main("IntegerSized", declared),
					"Sized.es": sized,
				},
				(directory) =>
					analysedAt(directory, "Main.es", "Main.es").find(
						(diagnostic) => diagnostic.code === "unknown-method",
					)?.helps,
			)

		expect(helpsFor("")).toEqual([
			"Import 'Measurable' from ./Sized.es — this value conforms to it, and a Protocol's provided Methods are only reachable where the Protocol is.",
		])
		expect(helpsFor("\n\ttype Sized = { count: Integer }\n")).toEqual([
			"Import 'Measurable' from ./Sized.es — this value conforms to it, and a Protocol's provided Methods are only reachable where the Protocol is.",
		])
		expect(helpsFor("\n\ttype Measurable = { count: Integer }\n")).toEqual([
			"Import 'Measurable' from ./Sized.es under a name of its own, 'Measurable as …' — this value conforms to it, and this file binds 'Measurable' already.",
		])

		await withBuiltProject(
			{
				"Main.es": main(
					"IntegerSized\n\t\tMeasurable",
					"\n\ttype Sized = { count: Integer }\n",
				),
				"Sized.es": sized,
			},
			async (directory) => {
				expect(
					await runBundle(
						generateModules(linkProject(directory, "Main.es")),
						directory,
					),
				).toEqual(["true"])
			},
		)
	})

	// No import names a Protocol its Module keeps private, so the Help
	// asks for the export first.
	it("asks for the export of a provided Method's Protocol its Module keeps private", async () => {
		let main = (entries: string, declared: string) => `import {
	from "./Sized.es" {
		${entries}
	}
}

implementation {${declared}
	Terminal.inspect(3::isBig())
}
`
		let hidden = providingModule.replace("\tSized\n", "")

		withProject(
			{ "Main.es": main("IntegerSized", ""), "Sized.es": hidden },
			(directory) => {
				let refusal = analysedAt(directory, "Main.es", "Main.es").find(
					(diagnostic) => diagnostic.code === "unknown-method",
				)

				expect(refusal?.helps).toEqual([
					"'Sized' is declared in Sized.es, which does not export it — export it there and import it here, since this value conforms to it and a Protocol's provided Methods are only reachable where the Protocol is.",
				])
			},
		)

		// The Protocol `Sized.es` forwards is declared at the Position of
		// its own, and is a different one.
		withProject(
			{
				"Main.es": main("IntegerSized", ""),
				"Other.es": `implementation {
	protocol Other {
		weight() -> Integer
	}
}

export {
	Other
}
`,
				"Sized.es": providingModule.replace(
					"\tSized\n",
					'\tfrom "./Other.es" { Other }\n',
				),
			},
			(directory) => {
				let refusal = analysedAt(directory, "Main.es", "Main.es").find(
					(diagnostic) => diagnostic.code === "unknown-method",
				)

				expect(refusal?.helps).toEqual([
					"'Sized' is declared in Sized.es, which does not export it — export it there and import it here, since this value conforms to it and a Protocol's provided Methods are only reachable where the Protocol is.",
				])
			},
		)

		withProject(
			{
				"Main.es": main(
					"IntegerSized",
					"\n\ttype Sized = { count: Integer }\n",
				),
				"Sized.es": hidden,
			},
			(directory) => {
				let refusal = analysedAt(directory, "Main.es", "Main.es").find(
					(diagnostic) => diagnostic.code === "unknown-method",
				)

				expect(refusal?.helps).toEqual([
					"'Sized' is declared in Sized.es, which does not export it — export it there and import it under a name of its own, 'Sized as …', since this value conforms to it and this file binds 'Sized' already.",
				])
			},
		)

		await withBuiltProject(
			{
				"Main.es": main("IntegerSized\n\t\tSized", ""),
				"Sized.es": providingModule,
			},
			async (directory) => {
				expect(
					await runBundle(
						generateModules(linkProject(directory, "Main.es")),
						directory,
					),
				).toEqual(["true"])
			},
		)
	})
})

describe("Names a report writes for the reader", () => {
	let boxModule = `implementation {
	choice Box<Value> { Full { value: Value }, Empty }

	namespace BoxShown<infer Item> for Box<Item> is Printable {
		toString() -> String { <- "box" }
	}
}

export {
	Box
	BoxShown
}
`

	// `Box` is imported, and its Cases carry payloads, so no import of it can
	// derive printing. The Namespace that declares it can.
	it("offers no import of a Choice the file imports already", () => {
		let main = (entries: string) => `import {
	from "./Box.es" {
		${entries}
	}
}

implementation {
	function boxed<infer Item>(_ b: Box<Item>) -> Integer {
		Terminal.print(b)
		<- 1
	}

	Terminal.inspect(boxed(Box<Integer>#Full(1)))
}
`

		withProject(
			{ "Main.es": main("Box"), "Box.es": boxModule },
			(directory) => {
				let refusal = analysedAt(directory, "Main.es", "Main.es").find(
					(diagnostic) => diagnostic.code === "unsatisfied-bound",
				)

				expect(refusal?.helps).toEqual([
					"Write 'Terminal.inspect(…)' instead — it renders any value structurally and asks for no conformance.",
					"'BoxShown' in ./Box.es makes Box<Item> conform to 'Printable' — import it.",
				])
			},
		)

		withProject(
			{ "Main.es": main("Box\n\t\tBoxShown"), "Box.es": boxModule },
			(directory) => {
				expect(
					codesOf(analysedAt(directory, "Main.es", "Main.es")),
				).toEqual([])
			},
		)
	})

	// Printing is derived only where a Namespace states it, so importing the
	// Choice is not enough. An import names what the Module exports.
	it("offers each import under its exported name, with what printing needs", () => {
		let colours = (exports: string) => `implementation {
	choice Colour { Red, Green }
	choice Box<Value> { Full { value: Value }, Empty }

	function pick() -> Colour {
		<- #Red
	}

	function boxed() -> Box<Integer> {
		<- #Full(1)
	}
}

export {
	${exports}
}
`
		let main = (entries: string, declared: string) => `import {
	from "./Colours.es" {
		${entries}
	}
}

implementation {${declared}
	function same<infer T is Equatable>(_ a: T, _ b: T) -> Boolean {
		<- a::is(b)
	}

	Terminal.print(pick())
	Terminal.inspect(same(pick(), pick()))
	Terminal.inspect(same(boxed(), boxed()))
}
`

		withProject(
			{
				"Main.es": main("boxed\n\t\tpick", ""),
				"Colours.es": colours("Colour as Hue\n\tboxed\n\tpick"),
			},
			(directory) => {
				expect(
					analysedAt(directory, "Main.es", "Main.es")
						.filter(
							(diagnostic) =>
								diagnostic.code === "unsatisfied-bound",
						)
						.map((diagnostic) => diagnostic.helps.at(-1)),
				).toEqual([
					"'Colour' is declared in Colours.es, which exports it as 'Hue' — import 'Hue' here, and declare a Namespace 'for Hue is Printable' — its body may be empty, since a Choice whose Cases carry no payload prints as their names.",
					"'Colour' is declared in Colours.es, which exports it as 'Hue' — import 'Hue' here, so its derived 'Equatable' is in scope.",
					"'Box' is declared in Colours.es, which does not export it — export it there and import it here, so its derived 'Equatable' is in scope.",
				])
			},
		)

		withProject(
			{
				"Main.es": main(
					"Box\n\t\tboxed\n\t\tHue\n\t\tpick",
					"\n\tnamespace HueShown for Hue is Printable {}\n",
				),
				"Colours.es": colours("Box\n\tColour as Hue\n\tboxed\n\tpick"),
			},
			(directory) => {
				expect(
					codesOf(analysedAt(directory, "Main.es", "Main.es")),
				).toEqual([])
			},
		)
	})

	// A Protocol no import derives still needs the Choice named, so the
	// Namespace Help leads with the import.
	it("leads a Namespace Help with the import a Choice needs", () => {
		let parcels = `implementation {
	choice Colour { Red, Green }
	choice Box<Value> { Full { value: Value }, Empty }

	function pick() -> Colour {
		<- #Red
	}

	function boxed() -> Box<Integer> {
		<- #Full(1)
	}
}

export {
	Box
	Colour
	boxed
	pick
}
`
		let main = (entries: string, declared: string) => `import {
	from "./Parcels.es" {
		${entries}
	}
}

implementation {${declared}
	function less<infer T is Comparable>(_ a: T, _ b: T) -> Boolean {
		<- a::isLessThan(b)
	}

	Terminal.print(boxed())
	Terminal.inspect(less(pick(), pick()))
}
`

		withProject(
			{ "Main.es": main("boxed\n\t\tpick", ""), "Parcels.es": parcels },
			(directory) => {
				expect(
					analysedAt(directory, "Main.es", "Main.es")
						.filter(
							(diagnostic) =>
								diagnostic.code === "unsatisfied-bound",
						)
						.map((diagnostic) => diagnostic.helps.at(-1)),
				).toEqual([
					"'Box' is declared in Parcels.es — import it here, and declare a Namespace 'for Box<Integer> is Printable'.",
					"'Colour' is declared in Parcels.es — import it here, and declare a Namespace 'for Colour is Comparable'.",
				])
			},
		)

		withProject(
			{
				"Main.es": main(
					"Box\n\t\tboxed\n\t\tColour\n\t\tpick",
					`
	namespace BoxShown for Box<Integer> is Printable {
		toString() -> String {
			<- "box"
		}
	}

	namespace ColourOrder for Colour is Comparable {
		compare(to other: Colour) -> Ordering {
			<- Ordering#Equal
		}
	}
`,
				),
				"Parcels.es": parcels,
			},
			(directory) => {
				expect(
					codesOf(analysedAt(directory, "Main.es", "Main.es")),
				).toEqual([])
			},
		)
	})

	// `for Box<Light>` names `Light` too, which `Main.es` binds no more than
	// `Box`, so the Help imports both.
	it("leads a Namespace Help with the import of every Choice its head names", () => {
		let printed = (entries: string, declared: string) =>
			withProject(
				{
					"Main.es": `import {
	from "./Lamps.es" {
		${entries}
	}
}

implementation {${declared}
	Terminal.print(make())
}
`,
					"Lamps.es": `implementation {
	choice Box<Value> { Full { value: Value }, Empty }
	choice Light { Red, Green }

	function make() -> Box<Light> {
		<- #Full(#Red)
	}
}

export {
	Box
	Light
	make
}
`,
				},
				(directory) => analysedAt(directory, "Main.es", "Main.es"),
			)
		let helpOf = (entries: string) =>
			printed(entries, "")
				.find((diagnostic) => diagnostic.code === "unsatisfied-bound")
				?.helps.at(-1)

		expect(helpOf("make")).toBe(
			"'Box' and 'Light' are declared in Lamps.es — import them here, and declare a Namespace 'for Box<Light> is Printable'.",
		)
		expect(helpOf("Box\n\t\tmake")).toBe(
			"'Light' is declared in Lamps.es — import it here, and declare a Namespace 'for Box<Light> is Printable'.",
		)
		expect(
			codesOf(
				printed(
					"Box\n\t\tLight\n\t\tmake",
					`
	namespace BoxShown for Box<Light> is Printable {
		toString() -> String {
			<- "box"
		}
	}
`,
				),
			),
		).toEqual([])
	})

	// Equality of a `Box<Light>` is derived through `Box` and through `Light`,
	// and each derive is found through a name for its Choice. Imported, both
	// derive it, and no Namespace is owed.
	it("imports every Choice a derived conformance is found through", () => {
		let compared = (entries: string, value: string) =>
			withProject(
				{
					"Main.es": `import {
	from "./Lamps.es" {
		${entries}
	}
}

implementation {
	function same<infer T is Equatable>(_ a: T, _ b: T) -> Boolean {
		<- a::is(b)
	}

	Terminal.inspect(same(${value}, ${value}))
}
`,
					"Lamps.es": `implementation {
	choice Box<Value> { Full { value: Value }, Empty }
	choice Light { Red, Green }

	function make() -> Box<Light> {
		<- #Full(#Red)
	}

	constant full = Box<Light>#Full(Light#Red)
}

export {
	Box
	full
	Light as Lamp
	make
}
`,
				},
				(directory) => analysedAt(directory, "Main.es", "Main.es"),
			)
		let helpsOf = (entries: string, value: string) =>
			compared(entries, value).map((diagnostic) => diagnostic.helps)

		expect(helpsOf("make", "make()")).toEqual([
			[
				"'Box' is declared in Lamps.es — import it here; 'Light' is declared in Lamps.es, which exports it as 'Lamp' — import 'Lamp' here, so their derived 'Equatable' is in scope.",
			],
		])
		expect(helpsOf("Box\n\t\tmake", "make()")).toEqual([
			[
				"'Light' is declared in Lamps.es, which exports it as 'Lamp' — import 'Lamp' here, so its derived 'Equatable' is in scope.",
			],
		])
		expect(helpsOf("full", "full")).toEqual(helpsOf("make", "make()"))
		expect(codesOf(compared("Box\n\t\tLamp\n\t\tmake", "make()"))).toEqual(
			[],
		)
		expect(codesOf(compared("Box\n\t\tfull\n\t\tLamp", "full"))).toEqual([])
	})

	// Imported, `Light` makes a `List<Light>` and a `{ l: Light }` equal by
	// what they hold. A Union of `Light` and an Integer, or a Function taking
	// a `Light`, still derives nothing, so the Help declares a Namespace too.
	it("imports a Choice alone only where the import brings the derive", () => {
		let compared = (entries: string, declared: string, value: string) =>
			withProject(
				{
					"Main.es": `import {
	from "./Lamps.es" {
		${entries}
	}
}

implementation {
	function same<infer T is Equatable>(_ a: T, _ b: T) -> Boolean {
		<- a::is(b)
	}
${declared}
	constant v = ${value}()
	Terminal.inspect(same(v, v))
}
`,
					"Lamps.es": `implementation {
	choice Light { Red, Green }

	function lights() -> List<Light> {
		<- [#Red]
	}

	function either() -> Light | Integer {
		<- 1
	}

	function callback() -> (_ l: Light) -> Integer {
		<- (_ l: Light) -> Integer { <- 1 }
	}
}

export {
	callback
	either
	Light
	lights
}
`,
				},
				(directory) => analysedAt(directory, "Main.es", "Main.es"),
			)
		let helpsOf = (value: string) =>
			compared(value, "", value).map((diagnostic) => diagnostic.helps)
		let equality = (target: string) => `
	namespace Equality for ${target} is Equatable {
		is(_ other: ${target}) -> Boolean {
			<- true
		}
	}
`

		expect(helpsOf("lights")).toEqual([
			[
				"'Light' is declared in Lamps.es — import it here, so its derived 'Equatable' is in scope.",
			],
		])
		expect(helpsOf("either")).toEqual([
			[
				"'Light' is declared in Lamps.es — import it here, and declare a Namespace 'for Light | Integer is Equatable'.",
			],
		])
		expect(helpsOf("callback")).toEqual([
			[
				"'Light' is declared in Lamps.es — import it here, and declare a Namespace 'for (_: Light) -> Integer is Equatable'.",
			],
		])
		expect(codesOf(compared("Light\n\t\tlights", "", "lights"))).toEqual([])
		expect(
			codesOf(
				compared(
					"either\n\t\tLight",
					equality("Light | Integer"),
					"either",
				),
			),
		).toEqual([])
		expect(
			codesOf(
				compared(
					"callback\n\t\tLight",
					equality("(_: Light) -> Integer"),
					"callback",
				),
			),
		).toEqual([])
	})

	// Asking whether importing `Light` brings the derive reaches `FnEq`. That
	// question is the Help's, not the file's, so `FnEq` stays unused until
	// the import is written.
	it("still warns about an import only a derive's question reaches", () => {
		let reports = (entries: string) =>
			withProject(
				{
					"Main.es": `import {
	from "./Lamps.es" {
		${entries}
	}
}

implementation {
	function same<infer T is Equatable>(_ a: T, _ b: T) -> Boolean {
		<- a::is(b)
	}
	constant v: Pair<Integer, Integer> = Pair<Integer, Integer>#Neither
	Terminal.inspect(same(pair(), pair()))
}
`,
					"Lamps.es": `implementation {
	choice Light { Red, Green }
	choice Pair<X, Y> { Both { x: X, y: Y }, Neither }

	namespace FnEq for (_ x: Integer) -> Integer is Equatable {
		is(_ other: (_ x: Integer) -> Integer) -> Boolean {
			<- true
		}
	}

	function pair() -> Pair<Light, (_ x: Integer) -> Integer> {
		<- #Neither
	}
}

export {
	FnEq
	Light
	Pair
	pair
}
`,
				},
				(directory) =>
					analysedAt(directory, "Main.es", "Main.es").map(
						(diagnostic) => [
							diagnostic.code,
							diagnostic.message,
							diagnostic.helps,
						],
					),
			)

		expect(reports("pair\n\t\tPair\n\t\tFnEq")).toEqual([
			[
				"unused-import",
				"'FnEq' is imported and never used",
				["Remove the entry."],
			],
			[
				"unsatisfied-bound",
				expect.any(String),
				[
					"'Light' is declared in Lamps.es — import it here, so its derived 'Equatable' is in scope.",
				],
			],
		])
		expect(reports("pair\n\t\tPair\n\t\tFnEq\n\t\tLight")).toEqual([])
	})

	// `red` holds a bare Case of `Colour`, which `Main.es` has no name for. No
	// annotation helps while `Colour` is not Comparable. So the Help is the
	// Choice's own: a Namespace for it, or the import of one that exists.
	it("offers a bare Case of an unimported Choice the Choice's own remedy", () => {
		let compared = (colours: string, entries: string, body: string) =>
			withProject(
				{
					"Main.es": `import {
	from "./Colours.es" {
		${entries}
	}
}

implementation {
	function less<infer T is Comparable>(_ a: T, _ b: T) -> Boolean {
		<- a::isLessThan(b)
	}
${body}
}
`,
					"Colours.es": `implementation {
	choice Colour { Red, Green }
${colours}
	constant red = Colour#Red
}

export {
	Colour
	red${colours === "" ? "" : "\n\tColourOrder"}
}
`,
				},
				(directory) => analysedAt(directory, "Main.es", "Main.es"),
			)
		let order = `
	namespace ColourOrder for Colour is Comparable {
		compare(to other: Colour) -> Ordering {
			<- Ordering#Equal
		}
	}
`
		let call = "\tTerminal.inspect(less(red, red))"
		let helpsOf = (colours: string) =>
			compared(colours, "red", call).map((diagnostic) => diagnostic.helps)

		expect(helpsOf("")).toEqual([
			[
				"'Colour' is declared in Colours.es — import it here, and declare a Namespace 'for Colour is Comparable'.",
			],
		])
		expect(
			codesOf(compared("", "Colour\n\t\tred", `${order}\n${call}`)),
		).toEqual([])
		expect(helpsOf(order)).toEqual([
			[
				"'ColourOrder' in ./Colours.es makes Colour conform to 'Comparable' — import it.",
			],
		])
		expect(codesOf(compared(order, "ColourOrder\n\t\tred", call))).toEqual(
			[],
		)
	})

	// `Colours.es` keeps `Secret` private, so the import needs an export first.
	// The Choice is read off its own Module all the same, and it is not
	// Comparable, so no annotation is offered.
	it("offers a bare Case of a private Choice the Choice's own remedy", () => {
		let compared = (exports: string, entries: string, body: string) =>
			withProject(
				{
					"Main.es": `import {
	from "./Colours.es" {
		${entries}
	}
}

implementation {
	function less<infer T is Comparable>(_ a: T, _ b: T) -> Boolean {
		<- a::isLessThan(b)
	}
${body}
}
`,
					"Colours.es": `implementation {
	choice Secret { Hidden, Shown }

	constant hidden = Secret#Hidden
}

export {
	hidden${exports}
}
`,
				},
				(directory) => analysedAt(directory, "Main.es", "Main.es"),
			)

		expect(
			compared(
				"",
				"hidden",
				"\tTerminal.inspect(less(hidden, hidden))",
			).map((diagnostic) => diagnostic.helps),
		).toEqual([
			[
				"'Secret' is declared in Colours.es, which does not export it — export it there and import it here, and declare a Namespace 'for Secret is Comparable'.",
			],
		])
		expect(
			codesOf(
				compared(
					"\n\tSecret",
					"hidden\n\t\tSecret",
					`
	namespace SecretOrder for Secret is Comparable {
		compare(to other: Secret) -> Ordering {
			<- Ordering#Equal
		}
	}

	Terminal.inspect(less(hidden, hidden))`,
				),
			),
		).toEqual([])
	})

	// A private Choice is bound from its own Module to ask whether importing
	// it brings the derive. `Box<Integer>` derives equality then, and a Union
	// of `Secret` and an Integer does not, so it needs a Namespace as well.
	it("asks whether importing a private Choice brings the derive", () => {
		let compared = (exports: string, entries: string, body: string) =>
			withProject(
				{
					"Main.es": `import {
	from "./Lib.es" {
		${entries}
	}
}

implementation {
	function same<infer T is Equatable>(_ a: T, _ b: T) -> Boolean {
		<- a::is(b)
	}
${body}
}
`,
					"Lib.es": `implementation {
	choice Secret { Hidden, Shown }

	function either() -> Secret | Integer {
		<- 1
	}
}

export {
	either${exports}
}
`,
				},
				(directory) => analysedAt(directory, "Main.es", "Main.es"),
			)
		let call = "\tconstant v = either()\n\tTerminal.inspect(same(v, v))"

		expect(
			compared("", "either", call).map((diagnostic) => diagnostic.helps),
		).toEqual([
			[
				"'Secret' is declared in Lib.es, which does not export it — export it there and import it here, and declare a Namespace 'for Secret | Integer is Equatable'.",
			],
		])
		expect(
			codesOf(
				compared(
					"\n\tSecret",
					"either\n\t\tSecret",
					`
	namespace Equality for Secret | Integer is Equatable {
		is(_ other: Secret | Integer) -> Boolean {
			<- true
		}
	}

${call}`,
				),
			),
		).toEqual([])
	})

	// `Main.es` reaches `Shades.es` only through `Mid.es`, which forwards
	// `dark` and not `ShadeOrder`. The Namespace is offered from the Module
	// that exports it, under a specifier written from `Main.es`.
	it("offers a Namespace a re-exported value's own Module exports", () => {
		let compared = (entries: string) =>
			withProject(
				{
					"Main.es": `import {
${entries}
}

implementation {
	function less<infer T is Comparable>(_ a: T, _ b: T) -> Boolean {
		<- a::isLessThan(b)
	}

	Terminal.inspect(less(dark, dark))
}
`,
					"Mid.es": `implementation {
	constant one = 1
}

export {
	from "./Shades.es" { dark }
}
`,
					"Shades.es": `implementation {
	choice Shade { Dark, Light }

	namespace ShadeOrder for Shade is Comparable {
		compare(to other: Shade) -> Ordering {
			<- Ordering#Equal
		}
	}

	constant dark = Shade#Dark
}

export {
	dark
	Shade
	ShadeOrder
}
`,
				},
				(directory) => analysedAt(directory, "Main.es", "Main.es"),
			)

		expect(
			compared('\tfrom "./Mid.es" { dark }').map(
				(diagnostic) => diagnostic.helps,
			),
		).toEqual([
			[
				"'ShadeOrder' in ./Shades.es makes Shade conform to 'Comparable' — import it.",
			],
		])
		expect(
			codesOf(
				compared(
					'\tfrom "./Mid.es" { dark }\n\tfrom "./Shades.es" { ShadeOrder }',
				),
			),
		).toEqual([])
	})

	// Importing `Colour` brings its derived listing, but `red` holds a bare
	// Case, which lists nothing of its own. One Help asks for both edits, and
	// the import is the first edit a Quick Fix writes.
	it("asks a bare Case of an unimported Choice for the import and the annotation at once", () => {
		let counted = (entries: string, body: string) =>
			withProject(
				{
					"Main.es": `import {
	from "./Colours.es" {
		${entries}
	}
}

implementation {
	function countOf<infer T is Enumerable>(_ example: T) -> Integer {
		<- T.cases()::length()
	}
${body}
}
`,
					"Colours.es": `implementation {
	choice Colour { Red, Green }

	constant red = Colour#Red
}

export {
	Colour
	red
}
`,
				},
				(directory) => analysedAt(directory, "Main.es", "Main.es"),
			)
		let [refusal] = counted(
			"red",
			"\tTerminal.print(countOf(red)::toString())",
		)

		expect(refusal?.code).toBe("unsatisfied-bound")
		expect(refusal?.helps).toEqual([
			"'Colour' is declared in Colours.es — import it here, and annotate the value at 'Colour': a bare Case binds the Case, not the Choice.",
		])
		expect(refusal?.data).toMatchObject({
			kind: "import-declaration",
			name: "Colour",
			partial: true,
		})
		expect(
			codesOf(
				counted(
					"Colour\n\t\tred",
					"\tconstant colour: Colour = red\n\n\tTerminal.print(countOf(colour)::toString())",
				),
			),
		).toEqual([])
	})

	// A generic Choice is annotated at its application, as the Case holds it.
	it("writes the annotation a bare Case needs with its Choice's Type Arguments", () => {
		let counted = (entries: string, body: string) =>
			withProject(
				{
					"Main.es": `import {
	from "./Lamps.es" {
		${entries}
	}
}

implementation {
	function countOf<infer T is Enumerable>(_ example: T) -> Integer {
		<- T.cases()::length()
	}
${body}
}
`,
					"Lamps.es": `implementation {
	choice Switch<Item> { On, Off }

	constant on = Switch<Integer>#On
}

export {
	Switch
	on
}
`,
				},
				(directory) => analysedAt(directory, "Main.es", "Main.es"),
			)

		expect(
			counted("on", "\tTerminal.print(countOf(on)::toString())").map(
				(diagnostic) => diagnostic.helps,
			),
		).toEqual([
			[
				"'Switch' is declared in Lamps.es — import it here, and annotate the value at 'Switch<Integer>': a bare Case binds the Case, not the Choice.",
			],
		])
		expect(
			codesOf(
				counted(
					"on\n\t\tSwitch",
					"\tconstant switch: Switch<Integer> = on\n\n\tTerminal.print(countOf(switch)::toString())",
				),
			),
		).toEqual([])
	})

	// `next() -> Colour` answers `Self` at `Colour`, but not at the bare Case
	// `red` holds. Annotated at the Choice, which `Main.es` imports first, the
	// value binds `Self` to `Colour`.
	it("leads a written Method's narrowed conformance with the import and the annotation", () => {
		let stepped = (entries: string, body: string) =>
			withProject(
				{
					"Main.es": `import {
	from "./Shelf.es" {
		${entries}
	}
}

implementation {
	function step<infer T is Cycled>(_ a: T) -> T {
		<- a::next()
	}
${body}
}
`,
					"Shelf.es": `implementation {
	choice Colour { Red, Green }

	protocol Cycled {
		next() -> Self
	}

	namespace ColourCycle for Colour is Cycled {
		next() -> Colour {
			<- #Green
		}
	}

	constant red = Colour#Red
}

export {
	Colour
	ColourCycle
	Cycled
	red
}
`,
				},
				(directory) => analysedAt(directory, "Main.es", "Main.es"),
			)
		let [refusal] = stepped(
			"ColourCycle\n\t\tCycled\n\t\tred",
			"\tTerminal.inspect(step(red))",
		)

		expect(refusal?.code).toBe("nonconforming-namespace")
		expect(refusal?.notes).toEqual([
			"'next' in 'ColourCycle' answers a Colour at Colour#Red, where 'Cycled' answers a Colour#Red.",
		])
		expect(refusal?.helps).toEqual([
			"'Colour' is declared in Shelf.es — import it here, and annotate the value at 'Colour', since a bare Case binds the Case, not the Choice.",
		])
		expect(
			codesOf(
				stepped(
					"Colour\n\t\tColourCycle\n\t\tCycled\n\t\tred",
					"\tconstant colour: Colour = red\n\n\tTerminal.inspect(step(colour))",
				),
			),
		).toEqual([])
	})

	let shelfModule = `implementation {
	choice Box<Value> { Full { value: Value }, Empty }
	choice Light { Red, Green }

	namespace LightShown for Light is Printable {}

	protocol Shown {
		label() -> String
	}

	choice Tagged<Item is Shown> { Tag { item: Item }, Untagged }

	function make() -> Box<Integer> {
		<- #Full(1)
	}
}

export {
	Box
	Light
	LightShown
	make
	Shown
	Tagged
}
`

	let importing = (entries: string, body: string) => `import {
	from "./Shelf.es" {
		${entries}
	}
}

implementation {
${body}
}
`

	// Each probe reports in `Main.es`, then compiles with its Help followed.
	let reportedIn = (
		main: string,
		code: common.DiagnosticCode,
	): common.Diagnostic | undefined =>
		withProject({ "Main.es": main, "Shelf.es": shelfModule }, (directory) =>
			analysedAt(directory, "Main.es", "Main.es").find(
				(diagnostic) => diagnostic.code === code,
			),
		)

	let codesIn = (main: string): Array<common.DiagnosticCode> =>
		withProject({ "Main.es": main, "Shelf.es": shelfModule }, (directory) =>
			codesOf(analysedAt(directory, "Main.es", "Main.es")),
		)

	// A Generic Alias under another name is one application of its Choice,
	// with Type Parameters of its own order, so it binds no Choice.
	let reorderingModule = `implementation {
	choice Pair<A, B> { Both { first: A, second: B }, Neither }
	type Flipped<A, B> = Pair<B, A>

	choice Sorted<Item is Comparable, Tag> { Entry { item: Item, tag: Tag }, None }
	type Reversed<Tag, Item is Comparable> = Sorted<Item, Tag>

	choice Box<Value> { Full { value: Value }, Empty }
	type Boxes<A> = Box<List<A>>
}

export {
	Boxes
	Flipped
	Reversed
}
`

	let reordered = (entries: string, body: string) =>
		withProject(
			{
				"Main.es": `import {
	from "./Reordering.es" {
		${entries}
	}
}

implementation {
${body}
}
`,
				"Reordering.es": reorderingModule,
			},
			(directory) => codesOf(analysedAt(directory, "Main.es", "Main.es")),
		)

	it("takes no Choice from a generic Alias that reorders its Type Parameters", () => {
		// The receiver's Choice has no name here, as without the import.
		expect(
			reordered(
				"Flipped",
				`	constant pair: Flipped<Integer, String> = #Both({ first = "a", second = 1 })
	Terminal.print(pair::is(pair))`,
			),
		).toEqual(["unknown-method"])

		// `Tag` is not the Type Parameter `Sorted` bounds, so nothing proves
		// it Comparable.
		expect(
			reordered(
				"Reversed",
				`	namespace ReversedOrder<infer Tag, infer Item> for Reversed<Tag, Item> {
		tagBefore(_ other: Tag) -> Boolean {
			<- match @ -> Boolean {
				case #Entry { <- @.tag::isLessThan(other) }
				case #None { <- false }
			}
		}
	}`,
			),
		).toContain("no-namespace-for-value")
	})

	it("derives equality and printing for a Choice imported under another name", async () => {
		await withBuiltProject(
			{
				"Main.es": importing(
					"Box as Carton\n\t\tLight as Lamp\n\t\tLightShown",
					`	constant box: Carton<Integer> = #Full(1)
	Terminal.inspect(box::is(box))
	constant lamp: Lamp = #Red
	Terminal.inspect(lamp::is(#Green))
	Terminal.print(lamp)`,
				),
				"Shelf.es": shelfModule,
			},
			async (directory) => {
				expect(
					codesOf(analysedAt(directory, "Main.es", "Main.es")),
				).toEqual([])
				expect(
					await runBundle(
						generateModules(linkProject(directory, "Main.es")),
						directory,
					),
				).toEqual(["true", "false", "Red"])
			},
		)
	})

	it("names the applications of an ambiguous Case as the imports name them", () => {
		let refusal = reportedIn(
			importing(
				"Box as Carton",
				'\tconstant box: Carton<Integer> | Carton<String> = #Full("x")',
			),
			"ambiguous-case",
		)

		expect(refusal?.message).toBe(
			"Case '#Full' fits more than one application of 'Carton'",
		)
		expect(refusal?.helps).toEqual([
			"Write 'Carton<Integer>#Full' to pick 'Carton<Integer>'.",
			"Write 'Carton<String>#Full' to pick 'Carton<String>'.",
		])
		expect(
			codesIn(
				importing(
					"Box as Carton",
					'\tconstant box: Carton<Integer> | Carton<String> = Carton<String>#Full("x")\n\tTerminal.inspect(box)',
				),
			),
		).toEqual([])
	})

	// `Crate` renames `Box`, which `Main.es` does not import. A construction
	// through it writes the Type Arguments, and a Matcher writes none.
	it("names an ambiguous Case's Choice through a generic Alias that renames it", () => {
		let crated = (body: string) =>
			withProject(
				{
					"Main.es": `import {
	from "./Crates.es" { Crate }
}

implementation {
	choice Bag { Full { value: Integer }, Empty }

${body}
}
`,
					"Crates.es": `implementation {
	choice Box<Value> { Full { value: Value }, Empty }
	type Crate<V> = Box<V>
}

export {
	Crate
}
`,
				},
				(directory) => analysedAt(directory, "Main.es", "Main.es"),
			)
		let helpsOf = (body: string) =>
			crated(body).find(
				(diagnostic) => diagnostic.code === "ambiguous-case",
			)?.helps
		let matched = (
			matcher: string,
		) => `	function describe(_ box: Crate<Integer> | Bag) -> String {
		<- match box -> String {
			case ${matcher} { <- "full" }
			case _ { <- "other" }
		}
	}

	Terminal.print(describe(Bag#Empty))`

		expect(
			helpsOf(
				'\tconstant box: Crate<Integer> | Crate<String> = #Full("x")',
			),
		).toEqual([
			"Write 'Crate<Integer>#Full' to pick 'Crate<Integer>'.",
			"Write 'Crate<String>#Full' to pick 'Crate<String>'.",
		])
		expect(
			codesOf(
				crated(
					'\tconstant box: Crate<Integer> | Crate<String> = Crate<String>#Full("x")\n\tTerminal.inspect(box)',
				),
			),
		).toEqual([])

		expect(helpsOf("\tconstant box = #Full(1)")).toEqual([
			"Write 'Crate<…>#Full' with its Type Arguments to pick 'Crate'.",
			"Write 'Bag#Full' to pick 'Bag'.",
		])
		expect(
			codesOf(
				crated(
					"\tconstant box = Crate<Integer>#Full(1)\n\tTerminal.inspect(box)",
				),
			),
		).toEqual([])

		expect(helpsOf(matched("#Full"))).toEqual([
			"Write 'Crate#Full' to pick 'Crate'.",
			"Write 'Bag#Full' to pick 'Bag'.",
		])
		expect(codesOf(crated(matched("Crate#Full")))).toEqual([])
	})

	// `Boxes` and `Flip` each write their Choice's applications under Type
	// Arguments of their own. The Help binds them by matching each Alias
	// against the application it picks.
	it("binds a generic Alias's own Type Arguments for an ambiguous Case", () => {
		let shelved = (entries: string, body: string) =>
			withProject(
				{
					"Main.es": `import {
	from "./Shelf.es" {
		${entries}
	}
}

implementation {
${body}
}
`,
					"Shelf.es": `implementation {
	choice Box<Value> { Full { value: Value }, Empty }
	choice Pair<X, Y> { Both { x: X, y: Y }, Neither }
	type Boxes<A> = Box<List<A>>
	type Flip<A, B> = Pair<B, A>
}

export {
	Boxes
	Flip
}
`,
				},
				(directory) => analysedAt(directory, "Main.es", "Main.es"),
			)
		let helpsOf = (entries: string, body: string) =>
			shelved(entries, body).find(
				(diagnostic) => diagnostic.code === "ambiguous-case",
			)?.helps

		expect(
			helpsOf(
				"Boxes",
				'\tconstant box: Boxes<Integer> | Boxes<String> = #Full(["x"])',
			),
		).toEqual([
			"Write 'Boxes<Integer>#Full' to pick 'Boxes<Integer>'.",
			"Write 'Boxes<String>#Full' to pick 'Boxes<String>'.",
		])
		expect(
			helpsOf(
				"Flip",
				'\tconstant pair: Flip<Integer, String> | Flip<String, Integer> = #Both({ x = 1, y = "s" })',
			),
		).toEqual([
			"Write 'Flip<Integer, String>#Both' to pick 'Flip<Integer, String>'.",
			"Write 'Flip<String, Integer>#Both' to pick 'Flip<String, Integer>'.",
		])
		expect(
			codesOf(
				shelved(
					"Boxes\n\t\tFlip",
					`	constant box: Boxes<Integer> | Boxes<String> = Boxes<String>#Full(["x"])
	constant pair: Flip<Integer, String> | Flip<String, Integer> = Flip<String, Integer>#Both({ x = 1, y = "s" })
	Terminal.inspect(box)
	Terminal.inspect(pair)`,
				),
			),
		).toEqual([])
	})

	// `Main.es` imports the Aliases alone, whose Cases mention their own Type
	// Parameters. A bare Case is still the one its Choice declares, read off
	// the Choice's own Module, as where the Choice is in scope.
	describe("a bare Case where only a generic Alias of its Choice is imported", () => {
		let shelf = `implementation {
	choice Box<Value> { Full { value: Value }, Empty }
	choice Pair<A, B> { Left { a: A }, Neither }
	choice Bin<K, V> { Stored { value: V }, Vacant }
	type Crate<W> = Box<W>
	type Boxes<L> = Box<List<L>>
	type Flip<X, Y> = Pair<Y, X>
	type Ints = Box<Integer>
	type Keyed<V> = Bin<String, V>
}

export {
	Boxes
	Crate
	Flip
	Ints
	Keyed
}
`
		let importing = (entries: string, body: string) => ({
			"Main.es": `import {
	from "./Shelf.es" {
		${entries}
	}
}

implementation {
${body}
}
`,
			"Shelf.es": shelf,
		})

		it("instantiates it from its payload", async () => {
			await withBuiltProject(
				importing(
					"Boxes\n\t\tCrate\n\t\tInts",
					`	function take(_ box: Crate<Integer>) -> String {
		<- "took"
	}

	Terminal.inspect(#Full(1))
	Terminal.inspect(#Full("five"))
	Terminal.inspect(#Full([2]))
	Terminal.inspect([#Full(6), #Full(7)])
	Terminal.inspect(take(#Full(8)))`,
				),
				async (directory) => {
					expect(
						codesOf(analysedAt(directory, "Main.es", "Main.es")),
					).toEqual([])
					expect(
						await runBundle(
							generateModules(linkProject(directory, "Main.es")),
							directory,
						),
					).toEqual([
						"Box#Full(1)",
						'Box#Full("five")',
						"Box#Full([ 2 ])",
						"[ Box#Full(6), Box#Full(7) ]",
						'"took"',
					])
				},
			)
		})

		// The Choice is no name in `Main.es`, so the Helps write the Alias.
		// `Keyed` fixes `Bin`'s `K`, so its payload decides every Type
		// Parameter of the Alias, and only writing `Keyed` decides `K`.
		it("writes an undecided one's Type Arguments through the Alias", () => {
			let analysed = (body: string, entries = "Flip") =>
				withProject(importing(entries, body), (directory) =>
					analysedAt(directory, "Main.es", "Main.es"),
				)
			let undecided = (body: string, entries = "Flip") =>
				analysed(body, entries).find(
					(diagnostic) =>
						diagnostic.code === "undecided-type-arguments",
				)

			expect(
				undecided("\tconstant left = #Left({ a = 1 })")?.labels[0]
					?.message,
			).toBe("its payload decides 'Y', and nothing decides 'X'")
			expect(
				undecided("\tconstant none = #Neither")?.labels[0]?.message,
			).toBe("no Type Arguments here, and nothing around it decides them")
			expect(
				undecided("\tconstant stored = #Stored(5)", "Keyed"),
			).toMatchObject({
				labels: [
					{
						message:
							"its payload decides 'V', and only writing 'Keyed' decides the rest",
					},
				],
				helps: [
					"Annotate the Declaration this is written into with 'Keyed<Integer>', which is what decides them.",
					"Or apply the Type Arguments here — 'Keyed<Integer>#Stored(…)', with the Type you mean in place of each '…'.",
				],
			})
			expect(
				codesOf(
					analysed(
						"\tconstant stored: Keyed<Integer> = #Stored(5)\n\tTerminal.inspect(stored)",
						"Keyed",
					),
				),
			).toEqual([])
			expect(
				undecided("\tconstant left = #Left({ a = 1 })")?.helps,
			).toEqual([
				"Annotate the Declaration this is written into with 'Flip<…, Integer>', which is what decides them.",
				"Or apply the Type Arguments here — 'Flip<…, Integer>#Left(…)', with the Type you mean in place of each '…'.",
			])
			expect(
				codesOf(
					analysed(
						"\tconstant left: Flip<String, Integer> = #Left({ a = 1 })\n\tTerminal.inspect(left)",
					),
				),
			).toEqual([])
			expect(
				codesOf(
					analysed(
						"\tTerminal.inspect(Flip<String, Integer>#Left({ a = 1 }))",
					),
				),
			).toEqual([])
			expect(undecided("\tconstant none = #Neither")?.helps).toEqual([
				"Annotate the Declaration this is written into with 'Flip<…, …>', which is what decides them.",
				"Or apply the Type Arguments here — 'Flip<…, …>#Neither', with the Type you mean in place of each '…'.",
			])
		})
	})

	it("writes a missing Case under the name an import gave its Choice", () => {
		let match = (handlers: string) =>
			importing(
				"Box as Carton",
				`	function describe(_ box: Carton<Integer> | Carton<String>) -> String {
		<- match box -> String {
			case #Empty { <- "empty" }${handlers}
		}
	}

	Terminal.print(describe(Carton<Integer>#Empty))`,
			)
		let refusal = reportedIn(match(""), "missing-case")

		expect(refusal?.helps).toEqual([
			"Add 'case Carton#Full', or a 'case _' that covers the rest.",
		])
		expect(refusal?.data).toEqual({
			kind: "missing-case",
			unhandled: ["Carton#Full"],
		})
		expect(
			codesIn(match('\n\t\t\tcase Carton#Full { <- "full" }')),
		).toEqual([])
	})

	// `Main.es` binds no name for `Box`, so its Case is written bare and
	// resolves against the matched value.
	it("writes a missing Case bare where no import names its Choice", () => {
		let match = (handlers: string) =>
			importing(
				"make",
				`	Terminal.print(match make() -> String {
		case #Empty { <- "empty" }${handlers}
	})`,
			)
		let refusal = reportedIn(match(""), "missing-case")

		expect(refusal?.helps).toEqual([
			"Add 'case #Full', or a 'case _' that covers the rest.",
		])
		expect(codesIn(match('\n\t\tcase #Full { <- "full" }'))).toEqual([])
	})

	it("offers the name an import gave a Type written by its declared name", () => {
		let refusal = reportedIn(
			importing(
				"Box as Carton",
				'\tconstant box: Carton<String> = Box<String>#Full("x")',
			),
			"unknown-type",
		)

		expect(refusal?.helps).toEqual([
			"Write 'Carton', the name 'Box' goes by in this file.",
		])
		expect(refusal?.data).toEqual({
			kind: "suggestion",
			suggestion: "Carton",
		})
		expect(
			codesIn(
				importing(
					"Box as Carton",
					'\tconstant box: Carton<String> = Carton<String>#Full("x")\n\tTerminal.inspect(box)',
				),
			),
		).toEqual([])
	})

	// `Flipped` and `Boxes` each name one application, which no Type Argument
	// written to `Pair` or `Box` spells.
	it("offers no generic Alias as the name a Choice goes by", () => {
		let named = (entry: string, annotation: string, value: string) =>
			withProject(
				{
					"Main.es": `import {
	from "./Reordering.es" { ${entry} }
}

implementation {
	constant held: ${annotation} = ${value}
	Terminal.inspect(held)
}
`,
					"Reordering.es": reorderingModule,
				},
				(directory) =>
					analysedAt(directory, "Main.es", "Main.es").find(
						(diagnostic) => diagnostic.code === "unknown-type",
					)?.helps,
			)

		expect(
			named(
				"Flipped",
				"Pair<String, Integer>",
				'#Both({ first = "a", second = 1 })',
			),
		).toEqual([])
		expect(named("Boxes", "Box<Integer>", "#Full(1)")).toEqual([])
	})

	it("spells a Namespace's target and condition as the imports name them", () => {
		let entries = "Shown as Visible\n\t\tTagged as Label"
		let printed = `	function show<infer Item is Visible>(_ tagged: Label<Item>) -> Integer {
		Terminal.print(tagged)
		<- 1
	}`
		let refusal = reportedIn(
			importing(entries, printed),
			"unsatisfied-bound",
		)

		expect(refusal?.helps).toEqual([
			"Write 'Terminal.inspect(…)' instead — it renders any value structurally and asks for no conformance.",
			"Declare a Namespace '<infer Item> for Label<Item> is Printable where Item is Visible'.",
		])
		expect(
			codesIn(
				importing(
					entries,
					`	namespace LabelShown<infer Item> for Label<Item> is Printable where Item is Visible {
		toString() -> String { <- "label" }
	}

${printed}`,
				),
			),
		).toEqual([])
	})

	it("names the Choice a dispatch can not tell applications of as imported", () => {
		let refusal = reportedIn(
			importing(
				"Box as Carton",
				`	function isEmpty(_ box: Carton<Integer> | Carton<String>) -> Boolean {
		<- box::is(#Empty)
	}`,
			),
			"erased-case-conflict",
		)

		expect(refusal?.helps).toEqual([
			"Write the receiver's Type as one application of 'Carton'.",
		])
		expect(
			codesIn(
				importing(
					"Box as Carton",
					`	function isEmpty(_ box: Carton<Integer>) -> Boolean {
		<- box::is(#Empty)
	}

	Terminal.inspect(isEmpty(#Empty))`,
				),
			),
		).toEqual([])
	})

	it("names the Case a Match takes from another application as imported", () => {
		let describe = (
			cases: string,
		) => `	function describe(_ box: Carton<Integer> | Carton<String>) -> String {
		<- match box -> String {
${cases}
		}
	}`
		let byApplication = `			case Carton<Integer> { <- "integers" }
			case Carton<String> { <- "strings" }`
		let warning = reportedIn(
			importing("Box as Carton", describe(byApplication)),
			"type-argument-overlap",
		)

		expect(warning?.message).toBe(
			"This Case never sees Carton<String>#Empty",
		)
		expect(warning?.helps).toEqual([
			"Write 'case Carton#Empty' above the Case that runs first, so one Case answers for it in every application.",
		])
		expect(
			codesIn(
				importing(
					"Box as Carton",
					describe(`			case Carton#Empty { <- "empty" }
${byApplication}`),
				),
			),
		).toEqual([])
	})

	it("names the Case a member takes from another application as imported", () => {
		let holderModule = `implementation {
	choice Box<Item> { Full { item: Item }, Empty }
	choice Holder { Hold { box: Box<Integer> | Box<String> }, Nothing }
}

export {
	Box
	Holder
}
`
		let main = (cases: string) => `import {
	from "./Holder.es" {
		Box as Carton
		Holder
	}
}

implementation {
	function describe(_ value: Holder) -> String {
		<- match value -> String {
${cases}
			case #Nothing { <- "nothing" }
		}
	}
}
`
		let analysed = (cases: string) =>
			withProject(
				{ "Main.es": main(cases), "Holder.es": holderModule },
				(directory) => analysedAt(directory, "Main.es", "Main.es"),
			)
		let warning =
			analysed(`			case #Hold({ box: Carton<Integer> }) { <- "integers" }
			case #Hold({ box: Carton<String> }) { <- "strings" }
			case _ { <- "other" }`).find(
				(diagnostic) => diagnostic.code === "type-argument-overlap",
			)

		expect(warning?.message).toBe(
			"This Case never sees Holder#Hold values whose box is Carton<String>#Empty",
		)
		expect(warning?.helps).toEqual([
			"Bind 'box' in one 'case Holder#Hold({ box })' in place of these Cases, and match it there with 'case Carton#Empty' first.",
		])
		expect(
			codesOf(
				analysed(`			case Holder#Hold({ box }) {
				<- match box -> String {
					case Carton#Empty { <- "empty" }
					case Carton<Integer> { <- "integers" }
					case Carton<String> { <- "strings" }
				}
			}`),
			),
		).toEqual([])
	})

	// Only the aliases are imported, so `Box<String>` would name nothing, and
	// the Case Matcher stands as before.
	it("names a missing Case as a Matcher where only aliases of its Choice are imported", () => {
		let boxModule = `implementation {
	choice Box<Item> { Full { item: Item }, Empty }
	type IntBox = Box<Integer>
	type StrBox = Box<String>
}

export {
	IntBox
	StrBox
}
`
		let main = (cases: string) => `import {
	from "./Box.es" {
		IntBox
		StrBox
	}
}

implementation {
	function describe(_ value: IntBox | StrBox) -> String {
		<- match value -> String {
${cases}
		}
	}
}
`
		let analysed = (cases: string) =>
			withProject(
				{ "Main.es": main(cases), "Box.es": boxModule },
				(directory) => analysedAt(directory, "Main.es", "Main.es"),
			)
		let refusal = analysed(
			`			case IntBox { <- "integers" }`,
		).find((diagnostic) => diagnostic.code === "missing-case")

		expect(refusal?.helps).toEqual([
			"Add 'case #Full', or a 'case _' that covers the rest.",
		])
		expect(refusal?.notes).toEqual(["Unhandled: '#Full'."])
		expect(
			codesOf(
				analysed(`			case IntBox { <- "integers" }
			case #Full { <- "full" }`),
			),
		).toEqual([])
	})

	// `Secret` is not imported, so `Box<Secret>` would name nothing.
	it("names a missing Case as a Matcher where a Type Argument has no name in the file", () => {
		let boxModule = `implementation {
	choice Box<Item> { Full { item: Item }, Empty }
	type Secret = { code: Integer }
	type SecretBox = Box<Secret>
}

export {
	Box
	SecretBox
}
`
		let main = (cases: string) => `import {
	from "./Box.es" {
		Box
		SecretBox
	}
}

implementation {
	function describe(_ value: Box<Integer> | SecretBox) -> String {
		<- match value -> String {
${cases}
		}
	}
}
`
		let analysed = (cases: string) =>
			withProject(
				{ "Main.es": main(cases), "Box.es": boxModule },
				(directory) => analysedAt(directory, "Main.es", "Main.es"),
			)

		expect(
			analysed(`			case Box<Integer> { <- "integers" }`).find(
				(diagnostic) => diagnostic.code === "missing-case",
			)?.helps,
		).toEqual(["Add 'case Box#Full', or a 'case _' that covers the rest."])
		expect(
			codesOf(
				analysed(`			case Box<Integer> { <- "integers" }
			case Box#Full { <- "full" }`),
			),
		).toEqual([])
	})

	let renamingModule = `implementation {
	choice Pair<A, B> { Both { first: A, second: B }, Neither }
	choice Either<First, Second> { Left { value: First }, Right { value: Second } }

	type Point = { x: Integer, y: Integer }
	type Small = Integer where @::isLessThan(10)
}

export {
	Either
	Pair
	Point
	Small
}
`

	let renamed = (body: string) =>
		withProject(
			{
				"Main.es": `import {
	from "./Renaming.es" {
		Either as Fork
		Pair as Duo
		Point as Spot
		Small as Tiny
	}
}

implementation {
${body}
}
`,
				"Renaming.es": renamingModule,
			},
			// Each probe uses only some of the entries.
			(directory) =>
				analysedAt(directory, "Main.es", "Main.es").filter(
					(diagnostic) => diagnostic.code !== "unused-import",
				),
		)

	it("names an undecided Choice as the imports name it", () => {
		expect(
			renamed(
				"\tconstant none = #Neither\n\tconstant left = #Left(1)",
			).map((diagnostic) => diagnostic.helps),
		).toEqual([
			[
				"Annotate the Declaration this is written into with 'Duo<…, …>', which is what decides them.",
				"Or apply the Type Arguments here — 'Duo<…, …>#Neither', with the Type you mean in place of each '…'.",
			],
			[
				"Annotate the Declaration this is written into with 'Fork<Integer, …>', which is what decides them.",
				"Or apply the Type Arguments here — 'Fork<Integer, …>#Left(…)', with the Type you mean in place of each '…'.",
			],
		])
		expect(
			codesOf(
				renamed(`	constant none: Duo<Integer, String> = #Neither
	constant left = Fork<Integer, String>#Left(1)
	Terminal.inspect(none)
	Terminal.inspect(left)`),
			),
		).toEqual([])
	})

	// A refinement is no Matcher, so the arm tests its base.
	it("writes a missing member as the imports name it, a refinement by its base", () => {
		let matched = (
			handlers: string,
		) => `	function spotted(_ value: Spot | Tiny | String) -> String {
		<- match value -> String {
			case String { <- "text" }${handlers}
		}
	}

	Terminal.print(spotted("a"))`

		expect(
			renamed(matched("")).find(
				(diagnostic) => diagnostic.code === "missing-case",
			)?.helps,
		).toEqual([
			"Add 'case Spot', 'case Integer', or a 'case _' that covers the rest.",
		])
		expect(
			codesOf(
				renamed(
					matched(
						'\n\t\t\tcase Spot { <- "spot" }\n\t\t\tcase Integer { <- "tiny" }',
					),
				),
			),
		).toEqual([])
	})

	// Two Choices no import names share `#Full`, so neither can be written
	// bare, and `case _` takes both.
	it("leaves the Cases no name here can write to a 'case _'", () => {
		let matched = (handlers: string) =>
			withProject(
				{
					"Main.es": `import {
	from "./Parcels.es" { parcels }
}

implementation {
	Terminal.print(match parcels() -> String {
		case #Bare { <- "bare" }${handlers}
	})
}
`,
					"Parcels.es": `implementation {
	choice Box<Value> { Full { value: Value }, Empty }
	choice Crate { Full { count: Integer }, Bare }

	function parcels() -> Box<Integer> | Crate {
		<- Crate#Bare
	}
}

export {
	parcels
}
`,
				},
				(directory) => analysedAt(directory, "Main.es", "Main.es"),
			)
		let refusal = matched("").find(
			(diagnostic) => diagnostic.code === "missing-case",
		)

		expect(refusal?.helps).toEqual([
			"Add 'case #Empty', and a 'case _' for the Cases this file has no name for.",
		])
		expect(refusal?.data).toEqual({
			kind: "missing-case",
			unhandled: ["#Empty", "_"],
		})
		expect(
			codesOf(
				matched(
					'\n\t\tcase #Empty { <- "empty" }\n\t\tcase _ { <- "full" }',
				),
			),
		).toEqual([])
	})

	// The Namespace's `for` clause names the Choice as the Help's import
	// binds it.
	it("spells a Namespace target by the name its import binds", () => {
		let printed = (entries: string, declared: string) =>
			withProject(
				{
					"Main.es": `import {
	from "./Parcels.es" {
		${entries}
	}
}

implementation {${declared}
	Terminal.print(boxed())
}
`,
					"Parcels.es": `implementation {
	choice Box<Value> { Full { value: Value }, Empty }

	function boxed() -> Box<Integer> {
		<- #Full(1)
	}
}

export {
	Box as Crate
	boxed
}
`,
				},
				(directory) => analysedAt(directory, "Main.es", "Main.es"),
			)

		expect(
			printed("boxed", "").find(
				(diagnostic) => diagnostic.code === "unsatisfied-bound",
			)?.helps,
		).toEqual([
			"Write 'Terminal.inspect(…)' instead — it renders any value structurally and asks for no conformance.",
			"'Box' is declared in Parcels.es, which exports it as 'Crate' — import 'Crate' here, and declare a Namespace 'for Crate<Integer> is Printable'.",
		])
		expect(
			codesOf(
				printed(
					"boxed\n\t\tCrate",
					`
	namespace CrateShown for Crate<Integer> is Printable {
		toString() -> String {
			<- "crate"
		}
	}
`,
				),
			),
		).toEqual([])
	})

	// A Matcher names what this file can write: a Record nothing here binds by
	// its shape, a Case of a Choice nothing here binds bare. A Choice's
	// `::is` needs the Choice bound, so without it the Help is withheld.
	describe("a Match a Help writes", () => {
		let lib = `implementation {
	type Point = { x: Integer }
	type Label = { text: String }

	choice Colour { Red, Green }
	choice Shape { Circle { radius: Integer }, Dot }

	function spot() -> Integer | Point {
		<- 1
	}

	function pick() -> Integer | Colour {
		<- 1
	}

	function made() -> Point | Label {
		<- { x = 1 }
	}

	function shaped() -> Shape | Integer {
		<- 1
	}
}

export {
	Point
	Label
	Colour
	Shape
	spot
	pick
	made
	shaped
}
`
		let main = (body: string) => `import {
	from "./Lib.es" {
		spot
		pick
		made
		shaped
	}
}

implementation {
${body}
}
`
		// The imports a body leaves unread are reported too, and are no
		// business of these specs.
		let analysed = (body: string) =>
			withProject({ "Main.es": main(body), "Lib.es": lib }, (directory) =>
				analysedAt(directory, "Main.es", "Main.es").filter(
					(diagnostic) => diagnostic.code !== "unused-import",
				),
			)

		it("should ask a Condition's members with Matchers this file can write", () => {
			let refusals = analysed(`	if spot() {
		Terminal.print("a")
	}

	if pick() {
		Terminal.print("b")
	}`)

			expect(codesOf(refusals)).toEqual([
				"condition-not-boolean",
				"condition-not-boolean",
			])
			expect(refusals.map((refusal) => refusal.helps)).toEqual([
				[
					"Ask each member its own question in a Match that answers a Boolean — 'match … -> Boolean { case Integer { <- @::isGreaterThan(0) } case { x: Integer } { <- @::is(…) } }'.",
				],
				[],
			])
			expect(
				codesOf(
					analysed(`	if match spot() -> Boolean { case Integer { <- @::isGreaterThan(0) } case { x: Integer } { <- @::is({ x = 1 }) } } {
		Terminal.print("a")
	}`),
				),
			).toEqual([])
		})

		// A Choice's `::is` is derived where the Choice is in scope, so a value
		// holding one the file does not import gets no question.
		it("should ask '::is' of a Choice only where this file binds it", () => {
			let outcomes = `implementation {
	choice Outcome { Won, Lost }

	type Standing = { team: String, last: Outcome }

	function outcome() -> Outcome {
		<- Outcome#Won
	}

	function standing() -> Standing {
		<- { team = "a", last = Outcome#Won }
	}
}

export {
	Outcome
	Standing
	outcome
	standing
}
`
			let reading = (entries: string, body: string) =>
				withProject(
					{
						"Main.es": `import {
	from "./Outcomes.es" {
		${entries}
	}
}

implementation {
${body}
}
`,
						"Outcomes.es": outcomes,
					},
					(directory) =>
						analysedAt(directory, "Main.es", "Main.es").filter(
							(diagnostic) => diagnostic.code !== "unused-import",
						),
				)
			let asked = `	if outcome() {
		Terminal.print("a")
	}

	if standing() {
		Terminal.print("b")
	}`

			expect(
				reading("outcome\n\t\tstanding", asked).map(
					(diagnostic) => diagnostic.helps,
				),
			).toEqual([[], []])
			expect(
				reading("Outcome\n\t\toutcome", asked.split("\n\n")[0]!).map(
					(diagnostic) => diagnostic.helps,
				),
			).toEqual([
				[
					"Ask a question that answers a Boolean — '::is(…)' reads an Outcome.",
				],
			])
			expect(
				codesOf(
					reading(
						"Outcome\n\t\toutcome",
						`	if outcome()::is(Outcome#Won) {
		Terminal.print("a")
	}`,
					),
				),
			).toEqual([])
		})

		it("should read a member in an arm this file can write", () => {
			let refusals = analysed(`	constant value = made()
	constant shape = shaped()

	Terminal.print(value.x)
	Terminal.print(shape.radius)`)

			expect(refusals.map((refusal) => refusal.helps)).toEqual([
				[
					"Read '@.x' in a Match arm that narrows the value — 'case { x: Integer } { … }'.",
				],
				[
					"Read '@.radius' in a Match arm that narrows the value — 'case #Circle { … }'.",
				],
			])
			expect(
				codesOf(
					analysed(`	constant value = made()
	constant shape = shaped()

	Terminal.print(match value -> Integer { case { x: Integer } { <- @.x } case { text: String } { <- 0 } })
	Terminal.print(match shape -> Integer { case #Circle { <- @.radius } case #Dot { <- 0 } case Integer { <- @ } })`),
				),
			).toEqual([])
		})
	})

	// The edit is to the Declaration, which `Sizes.es` writes as `Sizes`,
	// not under the name this file imports it as.
	it("names an imported Namespace's Declaration as its file declares it", () => {
		let checked = (keyword: string) =>
			withProject(
				{
					"Main.es": `import {
	from "./Sizes.es" { Sizes as S }
}

implementation {
	type Small = Integer where @::isSmall()

	constant small: Small = 3

	Terminal.inspect(small)
}
`,
					"Sizes.es": `implementation {
	namespace Sizes for Integer {
		${keyword}isSmall() -> Boolean {
			<- @::isLessThan(10)
		}
	}
}

export {
	Sizes
}
`,
				},
				(directory) => analysedAt(directory, "Main.es", "Main.es"),
			)

		let refused = checked("static ").find(
			(diagnostic) => diagnostic.code === "static-method-on-value",
		)

		expect(refused?.helps).toEqual([
			"Declare 'isSmall' in 'Sizes', which this file imports as 'S', without 'static' — a predicate asks a Method of '@', and a static Method has no receiver.",
		])
		expect(refused?.notes).toEqual([
			"'Sizes', which this file imports as 'S', declares 'isSmall' as static.",
		])
		expect(codesOf(checked(""))).toEqual([])
	})
})
