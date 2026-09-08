import { describe, expect, it } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import * as algebraic from "@essence-lang/runtime/Algebraic"
import * as integer from "@essence-lang/runtime/Integer"
import * as number from "@essence-lang/runtime/Number"
import {
	decimal,
	fraction,
	percent,
	scientific,
} from "@essence-lang/runtime/NumberFormat"
import * as optional from "@essence-lang/runtime/Optional"
import * as ordering from "@essence-lang/runtime/Ordering"
import * as rational from "@essence-lang/runtime/Rational"
import {
	down,
	nearest,
	nearestEven,
	towardZero,
	up,
} from "@essence-lang/runtime/Rounding"
import { type AnyType, typeKeySymbol } from "@essence-lang/runtime/type"

import { containsErrors } from "../diagnostics/index"
import { enrich } from "../enricher/index"
import { optimise } from "../optimiser/index"
import { parseWithDiagnostics } from "../parser/index"
import { rewrite } from "../rewriter/index"
import { simplify } from "../simplifier/index"
import { validate } from "../validator/index"

// NOTE: The two invariants a Rational is built on — the sign lives on the
// numerator, and zero is `0/1` — plus the two places they historically leaked:
// an Integer-operand `divide` that handed the sign to the DENOMINATOR, which
// every ordering primitive then read backwards, and a `reduce` that bailed on
// a zero operand, so a cancelled `0/4` could never reduce itself. The
// arithmetic is written in Essence now (`packages/standard-library/sources/Rational.es`)
// and funnels every result through `Rational.of` into `createRational`, so the
// direct half of these tests checks THAT gateway — the one place the invariants
// are enforced — and the compiled Programs below check the same behaviour
// through the Essence bodies, because the damage the leaks did was visible from
// Essence: `absolute()`, `round(toward:)` and `isWholeNumber()` are all written on
// top of them.

function generate(source: string): string {
	let parsed = parseWithDiagnostics(source)

	expect(containsErrors(parsed.diagnostics)).toBe(false)

	let enriched = enrich(parsed.program)

	expect(containsErrors(enriched.diagnostics)).toBe(false)
	expect(containsErrors(validate(enriched.program))).toBe(false)

	return rewrite(optimise(simplify(enriched.program)))
}

