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
import { boundConformance, typeKeySymbol } from "../rewriter/__internal/type"
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

		it("negates a value", () => {
			// NOTE: absolute, parity (isEven/isOdd), sign (isPositive/
			// isNegative/isZero) and clampedBetween are implemented in Essence
			// now (src/stdlib/Integer.es); the golden harness covers them. Only
			// negated stays native here.
			expect(integer.negated(int(5n))).toEqual(int(-5n))
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

	// NOTE: `Number.isBetween` used to be tested here, against the runtime
	// function directly. It is written in Essence now — `src/stdlib/Number.es`
	// — so there is no runtime function left to call, and the same five cases
	// are asserted end to end in `codeGeneration.spec.ts` ("runs isBetween from
	// the merged const" and the two beside it), where they exercise the
	// compiled Method the way a Program reaches it. The same move was made for
	// `Boolean.isNot` when it became the first Method to be written in Essence.

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

	// NOTE: `Optional.otherwise` is implemented in Essence now
	// (`src/stdlib/Optional.es`) — the golden harness exercises it end to end,
	// so the runtime-direct test that lived here is retired.

	describe("List round trips and construction", () => {
		// NOTE: `joinWith` is bounded by `Printable` rather than fixed to a
		// List of Strings, so the conformance witness is passed by hand here
		// the way the Simplifier passes it — String's `toString` is the
		// identity, Integer's is the conversion the widening bought.
		it("joins Strings — the return trip of splitOn", () => {
			const pieces = string.splitOn(str("a,b,c"), str(","))

			expect(
				list.joinWith(pieces, str(" + "), {
					toString: string.toString,
				}).value,
			).toBe("a + b + c")
			expect(
				list.joinWith(list.createList([]), str(","), {
					toString: string.toString,
				}).value,
			).toBe("")
		})

		it("joins any Printable items, not just Strings", () => {
			expect(
				list.joinWith(ints(1n, 2n, 3n), str(", "), {
					toString: integer.toString,
				}).value,
			).toBe("1, 2, 3")
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
				// NOTE: Integer.isEven is written in Essence now; the predicate
				// here checks parity on the runtime representation directly.
				boolean.createBoolean(item.value % 2n === 0n),
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
					compareTo: number.compareTo,
				}),
			).toEqual(ints(1n, 2n, 3n))
		})

		it("compares Lists lexicographically", () => {
			let integerConformance = { compareTo: number.compareTo }

			expect(
				list.compareTo(ints(1n, 2n), ints(1n, 3n), integerConformance)[
					typeKeySymbol
				],
			).toBe("Ordering#Less")

			expect(
				list.compareTo(ints(2n), ints(1n, 9n), integerConformance)[
					typeKeySymbol
				],
			).toBe("Ordering#Greater")

			expect(
				list.compareTo(ints(1n, 2n), ints(1n, 2n), integerConformance)[
					typeKeySymbol
				],
			).toBe("Ordering#Equal")
		})

		it("orders a shorter List before a longer one that shares its prefix", () => {
			expect(
				list.compareTo(ints(1n), ints(1n, 2n), {
					compareTo: number.compareTo,
				})[typeKeySymbol],
			).toBe("Ordering#Less")
		})

		it("sorts nested Lists through a bound conformance", () => {
			// NOTE: The witness the codegen builds for `List<List<Integer>>` —
			// `boundConformance` curries the inner Integer ordering onto
			// `List.compareTo`, exactly what `$type.boundConformance(...)` emits.
			let nested = boundConformance({ compareTo: list.compareTo }, [
				{ compareTo: number.compareTo },
			])

			expect(
				list.sorted(
					list.createList([ints(3n), ints(1n, 2n)]),
					nested as unknown as Parameters<typeof list.sorted>[1],
				),
			).toEqual(list.createList([ints(1n, 2n), ints(3n)]))
		})

		it("sorts three-level nested Lists", () => {
			let integerConformance = { compareTo: number.compareTo }
			let listOfIntegers = boundConformance(
				{ compareTo: list.compareTo },
				[integerConformance],
			)
			let listOfListOfIntegers = boundConformance(
				{ compareTo: list.compareTo },
				[listOfIntegers],
			)
			let listOfListOfListOfIntegers = boundConformance(
				{ compareTo: list.compareTo },
				[listOfListOfIntegers],
			)

			// NOTE: a and b are List<List<List<Integer>>>. Their first (only)
			// items order Greater vs Less at the innermost pair (2 vs 1), so a
			// sorts after b.
			let a = list.createList([list.createList([ints(2n)])])
			let b = list.createList([list.createList([ints(1n), ints(9n)])])

			expect(
				list.sorted(
					list.createList([a, b]),
					listOfListOfListOfIntegers as unknown as Parameters<
						typeof list.sorted
					>[1],
				),
			).toEqual(list.createList([b, a]))
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

		it("bounds joinWith by Printable, not by a String item Type", () => {
			expect(
				diagnosticsFor(`implementation {
					constant joined: String = ["a", "b"]::joinWith(",")
				}`),
			).toEqual([])

			expect(
				diagnosticsFor(`implementation {
					constant joined: String = [1, 2]::joinWith(",")
				}`),
			).toEqual([])

			expect(
				diagnosticsFor(`implementation {
					constant joined: String = [[1], [2]]::joinWith(",")
				}`),
			).toEqual([])

			// NOTE: The bound is what refuses a join, not a missing Method —
			// an unbounded Type Parameter conforms to nothing, so its items
			// have no `toString` to hand in.
			expect(
				diagnosticsFor(`implementation {
					function joinAll<Item>(_ items: List<Item>) -> String {
						<- items::joinWith(",")
					}
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
