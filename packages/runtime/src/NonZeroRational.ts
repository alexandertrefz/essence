// NOTE: The runtime module of the `NonZeroRational` Namespace — the Rationals a
// Program has proven are not zero. The Simplifier emits
// `<Namespace>.<method>(…)`, so a Namespace needs a module of its own name, and
// this is the whole of it.
import { createRational, type RationalType } from "./Rational"

// NOTE: The product is `Rational`'s own rather than a second one, for the
// reason `NonZeroInteger.ts` gives: a refinement erases before anything runs,
// so both operands ARE `RationalType`s here and the answer is the same
// cross-multiplication it always was. `multiply` is not an Overload in this
// Namespace, so it binds under the bare name.
export { multiply__overload$1 as multiply } from "./Rational"

// NOTE: `Rational.of(@::denominator(), over @::numerator())`, which is the
// Essence body of `Rational::reciprocal`, with the zero check taken OUT rather
// than skipped — the receiver is proven, so the check was already made. The
// parts are exchanged as they are STORED rather than in lowest terms:
// `createRational` is the gateway that moves a negative sign onto the numerator
// and reduction happens on read, so `2/4` answers `2` exactly as `1/2` answers
// `2`.
export function reciprocal(rational: RationalType): RationalType {
	return createRational(rational.denominator, rational.numerator)
}
