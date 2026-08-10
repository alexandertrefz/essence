import type { AlgebraicType } from "./Algebraic"
import { scaledIntervalOf } from "./Algebraic"
import type { BigRational } from "./bigRational"
import {
	addRationals,
	bigRationalOf,
	divideRationals,
	multiplyRationals,
	reduced,
	subtractRationals,
} from "./bigRational"
import type { BooleanType } from "./Boolean"
import { createBoolean } from "./Boolean"
import type { IntegerType } from "./Integer"
import type { OptionalType } from "./Optional"
import { createEmpty, createValue } from "./Optional"
import type { OrderingType } from "./Ordering"
import { equal, greater, less } from "./Ordering"
import type { RationalType } from "./Rational"
import { createRational } from "./Rational"
import type { StringType } from "./String"
import { createString } from "./String"
import { typeKeySymbol } from "./type"

// NOTE: The linear span of the transcendentals over a registry of named
// constant bases: every value is `rationalPart + Σ coefficient·base` with at
// least one term, held as reduced bigint rationals over canonically-ordered,
// zero-free terms. The basis is DATA — adding a constant is a registry entry
// and an enclosure routine, not a change to the arithmetic. Within this
// grammar equality is canonical-form equality. A value with a SINGLE term can
// never equal an Integer, Rational or Algebraic — each registered base is
// provably transcendental — which keeps those comparisons total. A value
// carrying SEVERAL bases is different: whether such a combination can ever be
// algebraic is an open problem (already for π + e), so the comparisons that
// meet one run an interval refinement that terminates unless the two values
// are equal — conjecturally never (Schanuel) — and give up at a deep,
// documented precision cutoff instead of looping forever.

// #region Basis registry

type ScaledEnclosure = (digits: bigint) => { low: bigint; high: bigint }

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

// NOTE: floor(e·10^digits) and its successor via the factorial series,
// e = Σ 1/k!, on scaled bigints — each term is the previous one divided by
// the next k, so the series needs no factorials of its own. The same guard
// digits absorb the truncation.
function scaledE(digits: bigint): { low: bigint; high: bigint } {
	const guardDigits = 8n
	const scale = 10n ** (digits + guardDigits)

	let sum = 0n
	let term = scale
	let k = 0n

	while (term !== 0n) {
		sum += term
		k += 1n
		term = term / k
	}

	const guardScale = 10n ** guardDigits

	return {
		low: sum / guardScale - 1n,
		high: sum / guardScale + 2n,
	}
}

// NOTE: Everything the rest of this module knows about a base: the symbol a
// term prints under — also its identity in the representation — and a
// certified enclosure of its value. Registration order is canonical term
// order, which is what keeps structural equality a plain walk. Every entry
// must be a PROVABLY transcendental constant: single-term totality rests on
// it, and `createTranscendental` is gated on membership here.
const bases = new Map<string, ScaledEnclosure>([
	["π", scaledPi],
	["e", scaledE],
])

const baseOrder = new Map([...bases.keys()].map((key, index) => [key, index]))

function enclosureOf(base: string): ScaledEnclosure {
	const enclosure = bases.get(base)

	if (enclosure === undefined) {
		throw new Error(`'${base}' is not a registered transcendental base.`)
	}

	return enclosure
}

// #endregion

export type TranscendentalTerm = {
	base: string
	coefficientNumerator: bigint
	coefficientDenominator: bigint
}

export type TranscendentalType = {
	[typeKeySymbol]: "Transcendental"
	rationalPartNumerator: bigint
	rationalPartDenominator: bigint
	// NOTE: Canonically ordered by base registration, free of zero
	// coefficients, at most one term per base, never empty — `createTranscendental`
	// enforces all four, and everything below relies on them.
	terms: Array<TranscendentalTerm>
}

// #region Construction

