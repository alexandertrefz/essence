import { describe, expect, test } from "bun:test"

import { createDictionary } from "../Dictionary"
import { createInteger } from "../Integer"
import { formatAsFraction } from "../Rational"
import { createRecord } from "../Record"
import { createString } from "../String"
import { getStringRepresentation } from "../Terminal"
import type { AnyType } from "../type"

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

// NOTE: The witness `createDictionary` asks about the keys it is handed. These
// keys are Strings and no two of them are equal, so the only thing this witness
// ever answers is `false`, and what it answers is what a Dictionary of distinct
// keys never depends on. `dictionaries.spec.ts` is where equality itself is
// asked.
const distinct = {
	is: () => ({ [Symbol.for("$type")]: "Boolean", value: false }) as never,
}

const dictionary = (...pairs: Array<[string, number]>) =>
	createDictionary(
		pairs.map(
			([key, value]) =>
				[createString(key), createInteger(BigInt(value))] as [
					AnyType,
					AnyType,
				],
		),
		distinct,
	)

// NOTE: A Dictionary is rendered by the WRITTEN form, which is what
// `Dictionary::toString` answers as well — so a Record holding one says the
// same about it as printing it on its own does. The two readers of this walk
// differ only in the padding, exactly as they do for a List.
describe("rendering a Dictionary", () => {
	test("the entries read as a Program writes them", () => {
		expect(getStringRepresentation(dictionary(["a", 1], ["b", 2]))).toBe(
			'[ "a" = 1, "b" = 2 ]',
		)
	})

	// NOTE: `[=]` rather than `[]`, which is the whole reason the empty
	// Dictionary carries the `=` an entry is written with: a reader has to be
	// able to tell it from the empty List. The padding says nothing about it,
	// because there is nothing to pad.
	test("the empty Dictionary reads [=]", () => {
		expect(getStringRepresentation(dictionary())).toBe("[=]")
		expect(
			getStringRepresentation(dictionary(), 0, formatAsFraction, ""),
		).toBe("[=]")
	})

	// NOTE: What `Record::toString` asks for — no padding inside the brackets,
	// which is the form `Dictionary::toString` answers and a Program writes.
	test("the printable reading pads nothing", () => {
		expect(
			getStringRepresentation(
				createRecord({ counts: dictionary(["a", 1]) }),
				0,
				formatAsFraction,
				"",
			),
		).toBe('{ counts = ["a" = 1] }')
	})

	// NOTE: A single line over sixty characters wraps, the way a List and a
	// Record do, and each entry is then rendered at the deeper indent so that
	// anything nested inside it lines up under its own key.
	test("a long Dictionary wraps one entry to a line", () => {
		expect(
			getStringRepresentation(
				dictionary(
					["alexander", 1],
					["bartholomew", 2],
					["christopher", 3],
					["dominic", 4],
				),
			),
		).toBe(
			[
				"[",
				'    "alexander" = 1,',
				'    "bartholomew" = 2,',
				'    "christopher" = 3,',
				'    "dominic" = 4',
				"]",
			].join("\n"),
		)
	})
})
