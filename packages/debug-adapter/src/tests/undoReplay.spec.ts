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

import { DESCRIBE_BATCH_SOURCE, LIST_ITEMS_SOURCE } from "../render"

// A box left behind on a written run undoes the writes made since its version
// before its items can be read. `caughtUp` in `runtime/src/listWrites.ts` does
// this, and the renderer in `render.ts` copies it, since it runs inside the
// debuggee and imports nothing. `packages/client/src/tests/undoReplay.spec.ts`
// guards the client's copies.
//
// This spec reads random stale boxes through the shipped source, as the
// debuggee does, and compares the answer with the runtime's.
const describeBatch = (0, eval)(`(${DESCRIBE_BATCH_SOURCE})`) as (
	...values: Array<unknown>
) => string

const listItems = (0, eval)(`(${LIST_ITEMS_SOURCE})`) as (
	list: unknown,
) => Array<unknown>

const integer = (value: number) => createInteger(BigInt(value))

const integers = (values: Array<number>): ListType<IntegerType> =>
	createList(values.map(integer))

// A seeded generator rather than `Math.random`, so a seed always names the
// same schedule, as in `positionalWrites.spec.ts`.
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

// What the runtime says the box holds. `materialise` catches a stale box up
// and answers an Array of exactly the box's view.
const runtimeItems = (box: ListType<IntegerType>): Array<number> =>
	materialise(box).map((each) => Number(each.value))

// What the debugger says: the items it expands the box into, and the line it
// prints for it. Both run the replay.
const debuggerItems = (box: ListType<IntegerType>): Array<number> =>
	listItems(box).map((each) => Number((each as IntegerType).value))

const debuggerLine = (box: ListType<IntegerType>): string => {
	let described = JSON.parse(describeBatch(box)) as Array<{
		display: string | null
	}>

	return described[0]!.display ?? ""
}

// The renderer elides a line past sixty characters, so the runtime's items
// are drawn by the same rule for comparison.
const lineFor = (items: Array<number>): string => {
	if (items.length === 0) {
		return "[]"
	}

	let line = `[ ${items.join(", ")} ]`

	return line.length < 60 ? line : `[ ${items[0]}, … ]`
}

// Random boxes whose Array has moved on without them. They are versions and
// windows of one written run, boxes with an untouched front run, and siblings
// made by a tip push.
const staleBoxesFrom = (seed: number): Array<ListType<IntegerType>> => {
	let next = generatorFrom(seed)
	let size = 6 + Math.floor(next() * 10)
	let items = Array.from({ length: size }, (_, index) => index)
	let kept: Array<ListType<IntegerType>> = []
	let latest = integers(items)

	// The first write copies and attaches the log to the copy, so every box
	// kept from here on shares one written Array.
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

describe("the debugger's copy of the undo replay", () => {
	// Written out rather than counted, so one seed can be removed without
	// renumbering the rest.
	for (let seed of [1, 2, 3, 5, 8, 13, 21, 34, 55, 89, 144, 233]) {
		it(`answers what the runtime answers, seed ${seed}`, () => {
			// The debugger is asked first, because reading a box through the
			// runtime repairs it and would hide a broken replay.
			for (let box of staleBoxesFrom(seed)) {
				let shown = debuggerItems(box)
				let line = debuggerLine(box)
				let owed = runtimeItems(box)

				expect(shown).toEqual(owed)
				expect(line).toBe(lineFor(owed))
			}
		})
	}

	// One run with three versions, all still held. Each box answers the items
	// it was made with.
	it("answers each version of one written run", () => {
		let first = replace(integers([0, 1, 2, 3, 4]), integer(0), integer(0))
		let second = replace(first, integer(91), integer(1))
		let third = replace(second, integer(92), integer(3))

		expect(debuggerItems(third)).toEqual([0, 91, 2, 92, 4])
		expect(debuggerItems(second)).toEqual([0, 91, 2, 3, 4])
		expect(debuggerItems(first)).toEqual([0, 1, 2, 3, 4])

		expect(runtimeItems(first)).toEqual([0, 1, 2, 3, 4])
		expect(runtimeItems(second)).toEqual([0, 91, 2, 3, 4])
		expect(runtimeItems(third)).toEqual([0, 91, 2, 92, 4])
	})

	// Looking at a paused Program must not change it. The replay copies rather
	// than repairs, so a box the debugger read stays stale and still answers its
	// own items.
	it("leaves the box it read exactly as stale as it found it", () => {
		let first = replace(integers([0, 1, 2, 3, 4]), integer(0), integer(0))
		let second = replace(first, integer(91), integer(1))
		let array = first.value
		let seen = first.writes?.seen

		expect(debuggerItems(first)).toEqual([0, 1, 2, 3, 4])
		expect(first.value).toBe(array)
		expect(first.writes?.seen).toBe(seen)
		expect(first.writes?.log.version).toBe(second.writes?.log.version)
		expect(runtimeItems(first)).toEqual([0, 1, 2, 3, 4])
	})
})
