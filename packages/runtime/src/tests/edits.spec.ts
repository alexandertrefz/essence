import { describe, expect, test } from "bun:test"

import { createBoolean } from "../Boolean"
import type { IntegerType } from "../Integer"
import { createInteger } from "../Integer"
import {
	append__overload$1 as append,
	createList,
	insert,
	is,
	item__overload$1 as item,
	length,
	type ListType,
	materialise,
	prepend__overload$1 as prepend,
	remove,
	runsOf,
	slice,
	toString as listToString,
} from "../List"
import {
	firstItem,
	lastItem,
	replace__overload$1 as replace,
} from "../NonEmptyList"
import { createString } from "../String"
import { getStringRepresentation } from "../Terminal"
import { typeKeySymbol } from "../type"

// `slice`, `remove(at:)`, `insert(_:at:)` and `NonEmptyList::replace(_:at:)`
// may answer by sharing the receiver's runs under a view of their own. Nothing
// in the language can ask about that, so tests that look at the box say so.
const integer = (value: number) => createInteger(BigInt(value))

const integerEquality = {
	is: (first: IntegerType, second: IntegerType) =>
		createBoolean(first.value === second.value),
}

const integerPrinting = {
	toString: (value: IntegerType) => createString(String(value.value)),
}

// Reads a List's items without the trimming `viewOf` does, since these tests
// watch what a box still holds after others read or grow it.
const itemsOf = (originalList: ListType<IntegerType>): Array<number> => {
	let view = runsOf(originalList)
	let items: Array<number> = []

	for (let index = view.frontCount - 1; index >= 0; index--) {
		items.push(Number(view.front[index].value))
	}

	for (let index = 0; index < view.backCount; index++) {
		items.push(Number(view.back[index].value))
	}

	return items
}

// The item a position names, unwrapped from its Optional.
const itemAt = (
	originalList: ListType<IntegerType>,
	position: number,
): number | null => {
	let answer = item(originalList, integer(position))

	return answer[typeKeySymbol] === "Optional#Empty"
		? null
		: Number(answer.item.value)
}

// What each edit means on a plain Array, as the Method's documentation
// describes it. Nothing here knows about runs, so a disagreement is the native's.
const referenceRemove = (
	items: Array<number>,
	position: number,
): Array<number> => {
	let resolved = position < 0 ? position + items.length : position

	if (resolved < 0 || resolved >= items.length) {
		return items
	}

	let answer = items.slice()

	answer.splice(resolved, 1)

	return answer
}

const referenceInsert = (
	items: Array<number>,
	value: number,
	position: number,
): Array<number> => {
	let resolved = position < 0 ? position + items.length : position
	let clamped =
		resolved < 0 ? 0 : resolved > items.length ? items.length : resolved
	let answer = items.slice()

	answer.splice(clamped, 0, value)

	return answer
}

const referenceReplace = (
	items: Array<number>,
	value: number,
	position: number,
): Array<number> => {
	let resolved = position < 0 ? position + items.length : position

	if (resolved < 0 || resolved >= items.length) {
		return items
	}

	let answer = items.slice()

	answer[resolved] = value

	return answer
}

const referenceSlice = (
	items: Array<number>,
	from: number,
	to: number,
): Array<number> => {
	let length = items.length
	let resolvedFrom = from < 0 ? from + length : from
	let resolvedTo = to < 0 ? to + length : to
	let start =
		resolvedFrom < 0 ? 0 : resolvedFrom > length ? length : resolvedFrom
	let end = resolvedTo < 0 ? 0 : resolvedTo > length ? length : resolvedTo

	return end <= start ? [] : items.slice(start, end)
}

// A box for each way a List may hold its items when an edit reaches it. `seam`
// is where its front run ends, and `build` answers a fresh box, since reading
// may change it.
type Shape = {
	name: string
	seam: number
	build: () => ListType<IntegerType>
}

const flatSix = () => createList([11, 22, 33, 44, 55, 66].map(integer))

const upgradedSix = () =>
	prepend(
		prepend(
			prepend(createList([44, 55, 66].map(integer)), integer(33)),
			integer(22),
		),
		integer(11),
	)

