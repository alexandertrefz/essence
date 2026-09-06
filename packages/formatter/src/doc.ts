// NOTE: A Wadler-style document algebra. The printer never decides where a
// line break goes — it describes the shape of the code as a Doc, and this
// module picks the layout that fits the target width. That split is what keeps
// the per-node printing rules readable: they say "these parts belong together,
// and if they do not fit, break here", not "if the column is past 80 then …".

// NOTE: Indentation is emitted as tabs, but width has to be measured in
// columns, so a tab counts as this many. It is the width the corpus is written
// against and the one the editors are configured for.
export const TAB_WIDTH = 4

// NOTE: The columns a line is laid out to. `printDoc` is handed the width it
// works to rather than reading this — the algebra itself has no opinion about
// how wide a page is — and this is the width the corpus is written to, which is
// why it sits beside the tab it is measured in. The printer reads it to answer
// the one question that is about the line rather than about the column: whether
// something is too wide to be written on one WHEREVER it stands.
export const WIDTH = 80

// NOTE: One line's share of an alignment run: how wide it reads left of the
// column the run lines up on, and how wide the whole of it reads flat.
//
// `fitWidth` is what says whether the padding is worth writing at the column
// the run turns out to stand at — a line whose padded width runs past the page
// breaks, and a line that breaks may put the very thing the column is drawn
// through onto a line of its own, or, as a `match` Handler's `{` does, open a
// block the column has no business running through. It is null where a break
// changes nothing about the column: an assignment's `=` is written after its
// head wherever that head ends, and only what follows it is ever moved down,
// so it holds its column however far the line runs on.
export type AlignmentItem = {
	headWidth: number
	fitWidth: number | null
}

// NOTE: A run of sibling lines lining one column up, resolved by the renderer
// rather than by whoever built it: how much padding each line carries is a
// question about the column the run STANDS at, and nothing knows that column
// until the run is reached.
//
// `maxSpan` is the most padding a line is worth carrying to reach its block's
// column; `resolved` remembers the answer per amount of room the run was
// reached with, because the renderer asks for it once to measure a line and
// again to write it.
//
// `partedByBreaks` is whether a line the run takes out for breaking parts it:
// the lines above that one and the lines below it line up among themselves,
// and never with each other. A `match` Handler that breaks opens a block, and
// a column carried across a block would run through two tables — so a `match`
// is parted where a `define` is not, since a `define` arm that breaks moves
// its `if` down and opens nothing.
type AlignmentRun = {
	items: Array<AlignmentItem>
	maxSpan: number
	partedByBreaks: boolean
	resolved: Map<number, Array<number>>
}

// NOTE: The padding one line carries to its run's column. It is handed to the
// printer before anyone knows whether the line joins a run at all, and
// `joinAlignment` is what puts it in one — a slot that joined none is written
// as nothing, the way an unpadded line always was.
export type AlignDoc = {
	kind: "align"
	run: AlignmentRun | null
	index: number
}

export type Doc =
	| { kind: "text"; value: string; verbatim: boolean }
	| { kind: "concat"; parts: Array<Doc> }
	// NOTE: One node covers all three break kinds. `soft` renders as nothing
	// rather than a space when the group is flat; `hard` never renders flat at
	// all and forces every group enclosing it to break.
	| { kind: "line"; soft: boolean; hard: boolean }
	| { kind: "breakParent" }
	// NOTE: `expandable` marks the one group of an Argument that gives way
	// when the Argument is hugged — a Function literal's body, a Record's or
	// a List's brackets. Measured inside an `expand`, such a group is taken to
	// break, so the measure ends at its first line, while every other group
	// in there is measured whole and flat.
	//
	// `breakIfTailFits` holds back the break unless it helps: when set, a group
	// that does not fit flat still stays flat if the line it opens on is
	// already past the width, or if the line its break would end on —
	// `breakIfTailFits` itself, at the group's indent, followed by everything
	// after the group — would not fit either.
	| {
			kind: "group"
			contents: Doc
			shouldBreak: boolean
			expandable: boolean
			breakIfTailFits: Doc | null
	  }
	| { kind: "indent"; contents: Doc }
	| { kind: "ifBreak"; broken: Doc; flat: Doc }
	// NOTE: Several layouts for one thing, tried in order: the first is
	// offered flat, every later one is taken if its FIRST line fits, and the
	// last is the fallback. A hard break inside one state does not force the
	// groups around it to break — that is the point of it: a trailing
	// callback Argument brings its own block, and the call around it must
	// still be free to stay on one line.
	| { kind: "conditional"; states: Array<Doc> }
	// NOTE: Contents laid out in their expanded form: printed in break mode
	// (what is inside still fits itself flat where it can), and measured up
	// to the first line of the first `expandable` group in them. This is how
	// a hugged trailing Argument is measured — `xs::map((n) {` and no further
	// — without deciding the enclosing call on what the body holds.
	| { kind: "expand"; contents: Doc }
	// NOTE: Text written at the end of the current line but never measured
	// against the width — a trailing Comment. Its length is the author's
	// business, not the layout's, so it must not be what tears the code in
	// front of it apart.
	| { kind: "lineSuffix"; value: string }
	// NOTE: Items separated by `line`s that break one at a time rather than
	// all at once: as many items as fit share a line, and only the separator
	// after the item that runs out is broken. `parts` alternates item,
	// separator, item, … — the separators are `line`s or things holding one.
	| { kind: "fill"; parts: Array<Doc> }
	// NOTE: Zero width until the renderer reaches it, which is the whole point
	// of it: the run it belongs to is resolved against the room the line was
	// reached with, and no one holding a Doc knows that room.
	| AlignDoc

