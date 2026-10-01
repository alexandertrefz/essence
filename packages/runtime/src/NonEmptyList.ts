// The `NonEmptyList` Namespace. `firstItem` and `lastItem` spend the proof,
// and `List::firstItem` is an Essence body, so they are written out here. The
// rest are `List`'s own natives. See "Refined Namespaces" in DEVELOPMENT.md.
import { append__overload$2, type ListType, viewOf } from "./List"
import type { AnyType } from "./type"

// Each end is read off whichever run holds it, through `viewOf` rather than
// `walkOf`. See "Reading a List while user code runs" in DEVELOPMENT.md.
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

export { length } from "./List"

// The transforms that keep the proof, none of which can empty a List. This
// Namespace declares one `append`, so it binds unmangled.
export { append__overload$2 as append } from "./List"

// `List::prepend(contentsOf:)` is an Essence body, so its native is written out
// here. See "Native and Essence in one Namespace" in
// packages/standard-library/DEVELOPMENT.md.
export function prepend<ItemType extends AnyType>(
	originalList: ListType<ItemType>,
	contentsOf: ListType<ItemType>,
): ListType<ItemType> {
	return append__overload$2(contentsOf, originalList)
}

export { map } from "./List"

export {
	reverse,
	sort__overload$1,
	sort__overload$2,
	sort__overload$3,
} from "./List"

export { replace__overload$1 } from "./List"

export { enumerate, indices__overload$1 as indices } from "./List"

// `pair` asks its Argument for the proof too.
export { pair, split__overload$1 as split } from "./List"

// The first item is always kept.
export {
	removeDuplicates__overload$1,
	removeDuplicates__overload$2,
} from "./List"