const prependedOnly = (values: Array<number>): ListType<IntegerType> => {
	let built = createList<IntegerType>([])

	for (let index = values.length - 1; index >= 0; index--) {
		built = prepend(built, integer(values[index]!))
	}

	return built
}

const shapes: Array<Shape> = [
	{ name: "a flat box", seam: 0, build: flatSix },
	{ name: "an upgraded box", seam: 3, build: upgradedSix },
	{
		name: "a front-heavy box",
		seam: 5,
		build: () =>
			prepend(
				prepend(
					prepend(
						prepend(
							prepend(createList([66].map(integer)), integer(55)),
							integer(44),
						),
						integer(33),
					),
					integer(22),
				),
				integer(11),
			),
	},
	{
		name: "a box with an empty back",
		seam: 6,
		build: () => prependedOnly([11, 22, 33, 44, 55, 66]),
	},
	{
		// Another box appended to this one's Array, so the back view is shorter
		// than the Array. The edits must answer for the view.
		name: "a stale-back box",
		seam: 0,
		build: () => {
			let base = flatSix()

			append(base, integer(99))

			return base
		},
	},
	{
		// Another box prepended, so the front Array holds an item this box never
		// saw.
		name: "a stale-front box",
		seam: 3,
		build: () => {
			let base = upgradedSix()

			prepend(base, integer(99))

			return base
		},
	},
	{
		// A sharing `slice`'s answer: a box viewing part of two Arrays it owns
		// neither of.
		name: "a freshly shared window",
		seam: 3,
		build: () =>
			slice(
				prepend(
					prepend(
						prepend(
							prepend(
								createList([44, 55, 66, 77].map(integer)),
								integer(33),
							),
							integer(22),
						),
						integer(11),
					),
					integer(0),
				),
				integer(1),
				integer(7),
			),
	},
	{
		// A prefix of a flat box, the only shared window with no front run.
		name: "a shared prefix of a flat box",
		seam: 0,
		build: () =>
			slice(
				createList([11, 22, 33, 44, 55, 66, 77].map(integer)),
				integer(0),
				integer(6),
			),
	},
	{
		name: "a one-item flat box",
		seam: 0,
		build: () => createList([11].map(integer)),
	},
	{ name: "a one-item front box", seam: 1, build: () => prependedOnly([11]) },
	{
		name: "the empty box",
		seam: 0,
		build: () => createList<IntegerType>([]),
	},
]

// Positions placed against the box's seam. Both ends, both sides of the seam
// and of the last item, and past the end, each also as a negative position.
// The far ones would wrap in 32-bit arithmetic.
const positionsFor = (total: number, seam: number): Array<number> => {
	let positions = new Set<number>()

	for (let position of [
		0,
		1,
		seam - 1,
		seam,
		seam + 1,
		total - 2,
		total - 1,
		total,
		total + 3,
	]) {
		positions.add(position)
		positions.add(position - total)
	}

	positions.add(-total - 1)
	positions.add(2 ** 40)
	positions.add(-(2 ** 40))

	return [...positions]
}

describe("edits against every representation", () => {
	for (let shape of shapes) {
		describe(shape.name, () => {
			// `materialise` on a fresh box answers a plain Array of its items, so
			// the reference is built from those alone.
			let items = materialise(shape.build()).map((item) =>
				Number(item.value),
			)
			let positions = positionsFor(items.length, shape.seam)

			test("is the box these positions were placed against", () => {
				let view = runsOf(shape.build())

				expect(view.frontCount).toBe(shape.seam)
				expect(view.total).toBe(items.length)
				expect(itemsOf(shape.build())).toEqual(items)
			})

			test("remove(at:) drops exactly the item the position names", () => {
				for (let position of positions) {
					expect([
						position,
						itemsOf(remove(shape.build(), integer(position))),
					]).toEqual([position, referenceRemove(items, position)])
				}
			})

			test("insert(_:at:) puts the item where the position clamps to", () => {
				for (let position of positions) {
					expect([
						position,
						itemsOf(
							insert(
								shape.build(),
								integer(99),
								integer(position),
							),
						),
					]).toEqual([position, referenceInsert(items, 99, position)])
				}
			})

			test("replace(_:at:) changes one item and keeps the length", () => {
				for (let position of positions) {
					expect([
						position,
						itemsOf(
							replace(
								shape.build(),
								integer(99),
								integer(position),
							),
						),
					]).toEqual([
						position,
						referenceReplace(items, 99, position),
					])
				}
			})

			test("slice(from:to:) answers the window between two positions", () => {
				for (let from of positions) {
					for (let to of positions) {
						expect([
							from,
							to,
							itemsOf(
								slice(
									shape.build(),
									integer(from),
									integer(to),
								),
							),
						]).toEqual([from, to, referenceSlice(items, from, to)])
					}
				}
			})
		})
	}
})

