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

// NOTE: The item a position names, unwrapped — `item(at:)` answers an Optional
// for every position, and nothing below is about the Optional.
const itemAt = (
	originalList: ListType<IntegerType>,
	position: number,
): number | null => {
	let answer = item(originalList, integer(position))

	return answer[typeKeySymbol] === "Optional#Empty"
		? null
		: Number(answer.item.value)
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

	// NOTE: A box whose seam is at zero can share no suffix as it stands, so
	// asked for one it moves its seam to the end first: the back run becomes a
	// front run, and the answer is a window of that. The receiver answers the
	// same items in its new shape, and the fresh back it is left with is its
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

	// NOTE: The half rule — an upgrade copies the whole run where the plain
	// path copies the window, so a suffix shorter than the prefix it drops is
	// copied out as it always was, and the receiver is left flat.
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
	// NOTE: Both ways a List can have been built, because which end it was
	// built at used to decide whether taking it apart from the front copied
	// the whole of it at every step.
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

// NOTE: THE ITEMS A WALK MOVES, counted from outside the runtime rather than
// timed. Every Array a box of the chain holds that has not been seen before was
// BUILT by somebody — the seed, the one upgrade, or a trim under the half rule —
// and building it moved as many items as it is long. Summing their lengths over
// a whole walk is the claim the half rule makes, said as a number: a walk over
// n items moves a few times n, where trimming at every read moved half of n
// times n.
//
// NOTE: A count rather than a clock. What the half rule promises is WORK, and a
// claim about work holds on a machine under any load at all — where the
// wall-clock ceilings in `listPerformance.spec.ts` have to sit an order of
// magnitude above the linear figure to be safe, and can only catch a
// regression that costs more than that.
//
// NOTE: The seed's own runs are recorded before the walk and charged nothing:
// the Program built them, and what is being measured is what taking the List
// apart adds to that.
// NOTE: WHAT THIS CAN NOT SEE. An item is priced at one item wherever it was
// moved from and however it was moved, so a path that moves its items DEARLY —
// one at a time through a call and a branch, rather than in a bulk `slice` —
// counts exactly the same here as the bulk copy it replaced. That is not a flaw
// in the count, which is measuring what it says it measures; it is the reason
// the count is not the whole of the claim. `upgradedAroundWindow` shipped
// filling its runs item by item at about 6.5x the per-item cost of the copy it
// stood in for, inside this metric's bound the whole time. The per-item half of
// the claim has no guard in this file, for the reason the NOTE over "what an
// interior window moves" gives.
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

		// NOTE: BOTH boxes, because either of them may have been trimmed: the
		// receiver where the turn read it or cut a window from it, and the
		// answer where it was read in its turn.
		record(walked)
		record(next)
		walked = next
	}

	return moved
}

describe("what a walk over a List moves", () => {
	// NOTE: Twenty thousand items, which is where a quadratic walk stands two
	// thousand times clear of a linear one and no arithmetic is needed to tell
	// them apart. The ceiling is five times the length: the dearest of the
	// shapes below moves three times it, and a walk that trimmed at every turn
	// moves ten thousand times it.
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

	// NOTE: `firstItem()` is `@::item(at 0)` and `removeFirst()` is
	// `@::slice(from 1)`, so the two lines of the canonical walk are these two
	// natives — and the walk is written BOTH ways round, because which of the
	// two the turn reaches first used to decide whether it stayed linear.
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

	// NOTE: The palindrome shape — both ends read, both ends dropped — in the
	// two spellings a Program has for it: one `slice` taking an item off each
	// end, and `removeFirst()` followed by `removeLast()`.
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
			// NOTE: The proven halves of the pair, which read the two ends off
			// the view rather than through the Optional `item(at:)` answers.
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

	// NOTE: THE FRONT half of the rule, which no other test here reaches: a
	// window keeping less than half of a long FRONT run. The front is stored
	// reversed, so what the trim must keep is the run's LOW end and what the
	// box's head is standing at is its high one — a trim that took the wrong
	// slice of it would answer an item nobody put there, or nothing at all.
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

	// NOTE: The other side of the rule's subject. Cutting a short window out of
	// a box that views the WHOLE of its run must move nothing at all: the run is
	// already as short as the receiver can make it, and the answer's own
	// smallness is the answer's business, settled the first time it is read. A
	// rule asked about the answer's counts here copies the whole receiver to
	// hand out two items.
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

	// NOTE: The other half of the claim, and the reason the rule is a HALF rule
	// rather than "never trim": a window that keeps only a little of a long run
	// still releases it, so nothing indexed for the rest of a Program holds a
	// parent it can not reach. Two items of twenty thousand, read at a position
	// and nothing more.
	test("a short window releases its parent when it is read", () => {
		let receiver = flat()
		let answer = slice(receiver, integer(0), integer(2))

		expect(answer.value).toBe(receiver.value)
		expect(itemAt(answer, 1)).toBe(1)
		expect(answer.value).not.toBe(receiver.value)
		expect(answer.value.length).toBe(2)
	})

	// NOTE: And the same for a window cut from the far end of a long run, which
	// is the other way a box ends up holding much more than it views.
	test("a short window of a two-run box releases both parents when it is read", () => {
		let receiver = prepend(flat(), integer(-1))
		let answer = slice(receiver, integer(0), integer(2))

		expect(itemAt(answer, 1)).toBe(0)
		expect(answer.front?.length).toBe(1)
		expect(answer.value.length).toBe(1)
	})

	// NOTE: WHERE THE RULE'S BOUNDARY IS, pinned because nothing else pins it:
	// the rule trims a view that is LESS than half of its Array, so a box
	// viewing exactly half keeps the Array it has and one item less lets it go.
	// Which side of the boundary equality falls on is a policy rather than an
	// invariant — the whole suite stays green with the comparison turned round —
	// but it is what the retention bound in the docs is stated against, so it is
	// worth a test saying which one the docs mean.
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

// NOTE: THE PER-ITEM HALF OF THE CLAIM has NO guard here, and that is a
// decision rather than an oversight. What `itemsMovedBy` can not see is a
// constant — the seam move costing more per item than the `slice` it stands in
// for — and a constant can only be caught by a clock. A ratio between the two
// cuts measured in one process was written and thrown away: the honest
// separation is 1.5x for the bulk fill against 4.5x for the item-by-item one,
// and twenty runs of it while a full suite ran on the same machine put the
// GOOD side as high as 3.03x and the bad side as low as 3.54x. There is no
// threshold between those two, so any such guard is a flake, and a flake that
// fires on a loaded machine is worse than no guard. The per-item cost is held
// by the numbers in the NOTE beside `upgradedAroundWindow` instead.
//
// NOTE: What IS expressible is the other half of the same fix — that a one-shot
// interior window of about half moves no more than the copy it asked for, which
// is what raising the rule to three quarters bought. The work count says it
// exactly.
describe("what an interior window moves", () => {
	const ITEMS = 20_000

	const flat = (): ListType<IntegerType> =>
		createList(Array.from({ length: ITEMS }, (_, index) => integer(index)))

	// NOTE: A window of about half, held off both ends: under the half rule this
	// moved the whole List to put a seam in the middle of it, and nothing that
	// follows ever asks for a second window to pay that back. The plain copy
	// moves the window and no more.
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

	// NOTE: And the other side of the rule, which is what the palindrome walk
	// rests on: a window keeping three quarters or more DOES move the seam, and
	// moves the whole List once to do it. Without this the two rules would be
	// indistinguishable from "never move a seam", which the walks above would
	// then catch as a quadratic — but slowly, and a long way from here.
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
