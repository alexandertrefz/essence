import type { AlgebraicType, BigRational } from "./Algebraic"
import {
	addRationals,
	bigRationalOf,
	divideRationals,
	multiplyRationals,
	reduced,
	scaledIntervalOf,
	subtractRationals,
} from "./Algebraic"
import type { IntegerType } from "./Integer"
import type { NothingType } from "./Nothing"
import { createNothing } from "./Nothing"
import type { OrderingType } from "./Ordering"
import { equal, greater, less } from "./Ordering"
import type { RationalType } from "./Rational"
import { createRational } from "./Rational"
import type { StringType } from "./String"
import { createString } from "./String"
import { typeKeySymbol } from "./type"

// NOTE: The linear-in-π slice of the transcendentals: every value is
// `rationalPart + piCoefficient·π` with a non-zero piCoefficient, held as
// reduced bigint rationals. Within this grammar equality is canonical-form
// equality — and because π is provably transcendental, a value here can never
// equal an Integer, Rational or Algebraic, which is what keeps every
// cross-kind comparison in `Number` total.
export type TranscendentalType = {
	[typeKeySymbol]: "Transcendental"
	rationalPartNumerator: bigint
	rationalPartDenominator: bigint
	piCoefficientNumerator: bigint
	piCoefficientDenominator: bigint
}

// #region Construction

export function createTranscendental(
	rationalPart: BigRational,
	piCoefficient: BigRational,
): TranscendentalType | RationalType {
	const reducedRationalPart = reduced(
		rationalPart.numerator,
		rationalPart.denominator,
	)
	const reducedPiCoefficient = reduced(
		piCoefficient.numerator,
		piCoefficient.denominator,
	)

	if (reducedPiCoefficient.numerator === 0n) {
		return createRational(
			reducedRationalPart.numerator,
			reducedRationalPart.denominator,
		)
	}

	return {
		[typeKeySymbol]: "Transcendental",
		rationalPartNumerator: reducedRationalPart.numerator,
		rationalPartDenominator: reducedRationalPart.denominator,
		piCoefficientNumerator: reducedPiCoefficient.numerator,
		piCoefficientDenominator: reducedPiCoefficient.denominator,
	}
}

function rationalPartOf(transcendental: TranscendentalType): BigRational {
	return {
		numerator: transcendental.rationalPartNumerator,
		denominator: transcendental.rationalPartDenominator,
	}
}

function piCoefficientOf(transcendental: TranscendentalType): BigRational {
	return {
		numerator: transcendental.piCoefficientNumerator,
		denominator: transcendental.piCoefficientDenominator,
	}
}

// #endregion

// #region π enclosure

// NOTE: floor(π·10^digits) and its successor via Machin's formula,
// π = 16·arctan(1/5) − 4·arctan(1/239), on scaled bigints. A few guard
// digits absorb the truncation of the two series.
function scaledPi(digits: bigint): { low: bigint; high: bigint } {
	const guardDigits = 8n
	const scale = 10n ** (digits + guardDigits)

	function scaledArctanOfReciprocal(x: bigint): bigint {
		let sum = 0n
		let term = scale / x
		let power = x
		let k = 0n

		while (term !== 0n) {
			sum += k % 2n === 0n ? term / (2n * k + 1n) : -term / (2n * k + 1n)
			power = power * x * x
			term = scale / power
			k += 1n
		}

		return sum
	}

	const scaledValue =
		16n * scaledArctanOfReciprocal(5n) - 4n * scaledArctanOfReciprocal(239n)
	const guardScale = 10n ** guardDigits

	return {
		low: scaledValue / guardScale - 1n,
		high: scaledValue / guardScale + 2n,
	}
}

