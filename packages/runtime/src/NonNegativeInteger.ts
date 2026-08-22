// NOTE: The runtime module of the `NonNegativeInteger` Namespace — the Integers
// a Program has proven are not below zero. The Simplifier emits
// `<Namespace>.<method>(…)`, so a Namespace needs a module of its own name, and
// this is the whole of it.
import type { AlgebraicType } from "./Algebraic"
import { type IntegerType, squareRoot__overload$1 } from "./Integer"
import type { ValueType } from "./Optional"

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
