import {
	Algebraic      from "./Algebraic.es"
	Boolean        from "./Boolean.es"
	Comparable     from "./Comparable.es"
	Integer        from "./Integer.es"
	List           from "./List.es"
	Optional       from "./Optional.es"
	Ordering       from "./Ordering.es"
	Equatable      from "./Protocols.es"
	Printable      from "./Protocols.es"
	String         from "./String.es"
	Transcendental from "./Transcendental.es"
}

declarations {

	§ The forms a Rational can be written in. `Fraction` is `"3/4"`, the
	§ lowest-terms form `toString` gives with no Argument; `Decimal` is
	§ `"0.75"`. It lives here because `Rational::toString` is its only user.
	choice NumberFormat {
		Fraction,
		Decimal,
	}

	§ The same shape as `Ordering`'s and `Side`'s Namespaces — unit Cases
	§ compared and printed by tag, with the `Equatable` conformance declared
	§ and derived rather than written.
	namespace NumberFormat for NumberFormat is Equatable, is Printable {
		§§ Represents the NumberFormat as `Fraction` or `Decimal`.
		§§
		§§ @returns — the name of the NumberFormat variant.
		toString() -> String {
			<- match @ -> String {
				case #Fraction { <- "Fraction" }
				case #Decimal  { <- "Decimal" }
			}
		}
	}

	§ Which Integer `round` reaches for a Rational that is not already whole.
	§ It lives here because `Rational::round` is its only user, and it is what
	§ keeps rounding ONE Method: `round`, `roundDown`, `roundUp` and `truncate`
	§ were four names for one idea, which is exactly the shape
	§ `trimmed`/`trimmedAtStart`/`trimmedAtEnd` had before `Side` collapsed it.
	§ `Nearest` is the direction the no-Argument entry means, so it is a Case
	§ like any other rather than a default hidden in a body.
	choice Rounding {
		Nearest,
		Down,
		Up,
		TowardZero,
	}

	§ The same unit-Case shape as `NumberFormat` above — compared and printed
	§ by tag, with the `Equatable` conformance declared and derived rather than
	§ written.
	namespace Rounding for Rounding is Equatable, is Printable {
		§§ Represents the Rounding as `Nearest`, `Down`, `Up` or `TowardZero`.
		§§
		§§ @returns — the name of the Rounding variant.
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
	§ numerator. The literal form is `3/4`; `Rational.of` builds one from two
	§ computed Integers. Arithmetic never rounds — an operation that leaves
	§ the Rationals widens into the Type that can still say the answer.
	namespace Rational for Rational is Equatable, is Printable, is Comparable {
		§§ Builds the Rational one Integer over another — the way to write a ratio of computed values, where the literal form `3/4` is not available.
		§§
		§§ @param numerator — the numerator
		§§ @param over — the denominator
		§§ @returns — the Rational, or nothing when the denominator is zero.
		static of(
			_ numerator: Integer,
			over denominator: Integer,
		) -> Optional<Rational>

		§§ Checks whether the Rational has the same value as another — compared in lowest terms, so `1/2 is 2/4` holds.
		§§
		§§ @param other — the Rational to compare against
		§§ @returns — `true` when both are equal.
		is(_ other: Rational) -> Boolean {
			<- @::compare(to other)::is(#Equal)
		}

		§§ Checks whether the Rational has a different value than another.
		§§
		§§ @param other — the Rational to compare against
		§§ @returns — `true` when the two differ.
		isNot(_ other: Rational) -> Boolean {
			<- @::is(other)::negate()
		}

		§ The arithmetic here is written on the lowest-terms accessors and
		§ `Rational.of`, so every result passes through the one gateway a
		§ Rational may be built by. `of` can only come back empty for a zero
		§ denominator, and a product of two denominators — each positive in
		§ lowest terms — never is one, so each `otherwise` below is
		§ unreachable. The irrational entries lean on commutativity: the other
		§ operand's own Namespace already declares the sum with a Rational.

		§§ Adds a number to this Rational, staying exact for every member of the numeric tower.
		overload add {
			(_ other: Rational) -> Rational {
				§ The schoolbook cross-multiplication — both numerators scaled
				§ onto the shared denominator, then added.
				<- Rational.of(
					@::numerator()
						::multiply(with other::denominator())
						::add(
							other::numerator()::multiply(with @::denominator()),
						),
					over @::denominator()::multiply(with other::denominator()),
				)::otherwise(0/1)
			}

			(_ other: Integer) -> Rational {
				<- Rational.of(
					@::numerator()::add(other::multiply(with @::denominator())),
					over @::denominator(),
				)::otherwise(0/1)
			}

			(_ other: Algebraic) -> Algebraic {
				<- other::add(@)
			}

			(_ other: Transcendental) -> Transcendental {
				<- other::add(@)
			}
		}

		§§ Subtracts a number from this Rational, staying exact for every member of the numeric tower.
		overload subtract {
			(_ other: Rational) -> Rational {
				<- @::add(other::negate())
			}

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

		§§ Divides this Rational by a number, exactly. Dividing by a possibly-zero Integer or Rational is empty for zero; dividing by an Algebraic can never fail — an irrational is never zero.
		overload divide {
			(by other: Rational) -> Optional<Rational> {
				§ Division is multiplication by the reciprocal, and `reciprocal`
				§ already comes back empty for zero — the same shape
				§ `Integer::divide(by:)` has.
				constant dividend = @

				<- other
					::reciprocal()
					::map((reciprocal) {
						<- dividend::multiply(with reciprocal)
					})
			}

			(by other: Integer) -> Optional<Rational> {
				§ A zero divisor widens to the Rational `0/1`, whose reciprocal
				§ the entry above already refuses — so the zero case needs no
				§ guard of its own.
				<- @::divide(by Rational.of(other, over 1)::otherwise(0/1))
			}

			(by other: Algebraic) -> Algebraic | Rational
		}

		§§ Multiplies this Rational with a number, staying exact for every member of the numeric tower.
		overload multiply {
			(with other: Rational) -> Rational {
				<- Rational.of(
					@::numerator()::multiply(with other::numerator()),
					over @::denominator()::multiply(with other::denominator()),
				)::otherwise(0/1)
			}

			(with other: Integer) -> Rational {
				<- Rational.of(
					@::numerator()::multiply(with other),
					over @::denominator(),
				)::otherwise(0/1)
			}

			(with other: Algebraic) -> Algebraic | Rational {
				<- other::multiply(with @)
			}

			(with other: Transcendental) -> Transcendental | Rational {
				<- other::multiply(with @)
			}
		}

		§ These four are not a copy of `Number`'s — see the note above
		§ `Integer::isLessThan`. The same-kind entry is written on Rational's
		§ OWN `compare`, a cross-multiplication, so that comparing two
		§ Rationals does not reach the sixteen-cell cross-kind table and drag
		§ the Algebraic and Transcendental machinery in behind it. The
		§ Integer entries cross-multiply the same way, in Integer arithmetic:
		§ the denominator is positive in lowest terms, so scaling the Integer
		§ by it leaves both sides ordered as the values are.

		§§ Whether this Rational is strictly below the given number.
		overload isLessThan {
			(_ other: Rational) -> Boolean {
				<- @::compare(to other)::is(#Less)
			}

			(_ other: Integer) -> Boolean {
				<- @::numerator()
					::isLessThan(other::multiply(with @::denominator()))
			}
		}

		§§ Whether this Rational is below the given number, or equal to it.
		overload isLessThanOrEqualTo {
			(_ other: Rational) -> Boolean {
				<- @::isGreaterThan(other)::negate()
			}

			(_ other: Integer) -> Boolean {
				<- @::isGreaterThan(other)::negate()
			}
		}

		§§ Whether this Rational is strictly above the given number.
		overload isGreaterThan {
			(_ other: Rational) -> Boolean {
				<- @::compare(to other)::is(#Greater)
			}

			(_ other: Integer) -> Boolean {
				<- @::numerator()
					::isGreaterThan(other::multiply(with @::denominator()))
			}
		}

		§§ Whether this Rational is above the given number, or equal to it.
		overload isGreaterThanOrEqualTo {
			(_ other: Rational) -> Boolean {
				<- @::isLessThan(other)::negate()
			}

			(_ other: Integer) -> Boolean {
				<- @::isLessThan(other)::negate()
			}
		}

		§§ The exact square root. A perfect square gives a Rational; any other non-negative value gives an exact Algebraic — and a negative is empty.
		squareRoot() -> Optional<Rational | Algebraic>

		§§ The numerator of the Rational in lowest terms. The sign of the Rational lives here — the denominator is always positive.
		numerator() -> Integer

		§§ The denominator of the Rational in lowest terms — always positive.
		denominator() -> Integer

		§§ The Rational without its sign — its distance from zero.
		absolute() -> Rational {
			if @::isLessThan(0/1) {
				<- @::negate()
			} else {
				<- @
			}
		}

		§§ The Rational with its sign flipped.
		negate() -> Rational {
			<- Rational.of(
				@::numerator()::negate(),
				over @::denominator(),
			)::otherwise(@)
		}

		§§ The Rational flipped upside down — the numerator and denominator exchanged.
		§§
		§§ @returns — the reciprocal, or nothing for zero.
		reciprocal() -> Optional<Rational> {
			<- Rational.of(@::denominator(), over @::numerator())
		}

		§§ Whether the Rational is a whole number — its denominator in lowest terms is one.
		isWholeNumber() -> Boolean {
			<- @::denominator()::is(1)
		}

		§ ONE Method, not four. `round`, `roundDown`, `roundUp` and `truncate`
		§ named the same idea four times, differing only in which Integer they
		§ reach for — which is what a Choice says in one place. Every entry is
		§ written on the FLOOR rather than on a sibling, so no branch depends
		§ on another entry of this same Overload, which an Essence body can not
		§ reach anyway.

		§§ The Rational as an Integer — the nearest one when no direction is named, or the one the given direction reaches.
		§§
		§§ @returns — the rounded Integer.
		overload round {
			§§ The nearest Integer. A value exactly halfway between two rounds away from zero — `1/2` gives `1`, `0 - 1/2` gives `0 - 1`.
			§§
			§§ @returns — the nearest Integer.
			() -> Integer {
				<- @::round(toward #Nearest)
			}

			§§ The Integer the given direction reaches — `Nearest` with halves rounding away from zero, `Down` the floor, `Up` the ceiling, `TowardZero` the Integer part with the fractional part cut off.
			§§
			§§ @param toward — which Integer to reach for
			§§ @returns — the rounded Integer.
			(toward direction: Rounding) -> Integer {
				§ The denominator is positive in lowest terms, so the Euclidean
				§ quotient is the FLOOR — `Down` outright, and the one Integer
				§ the other three are placed against. `quotient` can only answer
				§ empty for a zero divisor, and a denominator never is one.
				constant floored = @::numerator()
					::quotient(dividingBy @::denominator())
					::otherwise(0)

				constant isWhole = @::isWholeNumber()

				§ `@` is the SCRUTINEE inside a match, not the receiver, so the
				§ Rational is bound before the match to stay reachable in the
				§ Case bodies.
				constant value = @

				<- match direction -> Integer {
					case #Down { <- floored }

					case #Up {
						§ A whole Rational is already its own ceiling; anything
						§ else sits strictly above the floor.
						if isWhole {
							<- floored
						} else {
							<- floored::add(1)
						}
					}

					case #TowardZero {
						§ Cutting the fractional part off is the floor for a
						§ non-negative value, and one step back up towards zero
						§ for a negative one that is not already whole.
						if value::isLessThan(0/1)::and(isWhole::negate()) {
							<- floored::add(1)
						} else {
							<- floored
						}
					}

					case #Nearest {
						§ How far the value sits above its floor. Past a half
						§ the Integer above is nearer, below a half the floor
						§ is — and exactly at a half the tie is broken AWAY
						§ from zero, which for a negative value is the floor.
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
		}

		§§ Raises the Rational to the given power. A negative exponent gives the exact reciprocal power. Zero to the power of zero is one.
		§§
		§§ @param exponent — the exponent
		§§ @returns — the power, or nothing when raising zero to a negative power.
		raise(to exponent: Integer) -> Optional<Rational>

		§§ Reads a Rational from its text form — a fraction like `3/4`, a decimal like `0.75`, or a whole number like `3`, each with an optional minus sign.
		§§
		§§ @param text — the text to read
		§§ @returns — the Rational, or nothing when the text has any other shape or divides by zero.
		static parse(_ text: String) -> Optional<Rational> {
			§ The sign is carried as the position of a LEADING `-`, exactly as
			§ `Integer.parse` carries it — `keep` discards a `-` standing
			§ anywhere else, so what is left has a value exactly when the text
			§ is negative.
			constant sign = text
				::firstIndex(of "-")
				::keep(where (position) { <- position::is(0) })

			constant unsignedText = match sign -> String {
				case #Value { <- text::slice(from 1, to text::length()) }

				case #Empty { <- text }
			}

			§ The leading sign was the ONE place a `-` may stand — the pieces
			§ below are plain digit runs, so `1/-2` and `--1/2` are refused
			§ here rather than read as signed pieces.
			if unsignedText::contains("-") {
				<- #Empty
			}

			§ The sign folds back in as a factor on the numerator — the pieces
			§ below are unsigned, so multiplying the parsed numerator by this
			§ is the whole of what the leading `-` means.
			constant signFactor = match sign -> Integer {
				case #Value { <- -1 }

				case #Empty { <- 1 }
			}

			constant fractionPieces = unsignedText::split(on "/")

			if fractionPieces::length()::is(2) {
				§ One slash — a numerator over a denominator. `Rational.of`
				§ answers the zero-denominator empty itself, so both arms
				§ below hand back what it decided rather than wrapping it.
				<- match Integer.parse(
					fractionPieces::firstItem()::otherwise(""),
				) -> Optional<Rational> {
					case #Empty { <- #Empty }

					case #Value(parsedNumerator) {
						<- match Integer.parse(
							fractionPieces::lastItem()::otherwise(""),
						) -> Optional<Rational> {
							case #Empty                    { <- #Empty }

							case #Value(parsedDenominator) {
								<- Rational.of(
									parsedNumerator::multiply(with signFactor),
									over parsedDenominator,
								)
							}
						}
					}
				}
			} else if fractionPieces::length()::isNot(1) {
				<- #Empty
			} else {
				constant decimalPieces = unsignedText::split(on ".")

				if decimalPieces::length()::is(2) {
					§ One dot — the digits on both sides of it over a power
					§ of ten, one factor per fractional digit.
					constant wholeText      = decimalPieces
						::firstItem()
						::otherwise("")
					constant fractionalText = decimalPieces
						::lastItem()
						::otherwise("")

					if wholeText::isEmpty()::or(fractionalText::isEmpty()) {
						<- #Empty
					}

					<- match Integer.parse(
						wholeText::append(fractionalText),
					) -> Optional<Rational> {
						case #Empty { <- #Empty }

						case #Value(digitsValue) {
							constant scale = fractionalText
								::characters()
								::reduce(startingWith 1, (scaled, _) {
									<- scaled::multiply(with 10)
								})

							<- Rational.of(
								digitsValue::multiply(with signFactor),
								over scale,
							)
						}
					}
				} else if decimalPieces::length()::isNot(1) {
					<- #Empty
				} else {
					§ No slash and no dot — a whole number.
					<- match Integer.parse(unsignedText) -> Optional<Rational> {
						case #Empty              { <- #Empty }

						case #Value(parsedWhole) {
							<- Rational.of(
								parsedWhole::multiply(with signFactor),
								over 1,
							)
						}
					}
				}
			}
		}

		§ The format was a String — `toString(formatAs "decimal")` — which meant
		§ every other spelling silently fell back to the fraction form, and
		§ nothing told a caller which words were understood. `NumberFormat` is
		§ a Choice, so the two forms are the only two that can be written and
		§ a typo is a Diagnostic rather than a wrong answer.

		§§ Represents the Rational as a String — `"3/4"` in lowest terms when no format is named, or in the named format.
		§§
		§§ @returns — the String representation of the Rational.
		overload toString {
			() -> String {
				§ The fraction form off the accessors, NOT `formatAs #Fraction`
				§ — deliberately. The entries of an Overload are separate
				§ emitted Functions, so delegating would make every Program
				§ that merely prints a Rational carry the whole long-division
				§ decimal formatter behind the other entry.
				<- @::numerator()
					::toString()
					::append("/")
					::append(@::denominator()::toString())
			}

			§§ @param formatAs — the form to represent the Rational in
			(formatAs: NumberFormat) -> String
		}

		§§ Orders the Rational against another Rational.
		§§
		§§ @param other — the Rational to order against
		§§ @returns — `Ordering#Less`, `Ordering#Equal` or `Ordering#Greater`.
		compare(to other: Rational) -> Ordering
	}
}

export {
	NumberFormat
	Rational
	Rounding
}
