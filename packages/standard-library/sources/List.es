import {
	Boolean        from "./Boolean.es"
	Comparable     from "./Comparable.es"
	Integer        from "./Integer.es"
	NonZeroInteger from "./Integer.es"
	Optional       from "./Optional.es"
	Ordering       from "./Ordering.es"
	Equatable      from "./Protocols.es"
	Printable      from "./Protocols.es"
	Step           from "./Step.es"
}

declarations {

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
		is Comparable where ItemType is Comparable {
		§ An Essence body would be length equality and
		§ `pair(with other)::hasItems(onlyWhere …)`, and it can not be written
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

		§§ Answers whether the two Lists differ in any item or in their order.
		§§
		§§ The Method is available whenever the items conform to `Equatable`.
		§§
		§§ @param _ — the List to compare with
		§§ @returns — `true` when the Lists are not equal.
		isNot<infer ItemType is Equatable>(_ other: List<ItemType>) -> Boolean {
			<- @::is(other)::negate()
		}

		§§ Answers the List and its items as a String, in the form `[ 1, 2, 3 ]`.
		§§
		§§ Each item is rendered by its own `toString`. The empty List answers `[]`. The Method is available whenever the items conform to `Printable`.
		§§
		§§ @returns — the String representation of the List.
		toString<infer ItemType is Printable>() -> String

		§§ Answers how many items the List has.
		§§
		§§ @returns — the number of items.
		length() -> Integer

		§ Both quantified entries fold a Boolean. The alternative is
		§ `firstItem(where:)::hasValue()`, which answers the same question and
		§ builds an Optional per call to throw away. So the accumulator carries
		§ the answer rather than the item.

		§§ Answers whether the List has an item, has an item the check accepts, or holds only items the check accepts.
		§§
		§§ @returns — `true` when the List answers the question that was asked.
		overload hasItems {
			§§ Answers whether the List has at least one item.
			§§
			§§ It is the opposite of `isEmpty`.
			§§
			§§ @returns — `true` when the List is not empty.
			() -> Boolean {
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

			§§ Answers whether the check accepts every item.
			§§
			§§ The walk stops at the first item the check refuses. The empty List has no item to fail the check, so it answers `true`.
			§§
			§§ @param onlyWhere — the check each item is offered to
			§§ @returns — `true` when the check accepts every item.
			(onlyWhere check: (_: ItemType) -> Boolean) -> Boolean {
				<- @::hasItems(where (item) { <- check(item)::negate() })
					::negate()
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
			<- @::contains(item)::negate()
		}

		§ Every Method below that can answer empty offers a `defaultingTo:`
		§ entry beside it, answering the bare Type. Each of those entries is
		§ written on `Optional::value(defaultingTo:)`.

		§§ Answers the first item, or the first item the check accepts.
		§§
		§§ @returns — the matching item, or nothing when there is none.
		overload firstItem {
			() -> Optional<ItemType> {
				§ `item(at:)` answers empty for a position outside the List, so
				§ the empty List needs no guard here.
				<- @::item(at 0)
			}

			§ Written on `reduce`'s early-stopping entry, so the fold finishes
			§ at the first accepted item and never walks the rest.
			§ `everyItem(where:)::firstItem()` walks every item.
			§
			§ On a `List<Optional<Item>>` the answer is an
			§ `Optional<Optional<Item>>`, and the two levels say different
			§ things. An `#Empty` answer means no item matched. A
			§ `#Value(#Empty)` answer means the item that matched is itself
			§ empty.
			(where check: (_: ItemType) -> Boolean) -> Optional<ItemType> {
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
		§§ @returns — the matching item, or nothing when there is none.
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
			§§ @param where — the check each item is offered to
			§§ @returns — the matching item, or nothing when no item is accepted.
			(where check: (_: ItemType) -> Boolean) -> Optional<ItemType> {
				§ The last accepted item is the first accepted item of the
				§ reversed List. So `firstItem(where:)` answers this one too,
				§ and stops at the item that decides it.
				<- @::reverse()::firstItem(where check)
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
			<infer ItemType is Equatable>(_ item: ItemType) -> List<ItemType> {
				<- @::removeEvery(where (candidate) { <- candidate::is(item) })
			}

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
			if count::isLessThan(1) {
				<- @
			} else if count::isGreaterThanOrEqualTo(@::length()) {
				<- []
			} else {
				<- @::slice(to @::length()::subtract(count))
			}
		}

		§§ Answers a new List keeping only the first occurrence of each item, in the original order.
		§§
		§§ Equality is the items' own `is`. The Method is available whenever the items conform to `Equatable`.
		§§
		§§ @returns — the List without duplicates.
		removeDuplicates<infer ItemType is Equatable>() -> List<ItemType> {
			§ Quadratic, as the native was: each item is looked for among the
			§ ones kept so far.
			constant kept: List<ItemType> = []

			<- @::reduce(startingWith kept, (accumulated, item) {
				if accumulated::contains(item) {
					<- accumulated
				} else {
					<- accumulated::append(item)
				}
			})
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
		§§ @returns — the List of accepted items.
		everyItem(where check: (_: ItemType) -> Boolean) -> List<ItemType>

		§§ Answers the item at the given position.
		§§
		§§ The position counts from zero. A negative position counts back from the end: -1 is the last item. The furthest a negative position reaches back is the first item.
		§§
		§§ @returns — the item, or nothing when the position is outside the List.
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
		§§ @returns — the zero-based position, or nothing when there is no such item.
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
		§§ @returns — the reversed List.
		reverse() -> List<ItemType>

		§ The `Comparable` bound resolves the conforming Namespace at the call
		§ site: `Integer` for a `List<Integer>`, and the covering `Number` for a
		§ mixed numeric List.
		§
		§ Both entries are native. In Essence the no-Argument body would be
		§ `@::sort(by …)`, a call that has to pick between the two entries here.
		§ Picking one is what would give the comparison's Parameters their
		§ Types. Annotating them does not rescue it either. This entry's bounded
		§ `ItemType` shadows the Namespace's, so the annotated Function is typed
		§ in a different `ItemType` than the `by:` entry expects.

		§§ Answers a new List in order, by the items' own ordering or by the given comparison.
		§§
		§§ The no-Argument entry is available whenever the items conform to `Comparable`.
		§§
		§§ @returns — the ordered List.
		overload sort {
			§§ Answers a new List in ascending order, by the items' own ordering.
			§§
			§§ The entry is available whenever the items conform to `Comparable`. For any other order, use the `by:` entry.
			§§
			§§ @returns — the ordered List.
			<infer ItemType is Comparable>() -> List<ItemType>

			§§ Answers a new List ordered by the given comparison, applied to each pair of items.
			§§
			§§ @param by — the comparison to order the items with
			§§ @returns — the ordered List.
			(
				by comparison: (_: ItemType, _: ItemType) -> Ordering,
			) -> List<ItemType>
		}

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

		§§ Answers how many items equal the given one, or how many items the check accepts.
		§§
		§§ Equality is the items' own `is`. The by-value entry is available whenever the items conform to `Equatable`.
		§§
		§§ @returns — the count.
		overload count {
			<infer ItemType is Equatable>(of item: ItemType) -> Integer {
				<- @::count(where (candidate) { <- candidate::is(item) })
			}

			(where check: (_: ItemType) -> Boolean) -> Integer {
				<- @::everyItem(where check)::length()
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

		§§ Answers a new List with the item at the given position replaced.
		§§
		§§ A negative position counts back from the end: -1 is the last item. A position outside the List leaves it unchanged.
		§§
		§§ @param _ — the item to put at that position
		§§ @param at — the position of the item to replace
		§§ @returns — the List with the item replaced.
		replace(_ item: ItemType, at index: Integer) -> List<ItemType> {
			constant length = @::length()

			§ The guard is needed, because `remove(at:)` ignores a position
			§ outside the List but `insert(_:at:)` clamps it. Without it the
			§ item would be added at an end.
			§
			§ A negative position is resolved first, because `remove(at:)`
			§ shortens the List before `insert(_:at:)` reads the position again.
			§ The same negative position names a different place in the shorter
			§ List.
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

		§§ Answers the position of the last item equal to the given one.
		§§
		§§ Equality is the items' own `is`. The Method is available whenever the items conform to `Equatable`.
		§§
		§§ @returns — the zero-based position, or nothing when the item is absent.
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
				§ The last occurrence is the first occurrence of the reversed
				§ List. So `firstIndex` answers this one too, and only the
				§ position is counted back from the end.
				§
				§ The empty List reverses to itself and finds nothing, so it
				§ needs no guard. The -1 that `lastPosition` holds never reaches
				§ the subtraction, because `map` does not run on an empty
				§ Optional.
				constant lastPosition = @::length()::subtract(1)

				<- @::reverse()
					::firstIndex(of item)
					::map((position) { <- lastPosition::subtract(position) })
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
		}

		§ The bound does real work here rather than restating a conformance of
		§ List's own. An item with no `Printable` conformance is refused at the
		§ bound, which names the Protocol that is missing.

		§§ Answers the items joined into one String, with the given separator between them.
		§§
		§§ Each item is rendered by its own `toString`: `[1, 2, 3]::join(with ", ")` is `"1, 2, 3"`. For a List of Strings the Method undoes `String::split(on:)`. It is available whenever the items conform to `Printable`.
		§§
		§§ @param with — the separator to place between the items
		§§ @returns — the joined String. The empty List answers the empty String.
		join<infer ItemType is Printable>(with separator: String) -> String

		§ `flatten` is not here: it is not available on every List, and every
		§ Method of this Namespace is. `NestedList` below holds it.

		§§ Answers the List split in two by the check: the accepted items, and the rest.
		§§
		§§ Both halves keep the original order.
		§§
		§§ @param where — the check each item is offered to
		§§ @returns — a Record holding the accepted items under `matching` and the others under `rest`.
		partition(
			where check: (_: ItemType) -> Boolean,
		) -> { matching: List<ItemType>, rest: List<ItemType> } {
			§ Two passes where the native made one. The cost is the two walks
			§ either way.
			<- {
				matching = @::everyItem(where check),
				rest = @::removeEvery(where check),
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

		§§ Answers the List split into groups of the given size, in order.
		§§
		§§ The last group holds whatever remains, so it can be shorter. A size below one names no grouping, and the answer is one group holding every item. The empty List answers no groups at all, whatever the size.
		§§
		§§ @param intoGroupsOf — how many items each group holds
		§§ @returns — the List of groups.
		split(intoGroupsOf size: Integer) -> List<List<ItemType>>

		§§ Answers a List holding the given item the given number of times.
		§§
		§§ A count of zero or less answers the empty List.
		§§
		§§ @param _ — the item to repeat
		§§ @param times — how many copies the List holds
		§§ @returns — the List of repeated items.
		static repeat(
			_ item: ItemType,
			times count: Integer,
		) -> List<ItemType> {
			§ `of` counts down when the first Integer is the greater, so a count
			§ below one would answer `[1]` rather than nothing. The guard
			§ answers the empty List instead.
			if count::isLessThan(1) {
				<- []
			} else {
				§ The Integers are only the tally. Each is replaced by the item.
				<- List.of(integersFrom 1, through count)::map((_) { <- item })
			}
		}

		§ Essence has no Range Type, so a counting loop writes
		§ `List.of(integersFrom 1, through 10)::map(…)`. The Method is fixed to
		§ Integers, so the Namespace's `ItemType` has nothing to merge into.
		§
		§ Both ends are included, so the shortest List it builds is the one-item
		§ `[start]`, and counting down covers the rest. No pair of Integers
		§ answers empty, and the return Type is where that is written down.

		§§ Answers the Integers from one value through another, both included.
		§§
		§§ The count runs down when the first value is the greater. There is always at least the first value, so the answer certainly has something in it.
		§§
		§§ @param integersFrom — the first Integer of the List
		§§ @param through — the last Integer of the List, which is included
		§§ @returns — the List of Integers, which is never empty.
		static of(
			integersFrom start: Integer,
			through end: Integer,
		) -> NonEmptyList<Integer>
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

	§ The Methods the proof changes. A NonEmptyList already answers every
	§ Method of `List`. A Namespace of its own is for the Methods that answer
	§ better for having the proof.
	§
	§ Three Methods spend the proof: `firstItem`, `lastItem` and `length`.
	§ Everything else here carries it forward. Each answers with one item for
	§ every item it was handed, or with those items and more besides. So none
	§ of them can empty a List that was not empty. They are declared in the
	§ order `List` declares them, so the two can be read side by side.
	§
	§ Every entry is native, because the promise can not be said in Essence:
	§ `<- @::map(transform)` is the right answer and its Type is
	§ `List<Result>`. Only three of them are written in Essence on `List`:
	§ `prepend(contentsOf:)`, `removeDuplicates` and `replace`. For those the
	§ runtime writes the same operation out beside it. The harness calls both
	§ entries over the same inputs, so that the two can not drift.
	§
	§ What the proof does not survive stays on `List`, from `everyItem` and
	§ `slice` to `partition` and `split`. The single-item growers are absent
	§ for the opposite reason: `append(_:)`, `prepend(_:)` and `insert(_:at:)`
	§ answer a `NonEmptyList` on `List` itself, whatever they were handed.
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

		§ Removing duplicates keeps the first of every group of equal items, so
		§ it keeps at least one of whatever it was handed.

		§§ Answers a new List keeping only the first occurrence of each item, in the original order.
		§§
		§§ Equality is the items' own `is`. The Method is available whenever the items conform to `Equatable`.
		§§
		§§ @returns — the List without duplicates, which certainly has something in it.
		removeDuplicates<infer ItemType is Equatable>() -> NonEmptyList<ItemType>

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
		§ is the receiver's own items in another order.

		§§ Answers a new List with the items in the opposite order.
		§§
		§§ @returns — the reversed List, which certainly has something in it.
		reverse() -> NonEmptyList<ItemType>

		§§ Answers a new List in order, by the items' own ordering or by the given comparison.
		§§
		§§ The no-Argument entry is available whenever the items conform to `Comparable`.
		§§
		§§ @returns — the ordered List, which certainly has something in it.
		overload sort {
			§§ Answers a new List in ascending order, by the items' own ordering.
			§§
			§§ The entry is available whenever the items conform to `Comparable`. For any other order, use the `by:` entry.
			§§
			§§ @returns — the ordered List, which certainly has something in it.
			<infer ItemType is Comparable>() -> NonEmptyList<ItemType>

			§§ Answers a new List ordered by the given comparison, applied to each pair of items.
			§§
			§§ @param by — the comparison to order the items with
			§§ @returns — the ordered List, which certainly has something in it.
			(
				by comparison: (_: ItemType, _: ItemType) -> Ordering,
			) -> NonEmptyList<ItemType>
		}

		§ Replacing keeps the length in both of the cases `List`'s own entry
		§ has. A position inside the List swaps one item for one item, and a
		§ position outside it answers the receiver untouched.

		§§ Answers a new List with the item at the given position replaced.
		§§
		§§ A negative position counts back from the end: -1 is the last item. A position outside the List leaves it unchanged. Neither case can empty the List.
		§§
		§§ @param _ — the item to put at that position
		§§ @param at — the position of the item to replace
		§§ @returns — the List with the item replaced, which is never empty.
		replace(_ item: ItemType, at index: Integer) -> NonEmptyList<ItemType>
	}
}

export {
	List
	NestedList
	NonEmptyList
}
