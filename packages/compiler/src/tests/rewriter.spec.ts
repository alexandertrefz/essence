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

// NOTE: Absence, as the language spells it — `Optional` is a nominal Choice, so
// "no value" is the payload-less Case `Optional#Empty`, a tagged value carrying
// no members at all. It stands in these tables where the deleted `nothing`
// literal used to, and it asks more of them than that literal did: a Case is
// decided by its tag first and its payload second, so it must compare equal to
// itself and to nothing else, and it must NOT be confused with the structurally
// identical empty Record.
//
// NOTE: Cast because `CaseInstanceType` is deliberately kept out of `AnyType`
// — the same cast the emitted code's own call sites need.
const optionalEmpty = () => optional.createEmpty() as unknown as AnyType

// NOTE: `Integer.is` and `String.is` are written in Essence now — so are the
// `Equatable` witnesses the bounded List Methods take. These spell out the
// answer each Essence body gives, which is what the Simplifier passes at a
// `List<Integer>` or `List<String>` call site.
const integerIs = (first: integer.IntegerType, second: integer.IntegerType) =>
	boolean.createBoolean(first.value === second.value)

const stringIs = (first: string.StringType, second: string.StringType) =>
	boolean.createBoolean(first.value === second.value)

// NOTE: Two Lists of Integers hold the same items, asked the way the language
// asks it. The edits below answer with a box over the receiver's own runs
// wherever the answer is a WINDOW of them, so the box is not shaped like the
// literal it holds the same items as — which is the runtime's business and not
// something a test may pin.
const sameItems = (
	first: list.ListType<integer.IntegerType>,
	second: list.ListType<integer.IntegerType>,
) => list.is(first, second, { is: integerIs })

