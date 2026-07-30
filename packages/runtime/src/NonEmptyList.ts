// NOTE: The runtime module of the `NonEmptyList` Namespace — the Lists a Program has
// proven have something in them. The Simplifier emits `<Namespace>.<method>(…)`,
// so a Namespace needs a module of its own name, and this is the whole of it.
//
// NOTE: Written here rather than re-exported from `List.ts` the way
// `NestedList.flatten` is, because there is nothing there to re-export:
// `List.firstItem` and `List.lastItem` are written in Essence, on the
// `item(at:)` that has to answer an Optional for every position. These are the
// TOTAL halves of that pair, and total is the whole of the difference.
//
// NOTE: A refinement erases before anything runs, so what arrives is an ordinary
// `ListType` and the evidence the Type carried was spent while compiling. Read
// off a List nothing proved anything about, position 0 of an empty array
// answers `undefined` — and that this can not happen is exactly what the
// Namespace's target bought. The proof is spent HERE, which is why neither of
// these could be written in Essence: the language has no way to be told it holds.
import type { BooleanType } from "./Boolean"
import { createList, type ListType } from "./List"
import type { AnyType } from "./type"

export function firstItem<ItemType extends AnyType>(
	originalList: ListType<ItemType>,
): ItemType {
	return originalList.value[0]
}

export function lastItem<ItemType extends AnyType>(
	originalList: ListType<ItemType>,
): ItemType {
	return originalList.value[originalList.value.length - 1]
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
	let kept: Array<ItemType> = []

	for (let item of originalList.value) {
		let isDuplicate = kept.some(
			(candidate) => conformance.is(candidate, item).value,
		)

		if (!isDuplicate) {
			kept.push(item)
		}
	}

	return createList(kept)
}
