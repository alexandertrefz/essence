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
		§§ @example
		§§   constant golden = Number.GoldenRatio
		§§   constant rootFive = golden::multiply(with 2)::subtract(1)
		§§
		§§   expect rootFive::is(golden::subtract(1/2)::multiply(with 2))
		§§   expect rootFive::is(golden)::negate()
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
		§§ @example
		§§   constant golden = Number.GoldenRatio
		§§   constant rootFive = golden::multiply(with 2)::subtract(1)
		§§
		§§   expect golden::compare(to rootFive)::is(#Less)
		§§   expect rootFive::compare(to golden::add(1/2))::is(#Greater)
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
		§ so it is read two digits deeper and the shift stays exact. It is
		§ never read shallower than those two, which a count below zero would
		§ otherwise ask for. A scientific form counts the digits of a mantissa
		§ rather than of the value. So its depth is where the exponent falls:
		§ `decimalExponent` answers that, and the reading is taken that many
		§ digits off the count. Reading at a fixed eightieth digit is the
		§ cheaper alternative. It is wrong for a mantissa. It writes zeroes it
		§ never read past the eightieth place, and answers `0e0` for a value
		§ `isPositive` answers `true` for.

		§§ Answers the Algebraic as a String, in the exact symbolic form or in the named format.
		§§
		§§ The form is `√2`, `3·√2` or `1 + √2` when no format is named, and `#Fraction` names that same form. The `#Decimal` format writes the expansion, to at most 80 digits, which is the cap a Rational writes a non-terminating expansion at. A count of places writes exactly that many digits after the point.
		overload toString {
			§§ Answers the Algebraic as a String, in the exact symbolic form: `√2`, `3·√2` or `1 + √2`.
			§§
			§§ One radical has one printed form, with one exception. Normalisation divides out square factors up to 65536, so a radicand `p²·q` with both primes above that is printed as written. The equal `p·√q` prints in the normalised form.
			§§
			§§ @example
			§§   expect 2::squareRoot()::toString()::is("√2")
			§§   expect 18::squareRoot()::toString()::is("3·√2")
			§§   expect Number.GoldenRatio::toString()::is("1/2 + 1/2·√5")
			() -> String

			§§ Answers the Algebraic as a decimal, or in the exact symbolic form, in the named format.
			§§
			§§ The `#Decimal` format rounds the expansion at the eightieth digit and writes it. An irrational expansion never ends, so the cap is always reached. Trailing zeros the rounding leaves are dropped, as they are for any Rational. The `#Percent` format writes one hundred times that same reading, taken two digits deeper so that eighty still stand after the point. The `#Scientific` format writes eighty digits after the point of the mantissa, and the power of ten after an `e`. The reading is taken at the eightieth digit of the mantissa, wherever the value falls. A value below one is read deeper than eighty places. The `#Fraction` format writes the symbolic form, since no ratio of two Integers is this number.
			§§
			§§ @example
			§§   constant root = 2::squareRoot()
			§§
			§§   expect root::toString(as #Decimal)::starts(with "1.41421356237")
			§§   expect root::toString(as #Decimal)::length()::is(82)
			§§   expect root::toString(as #Fraction)::is("√2")
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
						constant depth = 80::subtract(value::decimalExponent())

						<- value
							::round(toPlaces depth)
							::toString(as #Scientific)
					}
				}
			}

			§§ Answers the Algebraic as a decimal with exactly that many places.
			§§
			§§ The digits are padded with zeroes where the rounded value is shorter. The last digit kept is rounded in the named direction, and `#Nearest` is what a call that names none is given. A count below one rounds to a whole number, and no point is written. The `#Percent` format takes the count the same way, on one hundred times the value. The `#Scientific` format counts the digits of the mantissa after the point, at every magnitude. The value is read as many digits past the count as its own power of ten falls below zero. The `#Fraction` format ignores both the count and the direction, and writes the symbolic form.
			§§
			§§ @example
			§§   constant root = 2::squareRoot()
			§§
			§§   expect root::toString(as #Decimal, toPlaces 3)::is("1.414")
			§§   expect root::toString(as #Decimal, toPlaces 3, toward #Up)::is("1.415")
			§§   expect root::toString(as #Percent, toPlaces 1)::is("141.4%")
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
						constant depth = define {
							as count::add(2) if count::isPositive()
							as 2             otherwise
						}

						<- value
							::round(toPlaces depth, toward direction)
							::toString(
								as #Percent,
								toPlaces count,
								toward direction,
							)
					}

					case #Scientific {
						constant depth = count::subtract(
							value::decimalExponent(),
						)

						<- value
							::round(toPlaces depth, toward direction)
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
			§§ @example
			§§   expect 2::squareRoot()::add(1)::toString()::is("1 + √2")
			§§   expect 2::squareRoot()::add(-1)::toString()::is("-1 + √2")
			§§
			§§ @param _ — the Integer to add
			§§ @returns — the exact sum.
			(_ other: Integer) -> Algebraic

			§§ Answers the exact sum of the Algebraic and a Rational.
			§§
			§§ A Rational shifts the rational part and leaves the radical in place, so the sum is again an Algebraic.
			§§
			§§ @example
			§§   expect 2::squareRoot()::add(1/2)::toString()::is("1/2 + √2")
			§§
			§§ @param _ — the Rational to add
			§§ @returns — the exact sum.
			(_ other: Rational) -> Algebraic

			§§ Answers the exact sum of the two Algebraics.
			§§
			§§ Over the same radical the sum stays in the slice, and can collapse to a Rational. Over different radicals the sum falls outside what an Algebraic holds, and the answer is empty.
			§§
			§§ @example
			§§   constant golden = Number.GoldenRatio
			§§   constant conjugate = golden::negate()::add(1)
			§§
			§§   expect golden::add(golden)::is(golden::multiply(with 2))
			§§   expect golden::add(conjugate)::is(1/1)
			§§
			§§ @param _ — the Algebraic to add
			§§ @returns — the sum, or nothing when the radicals differ.
			(_ other: Algebraic) -> Optional<Rational | Algebraic>

			§§ Answers the exact sum of the two Algebraics.
			§§
			§§ Over different radicals there is no sum, and the answer is the given value.
			§§
			§§ @example
			§§   constant golden = Number.GoldenRatio
			§§
			§§   expect golden::add(golden, defaultingTo 0/1)::toString()::is("1 + √5")
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
			§§ @example
			§§   expect 2::squareRoot()::subtract(1)::toString()::is("-1 + √2")
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
			§§ @example
			§§   expect 2::squareRoot()::subtract(1/2)::toString()::is("-1/2 + √2")
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
			§§ @example
			§§   constant golden = Number.GoldenRatio
			§§
			§§   expect golden::subtract(golden::multiply(with 2))::is(golden::negate())
			§§   expect golden::subtract(golden::subtract(1))::is(1/1)
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
			§§ @example
			§§   constant golden = Number.GoldenRatio
			§§   constant smaller = golden::subtract(1)
			§§
			§§   expect golden::subtract(smaller, defaultingTo 0/1)::is(1)
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
			§§ @example
			§§   constant root = 2::squareRoot()
			§§   constant copies = 3
			§§
			§§   expect root::multiply(with copies)::toString()::is("3·√2")
			§§   expect root::multiply(with 0)::is(0)
			§§
			§§ @param with — the Integer to multiply with
			§§ @returns — the exact product, an Algebraic or a Rational.
			(with other: Integer) -> Algebraic | Rational

			§§ Answers the exact product of the Algebraic and a Rational.
			§§
			§§ A Rational scales both parts and leaves the radical in place. A zero factor collapses the product to the Rational zero.
			§§
			§§ @example
			§§   constant root = 2::squareRoot()
			§§   constant half = 1/2
			§§
			§§   expect root::multiply(with half)::toString()::is("1/2·√2")
			§§   expect root::multiply(with 0/1)::is(0)
			§§
			§§ @param with — the Rational to multiply with
			§§ @returns — the exact product, an Algebraic or a Rational.
			(with other: Rational) -> Algebraic | Rational

			§§ Answers the exact product of the two Algebraics.
			§§
			§§ Over the same radical the product stays exact: `√2 · √2` is `2`. Two pure radicals combine across radicals: `√2 · √3` is `√6`. Anything else is empty.
			§§
			§§ @example
			§§   constant golden = Number.GoldenRatio
			§§
			§§   expect golden::multiply(with golden)::is(golden::add(1))
			§§   expect golden::multiply(with golden::subtract(1))::is(1/1)
			§§
			§§ @param with — the Algebraic to multiply with
			§§ @returns — the product, or nothing when there is none.
			(with other: Algebraic) -> Optional<Rational | Algebraic>

			§§ Answers the exact product of the two Algebraics.
			§§
			§§ Where there is no product, the answer is the given value.
			§§
			§§ @example
			§§   constant golden = Number.GoldenRatio
			§§   constant squared = golden::multiply(with golden, defaultingTo 0/1)
			§§
			§§   expect squared::is(golden::add(1))
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
			§§ @example
			§§   expect 2::squareRoot()::multiply(with 3)::toString()::is("3·√2")
			§§   expect Number.GoldenRatio::multiply(with 2)::toString()::is("1 + √5")
			§§
			§§ @param with — the factor, proven not to be zero
			§§ @returns — the exact product.
			(with other: NonZeroInteger) -> Algebraic

			§§ Answers the exact product of the Algebraic and a Rational factor proven not to be zero.
			§§
			§§ A Rational that is not zero scales both parts and leaves the radical in place. The answer is again an Algebraic rather than a Union.
			§§
			§§ @example
			§§   expect 2::squareRoot()::multiply(with 1/2)::toString()::is("1/2·√2")
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
			§§ @example
			§§   constant golden = Number.GoldenRatio
			§§   constant divisor = 2
			§§
			§§   expect golden::divide(by divisor)::is(golden::multiply(with 1/2))
			§§   expect golden::divide(by 0)::isEmpty()
			§§
			§§ @param by — the divisor
			§§ @returns — the exact quotient, or nothing when the divisor is zero.
			(by other: Integer) -> Optional<Algebraic>

			§§ Answers the exact quotient of the Algebraic and a Rational.
			§§
			§§ A divisor that is not zero scales both parts and leaves the radical in place. A zero divisor answers empty.
			§§
			§§ @example
			§§   constant golden = Number.GoldenRatio
			§§   constant half = 1/2
			§§
			§§   expect golden::divide(by half)::is(golden::multiply(with 2))
			§§   expect golden::divide(by 0/1)::isEmpty()
			§§
			§§ @param by — the divisor
			§§ @returns — the exact quotient, or nothing when the divisor is zero.
			(by other: Rational) -> Optional<Algebraic>

			§§ Answers the exact quotient of the two Algebraics.
			§§
			§§ The divisor's conjugate gives its reciprocal, and the quotient is that product. It is empty wherever the matching product is empty.
			§§
			§§ @example
			§§   constant golden = Number.GoldenRatio
			§§
			§§   expect golden::divide(by golden)::is(1/1)
			§§   expect golden::divide(by golden::subtract(1))::is(golden::add(1))
			§§
			§§ @param by — the divisor
			§§ @returns — the quotient, or nothing when there is none.
			(by other: Algebraic) -> Optional<Rational | Algebraic>

			§§ Answers the exact quotient of the Algebraic and an Integer.
			§§
			§§ A zero divisor answers the given value.
			§§
			§§ @example
			§§   constant golden = Number.GoldenRatio
			§§   constant halved = golden::multiply(with 1/2)
			§§   constant divisor = 2
			§§
			§§   expect golden::divide(by divisor, defaultingTo golden)::is(halved)
			§§   expect golden::divide(by 0, defaultingTo golden)::is(golden)
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
			§§ @example
			§§   constant golden = Number.GoldenRatio
			§§   constant doubled = golden::multiply(with 2)
			§§   constant half = 1/2
			§§
			§§   expect golden::divide(by half, defaultingTo golden)::is(doubled)
			§§   expect golden::divide(by 0/1, defaultingTo golden)::is(golden)
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
			§§ @example
			§§   constant golden = Number.GoldenRatio
			§§
			§§   expect golden::divide(by golden, defaultingTo 0/1)::is(1)
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
			§§ @example
			§§   expect 2::squareRoot()::divide(by 2)::toString()::is("1/2·√2")
			§§
			§§ @param by — the divisor, proven not to be zero
			§§ @returns — the exact quotient.
			(by other: NonZeroInteger) -> Algebraic

			§§ Answers the exact quotient of the Algebraic and a Rational divisor proven not to be zero.
			§§
			§§ The division can not fail, so the answer is the quotient itself rather than an Optional.
			§§
			§§ @example
			§§   expect 2::squareRoot()::divide(by 1/2)::toString()::is("2·√2")
			§§
			§§ @param by — the divisor, proven not to be zero
			§§ @returns — the exact quotient.
			(by other: NonZeroRational) -> Algebraic
		}

		§ There is no `squareRoot` beside this. A root of `a + b·√d` is a root
		§ of a quartic, and lies in this slice only where `a² − b²·d` is a
		§ square. So `√(3 + 2·√2)` is `1 + √2`, and `√(1 + √2)` is no
		§ Algebraic at all. An entry answering an Optional would be empty for
		§ almost every receiver, so the root waits for the representation that
		§ can hold it.

		§§ Answers the Algebraic raised to the given power, exactly.
		§§
		§§ The slice is closed under Integer powers, so every power is exact. A power can cancel the radical, so `2::squareRoot()` squared is the Rational `2`. A negative exponent answers the power of the reciprocal, which always exists, since an Algebraic is never zero. A zero exponent answers `1`.
		§§
		§§ @example
		§§   constant root = 2::squareRoot()
		§§
		§§   expect root::raise(to 2)::is(2)
		§§   expect root::raise(to 3)::toString()::is("2·√2")
		§§   expect root::raise(to -2)::is(1/2)
		§§
		§§ @param to — the exponent
		§§ @returns — the exact power, an Algebraic or a Rational.
		raise(to exponent: Integer) -> Rational | Algebraic

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
		§§
		§§ @example
		§§   constant root = 2::squareRoot()
		§§
		§§   expect root::subtract(1.4142)::isPositive()
		§§   expect root::subtract(1.4143)::isPositive()::negate()
		isPositive() -> Boolean {
			<- @::compare(to @::negate())::is(#Greater)
		}

		§§ Answers whether the Algebraic is below zero.
		§§
		§§ The sign of `a + b·√d` is exactly decidable. No approximation is consulted.
		§§
		§§ @example
		§§   constant root = 2::squareRoot()
		§§
		§§   expect root::subtract(1.4143)::isNegative()
		§§   expect root::isNegative()::negate()
		isNegative() -> Boolean {
			<- @::compare(to @::negate())::is(#Less)
		}

		§§ Answers whether the Algebraic is exactly zero.
		§§
		§§ An Algebraic carries a radical with a coefficient that is not zero, so the answer is always `false`.
		§§
		§§ @example
		§§   expect 2::squareRoot()::isZero()::negate()
		isZero() -> Boolean {
			<- false
		}

		§§ Answers whether the Algebraic is a whole number.
		§§
		§§ An Algebraic is irrational, so it is never whole and the answer is always `false`.
		§§
		§§ @example
		§§   expect 2::squareRoot()::isWholeNumber()::negate()
		isWholeNumber() -> Boolean {
			<- false
		}

		§§ Answers the Algebraic without its sign, which is its distance from zero.
		§§
		§§ The sign of `a + b·√d` is exactly decidable. No approximation is consulted.
		§§
		§§ @example
		§§   constant root = 2::squareRoot()
		§§
		§§   expect root::negate()::absolute()::is(root)
		§§   expect root::subtract(2)::absolute()::is(root::negate()::add(2))
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
		§§
		§§ @example
		§§   constant root = 2::squareRoot()
		§§
		§§   expect root::negate()::toString()::is("-√2")
		§§   expect root::negate()::negate()::is(root)
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
		§§ @example
		§§   constant root = 2::squareRoot()
		§§
		§§   expect root::approximate(toPlaces 5)::is(1.41421)
		§§   expect root::approximate(toPlaces 2, toward #Up)::is(1.42)
		§§   expect root::approximate(toPlaces 0)::is(1/1)
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
			§§ @example
			§§   constant root = 2::squareRoot()
			§§
			§§   expect root::round()::is(1)
			§§   expect root::round(toward #Up)::is(2)
			§§
			§§ @param toward — the direction to round in, `#Nearest` when it is left out
			§§ @returns — the rounded Integer.
			(toward direction: Rounding = #Nearest) -> Integer

			§§ Answers the Algebraic rounded to a decimal grid of the given width.
			§§
			§§ Two places round to hundredths. The answer is what `approximate(toPlaces:toward:)` answers, and a count below one rounds to a whole number. The entry stands here so that a Number receiver reaches `round` at every width, whichever kind it holds.
			§§
			§§ @example
			§§   constant root = 2::squareRoot()
			§§
			§§   expect root::round(toPlaces 2)::is(1.41)
			§§   expect root::round(toPlaces 2, toward #Up)::is(1.42)
			§§   expect root::round(toPlaces 0)::is(1/1)
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

		§ The width every reading of a mantissa is decided by, and the third
		§ Method written on the same enclosure. It stands here because the
		§ `#Scientific` arm above can not compute it. An Essence body reaches
		§ no enclosure, and the exponent is what says how deep that arm reads.

		§§ Answers the power of ten at or below the Algebraic's distance from zero.
		§§
		§§ This is the exponent the `#Scientific` format writes after the `e`. A value between one and ten answers zero, and a value between a tenth and one answers minus one. The enclosure widens until it falls inside one such power of ten. That always happens: an Algebraic is irrational, so it is never a power of ten itself.
		§§
		§§ @example
		§§   constant golden = Number.GoldenRatio
		§§
		§§   expect golden::decimalExponent()::is(0)
		§§   expect golden::subtract(1)::decimalExponent()::is(-1)
		§§   expect golden::multiply(with 10)::decimalExponent()::is(1)
		§§
		§§ @returns — the exponent of the power of ten the value falls on.
		decimalExponent() -> Integer
	}
}

export {
	Algebraic
}
