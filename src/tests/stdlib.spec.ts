import { describe, expect, it } from "bun:test"

import { enrich } from "../enricher/index"
import { parse } from "../parser/index"
import * as algebraic from "../rewriter/__internal/Algebraic"
import * as boolean from "../rewriter/__internal/Boolean"
import * as integer from "../rewriter/__internal/Integer"
import * as list from "../rewriter/__internal/List"
import { createNothing } from "../rewriter/__internal/Nothing"
import * as number from "../rewriter/__internal/Number"
import * as optional from "../rewriter/__internal/Optional"
import * as rational from "../rewriter/__internal/Rational"
import * as string from "../rewriter/__internal/String"
import * as transcendental from "../rewriter/__internal/Transcendental"
import { typeKeySymbol } from "../rewriter/__internal/type"
import { validate } from "../validator/index"

const int = (value: bigint) => integer.createInteger(value)
const rat = (numerator: bigint, denominator: bigint) =>
	rational.createRational(numerator, denominator)
const str = (value: string) => string.createString(value)
const bool = (value: boolean) => boolean.createBoolean(value)
const ints = (...values: Array<bigint>) => list.createList(values.map(int))

function diagnosticsFor(source: string) {
	let { program, diagnostics } = enrich(parse(source))

	return [...diagnostics, ...validate(program)].filter(
		(diagnostic) => diagnostic.severity === "error",
	)
}

