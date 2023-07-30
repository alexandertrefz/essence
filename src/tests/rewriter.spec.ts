import { describe, expect, it } from "bun:test"

import * as boolean from "../rewriter/__internal/Boolean"
import * as fraction from "../rewriter/__internal/Fraction"
import * as integer from "../rewriter/__internal/Integer"
import * as list from "../rewriter/__internal/List"
import { createNothing } from "../rewriter/__internal/Nothing"
import * as number from "../rewriter/__internal/Number"
import * as string from "../rewriter/__internal/String"

const booleanTrue = () => boolean.createBoolean(true)
const booleanFalse = () => boolean.createBoolean(false)
const stringEmpty = () => string.createString("")

const integerOne = () => integer.createInteger(1n)
const integerTwo = () => integer.createInteger(2n)
const integerHundred = () => integer.createInteger(100n)

const fractionOneHalf = () => fraction.createFraction(1n, 2n)
const fractionOne = () => fraction.createFraction(1n, 1n)
const fractionTwo = () => fraction.createFraction(2n, 1n)
const fractionHundred = () => fraction.createFraction(100n, 1n)

const listEmpty = () => list.createList([])

const nothing = () => createNothing()

describe("Rewriter", () => {
	describe("Internal", () => {
		describe("Boolean", () => {
			describe("negate", () => {
				it("turns true to false", () => {
					expect(boolean.negate(booleanTrue())).toEqual(booleanFalse())
				})

				it("turns false to true", () => {
					expect(boolean.negate(booleanFalse())).toEqual(booleanTrue())
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

			describe("isnt", () => {
				it("returns false when both sides match", () => {
					expect(boolean.isnt(booleanTrue(), booleanTrue())).toEqual(
						booleanFalse(),
					)
					expect(boolean.isnt(booleanFalse(), booleanFalse())).toEqual(
						booleanFalse(),
					)
				})

				it("returns true when the sides dont match ", () => {
					expect(boolean.isnt(booleanTrue(), booleanFalse())).toEqual(
						booleanTrue(),
					)
					expect(boolean.isnt(booleanFalse(), booleanTrue())).toEqual(
						booleanTrue(),
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

			describe("hasContent", () => {
				it("returns true when the string is not empty", () => {
					expect(string.hasContent(string.createString("a"))).toEqual(
						booleanTrue(),
					)

					expect(string.hasContent(string.createString("abc"))).toEqual(
						booleanTrue(),
					)

					expect(string.hasContent(string.createString(" "))).toEqual(
						booleanTrue(),
					)

					expect(string.hasContent(string.createString("!"))).toEqual(
						booleanTrue(),
					)
				})

				it("returns false when the string is empty", () => {
					expect(string.hasContent(stringEmpty())).toEqual(booleanFalse())
				})
			})

			describe("is", () => {
				it("returns true when the strings are equal", () => {
					expect(string.is(stringEmpty(), stringEmpty())).toEqual(booleanTrue())

					expect(
						string.is(string.createString("a"), string.createString("a")),
					).toEqual(booleanTrue())

					expect(
						string.is(string.createString("abc"), string.createString("abc")),
					).toEqual(booleanTrue())

					expect(
						string.is(string.createString("!"), string.createString("!")),
					).toEqual(booleanTrue())

					expect(
						string.is(string.createString(" "), string.createString(" ")),
					).toEqual(booleanTrue())
				})

				it("returns false when the strings are not equal", () => {
					expect(string.is(stringEmpty(), string.createString("a"))).toEqual(
						booleanFalse(),
					)

					expect(string.is(stringEmpty(), string.createString("abc"))).toEqual(
						booleanFalse(),
					)

					expect(string.is(stringEmpty(), string.createString("!"))).toEqual(
						booleanFalse(),
					)

					expect(string.is(stringEmpty(), string.createString(" "))).toEqual(
						booleanFalse(),
					)

					expect(
						string.is(string.createString("abc"), string.createString(" ")),
					).toEqual(booleanFalse())

					expect(string.is(string.createString("abc"), stringEmpty())).toEqual(
						booleanFalse(),
					)
				})
			})

			describe("isnt", () => {
				it("returns true when the strings are not equal", () => {
					expect(string.isnt(stringEmpty(), string.createString("a"))).toEqual(
						booleanTrue(),
					)

					expect(
						string.isnt(stringEmpty(), string.createString("abc")),
					).toEqual(booleanTrue())

					expect(string.isnt(stringEmpty(), string.createString("!"))).toEqual(
						booleanTrue(),
					)

					expect(string.isnt(stringEmpty(), string.createString(" "))).toEqual(
						booleanTrue(),
					)

					expect(
						string.isnt(string.createString("abc"), string.createString(" ")),
					).toEqual(booleanTrue())

					expect(
						string.isnt(string.createString("abc"), stringEmpty()),
					).toEqual(booleanTrue())
				})

				it("returns false when the strings are equal", () => {
					expect(string.isnt(stringEmpty(), stringEmpty())).toEqual(
						booleanFalse(),
					)

					expect(
						string.isnt(string.createString("a"), string.createString("a")),
					).toEqual(booleanFalse())

					expect(
						string.isnt(string.createString("abc"), string.createString("abc")),
					).toEqual(booleanFalse())

					expect(
						string.isnt(string.createString("!"), string.createString("!")),
					).toEqual(booleanFalse())

					expect(
						string.isnt(string.createString(" "), string.createString(" ")),
					).toEqual(booleanFalse())
				})
			})

			describe("prepend", () => {
				it("prepends any string in front of another", () => {
					expect(
						string.prepend(stringEmpty(), string.createString("a")),
					).toEqual(string.createString("a"))

					expect(
						string.prepend(stringEmpty(), string.createString("abc")),
					).toEqual(string.createString("abc"))

					expect(
						string.prepend(stringEmpty(), string.createString("!")),
					).toEqual(string.createString("!"))

					expect(
						string.prepend(stringEmpty(), string.createString(" ")),
					).toEqual(string.createString(" "))

					expect(
						string.prepend(string.createString("bc"), string.createString("a")),
					).toEqual(string.createString("abc"))
				})
			})

			describe("append", () => {
				it("appends any string to any other", () => {
					expect(
						string.append(stringEmpty(), string.createString("a")),
					).toEqual(string.createString("a"))

					expect(
						string.append(stringEmpty(), string.createString("abc")),
					).toEqual(string.createString("abc"))

					expect(
						string.append(stringEmpty(), string.createString("!")),
					).toEqual(string.createString("!"))

					expect(
						string.append(stringEmpty(), string.createString(" ")),
					).toEqual(string.createString(" "))

					expect(
						string.append(string.createString("a"), string.createString("bc")),
					).toEqual(string.createString("abc"))
				})
			})

			describe("split", () => {
				it("splits correctly when splitting on an empty string", () => {
					expect(
						string.split(string.createString("abc"), string.createString("")),
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
			})

			describe("contains", () => {
				it("returns true when the partial string is empty", () => {
					expect(
						string.contains(string.createString("abc"), stringEmpty()),
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
						string.contains(stringEmpty(), string.createString("abc")),
					).toEqual(booleanFalse())

					expect(
						string.contains(
							string.createString("abc"),
							string.createString("d"),
						),
					).toEqual(booleanFalse())
				})
			})
		})

		describe("Integer", () => {
			describe("add", () => {
				it("adds 2 integers correctly", () => {
					expect(integer.add__overload$1(integerOne(), integerOne())).toEqual(
						integerTwo(),
					)

					expect(
						integer.add__overload$1(integerHundred(), integerOne()),
					).toEqual(integer.createInteger(101n))

					expect(
						integer.add__overload$1(integerOne(), integerHundred()),
					).toEqual(integer.createInteger(101n))
				})

				it("adds an integer and a fraction correctly", () => {
					expect(
						integer.add__overload$2(integerOne(), fractionOneHalf()),
					).toEqual(fraction.createFraction(3n, 2n))

					expect(
						integer.add__overload$2(integerHundred(), fractionOneHalf()),
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
						integer.subtract__overload$1(integerTwo(), integerOne()),
					).toEqual(integerOne())

					expect(
						integer.subtract__overload$1(integerHundred(), integerOne()),
					).toEqual(integer.createInteger(99n))

					expect(
						integer.subtract__overload$1(integerOne(), integerHundred()),
					).toEqual(integer.createInteger(-99n))
				})

				it("subtracts a fraction from an integer correctly", () => {
					expect(
						integer.subtract__overload$2(integerOne(), fractionOneHalf()),
					).toEqual(fractionOneHalf())

					expect(
						integer.subtract__overload$2(integerHundred(), fractionOneHalf()),
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
						integer.multiplyWith__overload$1(integerOne(), integerOne()),
					).toEqual(integerOne())

					expect(
						integer.multiplyWith__overload$1(integerHundred(), integerOne()),
					).toEqual(integerHundred())

					expect(
						integer.multiplyWith__overload$1(integerTwo(), integerTwo()),
					).toEqual(integer.createInteger(4n))

					expect(
						integer.multiplyWith__overload$1(integerTwo(), integerHundred()),
					).toEqual(integer.createInteger(200n))
				})

				it("multiplies an integer and a fraction correctly", () => {
					expect(
						integer.multiplyWith__overload$2(integerOne(), fractionOneHalf()),
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
						integer.multiplyWith__overload$2(integerTwo(), fractionOneHalf()),
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
						integer.divideBy__overload$1(integerOne(), integerOne()),
					).toEqual(fraction.createFraction(1n, 1n))

					expect(
						integer.divideBy__overload$1(integerOne(), integerTwo()),
					).toEqual(fraction.createFraction(1n, 2n))

					expect(
						integer.divideBy__overload$1(integerHundred(), integerTwo()),
					).toEqual(fraction.createFraction(100n, 2n))
				})

				it("divides an integer and a fraction correctly", () => {
					expect(
						integer.divideBy__overload$2(integerOne(), fractionOneHalf()),
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

					expect(integer.toString(integer.createInteger(1000n))).toEqual(
						string.createString("1000"),
					)
				})
			})
		})

		describe("Fraction", () => {
			describe("add", () => {
				it("adds 2 fractions correctly", () => {
					expect(
						fraction.add__overload$1(fractionOneHalf(), fractionOneHalf()),
					).toEqual(fraction.createFraction(4n, 4n))

					expect(
						fraction.add__overload$1(fractionHundred(), fractionOne()),
					).toEqual(fraction.createFraction(101n, 1n))

					expect(
						fraction.add__overload$1(fractionOne(), fractionHundred()),
					).toEqual(fraction.createFraction(101n, 1n))
				})

				it("adds a fraction and an integer correctly", () => {
					expect(
						fraction.add__overload$2(fractionOneHalf(), integerOne()),
					).toEqual(fraction.createFraction(3n, 2n))

					expect(
						fraction.add__overload$2(fractionOneHalf(), integerHundred()),
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
						fraction.subtract__overload$1(fractionTwo(), fractionOne()),
					).toEqual(fractionOne())

					expect(
						fraction.subtract__overload$1(
							fraction.createFraction(100n, 1n),
							fractionOne(),
						),
					).toEqual(fraction.createFraction(99n, 1n))

					expect(
						fraction.subtract__overload$1(fractionOne(), fractionHundred()),
					).toEqual(fraction.createFraction(-99n, 1n))
				})

				it("subtracts an integer from a fraction correctly", () => {
					expect(
						fraction.subtract__overload$2(fractionTwo(), integerOne()),
					).toEqual(fractionOne())

					expect(
						fraction.subtract__overload$2(fractionHundred(), integerOne()),
					).toEqual(fraction.createFraction(99n, 1n))
				})
			})

			describe("multiply", () => {
				it("multiplies 2 fractions correctly", () => {
					expect(
						fraction.multiplyWith__overload$1(fractionOne(), fractionOne()),
					).toEqual(fractionOne())

					expect(
						fraction.multiplyWith__overload$1(fractionHundred(), fractionOne()),
					).toEqual(fractionHundred())

					expect(
						fraction.multiplyWith__overload$1(fractionTwo(), fractionTwo()),
					).toEqual(fraction.createFraction(4n, 1n))

					expect(
						fraction.multiplyWith__overload$1(fractionTwo(), fractionHundred()),
					).toEqual(fraction.createFraction(200n, 1n))
				})

				it("multiplies a fraction and an integer correctly", () => {
					expect(
						fraction.multiplyWith__overload$2(fractionOneHalf(), integerOne()),
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
						fraction.multiplyWith__overload$2(fractionOneHalf(), integerTwo()),
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
						fraction.divideBy__overload$1(fractionOne(), fractionOne()),
					).toEqual(fraction.createFraction(1n, 1n))

					expect(
						fraction.divideBy__overload$1(fractionOne(), fractionTwo()),
					).toEqual(fraction.createFraction(1n, 2n))

					expect(
						fraction.divideBy__overload$1(fractionOne(), fractionOneHalf()),
					).toEqual(fraction.createFraction(2n, 1n))

					expect(
						fraction.divideBy__overload$1(fractionHundred(), fractionTwo()),
					).toEqual(fraction.createFraction(100n, 2n))
				})

				it("divides a fraction and an integer correctly", () => {
					expect(
						fraction.divideBy__overload$2(fractionOne(), integerOne()),
					).toEqual(fractionOne())

					expect(
						fraction.divideBy__overload$2(
							fraction.createFraction(2n, 1n),
							integerTwo(),
						),
					).toEqual(fraction.createFraction(2n, 2n))

					expect(
						fraction.divideBy__overload$2(fractionHundred(), integerTwo()),
					).toEqual(fraction.createFraction(100n, 2n))
				})
			})

			describe("toString", () => {
				it("returns the correct strings", () => {
					expect(fraction.toString__overload$1(fractionOneHalf())).toEqual(
						string.createString("1/2"),
					)

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
						number.lowestNumber__overload$1(integerOne(), integerTwo()),
					).toEqual(integerOne())

					expect(
						number.lowestNumber__overload$1(integerTwo(), integerOne()),
					).toEqual(integerOne())

					expect(
						number.lowestNumber__overload$1(integerHundred(), integerTwo()),
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
						number.lowestNumber__overload$2(fractionOne(), fractionTwo()),
					).toEqual(fractionOne())

					expect(
						number.lowestNumber__overload$2(fractionTwo(), fractionOne()),
					).toEqual(fractionOne())

					expect(
						number.lowestNumber__overload$2(fractionHundred(), fractionTwo()),
					).toEqual(fractionTwo())

					expect(
						number.lowestNumber__overload$2(fractionOne(), fractionOneHalf()),
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
						number.lowestNumber__overload$3(integerOne(), fractionTwo()),
					).toEqual(integerOne())

					expect(
						number.lowestNumber__overload$3(integerTwo(), fractionOne()),
					).toEqual(fractionOne())

					expect(
						number.lowestNumber__overload$3(integerHundred(), fractionTwo()),
					).toEqual(fractionTwo())

					expect(
						number.lowestNumber__overload$3(integerOne(), fractionOneHalf()),
					).toEqual(fractionOneHalf())

					expect(
						number.lowestNumber__overload$3(
							integer.createInteger(-1n),
							fractionOne(),
						),
					).toEqual(integer.createInteger(-1n))

					expect(
						number.lowestNumber__overload$4(fractionOne(), integerTwo()),
					).toEqual(fractionOne())

					expect(
						number.lowestNumber__overload$4(fractionTwo(), integerOne()),
					).toEqual(integerOne())

					expect(
						number.lowestNumber__overload$4(fractionHundred(), integerTwo()),
					).toEqual(integerTwo())

					expect(
						number.lowestNumber__overload$4(fractionOneHalf(), integerOne()),
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
							list.createList([integerOne(), integerTwo(), integerHundred()]),
						),
					).toEqual(integerOne())

					expect(
						number.lowestNumber__overload$5(
							list.createList([integerTwo(), integerOne(), integerHundred()]),
						),
					).toEqual(integerOne())

					expect(
						number.lowestNumber__overload$5(
							list.createList([integerHundred(), integerTwo(), integerOne()]),
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
							list.createList([integerOne(), fractionTwo(), integerHundred()]),
						),
					).toEqual(integerOne())

					expect(
						number.lowestNumber__overload$7(
							list.createList([integerTwo(), fractionOne(), integerHundred()]),
						),
					).toEqual(fractionOne())

					expect(
						number.lowestNumber__overload$7(
							list.createList([fractionHundred(), integerTwo(), integerOne()]),
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
		})

		describe("List", () => {
			describe("hasItems", () => {
				it("returns true when the list has items", () => {
					expect(list.hasItems(list.createList([integerOne()]))).toEqual(
						booleanTrue(),
					)

					expect(
						list.hasItems(list.createList([integerOne(), integerTwo()])),
					).toEqual(booleanTrue())

					expect(list.hasItems(list.createList([stringEmpty()]))).toEqual(
						booleanTrue(),
					)

					expect(list.hasItems(list.createList([fractionOne()]))).toEqual(
						booleanTrue(),
					)

					expect(list.hasItems(list.createList([listEmpty()]))).toEqual(
						booleanTrue(),
					)
				})

				it("returns false when the list is empty", () => {
					expect(list.hasItems(listEmpty())).toEqual(booleanFalse())
				})
			})

			// TODO
			// describe("isEmpty", () => {})

			describe("firstItem", () => {
				it("returns the firstItem item of the list if it isnt empty", () => {
					expect(list.firstItem(list.createList([integerTwo()]))).toEqual(
						integerTwo(),
					)

					expect(
						list.firstItem(list.createList([integerTwo(), integerOne()])),
					).toEqual(integerTwo())

					expect(
						list.firstItem(
							list.createList([integerTwo(), integerOne(), integerHundred()]),
						),
					).toEqual(integerTwo())

					expect(list.firstItem(list.createList([integerHundred()]))).toEqual(
						integerHundred(),
					)
				})

				it("returns nothing if the list is empty", () => {
					expect(list.firstItem(listEmpty())).toEqual(nothing())
				})
			})

			describe("lastItemItem", () => {
				it("returns the lastItem item of the list if it isnt empty", () => {
					expect(list.lastItem(list.createList([integerTwo()]))).toEqual(
						integerTwo(),
					)

					expect(
						list.lastItem(list.createList([integerTwo(), integerOne()])),
					).toEqual(integerOne())

					expect(
						list.lastItem(
							list.createList([integerTwo(), integerOne(), integerHundred()]),
						),
					).toEqual(integerHundred())

					expect(list.lastItem(list.createList([integerHundred()]))).toEqual(
						integerHundred(),
					)
				})

				it("returns nothing if the list is empty", () => {
					expect(list.lastItem(listEmpty())).toEqual(nothing())
				})
			})

			describe("removeDuplicates", () => {
				it("returns the same list if it is already unique", () => {
					expect(list.removeDuplicates(listEmpty())).toEqual(listEmpty())

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
							list.createList([integerOne(), integerTwo(), integerHundred()]),
						),
					).toEqual(
						list.createList([integerOne(), integerTwo(), integerHundred()]),
					)
				})

				// TODO: Fix This to actually work
				it("returns a list of unique items", () => {
					expect(
						list.removeDuplicates(
							list.createList([integerOne(), integerOne()]),
						),
					).toEqual(list.createList([integerOne()]))

					expect(
						list.removeDuplicates(
							list.createList([integerOne(), integerTwo(), integerTwo()]),
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
						list.createList([integerOne(), integerTwo(), integerHundred()]),
					)
				})
			})

			describe("removeFirst", () => {
				it("removed the first item from the list", () => {
					expect(list.removeFirst(list.createList([integerOne()]))).toEqual(
						listEmpty(),
					)

					expect(
						list.removeFirst(list.createList([integerOne(), integerTwo()])),
					).toEqual(list.createList([integerTwo()]))

					expect(
						list.removeFirst(
							list.createList([integerOne(), integerTwo(), integerHundred()]),
						),
					).toEqual(list.createList([integerTwo(), integerHundred()]))

					expect(
						list.removeFirst(
							list.createList([
								integerOne(),
								integerTwo(),
								integerHundred(),
								integerTwo(),
							]),
						),
					).toEqual(
						list.createList([integerTwo(), integerHundred(), integerTwo()]),
					)
				})

				it("returns an empty list if the list is empty", () => {
					expect(list.removeFirst(listEmpty())).toEqual(listEmpty())
				})
			})

			describe("removeLast", () => {
				it("removed the lastItem item from the list", () => {
					expect(list.removeLast(list.createList([integerOne()]))).toEqual(
						listEmpty(),
					)

					expect(
						list.removeLast(list.createList([integerOne(), integerTwo()])),
					).toEqual(list.createList([integerOne()]))

					expect(
						list.removeLast(
							list.createList([integerOne(), integerTwo(), integerHundred()]),
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
						list.createList([integerOne(), integerTwo(), integerHundred()]),
					)
				})

				it("returns an empty list if the list is empty", () => {
					expect(list.removeLast(listEmpty())).toEqual(listEmpty())
				})
			})

			// TODO
			// describe("prepend", () => {})

			describe("append", () => {
				it("appends individual items to a list correctly", () => {
					expect(
						list.append__overload$1(list.createList([]), integerOne()),
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
						list.createList([integerOne(), integerTwo(), integerHundred()]),
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
						list.createList([integerOne(), integerTwo(), integerHundred()]),
					)
				})
			})
		})
	})
})