describe("Rewriter", () => {
	describe("Runtime", () => {
		describe("Internal Helpers", () => {
			// NOTE: `isFirstRationalBigger` is gone — the `lowestNumber` and
			// `greatestNumber` List entries it served are written in Essence
			// now (`packages/standard-library/sources/Number.es`), folding the pairwise
			// entries, which read the members' own `compare`.

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

				// NOTE: `Optional#Empty` beside the empty Record is the pair
				// worth naming: the two are structurally identical — no
				// members on either side — and only the tag tells them apart,
				// which is exactly what a nominal Case promises. `#Empty`
				// beside `#Value` is the other: same Choice, different Case.
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

				// NOTE: The last two pairs are the ones a nominal Case earns:
				// `Optional#Empty` and the empty Record carry the very same
				// members — none — so a structural check would call each a
				// value of the other's Type. Only the tag says otherwise, and
				// it has to say it in both directions.
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
					// NOTE: Item Types erase at runtime, so the empty List
					// fits any List matcher — the same way an empty literal
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

				// NOTE: Regression test — a Function descriptor used to reach
				// the "not implemented" branch, which printed a line of
				// Compiler prose into the Program's output and answered FALSE.
				// A Record Matcher naming a callback member could therefore
				// never match: every Handler of an exhaustive Match declined,
				// and the Match answered `undefined`.
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

					// NOTE: A Function value carries no Type key — `typeof` is
					// the whole check, because the Signature is erased by the
					// time it runs.
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

				// NOTE: The descriptors that are left are Types no Matcher and
				// no dispatch case can name — reaching one is a Compiler bug,
				// and it used to be answered with a `console.log` and a false,
				// which took a silently wrong branch instead.
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
				// NOTE: The end of an emitted Match's `if` chain. It used to
				// simply not exist: the wrapper fell off its end and answered
				// `undefined`, which is not an Essence value, so the failure
				// surfaced somewhere else entirely — as a `TypeError` out of
				// whatever read the missing Type key next.
				it("throws, naming the value that matched no Case", () => {
					expect(() => noCaseMatched(integerOne())).toThrow(
						"No Case of this Match matched the Integer it was given.",
					)

					// NOTE: A Case value is named by its whole tag, Choice and
					// Case both — `Optional#Empty`, not `Optional` — which is
					// what makes the message say WHICH Case fell through.
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

			// NOTE: `isNot` is not here because it is not native any more — it
			// is written in Essence in `packages/standard-library/sources/Boolean.es` and reaches the
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
			// (`packages/standard-library/sources/Boolean.es`); the golden harness covers them.
		})

		describe("String", () => {
			// NOTE: Most of this Namespace is written in Essence now
			// (`packages/standard-library/sources/String.es`) and the golden harness covers it —
			// `isEmpty`, `is`, `prepend`, `contains`, `length`, `characters`,
			// `character`, `trimmed`, `startsWith`, `endsWith`, `repeat`,
			// `reverse`, `slice`, `firstIndex`, `pad`,
			// and `toString`, alongside the negations
			// (`hasAnyContent`, `isNot`, `doesNotContain`, `doesNotStart`,
			// `doesNotEnd`) that moved earlier. What is left below is the
			// native floor those Essence bodies stand on, and it is where the
			// code-point behaviour is actually decided.

			describe("append", () => {
				// NOTE: The TEXT, not the wrapper. A joined String may carry
				// what `append` worked out about it — that it is ASCII, and
				// how many characters it therefore has — under Symbol keys,
				// and `toEqual` sees those where `Object.keys` and everything
				// else that reads a value does not. What this is about is
				// which characters the join holds, so that is what it asks
				// for; `unicodeEdges.spec.ts` is where the remembered answers
				// are held to account.
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
					let pieces = string.split(
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
					let pieces = string.split(
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

			describe("casing and trimming", () => {
				it("upper- and lower-cases", () => {
					expect(string.uppercase(string.createString("aB"))).toEqual(
						string.createString("AB"),
					)
					expect(string.lowercase(string.createString("aB"))).toEqual(
						string.createString("ab"),
					)
				})

				it("trims from either end", () => {
					// NOTE: One native reads the `Side` Case; `trim()` is the Essence
					// entry that passes `BothEnds`.
					expect(
						string.trim__overload$2(
							string.createString("  hi  "),
							side.start,
						),
					).toEqual(string.createString("hi  "))
					expect(
						string.trim__overload$2(
							string.createString("  hi  "),
							side.end,
						),
					).toEqual(string.createString("  hi"))
					expect(
						string.trim__overload$2(
							string.createString("  hi  "),
							side.bothEnds,
						),
					).toEqual(string.createString("hi"))
				})
			})

			// NOTE: `replaceEvery` is now written in Essence
			// (`split(on part)::join(with replacement)`, with the empty part a
			// no-op), so it is no longer a runtime native to test here — its
			// behaviour, the empty part included, is covered by the stdlib
			// golden harness.

			describe("compare", () => {
				it("orders lexicographically by code point", () => {
					// NOTE: This is also the whole of String equality —
					// `String.is` is `compare(other)::is(Ordering#Equal)` in
					// Essence.
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
					// NOTE: A prefix orders before the longer String.
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
			// NOTE: isNot / isOdd are implemented in Essence now (packages/standard-library/sources/Integer.es); the golden harness covers them.

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

			// NOTE: the Rational-operand entries of `add`, `multiply` and the
			// four comparisons are written in Essence now
			// (`packages/standard-library/sources/Integer.es`) — each is the flipped
			// call onto Rational's own mixed entry — and the golden harness
			// covers them. Only the Integer-Integer entries stay native above.

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
			// NOTE: The FIRST entry of `of` is fallible, and fallibility is
			// `Optional`, a nominal generic Choice — so the answer is a tagged
			// Case either way: `#Value` carrying the Rational under `item`, or
			// the payload-less `#Empty`. No Union's SHAPE means "missing" any
			// more; the tag says it. The Rational itself is still asserted on in
			// full, one wrapper deeper.
			//
			// NOTE: The SECOND entry is the same construction over a denominator
			// the Compiler proved is not zero, so it answers with the Rational
			// itself and there is no wrapper at all. It is reachable only through
			// that proof, which is why there is no zero case to assert here — a
			// caller with a zero denominator can not have reached it.
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

			// NOTE: is, isNot, compare and subtract were already Essence; the
			// whole arithmetic cluster followed — `add`, `multiply`, `divide`,
			// all four comparisons, `round`, `truncate`, `parse` and the
			// no-Argument `toString` are written in Essence now
			// (`packages/standard-library/sources/Rational.es`), on the lowest-terms
			// accessors and `Rational.of`, and the golden harness covers every
			// one. Only `of`, the accessors, `raise`, `squareRoot`, `compare`,
			// the decimal `toString(formatAs:)` and the Algebraic-operand
			// `divide` stay native.
		})

		describe("Number", () => {
			// NOTE: every `lowestNumber`/`greatestNumber` overload is
			// implemented in Essence now (`packages/standard-library/sources/Number.es`)
			// — the List forms fold the pairwise ones — as are `sum`,
			// `product` and `average`. The golden harness covers them all;
			// only the constants and the covering `compare` stay native.
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

			// NOTE: isNot / hasItems / doesNotContain are implemented in Essence now (packages/standard-library/sources/List.es); the golden harness covers them.

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

			// NOTE: isEmpty / firstItem (both forms) / lastItem / removeFirst (both
			// forms) / removeEvery (both forms) / removeLast (both forms) /
			// removeDuplicates / prepend (both forms) / append(_:) / contains /
			// anyItem / everyItem / count (both forms) / insert / replace /
			// partition / sorted / repeat are implemented in Essence now
			// (packages/standard-library/sources/List.es), so there is no runtime Function left to call
			// here. The golden harness covers them end to end; the entries of a
			// mixed `overload` block that are still native keep their tests below.
			// `remove(at:)` came BACK from Essence and has a describe of its own
			// beside `slice`.

			describe("append", () => {
				// NOTE: Asked through the runtime's own `is` rather than of the
				// boxes themselves. A List answers its ITEMS; how it holds them
				// is the runtime's business, and `append` may answer a List
				// sharing the Array its receiver holds, under a view of its own
				// — so two Lists of the same items are not the same object and
				// never were required to be.
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

			// NOTE: `item` is fallible, and fallibility is `Optional`, a
			// nominal generic Choice — so a hit answers `#Value` carrying the
			// item under `item`, and a miss answers the payload-less `#Empty`.
			// Which item was found is still asserted on in full, one wrapper
			// deeper; the wrapper is also what keeps a List whose items are
			// themselves Optionals unambiguous, which no flattening Union
			// could.
			describe("item", () => {
				it("returns the item at a position inside the list", () => {
					expect(
						list.item(
							list.createList([integerOne(), integerTwo()]),
							integerOne(),
						),
					).toEqual(optional.createValue(integerTwo()))
				})

				it("is empty for a position outside the list", () => {
					expect(
						list.item(
							list.createList([integerOne()]),
							integerTwo(),
						),
					).toEqual(optional.createEmpty())
					// NOTE: -1 names the last item, so the position that falls
					// outside a one-item List from below is -2.
					expect(
						list.item(
							list.createList([integerOne()]),
							integer.createInteger(-2n),
						),
					).toEqual(optional.createEmpty())
				})

				it("counts a negative position back from the end", () => {
					expect(
						list.item(
							list.createList([integerOne(), integerTwo()]),
							integer.createInteger(-1n),
						),
					).toEqual(optional.createValue(integerTwo()))
					expect(
						list.item(
							list.createList([integerOne(), integerTwo()]),
							integer.createInteger(-2n),
						),
					).toEqual(optional.createValue(integerOne()))
				})
			})

			// NOTE: `firstIndex`/`lastIndex` are written in Essence now, walking
			// the positions with `loop` and stopping at the first match; their
			// behaviour is covered by the golden harness over every Method.

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
					// NOTE: -5 counts back from the end of a four item List,
					// which reaches past the start — so it settles on zero
					// rather than wrapping a second time.
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
					// NOTE: The same in the other direction — counting back
					// from the end by more than a 32 bit index leaves the
					// position far below zero, where it clamps to the start.
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

			// NOTE: `remove(at:)` is a native again — the Essence body that
			// composed two `slice`s and an `append(contentsOf:)` is gone, and
			// with it the intermediates. These hold the CONTRACT that body set:
			// which positions name an item and which leave the List alone. The
			// golden harness calls it from Essence over the same positions; what
			// is held here is the Function the emitted call lands on.
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
					// NOTE: At the length, past it, and reaching back past the
					// first item — the three ways to name nothing.
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

			// NOTE: isNot is implemented in Essence now (packages/standard-library/sources/Record.es); the golden harness covers it.

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
			// Essence now (`packages/standard-library/sources/Ordering.es`) — the golden harness
			// exercises them end to end. `Integer.compare` and
			// `Rational.compare` are Essence too now (both route through the
			// native `Number.compare`); only the runtime `anyIs` remains
			// native and keeps its unit test.
			it("compares Ordering values with anyIs", () => {
				expect(anyIs(ordering.less, ordering.less)).toBeTrue()
				expect(anyIs(ordering.less, ordering.equal)).toBeFalse()
				expect(anyIs(ordering.less, integerOne())).toBeFalse()
			})
		})

		describe("Protocol runtime gap fills", () => {
			// NOTE: `String.toString` is implemented in Essence now
			// (`packages/standard-library/sources/String.es`, `<- @`) and covered by the golden
			// harness; only `List.toString`, which has a representation to
			// build, is still native.
			// NOTE: `List.toString` is written in Essence now
			// (`packages/standard-library/sources/List.es`) — the Printable conformance
			// is conditional on the items, and the golden harness covers the
			// filled, empty and single-item renderings.
			// NOTE: There was a third entry here, for `Nothing.is`, `isNot` and
			// `toString`. `Nothing` is gone as a Type — a Function that answers
			// nothing useful answers `{}` now, and absence is `Optional`'s
			// `#Empty` — so there is no Namespace left to gap-fill for. The
			// empty Record reaches `Record`'s own conformances like any other.
		})

		describe("Number", () => {
			// NOTE: `Number.is`, `isNot`, `toString` and the `isLessThan`
			// family are implemented in Essence now
			// (`packages/standard-library/sources/Number.es`) and covered by the golden harness.
			// Only `compare`, the one ordering primitive they all fall
			// out of, stays native.
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
				// NOTE: `Boolean.toString` is implemented in Essence now, so the
				// Boolean case supplies a stand-in of the same shape — this tests
				// that `dispatchMethod` picks the case whose member Type accepts
				// the receiver, not any particular runtime Method.
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
						integer.toString as (
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

			// NOTE: The order the cases are walked in IS the dispatch's meaning
			// — the Enricher writes them most specific first and the runtime
			// answers with the first one that accepts, so a receiver two cases
			// both accept belongs to the earlier of them. Pinned with cases
			// that deliberately overlap (the Union case accepts every Integer
			// the Integer case does) and then with the same two swapped: a
			// chain that answered by specificity, or with the last match
			// instead of the first, would still pass a test whose cases can
			// not both accept anything.
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

			// NOTE: The end of the emitted dispatch chain, and the counterpart
			// to a Match's `noCaseMatched`. The Enricher only emits a dispatch
			// when some case is guaranteed to accept the receiver, so reaching
			// here means a case's runtime check disagrees with the Type the
			// Enricher gave it — a Compiler bug, which the throw says out loud
			// rather than letting `undefined` flow on as if it were a result.
			it("throws when no case accepts the receiver", () => {
				let cases: Parameters<typeof dispatchMethod>[2] = [
					[
						{ type: "Integer" },
						integer.toString as (
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

			// NOTE: The three spies below are only ever asked what they were
			// HANDED, so each answers the unit value — the empty Record, which
			// is what a `-> {}` Method returns. It has to be an Essence value
			// all the same: `dispatchMethod` hands its answer straight on.
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

			// NOTE: A Function literal Argument is typed by the branch it is
			// passed to, so each branch carries its own compiled copy of it and
			// names the position that copy stands in for. The copies of the
			// branches that did NOT match must not reach the Method — that was
			// the whole fault: one copy, typed by whichever branch happened to
			// resolve last, was handed to all of them.
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

			// NOTE: The shared Arguments are evaluated once, at the call site,
			// and the same array is handed to whichever case matches — so a case
			// that overrides a position must leave that array alone. Writing
			// through it would make one dispatch's substitution the next one's
			// Argument.
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

	// NOTE: The Modules half of emission. Everything here is about what the
	// Rewriter does that `rewrite` on its own can not: one shared prelude
	// instead of a copy per Module, and Case tags spelled against the entry's
	// directory rather than against the machine that compiled.
	describe("Modules", () => {
		// NOTE: No graph and no file system: the paths are the Module identity
		// and nothing reads them, so a Program that imports nothing can be
		// enriched as a Module of a bundle straight away. What is under test is
		// emission, and a graph here would only be a second copy of what
		// `modules.spec.ts` pins.
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

			// NOTE: `Boolean.toString` is written in Essence, so each of the
			// three reaches the same `$es_Boolean_toString` const. Rewritten
			// one at a time they would carry three copies of its body — which
			// is the whole reason the reachability fixed point runs once over
			// their union.
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

		// NOTE: A Method no Module reaches is not emitted at all, exactly as it
		// is not for a lone Program — the prelude is one shared Module, not a
		// standard library the bundle carries whole.
		it("leaves out a Method no Module of the bundle reaches", () => {
			let bundle = rewriteModules(
				[moduleOf("/project/Main.es", printing("true"))],
				"/project/Main.es",
			)

			expect(bundle.sources.get("essence:$prelude")).not.toContain(
				"$es_List_sorted",
			)
		})

		// NOTE: The identity a Choice took from its Module is a canonical path,
		// which names the machine that compiled and must not reach the output.
		// The emitted tag renders it against the entry's directory instead, and
		// the Type descriptor a Match compares against renders identically —
		// they are one answer, so a value's tag and the check that claims it can
		// not drift apart.
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
			// NOTE: The descriptor is what the second half of this asks about,
			// and a lone Handler is the one `elide-final-match-test` drops the
			// test of — so the Match is emitted with that pass off. Which
			// Handler is tested is not this test's business; how an identity
			// is SPELLED wherever it is written is.
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

		// NOTE: The single-file form is the default and stays byte for byte
		// what it was: its prelude is inline, it names no Module and it spells
		// a Case by its bare name, because a Program that is no Module has no
		// path in its Choices' identity to render.
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

		// NOTE: The same spelling for somebody holding one identity and no graph
		// — a host building a Case value has to stamp it with the tag the
		// bundle's own values carry, and these two answers being one is what
		// makes that possible at all.
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

			// NOTE: A builtin Choice is identified by its bare name — there is no
			// Module path in it to render, and a `#` that is not preceded by one
			// is not a Module path either.
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
