declarations {

	§ A number that is provably not algebraic — for now the linear-in-π
	§ slice `a + b·π`, which is how PI and TAU stay exact. `is` means
	§ equality of canonical forms: reflexive and sound, and within this
	§ grammar it coincides with numeric equality. Transcendental
	§ deliberately does NOT conform to Comparable — deciding
	§ `Ordering#Equal` is undecidable for transcendentals in general — but
	§ every cross-kind comparison is total through the `Number` Namespace,
	§ whose covering `compareTo` hand-writes those cells.
	namespace Transcendental for Transcendental is Equatable, is Printable {
		§§ Whether both Transcendentals have the same canonical form.
		§§
		§§ Within the current grammar this is exactly numeric equality.
		§§
		§§ @param other the Transcendental to compare with
		§§ @returns `true` when the canonical forms agree.
		is(_ other: Transcendental) -> Boolean

		§§ Whether the Transcendentals have different canonical forms — within the current grammar, different numbers.
		§§
		§§ @param other the Transcendental to compare with
		§§ @returns `true` when the canonical forms differ.
		isNot(_ other: Transcendental) -> Boolean {
			<- @::is(other)::negate()
		}

		§§ Adds a number to this Transcendental, exactly. Two Transcendentals may cancel their π terms, leaving a Rational.
		overload add {
			(_ other: Integer) -> Transcendental

			(_ other: Rational) -> Transcendental

			§§ Adds another Transcendental — the π-parts may cancel, collapsing the sum to a Rational.
			(_ other: Transcendental) -> Rational | Transcendental
		}

		§§ Subtracts a number from this Transcendental, exactly. Subtracting an equal π term leaves a Rational.
		overload subtract {
			(_ other: Integer) -> Transcendental

			(_ other: Rational) -> Transcendental

			(_ other: Transcendental) -> Rational | Transcendental
		}

		§§ Multiplies this Transcendental with an Integer or Rational, exactly — multiplying by zero collapses to zero. Two Transcendentals can not be multiplied: `π·π` would leave the linear-in-π grammar.
		overload multiplyWith {
			(_ other: Integer) -> Transcendental | Rational

			(_ other: Rational) -> Transcendental | Rational
		}

		§§ Divides this Transcendental by a number, exactly. Dividing by an Integer or Rational gives `Nothing` only for zero; dividing by another Transcendental succeeds exactly when the two are proportional — `TAU::divideBy(PI)` is `2` — and gives `Nothing` otherwise.
		overload divideBy {
			(_ other: Integer) -> Optional<Transcendental>

			(_ other: Rational) -> Optional<Transcendental>

			§§ Divides by another Transcendental. Proportional values give an exact Rational — TAU divided by PI is exactly 2. Anything else is not representable yet and gives Nothing.
			(_ other: Transcendental) -> Optional<Rational>
		}

		§§ The Transcendental without its sign — its distance from zero. The sign of `a + b·π` against zero is decidable, since the value can never equal a rational.
		absolute() -> Transcendental

		§§ The Transcendental with its sign flipped. The π term keeps its non-zero coefficient, so the result is again a Transcendental.
		negated() -> Transcendental

		§§ The exact symbolic form — `π`, `2·π` or `1 + π`.
		toString() -> String
	}
}
