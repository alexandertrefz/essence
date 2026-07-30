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
import type { ListType } from "./List"
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
