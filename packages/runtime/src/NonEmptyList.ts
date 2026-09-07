// NOTE: The runtime module of the `NonEmptyList` Namespace — the Lists a Program has
// proven have something in them. The Simplifier emits `<Namespace>.<method>(…)`,
// so a Namespace needs a module of its own name, and this is it. It comes in two
// halves: the two Methods that SPEND the proof, written out below, and the
// transforms that CARRY it, which are `List`'s own operations under this
// Namespace's names.
//
// NOTE: `firstItem` and `lastItem` are written here rather than re-exported from
// `List.ts` the way `NestedList.flatten` is, because there is nothing there to
// re-export: `List.firstItem` and `List.lastItem` are written in Essence, on the
// `item(at:)` that has to answer an Optional for every position. These are the
// TOTAL halves of that pair, and total is the whole of the difference.
//
// NOTE: A refinement erases before anything runs, so what arrives is an ordinary
// `ListType` and the evidence the Type carried was spent while compiling. Read
// off a List nothing proved anything about, position 0 of an empty array
// answers `undefined` — and that this can not happen is exactly what the
// Namespace's target bought. The proof is spent HERE, which is why neither of
// those two could be written in Essence: the language has no way to be told it
// holds.
import type { IntegerType } from "./Integer"
import {
	append__overload$2,
	listRebuildingBack,
	listRebuildingFront,
	type ListType,
	positionFromEnd,
	runsOf,
	viewOf,
} from "./List"
import type { AnyType } from "./type"

// NOTE: The logical first and last item, which is one comparison away from
// either run's end rather than position zero of the backing Array — a List that
// has been prepended to holds its first items in a second run, stored reversed,
// and its last item is the back run's when there is one at all.
export function firstItem<ItemType extends AnyType>(
	originalList: ListType<ItemType>,
): ItemType {
	let view = viewOf(originalList)

	return view.frontCount > 0 ? view.front[view.frontCount - 1] : view.back[0]
}

export function lastItem<ItemType extends AnyType>(
	originalList: ListType<ItemType>,
): ItemType {
	let view = viewOf(originalList)

	return view.backCount > 0 ? view.back[view.backCount - 1] : view.front[0]
}

// NOTE: The count, which is `List`'s own — a refinement erases before anything
// runs, so what the Namespace's Type says about the answer is spent while
// compiling and the walk that produces it is the same one. It is here at all
// because an Essence body could not write it: `@::length()` on a proven
// receiver is this Method, not `List`'s.
export { length } from "./List"

// NOTE: Everything below CARRIES the proof rather than spending it — each is a
// transform that can not empty a List that was not empty, declared on this
// Namespace so that it may say so. None of them is a new operation, and where
// `List` answers the same question with a native, that native IS the answer and
// is re-exported straight through, so the two entries are one Function under two
// names and can not come apart.
//
// NOTE: `removeDuplicates` is not here. Both of its entries are written in
// Essence on `tally` and `keys`, in `Dictionary.es`, under `GroupedList` and
// `GroupedNonEmptyList` — the proof flows through the natives those read.

// NOTE: `append(contentsOf:)` is `List`'s own second Overload entry under a name
// with no `__overload$N` on it — this Namespace declares ONE `append`, so the
// Simplifier emits it unmangled and the re-export renames it. What is added is
// beside the point here: the receiver is the proof.
export { append__overload$2 as append } from "./List"

// NOTE: The mirror of it, and a wrapper rather than a re-export because
// `List::prepend(contentsOf:)` is written in Essence, as
// `other::append(contentsOf @)`. This is that body with the two Lists the other
// way round, which is all prepending has ever been.
export function prepend<ItemType extends AnyType>(
	originalList: ListType<ItemType>,
	contentsOf: ListType<ItemType>,
): ListType<ItemType> {
	return append__overload$2(contentsOf, originalList)
}

// NOTE: One transformed item for every item — `List`'s own native, under the
// same name, since the answer is the same array either way and only what may be
// said about it differs.
export { map } from "./List"

// NOTE: The two that only move items about, all four `List`'s own natives.
// `sort`'s entries bind by position exactly as they do there — `$1` takes the
// items' `compare` as its hidden conformance Argument, `$2` the comparison
// outright, and `$3` the key with the KEY Type's `compare` as the conformance.
export {
	reverse,
	sort__overload$1,
	sort__overload$2,
	sort__overload$3,
} from "./List"

// NOTE: The one entry with no native of `List`'s to hand the work to: `List`
// answers `replace` in Essence, so the walk is written out here. One
// item out and one item in, and nothing at all when the position names no item —
// which is what that four-branch body says at greater length, since a position
// reaching back past the first item and one standing at or past the end both
// leave the List alone. Every case keeps the length, which is the whole of why
// the receiver's proof is still good for the answer.
//
// NOTE: The position is resolved from the end exactly as `slice` and `insert`
// resolve theirs, through `List.positionFromEnd`, so an index past either end
// stays past it.
//
// NOTE: One item changes, so only the RUN holding it is copied and the other
// rides along by reference. A List built at both ends pays for the half the
// position falls in rather than for the whole of itself, and the receiver keeps
// the representation it arrived in — nothing here combines the runs, because
// combining them would be the very copy this is avoiding.
export function replace__overload$1<ItemType extends AnyType>(
	originalList: ListType<ItemType>,
	item: ItemType,
	at: IntegerType,
): ListType<ItemType> {
	let view = runsOf(originalList)
	let length = view.total
	let position = positionFromEnd(at.value, length)

	if (position < 0 || position >= length) {
		return originalList
	}

	if (position < view.frontCount) {
		let front = view.front.slice(0, view.frontCount)

		// NOTE: The front run is stored reversed, so the logical position counts
		// back from its end.
		front[view.frontCount - 1 - position] = item

		return listRebuildingFront(front, originalList, view)
	}

	let back = view.back.slice(0, view.backCount)

	back[position - view.frontCount] = item

	return listRebuildingBack(back, originalList, view)
}

// NOTE: `enumerate` is `List`'s own native, under the same name: one entry for
// every item means the answer is as long as the receiver, so a receiver with
// something in it answers with something in it. `indices` is not here — it is
// written in Essence on `List.of(integersFrom:through:)`, which already
// promises what it builds is not empty.
export { enumerate } from "./List"

// NOTE: Pairing and splitting, both `List`'s own natives, and last for the
// reason the declarations are: this file reads in the order `List.es` writes
// them. Pairing stops where the shorter side does and splitting opens a group
// per item, so neither can answer nothing when it was handed something. `pair`
// asks the ARGUMENT for the proof too, which the Type says and the Function
// neither knows nor needs to.
export { pair, split } from "./List"
