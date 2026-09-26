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

	// NOTE: Two entries naming one Module are one dependency and one entry in
	// the resolution table, keyed by the specifier as written — which is what an
	// Import or Export entry has in hand when it goes looking for the Module it
	// named.
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

	// NOTE: A cycle is one group, because nothing in it can be enriched before
	// the rest of it — the hoisting pass has to see every Module in the group at
	// once. Which member runs first is not something the source states, which is
	// why the group is the unit rather than an order inside it.
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

	// NOTE: Per Module, because the dedup key is severity, code, message and
	// Position with NO file in it — two Modules with the same mistake on the
	// same line are two Diagnostics, and one shared collection would report the
	// first and swallow the second.
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

				// NOTE: Two groups, two Diagnostics — one per specifier written,
				// however many names the group holds, and the second is not
				// deduplicated away, because each underlines its own specifier.
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

				// NOTE: Nothing was reachable, so nothing else was loaded — a
				// refused specifier is not an edge.
				expect(
					moduleAt(directory, graph, "Main.es").dependencies,
				).toEqual([])
				expect(graph.modules.size).toBe(1)
			},
		)
	})

	// NOTE: Appending '.es' is an answer for exactly one of the shapes that
	// reaches this report. A specifier already carrying an extension names a
	// file of another kind, and './clock.js.es' is a file nobody has — so the
	// Help says what is true and spells no edit, which is also what keeps the
	// Editor from offering one: `moduleSpecifierActions` reads the fix back out
	// of the Help text.
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

		// NOTE: One edit, one Diagnostic. A package specifier only told to begin
		// with './' is sent to `./lodash`, which is refused a second time for
		// the extension — so both halves of the path are named at once and what
		// follows the edit is `module-not-found`, a different thing to know.
		expect(helpFor("lodash")).toBe(
			"Write the path from this Module to the file, beginning with './' or '../' and ending in '.es'.",
		)
	})

	// NOTE: "Remove the entry" loops on both of these: they are reported on the
	// SPECIFIER, and an entry in this language is a NAME — a reader who deletes
	// one is left with the same group and the same report. The export side wants
	// the opposite edit besides, because the Module DECLARES those names and
	// dropping the group would take its whole public surface with it.
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
				`import {\n\tfrom "./Main.es" { area }\n}\n\n${moduleProgram()}`,
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
			// NOTE: The group, for the reason the two above are: deleting the
			// one name this entry asks for leaves `from "…" { }` behind and
			// reports the very same thing again.
			expect(diagnostics[0].helps[0]).toBe(
				`Remove the whole 'from "${specifier}" { … }' group — every name it asks for is a builtin.`,
			)
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

	expectNoPathShown(module.diagnostics, directory)

	return module
}

// NOTE: One Module's Diagnostics once the whole graph has been analysed, which
// is where the Validator has run over it too.
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

