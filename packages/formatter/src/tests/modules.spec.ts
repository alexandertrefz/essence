import { describe, expect, it } from "bun:test"

import { parseDocument } from "@essence-lang/compiler/documents"

import { format } from "../index"
import { sectionSpans } from "../sections"
import { commentAnchors } from "../trivia"

// A Program written as its lines, since these tests read how groups are laid
// out across lines, which a `\n`-escaped String hides.
function source(...lines: Array<string>): string {
	return lines.join("\n") + "\n"
}

let formatted = (text: string) => format(text).text

// The anchors the safety gate compares, with each Module section compared per
// group and per entry, since it comes out sorted.
let anchors = (text: string) =>
	commentAnchors(text, sectionSpans(parseDocument(text).program)).join("\n")

describe("module sections", () => {
	describe("canonical order", () => {
		// The compiler never dispatches in written order, so the sort cannot
		// change which Namespace a Method call resolves to.
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

		// Two groups for one file stay two, since merging them would have to
		// pick which keeps its Comments. They stand together, ordered by first
		// name.
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

		// A blank line survives only where the sort keeps the lines around it
		// together. Elsewhere it would part two lines the author never parted.
		it("drops a blank line written between two groups the sort parts", () => {
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

		it("drops a blank line written between two names the sort parts", () => {
			expect(
				formatted(
					source(
						"import {",
						'\tfrom "./Geometry.es" {',
						"\t\tCircle",
						"",
						"\t\tarea",
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

		it("keeps a blank line written between two groups the sort leaves side by side", () => {
			let text = source(
				"import {",
				'\tfrom "./Mirror.es" { mirrored }',
				"",
				'\tfrom "./Shapes.es" { Rectangle }',
				"}",
				"",
				"implementation {}",
			)

			expect(formatted(text)).toBe(text)
		})

		it("keeps a blank line written between two names the sort leaves side by side", () => {
			let text = source(
				"import {",
				'\tfrom "./Shapes.es" {',
				"\t\tRectangle",
				"",
				"\t\t§ the near miss",
				"\t\taera",
				"\t\tarea",
				"",
				"\t\t§ below the last name",
				"\t}",
				"}",
				"",
				"implementation {}",
			)

			expect(formatted(text)).toBe(text)
		})

		it("keeps a blank line written between the local names and the re-exports", () => {
			let text = source(
				"implementation {",
				"\tconstant alpha = 1",
				"}",
				"",
				"export {",
				"\talpha",
				"",
				'\tfrom "./Geometry.es" { Rectangle }',
				"}",
			)

			expect(formatted(text)).toBe(text)
		})

		it("keeps a blank line written between a Comment and the name below it", () => {
			let text = source(
				"import {",
				'\tfrom "./Geometry.es" {',
				"\t\tCircle",
				"\t\t§ the shapes with corners",
				"",
				"\t\tRectangle",
				"\t}",
				"}",
				"",
				"implementation {}",
			)

			expect(formatted(text)).toBe(text)
		})
	})

	// A group of one name stays on one line, and more names stand one per line.
	// Nothing is aligned, so adding a wide name rewrites no other line.
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

		// A Comment before the one name of a group rules out the flat shape,
		// since nothing can follow it on its line.
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

		// A Comment after a flat group is its name's, so it stays on the name's
		// line when the group breaks. A Comment before the name forces that here.
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
		// Both sections, an implementation between them, and every Comment
		// where it was written.
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

		// A sorted section is compared per group and per entry, so a re-sort
		// that keeps every Comment with its owner reads as no change.
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

		// A Comment that moved to another owner is still present and in order.
		// Only the group it rides with gives it away.
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

		// The same name in two groups is two entries, keyed by their groups'
		// specifiers, so a Comment crossing between them has moved.
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

		// A Comment carried out of the section, before its keyword, leaves its
		// chunk and shows up in the flat sequence instead.
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

		// A Comment between a name and its alias has no owner the Printer can
		// name, and the gate refuses to format it.
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

		// The Module keywords stay usable as names, so an entry may be called
		// `as` or `from`. In an export block, `from` opens a group only before a
		// specifier.
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
