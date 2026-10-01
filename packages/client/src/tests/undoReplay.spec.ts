import { describe, expect, it } from "bun:test"

import type { IntegerType } from "@essence-lang/runtime/Integer"
import { createInteger } from "@essence-lang/runtime/Integer"
import {
	append__overload$1 as append,
	createList,
	type ListType,
	materialise,
	prepend__overload$1 as prepend,
	replace__overload$1 as replace,
	slice,
} from "@essence-lang/runtime/List"

import { backRunSeenBy as marshallerReplay } from "../marshal-runtime"
import { backRunSeenBy as benchReplay } from "../tools/bench"

// The interpreter and `tools/bench.ts` each copy the runtime's `caughtUp`,
// read-only. This spec reads random stale boxes through each copy and compares
// the runtime's answer. See "List boxes" in DEVELOPMENT.md.
const integer = (value: number) => createInteger(BigInt(value))

const integers = (values: Array<number>): ListType<IntegerType> =>
	createList(values.map(integer))

// A seeded generator, as in `positionalWrites.spec.ts`, so a seed names one
// schedule for good.
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

// What the runtime says the box holds, through `materialise`.
const runtimeItems = (box: ListType<IntegerType>): Array<number> =>
	materialise(box).map((each) => Number(each.value))

// What a copy says. It answers the back run, so the front run, which no
// positional write touches, is walked here as each caller walks it.
const itemsThrough = (
	replay: (box: never) => Array<unknown>,
	box: ListType<IntegerType>,
): Array<number> => {
	let back = replay(box as never)
	let backCount = box.length ?? box.value.length
	let front = box.front ?? []
	let frontCount = box.frontLen ?? front.length
	let items: Array<number> = []

	for (let index = frontCount - 1; index >= 0; index--) {
		items.push(Number((front[index] as IntegerType).value))
	}

	for (let index = 0; index < backCount; index++) {
		items.push(Number((back[index] as IntegerType).value))
	}

	return items
}

// Stale boxes built at random. They include versions and windows of one
// written run, boxes with a front run, and siblings made by a push.
const staleBoxesFrom = (seed: number): Array<ListType<IntegerType>> => {
	let next = generatorFrom(seed)
	let size = 6 + Math.floor(next() * 10)
	let items = Array.from({ length: size }, (_, index) => index)
	let kept: Array<ListType<IntegerType>> = []
	let latest = integers(items)

	// The first write copies, so every box kept from here shares one Array.
	latest = replace(latest, integer(items[0]!), integer(0))
	kept.push(latest)

	for (let turn = 0; turn < 12; turn++) {
		let choice = Math.floor(next() * 6)
		let position = Math.floor(next() * size)
		let value = 100 + turn

		if (choice === 0) {
			kept.push(prepend(latest, integer(900 + turn)))
		} else if (choice === 1) {
			kept.push(append(latest, integer(800 + turn)))
		} else if (choice === 2) {
			let from = Math.floor(next() * size)
			let to = from + 1 + Math.floor(next() * (size - from))

			kept.push(slice(latest, integer(from), integer(to)))
		} else {
			latest = replace(latest, integer(value), integer(position))
			kept.push(latest)
		}
	}

	return kept
}

const copies: Array<[string, (box: never) => Array<unknown>]> = [
	[
		"the marshalling boundary",
		marshallerReplay as (box: never) => Array<unknown>,
	],
	[
		"the hand-built door in tools/bench.ts",
		benchReplay as (box: never) => Array<unknown>,
	],
]

describe("the client's copies of the undo replay", () => {
	for (let [name, replay] of copies) {
		// Seeds written out, so a failing one can be pulled without
		// renumbering the rest.
		for (let seed of [1, 2, 3, 5, 8, 13, 21, 34, 55, 89, 144, 233]) {
			it(`${name} answers what the runtime answers, seed ${seed}`, () => {
				// The copy first, since the runtime repairs a box it reads,
				// and a broken replay would pass on a current box.
				for (let box of staleBoxesFrom(seed)) {
					let shown = itemsThrough(replay, box)

					expect(shown).toEqual(runtimeItems(box))
				}
			})
		}

		// One run with three versions, every version still held.
		it(`${name} answers each version of one written run`, () => {
			let first = replace(
				integers([0, 1, 2, 3, 4]),
				integer(0),
				integer(0),
			)
			let second = replace(first, integer(91), integer(1))
			let third = replace(second, integer(92), integer(3))

			expect(itemsThrough(replay, third)).toEqual([0, 91, 2, 92, 4])
			expect(itemsThrough(replay, second)).toEqual([0, 91, 2, 3, 4])
			expect(itemsThrough(replay, first)).toEqual([0, 1, 2, 3, 4])
		})

		// A copy only reads, so a box it read is still stale for the Module.
		it(`${name} leaves the box it read exactly as stale as it found it`, () => {
			let first = replace(
				integers([0, 1, 2, 3, 4]),
				integer(0),
				integer(0),
			)

			replace(first, integer(91), integer(1))

			let array = first.value
			let seen = first.writes?.seen

			expect(itemsThrough(replay, first)).toEqual([0, 1, 2, 3, 4])
			expect(first.value).toBe(array)
			expect(first.writes?.seen).toBe(seen)
			expect(runtimeItems(first)).toEqual([0, 1, 2, 3, 4])
		})
	}
})