// NOTE: A Protocol's identity carries its Module's path, and neither what a
// reader is shown nor a name a fix writes may. `data.modulePath` is the
// canonical path by design.
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

	// NOTE: A facade never binds what it forwards — `Rectangle` is not in scope
	// inside `Facade.es` at all, and a chain of them still answers with the one
	// Type the declaring Module made.
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

	// NOTE: Three shapes, three answers. A declaration the block publishes under
	// ANOTHER name is asked for by that name — adding this one would publish one
	// function twice. A Module publishing nothing has no block to add to. And a
	// name that is no declaration at all is a near miss against what the Module
	// really exports, which nothing but the linker holds.
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
			"./Library.es exports it as 'squareArea' — import that name instead.",
		])

		expect(helpsFor("\nexport {}\n", "area")).toEqual([
			"Open an 'export { … }' block in ./Library.es and list 'area' in it.",
		])

		expect(helpsFor("\nexport {\n\tarea\n}\n", "aera")).toEqual([
			"Did you mean 'area'?",
			"Check the spelling, and that the specifier names the file you meant.",
		])
	})

	// NOTE: And the Note says the `as` rule out loud where that rule is the
	// answer — a reader looking at a block that plainly lists the declaration
	// has no other way of knowing why it is still private here. A block that
	// simply leaves the name out gets the one Note it always had.
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

	// NOTE: All three collisions are the one Diagnostic, because they are the one
	// mistake: the name an entry binds is taken. The entry is what gives way, so
	// whatever held the name still means what it did — a builtin stays the
	// builtin, and the local declaration is not reported as a duplicate of the
	// import that lost.
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

	// NOTE: The single hoisting pass over the whole group, which is the only way
	// this resolves: `A` needs `halved` typed to type `averaged`, and `B` needs
	// `Amount` and `doubled` to type `halved`. Neither can go first, so the rounds
	// bind the entries as the declarations they name come up.
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

	// NOTE: The shape every checked refinement is written in — a `type` and the
	// `namespace` targeting it, under ONE name — carried across a cycle. The two
	// halves do not hoist in the same round: the refined Alias hoists as a
	// skeleton, and the Namespace lands only once the predicate has been filled.
	// A cycle seeds its imports between rounds, so an entry that bound whatever
	// was in Scope and called itself done kept the Type and never saw the
	// Namespace. What pins it is the ANSWER rather than the Type: `marked()` is
	// declared on `Balanced` alone, so a Module holding only the Type reports
	// that no Method of that name was found and falls to `Integer`.
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

	// NOTE: `Fits` is read once `Fitting` is bound in `B.es`, and reading it
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

	// NOTE: `Five` is read through the body of `fitsFive`, which waits on
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

	// NOTE: The one kind a cycle can not carry, because it is the one kind that
	// does not hoist — and it is genuinely broken at runtime, not merely
	// unsupported: the emitted binding is read in its temporal dead zone.
	it("refuses a Constant imported across a cycle", () => {
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

	// NOTE: And silent about a Module the Parser did not read whole. Every use
	// the check counts is read off a tree, and a Statement the recovery dropped
	// is in neither of them — so the one line reading an import can go missing
	// and leave the entry looking unread. It only became reachable once the
	// Enricher started running over a Program the Parser had reported on.
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

	// NOTE: And the other side of that stand-down. A Recovery is also written
	// for a refused Pattern binder, which abandons a NAME while the Matcher
	// around it parses whole — no text went missing, so every line that reads an
	// import is still there to be counted. Asking whether the RECORD existed
	// switched the Warning off for a Module the Parser read from end to end.
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

	// NOTE: The case the check exists for. An imported Namespace used only through
	// `shape::area()` has no Identifier occurrence anywhere in the file — the only
	// trace of it is the Namespace name on the resolved Invocation, and reading
	// Identifiers alone would warn about the import that makes the call resolve.
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

	// NOTE: A Type used only in an annotation leaves no Identifier in the TYPED
	// tree — the annotation resolved to a Type object — so the written tree has to
	// be read as well.
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

	// NOTE: The shape the Warning used to be WRONG about. `Problem` is written
	// nowhere in `Main.es` but the import entry: it reaches the file as a Type
	// ARGUMENT of an imported Function's answer, and the `::is` below derives
	// its Equatable off the Choice — which `choiceTypeOf` finds by looking the
	// name up in THIS Module's Scope. Remove the entry the Warning asked to
	// remove and the file stops compiling, which is the one thing an
	// `unnecessary` tag and a preferred "remove it" fix may never be attached
	// to.
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

	// NOTE: And the other side of it — a Type import nothing in the file reads,
	// through an annotation or through a resolved Type, is still reported. The
	// rule above over-collects on purpose, and this is what says it does not
	// over-collect everything.
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

	// NOTE: And the shape it was wrong about in the OTHER direction. A Type
	// whose values merely flow through the file — `make()` answers a `Standing`
	// and nothing here ever names one — was counted as a use, because every
	// resolved Type object anywhere in either tree carries a name and the rule
	// above read all of them. Nothing derives a conformance off `Standing`, so
	// removing the entry compiles, and an import a reader can delete is exactly
	// what this Warning is for.
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

	// NOTE: Nothing writes to `counter` above, so rewriting the Declaration is a
	// real answer and the Help offers it. The moment something does, it stops
	// being one: `constant-reassignment` answers every assignment and asks for
	// the `variable` back, which closes a loop between the two codes with the
	// Quick Fix as its only door. The clause is withheld rather than reworded,
	// and the fix reads this text back, so withholding it withholds the fix.
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

		// NOTE: Inside a Function body, which is an assignment as much as one at
		// the top level is — and the shape a Module that publishes a counter
		// actually has.
		expect(
			helpsFor(
				"\tfunction bump() -> Integer {\n\t\tcounter = counter::add(1)\n\t\t<- counter\n\t}\n",
			),
		).toEqual(["Export a Function that answers with its value."])
	})

	// NOTE: A `from "…" { … }` group is an answer only where there is something
	// to forward FROM — and then the specifier is in hand, so it is spelled
	// rather than left as a `…` the reader has to fill from nowhere.
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

				// NOTE: No Module in reach declares it, so forwarding would name
				// a file that does not exist.
				expect(diagnostics[1]?.helps).toEqual([
					"Declare 'nowhere' in this Module, or remove the entry.",
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

				// NOTE: The builtins come first — they are the parent of every
				// import — and `Alpha` precedes `Zulu` although `Zulu` was
				// written first. Only the Namespaces an Integer can actually
				// reach are listed: `Optional` used to appear here as well,
				// because `Optional<ItemType>` was a Type Alias for
				// `ItemType | Nothing` and an Integer is a member of
				// `Integer | Nothing`. Now that `Optional` is a nominal Choice
				// an Integer is not one, so its Namespace is not searched.
				//
				// NOTE: The receiver is a written `2`, which proves it is
				// neither zero nor negative — so the refined Namespaces are in
				// the search too, in the same table order the rest are in.
				// `Scalar` and `Number` are the two Union Namespaces an Integer
				// is a member of, and they come after the Integer ones for the
				// reason `builtinMemberOrder` gives.
				expect(unknownMethod?.notes[0]).toContain(
					"'Integer', 'NonZeroInteger', 'NonNegativeInteger', 'PositiveInteger', 'Scalar', 'Number', 'Alpha', 'Zulu'",
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

	// NOTE: `Main.es` binds no name for either Protocol, so the registry is the
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

	// NOTE: `measure` is bounded by `Sized`, and `IntegerSized` is what makes an
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

	// NOTE: `measure`'s bound is the Protocol `Sized.es` resolved, so `Main.es`
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

	// NOTE: `Big`'s body asks for `extra`, which a witness for `Sized` does not
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

	// NOTE: `Ranked`'s body hands the `Self` its Function literal is given to
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

	// NOTE: `B.es` restates the `z` of `A.es`'s Protocol with another Type and is
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

	// NOTE: `Halved` provides a `z` answering a Number and `Counted` one
	// answering an Integer, and `Main.es` hands a value bounded by an extension
	// of one or both on to a bound on `Halved`.
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

	// NOTE: `Other.es` declares a `Sized` of its own, which the graph reaches
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

	// NOTE: A `where` condition is solved in the caller's Scope under the
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

	// NOTE: `Main.es` declares the bound itself without importing `Sized`, which
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

	// NOTE: `outer`'s own bound is refused where it is written, so its `Item`
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
				).toEqual([
					"unused-import",
					"unused-import",
					"unknown-protocol",
				])
			},
		)
	})

	// NOTE: A bound is resolved where it is written, so `Main.es` has to import a
	// Protocol it names itself, and the Module that declares one is the answer.
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

	// NOTE: An import under the declared name would collide with the Type this
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

	// NOTE: `Measure.es` bounds `measure` by a `Sized` it never imported, which
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

	// NOTE: The same for a `where` condition: `Sized.es` names a `Weighed` it
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

	// NOTE: `Measurable` is only how `Measure.es` spells the `Sized` that
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

	// NOTE: Per Module, because the dedup key is severity, code, message and
	// Position with NO file in it — the two files below make the same mistake on
	// the same line, and one shared collection would report the first and swallow
	// the second.
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

	// NOTE: A facade that only forwards names did not compile when what it
	// forwards did not, so the file importing it through the facade is told so.
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

	// NOTE: Every file on the chain is told about the one import it can follow
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

	// NOTE: `Loop.es` is the broken one. Its failure comes back to it round the
	// cycle through `Circle.es`, which is no second mistake for it to fix, while
	// the file importing the cycle from above is told.
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

	// NOTE: `Ping.es` fails only because `Pong.es` does, so `Pong.es` is told
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

	// NOTE: What the Module's canonical path is FOR: a Choice takes its nominal
	// identity from the Module that declares it, so two files each declaring
	// `choice Outcome` declare two Types — and linking is where that path is
	// supplied. Without it the two would be interchangeable at compile time and
	// carry the same runtime tag, and `is` would confuse them with no Diagnostic
	// anywhere.
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
// `Terminal` calls run — the same shape `fixtureSweep.spec.ts` uses for a lone
// Program, and both doors are held for the same reason: `inspect` ends its line
// through `console.log`, `print` writes its own to the stream, and a harness
// holding one of the two reads half a Program as silent. The bundle is
// standalone: the runtime is inlined into it, so it runs from wherever it is
// written.
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
				"area: 12",
				"25",
				"157",
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

	// NOTE: A Protocol's PROVIDED Method is one const for the whole graph, and
	// it belongs in the shared prelude Module for the reason a standard library
	// Method does: a copy per Module would be a bundle carrying as many
	// `describe` bodies as there are Modules that reach it. Two Modules conform
	// here and a third calls, so the const is reached from two files and
	// declared in neither.
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
					(source) => source.includes("$es_Shape__describe ="),
				)

				expect(declarations).toHaveLength(1)
				expect(sources.sources.get("essence:./Main.es")).toContain(
					"$es_Shape__describe",
				)
				expect(await runBundle(sources, directory)).toEqual([
					'"area 9"',
					'"area 4"',
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

	// NOTE: The reason a Case payload's default travels on the Case Type, and the
	// reason it is held to a literal: the merge happens where the Case is BUILT,
	// and that may be a Module that never named the Choice — `Main.es` below
	// imports one Function and no Type at all. There is no import to hang a value
	// off, so a default that read a name would read one that is not there.
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

				// NOTE: The filled member is emitted INTO the construction, in
				// the Module that wrote it — the only import is the Function,
				// and the default's `0` is pooled with `Main.es`'s own
				// constants, which is what a copy per site buys.
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

	// NOTE: What a path key reaches into is a fact about the DEFAULT, so it has
	// to travel the way every other fact about one does — on the Type. A Module
	// that merges into a default declared elsewhere is the only place that can
	// go wrong, and it is the place a Record Parameter's merge happens at the
	// callee while a Case payload's happens at the construction.
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

	// NOTE: A Case payload default may name a Constant of the Module the Choice
	// is declared in, and what travels is the VALUE — resolved there, baked into
	// the Case Type as data. This is the test that says so: the Module that
	// constructs the Case imports the Choice and never the Constant, and gets the
	// Constant's value all the same.
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

				// NOTE: `Fetch#Get`, with no Module in front of it. The tag
				// carries the Module that declares the Choice and a structural
				// rendering no longer prints it — see `caseText` in the
				// runtime's `registry.ts`. What this test is about is the baked
				// default, which is the `headers` member.
				expect(await runBundle(sources, directory)).toEqual([
					'Fetch#Get { url = "/x", headers = [ "Accept" ] }',
				])
			},
		)
	})

	// NOTE: The other direction, and the reason the rule is written about the
	// DECLARING Module: a Type crosses an import edge, an Expression does not, so
	// the Module writing the Choice has the imported Constant's Type in hand and
	// nothing to bake.
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

// NOTE: A provided Method is emitted once, in the bundle's band above every
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

	// NOTE: `X`'s body answers `R`'s `m() -> String` with an Integer, so `Y`'s
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

	// NOTE: A Namespace a Function literal declares is a class of the literal's
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

// NOTE: A Protocol is known by the Module that declares it and its name. An
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

	// NOTE: `Main.es` meets `measure`'s bound only through its own `Sized`,
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

	// NOTE: Two names for one Protocol offer its provided Method once.
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

	// NOTE: `Sized.es` names `Sized` from a cycle partner, whose import is bound
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

	// NOTE: `IntegerSized` is what meets `measure`'s bound, and `Main.es`'s own
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

	// NOTE: `Main.es` and `Sized.es` import each other, which is what the one
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

	// NOTE: `Item` carries the `Sized` that `SizedBox` demands, private to
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

	// NOTE: The witness `Main.es` hands `big` carries `isBig`, which `Sized`
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
					"Import 'Sized' under a name of its own, 'Sized as …' — this value conforms to it, and the 'Sized' named here is a different Protocol.",
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
					"Import 'Sized' under a name of its own, 'Sized as …' — this value conforms to it, and this file binds 'Sized' already.",
				])
			},
		)
	})
})
