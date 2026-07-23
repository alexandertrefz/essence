import { describe, expect, it } from "bun:test"

import { enrich } from "../enricher/index"
import { parse } from "../parser/index"
import * as algebraic from "../rewriter/__internal/Algebraic"
import { createBoolean } from "../rewriter/__internal/Boolean"
import * as integer from "../rewriter/__internal/Integer"
import { anyIs, anyIsNot } from "../rewriter/__internal/internalHelpers"
import * as list from "../rewriter/__internal/List"
import { createNothing } from "../rewriter/__internal/Nothing"
import * as number from "../rewriter/__internal/Number"
import * as ordering from "../rewriter/__internal/Ordering"
import * as rational from "../rewriter/__internal/Rational"
import * as transcendental from "../rewriter/__internal/Transcendental"
import { typeKeySymbol } from "../rewriter/__internal/type"
import { validate } from "../validator/index"

const bigRational = (numerator: bigint, denominator = 1n) => ({
	numerator,
	denominator,
})

// NOTE: √d, as a value — createAlgebraic can legitimately return a Rational,
// so the tests that need an Algebraic assert the tag on the way through.
const radical = (radicand: bigint): algebraic.AlgebraicType => {
	const value = algebraic.createAlgebraic(
		bigRational(0n),
		bigRational(1n),
		radicand,
	)

	expect(value[typeKeySymbol]).toBe("Algebraic")

	return value as algebraic.AlgebraicType
}

function diagnosticsFor(source: string) {
	let { program, diagnostics } = enrich(parse(source))

	return [...diagnostics, ...validate(program)].filter(
		(diagnostic) => diagnostic.severity === "error",
	)
}

