import type { common } from "@essence-lang/interfaces"

import { keywordBefore, lineAt, sliceOf } from "./geometry"
import type { CodeActionEntry } from "./index"

// Fixes for assertion shapes the Parser refuses, each rewritten to the
// spelling it reached for. The Statement is dropped, so they read the
// Diagnostic's span, its Labels and the keyword's line.

const assertionKeywords = ["expect", "require"] as const

type AssertionKeyword = (typeof assertionKeywords)[number]

type Opening = {
	keyword: AssertionKeyword
	position: common.Position
}

// Where the assertion begins: its keyword, on the line the span opens on. The
// keyword must open its line, so the word inside `expect "expect" is Integer`
// is never taken for it.
function openingOf(
	lines: Array<string>,
	cursor: common.Cursor,
): Opening | null {
	for (let keyword of assertionKeywords) {
		let column = keywordBefore(lines, cursor, keyword)

		if (
			column === null ||
			lineAt(lines, cursor.line)
				.slice(0, column - 1)
				.trim() !== ""
		) {
			continue
		}

		return {
			keyword,
			position: {
				start: { line: cursor.line, column },
				end: { line: cursor.line, column: column + keyword.length },
			},
		}
	}

	return null
}

// `expect MATCHER = EXPR` becomes `require MATCHER = EXPR`. An `expect` lets
// the test go on after a failure, so it cannot bind names; a `require` ends
// the test.
export function requireKeywordAction(
	diagnostic: common.Diagnostic & { position: common.Position },
	lines: Array<string>,
): CodeActionEntry | null {
	let opening = openingOf(lines, diagnostic.position.start)

	if (opening === null || opening.keyword !== "expect") {
		return null
	}

	return {
		title: "Take the value apart with 'require'",
		kind: "quickfix",
		diagnosticCode: diagnostic.code,
		diagnosticPosition: diagnostic.position,
		isPreferred: true,
		edits: [{ range: opening.position, newText: "require" }],
	}
}

// The Diagnostic spans `is MATCHER`, and the value it stands behind is
// whatever was written between the Keyword and it.
const trailingMatcherPattern = /^is\s+(\S[\s\S]*)$/

// `expect value is Integer` becomes `require Integer = value`. Preferred: the
// Diagnostic's other Help, comparing, has no value to compare with. Refused
// for a Matcher over several lines, which the rewrite would join.
export function matcherBeforeValueAction(
	diagnostic: common.Diagnostic & { position: common.Position },
	lines: Array<string>,
): CodeActionEntry | null {
	let opening = openingOf(lines, diagnostic.position.start)
	let written = trailingMatcherPattern.exec(
		sliceOf(lines, diagnostic.position),
	)

	if (opening === null || written === null) {
		return null
	}

	let matcher = written[1] as string
	let value = sliceOf(lines, {
		start: opening.position.end,
		end: diagnostic.position.start,
	}).trim()

	if (value === "" || matcher.includes("\n")) {
		return null
	}

	return {
		title: "Take the value apart with 'require'",
		kind: "quickfix",
		diagnosticCode: diagnostic.code,
		diagnosticPosition: diagnostic.position,
		isPreferred: true,
		edits: [
			{
				range: {
					start: opening.position.start,
					end: diagnostic.position.end,
				},
				newText: `require ${matcher} = ${value}`,
			},
		],
	}
}

// The `=` and the whitespace around it, which is the whole of what stands
// between a Matcher and the value it was written over.
const assignmentPattern = /^\s*=\s*$/

// `require 3 = value` becomes `require value::is(3)`, as the Diagnostic's Help
// spells it; the keyword stays. The value's span comes from the secondary
// Label, since no Node records it.
export function compareWrittenValueAction(
	diagnostic: common.Diagnostic & { position: common.Position },
	lines: Array<string>,
): CodeActionEntry | null {
	let valuePosition = diagnostic.labels.find(
		(label) => label.kind === "secondary",
	)?.position

	if (valuePosition === undefined) {
		return null
	}

	let literal = sliceOf(lines, diagnostic.position)
	let value = sliceOf(lines, valuePosition)
	let between = sliceOf(lines, {
		start: diagnostic.position.end,
		end: valuePosition.start,
	})

	if (
		literal.trim() === "" ||
		value.trim() === "" ||
		!assignmentPattern.test(between) ||
		`${literal}${value}`.includes("\n")
	) {
		return null
	}

	let comparison = `${value}::is(${literal})`

	return {
		title: `Compare it instead: '${comparison}'`,
		kind: "quickfix",
		diagnosticCode: diagnostic.code,
		diagnosticPosition: diagnostic.position,
		isPreferred: true,
		edits: [
			{
				range: {
					start: diagnostic.position.start,
					end: valuePosition.end,
				},
				newText: comparison,
			},
		],
	}
}
