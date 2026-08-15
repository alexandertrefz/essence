import { describe, expect, test } from "bun:test"

import { createInteger } from "../Integer"
import { anyIs } from "../internalHelpers"
import { createList } from "../List"
import { createEmpty, createValue } from "../Optional"
import { createRational } from "../Rational"
import { createRecord } from "../Record"
import {
	append,
	character,
	compare__overload$1 as compare,
	createString,
	length,
	repeat,
	slice,
	split,
} from "../String"
import { typeKeySymbol } from "../type"

// NOTE: The pairs that make this file worth having: the same text spelled two
// ways. Normalised here rather than written as two literals, because an editor,
// a formatter or a file round trip may quietly compose the decomposed one and
// leave every assertion below asserting nothing — which is why the first test
// checks that they are still two spellings.
const composed = "café".normalize("NFC")
const decomposed = "café".normalize("NFD")
const composedAccent = "é".normalize("NFC")
const decomposedAccent = "é".normalize("NFD")

// NOTE: A family emoji — four people joined by zero-width joiners, ONE
// character to a reader.
const family = "\u{1F468}‍\u{1F469}‍\u{1F467}‍\u{1F466}"

const string = createString
const integer = createInteger
const value = createValue
const countOf = (value: string) => length(createString(value)).value
const orderOf = (first: string, second: string) =>
	compare(createString(first), createString(second))[typeKeySymbol]

const equal = "Ordering#Equal"
const less = "Ordering#Less"
const greater = "Ordering#Greater"

test("the two spellings really are two spellings", () => {
	expect(composed).not.toBe(decomposed)
	expect(composedAccent).not.toBe(decomposedAccent)
	expect(composed.normalize("NFC")).toBe(decomposed.normalize("NFC"))
})

// NOTE: The ASCII fast path is what `append` propagates and what skips
// normalisation, and CR is the one ASCII unit it must decline: Unicode joins CR
// LF into a SINGLE cluster, so a join that puts one against the other has FEWER
// characters than the two pieces had. The marker excludes a carriage return
// outright, which is why the seam can not arise — this is the test that says so.
describe("carriage returns across a join", () => {
	test("a CR meeting an LF is one character", () => {
		expect(length(append(string("a\r"), string("\nb"))).value).toBe(3)
		expect(length(append(string("\r"), string("\n"))).value).toBe(1)
		expect(length(append(string("a\r"), string("b"))).value).toBe(3)
		expect(length(append(string("a"), string("\nb"))).value).toBe(3)
	})

	test("the joined String is measured however it was reached", () => {
		let left = string("a\r")
		let right = string("\nb")

		// NOTE: Both operands measured FIRST, so the join is asked after each
		// side has remembered its own count — the state in which a wrongly
		// propagated count would be handed out.
		expect(length(left).value).toBe(2)
		expect(length(right).value).toBe(2)
		expect(length(append(left, right)).value).toBe(3)
	})

	test("the joined String splits and slices on the cluster", () => {
		let joined = append(string("a\r"), string("\nb"))

		expect(
			split(joined, string("")).value.map((piece) => piece.value),
		).toEqual(["a", "\r\n", "b"])
		expect(slice(joined, integer(0n), integer(2n)).value).toBe("a\r\n")
		expect(slice(joined, integer(1n), integer(3n)).value).toBe("\r\nb")
		expect(character(joined, integer(1n))).toEqual(value(string("\r\n")))
	})

	// NOTE: A repeat is a join of the String with ITSELF, so its every seam is
	// the same seam — a String ending in CR and beginning with LF loses one
	// character per copy after the first.
	test("a repeat that meets its own end is measured too", () => {
		expect(length(repeat(string("a\r\n"), integer(3n))).value).toBe(6)
		expect(length(repeat(string("\r\n"), integer(3n))).value).toBe(3)
		expect(length(repeat(string("\n\r"), integer(3n))).value).toBe(4)
		expect(repeat(string("\n\r"), integer(3n)).value).toBe("\n\r\n\r\n\r")
		// NOTE: The ASCII case the marker is for — no seam, so the count is the
		// text's own length.
		expect(length(repeat(string("ab"), integer(3n))).value).toBe(6)
		expect(repeat(string("ab"), integer(3n)).value).toBe("ababab")
	})

	// NOTE: An ASCII join with nothing at its seam is the case the marker is
	// FOR — the count is the two counts added, and it has to be the count.
	test("an ordinary ASCII join counts as the two do", () => {
		let left = string("hello")
		let right = string(" world")

		expect(length(left).value).toBe(5)
		expect(length(append(left, right)).value).toBe(11)
		expect(length(append(string("hello"), string(" world"))).value).toBe(11)
		expect(length(append(string(""), string(""))).value).toBe(0)
	})
})

