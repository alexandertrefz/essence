import { Fraction } from "bigint-fraction"

import type { BooleanType } from "./Boolean"
import type { IntegerType } from "./Integer"
import type { StringType } from "./String"

import { createBoolean, negate } from "./Boolean"
import { createString } from "./String"
import { typeKeySymbol } from "./type"

export type FractionType = { [typeKeySymbol]: "Fraction"; fraction: Fraction }

export function createFraction(
	numerator: bigint,
	denominator: bigint,
): FractionType {
	if (denominator < 0) {
		numerator = numerator * -1n
		denominator = denominator * -1n
	}

	return {
		[typeKeySymbol]: "Fraction",
		fraction: new Fraction(numerator, denominator),
	}
}

export function of(numerator: IntegerType, denominator: IntegerType) {
	return createFraction(numerator.value, denominator.value)
}

export function is(
	originalFraction: FractionType,
	otherFraction: FractionType,
): BooleanType {
	let originalFractionClone = originalFraction.fraction.clone()
	let otherFractionClone = otherFraction.fraction.clone()

	originalFractionClone.reduce()
	otherFractionClone.reduce()

	return createBoolean(
		originalFractionClone.denominator === otherFractionClone.denominator &&
			originalFractionClone.numerator === otherFractionClone.numerator,
	)
}

export function isNot(
	originalFraction: FractionType,
	otherFraction: FractionType,
): BooleanType {
	return negate(is(originalFraction, otherFraction))
}

// #region Add

export function add__overload$1(
	firstFraction: FractionType,
	secondFraction: FractionType,
): FractionType {
	const numerator1 = firstFraction.fraction.numerator
	const denominator1 = firstFraction.fraction.denominator
	const numerator2 = secondFraction.fraction.numerator
	const denominator2 = secondFraction.fraction.denominator

	return createFraction(
		numerator1 * denominator2 + numerator2 * denominator1,
		denominator1 * denominator2,
	)
}

export function add__overload$2(
	fraction: FractionType,
	integer: IntegerType,
): FractionType {
	let clonedFraction = fraction.fraction.clone()

	clonedFraction.add(integer.value)

	return { [typeKeySymbol]: "Fraction", fraction: clonedFraction }
}

// #endregion

// #region Subtract

export function subtract__overload$1(
	firstFraction: FractionType,
	secondFraction: FractionType,
): FractionType {
	const numerator1 = firstFraction.fraction.numerator
	const denominator1 = firstFraction.fraction.denominator
	const numerator2 = secondFraction.fraction.numerator
	const denominator2 = secondFraction.fraction.denominator

	return createFraction(
		numerator1 * denominator2 - numerator2 * denominator1,
		denominator1 * denominator2,
	)
}

export function subtract__overload$2(
	fraction: FractionType,
	integer: IntegerType,
): FractionType {
	let clonedFraction = fraction.fraction.clone()

	clonedFraction.subtract(integer.value)

	return { [typeKeySymbol]: "Fraction", fraction: clonedFraction }
}

// #endregion

// #region Divide

export function divideBy__overload$1(
	firstFraction: FractionType,
	secondFraction: FractionType,
): FractionType {
	const numerator1 = firstFraction.fraction.numerator
	const denominator1 = firstFraction.fraction.denominator
	const numerator2 = secondFraction.fraction.numerator
	const denominator2 = secondFraction.fraction.denominator

	return createFraction(numerator1 * denominator2, denominator1 * numerator2)
}

export function divideBy__overload$2(
	fraction: FractionType,
	integer: IntegerType,
): FractionType {
	let clonedFraction = fraction.fraction.clone()

	clonedFraction.divide(integer.value)

	return { [typeKeySymbol]: "Fraction", fraction: clonedFraction }
}

// #endregion

// #region Multiply

export function multiplyWith__overload$1(
	firstFraction: FractionType,
	secondFraction: FractionType,
): FractionType {
	const numerator1 = firstFraction.fraction.numerator
	const denominator1 = firstFraction.fraction.denominator
	const numerator2 = secondFraction.fraction.numerator
	const denominator2 = secondFraction.fraction.denominator

	return createFraction(numerator1 * numerator2, denominator1 * denominator2)
}

export function multiplyWith__overload$2(
	fraction: FractionType,
	integer: IntegerType,
): FractionType {
	let clonedFraction = fraction.fraction.clone()

	clonedFraction.multiply(integer.value)

	return { [typeKeySymbol]: "Fraction", fraction: clonedFraction }
}

// #endregion

// #region isLessThan

