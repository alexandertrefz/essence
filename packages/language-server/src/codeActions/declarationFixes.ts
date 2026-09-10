import type { common, parser } from "@essence-lang/interfaces"

import { keywordBefore, sliceOf } from "./geometry"
import type { CodeActionEntry } from "./index"
import { findProtocolExtension, findStaticMethodName } from "./lookups"

// NOTE: The Diagnostics a DECLARATION'S HEAD carries — the Type Parameter list,
// the `static` a Method opens with, the `where` on a Protocol's extension list.
// What they share is that the fix is an edit to the line the declaration is
// announced on, never to the body under it, which is why they are read together
// rather than beside the fixes for the Statements they hold.

const inferKeyword = /^infer[ \t]+/
const parameterName = /^[A-Za-z][A-Za-z0-9]*/
const staticKeyword = "static"

// NOTE: A Type Parameter's Position opens on `infer` where the marker was
// written, so the keyword and the space behind it are the front of the span the
// Diagnostic underlines — read back off the buffer rather than measured from the
// name, since a marker written over a line break is a shape no fix here has an
// answer for and one it must not guess at.
//
// What follows is left exactly as it stands: a bound (`infer Item is
// Comparable`) and a default (`infer Item = Integer`) are no part of what the
// Diagnostic refuses.
export function removeInferAction(
	diagnostic: common.Diagnostic & { position: common.Position },
	lines: Array<string>,
): CodeActionEntry | null {
	let written = inferKeyword.exec(sliceOf(lines, diagnostic.position))

	if (written === null) {
		return null
	}

	return {
		title: "Remove 'infer'",
		kind: "quickfix",
		diagnosticCode: diagnostic.code,
		diagnosticPosition: diagnostic.position,
		isPreferred: true,
		edits: [
			{
				range: {
					start: diagnostic.position.start,
					end: {
						line: diagnostic.position.start.line,
						column:
							diagnostic.position.start.column +
							written[0].length,
					},
				},
				newText: "",
			},
		],
	}
}

// NOTE: The mirror, and the mirror of the span too: a Parameter written without
// the marker opens on its own name, so the marker goes in front of where the
// Diagnostic starts. The name is read back off the buffer to say the span still
// reads as a Parameter — and a span that already opens on `infer` is a stale
// analysis answering about a buffer somebody has since fixed.
export function inferParameterAction(
	diagnostic: common.Diagnostic & { position: common.Position },
	lines: Array<string>,
): CodeActionEntry | null {
	let written = sliceOf(lines, diagnostic.position)
	let name = parameterName.exec(written)

	if (name === null || inferKeyword.test(written)) {
		return null
	}

	return {
		title: `Declare it as 'infer ${name[0]}'`,
		kind: "quickfix",
		diagnosticCode: diagnostic.code,
		diagnosticPosition: diagnostic.position,
		isPreferred: true,
		edits: [
			{
				range: {
					start: diagnostic.position.start,
					end: diagnostic.position.start,
				},
				newText: "infer ",
			},
		],
	}
}

// NOTE: The Diagnostic points at the `@`, which is inside the body — so the
// Method it belongs to is what the fix starts from, and the Keyword is the one
// written in front of that Method's name. `overload static make` reads the same
// way as `static make`, since the Keyword sits directly against the name in both.
//
// Never preferred, and the Help says why: the other answer is to take the value
// as a Parameter, which is a change to the Signature and to every call, and
// nothing in the Diagnostic chooses between the two. Dropping the Keyword also
// moves the Method — a static is called on the Namespace and an instance Method
// on a value — so an Editor must not apply it without being asked.
export function dropStaticAction(
	diagnostic: common.Diagnostic & { position: common.Position },
	program: parser.Program,
	lines: Array<string>,
): CodeActionEntry | null {
	let name = findStaticMethodName(program, diagnostic.position)

	if (name === null) {
		return null
	}

	let column = keywordBefore(lines, name.position.start, staticKeyword)

	if (column === null) {
		return null
	}

	let range = {
		start: { line: name.position.start.line, column },
		end: name.position.start,
	}

	// NOTE: The Keyword and the blanks between it and the name, and nothing
	// else — a `static` the Parser read from another line, or a name that
	// merely ENDS in one, would otherwise have text deleted around it.
	if (!/^static[ \t]+$/.test(sliceOf(lines, range))) {
		return null
	}

	return {
		title: "Drop 'static'",
		kind: "quickfix",
		diagnosticCode: diagnostic.code,
		diagnosticPosition: diagnostic.position,
		isPreferred: false,
		edits: [{ range, newText: "" }],
	}
}

// NOTE: The whole clause goes, from the Protocol's name to the last condition —
// a `where` with one condition left is the same refusal, so taking them out one
// at a time would only report again. That is also why every condition of one
// clause answers with this same edit: the Diagnostic is reported per condition
// and the clause is what has to go, so a request that covers two of them is
// offered the fix twice rather than half of it once.
export function dropWhereClauseAction(
	diagnostic: common.Diagnostic & { position: common.Position },
	program: parser.Program,
	lines: Array<string>,
): CodeActionEntry | null {
	let clause = findProtocolExtension(program, diagnostic.position)

	if (clause === null) {
		return null
	}

	let range = {
		start: clause.protocol.position.end,
		end: clause.position.end,
	}

	// NOTE: A clause written over two lines is deleted whole, break and all —
	// `where` is contextual, so what says the span is a clause is that the
	// Keyword opens it.
	if (!/^\s*where\b/.test(sliceOf(lines, range))) {
		return null
	}

	return {
		title: "Drop the 'where' clause",
		kind: "quickfix",
		diagnosticCode: diagnostic.code,
		diagnosticPosition: diagnostic.position,
		isPreferred: true,
		edits: [{ range, newText: "" }],
	}
}
