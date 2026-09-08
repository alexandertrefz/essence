import { describe, expect, it } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import * as algebraic from "@essence-lang/runtime/Algebraic"
import { multiplyRationals } from "@essence-lang/runtime/bigRational"
import { createBoolean } from "@essence-lang/runtime/Boolean"
import * as integer from "@essence-lang/runtime/Integer"
import { anyIs, anyIsNot } from "@essence-lang/runtime/internalHelpers"
import * as list from "@essence-lang/runtime/List"
import * as number from "@essence-lang/runtime/Number"
import type { OptionalType, ValueType } from "@essence-lang/runtime/Optional"
import * as ordering from "@essence-lang/runtime/Ordering"
import * as rational from "@essence-lang/runtime/Rational"
import * as rounding from "@essence-lang/runtime/Rounding"
import * as transcendental from "@essence-lang/runtime/Transcendental"
import { type AnyType, typeKeySymbol } from "@essence-lang/runtime/type"

import { containsErrors } from "../diagnostics/index"
import { enrich } from "../enricher/index"
import { optimise } from "../optimiser/index"
import { parse, parseWithDiagnostics } from "../parser/index"
import { rewrite } from "../rewriter/index"
import { simplify } from "../simplifier/index"
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

// NOTE: The same runner `rationals.spec.ts` has: a Program compiled through the
// whole pipeline and run, its printed lines collected. The direct tests above
// reach the runtime by the names it happens to export; this reaches the Essence
// bodies — `Algebraic::is` is written on `compare` — the way a Program does.
async function run(source: string): Promise<Array<string>> {
	let parsed = parseWithDiagnostics(source)

	expect(containsErrors(parsed.diagnostics)).toBe(false)

	let enriched = enrich(parsed.program)

	expect(containsErrors(enriched.diagnostics)).toBe(false)
	expect(containsErrors(validate(enriched.program))).toBe(false)

	let javaScript = rewrite(optimise(simplify(enriched.program)))
	let directory = mkdtempSync(join(tmpdir(), "essence-irrationals-"))
	let file = join(directory, "program.ts")

	writeFileSync(file, javaScript)

	let output: Array<string> = []
	let originalLog = console.log

	console.log = (...args: Array<unknown>) => {
		output.push(args.map((argument) => String(argument)).join(" "))
	}

	try {
		await import(file)
	} finally {
		console.log = originalLog
		rmSync(directory, { recursive: true, force: true })
	}

	return output
}

// NOTE: Primes just past the trial-division bound of `extractSquarePart`
// (2^16), so that a radicand `p²·q` built from two of them is one the
// normalisation leaves as written. Each was checked prime by trial division
// when the list was made.
const primesPastTheBound = [
	65537n,
	65539n,
	65543n,
	65551n,
	65557n,
	65563n,
	65579n,
	65581n,
	65587n,
	65599n,
]

// NOTE: A deterministic pseudo-random sequence — a linear congruential step —
// so the property tests draw the same cases on every run and a failure names
// a case that can be re-run.
function* deterministicNumbers(seed: number): Generator<number> {
	let state = seed

	while (true) {
		state = (state * 1103515245 + 12345) % 2147483648

		yield state
	}
}

// NOTE: The five rounding rules under the names the tests read them by, so a
// table-driven case names its rule rather than reaching into the module.
const roundings = {
	nearest: rounding.nearest,
	nearestEven: rounding.nearestEven,
	down: rounding.down,
	up: rounding.up,
	towardZero: rounding.towardZero,
}

// NOTE: `p/q` as the pair the test compares against — `approximate` builds its
// answer through `createRational`, which normalises a zero numerator's
// denominator to 1, so the width can not be read back off the answer.
function boundsOf(
	value: rational.RationalType,
	places: bigint,
): { low: rational.RationalType; high: rational.RationalType } {
	const scale = 10n ** places

	return {
		low: rational.createRational(
			value.numerator * scale - value.denominator,
			value.denominator * scale,
		),
		high: rational.createRational(
			value.numerator * scale + value.denominator,
			value.denominator * scale,
		),
	}
}

