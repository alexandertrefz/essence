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

// `CaseInstanceType` stays out of `AnyType`, so a Case value is cast here as the
// runtime helpers cast it.
const asValue = (value: unknown) => value as AnyType

describe("interned Booleans", () => {
	test("both values are the one instance each", () => {
		expect(createBoolean(true)).toBe(trueInstance)
		expect(createBoolean(false)).toBe(falseInstance)
		expect(createBoolean(true)).toBe(createBoolean(true))
		expect(createBoolean(false)).toBe(createBoolean(false))
		expect(createBoolean(true)).not.toBe(createBoolean(false))
	})

	// A fresh object from `negate` would make every `not()` allocate.
	test("the Methods answer with the shared instances", () => {
		expect(negate(trueInstance)).toBe(falseInstance)
		expect(negate(falseInstance)).toBe(trueInstance)
		expect(booleanIs(trueInstance, trueInstance)).toBe(trueInstance)
		expect(booleanIs(trueInstance, falseInstance)).toBe(falseInstance)
	})

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

		// Two Modules may each declare a `Colour` with a `Red`, and they are
		// different Cases.
		expect(createCase("./Main.es#Colour#Red")).not.toBe(
			createCase("Colour#Red"),
		)
	})

	// Two values of a payload Case may carry different members, so neither is
	// shared.
	test("a Case carrying a payload is built fresh every time", () => {
		let first = createCase("Wrapper#Text", { item: createString("a") })
		let second = createCase("Wrapper#Text", { item: createString("a") })

		expect(first).not.toBe(second)
		expect(anyIs(asValue(first), asValue(second))).toBeTrue()
	})

	// The tag lives on a Symbol key, so Record equality, the printer and the
	// runtime Type checks, which read string keys, see an empty payload.
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

	// The builtin Choices keep their own Module constants, so `createCase`
	// builds a different instance of the same Case. Tag equality makes the two
	// equal.
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
