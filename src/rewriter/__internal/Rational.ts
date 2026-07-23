import { Fraction } from "bigint-fraction"

import type { AlgebraicType } from "./Algebraic"
import {
	add as algebraicAdd,
	bigRationalOf,
	dividedInto as algebraicDividedInto,
	multiplyWith as algebraicMultiplyWith,
	squareRootOfRational,
} from "./Algebraic"
import type { BooleanType } from "./Boolean"
import { createBoolean } from "./Boolean"
import type { IntegerType } from "./Integer"
import type { NothingType } from "./Nothing"
import { createNothing } from "./Nothing"
import type { OrderingType } from "./Ordering"
import { equal, greater, less } from "./Ordering"
import type { StringType } from "./String"
import { createString } from "./String"
import type { TranscendentalType } from "./Transcendental"
import {
	add as transcendentalAdd,
	multiplyWith as transcendentalMultiplyWith,
} from "./Transcendental"
import { typeKeySymbol } from "./type"

export type RationalType = { [typeKeySymbol]: "Rational"; rational: Fraction }

export function createRational(
	numerator: bigint,
	denominator: bigint,
): RationalType {
	if (denominator < 0) {
		numerator = numerator * -1n
		denominator = denominator * -1n
	}

	return {
		[typeKeySymbol]: "Rational",
		rational: new Fraction(numerator, denominator),
	}
}

export function of(
	numerator: IntegerType,
	denominator: IntegerType,
): RationalType | NothingType {
	if (denominator.value === 0n) {
		return createNothing()
	}

	return createRational(numerator.value, denominator.value)
}

// #region Add

export function add__overload$1(
	firstRational: RationalType,
	secondRational: RationalType,
): RationalType {
	const numerator1 = firstRational.rational.numerator
	const denominator1 = firstRational.rational.denominator
	const numerator2 = secondRational.rational.numerator
	const denominator2 = secondRational.rational.denominator

	return createRational(
		numerator1 * denominator2 + numerator2 * denominator1,
		denominator1 * denominator2,
	)
}

export function add__overload$2(
	rational: RationalType,
	integer: IntegerType,
): RationalType {
	let clonedRational = rational.rational.clone()

	clonedRational.add(integer.value)

	return { [typeKeySymbol]: "Rational", rational: clonedRational }
}

// #endregion

// #region Divide

export function divideBy__overload$1(
	firstRational: RationalType,
	secondRational: RationalType,
): RationalType | NothingType {
	const numerator1 = firstRational.rational.numerator
	const denominator1 = firstRational.rational.denominator
	const numerator2 = secondRational.rational.numerator
	const denominator2 = secondRational.rational.denominator

	if (numerator2 === 0n) {
		return createNothing()
	}

	return createRational(numerator1 * denominator2, denominator1 * numerator2)
}

export function divideBy__overload$2(
	rational: RationalType,
	integer: IntegerType,
): RationalType | NothingType {
	if (integer.value === 0n) {
		return createNothing()
	}

	let clonedRational = rational.rational.clone()

	clonedRational.divide(integer.value)

	return { [typeKeySymbol]: "Rational", rational: clonedRational }
}

// #endregion

// #region Multiply

export function multiplyWith__overload$1(
	firstRational: RationalType,
	secondRational: RationalType,
): RationalType {
	const numerator1 = firstRational.rational.numerator
	const denominator1 = firstRational.rational.denominator
	const numerator2 = secondRational.rational.numerator
	const denominator2 = secondRational.rational.denominator

	return createRational(numerator1 * numerator2, denominator1 * denominator2)
}

export function multiplyWith__overload$2(
	rational: RationalType,
	integer: IntegerType,
): RationalType {
	let clonedRational = rational.rational.clone()

	clonedRational.multiply(integer.value)

	return { [typeKeySymbol]: "Rational", rational: clonedRational }
}

// #endregion

// #region isLessThan

export function isLessThan__overload$2(
	rational: RationalType,
	integer: IntegerType,
): BooleanType {
	const numerator1 = rational.rational.numerator
	const denominator1 = rational.rational.denominator
	const numerator2 = integer.value
	const denominator2 = 1n

	const rational1 = numerator1 * denominator2
	const rational2 = numerator2 * denominator1

	return createBoolean(rational1 < rational2)
}

// #endregion

// #region isLessThanOrEqualTo

export function isLessThanOrEqualTo__overload$2(
	rational: RationalType,
	integer: IntegerType,
): BooleanType {
	const numerator1 = rational.rational.numerator
	const denominator1 = rational.rational.denominator
	const numerator2 = integer.value
	const denominator2 = 1n

	const rational1 = numerator1 * denominator2
	const rational2 = numerator2 * denominator1

	return createBoolean(rational1 <= rational2)
}

// #endregion

// #region isGreaterThan

export function isGreaterThan__overload$2(
	rational: RationalType,
	integer: IntegerType,
): BooleanType {
	const numerator1 = rational.rational.numerator
	const denominator1 = rational.rational.denominator
	const numerator2 = integer.value
	const denominator2 = 1n

	const rational1 = numerator1 * denominator2
	const rational2 = numerator2 * denominator1

	return createBoolean(rational1 > rational2)
}

// #endregion

// #region isGreaterThanOrEqualTo

export function isGreaterThanOrEqualTo__overload$2(
	rational: RationalType,
	integer: IntegerType,
): BooleanType {
	const numerator1 = rational.rational.numerator
	const denominator1 = rational.rational.denominator
	const numerator2 = integer.value
	const denominator2 = 1n

	const rational1 = numerator1 * denominator2
	const rational2 = numerator2 * denominator1

	return createBoolean(rational1 >= rational2)
}

