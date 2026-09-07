import { describe, expect, test } from "bun:test"

import { createAlgebraic } from "../Algebraic"
import { createBoolean } from "../Boolean"
import type { DictionaryType, Slot } from "../Dictionary"
import {
	createDictionary,
	encodeKey,
	keys as keysOf,
	length as lengthOf,
	map as mapEntries,
	remove as removeAt,
	set as setAt,
	TOMBSTONE,
	toString as dictionaryToString,
	values as valuesOf,
} from "../Dictionary"
import { group, tally } from "../GroupedList"
import type { IntegerType } from "../Integer"
import { createInteger } from "../Integer"
import { anyIs } from "../internalHelpers"
import type { ListType } from "../List"
import {
	append__overload$1 as append,
	createList,
	prepend__overload$1 as prepend,
} from "../List"
import { createRational, formatAsFraction } from "../Rational"
import type { RecordType } from "../Record"
import { createRecord } from "../Record"
import type { StringType } from "../String"
import { createString } from "../String"
import { getStringRepresentation } from "../Terminal"
import { createTranscendental } from "../Transcendental"
import { type AnyType, typeKeySymbol } from "../type"

// NOTE: The same fixtures `dictionaries.spec.ts` builds its walk on, kept to
// the shapes the two GATHERING natives are handed: the standard library's own
// equality under the Compiler's brand, the same equality without it, a witness
// a Namespace wrote that is COARSER than the encoding, and one that reads a
// Record member so the scan path is the only path.
const integer = (value: number): IntegerType => createInteger(BigInt(value))
const text = createString

// NOTE: The two spellings of one accented String, written as their code points
// so this file can not normalise them into each other. They are ONE String to
// the language, so a gathering has to collapse them into one entry.
const composedAccent = "caf\u00E9"
const decomposedAccent = "cafe\u0301"

// NOTE: √n, which is an Algebraic and so has NO encoding — it stands in a
// store beside the Integers and Rationals that do, which is the one arrangement
// a branded witness can make a MIXED store out of.
const squareRootOf = (radicand: bigint): AnyType =>
	createAlgebraic(
		{ numerator: 0n, denominator: 1n },
		{ numerator: 1n, denominator: 1n },
		radicand,
	) as AnyType

// NOTE: π, built as the runtime builds it — the one Transcendental a Program
// reaches without arithmetic.
const pi = createTranscendental({ numerator: 0n, denominator: 1n }, [
	{ base: "\u03C0", coefficient: { numerator: 1n, denominator: 1n } },
])

type Witness = {
	is: (first: AnyType, second: AnyType) => ReturnType<typeof createBoolean>
	structural?: true
}

const equality: Witness = {
	is: (first, second) => createBoolean(anyIs(first, second)),
	structural: true as const,
}

const witnessed: Witness = { is: equality.is }

const looseText: Witness = {
	is: (first, second) =>
		createBoolean(
			first[typeKeySymbol] === "String" &&
				second[typeKeySymbol] === "String" &&
				(first as StringType).value.toLowerCase() ===
					(second as StringType).value.toLowerCase(),
		),
}

const byIdentifier: Witness = {
	is: (first, second) =>
		createBoolean(
			anyIs((first as RecordType).id, (second as RecordType).id),
		),
}

const printing = {
	toString: (value: AnyType) =>
		createString(getStringRepresentation(value, 0, formatAsFraction, "")),
}

const writtenForm = (box: DictionaryType<AnyType, AnyType>) =>
	dictionaryToString(box, printing, printing).value

// NOTE: mulberry32, copied from `dictionaries.spec.ts` — four lines, no
// dependency, and the same sequence on every engine.
const seededRandom = (seed: number): (() => number) => {
	let state = seed >>> 0

	return () => {
		state = (state + 0x6d2b79f5) | 0

		let mixed = Math.imul(state ^ (state >>> 15), 1 | state)

		mixed = (mixed + Math.imul(mixed ^ (mixed >>> 7), 61 | mixed)) ^ mixed

		return ((mixed ^ (mixed >>> 14)) >>> 0) / 4294967296
	}
}

