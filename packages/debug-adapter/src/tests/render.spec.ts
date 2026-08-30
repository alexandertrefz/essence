import { describe, expect, it } from "bun:test"

import { createBoolean } from "@essence-lang/runtime/Boolean"
import type { DictionaryType, Slot } from "@essence-lang/runtime/Dictionary"
import { createDictionary, TOMBSTONE } from "@essence-lang/runtime/Dictionary"
import type { IntegerType } from "@essence-lang/runtime/Integer"
import { createInteger } from "@essence-lang/runtime/Integer"
import { anyIs } from "@essence-lang/runtime/internalHelpers"
import {
	append__overload$1 as append,
	createList,
	type ListType,
	prepend__overload$1 as prepend,
} from "@essence-lang/runtime/List"
import { createRational } from "@essence-lang/runtime/Rational"
import { createRecord } from "@essence-lang/runtime/Record"
import type { StringType } from "@essence-lang/runtime/String"
import { createString } from "@essence-lang/runtime/String"
import { getStringRepresentation } from "@essence-lang/runtime/Terminal"
import {
	type AnyType,
	createCase,
	typeKeySymbol,
} from "@essence-lang/runtime/type"

import {
	type DescribedValue,
	DESCRIBE_BATCH_SOURCE,
	DICTIONARY_ENTRIES_SOURCE,
	LIST_ITEMS_SOURCE,
} from "../render"

// NOTE: Both travel to the debuggee as source text — evaluating them here, the
// way `Runtime.callFunctionOn` does over there, proves they are genuinely
// self-contained: a captured binding would throw the moment it runs outside its
// module.
const describeBatch = (0, eval)(`(${DESCRIBE_BATCH_SOURCE})`) as (
	...values: Array<unknown>
) => string

const listItems = (0, eval)(`(${LIST_ITEMS_SOURCE})`) as (
	list: unknown,
) => Array<unknown>

const dictionaryEntries = (0, eval)(`(${DICTIONARY_ENTRIES_SOURCE})`) as (
	dictionary: unknown,
) => Array<unknown>

function describeOne(value: unknown): DescribedValue {
	return (JSON.parse(describeBatch(value)) as Array<DescribedValue>)[0]!
}

const integers = (...values: Array<number>): ListType<IntegerType> =>
	createList(values.map((value) => createInteger(BigInt(value))))

const valuesOf = (items: Array<unknown>): Array<number | bigint> =>
	items.map((item) => (item as IntegerType).value)

// NOTE: `anyIs` is the runtime's own structural comparison, branded
// `structural` exactly as the Compiler brands the standard library's own
// equality — so this is the witness a Dictionary of Strings in a debugged
// Program is really built through, and the store below is the store one really
// has.
const equality = {
	is: (first: AnyType, second: AnyType) =>
		createBoolean(anyIs(first, second)),
	structural: true as const,
}

const dictionary = (
	...pairs: Array<[string, number]>
): DictionaryType<AnyType, AnyType> =>
	createDictionary(
		pairs.map(
			([key, value]) =>
				[createString(key), createInteger(BigInt(value))] as [
					AnyType,
					AnyType,
				],
		),
		equality,
	)

// NOTE: One key's slot, written down as the versions its value has had, each
// with the generation of the write that gave it that value — `[2, 9]` is "the
// second write made this 9", and `TOMBSTONE` in that place is the removal that
// took the key away.
const slotOf = (
	key: string,
	...versions: Array<[number, number | typeof TOMBSTONE]>
): Slot<AnyType, AnyType> => ({
	key: createString(key),
	encoded: null,
	versions: versions.map(([generation, value]) => ({
		value: value === TOMBSTONE ? TOMBSTONE : createInteger(BigInt(value)),
		generation,
	})),
})

// NOTE: A box built BY HAND rather than through the runtime's own writes, so
// that everything a view has to be right about can stand in one store at once:
// a value SUPERSEDED by a later write, a key REMOVED, and a slot opened by a
// write the box came before. `DictionaryType` in runtime/src/Dictionary.ts is
// the authority for every field, and the two indexes are left EMPTY on purpose
// — a view is read off the slots and their stamps and off nothing else, which
// is the claim these tests are here to hold.
function boxAt(
	generation: number,
	...slots: Array<Slot<AnyType, AnyType>>
): DictionaryType<AnyType, AnyType> {
	let newestVersionOf = (slot: Slot<AnyType, AnyType>) =>
		slot.versions[slot.versions.length - 1]
	let visibleVersionOf = (slot: Slot<AnyType, AnyType>) =>
		slot.versions
			.filter((version) => version.generation <= generation)
			.pop()

	return {
		[typeKeySymbol]: "Dictionary",
		store: {
			slots,
			index: new Map(),
			fractions: new Map(),
			generation: Math.max(
				0,
				...slots.flatMap((slot) =>
					slot.versions.map((version) => version.generation),
				),
			),
			dead: slots.reduce(
				(count, slot) =>
					count +
					slot.versions.length -
					1 +
					(newestVersionOf(slot).value === TOMBSTONE ? 1 : 0),
				0,
			),
			unencoded: slots.length,
		},
		generation,
		length: slots.filter((slot) => {
			let visible = visibleVersionOf(slot)

			return visible !== undefined && visible.value !== TOMBSTONE
		}).length,
	}
}

