import { Lexer } from "@essence-lang/compiler/lexer"
import { type common, lexer } from "@essence-lang/interfaces"

const TokenType = lexer.TokenType

export type Comment = {
	// NOTE: Verbatim, sigil included and line break excluded, exactly as the
	// Lexer read it — bar the whitespace at its end, which is trailing
	// whitespace like any other. Comments are never reflowed — the corpus
	// contains divider rules and hand-wrapped prose that re-wrapping would
	// destroy — so the text is only ever moved, never rewritten.
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
					text: token.value.trimEnd(),
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

// NOTE: Where one Module section stands, where each of its groups was written,
// and where each of its entries was — in written order, which is the order the
// Comments around them were claimed in. An entry's `key` is the specifier of
// the group it is written in, or nothing for a bare export entry.
export type SectionSpan = {
	position: common.Position
	groups: Array<common.Position>
	entries: Array<{ position: common.Position; key: string }>
}

// NOTE: One entry's share of a Module section, and one group's: its own Tokens
// together with the Comments that ride with it. A group's share is its `from`,
// its specifier and its braces — the Tokens inside it that are no entry's —
// with the Comments written against those. The chunks of a section are
// compared as a set, which is what lets the block be sorted while still
// catching a Comment that changed which entry or group it belongs to.
type SectionChunks = {
	span: SectionSpan
	groups: Array<Array<string>>
	entries: Array<Array<string>>
	loose: Array<Array<string>>
}

function compareCursors(left: common.Cursor, right: common.Cursor): number {
	return left.line === right.line
		? left.column - right.column
		: left.line - right.line
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
//
// `sections` names the Module sections, the one place where the sequence is
// deliberately allowed to change: those blocks are written in canonical order,
// so their entries come out sorted rather than as they were read. Each entry is
// compared as one chunk carrying the Comments written around it, and the chunks
// as a set — a Comment that moved to another entry, or off the entry it was
// written against, still fails.
export function commentAnchors(
	source: string,
	sections: Array<SectionSpan> = [],
): Array<string> {
	let sourceLexer = new Lexer()
	sourceLexer.reset(source)

	let pending = [...sections].sort((left, right) =>
		compareCursors(left.position.start, right.position.start),
	)
	let open: SectionChunks | null = null

	let anchors: Array<string> = []
	let lastCodeLine = 0

	// NOTE: Sorted, so that the block having been reordered does not show up as a
	// difference, and joined per chunk, so that a Comment moving from one entry to
	// another does.
	let closeSection = (section: SectionChunks) => {
		let written = [
			...section.groups,
			...section.entries,
			...section.loose,
		].map((chunk) => chunk.join(" · "))

		written.sort()
		anchors.push(...written)
	}

	try {
		let token = sourceLexer.next()

		while (token !== undefined) {
			if (
				token.type === TokenType.Linebreak ||
				token.type === TokenType.SymbolComma
			) {
				token = sourceLexer.next()

				continue
			}

			if (
				open !== null &&
				compareCursors(token.position.end, open.span.position.end) >= 0
			) {
				closeSection(open)
				open = null
			}

			let next = pending[0]

			if (
				open === null &&
				next !== undefined &&
				compareCursors(token.position.start, next.position.start) >= 0
			) {
				pending.shift()
				open = {
					span: next,
					groups: next.groups.map(() => []),
					entries: next.entries.map((entry) => [entry.key]),
					loose: [],
				}
			}

			let isComment =
				token.type === TokenType.Comment ||
				token.type === TokenType.DocComment
			// NOTE: A Comment's trailing whitespace is trimmed on the way out,
			// so it is compared without it here too.
			let anchor = isComment
				? "§" + token.value.trimEnd()
				: token.type + " " + token.value

			let chunk =
				open === null
					? null
					: chunkFor(open, token, isComment, lastCodeLine)

			if (chunk === null) {
				anchors.push(anchor)
			} else {
				chunk.push(anchor)
			}

			if (!isComment) {
				lastCodeLine = token.position.end.line
			}

			token = sourceLexer.next()
		}
	} catch {
		// NOTE: See `collectComments` — unreachable for a source that parsed.
	}

	if (open !== null) {
		closeSection(open)
	}

	return anchors
}

// NOTE: Which entry or group a Token inside a Module section rides with, or
// null for one that keeps its place in the sequence — the `import` Keyword, the
// section's braces, and a Comment trailing the section's `{` itself, none of
// which the sort can move.
//
// The rule is the printer's own. Code belongs to the entry it is written in,
// else to the group. A Comment that follows code belongs to the entry ending
// on its line, else to the group opening or closing on it — so the note after
// a group written flat, `from "./A.es" { Amount } § note`, is the entry's. One
// that starts its line belongs to the entry below it inside the same group,
// else to the group it is written in, else to the entry or group below it,
// else to no one.
function chunkFor(
	section: SectionChunks,
	token: lexer.Token,
	isComment: boolean,
	lastCodeLine: number,
): Array<string> | null {
	let { groups, entries } = section.span
	let start = token.position.start

	let entryChunk = (index: number) => section.entries[index] as Array<string>
	let groupChunk = (index: number) => section.groups[index] as Array<string>

	let containingGroup = groups.findIndex(
		(group) =>
			compareCursors(start, group.start) >= 0 &&
			compareCursors(start, group.end) < 0,
	)

	if (!isComment) {
		for (let index = 0; index < entries.length; index++) {
			let entry = (entries[index] as SectionSpan["entries"][number])
				.position

			if (
				compareCursors(start, entry.start) >= 0 &&
				compareCursors(start, entry.end) < 0
			) {
				return entryChunk(index)
			}
		}

		return containingGroup === -1 ? null : groupChunk(containingGroup)
	}

	if (lastCodeLine === start.line) {
		if (start.line === section.span.position.start.line) {
			return null
		}

		for (let index = entries.length - 1; index >= 0; index--) {
			let entry = (entries[index] as SectionSpan["entries"][number])
				.position

			if (entry.end.line === start.line) {
				return entryChunk(index)
			}
		}

		for (let index = 0; index < groups.length; index++) {
			let group = groups[index] as common.Position

			if (
				group.start.line === start.line ||
				group.end.line === start.line
			) {
				return groupChunk(index)
			}
		}

		return null
	}

	if (containingGroup !== -1) {
		let group = groups[containingGroup] as common.Position

		for (let index = 0; index < entries.length; index++) {
			let entry = (entries[index] as SectionSpan["entries"][number])
				.position

			if (
				compareCursors(entry.start, start) > 0 &&
				compareCursors(entry.start, group.end) < 0
			) {
				return entryChunk(index)
			}
		}

		return groupChunk(containingGroup)
	}

	let below: { at: common.Cursor; chunk: Array<string> } | null = null

	for (let index = 0; index < entries.length; index++) {
		let entry = (entries[index] as SectionSpan["entries"][number]).position

		if (compareCursors(entry.start, start) > 0) {
			below = { at: entry.start, chunk: entryChunk(index) }
			break
		}
	}

	for (let index = 0; index < groups.length; index++) {
		let group = groups[index] as common.Position

		if (
			compareCursors(group.start, start) > 0 &&
			(below === null || compareCursors(group.start, below.at) < 0)
		) {
			below = { at: group.start, chunk: groupChunk(index) }
			break
		}
	}

	if (below !== null) {
		return below.chunk
	}

	// NOTE: A Comment written below the last entry belongs to no entry at all —
	// the printer flushes it before the closing brace, and it is still held to
	// being present.
	let loose: Array<string> = []
	section.loose.push(loose)

	return loose
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
	// are printed. `Terminal.inspect(list::map((box) { <- box.value })) § note` ends the
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
