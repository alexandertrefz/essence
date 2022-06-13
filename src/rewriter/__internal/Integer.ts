import { createFraction, FractionType } from "./Fraction"

export type IntegerType = { $type: "Integer"; value: bigint }

export function createInteger(value: bigint): IntegerType {
	return { $type: "Integer", value }
}

// #region Add

export function add__overload$1(originalNumber: IntegerType, other: IntegerType): IntegerType {
	return createInteger(originalNumber.value + other.value)
}

export function add__overload$2(originalNumber: IntegerType, other: FractionType): FractionType {
	let clonedFraction = other.fraction.clone()
	clonedFraction.add(originalNumber.value)

	return { $type: "Fraction", fraction: clonedFraction }
}

// #endregion

// #region Subtract

export function subtract__overload$1(originalNumber: IntegerType, other: IntegerType): IntegerType {
	return createInteger(originalNumber.value - other.value)
}

export function subtract__overload$2(originalNumber: IntegerType, other: FractionType): FractionType {
	let clonedFraction = other.fraction.clone()
	clonedFraction.subtract(originalNumber.value)

	return { $type: "Fraction", fraction: clonedFraction }
}

// #endregion

// #region Divide

export function divide__overload$1(numerator: IntegerType, denominator: IntegerType): FractionType {
	return createFraction(numerator.value, denominator.value)
}

export function divide__overload$2(numerator: IntegerType, denominator: FractionType): FractionType {
	let numerator1 = numerator.value
	let denominator1 = 1n
	let numerator2 = denominator.fraction.numerator
	let denominator2 = denominator.fraction.denominator

	return createFraction(numerator1 * denominator2, denominator1 * numerator2)
}

// #endregion

// #region Multiply

export function multiply__overload$1(originalNumber: IntegerType, other: IntegerType): IntegerType {
	return createInteger(originalNumber.value * other.value)
}

export function multiply__overload$2(originalNumber: IntegerType, other: FractionType): FractionType {
	let clonedFraction = other.fraction.clone()
	clonedFraction.multiply(originalNumber.value)

	return { $type: "Fraction", fraction: clonedFraction }
}

// #endregion
