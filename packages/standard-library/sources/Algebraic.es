import {
	from "./Boolean.es" { Boolean }
	from "./Integer.es" {
		Integer
		NonNegativeInteger
		NonZeroInteger
	}
	from "./Optional.es" { Optional }
	from "./Orderable.es" { Orderable }
	from "./Ordering.es" { Ordering }
	from "./Protocols.es" {
		Equatable
		Printable
	}
	from "./Rational.es" {
		NonZeroRational
		NumberFormat
		Rational
		Rounding
	}
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

		§ The `as:` entries match on the format rather than handing it on.
		§ A `#Fraction` of an irrational is the symbolic form, which no
		§ Rational carries. A Case added to `NumberFormat` stops the match
		§ here, which is the point. What a percentage or an exponent of an
		§ irrational writes is a decision, not a pass-through.
		§
		§ The decision each arm takes is the width to read the value at,
		§ before it hands the Rational on to the formatter. A decimal is read
		§ at the count it writes. A percentage shifts the point two places,
		§ so it is read two digits deeper and the shift stays exact. A
		§ scientific form's depth is decided by where its exponent falls,
		§ which the reading would have to answer. So it is read at the
		§ eightieth digit instead, the cap the entry without a count writes
		§ at.

		§§ Answers the Algebraic as a String, in the exact symbolic form or in the named format.
		§§
		§§ The form is `√2`, `3·√2` or `1 + √2` when no format is named, and `#Fraction` names that same form. The `#Decimal` format writes the expansion, to at most 80 digits, which is the cap a Rational writes a non-terminating expansion at. A count of places writes exactly that many digits after the point.
		overload toString {
			§§ Answers the Algebraic as a String, in the exact symbolic form: `√2`, `3·√2` or `1 + √2`.
			§§
			§§ One radical has one printed form, with one exception. Normalisation divides out square factors up to 65536, so a radicand `p²·q` with both primes above that is printed as written. The equal `p·√q` prints in the normalised form.
			() -> String

			§§ Answers the Algebraic as a decimal, or in the exact symbolic form, in the named format.
			§§
			§§ The `#Decimal` format rounds the expansion at the eightieth digit and writes it. An irrational expansion never ends, so the cap is always reached. Trailing zeros the rounding leaves are dropped, as they are for any Rational. The `#Percent` format writes one hundred times that same reading, taken two digits deeper so that eighty still stand after the point. The `#Scientific` format writes that reading with one digit before the point and the power of ten after an `e`. The `#Fraction` format writes the symbolic form, since no ratio of two Integers is this number.
			§§
			§§ @param as — the form to represent the Algebraic in
			§§ @returns — the String representation of the Algebraic.
			(as format: NumberFormat) -> String {
				§ `@` is the scrutinee inside a `match`; see DEVELOPMENT.md,
				§ Why bodies look the way they do.
				constant value = @

				<- match format -> String {
					case #Fraction { <- value::toString() }

					case #Decimal {
						<- value
							::approximate(toPlaces 80)
							::toString(as #Decimal)
					}

					case #Percent {
						<- value
							::approximate(toPlaces 82)
							::toString(as #Percent)
					}

					case #Scientific {
						<- value
							::approximate(toPlaces 80)
							::toString(as #Scientific)
					}
				}
			}

			§§ Answers the Algebraic as a decimal with exactly that many places.
			§§
			§§ The digits are padded with zeroes where the rounded value is shorter. The last digit kept is rounded in the named direction, and `#Nearest` is what a call that names none is given. A count below one rounds to a whole number, and no point is written. The `#Percent` format takes the count the same way, on one hundred times the value. The `#Scientific` format counts the digits of the mantissa after the point. The `#Fraction` format ignores both the count and the direction, and writes the symbolic form.
			§§
			§§ @param as — the form to represent the Algebraic in
			§§ @param toPlaces — how many digits to write after the point
			§§ @param toward — the direction to round the last digit in, `#Nearest` when it is left out
			§§ @returns — the String representation of the Algebraic.
			(
				as format: NumberFormat,
				toPlaces count: Integer,
				toward direction: Rounding = #Nearest,
			) -> String {
				constant value = @

				<- match format -> String {
					case #Fraction { <- value::toString() }

					case #Decimal {
						<- value
							::round(toPlaces count, toward direction)
							::toString(
								as #Decimal,
								toPlaces count,
								toward direction,
							)
					}

					case #Percent {
						<- value
							::round(toPlaces count::add(2), toward direction)
							::toString(
								as #Percent,
								toPlaces count,
								toward direction,
							)
					}

					case #Scientific {
						<- value
							::approximate(toPlaces 80, toward direction)
							::toString(
								as #Scientific,
								toPlaces count,
								toward direction,
							)
					}
				}
			}
		}

		§§ Answers the exact sum of the Algebraic and a number.
		§§
		§§ Two Algebraics over the same radical stay in the slice. Their radical parts can also cancel, which leaves a Rational. Two roots of different numbers have no sum in this slice, and the answer is empty. The `defaultingTo:` entry answers the given value in place of empty.
		overload add {
			§§ Answers the exact sum of the Algebraic and an Integer.
			§§
			§§ An Integer shifts the rational part and leaves the radical in place, so the sum is again an Algebraic.
			§§
			§§ @param _ — the Integer to add
			§§ @returns — the exact sum.
			(_ other: Integer) -> Algebraic

			§§ Answers the exact sum of the Algebraic and a Rational.
			§§
			§§ A Rational shifts the rational part and leaves the radical in place, so the sum is again an Algebraic.
			§§
			§§ @param _ — the Rational to add
			§§ @returns — the exact sum.
			(_ other: Rational) -> Algebraic

			§§ Answers the exact sum of the two Algebraics.
			§§
			§§ Over the same radical the sum stays in the slice, and can collapse to a Rational. Over different radicals there is no sum yet, and the answer is empty.
			§§
			§§ @param _ — the Algebraic to add
			§§ @returns — the sum, or nothing when the radicals differ.
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
		§§ Subtracting an equal radical part leaves a Rational. Two roots of different numbers have no difference in this slice, and the answer is empty. The `defaultingTo:` entry answers the given value in place of empty.
		overload subtract {
			§§ Answers the exact difference of the Algebraic and an Integer.
			§§
			§§ An Integer shifts the rational part and leaves the radical in place, so the difference is again an Algebraic.
			§§
			§§ @param _ — the Integer to subtract
			§§ @returns — the exact difference.
			(_ other: Integer) -> Algebraic {
				<- @::add(other::negate())
			}

			§§ Answers the exact difference of the Algebraic and a Rational.
			§§
			§§ A Rational shifts the rational part and leaves the radical in place, so the difference is again an Algebraic.
			§§
			§§ @param _ — the Rational to subtract
			§§ @returns — the exact difference.
			(_ other: Rational) -> Algebraic {
				<- @::add(other::negate())
			}

			§§ Answers the exact difference of the two Algebraics.
			§§
			§§ Over the same radical the difference stays in the slice, and can collapse to a Rational. Over different radicals there is no difference, and the answer is empty.
			§§
			§§ @param _ — the Algebraic to subtract
			§§ @returns — the difference, or nothing when the radicals differ.
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
		§§ A radical times itself turns rational: `√2 · √2` is `2`. Multiplying by zero answers zero. Multiplying by a NonZeroInteger or a NonZeroRational keeps the radical, so those entries answer an Algebraic. The `defaultingTo:` entry answers the given value in place of empty.
		overload multiply {
			§§ Answers the exact product of the Algebraic and an Integer.
			§§
			§§ An Integer scales both parts and leaves the radical in place. A zero factor collapses the product to the Rational zero.
			§§
			§§ @param with — the Integer to multiply with
			§§ @returns — the exact product, an Algebraic or a Rational.
			(with other: Integer) -> Algebraic | Rational

			§§ Answers the exact product of the Algebraic and a Rational.
			§§
			§§ A Rational scales both parts and leaves the radical in place. A zero factor collapses the product to the Rational zero.
			§§
			§§ @param with — the Rational to multiply with
			§§ @returns — the exact product, an Algebraic or a Rational.
			(with other: Rational) -> Algebraic | Rational

			§§ Answers the exact product of the two Algebraics.
			§§
			§§ Over the same radical the product stays exact: `√2 · √2` is `2`. Two pure radicals combine across radicals: `√2 · √3` is `√6`. Anything else is empty.
			§§
			§§ @param with — the Algebraic to multiply with
			§§ @returns — the product, or nothing when there is none.
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

			§§ Answers the exact product of the Algebraic and a Rational factor proven not to be zero.
			§§
			§§ A Rational that is not zero scales both parts and leaves the radical in place. The answer is again an Algebraic rather than a Union.
			§§
			§§ @param with — the factor, proven not to be zero
			§§ @returns — the exact product.
			(with other: NonZeroRational) -> Algebraic
		}

		§§ Answers the exact quotient of the Algebraic and a number.
		§§
		§§ Dividing by an Integer or a Rational is empty only for zero. Dividing by a NonZeroInteger or a NonZeroRational can not fail, because those divisors are proven. Dividing by an Algebraic multiplies by its reciprocal, which the conjugate always gives. That quotient is empty wherever the matching product is empty. The `defaultingTo:` entries answer the given value in place of empty.
		overload divide {
			§§ Answers the exact quotient of the Algebraic and an Integer.
			§§
			§§ A divisor that is not zero scales both parts and leaves the radical in place. A zero divisor answers empty.
			§§
			§§ @param by — the divisor
			§§ @returns — the exact quotient, or nothing when the divisor is zero.
			(by other: Integer) -> Optional<Algebraic>

			§§ Answers the exact quotient of the Algebraic and a Rational.
			§§
			§§ A divisor that is not zero scales both parts and leaves the radical in place. A zero divisor answers empty.
			§§
			§§ @param by — the divisor
			§§ @returns — the exact quotient, or nothing when the divisor is zero.
			(by other: Rational) -> Optional<Algebraic>

			§§ Answers the exact quotient of the two Algebraics.
			§§
			§§ The divisor's conjugate gives its reciprocal, and the quotient is that product. It is empty wherever the matching product is empty.
			§§
			§§ @param by — the divisor
			§§ @returns — the quotient, or nothing when there is none.
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

			§§ Answers the exact quotient of the Algebraic and a Rational divisor proven not to be zero.
			§§
			§§ The division can not fail, so the answer is the quotient itself rather than an Optional.
			§§
			§§ @param by — the divisor, proven not to be zero
			§§ @returns — the exact quotient.
			(by other: NonZeroRational) -> Algebraic
		}

		§ An Algebraic is never zero, so it is below its own negation exactly
		§ when it is negative, and above it exactly when it is positive. This
		§ Namespace's own `compare` decides both. The covering `Number`'s
		§ `isLessThan(0)` says the same and reaches the whole numeric tower;
		§ see DEVELOPMENT.md, Why bodies look the way they do.
		§
		§ `isZero` and `isWholeNumber` answer `false` for every Algebraic.
		§ They stand here for the reason `Integer::isWholeNumber` answers
		§ `true` for every Integer. A Union receiver dispatches only where
		§ every member Namespace declares the Method, so these two are what
		§ let a `Number` ask either question at all.

		§§ Answers whether the Algebraic is above zero.
		§§
		§§ The sign of `a + b·√d` is exactly decidable. No approximation is consulted.
		isPositive() -> Boolean {
			<- @::compare(to @::negate())::is(#Greater)
		}

		§§ Answers whether the Algebraic is below zero.
		§§
		§§ The sign of `a + b·√d` is exactly decidable. No approximation is consulted.
		isNegative() -> Boolean {
			<- @::compare(to @::negate())::is(#Less)
		}

		§§ Answers whether the Algebraic is exactly zero.
		§§
		§§ An Algebraic carries a radical with a coefficient that is not zero, so the answer is always `false`.
		isZero() -> Boolean {
			<- false
		}

		§§ Answers whether the Algebraic is a whole number.
		§§
		§§ An Algebraic is irrational, so it is never whole and the answer is always `false`.
		isWholeNumber() -> Boolean {
			<- false
		}

		§§ Answers the Algebraic without its sign, which is its distance from zero.
		§§
		§§ The sign of `a + b·√d` is exactly decidable. No approximation is consulted.
		absolute() -> Algebraic {
			if @::isNegative() {
				<- @::negate()
			} else {
				<- @
			}
		}

		§§ Answers the Algebraic with its sign flipped.
		§§
		§§ Negating an irrational leaves it irrational, so the answer is again an Algebraic.
		negate() -> Algebraic

		§ The two Methods that hand an Algebraic to a reader as digits. Both
		§ rest on the certified enclosure the runtime already refines for the
		§ ordering. The interval narrows until the rounding at the width asked
		§ for is decided, and that step is the answer. Nothing here estimates.
		§ The native is what reaches the enclosure, which no Essence body can.
		§ It always ends: an Algebraic is irrational, so it never sits on the
		§ point a rounding rule steps at.

		§§ Answers the Algebraic as a Rational on a decimal grid of the given width.
		§§
		§§ Five places answer the value rounded to hundred-thousandths, so `2::squareRoot()` over five places answers `141421/100000`. This Method is where a Program asks for digits in place of the exact value. The answer is exact all the same: it is the step of that grid the value rounds to. A width of no places answers a whole number, as a Rational.
		§§
		§§ @param toPlaces — how many decimal places the grid keeps
		§§ @param toward — the direction to round in, `#Nearest` when it is left out
		§§ @returns — the value on the grid the width names.
		approximate(
			toPlaces places: NonNegativeInteger,
			toward direction: Rounding = #Nearest,
		) -> Rational

		§§ Answers the Algebraic rounded in the named direction.
		§§
		§§ The direction is `#Nearest` when a call names none. An irrational is never exactly halfway between two steps, so `#Nearest` and `#NearestEven` answer alike here. The other directions answer the floor for `#Down`, the ceiling for `#Up`, and the step towards zero for `#TowardZero`. Naming a count of places rounds to a decimal grid of that width instead, and answers a Rational.
		overload round {
			§§ Answers the Algebraic as an Integer, rounded in the named direction.
			§§
			§§ @param toward — the direction to round in, `#Nearest` when it is left out
			§§ @returns — the rounded Integer.
			(toward direction: Rounding = #Nearest) -> Integer

			§§ Answers the Algebraic rounded to a decimal grid of the given width.
			§§
			§§ Two places round to hundredths. The answer is what `approximate(toPlaces:toward:)` answers, and a count below one rounds to a whole number. The entry stands here so that a Number receiver reaches `round` at every width, whichever kind it holds.
			§§
			§§ @param toPlaces — how many decimal places to keep
			§§ @param toward — the direction to round in, `#Nearest` when it is left out
			§§ @returns — the rounded Rational.
			(
				toPlaces places: Integer,
				toward direction: Rounding = #Nearest,
			) -> Rational {
				§ The `if` proves the width is not negative, which is what
				§ `approximate` asks of it. See DEVELOPMENT.md, Why bodies look
				§ the way they do.
				if places::isPositive() {
					<- @::approximate(toPlaces places, toward direction)
				} else {
					<- @::approximate(toPlaces 0, toward direction)
				}
			}
		}
	}
}

export {
	Algebraic
}
