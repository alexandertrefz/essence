import type { IntegerType } from "./Integer"
import type { RationalType } from "./Rational"
import { typeKeySymbol } from "./type"

// The exact rational core the numeric tower is built on, a pair of bigints
// never changed once built. `reduced` puts the sign on the numerator and writes
// zero as `0/1`, and every consumer relies on both.
export type BigRational = { numerator: bigint; denominator: bigint }

// Euclid's algorithm, swapping through a temporary so that no turn allocates.
// `b > 0n` rather than `b !== 0n`: a part that is not a bigint, such as `NaN`,
// then ends the loop rather than spinning forever.
export function greatestCommonDivisor(first: bigint, second: bigint): bigint {
	let a = first < 0n ? -first : first
	let b = second < 0n ? -second : second

	while (b > 0n) {
		let remainder = a % b

		a = b
		b = remainder
	}

	return a
}

export function reduced(numerator: bigint, denominator: bigint): BigRational {
	if (denominator < 0n) {
		numerator = -numerator
		denominator = -denominator
	}

	const divisor = greatestCommonDivisor(numerator, denominator)

	if (divisor === 0n) {
		return { numerator: 0n, denominator: 1n }
	}

	return {
		numerator: numerator / divisor,
		denominator: denominator / divisor,
	}
}

export function addRationals(
	first: BigRational,
	second: BigRational,
): BigRational {
	return reduced(
		first.numerator * second.denominator +
			second.numerator * first.denominator,
		first.denominator * second.denominator,
	)
}

export function subtractRationals(
	first: BigRational,
	second: BigRational,
): BigRational {
	return addRationals(first, {
		numerator: -second.numerator,
		denominator: second.denominator,
	})
}

export function multiplyRationals(
	first: BigRational,
	second: BigRational,
): BigRational {
	return reduced(
		first.numerator * second.numerator,
		first.denominator * second.denominator,
	)
}

export function divideRationals(
	first: BigRational,
	second: BigRational,
): BigRational {
	return reduced(
		first.numerator * second.denominator,
		first.denominator * second.numerator,
	)
}

export function rationalSign(rational: BigRational): -1n | 0n | 1n {
	if (rational.numerator === 0n) {
		return 0n
	}

	return rational.numerator < 0n ? -1n : 1n
}

export function bigRationalOf(value: IntegerType | RationalType): BigRational {
	// The boundary between the hybrid Integer and the numeric tower, which is
	// written on bigint pairs alone.
	if (value[typeKeySymbol] === "Integer") {
		return { numerator: BigInt(value.value), denominator: 1n }
	}

	return reduced(value.numerator, value.denominator)
}
