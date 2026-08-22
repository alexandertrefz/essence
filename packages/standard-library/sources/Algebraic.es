import {
	Boolean        from "./Boolean.es"
	Integer        from "./Integer.es"
	NonZeroInteger from "./Integer.es"
	Optional       from "./Optional.es"
	Orderable      from "./Orderable.es"
	Ordering       from "./Ordering.es"
	Equatable      from "./Protocols.es"
	Printable      from "./Protocols.es"
	Rational       from "./Rational.es"
}

declarations {

	§ A real algebraic irrational, for now the quadratic slice `a + b·√d`.
	§ Equality and ordering are symbolic and exact, which is why Algebraic
	§ conforms to Comparable and Transcendental does not.
	namespace Algebraic for Algebraic is Equatable, is Printable, is Orderable {
		§§ Answers whether both Algebraics are the same number.
		§§
		§§ Normal forms decide the answer exactly. No approximation is consulted.
		§§
		§§ @param _ — the Algebraic to compare with
		§§ @returns — `true` when the numbers are equal.
		is(_ other: Algebraic) -> Boolean {
			<- @::compare(to other)::is(#Equal)
		}

		§§ Orders the Algebraic against another Algebraic.
		§§
		§§ The comparison is symbolic, so it is exact.
		§§
		§§ @param to — the Algebraic to order against
		§§ @returns — `Ordering#Less`, `Ordering#Equal` or `Ordering#Greater`.
		compare(to other: Algebraic) -> Ordering

		§§ Answers the Algebraic as a String, in the exact symbolic form: `√2`, `3·√2` or `1 + √2`.
		toString() -> String

		§§ Answers the exact sum of the Algebraic and a number.
		§§
		§§ Two Algebraics over the same radical stay in the slice. Their radical parts can also cancel, which leaves a Rational. The `defaultingTo:` entry answers the given value in place of empty.
		overload add {
			(_ other: Integer) -> Algebraic

			(_ other: Rational) -> Algebraic

			§§ Answers the exact sum of the two Algebraics.
			§§
			§§ Over the same radical the sum stays in the slice, and can collapse to a Rational. Over different radicals there is no sum yet, and the answer is empty.
			(_ other: Algebraic) -> Optional<Rational | Algebraic>

			§§ Answers the exact sum of the two Algebraics.
			§§
			§§ Over different radicals there is no sum, and the answer is the given value.
			§§
			§§ @param _ — the Algebraic to add
			§§ @param defaultingTo — the value to answer with when there is no sum
			§§ @returns — the sum, or the given value in its place.
			(
				_ other: Algebraic,
				defaultingTo fallback: Rational | Algebraic,
			) -> Rational | Algebraic {
				<- @::add(other)::value(defaultingTo fallback)
			}
		}

		§§ Answers the exact difference of the Algebraic and a number.
		§§
		§§ Subtracting an equal radical part leaves a Rational. The `defaultingTo:` entry answers the given value in place of empty.
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

			§§ Answers the exact difference of the two Algebraics.
			§§
			§§ Over different radicals there is no difference, and the answer is the given value.
			§§
			§§ @param _ — the Algebraic to subtract
			§§ @param defaultingTo — the value to answer with when there is no difference
			§§ @returns — the difference, or the given value in its place.
			(
				_ other: Algebraic,
				defaultingTo fallback: Rational | Algebraic,
			) -> Rational | Algebraic {
				<- @::subtract(other)::value(defaultingTo fallback)
			}
		}

		§§ Answers the exact product of the Algebraic and a number.
		§§
		§§ A radical times itself turns rational: `√2 · √2` is `2`. Multiplying by zero answers zero. Multiplying by a NonZeroInteger keeps the radical, so that entry answers an Algebraic. The `defaultingTo:` entry answers the given value in place of empty.
		overload multiply {
			(with other: Integer) -> Algebraic | Rational

			(with other: Rational) -> Algebraic | Rational

			§§ Answers the exact product of the two Algebraics.
			§§
			§§ Over the same radical the product stays exact: `√2 · √2` is `2`. Two pure radicals combine across radicals: `√2 · √3` is `√6`. Anything else is empty.
			(with other: Algebraic) -> Optional<Rational | Algebraic>

			§§ Answers the exact product of the two Algebraics.
			§§
			§§ Where there is no product, the answer is the given value.
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

			§§ Answers the exact product of the Algebraic and a factor proven not to be zero.
			§§
			§§ A non-zero Integer scales both parts and leaves the radical in place. The answer is again an Algebraic rather than a Union.
			§§
			§§ @param with — the factor, proven not to be zero
			§§ @returns — the exact product.
			(with other: NonZeroInteger) -> Algebraic
		}

		§§ Answers the exact quotient of the Algebraic and a number.
		§§
		§§ Dividing by an Integer or a Rational is empty only for zero. Dividing by a NonZeroInteger can not fail, because that divisor is proven. Dividing by an Algebraic multiplies by its reciprocal, which the conjugate always gives. That quotient is empty wherever the matching product is empty. The `defaultingTo:` entries answer the given value in place of empty.
		overload divide {
			(by other: Integer) -> Optional<Algebraic>

			(by other: Rational) -> Optional<Algebraic>

			(by other: Algebraic) -> Optional<Rational | Algebraic>

			§§ Answers the exact quotient of the Algebraic and an Integer.
			§§
			§§ A zero divisor answers the given value.
			§§
			§§ @param by — the divisor
			§§ @param defaultingTo — the value to answer with when there is no quotient
			§§ @returns — the quotient, or the given value in its place.
			(by other: Integer, defaultingTo fallback: Algebraic) -> Algebraic {
				<- @::divide(by other)::value(defaultingTo fallback)
			}

			§§ Answers the exact quotient of the Algebraic and a Rational.
			§§
			§§ A zero divisor answers the given value.
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

			§§ Answers the exact quotient of the two Algebraics.
			§§
			§§ Where there is no quotient, the answer is the given value.
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

			§§ Answers the exact quotient of the Algebraic and a divisor proven not to be zero.
			§§
			§§ The division can not fail, so the answer is the quotient itself rather than an Optional.
			§§
			§§ @param by — the divisor, proven not to be zero
			§§ @returns — the exact quotient.
			(by other: NonZeroInteger) -> Algebraic
		}

		§§ Answers the Algebraic without its sign, which is its distance from zero.
		§§
		§§ The sign of `a + b·√d` is exactly decidable. No approximation is consulted.
		absolute() -> Algebraic {
			§ An Algebraic is never zero, so it is below its own negation
			§ exactly when it is negative. This Namespace's own `compare`
			§ decides that. The covering `Number`'s `isLessThan(0)` says the
			§ same and reaches the whole numeric tower; see DEVELOPMENT.md,
			§ Why bodies look the way they do.
			if @::compare(to @::negate())::is(#Less) {
				<- @::negate()
			} else {
				<- @
			}
		}

		§§ Answers the Algebraic with its sign flipped.
		§§
		§§ Negating an irrational leaves it irrational, so the answer is again an Algebraic.
		negate() -> Algebraic
	}
}

export {
	Algebraic
}
