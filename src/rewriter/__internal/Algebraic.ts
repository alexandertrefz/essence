import type { BooleanType } from "./Boolean"
import { createBoolean } from "./Boolean"
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

// NOTE: The quadratic slice of the real algebraic irrationals: every value is
// `rationalPart + radicalCoefficient·√radicand`, held exactly as reduced
// bigint rationals. Invariants: the radicand is squarefree and at least 2,
// and the radicalCoefficient is never zero — a value that would break either
// is returned as a Rational instead, so an Algebraic is irrational by
// construction.
export type AlgebraicType = {
	[typeKeySymbol]: "Algebraic"
	rationalPartNumerator: bigint
	rationalPartDenominator: bigint
	radicalCoefficientNumerator: bigint
	radicalCoefficientDenominator: bigint
	radicand: bigint
}

// #region Exact bigint-rational helpers

export type BigRational = { numerator: bigint; denominator: bigint }

function greatestCommonDivisor(first: bigint, second: bigint): bigint {
	let a = first < 0n ? -first : first
	let b = second < 0n ? -second : second

	while (b !== 0n) {
		;[a, b] = [b, a % b]
	}

	return a
}

export function reduced(numerator: bigint, denominator: bigint): BigRational {
	if (denominator < 0n) {
		numerator = -numerator
		denominator = -denominator
	}

	const divisor = greatestCommonDivisor(numerator, denominator)

	if (divisor === 0n) {
		return { numerator: 0n, denominator: 1n }
	}

	return {
		numerator: numerator / divisor,
		denominator: denominator / divisor,
	}
}

export function addRationals(
	first: BigRational,
	second: BigRational,
): BigRational {
	return reduced(
		first.numerator * second.denominator +
			second.numerator * first.denominator,
		first.denominator * second.denominator,
	)
}

export function subtractRationals(
	first: BigRational,
	second: BigRational,
): BigRational {
	return addRationals(first, {
		numerator: -second.numerator,
		denominator: second.denominator,
	})
}

export function multiplyRationals(
	first: BigRational,
	second: BigRational,
): BigRational {
	return reduced(
		first.numerator * second.numerator,
		first.denominator * second.denominator,
	)
}

export function divideRationals(
	first: BigRational,
	second: BigRational,
): BigRational {
	return reduced(
		first.numerator * second.denominator,
		first.denominator * second.numerator,
	)
}

function rationalSign(rational: BigRational): -1n | 0n | 1n {
	if (rational.numerator === 0n) {
		return 0n
	}

	return rational.numerator < 0n ? -1n : 1n
}

function rationalsAreEqual(first: BigRational, second: BigRational): boolean {
	return (
		first.numerator === second.numerator &&
		first.denominator === second.denominator
	)
}

export function bigRationalOf(value: IntegerType | RationalType): BigRational {
	if (value[typeKeySymbol] === "Integer") {
		return { numerator: value.value, denominator: 1n }
	}

	return reduced(value.rational.numerator, value.rational.denominator)
}

function rationalValueOf(rational: BigRational): RationalType {
	return createRational(rational.numerator, rational.denominator)
}

// #endregion

// #region Construction & normalization

// NOTE: Splits a positive integer into `square² · squarefree`, so that
// `√radicand` can be normalized (√12 → 2·√3). Trial division — fine for the
// sizes real programs produce.
function extractSquarePart(radicand: bigint): {
	square: bigint
	squarefree: bigint
} {
	let square = 1n
	let squarefree = radicand

	for (let factor = 2n; factor * factor <= squarefree; factor++) {
		const factorSquared = factor * factor

		while (squarefree % factorSquared === 0n) {
			squarefree = squarefree / factorSquared
			square = square * factor
		}
	}

	return { square, squarefree }
}

// NOTE: The single gateway every operation funnels through — it enforces the
// invariants, which is what makes an Algebraic provably irrational and its
// equality decidable by plain structural comparison.
export function createAlgebraic(
	rationalPart: BigRational,
	radicalCoefficient: BigRational,
	radicand: bigint,
): AlgebraicType | RationalType {
	if (radicand < 0n) {
		throw new Error("An Algebraic can not hold the root of a negative.")
	}

	const { square, squarefree } = extractSquarePart(radicand)
	const coefficient = multiplyRationals(radicalCoefficient, {
		numerator: square,
		denominator: 1n,
	})

	if (squarefree === 1n || coefficient.numerator === 0n) {
		// NOTE: The radical collapsed — the value is rational after all.
		return rationalValueOf(
			addRationals(
				rationalPart,
				squarefree === 1n
					? coefficient
					: { numerator: 0n, denominator: 1n },
			),
		)
	}

	return {
		[typeKeySymbol]: "Algebraic",
		rationalPartNumerator: rationalPart.numerator,
		rationalPartDenominator: rationalPart.denominator,
		radicalCoefficientNumerator: coefficient.numerator,
		radicalCoefficientDenominator: coefficient.denominator,
		radicand: squarefree,
	}
}

