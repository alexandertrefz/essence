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

import { STDLIB_DIRECTORY } from "@essence/stdlib"

import { loadModuleGraph, type Module } from "../modules/graph"
import { diskModuleHost, type ModuleHost } from "../modules/host"
import { canonicalPath, resolveSpecifier } from "../modules/resolve"

// NOTE: A project on disk, in a directory of its own that is removed again. The
// files are written rather than taken from `packages/fixtures`, because what is
// under test is resolution — which is about where files sit relative to each
// other, and a test that has to be read alongside a directory listing
// elsewhere is a test nobody can check.
//
// NOTE: The directory is canonicalised before anything is built out of it.
// `mkdtempSync` answers under `/var/folders/…` on macOS, which is a symlink to
// `/private/var/folders/…`, so every path a test compares against has to be the
// spelling the resolver answers in.
function withProject<T>(
	files: Record<string, string>,
	work: (directory: string) => T,
): T {
	let directory = mkdtempSync(path.join(tmpdir(), "essence-modules-"))

	try {
		for (let [name, source] of Object.entries(files)) {
			let filePath = path.join(directory, name)

			mkdirSync(path.dirname(filePath), { recursive: true })
			writeFileSync(filePath, source)
		}

		return work(realpathSync.native(directory))
	} finally {
		rmSync(directory, { recursive: true, force: true })
	}
}