// NOTE: A certified enclosure of the value, scaled by 10^digits.
export function scaledTranscendentalInterval(
	transcendental: TranscendentalType,
	digits: bigint,
): { low: bigint; high: bigint } {
	const scale = 10n ** digits
	const pi = scaledPi(digits)
	const coefficient = piCoefficientOf(transcendental)
	const rationalPart = rationalPartOf(transcendental)

	const candidates = [
		(coefficient.numerator * pi.low) / coefficient.denominator,
		(coefficient.numerator * pi.high) / coefficient.denominator,
	]
	const scaledRationalPart =
		(rationalPart.numerator * scale) / rationalPart.denominator

	return {
		low:
			scaledRationalPart +
			(candidates[0] < candidates[1] ? candidates[0] : candidates[1]) -
			2n,
		high:
			scaledRationalPart +
			(candidates[0] > candidates[1] ? candidates[0] : candidates[1]) +
			2n,
	}
}

// NOTE: The sign of `transcendental − other` for any non-transcendental
// operand. The loop terminates *because* equality is impossible — the two
// values are of provably different kinds, so their enclosures must
// eventually separate.
export function signRelativeTo(
	transcendental: TranscendentalType,
	other: IntegerType | RationalType | AlgebraicType,
): -1n | 1n {
	for (let digits = 8n; ; digits *= 2n) {
		const scale = 10n ** digits
		const enclosure = scaledTranscendentalInterval(transcendental, digits)

		let otherLow: bigint
		let otherHigh: bigint

		if (other[typeKeySymbol] === "Algebraic") {
			const otherEnclosure = scaledIntervalOf(other, digits)
			otherLow = otherEnclosure.low
			otherHigh = otherEnclosure.high
		} else {
			const rational = bigRationalOf(other)
			otherLow = (rational.numerator * scale) / rational.denominator - 1n
			otherHigh = otherLow + 2n
		}

		if (enclosure.high < otherLow) {
			return -1n
		}

		if (enclosure.low > otherHigh) {
			return 1n
		}
	}
}

// #endregion

// #region Methods

// NOTE: Exact within the linear grammar: the difference is again
// `A + B·π`; its sign is B's sign when B ≠ 0 (π-dominance), else A's.
export function compareTranscendentals(
	transcendental: TranscendentalType,
	other: TranscendentalType,
): OrderingType {
	const rationalDifference = subtractRationals(
		rationalPartOf(transcendental),
		rationalPartOf(other),
	)
	const piDifference = subtractRationals(
		piCoefficientOf(transcendental),
		piCoefficientOf(other),
	)

	if (piDifference.numerator === 0n) {
		if (rationalDifference.numerator === 0n) {
			return equal
		}

		return rationalDifference.numerator < 0n ? less : greater
	}

	// NOTE: A + B·π = 0 with B ≠ 0 would make π rational; so the sign is
	// decided by comparing π against the rational −A/B.
	const threshold = divideRationals(
		{
			numerator: -rationalDifference.numerator,
			denominator: rationalDifference.denominator,
		},
		piDifference,
	)
	const piSideSign = signOfPiMinusRational(threshold)

	return (piDifference.numerator > 0n ? piSideSign : -piSideSign) < 0n
		? less
		: greater
}

function signOfPiMinusRational(rational: BigRational): -1n | 1n {
	for (let digits = 8n; ; digits *= 2n) {
		const scale = 10n ** digits
		const pi = scaledPi(digits)
		const scaledRational =
			(rational.numerator * scale) / rational.denominator

		if (pi.high < scaledRational - 1n) {
			return -1n
		}

		if (pi.low > scaledRational + 1n) {
			return 1n
		}
	}
}

export function add(
	transcendental: TranscendentalType,
	other: IntegerType | RationalType,
): TranscendentalType {
	return createTranscendental(
		addRationals(rationalPartOf(transcendental), bigRationalOf(other)),
		piCoefficientOf(transcendental),
	) as TranscendentalType
}

export function multiplyWith(
	transcendental: TranscendentalType,
	other: IntegerType | RationalType,
): TranscendentalType | RationalType {
	const factor = bigRationalOf(other)

	return createTranscendental(
		multiplyRationals(rationalPartOf(transcendental), factor),
		multiplyRationals(piCoefficientOf(transcendental), factor),
	)
}