const pairsOf = (entries: Array<unknown>): Array<[string, number | bigint]> =>
	entries.map((entry) => {
		let held = entry as { key: StringType; value: IntegerType }

		return [held.key.value, held.value.value]
	})

describe("the in-debuggee renderer", () => {
	// NOTE: The display contract is `getStringRepresentation` itself — the
	// REAL runtime values, built by the REAL constructors, must render to the
	// very line `Terminal.inspect` would have printed.
	it("agrees with the runtime's own printer", () => {
		let values = [
			createInteger(42n),
			createString("hello"),
			createBoolean(true),
			createRecord({}),
			createRecord({
				width: createInteger(3n),
				height: createInteger(4n),
			}),
			createList([createInteger(1n), createInteger(2n)]),
			createCase("Ordering#Less"),
			createCase("Shape#Circle", { radius: createInteger(2n) }),
			// NOTE: Built UNREDUCED, which is the only way a Rational is worth
			// asking about here. `createRational` settles the sign and zero and
			// reduces nothing, so `6/2` is a value a Program really holds — and
			// the printer it is held against answers lowest terms.
			createRational(6n, 2n),
			createRational(2n, 4n),
			createRational(-4n, 6n),
		]

		for (let value of values) {
			expect(describeOne(value).display).toBe(
				getStringRepresentation(value as never),
			)
		}
	})

	it("classifies how a value expands", () => {
		expect(describeOne(createInteger(1n)).kind).toBe("leaf")
		expect(describeOne(createRecord({ a: createInteger(1n) })).kind).toBe(
			"record",
		)
		expect(describeOne(createList([])).kind).toBe("list")
		expect(describeOne(createCase("Ordering#Less")).kind).toBe("leaf")
		expect(
			describeOne(
				createCase("Shape#Circle", { radius: createInteger(2n) }),
			).kind,
		).toBe("record")
	})

	// NOTE: The one deliberate divergence — a Variables row is one line, so
	// what the runtime would print across several is truncated instead.
	it("caps what one line can hold", () => {
		let wide = createRecord({
			first: createString("a very long member value indeed"),
			second: createString("another long member value indeed"),
		})

		let display = describeOne(wide).display!

		expect(display.endsWith("… }")).toBe(true)
		expect(getStringRepresentation(wide as never)).toContain("\n")
	})

	it("hands anything that is not an Essence value back", () => {
		expect(describeOne({ plain: true })).toEqual({
			display: null,
			kind: "plain",
		})
		expect(describeOne(7)).toEqual({ display: null, kind: "leaf" })
	})

	it("answers many values in one call, in order", () => {
		let batch = JSON.parse(
			describeBatch(createInteger(1n), createString("two")),
		) as Array<DescribedValue>

		expect(batch.map((value) => value.display)).toEqual(["1", '"two"'])
	})
})

// NOTE: A List's runs are SHARED with the other boxes of its chain, so what a
// box holds and what it VIEWS come apart the moment either end is added to.
// Both ways that happens are held here: an inner Array grown past its box by
// somebody else's append, and a first item living in a second run stored
// backwards. A debugger drawing a box of four items as five is wrong in the
// way a debugger is not allowed to be.
describe("the in-debuggee renderer, over shared List runs", () => {
	it("draws what a box views, not what its Array holds", () => {
		let base = integers(1, 2, 3)

		append(base, createInteger(4n))

		expect(describeOne(base).display).toBe("[ 1, 2, 3 ]")
	})

	it("draws a box whose whole view was appended away as empty", () => {
		let base = integers()

		append(base, createInteger(1n))

		expect(describeOne(base).display).toBe("[]")
	})

	it("draws a prepended box's front run ahead of its back, in order", () => {
		let upgraded = prepend(
			prepend(integers(3), createInteger(2n)),
			createInteger(1n),
		)

		expect(describeOne(upgraded).display).toBe("[ 1, 2, 3 ]")
		expect(describeOne(upgraded).kind).toBe("list")
	})

	it("agrees with the runtime's own printer on a box grown at both ends", () => {
		let base = integers(2, 3)
		let upgraded = append(
			prepend(base, createInteger(1n)),
			createInteger(4n),
		)

		append(base, createInteger(9n))

		let display = describeOne(upgraded).display

		expect(display).toBe("[ 1, 2, 3, 4 ]")
		// NOTE: Second, because the runtime's printer materialises what it
		// prints — the renderer has to have gone first to have been the one
		// reading a box still in two runs.
		expect(display).toBe(getStringRepresentation(upgraded as never))
	})

	it("draws a shared inner List by its own view", () => {
		let outer = createList([prepend(integers(2), createInteger(1n))])

		expect(describeOne(outer).display).toBe("[ [ 1, 2 ] ]")
	})

	it("leaves the box it drew exactly as it found it", () => {
		let upgraded = prepend(integers(2, 3), createInteger(1n))

		describeOne(upgraded)

		expect(upgraded.front).toBeDefined()
		expect(upgraded.value.length).toBe(2)
	})
})

