// The `GroupedList` Namespace: one walk over a List into a Dictionary keyed by
// what each item gives. Their Types promise what no Essence expression can say.
// A group holds an item, a count is above zero, and the proven twin's
// Dictionary holds an entry. Each store is filled through `foldIntoFreshStore`.
// See "Writing to a Dictionary" in DEVELOPMENT.md.
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
import { append__overload$1, createList, sealedRunsOf } from "./List"
import type { AnyType } from "./type"

// A group only ever grows here, so it stays the tip of its run and `append`
// pushes in place.
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

// Groups stand in the order their keys first appear, and each keeps its items'
// order. The walk seals the runs, since `keyOf` may call back into Essence.
// See "Reading a List while user code runs" in DEVELOPMENT.md.
export function group<ItemType extends AnyType, Key extends AnyType>(
	originalList: ListType<ItemType>,
	keyOf: (item: ItemType) => Key,
	conformance: EquatableWitness<Key>,
): DictionaryType<Key, ListType<ItemType>> {
	let view = sealedRunsOf(originalList)
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

// Each item is its own key, and the value counts it. No count can pass a
// JavaScript Array's length, so every count is held as a number.
export function tally<ItemType extends AnyType>(
	originalList: ListType<ItemType>,
	conformance: EquatableWitness<ItemType>,
): DictionaryType<ItemType, IntegerType> {
	let view = sealedRunsOf(originalList)
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

// Each item under its key. A key met again replaces the value and keeps its
// slot, as `Dictionary.of` and `set` do.
export function index<ItemType extends AnyType, Key extends AnyType>(
	originalList: ListType<ItemType>,
	keyOf: (item: ItemType) => Key,
	conformance: EquatableWitness<Key>,
): DictionaryType<Key, ItemType> {
	let view = sealedRunsOf(originalList)
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
