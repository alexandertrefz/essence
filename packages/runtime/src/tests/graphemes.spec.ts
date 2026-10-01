import { describe, expect, test } from "bun:test"

import { anyIs } from "../internalHelpers"
import { createRecord } from "../Record"
import {
	createString,
	ends__overload$1 as ends,
	length,
	reverse,
	split__overload$1 as split,
} from "../String"
import { getStringRepresentation } from "../Terminal"

const countOf = (value: string) => length(createString(value)).value

// The same text composed (NFC) and decomposed (NFD): canonically equivalent, but
// different code points. Normalised here rather than written as literals, since
// an editor or a formatter may compose the decomposed one.
const composed = "cafe\u0301".normalize("NFC")
const decomposed = "cafe\u0301".normalize("NFD")

// A family emoji, four people joined by zero-width joiners in eleven code units,
// and Germany's flag, two regional indicators. Each is one character.
const family = "\u{1F468}\u200D\u{1F469}\u200D\u{1F467}\u200D\u{1F466}"
const flag = "\u{1F1E9}\u{1F1EA}"

describe("counting characters", () => {
	test("ASCII counts by code unit", () => {
		expect(countOf("")).toBe(0)
		expect(countOf("a")).toBe(1)
		expect(countOf("hello world!")).toBe(12)
		expect(countOf("\t\n ~")).toBe(4)
	})

	// CR LF is one grapheme cluster, so counting code units would answer one too
	// many for every Windows line break.
	test("a carriage return declines the fast path", () => {
		expect(countOf("a\r\nb")).toBe(3)
		expect(countOf("\r\n")).toBe(1)
		expect(countOf("a\rb")).toBe(3)
		expect(countOf("a\nb")).toBe(3)
	})

	test("canonically equivalent text counts alike", () => {
		expect(composed).not.toBe(decomposed)
		expect(countOf(composed)).toBe(4)
		expect(countOf(decomposed)).toBe(4)
	})

	test("a joined emoji is one character", () => {
		expect(family.length).toBe(11)
		expect(countOf(family)).toBe(1)
		expect(countOf(`a${family}b`)).toBe(3)
		expect(countOf(flag)).toBe(1)
	})

	// `scanned` is counted straight away and `segmented` off the view `split`
	// leaves. The two routes must agree, and a second ask must repeat the first.
	test("a String answers alike however often it is asked", () => {
		for (let value of ["hello", composed, decomposed, family, "a\r\nb"]) {
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
	// Each answer is a fresh array, so no caller can change the remembered one.
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
		// `ends` compares canonical grapheme views, so a composed suffix matches
		// inside a decomposed String.
		expect(
			ends(createString(decomposed), createString(composed.slice(3)))
				.value,
		).toBeTrue()
	})

	// What a String remembers lives on Symbol keys, which equality, printing and
	// `Object.keys` never read. See "String characters" in
	// packages/runtime/DEVELOPMENT.md.
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
	// Three regional indicators segment as `🇦🇧, 🇨`. Segmenting the reversed
	// text afresh would re-pair them as `🇨🇦, 🇧`, so the reversed String keeps
	// its view.
	test("reversal keeps the original's characters", () => {
		let flags = createString("🇦🇧🇨")
		let reversed = reverse(flags)

		expect(reversed.value).toBe("🇨🇦🇧")
		expect(
			split(reversed, createString("")).value.map((piece) => piece.value),
		).toEqual(["🇨", "🇦🇧"])
		expect(length(reversed).value).toBe(2)
	})

	test("reversing twice answers the original", () => {
		for (let value of ["", "hello", "🇦🇧🇨", `a${family}b`, decomposed]) {
			let twice = reverse(reverse(createString(value)))

			expect(anyIs(twice, createString(value)), value).toBeTrue()
		}
	})

	test("a piece of a reversed String counts its own characters", () => {
		let reversed = reverse(createString("🇦🇧🇨"))
		let pieces = split(reversed, createString("🇨"))

		expect(pieces.value.map((piece) => piece.value)).toEqual(["", "🇦🇧"])
		expect(length(pieces.value[0]!).value).toBe(0)
		expect(length(pieces.value[1]!).value).toBe(1)
	})
})
