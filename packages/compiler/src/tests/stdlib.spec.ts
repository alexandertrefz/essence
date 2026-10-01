import { describe, expect, it } from "bun:test"

import * as algebraic from "@essence-lang/runtime/Algebraic"
import * as boolean from "@essence-lang/runtime/Boolean"
import * as integer from "@essence-lang/runtime/Integer"
import * as list from "@essence-lang/runtime/List"
import * as number from "@essence-lang/runtime/Number"
import * as optional from "@essence-lang/runtime/Optional"
import * as rational from "@essence-lang/runtime/Rational"
import * as string from "@essence-lang/runtime/String"
import * as transcendental from "@essence-lang/runtime/Transcendental"
import {
	type AnyType,
	boundConformance,
	typeKeySymbol,
} from "@essence-lang/runtime/type"

import { enrich } from "../enricher/index"
import { parse } from "../parser/index"
import { validate } from "../validator/index"

const int = (value: bigint) => integer.createInteger(value)
const rat = (numerator: bigint, denominator: bigint) =>
	rational.createRational(numerator, denominator)
const str = (value: string) => string.createString(value)
const bool = (value: boolean) => boolean.createBoolean(value)
const ints = (...values: Array<bigint>) => list.createList(values.map(int))

// A fallible native answers `Optional#Value { item }` or `Optional#Empty`.
// These build the same values, so an assertion can name the whole answer.
const value = <ItemType extends AnyType>(item: ItemType) =>
	optional.createValue(item)
const empty = () => optional.createEmpty()

// For assertions that read the value inside rather than compare the whole
// answer. It asserts the `#Value` Case, so an empty answer fails here rather
// than as an undefined member later.
const unwrap = <ItemType extends AnyType>(
	answer: optional.OptionalType<ItemType>,
): ItemType => {
	expect(answer[typeKeySymbol]).toBe("Optional#Value")

	return (answer as optional.ValueType<ItemType>).item
}

// `Rational.is` is written in Essence, so the runtime has no function to
// compare two Rationals. The specs that need value equality cross-multiply.
const ratIs = (
	first: rational.RationalType,
	second: rational.RationalType,
): boolean =>
	first.numerator * second.denominator ===
	second.numerator * first.denominator

// `String.toString` is the identity, written in Essence, so the runtime has
// no export to hand `join` as its `Printable` witness.
const stringToString = (value: string.StringType) => value

// `Integer.is` is written in Essence too. The List Methods bounded by
// `Equatable` take it as their hidden witness, and two Integers are equal
// exactly when their values match.
const integerIs = (first: integer.IntegerType, second: integer.IntegerType) =>
	bool(first.value === second.value)

function diagnosticsFor(source: string) {
	let { program, diagnostics } = enrich(parse(source))

	return [...diagnostics, ...validate(program)].filter(
		(diagnostic) => diagnostic.severity === "error",
	)
}

