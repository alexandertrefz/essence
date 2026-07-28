import type { AlgebraicType } from "./Algebraic"
import {
	add as algebraicAdd,
	dividedInto as algebraicDividedInto,
	multiply as algebraicMultiplyWith,
	squareRootOfRational,
} from "./Algebraic"
import type { BigRational } from "./bigRational"
import { bigRationalOf, reduced } from "./bigRational"
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

// NOTE: The parts are held unreduced — `4/2` prints as `4/2` — and are treated
// as immutable everywhere; reduction happens on read, in `reducedParts`.
export type RationalType = {
	[typeKeySymbol]: "Rational"
	numerator: bigint
	denominator: bigint
}

// NOTE: The single gateway every Rational is built through, and the reason the
// ordering primitives may cross-multiply the raw parts: the sign lives on the
// numerator, never on the denominator. Zero is canonicalised here as well —
// a zero reached by cancellation (`1/2 − 1/2` gives `0/4`) has one
// lowest-terms form, and it is `0/1`.
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
		numerator,
		denominator,
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
	const numerator1 = firstRational.numerator
	const denominator1 = firstRational.denominator
	const numerator2 = secondRational.numerator
	const denominator2 = secondRational.denominator

	return createRational(
		numerator1 * denominator2 + numerator2 * denominator1,
		denominator1 * denominator2,
	)
}

// NOTE: The Integer-operand overloads do the arithmetic on the raw parts and
// hand the result to `createRational` — nothing may reach a caller without
// passing through the gateway, or an ordering primitive could read a sign off
// a denominator.
export function add__overload$2(
	rational: RationalType,
	integer: IntegerType,
): RationalType {
	const numerator = rational.numerator
	const denominator = rational.denominator

	return createRational(numerator + integer.value * denominator, denominator)
}

// #endregion

// #region Divide

export function divide__overload$1(
	firstRational: RationalType,
	secondRational: RationalType,
): RationalType | NothingType {
	const numerator1 = firstRational.numerator
	const denominator1 = firstRational.denominator
	const numerator2 = secondRational.numerator
	const denominator2 = secondRational.denominator

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
		rational.numerator,
		rational.denominator * integer.value,
	)
}

// #endregion

// #region Multiply

export function multiply__overload$1(
	firstRational: RationalType,
	secondRational: RationalType,
): RationalType {
	const numerator1 = firstRational.numerator
	const denominator1 = firstRational.denominator
	const numerator2 = secondRational.numerator
	const denominator2 = secondRational.denominator

	return createRational(numerator1 * numerator2, denominator1 * denominator2)
}

export function multiply__overload$2(
	rational: RationalType,
	integer: IntegerType,
): RationalType {
	return createRational(
		rational.numerator * integer.value,
		rational.denominator,
	)
}

// #endregion

// #region isLessThan

export function isLessThan__overload$2(
	rational: RationalType,
	integer: IntegerType,
): BooleanType {
	const numerator1 = rational.numerator
	const denominator1 = rational.denominator
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
	const numerator1 = rational.numerator
	const denominator1 = rational.denominator
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
	const numerator1 = rational.numerator
	const denominator1 = rational.denominator
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
	const numerator1 = rational.numerator
	const denominator1 = rational.denominator
	const numerator2 = integer.value
	const denominator2 = 1n

	const rational1 = numerator1 * denominator2
	const rational2 = numerator2 * denominator1

	return createBoolean(rational1 >= rational2)
}

// #endregion

// NOTE: The lowest-terms form with the sign on the numerator — the shape the
// accessors, the rounding family and the formatters read.
function reducedParts(rational: RationalType): BigRational {
	return reduced(rational.numerator, rational.denominator)
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

// NOTE: A deliberate cap, not a technical one: a non-terminating expansion is
// cut after this many fractional digits, with the last kept digit rounded.
const DECIMAL_DIGIT_LIMIT = 80

// NOTE: Long division on the magnitude, sign prefixed afterwards — so the cut
// digit rounds halves away from zero, matching `round`. A terminating
// expansion stops at its last digit, and a whole value prints without a dot,
// so every result is text `Rational.parse` reads back.
function formatAsDecimal(rational: RationalType): string {
	let parts = reducedParts(rational)
	let magnitude = parts.numerator < 0n ? -parts.numerator : parts.numerator

	let wholePart = magnitude / parts.denominator
	let remainder = magnitude % parts.denominator

	let digits: Array<string> = []

	while (remainder !== 0n && digits.length < DECIMAL_DIGIT_LIMIT) {
		remainder = remainder * 10n
		digits.push((remainder / parts.denominator).toString())
		remainder = remainder % parts.denominator
	}

	if (remainder !== 0n && remainder * 2n >= parts.denominator) {
		let index = digits.length - 1

		while (index >= 0 && digits[index] === "9") {
			digits[index] = "0"
			index -= 1
		}

		if (index >= 0) {
			digits[index] = (Number(digits[index]) + 1).toString()
		} else {
			wholePart = wholePart + 1n
		}

		// NOTE: Zeroes the carry walked over are rounding artifacts, not
		// expansion digits — `0.0999…` rounds to `0.1`, not `0.1000…`.
		while (digits.length > 0 && digits[digits.length - 1] === "0") {
			digits.pop()
		}
	}

	let sign = parts.numerator < 0n ? "-" : ""

	if (digits.length === 0) {
		return `${sign}${wholePart}`
	}

	return `${sign}${wholePart}.${digits.join("")}`
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

// NOTE: Same-kind ordering stays native — see the NOTE on `Integer.compare`.
// Cross-multiplication is exact, and denominators are kept positive by
// `createRational`, so the sign of the comparison is the sign of the products.
export function compare(
	originalRational: RationalType,
	otherRational: RationalType,
): OrderingType {
	const lhs = originalRational.numerator * otherRational.denominator
	const rhs = otherRational.numerator * originalRational.denominator

	if (lhs < rhs) {
		return less
	} else if (lhs > rhs) {
		return greater
	} else {
		return equal
	}
}
