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

// NOTE: A List is TWO runs and a VIEW into each — the back run stored forward
// in `value`, the front run stored REVERSED in `front` — so that adding at
// either end can push onto an Array the receiver already holds instead of
// copying the whole of it. The logical items are `front[frontLen - 1]` down to
// `front[0]`, then `value[0]` up to `value[length)`.
//
// NOTE: The two runs are SHARED between the boxes of one chain, and what keeps
// them apart is that each box says how much of each run is its own. A box that
// never prepended carries no `front` at all and is then what a List has always
// been plus a `length`: both fields absent has to mean "flat, and the view is
// the whole Array", because that is exactly the literal the Optimiser's
// `collapse-construction` emits.
//
// NOTE: None of this is observable. Every Essence value is immutable and the
// language has no way to ask whether two values are the SAME value, so a shared
// Array is indistinguishable from a copied one for as long as every box answers
// exactly the items its view holds — which is what the stamping discipline
// below is for.
export type ListType<ItemType extends AnyType> = {
	[typeKeySymbol]: "List"
	value: Array<ItemType>
	length?: number
	front?: Array<ItemType>
	frontLen?: number
}

// NOTE: TAKES OWNERSHIP of the Array it is handed. The box stores that Array
// rather than copying it, and a later `append` may push onto it in place, so no
// caller may keep the Array it passed or hand the same one to two boxes. Every
// caller — in this package and in the JavaScript the Rewriter emits — builds a
// fresh Array for the call. A caller that can not promise that reaches for
// `createListFrom` instead.
export function createList<ItemType extends AnyType>(
	originalList: Array<ItemType>,
): ListType<ItemType> {
	return { [typeKeySymbol]: "List", value: originalList }
}

// NOTE: `createList` for callers whose Array is not theirs to give away — the
// client bridge, and through it every host that builds a List out of a
// JavaScript Array of its own. The copy is what the ownership contract above
// costs when it can not be checked: a host keeps its Array, an append onto the
// List pushes onto ours, and neither ever sees the other's items. Nothing
// INSIDE this package calls it; a native that builds an Array to hand over
// builds a fresh one and uses `createList`.
export function createListFrom<ItemType extends AnyType>(
	items: Array<ItemType>,
): ListType<ItemType> {
	return { [typeKeySymbol]: "List", value: items.slice() }
}

// NOTE: What a native sees of a List: the two runs, and the counts THIS box
// owns of them. A box with no front views zero items of this one shared Array
// rather than of a `null`, so every walk is the same two loops with nothing to
// guard — the front loop simply does not run. Nothing writes to THIS Array, and
// a view over it counts zero items either way, so handing the same one to every
// front-less box is safe.
const noItems: Array<never> = []

export type ListView<ItemType extends AnyType> = {
	front: Array<ItemType>
	frontCount: number
	back: Array<ItemType>
	backCount: number
	total: number
}

// NOTE: THE REENTRANCY RULE. Every native fixes its item counts ONCE, here or
// in `materialise`, and never asks a run Array for its length again. A run can
// GROW mid-walk, because a callback may append to the very List being walked:
// `list::reduce(startingWith list, (acc, item) { <- acc::append(item) })` seeds
// the accumulator with the walked List, and its first append pushes onto the
// Array the walk is reading. The walk must cover the items the box viewed when
// it started, which is what it did when every operation copied. That is sound
// because a push only ever EXTENDS an Array: the positions a box has already
// answered for are frozen for good, since the copying paths only ever write
// Arrays of their own.
export function viewOf<ItemType extends AnyType>(
	originalList: ListType<ItemType>,
): ListView<ItemType> {
	let backCount = originalList.length ?? originalList.value.length

	// NOTE: A box whose view is shorter than its run is holding the whole of
	// its chain's high-water Array alive. Reading it trims that away and stores
	// the trimmed Array back, so the work happens once however often the box is
	// read afterwards — and the Array a reader is handed keeps its identity
	// across reads.
	if (backCount !== originalList.value.length) {
		originalList.value = originalList.value.slice(0, backCount)
		originalList.length = backCount
	}

	let front = originalList.front

	if (front === undefined) {
		return {
			front: noItems,
			frontCount: 0,
			back: originalList.value,
			backCount,
			total: backCount,
		}
	}

	let frontCount = originalList.frontLen ?? front.length

	if (frontCount !== front.length) {
		front = front.slice(0, frontCount)
		originalList.front = front
		originalList.frontLen = frontCount
	}

	return {
		front,
		frontCount,
		back: originalList.value,
		backCount,
		total: frontCount + backCount,
	}
}

