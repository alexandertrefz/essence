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

// NOTE: The quadratic slice of the real algebraic irrationals: every value is
// `rationalPart + radicalCoefficient·√radicand`, held exactly as reduced
// bigint rationals. Invariants: the radicand is at least 2 and is not a perfect
// square, and the radicalCoefficient is never zero — a value that would break
// either is returned as a Rational instead, so an Algebraic is irrational by
// construction. The radicand is squarefree as far as `extractSquarePart`
// normalises it, which is every square factor whose root is below 2^16 and a
// remainder that is a square outright; two spellings of one radical that the
// bound leaves apart are brought together where they meet, by
// `overCommonRadicand`, so every comparison below is exact all the same.
export type AlgebraicType = {
	[typeKeySymbol]: "Algebraic"
	rationalPartNumerator: bigint
	rationalPartDenominator: bigint
	radicalCoefficientNumerator: bigint
	radicalCoefficientDenominator: bigint
	radicand: bigint
}

// NOTE: Lives here rather than in `bigRational.ts` because it builds through
// `createRational` — the rational core must stay free of value imports from
// `Rational.ts`.
function rationalValueOf(rational: BigRational): RationalType {
	return createRational(rational.numerator, rational.denominator)
}

// #region Construction & normalization

// NOTE: floor(√value) by Newton's method on bigints. The first estimate is
// 2^⌈bits/2⌉, which is at least the root, so the iteration only ever descends
// and stops at the floor. Shared by the normalisation below, by the test two
// radicands meet under, and by the interval evaluation at the end of the file.
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

// NOTE: Where trial division stops. Past it the remainder is asked one
// question — is it a perfect square? — by `integerSquareRoot`, so the root of
// a large prime costs at most 65,535 divisions and one Newton root rather than
// a walk up to its own root: `10^16 + 61` measured 2488 ms under unbounded
// trial division and 1.25 ms here, best of three, and the unbounded growth was
// √n — `10^12 + 39` measured 27.0 ms there and the same 1.25 ms here, since a
// bounded cost is the bound. The price is a radicand `p²·q` whose p and q are
// BOTH above the bound, which stays as written; see `overCommonRadicand` for
// what that costs.
const TRIAL_DIVISION_BOUND = 65536n

// NOTE: Splits a non-negative integer into `square² · squarefree`, so that
// `√radicand` can be normalised (√12 → 2·√3). Every factor found is divided
// out wholly, and an odd multiplicity leaves one copy in the squarefree part,
// so `2·65537²` normalises to `65537·√2` although 65537 is past the bound: what
// is left after the small factors is exactly the square. A remainder the loop
// left because its own root was reached is 1 or a prime, and the square test
// is harmless on both. Zero is the one radicand whose "square" is 0 — 0 = 0²
// — and the coefficient it scales to zero is what collapses √0 to the
// rational part in `rebuildAlgebraic`.
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

// NOTE: The single gateway every NEW radicand funnels through — it normalises
// the radicand and enforces the invariants, which is what makes an Algebraic
// provably irrational. An operation that keeps its operand's radicand goes
// through `rebuildAlgebraic` below instead.
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

