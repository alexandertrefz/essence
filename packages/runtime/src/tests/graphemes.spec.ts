import { describe, expect, test } from "bun:test"

import { anyIs } from "../internalHelpers"
import { createRecord } from "../Record"
import { createString, ends, length, reverse, split } from "../String"
import { getStringRepresentation } from "../Terminal"

const countOf = (value: string) => length(createString(value)).value

// NOTE: The same text twice — once composed (NFC, one code point for `é`), once
// decomposed (NFD, `e` followed by a combining acute). They are canonically
// equivalent, so they hold the same characters, and they are genuinely
// different code points, which is what makes the test mean anything. Normalised
// here rather than written as two literals, because an editor, a formatter or a
// file round trip may quietly compose the decomposed one and leave the test
// asserting nothing.
const composed = "cafe\u0301".normalize("NFC")
const decomposed = "cafe\u0301".normalize("NFD")

// NOTE: A family emoji — four people joined by zero-width joiners, eleven code
// units, ONE character to a reader — and Germany's flag, two regional
// indicators making one.
const family = "\u{1F468}\u200D\u{1F469}\u200D\u{1F467}\u200D\u{1F466}"
const flag = "\u{1F1E9}\u{1F1EA}"

describe("counting characters", () => {
	test("ASCII counts by code unit", () => {
		expect(countOf("")).toBe(0n)
		expect(countOf("a")).toBe(1n)
		expect(countOf("hello world!")).toBe(12n)
		expect(countOf("\t\n ~")).toBe(4n)
	})

	// NOTE: The fast path's one exception. CR LF is a SINGLE grapheme cluster,
	// so counting code units would answer one too many for every line break a
	// Windows-authored text carries — the String has to be segmented properly.
	test("a carriage return declines the fast path", () => {
		expect(countOf("a\r\nb")).toBe(3n)
		expect(countOf("\r\n")).toBe(1n)
		expect(countOf("a\rb")).toBe(3n)
		expect(countOf("a\nb")).toBe(3n)
	})

	test("canonically equivalent text counts alike", () => {
		expect(composed).not.toBe(decomposed)
		expect(countOf(composed)).toBe(4n)
		expect(countOf(decomposed)).toBe(4n)
	})

	test("a joined emoji is one character", () => {
		expect(family.length).toBe(11)
		expect(countOf(family)).toBe(1n)
		expect(countOf(`a${family}b`)).toBe(3n)
		expect(countOf(flag)).toBe(1n)
	})

	// NOTE: The remembered count has to be the count, however the value was
	// first asked about — a String segmented by `split` is counted off that
	// view, and one counted first is not counted again.
	test("a String answers alike however often it is asked", () => {
		for (let value of ["hello", composed, decomposed, family, "a\r\nb"]) {
			// NOTE: Two wrappers over the same text, counted by the two routes
			// there are: one is asked straight away, so its count comes off the
			// scan where the text qualifies for it, and one is segmented first,
			// so its count comes off the remembered view. The routes have to
			// meet, and asking either a second time has to answer what asking
			// it the first time did.
			let scanned = createString(value)
			let segmented = createString(value)

			split(segmented, createString(""))

			let expected = length(scanned).value

			expect(length(segmented).value, value).toBe(expected)
			expect(length(scanned).value, value).toBe(expected)
			expect(length(segmented).value, value).toBe(expected)
		}
	})
})

describe("the remembered view", () => {
	// NOTE: What every position Method rests on: splitting the same String twice
	// answers the same characters, and the second answer is not the first one's
	// array handed out where a caller could change it.
	test("splitting twice answers alike", () => {
		let string = createString(`a${family}b`)

		let first = split(string, createString(""))
		let second = split(string, createString(""))

		expect(first).not.toBe(second)
		expect(first.value.map((piece) => piece.value)).toEqual([
			"a",
			family,
			"b",
		])
		expect(second.value.map((piece) => piece.value)).toEqual([
			"a",
			family,
			"b",
		])

		let separated = createString("one, two, one")
		let pieces = split(separated, createString(", "))

		expect(pieces.value.map((piece) => piece.value)).toEqual([
			"one",
			"two",
			"one",
		])
		expect(
			split(separated, createString(", ")).value.map(
				(piece) => piece.value,
			),
		).toEqual(["one", "two", "one"])
	})

	test("a suffix is found alike however often it is asked", () => {
		let string = createString(`stem${family}`)
		let suffix = createString(family)

		expect(ends(string, suffix).value).toBeTrue()
		expect(ends(string, suffix).value).toBeTrue()
		expect(ends(string, createString("stem")).value).toBeFalse()
		// NOTE: A composed suffix inside a decomposed String — `ends` takes both
		// sides as the canonical grapheme view, so it matches by canonical
		// equivalence rather than by code unit.
		expect(
			ends(createString(decomposed), createString(composed.slice(3)))
				.value,
		).toBeTrue()
	})

	// NOTE: The whole safety of remembering anything on the value: what is
	// remembered lives on a Symbol key, which nothing that reads a value can
	// see. A String that has been measured is the same value as one that has
	// not — to equality, to printing, and to whoever asks it for its keys.
	test("what is remembered is invisible", () => {
		let measured = createString(composed)

		length(measured)
		split(measured, createString(""))

		expect(Object.keys(measured)).toEqual(["value"])
		expect(JSON.stringify(measured)).toBe(
			JSON.stringify({ value: composed }),
		)
		expect(getStringRepresentation(measured)).toBe(`"${composed}"`)

		expect(anyIs(measured, createString(composed))).toBeTrue()
		expect(anyIs(measured, createString(decomposed))).toBeTrue()
		expect(anyIs(measured, createString("other"))).toBeFalse()

		expect(
			anyIs(
				createRecord({ name: measured }),
				createRecord({ name: createString(composed) }),
			),
		).toBeTrue()
		expect(
			anyIs(
				createRecord({ name: measured }),
				createRecord({ name: createString("other") }),
			),
		).toBeFalse()
	})
})

describe("reversing", () => {
	// NOTE: Three regional indicators segment as a pair and a single —
	// `🇦🇧, 🇨` — and segmenting the reversed TEXT afresh would re-pair them
	// as `🇨🇦, 🇧`: characters the original never had. The reversed String
	// remembers its view instead, so its characters are the original's in the
	// opposite order.
	test("reversal keeps the original's characters", () => {
		let flags = createString("🇦🇧🇨")
		let reversed = reverse(flags)

		expect(reversed.value).toBe("🇨🇦🇧")
		expect(
			split(reversed, createString("")).value.map((piece) => piece.value),
		).toEqual(["🇨", "🇦🇧"])
		expect(length(reversed).value).toBe(2n)
	})

	test("reversing twice answers the original", () => {
		for (let value of ["", "hello", "🇦🇧🇨", `a${family}b`, decomposed]) {
			let twice = reverse(reverse(createString(value)))

			expect(anyIs(twice, createString(value)), value).toBeTrue()
		}
	})

	// NOTE: What the `lastIndex` derivation in `String.es` rests on — a piece
	// cut from a reversed String carries the clusters it was cut into, so its
	// length is counted off them rather than off a fresh segmentation of the
	// joined text.
	test("a piece of a reversed String counts its own characters", () => {
		let reversed = reverse(createString("🇦🇧🇨"))
		let pieces = split(reversed, createString("🇨"))

		expect(pieces.value.map((piece) => piece.value)).toEqual(["", "🇦🇧"])
		expect(length(pieces.value[0]!).value).toBe(0n)
		expect(length(pieces.value[1]!).value).toBe(1n)
	})
})
