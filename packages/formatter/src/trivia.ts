import { Lexer } from "@essence/compiler/lexer"
import { lexer } from "@essence/interfaces"

const TokenType = lexer.TokenType

export type Comment = {
	// NOTE: Verbatim, sigil included and line break excluded, exactly as the
	// Lexer read it. Comments are never reflowed — the corpus contains divider
	// rules and hand-wrapped prose that re-wrapping would destroy — so the text
	// is only ever moved, never rewritten.
	text: string
	startLine: number
	endLine: number
	// NOTE: A Comment with nothing but whitespace before it on its line belongs
	// to whatever comes below it; one that follows code belongs to the line it
	// is on. That distinction is the whole of comment attachment here, because
	// 1,543 of the corpus's 1,548 Comments sit in a Statement list and the rest
	// sit above a Parameter.
	ownLine: boolean
}

// NOTE: The parser's TokenStream drops Comments and Linebreaks before the
// parser ever sees them, and diverts Documentation into a line-keyed map. A
// Lexer constructed here without any `ignore` call keeps all of it, which is
// why the formatter needs no change to the parser at all.
export function collectComments(source: string): Array<Comment> {
	let sourceLexer = new Lexer()
	sourceLexer.reset(source)

	let comments: Array<Comment> = []
	let lastCodeLine = 0

	try {
		let token = sourceLexer.next()

		while (token !== undefined) {
			if (
				token.type === TokenType.Comment ||
				token.type === TokenType.DocComment
			) {
				comments.push({
					text: token.value,
					startLine: token.position.start.line,
					endLine: token.position.end.line,
					ownLine: lastCodeLine !== token.position.start.line,
				})
			} else if (token.type !== TokenType.Linebreak) {
				lastCodeLine = token.position.end.line
			}

			token = sourceLexer.next()
		}
	} catch {
		// NOTE: The Lexer's one fatal case is an unterminated String. `format`
		// refuses any source that produced parse Diagnostics before it ever
		// gets here, so reaching this means the Comments gathered so far are
		// all there were to gather.
	}

	return comments
}

// NOTE: Where each Comment sits among the code around it, as one flat
// sequence: every Token in order, with Comments in their places.
//
// Comparing the sequence before and after formatting is what catches a Comment
// that was MOVED rather than lost. Comparing the Comments alone cannot: a block
// written inside an `else` that gets split across the `} else {` above it keeps
// every Comment, in order, and reads as untouched.
//
// Commas are dropped because formatting legitimately adds one when it breaks a
// list, and that is the only Token it ever adds — everything else about the
// code is already held identical by the AST comparison.
export function commentAnchors(source: string): Array<string> {
	let sourceLexer = new Lexer()
	sourceLexer.reset(source)

	let anchors: Array<string> = []

	try {
		let token = sourceLexer.next()

		while (token !== undefined) {
			if (
				token.type === TokenType.Comment ||
				token.type === TokenType.DocComment
			) {
				anchors.push("§" + token.value)
			} else if (
				token.type !== TokenType.Linebreak &&
				token.type !== TokenType.SymbolComma
			) {
				anchors.push(token.type + " " + token.value)
			}

			token = sourceLexer.next()
		}
	} catch {
		// NOTE: See `collectComments` — unreachable for a source that parsed.
	}

	return anchors
}

// NOTE: A cursor over the Comments in written order. The printer walks the AST
// in source order, so it can simply ask, at each Statement or member boundary,
// for everything written above that point — no per-node attachment table, and
// nothing can be silently skipped, because whatever is never claimed is
// flushed at the end of its block.
export class TriviaCursor {
	private comments: Array<Comment>
	private index: number

	constructor(comments: Array<Comment>) {
		this.comments = comments
		this.index = 0
	}

	// NOTE: Every own-line Comment written strictly above `line`, consumed.
	takeBefore(line: number): Array<Comment> {
		let taken: Array<Comment> = []

		while (this.index < this.comments.length) {
			let comment = this.comments[this.index] as Comment

			if (!comment.ownLine || comment.startLine >= line) {
				break
			}

			taken.push(comment)
			this.index++
		}

		return taken
	}

	// NOTE: The trailing Comment sitting on `line`, taken out of the sequence
	// wherever it is rather than only from the front. Only one can exist per
	// line — a Comment runs to its line break.
	//
	// Claimed by the OUTERMOST node ending on that line, before its children
	// are printed. `__print(list::map((box) { <- box.value })) § note` ends the
	// inner `<- box.value` on the same line as the whole Statement, and
	// whichever asks first wins — so the outer one asks first, and the note
	// stays at the end of the line instead of moving inside the braces.
	//
	// Searching forward rather than reading the front is what keeps that safe
	// when a Comment written INSIDE the node comes before it in the source.
	claimTrailingOn(line: number): Comment | null {
		for (let at = this.index; at < this.comments.length; at++) {
			let comment = this.comments[at] as Comment

			if (comment.startLine > line) {
				break
			}

			if (!comment.ownLine && comment.startLine === line) {
				this.comments.splice(at, 1)

				return comment
			}
		}

		return null
	}

	// NOTE: Everything left over, for the end of a block or of the file. A
	// Comment that claimed no owner still has to be written.
	takeRemaining(): Array<Comment> {
		let taken = this.comments.slice(this.index)
		this.index = this.comments.length

		return taken
	}

	hasMore(): boolean {
		return this.index < this.comments.length
	}
}
