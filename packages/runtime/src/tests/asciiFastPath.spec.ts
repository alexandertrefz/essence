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

// NOTE: An Optional position read back as a plain number, `-1` for an empty
// answer — the shape `indexOf` answers, which is what the ASCII route IS and
// what the grapheme route has to agree with.
function positionOf(answer: OptionalType<IntegerType>): number {
	return answer[typeKeySymbol] === "Optional#Empty"
		? -1
		: Number(answer.item.value)
}

// NOTE: The character a position answers, or nothing — unwrapped here so that
// the assertions below read the answer rather than the Optional around it.
function characterOf(answer: OptionalType<StringType>): StringType | undefined {
	return answer[typeKeySymbol] === "Optional#Empty" ? undefined : answer.item
}

const first = (text: string, part: string) =>
	positionOf(firstIndex(string(text), string(part)))
const last = (text: string, part: string) =>
	positionOf(lastIndex(string(text), string(part)))
const occurrences = (text: string, part: string) =>
	Number(count(string(text), string(part)).value)

// NOTE: The same two questions asked with the case folded, which is the route
// that reads the receiver in chunks.
const folded = (text: string, part: string) =>
	positionOf(firstIndexFolded(string(text), string(part), insensitive))
const foldedLast = (text: string, part: string) =>
	positionOf(lastIndexFolded(string(text), string(part), insensitive))

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
// different code points — so that a search across the two proves it matches by
// canonical equivalence rather than by unit. See `graphemes.spec.ts`.
const composed = "café".normalize("NFC")
const decomposed = "café".normalize("NFD")
const family = "\u{1F468}\u200D\u{1F469}\u200D\u{1F467}\u200D\u{1F466}"