// These tests look at the box, since a List can not be asked whether it is
// shared. The answer tests would still pass if an edit started copying.
describe("what an edit shares", () => {
	test("a window containing the seam shares both runs", () => {
		let receiver = upgradedSix()
		let answer = slice(receiver, integer(1), integer(5))

		expect(answer.front).toBe(receiver.front)
		expect(answer.value).toBe(receiver.value)
		expect(answer.frontLen).toBe(2)
		expect(answer.length).toBe(2)
	})

	test("a prefix of a flat box shares its Array", () => {
		let receiver = flatSix()
		let answer = slice(receiver, integer(0), integer(4))

		expect(answer.value).toBe(receiver.value)
		expect(answer.front).toBeUndefined()
		expect(answer.length).toBe(4)
	})

	test("dropping the first item shrinks the front run", () => {
		let receiver = upgradedSix()
		let answer = remove(receiver, integer(0))

		expect(answer.front).toBe(receiver.front)
		expect(answer.value).toBe(receiver.value)
		expect(answer.frontLen).toBe(2)
	})

	test("dropping the last item shrinks the back view", () => {
		let receiver = upgradedSix()
		let answer = remove(receiver, integer(-1))

		expect(answer.front).toBe(receiver.front)
		expect(answer.value).toBe(receiver.value)
		expect(answer.length).toBe(2)
	})

	// A box with its seam at zero first moves the seam to the end. Its back run
	// becomes a front run the answer can share. The receiver's fresh back is its
	// own, so a later append pushes onto it in place.
	test("dropping the first item of a box with no front upgrades it and shares", () => {
		let receiver = flatSix()
		let original = receiver.value
		let answer = remove(receiver, integer(0))

		expect(receiver.front).toBeDefined()
		expect(receiver.frontLen).toBe(6)
		expect(receiver.length).toBe(0)
		expect(receiver.value).not.toBe(original)
		expect(answer.front).toBe(receiver.front)
		expect(answer.value).toBe(receiver.value)
		expect(answer.frontLen).toBe(5)
		expect(answer.length).toBe(0)
		expect(itemsOf(receiver)).toEqual([11, 22, 33, 44, 55, 66])
		expect(itemsOf(answer)).toEqual([22, 33, 44, 55, 66])

		let grown = append(receiver, integer(77))

		expect(grown.value).toBe(receiver.value)
		expect(itemsOf(grown)).toEqual([11, 22, 33, 44, 55, 66, 77])
		expect(itemsOf(answer)).toEqual([22, 33, 44, 55, 66])
	})

	test("a suffix of a flat box upgrades it and shares", () => {
		let receiver = flatSix()
		let answer = slice(receiver, integer(2), integer(6))

		expect(receiver.frontLen).toBe(6)
		expect(answer.front).toBe(receiver.front)
		expect(answer.frontLen).toBe(4)
		expect(answer.length).toBe(0)
		expect(itemsOf(answer)).toEqual([33, 44, 55, 66])
		expect(itemsOf(receiver)).toEqual([11, 22, 33, 44, 55, 66])
	})

	// The half rule: an upgrade copies the whole run. So a suffix shorter than
	// the prefix it drops is copied out instead, and the receiver stays flat.
	test("a short suffix of a flat box copies rather than upgrading", () => {
		let receiver = flatSix()
		let answer = slice(receiver, integer(4), integer(6))

		expect(receiver.front).toBeUndefined()
		expect(answer.front).toBeUndefined()
		expect(answer.value).not.toBe(receiver.value)
		expect(itemsOf(answer)).toEqual([55, 66])
	})

	test("a front run viewed at zero upgrades like a flat box", () => {
		let receiver = remove(prependedOnly([11, 22]), integer(0))
		let widened = append(remove(receiver, integer(0)), integer(33))
		let grown = append(widened, integer(44))
		let seamAtZero = runsOf(grown)

		expect(seamAtZero.frontCount).toBe(0)
		expect(seamAtZero.backCount).toBe(2)

		let answer = slice(grown, integer(1), integer(2))

		expect(grown.frontLen).toBe(2)
		expect(answer.front).toBe(grown.front)
		expect(itemsOf(answer)).toEqual([44])
		expect(itemsOf(grown)).toEqual([33, 44])
	})

	test("replace copies only the run the position falls in", () => {
		let backEdit = upgradedSix()
		let backAnswer = replace(backEdit, integer(99), integer(4))

		expect(backAnswer.front).toBe(backEdit.front)
		expect(backAnswer.value).not.toBe(backEdit.value)

		let frontEdit = upgradedSix()
		let frontAnswer = replace(frontEdit, integer(99), integer(1))

		expect(frontAnswer.value).toBe(frontEdit.value)
		expect(frontAnswer.front).not.toBe(frontEdit.front)
	})

	test("inserting at either end is the grower that end already had", () => {
		let head = upgradedSix()
		let atHead = insert(head, integer(99), integer(0))

		expect(atHead.value).toBe(head.value)
		expect(itemsOf(atHead)).toEqual([99, 11, 22, 33, 44, 55, 66])

		let tail = upgradedSix()
		let atTail = insert(tail, integer(99), integer(6))

		expect(atTail.front).toBe(tail.front)
		expect(itemsOf(atTail)).toEqual([11, 22, 33, 44, 55, 66, 99])
	})

	// Reading a shared window trims it to the answer's size, not the parent's.
	test("reading a shared window trims it to its own size", () => {
		let receiver = createList(
			Array.from({ length: 100 }, (_, index) => integer(index)),
		)
		let answer = slice(receiver, integer(0), integer(2))

		expect(answer.value).toBe(receiver.value)
		expect(materialise(answer).length).toBe(2)
		expect(answer.value).not.toBe(receiver.value)
		expect(answer.value.length).toBe(2)
	})

	// `removeFirst()` slices to the length by default, so a drain asks a
	// shrinking window for its length every turn. A `length` that trimmed would
	// copy the whole front run there.
	test("asking a shared window for its length leaves it shared", () => {
		let receiver = upgradedSix()
		let answer = slice(receiver, integer(1), integer(5))

		expect(Number(length(answer).value)).toBe(4)
		expect(answer.front).toBe(receiver.front)
		expect(answer.value).toBe(receiver.value)
		expect(answer.front?.length).toBe(3)
	})
})

