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

	// NOTE: The remaining control characters have no spelling of their own, so
	// they render as their code point — which is a spelling a Program can now
	// write down as well as read back.
	test("a control character renders as its code point", () => {
		expect(getStringRepresentation(createString("\u0000"))).toBe('"\\u{0}"')
		expect(getStringRepresentation(createString("\u009F"))).toBe(
			'"\\u{9F}"',
		)
	})

	// NOTE: A BARE BRACE in quoted output opens an interpolation hole when the
	// text is read back, so `"a\{b\}"::quote()` printed `"a{b}"` and pasting
	// that into a Program was a syntax error rather than the value it came
	// from. `roundTrip.spec.ts` in the Compiler holds the whole promise, with
	// this printer and the real Lexer standing in one process.
	test("a brace renders as the escape that writes one", () => {
		expect(getStringRepresentation(createString("a{b}"))).toBe('"a\\{b\\}"')
	})

	// NOTE: The invisible characters that change how the text around them is
	// READ, which is what makes a printed value a trap: a bidi override
	// reorders the line it is printed on — the source-spoofing trick, pointed
	// at a report — U+2028 breaks the line in two, and a byte order mark simply
	// hides. Each is spelled instead.
	test("a character that reorders or hides renders as its code point", () => {
		expect(getStringRepresentation(createString("a\u202Eb"))).toBe(
			'"a\\u{202E}b"',
		)
		expect(getStringRepresentation(createString("a\u2028b"))).toBe(
			'"a\\u{2028}b"',
		)
		expect(getStringRepresentation(createString("\uFEFFa"))).toBe(
			'"\\u{FEFF}a"',
		)
	})

	// NOTE: And the invisible ones that change how their neighbours DRAW are
	// left alone. A zero-width joiner holds an emoji sequence together, and
	// escaping it would take a printed sequence apart into the characters
	// nobody wrote.
	test("a joiner inside an emoji sequence is left alone", () => {
		expect(
			getStringRepresentation(createString("\u{1F469}\u200D\u{1F4BB}")),
		).toBe('"\u{1F469}\u200D\u{1F4BB}"')
	})

	// NOTE: A lone surrogate is half of a character and no Literal spells one,
	// so there is no escape that reads back to it. It renders as the
	// replacement character's escape — what encoding the text would turn it
	// into anyway, named rather than silent.
	test("a lone surrogate renders as the replacement character", () => {
		expect(getStringRepresentation(createString("a\uD800b"))).toBe(
			'"a\\u{FFFD}b"',
		)
		expect(getStringRepresentation(createString("\uD83D\uDE00"))).toBe(
			'"\u{1F600}"',
		)
	})

	test("plain text renders unchanged inside its quotes", () => {
		expect(getStringRepresentation(createString("hello"))).toBe('"hello"')
		expect(getStringRepresentation(createString("caf\u00E9 \u65E5"))).toBe(
			'"caf\u00E9 \u65E5"',
		)
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

// NOTE: The walk renders every child ONCE, at indent zero, and re-indents that
// rendering for the nested layout — so what it costs is the size of the value
// and not two renderings per level of nesting. The two tests below are the two
// halves of that: the layout it produces at a deeper indent is the one it
// produces at zero with the indent written after each newline, and a value
// nested deeply enough that every level wraps still renders in no time at all.
describe("rendering a deeply nested value", () => {
	// NOTE: One member per level and a leaf long enough that every level
	// overflows the single-line budget, which is the shape that made the walk
	// double per level. Depth 22 measured 1,153 ms before and 0.03 ms now.
	function chain(depth: number): AnyType {
		let value: AnyType = createString(
			"a leaf String long enough that every level of this chain wraps",
		)

		for (let level = 0; level < depth; level++) {
			value = createRecord({ member: value })
		}

		return value
	}

	test("a deeper indent is the indent written into the shallower one", () => {
		let value = chain(4)
		let shallow = getStringRepresentation(value)

		for (let level of [1, 2, 5]) {
			expect(getStringRepresentation(value, level)).toBe(
				shallow.replaceAll("\n", `\n${" ".repeat(4 * level)}`),
			)
		}
	})

	test("a chain twenty-two deep renders at once", () => {
		let value = chain(22)
		let start = performance.now()
		let rendered = getStringRepresentation(value)

		expect(performance.now() - start).toBeLessThan(50)
		expect(rendered.split("\n").length).toBe(45)
	})
})
