import type { BooleanType } from "./Boolean"
import { createBoolean } from "./Boolean"
import type { IntegerType } from "./Integer"
import { createInteger } from "./Integer"
import type { EquatableWitness, KeySet } from "./keyEncoding"
import {
	addKey,
	countKey,
	freshKeyCount,
	freshKeySet,
	hasKey,
} from "./keyEncoding"
import { countCopied } from "./listWork"
import type { LoggedRun } from "./listWrites"
import { caughtUp, freshLog } from "./listWrites"
import type { OptionalType } from "./Optional"
import { createEmpty, createValue } from "./Optional"
import { equal, greater, less, type OrderingType } from "./Ordering"
import type { RecordType } from "./Record"
import type { SortOrderType } from "./SortOrder"
import type { StepType } from "./Step"
import type { StringType } from "./String"
import { createString, itemText } from "./String"
import { type AnyType, typeKeySymbol } from "./type"

// Two runs and a view into each: the back run forward in `value`, the front run
// reversed in `front`. With `front` and `length` absent, the box is flat and
// views the whole Array. See "Lists" in DEVELOPMENT.md.
export type ListType<ItemType extends AnyType> = {
	[typeKeySymbol]: "List"
	value: Array<ItemType>
	length?: number
	front?: Array<ItemType>
	frontLen?: number
	writes?: LoggedRun<ItemType>
}

// WARNING: takes ownership of the Array, which a later `append` may push onto.
// A caller that keeps its Array uses `createListFrom`.
export function createList<ItemType extends AnyType>(
	originalList: Array<ItemType>,
): ListType<ItemType> {
	return { [typeKeySymbol]: "List", value: originalList }
}

// `createList` over a copy, for the client bridge, whose host keeps its Array.
export function createListFrom<ItemType extends AnyType>(
	items: Array<ItemType>,
): ListType<ItemType> {
	return { [typeKeySymbol]: "List", value: items.slice() }
}

// The front run of every view of a box with no front, so a walk needs no guard.
// INVARIANT: nothing ever pushes onto it.
const noItems: Array<never> = []

export type ListView<ItemType extends AnyType> = {
	front: Array<ItemType>
	frontCount: number
	back: Array<ItemType>
	backCount: number
	total: number
}

// The runs trimmed under the half rule, unsealed, for readers that run no user
// code while they hold a run. See "Reading a List while user code runs" in
// DEVELOPMENT.md.
export function viewOf<ItemType extends AnyType>(
	originalList: ListType<ItemType>,
): ListView<ItemType> {
	let view = runsOf(originalList)

	trimUnderHalfRule(originalList, view)

	return view
}

// `viewOf`, sealed, for a native that hands a run to a Function or a witness.
// INVARIANT: such a native seals every run it holds, on every operand. See
// "Reading a List while user code runs" in DEVELOPMENT.md.
export function walkOf<ItemType extends AnyType>(
	originalList: ListType<ItemType>,
): ListView<ItemType> {
	let view = viewOf(originalList)

	sealWrites(originalList)

	return view
}

// Trims a run to the box's own view when the view is less than half of it. See
// "Trimming a List's runs" in DEVELOPMENT.md.
function trimUnderHalfRule<ItemType extends AnyType>(
	originalList: ListType<ItemType>,
	view: ListView<ItemType>,
): void {
	if (view.backCount * 2 < view.back.length) {
		let trimmed = view.back.slice(0, view.backCount)

		countCopied(view.backCount)
		originalList.value = trimmed
		originalList.length = view.backCount
		// The log describes the Array the box let go of.
		originalList.writes = undefined
		view.back = trimmed
	}

	if (view.frontCount * 2 < view.front.length) {
		let trimmed = view.front.slice(0, view.frontCount)

		countCopied(view.frontCount)
		originalList.front = trimmed
		originalList.frontLen = view.frontCount
		view.front = trimmed
	}
}

// The runs and their counts, read without trimming, for whatever asks a List
// about itself rather than its items.
export function runsOf<ItemType extends AnyType>(
	originalList: ListType<ItemType>,
): ListView<ItemType> {
	// Every view reader comes through here, so a box behind its log catches up
	// before any item is read.
	caughtUp(originalList)

	let backCount = originalList.length ?? originalList.value.length
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

	return {
		front,
		frontCount,
		back: originalList.value,
		backCount,
		total: frontCount + backCount,
	}
}

// The box's own Array, exactly its logical items. An upgraded box is demoted to
// the combined Array. See "Sharing a List's runs" in DEVELOPMENT.md.
export function materialise<ItemType extends AnyType>(
	originalList: ListType<ItemType>,
): Array<ItemType> {
	// The caller may walk the Array while calling user code, so a current box
	// is sealed. A freshly built Array needs no seal.
	caughtUp(originalList)

	let backCount = originalList.length ?? originalList.value.length
	let front = originalList.front

	if (front === undefined) {
		if (backCount !== originalList.value.length) {
			countCopied(backCount)
			originalList.value = originalList.value.slice(0, backCount)
			originalList.length = backCount
			originalList.writes = undefined
		} else {
			sealWrites(originalList)
		}

		return originalList.value
	}

	let frontCount = originalList.frontLen ?? front.length
	let back = originalList.value
	// Sized once and filled by index: the reversed front run is read
	// descending and written forwards.
	// oxlint-disable-next-line unicorn/no-new-array -- the answer's length
	let combined: Array<ItemType> = new Array(frontCount + backCount)

	countCopied(frontCount + backCount)

	for (let index = 0; index < frontCount; index++) {
		combined[index] = front[frontCount - 1 - index]
	}

	for (let index = 0; index < backCount; index++) {
		combined[frontCount + index] = back[index]
	}

	originalList.value = combined
	originalList.length = combined.length
	originalList.front = undefined
	originalList.frontLen = undefined
	originalList.writes = undefined

	return combined
}

// Closes the run's Array to writes in place, for every box sharing it. A box
// with no log is closed already.
function sealWrites(originalList: ListType<AnyType>): void {
	let writes = originalList.writes

	if (writes !== undefined) {
		writes.log.sealed = true
	}
}

