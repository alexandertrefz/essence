import { describe, expect, test } from "bun:test"

import type { common } from "@essence-lang/interfaces"

import { createBoolean } from "../Boolean"
import type { IntegerType } from "../Integer"
import { compare as compareIntegers, createInteger } from "../Integer"
import { anyIs } from "../internalHelpers"
import {
	append__overload$1 as append,
	append__overload$2 as appendContentsOf,
	compare,
	createList,
	insert,
	is,
	item,
	join,
	keepEvery,
	length,
	type ListType,
	map,
	materialise,
	pair,
	prepend__overload$1 as prepend,
	reduce__overload$1 as reduce,
	reduce__overload$2 as reduceWithStep,
	reverse,
	slice,
	sort__overload$1 as sortByOwnOrder,
	sort__overload$2 as sortBy,
	split,
	toString as listToString,
	viewOf,
} from "../List"
import { flatten } from "../NestedList"
import {
	firstItem,
	lastItem,
	prepend as prependContentsOf,
	removeDuplicates,
	replace,
} from "../NonEmptyList"
import { createString } from "../String"
import { getStringRepresentation } from "../Terminal"
import { type AnyType, isValueOfType, typeKeySymbol } from "../type"

const integers = (...values: Array<number>): ListType<IntegerType> =>
	createList(values.map((value) => createInteger(BigInt(value))))

// NOTE: The items a List answers, read WITHOUT collapsing it — `materialise`
// would demote an upgraded box to a flat one, and most of what these tests are
// about is what a box is still holding after it has been read.
const itemsOf = (originalList: ListType<IntegerType>): Array<number> => {
	let view = viewOf(originalList)
	let items: Array<number> = []

	for (let index = view.frontCount - 1; index >= 0; index--) {
		items.push(Number(view.front[index].value))
	}

	for (let index = 0; index < view.backCount; index++) {
		items.push(Number(view.back[index].value))
	}

	return items
}

const itemAt = (
	originalList: ListType<IntegerType>,
	position: number,
): number | null => {
	let answer = item(originalList, createInteger(BigInt(position)))

	return answer[typeKeySymbol] === "Optional#Empty"
		? null
		: Number(answer.item.value)
}

// NOTE: A five-item List whose first two items live in the front run and whose
// last three live in the back — the shape every native below is held against,
// since a run boundary in the middle is what a walk or a position can get
// wrong. A fresh one per call, because reading a List may demote it.
const upgraded = (): ListType<IntegerType> =>
	prepend(prepend(integers(3, 4, 5), createInteger(2n)), createInteger(1n))

const integerEquality = {
	is: (first: IntegerType, second: IntegerType) =>
		createBoolean(first.value === second.value),
}

const integerOrder = { compare: compareIntegers }

const integerPrinting = {
	toString: (value: IntegerType) => createString(String(value.value)),
}

const integerList: common.Type = {
	type: "List",
	itemType: { type: "Integer" },
}

const stringList: common.Type = { type: "List", itemType: { type: "String" } }

describe("cross-representation reads", () => {
	// NOTE: The claim the whole scheme rests on — the representation is not
	// part of the value. A List built by prepending and a List written out flat
	// hold the same items, so every question either can be asked has to give
	// the same answer for both.
	test("a flat List and an upgraded one holding the same items agree", () => {
		let flat = integers(1, 2, 3)
		let built = prepend(integers(2, 3), createInteger(1n))

		expect(built.front).toBeDefined()

		expect(is(flat, built, integerEquality).value).toBeTrue()
		expect(is(built, flat, integerEquality).value).toBeTrue()
		expect(anyIs(flat, built)).toBeTrue()
		expect(anyIs(built, flat)).toBeTrue()

		expect(compare(flat, built, integerOrder)[typeKeySymbol]).toBe(
			"Ordering#Equal",
		)
		expect(compare(built, flat, integerOrder)[typeKeySymbol]).toBe(
			"Ordering#Equal",
		)

		expect(listToString(built, integerPrinting).value).toBe(
			listToString(flat, integerPrinting).value,
		)
		expect(getStringRepresentation(built)).toBe(
			getStringRepresentation(flat),
		)
	})

	test("an upgraded List narrows the way a flat one does", () => {
		expect(isValueOfType(upgraded(), integerList)).toBeTrue()
		expect(isValueOfType(upgraded(), stringList)).toBeFalse()

		// NOTE: The item that would be missed by a walk of the back run alone
		// sits in the FRONT run, so a List whose front holds the odd item out
		// is what says the type test walks both.
		let mixed = prepend(
			createList<AnyType>([createInteger(3n), createInteger(4n)]),
			createString("one"),
		)

		expect(isValueOfType(mixed, integerList)).toBeFalse()
	})
})

