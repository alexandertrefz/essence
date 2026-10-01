import { describe, expect, test } from "bun:test"

import type { common } from "@essence-lang/interfaces"

import { TOMBSTONE } from "../Dictionary"
import { createInteger } from "../Integer"
import { createList } from "../List"
import { createRecord } from "../Record"
import { createString } from "../String"
import { type AnyType, createCase, isValueOfType, typeKeySymbol } from "../type"

// `CaseInstanceType` stays out of `AnyType`, so a Case value is cast here as the
// runtime helpers cast it. A Function value carries no Type key, so it is cast
// too.
const asValue = (value: unknown) => value as AnyType

const functionType: common.Type = {
	type: "Function",
	parameterTypes: [],
	generics: [],
	returnType: { type: "String" },
}

// Every name on `Object.prototype` is a function, so a Matcher for a
// Function-typed member of that name must read the value's own members only.
describe("matching against inherited members", () => {
	test("a prototype member does not satisfy a Record matcher", () => {
		let value = createRecord({ x: createInteger(1n) })

		expect(
			isValueOfType(value, {
				type: "Record",
				members: { toString: functionType },
			}),
		).toBe(false)

		expect(
			isValueOfType(value, {
				type: "Record",
				members: { hasOwnProperty: functionType },
			}),
		).toBe(false)
	})

	test("an own member of an inherited name still satisfies it", () => {
		let value = createRecord({
			toString: asValue((value: never) => value),
		})

		expect(
			isValueOfType(value, {
				type: "Record",
				members: { toString: functionType },
			}),
		).toBe(true)
	})

	test("a prototype member does not satisfy a Case payload matcher", () => {
		let value = asValue(createCase("Box#Full"))

		expect(
			isValueOfType(value, {
				type: "Case",
				choice: "Box",
				name: "Full",
				members: { valueOf: functionType },
			}),
		).toBe(false)
	})
})

// The boxes are built by hand, so the check is held to the box shape rather than
// to what `set` and `remove` write. `TOMBSTONE` is imported only to build one.
// See "Why `type.ts` reads containers itself" in packages/runtime/DEVELOPMENT.md.
describe("matching a Dictionary", () => {
	type Version = { value: unknown; generation: number }
	type Slot = { key: AnyType; encoded: unknown; versions: Array<Version> }

	// The Type check reads neither `encoded` nor `index`, so they stay empty here.
	function box(
		slots: Array<Slot>,
		generation: number,
		length: number,
	): AnyType {
		return asValue({
			[typeKeySymbol]: "Dictionary",
			store: {
				slots,
				index: new Map(),
				generation,
				dead: 0,
			},
			generation,
			length,
		})
	}

	function slot(key: AnyType, versions: Array<Version>): Slot {
		return { key, encoded: null, versions }
	}

	let stringToInteger: common.Type = {
		type: "Dictionary",
		keyType: { type: "String" },
		valueType: { type: "Integer" },
	}
	let stringToString: common.Type = {
		type: "Dictionary",
		keyType: { type: "String" },
		valueType: { type: "String" },
	}
	let bare: common.Type = {
		type: "GenericDictionary",
		generics: [
			{ name: "KeyType", defaultType: { type: "Unknown" } },
			{ name: "ValueType", defaultType: { type: "Unknown" } },
		],
	}

	let ages = box(
		[
			slot(createString("alex"), [
				{ value: createInteger(39n), generation: 0 },
			]),
			slot(createString("sam"), [
				{ value: createInteger(25n), generation: 0 },
			]),
		],
		0,
		2,
	)

	test("a Dictionary of the named slots matches", () => {
		expect(isValueOfType(ages, stringToInteger)).toBe(true)
	})

	test("a Dictionary whose values are another Type does not", () => {
		expect(isValueOfType(ages, stringToString)).toBe(false)
	})

	test("a Dictionary whose keys are another Type does not", () => {
		expect(
			isValueOfType(ages, {
				type: "Dictionary",
				keyType: { type: "Integer" },
				valueType: { type: "Integer" },
			}),
		).toBe(false)
	})

	test("an undecided slot asks nothing of that half", () => {
		expect(
			isValueOfType(ages, {
				type: "Dictionary",
				keyType: { type: "String" },
				valueType: { type: "Unknown" },
			}),
		).toBe(true)

		expect(
			isValueOfType(ages, {
				type: "Dictionary",
				keyType: { type: "Integer" },
				valueType: { type: "Unknown" },
			}),
		).toBe(false)
	})

	test("a bare Dictionary is the tag and nothing else", () => {
		expect(isValueOfType(ages, bare)).toBe(true)
		expect(isValueOfType(createRecord({}), bare)).toBe(false)
	})

	// An empty Dictionary holds no entry to disagree about, as with the empty
	// List. See "Runtime overlap" in packages/compiler/src/validator/DEVELOPMENT.md.
	test("an empty Dictionary matches every Dictionary Matcher", () => {
		expect(isValueOfType(box([], 0, 0), stringToInteger)).toBe(true)
		expect(isValueOfType(box([], 0, 0), stringToString)).toBe(true)
	})

	test("only the newest visible version of a slot is read", () => {
		let slots = [
			slot(createString("alex"), [
				{ value: createString("thirty nine"), generation: 0 },
				{ value: createInteger(39n), generation: 1 },
			]),
		]

		expect(isValueOfType(box(slots, 1, 1), stringToInteger)).toBe(true)
		expect(isValueOfType(box(slots, 1, 1), stringToString)).toBe(false)
	})

	test("an older box reads its own generation", () => {
		let slots = [
			slot(createString("alex"), [
				{ value: createString("thirty nine"), generation: 0 },
				{ value: createInteger(39n), generation: 1 },
			]),
		]

		expect(isValueOfType(box(slots, 0, 1), stringToString)).toBe(true)
		expect(isValueOfType(box(slots, 0, 1), stringToInteger)).toBe(false)
	})

	test("a removed key is no entry at all", () => {
		let slots = [
			slot(createString("alex"), [
				{ value: createInteger(39n), generation: 0 },
				{ value: TOMBSTONE, generation: 2 },
			]),
			slot(createString("sam"), [
				{ value: createString("twenty five"), generation: 1 },
			]),
		]

		expect(isValueOfType(box(slots, 2, 1), stringToString)).toBe(true)
		expect(isValueOfType(box(slots, 2, 1), stringToInteger)).toBe(false)
	})

	test("a slot written after the box holds nothing for it", () => {
		let slots = [
			slot(createString("alex"), [
				{ value: createString("thirty nine"), generation: 0 },
			]),
			slot(createString("sam"), [
				{ value: createInteger(25n), generation: 1 },
			]),
		]

		expect(isValueOfType(box(slots, 0, 1), stringToString)).toBe(true)
		expect(isValueOfType(box(slots, 1, 2), stringToString)).toBe(false)
	})

	test("the tag tells a Dictionary from a List", () => {
		expect(
			isValueOfType(createList([createInteger(1n)]), stringToInteger),
		).toBe(false)
		expect(
			isValueOfType(ages, {
				type: "List",
				itemType: { type: "Integer" },
			}),
		).toBe(false)
	})
})
