import { describe, expect, test } from "bun:test"

import { createBoolean } from "../Boolean"
import { createInteger } from "../Integer"
import { anyIs, anyIsNot } from "../internalHelpers"
import { createList } from "../List"
import { createRational } from "../Rational"
import { createRecord } from "../Record"
import { createString } from "../String"
import { type AnyType, createCase } from "../type"

// NOTE: `CaseInstanceType` is deliberately kept out of `AnyType` — see the NOTE
// in `type.ts` — so a Case value is cast on the way in here exactly as the
// runtime helpers cast it internally.
const asValue = (value: unknown) => value as AnyType

// NOTE: A Function reaches the runtime as a bare JavaScript function carrying
// no Type key at all, which is why comparing one needs a cell of its own.
const functionValue = () => asValue((value: never) => value)

describe("reflexive equality", () => {
	// NOTE: The claim the fast path rests on — a value is equal to itself — and
	// it has to hold for every kind, including the ones whose comparison is a
	// recursive walk.
	test("every value is equal to itself", () => {
		let cases: Array<[string, AnyType]> = [
			["Boolean", createBoolean(true)],
			["String", createString("café")],
			["Integer", createInteger(7n)],
			["Rational", createRational(4n, 2n)],
			["unit Case", asValue(createCase("Colour#Red"))],
			[
				"Case with a payload",
				asValue(
					createCase("Wrapper#Text", { item: createString("a") }),
				),
			],
			["Record", createRecord({ x: createInteger(1n) })],
			["List", createList([createInteger(1n), createInteger(2n)])],
			["Function", functionValue()],
		]

		for (let [kind, value] of cases) {
			expect(anyIs(value, value), kind).toBeTrue()
			expect(anyIsNot(value, value), kind).toBeFalse()
		}
	})

	// NOTE: A container holding a Function is the interesting one — the walk
	// reaches identity comparison at the leaf, which answers true for the SAME
	// Function, so the shortcut and the walk agree here too.
	test("a container holding a Function is equal to itself", () => {
		let callback = functionValue()

		let record = createRecord({ run: callback })
		let list = createList([callback])
		let payload = asValue(createCase("Handler#On", { run: callback }))

		expect(anyIs(record, record)).toBeTrue()
		expect(anyIs(list, list)).toBeTrue()
		expect(anyIs(payload, payload)).toBeTrue()
	})

	// NOTE: The shortcut must not have REPLACED the structural comparison —
	// two values built separately still have to be walked, and still answer
	// what they always did.
	test("distinct values are still compared structurally", () => {
		expect(
			anyIs(
				createRecord({
					x: createInteger(1n),
					items: createList([createString("a")]),
				}),
				createRecord({
					x: createInteger(1n),
					items: createList([createString("a")]),
				}),
			),
		).toBeTrue()

		expect(
			anyIs(
				createRecord({ x: createInteger(1n) }),
				createRecord({ x: createInteger(2n) }),
			),
		).toBeFalse()

		expect(
			anyIs(
				asValue(
					createCase("Wrapper#Text", { item: createString("a") }),
				),
				asValue(
					createCase("Wrapper#Text", { item: createString("a") }),
				),
			),
		).toBeTrue()

		expect(
			anyIs(
				asValue(
					createCase("Wrapper#Text", { item: createString("a") }),
				),
				asValue(
					createCase("Wrapper#Text", { item: createString("b") }),
				),
			),
		).toBeFalse()

		// NOTE: Two Functions written the same are still two Functions.
		expect(anyIs(functionValue(), functionValue())).toBeFalse()
	})

	// NOTE: The comparisons that cross kinds are the ones the shortcut can not
	// answer, and they keep answering false.
	test("values of different kinds are still unequal", () => {
		expect(anyIs(createInteger(1n), createBoolean(true))).toBeFalse()
		expect(anyIs(createString("1"), createInteger(1n))).toBeFalse()
		expect(
			anyIs(asValue(createCase("Colour#Red")), createRecord({})),
		).toBeFalse()
		expect(anyIs(functionValue(), createRecord({}))).toBeFalse()
	})
})