describe("branching at both ends", () => {
	// NOTE: Four boxes over two shared runs, each with its own history. Nothing
	// any of them is asked may show an item another one added.
	test("each box reads its own items and the receiver is unchanged", () => {
		let x = integers(1, 2)
		let y = prepend(x, createInteger(0n))
		let z = prepend(x, createInteger(9n))
		let w = append(y, createInteger(3n))

		expect(itemsOf(y)).toEqual([0, 1, 2])
		expect(itemsOf(z)).toEqual([9, 1, 2])
		expect(itemsOf(w)).toEqual([0, 1, 2, 3])
		expect(itemsOf(x)).toEqual([1, 2])

		// NOTE: Asked a second time, because the first ask trims a stale box
		// and the answer has to survive that.
		expect(itemsOf(y)).toEqual([0, 1, 2])
		expect(itemsOf(x)).toEqual([1, 2])
	})

	test("prepending twice from one box gives each answer its own front", () => {
		let base = prepend(integers(3), createInteger(2n))
		let first = prepend(base, createInteger(1n))
		let second = prepend(base, createInteger(0n))

		expect(itemsOf(base)).toEqual([2, 3])
		expect(itemsOf(first)).toEqual([1, 2, 3])
		expect(itemsOf(second)).toEqual([0, 2, 3])
		expect(itemsOf(base)).toEqual([2, 3])
	})
})

describe("divergent appends", () => {
	// NOTE: A thousand appends share one run; appending to a version from the
	// middle of that chain has to answer that version's items and one more,
	// while the held version itself never grows.
	test("appending to two tips of one chain answers two Lists", () => {
		let built = createList<IntegerType>([])
		let held = built

		for (let value = 0; value < 1000; value++) {
			built = append(built, createInteger(BigInt(value)))

			if (value === 499) {
				held = built
			}
		}

		let fromHeld = append(held, createInteger(-1n))
		let fromTip = append(built, createInteger(-2n))

		expect(Number(length(held).value)).toBe(500)
		expect(Number(length(built).value)).toBe(1000)
		expect(Number(length(fromHeld).value)).toBe(501)
		expect(Number(length(fromTip).value)).toBe(1001)

		expect(itemAt(held, -1)).toBe(499)
		expect(itemAt(fromHeld, -1)).toBe(-1)
		expect(itemAt(fromHeld, 499)).toBe(499)
		expect(itemAt(fromTip, -1)).toBe(-2)
		expect(itemAt(built, -1)).toBe(999)

		// NOTE: The held version's view never grows, however many times it is
		// read after the two tips diverged.
		expect(Number(length(held).value)).toBe(500)
	})
})