// `runsOf`, sealed, for the walks that hand items to user code and must not
// trim the receiver.
export function sealedRunsOf<ItemType extends AnyType>(
	originalList: ListType<ItemType>,
): ListView<ItemType> {
	let view = runsOf(originalList)

	sealWrites(originalList)

	return view
}

// The logical item at a position of a fixed view, allocating nothing.
export function itemOfView<ItemType extends AnyType>(
	view: ListView<ItemType>,
	position: number,
): ItemType {
	return position < view.frontCount
		? view.front[view.frontCount - 1 - position]
		: view.back[position - view.frontCount]
}

// Pushes a List's items onto an Array the caller owns. A walk the Rewriter
// writes out builds its List in place, and adds a whole List through this.
export function pushItemsOf<ItemType extends AnyType>(
	originalList: ListType<ItemType>,
	into: Array<ItemType>,
): void {
	let view = viewOf(originalList)

	countCopied(view.total)

	for (let index = view.frontCount - 1; index >= 0; index--) {
		into.push(view.front[index])
	}

	for (let index = 0; index < view.backCount; index++) {
		into.push(view.back[index])
	}
}

// A fresh Array of a List's items, for a walk that builds its List in place
// from a seed the Program holds. A flat box is copied with one bulk `slice`.
export function ownItemsOf<ItemType extends AnyType>(
	originalList: ListType<ItemType>,
): Array<ItemType> {
	let view = runsOf(originalList)

	countCopied(view.total)

	if (view.frontCount === 0) {
		return view.back.slice(0, view.backCount)
	}

	let items: Array<ItemType> = []

	for (let index = view.frontCount - 1; index >= 0; index--) {
		items.push(view.front[index])
	}

	for (let index = 0; index < view.backCount; index++) {
		items.push(view.back[index])
	}

	return items
}

// Writes both counts down before the box shares its runs. See "Sharing a List's
// runs" in DEVELOPMENT.md.
function stampClosed<ItemType extends AnyType>(
	originalList: ListType<ItemType>,
	view: ListView<ItemType>,
): void {
	originalList.length = view.backCount

	if (originalList.front !== undefined) {
		originalList.frontLen = view.frontCount
	}
}

// A window containing the seam, as a box over both of the receiver's runs. It
// carries the receiver's `writes` with the back run. See "List windows" in
// DEVELOPMENT.md.
function sharedWindowOf<ItemType extends AnyType>(
	originalList: ListType<ItemType>,
	view: ListView<ItemType>,
	start: number,
	end: number,
): ListType<ItemType> {
	trimUnderHalfRule(originalList, view)
	stampClosed(originalList, view)

	let frontLen = view.frontCount - start
	let length = end - view.frontCount

	if (frontLen === 0) {
		return {
			[typeKeySymbol]: "List",
			value: view.back,
			length,
			writes: originalList.writes,
		}
	}

	return {
		[typeKeySymbol]: "List",
		value: view.back,
		length,
		front: view.front,
		frontLen,
		writes: originalList.writes,
	}
}

// Moves a box's seam from zero to the end, so every later suffix is a shared
// window. The empty back is a fresh Array, since the box may push onto it. See
// "List windows" in DEVELOPMENT.md.
function upgradedForSuffix<ItemType extends AnyType>(
	originalList: ListType<ItemType>,
	view: ListView<ItemType>,
): ListView<ItemType> {
	let front = view.back.slice(0, view.backCount).reverse()
	let back: Array<ItemType> = []

	countCopied(view.backCount)

	originalList.value = back
	originalList.length = 0
	originalList.front = front
	originalList.frontLen = view.backCount
	// Both runs are the box's own now, and the old log describes neither.
	originalList.writes = undefined

	return {
		front,
		frontCount: view.backCount,
		back,
		backCount: 0,
		total: view.backCount,
	}
}

// Moves a box's seam to the middle of a window that holds neither end, so a walk
// that drops from both ends cuts shared windows. The branches are a flat box, a
// seam in the front run and a seam in the back run. See "List windows" in
// DEVELOPMENT.md.
function upgradedAroundWindow<ItemType extends AnyType>(
	originalList: ListType<ItemType>,
	view: ListView<ItemType>,
	first: number,
	last: number,
): ListView<ItemType> {
	let total = view.total
	let seam = first + ((last - first) >> 1)
	let frontCount = view.frontCount
	let front: Array<ItemType>
	let back: Array<ItemType>

	countCopied(total)

	if (frontCount === 0) {
		front = view.back.slice(0, seam).reverse()
		back = view.back.slice(seam, view.backCount)
	} else if (seam <= frontCount) {
		front = view.front.slice(frontCount - seam, frontCount)
		back = view.front
			.slice(0, frontCount - seam)
			.reverse()
			.concat(view.back.slice(0, view.backCount))
	} else {
		front = view.back
			.slice(0, seam - frontCount)
			.reverse()
			.concat(view.front.slice(0, frontCount))
		back = view.back.slice(seam - frontCount, view.backCount)
	}

	originalList.value = back
	originalList.length = total - seam
	originalList.front = front
	originalList.frontLen = seam
	// Both runs are the box's own now, and the old log describes neither.
	originalList.writes = undefined

	return {
		front,
		frontCount: seam,
		back,
		backCount: total - seam,
		total,
	}
}

// The answer of an edit that rebuilt one run, sharing the other by reference.
// The receiver is stamped closed first.
export function listRebuildingFront<ItemType extends AnyType>(
	front: Array<ItemType>,
	originalList: ListType<ItemType>,
	view: ListView<ItemType>,
): ListType<ItemType> {
	stampClosed(originalList, view)

	return {
		[typeKeySymbol]: "List",
		value: view.back,
		length: view.backCount,
		front,
		frontLen: view.frontCount,
		writes: originalList.writes,
	}
}

export function listRebuildingBack<ItemType extends AnyType>(
	back: Array<ItemType>,
	originalList: ListType<ItemType>,
	view: ListView<ItemType>,
): ListType<ItemType> {
	// With no front run to share, the fresh back run is the whole answer.
	if (view.frontCount === 0) {
		return createList(back)
	}

	stampClosed(originalList, view)

	return {
		[typeKeySymbol]: "List",
		value: back,
		length: view.backCount,
		front: view.front,
		frontLen: view.frontCount,
	}
}

