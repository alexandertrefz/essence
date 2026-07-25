import { describe, expect, it } from "bun:test"

import {
	concat,
	type Doc,
	group,
	hardline,
	ifBreak,
	indent,
	join,
	line,
	printDoc,
	softline,
	text,
} from "../doc"

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

	it("picks the ifBreak branch matching the enclosing group's mode", () => {
		let doc = group(
			concat([text("x"), line, ifBreak(text("BROKEN"), text("FLAT"))]),
		)

		expect(printDoc(doc, 80)).toBe("x FLAT")
		expect(printDoc(doc, 3)).toBe("x\nBROKEN")
	})
})
