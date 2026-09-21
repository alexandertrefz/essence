import { describe, expect, test } from "bun:test"

import type { common } from "@essence-lang/interfaces"

import { createBoolean } from "../Boolean"
import { keys } from "../Dictionary"
import { tally } from "../GroupedList"
import type { IntegerType } from "../Integer"
import { compare as compareIntegers, createInteger } from "../Integer"
import { anyIs } from "../internalHelpers"
import {
	append__overload$1 as append,
	append__overload$2 as appendContentsOf,
	compare,
	createList,
	hasDuplicates__overload$1 as hasDuplicates,
	insert,
	is,
	item__overload$1 as item,
	length,
	type ListType,
	map,
	materialise,
	ownItemsOf,
	prepend__overload$1 as prepend,
	reduce__overload$1 as reduce,
	remove,
	removeDuplicates__overload$1 as removeDuplicates,
	replace__overload$1 as replace,
	reverse,
	slice,
	sort__overload$1 as sort,
	toString as listToString,
	viewOf,
} from "../List"
import { firstItem, lastItem } from "../NonEmptyList"
import { createString } from "../String"
import { getStringRepresentation } from "../Terminal"
import { isValueOfType, typeKeySymbol } from "../type"

// NOTE: THE DIFFERENTIAL SPEC for positional writes. `replace` writes a run
// Array IN PLACE where it can — `listWrites.ts` holds the why — and every box
// that shares that Array is then behind on it and has to catch up before it is
// read. Nothing in the language can see any of that, and this file is what says
// so: random sequences of operations are run against a plain JavaScript Array
// that models the same values, and every answer either can give is compared.
//
// NOTE: What makes it a spec rather than a search is the fixed seeds. The same
// sequences run on every machine and in every order, so a failure here is a
// failure anybody can reproduce by its seed and nothing is ever "flaky because
// the fuzzer found something new".
//
// NOTE: Two shapes of use are what this is really for. PERSISTENT use keeps
// every value the run ever built and reads them all again at the end, forwards
// and backwards, so a box that was left behind five writes ago has to say what
// it holds. REENTRANT use runs a walk whose callback writes the very List being
// walked, which is the one way an in-place write could be seen from Essence —
// and is why the readers that hand a raw run to user code seal it.

const integers = (values: Array<number>): ListType<IntegerType> =>
	createList(values.map((value) => createInteger(BigInt(value))))

const integerEquality = {
	is: (first: IntegerType, second: IntegerType) =>
		createBoolean(first.value === second.value),
}

const integerOrder = { compare: compareIntegers }

const integerPrinting = {
	toString: (value: IntegerType) => createString(String(value.value)),
}

const ascending = { [typeKeySymbol]: "SortOrder#Ascending" } as const

const integerList: common.Type = {
	type: "List",
	itemType: { type: "Integer" },
}

const stringList: common.Type = { type: "List", itemType: { type: "String" } }

// NOTE: The items a box answers, read through the two-run walk rather than
// through `materialise`, which would demote an upgraded box — most of what is
// being held here is what a box is still holding after it has been read.
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

// NOTE: A counted generator rather than `Math.random`, so a seed names one
// sequence for good. Any small xorshift would do; what matters is that it is
// written here and never changes.
const generatorFrom = (seed: number): (() => number) => {
	let state = seed * 2654435761 + 1

	return () => {
		state ^= state << 13
		state ^= state >>> 17
		state ^= state << 5
		state >>>= 0

		return state / 4294967296
	}
}

type Tracked = { box: ListType<IntegerType>; items: Array<number> }

const trackedOf = (items: Array<number>): Tracked => ({
	box: integers(items),
	items: items.slice(),
})

