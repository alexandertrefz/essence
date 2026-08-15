import { describe, expect, test } from "bun:test"

import { anyIs } from "../internalHelpers"
import {
	append,
	compare__overload$1 as compare,
	createString,
	length,
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
		expect(length(append(string("a\r"), string("\nb"))).value).toBe(3n)
		expect(length(append(string("\r"), string("\n"))).value).toBe(1n)
		expect(length(append(string("a\r"), string("b"))).value).toBe(3n)
		expect(length(append(string("a"), string("\nb"))).value).toBe(3n)
	})

	test("the joined String is measured however it was reached", () => {
		let left = string("a\r")
		let right = string("\nb")

		// NOTE: Both operands measured FIRST, so the join is asked after each
		// side has remembered its own count — the state in which a wrongly
		// propagated count would be handed out.
		expect(length(left).value).toBe(2n)
		expect(length(right).value).toBe(2n)
		expect(length(append(left, right)).value).toBe(3n)
	})

	test("the joined String splits on the cluster", () => {
		let joined = append(string("a\r"), string("\nb"))

		expect(
			split(joined, string("")).value.map((piece) => piece.value),
		).toEqual(["a", "\r\n", "b"])
	})

	// NOTE: An ASCII join with nothing at its seam is the case the marker is
	// FOR — the count is the two counts added, and it has to be the count.
	test("an ordinary ASCII join counts as the two do", () => {
		let left = string("hello")
		let right = string(" world")

		expect(length(left).value).toBe(5n)
		expect(length(append(left, right)).value).toBe(11n)
		expect(length(append(string("hello"), string(" world"))).value).toBe(
			11n,
		)
		expect(length(append(string(""), string(""))).value).toBe(0n)
	})
})

// NOTE: A combining mark is the other neighbour-decided join, and the one
// canonical equivalence is about: `e` and a combining acute ARE `é`, so the two
// spellings count, order and compare alike.
describe("combining marks", () => {
	test("both spellings count alike", () => {
		expect(countOf(composed)).toBe(4n)
		expect(countOf(decomposed)).toBe(4n)
		expect(countOf(composedAccent)).toBe(1n)
		expect(countOf(decomposedAccent)).toBe(1n)
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

		expect(length(joined).value).toBe(4n)
		expect(anyIs(joined, string(composed))).toBeTrue()
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
		expect(countOf("")).toBe(0n)
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
