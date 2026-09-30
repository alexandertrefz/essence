// A Wadler-style document algebra. The Printer describes the shape of the code
// as a `Doc`, and `printDoc` picks the layout that fits the width.
// See "The document algebra" in DEVELOPMENT.md.

export const TAB_WIDTH = 4

// The columns a line is laid out to, which `printDoc` takes as an argument. The
// command line's help screen is laid out to it too.
export const WIDTH = 80

// One line of an alignment run. Its `fitWidth` is null where breaking the line
// leaves the column in place. See "Alignment runs" in DEVELOPMENT.md.
export type AlignmentItem = {
	headWidth: number
	fitWidth: number | null
}

// Sibling lines lining up one column, resolved when the renderer reaches them.
// The padding is kept per room, since the renderer asks once to measure a line
// and again to write it.
type AlignmentRun = {
	items: Array<AlignmentItem>
	maxSpan: number
	partedByBreaks: boolean
	resolved: Map<number, Array<number>>
}

// The padding one line carries to its run's column. A slot that joins no run
// is written as nothing.
export type AlignDoc = {
	kind: "align"
	run: AlignmentRun | null
	index: number
}

export type Doc =
	| { kind: "text"; value: string; verbatim: boolean }
	| { kind: "concat"; parts: Array<Doc> }
	// `soft` prints nothing rather than a space when flat. `hard` never prints
	// flat and breaks every group around it.
	| { kind: "line"; soft: boolean; hard: boolean }
	| { kind: "breakParent" }
	// In a hugged Argument, the `expandable` group gives way, such as a Function
	// literal's body. A `breakIfTailFits` holds back a break that would not help.
	// See "Hugging" in DEVELOPMENT.md.
	| {
			kind: "group"
			contents: Doc
			shouldBreak: boolean
			expandable: boolean
			breakIfTailFits: Doc | null
	  }
	| { kind: "indent"; contents: Doc }
	| { kind: "ifBreak"; broken: Doc; flat: Doc }
	// Layouts for one thing, measured in order. The first that fits prints,
	// and the last is the fallback. See "Hugging" in DEVELOPMENT.md.
	| { kind: "conditional"; states: Array<Doc> }
	// Contents printed broken and measured up to the first line of their first
	// `expandable` group, as a hugged trailing Argument is.
	| { kind: "expand"; contents: Doc }
	// Text at the end of the line that is never measured, since a trailing
	// Comment's length must not break the code before it.
	| { kind: "lineSuffix"; value: string }
	// Items whose separators break one at a time, so as many items as fit share
	// a line. `parts` alternates item and separator.
	| { kind: "fill"; parts: Array<Doc> }
	// Zero width until the renderer reaches it and knows the room of its line.
	| AlignDoc

// `hug` and `expand` only measure, and the renderer never prints in them.
// See "Hugging" in DEVELOPMENT.md.
type Mode = "flat" | "break" | "hug" | "expand"

type Command = [indent: number, mode: Mode, doc: Doc]

// A piece of output, and whether it is verbatim text, which the line-end trim
// leaves alone.
type Segment = { value: string; verbatim: boolean }

export function text(value: string): Doc {
	return { kind: "text", value, verbatim: false }
}

// Text printed untouched, such as a String Literal sliced from the source or a
// Comment. Its trailing spaces belong to the file, so the line-end trim keeps
// them.
export function verbatim(value: string): Doc {
	return { kind: "text", value, verbatim: true }
}

export function concat(parts: Array<Doc>): Doc {
	return { kind: "concat", parts }
}

export const line: Doc = { kind: "line", soft: false, hard: false }
export const softline: Doc = { kind: "line", soft: true, hard: false }
export const hardline: Doc = { kind: "line", soft: false, hard: true }

// Prints nothing and breaks every group around it, as a hard line does. The
// Printer puts one after a trailing Comment, since nothing may follow it.
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

