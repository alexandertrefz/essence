import { describe, expect, test } from "bun:test"

import {
	add__overload$1 as add,
	compare,
	createInteger,
	difference,
	divide__overload$4 as divideExactly,
	type IntegerType,
	multiply__overload$1 as multiply,
	negate,
	product,
	quotient__overload$2 as quotient,
	raise,
	remainder__overload$2 as remainder,
	sum,
	toString,
} from "../Integer"
import { anyIs } from "../internalHelpers"
import { createList, item, length, of, slice } from "../List"
import { createRational, formatAsRational } from "../Rational"
import {
	character,
	createString,
	length as stringLength,
	slice as stringSlice,
} from "../String"
import { typeKeySymbol } from "../type"

// NOTE: An Integer is HYBRID — a JavaScript number while its value is one a
// double holds exactly, a bigint beyond that — and the whole design rests on ONE
// invariant, which this file is here to keep true:
//
//   1. A value in safe range is ALWAYS held as a number.
//   2. A value outside safe range is ALWAYS held as a bigint.
//
// Together they say a mathematical Integer has exactly ONE representation, which
// is what lets the Compiler emit `===` for equality, lets `<` and `>` decide the
// order across both, and lets every operation below check its own answer rather
// than its operands. Every assertion here is one of those two, or something that
// only holds because of them.

const SAFE = 9007199254740991
const SAFE_AS_BIG = 9007199254740991n

// NOTE: The invariant as a predicate, asked of an answer rather than reasoned
// about. It is the assertion nearly every test here ends with.
function isCanonical(integer: IntegerType): boolean {
	let value = integer.value

	return typeof value === "number"
		? value >= -SAFE && value <= SAFE
		: value < -SAFE_AS_BIG || value > SAFE_AS_BIG
}

function heldBy(integer: IntegerType): "number" | "bigint" {
	return typeof integer.value === "number" ? "number" : "bigint"
}

function decimalOf(integer: IntegerType): string {
	return toString(integer).value
}

// NOTE: The three values either side of the boundary, which is where every
// crossing below starts or lands.
const boundary = {
	below: 9007199254740990n,
	at: 9007199254740991n,
	past: 9007199254740992n,
	farPast: 9007199254740993n,
}

describe("the canonical representation", () => {
	test("holds every safe value as a number and every other as a bigint", () => {
		let cases: Array<[number | bigint, "number" | "bigint"]> = [
			[0, "number"],
			[0n, "number"],
			[-1n, "number"],
			[boundary.below, "number"],
			[boundary.at, "number"],
			[-boundary.at, "number"],
			[boundary.past, "bigint"],
			[-boundary.past, "bigint"],
			[boundary.farPast, "bigint"],
			[2n ** 200n, "bigint"],
		]

		for (let [built, held] of cases) {
			let integer = createInteger(built)

			expect(heldBy(integer)).toBe(held)
			expect(isCanonical(integer)).toBe(true)
			expect(decimalOf(integer)).toBe(BigInt(built).toString())
		}
	})

	// NOTE: The direction that only a value from OUTSIDE can take — every
	// operation checks its own answer, so nothing in here produces one.
	test("takes a number past the boundary back to a bigint", () => {
		let escaped = createInteger(2 ** 60)

		expect(heldBy(escaped)).toBe("bigint")
		expect(isCanonical(escaped)).toBe(true)
		expect(decimalOf(escaped)).toBe("1152921504606846976")
	})

	// NOTE: A product can leave a NEGATIVE ZERO behind — `-3 * 0` is `-0` in
	// IEEE 754 — and it is a number in safe range, so it is canonical by the
	// letter of the invariant. What this holds is that it is also invisible: it
	// prints, compares, orders and crosses to a host exactly as `0` does, so
	// there is no second spelling of zero for anything to tell apart.
	test("a negative zero is the zero it prints as", () => {
		let negative = product(-3, 0)

		expect(Object.is(negative.value, -0)).toBe(true)
		expect(isCanonical(negative)).toBe(true)
		expect(decimalOf(negative)).toBe("0")
		expect(negative.value === createInteger(0).value).toBe(true)
		expect(anyIs(negative, createInteger(0))).toBe(true)
		expect(anyIs(negative, createRational(0n, 5n))).toBe(true)
		expect(compare(negative, createInteger(0))[typeKeySymbol]).toBe(
			"Ordering#Equal",
		)
		expect(BigInt(negative.value)).toBe(0n)
	})

	// NOTE: A number's own `toString` reaches for exponential notation at 1e21.
	// A number-held Integer can not get near it, and a bigint spells itself in
	// decimal at any size — so no Integer ever prints as `1e+21`.
	test("never prints in exponential notation", () => {
		for (let integer of [
			createInteger(SAFE),
			createInteger(2n ** 200n),
			createInteger(-(2n ** 200n)),
		]) {
			expect(decimalOf(integer)).not.toContain("e")
		}
	})
})

