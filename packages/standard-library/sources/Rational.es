import {
	Algebraic      from "./Algebraic.es"
	Boolean        from "./Boolean.es"
	Comparable     from "./Comparable.es"
	Integer        from "./Integer.es"
	NonZeroInteger from "./Integer.es"
	List           from "./List.es"
	Optional       from "./Optional.es"
	Ordering       from "./Ordering.es"
	Equatable      from "./Protocols.es"
	Printable      from "./Protocols.es"
	String         from "./String.es"
	Transcendental from "./Transcendental.es"
}

declarations {

	§ The forms `Rational::toString` writes: `Fraction` is `"3/4"` and
	§ `Decimal` is `"0.75"`. The Choice is declared beside its only user.
	choice NumberFormat {
		Fraction,
		Decimal,
	}

	§ `Equatable` is derived for a Choice; see DEVELOPMENT.md, Why bodies look
	§ the way they do.
	namespace NumberFormat for NumberFormat is Equatable, is Printable {
		§§ Represents the NumberFormat as `Fraction` or `Decimal`.
		§§
		§§ @returns — the name of the NumberFormat's Case.
		toString() -> String {
			<- match @ -> String {
				case #Fraction { <- "Fraction" }
				case #Decimal  { <- "Decimal" }
			}
		}
	}

	§ Which Integer `round` reaches for a Rational that is not whole. The
	§ Choice is declared beside its only user, and `#Nearest` is the default.
	choice Rounding {
		Nearest,
		Down,
		Up,
		TowardZero,
	}

	namespace Rounding for Rounding is Equatable, is Printable {
		§§ Represents the Rounding as `Nearest`, `Down`, `Up` or `TowardZero`.
		§§
		§§ @returns — the name of the Rounding's Case.
		toString() -> String {
			<- match @ -> String {
				case #Nearest    { <- "Nearest" }
				case #Down       { <- "Down" }
				case #Up         { <- "Up" }
				case #TowardZero { <- "TowardZero" }
			}
		}
	}

	§ Exact ratios of Integers, kept in lowest terms with the sign on the
	§ numerator. The literal form is `3/4`, and `Rational.of` builds one from
	§ two computed Integers. Arithmetic never rounds: an operation that leaves
	§ the Rationals widens into the Type that states the answer exactly.
	namespace Rational for Rational is Equatable, is Printable, is Comparable {
		§ The one gateway a Rational is built through. Overload entries are read
		§ refined-first, so a call that can prove its denominator reaches the
		§ total entry. See DEVELOPMENT.md, Why bodies look the way they do.

		§§ Builds a Rational from one Integer over another.
		§§
		§§ This is the way to write a ratio of computed values, where the literal form `3/4` is not available.
		overload static of {
			§§ Builds the Rational from two Integers, with nothing known about either.
			§§
			§§ @param _ — the numerator
			§§ @param over — the denominator
			§§ @returns — the Rational, or nothing when the denominator is zero.
			(
				_ numerator: Integer,
				over denominator: Integer,
			) -> Optional<Rational>

			§§ Builds the Rational over a denominator proven not to be zero.
			§§
			§§ There is no failure to report, so the Rational itself is the answer.
			§§
			§§ @param _ — the numerator
			§§ @param over — the denominator, proven not to be zero
			§§ @returns — the Rational.
			(_ numerator: Integer, over denominator: NonZeroInteger) -> Rational

			§§ Builds the Rational from two Integers, with a value to answer when the denominator is zero.
			§§
			§§ @param _ — the numerator
			§§ @param over — the denominator
			§§ @param defaultingTo — the value to answer with when there is no Rational
			§§ @returns — the Rational, or the given value in its place.
			(
				_ numerator: Integer,
				over denominator: Integer,
				defaultingTo fallback: Rational,
			) -> Rational {
				<- Rational.of(numerator, over denominator)::value(
					defaultingTo fallback,
				)
			}
		}

		§§ Checks whether the Rational has the same value as another Rational.
		§§
		§§ The comparison is in lowest terms, so `1/2` equals `2/4`.
		§§
		§§ @param _ — the Rational to compare against
		§§ @returns — `true` when both are equal.
		is(_ other: Rational) -> Boolean {
			<- @::compare(to other)::is(#Equal)
		}

		§§ Checks whether the Rational has a different value than another.
		§§
		§§ @param _ — the Rational to compare against
		§§ @returns — `true` when the two differ.
		isNot(_ other: Rational) -> Boolean {
			<- @::is(other)::negate()
		}

		§ The Integer entries are written on the accessors and `Rational.of`, so
		§ every answer passes through the one gateway. The irrational entries
		§ call the other operand, because addition and multiplication commute.

		§ The four same-kind entries are native. An Essence body would read both
		§ parts of both operands and hand them to `Rational.of`, whose answer is
		§ not reduced. The runtime's bigint core does each one as one
		§ cross-multiplication and one reduction.

		§§ Adds a number to the Rational, and stays exact for every member of the numeric tower.
		overload add {
			§§ @param _ — the Rational to add
			§§ @returns — the sum.
			(_ other: Rational) -> Rational

			(_ other: Integer) -> Rational {
				<- Rational.of(
					@::numerator()::add(other::multiply(with @::denominator())),
					over @::denominator(),
				)
			}

			(_ other: Algebraic) -> Algebraic {
				<- other::add(@)
			}

			(_ other: Transcendental) -> Transcendental {
				<- other::add(@)
			}
		}

		§§ Subtracts a number from the Rational, and stays exact for every member of the numeric tower.
		overload subtract {
			§§ @param _ — the Rational to subtract
			§§ @returns — the difference.
			(_ other: Rational) -> Rational

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

		§§ Divides the Rational by a number, exactly.
		§§
		§§ Dividing by an Integer or a Rational answers empty for a zero divisor. With `defaultingTo`, the given value stands in place of empty. Dividing by an Algebraic always answers, because an Algebraic is irrational and so never zero. Dividing by an Integer proven not to be zero always answers too.
		overload divide {
			§§ @param by — the Rational to divide by
			§§ @returns — the quotient, or nothing when the divisor is zero.
			(by other: Rational) -> Optional<Rational>

			(by other: Integer) -> Optional<Rational> {
				§ A zero divisor widens to `0/1`, which the entry above
				§ refuses. A written literal is its own refinement proof;
				§ see DEVELOPMENT.md, Why bodies look the way they do.
				<- @::divide(by Rational.of(other, over 1))
			}

			(by other: Algebraic) -> Algebraic | Rational

			§§ Divides by a Rational, and answers the given value when the divisor is zero.
			§§
			§§ @param by — the divisor
			§§ @param defaultingTo — the value to answer with when there is no quotient
			§§ @returns — the quotient, or the given value in its place.
			(by other: Rational, defaultingTo fallback: Rational) -> Rational {
				<- @::divide(by other)::value(defaultingTo fallback)
			}

			§§ Divides by an Integer, and answers the given value when the divisor is zero.
			§§
			§§ @param by — the divisor
			§§ @param defaultingTo — the value to answer with when there is no quotient
			§§ @returns — the quotient, or the given value in its place.
			(by other: Integer, defaultingTo fallback: Rational) -> Rational {
				<- @::divide(by other)::value(defaultingTo fallback)
			}

			§§ Divides by an Integer proven not to be zero.
			§§
			§§ There is no failure to report, so the quotient itself is the answer.
			§§
			§§ @param by — the divisor, proven not to be zero
			§§ @returns — the quotient.
			(by other: NonZeroInteger) -> Rational {
				§ Dividing by a whole number scales the denominator, which
				§ stays proven: the product of two NonZeroIntegers is one.
				<- Rational.of(
					@::numerator(),
					over @::denominator()::multiply(with other),
				)
			}
		}

		§§ Multiplies the Rational with a number, and stays exact for every member of the numeric tower.
		overload multiply {
			§§ @param with — the Rational to multiply with
			§§ @returns — the product.
			(with other: Rational) -> Rational

			(with other: Integer) -> Rational {
				<- Rational.of(
					@::numerator()::multiply(with other),
					over @::denominator(),
				)
			}

			(with other: Algebraic) -> Algebraic | Rational {
				<- other::multiply(with @)
			}

			(with other: Transcendental) -> Transcendental | Rational {
				<- other::multiply(with @)
			}
		}

		§ The same-kind entry is written on Rational's own `compare`, so
		§ comparing two Rationals does not reach the cross-kind table in
		§ `Number`. A body pulls its transitive reach into every bundle; see
		§ DEVELOPMENT.md, Why bodies look the way they do. The Integer entries
		§ scale by the denominator, which is positive and keeps the order.

		§§ Checks whether the Rational is strictly below the given number.
		overload isLessThan {
			(_ other: Rational) -> Boolean {
				<- @::compare(to other)::is(#Less)
			}

			(_ other: Integer) -> Boolean {
				<- @::numerator()
					::isLessThan(other::multiply(with @::denominator()))
			}
		}

		§§ Checks whether the Rational is below the given number, or equal to it.
		overload isLessThanOrEqualTo {
			(_ other: Rational) -> Boolean {
				<- @::isGreaterThan(other)::negate()
			}

			(_ other: Integer) -> Boolean {
				<- @::isGreaterThan(other)::negate()
			}
		}

		§§ Checks whether the Rational is strictly above the given number.
		overload isGreaterThan {
			(_ other: Rational) -> Boolean {
				<- @::compare(to other)::is(#Greater)
			}

			(_ other: Integer) -> Boolean {
				<- @::numerator()
					::isGreaterThan(other::multiply(with @::denominator()))
			}
		}

		§§ Checks whether the Rational is above the given number, or equal to it.
		overload isGreaterThanOrEqualTo {
			(_ other: Rational) -> Boolean {
				<- @::isLessThan(other)::negate()
			}

			(_ other: Integer) -> Boolean {
				<- @::isLessThan(other)::negate()
			}
		}

		§§ Answers the exact square root of the Rational.
		§§
		§§ A perfect square answers a Rational. Any other value that is not negative answers an exact Algebraic. A negative Rational answers empty.
		overload squareRoot {
			§§ @returns — the root, or nothing for a negative Rational.
			() -> Optional<Rational | Algebraic>

			§§ Answers the exact square root, with a value to answer for a negative Rational.
			§§
			§§ @param defaultingTo — the value to answer with when there is no root
			§§ @returns — the root, or the given value in its place.
			(
				defaultingTo fallback: Rational | Algebraic,
			) -> Rational | Algebraic {
				<- @::squareRoot()::value(defaultingTo fallback)
			}
		}

		§§ Answers the numerator of the Rational in lowest terms.
		§§
		§§ The numerator carries the sign, because the denominator is always positive.
		numerator() -> Integer

		§§ Answers the denominator of the Rational in lowest terms.
		§§
		§§ The denominator is always positive, and never zero.
		denominator() -> NonZeroInteger

		§§ Answers the Rational without its sign, which is its distance from zero.
		absolute() -> Rational {
			if @::isLessThan(0/1) {
				<- @::negate()
			} else {
				<- @
			}
		}

		§§ Answers the Rational with its sign flipped.
		negate() -> Rational {
			<- Rational.of(@::numerator()::negate(), over @::denominator())
		}

		§§ Answers the reciprocal of the Rational.
		§§
		§§ The reciprocal exchanges the numerator and the denominator. Zero has no reciprocal.
		overload reciprocal {
			§§ @returns — the reciprocal, or nothing for zero.
			() -> Optional<Rational> {
				<- Rational.of(@::denominator(), over @::numerator())
			}

			§§ Answers the reciprocal, with a value to answer for zero.
			§§
			§§ @param defaultingTo — the value to answer with when there is no reciprocal
			§§ @returns — the reciprocal, or the given value in its place.
			(defaultingTo fallback: Rational) -> Rational {
				<- @::reciprocal()::value(defaultingTo fallback)
			}
		}

		§§ Checks whether the Rational is a whole number.
		§§
		§§ A whole number has the denominator one in lowest terms.
		isWholeNumber() -> Boolean {
			<- @::denominator()::is(1)
		}

		§§ Answers the Rational as an Integer, rounded in the named direction.
		§§
		§§ The direction is `#Nearest` when a call names none. A value exactly halfway between two Integers rounds away from zero, so `1/2` answers `1` and `-1/2` answers `-1`. The other directions answer the floor for `#Down`, the ceiling for `#Up`, and the Integer part for `#TowardZero`.
		§§
		§§ @param toward — the direction to round in, `#Nearest` when it is left out
		§§ @returns — the rounded Integer.
		round(toward direction: Rounding = #Nearest) -> Integer {
			§ The denominator is positive in lowest terms, so the Euclidean
			§ quotient is the floor, and every branch below is written on it.
			§ A NonZeroInteger divisor makes `quotient` total.
			constant floored = @::numerator()
				::quotient(dividingBy @::denominator())

			constant isWhole = @::isWholeNumber()

			§ `@` is rebound inside `match`; see DEVELOPMENT.md, Why bodies
			§ look the way they do.
			constant value = @

			<- match direction -> Integer {
				case #Down { <- floored }

				case #Up {
					§ A whole Rational is its own ceiling.
					if isWhole {
						<- floored
					} else {
						<- floored::add(1)
					}
				}

				case #TowardZero {
					§ Cutting the fractional part off is the floor, except
					§ for a negative value that is not whole, which takes
					§ one step back towards zero.
					if value::isLessThan(0/1)::and(isWhole::negate()) {
						<- floored::add(1)
					} else {
						<- floored
					}
				}

				case #Nearest {
					§ Above a half the Integer above is nearer, and below
					§ a half the floor is. A tie breaks away from zero,
					§ which for a negative value is the floor.
					constant fractionalPart = value::subtract(floored)

					if fractionalPart::isGreaterThan(1/2) {
						<- floored::add(1)
					} else if fractionalPart::isLessThan(1/2) {
						<- floored
					} else if value::isLessThan(0/1) {
						<- floored
					} else {
						<- floored::add(1)
					}
				}
			}
		}

		§§ Raises the Rational to the given power.
		§§
		§§ A negative exponent answers the exact reciprocal power. Zero raised to the power of zero is one.
		overload raise {
			§§ @param to — the exponent
			§§ @returns — the power, or nothing when raising zero to a negative power.
			(to exponent: Integer) -> Optional<Rational>

			§§ Raises the Rational to the given power, and answers the given value when there is no power.
			§§
			§§ @param to — the exponent
			§§ @param defaultingTo — the value to answer with when there is no power
			§§ @returns — the power, or the given value in its place.
			(
				to exponent: Integer,
				defaultingTo fallback: Rational,
			) -> Rational {
				<- @::raise(to exponent)::value(defaultingTo fallback)
			}
		}

		§§ Reads a Rational from its text form.
		§§
		§§ The text is a fraction like `3/4`, a decimal like `0.75`, or a whole number like `3`. Each form takes an optional minus sign in front.
		overload static parse {
			§§ @param _ — the text to read
			§§ @returns — the Rational, or nothing when the text has any other shape or divides by zero.
			(_ text: String) -> Optional<Rational> {
				§ The sign is the position of a leading `-`. The `keep` step
				§ drops a `-` standing anywhere else, so what is left has a
				§ value only for a negative text.
				constant sign = text::firstIndex(of "-")
					::keep(where (position) { <- position::is(0) })

				constant unsignedText = match sign -> String {
					case #Value { <- text::slice(from 1) }

					case #Empty { <- text }
				}

				§ A `-` stands only at the front. The pieces below are plain
				§ digit runs, so `1/-2` and `--1/2` are refused here.
				if unsignedText::contains("-") {
					<- #Empty
				} else {
					§ The pieces below are unsigned, so the sign returns as
					§ a factor on the numerator.
					constant signFactor = match sign -> Integer {
						case #Value { <- -1 }

						case #Empty { <- 1 }
					}

					constant fractionPieces = unsignedText::split(on "/")

					if fractionPieces::length()::is(2) {
						§ One slash means a numerator over a denominator, and
						§ `andThen` carries the three answers that can refuse.
						<- Integer.parse(
							fractionPieces::firstItem(defaultingTo ""),
						)::andThen((parsedNumerator) {
							<- Integer.parse(
								fractionPieces::lastItem(defaultingTo ""),
							)::andThen((parsedDenominator) {
								<- Rational.of(
									parsedNumerator::multiply(with signFactor),
									over parsedDenominator,
								)
							})
						})
					} else if fractionPieces::length()::isNot(1) {
						<- #Empty
					} else {
						constant decimalPieces = unsignedText::split(on ".")

						if decimalPieces::length()::is(2) {
							§ One dot means the digits on both sides over
							§ a power of ten.
							constant wholeText      = decimalPieces::firstItem(
								defaultingTo "",
							)
							constant fractionalText = decimalPieces::lastItem(
								defaultingTo "",
							)

							if wholeText
								::isEmpty()
								::or(fractionalText::isEmpty())
							{
								<- #Empty
							} else {
								<- Integer.parse(
									wholeText::append(fractionalText),
								)::andThen((digitsValue) {
									constant scale = fractionalText
										::characters()
										::reduce(startingWith 1, (scaled, _) {
											<- scaled::multiply(with 10)
										})

									<- Rational.of(
										digitsValue::multiply(with signFactor),
										over scale,
									)
								})
							}
						} else if decimalPieces::length()::isNot(1) {
							<- #Empty
						} else {
							§ No slash and no dot means a whole number.
							<- Integer.parse(unsignedText)::map((parsedWhole) {
								<- Rational.of(
									parsedWhole::multiply(with signFactor),
									over 1,
								)
							})
						}
					}
				}
			}

			§§ Reads a Rational from its text form, with a value to answer when the text has another shape.
			§§
			§§ @param _ — the text to read
			§§ @param defaultingTo — the value to answer with when the text is no Rational
			§§ @returns — the Rational, or the given value in its place.
			(_ text: String, defaultingTo fallback: Rational) -> Rational {
				<- Rational.parse(text)::value(defaultingTo fallback)
			}
		}

		§§ Represents the Rational as a String, in lowest terms.
		§§
		§§ The form is `3/4` when no format is named, and the named format otherwise. A whole Rational prints its numerator alone, so `1/2::add(1/2)` prints `1` and `10::divide(by 2)` prints `5`. The `Rational.parse` Method reads every one of these forms back.
		§§
		§§ @returns — the String representation of the Rational.
		overload toString {
			() -> String {
				§ This entry builds the fraction form from the accessors rather
				§ than calling `as #Fraction`. The entries of an Overload are
				§ separate emitted Functions, so delegating would pull the decimal
				§ formatter into every Program that prints a Rational. The
				§ whole-number rule is repeated wherever a Rational is rendered
				§ for a reader: `Rational.ts`, the Optimiser's folded
				§ interpolation hole and the client package.
				if @::isWholeNumber() {
					<- @::numerator()::toString()
				} else {
					<- @::numerator()
						::toString()
						::append("/")
						::append(@::denominator()::toString())
				}
			}

			§§ @param as — the form to represent the Rational in
			(as format: NumberFormat) -> String
		}

		§§ Orders the Rational against another Rational.
		§§
		§§ @param to — the Rational to order against
		§§ @returns — `Ordering#Less`, `Ordering#Equal` or `Ordering#Greater`.
		compare(to other: Rational) -> Ordering
	}
}

export {
	NumberFormat
	Rational
	Rounding
}