// NOTE: `hug` and `expand` are measuring modes only, never modes the renderer
// prints in. A `conditional` measures its first state in `hug` mode, which is
// flat except that the `expand` inside it switches to `expand` mode: nested
// groups are measured flat there unless they are `expandable`, which are taken
// to break. Measured from outside — by a group around it asking whether IT
// fits — the same state is plain flat, and an `expand` is transparent.
type Mode = "flat" | "break" | "hug" | "expand"

type Command = [indent: number, mode: Mode, doc: Doc]

// NOTE: One piece of output, remembering whether it came from verbatim text —
// which is what the line-end trimming has to know to leave a multi-line String
// Literal's spaces alone.
type Segment = { value: string; verbatim: boolean }

export function text(value: string): Doc {
	return { kind: "text", value, verbatim: false }
}

// NOTE: Text the renderer hands through untouched — a String Literal sliced
// back out of the source, or a Comment. Trailing spaces in it are characters
// of the file rather than layout, so the line-end trimming stops at it.
export function verbatim(value: string): Doc {
	return { kind: "text", value, verbatim: true }
}

export function concat(parts: Array<Doc>): Doc {
	return { kind: "concat", parts }
}

export const line: Doc = { kind: "line", soft: false, hard: false }
export const softline: Doc = { kind: "line", soft: true, hard: false }
export const hardline: Doc = { kind: "line", soft: false, hard: true }

// NOTE: Renders as nothing and forces every enclosing group to break, the way
// a hard line does without spending a line break of its own. A Comment runs to
// the end of its line, so nothing may ever be laid out after one — this is
// what takes the flat shape off the table for a block whose last Statement
// carries a trailing Comment, without deciding where the break goes.
export const breakParent: Doc = { kind: "breakParent" }

export function group(
	contents: Doc,
	options?: {
		shouldBreak?: boolean
		expandable?: boolean
		breakIfTailFits?: Doc
	},
): Doc {
	return {
		kind: "group",
		contents,
		shouldBreak: options?.shouldBreak ?? false,
		expandable: options?.expandable ?? false,
		breakIfTailFits: options?.breakIfTailFits ?? null,
	}
}

export function expand(contents: Doc): Doc {
	return { kind: "expand", contents }
}

export function indent(contents: Doc): Doc {
	return { kind: "indent", contents }
}

export function ifBreak(broken: Doc, flat: Doc): Doc {
	return { kind: "ifBreak", broken, flat }
}

export function conditionalGroup(states: Array<Doc>): Doc {
	return { kind: "conditional", states }
}

export function lineSuffix(value: string): Doc {
	return { kind: "lineSuffix", value }
}

export function fill(parts: Array<Doc>): Doc {
	return { kind: "fill", parts }
}

// NOTE: Named, and mutable, for the reason `text` is: a line is laid out
// before it is known which run it belongs to, or whether it belongs to one.
export function alignmentSlot(): AlignDoc {
	return { kind: "align", run: null, index: -1 }
}

export function alignmentRun(
	maxSpan: number,
	{ partedByBreaks = false }: { partedByBreaks?: boolean } = {},
): AlignmentRun {
	return { items: [], maxSpan, partedByBreaks, resolved: new Map() }
}

