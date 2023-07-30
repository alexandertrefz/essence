import { Fraction } from "bigint-fraction"

import type { FractionType } from "./Fraction"
import type { IntegerType } from "./Integer"
import type { ListType } from "./List"

import { createFraction } from "./Fraction"
import { createInteger } from "./Integer"
import { isFirstFractionBigger } from "./internalHelpers"

export const PI = createFraction(355n, 113n)
export const TAO = createFraction(710n, 113n)

export function lowestNumber__overload$1(
	firstNumber: IntegerType,
	secondNumber: IntegerType,
): IntegerType {
	if (firstNumber.value <= secondNumber.value) {
		return createInteger(firstNumber.value)
	} else {
		return createInteger(secondNumber.value)
	}
}

export function lowestNumber__overload$2(
	firstNumber: FractionType,
	secondNumber: FractionType,
): FractionType {
	if (isFirstFractionBigger(firstNumber.fraction, secondNumber.fraction)) {
		return createFraction(
			secondNumber.fraction.numerator,
			secondNumber.fraction.denominator,
		)
	} else {
		return createFraction(
			firstNumber.fraction.numerator,
			firstNumber.fraction.denominator,
		)
	}
}

export function lowestNumber__overload$3(
	firstNumber: IntegerType,
	secondNumber: FractionType,
): IntegerType | FractionType {
	let firstNumberFraction = new Fraction(firstNumber.value, 1)

	if (isFirstFractionBigger(firstNumberFraction, secondNumber.fraction)) {
		return createFraction(
			secondNumber.fraction.numerator,
			secondNumber.fraction.denominator,
		)
	} else {
		return createInteger(firstNumber.value)
	}
}

export function lowestNumber__overload$4(
	firstNumber: FractionType,
	secondNumber: IntegerType,
): IntegerType | FractionType {
	let secondNumberFraction = new Fraction(secondNumber.value, 1)

	if (isFirstFractionBigger(firstNumber.fraction, secondNumberFraction)) {
		return createInteger(secondNumber.value)
	} else {
		return createFraction(
			firstNumber.fraction.numerator,
			firstNumber.fraction.denominator,
		)
	}
}

export function lowestNumber__overload$5(
	integers: ListType<IntegerType>,
): IntegerType {
	let lowestInteger = integers.value[0]

	for (let integer of integers.value.slice(1)) {
		if (integer.value < lowestInteger.value) {
			lowestInteger = integer
		}
	}

	return createInteger(lowestInteger.value)
}

export function lowestNumber__overload$6(
	fractions: ListType<FractionType>,
): FractionType {
	let lowestFraction = fractions.value[0]

	for (let fraction of fractions.value.slice(1)) {
		if (isFirstFractionBigger(lowestFraction.fraction, fraction.fraction)) {
			lowestFraction = fraction
		}
	}

	return createFraction(
		lowestFraction.fraction.numerator,
		lowestFraction.fraction.denominator,
	)
}

export function lowestNumber__overload$7(
	numbers: ListType<IntegerType | FractionType>,
): IntegerType | FractionType {
	let lowestNumber = numbers.value[0]

	for (let number of numbers.value.slice(1)) {
		if (number.$type === "Integer") {
			if (lowestNumber.$type === "Integer") {
				if (number.value < lowestNumber.value) {
					lowestNumber = number
				}
			} else {
				if (
					isFirstFractionBigger(
						lowestNumber.fraction,
						new Fraction(number.value, 1),
					)
				) {
					lowestNumber = number
				}
			}
		} else {
			if (lowestNumber.$type === "Fraction") {
				if (isFirstFractionBigger(lowestNumber.fraction, number.fraction)) {
					lowestNumber = number
				}
			} else {
				if (
					isFirstFractionBigger(
						new Fraction(lowestNumber.value, 1),
						number.fraction,
					)
				) {
					lowestNumber = number
				}
			}
		}
	}

	if (lowestNumber.$type === "Fraction") {
		return createFraction(
			lowestNumber.fraction.numerator,
			lowestNumber.fraction.denominator,
		)
	} else {
		return createInteger(lowestNumber.value)
	}
}
