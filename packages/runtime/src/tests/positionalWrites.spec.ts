import { describe, expect, test } from "bun:test"

import type { common } from "@essence-lang/interfaces"

import type { BooleanType } from "../Boolean"
import { createBoolean } from "../Boolean"
import {
	type EntryRecord,
	keys,
	of__overload$1 as dictionaryOf,
} from "../Dictionary"
import { group, index as indexOn, tally } from "../GroupedList"
import type { IntegerType } from "../Integer"
import { compare as compareIntegers, createInteger } from "../Integer"
import { anyIs, boundChoiceIs } from "../internalHelpers"
import {
	accumulate,
	append__overload$1 as append,
	append__overload$2 as appendContentsOf,
	compare,
	contains__overload$2 as contains,
	createList,
	everyItem__overload$1 as everyItem,
	everyItem__overload$2 as everyItemIn,
	hasDuplicates__overload$1 as hasDuplicates,
	hasDuplicates__overload$2 as hasDuplicatesOn,
	insert,
	is,
	isSorted,
	item__overload$1 as item,
	join,
	lastIndex__overload$3 as lastIndexWhere,
	length,
	type ListType,
	map,
	materialise,
	ownItemsOf,
	partition__overload$1 as partition,
	prepend__overload$1 as prepend,
	reduce__overload$1 as reduce,
	reduce__overload$2 as reduceWithStep,
	remove,
	removeDuplicates__overload$1 as removeDuplicates,
	removeDuplicates__overload$2 as removeDuplicatesOn,
	removeEvery__overload$3 as removeEveryIn,
	replace__overload$1 as replace,
	reverse,
	runs as runsWhere,
	slice,
	sort__overload$1 as sort,
	sort__overload$2 as sortBy,
	sort__overload$3 as sortOn,
	split__overload$3 as splitWhere,
	toString as listToString,
	viewOf,
} from "../List"
import { firstItem, lastItem } from "../NonEmptyList"
import type { OrderingType } from "../Ordering"
import { createRecord } from "../Record"
import { createString } from "../String"
import { getStringRepresentation } from "../Terminal"
import { type AnyType, isValueOfType, typeKeySymbol } from "../type"

// `replace` writes a run Array in place where it can, and every box sharing it
// must catch up before it is read. Random operations over fixed seeds run
// against a plain Array model. Every value is read again at the end, and walks
// whose callbacks write the walked List check the seals. See "The List write
// log" in packages/runtime/DEVELOPMENT.md.

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

// A generic Choice's derived `Equatable` hands each item of a List member to
// the witness, which is user code, while both runs are held.
const choiceHoldingListIs = boundChoiceIs({
	"Held#Items": { items: { k: "list", of: { k: "w", i: 0 } } },
})

const holding = (items: ListType<IntegerType>) =>
	({ [typeKeySymbol]: "Held#Items", items }) as never

// Reports the second Argument: a key scan calls `is(storedKey, key)`, and only
// the item just reached can show a write still ahead.
function visitingKey(visit: (item: IntegerType) => void) {
	return {
		is: (first: IntegerType, second: IntegerType) => (
			visit(second),
			createBoolean(first.value === second.value)
		),
	}
}

// A Type Parameter's witness is declared over `AnyType`, so the casts stand
// for a Program that bound it to Integer.
const holdingWitness = (visit: (item: IntegerType) => void) => ({
	is: (first: AnyType, second: AnyType) => (
		visit(second as IntegerType),
		createBoolean(
			(first as IntegerType).value === (second as IntegerType).value,
		)
	),
})

const integerList: common.Type = {
	type: "List",
	itemType: { type: "Integer" },
}

const stringList: common.Type = { type: "List", itemType: { type: "String" } }

// Reads a box's items without `materialise`, which would demote an upgraded
// box.
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

// A fixed xorshift rather than `Math.random`, so a seed names one sequence for
// good.
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

// A box that already carries a log. The first write on a bare Array copies and
// gives the copy a log, so rewriting the first item mints one and changes
// nothing.
const logged = (values: Array<number>): ListType<IntegerType> => {
	let fresh = integers(values)
	let first = values.length === 0 ? 0 : values[0]
	let minted = replace(fresh, createInteger(BigInt(first)), createInteger(0n))

	expect(minted.writes).toBeDefined()

	return minted
}

// Writes in place, so every other box on the run goes stale, the receiver
// included.
const written = (
	box: ListType<IntegerType>,
	value: number,
	position: number,
): ListType<IntegerType> =>
	replace(box, createInteger(BigInt(value)), createInteger(BigInt(position)))

