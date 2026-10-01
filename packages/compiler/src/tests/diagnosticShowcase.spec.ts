import { describe, expect, it } from "bun:test"
import { readdirSync, readFileSync } from "node:fs"
import * as path from "node:path"

import { fixturePath } from "@essence-lang/fixtures"
import type { common } from "@essence-lang/interfaces"

import { analyseSource } from "../analysis"
import { renderDiagnostics } from "../diagnostics/render"
import { loadModuleGraph } from "../modules/graph"
import { diskModuleHost } from "../modules/host"
import { linkModuleGraph } from "../modules/link"

// The files in `packages/fixtures/files/diagnostics/` are deliberately broken,
// so the Compiler's error output can be read end to end. A Diagnostic that
// loses its labels, notes or code shows up as a snapshot diff.

const SHOWCASE_DIRECTORY = fixturePath("diagnostics")

// The shared analysis the command line and the Editor run, with the tests as
// `essence test` asks for. A file without a `tests { … }` block is unaffected.
function analyse(source: string): Array<common.Diagnostic> {
	return analyseSource(source, undefined, { tests: true }).diagnostics
}

// A file may showcase several stages at once, because each stage runs
// whatever the one before it found. `Staged.es` does.
let showcaseFiles = readdirSync(SHOWCASE_DIRECTORY)
	.filter((fileName) => fileName.endsWith(".es"))
	.sort()

describe("Diagnostic Showcase", () => {
	it("should have showcase files", () => {
		expect(showcaseFiles.length).toBeGreaterThan(0)
	})

	for (let fileName of showcaseFiles) {
		describe(fileName, () => {
			let source = readFileSync(
				path.join(SHOWCASE_DIRECTORY, fileName),
				"utf8",
			)
			let diagnostics = analyse(source)

			it("should stay broken", () => {
				// Diagnostics rather than errors, because a showcase such as
				// `Documentation.es` may be Warnings throughout. The snapshot
				// pins each severity.
				expect(diagnostics.length).toBeGreaterThan(0)
			})

			it("should give every Diagnostic a code and a labelled span", () => {
				for (let diagnostic of diagnostics) {
					expect(diagnostic.code).toBeString()
					expect(diagnostic.position).not.toBeNull()
					expect(diagnostic.labels?.length ?? 0).toBeGreaterThan(0)
				}
			})

			it("should render the same report every time", () => {
				expect(
					renderDiagnostics(diagnostics, source, fileName, {
						color: false,
					}),
				).toMatchSnapshot()
			})
		})
	}
})

// A Module Diagnostic takes more than one file to provoke, so these showcases
// go through the graph and the linker. Each Module is rendered against its own
// source.
const MODULE_SHOWCASES: Array<{ entry: string; reports: Array<string> }> = [
	{
		entry: "Main.es",
		reports: ["Shapes.es", "Main.es"],
	},
	// A cycle is one group with no order inside it, so the entry is not last.
	{
		entry: "Ping.es",
		reports: ["Ping.es", "Pong.es"],
	},
	// The import block alone earns three refusals: a name asked of its own
	// Module, an undeclared name, and a name asked for twice. All are reported
	// in the importing file.
	{
		entry: "Mirror.es",
		reports: ["Shapes.es", "Mirror.es"],
	},
]

describe("Module Diagnostic Showcase", () => {
	for (let showcase of MODULE_SHOWCASES) {
		describe(showcase.entry, () => {
			let graph = loadModuleGraph(
				fixturePath("diagnostics", "modules", showcase.entry),
				diskModuleHost,
			)
			let linked = linkModuleGraph(graph)
			let modules = [...linked.modules.values()]

			it("should reach every Module of the showcase", () => {
				expect(
					modules.map((module) =>
						path.basename(module.module.filePath),
					),
				).toEqual(showcase.reports)
			})

			it("should stay broken", () => {
				expect(
					modules.flatMap((module) => module.diagnostics).length,
				).toBeGreaterThan(0)
			})

			it("should give every Diagnostic a code and a labelled span", () => {
				for (let module of modules) {
					for (let diagnostic of module.diagnostics) {
						expect(diagnostic.code).toBeString()
						expect(diagnostic.position).not.toBeNull()
						expect(diagnostic.labels?.length ?? 0).toBeGreaterThan(
							0,
						)
					}
				}
			})

			// No absolute path may appear in a report: it would differ on every
			// machine that compiled it.
			it("should render the same report every time", () => {
				for (let module of modules) {
					let fileName = path.basename(module.module.filePath)
					let report = renderDiagnostics(
						module.diagnostics,
						module.module.sourceText,
						fileName,
						{ color: false },
					)

					expect(report).not.toContain(fixturePath())
					expect(report).toMatchSnapshot(fileName)
				}
			})
		})
	}
})