function approximately(value: algebraic.AlgebraicType): number {
	return (
		Number(value.rationalPartNumerator) /
			Number(value.rationalPartDenominator) +
		(Number(value.radicalCoefficientNumerator) /
			Number(value.radicalCoefficientDenominator)) *
			Math.sqrt(Number(value.radicand))
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
				unwrap(
					integer.squareRoot__overload$1(integer.createInteger(9n)),
				),
			).toEqual(integer.createInteger(3n))
			expect(
				unwrap(
					integer.squareRoot__overload$1(integer.createInteger(2n)),
				)[typeKeySymbol],
			).toBe("Algebraic")
			// NOTE: A negative has no real root, so the root is missing rather
			// than being some other kind of number.
			expect(
				integer.squareRoot__overload$1(integer.createInteger(-1n))[
					typeKeySymbol
				],
			).toBe("Optional#Empty")
		})

		it("computes exact square roots of Rationals", () => {
			const exact = unwrap(
				rational.squareRoot__overload$1(
					rational.createRational(9n, 4n),
				),
			)

			expect(exact[typeKeySymbol]).toBe("Rational")

			const inexact = unwrap(
				rational.squareRoot__overload$1(
					rational.createRational(1n, 2n),
				),
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

		// NOTE: `integerSquareRoot` is what the perfect-square test and the
		// enclosure rest on, so it is pinned at the edges: 0 and 1 are their
		// own roots, a square answers its root exactly, and the number below
		// a square answers one less.
		it("takes the integer square root exactly at the edges", () => {
			expect(algebraic.integerSquareRoot(0n)).toBe(0n)
			expect(algebraic.integerSquareRoot(1n)).toBe(1n)
			expect(algebraic.integerSquareRoot(2n)).toBe(1n)
			expect(algebraic.integerSquareRoot(3n)).toBe(1n)
			expect(algebraic.integerSquareRoot(4n)).toBe(2n)
			expect(algebraic.integerSquareRoot(10n ** 40n)).toBe(10n ** 20n)
			expect(algebraic.integerSquareRoot(10n ** 40n - 1n)).toBe(
				10n ** 20n - 1n,
			)
			expect(algebraic.integerSquareRoot(10n ** 40n + 1n)).toBe(
				10n ** 20n,
			)
		})

		// NOTE: Trial division stops at 2^16, and the remainder is tested for
		// being a perfect square outright — so a square factor PAST the bound
		// is still found whenever it is all that is left once the small factors
		// are out. 65537 is the first prime past the bound.
		it("normalises a square factor past the trial-division bound", () => {
			const value = radical(2n * 65537n * 65537n)

			expect(value.radicand).toBe(2n)
			expect(value.radicalCoefficientNumerator).toBe(65537n)
			expect(algebraic.toString(value).value).toBe("65537·√2")

			const whole = algebraic.createAlgebraic(
				bigRational(0n),
				bigRational(1n),
				65537n * 65537n * 65539n * 65539n,
			)

			expect(whole[typeKeySymbol]).toBe("Rational")
		})

		// NOTE: The trade-off the bound makes: a radicand `p²·q` with p AND q
		// past 2^16 is neither smooth nor a square, so it stays as written. The
		// promise that survives is that it is still the same NUMBER as its
		// normalised spelling — equal, ordered the same against everything, and
		// added and multiplied as one radical — because two radicands whose
		// product is a square are aligned wherever they meet.
		describe("an un-normalised radicand", () => {
			const pairs = primesPastTheBound.flatMap((p, index) =>
				primesPastTheBound
					.slice(index + 1)
					.map((q): [bigint, bigint] => [p, q]),
			)

			it("stays as written", () => {
				const [p, q] = pairs[0]!
				const value = radical(p * p * q)

				expect(value.radicand).toBe(p * p * q)
				expect(value.radicalCoefficientNumerator).toBe(1n)
			})

			it("compares equal to its normalised spelling, and orders around it", () => {
				const numbers = deterministicNumbers(7)

				for (const [p, q] of pairs) {
					const a = bigRational(
						BigInt((numbers.next().value % 41) - 20),
						BigInt((numbers.next().value % 7) + 1),
					)
					const b = bigRational(
						BigInt((numbers.next().value % 19) + 1),
						BigInt((numbers.next().value % 5) + 1),
					)
					const written = algebraic.createAlgebraic(
						a,
						b,
						p * p * q,
					) as algebraic.AlgebraicType
					const normalised = algebraic.createAlgebraic(
						a,
						multiplyRationals(b, bigRational(p)),
						q,
					) as algebraic.AlgebraicType

					expect(written.radicand).toBe(p * p * q)
					expect(normalised.radicand).toBe(q)
					expect(algebraic.compare(written, normalised)).toEqual(
						ordering.equal,
					)
					expect(algebraic.compare(normalised, written)).toEqual(
						ordering.equal,
					)

					const above = algebraic.add(
						written,
						integer.createInteger(1n),
					)

					expect(algebraic.compare(above, normalised)).toEqual(
						ordering.greater,
					)
					expect(algebraic.compare(normalised, above)).toEqual(
						ordering.less,
					)
					expect(algebraic.compare(written, above)).toEqual(
						ordering.less,
					)
				}
			})

			it("adds and multiplies with its normalised spelling as one radical", () => {
				const [p, q] = pairs[3]!
				const written = radical(p * p * q)
				const normalised = algebraic.createAlgebraic(
					bigRational(0n),
					bigRational(p),
					q,
				) as algebraic.AlgebraicType

				const sum = unwrap(algebraic.addAlgebraic(written, normalised))

				expect(sum[typeKeySymbol]).toBe("Algebraic")
				expect((sum as algebraic.AlgebraicType).radicand).toBe(q)
				expect(
					(sum as algebraic.AlgebraicType)
						.radicalCoefficientNumerator,
				).toBe(2n * p)

				// NOTE: √(p²q) · p√q = p²·q, a Rational — the product of one
				// radical with itself.
				const product = unwrap(
					algebraic.multiplyWithAlgebraic(written, normalised),
				)

				expect(product[typeKeySymbol]).toBe("Rational")
				expect((product as rational.RationalType).numerator).toBe(
					p * p * q,
				)

				const difference = unwrap(
					algebraic.addAlgebraic(
						written,
						algebraic.negate(normalised),
					),
				)

				expect(difference[typeKeySymbol]).toBe("Rational")
				expect((difference as rational.RationalType).numerator).toBe(0n)
			})

			// NOTE: Two un-normalised radicands over genuinely different
			// radicals go through the two-radical squaring, which asks nothing
			// of them being squarefree. A double is precise enough to say
			// which way each pair falls, since the pairs are kept apart.
			it("orders against a genuinely different radical exactly", () => {
				const numbers = deterministicNumbers(11)
				let decided = 0

				for (const [p, q] of pairs) {
					for (const r of primesPastTheBound.slice(0, 4)) {
						if (r === q || r === p) {
							continue
						}

						const a = bigRational(
							BigInt((numbers.next().value % 41) - 20),
							1n,
						)
						const c = bigRational(
							BigInt((numbers.next().value % 41) - 20),
							1n,
						)
						const left = algebraic.createAlgebraic(
							a,
							bigRational(1n),
							p * p * q,
						) as algebraic.AlgebraicType
						const right = algebraic.createAlgebraic(
							c,
							bigRational(p),
							r,
						) as algebraic.AlgebraicType
						const gap = approximately(left) - approximately(right)

						if (Math.abs(gap) < 1e-3) {
							continue
						}

						decided += 1

						expect(algebraic.compare(left, right)).toEqual(
							gap < 0 ? ordering.less : ordering.greater,
						)
						expect(algebraic.compare(right, left)).toEqual(
							gap < 0 ? ordering.greater : ordering.less,
						)
					}
				}

				expect(decided).toBeGreaterThan(100)
			})

			// NOTE: The same pair the way a Program meets it. `Algebraic::is` is
			// written on `compare`, the inequalities are `Orderable`'s provided
			// bodies over it, and a Union receiver reaches `Number::is` and the
			// sixteen-cell `Number.compare` — every one of those has to read
			// √(65537²·65539) and 65537·√65539 as one number, and the same-radical
			// arithmetic has to find the radical they share.
			it("is one number to every Essence body that meets it", async () => {
				expect(
					await run(`implementation {
						constant written = 281496452005891::squareRoot()
						constant normalised = 65539::squareRoot()::multiply(with 65537)

						Terminal.inspect(written::is(normalised))
						Terminal.inspect(normalised::is(written))
						Terminal.inspect(written::isLessThan(normalised))
						Terminal.inspect(written::isLessThanOrEqualTo(normalised))
						Terminal.inspect(written::add(1)::isGreaterThan(normalised))
						Terminal.inspect(Number.compare(written, to normalised))

						match written -> {} {
							case Algebraic {
								constant root = @

								match normalised -> {} {
									case Algebraic {
										Terminal.inspect(root::is(@))
										Terminal.inspect(root::compare(to @))
										Terminal.inspect(root::add(@))
										Terminal.inspect(root::subtract(@))
										Terminal.inspect(root::multiply(with @))
										Terminal.inspect(root::divide(by @))
										Terminal.inspect(root::isLessThan(@::add(1)))
									}

									case Integer { Terminal.inspect("normalised collapsed") }
								}
							}

							case Integer { Terminal.inspect("written collapsed") }
						}
					}`),
				).toEqual([
					"true",
					"true",
					"false",
					"true",
					"true",
					"Ordering#Equal",
					"true",
					"Ordering#Equal",
					"Optional#Value(131074·√65539)",
					"Optional#Value(0/1)",
					"Optional#Value(281496452005891/1)",
					"Optional#Value(1/1)",
					"true",
				])
			})

			// NOTE: The same pair one level down, which is where the
			// universal comparison decides instead of `Algebraic::is`: a
			// Record member, a List item, and the key of a Dictionary. That
			// comparison used to read the five stored fields, so the pair was
			// equal on its own and unequal in every structure — and a
			// Dictionary keyed by such a Record opened two slots for the one
			// number. Congruence is what `removeDuplicates`, `group`, `tally`
			// and `contains` all rest on, so it is asserted where a Program
			// meets it as well as through the comparison itself.
			it("is one number inside a Record, a List and a Dictionary key", async () => {
				const written = radical(65537n * 65537n * 65539n)
				const normalised = algebraic.multiply(
					radical(65539n),
					integer.createInteger(65537n),
				)

				expect(anyIs(written, normalised)).toBeTrue()
				expect(anyIsNot(written, normalised)).toBeFalse()

				expect(
					await run(`implementation {
						constant written: Number = 281496452005891::squareRoot()
						constant normalised: Number = 65539::squareRoot()::multiply(with 65537)

						Terminal.inspect({ value = written }::is({ value = normalised }))
						Terminal.inspect([written]::is([normalised]))
						Terminal.inspect([{ value = written }]::is([{ value = normalised }]))
						Terminal.inspect([written = 1]::set(normalised, to 2)::length())
						Terminal.inspect([{ value = written } = 1]::set({ value = normalised }, to 2)::length())
						Terminal.inspect([written, normalised]::removeDuplicates()::length())
					}`),
				).toEqual(["true", "true", "true", "1", "1", "1"])
			})
		})

		// NOTE: The zero branch of the linear sign — |a| = |b|·√d with the signs
		// opposed — is exactly `a + b·√d = 0`, and answers 0 instead of throwing.
		// The gateway never builds a radicand it could fire on, so the only way
		// to reach it is by hand.
		it("answers zero for a linear radical that is exactly zero", () => {
			expect(
				algebraic.signOfLinearRadical(
					bigRational(2n),
					bigRational(-1n),
					4n,
				),
			).toBe(0n)
			expect(
				algebraic.signOfLinearRadical(
					bigRational(-2n),
					bigRational(1n),
					4n,
				),
			).toBe(0n)
		})

		// NOTE: The one claim here about TIME. Unbounded trial division walks up
		// to the root of the radicand, so a sixteen-digit prime measured 2488 ms
		// and a twenty-five-digit one would be hours; bounded at 2^16 with a
		// perfect-square test on the remainder, the same root measured 1.25 ms,
		// best of three. The ceiling is 50 ms — well above the bounded cost on
		// a slow machine, and fifty times below the unbounded one on a fast one.
		// Best of three, so a runner under load has three chances.
		it("takes the root of a sixteen-digit prime in milliseconds", () => {
			const prime = 10000000000000061n
			let best = Number.POSITIVE_INFINITY

			for (let attempt = 0; attempt < 3; attempt++) {
				const started = performance.now()
				const root = unwrap(
					integer.squareRoot__overload$1(
						integer.createInteger(prime),
					),
				)

				best = Math.min(best, performance.now() - started)

				expect(root[typeKeySymbol]).toBe("Algebraic")
				expect((root as algebraic.AlgebraicType).radicand).toBe(prime)
			}

			expect(best).toBeLessThan(50)
		})

		// NOTE: The quadratic slice is a FIELD, so it is closed under Integer
		// powers in both directions. The golden ratio is the case that shows
		// it: φⁿ is `(Lₙ + Fₙ·√5) / 2` over the Lucas and Fibonacci numbers,
		// so φ¹⁰ is `(123 + 55·√5) / 2` and a wrong power would be visible at
		// a glance.
		it("raises to an Integer power, exactly and in both directions", () => {
			const power = (value: algebraic.AlgebraicType, exponent: bigint) =>
				algebraic.raise(value, integer.createInteger(exponent))

			expect(power(radical(2n), 2n)).toEqual(
				rational.createRational(2n, 1n),
			)
			expect(power(radical(2n), 3n)).toEqual(radical(8n))
			expect(power(radical(2n), 0n)).toEqual(
				rational.createRational(1n, 1n),
			)
			expect(power(radical(2n), -2n)).toEqual(
				rational.createRational(1n, 2n),
			)
			expect(power(number.GoldenRatio, 1n)).toEqual(number.GoldenRatio)
			expect(power(number.GoldenRatio, 10n)).toEqual(
				algebraic.createAlgebraic(
					bigRational(123n, 2n),
					bigRational(55n, 2n),
					5n,
				),
			)
			// NOTE: φ⁻¹ is φ − 1, which is the identity the golden ratio is
			// named for, and the one case where the reciprocal branch is
			// checked against something a reader knows.
			expect(power(number.GoldenRatio, -1n)).toEqual(
				algebraic.createAlgebraic(
					bigRational(-1n, 2n),
					bigRational(1n, 2n),
					5n,
				),
			)
		})

		// NOTE: Square-and-multiply, so the claim is that a large exponent
		// costs a logarithm of it. φ to the ten-thousandth is a 2090-digit
		// pair; the same walk one product at a time is ten thousand products
		// on numbers that long.
		it("raises to a large exponent in milliseconds", () => {
			let best = Number.POSITIVE_INFINITY

			for (let attempt = 0; attempt < 3; attempt++) {
				const started = performance.now()

				algebraic.raise(
					number.GoldenRatio,
					integer.createInteger(10000n),
				)

				best = Math.min(best, performance.now() - started)
			}

			expect(best).toBeLessThan(50)
		})

		// NOTE: The enclosure `scaledIntervalOf` answers is refined until both
		// of its ends round alike at the width asked for, so what is checked
		// here is that the answer IS the step the exact value rounds to — not
		// that it is close to one. √2 is 1.41421356…, so the digits below are
		// readable, and the rounding rules separate on the third place of
		// 1.4142|1356 only where a rule looks at the remainder rather than at a
		// tie: an irrational never sits on a tie, which is why `#Nearest` and
		// `#NearestEven` agree everywhere here.
		describe("approximate(toPlaces:toward:)", () => {
			const at = (
				value: algebraic.AlgebraicType,
				places: bigint,
				direction: rounding.RoundingType = roundings.nearest,
			) =>
				algebraic.approximate(
					value,
					integer.createInteger(places),
					direction,
				)

			const digitsOf = (value: rational.RationalType) =>
				`${value.numerator}/${value.denominator}`

			it("answers the step of the grid the value rounds to", () => {
				expect(digitsOf(at(radical(2n), 0n))).toBe("1/1")
				expect(digitsOf(at(radical(2n), 3n))).toBe("1414/1000")
				expect(digitsOf(at(radical(2n), 6n))).toBe("1414214/1000000")
				expect(digitsOf(at(number.GoldenRatio, 10n))).toBe(
					"16180339887/10000000000",
				)
			})

			it("answers every rounding rule at the width asked for", () => {
				expect(digitsOf(at(radical(2n), 3n, roundings.down))).toBe(
					"1414/1000",
				)
				expect(digitsOf(at(radical(2n), 3n, roundings.up))).toBe(
					"1415/1000",
				)
				expect(
					digitsOf(at(radical(2n), 3n, roundings.towardZero)),
				).toBe("1414/1000")
				expect(
					digitsOf(at(radical(2n), 3n, roundings.nearestEven)),
				).toBe("1414/1000")
			})

			it("rounds a negative value the way its rule names", () => {
				const negated = algebraic.negate(radical(2n))

				expect(digitsOf(at(negated, 3n))).toBe("-1414/1000")
				expect(digitsOf(at(negated, 3n, roundings.down))).toBe(
					"-1415/1000",
				)
				expect(digitsOf(at(negated, 3n, roundings.up))).toBe(
					"-1414/1000",
				)
				expect(digitsOf(at(negated, 3n, roundings.towardZero))).toBe(
					"-1414/1000",
				)
			})

			it("answers a whole number as a Rational over one", () => {
				expect(digitsOf(at(radical(2n), 0n, roundings.up))).toBe("2/1")
				expect(digitsOf(at(algebraic.negate(radical(2n)), 0n))).toBe(
					"-1/1",
				)
			})

			// NOTE: `round` is the same decision at no places, answering an
			// Integer rather than a Rational — the rung a `Number` receiver
			// reaches.
			it("answers the same step through round", () => {
				expect(
					algebraic.round(radical(2n), roundings.nearest).value,
				).toBe(1)
				expect(algebraic.round(radical(2n), roundings.up).value).toBe(2)
				expect(
					algebraic.round(
						algebraic.negate(radical(2n)),
						roundings.down,
					).value,
				).toBe(-2)
			})

			// NOTE: The property the §§ block promises: the answer is within
			// one unit of the last place of the value itself. It is asserted
			// through `compare`, which is exact, so nothing here rests on a
			// second approximation.
			it("lands within a unit of the last place, for any value", () => {
				const numbers = deterministicNumbers(20260907)

				for (let attempt = 0; attempt < 200; attempt++) {
					const rationalPart = bigRational(
						BigInt((numbers.next().value % 200) - 100),
						BigInt((numbers.next().value % 9) + 1),
					)
					const coefficient = bigRational(
						BigInt((numbers.next().value % 200) - 100),
						BigInt((numbers.next().value % 9) + 1),
					)
					const radicand = BigInt((numbers.next().value % 500) + 2)
					const places = BigInt(numbers.next().value % 12)
					const value = algebraic.createAlgebraic(
						rationalPart,
						coefficient,
						radicand,
					)

					if (value[typeKeySymbol] !== "Algebraic") {
						continue
					}

					const answer = at(value, places)
					const bounds = boundsOf(answer, places)

					expect(algebraic.compare(value, bounds.low)).toEqual(
						ordering.greater,
					)
					expect(algebraic.compare(value, bounds.high)).toEqual(
						ordering.less,
					)
				}
			})
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

		// NOTE: The bounded comparison's promise, in both directions: two
		// values a unit of the last place or more apart are told apart, and
		// empty is answered only for two closer than that. π and e are 0.42
		// apart, so one decimal place decides them; a value 1/1156 above π that
		// carries e rather than π is told from π at three places and not at
		// two; and a difference whose terms cancel is exact at any width.
		describe("compare(to:withPrecision:)", () => {
			const at = (
				first: transcendental.TranscendentalType,
				second: transcendental.TranscendentalType,
				digits: bigint,
			) =>
				transcendental.compare(
					first,
					second,
					integer.createInteger(digits),
				)

			const nearPiOnE = transcendental.multiply(
				number.E,
				rational.createRational(1156n, 1000n),
			) as transcendental.TranscendentalType

			it("tells two values a unit of the last place apart", () => {
				expect(unwrap(at(number.Pi, number.E, 1n))).toEqual(
					ordering.greater,
				)
				expect(unwrap(at(number.E, number.Pi, 1n))).toEqual(
					ordering.less,
				)
				expect(unwrap(at(number.Pi, number.Tau, 1n))).toEqual(
					ordering.less,
				)
				expect(unwrap(at(number.Pi, nearPiOnE, 3n))).toEqual(
					ordering.less,
				)
				expect(unwrap(at(nearPiOnE, number.Pi, 3n))).toEqual(
					ordering.greater,
				)
			})

			// NOTE: Pinned behaviour rather than a promise, as the note above
			// says: what is promised is that no pair a unit or more apart lands
			// here.
			it("answers empty only for two values closer than that", () => {
				expect(at(number.Pi, nearPiOnE, 2n)[typeKeySymbol]).toBe(
					"Optional#Empty",
				)
				expect(at(nearPiOnE, number.Pi, 2n)[typeKeySymbol]).toBe(
					"Optional#Empty",
				)
				expect(at(number.Pi, nearPiOnE, 1n)[typeKeySymbol]).toBe(
					"Optional#Empty",
				)
			})

			it("compares exactly at any width where the terms cancel", () => {
				const shifted = transcendental.add(
					number.Pi,
					rational.createRational(1n, 10n ** 30n),
				)

				expect(unwrap(at(number.Pi, number.Pi, 1n))).toEqual(
					ordering.equal,
				)
				expect(unwrap(at(number.Pi, shifted, 1n))).toEqual(
					ordering.less,
				)
				expect(unwrap(at(shifted, number.Pi, 1n))).toEqual(
					ordering.greater,
				)
			})

			// NOTE: The width promise has to survive a large coefficient, since
			// a base's enclosure is scaled by it: 1000·π against 1000·e + 423
			// differ by about 0.31, so one place decides them where the plain
			// enclosure, a dozen units wide before the guard digits, would not.
			// The empty answer at no places is pinned rather than promised: a
			// pair closer than a unit can fall either way.
			it("keeps the interval under a unit for a large coefficient", () => {
				const thousandPi = transcendental.multiply(
					number.Pi,
					integer.createInteger(1000n),
				) as transcendental.TranscendentalType
				const thousandE = transcendental.add(
					transcendental.multiply(
						number.E,
						integer.createInteger(1000n),
					) as transcendental.TranscendentalType,
					integer.createInteger(423n),
				)

				expect(unwrap(at(thousandPi, thousandE, 1n))).toEqual(
					ordering.greater,
				)
				expect(at(thousandPi, thousandE, 0n)[typeKeySymbol]).toBe(
					"Optional#Empty",
				)
			})
		})

		// NOTE: The sign, which `absolute` already decided inside itself and
		// which no Method of this Namespace could ask before. A value over one
		// base is signed exactly; a value over several refines an interval,
		// and 1000·e − 2718 is the case that needs more than the first
		// enclosure to separate from zero.
		it("answers its own sign", () => {
			const thousandE = transcendental.multiply(
				number.E,
				integer.createInteger(1000n),
			) as transcendental.TranscendentalType

			expect(transcendental.isPositive(number.Pi).value).toBeTrue()
			expect(
				transcendental.isPositive(transcendental.negate(number.Pi))
					.value,
			).toBeFalse()
			expect(
				transcendental.isPositive(
					transcendental.add(number.Pi, integer.createInteger(-3n)),
				).value,
			).toBeTrue()
			expect(
				transcendental.isPositive(
					transcendental.add(number.Pi, integer.createInteger(-4n)),
				).value,
			).toBeFalse()
			expect(
				transcendental.isPositive(
					transcendental.add(
						thousandE,
						integer.createInteger(-2718n),
					),
				).value,
			).toBeTrue()
			expect(
				transcendental.isPositive(
					transcendental.addTranscendental(
						number.Pi,
						transcendental.negate(number.E),
					) as transcendental.TranscendentalType,
				).value,
			).toBeTrue()
		})

		// NOTE: The same refinement `compare` runs, read for digits rather
		// than for a sign: the enclosure is narrowed until both of its ends
		// round alike at the width asked for. π is 3.14159265358979…, e is
		// 2.718281828459…, and their sum is 5.859874482048…, so the answers
		// below are readable digit by digit.
		describe("approximate(toPlaces:toward:)", () => {
			const at = (
				value: transcendental.TranscendentalType,
				places: bigint,
				direction: rounding.RoundingType = roundings.nearest,
			) =>
				transcendental.approximate(
					value,
					integer.createInteger(places),
					direction,
				)

			const digitsOf = (value: rational.RationalType) =>
				`${value.numerator}/${value.denominator}`

			it("answers the step of the grid the value rounds to", () => {
				expect(digitsOf(at(number.Pi, 0n))).toBe("3/1")
				expect(digitsOf(at(number.Pi, 5n))).toBe("314159/100000")
				expect(digitsOf(at(number.E, 8n))).toBe("271828183/100000000")
				expect(digitsOf(at(number.Tau, 4n))).toBe("62832/10000")
			})

			it("answers every rounding rule at the width asked for", () => {
				expect(digitsOf(at(number.Pi, 3n, roundings.down))).toBe(
					"3141/1000",
				)
				expect(digitsOf(at(number.Pi, 3n, roundings.up))).toBe(
					"3142/1000",
				)
				expect(digitsOf(at(number.Pi, 3n, roundings.towardZero))).toBe(
					"3141/1000",
				)
				expect(digitsOf(at(number.Pi, 3n, roundings.nearestEven))).toBe(
					"3142/1000",
				)
			})

			it("rounds a value over both bases", () => {
				const sum = transcendental.addTranscendental(
					number.Pi,
					number.E,
				) as transcendental.TranscendentalType

				expect(digitsOf(at(sum, 6n))).toBe("5859874/1000000")
				expect(transcendental.round(sum, roundings.nearest).value).toBe(
					6,
				)
			})

			// NOTE: The claim the refinement loop exists for. A value a
			// thirty-first of a decimal place above a half can not be decided
			// by the first enclosure, which is eight digits wide, so the guard
			// doubles until it is. Built as π plus the rational that carries π
			// to a half, over a floor of π rather than a rounding of it, so the
			// value is above the half and never on it.
			it("refines an enclosure that does not decide at once", () => {
				const floored = at(number.Pi, 30n, roundings.down)
				const justAboveHalf = transcendental.add(
					number.Pi,
					rational.createRational(
						floored.denominator - 2n * floored.numerator,
						2n * floored.denominator,
					),
				)

				expect(
					transcendental.signRelativeTo(
						justAboveHalf,
						rational.createRational(1n, 2n),
					),
				).toBe(1n)
				expect(digitsOf(at(justAboveHalf, 0n))).toBe("1/1")
				expect(
					digitsOf(at(justAboveHalf, 0n, roundings.nearestEven)),
				).toBe("1/1")
				expect(digitsOf(at(justAboveHalf, 0n, roundings.down))).toBe(
					"0/1",
				)
				expect(
					digitsOf(at(justAboveHalf, 0n, roundings.towardZero)),
				).toBe("0/1")
			})

			// NOTE: The property the §§ block promises, asserted through
			// `signRelativeTo`, which is the exact ordering against a Rational.
			it("lands within a unit of the last place, for any value", () => {
				const numbers = deterministicNumbers(20260908)

				for (let attempt = 0; attempt < 200; attempt++) {
					const coefficients = [
						bigRational(
							BigInt((numbers.next().value % 40) - 20),
							BigInt((numbers.next().value % 9) + 1),
						),
						bigRational(
							BigInt((numbers.next().value % 40) - 20),
							BigInt((numbers.next().value % 9) + 1),
						),
					]
					const places = BigInt(numbers.next().value % 10)
					const value = transcendental.createTranscendental(
						bigRational(
							BigInt((numbers.next().value % 40) - 20),
							BigInt((numbers.next().value % 9) + 1),
						),
						[
							{ base: "π", coefficient: coefficients[0]! },
							{ base: "e", coefficient: coefficients[1]! },
						],
					)

					if (value[typeKeySymbol] !== "Transcendental") {
						continue
					}

					const answer = at(value, places)
					const bounds = boundsOf(answer, places)

					expect(
						transcendental.signRelativeTo(value, bounds.low),
					).toBe(1n)
					expect(
						transcendental.signRelativeTo(value, bounds.high),
					).toBe(-1n)
				}
			})
		})
	})

	describe("Number cross-kind semantics", () => {
		// NOTE: cross-kind `Number.is` is Essence now (`packages/standard-library/sources/Number.es`) and covered by the golden harness.
		// NOTE: the List entries of `lowestNumber`/`highestNumber` — and the
		// empty Optional they answer for an empty List — are Essence now
		// (`packages/standard-library/sources/Number.es`), folds over the pairwise
		// entries seeded with `#Empty`; the golden harness covers every entry
		// including the empty Lists.
		// NOTE: the `isLessThan` family is Essence now (`packages/standard-library/sources/Number.es`) — its agreement with `compare` is covered by the golden harness.
		// NOTE: the `isLessThan` family is Essence now (`packages/standard-library/sources/Number.es`); its symmetry with itself is covered by the golden harness.

		// NOTE: The reason the grid family is spelled the same way on all four
		// kinds. A `Number` reaches a Method only where every member Namespace
		// declares one of the signature, so this is what the `approximate`
		// rungs on `Integer` and `Rational` and the `toward:` on the
		// irrationals' `toString(as:toPlaces:)` were for: one call, whichever
		// kind the value turns out to hold.
		it("reads digits off a Number receiver of any kind", async () => {
			expect(
				await run(`implementation {
					function asNumber(_ value: Number) -> Number {
						<- value
					}

					constant pi    = asNumber(Number.Pi)
					constant whole = asNumber(7)
					constant ratio = asNumber(5/3)

					Terminal.inspect(pi::round(toPlaces 2))
					Terminal.inspect(whole::round(toPlaces 2))
					Terminal.inspect(ratio::round(toPlaces 2))
					Terminal.inspect(pi::approximate(toPlaces 5))
					Terminal.inspect(whole::approximate(toPlaces 5))
					Terminal.inspect(ratio::approximate(toPlaces 2, toward #Down))
					Terminal.inspect(pi::toString(as #Fraction))
					Terminal.inspect(pi::toString(as #Decimal, toPlaces 4))
					Terminal.inspect(whole::toString(as #Decimal, toPlaces 2))
					Terminal.inspect(ratio::toString(as #Percent, toPlaces 1))
					Terminal.inspect(pi::toString(as #Scientific, toPlaces 3))
				}`),
			).toEqual([
				"157/50",
				"7",
				"167/100",
				"314159/100000",
				"7/1",
				"83/50",
				`"π"`,
				`"3.1416"`,
				`"7.00"`,
				`"166.7%"`,
				`"3.142e0"`,
			])
		})

		// NOTE: `Number.lowest`/`highest` gained a widest entry, kept behind
		// the four kind-preserving ones so that two Integers still answer an
		// Integer. It is the only entry an irrational reaches, because it is
		// written on the covering `Number`'s ordering rather than on a kind's
		// own. The bound Constants are what read the answered Type back.
		it("answers the lower and higher of two Numbers of any kind", async () => {
			expect(
				await run(`implementation {
					constant lower: Number = Number.lowest(3, Number.Pi)
					constant higher: Number = Number.highest(3, Number.Pi)
					§ The four kind-preserving entries still stand ahead of it.
					constant integer: Integer = Number.lowest(3, 2)

					Terminal.inspect(lower::toString())
					Terminal.inspect(higher::toString())
					Terminal.inspect(integer)
					Terminal.inspect(Number.highest(Number.Pi, Number.E)::toString())
					Terminal.inspect(Number.lowest(Number.Pi, Number.E)::toString())
				}`),
			).toEqual([`"3"`, `"π"`, "2", `"π"`, `"e"`])
		})
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
		// NOTE: Both halves of the split. A receiver the Program COMPUTED might
		// be negative, so `squareRoot` answers an Optional there; a written one
		// proves its own sign and reaches `namespace NonNegativeInteger`, whose
		// entry answers the two kinds bare.
		// NOTE: The receiver is a DIFFERENCE, which is the one operation no
		// refinement of Integer closes over — a sum of two written Integers
		// answers a `PositiveInteger` and reaches the total root beside it.
		it("types squareRoot as Optional<Integer | Algebraic>", () => {
			expect(
				diagnosticsFor(`implementation {
					constant two = 3::subtract(1)
					constant root: Optional<Integer | Algebraic> = two::squareRoot()
					constant written: Integer | Algebraic = 2::squareRoot()
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
		// resolve on it, and this would stop being Diagnostic-free. One match
		// narrows the Union `squareRoot` answers a written receiver with.
		it("keeps division by an Algebraic total — the quotient is not an Optional", () => {
			expect(
				diagnosticsFor(`implementation {
					constant root = 2::squareRoot()

					Terminal.inspect(match root -> String {
						case Algebraic { <- 1::divide(by @)::toString() }
						case Integer { <- @::toString() }
					})
				}`),
			).toEqual([])
		})

		// NOTE: A Union receiver dispatches only where EVERY member Namespace
		// declares the Method, so this is the check that `round(toward:)` now
		// has all four rungs — Integer's and Rational's were already written,
		// and the two irrationals gained one each. It is written through a
		// Function so the receiver is a `Number` the Program was handed rather
		// than a value that proves its own kind.
		it("reaches round on a Number receiver, across every kind", async () => {
			expect(
				await run(`implementation {
					function asNumber(_ value: Number) -> Number {
						<- value
					}

					Terminal.inspect(asNumber(Number.Pi)::round())
					Terminal.inspect(asNumber(Number.GoldenRatio)::round(toward #Up))
					Terminal.inspect(asNumber(3/2)::round())
					Terminal.inspect(asNumber(7)::round(toward #Down))
				}`),
			).toEqual(["3", "2", "2", "7"])
		})

		// NOTE: The four questions a `Number` receiver could not ask before,
		// each of which needed a rung on both irrationals. `isZero` and
		// `isWholeNumber` answer `false` for every irrational, which is the
		// mirror of `Integer::isWholeNumber` answering `true` for every
		// Integer, and both are here so the Union can dispatch at all.
		it("reaches the sign and wholeness questions on a Number receiver", async () => {
			expect(
				await run(`implementation {
					function asNumber(_ value: Number) -> Number {
						<- value
					}

					Terminal.inspect(asNumber(Number.Pi)::isPositive())
					Terminal.inspect(asNumber(Number.GoldenRatio::negate())::isNegative())
					Terminal.inspect(asNumber(Number.Pi)::isZero())
					Terminal.inspect(asNumber(Number.GoldenRatio)::isWholeNumber())
					Terminal.inspect(asNumber(0)::isZero())
					Terminal.inspect(asNumber(7)::isWholeNumber())
				}`),
			).toEqual(["true", "true", "false", "false", "true", "true"])
		})

		// NOTE: The decimal rendering, which is `approximate` under a name a
		// reader reaches for. The entry with no count is capped where a
		// Rational's non-terminating expansion is capped, at eighty digits.
		// Rounding at the eightieth left π with two trailing zeroes, and a
		// Rational drops those, so the text is eighty characters: one digit,
		// the point, and seventy-eight after it.
		it("writes an irrational as a decimal", async () => {
			expect(
				await run(`implementation {
					constant root: Algebraic = match 2::squareRoot() -> Algebraic {
						case Algebraic { <- @ }
						case Integer { <- Number.GoldenRatio }
					}

					Terminal.inspect(Number.Pi::toString(as #Decimal, toPlaces 4))
					Terminal.inspect(Number.Pi::toString(as #Fraction))
					Terminal.inspect(Number.Pi::negate()::toString(as #Decimal, toPlaces 2))
					Terminal.inspect(root::toString(as #Decimal, toPlaces 6))
					Terminal.inspect(Number.Pi::toString(as #Decimal)::length())
				}`),
			).toEqual([`"3.1416"`, `"π"`, `"-3.14"`, `"1.414214"`, "80"])
		})

		// NOTE: The other two formats, and the direction the count entry takes.
		// Each arm reads the value at the width its own writing needs: a
		// decimal at the count, a percentage two digits deeper so the shift by
		// a hundred stays exact, and a scientific form at the eightieth digit,
		// since where its exponent falls is what would decide the depth. The
		// last two lines pin what that leaves the entries with no count. A
		// percentage is read two digits deeper, so eighty digits stand after
		// its point: three before it, the point, eighty after and the `%` is
		// 85 characters. A scientific form is the same eighty-digit reading a
		// decimal gets, and π's loses two trailing zeroes to the trimming
		// every Rational gets — the decimal is 80 characters, and the `e0`
		// after it makes 82.
		it("writes an irrational as a percentage and in scientific notation", async () => {
			expect(
				await run(`implementation {
					Terminal.inspect(Number.Pi::toString(as #Percent, toPlaces 2))
					Terminal.inspect(Number.Pi::toString(as #Scientific, toPlaces 4))
					Terminal.inspect(Number.Pi::toString(as #Decimal, toPlaces 4, toward #Down))
					Terminal.inspect(Number.Pi::toString(as #Percent, toPlaces 2, toward #Down))
					Terminal.inspect(Number.Pi::multiply(with 1/1000)::toString(as #Scientific, toPlaces 3))
					Terminal.inspect(Number.Pi::toString(as #Percent)::length())
					Terminal.inspect(Number.Pi::toString(as #Scientific)::length())
				}`),
			).toEqual([
				`"314.16%"`,
				`"3.1416e0"`,
				`"3.1415"`,
				`"314.15%"`,
				`"3.142e-3"`,
				"85",
				"82",
			])
		})

		// NOTE: The whole point of the approximation API, written the way a
		// Program writes it: an exact area, then digits asked for once at the
		// end.
		//
		// NOTE: `inspect` shows a Rational in lowest terms, so `4·π` over four
		// places reads `7854/625` rather than the `125664/10000` the grid is
		// built on. The two are one number; the direct tests above read the
		// unreduced pair off the answer, which is what makes the digits
		// legible there.
		it("answers digits for an exact irrational area", async () => {
			expect(
				await run(`implementation {
					constant area = Number.Pi::multiply(with 2::raise(to 2))

					Terminal.inspect(area::toString())
					Terminal.inspect(area::approximate(toPlaces 4))
					Terminal.inspect(area::round(toPlaces 2))
				}`),
			).toEqual([`"4·π"`, "7854/625", "1257/100"])
		})
	})
})
