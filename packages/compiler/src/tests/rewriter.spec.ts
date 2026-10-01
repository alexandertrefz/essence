import { describe, expect, it } from "bun:test"

import type { common } from "@essence-lang/interfaces"
import * as boolean from "@essence-lang/runtime/Boolean"
import * as integer from "@essence-lang/runtime/Integer"
import { anyIs, anyIsNot } from "@essence-lang/runtime/internalHelpers"
import * as list from "@essence-lang/runtime/List"
import * as number from "@essence-lang/runtime/Number"
import * as optional from "@essence-lang/runtime/Optional"
import * as ordering from "@essence-lang/runtime/Ordering"
import * as rational from "@essence-lang/runtime/Rational"
import * as record from "@essence-lang/runtime/Record"
import * as side from "@essence-lang/runtime/Side"
import * as string from "@essence-lang/runtime/String"
import {
	type AnyType,
	dispatchMethod,
	isValueOfType,
	noCaseMatched,
} from "@essence-lang/runtime/type"

import { containsErrors } from "../diagnostics/index"
import { enrich } from "../enricher/index"
import {
	defaultOptimiserOptions,
	optimise,
	type OptimiserOptions,
} from "../optimiser/index"
import { parseWithDiagnostics } from "../parser/index"
import {
	emittedIdentity,
	type ModuleInput,
	rewrite,
	rewriteModules,
} from "../rewriter/index"
import { simplify } from "../simplifier/index"
import { validate } from "../validator/index"

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

// `Optional#Empty`, a Case with no members. It equals only itself and must not
// be confused with the structurally identical empty Record. Cast because
// `CaseInstanceType` is kept out of `AnyType`, as at the emitted call sites.
const optionalEmpty = () => optional.createEmpty() as unknown as AnyType

// `Integer.is` and `String.is` are written in Essence. These spell out the
// answer each gives, as the witnesses passed at a `List<Integer>` or
// `List<String>` call site.
const integerIs = (first: integer.IntegerType, second: integer.IntegerType) =>
	boolean.createBoolean(first.value === second.value)

const stringIs = (first: string.StringType, second: string.StringType) =>
	boolean.createBoolean(first.value === second.value)

// Two Lists of Integers hold the same items, asked as the language asks it.
// An edit may answer with a box over the receiver's runs, which no spec may
// pin.
const sameItems = (
	first: list.ListType<integer.IntegerType>,
	second: list.ListType<integer.IntegerType>,
) => list.is(first, second, { is: integerIs })

