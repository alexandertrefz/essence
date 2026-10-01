import { describe, expect, test } from "bun:test"

import { insensitive } from "../CaseSensitivity"
import { createInteger, type IntegerType } from "../Integer"
import { firstCharacter, lastCharacter } from "../NonEmptyString"
import type { OptionalType } from "../Optional"
import { equal } from "../Ordering"
import { bothEnds, end, start } from "../Side"
import {
	character__overload$1 as character,
	compare__overload$1 as compare,
	count__overload$1 as count,
	createString,
	ends__overload$1 as ends,
	firstIndex__overload$1 as firstIndex,
	firstIndex__overload$3 as firstIndexFolded,
	lastIndex__overload$1 as lastIndex,
	lastIndex__overload$3 as lastIndexFolded,
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

// An Optional position as a plain number, `-1` for an empty answer, as
// `indexOf` answers.
function positionOf(answer: OptionalType<IntegerType>): number {
	return answer[typeKeySymbol] === "Optional#Empty"
		? -1
		: Number(answer.item.value)
}

// The character a position answers, unwrapped from its Optional.
function characterOf(answer: OptionalType<StringType>): StringType | undefined {
	return answer[typeKeySymbol] === "Optional#Empty" ? undefined : answer.item
}

const first = (text: string, part: string) =>
	positionOf(firstIndex(string(text), string(part)))
const last = (text: string, part: string) =>
	positionOf(lastIndex(string(text), string(part)))
const occurrences = (text: string, part: string) =>
	Number(count(string(text), string(part)).value)

// The same questions with the case folded, the route that reads the receiver in
// chunks.
const folded = (text: string, part: string) =>
	positionOf(firstIndexFolded(string(text), string(part), insensitive))
const foldedLast = (text: string, part: string) =>
	positionOf(lastIndexFolded(string(text), string(part), insensitive))

// Reads the private Symbol keys `String.ts` remembers ASCII-ness and the
// character count under, found by description. Only they show whether a marker
// survived a Method.
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

// The same text composed and decomposed, so a search across the two must match
// by canonical equivalence rather than by unit.
const composed = "café".normalize("NFC")
const decomposed = "café".normalize("NFD")
const family = "\u{1F468}\u200D\u{1F469}\u200D\u{1F467}\u200D\u{1F466}"

// `split`, `ends`, `slice` and `character(at:)` take the intrinsic when the
// searches do, and must answer what the walk over the view answers.
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

describe("searching by either route", () => {
	// The intrinsics answer the first occurrence, the last even where it overlaps
	// an earlier one, and the non-overlapping ones `split` cuts at.
	test("ASCII on both sides answers by unit", () => {
		expect(first("banana", "an")).toBe(1)
		expect(last("banana", "an")).toBe(3)
		expect(occurrences("banana", "an")).toBe(2)

		expect(first("aaa", "aa")).toBe(0)
		expect(last("aaa", "aa")).toBe(1)
		expect(occurrences("aaa", "aa")).toBe(1)
		expect(occurrences("aaaa", "aa")).toBe(2)

		expect(first("banana", "zz")).toBe(-1)
		expect(last("banana", "zz")).toBe(-1)
		expect(occurrences("banana", "zz")).toBe(0)

		expect(first("", "a")).toBe(-1)
		expect(last("", "a")).toBe(-1)
		expect(occurrences("", "a")).toBe(0)
	})

	// The rule for the empty part is stated beside `contains` in `String.es`.
	test("the empty part is a position at either end and no occurrence", () => {
		expect(first("hello", "")).toBe(0)
		expect(last("hello", "")).toBe(5)
		expect(occurrences("hello", "")).toBe(0)

		expect(first("", "")).toBe(0)
		expect(last("", "")).toBe(0)
		expect(occurrences("", "")).toBe(0)

		// The length is counted by grapheme on either route.
		expect(last(`a${family}b`, "")).toBe(3)
	})

	// A joined emoji is one position, a base with its mark is one, and a
	// composed part is found inside a decomposed String.
	test("a non-ASCII side is searched by grapheme and by canonical equivalence", () => {
		expect(first(`a${family}b`, "b")).toBe(2)
		expect(last(`a${family}b${family}`, "b")).toBe(2)
		expect(occurrences(`${family}a${family}`, family)).toBe(2)

		expect(first(decomposed, composed.slice(3))).toBe(3)
		expect(last(`${decomposed}${composed}`, "é")).toBe(7)
		expect(occurrences(`${decomposed} ${composed}`, "é")).toBe(2)

		expect(first("x\u0301y", "x")).toBe(-1)
		expect(occurrences("x\u0301yx", "x")).toBe(1)
		expect(last("x\u0301yx", "x")).toBe(2)
	})

	// CR LF is one cluster, so a line feed inside one is not found, while the
	// pair is.
	test("a carriage return is searched as part of its cluster", () => {
		expect(first("a\r\nb", "\n")).toBe(-1)
		expect(first("a\r\nb", "\r\n")).toBe(1)
		expect(last("a\r\nb", "b")).toBe(2)
		expect(occurrences("a\r\nb\r\n", "\r\n")).toBe(2)
	})

	// U+037E, the Greek question mark, normalises to the ASCII semicolon, so an
	// ASCII String holds it by canonical equivalence.
	test("an ASCII receiver and a non-ASCII part still agree on the answer", () => {
		expect(first("a;b", "\u037E")).toBe(1)
		expect(last("a;b;", "\u037E")).toBe(3)
		expect(occurrences("a;b;", "\u037E")).toBe(2)
		expect(first("abc", "é")).toBe(-1)
		expect(ends(string("abc"), string("é")).value).toBeFalse()

		expect(first("añb", "b")).toBe(2)
		expect(last("añb", "a")).toBe(0)
		expect(occurrences("añbñb", "b")).toBe(2)
		expect(ends(string("añb"), string("b")).value).toBeTrue()
	})

	// Folded first-match searches read doubling chunks that overlap by
	// `part.length - 1`. A receiver under twice the floor is read whole, so these
	// are long enough for the ASCII route to reach a doubled chunk. Putting the
	// part at every position needs no arithmetic about where chunks fall. See
	// "Searching a String" in packages/runtime/DEVELOPMENT.md.
	test("a folded match is found at every position of a chunked receiver", () => {
		let filler = "ab".repeat(3_000)
		let units = 6_000

		for (let at = 0; at + 3 <= units; at++) {
			let text =
				filler.slice(0, at) + "QRS" + filler.slice(0, units - at - 3)

			expect(text).toHaveLength(units)
			expect(folded(text, "qrs")).toBe(at)
			expect(foldedLast(text, "qrs")).toBe(at)
		}

		// The view route counts chunks in characters, and each accented letter
		// here is one character and one unit.
		let accents = "é".repeat(400)
		let characters = 300

		for (let at = 0; at + 3 <= characters; at++) {
			let text =
				accents.slice(0, at) +
				"QRS" +
				accents.slice(0, characters - at - 3)

			expect(folded(text, "qrs")).toBe(at)
			expect(foldedLast(text, "qrs")).toBe(at)
		}
	})

	// The ways out of the chunked loop the sweep never takes. The receiver is
	// over twice the ASCII floor, so the loop is entered.
	test("a folded search of a long receiver answers where there is no match", () => {
		let filler = "ab".repeat(3_000)

		expect(folded(filler, "qrs")).toBe(-1)
		expect(foldedLast(filler, "qrs")).toBe(-1)
		expect(folded(filler, `${filler}z`)).toBe(-1)
		expect(foldedLast(filler, `${filler}z`)).toBe(-1)
		expect(folded(filler, filler.toUpperCase())).toBe(0)
		expect(foldedLast(filler, filler.toUpperCase())).toBe(0)

		let accents = "é".repeat(400)

		expect(folded(accents, "qrs")).toBe(-1)
		expect(foldedLast(accents, "qrs")).toBe(-1)
		expect(folded(accents, `${accents}z`)).toBe(-1)
		expect(foldedLast(accents, `${accents}z`)).toBe(-1)
	})

	// Each walk stops at the first chunk holding a match, so the backward one
	// must answer the last match and the forward one the first.
	test("a folded walk answers the end it started from", () => {
		let filler = "ab".repeat(3_000)
		let text = `QRS${filler.slice(0, 1_500)}QRS${filler.slice(0, 1_500)}`

		expect(folded(text, "qrs")).toBe(0)
		expect(foldedLast(text, "qrs")).toBe(1_503)

		let accents = "é".repeat(400)
		let view = `QRS${accents.slice(0, 200)}QRS${accents.slice(0, 200)}`

		expect(folded(view, "qrs")).toBe(0)
		expect(foldedLast(view, "qrs")).toBe(203)
	})
})

describe("the ASCII marker", () => {
	// A Method mapping ASCII to ASCII marks its answer, so a loop measuring what
	// it built does not rescan it.
	test("survives the Methods that map ASCII to ASCII", () => {
		let text = string("  Hello, World  ")

		expect(isMarkedAscii(uppercase(text))).toBeTrue()
		expect(isMarkedAscii(lowercase(text))).toBeTrue()
		// `uppercase` marked the receiver, and `trim` hands that mark down.
		expect(isMarkedAscii(trim(text, bothEnds))).toBeTrue()
		expect(isMarkedAscii(trim(text, start))).toBeTrue()
		expect(isMarkedAscii(trim(text, end))).toBeTrue()
		expect(isMarkedAscii(slice(text, int(2), int(7)))).toBeTrue()
		expect(isMarkedAscii(repeat(text, int(3)))).toBeTrue()
		expect(isMarkedAscii(characterOf(character(text, int(2)))!)).toBeTrue()

		for (let piece of split(text, string(",")).value) {
			expect(isMarkedAscii(piece)).toBeTrue()
		}

		for (let word of words(text).value) {
			expect(isMarkedAscii(word)).toBeTrue()
		}
	})

	// A piece of the empty separator is one unit, as cheap to scan as to mark,
	// so it is left unmarked. It still counts as one character.
	test("leaves the characters of a split unmarked", () => {
		let text = string("  Hello, World  ")

		for (let piece of split(text, string("")).value) {
			expect(isUnmarked(piece)).toBeTrue()
			expect(length(piece).value).toBe(1)
		}
	})

	// Taking the mark would scan the whole String to answer a question about its
	// ends. The order matters here, so each case has a fresh receiver.
	test("is propagated by trim, never taken by it", () => {
		expect(isUnmarked(trim(string("  Hello  "), bothEnds))).toBeTrue()

		let measured = string("  Hello  ")

		expect(length(measured).value).toBe(9)
		expect(isMarkedAscii(trim(measured, bothEnds))).toBeTrue()
		expect(isMarkedAscii(trim(measured, start))).toBeTrue()
		expect(isMarkedAscii(trim(measured, end))).toBeTrue()
	})

	// An ASCII receiver's ends are read by unit and marked, and any other's come
	// through the view unmarked. So the mark shows which branch ran.
	test("is written by the ends a proven String answers", () => {
		let text = string("Hello")

		expect(firstCharacter(text).value).toBe("H")
		expect(lastCharacter(text).value).toBe("o")
		expect(isMarkedAscii(firstCharacter(text))).toBeTrue()
		expect(isMarkedAscii(lastCharacter(text))).toBeTrue()
		expect(length(firstCharacter(text)).value).toBe(1)

		let wide = string("a😀b")

		expect(firstCharacter(wide).value).toBe("a")
		expect(lastCharacter(wide).value).toBe("b")
		expect(isUnmarked(firstCharacter(wide))).toBeTrue()

		// A last character of several code units is why the other branch reads
		// the view.
		let emoji = string("ab😀")

		expect(lastCharacter(emoji).value).toBe("😀")
		expect(length(lastCharacter(emoji)).value).toBe(1)
	})

	// `ß` upper-cases to `SS`, which is ASCII, but the receiver was not, so the
	// answer is left for the scan.
	test("is not written where the receiver was not ASCII", () => {
		let sharp = string("straße")
		let upper = uppercase(sharp)

		expect(upper.value).toBe("STRASSE")
		expect(isUnmarked(upper)).toBeTrue()
		expect(length(upper).value).toBe(7)

		expect(isUnmarked(trim(string(` ${composed} `), bothEnds))).toBeTrue()
		expect(isUnmarked(lowercase(string("CAFÉ")))).toBeTrue()

		// The scan refuses a carriage return, so the answer is unmarked and counts
		// CR LF as one character.
		let windows = string("a\r\nb\r\n")

		expect(isUnmarked(uppercase(windows))).toBeTrue()
		expect(length(uppercase(windows)).value).toBe(4)
	})

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
	// `words` reads the NFC form, as the position Methods do. So the words of a
	// String and the pieces of its `split` hold the same text.
	test("words and split answer composed text", () => {
		expect(
			words(string(`${decomposed} ${decomposed}`)).value.map(
				(word) => word.value,
			),
		).toEqual([composed, composed])
		expect(
			split(string(`${decomposed} ${decomposed}`), string(" ")).value.map(
				(piece) => piece.value,
			),
		).toEqual([composed, composed])
	})

	// `trim` reads no normal form, which would cost the receiver's length.
	// Normalising neither creates nor destroys whitespace, so its answer is still
	// the same String.
	test("is not forced by trim, whose answer is the same String", () => {
		let trimmed = trim(string(` ${decomposed} `), bothEnds)

		expect(trimmed.value).toBe(decomposed)
		expect(compare(trimmed, string(composed))).toEqual(equal)
		expect(length(trimmed).value).toBe(length(string(composed)).value)
		expect(trim(string(` ${decomposed} `), start).value).toBe(
			`${decomposed} `,
		)
	})
})
