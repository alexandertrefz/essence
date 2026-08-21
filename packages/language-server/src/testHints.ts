import type { common } from "@essence-lang/interfaces"
import type { TestEvent } from "@essence-lang/runtime/Testing"

import type { InlayHint } from "./inlayHints"

// NOTE: The ghost text a live session draws beside a test — the values a run
// RECORDED, shown where they were recorded. Three kinds, all from the same
// events and all from the same trace mechanism underneath:
//
// - a `probe`, which is a `§?` line and every Constant a test body wrote;
// - a failed `expect`, whose ghost is what the comparison held;
// - nothing at all for a passing `expect`, because "it held" is what the gutter
//   and the absence of a squiggle already say, and a value beside every line
//   that is fine is a line nobody reads.

// NOTE: How much of a value is drawn inline. A Record or a List renders to
// whatever it renders to, and a hint is a margin note rather than a document —
// what does not fit is read on hover, where the whole of it is.
const MAXIMUM_LENGTH = 60

function clipped(value: string): string {
	let single = value.replace(/\s*\n\s*/g, " ")

	return single.length <= MAXIMUM_LENGTH
		? single
		: `${single.slice(0, MAXIMUM_LENGTH - 1)}…`
}

// NOTE: A value Hint carries no edit — there is nothing to accept — and sits at
// the END of the line the value was recorded on rather than at the end of the
// span. A `§?` comment stands between the two, and ghost text drawn in front of
// a comment reads as part of it.
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
		// NOTE: A snapshot's two sides are not an equality that failed but a
		// recording and a run that differ, and saying "is" of them would claim
		// the very thing the failure is about.
		if (comparison.kind === "snapshot") {
			return `recorded ${comparison.left}, held ${comparison.right}`
		}

		return `${comparison.left} ${
			comparison.kind === "is" ? "is not" : "is"
		} ${comparison.right}`
	}

	// NOTE: Every sub-expression the assertion evaluated, in the order they
	// were written — which is what the report shows as Labels and the closest
	// thing to an explanation a single line has room for.
	let values = event.values
		.filter(
			(value) => value.span !== null && value.value !== value.span.source,
		)
		.map((value) => `${value.span?.source} = ${value.value}`)

	return values.length === 0 ? `this ${event.form} failed` : values.join(", ")
}

// NOTE: The Hints for one file, out of the events its tests produced. Sorted by
// line, and at most one per line: two tests may record at one place — a suite's
// setup runs once per test — and a reader looking at that line wants one answer
// rather than one per test. The LAST one is kept, which is the most recent run
// of that line.
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
