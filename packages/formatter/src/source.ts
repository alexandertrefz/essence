import type { common } from "@essence-lang/interfaces"

// NOTE: Some things are safest reprinted exactly as they were written rather
// than rebuilt from the AST — a grouped Number (`1_000` reaches the AST as
// `"1000"`), a Rational whose parts must stay flush, a String whose quotes the
// Lexer stripped. Positions are 1-based line/column pairs with no byte offset
// anywhere in the compiler, so slicing needs the source split into lines.
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

	// NOTE: Whether every line strictly between the two given ones is blank.
	// This is what tells a written blank line apart from two things that merely
	// sit on non-adjacent lines because the first one spans several.
	hasBlankLineBetween(endLine: number, startLine: number): boolean {
		for (let line = endLine + 1; line < startLine; line++) {
			if (this.lineAt(line).trim() === "") {
				return true
			}
		}

		return false
	}

	// NOTE: The line a block's own `}` is written on, looked for between the end
	// of its last Statement and the start of whatever follows the block.
	//
	// An `if … else` gives no Position for the true body's brace — the
	// Statement's Position runs to the end of the false body — and guessing
	// "the line above the false body's first Statement" lands above any
	// Comments written at the top of the `else`, which then get flushed into
	// the `if` and end up above the `} else {` that used to be below them.
	// Nothing but the source says where that brace is.
	closingBraceLine(from: number, to: number): number | null {
		for (let line = from; line <= to; line++) {
			if (this.lineAt(line).trim().startsWith("}")) {
				return line
			}
		}

		return null
	}

	// NOTE: The line a block's own `{` is written on: the LAST line in the
	// range whose code — a trailing Comment stripped — ends with the brace. A
	// block's opening line is what a trailing Comment is claimed on and what
	// the Statement inside it are laid out against, and it is NOT the line the
	// Declaration starts on: a Parameter list, a conformance clause or a
	// broken chain in an `if` condition can put the brace several lines below
	// the keyword. The last such line, because a default value or a `match`
	// value written before the brace can end a line with a `{` of its own.
	openingBraceLine(from: number, to: number): number | null {
		for (let line = to; line >= from; line--) {
			let code = codeOf(this.lineAt(line)).trimEnd()

			if (code.endsWith("{") || code.endsWith("{}")) {
				return line
			}
		}

		return null
	}

	// NOTE: `end` is exclusive of the character at `end.column`, matching the
	// Lexer's cursor, which stops on the first character that is not part of
	// the Token.
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

// NOTE: A line with its trailing Comment cut off. A `§` inside a String is
// not a Comment, and the one way to tell without lexing is that an odd number
// of quotes stands before it — good enough for a line whose only job is to say
// whether it ends in a brace.
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