describe("crossing the boundary", () => {
	test("addition escapes and comes back", () => {
		let cases: Array<[number | bigint, number | bigint, string, string]> = [
			[boundary.below, 1n, "9007199254740991", "number"],
			[boundary.at, 1n, "9007199254740992", "bigint"],
			[boundary.at, 2n, "9007199254740993", "bigint"],
			[-boundary.at, -1n, "-9007199254740992", "bigint"],
			[boundary.past, -1n, "9007199254740991", "number"],
			[boundary.past, -boundary.past, "0", "number"],
			[2n ** 200n, -(2n ** 200n), "0", "number"],
			[SAFE, SAFE, "18014398509481982", "bigint"],
			[-SAFE, -SAFE, "-18014398509481982", "bigint"],
		]

		for (let [left, right, expected, held] of cases) {
			let answer = sum(
				createInteger(left).value,
				createInteger(right).value,
			)

			expect(decimalOf(answer)).toBe(expected)
			expect(heldBy(answer)).toBe(held as "number" | "bigint")
			expect(isCanonical(answer)).toBe(true)
			expect(answer).toEqual(
				add(createInteger(left), createInteger(right)),
			)
		}
	})

	test("subtraction escapes and comes back", () => {
		let cases: Array<[number | bigint, number | bigint, string, string]> = [
			[boundary.at, -1n, "9007199254740992", "bigint"],
			[-boundary.at, 1n, "-9007199254740992", "bigint"],
			[boundary.past, 1n, "9007199254740991", "number"],
			[boundary.past, boundary.past, "0", "number"],
			[0, boundary.past, "-9007199254740992", "bigint"],
			[2n ** 200n, 2n ** 200n - 5n, "5", "number"],
		]

		for (let [left, right, expected, held] of cases) {
			let answer = difference(
				createInteger(left).value,
				createInteger(right).value,
			)

			expect(decimalOf(answer)).toBe(expected)
			expect(heldBy(answer)).toBe(held as "number" | "bigint")
			expect(isCanonical(answer)).toBe(true)
		}
	})

	// NOTE: The operation the answer-side check exists for. Two factors well
	// inside safe range can have a product far outside it, and the double
	// product of two safe integers is the correctly-rounded true product — so
	// a product that has left safe range rounds to a double AT OR ABOVE 2⁵³ and
	// can not come back inside to be mistaken for an exact answer.
	test("multiplication escapes where the factors did not", () => {
		let cases: Array<[number | bigint, number | bigint, string, string]> = [
			[94906265, 94906265, "9007199136250225", "number"],
			[94906266, 94906266, "9007199326062756", "bigint"],
			[3037000499, 3037000499, "9223372030926249001", "bigint"],
			[2 ** 26, 2 ** 26, "4503599627370496", "number"],
			[2 ** 27, 2 ** 27, "18014398509481984", "bigint"],
			[SAFE, 1n, "9007199254740991", "number"],
			[SAFE, -1n, "-9007199254740991", "number"],
			[SAFE, 2n, "18014398509481982", "bigint"],
			[2n ** 200n, 0n, "0", "number"],
			[2n ** 100n, 2n ** 100n, (2n ** 200n).toString(), "bigint"],
		]

		for (let [left, right, expected, held] of cases) {
			let answer = product(
				createInteger(left).value,
				createInteger(right).value,
			)

			expect(decimalOf(answer)).toBe(expected)
			expect(heldBy(answer)).toBe(held as "number" | "bigint")
			expect(isCanonical(answer)).toBe(true)
			expect(answer).toEqual(
				multiply(createInteger(left), createInteger(right)),
			)
		}
	})

	// NOTE: The escape arm canonicalises its answer only where the answer can
	// still BE inside safe range, because asking costs two bigint comparisons.
	// Two arguments say when it can not, and this is what holds them: a product
	// with an escaped factor can only come back for a zero factor, and a pair of
	// numbers whose double answer left safe range had a true answer that left it
	// too. Both are asked here from both sides, and with a negative zero, which
	// `=== 0` answers true for.
	test("keeps the escape arm's shortcuts honest", () => {
		let escapedValue = boundary.past
		let cases: Array<[number | bigint, number | bigint, string, string]> = [
			[escapedValue, 0, "0", "number"],
			[0, escapedValue, "0", "number"],
			[escapedValue, -0, "0", "number"],
			[-escapedValue, 0, "0", "number"],
			[2n ** 200n, 0, "0", "number"],
			[escapedValue, 1n, "9007199254740992", "bigint"],
			[1n, escapedValue, "9007199254740992", "bigint"],
			[escapedValue, -1n, "-9007199254740992", "bigint"],
			[-escapedValue, -1n, "9007199254740992", "bigint"],
		]

		for (let [left, right, expected, held] of cases) {
			let answer = product(
				createInteger(left).value,
				createInteger(right).value,
			)

			expect(decimalOf(answer)).toBe(expected)
			expect(heldBy(answer)).toBe(held as "number" | "bigint")
			expect(isCanonical(answer)).toBe(true)
		}

		// NOTE: The other shortcut — the two-number overflow, which is written
		// as the bigint it is rather than asked about. `SAFE + SAFE` and
		// `SAFE · SAFE` are the smallest answers either operation can leave
		// safe range with.
		for (let [answer, expected] of [
			[sum(SAFE, SAFE), (BigInt(SAFE) + BigInt(SAFE)).toString()],
			[sum(-SAFE, -SAFE), (-BigInt(SAFE) - BigInt(SAFE)).toString()],
			[difference(SAFE, -SAFE), (BigInt(SAFE) * 2n).toString()],
			[difference(-SAFE, SAFE), (BigInt(SAFE) * -2n).toString()],
			[product(SAFE, SAFE), (BigInt(SAFE) * BigInt(SAFE)).toString()],
			[product(SAFE, -SAFE), (BigInt(SAFE) * -BigInt(SAFE)).toString()],
		] as Array<[IntegerType, string]>) {
			expect(decimalOf(answer)).toBe(expected)
			expect(heldBy(answer)).toBe("bigint")
			expect(isCanonical(answer)).toBe(true)
		}
	})

	// NOTE: The exhaustive half of the argument above. Every product of two
	// factors that a double holds either fits safe range exactly or is caught —
	// so the check is asked of the products that sit closest to the boundary,
	// where a rounding that carried would show.
	test("catches every product that rounds near the boundary", () => {
		for (let offset = -4; offset <= 4; offset++) {
			for (let factor of [2n, 3n, 5n, 7n, 65536n]) {
				let left = BigInt(SAFE) + BigInt(offset)
				let exact = left * factor
				let answer = product(
					createInteger(left).value,
					createInteger(factor).value,
				)

				expect(decimalOf(answer)).toBe(exact.toString())
				expect(isCanonical(answer)).toBe(true)
			}
		}
	})

	test("negation stays canonical either side", () => {
		let cases: Array<[number | bigint, string, string]> = [
			[0, "0", "number"],
			[SAFE, "-9007199254740991", "number"],
			[-SAFE, "9007199254740991", "number"],
			[boundary.past, "-9007199254740992", "bigint"],
			[-boundary.past, "9007199254740992", "bigint"],
		]

		for (let [value, expected, held] of cases) {
			let answer = negate(createInteger(value))

			expect(decimalOf(answer)).toBe(expected)
			expect(heldBy(answer)).toBe(held as "number" | "bigint")
			expect(isCanonical(answer)).toBe(true)
		}

		// NOTE: Negating zero must not leave a negative zero behind, which is a
		// number that prints and compares as `0` but is not the same double.
		expect(Object.is(negate(createInteger(0)).value, 0)).toBe(true)
	})

	test("raising crosses in one step", () => {
		let cases: Array<[number, number, string, string]> = [
			[2, 52, "4503599627370496", "number"],
			[2, 53, "9007199254740992", "bigint"],
			[2, 200, (2n ** 200n).toString(), "bigint"],
			[10, 0, "1", "number"],
			[-3, 3, "-27", "number"],
		]

		for (let [base, power, expected, held] of cases) {
			let answer = raise(createInteger(base), createInteger(power))

			expect(answer[typeKeySymbol]).toBe("Optional#Value")

			let raised = (answer as { item: IntegerType }).item

			expect(decimalOf(raised)).toBe(expected)
			expect(heldBy(raised)).toBe(held as "number" | "bigint")
			expect(isCanonical(raised)).toBe(true)
		}
	})

	// NOTE: `Math.trunc(a / b)` is exact for two safe integers, which is what
	// the number arm of `quotient` rests on — so the cases here are the ones
	// where a rounding that carried across an integer boundary would show: a
	// dividend at the top of safe range over small divisors.
	test("quotient and remainder agree with the bigint arithmetic", () => {
		let dividends = [
			BigInt(SAFE),
			BigInt(SAFE) - 1n,
			-BigInt(SAFE),
			boundary.past,
			-boundary.past,
			2n ** 200n + 7n,
			0n,
			-7n,
		]
		let divisors = [1n, 2n, 3n, 7n, -3n, 1000000007n, boundary.past]

		for (let dividend of dividends) {
			for (let divisor of divisors) {
				let left = createInteger(dividend)
				let right = createInteger(divisor)
				let remainderOf = remainder(left, right)
				let quotientOf = quotient(left, right)
				// NOTE: Euclidean — a remainder is never negative, and the
				// quotient is whatever makes the pair reconstruct the dividend.
				let expectedRemainder =
					((dividend % divisor) +
						(divisor < 0n ? -divisor : divisor)) %
					(divisor < 0n ? -divisor : divisor)
				let expectedQuotient = (dividend - expectedRemainder) / divisor

				expect(decimalOf(remainderOf)).toBe(
					expectedRemainder.toString(),
				)
				expect(decimalOf(quotientOf)).toBe(expectedQuotient.toString())
				expect(isCanonical(remainderOf)).toBe(true)
				expect(isCanonical(quotientOf)).toBe(true)
			}
		}
	})
})

