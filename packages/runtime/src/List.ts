import type { BooleanType } from "./Boolean"
import { createBoolean } from "./Boolean"
import type { IntegerType } from "./Integer"
import { createInteger } from "./Integer"
import type { EquatableWitness, KeySet } from "./keyEncoding"
import { addKey, freshKeySet, hasKey } from "./keyEncoding"
import type { OptionalType } from "./Optional"
import { createEmpty, createValue } from "./Optional"
import { equal, greater, less, type OrderingType } from "./Ordering"
import type { RecordType } from "./Record"
import type { SortOrderType } from "./SortOrder"
import type { StepType } from "./Step"
import type { StringType } from "./String"
import { createString, itemText } from "./String"
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
	let view = runsOf(originalList)

	// NOTE: A box whose view is shorter than its run is holding the whole of
	// its chain's high-water Array alive. Reading it trims that away and stores
	// the trimmed Array back, so the work happens once however often the box is
	// read afterwards — and the Array a reader is handed keeps its identity
	// across reads.
	if (view.backCount !== view.back.length) {
		let trimmed = view.back.slice(0, view.backCount)

		originalList.value = trimmed
		originalList.length = view.backCount
		view.back = trimmed
	}

	// NOTE: A front-less box views zero items of the one shared `noItems`, which
	// is zero items long, so this can not fire for it and no box is ever given a
	// front run it did not have.
	if (view.frontCount !== view.front.length) {
		let trimmed = view.front.slice(0, view.frontCount)

		originalList.front = trimmed
		originalList.frontLen = view.frontCount
		view.front = trimmed
	}

	return view
}

