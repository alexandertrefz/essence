import {
	displayPath,
	renderDiagnostics,
} from "@essence-lang/compiler/diagnostics/render"
import type { DiagnosticGroup } from "@essence-lang/compiler/embed"
import type { common } from "@essence-lang/interfaces"

// NOTE: The one failure that is the COMPILER's to report, kept apart from the
// three in `errors.ts` for exactly that reason: rendering a Diagnostic takes
// the Compiler's own renderer, and `errors.ts` is imported by the half of this
// package that runs where no Compiler exists. A marshalling refusal is a
// sentence about a value and travels anywhere; a compile failure is an excerpt
// of a source file with an underline under it, and only a machine that has the
// sources can draw one.

// NOTE: The message IS the report — the same Ariadne output `esc` prints, one
// block per file against that file's own source. Rendering it here rather than
// handing back a list is what makes a bare `throw` out of `loadModule` as
// readable as the command line: a host that does nothing at all still shows the
// excerpt, the underline and the Help.
export class EssenceCompileError extends Error {
	readonly entryPath: string
	readonly diagnostics: Array<common.Diagnostic>
	readonly diagnosticGroups: Array<DiagnosticGroup>

	constructor(
		entryPath: string,
		diagnosticGroups: Array<DiagnosticGroup>,
		// NOTE: Plain by default. An Error's message is read out of a log, a
		// serialised crash report and a test assertion at least as often as it is
		// read off a terminal, and escape codes are noise in all three. A host
		// that knows it is writing to a terminal renders the groups again.
		options: { color?: boolean } = {},
	) {
		super(renderGroups(diagnosticGroups, options.color ?? false))

		this.name = "EssenceCompileError"
		this.entryPath = entryPath
		this.diagnosticGroups = diagnosticGroups
		this.diagnostics = diagnosticGroups.flatMap(
			(group) => group.diagnostics,
		)
	}
}

// NOTE: The blocks run together with the trailing newline trimmed, because what
// this becomes is a `message` — whatever prints it adds the line break, and a
// message ending in one prints a blank line under every stack trace.
//
// NOTE: Both the renderer and the rule a file is NAMED under are the Compiler's
// own, so a host reading this report reads the one `esc` prints, down to how the
// path above each excerpt is spelled.
export function renderGroups(
	groups: Array<DiagnosticGroup>,
	color = false,
): string {
	return groups
		.map((group) =>
			renderDiagnostics(
				group.diagnostics,
				group.sourceText,
				displayPath(group.filePath),
				{ color },
			),
		)
		.join("")
		.replace(/\n+$/, "")
}
