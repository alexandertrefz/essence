import { Fraction } from "bigint-fraction"

import type { AlgebraicType } from "./Algebraic"
import {
	add as algebraicAdd,
	dividedInto as algebraicDividedInto,
	multiplyWith as algebraicMultiplyWith,
	squareRootOfRational,
	subtractedFrom as algebraicSubtractedFrom,
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
	multiplyWith as transcendentalMultiplyWith,
	subtractedFrom as transcendentalSubtractedFrom,
} from "./Transcendental"
import { typeKeySymbol } from "./type"

export type IntegerType = { [typeKeySymbol]: "Integer"; value: bigint }

export function createInteger(value: bigint): IntegerType {
	return { [typeKeySymbol]: "Integer", value }
}

export function is(
	originalInteger: IntegerType,
	otherInteger: IntegerType,
): BooleanType {
	return createBoolean(originalInteger.value === otherInteger.value)
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

// #region Subtract

export function subtract__overload$1(
	originalNumber: IntegerType,
	other: IntegerType,
): IntegerType {
	return createInteger(originalNumber.value - other.value)
}

export function subtract__overload$2(
	originalNumber: IntegerType,
	other: RationalType,
): RationalType {
	let rational = new Fraction(originalNumber.value, 1)
	rational.subtract(other.rational)

	return { [typeKeySymbol]: "Rational", rational }
}

// #endregion

// #region Divide

export function divideBy__overload$1(
	numerator: IntegerType,
	denominator: IntegerType,
): RationalType | NothingType {
	if (denominator.value === 0n) {
		return createNothing()
	}

	return createRational(numerator.value, denominator.value)
}

export function divideBy__overload$2(
	numerator: IntegerType,
	denominator: RationalType,
): RationalType | NothingType {
	let numerator1 = numerator.value
	let denominator1 = 1n
	let numerator2 = denominator.rational.numerator
	let denominator2 = denominator.rational.denominator

	if (numerator2 === 0n) {
		return createNothing()
	}

	return createRational(numerator1 * denominator2, denominator1 * numerator2)
}

// #endregion

// #region Multiply

export function multiplyWith__overload$1(
	originalNumber: IntegerType,
	other: IntegerType,
): IntegerType {
	return createInteger(originalNumber.value * other.value)
}

export function multiplyWith__overload$2(
	originalNumber: IntegerType,
	other: RationalType,
): RationalType {
	let clonedRational = other.rational.clone()
	clonedRational.multiply(originalNumber.value)

	return { [typeKeySymbol]: "Rational", rational: clonedRational }
}

// #endregion

// #region isLessThan

export function isLessThan__overload$1(
	firstInteger: IntegerType,
	secondInteger: IntegerType,
): BooleanType {
	return createBoolean(firstInteger.value < secondInteger.value)
}

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

export function isLessThanOrEqualTo__overload$1(
	firstInteger: IntegerType,
	secondInteger: IntegerType,
): BooleanType {
	return createBoolean(firstInteger.value <= secondInteger.value)
}

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

export function isGreaterThan__overload$1(
	firstInteger: IntegerType,
	secondInteger: IntegerType,
): BooleanType {
	return createBoolean(firstInteger.value > secondInteger.value)
}

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

export function isGreaterThanOrEqualTo__overload$1(
	firstInteger: IntegerType,
	secondInteger: IntegerType,
): BooleanType {
	return createBoolean(firstInteger.value >= secondInteger.value)
}

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

export function absolute(integer: IntegerType): IntegerType {
	return createInteger(integer.value < 0n ? -integer.value : integer.value)
}

export function negated(integer: IntegerType): IntegerType {
	return createInteger(-integer.value)
}

export function isEven(integer: IntegerType): BooleanType {
	return createBoolean(integer.value % 2n === 0n)
}

export function isPositive(integer: IntegerType): BooleanType {
	return createBoolean(integer.value > 0n)
}

export function isNegative(integer: IntegerType): BooleanType {
	return createBoolean(integer.value < 0n)
}

export function isZero(integer: IntegerType): BooleanType {
	return createBoolean(integer.value === 0n)
}

export function remainderOf(
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

export function toThePowerOf(
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

export function clampedBetween(
	integer: IntegerType,
	lowerBound: IntegerType,
	upperBound: IntegerType,
): IntegerType | NothingType {
	if (lowerBound.value > upperBound.value) {
		return createNothing()
	}

	if (integer.value < lowerBound.value) {
		return lowerBound
	}

	if (integer.value > upperBound.value) {
		return upperBound
	}

	return integer
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

export function subtract__overload$3(
	integer: IntegerType,
	algebraic: AlgebraicType,
): AlgebraicType {
	return algebraicSubtractedFrom(algebraic, integer)
}

export function subtract__overload$4(
	integer: IntegerType,
	transcendental: TranscendentalType,
): TranscendentalType {
	return transcendentalSubtractedFrom(transcendental, integer)
}

export function multiplyWith__overload$3(
	integer: IntegerType,
	algebraic: AlgebraicType,
): AlgebraicType | RationalType {
	return algebraicMultiplyWith(algebraic, integer)
}

export function multiplyWith__overload$4(
	integer: IntegerType,
	transcendental: TranscendentalType,
): TranscendentalType | RationalType {
	return transcendentalMultiplyWith(transcendental, integer)
}

export function divideBy__overload$3(
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
