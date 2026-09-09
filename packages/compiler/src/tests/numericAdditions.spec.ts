import { describe, expect, it } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import type { IntegerType } from "@essence-lang/runtime/Integer"
import * as integer from "@essence-lang/runtime/Integer"
import type { ValueType } from "@essence-lang/runtime/Optional"
import { typeKeySymbol } from "@essence-lang/runtime/type"

import { containsErrors } from "../diagnostics/index"
import { enrich } from "../enricher/index"
import { optimise } from "../optimiser/index"
import { parseWithDiagnostics } from "../parser/index"
import { rewrite } from "../rewriter/index"
import { simplify } from "../simplifier/index"
import { validate } from "../validator/index"

// NOTE: The entries wave 4 added to the numeric tower — the number theory on
// `Integer`, the radix pair, the division modes, the kind conversions, the
// sign refinements on `Rational` and the statistics a List of Numbers answers.
// Each is exercised through a compiled Program, because what is being checked
// is what a call RESOLVES to as much as what it computes: several of these
// entries stand beside one another and are told apart by a proof the receiver
// carries.

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
	let directory = mkdtempSync(join(tmpdir(), "essence-numeric-"))
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

// NOTE: A Program that prints one line per expression, so a case reads as the
// list of answers it expects.
function program(...lines: Array<string>): string {
	return `implementation {\n\t${lines.join("\n\t")}\n}`
}

// NOTE: `Terminal.inspect` rather than `Terminal.print`, because `print`
// writes to the Program's own stream and only `inspect` goes through the
// `console.log` this file captures. It renders a value through `Printable`,
// so an Optional reads as `Value(…)` and `Empty`.
function show(expression: string): string {
	return `Terminal.inspect(${expression})`
}

// NOTE: A deterministic pseudo-random sequence, as `irrationals.spec.ts` uses,
// so a property test draws the same cases on every run and a failure names a
// case that can be re-run.
function* deterministicNumbers(seed: number): Generator<number> {
	let state = seed

	while (true) {
		state = (state * 1103515245 + 12345) % 2147483648

		yield state
	}
}

function integerValue(value: number | bigint): bigint {
	return BigInt(integer.createInteger(value).value)
}

