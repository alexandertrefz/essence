import type { common } from "@essence-lang/interfaces"

// The source, for what is safest reprinted as written, such as the grouping in
// `1_000` or a String's quotes. Positions are 1-based lines and columns, so it
// is kept as lines.
export class SourceText {
	private lines: Array<string>

	constructor(source: string) {
		this.lines = source.split("\n")
	}

	lineCount(): number {
		return this.lines.length
	}

	lineAt(line: number): string {
		return this.lines[line - 1] ?? ""
	}

	// Whether a blank line stands strictly between the two. A Statement over
	// several lines leaves a gap in line numbers without one.
	hasBlankLineBetween(endLine: number, startLine: number): boolean {
		for (let line = endLine + 1; line < startLine; line++) {
			if (this.lineAt(line).trim() === "") {
				return true
			}
		}

		return false
	}

	// The line a block's own `}` is on. An `if … else` has no Position for the
	// `}` of its true body. Guessing it would pull the Comments at the top of
	// the `else` into the `if`.
	closingBraceLine(from: number, to: number): number | null {
		for (let line = from; line <= to; line++) {
			if (this.lineAt(line).trim().startsWith("}")) {
				return line
			}
		}

		return null
	}

	// The last line in the range whose code ends with `{`. A Parameter list or
	// a broken `if` condition can put the brace lines after the keyword. A
	// default value or a `match` can end an earlier line with a `{` of its own.
	openingBraceLine(from: number, to: number): number | null {
		for (let line = to; line >= from; line--) {
			let code = codeOf(this.lineAt(line)).trimEnd()

			if (code.endsWith("{") || code.endsWith("{}")) {
				return line
			}
		}

		return null
	}

	// `end` is exclusive, as the Lexer's cursor stops on the first character
	// after the Token.
	slice(position: common.Position): string {
		let { start, end } = position

		if (start.line === end.line) {
			return this.lineAt(start.line).slice(
				start.column - 1,
				end.column - 1,
			)
		}

		let parts: Array<string> = [
			this.lineAt(start.line).slice(start.column - 1),
		]

		for (let line = start.line + 1; line < end.line; line++) {
			parts.push(this.lineAt(line))
		}

		parts.push(this.lineAt(end.line).slice(0, end.column - 1))

		return parts.join("\n")
	}
}

// A line with its trailing Comment cut off. A `§` after an odd number of
// quotes is inside a String, which is close enough to see a line end in `{`.
function codeOf(line: string): string {
	let quotes = 0

	for (let index = 0; index < line.length; index++) {
		let character = line[index]

		if (character === '"' && line[index - 1] !== "\\") {
			quotes++
		} else if (character === "§" && quotes % 2 === 0) {
			return line.slice(0, index)
		}
	}

	return line
}
