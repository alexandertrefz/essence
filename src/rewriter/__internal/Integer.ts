import type { AlgebraicType } from "./Algebraic"
import {
	add as algebraicAdd,
	dividedInto as algebraicDividedInto,
	multiply as algebraicMultiplyWith,
	squareRootOfRational,
} from "./Algebraic"
import type { BooleanType } from "./Boolean"
import { createBoolean } from "./Boolean"
import type { NothingType } from "./Nothing"
import { createNothing } from "./Nothing"
import type { OrderingType } from "./Ordering"
import { equal, greater, less } from "./Ordering"
import type { RationalType } from "./Rational"
import { createRational } from "./Rational"
import type { StringType } from "./String"
import { createString } from "./String"
import type { TranscendentalType } from "./Transcendental"
import {
	add as transcendentalAdd,
	multiply as transcendentalMultiplyWith,
} from "./Transcendental"
import { typeKeySymbol } from "./type"

export type IntegerType = { [typeKeySymbol]: "Integer"; value: bigint }

export function createInteger(value: bigint): IntegerType {
	return { [typeKeySymbol]: "Integer", value }
}

// #region Add

export function add__overload$1(
	originalNumber: IntegerType,
	other: IntegerType,
): IntegerType {
	return createInteger(originalNumber.value + other.value)
}

export function add__overload$2(
	originalNumber: IntegerType,
	other: RationalType,
): RationalType {
	let clonedRational = other.rational.clone()
	clonedRational.add(originalNumber.value)

	return { [typeKeySymbol]: "Rational", rational: clonedRational }
}

// #endregion

// #region Multiply

export function multiply__overload$1(
	originalNumber: IntegerType,
	other: IntegerType,
): IntegerType {
	return createInteger(originalNumber.value * other.value)
}

export function multiply__overload$2(
	originalNumber: IntegerType,
	other: RationalType,
): RationalType {
	let clonedRational = other.rational.clone()
	clonedRational.multiply(originalNumber.value)

	return { [typeKeySymbol]: "Rational", rational: clonedRational }
}

// #endregion

// #region isLessThan

export function isLessThan__overload$2(
	integer: IntegerType,
	rational: RationalType,
): BooleanType {
	const numerator1 = integer.value
	const denominator1 = 1n
	const numerator2 = rational.rational.numerator
	const denominator2 = rational.rational.denominator

	const rational1 = numerator1 * denominator2
	const rational2 = numerator2 * denominator1

	return createBoolean(rational1 < rational2)
}

// #endregion

// #region isLessThanOrEqualTo

export function isLessThanOrEqualTo__overload$2(
	integer: IntegerType,
	rational: RationalType,
): BooleanType {
	const numerator1 = integer.value
	const denominator1 = 1n
	const numerator2 = rational.rational.numerator
	const denominator2 = rational.rational.denominator

	const rational1 = numerator1 * denominator2
	const rational2 = numerator2 * denominator1

	return createBoolean(rational1 <= rational2)
}

// #endregion

// #region isGreaterThan

export function isGreaterThan__overload$2(
	integer: IntegerType,
	rational: RationalType,
): BooleanType {
	const numerator1 = integer.value
	const denominator1 = 1n
	const numerator2 = rational.rational.numerator
	const denominator2 = rational.rational.denominator

	const rational1 = numerator1 * denominator2
	const rational2 = numerator2 * denominator1

	return createBoolean(rational1 > rational2)
}

// #endregion

// #region isGreaterThanOrEqualTo

export function isGreaterThanOrEqualTo__overload$2(
	integer: IntegerType,
	rational: RationalType,
): BooleanType {
	const numerator1 = integer.value
	const denominator1 = 1n
	const numerator2 = rational.rational.numerator
	const denominator2 = rational.rational.denominator

	const rational1 = numerator1 * denominator2
	const rational2 = numerator2 * denominator1

	return createBoolean(rational1 >= rational2)
}

// #endregion

// #region Everyday methods

export function negate(integer: IntegerType): IntegerType {
	return createInteger(-integer.value)
}