describe("Number theory on Integer", () => {
	it("answers the greatest common divisor, whatever the signs are", async () => {
		expect(
			await run(
				program(
					show("12::greatestCommonDivisor(with 18)"),
					show("-12::greatestCommonDivisor(with 18)"),
					show("12::greatestCommonDivisor(with -18)"),
					show("0::greatestCommonDivisor(with 7)"),
					show("7::greatestCommonDivisor(with 0)"),
					show("0::greatestCommonDivisor(with 0)"),
					show("13::greatestCommonDivisor(with 17)"),
				),
			),
		).toEqual(["6", "6", "6", "7", "7", "0", "1"])
	})

	it("answers the least common multiple, and zero where there is none", async () => {
		expect(
			await run(
				program(
					show("4::leastCommonMultiple(with 6)"),
					show("-4::leastCommonMultiple(with 6)"),
					show("21::leastCommonMultiple(with 6)"),
					show("0::leastCommonMultiple(with 6)"),
					show("6::leastCommonMultiple(with 0)"),
					show("0::leastCommonMultiple(with 0)"),
				),
			),
		).toEqual(["12", "12", "42", "0", "0", "0"])
	})

	// NOTE: The two laws the §§ blocks promise, over a spread of pairs each
	// representation covers: the divisor divides both, and the product of the
	// two answers is the product of the two Integers without its sign.
	it("keeps both laws of the divisor and the multiple, for any pair", () => {
		let numbers = deterministicNumbers(20260909)

		for (let attempt = 0; attempt < 300; attempt++) {
			let first = BigInt((numbers.next().value % 2001) - 1000)
			let second = BigInt((numbers.next().value % 2001) - 1000)
			let divisor = integerValue(
				integer.greatestCommonDivisor(
					integer.createInteger(first),
					integer.createInteger(second),
				).value,
			)
			let multiple = integerValue(
				integer.leastCommonMultiple(
					integer.createInteger(first),
					integer.createInteger(second),
				).value,
			)
			let product = first * second

			expect(divisor >= 0n).toBe(true)
			expect(multiple >= 0n).toBe(true)

			if (divisor !== 0n) {
				expect(first % divisor).toBe(0n)
				expect(second % divisor).toBe(0n)
			}

			expect(multiple * divisor).toBe(product < 0n ? -product : product)
		}
	})

	it("answers the factorial, and nothing below zero", async () => {
		expect(
			await run(
				program(
					"constant computedFive = 6::subtract(1)",
					"constant computedNegative = 0::subtract(3)",
					show("computedFive::factorial()"),
					show("computedNegative::factorial()"),
					show("computedNegative::factorial(defaultingTo 0)"),
					show("computedFive::factorial(defaultingTo 0)"),
					show("20::factorial()"),
				),
			),
		).toEqual([
			"Optional#Value(120)",
			"Optional#Empty",
			"0",
			"120",
			"2432902008176640000",
		])
	})

	// NOTE: A written receiver proves its own sign, so it reaches the entry
	// `NonNegativeInteger` declares and the answer is bare.
	it("answers the factorial itself for a receiver proven not to be negative", async () => {
		expect(
			await run(
				program(
					"constant proven: NonNegativeInteger = 4",
					show("proven::factorial()"),
					show("0::factorial()"),
					show("5::factorial()::multiply(with 2)"),
				),
			),
		).toEqual(["24", "1", "240"])
	})

	it("decides the primes, the composites and the Carmichael numbers", async () => {
		expect(
			await run(
				program(
					show("-7::isPrime()"),
					show("0::isPrime()"),
					show("1::isPrime()"),
					show("2::isPrime()"),
					show("3::isPrime()"),
					show("91::isPrime()"),
					show("97::isPrime()"),
					show("561::isPrime()"),
					show("2147483647::isPrime()"),
					show("67280421310721::isPrime()"),
				),
			),
		).toEqual([
			"false",
			"false",
			"false",
			"true",
			"true",
			"false",
			"true",
			"false",
			"true",
			"true",
		])
	})

	// NOTE: The witnesses are what the §§ block promises exactness below its
	// bound on, so the test is against a sieve rather than against a table of
	// answers this file wrote down.
	it("agrees with a sieve below a hundred thousand", () => {
		let limit = 100000
		let sieve = new Uint8Array(limit + 1).fill(1)

		sieve[0] = 0
		sieve[1] = 0

		for (let candidate = 2; candidate * candidate <= limit; candidate++) {
			if (sieve[candidate] === 0) {
				continue
			}

			for (
				let step = candidate * candidate;
				step <= limit;
				step += candidate
			) {
				sieve[step] = 0
			}
		}

		for (let candidate = 0; candidate <= limit; candidate++) {
			expect(
				integer.isPrime(integer.createInteger(candidate)).value,
			).toBe(sieve[candidate] === 1)
		}
	})

	// NOTE: Past 2⁵³ − 1 an Integer is a bigint, and the modular exponentiation
	// the test rests on is the arm that is only reached there.
	it("decides a prime past the safe range", () => {
		expect(
			integer.isPrime(integer.createInteger(2n ** 61n - 1n)).value,
		).toBe(true)
		expect(
			integer.isPrime(integer.createInteger(2n ** 61n - 3n)).value,
		).toBe(false)
	})
})

