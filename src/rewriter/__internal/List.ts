import type { BooleanType } from "./Boolean"
import type { NumberType } from "./Number"

import * as $Boolean from "./Boolean"
import { getRawNumber } from "./internalHelpers"

export type ListType<T> = { $type: "List"; value: Array<T> }

export function createList<T>(originalList: Array<T>): ListType<T> {
	return { $type: "List", value: originalList }
}

export function hasItems<T>(originalList: ListType<T>): BooleanType {
	return $Boolean.createBoolean(originalList.value.length !== 0)
}

export function first<T>(originalList: ListType<T>): T {
	return originalList.value[0]
}

export function last<T>(originalList: ListType<T>): T {
	return originalList.value[originalList.value.length - 1]
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
	return createList(originalList.value.slice(0, originalList.value.length - 1))
}

export function insert__overload$1<T>(originalList: ListType<T>, item: T, index: NumberType): ListType<T> {
	return createList(originalList.value.splice(getRawNumber(index), 1, item))
}

export function insert__overload$2<T>(
	originalList: ListType<T>,
	contentsOf: ListType<T>,
	index: NumberType,
): ListType<T> {
	return createList(originalList.value.splice(getRawNumber(index), contentsOf.value.length, ...contentsOf.value))
}

export function append__overload$1<T>(originalList: ListType<T>, item: T): ListType<T> {
	return createList([...originalList.value, item])
}

export function append__overload$2<T>(originalList: ListType<T>, contentsOf: ListType<T>): ListType<T> {
	return createList([...originalList.value, ...contentsOf.value])
}
