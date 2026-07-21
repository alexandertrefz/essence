import { Fraction } from "bigint-fraction"

import type { BooleanType } from "./Boolean"
import { createBoolean } from "./Boolean"
import type { IntegerType } from "./Integer"
import { createInteger, toString as integerToString } from "./Integer"
import { isFirstRationalBigger } from "./internalHelpers"
import type { ListType } from "./List"
import type { OrderingType } from "./Ordering"
import { equal, greater, less } from "./Ordering"
import type { RationalType } from "./Rational"
import {
	createRational,
	toString__overload$1 as rationalToString,
} from "./Rational"
import type { StringType } from "./String"
import { typeKeySymbol } from "./type"

// #region Constants

export const PI = createRational(355n, 113n)
export const TAO = createRational(710n, 113n)

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
	firstNumber: RationalType,
	secondNumber: RationalType,
): RationalType {
	if (isFirstRationalBigger(firstNumber.rational, secondNumber.rational)) {
		return createRational(
			secondNumber.rational.numerator,
			secondNumber.rational.denominator,
		)
	} else {
		return createRational(
			firstNumber.rational.numerator,
			firstNumber.rational.denominator,
		)
	}
}

export function lowestNumber__overload$3(
	firstNumber: IntegerType,
	secondNumber: RationalType,
): IntegerType | RationalType {
	let firstNumberRational = new Fraction(firstNumber.value, 1)

	if (isFirstRationalBigger(firstNumberRational, secondNumber.rational)) {
		return createRational(
			secondNumber.rational.numerator,
			secondNumber.rational.denominator,
		)
	} else {
		return createInteger(firstNumber.value)
	}
}

export function lowestNumber__overload$4(
	firstNumber: RationalType,
	secondNumber: IntegerType,
): IntegerType | RationalType {
	let secondNumberRational = new Fraction(secondNumber.value, 1)

	if (isFirstRationalBigger(firstNumber.rational, secondNumberRational)) {
		return createInteger(secondNumber.value)
	} else {
		return createRational(
			firstNumber.rational.numerator,
			firstNumber.rational.denominator,
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
	rationals: ListType<RationalType>,
): RationalType {
	let lowestRational = rationals.value[0]

	for (let rational of rationals.value.slice(1)) {
		if (isFirstRationalBigger(lowestRational.rational, rational.rational)) {
			lowestRational = rational
		}
	}

	return createRational(
		lowestRational.rational.numerator,
		lowestRational.rational.denominator,
	)
}

export function lowestNumber__overload$7(
	numbers: ListType<IntegerType | RationalType>,
): IntegerType | RationalType {
	let lowestNumber = numbers.value[0]

	for (let number of numbers.value.slice(1)) {
		if (number[typeKeySymbol] === "Integer") {
			if (lowestNumber[typeKeySymbol] === "Integer") {
				if (number.value < lowestNumber.value) {
					lowestNumber = number
				}
			} else {
				if (
					isFirstRationalBigger(
						lowestNumber.rational,
						new Fraction(number.value, 1),
					)
				) {
					lowestNumber = number
				}
			}
		} else {
			if (lowestNumber[typeKeySymbol] === "Rational") {
				if (
					isFirstRationalBigger(
						lowestNumber.rational,
						number.rational,
					)
				) {
					lowestNumber = number
				}
			} else {
				if (
					isFirstRationalBigger(
						new Fraction(lowestNumber.value, 1),
						number.rational,
					)
				) {
					lowestNumber = number
				}
			}
		}
	}

	if (lowestNumber[typeKeySymbol] === "Rational") {
		return createRational(
			lowestNumber.rational.numerator,
			lowestNumber.rational.denominator,
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
	firstNumber: RationalType,
	secondNumber: RationalType,
): RationalType {
	if (isFirstRationalBigger(firstNumber.rational, secondNumber.rational)) {
		return createRational(
			firstNumber.rational.numerator,
			firstNumber.rational.denominator,
		)
	} else {
		return createRational(
			secondNumber.rational.numerator,
			secondNumber.rational.denominator,
		)
	}
}

export function greatestNumber__overload$3(
	firstNumber: IntegerType,
	secondNumber: RationalType,
): IntegerType | RationalType {
	let firstNumberRational = new Fraction(firstNumber.value, 1)

	if (isFirstRationalBigger(firstNumberRational, secondNumber.rational)) {
		return createInteger(firstNumber.value)
	} else {
		return createRational(
			secondNumber.rational.numerator,
			secondNumber.rational.denominator,
		)
	}
}

export function greatestNumber__overload$4(
	firstNumber: RationalType,
	secondNumber: IntegerType,
): IntegerType | RationalType {
	let secondNumberRational = new Fraction(secondNumber.value, 1)

	if (isFirstRationalBigger(firstNumber.rational, secondNumberRational)) {
		return createRational(
			firstNumber.rational.numerator,
			firstNumber.rational.denominator,
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
	rationals: ListType<RationalType>,
): RationalType {
	let greatestRational = rationals.value[0]

	for (let rational of rationals.value.slice(1)) {
		if (
			isFirstRationalBigger(rational.rational, greatestRational.rational)
		) {
			greatestRational = rational
		}
	}

	return createRational(
		greatestRational.rational.numerator,
		greatestRational.rational.denominator,
	)
}

export function greatestNumber__overload$7(
	numbers: ListType<IntegerType | RationalType>,
): IntegerType | RationalType {
	let greatestNumber = numbers.value[0]

	for (let number of numbers.value.slice(1)) {
		if (number[typeKeySymbol] === "Integer") {
			if (greatestNumber[typeKeySymbol] === "Integer") {
				if (number.value > greatestNumber.value) {
					greatestNumber = number
				}
			} else {
				if (
					isFirstRationalBigger(
						new Fraction(number.value, 1),
						greatestNumber.rational,
					)
				) {
					greatestNumber = number
				}
			}
		} else {
			if (greatestNumber[typeKeySymbol] === "Rational") {
				if (
					isFirstRationalBigger(
						number.rational,
						greatestNumber.rational,
					)
				) {
					greatestNumber = number
				}
			} else {
				if (
					isFirstRationalBigger(
						number.rational,
						new Fraction(greatestNumber.value, 1),
					)
				) {
					greatestNumber = number
				}
			}
		}
	}

	if (greatestNumber[typeKeySymbol] === "Rational") {
		return createRational(
			greatestNumber.rational.numerator,
			greatestNumber.rational.denominator,
		)
	} else {
		return createInteger(greatestNumber.value)
	}
}

// #endregion

// #region Union-level Methods

export type NumberType = IntegerType | RationalType

// NOTE: The cross-member semantics of `Number`: two Numbers are compared by
// numeric value, so the Integer `1` and the Rational `1/1` are the same
// Number even though the member Namespaces treat them as different values.
// Cross-multiplication keeps everything in bigint arithmetic; equality is
// sign-safe, and the ordering comparisons assume positive denominators like
// the rest of the runtime does.
function numeratorOf(number: NumberType): bigint {
	if (number[typeKeySymbol] === "Integer") {
		return number.value
	} else {
		return number.rational.numerator
	}
}

function denominatorOf(number: NumberType): bigint {
	if (number[typeKeySymbol] === "Integer") {
		return 1n
	} else {
		return number.rational.denominator
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
		return rationalToString(number)
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
