import {
	from "./Boolean.es" { Boolean }
	from "./Integer.es" {
		Integer
		NonNegativeInteger
		NonZeroInteger
		PositiveInteger
	}
	from "./Optional.es" { Optional }
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

	§ A number that is provably not algebraic. For now it is the linear
	§ slice `a + b·π + c·e` over the bases Pi and E, which keeps Pi, Tau and
	§ E exact. Whether a value over both bases can equal another number is
	§ an open problem, so Transcendental does not conform to Comparable. A
	§ conformance would promise a total `compare`, and the one the runtime
	§ has stops at a precision cutoff. Every comparison is still reachable,
	§ against a Transcendental as much as against another kind, through the
	§ covering `Number`'s rung, which carries that cutoff. The bounded
	§ `compare(to:withPrecision:)` below is the form that never reaches it.
	namespace Transcendental for Transcendental is Equatable, is Printable {
		§ `is`, `compare` and `absolute` are native. None reaches a primitive
		§ this Namespace declares. Equality is decided by the canonical form
		§ itself, and the sign of `a + b·π + c·e` needs an ordering
		§ Transcendental declares nowhere. Reading the covering `Number`
		§ instead puts the whole numeric tower behind an equality check; see
		§ DEVELOPMENT.md, Why bodies look the way they do.

		§§ Answers whether both Transcendentals have the same canonical form.
		§§
		§§ Every component is held reduced, so agreement is structural. On a single base that agreement is exactly numeric equality.
		§§
		§§ @param _ — the Transcendental to compare with
		§§ @returns — `true` when the canonical forms agree.
		is(_ other: Transcendental) -> Boolean

		§§ Orders the Transcendental against another one, to a given number of decimal places.
		§§
		§§ The difference of the two is enclosed in an interval under one unit of the last decimal place wide. The answer is read off that interval. Two values one unit of that place or more apart are always told apart. The answer is empty only for two values closer than that. Two values whose π and e terms cancel differ by a Rational, and compare exactly at any width. No call here reaches the precision cutoff that `Number::compare` can, since nothing is refined past the width given.
		§§
		§§ @param to — the Transcendental to order against
		§§ @param withPrecision — the number of decimal places the two are told apart to
		§§ @returns — `Ordering#Less`, `Ordering#Equal` or `Ordering#Greater`, or nothing when the two are not told apart at that width.
		compare(
			to other: Transcendental,
			withPrecision digits: PositiveInteger,
		) -> Optional<Ordering>

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

		§§ Answers the Transcendental as a String, in the exact symbolic form or in the named format.
		§§
		§§ The form is `π`, `2·π`, `e` or `1 + π + e` when no format is named, and `#Fraction` names that same form. The `#Decimal` format writes the expansion, to at most 80 digits, which is the cap a Rational writes a non-terminating expansion at. A count of places writes exactly that many digits after the point.
		overload toString {
			§§ Answers the Transcendental as a String, in the exact symbolic form: `π`, `2·π`, `e` or `1 + π + e`.
			() -> String

			§§ Answers the Transcendental as a decimal, or in the exact symbolic form, in the named format.
			§§
			§§ The `#Decimal` format rounds the expansion at the eightieth digit and writes it. An irrational expansion never ends, so the cap is always reached. Trailing zeros the rounding leaves are dropped, as they are for any Rational. The `#Percent` format writes one hundred times that same reading, taken two digits deeper so that eighty still stand after the point. The `#Scientific` format writes that reading with one digit before the point and the power of ten after an `e`. The `#Fraction` format writes the symbolic form, since no ratio of two Integers is this number.
			§§
			§§ @param as — the form to represent the Transcendental in
			§§ @returns — the String representation of the Transcendental.
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

			§§ Answers the Transcendental as a decimal with exactly that many places.
			§§
			§§ The digits are padded with zeroes where the rounded value is shorter. The last digit kept is rounded in the named direction, and `#Nearest` is what a call that names none is given. A count below one rounds to a whole number, and no point is written. The `#Percent` format takes the count the same way, on one hundred times the value. The `#Scientific` format counts the digits of the mantissa after the point. The `#Fraction` format ignores both the count and the direction, and writes the symbolic form.
			§§
			§§ @param as — the form to represent the Transcendental in
			§§ @param toPlaces — how many digits to write after the point
			§§ @param toward — the direction to round the last digit in, `#Nearest` when it is left out
			§§ @returns — the String representation of the Transcendental.
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

		§§ Answers the exact sum of the Transcendental and a number.
		§§
		§§ Two Transcendentals can cancel their π and e terms, which leaves a Rational.
		overload add {
			§§ Adds an Integer to the Transcendental.
			§§
			§§ The sum is a Transcendental, since an Integer changes the rational part alone.
			§§
			§§ @param _ — the Integer to add
			§§ @returns — the sum, as a Transcendental.
			(_ other: Integer) -> Transcendental

			§§ Adds a Rational to the Transcendental.
			§§
			§§ The sum is a Transcendental, since a Rational changes the rational part alone.
			§§
			§§ @param _ — the Rational to add
			§§ @returns — the sum, as a Transcendental.
			(_ other: Rational) -> Transcendental

			§§ Answers the exact sum of the two Transcendentals.
			§§
			§§ The π and e parts can cancel, which leaves a Rational.
			§§
			§§ @param _ — the Transcendental to add
			§§ @returns — the exact sum, a Rational or a Transcendental.
			(_ other: Transcendental) -> Rational | Transcendental
		}

		§§ Answers the exact difference of the Transcendental and a number.
		§§
		§§ Subtracting equal π and e terms leaves a Rational.
		overload subtract {
			§§ Subtracts an Integer from the Transcendental.
			§§
			§§ The difference is a Transcendental, since an Integer changes the rational part alone.
			§§
			§§ @param _ — the Integer to subtract
			§§ @returns — the difference, as a Transcendental.
			(_ other: Integer) -> Transcendental {
				<- @::add(other::negate())
			}

			§§ Subtracts a Rational from the Transcendental.
			§§
			§§ The difference is a Transcendental, since a Rational changes the rational part alone.
			§§
			§§ @param _ — the Rational to subtract
			§§ @returns — the difference, as a Transcendental.
			(_ other: Rational) -> Transcendental {
				<- @::add(other::negate())
			}

			§§ Subtracts one Transcendental from another.
			§§
			§§ Equal π and e terms cancel, which leaves a Rational. Every other difference is a Transcendental.
			§§
			§§ @param _ — the Transcendental to subtract
			§§ @returns — the difference, as a Rational or a Transcendental.
			(_ other: Transcendental) -> Rational | Transcendental {
				<- @::add(other::negate())
			}
		}

		§§ Answers the exact product of the Transcendental and an Integer or a Rational.
		§§
		§§ Multiplying by zero answers zero. Multiplying by a NonZeroInteger or a NonZeroRational keeps every base term, so those entries answer a Transcendental. Two Transcendentals can not be multiplied: `π·π` and `π·e` leave the linear grammar.
		overload multiply {
			§§ Multiplies the Transcendental with an Integer.
			§§
			§§ The product is a Transcendental, since an Integer scales the rational part and every base term. A zero factor answers zero, which is a Rational.
			§§
			§§ @param with — the Integer to multiply with
			§§ @returns — the product, as a Transcendental or a Rational.
			(with other: Integer) -> Transcendental | Rational

			§§ Multiplies the Transcendental with a Rational.
			§§
			§§ The product is a Transcendental, since a Rational scales the rational part and every base term. A zero factor answers zero, which is a Rational.
			§§
			§§ @param with — the Rational to multiply with
			§§ @returns — the product, as a Transcendental or a Rational.
			(with other: Rational) -> Transcendental | Rational

			§§ Answers the exact product of the Transcendental and a factor proven not to be zero.
			§§
			§§ A non-zero Integer scales the rational part and every base term, and no coefficient reaches zero. The answer is again a Transcendental rather than a Union.
			§§
			§§ @param with — the factor, proven not to be zero
			§§ @returns — the exact product.
			(with other: NonZeroInteger) -> Transcendental

			§§ Answers the exact product of the Transcendental and a Rational factor proven not to be zero.
			§§
			§§ A Rational that is not zero scales the rational part and every base term, and no coefficient reaches zero. The answer is again a Transcendental rather than a Union.
			§§
			§§ @param with — the factor, proven not to be zero
			§§ @returns — the exact product.
			(with other: NonZeroRational) -> Transcendental
		}

		§§ Answers the exact quotient of the Transcendental and a number.
		§§
		§§ Dividing by an Integer or a Rational is empty only for zero. Dividing by a NonZeroInteger or a NonZeroRational can not fail, because those divisors are proven. Dividing by another Transcendental answers a Rational when the two are proportional: `Tau::divide(by Pi)` is `2`. Anything else is empty. The `defaultingTo:` entries answer the given value in place of empty.
		overload divide {
			§§ Divides the Transcendental by an Integer.
			§§
			§§ The quotient is a Transcendental, since an Integer scales the rational part and every base term. A zero divisor answers empty, and the `defaultingTo:` entry answers the given value instead.
			§§
			§§ @param by — the Integer to divide by
			§§ @returns — the quotient, or nothing when the divisor is zero.
			(by other: Integer) -> Optional<Transcendental>

			§§ Divides the Transcendental by a Rational.
			§§
			§§ The quotient is a Transcendental, since a Rational scales the rational part and every base term. A zero divisor answers empty, and the `defaultingTo:` entry answers the given value instead.
			§§
			§§ @param by — the Rational to divide by
			§§ @returns — the quotient, or nothing when the divisor is zero.
			(by other: Rational) -> Optional<Transcendental>

			§§ Answers the exact quotient of the two Transcendentals.
			§§
			§§ Proportional values answer a Rational: `Tau::divide(by Pi)` is `2`. Anything else is empty, including π divided by e.
			§§
			§§ @param by — the Transcendental to divide by
			§§ @returns — the quotient, or nothing when the two are not proportional.
			(by other: Transcendental) -> Optional<Rational>

			§§ Answers the exact quotient of the Transcendental and an Integer.
			§§
			§§ A zero divisor answers the given value.
			§§
			§§ @param by — the divisor
			§§ @param defaultingTo — the value to answer with when there is no quotient
			§§ @returns — the quotient, or the given value in its place.
			(
				by other: Integer,
				defaultingTo fallback: Transcendental,
			) -> Transcendental {
				<- @::divide(by other)::value(defaultingTo fallback)
			}

			§§ Answers the exact quotient of the Transcendental and a Rational.
			§§
			§§ A zero divisor answers the given value.
			§§
			§§ @param by — the divisor
			§§ @param defaultingTo — the value to answer with when there is no quotient
			§§ @returns — the quotient, or the given value in its place.
			(
				by other: Rational,
				defaultingTo fallback: Transcendental,
			) -> Transcendental {
				<- @::divide(by other)::value(defaultingTo fallback)
			}

			§§ Answers the exact quotient of the two Transcendentals.
			§§
			§§ Where the two are not proportional, the answer is the given value.
			§§
			§§ @param by — the divisor
			§§ @param defaultingTo — the value to answer with when there is no quotient
			§§ @returns — the quotient, or the given value in its place.
			(
				by other: Transcendental,
				defaultingTo fallback: Rational,
			) -> Rational {
				<- @::divide(by other)::value(defaultingTo fallback)
			}

			§§ Answers the exact quotient of the Transcendental and a divisor proven not to be zero.
			§§
			§§ The division can not fail, so the answer is the quotient itself rather than an Optional.
			§§
			§§ @param by — the divisor, proven not to be zero
			§§ @returns — the exact quotient.
			(by other: NonZeroInteger) -> Transcendental

			§§ Answers the exact quotient of the Transcendental and a Rational divisor proven not to be zero.
			§§
			§§ The division can not fail, so the answer is the quotient itself rather than an Optional.
			§§
			§§ @param by — the divisor, proven not to be zero
			§§ @returns — the exact quotient.
			(by other: NonZeroRational) -> Transcendental
		}

		§ There is no `raise` and no `squareRoot` here. The span is linear in
		§ its bases. Neither `π·π` nor `√π` is a Rational or a value of that
		§ span, so no entry could answer one exactly. An entry answering an
		§ Optional would be empty for every exponent but zero and one. An
		§ entry answering digits would be an estimate this Namespace does not
		§ make. The Method a Program that wants digits reaches for is
		§ `approximate(toPlaces:)`.

		§ A Transcendental is never zero. A value over one base equal to a
		§ Rational would make that base rational. A value over several being
		§ zero would settle an open problem. So `isPositive` and
		§ `isNegative` are contraries, and one is the other negated. The
		§ positive half is native, because this Namespace declares no ordering
		§ to write a sign on. The covering `Number`'s reaches the whole numeric
		§ tower; see DEVELOPMENT.md, Why bodies look the way they do.
		§
		§ `isZero` and `isWholeNumber` answer `false` for every value. They
		§ stand here for the reason `Integer::isWholeNumber` answers `true` for
		§ every Integer. A Union receiver dispatches only where every member
		§ Namespace declares the Method, so these two are what let a `Number`
		§ ask either question at all.

		§§ Answers whether the Transcendental is above zero.
		§§
		§§ A value over a single base has an exact sign. A value that mixes π and e decides its sign by refining an interval, down to the precision limit `absolute` names.
		isPositive() -> Boolean

		§§ Answers whether the Transcendental is below zero.
		§§
		§§ A Transcendental is never zero, so it is below zero exactly when it is not above it. The sign is decided the way `isPositive` decides it.
		isNegative() -> Boolean {
			<- @::isPositive()::negate()
		}

		§§ Answers whether the Transcendental is exactly zero.
		§§
		§§ At least one base term keeps a coefficient that is not zero, so the answer is always `false`.
		isZero() -> Boolean {
			<- false
		}

		§§ Answers whether the Transcendental is a whole number.
		§§
		§§ A Transcendental is irrational, so it is never whole and the answer is always `false`.
		isWholeNumber() -> Boolean {
			<- false
		}

		§§ Answers the Transcendental without its sign, which is its distance from zero.
		§§
		§§ A value on a single base can never equal a Rational, so its sign is exact. A value that mixes π and e decides its sign by refining an interval, down to a documented precision limit.
		absolute() -> Transcendental

		§§ Answers the Transcendental with its sign flipped.
		§§
		§§ At least one base term keeps its non-zero coefficient, so the answer is again a Transcendental.
		negate() -> Transcendental

		§ The two Methods that hand a Transcendental to a reader as digits.
		§ Both rest on the certified enclosure the sign decisions already
		§ refine. The interval narrows until the rounding at the width asked
		§ for is decided, and that step is the answer. Nothing here estimates.
		§ The native is what reaches the enclosure, which no Essence body can.
		§ It is also the one Method here that can reach the precision cutoff,
		§ on a value carrying several bases. The note at the head of the file
		§ says why.

		§§ Answers the Transcendental as a Rational on a decimal grid of the given width.
		§§
		§§ Five places answer the value rounded to hundred-thousandths, so `Number.Pi` over five places answers `314159/100000`. This Method is where a Program asks for digits in place of the exact value. The answer is exact all the same: it is the step of that grid the value rounds to. A width of no places answers a whole number, as a Rational.
		§§
		§§ A value over a single base is always answered for. A value carrying both π and e can not be shown to miss every step of the grid. Deciding that would settle an open problem. A call on such a value refines to the cutoff `Number::compare` names, and stops the Program there.
		§§
		§§ @param toPlaces — how many decimal places the grid keeps
		§§ @param toward — the direction to round in, `#Nearest` when it is left out
		§§ @returns — the value on the grid the width names.
		approximate(
			toPlaces places: NonNegativeInteger,
			toward direction: Rounding = #Nearest,
		) -> Rational

		§§ Answers the Transcendental rounded in the named direction.
		§§
		§§ The direction is `#Nearest` when a call names none. An irrational is never exactly halfway between two steps, so `#Nearest` and `#NearestEven` answer alike here. The other directions answer the floor for `#Down`, the ceiling for `#Up`, and the step towards zero for `#TowardZero`. Naming a count of places rounds to a decimal grid of that width instead, and answers a Rational.
		overload round {
			§§ Answers the Transcendental as an Integer, rounded in the named direction.
			§§
			§§ @param toward — the direction to round in, `#Nearest` when it is left out
			§§ @returns — the rounded Integer.
			(toward direction: Rounding = #Nearest) -> Integer

			§§ Answers the Transcendental rounded to a decimal grid of the given width.
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
	Transcendental
}
