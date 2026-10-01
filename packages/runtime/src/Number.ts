import type { AlgebraicType } from "./Algebraic"
import { compare as compareAlgebraicTo, createAlgebraic } from "./Algebraic"
import type { IntegerType } from "./Integer"
import type { OrderingType } from "./Ordering"
import { equal, greater, less } from "./Ordering"
import type { RationalType } from "./Rational"
import type { TranscendentalType } from "./Transcendental"
import {
	compareTranscendentals,
	createTranscendental,
	signRelativeTo,
} from "./Transcendental"
import { typeKeySymbol } from "./type"

// #region Constants

export const Pi = createTranscendental({ numerator: 0n, denominator: 1n }, [
	{ base: "π", coefficient: { numerator: 1n, denominator: 1n } },
]) as TranscendentalType
export const Tau = createTranscendental({ numerator: 0n, denominator: 1n }, [
	{ base: "π", coefficient: { numerator: 2n, denominator: 1n } },
]) as TranscendentalType
export const E = createTranscendental({ numerator: 0n, denominator: 1n }, [
	{ base: "e", coefficient: { numerator: 1n, denominator: 1n } },
]) as TranscendentalType
export const GoldenRatio = createAlgebraic(
	{ numerator: 1n, denominator: 2n },
	{ numerator: 1n, denominator: 2n },
	5n,
) as AlgebraicType

// #endregion

// #region Union-level Methods

// Every other Method of `Number` is written in Essence in `Number.es`, on
// `compare`.

export type NumberType =
	| IntegerType
	| RationalType
	| AlgebraicType
	| TranscendentalType

type RationalKind = IntegerType | RationalType

// The parts `compare` cross-multiplies. Every denominator is positive, so the
// products order as the values do.
function numeratorOf(number: RationalKind): bigint {
	if (number[typeKeySymbol] === "Integer") {
		return BigInt(number.value)
	} else {
		return number.numerator
	}
}

function denominatorOf(number: RationalKind): bigint {
	if (number[typeKeySymbol] === "Integer") {
		return 1n
	} else {
		return number.denominator
	}
}

// Compares by value across the members, so the Integer `1` and the Rational
// `1/1` are one Number. Only a Transcendental over several bases can reach the
// precision cutoff. See "Deciding a Transcendental's sign" in DEVELOPMENT.md.
export function compare(number: NumberType, other: NumberType): OrderingType {
	const numberKind = number[typeKeySymbol]
	const otherKind = other[typeKeySymbol]

	if (numberKind === "Transcendental") {
		if (otherKind === "Transcendental") {
			return compareTranscendentals(
				number as TranscendentalType,
				other as TranscendentalType,
			)
		}

		return signRelativeTo(
			number as TranscendentalType,
			other as RationalKind | AlgebraicType,
		) < 0n
			? less
			: greater
	}

	if (otherKind === "Transcendental") {
		return signRelativeTo(
			other as TranscendentalType,
			number as RationalKind | AlgebraicType,
		) < 0n
			? greater
			: less
	}

	if (numberKind === "Algebraic") {
		return compareAlgebraicTo(
			number as AlgebraicType,
			other as RationalKind | AlgebraicType,
		)
	}

	if (otherKind === "Algebraic") {
		const inverted = compareAlgebraicTo(
			other as AlgebraicType,
			number as RationalKind,
		)

		if (inverted === less) {
			return greater
		} else if (inverted === greater) {
			return less
		}

		return equal
	}

	let lhs =
		numeratorOf(number as RationalKind) *
		denominatorOf(other as RationalKind)
	let rhs =
		numeratorOf(other as RationalKind) *
		denominatorOf(number as RationalKind)

	if (lhs < rhs) {
		return less
	} else if (lhs === rhs) {
		return equal
	} else {
		return greater
	}
}

// #endregion