// NOTE: EVERY READER A STALE BOX CAN MEET, each asked of one value and checked
// against the model. A reader is here because it reaches the items some way of
// its own: the walk and `materialise` through the sealing readers, `item(at:)`
// and the two total ones through the reader that must NOT seal, `length` and
// `slice` through the counting one, the growers through the three that read a
// box's fields raw, equality and ordering through their views, the printer, the
// two that key items through `keyEncoding`, and the type test, which walks a
// List's runs raw in the Module every Program carries.
const readers: Array<[string, (tracked: Tracked) => void]> = [
	[
		"walk",
		({ box, items }) => {
			expect(itemsOf(box)).toEqual(items)
		},
	],
	[
		"materialise",
		({ box, items }) => {
			expect(materialise(box).map((each) => Number(each.value))).toEqual(
				items,
			)
		},
	],
	[
		"ownItemsOf",
		({ box, items }) => {
			expect(ownItemsOf(box).map((each) => Number(each.value))).toEqual(
				items,
			)
		},
	],
	[
		"item(at:)",
		({ box, items }) => {
			for (let index = 0; index < items.length; index++) {
				let answer = item(box, createInteger(BigInt(index)))

				expect(answer[typeKeySymbol]).toBe("Optional#Value")
				expect(
					Number((answer as { item: IntegerType }).item.value),
				).toBe(items[index])
			}

			for (let index = 1; index <= items.length; index++) {
				let answer = item(box, createInteger(BigInt(-index)))

				expect(
					Number((answer as { item: IntegerType }).item.value),
				).toBe(items[items.length - index])
			}

			expect(
				item(box, createInteger(BigInt(items.length)))[typeKeySymbol],
			).toBe("Optional#Empty")
		},
	],
	[
		"firstItem/lastItem",
		({ box, items }) => {
			if (items.length === 0) {
				return
			}

			expect(Number(firstItem(box).value)).toBe(items[0])
			expect(Number(lastItem(box).value)).toBe(items[items.length - 1])
		},
	],
	[
		"length",
		({ box, items }) => {
			expect(Number(length(box).value)).toBe(items.length)
		},
	],
	[
		"slice",
		({ box, items }) => {
			let from = Math.floor(items.length / 3)
			let to = items.length - Math.floor(items.length / 4)
			let window = slice(
				box,
				createInteger(BigInt(from)),
				createInteger(BigInt(to)),
			)

			expect(itemsOf(window)).toEqual(items.slice(from, to))
		},
	],
	[
		"append",
		({ box, items }) => {
			expect(itemsOf(append(box, createInteger(99n)))).toEqual([
				...items,
				99,
			])
		},
	],
	[
		"append(contentsOf:)",
		({ box, items }) => {
			expect(itemsOf(appendContentsOf(box, integers([7, 8])))).toEqual([
				...items,
				7,
				8,
			])
		},
	],
	[
		"prepend",
		({ box, items }) => {
			expect(itemsOf(prepend(box, createInteger(99n)))).toEqual([
				99,
				...items,
			])
		},
	],
	[
		"equality",
		({ box, items }) => {
			expect(is(box, integers(items), integerEquality).value).toBeTrue()
			expect(anyIs(box, integers(items))).toBeTrue()
			expect(
				is(box, integers([...items, 1]), integerEquality).value,
			).toBeFalse()
		},
	],
	[
		"ordering",
		({ box, items }) => {
			expect(
				compare(box, integers(items), integerOrder)[typeKeySymbol],
			).toBe("Ordering#Equal")
		},
	],
	[
		"printing",
		({ box, items }) => {
			expect(listToString(box, integerPrinting).value).toBe(
				`[${items.join(", ")}]`,
			)
			expect(getStringRepresentation(box)).toBe(
				getStringRepresentation(integers(items)),
			)
		},
	],
	[
		"key encoding",
		({ box, items }) => {
			let distinct: Array<number> = []

			for (let each of items) {
				if (!distinct.includes(each)) {
					distinct.push(each)
				}
			}

			expect(itemsOf(removeDuplicates(box, integerEquality))).toEqual(
				distinct,
			)
			expect(hasDuplicates(box, integerEquality).value).toBe(
				distinct.length !== items.length,
			)

			expect(
				Number(length(keys(tally(box, integerEquality))).value),
			).toBe(distinct.length)
		},
	],
	[
		"type test",
		({ box, items }) => {
			expect(isValueOfType(box, integerList)).toBeTrue()
			expect(isValueOfType(box, stringList)).toBe(items.length === 0)
		},
	],
	[
		"sort",
		({ box, items }) => {
			expect(itemsOf(sort(box, ascending, integerOrder))).toEqual(
				items.slice().sort((first, second) => first - second),
			)
		},
	],
	[
		"reverse",
		({ box, items }) => {
			expect(itemsOf(reverse(box))).toEqual(items.slice().reverse())
		},
	],
]

