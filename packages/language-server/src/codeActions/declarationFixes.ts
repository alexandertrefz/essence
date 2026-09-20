import type { common, parser } from "@essence-lang/interfaces"

import { keywordBefore, sliceOf } from "./geometry"
import type { CodeActionEntry } from "./index"
import {
	enclosingNamespace,
	findProtocolExtension,
	findStaticMethodName,
	findTypeParameter,
	readsNamespaceMember,
} from "./lookups"

// NOTE: The Diagnostics a DECLARATION'S HEAD carries — the Type Parameter list,
// the `static` a Method opens with, the `where` on a Protocol's extension list.
// What they share is that the fix is an edit to the line the declaration is
// announced on, never to the body under it, which is why they are read together
// rather than beside the fixes for the Statements they hold.

const inferKeyword = /^infer[ \t]+$/
const staticKeyword = "static"

// NOTE: What goes is the marker and the blanks behind it, which is the span
// between where the Type Parameter starts and where its NAME does — the
// Parameter's own Position opens on `infer` wherever one was written. Measured
// from the Node rather than from the Diagnostic's span, and then read back off
// the buffer: a marker carried over a line break is a shape this has no answer
// for, and the check is what turns one away instead of guessing.
//
// What follows the name is left exactly as it stands: a bound (`infer Item is
// Comparable`) and a default (`infer Item = Integer`) are no part of what the
// Diagnostic refuses.
export function removeInferAction(
	diagnostic: common.Diagnostic & { position: common.Position },
	program: parser.Program,
	lines: Array<string>,
): CodeActionEntry | null {
	let parameter = findTypeParameter(program, diagnostic.position)

	if (parameter === null || !parameter.inferred) {
		return null
	}

	let range = {
		start: parameter.position.start,
		end: parameter.name.position.start,
	}

	if (!inferKeyword.test(sliceOf(lines, range))) {
		return null
	}

	return {
		title: "Remove 'infer'",
		kind: "quickfix",
		diagnosticCode: diagnostic.code,
		diagnosticPosition: diagnostic.position,
		isPreferred: true,
		edits: [{ range, newText: "" }],
	}
}

// NOTE: The mirror, and the mirror of the span too: a Parameter written without
// the marker opens on its own name, so the marker goes in front of that name.
// The name is read back off the buffer first — an insertion can not be checked
// after the fact, so what has to be checked is that the Node and the text still
// agree about where the name stands.
export function inferParameterAction(
	diagnostic: common.Diagnostic & { position: common.Position },
	program: parser.Program,
	lines: Array<string>,
): CodeActionEntry | null {
	let parameter = findTypeParameter(program, diagnostic.position)

	if (parameter === null || parameter.inferred) {
		return null
	}

	if (sliceOf(lines, parameter.name.position) !== parameter.name.content) {
		return null
	}

	return {
		title: `Declare it as 'infer ${parameter.name.content}'`,
		kind: "quickfix",
		diagnosticCode: diagnostic.code,
		diagnosticPosition: diagnostic.position,
		isPreferred: true,
		edits: [
			{
				range: {
					start: parameter.name.position.start,
					end: parameter.name.position.start,
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

	// NOTE: And withheld altogether where this file CALLS the Method. Dropping
	// the Keyword changes how every call is written — `Namespace.name(…)`
	// becomes `value::name(…)` — so a file calling it once is refused once more
	// than it was, and one calling it five times five times more, each at a
	// line the reader was not looking at and none of them mentioned by the
	// lightbulb they pressed. The Diagnostic's Help says what dropping costs
	// and says it either way; what is withheld is the button that does it in
	// one click.
	let namespace = enclosingNamespace(program, diagnostic.position)

	if (
		namespace !== null &&
		readsNamespaceMember(program, namespace.name.content, name.content)
	) {
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
// at a time would only report again. Every condition of one clause therefore
// answers with this same edit, and the registry drops the repeats: two
// Diagnostics with one answer are one offer in the lightbulb.
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
