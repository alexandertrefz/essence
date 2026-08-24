import {
	Algebraic          from "./Algebraic.es"
	Boolean            from "./Boolean.es"
	Integer            from "./Integer.es"
	NonNegativeInteger from "./Integer.es"
	NonZeroInteger     from "./Integer.es"
	List               from "./List.es"
	NonEmptyList       from "./List.es"
	Optional           from "./Optional.es"
	Orderable          from "./Orderable.es"
	Ordering           from "./Ordering.es"
	Equatable          from "./Protocols.es"
	Printable          from "./Protocols.es"
	String             from "./String.es"
	Transcendental     from "./Transcendental.es"
}

declarations {

	§ The forms `Rational::toString` writes: `Fraction` is `"3/4"` and
	§ `Decimal` is `"0.75"`. The Choice is declared beside its only user.
	choice NumberFormat {
		Fraction,
		Decimal,
	}

	§ `Equatable` and `Printable` are both derived for a Choice of Cases that
	§ carry no payload. This Namespace declares the two and writes neither; see
	§ DEVELOPMENT.md, Why bodies look the way they do.
	namespace NumberFormat for NumberFormat is Equatable, is Printable {}

	§ Which step `round` reaches for a value that is not already on one. The
	§ Choice is declared beside the Namespace that rounds most, and `#Nearest`
	§ is the default. `Integer.es` imports it for its own `round`.
	choice Rounding {
		Nearest,
		Down,
		Up,
		TowardZero,
	}

	namespace Rounding for Rounding is Equatable, is Printable {}

	§ The Rationals that are not zero, as a checked refinement, and the sister
	§ of `NonZeroInteger`. The bound is written `0/1`, which is the house
	§ spelling for a Rational zero. A bare `0` asks the same question: the
	§ Compiler reads every Integer bound on a Rational as `n/1`, so both
	§ spellings reach this Type.
	type NonZeroRational = Rational where @::isNot(0/1)

	§ Exact ratios of Integers, kept in lowest terms with the sign on the
	§ numerator. The literal form is `3/4`, and `Rational.of` builds one from
	§ two computed Integers. Arithmetic never rounds: an operation that leaves
	§ the Rationals widens into the Type that states the answer exactly.
	namespace Rational for Rational is Equatable, is Printable, is Orderable {
		§ The one gateway a Rational is built through. Overload entries are read
		§ refined-first, so a call that can prove its denominator reaches the
		§ total entry. See DEVELOPMENT.md, Why bodies look the way they do.

		§§ Builds a Rational from one Integer over another.
		§§
		§§ This is the way to write a ratio of computed values, where the literal form `3/4` is not available. A zero denominator answers empty, and the `defaultingTo:` entry answers the given Rational instead.
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

		§§ Reads a Rational from its text form.
		§§
		§§ The text is a fraction like `3/4`, a decimal like `0.75`, or a whole number like `3`. Each form takes an optional minus sign in front. Text of another shape, or a fraction over zero, answers empty, and the `defaultingTo:` entry answers the given Rational instead.
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
						constant numeratorText   = fractionPieces::firstItem()
						constant denominatorText = fractionPieces::lastItem()

						<- Integer.parse(numeratorText)::andThen((numerator) {
							<- Integer.parse(denominatorText)::andThen(
								(denominator) {
									<- Rational.of(
										numerator::multiply(with signFactor),
										over denominator,
									)
								},
							)
						})
					} else if fractionPieces::length()::isNot(1) {
						<- #Empty
					} else {
						constant decimalPieces = unsignedText::split(on ".")

						if decimalPieces::length()::is(2) {
							§ One dot means the digits on both sides over
							§ a power of ten.
							constant wholeText      = decimalPieces::firstItem()
							constant fractionalText = decimalPieces::lastItem()

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

		§ The Integer entries carry equality where the four inequalities
		§ already carry order. Without them `rate::is(2)` falls to the covering
		§ `Number`'s sixteen-cell table and pulls the whole tower in. A Program
		§ that asks it alone measured 20.1 kB, against 6.2 kB with these
		§ entries and 6.5 kB for `rate::isLessThan(2)`. The Rational entry
		§ stands first, because it is the `Equatable` witness; see
		§ DEVELOPMENT.md, Why bodies look the way they do.

		§§ Answers whether the Rational has the same value as a number.
		§§
		§§ The comparison is in lowest terms, so `1/2` equals `2/4`. A Rational equals an Integer when it is whole and its numerator is that Integer.
		overload is {
			§§ @param _ — the Rational to compare against
			§§ @returns — `true` when both are equal.
			(_ other: Rational) -> Boolean {
				<- @::compare(to other)::is(#Equal)
			}

			§§ @param _ — the Integer to compare against
			§§ @returns — `true` when the Rational is whole and its numerator is that Integer.
			(_ other: Integer) -> Boolean {
				<- @::isWholeNumber()::and(@::numerator()::is(other))
			}
		}

		§ `Equatable` provides an `isNot` over `Self` alone, and a written
		§ Method replaces a provided one whole. So the Integer entry above
		§ needs its contrary written here, as `Optional`'s does and for the
		§ same reason.

		§§ Answers whether the Rational differs from a number.
		§§
		§§ A Rational that is not whole differs from every Integer.
		overload isNot {
			§§ @param _ — the Rational to compare against
			§§ @returns — `true` when the two differ.
			(_ other: Rational) -> Boolean {
				<- @::is(other)::negate()
			}

			§§ @param _ — the Integer to compare against
			§§ @returns — `true` when the two differ.
			(_ other: Integer) -> Boolean {
				<- @::is(other)::negate()
			}
		}

		§§ Orders the Rational against another Rational.
		§§
		§§ @param to — the Rational to order against
		§§ @returns — `Ordering#Less`, `Ordering#Equal` or `Ordering#Greater`.
		compare(to other: Rational) -> Ordering

		§§ Answers the Rational as a String, in lowest terms.
		§§
		§§ The form is `3/4` when no format is named, and the named format otherwise. A whole Rational prints its numerator alone, so `1/2::add(1/2)` prints `1` and `10::divide(by 2)` prints `5`. The `Rational.parse` Method reads every one of these forms. The fraction form reads back as the same Rational. A decimal form does too when its expansion ends within 80 digits, and reads back as the rounded value otherwise. A count of one or more places writes exactly that many digits after the point.
		§§
		§§ @returns — the String representation of the Rational.
		overload toString {
			§§ Answers the Rational as a fraction, in lowest terms.
			§§
			§§ The form is `3/4`. A whole Rational prints its numerator alone, so `1/2::add(1/2)` prints `1`.
			§§
			§§ @returns — the String representation of the Rational.
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

			§ Native beside the entry above, and written on the same long
			§ division. An Essence body would have to pad and cut the text
			§ that entry answers, which is reading a number back out of its
			§ own rendering.

			§§ Answers the Rational as a decimal with exactly that many places.
			§§
			§§ The digits are padded with zeroes where the expansion is shorter, so `1/2` over two places is `0.50`. The last digit kept is rounded to the nearest, with halves away from zero, so `1/8` is `0.13`. A count below one rounds to a whole number, and no point is written. The `#Fraction` format ignores the count.
			§§
			§§ @param as — the form to represent the Rational in
			§§ @param places — how many digits to write after the point
			(as format: NumberFormat, places count: Integer) -> String
		}

		§ The Integer entries are written on the accessors and `Rational.of`, so
		§ every answer passes through the one gateway. The irrational entries
		§ call the other operand, because addition and multiplication commute.

		§ The four same-kind entries are native. An Essence body would read both
		§ parts of both operands and hand them to `Rational.of`, whose answer is
		§ not reduced. The runtime's bigint core does each one as one
		§ cross-multiplication and one reduction. The refined quotient below is
		§ native beside them, and is that same division with the zero test taken
		§ out.

		§§ Adds a number to the Rational, and stays exact for every member of the numeric tower.
		overload add {
			§§ @param _ — the Rational to add
			§§ @returns — the sum.
			(_ other: Rational) -> Rational

			§§ Adds an Integer to the Rational.
			§§
			§§ The sum is a Rational, since a whole number added to a fraction need not be whole.
			§§
			§§ @param _ — the Integer to add
			§§ @returns — the sum, as a Rational.
			(_ other: Integer) -> Rational {
				<- Rational.of(
					@::numerator()::add(other::multiply(with @::denominator())),
					over @::denominator(),
				)
			}

			§§ Adds an Algebraic to the Rational.
			§§
			§§ The sum is an Algebraic, since adding a Rational leaves the radical part in place.
			§§
			§§ @param _ — the Algebraic to add
			§§ @returns — the sum, as an Algebraic.
			(_ other: Algebraic) -> Algebraic {
				<- other::add(@)
			}

			§§ Adds a Transcendental to the Rational.
			§§
			§§ The sum is a Transcendental, since adding a Rational leaves every base term in place.
			§§
			§§ @param _ — the Transcendental to add
			§§ @returns — the sum, as a Transcendental.
			(_ other: Transcendental) -> Transcendental {
				<- other::add(@)
			}
		}

		§§ Subtracts a number from the Rational, and stays exact for every member of the numeric tower.
		overload subtract {
			§§ @param _ — the Rational to subtract
			§§ @returns — the difference.
			(_ other: Rational) -> Rational

			§§ Subtracts an Integer from the Rational.
			§§
			§§ The difference is a Rational, since a whole number taken from a fraction need not be whole.
			§§
			§§ @param _ — the Integer to subtract
			§§ @returns — the difference, as a Rational.
			(_ other: Integer) -> Rational {
				<- @::add(other::negate())
			}

			§§ Subtracts an Algebraic from the Rational.
			§§
			§§ The difference is an Algebraic, since the radical part stays and only its sign flips.
			§§
			§§ @param _ — the Algebraic to subtract
			§§ @returns — the difference, as an Algebraic.
			(_ other: Algebraic) -> Algebraic {
				<- @::add(other::negate())
			}

			§§ Subtracts a Transcendental from the Rational.
			§§
			§§ The difference is a Transcendental, since every base term stays with its sign flipped.
			§§
			§§ @param _ — the Transcendental to subtract
			§§ @returns — the difference, as a Transcendental.
			(_ other: Transcendental) -> Transcendental {
				<- @::add(other::negate())
			}
		}

		§§ Multiplies the Rational with a number, and stays exact for every member of the numeric tower.
		overload multiply {
			§§ @param with — the Rational to multiply with
			§§ @returns — the product.
			(with other: Rational) -> Rational

			§§ Multiplies the Rational with an Integer.
			§§
			§§ The product is a Rational, since scaling a fraction by a whole number need not leave a whole number.
			§§
			§§ @param with — the Integer to multiply with
			§§ @returns — the product, as a Rational.
			(with other: Integer) -> Rational {
				<- Rational.of(
					@::numerator()::multiply(with other),
					over @::denominator(),
				)
			}

			§§ Multiplies the Rational with an Algebraic.
			§§
			§§ The product is an Algebraic, since scaling keeps the radical part. A zero receiver answers zero, which is a Rational.
			§§
			§§ @param with — the Algebraic to multiply with
			§§ @returns — the product, as an Algebraic or a Rational.
			(with other: Algebraic) -> Algebraic | Rational {
				<- other::multiply(with @)
			}

			§§ Multiplies the Rational with a Transcendental.
			§§
			§§ The product is a Transcendental, since scaling keeps every base term. A zero receiver answers zero, which is a Rational.
			§§
			§§ @param with — the Transcendental to multiply with
			§§ @returns — the product, as a Transcendental or a Rational.
			(with other: Transcendental) -> Transcendental | Rational {
				<- other::multiply(with @)
			}
		}

		§§ Divides the Rational by a number, exactly.
		§§
		§§ Dividing by an Integer or a Rational answers empty for a zero divisor. With `defaultingTo`, the given value stands in place of empty. Dividing by an Algebraic always answers, because an Algebraic is irrational and so never zero. Dividing by an Integer proven not to be zero always answers too. A Rational proven not to be zero answers as well.
		overload divide {
			§§ @param by — the Rational to divide by
			§§ @returns — the quotient, or nothing when the divisor is zero.
			(by other: Rational) -> Optional<Rational>

			§§ Divides the Rational by an Integer.
			§§
			§§ The quotient is a Rational. A zero divisor answers empty, and the `defaultingTo:` entry answers the given Rational instead.
			§§
			§§ @param by — the Integer to divide by
			§§ @returns — the quotient, or nothing when the divisor is zero.
			(by other: Integer) -> Optional<Rational> {
				§ A zero divisor widens to `0/1`, which the entry above
				§ refuses. A written literal is its own refinement proof;
				§ see DEVELOPMENT.md, Why bodies look the way they do.
				<- @::divide(by Rational.of(other, over 1))
			}

			§§ Divides the Rational by an Algebraic.
			§§
			§§ An Algebraic is irrational and so never zero, which is why the quotient itself is the answer. The quotient is an Algebraic, and a zero receiver answers zero, which is a Rational.
			§§
			§§ @param by — the Algebraic to divide by
			§§ @returns — the quotient, as an Algebraic or a Rational.
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

			§§ Divides by a Rational proven not to be zero.
			§§
			§§ There is no failure to report, so the quotient itself is the answer.
			§§
			§§ @param by — the divisor, proven not to be zero
			§§ @returns — the quotient.
			(by other: NonZeroRational) -> Rational
		}

		§§ Raises the Rational to the given power.
		§§
		§§ A negative exponent answers the exact reciprocal power. Zero raised to the power of zero is one. Raising this Rational to an exponent proven not to be negative can not fail. Zero raised to a negative power answers empty, and the `defaultingTo:` entry answers the given Rational instead.
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

			§§ Raises the Rational to an exponent proven not to be negative.
			§§
			§§ Every Rational has such a power, the reciprocal is never taken, and no denominator can reach zero. So the answer is the power itself rather than an Optional.
			§§
			§§ @param to — the exponent, proven not to be negative
			§§ @returns — the power.
			(to exponent: NonNegativeInteger) -> Rational
		}

		§§ Answers the exact square root of the Rational.
		§§
		§§ A perfect square answers a Rational. Any other value that is not negative answers an exact Algebraic. A negative Rational answers empty, and the `defaultingTo:` entry answers the given value instead.
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

		§ These four override `Orderable`'s provided Methods of the same
		§ names, for the reason Integer's do. The same-kind entry is written
		§ on Rational's own `compare`, so comparing two Rationals does not
		§ reach the cross-kind table in `Number`. A body pulls its transitive
		§ reach into every bundle; see DEVELOPMENT.md, Why bodies look the way
		§ they do. The Integer entries answer here what the covering `Number`'s
		§ rung would otherwise be reached for. Each scales by the denominator,
		§ which is positive and keeps the order.
		§
		§ An override is in the conformance witness, so a bounded
		§ `<Item is Orderable>` runs these entries where
		§ `1/2::isLessThan(2/3)` runs them. Both read `compare` either way.
		§
		§ These bodies are read as well as run. Each `…OrEqualTo` entry is one
		§ call on `@` negated, over the bound it was handed, so it is the
		§ comparison it negates. A Rational receiver reads every bare Integer
		§ bound as `n/1`, so one question has one key however it is written.
		§ See DEVELOPMENT.md, Why bodies look the way they do.

		§§ Answers whether the Rational is strictly below the given number.
		overload isLessThan {
			§§ Answers whether the Rational is strictly below another Rational.
			§§
			§§ The comparison is in lowest terms, so `1/2` is not below `2/4`.
			§§
			§§ @param _ — the Rational to compare against
			§§ @returns — `true` when the receiver is below the other Rational.
			(_ other: Rational) -> Boolean {
				<- @::compare(to other)::is(#Less)
			}

			§§ Answers whether the Rational is strictly below an Integer.
			§§
			§§ The Integer is read as `n/1`, so `1/2` is below `1`.
			§§
			§§ @param _ — the Integer to compare against
			§§ @returns — `true` when the Rational is below the Integer.
			(_ other: Integer) -> Boolean {
				<- @::numerator()
					::isLessThan(other::multiply(with @::denominator()))
			}
		}

		§§ Answers whether the Rational is below the given number, or equal to it.
		overload isLessThanOrEqualTo {
			§§ Answers whether the Rational is below another Rational, or equal to it.
			§§
			§§ Equal Rationals answer `true`.
			§§ The comparison is in lowest terms, so `1/2` answers `true` against `2/4`.
			§§
			§§ @param _ — the Rational to compare against
			§§ @returns — `true` when the receiver is below the other Rational or equal to it.
			(_ other: Rational) -> Boolean {
				<- @::isGreaterThan(other)::negate()
			}

			§§ Answers whether the Rational is below an Integer, or equal to it.
			§§
			§§ The Integer is read as `n/1`, so `2/2` answers `true` against `1`.
			§§
			§§ @param _ — the Integer to compare against
			§§ @returns — `true` when the Rational is below the Integer or equal to it.
			(_ other: Integer) -> Boolean {
				<- @::isGreaterThan(other)::negate()
			}
		}

		§§ Answers whether the Rational is strictly above the given number.
		overload isGreaterThan {
			§§ Answers whether the Rational is strictly above another Rational.
			§§
			§§ The comparison is in lowest terms, so `2/4` is not above `1/2`.
			§§
			§§ @param _ — the Rational to compare against
			§§ @returns — `true` when the receiver is above the other Rational.
			(_ other: Rational) -> Boolean {
				<- @::compare(to other)::is(#Greater)
			}

			§§ Answers whether the Rational is strictly above an Integer.
			§§
			§§ The Integer is read as `n/1`, so `3/2` is above `1`.
			§§
			§§ @param _ — the Integer to compare against
			§§ @returns — `true` when the Rational is above the Integer.
			(_ other: Integer) -> Boolean {
				<- @::numerator()
					::isGreaterThan(other::multiply(with @::denominator()))
			}
		}

		§§ Answers whether the Rational is above the given number, or equal to it.
		overload isGreaterThanOrEqualTo {
			§§ Answers whether the Rational is above another Rational, or equal to it.
			§§
			§§ Equal Rationals answer `true`.
			§§ The comparison is in lowest terms, so `2/4` answers `true` against `1/2`.
			§§
			§§ @param _ — the Rational to compare against
			§§ @returns — `true` when the receiver is above the other Rational or equal to it.
			(_ other: Rational) -> Boolean {
				<- @::isLessThan(other)::negate()
			}

			§§ Answers whether the Rational is above an Integer, or equal to it.
			§§
			§§ The Integer is read as `n/1`, so `2/2` answers `true` against `1`.
			§§
			§§ @param _ — the Integer to compare against
			§§ @returns — `true` when the Rational is above the Integer or equal to it.
			(_ other: Integer) -> Boolean {
				<- @::isLessThan(other)::negate()
			}
		}

		§§ Answers whether the Rational is a whole number.
		§§
		§§ A whole number has the denominator one in lowest terms.
		isWholeNumber() -> Boolean {
			<- @::denominator()::is(1)
		}

		§ The sign of a Rational is the sign of its numerator, because the
		§ denominator is always positive in lowest terms. So the two below are
		§ the Integer questions of the same names asked one level down, and
		§ neither builds a `0/1` to compare against.

		§§ Answers whether the Rational is above zero.
		§§
		§§ Zero is neither positive nor negative.
		isPositive() -> Boolean {
			<- @::numerator()::isPositive()
		}

		§§ Answers whether the Rational is below zero.
		§§
		§§ Zero is neither positive nor negative.
		isNegative() -> Boolean {
			<- @::numerator()::isNegative()
		}

		§§ Answers whether the Rational is exactly zero.
		isZero() -> Boolean {
			§ This one asks `@` rather than its numerator, and the bound is
			§ the `0/1` `NonZeroRational` is written over. A predicate
			§ written as one call on `@` is that call. So the `else` of an
			§ `if` asking this proves that refinement, exactly as Integer's
			§ `isZero` does. Reading the numerator would be a chain, and
			§ would prove nothing. See DEVELOPMENT.md, Why bodies look the
			§ way they do.
			<- @::is(0/1)
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
			if @::isNegative() {
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
		§§ The reciprocal exchanges the numerator and the denominator. Zero has no reciprocal, and the `defaultingTo:` entry answers the given Rational instead. A receiver proven not to be zero answers the reciprocal itself.
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

		§§ Answers the Rational rounded in the named direction.
		§§
		§§ The direction is `#Nearest` when a call names none. A value exactly halfway between two steps rounds away from zero, so `1/2` answers `1` and `-1/2` answers `-1`. The other directions answer the floor for `#Down`, the ceiling for `#Up`, and the value towards zero for `#TowardZero`. Naming a count of places rounds to a decimal grid of that width instead, and answers a Rational.
		overload round {
			§§ Answers the Rational as an Integer, rounded in the named direction.
			§§
			§§ @param toward — the direction to round in, `#Nearest` when it is left out
			§§ @returns — the rounded Integer.
			(toward direction: Rounding = #Nearest) -> Integer {
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

			§§ Answers the Rational rounded to a decimal grid of the given width.
			§§
			§§ Two places round to hundredths, so `5/3` answers `167/100`. The answer is exact, and it is a Rational rather than text: `toString(as #Decimal, places 2)` is what writes `1.67`. A count below one rounds to a whole number, answered as a Rational.
			§§
			§§ @param toPlaces — how many decimal places to keep
			§§ @param toward — the direction to round in, `#Nearest` when it is left out
			§§ @returns — the rounded Rational.
			(
				toPlaces places: Integer,
				toward direction: Rounding = #Nearest,
			) -> Rational {
				§ Both powers are total: a written receiver proves what
				§ `raise` asks of it, and the `if` proves the exponent is not
				§ negative. The grid step is its own exact Rational rather
				§ than a division. A divisor computed here carries no proof,
				§ so dividing would answer an Optional.
				if places::isPositive() {
					constant scale = 10::raise(to places)
					constant step  = 1/10::raise(to places)

					<- @::multiply(with scale)
						::round(toward direction)
						::multiply(with step)
				} else {
					<- Rational.of(@::round(toward direction), over 1)
				}
			}
		}
	}

	§ What a Rational proven not to be zero answers that a bare one can not,
	§ the sister of `namespace NonZeroInteger`. Both entries are native: a
	§ refinement erases before anything runs, so an entry whose promise is
	§ about the answer can not be written in Essence. Multiplying is one
	§ Function under two names and can not drift. Taking the reciprocal is
	§ written a second time, because the Essence body beside it exports
	§ nothing to import. See DEVELOPMENT.md, Native and Essence in one
	§ Namespace.
	§
	§ Multiplication closes over the proof, as it does for the Integers: a
	§ product of two Rationals that are not zero is never zero. Addition does
	§ not, as `1/2` and `-1/2` show, so nothing else here is written on it.
	namespace NonZeroRational for NonZeroRational {
		§§ Multiplies this NonZeroRational with another.
		§§
		§§ The product is never zero, so the answer is a NonZeroRational too.
		§§
		§§ @param with — the NonZeroRational to multiply with
		§§ @returns — the product, which is not zero.
		multiply(with other: NonZeroRational) -> NonZeroRational

		§§ Answers the reciprocal of this NonZeroRational.
		§§
		§§ Zero is the one Rational with no reciprocal, and the receiver is proven not to be one. So the answer is the reciprocal itself rather than an Optional. Exchanging the two parts of a value that is not zero leaves a value that is not zero, so the answer is proven as well.
		§§
		§§ @returns — the reciprocal, which is not zero.
		reciprocal() -> NonZeroRational
	}
}

export {
	NonZeroRational
	NumberFormat
	Rational
	Rounding
}