// NOTE: The canonical term list of a coefficient map: reduced, zero-free,
// in registration order. Shared by the gateway and by the difference forms
// the comparisons build.
function canonicalTerms(
	coefficients: ReadonlyArray<{ base: string; coefficient: BigRational }>,
): Array<TranscendentalTerm> {
	const merged = new Map<string, BigRational>()

	for (const { base, coefficient } of coefficients) {
		enclosureOf(base)

		const running = merged.get(base)

		merged.set(
			base,
			running === undefined
				? coefficient
				: addRationals(running, coefficient),
		)
	}

	return [...merged.entries()]
		.map(([base, coefficient]) => ({
			base,
			coefficient: reduced(
				coefficient.numerator,
				coefficient.denominator,
			),
		}))
		.filter(({ coefficient }) => coefficient.numerator !== 0n)
		.sort((a, b) => baseOrder.get(a.base)! - baseOrder.get(b.base)!)
		.map(({ base, coefficient }) => ({
			base,
			coefficientNumerator: coefficient.numerator,
			coefficientDenominator: coefficient.denominator,
		}))
}

export function createTranscendental(
	rationalPart: BigRational,
	coefficients: ReadonlyArray<{ base: string; coefficient: BigRational }>,
): TranscendentalType | RationalType {
	const reducedRationalPart = reduced(
		rationalPart.numerator,
		rationalPart.denominator,
	)
	const terms = canonicalTerms(coefficients)

	if (terms.length === 0) {
		return createRational(
			reducedRationalPart.numerator,
			reducedRationalPart.denominator,
		)
	}

	return {
		[typeKeySymbol]: "Transcendental",
		rationalPartNumerator: reducedRationalPart.numerator,
		rationalPartDenominator: reducedRationalPart.denominator,
		terms,
	}
}

function rationalPartOf(transcendental: TranscendentalType): BigRational {
	return {
		numerator: transcendental.rationalPartNumerator,
		denominator: transcendental.rationalPartDenominator,
	}
}

function coefficientOf(term: TranscendentalTerm): BigRational {
	return {
		numerator: term.coefficientNumerator,
		denominator: term.coefficientDenominator,
	}
}

function coefficientsOf(
	transcendental: TranscendentalType,
): Array<{ base: string; coefficient: BigRational }> {
	return transcendental.terms.map((term) => ({
		base: term.base,
		coefficient: coefficientOf(term),
	}))
}

function scaledCoefficients(
	transcendental: TranscendentalType,
	factor: BigRational,
): Array<{ base: string; coefficient: BigRational }> {
	return transcendental.terms.map((term) => ({
		base: term.base,
		coefficient: multiplyRationals(coefficientOf(term), factor),
	}))
}

// #endregion

// #region Sign decisions

// NOTE: The refinement depth at which the conjecturally-total comparisons stop.
// Only a comparison whose difference carries SEVERAL bases can reach it —
// deciding such a tie would settle an open problem (is `b·π + c·e` ever
// algebraic?), so past this depth the runtime reports the impasse instead of
// looping forever.
const precisionCutoffDigits = 32768n

function throwPrecisionCutoff(): never {
	throw new Error(
		"Comparing these two numbers exceeded the precision cutoff of " +
			`${precisionCutoffDigits} digits. They combine several ` +
			"transcendental constants, agree to that depth, and deciding " +
			"whether such a pair is exactly equal is an open problem in " +
			"mathematics.",
	)
}

// NOTE: A certified enclosure of `rationalPart + Σ coefficient·base`, scaled
// by 10^digits. Each base's enclosure is computed only when a term carries it.
function scaledFormInterval(
	rationalPart: BigRational,
	terms: ReadonlyArray<TranscendentalTerm>,
	digits: bigint,
): { low: bigint; high: bigint } {
	const scale = 10n ** digits
	const scaledRationalPart =
		(rationalPart.numerator * scale) / rationalPart.denominator

	let low = scaledRationalPart - 2n
	let high = scaledRationalPart + 2n

	for (const term of terms) {
		const enclosure = enclosureOf(term.base)(digits)
		const candidates = [
			(term.coefficientNumerator * enclosure.low) /
				term.coefficientDenominator,
			(term.coefficientNumerator * enclosure.high) /
				term.coefficientDenominator,
		]

		low +=
			(candidates[0] < candidates[1] ? candidates[0] : candidates[1]) - 2n
		high +=
			(candidates[0] > candidates[1] ? candidates[0] : candidates[1]) + 2n
	}

	return { low, high }
}

