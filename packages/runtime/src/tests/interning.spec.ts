import { describe, expect, test } from "bun:test"

import {
	createBoolean,
	falseInstance,
	is as booleanIs,
	negate,
	trueInstance,
} from "../Boolean"

describe("interned Booleans", () => {
	test("both values are the one instance each", () => {
		expect(createBoolean(true)).toBe(trueInstance)
		expect(createBoolean(false)).toBe(falseInstance)
		expect(createBoolean(true)).toBe(createBoolean(true))
		expect(createBoolean(false)).toBe(createBoolean(false))
		expect(createBoolean(true)).not.toBe(createBoolean(false))
	})

	// NOTE: The instances are what the Methods answer with too — a shared value
	// is only a saving if the Methods reach it, and `negate` returning a fresh
	// object would leave every `not()` allocating.
	test("the Methods answer with the shared instances", () => {
		expect(negate(trueInstance)).toBe(falseInstance)
		expect(negate(falseInstance)).toBe(trueInstance)
		expect(booleanIs(trueInstance, trueInstance)).toBe(trueInstance)
		expect(booleanIs(trueInstance, falseInstance)).toBe(falseInstance)
	})

	// NOTE: Sharing is invisible: equality still goes by the value carried, so
	// a Boolean answers exactly what it answered when every call built its own.
	test("equality is unchanged by the sharing", () => {
		expect(createBoolean(true).value).toBe(true)
		expect(createBoolean(false).value).toBe(false)
		expect(booleanIs(createBoolean(true), createBoolean(true)).value).toBe(
			true,
		)
		expect(booleanIs(createBoolean(true), createBoolean(false)).value).toBe(
			false,
		)
		expect(
			booleanIs(createBoolean(false), createBoolean(false)).value,
		).toBe(true)
	})
})
