import { describe, expect, it } from "bun:test"

import { parseDocument } from "@essence-lang/compiler/documents"

import { format } from "../index"
import { sectionSpans } from "../sections"
import { commentAnchors } from "../trivia"

// NOTE: A whole Program written as the lines it is made of, because a Module
// section is read for how its groups are laid out across lines, and a
// `\n`-escaped string hides exactly that.
function source(...lines: Array<string>): string {
	return lines.join("\n") + "\n"
}

let formatted = (text: string) => format(text).text

// NOTE: The anchors the safety gate compares, section-aware — the groups and
// entries of a Module section come out sorted, so they are compared per group
// and per entry rather than per Token.
let anchors = (text: string) =>
	commentAnchors(text, sectionSpans(parseDocument(text).program)).join("\n")

describe("module sections", () => {
	describe("canonical order", () => {
		// NOTE: This order is not a preference: dispatch over imported
		// Namespaces is defined to follow it, so the sort can never change which
		// Namespace a Method call resolves to.
		it("sorts groups by specifier", () => {
			expect(
				formatted(
					source(
						"import {",
						'\tfrom "./Geometry.es" { Rectangle }',
						'\tfrom "../math/Math.es" { PI }',
						'\tfrom "./Bounds.es" { Circle }',
						"}",
						"",
						"implementation {}",
					),
				),
			).toBe(
				source(
					"import {",
					'\tfrom "../math/Math.es" { PI }',
					'\tfrom "./Bounds.es" { Circle }',
					'\tfrom "./Geometry.es" { Rectangle }',
					"}",
					"",
					"implementation {}",
				),
			)
		})

		it("sorts the names inside a group", () => {
			expect(
				formatted(
					source(
						"import {",
						'\tfrom "./Geometry.es" {',
						"\t\tRectangle",
						"\t\tCircle",
						"\t\tarea",
						"\t}",
						"}",
						"",
						"implementation {}",
					),
				),
			).toBe(
				source(
					"import {",
					'\tfrom "./Geometry.es" {',
					"\t\tCircle",
					"\t\tRectangle",
					"\t\tarea",
					"\t}",
					"}",
					"",
					"implementation {}",
				),
			)
		})

		it("lists an export block's local names before its re-exports", () => {
			expect(
				formatted(
					source(
						"implementation {",
						"\tconstant zeta = 1",
						"\tconstant alpha = 2",
						"}",
						"",
						"export {",
						'\tfrom "./Geometry.es" { Rectangle }',
						"\tzeta",
						"\talpha",
						"}",
					),
				),
			).toBe(
				source(
					"implementation {",
					"\tconstant zeta  = 1",
					"\tconstant alpha = 2",
					"}",
					"",
					"export {",
					"\talpha",
					"\tzeta",
					'\tfrom "./Geometry.es" { Rectangle }',
					"}",
				),
			)
		})

		// NOTE: Two groups written for one file are left as two — merging them
		// would have to decide which keeps its Comments — and stand next to each
		// other, ordered by the first name in each, which is where a reader
		// finds them to fold together.
		it("keeps two groups for one file, side by side", () => {
			expect(
				formatted(
					source(
						"import {",
						'\tfrom "./Geometry.es" { Rectangle }',
						'\tfrom "./Bounds.es" { Box }',
						'\tfrom "./Geometry.es" { Circle }',
						"}",
						"",
						"implementation {}",
					),
				),
			).toBe(
				source(
					"import {",
					'\tfrom "./Bounds.es" { Box }',
					'\tfrom "./Geometry.es" { Circle }',
					'\tfrom "./Geometry.es" { Rectangle }',
					"}",
					"",
					"implementation {}",
				),
			)
		})

		// NOTE: A blank line the author left between two groups cannot survive
		// the sort — which two groups the gap would end up between is decided by
		// the sort rather than by anything the author said.
		it("drops a blank line written between two groups", () => {
			expect(
				formatted(
					source(
						"import {",
						'\tfrom "./Geometry.es" { Circle }',
						"",
						'\tfrom "../math/Math.es" { PI }',
						"}",
						"",
						"implementation {}",
					),
				),
			).toBe(
				source(
					"import {",
					'\tfrom "../math/Math.es" { PI }',
					'\tfrom "./Geometry.es" { Circle }',
					"}",
					"",
					"implementation {}",
				),
			)
		})
	})

	// NOTE: A group of one name stays on one line, the way a `case` with one
	// short Statement does; two or more names stand one to a line. Nothing is
	// aligned: a column is what made adding one wide name rewrite every line
	// beside it.
	describe("shape", () => {
		it("writes a group of two or more names one to a line", () => {
			expect(
				formatted(
					source(
						"import {",
						'\tfrom "./Geometry.es" { Circle Rectangle }',
						"}",
						"",
						"implementation {}",
					),
				),
			).toBe(
				source(
					"import {",
					'\tfrom "./Geometry.es" {',
					"\t\tCircle",
					"\t\tRectangle",
					"\t}",
					"}",
					"",
					"implementation {}",
				),
			)
		})

		it("writes a group of one name on one line", () => {
			expect(
				formatted(
					source(
						"import {",
						'\tfrom "./Geometry.es" {',
						"\t\tRectangle",
						"\t}",
						"}",
						"",
						"implementation {}",
					),
				),
			).toBe(
				source(
					"import {",
					'\tfrom "./Geometry.es" { Rectangle }',
					"}",
					"",
					"implementation {}",
				),
			)
		})

		it("lines nothing up", () => {
			let text = source(
				"import {",
				'\tfrom "./A.es" { A }',
				'\tfrom "./Geometry.es" { RectangleMeasurable }',
				"}",
				"",
				"implementation {}",
			)

			expect(formatted(text)).toBe(text)
		})

		it("normalises the spacing around as", () => {
			expect(
				formatted(
					source(
						"import {",
						'\tfrom   "../math/Math.es"   {   PI    as    Pi   }',
						"}",
						"",
						"implementation {}",
					),
				),
			).toBe(
				source(
					"import {",
					'\tfrom "../math/Math.es" { PI as Pi }',
					"}",
					"",
					"implementation {}",
				),
			)
		})

		it("writes out a group of one name that does not fit on its line", () => {
			let specifier = '"./' + "deeply/".repeat(8) + 'Geometry.es"'

			expect(
				formatted(
					source(
						"import {",
						"\tfrom " + specifier + " { RectangleMeasurable }",
						"}",
						"",
						"implementation {}",
					),
				),
			).toBe(
				source(
					"import {",
					"\tfrom " + specifier + " {",
					"\t\tRectangleMeasurable",
					"\t}",
					"}",
					"",
					"implementation {}",
				),
			)
		})
	})

	describe("idempotence", () => {
		let canonical = source(
			"import {",
			'\tfrom "../math/Math.es" { PI as Pi }',
			'\tfrom "./Geometry.es" {',
			"\t\tRectangle",
			"\t\tRectangleMeasurable",
			"\t}",
			"}",
			"",
			"implementation {",
			"\tconstant area = 1",
			"}",
			"",
			"export {",
			"\tarea",
			'\tfrom "./Geometry.es" { Rectangle }',
			"}",
		)

		it("leaves a canonical Program byte for byte alone", () => {
			let result = format(canonical)

			expect(result.refusal).toBeNull()
			expect(result.changed).toBe(false)
		})

		it("is a no-op on a block it has already sorted", () => {
			let once = format(
				source(
					"import {",
					'\tfrom "./Geometry.es" {',
					"\t\tRectangleMeasurable",
					"\t\tRectangle",
					"\t}",
					'\tfrom "../math/Math.es" { PI as Pi }',
					"}",
					"",
					"implementation {",
					"\tconstant area = 1",
					"}",
					"",
					"export {",
					'\tfrom "./Geometry.es" { Rectangle }',
					"\tarea",
					"}",
				),
			)

			expect(once.text).toBe(canonical)
			expect(format(once.text).changed).toBe(false)
		})
	})

	describe("comments", () => {
		it("moves a comment written above a group along with it", () => {
			expect(
				formatted(
					source(
						"import {",
						"\t§ the shapes",
						'\tfrom "./Geometry.es" { Rectangle }',
						'\tfrom "./Bounds.es" { Box }',
						"}",
						"",
						"implementation {}",
					),
				),
			).toBe(
				source(
					"import {",
					'\tfrom "./Bounds.es" { Box }',
					"\t§ the shapes",
					'\tfrom "./Geometry.es" { Rectangle }',
					"}",
					"",
					"implementation {}",
				),
			)
		})

		it("moves a comment written above a name along with it", () => {
			expect(
				formatted(
					source(
						"import {",
						'\tfrom "./Geometry.es" {',
						"\t\t§ the witness",
						"\t\tRectangleMeasurable",
						"\t\tCircle",
						"\t}",
						"}",
						"",
						"implementation {}",
					),
				),
			).toBe(
				source(
					"import {",
					'\tfrom "./Geometry.es" {',
					"\t\tCircle",
					"\t\t§ the witness",
					"\t\tRectangleMeasurable",
					"\t}",
					"}",
					"",
					"implementation {}",
				),
			)
		})

		// NOTE: A Comment above the one name of a group rules the flat shape
		// out — it runs to the end of its line, and nothing can follow it there.
		it("writes out a group whose one name carries a comment", () => {
			let text = source(
				"import {",
				'\tfrom "./Geometry.es" {',
				"\t\t§ the witness",
				"\t\tRectangleMeasurable",
				"\t}",
				"}",
				"",
				"implementation {}",
			)

			expect(formatted(text)).toBe(text)
		})

		it("keeps a trailing comment on the name it trails", () => {
			expect(
				formatted(
					source(
						"implementation {}",
						"",
						"export {",
						'\tfrom "./Geometry.es" {',
						"\t\tRectangle § never bound locally",
						"\t\tCircle",
						"\t}",
						"}",
					),
				),
			).toBe(
				source(
					"implementation {}",
					"",
					"export {",
					'\tfrom "./Geometry.es" {',
					"\t\tCircle",
					"\t\tRectangle § never bound locally",
					"\t}",
					"}",
				),
			)
		})

		// NOTE: The note after a group written flat is the name's rather than
		// the group's, so it stays on the name's line if the group is ever
		// written out — which a Comment above the name is what forces here.
		it("gives a comment trailing a flat group to its one name", () => {
			expect(
				formatted(
					source(
						"import {",
						"\t§ above",
						'\tfrom "./Geometry.es" { Rectangle } § the note',
						"}",
						"",
						"implementation {}",
					),
				),
			).toBe(
				source(
					"import {",
					"\t§ above",
					'\tfrom "./Geometry.es" { Rectangle } § the note',
					"}",
					"",
					"implementation {}",
				),
			)

			expect(
				formatted(
					source(
						"import {",
						'\tfrom "./Geometry.es" {',
						"\t\t§ about the name",
						"\t\tRectangle } § the note",
						"}",
						"",
						"implementation {}",
					),
				),
			).toBe(
				source(
					"import {",
					'\tfrom "./Geometry.es" {',
					"\t\t§ about the name",
					"\t\tRectangle § the note",
					"\t}",
					"}",
					"",
					"implementation {}",
				),
			)
		})

		it("keeps a comment that trails a group's opening brace", () => {
			let text = source(
				"import {",
				'\tfrom "./Geometry.es" { § the shapes',
				"\t\tRectangle",
				"\t}",
				"}",
				"",
				"implementation {}",
			)

			expect(formatted(text)).toBe(text)
		})

		it("keeps a comment written below a group's last name", () => {
			let text = source(
				"import {",
				'\tfrom "./Geometry.es" {',
				"\t\tRectangle",
				"\t\t§ nothing else from here",
				"\t}",
				"}",
				"",
				"implementation {}",
			)

			expect(formatted(text)).toBe(text)
		})

		it("keeps a comment that trails a group's closing brace", () => {
			let text = source(
				"import {",
				'\tfrom "./Geometry.es" {',
				"\t\tCircle",
				"\t\tRectangle",
				"\t} § the shapes",
				"}",
				"",
				"implementation {}",
			)

			expect(formatted(text)).toBe(text)
		})

		it("keeps a comment that trails the block's opening brace", () => {
			let text = source(
				"import { § everything this Module reaches for",
				'\tfrom "./A.es" { A }',
				"}",
				"",
				"implementation {}",
			)

			expect(formatted(text)).toBe(text)
		})

		it("keeps a comment written below the last group", () => {
			let text = source(
				"import {",
				'\tfrom "./A.es" { A }',
				"\t§ nothing else, on purpose",
				"}",
				"",
				"implementation {}",
			)

			expect(formatted(text)).toBe(text)
		})

		it("keeps a comment written above the import block", () => {
			let text = source(
				"§ about the file",
				"",
				"import {",
				'\tfrom "./A.es" { A }',
				"}",
				"",
				"implementation {}",
			)

			expect(formatted(text)).toBe(text)
		})

		it("keeps a comment written above the export block", () => {
			let text = source(
				"implementation {",
				"\tconstant a = 1",
				"}",
				"",
				"§ what this Module offers",
				"export {",
				"\ta",
				"}",
			)

			expect(formatted(text)).toBe(text)
		})
	})

	describe("the safety gate", () => {
		// NOTE: The round trip the whole provision has to survive: both blocks,
		// an implementation between them, and every Comment where it was written.
		it("round-trips a Module with both sections and refuses nothing", () => {
			let text = source(
				"import {",
				'\tfrom "./Geometry.es" {',
				"\t\tRectangleMeasurable",
				"\t\tRectangle",
				"\t}",
				'\tfrom "../math/Math.es" { PI as Pi }',
				"}",
				"",
				"implementation {",
				"",
				"\tfunction describe(_ shape: Rectangle) -> String {",
				'\t\t<- "area: {shape::area()::multiplyWith(Pi)}"',
				"\t}",
				"",
				"\tnamespace Described for Rectangle {",
				"\t\tdescription() -> String {",
				"\t\t\t<- describe(@)",
				"\t\t}",
				"\t}",
				"}",
				"",
				"export {",
				"\tdescribe",
				"\tDescribed as RectangleDescribed",
				'\tfrom "./Geometry.es" { Rectangle } § re-export, never bound locally',
				"}",
			)
			let result = format(text)

			expect(result.refusal).toBeNull()
			expect(result.text).toBe(
				source(
					"import {",
					'\tfrom "../math/Math.es" { PI as Pi }',
					'\tfrom "./Geometry.es" {',
					"\t\tRectangle",
					"\t\tRectangleMeasurable",
					"\t}",
					"}",
					"",
					"implementation {",
					"",
					"\tfunction describe(_ shape: Rectangle) -> String {",
					'\t\t<- "area: {shape::area()::multiplyWith(Pi)}"',
					"\t}",
					"",
					"\tnamespace Described for Rectangle {",
					"\t\tdescription() -> String {",
					"\t\t\t<- describe(@)",
					"\t\t}",
					"\t}",
					"}",
					"",
					"export {",
					"\tDescribed as RectangleDescribed",
					"\tdescribe",
					'\tfrom "./Geometry.es" { Rectangle } § re-export, never bound locally',
					"}",
				),
			)
			expect(anchors(result.text)).toBe(anchors(text))
		})

		// NOTE: A sorted block is the one place the Token sequence is allowed to
		// change, so the anchors are grouped per group and per entry there — and
		// a re-sort with every Comment still on its own owner has to read as no
		// change at all.
		it("reads a re-sorted block with its comments intact as unchanged", () => {
			let written = source(
				"import {",
				"\t§ note",
				'\tfrom "./B.es" {',
				"\t\t§ second",
				"\t\tZ",
				"\t\tA",
				"\t}",
				'\tfrom "./A.es" { A }',
				"}",
				"",
				"implementation {}",
			)
			let sorted = source(
				"import {",
				'\tfrom "./A.es" { A }',
				"\t§ note",
				'\tfrom "./B.es" {',
				"\t\tA",
				"\t\t§ second",
				"\t\tZ",
				"\t}",
				"}",
				"",
				"implementation {}",
			)

			expect(anchors(sorted)).toBe(anchors(written))
		})

		// NOTE: What the grouping buys: a Comment that ends up against another
		// owner is still present, still in order, and only which entry or group
		// it rides with gives it away.
		it("still notices a comment that changed which group it rides with", () => {
			let riding = source(
				"import {",
				"\t§ note",
				'\tfrom "./A.es" { A }',
				'\tfrom "./B.es" { B }',
				"}",
				"",
				"implementation {}",
			)
			let moved = source(
				"import {",
				'\tfrom "./A.es" { A }',
				"\t§ note",
				'\tfrom "./B.es" { B }',
				"}",
				"",
				"implementation {}",
			)

			expect(anchors(moved)).not.toBe(anchors(riding))
		})

		it("still notices a comment that changed which name it rides with", () => {
			let riding = source(
				"import {",
				'\tfrom "./A.es" {',
				"\t\t§ note",
				"\t\tA",
				"\t\tB",
				"\t}",
				"}",
				"",
				"implementation {}",
			)
			let moved = source(
				"import {",
				'\tfrom "./A.es" {',
				"\t\tA",
				"\t\t§ note",
				"\t\tB",
				"\t}",
				"}",
				"",
				"implementation {}",
			)

			expect(anchors(moved)).not.toBe(anchors(riding))
		})

		// NOTE: The same name written in two groups is two entries, and a
		// Comment that crossed from one to the other has moved — which is what
		// keying an entry by its group's specifier is for.
		it("still notices a comment that crossed between two groups' same name", () => {
			let riding = source(
				"import {",
				'\tfrom "./A.es" {',
				"\t\t§ note",
				"\t\tSame",
				"\t}",
				'\tfrom "./B.es" { Same }',
				"}",
				"",
				"implementation {}",
			)
			let moved = source(
				"import {",
				'\tfrom "./A.es" { Same }',
				'\tfrom "./B.es" {',
				"\t\t§ note",
				"\t\tSame",
				"\t}",
				"}",
				"",
				"implementation {}",
			)

			expect(anchors(moved)).not.toBe(anchors(riding))
		})

		it("still notices a comment that moved from a group to its first name", () => {
			let onGroup = source(
				"import {",
				'\tfrom "./A.es" { § note',
				"\t\tA",
				"\t}",
				"}",
				"",
				"implementation {}",
			)
			let onName = source(
				"import {",
				'\tfrom "./A.es" {',
				"\t\t§ note",
				"\t\tA",
				"\t}",
				"}",
				"",
				"implementation {}",
			)

			expect(anchors(onName)).not.toBe(anchors(onGroup))
		})

		it("still notices a comment dropped from a block", () => {
			let written = source(
				"import {",
				"\t§ note",
				'\tfrom "./A.es" { A }',
				"}",
				"",
				"implementation {}",
			)
			let dropped = source(
				"import {",
				'\tfrom "./A.es" { A }',
				"}",
				"",
				"implementation {}",
			)

			expect(anchors(dropped)).not.toBe(anchors(written))
		})

		// NOTE: Grouping per owner does not make the block a place where a
		// Comment may end up anywhere — one carried out of it, above the Keyword,
		// leaves its chunk and shows up in the sequence instead.
		it("still notices a comment carried out of a block", () => {
			let inside = source(
				"import {",
				"\t§ note",
				'\tfrom "./A.es" { A }',
				"}",
				"",
				"implementation {}",
			)
			let above = source(
				"§ note",
				"import {",
				'\tfrom "./A.es" { A }',
				"}",
				"",
				"implementation {}",
			)

			expect(anchors(above)).not.toBe(anchors(inside))
		})

		// NOTE: A Comment written between a name and its alias belongs to no
		// owner the printer can name, and the gate is what keeps that from
		// being formatted anyway.
		it("leaves a comment written inside an entry's own span alone", () => {
			let text = source(
				"import {",
				'\tfrom "./Geometry.es" {',
				"\t\tRectangle § why",
				"\t\tas Rect",
				"\t\tCircle",
				"\t}",
				"}",
				"",
				"implementation {}",
			)
			let result = format(text)

			expect(result.refusal?.kind).toBe("unsafe")
			expect(result.text).toBe(text)
		})
	})

	describe("what the blocks do not change", () => {
		it("gathers a group the author spread over lines", () => {
			expect(
				formatted(
					source(
						"import {",
						"\tfrom",
						'\t"./Geometry.es"',
						"\t{ Rectangle }",
						"}",
						"",
						"implementation {}",
					),
				),
			).toBe(
				source(
					"import {",
					'\tfrom "./Geometry.es" { Rectangle }',
					"}",
					"",
					"implementation {}",
				),
			)
		})

		// NOTE: All four Module Keywords stay spellable as names, so an entry may
		// be called `as` or `from` — in an export block too, where `from` opens
		// a group only when a specifier follows it.
		it("writes an entry whose own name is a Module keyword", () => {
			let text = source(
				"import {",
				'\tfrom "./A.es" {',
				"\t\tas as as",
				"\t\tfrom",
				"\t}",
				"}",
				"",
				"implementation {",
				"\tconstant import = 1",
				"}",
				"",
				"export {",
				"\tas",
				"\tfrom",
				"\timport",
				"}",
			)

			expect(formatted(text)).toBe(text)
		})

		it("keeps an empty block written by hand", () => {
			expect(
				formatted(source("import {}", "", "implementation {}")),
			).toBe(source("import {}", "", "implementation {}"))
		})

		it("keeps a Program that writes neither block untouched", () => {
			let text = source("implementation {", "\tconstant a = 1", "}")

			expect(formatted(text)).toBe(text)
		})
	})
})