// NOTE: A List's logical items WITHOUT touching the box — `materialise` trims
// and demotes the box it is handed, which is exactly what the aliasing tests
// below are trying to observe, so they can not go through it.
const viewedItems = (list: ListType<AnyType>): Array<AnyType> => {
	let back = list.value
	let backCount = list.length ?? back.length
	let front = list.front ?? []
	let frontCount = list.frontLen ?? front.length
	let items: Array<AnyType> = []

	for (let index = frontCount - 1; index >= 0; index--) {
		items.push(front[index]!)
	}

	for (let index = 0; index < backCount; index++) {
		items.push(back[index]!)
	}

	return items
}

// NOTE: `dictionaries.spec.ts`'s own store invariants, with the witness a
// parameter rather than the branded one closed over — a gathered Dictionary is
// built through whatever witness the call was handed, and the encodings its
// slots wear have to be that witness's, which is the very thing an unbranded
// one changes.
const expectStoreInvariants = (
	box: DictionaryType<AnyType, AnyType>,
	witness: Witness,
) => {
	let store = box.store
	let totalVersions = 0
	let liveAtTip = 0
	let liveHere = 0
	let seen: Array<AnyType> = []

	expect(box.generation).toBeLessThanOrEqual(store.generation)

	for (let slot of store.slots) {
		expect(slot.versions.length).toBeGreaterThan(0)

		for (let index = 1; index < slot.versions.length; index++) {
			expect(slot.versions[index]!.generation).toBeGreaterThan(
				slot.versions[index - 1]!.generation,
			)
		}

		expect(slot.encoded).toEqual(encodeKey(slot.key, witness))

		if (slot.encoded !== null && typeof slot.encoded === "object") {
			expect(store.texts.get(slot.encoded.text)).toBe(slot)
		} else if (slot.encoded !== null) {
			expect(store.index.get(slot.encoded)).toBe(slot)
		}

		for (let other of seen) {
			expect(witness.is(other, slot.key).value).toBeFalse()
		}

		seen.push(slot.key)
		totalVersions += slot.versions.length

		if (slot.versions[slot.versions.length - 1]!.value !== TOMBSTONE) {
			liveAtTip++
		}

		for (let index = slot.versions.length - 1; index >= 0; index--) {
			if (slot.versions[index]!.generation <= box.generation) {
				if (slot.versions[index]!.value !== TOMBSTONE) {
					liveHere++
				}

				break
			}
		}
	}

	expect(box.length).toBe(liveHere)
	expect(store.dead).toBe(totalVersions - liveAtTip)
	expect(store.index.size + store.texts.size).toBe(
		store.slots.filter((slot) => slot.encoded !== null).length,
	)
	expect(store.unencoded).toBe(
		store.slots.filter((slot) => slot.encoded === null).length,
	)
}

// NOTE: And what a store a GATHERING native answers has to be beyond that: the
// shape a repack leaves one in. Generation zero everywhere, one version per
// slot, nothing dead and nothing tombstoned — which is what makes the answer an
// ordinary Dictionary a Program may write to.
const expectGatheredShape = (box: DictionaryType<AnyType, AnyType>) => {
	expect(box.generation).toBe(0)
	expect(box.store.generation).toBe(0)
	expect(box.store.dead).toBe(0)
	expect(box.length).toBe(box.store.slots.length)

	for (let slot of box.store.slots) {
		expect(slot.versions).toHaveLength(1)
		expect(slot.versions[0]!.generation).toBe(0)
		expect(slot.versions[0]!.value).not.toBe(TOMBSTONE)
	}
}

// NOTE: THE MODEL. A plain Array of groups in first-appearance order, each
// found by asking the witness about the keys already standing — which is the
// specification of both natives read straight off the design, rather than a
// second implementation of the store.
type Group = { key: AnyType; items: Array<AnyType> }

