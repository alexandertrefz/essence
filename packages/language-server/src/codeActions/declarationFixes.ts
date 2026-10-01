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

// Fixes for a declaration's head: its Type Parameters, a Method's `static`, a
// Protocol extension's `where`. Each edits the head, never the body.

const inferKeyword = /^infer[ \t]+$/
const staticKeyword = "static"

// Removes `infer` and its blanks: the span from the Type Parameter's start to
// its name. A marker over a line break is refused. A bound or default after
// the name stays.
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

// Writes `infer` before the Type Parameter's name, once the buffer confirms
// the name stands where the Node says.
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

// Drops the `static` before the Method whose body uses `@`. Not preferred:
// taking the value as a Parameter is the other answer, and dropping `static`
// changes how every call is written.
export function dropStaticAction(
	diagnostic: common.Diagnostic & { position: common.Position },
	program: parser.Program,
	lines: Array<string>,
): CodeActionEntry | null {
	let name = findStaticMethodName(program, diagnostic.position)

	if (name === null) {
		return null
	}

	// Withheld where this file calls the Method, since each call would
	// then be refused. The Diagnostic's Help still explains the option.
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

	// Only the keyword and its blanks, so a `static` on another line or a
	// name ending in one is left alone.
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

// Removes the whole `where` clause, since one condition left is refused the
// same way. Each condition's Diagnostic gets this edit, and the repeats are
// offered once.
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

	// `where` is contextual, so the span must open with it. A clause over
	// two lines goes whole.
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
