import { describe, expect, it } from "bun:test"

import { parseDocument } from "@essence-lang/compiler/documents"

import { format } from "../index"
import { sectionSpans } from "../sections"
import { commentAnchors } from "../trivia"

// NOTE: A whole Program written as the lines it is made of. A Module section is
// read for the column its `from` Keywords line up in, and a `\n`-escaped string
// hides exactly that.
function source(...lines: Array<string>): string {
	return lines.join("\n") + "\n"
}

let formatted = (text: string) => format(text).text

// NOTE: The anchors the safety gate compares, section-aware — the entries of a
// Module section come out sorted, so they are compared per entry rather than
// per Token.
let anchors = (text: string) =>
	commentAnchors(text, sectionSpans(parseDocument(text).program)).join("\n")

describe("module sections", () => {
	describe("canonical order", () => {
		// NOTE: This order is not a preference: dispatch over imported
		// Namespaces is defined to follow it, so the sort can never change which
		// Namespace a Method call resolves to.
		it("sorts import entries by specifier, then by name", () => {
			expect(
				formatted(
					source(
						"import {",
						'\tRectangle from "./Geometry.es"',
						'\tPI from "../math/Math.es"',
						'\tCircle from "./Geometry.es"',
						"}",
						"",
						"implementation {}",
					),
				),
			).toBe(
				source(
					"import {",
					'\tPI        from "../math/Math.es"',
					'\tCircle    from "./Geometry.es"',
					'\tRectangle from "./Geometry.es"',
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
						'\tRectangle from "./Geometry.es"',
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
					'\tRectangle from "./Geometry.es"',
					"}",
				),
			)
		})

		it("sorts re-exports by specifier, then by name", () => {
			expect(
				formatted(
					source(
						"implementation {}",
						"",
						"export {",
						'\tRectangle from "./Geometry.es"',
						'\tPI from "../math/Math.es"',
						'\tCircle from "./Geometry.es"',
						"}",
					),
				),
			).toBe(
				source(
					"implementation {}",
					"",
					"export {",
					'\tPI        from "../math/Math.es"',
					'\tCircle    from "./Geometry.es"',
					'\tRectangle from "./Geometry.es"',
					"}",
				),
			)
		})

		// NOTE: A blank line the author left between two entries cannot survive
		// the sort — which two entries the gap would end up between is decided by
		// the sort rather than by anything the author said.
		it("drops a blank line written between two entries", () => {
			expect(
				formatted(
					source(
						"import {",
						'\tCircle from "./Geometry.es"',
						"",
						'\tPI from "../math/Math.es"',
						"}",
						"",
						"implementation {}",
					),
				),
			).toBe(
				source(
					"import {",
					'\tPI     from "../math/Math.es"',
					'\tCircle from "./Geometry.es"',
					"}",
					"",
					"implementation {}",
				),
			)
		})
	})

	describe("alignment", () => {
		it("puts every from one space past the widest left-hand side", () => {
			expect(
				formatted(
					source(
						"import {",
						'\tCircle from "./Geometry.es"',
						'\tRectangleMeasurable from "./Geometry.es"',
						"}",
						"",
						"implementation {}",
					),
				),
			).toBe(
				source(
					"import {",
					'\tCircle              from "./Geometry.es"',
					'\tRectangleMeasurable from "./Geometry.es"',
					"}",
					"",
					"implementation {}",
				),
			)
		})

		// NOTE: `PI as Pi` is one left-hand side, not a name with a suffix — the
		// column has to clear the whole spelling or the `from` lands inside it.
		it("measures an aliased entry at its full name as alias spelling", () => {
			expect(
				formatted(
					source(
						"import {",
						'\tPI as Pi from "../math/Math.es"',
						'\tE from "../math/Math.es"',
						"}",
						"",
						"implementation {}",
					),
				),
			).toBe(
				source(
					"import {",
					'\tE        from "../math/Math.es"',
					'\tPI as Pi from "../math/Math.es"',
					"}",
					"",
					"implementation {}",
				),
			)
		})

		it("normalises the spacing around as", () => {
			expect(
				formatted(
					source(
						"import {",
						'\tPI    as    Pi from "../math/Math.es"',
						"}",
						"",
						"implementation {}",
					),
				),
			).toBe(
				source(
					"import {",
					'\tPI as Pi from "../math/Math.es"',
					"}",
					"",
					"implementation {}",
				),
			)
		})

		// NOTE: Only the entries that carry a `from` are measured. An
		// `export { … }` block lists what a Module declares alongside what it
		// forwards, and padding a re-export out to the widest local name would
		// push its `from` halfway across the line rather than line anything up.
		it("does not measure a local export against the from column", () => {
			expect(
				formatted(
					source(
						"implementation {",
						"\tconstant somethingWithAVeryLongName = 1",
						"}",
						"",
						"export {",
						"\tsomethingWithAVeryLongName",
						'\tRectangle from "./Geometry.es"',
						"}",
					),
				),
			).toBe(
				source(
					"implementation {",
					"\tconstant somethingWithAVeryLongName = 1",
					"}",
					"",
					"export {",
					"\tsomethingWithAVeryLongName",
					'\tRectangle from "./Geometry.es"',
					"}",
				),
			)
		})

		it("aligns each block against its own widest entry", () => {
			expect(
				formatted(
					source(
						"import {",
						'\tRectangleMeasurable from "./Geometry.es"',
						"}",
						"",
						"implementation {}",
						"",
						"export {",
						'\tPI from "../math/Math.es"',
						'\tRectangle from "./Geometry.es"',
						"}",
					),
				),
			).toBe(
				source(
					"import {",
					'\tRectangleMeasurable from "./Geometry.es"',
					"}",
					"",
					"implementation {}",
					"",
					"export {",
					'\tPI        from "../math/Math.es"',
					'\tRectangle from "./Geometry.es"',
					"}",
				),
			)
		})
	})

	describe("idempotence", () => {
		let canonical = source(
			"import {",
			'\tPI as Pi            from "../math/Math.es"',
			'\tRectangle           from "./Geometry.es"',
			'\tRectangleMeasurable from "./Geometry.es"',
			"}",
			"",
			"implementation {",
			"\tconstant area = 1",
			"}",
			"",
			"export {",
			"\tarea",
			'\tRectangle from "./Geometry.es"',
			"}",
		)

		it("leaves a canonical Program byte for byte alone", () => {
			let result = format(canonical)

			expect(result.refusal).toBeNull()
			expect(result.changed).toBe(false)
		})

		it("is a no-op on a block it has already sorted and aligned", () => {
			let once = format(
				source(
					"import {",
					'\tRectangle from "./Geometry.es"',
					'\tPI as Pi from "../math/Math.es"',
					'\tRectangleMeasurable from "./Geometry.es"',
					"}",
					"",
					"implementation {",
					"\tconstant area = 1",
					"}",
					"",
					"export {",
					'\tRectangle from "./Geometry.es"',
					"\tarea",
					"}",
				),
			)

			expect(once.text).toBe(canonical)
			expect(format(once.text).changed).toBe(false)
		})
	})

	describe("comments", () => {
		it("moves a comment written above an entry along with it", () => {
			expect(
				formatted(
					source(
						"import {",
						"\t§ the witness",
						'\tRectangleMeasurable from "./Geometry.es"',
						'\tCircle from "./Geometry.es"',
						"}",
						"",
						"implementation {}",
					),
				),
			).toBe(
				source(
					"import {",
					'\tCircle              from "./Geometry.es"',
					"\t§ the witness",
					'\tRectangleMeasurable from "./Geometry.es"',
					"}",
					"",
					"implementation {}",
				),
			)
		})

		it("keeps a trailing comment on the entry it trails", () => {
			expect(
				formatted(
					source(
						"implementation {}",
						"",
						"export {",
						'\tRectangle from "./Geometry.es" § never bound locally',
						'\tCircle from "./Geometry.es"',
						"}",
					),
				),
			).toBe(
				source(
					"implementation {}",
					"",
					"export {",
					'\tCircle    from "./Geometry.es"',
					'\tRectangle from "./Geometry.es" § never bound locally',
					"}",
				),
			)
		})

		it("keeps a comment that trails the block's opening brace", () => {
			let text = source(
				"import { § everything this Module reaches for",
				'\tA from "./A.es"',
				"}",
				"",
				"implementation {}",
			)

			expect(formatted(text)).toBe(text)
		})

		it("keeps a comment written below the last entry", () => {
			let text = source(
				"import {",
				'\tA from "./A.es"',
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
				'\tA from "./A.es"',
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
				'\tRectangle from "./Geometry.es"',
				'\tPI as Pi from "../math/Math.es"',
				'\tRectangleMeasurable from "./Geometry.es"',
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
				'\tRectangle from "./Geometry.es" § re-export, never bound locally',
				"}",
			)
			let result = format(text)

			expect(result.refusal).toBeNull()
			expect(result.text).toBe(
				source(
					"import {",
					'\tPI as Pi            from "../math/Math.es"',
					'\tRectangle           from "./Geometry.es"',
					'\tRectangleMeasurable from "./Geometry.es"',
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
					'\tRectangle from "./Geometry.es" § re-export, never bound locally',
					"}",
				),
			)
			expect(anchors(result.text)).toBe(anchors(text))
		})

		// NOTE: A sorted block is the one place the Token sequence is allowed to
		// change, so the anchors are grouped per entry there — and a re-sort with
		// every Comment still on its own entry has to read as no change at all.
		it("reads a re-sorted block with its comments intact as unchanged", () => {
			let written = source(
				"import {",
				"\t§ note",
				'\tB from "./B.es"',
				'\tA from "./A.es"',
				"}",
				"",
				"implementation {}",
			)
			let sorted = source(
				"import {",
				'\tA from "./A.es"',
				"\t§ note",
				'\tB from "./B.es"',
				"}",
				"",
				"implementation {}",
			)

			expect(anchors(sorted)).toBe(anchors(written))
		})

		// NOTE: What the grouping buys: a Comment that ends up against another
		// entry is still present, still in order, and only which entry it rides
		// with gives it away.
		it("still notices a comment that changed which entry it rides with", () => {
			let riding = source(
				"import {",
				"\t§ note",
				'\tA from "./A.es"',
				'\tB from "./B.es"',
				"}",
				"",
				"implementation {}",
			)
			let moved = source(
				"import {",
				'\tA from "./A.es"',
				"\t§ note",
				'\tB from "./B.es"',
				"}",
				"",
				"implementation {}",
			)

			expect(anchors(moved)).not.toBe(anchors(riding))
		})

		it("still notices a comment dropped from a block", () => {
			let written = source(
				"import {",
				"\t§ note",
				'\tA from "./A.es"',
				"}",
				"",
				"implementation {}",
			)
			let dropped = source(
				"import {",
				'\tA from "./A.es"',
				"}",
				"",
				"implementation {}",
			)

			expect(anchors(dropped)).not.toBe(anchors(written))
		})

		// NOTE: Grouping per entry does not make the block a place where a
		// Comment may end up anywhere — one carried out of it, above the Keyword,
		// leaves its chunk and shows up in the sequence instead.
		it("still notices a comment carried out of a block", () => {
			let inside = source(
				"import {",
				"\t§ note",
				'\tA from "./A.es"',
				"}",
				"",
				"implementation {}",
			)
			let above = source(
				"§ note",
				"import {",
				'\tA from "./A.es"',
				"}",
				"",
				"implementation {}",
			)

			expect(anchors(above)).not.toBe(anchors(inside))
		})

		// NOTE: A Comment written between an entry's name and its `from` belongs
		// to no entry the printer can name, and the gate is what keeps that from
		// being formatted anyway.
		it("leaves a comment written inside an entry's own span alone", () => {
			let text = source(
				"import {",
				"\tRectangle § why",
				'\tfrom "./Geometry.es"',
				'\tCircle from "./Geometry.es"',
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
		it("keeps an entry the author spread over two lines on one", () => {
			expect(
				formatted(
					source(
						"import {",
						"\tRectangle",
						'\tfrom "./Geometry.es"',
						"}",
						"",
						"implementation {}",
					),
				),
			).toBe(
				source(
					"import {",
					'\tRectangle from "./Geometry.es"',
					"}",
					"",
					"implementation {}",
				),
			)
		})

		// NOTE: All four Module Keywords stay spellable as names, so an entry may
		// be called `as` or `from` — and then the alignment has to measure a
		// left-hand side that reads like a Keyword.
		it("writes an entry whose own name is a Module keyword", () => {
			expect(
				formatted(
					source(
						"import {",
						'\tas as as from "./A.es"',
						'\tfrom from "./A.es"',
						"}",
						"",
						"implementation {}",
					),
				),
			).toBe(
				source(
					"import {",
					'\tas as as from "./A.es"',
					'\tfrom     from "./A.es"',
					"}",
					"",
					"implementation {}",
				),
			)
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
