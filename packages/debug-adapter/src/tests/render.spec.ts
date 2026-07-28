import { describe, expect, it } from "bun:test"

import { createBoolean } from "@essence-lang/runtime/Boolean"
import { getStringRepresentation } from "@essence-lang/runtime/functions"
import { createInteger } from "@essence-lang/runtime/Integer"
import { createList } from "@essence-lang/runtime/List"
import { createRecord } from "@essence-lang/runtime/Record"
import { createString } from "@essence-lang/runtime/String"
import { createCase } from "@essence-lang/runtime/type"

import { type DescribedValue, DESCRIBE_BATCH_SOURCE } from "../render"

// NOTE: The renderer travels to the debuggee as source text — evaluating it
// here, the way `Runtime.callFunctionOn` does over there, proves it is
// genuinely self-contained: a captured binding would throw the moment it runs
// outside its module.
const describeBatch = (0, eval)(`(${DESCRIBE_BATCH_SOURCE})`) as (
	...values: Array<unknown>
) => string

function describeOne(value: unknown): DescribedValue {
	return (JSON.parse(describeBatch(value)) as Array<DescribedValue>)[0]!
}

describe("the in-debuggee renderer", () => {
	// NOTE: The display contract is `getStringRepresentation` itself — the
	// REAL runtime values, built by the REAL constructors, must render to the
	// very line `__print` would have printed.
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
