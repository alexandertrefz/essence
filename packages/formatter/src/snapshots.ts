import { parseDocument } from "@essence-lang/compiler/documents"
import type { common, parser } from "@essence-lang/interfaces"

import { format, type FormatResult, guarded } from "./index"

// NOTE: Writing a recorded value back into the source, which is what the first
// run of an inline `matches snapshot` does and what `essence test --update`
// does to one that differs.
//
// It lives in the FORMATTER because a recorded value is written by a machine
// into a file a person reads: the literal is spelled here, and the result is
// formatted here, so what a run leaves behind is source in the shape the
// project's own tools would have written.
//
// The literal is SPLICED over the slot rather than printed out of a changed
// tree, for one reason: a String Literal is printed verbatim from the span it
// occupies, so a Literal that is not in the source yet has nothing to print.
// What holds the splice honest is the check below — the rewritten source is
// parsed again, and every slot has to hold exactly the text it was given.

type SnapshotUpdate = {
	// NOTE: Where the recorded value stands, or would stand — the `snapshot`
	// Keyword's own span where the source has never held one. It comes off the
	// run's own event, which the Compiler filled from the span table.
	position: common.Position
	text: string
}

type SnapshotWrite = FormatResult & {
	// NOTE: How many of the updates found the slot they name. Fewer than were
	// handed over means the file moved under the run — nothing is written at a
	// Position that now means something else.
	applied: number
}

export function writeInlineSnapshots(
	source: string,
	updates: Array<SnapshotUpdate>,
	documentPath?: string,
): SnapshotWrite {
	return guarded(source, () =>
		writeUnguarded(source, updates, documentPath),
	) as SnapshotWrite
}

function writeUnguarded(
	source: string,
	updates: Array<SnapshotUpdate>,
	documentPath?: string,
): SnapshotWrite {
	let refused = (
		message: string,
		kind: "syntax" | "unsafe",
	): SnapshotWrite => ({
		text: source,
		changed: false,
		applied: 0,
		refusal: { kind, message, diagnostics: [] },
	})

	let { program, diagnostics } = parseDocument(source, documentPath)

	if (diagnostics.some((diagnostic) => diagnostic.severity === "error")) {
		return {
			text: source,
			changed: false,
			applied: 0,
			refusal: {
				kind: "syntax",
				message: "This file has syntax errors, so it was left alone.",
				diagnostics,
			},
		}
	}

	let slots = slotsOf(program)
	// NOTE: Back to front, so that splicing one slot leaves every slot before
	// it standing where the parse said it was.
	let wanted = updates
		.map((update) => ({
			update,
			slot: slots.find((slot) =>
				sameStart(slot.position, update.position),
			),
		}))
		.filter((wanted) => wanted.slot !== undefined)
		.sort(
			(left, right) =>
				offsetOf(source, right.update.position.start) -
				offsetOf(source, left.update.position.start),
		)

	if (wanted.length === 0) {
		return { text: source, changed: false, applied: 0, refusal: null }
	}

	let rewritten = source

	for (let { update, slot } of wanted) {
		let start = offsetOf(rewritten, update.position.start)
		let end = offsetOf(rewritten, update.position.end)
		let literal = literalOf(update.text)

		// NOTE: A snapshot nothing has recorded has no slot of its own — what
		// it names is the `snapshot` Keyword, and the value is written AFTER
		// it. One that holds a value is replaced where it stands.
		rewritten =
			rewritten.slice(0, start) +
			(slot?.empty === true
				? `${rewritten.slice(start, end)} ${literal}`
				: literal) +
			rewritten.slice(end)
	}

	let after = parseDocument(rewritten, documentPath)

	if (
		after.diagnostics.some((diagnostic) => diagnostic.severity === "error")
	) {
		return refused("The rewritten source no longer parses.", "unsafe")
	}

	// NOTE: The whole of the safety story for a splice: the slot that was
	// written into holds exactly the text the run recorded, and it is found by
	// its PLACE among the file's slots rather than by its Position, which the
	// splice moved. It says nothing about the rest of the file, which is why
	// the formatting below runs through `format`, whose own gate does.
	if (!holds(slotsOf(after.program), wanted)) {
		return refused(
			"The rewritten source does not hold what was recorded.",
			"unsafe",
		)
	}

	let formatted = format(rewritten, { documentPath })

	if (formatted.refusal !== null) {
		return {
			...formatted,
			text: rewritten,
			changed: true,
			applied: wanted.length,
		}
	}

	// NOTE: The formatter's answer is taken for a file that was ALREADY
	// formatted, and only then. Recording a snapshot is something a test run
	// does to a source, and a run that reformatted forty lines nobody touched
	// would be a build formatting your code — which this project does not do,
	// and which no report would mention. Where the file was already in the
	// shape `esfmt` writes, the only lines that can differ are the ones the
	// splice touched, so the recorded literal still arrives formatted: broken
	// across lines if it is long, indented where it stands.
	if (format(source, { documentPath }).text !== source) {
		return {
			text: rewritten,
			changed: true,
			applied: wanted.length,
			refusal: null,
		}
	}

	return {
		text: formatted.text,
		changed: formatted.text !== source,
		applied: wanted.length,
		refusal: null,
	}
}

