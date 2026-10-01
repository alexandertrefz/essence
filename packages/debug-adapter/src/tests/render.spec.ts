import { describe, expect, it } from "bun:test"

import { createBoolean } from "@essence-lang/runtime/Boolean"
import type { DictionaryType, Slot } from "@essence-lang/runtime/Dictionary"
import { createDictionary, TOMBSTONE } from "@essence-lang/runtime/Dictionary"
import {
	of as futureOf,
	root as futureRoot,
	start as futureStart,
} from "@essence-lang/runtime/Future"
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

// Evaluated from source text, as `Runtime.callFunctionOn` does, so a binding
// captured from the module throws here.
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

// The runtime's structural comparison, branded `structural` as the compiler
// brands the standard library's equality. A debugged Dictionary of Strings is
// built through this witness.
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

// One key's slot as the versions its value has had. `[2, 9]` means the write
// of generation 2 made it 9; `TOMBSTONE` as the value is a removal.
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

// A box built by hand, so one store can hold a superseded value, a removed key
// and a slot written after the box. The indexes stay empty, since a view reads
// only the slots and their generations.
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
			texts: new Map(),
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
	// Runtime values built by the runtime's constructors render to the line
	// `getStringRepresentation` prints.
	it("agrees with the runtime's own printer", () => {
		let values = [
			createInteger(42n),
			createString("hello"),
			// Strings that need escaping: line breaks, braces, controls,
			// bidi overrides, a byte order mark and a lone surrogate.
			createString('say "hi"\n\ttwice'),
			createString("a{b}"),
			createString("esc\u001B[0m"),
			createString("\u202Ereordered\u202C"),
			createString("\uFEFFleading"),
			createString("caf\u00E9 \u{1F600}"),
			createString("half\uD800"),
			createBoolean(true),
			createRecord({}),
			createRecord({
				width: createInteger(3n),
				height: createInteger(4n),
			}),
			createList([createInteger(1n), createInteger(2n)]),
			createCase("Ordering#Less"),
			createCase("Shape#Circle", { radius: createInteger(2n) }),
			// Cases of a Program's Choices, whose tags also carry the
			// declaring Module, which the shown text drops.
			createCase("./Ordering.es#Ordering#Less"),
			createCase("./Shapes.es#Shape#Circle", {
				radius: createInteger(2n),
			}),
			createCase("./Shapes.es#Shape#Square", {
				side: createInteger(1n),
				// Cast, since `CaseInstanceType` stays out of `AnyType`.
				door: createCase("./Doors.es#Door#Shut") as never,
			}),
			// Unreduced, as `createRational` leaves them, while the printer
			// answers lowest terms.
			createRational(6n, 2n),
			createRational(2n, 4n),
			createRational(-4n, 6n),
			// Both asynchronous kinds render as bare names, never the closure
			// or promise they hold.
			futureOf(() => createInteger(1n)),
			futureStart(
				futureOf(() => createInteger(1n)),
				futureRoot(),
			),
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
		expect(describeOne(futureOf(() => createInteger(1n))).kind).toBe("leaf")
		expect(
			describeOne(
				createCase("Shape#Circle", { radius: createInteger(2n) }),
			).kind,
		).toBe("record")
	})

	// Where the renderer differs from the runtime on purpose: a Variables row
	// is one line, so a value printed across several is truncated.
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

// A List's runs are shared with its chain, so a box's view and its Arrays come
// apart when either end grows. Another box may append, or a front run may be
// stored backwards.
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
		// After the renderer, since the runtime's printer materialises
		// the box it prints.
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

// What the Variables view expands a List row into. The items are the live
// ones, so expanding one opens the nested value.
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

// A Dictionary's store is shared with its chain. It carries superseded
// values, values written after a box, and tombstones, none of which a box
// shows.
describe("the in-debuggee renderer, over a Dictionary's shared store", () => {
	// `a` written twice, `b` removed and `c` added last, viewed by boxes of
	// different generations.
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

		// A store keeps the first key box that arrived, which may be an
		// unreduced Rational such as `6/2`. It is drawn reduced, as the Program
		// prints it.
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

// What the Variables view expands a Dictionary row into: one `{ key, value }`
// Record per entry the box views, holding the live key and value.
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

	// The entry carries the box's own tag symbol, so the renderer reads it as
	// a Record.
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
