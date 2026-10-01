import type { common } from "@essence-lang/interfaces"

function offsetOf(text: string, cursor: common.Cursor): number {
	let lines = text.split("\n")
	let offset = 0

	for (let line = 1; line < cursor.line; line++) {
		offset += (lines[line - 1] as string).length + 1
	}

	return offset + cursor.column - 1
}

// How the specs apply an action's edits. Spans are measured against the
// original text and applied in position order, since an action's own order
// means nothing. Insertions at one point keep their listed order, ahead of a
// replacement starting there.
export function applyEdits(
	text: string,
	edits: Array<{ range: common.Position; newText: string }>,
): string {
	let spans = edits
		.map((edit) => ({
			start: offsetOf(text, edit.range.start),
			end: offsetOf(text, edit.range.end),
			newText: edit.newText,
		}))
		.sort(
			(left, right) =>
				left.start - right.start ||
				Number(left.end > left.start) - Number(right.end > right.start),
		)
	let result = ""
	let cursor = 0

	for (let span of spans) {
		if (span.start < cursor) {
			throw new Error(`overlapping edits at offset ${span.start}`)
		}

		result += text.slice(cursor, span.start) + span.newText
		cursor = span.end
	}

	return result + text.slice(cursor)
}