// NOTE: The same two runs and the same fixed counts, read WITHOUT writing
// anything back. Trimming as `viewOf` does is right for a walk that is about to
// visit every item anyway, and wrong for everything below that visits none: the
// EDITS, whose whole business is answering with a shorter view of the runs they
// were handed, and `length`, which the stdlib's edits ask before they slice.
// Read through `viewOf`, a chain of shrinking answers trims its parent's Array
// at every step and each O(1) shrink is a whole copy again — draining a
// front-built List one item at a time would stay quadratic, which is the very
// thing the shrink is for. So they fix their counts here and leave the
// receiver's representation exactly as they found it — with the one exception
// `upgradedForSuffix` below is, which MOVES a box's seam rather than trimming a
// run, once, so that the rest of a drain from the front is windows.
export function runsOf<ItemType extends AnyType>(
	originalList: ListType<ItemType>,
): ListView<ItemType> {
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
//
// NOTE: Exported for the walks the Rewriter writes out. A walk that builds its
// List in place owns one Array and pushes onto it, and this is how a whole List
// added by `append(contentsOf:)` reaches that Array. It can not reach for
// `materialise`, which answers the receiver's OWN Array.
export function pushItemsOf<ItemType extends AnyType>(
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

// NOTE: A FRESH Array of a List's logical items, which is what a walk that
// builds its List in place enters with wherever its seed is not a literal: the
// walk owns what it pushes onto, so a List the Program was holding is copied
// rather than grown.
//
// NOTE: A flat box is copied by the same `slice` `append` performed where it
// could not push in place, so entering a walk costs what rebuilding its first
// turn cost before. Pushing the items one at a time instead costs four times as
// much on JavaScriptCore and sixteen on V8, which a short walk over a long seed
// pays in full and nothing else pays back.
//
// NOTE: Only a box carrying a front run has two runs to walk, and it is left
// exactly as it was found: nothing of the receiver is shared with the answer, so
// there is no count to stamp and no representation to trim.
export function ownItemsOf<ItemType extends AnyType>(
	originalList: ListType<ItemType>,
): Array<ItemType> {
	let view = runsOf(originalList)

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

// NOTE: What a native owes the receiver before it hands one of the receiver's
// run Arrays to a second box: both of the receiver's counts written down. A box
// whose count is ABSENT means "the whole Array", so a receiver left that way
// would view whatever the answer later pushes onto the run they now share.
// These are the two lines `prepend` and `append` write inline before they share,
// gathered up for the edits below, which share both runs at once.
function stampClosed<ItemType extends AnyType>(
	originalList: ListType<ItemType>,
	view: ListView<ItemType>,
): void {
	originalList.length = view.backCount

	if (originalList.front !== undefined) {
		originalList.frontLen = view.frontCount
	}
}

// NOTE: THE WHOLE OF WHAT IS SHAREABLE. Shrinking `frontLen` by k drops the
// first k logical items, because the front run is stored reversed; shrinking
// the back view by k drops the last k. So the sub-lists a box can answer with
// while COPYING NOTHING are exactly the windows that still contain the seam
// between the runs — starting at or before it and stopping at or after it — and
// a window lying wholly inside one run has to be copied. A flat box keeps its
// seam at zero, which leaves it the prefixes and nothing else — until it is
// asked for a suffix, when `upgradedForSuffix` below moves its seam to the end.
//
// NOTE: The answer is a STALE box, and that is the point. It holds both of the
// receiver's Arrays and views less of them, so the first read trims it —
// copying exactly the WINDOW's size, never the parent Array's, and releasing the
// parent then. A shared window is a copy deferred to the first read and sized by
// the answer rather than by the receiver, and no copy at all for a value nothing
// ever reads. What it costs in exchange is the only honest debit: an unread
// window keeps its parent's Arrays alive.
function sharedWindowOf<ItemType extends AnyType>(
	originalList: ListType<ItemType>,
	view: ListView<ItemType>,
	start: number,
	end: number,
): ListType<ItemType> {
	stampClosed(originalList, view)

	let frontLen = view.frontCount - start
	let length = end - view.frontCount

	if (frontLen === 0) {
		return { [typeKeySymbol]: "List", value: view.back, length }
	}

	return {
		[typeKeySymbol]: "List",
		value: view.back,
		length,
		front: view.front,
		frontLen,
	}
}

// NOTE: A box whose seam is at zero — flat, or a front run viewed at zero —
// can share no suffix, so a drain from the front of an APPEND-built List copied
// the whole back run at every turn and was quadratic: `removeFirst()` measured
// 121 ms against 20 for the prepend-built drain of 20,000 items, 442 at 40,000
// and 943 at 60,000. Asked for a suffix, such a box UPGRADES ITSELF here: its
// back run becomes a front run stored reversed, its back becomes empty, and
// every later suffix is a shared window of it. One copy pays for the whole
// drain — the same three drains measure 20, 21 and 25 ms after it, and
// `remove(at 0)`'s 193, 713 and 1606 became 19, 22 and 21. The receiver's
// representation changes under it, and that is invisible for the reason
// `materialise`'s demotion is: the same items answer, and nothing can ask
// whether two values are the same value.
//
// NOTE: The callers apply THE HALF RULE — upgrade only when the prefix dropped
// is no longer than the suffix kept — because the upgrade copies the whole run
// where the plain path copies the window. Under the rule the upgrade costs at
// most twice the copy it replaces, and `lastItems(2)` of a flat List a Program
// holds still copies two items rather than the List: 24 ms for two thousand of
// them on 200,000 items, with or without this.
//
// NOTE: The bulk `slice` and in-place `reverse` are what makes the one copy
// cheap; a walk pushing the items one at a time is what `ownItemsOf` measured
// four to sixteen times slower. The empty back is a FRESH Array rather than
// `noItems`, since the receiver may later be appended to in place, and pushing
// onto the shared empty run is what `noItems` must never see.
function upgradedForSuffix<ItemType extends AnyType>(
	originalList: ListType<ItemType>,
	view: ListView<ItemType>,
): ListView<ItemType> {
	let front = view.back.slice(0, view.backCount).reverse()
	let back: Array<ItemType> = []

	originalList.value = back
	originalList.length = 0
	originalList.front = front
	originalList.frontLen = view.backCount

	return {
		front,
		frontCount: view.backCount,
		back,
		backCount: 0,
		total: view.backCount,
	}
}

// NOTE: The answer of an edit that rebuilt ONE of the receiver's two runs — the
// fresh run stands where the old one stood, and the untouched one rides along by
// reference under the count the receiver viewed of it. The receiver is stamped
// closed first, for the reason every sharing answer stamps: the two boxes hold
// that run's Array between them from here on.
//
// NOTE: Exported, and the only two things `NonEmptyList::replace` has to answer
// such an edit with. Every branded List literal in the runtime is written in
// THIS file, and deliberately: what a box owes the receiver whose run it is
// about to share — both counts written down, before the two of them hold that
// Array between them — is an invariant of this file, and a second module writing
// the literal where it stands would be a second place for that debt to be
// forgotten. Nothing is traded for the indirection: inlining both of them into
// `replace` measures no slower than the calls, on either branch.
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
	}
}

export function listRebuildingBack<ItemType extends AnyType>(
	back: Array<ItemType>,
	originalList: ListType<ItemType>,
	view: ListView<ItemType>,
): ListType<ItemType> {
	// NOTE: A receiver with no front run has nothing to share, so the fresh back
	// run IS the whole answer and the receiver is left exactly as it was.
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

// NOTE: Counting is not reading — `runsOf`, for the reason stated there. The
// stdlib writes `removeFirst()` as `@::slice(from 1, to @::length())`, so a
// drain from the front asks each shrinking answer for its length before slicing
// it again, and a `length` that trimmed would copy the whole front run at every
// turn and hand back exactly the shrink `slice` had just bought.
// `removeFirst(count)` and `removeLast(count)` are the same composition.
export function length(originalList: ListType<AnyType>): IntegerType {
	return createInteger(runsOf(originalList).total)
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

export function map<ItemType extends AnyType, Other extends AnyType>(
	originalList: ListType<ItemType>,
	transform: (item: ItemType) => Other,
): ListType<Other> {
	let view = viewOf(originalList)
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
	Answer extends AnyType,
>(
	originalList: ListType<ItemType>,
	startingValue: Answer,
	combine: (accumulator: Answer, item: ItemType) => StepType<Answer, Answer>,
): Answer {
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

// NOTE: The running fold — `reduce` keeping every value it built instead of the
// last one. The starting value is pushed before any item is seen, which is what
// makes the answer one longer than the receiver and never empty, and is the
// promise `NonEmptyList<Answer>` records. An Essence body could only be a
// `reduce` carrying the List it builds, whose answer is a plain `List`.
export function accumulate<ItemType extends AnyType, Answer extends AnyType>(
	originalList: ListType<ItemType>,
	startingValue: Answer,
	combine: (accumulator: Answer, item: ItemType) => Answer,
): ListType<Answer> {
	let view = viewOf(originalList)
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

// NOTE: The filter and its complement in ONE walk, so the check is offered each
// item once. The Essence body this replaces was `everyItem(where:)` beside
// `removeEvery(where:)`, two native walks offering every item to the check
// twice; the one-`reduce` body that fixes that in Essence carries a Record of
// the two halves and pays a Record spread and an `append` box per item, which
// measured 202 ms against the two filters' 68 for two hundred partitions of
// 20,000 items on `isEven`, best of three with the subprocess startup inside.
// This walk measured 49 ms on the same run, and 361 ms against 655 with a
// check costing a hundred loop turns — where the fold's 566 was already ahead.
export function partition__overload$1<ItemType extends AnyType>(
	originalList: ListType<ItemType>,
	check: (item: ItemType) => BooleanType,
): RecordType & { accepted: ListType<ItemType>; refused: ListType<ItemType> } {
	let view = viewOf(originalList)
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

// NOTE: A negative position counts back from the end — -1 is the last item, and
// -length the first. The arithmetic is a double's, which is exact for every
// position a List can have and for every index a caller can pass: an out-of-
// range answer stays out of range at any size, since a double does not wrap the
// way a 32-bit narrowing used to.
export function positionFromEnd(
	index: number | bigint,
	length: number,
): number {
	// NOTE: A bigint index is outside safe range by the canonical invariant, so
	// it is past either end of any Array JavaScript can hold — which is all a
	// caller needs of it. Answering with the nearest position that is out of
	// range says exactly that, and says it without building a bigint length to
	// compare against.
	if (typeof index !== "number") {
		return index < 0n ? -1 : length
	}

	return index < 0 ? index + length : index
}

// NOTE: Reading a position does NOT combine the runs — an upgraded List has to
// stay O(1) to index — so the view decides which run holds the item and the
// item is read straight out of it.
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

// NOTE: `firstItem(where:)` is no longer here — it is written in Essence now, on
// `reduce`'s early-stopping entry, which `#Done`s at the first accepted item.
// The eager `everyItem` beside `reduce` is what it used to be compared against;
// the `Step` Choice is what let the short-circuiting version leave the native.

// NOTE: `firstIndex` is no longer here — both of its entries are written in
// Essence, on `reduce`'s early-stopping entry, which `#Done`s at the first
// match; the item `is` arrives as the bound's hidden conformance Argument.

// NOTE: The one backwards walk. `reduce` runs forwards and nothing in Essence
// walks a List the other way without copying it, so `lastIndex(where:)` is
// native and `lastIndex(of:)` and `lastItem(where:)` are written on it. The
// back run is walked from its end and then the front run from its START, since
// the front is stored reversed and its logical head is its last element — so
// the walk stops at the last accepted item having visited nothing after it.
// The body this replaces reversed the whole List first: two thousand calls on
// 20,000 items with the last item accepted measured 57 ms that way and 19 ms
// here, best of three with the subprocess startup inside both.
export function lastIndex__overload$3<ItemType extends AnyType>(
	originalList: ListType<ItemType>,
	check: (item: ItemType) => BooleanType,
): OptionalType<IntegerType> {
	let view = viewOf(originalList)

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
	// NOTE: Half-open [from, to). A negative end counts back from the List's
	// end — `slice(from 0, to -1)` drops the last item — and only THEN is each
	// end clamped, so a position that reaches back past the start settles on
	// zero rather than wrapping a second time.
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

	// NOTE: The window the receiver can answer with by sharing both runs. It is
	// what makes `removeLast()` and `removeFirst()` — the stdlib's two slices at
	// the ends — cost nothing but a box, and a middle window of an upgraded List
	// with it.
	if (first <= view.frontCount && last >= view.frontCount) {
		return sharedWindowOf(originalList, view, first, last)
	}

	// NOTE: A suffix of a box whose seam is at zero, under the half rule —
	// `removeFirst()` and `removeFirst(count)` are this window, and after the
	// upgrade the whole drain is windows.
	if (view.frontCount === 0 && last === length && first <= length - first) {
		return sharedWindowOf(
			originalList,
			upgradedForSuffix(originalList, view),
			first,
			last,
		)
	}

	// NOTE: Every other window lies wholly inside ONE run, since containing the
	// seam and being moved onto it are the only ways not to, so what is left is
	// a copy out of that run — a bulk one for the back, and a reversed walk for
	// the front, whose head is stored last.
	if (last < view.frontCount) {
		let count = last - first
		// NOTE: The argument is the answer's LENGTH. The rule below suggests
		// `Array.from({ length })` instead, which fills through an iterator —
		// the very turn-by-turn work these three fills exist to avoid.
		// oxlint-disable-next-line unicorn/no-new-array -- the answer's length
		let items: Array<ItemType> = new Array(count)
		let front = view.front
		let highest = view.frontCount - 1 - first

		for (let index = 0; index < count; index++) {
			items[index] = front[highest - index]
		}

		return createList(items)
	}

	return createList(
		view.back.slice(first - view.frontCount, last - view.frontCount),
	)
}

// NOTE: The item at a position is ABSENT from the answer, and every position
// naming no item leaves the List alone: one reaching back past the first item,
// and one standing at or past the end. That is the four-branch Essence body this
// replaces, said once — the position is resolved from the end BEFORE either
// decision, because `-1` is the last item and the branch that drops it has to
// know which item that is.
//
// NOTE: Native because no Essence composition can avoid the intermediates. The
// body was two `slice`s and an `append(contentsOf:)`, which builds the whole
// answer twice over and reads the receiver twice; here it is one Array of the
// answer's own size, filled once — the same reason `split` and `of` stayed
// native.
//
// NOTE: Dropping the FIRST item of a box with a front run, or the LAST of one
// with a back run, is a window rather than a fill: it shrinks the run it touches
// and shares both. Dropping the first item of a box whose seam is at zero
// upgrades it first, as `slice` does for the same window, so `remove(at 0)`
// drains an append-built List in the time `removeFirst()` does. The last item
// of a box whose back is empty lives at the bottom of the front run, where no
// view can reach it, so that one goes the general way rather than growing
// front-tail surgery for it.
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

	// NOTE: Everything before the position and everything after it, with each run
	// walked in two halves split there. The position falls in ONE of the runs, so
	// the pair of loops on the other side runs the whole of it and the split
	// leaves nothing out: no turn asks whether this is the item being dropped.
	//
	// oxlint-disable-next-line unicorn/no-new-array -- the length, as above
	let items: Array<ItemType> = new Array(view.total - 1)
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

// NOTE: Everything before the position, the item, then everything from the
// position on — what the Essence body built with `slice`, `append` and
// `append(contentsOf:)`, kept exactly. The position is resolved from the end
// and CLAMPED, so one before the start settles on zero and one past the end on
// the length: there is no position that drops the item, which is what lets the
// Declaration promise a `NonEmptyList` and is why the body could not stay in
// Essence — every step of it answered a plain `List`.
//
// NOTE: Clamped exactly as `slice` clamps — a position outside the List settles
// on the nearest end rather than wrapping to the far one.
//
// NOTE: Both ENDS are what the two growers already do, so both are handed
// straight to them and inherit their upgrade-or-push. There is no fast path at
// the seam and there can not be one: an item pushed onto the front run lands at
// the logical HEAD, not between the runs, so neither push can say what a seam
// insertion means. Everything between the ends is one Array of the answer's own
// size, filled once from the two runs.
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

	// NOTE: Everything before the position, the item, everything from it on —
	// the three parts, with each run walked in two halves split at the position.
	// The position falls in ONE of the runs, so one of the two splits sits at an
	// end of its run and the pair of loops on that side runs the whole of it and
	// nothing of the other: no turn asks where the item goes.
	//
	// oxlint-disable-next-line unicorn/no-new-array -- the length, as above
	let items: Array<ItemType> = new Array(view.total + 1)
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

// NOTE: The ordering asked rather than imposed, and native because every
// Essence body for it builds something. The adjacent pairs
// `@::pair(with @::removeFirst())` makes allocate a Record per item, and a fold
// carrying the item before pays a Record spread per item; two thousand checks of
// a two thousand item sorted List measured 64 ms and 127 ms against 21 ms here.
// This walk holds the item before in a local and leaves at the first pair out of
// order, where the pairs build their whole List anyway and measured 57 ms.
//
// NOTE: A descending check turns the comparison around rather than negating the
// answer, exactly as `sort` does, so items the order calls `#Equal` are in
// order in either direction.
export function isSorted<ItemType extends AnyType>(
	originalList: ListType<ItemType>,
	order: SortOrderType,
	conformance: {
		compare: (self: ItemType, other: ItemType) => OrderingType
	},
): BooleanType {
	let view = viewOf(originalList)
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

// NOTE: `sort` is one Method with three Overloads, all native, binding by
// position. `$1` reads the direction and orders by the items' own `compare`,
// whose conformance its `Comparable` bound hands in as the trailing Argument;
// `$2` takes the comparison outright and needs no direction, since a comparison
// says which way it runs; `$3` below orders by a key read off each item. The
// first two land on the same walk.
//
// NOTE: A descending sort hands the SAME comparison the pair the other way
// round rather than reversing the answer. `Array.sort` is stable, and two items
// the comparison calls `#Equal` still call each other `#Equal` swapped — so a
// tie keeps the order it had in either direction, which reversing the answer
// would break.
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
	// NOTE: A copy is sorted, since every List operation returns a new value.
	// `Array.sort` is stable, so items the comparison calls equal keep their
	// original order. The Ordering Case is read by tag, mapped to the sign
	// `sort` expects.
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

// NOTE: `$3` orders by a KEY read off each item, and the key is read ONCE per
// item rather than twice per comparison: every key is read into an Array, the
// POSITIONS are sorted on those keys through the key Type's `compare` — the
// hidden conformance Argument, as `$1`'s is — and the items are read back out
// in the order the positions ended in. The Essence body this replaces handed
// `$2` a comparison calling the key on both sides, which is 2·n·log₂n key reads
// against n: with a key costing four hundred loop turns, 20,000 rows in
// scrambled order measured 178 ms that way against 28 ms here, best of three
// with the subprocess startup inside both, and the hand-written
// decorate-sort-undecorate through `map` measured 29.
//
// NOTE: SORTING POSITIONS rather than an Array of `{ key, item }` Records, and
// that is what makes a CHEAP key cost nothing: three sorts of 200,000 rows on a
// member path measured 103 ms through the comparison, 100 ms here, and 131 ms
// with the Records — one object per item is a heavier debit than the key reads
// this is here to save. The receiver is read through `materialise` for the same
// reason `$1` and `$2` read it that way: a flat box hands over the Array it
// already holds, and a two-run box is combined and demoted once.
//
// NOTE: Rows in a strictly descending order are ONE run to `Array.sort`, which
// finishes them in n comparisons and hides the key's cost entirely — a probe
// has to scramble its keys, or it measures nothing.
//
// NOTE: Stable, as the two beside it are, and for the same reason: a
// descending sort hands the pairs of keys the other way round rather than
// reversing the answer. Two items whose keys compare `#Equal` keep the order
// they had in either direction, because `Array.sort` is stable and the
// positions it is sorting start out in the receiver's order.
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

// NOTE: What a READER sees, which is the form a Program writes the List down
// in: `[1, 2, 3]`, and `[]` for the empty one. Here rather than in Essence
// because the brackets are String concatenation: written there it would call
// `String::append`, the only edge this Namespace drew into a Namespace that is
// written on THIS one.
//
// NOTE: Not `join` with brackets around it any more, and the difference is the
// one rule `itemText` holds: a String item is QUOTED here where `join` leaves
// it bare. Joining answers the raw text — `["a", "b"]::join(with ", ")` is
// `a, b` — and printing answers what was written down, so `["a", "", "b"]`
// reads as three items rather than as `[a, , b]`.
export function toString<ItemType extends AnyType>(
	originalList: ListType<ItemType>,
	conformance: {
		toString: (value: ItemType) => StringType
	},
): StringType {
	let view = viewOf(originalList)
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

// NOTE: One walk up, and one Function under both Namespaces' names: there is a
// position for every item, so a receiver with something in it answers with
// something in it and `NonEmptyList` re-exports this rather than counting a
// second time. Written here because the proven entry could not be written in
// Essence without borrowing a promise from somewhere: its body counted DOWN
// through `List.of(integersFrom:downTo:)`, which promises a non-empty answer,
// and turned the count round — a second walk over an Array of Integers already
// built, which measured 0.90 ms per 100,000 positions against 0.55 ms for the
// single walk. A calling Program is 2,097 bytes smaller for it.
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

// NOTE: One walk and one Record per item — the position beside the item it
// stands at, so a fold that needs both does not have to carry a counter of its
// own. Written here rather than in Essence because the Essence body would be
// `@::indices()::map(…)`, and reading each item back by position builds an
// Optional per item to take apart again.
//
// NOTE: `materialise` rather than a view, for the reason `pair` uses one: the
// answer is a fresh Array of the receiver's whole length either way, so there
// is nothing to gain by walking the two runs apart.
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

// NOTE: A group size below one names no grouping, and the answer is the whole
// List in ONE group — nothing is dropped and nothing is refused. `1` rather
// than `1n`: an ordering comparison reads both representations, so one spelling
// asks the question of either. That clamp is what makes the loop below safe to
// read as it is: the size is never below one, and a group is opened only while
// an item remains to put in it, so every group comes back with at least one
// item. The declared item Type `NonEmptyList<ItemType>` rests on exactly that.
//
// NOTE: The empty List answers with no groups at all, for every size, because
// there is no item to put in one. That is the same answer a valid size gives
// it, so the size below one changes nothing there either.
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

// NOTE: One walk behind all four range natives. The step is signed and never
// zero, so the values run from the first and stop where a step passes the last,
// whichever side of it the step approaches from. `atLeastOne` is the promise the
// `downTo:` entries carry into their Type: where the first value is already past
// the end, the walk answers that value rather than nothing.
//
// NOTE: Counted in numbers where every bound is held as one, which is every
// range a List can actually hold — a range needing bigint ends spans more items
// than there is memory for, and is only ever reached to be refused by whatever
// runs out first.
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

// NOTE: The four range natives, each a step and a promise handed to one walk.
// The step is passed as the value it holds rather than as an Integer, because
// `Integer.ts` and this file import each other and a module level
// `createInteger(1)` here would run before the safe bound it reads is bound.
// `$1` counts up through its end and `$3` counts down through its own, which is
// what puts the direction in the label rather than in the pair of bounds. The
// `upTo:` entries beside them are written in Essence, over an end one step
// nearer, because what they add is an adjustment rather than a walk.
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

// NOTE: The count of this entry is a `PositiveInteger` in the source — proven
// while compiling, erased to an Integer here — so the answer certainly holds
// something and the Namespace may say so. The Essence entry beside it can not:
// its body is a `map` over `of`, and what that answers is a `List`.
//
// NOTE: The count is a JavaScript number, for the reason `of` counts in one. A
// count needing a bigint asks for more items than there is memory for, and is
// only ever reached to be refused by whatever runs out first.
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

// NOTE: THE SET-SHAPED NATIVES, and the one structure all five rest on: a
// `KeySet` (`keyEncoding.ts`) holding what the walk has met, keyed by the
// canonical encoding a Dictionary finds a slot by. What a fold on `contains`
// costs is a scan of everything kept so far per item, which is quadratic; each
// of these is one walk and one lookup per item. One `removeDuplicates` over
// 20,000 items with 2,000 distinct measured 106 ms as such a fold, 23 ms
// through the `tally()::keys()` this replaced, and 22 ms here; with all 20,000
// distinct the fold measured 650 ms and this walk 22 ms. Best of three, with
// the 21 ms of subprocess startup inside every figure.
//
// NOTE: The encoding lives in a module of its own so that this can reach it
// without the store, the version stamps, the kind registry and the written
// form arriving behind it — which is what `@::tally()::keys()` in `Dictionary.es`
// used to drag into any Program that asked a List for its distinct items.
// `bundleSize.spec.ts` holds the figure that trade is worth.
//
// NOTE: The witness decides, not the encoding. `encodeKey` answers `null` for a
// witness the Compiler has not branded structural, and every lookup then walks
// the keys and asks that witness — the same scan path a Dictionary takes for the
// same reason, and invisible from Essence apart from the time it costs.

// NOTE: The whole item standing as its own key, so that the `on:` entries and
// the bare ones are one walk each rather than two written twice. A monomorphic
// identity call per item is inside the noise of the `encodeKey` beside it.
function itself<ItemType extends AnyType>(item: ItemType): ItemType {
	return item
}

// NOTE: Every key of a List, in one set. `runsOf` rather than `viewOf`, for the
// reason `GroupedList` gives: this walk visits each item once and has no reason
// to trim the caller's List for it.
function keySetOver<ItemType extends AnyType, Key extends AnyType>(
	originalList: ListType<ItemType>,
	keyOf: (item: ItemType) => Key,
	conformance: EquatableWitness<Key>,
): KeySet<Key> {
	let view = runsOf(originalList)
	let set = freshKeySet(conformance)

	for (let index = view.frontCount - 1; index >= 0; index--) {
		addKey(set, keyOf(view.front[index]))
	}

	for (let index = 0; index < view.backCount; index++) {
		addKey(set, keyOf(view.back[index]))
	}

	return set
}

// NOTE: The intersection and the difference in one walk, told apart by which
// answer of the membership test keeps an item. Both are filters over the
// receiver rather than set operations over it: an item is kept every time it
// occurs, which is what `everyItem(where:)` beside them does with a check.
function keptByMembership<ItemType extends AnyType>(
	originalList: ListType<ItemType>,
	otherList: ListType<ItemType>,
	conformance: EquatableWitness<ItemType>,
	keeping: boolean,
): ListType<ItemType> {
	let other = keySetOver(otherList, itself, conformance)
	let view = viewOf(originalList)
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

// NOTE: The first item met at each key, which is what both `removeDuplicates`
// entries answer. `addKey` says whether the key was new, so the membership test
// and the insertion are one lookup rather than two.
function firstAtEachKey<ItemType extends AnyType, Key extends AnyType>(
	originalList: ListType<ItemType>,
	keyOf: (item: ItemType) => Key,
	conformance: EquatableWitness<Key>,
): ListType<ItemType> {
	let view = viewOf(originalList)
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

// NOTE: The same walk, stopped at the first key it has already met — which is
// the whole of what `hasDuplicates` asks, and the reason it is not
// `removeDuplicates()::length()` compared against the receiver's.
function meetsAKeyTwice<ItemType extends AnyType, Key extends AnyType>(
	originalList: ListType<ItemType>,
	keyOf: (item: ItemType) => Key,
	conformance: EquatableWitness<Key>,
): BooleanType {
	let view = runsOf(originalList)
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

// NOTE: The subset question. The receiver is indexed and the ARGUMENT is
// walked, so the answer is settled at the first item that is not there. The
// empty List asks nothing of the receiver, which is what makes the answer
// `true` before either List is read.
export function contains__overload$2<ItemType extends AnyType>(
	originalList: ListType<ItemType>,
	otherList: ListType<ItemType>,
	conformance: EquatableWitness<ItemType>,
): BooleanType {
	let others = runsOf(otherList)

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

// NOTE: The pieces a separator leaves, which is `String::split(on:)`'s shape
// over items. A piece is opened before the first item and closed by every
// accepted one, so a List holding n accepted items answers n+1 pieces and a
// List holding none answers one — including the empty List, whose one piece is
// empty. That is what the declared `NonEmptyList<List<ItemType>>` rests on.
export function split__overload$3<ItemType extends AnyType>(
	originalList: ListType<ItemType>,
	check: (item: ItemType) => BooleanType,
): ListType<ListType<ItemType>> {
	let view = viewOf(originalList)
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

// NOTE: Every stretch of one size, one position apart. The loop condition is
// what makes a size above the length answer nothing: the first window would
// have to reach past the last item. The size is a `PositiveInteger` in the
// source — proven while compiling, erased to an Integer here — so a stretch
// always holds something and the Namespace may say so.
//
// NOTE: `Number` on the size for the reason `repeat` counts in one: a window
// needing a bigint size spans more items than there is memory for, and reaches
// the comparison below only to fail it.
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

// NOTE: The maximal stretches of neighbours the check accepts. A stretch is
// opened by the first item accepted after a refusal and closed by the next
// refusal, so every one that reaches the answer holds an item — which is what
// the declared `NonEmptyList<ItemType>` item Type rests on, and what no Essence
// fold over the accepted items could say.
export function runs<ItemType extends AnyType>(
	originalList: ListType<ItemType>,
	check: (item: ItemType) => BooleanType,
): ListType<ListType<ItemType>> {
	let view = viewOf(originalList)
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

// NOTE: The inner Lists read as columns. The shortest one decides how many
// there are, which is `pair(with:)`'s rule one dimension along, and it is found
// in the same walk that materialises the rows — so each inner List is combined
// at most once however many columns are read out of it.
//
// NOTE: `NestedList` re-exports this, as it re-exports `flatten`: the operation
// is written here beside the List internals it reads, and the Namespace is a
// name for the receivers that can answer it.
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