// An answer and the box it was cut from share Arrays, and neither may answer
// an item the other added. The stale-copy paths in `append` and `prepend` keep
// that.
const expectOwnHistory = (
	originalList: ListType<IntegerType>,
	items: Array<number>,
): void => {
	expect(itemsOf(originalList)).toEqual(items)
	expect(itemsOf(append(originalList, integer(91)))).toEqual([...items, 91])
	expect(itemsOf(prepend(originalList, integer(92)))).toEqual([92, ...items])
	expect(itemsOf(originalList)).toEqual(items)
}

describe("a shared answer and the box it was cut from", () => {
	const cases: Array<{
		name: string
		receiverItems: Array<number>
		answerItems: Array<number>
		build: () => {
			receiver: ListType<IntegerType>
			answer: ListType<IntegerType>
		}
	}> = [
		{
			name: "a window of an upgraded box",
			receiverItems: [11, 22, 33, 44, 55, 66],
			answerItems: [22, 33, 44, 55],
			build: () => {
				let receiver = upgradedSix()

				return {
					receiver,
					answer: slice(receiver, integer(1), integer(5)),
				}
			},
		},
		{
			name: "a prefix of a flat box",
			receiverItems: [11, 22, 33, 44, 55, 66],
			answerItems: [11, 22, 33, 44],
			build: () => {
				let receiver = flatSix()

				return {
					receiver,
					answer: slice(receiver, integer(0), integer(4)),
				}
			},
		},
		{
			// The whole of a flat box, as `removeFirst(0)` asks for. Both boxes
			// view the whole Array, so the answer's append pushes in place, and
			// the receiver needs its own count to leave that item out.
			name: "the whole of a flat box",
			receiverItems: [11, 22, 33, 44, 55, 66],
			answerItems: [11, 22, 33, 44, 55, 66],
			build: () => {
				let receiver = flatSix()

				return {
					receiver,
					answer: slice(receiver, integer(0), integer(6)),
				}
			},
		},
		{
			name: "the first item dropped",
			receiverItems: [11, 22, 33, 44, 55, 66],
			answerItems: [22, 33, 44, 55, 66],
			build: () => {
				let receiver = upgradedSix()

				return { receiver, answer: remove(receiver, integer(0)) }
			},
		},
		{
			name: "the last item dropped",
			receiverItems: [11, 22, 33, 44, 55, 66],
			answerItems: [11, 22, 33, 44, 55],
			build: () => {
				let receiver = upgradedSix()

				return { receiver, answer: remove(receiver, integer(-1)) }
			},
		},
		{
			name: "an item in the back run replaced",
			receiverItems: [11, 22, 33, 44, 55, 66],
			answerItems: [11, 22, 33, 44, 99, 66],
			build: () => {
				let receiver = upgradedSix()

				return {
					receiver,
					answer: replace(receiver, integer(99), integer(4)),
				}
			},
		},
		{
			name: "an item in the front run replaced",
			receiverItems: [11, 22, 33, 44, 55, 66],
			answerItems: [11, 99, 33, 44, 55, 66],
			build: () => {
				let receiver = upgradedSix()

				return {
					receiver,
					answer: replace(receiver, integer(99), integer(1)),
				}
			},
		},
	]

	for (let entry of cases) {
		test(`${entry.name} keeps its own history, whichever grows first`, () => {
			let answerFirst = entry.build()

			expectOwnHistory(answerFirst.answer, entry.answerItems)
			expectOwnHistory(answerFirst.receiver, entry.receiverItems)

			let receiverFirst = entry.build()

			expectOwnHistory(receiverFirst.receiver, entry.receiverItems)
			expectOwnHistory(receiverFirst.answer, entry.answerItems)
		})
	}
})