// NOTE: EVERY EDIT THAT CAN MAKE A NEW VALUE OUT OF AN OLD ONE, including the
// three positions `replace` treats apart — inside the List, counted back from
// the end, and outside it, where the receiver is answered untouched. The
// operations that SHARE a run are what put two boxes on one Array, which is the
// only way a write in place can be seen at all, so `append`, `prepend`, `slice`
// and `remove` matter here as much as `replace` does.
const edits: Array<
	[string, (tracked: Tracked, next: () => number) => Tracked]
> = [
	[
		"replace inside",
		({ box, items }, next) => {
			if (items.length === 0) {
				return { box, items }
			}

			let position = Math.floor(next() * items.length)
			let value = Math.floor(next() * 40)
			let changed = items.slice()

			changed[position] = value

			return {
				box: replace(
					box,
					createInteger(BigInt(value)),
					createInteger(BigInt(position)),
				),
				items: changed,
			}
		},
	],
	[
		"replace from the end",
		({ box, items }, next) => {
			if (items.length === 0) {
				return { box, items }
			}

			let back = Math.floor(next() * items.length) + 1
			let value = Math.floor(next() * 40)
			let changed = items.slice()

			changed[items.length - back] = value

			return {
				box: replace(
					box,
					createInteger(BigInt(value)),
					createInteger(BigInt(-back)),
				),
				items: changed,
			}
		},
	],
	[
		"replace outside",
		({ box, items }, next) => {
			let position = next() < 0.5 ? items.length + 3 : -(items.length + 3)

			return {
				box: replace(
					box,
					createInteger(7n),
					createInteger(BigInt(position)),
				),
				items,
			}
		},
	],
	[
		"append",
		({ box, items }, next) => {
			let value = Math.floor(next() * 40)

			return {
				box: append(box, createInteger(BigInt(value))),
				items: [...items, value],
			}
		},
	],
	[
		"prepend",
		({ box, items }, next) => {
			let value = Math.floor(next() * 40)

			return {
				box: prepend(box, createInteger(BigInt(value))),
				items: [value, ...items],
			}
		},
	],
	[
		"slice",
		({ box, items }, next) => {
			let from = Math.floor(next() * (items.length + 1))
			let to = Math.floor(next() * (items.length + 1))

			return {
				box: slice(
					box,
					createInteger(BigInt(from)),
					createInteger(BigInt(to)),
				),
				items: to <= from ? [] : items.slice(from, to),
			}
		},
	],
	[
		"remove",
		({ box, items }, next) => {
			if (items.length === 0) {
				return { box, items }
			}

			let position = Math.floor(next() * items.length)
			let shorter = items.slice()

			shorter.splice(position, 1)

			return {
				box: remove(box, createInteger(BigInt(position))),
				items: shorter,
			}
		},
	],
	[
		"insert",
		({ box, items }, next) => {
			let position = Math.floor(next() * (items.length + 1))
			let value = Math.floor(next() * 40)
			let longer = items.slice()

			longer.splice(position, 0, value)

			return {
				box: insert(
					box,
					createInteger(BigInt(value)),
					createInteger(BigInt(position)),
				),
				items: longer,
			}
		},
	],
	[
		"map",
		({ box, items }) => ({
			box: map(box, (each) => createInteger(each.value)),
			items: items.slice(),
		}),
	],
	[
		"append(contentsOf:)",
		({ box, items }, next) => {
			let other = [Math.floor(next() * 40), Math.floor(next() * 40)]

			return {
				box: appendContentsOf(box, integers(other)),
				items: [...items, ...other],
			}
		},
	],
]

