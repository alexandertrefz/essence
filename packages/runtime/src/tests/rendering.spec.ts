import { describe, expect, test } from "bun:test"

import { createRecord } from "../Record"
import { createString } from "../String"
import { getStringRepresentation } from "../Terminal"

describe("rendering a String", () => {
	// NOTE: The structural rendering is for the Program's AUTHOR — an embedded
	// quote must not read as the closing one, and a line break must not split
	// the one value across two lines — so the contents are spelled with the
	// String Literal's own escapes.
	test("quotes, backslashes and line breaks are escaped", () => {
		expect(getStringRepresentation(createString('a"b\nc'))).toBe(
			'"a\\"b\\nc"',
		)
		expect(getStringRepresentation(createString("back\\slash"))).toBe(
			'"back\\\\slash"',
		)
		expect(getStringRepresentation(createString("tab\there\r"))).toBe(
			'"tab\\there\\r"',
		)
	})

	// NOTE: The remaining control characters have no Essence spelling of their
	// own, so they render as their code point.
	test("a control character renders as its code point", () => {
		expect(getStringRepresentation(createString("\u0000"))).toBe('"\\u{0}"')
		expect(getStringRepresentation(createString("\u009F"))).toBe(
			'"\\u{9F}"',
		)
	})

	test("plain text renders unchanged inside its quotes", () => {
		expect(getStringRepresentation(createString("hello"))).toBe('"hello"')
		expect(getStringRepresentation(createString("a{b}"))).toBe('"a{b}"')
	})

	test("a Record member renders with the same escapes", () => {
		expect(
			getStringRepresentation(
				createRecord({ note: createString('say "hi"\n') }),
			),
		).toBe('{ note = "say \\"hi\\"\\n" }')
	})
})
