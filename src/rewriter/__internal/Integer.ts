import { Fraction } from "bigint-fraction"

import type { BooleanType } from "./Boolean"
import type { FractionType } from "./Fraction"
import type { StringType } from "./String"

import { createBoolean } from "./Boolean"
import { createFraction } from "./Fraction"
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
	other: FractionType,
): FractionType {
	let clonedFraction = other.fraction.clone()
	clonedFraction.add(originalNumber.value)

	return { [typeKeySymbol]: "Fraction", fraction: clonedFraction }
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
	other: FractionType,
): FractionType {
	let fraction = new Fraction(originalNumber.value, 1)
	fraction.subtract(other.fraction)

	return { [typeKeySymbol]: "Fraction", fraction }
}

// #endregion

// #region Divide

export function divideBy__overload$1(
	numerator: IntegerType,
	denominator: IntegerType,
): FractionType {
	return createFraction(numerator.value, denominator.value)
}

export function divideBy__overload$2(
	numerator: IntegerType,
	denominator: FractionType,
): FractionType {
	let numerator1 = numerator.value
	let denominator1 = 1n
	let numerator2 = denominator.fraction.numerator
	let denominator2 = denominator.fraction.denominator

	return createFraction(numerator1 * denominator2, denominator1 * numerator2)
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
	other: FractionType,
): FractionType {
	let clonedFraction = other.fraction.clone()
	clonedFraction.multiply(originalNumber.value)

	return { [typeKeySymbol]: "Fraction", fraction: clonedFraction }
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
	fraction: FractionType,
): BooleanType {
	const numerator1 = integer.value
	const denominator1 = 1n
	const numerator2 = fraction.fraction.numerator
	const denominator2 = fraction.fraction.denominator

	const fraction1 = numerator1 * denominator2
	const fraction2 = numerator2 * denominator1

	return createBoolean(fraction1 < fraction2)
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
	fraction: FractionType,
): BooleanType {
	const numerator1 = integer.value
	const denominator1 = 1n
	const numerator2 = fraction.fraction.numerator
	const denominator2 = fraction.fraction.denominator

	const fraction1 = numerator1 * denominator2
	const fraction2 = numerator2 * denominator1

	return createBoolean(fraction1 <= fraction2)
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
	fraction: FractionType,
): BooleanType {
	const numerator1 = integer.value
	const denominator1 = 1n
	const numerator2 = fraction.fraction.numerator
	const denominator2 = fraction.fraction.denominator

	const fraction1 = numerator1 * denominator2
	const fraction2 = numerator2 * denominator1

	return createBoolean(fraction1 > fraction2)
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
	fraction: FractionType,
): BooleanType {
	const numerator1 = integer.value
	const denominator1 = 1n
	const numerator2 = fraction.fraction.numerator
	const denominator2 = fraction.fraction.denominator

	const fraction1 = numerator1 * denominator2
	const fraction2 = numerator2 * denominator1

	return createBoolean(fraction1 >= fraction2)
}

// #endregion

// biome-ignore lint/suspicious/noShadowRestrictedNames:
export function toString(integer: IntegerType): StringType {
	return createString(integer.value.toString())
}
