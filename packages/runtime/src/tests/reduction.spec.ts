import { describe, expect, test } from "bun:test"
import { spawnSync } from "node:child_process"

import { reduced } from "../bigRational"
import { createInteger } from "../Integer"
import { anyIs } from "../internalHelpers"
import { decimal, fraction } from "../NumberFormat"
import {
	createRational,
	denominator,
	formatAsRational,
	numerator,
	raise__overload$1 as raise,
	toString__overload$2 as toStringAs,
} from "../Rational"
import { createRecord } from "../Record"
import { getStringRepresentation } from "../Terminal"
import { type AnyType, typeKeySymbol } from "../type"

// NOTE: The payload of the Optional a fallible Rational Method answers with.
const itemOf = (value: unknown) =>
	(value as { item: { numerator: bigint; denominator: bigint } }).item

describe("remembered lowest terms", () => {
	// NOTE: The invariant the whole numeric tower rests on — a Rational HOLDS
	// what it was built with, and reducing is something the read side does.
	// Remembering the reduced form must not write it back.
	test("the stored parts stay as they were built", () => {
		let unreduced = createRational(4n, 2n)

		expect(unreduced.numerator).toBe(4n)
		expect(unreduced.denominator).toBe(2n)

		// NOTE: Asking twice, because the first ask is what fills the memory and
		// the second is what would read a written-back value if one had been.
		//
		// NOTE: The accessors answer INTEGERS, whose parts are canonicalised
		// into the hybrid representation — a number for anything a double
		// carries — while the Rational goes on holding the bigints it was built
		// with, which is what the assertions either side of these are for.
		expect(numerator(unreduced).value).toBe(2)
		expect(denominator(unreduced).value).toBe(1)
		expect(numerator(unreduced).value).toBe(2)
		expect(denominator(unreduced).value).toBe(1)

		expect(unreduced.numerator).toBe(4n)
		expect(unreduced.denominator).toBe(2n)
	})

	test("the accessors answer the lowest-terms parts", () => {
		let cases: Array<[bigint, bigint, number, number]> = [
			[4n, 2n, 2, 1],
			[1n, 2n, 1, 2],
			[6n, 4n, 3, 2],
			[-6n, 4n, -3, 2],
			[6n, -4n, -3, 2],
			[0n, 5n, 0, 1],
		]

		for (let [
			builtNumerator,
			builtDenominator,
			lowestNumerator,
			lowestDenominator,
		] of cases) {
			let rational = createRational(builtNumerator, builtDenominator)

			expect(numerator(rational).value).toBe(lowestNumerator)
			expect(denominator(rational).value).toBe(lowestDenominator)
			expect(numerator(rational).value).toBe(lowestNumerator)
			expect(denominator(rational).value).toBe(lowestDenominator)
		}
	})

	// NOTE: Printing asks for the reduced form too, so it is the other side of
	// the same memory — and it has to answer alike whether it asks first or
	// after an accessor already filled it.
	test("printing answers alike however often it is asked", () => {
		let printedFirst = createRational(4n, 2n)
		let readFirst = createRational(4n, 2n)

		numerator(readFirst)

		expect(formatAsRational(printedFirst)).toBe("2/1")
		expect(formatAsRational(printedFirst)).toBe("2/1")
		expect(formatAsRational(readFirst)).toBe("2/1")
		expect(getStringRepresentation(printedFirst)).toBe("2/1")
		expect(getStringRepresentation(readFirst)).toBe("2/1")

		// NOTE: The two formatters part company on a whole value: the
		// structural one above says what a Rational IS, while the two a caller
		// asks for print `2`, which is text `Rational.parse` reads back.
		expect(toStringAs(printedFirst, fraction).value).toBe("2")
		expect(toStringAs(printedFirst, decimal).value).toBe("2")
		expect(toStringAs(createRational(1n, 3n), decimal).value).toBe(
			`0.${"3".repeat(80)}`,
		)
		expect(toStringAs(createRational(2n, 6n), decimal).value).toBe(
			`0.${"3".repeat(80)}`,
		)
	})

	// NOTE: The 80-digit cap can cut an expansion before its first significant
	// digit — every kept digit a zero. The rounded value is the whole part
	// alone, so it prints as that whole, and never with a minus sign when the
	// whole is zero: there is no negative zero for `Rational.parse` to read
	// back.
	test("an all-zero expansion prints as the whole it rounds to", () => {
		expect(toStringAs(createRational(-4n, 10n ** 81n), decimal).value).toBe(
			"0",
		)
		expect(toStringAs(createRational(4n, 10n ** 81n), decimal).value).toBe(
			"0",
		)
		expect(
			toStringAs(
				createRational(-(5n * 10n ** 81n + 4n), 10n ** 81n),
				decimal,
			).value,
		).toBe("-5")
		expect(toStringAs(createRational(-1n, 3n), decimal).value).toBe(
			`-0.${"3".repeat(80)}`,
		)
	})

	// NOTE: `raise` reads the reduced form and builds a NEW Rational off it, so
	// it is where a shared, mutated parts object would show up as a wrong
	// answer the second time round.
	test("raising answers alike however often it is asked", () => {
		let rational = createRational(4n, 2n)

		for (let index = 0; index < 3; index++) {
			let squared = itemOf(raise(rational, createInteger(2n)))

			expect(squared.numerator).toBe(4n)
			expect(squared.denominator).toBe(1n)

			let inverted = itemOf(raise(rational, createInteger(-1n)))

			expect(inverted.numerator).toBe(1n)
			expect(inverted.denominator).toBe(2n)
		}

		expect(rational.numerator).toBe(4n)
		expect(rational.denominator).toBe(2n)
	})

	// NOTE: Equality cross-multiplies the RAW parts and never asks for the
	// reduced form, so a Rational that has been read is equal to exactly what it
	// was equal to before — including across the two spellings of one value.
	test("what is remembered is invisible", () => {
		let read = createRational(4n, 2n)

		numerator(read)
		formatAsRational(read)

		expect(Object.keys(read)).toEqual(["numerator", "denominator"])
		expect(read[typeKeySymbol]).toBe("Rational")

		expect(anyIs(read, createRational(4n, 2n))).toBeTrue()
		expect(anyIs(read, createRational(2n, 1n))).toBeTrue()
		expect(anyIs(read, createInteger(2n) as unknown as AnyType)).toBeTrue()
		expect(anyIs(read, createRational(3n, 1n))).toBeFalse()

		expect(
			anyIs(
				createRecord({ ratio: read }),
				createRecord({ ratio: createRational(2n, 1n) }),
			),
		).toBeTrue()
	})
})

