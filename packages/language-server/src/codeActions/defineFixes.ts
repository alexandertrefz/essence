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

// Fixes for a `define` with an arm after its `otherwise` arm, without one, or
// with nothing else. Each is answered from the arms' own text.

const armPattern = /^as\b/

// An arm after the `otherwise` arm is removed or moved above it. Removal is
// preferred, since the unreachable arm changes nothing. The Node does not
// record such an arm, so its span comes from the Diagnostic.
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

	// The arm's own line, or the arm with the blank before it when it shares
	// a line.
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

	// The move writes whole lines, so it needs the `otherwise` arm to open
	// its line. A single-line `define` gets only the removal.
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

// A `define` with only its `otherwise` arm is replaced by that arm's value,
// copied as written.
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

// Adds an `otherwise` arm to a refused `define`, whose Diagnostic spans it
// from keyword to closing brace. Its value is a hole for the reader to fill,
// so the fix is not preferred. See "Holes" in DEVELOPMENT.md.
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
