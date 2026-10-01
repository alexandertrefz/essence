import { describe, expect, it } from "bun:test"

import * as algebraic from "@essence-lang/runtime/Algebraic"
import { createBoolean } from "@essence-lang/runtime/Boolean"
import { createDictionary } from "@essence-lang/runtime/Dictionary"
import * as integer from "@essence-lang/runtime/Integer"
import {
	anyIs,
	anyIsNot,
	boundChoiceIs,
	choiceIs,
	choiceName,
} from "@essence-lang/runtime/internalHelpers"
import * as list from "@essence-lang/runtime/List"
import * as number from "@essence-lang/runtime/Number"
import * as rational from "@essence-lang/runtime/Rational"
import * as record from "@essence-lang/runtime/Record"
import * as string from "@essence-lang/runtime/String"
import { getStringRepresentation } from "@essence-lang/runtime/Terminal"
import {
	type AnyType,
	createCase,
	typeKeySymbol,
} from "@essence-lang/runtime/type"

// Values built with the `create…` constructors, the way the emitted
// JavaScript builds them.
const text = (value: string) => string.createString(value)
const whole = (value: bigint) => integer.createInteger(value)
const ratio = (numerator: bigint, denominator: bigint) =>
	rational.createRational(numerator, denominator)

// A Function reaches the runtime as a bare JavaScript function with no Type
// key, so printing and comparing one need a guard. `AnyType` does not
// describe it.
const functionValue = () => ((value: never) => value) as unknown as AnyType

// √d as a value. `createAlgebraic` may answer a Rational, so the tag is
// asserted on the way through.
const radical = (radicand: bigint): algebraic.AlgebraicType => {
	const value = algebraic.createAlgebraic(
		{ numerator: 0n, denominator: 1n },
		{ numerator: 1n, denominator: 1n },
		radicand,
	)

	expect(value[typeKeySymbol]).toBe("Algebraic")

	return value as algebraic.AlgebraicType
}

// The same String composed (NFC) and decomposed (NFD): different code points,
// canonically equivalent, which is what `String::is` decides by.
const composed = () => text("café")
const decomposed = () => text("café")

