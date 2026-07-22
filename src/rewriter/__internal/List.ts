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

export function firstItem__overload$1<ItemType extends AnyType>(
	originalList: ListType<ItemType>,
): ItemType | NothingType {
	if (originalList.value.length > 0) {
		return originalList.value[0]
	} else {
		return createNothing()
	}
}

export function firstItem__overload$2<ItemType extends AnyType>(
	originalList: ListType<ItemType>,
	matchesFunction: (item: ItemType) => BooleanType,
): ItemType | NothingType {
	for (let item of originalList.value) {
		if (matchesFunction(item).value) {
			return item
		}
	}

	return createNothing()
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
	} else if (amount.value >= BigInt(originalList.value.length)) {
		// NOTE: Dropping at least every item — checked against the bigint
		// before narrowing, since `getInt32` would wrap an amount this large
		// into a negative index and slice from the end instead.
		return createList([])
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
	shouldRemoveFunction: (item: ItemType) => BooleanType,
): ListType<ItemType> {
	let filteredList: Array<ItemType> = []

	for (let item of originalList.value) {
		if (!shouldRemoveFunction(item).value) {
			filteredList.push(item)
		}
	}

	return createList(filteredList)
}

export function removeLast__overload$1<ItemType extends AnyType>(
	originalList: ListType<ItemType>,
): ListType<ItemType> {
	return createList(
		originalList.value.slice(0, originalList.value.length - 1),
	)
}

export function removeLast__overload$2<ItemType extends AnyType>(
	originalList: ListType<ItemType>,
	amount: IntegerType,
): ListType<ItemType> {
	if (amount.value < 1) {
		return createList(originalList.value.slice(0))
	} else if (amount.value >= BigInt(originalList.value.length)) {
		// NOTE: Dropping at least every item — checked against the bigint
		// before narrowing, since `getInt32` would wrap an amount this large.
		return createList([])
	} else {
		return createList(
			originalList.value.slice(
				0,
				originalList.value.length - getInt32(amount),
			),
		)
	}
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

// NOTE: The bounded twin of `sortedBy` — `ItemType is Comparable` makes the
// Enricher hand the conforming Namespace's method map in as a hidden trailing
// Argument, and its `compareTo` is the whole comparison.
export function sorted<ItemType extends AnyType>(
	originalList: ListType<ItemType>,
	conformance: {
		compareTo: (first: ItemType, second: ItemType) => OrderingType
	},
): ListType<ItemType> {
	return sortedBy(originalList, conformance.compareTo)
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

export function anyItem<ItemType extends AnyType>(
	originalList: ListType<ItemType>,
	matchesFunction: (item: ItemType) => BooleanType,
): BooleanType {
	for (let item of originalList.value) {
		if (matchesFunction(item).value) {
			return createBoolean(true)
		}
	}

	return createBoolean(false)
}

export function everyItem<ItemType extends AnyType>(
	originalList: ListType<ItemType>,
	matchesFunction: (item: ItemType) => BooleanType,
): BooleanType {
	for (let item of originalList.value) {
		if (!matchesFunction(item).value) {
			return createBoolean(false)
		}
	}

	return createBoolean(true)
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

export function countOf__overload$2<ItemType extends AnyType>(
	originalList: ListType<ItemType>,
	matchesFunction: (item: ItemType) => BooleanType,
): IntegerType {
	let count = 0n

	for (let item of originalList.value) {
		if (matchesFunction(item).value) {
			count += 1n
		}
	}

	return createInteger(count)
}

export function insertAt<ItemType extends AnyType>(
	originalList: ListType<ItemType>,
	index: IntegerType,
	item: ItemType,
): ListType<ItemType> {
	// NOTE: The position is clamped to [0, length], so a position before the
	// start prepends and one at or past the end appends — insertion never
	// drops the item. Clamped on the bigint, ahead of the int32 narrowing.
	let length = BigInt(originalList.value.length)
	let at = index.value < 0n ? 0n : index.value > length ? length : index.value

	let copiedList = originalList.value.slice(0)
	copiedList.splice(Number(at), 0, item)

	return createList(copiedList)
}

export function replaceAt<ItemType extends AnyType>(
	originalList: ListType<ItemType>,
	index: IntegerType,
	item: ItemType,
): ListType<ItemType> {
	if (index.value < 0n || index.value >= BigInt(originalList.value.length)) {
		// NOTE: A position outside the List leaves it unchanged, the way
		// `removeAt` ignores one.
		return createList(originalList.value.slice(0))
	}

	let copiedList = originalList.value.slice(0)
	copiedList[getInt32(index)] = item

	return createList(copiedList)
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

export function joinWith(
	originalList: ListType<StringType>,
	separator: StringType,
): StringType {
	return createString(
		originalList.value.map((item) => item.value).join(separator.value),
	)
}

export function flattened<ItemType extends AnyType>(
	originalList: ListType<ListType<ItemType>>,
): ListType<ItemType> {
	return createList(
		originalList.value.flatMap((innerList) => innerList.value),
	)
}

export function partitioned<ItemType extends AnyType>(
	originalList: ListType<ItemType>,
	matchesFunction: (item: ItemType) => BooleanType,
): RecordType {
	let matching: Array<ItemType> = []
	let rest: Array<ItemType> = []

	for (let item of originalList.value) {
		if (matchesFunction(item).value) {
			matching.push(item)
		} else {
			rest.push(item)
		}
	}

	return {
		[typeKeySymbol]: "Record",
		matching: createList(matching),
		rest: createList(rest),
	}
}

export function pairedWith<ItemType extends AnyType, Other extends AnyType>(
	originalList: ListType<ItemType>,
	otherList: ListType<Other>,
): ListType<RecordType> {
	let pairCount = Math.min(originalList.value.length, otherList.value.length)
	let pairs: Array<RecordType> = []

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

export function repeating<ItemType extends AnyType>(
	item: ItemType,
	times: IntegerType,
): ListType<ItemType> {
	if (times.value <= 0n) {
		// NOTE: Zero or fewer copies is the empty List, the way `replaceAt`
		// treats an impossible position as a no-op.
		return createList([])
	}

	return createList(Array.from({ length: Number(times.value) }, () => item))
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
