import {
	from "./Algebraic.es" { Algebraic }
	from "./Integer.es" { Integer }
	from "./List.es" {
		List
		NonEmptyList
	}
	from "./Number.es" {
		Number
		Scalar
	}
	from "./Optional.es" { Optional }
	from "./Orderable.es" { Orderable }
	from "./Rational.es" {
		NonNegativeRational
		Rational
		Rounding
	}
}

declarations {

	§ The aggregates a List of Numbers answers, reached from the List itself.
	§ `Number.sum` and its four siblings stay the implementation. Every entry
	§ that answers an Optional calls one of them, and the `defaultingTo:` entry
	§ beside it collapses that answer. The narrowed Namespaces at the end call
	§ the same statics, whose proven entries answer a proven List bare.
	§
	§ A Namespace targets one Type, so `List<Integer>`, `List<Rational>` and
	§ `List<Scalar>` each need their own, and a receiver reaches the one its
	§ items decide. A List of Strings matches none of them, and
	§ `["a", "b"]::lowestNumber()` is refused.

	§ `sum` and `product` answer an Integer, because the sum and the product
	§ of Integers are Integers. `average` divides, so it answers a Rational.
	namespace IntegerList for List<Integer> {
		§§ Adds every item together.
		§§
		§§ The empty List totals zero.
		§§
		§§ @example
		§§   constant empty: List<Integer> = []
		§§
		§§   expect [3, 5, 2]::sum()::is(10)
		§§   expect empty::sum()::is(0)
		§§
		§§ @returns — the total.
		sum() -> Integer {
			<- Number.sum(@)
		}

		§§ Multiplies every item together.
		§§
		§§ The empty List answers one.
		§§
		§§ @example
		§§   constant empty: List<Integer> = []
		§§
		§§   expect [2, 3, 4]::product()::is(24)
		§§   expect empty::product()::is(1)
		§§
		§§ @returns — the product.
		product() -> Integer {
			<- Number.product(@)
		}

		§ The running form of `sum`, written on `List::accumulate` with the
		§ zero of the kind and the items' own `add`. The proof carries. The
		§ answer opens with that zero before any item is seen, so a running
		§ total is never empty. These three entries answer bare where
		§ `average` and the extrema answer an Optional. The note on
		§ `List::accumulate` says why a fold written here could not promise
		§ that.
		§
		§ The NonEmpty Namespaces below add no twin, for the reason given
		§ there: this question is already total.

		§§ Every total the items build, one after another.
		§§
		§§ The answer opens with zero and holds one total for every item after it. So it is one longer than the List, and it is never empty. The last total is what `sum` answers.
		§§
		§§ @example
		§§   constant empty: List<Integer> = []
		§§
		§§   expect [3, 5, 2]::runningTotal()::is([0, 3, 8, 10])
		§§   expect empty::runningTotal()::is([0])
		§§
		§§ @returns — the List of totals, which is never empty.
		runningTotal() -> NonEmptyList<Integer> {
			<- @::accumulate(startingWith 0, (total, item) {
				<- total::add(item)
			})
		}

		§§ The mean of the items: their total divided by their count.
		§§
		§§ The empty List has no mean, and the `defaultingTo:` entry answers the given Rational in place of nothing.
		overload average {
			§§ The mean of the items.
			§§
			§§ @example
			§§   constant scores: List<Integer> = [1, 2, 3, 4]
			§§   constant empty: List<Integer>  = []
			§§
			§§   expect scores::average()::is(5/2)
			§§   expect empty::average()::isEmpty()
			§§
			§§ @returns — the mean, or nothing for the empty List.
			() -> Optional<Rational> {
				<- Number.average(@)
			}

			§§ The mean of the items, or the given fallback for the empty List.
			§§
			§§ @example
			§§   constant scores: List<Integer> = [1, 2, 3, 4]
			§§   constant empty: List<Integer>  = []
			§§
			§§   expect scores::average(defaultingTo 0/1)::is(5/2)
			§§   expect empty::average(defaultingTo 0/1)::is(0/1)
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
			§§ @example
			§§   constant scores: List<Integer> = [7, 3, 9]
			§§   constant empty: List<Integer>  = []
			§§
			§§   expect scores::lowestNumber()::is(3)
			§§   expect empty::lowestNumber()::isEmpty()
			§§
			§§ @returns — the lowest item, or nothing for the empty List.
			() -> Optional<Integer> {
				<- Number.lowest(@)
			}

			§§ The lowest item, or the given fallback for the empty List.
			§§
			§§ @example
			§§   constant scores: List<Integer> = [7, 3, 9]
			§§   constant empty: List<Integer>  = []
			§§
			§§   expect scores::lowestNumber(defaultingTo 0)::is(3)
			§§   expect empty::lowestNumber(defaultingTo 0)::is(0)
			§§
			§§ @param defaultingTo — the item to answer with when there is none
			§§ @returns — the lowest item, or the fallback in its place.
			(defaultingTo fallback: Integer) -> Integer {
				<- @::lowestNumber()::value(defaultingTo fallback)
			}
		}

		§§ The highest item.
		§§
		§§ The empty List has no highest item, and the `defaultingTo:` entry answers the given item in place of nothing.
		overload highestNumber {
			§§ The highest item.
			§§
			§§ @example
			§§   constant scores: List<Integer> = [7, 3, 9]
			§§   constant empty: List<Integer>  = []
			§§
			§§   expect scores::highestNumber()::is(9)
			§§   expect empty::highestNumber()::isEmpty()
			§§
			§§ @returns — the highest item, or nothing for the empty List.
			() -> Optional<Integer> {
				<- Number.highest(@)
			}

			§§ The highest item, or the given fallback for the empty List.
			§§
			§§ @example
			§§   constant scores: List<Integer> = [7, 3, 9]
			§§   constant empty: List<Integer>  = []
			§§
			§§   expect scores::highestNumber(defaultingTo 0)::is(9)
			§§   expect empty::highestNumber(defaultingTo 0)::is(0)
			§§
			§§ @param defaultingTo — the item to answer with when there is none
			§§ @returns — the highest item, or the fallback in its place.
			(defaultingTo fallback: Integer) -> Integer {
				<- @::highestNumber()::value(defaultingTo fallback)
			}
		}

		§ The statistics beyond the mean. None of these is a `Number` static,
		§ and the five aggregates above are. A static only a List Method calls
		§ is a second spelling of it. The five have one because each is the
		§ fold its kind's own arithmetic is written on.
		§
		§ Each general entry asks `hasItems` and hands the proven receiver on.
		§ So every body is written once, in the proven Namespace at the end of
		§ the file. A receiver carrying the proof already reaches that entry
		§ without the `if`.
		§
		§ `variance` divides by the count rather than by one less than it. The
		§ items handed over are the whole population, and the answer is their
		§ variance. A sample estimate is a second name nobody has asked for.
		§
		§ `percentile` clamps its fraction between zero and one. The
		§ alternative was an empty answer outside that range. It reads at the
		§ call site as the empty List does, and nothing tells the two apart.
		§ Every List with an item in it has a lowest and a highest one.

		§§ The middle item, once the items are put in order.
		§§
		§§ A count that is even has two middle items, and the answer is their mean. The empty List has no median, and the `defaultingTo:` entry answers the given Rational in place of nothing.
		overload median {
			§§ The median of the items.
			§§
			§§ @example
			§§   constant scores: List<Integer> = [9, 1, 5]
			§§   constant empty: List<Integer>  = []
			§§
			§§   expect scores::median()::is(5/1)
			§§   expect empty::median()::isEmpty()
			§§
			§§ @returns — the median, or nothing for the empty List.
			() -> Optional<Rational> {
				if @::hasItems() {
					<- #Value(@::median())
				} else {
					<- #Empty
				}
			}

			§§ The median of the items, or the given fallback for the empty List.
			§§
			§§ @example
			§§   constant scores: List<Integer> = [9, 1, 5]
			§§   constant empty: List<Integer>  = []
			§§
			§§   expect scores::median(defaultingTo 0/1)::is(5/1)
			§§   expect empty::median(defaultingTo 0/1)::is(0/1)
			§§
			§§ @param defaultingTo — the median to answer with when there is none
			§§ @returns — the median, or the fallback in its place.
			(defaultingTo fallback: Rational) -> Rational {
				<- @::median()::value(defaultingTo fallback)
			}
		}

		§§ The value at the given position through the items, once they are put in order.
		§§
		§§ A position between two items answers the point between those items, in proportion. The fraction is clamped between zero and one. The empty List has no such value, and the `defaultingTo:` entry answers the given Rational in place of nothing.
		overload percentile {
			§§ The value at the given position through the items.
			§§
			§§ @example
			§§   constant scores: List<Integer> = [40, 10, 30, 20]
			§§   constant empty: List<Integer>  = []
			§§
			§§   expect scores::percentile(1/2)::is(25/1)
			§§   expect empty::percentile(1/2)::isEmpty()
			§§
			§§ @param _ — the position through the items, from zero to one
			§§ @returns — the value, or nothing for the empty List.
			(_ fraction: Rational) -> Optional<Rational> {
				if @::hasItems() {
					<- #Value(@::percentile(fraction))
				} else {
					<- #Empty
				}
			}

			§§ The value at the given position, or the given fallback for the empty List.
			§§
			§§ @example
			§§   constant scores: List<Integer> = [40, 10, 30, 20]
			§§   constant empty: List<Integer>  = []
			§§
			§§   expect scores::percentile(1/2, defaultingTo 0/1)::is(25/1)
			§§   expect empty::percentile(1/2, defaultingTo 0/1)::is(0/1)
			§§
			§§ @param _ — the position through the items, from zero to one
			§§ @param defaultingTo — the value to answer with when there is none
			§§ @returns — the value, or the fallback in its place.
			(
				_ fraction: Rational,
				defaultingTo fallback: Rational,
			) -> Rational {
				<- @::percentile(fraction)::value(defaultingTo fallback)
			}
		}

		§§ The item that occurs most often.
		§§
		§§ Items occurring equally often keep the earlier one, by where each first stands. The empty List has no such item, and the `defaultingTo:` entry answers the given item in place of nothing.
		overload mode {
			§§ The item that occurs most often.
			§§
			§§ @example
			§§   constant rolls: List<Integer> = [2, 6, 6, 3]
			§§   constant empty: List<Integer> = []
			§§
			§§   expect rolls::mode()::is(6)
			§§   expect empty::mode()::isEmpty()
			§§
			§§ @returns — the item, or nothing for the empty List.
			() -> Optional<Integer> {
				if @::hasItems() {
					<- #Value(@::mode())
				} else {
					<- #Empty
				}
			}

			§§ The item that occurs most often, or the given fallback for the empty List.
			§§
			§§ @example
			§§   constant rolls: List<Integer> = [2, 6, 6, 3]
			§§   constant empty: List<Integer> = []
			§§
			§§   expect rolls::mode(defaultingTo 0)::is(6)
			§§   expect empty::mode(defaultingTo 0)::is(0)
			§§
			§§ @param defaultingTo — the item to answer with when there is none
			§§ @returns — the item, or the fallback in its place.
			(defaultingTo fallback: Integer) -> Integer {
				<- @::mode()::value(defaultingTo fallback)
			}
		}

		§§ The mean of the squared distances from the mean.
		§§
		§§ The count divides, so the answer is the variance of the items as a whole population. The empty List has no variance, and the `defaultingTo:` entry answers the given Rational in place of nothing.
		overload variance {
			§§ The variance of the items.
			§§
			§§ @example
			§§   constant scores: List<Integer> = [1, 5]
			§§   constant empty: List<Integer>  = []
			§§
			§§   expect scores::variance()::is(4/1)
			§§   expect empty::variance()::isEmpty()
			§§
			§§ @returns — the variance, which is never negative, or nothing for the empty List.
			() -> Optional<NonNegativeRational> {
				if @::hasItems() {
					<- #Value(@::variance())
				} else {
					<- #Empty
				}
			}

			§§ The variance of the items, or the given fallback for the empty List.
			§§
			§§ @example
			§§   constant scores: List<Integer> = [1, 5]
			§§   constant empty: List<Integer>  = []
			§§
			§§   expect scores::variance(defaultingTo 0/1)::is(4/1)
			§§   expect empty::variance(defaultingTo 0/1)::is(0/1)
			§§
			§§ @param defaultingTo — the variance to answer with when there is none
			§§ @returns — the variance, or the fallback in its place.
			(
				defaultingTo fallback: NonNegativeRational,
			) -> NonNegativeRational {
				<- @::variance()::value(defaultingTo fallback)
			}
		}

		§§ The square root of the variance.
		§§
		§§ A variance that is a ratio of two perfect squares answers a Rational, and every other variance answers an exact Algebraic. The empty List has none, and the `defaultingTo:` entry answers the given value in place of nothing.
		overload standardDeviation {
			§§ The standard deviation of the items.
			§§
			§§ @example
			§§   constant scores: List<Integer> = [1, 5]
			§§   constant empty: List<Integer>  = []
			§§
			§§   expect scores::standardDeviation()::is(2/1)
			§§   expect empty::standardDeviation()::isEmpty()
			§§
			§§ @returns — the standard deviation, or nothing for the empty List.
			() -> Optional<Rational | Algebraic> {
				if @::hasItems() {
					<- #Value(@::standardDeviation())
				} else {
					<- #Empty
				}
			}

			§§ The standard deviation of the items, or the given fallback for the empty List.
			§§
			§§ @example
			§§   constant scores: List<Integer> = [1, 5]
			§§   constant empty: List<Integer>  = []
			§§
			§§   expect scores::standardDeviation(defaultingTo 0/1)::is(2/1)
			§§   expect empty::standardDeviation(defaultingTo 0/1)::is(0/1)
			§§
			§§ @param defaultingTo — the value to answer with when there is none
			§§ @returns — the standard deviation, or the fallback in its place.
			(
				defaultingTo fallback: Rational | Algebraic,
			) -> Rational | Algebraic {
				<- @::standardDeviation()::value(defaultingTo fallback)
			}
		}
	}

	namespace RationalList for List<Rational> {
		§§ Adds every item together.
		§§
		§§ The empty List totals zero.
		§§
		§§ @example
		§§   constant empty: List<Rational> = []
		§§
		§§   expect [1/2, 1/4, 1/4]::sum()::is(1/1)
		§§   expect empty::sum()::is(0/1)
		§§
		§§ @returns — the total.
		sum() -> Rational {
			<- Number.sum(@)
		}

		§§ Multiplies every item together.
		§§
		§§ The empty List answers one.
		§§
		§§ @example
		§§   constant empty: List<Rational> = []
		§§
		§§   expect [1/2, 2/3]::product()::is(1/3)
		§§   expect empty::product()::is(1/1)
		§§
		§§ @returns — the product.
		product() -> Rational {
			<- Number.product(@)
		}

		§§ Every total the items build, one after another.
		§§
		§§ The answer opens with zero and holds one total for every item after it. So it is one longer than the List, and it is never empty. The last total is what `sum` answers.
		§§
		§§ @example
		§§   constant empty: List<Rational> = []
		§§
		§§   expect [1/2, 1/4, 1/4]::runningTotal()::is([0/1, 1/2, 3/4, 1/1])
		§§   expect empty::runningTotal()::is([0/1])
		§§
		§§ @returns — the List of totals, which is never empty.
		runningTotal() -> NonEmptyList<Rational> {
			<- @::accumulate(startingWith 0/1, (total, item) {
				<- total::add(item)
			})
		}

		§§ The mean of the items: their total divided by their count.
		§§
		§§ The empty List has no mean, and the `defaultingTo:` entry answers the given Rational in place of nothing.
		overload average {
			§§ The mean of the items.
			§§
			§§ @example
			§§   constant weights: List<Rational> = [1/2, 3/2]
			§§   constant empty: List<Rational>   = []
			§§
			§§   expect weights::average()::is(1/1)
			§§   expect empty::average()::isEmpty()
			§§
			§§ @returns — the mean, or nothing for the empty List.
			() -> Optional<Rational> {
				<- Number.average(@)
			}

			§§ The mean of the items, or the given fallback for the empty List.
			§§
			§§ @example
			§§   constant weights: List<Rational> = [1/2, 3/2]
			§§   constant empty: List<Rational>   = []
			§§
			§§   expect weights::average(defaultingTo 0/1)::is(1/1)
			§§   expect empty::average(defaultingTo 0/1)::is(0/1)
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
			§§ @example
			§§   constant weights: List<Rational> = [3/4, 1/2, 5/4]
			§§   constant empty: List<Rational>   = []
			§§
			§§   expect weights::lowestNumber()::is(1/2)
			§§   expect empty::lowestNumber()::isEmpty()
			§§
			§§ @returns — the lowest item, or nothing for the empty List.
			() -> Optional<Rational> {
				<- Number.lowest(@)
			}

			§§ The lowest item, or the given fallback for the empty List.
			§§
			§§ @example
			§§   constant weights: List<Rational> = [3/4, 1/2, 5/4]
			§§   constant empty: List<Rational>   = []
			§§
			§§   expect weights::lowestNumber(defaultingTo 0/1)::is(1/2)
			§§   expect empty::lowestNumber(defaultingTo 0/1)::is(0/1)
			§§
			§§ @param defaultingTo — the item to answer with when there is none
			§§ @returns — the lowest item, or the fallback in its place.
			(defaultingTo fallback: Rational) -> Rational {
				<- @::lowestNumber()::value(defaultingTo fallback)
			}
		}

		§§ The highest item.
		§§
		§§ The empty List has no highest item, and the `defaultingTo:` entry answers the given item in place of nothing.
		overload highestNumber {
			§§ The highest item.
			§§
			§§ @example
			§§   constant weights: List<Rational> = [3/4, 1/2, 5/4]
			§§   constant empty: List<Rational>   = []
			§§
			§§   expect weights::highestNumber()::is(5/4)
			§§   expect empty::highestNumber()::isEmpty()
			§§
			§§ @returns — the highest item, or nothing for the empty List.
			() -> Optional<Rational> {
				<- Number.highest(@)
			}

			§§ The highest item, or the given fallback for the empty List.
			§§
			§§ @example
			§§   constant weights: List<Rational> = [3/4, 1/2, 5/4]
			§§   constant empty: List<Rational>   = []
			§§
			§§   expect weights::highestNumber(defaultingTo 0/1)::is(5/4)
			§§   expect empty::highestNumber(defaultingTo 0/1)::is(0/1)
			§§
			§§ @param defaultingTo — the item to answer with when there is none
			§§ @returns — the highest item, or the fallback in its place.
			(defaultingTo fallback: Rational) -> Rational {
				<- @::highestNumber()::value(defaultingTo fallback)
			}
		}

		§§ The middle item, once the items are put in order.
		§§
		§§ A count that is even has two middle items, and the answer is their mean. The empty List has no median, and the `defaultingTo:` entry answers the given Rational in place of nothing.
		overload median {
			§§ The median of the items.
			§§
			§§ @example
			§§   constant weights: List<Rational> = [3/4, 1/4, 1/2]
			§§   constant empty: List<Rational>   = []
			§§
			§§   expect weights::median()::is(1/2)
			§§   expect empty::median()::isEmpty()
			§§
			§§ @returns — the median, or nothing for the empty List.
			() -> Optional<Rational> {
				if @::hasItems() {
					<- #Value(@::median())
				} else {
					<- #Empty
				}
			}

			§§ The median of the items, or the given fallback for the empty List.
			§§
			§§ @example
			§§   constant weights: List<Rational> = [3/4, 1/4, 1/2]
			§§   constant empty: List<Rational>   = []
			§§
			§§   expect weights::median(defaultingTo 0/1)::is(1/2)
			§§   expect empty::median(defaultingTo 0/1)::is(0/1)
			§§
			§§ @param defaultingTo — the median to answer with when there is none
			§§ @returns — the median, or the fallback in its place.
			(defaultingTo fallback: Rational) -> Rational {
				<- @::median()::value(defaultingTo fallback)
			}
		}

		§§ The value at the given position through the items, once they are put in order.
		§§
		§§ A position between two items answers the point between those items, in proportion. The fraction is clamped between zero and one. The empty List has no such value, and the `defaultingTo:` entry answers the given Rational in place of nothing.
		overload percentile {
			§§ The value at the given position through the items.
			§§
			§§ @example
			§§   constant weights: List<Rational> = [3/4, 1/4]
			§§   constant empty: List<Rational>   = []
			§§
			§§   expect weights::percentile(1/2)::is(1/2)
			§§   expect empty::percentile(1/2)::isEmpty()
			§§
			§§ @param _ — the position through the items, from zero to one
			§§ @returns — the value, or nothing for the empty List.
			(_ fraction: Rational) -> Optional<Rational> {
				if @::hasItems() {
					<- #Value(@::percentile(fraction))
				} else {
					<- #Empty
				}
			}

			§§ The value at the given position, or the given fallback for the empty List.
			§§
			§§ @example
			§§   constant weights: List<Rational> = [3/4, 1/4]
			§§   constant empty: List<Rational>   = []
			§§
			§§   expect weights::percentile(1/2, defaultingTo 0/1)::is(1/2)
			§§   expect empty::percentile(1/2, defaultingTo 0/1)::is(0/1)
			§§
			§§ @param _ — the position through the items, from zero to one
			§§ @param defaultingTo — the value to answer with when there is none
			§§ @returns — the value, or the fallback in its place.
			(
				_ fraction: Rational,
				defaultingTo fallback: Rational,
			) -> Rational {
				<- @::percentile(fraction)::value(defaultingTo fallback)
			}
		}

		§§ The item that occurs most often.
		§§
		§§ Items occurring equally often keep the earlier one, by where each first stands. The empty List has no such item, and the `defaultingTo:` entry answers the given item in place of nothing.
		overload mode {
			§§ The item that occurs most often.
			§§
			§§ @example
			§§   constant weights: List<Rational> = [1/2, 1/3, 1/2]
			§§   constant empty: List<Rational>   = []
			§§
			§§   expect weights::mode()::is(1/2)
			§§   expect empty::mode()::isEmpty()
			§§
			§§ @returns — the item, or nothing for the empty List.
			() -> Optional<Rational> {
				if @::hasItems() {
					<- #Value(@::mode())
				} else {
					<- #Empty
				}
			}

			§§ The item that occurs most often, or the given fallback for the empty List.
			§§
			§§ @example
			§§   constant weights: List<Rational> = [1/2, 1/3, 1/2]
			§§   constant empty: List<Rational>   = []
			§§
			§§   expect weights::mode(defaultingTo 0/1)::is(1/2)
			§§   expect empty::mode(defaultingTo 0/1)::is(0/1)
			§§
			§§ @param defaultingTo — the item to answer with when there is none
			§§ @returns — the item, or the fallback in its place.
			(defaultingTo fallback: Rational) -> Rational {
				<- @::mode()::value(defaultingTo fallback)
			}
		}

		§§ The mean of the squared distances from the mean.
		§§
		§§ The count divides, so the answer is the variance of the items as a whole population. The empty List has no variance, and the `defaultingTo:` entry answers the given Rational in place of nothing.
		overload variance {
			§§ The variance of the items.
			§§
			§§ @example
			§§   constant weights: List<Rational> = [1/2, 3/2]
			§§   constant empty: List<Rational>   = []
			§§
			§§   expect weights::variance()::is(1/4)
			§§   expect empty::variance()::isEmpty()
			§§
			§§ @returns — the variance, which is never negative, or nothing for the empty List.
			() -> Optional<NonNegativeRational> {
				if @::hasItems() {
					<- #Value(@::variance())
				} else {
					<- #Empty
				}
			}

			§§ The variance of the items, or the given fallback for the empty List.
			§§
			§§ @example
			§§   constant weights: List<Rational> = [1/2, 3/2]
			§§   constant empty: List<Rational>   = []
			§§
			§§   expect weights::variance(defaultingTo 0/1)::is(1/4)
			§§   expect empty::variance(defaultingTo 0/1)::is(0/1)
			§§
			§§ @param defaultingTo — the variance to answer with when there is none
			§§ @returns — the variance, or the fallback in its place.
			(
				defaultingTo fallback: NonNegativeRational,
			) -> NonNegativeRational {
				<- @::variance()::value(defaultingTo fallback)
			}
		}

		§§ The square root of the variance.
		§§
		§§ A variance that is a ratio of two perfect squares answers a Rational, and every other variance answers an exact Algebraic. The empty List has none, and the `defaultingTo:` entry answers the given value in place of nothing.
		overload standardDeviation {
			§§ The standard deviation of the items.
			§§
			§§ @example
			§§   constant weights: List<Rational> = [1/2, 3/2]
			§§   constant empty: List<Rational>   = []
			§§
			§§   expect weights::standardDeviation()::is(1/2)
			§§   expect empty::standardDeviation()::isEmpty()
			§§
			§§ @returns — the standard deviation, or nothing for the empty List.
			() -> Optional<Rational | Algebraic> {
				if @::hasItems() {
					<- #Value(@::standardDeviation())
				} else {
					<- #Empty
				}
			}

			§§ The standard deviation of the items, or the given fallback for the empty List.
			§§
			§§ @example
			§§   constant weights: List<Rational> = [1/2, 3/2]
			§§   constant empty: List<Rational>   = []
			§§
			§§   expect weights::standardDeviation(defaultingTo 0/1)::is(1/2)
			§§   expect empty::standardDeviation(defaultingTo 0/1)::is(0/1)
			§§
			§§ @param defaultingTo — the value to answer with when there is none
			§§ @returns — the standard deviation, or the fallback in its place.
			(
				defaultingTo fallback: Rational | Algebraic,
			) -> Rational | Algebraic {
				<- @::standardDeviation()::value(defaultingTo fallback)
			}
		}
	}

	namespace NumberList for List<Scalar> {
		§§ Adds every item together.
		§§
		§§ The empty List totals zero. A whole total answers as an Integer, and a fractional one as a Rational.
		§§
		§§ @example
		§§   constant empty: List<Scalar> = []
		§§
		§§   expect [1, 1/2, 1/2]::sum()::is(2)
		§§   expect [1, 1/2]::sum()::is(3/2)
		§§   expect empty::sum()::is(0)
		§§
		§§ @returns — the total.
		sum() -> Scalar {
			<- Number.sum(@)
		}

		§§ Multiplies every item together.
		§§
		§§ The empty List answers one. A whole product answers as an Integer, and a fractional one as a Rational.
		§§
		§§ @example
		§§   constant empty: List<Scalar> = []
		§§
		§§   expect [4, 1/2]::product()::is(2)
		§§   expect [3, 1/2]::product()::is(3/2)
		§§   expect empty::product()::is(1)
		§§
		§§ @returns — the product.
		product() -> Scalar {
			<- Number.product(@)
		}

		§ Each total is left as `Scalar::add` built it. The mixed `sum`
		§ collapses a whole Rational to an Integer once the fold is over.
		§ Collapsing every total takes a second walk. It carries
		§ `Number.sum`'s match arm a second time. Five passes over 200,000
		§ mixed items measured 176 ms without that walk and 195 ms with it. A
		§ whole Rational prints and compares as the Integer it equals, so what
		§ the walk buys is the tag a `match` reads.

		§§ Every total the items build, one after another.
		§§
		§§ The answer opens with zero and holds one total for every item after it. So it is one longer than the List, and it is never empty. A total stays a Rational once a Rational has been added to it, where `sum` collapses a whole total to an Integer.
		§§
		§§ @example
		§§   constant empty: List<Scalar> = []
		§§
		§§   expect [1, 1/2, 1/2]::runningTotal()::is([0, 1, 3/2, 2])
		§§   expect empty::runningTotal()::is([0])
		§§
		§§ @returns — the List of totals, which is never empty.
		runningTotal() -> NonEmptyList<Scalar> {
			constant start: Scalar = 0

			<- @::accumulate(startingWith start, (total, item) {
				<- total::add(item)
			})
		}

		§§ The mean of the items: their total divided by their count.
		§§
		§§ The empty List has no mean, and the `defaultingTo:` entry answers the given Rational in place of nothing.
		overload average {
			§§ The mean of the items.
			§§
			§§ @example
			§§   constant amounts: List<Scalar> = [1, 1/2]
			§§   constant empty: List<Scalar>   = []
			§§
			§§   expect amounts::average()::is(3/4)
			§§   expect empty::average()::isEmpty()
			§§
			§§ @returns — the mean, or nothing for the empty List.
			() -> Optional<Rational> {
				<- Number.average(@)
			}

			§§ The mean of the items, or the given fallback for the empty List.
			§§
			§§ @example
			§§   constant amounts: List<Scalar> = [1, 1/2]
			§§   constant empty: List<Scalar>   = []
			§§
			§§   expect amounts::average(defaultingTo 0/1)::is(3/4)
			§§   expect empty::average(defaultingTo 0/1)::is(0/1)
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
			§§ @example
			§§   constant amounts: List<Scalar> = [2, 1/2, 1]
			§§   constant empty: List<Scalar>   = []
			§§
			§§   expect amounts::lowestNumber()::is(1/2)
			§§   expect empty::lowestNumber()::isEmpty()
			§§
			§§ @returns — the lowest item, or nothing for the empty List.
			() -> Optional<Scalar> {
				<- Number.lowest(@)
			}

			§§ The lowest item, or the given fallback for the empty List.
			§§
			§§ @example
			§§   constant amounts: List<Scalar> = [2, 1/2, 1]
			§§   constant empty: List<Scalar>   = []
			§§
			§§   expect amounts::lowestNumber(defaultingTo 0)::is(1/2)
			§§   expect empty::lowestNumber(defaultingTo 0)::is(0)
			§§
			§§ @param defaultingTo — the item to answer with when there is none
			§§ @returns — the lowest item, or the fallback in its place.
			(defaultingTo fallback: Scalar) -> Scalar {
				<- @::lowestNumber()::value(defaultingTo fallback)
			}
		}

		§§ The highest item.
		§§
		§§ The empty List has no highest item, and the `defaultingTo:` entry answers the given item in place of nothing.
		overload highestNumber {
			§§ The highest item.
			§§
			§§ @example
			§§   constant amounts: List<Scalar> = [2, 1/2, 1]
			§§   constant empty: List<Scalar>   = []
			§§
			§§   expect amounts::highestNumber()::is(2)
			§§   expect empty::highestNumber()::isEmpty()
			§§
			§§ @returns — the highest item, or nothing for the empty List.
			() -> Optional<Scalar> {
				<- Number.highest(@)
			}

			§§ The highest item, or the given fallback for the empty List.
			§§
			§§ @example
			§§   constant amounts: List<Scalar> = [2, 1/2, 1]
			§§   constant empty: List<Scalar>   = []
			§§
			§§   expect amounts::highestNumber(defaultingTo 0)::is(2)
			§§   expect empty::highestNumber(defaultingTo 0)::is(0)
			§§
			§§ @param defaultingTo — the item to answer with when there is none
			§§ @returns — the highest item, or the fallback in its place.
			(defaultingTo fallback: Scalar) -> Scalar {
				<- @::highestNumber()::value(defaultingTo fallback)
			}
		}

		§§ The middle item, once the items are put in order.
		§§
		§§ A count that is even has two middle items, and the answer is their mean. The empty List has no median, and the `defaultingTo:` entry answers the given Rational in place of nothing.
		overload median {
			§§ The median of the items.
			§§
			§§ @example
			§§   constant amounts: List<Scalar> = [2, 1/2, 1]
			§§   constant empty: List<Scalar>   = []
			§§
			§§   expect amounts::median()::is(1/1)
			§§   expect empty::median()::isEmpty()
			§§
			§§ @returns — the median, or nothing for the empty List.
			() -> Optional<Rational> {
				if @::hasItems() {
					<- #Value(@::median())
				} else {
					<- #Empty
				}
			}

			§§ The median of the items, or the given fallback for the empty List.
			§§
			§§ @example
			§§   constant amounts: List<Scalar> = [2, 1/2, 1]
			§§   constant empty: List<Scalar>   = []
			§§
			§§   expect amounts::median(defaultingTo 0/1)::is(1/1)
			§§   expect empty::median(defaultingTo 0/1)::is(0/1)
			§§
			§§ @param defaultingTo — the median to answer with when there is none
			§§ @returns — the median, or the fallback in its place.
			(defaultingTo fallback: Rational) -> Rational {
				<- @::median()::value(defaultingTo fallback)
			}
		}

		§§ The value at the given position through the items, once they are put in order.
		§§
		§§ A position between two items answers the point between those items, in proportion. The fraction is clamped between zero and one. The empty List has no such value, and the `defaultingTo:` entry answers the given Rational in place of nothing.
		overload percentile {
			§§ The value at the given position through the items.
			§§
			§§ @example
			§§   constant amounts: List<Scalar> = [1, 1/2]
			§§   constant empty: List<Scalar>   = []
			§§
			§§   expect amounts::percentile(1/2)::is(3/4)
			§§   expect empty::percentile(1/2)::isEmpty()
			§§
			§§ @param _ — the position through the items, from zero to one
			§§ @returns — the value, or nothing for the empty List.
			(_ fraction: Rational) -> Optional<Rational> {
				if @::hasItems() {
					<- #Value(@::percentile(fraction))
				} else {
					<- #Empty
				}
			}

			§§ The value at the given position, or the given fallback for the empty List.
			§§
			§§ @example
			§§   constant amounts: List<Scalar> = [1, 1/2]
			§§   constant empty: List<Scalar>   = []
			§§
			§§   expect amounts::percentile(1/2, defaultingTo 0/1)::is(3/4)
			§§   expect empty::percentile(1/2, defaultingTo 0/1)::is(0/1)
			§§
			§§ @param _ — the position through the items, from zero to one
			§§ @param defaultingTo — the value to answer with when there is none
			§§ @returns — the value, or the fallback in its place.
			(
				_ fraction: Rational,
				defaultingTo fallback: Rational,
			) -> Rational {
				<- @::percentile(fraction)::value(defaultingTo fallback)
			}
		}

		§§ The item that occurs most often.
		§§
		§§ Items occurring equally often keep the earlier one, by where each first stands. The empty List has no such item, and the `defaultingTo:` entry answers the given item in place of nothing.
		overload mode {
			§§ The item that occurs most often.
			§§
			§§ @example
			§§   constant amounts: List<Scalar> = [1/2, 1, 1/2]
			§§   constant empty: List<Scalar>   = []
			§§
			§§   expect amounts::mode()::is(1/2)
			§§   expect empty::mode()::isEmpty()
			§§
			§§ @returns — the item, or nothing for the empty List.
			() -> Optional<Scalar> {
				if @::hasItems() {
					<- #Value(@::mode())
				} else {
					<- #Empty
				}
			}

			§§ The item that occurs most often, or the given fallback for the empty List.
			§§
			§§ @example
			§§   constant amounts: List<Scalar> = [1/2, 1, 1/2]
			§§   constant empty: List<Scalar>   = []
			§§
			§§   expect amounts::mode(defaultingTo 0)::is(1/2)
			§§   expect empty::mode(defaultingTo 0)::is(0)
			§§
			§§ @param defaultingTo — the item to answer with when there is none
			§§ @returns — the item, or the fallback in its place.
			(defaultingTo fallback: Scalar) -> Scalar {
				<- @::mode()::value(defaultingTo fallback)
			}
		}

		§§ The mean of the squared distances from the mean.
		§§
		§§ The count divides, so the answer is the variance of the items as a whole population. The empty List has no variance, and the `defaultingTo:` entry answers the given Rational in place of nothing.
		overload variance {
			§§ The variance of the items.
			§§
			§§ @example
			§§   constant amounts: List<Scalar> = [1, 1/2]
			§§   constant empty: List<Scalar>   = []
			§§
			§§   expect amounts::variance()::is(1/16)
			§§   expect empty::variance()::isEmpty()
			§§
			§§ @returns — the variance, which is never negative, or nothing for the empty List.
			() -> Optional<NonNegativeRational> {
				if @::hasItems() {
					<- #Value(@::variance())
				} else {
					<- #Empty
				}
			}

			§§ The variance of the items, or the given fallback for the empty List.
			§§
			§§ @example
			§§   constant amounts: List<Scalar> = [1, 1/2]
			§§   constant empty: List<Scalar>   = []
			§§
			§§   expect amounts::variance(defaultingTo 0/1)::is(1/16)
			§§   expect empty::variance(defaultingTo 0/1)::is(0/1)
			§§
			§§ @param defaultingTo — the variance to answer with when there is none
			§§ @returns — the variance, or the fallback in its place.
			(
				defaultingTo fallback: NonNegativeRational,
			) -> NonNegativeRational {
				<- @::variance()::value(defaultingTo fallback)
			}
		}

		§§ The square root of the variance.
		§§
		§§ A variance that is a ratio of two perfect squares answers a Rational, and every other variance answers an exact Algebraic. The empty List has none, and the `defaultingTo:` entry answers the given value in place of nothing.
		overload standardDeviation {
			§§ The standard deviation of the items.
			§§
			§§ @example
			§§   constant amounts: List<Scalar> = [1, 1/2]
			§§   constant empty: List<Scalar>   = []
			§§
			§§   expect amounts::standardDeviation()::is(1/4)
			§§   expect empty::standardDeviation()::isEmpty()
			§§
			§§ @returns — the standard deviation, or nothing for the empty List.
			() -> Optional<Rational | Algebraic> {
				if @::hasItems() {
					<- #Value(@::standardDeviation())
				} else {
					<- #Empty
				}
			}

			§§ The standard deviation of the items, or the given fallback for the empty List.
			§§
			§§ @example
			§§   constant amounts: List<Scalar> = [1, 1/2]
			§§   constant empty: List<Scalar>   = []
			§§
			§§   expect amounts::standardDeviation(defaultingTo 0/1)::is(1/4)
			§§   expect empty::standardDeviation(defaultingTo 0/1)::is(0/1)
			§§
			§§ @param defaultingTo — the value to answer with when there is none
			§§ @returns — the standard deviation, or the fallback in its place.
			(
				defaultingTo fallback: Rational | Algebraic,
			) -> Rational | Algebraic {
				<- @::standardDeviation()::value(defaultingTo fallback)
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
			§§ @example
			§§   constant orders = [{ total = 30 }, { total = 12 }]
			§§
			§§   expect orders::sum(on .total)::is(42)
			§§
			§§ @param on — the key read off each item
			§§ @returns — the total.
			(on key: (_: ItemType) -> Integer) -> Integer {
				<- @::map(key)::sum()
			}

			§§ Adds together the Rationals the key reads off the items.
			§§
			§§ @example
			§§   constant parcels = [{ weight = 1/2 }, { weight = 3/4 }]
			§§
			§§   expect parcels::sum(on .weight)::is(5/4)
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
			§§ @example
			§§   constant cells = ["3", "1/2", "1/2"]
			§§   constant total = cells::sum(on (text) {
			§§   	<- Number.parse(text, defaultingTo 0)
			§§   })
			§§
			§§   expect total::is(4)
			§§
			§§ @param on — the key read off each item
			§§ @returns — the total.
			(on key: (_: ItemType) -> Scalar) -> Scalar {
				<- @::map(key)::sum()
			}
		}

		§§ Multiplies together what the key reads off every item.
		§§
		§§ The empty List answers one.
		§§
		§§ @returns — the product.
		overload product {
			§§ Multiplies together the Integers the key reads off the items.
			§§
			§§ @example
			§§   constant dice = [{ sides = 6 }, { sides = 4 }]
			§§
			§§   expect dice::product(on .sides)::is(24)
			§§
			§§ @param on — the key read off each item
			§§ @returns — the product.
			(on key: (_: ItemType) -> Integer) -> Integer {
				<- @::map(key)::product()
			}

			§§ Multiplies together the Rationals the key reads off the items.
			§§
			§§ @example
			§§   constant steps = [{ chance = 1/2 }, { chance = 1/3 }]
			§§
			§§   expect steps::product(on .chance)::is(1/6)
			§§
			§§ @param on — the key read off each item
			§§ @returns — the product.
			(on key: (_: ItemType) -> Rational) -> Rational {
				<- @::map(key)::product()
			}

			§§ Multiplies together the Numbers the key reads off the items.
			§§
			§§ A whole product answers as an Integer, and a fractional one as a Rational.
			§§
			§§ @example
			§§   constant cells   = ["4", "1/2"]
			§§   constant product = cells::product(on (text) {
			§§   	<- Number.parse(text, defaultingTo 0)
			§§   })
			§§
			§§   expect product::is(2)
			§§
			§§ @param on — the key read off each item
			§§ @returns — the product.
			(on key: (_: ItemType) -> Scalar) -> Scalar {
				<- @::map(key)::product()
			}
		}

		§§ The mean of what the key reads off every item: their total divided by their count.
		§§
		§§ The empty List has no mean, and the `defaultingTo:` entry answers the given Rational in place of nothing.
		overload average {
			§§ The mean of what the key reads off the items.
			§§
			§§ @example
			§§   constant orders: List<{ total: Integer }> = [
			§§   	{ total = 30 },
			§§   	{ total = 12 },
			§§   ]
			§§   constant empty: List<{ total: Integer }>  = []
			§§
			§§   expect orders::average(on .total)::is(21/1)
			§§   expect empty::average(on .total)::isEmpty()
			§§
			§§ @param on — the key read off each item
			§§ @returns — the mean, or nothing for the empty List.
			(on key: (_: ItemType) -> Scalar) -> Optional<Rational> {
				<- @::map(key)::average()
			}

			§§ The mean of what the key reads off the items, or the given fallback for the empty List.
			§§
			§§ @example
			§§   constant orders: List<{ total: Integer }> = [
			§§   	{ total = 30 },
			§§   	{ total = 12 },
			§§   ]
			§§   constant empty: List<{ total: Integer }>  = []
			§§
			§§   expect orders::average(on .total, defaultingTo 0/1)::is(21/1)
			§§   expect empty::average(on .total, defaultingTo 0/1)::is(0/1)
			§§
			§§ @param on — the key read off each item
			§§ @param defaultingTo — the mean to answer with when there is none
			§§ @returns — the mean, or the fallback in its place.
			(
				on key: (_: ItemType) -> Scalar,
				defaultingTo fallback: Rational,
			) -> Rational {
				<- @::average(on key)::value(defaultingTo fallback)
			}
		}
	}

	§ A List with an item in it has a lowest item, a highest item and a mean,
	§ and the statistics beyond it. So every entry here answers bare. The
	§ general Namespaces' `sum`, `product` and `runningTotal` are total
	§ already, so they are not repeated here. The extrema and the mean
	§ delegate as the general Namespaces do, and the receiver carries its
	§ proof into the static, whose proven entry answers. The statistics are
	§ declared here, and the general entries hand their proven receiver on
	§ to them.
	namespace NonEmptyIntegerList for NonEmptyList<Integer> {
		§§ The lowest item, which a non-empty List always has.
		§§
		§§ @example
		§§   expect [7, 3, 9]::lowestNumber()::is(3)
		§§
		§§ @returns — the lowest item.
		lowestNumber() -> Integer {
			<- Number.lowest(@)
		}

		§§ The highest item, which a non-empty List always has.
		§§
		§§ @example
		§§   expect [7, 3, 9]::highestNumber()::is(9)
		§§
		§§ @returns — the highest item.
		highestNumber() -> Integer {
			<- Number.highest(@)
		}

		§§ The mean of the items: their total divided by their count.
		§§
		§§ @example
		§§   expect [1, 2, 3, 4]::average()::is(5/2)
		§§
		§§ @returns — the mean.
		average() -> Rational {
			<- Number.average(@)
		}

		§ The two middle positions are read rather than one, and an odd count
		§ names the same position twice. So one body serves both counts, and
		§ the mean of an item with itself is that item.
		§
		§ `item(at:)` answers an Optional for a position outside the List, and
		§ neither of these positions is outside it. The fallback is the first
		§ item, which the proof answers bare, and no call reaches it.

		§§ The middle item, once the items are put in order.
		§§
		§§ A count that is even has two middle items, and the answer is their mean.
		§§
		§§ @example
		§§   expect [9, 1, 5]::median()::is(5/1)
		§§   expect [4, 1, 3, 2]::median()::is(5/2)
		§§
		§§ @returns — the median.
		median() -> Rational {
			constant sorted = @::sort()
			constant count  = sorted::length()
			constant first  = sorted::firstItem()

			<- Number.average([
				sorted
					::item(at count::subtract(1)::quotient(dividingBy 2))
					::value(defaultingTo first),
				sorted
					::item(at count::quotient(dividingBy 2))
					::value(defaultingTo first),
			])
		}

		§ The rank is the fraction of the way from the first position to the
		§ last. A rank landing between two positions reads both items and
		§ answers the point between them, in proportion. The exact arithmetic
		§ makes that point exact.
		§
		§ The item above is read with the item below as its fallback, and a
		§ rank of exactly the last position is where that fallback answers.
		§ The distance is then zero, so the item below is the whole answer.

		§§ The value at the given position through the items, once they are put in order.
		§§
		§§ A position between two items answers the point between those items, in proportion. The fraction is clamped between zero and one.
		§§
		§§ @example
		§§   constant scores: NonEmptyList<Integer> = [40, 10, 30, 20]
		§§
		§§   expect scores::percentile(1/2)::is(25/1)
		§§   expect scores::percentile(2/1)::is(40/1)
		§§
		§§ @param _ — the position through the items, from zero to one
		§§ @returns — the value at that position.
		percentile(_ fraction: Rational) -> Rational {
			constant sorted = @::sort()
			constant first  = sorted::firstItem()
			constant rank   = fraction
				::clamp(between 0/1, and 1/1)
				::multiply(with sorted::length()::subtract(1))
			constant lower  = rank::round(toward Rounding#Down)
			constant offset = rank::subtract(lower)
			constant below  = sorted::item(at lower)::value(defaultingTo first)
			constant above  = sorted
				::item(at lower::add(1))
				::value(defaultingTo below)

			<- below::add(above::subtract(below)::multiply(with offset))
		}

		§ A native counting each item once, over the canonical key encoding
		§ the set-shaped List Methods rest on. A later item has to beat a
		§ count rather than meet it, so the earliest of the items that occur
		§ most often is the answer.
		§
		§ One alternative was `@::tally()::entries()::highestItem(on .value)`,
		§ which crosses to the Dictionary for a count a plain Map holds. A
		§ Program calling `mode` measured 20,560 bytes that way and measures
		§ 9,443. The other was a sort and a walk of the equal runs. That is
		§ free of the store too, and answers the lowest of the items that tie.

		§§ The item that occurs most often.
		§§
		§§ Items occurring equally often keep the earlier one, by where each first stands.
		§§
		§§ @example
		§§   expect [2, 6, 6, 3]::mode()::is(6)
		§§   expect [3, 1, 1, 3]::mode()::is(3)
		§§
		§§ @returns — the item that occurs most often.
		mode() -> Integer

		§ The mean of the squared distances, and `absolute` is what states
		§ that a mean of squares is never negative. No fold carries a proof
		§ through, so the Rational the mean answers has none. The alternative
		§ was a native over the items, which writes the exact arithmetic
		§ beside it a second time.

		§§ The mean of the squared distances from the mean.
		§§
		§§ The count divides, so the answer is the variance of the items as a whole population.
		§§
		§§ @example
		§§   expect [1, 5]::variance()::is(4/1)
		§§
		§§ @returns — the variance, which is never negative.
		variance() -> NonNegativeRational {
			constant mean = @::average()

			<- @::map((item) {
				constant distance = item::subtract(mean)

				<- distance::multiply(with distance)
			})
				::average()
				::absolute()
		}

		§§ The square root of the variance.
		§§
		§§ A variance that is a ratio of two perfect squares answers a Rational, and every other variance answers an exact Algebraic.
		§§
		§§ @example
		§§   expect [1, 5]::standardDeviation()::is(2/1)
		§§   expect [0, 2, 2, 4]::standardDeviation()::is(2::squareRoot())
		§§
		§§ @returns — the standard deviation.
		standardDeviation() -> Rational | Algebraic {
			<- @::variance()::squareRoot()
		}
	}

	namespace NonEmptyRationalList for NonEmptyList<Rational> {
		§§ The lowest item, which a non-empty List always has.
		§§
		§§ @example
		§§   expect [3/4, 1/2, 5/4]::lowestNumber()::is(1/2)
		§§
		§§ @returns — the lowest item.
		lowestNumber() -> Rational {
			<- Number.lowest(@)
		}

		§§ The highest item, which a non-empty List always has.
		§§
		§§ @example
		§§   expect [3/4, 1/2, 5/4]::highestNumber()::is(5/4)
		§§
		§§ @returns — the highest item.
		highestNumber() -> Rational {
			<- Number.highest(@)
		}

		§§ The mean of the items: their total divided by their count.
		§§
		§§ @example
		§§   expect [1/2, 3/2]::average()::is(1/1)
		§§
		§§ @returns — the mean.
		average() -> Rational {
			<- Number.average(@)
		}

		§§ The middle item, once the items are put in order.
		§§
		§§ A count that is even has two middle items, and the answer is their mean.
		§§
		§§ @example
		§§   expect [3/4, 1/4, 1/2]::median()::is(1/2)
		§§   expect [3/4, 1/4]::median()::is(1/2)
		§§
		§§ @returns — the median.
		median() -> Rational {
			constant sorted = @::sort()
			constant count  = sorted::length()
			constant first  = sorted::firstItem()

			<- Number.average([
				sorted
					::item(at count::subtract(1)::quotient(dividingBy 2))
					::value(defaultingTo first),
				sorted
					::item(at count::quotient(dividingBy 2))
					::value(defaultingTo first),
			])
		}

		§§ The value at the given position through the items, once they are put in order.
		§§
		§§ A position between two items answers the point between those items, in proportion. The fraction is clamped between zero and one.
		§§
		§§ @example
		§§   constant weights: NonEmptyList<Rational> = [3/4, 1/4]
		§§
		§§   expect weights::percentile(1/2)::is(1/2)
		§§   expect weights::percentile(2/1)::is(3/4)
		§§
		§§ @param _ — the position through the items, from zero to one
		§§ @returns — the value at that position.
		percentile(_ fraction: Rational) -> Rational {
			constant sorted = @::sort()
			constant first  = sorted::firstItem()
			constant rank   = fraction
				::clamp(between 0/1, and 1/1)
				::multiply(with sorted::length()::subtract(1))
			constant lower  = rank::round(toward Rounding#Down)
			constant offset = rank::subtract(lower)
			constant below  = sorted::item(at lower)::value(defaultingTo first)
			constant above  = sorted
				::item(at lower::add(1))
				::value(defaultingTo below)

			<- below::add(above::subtract(below)::multiply(with offset))
		}

		§§ The item that occurs most often.
		§§
		§§ Items occurring equally often keep the earlier one, by where each first stands.
		§§
		§§ @example
		§§   expect [1/2, 1/3, 1/2]::mode()::is(1/2)
		§§   expect [1/3, 1/2]::mode()::is(1/3)
		§§
		§§ @returns — the item that occurs most often.
		mode() -> Rational

		§§ The mean of the squared distances from the mean.
		§§
		§§ The count divides, so the answer is the variance of the items as a whole population.
		§§
		§§ @example
		§§   expect [1/2, 3/2]::variance()::is(1/4)
		§§
		§§ @returns — the variance, which is never negative.
		variance() -> NonNegativeRational {
			constant mean = @::average()

			<- @::map((item) {
				constant distance = item::subtract(mean)

				<- distance::multiply(with distance)
			})
				::average()
				::absolute()
		}

		§§ The square root of the variance.
		§§
		§§ A variance that is a ratio of two perfect squares answers a Rational, and every other variance answers an exact Algebraic.
		§§
		§§ @example
		§§   expect [1/2, 3/2]::standardDeviation()::is(1/2)
		§§
		§§ @returns — the standard deviation.
		standardDeviation() -> Rational | Algebraic {
			<- @::variance()::squareRoot()
		}
	}

	namespace NonEmptyNumberList for NonEmptyList<Scalar> {
		§§ The lowest item, which a non-empty List always has.
		§§
		§§ @example
		§§   expect [2, 1/2, 1]::lowestNumber()::is(1/2)
		§§
		§§ @returns — the lowest item.
		lowestNumber() -> Scalar {
			<- Number.lowest(@)
		}

		§§ The highest item, which a non-empty List always has.
		§§
		§§ @example
		§§   expect [2, 1/2, 1]::highestNumber()::is(2)
		§§
		§§ @returns — the highest item.
		highestNumber() -> Scalar {
			<- Number.highest(@)
		}

		§§ The mean of the items: their total divided by their count.
		§§
		§§ @example
		§§   expect [1, 1/2]::average()::is(3/4)
		§§
		§§ @returns — the mean.
		average() -> Rational {
			<- Number.average(@)
		}

		§§ The middle item, once the items are put in order.
		§§
		§§ A count that is even has two middle items, and the answer is their mean.
		§§
		§§ @example
		§§   expect [2, 1/2, 1]::median()::is(1/1)
		§§   expect [1, 1/2]::median()::is(3/4)
		§§
		§§ @returns — the median.
		median() -> Rational {
			constant sorted = @::sort()
			constant count  = sorted::length()
			constant first  = sorted::firstItem()

			<- Number.average([
				sorted
					::item(at count::subtract(1)::quotient(dividingBy 2))
					::value(defaultingTo first),
				sorted
					::item(at count::quotient(dividingBy 2))
					::value(defaultingTo first),
			])
		}

		§ Two of the five read the items as Rationals first. A difference of
		§ two Scalars has no entry at all. The Namespace `Scalar` holds the
		§ sum and the product alone, because those two are what the mixed
		§ aggregates fold on. So each body that subtracts hands the proven
		§ List to the Namespace above, whose items are one kind.

		§§ The value at the given position through the items, once they are put in order.
		§§
		§§ A position between two items answers the point between those items, in proportion. The fraction is clamped between zero and one.
		§§
		§§ @example
		§§   constant amounts: NonEmptyList<Scalar> = [1, 1/2]
		§§
		§§   expect amounts::percentile(1/2)::is(3/4)
		§§   expect amounts::percentile(2/1)::is(1/1)
		§§
		§§ @param _ — the position through the items, from zero to one
		§§ @returns — the value at that position.
		percentile(_ fraction: Rational) -> Rational {
			<- @::map((item) { <- item::toRational() })::percentile(fraction)
		}

		§§ The item that occurs most often.
		§§
		§§ Items occurring equally often keep the earlier one, by where each first stands.
		§§
		§§ @example
		§§   expect [1/2, 1, 1/2]::mode()::is(1/2)
		§§   expect [1, 1/2]::mode()::is(1)
		§§
		§§ @returns — the item that occurs most often.
		mode() -> Scalar

		§§ The mean of the squared distances from the mean.
		§§
		§§ The count divides, so the answer is the variance of the items as a whole population.
		§§
		§§ @example
		§§   expect [1, 1/2]::variance()::is(1/16)
		§§
		§§ @returns — the variance, which is never negative.
		variance() -> NonNegativeRational {
			<- @::map((item) { <- item::toRational() })::variance()
		}

		§§ The square root of the variance.
		§§
		§§ A variance that is a ratio of two perfect squares answers a Rational, and every other variance answers an exact Algebraic.
		§§
		§§ @example
		§§   expect [1, 1/2]::standardDeviation()::is(1/4)
		§§
		§§ @returns — the standard deviation.
		standardDeviation() -> Rational | Algebraic {
			<- @::variance()::squareRoot()
		}
	}

	§ The keyed mean of a List with an item in it. `sum(on:)` is already total
	§ and stays on `KeyedNumberList`, which a proven receiver reaches too. The
	§ refined target beats the base only for a Method both declare.
	§
	§ `NonEmptyList::map` carries the proof, and the mean of a proven List of
	§ Numbers is bare, so the body needs no fallback.
	namespace NonEmptyKeyedNumberList<infer ItemType>
		for NonEmptyList<ItemType>
	{
		§§ The mean of what the key reads off every item: their total divided by their count.
		§§
		§§ The List has an item, so the answer is the mean itself rather than an Optional.
		§§
		§§ @example
		§§   constant orders: NonEmptyList<{ total: Integer }> = [
		§§   	{ total = 30 },
		§§   	{ total = 12 },
		§§   ]
		§§
		§§   expect orders::average(on .total)::is(21/1)
		§§
		§§ @param on — the key read off each item
		§§ @returns — the mean.
		average(on key: (_: ItemType) -> Scalar) -> Rational {
			<- @::map(key)::average()
		}
	}
}

export {
	IntegerList
	KeyedNumberList
	NonEmptyIntegerList
	NonEmptyKeyedNumberList
	NonEmptyNumberList
	NonEmptyRationalList
	NumberList
	RationalList
}
