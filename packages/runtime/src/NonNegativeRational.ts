// NOTE: The runtime module of the `NonNegativeRational` Namespace — the
// Rationals a Program has proven are not below zero. The Simplifier emits
// `<Namespace>.<method>(…)`, so a Namespace needs a module of its own name, and
// this is the whole of it.
import type { AlgebraicType } from "./Algebraic"
import type { ValueType } from "./Optional"
import { type RationalType, squareRoot__overload$1 } from "./Rational"

// NOTE: The sum and the product are `Rational`'s own, for the reason
// `NonZeroRational.ts` gives: a refinement erases before anything runs, so both
// operands ARE `RationalType`s here and the answer is the same
// cross-multiplication it always was. `add` is an Overload of two entries — a
// positive summand makes the sum positive, a non-negative one keeps it
// non-negative — and both bind to the one sum, under the names their positions
// give them. `multiply` is a lone entry and binds under the bare name.
export {
	add__overload$1,
	add__overload$1 as add__overload$2,
	multiply__overload$1 as multiply,
} from "./Rational"

// NOTE: A negative Rational is the one receiver `Rational::squareRoot` answers
// empty for, and that this can not be one is exactly what the Namespace's
// target bought. The root is READ off that entry rather than computed a second
// time, which is the shape `NonNegativeInteger.ts` copies. The cast is the
// proof the Types already carry, written where TypeScript can not be told it
// holds.
export function squareRoot(
	rational: RationalType,
): RationalType | AlgebraicType {
	return (
		squareRoot__overload$1(rational) as ValueType<
			RationalType | AlgebraicType
		>
	).item
}
