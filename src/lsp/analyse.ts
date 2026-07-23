import { containsErrors, placelessDiagnostic } from "../diagnostics/index"
import { enrichDocument, parseDocument } from "../documents"
import type { common } from "../interfaces/index"
import { validate } from "../validator/index"

// NOTE: The pipeline stages are fault-tolerant, so parsing and enrichment
// always run — broken statements are dropped from the AST, and the remaining
// Program is still analysed. Validation only runs when the Enricher reported
// no errors, since the Validator relies on a fully enriched Program.
// NOTE: `documentPath` is what tells a standard library source apart from an
// ordinary Program — see `./documents`. Absent, the document is an ordinary
// one, which is what every caller outside the Language Server is.
export function analyse(
	source: string,
	documentPath?: string,
): Array<common.Diagnostic> {
	try {
		let { program, diagnostics: parserDiagnostics } = parseDocument(
			source,
			documentPath,
		)

		let { program: enrichedProgram, diagnostics: enricherDiagnostics } =
			enrichDocument(program, documentPath)

		let diagnostics = [...parserDiagnostics, ...enricherDiagnostics]

		if (!containsErrors(enricherDiagnostics)) {
			diagnostics.push(...validate(enrichedProgram))
		}

		return diagnostics
	} catch (error) {
		// NOTE: A compiler bug must never take down the Language Server, so
		// any unexpected throw is surfaced as a single Diagnostic instead.
		return [
			placelessDiagnostic(
				"error",
				`Internal Compiler Error: ${
					error instanceof Error ? error.message : String(error)
				}`,
				"internal-error",
			),
		]
	}
}
