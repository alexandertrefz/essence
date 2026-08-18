import {
	Integer      from "./Integer.es"
	List         from "./List.es"
	NonEmptyList from "./List.es"
	Number       from "./Number.es"
	Optional     from "./Optional.es"
	Rational     from "./Rational.es"
}

declarations {

	§ The aggregates a List of Numbers can be asked for, reached from the List
	§ itself. `Number.sum` and its four siblings stay the implementation and
	§ every entry here delegates to one of them: a receiver-side spelling reads
	§ as the question a caller has — `readings::average()` rather than
	§ `Number.average(readings)` — and a static keeps the fold in one place.
	§
	§ Each item Type has a Namespace of its own, because a Namespace targets ONE
	§ Type: `List<Integer>`, `List<Rational>` and the mixed
	§ `List<Integer | Rational>` are three targets, and a receiver reaches the
	§ one its items decide. `["a", "b"]::lowestNumber()` matches none of them
	§ and is refused, which is the whole of what "the items have to be Numbers"
	§ means.

	§ The Integer List. `sum` and `product` answer an Integer, because adding
	§ and multiplying Integers can not leave them; `average` divides and so
	§ answers a Rational.
	namespace IntegerList for List<Integer> {
		§§ Adds every item together.
		§§
		§§ @returns — the total. The empty List totals zero.
		sum() -> Integer {
			<- Number.sum(@)
		}

		§§ Multiplies every item together.
		§§
		§§ @returns — the product. The empty List answers one.
		product() -> Integer {
			<- Number.product(@)
		}

		§§ The mean of the items — their total divided by how many there are.
		§§
		§§ @returns — the mean, or nothing for the empty List.
		overload average {
			§§ The mean of the items.
			§§
			§§ @returns — the mean, or nothing for the empty List.
			() -> Optional<Rational> {
				<- Number.average(@)
			}

			§§ The mean of the items, or the given fallback for the empty List.
			§§
			§§ @param defaultingTo — the mean to answer with when there is none
			§§ @returns — the mean, or the fallback in its place.
			(defaultingTo fallback: Rational) -> Rational {
				<- @::average()::value(defaultingTo fallback)
			}
		}

		§§ The lowest item.
		§§
		§§ @returns — the lowest item, or nothing for the empty List.
		overload lowestNumber {
			§§ The lowest item.
			§§
			§§ @returns — the lowest item, or nothing for the empty List.
			() -> Optional<Integer> {
				<- Number.lowestNumber(@)
			}

			§§ The lowest item, or the given fallback for the empty List.
			§§
			§§ @param defaultingTo — the item to answer with when there is none
			§§ @returns — the lowest item, or the fallback in its place.
			(defaultingTo fallback: Integer) -> Integer {
				<- @::lowestNumber()::value(defaultingTo fallback)
			}
		}

		§§ The greatest item.
		§§
		§§ @returns — the greatest item, or nothing for the empty List.
		overload greatestNumber {
			§§ The greatest item.
			§§
			§§ @returns — the greatest item, or nothing for the empty List.
			() -> Optional<Integer> {
				<- Number.greatestNumber(@)
			}

			§§ The greatest item, or the given fallback for the empty List.
			§§
			§§ @param defaultingTo — the item to answer with when there is none
			§§ @returns — the greatest item, or the fallback in its place.
			(defaultingTo fallback: Integer) -> Integer {
				<- @::greatestNumber()::value(defaultingTo fallback)
			}
		}
	}

	§ The Rational List. The same five questions, and `sum` and `product`
	§ answer a Rational here because Rational arithmetic stays exact.
	namespace RationalList for List<Rational> {
		§§ Adds every item together.
		§§
		§§ @returns — the total. The empty List totals zero.
		sum() -> Rational {
			<- Number.sum(@)
		}

		§§ Multiplies every item together.
		§§
		§§ @returns — the product. The empty List answers one.
		product() -> Rational {
			<- Number.product(@)
		}

		§§ The mean of the items — their total divided by how many there are.
		§§
		§§ @returns — the mean, or nothing for the empty List.
		overload average {
			§§ The mean of the items.
			§§
			§§ @returns — the mean, or nothing for the empty List.
			() -> Optional<Rational> {
				<- Number.average(@)
			}

			§§ The mean of the items, or the given fallback for the empty List.
			§§
			§§ @param defaultingTo — the mean to answer with when there is none
			§§ @returns — the mean, or the fallback in its place.
			(defaultingTo fallback: Rational) -> Rational {
				<- @::average()::value(defaultingTo fallback)
			}
		}

		§§ The lowest item.
		§§
		§§ @returns — the lowest item, or nothing for the empty List.
		overload lowestNumber {
			§§ The lowest item.
			§§
			§§ @returns — the lowest item, or nothing for the empty List.
			() -> Optional<Rational> {
				<- Number.lowestNumber(@)
			}

			§§ The lowest item, or the given fallback for the empty List.
			§§
			§§ @param defaultingTo — the item to answer with when there is none
			§§ @returns — the lowest item, or the fallback in its place.
			(defaultingTo fallback: Rational) -> Rational {
				<- @::lowestNumber()::value(defaultingTo fallback)
			}
		}

		§§ The greatest item.
		§§
		§§ @returns — the greatest item, or nothing for the empty List.
		overload greatestNumber {
			§§ The greatest item.
			§§
			§§ @returns — the greatest item, or nothing for the empty List.
			() -> Optional<Rational> {
				<- Number.greatestNumber(@)
			}

			§§ The greatest item, or the given fallback for the empty List.
			§§
			§§ @param defaultingTo — the item to answer with when there is none
			§§ @returns — the greatest item, or the fallback in its place.
			(defaultingTo fallback: Rational) -> Rational {
				<- @::greatestNumber()::value(defaultingTo fallback)
			}
		}
	}

	§ The mixed List. `sum` and `product` answer the Union, because what comes
	§ out depends on what went in: a whole Rational collapses to an Integer and
	§ a fractional one does not. `average` divides and so answers a Rational,
	§ as it does above.
	namespace NumberList for List<Integer | Rational> {
		§§ Adds every item together.
		§§
		§§ @returns — the total. The empty List totals zero.
		sum() -> Integer | Rational {
			<- Number.sum(@)
		}

		§§ Multiplies every item together.
		§§
		§§ @returns — the product. The empty List answers one.
		product() -> Integer | Rational {
			<- Number.product(@)
		}

		§§ The mean of the items — their total divided by how many there are.
		§§
		§§ @returns — the mean, or nothing for the empty List.
		overload average {
			§§ The mean of the items.
			§§
			§§ @returns — the mean, or nothing for the empty List.
			() -> Optional<Rational> {
				<- Number.average(@)
			}

			§§ The mean of the items, or the given fallback for the empty List.
			§§
			§§ @param defaultingTo — the mean to answer with when there is none
			§§ @returns — the mean, or the fallback in its place.
			(defaultingTo fallback: Rational) -> Rational {
				<- @::average()::value(defaultingTo fallback)
			}
		}

		§§ The lowest item.
		§§
		§§ @returns — the lowest item, or nothing for the empty List.
		overload lowestNumber {
			§§ The lowest item.
			§§
			§§ @returns — the lowest item, or nothing for the empty List.
			() -> Optional<Integer | Rational> {
				<- Number.lowestNumber(@)
			}

			§§ The lowest item, or the given fallback for the empty List.
			§§
			§§ @param defaultingTo — the item to answer with when there is none
			§§ @returns — the lowest item, or the fallback in its place.
			(defaultingTo fallback: Integer | Rational) -> Integer | Rational {
				<- @::lowestNumber()::value(defaultingTo fallback)
			}
		}

		§§ The greatest item.
		§§
		§§ @returns — the greatest item, or nothing for the empty List.
		overload greatestNumber {
			§§ The greatest item.
			§§
			§§ @returns — the greatest item, or nothing for the empty List.
			() -> Optional<Integer | Rational> {
				<- Number.greatestNumber(@)
			}

			§§ The greatest item, or the given fallback for the empty List.
			§§
			§§ @param defaultingTo — the item to answer with when there is none
			§§ @returns — the greatest item, or the fallback in its place.
			(defaultingTo fallback: Integer | Rational) -> Integer | Rational {
				<- @::greatestNumber()::value(defaultingTo fallback)
			}
		}
	}

	§ The three Namespaces the proof changes. A List with something in it has a
	§ lowest item, a greatest item and a mean, so there is no case left over for
	§ an Optional to stand for and each of these answers bare. Everything else
	§ the base Namespaces above answer is already total, so nothing else is
	§ written here.
	§
	§ Each is written on the very entry it narrows: the Optional is asked for
	§ and then collapsed against a value the receiver certainly holds, so the
	§ fallback is not a value the caller has to invent. `firstItem` is that
	§ value, and it costs the proof nothing.
	namespace NonEmptyIntegerList for NonEmptyList<Integer> {
		§§ The lowest item, which there certainly is one of.
		§§
		§§ @returns — the lowest item.
		lowestNumber() -> Integer {
			<- Number.lowestNumber(@)::value(defaultingTo @::firstItem())
		}

		§§ The greatest item, which there certainly is one of.
		§§
		§§ @returns — the greatest item.
		greatestNumber() -> Integer {
			<- Number.greatestNumber(@)::value(defaultingTo @::firstItem())
		}

		§§ The mean of the items — their total divided by how many there are.
		§§
		§§ @returns — the mean.
		average() -> Rational {
			§ The count is a NonZeroInteger, which is the divisor `divide` can
			§ not answer empty for, so the quotient itself is the answer.
			<- Number.sum(@)::divide(by @::length())
		}
	}

	namespace NonEmptyRationalList for NonEmptyList<Rational> {
		§§ The lowest item, which there certainly is one of.
		§§
		§§ @returns — the lowest item.
		lowestNumber() -> Rational {
			<- Number.lowestNumber(@)::value(defaultingTo @::firstItem())
		}

		§§ The greatest item, which there certainly is one of.
		§§
		§§ @returns — the greatest item.
		greatestNumber() -> Rational {
			<- Number.greatestNumber(@)::value(defaultingTo @::firstItem())
		}

		§§ The mean of the items — their total divided by how many there are.
		§§
		§§ @returns — the mean.
		average() -> Rational {
			§ `Rational::divide` has no NonZeroInteger entry to reach, so the
			§ division is written as a multiplication by the count's reciprocal
			§ — `Rational.of` over a NonZeroInteger is total, and so is the
			§ product. Dividing by the count outright would answer an Optional
			§ the proof was gathered to remove.
			<- Number.sum(@)::multiply(with Rational.of(1, over @::length()))
		}
	}

	namespace NonEmptyNumberList for NonEmptyList<Integer | Rational> {
		§§ The lowest item, which there certainly is one of.
		§§
		§§ @returns — the lowest item.
		lowestNumber() -> Integer | Rational {
			<- Number.lowestNumber(@)::value(defaultingTo @::firstItem())
		}

		§§ The greatest item, which there certainly is one of.
		§§
		§§ @returns — the greatest item.
		greatestNumber() -> Integer | Rational {
			<- Number.greatestNumber(@)::value(defaultingTo @::firstItem())
		}

		§§ The mean of the items — their total divided by how many there are.
		§§
		§§ @returns — the mean.
		average() -> Rational {
			§ The total is an `Integer | Rational`, and each arm divides by the
			§ NonZeroInteger count the way its own Namespace can: the Integer
			§ through `divide`, which is total over a proven divisor, and the
			§ Rational through the reciprocal, which is total for the same
			§ reason. The count is bound first, because `@` is rebound inside
			§ `match`.
			constant count = @::length()

			<- match Number.sum(@) -> Rational {
				case Integer  { <- @::divide(by count) }

				case Rational {
					<- @::multiply(with Rational.of(1, over count))
				}
			}
		}
	}
}

export {
	IntegerList
	NonEmptyIntegerList
	NonEmptyNumberList
	NonEmptyRationalList
	NumberList
	RationalList
}
