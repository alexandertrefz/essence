import type { IntegerType } from "./Integer"
import type { RationalType } from "./Rational"
import { typeKeySymbol } from "./type"

// NOTE: The exact bigint-rational core the numeric tower is built on: a plain
// `{ numerator, denominator }` pair, treated as immutable everywhere. The
// module is dependency- and side-effect-free so a Program only carries the
// helpers it reaches. `reduced` establishes the two invariants every consumer
// relies on — the sign lives on the numerator, never on the denominator, and
// zero has exactly one lowest-terms form, `0/1`.
export type BigRational = { numerator: bigint; denominator: bigint }

// NOTE: Euclid's, through a temporary rather than a destructured swap: the
// swap allocated an Array per turn, and this loop is what every reduction runs
// — several turns for every arithmetic operation on a Rational.
function greatestCommonDivisor(first: bigint, second: bigint): bigint {
	let a = first < 0n ? -first : first
	let b = second < 0n ? -second : second

	while (b !== 0n) {
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
	// NOTE: THE boundary between the hybrid Integer and the numeric tower.
	// Everything past here — Rational, Algebraic, Transcendental — is written
	// on pairs of bigints, and this is the one place an Integer that may be
	// holding a number is normalised into one, so the tower needs to know
	// nothing about the two representations.
	if (value[typeKeySymbol] === "Integer") {
		return { numerator: BigInt(value.value), denominator: 1n }
	}

	return reduced(value.numerator, value.denominator)
}