describe("Runtime Internals", () => {
	describe("getStringRepresentation", () => {
		// The multi-line layout prints each member once, not once per layout
		// pass.
		it("prints each member of a multi-line Record exactly once", () => {
			let rendered = getStringRepresentation(
				record.createRecord({
					firstName: text("Alexander"),
					lastName: text("Trefz"),
					occupation: text("Language designer"),
				}),
			)

			expect(rendered).toBe(
				[
					"{",
					'    firstName = "Alexander",',
					'    lastName = "Trefz",',
					'    occupation = "Language designer"',
					"}",
				].join("\n"),
			)
		})

		it("keeps a short Record on one line", () => {
			expect(
				getStringRepresentation(
					record.createRecord({ x: whole(1n), y: whole(2n) }),
				),
			).toBe("{ x = 1, y = 2 }")

			expect(getStringRepresentation(record.createRecord({}))).toBe("{}")
		})

		it("indents a nested multi-line Record inside its parent", () => {
			let rendered = getStringRepresentation(
				record.createRecord({
					nested: record.createRecord({
						firstName: text("Alexander"),
						lastName: text("Trefz"),
						occupation: text("Language designer"),
					}),
					other: whole(1n),
				}),
			)

			expect(rendered).toBe(
				[
					"{",
					"    nested = {",
					'        firstName = "Alexander",',
					'        lastName = "Trefz",',
					'        occupation = "Language designer"',
					"    },",
					"    other = 1",
					"}",
				].join("\n"),
			)
		})

		// A Case payload is rendered through the Record branch.
		it("prints each payload member of a multi-line Case exactly once", () => {
			let rendered = getStringRepresentation(
				createCase("Person#Named", {
					firstName: text("Alexander"),
					lastName: text("Trefz"),
					occupation: text("Language designer"),
				}) as unknown as AnyType,
			)

			expect(rendered).toBe(
				[
					"Person#Named {",
					'    firstName = "Alexander",',
					'    lastName = "Trefz",',
					'    occupation = "Language designer"',
					"}",
				].join("\n"),
			)
		})

		it("prints a multi-line List unchanged", () => {
			let rendered = getStringRepresentation(
				list.createList([
					text("a fairly long string value here"),
					text("another fairly long string value"),
				]),
			)

			expect(rendered).toBe(
				[
					"[",
					'    "a fairly long string value here",',
					'    "another fairly long string value"',
					"]",
				].join("\n"),
			)
		})

		// A Function carries no Type key, so the printer must not read a tag
		// off it. `Terminal.inspect` and `Record::toString()` reach here.
		it("prints a Function as a stable placeholder", () => {
			expect(getStringRepresentation(functionValue())).toBe("Function")
		})

		it("prints a Record or List holding a Function", () => {
			expect(
				getStringRepresentation(
					record.createRecord({
						callback: functionValue(),
						name: text("doubler"),
					}),
				),
			).toBe('{ callback = Function, name = "doubler" }')

			expect(
				getStringRepresentation(list.createList([functionValue()])),
			).toBe("[ Function ]")
		})

		it("answers from Record.toString for a Function, bare or in a List", () => {
			// A List of Functions has no `toString`, since `List.toString` is
			// bounded by `Printable`. The printer still reaches one through a
			// Record.
			expect(
				record.toString(
					record.createRecord({ callback: functionValue() }),
				).value,
			).toBe("{ callback = Function }")

			expect(
				record.toString(
					record.createRecord({
						callbacks: list.createList([functionValue()]),
					}),
				).value,
			).toBe("{ callbacks = [Function] }")
		})
	})

	describe("anyIs", () => {
		// `String::is` compares the NFC-normalised Strings, and deep equality
		// must agree inside a Record, a List or a Case payload.
		describe("Strings by canonical equivalence", () => {
			it("answers equal for a composed and a decomposed String", () => {
				expect(anyIs(composed(), decomposed())).toBeTrue()
				expect(anyIsNot(composed(), decomposed())).toBeFalse()
			})

			it("answers the same inside a Record, a List and a Case", () => {
				expect(
					anyIs(
						record.createRecord({ v: composed() }),
						record.createRecord({ v: decomposed() }),
					),
				).toBeTrue()

				expect(
					anyIs(
						list.createList([composed()]),
						list.createList([decomposed()]),
					),
				).toBeTrue()

				expect(
					choiceIs(
						createCase("Wrapper#Text", {
							value: composed(),
						}) as unknown as AnyType,
						createCase("Wrapper#Text", {
							value: decomposed(),
						}) as unknown as AnyType,
					).value,
				).toBeTrue()
			})

			it("still tells genuinely different Strings apart", () => {
				expect(anyIs(text("café"), text("cafe"))).toBeFalse()
				expect(anyIs(text(""), text(" "))).toBeFalse()
			})
		})

		// `Number::is` says `1 is 1/1`, and deep equality says it too.
		describe("Numbers across the tower", () => {
			it("answers equal for an Integer and an equal Rational", () => {
				expect(anyIs(whole(1n), ratio(1n, 1n))).toBeTrue()
				expect(anyIs(ratio(1n, 1n), whole(1n))).toBeTrue()
				expect(anyIs(whole(2n), ratio(4n, 2n))).toBeTrue()
			})

			// `createRational` does not reduce, so a Rational may hold 4/4.
			it("answers equal for an unreduced Rational and an Integer", () => {
				expect(anyIs(ratio(4n, 4n), whole(1n))).toBeTrue()
			})

			// Cross-multiplication decides the mixed pair, so zero and the
			// negatives test its sign convention.
			it("answers across the kinds for zero and for negatives", () => {
				expect(anyIs(whole(0n), ratio(0n, 5n))).toBeTrue()
				expect(anyIs(whole(-3n), ratio(-6n, 2n))).toBeTrue()
				expect(anyIs(ratio(-1n, 2n), ratio(1n, -2n))).toBeTrue()
				expect(anyIs(whole(-3n), ratio(6n, 2n))).toBeFalse()
			})

			it("answers the same inside a Record, a List and a Case", () => {
				expect(
					anyIs(
						record.createRecord({ x: whole(1n) }),
						record.createRecord({ x: ratio(1n, 1n) }),
					),
				).toBeTrue()

				expect(
					anyIs(
						list.createList([whole(1n)]),
						list.createList([ratio(1n, 1n)]),
					),
				).toBeTrue()

				expect(
					choiceIs(
						createCase("Wrapper#Amount", {
							value: whole(1n),
						}) as unknown as AnyType,
						createCase("Wrapper#Amount", {
							value: ratio(1n, 1n),
						}) as unknown as AnyType,
					).value,
				).toBeTrue()
			})

			it("still tells different Numbers apart, within a kind and across", () => {
				expect(anyIs(whole(1n), whole(2n))).toBeFalse()
				expect(anyIs(whole(1n), ratio(1n, 2n))).toBeFalse()
				expect(anyIs(ratio(1n, 2n), ratio(1n, 3n))).toBeFalse()
			})

			// An Algebraic and a Transcendental are provably irrational, so no
			// cross-kind pairing with them is equal.
			it("answers unequal for an irrational beside a rational value", () => {
				expect(anyIs(radical(2n), whole(2n))).toBeFalse()
				expect(anyIs(whole(2n), radical(2n))).toBeFalse()
				expect(anyIs(number.Pi, ratio(22n, 7n))).toBeFalse()
				expect(anyIs(ratio(22n, 7n), number.Pi)).toBeFalse()
				expect(anyIs(number.Pi, radical(2n))).toBeFalse()
			})

			it("keeps the same-kind answers it always gave", () => {
				expect(anyIs(radical(2n), radical(2n))).toBeTrue()
				expect(anyIs(radical(2n), radical(3n))).toBeFalse()
				expect(anyIs(number.Pi, number.Pi)).toBeTrue()
				expect(anyIs(number.Pi, number.Tau)).toBeFalse()
			})

			// A Number equals only a Number. The empty Record is included
			// because reading `numerator` off it finds `undefined`, not a
			// mismatch.
			it("answers unequal for a Number beside another Type", () => {
				expect(anyIs(whole(1n), createBoolean(true))).toBeFalse()
				expect(anyIs(whole(1n), record.createRecord({}))).toBeFalse()
				expect(anyIs(whole(1n), text("1"))).toBeFalse()
			})
		})

		// A generic Choice's derived equality compares a member that names no
		// Type Parameter through the `eq` node, which is `anyIs`.
		it("reaches the structural node of a derived generic Choice equality", () => {
			let isEqual = boundChoiceIs({
				"Wrapper#Text": { value: { k: "eq" } },
			})

			expect(
				isEqual(
					createCase("Wrapper#Text", {
						value: composed(),
					}) as unknown as AnyType,
					createCase("Wrapper#Text", {
						value: decomposed(),
					}) as unknown as AnyType,
				).value,
			).toBeTrue()

			expect(
				isEqual(
					createCase("Wrapper#Text", {
						value: whole(1n),
					}) as unknown as AnyType,
					createCase("Wrapper#Text", {
						value: ratio(1n, 1n),
					}) as unknown as AnyType,
				).value,
			).toBeTrue()
		})

		// The `dictionary` node sends keys and values to their own children
		// and compares the entries in any order.
		describe("the Dictionary node of a derived generic Choice equality", () => {
			// The witness a hand-built Dictionary is keyed by: the runtime's own
			// comparison, so the descriptor's `w` node shows against it.
			const anyEquatable = {
				is: (a: AnyType, b: AnyType) => createBoolean(anyIs(a, b)),
			}
			const held = (entries: Array<[AnyType, AnyType]>) =>
				createCase("Wrapper#Held", {
					v: createDictionary(entries, anyEquatable),
				}) as unknown as AnyType

			// A witness that calls every pair of keys equal. `anyIs` says these
			// keys differ, so `true` can only come through the `key` child.
			const everyKeyEqual = {
				is: () => createBoolean(true),
			}

			it("routes the keys through the witness the key node names", () => {
				let isEqual = boundChoiceIs({
					"Wrapper#Held": {
						v: {
							k: "dictionary",
							key: { k: "w", i: 0 },
							value: { k: "eq" },
						},
					},
				})

				expect(
					isEqual(
						held([[text("alex"), whole(39n)]]),
						held([[text("sam"), whole(39n)]]),
						everyKeyEqual,
					).value,
				).toBeTrue()

				// The values still decide, through their own child.
				expect(
					isEqual(
						held([[text("alex"), whole(39n)]]),
						held([[text("sam"), whole(40n)]]),
						everyKeyEqual,
					).value,
				).toBeFalse()
			})

			it("compares the entries whatever order they were written in", () => {
				let isEqual = boundChoiceIs({
					"Wrapper#Held": {
						v: {
							k: "dictionary",
							key: { k: "eq" },
							value: { k: "eq" },
						},
					},
				})

				expect(
					isEqual(
						held([
							[text("alex"), whole(39n)],
							[text("sam"), whole(25n)],
						]),
						held([
							[text("sam"), whole(25n)],
							[text("alex"), whole(39n)],
						]),
					).value,
				).toBeTrue()
			})

			it("answers unequal for Dictionaries of differing lengths", () => {
				let isEqual = boundChoiceIs({
					"Wrapper#Held": {
						v: {
							k: "dictionary",
							key: { k: "eq" },
							value: { k: "eq" },
						},
					},
				})

				expect(
					isEqual(held([]), held([[text("alex"), whole(39n)]])).value,
				).toBeFalse()
				expect(isEqual(held([]), held([])).value).toBeTrue()
			})
		})

		// Two Union arms with neither a tag nor a shape can not be told apart,
		// so the runtime throws rather than answer wrongly. The Compiler emits no
		// such descriptor, so it is built by hand.
		it("refuses a Union descriptor with two arms it can not tell apart", () => {
			let isEqual = boundChoiceIs({
				"Wrapper#Val": {
					v: {
						k: "union",
						arms: [
							{ tag: null, node: { k: "w", i: 0 } },
							{
								tag: null,
								node: { k: "list", of: { k: "w", i: 0 } },
							},
						],
					},
				},
			})

			expect(() =>
				isEqual(
					createCase("Wrapper#Val", {
						v: list.createList([whole(2n)]),
					}) as unknown as AnyType,
					createCase("Wrapper#Val", {
						v: list.createList([whole(10n)]),
					}) as unknown as AnyType,
					// Never consulted, since the throw comes first.
					{ is: (a, b) => createBoolean(anyIs(a, b)) },
				),
			).toThrow("This is a bug in the Compiler.")
		})
	})

	// The runtime half of a Choice's derived `Printable` conformance.
	describe("choiceName", () => {
		it("answers the Case's name for a builtin Choice", () => {
			expect(choiceName(createCase("Ordering#Less") as never).value).toBe(
				"Less",
			)
			expect(choiceName(createCase("Side#BothEnds") as never).value).toBe(
				"BothEnds",
			)
		})

		// A Program's Choice is identified by its Module and its name, so its
		// tag carries two `#`s and only the last part is the Case.
		it("answers the Case's name for a Choice a Module declares", () => {
			expect(
				choiceName(createCase("./Compass.es#Direction#Up") as never)
					.value,
			).toBe("Up")
		})

		// Only a Choice of payload-free Cases derives printing, but the tag is
		// all this reads.
		it("reads the tag alone, whatever the Case carries", () => {
			expect(
				choiceName(
					createCase("Wrapper#Text", { value: text("x") }) as never,
				).value,
			).toBe("Text")
		})
	})
})