// NOTE: What the Variables view expands a List row into. The items must be the
// LIVE ones — each is handed back to the view by reference, and expanding one
// of them again is how a nested value is opened.
describe("the in-debuggee List reader", () => {
	it("answers the items a box views, in order", () => {
		let base = integers(2, 3)
		let upgraded = prepend(base, createInteger(1n))

		append(base, createInteger(9n))

		expect(valuesOf(listItems(upgraded))).toEqual([1, 2, 3])
	})

	it("answers nothing for a box whose view is empty", () => {
		let base = integers()

		append(base, createInteger(1n))

		expect(listItems(base)).toEqual([])
		expect(listItems(integers())).toEqual([])
	})

	it("hands the items themselves back, not copies of them", () => {
		let first = createInteger(1n)

		expect(listItems(createList([first]))[0]).toBe(first)
	})

	it("leaves the box it read exactly as it found it", () => {
		let upgraded = prepend(integers(2, 3), createInteger(1n))

		listItems(upgraded)

		expect(upgraded.front).toBeDefined()
		expect(upgraded.value.length).toBe(2)
	})
})

// NOTE: A Dictionary's store is SHARED with the other boxes of its chain, and
// what separates them is a stamp rather than a copy: every write pushes a
// version onto the one store, and a box holds whichever version of each key was
// the newest when it was made. So a store carries values this box was written
// before, values it was written after, and tombstones for keys it no longer
// holds — three ways for a debugger to draw entries a Program cannot reach, all
// of them held here against one store three boxes view.
describe("the in-debuggee renderer, over a Dictionary's shared store", () => {
	// NOTE: `a` written twice, `b` removed, `c` added last — one store, and a
	// box before each of the three writes that made it.
	let slots = () => [
		slotOf("a", [0, 1], [2, 9]),
		slotOf("b", [0, 2], [1, TOMBSTONE]),
		slotOf("c", [3, 3]),
	]

	it("draws the entries a box views, in insertion order", () => {
		let written = slots()

		expect(describeOne(boxAt(0, ...written)).display).toBe(
			'[ "a" = 1, "b" = 2 ]',
		)
		expect(describeOne(boxAt(1, ...written)).display).toBe('[ "a" = 1 ]')
		expect(describeOne(boxAt(3, ...written)).display).toBe(
			'[ "a" = 9, "c" = 3 ]',
		)
	})

	it("draws a box that holds nothing as the empty Dictionary", () => {
		expect(describeOne(boxAt(0)).display).toBe("[=]")
		expect(
			describeOne(boxAt(1, slotOf("a", [0, 1], [1, TOMBSTONE]))).display,
		).toBe("[=]")
	})

	// NOTE: The display contract, here as everywhere in this file: what a
	// Variables row shows is the very line `Terminal.inspect` prints, down to
	// the padding inside the brackets and the `[=]` that is an empty Dictionary
	// rather than an empty List.
	it("agrees with the runtime's own printer", () => {
		let ages = dictionary(["alex", 39], ["sam", 25])
		let empty = createDictionary([], equality)

		expect(describeOne(ages).display).toBe('[ "alex" = 39, "sam" = 25 ]')
		expect(describeOne(ages).display).toBe(
			getStringRepresentation(ages as never),
		)
		expect(describeOne(empty).display).toBe("[=]")
		expect(describeOne(empty).display).toBe(
			getStringRepresentation(empty as never),
		)

		// NOTE: And a Rational on both sides of the `=`, written UNREDUCED. A
		// store keeps the first key box that arrived, so `6/2` is the very box
		// a Dictionary holds after `3` was set into it a second time — and the
		// two spellings are one key, which is why the entry is the earlier one.
		// Drawn raw, this row would read `6/2 = 2/4`: a spelling the Program it
		// belongs to can not print.
		let fractions = createDictionary(
			[
				[createRational(6n, 2n), createRational(2n, 4n)] as [
					AnyType,
					AnyType,
				],
			],
			equality,
		)

		expect(describeOne(fractions).display).toBe("[ 3/1 = 1/2 ]")
		expect(describeOne(fractions).display).toBe(
			getStringRepresentation(fractions as never),
		)
	})

	it("classifies a Dictionary by its entries rather than by its members", () => {
		expect(describeOne(dictionary(["alex", 39])).kind).toBe("dictionary")
		expect(describeOne(boxAt(0)).kind).toBe("dictionary")
	})

	it("draws a Dictionary inside another value by its own view", () => {
		let held = boxAt(1, ...slots())

		expect(describeOne(createList([held])).display).toBe('[ [ "a" = 1 ] ]')
		expect(describeOne(createRecord({ ages: held })).display).toBe(
			'{ ages = [ "a" = 1 ] }',
		)
	})

	it("stops drawing past the depth a row can hold", () => {
		expect(
			describeOne(createList([createList([dictionary(["alex", 39])])]))
				.display,
		).toBe("[ [ [ … ] ] ]")
	})

	it("caps what one line can hold", () => {
		let wide = dictionary(
			["a very long key indeed", 1],
			["another long key indeed", 2],
		)

		expect(describeOne(wide).display).toBe(
			'[ "a very long key indeed" = 1, … ]',
		)
	})

	it("leaves the store it drew exactly as it found it", () => {
		let box = boxAt(1, ...slots())
		let versions = box.store.slots.map((slot) => slot.versions.length)

		describeOne(box)

		expect(box.store.slots.map((slot) => slot.versions.length)).toEqual(
			versions,
		)
		expect(box.store.slots.length).toBe(3)
		expect(box.generation).toBe(1)
		expect(box.length).toBe(1)
	})
})

