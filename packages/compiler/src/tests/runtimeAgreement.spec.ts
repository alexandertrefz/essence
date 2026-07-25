import { describe, expect, it } from "bun:test"

import type { common } from "@essence/interfaces"
import { createAlgebraic } from "@essence/runtime/Algebraic"
import { createBoolean } from "@essence/runtime/Boolean"
import { createInteger } from "@essence/runtime/Integer"
import { createList } from "@essence/runtime/List"
import { createNothing } from "@essence/runtime/Nothing"
import { equal, greater, less } from "@essence/runtime/Ordering"
import { createRational } from "@essence/runtime/Rational"
import { createRecord } from "@essence/runtime/Record"
import { createString } from "@essence/runtime/String"
import { createTranscendental } from "@essence/runtime/Transcendental"
import { type AnyType, createCase, isValueOfType } from "@essence/runtime/type"

import { loadStdlib } from "../enricher/stdlib"
import { acceptsAllAtRuntime, overlapsAtRuntime } from "../validator/index"

// NOTE: The Validator decides which Handlers of a Match can run by asking what
// a Type NAMES; the runtime decides it by asking what a value IS. Nothing says
// so when those two answers drift apart — a Handler the Validator called
// impossible runs anyway (an empty `List<Integer>` walking into `case
// List<String>`), or one it counted on never does and the Match falls off its
// chain. `acceptsAllAtRuntime` and `overlapsAtRuntime` are the two edges the
// Validator reasons between, and this file sandwiches `isValueOfType` inside
// them: whatever the first accepts ALL of, the runtime has to accept, and
// whatever the second says can not overlap, the runtime has to refuse. What is
// left between the two is slack both sides know about.

// NOTE: One Type together with values OF that Type, built the way the emitted
// JavaScript builds them — the runtime is handed values, never Types.
//
// NOTE: Sampled exactly as the Type names them: no Record here carries a member
// its Type does not declare. A wider Record is assignable to a narrower one and
// the runtime's Record check is open, while the Validator's edges are written
// on the members a Type declares — whether that width should be assignable at
// all is a question `Discussion.md` still has open, and sampling it here would
// restate that question instead of the agreement this file is about.
type Sample = { name: string; type: common.Type; values: Array<AnyType> }

const integerType: common.Type = { type: "Integer" }
const stringType: common.Type = { type: "String" }
const integerListType: common.Type = { type: "List", itemType: integerType }
const callbackType: common.Type = {
	type: "Function",
	parameterTypes: [{ name: null, type: integerType }],
	generics: [],
	returnType: integerType,
}

// NOTE: A Function reaches the runtime as a bare JavaScript function carrying
// no Type key at all, which `AnyType` deliberately does not describe — and a
// Case instance carries a tag where `AnyType` describes a kind, for the same
// reason. Both are values the emitted code passes to these checks daily.
const callback = () => ((value: never) => value) as unknown as AnyType
const caseValue = (tag: string, payload?: Record<string, AnyType>) =>
	createCase(tag, payload) as unknown as AnyType

// NOTE: `Number` and `Ordering` are taken from the standard library rather than
// spelled out here — they are the Union and the Choice real Programs match on,
// and reading them out of the Scope the Enricher starts from is what keeps this
// table from describing a language the Compiler no longer has.
const stdlibTypes = loadStdlib().types

