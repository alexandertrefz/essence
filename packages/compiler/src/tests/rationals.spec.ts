import { describe, expect, it } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import * as algebraic from "@essence-lang/runtime/Algebraic"
import * as integer from "@essence-lang/runtime/Integer"
import * as number from "@essence-lang/runtime/Number"
import { decimal, fraction } from "@essence-lang/runtime/NumberFormat"
import * as ordering from "@essence-lang/runtime/Ordering"
import * as rational from "@essence-lang/runtime/Rational"
import { typeKeySymbol } from "@essence-lang/runtime/type"

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
// a zero operand, so a cancelled `0/4` could never reduce itself. Both are
// checked here on the runtime directly and again through a compiled Program,
// because the damage they did was visible from Essence: `absolute()`,
// `roundDown()` and `isWholeNumber()` are all written on top of them.

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

describe("Rationals", () => {
	describe("The positive-denominator invariant", () => {
		it("keeps the sign on the numerator when dividing by a negative Integer", () => {
			const quotient = rational.divide__overload$2(
				rational.createRational(1n, 2n),
				integer.createInteger(-3n),
			)

			expect(quotient[typeKeySymbol]).toBe("Rational")
			expect(partsOf(quotient as rational.RationalType)).toEqual({
				numerator: -1n,
				denominator: 6n,
			})
		})

		it("orders a Rational divided by a negative Integer below zero", () => {
			const quotient = rational.divide__overload$2(
				rational.createRational(1n, 2n),
				integer.createInteger(-3n),
			) as rational.RationalType
			const zero = rational.createRational(0n, 1n)

			expect(rational.compareTo(quotient, zero)).toEqual(ordering.less)
			expect(
				rational.isLessThan__overload$2(
					quotient,
					integer.createInteger(0n),
				).value,
			).toBeTrue()
			expect(
				rational.isGreaterThan__overload$2(
					quotient,
					integer.createInteger(0n),
				).value,
			).toBeFalse()
			expect(number.compareTo(quotient, zero)).toEqual(ordering.less)
			expect(
				number.lowestNumber__overload$7({
					[typeKeySymbol]: "List",
					value: [quotient, integer.createInteger(-1n)],
				}),
			).toEqual(integer.createInteger(-1n))
		})

		it("reads the accessors and the rounding family off the numerator's sign", () => {
			const quotient = rational.divide__overload$2(
				rational.createRational(1n, 2n),
				integer.createInteger(-3n),
			) as rational.RationalType

			expect(rational.numerator(quotient).value).toBe(-1n)
			expect(rational.denominator(quotient).value).toBe(6n)
			expect(rational.round(quotient).value).toBe(0n)
			expect(rational.truncate(quotient).value).toBe(0n)
		})

		it("prints a negative quotient in a form parse reads back", () => {
			const quotient = rational.divide__overload$2(
				rational.createRational(1n, 2n),
				integer.createInteger(-3n),
			) as rational.RationalType
			const text = rational.toString__overload$1(quotient)

			expect(text.value).toBe("-1/6")
			expect(rational.parse(text)).toEqual(quotient)
		})

		it("keeps the invariant through the other Integer-operand arithmetic", () => {
			const half = rational.createRational(1n, 2n)

			expect(
				partsOf(
					rational.multiply__overload$2(
						half,
						integer.createInteger(-3n),
					),
				),
			).toEqual({ numerator: -3n, denominator: 2n })
			expect(
				partsOf(
					rational.add__overload$2(half, integer.createInteger(-1n)),
				),
			).toEqual({ numerator: -1n, denominator: 2n })
		})

		it("leaves the receiver untouched — the parts are never shared", () => {
			const half = rational.createRational(1n, 2n)

			rational.divide__overload$2(half, integer.createInteger(-3n))
			rational.multiply__overload$2(half, integer.createInteger(4n))
			rational.add__overload$2(half, integer.createInteger(7n))

			expect(partsOf(half)).toEqual({ numerator: 1n, denominator: 2n })
		})
	})

	describe("Canonical zero", () => {
		// NOTE: `1/2 − 1/2` builds `(1·2 + −1·2)/4` — a zero that reaches the
		// gateway with a denominator of 4 and must leave it as `0/1`.
		const cancelled = () =>
			rational.add__overload$1(
				rational.createRational(1n, 2n),
				rational.createRational(-1n, 2n),
			)

		it("reduces a cancelled zero to 0/1", () => {
			expect(partsOf(cancelled())).toEqual({
				numerator: 0n,
				denominator: 1n,
			})
		})

		it("answers a denominator of one for every zero", () => {
			expect(rational.denominator(cancelled()).value).toBe(1n)
			expect(
				rational.denominator(rational.createRational(0n, 6n)).value,
			).toBe(1n)
			expect(
				rational.denominator(
					rational.multiply__overload$2(
						rational.createRational(1n, 2n),
						integer.createInteger(0n),
					),
				).value,
			).toBe(1n)
		})

		it("prints every zero as 0/1", () => {
			expect(rational.toString__overload$1(cancelled()).value).toBe("0/1")
			expect(
				rational.toString__overload$2(cancelled(), fraction).value,
			).toBe("0/1")
			expect(
				rational.toString__overload$1(rational.createRational(0n, 6n))
					.value,
			).toBe("0/1")
		})

		// NOTE: A zero built by Integer-operand arithmetic rather than written
		// as a literal — the accessors must answer canonically for it all the
		// same.
		it("answers for a zero the Integer Namespace built", () => {
			const zero = integer.add__overload$2(
				integer.createInteger(-1n),
				rational.createRational(2n, 2n),
			)

			expect(rational.denominator(zero).value).toBe(1n)
			expect(rational.numerator(zero).value).toBe(0n)
			expect(rational.toString__overload$1(zero).value).toBe("0/1")
		})

		it("still compares a zero equal whatever it was built from", () => {
			expect(
				rational.compareTo(
					cancelled(),
					rational.createRational(0n, 1n),
				),
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

		it("round-trips the decimal form back through parse", () => {
			for (const value of [
				rational.createRational(4n, 2n),
				rational.createRational(-4n, 2n),
				rational.createRational(0n, 1n),
				rational.createRational(1n, 2n),
			]) {
				const text = rational.toString__overload$2(value, decimal)
				const parsed = rational.parse(text)

				expect(parsed[typeKeySymbol]).toBe("Rational")
				expect(
					rational.compareTo(parsed as rational.RationalType, value),
				).toEqual(ordering.equal)
			}
		})
	})

	describe("The square root of zero", () => {
		it("gives the exact Integer zero", () => {
			expect(integer.squareRoot(integer.createInteger(0n))).toEqual(
				integer.createInteger(0n),
			)
		})

		it("gives the exact Rational zero", () => {
			const root = rational.squareRoot(rational.createRational(0n, 5n))

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
			const root = algebraic.squareRootOfRational({
				numerator: 0n,
				denominator: 1n,
			})

			expect(root[typeKeySymbol]).toBe("Rational")
			expect(
				number.compareTo(
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

					match 1/2::divide(by negativeThree) -> Nothing {
						case Rational {
							__print(@::toString())
							__print(@::isLessThan(0/1)::toString())
							__print(@::absolute()::toString())
							__print(@::roundDown()::toString())
							<- nothing
						}
						case Nothing {
							__print("Nothing")
							<- nothing
						}
					}
				}`),
			).toEqual(['"-1/6"', '"true"', '"1/6"', '"-1"'])
		})

		it("says a cancelled zero is a whole number", async () => {
			expect(
				await run(`implementation {
					constant cancelled = 1/2::subtract(1/2)

					__print(cancelled::toString())
					__print(cancelled::denominator()::toString())
					__print(cancelled::isWholeNumber()::toString())
				}`),
			).toEqual(['"0/1"', '"1"', '"true"'])
		})

		it("prints a whole-valued Rational as a decimal a caller can read back", async () => {
			expect(
				await run(`implementation {
					__print(4/2::toString(formatAs NumberFormat#Decimal))
					__print(1/2::subtract(1/2)::toString(formatAs NumberFormat#Decimal))
					__print(match Rational.parse(4/2::toString(formatAs NumberFormat#Decimal)) -> String {
						case Rational { <- @::toString() }
						case Nothing { <- "Nothing" }
					})
				}`),
			).toEqual(['"2"', '"0"', '"2/1"'])
		})

		it("takes the root of zero as an Integer, not an Algebraic", async () => {
			expect(
				await run(`implementation {
					__print(match 0::squareRoot() -> String {
						case Integer { <- @::toString() }
						case Algebraic { <- @::toString() }
						case Nothing { <- "Nothing" }
					})

					__print(match 0/5::squareRoot() -> String {
						case Rational { <- @::toString() }
						case Algebraic { <- @::toString() }
						case Nothing { <- "Nothing" }
					})
				}`),
			).toEqual(['"0"', '"0/1"'])
		})
	})
})
