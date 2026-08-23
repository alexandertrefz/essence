import {
	Algebraic       from "./Algebraic.es"
	Boolean         from "./Boolean.es"
	List            from "./List.es"
	Optional        from "./Optional.es"
	Orderable       from "./Orderable.es"
	Ordering        from "./Ordering.es"
	Equatable       from "./Protocols.es"
	Printable       from "./Protocols.es"
	NonZeroRational from "./Rational.es"
	Rational        from "./Rational.es"
	Rounding        from "./Rational.es"
	Step            from "./Step.es"
	String          from "./String.es"
	Transcendental  from "./Transcendental.es"
}

declarations {

	§ The Integers that are not zero, as a checked refinement: a value carries
	§ a proof of the predicate before it is one. The proof is what lets an
	§ operation say it can not fail. A division by one of these answers a
	§ Rational rather than an Optional.
	type NonZeroInteger = Integer where @::isNot(0)

	§ The Integers from zero upward. An exponent proven to be one of these
	§ raises any Integer to a whole power. A receiver proven to be one has a
	§ real square root. Both operations answer an Optional without the proof.
	type NonNegativeInteger = Integer where @::isGreaterThanOrEqualTo(0)

	§ The Integers above zero. `isPositive` is written `@::isGreaterThan(0)`,
	§ and a value above zero is neither zero nor below it. So a value proven
	§ to be one of these is accepted wherever either Type above is wanted.
	type PositiveInteger = Integer where @::isPositive()

	§ Whole numbers of arbitrary size, and the exact arithmetic over them.
	§ Nothing here rounds. An operation that leaves the Integers widens into
	§ a Rational, an Algebraic or a Transcendental instead.
	namespace Integer for Integer is Equatable, is Printable, is Orderable {
		§§ Reads an Integer from its text form.
		§§
		§§ The text form is an optional minus sign followed by digits, the shape `toString` produces. Text of any other shape answers empty, and the `defaultingTo:` entry answers the given Integer instead.
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

		§§ Answers whether the Integer has the same value as another.
		§§
		§§ @param _ — the Integer to compare against
		§§ @returns — `true` when both are equal.
		is(_ other: Integer) -> Boolean {
			<- @::compare(to other)::is(#Equal)
		}

		§§ Orders the Integer against another Integer.
		§§
		§§ @param to — the Integer to order against
		§§ @returns — `Ordering#Less`, `Ordering#Equal` or `Ordering#Greater`.
		compare(to other: Integer) -> Ordering

		§§ Answers the Integer as a String, in decimal digits.
		toString() -> String

		§ The mixed-kind entries of `add` and `multiply` are flipped calls.
		§ The other operand's Namespace already declares the same sum or
		§ product with an Integer, and both operations are commutative.

		§§ Adds a number to this Integer.
		overload add {
			§§ Adds an Integer to this Integer.
			§§
			§§ The sum is an Integer.
			§§
			§§ @param _ — the Integer to add
			(_ other: Integer) -> Integer

			§§ Adds a Rational to this Integer.
			§§
			§§ The sum is a Rational, since it need not be whole.
			§§
			§§ @param _ — the Rational to add
			(_ other: Rational) -> Rational {
				<- other::add(@)
			}

			§§ Adds an Algebraic to this Integer.
			§§
			§§ The sum stays exact. Shifting the rational part of `a + b·√d` leaves the radical untouched.
			§§
			§§ @param _ — the Algebraic to add
			(_ other: Algebraic) -> Algebraic {
				<- other::add(@)
			}

			§§ Adds a Transcendental to this Integer.
			§§
			§§ The sum stays exact. Shifting the rational part of `a + b·π + c·e` leaves the base terms untouched.
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

		§§ Divides this Integer by a number, exactly.
		§§
		§§ Dividing by an Integer or a Rational answers empty for a zero divisor. Dividing this Integer by a NonZeroInteger, by a NonZeroRational or by an Algebraic can not fail. The first two divisors are proven, and an Algebraic is irrational and so never zero. The `defaultingTo:` entries answer the given value in place of empty.
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

			§§ Divides this Integer by a Rational proven not to be zero.
			§§
			§§ The division can not fail, so the answer is the quotient itself rather than an Optional.
			§§
			§§ @param by — the divisor, proven not to be zero
			§§ @returns — the exact quotient.
			(by other: NonZeroRational) -> Rational {
				§ The reciprocal of a Rational that is not zero is proven
				§ too, so the product below is the whole of the division.
				<- @::multiply(with other::reciprocal())
			}
		}

		§§ Answers what is left over after taking out every whole divisor that fits.
		§§
		§§ The division is Euclidean, so the remainder is never negative and always below the divisor's magnitude. For example, `7::remainder(dividingBy 3)` is `1`, and `-7::remainder(dividingBy 3)` is `2` rather than the `-1` truncating division leaves. A zero divisor answers empty, and the `defaultingTo:` entry answers the given Integer instead.
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
		§§ This is the other half of the same Euclidean division as `remainder`, and the two agree: `quotient · divisor + remainder` is the original Integer. The remainder is never negative, so the quotient floors towards negative infinity rather than truncating towards zero. For example, `7::quotient(dividingBy 3)` is `2`, and `-7::quotient(dividingBy 3)` is `-3`, leaving a remainder of `2`. A zero divisor answers empty, and the `defaultingTo:` entry answers the given Integer instead.
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
		§§ A non-negative exponent answers an Integer, and a negative one answers the exact reciprocal as a Rational. Zero to the power of zero is one. Raising this Integer to an exponent proven not to be negative can not fail. A receiver proven not to be zero can not fail either, and answers through `NonZeroInteger`. Zero raised to a negative power answers empty, and the `defaultingTo:` entry answers the given value instead.
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

			§§ Raises the Integer to an exponent proven not to be negative.
			§§
			§§ Every Integer has such a power and every one of them is whole. So the answer is the power itself rather than an Optional, and it is an Integer rather than a Rational.
			§§
			§§ @param to — the exponent, proven not to be negative
			§§ @returns — the power.
			(to exponent: NonNegativeInteger) -> Integer
		}

		§§ Answers the exact square root.
		§§
		§§ A perfect square answers an Integer, and any other non-negative Integer answers an exact Algebraic. A negative Integer answers empty, and the `defaultingTo:` entry answers the given value instead. A receiver proven not to be negative answers the root itself, through `NonNegativeInteger`.
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

		§ These four override `Orderable`'s provided Methods of the same
		§ names, and are kept to answer an Integer question on this Namespace's
		§ own rung. Integer's `compare` is a bigint comparison, while
		§ `Number::compare` is the sixteen-cell cross-kind table, and a Program
		§ that only compares two Integers must reach the first. Deleting these
		§ entries once routed every Integer comparison through that table and
		§ grew `HelloWorld.es` from 18,271 to 35,729 bytes, the regression
		§ `eb27756` fixed. See DEVELOPMENT.md, Why bodies look the way they
		§ do. The Rational entries answer here what the covering `Number`'s
		§ rung would otherwise be reached for. Each is the flipped call, since
		§ `@` is below a Rational exactly when that Rational is above `@`.
		§
		§ An override is in the conformance witness, so a bounded
		§ `<Item is Orderable>` runs these entries where `1::isLessThan(2)`
		§ runs them. Agreeing with `Orderable`'s bodies is a promise about
		§ speed rather than one the language leans on, and both read `compare`
		§ either way.
		§
		§ These bodies are read as well as run, and only two of the six come
		§ out as a comparison. Both `…OrEqualTo` entries are `isGreaterThan`
		§ or `isLessThan` negated, over the bound each was handed. The Integer
		§ one says so directly. The Rational one is a flipped call, and its
		§ converse is taken of the leaf its target resolves to, which is the
		§ strict comparison. The flipped `isLessThan` and `isGreaterThan`
		§ entries converse back to the very name they were read off. So they
		§ say nothing, and stay questions of their own as `compare` makes
		§ their Integer siblings. A refinement written on either `…OrEqualTo`
		§ name is one Type with the comparison it negates. See
		§ DEVELOPMENT.md, Why bodies look the way they do.

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
			§ This body is read as well as run. A predicate written as one
			§ call on `@` is that call, so the `else` of an `if` asking
			§ `isZero` proves `NonZeroInteger`. The same holds of `isOdd`,
			§ `isPositive` and `isNegative` above. See DEVELOPMENT.md, Why
			§ bodies look the way they do.
			<- @::is(0)
		}

		§ This and `round` below answer for an Integer what `Rational` already
		§ answers. Both are Integer's rung of a Method a Union receiver
		§ dispatches over. So `numbers::sum()::round()` is one call rather
		§ than a `match` written at the use site.

		§§ Answers whether the Integer is a whole number.
		§§
		§§ Every Integer is whole, so the answer is always `true`.
		isWholeNumber() -> Boolean {
			<- true
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

		§§ Answers the Integer, rounded in the named direction.
		§§
		§§ An Integer is already whole, so every direction answers the receiver itself. The direction is `#Nearest` when a call names none.
		§§
		§§ @param toward — the direction to round in, `#Nearest` when it is left out
		§§ @returns — the Integer itself.
		round(toward direction: Rounding = #Nearest) -> Integer {
			<- @
		}

		§ `clamp` and `isBetween` are `Orderable`'s provided Methods now. Both
		§ are written on that Protocol's own inequalities, which read
		§ `compare` through the conformance, so an Integer receiver reaches
		§ Integer's `compare` and no other kind.
	}

	§ A refinement adds Methods and takes none away, so a NonZeroInteger
	§ answers every Method above. This Namespace holds the entries the proof
	§ changes the answer of, and it changes it in three ways.
	§
	§ One is closure: the answer is a NonZeroInteger too. Only multiplication
	§ qualifies, because a product is zero exactly when one of its factors is.
	§ A sum or a difference of two non-zero Integers can be zero, as `1` and
	§ `-1` show. Negation would close, and nothing needs it.
	§
	§ The second tightens another kind's answer. An irrational times an Integer
	§ is a Union, because a zero factor collapses it to a Rational. A proven
	§ factor can not, so the two multiply entries hand the receiver to the
	§ irrational's own refined entry and answer that kind itself.
	§
	§ The third is totality: zero is the only base with a missing power, so
	§ `raise` answers the power itself rather than an Optional. Its second
	§ entry repeats `Integer::raise(to NonNegativeInteger)`, which this
	§ Namespace would otherwise hide. A refined target beats the base target
	§ for a Method both declare. Without the repeat, a proven receiver would
	§ answer the Union where an unproven one answers an Integer.
	namespace NonZeroInteger for NonZeroInteger {
		§§ Multiplies this NonZeroInteger with a number.
		§§
		§§ A product of two non-zero Integers is never zero. An irrational scaled by a non-zero Integer stays irrational, so those two entries answer the irrational kind itself.
		overload multiply {
			§§ Multiplies this NonZeroInteger with another.
			§§
			§§ The product is never zero, so the answer is a NonZeroInteger too.
			§§
			§§ @param with — the NonZeroInteger to multiply with
			§§ @returns — the product, which is not zero.
			(with other: NonZeroInteger) -> NonZeroInteger

			§§ Multiplies this NonZeroInteger with an Algebraic.
			§§
			§§ The factor is proven, so the radical survives and the answer is an Algebraic rather than a Union.
			§§
			§§ @param with — the Algebraic to multiply with
			§§ @returns — the exact product.
			(with other: Algebraic) -> Algebraic {
				<- other::multiply(with @)
			}

			§§ Multiplies this NonZeroInteger with a Transcendental.
			§§
			§§ The factor is proven, so every base term survives and the answer is a Transcendental rather than a Union.
			§§
			§§ @param with — the Transcendental to multiply with
			§§ @returns — the exact product.
			(with other: Transcendental) -> Transcendental {
				<- other::multiply(with @)
			}
		}

		§§ Raises this NonZeroInteger to the given power.
		§§
		§§ A base that is not zero has every power, so the answer is the power itself rather than an Optional. An exponent proven not to be negative narrows that answer to an Integer.
		overload raise {
			§§ Raises this NonZeroInteger to the given power.
			§§
			§§ A non-negative exponent answers an Integer, and a negative one answers the exact reciprocal as a Rational.
			§§
			§§ @param to — the exponent
			§§ @returns — the power.
			(to exponent: Integer) -> Integer | Rational

			§§ Raises this NonZeroInteger to an exponent proven not to be negative.
			§§
			§§ Every such power is whole, so the answer is an Integer rather than a Union. The entry is `Integer`'s own, declared here as well, because a receiver carrying more proof must not answer wider than one carrying none.
			§§
			§§ @param to — the exponent, proven not to be negative
			§§ @returns — the power.
			(to exponent: NonNegativeInteger) -> Integer
		}
	}

	§ The other half of the sign. A negative Integer is the only one with no
	§ real square root, so a receiver proven not to be negative answers the
	§ root itself. No other Method of `Integer` turns on this proof. And no
	§ operation closes over it: a difference of two non-negative Integers can
	§ be negative, as `1` and `2` show.
	namespace NonNegativeInteger for NonNegativeInteger {
		§§ Answers the exact square root of this NonNegativeInteger.
		§§
		§§ A negative Integer is the only one with no real root, and the receiver is proven not to be one. So the answer is the root itself rather than an Optional. A perfect square answers an Integer, and every other value answers an exact Algebraic.
		§§
		§§ @returns — the root.
		squareRoot() -> Integer | Algebraic
	}
}

export {
	Integer
	NonNegativeInteger
	NonZeroInteger
	PositiveInteger
}