// NOTE: One run: a pool of values that only ever GROWS, an edit per turn on a
// value picked out of it at random, and a reader asked of a second value picked
// the same way. Nothing is ever dropped, so a value five hundred writes old is
// still in the pool at the end, and the last thing the run does is read every
// value in it — forwards, and then backwards, because catching a box up leaves
// it changed and the order a chain is read in must not matter.
const runSchedule = (seed: number, turns: number): void => {
	let next = generatorFrom(seed)
	let pool: Array<Tracked> = [
		trackedOf([1, 2, 3, 4, 5, 6, 7, 8]),
		trackedOf([]),
		trackedOf([9]),
	]

	for (let turn = 0; turn < turns; turn++) {
		let [, edit] = edits[Math.floor(next() * edits.length)]
		let chosen = pool[Math.floor(next() * pool.length)]
		let grown = edit(chosen, next)

		pool.push(grown)

		let [, read] = readers[Math.floor(next() * readers.length)]

		read(pool[Math.floor(next() * pool.length)])
	}

	for (let tracked of pool) {
		expect(itemsOf(tracked.box)).toEqual(tracked.items)
	}

	for (let index = pool.length - 1; index >= 0; index--) {
		for (let [, read] of readers) {
			read(pool[index])
		}
	}
}

describe("positional writes against a model", () => {
	// NOTE: Twelve seeds and sixty turns each, which is a few seconds and
	// covers every edit against every reader many times over. The seeds are
	// written out rather than counted, so that a failing one can be deleted
	// from the list while it is being fixed without renumbering the rest.
	for (let seed of [1, 2, 3, 5, 8, 13, 21, 34, 55, 89, 144, 233]) {
		test(`seed ${seed}`, () => {
			runSchedule(seed, 60)
		})
	}
})

describe("persistent use", () => {
	// NOTE: The plainest shape of it: one value written over and over, with
	// every version kept. Each is a box left further behind on the same Array
	// than the last, and each has to answer exactly the items it was made with.
	test("every version of a chain answers its own items", () => {
		let base = integers([0, 1, 2, 3, 4, 5, 6, 7])
		let versions: Array<Tracked> = [
			{ box: base, items: [0, 1, 2, 3, 4, 5, 6, 7] },
		]

		for (let turn = 0; turn < 20; turn++) {
			let previous = versions[versions.length - 1]
			let position = turn % 8
			let changed = previous.items.slice()

			changed[position] = 100 + turn

			versions.push({
				box: replace(
					previous.box,
					createInteger(BigInt(100 + turn)),
					createInteger(BigInt(position)),
				),
				items: changed,
			})
		}

		for (let index = versions.length - 1; index >= 0; index--) {
			expect(itemsOf(versions[index].box)).toEqual(versions[index].items)
		}

		for (let version of versions) {
			expect(itemsOf(version.box)).toEqual(version.items)
		}
	})

	// NOTE: The branching shape, which is the one an in-place write can not
	// help: the OLD value is written again and again, so every write but the
	// first finds its receiver behind and catches it up. It has to answer the
	// same thing it always did, which is the whole of what is claimed here —
	// what it costs is `optimisations` business, not this file's.
	test("writing the same old value over and over answers every time", () => {
		let base = integers([0, 1, 2, 3, 4, 5, 6, 7])

		for (let turn = 0; turn < 20; turn++) {
			let written = replace(
				base,
				createInteger(BigInt(turn)),
				createInteger(BigInt(turn % 8)),
			)
			let expected = [0, 1, 2, 3, 4, 5, 6, 7]

			expected[turn % 8] = turn

			expect(itemsOf(written)).toEqual(expected)
			expect(itemsOf(base)).toEqual([0, 1, 2, 3, 4, 5, 6, 7])
		}
	})

	// NOTE: A box that shares a run because it was GROWN from one, rather than
	// written from one — the sharing sites are where a log has to be carried
	// along, and a box handed a logged Array without one would read whatever
	// the next write left there.
	test("a box grown from a written one answers its own items", () => {
		let base = integers([0, 1, 2, 3, 4, 5, 6, 7])
		let written = replace(base, createInteger(50n), createInteger(0n))
		let appended = append(written, createInteger(60n))
		let prepended = prepend(written, createInteger(70n))
		let window = slice(written, createInteger(2n), createInteger(6n))
		let dropped = remove(written, createInteger(1n))

		replace(written, createInteger(51n), createInteger(1n))
		replace(written, createInteger(52n), createInteger(2n))

		expect(itemsOf(appended)).toEqual([50, 1, 2, 3, 4, 5, 6, 7, 60])
		expect(itemsOf(prepended)).toEqual([70, 50, 1, 2, 3, 4, 5, 6, 7])
		expect(itemsOf(window)).toEqual([2, 3, 4, 5])
		expect(itemsOf(dropped)).toEqual([50, 2, 3, 4, 5, 6, 7])
		expect(itemsOf(written)).toEqual([50, 1, 2, 3, 4, 5, 6, 7])
		expect(itemsOf(base)).toEqual([0, 1, 2, 3, 4, 5, 6, 7])
	})

	// NOTE: The grower reading a box that is BEHIND. `append` and `prepend`
	// read a box's fields without a view, so each catches its receiver up
	// itself — a box that pushed onto the Array it is behind on would hand the
	// answer items it never held.
	test("growing a box that is behind answers its items and the new one", () => {
		let base = integers([0, 1, 2, 3])

		replace(base, createInteger(9n), createInteger(0n))

		expect(itemsOf(append(base, createInteger(4n)))).toEqual([
			0, 1, 2, 3, 4,
		])

		let second = integers([0, 1, 2, 3])

		replace(second, createInteger(9n), createInteger(3n))

		expect(itemsOf(prepend(second, createInteger(-1n)))).toEqual([
			-1, 0, 1, 2, 3,
		])

		let third = integers([0, 1, 2, 3])

		replace(third, createInteger(9n), createInteger(1n))

		expect(itemsOf(appendContentsOf(third, integers([4, 5])))).toEqual([
			0, 1, 2, 3, 4, 5,
		])
	})

	// NOTE: An upgraded receiver — two runs, and a position in each. A front
	// run is never written in place, so this is the half that still copies, and
	// it has to agree with the flat half item for item.
	test("a two-run box answers a write in either run", () => {
		let built = prepend(
			prepend(integers([3, 4, 5]), createInteger(2n)),
			createInteger(1n),
		)
		let inFront = replace(built, createInteger(9n), createInteger(0n))
		let inBack = replace(built, createInteger(9n), createInteger(4n))

		expect(itemsOf(inFront)).toEqual([9, 2, 3, 4, 5])
		expect(itemsOf(inBack)).toEqual([1, 2, 3, 4, 9])
		expect(itemsOf(built)).toEqual([1, 2, 3, 4, 5])
	})
})

