import { describe, expect, test } from "bun:test"

import {
	createBoolean,
	falseInstance,
	is as booleanIs,
	negate,
	trueInstance,
} from "../Boolean"
import { anyIs } from "../internalHelpers"
import { createEmpty, createValue } from "../Optional"
import { equal, greater, less } from "../Ordering"
import { createString } from "../String"
import { getStringRepresentation } from "../Terminal"
import { type AnyType, createCase, typeKeySymbol } from "../type"

// NOTE: `CaseInstanceType` is deliberately kept out of `AnyType` — its
// `[typeKeySymbol]: string` would defeat the tag narrowing every runtime helper
// relies on — so a Case value is cast on the way in here exactly as the helpers
// cast it internally.
const asValue = (value: unknown) => value as AnyType

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

describe("interned unit Cases", () => {
	test("one instance per tag", () => {
		expect(createCase("Colour#Red")).toBe(createCase("Colour#Red"))
		expect(createCase("Colour#Red")).not.toBe(createCase("Colour#Green"))

		// NOTE: Module-qualified tags are distinct Cases — two Modules may each
		// declare a `Colour` with a `Red`, and they are not the same Case.
		expect(createCase("./Main.es#Colour#Red")).not.toBe(
			createCase("Colour#Red"),
		)
	})

	// NOTE: A Case WITH a payload is not a candidate — two values of it carry
	// different members, so each one is its own value and has to be built.
	test("a Case carrying a payload is built fresh every time", () => {
		let first = createCase("Wrapper#Text", { item: createString("a") })
		let second = createCase("Wrapper#Text", { item: createString("a") })

		expect(first).not.toBe(second)
		expect(anyIs(asValue(first), asValue(second))).toBeTrue()
	})

	// NOTE: The shared instance carries the tag and nothing else, which is what
	// keeps it indistinguishable — the tag lives on a Symbol key, so Record
	// equality, the printer and the runtime Type checks, which all read string
	// keys, see an empty payload exactly as they did before.
	test("the shared instance carries nothing but its tag", () => {
		let instance = createCase("Colour#Red")

		expect(Object.keys(instance)).toEqual([])
		expect(instance[typeKeySymbol]).toBe("Colour#Red")
		expect(getStringRepresentation(asValue(instance))).toBe("Colour#Red")
	})

	test("equality is unchanged by the sharing", () => {
		let red = asValue(createCase("Colour#Red"))
		let green = asValue(createCase("Colour#Green"))

		expect(anyIs(red, red)).toBeTrue()
		expect(anyIs(red, asValue(createCase("Colour#Red")))).toBeTrue()
		expect(anyIs(red, green)).toBeFalse()
	})

	// NOTE: The builtin Choices keep their own Module consts, so a value built
	// through `createCase` and one of those is a DIFFERENT instance of the same
	// Case. That is exactly what tag equality is for: the two are equal, which
	// is the only question the language can ask about them.
	test("a builtin Choice's own consts compare equal through it", () => {
		expect(anyIs(less, asValue(createCase("Ordering#Less")))).toBeTrue()
		expect(anyIs(equal, asValue(createCase("Ordering#Equal")))).toBeTrue()
		expect(
			anyIs(greater, asValue(createCase("Ordering#Greater"))),
		).toBeTrue()
		expect(anyIs(less, asValue(createCase("Ordering#Greater")))).toBeFalse()

		expect(
			anyIs(
				asValue(createEmpty()),
				asValue(createCase("Optional#Empty")),
			),
		).toBeTrue()
		expect(
			anyIs(
				asValue(createEmpty()),
				asValue(createValue(createString("a"))),
			),
		).toBeFalse()
	})
})