describe("equality and ordering across the two representations", () => {
	// NOTE: What the Compiler emits for `a is b` is `===` on what the two hold,
	// and it is the invariant that makes that the whole answer.
	test("=== decides equality exactly", () => {
		let values: Array<number | bigint> = [
			0,
			1,
			-1,
			SAFE,
			-SAFE,
			boundary.past,
			-boundary.past,
			2n ** 200n,
		]

		for (let left of values) {
			for (let right of values) {
				let same = BigInt(left) === BigInt(right)

				expect(
					createInteger(left).value === createInteger(right).value,
				).toBe(same)
				expect(anyIs(createInteger(left), createInteger(right))).toBe(
					same,
				)
			}
		}
	})

	test("orders a number against a bigint", () => {
		let ascending: Array<number | bigint> = [
			-(2n ** 200n),
			-boundary.past,
			-SAFE,
			-1,
			0,
			1,
			SAFE,
			boundary.past,
			2n ** 200n,
		]

		for (let first = 0; first < ascending.length; first++) {
			for (let second = 0; second < ascending.length; second++) {
				let ordering = compare(
					createInteger(ascending[first]!),
					createInteger(ascending[second]!),
				)
				let expected: (typeof ordering)[typeof typeKeySymbol] =
					first < second
						? "Ordering#Less"
						: first > second
							? "Ordering#Greater"
							: "Ordering#Equal"

				expect(ordering[typeKeySymbol]).toBe(expected)
			}
		}
	})

	// NOTE: The one cross-kind cell in the language — `1 is 1/1` holds — and it
	// reads an Integer's value into the bigint the Rational side is written on.
	test("an Integer equals the Rational spelling the same value", () => {
		expect(anyIs(createInteger(1), createRational(1n, 1n))).toBe(true)
		expect(anyIs(createInteger(2), createRational(4n, 2n))).toBe(true)
		expect(anyIs(createInteger(0), createRational(0n, 5n))).toBe(true)
		expect(anyIs(createInteger(-3), createRational(9n, -3n))).toBe(true)
		expect(
			anyIs(
				createInteger(boundary.past),
				createRational(boundary.past, 1n),
			),
		).toBe(true)
		expect(anyIs(createInteger(1), createRational(1n, 2n))).toBe(false)
	})

	test("exact division reads both representations into the Rational", () => {
		expect(
			formatAsRational(divideExactly(createInteger(1), createInteger(2))),
		).toBe("1/2")
		expect(
			formatAsRational(
				divideExactly(createInteger(boundary.past), createInteger(2)),
			),
		).toBe("4503599627370496/1")
	})
})

