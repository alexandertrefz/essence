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

// NOTE: THE UNDO REPLAY EXISTS FOUR TIMES, and nothing held the copies
// together. A positional write changes a run Array in place and counts a
// version up, so a box left behind on that run has to undo the writes made
// since it looked before its items can be read — `runtime/src/listWrites.ts`
// is the authority, and `caughtUp` there is the original. This boundary
// carries one, the hand-built door in `tools/bench.ts` carries another, and
// the debugger's renderer carries two more (guarded in
// `packages/debug-adapter/src/tests/undoReplay.spec.ts`, which is this same
// idea pointed at those).
//
// NOTE: The copies are not a mistake to be collapsed. This boundary imports
// values from three files and no others — `descriptor.spec.ts` asserts exactly
// that, because a Module's runtime is inlined in ITS bundle and an import from
// here would reach for a second copy of it in the HOST's. So what ties the
// copies together is a guard rather than a refactor, and this is it: random
// boxes left behind in every way a chain can leave one behind, read through
// each copy, and compared against what the runtime itself answers.
const integer = (value: number) => createInteger(BigInt(value))

const integers = (values: Array<number>): ListType<IntegerType> =>
	createList(values.map(integer))

// NOTE: A counted generator rather than `Math.random`, so a seed names one
// schedule for good — the same shape `positionalWrites.spec.ts` uses, and for
// the same reason.
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

// NOTE: What the runtime says the box holds — through `materialise`, which
// catches a stale box up and hands back an Array whose whole length is the
// box's view. This is the answer both copies are measured against.
const runtimeItems = (box: ListType<IntegerType>): Array<number> =>
	materialise(box).map((each) => Number(each.value))

// NOTE: What a COPY says. Each answers the BACK run as this box sees it, so the
// front run — which no positional write ever lands in — is walked here the way
// each copy's own caller walks it: reversed, and then the back.
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

// NOTE: EVERY WAY A CHAIN CAN LEAVE A BOX BEHIND, built at random and kept:
// several versions of one written run, windows of a written run, boxes with a
// front run the writes never touch, and siblings made by a tip push. What every
// one of them has in common is that the Array it holds has moved on without it.
const staleBoxesFrom = (seed: number): Array<ListType<IntegerType>> => {
	let next = generatorFrom(seed)
	let size = 6 + Math.floor(next() * 10)
	let items = Array.from({ length: size }, (_, index) => index)
	let kept: Array<ListType<IntegerType>> = []
	let latest = integers(items)

	// NOTE: The first write copies and attaches the log to the COPY, so every
	// box kept from here on shares one written Array.
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
		// NOTE: Twelve seeds, which is a few milliseconds and covers every
		// shape above many times over. Written out rather than counted, so a
		// failing one can be pulled while it is being fixed without
		// renumbering the rest.
		for (let seed of [1, 2, 3, 5, 8, 13, 21, 34, 55, 89, 144, 233]) {
			it(`${name} answers what the runtime answers, seed ${seed}`, () => {
				// NOTE: The copy is asked FIRST and the runtime second,
				// because reading a box through the runtime REPAIRS it — ask
				// the runtime first and every box handed to the copy is
				// already current, which is the one state a broken replay
				// would survive.
				for (let box of staleBoxesFrom(seed)) {
					let shown = itemsThrough(replay, box)

					expect(shown).toEqual(runtimeItems(box))
				}
			})
		}

		// NOTE: And the shape the arithmetic is really about, written out
		// rather than drawn from a seed: one run, three versions of it, every
		// version still held.
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

		// NOTE: THE OTHER HALF OF WHAT A COPY OWES: it reads, and the runtime
		// repairs. A box either of these has read must still be stale, so that
		// the Module on the other side of the boundary finds it exactly as it
		// left it.
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