// NOTE: Puts one line in a run, which is what gives its slot a padding to
// write. Everything a run needs is settled while the Doc is built; nothing
// here is touched again once the renderer has started.
export function joinAlignment(
	run: AlignmentRun,
	slot: AlignDoc,
	item: AlignmentItem,
): void {
	slot.run = run
	slot.index = run.items.length

	run.items.push(item)
}

// NOTE: How much padding each line of a run carries when the run is reached
// with `room` columns left of the page — the width of the page, less the
// indentation the run stands at.
//
// A line whose padded width runs past that room breaks, and a line that breaks
// need not keep the thing the column is drawn through on its head's line: a
// `define` arm writes its `if` below, where no column reaches it, while every
// sibling is padded out to a column it no longer stands in. Such a line is
// taken out of the run, and the lines either side of it line up without it —
// with each other, or, in a run that is `partedByBreaks`, each side on its
// own. This is what can not be settled where the run is built: whether a line
// fits is a question about the column it starts at.
//
// Taking one line out never widens another line's block on its own, but it
// does join the two lines either side of it into one, which can — so the pass
// runs again until nothing more comes out. It always ends: a line is only ever
// taken out, never put back.
//
// Blocks are greedy left to right rather than optimal, because a greedy pass
// is stable under a second run and an optimal partition need not be: a block
// is a maximal stretch of adjacent lines whose heads span no more than
// `maxSpan` — the widest minus the narrowest — measured that way rather than
// against the neighbour above, which would let a slow ramp of widths pad the
// first line far past the budget. A block of one is left unpadded.
function resolveAlignment(run: AlignmentRun, room: number): Array<number> {
	let remembered = run.resolved.get(room)

	if (remembered !== undefined) {
		return remembered
	}

	let items = run.items
	let padding = items.map(() => 0)
	let taken = items.map(() => false)

	for (;;) {
		padding.fill(0)

		// NOTE: The stretches of lines still in the run that may line up with
		// each other: all of them, or, where a line taken out parts the run,
		// those on each side of it.
		let stretches: Array<Array<number>> = [[]]

		for (let index = 0; index < items.length; index++) {
			if (!taken[index]) {
				;(stretches[stretches.length - 1] as Array<number>).push(index)
			} else if (run.partedByBreaks) {
				stretches.push([])
			}
		}

		for (let members of stretches) {
			let start = 0
			let narrowest = 0
			let widest = 0

			let flushBlock = (end: number) => {
				if (end - start > 1) {
					for (let at = start; at < end; at++) {
						let index = members[at] as number

						padding[index] =
							widest - (items[index] as AlignmentItem).headWidth
					}
				}

				start = end
			}

			for (let at = 0; at < members.length; at++) {
				let width = (items[members[at] as number] as AlignmentItem)
					.headWidth

				if (
					at > start &&
					Math.max(widest, width) - Math.min(narrowest, width) >
						run.maxSpan
				) {
					flushBlock(at)
				}

				if (at === start) {
					narrowest = width
					widest = width
				} else {
					narrowest = Math.min(narrowest, width)
					widest = Math.max(widest, width)
				}
			}

			flushBlock(members.length)
		}

		let dropped = false

		for (let index = 0; index < items.length; index++) {
			let item = items[index] as AlignmentItem

			if (
				!taken[index] &&
				item.fitWidth !== null &&
				item.fitWidth + (padding[index] as number) > room
			) {
				taken[index] = true
				dropped = true
			}
		}

		if (!dropped) {
			break
		}
	}

	run.resolved.set(room, padding)

	return padding
}

function alignmentPadding(slot: AlignDoc, room: number): number {
	if (slot.run === null) {
		return 0
	}

	return resolveAlignment(slot.run, room)[slot.index] ?? 0
}

export function join(separator: Doc, parts: Array<Doc>): Doc {
	let result: Array<Doc> = []

	for (let index = 0; index < parts.length; index++) {
		if (index > 0) {
			result.push(separator)
		}

		result.push(parts[index] as Doc)
	}

	return concat(result)
}

// NOTE: Measured in code points rather than UTF-16 units so that the box
// drawing and em dashes the corpus uses in divider Comments count as the one
// column they occupy. Exported because the printer's alignment runs measure
// their columns against the same ruler the renderer lays them out with.
export function stringWidth(value: string): number {
	let width = 0

	for (let character of value) {
		width += character === "\t" ? TAB_WIDTH : 1
	}

	return width
}

