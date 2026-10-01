import type { BigRational } from "./bigRational"
import {
	addRationals,
	bigRationalOf,
	divideRationals,
	multiplyRationals,
	rationalSign,
	subtractRationals,
} from "./bigRational"
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

// `rationalPart + radicalCoefficient·√radicand`, irrational by construction.
// See "Algebraic numbers" in DEVELOPMENT.md.
export type AlgebraicType = {
	[typeKeySymbol]: "Algebraic"
	rationalPartNumerator: bigint
	rationalPartDenominator: bigint
	radicalCoefficientNumerator: bigint
	radicalCoefficientDenominator: bigint
	radicand: bigint
}

// Here rather than in `bigRational.ts`, which must not import `Rational.ts`.
function rationalValueOf(rational: BigRational): RationalType {
	return createRational(rational.numerator, rational.denominator)
}

// #region Construction & normalization

// floor(√value) by Newton's method. The first estimate, 2^⌈bits/2⌉, is at
// least the root, so the iteration only descends and stops at the floor.
export function integerSquareRoot(value: bigint): bigint {
	if (value < 2n) {
		return value
	}

	let estimate = 1n << BigInt((value.toString(2).length + 1) >> 1)
	let next = (estimate + value / estimate) >> 1n

	while (next < estimate) {
		estimate = next
		next = (estimate + value / estimate) >> 1n
	}

	return estimate
}

// Where trial division stops. See "Radicands past the trial-division bound" in
// DEVELOPMENT.md.
const TRIAL_DIVISION_BOUND = 65536n

// Splits a non-negative integer into `square² · squarefree`, so √12 becomes
// 2·√3. Past the bound the remainder is only tested for being a square. Zero's
// square is 0, which zeroes the coefficient and collapses √0.
function extractSquarePart(radicand: bigint): {
	square: bigint
	squarefree: bigint
} {
	let square = 1n
	let squarefree = 1n
	let remainder = radicand

	for (
		let factor = 2n;
		factor <= TRIAL_DIVISION_BOUND && factor * factor <= remainder;
		factor++
	) {
		if (remainder % factor !== 0n) {
			continue
		}

		let multiplicity = 0n

		while (remainder % factor === 0n) {
			remainder = remainder / factor
			multiplicity += 1n
		}

		square = square * factor ** (multiplicity / 2n)

		if (multiplicity % 2n === 1n) {
			squarefree = squarefree * factor
		}
	}

	const root = integerSquareRoot(remainder)

	if (root * root === remainder) {
		square = square * root
		remainder = 1n
	}

	return { square, squarefree: squarefree * remainder }
}

// The gateway for a new radicand: normalises it and enforces the invariants.
export function createAlgebraic(
	rationalPart: BigRational,
	radicalCoefficient: BigRational,
	radicand: bigint,
): AlgebraicType | RationalType {
	if (radicand < 0n) {
		throw new Error("An Algebraic can not hold the root of a negative.")
	}

	const { square, squarefree } = extractSquarePart(radicand)

	return rebuildAlgebraic(
		rationalPart,
		multiplyRationals(radicalCoefficient, {
			numerator: square,
			denominator: 1n,
		}),
		squarefree,
	)
}

