import { containsErrors } from "../diagnostics"
import { enrich } from "../enricher"
import type { common } from "../interfaces"
import { parseWithDiagnostics } from "../parser"
import { validate } from "../validator"

// NOTE: The pipeline stages are fault-tolerant, so parsing and enrichment
// always run — broken statements are dropped from the AST, and the remaining
// Program is still analysed. Validation only runs when the Enricher reported
// no errors, since the Validator relies on a fully enriched Program.
export function analyse(source: string): Array<common.Diagnostic> {
	try {
		let { program, diagnostics: parserDiagnostics } =
			parseWithDiagnostics(source)

		let { program: enrichedProgram, diagnostics: enricherDiagnostics } =
			enrich(program)

		let diagnostics = [...parserDiagnostics, ...enricherDiagnostics]

		if (!containsErrors(enricherDiagnostics)) {
			diagnostics.push(...validate(enrichedProgram))
		}

		return diagnostics
	} catch (error) {
		// NOTE: A compiler bug must never take down the Language Server, so
		// any unexpected throw is surfaced as a single Diagnostic instead.
		return [
			{
				severity: "error",
				message: `Internal Compiler Error: ${
					error instanceof Error ? error.message : String(error)
				}`,
				position: null,
			},
		]
	}
}