// NOTE: The one place the two runs become one Array. What comes back is an
// Array whose whole length IS the box's logical view, so every operation that
// wants a flat List can be written against it exactly as it was written before
// there were two runs.
//
// NOTE: An upgraded box is DEMOTED in place while it is combined — the box
// keeps the combined Array and forgets its front — so a List that is read
// repeatedly pays for the combining once. Swapping one representation for
// another under a value is invisible for the same reason the whole scheme is:
// the logical items are the same ones, and nothing in the language can ask
// whether two values are the same value.
export function materialise<ItemType extends AnyType>(
	originalList: ListType<ItemType>,
): Array<ItemType> {
	let backCount = originalList.length ?? originalList.value.length
	let front = originalList.front

	if (front === undefined) {
		if (backCount !== originalList.value.length) {
			originalList.value = originalList.value.slice(0, backCount)
			originalList.length = backCount
		}

		return originalList.value
	}

	let frontCount = originalList.frontLen ?? front.length
	let combined: Array<ItemType> = []

	for (let index = frontCount - 1; index >= 0; index--) {
		combined.push(front[index])
	}

	let back = originalList.value

	for (let index = 0; index < backCount; index++) {
		combined.push(back[index])
	}

	originalList.value = combined
	originalList.length = combined.length
	originalList.front = undefined
	originalList.frontLen = undefined

	return combined
}

// NOTE: The logical item at a position of a FIXED view — one comparison to
// decide which run holds it, and nothing allocated, so the walks that need
// positions on both sides at once (`is`, `compare`) can have them without
// building anything.
export function itemOfView<ItemType extends AnyType>(
	view: ListView<ItemType>,
	position: number,
): ItemType {
	return position < view.frontCount
		? view.front[view.frontCount - 1 - position]
		: view.back[position - view.frontCount]
}

// NOTE: The two-run walk written once, for the readers that want nothing more
// of a List than its items added to an Array they are building.
function pushItemsOf<ItemType extends AnyType>(
	originalList: ListType<ItemType>,
	into: Array<ItemType>,
): void {
	let view = viewOf(originalList)

	for (let index = view.frontCount - 1; index >= 0; index--) {
		into.push(view.front[index])
	}

	for (let index = 0; index < view.backCount; index++) {
		into.push(view.back[index])
	}
}

// NOTE: The answer of an operation on the BACK of a List — a new box over the
// back run it built, carrying the receiver's front run through BY REFERENCE,
// since appending leaves the front alone. The `frontLen` comes with it, so a
// later prepend to the receiver may push onto that shared front without the
// answer's view growing by an item that was never added to it.
function listSharingFrontOf<ItemType extends AnyType>(
	value: Array<ItemType>,
	length: number,
	source: ListType<ItemType>,
): ListType<ItemType> {
	if (source.front === undefined) {
		return { [typeKeySymbol]: "List", value, length }
	}

	return {
		[typeKeySymbol]: "List",
		value,
		length,
		front: source.front,
		frontLen: source.frontLen,
	}
}