describe("Reading and writing an Integer in another base", () => {
	it("writes the digits of the base, and reads them back", async () => {
		expect(
			await run(
				program(
					show("255::toString(inBase 16)"),
					show("-255::toString(inBase 16)"),
					show("255::toString(inBase 2)"),
					show("255::toString(inBase 36)"),
					show("0::toString(inBase 16)"),
					show('Integer.parse("ff", inBase 16)'),
					show('Integer.parse("FF", inBase 16)'),
					show('Integer.parse("-ff", inBase 16)'),
					show('Integer.parse("fg", inBase 16)'),
					show('Integer.parse("2", inBase 2)'),
					show('Integer.parse("", inBase 16)'),
					show('Integer.parse("-", inBase 16)'),
					show('Integer.parse("1-1", inBase 16)'),
					show('Integer.parse("zz", inBase 36, defaultingTo 0)'),
					show('Integer.parse("nope", inBase 16, defaultingTo 0)'),
				),
			),
		).toEqual([
			'"ff"',
			'"-ff"',
			'"11111111"',
			'"73"',
			'"0"',
			"Optional#Value(255)",
			"Optional#Value(255)",
			"Optional#Value(-255)",
			"Optional#Empty",
			"Optional#Empty",
			"Optional#Empty",
			"Optional#Empty",
			"Optional#Empty",
			"1295",
			"0",
		])
	})

	// NOTE: The clamp both entries read a base through, which is what keeps
	// them a round trip at a base no positional notation has.
	it("reads a base outside two through thirty-six as the nearest of the two", async () => {
		expect(
			await run(
				program(
					show("255::toString(inBase 1)"),
					show("255::toString(inBase 0)"),
					show("255::toString(inBase -8)"),
					show("255::toString(inBase 99)"),
					show('Integer.parse("11111111", inBase 1)'),
					show('Integer.parse("73", inBase 99)'),
				),
			),
		).toEqual([
			'"11111111"',
			'"11111111"',
			'"11111111"',
			'"73"',
			"Optional#Value(255)",
			"Optional#Value(255)",
		])
	})

	// NOTE: The round trip the §§ blocks promise, over every base and both
	// representations of an Integer.
	it("reads back what it wrote, at every base and either sign", () => {
		let numbers = deterministicNumbers(20260910)

		for (let base = 2; base <= 36; base++) {
			for (let attempt = 0; attempt < 20; attempt++) {
				let value =
					BigInt(numbers.next().value) *
					BigInt(numbers.next().value % 7 === 0 ? -1 : 1)
				let written = integer.toString__overload$8(
					integer.createInteger(value),
					integer.createInteger(base),
				)
				let read = integer.parse__overload$3(
					written,
					integer.createInteger(base),
				)

				expect(read[typeKeySymbol]).toBe("Optional#Value")
				expect(
					integerValue((read as ValueType<IntegerType>).item.value),
				).toBe(value)
			}
		}
	})
})

describe("Division modes", () => {
	it("rounds the whole quotient in the named direction", async () => {
		expect(
			await run(
				program(
					show("7::quotient(dividingBy 2, toward #Up)"),
					show("7::quotient(dividingBy 2, toward #Down)"),
					show("7::quotient(dividingBy 2, toward #TowardZero)"),
					show("-7::quotient(dividingBy 2, toward #TowardZero)"),
					show("-7::quotient(dividingBy 2, toward #Up)"),
					show("-7::quotient(dividingBy 2, toward #Down)"),
					show("7::quotient(dividingBy 2, toward #Nearest)"),
					show("6::quotient(dividingBy 2, toward #Up)"),
				),
			),
		).toEqual(["4", "3", "3", "-3", "-3", "-4", "4", "3"])
	})

	// NOTE: The one place the direction and the Euclidean pairing part
	// company, which the §§ block of the entry names.
	it("answers the Euclidean quotient for a positive divisor alone", async () => {
		expect(
			await run(
				program(
					show("7::quotient(dividingBy 3)"),
					show("7::quotient(dividingBy 3, toward #Down)"),
					show("-7::quotient(dividingBy 3)"),
					show("-7::quotient(dividingBy 3, toward #Down)"),
					show("7::quotient(dividingBy -3)"),
					show("7::quotient(dividingBy -3, toward #Down)"),
				),
			),
		).toEqual(["2", "2", "-3", "-3", "-2", "-3"])
	})

	it("pairs the remainder the way the Division names", async () => {
		expect(
			await run(
				program(
					show("-7::remainder(dividingBy 3, as #Euclidean)"),
					show("-7::remainder(dividingBy 3, as #Truncating)"),
					show("7::remainder(dividingBy 3, as #Truncating)"),
					show("-7::remainder(dividingBy -3, as #Truncating)"),
					show("7::remainder(dividingBy -3, as #Truncating)"),
					show("-6::remainder(dividingBy 3, as #Truncating)"),
					show("6::remainder(dividingBy 3, as #Truncating)"),
				),
			),
		).toEqual(["2", "-1", "1", "-1", "1", "0", "0"])
	})

	// NOTE: The two laws the §§ blocks promise. The Euclidean remainder is
	// never negative and always below the divisor's magnitude; the truncating
	// one takes the dividend's sign; and either pairing rebuilds the dividend.
	it("keeps the laws of both pairings, for any pair", () => {
		let numbers = deterministicNumbers(20260911)

		for (let attempt = 0; attempt < 200; attempt++) {
			let dividend = (numbers.next().value % 2001) - 1000
			let divisor = (numbers.next().value % 40) - 20 || 7
			let euclidean = ((dividend % divisor) + Math.abs(divisor)) % divisor
			let truncating = dividend % divisor

			expect(euclidean >= 0).toBe(true)
			expect(euclidean < Math.abs(divisor)).toBe(true)
			expect(
				(dividend - euclidean) % divisor === 0 &&
					(dividend - truncating) % divisor === 0,
			).toBe(true)
			expect(truncating === 0 || truncating < 0 === dividend < 0).toBe(
				true,
			)
		}
	})

	it("divides two Rationals into a whole quotient and a Rational remainder", async () => {
		expect(
			await run(
				program(
					"constant computedZero = 1/2::subtract(1/2)",
					show("7/2::quotient(dividingBy 1/3)"),
					show("7/2::remainder(dividingBy 1/3)"),
					show("7/2::quotient(dividingBy -1/3)"),
					show("7/2::remainder(dividingBy -1/3)"),
					show("-7/2::quotient(dividingBy 1/3)"),
					show("-7/2::remainder(dividingBy 1/3)"),
					show("7/2::quotient(dividingBy computedZero)"),
					show("7/2::remainder(dividingBy computedZero)"),
					show(
						"7/2::quotient(dividingBy computedZero, defaultingTo 0)",
					),
					show(
						"7/2::remainder(dividingBy computedZero, defaultingTo 0/1)",
					),
					show("1/3::remainder(dividingBy 7/2)"),
				),
			),
		).toEqual([
			"10",
			"1/6",
			"-10",
			"1/6",
			"-11",
			"1/6",
			"Optional#Empty",
			"Optional#Empty",
			"0",
			"0/1",
			"1/3",
		])
	})
})