// NOTE: A certified enclosure of the value, scaled by 10^digits.
export function scaledTranscendentalInterval(
	transcendental: TranscendentalType,
	digits: bigint,
): { low: bigint; high: bigint } {
	return scaledFormInterval(
		rationalPartOf(transcendental),
		transcendental.terms,
		digits,
	)
}

// NOTE: The sign of `base − rational` for a provably irrational base. The loop
// terminates *because* the base can never equal the rational, so the
// enclosures must eventually separate.
function signOfBaseMinusRational(
	base: ScaledEnclosure,
	rational: BigRational,
): -1n | 1n {
	for (let digits = 8n; ; digits *= 2n) {
		const scale = 10n ** digits
		const enclosure = base(digits)
		const scaledRational =
			(rational.numerator * scale) / rational.denominator

		if (enclosure.high < scaledRational - 1n) {
			return -1n
		}

		if (enclosure.low > scaledRational + 1n) {
			return 1n
		}
	}
}

// NOTE: The sign of `A + B·base` with B ≠ 0 — such a value being zero would
// make the base rational, so the sign is decided by comparing the base against
// the rational threshold −A/B. Total, no cutoff needed.
function signOfSingleBaseForm(
	base: ScaledEnclosure,
	rationalPart: BigRational,
	coefficient: BigRational,
): -1n | 1n {
	const threshold = divideRationals(
		{
			numerator: -rationalPart.numerator,
			denominator: rationalPart.denominator,
		},
		coefficient,
	)
	const baseSideSign = signOfBaseMinusRational(base, threshold)

	return coefficient.numerator > 0n
		? baseSideSign
		: (-baseSideSign as -1n | 1n)
}

// NOTE: The sign of a form carrying several bases. Zero here would settle an
// open problem — conjecturally impossible (Schanuel), never witnessed — so
// the refinement runs to the documented cutoff.
function signOfMixedForm(
	rationalPart: BigRational,
	terms: ReadonlyArray<TranscendentalTerm>,
): -1n | 1n {
	for (let digits = 8n; ; digits *= 2n) {
		if (digits > precisionCutoffDigits) {
			throwPrecisionCutoff()
		}

		const enclosure = scaledFormInterval(rationalPart, terms, digits)

		if (enclosure.high < 0n) {
			return -1n
		}

		if (enclosure.low > 0n) {
			return 1n
		}
	}
}

// NOTE: The sign of a non-zero `A + Σ B·base` with at least one term — the
// single-base case is exact and total, only a several-base form runs the
// cutoff refinement.
function signOfForm(
	rationalPart: BigRational,
	terms: ReadonlyArray<TranscendentalTerm>,
): -1n | 1n {
	if (terms.length === 1) {
		const term = terms[0]!

		return signOfSingleBaseForm(
			enclosureOf(term.base),
			rationalPart,
			coefficientOf(term),
		)
	}

	return signOfMixedForm(rationalPart, terms)
}

// NOTE: The sign of `transcendental − other` for any non-transcendental
// operand. Against an Integer or Rational the difference is again a form this
// module can sign directly. Against an Algebraic the loop refines both
// enclosures; it terminates whenever the transcendental carries a single base
// — equality across those kinds is provably impossible — and runs to the
// documented cutoff when it carries several.
export function signRelativeTo(
	transcendental: TranscendentalType,
	other: IntegerType | RationalType | AlgebraicType,
): -1n | 1n {
	if (other[typeKeySymbol] !== "Algebraic") {
		return signOfForm(
			subtractRationals(
				rationalPartOf(transcendental),
				bigRationalOf(other),
			),
			transcendental.terms,
		)
	}

	const mixed = transcendental.terms.length > 1

	for (let digits = 8n; ; digits *= 2n) {
		if (mixed && digits > precisionCutoffDigits) {
			throwPrecisionCutoff()
		}

		const enclosure = scaledTranscendentalInterval(transcendental, digits)
		const otherEnclosure = scaledIntervalOf(other, digits)

		if (enclosure.high < otherEnclosure.low) {
			return -1n
		}

		if (enclosure.low > otherEnclosure.high) {
			return 1n
		}
	}
}

