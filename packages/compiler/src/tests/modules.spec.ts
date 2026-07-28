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
import { STDLIB_DIRECTORY } from "@essence-lang/stdlib"

import { bundle, type ModuleSources } from "../bundler/index"
import { containsErrors } from "../diagnostics/index"
import { loadModuleGraph, type Module } from "../modules/graph"
import { diskModuleHost, type ModuleHost } from "../modules/host"
import {
	type LinkedGraph,
	linkModuleGraph,
	type LinkedModule,
} from "../modules/link"
import { canonicalPath, resolveSpecifier } from "../modules/resolve"
import { optimise } from "../optimiser/index"
import { rewriteModules } from "../rewriter/index"
import { simplify } from "../simplifier/index"
import { validate } from "../validator/index"

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
		return work(writeProject(directory, files))
	} finally {
		rmSync(directory, { recursive: true, force: true })
	}
}

// NOTE: The same, for the tests that BUILD what they wrote — bundling and
// running are asynchronous, and a `finally` that removed the directory around a
// Promise would take the sources away while esbuild was still reading them.
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

// NOTE: The whole stage, entry in and one linked Module per file out — the graph
// and the linker are never used apart, and a test that ran only half of it would
// be testing an arrangement no caller makes.
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

	return module
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
	// NOTE: One entry carries its name across every table it is bound in, so a
	// `type Shape` and a Namespace `Shape` travel as one — which is what makes
	// `Shape.of(…)` and `shape: Shape` both work off a single import.
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

	// NOTE: Private by default. `hidden` is declared and reachable inside its own
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
	measure as area from "./Geometry.es"
}

