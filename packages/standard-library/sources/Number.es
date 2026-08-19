import {
	Algebraic      from "./Algebraic.es"
	Boolean        from "./Boolean.es"
	Integer        from "./Integer.es"
	List           from "./List.es"
	Optional       from "./Optional.es"
	Orderable      from "./Orderable.es"
	Ordering       from "./Ordering.es"
	Equatable      from "./Protocols.es"
	Printable      from "./Protocols.es"
	Rational       from "./Rational.es"
	Transcendental from "./Transcendental.es"
}

declarations {

	§ The whole numeric tower under one name; see DEVELOPMENT.md, Editing
	§ hazards, for what naming a Union does and does not do.
	type Number = Integer | Rational | Irrational

	§ `Algebraic` and `Transcendental` are complements: transcendental means
	§ not algebraic. The alias covers exactly the irrationals the tower holds.
	type Irrational = Algebraic | Transcendental

	§ The two numeric kinds the aggregates below fold over. `Prelude.es` does
	§ not re-export it, so it stays a helper of this file.
	type Exact = Integer | Rational

	§ The one 2×2 dispatch in the file. A Union-typed receiver reaches no
	§ member Namespace's `add`, and `Number` declares none, so the mixed
	§ aggregates below fold on this Namespace instead.
	§
	§ `@` is rebound inside `match`, and `reduce` binds `Result` from
	§ `startingWith`; see DEVELOPMENT.md, Why bodies look the way they do.
	namespace Exact for Exact {
		§§ Adds two exact numbers.
		§§
		§§ The answer is an Integer for two Integers, and a Rational for every other pair.
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

		§§ Multiplies two exact numbers.
		§§
		§§ The answer is an Integer for two Integers, and a Rational for every other pair.
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

	§ The cross-member semantics of the tower. `is` is numeric equality here,
	§ so `1 is 1/1` is true, while each member Namespace stays
	§ representational. Specificity routes a single-member receiver to its own
	§ Namespace, so these Methods answer for Union receivers.
	§
	§ `compare` is native and writes all sixteen member cells, which is what
	§ keeps `Number`'s Comparable conformance total across kinds. The
	§ `isLessThan` family reads that same order.
	namespace Number for Number is Equatable, is Printable, is Orderable {
		§§ The ratio of a circle's circumference to its diameter, exactly.
		static Pi: Transcendental

		§§ Twice `Pi`, which is the ratio of a circle's circumference to its radius.
		static Tau: Transcendental

		§§ Euler's number, the base of the natural logarithm, exactly.
		static E: Transcendental

		§§ The golden ratio `(1 + √5) / 2`, the positive solution of `x² = x + 1`, exactly.
		static GoldenRatio: Algebraic

		§ Each aggregate is a fold over the members' own arithmetic. A mixed
		§ entry folds on `Exact` above.

		§§ Adds up every Number in the List.
		§§
		§§ The empty List sums to zero. A mixed List answers an Integer when its total is whole, and a Rational otherwise.
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

		§§ Multiplies every Number in the List together.
		§§
		§§ The empty List multiplies to one. A mixed List answers an Integer when its product is whole, and a Rational otherwise.
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

		§ The empty List needs no guard here. It sums to zero, and dividing by
		§ its zero count is the empty Optional the signature answers with.

		§§ The arithmetic mean of the Numbers in the List: their sum divided by their count, as an exact Rational.
		§§
		§§ The empty List has no mean, and the `defaultingTo:` entries answer the given Rational in place of nothing.
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
		§§ The answer for two equal Numbers is the first of them. A List answers the earliest of its lowest items. The empty List has none, and the `defaultingTo:` entries answer the given Number in place of nothing.
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

			§ The List entries fold the pairwise ones over the items. The seed
			§ is empty, so the first item becomes the running answer and the
			§ empty List keeps it.

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

			§ The mixed entry needs no dispatch: an `Integer | Rational`
			§ receiver reaches `Number::isLessThanOrEqualTo` for the
			§ cross-kind order.
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
		§§ The answer for two equal Numbers is the first of them. A List answers the earliest of its greatest items. The empty List has none, and the `defaultingTo:` entries answer the given Number in place of nothing.
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

		§§ Answers whether the Number has the same numeric value as another Number.
		§§
		§§ An Integer and a Rational are the same Number when their values are equal, so `1 is 1/1` holds.
		§§
		§§ @param _ — the Number to compare against
		§§ @returns — `true` when both Numbers have the same numeric value.
		is(_ other: Number) -> Boolean {
			<- @::compare(to other)::is(#Equal)
		}

		§§ Orders the Number against another Number by numeric value, across every member of the tower.
		§§
		§§ @param to — the Number to order against
		§§ @returns — `Ordering#Less`, `Ordering#Equal` or `Ordering#Greater`.
		compare(to other: Number) -> Ordering

		§§ Answers the Number as a String, in the notation of the member Type it holds.
		§§
		§§ @returns — the String representation of the Number.
		toString() -> String {
			<- match @ -> String {
				case Integer        { <- @::toString() }
				case Rational       { <- @::toString() }
				case Algebraic      { <- @::toString() }
				case Transcendental { <- @::toString() }
			}
		}

		§ The four inequalities, `isBetween` and `clamp` are `Orderable`'s
		§ provided Methods, written once on `compare`. The conformance above
		§ is what a Number receiver reaches them through, and this Namespace
		§ declares none of the six itself. Reaching one through it is spelled
		§ both ways a written Method is, so `Number.isLessThan(a, b)` stands
		§ beside `Number.compare(a, to b)`. See README.md, Ordering across
		§ two kinds falls to Number.
	}
}

export {
	Irrational
	Number
}
