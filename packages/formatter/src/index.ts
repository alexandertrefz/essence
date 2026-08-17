import { parseDocument } from "@essence-lang/compiler/documents"
import type { common, parser } from "@essence-lang/interfaces"

import { printDoc } from "./doc"
import { Printer } from "./printer"
import { canonicalSections, sectionSpans } from "./sections"
import { SourceText } from "./source"
import { collectComments, commentAnchors, TriviaCursor } from "./trivia"

export const WIDTH = 80

export type Refusal = {
	// NOTE: `syntax` means the source never parsed; `unsafe` means it did, was
	// formatted, and the result failed one of the checks below — a formatter
	// bug, not the author's problem. They are kept apart because only the first
	// is worth showing as the file's own fault.
	kind: "syntax" | "unsafe"
	message: string
	diagnostics: Array<common.Diagnostic>
}

export type FormatResult = {
	// NOTE: The formatted source, or — whenever anything at all went wrong —
	// the original, byte for byte. `esfmt` can only ever improve a file or
	// leave it exactly as it found it.
	text: string
	changed: boolean
	refusal: Refusal | null
}

function formatOnce(source: string, documentPath?: string): string | null {
	let { program, diagnostics } = parseDocument(source, documentPath)

	if (diagnostics.some((diagnostic) => diagnostic.severity === "error")) {
		return null
	}

	let printer = new Printer(
		new SourceText(source),
		new TriviaCursor(collectComments(source)),
	)

	return printDoc(printer.printProgram(program), WIDTH)
}

// NOTE: Strips every Position so that two ASTs can be compared for the only
// thing formatting is allowed to change: nothing. `documentation` is compared
// rather than stripped, because Documentation attaches to a Declaration by
// line adjacency — a blank line wrongly inserted between a `§§` block and what
// it documents is valid code that silently loses the docs, and this is what
// catches it.
function stripPositions(value: unknown): unknown {
	if (Array.isArray(value)) {
		return value.map((item) => stripPositions(item))
	}

	if (value === null || typeof value !== "object") {
		return value
	}

	let result: Record<string, unknown> = {}

	for (let [key, member] of Object.entries(value)) {
		if (
			key === "position" ||
			key === "parameterListPosition" ||
			key === "headPosition" ||
			key === "declarationPosition"
		) {
			continue
		}

		result[key] = stripPositions(member)
	}

	return result
}

function parsed(source: string, documentPath?: string): parser.Program | null {
	let { program, diagnostics } = parseDocument(source, documentPath)

	if (diagnostics.some((diagnostic) => diagnostic.severity === "error")) {
		return null
	}

	return program
}

// NOTE: Both Module sections are brought into canonical order first, because
// sorting a block is the one reordering the Formatter is allowed to make.
function astOf(program: parser.Program): unknown {
	return stripPositions(canonicalSections(program))
}

function unsafe(source: string, message: string): FormatResult {
	return {
		text: source,
		changed: false,
		refusal: { kind: "unsafe", message, diagnostics: [] },
	}
}

// NOTE: The last line of the safety story. Every check below catches a
// mistake the formatter is known to be able to make; this catches the ones it
// is not — a printer thrown off by an AST shape it has never seen must still
// hand the original bytes back, not take the process down. Exported so the
// catch path can be tested without engineering a real crash.
export function guarded(
	source: string,
	work: () => FormatResult,
): FormatResult {
	try {
		return work()
	} catch (error) {
		let reason = error instanceof Error ? error.message : String(error)

		return unsafe(source, `Formatting failed unexpectedly (${reason}).`)
	}
}

export function format(
	source: string,
	options: { documentPath?: string; verify?: boolean } = {},
): FormatResult {
	return guarded(source, () => formatUnguarded(source, options))
}

function formatUnguarded(
	original: string,
	options: { documentPath?: string; verify?: boolean },
): FormatResult {
	let { documentPath, verify = true } = options

	// NOTE: Line endings are normalised to `\n` before anything else looks at
	// the source — the Lexer reads a `\r` as part of whatever Token it lands
	// in, so a CRLF file otherwise parses as one syntax error after another
	// and is refused. Formatting writes `\n`, and only that.
	let source = original.replace(/\r\n?/g, "\n")

	let { diagnostics } = parseDocument(source, documentPath)

	// NOTE: Formatting a file that does not parse would delete code — the
	// parser's recovery drops a broken Statement entirely rather than keeping
	// text it could not read.
	if (diagnostics.some((diagnostic) => diagnostic.severity === "error")) {
		return {
			text: original,
			changed: false,
			refusal: {
				kind: "syntax",
				message: "This file has syntax errors, so it was left alone.",
				diagnostics,
			},
		}
	}

	let formatted = formatOnce(source, documentPath)

	if (formatted === null) {
		return unsafe(original, "The formatted output no longer parses.")
	}

	if (verify) {
		let before = parsed(source, documentPath)
		let after = parsed(formatted, documentPath)

		if (before === null || after === null) {
			return unsafe(original, "The formatted output no longer parses.")
		}

		if (JSON.stringify(astOf(before)) !== JSON.stringify(astOf(after))) {
			return unsafe(
				original,
				"Formatting would have changed what this file means.",
			)
		}

		// NOTE: Compares each Comment's place among the Tokens around it, not
		// just the Comments themselves — a Comment that moved across a brace is
		// still present and still in order, and only its anchor gives it away.
		// Inside a Module section the comparison is per entry rather than per
		// Token, since the block comes out sorted.
		if (
			commentAnchors(source, sectionSpans(before)).join("\n") !==
			commentAnchors(formatted, sectionSpans(after)).join("\n")
		) {
			return unsafe(
				original,
				"Formatting would have moved or lost a comment.",
			)
		}

		let again = formatOnce(formatted, documentPath)

		if (again !== formatted) {
			return unsafe(
				original,
				"Formatting is not stable — a second pass changes the result.",
			)
		}
	}

	return {
		text: formatted,
		changed: formatted !== original,
		refusal: null,
	}
}
