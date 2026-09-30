// The `NonNegativeInteger` Namespace. See "Refined Namespaces" in
// DEVELOPMENT.md.
import type { AlgebraicType } from "./Algebraic"
import {
	factorial__overload$1,
	type IntegerType,
	squareRoot__overload$1,
} from "./Integer"
import type { ValueType } from "./Optional"

// Both `add` entries bind to `Integer`'s one sum: a positive or a non-negative
// summand keeps the answer's proof, and the arithmetic is the same.
export {
	add__overload$1,
	add__overload$1 as add__overload$2,
	multiply__overload$1 as multiply,
} from "./Integer"

// A negative Integer is the only receiver `Integer::squareRoot` answers empty
// for, and the proof rules it out. The root is read off that entry.
export function squareRoot(integer: IntegerType): IntegerType | AlgebraicType {
	return (
		squareRoot__overload$1(integer) as ValueType<
			IntegerType | AlgebraicType
		>
	).item
}

// A negative Integer is the only receiver `Integer::factorial` answers empty
// for, and the proof rules it out.
export function factorial(integer: IntegerType): IntegerType {
	return (factorial__overload$1(integer) as ValueType<IntegerType>).item
}
