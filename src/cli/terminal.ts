import { visibleLength } from "./theme"

// NOTE: Progress is drawn to stderr so that stdout stays a clean data channel —
// `esc build … | …` and `--json` must never have spinner frames interleaved
// into their output.

const MINIMUM_WIDTH = 20
const HIDE_CURSOR = "\x1b[?25l"
const SHOW_CURSOR = "\x1b[?25h"
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

// NOTE: CI environments are TTY-shaped often enough to fool `isTTY`, but their
// log collectors keep every redraw frame as a separate line — a spinner there
// produces hundreds of lines of noise, so animation is disabled.
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
		// NOTE: A terminal that has no window size — a pty opened without one,
		// a pipe, a CI log — reports zero columns rather than nothing at all,
		// so the fallback has to treat zero as "unknown" and not as a width.
		// Taking it literally truncates every line away to an ellipsis.
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

// NOTE: Truncation counts visible characters only, so that a line already
// carrying colour escapes is measured by what the user sees. The escapes
// themselves are left in place — a truncated line keeps its opening codes and
// the trailing reset is re-appended by the caller's styling.
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

// NOTE: A block of lines that can be redrawn in place. Every frame is written
// as one `write` call, because a partial frame split across several writes
// flickers visibly at spinner frame rates.
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

	// NOTE: Erasing without redrawing — used before printing permanent output
	// so that scrollback never keeps a half-finished progress frame.
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