// #endregion

// #region Methods

// NOTE: Canonical-form equality, decided structurally: `createTranscendental`
// reduces, orders and de-zeroes every component, so two values are the same
// number exactly when their rational parts and term lists agree. Native
// because this Namespace has no ordering to write equality on — the Essence
// body it replaces asked the covering `Number`, which put the whole numeric
// tower behind an equality check.
export function is(
	transcendental: TranscendentalType,
	other: TranscendentalType,
): BooleanType {
	return createBoolean(
		transcendental.rationalPartNumerator === other.rationalPartNumerator &&
			transcendental.rationalPartDenominator ===
				other.rationalPartDenominator &&
			transcendental.terms.length === other.terms.length &&
			transcendental.terms.every((term, index) => {
				const otherTerm = other.terms[index]!

				return (
					term.base === otherTerm.base &&
					term.coefficientNumerator ===
						otherTerm.coefficientNumerator &&
					term.coefficientDenominator ===
						otherTerm.coefficientDenominator
				)
			}),
	)
}

// NOTE: A Transcendental is never zero — a single-term `a + b·B = 0` with
// b ≠ 0 would make that base rational, a several-base zero would settle an
// open problem, and a value with no terms is a Rational at construction — so
// it is below its own negation exactly when it is negative, and the comparison
// below decides that with no zero value to build. Native because the sign
// reaches no primitive this Namespace declares: Transcendental deliberately
// does not conform to Comparable, and the Essence body this replaces borrowed
// the covering `Number`'s ordering, dragging the whole numeric tower behind an
// absolute value.
export function absolute(
	transcendental: TranscendentalType,
): TranscendentalType {
	const negated = negate(transcendental)

	return compareTranscendentals(transcendental, negated)[typeKeySymbol] ===
		"Ordering#Less"
		? negated
		: transcendental
}

// NOTE: The difference of two values is again a form in the span; its sign is
// decided by `signOfForm` — exactly for single-base differences, through the
// cutoff refinement for several-base ones.
export function compareTranscendentals(
	transcendental: TranscendentalType,
	other: TranscendentalType,
): OrderingType {
	const rationalDifference = subtractRationals(
		rationalPartOf(transcendental),
		rationalPartOf(other),
	)
	const differenceTerms = canonicalTerms([
		...coefficientsOf(transcendental),
		...scaledCoefficients(other, { numerator: -1n, denominator: 1n }),
	])

	if (differenceTerms.length === 0) {
		if (rationalDifference.numerator === 0n) {
			return equal
		}

		return rationalDifference.numerator < 0n ? less : greater
	}

	return signOfForm(rationalDifference, differenceTerms) < 0n ? less : greater
}

export function add(
	transcendental: TranscendentalType,
	other: IntegerType | RationalType,
): TranscendentalType {
	return createTranscendental(
		addRationals(rationalPartOf(transcendental), bigRationalOf(other)),
		coefficientsOf(transcendental),
	) as TranscendentalType
}

export function multiply(
	transcendental: TranscendentalType,
	other: IntegerType | RationalType,
): TranscendentalType | RationalType {
	const factor = bigRationalOf(other)

	return createTranscendental(
		multiplyRationals(rationalPartOf(transcendental), factor),
		scaledCoefficients(transcendental, factor),
	)
}

export function divide(
	transcendental: TranscendentalType,
	other: IntegerType | RationalType,
): OptionalType<TranscendentalType> {
	const divisor = bigRationalOf(other)

	if (divisor.numerator === 0n) {
		return createEmpty()
	}

	const reciprocal = {
		numerator: divisor.denominator,
		denominator: divisor.numerator,
	}

	return createValue(
		createTranscendental(
			divideRationals(rationalPartOf(transcendental), divisor),
			scaledCoefficients(transcendental, reciprocal),
		) as TranscendentalType,
	)
}

