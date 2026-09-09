import {
	from "./Boolean.es" { Boolean }
	from "./Comparable.es" { Comparable }
	from "./Integer.es" {
		Integer
		NonNegativeInteger
		NonZeroInteger
		PositiveInteger
	}
	from "./Optional.es" { Optional }
	from "./Ordering.es" { Ordering }
	from "./Protocols.es" {
		Equatable
		Printable
	}
	from "./Result.es" { Result }
	from "./Step.es" { Step }
	from "./String.es" { Side }
}

declarations {

	§ The Choice is declared beside its only user.

	§§ Which way `sort` runs: `#Ascending` from the lowest, or `#Descending` from the highest.
	§§
	§§ `#Ascending` is what a call that names no order gets. Descending is not a sort followed by a reverse. The comparison is turned around instead, so items the order does not tell apart keep the order they had.
	choice SortOrder {
		Ascending,
		Descending,
	}

	§ Equality and printing are both derived for a Choice of Cases that carry
	§ no payload. This Namespace declares the two and writes neither; see
	§ DEVELOPMENT.md, Why bodies look the way they do.
	namespace SortOrder for SortOrder is Equatable, is Printable {}

	§ The predicate asks nothing about the item Type, so one predicate serves
	§ every List and the Type Argument stays in the base.

	§§ A List proven to have an item in it, as a checked refinement of `List`.
	§§
	§§ The proof is what lets `firstItem` and `lastItem` answer an item rather than an Optional. A List written down with items in it carries the proof. A List a Program is handed earns it through an `if` asking `hasItems`.
	§§
	§§ `append(_:)`, `prepend(_:)` and `insert(_:at:)` each put something into what they were given, so each answers with this Type. The `of(integersFrom:downTo:)` entry answers it too, because a count down always answers its first value.
	type NonEmptyList<ItemType> = List<ItemType> where @::hasItems()

	§ The ordered sequence, and everything that reads or rebuilds one. Every
	§ Method here is a Query: a List is never changed in place, and a new List
	§ is answered.
	§
	§ `ItemType` is the Namespace's own Type Parameter, and it merges into a
	§ signature that mentions it. `of` fixes its Types outright, so it carries
	§ nothing. A bounded Method declares an `ItemType` of its own, which shadows
	§ the Namespace's.
	§
	§ Every conformance here is conditional. A List is printable, equatable and
	§ comparable exactly when its items are. A use site solving
	§ `List<ItemType> is Equatable` solves `ItemType is Equatable` too, so a
	§ `List<List<Integer>>` compares through Integer's own `is`, one nesting
	§ level at a time.
	§
	§ Every Method that asks whether two items are equal carries the `Equatable`
	§ bound. The structural comparison it replaced was not a Type the language
	§ could name. It gave `1/2` and `2/4` whatever answer the runtime
	§ representation happened to give.
	namespace List<infer ItemType> for List<ItemType>
		is Printable where ItemType is Printable,
		is Equatable where ItemType is Equatable,
		is Comparable where ItemType is Comparable
	{
		§§ Answers a List holding the given item the given number of times.
		§§
		§§ A count of zero or less answers the empty List. A count proven to be above zero answers a List with something in it.
		overload static repeat {
			§§ Answers a List holding the given item the given number of times.
			§§
			§§ A count of zero or less answers the empty List.
			§§
			§§ @param _ — the item to repeat
			§§ @param times — how many copies the List holds
			§§ @returns — the List of repeated items.
			(_ item: ItemType, times count: Integer) -> List<ItemType> {
				§ `of` counts up only, so a count below one answers no
				§ Integers and the guard an earlier body carried is gone.
				§ The Integers are only the tally. Each is replaced by the
				§ item.
				<- List.of(integersFrom 1, through count)::map((_) { <- item })
			}

			§ Native for the reason the single-item `append` is. In Essence the
			§ body would be the entry above, whose answer is a `List`. An
			§ expression that is not empty is not the same as one the language
			§ can be told is not empty.

			§§ Answers a List holding the given item a number of times proven to be above zero.
			§§
			§§ At least one copy is held, so the answer certainly has something in it.
			§§
			§§ @param _ — the item to repeat
			§§ @param times — how many copies the List holds, proven to be above zero
			§§ @returns — the List of repeated items, which is never empty.
			(
				_ item: ItemType,
				times count: PositiveInteger,
			) -> NonEmptyList<ItemType>
		}

		§ Essence has no Range Type, so a counting loop writes
		§ `List.of(integersFrom 1, through 10)::map(…)`. The Method is fixed to
		§ Integers, so the Namespace's `ItemType` has nothing to merge into.
		§
		§ The direction is in the label rather than in the pair of bounds. The
		§ `through:` and `upTo:` entries count up, and `downTo:` counts down. An
		§ up-counting entry answers the empty List where the end is behind the
		§ start. An earlier `through:` ran whichever way its bounds pointed, so
		§ a range written from the length of an empty List answered `[0, -1]`.
		§ Which way a pair of Integers points is a relation between two values,
		§ and no refinement reads one. So the proof of a non-empty answer moved
		§ to `downTo:`, which always answers its first value.
		§
		§ A `by:` Argument is the signed step. A step that moves away from the
		§ end answers the empty List on `through:` and `upTo:`, and the first
		§ value alone on `downTo:`. The Parameter is a `NonZeroInteger` because
		§ a step of zero reaches no end. The alternative was a `PositiveInteger`
		§ magnitude with the label deciding the direction, which refuses
		§ `by -3` where every peer reads it as a direction.

		§§ Answers the Integers of a range, counting up or down, one step at a time.
		§§
		§§ The `through:` and `upTo:` entries count up, and the `downTo:` entry counts down. The `by:` entries move by the given step instead of by one. The end is included where the label is `through:` or `downTo:`, and excluded where it is `upTo:`.
		§§
		§§ @returns — the List of Integers.
		overload static of {
			§§ Answers the Integers from one value up through another, both included.
			§§
			§§ The count only runs up. An end below the start answers the empty List. To count down, use the `downTo:` entry.
			§§
			§§ @example
			§§   expect List.of(integersFrom 1, through 4)::is([1, 2, 3, 4])
			§§   expect List.of(integersFrom 4, through 1)::isEmpty()
			§§
			§§ @param integersFrom — the first Integer of the List
			§§ @param through — the last Integer of the List, which is included
			§§ @returns — the List of Integers. It is empty when the end is below the start.
			(integersFrom start: Integer, through end: Integer) -> List<Integer>

			§§ Answers the Integers from one value up to, but not including, another.
			§§
			§§ The count only runs up. An end at or below the start answers the empty List.
			§§
			§§ @example
			§§   expect List.of(integersFrom 0, upTo 3)::is([0, 1, 2])
			§§   expect List.of(integersFrom 0, upTo 0)::isEmpty()
			§§
			§§ @param integersFrom — the first Integer of the List
			§§ @param upTo — the Integer the List stops before
			§§ @returns — the List of Integers. It is empty when the end is not above the start.
			(integersFrom start: Integer, upTo end: Integer) -> List<Integer> {
				§ The excluded end is the included one, one lower. The entry
				§ above counts up only, so a `through` below the start answers
				§ nothing and no guard is needed here.
				<- List.of(integersFrom start, through end::subtract(1))
			}

			§§ Answers the Integers from one value down through another, both included.
			§§
			§§ The count only runs down. The first value is always answered, so an end above the start answers a List holding that value alone. The answer certainly has something in it.
			§§
			§§ @example
			§§   expect List.of(integersFrom 3, downTo 1)::is([3, 2, 1])
			§§   expect List.of(integersFrom 3, downTo 9)::is([3])
			§§
			§§ @param integersFrom — the first Integer of the List
			§§ @param downTo — the last Integer of the List, which is included
			§§ @returns — the List of Integers, which is never empty.
			(
				integersFrom start: Integer,
				downTo end: Integer,
			) -> NonEmptyList<Integer>

			§§ Answers the Integers from one value through another, moving by the given step.
			§§
			§§ The step is added each turn, and the walk stops where a step passes the end. A step that moves away from the end answers the empty List.
			§§
			§§ @example
			§§   expect List.of(integersFrom 0, through 9, by 3)::is([0, 3, 6, 9])
			§§   expect List.of(integersFrom 9, through 0, by -3)::is([9, 6, 3, 0])
			§§
			§§ @param integersFrom — the first Integer of the List
			§§ @param through — the value the walk stops at or before, which is included when a step reaches it
			§§ @param by — how far each step moves, which is never zero
			§§ @returns — the List of Integers. It is empty when the step moves away from the end.
			(
				integersFrom start: Integer,
				through end: Integer,
				by step: NonZeroInteger,
			) -> List<Integer>

			§§ Answers the Integers from one value up to, but not including, another, moving by the given step.
			§§
			§§ The step is added each turn, and the walk stops before the end. A step that moves away from the end answers the empty List.
			§§
			§§ @example
			§§   expect List.of(integersFrom 0, upTo 9, by 3)::is([0, 3, 6])
			§§   expect List.of(integersFrom 9, upTo 0, by -3)::is([9, 6, 3])
			§§
			§§ @param integersFrom — the first Integer of the List
			§§ @param upTo — the Integer the walk stops before
			§§ @param by — how far each step moves, which is never zero
			§§ @returns — the List of Integers. It is empty when the step moves away from the end.
			(
				integersFrom start: Integer,
				upTo end: Integer,
				by step: NonZeroInteger,
			) -> List<Integer> {
				§ The excluded end is the included one, one nearer the start on
				§ the side the step comes from. The step is read for its
				§ direction before the call, so the Argument the entry above is
				§ handed is the `NonZeroInteger` this one was given.
				constant nearer = define {
					as end::subtract(1) if step::isPositive()
					as end::add(1)      otherwise
				}

				<- List.of(integersFrom start, through nearer, by step)
			}

			§§ Answers the Integers from one value down through another, moving by the given step.
			§§
			§§ The step is added each turn, and the walk stops where a step passes the end. The first value is always answered, so a step that moves away from the end answers a List holding that value alone.
			§§
			§§ @example
			§§   expect List.of(integersFrom 9, downTo 0, by -3)::is([9, 6, 3, 0])
			§§   expect List.of(integersFrom 9, downTo 0, by 3)::is([9])
			§§
			§§ @param integersFrom — the first Integer of the List
			§§ @param downTo — the value the walk stops at or before, which is included when a step reaches it
			§§ @param by — how far each step moves, which is never zero
			§§ @returns — the List of Integers, which is never empty.
			(
				integersFrom start: Integer,
				downTo end: Integer,
				by step: NonZeroInteger,
			) -> NonEmptyList<Integer>
		}

		§ An Essence body would be length equality and
		§ `pair(with other)::hasOnlyItems(where …)`, and it can not be written
		§ that way yet. The pair Record mentions `ItemType`. Binding a List
		§ Method's own `ItemType` to a Type that mentions it makes inference
		§ substitute the name into itself until the stack runs out. The bound is
		§ not the cause: a plain generic Function doing the same overflows too.
		§ So `is` is native and takes the witness, comparing each pair of items
		§ with the items' own `is`.

		§§ Answers whether the two Lists hold the same items in the same order.
		§§
		§§ Each pair of items is compared with the items' own `is`. The Method is available whenever the items conform to `Equatable`.
		§§
		§§ @param _ — the List to compare with
		§§ @returns — `true` when the Lists are equal.
		is<infer ItemType is Equatable>(_ other: List<ItemType>) -> Boolean

		§ The witness behind List's conditional `Comparable` conformance.

		§§ Answers how the List orders against another one, comparing them lexicographically.
		§§
		§§ The first differing pair of items decides. On an equal prefix the shorter List comes first. The Method is available whenever the items conform to `Comparable`.
		§§
		§§ @param to — the List to compare with
		§§ @returns — `Ordering#Less`, `Ordering#Equal` or `Ordering#Greater`.
		compare<infer ItemType is Comparable>(
			to other: List<ItemType>,
		) -> Ordering

		§§ Answers the List and its items as a String, in the form `[1, 2, 3]`.
		§§
		§§ Each item is rendered by its own `toString`, and a String item is quoted: `["a", "b"]` answers `["a", "b"]`. A String prints bare on its own and quoted inside a structure. The empty List answers `[]`. The Method is available whenever the items conform to `Printable`.
		§§
		§§ @returns — the String representation of the List.
		toString<infer ItemType is Printable>() -> String

		§ Each quantified Method folds a Boolean. The alternative is
		§ `firstItem(where:)::hasValue()`, which answers the same question and
		§ builds an Optional per call to throw away. So the accumulator carries
		§ the answer rather than the item.

		§§ Answers whether the List has an item, or has an item the check accepts.
		§§
		§§ @returns — `true` when the List has an item, or when the check accepts an item.
		overload hasItems {
			§§ Answers whether the List has at least one item.
			§§
			§§ It is the opposite of `isEmpty`.
			§§
			§§ @returns — `true` when the List is not empty.
			() -> Boolean {
				§ This body is read as well as run. A predicate written as
				§ one call on `@` is that call, so the `else` of an `if`
				§ asking `isEmpty` proves `NonEmptyList`. The chain in
				§ `isEmpty` keeps it a question of its own. See
				§ DEVELOPMENT.md, Why bodies look the way they do.
				<- @::isEmpty()::negate()
			}

			§§ Answers whether the check accepts at least one item.
			§§
			§§ The walk stops at the first accepted item. The empty List has no item to accept, so it answers `false`.
			§§
			§§ @param where — the check each item is offered to
			§§ @returns — `true` when the check accepts an item.
			(where check: (_: ItemType) -> Boolean) -> Boolean {
				<- @::reduce(startingWith false, step (found, item) {
					if check(item) {
						<- #Done(true)
					} else {
						<- #Continue(found)
					}
				})
			}
		}

		§§ Answers whether the List has no items at all.
		§§
		§§ @returns — `true` for the empty List.
		isEmpty() -> Boolean {
			§ Asking for `List.length` costs nothing: it is native and O(1),
			§ reading the underlying array's length. The body of
			§ `String.isEmpty` is the same, but there `length` walks the
			§ characters.
			<- @::length()::is(0)
		}

		§§ Answers whether an item equal to the given one is in the List, or whether every item of another List is.
		§§
		§§ Equality is the items' own `is`. The Method is available whenever the items conform to `Equatable`.
		§§
		§§ @returns — `true` when the item occurs, or when every item of the other List does.
		overload contains {
			§§ Answers whether an item equal to the given one is in the List.
			§§
			§§ Equality is the items' own `is`. The entry is available whenever the items conform to `Equatable`.
			§§
			§§ @param _ — the item to look for
			§§ @returns — `true` when the item occurs.
			<infer ItemType is Equatable>(_ item: ItemType) -> Boolean {
				<- @::hasItems(where (candidate) { <- candidate::is(item) })
			}

			§ One of the four set-shaped entries; the note above
			§ `removeDuplicates` says what they rest on. This one is the
			§ subset question. It counts nothing: a List is a bag, and
			§ `count(of:)` is what answers how many times an item occurs.

			§§ Answers whether every item of the given List occurs in this one.
			§§
			§§ How many times an item occurs is not asked, so a List holding one `1` contains every item of `[1, 1]`. The empty List has no item to look for, so every List contains its items. The walk stops at the first item that does not occur. Equality is the items' own `is`. The entry is available whenever the items conform to `Equatable`.
			§§
			§§ @example
			§§   expect [1, 2, 3]::contains(everyItemOf [3, 1])
			§§   expect [1, 2]::contains(everyItemOf [])
			§§
			§§ @param everyItemOf — the List whose items to look for
			§§ @returns — `true` when every item of it occurs.
			<infer ItemType is Equatable>(
				everyItemOf other: List<ItemType>,
			) -> Boolean
		}

		§§ Answers whether no item equal to the given one is in the List.
		§§
		§§ Equality is the items' own `is`. The Method is available whenever the items conform to `Equatable`.
		§§
		§§ @param _ — the item to look for
		§§ @returns — `true` when the item does not occur.
		doesNotContain<infer ItemType is Equatable>(
			_ item: ItemType,
		) -> Boolean {
			§ This body is read as well as run. It asks `contains`
			§ negated, over whatever item the call writes. See
			§ DEVELOPMENT.md, Why bodies look the way they do.
			<- @::contains(item)::negate()
		}

		§ The universal and the empty quantifier are Methods of their own
		§ rather than labels on `hasItems`. A `hasItems(onlyWhere:)` promises
		§ existence in its prefix and answers `true` for the empty List, which
		§ is the opposite of what the prefix says. A name of its own says which
		§ quantifier is asked.

		§§ Answers whether the check accepts every item.
		§§
		§§ The walk stops at the first item the check refuses. The empty List has no item to fail the check, so it answers `true`.
		§§
		§§ @param where — the check each item is offered to
		§§ @returns — `true` when the check accepts every item.
		hasOnlyItems(where check: (_: ItemType) -> Boolean) -> Boolean {
			<- @::hasItems(where (item) { <- check(item)::negate() })::negate()
		}

		§§ Answers whether the check accepts no item at all.
		§§
		§§ The walk stops at the first accepted item. The empty List has no item to accept, so it answers `true`.
		§§
		§§ @param where — the check each item is offered to
		§§ @returns — `true` when the check accepts no item.
		hasNoItems(where check: (_: ItemType) -> Boolean) -> Boolean {
			<- @::hasItems(where check)::negate()
		}

		§ Asked of the items themselves and of a key read off each, as
		§ `removeDuplicates` is, and native for the same walk. An Essence body
		§ is `removeDuplicates()::length()::isNot(@::length())`, which builds
		§ the whole distinct List to answer a question the second repeat
		§ settles. Two thousand asks of a 20,001 item List whose first two
		§ items are equal measured 1,081 ms that way and 21 ms here. Both
		§ figures hold 20 ms of subprocess startup.

		§§ Answers whether any item occurs twice, or whether any two items share a key.
		§§
		§§ Equality is the items' own `is`, or the keys' own where a key is read. The walk stops at the first repeat.
		§§
		§§ @returns — `true` when something occurs twice.
		overload hasDuplicates {
			§§ Answers whether any item occurs twice.
			§§
			§§ The walk stops at the first repeated item. The empty List and a List of one item answer `false`. Equality is the items' own `is`. The entry is available whenever the items conform to `Equatable`.
			§§
			§§ @example
			§§   expect [1, 2, 1]::hasDuplicates()
			§§
			§§ @returns — `true` when an item occurs twice.
			<infer ItemType is Equatable>() -> Boolean

			§§ Answers whether any two items share the key the given Function reads off each one.
			§§
			§§ The walk stops at the first repeated key. Equality is the keys' own `is`. The entry is available whenever what the key answers conforms to `Equatable`.
			§§
			§§ @example
			§§   constant rows = [{ sku = "a" }, { sku = "a" }]
			§§
			§§   expect rows::hasDuplicates(on .sku)
			§§
			§§ @param on — the key read off each item
			§§ @returns — `true` when two items share a key.
			<infer Key is Equatable>(on key: (_: ItemType) -> Key) -> Boolean
		}

		§ The four questions `String` asks of its text, asked of a List. A
		§ String's characters are a `List<String>`, so the same question was
		§ askable of the text and not of its characters. Each is written on
		§ the counted `firstItems` or `lastItems` beside it, which answer
		§ every item for a count past the length. So a prefix longer than the
		§ receiver is compared against fewer items than it has, and no guard
		§ is needed.
		§
		§ The two `doesNot` bodies are read as well as run, as `String`'s two
		§ are. Each asks its contrary's question over whatever List the call
		§ writes. See DEVELOPMENT.md, Why bodies look the way they do.

		§§ Answers whether the List begins with the items of the given one.
		§§
		§§ Equality is the items' own `is`. The Method is available whenever the items conform to `Equatable`. Every List begins with the empty List.
		§§
		§§ @example
		§§   expect [1, 2, 3]::starts(with [1, 2])
		§§   expect [1, 2, 3]::doesNotStart(with [2])
		§§
		§§ @param with — the leading items to look for
		§§ @returns — `true` when the List begins with those items.
		starts<infer ItemType is Equatable>(
			with prefix: List<ItemType>,
		) -> Boolean {
			<- @::firstItems(prefix::length())::is(prefix)
		}

		§§ Answers whether the List does not begin with the items of the given one.
		§§
		§§ Equality is the items' own `is`. The Method is available whenever the items conform to `Equatable`.
		§§
		§§ @param with — the leading items to look for
		§§ @returns — `true` when the List begins with other items.
		doesNotStart<infer ItemType is Equatable>(
			with prefix: List<ItemType>,
		) -> Boolean {
			<- @::starts(with prefix)::negate()
		}

		§§ Answers whether the List ends with the items of the given one.
		§§
		§§ Equality is the items' own `is`. The Method is available whenever the items conform to `Equatable`. Every List ends with the empty List.
		§§
		§§ @param with — the trailing items to look for
		§§ @returns — `true` when the List ends with those items.
		ends<infer ItemType is Equatable>(
			with suffix: List<ItemType>,
		) -> Boolean {
			<- @::lastItems(suffix::length())::is(suffix)
		}

		§§ Answers whether the List does not end with the items of the given one.
		§§
		§§ Equality is the items' own `is`. The Method is available whenever the items conform to `Equatable`.
		§§
		§§ @param with — the trailing items to look for
		§§ @returns — `true` when the List ends with other items.
		doesNotEnd<infer ItemType is Equatable>(
			with suffix: List<ItemType>,
		) -> Boolean {
			<- @::ends(with suffix)::negate()
		}

		§ Native, and the shape the README's fourth group names: an ordering
		§ whose Essence body builds a whole List to answer one question. Two
		§ bodies were weighed. One is the adjacent pairs
		§ `@::pair(with @::removeFirst())` makes, quantified by
		§ `hasNoItems`. The other is a fold carrying the item before in a
		§ Record. The pairs build one Record per item, and the fold pays a
		§ Record spread per item. Two thousand checks of a two thousand item
		§ sorted List measured 64 ms and 127 ms against 21 ms here. The walk
		§ here holds the item before in a local. A List already in order is
		§ the case that pays. The pairs build their whole List whatever the
		§ answer is, and measured 57 ms where the third item decides it.
		§
		§ A direction is a Parameter rather than a Method of its own, the way
		§ `sort` reads one. Descending turns the comparison around instead of
		§ asking a second question. So the two directions agree about a List
		§ whose items the order does not tell apart.

		§§ Answers whether the items are in order.
		§§
		§§ Items the order does not tell apart are in order either way. The empty List and a List of one item are both in order. The Method is available whenever the items conform to `Comparable`.
		§§
		§§ @example
		§§   expect [1, 2, 2, 3]::isSorted()
		§§   expect [3, 2, 1]::isSorted(in #Descending)
		§§
		§§ @param in — the direction to check for, `#Ascending` when it is left out
		§§ @returns — `true` when no item stands out of that order.
		isSorted<infer ItemType is Comparable>(
			in order: SortOrder = #Ascending,
		) -> Boolean

		§§ Answers how many items the List has.
		§§
		§§ @returns — the number of items, which is never negative.
		length() -> NonNegativeInteger

		§ Every Method below that can answer empty offers a `defaultingTo:`
		§ entry beside it, answering the bare Type. Each of those entries is
		§ written on `Optional::value(defaultingTo:)`.

		§§ Answers the first item, or the first item the check accepts.
		§§
		§§ The empty List has no first item, and a check can accept none of the items. The `defaultingTo:` entries answer the given item in place of nothing.
		overload firstItem {
			§§ Answers the first item of the List.
			§§
			§§ @returns — the item, or nothing for the empty List.
			() -> Optional<ItemType> {
				§ `item(at:)` answers empty for a position outside the List, so
				§ the empty List needs no guard here.
				<- @::item(at 0)
			}

			§§ Answers the first item the check accepts.
			§§
			§§ @param where — the check each item is offered to
			§§ @returns — the matching item, or nothing when no item is accepted.
			(where check: (_: ItemType) -> Boolean) -> Optional<ItemType> {
				§ Written on `reduce`'s early-stopping entry, so the fold
				§ finishes at the first accepted item and never walks the rest.
				§ `everyItem(where:)::firstItem()` walks every item.
				§
				§ On a `List<Optional<Item>>` the answer is an
				§ `Optional<Optional<Item>>`, and the two levels say different
				§ things. An `#Empty` answer means no item matched. A
				§ `#Value(#Empty)` answer means the item that matched is itself
				§ empty.
				constant start: Optional<ItemType> = #Empty

				<- @::reduce(startingWith start, step (found, item) {
					if check(item) {
						<- #Done(#Value(item))
					} else {
						<- #Continue(found)
					}
				})
			}

			§§ Answers the first item, or the given fallback for the empty List.
			§§
			§§ @param defaultingTo — the item to answer with when there is none
			§§ @returns — the first item, or the fallback in its place.
			(defaultingTo fallback: ItemType) -> ItemType {
				<- @::firstItem()::value(defaultingTo fallback)
			}

			§§ Answers the first item the check accepts, or the given fallback when it accepts none.
			§§
			§§ @param where — the check each item is offered to
			§§ @param defaultingTo — the item to answer with when there is none
			§§ @returns — the matching item, or the fallback in its place.
			(
				where check: (_: ItemType) -> Boolean,
				defaultingTo fallback: ItemType,
			) -> ItemType {
				<- @::firstItem(where check)::value(defaultingTo fallback)
			}
		}

		§§ Answers the last item, or the last item the check accepts.
		§§
		§§ The empty List has no last item, and a check can accept none of the items. The `defaultingTo:` entries answer the given item in place of nothing.
		overload lastItem {
			§§ Answers the last item of the List.
			§§
			§§ @returns — the item, or nothing for the empty List.
			() -> Optional<ItemType> {
				§ -1 is the last position. The empty List has no such item: the
				§ position lands outside the List, so `item(at:)` answers empty
				§ without a guard here.
				<- @::item(at -1)
			}

			§§ Answers the last item the check accepts.
			§§
			§§ The walk runs backwards and stops at the first item it accepts.
			§§
			§§ @param where — the check each item is offered to
			§§ @returns — the matching item, or nothing when no item is accepted.
			(where check: (_: ItemType) -> Boolean) -> Optional<ItemType> {
				§ Written on `lastIndex(where:)`, the one backwards walk that
				§ stops at the item that decides it, and the item is read back
				§ by its position. The body was `reverse()::firstItem(where:)`,
				§ which copies the whole List before a walk whose point is
				§ stopping early. Two thousand calls on 20,000 items with the
				§ last item accepted measured 61 ms that way and 20 ms this way.
				constant items = @

				<- @::lastIndex(where check)
					::andThen((position) { <- items::item(at position) })
			}

			§§ Answers the last item, or the given fallback for the empty List.
			§§
			§§ @param defaultingTo — the item to answer with when there is none
			§§ @returns — the last item, or the fallback in its place.
			(defaultingTo fallback: ItemType) -> ItemType {
				<- @::lastItem()::value(defaultingTo fallback)
			}

			§§ Answers the last item the check accepts, or the given fallback when it accepts none.
			§§
			§§ @param where — the check each item is offered to
			§§ @param defaultingTo — the item to answer with when there is none
			§§ @returns — the matching item, or the fallback in its place.
			(
				where check: (_: ItemType) -> Boolean,
				defaultingTo fallback: ItemType,
			) -> ItemType {
				<- @::lastItem(where check)::value(defaultingTo fallback)
			}
		}

		§§ Answers the item at the given position.
		§§
		§§ The position counts from zero. A negative position counts back from the end: -1 is the last item. A position outside the List answers nothing, and the `defaultingTo:` entry answers the given item instead.
		overload item {
			§§ Answers the item at the given position.
			§§
			§§ @param at — the position of the item
			§§ @returns — the item, or nothing when the position is outside the List.
			(at index: Integer) -> Optional<ItemType>

			§§ Answers the item at the given position, or the given fallback when the position is outside the List.
			§§
			§§ @param at — the position of the item
			§§ @param defaultingTo — the item to answer with when the position names none
			§§ @returns — the item at that position, or the fallback in its place.
			(at index: Integer, defaultingTo fallback: ItemType) -> ItemType {
				<- @::item(at index)::value(defaultingTo fallback)
			}
		}

		§ Both entries count their way through the items and stop at the first
		§ match. The fold threads the position as its accumulator and builds no
		§ List. Walking the positions with `item(at:)` reads better and costs an
		§ Optional per item. The `of:` entry is the `where:` entry with the
		§ items' own `is` as the check.

		§§ Answers the position of the first item equal to the given one, or of the first item the check accepts.
		§§
		§§ A List without such an item answers nothing, and the `defaultingTo:` entries answer the given position instead.
		overload firstIndex {
			§§ Answers the position of the first item equal to the given one.
			§§
			§§ Equality is the items' own `is`. The entry is available whenever the items conform to `Equatable`.
			§§
			§§ @param of — the item to look for
			§§ @returns — the zero-based position, or nothing when the item is absent.
			<infer ItemType is Equatable>(
				of item: ItemType,
			) -> Optional<Integer> {
				<- @::firstIndex(where (candidate) { <- candidate::is(item) })
			}

			§§ Answers the position of the first item the check accepts.
			§§
			§§ @param where — the check each item is offered to
			§§ @returns — the zero-based position, or nothing when no item is accepted.
			(where check: (_: ItemType) -> Boolean) -> Optional<Integer> {
				§ The accumulator is the position under test. A `#Done` leaves
				§ the fold at the first match. A fold that reaches the end
				§ settles on the length, which is the one position no match can
				§ answer. So an absent item needs no sentinel, and the fold
				§ carries a bare Integer rather than an Optional.
				constant found = @::reduce(
					startingWith 0,
					step (index, candidate) {
						if check(candidate) {
							<- #Done(index)
						} else {
							<- #Continue(index::add(1))
						}
					},
				)

				if found::isLessThan(@::length()) {
					<- #Value(found)
				} else {
					<- #Empty
				}
			}

			§§ Answers the position of the first item equal to the given one, or the given fallback when the item is absent.
			§§
			§§ Equality is the items' own `is`. The entry is available whenever the items conform to `Equatable`.
			§§
			§§ @param of — the item to look for
			§§ @param defaultingTo — the position to answer with when the item is absent
			§§ @returns — the zero-based position, or the fallback in its place.
			<infer ItemType is Equatable>(
				of item: ItemType,
				defaultingTo fallback: Integer,
			) -> Integer {
				<- @::firstIndex(of item)::value(defaultingTo fallback)
			}

			§§ Answers the position of the first item the check accepts, or the given fallback when it accepts none.
			§§
			§§ @param where — the check each item is offered to
			§§ @param defaultingTo — the position to answer with when no item is accepted
			§§ @returns — the zero-based position, or the fallback in its place.
			(
				where check: (_: ItemType) -> Boolean,
				defaultingTo fallback: Integer,
			) -> Integer {
				<- @::firstIndex(where check)::value(defaultingTo fallback)
			}
		}

		§§ Answers the position of the last item equal to the given one, or of the last item the check accepts.
		§§
		§§ A List without such an item answers nothing, and the `defaultingTo:` entries answer the given position instead.
		overload lastIndex {
			§§ Answers the position of the last item equal to the given one.
			§§
			§§ Equality is the items' own `is`. The entry is available whenever the items conform to `Equatable`.
			§§
			§§ @param of — the item to look for
			§§ @returns — the zero-based position, or nothing when the item is absent.
			<infer ItemType is Equatable>(
				of item: ItemType,
			) -> Optional<Integer> {
				<- @::lastIndex(where (candidate) { <- candidate::is(item) })
			}

			§§ Answers the position of the last item equal to the given one, or the given fallback when the item is absent.
			§§
			§§ Equality is the items' own `is`. The entry is available whenever the items conform to `Equatable`.
			§§
			§§ @param of — the item to look for
			§§ @param defaultingTo — the position to answer with when the item is absent
			§§ @returns — the zero-based position, or the fallback in its place.
			<infer ItemType is Equatable>(
				of item: ItemType,
				defaultingTo fallback: Integer,
			) -> Integer {
				<- @::lastIndex(of item)::value(defaultingTo fallback)
			}

			§ The one backwards walk in the Namespace, and native because no
			§ Essence expression walks a List backwards without copying it.
			§ The fold in `reduce` runs forwards. The general `loop` is in
			§ `Loop.es`, and importing that would make it a seventh file in
			§ the frozen import cycle, through `Integer.es`. The body it
			§ replaces reversed the receiver and read a `firstIndex` off the
			§ copy. That is a whole copy before a walk whose point is stopping
			§ early. Two thousand calls on 20,000 items with the last item
			§ accepted measured 57 ms that way and 19 ms natively. The entries
			§ `lastIndex(of:)` and `lastItem(where:)` are written on this one.

			§§ Answers the position of the last item the check accepts.
			§§
			§§ The walk runs backwards and stops at the first item it accepts.
			§§
			§§ @param where — the check each item is offered to
			§§ @returns — the zero-based position, or nothing when no item is accepted.
			(where check: (_: ItemType) -> Boolean) -> Optional<Integer>

			§§ Answers the position of the last item the check accepts, or the given fallback when it accepts none.
			§§
			§§ @param where — the check each item is offered to
			§§ @param defaultingTo — the position to answer with when no item is accepted
			§§ @returns — the zero-based position, or the fallback in its place.
			(
				where check: (_: ItemType) -> Boolean,
				defaultingTo fallback: Integer,
			) -> Integer {
				<- @::lastIndex(where check)::value(defaultingTo fallback)
			}
		}

		§ The positions the receiver has, and the items beside them. A `map`
		§ answers one item for each and forgets where each stood. A counter
		§ threaded through a `reduce` is what put that back.
		§
		§ `enumerate` is native and walks once. In Essence its body would be
		§ `@::indices()::map(…)`, which reads every item back through
		§ `item(at:)` and builds an Optional per item to take apart again.
		§
		§ `indices()` is native for the reason `NonEmptyList::indices` gives:
		§ the two entries are one walk under two names.

		§§ Answers the positions the List has, or the positions of the items a check accepts.
		§§
		§§ The positions count from zero and stop before the length. The empty List answers no positions.
		§§
		§§ @returns — the List of positions.
		overload indices {
			§§ Answers the positions the List has, in order.
			§§
			§§ The positions count from zero and stop before the length. The empty List answers no positions. The answer is a whole List of positions: to walk the items beside their positions in one pass, use `enumerate()`.
			§§
			§§ @returns — the List of positions.
			() -> List<Integer>

			§ Written on `enumerate`, which is the one walk that hands a body
			§ an item and the position it stands at. The fold is what keeps
			§ the positions. A filter over the same entries followed by a
			§ `map` reading `.index` builds two Lists where this builds one.
			§ Two hundred walks of 20,000 items measured 104 ms that way and
			§ 74 ms here.
			§
			§ For the positions an item stands at, `everyIndex(of:)` asks the
			§ same question by value.

			§§ Answers the positions of the items the check accepts, in order.
			§§
			§§ The positions count from zero. A check that accepts no item answers no positions.
			§§
			§§ @example
			§§   expect [3, 4, 5, 6]::indices(where (n) { <- n::isEven() })::is([1, 3])
			§§
			§§ @param where — the check each item is offered to
			§§ @returns — the List of positions the check accepted.
			(where check: (_: ItemType) -> Boolean) -> List<Integer> {
				constant kept: List<Integer> = []

				<- @::enumerate()
					::reduce(startingWith kept, (positions, entry) {
						if check(entry.item) {
							<- positions::append(entry.index)
						} else {
							<- positions
						}
					})
			}
		}

		§ The two ends have a middle. A search that expects to match one item
		§ answers a List of one, and reading that through `firstItem` says
		§ nothing about the items after it. The length is read once and
		§ `firstItem` answers the Optional outright, so nothing is unwrapped
		§ to be wrapped again.

		§§ Answers the only item of the List.
		§§
		§§ A List of any other length has no only item, and the `defaultingTo:` entry answers the given item in place of nothing.
		overload onlyItem {
			§§ Answers the only item of the List.
			§§
			§§ @example
			§§   expect [7]::onlyItem()::is(7)
			§§   expect [7, 8]::onlyItem()::isEmpty()
			§§
			§§ @returns — the item, or nothing when the List does not hold exactly one.
			() -> Optional<ItemType> {
				if @::length()::is(1) {
					<- @::firstItem()
				} else {
					<- #Empty
				}
			}

			§§ Answers the only item of the List, or the given fallback for a List of any other length.
			§§
			§§ @param defaultingTo — the item to answer with when there is no only item
			§§ @returns — the item, or the fallback in its place.
			(defaultingTo fallback: ItemType) -> ItemType {
				<- @::onlyItem()::value(defaultingTo fallback)
			}
		}

		§ The plural of `firstIndex(of:)` and `lastIndex(of:)`, which name
		§ one position each. It is a Method of its own rather than an entry
		§ on `indices`. That Method answers the positions the List holds, and
		§ this one answers the positions an item stands at. The check form of
		§ the same question is `indices(where:)`, and this is that entry with
		§ the items' own `is` as the check.

		§§ Answers the positions of every item equal to the given one, in order.
		§§
		§§ Equality is the items' own `is`. The Method is available whenever the items conform to `Equatable`. A List without the item answers no positions.
		§§
		§§ @example
		§§   expect [1, 2, 1]::everyIndex(of 1)::is([0, 2])
		§§
		§§ @param of — the item to look for
		§§ @returns — the List of positions the item stands at.
		everyIndex<infer ItemType is Equatable>(
			of item: ItemType,
		) -> List<Integer> {
			<- @::indices(where (candidate) { <- candidate::is(item) })
		}

		§§ Answers every item beside the position it stands at.
		§§
		§§ The position counts from zero. The empty List answers no entries.
		§§
		§§ @returns — the List of Records, each holding a position under `index` and the item at it under `item`.
		enumerate() -> List<{ index: Integer, item: ItemType }>

		§ The counted entry and the checked one. A count says how many
		§ leading items go. A `while:` check says where the leading run ends.
		§ The walk stops at the first item the check refuses, and every item
		§ from there on is kept.
		§
		§ The checked entry reads that boundary off `firstIndex(where:)`,
		§ which leaves at the first refusal, and slices from it. The
		§ alternative was a fold carrying a Record of the answer and whether
		§ it is still dropping. That fold walks every item and pays a Record
		§ spread for each item it keeps. Two thousand calls over a two
		§ thousand item List measured 34 ms on the boundary and 133 ms on the
		§ fold. A quarter of the items were dropped there. Dropping all but a
		§ twentieth they measured 23 ms and 33 ms.
		§
		§ The entries `removeLast(while:)` and `lastItems(while:)` read their
		§ boundary off `lastIndex(where:)`, which walks backwards. The entry
		§ `firstItems(while:)` does not, and says why at its own site.

		§§ Answers a new List without the first item, without the given number of leading items, or without the leading items a check accepts.
		§§
		§§ The answer is empty when every item is removed. A count below one removes nothing.
		§§
		§§ @returns — the shortened List.
		overload removeFirst {
			§§ Answers a new List without the first item, or without the given number of leading items.
			§§
			§§ The answer is empty when more items are removed than the List has. A count below one removes nothing.
			§§
			§§ @param _ — how many leading items to remove, which is one when it is left out
			§§ @returns — the shortened List.
			(_ count: Integer = 1) -> List<ItemType> {
				§ The Parameter is a count, not a position. A negative count
				§ would reach `slice` as a position counting back from the
				§ end, so the guard answers the receiver instead. A count past
				§ the length reaches `slice`'s own clamping and leaves
				§ nothing.
				§
				§ On the empty List the default slices `[1, 0)`, an inverted
				§ range, which `slice` answers empty.
				if count::isLessThan(0) {
					<- @
				} else {
					<- @::slice(from count)
				}
			}

			§§ Answers a new List without the leading items the check accepts.
			§§
			§§ The walk stops at the first item the check refuses, and that item and every item after it are kept. A check that accepts every item answers the empty List.
			§§
			§§ @example
			§§   expect [1, 2, 3, 1]::removeFirst(while (n) { <- n::isLessThan(3) })::is([3, 1])
			§§
			§§ @param while — the check the leading items are offered to
			§§ @returns — the List from the first refused item on.
			(while check: (_: ItemType) -> Boolean) -> List<ItemType> {
				<- @::slice(
					from @::firstIndex(
						where (item) { <- check(item)::negate() },
						defaultingTo @::length(),
					),
				)
			}
		}

		§ Native, because an Essence composition can not avoid its
		§ intermediates and here the intermediates are the whole Method. The
		§ body was `slice(from 0, to index)` joined to
		§ `slice(from index::add(1), to length)`, which builds the answer twice
		§ and reads the receiver twice. The runtime fills one Array of the
		§ answer's own size, and none at all where the item is at an end.

		§§ Answers a new List without the item at the given position.
		§§
		§§ The position counts from zero. A negative position counts back from the end: -1 is the last item. A position outside the List leaves it unchanged.
		§§
		§§ @param at — the position of the item to remove
		§§ @returns — the List without that item.
		remove(at index: Integer) -> List<ItemType>

		§§ Answers a new List without every item equal to the given one, or without every item the check accepts.
		§§
		§§ Equality is the items' own `is`. The by-value entry is available whenever the items conform to `Equatable`.
		§§
		§§ @returns — the List of remaining items.
		overload removeEvery {
			§§ Answers a new List without every item equal to the given one.
			§§
			§§ Equality is the items' own `is`. The entry is available whenever the items conform to `Equatable`.
			§§
			§§ @param _ — the item to remove
			§§ @returns — the List of remaining items.
			<infer ItemType is Equatable>(_ item: ItemType) -> List<ItemType> {
				<- @::removeEvery(where (candidate) { <- candidate::is(item) })
			}

			§§ Answers a new List without every item the check accepts.
			§§
			§§ @param where — the check each item is offered to
			§§ @returns — the List of the items the check rejects.
			(where check: (_: ItemType) -> Boolean) -> List<ItemType> {
				<- @::everyItem(where (item) { <- check(item)::negate() })
			}

			§ The difference, and one of the four set-shaped entries; the note
			§ above `removeDuplicates` says what they rest on. The label
			§ mirrors `append(contentsOf:)`, which is the other Method here
			§ that is about a whole List rather than one item.

			§§ Answers a new List without any item the given List holds.
			§§
			§§ Every occurrence of such an item goes, and the rest keep their order. An item of the given List that this one does not hold changes nothing. Equality is the items' own `is`. The entry is available whenever the items conform to `Equatable`.
			§§
			§§ @example
			§§   expect [1, 2, 3, 2]::removeEvery(contentsOf [2])::is([1, 3])
			§§
			§§ @param contentsOf — the List whose items to remove
			§§ @returns — the List of remaining items.
			<infer ItemType is Equatable>(
				contentsOf other: List<ItemType>,
			) -> List<ItemType>
		}

		§§ Answers a new List without the last item, without the given number of trailing items, or without the trailing items a check accepts.
		§§
		§§ The answer is empty when every item is removed. A count below one removes nothing.
		§§
		§§ @returns — the shortened List.
		overload removeLast {
			§§ Answers a new List without the last item, or without the given number of trailing items.
			§§
			§§ The answer is empty when more items are removed than the List has. A count below one removes nothing.
			§§
			§§ @param _ — how many trailing items to remove, which is one when it is left out
			§§ @returns — the shortened List.
			(_ count: Integer = 1) -> List<ItemType> {
				§ The Parameter is a count, not a position. A count at or past
				§ the length makes the subtraction go negative, and `slice`
				§ would read that as a position counting back from the end.
				§ Both ends are answered here instead.
				<- define {
					as @  if count::isLessThan(1)
					as [] if count::isGreaterThanOrEqualTo(@::length())
					as @::slice(to @::length()::subtract(count)) otherwise
				}
			}

			§ The boundary is `lastIndex(where:)`, which walks backwards
			§ natively and leaves at the last item the check refuses. Every
			§ position after it is the trailing run. A List the check accepts
			§ every item of answers no such position, and the fallback of -1
			§ makes the slice stop before position zero. See the note on
			§ `removeFirst`.

			§§ Answers a new List without the trailing items the check accepts.
			§§
			§§ The walk runs backwards and stops at the last item the check refuses. That item and every item before it are kept. A check that accepts every item answers the empty List.
			§§
			§§ @example
			§§   expect [1, 3, 2, 1]::removeLast(while (n) { <- n::isLessThan(3) })::is([1, 3])
			§§
			§§ @param while — the check the trailing items are offered to
			§§ @returns — the List up to the last refused item.
			(while check: (_: ItemType) -> Boolean) -> List<ItemType> {
				<- @::slice(
					to @::lastIndex(
						where (item) { <- check(item)::negate() },
						defaultingTo -1,
					)
						::add(1),
				)
			}
		}

		§§ Answers a new List with the given item, or with the contents of the given List, added at the front.
		overload prepend {
			§ Native for the reason `append`'s single-item entry is, and with
			§ the same proof behind it. Which end an item is added at has
			§ nothing to do with the proof.

			§§ Answers a new List with the given item added at the front.
			§§
			§§ The item is never dropped, so the answer certainly has something in it.
			§§
			§§ @param _ — the item to add
			§§ @returns — the extended List, which is never empty.
			(_ item: ItemType) -> NonEmptyList<ItemType>

			§§ Answers a new List with the contents of the given List added at the front.
			§§
			§§ @param contentsOf — the List whose items to add
			§§ @returns — the extended List.
			(contentsOf other: List<ItemType>) -> List<ItemType> {
				<- other::append(contentsOf @)
			}
		}

		§§ Answers a new List with the given item, or with the contents of the given List, added at the end.
		overload append {
			§ An item is added, so the answer holds one thing more than the
			§ receiver and is never empty. Adding a whole List proves nothing of
			§ the kind, because the List added can be the empty one.
			§
			§ The single-item entry is native. In Essence its body would be
			§ `@::append(contentsOf [item])`, whose answer is the other entry's
			§ `List`. An expression that is not empty is not the same as one
			§ the language can be told is not empty.

			§§ Answers a new List with the given item added at the end.
			§§
			§§ The item is never dropped, so the answer certainly has something in it.
			§§
			§§ @param _ — the item to add
			§§ @returns — the extended List, which is never empty.
			(_ item: ItemType) -> NonEmptyList<ItemType>

			§§ Answers a new List with the contents of the given List added at the end.
			§§
			§§ @param contentsOf — the List whose items to add
			§§ @returns — the extended List.
			(contentsOf other: List<ItemType>) -> List<ItemType>
		}

		§ `map` and `reduce` each carry a Method level Generic. The transform's
		§ answer is `Other`, and the fold carries `Answer`, which `reduce` reads
		§ from `startingWith`. See DEVELOPMENT.md, Why bodies look the way they
		§ do. The Namespace's `ItemType` merges in ahead of that Generic, so
		§ `map` is generic in `[ItemType, Other]`.

		§§ Answers a new List with the given transform applied to every item.
		§§
		§§ @param _ — the transform each item is handed to
		§§ @returns — the List of transformed items.
		map<infer Other>(_ transform: (_: ItemType) -> Other) -> List<Other>

		§ The second entry can stop early, because its combiner answers with a
		§ `Step`, which is what lets an Essence expression leave a walk early.

		§§ Answers the items combined into a single value, starting from the given one.
		§§
		§§ The fold runs to the end, or stops early when the combiner says to.
		§§
		§§ @returns — the combined value.
		overload reduce {
			§§ Answers the items combined into a single value, starting from the given one.
			§§
			§§ @param startingWith — the value the first combination builds on
			§§ @param _ — the combiner, handed the value so far and each item
			§§ @returns — the combined value.
			<infer Answer>(
				startingWith initial: Answer,
				_ combine: (_: Answer, _: ItemType) -> Answer,
			) -> Answer

			§§ Answers the items combined into a single value, starting from the given one, and can stop before the end.
			§§
			§§ The `step` combiner answers with a `Step`: `#Continue` carries the value forward, and `#Done` finishes at once with its own value. Both of that `Step`'s Type Parameters are the `Answer` here, so a fold stops with the Type it carries. The empty List answers the starting value untouched.
			§§
			§§ @param startingWith — the value the first combination builds on
			§§ @param step — the combiner, handed the value so far and each item, answering with a `Step`
			§§ @returns — the combined value, or the value the first `#Done` carries.
			<infer Answer>(
				startingWith initial: Answer,
				step combine: (_: Answer, _: ItemType) -> Step<Answer, Answer>,
			) -> Answer
		}

		§ The filter, and the complement of `removeEvery(where:)`. There is no
		§ by-value entry: keeping the items equal to a given value is what
		§ `contains` already answers.

		§§ Answers a new List of every item the check accepts, or of every item another List holds too.
		§§
		§§ The kept items keep their order.
		§§
		§§ @returns — the List of kept items.
		overload everyItem {
			§§ Answers a new List of every item the check accepts.
			§§
			§§ Each item is offered to the check, and the accepted items keep their order.
			§§
			§§ @param where — the check each item is offered to
			§§ @returns — the List of accepted items.
			(where check: (_: ItemType) -> Boolean) -> List<ItemType>

			§ The intersection, and one of the four set-shaped entries; the
			§ note above `removeDuplicates` says what they rest on. It is a
			§ filter like the entry above rather than a set operation. An item
			§ the other List holds is kept every time it occurs, so
			§ `[1, 1]::everyItem(alsoIn [1])` is `[1, 1]`. A caller that wants
			§ the set asks `removeDuplicates()` after it.

			§§ Answers a new List of every item the given List holds too.
			§§
			§§ The kept items keep the order they had here, and an item kept once for every time it occurs. How many times the other List holds it is not asked. Equality is the items' own `is`. The entry is available whenever the items conform to `Equatable`.
			§§
			§§ @example
			§§   expect [3, 1, 2]::everyItem(alsoIn [2, 3])::is([3, 2])
			§§
			§§ @param alsoIn — the List whose items to keep
			§§ @returns — the List of items both Lists hold.
			<infer ItemType is Equatable>(
				alsoIn other: List<ItemType>,
			) -> List<ItemType>
		}

		§ Both ends are defaulted, so `slice(from n)` is the tail from `n` and
		§ `slice(to n)` is the head up to it. Four callers in the library spelled
		§ `slice(from n, to @::length())` before that. The `to` default reads the
		§ receiver, which is a binding by the time it runs. The receiver
		§ Expression is evaluated once, whatever the call leaves out.

		§§ Answers a new List of the items from one position up to, but not including, another.
		§§
		§§ A negative position counts back from the end, so `slice(from 0, to -1)` drops the last item.
		§§
		§§ @param from — the first position to include, counting from zero, or back from the end when negative. It is zero when the call leaves it out.
		§§ @param to — the position to stop before, counting the same way. It is the length when the call leaves it out.
		§§ @returns — the List of items in that range. It is empty when the range is empty, inverted, or entirely outside the List.
		slice(
			from start: Integer = 0,
			to end: Integer = @::length(),
		) -> List<ItemType>

		§§ Answers a new List with the items in the opposite order.
		§§
		§§ @example
		§§   constant reversed = [1, 2, 3]::reverse()
		§§
		§§   expect reversed::is([3, 2, 1])
		§§
		§§ @returns — the reversed List.
		reverse() -> List<ItemType>

		§ The `Comparable` bound resolves the conforming Namespace at the call
		§ site: `Integer` for a `List<Integer>`, and the covering `Number` for a
		§ mixed numeric List.
		§
		§ All three entries are native. In Essence the first entry's body
		§ would be `@::sort(by …)`, a call that has to pick one of the entries
		§ below it. Picking one is what would give the comparison's Parameters
		§ their Types. Annotating them does not rescue it either. That entry's
		§ bounded `ItemType` shadows the Namespace's, so the annotated Function
		§ is typed in a different `ItemType` than the `by:` entry expects.
		§
		§ A direction is a Parameter of the two entries that read an ordering.
		§ The `by:` entry takes none, because a comparison already says which
		§ way it runs. Descending turns the comparison around rather than
		§ reversing the answer, so a sort stays stable in either direction.

		§§ Answers a new List in order, by the items' own ordering, by the given comparison, or by a key.
		§§
		§§ The sort is stable, so items the order does not tell apart keep the order they had, in either direction. The first entry is available whenever the items conform to `Comparable`.
		§§
		§§ A direction is read where one is taken, and it is `#Ascending` when a call names none.
		§§
		§§ @returns — the ordered List.
		overload sort {
			§§ Answers a new List in the given direction, by the items' own ordering.
			§§
			§§ The sort is stable. The entry is available whenever the items conform to `Comparable`. The direction is `#Ascending` when a call names none. For any other order, use the `by:` entry.
			§§
			§§ @param in — the direction to order in, `#Ascending` when it is left out
			§§ @returns — the ordered List.
			<infer ItemType is Comparable>(
				in order: SortOrder = #Ascending,
			) -> List<ItemType>

			§§ Answers a new List ordered by the given comparison, applied to each pair of items.
			§§
			§§ The sort is stable.
			§§
			§§ @param by — the comparison to order the items with
			§§ @returns — the ordered List.
			(
				by comparison: (_: ItemType, _: ItemType) -> Ordering,
			) -> List<ItemType>

			§ Native, and it was an Essence body on the `by:` entry handing
			§ over a comparison that called the key on both sides. That reads
			§ the key twice per comparison, 2·n·log₂n times against n. The
			§ native reads each key once, sorts the positions on the keys and
			§ reads the items back out in that order. With a key costing four
			§ hundred loop turns, 20,000 rows in scrambled order measured
			§ 178 ms that way against 28 ms natively. A member path key costs
			§ nothing either way: three sorts of 200,000 rows on `.weight`
			§ measured 103 ms through the comparison. Natively they measured
			§ 100 ms. The README's own example is a computed key.
			§
			§ `on` is the label for a key-reading Function everywhere one is
			§ taken: here, on `group`, `lowestItem`, `highestItem`, `sum` and
			§ `average`. A member path then reads the same way at each of
			§ them. `by` is not reused, because it already means a comparison
			§ one entry up. Two same-labelled entries told apart by arity
			§ alone would be a trap.

			§§ Answers a new List in the given direction of what the key reads off each item.
			§§
			§§ The key is read once per item. The sort is stable, so items whose keys compare equal keep the order they had. The entry is available whenever what the key answers conforms to `Comparable`. The direction is `#Ascending` when a call names none.
			§§
			§§ @param on — the key each item is ordered by
			§§ @param in — the direction to order in, `#Ascending` when it is left out
			§§ @returns — the ordered List.
			<infer Key is Comparable>(
				on key: (_: ItemType) -> Key,
				in order: SortOrder = #Ascending,
			) -> List<ItemType>
		}

		§§ Answers how many items equal the given one, or how many items the check accepts.
		§§
		§§ Equality is the items' own `is`. The by-value entry is available whenever the items conform to `Equatable`.
		§§
		§§ @returns — the count.
		overload count {
			§§ Answers how many items equal the given one.
			§§
			§§ Equality is the items' own `is`. The entry is available whenever the items conform to `Equatable`.
			§§
			§§ @param of — the item to look for
			§§ @returns — how many items equal it, which is never negative.
			<infer ItemType is Equatable>(
				of item: ItemType,
			) -> NonNegativeInteger {
				<- @::count(where (candidate) { <- candidate::is(item) })
			}

			§§ Answers how many items the check accepts.
			§§
			§§ @param where — the check each item is offered to
			§§ @returns — how many items the check accepts, which is never negative.
			(where check: (_: ItemType) -> Boolean) -> NonNegativeInteger {
				§ One fold carrying the total, over a filter whose length was
				§ read: the filter built a List of every accepted item to throw
				§ away. Counting has to see every item either way, so the walk
				§ is the same. What each accepted item costs is the difference:
				§ the filter pushed it, and the fold adds one to a number. Two
				§ thousand counts of 20,000 items with every item accepted
				§ measured 155 ms on the filter and 78 ms on the fold. With
				§ `isEven` they measured 275 ms and 231 ms.
				§
				§ The fold carries a bare Integer. What a fold carries is read
				§ off the value it starts at, and that reading widens a
				§ refinement away. So a proven zero would not keep the proof.
				§ A count starts at none and only ever grows. So `absolute` is
				§ the identity on the answer, and it is the entry that mints the
				§ proof back. The body this replaced minted it the same way, out
				§ of the native its chain ended on.
				constant total = @::reduce(startingWith 0, (running, item) {
					if check(item) {
						<- running::add(1)
					} else {
						<- running
					}
				})

				<- total::absolute()
			}
		}

		§ A position outside the List settles on the nearer end, so no position
		§ drops the item, however far out or however negative it stands.
		§
		§ Native for the reason `append`'s and `prepend`'s single-item entries
		§ are. The body it had was a `slice`, an `append` and an `append`, and
		§ every part of it answered a `List`.

		§§ Answers a new List with the given item inserted before the given position.
		§§
		§§ A negative position counts back from the end, so `insert(_, at -1)` puts the item before the last one. A position outside the List clamps to the nearer end. The item is never dropped, so the answer certainly has something in it.
		§§
		§§ @param _ — the item to insert
		§§ @param at — the position to insert the item before
		§§ @returns — the List with the item inserted. It is never empty.
		insert(_ item: ItemType, at index: Integer) -> NonEmptyList<ItemType>

		§§ Answers a new List with the item at the given position replaced by a given item, or by a transform of it.
		§§
		§§ A negative position counts back from the end: -1 is the last item. A position outside the List leaves it unchanged.
		§§
		§§ @returns — the List with the item replaced.
		overload replace {
			§§ Answers a new List with the item at the given position replaced.
			§§
			§§ A negative position counts back from the end: -1 is the last item. A position outside the List leaves it unchanged.
			§§
			§§ @param _ — the item to put at that position
			§§ @param at — the position of the item to replace
			§§ @returns — the List with the item replaced.
			(_ item: ItemType, at index: Integer) -> List<ItemType> {
				constant length = @::length()

				§ The guard is needed, because `remove(at:)` ignores a position
				§ outside the List but `insert(_:at:)` clamps it. Without it
				§ the item would be added at an end.
				§
				§ A negative position is resolved first, because `remove(at:)`
				§ shortens the List before `insert(_:at:)` reads the position
				§ again. The same negative position names a different place in
				§ the shorter List.
				if index::isLessThan(0::subtract(length)) {
					<- @
				} else if index::isLessThan(0) {
					<- @::replace(item, at index::add(length))
				} else if index::isGreaterThanOrEqualTo(length) {
					<- @
				} else {
					<- @::remove(at index)::insert(item, at index)
				}
			}

			§ Written on the entry above, over the item that is already there.
			§ The position needs no guard of its own. The `item(at:)` call
			§ counts a negative position back from the end exactly as the entry
			§ above does. It answers nothing for a position outside the List.
			§ That is the case that leaves the receiver alone, so the transform
			§ is never handed an item the List does not hold.

			§§ Answers a new List with the item at the given position replaced by what the transform answers for it.
			§§
			§§ A negative position counts back from the end: -1 is the last item. A position outside the List leaves it unchanged, and the transform is not run.
			§§
			§§ @param at — the position of the item to replace
			§§ @param _ — the transform the item at that position is handed to
			§§ @returns — the List with the item replaced.
			(
				at index: Integer,
				_ transform: (_: ItemType) -> ItemType,
			) -> List<ItemType> {
				§ `@` is rebound inside `match`; see DEVELOPMENT.md, Why bodies
				§ look the way they do.
				constant items = @

				<- match @::item(at index) -> List<ItemType> {
					case #Value(item) {
						<- items::replace(transform(item), at index)
					}

					case #Empty { <- items }
				}
			}
		}

		§ The bound does real work here rather than restating a conformance of
		§ List's own. An item with no `Printable` conformance is refused at the
		§ bound, which names the Protocol that is missing.

		§§ Answers the items joined into one String, with the given separator between them.
		§§
		§§ Each item is rendered by its own `toString`: `[1, 2, 3]::join(with ", ")` is `"1, 2, 3"`. The answer is the raw text, so a String item is not quoted, which is where joining differs from `toString`. For a List of Strings the Method undoes `String::split(on:)`. It is available whenever the items conform to `Printable`.
		§§
		§§ @param with — the separator to place between the items
		§§ @returns — the joined String. The empty List answers the empty String.
		join<infer ItemType is Printable>(with separator: String) -> String

		§ `flatten` is not here: it is not available on every List, and every
		§ Method of this Namespace is. `NestedList` below holds it.

		§ Native, so the check is offered each item once in one walk. The
		§ body it replaces was the filter beside its complement, which offers
		§ every item to the check twice. The fold in Essence that fixes that
		§ carries a Record of the two halves and pays a Record spread and an
		§ `append` per item. Two hundred partitions of 20,000 items on
		§ `isEven` measured 68 ms on the two filters, 202 ms on the fold and
		§ 49 ms natively. With a check costing a hundred loop turns the same
		§ run measured 655 ms, 566 ms and 361 ms.
		§
		§ The members are named for what the check does to an item. Every
		§ `§§` block in the file says a check accepts or refuses an item, so
		§ the halves are `accepted` and `refused`.

		§ The two entries below the first cut the List at one position
		§ instead of sorting the items into two heaps. So their halves are
		§ named for where they stand rather than for what a check did to
		§ them: `leading` and `trailing`. Every item of the receiver is in
		§ one of them, and joining the two answers the receiver back.

		§§ Answers the List split in two: by a check, at the end of the leading run a check accepts, or at a position.
		§§
		§§ Both halves keep the original order, and every item of the receiver is in exactly one of them.
		§§
		§§ @returns — a Record holding the two halves.
		overload partition {
			§§ Answers the List split in two by the check: the items it accepts, and the items it refuses.
			§§
			§§ Both halves keep the original order. Each item is offered to the check once.
			§§
			§§ @param where — the check each item is offered to
			§§ @returns — a Record holding the accepted items under `accepted` and the others under `refused`.
			(
				where check: (_: ItemType) -> Boolean,
			) -> { accepted: List<ItemType>, refused: List<ItemType> }

			§ Both halves off one boundary, which is the whole of what this
			§ entry buys over calling `firstItems(while:)` beside
			§ `removeFirst(while:)`: the leading run is walked once. The
			§ boundary is `removeFirst`'s own, and that note explains it.

			§§ Answers the List split at the end of the leading run the check accepts.
			§§
			§§ The walk stops at the first item the check refuses. That item opens the trailing half. A check that accepts every item answers the whole List under `leading`.
			§§
			§§ @example
			§§   constant halves = [1, 2, 3, 1]::partition(while (n) { <- n::isLessThan(3) })
			§§
			§§   expect halves.leading::is([1, 2])
			§§   expect halves.trailing::is([3, 1])
			§§
			§§ @param while — the check the leading items are offered to
			§§ @returns — a Record holding the leading run under `leading` and the rest under `trailing`.
			(
				while check: (_: ItemType) -> Boolean,
			) -> { leading: List<ItemType>, trailing: List<ItemType> } {
				<- @::partition(
					at @::firstIndex(
						where (item) { <- check(item)::negate() },
						defaultingTo @::length(),
					),
				)
			}

			§§ Answers the List split in two at the given position.
			§§
			§§ The item at that position opens the trailing half. A negative position counts back from the end: -1 cuts before the last item. A position outside the List leaves one half empty.
			§§
			§§ @example
			§§   constant halves = [1, 2, 3]::partition(at 1)
			§§
			§§   expect halves.leading::is([1])
			§§   expect halves.trailing::is([2, 3])
			§§
			§§ @param at — the position to cut before
			§§ @returns — a Record holding the items before that position under `leading` and the rest under `trailing`.
			(
				at index: Integer,
			) -> { leading: List<ItemType>, trailing: List<ItemType> } {
				<- {
					leading = @::slice(to index),
					trailing = @::slice(from index),
				}
			}
		}

		§§ Answers the items of the two Lists paired position by position.
		§§
		§§ The pairing stops with the shorter List.
		§§
		§§ @param with — the List to pair the items with
		§§ @returns — a List of Records, each holding one item of this List under `first` and its counterpart under `second`.
		pair<infer Other>(
			with other: List<Other>,
		) -> List<{ first: ItemType, second: Other }>

		§ Every group holds at least one item, which is what the item Type of
		§ the first entry's answer says. A group is opened for an item and
		§ never for the space after one. So the shorter last group exists only
		§ when something remains to put in it. A size below one answers one
		§ group holding everything, and the empty List answers no groups.
		§
		§ The other two cut at a separator rather than at a count, and their
		§ proof stands the other way round. A separator cuts between the
		§ pieces, so a List holding n of them has n+1 pieces and a List
		§ holding none is one piece. That is `String::split(on:)`'s own rule,
		§ where the proof is read on the separator because the empty String
		§ cuts nowhere. An item separator can not be empty, so nothing has to
		§ be asked for it here. The pieces themselves promise nothing: two
		§ separators side by side leave the empty piece between them.

		§§ Answers the List split into groups of a given size, or into the pieces around the items a separator or a check picks out.
		§§
		§§ @returns — the List of pieces.
		overload split {
			§§ Answers the List split into groups of the given size, in order.
			§§
			§§ The last group holds whatever remains, so it can be shorter. Every group holds at least one item. A size below one names no grouping, and the answer is one group holding every item. The empty List answers no groups at all, whatever the size.
			§§
			§§ @param intoGroupsOf — how many items each group holds
			§§ @returns — the List of groups, each of which certainly has something in it.
			(intoGroupsOf size: Integer) -> List<NonEmptyList<ItemType>>

			§ The separator entry is the check entry with the items' own `is`
			§ as the check, which is the shape `removeEvery` and `contains`
			§ have. The label is `String::split(on:)`'s, for the same idea.

			§§ Answers the pieces around every item equal to the given one.
			§§
			§§ The separators are not in the answer. Two separators next to each other leave the empty piece between them, and a separator at an end leaves one there. Equality is the items' own `is`. The entry is available whenever the items conform to `Equatable`.
			§§
			§§ @example
			§§   expect [1, 0, 2, 3]::split(on 0)::is([[1], [2, 3]])
			§§
			§§ @param on — the item to split at
			§§ @returns — the List of pieces, which always holds at least one.
			<infer ItemType is Equatable>(
				on separator: ItemType,
			) -> NonEmptyList<List<ItemType>> {
				<- @::split(where (candidate) { <- candidate::is(separator) })
			}

			§§ Answers the pieces around every item the check accepts.
			§§
			§§ The accepted items are not in the answer. Two accepted items next to each other leave the empty piece between them, and one at an end leaves one there. The empty List answers one empty piece.
			§§
			§§ @example
			§§   expect [1, 2, 3]::split(where (n) { <- n::isEven() })::is([[1], [3]])
			§§
			§§ @param where — the check each item is offered to
			§§ @returns — the List of pieces, which always holds at least one.
			(
				where check: (_: ItemType) -> Boolean,
			) -> NonEmptyList<List<ItemType>>
		}

		§ The item a key is lowest or highest at. That is a different
		§ question from `lowestNumber`, which answers a number the List holds.
		§ This one answers the item a number was read off. The return Type is
		§ what tells them apart, so rule 4 does not make these Overloads of it.
		§
		§ Both walk once. They are written on `reduce` rather than on
		§ `sort(on key)::firstItem()`, which answers the same item for n log n
		§ comparisons instead of n.

		§§ Answers the lowest item, or the item whose key is lowest.
		§§
		§§ Ties keep the earlier item. The empty List has no such item, and the `defaultingTo:` entries answer the given item in place of nothing.
		overload lowestItem {
			§§ Answers the item whose key is lowest.
			§§
			§§ @param on — the key the items are ordered by
			§§ @returns — the item, or nothing for the empty List.
			<infer Key is Comparable>(
				on key: (_: ItemType) -> Key,
			) -> Optional<ItemType> {
				constant start: Optional<ItemType> = #Empty

				<- @::reduce(startingWith start, (lowest, item) {
					<- match lowest -> Optional<ItemType> {
						case #Empty { <- #Value(item) }

						case #Value(found) {
							if key(item)
								::compare(to key(found))
								::is(Ordering#Less)
							{
								<- #Value(item)
							} else {
								<- lowest
							}
						}
					}
				})
			}

			§§ Answers the item whose key is lowest, or the given fallback for the empty List.
			§§
			§§ @param on — the key the items are ordered by
			§§ @param defaultingTo — the item to answer with when there is none
			§§ @returns — the item, or the fallback in its place.
			<infer Key is Comparable>(
				on key: (_: ItemType) -> Key,
				defaultingTo fallback: ItemType,
			) -> ItemType {
				<- @::lowestItem(on key)::value(defaultingTo fallback)
			}

			§ The keyless pair, for a List whose items order themselves.
			§ Without them `["pear", "apple"]::lowestItem()` had to be written
			§ as a sort and a read, or as an identity key at the call site.
			§ Each is the keyed entry above with the item as its own key. So
			§ the comparison stays written once, and one call per item is
			§ what that costs. Two thousand calls over a two thousand item
			§ List measured 15 ms here and 10 ms with the fold written out a
			§ second time. The second copy was declined at that price: it is
			§ the same walk and the same comparison under a second name.
			§
			§ They are appended rather than written beside the keyed pair,
			§ because an Overload's position binds its emitted name. See
			§ DEVELOPMENT.md, Editing hazards.

			§§ Answers the lowest item.
			§§
			§§ Ties keep the earlier item. The entry is available whenever the items conform to `Comparable`.
			§§
			§§ @example
			§§   constant fruit: List<String> = ["pear", "apple"]
			§§
			§§   expect fruit::lowestItem()::is("apple")
			§§
			§§ @returns — the item, or nothing for the empty List.
			<infer ItemType is Comparable>() -> Optional<ItemType> {
				<- @::lowestItem(on (item) { <- item })
			}

			§§ Answers the lowest item, or the given fallback for the empty List.
			§§
			§§ The entry is available whenever the items conform to `Comparable`.
			§§
			§§ @param defaultingTo — the item to answer with when there is none
			§§ @returns — the item, or the fallback in its place.
			<infer ItemType is Comparable>(
				defaultingTo fallback: ItemType,
			) -> ItemType {
				<- @::lowestItem()::value(defaultingTo fallback)
			}
		}

		§§ Answers the highest item, or the item whose key is highest.
		§§
		§§ Ties keep the earlier item. The empty List has no such item, and the `defaultingTo:` entries answer the given item in place of nothing.
		overload highestItem {
			§§ Answers the item whose key is highest.
			§§
			§§ @param on — the key the items are ordered by
			§§ @returns — the item, or nothing for the empty List.
			<infer Key is Comparable>(
				on key: (_: ItemType) -> Key,
			) -> Optional<ItemType> {
				constant start: Optional<ItemType> = #Empty

				<- @::reduce(startingWith start, (highest, item) {
					<- match highest -> Optional<ItemType> {
						case #Empty { <- #Value(item) }

						case #Value(found) {
							if key(item)
								::compare(to key(found))
								::is(Ordering#Greater)
							{
								<- #Value(item)
							} else {
								<- highest
							}
						}
					}
				})
			}

			§§ Answers the item whose key is highest, or the given fallback for the empty List.
			§§
			§§ @param on — the key the items are ordered by
			§§ @param defaultingTo — the item to answer with when there is none
			§§ @returns — the item, or the fallback in its place.
			<infer Key is Comparable>(
				on key: (_: ItemType) -> Key,
				defaultingTo fallback: ItemType,
			) -> ItemType {
				<- @::highestItem(on key)::value(defaultingTo fallback)
			}

			§ The keyless pair, for a List whose items order themselves.
			§ Without them `["pear", "apple"]::highestItem()` had to be written
			§ as a sort and a read, or as an identity key at the call site.
			§ Each is the keyed entry above with the item as its own key. So
			§ the comparison stays written once, and one call per item is
			§ what that costs. Two thousand calls over a two thousand item
			§ List measured 15 ms here and 10 ms with the fold written out a
			§ second time. The second copy was declined at that price: it is
			§ the same walk and the same comparison under a second name.
			§
			§ They are appended rather than written beside the keyed pair,
			§ because an Overload's position binds its emitted name. See
			§ DEVELOPMENT.md, Editing hazards.

			§§ Answers the highest item.
			§§
			§§ Ties keep the earlier item. The entry is available whenever the items conform to `Comparable`.
			§§
			§§ @example
			§§   constant fruit: List<String> = ["pear", "apple"]
			§§
			§§   expect fruit::highestItem()::is("pear")
			§§
			§§ @returns — the item, or nothing for the empty List.
			<infer ItemType is Comparable>() -> Optional<ItemType> {
				<- @::highestItem(on (item) { <- item })
			}

			§§ Answers the highest item, or the given fallback for the empty List.
			§§
			§§ The entry is available whenever the items conform to `Comparable`.
			§§
			§§ @param defaultingTo — the item to answer with when there is none
			§§ @returns — the item, or the fallback in its place.
			<infer ItemType is Comparable>(
				defaultingTo fallback: ItemType,
			) -> ItemType {
				<- @::highestItem()::value(defaultingTo fallback)
			}
		}

		§ Keeping from an end, which is what `removeFirst` and `removeLast`
		§ answer the other way round. Both take a count rather than a
		§ position. A count is lenient here as everywhere in the library.
		§ Nothing is kept for a count below one, and everything for a count
		§ past the length.
		§
		§ Each guards its count before handing it to `slice`, which reads a
		§ negative Argument as a position counting back from the end. A
		§ `slice(from 0)` is the whole List, so a count of zero would keep
		§ everything without the guard.

		§§ Answers a new List of the leading items, up to the given count, or of the leading items a check accepts.
		§§
		§§ A count below one answers the empty List. A count past the length answers every item.
		§§
		§§ @returns — the List of leading items, in the order they were in.
		overload firstItems {
			§§ Answers a new List of the leading items, up to the given count.
			§§
			§§ A count below one answers the empty List. A count past the length answers every item.
			§§
			§§ @param _ — how many leading items to keep
			§§ @returns — the List of leading items, in the order they were in.
			(_ count: Integer) -> List<ItemType> {
				if count::isLessThan(1) {
					<- []
				} else {
					<- @::slice(to count)
				}
			}

			§ The complement of `removeFirst(while:)`: the two joined answer
			§ the receiver back. This one is the fold rather than the
			§ boundary, because what it keeps is exactly what it walked. The
			§ boundary reads the leading run and then copies it. Two thousand
			§ calls over a two thousand item List measured 10 ms that way and
			§ 7 ms here. A quarter of the items were kept there. Keeping all
			§ but a twentieth the two measured 22 ms and 25 ms, and the fold
			§ is behind. The entry `removeFirst(while:)` keeps what it never
			§ walked, which is why it slices instead.

			§§ Answers a new List of the leading items the check accepts.
			§§
			§§ The walk stops at the first item the check refuses, and that item is left out. A check that accepts every item answers every item.
			§§
			§§ @example
			§§   expect [1, 2, 3, 1]::firstItems(while (n) { <- n::isLessThan(3) })::is([1, 2])
			§§
			§§ @param while — the check the leading items are offered to
			§§ @returns — the List up to the first refused item.
			(while check: (_: ItemType) -> Boolean) -> List<ItemType> {
				constant leading: List<ItemType> = []

				<- @::reduce(startingWith leading, step (kept, item) {
					if check(item) {
						<- #Continue(kept::append(item))
					} else {
						<- #Done(kept)
					}
				})
			}
		}

		§§ Answers a new List of the trailing items, up to the given count, or of the trailing items a check accepts.
		§§
		§§ A count below one answers the empty List. A count past the length answers every item.
		§§
		§§ @returns — the List of trailing items, in the order they were in.
		overload lastItems {
			§§ Answers a new List of the trailing items, up to the given count.
			§§
			§§ A count below one answers the empty List. A count past the length reaches back past the start, where `slice` settles on zero, so it answers every item.
			§§
			§§ @param _ — how many trailing items to keep
			§§ @returns — the List of trailing items, in the order they were in.
			(_ count: Integer) -> List<ItemType> {
				if count::isLessThan(1) {
					<- []
				} else {
					<- @::slice(from count::negate())
				}
			}

			§ The complement of `removeLast(while:)`, over the same backwards
			§ boundary. See the note on `removeFirst`.

			§§ Answers a new List of the trailing items the check accepts.
			§§
			§§ The walk runs backwards and stops at the last item the check refuses, which is left out. A check that accepts every item answers every item.
			§§
			§§ @example
			§§   expect [1, 3, 2, 1]::lastItems(while (n) { <- n::isLessThan(3) })::is([2, 1])
			§§
			§§ @param while — the check the trailing items are offered to
			§§ @returns — the List from after the last refused item.
			(while check: (_: ItemType) -> Boolean) -> List<ItemType> {
				<- @::slice(
					from @::lastIndex(
						where (item) { <- check(item)::negate() },
						defaultingTo -1,
					)
						::add(1),
				)
			}
		}

		§ The running fold. Where `reduce` keeps the last value the combiner
		§ built, this keeps every one of them. The name is neither `reduce`
		§ nor `scan`. Peers spell it five ways, and `accumulate` is the one
		§ that reads as a command and does not collide with the fold beside
		§ it.
		§
		§ Native, because the answer holds the starting value before any item
		§ is seen. So it is never empty, which is the promise an Essence body
		§ can not make. A body would be a `reduce` carrying the List it is
		§ building, whose answer is a `List`.

		§§ Answers every value the combiner builds, starting from the given one.
		§§
		§§ The answer opens with the starting value and holds one value for every item after it. So it is one longer than the List, and it is never empty. The empty List answers the starting value alone.
		§§
		§§ @example
		§§   constant totals = [1, 2, 3]::accumulate(startingWith 0, (total, item) {
		§§     <- total::add(item)
		§§   })
		§§
		§§   expect totals::is([0, 1, 3, 6])
		§§
		§§ @param startingWith — the value the first combination builds on
		§§ @param _ — the combiner, handed the value so far and each item
		§§ @returns — the List of values, which is never empty.
		accumulate<infer Answer>(
			startingWith initial: Answer,
			_ combine: (_: Answer, _: ItemType) -> Answer,
		) -> NonEmptyList<Answer>

		§ The filter and the transform in one walk, written on `reduce`
		§ rather than as `map(transform)::values()`. What it saves is the
		§ whole List of Optionals that composition builds to take apart
		§ again. It saves little time. Two thousand walks of a two thousand
		§ item List measured 1013 ms on the composition and 948 ms here, with
		§ `Integer.parse` as the transform. Halving an Integer instead
		§ measured 511 ms and 474 ms. The composition is still what the
		§ Method means, which is what its block says.

		§§ Answers every value the transform answers for an item.
		§§
		§§ The items the transform answers nothing for are left out, so the answer can be shorter than the receiver. It is `map(transform)::values()` in one walk.
		§§
		§§ @example
		§§   constant parsed = ["1", "x", "22"]::everyValue(from (text) {
		§§     <- Integer.parse(text)
		§§   })
		§§
		§§   expect parsed::is([1, 22])
		§§
		§§ @param from — the transform each item is handed to
		§§ @returns — the List of values.
		everyValue<infer Other>(
			from transform: (_: ItemType) -> Optional<Other>,
		) -> List<Other> {
			constant kept: List<Other> = []

			<- @::reduce(startingWith kept, (accumulated, item) {
				<- match transform(item) -> List<Other> {
					case #Value(value) { <- accumulated::append(value) }
					case #Empty        { <- accumulated }
				}
			})
		}

		§ The set-shaped Methods, and the one structure all four rest on. Each
		§ holds what it has met in a Map keyed by the canonical encoding, in
		§ `keyEncoding.ts` in the runtime. So each is linear, where a fold on
		§ `contains` is quadratic. The other three are
		§ `contains(everyItemOf:)`, `everyItem(alsoIn:)` and
		§ `removeEvery(contentsOf:)`. There is no fifth: the union of two
		§ Lists is `append(contentsOf other)::removeDuplicates()`, and needs
		§ no name of its own.
		§
		§ The item's own `is` still decides. A witness the Compiler brands
		§ structural is what the encoding stands in for. Any other is scanned
		§ instead, exactly as a Dictionary scans its slots.
		§
		§ The body was `@::tally()::keys()` on `GroupedList`. That answers the
		§ same List, and reaches the whole second container behind it: the
		§ store, the kind registry and the written form. A Program whose only
		§ call is this one measured 18,607 bytes that way, against 5,083 for
		§ the same Program without the call. The Map costs 5,854 of those
		§ 13,524 back, and `bundleSize.spec.ts` holds the figure. The encoding
		§ is a module of its own so that this walk can rest on it without a
		§ store arriving behind it.

		§§ Answers a new List keeping only the first occurrence of each item, or the first item met at each key.
		§§
		§§ The kept items keep the order they had. Equality is the items' own `is`, or the keys' own where a key is read.
		§§
		§§ @returns — the List without duplicates.
		overload removeDuplicates {
			§§ Answers a new List keeping only the first occurrence of each item.
			§§
			§§ The kept items keep the order they had. Equality is the items' own `is`. The entry is available whenever the items conform to `Equatable`. The union of two Lists is `append(contentsOf other)::removeDuplicates()`.
			§§
			§§ @example
			§§   expect ["a", "b", "a"]::removeDuplicates()::is(["a", "b"])
			§§
			§§ @returns — the List without duplicates.
			<infer ItemType is Equatable>() -> List<ItemType>

			§§ Answers a new List keeping only the first item met at each key.
			§§
			§§ The kept items keep the order they had. A later item whose key is already met goes, whatever the rest of it holds. Equality is the keys' own `is`. The entry is available whenever what the key answers conforms to `Equatable`.
			§§
			§§ @example
			§§   constant rows = [{ id = 1, name = "a" }, { id = 1, name = "b" }]
			§§
			§§   expect rows::removeDuplicates(on .id)::is([{ id = 1, name = "a" }])
			§§
			§§ @param on — the key read off each item
			§§ @returns — the List holding the first item met at each key.
			<infer Key is Equatable>(
				on key: (_: ItemType) -> Key,
			) -> List<ItemType>
		}

		§ The twin of `String::pad`, and its default is the other end. A
		§ String is padded to line a column up, which puts the padding in
		§ front of the text. A List is padded to reach a length, which leaves
		§ the items it holds where they stand. The board that hand-rolled this
		§ in `examples/client-2048` padded at the end.

		§§ Answers the List filled up to the given length with the given item.
		§§
		§§ The filler goes at the end when no side is named. A `#BothEnds` side splits it between the two ends, and an odd count leaves the extra one at the end. A length at or below the one the List has answers it unchanged, so nothing is ever dropped.
		§§
		§§ @example
		§§   expect [1, 2]::pad(to 4, with 0)::is([1, 2, 0, 0])
		§§   expect [1, 2]::pad(to 4, with 0, at #Start)::is([0, 0, 1, 2])
		§§
		§§ @param to — the length to fill up to
		§§ @param with — the item to fill with
		§§ @param at — the end to fill at, `#End` when it is left out
		§§ @returns — the filled List. It is the receiver where the List is already that long.
		pad(
			to length: Integer,
			with filler: ItemType,
			at side: Side = #End,
		) -> List<ItemType> {
			constant needed = length::subtract(@::length())

			if needed::isLessThan(1) {
				<- @
			}

			§ `@` is rebound inside `match`; see DEVELOPMENT.md, Why bodies
			§ look the way they do.
			constant items = @

			<- match side -> List<ItemType> {
				case #Start {
					<- items::prepend(
						contentsOf List.repeat(filler, times needed),
					)
				}

				case #End {
					<- items::append(
						contentsOf List.repeat(filler, times needed),
					)
				}

				case #BothEnds {
					§ Centring splits the filler between the two ends and
					§ leaves an odd one over for the end, as `String::pad`
					§ does. A written `2` is its own refinement proof; see
					§ DEVELOPMENT.md, Why bodies look the way they do.
					constant atStart = needed::quotient(dividingBy 2)

					<- items
						::prepend(contentsOf List.repeat(filler, times atStart))
						::append(
							contentsOf List.repeat(
								filler,
								times needed::subtract(atStart),
							),
						)
				}
			}
		}

		§ Native for the item promise: a window of a size above zero holds
		§ that many items. An Essence body could only answer a
		§ `List<List<ItemType>>`. The spelling is
		§ `indices()::map((start) { <- @::slice(…) })`, and its slices promise
		§ nothing.

		§§ Answers every stretch of the given size, one position at a time.
		§§
		§§ The stretches overlap: each starts one position after the one before it. A size above the length answers no stretches at all, and so does the empty List. Every stretch holds the given number of items. For the pairs of neighbours alone, `list::pair(with list::removeFirst())` answers a Record of `first` and `second` per pair and reads better.
		§§
		§§ @example
		§§   expect [1, 2, 3, 4]::windows(of 2)::is([[1, 2], [2, 3], [3, 4]])
		§§   expect [1, 2]::windows(of 3)::isEmpty()
		§§
		§§ @param of — how many items each stretch holds, which is above zero
		§§ @returns — the List of stretches, each of which certainly has something in it.
		windows(of size: PositiveInteger) -> List<NonEmptyList<ItemType>>

		§ Native for the reason `windows` is. A run holds the item that opened
		§ it, and an Essence fold over the accepted items can not say so. It
		§ is the adjacent-run half of the grouping family, which `group(on:)`
		§ answers keyed instead.

		§§ Answers the stretches of neighbouring items the check accepts.
		§§
		§§ A stretch ends at the first item the check refuses, and the refused items are in no stretch. Every stretch holds at least one item. A List the check accepts no item of answers no stretches, and so does the empty List.
		§§
		§§ @example
		§§   expect [1, 3, 2, 5, 7]::runs(where (n) { <- n::isOdd() })
		§§       ::is([[1, 3], [5, 7]])
		§§
		§§ @param where — the check each item is offered to
		§§ @returns — the List of stretches, each of which certainly has something in it.
		runs(
			where check: (_: ItemType) -> Boolean,
		) -> List<NonEmptyList<ItemType>>
	}

	§ A List of Lists, and the one Method only such a List can answer. Its
	§ `ItemType` binds to the inner List's item Type, so
	§ `[[1, 2], [3]]::flatten()` answers a `List<Integer>`. No Protocol bound
	§ can name a Type that is not in the signature, which is why `flatten` is
	§ not a Method of `List`.
	namespace NestedList<infer ItemType> for List<List<ItemType>> {
		§§ Answers the inner Lists flattened by one level, into a single List.
		§§
		§§ Every inner List's items keep their order.
		§§
		§§ @returns — the flattened List.
		flatten() -> List<ItemType>

		§ Native, and the Essence body is writable: the shortest row's length
		§ is a fold, and each column is
		§ `rows::map((row) { <- row::item(at position) })::values()`. That
		§ builds an Optional per cell to take apart again, and reaches
		§ `OptionalList` from a Namespace that otherwise reaches only `List`.
		§ Twenty transposes of a 200 by 200 List measured 42 ms that way and
		§ 27 ms here. Both figures hold 22 ms of subprocess startup.

		§§ Answers the inner Lists turned round: one List per position, holding what each inner List has there.
		§§
		§§ The shortest inner List decides how many the answer holds, as `pair(with:)` does. An empty inner List answers no Lists at all, and so does the empty List of Lists. Transposing twice answers the receiver where every inner List is the same length.
		§§
		§§ @example
		§§   expect [[1, 2, 3], [4, 5, 6]]::transpose()::is([[1, 4], [2, 5], [3, 6]])
		§§
		§§ @returns — the List of positions, each holding one item of every inner List.
		transpose() -> List<List<ItemType>>
	}

	§ A List of Optionals, and the three Methods only such a List can answer.
	§ Its `ItemType` binds to the payload Type, so `values()` answers a
	§ `List<Integer>` for a `List<Optional<Integer>>`. No Protocol bound can
	§ name a Type that is not in the signature. That is why none of them is a
	§ Method of `List`, for the reason `flatten` is not.
	§
	§ The `values` body is written in Essence on `reduce` and `append`, which
	§ reaches only `List`'s own primitives. A native would fill one Array of
	§ the answer's own size instead of a box per kept item. Neither saves the
	§ other a walk. The two Methods under it say at their own sites what they
	§ are written on.
	§
	§ There is no proven twin. A List with something in it can hold nothing but
	§ empty Optionals, so a proof about the receiver says nothing about the
	§ answer.
	namespace OptionalList<infer ItemType> for List<Optional<ItemType>> {
		§§ Answers the values the Optionals hold, in order.
		§§
		§§ The empty Optionals are left out, so the answer can be shorter than the receiver. A List of empty Optionals answers the empty List. Where one empty Optional has to answer nothing at all, the Method is `allValues()`.
		§§
		§§ @returns — the List of values.
		values() -> List<ItemType> {
			constant kept: List<ItemType> = []

			<- @::reduce(startingWith kept, (accumulated, item) {
				<- match item -> List<ItemType> {
					case #Value(value) { <- accumulated::append(value) }
					case #Empty        { <- accumulated }
				}
			})
		}

		§ Written on the quantified `hasItems`, which leaves the walk at the
		§ first empty Optional, and on `values()` for the answer. Two thousand
		§ calls over a two thousand item List measured 40 ms where nothing is
		§ empty and 16 ms where the first item is. Comparing
		§ `values()::length()` against the receiver's measured 32 ms and 33 ms,
		§ and a fold on `reduce`'s early-stopping entry 60 ms and 15 ms.

		§§ Answers every value in order, and nothing where an Optional is empty.
		§§
		§§ The answer holds one value for every item of the receiver. The empty List answers the empty List, held in an Optional.
		§§
		§§ @example
		§§   constant rows: List<Optional<Integer>> = [#Value(1), #Value(2)]
		§§
		§§   expect rows::allValues()::is(#Value([1, 2]))
		§§
		§§ @returns — the List of every value, or an empty Optional.
		allValues() -> Optional<List<ItemType>> {
			if @::hasItems(where (item) { <- item::isEmpty() }) {
				<- #Empty
			} else {
				<- #Value(@::values())
			}
		}

		§ Written on `reduce`'s early-stopping entry, which leaves the walk at
		§ the first Optional holding a value. The alternative,
		§ `firstItem(where …)::flatten()`, builds an Optional to take apart
		§ again and measured 25 ms against 21 ms over the same two thousand
		§ calls.

		§§ Answers the value of the first Optional that holds one.
		§§
		§§ The walk stops at that Optional. A List holding nothing but empty Optionals answers empty, and so does the empty List.
		§§
		§§ @returns — the first value, or an empty Optional.
		firstValue() -> Optional<ItemType> {
			constant start: Optional<ItemType> = #Empty

			<- @::reduce(startingWith start, step (found, item) {
				<- match item -> Step<Optional<ItemType>, Optional<ItemType>> {
					case #Value(value) { <- #Done(#Value(value)) }
					case #Empty        { <- #Continue(found) }
				}
			})
		}
	}

	§ The Namespace a List of Results reaches, beside the one a List of
	§ Optionals reaches. What puts it in reach is what the items are, which
	§ makes it a narrowing of `List` rather than a Namespace of `Result.es`.
	§ Declaring it there would close a second cycle around this file, which
	§ imports that one.
	namespace ResultList<infer ValueType, infer FailureType>
		for List<Result<ValueType, FailureType>>
	{
		§§ Answers the values the Results hold, in order.
		§§
		§§ The failed Results are left out, so the answer can be shorter than the receiver. A List of failed Results answers the empty List. Where one failure has to answer nothing at all, the Method is `allValues()`.
		§§
		§§ @returns — the List of values.
		values() -> List<ValueType> {
			constant kept: List<ValueType> = []

			<- @::reduce(startingWith kept, (accumulated, item) {
				<- match item -> List<ValueType> {
					case #Value(value) { <- accumulated::append(value) }
					case #Failure      { <- accumulated }
				}
			})
		}

		§§ Answers the reasons the failed Results hold, in order.
		§§
		§§ The Results holding a value are left out. A List of values answers the empty List.
		§§
		§§ @returns — the List of reasons.
		reasons() -> List<FailureType> {
			constant kept: List<FailureType> = []

			<- @::reduce(startingWith kept, (accumulated, item) {
				<- match item -> List<FailureType> {
					case #Value           { <- accumulated }
					case #Failure(reason) { <- accumulated::append(reason) }
				}
			})
		}

		§ The members are named as the singular accessors pluralise: `values`
		§ for `Result::value`, and `reasons` for `Result::reason`. Where
		§ `List::partition` names its halves for what a check did to an item,
		§ there is no check here to name them after. An `accepted` half would
		§ say that something passed one.
		§
		§ The body is written on `values` and `reasons` rather than on a fold
		§ carrying a Record, because a fold pays a Record spread per item. Two
		§ thousand partitions of a two thousand item List measured 45 ms on
		§ the two walks and 174 ms on the fold. Subprocess startup is inside
		§ both figures.

		§§ Answers the Results split in two: the values they hold, and the reasons they failed with.
		§§
		§§ Both halves keep the original order. Every item of the receiver is in exactly one of them.
		§§
		§§ @returns — a Record holding the values under `values` and the reasons under `reasons`.
		partition() -> { values: List<ValueType>, reasons: List<FailureType> } {
			<- { values = @::values(), reasons = @::reasons() }
		}

		§ Accumulating rather than stopping at the first failure, because that
		§ is what the callers of this shape want. A form or a file of rows is
		§ checked to be told everything that is wrong with it. The reasons are
		§ read once, and the `if` asking `hasItems` is what mints the proof the
		§ answer needs. An early-stopping `hasItems(where …)` in front of that
		§ buys nothing: the walk it cut short proves nothing, so the same `if`
		§ still has to follow. Two thousand gatherings of a two thousand item
		§ List measured 59 ms either way.

		§§ Answers every value in order, and every reason where anything failed.
		§§
		§§ The answer holds one value for every item of the receiver. A single failure decides the answer, and the reasons are kept in the order they stand in. The empty List answers the empty List, held in a value. Where only the first reason is wanted, `reason()::map((reasons) { <- reasons::firstItem() })` reads it.
		§§
		§§ @example
		§§   constant rows: List<Result<Integer, String>> = [#Value(1), #Value(2)]
		§§
		§§   expect rows::allValues()::is(#Value([1, 2]))
		§§
		§§ @returns — every value in a Result, or every reason in one.
		allValues() -> Result<List<ValueType>, NonEmptyList<FailureType>> {
			constant problems = @::reasons()

			if problems::hasItems() {
				<- #Failure(problems)
			} else {
				<- #Value(@::values())
			}
		}
	}

	§ The Methods the proof changes. A NonEmptyList already answers every
	§ Method of `List`. A Namespace of its own is for the Methods that answer
	§ better for having the proof.
	§
	§ Five Methods spend the proof: `firstItem`, `lastItem`, `length`,
	§ `lowestItem(on:)` and `highestItem(on:)`. Everything else here carries
	§ it forward. Most answer with one item for every item they were handed,
	§ or with those items and more besides. So they can not empty a List that
	§ was not empty. Splitting regroups the items instead, and every group it
	§ opens holds one. Pairing demands the second proof of its Argument,
	§ because it stops with the shorter List. They are declared in the order
	§ `List` declares them, so the two can be read side by side.
	§
	§ Every entry is native, because the promise can not be said in Essence:
	§ `<- @::map(transform)` is the right answer and its Type is
	§ `List<Other>`. Three of them are written in Essence on `List`, and the
	§ runtime writes those out twice; see DEVELOPMENT.md, Native and Essence in
	§ one Namespace.
	§
	§ What the proof does not survive stays on `List`, from `everyItem` and
	§ `slice` to `partition` and `removeEvery(where:)`. The single-item
	§ growers are absent for the opposite reason: `append(_:)`, `prepend(_:)`
	§ and `insert(_:at:)` answer a `NonEmptyList` on `List` itself, whatever
	§ they were handed.
	namespace NonEmptyList<infer ItemType> for NonEmptyList<ItemType> {
		§§ Answers the first item of the List, which certainly has one.
		§§
		§§ @returns — the first item.
		firstItem() -> ItemType

		§§ Answers the last item of the List, which certainly has one.
		§§
		§§ @returns — the last item.
		lastItem() -> ItemType

		§§ Answers how many items the List has, which is at least one.
		§§
		§§ @returns — the number of items, which is above zero.
		length() -> PositiveInteger

		§ Both carry the proof. There is one entry for every item and one
		§ position for every item. So neither can answer nothing when it was
		§ handed something.
		§
		§ `indices` is the native `List` answers with, under this Namespace's
		§ name, so the two entries are one walk. The alternative was an Essence
		§ body counting down through `List.of(integersFrom:downTo:)` to borrow
		§ its promise, then turning the count round. That reverse walks an
		§ array of Integers already built a second time: 100 000 positions
		§ measured 0.90 ms against 0.55 ms for the single walk.

		§§ Answers the positions the List has, in order.
		§§
		§§ The positions count from zero and stop before the length. The answer is a whole List of positions: to walk the items beside their positions in one pass, use `enumerate()`.
		§§
		§§ @returns — the List of positions, which is never empty.
		indices() -> NonEmptyList<Integer>

		§§ Answers every item beside the position it stands at.
		§§
		§§ The position counts from zero.
		§§
		§§ @returns — the List of Records, each holding a position under `index` and the item at it under `item`. It is never empty.
		enumerate() -> NonEmptyList<{ index: Integer, item: ItemType }>

		§ Adding a whole List proves nothing on `List`, because the List added
		§ can be the empty one. Here the receiver is the proof, and what is
		§ added to it is beside the point.

		§§ Answers a new List with the contents of the given List added at the front.
		§§
		§§ @param contentsOf — the List whose items to add
		§§ @returns — the extended List, which is never empty.
		prepend(contentsOf other: List<ItemType>) -> NonEmptyList<ItemType>

		§§ Answers a new List with the contents of the given List added at the end.
		§§
		§§ @param contentsOf — the List whose items to add
		§§ @returns — the extended List, which is never empty.
		append(contentsOf other: List<ItemType>) -> NonEmptyList<ItemType>

		§§ Answers a new List with the given transform applied to every item.
		§§
		§§ @param _ — the transform each item is handed to
		§§ @returns — the List of transformed items, which certainly has something in it.
		map<infer Other>(
			_ transform: (_: ItemType) -> Other,
		) -> NonEmptyList<Other>

		§ The fold with no starting value, which is the proof spent on a
		§ question `List` can not be asked. A seedless fold over the empty
		§ List has nothing to answer with. So peers ship two names for it,
		§ and one of them answers an Optional. Here the receiver carries the
		§ evidence, and one name answers the item outright.
		§
		§ The first item is the starting value, and the rest of the List is
		§ folded into it. The two seeded entries stay on `List`. A call that
		§ writes `startingWith:` finds no entry here and falls to that rung,
		§ as a `defaultingTo:` call on `lowestItem` does.

		§§ Answers the items combined into a single value, with no starting value to give.
		§§
		§§ The first item opens the fold and each item after it is combined into what came before. A List of one item answers that item, and the combiner is not run.
		§§
		§§ @example
		§§   constant total = [1, 2, 3]::reduce((running, item) { <- running::add(item) })
		§§
		§§   expect total::is(6)
		§§
		§§ @param _ — the combiner, handed the value so far and each item
		§§ @returns — the combined value.
		reduce(_ combine: (_: ItemType, _: ItemType) -> ItemType) -> ItemType {
			<- @::removeFirst()::reduce(startingWith @::firstItem(), combine)
		}

		§ Neither `reverse` nor `sort` adds an item or drops one, so the answer
		§ is the receiver's own items in another order. All four are `List`'s
		§ own natives under this Namespace's names.

		§§ Answers a new List with the items in the opposite order.
		§§
		§§ @returns — the reversed List, which certainly has something in it.
		reverse() -> NonEmptyList<ItemType>

		§§ Answers a new List in order, by the items' own ordering, by the given comparison, or by a key.
		§§
		§§ The sort is stable, so items the order does not tell apart keep the order they had, in either direction. The first entry is available whenever the items conform to `Comparable`.
		§§
		§§ A direction is read where one is taken, and it is `#Ascending` when a call names none.
		§§
		§§ @returns — the ordered List, which certainly has something in it.
		overload sort {
			§§ Answers a new List in the given direction, by the items' own ordering.
			§§
			§§ The sort is stable. The entry is available whenever the items conform to `Comparable`. The direction is `#Ascending` when a call names none. For any other order, use the `by:` entry.
			§§
			§§ @param in — the direction to order in, `#Ascending` when it is left out
			§§ @returns — the ordered List, which certainly has something in it.
			<infer ItemType is Comparable>(
				in order: SortOrder = #Ascending,
			) -> NonEmptyList<ItemType>

			§§ Answers a new List ordered by the given comparison, applied to each pair of items.
			§§
			§§ The sort is stable.
			§§
			§§ @param by — the comparison to order the items with
			§§ @returns — the ordered List, which certainly has something in it.
			(
				by comparison: (_: ItemType, _: ItemType) -> Ordering,
			) -> NonEmptyList<ItemType>

			§§ Answers a new List in the given direction of what the key reads off each item.
			§§
			§§ The key is read once per item. The sort is stable, so items whose keys compare equal keep the order they had. The entry is available whenever what the key answers conforms to `Comparable`. The direction is `#Ascending` when a call names none.
			§§
			§§ @param on — the key each item is ordered by
			§§ @param in — the direction to order in, `#Ascending` when it is left out
			§§ @returns — the ordered List, which certainly has something in it.
			<infer Key is Comparable>(
				on key: (_: ItemType) -> Key,
				in order: SortOrder = #Ascending,
			) -> NonEmptyList<ItemType>
		}

		§ Replacing keeps the length in both of the cases `List`'s own entries
		§ have. A position inside the List swaps one item for one item, and a
		§ position outside it answers the receiver untouched.

		§§ Answers a new List with the item at the given position replaced by a given item, or by a transform of it.
		§§
		§§ A negative position counts back from the end: -1 is the last item. A position outside the List leaves it unchanged. No case can empty the List.
		§§
		§§ @returns — the List with the item replaced, which is never empty.
		overload replace {
			§§ Answers a new List with the item at the given position replaced.
			§§
			§§ A negative position counts back from the end: -1 is the last item. A position outside the List leaves it unchanged. Neither case can empty the List.
			§§
			§§ @param _ — the item to put at that position
			§§ @param at — the position of the item to replace
			§§ @returns — the List with the item replaced, which is never empty.
			(_ item: ItemType, at index: Integer) -> NonEmptyList<ItemType>

			§ Written on the entry above, which is native and carries the
			§ proof, so this one carries it too — the shape `sort(on:)` has
			§ here. It is the same body `List` gives the transform entry, over
			§ the proven `replace` instead of the plain one.

			§§ Answers a new List with the item at the given position replaced by what the transform answers for it.
			§§
			§§ A negative position counts back from the end: -1 is the last item. A position outside the List leaves it unchanged, and the transform is not run.
			§§
			§§ @param at — the position of the item to replace
			§§ @param _ — the transform the item at that position is handed to
			§§ @returns — the List with the item replaced, which is never empty.
			(
				at index: Integer,
				_ transform: (_: ItemType) -> ItemType,
			) -> NonEmptyList<ItemType> {
				§ `@` is rebound inside `match`; see DEVELOPMENT.md, Why bodies
				§ look the way they do.
				constant items = @

				<- match @::item(at index) -> NonEmptyList<ItemType> {
					case #Value(item) {
						<- items::replace(transform(item), at index)
					}

					case #Empty { <- items }
				}
			}
		}

		§ Pairing stops with the shorter List, so two Lists that each have
		§ something in them pair at least their first items. The entry on
		§ `List` takes any List, and this one asks the Argument for the proof
		§ the receiver carries. A pairing with the empty List is empty,
		§ whatever the receiver holds.

		§§ Answers the items of the two Lists paired position by position.
		§§
		§§ The pairing stops with the shorter List, which certainly has something in it.
		§§
		§§ @param with — the List to pair the items with
		§§ @returns — a List of Records, each holding one item of this List under `first` and its counterpart under `second`. It is never empty.
		pair<infer Other>(
			with other: NonEmptyList<Other>,
		) -> NonEmptyList<{ first: ItemType, second: Other }>

		§ Splitting a List with something in it opens a group for the first
		§ item, and every group it opens holds one. So the proof is carried
		§ twice: the List of groups has a group, and each group has an item.

		§§ Answers the List split into groups of the given size, in order.
		§§
		§§ The last group holds whatever remains, so it can be shorter. A size below one names no grouping, and the answer is one group holding every item.
		§§
		§§ @param intoGroupsOf — how many items each group holds
		§§ @returns — the List of groups, which certainly has one, and each group certainly has an item.
		split(
			intoGroupsOf size: Integer,
		) -> NonEmptyList<NonEmptyList<ItemType>>

		§ The proof spent again. A List with something in it has an item its
		§ key is lowest at, so these answer the item rather than an Optional.
		§ Each reaches `List`'s own Optional entry through a Namespace
		§ specifier. Without it the bare call would find this very entry, and
		§ `infinite-recursion` would say so. The empty answer the proof rules
		§ out is read off by the first item. So the comparison is written once,
		§ in `List`, and the key Function is called for each item beyond the
		§ first. Nothing can tell this fallback is dead, since
		§ `Optional::value(defaultingTo:)` declares no bare `value()`.

		§§ Answers the lowest item, or the item whose key is lowest, which a non-empty List always has.
		§§
		§§ Ties keep the earlier item.
		§§
		§§ @returns — the item.
		overload lowestItem {
			§§ Answers the item whose key is lowest, which a non-empty List always has.
			§§
			§§ Ties keep the earlier item.
			§§
			§§ @param on — the key the items are ordered by
			§§ @returns — the item.
			<infer Key is Comparable>(
				on key: (_: ItemType) -> Key,
			) -> ItemType {
				<- @::<List>lowestItem(on key)
					::value(defaultingTo @::firstItem())
			}

			§§ Answers the lowest item, which a non-empty List always has.
			§§
			§§ Ties keep the earlier item. The entry is available whenever the items conform to `Comparable`.
			§§
			§§ @returns — the item.
			<infer ItemType is Comparable>() -> ItemType {
				<- @::<List>lowestItem()::value(defaultingTo @::firstItem())
			}
		}

		§§ Answers the highest item, or the item whose key is highest, which a non-empty List always has.
		§§
		§§ Ties keep the earlier item.
		§§
		§§ @returns — the item.
		overload highestItem {
			§§ Answers the item whose key is highest, which a non-empty List always has.
			§§
			§§ Ties keep the earlier item.
			§§
			§§ @param on — the key the items are ordered by
			§§ @returns — the item.
			<infer Key is Comparable>(
				on key: (_: ItemType) -> Key,
			) -> ItemType {
				<- @::<List>highestItem(on key)
					::value(defaultingTo @::firstItem())
			}

			§§ Answers the highest item, which a non-empty List always has.
			§§
			§§ Ties keep the earlier item. The entry is available whenever the items conform to `Comparable`.
			§§
			§§ @returns — the item.
			<infer ItemType is Comparable>() -> ItemType {
				<- @::<List>highestItem()::value(defaultingTo @::firstItem())
			}
		}

		§ Both entries carry the proof. The first item is always kept, so a
		§ List with something in it comes out with something in it. They are
		§ `List`'s own natives under this Namespace's names, so each pair is
		§ one Function under two names and can not come apart.

		§§ Answers a new List keeping only the first occurrence of each item, or the first item met at each key.
		§§
		§§ The kept items keep the order they had. Equality is the items' own `is`, or the keys' own where a key is read.
		§§
		§§ @returns — the List without duplicates, which certainly has something in it.
		overload removeDuplicates {
			§§ Answers a new List keeping only the first occurrence of each item.
			§§
			§§ The kept items keep the order they had. Equality is the items' own `is`. The entry is available whenever the items conform to `Equatable`.
			§§
			§§ @returns — the List without duplicates, which certainly has something in it.
			<infer ItemType is Equatable>() -> NonEmptyList<ItemType>

			§§ Answers a new List keeping only the first item met at each key.
			§§
			§§ The kept items keep the order they had. Equality is the keys' own `is`. The entry is available whenever what the key answers conforms to `Equatable`.
			§§
			§§ @param on — the key read off each item
			§§ @returns — the List holding the first item met at each key, which certainly has something in it.
			<infer Key is Equatable>(
				on key: (_: ItemType) -> Key,
			) -> NonEmptyList<ItemType>
		}
	}

	§ A List of Lists where both proofs are in hand, and the one Method that
	§ answers better for having them. The entry on `NestedList` can promise
	§ nothing about its answer. An outer List with something in it can hold
	§ nothing but empty Lists, and flattening those answers the empty List.
	§ Prove the inner Lists too and that is settled, because the first
	§ group's first item is in the answer.
	§
	§ It mirrors `NestedList`, and sits after it and after `NonEmptyList` for
	§ the reason every proven Namespace sits after the one it narrows.
	namespace NonEmptyNestedList<infer ItemType>
		for NonEmptyList<NonEmptyList<ItemType>>
	{
		§§ Answers the inner Lists flattened by one level, into a single List.
		§§
		§§ Every inner List's items keep their order.
		§§
		§§ @returns — the flattened List, which certainly has something in it.
		flatten() -> NonEmptyList<ItemType>
	}
}

export {
	List
	NestedList
	NonEmptyList
	NonEmptyNestedList
	OptionalList
	ResultList
	SortOrder
}