// A new box over a back run, sharing the source's front run and `frontLen`. The
// caller hands in the back run's `writes`, which a fresh Array has none of.
function listSharingFrontOf<ItemType extends AnyType>(
	value: Array<ItemType>,
	length: number,
	source: ListType<ItemType>,
	writes: LoggedRun<ItemType> | undefined,
): ListType<ItemType> {
	if (source.front === undefined) {
		return { [typeKeySymbol]: "List", value, length, writes }
	}

	return {
		[typeKeySymbol]: "List",
		value,
		length,
		front: source.front,
		frontLen: source.frontLen,
		writes,
	}
}

// Item by item through the items' own `is`, lengths first. Both sides are
// sealed, since the witness runs while both runs are held.
export function is<ItemType extends AnyType>(
	originalList: ListType<ItemType>,
	otherList: ListType<ItemType>,
	conformance: {
		is: (first: ItemType, second: ItemType) => BooleanType
	},
): BooleanType {
	let original = walkOf(originalList)
	let other = walkOf(otherList)

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

// Reads through `runsOf`, since a drain asks every window for its length before
// slicing it, and trimming there would copy the run each turn.
export function length(originalList: ListType<AnyType>): IntegerType {
	return createInteger(runsOf(originalList).total)
}

// Native because its Type promises a `NonEmptyList`, which no Essence
// expression can carry. Tip-or-copy on the front run, or an upgrade for a box
// without one. See "Sharing a List's runs" in DEVELOPMENT.md.
export function prepend__overload$1<ItemType extends AnyType>(
	originalList: ListType<ItemType>,
	item: ItemType,
): ListType<ItemType> {
	// The answer carries the receiver's `writes`, so it would catch up on its
	// own. Catching up first lets both share one repaired Array.
	caughtUp(originalList)

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
			writes: originalList.writes,
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
			writes: originalList.writes,
		}
	}

	let copiedFront = front.slice(0, frontCount)

	countCopied(frontCount)
	copiedFront.push(item)

	return {
		[typeKeySymbol]: "List",
		value: originalList.value,
		length: backCount,
		front: copiedFront,
		frontLen: frontCount + 1,
		writes: originalList.writes,
	}
}

// Native because its Type promises a `NonEmptyList`. Tip-or-copy on the back
// run. See "Sharing a List's runs" in DEVELOPMENT.md.
export function append__overload$1<ItemType extends AnyType>(
	originalList: ListType<ItemType>,
	item: ItemType,
): ListType<ItemType> {
	// A box behind its log must not push onto the Array it is behind on.
	caughtUp(originalList)

	let count = originalList.length ?? originalList.value.length

	if (count === originalList.value.length) {
		originalList.length = count
		originalList.value.push(item)

		return listSharingFrontOf(
			originalList.value,
			count + 1,
			originalList,
			originalList.writes,
		)
	}

	let copied = originalList.value.slice(0, count)

	countCopied(count)
	copied.push(item)

	return listSharingFrontOf(copied, count + 1, originalList, undefined)
}

// Tip-or-copy on the receiver's back run. The other List's counts are fixed
// before the first push, so `a::append(contentsOf a)` answers `a` twice.
export function append__overload$2<ItemType extends AnyType>(
	originalList: ListType<ItemType>,
	contentsOf: ListType<ItemType>,
): ListType<ItemType> {
	caughtUp(originalList)

	let count = originalList.length ?? originalList.value.length
	let target: Array<ItemType>
	let writes: LoggedRun<ItemType> | undefined

	if (count === originalList.value.length) {
		originalList.length = count
		target = originalList.value
		writes = originalList.writes
	} else {
		target = originalList.value.slice(0, count)
		writes = undefined
		countCopied(count)
	}

	pushItemsOf(contentsOf, target)

	return listSharingFrontOf(target, target.length, originalList, writes)
}

