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
	§ `Number.sum` and its four siblings stay the implementation. Every entry
	§ that answers an Optional calls one of them, and the `defaultingTo:` entry
	§ beside it collapses that answer. The narrowed Namespaces at the end call
	§ the same statics, whose proven entries answer a proven List bare.
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

	§ The same aggregates over a List of anything, reached through a key. The
	§ key reads a number off each item. `orders::sum(on .total)` is what this
	§ is for, and a member path is what makes it read that way.
	§
	§ It is a Namespace of its own rather than entries on the three above. The
	§ receiver here is any List at all: what has to be a number is what the key
	§ answers, not the item. Its target is therefore the widest one there is,
	§ and a `List<Integer>` reaches both. Such a List still resolves a bare
	§ `sum()` to `IntegerList`, because that entry is the only one the call's
	§ Arguments match. It reaches this Namespace for a keyed one, for the same
	§ reason.
	§
	§ `sum` keeps one entry per kind of key, so each answers the tightest Type
	§ it can. `average` needs no such split. It divides, so it answers a
	§ Rational whatever the key reads, and one entry over the widest key serves
	§ every one of them.
	namespace KeyedNumberList<infer ItemType> for List<ItemType> {
		§§ Adds together what the key reads off every item.
		§§
		§§ The empty List totals zero.
		§§
		§§ @returns — the total.
		overload sum {
			§§ Adds together the Integers the key reads off the items.
			§§
			§§ @param on — the key read off each item
			§§ @returns — the total.
			(on key: (_: ItemType) -> Integer) -> Integer {
				<- @::map(key)::sum()
			}

			§§ Adds together the Rationals the key reads off the items.
			§§
			§§ @param on — the key read off each item
			§§ @returns — the total.
			(on key: (_: ItemType) -> Rational) -> Rational {
				<- @::map(key)::sum()
			}

			§§ Adds together the Numbers the key reads off the items.
			§§
			§§ A whole total answers as an Integer, and a fractional one as a Rational.
			§§
			§§ @param on — the key read off each item
			§§ @returns — the total.
			(
				on key: (_: ItemType) -> Integer | Rational,
			) -> Integer | Rational {
				<- @::map(key)::sum()
			}
		}

		§§ The mean of what the key reads off every item: their total divided by their count.
		§§
		§§ The empty List has no mean, and the `defaultingTo:` entry answers the given Rational in place of nothing.
		overload average {
			§§ The mean of what the key reads off the items.
			§§
			§§ @param on — the key read off each item
			§§ @returns — the mean, or nothing for the empty List.
			(
				on key: (_: ItemType) -> Integer | Rational,
			) -> Optional<Rational> {
				<- @::map(key)::average()
			}

			§§ The mean of what the key reads off the items, or the given fallback for the empty List.
			§§
			§§ @param on — the key read off each item
			§§ @param defaultingTo — the mean to answer with when there is none
			§§ @returns — the mean, or the fallback in its place.
			(
				on key: (_: ItemType) -> Integer | Rational,
				defaultingTo fallback: Rational,
			) -> Rational {
				<- @::average(on key)::value(defaultingTo fallback)
			}
		}
	}

	§ A List with an item in it has a lowest item, a greatest item and a mean,
	§ so these three answer bare. Every other question the Namespaces above
	§ answer is already total, and is not repeated here. Each body is the
	§ delegation the general Namespaces write. The receiver carries its proof
	§ into the static, whose proven entry answers.
	namespace NonEmptyIntegerList for NonEmptyList<Integer> {
		§§ The lowest item, which a non-empty List always has.
		§§
		§§ @returns — the lowest item.
		lowestNumber() -> Integer {
			<- Number.lowestNumber(@)
		}

		§§ The greatest item, which a non-empty List always has.
		§§
		§§ @returns — the greatest item.
		greatestNumber() -> Integer {
			<- Number.greatestNumber(@)
		}

		§§ The mean of the items: their total divided by their count.
		§§
		§§ @returns — the mean.
		average() -> Rational {
			<- Number.average(@)
		}
	}

	namespace NonEmptyRationalList for NonEmptyList<Rational> {
		§§ The lowest item, which a non-empty List always has.
		§§
		§§ @returns — the lowest item.
		lowestNumber() -> Rational {
			<- Number.lowestNumber(@)
		}

		§§ The greatest item, which a non-empty List always has.
		§§
		§§ @returns — the greatest item.
		greatestNumber() -> Rational {
			<- Number.greatestNumber(@)
		}

		§§ The mean of the items: their total divided by their count.
		§§
		§§ @returns — the mean.
		average() -> Rational {
			<- Number.average(@)
		}
	}

	namespace NonEmptyNumberList for NonEmptyList<Integer | Rational> {
		§§ The lowest item, which a non-empty List always has.
		§§
		§§ @returns — the lowest item.
		lowestNumber() -> Integer | Rational {
			<- Number.lowestNumber(@)
		}

		§§ The greatest item, which a non-empty List always has.
		§§
		§§ @returns — the greatest item.
		greatestNumber() -> Integer | Rational {
			<- Number.greatestNumber(@)
		}

		§§ The mean of the items: their total divided by their count.
		§§
		§§ @returns — the mean.
		average() -> Rational {
			<- Number.average(@)
		}
	}
}

export {
	IntegerList
	KeyedNumberList
	NonEmptyIntegerList
	NonEmptyNumberList
	NonEmptyRationalList
	NumberList
	RationalList
}