// NOTE: What a Doc reads as on one line, or null when it can never be on one —
// it holds a hard break, or a group already resolved to break. Used to ask a
// question the renderer answers too late: whether a `match` Handler is the kind
// that stays on its own line, and so whether its brace joins an alignment run.
export function renderFlat(doc: Doc): string | null {
	let out: Array<string> = []
	let commands: Array<Doc> = [doc]

	while (commands.length > 0) {
		let current = commands.pop() as Doc

		switch (current.kind) {
			case "text":
				out.push(current.value)
				break

			case "concat":
				for (
					let index = current.parts.length - 1;
					index >= 0;
					index--
				) {
					commands.push(current.parts[index] as Doc)
				}
				break

			case "indent":
				commands.push(current.contents)
				break

			case "group":
				if (current.shouldBreak) {
					return null
				}

				commands.push(current.contents)
				break

			case "line":
				if (current.hard) {
					return null
				}

				if (!current.soft) {
					out.push(" ")
				}
				break

			case "breakParent":
				return null

			case "ifBreak":
				commands.push(current.flat)
				break

			case "conditional":
				commands.push(current.states[0] as Doc)
				break

			case "expand":
				commands.push(current.contents)
				break

			case "lineSuffix":
				out.push(current.value)
				break

			case "fill":
				for (
					let index = current.parts.length - 1;
					index >= 0;
					index--
				) {
					commands.push(current.parts[index] as Doc)
				}
				break

			// NOTE: Padding has no width until the column it is written at is
			// known, and there is no column here. A Doc measured around one is
			// a line whose run takes it out on its flat width, and that width
			// is the line's own — the padding is exactly the part of it the
			// run has yet to settle.
			case "align":
				break
		}
	}

	return out.join("")
}

// NOTE: A hard line break inside a group means that group can never render
// flat, and neither can any group around it — otherwise `fits` would measure a
// candidate layout that the renderer would refuse to produce. Marking those
// groups up front, once, is what lets the render loop treat `shouldBreak` as a
// simple flag. Returns whether the subtree forces a break.
function propagateBreaks(doc: Doc): boolean {
	switch (doc.kind) {
		case "text":
			return false

		case "line":
			return doc.hard

		case "breakParent":
			return true

		case "concat": {
			let broken = false

			for (let part of doc.parts) {
				if (propagateBreaks(part)) {
					broken = true
				}
			}

			return broken
		}

		case "indent":
			return propagateBreaks(doc.contents)

		case "ifBreak":
			// NOTE: Deliberately does not propagate. The broken branch exists
			// only for the case where the enclosing group already broke, so
			// letting a break inside it force that group would be circular.
			propagateBreaks(doc.broken)
			propagateBreaks(doc.flat)

			return false

		case "group": {
			if (propagateBreaks(doc.contents)) {
				doc.shouldBreak = true
			}

			return doc.shouldBreak
		}

		// NOTE: Deliberately does not propagate either. Each state is marked
		// up inside, but a block inside one state is that state's own affair;
		// the whole point of offering states is that the enclosing layout is
		// decided by what fits, not by a hard break three levels down.
		case "conditional":
			for (let state of doc.states) {
				propagateBreaks(state)
			}

			return false

		case "expand":
			return propagateBreaks(doc.contents)

		case "lineSuffix":
			return false

		case "fill": {
			let broken = false

			for (let part of doc.parts) {
				if (propagateBreaks(part)) {
					broken = true
				}
			}

			return broken
		}

		case "align":
			return false
	}
}

