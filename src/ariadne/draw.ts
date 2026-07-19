import { type Color, Colors } from "./color"

// The characters used to draw boxes, arrows & underlines, per character set.
export interface Characters {
	hbar: string
	vbar: string
	xbar: string
	vbarGap: string

	uarrow: string
	rarrow: string

	ltop: string
	mtop: string
	rtop: string
	lbot: string
	rbot: string
	mbot: string

	lbox: string
	rbox: string

	lcross: string
	rcross: string

	lunderbar: string
	runderbar: string
	munderbar: string
	underline: string
	underbarSingle: string
}

export const unicodeCharacters: Characters = {
	hbar: "─",
	vbar: "│",
	xbar: "┼",
	vbarGap: "┆",
	uarrow: "▲",
	rarrow: "▶",
	ltop: "╭",
	mtop: "┬",
	rtop: "╮",
	lbot: "╰",
	mbot: "┴",
	rbot: "╯",
	lbox: "┤",
	rbox: "│",
	lcross: "├",
	rcross: "┤",
	lunderbar: "┌",
	runderbar: "┐",
	munderbar: "┬",
	underline: "─",
	underbarSingle: "▲",
}

export const asciiCharacters: Characters = {
	hbar: "-",
	vbar: "|",
	xbar: "+",
	vbarGap: ":",
	uarrow: "^",
	rarrow: ">",
	ltop: ",",
	mtop: "v",
	rtop: ".",
	lbot: "`",
	mbot: "-",
	rbot: "'",
	lbox: "[",
	rbox: "]",
	lcross: "|",
	rcross: "|",
	lunderbar: "-",
	runderbar: "-",
	munderbar: "-",
	underline: "-",
	underbarSingle: "^",
}

export function arrowBend(characters: Characters, isTop: boolean): string {
	return isTop ? characters.ltop : characters.lbot
}

export function vbarCharacter(characters: Characters, isGap: boolean): string {
	return isGap ? characters.vbarGap : characters.vbar
}

// Generates a sequence of visually distinct 8-bit colors, useful for giving
// each label in a report its own color.
export class ColorGenerator {
	private state: [number, number, number]
	private minBrightness: number

	constructor(
		state: [number, number, number] = [30000, 15000, 35000],
		minBrightness = 0.5,
	) {
		this.state = [...state]
		this.minBrightness = Math.min(Math.max(minBrightness, 0), 1)
	}

	next(): Color {
		for (let i = 0; i < 3; i++) {
			// Magic constant from upstream, one of only two that have this property!
			this.state[i] = (this.state[i] + 40503 * (i * 4 + 1130)) & 0xffff
		}

		let scale = (component: number) =>
			(component / 65535) * (1 - this.minBrightness) + this.minBrightness

		return Colors.fixed(
			16 +
				Math.trunc(
					scale(this.state[2]) * 5 +
						scale(this.state[1]) * 30 +
						scale(this.state[0]) * 180,
				),
		)
	}
}
