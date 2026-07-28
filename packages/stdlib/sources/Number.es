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

	§ The Union-level behaviour of `Number` — cross-member semantics only a
	§ covering Namespace can define. `is` is numeric equality (`1 is 1/1` is
	§ true), while the member Namespaces stay representational; Method target
	§ specificity routes single-member receivers to those, so these Methods
	§ only answer for Union-typed receivers and mixed-member Arguments.
	§
	§ `compare` hand-writes all sixteen member cells and keeps the
	§ Comparable conformance even though Transcendental alone does not
	§ conform: every cross-kind cell is total because equality across kinds
	§ is impossible by definition, and the only cell that could ever need a
	§ documented cutoff — Transcendental against Transcendental — is exact
	§ within the current linear-in-π grammar. The `isLessThan` family reads
	§ that same order, so it lives here for the same reason and is the one
	§ place two Transcendentals can be compared with a `<`.
	namespace Number for Number is Equatable, is Printable, is Comparable {
		§§ The ratio of a circle's circumference to its diameter, exactly.
		static PI: Transcendental

		§§ Twice `PI` — the ratio of a circle's circumference to its radius.
		static TAU: Transcendental

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

		§§ Whether this Number lies between the two given ones, both included — across every member of the numeric tower, so `Number.PI::isBetween(3, and 22/7)` holds. Bounds in the wrong order enclose no Number, so the answer is `false`.
		§§
		§§ @param lower — the lower bound, included
		§§ @param and — the upper bound, included
		§§ @returns — `true` when the Number is within the bounds.
		isBetween(_ lower: Number, and upper: Number) -> Boolean {
			<- @::isGreaterThanOrEqualTo(lower)
				::and(@::isLessThanOrEqualTo(upper))
		}

		§ The aggregates are folds over the members' own arithmetic. The
		§ mixed-kind entries dispatch each step by matching BOTH operands
		§ apart — a Union-typed receiver reaches no member Namespace's `add`,
		§ and the covering Namespace deliberately declares none — and collapse
		§ a whole-number total back to an Integer at the end, so a mixed List
		§ that happens to sum to a whole answers with the simpler member.

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

				constant total = numbers::reduce(startingWith start, (
					accumulated,
					number,
				) {
					<- match accumulated -> Integer | Rational {
						case Integer {
							constant accumulatedInteger = @

							<- match number -> Integer | Rational {
								case Integer  { <- accumulatedInteger::add(@) }

								case Rational { <- accumulatedInteger::add(@) }
							}
						}

						case Rational {
							constant accumulatedRational = @

							<- match number -> Integer | Rational {
								case Integer  { <- accumulatedRational::add(@) }

								case Rational { <- accumulatedRational::add(@) }
							}
						}
					}
				})

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

				constant total = numbers::reduce(startingWith start, (
					accumulated,
					number,
				) {
					<- match accumulated -> Integer | Rational {
						case Integer {
							constant accumulatedInteger = @

							<- match number -> Integer | Rational {
								case Integer  {
									<- accumulatedInteger::multiply(with @)
								}

								case Rational {
									<- accumulatedInteger::multiply(with @)
								}
							}
						}

						case Rational {
							constant accumulatedRational = @

							<- match number -> Integer | Rational {
								case Integer  {
									<- accumulatedRational::multiply(with @)
								}

								case Rational {
									<- accumulatedRational::multiply(with @)
								}
							}
						}
					}
				})

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
		§ `Nothing` the signature already answers with.

		§§ The arithmetic mean of the Numbers in the List — their sum divided by their count, as an exact Rational.
		§§
		§§ @returns — the mean, or `Nothing` for the empty List — no Numbers have no mean.
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
		}

		§§ The lower of two Numbers, or the lowest in a List of them.
		§§
		§§ @returns — the lowest Number — `Nothing` for the empty List, which has none.
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
			§ with `Nothing` so the first item becomes the running answer and
			§ the empty List keeps the seed. On a tie the pairwise entries
			§ answer the FIRST operand, so the earliest of equal items wins,
			§ exactly as walking the List reads. The mixed entry matches both
			§ operands apart to reach a pairwise entry, as the aggregates
			§ above do.

			(_ integers: List<Integer>) -> Optional<Integer> {
				constant start: Optional<Integer> = nothing

				<- integers::reduce(startingWith start, (lowest, integer) {
					<- match lowest -> Optional<Integer> {
						case Nothing { <- integer }

						case _       { <- Number.lowestNumber(@, integer) }
					}
				})
			}

			(_ rationals: List<Rational>) -> Optional<Rational> {
				constant start: Optional<Rational> = nothing

				<- rationals::reduce(startingWith start, (lowest, rational) {
					<- match lowest -> Optional<Rational> {
						case Nothing { <- rational }

						case _       { <- Number.lowestNumber(@, rational) }
					}
				})
			}

			(
				_ numbers: List<Integer | Rational>,
			) -> Optional<Integer | Rational> {
				constant start: Optional<Integer | Rational> = nothing

				<- numbers::reduce(startingWith start, (lowest, number) {
					<- match lowest -> Optional<Integer | Rational> {
						case Nothing { <- number }

						case Integer {
							constant lowestInteger = @

							<- match number -> Integer | Rational {
								case Integer  {
									<- Number.lowestNumber(lowestInteger, @)
								}

								case Rational {
									<- Number.lowestNumber(lowestInteger, @)
								}
							}
						}

						case Rational {
							constant lowestRational = @

							<- match number -> Integer | Rational {
								case Integer  {
									<- Number.lowestNumber(lowestRational, @)
								}

								case Rational {
									<- Number.lowestNumber(lowestRational, @)
								}
							}
						}
					}
				})
			}
		}

		§§ The greater of two Numbers, or the greatest in a List of them.
		§§
		§§ @returns — the greatest Number — `Nothing` for the empty List, which has none.
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
				constant start: Optional<Integer> = nothing

				<- integers::reduce(startingWith start, (greatest, integer) {
					<- match greatest -> Optional<Integer> {
						case Nothing { <- integer }

						case _       { <- Number.greatestNumber(@, integer) }
					}
				})
			}

			(_ rationals: List<Rational>) -> Optional<Rational> {
				constant start: Optional<Rational> = nothing

				<- rationals::reduce(startingWith start, (greatest, rational) {
					<- match greatest -> Optional<Rational> {
						case Nothing { <- rational }

						case _       { <- Number.greatestNumber(@, rational) }
					}
				})
			}

			(
				_ numbers: List<Integer | Rational>,
			) -> Optional<Integer | Rational> {
				constant start: Optional<Integer | Rational> = nothing

				<- numbers::reduce(startingWith start, (greatest, number) {
					<- match greatest -> Optional<Integer | Rational> {
						case Nothing { <- number }

						case Integer {
							constant greatestInteger = @

							<- match number -> Integer | Rational {
								case Integer  {
									<- Number.greatestNumber(greatestInteger, @)
								}

								case Rational {
									<- Number.greatestNumber(greatestInteger, @)
								}
							}
						}

						case Rational {
							constant greatestRational = @

							<- match number -> Integer | Rational {
								case Integer  {
									<- Number.greatestNumber(
										greatestRational,
										@,
									)
								}

								case Rational {
									<- Number.greatestNumber(
										greatestRational,
										@,
									)
								}
							}
						}
					}
				})
			}
		}
	}
}
