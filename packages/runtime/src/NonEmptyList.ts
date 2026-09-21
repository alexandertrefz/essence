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
import { append__overload$2, type ListType, viewOf } from "./List"
import type { AnyType } from "./type"

// NOTE: The logical first and last item, which is one comparison away from
// either run's end rather than position zero of the backing Array — a List that
// has been prepended to holds its first items in a second run, stored reversed,
// and its last item is the back run's when there is one at all.
//
// NOTE: `viewOf` rather than `walkOf`, for the reason `List.item(at:)` reads
// that way: these visit ONE item and hand no Array to anybody, so there is
// nothing to seal — and a reader that sealed would put the copy back into every
// turn of a heap, which reads its least item and writes two cells per sift.
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

// NOTE: `replace` is `List`'s own native under this Namespace's name, and the
// two entries are ONE Function for the reason the re-exports above are: every
// case of it keeps the length, so a receiver that had something in it answers
// with something in it, and only what may be said about the answer differs. It
// was written out here while `List` answered `replace` in Essence; both are the
// native now, which is what makes a positional write constant work — `List.ts`
// and `listWrites.ts` hold the reasoning.
export { replace__overload$1 } from "./List"

// NOTE: `indices` and `enumerate` are `List`'s own natives, under this
// Namespace's names: there is one position and one entry for every item, so a
// receiver with something in it answers with something in it. `indices` was
// written in Essence here, counting down through
// `List.of(integersFrom:downTo:)` to borrow that entry's promise and turning
// the count round — the walk `List.ts` explains it took over.
export { enumerate, indices__overload$1 as indices } from "./List"

// NOTE: Pairing and splitting, both `List`'s own natives, and here for the
// reason the declarations are where they are: this file reads in the order
// `List.es` writes them. Pairing stops where the shorter side does and
// splitting opens a group per item, so neither can answer nothing when it was
// handed something. `pair` asks the ARGUMENT for the proof too, which the Type
// says and the Function neither knows nor needs to.
export { pair, split__overload$1 as split } from "./List"

// NOTE: `removeDuplicates` is `List`'s own pair of natives, under this
// Namespace's names: the first occurrence of the first item is kept whatever
// else is dropped, so a List with something in it comes out with something in
// it. Both entries were `@::tally()::keys()` in `Dictionary.es`, which reached
// the whole second container for an answer a plain Map holds.
export {
	removeDuplicates__overload$1,
	removeDuplicates__overload$2,
} from "./List"
