import { describe, expect, test } from "bun:test"

import { createBoolean } from "../Boolean"
import { createDictionary } from "../Dictionary"
import { createInteger } from "../Integer"
import { anyIs, anyIsNot } from "../internalHelpers"
import { createList } from "../List"
import { createRational } from "../Rational"
import { createRecord } from "../Record"
import { createString } from "../String"
import { type AnyType, createCase } from "../type"

// `CaseInstanceType` stays out of `AnyType`, so a Case value is cast here as the
// runtime helpers cast it.
const asValue = (value: unknown) => value as AnyType

// A Function reaches the runtime as a bare JavaScript function with no Type key.
const functionValue = () => asValue((value: never) => value)

describe("reflexive equality", () => {
	// `anyIs` answers identical operands first, so this must hold for every
	// kind, including those compared by a recursive walk.
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

	// The walk compares a Function leaf by identity, so it agrees with the
	// identity check.
	test("a container holding a Function is equal to itself", () => {
		let callback = functionValue()

		let record = createRecord({ run: callback })
		let list = createList([callback])
		let payload = asValue(createCase("Handler#On", { run: callback }))

		expect(anyIs(record, record)).toBeTrue()
		expect(anyIs(list, list)).toBeTrue()
		expect(anyIs(payload, payload)).toBeTrue()
	})

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

		// Two Functions written the same are still two Functions.
		expect(anyIs(functionValue(), functionValue())).toBeFalse()
	})

	test("values of different kinds are still unequal", () => {
		expect(anyIs(createInteger(1n), createBoolean(true))).toBeFalse()
		expect(anyIs(createString("1"), createInteger(1n))).toBeFalse()
		expect(
			anyIs(asValue(createCase("Colour#Red")), createRecord({})),
		).toBeFalse()
		expect(anyIs(functionValue(), createRecord({}))).toBeFalse()
	})
})

// Equal boxes need not share slots, versions or a generation, so `anyIs`
// compares the key sets and the value under each key, in any order. See
// "Dictionary equality" in packages/runtime/DEVELOPMENT.md.
describe("comparing two Dictionaries", () => {
	// The key witness is the universal comparison, the one `anyIs` looks keys up
	// by.
	const anyEquatable = {
		is: (a: AnyType, b: AnyType) => createBoolean(anyIs(a, b)),
	}

	function dictionaryOf(entries: Array<[AnyType, AnyType]>): AnyType {
		return createDictionary(entries, anyEquatable) as AnyType
	}

	let alex = createString("alex")
	let sam = createString("sam")

	test("two Dictionaries built the same way are equal", () => {
		expect(
			anyIs(
				dictionaryOf([
					[alex, createInteger(39n)],
					[sam, createInteger(25n)],
				]),
				dictionaryOf([
					[alex, createInteger(39n)],
					[sam, createInteger(25n)],
				]),
			),
		).toBeTrue()
	})

	test("the order the entries were written in does not decide", () => {
		expect(
			anyIs(
				dictionaryOf([
					[alex, createInteger(39n)],
					[sam, createInteger(25n)],
				]),
				dictionaryOf([
					[sam, createInteger(25n)],
					[alex, createInteger(39n)],
				]),
			),
		).toBeTrue()
	})

	test("a differing value under a shared key is unequal", () => {
		expect(
			anyIs(
				dictionaryOf([[alex, createInteger(39n)]]),
				dictionaryOf([[alex, createInteger(40n)]]),
			),
		).toBeFalse()
	})

	test("a key one of them does not hold is unequal", () => {
		expect(
			anyIs(
				dictionaryOf([[alex, createInteger(39n)]]),
				dictionaryOf([[sam, createInteger(39n)]]),
			),
		).toBeFalse()
	})

	test("a Dictionary holding more entries is unequal", () => {
		expect(
			anyIs(
				dictionaryOf([[alex, createInteger(39n)]]),
				dictionaryOf([
					[alex, createInteger(39n)],
					[sam, createInteger(25n)],
				]),
			),
		).toBeFalse()
	})

	test("the empty Dictionary is equal to the empty Dictionary", () => {
		expect(anyIs(dictionaryOf([]), dictionaryOf([]))).toBeTrue()
		expect(
			anyIs(dictionaryOf([]), dictionaryOf([[alex, createInteger(1n)]])),
		).toBeFalse()
	})

	// Comparing the stores field by field would make a wrapped Dictionary
	// unequal to its own copy.
	test("a Record holding one compares by the entries it holds", () => {
		expect(
			anyIs(
				createRecord({
					ages: dictionaryOf([[alex, createInteger(39n)]]),
				}),
				createRecord({
					ages: dictionaryOf([[alex, createInteger(39n)]]),
				}),
			),
		).toBeTrue()
	})

	// An Integer key and its Rational spelling are one key, as `Number.is`
	// promises everywhere else.
	test("keys compare by value rather than by spelling", () => {
		expect(
			anyIs(
				dictionaryOf([[createInteger(3n), createString("three")]]),
				dictionaryOf([[createRational(3n, 1n), createString("three")]]),
			),
		).toBeTrue()
	})

	test("a Dictionary is not equal to a List or a Record", () => {
		expect(anyIs(dictionaryOf([]), createList([]))).toBeFalse()
		expect(anyIs(dictionaryOf([]), createRecord({}))).toBeFalse()
	})
})
