import { describe, expect, it } from "bun:test"
import { readFileSync } from "node:fs"
import * as path from "node:path"

import { containsErrors } from "../diagnostics/index"
import { renderDiagnostics } from "../diagnostics/render"
import { enrich } from "../enricher/index"
import type { common } from "../interfaces/index"
import { parseWithDiagnostics } from "../parser/index"
import { validate } from "../validator/index"

// NOTE: `testFiles/diagnostics/Showcase.es` is deliberately broken — it is
// the one place where the Compiler's error output can be read end to end.
// Snapshotting it here is what keeps it that way: a Diagnostic that loses its
// labels, its notes or its code shows up as a snapshot diff rather than as
// output nobody looked at.

const SHOWCASE = path.join(
	import.meta.dir,
	"..",
	"..",
	"testFiles",
	"diagnostics",
	"Showcase.es",
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

describe("Diagnostic Showcase", () => {
	let source = readFileSync(SHOWCASE, "utf8")
	let diagnostics = analyse(source)

	it("should stay broken", () => {
		// NOTE: The file exists to produce Diagnostics. A clean run means the
		// showcase quietly stopped showcasing anything.
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
			renderDiagnostics(diagnostics, source, "Showcase.es", {
				color: false,
			}),
		).toMatchSnapshot()
	})
})