describe("Irrationals", () => {
	describe("Algebraic Runtime", () => {
		it("normalizes the radicand to its squarefree part", () => {
			const value = radical(12n)

			expect(value.radicand).toBe(3n)
			expect(value.radicalCoefficientNumerator).toBe(2n)
			expect(algebraic.toString(value).value).toBe("2·√3")
		})

		it("collapses perfect squares to Rationals", () => {
			const value = algebraic.createAlgebraic(
				bigRational(0n),
				bigRational(1n),
				9n,
			)

			expect(value[typeKeySymbol]).toBe("Rational")
		})

		it("collapses a zero coefficient to the rational part", () => {
			const value = algebraic.createAlgebraic(
				bigRational(5n),
				bigRational(0n),
				2n,
			)

			expect(value[typeKeySymbol]).toBe("Rational")
		})

		it("computes exact square roots of Integers", () => {
			expect(integer.squareRoot(integer.createInteger(9n))).toEqual(
				integer.createInteger(3n),
			)
			expect(
				integer.squareRoot(integer.createInteger(2n))[typeKeySymbol],
			).toBe("Algebraic")
			expect(
				integer.squareRoot(integer.createInteger(-1n))[typeKeySymbol],
			).toBe("Nothing")
		})

		it("computes exact square roots of Rationals", () => {
			const exact = rational.squareRoot(rational.createRational(9n, 4n))

			expect(exact[typeKeySymbol]).toBe("Rational")

			const inexact = rational.squareRoot(rational.createRational(1n, 2n))

			expect(inexact[typeKeySymbol]).toBe("Algebraic")
		})

		it("multiplies back to an exact Rational — √2·√2 is 2", () => {
			const rootTwo = radical(2n)
			const product = algebraic.multiplyWithAlgebraic(rootTwo, rootTwo)

			expect(product[typeKeySymbol]).toBe("Rational")
			// NOTE: `Number.is` (√2·√2 is 2) is Essence now, covered by the golden harness.
		})

		it("combines pure radicals across radicands — √2·√3 is √6", () => {
			const product = algebraic.multiplyWithAlgebraic(
				radical(2n),
				radical(3n),
			)

			expect(product[typeKeySymbol]).toBe("Algebraic")
			expect(
				algebraic.toString(product as algebraic.AlgebraicType).value,
			).toBe("√6")
		})

		it("returns Nothing for sums across different radicands", () => {
			expect(
				algebraic.addAlgebraic(radical(2n), radical(3n))[typeKeySymbol],
			).toBe("Nothing")
		})

		it("never fails when dividing a Rational by an Algebraic", () => {
			const quotient = algebraic.dividedInto(
				radical(2n),
				integer.createInteger(1n),
			)

			expect(quotient[typeKeySymbol]).toBe("Algebraic")
			expect(
				algebraic.toString(quotient as algebraic.AlgebraicType).value,
			).toBe("1/2·√2")
		})

		it("orders exactly across different radicands", () => {
			// NOTE: 1 + √2 ≈ 2.414 versus √6 ≈ 2.449 — close enough that a
			// float would need care; the symbolic comparison is exact.
			const onePlusRootTwo = algebraic.add(
				radical(2n),
				integer.createInteger(1n),
			)

			expect(algebraic.compareTo(onePlusRootTwo, radical(6n))).toEqual(
				ordering.less,
			)
			expect(algebraic.compareTo(radical(6n), onePlusRootTwo)).toEqual(
				ordering.greater,
			)
			expect(algebraic.compareTo(radical(2n), radical(2n))).toEqual(
				ordering.equal,
			)
		})
	})

	describe("Transcendental Runtime", () => {
		it("keeps PI and TAU exact", () => {
			expect(number.PI[typeKeySymbol]).toBe("Transcendental")
			expect(transcendental.toString(number.PI).value).toBe("π")
			expect(transcendental.toString(number.TAU).value).toBe("2·π")
		})

		it("uses canonical-form equality", () => {
			const doubled = transcendental.multiply(
				number.PI,
				integer.createInteger(2n),
			)

			expect(doubled[typeKeySymbol]).toBe("Transcendental")
			// NOTE: `Transcendental.is` is written in Essence now
			// (src/stdlib/Transcendental.es) — `anyIs` compares the canonical
			// form the same way the deleted native did.
			expect(anyIs(doubled, number.TAU)).toBeTrue()
		})

		it("collapses cancelling π-parts to a Rational", () => {
			// NOTE: `Transcendental.subtract` is written in Essence now
			// (src/stdlib/Transcendental.es) as `add(other::negate())` — this
			// is that composition, and the still-native gateway is what
			// collapses the cancelled π-part.
			const difference = transcendental.addTranscendental(
				number.TAU,
				transcendental.negate(number.TAU),
			)

			expect(difference[typeKeySymbol]).toBe("Rational")
		})

		it("divides proportional values exactly — TAU/π is 2", () => {
			const quotient = transcendental.divideByTranscendental(
				number.TAU,
				number.PI,
			)

			expect(quotient[typeKeySymbol]).toBe("Rational")
			// NOTE: `Number.is` (TAU/π is 2) is Essence now, covered by the golden harness.
		})

		it("returns Nothing for non-proportional quotients", () => {
			const shifted = transcendental.add(
				number.PI,
				integer.createInteger(1n),
			)

			expect(
				transcendental.divideByTranscendental(
					shifted as transcendental.TranscendentalType,
					number.PI,
				)[typeKeySymbol],
			).toBe("Nothing")
		})

		it("orders π exactly against tight rational bounds", () => {
			// NOTE: 22/7 and 355/113 are the classic over-approximations;
			// 333/106 under-approximates. All three are decided exactly.
			expect(
				number.compareTo(number.PI, rational.createRational(22n, 7n)),
			).toEqual(ordering.less)
			expect(
				number.compareTo(
					number.PI,
					rational.createRational(355n, 113n),
				),
			).toEqual(ordering.less)
			expect(
				number.compareTo(
					number.PI,
					rational.createRational(333n, 106n),
				),
			).toEqual(ordering.greater)
		})

		it("orders π against Algebraics", () => {
			// NOTE: √10 ≈ 3.162 > π > √9 — and √9 collapses, so use √8.
			expect(number.compareTo(number.PI, radical(10n))).toEqual(
				ordering.less,
			)
			expect(number.compareTo(number.PI, radical(8n))).toEqual(
				ordering.greater,
			)
		})
	})

	describe("Number cross-kind semantics", () => {
		// NOTE: cross-kind `Number.is` is Essence now (`src/stdlib/Number.es`) and covered by the golden harness.

		it("crashes no longer on empty lists — lowestNumber gives Nothing", () => {
			expect(
				number.lowestNumber__overload$5({
					[typeKeySymbol]: "List",
					value: [],
				}),
			).toEqual(createNothing())
			expect(
				number.greatestNumber__overload$7({
					[typeKeySymbol]: "List",
					value: [],
				}),
			).toEqual(createNothing())
		})
		// NOTE: the `isLessThan` family is Essence now (`src/stdlib/Number.es`) — its agreement with `compareTo` is covered by the golden harness.
		// NOTE: the `isLessThan` family is Essence now (`src/stdlib/Number.es`); its symmetry with itself is covered by the golden harness.
	})

	describe("Structural equality", () => {
		// NOTE: `anyIs` used to be what every List operation compared with. It
		// branched on the type tag for the other kinds and fell through to
		// `false` for Algebraic and Transcendental, so a List could not find a
		// value it held. The List Methods are bounded by `Equatable` now and
		// take the items' own `is` as a witness instead — `anyIs` still answers
		// for a Record's members and for a literal Matcher, so it keeps these
		// tests, and the searching Methods are exercised through the witness
		// beside them. `Algebraic.is` and `Transcendental.is` are Essence
		// (both read `compareTo`), so the witnesses are spelled out here the
		// way the Simplifier passes them.
		const irrationalIs = (
			first: algebraic.AlgebraicType | transcendental.TranscendentalType,
			second: algebraic.AlgebraicType | transcendental.TranscendentalType,
		) => createBoolean(anyIs(first, second))

		it("finds an Algebraic in a List", () => {
			const rootTwo = radical(2n)

			expect(anyIs(rootTwo, radical(2n))).toBeTrue()
			expect(anyIs(rootTwo, radical(3n))).toBeFalse()
			expect(anyIsNot(rootTwo, radical(2n))).toBeFalse()

			// NOTE: List.contains / doesNotContain / removeDuplicates are
			// implemented in Essence now (src/stdlib/List.es); `firstIndex`
			// is the searching Method still native, and it answers through the
			// witness.
			expect(
				list.firstIndex(list.createList([rootTwo]), radical(2n), {
					is: irrationalIs,
				}),
			).toEqual(integer.createInteger(0n))

			expect(
				list.firstIndex(list.createList([rootTwo]), radical(3n), {
					is: irrationalIs,
				})[typeKeySymbol],
			).toBe("Nothing")
		})

		it("finds a Transcendental in a List", () => {
			expect(anyIs(number.PI, number.PI)).toBeTrue()
			expect(anyIs(number.PI, number.TAU)).toBeFalse()

			expect(
				list.firstIndex(
					list.createList([number.TAU, number.PI]),
					number.PI,
					{ is: irrationalIs },
				),
			).toEqual(integer.createInteger(1n))
		})

		it("compares Lists of irrationals through the item witness", () => {
			expect(
				list.is(
					list.createList([radical(2n), radical(3n)]),
					list.createList([radical(2n), radical(3n)]),
					{ is: irrationalIs },
				).value,
			).toBeTrue()

			expect(
				list.is(
					list.createList([number.PI, number.TAU]),
					list.createList([number.PI, number.PI]),
					{ is: irrationalIs },
				).value,
			).toBeFalse()
		})

		it("keeps kinds apart", () => {
			// NOTE: An Algebraic is irrational by construction and a
			// Transcendental is provably not algebraic, so no cross-kind pair
			// is ever equal — the same rule `Number::is` states.
			expect(anyIs(radical(2n), number.PI)).toBeFalse()
			expect(anyIs(number.PI, radical(2n))).toBeFalse()
			expect(anyIs(radical(2n), integer.createInteger(2n))).toBeFalse()
		})
	})

	describe("Enricher", () => {
		it("types squareRoot as Integer | Algebraic | Nothing", () => {
			expect(
				diagnosticsFor(`implementation {
					constant root: Integer | Algebraic | Nothing = 2::squareRoot()
				}`),
			).toEqual([])
		})

		it("resolves the Irrational alias to Algebraic | Transcendental", () => {
			expect(
				diagnosticsFor(`implementation {
					constant value: Irrational = Number.PI

					__print(match value -> String {
						case Algebraic { <- "algebraic" }
						case Transcendental { <- "transcendental" }
					})
				}`),
			).toEqual([])
		})

		it("requires all four member cases when matching a Number", () => {
			let diagnostics = diagnosticsFor(`implementation {
				constant value: Number = 5

				__print(match value -> String {
					case Integer { <- @::toString() }
					case Rational { <- @::toString() }
				})
			}`)

			expect(diagnostics).toHaveLength(1)
			expect(diagnostics[0].code).toBe("missing-case")
			expect(diagnostics[0].notes).toEqual([
				"Unhandled: 'Algebraic', 'Transcendental'.",
			])
		})

		it("types PI as Transcendental", () => {
			expect(
				diagnosticsFor(`implementation {
					constant exactPi: Transcendental = Number.PI
				}`),
			).toEqual([])
		})

		it("routes mixed compareTo through the Number Namespace", () => {
			expect(
				diagnosticsFor(`implementation {
					constant order: Ordering = Number.PI::compareTo(22/7)
				}`),
			).toEqual([])
		})

		// NOTE: The List Methods that search by value are bounded by
		// `Equatable` now, so a List of irrationals only keeps them if the
		// covering `Number` Namespace's conformance is what solves the bound.
		// This is the gate on that: no Diagnostic means the witness was found.
		it("satisfies the Equatable bound of the searching List Methods", () => {
			expect(
				diagnosticsFor(`implementation {
					constant roots: List<Irrational> = [Number.PI, Number.TAU]

					__print(roots::contains(Number.PI)::toString())
					__print(roots::count(of Number.TAU)::toString())
					__print(roots::removeDuplicates()::length()::toString())
					__print(roots::is([Number.PI])::toString())
				}`),
			).toEqual([])
		})

		it("keeps division by an Algebraic total — no Nothing in the Type", () => {
			expect(
				diagnosticsFor(`implementation {
					constant root = 2::squareRoot()

					__print(match root -> String {
						case Algebraic { <- 1::divide(by @)::toString() }
						case Integer { <- @::toString() }
						case Nothing { <- "impossible" }
					})
				}`),
			).toEqual([])
		})
	})
})
