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
import type { BooleanType } from "./Boolean"
import type { IntegerType } from "./Integer"
import {
	append__overload$2,
	createList,
	type ListType,
	materialise,
	positionFromEnd,
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

// NOTE: Everything below CARRIES the proof rather than spending it — each is a
// transform that can not empty a List that was not empty, declared on this
// Namespace so that it may say so. None of them is a new operation, and where
// `List` answers the same question with a native, that native IS the answer and
// is re-exported straight through, so the two entries are one Function under two
// names and can not come apart.
//
// NOTE: `removeDuplicates` is not one of those: `List` answers it in Essence, so
// there is no native of its own to re-export and the walk is written out here.
// The golden harness calls BOTH entries over the same inputs, which is what
// keeps the two from drifting.
//
// NOTE: Quadratic, as `List`'s body is and as the native before it was — each
// item is looked for among the ones kept so far, with the item Type's own `is`
// arriving as the hidden conformance Argument. The FIRST of every group of equal
// items is the one kept, so the original order survives and a receiver with
// anything in it keeps at least that much.
export function removeDuplicates<ItemType extends AnyType>(
	originalList: ListType<ItemType>,
	conformance: {
		is: (first: ItemType, second: ItemType) => BooleanType
	},
): ListType<ItemType> {
	let view = viewOf(originalList)
	let kept: Array<ItemType> = []

	for (let index = view.frontCount - 1; index >= 0; index--) {
		keepWhenNew(view.front[index], kept, conformance)
	}

	for (let index = 0; index < view.backCount; index++) {
		keepWhenNew(view.back[index], kept, conformance)
	}

	return createList(kept)
}

function keepWhenNew<ItemType extends AnyType>(
	item: ItemType,
	kept: Array<ItemType>,
	conformance: {
		is: (first: ItemType, second: ItemType) => BooleanType
	},
): void {
	let isDuplicate = kept.some(
		(candidate) => conformance.is(candidate, item).value,
	)

	if (!isDuplicate) {
		kept.push(item)
	}
}

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

// NOTE: The two that only move items about, both `List`'s own natives. `sort`'s
// entries bind by position exactly as they do there — `$1` takes the items'
// `compare` as its hidden conformance Argument, `$2` the comparison outright.
export { reverse, sort__overload$1, sort__overload$2 } from "./List"

// NOTE: The second entry with no native of `List`'s to hand the work to, for the
// reason `removeDuplicates` has none: `List` answers `replace` in Essence. One
// item out and one item in, and nothing at all when the position names no item —
// which is what that four-branch body says at greater length, since a position
// reaching back past the first item and one standing at or past the end both
// leave the List alone. Every case keeps the length, which is the whole of why
// the receiver's proof is still good for the answer.
//
// NOTE: The position is resolved from the end in bigint before it narrows,
// exactly as `slice` and `insert` do and for the same reason — a position past
// 2³¹ narrowed first would come out as an unrelated one.
export function replace<ItemType extends AnyType>(
	originalList: ListType<ItemType>,
	item: ItemType,
	at: IntegerType,
): ListType<ItemType> {
	let items = materialise(originalList)
	let length = BigInt(items.length)
	let position = positionFromEnd(at.value, length)

	if (position < 0n || position >= length) {
		return originalList
	}

	let replaced = items.slice(0)

	replaced[Number(position)] = item

	return createList(replaced)
}