type Tracked = { box: ListType<IntegerType>; items: Array<number> }

const trackedOf = (items: Array<number>): Tracked => ({
	box: integers(items),
	items: items.slice(),
})

// Every reader a stale box can meet, each reaching the items its own way, and
// each checked against the model.
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

type ComparisonWitness = {
	is: (first: IntegerType, second: IntegerType) => BooleanType
	compare: (first: IntegerType, second: IntegerType) => OrderingType
}

// Whether a comparison says the two hold the same items: `Equal` or `true`.
const saysEqual = (answer: AnyType): boolean =>
	answer[typeKeySymbol] === "Ordering#Equal" ||
	(answer as unknown as BooleanType).value === true

// A comparison against a freshly logged twin, the only state in which a missing
// seal shows: the witness writes the Array being read. The twin holds the
// receiver's items and is written past position 0, so `Equal` is owed and only
// the answer can be corrupted.
function comparedAgainstATwin(
	comparing: (
		first: ListType<IntegerType>,
		second: ListType<IntegerType>,
		conformance: ComparisonWitness,
	) => AnyType,
): (tracked: Tracked, next: () => number) => Tracked {
	return ({ box, items }, next) => {
		if (items.length < 2) {
			return { box, items }
		}

		let twin = logged(items)
		let position = 1 + Math.floor(next() * (items.length - 1))
		let value = Math.floor(next() * 40)
		let latest = twin
		let changed = items.slice()
		let meddle = () => {
			latest = written(latest, value, position)
		}

		changed[position] = value

		let answer = comparing(box, twin, {
			is: (first, second) => (
				meddle(),
				createBoolean(first.value === second.value)
			),
			compare: (first, second) => (
				meddle(),
				compareIntegers(first, second)
			),
		})

		expect(saysEqual(answer)).toBe(true)
		expect(itemsOf(twin)).toEqual(items)

		return { box: latest, items: changed }
	}
}

// Every edit that makes a new value from an old one. The sharing edits put two
// boxes on one Array, which is how an in-place write could be seen. The
// comparisons at the end leave their twin in the pool.
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
	["is against a freshly logged twin", comparedAgainstATwin(is)],
	["compare against a freshly logged twin", comparedAgainstATwin(compare)],
	[
		"a generic Choice's derived is against a freshly logged twin",
		comparedAgainstATwin((first, second, conformance) =>
			choiceHoldingListIs(
				holding(first),
				holding(second),
				conformance as never,
			),
		),
	],
]

// A pool that only grows: each turn edits one random value and reads another.
// At the end every value is read forwards and then backwards, since catching a
// box up changes it.
const runSchedule = (seed: number, turns: number): void => {
	let next = generatorFrom(seed)
	let pool: Array<Tracked> = [
		{
			box: logged([1, 2, 3, 4, 5, 6, 7, 8]),
			items: [1, 2, 3, 4, 5, 6, 7, 8],
		},
		trackedOf([1, 2, 3, 4, 5, 6, 7, 8]),
		trackedOf([]),
		trackedOf([9]),
	]

	for (let turn = 0; turn < turns; turn++) {
		let [, edit] = edits[Math.floor(next() * edits.length)]
		let chosen = pool[Math.floor(next() * pool.length)]
		let grown = edit(chosen, next)

		pool.push(grown)

		// A box falls behind only when its run is written in place, which needs a
		// log. So each turn derives from the new value, writes it, and then reads
		// the derivatives.
		let derived: Array<Tracked> = []

		for (let share = 0; share < 3; share++) {
			let [, deriving] = edits[Math.floor(next() * edits.length)]

			derived.push(deriving(grown, next))
		}

		let latest = grown

		for (let write = 0; write < 3; write++) {
			if (latest.items.length === 0) {
				break
			}

			let [, writing] = edits[Math.floor(next() * 2)]

			latest = writing(latest, next)
		}

		pool.push(latest)

		for (let each of derived) {
			pool.push(each)
			expect(itemsOf(each.box)).toEqual(each.items)
		}

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
	// The seeds are written out, so a failing one can be removed while it is
	// fixed without renumbering the rest.
	for (let seed of [1, 2, 3, 5, 8, 13, 21, 34, 55, 89, 144, 233]) {
		test(`seed ${seed}`, () => {
			runSchedule(seed, 60)
		})
	}
})

