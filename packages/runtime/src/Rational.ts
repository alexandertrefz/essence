import type { AlgebraicType } from "./Algebraic"
import {
	dividedInto as algebraicDividedInto,
	squareRootOfRational,
} from "./Algebraic"
import type { BigRational } from "./bigRational"
import { bigRationalOf, reduced } from "./bigRational"
import type { IntegerType } from "./Integer"
import type { NumberFormatType } from "./NumberFormat"
import type { OptionalType } from "./Optional"
import { createEmpty, createValue } from "./Optional"
import type { OrderingType } from "./Ordering"
import { equal, greater, less } from "./Ordering"
import type { StringType } from "./String"
import { createString } from "./String"
import { typeKeySymbol } from "./type"

// NOTE: The parts are held unreduced — a Rational built from 4 and 2 HOLDS 4
// and 2 — and are treated as immutable everywhere; reduction happens on read,
// in `reducedParts`, so that same Rational PRINTS as `2/1`. The two sides matter
// separately: `compare` and `anyIs` cross-multiply the raw parts, which is what
// lets `4/2` be equal to `2` and to `2/1`, while every accessor and every
// formatter answers in lowest terms.
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
): OptionalType<RationalType> {
	if (denominator.value === 0n) {
		return createEmpty()
	}

	return createValue(createRational(numerator.value, denominator.value))
}

// NOTE: The lowest-terms form with the sign on the numerator — the shape the
// accessors, the rounding family and the formatters read. Reducing is a
// greatest-common-divisor over two bigints, and the SAME Rational is asked for
// it over and over: printing one as a decimal asks, `raise` asks, and reading
// its numerator and then its denominator asks twice for one answer. So the
// answer is remembered on the value itself, under a Symbol key.
//
// NOTE: What is stored is untouched by this. A Rational holds its parts exactly
// as it was built with them — `createRational(4n, 2n)` still holds 4 and 2, and
// `compare` and `anyIs` still cross-multiply those raw parts — and this is the
// READ-side view the accessors and the formatters take of them. A Symbol key is
// invisible to `Object.keys` and `Object.entries`, which is the whole of what
// Record equality, the printer and the runtime Type checks read a value with,
// and a Rational is immutable, so a remembered form can never go stale.
//
// NOTE: The remembered `BigRational` IS what is handed back rather than a copy,
// so every caller here only ever READS it.
const reducedPartsKey = Symbol("$reducedParts")

type ReducedRational = RationalType & { [reducedPartsKey]?: BigRational }

function reducedParts(rational: RationalType): BigRational {
	let cached = rational as ReducedRational
	let parts = cached[reducedPartsKey]

	if (parts === undefined) {
		parts = reduced(rational.numerator, rational.denominator)
		cached[reducedPartsKey] = parts
	}

	return parts
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

export function raise(
	rational: RationalType,
	exponent: IntegerType,
): OptionalType<RationalType> {
	let parts = reducedParts(rational)

	if (exponent.value >= 0n) {
		return createValue(
			createRational(
				parts.numerator ** exponent.value,
				parts.denominator ** exponent.value,
			),
		)
	}

	if (parts.numerator === 0n) {
		return createEmpty()
	}

	return createValue(
		createRational(
			parts.denominator ** -exponent.value,
			parts.numerator ** -exponent.value,
		),
	)
}

// #endregion

// NOTE: Exported for `getStringRepresentation` in `functions.ts` — the
// no-Argument `toString` is written in Essence now, so the universal printer
// renders a Rational off this helper rather than calling a native that no
// longer exists.
export function formatAsRational(rational: RationalType): string {
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

export function divide__overload$3(
	rational: RationalType,
	algebraic: AlgebraicType,
): AlgebraicType | RationalType {
	return algebraicDividedInto(algebraic, rational)
}

export function squareRoot(
	rational: RationalType,
): OptionalType<RationalType | AlgebraicType> {
	// NOTE: Handed straight on — `squareRootOfRational` already answers the
	// Optional, so wrapping it here would nest one inside another.
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