describe("a shared answer is invisible", () => {
	const window = () => slice(upgradedSix(), integer(1), integer(5))
	const copied = () => createList([22, 33, 44, 55].map(integer))

	test("it is equal to an eagerly copied one, before and after it is read", () => {
		let read = window()

		materialise(read)

		expect(is(window(), copied(), integerEquality).value).toBeTrue()
		expect(is(copied(), window(), integerEquality).value).toBeTrue()
		expect(is(read, copied(), integerEquality).value).toBeTrue()
		expect(is(window(), read, integerEquality).value).toBeTrue()
	})

	test("it prints as an eagerly copied one does, before and after it is read", () => {
		let read = window()

		materialise(read)

		expect(listToString(window(), integerPrinting).value).toBe(
			listToString(copied(), integerPrinting).value,
		)
		expect(listToString(read, integerPrinting).value).toBe(
			listToString(copied(), integerPrinting).value,
		)
		expect(getStringRepresentation(window())).toBe(
			getStringRepresentation(copied()),
		)
		expect(getStringRepresentation(read)).toBe(
			getStringRepresentation(copied()),
		)
	})
})

// Each step of a drain from the front answers a box over the same Array with one
// item less in view. Reading a box mid-chain must not disturb the rest.
describe("draining from the front", () => {
	// Both ways a List can be built, since neither may copy the whole List at
	// every step.
	for (let [built, build] of [
		["a prepend-built", prependedOnly],
		[
			"an append-built",
			(items: Array<number>) => createList(items.map(integer)),
		],
	] as const) {
		test(`every step of ${built} drain answers the items that are left`, () => {
			let drained = build([11, 22, 33, 44, 55, 66])
			let seen: Array<Array<number>> = []

			for (let step = 0; step < 6; step++) {
				drained = remove(drained, integer(0))
				seen.push(itemsOf(drained))
			}

			expect(seen).toEqual([
				[22, 33, 44, 55, 66],
				[33, 44, 55, 66],
				[44, 55, 66],
				[55, 66],
				[66],
				[],
			])
			expect(itemsOf(remove(drained, integer(0)))).toEqual([])
		})

		test(`every step of ${built} removeFirst drain answers the items that are left`, () => {
			let drained = build([11, 22, 33, 44, 55, 66])
			let seen: Array<Array<number>> = []

			for (let step = 0; step < 6; step++) {
				drained = slice(drained, integer(1), length(drained))
				seen.push(itemsOf(drained))
			}

			expect(seen).toEqual([
				[22, 33, 44, 55, 66],
				[33, 44, 55, 66],
				[44, 55, 66],
				[55, 66],
				[66],
				[],
			])
		})
	}

	test("an append-built drain upgrades once and stays on a front run", () => {
		let drained = createList([11, 22, 33, 44, 55, 66].map(integer))

		drained = remove(drained, integer(0))

		expect(drained.front).toBeDefined()

		for (let step = 0; step < 4; step++) {
			drained = remove(drained, integer(0))

			expect(drained.front).toBeDefined()
			expect(drained.value.length).toBe(0)
		}

		expect(itemsOf(drained)).toEqual([66])
	})

	test("a version held from the middle of the drain keeps its items", () => {
		let drained = prependedOnly([11, 22, 33, 44, 55, 66])
		let held = drained

		for (let step = 0; step < 3; step++) {
			drained = remove(drained, integer(0))

			if (step === 1) {
				held = drained
			}
		}

		expect(itemsOf(drained)).toEqual([44, 55, 66])
		expect(itemsOf(held)).toEqual([33, 44, 55, 66])
		expect(materialise(held).map((item) => Number(item.value))).toEqual([
			33, 44, 55, 66,
		])
		expect(itemsOf(drained)).toEqual([44, 55, 66])
	})
})

