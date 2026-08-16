import { describe, expect, it } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import * as algebraic from "@essence-lang/runtime/Algebraic"
import * as integer from "@essence-lang/runtime/Integer"
import * as number from "@essence-lang/runtime/Number"
import { decimal, fraction } from "@essence-lang/runtime/NumberFormat"
import * as optional from "@essence-lang/runtime/Optional"
import * as ordering from "@essence-lang/runtime/Ordering"
import * as rational from "@essence-lang/runtime/Rational"
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

		it("prints every zero as 0/1", () => {
			expect(rational.formatAsRational(cancelled())).toBe("0/1")
			expect(
				rational.toString__overload$2(cancelled(), fraction).value,
			).toBe("0/1")
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
							::toString(formatAs NumberFormat#Decimal)

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
			expect(integer.squareRoot(integer.createInteger(0n))).toEqual(
				optional.createValue(integer.createInteger(0n)),
			)
		})

		it("gives the exact Rational zero", () => {
			const root = valueOf(
				rational.squareRoot(rational.createRational(0n, 5n)),
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

		it("finds the lowest of a mixed List through the Essence fold", async () => {
			expect(
				await run(`implementation {
					constant negativeThree = 0::subtract(3)
					constant negativeOne = 0::subtract(1)
					constant quotient = 1/2
						::divide(by negativeThree)
						::value(withDefault 0/1)

					Terminal.inspect(match Number.lowestNumber(
						[quotient, negativeOne],
					) -> String {
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
			).toEqual(['"0/1"', '"1"', '"true"'])
		})

		it("prints a whole-valued Rational as a decimal a caller can read back", async () => {
			expect(
				await run(`implementation {
					Terminal.inspect(4/2::toString(formatAs NumberFormat#Decimal))
					Terminal.inspect(1/2::subtract(1/2)::toString(formatAs NumberFormat#Decimal))
					Terminal.inspect(match Rational.parse(4/2::toString(formatAs NumberFormat#Decimal)) -> String {
						case #Value(parsed) { <- parsed::toString() }
						case #Empty         { <- "Empty" }
					})
				}`),
			).toEqual(['"2"', '"0"', '"2/1"'])
		})

		it("takes the root of zero as an Integer, not an Algebraic", async () => {
			expect(
				await run(`implementation {
					Terminal.inspect(match 0::squareRoot() -> String {
						case #Value(root) {
							<- match root -> String {
								case Integer   { <- @::toString() }
								case Algebraic { <- @::toString() }
							}
						}
						case #Empty { <- "Empty" }
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
			).toEqual(['"0"', '"0/1"'])
		})
	})
})
