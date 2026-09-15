import type { common, parser } from "@essence-lang/interfaces"

import { containsRange, keywordAt, sliceOf } from "./geometry"
import type { CodeActionEntry } from "./index"
import { walk } from "./lookups"

// NOTE: The fixes for the Diagnostics asynchrony reports. Four of the five have
// a mechanical answer and are written below; `unobserved-started` has none and
// is the reason the NOTE at the bottom of this file exists.

// NOTE: The Keyword each Node is written with, which is what the two fixes that
// read the buffer back check the text against before cutting or naming it.
const keywords = { Start: "start", Complete: "complete" } as const

// NOTE: `complete` in a body that declared something other than a Future. The
// body is right and the signature is behind it: what it answers with is a
// Future of what it says today, so the annotation is wrapped rather than
// replaced — the Type the author wrote is the Value the future carries.
//
// Offered only where the `complete` stands in a BODY. The other site this code
// is reported at is a Parameter's default, which suspends nothing and is inside
// no body at all: wrapping the enclosing Function's return Type there would
// answer a question nobody asked and leave the default exactly as wrong.
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

	// NOTE: A Diagnostic the client echoed back may be a keystroke stale, and
	// the annotation may already read the way this would write it — in which
	// case there is nothing to offer rather than `Future<Future<Integer>>`.
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

// NOTE: The Function definition whose own body holds a Position, innermost
// first — the body rather than the whole Node, which is what tells a `complete`
// written in a Statement from one written in a Parameter's default.
//
// Innermost wins on the reading `findInnermostNodeContaining` takes of the same
// walk: a Node is visited before the Nodes it holds, so the last definition
// holding the Position is the one no other definition of the list is nested in.
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

// NOTE: A Future written where its value goes nowhere, which is the one
// Diagnostic of the five with two answers: waiting for it and putting it in
// flight are both whole things to mean, and nothing in the source says which.
// Neither is preferred for that reason, and `complete` is offered first because
// it is the answer that leaves the line's value where a reader can still reach
// it — a `start` dropped on the floor is the Information below this one.
export function discardedFutureActions(
	diagnostic: common.Diagnostic & { position: common.Position },
): Array<CodeActionEntry> {
	return [
		insertKeywordAction(diagnostic, "complete", "Wait for it with"),
		insertKeywordAction(diagnostic, "start", "Put it in flight with"),
	].map((entry) => ({ ...entry, isPreferred: false }))
}

// NOTE: The Helps that ask for one word to be written in front of a value —
// `asynchronyHelps` and `returnAsynchronyHelps` in the Validator, whose other
// answer ("build a future") is not an edit anything here can write. Matched on
// the Help rather than on the code, because the codes these arrive under —
// an assignment's and a return's mismatch — are reported for every other
// mismatch in the language as well.
const addsComplete = /add 'complete'/i

// NOTE: A Type mismatch that is one missing word: a Future or a Started
// standing where the value it answers with is wanted. The Validator has already
// decided that, by assignability, and says so in its Help — so what is left
// here is writing the word.
export function waitForValueAction(
	diagnostic: common.Diagnostic & { position: common.Position },
): CodeActionEntry | null {
	if (!diagnostic.helps.some((help) => addsComplete.test(help))) {
		return null
	}

	return insertKeywordAction(diagnostic, "complete", "Wait for it with")
}

function insertKeywordAction(
	diagnostic: common.Diagnostic & { position: common.Position },
	keyword: string,
	title: string,
): CodeActionEntry {
	return {
		title: `${title} '${keyword}'`,
		kind: "quickfix",
		diagnosticCode: diagnostic.code,
		diagnosticPosition: diagnostic.position,
		// NOTE: Preferred where it is the answer rather than one of two —
		// `discardedFutureActions` overrides this on both of the pair it
		// offers, since choosing between them is the reader's.
		isPreferred: true,
		edits: [
			{
				range: {
					start: diagnostic.position.start,
					end: diagnostic.position.start,
				},
				newText: `${keyword} `,
			},
		],
	}
}

// NOTE: A Keyword in front of a value that is neither a Future nor a Started.
// The word is the whole of what is wrong, so the whole of the fix is to take it
// out — everything from where it starts to where its operand does, which is the
// word and the space behind it.
//
// The buffer is read back before cutting: a Diagnostic that has slid by a
// keystroke would otherwise take a column of somebody's Expression with it.
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

// NOTE: The `start` or `complete` the Diagnostic was reported against. Both are
// reported at the whole Expression's Position, so the Node wanted is the one
// standing exactly there — and the walk answers with the innermost, which is
// what tells the inner Keyword of `complete start x` from the outer one.
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

// NOTE: And the one that is offered nothing. `unobserved-started` is an
// Information about a line that is legal — fire and forget is a real thing to
// write — and its two answers are "leave it", which is no edit, and "hold it in
// a Constant", whose whole content is a name only the reader knows. A fix that
// invented one would name the work after the Function that built it and shadow
// that Function on the line below, which is worse than the Information it
// answered.
