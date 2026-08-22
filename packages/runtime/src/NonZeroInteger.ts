// NOTE: The runtime module of the `NonZeroInteger` Namespace — the Integers a
// Program has proven are not zero. The Simplifier emits
// `<Namespace>.<method>(…)`, so a Namespace needs a module of its own name, and
// this is the whole of it: every native member is a Function `Integer.ts`
// already holds, under the name this Namespace gives it.
//
// NOTE: It re-exports Integer's product rather than writing a second one, and
// that is the point rather than a shortcut. A refinement erases before anything
// runs: both operands ARE `IntegerType`s here, the answer is the same bigint
// multiplication it always was, and the evidence the Types carried was spent
// while compiling. A separate implementation could only be the same three
// characters written twice, with two places for them to disagree.
//
// NOTE: Two names for a Namespace that declares four entries, because two of
// them — a proven Integer scaling an Algebraic or a Transcendental — are
// written in Essence, and a Method implemented there has no runtime export at
// all. The name carries the entry's position: `multiply` became an Overload, so
// its first entry binds to `multiply__overload$1`, which is the name
// `Integer.ts` gives that Function too.
//
// NOTE: `raise` is the same shape. `Integer::raise` decides one case before it
// reads the power — zero to a negative exponent, which has none — and the
// receiver's proof is exactly what rules that case out. So the Function behind
// the decision IS this Namespace's `raise`, re-exported under its name.
export { multiply__overload$1, power as raise } from "./Integer"
