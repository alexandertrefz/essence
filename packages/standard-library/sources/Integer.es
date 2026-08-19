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

	§ The Integers that are not zero, as a checked refinement: a value carries
	§ a proof of the predicate before it is one. The proof is what lets an
	§ operation say it can not fail. A division by one of these answers a
	§ Rational rather than an Optional.
	type NonZeroInteger = Integer where @::isNot(0)

	§ Whole numbers of arbitrary size, and the exact arithmetic over them.
	§ Nothing here rounds. An operation that leaves the Integers widens into
	§ a Rational, an Algebraic or a Transcendental instead.
	namespace Integer for Integer is Equatable, is Printable, is Comparable {
		§§ Answers whether the Integer has the same value as another.
		§§
		§§ @param _ — the Integer to compare against
		§§ @returns — `true` when both are equal.
		is(_ other: Integer) -> Boolean {
			<- @::compare(to other)::is(#Equal)
		}

		§§ Answers whether the Integer has a different value than another.
		§§
		§§ @param _ — the Integer to compare against
		§§ @returns — `true` when the two differ.
		isNot(_ other: Integer) -> Boolean {
			<- @::is(other)::negate()
		}

		§ The mixed-kind entries of `add` and `multiply` are flipped calls.
		§ The other operand's Namespace already declares the same sum or
		§ product with an Integer, and both operations are commutative.

		§§ Adds a number to this Integer.
		overload add {
			§§ Adds an Integer to this Integer. The sum is an Integer.
			§§
			§§ @param _ — the Integer to add
			(_ other: Integer) -> Integer

			§§ Adds a Rational to this Integer. The sum is a Rational, since it need not be whole.
			§§
			§§ @param _ — the Rational to add
			(_ other: Rational) -> Rational {
				<- other::add(@)
			}

			§§ Adds an Algebraic to this Integer. The sum stays exact.
			§§
			§§ Shifting the rational part of `a + b·√d` leaves the radical untouched.
			§§
			§§ @param _ — the Algebraic to add
			(_ other: Algebraic) -> Algebraic {
				<- other::add(@)
			}

			§§ Adds a Transcendental to this Integer. The sum stays exact.
			§§
			§§ Shifting the rational part of `a + b·π + c·e` leaves the base terms untouched.
			§§
			§§ @param _ — the Transcendental to add
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

		§§ Divides this Integer by a number, exactly.
		§§
		§§ Dividing by an Integer or a Rational answers empty for a zero divisor. Dividing this Integer by a NonZeroInteger or by an Algebraic can not fail. The first divisor is proven, and an Algebraic is irrational and so never zero.
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

			§§ Divides this Integer by a divisor proven not to be zero.
			§§
			§§ The division can not fail, so the answer is the quotient itself rather than an Optional.
			§§
			§§ @param by — the divisor, proven not to be zero
			§§ @returns — the exact quotient.
			(by other: NonZeroInteger) -> Rational

			§§ Divides by an Integer, and answers the given value when the divisor is zero.
			§§
			§§ @param by — the divisor
			§§ @param defaultingTo — the value to answer with when there is no quotient
			§§ @returns — the quotient, or the given value in its place.
			(by other: Integer, defaultingTo fallback: Rational) -> Rational {
				<- @::divide(by other)::value(defaultingTo fallback)
			}

			§§ Divides by a Rational, and answers the given value when the divisor is zero.
			§§
			§§ @param by — the divisor
			§§ @param defaultingTo — the value to answer with when there is no quotient
			§§ @returns — the quotient, or the given value in its place.
			(by other: Rational, defaultingTo fallback: Rational) -> Rational {
				<- @::divide(by other)::value(defaultingTo fallback)
			}
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

		§ These four are not a copy of `Number`'s. Integer's own `compare` is
		§ a bigint comparison, while `Number::compare` is the sixteen-cell
		§ cross-kind table. Deleting these entries routed every Integer
		§ comparison through that table and grew `HelloWorld.es` from 18,271
		§ to 35,729 bytes, the regression `eb27756` fixed. See DEVELOPMENT.md,
		§ Why bodies look the way they do. Each Rational entry is the flipped
		§ call: `@` is below a Rational exactly when that Rational is above `@`.

		§§ Answers whether this Integer is strictly below the given number.
		overload isLessThan {
			(_ other: Integer) -> Boolean {
				<- @::compare(to other)::is(#Less)
			}

			(_ other: Rational) -> Boolean {
				<- other::isGreaterThan(@)
			}
		}

		§§ Answers whether this Integer is below the given number, or equal to it.
		overload isLessThanOrEqualTo {
			(_ other: Integer) -> Boolean {
				<- @::isGreaterThan(other)::negate()
			}

			(_ other: Rational) -> Boolean {
				<- other::isGreaterThanOrEqualTo(@)
			}
		}

		§§ Answers whether this Integer is strictly above the given number.
		overload isGreaterThan {
			(_ other: Integer) -> Boolean {
				<- @::compare(to other)::is(#Greater)
			}

			(_ other: Rational) -> Boolean {
				<- other::isLessThan(@)
			}
		}

		§§ Answers whether this Integer is above the given number, or equal to it.
		overload isGreaterThanOrEqualTo {
			(_ other: Integer) -> Boolean {
				<- @::isLessThan(other)::negate()
			}

			(_ other: Rational) -> Boolean {
				<- other::isLessThanOrEqualTo(@)
			}
		}

		§§ Answers the exact square root.
		§§
		§§ A perfect square answers an Integer, and any other non-negative Integer answers an exact Algebraic. A negative Integer answers empty.
		overload squareRoot {
			§§ @returns — the root, or nothing for a negative Integer.
			() -> Optional<Integer | Algebraic>

			§§ Answers the exact square root, with a value to answer for a negative Integer.
			§§
			§§ @param defaultingTo — the value to answer with when there is no root
			§§ @returns — the root, or the given value in its place.
			(
				defaultingTo fallback: Integer | Algebraic,
			) -> Integer | Algebraic {
				<- @::squareRoot()::value(defaultingTo fallback)
			}
		}

		§§ Answers the Integer without its sign, which is its distance from zero.
		absolute() -> Integer {
			if @::isNegative() {
				<- @::negate()
			} else {
				<- @
			}
		}

		§§ Answers the Integer with its sign flipped.
		negate() -> Integer

		§§ Answers whether the Integer is divisible by two.
		§§
		§§ Zero is even.
		isEven() -> Boolean {
			§ `2` is a literal, so it is a NonZeroInteger and `remainder`
			§ answers a bare Integer.
			<- @::remainder(dividingBy 2)::is(0)
		}

		§§ Answers whether the Integer is not divisible by two.
		isOdd() -> Boolean {
			<- @::isEven()::negate()
		}

		§§ Answers whether the Integer is above zero.
		§§
		§§ Zero is neither positive nor negative.
		isPositive() -> Boolean {
			<- @::isGreaterThan(0)
		}

		§§ Answers whether the Integer is below zero.
		§§
		§§ Zero is neither positive nor negative.
		isNegative() -> Boolean {
			<- @::isLessThan(0)
		}

		§§ Answers whether the Integer is exactly zero.
		isZero() -> Boolean {
			<- @::is(0)
		}

		§§ Answers what is left over after taking out every whole divisor that fits.
		§§
		§§ The division is Euclidean, so the remainder is never negative and always below the divisor's magnitude. For example, `7::remainder(dividingBy 3)` is `1`, and `-7::remainder(dividingBy 3)` is `2` rather than the `-1` truncating division leaves.
		overload remainder {
			§§ Answers the remainder over a divisor nothing is known about.
			§§
			§§ @param dividingBy — the divisor
			§§ @returns — the remainder, or nothing when dividing by zero.
			(dividingBy divisor: Integer) -> Optional<Integer>

			§§ Answers the remainder over a divisor proven not to be zero.
			§§
			§§ The division can not fail, so the answer is the remainder itself rather than an Optional.
			§§
			§§ @param dividingBy — the divisor, proven not to be zero
			§§ @returns — the remainder.
			(dividingBy divisor: NonZeroInteger) -> Integer

			§§ Answers the remainder, with a value to answer when the divisor is zero.
			§§
			§§ @param dividingBy — the divisor
			§§ @param defaultingTo — the value to answer with when there is no remainder
			§§ @returns — the remainder, or the given value in its place.
			(
				dividingBy divisor: Integer,
				defaultingTo fallback: Integer,
			) -> Integer {
				<- @::remainder(dividingBy divisor)
					::value(defaultingTo fallback)
			}
		}

		§§ Answers how many whole divisors fit.
		§§
		§§ This is the other half of the same Euclidean division as `remainder`, and the two agree: `quotient · divisor + remainder` is the original Integer. The remainder is never negative, so the quotient floors towards negative infinity rather than truncating towards zero. For example, `7::quotient(dividingBy 3)` is `2`, and `-7::quotient(dividingBy 3)` is `-3`, leaving a remainder of `2`.
		overload quotient {
			§§ Answers the quotient over a divisor nothing is known about.
			§§
			§§ @param dividingBy — the divisor
			§§ @returns — the quotient, or nothing when dividing by zero.
			(dividingBy divisor: Integer) -> Optional<Integer>

			§§ Answers the quotient over a divisor proven not to be zero.
			§§
			§§ The division can not fail, so the answer is the quotient itself rather than an Optional.
			§§
			§§ @param dividingBy — the divisor, proven not to be zero
			§§ @returns — the quotient.
			(dividingBy divisor: NonZeroInteger) -> Integer

			§§ Answers the quotient, with a value to answer when the divisor is zero.
			§§
			§§ @param dividingBy — the divisor
			§§ @param defaultingTo — the value to answer with when there is no quotient
			§§ @returns — the quotient, or the given value in its place.
			(
				dividingBy divisor: Integer,
				defaultingTo fallback: Integer,
			) -> Integer {
				<- @::quotient(dividingBy divisor)::value(defaultingTo fallback)
			}
		}

		§§ Raises the Integer to the given power.
		§§
		§§ A non-negative exponent answers an Integer, and a negative one answers the exact reciprocal as a Rational. Zero to the power of zero is one.
		overload raise {
			§§ @param to — the exponent
			§§ @returns — the power, or nothing when raising zero to a negative power.
			(to exponent: Integer) -> Optional<Integer | Rational>

			§§ Raises the Integer to the given power, and answers the given value when there is no power.
			§§
			§§ @param to — the exponent
			§§ @param defaultingTo — the value to answer with when there is no power
			§§ @returns — the power, or the given value in its place.
			(
				to exponent: Integer,
				defaultingTo fallback: Integer | Rational,
			) -> Integer | Rational {
				<- @::raise(to exponent)::value(defaultingTo fallback)
			}
		}

		§§ Answers the Integer, pulled into the given bounds.
		§§
		§§ The answer is the lower bound when the Integer is below it. It is the upper bound when the Integer is above it, and the Integer itself otherwise. The two bounds name the same range in either order: `7::clamp(between 10, and 1)` is `7`, and `15::clamp(between 10, and 1)` is `10`.
		§§
		§§ @param between — one bound of the range
		§§ @param and — the other bound of the range
		§§ @returns — the clamped Integer.
		clamp(between lowest: Integer, and highest: Integer) -> Integer {
			§ The two ladders below are one ladder with the bounds exchanged.
			§ Swapping the bounds and calling `clamp` again would be a
			§ recursion, which a standard library body can not have.
			if lowest::isGreaterThan(highest) {
				if @::isLessThan(highest) {
					<- highest
				} else if @::isGreaterThan(lowest) {
					<- lowest
				} else {
					<- @
				}
			} else if @::isLessThan(lowest) {
				<- lowest
			} else if @::isGreaterThan(highest) {
				<- highest
			} else {
				<- @
			}
		}

		§§ Reads an Integer from its text form.
		§§
		§§ The text form is an optional minus sign followed by digits, the shape `toString` produces.
		overload static parse {
			§§ @param _ — the text to read
			§§ @returns — the Integer, or nothing when the text has any other shape.
			(_ text: String) -> Optional<Integer> {
				§ The sign is the position of a leading `-`. The `keep` call
				§ discards a `-` found anywhere else, so `sign` has a value
				§ exactly when the text is negative. A second sign falls to
				§ the digit check below, and a sign alone leaves no digits.
				constant sign = text::firstIndex(of "-")
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
							§ A digit's value is its position in the
							§ digit list, and any other character
							§ refuses the text.
							<- match "0123456789"::firstIndex(
								of character,
							) -> Step<Optional<Integer>, Optional<Integer>> {
								case #Empty        { <- #Done(#Empty) }

								case #Value(digit) {
									<- #Continue(
										#Value(
											value
												::value(defaultingTo 0)
												::multiply(with 10)
												::add(digit)
										)
									)
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

			§§ Reads an Integer from its text form, with a value to answer when the text has another shape.
			§§
			§§ @param _ — the text to read
			§§ @param defaultingTo — the value to answer with when the text is no Integer
			§§ @returns — the Integer, or the given value in its place.
			(_ text: String, defaultingTo fallback: Integer) -> Integer {
				<- Integer.parse(text)::value(defaultingTo fallback)
			}
		}

		§§ Answers the Integer as a String, in decimal digits.
		toString() -> String

		§§ Orders the Integer against another Integer.
		§§
		§§ @param to — the Integer to order against
		§§ @returns — `Ordering#Less`, `Ordering#Equal` or `Ordering#Greater`.
		compare(to other: Integer) -> Ordering
	}

	§ A refinement adds Methods and takes none away, so a NonZeroInteger
	§ answers every Method above. This Namespace holds the operations whose
	§ answer is a NonZeroInteger too. Only multiplication qualifies: a product
	§ is zero exactly when one of its factors is. A sum or a difference of two
	§ non-zero Integers can be zero, as `1` and `-1` show. Negation would
	§ close, and nothing needs it.
	namespace NonZeroInteger for NonZeroInteger {
		§§ Multiplies this NonZeroInteger with another.
		§§
		§§ The product is never zero, so the answer is a NonZeroInteger too.
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