describe("Crossing between the two exact kinds", () => {
	it("widens an Integer to a Rational, and answers a Rational unchanged", async () => {
		expect(
			await run(
				program(
					show("5::toRational()"),
					show("-5::toRational()"),
					show("0::toRational()"),
					show("3/4::toRational()"),
					"constant numbers: List<Scalar> = [1, 1/2]",
					show("numbers::sum()::toRational()"),
				),
			),
		).toEqual(["5/1", "-5/1", "0/1", "3/4", "3/2"])
	})

	// NOTE: The Integer form is tried first, which is the whole of what this
	// static adds over the two parsers it is written on.
	it("reads a whole number as an Integer and everything else as a Rational", async () => {
		expect(
			await run(
				program(
					show('Number.parse("5")'),
					show('Number.parse("-5")'),
					show('Number.parse("3/4")'),
					show('Number.parse("0.75")'),
					show('Number.parse("5/1")'),
					show('Number.parse("nope")'),
					show('Number.parse("")'),
					show('Number.parse("3/0")'),
					show('Number.parse("3/4", defaultingTo 0)'),
					show('Number.parse("nope", defaultingTo 0)'),
				),
			),
		).toEqual([
			"Optional#Value(5)",
			"Optional#Value(-5)",
			"Optional#Value(3/4)",
			"Optional#Value(3/4)",
			"Optional#Value(5/1)",
			"Optional#Empty",
			"Optional#Empty",
			"Optional#Empty",
			"3/4",
			"0",
		])
	})
})

