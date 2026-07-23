declarations {

	§ A real algebraic irrational — for now the quadratic slice `a + b·√d`.
	§ Every guarantee is exact: equality and ordering are decided
	§ symbolically, never by approximation, which is why Algebraic conforms
	§ to Comparable while Transcendental does not.
	namespace Algebraic for Algebraic is Equatable, is Printable, is Comparable {
		§§ Whether both Algebraics are the same number.
		§§
		§§ Normal forms make this exact — no approximation is consulted.
		§§
		§§ @param other the Algebraic to compare with
		§§ @returns `true` when the numbers are equal.
		is(_ other: Algebraic) -> Boolean

		§§ Whether the Algebraics are different numbers — exactly, no approximation is consulted.
		§§
		§§ @param other the Algebraic to compare with
		§§ @returns `true` when the numbers differ.
		isNot(_ other: Algebraic) -> Boolean {
			<- @::is(other)::negate()
		}

		§§ Orders the Algebraic against another Algebraic — exactly, by symbolic comparison.
		§§
		§§ @param other the Algebraic to order against
		§§ @returns `Ordering#Less`, `Ordering#Equal` or `Ordering#Greater`.
		compareTo(_ other: Algebraic) -> Ordering

		§§ Adds a number to this Algebraic, exactly. Two Algebraics over the same radical stay in the slice; the radical parts may also cancel, leaving a Rational.
		overload add {
			(_ other: Integer) -> Algebraic

			(_ other: Rational) -> Algebraic

			§§ Adds another Algebraic. Over the same radical the sum stays exact — and may collapse to a Rational. Over different radicals the sum is not representable yet and gives Nothing.
			(_ other: Algebraic) -> Optional<Rational | Algebraic>
		}

		§§ Subtracts a number from this Algebraic, exactly. Subtracting an equal radical part leaves a Rational.
		overload subtract {
			(_ other: Integer) -> Algebraic

			(_ other: Rational) -> Algebraic

			(_ other: Algebraic) -> Optional<Rational | Algebraic>
		}

		§§ Multiplies this Algebraic with a number, exactly. A radical times itself turns rational — `√2 · √2` is `2` — and multiplying by zero collapses to zero.
		overload multiplyWith {
			(_ other: Integer) -> Algebraic | Rational

			(_ other: Rational) -> Algebraic | Rational

			§§ Multiplies with another Algebraic. Over the same radical the product stays exact — √2·√2 is exactly 2. Products of pure radicals combine across radicals (√2·√3 is √6); anything else gives Nothing.
			(_ other: Algebraic) -> Optional<Rational | Algebraic>
		}

		§§ Divides this Algebraic by a number, exactly — via the conjugate, so dividing by an Algebraic itself can never fail. Dividing by an Integer or Rational gives `Nothing` only for zero.
		overload divideBy {
			(_ other: Integer) -> Optional<Algebraic>

			(_ other: Rational) -> Optional<Algebraic>

			(_ other: Algebraic) -> Optional<Rational | Algebraic>
		}

		§§ The Algebraic without its sign — its distance from zero. The sign of `a + b·√d` is exactly decidable, so no approximation is consulted.
		absolute() -> Algebraic

		§§ The Algebraic with its sign flipped. Negating an irrational leaves it irrational, so the result is again an Algebraic.
		negated() -> Algebraic

		§§ The exact symbolic form — `√2`, `3·√2` or `1 + √2`.
		toString() -> String
	}
}