describe("Stdlib", () => {
	describe("Integer everyday Methods", () => {
		it("takes the Euclidean remainder — never negative", () => {
			expect(integer.remainderOf(int(7n), int(3n))).toEqual(int(1n))
			expect(integer.remainderOf(int(-7n), int(3n))).toEqual(int(2n))
			expect(integer.remainderOf(int(-7n), int(-3n))).toEqual(int(2n))
			expect(integer.remainderOf(int(7n), int(-3n))).toEqual(int(1n))
			expect(integer.remainderOf(int(7n), int(0n))[typeKeySymbol]).toBe(
				"Nothing",
			)
		})

		it("raises to a power, exactly in both directions", () => {
			expect(integer.toThePowerOf(int(2n), int(10n))).toEqual(int(1024n))
			expect(integer.toThePowerOf(int(0n), int(0n))).toEqual(int(1n))

			const reciprocalPower = integer.toThePowerOf(int(2n), int(-2n))
			expect(reciprocalPower[typeKeySymbol]).toBe("Rational")
			expect(
				rational.is(reciprocalPower as never, rat(1n, 4n)).value,
			).toBe(true)

			expect(integer.toThePowerOf(int(0n), int(-1n))[typeKeySymbol]).toBe(
				"Nothing",
			)
		})

		it("answers absolute value, negation, parity and sign", () => {
			expect(integer.absolute(int(-5n))).toEqual(int(5n))
			expect(integer.absolute(int(5n))).toEqual(int(5n))
			expect(integer.negated(int(5n))).toEqual(int(-5n))
			expect(integer.isEven(int(0n)).value).toBe(true)
			expect(integer.isOdd(int(-3n)).value).toBe(true)
			expect(integer.isPositive(int(0n)).value).toBe(false)
			expect(integer.isNegative(int(0n)).value).toBe(false)
			expect(integer.isZero(int(0n)).value).toBe(true)
		})

		it("clamps into bounds, refusing inverted ones", () => {
			expect(integer.clampedBetween(int(15n), int(1n), int(10n))).toEqual(
				int(10n),
			)
			expect(integer.clampedBetween(int(-2n), int(1n), int(10n))).toEqual(
				int(1n),
			)
			expect(integer.clampedBetween(int(5n), int(1n), int(10n))).toEqual(
				int(5n),
			)
			expect(
				integer.clampedBetween(int(5n), int(10n), int(1n))[
					typeKeySymbol
				],
			).toBe("Nothing")
		})

		it("parses exactly the shape toString produces", () => {
			expect(integer.parse(str("42"))).toEqual(int(42n))
			expect(integer.parse(str("-42"))).toEqual(int(-42n))
			expect(integer.parse(str("+42"))[typeKeySymbol]).toBe("Nothing")
			expect(integer.parse(str("4.2"))[typeKeySymbol]).toBe("Nothing")
			expect(integer.parse(str(""))[typeKeySymbol]).toBe("Nothing")
			expect(integer.parse(str("nope"))[typeKeySymbol]).toBe("Nothing")
		})
	})

	describe("Rational everyday Methods", () => {
		it("exposes numerator and denominator in lowest terms, sign on top", () => {
			expect(rational.numerator(rat(2n, 4n))).toEqual(int(1n))
			expect(rational.denominator(rat(2n, 4n))).toEqual(int(2n))
			expect(rational.numerator(rat(3n, -4n))).toEqual(int(-3n))
			expect(rational.denominator(rat(3n, -4n))).toEqual(int(4n))
		})

		it("answers absolute value, negation and the reciprocal", () => {
			expect(
				rational.is(rational.absolute(rat(-3n, 4n)), rat(3n, 4n)).value,
			).toBe(true)
			expect(
				rational.is(rational.negated(rat(3n, 4n)), rat(-3n, 4n)).value,
			).toBe(true)

			const flipped = rational.reciprocal(rat(-3n, 4n))
			expect(flipped[typeKeySymbol]).toBe("Rational")
			expect(rational.is(flipped as never, rat(-4n, 3n)).value).toBe(true)

			expect(rational.reciprocal(rat(0n, 1n))[typeKeySymbol]).toBe(
				"Nothing",
			)
		})

		it("knows whether it is a whole number", () => {
			expect(rational.isWholeNumber(rat(4n, 2n)).value).toBe(true)
			expect(rational.isWholeNumber(rat(1n, 2n)).value).toBe(false)
		})

		it("rounds in all four directions", () => {
			expect(rational.rounded(rat(7n, 2n))).toEqual(int(4n))
			expect(rational.rounded(rat(-7n, 2n))).toEqual(int(-4n))
			expect(rational.rounded(rat(1n, 3n))).toEqual(int(0n))
			expect(rational.roundedDown(rat(7n, 2n))).toEqual(int(3n))
			expect(rational.roundedDown(rat(-7n, 2n))).toEqual(int(-4n))
			expect(rational.roundedUp(rat(7n, 2n))).toEqual(int(4n))
			expect(rational.roundedUp(rat(-7n, 2n))).toEqual(int(-3n))
			expect(rational.truncated(rat(7n, 2n))).toEqual(int(3n))
			expect(rational.truncated(rat(-7n, 2n))).toEqual(int(-3n))
		})

		it("raises to a power, exactly in both directions", () => {
			expect(
				rational.is(
					rational.toThePowerOf(rat(2n, 3n), int(2n)) as never,
					rat(4n, 9n),
				).value,
			).toBe(true)
			expect(
				rational.is(
					rational.toThePowerOf(rat(2n, 3n), int(-2n)) as never,
					rat(9n, 4n),
				).value,
			).toBe(true)
			expect(
				rational.toThePowerOf(rat(0n, 1n), int(-1n))[typeKeySymbol],
			).toBe("Nothing")
		})

		it("parses fractions, decimals and whole numbers", () => {
			expect(
				rational.is(rational.parse(str("3/4")) as never, rat(3n, 4n))
					.value,
			).toBe(true)
			expect(
				rational.is(rational.parse(str("-3/4")) as never, rat(-3n, 4n))
					.value,
			).toBe(true)
			expect(
				rational.is(rational.parse(str("0.75")) as never, rat(3n, 4n))
					.value,
			).toBe(true)
			expect(
				rational.is(rational.parse(str("-1.5")) as never, rat(-3n, 2n))
					.value,
			).toBe(true)
			expect(
				rational.is(rational.parse(str("5")) as never, rat(5n, 1n))
					.value,
			).toBe(true)
			expect(rational.parse(str("1/0"))[typeKeySymbol]).toBe("Nothing")
			expect(rational.parse(str("nope"))[typeKeySymbol]).toBe("Nothing")
		})
	})

	describe("Irrational sign Methods", () => {
		it("negates and takes the absolute value of an Algebraic", () => {
			const rootTwo = algebraic.createAlgebraic(
				{ numerator: 0n, denominator: 1n },
				{ numerator: 1n, denominator: 1n },
				2n,
			) as algebraic.AlgebraicType

			const negatedRoot = algebraic.negated(rootTwo)
			expect(negatedRoot.radicalCoefficientNumerator).toBe(-1n)
			expect(
				algebraic.is(algebraic.negated(negatedRoot), rootTwo).value,
			).toBe(true)
			expect(
				algebraic.is(algebraic.absolute(negatedRoot), rootTwo).value,
			).toBe(true)
			expect(
				algebraic.is(algebraic.absolute(rootTwo), rootTwo).value,
			).toBe(true)
		})

		it("negates and takes the absolute value of a Transcendental", () => {
			const negatedPi = transcendental.negated(number.PI)

			expect(negatedPi.piCoefficientNumerator).toBe(-1n)
			expect(
				transcendental.is(transcendental.absolute(negatedPi), number.PI)
					.value,
			).toBe(true)
			expect(
				transcendental.is(transcendental.absolute(number.PI), number.PI)
					.value,
			).toBe(true)
		})
	})

	describe("Number aggregates", () => {
		it("sums exactly, the empty List to zero", () => {
			expect(number.sum__overload$1(ints(1n, 2n, 3n))).toEqual(int(6n))
			expect(number.sum__overload$1(list.createList([]))).toEqual(int(0n))
			expect(
				rational.is(
					number.sum__overload$2(
						list.createList([rat(1n, 2n), rat(1n, 3n)]),
					),
					rat(5n, 6n),
				).value,
			).toBe(true)
		})

		it("collapses a whole mixed sum to an Integer", () => {
			const total = number.sum__overload$3(
				list.createList([int(1n), rat(1n, 2n), rat(1n, 2n)]),
			)

			expect(total).toEqual(int(2n))
		})

		it("multiplies exactly, the empty List to one", () => {
			expect(number.product__overload$1(ints(2n, 3n, 4n))).toEqual(
				int(24n),
			)
			expect(number.product__overload$1(list.createList([]))).toEqual(
				int(1n),
			)

			const mixed = number.product__overload$3(
				list.createList([int(3n), rat(1n, 3n)]),
			)
			expect(mixed).toEqual(int(1n))
		})

		it("averages to an exact Rational, the empty List to Nothing", () => {
			const mean = number.average__overload$1(ints(1n, 2n))

			expect(mean[typeKeySymbol]).toBe("Rational")
			expect(rational.is(mean as never, rat(3n, 2n)).value).toBe(true)

			expect(
				number.average__overload$1(list.createList([]))[typeKeySymbol],
			).toBe("Nothing")
		})
	})

	describe("Number isBetween", () => {
		it("includes both bounds", () => {
			expect(number.isBetween(int(5n), int(1n), int(10n)).value).toBe(
				true,
			)
			expect(number.isBetween(int(1n), int(1n), int(10n)).value).toBe(
				true,
			)
			expect(number.isBetween(int(10n), int(1n), int(10n)).value).toBe(
				true,
			)
			expect(number.isBetween(int(11n), int(1n), int(10n)).value).toBe(
				false,
			)
			expect(number.isBetween(int(0n), int(1n), int(10n)).value).toBe(
				false,
			)
		})

		it("reads the covering order — the whole tower qualifies", () => {
			expect(
				number.isBetween(number.PI, int(3n), rat(22n, 7n)).value,
			).toBe(true)
			expect(
				number.isBetween(number.PI, rat(22n, 7n), int(4n)).value,
			).toBe(false)
			expect(number.isBetween(rat(3n, 2n), int(1n), int(2n)).value).toBe(
				true,
			)
		})

		it("answers false for bounds in the wrong order", () => {
			expect(number.isBetween(int(5n), int(10n), int(1n)).value).toBe(
				false,
			)
		})
	})

	describe("Boolean exclusiveOr", () => {
		it("is true for exactly one true operand", () => {
			expect(boolean.exclusiveOr(bool(true), bool(false)).value).toBe(
				true,
			)
			expect(boolean.exclusiveOr(bool(false), bool(true)).value).toBe(
				true,
			)
			expect(boolean.exclusiveOr(bool(true), bool(true)).value).toBe(
				false,
			)
			expect(boolean.exclusiveOr(bool(false), bool(false)).value).toBe(
				false,
			)
		})
	})

	describe("Optional otherwise", () => {
		it("passes a value through and replaces Nothing", () => {
			expect(optional.otherwise(int(1n), int(0n))).toEqual(int(1n))
			expect(optional.otherwise(createNothing(), int(0n))).toEqual(
				int(0n),
			)
		})
	})

	describe("List round trips and construction", () => {
		it("joins Strings — the return trip of splitOn", () => {
			const pieces = string.splitOn(str("a,b,c"), str(","))

			expect(list.joinWith(pieces, str(" + ")).value).toBe("a + b + c")
			expect(list.joinWith(list.createList([]), str(",")).value).toBe("")
		})

		it("builds a List by repetition, never with a negative count", () => {
			expect(list.repeating(str("x"), int(3n))).toEqual(
				list.createList([str("x"), str("x"), str("x")]),
			)
			expect(list.repeating(str("x"), int(-1n))).toEqual(
				list.createList([]),
			)
		})

		it("builds inclusive Integer ranges, counting either way", () => {
			expect(list.of(int(1n), int(4n))).toEqual(ints(1n, 2n, 3n, 4n))
			expect(list.of(int(3n), int(1n))).toEqual(ints(3n, 2n, 1n))
			expect(list.of(int(2n), int(2n))).toEqual(ints(2n))
		})
	})

	describe("List restructuring", () => {
		it("flattens one level", () => {
			expect(
				list.flattened(
					list.createList([ints(1n, 2n), ints(), ints(3n)]),
				),
			).toEqual(ints(1n, 2n, 3n))
		})

		it("finds the last occurrence", () => {
			expect(list.lastIndexOf(ints(1n, 2n, 3n, 2n), int(2n))).toEqual(
				int(3n),
			)
			expect(list.lastIndexOf(ints(1n, 2n), int(9n))[typeKeySymbol]).toBe(
				"Nothing",
			)
		})

		it("partitions by a check, keeping order on both sides", () => {
			const partitions = list.partitioned(ints(1n, 2n, 3n, 4n), (item) =>
				integer.isEven(item),
			)

			expect(partitions.matching).toEqual(ints(2n, 4n))
			expect(partitions.rest).toEqual(ints(1n, 3n))
		})

		it("pairs position by position, stopping with the shorter List", () => {
			const pairs = list.pairedWith(
				list.createList([str("a"), str("b")]),
				ints(1n, 2n, 3n),
			)

			expect(pairs.value.length).toBe(2)
			expect(pairs.value[0].first).toEqual(str("a"))
			expect(pairs.value[0].second).toEqual(int(1n))
			expect(pairs.value[1].first).toEqual(str("b"))
			expect(pairs.value[1].second).toEqual(int(2n))
		})

		it("splits into groups, the last one shorter", () => {
			const groups = list.splitInto(ints(1n, 2n, 3n, 4n, 5n), int(2n))

			expect(groups).toEqual(
				list.createList([ints(1n, 2n), ints(3n, 4n), ints(5n)]),
			)
			expect(list.splitInto(ints(1n), int(0n))[typeKeySymbol]).toBe(
				"Nothing",
			)
		})

		it("sorts through a Comparable conformance", () => {
			expect(
				list.sorted(ints(3n, 1n, 2n), {
					compareTo: integer.compareTo,
				}),
			).toEqual(ints(1n, 2n, 3n))
		})
	})

	describe("Enricher typings", () => {
		it("types otherwise by the non-Nothing member", () => {
			expect(
				diagnosticsFor(`implementation {
					constant fallback: Integer = [1]::firstItem()::otherwise(0)
				}`),
			).toEqual([])
		})

		it("rejects a fallback of the wrong Type", () => {
			expect(
				diagnosticsFor(`implementation {
					constant fallback = [1]::firstItem()::otherwise("zero")
				}`),
			).not.toEqual([])
		})

		it("keeps otherwise off unbounded Type Parameters", () => {
			expect(
				diagnosticsFor(`implementation {
					function passThrough<Item>(_ item: Item) -> Item {
						<- item::otherwise(item)
					}
				}`),
			).not.toEqual([])
		})

		it("offers joinWith only on a List of Strings", () => {
			expect(
				diagnosticsFor(`implementation {
					constant joined: String = ["a", "b"]::joinWith(",")
				}`),
			).toEqual([])

			expect(
				diagnosticsFor(`implementation {
					constant joined = [1, 2]::joinWith(",")
				}`),
			).not.toEqual([])
		})

		it("bounds sorted by Comparable", () => {
			expect(
				diagnosticsFor(`implementation {
					constant ordered: List<Integer> = [3, 1, 2]::sorted()
				}`),
			).toEqual([])

			expect(
				diagnosticsFor(`implementation {
					constant ordered = [true, false]::sorted()
				}`),
			).not.toEqual([])
		})

		it("types the aggregate statics over Lists of Numbers", () => {
			expect(
				diagnosticsFor(`implementation {
					constant total: Integer = Number.sum([1, 2, 3])
					constant mean = Number.average([1, 2])
				}`),
			).toEqual([])
		})

		it("types isBetween across the tower", () => {
			expect(
				diagnosticsFor(`implementation {
					constant inRange: Boolean = Number.PI::isBetween(3, and 22/7)
					constant plain: Boolean = 5::isBetween(1, and 10)
				}`),
			).toEqual([])
		})

		it("types the parse statics as fallible", () => {
			expect(
				diagnosticsFor(`implementation {
					constant parsed: Integer = Integer.parse("42")::otherwise(0)
				}`),
			).toEqual([])
		})
	})
})
