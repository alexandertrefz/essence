import {
	displayPath,
	renderDiagnostics,
} from "@essence-lang/compiler/diagnostics/render"
import type { DiagnosticGroup } from "@essence-lang/compiler/embed"
import type { common } from "@essence-lang/interfaces"

// NOTE: The four ways reaching an Essence Module can go wrong, told apart by
// WHOSE mistake they are: the Essence source did not compile, a JavaScript value
// does not fit the Essence Type it was handed to, a Function was called in a way
// its signature does not allow, or the build itself was set up in a way that can
// not work. A host catching one of these knows which of its own sides to look
// at, which a bare `Error` never says.

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
// in either direction.
//
// NOTE: `path` says WHERE, as the message already does — `argument 2 →
// .items[0].width`. It is carried apart from the prose so that a host can group,
// match or point an editor at the failure without reading the sentence back
// again, which is the one thing a caught Error's message is bad at.
export class EssenceMarshalError extends Error {
	readonly path: string
	// NOTE: Whether the value was RECOGNISED before it was refused — a Case
	// whose `$case` named this arm and whose payload then did not fit, rather
	// than an arm that never took the value at all. A Union tries its arms in
	// order and answers with one refusal, and this is how it tells "you meant
	// this one and got a member wrong" from "this is not any of them".
	readonly inside: boolean

	constructor(message: string, path = "", inside = false) {
		super(message)

		this.name = "EssenceMarshalError"
		this.path = path
		this.inside = inside
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

// NOTE: A build the plugins can not serve — two `.es` entries out of one Module
// graph, today. Not a compile failure: every source involved compiled, and
// what is wrong is the shape of the build rather than anything in a file, so
// there is no excerpt to show and nothing to underline.
export class EssenceBuildError extends Error {
	constructor(message: string) {
		super(message)

		this.name = "EssenceBuildError"
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
