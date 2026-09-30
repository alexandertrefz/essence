// The `NonZeroRational` Namespace. See "Refined Namespaces" in DEVELOPMENT.md.
import { negate as negateInteger } from "./Integer"
import {
	createRational,
	denominator,
	numerator,
	of__overload$2,
	type RationalType,
} from "./Rational"

// A Rational is zero exactly when its numerator is, so the numerator of a
// proven receiver is a `NonZeroInteger` with nothing to do differently.
export {
	absolute,
	multiply__overload$1 as multiply,
	numerator,
} from "./Rational"

// The Essence body of `Rational::negate`, built from the natives that body
// calls so both store the same parts. The Essence entry exports nothing to
// import. The golden harness checks that both agree.
export function negate(rational: RationalType): RationalType {
	return of__overload$2(
		negateInteger(numerator(rational)),
		denominator(rational),
	)
}

// `Rational::reciprocal` without the zero check, which the proof already made.
// `createRational` moves a negative sign onto the numerator, and reduction
// happens on read, so the stored parts need not be in lowest terms.
export function reciprocal(rational: RationalType): RationalType {
	return createRational(rational.denominator, rational.numerator)
}
