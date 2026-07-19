import type { Range, Span } from "./span"

// A single line of a `Source`. Offsets/lengths are stored both in code
// points ("char") and UTF-16 code units, so spans of either index type can be
// resolved.
export class Line {
	constructor(
		readonly offset: number,
		readonly charLength: number,
		readonly utf16Offset: number,
		readonly utf16Length: number,
	) {}

	// The code-point offset span of this line in the original `Source`.
	get span(): Range {
		return { start: this.offset, end: this.offset + this.charLength }
	}
}

export interface Location {
	line: Line
	lineIndex: number
	columnIndex: number
}

const LINE_SEPARATORS = new Set([
	"\r", // Carriage return
	"\n", // Line feed
	"\x0B", // Vertical tab
	"\x0C", // Form feed
	"\u0085", // Next line
	"\u2028", // Line separator
	"\u2029", // Paragraph separator
])

// A single source (usually a file) that may be referred to by spans.
export class Source {
	readonly text: string
	readonly lines: Array<Line>
	// Total length in code points.
	readonly charLength: number
	// Offset added to displayed line numbers.
	displayLineOffset = 0

	constructor(text: string) {
		this.text = text

		// An empty input still ought to count as a single empty line.
		if (text === "") {
			this.lines = [new Line(0, 0, 0, 0)]
			this.charLength = 0
			return
		}

		let lines: Array<Line> = []
		let characters = [...text]
		let charOffset = 0
		let utf16Offset = 0
		let charLength = 0
		let utf16Length = 0

		let index = 0
		while (index < characters.length) {
			let character = characters[index]
			charLength++
			utf16Length += character.length
			index++

			if (LINE_SEPARATORS.has(character)) {
				// Handle CRLF as a single terminator.
				if (character === "\r" && characters[index] === "\n") {
					charLength++
					utf16Length++
					index++
				}

				lines.push(
					new Line(charOffset, charLength, utf16Offset, utf16Length),
				)
				charOffset += charLength
				utf16Offset += utf16Length
				charLength = 0
				utf16Length = 0
			}
		}

		if (charLength > 0) {
			lines.push(
				new Line(charOffset, charLength, utf16Offset, utf16Length),
			)
			charOffset += charLength
		}

		this.lines = lines
		this.charLength = charOffset
	}

	static from(text: string): Source {
		return new Source(text)
	}

	// Add an offset to the printed line numbers.
	withDisplayLineOffset(offset: number): Source {
		this.displayLineOffset = offset
		return this
	}

	// Get a specific, zero-indexed line.
	line(index: number): Line | null {
		return this.lines[index] ?? null
	}

	// Get the line that the given code-point offset appears on, and the
	// zero-indexed line/column numbers of the offset.
	getOffsetLine(offset: number): Location | null {
		if (offset > this.charLength) {
			return null
		}

		let lineIndex = lastIndexWithKeyAtMost(
			this.lines,
			offset,
			(line) => line.offset,
		)
		let line = this.line(lineIndex)

		if (line === null || offset < line.offset) {
			return null
		}

		return { line, lineIndex, columnIndex: offset - line.offset }
	}

	// Get the line that the given UTF-16 offset appears on, and the
	// zero-indexed line number and UTF-16 column of the offset.
	getUtf16Line(utf16Offset: number): Location | null {
		if (utf16Offset > this.text.length) {
			return null
		}

		let lineIndex = lastIndexWithKeyAtMost(
			this.lines,
			utf16Offset,
			(line) => line.utf16Offset,
		)
		let line = this.line(lineIndex)

		if (line === null || utf16Offset < line.utf16Offset) {
			return null
		}

		return { line, lineIndex, columnIndex: utf16Offset - line.utf16Offset }
	}

	// Get the range of line indices that the given code-point span runs
	// across. The resulting indices are guaranteed to be valid for `line()`.
	getLineRange(span: Range): Range {
		let start = this.getOffsetLine(span.start)?.lineIndex ?? 0
		let end =
			this.getOffsetLine(Math.max(span.end - 1, span.start)) == null
				? this.lines.length
				: (this.getOffsetLine(Math.max(span.end - 1, span.start))
						?.lineIndex ?? 0) + 1
		return { start, end }
	}

	// Get the source text of a line, including trailing whitespace and the
	// line terminator.
	getLineText(line: Line): string {
		return this.text.slice(
			line.utf16Offset,
			line.utf16Offset + line.utf16Length,
		)
	}
}

function lastIndexWithKeyAtMost(
	lines: Array<Line>,
	target: number,
	key: (line: Line) => number,
): number {
	let low = 0
	let high = lines.length

	while (low < high) {
		let middle = (low + high) >> 1

		if (key(lines[middle]) <= target) {
			low = middle + 1
		} else {
			high = middle
		}
	}

	return Math.max(0, low - 1)
}

// Provides `Source`s for the source ids referenced by a report's spans.
// `fetch` should throw if the id cannot be resolved; `display` returns a
// human-readable name for the id, or `null` if it has none.
export interface Cache<Id> {
	fetch(id: Id): Source
	display(id: Id): string | null
}

// Creates a `Cache` from a collection of id/text pairs.
export function sources<Id>(entries: Iterable<[Id, string]>): Cache<Id> {
	let map = new Map<Id, Source>()

	for (let [id, text] of entries) {
		map.set(id, new Source(text))
	}

	return {
		fetch(id: Id): Source {
			let source = map.get(id)

			if (source === undefined) {
				throw new Error(`Failed to fetch source '${String(id)}'`)
			}

			return source
		},
		display(id: Id): string {
			return String(id)
		},
	}
}

// Wraps a single `Source` as a `Cache` that ignores source ids.
export function singleSource(source: Source): Cache<unknown> {
	return {
		fetch: () => source,
		display: () => null,
	}
}

export type { Span }
