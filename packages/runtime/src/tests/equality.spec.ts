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

// NOTE: The universal comparison for a Dictionary, which is the one it can not
// answer structurally: a box reads through a SHARED store stamped with a
// generation, so two boxes holding the very same entries need not hold the same
// slots, versions or generation. What `anyIs` asks instead is what the design
// says two Dictionaries mean by equal — the same key set, and an equal value
// under each key, in whatever order they were written.
describe("comparing two Dictionaries", () => {
	// NOTE: The witness a hand-built Dictionary is keyed by here. `anyIs` uses
	// no witness of its own — there is none to hand it — so it recurses through
	// this same universal comparison, exactly as it does for a List's items.
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

	// NOTE: A Dictionary held INSIDE something else is where the structural
	// fallback used to answer wrongly — a Record carrying one compared its
	// stores field by field, so a value stopped being equal to its own copy the
	// moment it was wrapped.
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

	// NOTE: Keys and values compare through the very same universal comparison,
	// so an Integer key and the Rational spelling of it are ONE key — which is
	// what `Number.is` promises about them everywhere else.
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
