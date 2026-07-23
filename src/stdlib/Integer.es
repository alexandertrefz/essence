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
		is(_ other: Integer) -> Boolean {
			<- @::compareTo(other)::is(Ordering#Equal)
		}

		§§ Checks whether the Integer has a different value than another.
		§§
		§§ @param other the Integer to compare against
		§§ @returns `true` when the two differ.
		isNot(_ other: Integer) -> Boolean {
			<- @::is(other)::negate()
		}

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
			(_ other: Integer) -> Integer {
				<- @::add(other::negate())
			}

			(_ other: Rational) -> Rational {
				<- @::add(other::negate())
			}

			(_ other: Algebraic) -> Algebraic {
				<- @::add(other::negate())
			}

			(_ other: Transcendental) -> Transcendental {
				<- @::add(other::negate())
			}
		}

		§§ Divides this Integer by a number, exactly. Dividing by a possibly-zero Integer or Rational gives `Nothing` for zero; dividing by an Algebraic can never fail — an irrational is never zero.
		overload divide {
			(by other: Integer) -> Optional<Rational> {
				<- Rational.of(@, over other)
			}

			(by other: Rational) -> Optional<Rational> {
				constant dividend = @
				<- match other::reciprocal() -> Optional<Rational> {
					case Rational { <- dividend::multiply(with @) }
					case Nothing { <- nothing }
				}
			}

			(by other: Algebraic) -> Algebraic | Rational
		}

		§§ Multiplies this Integer with a number, staying exact for every member of the numeric tower.
		overload multiply {
			(with other: Integer) -> Integer

			(with other: Rational) -> Rational

			(with other: Algebraic) -> Algebraic | Rational

			(with other: Transcendental) -> Transcendental | Rational
		}

		§ THE INEQUALITIES LOOK LIKE DUPLICATION OF `Number`'s AND ARE NOT.
		§ `Number` declares the same four over the whole tower, and deleting
		§ these four would leave every Integer comparison resolving to those —
		§ which is exactly the regression `eb27756` fixed. The chain runs
		§ `Integer.isLessThan` → `compareTo`, and WHICH `compareTo` is the
		§ whole point: the one below is Integer's own, a bigint comparison,
		§ while `Number`'s is the sixteen-cell cross-kind table that reaches
		§ Rational, Algebraic, Transcendental and `bigint-fraction`. Routing
		§ two Integers through it made `HelloWorld.es` bundle the machinery for
		§ comparing an Integer with π, and nearly doubled it — 18,271 → 35,729
		§ bytes. `src/tests/bundleSize.spec.ts` is the guard.
		§
		§ So the entries here are a performance stratification, not a copy: the
		§ same-kind entry is written on the same-kind native, and only the
		§ mixed-kind ones need the covering Namespace. The same reading applies
		§ to `Rational`'s four, and to `isPositive`/`isNegative`/`isZero`
		§ below, which are written on these.

		§§ Whether this Integer is strictly below the given number.
		overload isLessThan {
			(_ other: Integer) -> Boolean {
				<- @::compareTo(other)::is(Ordering#Less)
			}

			(_ other: Rational) -> Boolean
		}

		§§ Whether this Integer is below the given number, or equal to it.
		overload isLessThanOrEqualTo {
			(_ other: Integer) -> Boolean {
				<- @::isGreaterThan(other)::negate()
			}

			(_ other: Rational) -> Boolean
		}

		§§ Whether this Integer is strictly above the given number.
		overload isGreaterThan {
			(_ other: Integer) -> Boolean {
				<- @::compareTo(other)::is(Ordering#Greater)
			}

			(_ other: Rational) -> Boolean
		}

		§§ Whether this Integer is above the given number, or equal to it.
		overload isGreaterThanOrEqualTo {
			(_ other: Integer) -> Boolean {
				<- @::isLessThan(other)::negate()
			}

			(_ other: Rational) -> Boolean
		}

		§§ The exact square root. A perfect square gives a Integer; any other non-negative value gives an exact Algebraic — and a negative gives Nothing.
		squareRoot() -> Optional<Integer | Algebraic>

		§§ The Integer without its sign — its distance from zero.
		absolute() -> Integer {
			if @::isNegative() { <- @::negate() }
			<- @
		}

		§§ The Integer with its sign flipped.
		negate() -> Integer

		§§ Whether the Integer is divisible by two. Zero is even.
		isEven() -> Boolean {
			<- match @::remainder(dividingBy 2) -> Boolean {
				case 0 { <- true }
				case _ { <- false }
			}
		}

		§§ Whether the Integer is not divisible by two.
		isOdd() -> Boolean {
			<- @::isEven()::negate()
		}

		§§ Whether the Integer is above zero. Zero is neither positive nor negative.
		isPositive() -> Boolean {
			<- @::isGreaterThan(0)
		}

		§§ Whether the Integer is below zero. Zero is neither positive nor negative.
		isNegative() -> Boolean {
			<- @::isLessThan(0)
		}

		§§ Whether the Integer is exactly zero.
		isZero() -> Boolean {
			<- @::is(0)
		}

		§§ The remainder of Euclidean division — always at least zero and below the divisor's magnitude, whatever the signs of the operands. `(0 - 7)::remainder(dividingBy 3)` is `2`.
		§§
		§§ @param dividingBy the divisor
		§§ @returns the remainder, or `Nothing` when dividing by zero.
		remainder(dividingBy divisor: Integer) -> Optional<Integer>

		§§ The whole part of Euclidean division — the count of whole divisors, paired with `remainder` so that `quotient · divisor + remainder` is the original Integer. `(0 - 7)::quotient(dividingBy 3)` is `0 - 3`, since the remainder is never negative.
		§§
		§§ @param dividingBy the divisor
		§§ @returns the quotient, or `Nothing` when dividing by zero.
		quotient(dividingBy divisor: Integer) -> Optional<Integer>

		§§ Raises the Integer to the given power. A non-negative exponent gives an Integer, a negative one the exact reciprocal as a Rational. Zero to the power of zero is one.
		§§
		§§ @param exponent the exponent
		§§ @returns the power, or `Nothing` when raising zero to a negative power.
		raise(to exponent: Integer) -> Optional<Integer | Rational>

		§§ The Integer, pulled into the given bounds — the lower bound when below it, the upper when above it, itself otherwise.
		§§
		§§ @param lowest the lowest allowed value
		§§ @param and the highest allowed value
		§§ @returns the clamped Integer, or `Nothing` when the bounds are in the wrong order.
		clamp(between lowest: Integer, and highest: Integer) -> Optional<Integer> {
			if lowest::isGreaterThan(highest) { <- nothing }
			if @::isLessThan(lowest) { <- lowest }
			if @::isGreaterThan(highest) { <- highest }
			<- @
		}

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
