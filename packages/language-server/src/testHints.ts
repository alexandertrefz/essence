import type { common } from "@essence-lang/interfaces"
import type { TestEvent } from "@essence-lang/runtime/Testing"

import type { InlayHint } from "./inlayHints"

// The values a live session's test run recorded, drawn where they were
// recorded. A `probe` comes from a `§?` line or a Constant a test body wrote.
// A failed `expect` shows its values; a passing one draws nothing.

// How much of a value is drawn inline. The rest is read on hover.
const MAXIMUM_LENGTH = 60

function clipped(value: string): string {
	let single = value.replace(/\s*\n\s*/g, " ")

	return single.length <= MAXIMUM_LENGTH
		? single
		: `${single.slice(0, MAXIMUM_LENGTH - 1)}…`
}

// A value Hint has no edit. It sits at the end of its line, after any `§?`
// comment, so it never reads as part of the comment.
function valueHint(
	line: number,
	lines: Array<string>,
	label: string,
): InlayHint {
	return {
		position: { line, column: (lines[line - 1]?.length ?? 0) + 1 },
		label: clipped(label),
		kind: "value",
		textEdit: null,
	}
}

function comparisonLabel(
	event: Extract<TestEvent, { kind: "expect" }>,
): string {
	let comparison = event.comparison

	if (comparison !== null && comparison.left !== null) {
		// A snapshot's two sides are a recording and a run that differ, not a failed
		// equality.
		if (comparison.kind === "snapshot") {
			return `recorded ${comparison.left}, held ${comparison.right}`
		}

		return `${comparison.left} ${
			comparison.kind === "is" ? "is not" : "is"
		} ${comparison.right}`
	}

	// Every sub-expression the assertion evaluated, in written order.
	let values = event.values
		.filter(
			(value) => value.span !== null && value.value !== value.span.source,
		)
		.map((value) => `${value.span?.source} = ${value.value}`)

	return values.length === 0 ? `this ${event.form} failed` : values.join(", ")
}

// The Hints for one file, sorted by line, one per line. A suite's setup may
// record once per test; the last recording wins.
export function findValueHints(
	events: Array<TestEvent>,
	sourceText: string,
	range: common.Position | null = null,
): Array<InlayHint> {
	let lines = sourceText.split("\n")
	let byLine = new Map<number, InlayHint>()

	for (let event of events) {
		if (event.kind === "probe") {
			if (event.span === null) {
				continue
			}

			byLine.set(
				event.span.end.line,
				valueHint(event.span.end.line, lines, event.value),
			)

			continue
		}

		if (event.kind !== "expect" || event.passed || event.span === null) {
			continue
		}

		byLine.set(
			event.span.end.line,
			valueHint(event.span.end.line, lines, comparisonLabel(event)),
		)
	}

	return [...byLine.values()]
		.filter(
			(hint) =>
				range === null ||
				(hint.position.line >= range.start.line &&
					hint.position.line <= range.end.line),
		)
		.sort((left, right) => left.position.line - right.position.line)
}
