import {
	from "./Boolean.es" { Boolean }
	from "./Comparable.es" { Comparable }
	from "./Integer.es" {
		Integer
		NonZeroInteger
		PositiveInteger
	}
	from "./Optional.es" { Optional }
	from "./Ordering.es" { Ordering }
	from "./Protocols.es" {
		Equatable
		Printable
	}
	from "./Step.es" { Step }
}

declarations {

	§ Which way `sort` runs. The Choice is declared beside its only user, and
	§ `#Ascending` is the default. Descending is not a sort followed by a
	§ reverse. The comparison is turned around instead, so items the order
	§ does not tell apart keep the order they had.
	choice SortOrder {
		Ascending,
		Descending,
	}

	§ Equality and printing are both derived for a Choice of Cases that carry
	§ no payload. This Namespace declares the two and writes neither; see
	§ DEVELOPMENT.md, Why bodies look the way they do.
	namespace SortOrder for SortOrder is Equatable, is Printable {}

	§ The Lists that have something in them. It is a checked refinement: the
	§ predicate is what a value has to be proven to satisfy, and the proof is
	§ what the Type carries.
	§
	§ Three routes reach the proof. A List written down with items in it is its
	§ own proof. A List a Program is handed goes through an `if` asking
	§ `hasItems`. And `append(_:)`, `prepend(_:)`, `insert(_:at:)` and
	§ `of(integersFrom:through:)` each put something in what they were given,
	§ so each answers with this Type.
	§
	§ The predicate asks nothing about the item Type, so one predicate serves
	§ every List and the Type Argument stays in the base.
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
				§ `of` counts down when the first Integer is the greater, so a
				§ count below one would answer `[1]` rather than nothing. The
				§ guard answers the empty List instead.
				if count::isLessThan(1) {
					<- []
				} else {
					§ The Integers are only the tally. Each is replaced by the
					§ item.
					<- List.of(integersFrom 1, through count)::map((_) {
						<- item
					})
				}
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
		§ Two entries, because a range written from a length has to be able to
		§ be empty. The `through:` entry counts down when the first Integer is
		§ the greater, so no pair of Integers answers empty. A length of zero
		§ reaches `through -1` and gets `[0, -1]` for it. The `upTo:` entry
		§ stops before the end and only counts up, so it answers the empty
		§ List instead.

		§§ Answers the Integers of a range, through the last value or up to it.
		§§
		§§ The `through:` entry includes both ends and counts in either direction. The `upTo:` entry stops before the end and only counts up.
		§§
		§§ @returns — the List of Integers.
		overload static of {
			§§ Answers the Integers from one value through another, both included.
			§§
			§§ The count runs down when the first value is the greater. There is always at least the first value, so the answer certainly has something in it.
			§§
			§§ @param integersFrom — the first Integer of the List
			§§ @param through — the last Integer of the List, which is included
			§§ @returns — the List of Integers, which is never empty.
			(
				integersFrom start: Integer,
				through end: Integer,
			) -> NonEmptyList<Integer>

			§§ Answers the Integers from one value up to, but not including, another.
			§§
			§§ The count only runs up. An end at or below the start answers the empty List.
			§§
			§§ @param integersFrom — the first Integer of the List
			§§ @param upTo — the Integer the List stops before
			§§ @returns — the List of Integers. It is empty when the end is not above the start.
			(integersFrom start: Integer, upTo end: Integer) -> List<Integer> {
				if end::isGreaterThan(start) {
					<- List.of(integersFrom start, through end::subtract(1))
				} else {
					<- []
				}
			}
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

		§§ Answers whether an item equal to the given one is in the List.
		§§
		§§ Equality is the items' own `is`. The Method is available whenever the items conform to `Equatable`.
		§§
		§§ @param _ — the item to look for
		§§ @returns — `true` when the item occurs.
		contains<infer ItemType is Equatable>(_ item: ItemType) -> Boolean {
			<- @::hasItems(where (candidate) { <- candidate::is(item) })
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

		§§ Answers how many items the List has.
		§§
		§§ @returns — the number of items.
		length() -> Integer

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

		§§ Answers the positions the List has, in order.
		§§
		§§ The positions count from zero and stop before the length. The empty List answers no positions. The answer is a whole List of positions: to walk the items beside their positions in one pass, use `enumerate()`.
		§§
		§§ @returns — the List of positions.
		indices() -> List<Integer> {
			<- List.of(integersFrom 0, upTo @::length())
		}

		§§ Answers every item beside the position it stands at.
		§§
		§§ The position counts from zero. The empty List answers no entries.
		§§
		§§ @returns — the List of Records, each holding a position under `index` and the item at it under `item`.
		enumerate() -> List<{ index: Integer, item: ItemType }>

		§§ Answers a new List without the first item, or without the given number of leading items.
		§§
		§§ The answer is empty when more items are removed than the List has. A count below one removes nothing.
		§§
		§§ @param _ — how many leading items to remove, which is one when it is left out
		§§ @returns — the shortened List.
		removeFirst(_ count: Integer = 1) -> List<ItemType> {
			§ The Parameter is a count, not a position. A negative count would
			§ reach `slice` as a position counting back from the end, so the
			§ guard answers the receiver instead. A count past the length
			§ reaches `slice`'s own clamping and leaves nothing.
			§
			§ On the empty List the default slices `[1, 0)`, an inverted range,
			§ which `slice` answers empty.
			if count::isLessThan(0) {
				<- @
			} else {
				<- @::slice(from count)
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
		}

		§§ Answers a new List without the last item, or without the given number of trailing items.
		§§
		§§ The answer is empty when more items are removed than the List has. A count below one removes nothing.
		§§
		§§ @param _ — how many trailing items to remove, which is one when it is left out
		§§ @returns — the shortened List.
		removeLast(_ count: Integer = 1) -> List<ItemType> {
			§ The Parameter is a count, not a position. A count at or past the
			§ length makes the subtraction go negative, and `slice` would read
			§ that as a position counting back from the end. Both ends are
			§ answered here instead.
			<- define {
				as @  if count::isLessThan(1)
				as [] if count::isGreaterThanOrEqualTo(@::length())
				as @::slice(to @::length()::subtract(count)) otherwise
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

		§ `map` and `reduce` each carry a Method level Generic, and `reduce`
		§ reads its `Result` from `startingWith`; see DEVELOPMENT.md, Why bodies
		§ look the way they do. The Namespace's `ItemType` merges in ahead of
		§ that Generic, so each Method is generic in `[ItemType, Result]`.

		§§ Answers a new List with the given transform applied to every item.
		§§
		§§ @param _ — the transform each item is handed to
		§§ @returns — the List of transformed items.
		map<infer Result>(_ transform: (_: ItemType) -> Result) -> List<Result>

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
			<infer Result>(
				startingWith initial: Result,
				_ combine: (_: Result, _: ItemType) -> Result,
			) -> Result

			§§ Answers the items combined into a single value, starting from the given one, and can stop before the end.
			§§
			§§ The `step` combiner answers with a `Step`: `#Continue` carries the value forward, and `#Done` finishes at once with its own value. The empty List answers the starting value untouched.
			§§
			§§ @param startingWith — the value the first combination builds on
			§§ @param step — the combiner, handed the value so far and each item, answering with a `Step`
			§§ @returns — the combined value, or the value the first `#Done` carries.
			<infer Result>(
				startingWith initial: Result,
				step combine: (_: Result, _: ItemType) -> Step<Result, Result>,
			) -> Result
		}

		§ The filter, and the complement of `removeEvery(where:)`. There is no
		§ by-value entry: keeping the items equal to a given value is what
		§ `contains` already answers.

		§§ Answers a new List of every item the check accepts.
		§§
		§§ Each item is offered to the check, and the accepted items keep their order.
		§§
		§§ @param where — the check each item is offered to
		§§ @returns — the List of accepted items.
		everyItem(where check: (_: ItemType) -> Boolean) -> List<ItemType>

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
			§§ @returns — how many items equal it.
			<infer ItemType is Equatable>(of item: ItemType) -> Integer {
				<- @::count(where (candidate) { <- candidate::is(item) })
			}

			§§ Answers how many items the check accepts.
			§§
			§§ @param where — the check each item is offered to
			§§ @returns — how many items the check accepts.
			(where check: (_: ItemType) -> Boolean) -> Integer {
				§ One fold carrying the total, over a filter whose length was
				§ read: the filter built a List of every accepted item to throw
				§ away. Counting has to see every item either way, so the walk
				§ is the same. What each accepted item costs is the difference:
				§ the filter pushed it, and the fold adds one to a number. Two
				§ thousand counts of 20,000 items with every item accepted
				§ measured 155 ms on the filter and 78 ms on the fold. With
				§ `isEven` they measured 275 ms and 231 ms.
				<- @::reduce(startingWith 0, (total, item) {
					if check(item) {
						<- total::add(1)
					} else {
						<- total
					}
				})
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

		§§ Answers the List split in two by the check: the items it accepts, and the items it refuses.
		§§
		§§ Both halves keep the original order. Each item is offered to the check once.
		§§
		§§ @param where — the check each item is offered to
		§§ @returns — a Record holding the accepted items under `accepted` and the others under `refused`.
		partition(
			where check: (_: ItemType) -> Boolean,
		) -> { accepted: List<ItemType>, refused: List<ItemType> }

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
		§ the answer says. A group is opened for an item and never for the
		§ space after one. So the shorter last group exists only when
		§ something remains to put in it. A size below one answers one group
		§ holding everything, and the empty List answers no groups.

		§§ Answers the List split into groups of the given size, in order.
		§§
		§§ The last group holds whatever remains, so it can be shorter. Every group holds at least one item. A size below one names no grouping, and the answer is one group holding every item. The empty List answers no groups at all, whatever the size.
		§§
		§§ @param intoGroupsOf — how many items each group holds
		§§ @returns — the List of groups, each of which certainly has something in it.
		split(intoGroupsOf size: Integer) -> List<NonEmptyList<ItemType>>

		§ The item a key is lowest or highest at. That is a different
		§ question from `lowestNumber`, which answers a number the List holds.
		§ This one answers the item a number was read off. The return Type is
		§ what tells them apart, so rule 4 does not make these Overloads of it.
		§
		§ Both walk once. They are written on `reduce` rather than on
		§ `sort(on key)::firstItem()`, which answers the same item for n log n
		§ comparisons instead of n.

		§§ Answers the item whose key is lowest.
		§§
		§§ Ties keep the earlier item. The empty List has no such item, and the `defaultingTo:` entry answers the given item in place of nothing.
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
		}

		§§ Answers the item whose key is highest.
		§§
		§§ Ties keep the earlier item. The empty List has no such item, and the `defaultingTo:` entry answers the given item in place of nothing.
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

		§§ Answers a new List of the leading items, up to the given count.
		§§
		§§ A count below one answers the empty List. A count past the length answers every item.
		§§
		§§ @param _ — how many leading items to keep
		§§ @returns — the List of leading items, in the order they were in.
		firstItems(_ count: Integer) -> List<ItemType> {
			if count::isLessThan(1) {
				<- []
			} else {
				<- @::slice(to count)
			}
		}

		§§ Answers a new List of the trailing items, up to the given count.
		§§
		§§ A count below one answers the empty List. A count past the length reaches back past the start, where `slice` settles on zero, so it answers every item.
		§§
		§§ @param _ — how many trailing items to keep
		§§ @returns — the List of trailing items, in the order they were in.
		lastItems(_ count: Integer) -> List<ItemType> {
			if count::isLessThan(1) {
				<- []
			} else {
				<- @::slice(from count::negate())
			}
		}
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
	}

	§ A List of Optionals, and the one Method only such a List can answer. Its
	§ `ItemType` binds to the payload Type, so `values()` answers a
	§ `List<Integer>` for a `List<Optional<Integer>>`. No Protocol bound can
	§ name a Type that is not in the signature. That is why it is not a Method
	§ of `List`, for the reason `flatten` is not.
	§
	§ Written in Essence on `reduce` and `append`, which reaches only `List`'s
	§ own primitives. A native would fill one Array of the answer's own size
	§ instead of a box per kept item. Neither saves the other a walk.
	§
	§ There is no proven twin. A List with something in it can hold nothing but
	§ empty Optionals, so a proof about the receiver says nothing about the
	§ answer.
	namespace OptionalList<infer ItemType> for List<Optional<ItemType>> {
		§§ Answers the values the Optionals hold, in order.
		§§
		§§ The empty Optionals are left out, so the answer can be shorter than the receiver. A List of empty Optionals answers the empty List.
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
	§ `List<Result>`. Three of them are written in Essence on `List`, and the
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
		§§ @returns — the number of items, which is never zero.
		length() -> NonZeroInteger

		§ Both carry the proof. There is one entry for every item and one
		§ position for every item. So neither can answer nothing when it was
		§ handed something. The `indices` body is written on
		§ `List.of(integersFrom:through:)`, which promises that already. It
		§ carries a proof another Method holds rather than minting one.

		§§ Answers the positions the List has, in order.
		§§
		§§ The positions count from zero and stop before the length. The answer is a whole List of positions: to walk the items beside their positions in one pass, use `enumerate()`.
		§§
		§§ @returns — the List of positions, which is never empty.
		indices() -> NonEmptyList<Integer> {
			<- List.of(integersFrom 0, through @::length()::subtract(1))
		}

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
		map<infer Result>(
			_ transform: (_: ItemType) -> Result,
		) -> NonEmptyList<Result>

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

		§§ Answers the item whose key is lowest, which a non-empty List always has.
		§§
		§§ Ties keep the earlier item.
		§§
		§§ @param on — the key the items are ordered by
		§§ @returns — the item.
		lowestItem<infer Key is Comparable>(
			on key: (_: ItemType) -> Key,
		) -> ItemType {
			<- @::<List>lowestItem(on key)::value(defaultingTo @::firstItem())
		}

		§§ Answers the item whose key is highest, which a non-empty List always has.
		§§
		§§ Ties keep the earlier item.
		§§
		§§ @param on — the key the items are ordered by
		§§ @returns — the item.
		highestItem<infer Key is Comparable>(
			on key: (_: ItemType) -> Key,
		) -> ItemType {
			<- @::<List>highestItem(on key)::value(defaultingTo @::firstItem())
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
	SortOrder
}