// NOTE: Whether `next` rendered flat fits in `remaining` columns. The commands
// still queued matter as much as the candidate does — `(a, b)` fits only if the
// `)` that follows it fits too — so the scan continues into `restCommands`
// until it reaches a break, which is where the line would end anyway.
//
// `width` is the width of the page rather than what is left of the line: an
// alignment run is resolved against the room its line was reached with, and
// that is the page less the indentation, not the columns still free here.
function fits(
	next: Command,
	restCommands: Array<Command>,
	remaining: number,
	width: number,
): boolean {
	let restIndex = restCommands.length
	let commands: Array<Command> = [next]

	while (remaining >= 0) {
		if (commands.length === 0) {
			if (restIndex === 0) {
				return true
			}

			restIndex--
			commands.push(restCommands[restIndex] as Command)

			continue
		}

		let [commandIndent, mode, doc] = commands.pop() as Command

		switch (doc.kind) {
			case "text":
				remaining -= stringWidth(doc.value)
				break

			case "concat":
				for (let index = doc.parts.length - 1; index >= 0; index--) {
					commands.push([
						commandIndent,
						mode,
						doc.parts[index] as Doc,
					])
				}
				break

			case "indent":
				commands.push([commandIndent + 1, mode, doc.contents])
				break

			case "group":
				commands.push([
					commandIndent,
					doc.shouldBreak || (mode === "expand" && doc.expandable)
						? "break"
						: mode === "expand"
							? "flat"
							: mode,
					doc.contents,
				])
				break

			case "expand":
				commands.push([
					commandIndent,
					mode === "hug" ? "expand" : mode,
					doc.contents,
				])
				break

			case "line":
				// NOTE: A break ends the line, so everything measured so far
				// is everything that had to fit.
				if (mode === "break" || mode === "expand" || doc.hard) {
					return true
				}

				if (!doc.soft) {
					remaining -= 1
				}
				break

			// NOTE: Zero width — the groups it forces to break were already
			// marked by `propagateBreaks`, so here there is nothing to measure.
			case "breakParent":
				break

			case "ifBreak":
				commands.push([
					commandIndent,
					mode,
					mode === "flat" || mode === "hug" ? doc.flat : doc.broken,
				])
				break

			// NOTE: Measured as its first state when flat and its last when
			// broken — the two the renderer would print in those modes. Only
			// the conditional's own decision measures in `hug` mode; from
			// here it is a plain flat measure, so a nested `expand` does not
			// cut an outer group's measure short.
			case "conditional":
				commands.push([
					commandIndent,
					mode === "break" ? "break" : "flat",
					(mode === "break"
						? doc.states[doc.states.length - 1]
						: doc.states[0]) as Doc,
				])
				break

			// NOTE: Zero width, by definition.
			case "lineSuffix":
				break

			case "fill":
				for (let index = doc.parts.length - 1; index >= 0; index--) {
					commands.push([
						commandIndent,
						mode,
						doc.parts[index] as Doc,
					])
				}
				break

			// NOTE: Measured exactly as the renderer will write it: both ask
			// the run for the same room, so a line the run keeps is one the
			// renderer is bound to leave flat.
			case "align":
				remaining -= alignmentPadding(
					doc,
					width - commandIndent * TAB_WIDTH,
				)
				break
		}
	}

	return false
}

