import { describe, expect, test } from "bun:test"

import type { common } from "@essence-lang/interfaces"

import { createBoolean } from "../Boolean"
import { keys } from "../Dictionary"
import { tally } from "../GroupedList"
import type { IntegerType } from "../Integer"
import {
	compare as compareIntegers,
	createInteger,
	product,
	sum,
} from "../Integer"
import { anyIs } from "../internalHelpers"
import {
	append__overload$1 as append,
	append__overload$2 as appendContentsOf,
	compare,
	createList,
	insert,
	is,
	item__overload$1 as item,
	join,
	everyItem__overload$1 as everyItem,
	lastIndex__overload$3 as lastIndexWhere,
	length,
	type ListType,
	map,
	materialise,
	ownItemsOf,
	pair,
	partition__overload$1 as partition,
	prepend__overload$1 as prepend,
	reduce__overload$1 as reduce,
	remove,
	reduce__overload$2 as reduceWithStep,
	reverse,
	slice,
	sort__overload$1 as sortByOwnOrder,
	sort__overload$2 as sortBy,
	sort__overload$3 as sortOn,
	split__overload$1 as split,
	toString as listToString,
	viewOf,
} from "../List"
import { flatten } from "../NestedList"
import {
	firstItem,
	lastItem,
	prepend as prependContentsOf,
	replace__overload$1 as replace,
} from "../NonEmptyList"
import { equal } from "../Ordering"
import { createString } from "../String"
import { getStringRepresentation } from "../Terminal"
import { type AnyType, isValueOfType, typeKeySymbol } from "../type"

const integers = (...values: Array<number>): ListType<IntegerType> =>
	createList(values.map((value) => createInteger(BigInt(value))))

// Reads a List's items without collapsing it, since `materialise` demotes an
// upgraded box and these tests watch what a box still holds.
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

// Two items in the front run and three in the back, since a walk or a position
// gets a run boundary wrong. Fresh per call, since reading may demote it.
const upgraded = (): ListType<IntegerType> =>
	prepend(prepend(integers(3, 4, 5), createInteger(2n)), createInteger(1n))

const integerEquality = {
	is: (first: IntegerType, second: IntegerType) =>
		createBoolean(first.value === second.value),
}

const integerOrder = { compare: compareIntegers }

// The direction a `sort` call that names none is given.
const ascending = { [typeKeySymbol]: "SortOrder#Ascending" } as const

// `itemsOf` for the Arrays a build is handed.
const valuesOf = (items: Array<IntegerType>): Array<number> =>
	items.map((value) => Number(value.value))

const integerPrinting = {
	toString: (value: IntegerType) => createString(String(value.value)),
}

const integerList: common.Type = {
	type: "List",
	itemType: { type: "Integer" },
}

const stringList: common.Type = { type: "List", itemType: { type: "String" } }

describe("cross-representation reads", () => {
	// The representation is not part of the value.
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

		// The odd item out sits in the front run, so the type test must walk
		// both runs.
		let mixed = prepend(
			createList<AnyType>([createInteger(3n), createInteger(4n)]),
			createString("one"),
		)

		expect(isValueOfType(mixed, integerList)).toBeFalse()
	})
})

describe("branching at both ends", () => {
	// Four boxes over two shared runs. None may show an item another added.
	test("each box reads its own items and the receiver is unchanged", () => {
		let x = integers(1, 2)
		let y = prepend(x, createInteger(0n))
		let z = prepend(x, createInteger(9n))
		let w = append(y, createInteger(3n))

		expect(itemsOf(y)).toEqual([0, 1, 2])
		expect(itemsOf(z)).toEqual([9, 1, 2])
		expect(itemsOf(w)).toEqual([0, 1, 2, 3])
		expect(itemsOf(x)).toEqual([1, 2])

		// Asked again, since the first ask may trim a stale box under the half
		// rule.
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
	// A thousand appends share one run. Appending to a version from the middle
	// answers its items and one more, and the held version never grows.
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

		// Read again after the two tips diverged.
		expect(Number(length(held).value)).toBe(500)
	})
})