// Counts the items a walk moves rather than timing it, since work holds under
// any load. Each Array a box holds that was not seen before was built by the
// upgrade or a trim, and moved its length. The seed's own runs are charged
// nothing. Every item is priced alike, so a fill one item at a time costs the
// same here as a bulk copy.
const itemsMovedBy = (
	seed: ListType<IntegerType>,
	turn: (originalList: ListType<IntegerType>) => ListType<IntegerType>,
	turns: number,
): number => {
	let seen = new Set<Array<IntegerType>>()
	let moved = 0

	const record = (originalList: ListType<IntegerType>): void => {
		for (let run of [originalList.value, originalList.front]) {
			if (run !== undefined && !seen.has(run)) {
				seen.add(run)
				moved += run.length
			}
		}
	}

	record(seed)
	moved = 0

	let walked = seed

	for (let index = 0; index < turns; index++) {
		let next = turn(walked)

		// Both boxes, since the turn may have trimmed either.
		record(walked)
		record(next)
		walked = next
	}

	return moved
}

describe("what a walk over a List moves", () => {
	// At twenty thousand items a quadratic walk stands thousands of times clear
	// of the ceiling, five times the length.
	const ITEMS = 20_000
	const CEILING = ITEMS * 5

	const flat = (): ListType<IntegerType> =>
		createList(Array.from({ length: ITEMS }, (_, index) => integer(index)))

	const prepended = (): ListType<IntegerType> => {
		let built = createList<IntegerType>([])

		for (let index = ITEMS - 1; index >= 0; index--) {
			built = prepend(built, integer(index))
		}

		return built
	}

	const lengthOf = (originalList: ListType<IntegerType>): number =>
		Number(length(originalList).value)

	// The walk reads the head and drops it, written both ways round, since
	// either order must stay linear.
	const headTail = (originalList: ListType<IntegerType>) => {
		item(originalList, integer(0))

		return slice(originalList, integer(1), length(originalList))
	}

	const headTailDerivingFirst = (originalList: ListType<IntegerType>) => {
		let next = slice(originalList, integer(1), length(originalList))

		item(originalList, integer(0))

		return next
	}

	const initLast = (originalList: ListType<IntegerType>) => {
		item(originalList, integer(-1))

		return slice(
			originalList,
			integer(0),
			integer(lengthOf(originalList) - 1),
		)
	}

	// Both ends read and dropped, in one `slice` or in a `removeFirst()` and a
	// `removeLast()`.
	const bothEnds = (originalList: ListType<IntegerType>) => {
		item(originalList, integer(0))
		item(originalList, integer(-1))

		return slice(
			originalList,
			integer(1),
			integer(lengthOf(originalList) - 1),
		)
	}

	const bothEndsInTwoSlices = (originalList: ListType<IntegerType>) => {
		item(originalList, integer(0))
		item(originalList, integer(-1))

		let dropped = slice(originalList, integer(1), length(originalList))

		return slice(dropped, integer(0), integer(lengthOf(dropped) - 1))
	}

	const walks: Array<{
		name: string
		seed: () => ListType<IntegerType>
		turn: (originalList: ListType<IntegerType>) => ListType<IntegerType>
		turns: number
	}> = [
		{ name: "head/tail", seed: flat, turn: headTail, turns: ITEMS - 1 },
		{
			name: "head/tail with its two lines the other way round",
			seed: flat,
			turn: headTailDerivingFirst,
			turns: ITEMS - 1,
		},
		{
			name: "head/tail over a prepend-built List",
			seed: prepended,
			turn: headTail,
			turns: ITEMS - 1,
		},
		{ name: "init/last", seed: flat, turn: initLast, turns: ITEMS - 1 },
		{
			name: "init/last over a prepend-built List",
			seed: prepended,
			turn: initLast,
			turns: ITEMS - 1,
		},
		{
			name: "both ends in one slice",
			seed: flat,
			turn: bothEnds,
			turns: ITEMS / 2 - 1,
		},
		{
			name: "both ends in two slices",
			seed: flat,
			turn: bothEndsInTwoSlices,
			turns: ITEMS / 2 - 1,
		},
		{
			name: "remove(at 0)",
			seed: flat,
			turn: (originalList) => {
				item(originalList, integer(0))

				return remove(originalList, integer(0))
			},
			turns: ITEMS - 1,
		},
		{
			name: "remove(at 0) over a prepend-built List",
			seed: prepended,
			turn: (originalList) => {
				item(originalList, integer(0))

				return remove(originalList, integer(0))
			},
			turns: ITEMS - 1,
		},
		{
			// `firstItem` and `lastItem` read the ends off the view rather than
			// through the Optional of `item(at:)`.
			name: "the proven firstItem",
			seed: flat,
			turn: (originalList) => {
				firstItem(originalList)

				return slice(originalList, integer(1), length(originalList))
			},
			turns: ITEMS - 1,
		},
		{
			name: "the proven lastItem",
			seed: flat,
			turn: (originalList) => {
				lastItem(originalList)

				return slice(
					originalList,
					integer(0),
					integer(lengthOf(originalList) - 1),
				)
			},
			turns: ITEMS - 1,
		},
		{
			name: "two items a turn",
			seed: flat,
			turn: (originalList) => {
				item(originalList, integer(0))
				item(originalList, integer(1))

				return slice(originalList, integer(2), length(originalList))
			},
			turns: ITEMS / 2 - 1,
		},
	]

	for (let walk of walks) {
		test(`the ${walk.name} walk moves a few items per item, not a few thousand`, () => {
			expect(
				itemsMovedBy(walk.seed(), walk.turn, walk.turns),
			).toBeLessThan(CEILING)
		})
	}

	// The front half of the half rule. The front run is stored reversed, so the
	// trim must keep the run's low end.
	test("a window of a long front run is trimmed and still answers its items", () => {
		let deep = prependedOnly([11, 22, 33, 44, 55, 66, 77, 88])
		let answer = slice(deep, integer(6), integer(8))

		expect(answer.front).toBe(deep.front)
		expect(itemAt(answer, 0)).toBe(77)
		expect(answer.front).not.toBe(deep.front)
		expect(answer.front?.length).toBe(2)
		expect(itemsOf(answer)).toEqual([77, 88])
		expect(itemAt(answer, 1)).toBe(88)
		expect(itemAt(answer, -1)).toBe(88)
		expect(itemAt(answer, 2)).toBeNull()
		expect(itemsOf(deep)).toEqual([11, 22, 33, 44, 55, 66, 77, 88])
	})

	// The receiver already views its whole run, and the answer's size is settled
	// when the answer is read.
	test("a short window of a tight box is cut without moving an item", () => {
		let receiver = flat()

		expect(
			itemsMovedBy(
				receiver,
				(originalList) => {
					slice(originalList, integer(0), integer(2))

					return originalList
				},
				1,
			),
		).toBe(0)
	})

	// A window keeping little of a long run releases it when read, so nothing
	// holds a parent it can not reach. So the rule trims at half rather than never.
	test("a short window releases its parent when it is read", () => {
		let receiver = flat()
		let answer = slice(receiver, integer(0), integer(2))

		expect(answer.value).toBe(receiver.value)
		expect(itemAt(answer, 1)).toBe(1)
		expect(answer.value).not.toBe(receiver.value)
		expect(answer.value.length).toBe(2)
	})

	// The same for a window holding part of each of two runs.
	test("a short window of a two-run box releases both parents when it is read", () => {
		let receiver = prepend(flat(), integer(-1))
		let answer = slice(receiver, integer(0), integer(2))

		expect(itemAt(answer, 1)).toBe(0)
		expect(answer.front?.length).toBe(1)
		expect(answer.value.length).toBe(1)
	})

	// The rule trims a view of less than half its Array. Where equality falls is
	// policy rather than an invariant, but the documented retention bound is
	// stated against it.
	test("a window of exactly half its run keeps it, and one item less does not", () => {
		let half = slice(flat(), integer(0), integer(ITEMS / 2))
		let parent = half.value

		expect(itemAt(half, 0)).toBe(0)
		expect(half.value).toBe(parent)
		expect(half.value.length).toBe(ITEMS)

		let underHalf = slice(flat(), integer(0), integer(ITEMS / 2 - 1))

		expect(itemAt(underHalf, 0)).toBe(0)
		expect(underHalf.value.length).toBe(ITEMS / 2 - 1)
	})
})

