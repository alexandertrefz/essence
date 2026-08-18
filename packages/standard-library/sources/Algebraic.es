import {
	Boolean    from "./Boolean.es"
	Comparable from "./Comparable.es"
	Integer    from "./Integer.es"
	Optional   from "./Optional.es"
	Ordering   from "./Ordering.es"
	Equatable  from "./Protocols.es"
	Printable  from "./Protocols.es"
	Rational   from "./Rational.es"
}

declarations {

	§ A real algebraic irrational — for now the quadratic slice `a + b·√d`.
	§ Every guarantee is exact: equality and ordering are decided
	§ symbolically, never by approximation, which is why Algebraic conforms
	§ to Comparable while Transcendental does not.
	namespace Algebraic for Algebraic
		is Equatable,
		is Printable,
		is Comparable {
		§§ Whether both Algebraics are the same number.
		§§
		§§ Normal forms make this exact — no approximation is consulted.
		§§
		§§ @param other — the Algebraic to compare with
		§§ @returns — `true` when the numbers are equal.
		is(_ other: Algebraic) -> Boolean {
			<- @::compare(to other)::is(#Equal)
		}

		§§ Whether the Algebraics are different numbers — exactly, no approximation is consulted.
		§§
		§§ @param other — the Algebraic to compare with
		§§ @returns — `true` when the numbers differ.
		isNot(_ other: Algebraic) -> Boolean {
			<- @::is(other)::negate()
		}

		§§ Orders the Algebraic against another Algebraic — exactly, by symbolic comparison.
		§§
		§§ @param other — the Algebraic to order against
		§§ @returns — `Ordering#Less`, `Ordering#Equal` or `Ordering#Greater`.
		compare(to other: Algebraic) -> Ordering

		§§ Adds a number to this Algebraic, exactly. Two Algebraics over the same radical stay in the slice; the radical parts may also cancel, leaving a Rational.
		overload add {
			(_ other: Integer) -> Algebraic

			(_ other: Rational) -> Algebraic

			§§ Adds another Algebraic. Over the same radical the sum stays exact — and may collapse to a Rational. Over different radicals the sum is not representable yet and is empty.
			(_ other: Algebraic) -> Optional<Rational | Algebraic>

			§§ Adds another Algebraic, and answers the given value when the radicals differ.
			§§
			§§ @param other — the Algebraic to add
			§§ @param defaultingTo — the value to answer with when there is no sum
			§§ @returns — the sum, or the given value in its place.
			(
				_ other: Algebraic,
				defaultingTo fallback: Rational | Algebraic,
			) -> Rational | Algebraic {
				<- @::add(other)::value(defaultingTo fallback)
			}
		}

		§§ Subtracts a number from this Algebraic, exactly. Subtracting an equal radical part leaves a Rational.
		overload subtract {
			(_ other: Integer) -> Algebraic {
				<- @::add(other::negate())
			}

			(_ other: Rational) -> Algebraic {
				<- @::add(other::negate())
			}

			(_ other: Algebraic) -> Optional<Rational | Algebraic> {
				<- @::add(other::negate())
			}
		}

		§§ Multiplies this Algebraic with a number, exactly. A radical times itself turns rational — `√2 · √2` is `2` — and multiplying by zero collapses to zero.
		overload multiply {
			(with other: Integer) -> Algebraic | Rational

			(with other: Rational) -> Algebraic | Rational

			§§ Multiplies with another Algebraic. Over the same radical the product stays exact — √2·√2 is exactly 2. Products of pure radicals combine across radicals (√2·√3 is √6); anything else is empty.
			(with other: Algebraic) -> Optional<Rational | Algebraic>

			§§ Multiplies with another Algebraic, and answers the given value when the product is not representable.
			§§
			§§ @param with — the Algebraic to multiply with
			§§ @param defaultingTo — the value to answer with when there is no product
			§§ @returns — the product, or the given value in its place.
			(
				with other: Algebraic,
				defaultingTo fallback: Rational | Algebraic,
			) -> Rational | Algebraic {
				<- @::multiply(with other)::value(defaultingTo fallback)
			}
		}

		§§ Divides this Algebraic by a number, exactly — via the conjugate, so dividing by an Algebraic itself can never fail. Dividing by an Integer or Rational is empty only for zero.
		overload divide {
			(by other: Integer) -> Optional<Algebraic>

			(by other: Rational) -> Optional<Algebraic>

			(by other: Algebraic) -> Optional<Rational | Algebraic>

			§§ Divides by an Integer, and answers the given value when the divisor is zero.
			§§
			§§ @param by — the divisor
			§§ @param defaultingTo — the value to answer with when there is no quotient
			§§ @returns — the quotient, or the given value in its place.
			(by other: Integer, defaultingTo fallback: Algebraic) -> Algebraic {
				<- @::divide(by other)::value(defaultingTo fallback)
			}

			§§ Divides by a Rational, and answers the given value when the divisor is zero.
			§§
			§§ @param by — the divisor
			§§ @param defaultingTo — the value to answer with when there is no quotient
			§§ @returns — the quotient, or the given value in its place.
			(
				by other: Rational,
				defaultingTo fallback: Algebraic,
			) -> Algebraic {
				<- @::divide(by other)::value(defaultingTo fallback)
			}

			§§ Divides by another Algebraic, and answers the given value when the quotient is not representable.
			§§
			§§ @param by — the divisor
			§§ @param defaultingTo — the value to answer with when there is no quotient
			§§ @returns — the quotient, or the given value in its place.
			(
				by other: Algebraic,
				defaultingTo fallback: Rational | Algebraic,
			) -> Rational | Algebraic {
				<- @::divide(by other)::value(defaultingTo fallback)
			}
		}

		§§ The Algebraic without its sign — its distance from zero. The sign of `a + b·√d` is exactly decidable, so no approximation is consulted.
		absolute() -> Algebraic {
			§ An Algebraic is never zero — a value whose radical cancels comes
			§ back a Rational instead — so it is below its own negation exactly
			§ when it is negative, which this Namespace's own `compare`
			§ decides. The covering `Number`'s `isLessThan(0)` says the same
			§ thing and reads better; what it costs is the whole numeric tower,
			§ in every Program that takes an absolute value.
			if @::compare(to @::negate())::is(#Less) {
				<- @::negate()
			} else {
				<- @
			}
		}

		§§ The Algebraic with its sign flipped. Negating an irrational leaves it irrational, so the result is again an Algebraic.
		negate() -> Algebraic

		§§ The exact symbolic form — `√2`, `3·√2` or `1 + √2`.
		toString() -> String
	}
}

export {
	Algebraic
}
