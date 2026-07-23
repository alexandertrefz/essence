import type { BooleanType } from "./Boolean"
import { createBoolean, negate } from "./Boolean"
import { getStringRepresentation } from "./functions"
import type { IntegerType } from "./Integer"
import { createInteger } from "./Integer"
import { anyIs, anyIsNot, getInt32 } from "./internalHelpers"
import type { NothingType } from "./Nothing"
import { createNothing } from "./Nothing"
import { equal, greater, less, type OrderingType } from "./Ordering"
import type { RecordType } from "./Record"
import type { StringType } from "./String"
import { createString } from "./String"
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

export function length(originalList: ListType<AnyType>): IntegerType {
	return createInteger(BigInt(originalList.value.length))
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

export function append__overload$2<ItemType extends AnyType>(
	originalList: ListType<ItemType>,
	contentsOf: ListType<ItemType>,
): ListType<ItemType> {
	return createList([...originalList.value, ...contentsOf.value])
}

// biome-ignore lint/suspicious/noShadowRestrictedNames: This is a runtime function
export function toString<ItemType extends AnyType>(
	originalList: ListType<ItemType>,
): StringType {
	return createString(getStringRepresentation(originalList))
}

export function map<ItemType extends AnyType, Result extends AnyType>(
	originalList: ListType<ItemType>,
	transform: (item: ItemType) => Result,
): ListType<Result> {
	return createList(originalList.value.map((item) => transform(item)))
}

export function reduce<ItemType extends AnyType, Result extends AnyType>(
	originalList: ListType<ItemType>,
	startingValue: Result,
	combine: (accumulator: Result, item: ItemType) => Result,
): Result {
	let accumulator = startingValue

	for (let item of originalList.value) {
		accumulator = combine(accumulator, item)
	}

	return accumulator
}

export function keepEvery<ItemType extends AnyType>(
	originalList: ListType<ItemType>,
	keepFunction: (item: ItemType) => BooleanType,
): ListType<ItemType> {
	let keptList: Array<ItemType> = []

	for (let item of originalList.value) {
		if (keepFunction(item).value) {
			keptList.push(item)
		}
	}

	return createList(keptList)
}

export function itemAt<ItemType extends AnyType>(
	originalList: ListType<ItemType>,
	index: IntegerType,
): ItemType | NothingType {
	if (index.value > -1 && index.value < originalList.value.length) {
		return originalList.value[getInt32(index)]
	} else {
		return createNothing()
	}
}

export function firstIndexOf<ItemType extends AnyType>(
	originalList: ListType<ItemType>,
	item: ItemType,
): IntegerType | NothingType {
	for (let index = 0; index < originalList.value.length; index++) {
		if (anyIs(originalList.value[index], item)) {
			return createInteger(BigInt(index))
		}
	}

	return createNothing()
}

export function slice<ItemType extends AnyType>(
	originalList: ListType<ItemType>,
	from: IntegerType,
	to: IntegerType,
): ListType<ItemType> {
	// NOTE: Half-open [from, to), each end clamped to the List — checked
	// against the bigint before narrowing, since `getInt32` would wrap a
	// position past 2³¹ into a negative index and slice from the far end.
	let length = BigInt(originalList.value.length)
	let start = from.value < 0n ? 0n : from.value > length ? length : from.value
	let end = to.value < 0n ? 0n : to.value > length ? length : to.value

	if (end <= start) {
		return createList([])
	}

	return createList(originalList.value.slice(Number(start), Number(end)))
}

export function reversed<ItemType extends AnyType>(
	originalList: ListType<ItemType>,
): ListType<ItemType> {
	return createList(originalList.value.slice(0).reverse())
}

export function sortedBy<ItemType extends AnyType>(
	originalList: ListType<ItemType>,
	order: (first: ItemType, second: ItemType) => OrderingType,
): ListType<ItemType> {
	// NOTE: A copy is sorted, since every List operation returns a new value.
	// `Array.sort` is stable, so items the comparison calls equal keep their
	// original order. The Ordering Case is read by tag, mapped to the sign
	// `sort` expects.
	let sorted = originalList.value.slice(0)

	sorted.sort((first, second) => {
		let ordering = order(first, second)

		if (ordering[typeKeySymbol] === "Ordering#Less") {
			return -1
		} else if (ordering[typeKeySymbol] === "Ordering#Greater") {
			return 1
		} else {
			return 0
		}
	})

	return createList(sorted)
}

// NOTE: Lexicographic comparison — the item `compareTo` arrives as the hidden
// conformance Argument (curried by `boundConformance` for a nested List). The
// first pair that is not `Equal` decides; on an equal prefix the shorter List
// is `Less`, and two equal-length Lists compare `Equal`.
export function compareTo<ItemType extends AnyType>(
	first: ListType<ItemType>,
	second: ListType<ItemType>,
	conformance: {
		compareTo: (first: ItemType, second: ItemType) => OrderingType
	},
): OrderingType {
	let shared = Math.min(first.value.length, second.value.length)

	for (let index = 0; index < shared; index++) {
		let ordering = conformance.compareTo(
			first.value[index],
			second.value[index],
		)

		if (ordering[typeKeySymbol] !== "Ordering#Equal") {
			return ordering
		}
	}

	if (first.value.length < second.value.length) {
		return less
	}

	if (first.value.length > second.value.length) {
		return greater
	}

	return equal
}

export function countOf__overload$1<ItemType extends AnyType>(
	originalList: ListType<ItemType>,
	item: ItemType,
): IntegerType {
	let count = 0n

	for (let listItem of originalList.value) {
		if (anyIs(listItem, item)) {
			count += 1n
		}
	}

	return createInteger(count)
}

export function lastIndexOf<ItemType extends AnyType>(
	originalList: ListType<ItemType>,
	item: ItemType,
): IntegerType | NothingType {
	for (let index = originalList.value.length - 1; index >= 0; index--) {
		if (anyIs(originalList.value[index], item)) {
			return createInteger(BigInt(index))
		}
	}

	return createNothing()
}

// NOTE: Joining asks nothing of the items but that each can say what it is, so
// the Method is bounded by `Printable` rather than fixed to a List of Strings —
// the conforming Namespace's method map arrives as the hidden trailing
// Argument, exactly as `sorted`'s does, and its `toString` is the whole of the
// conversion. For a List of Strings that `toString` is the identity, so the
// original behaviour is unchanged.
export function joinWith<ItemType extends AnyType>(
	originalList: ListType<ItemType>,
	separator: StringType,
	conformance: {
		toString: (value: ItemType) => StringType
	},
): StringType {
	return createString(
		originalList.value
			.map((item) => conformance.toString(item).value)
			.join(separator.value),
	)
}

export function flattened<ItemType extends AnyType>(
	originalList: ListType<ListType<ItemType>>,
): ListType<ItemType> {
	return createList(
		originalList.value.flatMap((innerList) => innerList.value),
	)
}

export function pairedWith<ItemType extends AnyType, Other extends AnyType>(
	originalList: ListType<ItemType>,
	otherList: ListType<Other>,
): ListType<RecordType & { first: ItemType; second: Other }> {
	let pairCount = Math.min(originalList.value.length, otherList.value.length)
	let pairs: Array<RecordType & { first: ItemType; second: Other }> = []

	for (let index = 0; index < pairCount; index++) {
		pairs.push({
			[typeKeySymbol]: "Record",
			first: originalList.value[index],
			second: otherList.value[index],
		})
	}

	return createList(pairs)
}

export function splitInto<ItemType extends AnyType>(
	originalList: ListType<ItemType>,
	groupSize: IntegerType,
): ListType<ListType<ItemType>> | NothingType {
	if (groupSize.value < 1n) {
		return createNothing()
	}

	let size = Number(groupSize.value)
	let groups: Array<ListType<ItemType>> = []

	for (let start = 0; start < originalList.value.length; start += size) {
		groups.push(createList(originalList.value.slice(start, start + size)))
	}

	return createList(groups)
}

export function of(
	firstInteger: IntegerType,
	lastInteger: IntegerType,
): ListType<IntegerType> {
	let integers: Array<IntegerType> = []

	if (firstInteger.value <= lastInteger.value) {
		for (
			let value = firstInteger.value;
			value <= lastInteger.value;
			value++
		) {
			integers.push(createInteger(value))
		}
	} else {
		for (
			let value = firstInteger.value;
			value >= lastInteger.value;
			value--
		) {
			integers.push(createInteger(value))
		}
	}

	return createList(integers)
}