export function map<ItemType extends AnyType, Other extends AnyType>(
	originalList: ListType<ItemType>,
	transform: (item: ItemType) => Other,
): ListType<Other> {
	let view = walkOf(originalList)
	let transformed: Array<Other> = []

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
	Answer extends AnyType,
>(
	originalList: ListType<ItemType>,
	startingValue: Answer,
	combine: (accumulator: Answer, item: ItemType) => Answer,
): Answer {
	let view = walkOf(originalList)
	let accumulator = startingValue

	for (let index = view.frontCount - 1; index >= 0; index--) {
		accumulator = combine(accumulator, view.front[index])
	}

	for (let index = 0; index < view.backCount; index++) {
		accumulator = combine(accumulator, view.back[index])
	}

	return accumulator
}

// The early-stopping fold: `#Done` ends the walk with its value, and
// `#Continue` carries the accumulator on. No Essence expression can stop a walk.
export function reduce__overload$2<
	ItemType extends AnyType,
	Answer extends AnyType,
>(
	originalList: ListType<ItemType>,
	startingValue: Answer,
	combine: (accumulator: Answer, item: ItemType) => StepType<Answer, Answer>,
): Answer {
	let view = walkOf(originalList)
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

// `reduce` keeping every value it builds. The starting value comes first, so
// the answer is never empty, which only a native can promise.
export function accumulate<ItemType extends AnyType, Answer extends AnyType>(
	originalList: ListType<ItemType>,
	startingValue: Answer,
	combine: (accumulator: Answer, item: ItemType) => Answer,
): ListType<Answer> {
	let view = walkOf(originalList)
	let accumulator = startingValue
	let running: Array<Answer> = [accumulator]

	for (let index = view.frontCount - 1; index >= 0; index--) {
		accumulator = combine(accumulator, view.front[index])
		running.push(accumulator)
	}

	for (let index = 0; index < view.backCount; index++) {
		accumulator = combine(accumulator, view.back[index])
		running.push(accumulator)
	}

	return createList(running)
}

export function everyItem__overload$1<ItemType extends AnyType>(
	originalList: ListType<ItemType>,
	keepFunction: (item: ItemType) => BooleanType,
): ListType<ItemType> {
	let view = walkOf(originalList)
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

// The filter and its complement in one walk, so the check sees each item once.
export function partition__overload$1<ItemType extends AnyType>(
	originalList: ListType<ItemType>,
	check: (item: ItemType) => BooleanType,
): RecordType & { accepted: ListType<ItemType>; refused: ListType<ItemType> } {
	let view = walkOf(originalList)
	let accepted: Array<ItemType> = []
	let refused: Array<ItemType> = []

	for (let index = view.frontCount - 1; index >= 0; index--) {
		let item = view.front[index]

		if (check(item).value) {
			accepted.push(item)
		} else {
			refused.push(item)
		}
	}

	for (let index = 0; index < view.backCount; index++) {
		let item = view.back[index]

		if (check(item).value) {
			accepted.push(item)
		} else {
			refused.push(item)
		}
	}

	return {
		[typeKeySymbol]: "Record",
		accepted: createList(accepted),
		refused: createList(refused),
	}
}

// A negative position counts back from the end, so -1 is the last item. Double
// arithmetic keeps an out-of-range position out of range at any size.
export function positionFromEnd(
	index: number | bigint,
	length: number,
): number {
	// A bigint index is outside the safe range, so past either end of any Array.
	if (typeof index !== "number") {
		return index < 0n ? -1 : length
	}

	return index < 0 ? index + length : index
}

// Reads the item out of its run without combining the runs. `viewOf` rather than
// `walkOf`, since a seal would make every positional write after it copy.
export function item__overload$1<ItemType extends AnyType>(
	originalList: ListType<ItemType>,
	index: IntegerType,
): OptionalType<ItemType> {
	let view = viewOf(originalList)
	let length = view.total
	let position = positionFromEnd(index.value, length)

	if (position > -1 && position < length) {
		return createValue(itemOfView(view, position))
	} else {
		return createEmpty()
	}
}

// The backwards walk, which Essence can not write without copying the List.
// The back run is walked from its end, then the reversed front run from its
// start.
export function lastIndex__overload$3<ItemType extends AnyType>(
	originalList: ListType<ItemType>,
	check: (item: ItemType) => BooleanType,
): OptionalType<IntegerType> {
	let view = walkOf(originalList)

	for (let index = view.backCount - 1; index >= 0; index--) {
		if (check(view.back[index]).value) {
			return createValue(createInteger(view.frontCount + index))
		}
	}

	for (let index = 0; index < view.frontCount; index++) {
		if (check(view.front[index]).value) {
			return createValue(createInteger(view.frontCount - 1 - index))
		}
	}

	return createEmpty()
}

export function slice<ItemType extends AnyType>(
	originalList: ListType<ItemType>,
	from: IntegerType,
	to: IntegerType,
): ListType<ItemType> {
	// Half-open. A negative end counts back from the end, and then each end is
	// clamped, so a position before the start settles on zero.
	let view = runsOf(originalList)
	let length = view.total
	let fromPosition = positionFromEnd(from.value, length)
	let toPosition = positionFromEnd(to.value, length)
	let first =
		fromPosition < 0 ? 0 : fromPosition > length ? length : fromPosition
	let last = toPosition < 0 ? 0 : toPosition > length ? length : toPosition

	if (last <= first) {
		return createList([])
	}

	// A window containing the seam shares both runs.
	if (first <= view.frontCount && last >= view.frontCount) {
		return sharedWindowOf(originalList, view, first, last)
	}

	// A suffix of a box with its seam at zero, under the half rule.
	if (view.frontCount === 0 && last === length && first <= length - first) {
		return sharedWindowOf(
			originalList,
			upgradedForSuffix(originalList, view),
			first,
			last,
		)
	}

	// An interior window keeping at least three quarters of the List.
	if ((last - first) * 4 >= length * 3) {
		return sharedWindowOf(
			originalList,
			upgradedAroundWindow(originalList, view, first, last),
			first,
			last,
		)
	}

	// Every other window lies inside one run and is copied out of it.
	if (last < view.frontCount) {
		let count = last - first
		// `Array.from({ length })` would fill through an iterator.
		// oxlint-disable-next-line unicorn/no-new-array -- the answer's length
		let items: Array<ItemType> = new Array(count)
		let front = view.front
		let highest = view.frontCount - 1 - first

		countCopied(count)

		for (let index = 0; index < count; index++) {
			items[index] = front[highest - index]
		}

		return createList(items)
	}

	countCopied(last - first)

	return createList(
		view.back.slice(first - view.frontCount, last - view.frontCount),
	)
}

// The List without the item at the position, filled once. A position naming no
// item leaves the List alone. Dropping the first or the last item is a shared
// window where the runs allow one. The last item of a box with an empty back
// takes the general path.
export function remove<ItemType extends AnyType>(
	originalList: ListType<ItemType>,
	at: IntegerType,
): ListType<ItemType> {
	let view = runsOf(originalList)
	let total = view.total
	let position = positionFromEnd(at.value, total)

	if (position < 0 || position >= total) {
		return originalList
	}

	if (position === 0 && view.frontCount > 0) {
		return sharedWindowOf(originalList, view, 1, view.total)
	}

	if (position === 0 && total >= 2) {
		return sharedWindowOf(
			originalList,
			upgradedForSuffix(originalList, view),
			1,
			total,
		)
	}

	if (position === view.total - 1 && view.backCount > 0) {
		return sharedWindowOf(originalList, view, 0, view.total - 1)
	}

	// Each run is walked in two halves split at the position, so no turn asks
	// whether its item is the one dropped.
	// oxlint-disable-next-line unicorn/no-new-array -- the answer's length
	let items: Array<ItemType> = new Array(view.total - 1)

	countCopied(view.total - 1)
	let front = view.front
	let frontCount = view.frontCount
	let back = view.back
	let backCount = view.backCount
	let inFront = position < frontCount
	let frontSplit = inFront ? position : frontCount
	let frontResume = inFront ? position + 1 : frontCount
	let backSplit = inFront ? 0 : position - frontCount
	let backResume = inFront ? 0 : position - frontCount + 1
	let target = 0

	for (let index = 0; index < frontSplit; index++) {
		items[target] = front[frontCount - 1 - index]
		target++
	}

	for (let index = 0; index < backSplit; index++) {
		items[target] = back[index]
		target++
	}

	for (let index = frontResume; index < frontCount; index++) {
		items[target] = front[frontCount - 1 - index]
		target++
	}

	for (let index = backResume; index < backCount; index++) {
		items[target] = back[index]
		target++
	}

	return createList(items)
}

export function reverse<ItemType extends AnyType>(
	originalList: ListType<ItemType>,
): ListType<ItemType> {
	return createList(materialise(originalList).slice(0).reverse())
}

// The position is clamped as `slice` clamps, so no position drops the item and
// the Type may promise a `NonEmptyList`. The two ends go to `prepend` and
// `append`, and every other position fills one Array of the answer's size.
export function insert<ItemType extends AnyType>(
	originalList: ListType<ItemType>,
	item: ItemType,
	at: IntegerType,
): ListType<ItemType> {
	let view = runsOf(originalList)
	let length = view.total
	let requested = positionFromEnd(at.value, length)
	let position = requested < 0 ? 0 : requested > length ? length : requested

	if (position === 0) {
		return prepend__overload$1(originalList, item)
	}

	if (position === view.total) {
		return append__overload$1(originalList, item)
	}

	// Each run is walked in two halves split at the position, so no turn asks
	// where the item goes.
	// oxlint-disable-next-line unicorn/no-new-array -- the answer's length
	let items: Array<ItemType> = new Array(view.total + 1)

	countCopied(view.total)
	let front = view.front
	let frontCount = view.frontCount
	let back = view.back
	let backCount = view.backCount
	let frontSplit = position < frontCount ? position : frontCount
	let backSplit = position > frontCount ? position - frontCount : 0
	let target = 0

	for (let index = 0; index < frontSplit; index++) {
		items[target] = front[frontCount - 1 - index]
		target++
	}

	for (let index = 0; index < backSplit; index++) {
		items[target] = back[index]
		target++
	}

	items[target] = item
	target++

	for (let index = frontSplit; index < frontCount; index++) {
		items[target] = front[frontCount - 1 - index]
		target++
	}

	for (let index = backSplit; index < backCount; index++) {
		items[target] = back[index]
		target++
	}

	return createList(items)
}

// One item out and one in, keeping the length. A position naming no item leaves
// the List alone. Native so that a write into the back run can happen in place.
// See "The List write log" in DEVELOPMENT.md.
export function replace__overload$1<ItemType extends AnyType>(
	originalList: ListType<ItemType>,
	item: ItemType,
	at: IntegerType,
): ListType<ItemType> {
	let view = runsOf(originalList)
	let length = view.total
	let position = positionFromEnd(at.value, length)

	if (position < 0 || position >= length) {
		return originalList
	}

	// A front run is never written in place, so the touched run is copied and
	// the back run shared.
	if (position < view.frontCount) {
		let front = view.front.slice(0, view.frontCount)

		countCopied(view.frontCount)
		front[view.frontCount - 1 - position] = item

		return listRebuildingFront(front, originalList, view)
	}

	return writtenInBack(originalList, view, position - view.frontCount, item)
}

// Writes in place when the box is current for an unsealed log with room left.
// Otherwise it copies, and the copy gets a fresh log. See "The List write log" in
// DEVELOPMENT.md.
function writtenInBack<ItemType extends AnyType>(
	originalList: ListType<ItemType>,
	view: ListView<ItemType>,
	position: number,
	item: ItemType,
): ListType<ItemType> {
	let back = view.back
	let count = view.backCount
	let writes = originalList.writes

	if (
		writes !== undefined &&
		writes.seen === writes.log.version &&
		!writes.log.sealed &&
		writes.log.version < count
	) {
		let log = writes.log

		log.positions.push(position)
		log.items.push(back[position])
		log.version++
		back[position] = item

		stampClosed(originalList, view)

		let seen = { log, seen: log.version }

		// A flat box keeps the shape `createList` and the Optimiser's literal
		// build, rather than carrying undefined front fields.
		if (view.frontCount === 0) {
			return {
				[typeKeySymbol]: "List",
				value: back,
				length: count,
				writes: seen,
			}
		}

		return {
			[typeKeySymbol]: "List",
			value: back,
			length: count,
			front: view.front,
			frontLen: view.frontCount,
			writes: seen,
		}
	}

	// INVARIANT: a log is minted only on an Array no other box holds.
	let copied = back.slice(0, count)

	countCopied(count)
	copied[position] = item

	let answer = listRebuildingBack(copied, originalList, view)

	answer.writes = { log: freshLog(), seen: 0 }

	return answer
}

// Native because every Essence body for it allocates per item. It stops at the
// first pair out of order. A descending check swaps the comparison, as `sort`
// does, so equal items are in order either way.
export function isSorted<ItemType extends AnyType>(
	originalList: ListType<ItemType>,
	order: SortOrderType,
	conformance: {
		compare: (self: ItemType, other: ItemType) => OrderingType
	},
): BooleanType {
	let view = walkOf(originalList)
	let descending = order[typeKeySymbol] === "SortOrder#Descending"
	let previous: ItemType | null = null

	for (let index = view.frontCount - 1; index >= 0; index--) {
		let item = view.front[index]

		if (
			previous !== null &&
			outOfOrder(conformance, previous, item, descending)
		) {
			return createBoolean(false)
		}

		previous = item
	}

	for (let index = 0; index < view.backCount; index++) {
		let item = view.back[index]

		if (
			previous !== null &&
			outOfOrder(conformance, previous, item, descending)
		) {
			return createBoolean(false)
		}

		previous = item
	}

	return createBoolean(true)
}

function outOfOrder<ItemType extends AnyType>(
	conformance: { compare: (self: ItemType, other: ItemType) => OrderingType },
	previous: ItemType,
	item: ItemType,
	descending: boolean,
): boolean {
	let ordering = descending
		? conformance.compare(item, previous)
		: conformance.compare(previous, item)

	return ordering[typeKeySymbol] === "Ordering#Greater"
}

// Orders by the items' own `compare`. A descending sort swaps the pair rather
// than reversing the answer, so the stable `Array.sort` keeps ties in order.
export function sort__overload$1<ItemType extends AnyType>(
	originalList: ListType<ItemType>,
	order: SortOrderType,
	conformance: {
		compare: (self: ItemType, other: ItemType) => OrderingType
	},
): ListType<ItemType> {
	return order[typeKeySymbol] === "SortOrder#Descending"
		? sort__overload$2(originalList, (first, second) =>
				conformance.compare(second, first),
			)
		: sort__overload$2(originalList, (first, second) =>
				conformance.compare(first, second),
			)
}

export function sort__overload$2<ItemType extends AnyType>(
	originalList: ListType<ItemType>,
	order: (first: ItemType, second: ItemType) => OrderingType,
): ListType<ItemType> {
	// A copy is sorted, and `Array.sort` is stable.
	let sorted = materialise(originalList).slice(0)

	sorted.sort((first, second) => signOf(order(first, second)))

	return createList(sorted)
}

function signOf(ordering: OrderingType): number {
	if (ordering[typeKeySymbol] === "Ordering#Less") {
		return -1
	} else if (ordering[typeKeySymbol] === "Ordering#Greater") {
		return 1
	} else {
		return 0
	}
}

// Orders by a key read once per item. The positions are sorted on the keys, so
// no Record is built per item. Stable in either direction, as the other entries
// are.
export function sort__overload$3<ItemType extends AnyType, Key extends AnyType>(
	originalList: ListType<ItemType>,
	key: (item: ItemType) => Key,
	order: SortOrderType,
	conformance: {
		compare: (self: Key, other: Key) => OrderingType
	},
): ListType<ItemType> {
	let items = materialise(originalList)
	let count = items.length
	// oxlint-disable-next-line unicorn/no-new-array -- the answer's length
	let keys: Array<Key> = new Array(count)
	// oxlint-disable-next-line unicorn/no-new-array -- the answer's length
	let positions: Array<number> = new Array(count)

	for (let index = 0; index < count; index++) {
		keys[index] = key(items[index])
		positions[index] = index
	}

	if (order[typeKeySymbol] === "SortOrder#Descending") {
		positions.sort((first, second) =>
			signOf(conformance.compare(keys[second], keys[first])),
		)
	} else {
		positions.sort((first, second) =>
			signOf(conformance.compare(keys[first], keys[second])),
		)
	}

	// oxlint-disable-next-line unicorn/no-new-array -- the answer's length
	let sorted: Array<ItemType> = new Array(count)

	for (let index = 0; index < count; index++) {
		sorted[index] = items[positions[index]]
	}

	return createList(sorted)
}

// Lexicographic: the first pair that is not `#Equal` decides, and on an equal
// prefix the shorter List is `#Less`. Both sides are sealed, as in `is`.
export function compare<ItemType extends AnyType>(
	first: ListType<ItemType>,
	second: ListType<ItemType>,
	conformance: {
		compare: (first: ItemType, second: ItemType) => OrderingType
	},
): OrderingType {
	let firstView = walkOf(first)
	let secondView = walkOf(second)
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

// Bounded by `Printable`, so any items join through their `toString`.
export function join<ItemType extends AnyType>(
	originalList: ListType<ItemType>,
	separator: StringType,
	conformance: {
		toString: (value: ItemType) => StringType
	},
): StringType {
	let view = walkOf(originalList)
	let pieces: Array<string> = []

	for (let index = view.frontCount - 1; index >= 0; index--) {
		pieces.push(conformance.toString(view.front[index]).value)
	}

	for (let index = 0; index < view.backCount; index++) {
		pieces.push(conformance.toString(view.back[index]).value)
	}

	return createString(pieces.join(separator.value))
}

// The List as a Program writes it, so a String item is quoted where `join`
// leaves it bare. Native, since an Essence body would call `String::append`,
// and `String` is written on `List`.
export function toString<ItemType extends AnyType>(
	originalList: ListType<ItemType>,
	conformance: {
		toString: (value: ItemType) => StringType
	},
): StringType {
	let view = walkOf(originalList)
	let pieces: Array<string> = []

	for (let index = view.frontCount - 1; index >= 0; index--) {
		pieces.push(itemText(view.front[index], conformance))
	}

	for (let index = 0; index < view.backCount; index++) {
		pieces.push(itemText(view.back[index], conformance))
	}

	return createString(`[${pieces.join(", ")}]`)
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

// One position for every item, so `NonEmptyList` re-exports this as its proven
// entry.
export function indices__overload$1(
	originalList: ListType<AnyType>,
): ListType<IntegerType> {
	let total = runsOf(originalList).total
	let positions: Array<IntegerType> = []

	for (let index = 0; index < total; index++) {
		positions.push(createInteger(index))
	}

	return createList(positions)
}

// Each item beside its position. An Essence body would read each item back by
// position and build an Optional per item.
export function enumerate<ItemType extends AnyType>(
	originalList: ListType<ItemType>,
): ListType<RecordType & { index: IntegerType; item: ItemType }> {
	let items = materialise(originalList)
	let entries: Array<RecordType & { index: IntegerType; item: ItemType }> = []

	for (let index = 0; index < items.length; index++) {
		entries.push({
			[typeKeySymbol]: "Record",
			index: createInteger(index),
			item: items[index],
		})
	}

	return createList(entries)
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

// A group size below one answers the whole List as one group. A group opens
// only while an item remains, so every group holds one, as its Type promises.
// The empty List answers no groups.
export function split__overload$1<ItemType extends AnyType>(
	originalList: ListType<ItemType>,
	groupSize: IntegerType,
): ListType<ListType<ItemType>> {
	let items = materialise(originalList)
	let total = items.length
	let size =
		groupSize.value < 1 ? Math.max(total, 1) : Number(groupSize.value)
	let groups: Array<ListType<ItemType>> = []

	for (let start = 0; start < total; start += size) {
		groups.push(createList(items.slice(start, start + size)))
	}

	return createList(groups)
}

// The walk behind the range natives. The step is signed and never zero.
// `atLeastOne` keeps the `downTo:` promise: a first value already past the end
// is answered alone. A range with bigint ends could not fit in memory anyway.
function integerRange(
	firstInteger: IntegerType,
	lastInteger: IntegerType,
	step: number | bigint,
	atLeastOne: boolean,
): ListType<IntegerType> {
	let integers: Array<IntegerType> = []
	let first = firstInteger.value
	let last = lastInteger.value

	if (
		typeof first === "number" &&
		typeof last === "number" &&
		typeof step === "number"
	) {
		if (step > 0) {
			for (let value = first; value <= last; value += step) {
				integers.push(createInteger(value))
			}
		} else {
			for (let value = first; value >= last; value += step) {
				integers.push(createInteger(value))
			}
		}

		if (atLeastOne && integers.length === 0) {
			integers.push(createInteger(first))
		}

		return createList(integers)
	}

	let from = BigInt(first)
	let to = BigInt(last)
	let by = BigInt(step)

	if (by > 0n) {
		for (let value = from; value <= to; value += by) {
			integers.push(createInteger(value))
		}
	} else {
		for (let value = from; value >= to; value += by) {
			integers.push(createInteger(value))
		}
	}

	if (atLeastOne && integers.length === 0) {
		integers.push(createInteger(from))
	}

	return createList(integers)
}

// The step is passed as a number. `Integer.ts` imports this module through
// `String.ts`, so a top-level `createInteger(1)` here could run before
// `Integer.ts` binds its bounds.
export function of__overload$1(
	firstInteger: IntegerType,
	lastInteger: IntegerType,
): ListType<IntegerType> {
	return integerRange(firstInteger, lastInteger, 1, false)
}

export function of__overload$3(
	firstInteger: IntegerType,
	lastInteger: IntegerType,
): ListType<IntegerType> {
	return integerRange(firstInteger, lastInteger, -1, true)
}

export function of__overload$4(
	firstInteger: IntegerType,
	lastInteger: IntegerType,
	stepInteger: IntegerType,
): ListType<IntegerType> {
	return integerRange(firstInteger, lastInteger, stepInteger.value, false)
}

export function of__overload$6(
	firstInteger: IntegerType,
	lastInteger: IntegerType,
	stepInteger: IntegerType,
): ListType<IntegerType> {
	return integerRange(firstInteger, lastInteger, stepInteger.value, true)
}

// The count is a proven `PositiveInteger`, so the answer is never empty, which
// the Essence entry can not say.
export function repeat__overload$2<ItemType extends AnyType>(
	item: ItemType,
	count: IntegerType,
): ListType<ItemType> {
	let copies: Array<ItemType> = []

	for (let index = Number(count.value); index > 0; index--) {
		copies.push(item)
	}

	return createList(copies)
}

// The set-shaped natives walk once with one `KeySet` lookup per item, where a
// fold on `contains` would be quadratic. See "Key sets and counts" in
// DEVELOPMENT.md.
//
// The item as its own key, so the bare entries share the `on:` entries' walk.
function itself<ItemType extends AnyType>(item: ItemType): ItemType {
	return item
}

// Every key of a List. The key Function and the witness are user code, so the
// runs are sealed.
function keySetOver<ItemType extends AnyType, Key extends AnyType>(
	originalList: ListType<ItemType>,
	keyOf: (item: ItemType) => Key,
	conformance: EquatableWitness<Key>,
): KeySet<Key> {
	let view = sealedRunsOf(originalList)
	let set = freshKeySet(conformance)

	for (let index = view.frontCount - 1; index >= 0; index--) {
		addKey(set, keyOf(view.front[index]))
	}

	for (let index = 0; index < view.backCount; index++) {
		addKey(set, keyOf(view.back[index]))
	}

	return set
}

// The intersection and the difference as filters over the receiver, so an
// item is kept every time it occurs.
function keptByMembership<ItemType extends AnyType>(
	originalList: ListType<ItemType>,
	otherList: ListType<ItemType>,
	conformance: EquatableWitness<ItemType>,
	keeping: boolean,
): ListType<ItemType> {
	let other = keySetOver(otherList, itself, conformance)
	let view = walkOf(originalList)
	let kept: Array<ItemType> = []

	for (let index = view.frontCount - 1; index >= 0; index--) {
		let item = view.front[index]

		if (hasKey(other, item) === keeping) {
			kept.push(item)
		}
	}

	for (let index = 0; index < view.backCount; index++) {
		let item = view.back[index]

		if (hasKey(other, item) === keeping) {
			kept.push(item)
		}
	}

	return createList(kept)
}

// The first item met at each key. `addKey` answers whether the key was new, so
// the test and the insertion are one lookup.
function firstAtEachKey<ItemType extends AnyType, Key extends AnyType>(
	originalList: ListType<ItemType>,
	keyOf: (item: ItemType) => Key,
	conformance: EquatableWitness<Key>,
): ListType<ItemType> {
	let view = walkOf(originalList)
	let seen = freshKeySet(conformance)
	let kept: Array<ItemType> = []

	for (let index = view.frontCount - 1; index >= 0; index--) {
		let item = view.front[index]

		if (addKey(seen, keyOf(item))) {
			kept.push(item)
		}
	}

	for (let index = 0; index < view.backCount; index++) {
		let item = view.back[index]

		if (addKey(seen, keyOf(item))) {
			kept.push(item)
		}
	}

	return createList(kept)
}

// Stops at the first key met twice, which is all `hasDuplicates` asks.
function meetsAKeyTwice<ItemType extends AnyType, Key extends AnyType>(
	originalList: ListType<ItemType>,
	keyOf: (item: ItemType) => Key,
	conformance: EquatableWitness<Key>,
): BooleanType {
	let view = sealedRunsOf(originalList)
	let seen = freshKeySet(conformance)

	for (let index = view.frontCount - 1; index >= 0; index--) {
		if (!addKey(seen, keyOf(view.front[index]))) {
			return createBoolean(true)
		}
	}

	for (let index = 0; index < view.backCount; index++) {
		if (!addKey(seen, keyOf(view.back[index]))) {
			return createBoolean(true)
		}
	}

	return createBoolean(false)
}

// The subset question. The receiver is indexed and the Argument walked, so the
// first missing item settles it. Both are sealed, and an empty Argument answers
// `true` at once.
export function contains__overload$2<ItemType extends AnyType>(
	originalList: ListType<ItemType>,
	otherList: ListType<ItemType>,
	conformance: EquatableWitness<ItemType>,
): BooleanType {
	let others = sealedRunsOf(otherList)

	if (others.total === 0) {
		return createBoolean(true)
	}

	let held = keySetOver(originalList, itself, conformance)

	for (let index = others.frontCount - 1; index >= 0; index--) {
		if (!hasKey(held, others.front[index])) {
			return createBoolean(false)
		}
	}

	for (let index = 0; index < others.backCount; index++) {
		if (!hasKey(held, others.back[index])) {
			return createBoolean(false)
		}
	}

	return createBoolean(true)
}

export function everyItem__overload$2<ItemType extends AnyType>(
	originalList: ListType<ItemType>,
	otherList: ListType<ItemType>,
	conformance: EquatableWitness<ItemType>,
): ListType<ItemType> {
	return keptByMembership(originalList, otherList, conformance, true)
}

export function removeEvery__overload$3<ItemType extends AnyType>(
	originalList: ListType<ItemType>,
	otherList: ListType<ItemType>,
	conformance: EquatableWitness<ItemType>,
): ListType<ItemType> {
	return keptByMembership(originalList, otherList, conformance, false)
}

export function removeDuplicates__overload$1<ItemType extends AnyType>(
	originalList: ListType<ItemType>,
	conformance: EquatableWitness<ItemType>,
): ListType<ItemType> {
	return firstAtEachKey(originalList, itself, conformance)
}

export function removeDuplicates__overload$2<
	ItemType extends AnyType,
	Key extends AnyType,
>(
	originalList: ListType<ItemType>,
	keyOf: (item: ItemType) => Key,
	conformance: EquatableWitness<Key>,
): ListType<ItemType> {
	return firstAtEachKey(originalList, keyOf, conformance)
}

export function hasDuplicates__overload$1<ItemType extends AnyType>(
	originalList: ListType<ItemType>,
	conformance: EquatableWitness<ItemType>,
): BooleanType {
	return meetsAKeyTwice(originalList, itself, conformance)
}

export function hasDuplicates__overload$2<
	ItemType extends AnyType,
	Key extends AnyType,
>(
	originalList: ListType<ItemType>,
	keyOf: (item: ItemType) => Key,
	conformance: EquatableWitness<Key>,
): BooleanType {
	return meetsAKeyTwice(originalList, keyOf, conformance)
}

// The item counted highest by its canonical encoding, the earliest key on a
// tie. It answers a key's first occurrence, as a Dictionary keeps it: `[3, 3/1,
// 4]` answers the Integer `3`.
export function mode<ItemType extends AnyType>(
	originalList: ListType<ItemType>,
): ItemType {
	let view = sealedRunsOf(originalList)
	let count = freshKeyCount<ItemType>()

	for (let index = view.frontCount - 1; index >= 0; index--) {
		countKey(count, view.front[index])
	}

	for (let index = 0; index < view.backCount; index++) {
		countKey(count, view.back[index])
	}

	let highest = 0

	for (let index = 1; index < count.counts.length; index++) {
		if (count.counts[index] > count.counts[highest]) {
			highest = index
		}
	}

	return count.keys[highest]
}

// The pieces between accepted items, as `String::split(on:)` cuts. There is
// always one piece more than accepted items, so the answer is never empty.
export function split__overload$3<ItemType extends AnyType>(
	originalList: ListType<ItemType>,
	check: (item: ItemType) => BooleanType,
): ListType<ListType<ItemType>> {
	let view = walkOf(originalList)
	let pieces: Array<ListType<ItemType>> = []
	let piece: Array<ItemType> = []

	for (let index = view.frontCount - 1; index >= 0; index--) {
		let item = view.front[index]

		if (check(item).value) {
			pieces.push(createList(piece))
			piece = []
		} else {
			piece.push(item)
		}
	}

	for (let index = 0; index < view.backCount; index++) {
		let item = view.back[index]

		if (check(item).value) {
			pieces.push(createList(piece))
			piece = []
		} else {
			piece.push(item)
		}
	}

	pieces.push(createList(piece))

	return createList(pieces)
}

// Every stretch of one size, one position apart. A size above the length
// answers nothing. The size is a proven `PositiveInteger`, so every stretch
// holds an item.
export function windows<ItemType extends AnyType>(
	originalList: ListType<ItemType>,
	windowSize: IntegerType,
): ListType<ListType<ItemType>> {
	let items = materialise(originalList)
	let size = Number(windowSize.value)
	let stretches: Array<ListType<ItemType>> = []

	for (let start = 0; start + size <= items.length; start++) {
		stretches.push(createList(items.slice(start, start + size)))
	}

	return createList(stretches)
}

// The longest stretches of neighbours the check accepts. Each holds an item,
// which its Type promises and no Essence fold could.
export function runs<ItemType extends AnyType>(
	originalList: ListType<ItemType>,
	check: (item: ItemType) => BooleanType,
): ListType<ListType<ItemType>> {
	let view = walkOf(originalList)
	let stretches: Array<ListType<ItemType>> = []
	let current: Array<ItemType> = []

	for (let index = view.frontCount - 1; index >= 0; index--) {
		let item = view.front[index]

		if (check(item).value) {
			current.push(item)
		} else if (current.length > 0) {
			stretches.push(createList(current))
			current = []
		}
	}

	for (let index = 0; index < view.backCount; index++) {
		let item = view.back[index]

		if (check(item).value) {
			current.push(item)
		} else if (current.length > 0) {
			stretches.push(createList(current))
			current = []
		}
	}

	if (current.length > 0) {
		stretches.push(createList(current))
	}

	return createList(stretches)
}

// The inner Lists read as columns. The shortest decides how many, as in
// `pair(with:)`, and each row is combined once.
export function transpose<ItemType extends AnyType>(
	originalList: ListType<ListType<ItemType>>,
): ListType<ListType<ItemType>> {
	let rows = materialise(originalList)
	let items: Array<Array<ItemType>> = []
	let shortest = 0

	for (let index = 0; index < rows.length; index++) {
		let row = materialise(rows[index])

		items.push(row)

		if (index === 0 || row.length < shortest) {
			shortest = row.length
		}
	}

	let columns: Array<ListType<ItemType>> = []

	for (let position = 0; position < shortest; position++) {
		let column: Array<ItemType> = []

		for (let index = 0; index < items.length; index++) {
			column.push(items[index][position])
		}

		columns.push(createList(column))
	}

	return createList(columns)
}