describe("the bridges that carry a position", () => {
	test("a List answers its length as a number", () => {
		let list = createList([createInteger(1), createInteger(2)])

		expect(length(list).value).toBe(2)
		expect(isCanonical(length(list))).toBe(true)
		expect(stringLength(createString("abc")).value).toBe(3)
	})

	test("an index past safe range is out of range rather than wrapped", () => {
		let list = createList([createInteger(7), createInteger(8)])
		let far = createInteger(boundary.past)
		let farBack = createInteger(-boundary.past)

		expect(item(list, far)[typeKeySymbol]).toBe("Optional#Empty")
		expect(item(list, farBack)[typeKeySymbol]).toBe("Optional#Empty")
		expect(item(list, createInteger(-1))).toEqual(
			item(list, createInteger(1)),
		)

		// NOTE: A slice clamps rather than refuses, so a bound past either end
		// answers the whole List or none of it — which is what the same bound
		// written as a safe number does.
		expect(slice(list, createInteger(0), far)).toEqual(
			slice(list, createInteger(0), createInteger(2)),
		)
		expect(slice(list, farBack, createInteger(2))).toEqual(
			slice(list, createInteger(0), createInteger(2)),
		)
		expect(slice(list, far, createInteger(2)).value).toEqual([])
	})

	test("a String position past safe range is out of range too", () => {
		let text = createString("abc")
		let far = createInteger(boundary.past)

		expect(character(text, far)[typeKeySymbol]).toBe("Optional#Empty")
		expect(
			character(text, createInteger(-boundary.past))[typeKeySymbol],
		).toBe("Optional#Empty")
		expect(stringSlice(text, createInteger(0), far).value).toBe("abc")
		expect(stringSlice(text, far, createInteger(3)).value).toBe("")
	})

	test("a range of Integers is built canonically at any size", () => {
		let small = of(createInteger(1), createInteger(4))

		expect(small.value.map((each) => each.value)).toEqual([1, 2, 3, 4])
		expect(small.value.every(isCanonical)).toBe(true)

		let crossing = of(
			createInteger(boundary.below),
			createInteger(boundary.farPast),
		)

		expect(crossing.value.map((each) => each.value)).toEqual([
			9007199254740990,
			9007199254740991,
			9007199254740992n,
			9007199254740993n,
		])
		expect(crossing.value.every(isCanonical)).toBe(true)
	})
})