export function divideBy(
	transcendental: TranscendentalType,
	other: IntegerType | RationalType,
): TranscendentalType | NothingType {
	const divisor = bigRationalOf(other)

	if (divisor.numerator === 0n) {
		return createNothing()
	}

	return createTranscendental(
		divideRationals(rationalPartOf(transcendental), divisor),
		divideRationals(piCoefficientOf(transcendental), divisor),
	) as TranscendentalType
}

// NOTE: `value − transcendental`, for the commuted overloads on Integer and
// Rational — total, since the π-coefficient merely flips sign.
export function subtractedFrom(
	transcendental: TranscendentalType,
	value: IntegerType | RationalType,
): TranscendentalType {
	const coefficient = piCoefficientOf(transcendental)

	return createTranscendental(
		subtractRationals(bigRationalOf(value), rationalPartOf(transcendental)),
		{
			numerator: -coefficient.numerator,
			denominator: coefficient.denominator,
		},
	) as TranscendentalType
}

export function addTranscendental(
	transcendental: TranscendentalType,
	other: TranscendentalType,
): TranscendentalType | RationalType {
	return createTranscendental(
		addRationals(rationalPartOf(transcendental), rationalPartOf(other)),
		addRationals(piCoefficientOf(transcendental), piCoefficientOf(other)),
	)
}

// NOTE: A quotient of two linear-in-π values is representable exactly when
// they are proportional — π/π = 1, TAU/PI = 2, (1 + π)/(2 + 2·π) = 1/2.
// Anything else leaves the grammar and returns Nothing.
export function divideByTranscendental(
	transcendental: TranscendentalType,
	other: TranscendentalType,
): RationalType | NothingType {
	const ratio = divideRationals(
		piCoefficientOf(transcendental),
		piCoefficientOf(other),
	)
	const scaledRationalPart = multiplyRationals(rationalPartOf(other), ratio)
	const isProportional =
		subtractRationals(rationalPartOf(transcendental), scaledRationalPart)
			.numerator === 0n

	if (!isProportional) {
		return createNothing()
	}

	return createRational(ratio.numerator, ratio.denominator)
}

// NOTE: Negation flips both components and keeps the π coefficient non-zero,
// so the result stays a Transcendental without consulting the
// `createTranscendental` gateway.
export function negated(
	transcendental: TranscendentalType,
): TranscendentalType {
	return {
		[typeKeySymbol]: "Transcendental",
		rationalPartNumerator: -transcendental.rationalPartNumerator,
		rationalPartDenominator: transcendental.rationalPartDenominator,
		piCoefficientNumerator: -transcendental.piCoefficientNumerator,
		piCoefficientDenominator: transcendental.piCoefficientDenominator,
	}
}

// #endregion

// #region Printing

function formatRational(rational: BigRational): string {
	if (rational.denominator === 1n) {
		return rational.numerator.toString()
	}

	return `${rational.numerator}/${rational.denominator}`
}

export function toString(transcendental: TranscendentalType): StringType {
	const rationalPart = rationalPartOf(transcendental)
	const coefficient = piCoefficientOf(transcendental)
	const absoluteCoefficient = {
		numerator:
			coefficient.numerator < 0n
				? -coefficient.numerator
				: coefficient.numerator,
		denominator: coefficient.denominator,
	}

	const piText =
		absoluteCoefficient.numerator === 1n &&
		absoluteCoefficient.denominator === 1n
			? "π"
			: `${formatRational(absoluteCoefficient)}·π`

	if (rationalPart.numerator === 0n) {
		return createString(coefficient.numerator < 0n ? `-${piText}` : piText)
	}

	const operator = coefficient.numerator < 0n ? " − " : " + "

	return createString(`${formatRational(rationalPart)}${operator}${piText}`)
}

// #endregion

// #region Overload wrappers

// NOTE: The Rewriter addresses Overloads by index — these bind the generic
// implementations to the Namespace's declared Overload order.
export const add__overload$1 = add
export const add__overload$2 = add
export const add__overload$3 = addTranscendental
export const multiplyWith__overload$1 = multiplyWith
export const multiplyWith__overload$2 = multiplyWith
export const divideBy__overload$1 = divideBy
export const divideBy__overload$2 = divideBy
export const divideBy__overload$3 = divideByTranscendental

// #endregion
