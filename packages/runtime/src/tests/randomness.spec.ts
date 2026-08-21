import { describe, expect, test } from "bun:test"

import { createInteger } from "../Integer"
import { createList } from "../List"
import {
	below,
	bigBetween,
	boolean,
	createRandomness,
	fraction,
	integer,
	pick,
	type RandomnessType,
	rational,
	seedOf,
	string,
} from "../Randomness"
import { createRational } from "../Rational"
import { createString } from "../String"
import { typeKeySymbol } from "../type"

// NOTE: The Namespace `stdlibGolden.spec.ts` can not reach — every entry takes a
// source, and nothing written in Essence builds one. So the natives are driven
// here, directly, over fixed seeds: what each answers is random, and what is
// asserted about it is the range it lands in, the exactness it keeps, and that
// one seed answers one sequence.

function sourceOf(seed = "beef"): RandomnessType {
	return createRandomness(seedOf(seed))
}

describe("Randomness", () => {
	// NOTE: A bound WIDER than a word has no whole multiple inside one, so the
	// rejection loop would reject every draw. It is reachable from
	// `string(upTo:)`, whose bound is whatever a caller wrote.
	test("answers a bound wider than a word rather than looping", () => {
		let source = sourceOf()
		let bound = 4294967296 * 4

		for (let index = 0; index < 20; index++) {
			let drawn = below(source, bound)

			expect(drawn).toBeGreaterThanOrEqual(0)
			expect(drawn).toBeLessThan(bound)
		}
	})

	test("answers the same sequence for one seed", () => {
		let first = Array.from({ length: 64 }, () => below(sourceOf(), 1000))
		let second = Array.from({ length: 64 }, () => below(sourceOf(), 1000))

		expect(first).toEqual(second)

		let one = sourceOf()
		let other = sourceOf()

		expect(Array.from({ length: 64 }, () => below(one, 1000))).toEqual(
			Array.from({ length: 64 }, () => below(other, 1000)),
		)
	})

	test("answers a different sequence for a different seed", () => {
		let one = sourceOf("beef")
		let other = sourceOf("cafe")

		let drawn = Array.from({ length: 32 }, () => below(one, 1_000_000))
		let others = Array.from({ length: 32 }, () => below(other, 1_000_000))

		expect(drawn).not.toEqual(others)
	})

	test("advances the source with every answer", () => {
		let source = sourceOf()
		let first = boolean(source)
		let drawn = [first]

		for (let index = 0; index < 32; index++) {
			drawn.push(boolean(source))
		}

		// NOTE: Two reads of ONE source answer two values, which is the whole
		// reason a source is the one value in the language that changes.
		expect(drawn.some((value) => value.value !== first.value)).toBe(true)
	})

	test("carries the Randomness tag", () => {
		expect(sourceOf()[typeKeySymbol]).toBe("Randomness")
	})

	describe("below", () => {
		test("stays inside the bound", () => {
			let source = sourceOf()

			for (let index = 0; index < 2000; index++) {
				let drawn = below(source, 7)

				expect(drawn).toBeGreaterThanOrEqual(0)
				expect(drawn).toBeLessThan(7)
			}
		})

		test("answers zero for a bound of one or less", () => {
			let source = sourceOf()

			expect(below(source, 1)).toBe(0)
			expect(below(source, 0)).toBe(0)
			expect(below(source, -3)).toBe(0)
		})

		test("reaches every value of a small bound", () => {
			let source = sourceOf()
			let seen = new Set<number>()

			for (let index = 0; index < 400; index++) {
				seen.add(below(source, 6))
			}

			expect([...seen].sort()).toEqual([0, 1, 2, 3, 4, 5])
		})
	})

	describe("fraction", () => {
		test("stays in the half open unit range", () => {
			let source = sourceOf()

			for (let index = 0; index < 1000; index++) {
				let drawn = fraction(source)

				expect(drawn).toBeGreaterThanOrEqual(0)
				expect(drawn).toBeLessThan(1)
			}
		})
	})

	describe("bigBetween", () => {
		test("includes both bounds", () => {
			let source = sourceOf()
			let seen = new Set<bigint>()

			for (let index = 0; index < 400; index++) {
				seen.add(bigBetween(source, -2n, 2n))
			}

			expect([...seen].sort((a, b) => Number(a - b))).toEqual([
				-2n,
				-1n,
				0n,
				1n,
				2n,
			])
		})

		test("draws a span wider than a word", () => {
			let source = sourceOf()
			let low = -(10n ** 30n)
			let high = 10n ** 30n

			for (let index = 0; index < 200; index++) {
				let drawn = bigBetween(source, low, high)

				expect(drawn >= low && drawn <= high).toBe(true)
			}
		})

		test("answers the lower bound for a range that encloses nothing", () => {
			expect(bigBetween(sourceOf(), 5n, 3n)).toBe(5n)
			expect(bigBetween(sourceOf(), 5n, 5n)).toBe(5n)
		})
	})

	describe("integer", () => {
		test("includes both bounds", () => {
			let source = sourceOf()
			let seen = new Set<number | bigint>()

			for (let index = 0; index < 400; index++) {
				seen.add(
					integer(source, createInteger(1), createInteger(4)).value,
				)
			}

			expect([...seen].sort()).toEqual([1, 2, 3, 4])
		})

		test("answers the lower bound where the bounds are the wrong way round", () => {
			expect(
				integer(sourceOf(), createInteger(9), createInteger(2)).value,
			).toBe(9)
		})

		test("draws past the safe range as a bigint", () => {
			let source = sourceOf()
			let low = 10n ** 30n
			let drawn = integer(
				source,
				createInteger(low),
				createInteger(low + 10n ** 20n),
			)

			expect(typeof drawn.value).toBe("bigint")
			expect(drawn.value >= low).toBe(true)
		})
	})

	describe("rational", () => {
		test("stays inside the bounds", () => {
			let source = sourceOf()
			let low = createRational(-3n, 2n)
			let high = createRational(7n, 2n)

			for (let index = 0; index < 500; index++) {
				let drawn = rational(source, low, high)
				let scaled = drawn.numerator * 2n

				expect(scaled >= -3n * drawn.denominator).toBe(true)
				expect(scaled <= 7n * drawn.denominator).toBe(true)
			}
		})

		test("answers exact fractions with small denominators", () => {
			let source = sourceOf()
			let denominators = new Set<bigint>()

			for (let index = 0; index < 500; index++) {
				denominators.add(
					rational(
						source,
						createRational(0n, 1n),
						createRational(1n, 1n),
					).denominator,
				)
			}

			// NOTE: Every denominator is one of the table's, which is what makes
			// a drawn Rational one a reader recognises rather than a scaled
			// double.
			expect(
				[...denominators].every((denominator) =>
					[1n, 2n, 3n, 4n, 5n, 6n, 8n, 10n, 12n, 16n, 100n, 1000n]
						.map((entry) => entry)
						.includes(denominator),
				),
			).toBe(true)
		})

		test("answers the lower bound for a range too narrow to hold a multiple", () => {
			let drawn = rational(
				sourceOf(),
				createRational(1n, 7n),
				createRational(1n, 7n),
			)

			expect(drawn.numerator).toBe(1n)
			expect(drawn.denominator).toBe(7n)
		})
	})

	describe("string", () => {
		test("answers no more characters than asked for", () => {
			let source = sourceOf()

			for (let index = 0; index < 400; index++) {
				let drawn = string(source, createInteger(6))

				expect([...drawn.value].length).toBeLessThanOrEqual(8)
			}
		})

		test("answers the empty String for a bound of zero or less", () => {
			expect(string(sourceOf(), createInteger(0)).value).toBe("")
			expect(string(sourceOf(), createInteger(-4)).value).toBe("")
		})

		test("answers the empty String sometimes and a full one sometimes", () => {
			let source = sourceOf()
			let lengths = new Set<number>()

			for (let index = 0; index < 400; index++) {
				lengths.add(string(source, createInteger(3)).value.length)
			}

			expect(lengths.has(0)).toBe(true)
			expect(lengths.size).toBeGreaterThan(1)
		})
	})

	describe("pick", () => {
		test("answers an item of the List", () => {
			let source = sourceOf()
			let items = createList([
				createString("Lions"),
				createString("Tigers"),
				createString("Bears"),
			])
			let seen = new Set<string>()

			for (let index = 0; index < 300; index++) {
				seen.add(pick(source, items).value)
			}

			expect([...seen].sort()).toEqual(["Bears", "Lions", "Tigers"])
		})

		test("answers the one item of a List that holds one", () => {
			let items = createList([createString("Wolves")])

			expect(pick(sourceOf(), items).value).toBe("Wolves")
		})
	})

	describe("seedOf", () => {
		test("answers the same word for the same text", () => {
			expect(seedOf("41c37ea3")).toBe(seedOf("41c37ea3"))
		})

		test("answers a different word for different text", () => {
			expect(seedOf("41c37ea3")).not.toBe(seedOf("41c37ea4"))
		})
	})
})
