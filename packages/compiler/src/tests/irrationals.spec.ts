import { describe, expect, it } from "bun:test"

import * as algebraic from "@essence-lang/runtime/Algebraic"
import { createBoolean } from "@essence-lang/runtime/Boolean"
import * as integer from "@essence-lang/runtime/Integer"
import { anyIs, anyIsNot } from "@essence-lang/runtime/internalHelpers"
import * as list from "@essence-lang/runtime/List"
import * as number from "@essence-lang/runtime/Number"
import type { OptionalType, ValueType } from "@essence-lang/runtime/Optional"
import * as ordering from "@essence-lang/runtime/Ordering"
import * as rational from "@essence-lang/runtime/Rational"
import * as transcendental from "@essence-lang/runtime/Transcendental"
import { type AnyType, typeKeySymbol } from "@essence-lang/runtime/type"

import { enrich } from "../enricher/index"
import { parse } from "../parser/index"
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

// NOTE: Every fallible native answers an `Optional` now — `Optional#Value`
// around the answer, or `Optional#Empty`. The tests below still care about the
// tag of the ANSWER (Rational versus Algebraic), so this asserts the value Case
// once and hands the payload on, rather than repeating the wrapper check at
// every call site. The cast is what the assertion above has already proven:
// `expect` throws on a mismatch, so nothing reaches the return but a `#Value`.
const unwrap = <Item extends AnyType>(optional: OptionalType<Item>): Item => {
	expect(optional[typeKeySymbol]).toBe("Optional#Value")

	return (optional as ValueType<Item>).item
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
			expect(
				unwrap(integer.squareRoot(integer.createInteger(9n))),
			).toEqual(integer.createInteger(3n))
			expect(
				unwrap(integer.squareRoot(integer.createInteger(2n)))[
					typeKeySymbol
				],
			).toBe("Algebraic")
			// NOTE: A negative has no real root, so the root is missing rather
			// than being some other kind of number.
			expect(
				integer.squareRoot(integer.createInteger(-1n))[typeKeySymbol],
			).toBe("Optional#Empty")
		})

		it("computes exact square roots of Rationals", () => {
			const exact = unwrap(
				rational.squareRoot(rational.createRational(9n, 4n)),
			)

			expect(exact[typeKeySymbol]).toBe("Rational")

			const inexact = unwrap(
				rational.squareRoot(rational.createRational(1n, 2n)),
			)

			expect(inexact[typeKeySymbol]).toBe("Algebraic")
		})

		it("multiplies back to an exact Rational — √2·√2 is 2", () => {
			const rootTwo = radical(2n)
			const product = unwrap(
				algebraic.multiplyWithAlgebraic(rootTwo, rootTwo),
			)

			expect(product[typeKeySymbol]).toBe("Rational")
			// NOTE: `Number.is` (√2·√2 is 2) is Essence now, covered by the golden harness.
		})

		it("combines pure radicals across radicands — √2·√3 is √6", () => {
			const product = unwrap(
				algebraic.multiplyWithAlgebraic(radical(2n), radical(3n)),
			)

			expect(product[typeKeySymbol]).toBe("Algebraic")
			expect(
				algebraic.toString(product as algebraic.AlgebraicType).value,
			).toBe("√6")
		})

		it("answers nothing for sums across different radicands", () => {
			expect(
				algebraic.addAlgebraic(radical(2n), radical(3n))[typeKeySymbol],
			).toBe("Optional#Empty")
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

			expect(algebraic.compare(onePlusRootTwo, radical(6n))).toEqual(
				ordering.less,
			)
			expect(algebraic.compare(radical(6n), onePlusRootTwo)).toEqual(
				ordering.greater,
			)
			expect(algebraic.compare(radical(2n), radical(2n))).toEqual(
				ordering.equal,
			)
		})
	})

	describe("Transcendental Runtime", () => {
		it("keeps Pi and Tau exact", () => {
			expect(number.Pi[typeKeySymbol]).toBe("Transcendental")
			expect(transcendental.toString(number.Pi).value).toBe("π")
			expect(transcendental.toString(number.Tau).value).toBe("2·π")
		})

		it("uses canonical-form equality", () => {
			const doubled = transcendental.multiply(
				number.Pi,
				integer.createInteger(2n),
			)

			expect(doubled[typeKeySymbol]).toBe("Transcendental")
			// NOTE: `Transcendental.is` is written in Essence now
			// (packages/standard-library/sources/Transcendental.es) — `anyIs` compares the canonical
			// form the same way the deleted native did.
			expect(anyIs(doubled, number.Tau)).toBeTrue()
		})

		it("collapses cancelling π-parts to a Rational", () => {
			// NOTE: `Transcendental.subtract` is written in Essence now
			// (packages/standard-library/sources/Transcendental.es) as `add(other::negate())` — this
			// is that composition, and the still-native gateway is what
			// collapses the cancelled π-part.
			const difference = transcendental.addTranscendental(
				number.Tau,
				transcendental.negate(number.Tau),
			)

			expect(difference[typeKeySymbol]).toBe("Rational")
		})

		it("divides proportional values exactly — Tau/π is 2", () => {
			const quotient = unwrap(
				transcendental.divideByTranscendental(number.Tau, number.Pi),
			)

			expect(quotient[typeKeySymbol]).toBe("Rational")
			// NOTE: `Number.is` (Tau/π is 2) is Essence now, covered by the golden harness.
		})

		it("answers nothing for non-proportional quotients", () => {
			const shifted = transcendental.add(
				number.Pi,
				integer.createInteger(1n),
			)

			expect(
				transcendental.divideByTranscendental(
					shifted as transcendental.TranscendentalType,
					number.Pi,
				)[typeKeySymbol],
			).toBe("Optional#Empty")
		})

		it("orders π exactly against tight rational bounds", () => {
			// NOTE: 22/7 and 355/113 are the classic over-approximations;
			// 333/106 under-approximates. All three are decided exactly.
			expect(
				number.compare(number.Pi, rational.createRational(22n, 7n)),
			).toEqual(ordering.less)
			expect(
				number.compare(number.Pi, rational.createRational(355n, 113n)),
			).toEqual(ordering.less)
			expect(
				number.compare(number.Pi, rational.createRational(333n, 106n)),
			).toEqual(ordering.greater)
		})

		it("orders π against Algebraics", () => {
			// NOTE: √10 ≈ 3.162 > π > √9 — and √9 collapses, so use √8.
			expect(number.compare(number.Pi, radical(10n))).toEqual(
				ordering.less,
			)
			expect(number.compare(number.Pi, radical(8n))).toEqual(
				ordering.greater,
			)
		})

		it("keeps E exact and prints mixed forms symbolically", () => {
			expect(number.E[typeKeySymbol]).toBe("Transcendental")
			expect(transcendental.toString(number.E).value).toBe("e")

			const mixed = transcendental.addTranscendental(number.Pi, number.E)

			expect(mixed[typeKeySymbol]).toBe("Transcendental")
			expect(
				transcendental.toString(
					mixed as transcendental.TranscendentalType,
				).value,
			).toBe("π + e")
		})

		it("collapses a cancelled e-part back to the π term", () => {
			const mixed = transcendental.addTranscendental(
				number.Pi,
				number.E,
			) as transcendental.TranscendentalType
			const difference = transcendental.addTranscendental(
				mixed,
				transcendental.negate(number.E),
			)

			expect(anyIs(difference, number.Pi)).toBeTrue()
		})

		it("orders e exactly against tight rational bounds", () => {
			// NOTE: 2718/1000 < e < 2719/1000 — decided exactly through the
			// single-base threshold, no cutoff in sight.
			expect(
				number.compare(number.E, rational.createRational(2719n, 1000n)),
			).toEqual(ordering.less)
			expect(
				number.compare(number.E, rational.createRational(2718n, 1000n)),
			).toEqual(ordering.greater)
		})

		it("orders e against π through the mixed-form refinement", () => {
			expect(number.compare(number.E, number.Pi)).toEqual(ordering.less)
			expect(number.compare(number.Pi, number.E)).toEqual(
				ordering.greater,
			)

			// NOTE: π + e against 2·π is e against π in disguise — the
			// difference carries both bases, so this walks the refinement.
			expect(
				number.compare(
					transcendental.addTranscendental(
						number.Pi,
						number.E,
					) as transcendental.TranscendentalType,
					number.Tau,
				),
			).toEqual(ordering.less)
		})

		it("orders e against Algebraics", () => {
			// NOTE: √8 ≈ 2.828 > e > √7 ≈ 2.646.
			expect(number.compare(number.E, radical(8n))).toEqual(ordering.less)
			expect(number.compare(number.E, radical(7n))).toEqual(
				ordering.greater,
			)
		})

		it("answers nothing for π divided by e", () => {
			expect(
				transcendental.divideByTranscendental(number.Pi, number.E)[
					typeKeySymbol
				],
			).toBe("Optional#Empty")
		})

		it("refuses an unregistered base at the gateway", () => {
			// NOTE: γ — Euler–Mascheroni — is not even known to be irrational,
			// so no enclosure of it could promise single-base totality. The
			// gateway is what keeps the invariant "every registered base is
			// provably transcendental" true.
			expect(() =>
				transcendental.createTranscendental(bigRational(0n), [
					{ base: "γ", coefficient: bigRational(1n) },
				]),
			).toThrow(/not a registered transcendental base/)
		})

		it("distinguishes forms that differ only in a later term", () => {
			// NOTE: π + e against π + 2·e — the rational part and the π term
			// agree, so only a walk over the WHOLE term list can tell them
			// apart. The hand-written six-field equality this replaces went
			// blind past the fields it named; the term walk cannot.
			const mixed = transcendental.addTranscendental(
				number.Pi,
				number.E,
			) as transcendental.TranscendentalType
			const wider = transcendental.addTranscendental(
				mixed,
				number.E,
			) as transcendental.TranscendentalType

			expect(anyIs(mixed, wider)).toBeFalse()
			expect(anyIs(mixed, mixed)).toBeTrue()
			expect(transcendental.is(mixed, wider).value).toBeFalse()
		})

		it("divides proportional mixed forms exactly", () => {
			// NOTE: (1 + π + e) / (2 + 2·π + 2·e) = 1/2 — proportionality is
			// componentwise across all three parts.
			const mixedForm = transcendental.createTranscendental(
				bigRational(1n),
				[
					{ base: "π", coefficient: bigRational(1n) },
					{ base: "e", coefficient: bigRational(1n) },
				],
			) as transcendental.TranscendentalType
			const doubled = transcendental.multiply(
				mixedForm,
				integer.createInteger(2n),
			) as transcendental.TranscendentalType

			const quotient = unwrap(
				transcendental.divideByTranscendental(mixedForm, doubled),
			)

			expect(anyIs(quotient, rational.createRational(1n, 2n))).toBeTrue()
		})

		it("holds the golden ratio exactly", () => {
			expect(number.GoldenRatio[typeKeySymbol]).toBe("Algebraic")
			expect(algebraic.toString(number.GoldenRatio).value).toBe(
				"1/2 + 1/2·√5",
			)

			// NOTE: φ² = φ + 1, the defining identity — exact, structural.
			const squared = unwrap(
				algebraic.multiplyWithAlgebraic(
					number.GoldenRatio,
					number.GoldenRatio,
				),
			)
			const incremented = algebraic.add(
				number.GoldenRatio,
				integer.createInteger(1n),
			)

			expect(anyIs(squared, incremented)).toBeTrue()

			// NOTE: 1618/1000 < φ < 1619/1000.
			expect(
				number.compare(
					number.GoldenRatio,
					rational.createRational(1618n, 1000n),
				),
			).toEqual(ordering.greater)
			expect(
				number.compare(
					number.GoldenRatio,
					rational.createRational(1619n, 1000n),
				),
			).toEqual(ordering.less)
		})
	})

	describe("Number cross-kind semantics", () => {
		// NOTE: cross-kind `Number.is` is Essence now (`packages/standard-library/sources/Number.es`) and covered by the golden harness.
		// NOTE: the List entries of `lowestNumber`/`greatestNumber` — and the
		// empty Optional they answer for an empty List — are Essence now
		// (`packages/standard-library/sources/Number.es`), folds over the pairwise
		// entries seeded with `#Empty`; the golden harness covers every entry
		// including the empty Lists.
		// NOTE: the `isLessThan` family is Essence now (`packages/standard-library/sources/Number.es`) — its agreement with `compare` is covered by the golden harness.
		// NOTE: the `isLessThan` family is Essence now (`packages/standard-library/sources/Number.es`); its symmetry with itself is covered by the golden harness.
	})

	describe("Structural equality", () => {
		// NOTE: `anyIs` used to be what every List operation compared with. It
		// branched on the type tag for the other kinds and fell through to
		// `false` for Algebraic and Transcendental, so a List could not find a
		// value it held. The List Methods are bounded by `Equatable` now and
		// take the items' own `is` as a witness instead — `anyIs` still answers
		// for a Record's members and for a literal Matcher, so it keeps these
		// tests, and `List.is` is exercised through that witness beside them.
		// `Algebraic.is` and `Transcendental.is` are Essence
		// (both read `compare`), so the witnesses are spelled out here the
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
		})

		it("finds a Transcendental in a List", () => {
			expect(anyIs(number.Pi, number.Pi)).toBeTrue()
			expect(anyIs(number.Pi, number.Tau)).toBeFalse()
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
					list.createList([number.Pi, number.Tau]),
					list.createList([number.Pi, number.Pi]),
					{ is: irrationalIs },
				).value,
			).toBeFalse()
		})

		it("keeps kinds apart", () => {
			// NOTE: An Algebraic is irrational by construction and a
			// Transcendental is provably not algebraic, so no cross-kind pair
			// is ever equal — the same rule `Number::is` states.
			expect(anyIs(radical(2n), number.Pi)).toBeFalse()
			expect(anyIs(number.Pi, radical(2n))).toBeFalse()
			expect(anyIs(radical(2n), integer.createInteger(2n))).toBeFalse()
		})
	})

	describe("Enricher", () => {
		it("types squareRoot as Optional<Integer | Algebraic>", () => {
			expect(
				diagnosticsFor(`implementation {
					constant root: Optional<Integer | Algebraic> = 2::squareRoot()
				}`),
			).toEqual([])
		})

		it("resolves the Irrational alias to Algebraic | Transcendental", () => {
			expect(
				diagnosticsFor(`implementation {
					constant value: Irrational = Number.Pi

					Terminal.inspect(match value -> String {
						case Algebraic { <- "algebraic" }
						case Transcendental { <- "transcendental" }
					})
				}`),
			).toEqual([])
		})

		it("requires all four member cases when matching a Number", () => {
			let diagnostics = diagnosticsFor(`implementation {
				constant value: Number = 5

				Terminal.inspect(match value -> String {
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

		it("types Pi as Transcendental", () => {
			expect(
				diagnosticsFor(`implementation {
					constant exactPi: Transcendental = Number.Pi
				}`),
			).toEqual([])
		})

		it("types E as Transcendental and GoldenRatio as Algebraic", () => {
			expect(
				diagnosticsFor(`implementation {
					constant exactE: Transcendental = Number.E
					constant golden: Algebraic = Number.GoldenRatio
				}`),
			).toEqual([])
		})

		it("routes mixed compare through the Number Namespace", () => {
			expect(
				diagnosticsFor(`implementation {
					constant order: Ordering = Number.Pi::compare(to 22/7)
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
					constant roots: List<Irrational> = [Number.Pi, Number.Tau]

					Terminal.inspect(roots::contains(Number.Pi)::toString())
					Terminal.inspect(roots::count(of Number.Tau)::toString())
					Terminal.inspect(roots::removeDuplicates()::length()::toString())
					Terminal.inspect(roots::is([Number.Pi])::toString())
				}`),
			).toEqual([])
		})

		// NOTE: The gate is the `Algebraic` arm: `1::divide(by @)` there answers
		// an `Algebraic | Rational` and NOT an `Optional` of one, because an
		// irrational is never zero. If division by an Algebraic ever became
		// fallible the arm would answer an `Optional<…>`, `toString` would not
		// resolve on it, and this would stop being Diagnostic-free. The outer
		// match takes the Optional that `squareRoot` answers apart; the inner
		// one narrows the payload Union, which is the only way in now that
		// `case Algebraic` can not reach through the wrapper.
		it("keeps division by an Algebraic total — the quotient is not an Optional", () => {
			expect(
				diagnosticsFor(`implementation {
					constant root = 2::squareRoot()

					Terminal.inspect(match root -> String {
						case #Value(value) {
							<- match value -> String {
								case Algebraic { <- 1::divide(by @)::toString() }
								case Integer { <- @::toString() }
							}
						}
						case #Empty { <- "impossible" }
					})
				}`),
			).toEqual([])
		})
	})
})