// NOTE: A combining mark is the other neighbour-decided join, and the one
// canonical equivalence is about: `e` and a combining acute ARE `é`, so the two
// spellings count, order and compare alike.
describe("combining marks", () => {
	test("both spellings count alike", () => {
		expect(countOf(composed)).toBe(4)
		expect(countOf(decomposed)).toBe(4)
		expect(countOf(composedAccent)).toBe(1)
		expect(countOf(decomposedAccent)).toBe(1)
	})

	test("both spellings are one String", () => {
		expect(anyIs(string(composed), string(decomposed))).toBeTrue()
		expect(anyIs(string(decomposed), string(composed))).toBeTrue()
		expect(orderOf(composed, decomposed)).toBe(equal)
		expect(orderOf(decomposed, composed)).toBe(equal)
	})

	// NOTE: The join that DOES change a cluster, and so must propagate nothing:
	// a base at the end of one String and a mark at the start of the next are
	// one character, not two.
	test("a mark joined onto a base is one character", () => {
		let joined = append(string("cafe"), string("́"))

		expect(length(joined).value).toBe(4)
		expect(anyIs(joined, string(composed))).toBeTrue()
	})

	test("both spellings slice alike", () => {
		let first = slice(string(composed), integer(3n), integer(4n))
		let second = slice(string(decomposed), integer(3n), integer(4n))

		expect(anyIs(first, second)).toBeTrue()
		expect(length(first).value).toBe(1)
		expect(length(second).value).toBe(1)
		expect(anyIs(first, string(composedAccent))).toBeTrue()
	})

	// NOTE: A position Method reads the grapheme view, so it can never cut a
	// mark away from the base it belongs to — whichever way the text is spelled.
	// The view is taken of the NFC form, so the character it hands back is the
	// COMPOSED spelling however the String was written: the two are one
	// character, and this is which of them a reader is given.
	test("a mark is never cut away from its base", () => {
		expect(character(string(decomposed), integer(3n))).toEqual(
			value(string(composedAccent)),
		)
		expect(character(string(decomposed), integer(3n))).toEqual(
			character(string(composed), integer(3n)),
		)
		expect(slice(string(decomposed), integer(0n), integer(3n)).value).toBe(
			"caf",
		)
		expect(character(string(family), integer(0n))).toEqual(
			value(string(family)),
		)
		expect(length(repeat(string(family), integer(3n))).value).toBe(3)
	})
})

