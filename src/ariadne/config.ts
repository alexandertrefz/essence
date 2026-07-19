import { characterWidth } from "./characterWidth"
import { type Color, Colors } from "./color"

// Possible character sets to use when rendering dynamic elements such as
// boxes and arrows.
export type CharSet = "unicode" | "ascii"

// How span offsets are interpreted: as Unicode code points ("char", the
// equivalent of ariadne's char spans) or as UTF-16 code units ("utf16", the
// JavaScript-native equivalent of ariadne's byte spans).
export type IndexType = "char" | "utf16"

// The attachment point of inline label arrows.
export type LabelAttach = "start" | "middle" | "end"

export interface ConfigOptions {
	// When label lines cross one-another, should there be a gap? The
	// alternative is to insert crossing characters, which interact poorly with
	// label colors. Defaults to `true`.
	crossGap: boolean
	// Where inline labels attach to their spans. Defaults to `"middle"`.
	labelAttach: LabelAttach
	// Remove gaps to minimise used space. Defaults to `false`.
	compact: boolean
	// Use underlines for label spans where possible. Defaults to `true`.
	underlines: boolean
	// Use arrows to point to the bounds of multi-line spans. Defaults to `true`.
	multilineArrows: boolean
	// Enable colored output. Defaults to `true`.
	color: boolean
	// Display width of tab characters. Defaults to `4`.
	tabWidth: number
	// Character set for boxes and arrows. Defaults to `"unicode"`.
	charSet: CharSet
	// How span offsets are interpreted. Defaults to `"char"`.
	indexType: IndexType
	// Minimise label crossings rather than prioritising label ordering.
	// Defaults to `false`.
	minimiseCrossings: boolean
	// Extra context lines shown around the start and end of labels.
	// Defaults to `0`.
	contextLines: number
	// Strip all ANSI escape codes from the output, including any contained in
	// user-provided messages. Defaults to `false`.
	stripAnsi: boolean
	// Number separate notes ("Note 1:", "Note 2:", ...). Defaults to `true`.
	enumerateNotes: boolean
	// Number separate help messages. Defaults to `true`.
	enumerateHelps: boolean
}

export class Config implements ConfigOptions {
	readonly crossGap: boolean = true
	readonly labelAttach: LabelAttach = "middle"
	readonly compact: boolean = false
	readonly underlines: boolean = true
	readonly multilineArrows: boolean = true
	readonly color: boolean = true
	readonly tabWidth: number = 4
	readonly charSet: CharSet = "unicode"
	readonly indexType: IndexType = "char"
	readonly minimiseCrossings: boolean = false
	readonly contextLines: number = 0
	readonly stripAnsi: boolean = false
	readonly enumerateNotes: boolean = true
	readonly enumerateHelps: boolean = true

	constructor(options: Partial<ConfigOptions> = {}) {
		Object.assign(this, options)
	}

	errorColor(): Color | null {
		return this.color ? Colors.red : null
	}

	warningColor(): Color | null {
		return this.color ? Colors.yellow : null
	}

	adviceColor(): Color | null {
		return this.color ? Colors.fixed(147) : null
	}

	marginColor(): Color | null {
		return this.color ? Colors.fixed(246) : null
	}

	skippedMarginColor(): Color | null {
		return this.color ? Colors.fixed(240) : null
	}

	unimportantColor(): Color | null {
		return this.color ? Colors.fixed(249) : null
	}

	noteColor(): Color | null {
		return this.color ? Colors.fixed(115) : null
	}

	filterColor(color: Color | null): Color | null {
		return this.color ? color : null
	}

	// Finds the character that should be drawn, and the number of times it
	// should be drawn, for the given source character at the given column.
	characterWidthOf(character: string, column: number): [string, number] {
		if (character === "\t") {
			// Find the column that the tab should end at
			let tabEnd =
				(Math.floor(column / this.tabWidth) + 1) * this.tabWidth
			return [" ", tabEnd - column]
		}

		if (/\s/u.test(character)) {
			return [" ", 1]
		}

		return [character, characterWidth(character)]
	}
}