describe("The sign refinements on Rational", () => {
	// NOTE: A written Rational proves its own sign, so each of these reaches
	// the narrowest Namespace that declares the name. The answers are the
	// same arithmetic either way; what the proof buys is the ANSWER's Type,
	// which the compiled cases below read back through a declaration.
	it("answers the root itself for a receiver proven not to be negative", async () => {
		expect(
			await run(
				program(
					"constant nonNegative: NonNegativeRational = 3/4",
					"constant zero: NonNegativeRational = 0/1",
					show("nonNegative::squareRoot()"),
					show("zero::squareRoot()"),
					show("1/4::squareRoot()"),
					show("1/2::squareRoot()"),
				),
			),
		).toEqual(["1/2·√3", "0/1", "1/2", "1/2·√2"])
	})

	it("keeps a sum and a product within the proof", async () => {
		expect(
			await run(
				program(
					"constant nonNegative: NonNegativeRational = 3/4",
					"constant zero: NonNegativeRational = 0/1",
					"constant positive: PositiveRational = 1/2",
					show("nonNegative::add(positive)"),
					show("zero::add(zero)"),
					show("nonNegative::multiply(with zero)"),
					show("positive::multiply(with 2/3)"),
					show("1/2::add(3/4)"),
					show("1/2::multiply(with 3/4)"),
				),
			),
		).toEqual(["5/4", "0/1", "0/1", "1/3", "5/4", "3/8"])
	})

	// NOTE: The Types the proofs answer, read back off a declaration — an
	// answer too wide would be a `constant-type-mismatch` here.
	it("answers the proven Types the declarations promise", () => {
		expect(() =>
			generate(
				program(
					"constant nonNegative: NonNegativeRational = 3/4",
					"constant zero: NonNegativeRational = 0/1",
					"constant positive: PositiveRational = 1/2",
					"constant sum: PositiveRational = nonNegative::add(positive)",
					"constant kept: NonNegativeRational = zero::add(zero)",
					"constant product: NonNegativeRational = nonNegative::multiply(with zero)",
					"constant scaled: PositiveRational = positive::multiply(with 2/3)",
					"constant root: PositiveRational | Algebraic = 1/4::squareRoot()",
					"constant written: PositiveRational = 1/2::add(3/4)",
				),
			),
		).not.toThrow()
	})

	// NOTE: A value above zero is a NonZeroRational and a NonNegativeRational
	// at once, so both of those Namespaces are in reach — and `multiply` on
	// the narrowest target is what keeps the call from being ambiguous.
	it("passes a positive Rational wherever either weaker proof is wanted", () => {
		expect(() =>
			generate(
				program(
					"constant positive: PositiveRational = 1/2",
					"constant reciprocal: NonZeroRational = positive::reciprocal()",
					"constant halved: NonNegativeRational = positive",
					"constant nonZero: NonZeroRational = positive",
				),
			),
		).not.toThrow()
	})
})

