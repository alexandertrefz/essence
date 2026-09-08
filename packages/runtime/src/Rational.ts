import type { AlgebraicType } from "./Algebraic"
import {
	dividedInto as algebraicDividedInto,
	squareRootOfRational,
} from "./Algebraic"
import type { BigRational } from "./bigRational"
import {
	addRationals,
	bigRationalOf,
	divideRationals,
	multiplyRationals,
	reduced,
	subtractRationals,
} from "./bigRational"
import type { IntegerType } from "./Integer"
import { createInteger } from "./Integer"
import type { NumberFormatType } from "./NumberFormat"
import type { OptionalType, ValueType } from "./Optional"
import { createEmpty, createValue } from "./Optional"
import type { OrderingType } from "./Ordering"
import { equal, greater, less } from "./Ordering"
import type { RoundingType } from "./Rounding"
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

export function of__overload$1(
	numerator: IntegerType,
	denominator: IntegerType,
): OptionalType<RationalType> {
	// NOTE: Zero is in safe range, so the canonical invariant makes it the
	// number `0` — `0n` would answer `false` for the value it looks for.
	if (denominator.value === 0) {
		return createEmpty()
	}

	return createValue(
		createRational(BigInt(numerator.value), BigInt(denominator.value)),
	)
}

// NOTE: The same construction with the zero check taken OUT rather than skipped
// — it was already made. This entry is reached only for a denominator the
// Compiler proved is not zero, so what is left is exactly what the entry above
// does once it has decided the same thing, and there is nothing left to wrap an
// Optional around.
export function of__overload$2(
	numerator: IntegerType,
	denominator: IntegerType,
): RationalType {
	return createRational(BigInt(numerator.value), BigInt(denominator.value))
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

// NOTE: A Rational built FROM parts already in lowest terms — which is what the
// four arithmetic entries below are handed, since the bigint-rational core
// reduces what it answers. The parts are remembered as the read-side view right
// away, so the first accessor, formatter or `raise` to ask pays no
// greatest-common-divisor of its own: the answer is the value it was built
// with.
//
// NOTE: `createRational` is still the gateway, and it changes nothing here —
// `reduced` already puts the sign on the numerator and canonicalises zero as
// `0/1`, which is exactly what it would otherwise do — so what is stored and
// what is remembered are the same two bigints rather than two views that must
// agree.
function createReducedRational(parts: BigRational): RationalType {
	let rational = createRational(
		parts.numerator,
		parts.denominator,
	) as ReducedRational

	rational[reducedPartsKey] = parts

	return rational
}

// #region Arithmetic

// NOTE: The four same-kind operations, each one cross-multiplication and one
// reduction on the parts themselves. The Essence bodies they replace read
// `numerator()` and `denominator()` off both operands — four Integers built
// only to be unwrapped — did the same arithmetic through four more boxes, and
// handed the parts to `Rational.of`, whose answer was UNREDUCED and charged its
// next reader a greatest-common-divisor.
//
// NOTE: Same answers, and a smaller representation of them. `4/2` built by
// `Rational.of` still HOLDS 4 and 2 — nothing here touches what construction
// stores — but a SUM now holds its lowest terms rather than the products the
// cross-multiplication left. Nothing can tell: every accessor and every
// formatter already answered in lowest terms, and equality cross-multiplies the
// raw parts, so `(1/2)::add(1/2)` equals `1` whether it holds `4/4` or `1/1`.
//
// NOTE: Through `reducedParts` rather than `bigRationalOf`, which is the same
// answer off the remembered form — an operand that has been read, printed or
// operated on before reduces once for all of them.
export function add__overload$1(
	rational: RationalType,
	other: RationalType,
): RationalType {
	return createReducedRational(
		addRationals(reducedParts(rational), reducedParts(other)),
	)
}

export function subtract__overload$1(
	rational: RationalType,
	other: RationalType,
): RationalType {
	return createReducedRational(
		subtractRationals(reducedParts(rational), reducedParts(other)),
	)
}

export function multiply__overload$1(
	rational: RationalType,
	other: RationalType,
): RationalType {
	return createReducedRational(
		multiplyRationals(reducedParts(rational), reducedParts(other)),
	)
}

// NOTE: The one entry that can fail, and it answers the same Optional the
// Essence body did: it multiplied with `other::reciprocal()`, which is empty
// for zero, so a zero divisor was the whole of what came back empty. Asked
// outright here — a Rational is zero exactly when its numerator is, in lowest
// terms as in any other.
export function divide__overload$1(
	rational: RationalType,
	other: RationalType,
): OptionalType<RationalType> {
	let divisor = reducedParts(other)

	if (divisor.numerator === 0n) {
		return createEmpty()
	}

	return createValue(
		createReducedRational(divideRationals(reducedParts(rational), divisor)),
	)
}

// NOTE: The same division under the proof its refined entry carries. The
// divisor is a `NonZeroRational` in the source, so the numerator test above can
// not fire and the Optional always holds a value. A read of that value rather
// than a second division: the arithmetic stays in one place.
export function divide__overload$7(
	rational: RationalType,
	other: RationalType,
): RationalType {
	return (divide__overload$1(rational, other) as ValueType<RationalType>).item
}

// #endregion

// #region Everyday methods

// NOTE: Through `createInteger` rather than written out, because the parts are
// bigints and an Integer holding one that fits a double would be a second
// spelling of a value that already has one.
export function numerator(rational: RationalType): IntegerType {
	return createInteger(reducedParts(rational).numerator)
}

export function denominator(rational: RationalType): IntegerType {
	return createInteger(reducedParts(rational).denominator)
}

export function raise__overload$1(
	rational: RationalType,
	exponent: IntegerType,
): OptionalType<RationalType> {
	let power = BigInt(exponent.value)

	if (power >= 0n) {
		return createValue(raise__overload$3(rational, exponent))
	}

	let parts = reducedParts(rational)

	if (parts.numerator === 0n) {
		return createEmpty()
	}

	return createValue(
		createRational(parts.denominator ** -power, parts.numerator ** -power),
	)
}

// NOTE: The exponent of this entry is a `NonNegativeInteger` in the source —
// proven while compiling, erased to an Integer here — so there is no empty arm
// to build and no reciprocal to take. It holds the non-negative power rather
// than reading it back out of the Optional entry, which is the direction
// `Integer`'s two `raise` entries are paired in as well.
export function raise__overload$3(
	rational: RationalType,
	exponent: IntegerType,
): RationalType {
	let parts = reducedParts(rational)
	let power = BigInt(exponent.value)

	return createRational(parts.numerator ** power, parts.denominator ** power)
}

// #endregion

// NOTE: Exported for `getStringRepresentation` in `Terminal.ts` — the
// no-Argument `toString` is written in Essence now, so the universal printer
// renders a Rational off this helper rather than calling a native that no
// longer exists. This is the STRUCTURAL form, and `Terminal.inspect` is the one
// reader that asks for it: a whole Rational shows as `5/1`, because what
// `inspect` shows is what a value IS.
export function formatAsRational(rational: RationalType): string {
	let parts = reducedParts(rational)

	return `${parts.numerator}/${parts.denominator}`
}

// NOTE: The fraction form a CALLER asks for, which is not the structural form
// above: a whole Rational prints its numerator alone, so `5/1` reads as `5`.
// Every `Printable` rendering answers this one, and they have to agree — the
// Essence `toString()` entry beside this one, `toString(as #Fraction)` here,
// the Optimiser's folded interpolation hole (`renderedHole` in
// `foldConstants.ts`), and `Record.toString`, which is why this is exported.
export function formatAsFraction(rational: RationalType): string {
	let parts = reducedParts(rational)

	if (parts.denominator === 1n) {
		return `${parts.numerator}`
	}

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

	// NOTE: A cut that kept only zeroes rounded to the whole part alone — the
	// digits are dropped so the value prints as the whole it rounded to, and
	// the sign goes with them when nothing is left: there is no negative zero.
	if (digits.length > 0 && digits.every((digit) => digit === "0")) {
		digits = []
	}

	let sign =
		parts.numerator < 0n && (wholePart !== 0n || digits.length > 0)
			? "-"
			: ""

	if (digits.length === 0) {
		return `${sign}${wholePart}`
	}

	return `${sign}${wholePart}.${digits.join("")}`
}

// NOTE: The one place a `Rounding` Case decides an answer here, shared by the
// fixed-width formatter and the scientific mantissa. It is asked about the
// MAGNITUDE — `digits` and `remainder` are both non-negative, and the sign is
// prefixed afterwards — so the two directions that name a side of the number
// line read the sign, and the two that name a distance do not. This mirrors the
// Essence `Rational::round(toward:)`, which is written on the floor and takes
// the same four decisions in the same four Cases.
function roundsUpTheMagnitude(
	digits: bigint,
	remainder: bigint,
	denominator: bigint,
	isNegative: boolean,
	direction: RoundingType,
): boolean {
	if (remainder === 0n) {
		return false
	}

	let doubled = remainder * 2n

	switch (direction[typeKeySymbol]) {
		case "Rounding#Down":
			return isNegative
		case "Rounding#Up":
			return !isNegative
		case "Rounding#TowardZero":
			return false
		case "Rounding#NearestEven":
			if (doubled === denominator) {
				return digits % 2n !== 0n
			}

			return doubled > denominator
		default:
			return doubled >= denominator
	}
}

// NOTE: The same long division as `formatAsDecimal`, over a fixed width: the
// magnitude is scaled by a power of ten first, so the quotient IS the digit
// string and the remainder decides the one rounding. The direction decides
// which way that one rounding goes, and `#Nearest` is what a call that names
// none is handed. A width below one rounds to a whole number, the same answer
// `round(toPlaces:)` gives, and no dot is written for it.
//
// NOTE: The sign is prefixed only where something is left of it, so a value
// that rounds to nothing prints `0.00` rather than `-0.00`.
function formatAsFixedDecimal(
	rational: RationalType,
	places: number,
	direction: RoundingType,
): string {
	let parts = reducedParts(rational)
	let isNegative = parts.numerator < 0n
	let magnitude = isNegative ? -parts.numerator : parts.numerator
	let scale = places < 1 ? 1n : 10n ** BigInt(places)
	let scaled = magnitude * scale

	let digits = scaled / parts.denominator
	let remainder = scaled % parts.denominator

	if (
		roundsUpTheMagnitude(
			digits,
			remainder,
			parts.denominator,
			isNegative,
			direction,
		)
	) {
		digits = digits + 1n
	}

	let sign = isNegative && digits !== 0n ? "-" : ""

	if (places < 1) {
		return `${sign}${digits}`
	}

	// NOTE: Padded to one digit more than the width, so that a value below one
	// keeps the `0` in front of its point.
	let text = digits.toString().padStart(places + 1, "0")

	return `${sign}${text.slice(0, text.length - places)}.${text.slice(
		text.length - places,
	)}`
}

// NOTE: A percentage is the same decimal one hundred times over, with a `%`
// after it. The factor goes on the numerator rather than through
// `multiplyRationals`, because a whole number times a fraction needs no
// cross-multiplication and no reduction: `reducedParts` reduces on read.
function scaledByAHundred(rational: RationalType): RationalType {
	let parts = reducedParts(rational)

	return createRational(parts.numerator * 100n, parts.denominator)
}

// NOTE: Whether the magnitude is at or above a power of ten, asked without
// building a decimal expansion: `n / d >= 10^exponent` is a comparison of two
// products, and a negative exponent scales the other side instead of dividing.
function isAtLeastPowerOfTen(
	numerator: bigint,
	denominator: bigint,
	exponent: bigint,
): boolean {
	if (exponent >= 0n) {
		return numerator >= 10n ** exponent * denominator
	}

	return numerator * 10n ** -exponent >= denominator
}

// NOTE: The exponent of the scientific form: the largest power of ten at or
// below the magnitude. The digit counts bracket it within one — a numerator of
// `a` digits over a denominator of `b` is between `10^(a-b-1)` and
// `10^(a-b+1)` — so one comparison settles which of the two it is, whatever the
// size of the parts. Zero has no such power and is written `0e0`, which is what
// the caller of this reads the zero magnitude as.
function decimalExponentOf(numerator: bigint, denominator: bigint): bigint {
	let guess =
		BigInt(numerator.toString().length) -
		BigInt(denominator.toString().length)

	if (isAtLeastPowerOfTen(numerator, denominator, guess)) {
		return guess
	}

	return guess - 1n
}

// NOTE: The receiver divided by a power of ten, which is the mantissa of the
// scientific form.
function shiftedByPowerOfTen(
	rational: RationalType,
	exponent: bigint,
): RationalType {
	let parts = reducedParts(rational)

	if (exponent >= 0n) {
		return createRational(
			parts.numerator,
			parts.denominator * 10n ** exponent,
		)
	}

	return createRational(parts.numerator * 10n ** -exponent, parts.denominator)
}

// NOTE: How many digits stand before the point, sign apart. A mantissa written
// at a fixed width can round UP into the next power of ten — `9.99` at one
// place is `10.0` — and this is what says so, off the text rather than off a
// second exact comparison, because the rounding happened inside the formatter.
function wholeDigitCount(text: string): number {
	let magnitude = text.startsWith("-") ? text.slice(1) : text
	let point = magnitude.indexOf(".")

	return point === -1 ? magnitude.length : point
}

// NOTE: One digit before the point, the rest after it, and the power of ten
// that was taken out written as `e` and a decimal exponent. The exponent takes
// a minus sign and never a plus, so `1.23e3` and `5e-4` are the two shapes, and
// zero is `0e0`. Rounding the mantissa can carry it to ten, and one step of
// renormalisation is enough: ten is the only value a carry can reach.
function formatAsScientific(
	rational: RationalType,
	width: (mantissa: RationalType) => string,
): string {
	let parts = reducedParts(rational)

	if (parts.numerator === 0n) {
		return `${width(rational)}e0`
	}

	let magnitude = parts.numerator < 0n ? -parts.numerator : parts.numerator
	let exponent = decimalExponentOf(magnitude, parts.denominator)
	let text = width(shiftedByPowerOfTen(rational, exponent))

	if (wholeDigitCount(text) > 1) {
		exponent = exponent + 1n
		text = width(shiftedByPowerOfTen(rational, exponent))
	}

	return `${text}e${exponent}`
}

// #region toString

// NOTE: The format arrives as a `NumberFormat` Case rather than a String, so
// there is no unrecognised spelling to fall back from — the four Cases are the
// only four a caller can write.
export function toString__overload$2(
	rational: RationalType,
	format: NumberFormatType,
): StringType {
	let tag = format[typeKeySymbol]

	if (tag === "NumberFormat#Decimal") {
		return createString(formatAsDecimal(rational))
	} else if (tag === "NumberFormat#Percent") {
		return createString(`${formatAsDecimal(scaledByAHundred(rational))}%`)
	} else if (tag === "NumberFormat#Scientific") {
		return createString(formatAsScientific(rational, formatAsDecimal))
	} else {
		return createString(formatAsFraction(rational))
	}
}

// NOTE: The width is meaningless to a fraction — `3/4` has no digits after a
// point to count — so `#Fraction` answers what the entry above answers for it
// and ignores the count and the direction alike, as the declaration says it
// does.
export function toString__overload$3(
	rational: RationalType,
	format: NumberFormatType,
	places: IntegerType,
	direction: RoundingType,
): StringType {
	let tag = format[typeKeySymbol]
	let width = (value: RationalType) =>
		formatAsFixedDecimal(value, Number(places.value), direction)

	if (tag === "NumberFormat#Decimal") {
		return createString(width(rational))
	} else if (tag === "NumberFormat#Percent") {
		return createString(`${width(scaledByAHundred(rational))}%`)
	} else if (tag === "NumberFormat#Scientific") {
		return createString(formatAsScientific(rational, width))
	} else {
		return createString(formatAsFraction(rational))
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

export function squareRoot__overload$1(
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
