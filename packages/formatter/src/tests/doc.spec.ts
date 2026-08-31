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

// NOTE: A run of lines, each of them a head, the padding that carries it to
// the run's column, and a tail. `fit` is what the whole line must fit for its
// padding to be worth writing — a `define` arm reports one, because an arm
// that breaks writes the very word the column runs through on a line of its
// own; an assignment reports none, because its `=` never leaves its head's
// line however far the value runs on.
function alignedLines(
	maxSpan: number,
	lines: Array<[head: string, tail: string, fit: number | null]>,
): Doc {
	let run = alignmentRun(maxSpan)

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

// NOTE: The shape every list-like construct in the printer uses — an opening
// bracket, comma separated entries that break one per line, and a trailing
// comma that appears only when broken.
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
		// NOTE: At width 10 the entries fit only if the leading tab is counted
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
		// NOTE: `(a, b)` is six columns and the width is seven, but the `;;;`
		// queued behind it belongs to the same line, so the group must break.
		let doc = concat([bracketed(["a", "b"]), text(";;;")])

		expect(printDoc(doc, 7)).toBe("(\n\ta,\n\tb,\n);;;")
	})

	it("leaves no trailing whitespace on a blank line", () => {
		let doc = indent(concat([text("a"), hardline, hardline, text("b")]))

		expect(printDoc(doc, 80)).toBe("a\n\n\tb")
	})

	// NOTE: A multi-line String Literal's trailing spaces are characters of the
	// value, not layout — trimming them changes what the file says.
	it("keeps trailing whitespace inside verbatim text", () => {
		let doc = concat([verbatim('"hello   \nworld"'), hardline, text("b")])

		expect(printDoc(doc, 80)).toBe('"hello   \nworld"\nb')
	})

	it("trims layout whitespace back to the last verbatim piece", () => {
		let doc = concat([verbatim("a  "), text("   "), hardline, text("b")])

		expect(printDoc(doc, 80)).toBe("a  \nb")
	})

	// NOTE: What a Comment claimed onto a Statement rides on — the group can
	// never render flat, but no line break is written where the marker stands.
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

		// NOTE: A head further from its neighbours than the run's span starts a
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

		// NOTE: The column a run stands at is the renderer's to know, and the
		// same run resolves differently at two of them: with the whole page to
		// itself the first line takes its padding, and two indents in the
		// padding would carry it past the width — so it is out of the run, and
		// what is left is a block of one and unpadded.
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

		// NOTE: Taking one line out is not the end of it — the two lines either
		// side of it become one block, which can widen the padding of a line
		// that fit before. The pass runs again until nothing more comes out.
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

		// NOTE: A line that reports no width holds its column however long it
		// runs — nothing about the room it stands in can move the thing the
		// column is drawn through.
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