describe("reentrancy", () => {
	// NOTE: The fold is seeded with the very List it walks, so the first append
	// pushes onto the run the walk is reading. The walk covers the items the
	// List held when it started, which is what it did when every append copied.
	test("a fold seeded with the List it walks answers twice its items", () => {
		let list = integers(1, 2, 3)
		let doubled = reduce(list, list, (accumulator, each) =>
			append(accumulator, each),
		)

		expect(itemsOf(doubled)).toEqual([1, 2, 3, 1, 2, 3])
		expect(itemsOf(list)).toEqual([1, 2, 3])
	})

	test("the early-stopping fold covers the entry-time items too", () => {
		let list = integers(1, 2, 3)
		let grown = list
		let visited: Array<number> = []

		reduceWithStep(list, list, (accumulator, each) => {
			visited.push(Number(each.value))
			grown = append(grown, each)

			return {
				[typeKeySymbol]: "Step#Continue",
				state: accumulator,
			}
		})

		expect(visited).toEqual([1, 2, 3])
		expect(itemsOf(list)).toEqual([1, 2, 3])
		expect(itemsOf(grown)).toEqual([1, 2, 3, 1, 2, 3])
	})

	test("a map whose transform appends to the walked List answers n items", () => {
		let list = integers(1, 2, 3)
		let grown = list
		let mapped = map(list, (each) => {
			grown = append(grown, each)

			return each
		})

		expect(itemsOf(mapped)).toEqual([1, 2, 3])
		expect(itemsOf(list)).toEqual([1, 2, 3])
		expect(itemsOf(grown)).toEqual([1, 2, 3, 1, 2, 3])
	})

	test("adding a List to itself adds the items it held at entry", () => {
		let list = integers(1, 2, 3)

		expect(itemsOf(appendContentsOf(list, list))).toEqual([
			1, 2, 3, 1, 2, 3,
		])
		expect(itemsOf(list)).toEqual([1, 2, 3])

		let built = upgraded()

		expect(itemsOf(appendContentsOf(built, built))).toEqual([
			1, 2, 3, 4, 5, 1, 2, 3, 4, 5,
		])
		expect(itemsOf(built)).toEqual([1, 2, 3, 4, 5])
	})
})

describe("stale views", () => {
	// NOTE: A box left behind by an append holds its chain's high-water Array
	// until it is read. The first read trims that away and stores the trimmed
	// Array back, so every read after it is handed the same Array.
	test("a stale box is trimmed once and answers one Array ever after", () => {
		let list = integers(1, 2, 3)

		append(list, createInteger(4n))

		expect(list.value.length).toBe(4)
		expect(list.length).toBe(3)

		let first = materialise(list)
		let second = materialise(list)

		expect(first.length).toBe(3)
		expect(second).toBe(first)
		expect(list.value).toBe(first)
		expect(list.length).toBe(3)
	})

	test("an upgraded box is demoted once and reads flat afterwards", () => {
		let built = upgraded()
		let first = materialise(built)
		let second = materialise(built)

		expect(second).toBe(first)
		expect(built.front).toBeUndefined()
		expect(built.value).toBe(first)
		expect(built.length).toBe(5)
		expect(itemsOf(built)).toEqual([1, 2, 3, 4, 5])
	})
})

