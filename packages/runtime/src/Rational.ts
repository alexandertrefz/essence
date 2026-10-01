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

// The parts are held as built and reduced on read. See "Rational numbers" in
// DEVELOPMENT.md.
export type RationalType = {
	[typeKeySymbol]: "Rational"
	numerator: bigint
	denominator: bigint
}

// INVARIANT: the sign is on the numerator, and zero is `0/1`. Every Rational is
// built here.
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
	// An Integer in safe range holds a number, so zero is `0` and never `0n`.
	if (denominator.value === 0) {
		return createEmpty()
	}

	return createValue(
		createRational(BigInt(numerator.value), BigInt(denominator.value)),
	)
}

// For a denominator proven not zero, so there is no Optional to answer.
export function of__overload$2(
	numerator: IntegerType,
	denominator: IntegerType,
): RationalType {
	return createRational(BigInt(numerator.value), BigInt(denominator.value))
}

// The lowest-terms form the accessors and formatters read, remembered on the
// value under a Symbol key. Callers only read the remembered parts.
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

// A Rational from parts already in lowest terms, remembered as its reduced
// form at once.
function createReducedRational(parts: BigRational): RationalType {
	let rational = createRational(
		parts.numerator,
		parts.denominator,
	) as ReducedRational

	rational[reducedPartsKey] = parts

	return rational
}

// #region Arithmetic

// The arithmetic reads the reduced parts and stores its answer in lowest terms.
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

// Empty for a zero divisor. A Rational is zero exactly when its numerator is.
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

// `divide` for a divisor proven not zero, which always holds a value.
export function divide__overload$7(
	rational: RationalType,
	other: RationalType,
): RationalType {
	return (divide__overload$1(rational, other) as ValueType<RationalType>).item
}

// #endregion

// #region Everyday methods

// Through `createInteger`, which keeps a value that fits a double as a number.
export function numerator(rational: RationalType): IntegerType {
	return createInteger(reducedParts(rational).numerator)
}

export function denominator(rational: RationalType): IntegerType {
	return createInteger(reducedParts(rational).denominator)
}

// Native so that the answer can be declared a `NonNegativeRational`, which an
// Essence body could not prove. A value that is not negative comes back as the
// same object. `NonZeroRational` re-exports this as its own.
export function absolute(rational: RationalType): RationalType {
	return rational.numerator < 0n
		? createRational(-rational.numerator, rational.denominator)
		: rational
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

// For an exponent proven not negative, so there is no reciprocal to take.
export function raise__overload$3(
	rational: RationalType,
	exponent: IntegerType,
): RationalType {
	let parts = reducedParts(rational)
	let power = BigInt(exponent.value)

	return createRational(parts.numerator ** power, parts.denominator ** power)
}

// #endregion

// The structural form `Terminal.inspect` and the test difference show: a
// whole Rational shows as `5/1`.
export function formatAsRational(rational: RationalType): string {
	let parts = reducedParts(rational)

	return `${parts.numerator}/${parts.denominator}`
}

// The fraction form `toString` writes: a whole Rational prints its numerator
// alone. Every `Printable` rendering of a Rational must agree with it,
// including `renderedHole` in the Optimiser.
export function formatAsFraction(rational: RationalType): string {
	let parts = reducedParts(rational)

	if (parts.denominator === 1n) {
		return `${parts.numerator}`
	}

	return `${parts.numerator}/${parts.denominator}`
}

// A chosen cap on the fractional digits of a non-terminating expansion. The
// last kept digit is rounded.
const DECIMAL_DIGIT_LIMIT = 80

// Long division on the magnitude, so a cut rounds halves away from zero as
// `round` does. A whole value prints without a dot, and `Rational.parse` reads
// every result back.
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

		// Zeroes the carry left are not expansion digits: `0.0999…` rounds to `0.1`.
		while (digits.length > 0 && digits[digits.length - 1] === "0") {
			digits.pop()
		}
	}

	// A cut that kept only zeroes prints the whole part alone, and drops the
	// sign when nothing is left, since there is no negative zero.
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

