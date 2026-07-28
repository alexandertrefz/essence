import type { BooleanType } from "./Boolean"
import { createBoolean } from "./Boolean"
import type { IntegerType } from "./Integer"
import { createInteger } from "./Integer"
import type { OptionalType } from "./Optional"
import { createEmpty, createValue } from "./Optional"
import { equal, greater, less, type OrderingType } from "./Ordering"
import type { RecordType } from "./Record"
import type { StepType } from "./Step"
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

export function map<ItemType extends AnyType, Result extends AnyType>(
	originalList: ListType<ItemType>,
	transform: (item: ItemType) => Result,
): ListType<Result> {
	return createList(originalList.value.map((item) => transform(item)))
}

export function reduce__overload$1<
	ItemType extends AnyType,
	Result extends AnyType,
>(
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

// NOTE: The early-stopping fold — the sibling Overload of `reduce`. Its combiner
// answers with a `Step` rather than the accumulator outright, so it can leave
// the walk before its end: `#Continue` carries the accumulator to the next item,
// `#Done` finishes the whole fold at once with its value and no later item is
// visited. Native for the same reason `firstItem(where:)` is — no Essence
// expression can stop a walk partway, and stopping is the whole point.
export function reduce__overload$2<
	ItemType extends AnyType,
	Result extends AnyType,
>(
	originalList: ListType<ItemType>,
	startingValue: Result,
	combine: (accumulator: Result, item: ItemType) => StepType<Result, Result>,
): Result {
	let accumulator = startingValue

	for (let item of originalList.value) {
		let step = combine(accumulator, item)

		if (step[typeKeySymbol] === "Step#Done") {
			return step.value
		}

		accumulator = step.state
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

// NOTE: A negative position counts back from the end — -1 is the last item, and
// -length the first. The arithmetic stays in bigint and narrows to a Number only
// once the position is known to sit inside the List: narrowing first would wrap
// a position past 2³¹ into an unrelated one.
export function positionFromEnd(index: bigint, length: bigint): bigint {
	return index < 0n ? index + length : index
}

export function item<ItemType extends AnyType>(
	originalList: ListType<ItemType>,
	index: IntegerType,
): OptionalType<ItemType> {
	let length = BigInt(originalList.value.length)
	let position = positionFromEnd(index.value, length)

	if (position > -1n && position < length) {
		return createValue(originalList.value[Number(position)])
	} else {
		return createEmpty()
	}
}

// NOTE: `firstItem(where:)` is no longer here — it is written in Essence now, on
// `reduce`'s early-stopping entry, which `#Done`s at the first accepted item.
// The eager `keepEvery` beside `reduce` is what it used to be compared against;
// the `Step` Choice is what let the short-circuiting version leave the native.

// NOTE: `firstIndex`/`lastIndex` are no longer here — both are written in
// Essence now, walking the positions with the general `loop` and `#Done`-ing at
// the first match. The `Step` Choice is what let that walk-and-stop leave the
// native; the item `is` arrives as the bound's hidden conformance Argument.

export function slice<ItemType extends AnyType>(
	originalList: ListType<ItemType>,
	from: IntegerType,
	to: IntegerType,
): ListType<ItemType> {
	// NOTE: Half-open [from, to). A negative end counts back from the List's
	// end — `slice(from 0, to -1)` drops the last item — and only THEN is each
	// end clamped, so a position that reaches back past the start settles on
	// zero rather than wrapping a second time. Kept in bigint throughout:
	// narrowing first would turn a position past 2³¹ into a negative one and
	// slice from the far end.
	let length = BigInt(originalList.value.length)
	let fromPosition = positionFromEnd(from.value, length)
	let toPosition = positionFromEnd(to.value, length)
	let start =
		fromPosition < 0n ? 0n : fromPosition > length ? length : fromPosition
	let end = toPosition < 0n ? 0n : toPosition > length ? length : toPosition

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
// `compare`. `$2` takes the comparison outright. Both land on the same walk.
export function sort__overload$1<ItemType extends AnyType>(
	originalList: ListType<ItemType>,
	conformance: {
		compare: (self: ItemType, other: ItemType) => OrderingType
	},
): ListType<ItemType> {
	return sort__overload$2(originalList, (first, second) =>
		conformance.compare(first, second),
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

// NOTE: Lexicographic comparison — the item `compare` arrives as the hidden
// conformance Argument (curried by `boundConformance` for a nested List). The
// first pair that is not `Equal` decides; on an equal prefix the shorter List
// is `Less`, and two equal-length Lists compare `Equal`.
export function compare<ItemType extends AnyType>(
	first: ListType<ItemType>,
	second: ListType<ItemType>,
	conformance: {
		compare: (first: ItemType, second: ItemType) => OrderingType
	},
): OrderingType {
	let shared = Math.min(first.value.length, second.value.length)

	for (let index = 0; index < shared; index++) {
		let ordering = conformance.compare(
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

// NOTE: `join` with brackets around it, carrying the same `Printable` witness
// through. Here rather than in Essence because the brackets are String
// concatenation: written there it would call `String::append`, the only edge
// this Namespace drew into a Namespace that is written on THIS one. The empty
// List has no items to space, so it prints as `[]` rather than `[  ]`.
export function toString<ItemType extends AnyType>(
	originalList: ListType<ItemType>,
	conformance: {
		toString: (value: ItemType) => StringType
	},
): StringType {
	if (originalList.value.length === 0) {
		return createString("[]")
	}

	return createString(
		`[ ${join(originalList, createString(", "), conformance).value} ]`,
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
): OptionalType<ListType<ListType<ItemType>>> {
	if (groupSize.value < 1n) {
		return createEmpty()
	}

	let size = Number(groupSize.value)
	let groups: Array<ListType<ItemType>> = []

	for (let start = 0; start < originalList.value.length; start += size) {
		groups.push(createList(originalList.value.slice(start, start + size)))
	}

	return createValue(createList(groups))
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
