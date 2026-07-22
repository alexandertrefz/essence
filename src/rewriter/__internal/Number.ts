import { Fraction } from "bigint-fraction"

import type { AlgebraicType } from "./Algebraic"
import {
	compareTo as compareAlgebraicTo,
	is as algebraicIs,
	reduced,
	toString as algebraicToString,
} from "./Algebraic"
import type { BooleanType } from "./Boolean"
import { createBoolean } from "./Boolean"
import type { IntegerType } from "./Integer"
import { createInteger, toString as integerToString } from "./Integer"
import { isFirstRationalBigger } from "./internalHelpers"
import type { ListType } from "./List"
import type { NothingType } from "./Nothing"
import { createNothing } from "./Nothing"
import type { OrderingType } from "./Ordering"
import { equal, greater, less, is as orderingIs } from "./Ordering"
import type { RationalType } from "./Rational"
import {
	createRational,
	toString__overload$1 as rationalToString,
} from "./Rational"
import type { StringType } from "./String"
import type { TranscendentalType } from "./Transcendental"
import {
	compareTranscendentals,
	createTranscendental,
	is as transcendentalIs,
	signRelativeTo,
	toString as transcendentalToString,
} from "./Transcendental"
import { typeKeySymbol } from "./type"

// #region Constants

export const PI = createTranscendental(
	{ numerator: 0n, denominator: 1n },
	{ numerator: 1n, denominator: 1n },
) as TranscendentalType
export const TAU = createTranscendental(
	{ numerator: 0n, denominator: 1n },
	{ numerator: 2n, denominator: 1n },
) as TranscendentalType

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
): IntegerType | NothingType {
	if (integers.value.length === 0) {
		return createNothing()
	}

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
): RationalType | NothingType {
	if (rationals.value.length === 0) {
		return createNothing()
	}

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
): IntegerType | RationalType | NothingType {
	if (numbers.value.length === 0) {
		return createNothing()
	}

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
): IntegerType | NothingType {
	if (integers.value.length === 0) {
		return createNothing()
	}

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
): RationalType | NothingType {
	if (rationals.value.length === 0) {
		return createNothing()
	}

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
): IntegerType | RationalType | NothingType {
	if (numbers.value.length === 0) {
		return createNothing()
	}

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

// #region Aggregates

// NOTE: The exact running total as a bigint rational — the one shape every
// mix of Integers and Rationals folds into without loss.
function addToRunningTotal(
	total: { numerator: bigint; denominator: bigint },
	number: IntegerType | RationalType,
): { numerator: bigint; denominator: bigint } {
	if (number[typeKeySymbol] === "Integer") {
		return {
			numerator: total.numerator + number.value * total.denominator,
			denominator: total.denominator,
		}
	}

	return {
		numerator:
			total.numerator * number.rational.denominator +
			number.rational.numerator * total.denominator,
		denominator: total.denominator * number.rational.denominator,
	}
}

function multiplyIntoRunningProduct(
	product: { numerator: bigint; denominator: bigint },
	number: IntegerType | RationalType,
): { numerator: bigint; denominator: bigint } {
	if (number[typeKeySymbol] === "Integer") {
		return {
			numerator: product.numerator * number.value,
			denominator: product.denominator,
		}
	}

	return {
		numerator: product.numerator * number.rational.numerator,
		denominator: product.denominator * number.rational.denominator,
	}
}

export function sum__overload$1(integers: ListType<IntegerType>): IntegerType {
	let total = 0n

	for (let integer of integers.value) {
		total += integer.value
	}

	return createInteger(total)
}

export function sum__overload$2(
	rationals: ListType<RationalType>,
): RationalType {
	let total = { numerator: 0n, denominator: 1n }

	for (let rational of rationals.value) {
		total = addToRunningTotal(total, rational)
	}

	return createRational(total.numerator, total.denominator)
}

export function sum__overload$3(
	numbers: ListType<IntegerType | RationalType>,
): IntegerType | RationalType {
	let total = { numerator: 0n, denominator: 1n }

	for (let number of numbers.value) {
		total = addToRunningTotal(total, number)
	}

	// NOTE: A mixed List may still add up to a whole number — surface it as
	// one, like `lowestNumber` surfaces whichever member won.
	const reducedTotal = reduced(total.numerator, total.denominator)

	if (reducedTotal.denominator === 1n) {
		return createInteger(reducedTotal.numerator)
	}

	return createRational(reducedTotal.numerator, reducedTotal.denominator)
}

export function product__overload$1(
	integers: ListType<IntegerType>,
): IntegerType {
	let product = 1n

	for (let integer of integers.value) {
		product *= integer.value
	}

	return createInteger(product)
}

export function product__overload$2(
	rationals: ListType<RationalType>,
): RationalType {
	let product = { numerator: 1n, denominator: 1n }

	for (let rational of rationals.value) {
		product = multiplyIntoRunningProduct(product, rational)
	}

	return createRational(product.numerator, product.denominator)
}

export function product__overload$3(
	numbers: ListType<IntegerType | RationalType>,
): IntegerType | RationalType {
	let product = { numerator: 1n, denominator: 1n }

	for (let number of numbers.value) {
		product = multiplyIntoRunningProduct(product, number)
	}

	const reducedProduct = reduced(product.numerator, product.denominator)

	if (reducedProduct.denominator === 1n) {
		return createInteger(reducedProduct.numerator)
	}

	return createRational(reducedProduct.numerator, reducedProduct.denominator)
}

function averageOf(
	numbers: ListType<IntegerType | RationalType>,
): RationalType | NothingType {
	if (numbers.value.length === 0) {
		return createNothing()
	}

	let total = { numerator: 0n, denominator: 1n }

	for (let number of numbers.value) {
		total = addToRunningTotal(total, number)
	}

	return createRational(
		total.numerator,
		total.denominator * BigInt(numbers.value.length),
	)
}

export const average__overload$1 = averageOf
export const average__overload$2 = averageOf
export const average__overload$3 = averageOf

// #endregion

// #region Union-level Methods

export type NumberType =
	| IntegerType
	| RationalType
	| AlgebraicType
	| TranscendentalType

type RationalKind = IntegerType | RationalType

// NOTE: The cross-member semantics of `Number`: two Numbers are compared by
// numeric value, so the Integer `1` and the Rational `1/1` are the same
// Number even though the member Namespaces treat them as different values.
// Cross-multiplication keeps everything in bigint arithmetic; equality is
// sign-safe, and the ordering comparisons assume positive denominators like
// the rest of the runtime does.
function numeratorOf(number: RationalKind): bigint {
	if (number[typeKeySymbol] === "Integer") {
		return number.value
	} else {
		return number.rational.numerator
	}
}

function denominatorOf(number: RationalKind): bigint {
	if (number[typeKeySymbol] === "Integer") {
		return 1n
	} else {
		return number.rational.denominator
	}
}

export function is(number: NumberType, other: NumberType): BooleanType {
	const numberKind = number[typeKeySymbol]
	const otherKind = other[typeKeySymbol]

	if (numberKind === "Algebraic" || otherKind === "Algebraic") {
		// NOTE: An Algebraic is irrational by construction — it can only ever
		// equal another Algebraic.
		if (numberKind === "Algebraic" && otherKind === "Algebraic") {
			return algebraicIs(number as AlgebraicType, other as AlgebraicType)
		}

		return createBoolean(false)
	}

	if (numberKind === "Transcendental" || otherKind === "Transcendental") {
		// NOTE: A Transcendental is provably not algebraic — it can only ever
		// equal another Transcendental.
		if (numberKind === "Transcendental" && otherKind === "Transcendental") {
			return transcendentalIs(
				number as TranscendentalType,
				other as TranscendentalType,
			)
		}

		return createBoolean(false)
	}

	return createBoolean(
		numeratorOf(number as RationalKind) *
			denominatorOf(other as RationalKind) ===
			numeratorOf(other as RationalKind) *
				denominatorOf(number as RationalKind),
	)
}

export function isNot(number: NumberType, other: NumberType): BooleanType {
	return createBoolean(!is(number, other).value)
}

export function toString(number: NumberType): StringType {
	if (number[typeKeySymbol] === "Integer") {
		return integerToString(number)
	} else if (number[typeKeySymbol] === "Rational") {
		return rationalToString(number)
	} else if (number[typeKeySymbol] === "Algebraic") {
		return algebraicToString(number)
	} else {
		return transcendentalToString(number)
	}
}

// NOTE: Wiring B — the covering Namespace hand-writes all sixteen cells.
// Every cross-kind cell is total and exact, because equality across kinds is
// impossible by definition; only comparing two Transcendentals could ever
// need refinement, and within the current linear-in-π grammar even that cell
// is exact.
export function compareTo(number: NumberType, other: NumberType): OrderingType {
	const numberKind = number[typeKeySymbol]
	const otherKind = other[typeKeySymbol]

	if (numberKind === "Transcendental") {
		if (otherKind === "Transcendental") {
			return compareTranscendentals(
				number as TranscendentalType,
				other as TranscendentalType,
			)
		}

		return signRelativeTo(
			number as TranscendentalType,
			other as RationalKind | AlgebraicType,
		) < 0n
			? less
			: greater
	}

	if (otherKind === "Transcendental") {
		return signRelativeTo(
			other as TranscendentalType,
			number as RationalKind | AlgebraicType,
		) < 0n
			? greater
			: less
	}

	if (numberKind === "Algebraic") {
		return compareAlgebraicTo(
			number as AlgebraicType,
			other as RationalKind | AlgebraicType,
		)
	}

	if (otherKind === "Algebraic") {
		const inverted = compareAlgebraicTo(
			other as AlgebraicType,
			number as RationalKind,
		)

		if (inverted === less) {
			return greater
		} else if (inverted === greater) {
			return less
		}

		return equal
	}

	let lhs =
		numeratorOf(number as RationalKind) *
		denominatorOf(other as RationalKind)
	let rhs =
		numeratorOf(other as RationalKind) *
		denominatorOf(number as RationalKind)

	if (lhs < rhs) {
		return less
	} else if (lhs === rhs) {
		return equal
	} else {
		return greater
	}
}

// #endregion

// #region Comparisons

// NOTE: The Union-level ordering — one signature over every pair, reading the
// covering `compareTo`, which hand-writes all sixteen cells. This is where a
// Transcendental is compared against another Transcendental; the member
// Namespaces leave that cell out.

export function isLessThan(number: NumberType, other: NumberType): BooleanType {
	return createBoolean(orderingIs(compareTo(number, other), less).value)
}

export function isLessThanOrEqualTo(
	number: NumberType,
	other: NumberType,
): BooleanType {
	return createBoolean(!orderingIs(compareTo(number, other), greater).value)
}

export function isGreaterThan(
	number: NumberType,
	other: NumberType,
): BooleanType {
	return createBoolean(orderingIs(compareTo(number, other), greater).value)
}

export function isGreaterThanOrEqualTo(
	number: NumberType,
	other: NumberType,
): BooleanType {
	return createBoolean(!orderingIs(compareTo(number, other), less).value)
}

// #endregion
