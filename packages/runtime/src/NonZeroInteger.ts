// NOTE: The runtime module of the `NonZeroInteger` Namespace — the Integers a
// Program has proven are not zero. The Simplifier emits
// `<Namespace>.<method>(…)`, so a Namespace needs a module of its own name, and
// this is the whole of it.
//
// NOTE: It re-exports Integer's product rather than writing a second one, and
// that is the point rather than a shortcut. A refinement erases before anything
// runs: both operands ARE `IntegerType`s here, the answer is the same bigint
// multiplication it always was, and the evidence the Types carried was spent
// while compiling. A separate implementation could only be the same three
// characters written twice, with two places for them to disagree.
export { multiply__overload$1 as multiply } from "./Integer"
