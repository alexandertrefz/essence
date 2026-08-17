import {
	Algebraic      from "./Algebraic.es"
	Boolean        from "./Boolean.es"
	Comparable     from "./Comparable.es"
	List           from "./List.es"
	Optional       from "./Optional.es"
	Ordering       from "./Ordering.es"
	Equatable      from "./Protocols.es"
	Printable      from "./Protocols.es"
	Rational       from "./Rational.es"
	Step           from "./Step.es"
	String         from "./String.es"
	Transcendental from "./Transcendental.es"
}

declarations {

	§ The Integers that are not zero. It is a checked refinement, so the
	§ predicate is not a comment about the values — it is what a value has to
	§ have been proven to satisfy before it may be called one, and the proof is
	§ what the Type carries. A value written DOWN is its own proof; a value a
	§ Program is handed goes through an `if` or a `match` that asks the question.
	§
	§ This is what lets an operation that can not fail say so. A division by one
	§ of these is a Rational rather than an Optional, and `Rational::denominator`
	§ answers with one — so the arithmetic on the lowest-terms accessors composes
	§ without a single fallback for a case that can not arise.
	type NonZeroInteger = Integer where @::isNot(0)

	§ Whole numbers of arbitrary size, and the exact arithmetic over them.
	§ Every Method here stays exact: an operation that leaves the Integers
	§ widens into the Type that can still say the answer — a Rational, an
	§ Algebraic or a Transcendental — rather than rounding.
	namespace Integer for Integer is Equatable, is Printable, is Comparable {
		§§ Checks whether the Integer has the same value as another.
		§§
		§§ @param other — the Integer to compare against
		§§ @returns — `true` when both are equal.
		is(_ other: Integer) -> Boolean {
			<- @::compare(to other)::is(#Equal)
		}

		§§ Checks whether the Integer has a different value than another.
		§§
		§§ @param other — the Integer to compare against
		§§ @returns — `true` when the two differ.
		isNot(_ other: Integer) -> Boolean {
			<- @::is(other)::negate()
		}

		§ The mixed-kind entries of `add` and `multiply` lean on commutativity:
		§ the other operand's Namespace already declares the same sum or
		§ product with an Integer, so each entry is the flipped call. Only the
		§ Integer-Integer entry is a primitive of this Namespace's own.

		§§ Adds a number to this Integer.
		overload add {
			§§ Adds two Integers, giving an Integer.
			§§
			§§ @param other — the Integer to add
			(_ other: Integer) -> Integer

			§§ Adds a Rational to an Integer. The result is a Rational, since the sum need not be whole.
			§§
			§§ @param other — the Rational to add
			(_ other: Rational) -> Rational {
				<- other::add(@)
			}

			§§ Adds an Algebraic to an Integer. Shifting the rational part of `a + b·√d` leaves the radical untouched, so the sum is exact.
			§§
			§§ @param other — the Algebraic to add
			(_ other: Algebraic) -> Algebraic {
				<- other::add(@)
			}

			§§ Adds a Transcendental to an Integer. Shifting the rational part of `a + b·π + c·e` leaves the base terms untouched, so the sum is exact.
			§§
			§§ @param other — the Transcendental to add
			(_ other: Transcendental) -> Transcendental {
				<- other::add(@)
			}
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

		§§ Divides this Integer by a number, exactly. Dividing by a possibly-zero Integer or Rational is empty for zero; dividing by a NonZeroInteger or an Algebraic can never fail — the one is proven, the other is irrational and so never zero.
		overload divide {
			(by other: Integer) -> Optional<Rational> {
				<- Rational.of(@, over other)
			}

			(by other: Rational) -> Optional<Rational> {
				constant dividend = @

				<- other
					::reciprocal()
					::map((reciprocal) {
						<- dividend::multiply(with reciprocal)
					})
			}

			(by other: Algebraic) -> Algebraic | Rational

			§§ Divides this Integer by a divisor proven not to be zero. There is no failure left to report, so the quotient itself is the answer.
			§§
			§§ @param by — the divisor, proven not to be zero
			§§ @returns — the exact quotient.
			(by other: NonZeroInteger) -> Rational
		}

		§§ Multiplies this Integer with a number, staying exact for every member of the numeric tower.
		overload multiply {
			(with other: Integer) -> Integer

			(with other: Rational) -> Rational {
				<- other::multiply(with @)
			}

			(with other: Algebraic) -> Algebraic | Rational {
				<- other::multiply(with @)
			}

			(with other: Transcendental) -> Transcendental | Rational {
				<- other::multiply(with @)
			}
		}

		§ THE INEQUALITIES LOOK LIKE DUPLICATION OF `Number`'s AND ARE NOT.
		§ `Number` declares the same four over the whole tower, and deleting
		§ these four would leave every Integer comparison resolving to those —
		§ which is exactly the regression `eb27756` fixed. The chain runs
		§ `Integer.isLessThan` → `compare`, and WHICH `compare` is the
		§ whole point: the one below is Integer's own, a bigint comparison,
		§ while `Number`'s is the sixteen-cell cross-kind table that reaches
		§ Rational, Algebraic and Transcendental. Routing
		§ two Integers through it made `HelloWorld.es` bundle the machinery for
		§ comparing an Integer with π, and nearly doubled it — 18,271 → 35,729
		§ bytes. `src/tests/bundleSize.spec.ts` is the guard.
		§
		§ So the entries here are a performance stratification, not a copy: the
		§ same-kind entry is written on the same-kind native, and only the
		§ mixed-kind ones need the covering Namespace. The same reading applies
		§ to `Rational`'s four, and to `isPositive`/`isNegative`/`isZero`
		§ below, which are written on these. The Rational entries are each the
		§ flipped call — `@` is below the Rational exactly when the Rational is
		§ above `@` — so Rational's own mixed entries answer all four.

		§§ Whether this Integer is strictly below the given number.
		overload isLessThan {
			(_ other: Integer) -> Boolean {
				<- @::compare(to other)::is(#Less)
			}

			(_ other: Rational) -> Boolean {
				<- other::isGreaterThan(@)
			}
		}

		§§ Whether this Integer is below the given number, or equal to it.
		overload isLessThanOrEqualTo {
			(_ other: Integer) -> Boolean {
				<- @::isGreaterThan(other)::negate()
			}

			(_ other: Rational) -> Boolean {
				<- other::isGreaterThanOrEqualTo(@)
			}
		}

		§§ Whether this Integer is strictly above the given number.
		overload isGreaterThan {
			(_ other: Integer) -> Boolean {
				<- @::compare(to other)::is(#Greater)
			}

			(_ other: Rational) -> Boolean {
				<- other::isLessThan(@)
			}
		}

		§§ Whether this Integer is above the given number, or equal to it.
		overload isGreaterThanOrEqualTo {
			(_ other: Integer) -> Boolean {
				<- @::isLessThan(other)::negate()
			}

			(_ other: Rational) -> Boolean {
				<- other::isLessThanOrEqualTo(@)
			}
		}

		§§ The exact square root. A perfect square gives a Integer; any other non-negative value gives an exact Algebraic — and a negative is empty.
		squareRoot() -> Optional<Integer | Algebraic>

		§§ The Integer without its sign — its distance from zero.
		absolute() -> Integer {
			if @::isNegative() {
				<- @::negate()
			} else {
				<- @
			}
		}

		§§ The Integer with its sign flipped.
		negate() -> Integer

		§§ Whether the Integer is divisible by two. Zero is even.
		isEven() -> Boolean {
			§ The written `2` is its own proof of not being zero, so this is
			§ the total `remainder` entry: a bare Integer, no Optional to take
			§ apart. The match that used to stand here — kept over
			§ `::is(#Value(0))` to spare every Program 2.4 kB of generic-Choice
			§ equality — is simply gone, empty arm and all.
			<- @::remainder(dividingBy 2)::is(0)
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

		§§ What is left over after taking out every whole divisor that fits. `7::remainder(dividingBy 3)` is `1`.
		§§
		§§ The division is Euclidean, so the remainder is always at least zero and below the divisor's magnitude, whatever the signs of the operands: `(0 - 7)::remainder(dividingBy 3)` is `2`, not the `0 - 1` that truncating division leaves.
		overload remainder {
			§§ The remainder over a divisor nothing is known about.
			§§
			§§ @param dividingBy — the divisor
			§§ @returns — the remainder, or nothing when dividing by zero.
			(dividingBy divisor: Integer) -> Optional<Integer>

			§§ The remainder over a divisor proven not to be zero. There is no failure left to report, so the remainder itself is the answer.
			§§
			§§ @param dividingBy — the divisor, proven not to be zero
			§§ @returns — the remainder.
			(dividingBy divisor: NonZeroInteger) -> Integer
		}

		§§ How many whole divisors fit. `7::quotient(dividingBy 3)` is `2`.
		§§
		§§ The other half of the same Euclidean division as `remainder`, and the two always agree: `quotient · divisor + remainder` is the original Integer. Since that remainder is never negative, the quotient floors towards negative infinity rather than truncating towards zero: `(0 - 7)::quotient(dividingBy 3)` is `0 - 3`, leaving a remainder of `2`.
		overload quotient {
			§§ The quotient over a divisor nothing is known about.
			§§
			§§ @param dividingBy — the divisor
			§§ @returns — the quotient, or nothing when dividing by zero.
			(dividingBy divisor: Integer) -> Optional<Integer>

			§§ The quotient over a divisor proven not to be zero. There is no failure left to report, so the quotient itself is the answer.
			§§
			§§ @param dividingBy — the divisor, proven not to be zero
			§§ @returns — the quotient.
			(dividingBy divisor: NonZeroInteger) -> Integer
		}

		§§ Raises the Integer to the given power. A non-negative exponent gives an Integer, a negative one the exact reciprocal as a Rational. Zero to the power of zero is one.
		§§
		§§ @param exponent — the exponent
		§§ @returns — the power, or nothing when raising zero to a negative power.
		raise(to exponent: Integer) -> Optional<Integer | Rational>

		§§ The Integer, pulled into the given bounds — the lower bound when below it, the upper when above it, itself otherwise.
		§§
		§§ @param lowest — the lowest allowed value
		§§ @param and — the highest allowed value
		§§ @returns — the clamped Integer, or nothing when the bounds are in the wrong order.
		clamp(
			between lowest: Integer,
			and highest: Integer,
		) -> Optional<Integer> {
			if lowest::isGreaterThan(highest) {
				<- #Empty
			} else if @::isLessThan(lowest) {
				<- #Value(lowest)
			} else if @::isGreaterThan(highest) {
				<- #Value(highest)
			} else {
				<- #Value(@)
			}
		}

		§§ Reads an Integer from its text form — an optional minus sign followed by digits, the same shape `toString` produces.
		§§
		§§ @param text — the text to read
		§§ @returns — the Integer, or nothing when the text has any other shape.
		static parse(_ text: String) -> Optional<Integer> {
			§ The sign is carried as the position of a LEADING `-` — `keep`
			§ discards a `-` found anywhere else, so what is left has a value
			§ exactly when the text is negative. One leading sign at most:
			§ everything after it has to be a digit, so a second sign falls to
			§ the digit check below like any other stray character, and a sign
			§ alone leaves no digits at all.
			constant sign = text
				::firstIndex(of "-")
				::keep(where (position) { <- position::is(0) })

			constant digitsText = match sign -> String {
				case #Value { <- text::slice(from 1) }

				case #Empty { <- text }
			}

			if digitsText::isEmpty() {
				<- #Empty
			} else {
				constant start: Optional<Integer> = #Value(0)

				constant magnitude = digitsText
					::characters()
					::reduce(startingWith start, step (value, character) {
						§ A digit's value IS its position in the digit
						§ line-up; a character that is not there refuses the
						§ whole text at once.
						<- match "0123456789"::firstIndex(
							of character,
						) -> Step<Optional<Integer>, Optional<Integer>> {
							case #Empty        { <- #Done(#Empty) }

							case #Value(digit) {
								<- #Continue(#Value(value
									::value(withDefault 0)
									::multiply(with 10)
									::add(digit)))
							}
						}
					})

				<- magnitude::map((parsedMagnitude) {
					<- match sign -> Integer {
						case #Value { <- parsedMagnitude::negate() }

						case #Empty { <- parsedMagnitude }
					}
				})
			}
		}

		§§ Represents the Integer as a String, in decimal digits.
		toString() -> String

		§§ Orders the Integer against another Integer.
		§§
		§§ @param other — the Integer to order against
		§§ @returns — `Ordering#Less`, `Ordering#Equal` or `Ordering#Greater`.
		compare(to other: Integer) -> Ordering
	}

	§ The arithmetic that KEEPS the evidence, rather than forgetting it. Evidence
	§ adds Methods to a Type and takes none away, so a NonZeroInteger already
	§ answers every Method above; what a Namespace of its own is for is the
	§ operations whose answer is a NonZeroInteger too.
	§
	§ Only one qualifies, and it qualifies for a reason worth writing down: a
	§ product is zero exactly when one of its factors is, so neither factor being
	§ zero is the whole of the proof. Nothing else closes — a sum of two non-zero
	§ Integers is `1 + (0 - 1)`, a difference the same, and a negation is the one
	§ operation that would close but which nothing needs.
	namespace NonZeroInteger for NonZeroInteger {
		§§ Multiplies this NonZeroInteger with another. The product is never zero either, so the evidence carries through the operation instead of being forgotten at it.
		§§
		§§ @param with — the NonZeroInteger to multiply with
		§§ @returns — the product, which is not zero.
		multiply(with other: NonZeroInteger) -> NonZeroInteger
	}
}

export {
	Integer
	NonZeroInteger
}
