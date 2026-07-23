declarations {

	§ The whole numeric tower under one name. The `name` a use site sees is
	§ display-only — Hovers, Inlay Hints and Diagnostics print this Union as
	§ `Number` instead of spelling out all four members. Assignability
	§ ignores Union names entirely.
	type Number = Integer | Rational | Algebraic | Transcendental

	§ `Irrational` is a transparent alias for `Algebraic | Transcendental`
	§ — the pair are definitional complements (transcendental means "not
	§ algebraic"), so the alias covers exactly the representable irrationals
	§ and makes `π is Irrational` a true sentence.
	type Irrational = Algebraic | Transcendental

	§ The Union-level behaviour of `Number` — cross-member semantics only a
	§ covering Namespace can define. `is` is numeric equality (`1 is 1/1` is
	§ true), while the member Namespaces stay representational; Method target
	§ specificity routes single-member receivers to those, so these Methods
	§ only answer for Union-typed receivers and mixed-member Arguments.
	§
	§ `compareTo` hand-writes all sixteen member cells and keeps the
	§ Comparable conformance even though Transcendental alone does not
	§ conform: every cross-kind cell is total because equality across kinds
	§ is impossible by definition, and the only cell that could ever need a
	§ documented cutoff — Transcendental against Transcendental — is exact
	§ within the current linear-in-π grammar. The `isLessThan` family reads
	§ that same order, so it lives here for the same reason and is the one
	§ place two Transcendentals can be compared with a `<`.
	namespace Number for Number is Equatable, is Printable, is Comparable {
		§§ The ratio of a circle's circumference to its diameter, exactly.
		static PI: Transcendental

		§§ Twice `PI` — the ratio of a circle's circumference to its radius.
		static TAU: Transcendental

		§§ Checks whether the Number has the same numeric value as another Number — an Integer and a Rational are the same Number when their values are equal, so `1 is 1/1` holds.
		§§
		§§ @param other the Number to compare against
		§§ @returns `true` when both Numbers have the same numeric value.
		is(_ other: Number) -> Boolean {
			<- @::compareTo(other)::is(Ordering#Equal)
		}

		§§ Checks whether the Number has a different numeric value than another Number.
		§§
		§§ @param other the Number to compare against
		§§ @returns `true` when the Numbers have different numeric values.
		isNot(_ other: Number) -> Boolean {
			<- @::is(other)::negate()
		}

		§§ Represents the Number as a String, in the notation of the member Type it currently holds.
		toString() -> String {
			<- match @ -> String {
				case Integer { <- @::toString() }
				case Rational { <- @::toString() }
				case Algebraic { <- @::toString() }
				case Transcendental { <- @::toString() }
			}
		}

		§§ Orders the Number against another Number by numeric value, across Integers and Rationals.
		§§
		§§ @param other the Number to order against
		§§ @returns `Ordering#Less`, `Ordering#Equal` or `Ordering#Greater`.
		compareTo(_ other: Number) -> Ordering

		§§ Whether this Number is strictly below the given one.
		§§
		§§ @param other the Number to compare against
		isLessThan(_ other: Number) -> Boolean {
			<- @::compareTo(other)::is(Ordering#Less)
		}

		§§ Whether this Number is below the given one, or equal to it.
		§§
		§§ @param other the Number to compare against
		isLessThanOrEqualTo(_ other: Number) -> Boolean {
			<- @::isGreaterThan(other)::negate()
		}

		§§ Whether this Number is strictly above the given one.
		§§
		§§ @param other the Number to compare against
		isGreaterThan(_ other: Number) -> Boolean {
			<- @::compareTo(other)::is(Ordering#Greater)
		}

		§§ Whether this Number is above the given one, or equal to it.
		§§
		§§ @param other the Number to compare against
		isGreaterThanOrEqualTo(_ other: Number) -> Boolean {
			<- @::isLessThan(other)::negate()
		}

		§§ Whether this Number lies between the two given ones, both included — across every member of the numeric tower, so `Number.PI::isBetween(3, and 22/7)` holds. Bounds in the wrong order enclose no Number, so the answer is `false`.
		§§
		§§ @param lower the lower bound, included
		§§ @param and the upper bound, included
		§§ @returns `true` when the Number is within the bounds.
		isBetween(_ lower: Number, and upper: Number) -> Boolean {
			<- @::isGreaterThanOrEqualTo(lower)::and(@::isLessThanOrEqualTo(upper))
		}

		§§ Adds up every Number in the List. The empty List sums to zero.
		§§
		§§ @returns the exact total.
		overload static sum {
			(_ integers: List<Integer>) -> Integer

			(_ rationals: List<Rational>) -> Rational

			(_ numbers: List<Integer | Rational>) -> Integer | Rational
		}

		§§ Multiplies every Number in the List together. The empty List multiplies to one.
		§§
		§§ @returns the exact product.
		overload static product {
			(_ integers: List<Integer>) -> Integer

			(_ rationals: List<Rational>) -> Rational

			(_ numbers: List<Integer | Rational>) -> Integer | Rational
		}

		§§ The arithmetic mean of the Numbers in the List — their sum divided by their count, as an exact Rational.
		§§
		§§ @returns the mean, or `Nothing` for the empty List — no Numbers have no mean.
		overload static average {
			(_ integers: List<Integer>) -> Optional<Rational>

			(_ rationals: List<Rational>) -> Optional<Rational>

			(_ numbers: List<Integer | Rational>) -> Optional<Rational>
		}

		§§ The lower of two Numbers, or the lowest in a List of them.
		§§
		§§ @returns the lowest Number — `Nothing` for the empty List, which has none.
		overload static lowestNumber {
			(_ firstNumber: Integer, _ secondNumber: Integer) -> Integer {
				if firstNumber::isLessThanOrEqualTo(secondNumber) { <- firstNumber }
				<- secondNumber
			}

			(_ firstNumber: Rational, _ secondNumber: Rational) -> Rational {
				if firstNumber::isLessThanOrEqualTo(secondNumber) { <- firstNumber }
				<- secondNumber
			}

			(_ firstNumber: Integer, _ secondNumber: Rational) -> Integer | Rational {
				if firstNumber::isLessThanOrEqualTo(secondNumber) { <- firstNumber }
				<- secondNumber
			}

			(_ firstNumber: Rational, _ secondNumber: Integer) -> Integer | Rational {
				if firstNumber::isLessThanOrEqualTo(secondNumber) { <- firstNumber }
				<- secondNumber
			}

			(_ integers: List<Integer>) -> Optional<Integer>

			(_ rationals: List<Rational>) -> Optional<Rational>

			(_ numbers: List<Integer | Rational>) -> Optional<Integer | Rational>
		}

		§§ The greater of two Numbers, or the greatest in a List of them.
		§§
		§§ @returns the greatest Number — `Nothing` for the empty List, which has none.
		overload static greatestNumber {
			(_ firstNumber: Integer, _ secondNumber: Integer) -> Integer {
				if firstNumber::isGreaterThanOrEqualTo(secondNumber) { <- firstNumber }
				<- secondNumber
			}

			(_ firstNumber: Rational, _ secondNumber: Rational) -> Rational {
				if firstNumber::isGreaterThanOrEqualTo(secondNumber) { <- firstNumber }
				<- secondNumber
			}

			(_ firstNumber: Integer, _ secondNumber: Rational) -> Integer | Rational {
				if firstNumber::isGreaterThanOrEqualTo(secondNumber) { <- firstNumber }
				<- secondNumber
			}

			(_ firstNumber: Rational, _ secondNumber: Integer) -> Integer | Rational {
				if firstNumber::isGreaterThanOrEqualTo(secondNumber) { <- firstNumber }
				<- secondNumber
			}

			(_ integers: List<Integer>) -> Optional<Integer>

			(_ rationals: List<Rational>) -> Optional<Rational>

			(_ numbers: List<Integer | Rational>) -> Optional<Integer | Rational>
		}
	}
}
