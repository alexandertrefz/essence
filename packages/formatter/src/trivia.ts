import { Lexer } from "@essence-lang/compiler/lexer"
import { type common, lexer } from "@essence-lang/interfaces"

const TokenType = lexer.TokenType

export type Comment = {
	// As the Lexer read it, sigil included, trailing whitespace trimmed. It is
	// moved but never rewritten. See "Placing comments" in DEVELOPMENT.md.
	text: string
	startLine: number
	endLine: number
	// Whether only whitespace stands before it on its line. Then it belongs to
	// what follows it rather than to its line.
	ownLine: boolean
}

// A Lexer with no `ignore` call keeps the Comments and line breaks that the
// parser's token stream drops.
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
		// The Lexer throws only on an unterminated String, and `format` refuses
		// a source that does not parse before it gets here.
	}

	return comments
}

// A Module section's groups and entries in written order. An entry's `key` is
// its group's specifier, or empty for a bare export entry.
export type SectionSpan = {
	position: common.Position
	groups: Array<common.Position>
	entries: Array<{ position: common.Position; key: string }>
}

// A section's anchors, one chunk per entry and per group. A group's chunk holds
// its `from`, its specifier, its braces and their Comments.
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

// Every Token but the commas in order, with each Comment in its place. A
// Module section adds its chunks sorted. See "Comment anchors" in
// DEVELOPMENT.md.
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

	// Sorted, so a reordered section compares equal. Joined per chunk, so a
	// Comment that moved to another entry does not.
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
			// Without trailing whitespace, which the Printer trims.
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
		// Unreachable for a source that parsed, as in `collectComments`.
	}

	if (open !== null) {
		closeSection(open)
	}

	return anchors
}

// The chunk a Token in a Module section rides with, or null for a Token the
// sort cannot move. The rule is the Printer's own. See "Comment anchors" in
// DEVELOPMENT.md.
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

	// A Comment after the last entry, which the Printer writes before the
	// closing brace.
	let loose: Array<string> = []
	section.loose.push(loose)

	return loose
}

// The Comments in written order, handed out as the Printer walks the tree in
// source order. See "Placing comments" in DEVELOPMENT.md.
export class TriviaCursor {
	private comments: Array<Comment>
	private index: number

	constructor(comments: Array<Comment>) {
		this.comments = comments
		this.index = 0
	}

	// The own-line Comments at the front of the sequence that start before
	// `line`, consumed.
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

	// The Comment trailing `line`, taken wherever it stands in the sequence.
	// The outermost node ending on the line asks first. See "Placing comments"
	// in DEVELOPMENT.md.
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

	// Everything left over. A Comment that no node claimed is still written.
	takeRemaining(): Array<Comment> {
		let taken = this.comments.slice(this.index)
		this.index = this.comments.length

		return taken
	}

	hasMore(): boolean {
		return this.index < this.comments.length
	}
}
