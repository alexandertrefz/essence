import {
	from "./Algebraic.es" { Algebraic }
	from "./Boolean.es" { Boolean }
	from "./Integer.es" { Integer }
	from "./List.es" {
		List
		NonEmptyList
	}
	from "./Optional.es" { Optional }
	from "./Orderable.es" { Orderable }
	from "./Ordering.es" { Ordering }
	from "./Protocols.es" {
		Equatable
		Printable
	}
	from "./Rational.es" { Rational }
	from "./Transcendental.es" { Transcendental }
}

declarations {

	§ The whole numeric tower under one name; see DEVELOPMENT.md, Editing
	§ hazards, for what naming a Union does and does not do.
	type Number = Integer | Rational | Irrational

	§ `Algebraic` and `Transcendental` are complements: transcendental means
	§ not algebraic. The alias covers exactly the irrationals the tower holds.
	type Irrational = Algebraic | Transcendental

	§§ An Integer or a Rational: the two numeric kinds a Program computes with exactly.
	§§
	§§ Every Number is a Scalar or an Irrational. The two Methods below answer a Scalar for any two Scalars, which is what the mixed aggregates fold on.
	§
	§ The name is the author's pick over `Exact`, which this alias carried as a
	§ helper of this file. Pi is exact as well, so `Exact` overclaimed the half
	§ it names. That half is the rationals in either representation. The
	§ sources spell `Integer | Rational` 54 times, and a Program that writes
	§ `numbers::sum()` had no word for what it got back.
	type Scalar = Integer | Rational

	§ The one 2×2 dispatch in the file, and the only shape that adds or
	§ multiplies two Scalars. A Union-typed receiver does reach a member
	§ Namespace's `add`. A Scalar receiver with an Integer Argument emits a
	§ two-arm test on the receiver's tag. It is the Argument that no member
	§ takes: each of `Integer::add`'s four overloads wants one kind, so a
	§ Scalar Argument matches none of them. Both operands of the mixed
	§ aggregates below are Scalars, which is why they fold here. A Program
	§ adding two Scalars of its own reaches the same two bodies.
	§
	§ The alternative was `add` on `Number` itself, a 4×4 match whose answer
	§ every caller would have to unwrap. An Algebraic sum over two radicals
	§ answers empty, so a Number-level sum could not answer bare. Folding on
	§ the covering `Number` also keeps the irrational arms in the bundle. A
	§ 300 000-item fold over `List.of(integersFrom 1, through 300000)`
	§ bundles to 16,812 bytes with the accumulator annotated as `Number`,
	§ against 14,703 with it annotated as `Scalar`.
	§
	§ Specificity is what routes a call here rather than to a member's own
	§ rung, since this target is the Union exactly. The mixed `sum` below
	§ emits `$es_Scalar_add`, and so does the fold measured above.
	§
	§ `@` is rebound inside `match`, and `reduce` binds `Result` from
	§ `startingWith`; see DEVELOPMENT.md, Why bodies look the way they do.
	namespace Scalar for Scalar {
		§§ Adds two Scalars.
		§§
		§§ The answer is an Integer for two Integers, and a Rational for every other pair.
		§§
		§§ @param _ — the Scalar to add
		§§ @returns — the exact sum.
		add(_ other: Scalar) -> Scalar {
			<- match @ -> Scalar {
				case Integer {
					constant integer = @

					<- match other -> Scalar {
						case Integer  { <- integer::add(@) }

						case Rational { <- integer::add(@) }
					}
				}

				case Rational {
					constant rational = @

					<- match other -> Scalar {
						case Integer  { <- rational::add(@) }

						case Rational { <- rational::add(@) }
					}
				}
			}
		}

		§§ Multiplies two Scalars.
		§§
		§§ The answer is an Integer for two Integers, and a Rational for every other pair.
		§§
		§§ @param with — the Scalar to multiply with
		§§ @returns — the exact product.
		multiply(with other: Scalar) -> Scalar {
			<- match @ -> Scalar {
				case Integer {
					constant integer = @

					<- match other -> Scalar {
						case Integer  { <- integer::multiply(with @) }

						case Rational { <- integer::multiply(with @) }
					}
				}

				case Rational {
					constant rational = @

					<- match other -> Scalar {
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
		§ entry folds on `Scalar` above.

		§§ Adds up every Number in the List.
		§§
		§§ The empty List sums to zero. A mixed List answers an Integer when its total is whole, and a Rational otherwise.
		§§
		§§ @returns — the exact total.
		overload static sum {
			§§ Adds up every Integer in the List.
			§§
			§§ The sum is an Integer, since whole numbers add to a whole number. The empty List sums to zero.
			§§
			§§ @param _ — the Integers to add up
			§§ @returns — the total.
			(_ integers: List<Integer>) -> Integer {
				<- integers::reduce(startingWith 0, (total, integer) {
					<- total::add(integer)
				})
			}

			§§ Adds up every Rational in the List.
			§§
			§§ The sum is a Rational, since it need not be whole. The empty List sums to zero.
			§§
			§§ @param _ — the Rationals to add up
			§§ @returns — the total.
			(_ rationals: List<Rational>) -> Rational {
				<- rationals::reduce(startingWith 0/1, (total, rational) {
					<- total::add(rational)
				})
			}

			§§ Adds up a List holding both Integers and Rationals.
			§§
			§§ The sum is an Integer when the total is whole, and a Rational otherwise. The empty List sums to zero.
			§§
			§§ @param _ — the Numbers to add up
			§§ @returns — the total.
			(_ numbers: List<Scalar>) -> Scalar {
				constant start: Scalar = 0

				constant total = numbers::reduce(
					startingWith start,
					(accumulated, number) { <- accumulated::add(number) },
				)

				<- match total -> Scalar {
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
			§§ Multiplies every Integer in the List together.
			§§
			§§ The product is an Integer, since whole numbers multiply to a whole number. The empty List multiplies to one.
			§§
			§§ @param _ — the Integers to multiply
			§§ @returns — the product.
			(_ integers: List<Integer>) -> Integer {
				<- integers::reduce(startingWith 1, (total, integer) {
					<- total::multiply(with integer)
				})
			}

			§§ Multiplies every Rational in the List together.
			§§
			§§ The product is a Rational, since it need not be whole. The empty List multiplies to one.
			§§
			§§ @param _ — the Rationals to multiply
			§§ @returns — the product.
			(_ rationals: List<Rational>) -> Rational {
				<- rationals::reduce(startingWith 1/1, (total, rational) {
					<- total::multiply(with rational)
				})
			}

			§§ Multiplies a List holding both Integers and Rationals together.
			§§
			§§ The product is an Integer when it is whole, and a Rational otherwise. The empty List multiplies to one.
			§§
			§§ @param _ — the Numbers to multiply
			§§ @returns — the product.
			(_ numbers: List<Scalar>) -> Scalar {
				constant start: Scalar = 1

				constant total = numbers::reduce(
					startingWith start,
					(accumulated, number) {
						<- accumulated::multiply(with number)
					},
				)

				<- match total -> Scalar {
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
		§ its zero count is the empty Optional the signature answers with. A
		§ proven List divides by a NonZeroInteger count, so the proven entries
		§ at the end answer the mean itself.

		§§ The arithmetic mean of the Numbers in the List: their sum divided by their count, as an exact Rational.
		§§
		§§ The empty List has no mean, and the `defaultingTo:` entries answer the given Rational in place of nothing. A List proven to have an item answers the mean itself.
		overload static average {
			§§ The arithmetic mean of the Integers: their sum divided by their count.
			§§
			§§ The mean is a Rational, since it need not be whole. The empty List has no mean.
			§§
			§§ @param _ — the Integers to average
			§§ @returns — the mean, or nothing for the empty List.
			(_ integers: List<Integer>) -> Optional<Rational> {
				<- Number.sum(integers)::divide(by integers::length())
			}

			§§ The arithmetic mean of the Rationals: their sum divided by their count.
			§§
			§§ The mean is a Rational. The empty List has no mean.
			§§
			§§ @param _ — the Rationals to average
			§§ @returns — the mean, or nothing for the empty List.
			(_ rationals: List<Rational>) -> Optional<Rational> {
				<- Number.sum(rationals)::divide(by rationals::length())
			}

			§§ The arithmetic mean of a List holding both Integers and Rationals.
			§§
			§§ The mean is a Rational, since it need not be whole. The empty List has no mean.
			§§
			§§ @param _ — the Numbers to average
			§§ @returns — the mean, or nothing for the empty List.
			(_ numbers: List<Scalar>) -> Optional<Rational> {
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
				_ numbers: List<Scalar>,
				defaultingTo fallback: Rational,
			) -> Rational {
				<- Number.average(numbers)::value(defaultingTo fallback)
			}

			§ The proven entries stand after the `defaultingTo:` ones because an
			§ entry's position is the name it is emitted under; see
			§ DEVELOPMENT.md, Editing hazards. A call that can prove what one of
			§ them asks for reaches it wherever it stands.

			§§ The arithmetic mean of the Integers in a List proven to have an item.
			§§
			§§ The count is above zero, so the answer is the mean itself rather than an Optional.
			§§
			§§ @param _ — the Integers to average
			§§ @returns — the mean.
			(_ integers: NonEmptyList<Integer>) -> Rational {
				<- Number.sum(integers)::divide(by integers::length())
			}

			§§ The arithmetic mean of the Rationals in a List proven to have an item.
			§§
			§§ The count is above zero, so the answer is the mean itself rather than an Optional.
			§§
			§§ @param _ — the Rationals to average
			§§ @returns — the mean.
			(_ rationals: NonEmptyList<Rational>) -> Rational {
				<- Number.sum(rationals)::divide(by rationals::length())
			}

			§§ The arithmetic mean of the Numbers in a List proven to have an item.
			§§
			§§ The count is above zero, so the answer is the mean itself rather than an Optional.
			§§
			§§ @param _ — the Numbers to average
			§§ @returns — the mean.
			(_ numbers: NonEmptyList<Scalar>) -> Rational {
				constant count = numbers::length()

				<- match Number.sum(numbers) -> Rational {
					case Integer  { <- @::divide(by count) }

					case Rational { <- @::divide(by count) }
				}
			}
		}

		§§ The lower of two Numbers, or the lowest in a List of them.
		§§
		§§ The answer for two equal Numbers is the first of them. A List answers the earliest of its lowest items. The empty List has none, and the `defaultingTo:` entries answer the given Number in place of nothing. A List proven to have an item answers the item itself.
		overload static lowestNumber {
			§§ The lower of two Integers.
			§§
			§§ The answer is an Integer. Two equal Integers answer the first of them.
			§§
			§§ @param _ — the first Integer to compare
			§§ @param _ — the second Integer to compare
			§§ @returns — the lower Integer.
			(_ firstNumber: Integer, _ secondNumber: Integer) -> Integer {
				if firstNumber::isLessThanOrEqualTo(secondNumber) {
					<- firstNumber
				} else {
					<- secondNumber
				}
			}

			§§ The lower of two Rationals.
			§§
			§§ The answer is a Rational. Two equal Rationals answer the first of them.
			§§
			§§ @param _ — the first Rational to compare
			§§ @param _ — the second Rational to compare
			§§ @returns — the lower Rational.
			(_ firstNumber: Rational, _ secondNumber: Rational) -> Rational {
				if firstNumber::isLessThanOrEqualTo(secondNumber) {
					<- firstNumber
				} else {
					<- secondNumber
				}
			}

			§§ The lower of an Integer and a Rational.
			§§
			§§ The answer keeps the kind of the Number it picks, so it is an Integer or a Rational. Two equal Numbers answer the Integer.
			§§
			§§ @param _ — the Integer to compare
			§§ @param _ — the Rational to compare
			§§ @returns — the lower Number.
			(_ firstNumber: Integer, _ secondNumber: Rational) -> Scalar {
				if firstNumber::isLessThanOrEqualTo(secondNumber) {
					<- firstNumber
				} else {
					<- secondNumber
				}
			}

			§§ The lower of a Rational and an Integer.
			§§
			§§ The answer keeps the kind of the Number it picks, so it is an Integer or a Rational. Two equal Numbers answer the Rational.
			§§
			§§ @param _ — the Rational to compare
			§§ @param _ — the Integer to compare
			§§ @returns — the lower Number.
			(_ firstNumber: Rational, _ secondNumber: Integer) -> Scalar {
				if firstNumber::isLessThanOrEqualTo(secondNumber) {
					<- firstNumber
				} else {
					<- secondNumber
				}
			}

			§ The List entries fold the pairwise ones over the items. The seed
			§ is empty, so the first item becomes the running answer and the
			§ empty List keeps it.

			§§ The lowest of the Integers in the List.
			§§
			§§ The answer is the earliest of the lowest items. The empty List has none.
			§§
			§§ @param _ — the Integers to compare
			§§ @returns — the lowest Integer, or nothing for the empty List.
			(_ integers: List<Integer>) -> Optional<Integer> {
				constant start: Optional<Integer> = #Empty

				<- integers::reduce(startingWith start, (lowest, integer) {
					<- match lowest -> Optional<Integer> {
						case #Empty { <- #Value(integer) }

						case #Value(running) {
							<- #Value(Number.lowestNumber(running, integer))
						}
					}
				})
			}

			§§ The lowest of the Rationals in the List.
			§§
			§§ The answer is the earliest of the lowest items. The empty List has none.
			§§
			§§ @param _ — the Rationals to compare
			§§ @returns — the lowest Rational, or nothing for the empty List.
			(_ rationals: List<Rational>) -> Optional<Rational> {
				constant start: Optional<Rational> = #Empty

				<- rationals::reduce(startingWith start, (lowest, rational) {
					<- match lowest -> Optional<Rational> {
						case #Empty { <- #Value(rational) }

						case #Value(running) {
							<- #Value(Number.lowestNumber(running, rational))
						}
					}
				})
			}

			§ The mixed entry needs no dispatch: a `Scalar` receiver reaches
			§ `Number::isLessThanOrEqualTo` for the cross-kind order.

			§§ The lowest Number in a List holding both Integers and Rationals.
			§§
			§§ The answer keeps the kind of the item it picks, and is the earliest of the lowest items. The empty List has none.
			§§
			§§ @param _ — the Numbers to compare
			§§ @returns — the lowest Number, or nothing for the empty List.
			(_ numbers: List<Scalar>) -> Optional<Scalar> {
				constant start: Optional<Scalar> = #Empty

				<- numbers::reduce(startingWith start, (lowest, number) {
					<- match lowest -> Optional<Scalar> {
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
			(_ numbers: List<Scalar>, defaultingTo fallback: Scalar) -> Scalar {
				<- Number.lowestNumber(numbers)::value(defaultingTo fallback)
			}

			§ The proven entries fold the same pairwise ones from `firstItem()`,
			§ which the List certainly holds. There is no empty seed to carry,
			§ so no entry answers an Optional.

			§§ The lowest of the Integers in a List proven to have an item.
			§§
			§§ The List has a lowest item, so the answer is that item rather than an Optional.
			§§
			§§ @param _ — the Integers to compare
			§§ @returns — the lowest Integer.
			(_ integers: NonEmptyList<Integer>) -> Integer {
				<- integers::reduce(
					startingWith integers::firstItem(),
					(lowest, integer) {
						<- Number.lowestNumber(lowest, integer)
					},
				)
			}

			§§ The lowest of the Rationals in a List proven to have an item.
			§§
			§§ The List has a lowest item, so the answer is that item rather than an Optional.
			§§
			§§ @param _ — the Rationals to compare
			§§ @returns — the lowest Rational.
			(_ rationals: NonEmptyList<Rational>) -> Rational {
				<- rationals::reduce(
					startingWith rationals::firstItem(),
					(lowest, rational) {
						<- Number.lowestNumber(lowest, rational)
					},
				)
			}

			§§ The lowest of the Numbers in a List proven to have an item.
			§§
			§§ The List has a lowest item, so the answer is that item rather than an Optional.
			§§
			§§ @param _ — the Numbers to compare
			§§ @returns — the lowest Number.
			(_ numbers: NonEmptyList<Scalar>) -> Scalar {
				<- numbers::reduce(
					startingWith numbers::firstItem(),
					(lowest, number) {
						if lowest::isLessThanOrEqualTo(number) {
							<- lowest
						} else {
							<- number
						}
					},
				)
			}
		}

		§§ The higher of two Numbers, or the highest in a List of them.
		§§
		§§ The answer for two equal Numbers is the first of them. A List answers the earliest of its highest items. The empty List has none, and the `defaultingTo:` entries answer the given Number in place of nothing. A List proven to have an item answers the item itself.
		overload static highestNumber {
			§§ The higher of two Integers.
			§§
			§§ The answer is an Integer. Two equal Integers answer the first of them.
			§§
			§§ @param _ — the first Integer to compare
			§§ @param _ — the second Integer to compare
			§§ @returns — the higher Integer.
			(_ firstNumber: Integer, _ secondNumber: Integer) -> Integer {
				if firstNumber::isGreaterThanOrEqualTo(secondNumber) {
					<- firstNumber
				} else {
					<- secondNumber
				}
			}

			§§ The higher of two Rationals.
			§§
			§§ The answer is a Rational. Two equal Rationals answer the first of them.
			§§
			§§ @param _ — the first Rational to compare
			§§ @param _ — the second Rational to compare
			§§ @returns — the higher Rational.
			(_ firstNumber: Rational, _ secondNumber: Rational) -> Rational {
				if firstNumber::isGreaterThanOrEqualTo(secondNumber) {
					<- firstNumber
				} else {
					<- secondNumber
				}
			}

			§§ The higher of an Integer and a Rational.
			§§
			§§ The answer keeps the kind of the Number it picks, so it is an Integer or a Rational. Two equal Numbers answer the Integer.
			§§
			§§ @param _ — the Integer to compare
			§§ @param _ — the Rational to compare
			§§ @returns — the higher Number.
			(_ firstNumber: Integer, _ secondNumber: Rational) -> Scalar {
				if firstNumber::isGreaterThanOrEqualTo(secondNumber) {
					<- firstNumber
				} else {
					<- secondNumber
				}
			}

			§§ The higher of a Rational and an Integer.
			§§
			§§ The answer keeps the kind of the Number it picks, so it is an Integer or a Rational. Two equal Numbers answer the Rational.
			§§
			§§ @param _ — the Rational to compare
			§§ @param _ — the Integer to compare
			§§ @returns — the higher Number.
			(_ firstNumber: Rational, _ secondNumber: Integer) -> Scalar {
				if firstNumber::isGreaterThanOrEqualTo(secondNumber) {
					<- firstNumber
				} else {
					<- secondNumber
				}
			}

			§§ The highest of the Integers in the List.
			§§
			§§ The answer is the earliest of the highest items. The empty List has none.
			§§
			§§ @param _ — the Integers to compare
			§§ @returns — the highest Integer, or nothing for the empty List.
			(_ integers: List<Integer>) -> Optional<Integer> {
				constant start: Optional<Integer> = #Empty

				<- integers::reduce(startingWith start, (highest, integer) {
					<- match highest -> Optional<Integer> {
						case #Empty { <- #Value(integer) }

						case #Value(running) {
							<- #Value(Number.highestNumber(running, integer))
						}
					}
				})
			}

			§§ The highest of the Rationals in the List.
			§§
			§§ The answer is the earliest of the highest items. The empty List has none.
			§§
			§§ @param _ — the Rationals to compare
			§§ @returns — the highest Rational, or nothing for the empty List.
			(_ rationals: List<Rational>) -> Optional<Rational> {
				constant start: Optional<Rational> = #Empty

				<- rationals::reduce(startingWith start, (highest, rational) {
					<- match highest -> Optional<Rational> {
						case #Empty { <- #Value(rational) }

						case #Value(running) {
							<- #Value(Number.highestNumber(running, rational))
						}
					}
				})
			}

			§§ The highest Number in a List holding both Integers and Rationals.
			§§
			§§ The answer keeps the kind of the item it picks, and is the earliest of the highest items. The empty List has none.
			§§
			§§ @param _ — the Numbers to compare
			§§ @returns — the highest Number, or nothing for the empty List.
			(_ numbers: List<Scalar>) -> Optional<Scalar> {
				constant start: Optional<Scalar> = #Empty

				<- numbers::reduce(startingWith start, (highest, number) {
					<- match highest -> Optional<Scalar> {
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

			§§ The highest of the Integers, with a value to answer for the empty List.
			§§
			§§ @param _ — the Integers to compare
			§§ @param defaultingTo — the value to answer with when there is no highest
			§§ @returns — the highest Integer, or the given value in its place.
			(
				_ integers: List<Integer>,
				defaultingTo fallback: Integer,
			) -> Integer {
				<- Number.highestNumber(integers)::value(defaultingTo fallback)
			}

			§§ The highest of the Rationals, with a value to answer for the empty List.
			§§
			§§ @param _ — the Rationals to compare
			§§ @param defaultingTo — the value to answer with when there is no highest
			§§ @returns — the highest Rational, or the given value in its place.
			(
				_ rationals: List<Rational>,
				defaultingTo fallback: Rational,
			) -> Rational {
				<- Number.highestNumber(rationals)::value(defaultingTo fallback)
			}

			§§ The highest of the Numbers, with a value to answer for the empty List.
			§§
			§§ @param _ — the Numbers to compare
			§§ @param defaultingTo — the value to answer with when there is no highest
			§§ @returns — the highest Number, or the given value in its place.
			(_ numbers: List<Scalar>, defaultingTo fallback: Scalar) -> Scalar {
				<- Number.highestNumber(numbers)::value(defaultingTo fallback)
			}

			§§ The highest of the Integers in a List proven to have an item.
			§§
			§§ The List has a highest item, so the answer is that item rather than an Optional.
			§§
			§§ @param _ — the Integers to compare
			§§ @returns — the highest Integer.
			(_ integers: NonEmptyList<Integer>) -> Integer {
				<- integers::reduce(
					startingWith integers::firstItem(),
					(highest, integer) {
						<- Number.highestNumber(highest, integer)
					},
				)
			}

			§§ The highest of the Rationals in a List proven to have an item.
			§§
			§§ The List has a highest item, so the answer is that item rather than an Optional.
			§§
			§§ @param _ — the Rationals to compare
			§§ @returns — the highest Rational.
			(_ rationals: NonEmptyList<Rational>) -> Rational {
				<- rationals::reduce(
					startingWith rationals::firstItem(),
					(highest, rational) {
						<- Number.highestNumber(highest, rational)
					},
				)
			}

			§§ The highest of the Numbers in a List proven to have an item.
			§§
			§§ The List has a highest item, so the answer is that item rather than an Optional.
			§§
			§§ @param _ — the Numbers to compare
			§§ @returns — the highest Number.
			(_ numbers: NonEmptyList<Scalar>) -> Scalar {
				<- numbers::reduce(
					startingWith numbers::firstItem(),
					(highest, number) {
						if highest::isGreaterThanOrEqualTo(number) {
							<- highest
						} else {
							<- number
						}
					},
				)
			}
		}

		§§ Answers whether the Number has the same numeric value as another Number.
		§§
		§§ An Integer and a Rational are the same Number when their values are equal, so `1 is 1/1` holds. The answer is read off `compare`. So two Transcendentals that both carry π and e can stop the Program at the precision cutoff `compare` names.
		§§
		§§ @param _ — the Number to compare against
		§§ @returns — `true` when both Numbers have the same numeric value.
		is(_ other: Number) -> Boolean {
			<- @::compare(to other)::is(#Equal)
		}

		§§ Orders the Number against another Number by numeric value, across every member of the tower.
		§§
		§§ Every pair is ordered exactly, with one exception. A Transcendental carrying both π and e is ordered against another Number by refining enclosures, and the refinement stops at 32768 decimal places. A pair that still agrees there stops the Program with an error, since deciding it exactly is an open problem. The bounded form is `Transcendental::compare(to:withPrecision:)`, which answers empty instead.
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
	Scalar
}