let samples: Array<Sample> = [
	{ name: "Nothing", type: { type: "Nothing" }, values: [createNothing()] },
	{
		name: "Boolean",
		type: { type: "Boolean" },
		values: [createBoolean(true), createBoolean(false)],
	},
	{
		name: "String",
		type: stringType,
		values: [createString("hello"), createString("")],
	},
	{
		name: "Integer",
		type: integerType,
		values: [createInteger(0n), createInteger(-3n)],
	},
	{
		name: "Rational",
		type: { type: "Rational" },
		values: [createRational(1n, 2n)],
	},
	{
		name: "Algebraic",
		type: { type: "Algebraic" },
		// NOTE: √2 — `createAlgebraic` answers a Rational for a radicand that
		// collapses, which the sampling test below is what catches.
		values: [
			createAlgebraic(
				{ numerator: 0n, denominator: 1n },
				{ numerator: 1n, denominator: 1n },
				2n,
			),
		],
	},
	{
		name: "Transcendental",
		type: { type: "Transcendental" },
		// NOTE: π, as `0 + 1·π`.
		values: [
			createTranscendental(
				{ numerator: 0n, denominator: 1n },
				{ numerator: 1n, denominator: 1n },
			),
		],
	},
	{
		name: "Number",
		type: stdlibTypes.Number,
		values: [createInteger(1n), createRational(1n, 3n)],
	},
	{
		name: "{ x: Integer }",
		type: { type: "Record", members: { x: integerType } },
		values: [createRecord({ x: createInteger(1n) })],
	},
	{
		name: "{ x: Integer, y: String }",
		type: { type: "Record", members: { x: integerType, y: stringType } },
		values: [
			createRecord({ x: createInteger(1n), y: createString("here") }),
		],
	},
	{
		name: "{ items: List<Integer> }",
		type: { type: "Record", members: { items: integerListType } },
		values: [
			createRecord({ items: createList([]) }),
			createRecord({ items: createList([createInteger(1n)]) }),
		],
	},
	{
		name: "{}",
		type: { type: "Record", members: {} },
		values: [createRecord({})],
	},
	{
		name: "{ handler: (_ Integer) -> Integer }",
		type: { type: "Record", members: { handler: callbackType } },
		values: [createRecord({ handler: callback() })],
	},
	{
		name: "(_ Integer) -> Integer",
		type: callbackType,
		values: [callback()],
	},
	{
		name: "List<Integer>",
		type: integerListType,
		values: [
			createList([]),
			createList([createInteger(1n), createInteger(2n)]),
		],
	},
	{
		name: "List<String>",
		type: { type: "List", itemType: stringType },
		values: [createList([]), createList([createString("here")])],
	},
	{
		name: "List<List<Integer>>",
		type: { type: "List", itemType: integerListType },
		values: [createList([]), createList([createList([createInteger(1n)])])],
	},
	{
		name: "List",
		type: {
			type: "GenericList",
			generics: [{ name: "ItemType", defaultType: { type: "Unknown" } }],
		},
		values: [createList([]), createList([createString("here")])],
	},
	{
		name: "Box#Full<Integer>",
		type: {
			type: "Case",
			choice: "Box",
			name: "Full",
			members: { value: integerType },
		},
		values: [caseValue("Box#Full", { value: createInteger(1n) })],
	},
	{
		name: "Box#Full<String>",
		type: {
			type: "Case",
			choice: "Box",
			name: "Full",
			members: { value: stringType },
		},
		values: [caseValue("Box#Full", { value: createString("here") })],
	},
	{
		name: "Box#Full<List<Integer>>",
		type: {
			type: "Case",
			choice: "Box",
			name: "Full",
			members: { value: integerListType },
		},
		values: [
			caseValue("Box#Full", { value: createList([]) }),
			caseValue("Box#Full", { value: createList([createInteger(1n)]) }),
		],
	},
	{
		name: "Box#Empty",
		type: { type: "Case", choice: "Box", name: "Empty", members: {} },
		values: [caseValue("Box#Empty")],
	},
	{
		name: "Ordering",
		type: stdlibTypes.Ordering,
		values: [
			less as unknown as AnyType,
			equal as unknown as AnyType,
			greater as unknown as AnyType,
		],
	},
	{
		name: "Ordering#Less",
		type: { type: "Case", choice: "Ordering", name: "Less", members: {} },
		values: [less as unknown as AnyType],
	},
	{
		name: "Integer | String",
		type: { type: "UnionType", types: [integerType, stringType] },
		values: [createInteger(1n), createString("here")],
	},
	{
		name: "Integer | Nothing",
		type: { type: "UnionType", types: [integerType, { type: "Nothing" }] },
		values: [createInteger(1n), createNothing()],
	},
	// NOTE: A GenericUse and an Unknown carry no values of their own. As a
	// Matcher each takes everything, which the accepting half below asserts
	// against every value in the table. As a member Type neither NAMES any
	// value — a Type Parameter's Argument could be anything, and
	// `overlapsAtRuntime` deliberately declines to guess, because otherwise
	// every Match over a `Value | Nothing` would report an overlap — so
	// sampling them would ask the refusing half a question it does not answer.
	{
		name: "ItemType",
		type: { type: "GenericUse", name: "ItemType" },
		values: [],
	},
	{ name: "Unknown", type: { type: "Unknown" }, values: [] },
]