// NOTE: `reduced` is typed code that trusts the Enricher, and nothing in the
// language can hand it a pair that is not two bigints. A hole in the Enricher
// once did, and what came of it was not a wrong answer anybody could read: the
// Euclid loop compared a `NaN` remainder against `0n` forever, and the run
// stopped responding. The loop asks `b > 0n` for that reason, and this is what
// says so.
describe("a pair that is no pair of bigints", () => {
	// NOTE: Spawned rather than called here, and on a clock. What this is about
	// is a call that RETURNS — a synchronous loop on the very thread a spec runs
	// on would take the whole suite down with it instead of failing, and no
	// timeout a test runner offers can interrupt one that never yields. The
	// test is given the longer budget of the two, so that a spin is answered by
	// the assertion on the killed child rather than by a runner saying only
	// that time ran out.
	test("is reduced to an answer rather than spun on", () => {
		let module = import.meta.resolve("../bigRational")
		let result = spawnSync(
			process.execPath,
			[
				"--eval",
				[
					`let { reduced } = await import(${JSON.stringify(module)})`,
					"reduced(Number.NaN, 2)",
					"reduced(0.1, 0.3)",
					"reduced(undefined, undefined)",
					'console.log("answered")',
				].join("\n"),
			],
			{
				encoding: "utf-8",
				timeout: 20_000,
				// NOTE: The loop this guards against yields to nothing, so the
				// child is killed outright rather than asked to stop.
				killSignal: "SIGKILL",
			},
		)

		// NOTE: A killed child is the spin itself — `status` is null there, so
		// the exit code below would pass it by.
		expect(result.signal).toBeNull()
		expect(result.stdout).toContain("answered")
		expect(result.status).toBe(0)
	}, 30_000)

	// NOTE: And the guard is the same question of the bigints the loop is
	// written for, which is what lets it be free: `b` is an absolute value and
	// a remainder of one, so `> 0n` and `!== 0n` part company nowhere a
	// Rational goes.
	test("changes nothing about a pair that is one", () => {
		let cases: Array<[bigint, bigint, bigint, bigint]> = [
			[12n, 18n, 2n, 3n],
			[-12n, 18n, -2n, 3n],
			[12n, -18n, -2n, 3n],
			[-12n, -18n, 2n, 3n],
			[0n, 5n, 0n, 1n],
			[7n, 1n, 7n, 1n],
			[10n ** 40n * 6n, 10n ** 40n * 4n, 3n, 2n],
		]

		for (let [
			builtNumerator,
			builtDenominator,
			reducedNumerator,
			reducedDenominator,
		] of cases) {
			expect(reduced(builtNumerator, builtDenominator)).toEqual({
				numerator: reducedNumerator,
				denominator: reducedDenominator,
			})
		}
	})
})
