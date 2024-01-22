import type { FractionType } from "./Fraction"
import type { StringType } from "./String"

import { Fraction } from "bigint-fraction"

import { createFraction } from "./Fraction"
import { createString } from "./String"
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

export function divide__overload$1(
	numerator: IntegerType,
	denominator: IntegerType,
): FractionType {
	return createFraction(numerator.value, denominator.value)
}

export function divide__overload$2(
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

export function multiply__overload$1(
	originalNumber: IntegerType,
	other: IntegerType,
): IntegerType {
	return createInteger(originalNumber.value * other.value)
}

export function multiply__overload$2(
	originalNumber: IntegerType,
	other: FractionType,
): FractionType {
	let clonedFraction = other.fraction.clone()
	clonedFraction.multiply(originalNumber.value)

	return { [typeKeySymbol]: "Fraction", fraction: clonedFraction }
}

// #endregion

// biome-ignore lint/suspicious/noShadowRestrictedNames:
export function toString(integer: IntegerType): StringType {
	return createString(integer.value.toString())
}