describe("reentrancy", () => {
	// NOTE: THE HAZARD THE SEAL IS FOR. The fold is seeded with the very List
	// it walks, so the first `replace` would write the run the walk is holding
	// — a walk fixes its counts on entry, but an item it has not reached yet
	// would be the one the callback just wrote. The reader sealed the run, so
	// the write copies and the walk answers the items the List held at entry.
	test("a fold whose callback writes the walked List sees the entry items", () => {
		let list = integers([1, 2, 3, 4, 5])
		let visited: Array<number> = []

		reduce(list, list, (accumulator, each) => {
			visited.push(Number(each.value))

			return replace(accumulator, createInteger(99n), createInteger(4n))
		})

		expect(visited).toEqual([1, 2, 3, 4, 5])
		expect(itemsOf(list)).toEqual([1, 2, 3, 4, 5])
	})

	test("a map whose transform writes the walked List sees the entry items", () => {
		let list = integers([1, 2, 3, 4, 5])
		let written = list
		let mapped = map(list, (each) => {
			written = replace(written, createInteger(99n), createInteger(4n))

			return each
		})

		expect(itemsOf(mapped)).toEqual([1, 2, 3, 4, 5])
		expect(itemsOf(list)).toEqual([1, 2, 3, 4, 5])
		expect(itemsOf(written)).toEqual([1, 2, 3, 4, 99])
	})

	// NOTE: The same hazard through the readers that do NOT trim — the
	// set-shaped natives ask an item's own witness about every item while they
	// hold the run, and a witness is user code.
	test("a witness that writes the walked List sees the entry items", () => {
		let list = integers([1, 2, 3, 2, 1])
		let written = list
		let writingEquality = {
			is: (first: IntegerType, second: IntegerType) => {
				written = replace(
					written,
					createInteger(99n),
					createInteger(0n),
				)

				return createBoolean(first.value === second.value)
			},
		}

		expect(itemsOf(removeDuplicates(list, writingEquality))).toEqual([
			1, 2, 3,
		])
		expect(itemsOf(list)).toEqual([1, 2, 3, 2, 1])
		expect(itemsOf(written)).toEqual([99, 2, 3, 2, 1])
	})

	// NOTE: And through the one that hands its OWN Array over — `sort(on:)`
	// reads a key off every item while holding it, and the Rewriter's inlined
	// walks read their items the same way.
	test("a comparison that writes the sorted List sees the entry items", () => {
		let list = integers([5, 3, 1, 4, 2])
		let written = list
		let writingOrder = {
			compare: (first: IntegerType, second: IntegerType) => {
				written = replace(
					written,
					createInteger(99n),
					createInteger(0n),
				)

				return compareIntegers(first, second)
			},
		}

		expect(itemsOf(sort(list, ascending, writingOrder))).toEqual([
			1, 2, 3, 4, 5,
		])
		expect(itemsOf(list)).toEqual([5, 3, 1, 4, 2])
		expect(itemsOf(written)).toEqual([99, 3, 1, 4, 2])
	})
})

