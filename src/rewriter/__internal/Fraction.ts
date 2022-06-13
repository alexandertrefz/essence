import { Fraction } from "bigint-fraction"

import type { IntegerType } from "./Integer"

export type FractionType = { $type: "Fraction"; fraction: Fraction }

export function createFraction(numerator: bigint, denominator: bigint): FractionType {
	return { $type: "Fraction", fraction: new Fraction(numerator, denominator) }
}

// #region Add

export function add__overload$1(numerator: FractionType, denominator: FractionType): FractionType {
	const numerator1 = numerator.fraction.numerator
	const denominator1 = numerator.fraction.denominator
	const numerator2 = denominator.fraction.numerator
	const denominator2 = denominator.fraction.denominator

	return createFraction(numerator1 * denominator2 + numerator2 * denominator1, denominator1 * denominator2)
}

export function add__overload$2(numerator: FractionType, denominator: IntegerType): FractionType {
	let fraction = numerator.fraction.clone()

	fraction.add(denominator.value)

	return { $type: "Fraction", fraction }
}

// #endregion

// #region Subtract

export function subtract__overload$1(numerator: FractionType, denominator: FractionType): FractionType {
	const numerator1 = numerator.fraction.numerator
	const denominator1 = numerator.fraction.denominator
	const numerator2 = denominator.fraction.numerator
	const denominator2 = denominator.fraction.denominator

	return createFraction(numerator1 * denominator2 - numerator2 * denominator1, denominator1 * denominator2)
}

export function subtract__overload$2(numerator: FractionType, denominator: IntegerType): FractionType {
	let fraction = numerator.fraction.clone()

	fraction.subtract(denominator.value)

	return { $type: "Fraction", fraction }
}

// #endregion

// #region Divide

export function divide__overload$1(numerator: FractionType, denominator: FractionType): FractionType {
	const numerator1 = numerator.fraction.numerator
	const denominator1 = numerator.fraction.denominator
	const numerator2 = denominator.fraction.numerator
	const denominator2 = denominator.fraction.denominator

	return createFraction(numerator1 * denominator2, denominator1 * numerator2)
}

export function divide__overload$2(numerator: FractionType, denominator: IntegerType): FractionType {
	let fraction = numerator.fraction.clone()

	fraction.divide(denominator.value)

	return { $type: "Fraction", fraction }
}

// #endregion

// #region Multiply

export function multiply__overload$1(numerator: FractionType, denominator: FractionType): FractionType {
	const numerator1 = numerator.fraction.numerator
	const denominator1 = numerator.fraction.denominator
	const numerator2 = denominator.fraction.numerator
	const denominator2 = denominator.fraction.denominator

	return createFraction(numerator1 * numerator2, denominator1 * denominator2)
}

export function multiply__overload$2(numerator: FractionType, denominator: IntegerType): FractionType {
	let fraction = numerator.fraction.clone()

	fraction.multiply(denominator.value)

	return { $type: "Fraction", fraction }
}

// #endregion
