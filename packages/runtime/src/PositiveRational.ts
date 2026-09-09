// NOTE: The runtime module of the `PositiveRational` Namespace — the Rationals
// a Program has proven are above zero. The Simplifier emits
// `<Namespace>.<method>(…)`, so a Namespace needs a module of its own name, and
// this is the whole of it: every entry is a Function another module already
// holds, under the name this Namespace gives it.
//
// NOTE: Nothing is written a second time here, and that is the point rather
// than a shortcut, for the reason `PositiveInteger.ts` gives. What the
// Namespace adds is only what each answer's Type says — that a sum with a
// non-negative Rational and a product with a positive one are above zero, and
// that the root of a positive ratio of perfect squares is. `squareRoot` is
// `NonNegativeRational`'s, which reads the root off `Rational`'s Optional entry
// — a positive Rational is a non-negative one, and the root is the same root.
export {
	add__overload$1 as add,
	multiply__overload$1 as multiply,
} from "./Rational"
export { squareRoot } from "./NonNegativeRational"