// NOTE: `split`, `ends`, `slice` and `character(at:)` take the intrinsic on
// the same condition the searches take it on, and each has to answer what the
// walk over the view answers.
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
	// NOTE: Two ASCII Strings are searched by the JavaScript intrinsics, and
	// these are the intrinsics' own answers: the first occurrence, the LAST
	// occurrence even where it overlaps an earlier one, and the occurrences
	// that do not overlap — the ones `split` cuts at.
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

	// NOTE: The one rule for the empty part, stated above `contains` in
	// `String.es`: it matches nowhere, except as a position at either end.
	test("the empty part is a position at either end and no occurrence", () => {
		expect(first("hello", "")).toBe(0)
		expect(last("hello", "")).toBe(5)
		expect(occurrences("hello", "")).toBe(0)

		expect(first("", "")).toBe(0)
		expect(last("", "")).toBe(0)
		expect(occurrences("", "")).toBe(0)

		// NOTE: The length is counted by grapheme, whichever route the empty
		// part would have taken.
		expect(last(`a${family}b`, "")).toBe(3)
	})

	// NOTE: A side the scan refuses goes through the grapheme view, and the
	// positions are then by grapheme: a joined emoji is ONE position, a base
	// and its combining mark are one, and a composed part is found inside a
	// decomposed String.
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

	// NOTE: A carriage return declines the ASCII route (see `isSingleUnitAscii`),
	// because CR LF is one cluster — so a line feed inside one is not found,
	// while the pair is.
	test("a carriage return is searched as part of its cluster", () => {
		expect(first("a\r\nb", "\n")).toBe(-1)
		expect(first("a\r\nb", "\r\n")).toBe(1)
		expect(last("a\r\nb", "b")).toBe(2)
		expect(occurrences("a\r\nb\r\n", "\r\n")).toBe(2)
	})

	// NOTE: The routes have to meet where one side qualifies and the other
	// does not: U+037E is the Greek question mark, whose NFC form is the ASCII
	// semicolon, so an ASCII String holds it by canonical equivalence.
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

	// NOTE: THE FOLDED FIRST-MATCH SEARCHES READ THE RECEIVER IN CHUNKS, so
	// that one costs the distance to its match rather than the whole receiver
	// — and a chunk can cut a match in half. Each chunk therefore begins
	// `part.length - 1` characters back inside the one before it, and ends that
	// far inside it walking from the back, which is the widest a match can hang
	// over a boundary by.
	//
	// NOTE: THE RECEIVERS HERE ARE LONG ON PURPOSE, and the part is put at
	// EVERY position of one rather than at the boundaries a reader worked out.
	// Neither route chunks a receiver under twice its chunk — 2,048 units on the
	// ASCII route, 32 characters on the view route — so every other search test
	// in this repository reads a receiver that takes the whole text in ONE call
	// and could not see a boundary bug at all. Sweeping every position needs no
	// arithmetic about where the chunks fall, and keeps holding when they move.
	//
	// NOTE: SIX THOUSAND UNITS rather than the least that chunks at all, because
	// the ASCII receiver has to reach the DOUBLING and not merely the first
	// boundary. Its chunks are 1,024 then 2,048, so it crosses a boundary at
	// 1,024 and another at 3,070 and its last chunk swallows the tail; at 3,000
	// units there would be one boundary and the doubled chunk would never be
	// walked. The view receiver crosses three at a floor of 16. Every position
	// of both is swept rather than the seams alone, which costs this file 90 ms
	// — a receiver long enough to cross a fourth boundary would cost it 1.4 s,
	// and the fourth boundary is the third one doubled again.
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

		// NOTE: A receiver the ASCII scan refuses, walked the same way — its
		// chunks are counted in CHARACTERS, and each `é` is one character and
		// one unit, so the position a search answers is the position the sweep
		// put the part at.
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

	// NOTE: The answers a chunked walk has to keep giving when there is nothing
	// to find, or nothing long enough to find it in — the three ways out of the
	// loop that the sweep above never takes. The receiver is over twice the
	// ASCII floor for the same reason the sweep's is: under that it is read in
	// one call and the loop these cases are about is never entered.
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

	// NOTE: The LAST match of a receiver holding several, which is what a
	// backward walk stopping at the first chunk that holds one has to answer —
	// and the FIRST where a forward walk would meet the later one too.
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
	// NOTE: Every Method that maps an ASCII String to an ASCII String marks
	// its answer, so that a loop measuring what it built does not rescan it.
	test("survives the Methods that map ASCII to ASCII", () => {
		let text = string("  Hello, World  ")

		expect(isMarkedAscii(uppercase(text))).toBeTrue()
		expect(isMarkedAscii(lowercase(text))).toBeTrue()
		// NOTE: `uppercase` above took the receiver's mark, and `trim` hands
		// down what the receiver carries rather than taking it itself — the
		// test below this one is about that, and asserts both halves.
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

	// NOTE: The one split that does not mark its pieces, and why: the empty
	// separator answers the characters, and a piece there is ONE unit — the
	// scan that would answer the mark reads it, so the mark saves nothing and
	// writing two Symbol keys per character of the receiver measured most of
	// the Method. It is still an ASCII String and still counts as one.
	test("leaves the characters of a split unmarked", () => {
		let text = string("  Hello, World  ")

		for (let piece of split(text, string("")).value) {
			expect(isUnmarked(piece)).toBeTrue()
			expect(length(piece).value).toBe(1)
		}
	})

	// NOTE: `trim` PROPAGATES the mark and never takes it. Taking it means
	// scanning the whole String to answer a question about its two ends,
	// which is what made trimming a fresh String cost its length; a receiver
	// something has already measured hands the answer down for free. The
	// order matters here, so the receiver is a fresh String per case.
	test("is propagated by trim, never taken by it", () => {
		expect(isUnmarked(trim(string("  Hello  "), bothEnds))).toBeTrue()

		let measured = string("  Hello  ")

		expect(length(measured).value).toBe(9)
		expect(isMarkedAscii(trim(measured, bothEnds))).toBeTrue()
		expect(isMarkedAscii(trim(measured, start))).toBeTrue()
		expect(isMarkedAscii(trim(measured, end))).toBeTrue()
	})

	// NOTE: The two ends a PROVEN String answers, whose fast path is the mark
	// itself: an ASCII receiver is read by unit and the answer is marked, and
	// every other receiver comes through the view and is not. So the mark on
	// the answer is what says which branch ran, and it is asserted rather than
	// timed. Reading the ends off the view built a String per character of the
	// receiver, which made the proven Method slower than the unproven
	// `character(at:)` it spares a Program the Optional of.
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

		// NOTE: The end of a String whose last character is several code
		// units, which is the whole reason the other branch reads the view.
		let emoji = string("ab😀")

		expect(lastCharacter(emoji).value).toBe("😀")
		expect(length(lastCharacter(emoji)).value).toBe(1)
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
	// NOTE: `words` reads the NFC form, as the position Methods do — they
	// read the character view, and the view is segmented off the normal form
	// — so the words of a String and the pieces of its `split` are the same
	// text in the same bytes.
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

	// NOTE: `trim` is the exception, and deliberately: normalising is about
	// the WHOLE String and trimming is about its two ends, so reading the
	// normal form made an O(1) Method cost the receiver's length. It hands
	// back the receiver's own bytes, which is the same String — no canonical
	// composition or decomposition creates or destroys whitespace, so the
	// trimmed decomposed text normalises to the trimmed composed text, and
	// the two compare Equal, key one Dictionary slot and count the same
	// characters.
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
