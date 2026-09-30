import type { AlgebraicType } from "./Algebraic"
import {
	decimalExponentOnEnclosure,
	roundedOnDecimalGrid,
	scaledIntervalOf,
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
import type { BooleanType } from "./Boolean"
import { createBoolean } from "./Boolean"
import type { IntegerType } from "./Integer"
import { createInteger } from "./Integer"
import type { OptionalType, ValueType } from "./Optional"
import { createEmpty, createValue } from "./Optional"
import type { OrderingType } from "./Ordering"
import { equal, greater, less } from "./Ordering"
import type { RationalType } from "./Rational"
import { createRational } from "./Rational"
import type { RoundingType } from "./Rounding"
import type { StringType } from "./String"
import { createString } from "./String"
import { typeKeySymbol } from "./type"

// A Transcendental is `rationalPart + Σ coefficient·base` over a registry of
// named constants. See "Transcendental numbers" in DEVELOPMENT.md.

// #region Basis registry

type ScaledEnclosure = (digits: bigint) => { low: bigint; high: bigint }

// An enclosure of π·10^digits, three units wide, from Machin's formula
// π = 16·arctan(1/5) − 4·arctan(1/239). Guard digits absorb the truncation.
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

// An enclosure of e·10^digits, three units wide, from the series e = Σ 1/k!.
// Each term is the previous one divided by the next k.
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

// A base's place in the canonical term order and its enclosure. Every entry
// must be a provably transcendental constant. The order lives in each entry,
// since a Map derived at the top level would keep this module in every bundle.
type Base = { order: number; enclosure: ScaledEnclosure }

const bases = new Map<string, Base>([
	["π", { order: 0, enclosure: scaledPi }],
	["e", { order: 1, enclosure: scaledE }],
])

function baseOf(base: string): Base {
	const entry = bases.get(base)

	if (entry === undefined) {
		throw new Error(`'${base}' is not a registered transcendental base.`)
	}

	return entry
}

function enclosureOf(base: string): ScaledEnclosure {
	return baseOf(base).enclosure
}

function orderOf(base: string): number {
	return baseOf(base).order
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
	// INVARIANT: ordered by the registry, one term per base, no zero
	// coefficient, never empty. `createTranscendental` enforces it.
	terms: Array<TranscendentalTerm>
}

// #region Construction

// The canonical terms of a coefficient list: merged by base, reduced,
// zero-free and in registry order. An unregistered base throws.
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
		.sort((a, b) => orderOf(a.base) - orderOf(b.base))
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

// The depth at which a sign decision over several bases gives up. Deciding
// such a tie would settle an open problem.
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

// The cutoff met while reading digits. Two values never agreed to a depth
// here, so the message names the reading instead.
function throwPrecisionCutoffForReading(reading: string): never {
	throw new Error(
		`${reading} exceeded the precision cutoff of ` +
			`${precisionCutoffDigits} digits. This number combines several ` +
			"transcendental constants, so the reading is decided by refining " +
			"an enclosure, and whether such a value falls exactly on the " +
			"point that would decide it is an open problem in mathematics.",
	)
}

// A certified enclosure of `rationalPart + Σ coefficient·base`, scaled by
// 10^digits. A base's enclosure is computed only when a term carries it.
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

// A certified enclosure of the value, scaled by 10^digits.
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

// The sign of `base − rational`. The loop ends because an irrational base
// never equals the rational, so the enclosures separate.
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

// The sign of `A + B·base` with B ≠ 0, from comparing the base against −A/B.
// Total. See "Deciding a Transcendental's sign" in DEVELOPMENT.md.
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

// The sign of a form over several bases, refined up to the cutoff.
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

// The sign of `transcendental − other`. Against an Algebraic both enclosures
// are refined, and only a value over several bases can reach the cutoff.
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

// Canonical forms are unique, so equality compares the fields. Native because
// this Namespace has no ordering to write equality on.
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

// A Transcendental is never zero, so it is below its negation exactly when it
// is negative. Native because the Namespace is not `Comparable`.
export function absolute(
	transcendental: TranscendentalType,
): TranscendentalType {
	const negated = negate(transcendental)

	return compareTranscendentals(transcendental, negated)[typeKeySymbol] ===
		"Ordering#Less"
		? negated
		: transcendental
}

// `transcendental − other`, again a form in the span, with cancelled terms gone.
function differenceForm(
	transcendental: TranscendentalType,
	other: TranscendentalType,
): { rationalPart: BigRational; terms: Array<TranscendentalTerm> } {
	return {
		rationalPart: subtractRationals(
			rationalPartOf(transcendental),
			rationalPartOf(other),
		),
		terms: canonicalTerms([
			...coefficientsOf(transcendental),
			...scaledCoefficients(other, { numerator: -1n, denominator: 1n }),
		]),
	}
}

function orderingOfRational(rational: BigRational): OrderingType {
	if (rational.numerator === 0n) {
		return equal
	}

	return rational.numerator < 0n ? less : greater
}

export function compareTranscendentals(
	transcendental: TranscendentalType,
	other: TranscendentalType,
): OrderingType {
	const { rationalPart, terms } = differenceForm(transcendental, other)

	if (terms.length === 0) {
		return orderingOfRational(rationalPart)
	}

	return signOfForm(rationalPart, terms) < 0n ? less : greater
}

// The width of `scaledFormInterval` in units of its scale: 4 for the rational
// part, and for each term 4 plus three times its coefficient's ceiling.
function scaledFormWidth(terms: ReadonlyArray<TranscendentalTerm>): bigint {
	let width = 4n

	for (const term of terms) {
		const magnitude =
			term.coefficientNumerator < 0n
				? -term.coefficientNumerator
				: term.coefficientNumerator
		const coefficient =
			(magnitude + term.coefficientDenominator - 1n) /
			term.coefficientDenominator

		width += 3n * coefficient + 4n
	}

	return width
}

// The bounded comparison: the difference is enclosed once, with guard digits
// that make the enclosure narrower than one unit of the last place. It never
// refines. See "Deciding a Transcendental's sign" in DEVELOPMENT.md.
export function compare(
	transcendental: TranscendentalType,
	other: TranscendentalType,
	digits: IntegerType,
): OptionalType<OrderingType> {
	const { rationalPart, terms } = differenceForm(transcendental, other)

	if (terms.length === 0) {
		return createValue(orderingOfRational(rationalPart))
	}

	const guardDigits = BigInt(scaledFormWidth(terms).toString().length)
	const enclosure = scaledFormInterval(
		rationalPart,
		terms,
		BigInt(digits.value) + guardDigits,
	)

	if (enclosure.high < 0n) {
		return createValue(less)
	}

	if (enclosure.low > 0n) {
		return createValue(greater)
	}

	return createEmpty()
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

// `divide` for a divisor proven not zero, which always holds a value.
export function divideByNonZero(
	transcendental: TranscendentalType,
	other: IntegerType | RationalType,
): TranscendentalType {
	return (divide(transcendental, other) as ValueType<TranscendentalType>).item
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

// A quotient is a Rational exactly when the two values are proportional: same
// bases, and every part scaled by one ratio. Anything else, like π/e, is empty.
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

// Negation keeps the terms canonical, so it skips `createTranscendental`.
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

// Native because the Namespace declares no ordering. `isNegative` is this
// negated, in Essence, since a Transcendental is never zero.
export function isPositive(transcendental: TranscendentalType): BooleanType {
	return createBoolean(
		signOfForm(rationalPartOf(transcendental), transcendental.terms) > 0n,
	)
}

// Refines the enclosure until the rounding at `places` is decided. Only a
// value over several bases can reach the cutoff. See "Reading a
// Transcendental's digits" in DEVELOPMENT.md.
function roundedTranscendental(
	transcendental: TranscendentalType,
	places: bigint,
	direction: RoundingType,
): bigint {
	const step = roundedOnDecimalGrid(
		(digits) => scaledTranscendentalInterval(transcendental, digits),
		places,
		direction,
		transcendental.terms.length > 1 ? precisionCutoffDigits : null,
	)

	if (step === null) {
		throwPrecisionCutoffForReading(
			`Reading this number at ${places} decimal places`,
		)
	}

	return step
}

export function round(
	transcendental: TranscendentalType,
	direction: RoundingType,
): IntegerType {
	return createInteger(roundedTranscendental(transcendental, 0n, direction))
}

export function approximate(
	transcendental: TranscendentalType,
	places: IntegerType,
	direction: RoundingType,
): RationalType {
	const width = BigInt(places.value)

	return createRational(
		roundedTranscendental(transcendental, width, direction),
		10n ** width,
	)
}

export function decimalExponent(
	transcendental: TranscendentalType,
): IntegerType {
	const exponent = decimalExponentOnEnclosure(
		(digits) => scaledTranscendentalInterval(transcendental, digits),
		transcendental.terms.length > 1 ? precisionCutoffDigits : null,
	)

	if (exponent === null) {
		throwPrecisionCutoffForReading("Reading this number's power of ten")
	}

	return createInteger(exponent)
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

// The Rewriter addresses Overloads by index, so these bind each entry in the
// Namespace's declared order.
export const add__overload$1 = add
export const add__overload$2 = add
export const add__overload$3 = addTranscendental
export const multiply__overload$1 = multiply
export const multiply__overload$2 = multiply
// A non-zero factor takes no coefficient to zero, so the proven entries answer
// a Transcendental. The arithmetic is the same.
export const multiply__overload$3 = multiply as (
	transcendental: TranscendentalType,
	other: IntegerType,
) => TranscendentalType
export const multiply__overload$4 = multiply as (
	transcendental: TranscendentalType,
	other: RationalType,
) => TranscendentalType
export const divide__overload$1 = divide
export const divide__overload$2 = divide
export const divide__overload$3 = divideByTranscendental
export const divide__overload$7 = divideByNonZero as (
	transcendental: TranscendentalType,
	other: IntegerType,
) => TranscendentalType
export const divide__overload$8 = divideByNonZero as (
	transcendental: TranscendentalType,
	other: RationalType,
) => TranscendentalType

// The other entries of `round` and `toString` are written in Essence.
export const round__overload$1 = round
export const toString__overload$1 = toString

// #endregion
