import type { BooleanType } from "./Boolean"
import type { IntegerType } from "./Integer"
import type { NothingType } from "./Nothing"

import { createBoolean, negate } from "./Boolean"
import { createInteger } from "./Integer"
import { createNothing } from "./Nothing"
import { anyIs, anyIsNot, getInt32 } from "./internalHelpers"
import { type AnyType, typeKeySymbol } from "./type"

export type ListType<ItemType extends AnyType> = {
	[typeKeySymbol]: "List"
	value: Array<ItemType>
}

export function createList<ItemType extends AnyType>(
	originalList: Array<ItemType>,
): ListType<ItemType> {
	return { [typeKeySymbol]: "List", value: originalList }
}

export function is<ItemType extends AnyType>(
	originalList: ListType<ItemType>,
	otherList: ListType<ItemType>,
): BooleanType {
	if (originalList.value.length === otherList.value.length) {
		for (let index = 0; index < originalList.value.length; index++) {
			let originalListItem = originalList.value[index]
			let otherListItem = otherList.value[index]

			if (anyIsNot(originalListItem, otherListItem)) {
				return createBoolean(false)
			}
		}

		return createBoolean(true)
	} else {
		return createBoolean(false)
	}
}

export function isNot<ItemType extends AnyType>(
	originalList: ListType<ItemType>,
	otherList: ListType<ItemType>,
) {
	return negate(is(originalList, otherList))
}

export function length(originalList: ListType<AnyType>): IntegerType {
	return createInteger(BigInt(originalList.value.length))
}

export function hasItems<ItemType extends AnyType>(
	originalList: ListType<ItemType>,
): BooleanType {
	return createBoolean(originalList.value.length !== 0)
}

export function isEmpty<ItemType extends AnyType>(
	originalList: ListType<ItemType>,
): BooleanType {
	return createBoolean(originalList.value.length === 0)
}

export function contains<ItemType extends AnyType>(
	originalList: ListType<ItemType>,
	item: ItemType,
): BooleanType {
	for (let listItem of originalList.value) {
		if (anyIs(listItem, item)) {
			return createBoolean(true)
		}
	}

	return createBoolean(false)
}

export function doesNotContain<ItemType extends AnyType>(
	originalList: ListType<ItemType>,
	item: ItemType,
): BooleanType {
	for (let listItem of originalList.value) {
		if (anyIs(listItem, item)) {
			return createBoolean(false)
		}
	}

	return createBoolean(true)
}

export function firstItem<ItemType extends AnyType>(
	originalList: ListType<ItemType>,
): ItemType | NothingType {
	if (originalList.value.length > 0) {
		return originalList.value[0]
	} else {
		return createNothing()
	}
}

export function lastItem<ItemType extends AnyType>(
	originalList: ListType<ItemType>,
): ItemType | NothingType {
	if (originalList.value.length > 0) {
		return originalList.value[originalList.value.length - 1]
	} else {
		return createNothing()
	}
}

export function removeFirst__overload$1<ItemType extends AnyType>(
	originalList: ListType<ItemType>,
): ListType<ItemType> {
	return createList(originalList.value.slice(1))
}

export function removeFirst__overload$2<ItemType extends AnyType>(
	originalList: ListType<ItemType>,
	amount: IntegerType,
): ListType<ItemType> {
	if (amount.value < 1) {
		return createList(originalList.value.slice(0))
	} else {
		return createList(originalList.value.slice(getInt32(amount)))
	}
}

export function removeAt<ItemType extends AnyType>(
	originalList: ListType<ItemType>,
	removedIndex: IntegerType,
): ListType<ItemType> {
	let copiedList = originalList.value.slice(0)

	if (
		removedIndex.value > -1 &&
		removedIndex.value < originalList.value.length
	) {
		copiedList.splice(getInt32(removedIndex), 1)
	}

	return createList(copiedList)
}

export function removeEvery__overload$1<ItemType extends AnyType>(
	originalList: ListType<ItemType>,
	excludedItem: ItemType,
): ListType<ItemType> {
	let filteredList: Array<ItemType> = []

	for (let item of originalList.value) {
		if (excludedItem[typeKeySymbol] === "Nothing") {
			// Always filtered out
		} else if (anyIsNot(excludedItem, item)) {
			filteredList.push(item)
		}
	}

	return createList(filteredList)
}

export function removeEvery__overload$2<ItemType extends AnyType>(
	originalList: ListType<ItemType>,
	positiveFilterFunction: (item: ItemType) => BooleanType,
): ListType<ItemType> {
	let filteredList: Array<ItemType> = []

	for (let item of originalList.value) {
		if (positiveFilterFunction(item).value) {
			filteredList.push(item)
		}
	}

	return createList(filteredList)
}

export function removeLast<ItemType extends AnyType>(
	originalList: ListType<ItemType>,
): ListType<ItemType> {
	return createList(
		originalList.value.slice(0, originalList.value.length - 1),
	)
}

export function removeDuplicates<ItemType extends AnyType>(
	originalList: ListType<ItemType>,
): ListType<ItemType> {
	let results: Array<ItemType> = []

	for (let originalValue of originalList.value) {
		let valueIsInResults = false

		for (let resultsValue of results) {
			if (anyIs(resultsValue, originalValue)) {
				valueIsInResults = true
				break
			}
		}

		if (!valueIsInResults) {
			results.push(originalValue)
		}
	}

	return createList(results)
}

export function prepend__overload$1<ItemType extends AnyType>(
	originalList: ListType<ItemType>,
	item: ItemType,
): ListType<ItemType> {
	return createList([item, ...originalList.value])
}

export function prepend__overload$2<ItemType extends AnyType>(
	originalList: ListType<ItemType>,
	contentsOf: ListType<ItemType>,
): ListType<ItemType> {
	return createList([...contentsOf.value, ...originalList.value])
}

export function append__overload$1<ItemType extends AnyType>(
	originalList: ListType<ItemType>,
	item: ItemType,
): ListType<ItemType> {
	return createList([...originalList.value, item])
}

export function append__overload$2<ItemType extends AnyType>(
	originalList: ListType<ItemType>,
	contentsOf: ListType<ItemType>,
): ListType<ItemType> {
	return createList([...originalList.value, ...contentsOf.value])
}
