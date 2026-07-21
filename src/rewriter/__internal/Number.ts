import { Fraction } from "bigint-fraction"

import type { BooleanType } from "./Boolean"
import { createBoolean } from "./Boolean"
import type { FractionType } from "./Fraction"
import {
	createFraction,
	toString__overload$1 as fractionToString,
} from "./Fraction"
import type { IntegerType } from "./Integer"
import { createInteger, toString as integerToString } from "./Integer"
import { isFirstFractionBigger } from "./internalHelpers"
import type { ListType } from "./List"
import type { OrderingType } from "./Ordering"
import { equal, greater, less } from "./Ordering"
import type { StringType } from "./String"
import { typeKeySymbol } from "./type"

// #region Constants

export const PI = createFraction(355n, 113n)
export const TAO = createFraction(710n, 113n)

// #endregion

// #region lowestNumber

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
		if (number[typeKeySymbol] === "Integer") {
			if (lowestNumber[typeKeySymbol] === "Integer") {
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
			if (lowestNumber[typeKeySymbol] === "Fraction") {
				if (
					isFirstFractionBigger(
						lowestNumber.fraction,
						number.fraction,
					)
				) {
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

	if (lowestNumber[typeKeySymbol] === "Fraction") {
		return createFraction(
			lowestNumber.fraction.numerator,
			lowestNumber.fraction.denominator,
		)
	} else {
		return createInteger(lowestNumber.value)
	}
}

// #endregion

// #region greatestNumber

export function greatestNumber__overload$1(
	firstNumber: IntegerType,
	secondNumber: IntegerType,
): IntegerType {
	if (firstNumber.value >= secondNumber.value) {
		return createInteger(firstNumber.value)
	} else {
		return createInteger(secondNumber.value)
	}
}

export function greatestNumber__overload$2(
	firstNumber: FractionType,
	secondNumber: FractionType,
): FractionType {
	if (isFirstFractionBigger(firstNumber.fraction, secondNumber.fraction)) {
		return createFraction(
			firstNumber.fraction.numerator,
			firstNumber.fraction.denominator,
		)
	} else {
		return createFraction(
			secondNumber.fraction.numerator,
			secondNumber.fraction.denominator,
		)
	}
}

export function greatestNumber__overload$3(
	firstNumber: IntegerType,
	secondNumber: FractionType,
): IntegerType | FractionType {
	let firstNumberFraction = new Fraction(firstNumber.value, 1)

	if (isFirstFractionBigger(firstNumberFraction, secondNumber.fraction)) {
		return createInteger(firstNumber.value)
	} else {
		return createFraction(
			secondNumber.fraction.numerator,
			secondNumber.fraction.denominator,
		)
	}
}

export function greatestNumber__overload$4(
	firstNumber: FractionType,
	secondNumber: IntegerType,
): IntegerType | FractionType {
	let secondNumberFraction = new Fraction(secondNumber.value, 1)

	if (isFirstFractionBigger(firstNumber.fraction, secondNumberFraction)) {
		return createFraction(
			firstNumber.fraction.numerator,
			firstNumber.fraction.denominator,
		)
	} else {
		return createInteger(secondNumber.value)
	}
}

export function greatestNumber__overload$5(
	integers: ListType<IntegerType>,
): IntegerType {
	let greatestInteger = integers.value[0]

	for (let integer of integers.value.slice(1)) {
		if (integer.value > greatestInteger.value) {
			greatestInteger = integer
		}
	}

	return createInteger(greatestInteger.value)
}

export function greatestNumber__overload$6(
	fractions: ListType<FractionType>,
): FractionType {
	let greatestFraction = fractions.value[0]

	for (let fraction of fractions.value.slice(1)) {
		if (
			isFirstFractionBigger(fraction.fraction, greatestFraction.fraction)
		) {
			greatestFraction = fraction
		}
	}

	return createFraction(
		greatestFraction.fraction.numerator,
		greatestFraction.fraction.denominator,
	)
}

export function greatestNumber__overload$7(
	numbers: ListType<IntegerType | FractionType>,
): IntegerType | FractionType {
	let greatestNumber = numbers.value[0]

	for (let number of numbers.value.slice(1)) {
		if (number[typeKeySymbol] === "Integer") {
			if (greatestNumber[typeKeySymbol] === "Integer") {
				if (number.value > greatestNumber.value) {
					greatestNumber = number
				}
			} else {
				if (
					isFirstFractionBigger(
						new Fraction(number.value, 1),
						greatestNumber.fraction,
					)
				) {
					greatestNumber = number
				}
			}
		} else {
			if (greatestNumber[typeKeySymbol] === "Fraction") {
				if (
					isFirstFractionBigger(
						number.fraction,
						greatestNumber.fraction,
					)
				) {
					greatestNumber = number
				}
			} else {
				if (
					isFirstFractionBigger(
						number.fraction,
						new Fraction(greatestNumber.value, 1),
					)
				) {
					greatestNumber = number
				}
			}
		}
	}

	if (greatestNumber[typeKeySymbol] === "Fraction") {
		return createFraction(
			greatestNumber.fraction.numerator,
			greatestNumber.fraction.denominator,
		)
	} else {
		return createInteger(greatestNumber.value)
	}
}

// #endregion

// #region Union-level Methods

export type NumberType = IntegerType | FractionType

// NOTE: The cross-member semantics of `Number`: two Numbers are compared by
// numeric value, so the Integer `1` and the Fraction `1/1` are the same
// Number even though the member Namespaces treat them as different values.
// Cross-multiplication keeps everything in bigint arithmetic; equality is
// sign-safe, and the ordering comparisons assume positive denominators like
// the rest of the runtime does.
function numeratorOf(number: NumberType): bigint {
	if (number[typeKeySymbol] === "Integer") {
		return number.value
	} else {
		return number.fraction.numerator
	}
}

function denominatorOf(number: NumberType): bigint {
	if (number[typeKeySymbol] === "Integer") {
		return 1n
	} else {
		return number.fraction.denominator
	}
}

export function is(number: NumberType, other: NumberType): BooleanType {
	return createBoolean(
		numeratorOf(number) * denominatorOf(other) ===
			numeratorOf(other) * denominatorOf(number),
	)
}

export function isNot(number: NumberType, other: NumberType): BooleanType {
	return createBoolean(!is(number, other).value)
}

export function toString(number: NumberType): StringType {
	if (number[typeKeySymbol] === "Integer") {
		return integerToString(number)
	} else {
		return fractionToString(number)
	}
}

export function compareTo(number: NumberType, other: NumberType): OrderingType {
	let lhs = numeratorOf(number) * denominatorOf(other)
	let rhs = numeratorOf(other) * denominatorOf(number)

	if (lhs < rhs) {
		return less
	} else if (lhs === rhs) {
		return equal
	} else {
		return greater
	}
}

// #endregion