describe("persistent use", () => {
	// Positions repeat, so one log holds a position more than once, which tells
	// undoing the log backwards from undoing it forwards.
	test("every version of a chain answers its own items", () => {
		let versions: Array<Tracked> = [
			{
				box: logged([0, 1, 2, 3, 4, 5, 6, 7]),
				items: [0, 1, 2, 3, 4, 5, 6, 7],
			},
		]

		for (let turn = 0; turn < 24; turn++) {
			let previous = versions[versions.length - 1]
			let position = turn % 3
			let changed = previous.items.slice()

			changed[position] = 100 + turn

			versions.push({
				box: written(previous.box, 100 + turn, position),
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

	// Every write after the first finds its receiver behind and catches it up.
	test("writing the same old value over and over answers every time", () => {
		let base = logged([0, 1, 2, 3, 4, 5, 6, 7])

		for (let turn = 0; turn < 20; turn++) {
			let changed = written(base, turn, turn % 8)
			let expected = [0, 1, 2, 3, 4, 5, 6, 7]

			expected[turn % 8] = turn

			expect(itemsOf(changed)).toEqual(expected)
			expect(itemsOf(base)).toEqual([0, 1, 2, 3, 4, 5, 6, 7])
		}
	})

	// Every operation that shares a back run must hand the box the log version it
	// views. The source is written after the box is derived and before it is
	// read, the order in which a forgotten log shows.
	const sharers: Array<
		[
			string,
			(
				source: ListType<IntegerType>,
			) => [ListType<IntegerType>, Array<number>],
		]
	> = [
		[
			"append",
			(source) => [
				append(source, createInteger(60n)),
				[0, 1, 2, 3, 4, 5, 6, 7, 60],
			],
		],
		[
			"append(contentsOf:)",
			(source) => [
				appendContentsOf(source, integers([60, 61])),
				[0, 1, 2, 3, 4, 5, 6, 7, 60, 61],
			],
		],
		[
			"prepend onto a flat box",
			(source) => [
				prepend(source, createInteger(70n)),
				[70, 0, 1, 2, 3, 4, 5, 6, 7],
			],
		],
		[
			"prepend twice",
			(source) => [
				prepend(
					prepend(source, createInteger(70n)),
					createInteger(71n),
				),
				[71, 70, 0, 1, 2, 3, 4, 5, 6, 7],
			],
		],
		[
			"a window at the front",
			(source) => [
				slice(source, createInteger(0n), createInteger(6n)),
				[0, 1, 2, 3, 4, 5],
			],
		],
		[
			"dropping the last item",
			(source) => [
				remove(source, createInteger(7n)),
				[0, 1, 2, 3, 4, 5, 6],
			],
		],
		[
			"a window of a two-run box",
			(source) => [
				slice(
					prepend(source, createInteger(70n)),
					createInteger(0n),
					createInteger(5n),
				),
				[70, 0, 1, 2, 3],
			],
		],
		[
			"writing the front of a two-run box",
			(source) => [
				written(prepend(source, createInteger(70n)), 99, 0),
				[99, 0, 1, 2, 3, 4, 5, 6, 7],
			],
		],
	]

	for (let [label, share] of sharers) {
		test(`${label} carries the log it shares`, () => {
			let source = logged([0, 1, 2, 3, 4, 5, 6, 7])
			let [derived, expected] = share(source)

			// Three writes, so a log undone the wrong way round answers the wrong
			// items.
			let once = written(source, 91, 1)
			let twice = written(once, 92, 2)

			written(twice, 93, 1)

			expect(itemsOf(derived)).toEqual(expected)
			expect(itemsOf(source)).toEqual([0, 1, 2, 3, 4, 5, 6, 7])
		})
	}

	// `append` and `prepend` read a box's fields without a view, so each catches
	// its receiver up itself.
	test("growing a box that is behind answers its items and the new one", () => {
		let stale = () => {
			let base = logged([0, 1, 2, 3])

			written(base, 9, 0)

			expect(base.writes?.seen).not.toBe(base.writes?.log.version)

			return base
		}

		expect(itemsOf(append(stale(), createInteger(4n)))).toEqual([
			0, 1, 2, 3, 4,
		])
		expect(itemsOf(prepend(stale(), createInteger(-1n)))).toEqual([
			-1, 0, 1, 2, 3,
		])
		expect(itemsOf(appendContentsOf(stale(), integers([4, 5])))).toEqual([
			0, 1, 2, 3, 4, 5,
		])
		expect(itemsOf(written(stale(), 8, 3))).toEqual([0, 1, 2, 8])
		expect(Number(length(stale()).value)).toBe(4)
	})

	// `prepend` hands the answer the receiver's `writes`, so a stale answer would
	// repair itself when read. Catching up first lets the two share one repaired
	// Array.
	test("prepending to a box that is behind repairs the run once, not twice", () => {
		let source = logged([0, 1, 2, 3, 4])
		let ahead = written(source, 91, 1)

		written(ahead, 92, 3)

		let answer = prepend(source, createInteger(-1n))
		let arrays = new Set<Array<IntegerType>>()

		expect(itemsOf(answer)).toEqual([-1, 0, 1, 2, 3, 4])
		expect(itemsOf(source)).toEqual([0, 1, 2, 3, 4])

		arrays.add(answer.value)
		arrays.add(source.value)

		expect(arrays.size).toBe(1)
	})

	// Cutting an interior window rebuilds both runs as fresh Arrays, so the
	// receiver drops its log. Otherwise its writes would tell boxes on the old
	// Array to undo positions in another. Six of eight items, since only a window
	// of three quarters or more moves the seam.
	test("a box whose seam moves lets go of the log it was carrying", () => {
		let source = logged([0, 1, 2, 3, 4, 5, 6, 7])
		let derived = append(source, createInteger(60n))
		let interior = slice(source, createInteger(1n), createInteger(7n))

		expect(source.front).toBeDefined()
		expect(source.writes).toBeUndefined()

		let once = written(source, 91, 1)

		written(once, 92, 2)

		expect(itemsOf(derived)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 60])
		expect(itemsOf(interior)).toEqual([1, 2, 3, 4, 5, 6])
		expect(itemsOf(source)).toEqual([0, 1, 2, 3, 4, 5, 6, 7])
	})

	// A front run is never written in place, so a front write copies.
	test("a two-run box answers a write in either run", () => {
		let built = prepend(
			prepend(logged([3, 4, 5]), createInteger(2n)),
			createInteger(1n),
		)
		let inFront = written(built, 9, 0)
		let inBack = written(built, 9, 4)

		expect(itemsOf(inFront)).toEqual([9, 2, 3, 4, 5])
		expect(itemsOf(inBack)).toEqual([1, 2, 3, 4, 9])
		expect(itemsOf(built)).toEqual([1, 2, 3, 4, 5])
	})
})

describe("reentrancy", () => {
	// Each walk runs over a List current for its log, with a callback writing that
	// List. Without the seal the write would land in the Array the walk holds. A
	// native that takes a Function or a conformance and reads its receiver belongs
	// here. `mode` runs no user code, and `Dictionary.of(_:)` has its own test.
	const walks: Array<
		[
			string,
			(
				list: ListType<IntegerType>,
				visit: (item: IntegerType) => void,
			) => void,
		]
	> = [
		["map", (list, visit) => void map(list, (item) => (visit(item), item))],
		[
			"reduce",
			(list, visit) =>
				void reduce(
					list,
					list,
					(accumulator, item) => (visit(item), accumulator),
				),
		],
		[
			"reduce(step:)",
			(list, visit) =>
				void reduceWithStep(list, list, (accumulator, item) => {
					visit(item)

					return {
						[typeKeySymbol]: "Step#Continue",
						state: accumulator,
					}
				}),
		],
		[
			"accumulate",
			(list, visit) =>
				void accumulate(
					list,
					list,
					(accumulator, item) => (visit(item), accumulator),
				),
		],
		[
			"everyItem(where:)",
			(list, visit) =>
				void everyItem(
					list,
					(item) => (visit(item), createBoolean(true)),
				),
		],
		[
			"partition",
			(list, visit) =>
				void partition(
					list,
					(item) => (visit(item), createBoolean(true)),
				),
		],
		[
			"lastIndex(where:)",
			(list, visit) =>
				void lastIndexWhere(
					list,
					(item) => (visit(item), createBoolean(false)),
				),
		],
		[
			"split(where:)",
			(list, visit) =>
				void splitWhere(
					list,
					(item) => (visit(item), createBoolean(false)),
				),
		],
		[
			"runs(where:)",
			(list, visit) =>
				void runsWhere(
					list,
					(item) => (visit(item), createBoolean(true)),
				),
		],
		[
			"is",
			(list, visit) =>
				void is(list, list, {
					is: (first: IntegerType, second: IntegerType) => (
						visit(first),
						createBoolean(first.value === second.value)
					),
				}),
		],
		[
			"compare",
			(list, visit) =>
				void compare(list, list, {
					compare: (first: IntegerType, second: IntegerType) => (
						visit(first),
						compareIntegers(first, second)
					),
				}),
		],
		// The second of the pair is the item the walk has just reached.
		[
			"isSorted",
			(list, visit) =>
				void isSorted(list, ascending, {
					compare: (first: IntegerType, second: IntegerType) => (
						visit(second),
						compareIntegers(first, second)
					),
				}),
		],
		[
			"join",
			(list, visit) =>
				void join(list, createString(","), {
					toString: (value: IntegerType) => (
						visit(value),
						createString(String(value.value))
					),
				}),
		],
		[
			"toString",
			(list, visit) =>
				void listToString(list, {
					toString: (value: IntegerType) => (
						visit(value),
						createString(String(value.value))
					),
				}),
		],
		// `sort(in:)` and `sort(by:)` compare a copy of the run and hold without
		// the seal, but every native taking a comparison is listed.
		[
			"sort(in:)",
			(list, visit) =>
				void sort(list, ascending, {
					compare: (first: IntegerType, second: IntegerType) => (
						visit(first),
						compareIntegers(first, second)
					),
				}),
		],
		[
			"sort(by:)",
			(list, visit) =>
				void sortBy(
					list,
					(first, second) => (
						visit(first),
						compareIntegers(first, second)
					),
				),
		],
		[
			"sort(on:)",
			(list, visit) =>
				void sortOn(list, (item) => (visit(item), item), ascending, {
					compare: compareIntegers,
				}),
		],
		[
			"removeDuplicates",
			(list, visit) => void removeDuplicates(list, visitingKey(visit)),
		],
		[
			"removeDuplicates(on:)",
			(list, visit) =>
				void removeDuplicatesOn(
					list,
					(item) => (visit(item), item),
					integerEquality,
				),
		],
		[
			"hasDuplicates",
			(list, visit) => void hasDuplicates(list, visitingKey(visit)),
		],
		[
			"hasDuplicates(on:)",
			(list, visit) =>
				void hasDuplicatesOn(
					list,
					(item) => (visit(item), item),
					integerEquality,
				),
		],
		// A one-item argument, whose key set is built without asking the
		// witness, so the first write comes from inside the receiver's walk.
		[
			"everyItem(alsoIn:)",
			(list, visit) =>
				void everyItemIn(list, integers([1]), visitingKey(visit)),
		],
		[
			"removeEvery(contentsOf:)",
			(list, visit) =>
				void removeEveryIn(list, integers([1]), visitingKey(visit)),
		],
		[
			"contains(everyItemOf:)",
			(list, visit) => void contains(list, list, visitingKey(visit)),
		],
		[
			"group(on:)",
			(list, visit) =>
				void group(
					list,
					(item) => (visit(item), item),
					integerEquality,
				),
		],
		[
			"index(on:)",
			(list, visit) =>
				void indexOn(
					list,
					(item) => (visit(item), item),
					integerEquality,
				),
		],
		["tally", (list, visit) => void tally(list, visitingKey(visit))],
	]

	for (let [label, walk] of walks) {
		test(`${label} over a List its callback writes sees the entry items`, () => {
			let list = logged([1, 2, 3, 4, 5])
			let latest = list
			let visited: Array<number> = []

			walk(list, (item) => {
				visited.push(Number(item.value))
				// Both ends, so a walk that runs backwards, as
				// `lastIndex(where:)` does, still has a write ahead of it.
				latest = written(written(latest, 99, 0), 99, 4)
			})

			expect(visited.length).toBeGreaterThan(0)

			for (let seen of visited) {
				expect([1, 2, 3, 4, 5]).toContain(seen)
			}

			expect(itemsOf(list)).toEqual([1, 2, 3, 4, 5])
			expect(itemsOf(latest)).toEqual([99, 2, 3, 4, 99])
		})
	}

	// The key witness reports the key the walk has just reached and
	// replaces the last entry, so an unsealed walk would file the key 99.
	test("Dictionary.of(_:) over entries its key witness writes answers the entry keys", () => {
		let entry = (key: number) =>
			createRecord({
				key: createInteger(BigInt(key)),
				value: createInteger(0n),
			}) as EntryRecord<IntegerType, IntegerType>
		let keysOf = (
			entries: ListType<EntryRecord<IntegerType, IntegerType>>,
		) => ownItemsOf(entries).map((each) => Number(each.key.value))
		let entries = replace(
			createList([1, 2, 3, 4, 5].map(entry)),
			entry(1),
			createInteger(0n),
		)
		let latest = entries
		let visited: Array<number> = []

		expect(entries.writes).toBeDefined()

		let answer = dictionaryOf(
			entries,
			visitingKey((key) => {
				visited.push(Number(key.value))
				latest = replace(latest, entry(99), createInteger(4n))
			}),
		)

		expect(itemsOf(keys(answer))).toEqual([1, 2, 3, 4, 5])
		expect(visited.length).toBeGreaterThan(0)

		for (let seen of visited) {
			expect([1, 2, 3, 4, 5]).toContain(seen)
		}

		expect(keysOf(entries)).toEqual([1, 2, 3, 4, 5])
		expect(keysOf(latest)).toEqual([1, 2, 3, 4, 99])
	})

	// A native may also hold a second List's raw run across user code. The
	// `walks` table passes one box as both operands, so the receiver's seal
	// covers the argument. Each entry here gets a distinct argument, logged and
	// never read, which its callback writes. Reading it first would seal it for
	// good. A missing seal shows only in the answer, which each entry states.
	const argumentWalks: Array<
		[
			string,
			(
				list: ListType<IntegerType>,
				other: ListType<IntegerType>,
				visit: (item: IntegerType) => void,
			) => unknown,
			unknown,
		]
	> = [
		[
			"is",
			(list, other, visit) =>
				is(list, other, {
					is: (first: IntegerType, second: IntegerType) => (
						visit(second),
						createBoolean(first.value === second.value)
					),
				}).value,
			true,
		],
		[
			"compare",
			(list, other, visit) =>
				compare(list, other, {
					compare: (first: IntegerType, second: IntegerType) => (
						visit(second),
						compareIntegers(first, second)
					),
				})[typeKeySymbol],
			"Ordering#Equal",
		],
		[
			"contains(everyItemOf:)",
			(list, other, visit) =>
				contains(list, other, visitingKey(visit)).value,
			true,
		],
		[
			"everyItem(alsoIn:)",
			(list, other, visit) =>
				itemsOf(everyItemIn(list, other, visitingKey(visit))),
			[1, 2, 3, 4, 5],
		],
		[
			"removeEvery(contentsOf:)",
			(list, other, visit) =>
				itemsOf(removeEveryIn(list, other, visitingKey(visit))),
			[],
		],
		[
			"a generic Choice's derived is",
			(list, other, visit) =>
				choiceHoldingListIs(
					holding(list),
					holding(other),
					holdingWitness(visit),
				).value,
			true,
		],
	]

	for (let [label, walk, owed] of argumentWalks) {
		test(`${label} over an argument its callback writes answers about the entry items`, () => {
			let list = logged([1, 2, 3, 4, 5])
			let other = logged([1, 2, 3, 4, 5])
			let latest = other
			let visited: Array<number> = []

			let answer = walk(list, other, (item) => {
				visited.push(Number(item.value))
				latest = written(latest, 99, 4)
			})

			expect(answer).toEqual(owed)
			expect(visited.length).toBeGreaterThan(0)

			for (let seen of visited) {
				expect([1, 2, 3, 4, 5]).toContain(seen)
			}

			expect(itemsOf(list)).toEqual([1, 2, 3, 4, 5])
			expect(itemsOf(other)).toEqual([1, 2, 3, 4, 5])
			expect(itemsOf(latest)).toEqual([1, 2, 3, 4, 99])
		})
	}

	// The accumulator is the walked box, so its first write would land in the
	// run being read.
	test("a fold seeded with the List it walks answers the entry items", () => {
		let list = logged([1, 2, 3, 4, 5])
		let visited: Array<number> = []

		let answer = reduce(list, list, (accumulator, each) => {
			visited.push(Number(each.value))

			return written(accumulator, 99, 4)
		})

		expect(visited).toEqual([1, 2, 3, 4, 5])
		expect(itemsOf(list)).toEqual([1, 2, 3, 4, 5])
		expect(itemsOf(answer)).toEqual([1, 2, 3, 4, 99])
	})
})

describe("what a write actually costs", () => {
	// Each distinct Array is a copy. The first write mints the log, and a write
	// after the log outgrows the run starts a fresh one.
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

	// Reading a cell must not close the run to writes, or a table that reads the
	// previous cell before each write would copy per turn.
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

	// Past the run's length a write copies and starts a fresh log, which keeps
	// the memory bounded and the work per write constant.
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
