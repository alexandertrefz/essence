import { Fraction } from "bigint-fraction"

import type { IntegerType } from "./Integer"
import type { StringType } from "./String"

import { createString } from "./String"

export type FractionType = { $type: "Fraction"; fraction: Fraction }

export function createFraction(
	numerator: bigint,
	denominator: bigint,
): FractionType {
	if (denominator < 0) {
		numerator = numerator * -1n
		denominator = denominator * -1n
	}

	return { $type: "Fraction", fraction: new Fraction(numerator, denominator) }
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

	return { $type: "Fraction", fraction: clonedFraction }
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

	return { $type: "Fraction", fraction: clonedFraction }
}

// #endregion

// #region Divide

export function divide__overload$1(
	firstFraction: FractionType,
	secondFraction: FractionType,
): FractionType {
	const numerator1 = firstFraction.fraction.numerator
	const denominator1 = firstFraction.fraction.denominator
	const numerator2 = secondFraction.fraction.numerator
	const denominator2 = secondFraction.fraction.denominator

	return createFraction(numerator1 * denominator2, denominator1 * numerator2)
}

export function divide__overload$2(
	fraction: FractionType,
	integer: IntegerType,
): FractionType {
	let clonedFraction = fraction.fraction.clone()

	clonedFraction.divide(integer.value)

	return { $type: "Fraction", fraction: clonedFraction }
}

// #endregion

// #region Multiply

export function multiply__overload$1(
	firstFraction: FractionType,
	secondFraction: FractionType,
): FractionType {
	const numerator1 = firstFraction.fraction.numerator
	const denominator1 = firstFraction.fraction.denominator
	const numerator2 = secondFraction.fraction.numerator
	const denominator2 = secondFraction.fraction.denominator

	return createFraction(numerator1 * numerator2, denominator1 * denominator2)
}

export function multiply__overload$2(
	fraction: FractionType,
	integer: IntegerType,
): FractionType {
	let clonedFraction = fraction.fraction.clone()

	clonedFraction.multiply(integer.value)

	return { $type: "Fraction", fraction: clonedFraction }
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
