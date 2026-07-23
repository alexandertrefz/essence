declarations {

	§ Whole numbers of arbitrary size, and the exact arithmetic over them.
	§ Every Method here stays exact: an operation that leaves the Integers
	§ widens into the Type that can still say the answer — a Rational, an
	§ Algebraic or a Transcendental — rather than rounding.
	namespace Integer for Integer is Equatable, is Printable, is Comparable {
		§§ Checks whether the Integer has the same value as another.
		§§
		§§ @param other the Integer to compare against
		§§ @returns `true` when both are equal.
		is(_ other: Integer) -> Boolean

		§§ Checks whether the Integer has a different value than another.
		§§
		§§ @param other the Integer to compare against
		§§ @returns `true` when the two differ.
		isNot(_ other: Integer) -> Boolean

		§§ Adds a number to this Integer.
		overload add {
			§§ Adds two Integers, giving an Integer.
			§§
			§§ @param other the Integer to add
			(_ other: Integer) -> Integer

			§§ Adds a Rational to an Integer. The result is a Rational, since the sum need not be whole.
			§§
			§§ @param other the Rational to add
			(_ other: Rational) -> Rational

			§§ Adds an Algebraic to an Integer. Shifting the rational part of `a + b·√d` leaves the radical untouched, so the sum is exact.
			§§
			§§ @param other the Algebraic to add
			(_ other: Algebraic) -> Algebraic

			§§ Adds a Transcendental to an Integer. Shifting the rational part of `a + b·π` leaves the π term untouched, so the sum is exact.
			§§
			§§ @param other the Transcendental to add
			(_ other: Transcendental) -> Transcendental
		}

		§§ Subtracts a number from this Integer, staying exact for every member of the numeric tower.
		overload subtract {
			(_ other: Integer) -> Integer

			(_ other: Rational) -> Rational

			(_ other: Algebraic) -> Algebraic

			(_ other: Transcendental) -> Transcendental
		}

		§§ Divides this Integer by a number, exactly. Dividing by a possibly-zero Integer or Rational gives `Nothing` for zero; dividing by an Algebraic can never fail — an irrational is never zero.
		overload divideBy {
			(_ other: Integer) -> Optional<Rational>

			(_ other: Rational) -> Optional<Rational>

			(_ other: Algebraic) -> Algebraic | Rational
		}

		§§ Multiplies this Integer with a number, staying exact for every member of the numeric tower.
		overload multiplyWith {
			(_ other: Integer) -> Integer

			(_ other: Rational) -> Rational

			(_ other: Algebraic) -> Algebraic | Rational

			(_ other: Transcendental) -> Transcendental | Rational
		}

		§§ Whether this Integer is strictly below the given number.
		overload isLessThan {
			(_ other: Integer) -> Boolean

			(_ other: Rational) -> Boolean
		}

		§§ Whether this Integer is below the given number, or equal to it.
		overload isLessThanOrEqualTo {
			(_ other: Integer) -> Boolean

			(_ other: Rational) -> Boolean
		}

		§§ Whether this Integer is strictly above the given number.
		overload isGreaterThan {
			(_ other: Integer) -> Boolean

			(_ other: Rational) -> Boolean
		}

		§§ Whether this Integer is above the given number, or equal to it.
		overload isGreaterThanOrEqualTo {
			(_ other: Integer) -> Boolean

			(_ other: Rational) -> Boolean
		}

		§§ The exact square root. A perfect square gives a Integer; any other non-negative value gives an exact Algebraic — and a negative gives Nothing.
		squareRoot() -> Optional<Integer | Algebraic>

		§§ The Integer without its sign — its distance from zero.
		absolute() -> Integer

		§§ The Integer with its sign flipped.
		negated() -> Integer

		§§ Whether the Integer is divisible by two. Zero is even.
		isEven() -> Boolean

		§§ Whether the Integer is not divisible by two.
		isOdd() -> Boolean

		§§ Whether the Integer is above zero. Zero is neither positive nor negative.
		isPositive() -> Boolean

		§§ Whether the Integer is below zero. Zero is neither positive nor negative.
		isNegative() -> Boolean

		§§ Whether the Integer is exactly zero.
		isZero() -> Boolean

		§§ The remainder of Euclidean division — always at least zero and below the divisor's magnitude, whatever the signs of the operands. `(0 - 7)::remainderOf(dividingBy 3)` is `2`.
		§§
		§§ @param dividingBy the divisor
		§§ @returns the remainder, or `Nothing` when dividing by zero.
		remainderOf(dividingBy divisor: Integer) -> Optional<Integer>

		§§ Raises the Integer to the given power. A non-negative exponent gives an Integer, a negative one the exact reciprocal as a Rational. Zero to the power of zero is one.
		§§
		§§ @param exponent the exponent
		§§ @returns the power, or `Nothing` when raising zero to a negative power.
		toThePowerOf(_ exponent: Integer) -> Optional<Integer | Rational>

		§§ The Integer, pulled into the given bounds — the lower bound when below it, the upper when above it, itself otherwise.
		§§
		§§ @param lowest the lowest allowed value
		§§ @param and the highest allowed value
		§§ @returns the clamped Integer, or `Nothing` when the bounds are in the wrong order.
		clampedBetween(_ lowest: Integer, and highest: Integer) -> Optional<Integer>

		§§ Reads an Integer from its text form — an optional minus sign followed by digits, the same shape `toString` produces.
		§§
		§§ @param text the text to read
		§§ @returns the Integer, or `Nothing` when the text has any other shape.
		static parse(_ text: String) -> Optional<Integer>

		§§ Represents the Integer as a String, in decimal digits.
		toString() -> String

		§§ Orders the Integer against another Integer.
		§§
		§§ @param other the Integer to order against
		§§ @returns `Ordering#Less`, `Ordering#Equal` or `Ordering#Greater`.
		compareTo(_ other: Integer) -> Ordering
	}
}