// NOTE: What the Variables view expands a Dictionary row into: one row per
// entry the box VIEWS, each the Record `{ key, value }` the language writes an
// entry as, holding the live key and the live value — so opening an entry opens
// what the Dictionary actually holds, and a superseded value, a tombstoned key
// and a slot written past the box are all absent.
describe("the in-debuggee Dictionary reader", () => {
	it("answers the entries a box views, in insertion order", () => {
		let written = [
			slotOf("a", [0, 1], [2, 9]),
			slotOf("b", [0, 2], [1, TOMBSTONE]),
			slotOf("c", [3, 3]),
		]

		expect(pairsOf(dictionaryEntries(boxAt(0, ...written)))).toEqual([
			["a", 1],
			["b", 2],
		])
		expect(pairsOf(dictionaryEntries(boxAt(1, ...written)))).toEqual([
			["a", 1],
		])
		expect(pairsOf(dictionaryEntries(boxAt(3, ...written)))).toEqual([
			["a", 9],
			["c", 3],
		])
	})

	it("answers nothing for a box that holds nothing", () => {
		expect(dictionaryEntries(boxAt(0))).toEqual([])
		expect(
			dictionaryEntries(boxAt(1, slotOf("a", [0, 1], [1, TOMBSTONE]))),
		).toEqual([])
	})

	it("hands the key and the value themselves back, not copies of them", () => {
		let key = createString("alex")
		let value = createInteger(39n)
		let entry = dictionaryEntries(
			boxAt(0, {
				key,
				encoded: null,
				versions: [{ value, generation: 0 }],
			}),
		)[0] as { key: unknown; value: unknown }

		expect(entry.key).toBe(key)
		expect(entry.value).toBe(value)
	})

	// NOTE: The entry wears the BOX's own tag rather than one this reader
	// mints, which is what makes it a Record to the renderer that draws the row
	// and to the view that expands it into a `key` and a `value`.
	it("answers entries the renderer draws as the Records they are", () => {
		let entry = dictionaryEntries(dictionary(["alex", 39]))[0]

		expect(describeOne(entry)).toEqual({
			display: '{ key = "alex", value = 39 }',
			kind: "record",
		})
	})

	it("answers a fresh Array of fresh entries every time", () => {
		let ages = dictionary(["alex", 39])

		expect(dictionaryEntries(ages)).not.toBe(dictionaryEntries(ages))
		expect(dictionaryEntries(ages)[0]).not.toBe(dictionaryEntries(ages)[0])
	})

	it("leaves the store it read exactly as it found it", () => {
		let box = boxAt(1, slotOf("a", [0, 1], [2, 9]))
		let versions = box.store.slots.map((slot) => slot.versions.length)

		dictionaryEntries(box)

		expect(box.store.slots.map((slot) => slot.versions.length)).toEqual(
			versions,
		)
		expect(box.length).toBe(1)
	})
})