describe("The statistics a List of Numbers answers", () => {
	// NOTE: The three general Namespaces and the three proven ones are told
	// apart here by whether the receiver is annotated `NonEmptyList`, which is
	// what decides between the Optional answer and the bare one.
	it("answers the median of an odd and an even count", async () => {
		expect(
			await run(
				program(
					"constant odd: NonEmptyList<Integer> = [3, 1, 2]",
					"constant even: NonEmptyList<Integer> = [3, 1, 2, 5]",
					"constant fractions: NonEmptyList<Rational> = [1/2, 1/4]",
					"constant mixed: NonEmptyList<Integer | Rational> = [1, 1/2, 3]",
					show("odd::median()"),
					show("even::median()"),
					show("fractions::median()"),
					show("mixed::median()"),
				),
			),
		).toEqual(["2/1", "5/2", "3/8", "1/1"])
	})

	it("answers nothing for the empty List, and the fallback beside it", async () => {
		expect(
			await run(
				program(
					"constant none: List<Integer> = []",
					show("none::median()"),
					show("none::median(defaultingTo 0/1)"),
					show("none::percentile(1/2)"),
					show("none::percentile(1/2, defaultingTo -1/1)"),
					show("none::mode()"),
					show("none::mode(defaultingTo -1)"),
					show("none::variance()"),
					show("none::variance(defaultingTo 0/1)"),
					show("none::standardDeviation()"),
					show("none::standardDeviation(defaultingTo 0/1)"),
				),
			),
		).toEqual([
			"Optional#Empty",
			"0/1",
			"Optional#Empty",
			"-1/1",
			"Optional#Empty",
			"-1",
			"Optional#Empty",
			"0/1",
			"Optional#Empty",
			"0/1",
		])
	})

	// NOTE: A List with an item in it answers each of these bare, so a `match`
	// over the answer would be `no-matching-case` — which is the point of the
	// proven Namespaces, and what these lines read back.
	it("answers the whole family bare for a List with an item in it", async () => {
		expect(
			await run(
				program(
					"constant numbers: NonEmptyList<Integer> = [3, 1, 2, 5, 4, 4]",
					show("numbers::median()"),
					show("numbers::percentile(1/4)"),
					show("numbers::mode()"),
					show("numbers::variance()"),
					show("numbers::standardDeviation()"),
				),
			),
		).toEqual(["7/2", "9/4", "4", "65/36", "1/6·√65"])
	})

	it("reads the position a percentile names, and clamps the fraction", async () => {
		expect(
			await run(
				program(
					"constant numbers: NonEmptyList<Integer> = [10, 20, 30, 40]",
					show("numbers::percentile(0/1)"),
					show("numbers::percentile(1/1)"),
					show("numbers::percentile(1/2)"),
					show("numbers::percentile(1/3)"),
					show("numbers::percentile(-1/2)"),
					show("numbers::percentile(5/1)"),
				),
			),
		).toEqual(["10/1", "40/1", "25/1", "20/1", "10/1", "40/1"])
	})

	it("keeps the earliest of the items that occur equally often", async () => {
		expect(
			await run(
				program(
					"constant tied: NonEmptyList<Integer> = [7, 3, 7, 3]",
					"constant single: NonEmptyList<Integer> = [5]",
					"constant fractions: NonEmptyList<Rational> = [1/2, 1/4, 1/4]",
					show("tied::mode()"),
					show("single::mode()"),
					show("fractions::mode()"),
				),
			),
		).toEqual(["7", "5", "1/4"])
	})

	it("answers an exact standard deviation over the tower", async () => {
		expect(
			await run(
				program(
					"constant square: NonEmptyList<Integer> = [1, 3]",
					"constant root: NonEmptyList<Integer> = [1, 2, 3]",
					"constant flat: NonEmptyList<Integer> = [4, 4, 4]",
					show("square::variance()"),
					show("square::standardDeviation()"),
					show("root::variance()"),
					show("root::standardDeviation()"),
					show("flat::variance()"),
					show("flat::standardDeviation()"),
				),
			),
		).toEqual(["1/1", "1/1", "2/3", "1/3·√6", "0/1", "0/1"])
	})

	it("multiplies together what a key reads off every item", async () => {
		expect(
			await run(
				program(
					"constant rows = [{ count = 2, share = 1/2 }, { count = 3, share = 2/3 }]",
					"constant none: List<{ count: Integer }> = []",
					show("rows::product(on .count)"),
					show("rows::product(on .share)"),
					show("rows::sum(on .count)"),
					show("none::product(on .count)"),
				),
			),
		).toEqual(["6", "1/3", "5", "1"])
	})

	// NOTE: The Types the proofs answer, read back off a declaration. An answer
	// too wide is a `constant-type-mismatch` here, which is the only way to see
	// that `variance` promises a NonNegativeRational rather than a Rational.
	it("answers the proven Types the declarations promise", () => {
		expect(() =>
			generate(
				program(
					"constant numbers: NonEmptyList<Integer> = [1, 2, 3]",
					"constant loose: List<Integer> = [1, 2, 3]",
					"constant middle: Rational = numbers::median()",
					"constant spread: NonNegativeRational = numbers::variance()",
					"constant deviation: Rational | Algebraic = numbers::standardDeviation()",
					"constant item: Integer = numbers::mode()",
					"constant quarter: Rational = numbers::percentile(1/4)",
					"constant root: Rational | Algebraic = numbers::variance()::squareRoot()",
					"constant maybe: Optional<NonNegativeRational> = loose::variance()",
					"constant kept: NonNegativeRational = loose::variance(defaultingTo 0/1)",
				),
			),
		).not.toThrow()
	})

	// NOTE: The laws the §§ blocks promise, checked in Essence over a spread of
	// Lists so that one compile covers every case. Each line answers `true`,
	// and a failure names the case by its position in this List.
	it("keeps the laws of the statistics, for any List", async () => {
		let numbers = deterministicNumbers(20260910)
		let cases: Array<string> = []

		for (let attempt = 0; attempt < 40; attempt++) {
			let length = (numbers.next().value % 9) + 1
			let items: Array<number> = []

			for (let index = 0; index < length; index++) {
				items.push((numbers.next().value % 41) - 20)
			}

			cases.push(`[${items.join(", ")}]`)
		}

		let lines = cases.flatMap((items) => [
			`constant case${cases.indexOf(items)}: NonEmptyList<Integer> = ${items}`,
		])
		let checks = cases.map((items, index) => {
			let name = `case${index}`

			return show(
				`${name}::variance()::isGreaterThanOrEqualTo(0/1)` +
					`::and(${name}::percentile(0/1)::is(${name}::lowestNumber()))` +
					`::and(${name}::percentile(1/1)::is(${name}::highestNumber()))` +
					`::and(${name}::median()::isGreaterThanOrEqualTo(${name}::lowestNumber()))` +
					`::and(${name}::median()::isLessThanOrEqualTo(${name}::highestNumber()))` +
					`::and(${name}::contains(${name}::mode()))`,
			)
		})

		expect(await run(program(...lines, ...checks))).toEqual(
			cases.map(() => "true"),
		)
	})
})
