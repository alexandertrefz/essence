import type { common, parser } from "@essence-lang/interfaces"

import {
	indentationOf,
	insertBeforeClosingBrace,
	lineAt,
	removeLinesEdit,
	sliceOf,
} from "./geometry"
import type { CodeActionEntry } from "./index"
import { findInnermostNodeContaining, findNodeAt } from "./lookups"

// NOTE: The three things a `define` can be wrong about: an arm below the one
// that always holds, no arm that always holds, and nothing but the one that
// always holds. Each of the three is answered from the arms themselves — the
// `otherwise` arm's own line, its value's text — which is why they share a file
// rather than a shape.

const armPattern = /^as\b/

// NOTE: An arm below the `otherwise` one has TWO answers and the Diagnostic's
// Help gives both: it is dead where it stands, so either it goes or it belongs
// higher up. Deleting is preferred because the arm is unreachable — removing it
// provably leaves the Program answering exactly what it answered before, which
// moving it above the `otherwise` arm just as provably does not.
//
// The arm is not on the Node — an unreachable one is never recorded, which is
// what keeps "the `otherwise` arm is last" true of every `define` that can be
// built — so the Diagnostic's own span is the whole of what says where the arm
// ends, and the buffer is read back to check it still says it.
export function unreachableDefineArmActions(
	diagnostic: common.Diagnostic & { position: common.Position },
	program: parser.Program,
	lines: Array<string>,
): Array<CodeActionEntry> {
	if (!armPattern.test(sliceOf(lines, diagnostic.position))) {
		return []
	}

	let define = findInnermostNodeContaining(program, diagnostic.position)

	if (define === null || define.nodeType !== "Define") {
		return []
	}

	// NOTE: The arm's own line where it stands on one, and the arm with the
	// blank in front of it where it shares a line — `as 0 otherwise as 2 if
	// other` deleted without that blank leaves `otherwise  }` behind.
	let removal = removeLinesEdit(lines, diagnostic.position)

	let entries: Array<CodeActionEntry> = [
		{
			title: "Remove the arm",
			kind: "quickfix",
			diagnosticCode: diagnostic.code,
			diagnosticPosition: diagnostic.position,
			isPreferred: true,
			edits: [removal],
		},
	]

	let otherwise = define.otherwise.position.start
	let before = lineAt(lines, otherwise.line).slice(0, otherwise.column - 1)

	// NOTE: The move writes whole LINES, so it is offered only where the
	// `otherwise` arm opens one. A `define` written on a single line has no line
	// above its `otherwise` to write into — the start of that line is the start
	// of the Statement the `define` stands in — and deleting the arm is the
	// answer that still holds there.
	if (before.trim() !== "") {
		return entries
	}

	entries.push({
		title: "Move the arm above the 'otherwise' arm",
		kind: "quickfix",
		diagnosticCode: diagnostic.code,
		diagnosticPosition: diagnostic.position,
		isPreferred: false,
		edits: [
			{
				range: {
					start: { line: otherwise.line, column: 1 },
					end: { line: otherwise.line, column: 1 },
				},
				newText: `${before}${sliceOf(lines, diagnostic.position)}\n`,
			},
			removal,
		],
	})

	return entries
}

const defineKeyword = "define"

// NOTE: A `define` whose only arm is the `otherwise` one IS the value it answers
// with, written the long way round — so the fix is that value, in place of the
// whole `define`. The Warning spans the `define` exactly, which is the Node this
// finds it by; the value's text is copied rather than retyped, since a fix that
// rewrites an Expression it has no reason to read is a fix that can corrupt one.
export function inlineDefineValueAction(
	diagnostic: common.Diagnostic & { position: common.Position },
	program: parser.Program,
	lines: Array<string>,
): CodeActionEntry | null {
	let define = findNodeAt(program, diagnostic.position)

	if (
		define === null ||
		define.nodeType !== "Define" ||
		define.arms.length > 0
	) {
		return null
	}

	return {
		title: "Write the value on its own",
		kind: "quickfix",
		diagnosticCode: diagnostic.code,
		diagnosticPosition: diagnostic.position,
		isPreferred: true,
		edits: [
			{
				range: diagnostic.position,
				newText: sliceOf(lines, define.otherwise.value.position),
			},
		],
	}
}

// NOTE: A `define` short of its `otherwise` arm is refused, so there is no Node
// to read — the Diagnostic spans the `define` keyword through its closing brace,
// and the buffer is what says the two are still there.
//
// Not preferred, and honest about why: the arm it writes holds a hole rather than
// a value, so the file does not compile until the reader fills one in. What the
// fix buys is that hole in the place it belongs, at the indentation the arms
// above it stand at — and the title says as much, since a fix named for the
// Diagnostic it does not clear reads as one that failed.
//
// The hole is `{}` and not a blank. `as  otherwise` does not PARSE, and a buffer
// that no longer parses is a buffer whose every other report goes with it — the
// one scaffolding fix in this family whose result was worse than the hole it
// filled. `{}` is the unit value: it parses, it is visibly not an answer, and in
// any position that names a Type it is refused as "this arm does not answer with
// the Type this 'define' has", which is the report a reader can act on.
export function otherwiseArmAction(
	diagnostic: common.Diagnostic & { position: common.Position },
	lines: Array<string>,
): CodeActionEntry | null {
	let written = sliceOf(lines, diagnostic.position)

	if (!written.startsWith(defineKeyword) || !written.endsWith("}")) {
		return null
	}

	let indentation = indentationOf(lines, diagnostic.position.start.line)

	return {
		title: "Add an 'otherwise' arm to fill in",
		kind: "quickfix",
		diagnosticCode: diagnostic.code,
		diagnosticPosition: diagnostic.position,
		isPreferred: false,
		edits: [
			insertBeforeClosingBrace(
				diagnostic.position.end,
				lines,
				`${indentation}\tas {} otherwise\n`,
				indentation,
			),
		],
	}
}
