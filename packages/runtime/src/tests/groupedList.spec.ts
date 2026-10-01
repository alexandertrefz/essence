import { describe, expect, test } from "bun:test"

import { createAlgebraic } from "../Algebraic"
import { createBoolean } from "../Boolean"
import type { DictionaryType, Slot } from "../Dictionary"
import {
	createDictionary,
	keys as keysOf,
	length as lengthOf,
	map as mapEntries,
	remove__overload$1 as removeAt,
	set as setAt,
	TOMBSTONE,
	toString as dictionaryToString,
	values as valuesOf,
} from "../Dictionary"
import { group, index as indexBy, tally } from "../GroupedList"
import type { IntegerType } from "../Integer"
import { createInteger } from "../Integer"
import { anyIs } from "../internalHelpers"
import { encodeKey } from "../keyEncoding"
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

// The witnesses a gathering native may be handed. They are the library's
// equality with and without the Compiler's brand, a Namespace's witness coarser
// than the encoding, and one reading a Record member.
const integer = (value: number): IntegerType => createInteger(BigInt(value))
const text = createString

// Two spellings of one String, written as code points so that no editor can
// normalise them into each other. A gathering collapses them into one entry.
const composedAccent = "caf\u00E9"
const decomposedAccent = "cafe\u0301"

// The square root of n, an Algebraic with no encoding. Beside Integers and
// Rationals under a branded witness it makes a mixed store.
const squareRootOf = (radicand: bigint): AnyType =>
	createAlgebraic(
		{ numerator: 0n, denominator: 1n },
		{ numerator: 1n, denominator: 1n },
		radicand,
	) as AnyType

// Pi, built as the runtime builds it.
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

// A List's items read without touching the box, since `materialise` demotes
// the box the aliasing tests observe.
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

// The store invariants of `dictionaries.spec.ts`, with the witness as a
// parameter, since a slot's encoding must be the one its witness gives.
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

// A gathered store has the shape a repack leaves: generation zero, one version
// per slot, nothing dead. See "Writing to a Dictionary" in
// packages/runtime/DEVELOPMENT.md.
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

// The model: groups in first-appearance order, each found by asking the witness
// about the keys already standing. A tally is the groups' sizes, and an index is
// each group's last item under the group's own key box.
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

// Pushes some items on the back and some on the front. Both runs of the box are
// then filled, and the backwards walk of the front run is checked.
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

	// The caller reads the order for the model back off the box.
	return box
}

