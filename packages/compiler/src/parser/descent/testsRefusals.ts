import type { common, lexer, parser } from "@essence-lang/interfaces"

import { matcherNames } from "../../helpers/patterns"
import { ParseError } from "./tokenStream"

// The refusals written in and around a tests section. Their Helps spell the
// reader's own Matcher and value back. `…` stands for a span that runs over
// several lines, which the reader fills in.

// The text a one-line span was read from, for a Help that spells the
// reader's text back. A String Node holds decoded escapes, so it can not.
// Empty where the span reaches past the text.
export function writtenText(
	lines: Array<string>,
	position: common.Position,
): string {
	if (position.start.line !== position.end.line) {
		return ""
	}

	let line = lines[position.start.line - 1]

	if (line === undefined || position.end.column - 1 > line.length) {
		return ""
	}

	return line.slice(position.start.column - 1, position.end.column - 1)
}

// A Matcher and the value it was written over.
type Assertion = {
	matcher: parser.MatcherNode
	value: parser.ExpressionNode
}

function spelled(
	lines: Array<string>,
	assertion: Assertion,
): { matcher: string; value: string } {
	return {
		matcher: writtenText(lines, assertion.matcher.position) || "…",
		value: writtenText(lines, assertion.value.position) || "…",
	}
}

// Comparing keeps the keyword the reader wrote.
function takeApartHelps(
	lines: Array<string>,
	keyword: string,
	assertion: Assertion,
): Array<string> {
	let { matcher, value } = spelled(lines, assertion)

	return [
		`Take the value apart with 'require': 'require ${matcher} = ${value}'.`,
		`Or compare instead: '${keyword} ${value}::is(…)'.`,
	]
}

// `expect MATCHER = EXPR`.
export function refusedMatcherOnExpect(
	lines: Array<string>,
	matcher: parser.MatcherNode,
	value: parser.ExpressionNode,
): ParseError {
	return new ParseError(
		"An 'expect' can not take a value apart",
		matcher.position,
		"this would introduce a name",
		{
			code: "matcher-on-expect",
			notes: [
				"An 'expect' records its result and the test carries on, so a name it introduced would stand below a line that may never have run. A 'require' ends the test where it stands, which is what makes the names it introduces safe to read.",
			],
			helps: takeApartHelps(lines, "expect", { matcher, value }),
		},
	)
}

// `EXPR is MATCHER`, a form this language does not have.
export function refusedMatcherAfterValue(
	lines: Array<string>,
	keyword: lexer.Token,
	is: lexer.Token,
	assertion: Assertion,
): ParseError {
	return new ParseError(
		"An assertion has no 'is' form",
		{ start: is.position.start, end: assertion.matcher.position.end },
		"this Matcher stands after the value",
		{
			code: "matcher-after-value",
			notes: [
				"A name is introduced left of '=', in a Parameter, or in a Handler head — never on the right of anything.",
			],
			helps: takeApartHelps(lines, keyword.value, assertion),
		},
	)
}

// `require MATCHER = EXPR matches snapshot`. A Matcher that names nothing,
// such as `#Empty`, leaves nothing to record but the value.
export function refusedSnapshotAfterMatcher(
	lines: Array<string>,
	snapshot: parser.SnapshotNode,
	assertion: Assertion,
): ParseError {
	let names = matcherNames(assertion.matcher)
	let { matcher, value } = spelled(lines, assertion)
	let taken = `require ${matcher} = ${value}`
	let whole = `Or snapshot the value whole, where it is one that prints: 'expect ${value} matches snapshot'.`

	return new ParseError(
		"A snapshot records a value, and this line took one apart",
		snapshot.position,
		"there is no value here to record",
		{
			code: "snapshot-after-matcher",
			// The Matcher's names, for the Quick Fix that records one of them on
			// a line of its own.
			data: { kind: "introduced-names", names },
			notes: [
				"A snapshot is of the value an assertion is written over, printed as text. 'require MATCHER = EXPR' is written over a shape instead: it asks what the value has to be and names its parts, so what there is to record is one of those names.",
			],
			helps:
				names.length === 0
					? [
							`Drop 'matches snapshot' — '${taken}' names nothing to record.`,
							whole,
						]
					: [
							`Record ${names.length === 1 ? "the name" : "a name"} on a line of its own: '${taken}' then 'expect ${names[0]} matches snapshot'.`,
							whole,
						],
		},
	)
}

// A `test` or a `suite` read where only Statements stand. One in a test's own
// body or in a block written in the tests section stands in that section
// already. So the edit moves it out of what holds it.
export function refusedTestItem(
	token: lexer.Token,
	standing: "test-body" | "block" | "outside",
): ParseError {
	if (standing === "test-body") {
		return new ParseError(
			`A '${token.value}' can not be written inside a test's body`,
			token.position,
			`this '${token.value}' stands in the body of another test`,
			{
				code: "test-outside-tests",
				notes: [
					"A test's body is what it runs, and a 'suite' is what groups tests.",
				],
				helps: [
					"Move it out beside the test it stands in, or group the two in a 'suite \"…\" { … }'.",
				],
			},
		)
	}

	if (standing === "block") {
		return new ParseError(
			`A '${token.value}' can not be written inside a block`,
			token.position,
			`this '${token.value}' stands in a block inside the tests section`,
			{
				code: "test-outside-tests",
				notes: [
					"A test is declared where the tests section or a 'suite' lists it, and a block, such as a Function's body or an 'if', runs only when something reaches it.",
				],
				helps: [
					"Move it out of the block, beside the test or suite the block is written in.",
				],
			},
		)
	}

	return new ParseError(
		`A '${token.value}' may only be written in the 'tests { … }' section`,
		token.position,
		`this '${token.value}' stands outside every tests section`,
		{
			code: "test-outside-tests",
			notes: [
				"The tests section is written below the implementation block, and a 'suite' groups the tests inside it.",
			],
			helps: [
				"Move it into the file's 'tests { … }' block, or open one below the implementation.",
			],
		},
	)
}
