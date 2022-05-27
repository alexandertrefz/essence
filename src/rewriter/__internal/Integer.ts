import { createFraction, FractionType } from "./Fraction"

export type IntegerType = { $type: "Integer"; value: bigint }

export function createInteger(value: bigint): IntegerType {
	return { $type: "Integer", value }
}

export function add(originalNumber: IntegerType, other: IntegerType): IntegerType {
	return createInteger(originalNumber.value + other.value)
}

export function subtract(originalNumber: IntegerType, other: IntegerType): IntegerType {
	return createInteger(originalNumber.value - other.value)
}

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

export function multiply(originalNumber: IntegerType, other: IntegerType): IntegerType {
	return createInteger(originalNumber.value * other.value)
}
