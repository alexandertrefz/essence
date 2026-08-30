import { describe, expect, test } from "bun:test"

import type { common } from "@essence-lang/interfaces"

import { TOMBSTONE } from "../Dictionary"
import { createInteger } from "../Integer"
import { createList } from "../List"
import { createRecord } from "../Record"
import { createString } from "../String"
import { type AnyType, createCase, isValueOfType, typeKeySymbol } from "../type"

// NOTE: `CaseInstanceType` is deliberately kept out of `AnyType` — see the NOTE
// in `type.ts` — so a Case value is cast on the way in here exactly as the
// runtime helpers cast it internally. A Function value carries no Type key at
// all, so it is cast the same way.
const asValue = (value: unknown) => value as AnyType

const functionType: common.Type = {
	type: "Function",
	parameterTypes: [],
	generics: [],
	returnType: { type: "String" },
}

// NOTE: Every plain object inherits `toString`, `valueOf` and the rest of
// `Object.prototype`, and each of those is a function — so a Matcher naming a
// Function-typed member of one of those names asks exactly the question the
// prototype chain answers wrongly. These tests hold the checks to the value's
// OWN members.
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

// NOTE: The Dictionary arm of the runtime Type check, against boxes built BY
// HAND rather than through the Dictionary Module's own writers. That is the
// point of them: what `isValueOfType` reads is the box SHAPE — `store.slots` in
// insertion order, the newest version each slot's generation lets a box see —
// and a test that built its boxes through `set` and `remove` would agree with
// those writers rather than with the shape they promise to leave behind.
//
// NOTE: `TOMBSTONE` is imported because it is the one part of the shape that is
// an identity rather than a layout. The check itself does not import it — see
// the NOTE on `everyLiveEntry` — and asks whether a version holds a SYMBOL,
// which no Essence value is.
describe("matching a Dictionary", () => {
	type Version = { value: unknown; generation: number }
	type Slot = { key: AnyType; encoded: unknown; versions: Array<Version> }

	// NOTE: `encoded` and `index` are the FAST PATH and nothing the Type check
	// reads — every slot here takes the scan-path `null` so that a test which
	// passed on the encodings alone can not pass at all.
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

	// NOTE: Each slot stops at the tag on its OWN, so a Matcher that names one
	// and leaves the other undecided walks the half it named and asks nothing
	// of the other.
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

	// NOTE: An empty Dictionary holds no entry to disagree about, so it is a
	// value of every Dictionary Type there is — the same rule the empty List
	// gets, and the reason the Validator's `overlapsAtRuntime` answers true for
	// any two of them.
	test("an empty Dictionary matches every Dictionary Matcher", () => {
		expect(isValueOfType(box([], 0, 0), stringToInteger)).toBe(true)
		expect(isValueOfType(box([], 0, 0), stringToString)).toBe(true)
	})

	// NOTE: The live view, which is the whole of what a box holds: the NEWEST
	// version its generation can see, never an older one that is still standing
	// in the slot.
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

	// NOTE: And an OLDER box reading the same store still sees what it saw. This
	// is the generation stamp doing its work: the tip's write is standing in the
	// slot and is not this box's.
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

	// NOTE: A slot whose newest visible version is a tombstone holds no entry,
	// so what it used to hold is no part of what the box is checked against.
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

	// NOTE: A slot written AFTER this box has no version it can see at all, and
	// holds no entry for it either.
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

	// NOTE: The tag decides first, in both directions — a List is no Dictionary
	// however its items line up, and a Dictionary answers no List Matcher.
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
