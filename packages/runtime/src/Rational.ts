import { Fraction } from "bigint-fraction"

import type { AlgebraicType } from "./Algebraic"
import {
	add as algebraicAdd,
	dividedInto as algebraicDividedInto,
	multiply as algebraicMultiplyWith,
	squareRootOfRational,
} from "./Algebraic"
import { bigRationalOf } from "./bigRational"
import type { BooleanType } from "./Boolean"
import { createBoolean } from "./Boolean"
import type { IntegerType } from "./Integer"
import type { NothingType } from "./Nothing"
import { createNothing } from "./Nothing"
import type { NumberFormatType } from "./NumberFormat"
import type { OrderingType } from "./Ordering"
import { equal, greater, less } from "./Ordering"
import type { StringType } from "./String"
import { createString } from "./String"
import type { TranscendentalType } from "./Transcendental"
import {
	add as transcendentalAdd,
	multiply as transcendentalMultiplyWith,
} from "./Transcendental"
import { typeKeySymbol } from "./type"

export type RationalType = { [typeKeySymbol]: "Rational"; rational: Fraction }

// NOTE: The single gateway every Rational is built through, and the reason the
// ordering primitives may cross-multiply the raw parts: the sign lives on the
// numerator, never on the denominator. Zero is canonicalised here as well —
// `bigint-fraction`'s GCD answers 0 whenever an operand is 0 and its `reduce`
// bails on a gcd of 0, so a zero reached by cancellation (`1/2 − 1/2` gives
// `0/4`) can never reduce itself afterwards. Zero has one lowest-terms form,
// and it is `0/1`.
export function createRational(
	numerator: bigint,
	denominator: bigint,
): RationalType {
	if (denominator < 0) {
		numerator = numerator * -1n
		denominator = denominator * -1n
	}

	if (numerator === 0n && denominator !== 0n) {
		denominator = 1n
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

// NOTE: The Integer-operand overloads do the arithmetic on the parts and hand
// the result to `createRational`, rather than mutating a clone of the
// `Fraction`. The class's own operations promise neither of the invariants —
// `divide(-3n)` multiplies the DENOMINATOR by −3 and leaves the sign there,
// which every ordering primitive then reads backwards — so nothing may reach a
// caller without passing through the gateway.
export function add__overload$2(
	rational: RationalType,
	integer: IntegerType,
): RationalType {
	const numerator = rational.rational.numerator
	const denominator = rational.rational.denominator

	return createRational(numerator + integer.value * denominator, denominator)
}

// #endregion

// #region Divide

export function divide__overload$1(
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

export function divide__overload$2(
	rational: RationalType,
	integer: IntegerType,
): RationalType | NothingType {
	if (integer.value === 0n) {
		return createNothing()
	}

	return createRational(
		rational.rational.numerator,
		rational.rational.denominator * integer.value,
	)
}

// #endregion

// #region Multiply

export function multiply__overload$1(
	firstRational: RationalType,
	secondRational: RationalType,
): RationalType {
	const numerator1 = firstRational.rational.numerator
	const denominator1 = firstRational.rational.denominator
	const numerator2 = secondRational.rational.numerator
	const denominator2 = secondRational.rational.denominator

	return createRational(numerator1 * numerator2, denominator1 * denominator2)
}

export function multiply__overload$2(
	rational: RationalType,
	integer: IntegerType,
): RationalType {
	return createRational(
		rational.rational.numerator * integer.value,
		rational.rational.denominator,
	)
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

	// NOTE: The one case `reduce()` can not answer — its GCD is 0 whenever an
	// operand is 0, and it bails on a gcd of 0, so a zero keeps whatever
	// denominator it was built with. `createRational` canonicalises zero, but
	// a Rational the Integer Namespace built by adding to a Fraction has not
	// been through it, and `denominator()` and `isWholeNumber()` read here.
	if (numerator === 0n) {
		denominator = 1n
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

export function raise(
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

function formatAsRational(rational: RationalType): string {
	let parts = reducedParts(rational)

	return `${parts.numerator}/${parts.denominator}`
}

// NOTE: `bigint-fraction` seeds its decimal text with `${wholePart}.` and only
// then appends fractional digits, so a Rational that IS a whole number comes
// back as "2." — text `Rational.parse` refuses to read back, since its decimal
// form requires digits behind the dot. Drop a separator with nothing behind it.
function formatAsDecimal(rational: RationalType): string {
	let decimalForm = rational.rational.toString()

	return decimalForm.endsWith(".")
		? decimalForm.slice(0, decimalForm.length - 1)
		: decimalForm
}

// #region toString

export function toString__overload$1(rational: RationalType): StringType {
	return createString(formatAsRational(rational))
}

// NOTE: The format arrives as a `NumberFormat` Case rather than a String, so
// there is no unrecognised spelling to fall back from — the two Cases are the
// only two a caller can write.
export function toString__overload$2(
	rational: RationalType,
	formatAs: NumberFormatType,
): StringType {
	if (formatAs[typeKeySymbol] === "NumberFormat#Decimal") {
		return createString(formatAsDecimal(rational))
	} else {
		return createString(formatAsRational(rational))
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

export function multiply__overload$3(
	rational: RationalType,
	algebraic: AlgebraicType,
): AlgebraicType | RationalType {
	return algebraicMultiplyWith(algebraic, rational)
}

export function multiply__overload$4(
	rational: RationalType,
	transcendental: TranscendentalType,
): TranscendentalType | RationalType {
	return transcendentalMultiplyWith(transcendental, rational)
}

export function divide__overload$3(
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
