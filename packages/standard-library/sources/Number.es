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
	Rational       from "./Rational.es"
	Transcendental from "./Transcendental.es"
}

declarations {

	§ The whole numeric tower under one name. The `name` a use site sees is
	§ display-only — Hovers, Inlay Hints and Diagnostics print this Union as
	§ `Number` instead of spelling out all four members. Assignability
	§ ignores Union names entirely.
	type Number = Integer | Rational | Irrational

	§ `Irrational` is a transparent alias for `Algebraic | Transcendental`
	§ — the pair are definitional complements (transcendental means "not
	§ algebraic"), so the alias covers exactly the representable irrationals
	§ and makes `π is Irrational` a true sentence.
	type Irrational = Algebraic | Transcendental

	§ The two numeric kinds every aggregate below folds over. `Prelude.es` does
	§ not re-export it, so it is a helper of this file rather than a name the
	§ language grows.
	type Exact = Integer | Rational

	§ The one 2×2 dispatch in the file. Each aggregate below used to write it
	§ out again — a match on the running total around a match on the item, four
	§ arms deep, once per aggregate — and each of those was the same four cells
	§ this Namespace holds. A Union-typed receiver reaches no member
	§ Namespace's `add`, and `Number` deliberately declares none, so a
	§ Namespace over the two kinds is what lets a fold read as a fold.
	namespace Exact for Exact {
		§§ Adds two exact numbers. Two Integers give an Integer; anything else gives a Rational.
		§§
		§§ @param _ — the number to add
		§§ @returns — the exact sum.
		add(_ other: Exact) -> Exact {
			<- match @ -> Exact {
				case Integer {
					constant integer = @

					<- match other -> Exact {
						case Integer  { <- integer::add(@) }

						case Rational { <- integer::add(@) }
					}
				}

				case Rational {
					constant rational = @

					<- match other -> Exact {
						case Integer  { <- rational::add(@) }

						case Rational { <- rational::add(@) }
					}
				}
			}
		}

		§§ Multiplies two exact numbers. Two Integers give an Integer; anything else gives a Rational.
		§§
		§§ @param with — the number to multiply with
		§§ @returns — the exact product.
		multiply(with other: Exact) -> Exact {
			<- match @ -> Exact {
				case Integer {
					constant integer = @

					<- match other -> Exact {
						case Integer  { <- integer::multiply(with @) }

						case Rational { <- integer::multiply(with @) }
					}
				}

				case Rational {
					constant rational = @

					<- match other -> Exact {
						case Integer  { <- rational::multiply(with @) }

						case Rational { <- rational::multiply(with @) }
					}
				}
			}
		}
	}

	§ The Union-level behaviour of `Number` — cross-member semantics only a
	§ covering Namespace can define. `is` is numeric equality (`1 is 1/1` is
	§ true), while the member Namespaces stay representational; Method target
	§ specificity routes single-member receivers to those, so these Methods
	§ only answer for Union-typed receivers and mixed-member Arguments.
	§
	§ `compare` hand-writes all sixteen member cells and keeps the
	§ Comparable conformance even though Transcendental alone does not
	§ conform: every cell touching a single-base Transcendental is total
	§ because equality across kinds is impossible by definition, and only a
	§ Transcendental carrying both π and e reaches the one documented
	§ precision cutoff in the tower. The `isLessThan` family reads
	§ that same order, so it lives here for the same reason and is the one
	§ place two Transcendentals can be compared with a `<`.
	namespace Number for Number is Equatable, is Printable, is Comparable {
		§§ The ratio of a circle's circumference to its diameter, exactly.
		static Pi: Transcendental

		§§ Twice `Pi` — the ratio of a circle's circumference to its radius.
		static Tau: Transcendental

		§§ Euler's number — the base of the natural logarithm, exactly.
		static E: Transcendental

		§§ The golden ratio — `(1 + √5) / 2`, the positive solution of `x² = x + 1`, exactly.
		static GoldenRatio: Algebraic

		§§ Checks whether the Number has the same numeric value as another Number — an Integer and a Rational are the same Number when their values are equal, so `1 is 1/1` holds.
		§§
		§§ @param other — the Number to compare against
		§§ @returns — `true` when both Numbers have the same numeric value.
		is(_ other: Number) -> Boolean {
			<- @::compare(to other)::is(#Equal)
		}

		§§ Checks whether the Number has a different numeric value than another Number.
		§§
		§§ @param other — the Number to compare against
		§§ @returns — `true` when the Numbers have different numeric values.
		isNot(_ other: Number) -> Boolean {
			<- @::is(other)::negate()
		}

		§§ Represents the Number as a String, in the notation of the member Type it currently holds.
		toString() -> String {
			<- match @ -> String {
				case Integer        { <- @::toString() }
				case Rational       { <- @::toString() }
				case Algebraic      { <- @::toString() }
				case Transcendental { <- @::toString() }
			}
		}

		§§ Orders the Number against another Number by numeric value, across Integers and Rationals.
		§§
		§§ @param other — the Number to order against
		§§ @returns — `Ordering#Less`, `Ordering#Equal` or `Ordering#Greater`.
		compare(to other: Number) -> Ordering

		§§ Whether this Number is strictly below the given one.
		§§
		§§ @param other — the Number to compare against
		isLessThan(_ other: Number) -> Boolean {
			<- @::compare(to other)::is(#Less)
		}

		§§ Whether this Number is below the given one, or equal to it.
		§§
		§§ @param other — the Number to compare against
		isLessThanOrEqualTo(_ other: Number) -> Boolean {
			<- @::isGreaterThan(other)::negate()
		}

		§§ Whether this Number is strictly above the given one.
		§§
		§§ @param other — the Number to compare against
		isGreaterThan(_ other: Number) -> Boolean {
			<- @::compare(to other)::is(#Greater)
		}

		§§ Whether this Number is above the given one, or equal to it.
		§§
		§§ @param other — the Number to compare against
		isGreaterThanOrEqualTo(_ other: Number) -> Boolean {
			<- @::isLessThan(other)::negate()
		}

		§§ Whether this Number lies between the two given ones, both included — across every member of the numeric tower, so `Number.Pi::isBetween(3, and 22/7)` holds. Bounds in the wrong order enclose no Number, so the answer is `false`.
		§§
		§§ @param lower — the lower bound, included
		§§ @param and — the upper bound, included
		§§ @returns — `true` when the Number is within the bounds.
		isBetween(_ lower: Number, and upper: Number) -> Boolean {
			<- @::isGreaterThanOrEqualTo(lower)
				::and(@::isLessThanOrEqualTo(upper))
		}

		§ The aggregates are folds over the members' own arithmetic. A
		§ mixed-kind entry folds on `Exact` above, which holds the one 2×2
		§ dispatch, and collapses a whole-number total back to an Integer at the
		§ end — so a mixed List that happens to sum to a whole answers with the
		§ simpler member.

		§§ Adds up every Number in the List. The empty List sums to zero.
		§§
		§§ @returns — the exact total.
		overload static sum {
			(_ integers: List<Integer>) -> Integer {
				<- integers::reduce(startingWith 0, (total, integer) {
					<- total::add(integer)
				})
			}

			(_ rationals: List<Rational>) -> Rational {
				<- rationals::reduce(startingWith 0/1, (total, rational) {
					<- total::add(rational)
				})
			}

			(_ numbers: List<Integer | Rational>) -> Integer | Rational {
				constant start: Integer | Rational = 0

				constant total = numbers::reduce(
					startingWith start,
					(accumulated, number) { <- accumulated::add(number) },
				)

				<- match total -> Integer | Rational {
					case Integer { <- @ }

					case Rational {
						if @::isWholeNumber() {
							<- @::numerator()
						} else {
							<- @
						}
					}
				}
			}
		}

		§§ Multiplies every Number in the List together. The empty List multiplies to one.
		§§
		§§ @returns — the exact product.
		overload static product {
			(_ integers: List<Integer>) -> Integer {
				<- integers::reduce(startingWith 1, (total, integer) {
					<- total::multiply(with integer)
				})
			}

			(_ rationals: List<Rational>) -> Rational {
				<- rationals::reduce(startingWith 1/1, (total, rational) {
					<- total::multiply(with rational)
				})
			}

			(_ numbers: List<Integer | Rational>) -> Integer | Rational {
				constant start: Integer | Rational = 1

				constant total = numbers::reduce(
					startingWith start,
					(accumulated, number) {
						<- accumulated::multiply(with number)
					},
				)

				<- match total -> Integer | Rational {
					case Integer { <- @ }

					case Rational {
						if @::isWholeNumber() {
							<- @::numerator()
						} else {
							<- @
						}
					}
				}
			}
		}

		§ The empty List needs no guard of its own in `average`: it sums to
		§ zero and counts zero items, and dividing by the zero count is the
		§ empty Optional the signature already answers with.

		§§ The arithmetic mean of the Numbers in the List — their sum divided by their count, as an exact Rational.
		§§
		§§ @returns — the mean, or nothing for the empty List — no Numbers have no mean.
		overload static average {
			(_ integers: List<Integer>) -> Optional<Rational> {
				<- Number.sum(integers)::divide(by integers::length())
			}

			(_ rationals: List<Rational>) -> Optional<Rational> {
				<- Number.sum(rationals)::divide(by rationals::length())
			}

			(_ numbers: List<Integer | Rational>) -> Optional<Rational> {
				constant count = numbers::length()

				<- match Number.sum(numbers) -> Optional<Rational> {
					case Integer  { <- @::divide(by count) }

					case Rational { <- @::divide(by count) }
				}
			}

			§§ The arithmetic mean of the Integers, with a value to answer for the empty List.
			§§
			§§ @param _ — the Integers to average
			§§ @param defaultingTo — the value to answer with when there is no mean
			§§ @returns — the mean, or the given value in its place.
			(
				_ integers: List<Integer>,
				defaultingTo fallback: Rational,
			) -> Rational {
				<- Number.average(integers)::value(defaultingTo fallback)
			}

			§§ The arithmetic mean of the Rationals, with a value to answer for the empty List.
			§§
			§§ @param _ — the Rationals to average
			§§ @param defaultingTo — the value to answer with when there is no mean
			§§ @returns — the mean, or the given value in its place.
			(
				_ rationals: List<Rational>,
				defaultingTo fallback: Rational,
			) -> Rational {
				<- Number.average(rationals)::value(defaultingTo fallback)
			}

			§§ The arithmetic mean of the Numbers, with a value to answer for the empty List.
			§§
			§§ @param _ — the Numbers to average
			§§ @param defaultingTo — the value to answer with when there is no mean
			§§ @returns — the mean, or the given value in its place.
			(
				_ numbers: List<Integer | Rational>,
				defaultingTo fallback: Rational,
			) -> Rational {
				<- Number.average(numbers)::value(defaultingTo fallback)
			}
		}

		§§ The lower of two Numbers, or the lowest in a List of them.
		§§
		§§ @returns — the lowest Number — nothing for the empty List, which has none.
		overload static lowestNumber {
			(_ firstNumber: Integer, _ secondNumber: Integer) -> Integer {
				if firstNumber::isLessThanOrEqualTo(secondNumber) {
					<- firstNumber
				} else {
					<- secondNumber
				}
			}

			(_ firstNumber: Rational, _ secondNumber: Rational) -> Rational {
				if firstNumber::isLessThanOrEqualTo(secondNumber) {
					<- firstNumber
				} else {
					<- secondNumber
				}
			}

			(
				_ firstNumber: Integer,
				_ secondNumber: Rational,
			) -> Integer | Rational {
				if firstNumber::isLessThanOrEqualTo(secondNumber) {
					<- firstNumber
				} else {
					<- secondNumber
				}
			}

			(
				_ firstNumber: Rational,
				_ secondNumber: Integer,
			) -> Integer | Rational {
				if firstNumber::isLessThanOrEqualTo(secondNumber) {
					<- firstNumber
				} else {
					<- secondNumber
				}
			}

			§ The List entries fold the pairwise ones over the items, seeded
			§ empty so the first item becomes the running answer and the empty
			§ List keeps the seed. On a tie the pairwise entries answer the
			§ FIRST operand, so the earliest of equal items wins, exactly as
			§ walking the List reads.

			(_ integers: List<Integer>) -> Optional<Integer> {
				constant start: Optional<Integer> = #Empty

				<- integers::reduce(startingWith start, (lowest, integer) {
					<- match lowest -> Optional<Integer> {
						case #Empty          { <- #Value(integer) }

						case #Value(running) {
							<- #Value(Number.lowestNumber(running, integer))
						}
					}
				})
			}

			(_ rationals: List<Rational>) -> Optional<Rational> {
				constant start: Optional<Rational> = #Empty

				<- rationals::reduce(startingWith start, (lowest, rational) {
					<- match lowest -> Optional<Rational> {
						case #Empty          { <- #Value(rational) }

						case #Value(running) {
							<- #Value(Number.lowestNumber(running, rational))
						}
					}
				})
			}

			§ The mixed entry needs no dispatch of its own: the covering
			§ `Number::isLessThanOrEqualTo` reads the cross-kind order, and an
			§ `Integer | Rational` receiver reaches it.
			(
				_ numbers: List<Integer | Rational>,
			) -> Optional<Integer | Rational> {
				constant start: Optional<Integer | Rational> = #Empty

				<- numbers::reduce(startingWith start, (lowest, number) {
					<- match lowest -> Optional<Integer | Rational> {
						case #Empty { <- #Value(number) }

						case #Value(running) {
							if running::isLessThanOrEqualTo(number) {
								<- #Value(running)
							} else {
								<- #Value(number)
							}
						}
					}
				})
			}

			§§ The lowest of the Integers, with a value to answer for the empty List.
			§§
			§§ @param _ — the Integers to compare
			§§ @param defaultingTo — the value to answer with when there is no lowest
			§§ @returns — the lowest Integer, or the given value in its place.
			(
				_ integers: List<Integer>,
				defaultingTo fallback: Integer,
			) -> Integer {
				<- Number.lowestNumber(integers)::value(defaultingTo fallback)
			}

			§§ The lowest of the Rationals, with a value to answer for the empty List.
			§§
			§§ @param _ — the Rationals to compare
			§§ @param defaultingTo — the value to answer with when there is no lowest
			§§ @returns — the lowest Rational, or the given value in its place.
			(
				_ rationals: List<Rational>,
				defaultingTo fallback: Rational,
			) -> Rational {
				<- Number.lowestNumber(rationals)::value(defaultingTo fallback)
			}

			§§ The lowest of the Numbers, with a value to answer for the empty List.
			§§
			§§ @param _ — the Numbers to compare
			§§ @param defaultingTo — the value to answer with when there is no lowest
			§§ @returns — the lowest Number, or the given value in its place.
			(
				_ numbers: List<Integer | Rational>,
				defaultingTo fallback: Integer | Rational,
			) -> Integer | Rational {
				<- Number.lowestNumber(numbers)::value(defaultingTo fallback)
			}
		}

		§§ The greater of two Numbers, or the greatest in a List of them.
		§§
		§§ @returns — the greatest Number — nothing for the empty List, which has none.
		overload static greatestNumber {
			(_ firstNumber: Integer, _ secondNumber: Integer) -> Integer {
				if firstNumber::isGreaterThanOrEqualTo(secondNumber) {
					<- firstNumber
				} else {
					<- secondNumber
				}
			}

			(_ firstNumber: Rational, _ secondNumber: Rational) -> Rational {
				if firstNumber::isGreaterThanOrEqualTo(secondNumber) {
					<- firstNumber
				} else {
					<- secondNumber
				}
			}

			(
				_ firstNumber: Integer,
				_ secondNumber: Rational,
			) -> Integer | Rational {
				if firstNumber::isGreaterThanOrEqualTo(secondNumber) {
					<- firstNumber
				} else {
					<- secondNumber
				}
			}

			(
				_ firstNumber: Rational,
				_ secondNumber: Integer,
			) -> Integer | Rational {
				if firstNumber::isGreaterThanOrEqualTo(secondNumber) {
					<- firstNumber
				} else {
					<- secondNumber
				}
			}

			§ The same fold as `lowestNumber`'s List entries, over the greater
			§ pairwise answer.

			(_ integers: List<Integer>) -> Optional<Integer> {
				constant start: Optional<Integer> = #Empty

				<- integers::reduce(startingWith start, (greatest, integer) {
					<- match greatest -> Optional<Integer> {
						case #Empty          { <- #Value(integer) }

						case #Value(running) {
							<- #Value(Number.greatestNumber(running, integer))
						}
					}
				})
			}

			(_ rationals: List<Rational>) -> Optional<Rational> {
				constant start: Optional<Rational> = #Empty

				<- rationals::reduce(startingWith start, (greatest, rational) {
					<- match greatest -> Optional<Rational> {
						case #Empty          { <- #Value(rational) }

						case #Value(running) {
							<- #Value(Number.greatestNumber(running, rational))
						}
					}
				})
			}

			§ The same fold as `lowestNumber`'s mixed entry, over the covering
			§ `Number::isGreaterThanOrEqualTo`.
			(
				_ numbers: List<Integer | Rational>,
			) -> Optional<Integer | Rational> {
				constant start: Optional<Integer | Rational> = #Empty

				<- numbers::reduce(startingWith start, (greatest, number) {
					<- match greatest -> Optional<Integer | Rational> {
						case #Empty { <- #Value(number) }

						case #Value(running) {
							if running::isGreaterThanOrEqualTo(number) {
								<- #Value(running)
							} else {
								<- #Value(number)
							}
						}
					}
				})
			}

			§§ The greatest of the Integers, with a value to answer for the empty List.
			§§
			§§ @param _ — the Integers to compare
			§§ @param defaultingTo — the value to answer with when there is no greatest
			§§ @returns — the greatest Integer, or the given value in its place.
			(
				_ integers: List<Integer>,
				defaultingTo fallback: Integer,
			) -> Integer {
				<- Number.greatestNumber(integers)::value(defaultingTo fallback)
			}

			§§ The greatest of the Rationals, with a value to answer for the empty List.
			§§
			§§ @param _ — the Rationals to compare
			§§ @param defaultingTo — the value to answer with when there is no greatest
			§§ @returns — the greatest Rational, or the given value in its place.
			(
				_ rationals: List<Rational>,
				defaultingTo fallback: Rational,
			) -> Rational {
				<- Number.greatestNumber(rationals)::value(
					defaultingTo fallback,
				)
			}

			§§ The greatest of the Numbers, with a value to answer for the empty List.
			§§
			§§ @param _ — the Numbers to compare
			§§ @param defaultingTo — the value to answer with when there is no greatest
			§§ @returns — the greatest Number, or the given value in its place.
			(
				_ numbers: List<Integer | Rational>,
				defaultingTo fallback: Integer | Rational,
			) -> Integer | Rational {
				<- Number.greatestNumber(numbers)::value(defaultingTo fallback)
			}
		}
	}
}

export {
	Irrational
	Number
}
