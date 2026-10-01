import { describe, expect, test } from "bun:test"

import { createInteger } from "../Integer"
import { anyIs } from "../internalHelpers"
import { createList } from "../List"
import { createEmpty, createValue } from "../Optional"
import { createRational } from "../Rational"
import { createRecord } from "../Record"
import {
	append,
	character__overload$1 as character,
	compare__overload$1 as compare,
	createString,
	length,
	repeat,
	slice,
	split__overload$1 as split,
} from "../String"
import { typeKeySymbol } from "../type"

// The same text in two spellings. Normalised here rather than written as
// literals, since an editor or a formatter may compose the decomposed one. The
// first test checks that they still differ.
const composed = "café".normalize("NFC")
const decomposed = "café".normalize("NFD")
const composedAccent = "é".normalize("NFC")
const decomposedAccent = "é".normalize("NFD")

// A family emoji, four people joined by zero-width joiners: one character.
const family = "\u{1F468}‍\u{1F469}‍\u{1F467}‍\u{1F466}"

const string = createString
const integer = createInteger
const value = createValue
const countOf = (value: string) => length(createString(value)).value

// The text rather than the Optional. A character of an ASCII String carries the
// ASCII marker and its count, which a deep comparison with a fresh String trips
// on.
const characterAt = (value: string, position: bigint) => {
	let answer = character(createString(value), createInteger(position))

	return answer[typeKeySymbol] === "Optional#Empty"
		? undefined
		: answer.item.value
}
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

// Unicode joins CR LF into one cluster, so a join that puts them together has
// fewer characters than its pieces. The ASCII marker excludes a carriage return,
// so `append` never adds counts across such a seam. See "The ASCII route" in
// packages/runtime/DEVELOPMENT.md.
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

		// Both operands are measured first, so a wrongly propagated count would
		// be handed out.
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

	// Every seam of a repeat is the same seam, so a String ending in CR and
	// beginning with LF loses one character per extra copy.
	test("a repeat that meets its own end is measured too", () => {
		expect(length(repeat(string("a\r\n"), integer(3n))).value).toBe(6)
		expect(length(repeat(string("\r\n"), integer(3n))).value).toBe(3)
		expect(length(repeat(string("\n\r"), integer(3n))).value).toBe(4)
		expect(repeat(string("\n\r"), integer(3n)).value).toBe("\n\r\n\r\n\r")
		// No seam, so the count is the text's own length.
		expect(length(repeat(string("ab"), integer(3n))).value).toBe(6)
		expect(repeat(string("ab"), integer(3n)).value).toBe("ababab")
	})

	test("an ordinary ASCII join counts as the two do", () => {
		let left = string("hello")
		let right = string(" world")

		expect(length(left).value).toBe(5)
		expect(length(append(left, right)).value).toBe(11)
		expect(length(append(string("hello"), string(" world"))).value).toBe(11)
		expect(length(append(string(""), string(""))).value).toBe(0)
	})
})

// A combining mark also joins its neighbour. A base with its mark is canonically
// equivalent to the composed character, so the spellings count, order and
// compare alike.
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

	// A base ending one String and a mark starting the next are one character,
	// so the join must propagate no count.
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

	// Position Methods read the grapheme view of the NFC form, so a mark stays
	// with its base and a character comes back composed. See "String characters"
	// in packages/runtime/DEVELOPMENT.md.
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

// Positions count from zero, a negative one counts back from the end, and an
// empty or inverted range is the empty String.
describe("positions", () => {
	test("a negative position counts back from the end", () => {
		expect(slice(string("abcde"), integer(0n), integer(-1n)).value).toBe(
			"abcd",
		)
		expect(slice(string("abcde"), integer(-2n), integer(5n)).value).toBe(
			"de",
		)
		expect(characterAt("abcde", -1n)).toBe("e")
		expect(characterAt("abcde", -5n)).toBe("a")
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

	test("a repeat below one is the empty String", () => {
		expect(repeat(string("ab"), integer(0n)).value).toBe("")
		expect(repeat(string("ab"), integer(-3n)).value).toBe("")
		expect(repeat(string(""), integer(5n)).value).toBe("")
		expect(length(repeat(string(""), integer(5n))).value).toBe(0)
	})
})

// Equality is asked both ways, since a normal form is remembered on one value
// and an asymmetric answer would hide there.
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

	// The second answer comes off the remembered form.
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

	// Ordering is by code point: an astral character sorts above the Basic
	// Multilingual Plane, though JavaScript's `<` on its surrogates says otherwise.
	test("ordering is by code point", () => {
		expect(orderOf("\u{1F600}", "�")).toBe(greater)
		expect(orderOf("�", "\u{1F600}")).toBe(less)
		expect(orderOf("\u{1F600}", "\u{1F600}")).toBe(equal)
		expect(orderOf("a\u{1F600}", "a\u{1F601}")).toBe(less)
		expect(orderOf(family, family)).toBe(equal)
		// An equal prefix puts the shorter String first.
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

// `1 is 1/1` holds, so differing tags do not mean differing values. Asked both
// ways, bare and wrapped, since a comparison that dispatches on the tags loses
// this easily.
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

	// A member the other lacks makes two Records unequal, whichever has more.
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
