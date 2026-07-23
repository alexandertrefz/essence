import { describe, expect, it } from "bun:test"

import { Fraction } from "bigint-fraction"

import * as boolean from "../rewriter/__internal/Boolean"
import * as integer from "../rewriter/__internal/Integer"
import {
	anyIs,
	anyIsNot,
	isFirstRationalBigger,
} from "../rewriter/__internal/internalHelpers"
import * as list from "../rewriter/__internal/List"
import { createNothing } from "../rewriter/__internal/Nothing"
import * as number from "../rewriter/__internal/Number"
import * as ordering from "../rewriter/__internal/Ordering"
import * as rational from "../rewriter/__internal/Rational"
import * as record from "../rewriter/__internal/Record"
import * as string from "../rewriter/__internal/String"
import { dispatchMethod, isValueOfType } from "../rewriter/__internal/type"

const booleanTrue = () => boolean.createBoolean(true)
const booleanFalse = () => boolean.createBoolean(false)
const stringEmpty = () => string.createString("")

const integerZero = () => integer.createInteger(0n)
const integerOne = () => integer.createInteger(1n)
const integerTwo = () => integer.createInteger(2n)
const integerHundred = () => integer.createInteger(100n)

const rationalOneHalf = () => rational.createRational(1n, 2n)
const rationalOne = () => rational.createRational(1n, 1n)
const rationalTwo = () => rational.createRational(2n, 1n)
const rationalHundred = () => rational.createRational(100n, 1n)

const listEmpty = () => list.createList([])

const recordEmpty = () => record.createRecord({})

const nothing = () => createNothing()

// NOTE: `Integer.is` and `String.is` are written in Essence now — so are the
// `Equatable` witnesses the bounded List Methods take. These spell out the
// answer each Essence body gives, which is what the Simplifier passes at a
// `List<Integer>` or `List<String>` call site.
const integerIs = (first: integer.IntegerType, second: integer.IntegerType) =>
	boolean.createBoolean(first.value === second.value)

const stringIs = (first: string.StringType, second: string.StringType) =>
	boolean.createBoolean(first.value === second.value)