async function run(source: string): Promise<Array<string>> {
	let js = generate(source)
	let directory = mkdtempSync(join(tmpdir(), "essence-rationals-"))
	let file = join(directory, "program.ts")

	writeFileSync(file, js)

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

const partsOf = (value: rational.RationalType) => ({
	numerator: value.numerator,
	denominator: value.denominator,
})

// NOTE: Every fallible native answers an `Optional<…>` — `Rational.of` has no
// answer for a zero denominator, `squareRoot` none for a negative radicand —
// so the direct tests below have to step through the `#Value` Case before they
// reach the value the invariants live on. The tag is asserted on the way past
// rather than cast away: an accidental `#Empty` would otherwise hand the checks
// an `undefined` payload, and `undefined` compares equal to nothing they ask
// about, which reads as a failure somewhere else entirely.
function valueOf<Item extends AnyType>(
	built: optional.OptionalType<Item>,
): Item {
	expect(built[typeKeySymbol]).toBe("Optional#Value")

	return (built as optional.ValueType<Item>).item
}

describe("Rationals", () => {
	describe("The positive-denominator invariant", () => {
		it("keeps the sign on the numerator at the createRational gateway", () => {
			expect(partsOf(rational.createRational(1n, -6n))).toEqual({
				numerator: -1n,
				denominator: 6n,
			})
		})

		it("keeps the sign on the numerator through Rational.of", () => {
			const built = valueOf(
				rational.of__overload$1(
					integer.createInteger(1n),
					integer.createInteger(-6n),
				),
			)

			expect(built[typeKeySymbol]).toBe("Rational")
			expect(partsOf(built as rational.RationalType)).toEqual({
				numerator: -1n,
				denominator: 6n,
			})
		})

		it("orders a gateway-normalised Rational below zero", () => {
			const quotient = rational.createRational(1n, -6n)
			const zero = rational.createRational(0n, 1n)

			expect(rational.compare(quotient, zero)).toEqual(ordering.less)
			expect(number.compare(quotient, zero)).toEqual(ordering.less)
		})

		it("reads the accessors off the numerator's sign", () => {
			const quotient = rational.createRational(1n, -6n)

			expect(rational.numerator(quotient).value).toBe(-1)
			expect(rational.denominator(quotient).value).toBe(6)
		})
	})

	describe("Canonical zero", () => {
		// NOTE: `1/2 − 1/2` builds `(1·2 + −1·2)/4` in the Essence `add` — a
		// zero that reaches the gateway with a denominator of 4 and must leave
		// it as `0/1`. The gateway is checked with that same shape here, and
		// the Essence route to it in the compiled Programs below.
		const cancelled = () => rational.createRational(0n, 4n)

		it("reduces a cancelled zero to 0/1", () => {
			expect(partsOf(cancelled())).toEqual({
				numerator: 0n,
				denominator: 1n,
			})
		})

		it("answers a denominator of one for every zero", () => {
			expect(rational.denominator(cancelled()).value).toBe(1)
			expect(
				rational.denominator(rational.createRational(0n, 6n)).value,
			).toBe(1)
		})

		// NOTE: The structural form and the form a caller asks for differ on a
		// whole value. `formatAsRational` is what `Terminal.inspect` shows, so
		// it says what a Rational IS; `toString(as #Fraction)` prints the
		// numerator alone, exactly as the no-Argument `toString` does.
		it("prints every zero as 0/1 structurally, and as 0 to a caller", () => {
			expect(rational.formatAsRational(cancelled())).toBe("0/1")
			expect(
				rational.toString__overload$2(cancelled(), fraction).value,
			).toBe("0")
			expect(
				rational.formatAsRational(rational.createRational(0n, 6n)),
			).toBe("0/1")
		})

		it("still compares a zero equal whatever it was built from", () => {
			expect(
				rational.compare(cancelled(), rational.createRational(0n, 1n)),
			).toEqual(ordering.equal)
		})
	})

	describe("The decimal form", () => {
		it("prints a whole-valued Rational without a trailing dot", () => {
			expect(
				rational.toString__overload$2(
					rational.createRational(4n, 2n),
					decimal,
				).value,
			).toBe("2")
			expect(
				rational.toString__overload$2(
					rational.createRational(-4n, 2n),
					decimal,
				).value,
			).toBe("-2")
			expect(
				rational.toString__overload$2(
					rational.createRational(0n, 1n),
					decimal,
				).value,
			).toBe("0")
		})

		it("keeps the fractional digits it has", () => {
			expect(
				rational.toString__overload$2(
					rational.createRational(1n, 2n),
					decimal,
				).value,
			).toBe("0.5")
			expect(
				rational.toString__overload$2(
					rational.createRational(-3n, 4n),
					decimal,
				).value,
			).toBe("-0.75")
		})

		// NOTE: The cap and the rounding are deliberate: a non-terminating
		// expansion is cut at 80 fractional digits, and the cut digit rounds
		// halves away from zero, like `round` does. `2/3` ending in `…667`
		// is what separates rounding from the truncation it replaced.
		it("cuts a non-terminating expansion at 80 digits and rounds the last one", () => {
			expect(
				rational.toString__overload$2(
					rational.createRational(1n, 3n),
					decimal,
				).value,
			).toBe(`0.${"3".repeat(80)}`)
			expect(
				rational.toString__overload$2(
					rational.createRational(2n, 3n),
					decimal,
				).value,
			).toBe(`0.${"6".repeat(79)}7`)
			expect(
				rational.toString__overload$2(
					rational.createRational(-2n, 3n),
					decimal,
				).value,
			).toBe(`-0.${"6".repeat(79)}7`)
		})

		// NOTE: `1 − 5·10⁻⁸¹` expands to eighty 9s with an exactly-half tail, so
		// the round-up has to carry through every kept digit into the whole part
		// — and the zeroes it leaves behind are artifacts, not expansion digits.
		it("carries a round-up through the kept digits into the whole part", () => {
			const scale = 2n * 10n ** 80n

			expect(
				rational.toString__overload$2(
					rational.createRational(scale - 1n, scale),
					decimal,
				).value,
			).toBe("1")
			expect(
				rational.toString__overload$2(
					rational.createRational(1n - scale, scale),
					decimal,
				).value,
			).toBe("-1")
		})

		it("round-trips the decimal form back through parse", async () => {
			expect(
				await run(`implementation {
					constant values = [4/2, 0/1::subtract(4/2), 0/1, 1/2]

					values::map((value) {
						constant text = value
							::toString(as NumberFormat#Decimal)

						<- Terminal.inspect(match Rational.parse(text) -> String {
							case #Value(parsed) {
								<- parsed::is(value)::toString()
							}
							case #Empty { <- "Empty" }
						})
					})
				}`),
			).toEqual(['"true"', '"true"', '"true"', '"true"'])
		})
	})

	describe("The square root of zero", () => {
		it("gives the exact Integer zero", () => {
			expect(
				integer.squareRoot__overload$1(integer.createInteger(0n)),
			).toEqual(optional.createValue(integer.createInteger(0n)))
		})

		it("gives the exact Rational zero", () => {
			const root = valueOf(
				rational.squareRoot__overload$1(
					rational.createRational(0n, 5n),
				),
			)

			expect(root[typeKeySymbol]).toBe("Rational")
			expect(partsOf(root as rational.RationalType)).toEqual({
				numerator: 0n,
				denominator: 1n,
			})
		})

		// NOTE: `extractSquarePart(0)` leaves 0 whole — its trial division
		// starts above it — so the collapse test has to name the radicand 0
		// itself. Without this an Algebraic escaped with `radicand: 0` and a
		// non-zero radical coefficient, which every sign routine read as
		// strictly positive: `√0` compared GREATER than zero.
		it("collapses a zero radicand at the createAlgebraic gateway", () => {
			const value = algebraic.createAlgebraic(
				{ numerator: 3n, denominator: 4n },
				{ numerator: 1n, denominator: 1n },
				0n,
			)

			expect(value[typeKeySymbol]).toBe("Rational")
			expect(partsOf(value as rational.RationalType)).toEqual({
				numerator: 3n,
				denominator: 4n,
			})
		})

		it("never hands back an Algebraic that is not irrational", () => {
			const root = valueOf(
				algebraic.squareRootOfRational({
					numerator: 0n,
					denominator: 1n,
				}),
			)

			expect(root[typeKeySymbol]).toBe("Rational")
			expect(
				number.compare(
					root as rational.RationalType,
					integer.createInteger(0n),
				),
			).toEqual(ordering.equal)
		})
	})

	// NOTE: The two formats that rewrite the value before they render it. A
	// percentage is one hundred times the receiver, and the scientific form is
	// the receiver over the largest power of ten at or below it — so both are
	// held to the same 80-digit cap and the same fixed widths the decimal form
	// is, and both are checked here against a value whose expansion never ends.
	describe("The percent and scientific forms", () => {
		const plain = (
			numerator: bigint,
			denominator: bigint,
			format: Parameters<typeof rational.toString__overload$2>[1],
		) =>
			rational.toString__overload$2(
				rational.createRational(numerator, denominator),
				format,
			).value

		const fixed = (
			numerator: bigint,
			denominator: bigint,
			format: Parameters<typeof rational.toString__overload$3>[1],
			places: number,
		) =>
			rational.toString__overload$3(
				rational.createRational(numerator, denominator),
				format,
				integer.createInteger(BigInt(places)),
				nearest,
			).value

		it("writes a percentage as one hundred times the decimal", () => {
			expect(plain(3n, 4n, percent)).toBe("75%")
			expect(plain(1n, 8n, percent)).toBe("12.5%")
			expect(fixed(1n, 8n, percent, 1)).toBe("12.5%")
			expect(fixed(-1n, 4n, percent, 0)).toBe("-25%")
			expect(fixed(0n, 1n, percent, 2)).toBe("0.00%")
		})

		it("caps a percentage's expansion where the decimal form caps", () => {
			expect(plain(1n, 3n, percent)).toBe(`33.${"3".repeat(80)}%`)
		})

		it("writes one digit before the point and the power of ten after an e", () => {
			expect(plain(1234n, 1n, scientific)).toBe("1.234e3")
			expect(fixed(1234n, 1n, scientific, 2)).toBe("1.23e3")
			expect(plain(1n, 2000n, scientific)).toBe("5e-4")
			expect(plain(-5n, 1n, scientific)).toBe("-5e0")
			expect(plain(1n, 1n, scientific)).toBe("1e0")
		})

		it("writes zero as 0e0, at every width", () => {
			expect(plain(0n, 1n, scientific)).toBe("0e0")
			expect(fixed(0n, 1n, scientific, 2)).toBe("0.00e0")
		})

		// NOTE: A mantissa is below ten before it is rounded and can reach ten
		// after — `9.99` at one place is `10.0` — so the exponent has to take
		// the carry. Ten is the only value a carry can reach, so one step of
		// renormalisation is the whole of it.
		it("carries a rounded mantissa into the exponent", () => {
			expect(fixed(999n, 100n, scientific, 1)).toBe("1.0e1")
			expect(fixed(9999n, 1000n, scientific, 2)).toBe("1.00e1")
			expect(fixed(-999n, 100n, scientific, 1)).toBe("-1.0e1")
		})

		it("ignores the two new formats where the fraction form is asked for", () => {
			expect(fixed(3n, 4n, fraction, 2)).toBe("3/4")
		})

		it("reaches both formats from a Program", async () => {
			expect(
				await run(`implementation {
					Terminal.inspect(1/8::toString(as #Percent, toPlaces 1))
					Terminal.inspect(1234::divide(by 1, defaultingTo 0/1)
						::toString(as #Scientific, toPlaces 2))
				}`),
			).toEqual(['"12.5%"', '"1.23e3"'])
		})
	})

	// NOTE: `#NearestEven` is the one Rounding Case whose answer depends on the
	// step below rather than only on the distance to it, so every test here
	// pairs a tie with the parity of its floor. `round` is written in Essence,
	// so all of them go through a compiled Program: there is no native to
	// drive.
	// NOTE: The fixed-width formatter rounds the one digit it cuts, and the
	// direction is what decides which way. It works on the MAGNITUDE with the
	// sign prefixed afterwards, so `#Down` and `#Up` have to read the sign back
	// — a negative value rounded down is rounded AWAY from zero — and these
	// tests are what hold that pairing.
	describe("The rounded width", () => {
		const fixed = (
			numerator: bigint,
			denominator: bigint,
			places: number,
			direction: Parameters<typeof rational.toString__overload$3>[3],
		) =>
			rational.toString__overload$3(
				rational.createRational(numerator, denominator),
				decimal,
				integer.createInteger(BigInt(places)),
				direction,
			).value

		it("rounds the cut digit in the named direction", () => {
			expect(fixed(5n, 3n, 2, nearest)).toBe("1.67")
			expect(fixed(5n, 3n, 2, down)).toBe("1.66")
			expect(fixed(5n, 3n, 2, up)).toBe("1.67")
			expect(fixed(5n, 3n, 2, towardZero)).toBe("1.66")
			expect(fixed(5n, 3n, 2, nearestEven)).toBe("1.67")
		})

		it("reads the sign back for the two directions that name a side", () => {
			expect(fixed(-5n, 3n, 2, nearest)).toBe("-1.67")
			expect(fixed(-5n, 3n, 2, down)).toBe("-1.67")
			expect(fixed(-5n, 3n, 2, up)).toBe("-1.66")
			expect(fixed(-5n, 3n, 2, towardZero)).toBe("-1.66")
		})

		it("takes the even digit at a half, on either side of zero", () => {
			expect(fixed(1n, 8n, 2, nearestEven)).toBe("0.12")
			expect(fixed(3n, 8n, 2, nearestEven)).toBe("0.38")
			expect(fixed(-1n, 8n, 2, nearestEven)).toBe("-0.12")
			expect(fixed(1n, 8n, 2, nearest)).toBe("0.13")
		})

		it("leaves a value already on the grid alone in every direction", () => {
			expect(fixed(1n, 2n, 2, down)).toBe("0.50")
			expect(fixed(-1n, 2n, 2, down)).toBe("-0.50")
			expect(fixed(-1n, 2n, 2, up)).toBe("-0.50")
		})

		// NOTE: The count has no ceiling, where the entry beside it stops at 80
		// digits — measured at 15 ms for 200 000 places. This asks for more
		// digits than that cap and checks the expansion is what long division
		// gives, so a cap added later fails here rather than silently
		// shortening an answer a caller asked the width of.
		it("writes every place it is asked for, past the 80 the capped entry stops at", () => {
			let text = fixed(2n, 3n, 200, nearest)

			expect(text.length).toBe(202)
			expect(text).toBe(`0.${"6".repeat(199)}7`)
		})

		it("names #Nearest for a call that leaves the direction out", async () => {
			expect(
				await run(`implementation {
					Terminal.inspect(1/8::toString(as #Decimal, toPlaces 2))
					Terminal.inspect(
						1/8::toString(as #Decimal, toPlaces 2, toward #Nearest),
					)
				}`),
			).toEqual(['"0.13"', '"0.13"'])
		})
	})

	describe("Banker's rounding", () => {
		it("sends a tie to the even step on either side of zero", async () => {
			expect(
				await run(`implementation {
					constant halves = [-5/2, -3/2, -1/2, 1/2, 3/2, 5/2, 7/2]

					halves::map((half) {
						<- Terminal.inspect(
							half::round(toward #NearestEven)::toString(),
						)
					})
				}`),
			).toEqual(['"-2"', '"-2"', '"0"', '"0"', '"2"', '"2"', '"4"'])
		})

		it("answers what #Nearest answers where there is no tie", async () => {
			expect(
				await run(`implementation {
					constant values = [-9/4, -1/4, 1/4, 9/4, 11/4]

					values::map((value) {
						<- Terminal.inspect(
							value::round(toward #NearestEven)::toString(),
						)
					})
				}`),
			).toEqual(['"-2"', '"0"', '"0"', '"2"', '"3"'])
		})

		it("takes the even digit at a decimal grid", async () => {
			expect(
				await run(`implementation {
					Terminal.inspect(
						1/8::round(toPlaces 2, toward #NearestEven)::toString(),
					)
					Terminal.inspect(
						3/8::round(toPlaces 2, toward #NearestEven)::toString(),
					)
					Terminal.inspect(1/8::round(toPlaces 2)::toString())
				}`),
			).toEqual(['"3/25"', '"19/50"', '"13/100"'])
		})

		// NOTE: The bias the Case exists for, measured rather than argued. The
		// hundred halves `1/2` through `199/2` sum to exactly 5000; rounding
		// each away from zero first totals 5050, and rounding each to its even
		// neighbour totals 5000. Exhaustive over the run rather than a `for
		// any` draw, because the halves ARE the whole of what separates the two
		// Cases and a draw would mostly miss them.
		it("keeps a run of halves on its exact total", async () => {
			expect(
				await run(`implementation {
					constant halves = List.of(integersFrom 1, through 100)
						::map((step) {
							<- Rational.of(
								step::multiply(with 2)::subtract(1),
								over 2,
							)
						})

					Terminal.inspect(halves::sum()::toString())
					Terminal.inspect(
						halves::map((half) { <- half::round() })
							::sum()
							::toString(),
					)
					Terminal.inspect(
						halves::map((half) {
							<- half::round(toward #NearestEven)
						})
							::sum()
							::toString(),
					)
				}`),
			).toEqual(['"5000"', '"5050"', '"5000"'])
		})
	})

	// NOTE: The Integer rungs of the formatting family. What they are FOR is a
	// receiver of `Integer | Rational` — the Type a mixed List sums to — which
	// dispatches per member and needs both Namespaces to declare the name. So
	// every test here runs the call twice: once on an Integer, and once on a
	// Scalar the Compiler can not narrow.
	describe("Integer's rung of the formatting family", () => {
		it("writes an Integer in every format", async () => {
			expect(
				await run(`implementation {
					Terminal.inspect(42::toString(as #Decimal))
					Terminal.inspect(42::toString(as #Fraction))
					Terminal.inspect(42::toString(as #Percent))
					Terminal.inspect(1234::toString(as #Scientific))
					Terminal.inspect(42::toString(as #Decimal, toPlaces 2))
					Terminal.inspect(
						1234::toString(as #Scientific, toPlaces 2),
					)
				}`),
			).toEqual([
				'"42"',
				'"42"',
				'"4200%"',
				'"1.234e3"',
				'"42.00"',
				'"1.23e3"',
			])
		})

		it("answers the receiver for every width and direction", async () => {
			expect(
				await run(`implementation {
					Terminal.inspect(5::round(toPlaces 2))
					Terminal.inspect(-5::round(toPlaces 2, toward #Down))
					Terminal.inspect(5::round(toPlaces 0, toward #NearestEven))
				}`),
			).toEqual(["5", "-5", "5"])
		})

		// NOTE: The Type is written out rather than inferred, so the receiver
		// is the Union both rungs answer for and neither the Integer nor the
		// Rational entry can be reached on its own. Without Integer's rungs
		// these three calls are `no-matching-overload`, which is the hole this
		// package was written to close.
		it("dispatches a Scalar receiver over both rungs", async () => {
			expect(
				await run(`implementation {
					constant mixed: List<Integer | Rational> = [1, 3/2, 2]
					constant total = mixed::sum()

					Terminal.inspect(total::toString(as #Decimal, toPlaces 2))
					Terminal.inspect(total::toString(as #Percent, toPlaces 1))
					Terminal.inspect(total::round(toPlaces 1))

					constant whole: List<Integer | Rational> = [1, 2]

					Terminal.inspect(
						whole::sum()::toString(as #Decimal, toPlaces 2),
					)
					Terminal.inspect(whole::sum()::round(toPlaces 1))
				}`),
			).toEqual(['"4.50"', '"450.0%"', "9/2", '"3.00"', "3"])
		})
	})

	describe("Compiled Programs", () => {
		it("divides by a negative Integer without corrupting the value", async () => {
			expect(
				await run(`implementation {
					constant negativeThree = 0::subtract(3)

					match 1/2::divide(by negativeThree) -> {} {
						case #Value(quotient) {
							Terminal.inspect(quotient::toString())
							Terminal.inspect(quotient::isLessThan(0/1)::toString())
							Terminal.inspect(quotient::absolute()::toString())
							Terminal.inspect(quotient::round(toward #Down)::toString())
							<- {}
						}
						case #Empty {
							Terminal.inspect("Empty")
							<- {}
						}
					}
				}`),
			).toEqual(['"-1/6"', '"true"', '"1/6"', '"-1"'])
		})

		it("rounds and truncates a negative quotient towards the right ends", async () => {
			expect(
				await run(`implementation {
					constant negativeThree = 0::subtract(3)

					match 1/2::divide(by negativeThree) -> {} {
						case #Value(quotient) {
							Terminal.inspect(quotient::round()::toString())
							Terminal.inspect(quotient::round(toward #TowardZero)::toString())
							Terminal.inspect(quotient::isLessThan(0)::toString())
							Terminal.inspect(quotient::isGreaterThan(0)::toString())
							<- {}
						}
						case #Empty {
							Terminal.inspect("Empty")
							<- {}
						}
					}
				}`),
			).toEqual(['"0"', '"0"', '"true"', '"false"'])
		})

		it("keeps the invariant through the Integer-operand arithmetic", async () => {
			expect(
				await run(`implementation {
					constant half = 1/2
					constant negativeThree = 0::subtract(3)
					constant negativeOne = 0::subtract(1)

					Terminal.inspect(half::multiply(with negativeThree)::toString())
					Terminal.inspect(half::add(negativeOne)::toString())
					Terminal.inspect(half::toString())
				}`),
			).toEqual(['"-3/2"', '"-1/2"', '"1/2"'])
		})

		it("prints a negative quotient in a form parse reads back", async () => {
			expect(
				await run(`implementation {
					constant negativeThree = 0::subtract(3)

					match 1/2::divide(by negativeThree) -> {} {
						case #Value(quotient) {
							constant text = quotient::toString()

							Terminal.inspect(text)
							Terminal.inspect(match Rational.parse(text) -> String {
								case #Value(parsed) { <- parsed::toString() }
								case #Empty         { <- "Empty" }
							})
							<- {}
						}
						case #Empty {
							Terminal.inspect("Empty")
							<- {}
						}
					}
				}`),
			).toEqual(['"-1/6"', '"-1/6"'])
		})

		// NOTE: The List is bound to a `List` Type on purpose. A written List is
		// its own proof of having an item, so a literal Argument would reach
		// `Number.lowestNumber(_ NonEmptyList<Integer | Rational>)` and answer
		// bare — and the fold under test here is the one answering an Optional.
		it("finds the lowest of a mixed List through the Essence fold", async () => {
			expect(
				await run(`implementation {
					constant negativeThree = 0::subtract(3)
					constant negativeOne = 0::subtract(1)
					constant quotient = 1/2
						::divide(by negativeThree)
						::value(defaultingTo 0/1)
					constant mixed: List<Integer | Rational> = [
						quotient,
						negativeOne,
					]

					Terminal.inspect(match Number.lowestNumber(mixed) -> String {
						case #Value(lowest) {
							<- match lowest -> String {
								case Integer  { <- @::toString() }
								case Rational { <- @::toString() }
							}
						}
						case #Empty { <- "Empty" }
					})
				}`),
			).toEqual(['"-1"'])
		})

		it("says a cancelled zero is a whole number", async () => {
			expect(
				await run(`implementation {
					constant cancelled = 1/2::subtract(1/2)

					Terminal.inspect(cancelled::toString())
					Terminal.inspect(cancelled::denominator()::toString())
					Terminal.inspect(cancelled::isWholeNumber()::toString())
				}`),
			).toEqual(['"0"', '"1"', '"true"'])
		})

		it("prints a whole-valued Rational as a decimal a caller can read back", async () => {
			expect(
				await run(`implementation {
					Terminal.inspect(4/2::toString(as NumberFormat#Decimal))
					Terminal.inspect(1/2::subtract(1/2)::toString(as NumberFormat#Decimal))
					Terminal.inspect(match Rational.parse(4/2::toString(as NumberFormat#Decimal)) -> String {
						case #Value(parsed) { <- parsed::toString() }
						case #Empty         { <- "Empty" }
					})
				}`),
			).toEqual(['"2"', '"0"', '"2"'])
		})

		it("takes the root of zero as an Integer, not an Algebraic", async () => {
			expect(
				await run(`implementation {
					Terminal.inspect(match 0::squareRoot() -> String {
						case Integer   { <- @::toString() }
						case Algebraic { <- @::toString() }
					})

					Terminal.inspect(match 0/5::squareRoot() -> String {
						case #Value(root) {
							<- match root -> String {
								case Rational  { <- @::toString() }
								case Algebraic { <- @::toString() }
							}
						}
						case #Empty { <- "Empty" }
					})
				}`),
			).toEqual(['"0"', '"0"'])
		})

		// NOTE: `Rational::isPositive` is `@::isGreaterThan(0/1)` and
		// `isNegative` is `@::isLessThan(0/1)` — one call on `@` each, so a
		// refinement written on either name is the comparison's own Type, and
		// the guard that asks the comparison proves it. Written as chains over
		// the numerator, both were questions of their own, and every line here
		// that hands `r` on was `argument-type-mismatch`: the guard proved
		// nothing a `PositiveRational` asks for, and a written `3/4` proved it
		// neither. The `else` of `isPositive` narrows too, to the negation the
		// alias records, which is what `isLessThanOrEqualTo(0/1)` reads.
		it("narrows a Rational by its sign through the comparison it is written on", async () => {
			expect(
				await run(`implementation {
					type PositiveRational = Rational where @::isPositive()
					type NegativeRational = Rational where @::isNegative()

					function keepPositive(_ r: PositiveRational) -> Rational { <- r }
					function keepNegative(_ r: NegativeRational) -> Rational { <- r }

					constant r = 0/1::subtract(3/4)

					if r::isGreaterThan(0/1) {
						Terminal.inspect(keepPositive(r))
					} else {
						Terminal.inspect("not positive")
					}

					if r::isLessThan(0/1) {
						Terminal.inspect(keepNegative(r))
					}

					if r::isPositive() {
						Terminal.inspect(keepPositive(r))
					} else {
						Terminal.inspect(r::isLessThanOrEqualTo(0/1))
					}

					Terminal.inspect(keepPositive(3/4))
					Terminal.inspect(keepNegative(-3/4))
				}`),
			).toEqual(['"not positive"', "-3/4", "true", "3/4", "-3/4"])
		})
	})
})
