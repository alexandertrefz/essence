import type { common } from "@essence-lang/interfaces"

import { keywordBefore, lineAt, sliceOf } from "./geometry"
import type { CodeActionEntry } from "./index"

// NOTE: The three assertion shapes the Parser turns away, and the one spelling
// each of them was reaching for. All three drop the whole Statement, so there is
// no Node left to measure an edit against — what the fixes below read is the
// Diagnostic's span, the Labels beside it, and the line the keyword opens.

const assertionKeywords = ["expect", "require"] as const

type AssertionKeyword = (typeof assertionKeywords)[number]

type Opening = {
	keyword: AssertionKeyword
	position: common.Position
}

// NOTE: Where the assertion this Diagnostic is about begins. Both shapes are
// written on one line — `expect { team } = value`, `expect value is Integer` —
// so the keyword is looked for on the line the span opens on, and a fix that
// can not find it offers nothing rather than guessing at where the Statement
// began.
//
// The keyword must OPEN its line, which is what keeps `expect "expect" is
// Integer` from being rewritten around the word inside the String: a backwards
// search finds the last one before the cursor, and only the one with nothing but
// indentation in front of it is the Statement's own.
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

// NOTE: `expect MATCHER = EXPR` — the form `require` has, written on the Keyword
// that can not have it. The whole of what is wrong is the Keyword: an `expect`
// records its result and the test carries on, so a name it introduced would
// stand below a line that may never have run, and a `require` ends the test
// where it stands. Swapping the word is the whole edit, and the Matcher and the
// value it was written over are left exactly as they are.
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

// NOTE: The Diagnostic spans `is MATCHER`, and the value it stands behind is
// whatever was written between the Keyword and it.
const trailingMatcherPattern = /^is\s+(\S[\s\S]*)$/

// NOTE: `EXPR is MATCHER` — the form a writer reaches for who has met a Matcher
// behind an `is` somewhere else. A name is introduced left of `=`, so the
// rewrite is the two sides swapped around a `require`: `expect value is Integer`
// becomes `require Integer = value`.
//
// Preferred, because it is the only mechanical answer the Diagnostic has. Its
// other Help — compare instead — needs the value the comparison is against, and
// a Matcher is not one: `Integer` names a shape and there is no `::is(Integer)`
// to write.
//
// Refused where either side runs over a line break. The rewrite puts them on one
// line in the other order, and text that was laid out over several would come
// back as one long one.
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

// NOTE: The `=` and the whitespace around it, which is the whole of what stands
// between a Matcher and the value it was written over.
const assignmentPattern = /^\s*=\s*$/

// NOTE: `require 3 = value` — a written value where a shape belongs. What the
// line asks is whether the two are equal, and that is `Equatable::is`, so the
// two sides swap around the call: `require value::is(3)`. The Keyword stays as
// it was written, which is what the Diagnostic's own Help spells — a comparison
// is a Boolean, and both Keywords judge one.
//
// The value's span comes off the secondary Label, and it is the only place it
// could come from: the Statement is refused whole, so no Node records where the
// value ends.
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
