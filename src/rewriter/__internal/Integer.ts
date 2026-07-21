import { Fraction } from "bigint-fraction"

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

export function isNot(
	originalInteger: IntegerType,
	otherInteger: IntegerType,
): BooleanType {
	return createBoolean(originalInteger.value !== otherInteger.value)
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