describe("Rewriter", () => {
	describe("Runtime", () => {
		describe("Internal Helpers", () => {
			describe("isFirstRationalBigger", () => {
				it("returns true of the first rational is bigger", () => {
					expect(
						isFirstRationalBigger(
							new Fraction(1, 2),
							new Fraction(1, 3),
						),
					).toBeTrue()

					expect(
						isFirstRationalBigger(
							new Fraction(2, 8),
							new Fraction(3, 24),
						),
					).toBeTrue()
				})

				it("returns false of the second rational is bigger", () => {
					expect(
						isFirstRationalBigger(
							new Fraction(1, 2),
							new Fraction(2, 3),
						),
					).toBeFalse()

					expect(
						isFirstRationalBigger(
							new Fraction(2, 8),
							new Fraction(7, 24),
						),
					).toBeFalse()
				})
			})

			describe("anyIs", () => {
				it("returns true if the elements are identical", () => {
					expect(anyIs(nothing(), nothing())).toBeTrue()

					expect(anyIs(booleanTrue(), booleanTrue())).toBeTrue()

					expect(anyIs(booleanFalse(), booleanFalse())).toBeTrue()

					expect(anyIs(integerZero(), integerZero())).toBeTrue()

					expect(anyIs(integerOne(), integerOne())).toBeTrue()

					expect(anyIs(integerTwo(), integerTwo())).toBeTrue()

					expect(anyIs(integerHundred(), integerHundred())).toBeTrue()

					expect(
						anyIs(rationalOneHalf(), rationalOneHalf()),
					).toBeTrue()

					expect(anyIs(rationalOne(), rationalOne())).toBeTrue()

					expect(anyIs(rationalTwo(), rationalTwo())).toBeTrue()

					expect(
						anyIs(rationalHundred(), rationalHundred()),
					).toBeTrue()

					expect(anyIs(stringEmpty(), stringEmpty())).toBeTrue()

					expect(
						anyIs(
							string.createString("test"),
							string.createString("test"),
						),
					).toBeTrue()

					expect(anyIs(recordEmpty(), recordEmpty())).toBeTrue()

					expect(
						anyIs(
							record.createRecord({ a: integerOne() }),
							record.createRecord({ a: integerOne() }),
						),
					).toBeTrue()

					expect(
						anyIs(
							record.createRecord({
								a: integerOne(),
								b: stringEmpty(),
							}),
							record.createRecord({
								a: integerOne(),
								b: stringEmpty(),
							}),
						),
					).toBeTrue()

					expect(anyIs(listEmpty(), listEmpty())).toBeTrue()

					expect(
						anyIs(
							list.createList([integerOne(), integerTwo()]),
							list.createList([integerOne(), integerTwo()]),
						),
					).toBeTrue()
				})

				it("returns false if the elements are different", () => {
					expect(anyIs(nothing(), booleanTrue())).toBeFalse()

					expect(anyIs(nothing(), booleanFalse())).toBeFalse()

					expect(anyIs(nothing(), integerOne())).toBeFalse()

					expect(anyIs(nothing(), rationalOne())).toBeFalse()

					expect(anyIs(nothing(), stringEmpty())).toBeFalse()

					expect(anyIs(nothing(), listEmpty())).toBeFalse()

					expect(anyIs(nothing(), recordEmpty())).toBeFalse()

					expect(anyIs(booleanTrue(), nothing())).toBeFalse()

					expect(anyIs(booleanFalse(), nothing())).toBeFalse()

					expect(anyIs(integerOne(), nothing())).toBeFalse()

					expect(anyIs(rationalOne(), nothing())).toBeFalse()

					expect(anyIs(stringEmpty(), nothing())).toBeFalse()

					expect(anyIs(listEmpty(), nothing())).toBeFalse()

					expect(anyIs(recordEmpty(), nothing())).toBeFalse()
				})
			})

			describe("anyIsNot", () => {
				it("returns false if the elements are identical", () => {
					expect(anyIsNot(nothing(), nothing())).toBeFalse()

					expect(anyIsNot(booleanTrue(), booleanTrue())).toBeFalse()

					expect(anyIsNot(booleanFalse(), booleanFalse())).toBeFalse()

					expect(anyIsNot(integerZero(), integerZero())).toBeFalse()

					expect(anyIsNot(integerOne(), integerOne())).toBeFalse()

					expect(anyIsNot(integerTwo(), integerTwo())).toBeFalse()

					expect(
						anyIsNot(integerHundred(), integerHundred()),
					).toBeFalse()

					expect(
						anyIsNot(rationalOneHalf(), rationalOneHalf()),
					).toBeFalse()

					expect(anyIsNot(rationalOne(), rationalOne())).toBeFalse()

					expect(anyIsNot(rationalTwo(), rationalTwo())).toBeFalse()

					expect(
						anyIsNot(rationalHundred(), rationalHundred()),
					).toBeFalse()

					expect(anyIsNot(stringEmpty(), stringEmpty())).toBeFalse()

					expect(
						anyIsNot(
							string.createString("test"),
							string.createString("test"),
						),
					).toBeFalse()

					expect(anyIsNot(recordEmpty(), recordEmpty())).toBeFalse()

					expect(
						anyIsNot(
							record.createRecord({ a: integerOne() }),
							record.createRecord({ a: integerOne() }),
						),
					).toBeFalse()

					expect(
						anyIsNot(
							record.createRecord({
								a: integerOne(),
								b: stringEmpty(),
							}),
							record.createRecord({
								a: integerOne(),
								b: stringEmpty(),
							}),
						),
					).toBeFalse()

					expect(anyIsNot(listEmpty(), listEmpty())).toBeFalse()

					expect(
						anyIsNot(
							list.createList([integerOne(), integerTwo()]),
							list.createList([integerOne(), integerTwo()]),
						),
					).toBeFalse()
				})

				it("returns true if the elements are different", () => {
					expect(anyIsNot(nothing(), booleanTrue())).toBeTrue()

					expect(anyIsNot(nothing(), booleanFalse())).toBeTrue()

					expect(anyIsNot(nothing(), integerOne())).toBeTrue()

					expect(anyIsNot(nothing(), rationalOne())).toBeTrue()

					expect(anyIsNot(nothing(), stringEmpty())).toBeTrue()

					expect(anyIsNot(nothing(), listEmpty())).toBeTrue()

					expect(anyIsNot(nothing(), recordEmpty())).toBeTrue()

					expect(anyIsNot(booleanTrue(), nothing())).toBeTrue()

					expect(anyIsNot(booleanFalse(), nothing())).toBeTrue()

					expect(anyIsNot(integerOne(), nothing())).toBeTrue()

					expect(anyIsNot(rationalOne(), nothing())).toBeTrue()

					expect(anyIsNot(stringEmpty(), nothing())).toBeTrue()

					expect(anyIsNot(listEmpty(), nothing())).toBeTrue()

					expect(anyIsNot(recordEmpty(), nothing())).toBeTrue()
				})
			})
		})

		describe("type", () => {
			describe("isValueOfType", () => {
				it("returns true when the type is the same", () => {
					expect(
						isValueOfType(nothing(), {
							type: "Nothing",
						}),
					).toBeTrue()

					expect(
						isValueOfType(booleanTrue(), {
							type: "Boolean",
						}),
					).toBeTrue()

					expect(
						isValueOfType(booleanFalse(), {
							type: "Boolean",
						}),
					).toBeTrue()

					expect(
						isValueOfType(stringEmpty(), {
							type: "String",
						}),
					).toBeTrue()

					expect(
						isValueOfType(integerOne(), {
							type: "Integer",
						}),
					).toBeTrue()

					expect(
						isValueOfType(rationalOne(), {
							type: "Rational",
						}),
					).toBeTrue()
				})

				it("returns false when the type is different", () => {
					expect(
						isValueOfType(nothing(), {
							type: "String",
						}),
					).toBeFalse()

					expect(
						isValueOfType(nothing(), {
							type: "Boolean",
						}),
					).toBeFalse()

					expect(
						isValueOfType(nothing(), {
							type: "Boolean",
						}),
					).toBeFalse()

					expect(
						isValueOfType(nothing(), {
							type: "String",
						}),
					).toBeFalse()

					expect(
						isValueOfType(nothing(), {
							type: "Integer",
						}),
					).toBeFalse()

					expect(
						isValueOfType(nothing(), {
							type: "Rational",
						}),
					).toBeFalse()
				})

				it("narrows Lists by the items they hold", () => {
					// NOTE: Item Types erase at runtime, so the empty List
					// fits any List matcher — the same way an empty literal
					// is assignable to any List.
					expect(
						isValueOfType(listEmpty(), {
							type: "List",
							itemType: {
								type: "Nothing",
							},
						}),
					).toBeTrue()

					expect(
						isValueOfType(list.createList([integerOne()]), {
							type: "List",
							itemType: { type: "Integer" },
						}),
					).toBeTrue()

					expect(
						isValueOfType(list.createList([integerOne()]), {
							type: "List",
							itemType: { type: "String" },
						}),
					).toBeFalse()

					expect(
						isValueOfType(integerOne(), {
							type: "List",
							itemType: { type: "Integer" },
						}),
					).toBeFalse()
				})
			})
		})

		describe("Boolean", () => {
			describe("negate", () => {
				it("turns true to false", () => {
					expect(boolean.negate(booleanTrue())).toEqual(
						booleanFalse(),
					)
				})

				it("turns false to true", () => {
					expect(boolean.negate(booleanFalse())).toEqual(
						booleanTrue(),
					)
				})
			})

			describe("is", () => {
				it("returns true when both sides match", () => {
					expect(boolean.is(booleanTrue(), booleanTrue())).toEqual(
						booleanTrue(),
					)

					expect(boolean.is(booleanFalse(), booleanFalse())).toEqual(
						booleanTrue(),
					)
				})

				it("returns false when the sides dont match ", () => {
					expect(boolean.is(booleanTrue(), booleanFalse())).toEqual(
						booleanFalse(),
					)

					expect(boolean.is(booleanFalse(), booleanTrue())).toEqual(
						booleanFalse(),
					)
				})
			})

			// NOTE: `isNot` is not here because it is not native any more — it
			// is written in Essence in `src/stdlib/Boolean.es` and reaches the
			// emitted Program through the standard library prelude. There is
			// nothing in this module left to call; what it does now is asserted
			// end to end in `codeGeneration.spec.ts`.

			describe("and", () => {
				it("returns true if both sides are true", () => {
					expect(boolean.and(booleanTrue(), booleanTrue())).toEqual(
						booleanTrue(),
					)
				})

				it("returns false if both sides are not true", () => {
					expect(boolean.and(booleanTrue(), booleanFalse())).toEqual(
						booleanFalse(),
					)

					expect(boolean.and(booleanFalse(), booleanTrue())).toEqual(
						booleanFalse(),
					)

					expect(boolean.and(booleanFalse(), booleanFalse())).toEqual(
						booleanFalse(),
					)
				})
			})

			describe("or", () => {
				it("returns true if either side is true", () => {
					expect(boolean.or(booleanTrue(), booleanTrue())).toEqual(
						booleanTrue(),
					)

					expect(boolean.or(booleanTrue(), booleanFalse())).toEqual(
						booleanTrue(),
					)

					expect(boolean.or(booleanFalse(), booleanTrue())).toEqual(
						booleanTrue(),
					)
				})

				it("returns false if both sides are not true", () => {
					expect(boolean.or(booleanFalse(), booleanFalse())).toEqual(
						booleanFalse(),
					)
				})
			})

			// NOTE: `toString` and `exclusiveOr` are implemented in Essence now
			// (`src/stdlib/Boolean.es`); the golden harness covers them.
		})

		describe("String", () => {
			// NOTE: Most of this Namespace is written in Essence now
			// (`src/stdlib/String.es`) and the golden harness covers it —
			// `isEmpty`, `is`, `prepend`, `contains`, `length`, `characters`,
			// `character`, `trimmed`, `startsWith`, `endsWith`, `repeat`,
			// `reverse`, `slice`, `firstIndex`, `paddedAtStart`,
			// `paddedAtEnd` and `toString`, alongside the negations
			// (`hasAnyContent`, `isNot`, `doesNotContain`, `doesNotStart`,
			// `doesNotEnd`) that moved earlier. What is left below is the
			// native floor those Essence bodies stand on, and it is where the
			// code-point behaviour is actually decided.

			describe("append", () => {
				it("appends any string to any other", () => {
					expect(
						string.append(stringEmpty(), string.createString("a")),
					).toEqual(string.createString("a"))

					expect(
						string.append(
							stringEmpty(),
							string.createString("abc"),
						),
					).toEqual(string.createString("abc"))

					expect(
						string.append(stringEmpty(), string.createString("!")),
					).toEqual(string.createString("!"))

					expect(
						string.append(stringEmpty(), string.createString(" ")),
					).toEqual(string.createString(" "))

					expect(
						string.append(
							string.createString("a"),
							string.createString("bc"),
						),
					).toEqual(string.createString("abc"))
				})
			})

			describe("split", () => {
				it("splits correctly when splitting on an empty string", () => {
					expect(
						string.split(
							string.createString("abc"),
							string.createString(""),
						),
					).toEqual(
						list.createList([
							string.createString("a"),
							string.createString("b"),
							string.createString("c"),
						]),
					)
				})

				it("splits an empty splitter by code point, keeping astral characters whole", () => {
					// NOTE: `String.split("")` would tear the emoji into two
					// lone surrogates; splitting by code point keeps it whole.
					// This is the ONE place the runtime decides what a
					// character is — `characters()` IS `split("")` in
					// Essence, and `length`, `character`, `slice` and
					// `reverse` are written on top of `characters()`, so
					// every one of them inherits this behaviour from here.
					let emoji = string.createString("a\u{1F600}b")

					expect(
						string.split(emoji, string.createString("")),
					).toEqual(
						list.createList([
							string.createString("a"),
							string.createString("\u{1F600}"),
							string.createString("b"),
						]),
					)
				})

				it("splits correctly using a substring", () => {
					expect(
						string.split(
							string.createString("1 2 3"),
							string.createString(" "),
						),
					).toEqual(
						list.createList([
							string.createString("1"),
							string.createString("2"),
							string.createString("3"),
						]),
					)
				})

				it("splits on an astral separator", () => {
					expect(
						string.split(
							string.createString("a\u{1F600}b\u{1F600}c"),
							string.createString("\u{1F600}"),
						),
					).toEqual(
						list.createList([
							string.createString("a"),
							string.createString("b"),
							string.createString("c"),
						]),
					)
				})
			})

			describe("casing and trimming", () => {
				it("upper- and lower-cases", () => {
					expect(
						string.uppercased(string.createString("aB")),
					).toEqual(string.createString("AB"))
					expect(
						string.lowercased(string.createString("aB")),
					).toEqual(string.createString("ab"))
				})

				it("trims from either end", () => {
					// NOTE: `trimmed` is the Essence composition of these two.
					expect(
						string.trimmedAtStart(string.createString("  hi  ")),
					).toEqual(string.createString("hi  "))
					expect(
						string.trimmedAtEnd(string.createString("  hi  ")),
					).toEqual(string.createString("  hi"))
				})
			})

			describe("replaceEvery", () => {
				it("replaces every occurrence", () => {
					expect(
						string.replaceEvery(
							string.createString("a-a-a"),
							string.createString("a"),
							string.createString("b"),
						),
					).toEqual(string.createString("b-b-b"))
				})

				// NOTE: This is why `replaceEvery` is the one substring Method
				// still native. On the empty part the replacement lands at
				// every UTF-16 code UNIT boundary — outside the ends, and
				// BETWEEN the two halves of an astral character, which is a
				// position Essence can not name. The obvious Essence body,
				// `@::split(on part)::join(with replacement)`, would answer
				// `"a-b-c"` and `"a-\u{1F600}-b"` here instead.
				it("places the replacement at every code unit for an empty part", () => {
					expect(
						string.replaceEvery(
							string.createString("abc"),
							stringEmpty(),
							string.createString("-"),
						),
					).toEqual(string.createString("-a-b-c-"))

					expect(
						string.replaceEvery(
							string.createString("a\u{1F600}b"),
							stringEmpty(),
							string.createString("-"),
						),
					).toEqual(string.createString("-a-\uD83D-\uDE00-b-"))
				})
			})

			describe("compareTo", () => {
				it("orders lexicographically by code point", () => {
					// NOTE: This is also the whole of String equality —
					// `String.is` is `compareTo(other)::is(Ordering#Equal)` in
					// Essence.
					expect(
						string.compareTo(
							string.createString("apple"),
							string.createString("banana"),
						),
					).toBe(ordering.less)
					expect(
						string.compareTo(
							string.createString("banana"),
							string.createString("apple"),
						),
					).toBe(ordering.greater)
					expect(
						string.compareTo(
							string.createString("apple"),
							string.createString("apple"),
						),
					).toBe(ordering.equal)
					// NOTE: A prefix orders before the longer String.
					expect(
						string.compareTo(
							string.createString("app"),
							string.createString("apple"),
						),
					).toBe(ordering.less)
				})
			})
		})

		describe("Integer", () => {
			// NOTE: isNot / isOdd are implemented in Essence now (src/stdlib/Integer.es); the golden harness covers them.

			describe("add", () => {
				it("adds 2 integers correctly", () => {
					expect(
						integer.add__overload$1(integerOne(), integerOne()),
					).toEqual(integerTwo())

					expect(
						integer.add__overload$1(integerHundred(), integerOne()),
					).toEqual(integer.createInteger(101n))

					expect(
						integer.add__overload$1(integerOne(), integerHundred()),
					).toEqual(integer.createInteger(101n))
				})

				it("adds an integer and a rational correctly", () => {
					expect(
						integer.add__overload$2(
							integerOne(),
							rationalOneHalf(),
						),
					).toEqual(rational.createRational(3n, 2n))

					expect(
						integer.add__overload$2(
							integerHundred(),
							rationalOneHalf(),
						),
					).toEqual(rational.createRational(201n, 2n))

					expect(
						integer.add__overload$2(
							integerOne(),
							rational.createRational(-1n, 2n),
						),
					).toEqual(rationalOneHalf())

					expect(
						integer.add__overload$2(
							integerOne(),
							rational.createRational(1n, -2n),
						),
					).toEqual(rationalOneHalf())
				})
			})

			describe("multiply", () => {
				it("multiplies 2 integers correctly", () => {
					expect(
						integer.multiply__overload$1(
							integerOne(),
							integerOne(),
						),
					).toEqual(integerOne())

					expect(
						integer.multiply__overload$1(
							integerHundred(),
							integerOne(),
						),
					).toEqual(integerHundred())

					expect(
						integer.multiply__overload$1(
							integerTwo(),
							integerTwo(),
						),
					).toEqual(integer.createInteger(4n))

					expect(
						integer.multiply__overload$1(
							integerTwo(),
							integerHundred(),
						),
					).toEqual(integer.createInteger(200n))
				})

				it("multiplies an integer and a rational correctly", () => {
					expect(
						integer.multiply__overload$2(
							integerOne(),
							rationalOneHalf(),
						),
					).toEqual(rationalOneHalf())

					// NOTE: Rationals are not automatically reduced, so we need to compare against the common demoninator
					expect(
						integer.multiply__overload$2(
							integerHundred(),
							rationalOneHalf(),
						),
					).toEqual(rational.createRational(100n, 2n))

					// NOTE: Rationals are not automatically reduced, so we need to compare against the common demoninator
					expect(
						integer.multiply__overload$2(
							integerTwo(),
							rationalOneHalf(),
						),
					).toEqual(rational.createRational(2n, 2n))

					expect(
						integer.multiply__overload$2(
							integerTwo(),
							rational.createRational(50n, 1n),
						),
					).toEqual(rational.createRational(100n, 1n))
				})
			})

			describe("isLessThan", () => {
				it("returns true if the first number is less than the second", () => {
					expect(
						integer.isLessThan__overload$2(
							integerZero(),
							rationalOneHalf(),
						),
					).toEqual(booleanTrue())

					expect(
						integer.isLessThan__overload$2(
							integerZero(),
							rationalOne(),
						),
					).toEqual(booleanTrue())

					expect(
						integer.isLessThan__overload$2(
							integerZero(),
							rationalTwo(),
						),
					).toEqual(booleanTrue())

					expect(
						integer.isLessThan__overload$2(
							integerZero(),
							rationalHundred(),
						),
					).toEqual(booleanTrue())

					expect(
						integer.isLessThan__overload$2(
							integerOne(),
							rationalTwo(),
						),
					).toEqual(booleanTrue())

					expect(
						integer.isLessThan__overload$2(
							integerOne(),
							rationalHundred(),
						),
					).toEqual(booleanTrue())

					expect(
						integer.isLessThan__overload$2(
							integerTwo(),
							rationalHundred(),
						),
					).toEqual(booleanTrue())
				})

				it("returns false if the numbers are equal", () => {
					expect(
						integer.isLessThan__overload$2(
							integerOne(),
							rationalOne(),
						),
					).toEqual(booleanFalse())

					expect(
						integer.isLessThan__overload$2(
							integerTwo(),
							rationalTwo(),
						),
					).toEqual(booleanFalse())

					expect(
						integer.isLessThan__overload$2(
							integerHundred(),
							rationalHundred(),
						),
					).toEqual(booleanFalse())
				})

				it("returns false if the first number is bigger than the second", () => {
					expect(
						integer.isLessThan__overload$2(
							integerOne(),
							rationalOneHalf(),
						),
					).toEqual(booleanFalse())

					expect(
						integer.isLessThan__overload$2(
							integerTwo(),
							rationalOneHalf(),
						),
					).toEqual(booleanFalse())

					expect(
						integer.isLessThan__overload$2(
							integerTwo(),
							rationalOne(),
						),
					).toEqual(booleanFalse())

					expect(
						integer.isLessThan__overload$2(
							integerHundred(),
							rationalOneHalf(),
						),
					).toEqual(booleanFalse())

					expect(
						integer.isLessThan__overload$2(
							integerHundred(),
							rationalOne(),
						),
					).toEqual(booleanFalse())

					expect(
						integer.isLessThan__overload$2(
							integerHundred(),
							rationalTwo(),
						),
					).toEqual(booleanFalse())
				})
			})

			describe("isLessThanOrEqualTo", () => {
				it("returns true if the first number is less than the second", () => {
					expect(
						integer.isLessThanOrEqualTo__overload$2(
							integerZero(),
							rationalOneHalf(),
						),
					).toEqual(booleanTrue())

					expect(
						integer.isLessThanOrEqualTo__overload$2(
							integerZero(),
							rationalOne(),
						),
					).toEqual(booleanTrue())

					expect(
						integer.isLessThanOrEqualTo__overload$2(
							integerZero(),
							rationalTwo(),
						),
					).toEqual(booleanTrue())

					expect(
						integer.isLessThanOrEqualTo__overload$2(
							integerZero(),
							rationalHundred(),
						),
					).toEqual(booleanTrue())

					expect(
						integer.isLessThanOrEqualTo__overload$2(
							integerOne(),
							rationalTwo(),
						),
					).toEqual(booleanTrue())

					expect(
						integer.isLessThanOrEqualTo__overload$2(
							integerOne(),
							rationalHundred(),
						),
					).toEqual(booleanTrue())

					expect(
						integer.isLessThanOrEqualTo__overload$2(
							integerTwo(),
							rationalHundred(),
						),
					).toEqual(booleanTrue())
				})

				it("returns true if the numbers are equal", () => {
					expect(
						integer.isLessThanOrEqualTo__overload$2(
							integerOne(),
							rationalOne(),
						),
					).toEqual(booleanTrue())

					expect(
						integer.isLessThanOrEqualTo__overload$2(
							integerTwo(),
							rationalTwo(),
						),
					).toEqual(booleanTrue())

					expect(
						integer.isLessThanOrEqualTo__overload$2(
							integerHundred(),
							rationalHundred(),
						),
					).toEqual(booleanTrue())
				})

				it("returns false if the first number is bigger than the second", () => {
					expect(
						integer.isLessThanOrEqualTo__overload$2(
							integerOne(),
							rationalOneHalf(),
						),
					).toEqual(booleanFalse())

					expect(
						integer.isLessThanOrEqualTo__overload$2(
							integerTwo(),
							rationalOneHalf(),
						),
					).toEqual(booleanFalse())

					expect(
						integer.isLessThanOrEqualTo__overload$2(
							integerTwo(),
							rationalOne(),
						),
					).toEqual(booleanFalse())

					expect(
						integer.isLessThanOrEqualTo__overload$2(
							integerHundred(),
							rationalOneHalf(),
						),
					).toEqual(booleanFalse())

					expect(
						integer.isLessThanOrEqualTo__overload$2(
							integerHundred(),
							rationalOne(),
						),
					).toEqual(booleanFalse())

					expect(
						integer.isLessThanOrEqualTo__overload$2(
							integerHundred(),
							rationalTwo(),
						),
					).toEqual(booleanFalse())
				})
			})

			describe("isGreaterThan", () => {
				it("returns false if the first number is less than the second", () => {
					expect(
						integer.isGreaterThan__overload$2(
							integerZero(),
							rationalOneHalf(),
						),
					).toEqual(booleanFalse())

					expect(
						integer.isGreaterThan__overload$2(
							integerZero(),
							rationalOne(),
						),
					).toEqual(booleanFalse())

					expect(
						integer.isGreaterThan__overload$2(
							integerZero(),
							rationalTwo(),
						),
					).toEqual(booleanFalse())

					expect(
						integer.isGreaterThan__overload$2(
							integerZero(),
							rationalHundred(),
						),
					).toEqual(booleanFalse())

					expect(
						integer.isGreaterThan__overload$2(
							integerOne(),
							rationalTwo(),
						),
					).toEqual(booleanFalse())

					expect(
						integer.isGreaterThan__overload$2(
							integerOne(),
							rationalHundred(),
						),
					).toEqual(booleanFalse())

					expect(
						integer.isGreaterThan__overload$2(
							integerTwo(),
							rationalHundred(),
						),
					).toEqual(booleanFalse())
				})

				it("returns false if the numbers are equal", () => {
					expect(
						integer.isGreaterThan__overload$2(
							integerOne(),
							rationalOne(),
						),
					).toEqual(booleanFalse())

					expect(
						integer.isGreaterThan__overload$2(
							integerTwo(),
							rationalTwo(),
						),
					).toEqual(booleanFalse())

					expect(
						integer.isGreaterThan__overload$2(
							integerHundred(),
							rationalHundred(),
						),
					).toEqual(booleanFalse())
				})

				it("returns true if the first number is bigger than the second", () => {
					expect(
						integer.isGreaterThan__overload$2(
							integerOne(),
							rationalOneHalf(),
						),
					).toEqual(booleanTrue())

					expect(
						integer.isGreaterThan__overload$2(
							integerTwo(),
							rationalOneHalf(),
						),
					).toEqual(booleanTrue())

					expect(
						integer.isGreaterThan__overload$2(
							integerTwo(),
							rationalOne(),
						),
					).toEqual(booleanTrue())

					expect(
						integer.isGreaterThan__overload$2(
							integerHundred(),
							rationalOneHalf(),
						),
					).toEqual(booleanTrue())

					expect(
						integer.isGreaterThan__overload$2(
							integerHundred(),
							rationalOne(),
						),
					).toEqual(booleanTrue())

					expect(
						integer.isGreaterThan__overload$2(
							integerHundred(),
							rationalTwo(),
						),
					).toEqual(booleanTrue())
				})
			})

			describe("isGreaterThanOrEqualTo", () => {
				it("returns false if the first number is less than the second", () => {
					expect(
						integer.isGreaterThanOrEqualTo__overload$2(
							integerZero(),
							rationalOneHalf(),
						),
					).toEqual(booleanFalse())

					expect(
						integer.isGreaterThanOrEqualTo__overload$2(
							integerZero(),
							rationalOne(),
						),
					).toEqual(booleanFalse())

					expect(
						integer.isGreaterThanOrEqualTo__overload$2(
							integerZero(),
							rationalTwo(),
						),
					).toEqual(booleanFalse())

					expect(
						integer.isGreaterThanOrEqualTo__overload$2(
							integerZero(),
							rationalHundred(),
						),
					).toEqual(booleanFalse())

					expect(
						integer.isGreaterThanOrEqualTo__overload$2(
							integerOne(),
							rationalTwo(),
						),
					).toEqual(booleanFalse())

					expect(
						integer.isGreaterThanOrEqualTo__overload$2(
							integerOne(),
							rationalHundred(),
						),
					).toEqual(booleanFalse())

					expect(
						integer.isGreaterThanOrEqualTo__overload$2(
							integerTwo(),
							rationalHundred(),
						),
					).toEqual(booleanFalse())
				})

				it("returns true if the numbers are equal", () => {
					expect(
						integer.isGreaterThanOrEqualTo__overload$2(
							integerOne(),
							rationalOne(),
						),
					).toEqual(booleanTrue())

					expect(
						integer.isGreaterThanOrEqualTo__overload$2(
							integerTwo(),
							rationalTwo(),
						),
					).toEqual(booleanTrue())

					expect(
						integer.isGreaterThanOrEqualTo__overload$2(
							integerHundred(),
							rationalHundred(),
						),
					).toEqual(booleanTrue())
				})

				it("returns true if the first number is bigger than the second", () => {
					expect(
						integer.isGreaterThanOrEqualTo__overload$2(
							integerOne(),
							rationalOneHalf(),
						),
					).toEqual(booleanTrue())

					expect(
						integer.isGreaterThanOrEqualTo__overload$2(
							integerTwo(),
							rationalOneHalf(),
						),
					).toEqual(booleanTrue())

					expect(
						integer.isGreaterThanOrEqualTo__overload$2(
							integerTwo(),
							rationalOne(),
						),
					).toEqual(booleanTrue())

					expect(
						integer.isGreaterThanOrEqualTo__overload$2(
							integerHundred(),
							rationalOneHalf(),
						),
					).toEqual(booleanTrue())

					expect(
						integer.isGreaterThanOrEqualTo__overload$2(
							integerHundred(),
							rationalOne(),
						),
					).toEqual(booleanTrue())

					expect(
						integer.isGreaterThanOrEqualTo__overload$2(
							integerHundred(),
							rationalTwo(),
						),
					).toEqual(booleanTrue())
				})
			})

			describe("toString", () => {
				it("returns the correct strings", () => {
					expect(integer.toString(integerOne())).toEqual(
						string.createString("1"),
					)

					expect(integer.toString(integerTwo())).toEqual(
						string.createString("2"),
					)

					expect(integer.toString(integerHundred())).toEqual(
						string.createString("100"),
					)

					expect(
						integer.toString(integer.createInteger(1000n)),
					).toEqual(string.createString("1000"))
				})
			})
		})

		describe("Rational", () => {
			describe("of", () => {
				it("creates a rational", () => {
					expect(rational.of(integerOne(), integerTwo())).toEqual(
						rationalOneHalf(),
					)
				})

				it("returns Nothing for a zero denominator", () => {
					expect(rational.of(integerOne(), integerZero())).toEqual(
						nothing(),
					)
				})
			})

			// NOTE: is, isNot, compareTo, subtract and the Rational-operand
			// entries of the four comparison overloads are implemented in
			// Essence now (src/stdlib/Rational.es); the golden harness covers
			// them. The Integer-operand entries of the comparisons are still
			// native and keep their assertions below.

			describe("add", () => {
				it("adds 2 rationals correctly", () => {
					expect(
						rational.add__overload$1(
							rationalOneHalf(),
							rationalOneHalf(),
						),
					).toEqual(rational.createRational(4n, 4n))

					expect(
						rational.add__overload$1(
							rationalHundred(),
							rationalOne(),
						),
					).toEqual(rational.createRational(101n, 1n))

					expect(
						rational.add__overload$1(
							rationalOne(),
							rationalHundred(),
						),
					).toEqual(rational.createRational(101n, 1n))
				})

				it("adds a rational and an integer correctly", () => {
					expect(
						rational.add__overload$2(
							rationalOneHalf(),
							integerOne(),
						),
					).toEqual(rational.createRational(3n, 2n))

					expect(
						rational.add__overload$2(
							rationalOneHalf(),
							integerHundred(),
						),
					).toEqual(rational.createRational(201n, 2n))

					expect(
						rational.add__overload$2(
							rational.createRational(-1n, 2n),
							integerOne(),
						),
					).toEqual(rationalOneHalf())
				})
			})

			describe("multiply", () => {
				it("multiplies 2 rationals correctly", () => {
					expect(
						rational.multiply__overload$1(
							rationalOne(),
							rationalOne(),
						),
					).toEqual(rationalOne())

					expect(
						rational.multiply__overload$1(
							rationalHundred(),
							rationalOne(),
						),
					).toEqual(rationalHundred())

					expect(
						rational.multiply__overload$1(
							rationalTwo(),
							rationalTwo(),
						),
					).toEqual(rational.createRational(4n, 1n))

					expect(
						rational.multiply__overload$1(
							rationalTwo(),
							rationalHundred(),
						),
					).toEqual(rational.createRational(200n, 1n))
				})

				it("multiplies a rational and an integer correctly", () => {
					expect(
						rational.multiply__overload$2(
							rationalOneHalf(),
							integerOne(),
						),
					).toEqual(rationalOneHalf())

					// NOTE: Rationals are not automatically reduced, so we need to compare against the common demoninator
					expect(
						rational.multiply__overload$2(
							rationalOneHalf(),
							integerHundred(),
						),
					).toEqual(rational.createRational(100n, 2n))

					// NOTE: Rationals are not automatically reduced, so we need to compare against the common demoninator
					expect(
						rational.multiply__overload$2(
							rationalOneHalf(),
							integerTwo(),
						),
					).toEqual(rational.createRational(2n, 2n))

					expect(
						rational.multiply__overload$2(
							rational.createRational(50n, 1n),
							integerTwo(),
						),
					).toEqual(rational.createRational(100n, 1n))
				})
			})

			describe("divide", () => {
				it("divides 2 rationals correctly", () => {
					expect(
						rational.divide__overload$1(
							rationalOne(),
							rationalOne(),
						),
					).toEqual(rational.createRational(1n, 1n))

					expect(
						rational.divide__overload$1(
							rationalOne(),
							rationalTwo(),
						),
					).toEqual(rational.createRational(1n, 2n))

					expect(
						rational.divide__overload$1(
							rationalOne(),
							rationalOneHalf(),
						),
					).toEqual(rational.createRational(2n, 1n))

					expect(
						rational.divide__overload$1(
							rationalHundred(),
							rationalTwo(),
						),
					).toEqual(rational.createRational(100n, 2n))
				})

				it("divides a rational and an integer correctly", () => {
					expect(
						rational.divide__overload$2(
							rationalOne(),
							integerOne(),
						),
					).toEqual(rationalOne())

					expect(
						rational.divide__overload$2(
							rational.createRational(2n, 1n),
							integerTwo(),
						),
					).toEqual(rational.createRational(2n, 2n))

					expect(
						rational.divide__overload$2(
							rationalHundred(),
							integerTwo(),
						),
					).toEqual(rational.createRational(100n, 2n))
				})

				it("returns Nothing when dividing by zero", () => {
					expect(
						rational.divide__overload$1(
							rationalOne(),
							rational.createRational(0n, 1n),
						),
					).toEqual(nothing())

					expect(
						rational.divide__overload$2(
							rationalOne(),
							integerZero(),
						),
					).toEqual(nothing())
				})
			})

			describe("isLessThan", () => {
				it("returns true if the first number is less than the second", () => {
					expect(
						rational.isLessThan__overload$2(
							rationalOneHalf(),
							integerOne(),
						),
					).toEqual(booleanTrue())

					expect(
						rational.isLessThan__overload$2(
							rationalOneHalf(),
							integerTwo(),
						),
					).toEqual(booleanTrue())

					expect(
						rational.isLessThan__overload$2(
							rationalOneHalf(),
							integerHundred(),
						),
					).toEqual(booleanTrue())

					expect(
						rational.isLessThan__overload$2(
							rationalOne(),
							integerTwo(),
						),
					).toEqual(booleanTrue())

					expect(
						rational.isLessThan__overload$2(
							rationalOne(),
							integerHundred(),
						),
					).toEqual(booleanTrue())

					expect(
						rational.isLessThan__overload$2(
							rationalTwo(),
							integerHundred(),
						),
					).toEqual(booleanTrue())
				})

				it("returns false if the numbers are equal", () => {
					expect(
						rational.isLessThan__overload$2(
							rationalOne(),
							integerOne(),
						),
					).toEqual(booleanFalse())

					expect(
						rational.isLessThan__overload$2(
							rationalTwo(),
							integerTwo(),
						),
					).toEqual(booleanFalse())

					expect(
						rational.isLessThan__overload$2(
							rationalHundred(),
							integerHundred(),
						),
					).toEqual(booleanFalse())
				})

				it("returns false if the first number is bigger than the second", () => {
					expect(
						rational.isLessThan__overload$2(
							rationalOne(),
							integerZero(),
						),
					).toEqual(booleanFalse())

					expect(
						rational.isLessThan__overload$2(
							rationalTwo(),
							integerZero(),
						),
					).toEqual(booleanFalse())

					expect(
						rational.isLessThan__overload$2(
							rationalTwo(),
							integerOne(),
						),
					).toEqual(booleanFalse())

					expect(
						rational.isLessThan__overload$2(
							rationalHundred(),
							integerZero(),
						),
					).toEqual(booleanFalse())

					expect(
						rational.isLessThan__overload$2(
							rationalHundred(),
							integerOne(),
						),
					).toEqual(booleanFalse())

					expect(
						rational.isLessThan__overload$2(
							rationalHundred(),
							integerTwo(),
						),
					).toEqual(booleanFalse())
				})
			})

			describe("isLessThanOrEqualTo", () => {
				it("returns true if the first number is less than the second", () => {
					expect(
						rational.isLessThanOrEqualTo__overload$2(
							rationalOneHalf(),
							integerOne(),
						),
					).toEqual(booleanTrue())

					expect(
						rational.isLessThanOrEqualTo__overload$2(
							rationalOneHalf(),
							integerTwo(),
						),
					).toEqual(booleanTrue())

					expect(
						rational.isLessThanOrEqualTo__overload$2(
							rationalOneHalf(),
							integerHundred(),
						),
					).toEqual(booleanTrue())

					expect(
						rational.isLessThanOrEqualTo__overload$2(
							rationalOne(),
							integerTwo(),
						),
					).toEqual(booleanTrue())

					expect(
						rational.isLessThanOrEqualTo__overload$2(
							rationalOne(),
							integerHundred(),
						),
					).toEqual(booleanTrue())

					expect(
						rational.isLessThanOrEqualTo__overload$2(
							rationalTwo(),
							integerHundred(),
						),
					).toEqual(booleanTrue())
				})

				it("returns true if the numbers are equal", () => {
					expect(
						rational.isLessThanOrEqualTo__overload$2(
							rationalOne(),
							integerOne(),
						),
					).toEqual(booleanTrue())

					expect(
						rational.isLessThanOrEqualTo__overload$2(
							rationalTwo(),
							integerTwo(),
						),
					).toEqual(booleanTrue())

					expect(
						rational.isLessThanOrEqualTo__overload$2(
							rationalHundred(),
							integerHundred(),
						),
					).toEqual(booleanTrue())
				})

				it("returns false if the first number is bigger than the second", () => {
					expect(
						rational.isLessThanOrEqualTo__overload$2(
							rationalOneHalf(),
							integerZero(),
						),
					).toEqual(booleanFalse())

					expect(
						rational.isLessThanOrEqualTo__overload$2(
							rationalOne(),
							integerZero(),
						),
					).toEqual(booleanFalse())

					expect(
						rational.isLessThanOrEqualTo__overload$2(
							rationalTwo(),
							integerOne(),
						),
					).toEqual(booleanFalse())

					expect(
						rational.isLessThanOrEqualTo__overload$2(
							rationalHundred(),
							integerZero(),
						),
					).toEqual(booleanFalse())

					expect(
						rational.isLessThanOrEqualTo__overload$2(
							rationalHundred(),
							integerOne(),
						),
					).toEqual(booleanFalse())

					expect(
						rational.isLessThanOrEqualTo__overload$2(
							rationalHundred(),
							integerTwo(),
						),
					).toEqual(booleanFalse())
				})
			})

			describe("isGreaterThan", () => {
				it("returns false if the first number is less than the second", () => {
					expect(
						rational.isGreaterThan__overload$2(
							rationalOneHalf(),
							integerOne(),
						),
					).toEqual(booleanFalse())

					expect(
						rational.isGreaterThan__overload$2(
							rationalOneHalf(),
							integerTwo(),
						),
					).toEqual(booleanFalse())

					expect(
						rational.isGreaterThan__overload$2(
							rationalOneHalf(),
							integerHundred(),
						),
					).toEqual(booleanFalse())

					expect(
						rational.isGreaterThan__overload$2(
							rationalOne(),
							integerTwo(),
						),
					).toEqual(booleanFalse())

					expect(
						rational.isGreaterThan__overload$2(
							rationalOne(),
							integerHundred(),
						),
					).toEqual(booleanFalse())

					expect(
						rational.isGreaterThan__overload$2(
							rationalTwo(),
							integerHundred(),
						),
					).toEqual(booleanFalse())
				})

				it("returns false if the numbers are equal", () => {
					expect(
						rational.isGreaterThan__overload$2(
							rationalOne(),
							integerOne(),
						),
					).toEqual(booleanFalse())

					expect(
						rational.isGreaterThan__overload$2(
							rationalTwo(),
							integerTwo(),
						),
					).toEqual(booleanFalse())

					expect(
						rational.isGreaterThan__overload$2(
							rationalHundred(),
							integerHundred(),
						),
					).toEqual(booleanFalse())
				})

				it("returns true if the first number is bigger than the second", () => {
					expect(
						rational.isGreaterThan__overload$2(
							rationalOneHalf(),
							integerZero(),
						),
					).toEqual(booleanTrue())

					expect(
						rational.isGreaterThan__overload$2(
							rationalOne(),
							integerZero(),
						),
					).toEqual(booleanTrue())

					expect(
						rational.isGreaterThan__overload$2(
							rationalTwo(),
							integerZero(),
						),
					).toEqual(booleanTrue())

					expect(
						rational.isGreaterThan__overload$2(
							rationalTwo(),
							integerOne(),
						),
					).toEqual(booleanTrue())

					expect(
						rational.isGreaterThan__overload$2(
							rationalHundred(),
							integerZero(),
						),
					).toEqual(booleanTrue())

					expect(
						rational.isGreaterThan__overload$2(
							rationalHundred(),
							integerOne(),
						),
					).toEqual(booleanTrue())

					expect(
						rational.isGreaterThan__overload$2(
							rationalHundred(),
							integerTwo(),
						),
					).toEqual(booleanTrue())
				})
			})

			describe("isGreaterThanOrEqualTo", () => {
				it("returns false if the first number is less than the second", () => {
					expect(
						rational.isGreaterThanOrEqualTo__overload$2(
							rationalOneHalf(),
							integerOne(),
						),
					).toEqual(booleanFalse())

					expect(
						rational.isGreaterThanOrEqualTo__overload$2(
							rationalOneHalf(),
							integerTwo(),
						),
					).toEqual(booleanFalse())

					expect(
						rational.isGreaterThanOrEqualTo__overload$2(
							rationalOneHalf(),
							integerHundred(),
						),
					).toEqual(booleanFalse())

					expect(
						rational.isGreaterThanOrEqualTo__overload$2(
							rationalOne(),
							integerTwo(),
						),
					).toEqual(booleanFalse())

					expect(
						rational.isGreaterThanOrEqualTo__overload$2(
							rationalOne(),
							integerHundred(),
						),
					).toEqual(booleanFalse())

					expect(
						rational.isGreaterThanOrEqualTo__overload$2(
							rationalTwo(),
							integerHundred(),
						),
					).toEqual(booleanFalse())
				})

				it("returns true if the numbers are equal", () => {
					expect(
						rational.isGreaterThanOrEqualTo__overload$2(
							rationalOne(),
							integerOne(),
						),
					).toEqual(booleanTrue())

					expect(
						rational.isGreaterThanOrEqualTo__overload$2(
							rationalTwo(),
							integerTwo(),
						),
					).toEqual(booleanTrue())

					expect(
						rational.isGreaterThanOrEqualTo__overload$2(
							rationalHundred(),
							integerHundred(),
						),
					).toEqual(booleanTrue())
				})

				it("returns true if the first number is bigger than the second", () => {
					expect(
						rational.isGreaterThanOrEqualTo__overload$2(
							rationalOneHalf(),
							integerZero(),
						),
					).toEqual(booleanTrue())

					expect(
						rational.isGreaterThanOrEqualTo__overload$2(
							rationalOne(),
							integerZero(),
						),
					).toEqual(booleanTrue())

					expect(
						rational.isGreaterThanOrEqualTo__overload$2(
							rationalTwo(),
							integerZero(),
						),
					).toEqual(booleanTrue())

					expect(
						rational.isGreaterThanOrEqualTo__overload$2(
							rationalTwo(),
							integerOne(),
						),
					).toEqual(booleanTrue())

					expect(
						rational.isGreaterThanOrEqualTo__overload$2(
							rationalHundred(),
							integerZero(),
						),
					).toEqual(booleanTrue())

					expect(
						rational.isGreaterThanOrEqualTo__overload$2(
							rationalHundred(),
							integerOne(),
						),
					).toEqual(booleanTrue())

					expect(
						rational.isGreaterThanOrEqualTo__overload$2(
							rationalHundred(),
							integerTwo(),
						),
					).toEqual(booleanTrue())
				})
			})

			describe("toString", () => {
				it("returns the correct strings", () => {
					expect(
						rational.toString__overload$1(rationalOneHalf()),
					).toEqual(string.createString("1/2"))

					expect(
						rational.toString__overload$2(
							rationalOneHalf(),
							string.createString("rational"),
						),
					).toEqual(string.createString("1/2"))

					expect(
						rational.toString__overload$2(
							rationalOneHalf(),
							string.createString("decimal"),
						),
					).toEqual(string.createString("0.5"))
				})
			})
		})

		describe("Number", () => {
			describe("lowestNumber", () => {
				// NOTE: the pairwise `lowestNumber` overloads ($1-$4) are
				// implemented in Essence now (`src/stdlib/Number.es`) and
				// covered by the golden harness; only the List-form overloads
				// ($5-$7) stay native.
				it("returns the smallest number of a list", () => {
					expect(
						number.lowestNumber__overload$5(
							list.createList([
								integerOne(),
								integerTwo(),
								integerHundred(),
							]),
						),
					).toEqual(integerOne())

					expect(
						number.lowestNumber__overload$5(
							list.createList([
								integerTwo(),
								integerOne(),
								integerHundred(),
							]),
						),
					).toEqual(integerOne())

					expect(
						number.lowestNumber__overload$5(
							list.createList([
								integerHundred(),
								integerTwo(),
								integerOne(),
							]),
						),
					).toEqual(integerOne())

					expect(
						number.lowestNumber__overload$6(
							list.createList([
								rationalOne(),
								rationalTwo(),
								rationalHundred(),
							]),
						),
					).toEqual(rationalOne())

					expect(
						number.lowestNumber__overload$6(
							list.createList([
								rationalTwo(),
								rationalOne(),
								rationalHundred(),
							]),
						),
					).toEqual(rationalOne())

					expect(
						number.lowestNumber__overload$6(
							list.createList([
								rationalHundred(),
								rationalTwo(),
								rationalOne(),
							]),
						),
					).toEqual(rationalOne())

					expect(
						number.lowestNumber__overload$6(
							list.createList([
								rationalHundred(),
								rationalTwo(),
								rationalOneHalf(),
								rationalOne(),
							]),
						),
					).toEqual(rationalOneHalf())

					expect(
						number.lowestNumber__overload$7(
							list.createList([
								integerOne(),
								rationalTwo(),
								integerHundred(),
							]),
						),
					).toEqual(integerOne())

					expect(
						number.lowestNumber__overload$7(
							list.createList([
								integerTwo(),
								rationalOne(),
								integerHundred(),
							]),
						),
					).toEqual(rationalOne())

					expect(
						number.lowestNumber__overload$7(
							list.createList([
								rationalHundred(),
								integerTwo(),
								integerOne(),
							]),
						),
					).toEqual(integerOne())

					expect(
						number.lowestNumber__overload$7(
							list.createList([
								integerHundred(),
								rationalOne(),
								rationalOneHalf(),
								integerOne(),
							]),
						),
					).toEqual(rationalOneHalf())
				})
			})

			describe("greatestNumber", () => {
				// NOTE: the pairwise `greatestNumber` overloads ($1-$4) are
				// implemented in Essence now (`src/stdlib/Number.es`) and
				// covered by the golden harness; only the List-form overloads
				// ($5-$7) stay native.
				it("returns the largest number of a list", () => {
					expect(
						number.greatestNumber__overload$5(
							list.createList([
								integerOne(),
								integerTwo(),
								integerHundred(),
							]),
						),
					).toEqual(integerHundred())

					expect(
						number.greatestNumber__overload$5(
							list.createList([
								integerTwo(),
								integerOne(),
								integerHundred(),
							]),
						),
					).toEqual(integerHundred())

					expect(
						number.greatestNumber__overload$5(
							list.createList([
								integerHundred(),
								integerTwo(),
								integerOne(),
							]),
						),
					).toEqual(integerHundred())

					expect(
						number.greatestNumber__overload$6(
							list.createList([
								rationalOne(),
								rationalTwo(),
								rationalHundred(),
							]),
						),
					).toEqual(rationalHundred())

					expect(
						number.greatestNumber__overload$6(
							list.createList([
								rationalTwo(),
								rationalOne(),
								rationalHundred(),
							]),
						),
					).toEqual(rationalHundred())

					expect(
						number.greatestNumber__overload$6(
							list.createList([
								rationalHundred(),
								rationalTwo(),
								rationalOne(),
							]),
						),
					).toEqual(rationalHundred())

					expect(
						number.greatestNumber__overload$6(
							list.createList([
								rationalHundred(),
								rationalTwo(),
								rationalOneHalf(),
								rationalOne(),
							]),
						),
					).toEqual(rationalHundred())

					expect(
						number.greatestNumber__overload$7(
							list.createList([
								integerOne(),
								rationalTwo(),
								integerHundred(),
							]),
						),
					).toEqual(integerHundred())

					expect(
						number.greatestNumber__overload$7(
							list.createList([
								integerTwo(),
								rationalOne(),
								integerHundred(),
							]),
						),
					).toEqual(integerHundred())

					expect(
						number.greatestNumber__overload$7(
							list.createList([
								rationalHundred(),
								integerTwo(),
								integerOne(),
							]),
						),
					).toEqual(rationalHundred())

					expect(
						number.greatestNumber__overload$7(
							list.createList([
								rationalOneHalf(),
								rationalOne(),
								integerHundred(),
								integerOne(),
							]),
						),
					).toEqual(integerHundred())
				})
			})
		})

		describe("List", () => {
			// NOTE: `is` takes a conformance witness now — equality of a List is
			// its items\' own equality, handed in by the call site — so the mixed
			// Lists this block used to compare (a String beside an Integer beside
			// a Rational) have no single witness to be compared through, and are
			// not a List any Program can call `is` on. The universal structural
			// comparison they exercised is `anyIs`, which keeps its own tests at
			// the top of this file.
			describe("is", () => {
				it("returns true if the lists have the same items in the same order", () => {
					expect(
						list.is(listEmpty(), listEmpty(), { is: integerIs }),
					).toEqual(booleanTrue())

					expect(
						list.is(
							list.createList([integerOne()]),
							list.createList([integerOne()]),
							{ is: integerIs },
						),
					).toEqual(booleanTrue())

					expect(
						list.is(
							list.createList([integerOne(), integerTwo()]),
							list.createList([integerOne(), integerTwo()]),
							{ is: integerIs },
						),
					).toEqual(booleanTrue())

					expect(
						list.is(
							list.createList([stringEmpty()]),
							list.createList([stringEmpty()]),
							{ is: stringIs },
						),
					).toEqual(booleanTrue())
				})

				it("returns false if the lists have the same items in a different order", () => {
					expect(
						list.is(
							list.createList([integerOne(), integerTwo()]),
							list.createList([integerTwo(), integerOne()]),
							{ is: integerIs },
						),
					).toEqual(booleanFalse())
				})

				it("returns false if the lists do not have the same items", () => {
					expect(
						list.is(
							list.createList([integerOne()]),
							list.createList([integerTwo()]),
							{ is: integerIs },
						),
					).toEqual(booleanFalse())

					expect(
						list.is(
							list.createList([stringEmpty()]),
							list.createList([string.createString("not empty")]),
							{ is: stringIs },
						),
					).toEqual(booleanFalse())
				})

				it("returns false if the lists are not the same length", () => {
					expect(
						list.is(listEmpty(), list.createList([integerTwo()]), {
							is: integerIs,
						}),
					).toEqual(booleanFalse())

					expect(
						list.is(list.createList([integerTwo()]), listEmpty(), {
							is: integerIs,
						}),
					).toEqual(booleanFalse())

					expect(
						list.is(
							list.createList([
								integerOne(),
								integerTwo(),
								integerHundred(),
							]),
							list.createList([integerOne(), integerTwo()]),
							{ is: integerIs },
						),
					).toEqual(booleanFalse())
				})
			})

			// NOTE: isNot / hasItems / doesNotContain are implemented in Essence now (src/stdlib/List.es); the golden harness covers them.

			describe("length", () => {
				it("returns the number of items in the list", () => {
					expect(list.length(listEmpty())).toEqual(integerZero())

					expect(
						list.length(list.createList([integerOne()])),
					).toEqual(integerOne())

					expect(
						list.length(
							list.createList([integerOne(), integerOne()]),
						),
					).toEqual(integerTwo())

					expect(
						list.length(list.createList([stringEmpty()])),
					).toEqual(integerOne())

					expect(list.length(list.createList([nothing()]))).toEqual(
						integerOne(),
					)

					expect(
						list.length(
							list.createList([
								integerOne(),
								stringEmpty(),
								integerHundred(),
								rationalOneHalf(),
							]),
						),
					).toEqual(integer.createInteger(4n))
				})
			})

			// NOTE: isEmpty / firstItem (both forms) / lastItem / removeFirst (both
			// forms) / remove / removeEvery (both forms) / removeLast (both forms)
			// / removeDuplicates / prepend (both forms) / append(_:) / contains /
			// anyItem / everyItem / count (both forms) / insert / replace /
			// partition / sorted / repeat are implemented in Essence now
			// (src/stdlib/List.es), so there is no runtime Function left to call
			// here. The golden harness covers them end to end; the entries of a
			// mixed `overload` block that are still native keep their tests below.

			describe("append", () => {
				it("appends contents of a list to another list correctly", () => {
					expect(
						list.append__overload$2(
							list.createList([]),
							list.createList([integerOne()]),
						),
					).toEqual(list.createList([integerOne()]))

					expect(
						list.append__overload$2(
							list.createList([integerOne()]),
							list.createList([integerTwo()]),
						),
					).toEqual(list.createList([integerOne(), integerTwo()]))

					expect(
						list.append__overload$2(
							list.createList([integerOne(), integerTwo()]),
							list.createList([integerHundred()]),
						),
					).toEqual(
						list.createList([
							integerOne(),
							integerTwo(),
							integerHundred(),
						]),
					)
				})
			})

			describe("map", () => {
				it("applies the transform to every item", () => {
					expect(
						list.map(
							list.createList([integerOne(), integerTwo()]),
							(item: integer.IntegerType) =>
								integer.toString(item),
						),
					).toEqual(
						list.createList([
							string.createString("1"),
							string.createString("2"),
						]),
					)
				})

				it("maps the empty list to the empty list", () => {
					expect(list.map(listEmpty(), () => integerOne())).toEqual(
						listEmpty(),
					)
				})
			})

			describe("reduce", () => {
				it("combines every item onto the starting value", () => {
					expect(
						list.reduce(
							list.createList([
								integerOne(),
								integerTwo(),
								integerHundred(),
							]),
							integerZero(),
							(
								accumulator: integer.IntegerType,
								item: integer.IntegerType,
							) =>
								integer.createInteger(
									accumulator.value + item.value,
								),
						),
					).toEqual(integer.createInteger(103n))
				})

				it("returns the starting value for the empty list", () => {
					expect(
						list.reduce(
							listEmpty(),
							integerZero(),
							(accumulator: integer.IntegerType) => accumulator,
						),
					).toEqual(integerZero())
				})
			})

			describe("keepEvery", () => {
				it("keeps just the accepted items", () => {
					const greaterThanOne = (item: integer.IntegerType) =>
						boolean.createBoolean(item.value > 1n)

					expect(
						list.keepEvery(
							list.createList([
								integerOne(),
								integerTwo(),
								integerHundred(),
							]),
							greaterThanOne,
						),
					).toEqual(list.createList([integerTwo(), integerHundred()]))
				})
			})

			describe("item", () => {
				it("returns the item at a position inside the list", () => {
					expect(
						list.item(
							list.createList([integerOne(), integerTwo()]),
							integerOne(),
						),
					).toEqual(integerTwo())
				})

				it("returns nothing for a position outside the list", () => {
					expect(
						list.item(
							list.createList([integerOne()]),
							integerTwo(),
						),
					).toEqual(nothing())
					expect(
						list.item(
							list.createList([integerOne()]),
							integer.createInteger(-1n),
						),
					).toEqual(nothing())
				})
			})

			describe("firstIndex", () => {
				// NOTE: Bounded by `Equatable` — the item `is` arrives as the
				// hidden witness, so which position is found is decided by the
				// items' own equality rather than by a structural comparison.
				it("gives the position of the first equal item", () => {
					expect(
						list.firstIndex(
							list.createList([
								integerTwo(),
								integerOne(),
								integerOne(),
							]),
							integerOne(),
							{ is: integerIs },
						),
					).toEqual(integerOne())
				})

				it("gives nothing when the item is absent", () => {
					expect(
						list.firstIndex(
							list.createList([integerOne()]),
							integerTwo(),
							{ is: integerIs },
						),
					).toEqual(nothing())
				})
			})

			describe("slice", () => {
				const abcd = () =>
					list.createList([
						integerZero(),
						integerOne(),
						integerTwo(),
						integerHundred(),
					])

				it("returns the half-open range", () => {
					// NOTE: [1, 3) — positions 1 and 2, stopping before 3.
					expect(
						list.slice(
							abcd(),
							integerOne(),
							integer.createInteger(3n),
						),
					).toEqual(list.createList([integerOne(), integerTwo()]))
				})

				it("clamps each end to the list", () => {
					expect(
						list.slice(
							abcd(),
							integer.createInteger(-5n),
							integer.createInteger(99n),
						),
					).toEqual(abcd())
				})

				it("returns empty when the range is empty or reversed", () => {
					expect(
						list.slice(abcd(), integerTwo(), integerOne()),
					).toEqual(listEmpty())
				})

				it("clamps a position past a 32 bit index instead of wrapping", () => {
					expect(
						list.slice(
							abcd(),
							integerZero(),
							integer.createInteger(2n ** 40n),
						),
					).toEqual(abcd())
				})
			})

			describe("reverse", () => {
				it("reverses without mutating the original", () => {
					const original = list.createList([
						integerOne(),
						integerTwo(),
						integerHundred(),
					])

					expect(list.reverse(original)).toEqual(
						list.createList([
							integerHundred(),
							integerTwo(),
							integerOne(),
						]),
					)
					expect(original).toEqual(
						list.createList([
							integerOne(),
							integerTwo(),
							integerHundred(),
						]),
					)
				})
			})

			describe("sortedBy", () => {
				it("orders by the comparison and is stable", () => {
					const ascending = (
						first: integer.IntegerType,
						second: integer.IntegerType,
					) => number.compareTo(first, second)

					expect(
						list.sortedBy(
							list.createList([
								integerTwo(),
								integerHundred(),
								integerOne(),
							]),
							ascending,
						),
					).toEqual(
						list.createList([
							integerOne(),
							integerTwo(),
							integerHundred(),
						]),
					)
				})
			})
		})

		describe("Record", () => {
			describe("entries", () => {
				it("returns the list of entries", () => {
					expect(record.entries(recordEmpty())).toEqual(listEmpty())

					expect(
						record.entries(
							record.createRecord({ a: integerOne() }),
						),
					).toEqual(
						list.createList([
							record.createRecord({
								key: string.createString("a"),
								value: integerOne(),
							}),
						]),
					)

					expect(
						record.entries(
							record.createRecord({
								a: integerOne(),
								b: stringEmpty(),
							}),
						),
					).toEqual(
						list.createList([
							record.createRecord({
								key: string.createString("a"),
								value: integerOne(),
							}),
							record.createRecord({
								key: string.createString("b"),
								value: stringEmpty(),
							}),
						]),
					)
				})
			})

			describe("keys", () => {
				it("returns the list of keys", () => {
					expect(record.keys(recordEmpty())).toEqual(listEmpty())

					expect(
						record.keys(record.createRecord({ a: integerOne() })),
					).toEqual(list.createList([string.createString("a")]))

					expect(
						record.keys(
							record.createRecord({
								a: integerOne(),
								b: stringEmpty(),
							}),
						),
					).toEqual(
						list.createList([
							string.createString("a"),
							string.createString("b"),
						]),
					)
				})
			})

			describe("values", () => {
				it("returns the list of values", () => {
					expect(record.values(recordEmpty())).toEqual(listEmpty())

					expect(
						record.values(record.createRecord({ a: integerOne() })),
					).toEqual(list.createList([integerOne()]))

					expect(
						record.values(
							record.createRecord({
								a: integerOne(),
								b: stringEmpty(),
							}),
						),
					).toEqual(list.createList([integerOne(), stringEmpty()]))
				})
			})

			describe("is", () => {
				it("returns true if the records are identical", () => {
					expect(record.is(recordEmpty(), recordEmpty())).toEqual(
						booleanTrue(),
					)

					expect(
						record.is(
							record.createRecord({ a: integerOne() }),
							record.createRecord({ a: integerOne() }),
						),
					).toEqual(booleanTrue())

					expect(
						record.is(
							record.createRecord({
								a: integerOne(),
								b: stringEmpty(),
							}),
							record.createRecord({
								a: integerOne(),
								b: stringEmpty(),
							}),
						),
					).toEqual(booleanTrue())
				})

				it("returns true regardless of key order", () => {
					expect(
						record.is(
							record.createRecord({
								a: integerOne(),
								b: stringEmpty(),
							}),
							record.createRecord({
								b: stringEmpty(),
								a: integerOne(),
							}),
						),
					).toEqual(booleanTrue())
				})

				it("returns false if the records share keys but differ in values", () => {
					expect(
						record.is(
							record.createRecord({
								a: integerOne(),
								b: stringEmpty(),
							}),
							record.createRecord({
								a: integerTwo(),
								b: stringEmpty(),
							}),
						),
					).toEqual(booleanFalse())
				})

				it("returns false if the records are different", () => {
					expect(
						record.is(
							recordEmpty(),
							record.createRecord({ a: integerOne() }),
						),
					).toEqual(booleanFalse())

					expect(
						record.is(
							record.createRecord({ a: integerOne() }),
							recordEmpty(),
						),
					).toEqual(booleanFalse())

					expect(
						record.is(
							record.createRecord({ a: integerOne() }),
							record.createRecord({
								a: integerOne(),
								b: stringEmpty(),
							}),
						),
					).toEqual(booleanFalse())

					expect(
						record.is(
							record.createRecord({
								a: integerOne(),
								b: stringEmpty(),
							}),
							record.createRecord({ a: integerOne() }),
						),
					).toEqual(booleanFalse())
				})
			})

			// NOTE: isNot is implemented in Essence now (src/stdlib/Record.es); the golden harness covers it.

			describe("toString", () => {
				it("prints correctly", () => {
					expect(record.toString(recordEmpty())).toEqual(
						string.createString("{}"),
					)

					expect(
						record.toString(
							record.createRecord({
								a: integerOne(),
								b: string.createString("text"),
							}),
						),
					).toEqual(string.createString('{ a = 1, b = "text" }'))
				})
			})
		})

		describe("Ordering", () => {
			// NOTE: `Ordering.is`, `isNot` and `toString` are implemented in
			// Essence now (`src/stdlib/Ordering.es`) — the golden harness
			// exercises them end to end. `Integer.compareTo` and
			// `Rational.compareTo` are Essence too now (both route through the
			// native `Number.compareTo`); only the runtime `anyIs` remains
			// native and keeps its unit test.
			it("compares Ordering values with anyIs", () => {
				expect(anyIs(ordering.less, ordering.less)).toBeTrue()
				expect(anyIs(ordering.less, ordering.equal)).toBeFalse()
				expect(anyIs(ordering.less, integerOne())).toBeFalse()
			})
		})

		describe("Protocol runtime gap fills", () => {
			// NOTE: `String.toString` is implemented in Essence now
			// (`src/stdlib/String.es`, `<- @`) and covered by the golden
			// harness; only `List.toString`, which has a representation to
			// build, is still native.

			it("represents a List with its items", () => {
				expect(
					list.toString(
						list.createList([integerOne(), integerTwo()]),
					),
				).toEqual(string.createString("[ 1, 2 ]"))
			})

			// NOTE: `Nothing.is`, `isNot` and `toString` are implemented in
			// Essence now (`src/stdlib/Nothing.es`) and covered by the golden
			// harness; only the value constructor stays native.
		})

		describe("Number", () => {
			// NOTE: `Number.is`, `isNot`, `toString` and the `isLessThan`
			// family are implemented in Essence now
			// (`src/stdlib/Number.es`) and covered by the golden harness.
			// Only `compareTo`, the one ordering primitive they all fall
			// out of, stays native.
			it("orders numerically across members", () => {
				expect(number.compareTo(integerOne(), rationalOneHalf())).toBe(
					ordering.greater,
				)
				expect(number.compareTo(rationalOneHalf(), integerOne())).toBe(
					ordering.less,
				)
				expect(number.compareTo(integerOne(), rationalOne())).toBe(
					ordering.equal,
				)
				expect(number.compareTo(integerTwo(), integerHundred())).toBe(
					ordering.less,
				)
			})
		})

		describe("Union Method dispatch", () => {
			it("runs the first case whose member Type accepts the receiver", () => {
				// NOTE: `Nothing.toString` is implemented in Essence now, so the
				// Nothing case supplies a stand-in of the same shape — this tests
				// that `dispatchMethod` picks the case whose member Type accepts
				// the receiver, not any particular runtime Method.
				let cases: Parameters<typeof dispatchMethod>[2] = [
					[
						{ type: "Nothing" },
						(() => string.createString("Nothing")) as (
							...args: Array<unknown>
						) => unknown,
						[],
					],
					[
						{ type: "Integer" },
						integer.toString as (
							...args: Array<unknown>
						) => unknown,
						[],
					],
				]

				expect(dispatchMethod(integerTwo(), [], cases)).toEqual(
					string.createString("2"),
				)
				expect(dispatchMethod(nothing(), [], cases)).toEqual(
					string.createString("Nothing"),
				)
			})

			it("appends the matched case's conformance Arguments", () => {
				let receivedArguments: Array<unknown> = []
				let method = (...args: Array<unknown>) => {
					receivedArguments = args
					return nothing()
				}

				dispatchMethod(
					integerTwo(),
					["shared"],
					[[{ type: "Integer" }, method, ["conformance"]]],
				)

				expect(receivedArguments).toEqual([
					integerTwo(),
					"shared",
					"conformance",
				])
			})
		})
	})
})
