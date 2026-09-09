// NOTE: The runtime module of the `GroupedList` Namespace — the bridge from the
// first container to the second (`packages/standard-library/sources/Dictionary.es`).
// The three natives here each walk a List once and answer a Dictionary keyed by
// something read off its items, and each is native because it promises
// something about what it built that no Essence expression can say: a group
// that has an item in it, a count that is above zero, and a Dictionary with an
// entry in it for the proven twin. A fourth Method, `removeDuplicates`, used to
// stand beside them, written in Essence on `tally` and `keys`; it is a `List`
// native over a plain Map now, and reaches none of this file.
//
// NOTE: The store is built through `Dictionary.ts`'s own three doors rather
// than out of slots reached from here. A grouping is one walk that folds each
// item into the entry its key already stands at, and `foldIntoFreshStore` is
// that fold — so the slots, the two key indexes and the version stamps stay in
// the one file that owns them, and a Dictionary gathered here is the same shape
// as one written down.
//
// NOTE: The List is walked as every List native walks one, with the two runs'
// counts fixed before the first item is read — `runsOf` rather than `viewOf`,
// because no Method here visits an item twice and there is no reason to trim
// the caller's List for it. A List built at the front holds its first items in
// a second run, stored reversed, which is what the backwards loop is.
import type { DictionaryType, Store } from "./Dictionary"
import {
	dictionaryOverFreshStore,
	foldIntoFreshStore,
	freshStore,
} from "./Dictionary"
import type { IntegerType } from "./Integer"
import { createInteger } from "./Integer"
import type { EquatableWitness } from "./keyEncoding"
import type { ListType } from "./List"
import { append__overload$1, createList, runsOf } from "./List"
import type { AnyType } from "./type"

// NOTE: One item into its group, which is the whole of what `group` does with
// an item. The group is a List and grows through `List`'s own `append`, which
// pushes onto the Array in place while the group is the tip of its run — and a
// group gathered here is only ever appended to, so it always is. The
// alternative was a plain Array per group and one `createList` at the end,
// which buys nothing: `createList` takes the Array over either way, and this
// keeps the answer's Lists in the representation `List.ts` maintains rather
// than in one this file would have to know about.
function gatherItem<Key extends AnyType, ItemType extends AnyType>(
	store: Store<Key, ListType<ItemType>>,
	key: Key,
	item: ItemType,
	conformance: EquatableWitness<Key>,
): void {
	foldIntoFreshStore(
		store,
		key,
		conformance,
		() => createList([item]),
		(group) => append__overload$1(group, item),
	)
}

// NOTE: The groups stand in the order their keys FIRST appear and each group's
// items keep the order they had, which is what one forward walk over the logical
// items gives for free — a key opens its slot where it is first met, and every
// later item is appended to the group already standing there.
export function group<ItemType extends AnyType, Key extends AnyType>(
	originalList: ListType<ItemType>,
	keyOf: (item: ItemType) => Key,
	conformance: EquatableWitness<Key>,
): DictionaryType<Key, ListType<ItemType>> {
	let view = runsOf(originalList)
	let store = freshStore<Key, ListType<ItemType>>()

	for (let position = view.frontCount - 1; position >= 0; position--) {
		let item = view.front[position]

		gatherItem(store, keyOf(item), item, conformance)
	}

	for (let position = 0; position < view.backCount; position++) {
		let item = view.back[position]

		gatherItem(store, keyOf(item), item, conformance)
	}

	return dictionaryOverFreshStore(store)
}

// NOTE: The same walk with the item as its own key and a count in place of a
// group. The count is an Integer built afresh per item rather than folded
// through `Integer.add`, because a tally counts the items of ONE List and a
// List's length is a JavaScript Array's length — so every count here is a number
// that `createInteger` keeps as a number, and the bigint half of the hybrid
// Integer is unreachable.
export function tally<ItemType extends AnyType>(
	originalList: ListType<ItemType>,
	conformance: EquatableWitness<ItemType>,
): DictionaryType<ItemType, IntegerType> {
	let view = runsOf(originalList)
	let store = freshStore<ItemType, IntegerType>()

	for (let position = view.frontCount - 1; position >= 0; position--) {
		countItem(store, view.front[position], conformance)
	}

	for (let position = 0; position < view.backCount; position++) {
		countItem(store, view.back[position], conformance)
	}

	return dictionaryOverFreshStore(store)
}

function countItem<ItemType extends AnyType>(
	store: Store<ItemType, IntegerType>,
	item: ItemType,
	conformance: EquatableWitness<ItemType>,
): void {
	foldIntoFreshStore(
		store,
		item,
		conformance,
		() => createInteger(1),
		(count) => createInteger((count.value as number) + 1),
	)
}

// NOTE: The one-to-one crossing: the same walk as `group`, with the item itself
// standing where a group would. A key met again REPLACES the value and keeps
// its slot, which is what `Dictionary.of` and `set` promise about a repeated
// key, and the fold's two halves say exactly that — the first item under a key
// opens the slot, and every later one is written over it.
//
// NOTE: Native rather than `Dictionary.of(@::map(…))` in Essence, for the
// proven twin's sake: the Essence spelling answers a bare `Dictionary` on any
// receiver, and only a native can say that a List with an item in it indexes
// into a Dictionary with an entry in it. The base entry is this same walk under
// the wider name, so the two can not come apart — and it saves the List of
// entry Records the Essence spelling would build and throw away.
export function index<ItemType extends AnyType, Key extends AnyType>(
	originalList: ListType<ItemType>,
	keyOf: (item: ItemType) => Key,
	conformance: EquatableWitness<Key>,
): DictionaryType<Key, ItemType> {
	let view = runsOf(originalList)
	let store = freshStore<Key, ItemType>()

	for (let position = view.frontCount - 1; position >= 0; position--) {
		let item = view.front[position]

		fileItem(store, keyOf(item), item, conformance)
	}

	for (let position = 0; position < view.backCount; position++) {
		let item = view.back[position]

		fileItem(store, keyOf(item), item, conformance)
	}

	return dictionaryOverFreshStore(store)
}

function fileItem<Key extends AnyType, ItemType extends AnyType>(
	store: Store<Key, ItemType>,
	key: Key,
	item: ItemType,
	conformance: EquatableWitness<Key>,
): void {
	foldIntoFreshStore(
		store,
		key,
		conformance,
		() => item,
		() => item,
	)
}
