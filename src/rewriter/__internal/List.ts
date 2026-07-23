import type { BooleanType } from "./Boolean"
import { createBoolean, negate } from "./Boolean"
import { getStringRepresentation } from "./functions"
import type { IntegerType } from "./Integer"
import { createInteger } from "./Integer"
import { getInt32 } from "./internalHelpers"
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

// NOTE: Equality item by item — the item `is` arrives as the hidden conformance
// Argument (curried by `boundConformance` for a nested List), so two Lists are
// equal exactly when their items say so with their OWN equality, rather than
// with the universal structural comparison this used to reach for. Lengths
// decide first, so nothing is compared for a pair of Lists that can not match.
export function is<ItemType extends AnyType>(
	originalList: ListType<ItemType>,
	otherList: ListType<ItemType>,
	conformance: {
		is: (first: ItemType, second: ItemType) => BooleanType
	},
): BooleanType {
	if (originalList.value.length !== otherList.value.length) {
		return createBoolean(false)
	}

	for (let index = 0; index < originalList.value.length; index++) {
		let itemsAreEqual = conformance.is(
			originalList.value[index],
			otherList.value[index],
		)

		if (!itemsAreEqual.value) {
			return createBoolean(false)
		}
	}

	return createBoolean(true)
}

export function length(originalList: ListType<AnyType>): IntegerType {
	return createInteger(BigInt(originalList.value.length))
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

export function item<ItemType extends AnyType>(
	originalList: ListType<ItemType>,
	index: IntegerType,
): ItemType | NothingType {
	if (index.value > -1 && index.value < originalList.value.length) {
		return originalList.value[getInt32(index)]
	} else {
		return createNothing()
	}
}

// NOTE: Native rather than Essence because the Essence form has to pair every
// item with its position first, build that whole List of Records and read one
// member back out, where this walks and stops. The item `is` arrives as the
// hidden conformance Argument, so which position is found is decided by the
// items' own equality either way. `lastIndex` is the same walk, backwards.
export function firstIndex<ItemType extends AnyType>(
	originalList: ListType<ItemType>,
	item: ItemType,
	conformance: {
		is: (first: ItemType, second: ItemType) => BooleanType
	},
): IntegerType | NothingType {
	for (let index = 0; index < originalList.value.length; index++) {
		if (conformance.is(originalList.value[index], item).value) {
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

export function reverse<ItemType extends AnyType>(
	originalList: ListType<ItemType>,
): ListType<ItemType> {
	return createList(originalList.value.slice(0).reverse())
}

// NOTE: `sort` is one Method with two Overloads, so both bind by position.
// `$1` is the no-Argument entry, whose `Comparable` bound hands its
// conformance in as the trailing Argument; it orders by the items' own
// `compareTo`. `$2` takes the comparison outright. Both land on the same walk.
export function sort__overload$1<ItemType extends AnyType>(
	originalList: ListType<ItemType>,
	conformance: {
		compareTo: (self: ItemType, other: ItemType) => OrderingType
	},
): ListType<ItemType> {
	return sort__overload$2(originalList, (first, second) =>
		conformance.compareTo(first, second),
	)
}

export function sort__overload$2<ItemType extends AnyType>(
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

export function lastIndex<ItemType extends AnyType>(
	originalList: ListType<ItemType>,
	item: ItemType,
	conformance: {
		is: (first: ItemType, second: ItemType) => BooleanType
	},
): IntegerType | NothingType {
	for (let index = originalList.value.length - 1; index >= 0; index--) {
		if (conformance.is(originalList.value[index], item).value) {
			return createInteger(BigInt(index))
		}
	}

	return createNothing()
}

// NOTE: Joining asks nothing of the items but that each can say what it is, so
// the Method is bounded by `Printable` rather than fixed to a List of Strings —
// the conforming Namespace's method map arrives as the hidden trailing
// Argument, exactly as `sort`'s does, and its `toString` is the whole of the
// conversion. For a List of Strings that `toString` is the identity, so the
// original behaviour is unchanged.
export function join<ItemType extends AnyType>(
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

export function flatten<ItemType extends AnyType>(
	originalList: ListType<ListType<ItemType>>,
): ListType<ItemType> {
	return createList(
		originalList.value.flatMap((innerList) => innerList.value),
	)
}

export function pair<ItemType extends AnyType, Other extends AnyType>(
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

export function split<ItemType extends AnyType>(
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
