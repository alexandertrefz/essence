import { describe, expect, test } from "bun:test"

import { createBoolean } from "../Boolean"
import type { IntegerType } from "../Integer"
import { createInteger } from "../Integer"
import {
	append__overload$1 as append,
	createList,
	insert,
	is,
	length,
	type ListType,
	materialise,
	prepend__overload$1 as prepend,
	remove,
	runsOf,
	slice,
	toString as listToString,
} from "../List"
import { replace } from "../NonEmptyList"
import { createString } from "../String"
import { getStringRepresentation } from "../Terminal"

// NOTE: The four edits that answer with a shorter, longer or altered List —
// `slice`, `remove(at:)`, `insert(_:at:)` and `NonEmptyList::replace(_:at:)`.
// Each of them may answer by SHARING one or both of the receiver's runs under a
// view of its own, which is a representation nothing in the language can ask
// about — so every test here asks only what a List ANSWERS, and the handful that
// do look at the box say so and are about the sharing itself.
const integer = (value: number) => createInteger(BigInt(value))

const integerEquality = {
	is: (first: IntegerType, second: IntegerType) =>
		createBoolean(first.value === second.value),
}

const integerPrinting = {
	toString: (value: IntegerType) => createString(String(value.value)),
}

// NOTE: The items a List answers, read without disturbing it at all — not even
// the trimming `viewOf` does, since half of what is held here is what a box is
// still holding after somebody else has read or grown it.
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

// NOTE: What each edit MEANS, written against a plain JavaScript Array — the
// items the box answers, spliced the way the Method's documentation describes
// them. Nothing here knows a List has runs, so a disagreement below is always
// the native's.
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

// NOTE: A box for every way a List can be holding its items by the time an edit
// reaches it. `seam` is where its front run ends and its back run begins, which
// is the boundary every position below is placed against; `build` answers a
// fresh one, because reading a List may change how it holds them.
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
		// NOTE: A box somebody else appended to, so its back view is shorter
		// than the Array it holds — the edits must answer for the VIEW.
		name: "a stale-back box",
		seam: 0,
		build: () => {
			let base = flatSix()

			append(base, integer(99))

			return base
		},
	},
	{
		// NOTE: The same on the other side — somebody else prepended, so the
		// front Array holds an item this box never saw.
		name: "a stale-front box",
		seam: 3,
		build: () => {
			let base = upgradedSix()

			prepend(base, integer(99))

			return base
		},
	},
	{
		// NOTE: The answer of a sharing `slice`, edited in its turn — a box
		// holding two Arrays it owns neither of, and viewing less of both.
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
		// NOTE: The same with no front run at all — a prefix of a flat box,
		// which is the only window a flat box can share.
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

// NOTE: Every position an edit can be given, placed against the box's own seam:
// the two ends, both sides of the seam, both sides of the last item, one past
// the end and one further — each of them mirrored as the negative position
// naming the same place, plus the two that reach past either end and the two
// that would wrap if the arithmetic ever left bigint.
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
			// NOTE: Read off a FRESH box with `materialise`, which is the one
			// reader that answers a plain Array — so the reference below is
			// built from the same items the box answers and from nothing else.
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

// NOTE: The structural claims — the only tests here that look at the box rather
// than at what it answers, because "shared" is not something a List can be
// asked. Each pins an answer that costs nothing but a box, and would go on
// passing the tests above if it quietly started copying.
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

	test("dropping the first item of a box with no front copies", () => {
		let receiver = flatSix()
		let answer = remove(receiver, integer(0))

		expect(answer.value).not.toBe(receiver.value)
		expect(itemsOf(receiver)).toEqual([11, 22, 33, 44, 55, 66])
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

	// NOTE: A read is where a shared answer pays for itself, and it pays the
	// ANSWER's size rather than the parent's: a two-item window of a hundred
	// item List trims to two.
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

	// NOTE: Counting is not reading. The stdlib writes `removeFirst()` as
	// `@::slice(from 1, to @::length())`, so every turn of a drain from the
	// front asks a shrinking window for its length before slicing it again — and
	// a `length` that trimmed would copy the whole front run there and hand back
	// exactly what the shrink had just saved. `removeFirst(count)` and
	// `removeLast(count)` are the same composition; `listPerformance.spec.ts`
	// guards the time.
	test("asking a shared window for its length leaves it shared", () => {
		let receiver = upgradedSix()
		let answer = slice(receiver, integer(1), integer(5))

		expect(Number(length(answer).value)).toBe(4)
		expect(answer.front).toBe(receiver.front)
		expect(answer.value).toBe(receiver.value)
		expect(answer.front?.length).toBe(3)
	})
})

// NOTE: The claim every shared answer rests on. The answer and the box it was
// cut from hold the same Arrays and neither may ever answer with an item the
// other added, however either of them grows and in whichever order — which is
// what the stale-copy paths in `append` and `prepend` are for.
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
			// NOTE: The WHOLE of a flat box, which is what `removeFirst(0)` and
			// `removeLast(0)` ask for. This one is the case a receiver's view
			// has to be written down for: both boxes view the whole Array, so
			// the answer's own append pushes onto it in place, and a receiver
			// whose count was left IMPLIED would answer with the item that was
			// added for somebody else.
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

// NOTE: Draining a List one item at a time from the front, which is what the
// front run is for. Every step answers a box over the same Array with one item
// less of it in view, so the whole drain moves no items at all — and reading a
// box in the middle of the chain must not disturb the rest of it.
describe("draining from the front", () => {
	test("every step answers the items that are left", () => {
		let drained = prependedOnly([11, 22, 33, 44, 55, 66])
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