function rationalPartOf(algebraic: AlgebraicType): BigRational {
	return {
		numerator: algebraic.rationalPartNumerator,
		denominator: algebraic.rationalPartDenominator,
	}
}

function radicalCoefficientOf(algebraic: AlgebraicType): BigRational {
	return {
		numerator: algebraic.radicalCoefficientNumerator,
		denominator: algebraic.radicalCoefficientDenominator,
	}
}

// NOTE: The exact square root of a non-negative rational, staying in the
// quadratic slice: √(p/q) = √(p·q)/q. Returns an Integer-free Rational when
// the root is exact and an Algebraic otherwise.
export function squareRootOfRational(
	value: BigRational,
): AlgebraicType | RationalType | NothingType {
	if (value.numerator < 0n) {
		return createNothing()
	}

	return createAlgebraic(
		{ numerator: 0n, denominator: 1n },
		{ numerator: 1n, denominator: value.denominator },
		value.numerator * value.denominator,
	)
}

// #endregion

// #region Exact sign determination

// NOTE: The exact sign of `a + b·√d` — decidable because comparing `a²`
// against `b²·d` settles which side dominates. This, plus normalization, is
// the entire reason Algebraic keeps every guarantee: no approximation is ever
// consulted.
export function signOfLinearRadical(
	rationalPart: BigRational,
	radicalCoefficient: BigRational,
	radicand: bigint,
): -1n | 0n | 1n {
	const rationalSignValue = rationalSign(rationalPart)
	const radicalSignValue = rationalSign(radicalCoefficient)

	if (radicalSignValue === 0n) {
		return rationalSignValue
	}

	if (rationalSignValue === 0n) {
		return radicalSignValue
	}

	if (rationalSignValue === radicalSignValue) {
		return rationalSignValue
	}

	// NOTE: Opposite signs — compare |a|² with |b|²·d; the larger term wins.
	const rationalSquared = multiplyRationals(rationalPart, rationalPart)
	const radicalSquared = multiplyRationals(
		multiplyRationals(radicalCoefficient, radicalCoefficient),
		{ numerator: radicand, denominator: 1n },
	)
	const difference = subtractRationals(rationalSquared, radicalSquared)
	const differenceSign = rationalSign(difference)

	if (differenceSign === 0n) {
		// NOTE: |a| = |b|·√d would make √d rational — impossible for a
		// squarefree radicand ≥ 2.
		throw new Error("An Algebraic invariant was violated.")
	}

	return differenceSign > 0n ? rationalSignValue : radicalSignValue
}

// NOTE: The exact sign of `a + b·√d − c·√e` with distinct squarefree radicands
// — needed to compare two Algebraics over different radicals. One careful
// squaring reduces it to the single-radical case.
function signOfTwoRadicalDifference(
	rationalPart: BigRational,
	radicalCoefficient: BigRational,
	radicand: bigint,
	otherRadicalCoefficient: BigRational,
	otherRadicand: bigint,
): -1n | 0n | 1n {
	const leftSign = signOfLinearRadical(
		rationalPart,
		radicalCoefficient,
		radicand,
	)
	const rightSign = rationalSign(otherRadicalCoefficient)

	if (rightSign === 0n) {
		return leftSign
	}

	if (leftSign === 0n) {
		return -rightSign as -1n | 1n
	}

	if (leftSign !== rightSign) {
		return leftSign
	}

	// NOTE: Same sign on both sides — compare (a + b·√d)² against (c·√e)²,
	// which is again of the form A + B·√d versus a rational.
	const squaredRationalPart = addRationals(
		multiplyRationals(rationalPart, rationalPart),
		multiplyRationals(
			multiplyRationals(radicalCoefficient, radicalCoefficient),
			{ numerator: radicand, denominator: 1n },
		),
	)
	const squaredRadicalCoefficient = multiplyRationals(
		multiplyRationals(rationalPart, radicalCoefficient),
		{ numerator: 2n, denominator: 1n },
	)
	const rightSquared = multiplyRationals(
		multiplyRationals(otherRadicalCoefficient, otherRadicalCoefficient),
		{ numerator: otherRadicand, denominator: 1n },
	)
	const comparisonSign = signOfLinearRadical(
		subtractRationals(squaredRationalPart, rightSquared),
		squaredRadicalCoefficient,
		radicand,
	)

	return (leftSign * comparisonSign) as -1n | 0n | 1n
}

