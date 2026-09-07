// NOTE: The runtime module of the `PositiveInteger` Namespace — the Integers a
// Program has proven are above zero. The Simplifier emits
// `<Namespace>.<method>(…)`, so a Namespace needs a module of its own name, and
// this is the whole of it: every entry is a Function another module already
// holds, under the name this Namespace gives it.
//
// NOTE: Nothing is written a second time here, and that is the point rather
// than a shortcut. A refinement erases before anything runs: every operand IS
// an `IntegerType` by the time one of these runs, the sum, the product and the
// power are the same arithmetic `Integer.ts` performs for a value nothing was
// proven about, and the evidence the Types carried was spent while compiling.
// What the Namespace adds is only what each answer's Type says — that a sum
// with a non-negative Integer, a product with a positive one and a whole power
// are above zero, and that the root of a positive perfect square is.
//
// NOTE: `raise` binds `Integer`'s non-negative entry, which holds the whole
// power outright: a positive base has every power, and the exponent's proof
// rules the reciprocal arm out before this is reached. `squareRoot` is
// `NonNegativeInteger`'s, which reads the root off `Integer`'s Optional entry
// — a positive Integer is a non-negative one, and the root is the same root.
export {
	add__overload$1 as add,
	multiply__overload$1 as multiply,
	raise__overload$3 as raise,
} from "./Integer"
export { squareRoot } from "./NonNegativeInteger"