export function remainder(
	integer: IntegerType,
	divisor: IntegerType,
): IntegerType | NothingType {
	if (divisor.value === 0n) {
		return createNothing()
	}

	// NOTE: Euclidean remainder — the result is always in
	// `0 ≤ r < |divisor|`, whatever the signs of the operands.
	let remainder = integer.value % divisor.value

	if (remainder < 0n) {
		remainder += divisor.value < 0n ? -divisor.value : divisor.value
	}

	return createInteger(remainder)
}

// NOTE: The other half of the same division, and it has to agree with
// `remainder` exactly: `quotient · divisor + remainder` must be the original
// Integer. Since the remainder is Euclidean — never negative — the quotient is
// floored towards negative infinity for a positive divisor rather than
// truncated towards zero, which is where it parts company with JavaScript's
// `/`. `(-7) ÷ 3` is `-3` remainder `2`, not `-2` remainder `-1`.
export function quotient(
	integer: IntegerType,
	divisor: IntegerType,
): IntegerType | NothingType {
	if (divisor.value === 0n) {
		return createNothing()
	}

	let truncated = integer.value / divisor.value
	let remainder = integer.value % divisor.value

	// NOTE: A negative remainder means the truncation rounded the wrong way for
	// a Euclidean pairing; step the quotient one towards the divisor's sign.
	if (remainder < 0n) {
		truncated += divisor.value < 0n ? 1n : -1n
	}

	return createInteger(truncated)
}

export function raise(
	base: IntegerType,
	exponent: IntegerType,
): IntegerType | RationalType | NothingType {
	if (exponent.value >= 0n) {
		return createInteger(base.value ** exponent.value)
	}

	if (base.value === 0n) {
		return createNothing()
	}

	return createRational(1n, base.value ** -exponent.value)
}

export function parse(text: StringType): IntegerType | NothingType {
	if (!/^-?[0-9]+$/.test(text.value)) {
		return createNothing()
	}

	return createInteger(BigInt(text.value))
}

// #endregion

// biome-ignore lint/suspicious/noShadowRestrictedNames: This is a runtime function
export function toString(integer: IntegerType): StringType {
	return createString(integer.value.toString())
}

// #region Irrational operands

export function add__overload$3(
	integer: IntegerType,
	algebraic: AlgebraicType,
): AlgebraicType {
	return algebraicAdd(algebraic, integer)
}

export function add__overload$4(
	integer: IntegerType,
	transcendental: TranscendentalType,
): TranscendentalType {
	return transcendentalAdd(transcendental, integer)
}

export function multiply__overload$3(
	integer: IntegerType,
	algebraic: AlgebraicType,
): AlgebraicType | RationalType {
	return algebraicMultiplyWith(algebraic, integer)
}

export function multiply__overload$4(
	integer: IntegerType,
	transcendental: TranscendentalType,
): TranscendentalType | RationalType {
	return transcendentalMultiplyWith(transcendental, integer)
}

export function divide__overload$3(
	integer: IntegerType,
	algebraic: AlgebraicType,
): AlgebraicType | RationalType {
	return algebraicDividedInto(algebraic, integer)
}

export function squareRoot(
	integer: IntegerType,
): IntegerType | AlgebraicType | NothingType {
	const root = squareRootOfRational({
		numerator: integer.value,
		denominator: 1n,
	})

	if (root[typeKeySymbol] === "Rational") {
		// NOTE: A whole number's exact root is whole — surface it as one.
		return createInteger(root.rational.numerator)
	}

	return root
}

// #endregion

// NOTE: Same-kind ordering stays native deliberately. Routing it through the
// covering `Number.compareTo` reads better, but that Method decides every
// cross-kind cell, so comparing two Integers would drag the Algebraic,
// Transcendental and Rational machinery — and `bigint-fraction` — into any
// Program that compares two Integers, which is nearly all of them. `is` and the
// inequalities are still written in Essence on top of this.
export function compareTo(
	originalInteger: IntegerType,
	otherInteger: IntegerType,
): OrderingType {
	if (originalInteger.value < otherInteger.value) {
		return less
	} else if (originalInteger.value > otherInteger.value) {
		return greater
	} else {
		return equal
	}
}