// NOTE: Equality item by item — the item `is` arrives as the hidden conformance
// Argument (curried by `boundConformance` for a nested List), so two Lists are
// equal exactly when their items say so with their OWN equality, rather than
// with the universal structural comparison this used to reach for. Lengths
// decide first, so nothing is compared for a pair of Lists that can not match.
//
// NOTE: The two sides may be in different representations — one flat, one
// upgraded — and two Lists holding the same items are equal whichever way round
// they are stored, so both are read through a view rather than off their
// Arrays.
export function is<ItemType extends AnyType>(
	originalList: ListType<ItemType>,
	otherList: ListType<ItemType>,
	conformance: {
		is: (first: ItemType, second: ItemType) => BooleanType
	},
): BooleanType {
	let original = viewOf(originalList)
	let other = viewOf(otherList)

	if (original.total !== other.total) {
		return createBoolean(false)
	}

	for (let index = 0; index < original.total; index++) {
		let itemsAreEqual = conformance.is(
			itemOfView(original, index),
			itemOfView(other, index),
		)

		if (!itemsAreEqual.value) {
			return createBoolean(false)
		}
	}

	return createBoolean(true)
}

export function length(originalList: ListType<AnyType>): IntegerType {
	return createInteger(BigInt(viewOf(originalList).total))
}

// NOTE: The single-item half of `prepend`, whose sibling `prepend(contentsOf:)`
// stays in Essence on `append(contentsOf:)`. Here for the reason
// `append__overload$1` is: adding an item can not answer empty, its Declaration
// says so with a `NonEmptyList`, and no Essence expression can carry that.
//
// NOTE: A receiver that never prepended is UPGRADED — the answer keeps the
// receiver's back run by reference and starts a front run of its own. The
// receiver's back view is stamped closed first, even though nothing is pushed
// onto it here: the two boxes now share that Array and either of them may later
// append to it, and a box with no explicit `length` would then view the item
// the other one added. Stamping is what makes the pair of them honest, and it
// is the whole of what the answer's explicit `length` rests on.
//
// NOTE: A receiver that HAS a front is tip-or-copy on that front, exactly as
// `append` is on the back — with nothing to stamp, because a front run is never
// carried without the `frontLen` that says how much of it is viewed.
export function prepend__overload$1<ItemType extends AnyType>(
	originalList: ListType<ItemType>,
	item: ItemType,
): ListType<ItemType> {
	let backCount = originalList.length ?? originalList.value.length
	let front = originalList.front

	originalList.length = backCount

	if (front === undefined) {
		return {
			[typeKeySymbol]: "List",
			value: originalList.value,
			length: backCount,
			front: [item],
			frontLen: 1,
		}
	}

	let frontCount = originalList.frontLen ?? front.length

	if (frontCount === front.length) {
		front.push(item)

		return {
			[typeKeySymbol]: "List",
			value: originalList.value,
			length: backCount,
			front,
			frontLen: frontCount + 1,
		}
	}

	let copiedFront = front.slice(0, frontCount)

	copiedFront.push(item)

	return {
		[typeKeySymbol]: "List",
		value: originalList.value,
		length: backCount,
		front: copiedFront,
		frontLen: frontCount + 1,
	}
}

// NOTE: `append` is one Method with two Overloads, so both bind by position.
// `$1` adds ONE item, `$2` adds a whole List. The single-item entry is a native
// rather than the one-line `@::append(contentsOf [item])` it used to be in
// Essence, because its Declaration now promises a `NonEmptyList` — adding an
// item can not answer empty — and no Essence expression can say that about the
// `List` the other entry hands back.
//
// NOTE: Tip-or-copy. A receiver viewing all of its back run is the TIP of that
// run, so the item can be pushed onto the Array in place and the answer can
// share it; a receiver viewing less than all of it has been appended to already
// by somebody else, so the answer gets a run of its own.
//
// NOTE: The receiver's view is stamped closed BEFORE the push, and the order is
// load-bearing: between the two lines there must be no moment at which a box
// whose `length` is absent — and whose view is therefore implied to be the
// whole Array — has an item in that Array that was pushed for somebody else.
export function append__overload$1<ItemType extends AnyType>(
	originalList: ListType<ItemType>,
	item: ItemType,
): ListType<ItemType> {
	let count = originalList.length ?? originalList.value.length

	if (count === originalList.value.length) {
		originalList.length = count
		originalList.value.push(item)

		return listSharingFrontOf(originalList.value, count + 1, originalList)
	}

	let copied = originalList.value.slice(0, count)

	copied.push(item)

	return listSharingFrontOf(copied, count + 1, originalList)
}