export function addTranscendental(
	transcendental: TranscendentalType,
	other: TranscendentalType,
): TranscendentalType | RationalType {
	return createTranscendental(
		addRationals(rationalPartOf(transcendental), rationalPartOf(other)),
		[...coefficientsOf(transcendental), ...coefficientsOf(other)],
	)
}

// NOTE: A quotient of two values in the span is representable exactly when
// they are proportional — π/π = 1, Tau/Pi = 2, (1 + π)/(2 + 2·π) = 1/2 — and
// proportionality is componentwise: the term lists must carry the same bases,
// every part must scale by the same ratio, read off the divisor's first term.
// Anything else — π/e most famously — leaves the grammar and comes back empty.
export function divideByTranscendental(
	transcendental: TranscendentalType,
	other: TranscendentalType,
): OptionalType<RationalType> {
	if (transcendental.terms.length !== other.terms.length) {
		return createEmpty()
	}

	const ratio = divideRationals(
		coefficientOf(transcendental.terms[0]!),
		coefficientOf(other.terms[0]!),
	)

	const componentPairs: Array<[BigRational, BigRational]> = [
		[rationalPartOf(transcendental), rationalPartOf(other)],
		...transcendental.terms.map(
			(term, index): [BigRational, BigRational] => [
				coefficientOf(term),
				coefficientOf(other.terms[index]!),
			],
		),
	]

	const sameBases = transcendental.terms.every(
		(term, index) => term.base === other.terms[index]!.base,
	)
	const isProportional =
		sameBases &&
		componentPairs.every(
			([component, otherComponent]) =>
				subtractRationals(
					component,
					multiplyRationals(otherComponent, ratio),
				).numerator === 0n,
		)

	if (!isProportional) {
		return createEmpty()
	}

	return createValue(createRational(ratio.numerator, ratio.denominator))
}

// NOTE: Negation flips the rational part and every term, and cannot create a
// zero coefficient or disturb the canonical order, so the result stays a
// Transcendental without consulting the `createTranscendental` gateway.
export function negate(transcendental: TranscendentalType): TranscendentalType {
	return {
		[typeKeySymbol]: "Transcendental",
		rationalPartNumerator: -transcendental.rationalPartNumerator,
		rationalPartDenominator: transcendental.rationalPartDenominator,
		terms: transcendental.terms.map((term) => ({
			base: term.base,
			coefficientNumerator: -term.coefficientNumerator,
			coefficientDenominator: term.coefficientDenominator,
		})),
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

	let text = rationalPart.numerator === 0n ? "" : formatRational(rationalPart)

	for (const term of transcendental.terms) {
		const absoluteCoefficient = {
			numerator:
				term.coefficientNumerator < 0n
					? -term.coefficientNumerator
					: term.coefficientNumerator,
			denominator: term.coefficientDenominator,
		}
		const termText =
			absoluteCoefficient.numerator === 1n &&
			absoluteCoefficient.denominator === 1n
				? term.base
				: `${formatRational(absoluteCoefficient)}·${term.base}`

		if (text === "") {
			text = term.coefficientNumerator < 0n ? `-${termText}` : termText
		} else {
			text +=
				term.coefficientNumerator < 0n
					? ` − ${termText}`
					: ` + ${termText}`
		}
	}

	return createString(text)
}

// #endregion

// #region Overload wrappers

// NOTE: The Rewriter addresses Overloads by index — these bind the generic
// implementations to the Namespace's declared Overload order.
export const add__overload$1 = add
export const add__overload$2 = add
export const add__overload$3 = addTranscendental
export const multiply__overload$1 = multiply
export const multiply__overload$2 = multiply
export const divide__overload$1 = divide
export const divide__overload$2 = divide
export const divide__overload$3 = divideByTranscendental

// #endregion