// The gateway for a radicand `createAlgebraic` already normalised. It skips the
// factoring, and collapses a cancelled radical to a Rational.
function rebuildAlgebraic(
	rationalPart: BigRational,
	coefficient: BigRational,
	radicand: bigint,
): AlgebraicType | RationalType {
	if (radicand === 1n || coefficient.numerator === 0n) {
		return rationalValueOf(
			addRationals(
				rationalPart,
				radicand === 1n
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
		radicand,
	}
}

// The two parts of `a + b·√d`, without the radicand.
type AlgebraicParts = { rationalPart: BigRational; coefficient: BigRational }

function partsOf(algebraic: AlgebraicType): AlgebraicParts {
	return {
		rationalPart: rationalPartOf(algebraic),
		coefficient: radicalCoefficientOf(algebraic),
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

// (a + b·√d)(c + e·√d) = (a·c + b·e·d) + (a·e + b·c)·√d, over the parts so
// that `raise` need not build a value per step.
function productParts(
	first: AlgebraicParts,
	second: AlgebraicParts,
	radicand: bigint,
): AlgebraicParts {
	const scaledRadicand = { numerator: radicand, denominator: 1n }

	return {
		rationalPart: addRationals(
			multiplyRationals(first.rationalPart, second.rationalPart),
			multiplyRationals(
				multiplyRationals(first.coefficient, second.coefficient),
				scaledRadicand,
			),
		),
		coefficient: addRationals(
			multiplyRationals(first.rationalPart, second.coefficient),
			multiplyRationals(second.rationalPart, first.coefficient),
		),
	}
}

// 1/(a + b·√d) = (a − b·√d)/(a² − b²·d). The norm is never zero, since that
// would make √d rational.
function reciprocalParts(
	parts: AlgebraicParts,
	radicand: bigint,
): AlgebraicParts {
	const conjugateNorm = subtractRationals(
		multiplyRationals(parts.rationalPart, parts.rationalPart),
		multiplyRationals(
			multiplyRationals(parts.coefficient, parts.coefficient),
			{ numerator: radicand, denominator: 1n },
		),
	)

	return {
		rationalPart: divideRationals(parts.rationalPart, conjugateNorm),
		coefficient: divideRationals(
			{
				numerator: -parts.coefficient.numerator,
				denominator: parts.coefficient.denominator,
			},
			conjugateNorm,
		),
	}
}

// Rewrites the larger radicand over the smaller when the two name one radical,
// or answers `null`. See "Radicands past the trial-division bound" in
// DEVELOPMENT.md.
function overCommonRadicand(
	first: AlgebraicType,
	second: AlgebraicType,
): [AlgebraicType, AlgebraicType] | null {
	if (first.radicand === second.radicand) {
		return [first, second]
	}

	const product = first.radicand * second.radicand
	const root = integerSquareRoot(product)

	if (root * root !== product) {
		return null
	}

	if (first.radicand > second.radicand) {
		return [rewrittenOver(first, second.radicand, root), second]
	}

	return [first, rewrittenOver(second, first.radicand, root)]
}

// `a + b·√d` as `a + (b·root/e)·√e`, where root = √(d·e). The coefficient
// stays non-zero, so the rebuild can not collapse and the cast holds.
function rewrittenOver(
	algebraic: AlgebraicType,
	radicand: bigint,
	root: bigint,
): AlgebraicType {
	return rebuildAlgebraic(
		rationalPartOf(algebraic),
		multiplyRationals(radicalCoefficientOf(algebraic), {
			numerator: root,
			denominator: radicand,
		}),
		radicand,
	) as AlgebraicType
}

// √(p/q) = √(p·q)/q: a Rational when the root is exact, else an Algebraic.
export function squareRootOfRational(
	value: BigRational,
): OptionalType<AlgebraicType | RationalType> {
	if (value.numerator < 0n) {
		return createEmpty()
	}

	// √0 is 0, the one root that leaves no radical.
	if (value.numerator === 0n) {
		return createValue(createRational(0n, 1n))
	}

	return createValue(
		createAlgebraic(
			{ numerator: 0n, denominator: 1n },
			{ numerator: 1n, denominator: value.denominator },
			value.numerator * value.denominator,
		),
	)
}

// #endregion

// #region Exact sign determination

// The exact sign of `a + b·√d`. See "Exact Algebraic signs" in DEVELOPMENT.md.
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

	// Opposite signs: compare a² with b²·d, and the larger term wins.
	const rationalSquared = multiplyRationals(rationalPart, rationalPart)
	const radicalSquared = multiplyRationals(
		multiplyRationals(radicalCoefficient, radicalCoefficient),
		{ numerator: radicand, denominator: 1n },
	)
	const difference = subtractRationals(rationalSquared, radicalSquared)
	const differenceSign = rationalSign(difference)

	// Zero would make √d rational, so it is unreachable, but answered rather
	// than thrown so the function is total.
	if (differenceSign === 0n) {
		return 0n
	}

	return differenceSign > 0n ? rationalSignValue : radicalSignValue
}

// The exact sign of `a + b·√d − c·√e` over two different radicals, by one
// squaring. See "Exact Algebraic signs" in DEVELOPMENT.md.
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

	// Same sign on both sides: compare (a + b·√d)² with (c·√e)², a form over √d
	// against a rational.
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
	const aligned = overCommonRadicand(first, second)

	if (aligned !== null) {
		const [left, right] = aligned

		return signOfLinearRadical(
			rationalPart,
			subtractRationals(
				radicalCoefficientOf(left),
				radicalCoefficientOf(right),
			),
			left.radicand,
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

// A certified enclosure of the value, scaled by 10^digits. See "Reading digits
// off an enclosure" in DEVELOPMENT.md.
export function scaledIntervalOf(
	algebraic: AlgebraicType,
	digits: bigint,
): { low: bigint; high: bigint } {
	const scale = 10n ** digits

	// floor(√(radicand · scale²)) and its successor enclose √radicand.
	const radicalLow = integerSquareRoot(algebraic.radicand * scale * scale)
	const radicalHigh = radicalLow + 1n

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

// The step of the unit grid each `Rounding` rule reaches for `scaled / scale`,
// with a positive scale. Shared by both irrationals.
export function roundScaled(
	scaled: bigint,
	scale: bigint,
	direction: RoundingType,
): bigint {
	// bigint division truncates towards zero, so a negative value steps back
	// one to reach its floor. The rules are written on the floor.
	let floored = scaled / scale
	let remainder = scaled - floored * scale

	if (remainder < 0n) {
		floored -= 1n
		remainder += scale
	}

	switch (direction[typeKeySymbol]) {
		case "Rounding#Down":
			return floored

		case "Rounding#Up":
			return remainder === 0n ? floored : floored + 1n

		case "Rounding#TowardZero":
			// The floor, but a negative value that is not whole steps up one.
			return scaled < 0n && remainder !== 0n ? floored + 1n : floored

		case "Rounding#Nearest":
			if (remainder * 2n !== scale) {
				return remainder * 2n > scale ? floored + 1n : floored
			}

			// A tie goes away from zero, which for a negative value is the floor.
			return scaled < 0n ? floored : floored + 1n

		case "Rounding#NearestEven":
			if (remainder * 2n !== scale) {
				return remainder * 2n > scale ? floored + 1n : floored
			}

			return floored % 2n === 0n ? floored : floored + 1n
	}
}

// The step of the 10^-places grid a certified enclosure decides on, or `null`
// past `limitDigits`. See "Reading digits off an enclosure" in DEVELOPMENT.md.
export function roundedOnDecimalGrid(
	enclosureAt: (digits: bigint) => { low: bigint; high: bigint },
	places: bigint,
	direction: RoundingType,
	limitDigits: null,
): bigint
export function roundedOnDecimalGrid(
	enclosureAt: (digits: bigint) => { low: bigint; high: bigint },
	places: bigint,
	direction: RoundingType,
	limitDigits: bigint | null,
): bigint | null
export function roundedOnDecimalGrid(
	enclosureAt: (digits: bigint) => { low: bigint; high: bigint },
	places: bigint,
	direction: RoundingType,
	limitDigits: bigint | null,
): bigint | null {
	for (let guard = 8n; ; guard *= 2n) {
		if (limitDigits !== null && places + guard > limitDigits) {
			return null
		}

		const enclosure = enclosureAt(places + guard)
		const scale = 10n ** guard
		const step = roundScaled(enclosure.low, scale, direction)

		if (step === roundScaled(enclosure.high, scale, direction)) {
			return step
		}
	}
}

// The exponent of the largest power of ten not greater than the value's
// distance from zero, or `null` past `limitDigits`.
export function decimalExponentOnEnclosure(
	enclosureAt: (digits: bigint) => { low: bigint; high: bigint },
	limitDigits: null,
): bigint
export function decimalExponentOnEnclosure(
	enclosureAt: (digits: bigint) => { low: bigint; high: bigint },
	limitDigits: bigint | null,
): bigint | null
export function decimalExponentOnEnclosure(
	enclosureAt: (digits: bigint) => { low: bigint; high: bigint },
	limitDigits: bigint | null,
): bigint | null {
	for (let digits = 8n; ; digits *= 2n) {
		if (limitDigits !== null && digits > limitDigits) {
			return null
		}

		const enclosure = enclosureAt(digits)
		const nearer = enclosure.low > 0n ? enclosure.low : -enclosure.high
		const further = enclosure.low > 0n ? enclosure.high : -enclosure.low

		if (nearer > 0n) {
			const length = nearer.toString().length

			if (length === further.toString().length) {
				return BigInt(length) - 1n - digits
			}
		}
	}
}

// #endregion

// #region Methods

export function compare(
	algebraic: AlgebraicType,
	other: AlgebraicType | IntegerType | RationalType,
): OrderingType {
	return orderingOfSign(signOfDifference(algebraic, other))
}

export function add(
	algebraic: AlgebraicType,
	other: IntegerType | RationalType,
): AlgebraicType {
	// Adding a rational can not collapse the radical, so the cast holds.
	return rebuildAlgebraic(
		addRationals(rationalPartOf(algebraic), bigRationalOf(other)),
		radicalCoefficientOf(algebraic),
		algebraic.radicand,
	) as AlgebraicType
}

export function multiply(
	algebraic: AlgebraicType,
	other: IntegerType | RationalType,
): AlgebraicType | RationalType {
	const factor = bigRationalOf(other)

	return rebuildAlgebraic(
		multiplyRationals(rationalPartOf(algebraic), factor),
		multiplyRationals(radicalCoefficientOf(algebraic), factor),
		algebraic.radicand,
	)
}

export function divide(
	algebraic: AlgebraicType,
	other: IntegerType | RationalType,
): OptionalType<AlgebraicType> {
	const divisor = bigRationalOf(other)

	if (divisor.numerator === 0n) {
		return createEmpty()
	}

	return createValue(
		rebuildAlgebraic(
			divideRationals(rationalPartOf(algebraic), divisor),
			divideRationals(radicalCoefficientOf(algebraic), divisor),
			algebraic.radicand,
		) as AlgebraicType,
	)
}

// `divide` for a divisor proven not zero, which always holds a value.
export function divideByNonZero(
	algebraic: AlgebraicType,
	other: IntegerType | RationalType,
): AlgebraicType {
	return (divide(algebraic, other) as ValueType<AlgebraicType>).item
}

// Empty when the two radicals differ, since the sum leaves the slice. See
// "Arithmetic across radicands" in DEVELOPMENT.md.
export function addAlgebraic(
	algebraic: AlgebraicType,
	other: AlgebraicType,
): OptionalType<AlgebraicType | RationalType> {
	const aligned = overCommonRadicand(algebraic, other)

	if (aligned === null) {
		return createEmpty()
	}

	const [first, second] = aligned

	return createValue(
		rebuildAlgebraic(
			addRationals(rationalPartOf(first), rationalPartOf(second)),
			addRationals(
				radicalCoefficientOf(first),
				radicalCoefficientOf(second),
			),
			first.radicand,
		),
	)
}

export function multiplyWithAlgebraic(
	algebraic: AlgebraicType,
	other: AlgebraicType,
): OptionalType<AlgebraicType | RationalType> {
	const aligned = overCommonRadicand(algebraic, other)

	if (aligned !== null) {
		const [first, second] = aligned
		const product = productParts(
			partsOf(first),
			partsOf(second),
			first.radicand,
		)

		return createValue(
			rebuildAlgebraic(
				product.rationalPart,
				product.coefficient,
				first.radicand,
			),
		)
	}

	const firstRational = rationalPartOf(algebraic)
	const firstRadical = radicalCoefficientOf(algebraic)
	const secondRational = rationalPartOf(other)
	const secondRadical = radicalCoefficientOf(other)

	// Across radicands only pure radicals stay quadratic: b·√d · b'·√e =
	// bb'·√(d·e).
	if (firstRational.numerator === 0n && secondRational.numerator === 0n) {
		return createValue(
			createAlgebraic(
				{ numerator: 0n, denominator: 1n },
				multiplyRationals(firstRadical, secondRadical),
				algebraic.radicand * other.radicand,
			),
		)
	}

	return createEmpty()
}

export function divideByAlgebraic(
	algebraic: AlgebraicType,
	other: AlgebraicType,
): OptionalType<AlgebraicType | RationalType> {
	const reciprocal = reciprocalOf(other)

	if (reciprocal[typeKeySymbol] === "Algebraic") {
		return multiplyWithAlgebraic(algebraic, reciprocal)
	}

	// Unreachable, since the reciprocal of an irrational is irrational.
	return createEmpty()
}

// `value ÷ algebraic`, for the commuted entries on Integer and Rational. Total,
// since an Algebraic is never zero.
export function dividedInto(
	algebraic: AlgebraicType,
	value: IntegerType | RationalType,
): AlgebraicType | RationalType {
	const reciprocal = reciprocalOf(algebraic)

	if (reciprocal[typeKeySymbol] === "Algebraic") {
		return multiply(reciprocal, value)
	}

	// Unreachable, since the reciprocal of an irrational is irrational.
	return reciprocal
}

// The slice is closed under Integer powers, so a negative exponent is exact
// too. The power may still collapse: (√2)² is 2. Square-and-multiply.
export function raise(
	algebraic: AlgebraicType,
	exponent: IntegerType,
): AlgebraicType | RationalType {
	const power = BigInt(exponent.value)
	let base =
		power < 0n
			? reciprocalParts(partsOf(algebraic), algebraic.radicand)
			: partsOf(algebraic)
	let answer: AlgebraicParts = {
		rationalPart: { numerator: 1n, denominator: 1n },
		coefficient: { numerator: 0n, denominator: 1n },
	}
	let remaining = power < 0n ? -power : power

	while (remaining > 0n) {
		if (remaining % 2n === 1n) {
			answer = productParts(answer, base, algebraic.radicand)
		}

		remaining = remaining / 2n

		if (remaining > 0n) {
			base = productParts(base, base, algebraic.radicand)
		}
	}

	return rebuildAlgebraic(
		answer.rationalPart,
		answer.coefficient,
		algebraic.radicand,
	)
}

export function reciprocalOf(
	algebraic: AlgebraicType,
): AlgebraicType | RationalType {
	const parts = reciprocalParts(partsOf(algebraic), algebraic.radicand)

	return rebuildAlgebraic(
		parts.rationalPart,
		parts.coefficient,
		algebraic.radicand,
	)
}

// Negation keeps both invariants, so it skips the gateways.
export function negate(algebraic: AlgebraicType): AlgebraicType {
	return {
		[typeKeySymbol]: "Algebraic",
		rationalPartNumerator: -algebraic.rationalPartNumerator,
		rationalPartDenominator: algebraic.rationalPartDenominator,
		radicalCoefficientNumerator: -algebraic.radicalCoefficientNumerator,
		radicalCoefficientDenominator: algebraic.radicalCoefficientDenominator,
		radicand: algebraic.radicand,
	}
}

// An Algebraic is irrational, so these readings never reach a limit. See
// "Reading digits off an enclosure" in DEVELOPMENT.md.
export function round(
	algebraic: AlgebraicType,
	direction: RoundingType,
): IntegerType {
	return createInteger(
		roundedOnDecimalGrid(
			(digits) => scaledIntervalOf(algebraic, digits),
			0n,
			direction,
			null,
		),
	)
}

export function approximate(
	algebraic: AlgebraicType,
	places: IntegerType,
	direction: RoundingType,
): RationalType {
	const width = BigInt(places.value)

	return createRational(
		roundedOnDecimalGrid(
			(digits) => scaledIntervalOf(algebraic, digits),
			width,
			direction,
			null,
		),
		10n ** width,
	)
}

export function decimalExponent(algebraic: AlgebraicType): IntegerType {
	return createInteger(
		decimalExponentOnEnclosure(
			(digits) => scaledIntervalOf(algebraic, digits),
			null,
		),
	)
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

// The Rewriter addresses Overloads by index, so these bind each entry in the
// Namespace's declared order.
export const add__overload$1 = add
export const add__overload$2 = add
export const add__overload$3 = addAlgebraic
export const multiply__overload$1 = multiply
export const multiply__overload$2 = multiply
export const multiply__overload$3 = multiplyWithAlgebraic
// A non-zero factor leaves the coefficient non-zero, so the proven entries
// answer an Algebraic. The arithmetic is the same.
export const multiply__overload$5 = multiply as (
	algebraic: AlgebraicType,
	other: IntegerType,
) => AlgebraicType
export const multiply__overload$6 = multiply as (
	algebraic: AlgebraicType,
	other: RationalType,
) => AlgebraicType
export const divide__overload$1 = divide
export const divide__overload$2 = divide
export const divide__overload$3 = divideByAlgebraic
export const divide__overload$7 = divideByNonZero as (
	algebraic: AlgebraicType,
	other: IntegerType,
) => AlgebraicType
export const divide__overload$8 = divideByNonZero as (
	algebraic: AlgebraicType,
	other: RationalType,
) => AlgebraicType

// The other entries of `round` and `toString` are written in Essence.
export const round__overload$1 = round
export const toString__overload$1 = toString

// #endregion
