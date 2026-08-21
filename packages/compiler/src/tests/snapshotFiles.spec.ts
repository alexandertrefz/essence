import { describe, expect, it } from "bun:test"
import path from "node:path"

import { writeInlineSnapshots } from "@essence-lang/formatter/snapshots"
import type { parser } from "@essence-lang/interfaces"

import { parseWithDiagnostics } from "../parser/index"
import {
	parseSnapshotFile,
	printSnapshotFile,
	snapshotFileOf,
} from "../testing/snapshots"

// NOTE: The two places a recorded snapshot ends up: the `__snapshots__`
// companion beside the source, and the source itself. Both are read back after
// they are written, because what a snapshot is worth is exactly what survives
// the round trip.

describe("The snapshot companion file", () => {
	it("names a file beside the source it belongs to", () => {
		expect(snapshotFileOf("/project/Season.es")).toBe(
			path.join("/project", "__snapshots__", "Season.es.snap"),
		)
	})

	it("reads back what it wrote", () => {
		let entries = {
			"season-report": "After round 7\n 1  Lions   19\n 2  Tigers  16",
			plain: "one line",
		}

		expect(parseSnapshotFile(printSnapshotFile(entries))).toEqual(entries)
	})

	it("keeps a blank line, a tab and a trailing newline exactly", () => {
		let entries = {
			awkward: "first\n\n\tindented\n",
			quoted: 'holds a " and a \\ in the name',
		}

		expect(parseSnapshotFile(printSnapshotFile(entries))).toEqual(entries)
	})

	it("writes the entries in name order", () => {
		let written = printSnapshotFile({ b: "second", a: "first" })

		expect(written.indexOf('snapshot "a"')).toBeLessThan(
			written.indexOf('snapshot "b"'),
		)
	})

	it("escapes a quote in a name and reads it back", () => {
		let entries = { 'a "quoted" name': "text" }

		expect(parseSnapshotFile(printSnapshotFile(entries))).toEqual(entries)
	})

	// NOTE: The format writes `\n` and only `\n`, so a `\r` in a file is either
	// a value's own or a tool's rewriting of the line endings — and which of
	// the two it is, is what the whole file says rather than one line.
	it("keeps a carriage return a value put there", () => {
		let entries = { odd: "before\rafter" }

		expect(parseSnapshotFile(printSnapshotFile(entries))).toEqual(entries)
	})

	it("reads a file whose line endings were rewritten", () => {
		let entries = { plain: "one line", other: "two\nlines" }
		let rewritten = printSnapshotFile(entries).replaceAll("\n", "\r\n")

		expect(parseSnapshotFile(rewritten)).toEqual(entries)
	})

	it("answers with nothing for a file that says nothing", () => {
		expect(parseSnapshotFile("")).toEqual({})
		expect(parseSnapshotFile("§ just a comment\n")).toEqual({})
	})
})

const source = `implementation {
	constant x = 1
}

tests {
	test "renders" {
		expect x matches snapshot
		expect x matches snapshot "old"
		expect x matches snapshot from "stored"
	}
}
`

function slotsOf(text: string): Array<parser.SnapshotNode> {
	let { program } = parseWithDiagnostics(text)
	let test = program.tests?.nodes[0] as parser.TestNode

	return test.body.map(
		(node) =>
			(node as parser.ExpectStatementNode)
				.snapshot as parser.SnapshotNode,
	)
}

describe("Writing a recorded value into the source", () => {
	it("writes one where nothing was recorded", () => {
		let slots = slotsOf(source)
		let written = writeInlineSnapshots(source, [
			{ position: slots[0]!.valuePosition, text: "1" },
		])

		expect(written.refusal).toBeNull()
		expect(written.applied).toBe(1)
		expect(written.text).toContain('expect x matches snapshot "1"')
	})

	it("replaces one that was", () => {
		let slots = slotsOf(source)
		let written = writeInlineSnapshots(source, [
			{ position: slots[1]!.valuePosition, text: "new" },
		])

		expect(written.text).toContain('expect x matches snapshot "new"')
		expect(written.text).not.toContain('"old"')
	})

	// NOTE: Essence has no multi-line String Literal, so a value that spans
	// lines is spelled on one with the escapes the Lexer knows — and read back
	// as the very text it was recorded from.
	it("spells a value that spans lines on one line", () => {
		let slots = slotsOf(source)
		let text = 'two\nlines "quoted" {braced}\tand tabbed'
		let written = writeInlineSnapshots(source, [
			{ position: slots[0]!.valuePosition, text },
		])

		expect(written.refusal).toBeNull()
		expect(
			(slotsOf(written.text)[0] as parser.SnapshotNode).value?.value,
		).toBe(text)
	})

	it("leaves a stored snapshot's name alone", () => {
		let slots = slotsOf(source)
		let written = writeInlineSnapshots(source, [
			{ position: slots[2]!.valuePosition, text: "text" },
		])

		expect(written.applied).toBe(0)
		expect(written.changed).toBe(false)
		expect(written.text).toBe(source)
	})

	it("writes several slots at once", () => {
		let slots = slotsOf(source)
		let written = writeInlineSnapshots(source, [
			{ position: slots[0]!.valuePosition, text: "first" },
			{ position: slots[1]!.valuePosition, text: "second" },
		])

		expect(written.applied).toBe(2)
		expect(written.text).toContain('snapshot "first"')
		expect(written.text).toContain('snapshot "second"')
	})

	// NOTE: A Position that names nothing is a file that moved under the run.
	// Nothing is written at it, and nothing else is either.
	it("writes nothing at a slot that is not there", () => {
		let written = writeInlineSnapshots(source, [
			{
				position: {
					start: { line: 99, column: 1 },
					end: { line: 99, column: 2 },
				},
				text: "nowhere",
			},
		])

		expect(written.applied).toBe(0)
		expect(written.text).toBe(source)
	})

	// NOTE: Recording a snapshot is a test run writing into a source, and a run
	// that also reformatted the file would be a build formatting your code.
	// Only the slot moves; the rest of the file is left exactly as it was
	// written, however it was written.
	it("leaves an unformatted file unformatted but for the slot", () => {
		let messy = [
			"implementation {",
			"    constant   x =  1",
			"}",
			"",
			"tests {",
			'\ttest "renders" {',
			"\t\texpect x matches snapshot",
			"\t}",
			"}",
			"",
		].join("\n")
		let slots = slotsOf(messy)
		let written = writeInlineSnapshots(messy, [
			{ position: slots[0]!.valuePosition, text: "1" },
		])

		expect(written.refusal).toBeNull()
		expect(written.applied).toBe(1)
		expect(written.text).toContain("    constant   x =  1")
		expect(written.text).toContain('expect x matches snapshot "1"')
	})

	it("leaves a file that does not parse alone", () => {
		let written = writeInlineSnapshots("implementation {", [
			{
				position: {
					start: { line: 1, column: 1 },
					end: { line: 1, column: 2 },
				},
				text: "x",
			},
		])

		expect(written.refusal?.kind).toBe("syntax")
		expect(written.text).toBe("implementation {")
	})
})
