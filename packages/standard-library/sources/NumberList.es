import {
	Integer      from "./Integer.es"
	List         from "./List.es"
	NonEmptyList from "./List.es"
	Number       from "./Number.es"
	Optional     from "./Optional.es"
	Rational     from "./Rational.es"
}

declarations {

	§ The aggregates a List of Numbers answers, reached from the List itself.
	§ Every entry here delegates to `Number.sum` or one of its four
	§ siblings, which stay the implementation.
	§
	§ A Namespace targets one Type, so `List<Integer>`, `List<Rational>` and
	§ `List<Integer | Rational>` each need their own, and a receiver reaches
	§ the one its items decide. A List of Strings matches none of them, and
	§ `["a", "b"]::lowestNumber()` is refused.

	§ `sum` and `product` answer an Integer, because the sum and the product
	§ of Integers are Integers. `average` divides, so it answers a Rational.
	namespace IntegerList for List<Integer> {
		§§ Adds every item together.
		§§
		§§ The empty List totals zero.
		§§
		§§ @returns — the total.
		sum() -> Integer {
			<- Number.sum(@)
		}

		§§ Multiplies every item together.
		§§
		§§ The empty List answers one.
		§§
		§§ @returns — the product.
		product() -> Integer {
			<- Number.product(@)
		}

		§§ The mean of the items: their total divided by their count.
		§§
		§§ The empty List has no mean, and the `defaultingTo:` entry answers the given Rational in place of nothing.
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
		§§ The empty List has no lowest item, and the `defaultingTo:` entry answers the given item in place of nothing.
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
		§§ The empty List has no greatest item, and the `defaultingTo:` entry answers the given item in place of nothing.
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

	namespace RationalList for List<Rational> {
		§§ Adds every item together.
		§§
		§§ The empty List totals zero.
		§§
		§§ @returns — the total.
		sum() -> Rational {
			<- Number.sum(@)
		}

		§§ Multiplies every item together.
		§§
		§§ The empty List answers one.
		§§
		§§ @returns — the product.
		product() -> Rational {
			<- Number.product(@)
		}

		§§ The mean of the items: their total divided by their count.
		§§
		§§ The empty List has no mean, and the `defaultingTo:` entry answers the given Rational in place of nothing.
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
		§§ The empty List has no lowest item, and the `defaultingTo:` entry answers the given item in place of nothing.
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
		§§ The empty List has no greatest item, and the `defaultingTo:` entry answers the given item in place of nothing.
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

	namespace NumberList for List<Integer | Rational> {
		§§ Adds every item together.
		§§
		§§ The empty List totals zero. A whole total answers as an Integer, and a fractional one as a Rational.
		§§
		§§ @returns — the total.
		sum() -> Integer | Rational {
			<- Number.sum(@)
		}

		§§ Multiplies every item together.
		§§
		§§ The empty List answers one. A whole product answers as an Integer, and a fractional one as a Rational.
		§§
		§§ @returns — the product.
		product() -> Integer | Rational {
			<- Number.product(@)
		}

		§§ The mean of the items: their total divided by their count.
		§§
		§§ The empty List has no mean, and the `defaultingTo:` entry answers the given Rational in place of nothing.
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
		§§ The empty List has no lowest item, and the `defaultingTo:` entry answers the given item in place of nothing.
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
		§§ The empty List has no greatest item, and the `defaultingTo:` entry answers the given item in place of nothing.
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

	§ A List with an item in it has a lowest item, a greatest item and a mean,
	§ so these three answer bare. Every other question the Namespaces above
	§ answer is already total, and is not repeated here. Each body collapses
	§ the Optional against `firstItem()`, which the receiver certainly holds.
	namespace NonEmptyIntegerList for NonEmptyList<Integer> {
		§§ The lowest item, which a non-empty List always has.
		§§
		§§ @returns — the lowest item.
		lowestNumber() -> Integer {
			<- Number.lowestNumber(@)::value(defaultingTo @::firstItem())
		}

		§§ The greatest item, which a non-empty List always has.
		§§
		§§ @returns — the greatest item.
		greatestNumber() -> Integer {
			<- Number.greatestNumber(@)::value(defaultingTo @::firstItem())
		}

		§§ The mean of the items: their total divided by their count.
		§§
		§§ @returns — the mean.
		average() -> Rational {
			§ The count is a NonZeroInteger, and `divide` by one of those
			§ answers no Optional, so the quotient itself is the answer.
			<- Number.sum(@)::divide(by @::length())
		}
	}

	namespace NonEmptyRationalList for NonEmptyList<Rational> {
		§§ The lowest item, which a non-empty List always has.
		§§
		§§ @returns — the lowest item.
		lowestNumber() -> Rational {
			<- Number.lowestNumber(@)::value(defaultingTo @::firstItem())
		}

		§§ The greatest item, which a non-empty List always has.
		§§
		§§ @returns — the greatest item.
		greatestNumber() -> Rational {
			<- Number.greatestNumber(@)::value(defaultingTo @::firstItem())
		}

		§§ The mean of the items: their total divided by their count.
		§§
		§§ @returns — the mean.
		average() -> Rational {
			<- Number.sum(@)::divide(by @::length())
		}
	}

	namespace NonEmptyNumberList for NonEmptyList<Integer | Rational> {
		§§ The lowest item, which a non-empty List always has.
		§§
		§§ @returns — the lowest item.
		lowestNumber() -> Integer | Rational {
			<- Number.lowestNumber(@)::value(defaultingTo @::firstItem())
		}

		§§ The greatest item, which a non-empty List always has.
		§§
		§§ @returns — the greatest item.
		greatestNumber() -> Integer | Rational {
			<- Number.greatestNumber(@)::value(defaultingTo @::firstItem())
		}

		§§ The mean of the items: their total divided by their count.
		§§
		§§ @returns — the mean.
		average() -> Rational {
			§ Each arm divides by the NonZeroInteger count in its own
			§ Namespace, and both entries are total over a proven divisor. The
			§ count is bound above the `match`, because `@` is rebound inside
			§ one; see DEVELOPMENT.md, Why bodies look the way they do.
			constant count = @::length()

			<- match Number.sum(@) -> Rational {
				case Integer  { <- @::divide(by count) }

				case Rational { <- @::divide(by count) }
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