describe("what a write actually costs", () => {
	// NOTE: THE CLAIM THE WHOLE CHANGE IS FOR, made as WORK rather than as
	// time: filling a List cell by cell must not copy the List per cell. The
	// Array a box holds is what says so — a copy is a new one — so counting the
	// DISTINCT Arrays a chain passes through counts the copies it made. One for
	// the first write, which mints the log, and one more when the log grows
	// longer than the run and the next write starts a fresh one. Before this,
	// every turn made its own: two thousand of them for two thousand cells.
	test("filling a List cell by cell makes a handful of Arrays, not one per cell", () => {
		for (let size of [500, 1_000, 2_000]) {
			let cells = createList(
				Array.from({ length: size }, () => createInteger(0n)),
			)
			let seen = new Set<Array<IntegerType>>()

			for (let index = 0; index < size; index++) {
				cells = replace(
					cells,
					createInteger(BigInt(index)),
					createInteger(BigInt(index)),
				)
				seen.add(cells.value)
			}

			expect(seen.size).toBeLessThanOrEqual(3)
			expect(itemsOf(cells)).toEqual(
				Array.from({ length: size }, (_, index) => index),
			)
		}
	})

	// NOTE: And the other half of it — reading a cell must not close the run to
	// writes, or "read the cell before, write this one" would copy per turn.
	// A DP table is exactly that, and it makes no more Arrays than the fill
	// above does.
	test("reading a cell between writes does not put the copy back", () => {
		let size = 1_000
		let cells = createList(
			Array.from({ length: size }, () => createInteger(0n)),
		)
		let seen = new Set<Array<IntegerType>>()

		for (let index = 1; index < size; index++) {
			let before = item(cells, createInteger(BigInt(index - 1)))
			let carried = (before as { item: IntegerType }).item

			cells = replace(
				cells,
				createInteger(BigInt(Number(carried.value) + 1)),
				createInteger(BigInt(index)),
			)
			seen.add(cells.value)
		}

		expect(seen.size).toBeLessThanOrEqual(3)
		expect(Number(lastItem(cells).value)).toBe(size - 1)
	})

	// NOTE: The log is BOUNDED, so what a chain holds stays proportional to the
	// List: writing many times over a short List must not grow a log longer
	// than the run. Past the bound a write copies and starts a fresh log, which
	// is what keeps the memory bounded and the work per write constant.
	test("a log never grows longer than the run it belongs to", () => {
		let cells = createList(
			Array.from({ length: 16 }, () => createInteger(0n)),
		)

		for (let turn = 0; turn < 500; turn++) {
			cells = replace(
				cells,
				createInteger(BigInt(turn)),
				createInteger(BigInt(turn % 16)),
			)

			let writes = cells.writes

			if (writes !== undefined) {
				expect(writes.log.positions.length).toBeLessThanOrEqual(16)
			}
		}

		expect(Number(lastItem(cells).value)).toBe(495)
	})
})
