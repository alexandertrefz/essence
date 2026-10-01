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
	raise__overload$1 as raise,
	remainder__overload$2 as remainder,
	sum,
	toString__overload$1,
} from "../Integer"
import { anyIs } from "../internalHelpers"
import {
	createList,
	item__overload$1 as item,
	length,
	of__overload$1 as of,
	slice,
} from "../List"
import { createRational, formatAsRational } from "../Rational"
import {
	character__overload$1 as character,
	createString,
	length as stringLength,
	slice as stringSlice,
} from "../String"
import { typeKeySymbol } from "../type"

// INVARIANT: an Integer in safe range is held as a number, and any other as a
// bigint. So each value has one representation. The Compiler emits `===` for
// equality, `<` and `>` order across both, and each operation checks its answer.

const SAFE = 9007199254740991
const SAFE_AS_BIG = 9007199254740991n

// The invariant as a predicate on an answer.
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
	return toString__overload$1(integer).value
}

// Values either side of the safe boundary, where the crossings start or land.
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

	// Only a value from outside takes this direction, since every operation
	// checks its own answer.
	test("takes a number past the boundary back to a bigint", () => {
		let escaped = createInteger(2 ** 60)

		expect(heldBy(escaped)).toBe("bigint")
		expect(isCanonical(escaped)).toBe(true)
		expect(decimalOf(escaped)).toBe("1152921504606846976")
	})

	// `-3 * 0` leaves a negative zero, which is canonical. It must print,
	// compare, order and cross to a host as `0` does.
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

	// A number's `toString` turns exponential at 1e21, far outside safe range,
	// and a bigint prints in decimal at any size.
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

	// The double product of two safe integers is correctly rounded. So a product
	// outside safe range rounds to at least 2^53 and can not pass for exact.
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

	// The escape arm checks for safe range only where the answer can still be
	// inside it. A product with an escaped factor comes back only for a zero
	// factor, including a negative zero, which `=== 0` answers true for.
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

		// Two numbers whose double answer left safe range have a true answer
		// outside it too, so it is built as a bigint unchecked. These are the
		// extreme answers two safe numbers can give.
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

	// The products closest to the boundary, where a rounding that carried would
	// show.
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

		// Negating zero must not leave a negative zero, which prints as `0` but
		// is a different double.
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

	// The number arm of `quotient` relies on `Math.trunc(a / b)` being exact for
	// safe integers. A carried rounding would show at the top of safe range.
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
				// Euclidean: the remainder is never negative, and the quotient
				// makes the pair reconstruct the dividend.
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
	// The Compiler emits `===` for `a is b` on Integers.
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

	// `1 is 1/1` holds, reading the Integer's value into a bigint for the
	// Rational side.
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

		// A slice clamps a bound past either end, as it does a safe one.
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