// NOTE: The exact sign of `first − second` for any mix of the quadratic
// slice's values.
export function signOfDifference(
	first: AlgebraicType,
	second: AlgebraicType | IntegerType | RationalType,
): -1n | 0n | 1n {
	if (second[typeKeySymbol] !== "Algebraic") {
		return signOfLinearRadical(
			subtractRationals(rationalPartOf(first), bigRationalOf(second)),
			radicalCoefficientOf(first),
			first.radicand,
		)
	}

	const rationalPart = subtractRationals(
		rationalPartOf(first),
		rationalPartOf(second),
	)

	if (first.radicand === second.radicand) {
		return signOfLinearRadical(
			rationalPart,
			subtractRationals(
				radicalCoefficientOf(first),
				radicalCoefficientOf(second),
			),
			first.radicand,
		)
	}

	return signOfTwoRadicalDifference(
		rationalPart,
		radicalCoefficientOf(first),
		first.radicand,
		radicalCoefficientOf(second),
		second.radicand,
	)
}

function orderingOfSign(sign: -1n | 0n | 1n): OrderingType {
	if (sign < 0n) {
		return less
	} else if (sign === 0n) {
		return equal
	} else {
		return greater
	}
}

// #endregion

// #region Interval evaluation

// NOTE: A certified enclosure of the value, scaled by 10^digits — used only
// when an Algebraic must be compared against a Transcendental, where interval
// refinement is the terminating procedure.
export function scaledIntervalOf(
	algebraic: AlgebraicType,
	digits: bigint,
): { low: bigint; high: bigint } {
	const scale = 10n ** digits

	// NOTE: floor(√(radicand · scale²)) by Newton's method on bigints.
	const target = algebraic.radicand * scale * scale
	let estimate = target
	let next = (estimate + 1n) / 2n

	while (next < estimate) {
		estimate = next
		next = (estimate + target / estimate) / 2n
	}

	const radicalLow = estimate
	const radicalHigh = estimate + 1n

	const coefficient = radicalCoefficientOf(algebraic)
	const scaledCoefficientTimesRadical = (candidate: bigint): bigint =>
		(coefficient.numerator * candidate) / coefficient.denominator

	const candidates = [
		scaledCoefficientTimesRadical(radicalLow),
		scaledCoefficientTimesRadical(radicalHigh),
	]
	const rationalPart = rationalPartOf(algebraic)
	const scaledRationalPart =
		(rationalPart.numerator * scale) / rationalPart.denominator

	const low =
		scaledRationalPart +
		(candidates[0] < candidates[1] ? candidates[0] : candidates[1]) -
		2n
	const high =
		scaledRationalPart +
		(candidates[0] > candidates[1] ? candidates[0] : candidates[1]) +
		2n

	return { low, high }
}

// #endregion

// #region Methods

export function is(
	algebraic: AlgebraicType,
	other: AlgebraicType,
): BooleanType {
	// NOTE: Normal forms make numeric equality a structural check.
	return createBoolean(
		algebraic.radicand === other.radicand &&
			rationalsAreEqual(
				rationalPartOf(algebraic),
				rationalPartOf(other),
			) &&
			rationalsAreEqual(
				radicalCoefficientOf(algebraic),
				radicalCoefficientOf(other),
			),
	)
}

export function isNot(
	algebraic: AlgebraicType,
	other: AlgebraicType,
): BooleanType {
	return createBoolean(!is(algebraic, other).value)
}

export function compareTo(
	algebraic: AlgebraicType,
	other: AlgebraicType | IntegerType | RationalType,
): OrderingType {
	return orderingOfSign(signOfDifference(algebraic, other))
}

export function add(
	algebraic: AlgebraicType,
	other: IntegerType | RationalType,
): AlgebraicType {
	// NOTE: Adding a rational moves the rational part and can never collapse
	// the radical — the result is total.
	return createAlgebraic(
		addRationals(rationalPartOf(algebraic), bigRationalOf(other)),
		radicalCoefficientOf(algebraic),
		algebraic.radicand,
	) as AlgebraicType
}

export function subtract(
	algebraic: AlgebraicType,
	other: IntegerType | RationalType,
): AlgebraicType {
	return createAlgebraic(
		subtractRationals(rationalPartOf(algebraic), bigRationalOf(other)),
		radicalCoefficientOf(algebraic),
		algebraic.radicand,
	) as AlgebraicType
}

