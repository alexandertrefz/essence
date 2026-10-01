import type { common, parser } from "@essence-lang/interfaces"

import { containsRange, keywordAt, sliceOf } from "./geometry"
import type { CodeActionEntry } from "./index"
import { walk } from "./lookups"

// Fixes for the Diagnostics asynchrony reports. `unobserved-started` gets
// none: its answers are to leave the line, or to name the work, which only the
// reader can.

// The keyword each Node is written with, which `dropKeywordAction` checks the
// buffer against.
const keywords = { Start: "start", Complete: "complete" } as const

// `complete` in a body whose return Type is not a Future: the annotation is
// wrapped as `Future<…>`, keeping what the author wrote. Not offered for a
// Parameter's default, which is in no body.
export function declareFutureReturnAction(
	diagnostic: common.Diagnostic & { position: common.Position },
	program: parser.Program,
	lines: Array<string>,
): CodeActionEntry | null {
	let definition = completingDefinitionAt(program, diagnostic.position)

	if (definition === null || definition.returnType === null) {
		return null
	}

	let written = sliceOf(lines, definition.returnType.position).trim()

	// Nothing where the annotation is empty or already a `Future<…>`.
	if (written === "" || written.startsWith("Future<")) {
		return null
	}

	return {
		title: `Declare the return Type 'Future<${written}>'`,
		kind: "quickfix",
		diagnosticCode: diagnostic.code,
		diagnosticPosition: diagnostic.position,
		isPreferred: true,
		edits: [
			{
				range: definition.returnType.position,
				newText: `Future<${written}>`,
			},
		],
	}
}

// The innermost Function definition whose body holds a Position, so a
// Parameter's default does not count. The walk visits outer Nodes first, so
// the last match is innermost.
function completingDefinitionAt(
	program: parser.Program,
	position: common.Position,
): parser.FunctionDefinitionNode | null {
	let found: parser.FunctionDefinitionNode | null = null

	walk(program, (node) => {
		if (
			node.nodeType !== "FunctionStatement" &&
			node.nodeType !== "FunctionValue"
		) {
			return
		}

		if (
			node.value.body.some((statement) =>
				containsRange(statement.position, position),
			)
		) {
			found = node.value
		}
	})

	return found
}

// A Future whose value goes nowhere: wait for it or put it in flight. The
// source does not say which, so neither is preferred. `complete` comes first,
// since a dropped `start` is reported again.
export function discardedFutureActions(
	diagnostic: common.Diagnostic & { position: common.Position },
): Array<CodeActionEntry> {
	return [
		insertKeywordAction(diagnostic, "complete", "Wait for it with"),
		insertKeywordAction(diagnostic, "start", "Put it in flight with"),
	].map((entry) => ({ ...entry, isPreferred: false }))
}

// A Future or Started where its value is wanted, which the Validator marks in
// `data`. The code alone is shared with every other mismatch, and Help wording
// may change, so the `data` decides.
export function waitForValueAction(
	diagnostic: common.Diagnostic & { position: common.Position },
): CodeActionEntry | null {
	if (diagnostic.data?.kind !== "asynchrony-mismatch") {
		return null
	}

	return insertKeywordAction(diagnostic, "complete", "Wait for it with")
}

// The same on a call that picked no Overload. The Diagnostic spans the call,
// so the word goes before the refused Argument, its primary Label. The
// Enricher sends no `data` for a `::` receiver.
export function waitForArgumentAction(
	diagnostic: common.Diagnostic & { position: common.Position },
): CodeActionEntry | null {
	if (diagnostic.data?.kind !== "asynchrony-mismatch") {
		return null
	}

	let refused = diagnostic.labels.find((label) => label.kind === "primary")

	if (refused === undefined) {
		return null
	}

	return insertKeywordAction(
		diagnostic,
		"complete",
		"Wait for it with",
		refused.position,
	)
}

function insertKeywordAction(
	diagnostic: common.Diagnostic & { position: common.Position },
	keyword: string,
	title: string,
	// Where the word goes; by default the Diagnostic's own span.
	at: common.Position = diagnostic.position,
): CodeActionEntry {
	return {
		title: `${title} '${keyword}'`,
		kind: "quickfix",
		diagnosticCode: diagnostic.code,
		diagnosticPosition: diagnostic.position,
		// `discardedFutureActions` overrides this for its pair.
		isPreferred: true,
		edits: [
			{
				range: { start: at.start, end: at.start },
				newText: `${keyword} `,
			},
		],
	}
}

// Drops a keyword before a value that is neither a Future nor a Started. The
// span runs from the keyword to its operand, once the buffer confirms the word.
export function dropKeywordAction(
	diagnostic: common.Diagnostic & { position: common.Position },
	program: parser.Program,
	lines: Array<string>,
): CodeActionEntry | null {
	let node = keywordNodeAt(program, diagnostic.position)

	if (node === null) {
		return null
	}

	let keyword = keywords[node.nodeType]

	if (!keywordAt(lines, node.position.start, keyword)) {
		return null
	}

	return {
		title: `Drop the '${keyword}'`,
		kind: "quickfix",
		diagnosticCode: diagnostic.code,
		diagnosticPosition: diagnostic.position,
		isPreferred: true,
		edits: [
			{
				range: {
					start: node.position.start,
					end: node.expression.position.start,
				},
				newText: "",
			},
		],
	}
}

// The innermost `start` or `complete` at the Diagnostic, which tells the
// keywords of `complete start x` apart.
function keywordNodeAt(
	program: parser.Program,
	position: common.Position,
): parser.StartNode | parser.CompleteNode | null {
	let found: parser.StartNode | parser.CompleteNode | null = null

	walk(program, (node) => {
		if (
			(node.nodeType === "Start" || node.nodeType === "Complete") &&
			containsRange(node.position, position)
		) {
			found = node
		}
	})

	return found
}