// NOTE: The other kind of host: files that are not on disk at all, which is what
// the Language Server hands over for a document the Editor holds unsaved. It
// records what it was asked for, so that "one file is read once" is observable.
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

	// NOTE: Above the importer's directory is an ordinary place for a dependency
	// to sit — `"../math/Math.es"` is in the language's own examples. There is no
	// root a specifier may not leave: a Module names files, and a file that
	// exists is a file that can be imported.
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

	// NOTE: The Language Server resolves against documents that have never been
	// saved, so resolution may not ask whether the file exists. Whether anything
	// can be READ there is the host's answer, and the graph's Diagnostic.
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

			// NOTE: The same file spelled the long way round. A self-import is
			// which FILE the path lands on, not whether the two spellings look
			// alike.
			expect(resolveSpecifier("../src/Main.es", importer)).toEqual({
				kind: "rejected",
				reason: "self-import",
			})
		})
	})

	// NOTE: Derived from `STDLIB_DIRECTORY` rather than spelled out, so this
	// holds under both layouts that constant answers for — the sources in a
	// workspace checkout, and the copy written beside the bundled Language
	// Server in the VS Code extension. Written out, the test would quietly stop
	// naming the standard library and pass anyway.
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

	// NOTE: One file reached through a symlink and directly is ONE Module. Two
	// spellings of one path would be parsed twice, enriched twice, and their
	// Types would not be interchangeable — a Rectangle that is not a Rectangle.
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
	// NOTE: Dependencies first, the entry last. Every stage after this one runs
	// over the Modules in this order, and a Module may only be enriched once
	// everything it imports has been.
	it("orders a chain of Modules dependency first", () => {
		withProject(
			{
				"Main.es": `import {
	Rectangle from "./Geometry.es"
}

${moduleProgram()}`,
				"Geometry.es": `import {
	PI from "./math/Math.es"
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

				// NOTE: Nothing is grouped — a chain is one Module per group.
				expect(groupNamesOf(directory, graph.groups)).toEqual([
					[path.join("math", "Math.es")],
					["Geometry.es"],
					["Main.es"],
				])
			},
		)
	})

	// NOTE: A re-export is a dependency. A facade that only forwards names never
	// mentions the Module it forwards them from anywhere but its `export` block,
	// and reading edges off the imports alone leaves it with none at all — the
	// file it depends on would not be loaded, enriched, or bundled.
	it("takes a dependency from an export section's 'from' entry", () => {
		withProject(
			{
				"Main.es": `import {
	Rectangle from "./Facade.es"
}

${moduleProgram()}`,
				"Facade.es": `${moduleProgram()}
export {
	Rectangle from "./Geometry.es"
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

	// NOTE: The whole point of keying on the canonical path: a diamond binds one
	// Module, whichever importer reached it first, so its body runs once and its
	// Types are the same Types on both sides.
	it("reads a Module two importers name exactly once", () => {
		let directory = canonicalPath(
			path.join(tmpdir(), `essence-diamond-${process.pid}`),
		)
		let filePath = (name: string) => path.join(directory, name)
		let host = memoryHost({
			[filePath("Main.es")]: `import {
	Rectangle from "./Left.es"
	Circle from "./Right.es"
}

${moduleProgram()}`,
			[filePath("Left.es")]: `import {
	Shape from "./Shape.es"
}

${moduleProgram()}`,
			[filePath("Right.es")]: `import {
	Shape from "./Shape.es"
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

	// NOTE: Two entries naming one Module are one dependency and one entry in
	// the resolution table, keyed by the specifier as written — which is what an
	// Import or Export entry has in hand when it goes looking for the Module it
	// named.
	it("names a Module once however many entries mention it", () => {
		withProject(
			{
				"Main.es": `import {
	Rectangle from "./Geometry.es"
	Circle from "./Geometry.es"
}

${moduleProgram()}
export {
	Square from "./Geometry.es"
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

	// NOTE: A cycle is one group, because nothing in it can be enriched before
	// the rest of it — the hoisting pass has to see every Module in the group at
	// once. Which member runs first is not something the source states, which is
	// why the group is the unit rather than an order inside it.
	it("groups a cycle into one Strongly Connected Component", () => {
		withProject(
			{
				"A.es": `import {
	b from "./B.es"
}

${moduleProgram()}`,
				"B.es": `import {
	a from "./A.es"
	leaf from "./Leaf.es"
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

				// NOTE: The flattened order is the groups in order — a Module
				// inside a cycle is not ahead of the ones it imports, and cannot
				// be.
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
	b from "./B.es"
}

${moduleProgram()}`,
				"B.es": `import {
	c from "./C.es"
}

${moduleProgram()}`,
				"C.es": `import {
	a from "./A.es"
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

	// NOTE: Per Module, because the dedup key is severity, code, message and
	// Position with NO file in it — two Modules with the same mistake on the
	// same line are two Diagnostics, and one shared collection would report the
	// first and swallow the second.
	it("keeps each Module's parse Diagnostics on that Module", () => {
		withProject(
			{
				"Main.es": `import {
	broken from "./Broken.es"
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

				// NOTE: The source each Diagnostic is rendered against travels
				// with the Module — a report about a dependency is printed
				// against the dependency's own text.
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
	Rectangle from "./Gone.es"
	Circle from "./Gone.es"
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

				// NOTE: Two entries, two Diagnostics — the second is not
				// deduplicated away, because each underlines its own specifier.
				expect(
					diagnostics.map((diagnostic) => diagnostic.code),
				).toEqual(["module-not-found", "module-not-found"])
				expect(diagnostics[0].message).toBe(
					"No Module was found at './Gone.es'",
				)
				expect(diagnostics[0].position).toEqual({
					start: { line: 2, column: 17 },
					end: { line: 2, column: 28 },
				})
				expect(diagnostics[0].labels).toHaveLength(1)
				expect(diagnostics[0].labels[0]?.kind).toBe("primary")
				expect(diagnostics[0].notes[0]).toContain(
					path.join(directory, "Gone.es"),
				)
				expect(diagnostics[1].position?.start.line).toBe(3)
			},
		)
	})

	it("reports every kind of specifier the resolver refuses", () => {
		withProject(
			{
				"Main.es": `import {
	Bare from "Geometry.es"
	Absolute from "/project/Geometry.es"
	Extensionless from "./Geometry"
	Own from "./Main.es"
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

				// NOTE: Nothing was reachable, so nothing else was loaded — a
				// refused specifier is not an edge.
				expect(
					moduleAt(directory, graph, "Main.es").dependencies,
				).toEqual([])
				expect(graph.modules.size).toBe(1)
			},
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
				`import {\n\tBoolean from "${specifier}"\n}\n\n${moduleProgram()}`,
			)

			let graph = loadModuleGraph(
				path.join(directory, "Main.es"),
				diskModuleHost,
			)
			let diagnostics = moduleAt(directory, graph, "Main.es").diagnostics

			expect(diagnostics.map((diagnostic) => diagnostic.code)).toEqual([
				"invalid-module-specifier",
			])
			expect(diagnostics[0].message).toBe(
				"The standard library is not importable",
			)
			expect(graph.modules.size).toBe(1)
		})
	})

	// NOTE: The entry has no Program to point a Diagnostic into, so this is the
	// one placeless report the stage makes — and the graph is empty rather than
	// half-built, because there is nothing to be half-built out of.
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

	// NOTE: One Module, reached twice. The graph is keyed by the canonical path,
	// so a symlinked spelling of a file is the file — not a second Module
	// declaring second Types of every name in it.
	it("binds one Module for a file reached through a symlink", () => {
		withProject(
			{
				"Main.es": `import {
	Rectangle from "./real/Geometry.es"
	Circle from "./link/Geometry.es"
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

					// NOTE: Both spellings answer with the one Module, so an
					// entry finds it under the specifier IT wrote.
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
					// NOTE: The link is unlinked first and on its own, before
					// anything recursive runs over the directory holding it.
					rmSync(link, { force: true })
				}
			},
		)
	})

	// NOTE: The Language Server's half of the host contract: a graph whose files
	// only ever existed in an Editor. Nothing here touches disk, and the entry
	// is a document that has never been saved.
	it("loads a graph entirely from a host that reads no files", () => {
		let directory = canonicalPath(
			path.join(tmpdir(), `essence-unsaved-${process.pid}`),
		)
		let host = memoryHost({
			[path.join(directory, "Main.es")]: `import {
	Rectangle from "./Geometry.es"
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