describe("gathering a Dictionary out of a List, against a plain model", () => {
	// Each pool holds equal keys spelled differently, so a scan that skips a slot
	// or an encoding that splits one shows as an extra group.
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
				// A branded `Number` witness also covers these, which have no
				// encoding, so the store holds encoded and unencoded slots.
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
		test(`groups, tallies and indexes as the model does, under ${pool.name}`, () => {
			let next = seededRandom(0x5eed + pool.name.length)

			for (let round = 0; round < 120; round++) {
				let count = Math.floor(next() * 9)
				let items: Array<AnyType> = []

				for (let index = 0; index < count; index++) {
					// The item is its own key, so grouping and tallying are asked
					// the same question.
					items.push(
						pool.keys[Math.floor(next() * pool.keys.length)]!,
					)
				}

				let list = listOfBothEnds(items, next)
				let logical = viewedItems(list)
				let grouped = group(list, (item) => item, pool.witness as never)
				let counted = tally(list, pool.witness as never)
				let indexed = indexBy(
					list,
					(item) => item,
					pool.witness as never,
				)
				let model = modelGroup(logical, (item) => item, pool.witness)

				// Each answer keeps the key box that arrived first. Asked by
				// identity, since equal keys may be spelled differently.
				let groupedKeys = keysOf(grouped).value
				let countedKeys = keysOf(counted).value
				let indexedKeys = keysOf(indexed).value

				expect(groupedKeys).toHaveLength(model.length)
				expect(countedKeys).toHaveLength(model.length)
				expect(indexedKeys).toHaveLength(model.length)

				for (let index = 0; index < model.length; index++) {
					expect(groupedKeys[index]).toBe(model[index]!.key)
					expect(countedKeys[index]).toBe(model[index]!.key)
					expect(indexedKeys[index]).toBe(model[index]!.key)
					expect(grouped.store.slots[index]!.key).toBe(
						model[index]!.key,
					)
				}

				// An index keeps the very box of the last item under a key.
				let indexedValues = valuesOf(indexed).value

				for (let index = 0; index < model.length; index++) {
					let items = model[index]!.items

					expect(indexedValues[index]).toBe(items[items.length - 1])
				}

				let groupItems = valuesOf(grouped).value.map((group) =>
					viewedItems(group as ListType<AnyType>),
				)

				expect(groupItems).toEqual(model.map((group) => group.items))

				// The items are the very boxes that were grouped.
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
				expect(Number(lengthOf(indexed).value)).toBe(model.length)

				expectStoreInvariants(grouped, pool.witness)
				expectStoreInvariants(counted, pool.witness)
				expectStoreInvariants(indexed, pool.witness)
				expectGatheredShape(grouped)
				expectGatheredShape(counted)
				expectGatheredShape(indexed)

				// Every group holds its own Array, so an append to one can not
				// reach a sibling or the grouped List.
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

	// Under a branded `Number` witness one store holds encoded and unencoded
	// slots, and a key whose encoding misses still falls through to the scan.
	// See "Finding a Dictionary key" in packages/runtime/DEVELOPMENT.md.
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

		// The fixture's premise: no unencoded key equals an encoded one.
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

	// Each native must answer the empty Dictionary itself, not something that
	// merely prints like one.
	test("the empty List gathers into the empty Dictionary", () => {
		for (let witness of [equality, witnessed, looseText, byIdentifier]) {
			let grouped = group(
				createList([]),
				(item) => item,
				witness as never,
			)
			let counted = tally(createList([]), witness as never)
			let indexed = indexBy(
				createList([]),
				(item) => item,
				witness as never,
			)

			expect(writtenForm(grouped)).toBe("[=]")
			expect(writtenForm(counted)).toBe("[=]")
			expect(writtenForm(indexed)).toBe("[=]")
			expect(grouped.store.slots).toHaveLength(0)
			expect(counted.store.slots).toHaveLength(0)
			expect(indexed.store.slots).toHaveLength(0)
			expectStoreInvariants(grouped, witness)
			expectStoreInvariants(counted, witness)
			expectStoreInvariants(indexed, witness)
			expectGatheredShape(grouped)
			expectGatheredShape(counted)
			expectGatheredShape(indexed)
		}
	})

	// A repeated key keeps the place and the key box it was first met at, as
	// `Dictionary.of` and `set` promise.
	test("indexes the last item under a key that keeps its first place", () => {
		let first = createRecord({ id: integer(1), tag: text("first") })
		let second = createRecord({ id: integer(2), tag: text("second") })
		let third = createRecord({ id: integer(1), tag: text("third") })
		let keyOf = (item: AnyType) => (item as RecordType).id as AnyType
		let indexed = indexBy(
			createList<AnyType>([first, second, third]),
			keyOf,
			equality as never,
		)

		expect(Number(lengthOf(indexed).value)).toBe(2)
		expect(keysOf(indexed).value).toEqual([first.id, second.id])
		expect(keysOf(indexed).value[0]).toBe(first.id)
		expect(valuesOf(indexed).value[0]).toBe(third)
		expect(valuesOf(indexed).value[1]).toBe(second)
		expectStoreInvariants(indexed, equality)
		expectGatheredShape(indexed)
	})

	// `createList` takes ownership, and `append` pushes in place on the tip of a
	// run. A group is such a tip, so an append to it must reach nothing else.
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

	// A write on a gathered Dictionary is a tip write, and the box written from
	// keeps its answer.
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

	// `3` and `3/1` are one Number, so they are one item, and the entry keeps the
	// spelling that arrived first.
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

	// `tally` uses the item as its key, so only the witness tells two Record
	// items apart, and only the scan path finds them.
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

	// A witness a Namespace wrote is unbranded, so every native must scan. Encoding
	// anyway would split "Ada" and "ada", which the witness calls one.
	test("honours a witness a Namespace wrote in every bridge", () => {
		let names = createList<AnyType>([
			text("Ada"),
			text("ada"),
			text("Grace"),
			text("ADA"),
		])
		let grouped = group(names, (item) => item, looseText as never)
		let counted = tally(names, looseText as never)
		let indexed = indexBy(names, (item) => item, looseText as never)

		expect(
			keysOf(grouped).value.map((key) => (key as StringType).value),
		).toEqual(["Ada", "Grace"])
		expect(writtenForm(counted)).toBe(`["Ada" = 3, "Grace" = 1]`)
		expect(writtenForm(indexed)).toBe(`["Ada" = "ADA", "Grace" = "Grace"]`)

		for (let slot of grouped.store.slots as Array<Slot<AnyType, AnyType>>) {
			expect(slot.encoded).toBeNull()
		}

		expect(grouped.store.unencoded).toBe(2)
		expect(grouped.store.index.size).toBe(0)
		expect(indexed.store.unencoded).toBe(2)
		expectStoreInvariants(grouped, looseText)
		expectStoreInvariants(counted, looseText)
		expectStoreInvariants(indexed, looseText)
	})

	// `map` copies each slot's encoding rather than making one. So a Dictionary
	// gathered through an unbranded witness stays unencoded, and no lookup takes a
	// fast path the witness never agreed to.
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

	// Nothing downstream can tell a gathered Dictionary from one `createDictionary`
	// built.
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