implementation {
	__print(area(3)::toString())
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

	// NOTE: A facade never binds what it forwards — `Rectangle` is not in scope
	// inside `Facade.es` at all, and a chain of them still answers with the one
	// Type the declaring Module made.
	it("forwards a name through a chain of re-exports", () => {
		withProject(
			{
				"Main.es": `import {
	Shape from "./Facade.es"
}

implementation {
	function widthOf(_ shape: Shape) -> Integer {
		<- shape.width
	}

	__print(widthOf({ width = 2 })::toString())
}
`,
				"Facade.es": `implementation {}

export {
	Rectangle as Shape from "./Inner.es"
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
	hidden from "./Library.es"
	absent from "./Library.es"
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
					// NOTE: `absent` first, although `hidden` was written first
					// — the entries are read in canonical order.
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

	// NOTE: All three collisions are the one Diagnostic, because they are the one
	// mistake: the name an entry binds is taken. The entry is what gives way, so
	// whatever held the name still means what it did — a builtin stays the
	// builtin, and the local declaration is not reported as a duplicate of the
	// import that lost.
	it("refuses an import that shadows a builtin, a declaration or another import", () => {
		withProject(
			{
				"Main.es": `import {
	String from "./Library.es"
	local from "./Library.es"
	first from "./Library.es"
	second as first from "./Library.es"
}

implementation {
	function local() -> Integer {
		<- 0
	}

	__print(local()::toString())
	__print("literal"::append(""))
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
					// NOTE: The entry that loses is the one read LATER, which is
					// the aliased one — `first` itself binds, and `second as
					// first` is what collides with it.
					"'first' is already declared here",
				])
			},
		)
	})

	// NOTE: The Rewriter emits a Method call as `<Namespace name>.method(…)`, so
	// an alias has to reach the emitted code: the import binds a shallow copy of
	// the Namespace Type carrying the local name. The declaring Module's own copy
	// keeps its own name, which is what its emission needs.
	it("binds an aliased Namespace under the name the import gave it", () => {
		withProject(
			{
				"Main.es": `import {
	Measurable as Sizing from "./Geometry.es"
	Rectangle from "./Geometry.es"
}

implementation {
	function areaOf(_ shape: Rectangle) -> Integer {
		<- shape::area()
	}

	__print(areaOf({ width = 2, height = 3 })::toString())
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

	// NOTE: The single hoisting pass over the whole group, which is the only way
	// this resolves: `A` needs `halved` typed to type `averaged`, and `B` needs
	// `Amount` and `doubled` to type `halved`. Neither can go first, so the rounds
	// bind the entries as the declarations they name come up.
	it("enriches a cycle of hoistable declarations in one pass", () => {
		withProject(
			{
				"A.es": `import {
	halved from "./B.es"
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
	Amount from "./A.es"
	doubled from "./A.es"
}

implementation {
	function halved(_ amount: Amount) -> Amount {
		<- { cents = amount.cents::divide(by 2)::otherwise(0/1)::round(toward #TowardZero) }
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

	// NOTE: The one kind a cycle can not carry, because it is the one kind that
	// does not hoist — and it is genuinely broken at runtime, not merely
	// unsupported: the emitted binding is read in its temporal dead zone.
	it("refuses a Constant imported across a cycle", () => {
		withProject(
			{
				"A.es": `import {
	SCALE from "./B.es"
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
	scaled from "./A.es"
}

implementation {
	constant SCALE = 3

	function stepped(_ value: Integer) -> Integer {
		<- scaled(value)
	}
}

export {
	SCALE
	stepped
}
`,
			},
			(directory) => {
				let linked = linkProject(directory, "A.es")
				let a = linkedAt(directory, linked, "A.es")

				expect(reportsOf(a.diagnostics)).toEqual([
					[
						"cyclic-constant-import",
						"Constant 'SCALE' is imported across a cycle",
					],
				])

				// NOTE: The name is bound as an Error, so the body that reads it
				// is not a second Diagnostic about a name the Program does
				// declare.
				expect(a.diagnostics[0]?.notes[0]).toContain("./B.es")
				expect(linkedAt(directory, linked, "B.es").diagnostics).toEqual(
					[],
				)
			},
		)
	})

	// NOTE: The same Constant, imported from OUTSIDE a cycle, is ordinary — the
	// rule is about the cycle rather than about Constants.
	it("allows a Constant imported down a chain", () => {
		withProject(
			{
				"Main.es": `import {
	SCALE from "./Settings.es"
}

implementation {
	__print(SCALE::toString())
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
	fromB from "./B.es"
}

implementation {
	function fromA() -> Integer {
		<- 1
	}

	__print(fromB()::toString())
}

export {
	fromA
}
`,
				"B.es": `import {
	fromA from "./A.es"
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

				// NOTE: `B.es` declares and nothing more, so nothing there runs
				// in an order anyone could notice.
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
	kept from "./Library.es"
	unread from "./Library.es"
}

implementation {
	__print(kept()::toString())
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

	// NOTE: The case the check exists for. An imported Namespace used only through
	// `shape::area()` has no Identifier occurrence anywhere in the file — the only
	// trace of it is the Namespace name on the resolved Invocation, and reading
	// Identifiers alone would warn about the import that makes the call resolve.
	it("counts implicit dispatch as a use of an imported Namespace", () => {
		withProject(
			{
				"Main.es": `import {
	Measurable from "./Geometry.es"
	Rectangle from "./Geometry.es"
}

implementation {
	function areaOf(_ shape: Rectangle) -> Integer {
		<- shape::area()
	}

	__print(areaOf({ width = 2, height = 3 })::toString())
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

	// NOTE: A Type used only in an annotation leaves no Identifier in the TYPED
	// tree — the annotation resolved to a Type object — so the written tree has to
	// be read as well.
	it("counts an annotation as a use of an imported Type", () => {
		withProject(
			{
				"Main.es": `import {
	Rectangle from "./Geometry.es"
}

implementation {
	function widthOf(_ shape: Rectangle) -> Integer {
		<- shape.width
	}

	__print(widthOf({ width = 2 })::toString())
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

	it("refuses an export of a Variable and of a name the Module does not declare", () => {
		withProject(
			{
				"Main.es": `implementation {
	variable counter = 0

	__print(counter::toString())
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

	// NOTE: The canonical order — by specifier, then by name — rather than the
	// written one, which is exactly the order `esfmt` writes the block in. The
	// "searched Namespaces" listing is where that order is observable, and it is
	// the same order Completion dedupes members in.
	it("seeds imported Namespaces in canonical order, not written order", () => {
		withProject(
			{
				"Main.es": `import {
	Zulu from "./Zulu.es"
	Alpha from "./Alpha.es"
}

implementation {
	__print(2::missing()::toString())
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

				// NOTE: The builtins come first — they are the parent of every
				// import — and `Alpha` precedes `Zulu` although `Zulu` was
				// written first. Only the Namespaces an Integer can actually
				// reach are listed: `Optional` used to appear here as well,
				// because `Optional<ItemType>` was a Type Alias for
				// `ItemType | Nothing` and an Integer is a member of
				// `Integer | Nothing`. Now that `Optional` is a nominal Choice
				// an Integer is not one, so its Namespace is not searched.
				expect(unknownMethod?.notes[0]).toContain(
					"'Integer', 'Number', 'Alpha', 'Zulu'",
				)
			},
		)
	})

	// NOTE: The Diagnostic a forgotten Namespace import produces on its own says
	// only that no Method of that name exists, which is indistinguishable from a
	// typo. The graph knows better, and the help is what the auto-import Quick Fix
	// keys off.
	it("names the unimported Namespace and its Module in the no-such-Method help", () => {
		withProject(
			{
				"Main.es": `import {
	Rectangle from "./Geometry.es"
}

implementation {
	function areaOf(_ shape: Rectangle) -> Integer {
		<- shape::area()
	}

	__print(areaOf({ width = 2, height = 3 })::toString())
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
					"'Measurable' in ./Geometry.es declares 'area' for { width: Integer, height: Integer } — import it.",
				)
			},
		)
	})

	// NOTE: A single file compile has no graph at all, and its Diagnostics must be
	// the ones it always had — no help about a Namespace nobody could import.
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

	// NOTE: Per Module, because the dedup key is severity, code, message and
	// Position with NO file in it — the two files below make the same mistake on
	// the same line, and one shared collection would report the first and swallow
	// the second.
	it("attributes each Module's Diagnostics to that Module", () => {
		withProject(
			{
				"Main.es": `import {
	broken from "./Other.es"
}

implementation {
	constant wrong = missing

	__print(broken()::toString())
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

				// NOTE: The same code, the same message and the same Position in
				// both files — which is exactly what one shared collection would
				// deduplicate down to a single report.
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

	// NOTE: An entry naming something that IS exported and could not be typed
	// binds an Error rather than nothing. The Module that declares it has said
	// what is wrong with it; leaving the name unbound would bury that under one
	// `unknown-name` per use, in a file whose author can see the import written
	// at the top.
	it("stays quiet about an import whose declaration the other Module could not type", () => {
		withProject(
			{
				"Main.es": `import {
	broken from "./Other.es"
}

implementation {
	__print(broken()::toString())
	__print(broken()::toString())
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

	// NOTE: What the Module's canonical path is FOR: a Choice takes its nominal
	// identity from the Module that declares it, so two files each declaring
	// `choice Result` declare two Types — and linking is where that path is
	// supplied. Without it the two would be interchangeable at compile time and
	// carry the same runtime tag, and `is` would confuse them with no Diagnostic
	// anywhere.
	it("identifies a Choice by the Module that declares it", () => {
		withProject(
			{
				"Main.es": `import {
	Result as Theirs from "./Other.es"
}

implementation {
	choice Result {
		Ok
	}

	function take(_ value: Theirs) -> Boolean {
		<- true
	}

	constant mine: Result = #Ok

	__print(take(mine)::toString())
}
`,
				"Other.es": `implementation {
	choice Result {
		Ok
	}
}

export {
	Result
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

				// NOTE: Same spelling, same Case, two Types — because the two
				// declarations are in two Modules. Unqualified they would be
				// interchangeable here AND carry the same runtime tag. A free
				// Function's Arguments are the Validator's stage, which is a
				// stage linking does not run: it links, and the caller decides
				// what to run over what came back.
				expect(codesOf(validate(main.program))).toEqual([
					"argument-type-mismatch",
				])
			},
		)
	})

	// NOTE: The fixtures the rest of the Modules work is verified against, linked
	// end to end — five files, a cycle among them, every Diagnostic stage run.
	// They are the one Module Programs in the repository that are meant to be
	// clean, so this is where "clean" is pinned.
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

// NOTE: Every Module of a linked graph, through the stages the CLI runs after
// linking. A Module that reported anything fails HERE, naming itself, rather
// than emitting JavaScript nobody can account for.
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

// NOTE: Bundles the whole graph and imports the result, so its top-level
// `__print` calls run — the same shape `fixtureSweep.spec.ts` uses for a lone
// Program. The bundle is standalone: the runtime is inlined into it, so it runs
// from wherever it is written.
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

	let output: Array<string> = []
	let originalLog = console.log

	console.log = (...args: Array<unknown>) => {
		output.push(args.map((argument) => String(argument)).join(" "))
	}

	try {
		await import(file)
	} finally {
		console.log = originalLog
	}

	return output
}

describe("Module Code Generation", () => {
	// NOTE: The end of the road for the fixtures: five files, a cycle among
	// them, an aliased Constant, a re-export and a Namespace reached only
	// through implicit dispatch — compiled into ONE standalone bundle and run.
	// The three lines are the ones the fixture annotates itself with.
	it("compiles the Module fixtures into one bundle and runs it", async () => {
		let linked = linkModuleGraph(
			loadModuleGraph(fixturePath("modules", "Main.es"), diskModuleHost),
		)
		let sources = generateModules(linked)

		// NOTE: A rename travels as an ESM `as`, on either side — the emitted
		// name is always the one the DECLARATION wrote, so the two Modules
		// agree without either having to know what the other called it.
		expect(sources.sources.get("essence:./math/Math.es")).toContain(
			"squared as square",
		)
		expect(sources.sources.get("essence:./Main.es")).toContain("PI as Pi")

		// NOTE: A re-export is forwarded straight from the Module it names, not
		// bound here and exported again: `Rectangle` is never a binding of
		// `Main.es`.
		expect(sources.sources.get("essence:./Main.es")).toContain(
			'} from "essence:./Geometry.es"',
		)

		await withBuiltProject({}, async (directory) => {
			expect(await runBundle(sources, directory)).toEqual([
				'"area: 12"',
				'"25"',
				'"157/1"',
			])
		})
	})

	// NOTE: A Module whose every exported name ERASES still has to run. There
	// is nothing to import from it — a Type Alias is no binding — so the edge
	// that orders the two bodies would be gone with it, and the dependency
	// would run wherever the bundler happened to place it, or not at all. A
	// bare `import "…"` is what keeps it.
	it("runs a Module it imports nothing bindable from", async () => {
		await withBuiltProject(
			{
				"Main.es": `import {
	Amount from "./Dep.es"
}

implementation {
	function total(_ amount: Amount) -> Integer {
		<- amount.cents
	}

	__print(total({ cents = 7 })::toString())
}
`,
				"Dep.es": `implementation {
	__print("Dep")

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

	// NOTE: A Module body runs ONCE, on first import, however many Modules
	// reach it — which is what an emitted ESM graph gives for free and a
	// concatenation of the bodies would not. The diamond is what makes it
	// observable: `Shared.es` is named by both arms and by the entry, and its
	// line appears once, ahead of everything that imports it.
	it("runs a Module body once however many Modules import it", async () => {
		await withBuiltProject(
			{
				"Main.es": `import {
	left  from "./Left.es"
	right from "./Right.es"
}

implementation {
	__print("Main")
	__print(left()::add(right())::toString())
}
`,
				"Left.es": `import {
	shared from "./Shared.es"
}

implementation {
	__print("Left")

	function left() -> Integer {
		<- shared()
	}
}

export {
	left
}
`,
				"Right.es": `import {
	shared from "./Shared.es"
}

implementation {
	__print("Right")

	function right() -> Integer {
		<- shared()::multiply(with 2)
	}
}

export {
	right
}
`,
				"Shared.es": `implementation {
	__print("Shared")

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

	// NOTE: What the Module-qualified nominal identity buys, run rather than
	// type checked: two Modules each declaring `choice Colour { Red, Green }`
	// are two Types, so a value of one must not be claimed by a check written
	// for the other. Unqualified they carried the same runtime tag, and this
	// Program printed "mine" twice with no Diagnostic anywhere.
	//
	// NOTE: The check is `$type.isValueOfType` against the emitted Case
	// descriptors, which is the same comparison an `is` makes — and the one
	// place the tag a value was stamped with and the tag a descriptor names have
	// to agree, both being rendered against the entry's directory.
	it("keeps two Modules' same-named Choices apart at run time", async () => {
		await withBuiltProject(
			{
				"Main.es": `import {
	Colour as Theirs from "./Other.es"
	theirRed         from "./Other.es"
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

	__print(describe(mine))
	__print(describe(theirRed))
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

				// NOTE: The two tags differ by the Module they were declared
				// in, and neither names the machine that compiled.
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
})