export function multiplyWith(
	algebraic: AlgebraicType,
	other: IntegerType | RationalType,
): AlgebraicType | RationalType {
	const factor = bigRationalOf(other)

	return createAlgebraic(
		multiplyRationals(rationalPartOf(algebraic), factor),
		multiplyRationals(radicalCoefficientOf(algebraic), factor),
		algebraic.radicand,
	)
}

export function divideBy(
	algebraic: AlgebraicType,
	other: IntegerType | RationalType,
): AlgebraicType | NothingType {
	const divisor = bigRationalOf(other)

	if (divisor.numerator === 0n) {
		return createNothing()
	}

	return createAlgebraic(
		divideRationals(rationalPartOf(algebraic), divisor),
		divideRationals(radicalCoefficientOf(algebraic), divisor),
		algebraic.radicand,
	) as AlgebraicType
}

// NOTE: Same-radicand arithmetic stays inside the slice (and may collapse to
// a Rational — √2·√2 = 2); different radicands generally do not — those
// return Nothing until the general algebraic representation exists.
export function addAlgebraic(
	algebraic: AlgebraicType,
	other: AlgebraicType,
): AlgebraicType | RationalType | NothingType {
	if (algebraic.radicand !== other.radicand) {
		return createNothing()
	}

	return createAlgebraic(
		addRationals(rationalPartOf(algebraic), rationalPartOf(other)),
		addRationals(
			radicalCoefficientOf(algebraic),
			radicalCoefficientOf(other),
		),
		algebraic.radicand,
	)
}

export function subtractAlgebraic(
	algebraic: AlgebraicType,
	other: AlgebraicType,
): AlgebraicType | RationalType | NothingType {
	if (algebraic.radicand !== other.radicand) {
		return createNothing()
	}

	return createAlgebraic(
		subtractRationals(rationalPartOf(algebraic), rationalPartOf(other)),
		subtractRationals(
			radicalCoefficientOf(algebraic),
			radicalCoefficientOf(other),
		),
		algebraic.radicand,
	)
}

export function multiplyWithAlgebraic(
	algebraic: AlgebraicType,
	other: AlgebraicType,
): AlgebraicType | RationalType | NothingType {
	const firstRational = rationalPartOf(algebraic)
	const firstRadical = radicalCoefficientOf(algebraic)
	const secondRational = rationalPartOf(other)
	const secondRadical = radicalCoefficientOf(other)

	if (algebraic.radicand === other.radicand) {
		// NOTE: (a + b·√d)(a' + b'·√d) = aa' + bb'·d + (ab' + a'b)·√d.
		return createAlgebraic(
			addRationals(
				multiplyRationals(firstRational, secondRational),
				multiplyRationals(
					multiplyRationals(firstRadical, secondRadical),
					{
						numerator: algebraic.radicand,
						denominator: 1n,
					},
				),
			),
			addRationals(
				multiplyRationals(firstRational, secondRadical),
				multiplyRationals(secondRational, firstRadical),
			),
			algebraic.radicand,
		)
	}

	// NOTE: Across radicands only pure radicals stay quadratic:
	// b·√d · b'·√e = bb'·√(d·e).
	if (firstRational.numerator === 0n && secondRational.numerator === 0n) {
		return createAlgebraic(
			{ numerator: 0n, denominator: 1n },
			multiplyRationals(firstRadical, secondRadical),
			algebraic.radicand * other.radicand,
		)
	}

	return createNothing()
}

export function divideByAlgebraic(
	algebraic: AlgebraicType,
	other: AlgebraicType,
): AlgebraicType | RationalType | NothingType {
	const reciprocal = reciprocalOf(other)

	if (reciprocal[typeKeySymbol] === "Algebraic") {
		return multiplyWithAlgebraic(algebraic, reciprocal)
	}

	// NOTE: A reciprocal can not itself collapse — the inverse of an
	// irrational is irrational — so this branch is unreachable; it exists for
	// the type system.
	return createNothing()
}

// NOTE: `value − algebraic`, for the commuted overloads on Integer and
// Rational — total, since subtracting a rational can not collapse the radical.
export function subtractedFrom(
	algebraic: AlgebraicType,
	value: IntegerType | RationalType,
): AlgebraicType {
	const coefficient = radicalCoefficientOf(algebraic)

	return createAlgebraic(
		subtractRationals(bigRationalOf(value), rationalPartOf(algebraic)),
		{
			numerator: -coefficient.numerator,
			denominator: coefficient.denominator,
		},
		algebraic.radicand,
	) as AlgebraicType
}