// The per-item cost of moving a seam has no guard, since only a clock sees a
// constant and a clock flakes under load. The count can hold that a one-shot
// interior window of about half moves no more than its own copy.
describe("what an interior window moves", () => {
	const ITEMS = 20_000

	const flat = (): ListType<IntegerType> =>
		createList(Array.from({ length: ITEMS }, (_, index) => integer(index)))

	// A seam in the middle of this window would move the whole List, and no
	// later window repays that, so the window is copied.
	test("a one-shot window of about half moves the window, not the List", () => {
		expect(
			itemsMovedBy(
				flat(),
				(originalList) => {
					slice(originalList, integer(1), integer(1 + ITEMS / 2))

					return originalList
				},
				1,
			),
		).toBeLessThanOrEqual(ITEMS / 2)
	})

	// A window keeping three quarters or more moves the seam, moving the whole
	// List once. The walk that drops both ends relies on it.
	test("a window of three quarters moves the seam, and moves the List once", () => {
		let receiver = flat()
		let moved = itemsMovedBy(
			receiver,
			(originalList) => {
				slice(originalList, integer(1), integer(1 + (ITEMS * 3) / 4))

				return originalList
			},
			1,
		)

		expect(receiver.front).toBeDefined()
		expect(moved).toBeGreaterThan(ITEMS / 2)
		expect(moved).toBeLessThanOrEqual(ITEMS * 2)
	})
})
