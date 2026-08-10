import { describe, expect, test } from "bun:test"

import type { common } from "@essence-lang/interfaces"

import { createInteger } from "../Integer"
import { createRecord } from "../Record"
import { type AnyType, createCase, isValueOfType } from "../type"

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