// NOTE: The gateway for a radicand that has already been through
// `createAlgebraic` — every operation that keeps its operand's radicand, which
// is all of them but a root and a product across radicals. Normalising again
// would run the trial division a second time on a radicand that can not have
// changed: 1,000 additions on √(10^16 + 61) measured 1283 ms through
// `createAlgebraic` and 0.15 ms through this, best of three. It still collapses
// a cancelled radical to a Rational, which is the one invariant an operation
// can break.
function rebuildAlgebraic(
	rationalPart: BigRational,
	coefficient: BigRational,
	radicand: bigint,
): AlgebraicType | RationalType {
	if (radicand === 1n || coefficient.numerator === 0n) {
		// NOTE: The radical collapsed — the value is rational after all.
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

// NOTE: The two halves of `a + b·√d`, without the radicand — every helper below
// that works on the parts of ONE radical takes and answers this.
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

// NOTE: (a + b·√d)(c + e·√d) = (a·c + b·e·d) + (a·e + b·c)·√d, over the parts
// rather than over two values — the one product formula of the slice, read by
// the Method and by `raise`, which multiplies without building a value it would
// take apart again.
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

// NOTE: 1/(a + b·√d) = (a − b·√d)/(a² − b²·d) — the conjugate trick, over the
// parts for the same reason the product above is. The denominator can not be
// zero (that would make √d rational), which is exactly the "dividing by an
// Algebraic never fails" guarantee.
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

// NOTE: Two radicands name one radical exactly when their product is a perfect
// square: √d = (s/e)·√e with s = √(d·e). Two distinct squarefree radicands
// never do, so this is the seam where a radicand the trial-division bound left
// as `p²·q` meets its normalised spelling, or another un-normalised one. The
// larger radicand is rewritten over the smaller, which is the more normalised
// of the two, and the caller then runs the same-radicand arithmetic it already
// has — so a sum, a product, an ordering and an equality across the two
// spellings all answer what they answer for one. `null` says the radicals are
// genuinely different. One Newton root of `d·e` per meeting of two radicands,
// which the same-radicand fast path never pays: 100,000 comparisons of √2
// against √3 measured 76.6 ms here against 68.9 ms without the alignment,
// best of five, while the same-radicand pairs measured 15.9 and 17.7 ms
// against 15.2 and 16.6 — the price is a tenth on the one path that pays it.
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

// NOTE: `a + b·√d` as `a + (b·root/e)·√e`, where root = √(d·e). The coefficient
// stays non-zero and the radicand is one an Algebraic already carries, so the
// rebuild can not collapse and the cast holds.
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

// NOTE: The exact square root of a non-negative rational, staying in the
// quadratic slice: √(p/q) = √(p·q)/q. Returns an Integer-free Rational when
// the root is exact and an Algebraic otherwise.
export function squareRootOfRational(
	value: BigRational,
): OptionalType<AlgebraicType | RationalType> {
	if (value.numerator < 0n) {
		return createEmpty()
	}

	// NOTE: √0 is exactly 0 — the one non-negative root that leaves no radical
	// at all. Said here rather than left to `createAlgebraic` so the answer is
	// the canonical zero and not `0/q`.
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

	// NOTE: |a| = |b|·√d with the two signs opposed is exactly `a + b·√d = 0`,
	// so 0 is the sign — and it is also unreachable: it would make √d rational,
	// and the gateway never hands out a radicand that is a perfect square.
	// Answered rather than thrown, so that the routine is total whatever
	// radicand it is handed.
	if (differenceSign === 0n) {
		return 0n
	}

	return differenceSign > 0n ? rationalSignValue : radicalSignValue
}

// NOTE: The exact sign of `a + b·√d − c·√e` over two genuinely different
// radicals — `overCommonRadicand` has already said the two are not one — needed
// to compare two Algebraics over different radicals. One careful squaring
// reduces it to the single-radical case, and nothing in it asks the radicands
// to be squarefree: the squaring is an identity, and the sign it hands to
// `signOfLinearRadical` is decided by comparing rational squares, which is
// exact for any radicand that is not a perfect square. No enclosure is
// consulted, for the reason none could decide the one case that matters:
// two spellings of one number, which the alignment above answers exactly.
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

// NOTE: A certified enclosure of the value, scaled by 10^digits — used only
// when an Algebraic must be compared against a Transcendental, where interval
// refinement is the terminating procedure.
export function scaledIntervalOf(
	algebraic: AlgebraicType,
	digits: bigint,
): { low: bigint; high: bigint } {
	const scale = 10n ** digits

	// NOTE: floor(√(radicand · scale²)) and its successor enclose √radicand at
	// this scale.
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

// NOTE: The five rules of `Rounding`, over an exact value held as the scaled
// integer `scaled / scale` with a positive scale: the answer is the step of
// the unit grid the named rule reaches. Written here rather than in either
// irrational, because rounding an enclosure is one decision whichever kind
// produced the enclosure, and `Rational::round(toward:)` says the same five
// things in Essence over its own numerator and denominator.
export function roundScaled(
	scaled: bigint,
	scale: bigint,
	direction: RoundingType,
): bigint {
	// NOTE: bigint division truncates towards zero, so a negative value takes
	// one step back to reach its floor. Everything below is written on that
	// floor and on the part above it, exactly as the Essence body is.
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
			// NOTE: Cutting the fractional part off IS the floor, except for a
			// negative value that is not whole, which takes one step back
			// towards zero.
			return scaled < 0n && remainder !== 0n ? floored + 1n : floored

		case "Rounding#Nearest":
			if (remainder * 2n !== scale) {
				return remainder * 2n > scale ? floored + 1n : floored
			}

			// NOTE: A tie away from zero, which for a negative value is the
			// floor.
			return scaled < 0n ? floored : floored + 1n

		case "Rounding#NearestEven":
			if (remainder * 2n !== scale) {
				return remainder * 2n > scale ? floored + 1n : floored
			}

			return floored % 2n === 0n ? floored : floored + 1n
	}
}

// NOTE: The step of the 10^-places grid a certified enclosure decides on. The
// enclosure is taken at `places + guard` digits, both of its ends are rounded
// at `places`, and agreement is the answer — a disagreement asks for twice the
// guard. It terminates because the two ends can only disagree while the value
// sits inside the enclosure's own width of the one point the rule steps at: an
// integer multiple of the grid for `#Down`, `#Up` and `#TowardZero`, a half of
// one for the two nearest rules. A value on such a point is a ratio of
// Integers, which neither irrational is.
//
// NOTE: `limitDigits` is for the one caller that can not say that outright — a
// Transcendental over several bases, whose value being rational would settle an
// open problem. That caller reads a `null` answer as the impasse it is instead
// of looping forever; every other caller passes `null` for no limit and is
// answered a step.
//
// NOTE: The guard starts at 8 digits and doubles. Eight is what makes the
// FIRST enclosure decide for every ordinary value, so the common call costs one
// enclosure: 10,000 approximations of √2 to five places measured 5.9 ms, and
// 1,000 of π measured 2.0 ms, best of three. Depth is what costs — 1,000
// places measured 57 µs a call for √2 and 1.8 ms for π, since π's enclosure
// sums a Machin series to that width — so a doubling that overshoots is paid
// for once rather than a walk that adds a digit at a time.
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
	// NOTE: Adding a rational moves the rational part and can never collapse
	// the radical — the result is total.
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

// NOTE: `divide` under the proof its refined entries carry. The divisor is a
// `NonZeroInteger` or a `NonZeroRational` in the source, so the zero test above
// it can not fire and the Optional always holds a value. A read of that value
// rather than a second division: the arithmetic stays in one place.
export function divideByNonZero(
	algebraic: AlgebraicType,
	other: IntegerType | RationalType,
): AlgebraicType {
	return (divide(algebraic, other) as ValueType<AlgebraicType>).item
}

// NOTE: Same-radicand arithmetic stays inside the slice (and may collapse to
// a Rational — √2·√2 = 2); different radicands generally do not — those come
// back empty until the general algebraic representation exists. "Same" is
// decided by `overCommonRadicand`, so two spellings of one radical add.
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

	// NOTE: Across radicands only pure radicals stay quadratic:
	// b·√d · b'·√e = bb'·√(d·e).
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

	// NOTE: A reciprocal can not itself collapse — the inverse of an
	// irrational is irrational — so this branch is unreachable; it exists for
	// the type system.
	return createEmpty()
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
		return multiply(reciprocal, value)
	}

	// NOTE: Unreachable — the reciprocal of an irrational is irrational — but
	// the type system can not know that.
	return reciprocal
}

