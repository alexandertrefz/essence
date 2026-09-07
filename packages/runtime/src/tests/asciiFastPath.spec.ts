import { describe, expect, test } from "bun:test"

import { createInteger } from "../Integer"
import type { OptionalType } from "../Optional"
import { bothEnds, end, start } from "../Side"
import {
	character__overload$1 as character,
	createString,
	ends,
	length,
	lowercase,
	repeat,
	slice,
	split__overload$1 as split,
	type StringType,
	trim,
	uppercase,
	words,
} from "../String"
import { typeKeySymbol } from "../type"

const string = (value: string) => createString(value)
const int = (value: number) => createInteger(value)

// NOTE: The character a position answers, or nothing — unwrapped here so that
// the assertions below read the answer rather than the Optional around it.
function characterOf(answer: OptionalType<StringType>): StringType | undefined {
	return answer[typeKeySymbol] === "Optional#Empty" ? undefined : answer.item
}

// NOTE: The two Symbol keys `String.ts` remembers a String's ASCII-ness and
// character count under, found by their descriptions — they are private to
// the module, and this file is the one reader that has to see them, because
// whether a marker SURVIVED a Method is not observable any other way than by
// timing. A String that carries neither is one the next Method rescans.
function remembered(value: StringType, description: string): unknown {
	let key = Object.getOwnPropertySymbols(value).find(
		(symbol) => symbol.description === description,
	)

	return key === undefined ? undefined : (value as any)[key]
}

const isMarkedAscii = (value: StringType) =>
	remembered(value, "$isAscii") === true &&
	remembered(value, "$graphemeCount") === value.value.length

const isUnmarked = (value: StringType) =>
	remembered(value, "$isAscii") === undefined &&
	remembered(value, "$graphemeCount") === undefined

// NOTE: The same text twice, composed and decomposed — canonically equivalent,
// different code points — so that what a Method answers off one can be held
// against what it answers off the other. See `graphemes.spec.ts`.
const composed = "café".normalize("NFC")
const decomposed = "café".normalize("NFD")

// NOTE: `split`, `ends`, `slice` and `character(at:)` take the intrinsic on
// the same condition, and each has to answer what the walk over the view
// answers.
describe("cutting by either route", () => {
	test("split, ends, slice and character answer alike on ASCII", () => {
		let pieces = (text: string, separator: string) =>
			split(string(text), string(separator)).value.map(
				(piece) => piece.value,
			)

		expect(pieces("a,b,", ",")).toEqual(["a", "b", ""])
		expect(pieces(",a", ",")).toEqual(["", "a"])
		expect(pieces("abc", "abc")).toEqual(["", ""])
		expect(pieces("aaa", "aa")).toEqual(["", "a"])
		expect(pieces("", ",")).toEqual([""])
		expect(pieces("", "")).toEqual([])
		expect(pieces("abc", "")).toEqual(["a", "b", "c"])

		expect(ends(string("hello"), string("llo")).value).toBeTrue()
		expect(ends(string("hello"), string("hello!")).value).toBeFalse()
		expect(ends(string("hello"), string("")).value).toBeTrue()

		expect(slice(string("hello"), int(1), int(-1)).value).toBe("ell")
		expect(slice(string("hello"), int(3), int(1)).value).toBe("")
		expect(slice(string("hello"), int(-2), int(5)).value).toBe("lo")
		expect(slice(string("hello"), int(0), int(99)).value).toBe("hello")

		expect(characterOf(character(string("hello"), int(-1)))?.value).toBe(
			"o",
		)
		expect(characterOf(character(string("hello"), int(5)))).toBeUndefined()
		expect(characterOf(character(string("hello"), int(-6)))).toBeUndefined()
	})
})

describe("the ASCII marker", () => {
	// NOTE: Every Method that maps an ASCII String to an ASCII String marks
	// its answer, so that a loop measuring what it built does not rescan it.
	test("survives the Methods that map ASCII to ASCII", () => {
		let text = string("  Hello, World  ")

		expect(isMarkedAscii(uppercase(text))).toBeTrue()
		expect(isMarkedAscii(lowercase(text))).toBeTrue()
		expect(isMarkedAscii(trim(text, bothEnds))).toBeTrue()
		expect(isMarkedAscii(trim(text, start))).toBeTrue()
		expect(isMarkedAscii(trim(text, end))).toBeTrue()
		expect(isMarkedAscii(slice(text, int(2), int(7)))).toBeTrue()
		expect(isMarkedAscii(repeat(text, int(3)))).toBeTrue()
		expect(isMarkedAscii(characterOf(character(text, int(2)))!)).toBeTrue()

		for (let piece of split(text, string(",")).value) {
			expect(isMarkedAscii(piece)).toBeTrue()
		}

		for (let piece of split(text, string("")).value) {
			expect(isMarkedAscii(piece)).toBeTrue()
		}

		for (let word of words(text).value) {
			expect(isMarkedAscii(word)).toBeTrue()
		}
	})

	// NOTE: The marker is a claim, and a String the scan would refuse must
	// not carry it — `ß` upper-cases to `SS`, which IS ASCII, but the receiver
	// was not, so the answer is left for the scan to decide.
	test("is not written where the receiver was not ASCII", () => {
		let sharp = string("straße")
		let upper = uppercase(sharp)

		expect(upper.value).toBe("STRASSE")
		expect(isUnmarked(upper)).toBeTrue()
		expect(length(upper).value).toBe(7)

		expect(isUnmarked(trim(string(` ${composed} `), bothEnds))).toBeTrue()
		expect(isUnmarked(lowercase(string("CAFÉ")))).toBeTrue()

		// NOTE: A carriage return is the scan's one ASCII exception, so it is
		// unmarked too — and its pieces then count CR LF as one character.
		let windows = string("a\r\nb\r\n")

		expect(isUnmarked(uppercase(windows))).toBeTrue()
		expect(length(uppercase(windows)).value).toBe(4)
	})

	// NOTE: What the marker carries is the character count, and it has to be
	// the count the scan would have answered.
	test("carries the count the scan would answer", () => {
		let text = string("Hello, World")

		expect(length(uppercase(text)).value).toBe(12)
		expect(length(trim(string("  hi  "), bothEnds)).value).toBe(2)
		expect(length(slice(text, int(7), int(12))).value).toBe(5)
		expect(length(repeat(string("ab"), int(3))).value).toBe(6)
		expect(
			split(text, string(", ")).value.map((piece) => length(piece).value),
		).toEqual([5, 5])
	})
})

describe("the NFC form", () => {
	// NOTE: `words` and `trim` read the NFC form, as every other position
	// Method does — so the words of a String and the pieces of its `split`
	// are the same text in the same bytes, and a decomposed receiver answers
	// composed text.
	test("words and trim answer composed text", () => {
		expect(
			words(string(`${decomposed} ${decomposed}`)).value.map(
				(word) => word.value,
			),
		).toEqual([composed, composed])
		expect(trim(string(` ${decomposed} `), bothEnds).value).toBe(composed)
		expect(trim(string(` ${decomposed} `), start).value).toBe(
			`${composed} `,
		)
		expect(
			split(string(`${decomposed} ${decomposed}`), string(" ")).value.map(
				(piece) => piece.value,
			),
		).toEqual([composed, composed])
	})
})
