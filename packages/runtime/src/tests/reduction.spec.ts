import { describe, expect, test } from "bun:test"

import { spawnAndWait } from "@essence-lang/fixtures/spawn"

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

// The payload of the Optional a fallible Rational Method answers with.
const itemOf = (value: unknown) =>
	(value as { item: { numerator: bigint; denominator: bigint } }).item

describe("remembered lowest terms", () => {
	// A Rational holds what it was built with, so remembering the reduced form
	// must not write it back. See "Rational numbers" in
	// packages/runtime/DEVELOPMENT.md.
	test("the stored parts stay as they were built", () => {
		let unreduced = createRational(4n, 2n)

		expect(unreduced.numerator).toBe(4n)
		expect(unreduced.denominator).toBe(2n)

		// Asked twice: the first ask fills the memory and the second would read
		// a written-back value. The accessors answer Integers, which hold a small
		// value as a number.
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

	// Printing reads the same memory, whether it fills it or an accessor did.
	test("printing answers alike however often it is asked", () => {
		let printedFirst = createRational(4n, 2n)
		let readFirst = createRational(4n, 2n)

		numerator(readFirst)

		expect(formatAsRational(printedFirst)).toBe("2/1")
		expect(formatAsRational(printedFirst)).toBe("2/1")
		expect(formatAsRational(readFirst)).toBe("2/1")
		expect(getStringRepresentation(printedFirst)).toBe("2/1")
		expect(getStringRepresentation(readFirst)).toBe("2/1")

		// On a whole value the structural rendering says `2/1`, and `toString`
		// says `2`, which `Rational.parse` reads back.
		expect(toStringAs(printedFirst, fraction).value).toBe("2")
		expect(toStringAs(printedFirst, decimal).value).toBe("2")
		expect(toStringAs(createRational(1n, 3n), decimal).value).toBe(
			`0.${"3".repeat(80)}`,
		)
		expect(toStringAs(createRational(2n, 6n), decimal).value).toBe(
			`0.${"3".repeat(80)}`,
		)
	})

	// The 80-digit cap can keep only zeros, so the value prints as its whole
	// part. A zero whole takes no minus sign, since there is no negative zero.
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

	// `raise` builds a new Rational off the remembered parts, so mutating them
	// would spoil the next answer.
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

	// Equality cross-multiplies the raw parts and never reads the reduced form.
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

// `reduced` trusts the Enricher to hand it bigints. On anything else it must
// answer rather than spin: `greatestCommonDivisor` loops while `b > 0n`, which
// is false for `NaN`.
describe("a pair that is no pair of bigints", () => {
	// Spawned on a clock, since no runner timeout can interrupt a synchronous
	// spin on the spec's own thread. The test's budget outlasts the spawn's
	// deadline, so a spin fails with an error that names the child.
	test("is reduced to an answer rather than spun on", async () => {
		let module = import.meta.resolve("../bigRational")
		let result = await spawnAndWait(
			[
				process.execPath,
				"--eval",
				[
					`let { reduced } = await import(${JSON.stringify(module)})`,
					"reduced(Number.NaN, 2)",
					"reduced(0.1, 0.3)",
					"reduced(undefined, undefined)",
					'console.log("answered")',
				].join("\n"),
			],
			{ deadline: 20_000 },
		)

		// This catches a child killed by another signal, whose `code` is null.
		expect(result.signal).toBeNull()
		expect(result.stdout).toContain("answered")
		expect(result.code).toBe(0)
	}, 30_000)

	// For bigints `b` is never negative, so `b > 0n` asks what `b !== 0n` would.
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