describe("every native against an upgraded receiver", () => {
	// NOTE: `removeFirst`, `removeLast`, `partition` and the rest of that family
	// are written in Essence on `slice`, `item(at:)` and `length`, so there is
	// no native of their own to hold here — the three they are written on are
	// held instead. `remove(at:)` has a native again, and it and the three
	// edits beside it are held in `edits.spec.ts`, against every shape a box can
	// be in when one reaches it.
	test("length and positions across the run boundary", () => {
		let built = upgraded()

		expect(Number(length(built).value)).toBe(5)

		expect(itemAt(built, 0)).toBe(1)
		expect(itemAt(built, 1)).toBe(2)
		expect(itemAt(built, 2)).toBe(3)
		expect(itemAt(built, 4)).toBe(5)
		expect(itemAt(built, -1)).toBe(5)
		expect(itemAt(built, -3)).toBe(3)
		expect(itemAt(built, -4)).toBe(2)
		expect(itemAt(built, -5)).toBe(1)
		expect(itemAt(built, 5)).toBeNull()
		expect(itemAt(built, -6)).toBeNull()

		// NOTE: Reading a position must not collapse the box — indexing an
		// upgraded List stays one comparison rather than a combining walk.
		expect(built.front).toBeDefined()
	})

	test("slice spanning both runs", () => {
		expect(
			itemsOf(slice(upgraded(), createInteger(1n), createInteger(4n))),
		).toEqual([2, 3, 4])
		expect(
			itemsOf(slice(upgraded(), createInteger(0n), createInteger(2n))),
		).toEqual([1, 2])
		expect(
			itemsOf(slice(upgraded(), createInteger(2n), createInteger(5n))),
		).toEqual([3, 4, 5])
		expect(
			itemsOf(slice(upgraded(), createInteger(0n), createInteger(-1n))),
		).toEqual([1, 2, 3, 4])
	})

	test("reverse, sort and insert", () => {
		expect(itemsOf(reverse(upgraded()))).toEqual([5, 4, 3, 2, 1])

		expect(
			itemsOf(sortByOwnOrder(reverse(upgraded()), integerOrder)),
		).toEqual([1, 2, 3, 4, 5])
		expect(
			itemsOf(
				sortBy(upgraded(), (first, second) =>
					compareIntegers(second, first),
				),
			),
		).toEqual([5, 4, 3, 2, 1])

		expect(
			itemsOf(insert(upgraded(), createInteger(9n), createInteger(2n))),
		).toEqual([1, 2, 9, 3, 4, 5])
		expect(
			itemsOf(insert(upgraded(), createInteger(9n), createInteger(0n))),
		).toEqual([9, 1, 2, 3, 4, 5])
		expect(
			itemsOf(insert(upgraded(), createInteger(9n), createInteger(-1n))),
		).toEqual([1, 2, 3, 4, 9, 5])
	})

	test("split and pair", () => {
		let groups = split(upgraded(), createInteger(2n))

		expect(groups[typeKeySymbol]).toBe("Optional#Value")

		if (groups[typeKeySymbol] === "Optional#Value") {
			expect(materialise(groups.item).map(itemsOf)).toEqual([
				[1, 2],
				[3, 4],
				[5],
			])
		}

		let paired = materialise(pair(upgraded(), integers(9, 8, 7)))

		expect(
			paired.map((entry) => [
				Number(entry.first.value),
				Number(entry.second.value),
			]),
		).toEqual([
			[1, 9],
			[2, 8],
			[3, 7],
		])
	})

	test("map, keepEvery and both folds", () => {
		expect(
			itemsOf(
				map(upgraded(), (each) =>
					createInteger(each.value * each.value),
				),
			),
		).toEqual([1, 4, 9, 16, 25])

		expect(
			itemsOf(
				keepEvery(upgraded(), (each) =>
					createBoolean(each.value % 2n === 0n),
				),
			),
		).toEqual([2, 4])

		let sum = reduce(upgraded(), createInteger(0n), (accumulator, each) =>
			createInteger(accumulator.value + each.value),
		)

		expect(Number(sum.value)).toBe(15)

		// NOTE: Stopping inside the FRONT run is the case the two loops could
		// get wrong — the back run must not be walked after a `#Done`.
		let visited: Array<number> = []
		let stopped = reduceWithStep(
			upgraded(),
			createInteger(0n),
			(accumulator, each) => {
				visited.push(Number(each.value))

				return each.value === 2n
					? { [typeKeySymbol]: "Step#Done", value: accumulator }
					: {
							[typeKeySymbol]: "Step#Continue",
							state: createInteger(
								accumulator.value + each.value,
							),
						}
			},
		)

		expect(visited).toEqual([1, 2])
		expect(Number(stopped.value)).toBe(1)
	})

	test("join, toString and the structural rendering", () => {
		expect(join(upgraded(), createString("-"), integerPrinting).value).toBe(
			"1-2-3-4-5",
		)
		expect(listToString(upgraded(), integerPrinting).value).toBe(
			"[ 1, 2, 3, 4, 5 ]",
		)
		expect(getStringRepresentation(upgraded())).toBe("[ 1, 2, 3, 4, 5 ]")

		// NOTE: A box an append left behind with an empty view still holds the
		// item that was pushed for somebody else, so the empty rendering has to
		// be decided by the VIEW rather than by the Array.
		let emptied = createList<IntegerType>([])

		append(emptied, createInteger(1n))

		expect(emptied.value.length).toBe(1)
		expect(listToString(emptied, integerPrinting).value).toBe("[]")
		expect(getStringRepresentation(emptied)).toBe("[]")
	})

	test("adding items at either end of an upgraded receiver", () => {
		expect(itemsOf(append(upgraded(), createInteger(6n)))).toEqual([
			1, 2, 3, 4, 5, 6,
		])
		expect(itemsOf(appendContentsOf(upgraded(), integers(6, 7)))).toEqual([
			1, 2, 3, 4, 5, 6, 7,
		])
		expect(itemsOf(appendContentsOf(upgraded(), upgraded()))).toEqual([
			1, 2, 3, 4, 5, 1, 2, 3, 4, 5,
		])
		expect(itemsOf(appendContentsOf(integers(0), upgraded()))).toEqual([
			0, 1, 2, 3, 4, 5,
		])
		expect(itemsOf(prepend(upgraded(), createInteger(0n)))).toEqual([
			0, 1, 2, 3, 4, 5,
		])
	})

	test("flatten over upgraded inner Lists", () => {
		let nested = prepend(
			createList([upgraded(), integers(6, 7)]),
			upgraded(),
		)

		expect(itemsOf(flatten(nested))).toEqual([
			1, 2, 3, 4, 5, 1, 2, 3, 4, 5, 6, 7,
		])
	})
})