// NOTE: Positions count from zero, a negative one counts back from the end, and
// an empty or inverted range is the empty String — the resolution `List.slice`
// used to perform for these, now performed where they are.
describe("positions", () => {
	test("a negative position counts back from the end", () => {
		expect(slice(string("abcde"), integer(0n), integer(-1n)).value).toBe(
			"abcd",
		)
		expect(slice(string("abcde"), integer(-2n), integer(5n)).value).toBe(
			"de",
		)
		expect(character(string("abcde"), integer(-1n))).toEqual(
			value(string("e")),
		)
		expect(character(string("abcde"), integer(-5n))).toEqual(
			value(string("a")),
		)
	})

	test("a position outside the String has no character", () => {
		expect(character(string(""), integer(0n))).toEqual(createEmpty())
		expect(character(string("ab"), integer(2n))).toEqual(createEmpty())
		expect(character(string("ab"), integer(-3n))).toEqual(createEmpty())
	})

	test("each end of a range is clamped, and an inverted one is empty", () => {
		expect(slice(string("abc"), integer(-99n), integer(99n)).value).toBe(
			"abc",
		)
		expect(slice(string("abc"), integer(2n), integer(1n)).value).toBe("")
		expect(slice(string("abc"), integer(1n), integer(1n)).value).toBe("")
		expect(slice(string(""), integer(0n), integer(5n)).value).toBe("")
		expect(slice(string("abc"), integer(5n), integer(9n)).value).toBe("")
	})

	// NOTE: A repeat below one is the empty String, which is what repeating
	// into the empty List and joining it gave.
	test("a repeat below one is the empty String", () => {
		expect(repeat(string("ab"), integer(0n)).value).toBe("")
		expect(repeat(string("ab"), integer(-3n)).value).toBe("")
		expect(repeat(string(""), integer(5n)).value).toBe("")
		expect(length(repeat(string(""), integer(5n))).value).toBe(0)
	})
})

// NOTE: Equality is asked in BOTH directions everywhere, because a remembered
// normal form is remembered on ONE of the two values and an asymmetric answer
// would be the bug that hides in it.
describe("normalisation-sensitive equality", () => {
	test("holds whichever side is asked first", () => {
		for (let [first, second] of [
			[composed, decomposed],
			[decomposedAccent, composedAccent],
			[`x${composed}y`, `x${decomposed}y`],
		]) {
			expect(anyIs(string(first!), string(second!))).toBeTrue()
			expect(anyIs(string(second!), string(first!))).toBeTrue()
		}
	})

	// NOTE: The same value asked twice — the second answer comes off the
	// remembered form, and it has to be the first answer.
	test("holds however often it is asked", () => {
		let left = string(composed)
		let right = string(decomposed)

		expect(anyIs(left, right)).toBeTrue()
		expect(anyIs(left, right)).toBeTrue()
		expect(compare(left, right)[typeKeySymbol]).toBe(equal)
		expect(anyIs(left, string("other"))).toBeFalse()
		expect(anyIs(left, right)).toBeTrue()
	})

	test("differing Strings stay differing", () => {
		expect(anyIs(string(composed), string("cafe"))).toBeFalse()
		expect(anyIs(string("cafe"), string(decomposed))).toBeFalse()
		expect(orderOf("cafe", composed)).toBe(less)
		expect(orderOf(composed, "cafe")).toBe(greater)
	})

	// NOTE: Ordering is by CODE POINT, not by code unit — an astral character
	// sorts above every character in the Basic Multilingual Plane, which is the
	// opposite of what JavaScript's own `<` says about the surrogates spelling
	// it.
	test("ordering is by code point", () => {
		expect(orderOf("\u{1F600}", "�")).toBe(greater)
		expect(orderOf("�", "\u{1F600}")).toBe(less)
		expect(orderOf("\u{1F600}", "\u{1F600}")).toBe(equal)
		expect(orderOf("a\u{1F600}", "a\u{1F601}")).toBe(less)
		expect(orderOf(family, family)).toBe(equal)
		// NOTE: An equal prefix leaves the shorter String first, counted in
		// code POINTS — the astral character is two units and one point.
		expect(orderOf("a\u{1F600}", "a")).toBe(greater)
		expect(orderOf("a", "a\u{1F600}")).toBe(less)
	})
})

describe("empty Strings", () => {
	test("the empty String is equal to and orders below every other", () => {
		expect(countOf("")).toBe(0)
		expect(anyIs(string(""), string(""))).toBeTrue()
		expect(anyIs(string(""), string("a"))).toBeFalse()
		expect(anyIs(string("a"), string(""))).toBeFalse()
		expect(orderOf("", "")).toBe(equal)
		expect(orderOf("", "a")).toBe(less)
		expect(orderOf("a", "")).toBe(greater)
		expect(append(string(""), string("ab")).value).toBe("ab")
		expect(append(string("ab"), string("")).value).toBe("ab")
	})
})

