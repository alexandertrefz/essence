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

// NOTE: THE UNDO REPLAY EXISTS FOUR TIMES, and nothing held the copies
// together. A positional write changes a run Array in place and counts a
// version up, so a box left behind on that run has to undo the writes made
// since it looked before its items can be read — `runtime/src/listWrites.ts`
// is the authority, and `caughtUp` there is the original. The renderer in
// `render.ts` carries two more, one for the line the Variables view shows and
// one for expanding a List, and the client boundary carries a fourth (guarded
// in `packages/client/src/tests/undoReplay.spec.ts`, which is the same idea
// pointed at the other two).
//
// NOTE: The copies are not a mistake to be collapsed. This source is evaluated
// INSIDE the debuggee through `Runtime.callFunctionOn`, where nothing else of
// this module exists, so it can import nothing — which is exactly why it needs
// a guard rather than a refactor. What follows is that guard: random boxes
// left behind in every way a chain can leave one behind, read through the
// shipped source EXACTLY as the debuggee reads it, and compared against what
// the runtime itself answers for the same box.
const describeBatch = (0, eval)(`(${DESCRIBE_BATCH_SOURCE})`) as (
	...values: Array<unknown>
) => string

const listItems = (0, eval)(`(${LIST_ITEMS_SOURCE})`) as (
	list: unknown,
) => Array<unknown>

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
// box's view. This is the answer every other copy is measured against.
const runtimeItems = (box: ListType<IntegerType>): Array<number> =>
	materialise(box).map((each) => Number(each.value))

// NOTE: What the DEBUGGER says, twice over: the items it would expand the box
// into, and the line it would print for it. Both run the replay, and a copy
// that got it wrong would disagree with the runtime about a box that is
// perfectly intact.
const debuggerItems = (box: ListType<IntegerType>): Array<number> =>
	listItems(box).map((each) => Number((each as IntegerType).value))

const debuggerLine = (box: ListType<IntegerType>): string => {
	let described = JSON.parse(describeBatch(box)) as Array<{
		display: string | null
	}>

	return described[0]!.display ?? ""
}

// NOTE: The line the renderer draws is elided past sixty characters, which is
// a display rule rather than anything about the replay — so it is compared
// against the runtime's own items drawn by the SAME rule rather than against
// the items themselves.
const lineFor = (items: Array<number>): string => {
	if (items.length === 0) {
		return "[]"
	}

	let line = `[ ${items.join(", ")} ]`

	return line.length < 60 ? line : `[ ${items[0]}, … ]`
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

describe("the debugger's copy of the undo replay", () => {
	// NOTE: Twelve seeds, which is a few milliseconds and covers every shape
	// above many times over. Written out rather than counted, so a failing one
	// can be pulled while it is being fixed without renumbering the rest.
	for (let seed of [1, 2, 3, 5, 8, 13, 21, 34, 55, 89, 144, 233]) {
		it(`answers what the runtime answers, seed ${seed}`, () => {
			// NOTE: The debugger is asked FIRST and the runtime second, because
			// reading a box through the runtime REPAIRS it — ask the runtime
			// first and every box handed to the debugger is already current,
			// which is the one state a broken replay would survive.
			for (let box of staleBoxesFrom(seed)) {
				let shown = debuggerItems(box)
				let line = debuggerLine(box)
				let owed = runtimeItems(box)

				expect(shown).toEqual(owed)
				expect(line).toBe(lineFor(owed))
			}
		})
	}

	// NOTE: And the shape the arithmetic is really about, written out rather
	// than drawn from a seed: one run, three versions of it, every version
	// still held. Each box owes the items it was made with, and the debugger
	// owes the same.
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

	// NOTE: THE OTHER HALF OF WHAT THE DEBUGGER OWES: looking at a paused
	// Program may not change it. The replay copies rather than repairing, so a
	// box the debugger has read must still be stale — and must still answer
	// its own items when the Program is resumed.
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