describe("NonEmptyList against an upgraded receiver", () => {
	test("the first and last item", () => {
		expect(Number(firstItem(upgraded()).value)).toBe(1)
		expect(Number(lastItem(upgraded()).value)).toBe(5)

		// NOTE: A List built out of prepends alone has NO back run, so its last
		// item is the front run's — the front is stored reversed, which puts it
		// at position zero.
		let onlyPrepended = prepend(
			prepend(createList<IntegerType>([]), createInteger(2n)),
			createInteger(1n),
		)

		expect(itemsOf(onlyPrepended)).toEqual([1, 2])
		expect(Number(firstItem(onlyPrepended).value)).toBe(1)
		expect(Number(lastItem(onlyPrepended).value)).toBe(2)
	})

	test("removeDuplicates keeps the first of every group", () => {
		let repeated = prepend(
			prepend(integers(1, 3, 2), createInteger(2n)),
			createInteger(1n),
		)

		expect(itemsOf(repeated)).toEqual([1, 2, 1, 3, 2])
		expect(itemsOf(removeDuplicates(repeated, integerEquality))).toEqual([
			1, 2, 3,
		])
	})

	test("replace across the run boundary", () => {
		expect(
			itemsOf(replace(upgraded(), createInteger(9n), createInteger(0n))),
		).toEqual([9, 2, 3, 4, 5])
		expect(
			itemsOf(replace(upgraded(), createInteger(9n), createInteger(3n))),
		).toEqual([1, 2, 3, 9, 5])
		expect(
			itemsOf(replace(upgraded(), createInteger(9n), createInteger(-1n))),
		).toEqual([1, 2, 3, 4, 9])
		expect(
			itemsOf(replace(upgraded(), createInteger(9n), createInteger(5n))),
		).toEqual([1, 2, 3, 4, 5])
	})

	test("the transforms that carry the proof", () => {
		expect(itemsOf(prependContentsOf(upgraded(), integers(0)))).toEqual([
			0, 1, 2, 3, 4, 5,
		])
		expect(itemsOf(reverse(upgraded()))).toEqual([5, 4, 3, 2, 1])
		expect(
			itemsOf(sortByOwnOrder(reverse(upgraded()), integerOrder)),
		).toEqual([1, 2, 3, 4, 5])
	})
})
