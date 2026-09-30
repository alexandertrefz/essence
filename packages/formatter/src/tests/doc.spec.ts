import { describe, expect, it } from "bun:test"

import {
	alignmentRun,
	alignmentSlot,
	breakParent,
	concat,
	conditionalGroup,
	type Doc,
	fill,
	group,
	hardline,
	ifBreak,
	indent,
	join,
	joinAlignment,
	line,
	lineSuffix,
	printDoc,
	softline,
	text,
	verbatim,
} from "../doc"

// A run of lines, each a head, its padding and a tail. The `fit` is the width
// the whole line must fit for its padding to count. A `define` arm reports one,
// and an assignment none, since its `=` never leaves its head's line.
function alignedLines(
	maxSpan: number,
	lines: Array<[head: string, tail: string, fit: number | null]>,
	partedByBreaks = false,
): Doc {
	let run = alignmentRun(maxSpan, { partedByBreaks })

	return join(
		hardline,
		lines.map(([head, tail, fit]) => {
			let padding = alignmentSlot()

			joinAlignment(run, padding, {
				headWidth: head.length,
				fitWidth: fit,
			})

			return concat([text(head), padding, text(tail)])
		}),
	)
}

// The shape of every list in the Printer: a bracket, entries that break one per
// line, and a trailing comma only when broken.
function bracketed(entries: Array<string>): Doc {
	return group(
		concat([
			text("("),
			indent(
				concat([
					softline,
					join(concat([text(","), line]), entries.map(text)),
					ifBreak(text(","), text("")),
				]),
			),
			softline,
			text(")"),
		]),
	)
}