// NOTE: The same tip-or-copy on the receiver's back, and then the other List's
// logical items. The other one's counts are fixed before the first push, which
// is what makes `a::append(contentsOf a)` answer the entry-time items twice
// rather than chasing an Array it is itself growing.
export function append__overload$2<ItemType extends AnyType>(
	originalList: ListType<ItemType>,
	contentsOf: ListType<ItemType>,
): ListType<ItemType> {
	let count = originalList.length ?? originalList.value.length
	let target: Array<ItemType>

	if (count === originalList.value.length) {
		originalList.length = count
		target = originalList.value
	} else {
		target = originalList.value.slice(0, count)
	}

	pushItemsOf(contentsOf, target)

	return listSharingFrontOf(target, target.length, originalList)
}

export function map<ItemType extends AnyType, Result extends AnyType>(
	originalList: ListType<ItemType>,
	transform: (item: ItemType) => Result,
): ListType<Result> {
	let view = viewOf(originalList)
	let transformed: Array<Result> = []

	for (let index = view.frontCount - 1; index >= 0; index--) {
		transformed.push(transform(view.front[index]))
	}

	for (let index = 0; index < view.backCount; index++) {
		transformed.push(transform(view.back[index]))
	}

	return createList(transformed)
}

export function reduce__overload$1<
	ItemType extends AnyType,
	Result extends AnyType,
