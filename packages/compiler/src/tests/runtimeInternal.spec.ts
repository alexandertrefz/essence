import { describe, expect, it } from "bun:test"

import * as algebraic from "@essence/runtime/Algebraic"
import { getStringRepresentation } from "@essence/runtime/functions"
import * as integer from "@essence/runtime/Integer"
import {
	anyIs,
	anyIsNot,
	boundChoiceIs,
	choiceIs,
} from "@essence/runtime/internalHelpers"
import * as list from "@essence/runtime/List"
import { createNothing } from "@essence/runtime/Nothing"
import * as number from "@essence/runtime/Number"
import * as rational from "@essence/runtime/Rational"
import * as record from "@essence/runtime/Record"
import * as string from "@essence/runtime/String"
import { type AnyType, createCase, typeKeySymbol } from "@essence/runtime/type"

// NOTE: The runtime is handed values, never Types — so these are built the way
// the emitted JavaScript builds them, with the `create…` constructors.
const text = (value: string) => string.createString(value)
const whole = (value: bigint) => integer.createInteger(value)
const ratio = (numerator: bigint, denominator: bigint) =>
	rational.createRational(numerator, denominator)

// NOTE: A Function reaches the runtime as a bare JavaScript function carrying
// no Type key at all — which is the whole reason printing and comparing one
// need a guard of their own. `AnyType` deliberately does not describe it.
const functionValue = () => ((value: never) => value) as unknown as AnyType

// NOTE: √d as a value — `createAlgebraic` may legitimately answer a Rational,
// so the tag is asserted on the way through, as `irrationals.spec.ts` does.
const radical = (radicand: bigint): algebraic.AlgebraicType => {
	const value = algebraic.createAlgebraic(
		{ numerator: 0n, denominator: 1n },
		{ numerator: 1n, denominator: 1n },
		radicand,
	)

	expect(value[typeKeySymbol]).toBe("Algebraic")

	return value as algebraic.AlgebraicType
}

// NOTE: The same String twice — once composed (NFC, one code point for `é`),
// once decomposed (NFD, `e` followed by a combining acute). They are
// canonically equivalent, which is what `String::is` decides by, and they are
// genuinely different code points, which is what makes the test mean anything.
const composed = () => text("café")
const decomposed = () => text("café")

describe("Runtime Internals", () => {
	describe("getStringRepresentation", () => {
		// NOTE: The regression — the multi-line rebuild used to PUSH onto the
		// array the single-line pass had already filled, so every member was
		// printed twice: once at indent zero and once indented.
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

		// NOTE: The duplicated members were rendered at TWO different indent
		// levels, so a nested Record came out with one copy of its members
		// hanging outside the indentation of the other. One pass, one indent.
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

		// NOTE: A Case payload is rendered through the Record branch, so it
		// carried the same duplication.
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

		// NOTE: The List branch always built a fresh array, so it never
		// duplicated — this pins that the Record fix left it alone.
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

		// NOTE: The regression — a Function carries no Type key, so the tag
		// cascade fell through to `obj[typeKeySymbol].includes("#")` and threw
		// `undefined is not an object`. `__print(f)`, `Record::toString()` and
		// `List::toString()` all reach here, so all three crashed.
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

		it("answers from Record.toString and List.toString for a Function", () => {
			expect(
				record.toString(
					record.createRecord({ callback: functionValue() }),
				).value,
			).toBe("{ callback = Function }")

			expect(
				list.toString(list.createList([functionValue()])).value,
			).toBe("[ Function ]")
		})
	})

	describe("anyIs", () => {
		// NOTE: The regression — `String::is` is `compareTo(other)::is(#Equal)`
		// over the NFC-normalised String, so canonically equivalent Strings are
		// equal. Comparing the raw representation here made the SAME pair
		// unequal the moment either side was wrapped in a Record, a List or a
		// Case payload.
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

		// NOTE: The regression — every numeric cell demanded the SAME tag on
		// both sides, so an Integer beside a numerically equal Rational matched
		// no branch and fell through to `false`. `Number::is` says `1 is 1/1`,
		// and deep equality has to say it too.
		describe("Numbers across the tower", () => {
			it("answers equal for an Integer and an equal Rational", () => {
				expect(anyIs(whole(1n), ratio(1n, 1n))).toBeTrue()
				expect(anyIs(ratio(1n, 1n), whole(1n))).toBeTrue()
				expect(anyIs(whole(2n), ratio(4n, 2n))).toBeTrue()
			})

			// NOTE: The way an ordinary Program reaches the mixed pair —
			// `createRational` never reduces, so `(1/2)::add(1/2)` is the
			// Rational 4/4 rather than the Integer 1.
			it("answers equal for an unreduced Rational and an Integer", () => {
				expect(anyIs(ratio(4n, 4n), whole(1n))).toBeTrue()
			})

			// NOTE: Cross-multiplication is what decides the mixed pair, so
			// zero and the negatives are worth naming — a sign convention read
			// wrongly would show up here first.
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

			// NOTE: An Algebraic and a Transcendental are provably irrational,
			// so no cross-kind pairing with them can ever be equal — which is
			// what makes the covering `compareTo` total and keeps these cheap.
			it("answers unequal for an irrational beside a rational value", () => {
				expect(anyIs(radical(2n), whole(2n))).toBeFalse()
				expect(anyIs(whole(2n), radical(2n))).toBeFalse()
				expect(anyIs(number.PI, ratio(22n, 7n))).toBeFalse()
				expect(anyIs(ratio(22n, 7n), number.PI)).toBeFalse()
				expect(anyIs(number.PI, radical(2n))).toBeFalse()
			})

			it("keeps the same-kind answers it always gave", () => {
				expect(anyIs(radical(2n), radical(2n))).toBeTrue()
				expect(anyIs(radical(2n), radical(3n))).toBeFalse()
				expect(anyIs(number.PI, number.PI)).toBeTrue()
				expect(anyIs(number.PI, number.TAU)).toBeFalse()
			})

			// NOTE: A Number is still only equal to a Number — the numeric cell
			// must not swallow a value of some other Type.
			it("answers unequal for a Number beside another Type", () => {
				expect(anyIs(whole(1n), createNothing())).toBeFalse()
				expect(anyIs(whole(1n), text("1"))).toBeFalse()
			})
		})

		// NOTE: A generic Choice's derived equality compares a payload member
		// that names no Type Parameter through the `eq` descriptor node, which
		// is `anyIs` — so both fixes have to reach it too.
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
	})
})
