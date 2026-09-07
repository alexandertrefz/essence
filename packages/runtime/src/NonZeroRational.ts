// NOTE: The runtime module of the `NonZeroRational` Namespace — the Rationals a
// Program has proven are not zero. The Simplifier emits
// `<Namespace>.<method>(…)`, so a Namespace needs a module of its own name, and
// this is the whole of it.
import { negate as negateInteger } from "./Integer"
import {
	createRational,
	denominator,
	numerator,
	of__overload$2,
	type RationalType,
} from "./Rational"

// NOTE: The product is `Rational`'s own rather than a second one, for the
// reason `NonZeroInteger.ts` gives: a refinement erases before anything runs,
// so both operands ARE `RationalType`s here and the answer is the same
// cross-multiplication it always was. `multiply` is not an Overload in this
// Namespace, so it binds under the bare name. The numerator is the same read:
// a Rational is zero exactly when its numerator is, and the receiver is proven
// not to be, so the Integer `Rational.numerator` answers is a `NonZeroInteger`
// with nothing to do differently.
export { multiply__overload$1 as multiply, numerator } from "./Rational"

// NOTE: `Rational.of(@::numerator()::negate(), over @::denominator())`, which
// is the Essence body of `Rational::negate`, written a second time for the
// reason `reciprocal` below is: the entry beside it is an Essence body and
// exports nothing to import. It is spelled out of the same three natives that
// body reaches — the lowest-terms parts, Integer's negation and the total
// entry of `Rational.of` — so the parts it stores are the parts the Essence
// body stores. The golden harness calls both entries over one input, which is
// what keeps the two from drifting.
export function negate(rational: RationalType): RationalType {
	return of__overload$2(
		negateInteger(numerator(rational)),
		denominator(rational),
	)
}

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
