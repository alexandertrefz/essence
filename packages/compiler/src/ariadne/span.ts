// A span within a source. Offsets are zero-indexed and half-open (`end` is
// exclusive). Whether they count code points or UTF-16 code units is decided
// by `Config.indexType`.
//
// `sourceId` identifies which source the span refers to; it may be omitted
// when a report only concerns a single source.
export interface Span<Id = unknown> {
	start: number
	end: number
	sourceId?: Id
}

export interface Range {
	start: number
	end: number
}

export function rangeLength(range: Range): number {
	return Math.max(0, range.end - range.start)
}

export function rangeContains(range: Range, offset: number): boolean {
	return offset >= range.start && offset < range.end
}
