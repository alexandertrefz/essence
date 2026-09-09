// NOTE: The runtime module of the `NonNegativeInteger` Namespace — the Integers
// a Program has proven are not below zero. The Simplifier emits
// `<Namespace>.<method>(…)`, so a Namespace needs a module of its own name, and
// this is the whole of it.
import type { AlgebraicType } from "./Algebraic"
import {
	factorial__overload$1,
	type IntegerType,
	squareRoot__overload$1,
} from "./Integer"
import type { ValueType } from "./Optional"

// NOTE: The sum and the product are `Integer`'s own, for the reason
// `NonZeroInteger.ts` gives: a refinement erases before anything runs, so both
// operands ARE `IntegerType`s here and the answer is the same arithmetic it
// always was. `add` is an Overload of two entries — a positive summand makes
// the sum positive, a non-negative one keeps it non-negative — and both bind to
// the one sum, under the names their positions give them. `multiply` is a lone
// entry and binds under the bare name.
export {
	add__overload$1,
	add__overload$1 as add__overload$2,
	multiply__overload$1 as multiply,
} from "./Integer"

// NOTE: A refinement erases before anything runs, so what arrives is an
// ordinary `IntegerType` and the evidence the Type carried was spent while
// compiling. A negative Integer is the one receiver `Integer::squareRoot`
// answers empty for, and that this can not be one is exactly what the
// Namespace's target bought.
//
// NOTE: The root is READ off that entry rather than computed a second time, so
// the two can not come apart — the same reason `multiply` is a re-export in
// `NonZeroInteger.ts`. The cast is the proof the Types already carry, written
// where TypeScript can not be told it holds.
export function squareRoot(integer: IntegerType): IntegerType | AlgebraicType {
	return (
		squareRoot__overload$1(integer) as ValueType<
			IntegerType | AlgebraicType
		>
	).item
}

// NOTE: A negative Integer is the one receiver `Integer::factorial` answers
// empty for, and that this can not be one is what the Namespace's target
// bought. The factorial is READ off that entry rather than computed a second
// time, for the reason `squareRoot` above reads its root off one.
export function factorial(integer: IntegerType): IntegerType {
	return (factorial__overload$1(integer) as ValueType<IntegerType>).item
}
