import { parseDocument } from "@essence-lang/compiler/documents"
import type { common, parser } from "@essence-lang/interfaces"
import { quotedText } from "@essence-lang/runtime/String"

import { format, type FormatResult, guarded } from "./index"

// Writes recorded values of inline snapshots back into a test file's source.
// See "Writing snapshots into the source" in DEVELOPMENT.md.

type SnapshotUpdate = {
	// Where the recorded value stands, or the `snapshot` keyword where no
	// value has been recorded yet.
	position: common.Position
	text: string
}

type SnapshotWrite = FormatResult & {
	// How many updates found their slot. The rest are dropped, since the file
	// changed under the run.
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
	// Back to front, so that splicing one slot leaves every slot before it
	// where the parse found it.
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

		// An empty snapshot's update names the `snapshot` keyword, and the
		// value goes after it. A recorded value is replaced where it stands.
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

	// Each slot written to holds exactly the recorded text. Slots are found by
	// index, since the splice moved Positions, and `format` checks the rest.
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

	// Formatted only when the source already was, so that a test run never
	// reformats lines nobody touched. See "Writing snapshots into the source"
	// in DEVELOPMENT.md.
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

// The runtime's quoted printer, whose literal the Lexer reads back as the same
// value. It spells a newline as `\n`, so a recorded value stays on one line.
function literalOf(text: string): string {
	return quotedText(text)
}

// A slot an inline recorded value stands in. A stored snapshot names a file
// instead, and nothing here writes one.
type Slot = {
	// The slot's place among the file's inline slots, which a splice moves but
	// never reorders.
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

// Cursors are 1-based on both axes. The offset is the length of the lines
// before the Cursor's, newlines included, plus the column minus one.
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