export function printDoc(doc: Doc, width: number): string {
	propagateBreaks(doc)

	let commands: Array<Command> = [[0, "break", doc]]
	let out: Array<Segment> = []
	let column = 0
	// NOTE: Trailing Comments waiting for the end of the line they were
	// written on. Flushed before the next line break is written, so they land
	// after everything else on the line — including a comma the layout put
	// after the thing they trail.
	let suffixes: Array<string> = []

	let flushSuffixes = () => {
		for (let suffix of suffixes) {
			out.push({ value: suffix, verbatim: true })
		}

		suffixes = []
	}

	while (commands.length > 0) {
		let [commandIndent, mode, current] = commands.pop() as Command

		switch (current.kind) {
			case "text":
				out.push({ value: current.value, verbatim: current.verbatim })
				column += stringWidth(current.value)
				break

			case "concat":
				for (
					let index = current.parts.length - 1;
					index >= 0;
					index--
				) {
					commands.push([
						commandIndent,
						mode,
						current.parts[index] as Doc,
					])
				}
				break

			case "indent":
				commands.push([commandIndent + 1, mode, current.contents])
				break

			// NOTE: Inside a group that fit flat, everything fits flat — the
			// measure covered the whole of it — so a nested group is not asked
			// again. Asking again is not just wasted: a `conditional`'s hugged
			// state is printed flat past the point its own measure covered,
			// and a group re-measured there against the rest of the line
			// would break a Parameter list the hug had already placed.
			case "group": {
				let flat: Command = [commandIndent, "flat", current.contents]

				if (
					!current.shouldBreak &&
					(mode === "flat" ||
						fits(flat, commands, width - column, width) ||
						(current.breakIfTailFits !== null &&
							!(
								column < width &&
								fits(
									[
										commandIndent,
										"flat",
										current.breakIfTailFits,
									],
									commands,
									width - commandIndent * TAB_WIDTH,
									width,
								)
							)))
				) {
					commands.push(flat)
				} else {
					commands.push([commandIndent, "break", current.contents])
				}
				break
			}

			case "line":
				if (mode === "flat" && !current.hard) {
					if (!current.soft) {
						out.push({ value: " ", verbatim: false })
						column += 1
					}

					break
				}

				flushSuffixes()
				out.push({
					value: "\n" + "\t".repeat(commandIndent),
					verbatim: false,
				})
				column = commandIndent * TAB_WIDTH
				break

			case "breakParent":
				break

			case "ifBreak":
				commands.push([
					commandIndent,
					mode,
					mode === "break" ? current.broken : current.flat,
				])
				break

			case "conditional": {
				let states = current.states
				let first: Command = [commandIndent, "flat", states[0] as Doc]

				if (
					fits(
						[commandIndent, "hug", states[0] as Doc],
						commands,
						width - column,
						width,
					)
				) {
					commands.push(first)
					break
				}

				let chosen: Command = [
					commandIndent,
					"break",
					states[states.length - 1] as Doc,
				]

				for (let index = 1; index < states.length - 1; index++) {
					let candidate: Command = [
						commandIndent,
						"flat",
						states[index] as Doc,
					]

					if (
						fits(
							[commandIndent, "hug", states[index] as Doc],
							commands,
							width - column,
							width,
						)
					) {
						chosen = candidate
						break
					}
				}

				commands.push(chosen)
				break
			}

			case "expand":
				commands.push([commandIndent, "break", current.contents])
				break

			case "lineSuffix":
				suffixes.push(current.value)
				break

			// NOTE: Each separator is decided on its own: the item after it is
			// measured flat, and the separator breaks only if that item would
			// not fit on the line as it stands. Everything the renderer already
			// knows how to do; only the decision is made pairwise.
			case "fill": {
				let parts = current.parts

				if (parts.length === 0) {
					break
				}

				let [content, separator, ...rest] = parts as [
					Doc,
					Doc?,
					...Array<Doc>,
				]

				let contentFlat: Command = [commandIndent, "flat", content]
				let contentFits = fits(contentFlat, [], width - column, width)

				if (separator === undefined) {
					commands.push(
						contentFits
							? contentFlat
							: [commandIndent, "break", content],
					)
					break
				}

				let remaining: Command = [commandIndent, mode, fill(rest)]
				let next = rest[0]

				// NOTE: Whether the separator breaks depends on whether the
				// NEXT item, laid flat after a flat separator, would fit.
				let pairFits =
					next !== undefined &&
					fits(
						[
							commandIndent,
							"flat",
							concat([content, separator, next]),
						],
						[],
						width - column,
						width,
					)

				commands.push(remaining)
				commands.push([
					commandIndent,
					pairFits ? "flat" : "break",
					separator,
				])
				commands.push(
					contentFits
						? contentFlat
						: [commandIndent, "break", content],
				)
				break
			}

			case "align": {
				let padding = " ".repeat(
					alignmentPadding(
						current,
						width - commandIndent * TAB_WIDTH,
					),
				)

				out.push({ value: padding, verbatim: false })
				column += padding.length
				break
			}
		}
	}

	flushSuffixes()

	// NOTE: A break followed by another break lays down the first line's
	// indentation with nothing after it. Trimming line ends here costs one pass
	// and saves every caller from having to emit blank lines in a special way.
	// Verbatim text is exempt: its trailing spaces are characters of the file,
	// not layout, so the trim reaches back only as far as the last verbatim
	// piece of each line.
	let lines: Array<Array<Segment>> = [[]]

	for (let segment of out) {
		let pieces = segment.value.split("\n")

		for (let [index, piece] of pieces.entries()) {
			if (index > 0) {
				lines.push([])
			}

			if (piece !== "") {
				let current = lines[lines.length - 1] as Array<Segment>

				current.push({ value: piece, verbatim: segment.verbatim })
			}
		}
	}

	return lines.map((segments) => trimmedLine(segments)).join("\n")
}

function trimmedLine(segments: Array<Segment>): string {
	while (segments.length > 0) {
		let last = segments[segments.length - 1] as Segment

		if (last.verbatim) {
			break
		}

		let trimmed = last.value.trimEnd()

		if (trimmed === "") {
			segments.pop()

			continue
		}

		segments[segments.length - 1] = { value: trimmed, verbatim: false }

		break
	}

	return segments.map((segment) => segment.value).join("")
}