describe("Stdlib", () => {
	describe("Integer everyday Methods", () => {
		it("takes the Euclidean remainder — never negative, and is empty on a zero divisor", () => {
			expect(integer.remainder__overload$1(int(7n), int(3n))).toEqual(
				value(int(1n)),
			)
			expect(integer.remainder__overload$1(int(-7n), int(3n))).toEqual(
				value(int(2n)),
			)
			expect(integer.remainder__overload$1(int(-7n), int(-3n))).toEqual(
				value(int(2n)),
			)
			expect(integer.remainder__overload$1(int(7n), int(-3n))).toEqual(
				value(int(1n)),
			)
			expect(integer.remainder__overload$1(int(7n), int(0n))).toEqual(
				empty(),
			)

			// The entry whose divisor is a NonZeroInteger answers no Optional.
			expect(integer.remainder__overload$2(int(-7n), int(3n))).toEqual(
				int(2n),
			)
		})

		it("raises to a power, exactly in both directions", () => {
			expect(integer.raise__overload$1(int(2n), int(10n))).toEqual(
				value(int(1024n)),
			)
			expect(integer.raise__overload$1(int(0n), int(0n))).toEqual(
				value(int(1n)),
			)

			// A negative exponent widens the answer to a Rational, so the spec
			// reads the payload's Type tag.
			const reciprocalPower = unwrap(
				integer.raise__overload$1(int(2n), int(-2n)),
			)
			expect(reciprocalPower[typeKeySymbol]).toBe("Rational")
			expect(ratIs(reciprocalPower as never, rat(1n, 4n))).toBe(true)

			expect(integer.raise__overload$1(int(0n), int(-1n))).toEqual(
				empty(),
			)
		})

		it("negates a value", () => {
			// The golden harness covers the Essence sign Methods and the native
			// `absolute`.
			expect(integer.negate(int(5n))).toEqual(int(-5n))
		})
	})

	describe("Rational everyday Methods", () => {
		it("exposes numerator and denominator in lowest terms, sign on top", () => {
			expect(rational.numerator(rat(2n, 4n))).toEqual(int(1n))
			expect(rational.denominator(rat(2n, 4n))).toEqual(int(2n))
			expect(rational.numerator(rat(3n, -4n))).toEqual(int(-3n))
			expect(rational.denominator(rat(3n, -4n))).toEqual(int(4n))
		})

		it("raises to a power, exactly in both directions", () => {
			expect(
				ratIs(
					unwrap(rational.raise__overload$1(rat(2n, 3n), int(2n))),
					rat(4n, 9n),
				),
			).toBe(true)
			expect(
				ratIs(
					unwrap(rational.raise__overload$1(rat(2n, 3n), int(-2n))),
					rat(9n, 4n),
				),
			).toBe(true)
			expect(rational.raise__overload$1(rat(0n, 1n), int(-1n))).toEqual(
				empty(),
			)
		})
	})

	// `negate` is native on Algebraic and Transcendental. The golden harness,
	// `packages/fixtures/files/StdlibExhaustive.es`, covers their other sign
	// Methods.
	describe("Irrational sign Methods", () => {
		it("negates an Algebraic", () => {
			const rootTwo = algebraic.createAlgebraic(
				{ numerator: 0n, denominator: 1n },
				{ numerator: 1n, denominator: 1n },
				2n,
			) as algebraic.AlgebraicType

			const negatedRoot = algebraic.negate(rootTwo)
			expect(negatedRoot.radicalCoefficientNumerator).toBe(-1n)
			expect(algebraic.negate(negatedRoot)).toEqual(rootTwo)
		})

		it("negates a Transcendental", () => {
			const negatedPi = transcendental.negate(number.Pi)

			expect(negatedPi.terms[0]!.coefficientNumerator).toBe(-1n)
			expect(transcendental.negate(negatedPi)).toEqual(number.Pi)
		})
	})

	describe("List round trips and construction", () => {
		// `join` is bounded by `Printable`, so the specs pass the witness by
		// hand as the Simplifier would.
		it("joins Strings — the return trip of split", () => {
			const pieces = string.split__overload$1(str("a,b,c"), str(","))

			expect(
				list.join(pieces, str(" + "), {
					toString: stringToString,
				}).value,
			).toBe("a + b + c")
			expect(
				list.join(list.createList([]), str(","), {
					toString: stringToString,
				}).value,
			).toBe("")
		})

		it("joins any Printable items, not just Strings", () => {
			expect(
				list.join(ints(1n, 2n, 3n), str(", "), {
					toString: integer.toString__overload$1,
				}).value,
			).toBe("1, 2, 3")
		})

		// The range natives share one walk and differ in the step and in
		// whether the answer holds an item. `ranges.spec.ts` calls them from
		// Programs.
		it("builds inclusive Integer ranges, counting up", () => {
			expect(list.of__overload$1(int(1n), int(4n))).toEqual(
				ints(1n, 2n, 3n, 4n),
			)
			expect(list.of__overload$1(int(3n), int(1n))).toEqual(ints())
			expect(list.of__overload$1(int(2n), int(2n))).toEqual(ints(2n))
		})

		it("builds inclusive Integer ranges, counting down", () => {
			expect(list.of__overload$3(int(4n), int(1n))).toEqual(
				ints(4n, 3n, 2n, 1n),
			)
			expect(list.of__overload$3(int(2n), int(2n))).toEqual(ints(2n))
			expect(list.of__overload$3(int(1n), int(3n))).toEqual(ints(1n))
		})

		it("steps a range by a signed amount", () => {
			expect(list.of__overload$4(int(0n), int(9n), int(3n))).toEqual(
				ints(0n, 3n, 6n, 9n),
			)
			expect(list.of__overload$4(int(9n), int(0n), int(-3n))).toEqual(
				ints(9n, 6n, 3n, 0n),
			)
			expect(list.of__overload$4(int(0n), int(9n), int(-3n))).toEqual(
				ints(),
			)
			expect(list.of__overload$6(int(9n), int(0n), int(-3n))).toEqual(
				ints(9n, 6n, 3n, 0n),
			)
			expect(list.of__overload$6(int(9n), int(0n), int(3n))).toEqual(
				ints(9n),
			)
		})
	})

	describe("List restructuring", () => {
		it("flattens one level", () => {
			expect(
				list.flatten(list.createList([ints(1n, 2n), ints(), ints(3n)])),
			).toEqual(ints(1n, 2n, 3n))
		})

		// `List is Equatable` is conditional, so a `List<List<Integer>>`
		// compares through `List.is` curried with the Integer equality, as
		// emitted code builds it with `boundConformance`.
		it("compares nested Lists through a bound conformance", () => {
			let innerLists = boundConformance({ is: list.is }, [
				{ is: integerIs },
			]) as unknown as Parameters<typeof list.is>[2]

			expect(
				list.is(
					list.createList([ints(1n, 2n), ints(3n)]),
					list.createList([ints(1n, 2n), ints(3n)]),
					innerLists,
				),
			).toEqual(bool(true))

			expect(
				list.is(
					list.createList([ints(1n, 2n), ints(3n)]),
					list.createList([ints(1n, 2n), ints(9n)]),
					innerLists,
				),
			).toEqual(bool(false))

			expect(
				list.is(
					list.createList([ints(1n, 2n)]),
					list.createList([ints(1n, 2n), ints(3n)]),
					innerLists,
				),
			).toEqual(bool(false))
		})

		it("pairs position by position, stopping with the shorter List", () => {
			const pairs = list.pair(
				list.createList([str("a"), str("b")]),
				ints(1n, 2n, 3n),
			)

			expect(pairs.value.length).toBe(2)
			expect(pairs.value[0].first).toEqual(str("a"))
			expect(pairs.value[0].second).toEqual(int(1n))
			expect(pairs.value[1].first).toEqual(str("b"))
			expect(pairs.value[1].second).toEqual(int(2n))
		})

		it("splits into groups, the last one shorter, and holds every item in one group for a size below one", () => {
			const groups = list.split__overload$1(
				ints(1n, 2n, 3n, 4n, 5n),
				int(2n),
			)

			expect(groups).toEqual(
				list.createList([ints(1n, 2n), ints(3n, 4n), ints(5n)]),
			)
			expect(list.split__overload$1(ints(1n, 2n), int(0n))).toEqual(
				list.createList([ints(1n, 2n)]),
			)
			// The empty List answers no groups, whatever the size.
			expect(
				list.split__overload$1(list.createList([]), int(0n)),
			).toEqual(list.createList([]))
		})

		it("compares Lists lexicographically", () => {
			let integerConformance = { compare: number.compare }

			expect(
				list.compare(ints(1n, 2n), ints(1n, 3n), integerConformance)[
					typeKeySymbol
				],
			).toBe("Ordering#Less")

			expect(
				list.compare(ints(2n), ints(1n, 9n), integerConformance)[
					typeKeySymbol
				],
			).toBe("Ordering#Greater")

			expect(
				list.compare(ints(1n, 2n), ints(1n, 2n), integerConformance)[
					typeKeySymbol
				],
			).toBe("Ordering#Equal")
		})

		it("orders a shorter List before a longer one that shares its prefix", () => {
			expect(
				list.compare(ints(1n), ints(1n, 2n), {
					compare: number.compare,
				})[typeKeySymbol],
			).toBe("Ordering#Less")
		})

		// The golden harness covers a flat sort. A nested sort hands the `by:`
		// entry the `compare` that `boundConformance` curries the inner ordering
		// onto.
		it("sorts nested Lists through a bound conformance", () => {
			// The witness emitted code builds for `List<List<Integer>>`.
			let nested = boundConformance({ compare: list.compare }, [
				{ compare: number.compare },
			])

			expect(
				list.sort__overload$2(
					list.createList([ints(3n), ints(1n, 2n)]),
					nested.compare as unknown as Parameters<
						typeof list.sort__overload$2
					>[1],
				),
			).toEqual(list.createList([ints(1n, 2n), ints(3n)]))
		})

		it("sorts three-level nested Lists", () => {
			let integerConformance = { compare: number.compare }
			let listOfIntegers = boundConformance({ compare: list.compare }, [
				integerConformance,
			])
			let listOfListOfIntegers = boundConformance(
				{ compare: list.compare },
				[listOfIntegers],
			)
			let listOfListOfListOfIntegers = boundConformance(
				{ compare: list.compare },
				[listOfListOfIntegers],
			)

			// At the innermost pair 2 is greater than 1, so `a` sorts after `b`.
			let a = list.createList([list.createList([ints(2n)])])
			let b = list.createList([list.createList([ints(1n), ints(9n)])])

			expect(
				list.sort__overload$2(
					list.createList([a, b]),
					listOfListOfListOfIntegers.compare as unknown as Parameters<
						typeof list.sort__overload$2
					>[1],
				),
			).toEqual(list.createList([b, a]))
		})
	})

	describe("Enricher typings", () => {
		// The fallback must match the Optional's item Type. The List is
		// annotated `List`, since `firstItem` on a written one answers no
		// Optional.
		it("types value(defaultingTo:) by the Optional's item Type", () => {
			expect(
				diagnosticsFor(`implementation {
					constant numbers: List<Integer> = [1]
					constant fallback: Integer = numbers::firstItem()::value(defaultingTo 0)
				}`),
			).toEqual([])
		})

		it("rejects a fallback of the wrong Type", () => {
			expect(
				diagnosticsFor(`implementation {
					constant numbers: List<Integer> = [1]
					constant fallback = numbers::firstItem()::value(defaultingTo "zero")
				}`),
			).not.toEqual([])
		})

		it("keeps value(defaultingTo:) off unbounded Type Parameters", () => {
			expect(
				diagnosticsFor(`implementation {
					function passThrough<Item>(_ item: Item) -> Item {
						<- item::value(defaultingTo item)
					}
				}`),
			).not.toEqual([])
		})

		it("bounds join by Printable, not by a String item Type", () => {
			expect(
				diagnosticsFor(`implementation {
					constant joined: String = ["a", "b"]::join(with ",")
				}`),
			).toEqual([])

			expect(
				diagnosticsFor(`implementation {
					constant joined: String = [1, 2]::join(with ",")
				}`),
			).toEqual([])

			expect(
				diagnosticsFor(`implementation {
					constant joined: String = [[1], [2]]::join(with ",")
				}`),
			).toEqual([])

			// An unbounded Type Parameter conforms to nothing, so the bound
			// refuses the join.
			expect(
				diagnosticsFor(`implementation {
					function joinAll<Item>(_ items: List<Item>) -> String {
						<- items::join(with ",")
					}
				}`),
			).not.toEqual([])
		})

		it("bounds sorted by Comparable", () => {
			expect(
				diagnosticsFor(`implementation {
					constant ordered: List<Integer> = [3, 1, 2]::sort()
				}`),
			).toEqual([])

			// A Record is only `Equatable` and `Printable`, so it is not
			// `Comparable`.
			expect(
				diagnosticsFor(`implementation {
					constant ordered = [{ x = 1 }, { x = 2 }]::sort()
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

		// `isBetween` is provided by `Orderable` and takes `Self`, the
		// receiver's Type. So a question across kinds annotates the receiver as
		// `Number`.
		it("types isBetween across the tower", () => {
			expect(
				diagnosticsFor(`implementation {
					constant pi: Number = Number.Pi
					constant inRange: Boolean = pi::isBetween(3, and 22/7)
					constant plain: Boolean = 5::isBetween(1, and 10)
				}`),
			).toEqual([])
		})

		it("types the parse statics as fallible", () => {
			expect(
				diagnosticsFor(`implementation {
					constant parsed: Integer = Integer.parse("42")::value(defaultingTo 0)
				}`),
			).toEqual([])
		})

		// Every group `split` answers holds an item. A receiver proven to hold
		// an item also answers at least one group. A written List proves its
		// count, a `NonEmptyList` Constant carries its proof, and a computed
		// List carries none.
		it("types split by what the receiver proves", () => {
			expect(
				diagnosticsFor(`implementation {
					constant computed: List<Integer> = [1, 2]::map((n) { <- n::add(0) })
					constant proven: NonEmptyList<Integer> = [1, 2]

					constant written: NonEmptyList<NonEmptyList<Integer>> = [1, 2]::split(intoGroupsOf 1)
					constant fromProof: NonEmptyList<NonEmptyList<Integer>> = proven::split(intoGroupsOf 1)
					constant fromComputed: List<NonEmptyList<Integer>> = computed::split(intoGroupsOf 1)
					constant item: Integer = fromProof::firstItem()::firstItem()
					constant flat: NonEmptyList<Integer> = fromProof::flatten()
					constant flatComputed: List<Integer> = fromComputed::flatten()
				}`),
			).toEqual([])

			// Nothing proves the computed List has an item, so nothing proves it
			// answers a group.
			expect(
				diagnosticsFor(`implementation {
					constant computed: List<Integer> = [1, 2]::map((n) { <- n::add(0) })
					constant groups: NonEmptyList<NonEmptyList<Integer>> = computed::split(intoGroupsOf 1)
				}`),
			).not.toEqual([])
		})

		// Pairing stops with the shorter List, so both sides must prove an
		// item.
		it("types pair by what both Lists prove", () => {
			expect(
				diagnosticsFor(`implementation {
					constant computed: List<Integer> = [1, 2]::map((n) { <- n::add(0) })
					constant proven: NonEmptyList<Integer> = [1, 2]

					constant both: NonEmptyList<{ first: Integer, second: Integer }> = proven::pair(with proven)
					constant one: List<{ first: Integer, second: Integer }> = proven::pair(with computed)
				}`),
			).toEqual([])

			expect(
				diagnosticsFor(`implementation {
					constant computed: List<Integer> = [1, 2]::map((n) { <- n::add(0) })
					constant proven: NonEmptyList<Integer> = [1, 2]
					constant pairs: NonEmptyList<{ first: Integer, second: Integer }> = proven::pair(with computed)
				}`),
			).not.toEqual([])
		})
	})
})
