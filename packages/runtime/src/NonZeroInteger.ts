// NOTE: The runtime module of the `NonZeroInteger` Namespace — the Integers a
// Program has proven are not zero. The Simplifier emits
// `<Namespace>.<method>(…)`, so a Namespace needs a module of its own name, and
// this is the whole of it: every native member is a Function `Integer.ts`
// already holds, under the name this Namespace gives it.
//
// NOTE: It re-exports Integer's product rather than writing a second one, and
// that is the point rather than a shortcut. A refinement erases before anything
// runs: both operands ARE `IntegerType`s here, the answer is the same
// multiplication `Integer.ts` performs, and the evidence the Types carried was
// spent while compiling. A separate implementation could only be the same
// arithmetic written twice, with two places for it to disagree.
//
// NOTE: `multiply` is an Overload of three entries here, and only the first has
// a runtime export: the other two, a proven Integer scaling an Algebraic or a
// Transcendental, are written in Essence. The name carries the entry's
// position, so the first entry binds to `multiply__overload$1`, which is the
// name `Integer.ts` gives that Function too.
//
// NOTE: `raise` is the same shape, twice over. `Integer::raise` decides one
// case before it reads the power — zero to a negative exponent, which has none
// — and the receiver's proof is exactly what rules that case out, so the
// Function behind the decision is this Namespace's first entry. The second is
// `Integer`'s own non-negative entry under a second name: a Namespace over a
// refinement hides the base's Method of the same name, so the entry has to be
// declared here to stay reachable, and it is the same whole power either way.
//
// NOTE: `divide`, `absolute` and `negate` are the same shape once more. Each
// is `Integer`'s own native — the total division a proven divisor reaches, the
// distance from zero and the negation — under the name this Namespace gives it,
// and what the Namespace adds is only what the answer's Type says: a quotient
// of two non-zero Integers is a `NonZeroRational`, a distance from zero of a
// non-zero Integer is a `PositiveInteger`, and a negation stays away from zero.
// `divide` is not an Overload here, so it binds under the bare name.
export {
	absolute,
	divide__overload$4 as divide,
	multiply__overload$1,
	negate,
	power as raise__overload$1,
	raise__overload$3 as raise__overload$2,
} from "./Integer"
