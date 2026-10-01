import { visibleLength } from "./theme"

// Progress is drawn to stderr, so stdout carries only data, as pipes and
// `--json` need.

const MINIMUM_WIDTH = 20
const HIDE_CURSOR = "\x1b[?25l"
export const SHOW_CURSOR = "\x1b[?25h"
const CLEAR_LINE = "\x1b[2K"
const CURSOR_UP = "\x1b[1A"
const CURSOR_START = "\x1b[G"

export type Terminal = {
	stdout: NodeJS.WriteStream
	stderr: NodeJS.WriteStream
	isInteractive: boolean
	width: number
	out: (text: string) => void
	err: (text: string) => void
}

// CI often looks like a TTY, but its logs keep every redraw as a line, so
// animation is off there.
export function isInteractive(
	stream: NodeJS.WriteStream,
	env: NodeJS.ProcessEnv = process.env,
): boolean {
	if (env.CI !== undefined && env.CI !== "" && env.CI !== "false") {
		return false
	}

	return stream.isTTY === true
}

export function createTerminal(
	stdout: NodeJS.WriteStream = process.stdout,
	stderr: NodeJS.WriteStream = process.stderr,
	env: NodeJS.ProcessEnv = process.env,
): Terminal {
	return {
		stdout,
		stderr,
		isInteractive: isInteractive(stderr, env),
		// A terminal without a window size reports zero columns, so zero means unknown
		// rather than a width.
		get width() {
			return Math.max(
				MINIMUM_WIDTH,
				stdout.columns || stderr.columns || 80,
			)
		},
		out: (text: string) => {
			stdout.write(`${text}\n`)
		},
		err: (text: string) => {
			stderr.write(`${text}\n`)
		},
	}
}

// Truncation counts visible characters only, leaving colour escapes in place.
// The caller's styling appends the closing reset.
export function truncate(text: string, width: number): string {
	if (width <= 1 || visibleLength(text) <= width) {
		return text
	}

	let result = ""
	let visible = 0
	let index = 0

	while (index < text.length && visible < width - 1) {
		if (text[index] === "\x1b") {
			let end = text.indexOf("m", index)

			if (end === -1) {
				break
			}

			result += text.slice(index, end + 1)
			index = end + 1

			continue
		}

		result += text[index]
		index += 1
		visible += 1
	}

	return `${result}…`
}

// A block of lines redrawn in place. Each frame is one `write`, since a frame
// split across writes flickers.
export class LiveRegion {
	private terminal: Terminal
	private renderedLines = 0
	private cursorHidden = false

	constructor(terminal: Terminal) {
		this.terminal = terminal
	}

	get isActive(): boolean {
		return this.renderedLines > 0
	}

	render(lines: Array<string>): void {
		if (!this.terminal.isInteractive) {
			return
		}

		let width = this.terminal.width
		let frame = ""

		if (!this.cursorHidden) {
			frame += HIDE_CURSOR
			this.cursorHidden = true
		}

		frame += this.eraseSequence()

		for (let line of lines) {
			frame += `${CLEAR_LINE}${truncate(line, width)}\n`
		}

		this.renderedLines = lines.length
		this.terminal.stderr.write(frame)
	}

	// Erases without redrawing, so scrollback never keeps a half-drawn frame.
	clear(): void {
		if (!this.terminal.isInteractive || this.renderedLines === 0) {
			this.showCursor()

			return
		}

		this.terminal.stderr.write(this.eraseSequence())
		this.renderedLines = 0
		this.showCursor()
	}

	private eraseSequence(): string {
		if (this.renderedLines === 0) {
			return ""
		}

		return (
			`${CURSOR_UP}${CLEAR_LINE}`.repeat(this.renderedLines) +
			CURSOR_START
		)
	}

	private showCursor(): void {
		if (this.cursorHidden) {
			this.terminal.stderr.write(SHOW_CURSOR)
			this.cursorHidden = false
		}
	}
}