// Whether a `Rounding` rule rounds the magnitude up. Down and Up name a side
// of the number line, so they read the sign; the nearest rules do not.
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

// The long division over a fixed width: the magnitude is scaled first, so the
// quotient is the digit string. A width below one rounds to a whole number.
// The sign is written only where a digit is left, so no `-0.00` appears.
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

	// Padded one past the width, so a value below one keeps its leading `0`.
	let text = digits.toString().padStart(places + 1, "0")

	return `${sign}${text.slice(0, text.length - places)}.${text.slice(
		text.length - places,
	)}`
}

// The value times a hundred. The factor goes on the numerator, since the
// formatter reduces on read.
function scaledByAHundred(rational: RationalType): RationalType {
	let parts = reducedParts(rational)

	return createRational(parts.numerator * 100n, parts.denominator)
}

// Whether `n / d >= 10^exponent`, as a comparison of two products.
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

// The largest power of ten not greater than the magnitude. The digit counts
// put it within one of their difference, and one comparison settles which.
function decimalExponentOf(numerator: bigint, denominator: bigint): bigint {
	let guess =
		BigInt(numerator.toString().length) -
		BigInt(denominator.toString().length)

	if (isAtLeastPowerOfTen(numerator, denominator, guess)) {
		return guess
	}

	return guess - 1n
}

// The receiver divided by a power of ten: the scientific form's mantissa.
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

// The digits before the point. A rounded mantissa can carry into the next
// power of ten, `9.99` at one place being `10.0`, and this detects it.
function wholeDigitCount(text: string): number {
	let magnitude = text.startsWith("-") ? text.slice(1) : text
	let point = magnitude.indexOf(".")

	return point === -1 ? magnitude.length : point
}

// One digit before the point and `e` with the exponent, as `1.23e3`, `5e-4` or
// `0e0`. A carry can only reach ten, so one renormalisation is enough.
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

// Writes the separator between every three digits of the leading digit run,
// counted from the right. The separator is written as given, with no locale.
function groupedWholePart(part: string, separator: string): string {
	let sign = part.startsWith("-") ? "-" : ""
	let rest = sign === "" ? part : part.slice(1)
	let boundary = rest.length

	for (let index = 0; index < rest.length; index++) {
		let character = rest[index]!

		if (character < "0" || character > "9") {
			boundary = index
			break
		}
	}

	let digits = rest.slice(0, boundary)
	let tail = rest.slice(boundary)
	let groups: Array<string> = []

	// Pushed and reversed once, since unshifting each group is quadratic.
	for (let index = digits.length; index > 0; index -= 3) {
		groups.push(digits.slice(index - 3 < 0 ? 0 : index - 3, index))
	}

	groups.reverse()

	return `${sign}${groups.join(separator)}${tail}`
}

function withGrouping(text: string, separator: string): string {
	return text
		.split("/")
		.map((part) => groupedWholePart(part, separator))
		.join("/")
}

// #region toString

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

// A fraction has no digits after a point, so `#Fraction` ignores the width
// and the direction.
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

// The grouped entries are native, since an Essence body would take the text
// apart with `split` and reach all of `List`.
export function toString__overload$4(
	rational: RationalType,
	format: NumberFormatType,
	separator: StringType,
): StringType {
	return createString(
		withGrouping(
			toString__overload$2(rational, format).value,
			separator.value,
		),
	)
}

export function toString__overload$5(
	rational: RationalType,
	format: NumberFormatType,
	places: IntegerType,
	separator: StringType,
	direction: RoundingType,
): StringType {
	return createString(
		withGrouping(
			toString__overload$3(rational, format, places, direction).value,
			separator.value,
		),
	)
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
	return squareRootOfRational(bigRationalOf(rational))
}

// #endregion

// Cross-multiplies the raw parts, which is exact since both denominators are
// positive.
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