describe("doc", () => {
	it("renders text verbatim", () => {
		expect(printDoc(text("hello"), 80)).toBe("hello")
	})

	it("renders a flat group with spaces for lines", () => {
		expect(printDoc(group(join(line, [text("a"), text("b")])), 80)).toBe(
			"a b",
		)
	})

	it("renders softline as nothing when flat", () => {
		expect(printDoc(bracketed(["a", "b"]), 80)).toBe("(a, b)")
	})

	it("breaks a group that does not fit, one entry per line", () => {
		expect(printDoc(bracketed(["alpha", "beta", "gamma"]), 10)).toBe(
			"(\n\talpha,\n\tbeta,\n\tgamma,\n)",
		)
	})

	it("adds the trailing comma only when broken", () => {
		expect(printDoc(bracketed(["alpha", "beta"]), 80)).toBe("(alpha, beta)")
		expect(printDoc(bracketed(["alpha", "beta"]), 8)).toBe(
			"(\n\talpha,\n\tbeta,\n)",
		)
	})

	it("indents with tabs, one per nesting level", () => {
		let doc = group(
			concat([
				text("{"),
				indent(
					concat([
						hardline,
						text("outer"),
						indent(concat([hardline, text("inner")])),
					]),
				),
				hardline,
				text("}"),
			]),
		)

		expect(printDoc(doc, 80)).toBe("{\n\touter\n\t\tinner\n}")
	})

	it("measures a tab as four columns", () => {
		// At width 10 the entries fit only if the leading tab is counted
		// as one character; counted as four they do not.
		let doc = indent(concat([hardline, bracketed(["abcd", "ef"])]))

		expect(printDoc(doc, 12)).toBe("\n\t(\n\t\tabcd,\n\t\tef,\n\t)")
	})

	it("forces every enclosing group to break around a hardline", () => {
		let doc = group(
			concat([text("a"), line, group(concat([text("b"), hardline]))]),
		)

		expect(printDoc(doc, 80)).toBe("a\nb\n")
	})

	it("honours an explicitly broken group even when it would fit", () => {
		let doc = group(join(line, [text("a"), text("b")]), {
			shouldBreak: true,
		})

		expect(printDoc(doc, 80)).toBe("a\nb")
	})

	it("counts what follows the group when deciding whether it fits", () => {
		// `(a, b)` is six columns and the width is seven, but the `;;;`
		// queued behind it belongs to the same line, so the group must break.
		let doc = concat([bracketed(["a", "b"]), text(";;;")])

		expect(printDoc(doc, 7)).toBe("(\n\ta,\n\tb,\n);;;")
	})

	it("leaves no trailing whitespace on a blank line", () => {
		let doc = indent(concat([text("a"), hardline, hardline, text("b")]))

		expect(printDoc(doc, 80)).toBe("a\n\n\tb")
	})

	// A multi-line String Literal's trailing spaces belong to the value, so
	// trimming them would change what the file says.
	it("keeps trailing whitespace inside verbatim text", () => {
		let doc = concat([verbatim('"hello   \nworld"'), hardline, text("b")])

		expect(printDoc(doc, 80)).toBe('"hello   \nworld"\nb')
	})

	it("trims layout whitespace back to the last verbatim piece", () => {
		let doc = concat([verbatim("a  "), text("   "), hardline, text("b")])

		expect(printDoc(doc, 80)).toBe("a  \nb")
	})

	// What a trailing Comment carries: the group never prints flat, but no line
	// break is written for the marker itself.
	it("renders breakParent as nothing and breaks the enclosing group", () => {
		let doc = group(concat([text("a"), line, text("b"), breakParent]))

		expect(printDoc(doc, 80)).toBe("a\nb")
	})

	it("picks the ifBreak branch matching the enclosing group's mode", () => {
		let doc = group(
			concat([text("x"), line, ifBreak(text("BROKEN"), text("FLAT"))]),
		)

		expect(printDoc(doc, 80)).toBe("x FLAT")
		expect(printDoc(doc, 3)).toBe("x\nBROKEN")
	})

	describe("conditionalGroup", () => {
		let block = concat([
			text("{"),
			indent(concat([hardline, text("body")])),
			hardline,
			text("}"),
		])
		let hug = concat([
			text("f("),
			text("aaaa"),
			text(", "),
			block,
			text(")"),
		])
		let broken = concat([
			text("f("),
			indent(
				concat([hardline, text("aaaa,"), hardline, block, text(",")]),
			),
			hardline,
			text(")"),
		])

		it("takes the first state when its first line fits", () => {
			expect(printDoc(conditionalGroup([hug, broken]), 20)).toBe(
				"f(aaaa, {\n\tbody\n})",
			)
		})

		it("falls through to the last state when nothing fits", () => {
			expect(printDoc(conditionalGroup([hug, broken]), 8)).toBe(
				"f(\n\taaaa,\n\t{\n\t\tbody\n\t},\n)",
			)
		})

		it("does not force the group around it to break", () => {
			let doc = group(
				concat([
					text("a"),
					line,
					conditionalGroup([hug, broken]),
					line,
					text("z"),
				]),
			)

			expect(printDoc(doc, 40)).toBe("a f(aaaa, {\n\tbody\n}) z")
		})
	})

	describe("lineSuffix", () => {
		it("is written at the end of the line and never measured", () => {
			let doc = concat([
				bracketed(["a", "b"]),
				lineSuffix(" § a comment far longer than the width"),
				hardline,
				text("next"),
			])

			expect(printDoc(doc, 10)).toBe(
				"(a, b) § a comment far longer than the width\nnext",
			)
		})

		it("lands after a comma the layout puts on its line", () => {
			let doc = group(
				concat([
					text("["),
					indent(
						concat([
							softline,
							text("first"),
							text(","),
							lineSuffix(" § one"),
							line,
							text("second"),
							ifBreak(text(","), text("")),
						]),
					),
					softline,
					text("]"),
					breakParent,
				]),
			)

			expect(printDoc(doc, 80)).toBe("[\n\tfirst, § one\n\tsecond,\n]")
		})
	})

	describe("alignment", () => {
		it("pads every line of a run out to its widest head", () => {
			expect(
				printDoc(
					alignedLines(12, [
						["ab", " = 1", null],
						["abcd", " = 2", null],
					]),
					80,
				),
			).toBe("ab   = 1\nabcd = 2")
		})

		it("leaves a run of one unpadded", () => {
			expect(printDoc(alignedLines(12, [["ab", " = 1", null]]), 80)).toBe(
				"ab = 1",
			)
		})

		// A head further from its neighbours than the run's span starts a
		// block of its own rather than dragging every sibling out to meet it.
		it("splits a run into blocks its heads span", () => {
			expect(
				printDoc(
					alignedLines(12, [
						["a", " = 1", null],
						["bb", " = 2", null],
						["cccccccccccccccccccc", " = 3", null],
					]),
					80,
				),
			).toBe("a  = 1\nbb = 2\ncccccccccccccccccccc = 3")
		})

		// One run resolves differently at two columns. With the whole page the
		// first line takes its padding. Two indents in, that padding would pass
		// the width, so the line leaves the run and the rest is a block of one.
		it("resolves one run against the room it is reached with", () => {
			let atRoot = alignedLines(12, [
				["ab", " if " + "x".repeat(64), 70],
				["abcdefghij", " if x", 16],
			])
			let indented = alignedLines(12, [
				["ab", " if " + "x".repeat(64), 70],
				["abcdefghij", " if x", 16],
			])

			expect(printDoc(atRoot, 80).split("\n")[0]).toBe(
				"ab" + " ".repeat(8) + " if " + "x".repeat(64),
			)
			expect(printDoc(indent(indent(indented)), 80).split("\n")[0]).toBe(
				"ab if " + "x".repeat(64),
			)
		})

		// Taking a line out joins the lines around it into one block, which can
		// widen another line's padding. The pass repeats until no line comes out.
		it("takes a line out that the padding alone would break", () => {
			expect(
				printDoc(
					alignedLines(12, [
						["ab", " if " + "x".repeat(74), 80],
						["abcdefghij", " if x", 16],
						["abcdef", " if x", 12],
					]),
					80,
				),
			).toBe(
				[
					"ab if " + "x".repeat(74),
					"abcdefghij if x",
					"abcdef     if x",
				].join("\n"),
			)
		})

		// The lines around one taken out line up with each other, unless the run
		// is parted by its breaks. Then each side is a run of its own.
		it("parts a run at a line taken out, where asked to", () => {
			let lines: Array<[string, string, number | null]> = [
				["a", " { 1 }", 7],
				["bbb", " { 2 }", 9],
				["cc", " { " + "x".repeat(74) + " }", 80],
				["d", " { 3 }", 7],
				["eeeee", " { 4 }", 11],
			]

			expect(printDoc(alignedLines(12, lines), 80)).toBe(
				[
					"a     { 1 }",
					"bbb   { 2 }",
					"cc { " + "x".repeat(74) + " }",
					"d     { 3 }",
					"eeeee { 4 }",
				].join("\n"),
			)
			expect(printDoc(alignedLines(12, lines, true), 80)).toBe(
				[
					"a   { 1 }",
					"bbb { 2 }",
					"cc { " + "x".repeat(74) + " }",
					"d     { 3 }",
					"eeeee { 4 }",
				].join("\n"),
			)
		})

		// A line that reports no width holds its column however long it runs.
		it("keeps a line with no width of its own in the run", () => {
			expect(
				printDoc(
					indent(
						alignedLines(12, [
							["ab", " = " + "x".repeat(90), null],
							["abcd", " = 2", null],
						]),
					),
					80,
				),
			).toBe("ab   = " + "x".repeat(90) + "\n\tabcd = 2")
		})
	})

	describe("fill", () => {
		let numbers = (count: number) => {
			let parts: Array<Doc> = []

			for (let index = 1; index <= count; index++) {
				if (index > 1) {
					parts.push(line)
				}

				parts.push(text(String(index) + ","))
			}

			return fill(parts)
		}

		it("keeps everything on one line when it fits", () => {
			expect(printDoc(numbers(3), 80)).toBe("1, 2, 3,")
		})

		it("breaks only where the next item would not fit", () => {
			expect(printDoc(indent(numbers(12)), 20)).toBe(
				"1, 2, 3, 4, 5, 6, 7,\n\t8, 9, 10, 11,\n\t12,",
			)
		})
	})
})
