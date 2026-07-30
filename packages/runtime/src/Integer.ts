import type { AlgebraicType } from "./Algebraic"
import {
	dividedInto as algebraicDividedInto,
	squareRootOfRational,
} from "./Algebraic"
import type { OptionalType } from "./Optional"
import { createEmpty, createValue } from "./Optional"
import type { OrderingType } from "./Ordering"
import { equal, greater, less } from "./Ordering"
import type { RationalType } from "./Rational"
import { createRational } from "./Rational"
import type { StringType } from "./String"
import { createString } from "./String"
import { typeKeySymbol } from "./type"

export type IntegerType = { [typeKeySymbol]: "Integer"; value: bigint }

export function createInteger(value: bigint): IntegerType {
	return { [typeKeySymbol]: "Integer", value }
}

// #region Add

export function add__overload$1(
	originalNumber: IntegerType,
	other: IntegerType,
): IntegerType {
	return createInteger(originalNumber.value + other.value)
}

// #endregion

// #region Multiply

export function multiply__overload$1(
	originalNumber: IntegerType,
	other: IntegerType,
): IntegerType {
	return createInteger(originalNumber.value * other.value)
}

// #endregion

// #region Everyday methods

export function negate(integer: IntegerType): IntegerType {
	return createInteger(-integer.value)
}

export function remainder__overload$1(
	integer: IntegerType,
	divisor: IntegerType,
): OptionalType<IntegerType> {
	if (divisor.value === 0n) {
		return createEmpty()
	}

	return createValue(remainder__overload$2(integer, divisor))
}

// NOTE: The divisor of this entry is a `NonZeroInteger` in the source — proven
// while compiling, erased to an Integer here — so there is no empty arm to
// build.
export function remainder__overload$2(
	integer: IntegerType,
	divisor: IntegerType,
): IntegerType {
	// NOTE: Euclidean remainder — the result is always in
	// `0 ≤ r < |divisor|`, whatever the signs of the operands.
	let remainder = integer.value % divisor.value

	if (remainder < 0n) {
		remainder += divisor.value < 0n ? -divisor.value : divisor.value
	}

	return createInteger(remainder)
}

// NOTE: The other half of the same division, and it has to agree with
// `remainder` exactly: `quotient · divisor + remainder` must be the original
// Integer. Since the remainder is Euclidean — never negative — the quotient is
// floored towards negative infinity for a positive divisor rather than
// truncated towards zero, which is where it parts company with JavaScript's
// `/`. `(-7) ÷ 3` is `-3` remainder `2`, not `-2` remainder `-1`.
export function quotient__overload$1(
	integer: IntegerType,
	divisor: IntegerType,
): OptionalType<IntegerType> {
	if (divisor.value === 0n) {
		return createEmpty()
	}

	return createValue(quotient__overload$2(integer, divisor))
}

// NOTE: The divisor of this entry is a `NonZeroInteger` in the source — proven
// while compiling, erased to an Integer here — so there is no empty arm to
// build.
export function quotient__overload$2(
	integer: IntegerType,
	divisor: IntegerType,
): IntegerType {
	let truncated = integer.value / divisor.value
	let remainder = integer.value % divisor.value

	// NOTE: A negative remainder means the truncation rounded the wrong way for
	// a Euclidean pairing; step the quotient one towards the divisor's sign.
	if (remainder < 0n) {
		truncated += divisor.value < 0n ? 1n : -1n
	}

	return createInteger(truncated)
}

// NOTE: Division by a divisor the Types have already proven not to be zero —
// `NonZeroInteger` erases to an Integer, so the Parameter reads as one here —
// which is why there is no empty arm to build: the check the sibling entries
// open with was made while compiling.
export function divide__overload$4(
	integer: IntegerType,
	divisor: IntegerType,
): RationalType {
	return createRational(integer.value, divisor.value)
}

export function raise(
	base: IntegerType,
	exponent: IntegerType,
): OptionalType<IntegerType | RationalType> {
	if (exponent.value >= 0n) {
		return createValue(createInteger(base.value ** exponent.value))
	}

	if (base.value === 0n) {
		return createEmpty()
	}

	return createValue(createRational(1n, base.value ** -exponent.value))
}

// #endregion

// biome-ignore lint/suspicious/noShadowRestrictedNames: This is a runtime function
export function toString(integer: IntegerType): StringType {
	return createString(integer.value.toString())
}

// #region Irrational operands

export function divide__overload$3(
	integer: IntegerType,
	algebraic: AlgebraicType,
): AlgebraicType | RationalType {
	return algebraicDividedInto(algebraic, integer)
}

export function squareRoot(
	integer: IntegerType,
): OptionalType<IntegerType | AlgebraicType> {
	const root = squareRootOfRational({
		numerator: integer.value,
		denominator: 1n,
	})

	// NOTE: A negative has no real root, and `squareRootOfRational` has already
	// said so — this hands its answer on rather than deciding again.
	if (root[typeKeySymbol] === "Optional#Empty") {
		return root
	}

	const value = root.item

	if (value[typeKeySymbol] === "Rational") {
		// NOTE: A whole number's exact root is whole — surface it as one.
		return createValue(createInteger(value.numerator))
	}

	return createValue(value)
}

// #endregion

// NOTE: Same-kind ordering stays native deliberately. Routing it through the
// covering `Number.compare` reads better, but that Method decides every
// cross-kind cell, so comparing two Integers would drag the Algebraic,
// Transcendental and Rational machinery into any Program that compares two
// Integers, which is nearly all of them. `is` and the inequalities are still
// written in Essence on top of this.
export function compare(
	originalInteger: IntegerType,
	otherInteger: IntegerType,
): OrderingType {
	if (originalInteger.value < otherInteger.value) {
		return less
	} else if (originalInteger.value > otherInteger.value) {
		return greater
	} else {
		return equal
	}
}
