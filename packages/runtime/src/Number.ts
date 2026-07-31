import type { AlgebraicType } from "./Algebraic"
import { compare as compareAlgebraicTo } from "./Algebraic"
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

// #endregion

// NOTE: `lowestNumber`, `greatestNumber`, `sum`, `product` and `average` are
// written in Essence now — `packages/stdlib/sources/Number.es`. The pairwise
// `lowestNumber`/`greatestNumber` entries were already there; the List entries
// fold them over the items, and the aggregates fold the members' own
// arithmetic, collapsing a whole mixed total back to an Integer.

// #region Union-level Methods

export type NumberType =
	| IntegerType
	| RationalType
	| AlgebraicType
	| TranscendentalType

type RationalKind = IntegerType | RationalType

// NOTE: The cross-member semantics of `Number`: two Numbers are compared by
// numeric value, so the Integer `1` and the Rational `1/1` are the same
// Number even though the member Namespaces treat them as different values.
// Cross-multiplication keeps everything in bigint arithmetic; equality is
// sign-safe, and the ordering comparisons assume positive denominators like
// the rest of the runtime does.
function numeratorOf(number: RationalKind): bigint {
	if (number[typeKeySymbol] === "Integer") {
		return number.value
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

// NOTE: `is`, `isNot` and `toString` are written in Essence now —
// `packages/stdlib/sources/Number.es`. `is` reads the covering `compare` against
// `Ordering#Equal`, `isNot` negates it, and `toString` matches the member Type
// and defers to that member's own `toString`. `compare` below is the one
// ordering primitive they all fall out of, and it stays native.

// NOTE: Wiring B — the covering Namespace hand-writes all sixteen cells.
// Every cross-kind cell is total and exact, because equality across kinds is
// impossible by definition; only comparing two Transcendentals could ever
// need refinement, and with a single registered base even that cell is exact
// — see the basis registry in `Transcendental.ts`.
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

// #region Comparisons

// NOTE: The Union-level ordering family — `isLessThan`, `isLessThanOrEqualTo`,
// `isGreaterThan` and `isGreaterThanOrEqualTo` — is written in Essence now,
// `packages/stdlib/sources/Number.es`. Each reads the covering `compare` above against the
// matching `Ordering` variant (`isLessThan` against `Ordering#Less`, and so
// on), and the `…OrEqualTo` pair negates the strict opposite. `compare` is
// the one ordering primitive they all fall out of, and it stays native.

// NOTE: `isBetween` is written in Essence now — `packages/stdlib/sources/Number.es` — as
// `@::isGreaterThanOrEqualTo(lower)::and(@::isLessThanOrEqualTo(upper))`, which
// is the same two comparisons this function made, read off the same covering
// order. Both bounds stay included, and bounds in the wrong order still enclose
// no Number at all, so the answer is simply `false`.

// #endregion
