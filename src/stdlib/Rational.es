declarations {

	§ Exact ratios of Integers, kept in lowest terms with the sign on the
	§ numerator. The literal form is `3/4`; `Rational.of` builds one from two
	§ computed Integers. Arithmetic never rounds — an operation that leaves
	§ the Rationals widens into the Type that can still say the answer.
	namespace Rational for Rational is Equatable, is Printable, is Comparable {
		§§ Builds the Rational one Integer over another — the way to write a ratio of computed values, where the literal form `3/4` is not available.
		§§
		§§ @param numerator the numerator
		§§ @param over the denominator
		§§ @returns the Rational, or `Nothing` when the denominator is zero.
		static of(_ numerator: Integer, over denominator: Integer) -> Optional<Rational>

		§§ Checks whether the Rational has the same value as another — compared in lowest terms, so `1/2 is 2/4` holds.
		§§
		§§ @param other the Rational to compare against
		§§ @returns `true` when both are equal.
		is(_ other: Rational) -> Boolean {
			<- @::compareTo(other)::is(Ordering#Equal)
		}

		§§ Checks whether the Rational has a different value than another.
		§§
		§§ @param other the Rational to compare against
		§§ @returns `true` when the two differ.
		isNot(_ other: Rational) -> Boolean {
			<- @::is(other)::negate()
		}

		§§ Adds a number to this Rational, staying exact for every member of the numeric tower.
		overload add {
			(_ other: Rational) -> Rational

			(_ other: Integer) -> Rational

			(_ other: Algebraic) -> Algebraic

			(_ other: Transcendental) -> Transcendental
		}

		§§ Subtracts a number from this Rational, staying exact for every member of the numeric tower.
		overload subtract {
			(_ other: Rational) -> Rational {
				<- @::add(other::negate())
			}

			(_ other: Integer) -> Rational {
				<- @::add(other::negate())
			}

			(_ other: Algebraic) -> Algebraic {
				<- @::add(other::negate())
			}

			(_ other: Transcendental) -> Transcendental {
				<- @::add(other::negate())
			}
		}

		§§ Divides this Rational by a number, exactly. Dividing by a possibly-zero Integer or Rational gives `Nothing` for zero; dividing by an Algebraic can never fail — an irrational is never zero.
		overload divide {
			(by other: Rational) -> Optional<Rational>

			(by other: Integer) -> Optional<Rational>

			(by other: Algebraic) -> Algebraic | Rational
		}

		§§ Multiplies this Rational with a number, staying exact for every member of the numeric tower.
		overload multiply {
			(with other: Rational) -> Rational

			(with other: Integer) -> Rational

			(with other: Algebraic) -> Algebraic | Rational

			(with other: Transcendental) -> Transcendental | Rational
		}

		§§ Whether this Rational is strictly below the given number.
		overload isLessThan {
			(_ other: Rational) -> Boolean {
				<- @::compareTo(other)::is(Ordering#Less)
			}

			(_ other: Integer) -> Boolean
		}

		§§ Whether this Rational is below the given number, or equal to it.
		overload isLessThanOrEqualTo {
			(_ other: Rational) -> Boolean {
				<- @::isGreaterThan(other)::negate()
			}

			(_ other: Integer) -> Boolean
		}

		§§ Whether this Rational is strictly above the given number.
		overload isGreaterThan {
			(_ other: Rational) -> Boolean {
				<- @::compareTo(other)::is(Ordering#Greater)
			}

			(_ other: Integer) -> Boolean
		}

		§§ Whether this Rational is above the given number, or equal to it.
		overload isGreaterThanOrEqualTo {
			(_ other: Rational) -> Boolean {
				<- @::isLessThan(other)::negate()
			}

			(_ other: Integer) -> Boolean
		}

		§§ The exact square root. A perfect square gives a Rational; any other non-negative value gives an exact Algebraic — and a negative gives Nothing.
		squareRoot() -> Optional<Rational | Algebraic>

		§§ The numerator of the Rational in lowest terms. The sign of the Rational lives here — the denominator is always positive.
		numerator() -> Integer

		§§ The denominator of the Rational in lowest terms — always positive.
		denominator() -> Integer

		§§ The Rational without its sign — its distance from zero.
		absolute() -> Rational {
			if @::isLessThan(0/1) { <- @::negate() }
			<- @
		}

		§§ The Rational with its sign flipped.
		negate() -> Rational {
			<- Rational.of(@::numerator()::negate(), over @::denominator())::otherwise(@)
		}

		§§ The Rational flipped upside down — the numerator and denominator exchanged.
		§§
		§§ @returns the reciprocal, or `Nothing` for zero.
		reciprocal() -> Optional<Rational> {
			<- Rational.of(@::denominator(), over @::numerator())
		}

		§§ Whether the Rational is a whole number — its denominator in lowest terms is one.
		isWholeNumber() -> Boolean {
			<- @::denominator()::is(1)
		}

		§§ The nearest Integer. A value exactly halfway between two rounds away from zero — `1/2` gives `1`, `0 - 1/2` gives `0 - 1`.
		round() -> Integer

		§§ The greatest Integer at or below the Rational — the floor.
		roundDown() -> Integer {
			constant truncatedValue = @::truncate()
			if @::isLessThan(0/1)::and(@::isWholeNumber()::negate()) {
				<- truncatedValue::subtract(1)
			}
			<- truncatedValue
		}

		§§ The lowest Integer at or above the Rational — the ceiling.
		roundUp() -> Integer {
			constant truncatedValue = @::truncate()
			if @::isGreaterThan(0/1)::and(@::isWholeNumber()::negate()) {
				<- truncatedValue::add(1)
			}
			<- truncatedValue
		}

		§§ The Integer part of the Rational — the fractional part cut off, rounding towards zero.
		truncate() -> Integer

		§§ Raises the Rational to the given power. A negative exponent gives the exact reciprocal power. Zero to the power of zero is one.
		§§
		§§ @param exponent the exponent
		§§ @returns the power, or `Nothing` when raising zero to a negative power.
		raise(to exponent: Integer) -> Optional<Rational>

		§§ Reads a Rational from its text form — a fraction like `3/4`, a decimal like `0.75`, or a whole number like `3`, each with an optional minus sign.
		§§
		§§ @param text the text to read
		§§ @returns the Rational, or `Nothing` when the text has any other shape or divides by zero.
		static parse(_ text: String) -> Optional<Rational>

		§§ Represents the Rational as a String — `"3/4"` in lowest terms, or its decimal form with `formatAs "decimal"`.
		overload toString {
			() -> String

			(formatAs: String) -> String
		}

		§§ Orders the Rational against another Rational.
		§§
		§§ @param other the Rational to order against
		§§ @returns `Ordering#Less`, `Ordering#Equal` or `Ordering#Greater`.
		compareTo(_ other: Rational) -> Ordering
	}
}