>(
	originalList: ListType<ItemType>,
	startingValue: Result,
	combine: (accumulator: Result, item: ItemType) => Result,
): Result {
	let view = viewOf(originalList)
	let accumulator = startingValue

	for (let index = view.frontCount - 1; index >= 0; index--) {
		accumulator = combine(accumulator, view.front[index])
	}

	for (let index = 0; index < view.backCount; index++) {
		accumulator = combine(accumulator, view.back[index])
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
	let view = viewOf(originalList)
	let accumulator = startingValue

	for (let index = view.frontCount - 1; index >= 0; index--) {
		let step = combine(accumulator, view.front[index])

		if (step[typeKeySymbol] === "Step#Done") {
			return step.value
		}

		accumulator = step.state
	}

	for (let index = 0; index < view.backCount; index++) {
		let step = combine(accumulator, view.back[index])

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
	let view = viewOf(originalList)
	let keptList: Array<ItemType> = []

	for (let index = view.frontCount - 1; index >= 0; index--) {
		if (keepFunction(view.front[index]).value) {
			keptList.push(view.front[index])
		}
	}

	for (let index = 0; index < view.backCount; index++) {
		if (keepFunction(view.back[index]).value) {
			keptList.push(view.back[index])
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

// NOTE: Reading a position does NOT combine the runs — an upgraded List has to
// stay O(1) to index — so the view decides which run holds the item and the
// item is read straight out of it.
export function item<ItemType extends AnyType>(
	originalList: ListType<ItemType>,
	index: IntegerType,
): OptionalType<ItemType> {
	let view = viewOf(originalList)
	let length = BigInt(view.total)
	let position = positionFromEnd(index.value, length)

	if (position > -1n && position < length) {
		return createValue(itemOfView(view, Number(position)))
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
	let items = materialise(originalList)
	let length = BigInt(items.length)
	let fromPosition = positionFromEnd(from.value, length)
	let toPosition = positionFromEnd(to.value, length)
	let start =
		fromPosition < 0n ? 0n : fromPosition > length ? length : fromPosition
	let end = toPosition < 0n ? 0n : toPosition > length ? length : toPosition

	if (end <= start) {
		return createList([])
	}

	return createList(items.slice(Number(start), Number(end)))
}

export function reverse<ItemType extends AnyType>(
	originalList: ListType<ItemType>,
): ListType<ItemType> {
	return createList(materialise(originalList).slice(0).reverse())
}

// NOTE: Everything before the position, the item, then everything from the
// position on — the three parts the Essence body built with `slice`, `append`
// and `append(contentsOf:)`, kept exactly. The position is resolved from the end
// and CLAMPED, so one before the start settles on zero and one past the end on
// the length: there is no position that drops the item, which is what lets the
// Declaration promise a `NonEmptyList` and is why the body could not stay in
// Essence — every step of it answered a plain `List`.
//
// NOTE: Clamped in bigint before it narrows, exactly as `slice` is: a position
// past 2³¹ narrowed first would come out as an unrelated one.
export function insert<ItemType extends AnyType>(
	originalList: ListType<ItemType>,
	item: ItemType,
	at: IntegerType,
): ListType<ItemType> {
	let items = materialise(originalList)
	let length = BigInt(items.length)
	let requested = positionFromEnd(at.value, length)
	let position = Number(
		requested < 0n ? 0n : requested > length ? length : requested,
	)

	return createList([
		...items.slice(0, position),
		item,
		...items.slice(position),
	])
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
	let sorted = materialise(originalList).slice(0)

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
//
// NOTE: Both sides are read through a view, for the reason `is` is: two Lists
// holding the same items compare `Equal` whichever representation each of them
// happens to be in.
export function compare<ItemType extends AnyType>(
	first: ListType<ItemType>,
	second: ListType<ItemType>,
	conformance: {
		compare: (first: ItemType, second: ItemType) => OrderingType
	},
): OrderingType {
	let firstView = viewOf(first)
	let secondView = viewOf(second)
	let shared = Math.min(firstView.total, secondView.total)

	for (let index = 0; index < shared; index++) {
		let ordering = conformance.compare(
			itemOfView(firstView, index),
			itemOfView(secondView, index),
		)

		if (ordering[typeKeySymbol] !== "Ordering#Equal") {
			return ordering
		}
	}

	if (firstView.total < secondView.total) {
		return less
	}

	if (firstView.total > secondView.total) {
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
	let view = viewOf(originalList)
	let pieces: Array<string> = []

	for (let index = view.frontCount - 1; index >= 0; index--) {
		pieces.push(conformance.toString(view.front[index]).value)
	}

	for (let index = 0; index < view.backCount; index++) {
		pieces.push(conformance.toString(view.back[index]).value)
	}

	return createString(pieces.join(separator.value))
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
	if (viewOf(originalList).total === 0) {
		return createString("[]")
	}

	return createString(
		`[ ${join(originalList, createString(", "), conformance).value} ]`,
	)
}

export function flatten<ItemType extends AnyType>(
	originalList: ListType<ListType<ItemType>>,
): ListType<ItemType> {
	let view = viewOf(originalList)
	let flattened: Array<ItemType> = []

	for (let index = view.frontCount - 1; index >= 0; index--) {
		pushItemsOf(view.front[index], flattened)
	}

	for (let index = 0; index < view.backCount; index++) {
		pushItemsOf(view.back[index], flattened)
	}

	return createList(flattened)
}

export function pair<ItemType extends AnyType, Other extends AnyType>(
	originalList: ListType<ItemType>,
	otherList: ListType<Other>,
): ListType<RecordType & { first: ItemType; second: Other }> {
	let items = materialise(originalList)
	let others = materialise(otherList)
	let pairCount = Math.min(items.length, others.length)
	let pairs: Array<RecordType & { first: ItemType; second: Other }> = []

	for (let index = 0; index < pairCount; index++) {
		pairs.push({
			[typeKeySymbol]: "Record",
			first: items[index],
			second: others[index],
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

	let items = materialise(originalList)
	let total = items.length
	let size = Number(groupSize.value)
	let groups: Array<ListType<ItemType>> = []

	for (let start = 0; start < total; start += size) {
		groups.push(createList(items.slice(start, start + size)))
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
