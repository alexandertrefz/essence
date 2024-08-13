import { describe, expect, it } from "bun:test"

import { Fraction } from "bigint-fraction"

import * as boolean from "../rewriter/__internal/Boolean"
import * as fraction from "../rewriter/__internal/Fraction"
import * as integer from "../rewriter/__internal/Integer"
import * as list from "../rewriter/__internal/List"
import { createNothing } from "../rewriter/__internal/Nothing"
import * as number from "../rewriter/__internal/Number"
import * as record from "../rewriter/__internal/Record"
import * as string from "../rewriter/__internal/String"
import {
	anyIs,
	anyIsNot,
	isFirstFractionBigger,
} from "../rewriter/__internal/internalHelpers"
import { isValueOfType } from "../rewriter/__internal/type"

const booleanTrue = () => boolean.createBoolean(true)
const booleanFalse = () => boolean.createBoolean(false)
const stringEmpty = () => string.createString("")

const integerZero = () => integer.createInteger(0n)
const integerOne = () => integer.createInteger(1n)
const integerTwo = () => integer.createInteger(2n)
const integerHundred = () => integer.createInteger(100n)

const fractionOneHalf = () => fraction.createFraction(1n, 2n)
const fractionOne = () => fraction.createFraction(1n, 1n)
const fractionTwo = () => fraction.createFraction(2n, 1n)
const fractionHundred = () => fraction.createFraction(100n, 1n)

const listEmpty = () => list.createList([])

const recordEmpty = () => record.createRecord({})

const nothing = () => createNothing()

