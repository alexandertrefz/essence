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