const modelGroup = (
	items: Array<AnyType>,
	keyOf: (item: AnyType) => AnyType,
	witness: Witness,
): Array<Group> => {
	let groups: Array<Group> = []

	for (let item of items) {
		let key = keyOf(item)
		let found = groups.find((group) => witness.is(group.key, key).value)

		if (found === undefined) {
			groups.push({ key, items: [item] })
		} else {
			found.items.push(item)
		}
	}

	return groups
}

// NOTE: A List built the way a Program builds one — some items pushed on the
// back and some pushed on the front — so that the two runs a box may hold are
// both filled, and the natives' backwards walk of the reversed front run is
// what the model's plain order holds them to.
const listOfBothEnds = (
	items: Array<AnyType>,
	next: () => number,
): ListType<AnyType> => {
	let box = createList<AnyType>([])
	let front: Array<AnyType> = []
	let back: Array<AnyType> = []

	for (let item of items) {
		if (next() < 0.4) {
			front.push(item)
		} else {
			back.push(item)
		}
	}

	for (let item of back) {
		box = append(box, item)
	}

	for (let index = front.length - 1; index >= 0; index--) {
		box = prepend(box, front[index]!)
	}

	// NOTE: The model has to be handed the same order, so the caller reads it
	// back off the box rather than off the two halves it built.
	return box
}