describe("Rewriter", () => {
	describe("Runtime", () => {
		describe("Internal Helpers", () => {
			describe("isFirstFractionBigger", () => {
				it("returns true of the first fraction is bigger", () => {
					expect(
						isFirstFractionBigger(
							new Fraction(1, 2),
							new Fraction(1, 3),
						),
					).toBeTrue()

					expect(
						isFirstFractionBigger(
							new Fraction(2, 8),
							new Fraction(3, 24),
						),
					).toBeTrue()
				})

				it("returns false of the second fraction is bigger", () => {
					expect(
						isFirstFractionBigger(
							new Fraction(1, 2),
							new Fraction(2, 3),
						),
					).toBeFalse()

					expect(
						isFirstFractionBigger(
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
						anyIs(fractionOneHalf(), fractionOneHalf()),
					).toBeTrue()

					expect(anyIs(fractionOne(), fractionOne())).toBeTrue()

					expect(anyIs(fractionTwo(), fractionTwo())).toBeTrue()

					expect(
						anyIs(fractionHundred(), fractionHundred()),
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

					expect(anyIs(nothing(), fractionOne())).toBeFalse()

					expect(anyIs(nothing(), stringEmpty())).toBeFalse()

					expect(anyIs(nothing(), listEmpty())).toBeFalse()

					expect(anyIs(nothing(), recordEmpty())).toBeFalse()

					expect(anyIs(booleanTrue(), nothing())).toBeFalse()

					expect(anyIs(booleanFalse(), nothing())).toBeFalse()

					expect(anyIs(integerOne(), nothing())).toBeFalse()

					expect(anyIs(fractionOne(), nothing())).toBeFalse()

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
						anyIsNot(fractionOneHalf(), fractionOneHalf()),
					).toBeFalse()

					expect(anyIsNot(fractionOne(), fractionOne())).toBeFalse()

					expect(anyIsNot(fractionTwo(), fractionTwo())).toBeFalse()

					expect(
						anyIsNot(fractionHundred(), fractionHundred()),
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

					expect(anyIsNot(nothing(), fractionOne())).toBeTrue()

					expect(anyIsNot(nothing(), stringEmpty())).toBeTrue()

					expect(anyIsNot(nothing(), listEmpty())).toBeTrue()

					expect(anyIsNot(nothing(), recordEmpty())).toBeTrue()

					expect(anyIsNot(booleanTrue(), nothing())).toBeTrue()

					expect(anyIsNot(booleanFalse(), nothing())).toBeTrue()

					expect(anyIsNot(integerOne(), nothing())).toBeTrue()

					expect(anyIsNot(fractionOne(), nothing())).toBeTrue()

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
						isValueOfType(fractionOne(), {
							type: "Fraction",
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
							type: "Fraction",
						}),
					).toBeFalse()
				})

				it("returns false for unimplemented checks", () => {
					expect(
						isValueOfType(listEmpty(), {
							type: "List",
							itemType: {
								type: "Nothing",
							},
						}),
					).toBeFalse()
				})
			})
		})

		describe("Native Functions", () => {
			describe("__print", () => {
				// TODO
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

			describe("isNot", () => {
				it("returns false when both sides match", () => {
					expect(boolean.isNot(booleanTrue(), booleanTrue())).toEqual(
						booleanFalse(),
					)

					expect(
						boolean.isNot(booleanFalse(), booleanFalse()),
					).toEqual(booleanFalse())
				})

				it("returns true when the sides dont match ", () => {
					expect(
						boolean.isNot(booleanTrue(), booleanFalse()),
					).toEqual(booleanTrue())

					expect(
						boolean.isNot(booleanFalse(), booleanTrue()),
					).toEqual(booleanTrue())
				})
			})

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

			describe("toString", () => {
				it("returns the correct strings", () => {
					expect(boolean.toString(booleanTrue())).toEqual(
						string.createString("true"),
					)

					expect(boolean.toString(booleanFalse())).toEqual(
						string.createString("false"),
					)
				})
			})
		})

		describe("String", () => {
			describe("isEmpty", () => {
				it("returns true for an empty string", () => {
					expect(string.isEmpty(stringEmpty())).toEqual(booleanTrue())
				})

				it("returns false for non-empty strings", () => {
					expect(string.isEmpty(string.createString(" "))).toEqual(
						booleanFalse(),
					)

					expect(string.isEmpty(string.createString("a"))).toEqual(
						booleanFalse(),
					)

					expect(string.isEmpty(string.createString("abc"))).toEqual(
						booleanFalse(),
					)

					expect(string.isEmpty(string.createString("!"))).toEqual(
						booleanFalse(),
					)
				})
			})

			describe("hasAnyContent", () => {
				it("returns true when the string is not empty", () => {
					expect(
						string.hasAnyContent(string.createString("a")),
					).toEqual(booleanTrue())

					expect(
						string.hasAnyContent(string.createString("abc")),
					).toEqual(booleanTrue())

					expect(
						string.hasAnyContent(string.createString(" ")),
					).toEqual(booleanTrue())

					expect(
						string.hasAnyContent(string.createString("!")),
					).toEqual(booleanTrue())
				})

				it("returns false when the string is empty", () => {
					expect(string.hasAnyContent(stringEmpty())).toEqual(
						booleanFalse(),
					)
				})
			})

			describe("is", () => {
				it("returns true when the strings are equal", () => {
					expect(string.is(stringEmpty(), stringEmpty())).toEqual(
						booleanTrue(),
					)

					expect(
						string.is(
							string.createString("a"),
							string.createString("a"),
						),
					).toEqual(booleanTrue())

					expect(
						string.is(
							string.createString("abc"),
							string.createString("abc"),
						),
					).toEqual(booleanTrue())

					expect(
						string.is(
							string.createString("!"),
							string.createString("!"),
						),
					).toEqual(booleanTrue())

					expect(
						string.is(
							string.createString(" "),
							string.createString(" "),
						),
					).toEqual(booleanTrue())
				})

				it("returns false when the strings are not equal", () => {
					expect(
						string.is(stringEmpty(), string.createString("a")),
					).toEqual(booleanFalse())

					expect(
						string.is(stringEmpty(), string.createString("abc")),
					).toEqual(booleanFalse())

					expect(
						string.is(stringEmpty(), string.createString("!")),
					).toEqual(booleanFalse())

					expect(
						string.is(stringEmpty(), string.createString(" ")),
					).toEqual(booleanFalse())

					expect(
						string.is(
							string.createString("abc"),
							string.createString(" "),
						),
					).toEqual(booleanFalse())

					expect(
						string.is(string.createString("abc"), stringEmpty()),
					).toEqual(booleanFalse())
				})
			})

			describe("isNot", () => {
				it("returns true when the strings are not equal", () => {
					expect(
						string.isNot(stringEmpty(), string.createString("a")),
					).toEqual(booleanTrue())

					expect(
						string.isNot(stringEmpty(), string.createString("abc")),
					).toEqual(booleanTrue())

					expect(
						string.isNot(stringEmpty(), string.createString("!")),
					).toEqual(booleanTrue())

					expect(
						string.isNot(stringEmpty(), string.createString(" ")),
					).toEqual(booleanTrue())

					expect(
						string.isNot(
							string.createString("abc"),
							string.createString(" "),
						),
					).toEqual(booleanTrue())

					expect(
						string.isNot(string.createString("abc"), stringEmpty()),
					).toEqual(booleanTrue())
				})

				it("returns false when the strings are equal", () => {
					expect(string.isNot(stringEmpty(), stringEmpty())).toEqual(
						booleanFalse(),
					)

					expect(
						string.isNot(
							string.createString("a"),
							string.createString("a"),
						),
					).toEqual(booleanFalse())

					expect(
						string.isNot(
							string.createString("abc"),
							string.createString("abc"),
						),
					).toEqual(booleanFalse())

					expect(
						string.isNot(
							string.createString("!"),
							string.createString("!"),
						),
					).toEqual(booleanFalse())

					expect(
						string.isNot(
							string.createString(" "),
							string.createString(" "),
						),
					).toEqual(booleanFalse())
				})
			})

			describe("prepend", () => {
				it("prepends any string in front of another", () => {
					expect(
						string.prepend(stringEmpty(), string.createString("a")),
					).toEqual(string.createString("a"))

					expect(
						string.prepend(
							stringEmpty(),
							string.createString("abc"),
						),
					).toEqual(string.createString("abc"))

					expect(
						string.prepend(stringEmpty(), string.createString("!")),
					).toEqual(string.createString("!"))

					expect(
						string.prepend(stringEmpty(), string.createString(" ")),
					).toEqual(string.createString(" "))

					expect(
						string.prepend(
							string.createString("bc"),
							string.createString("a"),
						),
					).toEqual(string.createString("abc"))
				})
			})

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

			describe("splitOn", () => {
				it("splits correctly when splitting on an empty string", () => {
					expect(
						string.splitOn(
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

				it("splits correctly using a substring", () => {
					expect(
						string.splitOn(
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
			})

			describe("contains", () => {
				it("returns true when the partial string is empty", () => {
					expect(
						string.contains(
							string.createString("abc"),
							stringEmpty(),
						),
					).toEqual(booleanTrue())
				})

				it("returns true when the partial string is found", () => {
					expect(
						string.contains(
							string.createString("abc"),
							string.createString("a"),
						),
					).toEqual(booleanTrue())

					expect(
						string.contains(
							string.createString("abc"),
							string.createString("b"),
						),
					).toEqual(booleanTrue())

					expect(
						string.contains(
							string.createString("abc"),
							string.createString("ab"),
						),
					).toEqual(booleanTrue())

					expect(
						string.contains(
							string.createString("abc"),
							string.createString("bc"),
						),
					).toEqual(booleanTrue())
				})

				it("returns true when the string is matched", () => {
					expect(
						string.contains(
							string.createString("abc"),
							string.createString("abc"),
						),
					).toEqual(booleanTrue())
				})

				it("returns false when the partial string is not found", () => {
					expect(
						string.contains(
							stringEmpty(),
							string.createString("abc"),
						),
					).toEqual(booleanFalse())

					expect(
						string.contains(
							string.createString("abc"),
							string.createString("d"),
						),
					).toEqual(booleanFalse())
				})
			})

			describe("doesNotContain", () => {
				it("returns true when the base string is empty", () => {
					expect(
						string.doesNotContain(
							stringEmpty(),
							string.createString("a"),
						),
					).toEqual(booleanTrue())
				})

				it("returns false when the partial string is empty", () => {
					expect(
						string.doesNotContain(
							string.createString("a"),
							stringEmpty(),
						),
					).toEqual(booleanFalse())
				})

				it("returns false when the partial string is found", () => {
					expect(
						string.doesNotContain(
							string.createString("abc"),
							string.createString("a"),
						),
					).toEqual(booleanFalse())

					expect(
						string.doesNotContain(
							string.createString("abc"),
							string.createString("b"),
						),
					).toEqual(booleanFalse())

					expect(
						string.doesNotContain(
							string.createString("abc"),
							string.createString("ab"),
						),
					).toEqual(booleanFalse())

					expect(
						string.doesNotContain(
							string.createString("abc"),
							string.createString("bc"),
						),
					).toEqual(booleanFalse())
				})

				it("returns false when the string is matched", () => {
					expect(
						string.doesNotContain(
							string.createString("abc"),
							string.createString("abc"),
						),
					).toEqual(booleanFalse())
				})

				it("returns true when the partial string is not found", () => {
					expect(
						string.doesNotContain(
							string.createString("abc"),
							string.createString("abcd"),
						),
					).toEqual(booleanTrue())

					expect(
						string.doesNotContain(
							string.createString("abc"),
							string.createString("d"),
						),
					).toEqual(booleanTrue())
				})
			})
		})

		describe("Integer", () => {
			describe("is", () => {
				it("returns true if the integers are the same", () => {
					expect(integer.is(integerOne(), integerOne())).toEqual(
						booleanTrue(),
					)

					expect(integer.is(integerTwo(), integerTwo())).toEqual(
						booleanTrue(),
					)

					expect(
						integer.is(integerHundred(), integerHundred()),
					).toEqual(booleanTrue())
				})

				it("returns false if the integers are not the same", () => {
					expect(integer.is(integerOne(), integerTwo())).toEqual(
						booleanFalse(),
					)

					expect(integer.is(integerOne(), integerHundred())).toEqual(
						booleanFalse(),
					)

					expect(integer.is(integerTwo(), integerOne())).toEqual(
						booleanFalse(),
					)

					expect(integer.is(integerTwo(), integerHundred())).toEqual(
						booleanFalse(),
					)

					expect(integer.is(integerHundred(), integerOne())).toEqual(
						booleanFalse(),
					)

					expect(integer.is(integerHundred(), integerTwo())).toEqual(
						booleanFalse(),
					)
				})
			})

			describe("isNot", () => {
				it("returns true if the integers are not the same", () => {
					expect(integer.isNot(integerOne(), integerTwo())).toEqual(
						booleanTrue(),
					)

					expect(
						integer.isNot(integerOne(), integerHundred()),
					).toEqual(booleanTrue())

					expect(integer.isNot(integerTwo(), integerOne())).toEqual(
						booleanTrue(),
					)

					expect(
						integer.isNot(integerTwo(), integerHundred()),
					).toEqual(booleanTrue())

					expect(
						integer.isNot(integerHundred(), integerOne()),
					).toEqual(booleanTrue())

					expect(
						integer.isNot(integerHundred(), integerTwo()),
					).toEqual(booleanTrue())
				})

				it("returns false if the integers are the same", () => {
					expect(integer.isNot(integerOne(), integerOne())).toEqual(
						booleanFalse(),
					)

					expect(integer.isNot(integerTwo(), integerTwo())).toEqual(
						booleanFalse(),
					)

					expect(
						integer.isNot(integerHundred(), integerHundred()),
					).toEqual(booleanFalse())
				})
			})

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

				it("adds an integer and a fraction correctly", () => {
					expect(
						integer.add__overload$2(
							integerOne(),
							fractionOneHalf(),
						),
					).toEqual(fraction.createFraction(3n, 2n))

					expect(
						integer.add__overload$2(
							integerHundred(),
							fractionOneHalf(),
						),
					).toEqual(fraction.createFraction(201n, 2n))

					expect(
						integer.add__overload$2(
							integerOne(),
							fraction.createFraction(-1n, 2n),
						),
					).toEqual(fractionOneHalf())

					expect(
						integer.add__overload$2(
							integerOne(),
							fraction.createFraction(1n, -2n),
						),
					).toEqual(fractionOneHalf())
				})
			})

			describe("subtract", () => {
				it("subtract 2 integers correctly", () => {
					expect(
						integer.subtract__overload$1(
							integerTwo(),
							integerOne(),
						),
					).toEqual(integerOne())

					expect(
						integer.subtract__overload$1(
							integerHundred(),
							integerOne(),
						),
					).toEqual(integer.createInteger(99n))

					expect(
						integer.subtract__overload$1(
							integerOne(),
							integerHundred(),
						),
					).toEqual(integer.createInteger(-99n))
				})

				it("subtracts a fraction from an integer correctly", () => {
					expect(
						integer.subtract__overload$2(
							integerOne(),
							fractionOneHalf(),
						),
					).toEqual(fractionOneHalf())

					expect(
						integer.subtract__overload$2(
							integerHundred(),
							fractionOneHalf(),
						),
					).toEqual(fraction.createFraction(199n, 2n))

					expect(
						integer.subtract__overload$2(
							integerOne(),
							fraction.createFraction(-1n, 2n),
						),
					).toEqual(fraction.createFraction(3n, 2n))
				})
			})

			describe("multiply", () => {
				it("multiplies 2 integers correctly", () => {
					expect(
						integer.multiplyWith__overload$1(
							integerOne(),
							integerOne(),
						),
					).toEqual(integerOne())

					expect(
						integer.multiplyWith__overload$1(
							integerHundred(),
							integerOne(),
						),
					).toEqual(integerHundred())

					expect(
						integer.multiplyWith__overload$1(
							integerTwo(),
							integerTwo(),
						),
					).toEqual(integer.createInteger(4n))

					expect(
						integer.multiplyWith__overload$1(
							integerTwo(),
							integerHundred(),
						),
					).toEqual(integer.createInteger(200n))
				})

				it("multiplies an integer and a fraction correctly", () => {
					expect(
						integer.multiplyWith__overload$2(
							integerOne(),
							fractionOneHalf(),
						),
					).toEqual(fractionOneHalf())

					// NOTE: Fractions are not automatically reduced, so we need to compare against the common demoninator
					expect(
						integer.multiplyWith__overload$2(
							integerHundred(),
							fractionOneHalf(),
						),
					).toEqual(fraction.createFraction(100n, 2n))

					// NOTE: Fractions are not automatically reduced, so we need to compare against the common demoninator
					expect(
						integer.multiplyWith__overload$2(
							integerTwo(),
							fractionOneHalf(),
						),
					).toEqual(fraction.createFraction(2n, 2n))

					expect(
						integer.multiplyWith__overload$2(
							integerTwo(),
							fraction.createFraction(50n, 1n),
						),
					).toEqual(fraction.createFraction(100n, 1n))
				})
			})

			describe("divide", () => {
				it("divides 2 integers correctly", () => {
					expect(
						integer.divideBy__overload$1(
							integerOne(),
							integerOne(),
						),
					).toEqual(fraction.createFraction(1n, 1n))

					expect(
						integer.divideBy__overload$1(
							integerOne(),
							integerTwo(),
						),
					).toEqual(fraction.createFraction(1n, 2n))

					expect(
						integer.divideBy__overload$1(
							integerHundred(),
							integerTwo(),
						),
					).toEqual(fraction.createFraction(100n, 2n))
				})

				it("divides an integer and a fraction correctly", () => {
					expect(
						integer.divideBy__overload$2(
							integerOne(),
							fractionOneHalf(),
						),
					).toEqual(fraction.createFraction(2n, 1n))

					expect(
						integer.divideBy__overload$2(
							integerOne(),
							fraction.createFraction(2n, 1n),
						),
					).toEqual(fraction.createFraction(1n, 2n))

					expect(
						integer.divideBy__overload$2(
							integerHundred(),
							fraction.createFraction(2n, 1n),
						),
					).toEqual(fraction.createFraction(100n, 2n))
				})
			})

			describe("isLessThan", () => {
				it("returns true if the first number is less than the second", () => {
					expect(
						integer.isLessThan__overload$1(
							integerZero(),
							integerOne(),
						),
					).toEqual(booleanTrue())

					expect(
						integer.isLessThan__overload$1(
							integerZero(),
							integerTwo(),
						),
					).toEqual(booleanTrue())

					expect(
						integer.isLessThan__overload$1(
							integerZero(),
							integerHundred(),
						),
					).toEqual(booleanTrue())

					expect(
						integer.isLessThan__overload$1(
							integerOne(),
							integerTwo(),
						),
					).toEqual(booleanTrue())

					expect(
						integer.isLessThan__overload$1(
							integerOne(),
							integerHundred(),
						),
					).toEqual(booleanTrue())

					expect(
						integer.isLessThan__overload$1(
							integerTwo(),
							integerHundred(),
						),
					).toEqual(booleanTrue())

					expect(
						integer.isLessThan__overload$2(
							integerZero(),
							fractionOneHalf(),
						),
					).toEqual(booleanTrue())

					expect(
						integer.isLessThan__overload$2(
							integerZero(),
							fractionOne(),
						),
					).toEqual(booleanTrue())

					expect(
						integer.isLessThan__overload$2(
							integerZero(),
							fractionTwo(),
						),
					).toEqual(booleanTrue())

					expect(
						integer.isLessThan__overload$2(
							integerZero(),
							fractionHundred(),
						),
					).toEqual(booleanTrue())

					expect(
						integer.isLessThan__overload$2(
							integerOne(),
							fractionTwo(),
						),
					).toEqual(booleanTrue())

					expect(
						integer.isLessThan__overload$2(
							integerOne(),
							fractionHundred(),
						),
					).toEqual(booleanTrue())

					expect(
						integer.isLessThan__overload$2(
							integerTwo(),
							fractionHundred(),
						),
					).toEqual(booleanTrue())
				})

				it("returns false if the numbers are equal", () => {
					expect(
						integer.isLessThan__overload$1(
							integerZero(),
							integerZero(),
						),
					).toEqual(booleanFalse())

					expect(
						integer.isLessThan__overload$1(
							integerOne(),
							integerOne(),
						),
					).toEqual(booleanFalse())

					expect(
						integer.isLessThan__overload$1(
							integerTwo(),
							integerTwo(),
						),
					).toEqual(booleanFalse())

					expect(
						integer.isLessThan__overload$1(
							integerHundred(),
							integerHundred(),
						),
					).toEqual(booleanFalse())

					expect(
						integer.isLessThan__overload$2(
							integerOne(),
							fractionOne(),
						),
					).toEqual(booleanFalse())

					expect(
						integer.isLessThan__overload$2(
							integerTwo(),
							fractionTwo(),
						),
					).toEqual(booleanFalse())

					expect(
						integer.isLessThan__overload$2(
							integerHundred(),
							fractionHundred(),
						),
					).toEqual(booleanFalse())
				})

				it("returns false if the first number is bigger than the second", () => {
					expect(
						integer.isLessThan__overload$1(
							integerHundred(),
							integerTwo(),
						),
					).toEqual(booleanFalse())

					expect(
						integer.isLessThan__overload$1(
							integerHundred(),
							integerOne(),
						),
					).toEqual(booleanFalse())

					expect(
						integer.isLessThan__overload$1(
							integerHundred(),
							integerZero(),
						),
					).toEqual(booleanFalse())

					expect(
						integer.isLessThan__overload$1(
							integerTwo(),
							integerOne(),
						),
					).toEqual(booleanFalse())

					expect(
						integer.isLessThan__overload$1(
							integerTwo(),
							integerZero(),
						),
					).toEqual(booleanFalse())

					expect(
						integer.isLessThan__overload$1(
							integerOne(),
							integerZero(),
						),
					).toEqual(booleanFalse())

					expect(
						integer.isLessThan__overload$2(
							integerOne(),
							fractionOneHalf(),
						),
					).toEqual(booleanFalse())

					expect(
						integer.isLessThan__overload$2(
							integerTwo(),
							fractionOneHalf(),
						),
					).toEqual(booleanFalse())

					expect(
						integer.isLessThan__overload$2(
							integerTwo(),
							fractionOne(),
						),
					).toEqual(booleanFalse())

					expect(
						integer.isLessThan__overload$2(
							integerHundred(),
							fractionOneHalf(),
						),
					).toEqual(booleanFalse())

					expect(
						integer.isLessThan__overload$2(
							integerHundred(),
							fractionOne(),
						),
					).toEqual(booleanFalse())

					expect(
						integer.isLessThan__overload$2(
							integerHundred(),
							fractionTwo(),
						),
					).toEqual(booleanFalse())
				})
			})

			describe("isLessThanOrEqualTo", () => {
				it("returns true if the first number is less than the second", () => {
					expect(
						integer.isLessThanOrEqualTo__overload$1(
							integerZero(),
							integerOne(),
						),
					).toEqual(booleanTrue())

					expect(
						integer.isLessThanOrEqualTo__overload$1(
							integerZero(),
							integerTwo(),
						),
					).toEqual(booleanTrue())

					expect(
						integer.isLessThanOrEqualTo__overload$1(
							integerZero(),
							integerHundred(),
						),
					).toEqual(booleanTrue())

					expect(
						integer.isLessThanOrEqualTo__overload$1(
							integerOne(),
							integerTwo(),
						),
					).toEqual(booleanTrue())

					expect(
						integer.isLessThanOrEqualTo__overload$1(
							integerOne(),
							integerHundred(),
						),
					).toEqual(booleanTrue())

					expect(
						integer.isLessThanOrEqualTo__overload$1(
							integerTwo(),
							integerHundred(),
						),
					).toEqual(booleanTrue())

					expect(
						integer.isLessThanOrEqualTo__overload$2(
							integerZero(),
							fractionOneHalf(),
						),
					).toEqual(booleanTrue())

					expect(
						integer.isLessThanOrEqualTo__overload$2(
							integerZero(),
							fractionOne(),
						),
					).toEqual(booleanTrue())

					expect(
						integer.isLessThanOrEqualTo__overload$2(
							integerZero(),
							fractionTwo(),
						),
					).toEqual(booleanTrue())

					expect(
						integer.isLessThanOrEqualTo__overload$2(
							integerZero(),
							fractionHundred(),
						),
					).toEqual(booleanTrue())

					expect(
						integer.isLessThanOrEqualTo__overload$2(
							integerOne(),
							fractionTwo(),
						),
					).toEqual(booleanTrue())

					expect(
						integer.isLessThanOrEqualTo__overload$2(
							integerOne(),
							fractionHundred(),
						),
					).toEqual(booleanTrue())

					expect(
						integer.isLessThanOrEqualTo__overload$2(
							integerTwo(),
							fractionHundred(),
						),
					).toEqual(booleanTrue())
				})

				it("returns true if the numbers are equal", () => {
					expect(
						integer.isLessThanOrEqualTo__overload$1(
							integerZero(),
							integerZero(),
						),
					).toEqual(booleanTrue())

					expect(
						integer.isLessThanOrEqualTo__overload$1(
							integerOne(),
							integerOne(),
						),
					).toEqual(booleanTrue())

					expect(
						integer.isLessThanOrEqualTo__overload$1(
							integerTwo(),
							integerTwo(),
						),
					).toEqual(booleanTrue())

					expect(
						integer.isLessThanOrEqualTo__overload$1(
							integerHundred(),
							integerHundred(),
						),
					).toEqual(booleanTrue())

					expect(
						integer.isLessThanOrEqualTo__overload$2(
							integerOne(),
							fractionOne(),
						),
					).toEqual(booleanTrue())

					expect(
						integer.isLessThanOrEqualTo__overload$2(
							integerTwo(),
							fractionTwo(),
						),
					).toEqual(booleanTrue())

					expect(
						integer.isLessThanOrEqualTo__overload$2(
							integerHundred(),
							fractionHundred(),
						),
					).toEqual(booleanTrue())
				})

				it("returns false if the first number is bigger than the second", () => {
					expect(
						integer.isLessThanOrEqualTo__overload$1(
							integerHundred(),
							integerTwo(),
						),
					).toEqual(booleanFalse())

					expect(
						integer.isLessThanOrEqualTo__overload$1(
							integerHundred(),
							integerOne(),
						),
					).toEqual(booleanFalse())

					expect(
						integer.isLessThanOrEqualTo__overload$1(
							integerHundred(),
							integerZero(),
						),
					).toEqual(booleanFalse())

					expect(
						integer.isLessThanOrEqualTo__overload$1(
							integerTwo(),
							integerOne(),
						),
					).toEqual(booleanFalse())

					expect(
						integer.isLessThanOrEqualTo__overload$1(
							integerTwo(),
							integerZero(),
						),
					).toEqual(booleanFalse())

					expect(
						integer.isLessThanOrEqualTo__overload$1(
							integerOne(),
							integerZero(),
						),
					).toEqual(booleanFalse())

					expect(
						integer.isLessThanOrEqualTo__overload$2(
							integerOne(),
							fractionOneHalf(),
						),
					).toEqual(booleanFalse())

					expect(
						integer.isLessThanOrEqualTo__overload$2(
							integerTwo(),
							fractionOneHalf(),
						),
					).toEqual(booleanFalse())

					expect(
						integer.isLessThanOrEqualTo__overload$2(
							integerTwo(),
							fractionOne(),
						),
					).toEqual(booleanFalse())

					expect(
						integer.isLessThanOrEqualTo__overload$2(
							integerHundred(),
							fractionOneHalf(),
						),
					).toEqual(booleanFalse())

					expect(
						integer.isLessThanOrEqualTo__overload$2(
							integerHundred(),
							fractionOne(),
						),
					).toEqual(booleanFalse())

					expect(
						integer.isLessThanOrEqualTo__overload$2(
							integerHundred(),
							fractionTwo(),
						),
					).toEqual(booleanFalse())
				})
			})

			describe("isGreaterThan", () => {
				it("returns false if the first number is less than the second", () => {
					expect(
						integer.isGreaterThan__overload$1(
							integerZero(),
							integerOne(),
						),
					).toEqual(booleanFalse())

					expect(
						integer.isGreaterThan__overload$1(
							integerZero(),
							integerTwo(),
						),
					).toEqual(booleanFalse())

					expect(
						integer.isGreaterThan__overload$1(
							integerZero(),
							integerHundred(),
						),
					).toEqual(booleanFalse())

					expect(
						integer.isGreaterThan__overload$1(
							integerOne(),
							integerTwo(),
						),
					).toEqual(booleanFalse())

					expect(
						integer.isGreaterThan__overload$1(
							integerOne(),
							integerHundred(),
						),
					).toEqual(booleanFalse())

					expect(
						integer.isGreaterThan__overload$1(
							integerTwo(),
							integerHundred(),
						),
					).toEqual(booleanFalse())

					expect(
						integer.isGreaterThan__overload$2(
							integerZero(),
							fractionOneHalf(),
						),
					).toEqual(booleanFalse())

					expect(
						integer.isGreaterThan__overload$2(
							integerZero(),
							fractionOne(),
						),
					).toEqual(booleanFalse())

					expect(
						integer.isGreaterThan__overload$2(
							integerZero(),
							fractionTwo(),
						),
					).toEqual(booleanFalse())

					expect(
						integer.isGreaterThan__overload$2(
							integerZero(),
							fractionHundred(),
						),
					).toEqual(booleanFalse())

					expect(
						integer.isGreaterThan__overload$2(
							integerOne(),
							fractionTwo(),
						),
					).toEqual(booleanFalse())

					expect(
						integer.isGreaterThan__overload$2(
							integerOne(),
							fractionHundred(),
						),
					).toEqual(booleanFalse())

					expect(
						integer.isGreaterThan__overload$2(
							integerTwo(),
							fractionHundred(),
						),
					).toEqual(booleanFalse())
				})

				it("returns false if the numbers are equal", () => {
					expect(
						integer.isGreaterThan__overload$1(
							integerZero(),
							integerZero(),
						),
					).toEqual(booleanFalse())

					expect(
						integer.isGreaterThan__overload$1(
							integerOne(),
							integerOne(),
						),
					).toEqual(booleanFalse())

					expect(
						integer.isGreaterThan__overload$1(
							integerTwo(),
							integerTwo(),
						),
					).toEqual(booleanFalse())

					expect(
						integer.isGreaterThan__overload$1(
							integerHundred(),
							integerHundred(),
						),
					).toEqual(booleanFalse())

					expect(
						integer.isGreaterThan__overload$2(
							integerOne(),
							fractionOne(),
						),
					).toEqual(booleanFalse())

					expect(
						integer.isGreaterThan__overload$2(
							integerTwo(),
							fractionTwo(),
						),
					).toEqual(booleanFalse())

					expect(
						integer.isGreaterThan__overload$2(
							integerHundred(),
							fractionHundred(),
						),
					).toEqual(booleanFalse())
				})

				it("returns true if the first number is bigger than the second", () => {
					expect(
						integer.isGreaterThan__overload$1(
							integerHundred(),
							integerTwo(),
						),
					).toEqual(booleanTrue())

					expect(
						integer.isGreaterThan__overload$1(
							integerHundred(),
							integerOne(),
						),
					).toEqual(booleanTrue())

					expect(
						integer.isGreaterThan__overload$1(
							integerHundred(),
							integerZero(),
						),
					).toEqual(booleanTrue())

					expect(
						integer.isGreaterThan__overload$1(
							integerTwo(),
							integerOne(),
						),
					).toEqual(booleanTrue())

					expect(
						integer.isGreaterThan__overload$1(
							integerTwo(),
							integerZero(),
						),
					).toEqual(booleanTrue())

					expect(
						integer.isGreaterThan__overload$1(
							integerOne(),
							integerZero(),
						),
					).toEqual(booleanTrue())

					expect(
						integer.isGreaterThan__overload$2(
							integerOne(),
							fractionOneHalf(),
						),
					).toEqual(booleanTrue())

					expect(
						integer.isGreaterThan__overload$2(
							integerTwo(),
							fractionOneHalf(),
						),
					).toEqual(booleanTrue())

					expect(
						integer.isGreaterThan__overload$2(
							integerTwo(),
							fractionOne(),
						),
					).toEqual(booleanTrue())

					expect(
						integer.isGreaterThan__overload$2(
							integerHundred(),
							fractionOneHalf(),
						),
					).toEqual(booleanTrue())

					expect(
						integer.isGreaterThan__overload$2(
							integerHundred(),
							fractionOne(),
						),
					).toEqual(booleanTrue())

					expect(
						integer.isGreaterThan__overload$2(
							integerHundred(),
							fractionTwo(),
						),
					).toEqual(booleanTrue())
				})
			})

			describe("isGreaterThanOrEqualTo", () => {
				it("returns false if the first number is less than the second", () => {
					expect(
						integer.isGreaterThanOrEqualTo__overload$1(
							integerZero(),
							integerOne(),
						),
					).toEqual(booleanFalse())

					expect(
						integer.isGreaterThanOrEqualTo__overload$1(
							integerZero(),
							integerTwo(),
						),
					).toEqual(booleanFalse())

					expect(
						integer.isGreaterThanOrEqualTo__overload$1(
							integerZero(),
							integerHundred(),
						),
					).toEqual(booleanFalse())

					expect(
						integer.isGreaterThanOrEqualTo__overload$1(
							integerOne(),
							integerTwo(),
						),
					).toEqual(booleanFalse())

					expect(
						integer.isGreaterThanOrEqualTo__overload$1(
							integerOne(),
							integerHundred(),
						),
					).toEqual(booleanFalse())

					expect(
						integer.isGreaterThanOrEqualTo__overload$1(
							integerTwo(),
							integerHundred(),
						),
					).toEqual(booleanFalse())

					expect(
						integer.isGreaterThanOrEqualTo__overload$2(
							integerZero(),
							fractionOneHalf(),
						),
					).toEqual(booleanFalse())

					expect(
						integer.isGreaterThanOrEqualTo__overload$2(
							integerZero(),
							fractionOne(),
						),
					).toEqual(booleanFalse())

					expect(
						integer.isGreaterThanOrEqualTo__overload$2(
							integerZero(),
							fractionTwo(),
						),
					).toEqual(booleanFalse())

					expect(
						integer.isGreaterThanOrEqualTo__overload$2(
							integerZero(),
							fractionHundred(),
						),
					).toEqual(booleanFalse())

					expect(
						integer.isGreaterThanOrEqualTo__overload$2(
							integerOne(),
							fractionTwo(),
						),
					).toEqual(booleanFalse())

					expect(
						integer.isGreaterThanOrEqualTo__overload$2(
							integerOne(),
							fractionHundred(),
						),
					).toEqual(booleanFalse())

					expect(
						integer.isGreaterThanOrEqualTo__overload$2(
							integerTwo(),
							fractionHundred(),
						),
					).toEqual(booleanFalse())
				})

				it("returns true if the numbers are equal", () => {
					expect(
						integer.isGreaterThanOrEqualTo__overload$1(
							integerZero(),
							integerZero(),
						),
					).toEqual(booleanTrue())

					expect(
						integer.isGreaterThanOrEqualTo__overload$1(
							integerOne(),
							integerOne(),
						),
					).toEqual(booleanTrue())

					expect(
						integer.isGreaterThanOrEqualTo__overload$1(
							integerTwo(),
							integerTwo(),
						),
					).toEqual(booleanTrue())

					expect(
						integer.isGreaterThanOrEqualTo__overload$1(
							integerHundred(),
							integerHundred(),
						),
					).toEqual(booleanTrue())

					expect(
						integer.isGreaterThanOrEqualTo__overload$2(
							integerOne(),
							fractionOne(),
						),
					).toEqual(booleanTrue())

					expect(
						integer.isGreaterThanOrEqualTo__overload$2(
							integerTwo(),
							fractionTwo(),
						),
					).toEqual(booleanTrue())

					expect(
						integer.isGreaterThanOrEqualTo__overload$2(
							integerHundred(),
							fractionHundred(),
						),
					).toEqual(booleanTrue())
				})

				it("returns true if the first number is bigger than the second", () => {
					expect(
						integer.isGreaterThanOrEqualTo__overload$1(
							integerHundred(),
							integerTwo(),
						),
					).toEqual(booleanTrue())

					expect(
						integer.isGreaterThanOrEqualTo__overload$1(
							integerHundred(),
							integerOne(),
						),
					).toEqual(booleanTrue())

					expect(
						integer.isGreaterThanOrEqualTo__overload$1(
							integerHundred(),
							integerZero(),
						),
					).toEqual(booleanTrue())

					expect(
						integer.isGreaterThanOrEqualTo__overload$1(
							integerTwo(),
							integerOne(),
						),
					).toEqual(booleanTrue())

					expect(
						integer.isGreaterThanOrEqualTo__overload$1(
							integerTwo(),
							integerZero(),
						),
					).toEqual(booleanTrue())

					expect(
						integer.isGreaterThanOrEqualTo__overload$1(
							integerOne(),
							integerZero(),
						),
					).toEqual(booleanTrue())

					expect(
						integer.isGreaterThanOrEqualTo__overload$2(
							integerOne(),
							fractionOneHalf(),
						),
					).toEqual(booleanTrue())

					expect(
						integer.isGreaterThanOrEqualTo__overload$2(
							integerTwo(),
							fractionOneHalf(),
						),
					).toEqual(booleanTrue())

					expect(
						integer.isGreaterThanOrEqualTo__overload$2(
							integerTwo(),
							fractionOne(),
						),
					).toEqual(booleanTrue())

					expect(
						integer.isGreaterThanOrEqualTo__overload$2(
							integerHundred(),
							fractionOneHalf(),
						),
					).toEqual(booleanTrue())

					expect(
						integer.isGreaterThanOrEqualTo__overload$2(
							integerHundred(),
							fractionOne(),
						),
					).toEqual(booleanTrue())

					expect(
						integer.isGreaterThanOrEqualTo__overload$2(
							integerHundred(),
							fractionTwo(),
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

		describe("Fraction", () => {
			describe("of", () => {
				it("creates a fraction", () => {
					expect(fraction.of(integerOne(), integerTwo())).toEqual(
						fractionOneHalf(),
					)
				})
			})

			describe("is", () => {
				it("returns true if both fractions are the same", () => {
					expect(
						fraction.is(fractionOneHalf(), fractionOneHalf()),
					).toEqual(booleanTrue())

					expect(fraction.is(fractionOne(), fractionOne())).toEqual(
						booleanTrue(),
					)

					expect(fraction.is(fractionTwo(), fractionTwo())).toEqual(
						booleanTrue(),
					)

					expect(
						fraction.is(fractionHundred(), fractionHundred()),
					).toEqual(booleanTrue())

					expect(
						fraction.is(
							fractionOne(),
							fraction.divideBy__overload$1(
								fractionTwo(),
								fractionTwo(),
							),
						),
					).toEqual(booleanTrue())

					expect(
						fraction.is(
							fraction.divideBy__overload$1(
								fractionTwo(),
								fractionTwo(),
							),
							fractionOne(),
						),
					).toEqual(booleanTrue())
				})

				it("returns false if the fractions are not the same", () => {
					expect(fraction.is(fractionOne(), fractionTwo())).toEqual(
						booleanFalse(),
					)

					expect(fraction.is(fractionTwo(), fractionOne())).toEqual(
						booleanFalse(),
					)

					expect(
						fraction.is(fractionHundred(), fractionOneHalf()),
					).toEqual(booleanFalse())

					expect(
						fraction.is(fractionOneHalf(), fractionHundred()),
					).toEqual(booleanFalse())

					expect(
						fraction.is(fractionOne(), fractionOneHalf()),
					).toEqual(booleanFalse())

					expect(
						fraction.is(fractionOneHalf(), fractionOne()),
					).toEqual(booleanFalse())
				})
			})

			describe("isNot", () => {
				it("returns true if the fractions are not the same", () => {
					expect(
						fraction.isNot(fractionOne(), fractionOneHalf()),
					).toEqual(booleanTrue())

					expect(
						fraction.isNot(fractionOne(), fractionTwo()),
					).toEqual(booleanTrue())

					expect(
						fraction.isNot(fractionOne(), fractionHundred()),
					).toEqual(booleanTrue())

					expect(
						fraction.isNot(fractionOneHalf(), fractionOne()),
					).toEqual(booleanTrue())

					expect(
						fraction.isNot(fractionOneHalf(), fractionTwo()),
					).toEqual(booleanTrue())

					expect(
						fraction.isNot(fractionOneHalf(), fractionHundred()),
					).toEqual(booleanTrue())

					expect(
						fraction.isNot(fractionTwo(), fractionOneHalf()),
					).toEqual(booleanTrue())

					expect(
						fraction.isNot(fractionTwo(), fractionOne()),
					).toEqual(booleanTrue())

					expect(
						fraction.isNot(fractionTwo(), fractionHundred()),
					).toEqual(booleanTrue())

					expect(
						fraction.isNot(fractionHundred(), fractionOneHalf()),
					).toEqual(booleanTrue())

					expect(
						fraction.isNot(fractionHundred(), fractionOne()),
					).toEqual(booleanTrue())

					expect(
						fraction.isNot(fractionHundred(), fractionTwo()),
					).toEqual(booleanTrue())
				})

				it("returns false if the fractions are the same", () => {
					expect(
						fraction.isNot(fractionOneHalf(), fractionOneHalf()),
					).toEqual(booleanFalse())

					expect(
						fraction.isNot(fractionOne(), fractionOne()),
					).toEqual(booleanFalse())

					expect(
						fraction.isNot(fractionTwo(), fractionTwo()),
					).toEqual(booleanFalse())

					expect(
						fraction.isNot(fractionHundred(), fractionHundred()),
					).toEqual(booleanFalse())
				})
			})

			describe("add", () => {
				it("adds 2 fractions correctly", () => {
					expect(
						fraction.add__overload$1(
							fractionOneHalf(),
							fractionOneHalf(),
						),
					).toEqual(fraction.createFraction(4n, 4n))

					expect(
						fraction.add__overload$1(
							fractionHundred(),
							fractionOne(),
						),
					).toEqual(fraction.createFraction(101n, 1n))

					expect(
						fraction.add__overload$1(
							fractionOne(),
							fractionHundred(),
						),
					).toEqual(fraction.createFraction(101n, 1n))
				})

				it("adds a fraction and an integer correctly", () => {
					expect(
						fraction.add__overload$2(
							fractionOneHalf(),
							integerOne(),
						),
					).toEqual(fraction.createFraction(3n, 2n))

					expect(
						fraction.add__overload$2(
							fractionOneHalf(),
							integerHundred(),
						),
					).toEqual(fraction.createFraction(201n, 2n))

					expect(
						fraction.add__overload$2(
							fraction.createFraction(-1n, 2n),
							integerOne(),
						),
					).toEqual(fractionOneHalf())
				})
			})

			describe("subtract", () => {
				it("subtract 2 fractions correctly", () => {
					expect(
						fraction.subtract__overload$1(
							fractionTwo(),
							fractionOne(),
						),
					).toEqual(fractionOne())

					expect(
						fraction.subtract__overload$1(
							fraction.createFraction(100n, 1n),
							fractionOne(),
						),
					).toEqual(fraction.createFraction(99n, 1n))

					expect(
						fraction.subtract__overload$1(
							fractionOne(),
							fractionHundred(),
						),
					).toEqual(fraction.createFraction(-99n, 1n))
				})

				it("subtracts an integer from a fraction correctly", () => {
					expect(
						fraction.subtract__overload$2(
							fractionTwo(),
							integerOne(),
						),
					).toEqual(fractionOne())

					expect(
						fraction.subtract__overload$2(
							fractionHundred(),
							integerOne(),
						),
					).toEqual(fraction.createFraction(99n, 1n))
				})
			})

			describe("multiply", () => {
				it("multiplies 2 fractions correctly", () => {
					expect(
						fraction.multiplyWith__overload$1(
							fractionOne(),
							fractionOne(),
						),
					).toEqual(fractionOne())

					expect(
						fraction.multiplyWith__overload$1(
							fractionHundred(),
							fractionOne(),
						),
					).toEqual(fractionHundred())

					expect(
						fraction.multiplyWith__overload$1(
							fractionTwo(),
							fractionTwo(),
						),
					).toEqual(fraction.createFraction(4n, 1n))

					expect(
						fraction.multiplyWith__overload$1(
							fractionTwo(),
							fractionHundred(),
						),
					).toEqual(fraction.createFraction(200n, 1n))
				})

				it("multiplies a fraction and an integer correctly", () => {
					expect(
						fraction.multiplyWith__overload$2(
							fractionOneHalf(),
							integerOne(),
						),
					).toEqual(fractionOneHalf())

					// NOTE: Fractions are not automatically reduced, so we need to compare against the common demoninator
					expect(
						fraction.multiplyWith__overload$2(
							fractionOneHalf(),
							integerHundred(),
						),
					).toEqual(fraction.createFraction(100n, 2n))

					// NOTE: Fractions are not automatically reduced, so we need to compare against the common demoninator
					expect(
						fraction.multiplyWith__overload$2(
							fractionOneHalf(),
							integerTwo(),
						),
					).toEqual(fraction.createFraction(2n, 2n))

					expect(
						fraction.multiplyWith__overload$2(
							fraction.createFraction(50n, 1n),
							integerTwo(),
						),
					).toEqual(fraction.createFraction(100n, 1n))
				})
			})

			describe("divide", () => {
				it("divides 2 fractions correctly", () => {
					expect(
						fraction.divideBy__overload$1(
							fractionOne(),
							fractionOne(),
						),
					).toEqual(fraction.createFraction(1n, 1n))

					expect(
						fraction.divideBy__overload$1(
							fractionOne(),
							fractionTwo(),
						),
					).toEqual(fraction.createFraction(1n, 2n))

					expect(
						fraction.divideBy__overload$1(
							fractionOne(),
							fractionOneHalf(),
						),
					).toEqual(fraction.createFraction(2n, 1n))

					expect(
						fraction.divideBy__overload$1(
							fractionHundred(),
							fractionTwo(),
						),
					).toEqual(fraction.createFraction(100n, 2n))
				})

				it("divides a fraction and an integer correctly", () => {
					expect(
						fraction.divideBy__overload$2(
							fractionOne(),
							integerOne(),
						),
					).toEqual(fractionOne())

					expect(
						fraction.divideBy__overload$2(
							fraction.createFraction(2n, 1n),
							integerTwo(),
						),
					).toEqual(fraction.createFraction(2n, 2n))

					expect(
						fraction.divideBy__overload$2(
							fractionHundred(),
							integerTwo(),
						),
					).toEqual(fraction.createFraction(100n, 2n))
				})
			})

			describe("isLessThan", () => {
				it("returns true if the first number is less than the second", () => {
					expect(
						fraction.isLessThan__overload$1(
							fractionOneHalf(),
							fractionOne(),
						),
					).toEqual(booleanTrue())

					expect(
						fraction.isLessThan__overload$1(
							fractionOneHalf(),
							fractionTwo(),
						),
					).toEqual(booleanTrue())

					expect(
						fraction.isLessThan__overload$1(
							fractionOneHalf(),
							fractionHundred(),
						),
					).toEqual(booleanTrue())

					expect(
						fraction.isLessThan__overload$1(
							fractionOne(),
							fractionTwo(),
						),
					).toEqual(booleanTrue())

					expect(
						fraction.isLessThan__overload$1(
							fractionOne(),
							fractionHundred(),
						),
					).toEqual(booleanTrue())

					expect(
						fraction.isLessThan__overload$1(
							fractionTwo(),
							fractionHundred(),
						),
					).toEqual(booleanTrue())

					expect(
						fraction.isLessThan__overload$2(
							fractionOneHalf(),
							integerOne(),
						),
					).toEqual(booleanTrue())

					expect(
						fraction.isLessThan__overload$2(
							fractionOneHalf(),
							integerTwo(),
						),
					).toEqual(booleanTrue())

					expect(
						fraction.isLessThan__overload$2(
							fractionOneHalf(),
							integerHundred(),
						),
					).toEqual(booleanTrue())

					expect(
						fraction.isLessThan__overload$2(
							fractionOne(),
							integerTwo(),
						),
					).toEqual(booleanTrue())

					expect(
						fraction.isLessThan__overload$2(
							fractionOne(),
							integerHundred(),
						),
					).toEqual(booleanTrue())

					expect(
						fraction.isLessThan__overload$2(
							fractionTwo(),
							integerHundred(),
						),
					).toEqual(booleanTrue())
				})

				it("returns false if the numbers are equal", () => {
					expect(
						fraction.isLessThan__overload$1(
							fractionOneHalf(),
							fractionOneHalf(),
						),
					).toEqual(booleanFalse())

					expect(
						fraction.isLessThan__overload$1(
							fractionOne(),
							fractionOne(),
						),
					).toEqual(booleanFalse())

					expect(
						fraction.isLessThan__overload$1(
							fractionTwo(),
							fractionTwo(),
						),
					).toEqual(booleanFalse())

					expect(
						fraction.isLessThan__overload$1(
							fractionHundred(),
							fractionHundred(),
						),
					).toEqual(booleanFalse())

					expect(
						fraction.isLessThan__overload$2(
							fractionOne(),
							integerOne(),
						),
					).toEqual(booleanFalse())

					expect(
						fraction.isLessThan__overload$2(
							fractionTwo(),
							integerTwo(),
						),
					).toEqual(booleanFalse())

					expect(
						fraction.isLessThan__overload$2(
							fractionHundred(),
							integerHundred(),
						),
					).toEqual(booleanFalse())
				})

				it("returns false if the first number is bigger than the second", () => {
					expect(
						fraction.isLessThan__overload$1(
							fractionHundred(),
							fractionTwo(),
						),
					).toEqual(booleanFalse())

					expect(
						fraction.isLessThan__overload$1(
							fractionHundred(),
							fractionOne(),
						),
					).toEqual(booleanFalse())

					expect(
						fraction.isLessThan__overload$1(
							fractionHundred(),
							fractionOneHalf(),
						),
					).toEqual(booleanFalse())

					expect(
						fraction.isLessThan__overload$1(
							fractionTwo(),
							fractionOne(),
						),
					).toEqual(booleanFalse())

					expect(
						fraction.isLessThan__overload$1(
							fractionTwo(),
							fractionOneHalf(),
						),
					).toEqual(booleanFalse())

					expect(
						fraction.isLessThan__overload$1(
							fractionOne(),
							fractionOneHalf(),
						),
					).toEqual(booleanFalse())

					expect(
						fraction.isLessThan__overload$2(
							fractionOne(),
							integerZero(),
						),
					).toEqual(booleanFalse())

					expect(
						fraction.isLessThan__overload$2(
							fractionTwo(),
							integerZero(),
						),
					).toEqual(booleanFalse())

					expect(
						fraction.isLessThan__overload$2(
							fractionTwo(),
							integerOne(),
						),
					).toEqual(booleanFalse())

					expect(
						fraction.isLessThan__overload$2(
							fractionHundred(),
							integerZero(),
						),
					).toEqual(booleanFalse())

					expect(
						fraction.isLessThan__overload$2(
							fractionHundred(),
							integerOne(),
						),
					).toEqual(booleanFalse())

					expect(
						fraction.isLessThan__overload$2(
							fractionHundred(),
							integerTwo(),
						),
					).toEqual(booleanFalse())
				})
			})

			describe("isLessThanOrEqualTo", () => {
				it("returns true if the first number is less than the second", () => {
					expect(
						fraction.isLessThanOrEqualTo__overload$1(
							fractionOneHalf(),
							fractionOne(),
						),
					).toEqual(booleanTrue())

					expect(
						fraction.isLessThanOrEqualTo__overload$1(
							fractionOneHalf(),
							fractionTwo(),
						),
					).toEqual(booleanTrue())

					expect(
						fraction.isLessThanOrEqualTo__overload$1(
							fractionOneHalf(),
							fractionHundred(),
						),
					).toEqual(booleanTrue())

					expect(
						fraction.isLessThanOrEqualTo__overload$1(
							fractionOne(),
							fractionTwo(),
						),
					).toEqual(booleanTrue())

					expect(
						fraction.isLessThanOrEqualTo__overload$1(
							fractionOne(),
							fractionHundred(),
						),
					).toEqual(booleanTrue())

					expect(
						fraction.isLessThanOrEqualTo__overload$1(
							fractionTwo(),
							fractionHundred(),
						),
					).toEqual(booleanTrue())

					expect(
						fraction.isLessThanOrEqualTo__overload$2(
							fractionOneHalf(),
							integerOne(),
						),
					).toEqual(booleanTrue())

					expect(
						fraction.isLessThanOrEqualTo__overload$2(
							fractionOneHalf(),
							integerTwo(),
						),
					).toEqual(booleanTrue())

					expect(
						fraction.isLessThanOrEqualTo__overload$2(
							fractionOneHalf(),
							integerHundred(),
						),
					).toEqual(booleanTrue())

					expect(
						fraction.isLessThanOrEqualTo__overload$2(
							fractionOne(),
							integerTwo(),
						),
					).toEqual(booleanTrue())

					expect(
						fraction.isLessThanOrEqualTo__overload$2(
							fractionOne(),
							integerHundred(),
						),
					).toEqual(booleanTrue())

					expect(
						fraction.isLessThanOrEqualTo__overload$2(
							fractionTwo(),
							integerHundred(),
						),
					).toEqual(booleanTrue())
				})

				it("returns true if the numbers are equal", () => {
					expect(
						fraction.isLessThanOrEqualTo__overload$1(
							fractionOneHalf(),
							fractionOneHalf(),
						),
					).toEqual(booleanTrue())

					expect(
						fraction.isLessThanOrEqualTo__overload$1(
							fractionOne(),
							fractionOne(),
						),
					).toEqual(booleanTrue())

					expect(
						fraction.isLessThanOrEqualTo__overload$1(
							fractionTwo(),
							fractionTwo(),
						),
					).toEqual(booleanTrue())

					expect(
						fraction.isLessThanOrEqualTo__overload$1(
							fractionHundred(),
							fractionHundred(),
						),
					).toEqual(booleanTrue())

					expect(
						fraction.isLessThanOrEqualTo__overload$2(
							fractionOne(),
							integerOne(),
						),
					).toEqual(booleanTrue())

					expect(
						fraction.isLessThanOrEqualTo__overload$2(
							fractionTwo(),
							integerTwo(),
						),
					).toEqual(booleanTrue())

					expect(
						fraction.isLessThanOrEqualTo__overload$2(
							fractionHundred(),
							integerHundred(),
						),
					).toEqual(booleanTrue())
				})

				it("returns false if the first number is bigger than the second", () => {
					expect(
						fraction.isLessThanOrEqualTo__overload$1(
							fractionHundred(),
							fractionTwo(),
						),
					).toEqual(booleanFalse())

					expect(
						fraction.isLessThanOrEqualTo__overload$1(
							fractionHundred(),
							fractionOne(),
						),
					).toEqual(booleanFalse())

					expect(
						fraction.isLessThanOrEqualTo__overload$1(
							fractionHundred(),
							fractionOneHalf(),
						),
					).toEqual(booleanFalse())

					expect(
						fraction.isLessThanOrEqualTo__overload$1(
							fractionTwo(),
							fractionOne(),
						),
					).toEqual(booleanFalse())

					expect(
						fraction.isLessThanOrEqualTo__overload$1(
							fractionTwo(),
							fractionOneHalf(),
						),
					).toEqual(booleanFalse())

					expect(
						fraction.isLessThanOrEqualTo__overload$1(
							fractionOne(),
							fractionOneHalf(),
						),
					).toEqual(booleanFalse())

					expect(
						fraction.isLessThanOrEqualTo__overload$2(
							fractionOneHalf(),
							integerZero(),
						),
					).toEqual(booleanFalse())

					expect(
						fraction.isLessThanOrEqualTo__overload$2(
							fractionOne(),
							integerZero(),
						),
					).toEqual(booleanFalse())

					expect(
						fraction.isLessThanOrEqualTo__overload$2(
							fractionTwo(),
							integerOne(),
						),
					).toEqual(booleanFalse())

					expect(
						fraction.isLessThanOrEqualTo__overload$2(
							fractionHundred(),
							integerZero(),
						),
					).toEqual(booleanFalse())

					expect(
						fraction.isLessThanOrEqualTo__overload$2(
							fractionHundred(),
							integerOne(),
						),
					).toEqual(booleanFalse())

					expect(
						fraction.isLessThanOrEqualTo__overload$2(
							fractionHundred(),
							integerTwo(),
						),
					).toEqual(booleanFalse())
				})
			})

			describe("isGreaterThan", () => {
				it("returns false if the first number is less than the second", () => {
					expect(
						fraction.isGreaterThan__overload$1(
							fractionOneHalf(),
							fractionOne(),
						),
					).toEqual(booleanFalse())

					expect(
						fraction.isGreaterThan__overload$1(
							fractionOneHalf(),
							fractionTwo(),
						),
					).toEqual(booleanFalse())

					expect(
						fraction.isGreaterThan__overload$1(
							fractionOneHalf(),
							fractionHundred(),
						),
					).toEqual(booleanFalse())

					expect(
						fraction.isGreaterThan__overload$1(
							fractionOne(),
							fractionTwo(),
						),
					).toEqual(booleanFalse())

					expect(
						fraction.isGreaterThan__overload$1(
							fractionOne(),
							fractionHundred(),
						),
					).toEqual(booleanFalse())

					expect(
						fraction.isGreaterThan__overload$1(
							fractionTwo(),
							fractionHundred(),
						),
					).toEqual(booleanFalse())

					expect(
						fraction.isGreaterThan__overload$2(
							fractionOneHalf(),
							integerOne(),
						),
					).toEqual(booleanFalse())

					expect(
						fraction.isGreaterThan__overload$2(
							fractionOneHalf(),
							integerTwo(),
						),
					).toEqual(booleanFalse())

					expect(
						fraction.isGreaterThan__overload$2(
							fractionOneHalf(),
							integerHundred(),
						),
					).toEqual(booleanFalse())

					expect(
						fraction.isGreaterThan__overload$2(
							fractionOne(),
							integerTwo(),
						),
					).toEqual(booleanFalse())

					expect(
						fraction.isGreaterThan__overload$2(
							fractionOne(),
							integerHundred(),
						),
					).toEqual(booleanFalse())

					expect(
						fraction.isGreaterThan__overload$2(
							fractionTwo(),
							integerHundred(),
						),
					).toEqual(booleanFalse())
				})

				it("returns false if the numbers are equal", () => {
					expect(
						fraction.isGreaterThan__overload$1(
							fractionOneHalf(),
							fractionOneHalf(),
						),
					).toEqual(booleanFalse())

					expect(
						fraction.isGreaterThan__overload$1(
							fractionOne(),
							fractionOne(),
						),
					).toEqual(booleanFalse())

					expect(
						fraction.isGreaterThan__overload$1(
							fractionTwo(),
							fractionTwo(),
						),
					).toEqual(booleanFalse())

					expect(
						fraction.isGreaterThan__overload$1(
							fractionHundred(),
							fractionHundred(),
						),
					).toEqual(booleanFalse())

					expect(
						fraction.isGreaterThan__overload$2(
							fractionOne(),
							integerOne(),
						),
					).toEqual(booleanFalse())

					expect(
						fraction.isGreaterThan__overload$2(
							fractionTwo(),
							integerTwo(),
						),
					).toEqual(booleanFalse())

					expect(
						fraction.isGreaterThan__overload$2(
							fractionHundred(),
							integerHundred(),
						),
					).toEqual(booleanFalse())
				})

				it("returns true if the first number is bigger than the second", () => {
					expect(
						fraction.isGreaterThan__overload$1(
							fractionHundred(),
							fractionTwo(),
						),
					).toEqual(booleanTrue())

					expect(
						fraction.isGreaterThan__overload$1(
							fractionHundred(),
							fractionOne(),
						),
					).toEqual(booleanTrue())

					expect(
						fraction.isGreaterThan__overload$1(
							fractionHundred(),
							fractionOneHalf(),
						),
					).toEqual(booleanTrue())

					expect(
						fraction.isGreaterThan__overload$1(
							fractionTwo(),
							fractionOne(),
						),
					).toEqual(booleanTrue())

					expect(
						fraction.isGreaterThan__overload$1(
							fractionTwo(),
							fractionOneHalf(),
						),
					).toEqual(booleanTrue())

					expect(
						fraction.isGreaterThan__overload$1(
							fractionOne(),
							fractionOneHalf(),
						),
					).toEqual(booleanTrue())

					expect(
						fraction.isGreaterThan__overload$2(
							fractionOneHalf(),
							integerZero(),
						),
					).toEqual(booleanTrue())

					expect(
						fraction.isGreaterThan__overload$2(
							fractionOne(),
							integerZero(),
						),
					).toEqual(booleanTrue())

					expect(
						fraction.isGreaterThan__overload$2(
							fractionTwo(),
							integerZero(),
						),
					).toEqual(booleanTrue())

					expect(
						fraction.isGreaterThan__overload$2(
							fractionTwo(),
							integerOne(),
						),
					).toEqual(booleanTrue())

					expect(
						fraction.isGreaterThan__overload$2(
							fractionHundred(),
							integerZero(),
						),
					).toEqual(booleanTrue())

					expect(
						fraction.isGreaterThan__overload$2(
							fractionHundred(),
							integerOne(),
						),
					).toEqual(booleanTrue())

					expect(
						fraction.isGreaterThan__overload$2(
							fractionHundred(),
							integerTwo(),
						),
					).toEqual(booleanTrue())
				})
			})

			describe("isGreaterThanOrEqualTo", () => {
				it("returns false if the first number is less than the second", () => {
					expect(
						fraction.isGreaterThanOrEqualTo__overload$1(
							fractionOneHalf(),
							fractionOne(),
						),
					).toEqual(booleanFalse())

					expect(
						fraction.isGreaterThanOrEqualTo__overload$1(
							fractionOneHalf(),
							fractionTwo(),
						),
					).toEqual(booleanFalse())

					expect(
						fraction.isGreaterThanOrEqualTo__overload$1(
							fractionOneHalf(),
							fractionHundred(),
						),
					).toEqual(booleanFalse())

					expect(
						fraction.isGreaterThanOrEqualTo__overload$1(
							fractionOne(),
							fractionTwo(),
						),
					).toEqual(booleanFalse())

					expect(
						fraction.isGreaterThanOrEqualTo__overload$1(
							fractionOne(),
							fractionHundred(),
						),
					).toEqual(booleanFalse())

					expect(
						fraction.isGreaterThanOrEqualTo__overload$1(
							fractionTwo(),
							fractionHundred(),
						),
					).toEqual(booleanFalse())

					expect(
						fraction.isGreaterThanOrEqualTo__overload$2(
							fractionOneHalf(),
							integerOne(),
						),
					).toEqual(booleanFalse())

					expect(
						fraction.isGreaterThanOrEqualTo__overload$2(
							fractionOneHalf(),
							integerTwo(),
						),
					).toEqual(booleanFalse())

					expect(
						fraction.isGreaterThanOrEqualTo__overload$2(
							fractionOneHalf(),
							integerHundred(),
						),
					).toEqual(booleanFalse())

					expect(
						fraction.isGreaterThanOrEqualTo__overload$2(
							fractionOne(),
							integerTwo(),
						),
					).toEqual(booleanFalse())

					expect(
						fraction.isGreaterThanOrEqualTo__overload$2(
							fractionOne(),
							integerHundred(),
						),
					).toEqual(booleanFalse())

					expect(
						fraction.isGreaterThanOrEqualTo__overload$2(
							fractionTwo(),
							integerHundred(),
						),
					).toEqual(booleanFalse())
				})

				it("returns true if the numbers are equal", () => {
					expect(
						fraction.isGreaterThanOrEqualTo__overload$1(
							fractionOneHalf(),
							fractionOneHalf(),
						),
					).toEqual(booleanTrue())

					expect(
						fraction.isGreaterThanOrEqualTo__overload$1(
							fractionOne(),
							fractionOne(),
						),
					).toEqual(booleanTrue())

					expect(
						fraction.isGreaterThanOrEqualTo__overload$1(
							fractionTwo(),
							fractionTwo(),
						),
					).toEqual(booleanTrue())

					expect(
						fraction.isGreaterThanOrEqualTo__overload$1(
							fractionHundred(),
							fractionHundred(),
						),
					).toEqual(booleanTrue())

					expect(
						fraction.isGreaterThanOrEqualTo__overload$2(
							fractionOne(),
							integerOne(),
						),
					).toEqual(booleanTrue())

					expect(
						fraction.isGreaterThanOrEqualTo__overload$2(
							fractionTwo(),
							integerTwo(),
						),
					).toEqual(booleanTrue())

					expect(
						fraction.isGreaterThanOrEqualTo__overload$2(
							fractionHundred(),
							integerHundred(),
						),
					).toEqual(booleanTrue())
				})

				it("returns true if the first number is bigger than the second", () => {
					expect(
						fraction.isGreaterThanOrEqualTo__overload$1(
							fractionHundred(),
							fractionTwo(),
						),
					).toEqual(booleanTrue())

					expect(
						fraction.isGreaterThanOrEqualTo__overload$1(
							fractionHundred(),
							fractionOne(),
						),
					).toEqual(booleanTrue())

					expect(
						fraction.isGreaterThanOrEqualTo__overload$1(
							fractionHundred(),
							fractionOneHalf(),
						),
					).toEqual(booleanTrue())

					expect(
						fraction.isGreaterThanOrEqualTo__overload$1(
							fractionTwo(),
							fractionOne(),
						),
					).toEqual(booleanTrue())

					expect(
						fraction.isGreaterThanOrEqualTo__overload$1(
							fractionTwo(),
							fractionOneHalf(),
						),
					).toEqual(booleanTrue())

					expect(
						fraction.isGreaterThanOrEqualTo__overload$1(
							fractionOne(),
							fractionOneHalf(),
						),
					).toEqual(booleanTrue())

					expect(
						fraction.isGreaterThanOrEqualTo__overload$2(
							fractionOneHalf(),
							integerZero(),
						),
					).toEqual(booleanTrue())

					expect(
						fraction.isGreaterThanOrEqualTo__overload$2(
							fractionOne(),
							integerZero(),
						),
					).toEqual(booleanTrue())

					expect(
						fraction.isGreaterThanOrEqualTo__overload$2(
							fractionTwo(),
							integerZero(),
						),
					).toEqual(booleanTrue())

					expect(
						fraction.isGreaterThanOrEqualTo__overload$2(
							fractionTwo(),
							integerOne(),
						),
					).toEqual(booleanTrue())

					expect(
						fraction.isGreaterThanOrEqualTo__overload$2(
							fractionHundred(),
							integerZero(),
						),
					).toEqual(booleanTrue())

					expect(
						fraction.isGreaterThanOrEqualTo__overload$2(
							fractionHundred(),
							integerOne(),
						),
					).toEqual(booleanTrue())

					expect(
						fraction.isGreaterThanOrEqualTo__overload$2(
							fractionHundred(),
							integerTwo(),
						),
					).toEqual(booleanTrue())
				})
			})

			describe("toString", () => {
				it("returns the correct strings", () => {
					expect(
						fraction.toString__overload$1(fractionOneHalf()),
					).toEqual(string.createString("1/2"))

					expect(
						fraction.toString__overload$2(
							fractionOneHalf(),
							string.createString("fraction"),
						),
					).toEqual(string.createString("1/2"))

					expect(
						fraction.toString__overload$2(
							fractionOneHalf(),
							string.createString("decimal"),
						),
					).toEqual(string.createString("0.5"))
				})
			})
		})

		describe("Number", () => {
			describe("lowestNumber", () => {
				it("returns the smaller of 2 integers", () => {
					expect(
						number.lowestNumber__overload$1(
							integerOne(),
							integerTwo(),
						),
					).toEqual(integerOne())

					expect(
						number.lowestNumber__overload$1(
							integerTwo(),
							integerOne(),
						),
					).toEqual(integerOne())

					expect(
						number.lowestNumber__overload$1(
							integerHundred(),
							integerTwo(),
						),
					).toEqual(integerTwo())

					expect(
						number.lowestNumber__overload$1(
							integer.createInteger(-2n),
							integerTwo(),
						),
					).toEqual(integer.createInteger(-2n))
				})

				it("returns the smaller of 2 fractions", () => {
					expect(
						number.lowestNumber__overload$2(
							fractionOne(),
							fractionTwo(),
						),
					).toEqual(fractionOne())

					expect(
						number.lowestNumber__overload$2(
							fractionTwo(),
							fractionOne(),
						),
					).toEqual(fractionOne())

					expect(
						number.lowestNumber__overload$2(
							fractionHundred(),
							fractionTwo(),
						),
					).toEqual(fractionTwo())

					expect(
						number.lowestNumber__overload$2(
							fractionOne(),
							fractionOneHalf(),
						),
					).toEqual(fractionOneHalf())

					expect(
						number.lowestNumber__overload$2(
							fraction.createFraction(-1n, 1n),
							fractionOne(),
						),
					).toEqual(fraction.createFraction(-1n, 1n))
				})

				it("returns the smaller number of an integer and a fraction", () => {
					expect(
						number.lowestNumber__overload$3(
							integerOne(),
							fractionTwo(),
						),
					).toEqual(integerOne())

					expect(
						number.lowestNumber__overload$3(
							integerTwo(),
							fractionOne(),
						),
					).toEqual(fractionOne())

					expect(
						number.lowestNumber__overload$3(
							integerHundred(),
							fractionTwo(),
						),
					).toEqual(fractionTwo())

					expect(
						number.lowestNumber__overload$3(
							integerOne(),
							fractionOneHalf(),
						),
					).toEqual(fractionOneHalf())

					expect(
						number.lowestNumber__overload$3(
							integer.createInteger(-1n),
							fractionOne(),
						),
					).toEqual(integer.createInteger(-1n))

					expect(
						number.lowestNumber__overload$4(
							fractionOne(),
							integerTwo(),
						),
					).toEqual(fractionOne())

					expect(
						number.lowestNumber__overload$4(
							fractionTwo(),
							integerOne(),
						),
					).toEqual(integerOne())

					expect(
						number.lowestNumber__overload$4(
							fractionHundred(),
							integerTwo(),
						),
					).toEqual(integerTwo())

					expect(
						number.lowestNumber__overload$4(
							fractionOneHalf(),
							integerOne(),
						),
					).toEqual(fractionOneHalf())

					expect(
						number.lowestNumber__overload$4(
							fraction.createFraction(-1n, 1n),
							integerOne(),
						),
					).toEqual(fraction.createFraction(-1n, 1n))
				})

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
								fractionOne(),
								fractionTwo(),
								fractionHundred(),
							]),
						),
					).toEqual(fractionOne())

					expect(
						number.lowestNumber__overload$6(
							list.createList([
								fractionTwo(),
								fractionOne(),
								fractionHundred(),
							]),
						),
					).toEqual(fractionOne())

					expect(
						number.lowestNumber__overload$6(
							list.createList([
								fractionHundred(),
								fractionTwo(),
								fractionOne(),
							]),
						),
					).toEqual(fractionOne())

					expect(
						number.lowestNumber__overload$6(
							list.createList([
								fractionHundred(),
								fractionTwo(),
								fractionOneHalf(),
								fractionOne(),
							]),
						),
					).toEqual(fractionOneHalf())

					expect(
						number.lowestNumber__overload$7(
							list.createList([
								integerOne(),
								fractionTwo(),
								integerHundred(),
							]),
						),
					).toEqual(integerOne())

					expect(
						number.lowestNumber__overload$7(
							list.createList([
								integerTwo(),
								fractionOne(),
								integerHundred(),
							]),
						),
					).toEqual(fractionOne())

					expect(
						number.lowestNumber__overload$7(
							list.createList([
								fractionHundred(),
								integerTwo(),
								integerOne(),
							]),
						),
					).toEqual(integerOne())

					expect(
						number.lowestNumber__overload$7(
							list.createList([
								integerHundred(),
								fractionOne(),
								fractionOneHalf(),
								integerOne(),
							]),
						),
					).toEqual(fractionOneHalf())
				})
			})

			describe("greatestNumber", () => {
				it("returns the larger of 2 integers", () => {
					expect(
						number.greatestNumber__overload$1(
							integerOne(),
							integerTwo(),
						),
					).toEqual(integerTwo())

					expect(
						number.greatestNumber__overload$1(
							integerTwo(),
							integerOne(),
						),
					).toEqual(integerTwo())

					expect(
						number.greatestNumber__overload$1(
							integerHundred(),
							integerTwo(),
						),
					).toEqual(integerHundred())

					expect(
						number.greatestNumber__overload$1(
							integer.createInteger(-2n),
							integerTwo(),
						),
					).toEqual(integerTwo())
				})

				it("returns the larger of 2 fractions", () => {
					expect(
						number.greatestNumber__overload$2(
							fractionOne(),
							fractionTwo(),
						),
					).toEqual(fractionTwo())

					expect(
						number.greatestNumber__overload$2(
							fractionTwo(),
							fractionOne(),
						),
					).toEqual(fractionTwo())

					expect(
						number.greatestNumber__overload$2(
							fractionHundred(),
							fractionTwo(),
						),
					).toEqual(fractionHundred())

					expect(
						number.greatestNumber__overload$2(
							fractionOne(),
							fractionOneHalf(),
						),
					).toEqual(fractionOne())

					expect(
						number.greatestNumber__overload$2(
							fraction.createFraction(-1n, 1n),
							fractionOne(),
						),
					).toEqual(fractionOne())
				})

				it("returns the larger number of an integer and a fraction", () => {
					expect(
						number.greatestNumber__overload$3(
							integerOne(),
							fractionTwo(),
						),
					).toEqual(fractionTwo())

					expect(
						number.greatestNumber__overload$3(
							integerTwo(),
							fractionOne(),
						),
					).toEqual(integerTwo())

					expect(
						number.greatestNumber__overload$3(
							integerHundred(),
							fractionTwo(),
						),
					).toEqual(integerHundred())

					expect(
						number.greatestNumber__overload$3(
							integerOne(),
							fractionOneHalf(),
						),
					).toEqual(integerOne())

					expect(
						number.greatestNumber__overload$3(
							integer.createInteger(-1n),
							fractionOne(),
						),
					).toEqual(fractionOne())

					expect(
						number.greatestNumber__overload$4(
							fractionOne(),
							integerTwo(),
						),
					).toEqual(integerTwo())

					expect(
						number.greatestNumber__overload$4(
							fractionTwo(),
							integerOne(),
						),
					).toEqual(fractionTwo())

					expect(
						number.greatestNumber__overload$4(
							fractionHundred(),
							integerTwo(),
						),
					).toEqual(fractionHundred())

					expect(
						number.greatestNumber__overload$4(
							fractionOneHalf(),
							integerOne(),
						),
					).toEqual(integerOne())

					expect(
						number.greatestNumber__overload$4(
							fraction.createFraction(-1n, 1n),
							integerOne(),
						),
					).toEqual(integerOne())
				})

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
								fractionOne(),
								fractionTwo(),
								fractionHundred(),
							]),
						),
					).toEqual(fractionHundred())

					expect(
						number.greatestNumber__overload$6(
							list.createList([
								fractionTwo(),
								fractionOne(),
								fractionHundred(),
							]),
						),
					).toEqual(fractionHundred())

					expect(
						number.greatestNumber__overload$6(
							list.createList([
								fractionHundred(),
								fractionTwo(),
								fractionOne(),
							]),
						),
					).toEqual(fractionHundred())

					expect(
						number.greatestNumber__overload$6(
							list.createList([
								fractionHundred(),
								fractionTwo(),
								fractionOneHalf(),
								fractionOne(),
							]),
						),
					).toEqual(fractionHundred())

					expect(
						number.greatestNumber__overload$7(
							list.createList([
								integerOne(),
								fractionTwo(),
								integerHundred(),
							]),
						),
					).toEqual(integerHundred())

					expect(
						number.greatestNumber__overload$7(
							list.createList([
								integerTwo(),
								fractionOne(),
								integerHundred(),
							]),
						),
					).toEqual(integerHundred())

					expect(
						number.greatestNumber__overload$7(
							list.createList([
								fractionHundred(),
								integerTwo(),
								integerOne(),
							]),
						),
					).toEqual(fractionHundred())

					expect(
						number.greatestNumber__overload$7(
							list.createList([
								fractionOneHalf(),
								fractionOne(),
								integerHundred(),
								integerOne(),
							]),
						),
					).toEqual(integerHundred())
				})
			})
		})

		describe("List", () => {
			describe("is", () => {
				it("returns true if the lists have the same items in the same order", () => {
					expect(list.is(listEmpty(), listEmpty())).toEqual(
						booleanTrue(),
					)

					expect(
						list.is(
							list.createList([integerOne()]),
							list.createList([integerOne()]),
						),
					).toEqual(booleanTrue())

					expect(
						list.is(
							list.createList([integerOne(), integerTwo()]),
							list.createList([integerOne(), integerTwo()]),
						),
					).toEqual(booleanTrue())

					expect(
						list.is(
							list.createList([stringEmpty()]),
							list.createList([stringEmpty()]),
						),
					).toEqual(booleanTrue())

					expect(
						list.is(
							list.createList([fractionOne()]),
							list.createList([fractionOne()]),
						),
					).toEqual(booleanTrue())

					expect(
						list.is(
							list.createList([
								stringEmpty(),
								integerOne(),
								fractionHundred(),
								nothing(),
								booleanFalse(),
							]),
							list.createList([
								stringEmpty(),
								integerOne(),
								fractionHundred(),
								nothing(),
								booleanFalse(),
							]),
						),
					).toEqual(booleanTrue())
				})

				it("returns false if the lists have the same items in a different order", () => {
					expect(
						list.is(
							list.createList([integerOne(), integerTwo()]),
							list.createList([integerTwo(), integerOne()]),
						),
					).toEqual(booleanFalse())

					expect(
						list.is(
							list.createList([
								stringEmpty(),
								integerOne(),
								fractionHundred(),
								nothing(),
								booleanFalse(),
							]),
							list.createList([
								stringEmpty(),
								integerOne(),
								nothing(),
								fractionHundred(),
								booleanFalse(),
							]),
						),
					).toEqual(booleanFalse())
				})

				it("returns false if the lists do not have the same items", () => {
					expect(
						list.is(
							list.createList([integerOne()]),
							list.createList([integerTwo()]),
						),
					).toEqual(booleanFalse())

					expect(
						list.is(
							list.createList([integerOne(), integerTwo()]),
							list.createList([integerOne(), fractionTwo()]),
						),
					).toEqual(booleanFalse())

					expect(
						list.is(
							list.createList([stringEmpty()]),
							list.createList([string.createString("not empty")]),
						),
					).toEqual(booleanFalse())

					expect(
						list.is(
							list.createList([fractionOne()]),
							list.createList([fractionOneHalf()]),
						),
					).toEqual(booleanFalse())

					expect(
						list.is(
							list.createList([
								stringEmpty(),
								integerOne(),
								fractionHundred(),
								nothing(),
								booleanFalse(),
							]),
							list.createList([
								stringEmpty(),
								integerOne(),
								fractionHundred(),
								nothing(),
								booleanTrue(),
							]),
						),
					).toEqual(booleanFalse())
				})

				it("returns false if the lists are not the same length", () => {
					expect(
						list.is(listEmpty(), list.createList([integerTwo()])),
					).toEqual(booleanFalse())

					expect(
						list.is(list.createList([integerTwo()]), listEmpty()),
					).toEqual(booleanFalse())

					expect(
						list.is(
							list.createList([
								integerOne(),
								integerTwo(),
								integerHundred(),
							]),
							list.createList([integerOne(), fractionTwo()]),
						),
					).toEqual(booleanFalse())

					expect(
						list.is(
							list.createList([stringEmpty()]),
							list.createList([
								string.createString("not empty"),
								stringEmpty(),
							]),
						),
					).toEqual(booleanFalse())
				})
			})

			describe("isNot", () => {
				it("returns false if the lists have the same items in the same order", () => {
					expect(list.isNot(listEmpty(), listEmpty())).toEqual(
						booleanFalse(),
					)

					expect(
						list.isNot(
							list.createList([integerOne()]),
							list.createList([integerOne()]),
						),
					).toEqual(booleanFalse())

					expect(
						list.isNot(
							list.createList([integerOne(), integerTwo()]),
							list.createList([integerOne(), integerTwo()]),
						),
					).toEqual(booleanFalse())

					expect(
						list.isNot(
							list.createList([stringEmpty()]),
							list.createList([stringEmpty()]),
						),
					).toEqual(booleanFalse())

					expect(
						list.isNot(
							list.createList([fractionOne()]),
							list.createList([fractionOne()]),
						),
					).toEqual(booleanFalse())

					expect(
						list.isNot(
							list.createList([
								stringEmpty(),
								integerOne(),
								fractionHundred(),
								nothing(),
								booleanFalse(),
							]),
							list.createList([
								stringEmpty(),
								integerOne(),
								fractionHundred(),
								nothing(),
								booleanFalse(),
							]),
						),
					).toEqual(booleanFalse())
				})

				it("returns true if the lists have the same items in a different order", () => {
					expect(
						list.isNot(
							list.createList([integerOne(), integerTwo()]),
							list.createList([integerTwo(), integerOne()]),
						),
					).toEqual(booleanTrue())

					expect(
						list.isNot(
							list.createList([
								stringEmpty(),
								integerOne(),
								fractionHundred(),
								nothing(),
								booleanFalse(),
							]),
							list.createList([
								stringEmpty(),
								integerOne(),
								nothing(),
								fractionHundred(),
								booleanFalse(),
							]),
						),
					).toEqual(booleanTrue())
				})

				it("returns true if the lists do not have the same items", () => {
					expect(
						list.isNot(
							list.createList([integerOne()]),
							list.createList([integerTwo()]),
						),
					).toEqual(booleanTrue())

					expect(
						list.isNot(
							list.createList([integerOne(), integerTwo()]),
							list.createList([integerOne(), fractionTwo()]),
						),
					).toEqual(booleanTrue())

					expect(
						list.isNot(
							list.createList([stringEmpty()]),
							list.createList([string.createString("not empty")]),
						),
					).toEqual(booleanTrue())

					expect(
						list.isNot(
							list.createList([fractionOne()]),
							list.createList([fractionOneHalf()]),
						),
					).toEqual(booleanTrue())

					expect(
						list.isNot(
							list.createList([
								stringEmpty(),
								integerOne(),
								fractionHundred(),
								nothing(),
								booleanFalse(),
							]),
							list.createList([
								stringEmpty(),
								integerOne(),
								fractionHundred(),
								nothing(),
								booleanTrue(),
							]),
						),
					).toEqual(booleanTrue())
				})
			})

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
								fractionOneHalf(),
							]),
						),
					).toEqual(integer.createInteger(4n))
				})
			})

			describe("hasItems", () => {
				it("returns true when the list has items", () => {
					expect(
						list.hasItems(list.createList([integerOne()])),
					).toEqual(booleanTrue())

					expect(
						list.hasItems(
							list.createList([integerOne(), integerTwo()]),
						),
					).toEqual(booleanTrue())

					expect(
						list.hasItems(list.createList([stringEmpty()])),
					).toEqual(booleanTrue())

					expect(
						list.hasItems(list.createList([fractionOne()])),
					).toEqual(booleanTrue())

					expect(
						list.hasItems(list.createList([listEmpty()])),
					).toEqual(booleanTrue())
				})

				it("returns false when the list is empty", () => {
					expect(list.hasItems(listEmpty())).toEqual(booleanFalse())
				})
			})

			describe("isEmpty", () => {
				it("returns true if the list is empty", () => {
					expect(list.isEmpty(listEmpty())).toEqual(booleanTrue())
				})

				it("returns false if the list is not empty", () => {
					expect(
						list.isEmpty(list.createList([integerOne()])),
					).toEqual(booleanFalse())

					expect(
						list.isEmpty(list.createList([stringEmpty()])),
					).toEqual(booleanFalse())

					expect(
						list.isEmpty(list.createList([fractionOne()])),
					).toEqual(booleanFalse())

					expect(
						list.isEmpty(list.createList([booleanTrue()])),
					).toEqual(booleanFalse())

					expect(
						list.isEmpty(list.createList([booleanFalse()])),
					).toEqual(booleanFalse())

					expect(list.isEmpty(list.createList([nothing()]))).toEqual(
						booleanFalse(),
					)
				})
			})

			describe("contains", () => {
				it("returns true if the item is in the list", () => {
					const numbersList = list.createList([
						integerZero(),
						integerOne(),
						integerTwo(),
					])

					expect(list.contains(numbersList, integerOne())).toEqual(
						booleanTrue(),
					)

					expect(list.contains(numbersList, integerTwo())).toEqual(
						booleanTrue(),
					)

					expect(list.contains(numbersList, integerOne())).toEqual(
						booleanTrue(),
					)

					const stringList = list.createList([
						string.createString("a"),
						string.createString("b"),
						string.createString("c"),
					])

					expect(
						list.contains(stringList, string.createString("a")),
					).toEqual(booleanTrue())

					expect(
						list.contains(stringList, string.createString("b")),
					).toEqual(booleanTrue())

					expect(
						list.contains(stringList, string.createString("c")),
					).toEqual(booleanTrue())
				})

				it("returns false if the item is not in the list", () => {
					const numbersList = list.createList([
						integerZero(),
						integerOne(),
						integerTwo(),
					])

					expect(
						list.contains(numbersList, integerHundred()),
					).toEqual(booleanFalse())

					const stringList = list.createList([
						string.createString("a"),
						string.createString("b"),
						string.createString("c"),
					])

					expect(
						list.contains(stringList, string.createString("d")),
					).toEqual(booleanFalse())
				})

				it("returns false if the list is empty", () => {
					expect(
						list.contains(list.createList([]), integerOne()),
					).toEqual(booleanFalse())
				})
			})

			describe("doesNotContain", () => {
				it("returns false if the item is in the list", () => {
					const numbersList = list.createList([
						integerZero(),
						integerOne(),
						integerTwo(),
					])

					expect(
						list.doesNotContain(numbersList, integerOne()),
					).toEqual(booleanFalse())

					expect(
						list.doesNotContain(numbersList, integerTwo()),
					).toEqual(booleanFalse())

					expect(
						list.doesNotContain(numbersList, integerOne()),
					).toEqual(booleanFalse())

					const stringList = list.createList([
						string.createString("a"),
						string.createString("b"),
						string.createString("c"),
					])

					expect(
						list.doesNotContain(
							stringList,
							string.createString("a"),
						),
					).toEqual(booleanFalse())

					expect(
						list.doesNotContain(
							stringList,
							string.createString("b"),
						),
					).toEqual(booleanFalse())

					expect(
						list.doesNotContain(
							stringList,
							string.createString("c"),
						),
					).toEqual(booleanFalse())
				})

				it("returns true if the item is not in the list", () => {
					const numbersList = list.createList([
						integerZero(),
						integerOne(),
						integerTwo(),
					])

					expect(
						list.doesNotContain(numbersList, integerHundred()),
					).toEqual(booleanTrue())

					const stringList = list.createList([
						string.createString("a"),
						string.createString("b"),
						string.createString("c"),
					])

					expect(
						list.doesNotContain(
							stringList,
							string.createString("d"),
						),
					).toEqual(booleanTrue())
				})

				it("returns true if the list is empty", () => {
					expect(
						list.doesNotContain(list.createList([]), integerOne()),
					).toEqual(booleanTrue())
				})
			})

			describe("firstItem", () => {
				it("returns the firstItem item of the list if it is not empty", () => {
					expect(
						list.firstItem(list.createList([integerTwo()])),
					).toEqual(integerTwo())

					expect(
						list.firstItem(
							list.createList([integerTwo(), integerOne()]),
						),
					).toEqual(integerTwo())

					expect(
						list.firstItem(
							list.createList([
								integerTwo(),
								integerOne(),
								integerHundred(),
							]),
						),
					).toEqual(integerTwo())

					expect(
						list.firstItem(list.createList([integerHundred()])),
					).toEqual(integerHundred())
				})

				it("returns nothing if the list is empty", () => {
					expect(list.firstItem(listEmpty())).toEqual(nothing())
				})
			})

			describe("lastItem", () => {
				it("returns the lastItem item of the list if it is not empty", () => {
					expect(
						list.lastItem(list.createList([integerTwo()])),
					).toEqual(integerTwo())

					expect(
						list.lastItem(
							list.createList([integerTwo(), integerOne()]),
						),
					).toEqual(integerOne())

					expect(
						list.lastItem(
							list.createList([
								integerTwo(),
								integerOne(),
								integerHundred(),
							]),
						),
					).toEqual(integerHundred())

					expect(
						list.lastItem(list.createList([integerHundred()])),
					).toEqual(integerHundred())
				})

				it("returns nothing if the list is empty", () => {
					expect(list.lastItem(listEmpty())).toEqual(nothing())
				})
			})

			describe("removeFirst", () => {
				it("removed the first item from the list", () => {
					expect(
						list.removeFirst__overload$1(
							list.createList([integerOne()]),
						),
					).toEqual(listEmpty())

					expect(
						list.removeFirst__overload$1(
							list.createList([integerOne(), integerTwo()]),
						),
					).toEqual(list.createList([integerTwo()]))

					expect(
						list.removeFirst__overload$1(
							list.createList([
								integerOne(),
								integerTwo(),
								integerHundred(),
							]),
						),
					).toEqual(list.createList([integerTwo(), integerHundred()]))

					expect(
						list.removeFirst__overload$1(
							list.createList([
								integerOne(),
								integerTwo(),
								integerHundred(),
								integerTwo(),
							]),
						),
					).toEqual(
						list.createList([
							integerTwo(),
							integerHundred(),
							integerTwo(),
						]),
					)
				})

				it("returns an identical list if no items get removed", () => {
					expect(
						list.removeFirst__overload$2(
							list.createList([integerOne()]),
							integerZero(),
						),
					).toEqual(list.createList([integerOne()]))

					expect(
						list.removeFirst__overload$2(
							list.createList([integerOne(), integerTwo()]),
							integerZero(),
						),
					).toEqual(list.createList([integerOne(), integerTwo()]))

					expect(
						list.removeFirst__overload$2(
							list.createList([
								integerOne(),
								integerTwo(),
								integerHundred(),
							]),
							integerZero(),
						),
					).toEqual(
						list.createList([
							integerOne(),
							integerTwo(),
							integerHundred(),
						]),
					)

					expect(
						list.removeFirst__overload$2(
							list.createList([
								integerOne(),
								integerTwo(),
								integerHundred(),
							]),
							integerZero(),
						),
					).toEqual(
						list.createList([
							integerOne(),
							integerTwo(),
							integerHundred(),
						]),
					)

					expect(
						list.removeFirst__overload$2(
							list.createList([
								integerOne(),
								integerTwo(),
								integerHundred(),
								integerTwo(),
							]),
							integerZero(),
						),
					).toEqual(
						list.createList([
							integerOne(),
							integerTwo(),
							integerHundred(),
							integerTwo(),
						]),
					)
				})

				it("removed the first N items from the list", () => {
					expect(
						list.removeFirst__overload$2(
							list.createList([integerOne()]),
							integerOne(),
						),
					).toEqual(listEmpty())

					expect(
						list.removeFirst__overload$2(
							list.createList([integerOne(), integerTwo()]),
							integerOne(),
						),
					).toEqual(list.createList([integerTwo()]))

					expect(
						list.removeFirst__overload$2(
							list.createList([
								integerOne(),
								integerTwo(),
								integerHundred(),
							]),
							integerOne(),
						),
					).toEqual(list.createList([integerTwo(), integerHundred()]))

					expect(
						list.removeFirst__overload$2(
							list.createList([
								integerOne(),
								integerTwo(),
								integerHundred(),
							]),
							integerTwo(),
						),
					).toEqual(list.createList([integerHundred()]))

					expect(
						list.removeFirst__overload$2(
							list.createList([
								integerOne(),
								integerTwo(),
								integerHundred(),
								integerTwo(),
							]),
							integerTwo(),
						),
					).toEqual(list.createList([integerHundred(), integerTwo()]))
				})

				it("returns an empty list all or more items get removed", () => {
					expect(
						list.removeFirst__overload$2(
							list.createList([integerOne()]),
							integerTwo(),
						),
					).toEqual(listEmpty())

					expect(
						list.removeFirst__overload$2(
							list.createList([integerOne(), integerTwo()]),
							integerTwo(),
						),
					).toEqual(listEmpty())

					expect(
						list.removeFirst__overload$2(
							list.createList([
								integerOne(),
								integerTwo(),
								integerHundred(),
							]),
							integerHundred(),
						),
					).toEqual(listEmpty())
				})

				it("returns an empty list if the list is empty", () => {
					expect(list.removeFirst__overload$1(listEmpty())).toEqual(
						listEmpty(),
					)

					expect(
						list.removeFirst__overload$2(listEmpty(), integerOne()),
					).toEqual(listEmpty())
				})
			})

			describe("removeAt", () => {
				it("removes the item at the given index", () => {
					const numbersList = list.createList([
						integerZero(),
						integerOne(),
						integerTwo(),
					])

					expect(list.removeAt(numbersList, integerZero())).toEqual(
						list.createList([integerOne(), integerTwo()]),
					)

					expect(list.removeAt(numbersList, integerOne())).toEqual(
						list.createList([integerZero(), integerTwo()]),
					)

					expect(list.removeAt(numbersList, integerTwo())).toEqual(
						list.createList([integerZero(), integerOne()]),
					)
				})

				it("removes nothing if the index is out of bounds", () => {
					const numbersList = list.createList([
						integerZero(),
						integerOne(),
						integerTwo(),
					])

					expect(
						list.removeAt(numbersList, integerHundred()),
					).toEqual(numbersList)

					expect(
						list.removeAt(numbersList, integer.createInteger(-1n)),
					).toEqual(numbersList)
				})
			})

			describe("removeEvery", () => {
				it("removes every instance from the list that match the excluded item", () => {
					const integerList = list.createList([
						integerZero(),
						integerOne(),
						integerOne(),
						integerTwo(),
					])

					expect(
						list.removeEvery__overload$1(
							integerList,
							integerZero(),
						),
					).toEqual(
						list.createList([
							integerOne(),
							integerOne(),
							integerTwo(),
						]),
					)

					expect(
						list.removeEvery__overload$1(integerList, integerOne()),
					).toEqual(list.createList([integerZero(), integerTwo()]))

					expect(
						list.removeEvery__overload$1(integerList, integerTwo()),
					).toEqual(
						list.createList([
							integerZero(),
							integerOne(),
							integerOne(),
						]),
					)

					expect(
						list.removeEvery__overload$1(
							list.createList([booleanTrue(), booleanFalse()]),
							booleanTrue(),
						),
					).toEqual(list.createList([booleanFalse()]))

					expect(
						list.removeEvery__overload$1(
							list.createList([booleanTrue(), booleanFalse()]),
							booleanFalse(),
						),
					).toEqual(list.createList([booleanTrue()]))
				})

				it("removes every instance from the list that are matched by the filter function", () => {
					const integerList = list.createList([
						integerZero(),
						integerOne(),
						integerOne(),
						integerTwo(),
					])

					expect(
						list.removeEvery__overload$2(
							integerList,
							(item: integer.IntegerType) => {
								if (item.value === integerZero().value) {
									return booleanFalse()
								} else {
									return booleanTrue()
								}
							},
						),
					).toEqual(
						list.createList([
							integerOne(),
							integerOne(),
							integerTwo(),
						]),
					)

					expect(
						list.removeEvery__overload$2(
							integerList,
							(item: integer.IntegerType) => {
								if (item.value === integerOne().value) {
									return booleanFalse()
								} else {
									return booleanTrue()
								}
							},
						),
					).toEqual(list.createList([integerZero(), integerTwo()]))

					expect(
						list.removeEvery__overload$2(
							integerList,
							(item: integer.IntegerType) => {
								if (item.value === integerTwo().value) {
									return booleanFalse()
								} else {
									return booleanTrue()
								}
							},
						),
					).toEqual(
						list.createList([
							integerZero(),
							integerOne(),
							integerOne(),
						]),
					)

					expect(
						list.removeEvery__overload$2(
							list.createList([booleanTrue(), booleanFalse()]),
							(item: boolean.BooleanType) => {
								if (item.value === booleanTrue().value) {
									return booleanFalse()
								} else {
									return booleanTrue()
								}
							},
						),
					).toEqual(list.createList([booleanFalse()]))

					expect(
						list.removeEvery__overload$2(
							list.createList([booleanTrue(), booleanFalse()]),
							(item: boolean.BooleanType) => {
								if (item.value === booleanFalse().value) {
									return booleanFalse()
								} else {
									return booleanTrue()
								}
							},
						),
					).toEqual(list.createList([booleanTrue()]))
				})
			})

			describe("removeLast", () => {
				it("removed the lastItem item from the list", () => {
					expect(
						list.removeLast(list.createList([integerOne()])),
					).toEqual(listEmpty())

					expect(
						list.removeLast(
							list.createList([integerOne(), integerTwo()]),
						),
					).toEqual(list.createList([integerOne()]))

					expect(
						list.removeLast(
							list.createList([
								integerOne(),
								integerTwo(),
								integerHundred(),
							]),
						),
					).toEqual(list.createList([integerOne(), integerTwo()]))

					expect(
						list.removeLast(
							list.createList([
								integerOne(),
								integerTwo(),
								integerHundred(),
								integerTwo(),
							]),
						),
					).toEqual(
						list.createList([
							integerOne(),
							integerTwo(),
							integerHundred(),
						]),
					)
				})

				it("returns an empty list if the list is empty", () => {
					expect(list.removeLast(listEmpty())).toEqual(listEmpty())
				})
			})

			describe("removeDuplicates", () => {
				it("returns the same list if it is already unique", () => {
					expect(list.removeDuplicates(listEmpty())).toEqual(
						listEmpty(),
					)

					expect(
						list.removeDuplicates(list.createList([integerOne()])),
					).toEqual(list.createList([integerOne()]))

					expect(
						list.removeDuplicates(
							list.createList([integerOne(), integerTwo()]),
						),
					).toEqual(list.createList([integerOne(), integerTwo()]))

					expect(
						list.removeDuplicates(
							list.createList([
								integerOne(),
								integerTwo(),
								integerHundred(),
							]),
						),
					).toEqual(
						list.createList([
							integerOne(),
							integerTwo(),
							integerHundred(),
						]),
					)
				})

				it("returns a list of unique items", () => {
					expect(
						list.removeDuplicates(
							list.createList([integerOne(), integerOne()]),
						),
					).toEqual(list.createList([integerOne()]))

					expect(
						list.removeDuplicates(
							list.createList([
								integerOne(),
								integerTwo(),
								integerTwo(),
							]),
						),
					).toEqual(list.createList([integerOne(), integerTwo()]))

					expect(
						list.removeDuplicates(
							list.createList([
								integerOne(),
								integerTwo(),
								integerHundred(),
								integerOne(),
								integerTwo(),
								integerHundred(),
							]),
						),
					).toEqual(
						list.createList([
							integerOne(),
							integerTwo(),
							integerHundred(),
						]),
					)

					expect(
						list.removeDuplicates(
							list.createList([
								integerOne(),
								integerTwo(),
								integerHundred(),
								integerHundred(),
								integerTwo(),
								integerOne(),
							]),
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

			describe("prepend", () => {
				it("prepends individual items to a list correctly", () => {
					expect(
						list.prepend__overload$1(
							list.createList([]),
							integerOne(),
						),
					).toEqual(list.createList([integerOne()]))

					expect(
						list.prepend__overload$1(
							list.createList([integerOne()]),
							integerTwo(),
						),
					).toEqual(list.createList([integerTwo(), integerOne()]))

					expect(
						list.prepend__overload$1(
							list.createList([integerOne(), integerTwo()]),
							integerHundred(),
						),
					).toEqual(
						list.createList([
							integerHundred(),
							integerOne(),
							integerTwo(),
						]),
					)

					expect(
						list.prepend__overload$1(
							list.createList([
								list.createList([integerOne()]),
								list.createList([integerTwo()]),
							]),
							list.createList([integerHundred()]),
						),
					).toEqual(
						list.createList([
							list.createList([integerHundred()]),
							list.createList([integerOne()]),
							list.createList([integerTwo()]),
						]),
					)
				})

				it("prepends contents of a list to another list correctly", () => {
					expect(
						list.prepend__overload$2(
							list.createList([]),
							list.createList([integerOne()]),
						),
					).toEqual(list.createList([integerOne()]))

					expect(
						list.prepend__overload$2(
							list.createList([integerOne()]),
							list.createList([integerTwo()]),
						),
					).toEqual(list.createList([integerTwo(), integerOne()]))

					expect(
						list.prepend__overload$2(
							list.createList([integerOne(), integerTwo()]),
							list.createList([integerHundred()]),
						),
					).toEqual(
						list.createList([
							integerHundred(),
							integerOne(),
							integerTwo(),
						]),
					)
				})
			})

			describe("append", () => {
				it("appends individual items to a list correctly", () => {
					expect(
						list.append__overload$1(
							list.createList([]),
							integerOne(),
						),
					).toEqual(list.createList([integerOne()]))

					expect(
						list.append__overload$1(
							list.createList([integerOne()]),
							integerTwo(),
						),
					).toEqual(list.createList([integerOne(), integerTwo()]))

					expect(
						list.append__overload$1(
							list.createList([integerOne(), integerTwo()]),
							integerHundred(),
						),
					).toEqual(
						list.createList([
							integerOne(),
							integerTwo(),
							integerHundred(),
						]),
					)

					expect(
						list.append__overload$1(
							list.createList([
								list.createList([integerOne()]),
								list.createList([integerTwo()]),
							]),
							list.createList([integerHundred()]),
						),
					).toEqual(
						list.createList([
							list.createList([integerOne()]),
							list.createList([integerTwo()]),
							list.createList([integerHundred()]),
						]),
					)
				})

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

			describe("isNot", () => {
				it("returns true if the records are different", () => {
					expect(
						record.isNot(
							recordEmpty(),
							record.createRecord({ a: integerOne() }),
						),
					).toEqual(booleanTrue())

					expect(
						record.isNot(
							record.createRecord({ a: integerOne() }),
							recordEmpty(),
						),
					).toEqual(booleanTrue())

					expect(
						record.isNot(
							record.createRecord({ a: integerOne() }),
							record.createRecord({
								a: integerOne(),
								b: stringEmpty(),
							}),
						),
					).toEqual(booleanTrue())

					expect(
						record.isNot(
							record.createRecord({
								a: integerOne(),
								b: stringEmpty(),
							}),
							record.createRecord({ a: integerOne() }),
						),
					).toEqual(booleanTrue())
				})

				it("returns false if the records are identical", () => {
					expect(record.isNot(recordEmpty(), recordEmpty())).toEqual(
						booleanFalse(),
					)

					expect(
						record.isNot(
							record.createRecord({ a: integerOne() }),
							record.createRecord({ a: integerOne() }),
						),
					).toEqual(booleanFalse())

					expect(
						record.isNot(
							record.createRecord({
								a: integerOne(),
								b: stringEmpty(),
							}),
							record.createRecord({
								a: integerOne(),
								b: stringEmpty(),
							}),
						),
					).toEqual(booleanFalse())
				})
			})

			describe("toString", () => {
				it("prints correctly", () => {
					expect(record.toString(recordEmpty())).toEqual(
						string.createString("Record"),
					)
				})
			})
		})
	})
})
