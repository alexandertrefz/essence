import { parseDocument } from "@essence-lang/compiler/documents"
import type { common, parser } from "@essence-lang/interfaces"

import { printDoc, WIDTH } from "./doc"
import { Printer } from "./printer"
import { canonicalSections, sectionSpans } from "./sections"
import { SourceText } from "./source"
import { collectComments, commentAnchors, TriviaCursor } from "./trivia"

export { WIDTH }

export type Refusal = {
	// `syntax`: the source does not parse, which is the file's own fault.
	// `unsafe`: the result failed a check or the Printer threw, a formatter bug.
	kind: "syntax" | "unsafe"
	message: string
	diagnostics: Array<common.Diagnostic>
}

export type FormatResult = {
	// The formatted source, or the original byte for byte after a refusal.
	text: string
	changed: boolean
	refusal: Refusal | null
}

function formatOnce(source: string, documentPath?: string): string | null {
	let { program, diagnostics } = parseDocument(source, documentPath)

	if (diagnostics.some((diagnostic) => diagnostic.severity === "error")) {
		return null
	}

	return printProgram(program, source)
}

// Not exported, so the safety gate only vouches for a Program that `format`
// has just parsed.
function printProgram(program: parser.Program, source: string): string {
	let printer = new Printer(
		new SourceText(source),
		new TriviaCursor(collectComments(source)),
	)

	return printDoc(printer.printProgram(program), WIDTH)
}

// Strips every Position, the one thing formatting may change. `documentation`
// stays, since a blank line printed after a `§§` block detaches it.
// See "The safety gate" in DEVELOPMENT.md.
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
			key === "genericListPosition" ||
			key === "headPosition" ||
			key === "declarationPosition" ||
			key === "keywordPosition" ||
			key === "valuePosition"
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

// Sorting the Module sections is the one reordering formatting may make, so
// both trees are sorted before they are compared.
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

// Hands the original back when formatting throws. Exported so that a spec can
// reach the catch path without a real crash.
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

	// The result has `\n` line endings whatever the source had.
	let source = original.replace(/\r\n?/g, "\n")

	let { diagnostics } = parseDocument(source, documentPath)

	// The parser's recovery drops a broken Statement, so formatting a file that
	// does not parse would delete code.
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

		// A Comment moved across a brace keeps its order among the Comments, so
		// its place among the Tokens is compared. See "Comment anchors" in
		// DEVELOPMENT.md.
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
