import type { BooleanType } from "./Boolean"
import type { IntegerType } from "./Integer"
import type { NothingType } from "./Nothing"

import { createBoolean } from "./Boolean"
import { createNothing } from "./Nothing"
import { getInt32 } from "./internalHelpers"
import { typeKeySymbol } from "./type"

export type ListType<T> = {
	[typeKeySymbol]: "List"
	value: Array<T>
}

export function createList<T>(originalList: Array<T>): ListType<T> {
	return { [typeKeySymbol]: "List", value: originalList }
}

export function hasItems<T>(originalList: ListType<T>): BooleanType {
	return createBoolean(originalList.value.length !== 0)
}

export function first<T>(originalList: ListType<T>): T | NothingType {
	if (originalList.value.length > 0) {
		return originalList.value[0]
	} else {
		return createNothing()
	}
}

export function last<T>(originalList: ListType<T>): T | NothingType {
	if (originalList.value.length > 0) {
		return originalList.value[originalList.value.length - 1]
	} else {
		return createNothing()
	}
}

export function unique<T>(originalList: ListType<T>): ListType<T> {
	let results: Array<T> = []

	originalList.value.map((value) => {
		if (!results.includes(value)) {
			results.push(value)
		}
	})

	return createList(results)
}

export function dropFirst<T>(originalList: ListType<T>): ListType<T> {
	return createList(originalList.value.slice(1))
}

export function dropLast<T>(originalList: ListType<T>): ListType<T> {
	return createList(
		originalList.value.slice(0, originalList.value.length - 1),
	)
}

export function append__overload$1<T>(
	originalList: ListType<T>,
	item: T,
): ListType<T> {
	return createList([...originalList.value, item])
}

export function append__overload$2<T>(
	originalList: ListType<T>,
	contentsOf: ListType<T>,
): ListType<T> {
	return createList([...originalList.value, ...contentsOf.value])
}
