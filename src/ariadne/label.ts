import type { Color } from "./color"
import type { Span } from "./span"

// How many lines of a multi-line label should be shown: all of them, or at
// most N (the start and end lines are always shown, so N should be >= 2).
export type LabelShowLines = "all" | number

export interface LabelOptions {
	// The message displayed alongside the label's arrow.
	message?: string
	// The highlight color of the label's span and arrow.
	color?: Color
	// The order of this label relative to other labels; lower values are
	// displayed earlier. Defaults to `0`.
	order?: number
	// The priority of this label when spans overlap; higher values win.
	// By default, smaller spans get higher priority. Defaults to `0`.
	priority?: number
	// How many lines of the label to show. Defaults to at most 2.
	showLines?: LabelShowLines
}

// A labelled section of source code.
export class Label<Id = unknown> {
	readonly span: Span<Id>
	readonly message: string | null
	readonly color: Color | null
	readonly order: number
	readonly priority: number
	readonly showLines: LabelShowLines

	constructor(span: Span<Id>, options: LabelOptions = {}) {
		if (span.start > span.end) {
			throw new Error("Label start is after its end")
		}

		this.span = span
		this.message = options.message ?? null
		this.color = options.color ?? null
		this.order = options.order ?? 0
		this.priority = options.priority ?? 0
		this.showLines = options.showLines ?? 2
	}
}