// NOTE: The one cross-kind cell of the universal equality, and the trap in
// deciding it by tag: an Integer and a Rational spell the SAME value two ways,
// so `1 is 1/1` holds and differing tags do NOT mean differing values. Asked in
// both directions, bare and wrapped, because a comparison that reads the two
// tags and dispatches on them is one early return away from losing this
// quietly.
describe("Integer beside Rational", () => {
	test("the same value is equal either way round", () => {
		expect(anyIs(createInteger(1n), createRational(1n, 1n))).toBeTrue()
		expect(anyIs(createRational(1n, 1n), createInteger(1n))).toBeTrue()
		expect(anyIs(createInteger(2n), createRational(4n, 2n))).toBeTrue()
		expect(anyIs(createRational(4n, 2n), createInteger(2n))).toBeTrue()
		expect(anyIs(createInteger(0n), createRational(0n, 5n))).toBeTrue()
		expect(anyIs(createInteger(-3n), createRational(-9n, 3n))).toBeTrue()
		expect(anyIs(createRational(-9n, 3n), createInteger(-3n))).toBeTrue()
	})

	test("a different value is unequal either way round", () => {
		expect(anyIs(createInteger(1n), createRational(1n, 2n))).toBeFalse()
		expect(anyIs(createRational(1n, 2n), createInteger(1n))).toBeFalse()
		expect(anyIs(createRational(1n, 2n), createRational(2n, 4n))).toBeTrue()
		expect(
			anyIs(createRational(1n, 2n), createRational(1n, 3n)),
		).toBeFalse()
		expect(anyIs(createInteger(1n), createInteger(2n))).toBeFalse()
	})

	// NOTE: Inside a Record and inside a List, which is where a lost cell shows
	// up as a value that stopped being equal to its equal the moment either was
	// wrapped.
	test("the same value is equal wrapped as well as bare", () => {
		expect(
			anyIs(
				createRecord({ count: createInteger(1n) }),
				createRecord({ count: createRational(1n, 1n) }),
			),
		).toBeTrue()
		expect(
			anyIs(
				createRecord({ count: createRational(4n, 2n) }),
				createRecord({ count: createInteger(2n) }),
			),
		).toBeTrue()
		expect(
			anyIs(
				createRecord({ count: createInteger(1n) }),
				createRecord({ count: createRational(1n, 2n) }),
			),
		).toBeFalse()
		expect(
			anyIs(
				createList([createInteger(2n), createInteger(1n)]),
				createList([createRational(4n, 2n), createRational(3n, 3n)]),
			),
		).toBeTrue()
	})

	// NOTE: Records are equal by their MEMBERS, whatever order they were
	// written in, and a Record carrying a member the other lacks is unequal
	// however the counts fall.
	test("Records compare by their members, in any order", () => {
		expect(
			anyIs(
				createRecord({ a: createInteger(1n), b: string("x") }),
				createRecord({ b: string("x"), a: createRational(1n, 1n) }),
			),
		).toBeTrue()
		expect(
			anyIs(
				createRecord({ a: createInteger(1n) }),
				createRecord({ b: createInteger(1n) }),
			),
		).toBeFalse()
		expect(
			anyIs(
				createRecord({ a: createInteger(1n) }),
				createRecord({ a: createInteger(1n), b: createInteger(2n) }),
			),
		).toBeFalse()
		expect(
			anyIs(
				createRecord({ a: createInteger(1n), b: createInteger(2n) }),
				createRecord({ a: createInteger(1n) }),
			),
		).toBeFalse()
		expect(anyIs(createRecord({}), createRecord({}))).toBeTrue()
	})

	test("a value of one kind is equal to no value of another", () => {
		expect(anyIs(createRational(1n, 1n), string("1"))).toBeFalse()
		expect(anyIs(createInteger(1n), string("1"))).toBeFalse()
		expect(anyIs(string("1"), createInteger(1n))).toBeFalse()
		expect(anyIs(createInteger(1n), createList([]))).toBeFalse()
		expect(anyIs(createRecord({}), createList([]))).toBeFalse()
	})
})
