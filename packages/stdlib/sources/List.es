declarations {

	§ The ordered sequence, and everything that reads or rebuilds one. Every
	§ Method here is a Query — a List is never changed in place, a new List is
	§ returned.
	§
	§ `ItemType` is the Namespace's own Type Parameter, and it is merged into a
	§ Method's signature exactly when that signature mentions it. `of` fixes
	§ its Types outright (an Integer-only result), so it does not carry it; the
	§ bounded Methods below declare their own `ItemType`, bounded by the
	§ Protocol each of them needs, which shadows the Namespace's outright.
	§
	§ A Method that asks something of the items asks for it with a BOUND, not
	§ with a narrower receiver — the Method stays here, on the Namespace that
	§ targets every List, and the bound is what a use site has to satisfy. One
	§ Method can not be written that way and is NOT here: `NestedList` below
	§ holds `flatten`, because no bound can say "the items are themselves
	§ Lists" and still name the inner item Type.
	§
	§ The Equatable and Comparable conformances are BOTH conditional — a List is
	§ equatable exactly when its items are, and orderable exactly when its items
	§ are. `is` and `compareTo` carry the same bound as their own Method
	§ Generic, so a use site solving `List<ItemType> is Equatable` recursively
	§ solves `ItemType is Equatable` and hands the item equality in as the
	§ hidden conformance Argument. That recursion is what makes a
	§ `List<List<Integer>>` compare through Integer's own `is`, one nesting
	§ level at a time.
	§
	§ Every Method that asks whether two ITEMS are equal — `is`, `contains`,
	§ `firstIndex`, `lastIndex`, `count(of:)`, `removeEvery(_:)` and
	§ `removeDuplicates` — carries that bound, for the same reason `sort`
	§ carries `Comparable`: equality is the item Type's own `is`, and a List
	§ whose items can not answer it can not be searched by value. The universal
	§ structural comparison that stood in for it before was not a Type the
	§ language could name, and gave `1/2` and `2/4` whatever answer the runtime
	§ representation happened to give.
	namespace List<infer ItemType> for List<ItemType>
		is Printable,
		is Equatable where ItemType is Equatable,
		is Comparable where ItemType is Comparable {
		§ NOTE: This would read better in Essence — length equality AND
		§ `pair(with other)::everyItem(matches (pair) { … })` — and it can not
		§ be written that way yet. Binding a List Method's own `ItemType` to a
		§ Type that MENTIONS `ItemType` (the pair Record) makes inference
		§ substitute the name into itself and recurse until the stack runs out.
		§ The bound has nothing to do with it: a plain
		§ `function f<ItemType>(_ a: List<ItemType>, _ b: List<ItemType>) { <-
		§ a::pair(with b)::everyItem(…) }` overflows the same way, and did
		§ before any of this. So `is` stays native and takes the witness — it
		§ compares each pair with the items' own `is` rather than structurally,
		§ exactly as `compareTo` below does with their `compareTo`.

		§§ Checks whether the Lists are structurally equal — the same items in the same order, each pair compared with the items' own `is`. Available whenever the items conform to `Equatable`.
		§§
		§§ @param other the value to compare with
		§§ @returns `true` when the Lists are equal.
		is<infer ItemType is Equatable>(_ other: List<ItemType>) -> Boolean

		§§ Checks whether the Lists differ — in any item or in their order. Available whenever the items conform to `Equatable`.
		§§
		§§ @param other the value to compare with
		§§ @returns `true` when the Lists are not equal.
		isNot<infer ItemType is Equatable>(_ other: List<ItemType>) -> Boolean {
			<- @::is(other)::negate()
		}

		§§ Represents the List and its items as a String.
		§§
		§§ @returns the String representation of the List.
		toString() -> String

		§§ How many items the List has.
		§§
		§§ @returns the number of items.
		length() -> Integer

		§§ Whether the List has at least one item — the opposite of `isEmpty`.
		§§
		§§ @returns `true` when the List is not empty.
		hasItems() -> Boolean {
			<- @::isEmpty()::negate()
		}

		§§ Whether the List has no items at all.
		§§
		§§ @returns `true` for the empty List.
		isEmpty() -> Boolean {
			§ `List.length` is native and O(1) — it reads the underlying array's
			§ length — so asking for it costs nothing. `String.isEmpty` is
			§ written the same way, but there `length` walks the characters.
			<- @::length()::is(0)
		}

		§§ Whether an item equal to the given one — by the items' own `is` — is in the List. Available whenever the items conform to `Equatable`.
		§§
		§§ @param item the item to look for
		§§ @returns `true` when the item occurs.
		contains<infer ItemType is Equatable>(_ item: ItemType) -> Boolean {
			§ The bound is the whole of the difference from `anyItem`: the
			§ conforming Namespace's `is` arrives as the hidden conformance
			§ Argument, and this hands it straight on as the check.
			<- @::anyItem(matches (candidate) { <- candidate::is(item) })
		}

		§§ Whether no item equal to the given one is in the List. Available whenever the items conform to `Equatable`.
		§§
		§§ @param item the item to look for
		§§ @returns `true` when the item does not occur.
		doesNotContain<infer ItemType is Equatable>(
			_ item: ItemType,
		) -> Boolean {
			<- @::contains(item)::negate()
		}

		§§ The first item, or the first item the given check accepts.
		§§
		§§ @returns the matching item, or `Nothing` when there is none.
		overload firstItem {
			() -> Optional<ItemType> {
				§ `item(at:)` answers `Nothing` for a position outside the List, so
				§ the empty case needs no guard of its own.
				<- @::item(at 0)
			}

			§ Written on `reduce`'s early-stopping entry — the fold `#Done`s at
			§ the first accepted item and never walks the rest. Stopping at the
			§ first match is the whole of the difference from
			§ `keepEvery(where:)::firstItem()`, and leaving a walk before its end is
			§ what the `Step` Choice made an Essence expression able to do — this
			§ Method was native until it existed.
			§
			§ What this Method can NOT say is which of two things happened when it
			§ answers `Nothing`: no item matched, or the item that matched IS
			§ `nothing`. Both are the same value, and no return Type here can tell
			§ them apart. So the Methods that only want the DECISION —
			§ `anyItem`/`everyItem`, and `firstIndex`/`lastIndex` for the position —
			§ step the same fold themselves, carrying a Boolean or an Integer, and
			§ are not written on top of this one.
			(where check: (_: ItemType) -> Boolean) -> Optional<ItemType> {
				§ `reduce` binds its `Result` from the `startingWith` value, and a
				§ bare `nothing` would fix it to `Nothing` alone — so the seed is
				§ annotated to the `Optional` the accumulator and the answer share.
				§ The accumulator is only ever `nothing`: it is carried untouched
				§ until a match `#Done`s the whole fold with the item itself.
				constant start: Optional<ItemType> = nothing

				<- @::reduce(startingWith start, step (found, item) {
					if check(item) {
						<- #Done(item)
					}

					<- #Continue(found)
				})
			}
		}

		§§ The last item of the List.
		§§
		§§ @returns the item, or `Nothing` for the empty List.
		lastItem() -> Optional<ItemType> {
			§ The empty List's last position is -1, which is outside it, so
			§ `item(at:)` answers `Nothing` without a guard here.
			<- @::item(at @::length()::subtract(1))
		}

		§§ A new List without the first item, or without the given number of leading items.
		§§
		§§ @returns the shortened List — empty when more items were removed than it had.
		overload removeFirst {
			() -> List<ItemType> {
				§ On the empty List this slices [1, 0), an inverted range, which
				§ `slice` answers with the empty List.
				<- @::slice(from 1, to @::length())
			}

			(_ count: Integer) -> List<ItemType> {
				§ `slice` clamps both ends to the List, which is exactly the
				§ clamping this needs: a count below one clamps the start to
				§ zero and keeps every item, and a count at or past the length
				§ clamps it to the length, leaving nothing.
				<- @::slice(from count, to @::length())
			}
		}

		§§ A new List without the item at the given position, counting from zero.
		§§
		§§ @param index the position of the item to remove
		§§ @returns the List without that item, or unchanged when the position is outside it.
		remove(at index: Integer) -> List<ItemType> {
			§ Everything before the position, then everything after it. A
			§ position outside the List leaves it unchanged without a guard: a
			§ negative one empties the first slice and clamps the second's start
			§ to zero, and one at or past the end fills the first slice with the
			§ whole List and empties the second.
			<- @
				::slice(from 0, to index)
				::append(
					contentsOf @::slice(from index::add(1), to @::length()),
				)
		}

		§§ A new List without every item equal — by the items' own `is` — to the given one, or without every item the given check accepts. The by-value entry is available whenever the items conform to `Equatable`.
		§§
		§§ @returns the List of remaining items.
		overload removeEvery {
			<infer ItemType is Equatable>(_ item: ItemType) -> List<ItemType> {
				<- @::removeEvery(where (candidate) { <- candidate::is(item) })
			}

			(where check: (_: ItemType) -> Boolean) -> List<ItemType> {
				<- @::keepEvery(where (item) { <- check(item)::negate() })
			}
		}

		§§ A new List without the last item, or without the given number of trailing items.
		§§
		§§ @returns the shortened List — empty when more items were removed than it had.
		overload removeLast {
			() -> List<ItemType> {
				§ On the empty List the end is -1, which `slice` clamps to zero
				§ — an empty range, so the empty List comes back unchanged.
				<- @::slice(from 0, to @::length()::subtract(1))
			}

			(_ count: Integer) -> List<ItemType> {
				§ Again `slice`'s clamping is the clamping this needs: a count
				§ below one puts the end past the length and keeps every item,
				§ and a count at or past the length drives it below zero,
				§ leaving nothing.
				<- @::slice(from 0, to @::length()::subtract(count))
			}
		}

		§§ A new List keeping only the first occurrence of each item — by the items' own `is` — in the original order. Available whenever the items conform to `Equatable`.
		§§
		§§ @returns the List without duplicates.
		removeDuplicates<infer ItemType is Equatable>() -> List<ItemType> {
			§ NOTE: Quadratic, as the native was — each item is looked for among
			§ the ones kept so far. The empty List the fold starts from is
			§ annotated: `reduce` binds `Result` from the `startingWith` value
			§ before the callback is even checked, and a bare `[]` has no items
			§ to read the item Type from.
			constant kept: List<ItemType> = []

			<- @::reduce(startingWith kept, (accumulated, item) {
				if accumulated::contains(item) {
					<- accumulated
				} else {
					<- accumulated::append(item)
				}
			})
		}

		§§ A new List with the given item — or the contents of the given List — added at the front.
		§§
		§§ @returns the extended List.
		overload prepend {
			(_ item: ItemType) -> List<ItemType> {
				<- [item]::append(contentsOf @)
			}

			(contentsOf other: List<ItemType>) -> List<ItemType> {
				<- other::append(contentsOf @)
			}
		}

		§§ A new List with the given item — or the contents of the given List — added at the end.
		§§
		§§ @returns the extended List.
		overload append {
			(_ item: ItemType) -> List<ItemType> {
				§ The other entry of this same block — a different emitted
				§ Function, so this is not recursion.
				<- @::append(contentsOf [item])
			}

			(contentsOf other: List<ItemType>) -> List<ItemType>
		}

		§ `map` and `reduce` are the first builtins to carry a Method-level
		§ Generic. `Result` must be inferred, or it never enters `bindableNames`
		§ and inference silently leaves it unbound. It is bound from the
		§ callback: for `map` from the callback's return Type, for `reduce` from
		§ the `startingWith` value before the callback is even checked. The
		§ Namespace's `ItemType` merges in ahead of it, so each ends up generic
		§ in `[ItemType, Result]`.

		§§ A new List with the given transform applied to every item.
		§§
		§§ @returns the List of transformed items.
		map<infer Result>(_ transform: (_: ItemType) -> Result) -> List<Result>

		§ `reduce` is one Method with two Overloads. The first folds every item
		§ in, always to the end; the second may stop early, because its combiner
		§ answers with a `Step` rather than with the accumulator outright —
		§ `#Continue` carries the accumulator on, `#Done` finishes at once. It is
		§ the fold a search or a running total that has already found its answer
		§ can leave, which no Essence expression walking the List could do on its
		§ own. Both bind `Result` from the `startingWith` value, so both are
		§ generic in `[ItemType, Result]` exactly as the single Method was.

		§§ Combines every item into a single value, starting from the given one —
		§§ folding to the end, or stopping early when the combiner says to.
		§§
		§§ @returns the combined value.
		overload reduce {
			§§ Combines every item into a single value, starting from the given one.
			§§
			§§ @param startingWith the value the first combination builds on.
			§§ @returns the combined value.
			<infer Result>(
				startingWith initial: Result,
				_ combine: (_: Result, _: ItemType) -> Result,
			) -> Result

			§§ Combines the items into a single value, starting from the given one, and may stop before the end: the `step` combiner answers with a `Step` — `#Continue` carries the accumulator forward, `#Done` finishes at once with its value. An empty List returns the starting value untouched.
			§§
			§§ @param startingWith the value the first combination builds on.
			§§ @param step the combiner, handed the accumulator and each item, answering with a `Step` — `#Continue` to fold on, `#Done` to finish now.
			§§ @returns the accumulated value, or the value the first `#Done` carries.
			<infer Result>(
				startingWith initial: Result,
				step combine: (_: Result, _: ItemType) -> Step<Result, Result>,
			) -> Result
		}

		§ The complement of `removeEvery(where:)` — the filter. Only the `where`
		§ form, since keeping just the items equal to a given value is what
		§ `contains` already answers.

		§§ A new List of just the items the given check accepts.
		§§
		§§ @returns the List of accepted items.
		keepEvery(where check: (_: ItemType) -> Boolean) -> List<ItemType>

		§§ The item at the given position, counting from zero.
		§§
		§§ @returns the item, or `Nothing` when the position is outside the List.
		item(at index: Integer) -> Optional<ItemType>

		§ `firstIndex` and `lastIndex` COUNT their way through the items, stopping
		§ at the first match — the walk-and-stop the native did, now that the
		§ `Step` Choice lets an Essence expression leave a walk before its end.
		§ The old objection — that Essence would have to pair every item with its
		§ position, build that whole List of Records and read one member back out —
		§ was about a `pair(with:)` formulation; the fold threads the position as
		§ its accumulator and never builds a List.
		§
		§ The counting is what makes them right for EVERY item Type. Walking the
		§ positions with `item(at:)` reads better and is wrong: `item(at:)` answers
		§ `Optional<ItemType>`, so a `nothing` STORED in the List and a position
		§ past the end come back as the same value, and an item Type that already
		§ contains `Nothing` — a `List<Nothing>`, or any `… | Nothing` Union a
		§ Program conforms to `Equatable` — would have its `nothing` items skipped
		§ without ever being compared. `reduce` hands the item ITSELF, so every
		§ item reaches the comparison.
		§
		§ The bound is the whole of the search: the item Type's own `is` decides
		§ which position is found, arriving as the hidden conformance Argument
		§ exactly as `contains` hands it to `anyItem`.

		§§ The position of the first item equal — by the items' own `is` — to the given one. Available whenever the items conform to `Equatable`.
		§§
		§§ @returns the zero-based position, or `Nothing` when the item is absent.
		firstIndex<infer ItemType is Equatable>(
			of item: ItemType,
		) -> Optional<Integer> {
			§ The accumulator is the position under test: `#Done` leaves the fold
			§ at the first match, carrying that position, and a fold that reaches
			§ the end settles on the position AFTER the last item — the length,
			§ which is the one Integer no match can answer. So "absent" needs no
			§ sentinel of its own, and every item, `nothing` included, is compared.
			constant found = @::reduce(startingWith 0, step (index, candidate) {
				if candidate::is(item) {
					<- #Done(index)
				} else {
					<- #Continue(index::add(1))
				}
			})

			if found::isLessThan(@::length()) {
				<- found
			} else {
				<- nothing
			}
		}

		§§ A new List of the items from one position up to, but not including, another.
		§§
		§§ @param from the first position to include, counting from zero.
		§§ @param to the position to stop before.
		§§ @returns the List of items in that range.
		slice(from: Integer, to: Integer) -> List<ItemType>

		§§ A new List with the items in the opposite order.
		§§
		§§ @returns the reversed List.
		reverse() -> List<ItemType>

		§ The `Comparable` bound works exactly as the `Equatable` one above
		§ does. It resolves the conforming Namespace at the call site —
		§ `Integer` for a `List<Integer>`, the covering `Number` for a mixed
		§ numeric List — and its `compareTo` arrives as a hidden trailing
		§ Argument. Its own bounded `ItemType` shadows the Namespace's.
		§
		§ BOTH entries are native, and the no-Argument one is native for a
		§ reason worth keeping: written in Essence its body would be
		§ `@::sort(by …)`, a call that has to pick between the two entries
		§ HERE. Picking one is what would give the comparison's Parameters
		§ their Types, so they can not be inferred; and annotating them does
		§ not rescue it either, because this entry's bounded `ItemType`
		§ shadows the Namespace's, so the annotated Function is typed in a
		§ DIFFERENT `ItemType` than the `by:` entry expects and no Overload
		§ matches. A sibling Overload is not reachable from an Essence body
		§ the way a separately named Method was.

		§§ A new List in order — by the items' own ordering when called with no Argument, available whenever they conform to `Comparable`, or by the given comparison.
		§§
		§§ @returns the ordered List.
		overload sort {
			§§ A new List in ascending order — the items' own ordering, available whenever they conform to `Comparable`. For any other order, use the `by:` entry.
			§§
			§§ @returns the ordered List.
			<infer ItemType is Comparable>() -> List<ItemType>

			§§ A new List ordered by the given comparison, applied to each pair of items.
			§§
			§§ @param by the comparison to order the items with
			§§ @returns the ordered List.
			(
				by comparison: (_: ItemType, _: ItemType) -> Ordering,
			) -> List<ItemType>
		}

		§ The witness behind List's conditional Comparable conformance —
		§ lexicographic ordering, available whenever the items are `Comparable`.
		§ Its own bounded `ItemType` shadows the Namespace's, exactly as
		§ `sort`'s does.

		§§ Orders the List against another one lexicographically — the first differing pair of items decides, and on an equal prefix the shorter List comes first. Available whenever the items conform to `Comparable`.
		§§
		§§ @param other the List to compare with
		§§ @returns `Ordering#Less`, `Ordering#Equal` or `Ordering#Greater`.
		compareTo<infer ItemType is Comparable>(
			_ other: List<ItemType>,
		) -> Ordering

		§ `anyItem`/`everyItem` read as sentences — "any item matches …", "every
		§ item matches …" — the existential and universal checks over a
		§ predicate. The no-argument existential is `hasItems`.
		§
		§ Both stop at the first item that decides the answer — `anyItem` at the
		§ first match, `everyItem` at the first failure — and both stop on
		§ `reduce`'s early-stopping entry, carrying the ANSWER rather than the
		§ item. `firstItem(where:)::hasValue()` would read the same way and is
		§ wrong: it answers `Nothing` both when no item matched and when the
		§ matching item IS `nothing`, so on a `List<Optional<Integer>>` a check
		§ that accepts the empty Optionals would find one and report `false`.
		§ A Boolean has no such second reading. `count(where:)` below stays on
		§ `keepEvery` — counting has to see every item, so there is no walk to
		§ leave early.

		§§ Whether the given check accepts at least one item.
		§§
		§§ @returns `true` when some item is accepted.
		anyItem(matches check: (_: ItemType) -> Boolean) -> Boolean {
			§ The accumulator is the answer so far, which stays `false` until an
			§ item is accepted and `#Done` finishes the fold with `true`. The
			§ empty List has no item to accept and keeps the seed.
			<- @::reduce(startingWith false, step (found, item) {
				if check(item) {
					<- #Done(true)
				} else {
					<- #Continue(found)
				}
			})
		}

		§§ Whether the given check accepts every item.
		§§
		§§ @returns `true` when all items are accepted, including the empty List.
		everyItem(matches check: (_: ItemType) -> Boolean) -> Boolean {
			§ No item fails the check. The empty List has none to fail, so it
			§ answers `true`, as it should.
			<- @::anyItem(matches (item) { <- check(item)::negate() })::negate()
		}

		§§ How many items equal the given one — by the items' own `is` — or are accepted by the given check. The by-value entry is available whenever the items conform to `Equatable`.
		§§
		§§ @returns the count.
		overload count {
			<infer ItemType is Equatable>(of item: ItemType) -> Integer {
				<- @::count(where (candidate) { <- candidate::is(item) })
			}

			(where check: (_: ItemType) -> Boolean) -> Integer {
				§ The filtered List is built only to be measured. Counting has to
				§ see every item, so unlike `anyItem`/`everyItem` there is no
				§ short circuit to keep here.
				<- @::keepEvery(where check)::length()
			}
		}

		§§ A new List with the given item inserted before the given position.
		§§
		§§ @returns the List with the item inserted.
		insert(_ item: ItemType, at index: Integer) -> List<ItemType> {
			§ Everything before the position, the item, then everything from the
			§ position on. `slice` clamps both ends, so a position before the
			§ start empties the first slice and prepends, and one at or past the
			§ end fills it with the whole List and appends — insertion never
			§ drops the item.
			<- @
				::slice(from 0, to index)
				::append(item)
				::append(contentsOf @::slice(from index, to @::length()))
		}

		§§ A new List with the item at the given position replaced.
		§§
		§§ @returns the List with the item replaced, or unchanged when the position is outside it.
		replace(_ item: ItemType, at index: Integer) -> List<ItemType> {
			§ A position outside the List leaves it unchanged. The guard is
			§ needed: `remove(at:)` would ignore such a position but `insert(_:at:)`
			§ clamps it, so without this the item would be added at an end.
			if index::isLessThan(0) {
				<- @
			} else if index::isGreaterThanOrEqualTo(@::length()) {
				<- @
			} else {
				<- @::remove(at index)::insert(item, at index)
			}
		}

		§§ The position of the last item equal — by the items' own `is` — to the given one. Available whenever the items conform to `Equatable`.
		§§
		§§ @returns the zero-based position, or `Nothing` when the item is absent.
		lastIndex<infer ItemType is Equatable>(
			of item: ItemType,
		) -> Optional<Integer> {
			§ The LAST occurrence is the FIRST occurrence of the reversed List, so
			§ `firstIndex` answers this one too and only the position has to be
			§ counted back from the end. Counting down from the last position
			§ instead would have to read each one with `item(at:)`, which can not
			§ say whether a `Nothing` is the item stored there or the end of the
			§ List — see the note above `firstIndex`.
			§
			§ The empty List reverses to itself and holds no item to find, so it
			§ answers `Nothing` without a guard of its own — the -1 that
			§ `lastPosition` holds for it never reaches the subtraction.
			constant lastPosition = @::length()::subtract(1)

			§ `@` is the SCRUTINEE inside a match, not the receiver, so the last
			§ position is bound before the match to stay reachable in the Case
			§ bodies.
			<- match @::reverse()::firstIndex(of item) -> Optional<Integer> {
				case Nothing { <- nothing }

				case _       { <- lastPosition::subtract(@) }
			}
		}

		§ The one bounded Method whose bound does real work rather than
		§ restating a conformance of List's own: joining needs nothing of the
		§ items but that each can say what it is, so the bound is `Printable`
		§ and the conforming Namespace's `toString` arrives as the hidden
		§ Argument, exactly as `sort`'s `compareTo` does. Bounding the METHOD
		§ is what keeps it here — a Namespace targeting `List<String>` would
		§ have answered for Strings only, and every builtin worth joining is
		§ Printable, Lists included. `[1, 2, 3]::join(with ", ")` is `"1, 2, 3"`.
		§ Items with no `Printable` conformance to hand in — an unbounded Type
		§ Parameter, a Function — are refused AT the bound, which names the
		§ Protocol that is missing, rather than by leaving the Method unfound.

		§§ Joins the items into one String, each item as its own `toString`, with the given separator between them — the return trip of `String::split(on:)` for a List of Strings.
		§§
		§§ @param separator the separator to place between the items
		§§ @returns the joined String, or the empty String for the empty List.
		join<infer ItemType is Printable>(with separator: String) -> String

		§ `flatten` would read naturally here too, and it is not here: it is
		§ not available on every List, and every Method of this Namespace is.
		§ It is declared in `NestedList` below, which says what its receiver has
		§ to be.

		§§ Splits the List in two by the given check — the accepted items and the rest, each in their original order.
		§§
		§§ @returns a Record with the accepted items under `matching` and the others under `rest`.
		partition(where check: (_: ItemType) -> Boolean) -> {
			matching: List<ItemType>,
			rest: List<ItemType>,
		} {
			§ Two passes where the native made one, each keeping the original
			§ order — which is what the halves are specified to do.
			<- {
				matching = @::keepEvery(where check),
				rest = @::removeEvery(where check),
			}
		}

		§§ Pairs the items of the two Lists position by position. The pairing stops with the shorter List.
		§§
		§§ @param other the List to pair the items with
		§§ @returns a List of Records, each holding one item of this List under `first` and its counterpart under `second`.
		pair<infer Other>(with other: List<Other>) -> List<{
			first: ItemType,
			second: Other,
		}>

		§§ Splits the List into groups of the given size, in order. The last group holds whatever remains, so it may be shorter.
		§§
		§§ @param groupsOf how many items each group holds
		§§ @returns the List of groups, or `Nothing` when the group size is below one.
		split(intoGroupsOf size: Integer) -> Optional<List<List<ItemType>>>

		§§ A List holding the given item the given number of times. Zero or fewer times gives the empty List.
		§§
		§§ @param item the item to repeat
		§§ @param times how many copies the List holds
		§§ @returns the List of repeated items.
		static repeat(
			_ item: ItemType,
			times count: Integer,
		) -> List<ItemType> {
			§ `of` counts DOWN when the first Integer is the greater, so a count
			§ below one would give `[1]` rather than nothing — hence the guard.
			if count::isLessThan(1) {
				<- []
			} else {
				§ The Integers are only the tally; each is replaced by the item.
				<- List.of(integersFrom 1, through count)::map((_) { <- item })
			}
		}

		§ The loop-fuel constructor — Essence has no Range Type by design, so
		§ counting loops write `List.of(integersFrom 1, through 10)::map(...)`.
		§ Fixed to Integers, so the Namespace's `ItemType` has nothing to merge
		§ into.

		§§ The Integers from one value through another, both included — counting down when the first is the greater.
		§§
		§§ @param integersFrom the first Integer of the List
		§§ @param through the last Integer of the List, included
		§§ @returns the List of Integers.
		static of(
			integersFrom start: Integer,
			through end: Integer,
		) -> List<Integer>
	}

	§ A List of Lists, and the one Method that only such a List can answer. It
	§ is a Namespace of its own because a Namespace targets ONE Type and every
	§ Method in it answers for that Type: `List` targets `List<ItemType>` —
	§ every List there is — and `flatten` is not available on every List. A
	§ Namespace targeting `List<List<ItemType>>` says exactly that, and says it
	§ in the one place the compiler already looks.
	§
	§ A bound could not have kept it on `List`, the way `join(with:)`'s does: the
	§ depth is the point. `ItemType` here binds to the INNER List's item Type,
	§ so `[[1, 2], [3]]::flatten()` is a `List<Integer>` rather than a
	§ `List<List<Integer>>`. Written as a Method of `List` it could only ever
	§ have named the OUTER item Type, which is the List it is removing, and no
	§ Protocol bound can name a Type that is not in the signature.
	§
	§ `[1, 2]::flatten()` matches no Namespace holding `flatten` and is
	§ refused, which is the whole of what "flattening needs something to
	§ flatten" means.
	§
	§ The name reads as what the receiver IS — a Nested List — and it is
	§ visible: it is what a Hover names, what `::<NestedList>flatten()`
	§ disambiguates with, and what a "searched Namespaces" Diagnostic lists.
	namespace NestedList<infer ItemType> for List<List<ItemType>> {
		§§ Flattens a List of Lists by one level — every inner List's items, in order, in a single List.
		§§
		§§ @returns the flattened List.
		flatten() -> List<ItemType>
	}
}
