import type { common } from "@essence-lang/interfaces"

import { sliceOf } from "./geometry"
import type { CodeActionEntry } from "./index"

// Fixes for text that is not Essence, such as a JavaScript habit. Each writes
// over a span the compiler measured, since the Parser drops a refused Statement
// and leaves no Node.

// Writes the Essence spelling of an `essence-spelling` span. The title quotes
// the habit as it was written.
export function essenceSpellingAction(
	diagnostic: common.Diagnostic & { position: common.Position },
	lines: Array<string>,
): CodeActionEntry | null {
	if (diagnostic.data?.kind !== "essence-spelling") {
		return null
	}

	let { position, spelling } = diagnostic.data
	let written = sliceOf(lines, position).trim()

	// An empty span is stale. See "Reading the buffer back" in
	// DEVELOPMENT.md.
	if (written === "") {
		return null
	}

	return {
		// The title names the spelling; the edit also writes its spacing, so
		// `{ x: 0 }` becomes `{ x = 0 }`.
		title:
			spelling === ""
				? `Remove the '${written}'`
				: `Write '${spelling.trim()}' instead of '${written}'`,
		kind: "quickfix",
		diagnosticCode: diagnostic.code,
		diagnosticPosition: diagnostic.position,
		isPreferred: true,
		edits: [{ range: position, newText: spelling }],
	}
}

// `(value)` becomes `value`. Both parentheses go, and the stale check reads
// each one back off the buffer.
export function removeParenthesesAction(
	diagnostic: common.Diagnostic & { position: common.Position },
	lines: Array<string>,
): CodeActionEntry | null {
	if (diagnostic.data?.kind !== "grouping-parentheses") {
		return null
	}

	let { open, close } = diagnostic.data

	if (sliceOf(lines, open) !== "(" || sliceOf(lines, close) !== ")") {
		return null
	}

	return {
		title: "Remove the parentheses",
		kind: "quickfix",
		diagnosticCode: diagnostic.code,
		diagnosticPosition: diagnostic.position,
		isPreferred: true,
		edits: [
			{ range: open, newText: "" },
			{ range: close, newText: "" },
		],
	}
}

// `names.length` becomes `names::length()`. A Method that was only read gets
// the `()` as a second edit; one already called keeps its own.
export function methodSeparatorAction(
	diagnostic: common.Diagnostic & { position: common.Position },
	lines: Array<string>,
): CodeActionEntry | null {
	if (diagnostic.data?.kind !== "method-with-dot") {
		return null
	}

	let { separator, call } = diagnostic.data

	// The separator span must still read as one `.` with any blanks.
	if (sliceOf(lines, separator).trim() !== ".") {
		return null
	}

	return {
		title: "Call it with '::'",
		kind: "quickfix",
		diagnosticCode: diagnostic.code,
		diagnosticPosition: diagnostic.position,
		isPreferred: true,
		edits: [
			{ range: separator, newText: "::" },
			...(call === null ? [] : [{ range: call, newText: "()" }]),
		],
	}
}
