import { describe, expect, it } from "bun:test"
import { readdirSync, readFileSync } from "node:fs"
import * as path from "node:path"

import { containsErrors } from "../diagnostics/index"
import { renderDiagnostics } from "../diagnostics/render"
import { enrich } from "../enricher/index"
import type { common } from "../interfaces/index"
import { parseWithDiagnostics } from "../parser/index"
import { validate } from "../validator/index"

// NOTE: The files in `testFiles/diagnostics/` are deliberately broken — they
// are the one place where the Compiler's error output can be read end to end.
// Snapshotting it here is what keeps it that way: a Diagnostic that loses its
// labels, its notes or its code shows up as a snapshot diff rather than as
// output nobody looked at.

const SHOWCASE_DIRECTORY = path.join(
	import.meta.dir,
	"..",
	"..",
	"testFiles",
	"diagnostics",
)

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
				expect(containsErrors(diagnostics)).toBe(true)
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
