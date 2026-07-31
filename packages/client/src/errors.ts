import {
	displayPath,
	renderDiagnostics,
} from "@essence-lang/compiler/diagnostics/render"
import type { DiagnosticGroup } from "@essence-lang/compiler/embed"
import type { common } from "@essence-lang/interfaces"

// NOTE: The three ways loading an Essence Module can go wrong, told apart by
// WHOSE mistake they are: the Essence source did not compile, a JavaScript value
// does not fit the Essence Type it was handed to, or a Function was called in a
// way its signature does not allow. A host catching one of these knows which of
// its own sides to look at, which a bare `Error` never says.

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

// NOTE: A value that does not fit the Type on the other side of the boundary,
// in either direction. Marshalling arrives in a later slice; the Error exists
// now so that nothing has to invent a second name for the same failure.
export class EssenceMarshalError extends Error {
	constructor(message: string) {
		super(message)

		this.name = "EssenceMarshalError"
	}
}

// NOTE: A call the Function's signature does not admit — the wrong number of
// Arguments, labels that are not its Parameters', an overloaded export with no
// single answer.
export class EssenceCallError extends Error {
	constructor(message: string) {
		super(message)

		this.name = "EssenceCallError"
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
