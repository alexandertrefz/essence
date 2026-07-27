import { describe, expect, it } from "bun:test"
import { readdirSync, readFileSync } from "node:fs"
import * as path from "node:path"

import { fixturePath } from "@essence/fixtures"
import type { common } from "@essence/interfaces"

import { containsErrors } from "../diagnostics/index"
import { renderDiagnostics } from "../diagnostics/render"
import { enrich } from "../enricher/index"
import { loadModuleGraph } from "../modules/graph"
import { diskModuleHost } from "../modules/host"
import { linkModuleGraph } from "../modules/link"
import { parseWithDiagnostics } from "../parser/index"
import { validate } from "../validator/index"

// NOTE: The files in `packages/fixtures/files/diagnostics/` are deliberately
// broken — they are the one place where the Compiler's error output can be
// read end to end. Snapshotting it here is what keeps it that way: a
// Diagnostic that loses its labels, its notes or its code shows up as a
// snapshot diff rather than as output nobody looked at.

const SHOWCASE_DIRECTORY = fixturePath("diagnostics")

function analyse(source: string): Array<common.Diagnostic> {
	let { program, diagnostics: parserDiagnostics } =
		parseWithDiagnostics(source)

	if (containsErrors(parserDiagnostics)) {
		return parserDiagnostics
	}

	let { program: enriched, diagnostics: enricherDiagnostics } =
		enrich(program)
	let diagnostics = [...parserDiagnostics, ...enricherDiagnostics]

	if (containsErrors(enricherDiagnostics)) {
		return diagnostics
	}

	return [...diagnostics, ...validate(enriched)]
}

// NOTE: One file per Compiler stage — the Enricher never runs when the Parser
// reported errors, and the Validator never runs when the Enricher did, so a
// single file could only ever showcase the earliest stage that fails in it.
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
				// NOTE: The file exists to produce Diagnostics. A clean run
				// means the showcase quietly stopped showcasing anything.
				// Diagnostics rather than errors, because a showcase may be
				// Warnings throughout — `Documentation.es` is, since a `§§`
				// block that describes the wrong thing still compiles. The
				// snapshot below pins each severity, so a file that decays
				// from an error to a Warning is still a diff.
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

// NOTE: The Module showcases sit in a subdirectory of their own, because a
// Module Diagnostic takes more than one file to provoke: a name is only
// `not-exported` relative to the Module that kept it private. They are reached
// through the graph and the linker rather than through `enrich`, which is the
// only way an entry resolves to anything at all, and every Module the entry
// reaches is rendered against its own source — the report a reader gets.
const MODULE_SHOWCASES: Array<{ entry: string; reports: Array<string> }> = [
	{
		entry: "Main.es",
		reports: ["Shapes.es", "Main.es"],
	},
	// NOTE: The two of them are one group, and a group has no order inside it —
	// the entry is not last here, because nothing in a cycle is behind the rest
	// of it.
	{
		entry: "Ping.es",
		reports: ["Ping.es", "Pong.es"],
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

			// NOTE: No absolute path may appear in a report — a canonical path
			// names a place on the machine that compiled, so a Diagnostic
			// carrying one would read differently for every reader, and this
			// snapshot could not be committed at all.
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
