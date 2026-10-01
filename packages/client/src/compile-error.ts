import {
	displayPath,
	renderDiagnostics,
} from "@essence-lang/compiler/diagnostics/render"
import type { DiagnosticGroup } from "@essence-lang/compiler/embed"
import type { common } from "@essence-lang/interfaces"

// The one failure the compiler reports. It stays out of `errors.ts` because it
// needs the compiler's renderer, and `errors.ts` runs where no compiler exists.

// The message is the report `esc` prints, one block per file. An uncaught throw
// out of `loadModule` still shows the excerpt, the underline and the Help.
export class EssenceCompileError extends Error {
	readonly entryPath: string
	readonly diagnostics: Array<common.Diagnostic>
	readonly diagnosticGroups: Array<DiagnosticGroup>

	constructor(
		entryPath: string,
		diagnosticGroups: Array<DiagnosticGroup>,
		// Plain by default, since a message is read from logs and assertions as
		// often as from a terminal. A terminal host renders the groups again.
		options: { color?: boolean } = {},
	) {
		super(renderGroups(diagnosticGroups, options.color ?? false))

		this.name = "EssenceCompileError"
		this.entryPath = entryPath
		this.diagnosticGroups = diagnosticGroups
		this.diagnostics = diagnosticGroups.flatMap(
			(group) => group.diagnostics,
		)

		// Not enumerable, because Bun and Node print an uncaught Error's own
		// enumerable properties under its message, repeating the whole report.
		for (let name of ["entryPath", "diagnostics", "diagnosticGroups"]) {
			Object.defineProperty(this, name, { enumerable: false })
		}
	}
}

// The trailing newline is trimmed, since whatever prints a message adds one.
// The renderer and `displayPath` are the compiler's, so this matches `esc`.
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