describe("reentrancy", () => {
	// The fold is seeded with the List it walks, so the first append pushes onto
	// the run being read. The walk covers the items held when it started.
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
	// A box left behind by an append holds its chain's longer Array. `materialise`
	// trims it once, stores the trimmed Array back, and hands that Array out after.
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
	// `removeFirst` and `removeLast` are written in Essence on natives held here.
	// `remove(at:)` and the other edits are held in `edits.spec.ts`.
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

		// Reading a position must not collapse the box.
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
			itemsOf(
				sortByOwnOrder(reverse(upgraded()), ascending, integerOrder),
			),
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

	// The key is read once per item, and items whose keys tie keep their order
	// in either direction.
	test("sort on a key reads each key once and keeps ties in order", () => {
		let reads = 0
		let key = (item: IntegerType) => {
			reads++

			return createInteger(Number(item.value) % 2)
		}
		let descending = { [typeKeySymbol]: "SortOrder#Descending" } as const

		expect(
			itemsOf(sortOn(upgraded(), key, ascending, integerOrder)),
		).toEqual([2, 4, 1, 3, 5])
		expect(reads).toBe(5)
		expect(
			itemsOf(sortOn(upgraded(), key, descending, integerOrder)),
		).toEqual([1, 3, 5, 2, 4])
		expect(reads).toBe(10)
		expect(
			itemsOf(sortOn(integers(), key, ascending, integerOrder)),
		).toEqual([])
		expect(reads).toBe(10)
	})

	// One walk over both runs offers the check each item once, and both halves
	// keep the receiver's order.
	test("partition offers each item to the check once, across the run boundary", () => {
		let offered: Array<number> = []
		let isEven = (item: IntegerType) => {
			offered.push(Number(item.value))

			return createBoolean(Number(item.value) % 2 === 0)
		}
		let halves = partition(upgraded(), isEven)

		expect(itemsOf(halves.accepted)).toEqual([2, 4])
		expect(itemsOf(halves.refused)).toEqual([1, 3, 5])
		expect(offered).toEqual([1, 2, 3, 4, 5])

		let empty = partition(integers(), isEven)

		expect(itemsOf(empty.accepted)).toEqual([])
		expect(itemsOf(empty.refused)).toEqual([])
	})

	// A backward walk finds the last accepted item in either run and offers the
	// check nothing after it.
	test("lastIndex(where:) walks backwards across the run boundary and stops", () => {
		let offered: Array<number> = []
		let accepting = (limit: number) => (item: IntegerType) => {
			offered.push(Number(item.value))

			return createBoolean(Number(item.value) <= limit)
		}
		let positionOf = (answer: ReturnType<typeof lastIndexWhere>) =>
			answer[typeKeySymbol] === "Optional#Empty"
				? null
				: Number(answer.item.value)

		expect(positionOf(lastIndexWhere(upgraded(), accepting(9)))).toBe(4)
		expect(offered).toEqual([5])

		offered = []
		expect(positionOf(lastIndexWhere(upgraded(), accepting(2)))).toBe(1)
		expect(offered).toEqual([5, 4, 3, 2])

		offered = []
		expect(positionOf(lastIndexWhere(upgraded(), accepting(1)))).toBe(0)
		expect(offered).toEqual([5, 4, 3, 2, 1])

		offered = []
		expect(positionOf(lastIndexWhere(upgraded(), accepting(0)))).toBeNull()
		expect(offered).toEqual([5, 4, 3, 2, 1])
		expect(positionOf(lastIndexWhere(integers(), accepting(9)))).toBeNull()
	})

	test("split and pair", () => {
		let groups = split(upgraded(), createInteger(2n))

		expect(materialise(groups).map(itemsOf)).toEqual([[1, 2], [3, 4], [5]])

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

	test("map, everyItem and both folds", () => {
		expect(
			itemsOf(map(upgraded(), (each) => product(each.value, each.value))),
		).toEqual([1, 4, 9, 16, 25])

		expect(
			itemsOf(
				everyItem(upgraded(), (each) =>
					createBoolean(Number(each.value) % 2 === 0),
				),
			),
		).toEqual([2, 4])

		let total = reduce(upgraded(), createInteger(0), (accumulator, each) =>
			sum(accumulator.value, each.value),
		)

		expect(Number(total.value)).toBe(15)

		// After a `#Done` inside the front run, the back run must not be walked.
		let visited: Array<number> = []
		let stopped = reduceWithStep(
			upgraded(),
			createInteger(0n),
			(accumulator, each) => {
				visited.push(Number(each.value))

				return each.value === 2
					? { [typeKeySymbol]: "Step#Done", value: accumulator }
					: {
							[typeKeySymbol]: "Step#Continue",
							state: sum(accumulator.value, each.value),
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
			"[1, 2, 3, 4, 5]",
		)
		expect(getStringRepresentation(upgraded())).toBe("[ 1, 2, 3, 4, 5 ]")

		// A box an append left behind still holds the item pushed for another,
		// so emptiness is decided by the view, not the Array.
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

		// A List built by prepends alone has no back run. Its last item is at
		// position zero of the front run, which is stored reversed.
		let onlyPrepended = prepend(
			prepend(createList<IntegerType>([]), createInteger(2n)),
			createInteger(1n),
		)

		expect(itemsOf(onlyPrepended)).toEqual([1, 2])
		expect(Number(firstItem(onlyPrepended).value)).toBe(1)
		expect(Number(lastItem(onlyPrepended).value)).toBe(2)
	})

	// The walk crosses the run boundary in order, and the first of every group
	// of equal items is kept.
	test("a tally's keys keep the first of every group", () => {
		let repeated = prepend(
			prepend(integers(1, 3, 2), createInteger(2n)),
			createInteger(1n),
		)

		expect(itemsOf(repeated)).toEqual([1, 2, 1, 3, 2])
		expect(
			itemsOf(
				keys(tally(repeated, integerEquality)) as ListType<IntegerType>,
			),
		).toEqual([1, 2, 3])
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
			itemsOf(
				sortByOwnOrder(reverse(upgraded()), ascending, integerOrder),
			),
		).toEqual([1, 2, 3, 4, 5])
	})
})

// A walk that builds its List in place pushes onto the Array it is handed. So
// that Array is shared with nothing, even for a trimmed view or a front run.
describe("the Array a build enters with", () => {
	test("answers the seed's logical items, flat", () => {
		expect(valuesOf(ownItemsOf(integers(1, 2, 3)))).toEqual([1, 2, 3])
		expect(valuesOf(ownItemsOf(upgraded()))).toEqual([1, 2, 3, 4, 5])
		expect(valuesOf(ownItemsOf(integers()))).toEqual([])
	})

	test("shares no Array with the seed", () => {
		let seed = integers(1, 2, 3)
		let entered = ownItemsOf(seed)

		expect(entered).not.toBe(seed.value)

		entered.push(createInteger(4n))

		expect(itemsOf(seed)).toEqual([1, 2, 3])
		expect(itemsOf(createList(entered))).toEqual([1, 2, 3, 4])
	})

	test("answers a trimmed view's items and leaves the seed as it found it", () => {
		// A view shorter than its Array, as an append beside another leaves. The
		// copy answers the view, and must not trim the seed, which would make a
		// drain quadratic.
		let seed = integers(1, 2, 3)
		let grown = append(seed, createInteger(4n))
		let entered = ownItemsOf(seed)

		expect(valuesOf(entered)).toEqual([1, 2, 3])
		expect(seed.value.length).toBe(4)
		expect(itemsOf(grown)).toEqual([1, 2, 3, 4])
	})
})

// A random chain of operations against a plain Array model. Each turn derives a
// box from one built so far, then asks every box ever built all the language
// can ask. A box is asked again after its relatives are derived, read and
// trimmed. A trim writes a fresh Array under a box whose children hold the old
// one. The seeds are pinned, so a failure can be run again.
const CHAIN_SEEDS = [
	0x115701, 0x115702, 0x115703, 0x115704, 0x115705, 0x115706, 0x115707,
	0x115708, 0x115709, 0x11570a, 0x11570b, 0x11570c,
]

// mulberry32, copied from `dictionaries.spec.ts`: no dependency, and the same
// sequence on every engine.
const seededRandom = (seed: number): (() => number) => {
	let state = seed >>> 0

	return () => {
		state = (state + 0x6d2b79f5) | 0

		let mixed = Math.imul(state ^ (state >>> 15), 1 | state)

		mixed = (mixed + Math.imul(mixed ^ (mixed >>> 7), 61 | mixed)) ^ mixed

		return ((mixed ^ (mixed >>> 14)) >>> 0) / 4294967296
	}
}

// What each operation means on a plain Array. `edits.spec.ts` keeps its own
// copy, so a change for one file can not shift what the other compares against.
const referenceSlice = (
	items: Array<number>,
	from: number,
	to: number,
): Array<number> => {
	let count = items.length
	let resolvedFrom = from < 0 ? from + count : from
	let resolvedTo = to < 0 ? to + count : to
	let start =
		resolvedFrom < 0 ? 0 : resolvedFrom > count ? count : resolvedFrom
	let end = resolvedTo < 0 ? 0 : resolvedTo > count ? count : resolvedTo

	return end <= start ? [] : items.slice(start, end)
}

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

// What the model says the box holds, and the whole of what is compared.
type Held = { list: ListType<IntegerType>; items: Array<number> }

// Asks one box all the language can ask a List. `item(at:)` is asked at every
// position and at four outside. `is` and `compare` are asked against a flat
// List, so a view read off the wrong run shows.
const expectAnswers = (held: Held): void => {
	expect(Number(length(held.list).value)).toBe(held.items.length)

	for (
		let position = -held.items.length - 2;
		position <= held.items.length + 1;
		position++
	) {
		let expected =
			position < -held.items.length || position >= held.items.length
				? null
				: held.items.at(position)

		expect(itemAt(held.list, position)).toBe(expected ?? null)
	}

	let flat = integers(...held.items)

	expect(is(held.list, flat, integerEquality).value).toBe(true)
	expect(is(flat, held.list, integerEquality).value).toBe(true)
	expect(compare(held.list, flat, integerOrder)).toEqual(equal)
	expect(
		is(held.list, integers(...held.items, 7), integerEquality).value,
	).toBe(false)
	expect(listToString(held.list, integerPrinting).value).toBe(
		`[${held.items.join(", ")}]`,
	)
	expect(getStringRepresentation(held.list)).toBe(
		getStringRepresentation(flat),
	)
}

describe("a random chain of List operations against an Array model", () => {
	// Deep enough for a box to be a window of a window of a window.
	const TURNS = 80

	// The ends, their neighbours, one past each end and one inside, in both
	// spellings of a position. The ends are where an off-by-one lives.
	const positionIn = (draw: () => number, items: Array<number>): number => {
		let count = items.length
		let candidates = [
			0,
			1,
			2,
			count - 2,
			count - 1,
			count,
			count + 1,
			Math.floor(draw() * (count + 1)),
			-1,
			-2,
			-count,
			-count - 1,
			-Math.floor(draw() * (count + 1)) - 1,
		]

		return candidates[Math.floor(draw() * candidates.length)] as number
	}

	for (let seed of CHAIN_SEEDS) {
		test(`every box a chain builds keeps answering for itself, at seed ${seed.toString(16)}`, () => {
			let draw = seededRandom(seed)
			// Twelve prepends build a front run long enough for a window to view
			// less than half of it. That fires the front half of the half rule.
			let prepended = createList<IntegerType>([])

			for (let value = 12; value >= 1; value--) {
				prepended = prepend(prepended, createInteger(BigInt(value)))
			}

			let pool: Array<Held> = [
				{ list: integers(), items: [] },
				{ list: integers(1), items: [1] },
				{ list: integers(1, 2, 3, 4, 5), items: [1, 2, 3, 4, 5] },
				{ list: upgraded(), items: [1, 2, 3, 4, 5] },
				{
					list: prepended,
					items: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12],
				},
			]

			const pick = (): Held =>
				pool[Math.floor(draw() * pool.length)] as Held

			// Each operation is written as the native and against the model. Its
			// answer joins the pool and is compared on every later turn.
			const turns: Array<() => Held> = [
				() => {
					let held = pick()
					let value = Math.floor(draw() * 20) - 5

					return {
						list: append(held.list, createInteger(BigInt(value))),
						items: [...held.items, value],
					}
				},
				() => {
					let held = pick()
					let value = Math.floor(draw() * 20) - 5

					return {
						list: prepend(held.list, createInteger(BigInt(value))),
						items: [value, ...held.items],
					}
				},
				// A fresh long front run with a window keeping a few items off its
				// far end. Built rather than drawn, since drawing rarely reaches
				// this shape, which the front half of the half rule needs.
				() => {
					let list = createList<IntegerType>([])
					let items: Array<number> = []
					let count = Math.floor(draw() * 8) + 5

					for (let value = count; value >= 1; value--) {
						list = prepend(list, createInteger(BigInt(value)))
						items.unshift(value)
					}

					let keep = Math.floor(draw() * 3) + 1

					return {
						list: slice(
							list,
							createInteger(BigInt(-keep)),
							createInteger(BigInt(count)),
						),
						items: items.slice(count - keep),
					}
				},
				() => {
					let first = pick()
					let second = pick()

					return {
						list: appendContentsOf(first.list, second.list),
						items: [...first.items, ...second.items],
					}
				},
				() => {
					let held = pick()
					let from = positionIn(draw, held.items)
					let to = positionIn(draw, held.items)

					return {
						list: slice(
							held.list,
							createInteger(BigInt(from)),
							createInteger(BigInt(to)),
						),
						items: referenceSlice(held.items, from, to),
					}
				},
				() => {
					let held = pick()
					let at = positionIn(draw, held.items)

					return {
						list: remove(held.list, createInteger(BigInt(at))),
						items: referenceRemove(held.items, at),
					}
				},
				() => {
					let held = pick()
					let at = positionIn(draw, held.items)
					let value = Math.floor(draw() * 20) - 5

					return {
						list: insert(
							held.list,
							createInteger(BigInt(value)),
							createInteger(BigInt(at)),
						),
						items: referenceInsert(held.items, value, at),
					}
				},
				() => {
					let held = pick()
					let at = positionIn(draw, held.items)
					let value = Math.floor(draw() * 20) - 5

					return held.items.length === 0
						? held
						: {
								list: replace(
									held.list,
									createInteger(BigInt(value)),
									createInteger(BigInt(at)),
								),
								items: referenceReplace(held.items, value, at),
							}
				},
				() => {
					let held = pick()

					return {
						list: map(held.list, (item) =>
							createInteger(BigInt(Number(item.value) + 1)),
						),
						items: held.items.map((item) => item + 1),
					}
				},
				() => {
					let held = pick()

					return {
						list: everyItem(held.list, (item) =>
							createBoolean(Number(item.value) % 2 === 0),
						),
						items: held.items.filter((item) => item % 2 === 0),
					}
				},
				// `lastItems(k)`: a window keeping a few items off the far end,
				// which can view less than half of a long front run.
				() => {
					let held = pick()
					let keep = Math.floor(draw() * 4) + 1

					return {
						list: slice(
							held.list,
							createInteger(BigInt(-keep)),
							createInteger(BigInt(held.items.length)),
						),
						items: held.items.slice(
							Math.max(0, held.items.length - keep),
						),
					}
				},
				() => {
					let held = pick()

					return {
						list: reverse(held.list),
						items: [...held.items].reverse(),
					}
				},
				() => {
					let held = pick()

					return {
						list: sortByOwnOrder(
							held.list,
							ascending,
							integerOrder,
						),
						items: [...held.items].sort(
							(first, second) => first - second,
						),
					}
				},
				// Both halves of the functional walk, so the chain builds shrinking
				// windows. The head is read before the tail is cut.
				() => {
					let held = pick()

					itemAt(held.list, 0)

					return {
						list: slice(
							held.list,
							createInteger(1n),
							length(held.list),
						),
						items: held.items.slice(1),
					}
				},
				() => {
					let held = pick()
					let tail = slice(
						held.list,
						createInteger(0n),
						createInteger(BigInt(held.items.length - 1)),
					)

					itemAt(held.list, -1)

					return { list: tail, items: held.items.slice(0, -1) }
				},
				() => {
					let held = pick()

					return {
						list: slice(
							held.list,
							createInteger(1n),
							createInteger(BigInt(held.items.length - 1)),
						),
						items: held.items.slice(1, -1),
					}
				},
			]

			for (let turn = 0; turn < TURNS; turn++) {
				pool.push(
					(turns[Math.floor(draw() * turns.length)] as () => Held)(),
				)

				// Every box in a drawn order, since a read may trim a box and its
				// relatives feel that.
				let order = pool.map((_, index) => index)

				for (let index = order.length - 1; index > 0; index--) {
					let other = Math.floor(draw() * (index + 1))

					;[order[index], order[other]] = [
						order[other] as number,
						order[index] as number,
					]
				}

				for (let index of order) {
					expectAnswers(pool[index] as Held)
				}
			}

			// Once more from each end, so no box is only ever asked before its
			// children are read, or only after.
			for (let held of pool) {
				expectAnswers(held)
			}

			for (let index = pool.length - 1; index >= 0; index--) {
				expectAnswers(pool[index] as Held)
			}
		})
	}
})

// A callback may edit the List being walked, and the walk must cover exactly
// the items the box viewed when it started. Trimming replaces runs under boxes,
// so it could make a walk read the wrong Array.
describe("a callback that edits the List being walked", () => {
	const shapes: Array<[string, () => ListType<IntegerType>, Array<number>]> =
		[
			["a flat box", () => integers(1, 2, 3, 4, 5), [1, 2, 3, 4, 5]],
			["an upgraded box", upgraded, [1, 2, 3, 4, 5]],
			[
				"a shared window",
				() =>
					slice(
						integers(0, 1, 2, 3, 4, 5, 6),
						createInteger(1n),
						createInteger(6n),
					),
				[1, 2, 3, 4, 5],
			],
			[
				"a stale box",
				() => {
					let seed = integers(1, 2, 3, 4, 5)

					append(seed, createInteger(9n))

					return seed
				},
				[1, 2, 3, 4, 5],
			],
		]

	for (let [name, build, items] of shapes) {
		test(`a fold over ${name} seeded with itself answers its items twice`, () => {
			let list = build()

			expect(
				itemsOf(
					reduce(list, list, (accumulator, item) =>
						append(accumulator, item),
					),
				),
			).toEqual([...items, ...items])
			expect(itemsOf(list)).toEqual(items)
		})

		test(`a map over ${name} appending to it answers its entry-time items`, () => {
			let list = build()

			expect(
				itemsOf(
					map(list, (item) => {
						append(list, item)

						return item
					}),
				),
			).toEqual(items)
			expect(itemsOf(list)).toEqual(items)
		})

		test(`a map over ${name} prepending to it answers its entry-time items`, () => {
			let list = build()

			expect(
				itemsOf(
					map(list, (item) => {
						prepend(list, item)

						return item
					}),
				),
			).toEqual(items)
			expect(itemsOf(list)).toEqual(items)
		})

		test(`a filter over ${name} slicing it answers its entry-time items`, () => {
			let list = build()

			expect(
				itemsOf(
					everyItem(list, (item) => {
						slice(list, createInteger(1n), length(list))
						itemAt(list, 0)

						return createBoolean(
							Math.abs(Number(item.value)) % 2 === 1,
						)
					}),
				),
			).toEqual(items.filter((item) => Math.abs(item) % 2 === 1))
			expect(itemsOf(list)).toEqual(items)
		})
	}
})
