import {
	containsErrors,
	placelessDiagnostic,
} from "@essence/compiler/diagnostics"
import { enrichDocument, parseDocument } from "@essence/compiler/documents"
import { validate } from "@essence/compiler/validator"
import type { common, parser } from "@essence/interfaces"

// NOTE: Either Program is null when the stage that builds it threw — the
// Diagnostics then hold the Internal Compiler Error and nothing else.
export type Analysis = {
	program: parser.Program | null
	enrichedProgram: common.typed.Program | null
	diagnostics: Array<common.Diagnostic>
}

// NOTE: The pipeline stages are fault-tolerant, so parsing and enrichment
// always run — broken statements are dropped from the AST, and the remaining
// Program is still analysed. Validation only runs when the Enricher reported
// no errors, since the Validator relies on a fully enriched Program.
// NOTE: `documentPath` is what tells a standard library source apart from an
// ordinary Program — see `./documents`. Absent, the document is an ordinary
// one, which is what every caller outside the Language Server is.
// NOTE: The Programs are handed back as well as the Diagnostics, for the
// requests that answer with an edit rather than with a message: a Code Action
// reads the source's own Nodes, and running this pipeline twice for one
// request costs as much as the analysis itself.
export function analyseDocument(
	source: string,
	documentPath?: string,
): Analysis {
	let program: parser.Program | null = null
	let enrichedProgram: common.typed.Program | null = null

	try {
		let { program: parsedProgram, diagnostics: parserDiagnostics } =
			parseDocument(source, documentPath)

		program = parsedProgram

		let { program: typedProgram, diagnostics: enricherDiagnostics } =
			enrichDocument(parsedProgram, documentPath)

		enrichedProgram = typedProgram

		let diagnostics = [...parserDiagnostics, ...enricherDiagnostics]

		if (!containsErrors(enricherDiagnostics)) {
			diagnostics.push(...validate(typedProgram))
		}

		return { program, enrichedProgram, diagnostics }
	} catch (error) {
		// NOTE: A compiler bug must never take down the Language Server, so
		// any unexpected throw is surfaced as a single Diagnostic instead.
		// Whatever the stages before it produced is still handed back — a
		// throw out of the Validator does not make the Programs unusable.
		return {
			program,
			enrichedProgram,
			diagnostics: [
				placelessDiagnostic(
					"error",
					`Internal Compiler Error: ${
						error instanceof Error ? error.message : String(error)
					}`,
					"internal-error",
				),
			],
		}
	}
}

export function analyse(
	source: string,
	documentPath?: string,
): Array<common.Diagnostic> {
	return analyseDocument(source, documentPath).diagnostics
}
