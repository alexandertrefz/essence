import type { common, lexer } from "@essence-lang/interfaces"

import { ParseError } from "./tokenStream"

// The refusals written in and around a tests section, and the reader's text
// their Helps spell back.

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