export function isLessThan__overload$1(
	firstFraction: FractionType,
	secondFraction: FractionType,
): BooleanType {
	const numerator1 = firstFraction.fraction.numerator
	const denominator1 = firstFraction.fraction.denominator
	const numerator2 = secondFraction.fraction.numerator
	const denominator2 = secondFraction.fraction.denominator

	const fraction1 = numerator1 * denominator2
	const fraction2 = numerator2 * denominator1

	return createBoolean(fraction1 < fraction2)
}

export function isLessThan__overload$2(
	fraction: FractionType,
	integer: IntegerType,
): BooleanType {
	const numerator1 = fraction.fraction.numerator
	const denominator1 = fraction.fraction.denominator
	const numerator2 = integer.value
	const denominator2 = 1n

	const fraction1 = numerator1 * denominator2
	const fraction2 = numerator2 * denominator1

	return createBoolean(fraction1 < fraction2)
}

// #endregion

// #region isLessThanOrEqualTo

export function isLessThanOrEqualTo__overload$1(
	firstFraction: FractionType,
	secondFraction: FractionType,
): BooleanType {
	const numerator1 = firstFraction.fraction.numerator
	const denominator1 = firstFraction.fraction.denominator
	const numerator2 = secondFraction.fraction.numerator
	const denominator2 = secondFraction.fraction.denominator

	const fraction1 = numerator1 * denominator2
	const fraction2 = numerator2 * denominator1

	return createBoolean(fraction1 <= fraction2)
}

export function isLessThanOrEqualTo__overload$2(
	fraction: FractionType,
	integer: IntegerType,
): BooleanType {
	const numerator1 = fraction.fraction.numerator
	const denominator1 = fraction.fraction.denominator
	const numerator2 = integer.value
	const denominator2 = 1n

	const fraction1 = numerator1 * denominator2
	const fraction2 = numerator2 * denominator1

	return createBoolean(fraction1 <= fraction2)
}

// #endregion

// #region isGreaterThan

export function isGreaterThan__overload$1(
	firstFraction: FractionType,
	secondFraction: FractionType,
): BooleanType {
	const numerator1 = firstFraction.fraction.numerator
	const denominator1 = firstFraction.fraction.denominator
	const numerator2 = secondFraction.fraction.numerator
	const denominator2 = secondFraction.fraction.denominator

	const fraction1 = numerator1 * denominator2
	const fraction2 = numerator2 * denominator1

	return createBoolean(fraction1 > fraction2)
}

export function isGreaterThan__overload$2(
	fraction: FractionType,
	integer: IntegerType,
): BooleanType {
	const numerator1 = fraction.fraction.numerator
	const denominator1 = fraction.fraction.denominator
	const numerator2 = integer.value
	const denominator2 = 1n

	const fraction1 = numerator1 * denominator2
	const fraction2 = numerator2 * denominator1

	return createBoolean(fraction1 > fraction2)
}

// #endregion

// #region isGreaterThanOrEqualTo

export function isGreaterThanOrEqualTo__overload$1(
	firstFraction: FractionType,
	secondFraction: FractionType,
): BooleanType {
	const numerator1 = firstFraction.fraction.numerator
	const denominator1 = firstFraction.fraction.denominator
	const numerator2 = secondFraction.fraction.numerator
	const denominator2 = secondFraction.fraction.denominator

	const fraction1 = numerator1 * denominator2
	const fraction2 = numerator2 * denominator1

	return createBoolean(fraction1 >= fraction2)
}

export function isGreaterThanOrEqualTo__overload$2(
	fraction: FractionType,
	integer: IntegerType,
): BooleanType {
	const numerator1 = fraction.fraction.numerator
	const denominator1 = fraction.fraction.denominator
	const numerator2 = integer.value
	const denominator2 = 1n

	const fraction1 = numerator1 * denominator2
	const fraction2 = numerator2 * denominator1

	return createBoolean(fraction1 >= fraction2)
}

// #endregion

function formatAsFraction(fraction: Fraction): string {
	let clonedFraction = fraction.clone()
	clonedFraction.reduce()
	return `${clonedFraction.numerator}/${clonedFraction.denominator}`
}

// #region toString

export function toString__overload$1(fraction: FractionType): StringType {
	return createString(formatAsFraction(fraction.fraction))
}

export function toString__overload$2(
	fraction: FractionType,
	formatAs: StringType,
): StringType {
	if (formatAs.value === "decimal") {
		return createString(fraction.fraction.toString())
	} else {
		return createString(formatAsFraction(fraction.fraction))
	}
}

// #endregion