describe("Rewriter", () => {
	describe("Runtime", () => {
		describe("Internal Helpers", () => {
			describe("anyIs", () => {
				it("returns true if the elements are identical", () => {
					expect(anyIs(optionalEmpty(), optionalEmpty())).toBeTrue()

					expect(
						anyIs(
							optional.createValue(integerOne()) as never,
							optional.createValue(integerOne()) as never,
						),
					).toBeTrue()

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

				// `Optional#Empty` and the empty Record differ only by the tag.
				// `#Empty` and `#Value` are one Choice but different Cases.
				it("returns false if the elements are different", () => {
					expect(anyIs(optionalEmpty(), booleanTrue())).toBeFalse()

					expect(anyIs(optionalEmpty(), booleanFalse())).toBeFalse()

					expect(anyIs(optionalEmpty(), integerOne())).toBeFalse()

					expect(anyIs(optionalEmpty(), rationalOne())).toBeFalse()

					expect(anyIs(optionalEmpty(), stringEmpty())).toBeFalse()

					expect(anyIs(optionalEmpty(), listEmpty())).toBeFalse()

					expect(anyIs(optionalEmpty(), recordEmpty())).toBeFalse()

					expect(
						anyIs(
							optionalEmpty(),
							optional.createValue(integerOne()) as never,
						),
					).toBeFalse()

					expect(
						anyIs(
							optional.createValue(integerOne()) as never,
							optional.createValue(integerTwo()) as never,
						),
					).toBeFalse()

					expect(anyIs(booleanTrue(), optionalEmpty())).toBeFalse()

					expect(anyIs(booleanFalse(), optionalEmpty())).toBeFalse()

					expect(anyIs(integerOne(), optionalEmpty())).toBeFalse()

					expect(anyIs(rationalOne(), optionalEmpty())).toBeFalse()

					expect(anyIs(stringEmpty(), optionalEmpty())).toBeFalse()

					expect(anyIs(listEmpty(), optionalEmpty())).toBeFalse()

					expect(anyIs(recordEmpty(), optionalEmpty())).toBeFalse()
				})
			})

			describe("anyIsNot", () => {
				it("returns false if the elements are identical", () => {
					expect(
						anyIsNot(optionalEmpty(), optionalEmpty()),
					).toBeFalse()

					expect(
						anyIsNot(
							optional.createValue(integerOne()) as never,
							optional.createValue(integerOne()) as never,
						),
					).toBeFalse()

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
					expect(anyIsNot(optionalEmpty(), booleanTrue())).toBeTrue()

					expect(anyIsNot(optionalEmpty(), booleanFalse())).toBeTrue()

					expect(anyIsNot(optionalEmpty(), integerOne())).toBeTrue()

					expect(anyIsNot(optionalEmpty(), rationalOne())).toBeTrue()

					expect(anyIsNot(optionalEmpty(), stringEmpty())).toBeTrue()

					expect(anyIsNot(optionalEmpty(), listEmpty())).toBeTrue()

					expect(anyIsNot(optionalEmpty(), recordEmpty())).toBeTrue()

					expect(
						anyIsNot(
							optionalEmpty(),
							optional.createValue(integerOne()) as never,
						),
					).toBeTrue()

					expect(
						anyIsNot(
							optional.createValue(integerOne()) as never,
							optional.createValue(integerTwo()) as never,
						),
					).toBeTrue()

					expect(anyIsNot(booleanTrue(), optionalEmpty())).toBeTrue()

					expect(anyIsNot(booleanFalse(), optionalEmpty())).toBeTrue()

					expect(anyIsNot(integerOne(), optionalEmpty())).toBeTrue()

					expect(anyIsNot(rationalOne(), optionalEmpty())).toBeTrue()

					expect(anyIsNot(stringEmpty(), optionalEmpty())).toBeTrue()

					expect(anyIsNot(listEmpty(), optionalEmpty())).toBeTrue()

					expect(anyIsNot(recordEmpty(), optionalEmpty())).toBeTrue()
				})
			})
		})

		describe("type", () => {
			describe("isValueOfType", () => {
				it("returns true when the type is the same", () => {
					expect(
						isValueOfType(optionalEmpty(), {
							type: "Case",
							choice: "Optional",
							name: "Empty",
							members: {},
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

				// `Optional#Empty` and the empty Record carry the same members,
				// none, so only the tag tells them apart, in both directions.
				it("returns false when the type is different", () => {
					expect(
						isValueOfType(optionalEmpty(), {
							type: "String",
						}),
					).toBeFalse()

					expect(
						isValueOfType(optionalEmpty(), {
							type: "Boolean",
						}),
					).toBeFalse()

					expect(
						isValueOfType(optionalEmpty(), {
							type: "Integer",
						}),
					).toBeFalse()

					expect(
						isValueOfType(optionalEmpty(), {
							type: "Rational",
						}),
					).toBeFalse()

					expect(
						isValueOfType(optionalEmpty(), {
							type: "Case",
							choice: "Optional",
							name: "Value",
							members: { item: { type: "Integer" } },
						}),
					).toBeFalse()

					expect(
						isValueOfType(optionalEmpty(), {
							type: "Record",
							members: {},
						}),
					).toBeFalse()

					expect(
						isValueOfType(recordEmpty(), {
							type: "Case",
							choice: "Optional",
							name: "Empty",
							members: {},
						}),
					).toBeFalse()
				})

				it("narrows Lists by the items they hold", () => {
					// The empty List fits any List matcher, as an empty literal
					// is assignable to any List.
					expect(
						isValueOfType(listEmpty(), {
							type: "List",
							itemType: {
								type: "String",
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

				// A Record Matcher naming a callback member must match a value
				// whose member is a Function.
				it("matches a Function by its callability", () => {
					let functionType: common.FunctionType = {
						type: "Function",
						generics: [],
						parameterTypes: [
							{ name: null, type: { type: "Integer" } },
						],
						returnType: { type: "Integer" },
					}

					let double = (value: integer.IntegerType) =>
						integer.product(value.value, 2)

					// A Function value carries no Type key and its Signature is
					// erased, so `typeof` is the whole check.
					expect(
						isValueOfType(double as never, functionType),
					).toBeTrue()

					expect(
						isValueOfType(integerOne(), functionType),
					).toBeFalse()

					expect(
						isValueOfType(
							record.createRecord({ fn: double as never }),
							{
								type: "Record",
								members: { fn: functionType },
							},
						),
					).toBeTrue()

					expect(
						isValueOfType(
							record.createRecord({ fn: integerOne() }),
							{
								type: "Record",
								members: { fn: functionType },
							},
						),
					).toBeFalse()
				})

				// No Matcher or dispatch case can name the remaining descriptors,
				// so reaching one is a Compiler bug.
				it("throws on a descriptor it can not check", () => {
					expect(() =>
						isValueOfType(integerOne(), {
							type: "Protocol",
							name: "Comparable",
							methods: {},
						} as never),
					).toThrow("This is a bug in the Compiler.")
				})
			})

			describe("noCaseMatched", () => {
				// The end of an emitted Match's `if` chain, so a value no Case
				// matched fails here rather than as `undefined` later.
				it("throws, naming the value that matched no Case", () => {
					expect(() => noCaseMatched(integerOne())).toThrow(
						"No Case of this Match matched the Integer it was given.",
					)

					// A Case value is named by its whole tag, so the message says
					// which Case fell through.
					expect(() => noCaseMatched(optionalEmpty())).toThrow(
						"No Case of this Match matched the Optional#Empty it was given.",
					)

					expect(() =>
						noCaseMatched(((value: never) => value) as never),
					).toThrow(
						"No Case of this Match matched the Function it was given.",
					)
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
		})

		describe("String", () => {
			// The golden harness covers the Namespace's Essence bodies. These
			// specs test the natives under them.

			describe("append", () => {
				// The text, not the wrapper: a joined String may carry what
				// `append` worked out under Symbol keys, which `toEqual` sees.
				// `unicodeEdges.spec.ts` checks those.
				it("appends any string to any other", () => {
					expect(
						string.append(stringEmpty(), string.createString("a"))
							.value,
					).toBe("a")

					expect(
						string.append(stringEmpty(), string.createString("abc"))
							.value,
					).toBe("abc")

					expect(
						string.append(stringEmpty(), string.createString("!"))
							.value,
					).toBe("!")

					expect(
						string.append(stringEmpty(), string.createString(" "))
							.value,
					).toBe(" ")

					expect(
						string.append(
							string.createString("a"),
							string.createString("bc"),
						).value,
					).toBe("abc")
				})
			})

			// The text of each piece, since a piece may carry a marker or its
			// clusters. `asciiFastPath.spec.ts` and `graphemes.spec.ts` check those.
			describe("split", () => {
				it("splits correctly when splitting on an empty string", () => {
					expect(
						string
							.split__overload$1(
								string.createString("abc"),
								string.createString(""),
							)
							.value.map((piece) => piece.value),
					).toEqual(["a", "b", "c"])
				})

				it("splits an empty splitter by code point, keeping astral characters whole", () => {
					// JavaScript's `split("")` would tear the emoji into lone
					// surrogates. This one splits by grapheme cluster, as the
					// native `characters()` does.
					let emoji = string.createString("a\u{1F600}b")

					expect(
						string
							.split__overload$1(emoji, string.createString(""))
							.value.map((piece) => piece.value),
					).toEqual(["a", "\u{1F600}", "b"])
				})

				it("splits correctly using a substring", () => {
					let pieces = string.split__overload$1(
						string.createString("1 2 3"),
						string.createString(" "),
					)

					expect(pieces.value.map((piece) => piece.value)).toEqual([
						"1",
						"2",
						"3",
					])
				})

				it("splits on an astral separator", () => {
					let pieces = string.split__overload$1(
						string.createString("a\u{1F600}b\u{1F600}c"),
						string.createString("\u{1F600}"),
					)

					expect(pieces.value.map((piece) => piece.value)).toEqual([
						"a",
						"b",
						"c",
					])
				})
			})

			// The text again: a case mapping or a trim keeps the ASCII marker.
			describe("casing and trimming", () => {
				it("upper- and lower-cases", () => {
					expect(
						string.uppercase(string.createString("aB")).value,
					).toBe("AB")
					expect(
						string.lowercase(string.createString("aB")).value,
					).toBe("ab")
				})

				it("trims from either end", () => {
					// One native reads the `Side` Case; `trim()` with no
					// Argument reaches it through the frame the Compiler
					// synthesizes for the `at:` Parameter's default.
					expect(
						string.trim(string.createString("  hi  "), side.start)
							.value,
					).toBe("hi  ")
					expect(
						string.trim(string.createString("  hi  "), side.end)
							.value,
					).toBe("  hi")
					expect(
						string.trim(
							string.createString("  hi  "),
							side.bothEnds,
						).value,
					).toBe("hi")
				})
			})

			describe("compare", () => {
				it("orders lexicographically by code point", () => {
					// `String.is` reads this too.
					expect(
						string.compare__overload$1(
							string.createString("apple"),
							string.createString("banana"),
						),
					).toBe(ordering.less)
					expect(
						string.compare__overload$1(
							string.createString("banana"),
							string.createString("apple"),
						),
					).toBe(ordering.greater)
					expect(
						string.compare__overload$1(
							string.createString("apple"),
							string.createString("apple"),
						),
					).toBe(ordering.equal)
					// A prefix orders before the longer String.
					expect(
						string.compare__overload$1(
							string.createString("app"),
							string.createString("apple"),
						),
					).toBe(ordering.less)
				})
			})
		})

		describe("Integer", () => {
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
			})

			describe("toString", () => {
				it("returns the correct strings", () => {
					expect(integer.toString__overload$1(integerOne())).toEqual(
						string.createString("1"),
					)

					expect(integer.toString__overload$1(integerTwo())).toEqual(
						string.createString("2"),
					)

					expect(
						integer.toString__overload$1(integerHundred()),
					).toEqual(string.createString("100"))

					expect(
						integer.toString__overload$1(
							integer.createInteger(1000n),
						),
					).toEqual(string.createString("1000"))
				})
			})
		})

		describe("Rational", () => {
			// The first entry of `of` is fallible and answers an `Optional`. The
			// second takes a denominator proven not zero, so it answers the
			// Rational unwrapped and has no zero case.
			describe("of", () => {
				it("creates a rational", () => {
					expect(
						rational.of__overload$1(integerOne(), integerTwo()),
					).toEqual(optional.createValue(rationalOneHalf()))
				})

				it("is empty for a zero denominator", () => {
					expect(
						rational.of__overload$1(integerOne(), integerZero()),
					).toEqual(optional.createEmpty())
				})

				it("creates a rational unwrapped over a proven denominator", () => {
					expect(
						rational.of__overload$2(integerOne(), integerTwo()),
					).toEqual(rationalOneHalf())
				})
			})
		})

		describe("Number", () => {
			// The numeric List aggregates are written in Essence, and the golden
			// harness covers them.
		})

		describe("List", () => {
			// `is` takes the items' witness from the call site, so every List
			// here holds items of one Type.
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

					expect(
						list.length(list.createList([booleanTrue()])),
					).toEqual(integerOne())

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

			describe("append", () => {
				// Asked through the runtime's own `is`, since `append` may answer
				// a view over its receiver's Array rather than a fresh box.
				it("appends contents of a list to another list correctly", () => {
					expect(
						list.is(
							list.append__overload$2(
								list.createList([]),
								list.createList([integerOne()]),
							),
							list.createList([integerOne()]),
							{ is: integerIs },
						),
					).toEqual(booleanTrue())

					expect(
						list.is(
							list.append__overload$2(
								list.createList([integerOne()]),
								list.createList([integerTwo()]),
							),
							list.createList([integerOne(), integerTwo()]),
							{ is: integerIs },
						),
					).toEqual(booleanTrue())

					expect(
						list.is(
							list.append__overload$2(
								list.createList([integerOne(), integerTwo()]),
								list.createList([integerHundred()]),
							),
							list.createList([
								integerOne(),
								integerTwo(),
								integerHundred(),
							]),
							{ is: integerIs },
						),
					).toEqual(booleanTrue())
				})
			})

			describe("map", () => {
				it("applies the transform to every item", () => {
					expect(
						list.map(
							list.createList([integerOne(), integerTwo()]),
							(item: integer.IntegerType) =>
								integer.toString__overload$1(item),
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
						list.reduce__overload$1(
							list.createList([
								integerOne(),
								integerTwo(),
								integerHundred(),
							]),
							integerZero(),
							(
								accumulator: integer.IntegerType,
								item: integer.IntegerType,
							) => integer.sum(accumulator.value, item.value),
						),
					).toEqual(integer.createInteger(103n))
				})

				it("returns the starting value for the empty list", () => {
					expect(
						list.reduce__overload$1(
							listEmpty(),
							integerZero(),
							(accumulator: integer.IntegerType) => accumulator,
						),
					).toEqual(integerZero())
				})
			})

			describe("everyItem", () => {
				it("keeps just the accepted items", () => {
					const greaterThanOne = (item: integer.IntegerType) =>
						boolean.createBoolean(item.value > 1n)

					expect(
						list.everyItem__overload$1(
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

			// `item` answers `#Value` with the item for a hit and `#Empty` for a
			// miss.
			describe("item", () => {
				it("returns the item at a position inside the list", () => {
					expect(
						list.item__overload$1(
							list.createList([integerOne(), integerTwo()]),
							integerOne(),
						),
					).toEqual(optional.createValue(integerTwo()))
				})

				it("is empty for a position outside the list", () => {
					expect(
						list.item__overload$1(
							list.createList([integerOne()]),
							integerTwo(),
						),
					).toEqual(optional.createEmpty())
					// -1 names the last item, so -2 is outside a one-item List.
					expect(
						list.item__overload$1(
							list.createList([integerOne()]),
							integer.createInteger(-2n),
						),
					).toEqual(optional.createEmpty())
				})

				it("counts a negative position back from the end", () => {
					expect(
						list.item__overload$1(
							list.createList([integerOne(), integerTwo()]),
							integer.createInteger(-1n),
						),
					).toEqual(optional.createValue(integerTwo()))
					expect(
						list.item__overload$1(
							list.createList([integerOne(), integerTwo()]),
							integer.createInteger(-2n),
						),
					).toEqual(optional.createValue(integerOne()))
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
					// [1, 3): positions 1 and 2, stopping before 3.
					expect(
						sameItems(
							list.slice(
								abcd(),
								integerOne(),
								integer.createInteger(3n),
							),
							list.createList([integerOne(), integerTwo()]),
						),
					).toEqual(booleanTrue())
				})

				it("clamps each end to the list", () => {
					// -5 reaches past the start of a four item List, so it settles
					// on zero rather than wrapping again.
					expect(
						sameItems(
							list.slice(
								abcd(),
								integer.createInteger(-5n),
								integer.createInteger(99n),
							),
							abcd(),
						),
					).toEqual(booleanTrue())
				})

				it("counts a negative end back from the end", () => {
					expect(
						sameItems(
							list.slice(
								abcd(),
								integerZero(),
								integer.createInteger(-1n),
							),
							list.createList([
								integerZero(),
								integerOne(),
								integerTwo(),
							]),
						),
					).toEqual(booleanTrue())
					expect(
						sameItems(
							list.slice(
								abcd(),
								integer.createInteger(-2n),
								integer.createInteger(-1n),
							),
							list.createList([integerTwo()]),
						),
					).toEqual(booleanTrue())
				})

				it("returns empty when the range is empty or reversed", () => {
					expect(
						list.slice(abcd(), integerTwo(), integerOne()),
					).toEqual(listEmpty())
				})

				it("clamps a position past a 32 bit index instead of wrapping", () => {
					expect(
						sameItems(
							list.slice(
								abcd(),
								integerZero(),
								integer.createInteger(2n ** 40n),
							),
							abcd(),
						),
					).toEqual(booleanTrue())
					// Counting back by more than a 32 bit index clamps to the
					// start.
					expect(
						sameItems(
							list.slice(
								abcd(),
								integer.createInteger(0n - 2n ** 40n),
								integer.createInteger(4n),
							),
							abcd(),
						),
					).toEqual(booleanTrue())
				})
			})

			// `remove(at:)` is native. These specs hold which positions name an
			// item and which leave the List alone.
			describe("remove", () => {
				const abcd = () =>
					list.createList([
						integerZero(),
						integerOne(),
						integerTwo(),
						integerHundred(),
					])

				it("drops the item at the position", () => {
					expect(
						sameItems(
							list.remove(abcd(), integerZero()),
							list.createList([
								integerOne(),
								integerTwo(),
								integerHundred(),
							]),
						),
					).toEqual(booleanTrue())
					expect(
						sameItems(
							list.remove(abcd(), integerTwo()),
							list.createList([
								integerZero(),
								integerOne(),
								integerHundred(),
							]),
						),
					).toEqual(booleanTrue())
					expect(
						sameItems(
							list.remove(abcd(), integer.createInteger(3n)),
							list.createList([
								integerZero(),
								integerOne(),
								integerTwo(),
							]),
						),
					).toEqual(booleanTrue())
				})

				it("counts a negative position back from the end", () => {
					expect(
						sameItems(
							list.remove(abcd(), integer.createInteger(-1n)),
							list.createList([
								integerZero(),
								integerOne(),
								integerTwo(),
							]),
						),
					).toEqual(booleanTrue())
					expect(
						sameItems(
							list.remove(abcd(), integer.createInteger(-4n)),
							list.createList([
								integerOne(),
								integerTwo(),
								integerHundred(),
							]),
						),
					).toEqual(booleanTrue())
				})

				it("leaves the List alone when the position names no item", () => {
					// At the length, past it, and reaching back past the first
					// item.
					expect(
						sameItems(
							list.remove(abcd(), integer.createInteger(4n)),
							abcd(),
						),
					).toEqual(booleanTrue())
					expect(
						sameItems(
							list.remove(abcd(), integer.createInteger(99n)),
							abcd(),
						),
					).toEqual(booleanTrue())
					expect(
						sameItems(
							list.remove(abcd(), integer.createInteger(-5n)),
							abcd(),
						),
					).toEqual(booleanTrue())
					expect(
						sameItems(
							list.remove(listEmpty(), integerZero()),
							listEmpty(),
						),
					).toEqual(booleanTrue())
				})

				it("clamps a position past a 32 bit index instead of wrapping", () => {
					expect(
						sameItems(
							list.remove(
								abcd(),
								integer.createInteger(2n ** 40n),
							),
							abcd(),
						),
					).toEqual(booleanTrue())
					expect(
						sameItems(
							list.remove(
								abcd(),
								integer.createInteger(0n - 2n ** 40n),
							),
							abcd(),
						),
					).toEqual(booleanTrue())
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

			describe("sort__overload$2", () => {
				it("orders by the comparison and is stable", () => {
					const ascending = (
						first: integer.IntegerType,
						second: integer.IntegerType,
					) => number.compare(first, second)

					expect(
						list.sort__overload$2(
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
			// The Choice's derived Methods are covered by the golden harness.
			it("compares Ordering values with anyIs", () => {
				expect(anyIs(ordering.less, ordering.less)).toBeTrue()
				expect(anyIs(ordering.less, ordering.equal)).toBeFalse()
				expect(anyIs(ordering.less, integerOne())).toBeFalse()
			})
		})

		describe("Protocol runtime gap fills", () => {
			// The golden harness covers `String.toString` and `List.toString`.
		})

		describe("Number", () => {
			// `compare` is the native that `Number.is` and the inequalities
			// read. The golden harness covers the rest.
			it("orders numerically across members", () => {
				expect(number.compare(integerOne(), rationalOneHalf())).toBe(
					ordering.greater,
				)
				expect(number.compare(rationalOneHalf(), integerOne())).toBe(
					ordering.less,
				)
				expect(number.compare(integerOne(), rationalOne())).toBe(
					ordering.equal,
				)
				expect(number.compare(integerTwo(), integerHundred())).toBe(
					ordering.less,
				)
			})
		})

		describe("Union Method dispatch", () => {
			it("runs the first case whose member Type accepts the receiver", () => {
				// The Boolean case is a stand-in, since this tests which case
				// `dispatchMethod` picks.
				let cases: Parameters<typeof dispatchMethod>[2] = [
					[
						{ type: "Boolean" },
						(() => string.createString("Boolean")) as (
							...args: Array<unknown>
						) => unknown,
						[],
					],
					[
						{ type: "Integer" },
						integer.toString__overload$1 as (
							...args: Array<unknown>
						) => unknown,
						[],
					],
				]

				expect(dispatchMethod(integerTwo(), [], cases)).toEqual(
					string.createString("2"),
				)
				expect(dispatchMethod(booleanTrue(), [], cases)).toEqual(
					string.createString("Boolean"),
				)
			})

			// A case's fifth element names the Parameters its callee defaults.
			// The indices count the receiver as 0, so a hole at `index` falls at
			// `index - 1` among the Arguments.
			it("opens the holes a branch's callee takes defaults for", () => {
				let seen: Array<Array<unknown>> = []
				let record = (
					_receiver: unknown,
					...args: Array<unknown>
				): unknown => {
					seen.push(args)

					return string.createString("ok")
				}

				let cases: Parameters<typeof dispatchMethod>[2] = [
					[
						{ type: "Integer" },
						record as (...args: Array<unknown>) => unknown,
						[],
						[],
						[1, 3],
					],
				]

				expect(
					dispatchMethod(
						integerTwo(),
						[string.createString("written")],
						cases,
					),
				).toEqual(string.createString("ok"))

				expect(seen).toEqual([
					[undefined, string.createString("written"), undefined],
				])
			})

			// The first case that accepts the receiver answers. The two cases
			// overlap, and are asked in both orders. See "Union Method dispatch"
			// in packages/runtime/DEVELOPMENT.md.
			it("runs the earlier of two cases that both accept the receiver", () => {
				let integerCase: Parameters<typeof dispatchMethod>[2][number] =
					[
						{ type: "Integer" },
						(() => string.createString("Integer")) as (
							...args: Array<unknown>
						) => unknown,
						[],
					]
				let unionCase: Parameters<typeof dispatchMethod>[2][number] = [
					{
						type: "UnionType",
						types: [{ type: "Integer" }, { type: "String" }],
					},
					(() => string.createString("Union")) as (
						...args: Array<unknown>
					) => unknown,
					[],
				]

				expect(
					dispatchMethod(integerTwo(), [], [integerCase, unionCase]),
				).toEqual(string.createString("Integer"))

				expect(
					dispatchMethod(integerTwo(), [], [unionCase, integerCase]),
				).toEqual(string.createString("Union"))
			})

			// The end of the dispatch chain, as `noCaseMatched` ends a Match.
			// Some case always accepts, so reaching it is a Compiler bug.
			it("throws when no case accepts the receiver", () => {
				let cases: Parameters<typeof dispatchMethod>[2] = [
					[
						{ type: "Integer" },
						integer.toString__overload$1 as (
							...args: Array<unknown>
						) => unknown,
						[],
					],
					[
						{ type: "Boolean" },
						(() => string.createString("Boolean")) as (
							...args: Array<unknown>
						) => unknown,
						[],
					],
				]

				expect(() => dispatchMethod(stringEmpty(), [], cases)).toThrow(
					"No dispatch case matched the receiver.",
				)

				expect(() => dispatchMethod(integerTwo(), [], [])).toThrow(
					"No dispatch case matched the receiver.",
				)
			})

			// The spies are asked only what they were handed, so each answers
			// the empty Record, as a `-> {}` Method does.
			it("appends the matched case's conformance Arguments", () => {
				let receivedArguments: Array<unknown> = []
				let method = (...args: Array<unknown>) => {
					receivedArguments = args
					return recordEmpty()
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

			// A Function literal Argument is typed by its branch, so each branch
			// carries its own copy at a position. Only the matched branch's copy
			// reaches the Method.
			it("substitutes the matched case's own Arguments by position", () => {
				let receivedArguments: Array<unknown> = []
				let method = (...args: Array<unknown>) => {
					receivedArguments = args
					return recordEmpty()
				}

				dispatchMethod(
					integerTwo(),
					["shared", "shared second"],
					[
						[{ type: "String" }, method, [], [[1, "String's own"]]],
						[
							{ type: "Integer" },
							method,
							["conformance"],
							[[1, "Integer's own"]],
						],
					],
				)

				expect(receivedArguments).toEqual([
					integerTwo(),
					"shared",
					"Integer's own",
					"conformance",
				])
			})

			// The shared Arguments are evaluated once and handed to whichever
			// case matches, so an override must not write into them.
			it("leaves the shared Arguments untouched", () => {
				let sharedArguments = ["shared"]
				let receivedArguments: Array<unknown> = []
				let method = (...args: Array<unknown>) => {
					receivedArguments = args
					return recordEmpty()
				}

				dispatchMethod(integerTwo(), sharedArguments, [
					[{ type: "Integer" }, method, [], [[0, "Integer's own"]]],
				])

				expect(receivedArguments).toEqual([
					integerTwo(),
					"Integer's own",
				])
				expect(sharedArguments).toEqual(["shared"])

				dispatchMethod(integerTwo(), sharedArguments, [
					[{ type: "Integer" }, method, [], []],
				])

				expect(receivedArguments).toEqual([integerTwo(), "shared"])
			})
		})
	})

	// Emission for Modules: one shared prelude, and Case tags spelled against
	// the entry's directory. See "A lone Program and a graph" in
	// packages/compiler/src/rewriter/DEVELOPMENT.md.
	describe("Modules", () => {
		// No graph and no file system: the paths are only the Module identity,
		// so a Program importing nothing is enriched as a Module directly.
		function moduleOf(
			filePath: string,
			source: string,
			optimiserOptions: OptimiserOptions = defaultOptimiserOptions,
		): ModuleInput {
			let parsed = parseWithDiagnostics(source)

			expect(containsErrors(parsed.diagnostics)).toBe(false)

			let enriched = enrich(parsed.program, { modulePath: filePath })

			expect(containsErrors(enriched.diagnostics)).toBe(false)
			expect(containsErrors(validate(enriched.program))).toBe(false)

			return {
				filePath,
				program: optimise(simplify(enriched.program), optimiserOptions),
			}
		}

		function declarationsOf(source: string, name: string): number {
			return (
				source.match(
					new RegExp(
						`(?:const|let|var|function)\\s+\\${name}\\b`,
						"g",
					),
				) ?? []
			).length
		}

		let printing = (value: string) =>
			`implementation {\n\tTerminal.inspect(${value}::toString())\n}\n`

		it("emits one copy of a standard library Method three Modules share", () => {
			let bundle = rewriteModules(
				[
					moduleOf("/project/Main.es", printing("true")),
					moduleOf("/project/Second.es", printing("false")),
					moduleOf("/project/deep/Third.es", printing("true")),
				],
				"/project/Main.es",
			)

			expect([...bundle.sources.keys()]).toEqual([
				"essence:$prelude",
				"essence:./Main.es",
				"essence:./Second.es",
				"essence:./deep/Third.es",
			])

			// Every Module reaches `$es_Boolean_toString`, and reachability runs
			// once over their union, so the prelude declares it once.
			let declarations = [...bundle.sources.values()].map((source) =>
				declarationsOf(source, "$es_Boolean_toString"),
			)

			expect(declarations).toEqual([1, 0, 0, 0])

			for (let specifier of [
				"essence:./Main.es",
				"essence:./Second.es",
				"essence:./deep/Third.es",
			]) {
				expect(bundle.sources.get(specifier)).toContain(
					'import { $es_Boolean_toString } from "essence:$prelude"',
				)
			}

			expect(bundle.sources.get("essence:$prelude")).toContain(
				"$es_Boolean_toString",
			)
			expect(bundle.entry).toBe("essence:./Main.es")
		})

		// A Method no Module reaches is not emitted, as for a lone Program.
		it("leaves out a Method no Module of the bundle reaches", () => {
			let bundle = rewriteModules(
				[moduleOf("/project/Main.es", printing("true"))],
				"/project/Main.es",
			)

			expect(bundle.sources.get("essence:$prelude")).not.toContain(
				"$es_List_sorted",
			)
		})

		// A Choice's identity holds a canonical path, which must not reach the
		// output. The tag and the Match descriptor both render it against the
		// entry's directory.
		it("spells a Case tag against the entry's directory", () => {
			let source = `implementation {
	choice Colour {
		Red,
		Green,
	}

	constant chosen: Colour = #Red

	Terminal.inspect(match chosen -> String {
		case Colour { <- "a Colour" }
	})
}
`
			// `elide-final-match-test` would drop a lone Handler's test, and with
			// it the descriptor, so that pass is off.
			let bundle = rewriteModules(
				[
					moduleOf("/project/deep/Main.es", source, {
						enabled: true,
						disabledPasses: new Set(["elide-final-match-test"]),
					}),
				],
				"/project/deep/Main.es",
			)
			let emitted = bundle.sources.get("essence:./Main.es")!

			expect(emitted).toContain(
				'$type.createCase("./Main.es#Colour#Red")',
			)
			expect(emitted).toContain('choice: "./Main.es#Colour"')
			expect(emitted).not.toContain("/project")
		})

		// A lone Program keeps its prelude inline, names no Module, and spells a
		// Case by its bare name, since its Choices' identities hold no path.
		it("keeps a lone Program's prelude inline and its tags bare", () => {
			let parsed = parseWithDiagnostics(`implementation {
	choice Colour {
		Red,
	}

	constant chosen: Colour = #Red

	Terminal.inspect(chosen)
	Terminal.inspect(true::toString())
}
`)
			let enriched = enrich(parsed.program)
			let generated = rewrite(optimise(simplify(enriched.program)))

			expect(declarationsOf(generated, "$es_Boolean_toString")).toBe(1)
			expect(generated).not.toContain("essence:")
			expect(generated).toContain('$type.createCase("Colour#Red")')
		})

		// A host building a Case value from one identity must stamp the tag the
		// bundle's own values carry.
		describe("emittedIdentity", () => {
			it("agrees with the tag the bundle writes", () => {
				let bundle = rewriteModules(
					[
						moduleOf(
							"/project/deep/Main.es",
							`implementation {
	choice Colour {
		Red,
	}

	constant chosen: Colour = #Red

	Terminal.inspect(chosen)
}
`,
						),
					],
					"/project/deep/Main.es",
				)

				expect(bundle.sources.get("essence:./Main.es")!).toContain(
					`"${emittedIdentity(
						"/project/deep/Main.es",
						"/project/deep/Main.es#Colour",
					)}#Red"`,
				)
			})

			it("spells a dependency's Choice relative to the entry", () => {
				expect(
					emittedIdentity(
						"/project/Main.es",
						"/project/shapes/Shapes.es#Shape",
					),
				).toBe("./shapes/Shapes.es#Shape")
				expect(
					emittedIdentity(
						"/project/deep/Main.es",
						"/project/Shared.es#Shape",
					),
				).toBe("../Shared.es#Shape")
			})

			// A builtin Choice's identity is its bare name, with no Module path
			// to render.
			it("leaves an identity with no Module path alone", () => {
				expect(emittedIdentity("/project/Main.es", "Optional")).toBe(
					"Optional",
				)
				expect(emittedIdentity("/project/Main.es", "Ordering")).toBe(
					"Ordering",
				)
				expect(emittedIdentity("/project/Main.es", "Colour#Red")).toBe(
					"Colour#Red",
				)
			})
		})
	})
})