// NOTE: A String Literal spelling the text, with every escape the Lexer knows.
// A newline is `\n` rather than a line of its own: Essence has no multi-line
// String Literal, so a recorded value that spans lines is spelled on one — and
// a value long enough for that to read badly is what a STORED snapshot is for.
function literalOf(text: string): string {
	return `"${text
		.replaceAll("\\", "\\\\")
		.replaceAll('"', '\\"')
		.replaceAll("{", "\\{")
		.replaceAll("}", "\\}")
		.replaceAll("\t", "\\t")
		.replaceAll("\r", "\\r")
		.replaceAll("\n", "\\n")}"`
}

// NOTE: Every slot an INLINE recorded value stands in. A stored snapshot names
// a file instead, and nothing here writes into a source for one.
type Slot = {
	// NOTE: Which inline slot of the file this is. A splice moves Positions and
	// never reorders slots, so the place is what a rewritten file is checked by.
	index: number
	position: common.Position
	empty: boolean
	value: string | undefined
}

function slotsOf(program: parser.Program): Array<Slot> {
	let slots: Array<Slot> = []

	for (let node of assertionsOf(program)) {
		let snapshot = node.snapshot

		if (snapshot !== null && snapshot.name === null) {
			slots.push({
				index: slots.length,
				position: snapshot.valuePosition,
				empty: snapshot.value === null,
				value: snapshot.value?.value,
			})
		}
	}

	return slots
}

function holds(
	slots: Array<Slot>,
	wanted: Array<{ update: SnapshotUpdate; slot?: Slot }>,
): boolean {
	return wanted.every(
		({ update, slot }) =>
			slot !== undefined && slots[slot.index]?.value === update.text,
	)
}

function assertionsOf(
	program: parser.Program,
): Array<parser.ExpectStatementNode | parser.RequireStatementNode> {
	let found: Array<parser.ExpectStatementNode | parser.RequireStatementNode> =
		[]

	let visit = (value: unknown): void => {
		if (Array.isArray(value)) {
			for (let item of value) {
				visit(item)
			}

			return
		}

		if (value === null || typeof value !== "object") {
			return
		}

		let node = value as Record<string, unknown>

		if (
			(node["nodeType"] === "ExpectStatement" ||
				node["nodeType"] === "RequireStatement") &&
			node["snapshot"] !== null &&
			node["snapshot"] !== undefined
		) {
			found.push(
				node as unknown as
					| parser.ExpectStatementNode
					| parser.RequireStatementNode,
			)
		}

		for (let member of Object.values(node)) {
			visit(member)
		}
	}

	visit(program.tests)

	return found
}

// NOTE: Essence Cursors are 1-based on both axes, and a column stands one past
// the character before it — so the offset of a Cursor is the length of every
// line above it, the newlines included, plus the column minus one.
function offsetOf(source: string, cursor: common.Cursor): number {
	let offset = 0
	let line = 1

	while (line < cursor.line) {
		let next = source.indexOf("\n", offset)

		if (next === -1) {
			return source.length
		}

		offset = next + 1
		line += 1
	}

	return Math.min(offset + cursor.column - 1, source.length)
}

function sameStart(left: common.Position, right: common.Position): boolean {
	return (
		left.start.line === right.start.line &&
		left.start.column === right.start.column
	)
}