// NOTE: `value ÷ algebraic`, for the commuted overloads on Integer and
// Rational — total, because an Algebraic is never zero. This is the
// "dividing by an Irrational can not fail" guarantee, in code.
export function dividedInto(
	algebraic: AlgebraicType,
	value: IntegerType | RationalType,
): AlgebraicType | RationalType {
	const reciprocal = reciprocalOf(algebraic)

	if (reciprocal[typeKeySymbol] === "Algebraic") {
		return multiplyWith(reciprocal, value)
	}

	// NOTE: Unreachable — the reciprocal of an irrational is irrational — but
	// the type system can not know that.
	return reciprocal
}

// NOTE: 1/(a + b·√d) = (a − b·√d)/(a² − b²·d) — the conjugate trick. The
// denominator can not be zero (that would make √d rational), which is exactly
// the "dividing by an Algebraic never fails" guarantee.
export function reciprocalOf(
	algebraic: AlgebraicType,
): AlgebraicType | RationalType {
	const rationalPart = rationalPartOf(algebraic)
	const radicalCoefficient = radicalCoefficientOf(algebraic)
	const conjugateNorm = subtractRationals(
		multiplyRationals(rationalPart, rationalPart),
		multiplyRationals(
			multiplyRationals(radicalCoefficient, radicalCoefficient),
			{ numerator: algebraic.radicand, denominator: 1n },
		),
	)

	return createAlgebraic(
		divideRationals(rationalPart, conjugateNorm),
		divideRationals(
			{
				numerator: -radicalCoefficient.numerator,
				denominator: radicalCoefficient.denominator,
			},
			conjugateNorm,
		),
		algebraic.radicand,
	)
}

// NOTE: Negation flips both components and touches neither invariant — the
// radicand stays squarefree and the coefficient stays non-zero, so the result
// is an Algebraic without consulting the `createAlgebraic` gateway.
export function negated(algebraic: AlgebraicType): AlgebraicType {
	return {
		[typeKeySymbol]: "Algebraic",
		rationalPartNumerator: -algebraic.rationalPartNumerator,
		rationalPartDenominator: algebraic.rationalPartDenominator,
		radicalCoefficientNumerator: -algebraic.radicalCoefficientNumerator,
		radicalCoefficientDenominator: algebraic.radicalCoefficientDenominator,
		radicand: algebraic.radicand,
	}
}

export function absolute(algebraic: AlgebraicType): AlgebraicType {
	// NOTE: The sign is exactly decidable, and never zero — an Algebraic is
	// irrational by construction.
	const sign = signOfLinearRadical(
		rationalPartOf(algebraic),
		radicalCoefficientOf(algebraic),
		algebraic.radicand,
	)

	return sign < 0n ? negated(algebraic) : algebraic
}

// #endregion

// #region Printing

function formatRational(rational: BigRational): string {
	if (rational.denominator === 1n) {
		return rational.numerator.toString()
	}

	return `${rational.numerator}/${rational.denominator}`
}

export function toString(algebraic: AlgebraicType): StringType {
	const rationalPart = rationalPartOf(algebraic)
	const coefficient = radicalCoefficientOf(algebraic)
	const absoluteCoefficient = {
		numerator:
			coefficient.numerator < 0n
				? -coefficient.numerator
				: coefficient.numerator,
		denominator: coefficient.denominator,
	}

	const radicalText =
		absoluteCoefficient.numerator === 1n &&
		absoluteCoefficient.denominator === 1n
			? `√${algebraic.radicand}`
			: `${formatRational(absoluteCoefficient)}·√${algebraic.radicand}`

	if (rationalPart.numerator === 0n) {
		return createString(
			coefficient.numerator < 0n ? `-${radicalText}` : radicalText,
		)
	}

	const operator = coefficient.numerator < 0n ? " − " : " + "

	return createString(
		`${formatRational(rationalPart)}${operator}${radicalText}`,
	)
}

// #endregion

// #region Overload wrappers

// NOTE: The Rewriter addresses Overloads by index — these bind the generic
// implementations to the Namespace's declared Overload order.
export const add__overload$1 = add
export const add__overload$2 = add
export const add__overload$3 = addAlgebraic
export const subtract__overload$1 = subtract
export const subtract__overload$2 = subtract
export const subtract__overload$3 = subtractAlgebraic
export const multiplyWith__overload$1 = multiplyWith
export const multiplyWith__overload$2 = multiplyWith
export const multiplyWith__overload$3 = multiplyWithAlgebraic
export const divideBy__overload$1 = divideBy
export const divideBy__overload$2 = divideBy
export const divideBy__overload$3 = divideByAlgebraic

// #endregion