describe("gathering a Dictionary out of a List, against a plain model", () => {
	// NOTE: Four pools, one per witness the Compiler may hand a gathering call,
	// each holding keys that are EQUAL but spelled differently — so the model
	// collapses exactly where the store has to, and a scan that skipped a slot
	// or an encoding that split one shows up as a group too many.
	const pools: Array<{
		name: string
		witness: Witness
		keys: Array<AnyType>
	}> = [
		{
			name: "the standard library's own equality, branded",
			witness: equality,
			keys: [
				text("a"),
				text("b"),
				text(composedAccent),
				text(decomposedAccent),
				text(""),
			],
		},
		{
			name: "the same equality unbranded, as a Namespace's own arrives",
			witness: witnessed,
			keys: [
				text("a"),
				text("b"),
				text(composedAccent),
				text(decomposedAccent),
			],
		},
		{
			name: "a witness a Namespace wrote that is coarser than the encoding",
			witness: looseText,
			keys: [text("Ada"), text("ada"), text("Grace"), text("GRACE")],
		},
		{
			name: "Numbers, where two kinds spell one key",
			witness: equality,
			keys: [
				integer(3),
				createRational(3n, 1n),
				createRational(6n, 2n),
				createRational(1n, 2n),
				createRational(2n, 4n),
				integer(0),
				createRational(0n, 5n),
				createInteger(9007199254740993n),
				createRational(9007199254740993n, 1n),
				createBoolean(true),
				// NOTE: The two kinds a branded `Number` witness covers that
				// have NO encoding — an Algebraic and a Transcendental are
				// provably irrational, so neither can ever equal a Rational,
				// and they are found by the scan. They make the store MIXED:
				// encoded slots and unencoded ones side by side under one
				// witness, which is the arrangement the fresh-store search has
				// no fallthrough for.
				squareRootOf(2n),
				squareRootOf(2n),
				squareRootOf(3n),
				pi,
			],
		},
		{
			name: "Records compared by a member, which only the scan path finds",
			witness: byIdentifier,
			keys: [
				createRecord({ id: integer(1), tag: text("first") }),
				createRecord({ id: integer(1), tag: text("second") }),
				createRecord({ id: integer(2), tag: text("third") }),
			],
		},
	]

	for (let pool of pools) {
		test(`groups and tallies as the model does, under ${pool.name}`, () => {
			let next = seededRandom(0x5eed + pool.name.length)

			for (let round = 0; round < 120; round++) {
				let count = Math.floor(next() * 9)
				let items: Array<AnyType> = []

				for (let index = 0; index < count; index++) {
					// NOTE: The item CARRIES its key, so grouping and tallying
					// are asked the same question of the same List — the key
					// read off an item is the key the item is.
					items.push(
						pool.keys[Math.floor(next() * pool.keys.length)]!,
					)
				}

				let list = listOfBothEnds(items, next)
				let logical = viewedItems(list)
				let grouped = group(list, (item) => item, pool.witness as never)
				let counted = tally(list, pool.witness as never)
				let model = modelGroup(logical, (item) => item, pool.witness)

				// NOTE: The KEY BOX the answer keeps is the one that arrived
				// FIRST, identity and all, which is what says the slot kept its
				// original key on every later fold. Asked by identity rather
				// than by value, because two keys that are EQUAL may be spelled
				// differently and which of the two is kept is the claim.
				let groupedKeys = keysOf(grouped).value
				let countedKeys = keysOf(counted).value

				expect(groupedKeys).toHaveLength(model.length)
				expect(countedKeys).toHaveLength(model.length)

				for (let index = 0; index < model.length; index++) {
					expect(groupedKeys[index]).toBe(model[index]!.key)
					expect(countedKeys[index]).toBe(model[index]!.key)
					expect(grouped.store.slots[index]!.key).toBe(
						model[index]!.key,
					)
				}

				let groupItems = valuesOf(grouped).value.map((group) =>
					viewedItems(group as ListType<AnyType>),
				)

				expect(groupItems).toEqual(model.map((group) => group.items))

				// NOTE: And the ITEMS are the very boxes that were grouped,
				// which is what says the walk put each item in its own group
				// rather than rebuilding anything.
				for (let index = 0; index < model.length; index++) {
					for (
						let position = 0;
						position < model[index]!.items.length;
						position++
					) {
						expect(groupItems[index]![position]).toBe(
							model[index]!.items[position],
						)
					}
				}
				expect(
					valuesOf(counted).value.map((count) =>
						Number((count as IntegerType).value),
					),
				).toEqual(model.map((group) => group.items.length))

				expect(Number(lengthOf(grouped).value)).toBe(model.length)
				expect(Number(lengthOf(counted).value)).toBe(model.length)

				expectStoreInvariants(grouped, pool.witness)
				expectStoreInvariants(counted, pool.witness)
				expectGatheredShape(grouped)
				expectGatheredShape(counted)

				// NOTE: And every group holds an Array of its OWN. A group that
				// shared one with a sibling, or with the List that was grouped,
				// would answer that sibling's items the moment either was
				// appended to.
				let arrays = valuesOf(grouped).value.map(
					(group) => (group as ListType<AnyType>).value,
				)

				expect(new Set(arrays).size).toBe(arrays.length)

				for (let array of arrays) {
					expect(array).not.toBe(list.value)
					expect(array).not.toBe(list.front)
				}
			}
		})
	}

	// NOTE: The arrangement the fresh-store search has no fallthrough for, held
	// here so it can not quietly stop being reachable — or quietly become
	// UNSOUND. A branded `Number` witness covers five kinds, two of which have
	// no encoding, so one store carries encoded slots and unencoded ones at
	// once. It is right today only because an Algebraic and a Transcendental
	// are provably irrational and so can never equal an Integer or a Rational:
	// no encoded key is ever the key an unencoded slot holds. A sixth branded
	// Namespace whose `is` crossed that line would gather two slots for one
	// key, where `slotHolding` — which falls through to the scan while
	// `unencoded` stands — would find the one.
	test("gathers a store of encoded and unencoded slots at once", () => {
		let root2 = squareRootOf(2n)
		let counted = tally(
			createList<AnyType>([
				integer(3),
				root2,
				createRational(3n, 1n),
				pi,
				root2,
				createRational(1n, 2n),
			]),
			equality as never,
		)

		expect(counted.store.unencoded).toBe(2)
		expect(counted.store.index.size).toBe(1)
		expect(counted.store.texts.size).toBe(1)
		expect(Number(lengthOf(counted).value)).toBe(4)
		expect(
			valuesOf(counted).value.map((count) =>
				Number((count as IntegerType).value),
			),
		).toEqual([2, 2, 1, 1])

		// NOTE: And the claim the arrangement rests on, asserted rather than
		// assumed: neither unencoded key is equal to any encoded one.
		for (let unencodedKey of [root2, pi]) {
			for (let encodedKey of [
				integer(3),
				createRational(1n, 2n),
				createRational(3n, 1n),
			]) {
				expect(equality.is(unencodedKey, encodedKey).value).toBeFalse()
			}
		}

		expectStoreInvariants(counted, equality)
	})

	// NOTE: The empty List is the one input with no first item to open a group
	// with, and both natives have to answer the empty Dictionary rather than
	// something that merely prints like one.
	test("the empty List gathers into the empty Dictionary", () => {
		for (let witness of [equality, witnessed, looseText, byIdentifier]) {
			let grouped = group(
				createList([]),
				(item) => item,
				witness as never,
			)
			let counted = tally(createList([]), witness as never)

			expect(writtenForm(grouped)).toBe("[=]")
			expect(writtenForm(counted)).toBe("[=]")
			expect(grouped.store.slots).toHaveLength(0)
			expect(counted.store.slots).toHaveLength(0)
			expectStoreInvariants(grouped, witness)
			expectStoreInvariants(counted, witness)
			expectGatheredShape(grouped)
			expectGatheredShape(counted)
		}
	})

	// NOTE: The hazard `List.ts` states in its own words — `createList` TAKES
	// OWNERSHIP, and `append` pushes onto the Array in place while its box is
	// the tip of the run. A group handed to a Program is such a tip, so the
	// Program may append to it; nothing that does may reach a sibling group, the
	// Dictionary that answered them, or the List that was grouped.
	test("appending to one group reaches neither its siblings nor the Dictionary", () => {
		let source = createList<AnyType>([
			text("apple"),
			text("banana"),
			text("avocado"),
			text("blueberry"),
			text("cherry"),
		])
		let grouped = group(
			source,
			(item) => text((item as StringType).value.slice(0, 1)),
			equality as never,
		)
		let groups = valuesOf(grouped).value as Array<ListType<AnyType>>
		let before = groups.map(viewedItems)

		append(groups[0]!, text("apricot"))
		append(groups[1]!, text("bilberry"))

		expect(groups.map(viewedItems)).toEqual(before)
		expect(
			(valuesOf(grouped).value as Array<ListType<AnyType>>).map(
				viewedItems,
			),
		).toEqual(before)
		expect(
			viewedItems(source).map((item) => (item as StringType).value),
		).toEqual(["apple", "banana", "avocado", "blueberry", "cherry"])
	})

	// NOTE: And the same hazard from the other side — a gathered Dictionary is
	// an ordinary one, so a write on it is a tip write, and the box that was
	// written FROM goes on answering what it answered.
	test("a gathered Dictionary is a Dictionary a Program may write to", () => {
		let counted = tally(
			createList<AnyType>([text("a"), text("b"), text("a")]),
			equality as never,
		)
		let written = setAt(counted, text("c"), integer(7), equality as never)
		let removed = removeAt(written, text("a"), equality as never)

		expect(writtenForm(counted)).toBe(`["a" = 2, "b" = 1]`)
		expect(writtenForm(written)).toBe(`["a" = 2, "b" = 1, "c" = 7]`)
		expect(writtenForm(removed)).toBe(`["b" = 1, "c" = 7]`)
		expectStoreInvariants(removed, equality)
	})

	// NOTE: The one place a tally has to count through the ENCODING rather than
	// through the witness's answer alone: `3` and `3/1` are one Number, so they
	// are one item, and the spelling that arrived first is the one the entry
	// keeps.
	test("counts two spellings of one Number as one item", () => {
		let counted = tally(
			createList<AnyType>([
				createRational(6n, 2n),
				integer(3),
				createRational(3n, 1n),
				createRational(1n, 2n),
				createRational(2n, 4n),
			]),
			equality as never,
		)

		expect(writtenForm(counted)).toBe("[3 = 3, 1/2 = 2]")
		expect(keysOf(counted).value[0]![typeKeySymbol]).toBe("Rational")
		expectStoreInvariants(counted, equality)
	})

	// NOTE: A key that only the SCAN path finds, counted rather than grouped —
	// `tally` hands the item itself over as the key, so a Record item is a
	// Record key and the witness is the only thing that can tell two of them
	// apart.
	test("counts Records the way the Namespace that owns them says", () => {
		let counted = tally(
			createList<AnyType>([
				createRecord({ id: integer(1), tag: text("first") }),
				createRecord({ id: integer(2), tag: text("second") }),
				createRecord({ id: integer(1), tag: text("third") }),
			]),
			byIdentifier as never,
		)

		expect(Number(lengthOf(counted).value)).toBe(2)
		expect(
			valuesOf(counted).value.map((count) =>
				Number((count as IntegerType).value),
			),
		).toEqual([2, 1])
		expect(
			(keysOf(counted).value[0] as RecordType & { tag: StringType }).tag
				.value,
		).toBe("first")
		expectStoreInvariants(counted, byIdentifier)
	})

	// NOTE: The blocker shape an earlier review found — a Namespace writing its
	// own `is` for a refinement of a kind whose keys encode. The witness is
	// unbranded, so both natives must SCAN, and a grouping that encoded anyway
	// would put "Ada" and "ada" in two groups the witness says are one.
	test("honours a witness a Namespace wrote in both bridges", () => {
		let names = createList<AnyType>([
			text("Ada"),
			text("ada"),
			text("Grace"),
			text("ADA"),
		])
		let grouped = group(names, (item) => item, looseText as never)
		let counted = tally(names, looseText as never)

		expect(
			keysOf(grouped).value.map((key) => (key as StringType).value),
		).toEqual(["Ada", "Grace"])
		expect(writtenForm(counted)).toBe(`["Ada" = 3, "Grace" = 1]`)

		for (let slot of grouped.store.slots as Array<Slot<AnyType, AnyType>>) {
			expect(slot.encoded).toBeNull()
		}

		expect(grouped.store.unencoded).toBe(2)
		expect(grouped.store.index.size).toBe(0)
		expectStoreInvariants(grouped, looseText)
		expectStoreInvariants(counted, looseText)
	})

	// NOTE: The composition the fixture itself writes — a grouping mapped over —
	// and the one thing it can get wrong: `map` copies each slot's encoding
	// rather than making one, so a Dictionary gathered through a witness a
	// Namespace wrote has to stay unencoded on the other side of it, or a later
	// lookup would take a fast path the witness never agreed to.
	test("mapping a gathered Dictionary carries its encodings over", () => {
		let grouped = group(
			createList<AnyType>([text("Ada"), text("ada"), text("Grace")]),
			(item) => item,
			looseText as never,
		)
		let mapped = mapEntries(grouped, (entry) =>
			integer(viewedItems(entry.value as ListType<AnyType>).length),
		)

		expect(writtenForm(mapped)).toBe(`["Ada" = 2, "Grace" = 1]`)
		expect(mapped.store.unencoded).toBe(2)
		expect(mapped.store.index.size).toBe(0)
		expectStoreInvariants(mapped, looseText)
		expectGatheredShape(mapped)

		let branded = mapEntries(
			tally(
				createList<AnyType>([text("a"), text("b"), text("a")]),
				equality as never,
			),
			(entry) => entry.value,
		)

		expect(branded.store.unencoded).toBe(0)
		expect(branded.store.index.size).toBe(2)
		expectStoreInvariants(branded, equality)
		expectGatheredShape(branded)
	})

	// NOTE: And the same claim about the door itself: a Dictionary built out of
	// pairs through `createDictionary` and one gathered through the three doors
	// a native gathers by are the SAME shape, so nothing downstream can tell
	// which built it.
	test("gathers the shape `createDictionary` builds", () => {
		let gathered = tally(
			createList<AnyType>([text("a"), text("b"), text("a")]),
			equality as never,
		)
		let written = createDictionary(
			[
				[text("a"), integer(2)],
				[text("b"), integer(1)],
			],
			equality as never,
		)

		expect(writtenForm(gathered)).toBe(writtenForm(written))
		expect(gathered.store.unencoded).toBe(written.store.unencoded)
		expect(gathered.store.index.size).toBe(written.store.index.size)
		expect(gathered.store.texts.size).toBe(written.store.texts.size)
	})
})