// #endregion

// NOTE: The reduced form with the sign on the numerator — the shape the
// accessors and the rounding family read. Operations on the underlying
// Fraction class do not promise either normalization.
function reducedParts(rational: RationalType): {
	numerator: bigint
	denominator: bigint
} {
	let clonedRational = rational.rational.clone()
	clonedRational.reduce()

	let numerator = clonedRational.numerator
	let denominator = clonedRational.denominator

	if (denominator < 0n) {
		numerator = -numerator
		denominator = -denominator
	}

	return { numerator, denominator }
}

// #region Everyday methods

export function numerator(rational: RationalType): IntegerType {
	return {
		[typeKeySymbol]: "Integer",
		value: reducedParts(rational).numerator,
	}
}

export function denominator(rational: RationalType): IntegerType {
	return {
		[typeKeySymbol]: "Integer",
		value: reducedParts(rational).denominator,
	}
}

export function round(rational: RationalType): IntegerType {
	let parts = reducedParts(rational)
	let truncatedQuotient = parts.numerator / parts.denominator
	let remainder = parts.numerator % parts.denominator
	let remainderMagnitude = remainder < 0n ? -remainder : remainder

	// NOTE: Halves round away from zero.
	if (remainderMagnitude * 2n >= parts.denominator) {
		truncatedQuotient += parts.numerator < 0n ? -1n : 1n
	}

	return { [typeKeySymbol]: "Integer", value: truncatedQuotient }
}

export function truncate(rational: RationalType): IntegerType {
	let parts = reducedParts(rational)

	return {
		[typeKeySymbol]: "Integer",
		value: parts.numerator / parts.denominator,
	}
}

export function toThePowerOf(
	rational: RationalType,
	exponent: IntegerType,
): RationalType | NothingType {
	let parts = reducedParts(rational)

	if (exponent.value >= 0n) {
		return createRational(
			parts.numerator ** exponent.value,
			parts.denominator ** exponent.value,
		)
	}

	if (parts.numerator === 0n) {
		return createNothing()
	}

	return createRational(
		parts.denominator ** -exponent.value,
		parts.numerator ** -exponent.value,
	)
}

export function parse(text: StringType): RationalType | NothingType {
	let fractionForm = /^(-?[0-9]+)\/([0-9]+)$/.exec(text.value)

	if (fractionForm !== null) {
		let parsedDenominator = BigInt(fractionForm[2])

		if (parsedDenominator === 0n) {
			return createNothing()
		}

		return createRational(BigInt(fractionForm[1]), parsedDenominator)
	}

	let decimalForm = /^(-?)([0-9]+)\.([0-9]+)$/.exec(text.value)

	if (decimalForm !== null) {
		let scale = 10n ** BigInt(decimalForm[3].length)
		let magnitude = BigInt(decimalForm[2]) * scale + BigInt(decimalForm[3])

		return createRational(
			decimalForm[1] === "-" ? -magnitude : magnitude,
			scale,
		)
	}

	if (/^-?[0-9]+$/.test(text.value)) {
		return createRational(BigInt(text.value), 1n)
	}

	return createNothing()
}

// #endregion

function formatAsRational(rational: Fraction): string {
	let clonedRational = rational.clone()
	clonedRational.reduce()
	return `${clonedRational.numerator}/${clonedRational.denominator}`
}

// #region toString

export function toString__overload$1(rational: RationalType): StringType {
	return createString(formatAsRational(rational.rational))
}

export function toString__overload$2(
	rational: RationalType,
	formatAs: StringType,
): StringType {
	if (formatAs.value === "decimal") {
		return createString(rational.rational.toString())
	} else {
		return createString(formatAsRational(rational.rational))
	}
}

// #endregion

// #region Irrational operands

export function add__overload$3(
	rational: RationalType,
	algebraic: AlgebraicType,
): AlgebraicType {
	return algebraicAdd(algebraic, rational)
}

export function add__overload$4(
	rational: RationalType,
	transcendental: TranscendentalType,
): TranscendentalType {
	return transcendentalAdd(transcendental, rational)
}

export function multiplyWith__overload$3(
	rational: RationalType,
	algebraic: AlgebraicType,
): AlgebraicType | RationalType {
	return algebraicMultiplyWith(algebraic, rational)
}

export function multiplyWith__overload$4(
	rational: RationalType,
	transcendental: TranscendentalType,
): TranscendentalType | RationalType {
	return transcendentalMultiplyWith(transcendental, rational)
}

export function divideBy__overload$3(
	rational: RationalType,
	algebraic: AlgebraicType,
): AlgebraicType | RationalType {
	return algebraicDividedInto(algebraic, rational)
}

export function squareRoot(
	rational: RationalType,
): RationalType | AlgebraicType | NothingType {
	return squareRootOfRational(bigRationalOf(rational))
}

// #endregion

// NOTE: Same-kind ordering stays native — see the NOTE on `Integer.compareTo`.
// Cross-multiplication is exact, and denominators are kept positive by
// `createRational`, so the sign of the comparison is the sign of the products.
export function compareTo(
	originalRational: RationalType,
	otherRational: RationalType,
): OrderingType {
	const lhs =
		originalRational.rational.numerator * otherRational.rational.denominator
	const rhs =
		otherRational.rational.numerator * originalRational.rational.denominator

	if (lhs < rhs) {
		return less
	} else if (lhs > rhs) {
		return greater
	} else {
		return equal
	}
}
