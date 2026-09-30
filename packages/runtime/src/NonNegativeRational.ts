// The `NonNegativeRational` Namespace. See "Refined Namespaces" in
// DEVELOPMENT.md.
import type { AlgebraicType } from "./Algebraic"
import type { ValueType } from "./Optional"
import { type RationalType, squareRoot__overload$1 } from "./Rational"

// Both `add` entries bind to `Rational`'s one sum: a positive or a
// non-negative summand keeps the answer's proof, and the arithmetic is the same.
export {
	add__overload$1,
	add__overload$1 as add__overload$2,
	multiply__overload$1 as multiply,
} from "./Rational"

// A negative Rational is the only receiver `Rational::squareRoot` answers empty
// for, and the proof rules it out. The root is read off that entry.
export function squareRoot(
	rational: RationalType,
): RationalType | AlgebraicType {
	return (
		squareRoot__overload$1(rational) as ValueType<
			RationalType | AlgebraicType
		>
	).item
}
