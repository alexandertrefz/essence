import { describe, expect, it } from "bun:test"

import { createBoolean } from "@essence-lang/runtime/Boolean"
import type { IntegerType } from "@essence-lang/runtime/Integer"
import { createInteger } from "@essence-lang/runtime/Integer"
import {
	append__overload$1 as append,
	createList,
	type ListType,
	prepend__overload$1 as prepend,
} from "@essence-lang/runtime/List"
import { createRecord } from "@essence-lang/runtime/Record"
import { createString } from "@essence-lang/runtime/String"
import { getStringRepresentation } from "@essence-lang/runtime/Terminal"
import { createCase } from "@essence-lang/runtime/type"

import {
	type DescribedValue,
	DESCRIBE_BATCH_SOURCE,
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

function describeOne(value: unknown): DescribedValue {
	return (JSON.parse(describeBatch(value)) as Array<DescribedValue>)[0]!
}

const integers = (...values: Array<number>): ListType<IntegerType> =>
	createList(values.map((value) => createInteger(BigInt(value))))

const valuesOf = (items: Array<unknown>): Array<number | bigint> =>
	items.map((item) => (item as IntegerType).value)

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
