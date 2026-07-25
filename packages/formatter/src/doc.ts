// NOTE: A Wadler-style document algebra. The printer never decides where a
// line break goes — it describes the shape of the code as a Doc, and this
// module picks the layout that fits the target width. That split is what keeps
// the per-node printing rules readable: they say "these parts belong together,
// and if they do not fit, break here", not "if the column is past 80 then …".

// NOTE: Indentation is emitted as tabs, but width has to be measured in
// columns, so a tab counts as this many. It is the width the corpus is written
// against and the one the editors are configured for.
export const TAB_WIDTH = 4

// NOTE: Named, and returned by `text`, so that a caller holding one can write
// to its `value` later. The `match` Handler alignment does exactly that: it
// lays a Handler out before it knows how wide its siblings are, and fills the
// padding in once the run has ended.
export type TextDoc = { kind: "text"; value: string }

export type Doc =
	| TextDoc
	| { kind: "concat"; parts: Array<Doc> }
	// NOTE: One node covers all three break kinds. `soft` renders as nothing
	// rather than a space when the group is flat; `hard` never renders flat at
	// all and forces every group enclosing it to break.
	| { kind: "line"; soft: boolean; hard: boolean }
	| { kind: "group"; contents: Doc; shouldBreak: boolean }
	| { kind: "indent"; contents: Doc }
	| { kind: "ifBreak"; broken: Doc; flat: Doc }

type Mode = "flat" | "break"

type Command = [indent: number, mode: Mode, doc: Doc]

export function text(value: string): TextDoc {
	return { kind: "text", value }
}

export function concat(parts: Array<Doc>): Doc {
	return { kind: "concat", parts }
}

export const line: Doc = { kind: "line", soft: false, hard: false }
export const softline: Doc = { kind: "line", soft: true, hard: false }
export const hardline: Doc = { kind: "line", soft: false, hard: true }

export function group(contents: Doc, options?: { shouldBreak?: boolean }): Doc {
	return {
		kind: "group",
		contents,
		shouldBreak: options?.shouldBreak ?? false,
	}
}

export function indent(contents: Doc): Doc {
	return { kind: "indent", contents }
}

export function ifBreak(broken: Doc, flat: Doc): Doc {
	return { kind: "ifBreak", broken, flat }
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
// column they occupy.
function stringWidth(value: string): number {
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

			case "ifBreak":
				commands.push(current.flat)
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
	}
}

// NOTE: Whether `next` rendered flat fits in `remaining` columns. The commands
// still queued matter as much as the candidate does — `(a, b)` fits only if the
// `)` that follows it fits too — so the scan continues into `restCommands`
// until it reaches a break, which is where the line would end anyway.
function fits(
	next: Command,
	restCommands: Array<Command>,
	remaining: number,
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
					doc.shouldBreak ? "break" : mode,
					doc.contents,
				])
				break

			case "line":
				// NOTE: A break ends the line, so everything measured so far
				// is everything that had to fit.
				if (mode === "break" || doc.hard) {
					return true
				}

				if (!doc.soft) {
					remaining -= 1
				}
				break

			case "ifBreak":
				commands.push([
					commandIndent,
					mode,
					mode === "break" ? doc.broken : doc.flat,
				])
				break
		}
	}

	return false
}

export function printDoc(doc: Doc, width: number): string {
	propagateBreaks(doc)

	let commands: Array<Command> = [[0, "break", doc]]
	let out: Array<string> = []
	let column = 0

	while (commands.length > 0) {
		let [commandIndent, mode, current] = commands.pop() as Command

		switch (current.kind) {
			case "text":
				out.push(current.value)
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

			case "group": {
				let flat: Command = [commandIndent, "flat", current.contents]

				if (
					!current.shouldBreak &&
					fits(flat, commands, width - column)
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
						out.push(" ")
						column += 1
					}

					break
				}

				out.push("\n" + "\t".repeat(commandIndent))
				column = commandIndent * TAB_WIDTH
				break

			case "ifBreak":
				commands.push([
					commandIndent,
					mode,
					mode === "break" ? current.broken : current.flat,
				])
				break
		}
	}

	// NOTE: A break followed by another break lays down the first line's
	// indentation with nothing after it. Trimming line ends here costs one pass
	// and saves every caller from having to emit blank lines in a special way.
	return out
		.join("")
		.split("\n")
		.map((sourceLine) => sourceLine.trimEnd())
		.join("\n")
}