// Mutable, since a line is laid out before it is known which run it joins, if
// any.
export function alignmentSlot(): AlignDoc {
	return { kind: "align", run: null, index: -1 }
}

export function alignmentRun(
	maxSpan: number,
	{ partedByBreaks = false }: { partedByBreaks?: boolean } = {},
): AlignmentRun {
	return { items: [], maxSpan, partedByBreaks, resolved: new Map() }
}

// Puts a line in a run, which gives its slot a padding. A run's lines all join
// it before rendering starts.
export function joinAlignment(
	run: AlignmentRun,
	slot: AlignDoc,
	item: AlignmentItem,
): void {
	slot.run = run
	slot.index = run.items.length

	run.items.push(item)
}

// The padding of each line of a run reached with `room` columns, the width
// less the run's indentation. See "Alignment runs" in DEVELOPMENT.md.
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

		// The lines that may line up with each other. In a run that is
		// `partedByBreaks`, a line taken out starts a new stretch.
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

// One column per code point, and `TAB_WIDTH` per tab. Exported so that the
// Printer measures alignment with the renderer's ruler.
export function stringWidth(value: string): number {
	let width = 0

	for (let character of value) {
		width += character === "\t" ? TAB_WIDTH : 1
	}

	return width
}

// What a Doc reads as on one line, or null when it holds a hard break or a
// group that must break. The Printer asks before rendering, such as whether a
// `match` Handler stays on one line and so joins an alignment run.
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

			// No width without a column. A run judges a line by its flat width,
			// which is the line's own without the padding.
			case "align":
				break
		}
	}

	return out.join("")
}

// Marks every group that holds a hard break as broken, except through `ifBreak`
// and `conditional`, and answers whether `doc` forces a break.
// See "The document algebra" in DEVELOPMENT.md.
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
			// Does not propagate: the broken branch only exists once the group
			// around it broke, so forcing that group from it would be circular.
			propagateBreaks(doc.broken)
			propagateBreaks(doc.flat)

			return false

		case "group": {
			if (propagateBreaks(doc.contents)) {
				doc.shouldBreak = true
			}

			return doc.shouldBreak
		}

		// Does not propagate either: what fits decides a `conditional`, not a
		// hard break inside one of its states.
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

// Whether `next` fits flat in `remaining` columns, measured on into
// `restCommands` until a break ends the line. The `width` is the page's, since
// an alignment run is resolved against the page less its indentation.
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
				// A break ends the line, so everything measured so far
				// is everything that had to fit.
				if (mode === "break" || mode === "expand" || doc.hard) {
					return true
				}

				if (!doc.soft) {
					remaining -= 1
				}
				break

			// Zero width, since `propagateBreaks` already broke its groups.
			case "breakParent":
				break

			case "ifBreak":
				commands.push([
					commandIndent,
					mode,
					mode === "flat" || mode === "hug" ? doc.flat : doc.broken,
				])
				break

			// Its first state when flat and its last when broken, as the
			// renderer prints them. Measured plain flat, so a nested `expand`
			// cannot cut an outer group's measure short.
			case "conditional":
				commands.push([
					commandIndent,
					mode === "break" ? "break" : "flat",
					(mode === "break"
						? doc.states[doc.states.length - 1]
						: doc.states[0]) as Doc,
				])
				break

			// Zero width, by definition.
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

			// Asks the run for the same room the renderer will, so a line the
			// run keeps is one the renderer leaves flat.
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
	// Trailing Comments, written before the next line break so that they
	// follow everything else on their line.
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

			// Inside a group that printed flat, a nested group is not measured
			// again. See "The document algebra" in DEVELOPMENT.md.
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

			// Each separator breaks only if the item after it would not fit on
			// the line as it stands.
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

				// Whether the next item fits flat after a flat separator.
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

	// Trims line ends, so that a break after a break leaves an empty line. The
	// trim stops at verbatim text, whose trailing spaces belong to the file.
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
