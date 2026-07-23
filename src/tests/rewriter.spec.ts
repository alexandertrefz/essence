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

				it("splits an empty splitter by code point, keeping astral characters whole", () => {
					// NOTE: `String.split("")` would tear the emoji into two
					// lone surrogates; splitting by code point keeps it whole,
					// so this matches `characters()` exactly.
					let emoji = string.createString("a\u{1F600}b")

					expect(
						string.splitOn(emoji, string.createString("")),
					).toEqual(
						list.createList([
							string.createString("a"),
							string.createString("\u{1F600}"),
							string.createString("b"),
						]),
					)
					expect(
						string.splitOn(emoji, string.createString("")),
					).toEqual(string.characters(emoji))
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

				it("splits on an astral separator", () => {
					expect(
						string.splitOn(
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

			describe("length and characters", () => {
				it("counts and splits by code point", () => {
					expect(string.length(string.createString("abc"))).toEqual(
						integer.createInteger(3n),
					)
					// NOTE: The emoji is one code point, not two code units.
					expect(
						string.length(string.createString("a\u{1F600}b")),
					).toEqual(integer.createInteger(3n))
					expect(
						string.characters(string.createString("a\u{1F600}")),
					).toEqual(
						list.createList([
							string.createString("a"),
							string.createString("\u{1F600}"),
						]),
					)
				})
			})

			describe("characterAt", () => {
				it("returns the code point at the position", () => {
					expect(
						string.characterAt(
							string.createString("a\u{1F600}b"),
							integerOne(),
						),
					).toEqual(string.createString("\u{1F600}"))
				})

				it("returns nothing outside the String", () => {
					expect(
						string.characterAt(
							string.createString("a"),
							integerTwo(),
						),
					).toEqual(nothing())
					expect(
						string.characterAt(
							string.createString("a"),
							integer.createInteger(-1n),
						),
					).toEqual(nothing())
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

				it("trims from either or both ends", () => {
					expect(
						string.trimmed(string.createString("  hi  ")),
					).toEqual(string.createString("hi"))
					expect(
						string.trimmedAtStart(string.createString("  hi  ")),
					).toEqual(string.createString("hi  "))
					expect(
						string.trimmedAtEnd(string.createString("  hi  ")),
					).toEqual(string.createString("  hi"))
				})
			})

			describe("prefixes and suffixes", () => {
				it("answers starts/ends and their negations", () => {
					const hello = string.createString("hello")

					expect(
						string.startsWith(hello, string.createString("he")),
					).toEqual(booleanTrue())
					expect(
						string.doesNotStartWith(
							hello,
							string.createString("he"),
						),
					).toEqual(booleanFalse())
					expect(
						string.endsWith(hello, string.createString("lo")),
					).toEqual(booleanTrue())
					expect(
						string.doesNotEndWith(hello, string.createString("x")),
					).toEqual(booleanTrue())
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
			})

			describe("repeated", () => {
				it("joins the String to itself", () => {
					expect(
						string.repeated(
							string.createString("ab"),
							integerTwo(),
						),
					).toEqual(string.createString("abab"))
				})

				it("is empty for a count below one", () => {
					expect(
						string.repeated(
							string.createString("ab"),
							integerZero(),
						),
					).toEqual(stringEmpty())
					expect(
						string.repeated(
							string.createString("ab"),
							integer.createInteger(-3n),
						),
					).toEqual(stringEmpty())
				})
			})

			describe("reversed", () => {
				it("reverses by code point, keeping astral characters whole", () => {
					expect(
						string.reversed(string.createString("a\u{1F600}b")),
					).toEqual(string.createString("b\u{1F600}a"))
				})
			})

			describe("slice", () => {
				const abcde = () => string.createString("abcde")

				it("returns the half-open range", () => {
					expect(
						string.slice(
							abcde(),
							integerOne(),
							integer.createInteger(3n),
						),
					).toEqual(string.createString("bc"))
				})

				it("clamps each end", () => {
					expect(
						string.slice(
							abcde(),
							integer.createInteger(-2n),
							integer.createInteger(99n),
						),
					).toEqual(abcde())
				})

				it("is empty when the range is empty or reversed", () => {
					expect(
						string.slice(
							abcde(),
							integer.createInteger(3n),
							integerOne(),
						),
					).toEqual(stringEmpty())
				})
			})

			describe("firstIndexOf", () => {
				it("gives the code-point position of the first occurrence", () => {
					expect(
						string.firstIndexOf(
							string.createString("a\u{1F600}bc"),
							string.createString("b"),
						),
					).toEqual(integerTwo())
				})

				it("gives nothing when absent", () => {
					expect(
						string.firstIndexOf(
							string.createString("abc"),
							string.createString("z"),
						),
					).toEqual(nothing())
				})
			})

			describe("padding", () => {
				it("pads at the start and end up to a length in code points", () => {
					expect(
						string.paddedAtStart(
							string.createString("7"),
							integer.createInteger(3n),
							string.createString("0"),
						),
					).toEqual(string.createString("007"))
					expect(
						string.paddedAtEnd(
							string.createString("7"),
							integer.createInteger(3n),
							string.createString("."),
						),
					).toEqual(string.createString("7.."))
				})

				it("leaves a long-enough String unchanged, and an empty pad has no effect", () => {
					expect(
						string.paddedAtStart(
							string.createString("hello"),
							integerTwo(),
							string.createString("0"),
						),
					).toEqual(string.createString("hello"))
					expect(
						string.paddedAtStart(
							string.createString("hi"),
							integerHundred(),
							stringEmpty(),
						),
					).toEqual(string.createString("hi"))
				})
			})

			describe("compareTo", () => {
				it("orders lexicographically by code point", () => {
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

				it("subtracts a rational from an integer correctly", () => {
					expect(
						integer.subtract__overload$2(
							integerOne(),
							rationalOneHalf(),
						),
					).toEqual(rationalOneHalf())

					expect(
						integer.subtract__overload$2(
							integerHundred(),
							rationalOneHalf(),
						),
					).toEqual(rational.createRational(199n, 2n))

					expect(
						integer.subtract__overload$2(
							integerOne(),
							rational.createRational(-1n, 2n),
						),
					).toEqual(rational.createRational(3n, 2n))
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

				it("multiplies an integer and a rational correctly", () => {
					expect(
						integer.multiplyWith__overload$2(
							integerOne(),
							rationalOneHalf(),
						),
					).toEqual(rationalOneHalf())

					// NOTE: Rationals are not automatically reduced, so we need to compare against the common demoninator
					expect(
						integer.multiplyWith__overload$2(
							integerHundred(),
							rationalOneHalf(),
						),
					).toEqual(rational.createRational(100n, 2n))

					// NOTE: Rationals are not automatically reduced, so we need to compare against the common demoninator
					expect(
						integer.multiplyWith__overload$2(
							integerTwo(),
							rationalOneHalf(),
						),
					).toEqual(rational.createRational(2n, 2n))

					expect(
						integer.multiplyWith__overload$2(
							integerTwo(),
							rational.createRational(50n, 1n),
						),
					).toEqual(rational.createRational(100n, 1n))
				})
			})

			describe("divide", () => {
				it("divides 2 integers correctly", () => {
					expect(
						integer.divideBy__overload$1(
							integerOne(),
							integerOne(),
						),
					).toEqual(rational.createRational(1n, 1n))

					expect(
						integer.divideBy__overload$1(
							integerOne(),
							integerTwo(),
						),
					).toEqual(rational.createRational(1n, 2n))

					expect(
						integer.divideBy__overload$1(
							integerHundred(),
							integerTwo(),
						),
					).toEqual(rational.createRational(100n, 2n))
				})

				it("divides an integer and a rational correctly", () => {
					expect(
						integer.divideBy__overload$2(
							integerOne(),
							rationalOneHalf(),
						),
					).toEqual(rational.createRational(2n, 1n))

					expect(
						integer.divideBy__overload$2(
							integerOne(),
							rational.createRational(2n, 1n),
						),
					).toEqual(rational.createRational(1n, 2n))

					expect(
						integer.divideBy__overload$2(
							integerHundred(),
							rational.createRational(2n, 1n),
						),
					).toEqual(rational.createRational(100n, 2n))
				})

				it("returns Nothing when dividing by zero", () => {
					expect(
						integer.divideBy__overload$1(
							integerOne(),
							integerZero(),
						),
					).toEqual(nothing())

					expect(
						integer.divideBy__overload$2(
							integerOne(),
							rational.createRational(0n, 1n),
						),
					).toEqual(nothing())
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

			describe("is", () => {
				it("returns true if both rationals are the same", () => {
					expect(
						rational.is(rationalOneHalf(), rationalOneHalf()),
					).toEqual(booleanTrue())

					expect(rational.is(rationalOne(), rationalOne())).toEqual(
						booleanTrue(),
					)

					expect(rational.is(rationalTwo(), rationalTwo())).toEqual(
						booleanTrue(),
					)

					expect(
						rational.is(rationalHundred(), rationalHundred()),
					).toEqual(booleanTrue())

					expect(
						rational.is(
							rationalOne(),
							rational.divideBy__overload$1(
								rationalTwo(),
								rationalTwo(),
							) as rational.RationalType,
						),
					).toEqual(booleanTrue())

					expect(
						rational.is(
							rational.divideBy__overload$1(
								rationalTwo(),
								rationalTwo(),
							) as rational.RationalType,
							rationalOne(),
						),
					).toEqual(booleanTrue())
				})

				it("returns false if the rationals are not the same", () => {
					expect(rational.is(rationalOne(), rationalTwo())).toEqual(
						booleanFalse(),
					)

					expect(rational.is(rationalTwo(), rationalOne())).toEqual(
						booleanFalse(),
					)

					expect(
						rational.is(rationalHundred(), rationalOneHalf()),
					).toEqual(booleanFalse())

					expect(
						rational.is(rationalOneHalf(), rationalHundred()),
					).toEqual(booleanFalse())

					expect(
						rational.is(rationalOne(), rationalOneHalf()),
					).toEqual(booleanFalse())

					expect(
						rational.is(rationalOneHalf(), rationalOne()),
					).toEqual(booleanFalse())
				})
			})

			describe("isNot", () => {
				it("returns true if the rationals are not the same", () => {
					expect(
						rational.isNot(rationalOne(), rationalOneHalf()),
					).toEqual(booleanTrue())

					expect(
						rational.isNot(rationalOne(), rationalTwo()),
					).toEqual(booleanTrue())

					expect(
						rational.isNot(rationalOne(), rationalHundred()),
					).toEqual(booleanTrue())

					expect(
						rational.isNot(rationalOneHalf(), rationalOne()),
					).toEqual(booleanTrue())

					expect(
						rational.isNot(rationalOneHalf(), rationalTwo()),
					).toEqual(booleanTrue())

					expect(
						rational.isNot(rationalOneHalf(), rationalHundred()),
					).toEqual(booleanTrue())

					expect(
						rational.isNot(rationalTwo(), rationalOneHalf()),
					).toEqual(booleanTrue())

					expect(
						rational.isNot(rationalTwo(), rationalOne()),
					).toEqual(booleanTrue())

					expect(
						rational.isNot(rationalTwo(), rationalHundred()),
					).toEqual(booleanTrue())

					expect(
						rational.isNot(rationalHundred(), rationalOneHalf()),
					).toEqual(booleanTrue())

					expect(
						rational.isNot(rationalHundred(), rationalOne()),
					).toEqual(booleanTrue())

					expect(
						rational.isNot(rationalHundred(), rationalTwo()),
					).toEqual(booleanTrue())
				})

				it("returns false if the rationals are the same", () => {
					expect(
						rational.isNot(rationalOneHalf(), rationalOneHalf()),
					).toEqual(booleanFalse())

					expect(
						rational.isNot(rationalOne(), rationalOne()),
					).toEqual(booleanFalse())

					expect(
						rational.isNot(rationalTwo(), rationalTwo()),
					).toEqual(booleanFalse())

					expect(
						rational.isNot(rationalHundred(), rationalHundred()),
					).toEqual(booleanFalse())
				})
			})

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

			describe("subtract", () => {
				it("subtract 2 rationals correctly", () => {
					expect(
						rational.subtract__overload$1(
							rationalTwo(),
							rationalOne(),
						),
					).toEqual(rationalOne())

					expect(
						rational.subtract__overload$1(
							rational.createRational(100n, 1n),
							rationalOne(),
						),
					).toEqual(rational.createRational(99n, 1n))

					expect(
						rational.subtract__overload$1(
							rationalOne(),
							rationalHundred(),
						),
					).toEqual(rational.createRational(-99n, 1n))
				})

				it("subtracts an integer from a rational correctly", () => {
					expect(
						rational.subtract__overload$2(
							rationalTwo(),
							integerOne(),
						),
					).toEqual(rationalOne())

					expect(
						rational.subtract__overload$2(
							rationalHundred(),
							integerOne(),
						),
					).toEqual(rational.createRational(99n, 1n))
				})
			})

			describe("multiply", () => {
				it("multiplies 2 rationals correctly", () => {
					expect(
						rational.multiplyWith__overload$1(
							rationalOne(),
							rationalOne(),
						),
					).toEqual(rationalOne())

					expect(
						rational.multiplyWith__overload$1(
							rationalHundred(),
							rationalOne(),
						),
					).toEqual(rationalHundred())

					expect(
						rational.multiplyWith__overload$1(
							rationalTwo(),
							rationalTwo(),
						),
					).toEqual(rational.createRational(4n, 1n))

					expect(
						rational.multiplyWith__overload$1(
							rationalTwo(),
							rationalHundred(),
						),
					).toEqual(rational.createRational(200n, 1n))
				})

				it("multiplies a rational and an integer correctly", () => {
					expect(
						rational.multiplyWith__overload$2(
							rationalOneHalf(),
							integerOne(),
						),
					).toEqual(rationalOneHalf())

					// NOTE: Rationals are not automatically reduced, so we need to compare against the common demoninator
					expect(
						rational.multiplyWith__overload$2(
							rationalOneHalf(),
							integerHundred(),
						),
					).toEqual(rational.createRational(100n, 2n))

					// NOTE: Rationals are not automatically reduced, so we need to compare against the common demoninator
					expect(
						rational.multiplyWith__overload$2(
							rationalOneHalf(),
							integerTwo(),
						),
					).toEqual(rational.createRational(2n, 2n))

					expect(
						rational.multiplyWith__overload$2(
							rational.createRational(50n, 1n),
							integerTwo(),
						),
					).toEqual(rational.createRational(100n, 1n))
				})
			})

			describe("divide", () => {
				it("divides 2 rationals correctly", () => {
					expect(
						rational.divideBy__overload$1(
							rationalOne(),
							rationalOne(),
						),
					).toEqual(rational.createRational(1n, 1n))

					expect(
						rational.divideBy__overload$1(
							rationalOne(),
							rationalTwo(),
						),
					).toEqual(rational.createRational(1n, 2n))

					expect(
						rational.divideBy__overload$1(
							rationalOne(),
							rationalOneHalf(),
						),
					).toEqual(rational.createRational(2n, 1n))

					expect(
						rational.divideBy__overload$1(
							rationalHundred(),
							rationalTwo(),
						),
					).toEqual(rational.createRational(100n, 2n))
				})

				it("divides a rational and an integer correctly", () => {
					expect(
						rational.divideBy__overload$2(
							rationalOne(),
							integerOne(),
						),
					).toEqual(rationalOne())

					expect(
						rational.divideBy__overload$2(
							rational.createRational(2n, 1n),
							integerTwo(),
						),
					).toEqual(rational.createRational(2n, 2n))

					expect(
						rational.divideBy__overload$2(
							rationalHundred(),
							integerTwo(),
						),
					).toEqual(rational.createRational(100n, 2n))
				})

				it("returns Nothing when dividing by zero", () => {
					expect(
						rational.divideBy__overload$1(
							rationalOne(),
							rational.createRational(0n, 1n),
						),
					).toEqual(nothing())

					expect(
						rational.divideBy__overload$2(
							rationalOne(),
							integerZero(),
						),
					).toEqual(nothing())
				})
			})

			describe("isLessThan", () => {
				it("returns true if the first number is less than the second", () => {
					expect(
						rational.isLessThan__overload$1(
							rationalOneHalf(),
							rationalOne(),
						),
					).toEqual(booleanTrue())

					expect(
						rational.isLessThan__overload$1(
							rationalOneHalf(),
							rationalTwo(),
						),
					).toEqual(booleanTrue())

					expect(
						rational.isLessThan__overload$1(
							rationalOneHalf(),
							rationalHundred(),
						),
					).toEqual(booleanTrue())

					expect(
						rational.isLessThan__overload$1(
							rationalOne(),
							rationalTwo(),
						),
					).toEqual(booleanTrue())

					expect(
						rational.isLessThan__overload$1(
							rationalOne(),
							rationalHundred(),
						),
					).toEqual(booleanTrue())

					expect(
						rational.isLessThan__overload$1(
							rationalTwo(),
							rationalHundred(),
						),
					).toEqual(booleanTrue())

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
						rational.isLessThan__overload$1(
							rationalOneHalf(),
							rationalOneHalf(),
						),
					).toEqual(booleanFalse())

					expect(
						rational.isLessThan__overload$1(
							rationalOne(),
							rationalOne(),
						),
					).toEqual(booleanFalse())

					expect(
						rational.isLessThan__overload$1(
							rationalTwo(),
							rationalTwo(),
						),
					).toEqual(booleanFalse())

					expect(
						rational.isLessThan__overload$1(
							rationalHundred(),
							rationalHundred(),
						),
					).toEqual(booleanFalse())

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
						rational.isLessThan__overload$1(
							rationalHundred(),
							rationalTwo(),
						),
					).toEqual(booleanFalse())

					expect(
						rational.isLessThan__overload$1(
							rationalHundred(),
							rationalOne(),
						),
					).toEqual(booleanFalse())

					expect(
						rational.isLessThan__overload$1(
							rationalHundred(),
							rationalOneHalf(),
						),
					).toEqual(booleanFalse())

					expect(
						rational.isLessThan__overload$1(
							rationalTwo(),
							rationalOne(),
						),
					).toEqual(booleanFalse())

					expect(
						rational.isLessThan__overload$1(
							rationalTwo(),
							rationalOneHalf(),
						),
					).toEqual(booleanFalse())

					expect(
						rational.isLessThan__overload$1(
							rationalOne(),
							rationalOneHalf(),
						),
					).toEqual(booleanFalse())

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
						rational.isLessThanOrEqualTo__overload$1(
							rationalOneHalf(),
							rationalOne(),
						),
					).toEqual(booleanTrue())

					expect(
						rational.isLessThanOrEqualTo__overload$1(
							rationalOneHalf(),
							rationalTwo(),
						),
					).toEqual(booleanTrue())

					expect(
						rational.isLessThanOrEqualTo__overload$1(
							rationalOneHalf(),
							rationalHundred(),
						),
					).toEqual(booleanTrue())

					expect(
						rational.isLessThanOrEqualTo__overload$1(
							rationalOne(),
							rationalTwo(),
						),
					).toEqual(booleanTrue())

					expect(
						rational.isLessThanOrEqualTo__overload$1(
							rationalOne(),
							rationalHundred(),
						),
					).toEqual(booleanTrue())

					expect(
						rational.isLessThanOrEqualTo__overload$1(
							rationalTwo(),
							rationalHundred(),
						),
					).toEqual(booleanTrue())

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
						rational.isLessThanOrEqualTo__overload$1(
							rationalOneHalf(),
							rationalOneHalf(),
						),
					).toEqual(booleanTrue())

					expect(
						rational.isLessThanOrEqualTo__overload$1(
							rationalOne(),
							rationalOne(),
						),
					).toEqual(booleanTrue())

					expect(
						rational.isLessThanOrEqualTo__overload$1(
							rationalTwo(),
							rationalTwo(),
						),
					).toEqual(booleanTrue())

					expect(
						rational.isLessThanOrEqualTo__overload$1(
							rationalHundred(),
							rationalHundred(),
						),
					).toEqual(booleanTrue())

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
						rational.isLessThanOrEqualTo__overload$1(
							rationalHundred(),
							rationalTwo(),
						),
					).toEqual(booleanFalse())

					expect(
						rational.isLessThanOrEqualTo__overload$1(
							rationalHundred(),
							rationalOne(),
						),
					).toEqual(booleanFalse())

					expect(
						rational.isLessThanOrEqualTo__overload$1(
							rationalHundred(),
							rationalOneHalf(),
						),
					).toEqual(booleanFalse())

					expect(
						rational.isLessThanOrEqualTo__overload$1(
							rationalTwo(),
							rationalOne(),
						),
					).toEqual(booleanFalse())

					expect(
						rational.isLessThanOrEqualTo__overload$1(
							rationalTwo(),
							rationalOneHalf(),
						),
					).toEqual(booleanFalse())

					expect(
						rational.isLessThanOrEqualTo__overload$1(
							rationalOne(),
							rationalOneHalf(),
						),
					).toEqual(booleanFalse())

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
						rational.isGreaterThan__overload$1(
							rationalOneHalf(),
							rationalOne(),
						),
					).toEqual(booleanFalse())

					expect(
						rational.isGreaterThan__overload$1(
							rationalOneHalf(),
							rationalTwo(),
						),
					).toEqual(booleanFalse())

					expect(
						rational.isGreaterThan__overload$1(
							rationalOneHalf(),
							rationalHundred(),
						),
					).toEqual(booleanFalse())

					expect(
						rational.isGreaterThan__overload$1(
							rationalOne(),
							rationalTwo(),
						),
					).toEqual(booleanFalse())

					expect(
						rational.isGreaterThan__overload$1(
							rationalOne(),
							rationalHundred(),
						),
					).toEqual(booleanFalse())

					expect(
						rational.isGreaterThan__overload$1(
							rationalTwo(),
							rationalHundred(),
						),
					).toEqual(booleanFalse())

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
						rational.isGreaterThan__overload$1(
							rationalOneHalf(),
							rationalOneHalf(),
						),
					).toEqual(booleanFalse())

					expect(
						rational.isGreaterThan__overload$1(
							rationalOne(),
							rationalOne(),
						),
					).toEqual(booleanFalse())

					expect(
						rational.isGreaterThan__overload$1(
							rationalTwo(),
							rationalTwo(),
						),
					).toEqual(booleanFalse())

					expect(
						rational.isGreaterThan__overload$1(
							rationalHundred(),
							rationalHundred(),
						),
					).toEqual(booleanFalse())

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
						rational.isGreaterThan__overload$1(
							rationalHundred(),
							rationalTwo(),
						),
					).toEqual(booleanTrue())

					expect(
						rational.isGreaterThan__overload$1(
							rationalHundred(),
							rationalOne(),
						),
					).toEqual(booleanTrue())

					expect(
						rational.isGreaterThan__overload$1(
							rationalHundred(),
							rationalOneHalf(),
						),
					).toEqual(booleanTrue())

					expect(
						rational.isGreaterThan__overload$1(
							rationalTwo(),
							rationalOne(),
						),
					).toEqual(booleanTrue())

					expect(
						rational.isGreaterThan__overload$1(
							rationalTwo(),
							rationalOneHalf(),
						),
					).toEqual(booleanTrue())

					expect(
						rational.isGreaterThan__overload$1(
							rationalOne(),
							rationalOneHalf(),
						),
					).toEqual(booleanTrue())

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
						rational.isGreaterThanOrEqualTo__overload$1(
							rationalOneHalf(),
							rationalOne(),
						),
					).toEqual(booleanFalse())

					expect(
						rational.isGreaterThanOrEqualTo__overload$1(
							rationalOneHalf(),
							rationalTwo(),
						),
					).toEqual(booleanFalse())

					expect(
						rational.isGreaterThanOrEqualTo__overload$1(
							rationalOneHalf(),
							rationalHundred(),
						),
					).toEqual(booleanFalse())

					expect(
						rational.isGreaterThanOrEqualTo__overload$1(
							rationalOne(),
							rationalTwo(),
						),
					).toEqual(booleanFalse())

					expect(
						rational.isGreaterThanOrEqualTo__overload$1(
							rationalOne(),
							rationalHundred(),
						),
					).toEqual(booleanFalse())

					expect(
						rational.isGreaterThanOrEqualTo__overload$1(
							rationalTwo(),
							rationalHundred(),
						),
					).toEqual(booleanFalse())

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
						rational.isGreaterThanOrEqualTo__overload$1(
							rationalOneHalf(),
							rationalOneHalf(),
						),
					).toEqual(booleanTrue())

					expect(
						rational.isGreaterThanOrEqualTo__overload$1(
							rationalOne(),
							rationalOne(),
						),
					).toEqual(booleanTrue())

					expect(
						rational.isGreaterThanOrEqualTo__overload$1(
							rationalTwo(),
							rationalTwo(),
						),
					).toEqual(booleanTrue())

					expect(
						rational.isGreaterThanOrEqualTo__overload$1(
							rationalHundred(),
							rationalHundred(),
						),
					).toEqual(booleanTrue())

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
						rational.isGreaterThanOrEqualTo__overload$1(
							rationalHundred(),
							rationalTwo(),
						),
					).toEqual(booleanTrue())

					expect(
						rational.isGreaterThanOrEqualTo__overload$1(
							rationalHundred(),
							rationalOne(),
						),
					).toEqual(booleanTrue())

					expect(
						rational.isGreaterThanOrEqualTo__overload$1(
							rationalHundred(),
							rationalOneHalf(),
						),
					).toEqual(booleanTrue())

					expect(
						rational.isGreaterThanOrEqualTo__overload$1(
							rationalTwo(),
							rationalOne(),
						),
					).toEqual(booleanTrue())

					expect(
						rational.isGreaterThanOrEqualTo__overload$1(
							rationalTwo(),
							rationalOneHalf(),
						),
					).toEqual(booleanTrue())

					expect(
						rational.isGreaterThanOrEqualTo__overload$1(
							rationalOne(),
							rationalOneHalf(),
						),
					).toEqual(booleanTrue())

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

				it("returns the smaller of 2 rationals", () => {
					expect(
						number.lowestNumber__overload$2(
							rationalOne(),
							rationalTwo(),
						),
					).toEqual(rationalOne())

					expect(
						number.lowestNumber__overload$2(
							rationalTwo(),
							rationalOne(),
						),
					).toEqual(rationalOne())

					expect(
						number.lowestNumber__overload$2(
							rationalHundred(),
							rationalTwo(),
						),
					).toEqual(rationalTwo())

					expect(
						number.lowestNumber__overload$2(
							rationalOne(),
							rationalOneHalf(),
						),
					).toEqual(rationalOneHalf())

					expect(
						number.lowestNumber__overload$2(
							rational.createRational(-1n, 1n),
							rationalOne(),
						),
					).toEqual(rational.createRational(-1n, 1n))
				})

				it("returns the smaller number of an integer and a rational", () => {
					expect(
						number.lowestNumber__overload$3(
							integerOne(),
							rationalTwo(),
						),
					).toEqual(integerOne())

					expect(
						number.lowestNumber__overload$3(
							integerTwo(),
							rationalOne(),
						),
					).toEqual(rationalOne())

					expect(
						number.lowestNumber__overload$3(
							integerHundred(),
							rationalTwo(),
						),
					).toEqual(rationalTwo())

					expect(
						number.lowestNumber__overload$3(
							integerOne(),
							rationalOneHalf(),
						),
					).toEqual(rationalOneHalf())

					expect(
						number.lowestNumber__overload$3(
							integer.createInteger(-1n),
							rationalOne(),
						),
					).toEqual(integer.createInteger(-1n))

					expect(
						number.lowestNumber__overload$4(
							rationalOne(),
							integerTwo(),
						),
					).toEqual(rationalOne())

					expect(
						number.lowestNumber__overload$4(
							rationalTwo(),
							integerOne(),
						),
					).toEqual(integerOne())

					expect(
						number.lowestNumber__overload$4(
							rationalHundred(),
							integerTwo(),
						),
					).toEqual(integerTwo())

					expect(
						number.lowestNumber__overload$4(
							rationalOneHalf(),
							integerOne(),
						),
					).toEqual(rationalOneHalf())

					expect(
						number.lowestNumber__overload$4(
							rational.createRational(-1n, 1n),
							integerOne(),
						),
					).toEqual(rational.createRational(-1n, 1n))
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

				it("returns the larger of 2 rationals", () => {
					expect(
						number.greatestNumber__overload$2(
							rationalOne(),
							rationalTwo(),
						),
					).toEqual(rationalTwo())

					expect(
						number.greatestNumber__overload$2(
							rationalTwo(),
							rationalOne(),
						),
					).toEqual(rationalTwo())

					expect(
						number.greatestNumber__overload$2(
							rationalHundred(),
							rationalTwo(),
						),
					).toEqual(rationalHundred())

					expect(
						number.greatestNumber__overload$2(
							rationalOne(),
							rationalOneHalf(),
						),
					).toEqual(rationalOne())

					expect(
						number.greatestNumber__overload$2(
							rational.createRational(-1n, 1n),
							rationalOne(),
						),
					).toEqual(rationalOne())
				})

				it("returns the larger number of an integer and a rational", () => {
					expect(
						number.greatestNumber__overload$3(
							integerOne(),
							rationalTwo(),
						),
					).toEqual(rationalTwo())

					expect(
						number.greatestNumber__overload$3(
							integerTwo(),
							rationalOne(),
						),
					).toEqual(integerTwo())

					expect(
						number.greatestNumber__overload$3(
							integerHundred(),
							rationalTwo(),
						),
					).toEqual(integerHundred())

					expect(
						number.greatestNumber__overload$3(
							integerOne(),
							rationalOneHalf(),
						),
					).toEqual(integerOne())

					expect(
						number.greatestNumber__overload$3(
							integer.createInteger(-1n),
							rationalOne(),
						),
					).toEqual(rationalOne())

					expect(
						number.greatestNumber__overload$4(
							rationalOne(),
							integerTwo(),
						),
					).toEqual(integerTwo())

					expect(
						number.greatestNumber__overload$4(
							rationalTwo(),
							integerOne(),
						),
					).toEqual(rationalTwo())

					expect(
						number.greatestNumber__overload$4(
							rationalHundred(),
							integerTwo(),
						),
					).toEqual(rationalHundred())

					expect(
						number.greatestNumber__overload$4(
							rationalOneHalf(),
							integerOne(),
						),
					).toEqual(integerOne())

					expect(
						number.greatestNumber__overload$4(
							rational.createRational(-1n, 1n),
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
							list.createList([rationalOne()]),
							list.createList([rationalOne()]),
						),
					).toEqual(booleanTrue())

					expect(
						list.is(
							list.createList([
								stringEmpty(),
								integerOne(),
								rationalHundred(),
								nothing(),
								booleanFalse(),
							]),
							list.createList([
								stringEmpty(),
								integerOne(),
								rationalHundred(),
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
								rationalHundred(),
								nothing(),
								booleanFalse(),
							]),
							list.createList([
								stringEmpty(),
								integerOne(),
								nothing(),
								rationalHundred(),
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
							list.createList([integerOne(), rationalTwo()]),
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
							list.createList([rationalOne()]),
							list.createList([rationalOneHalf()]),
						),
					).toEqual(booleanFalse())

					expect(
						list.is(
							list.createList([
								stringEmpty(),
								integerOne(),
								rationalHundred(),
								nothing(),
								booleanFalse(),
							]),
							list.createList([
								stringEmpty(),
								integerOne(),
								rationalHundred(),
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
							list.createList([integerOne(), rationalTwo()]),
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
							list.createList([rationalOne()]),
							list.createList([rationalOne()]),
						),
					).toEqual(booleanFalse())

					expect(
						list.isNot(
							list.createList([
								stringEmpty(),
								integerOne(),
								rationalHundred(),
								nothing(),
								booleanFalse(),
							]),
							list.createList([
								stringEmpty(),
								integerOne(),
								rationalHundred(),
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
								rationalHundred(),
								nothing(),
								booleanFalse(),
							]),
							list.createList([
								stringEmpty(),
								integerOne(),
								nothing(),
								rationalHundred(),
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
							list.createList([integerOne(), rationalTwo()]),
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
							list.createList([rationalOne()]),
							list.createList([rationalOneHalf()]),
						),
					).toEqual(booleanTrue())

					expect(
						list.isNot(
							list.createList([
								stringEmpty(),
								integerOne(),
								rationalHundred(),
								nothing(),
								booleanFalse(),
							]),
							list.createList([
								stringEmpty(),
								integerOne(),
								rationalHundred(),
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
								rationalOneHalf(),
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
						list.hasItems(list.createList([rationalOne()])),
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
						list.isEmpty(list.createList([rationalOne()])),
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
						list.firstItem__overload$1(
							list.createList([integerTwo()]),
						),
					).toEqual(integerTwo())

					expect(
						list.firstItem__overload$1(
							list.createList([integerTwo(), integerOne()]),
						),
					).toEqual(integerTwo())

					expect(
						list.firstItem__overload$1(
							list.createList([
								integerTwo(),
								integerOne(),
								integerHundred(),
							]),
						),
					).toEqual(integerTwo())

					expect(
						list.firstItem__overload$1(
							list.createList([integerHundred()]),
						),
					).toEqual(integerHundred())
				})

				it("returns nothing if the list is empty", () => {
					expect(list.firstItem__overload$1(listEmpty())).toEqual(
						nothing(),
					)
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
									return booleanTrue()
								} else {
									return booleanFalse()
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
									return booleanTrue()
								} else {
									return booleanFalse()
								}
							},
						),
					).toEqual(list.createList([integerZero(), integerTwo()]))

					expect(
						list.removeEvery__overload$2(
							integerList,
							(item: integer.IntegerType) => {
								if (item.value === integerTwo().value) {
									return booleanTrue()
								} else {
									return booleanFalse()
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
									return booleanTrue()
								} else {
									return booleanFalse()
								}
							},
						),
					).toEqual(list.createList([booleanFalse()]))

					expect(
						list.removeEvery__overload$2(
							list.createList([booleanTrue(), booleanFalse()]),
							(item: boolean.BooleanType) => {
								if (item.value === booleanFalse().value) {
									return booleanTrue()
								} else {
									return booleanFalse()
								}
							},
						),
					).toEqual(list.createList([booleanTrue()]))
				})
			})

			describe("removeLast", () => {
				it("removed the lastItem item from the list", () => {
					expect(
						list.removeLast__overload$1(
							list.createList([integerOne()]),
						),
					).toEqual(listEmpty())

					expect(
						list.removeLast__overload$1(
							list.createList([integerOne(), integerTwo()]),
						),
					).toEqual(list.createList([integerOne()]))

					expect(
						list.removeLast__overload$1(
							list.createList([
								integerOne(),
								integerTwo(),
								integerHundred(),
							]),
						),
					).toEqual(list.createList([integerOne(), integerTwo()]))

					expect(
						list.removeLast__overload$1(
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
					expect(list.removeLast__overload$1(listEmpty())).toEqual(
						listEmpty(),
					)
				})

				it("removes the given amount of items from the end", () => {
					const threeItems = () =>
						list.createList([
							integerOne(),
							integerTwo(),
							integerHundred(),
						])

					expect(
						list.removeLast__overload$2(threeItems(), integerOne()),
					).toEqual(list.createList([integerOne(), integerTwo()]))

					expect(
						list.removeLast__overload$2(threeItems(), integerTwo()),
					).toEqual(list.createList([integerOne()]))
				})

				it("keeps every item when the amount is below one", () => {
					expect(
						list.removeLast__overload$2(
							list.createList([integerOne(), integerTwo()]),
							integerZero(),
						),
					).toEqual(list.createList([integerOne(), integerTwo()]))
				})

				it("returns an empty list when the amount reaches the length", () => {
					expect(
						list.removeLast__overload$2(
							list.createList([integerOne(), integerTwo()]),
							integerTwo(),
						),
					).toEqual(listEmpty())

					// NOTE: Far beyond a 32 bit index — the guard has to read
					// the bigint, not the narrowed Number.
					expect(
						list.removeLast__overload$2(
							list.createList([integerOne(), integerTwo()]),
							integer.createInteger(2n ** 40n),
						),
					).toEqual(listEmpty())

					expect(
						list.removeLast__overload$2(listEmpty(), integerOne()),
					).toEqual(listEmpty())
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

			describe("firstItem", () => {
				it("finds the first item the check accepts", () => {
					const greaterThanOne = (item: integer.IntegerType) =>
						boolean.createBoolean(item.value > 1n)

					expect(
						list.firstItem__overload$2(
							list.createList([
								integerOne(),
								integerTwo(),
								integerHundred(),
							]),
							greaterThanOne,
						),
					).toEqual(integerTwo())
				})

				it("returns nothing when nothing is accepted", () => {
					const never = () => booleanFalse()

					expect(
						list.firstItem__overload$2(
							list.createList([integerOne(), integerTwo()]),
							never,
						),
					).toEqual(nothing())
					expect(
						list.firstItem__overload$2(listEmpty(), never),
					).toEqual(nothing())
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

			describe("itemAt", () => {
				it("returns the item at a position inside the list", () => {
					expect(
						list.itemAt(
							list.createList([integerOne(), integerTwo()]),
							integerOne(),
						),
					).toEqual(integerTwo())
				})

				it("returns nothing for a position outside the list", () => {
					expect(
						list.itemAt(
							list.createList([integerOne()]),
							integerTwo(),
						),
					).toEqual(nothing())
					expect(
						list.itemAt(
							list.createList([integerOne()]),
							integer.createInteger(-1n),
						),
					).toEqual(nothing())
				})
			})

			describe("firstIndexOf", () => {
				it("gives the position of the first equal item", () => {
					expect(
						list.firstIndexOf(
							list.createList([
								integerTwo(),
								integerOne(),
								integerOne(),
							]),
							integerOne(),
						),
					).toEqual(integerOne())
				})

				it("gives nothing when the item is absent", () => {
					expect(
						list.firstIndexOf(
							list.createList([integerOne()]),
							integerTwo(),
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

			describe("reversed", () => {
				it("reverses without mutating the original", () => {
					const original = list.createList([
						integerOne(),
						integerTwo(),
						integerHundred(),
					])

					expect(list.reversed(original)).toEqual(
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
					) => integer.compareTo(first, second)

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

			describe("anyItem and everyItem", () => {
				const greaterThanOne = (item: integer.IntegerType) =>
					boolean.createBoolean(item.value > 1n)

				it("anyItem is true when some item is accepted", () => {
					expect(
						list.anyItem(
							list.createList([integerOne(), integerTwo()]),
							greaterThanOne,
						),
					).toEqual(booleanTrue())
					expect(
						list.anyItem(
							list.createList([integerOne()]),
							greaterThanOne,
						),
					).toEqual(booleanFalse())
				})

				it("everyItem is true only when all are — vacuously for empty", () => {
					expect(
						list.everyItem(
							list.createList([integerTwo(), integerHundred()]),
							greaterThanOne,
						),
					).toEqual(booleanTrue())
					expect(
						list.everyItem(
							list.createList([integerOne(), integerTwo()]),
							greaterThanOne,
						),
					).toEqual(booleanFalse())
					expect(list.everyItem(listEmpty(), greaterThanOne)).toEqual(
						booleanTrue(),
					)
				})
			})

			describe("countOf", () => {
				it("counts equal items", () => {
					expect(
						list.countOf__overload$1(
							list.createList([
								integerOne(),
								integerTwo(),
								integerOne(),
							]),
							integerOne(),
						),
					).toEqual(integerTwo())
				})

				it("counts accepted items", () => {
					const greaterThanOne = (item: integer.IntegerType) =>
						boolean.createBoolean(item.value > 1n)

					expect(
						list.countOf__overload$2(
							list.createList([
								integerOne(),
								integerTwo(),
								integerHundred(),
							]),
							greaterThanOne,
						),
					).toEqual(integerTwo())
				})
			})

			describe("insertAt", () => {
				it("inserts before the position", () => {
					expect(
						list.insertAt(
							list.createList([integerOne(), integerHundred()]),
							integerOne(),
							integerTwo(),
						),
					).toEqual(
						list.createList([
							integerOne(),
							integerTwo(),
							integerHundred(),
						]),
					)
				})

				it("clamps so it always inserts — before the start or past the end", () => {
					expect(
						list.insertAt(
							list.createList([integerOne()]),
							integer.createInteger(-5n),
							integerZero(),
						),
					).toEqual(list.createList([integerZero(), integerOne()]))
					expect(
						list.insertAt(
							list.createList([integerOne()]),
							integer.createInteger(99n),
							integerTwo(),
						),
					).toEqual(list.createList([integerOne(), integerTwo()]))
				})
			})

			describe("replaceAt", () => {
				it("replaces the item at the position", () => {
					expect(
						list.replaceAt(
							list.createList([integerOne(), integerTwo()]),
							integerZero(),
							integerHundred(),
						),
					).toEqual(list.createList([integerHundred(), integerTwo()]))
				})

				it("leaves the list unchanged for a position outside it", () => {
					expect(
						list.replaceAt(
							list.createList([integerOne()]),
							integerTwo(),
							integerHundred(),
						),
					).toEqual(list.createList([integerOne()]))
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
			// exercises them end to end. Only the runtime `anyIs` and the
			// numeric `compareTo` remain native and keep their unit tests.
			it("compares Ordering values with anyIs", () => {
				expect(anyIs(ordering.less, ordering.less)).toBeTrue()
				expect(anyIs(ordering.less, ordering.equal)).toBeFalse()
				expect(anyIs(ordering.less, integerOne())).toBeFalse()
			})

			it("orders Integers with compareTo", () => {
				expect(integer.compareTo(integerOne(), integerTwo())).toBe(
					ordering.less,
				)
				expect(integer.compareTo(integerTwo(), integerTwo())).toBe(
					ordering.equal,
				)
				expect(integer.compareTo(integerHundred(), integerTwo())).toBe(
					ordering.greater,
				)
			})

			it("orders Rationals with compareTo", () => {
				expect(
					rational.compareTo(rationalOneHalf(), rationalOne()),
				).toBe(ordering.less)
				expect(rational.compareTo(rationalOne(), rationalOne())).toBe(
					ordering.equal,
				)
				expect(rational.compareTo(rationalTwo(), rationalOne())).toBe(
					ordering.greater,
				)
			})
		})

		describe("Protocol runtime gap fills", () => {
			it("represents a String as itself", () => {
				expect(string.toString(string.createString("text"))).toEqual(
					string.createString("text"),
				)
			})

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
			it("compares numerically across members", () => {
				expect(number.is(integerOne(), rationalOne()).value).toBe(true)
				expect(number.is(integerOne(), rationalOneHalf()).value).toBe(
					false,
				)
				expect(
					number.isNot(integerOne(), rationalOneHalf()).value,
				).toBe(true)
				expect(number.is(integerTwo(), integerTwo()).value).toBe(true)
			})

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

			it("represents each member in its own notation", () => {
				expect(number.toString(integerTwo())).toEqual(
					string.createString("2"),
				)
				expect(number.toString(rationalOneHalf())).toEqual(
					string.createString("1/2"),
				)
			})

			it("orders with the isLessThan family, reading compareTo", () => {
				// NOTE: 1/2 < 1, so the strict pair splits and the
				// or-equal-to pair follows the strict one.
				expect(
					number.isLessThan(rationalOneHalf(), integerOne()).value,
				).toBe(true)
				expect(
					number.isGreaterThan(rationalOneHalf(), integerOne()).value,
				).toBe(false)
				expect(
					number.isLessThanOrEqualTo(rationalOneHalf(), integerOne())
						.value,
				).toBe(true)

				// NOTE: 1 == 1/1, so only the or-equal-to members hold.
				expect(
					number.isLessThan(integerOne(), rationalOne()).value,
				).toBe(false)
				expect(
					number.isLessThanOrEqualTo(integerOne(), rationalOne())
						.value,
				).toBe(true)
				expect(
					number.isGreaterThanOrEqualTo(integerOne(), rationalOne())
						.value,
				).toBe(true)
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