// NOTE: The quadratic slice is closed under Integer powers — a product over one
// radicand stays over it, and the reciprocal of one value in the field is
// another — so a negative exponent is as exact as a positive one and no entry
// of this Method answers an Optional. The power can still collapse: `(√2)²` is
// the Rational 2, which is why the answer is a Union.
//
// NOTE: Square-and-multiply, so an exponent of n costs a logarithm of n
// products rather than n of them. The parts are reduced at every step by
// `multiplyRationals`, so what grows is the value and not the spelling.
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

// NOTE: Negation flips both components and touches neither invariant — the
// radicand is untouched and the coefficient stays non-zero, so the result is
// an Algebraic without consulting either gateway.
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

// NOTE: The two Methods that hand an Algebraic to a reader as digits. Both are
// written on `scaledIntervalOf` above: the enclosure is refined until the
// rounding at the width asked for is decided, and the decided step is the
// answer. Neither ever gives up — an Algebraic is irrational by construction,
// so it never sits on the point a rounding rule steps at.
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
export const multiply__overload$1 = multiply
export const multiply__overload$2 = multiply
export const multiply__overload$3 = multiplyWithAlgebraic
// NOTE: The refined entries take the same Integer the plain ones do — a
// refinement erases before anything runs — and answer the narrower Type the
// proof affords: scaling `a + b·√d` by a non-zero factor leaves `b` non-zero,
// so the radical survives and the value can not collapse to a Rational. The
// product is the very implementation above under a narrower signature, which
// is what keeps a proven call and an unproven one the same arithmetic.
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

// NOTE: `round` answers an Integer as the first entry of its Overload; the
// second is written in Essence on `approximate`. `toString` is the first entry
// of its own, and the two `as:` entries beside it are Essence.
export const round__overload$1 = round
export const toString__overload$1 = toString

// #endregion