describe("Runtime Agreement", () => {
	// NOTE: The premise the two halves below rest on. A value sampled under the
	// wrong Type would make them assert something about a Type nothing in the
	// table is a value of, and they would still pass.
	it("should sample every Type with values of that Type", () => {
		let mistaken: Array<string> = []

		for (let sample of samples) {
			for (let [index, value] of sample.values.entries()) {
				if (!isValueOfType(value, sample.type)) {
					mistaken.push(
						`value #${index + 1} of '${sample.name}' is not a value of it`,
					)
				}
			}
		}

		expect(mistaken).toEqual([])
	})

	it("should accept every value of a Type a Matcher accepts all of", () => {
		let disagreements: Array<string> = []
		let checked = 0

		for (let matcher of samples) {
			for (let member of samples) {
				if (!acceptsAllAtRuntime(matcher.type, member.type)) {
					continue
				}

				for (let [index, value] of member.values.entries()) {
					checked++

					if (!isValueOfType(value, matcher.type)) {
						disagreements.push(
							`'${matcher.name}' accepts all of '${member.name}', but the runtime refused value #${index + 1} of it`,
						)
					}
				}
			}
		}

		expect(disagreements).toEqual([])

		// NOTE: An edge that answered false everywhere would walk this loop
		// without a single value reaching the runtime, so what was asked is
		// counted as well — every Type in the table accepts all of itself, and
		// the erasing Matchers accept all of every other.
		expect(checked).toBeGreaterThan(samples.length)
	})

	it("should refuse every value of a Type a Matcher can not overlap", () => {
		let disagreements: Array<string> = []
		let checked = 0

		for (let matcher of samples) {
			for (let member of samples) {
				if (overlapsAtRuntime(matcher.type, member.type)) {
					continue
				}

				for (let [index, value] of member.values.entries()) {
					checked++

					if (isValueOfType(value, matcher.type)) {
						disagreements.push(
							`'${matcher.name}' can not overlap '${member.name}', but the runtime accepted value #${index + 1} of it`,
						)
					}
				}
			}
		}

		expect(disagreements).toEqual([])
		expect(checked).toBeGreaterThan(samples.length)
	})

	// NOTE: The one place the two edges are deliberately apart, and the whole
	// reason there are two of them: an empty List holds no item to disagree
	// about, so it is a value of every List Type there is. `case List<String>`
	// above `case List<Integer>` therefore RUNS for an empty `List<Integer>` —
	// which the Validator may neither call unreachable nor count on.
	it("should leave the empty List between the two edges", () => {
		let strings: common.Type = { type: "List", itemType: stringType }

		expect(acceptsAllAtRuntime(strings, integerListType)).toBe(false)
		expect(overlapsAtRuntime(strings, integerListType)).toBe(true)

		expect(isValueOfType(createList([]), strings)).toBe(true)
		expect(isValueOfType(createList([createInteger(1n)]), strings)).toBe(
			false,
		)
	})
})
