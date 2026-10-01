import { describe, expect, it } from "bun:test"

import type { common } from "@essence-lang/interfaces"
import { createAlgebraic } from "@essence-lang/runtime/Algebraic"
import { createBoolean } from "@essence-lang/runtime/Boolean"
import { createInteger } from "@essence-lang/runtime/Integer"
import { createList } from "@essence-lang/runtime/List"
import { createEmpty, createValue } from "@essence-lang/runtime/Optional"
import { equal, greater, less } from "@essence-lang/runtime/Ordering"
import { createRational } from "@essence-lang/runtime/Rational"
import { createRecord } from "@essence-lang/runtime/Record"
import { createString } from "@essence-lang/runtime/String"
import { createTranscendental } from "@essence-lang/runtime/Transcendental"
import {
	type AnyType,
	createCase,
	isValueOfType,
} from "@essence-lang/runtime/type"

import { loadStdlib } from "../enricher/stdlib"
import { applyGenericBindings } from "../helpers/types"
import { acceptsAllAtRuntime, overlapsAtRuntime } from "../validator/index"

// The Validator decides which Handlers can run from Types, the runtime from
// values. `isValueOfType` must accept whatever `acceptsAllAtRuntime` accepts
// all of, and refuse whatever `overlapsAtRuntime` says can not overlap. See
// "Runtime overlap" in packages/compiler/src/validator/DEVELOPMENT.md.

// One Type with values of it, built the way the emitted JavaScript builds
// them. No Record here carries a member its Type does not declare, since the
// edges reason about declared members only.
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

// A Function reaches the runtime as a bare JavaScript function with no Type
// key, and a Case instance carries a tag. `AnyType` describes neither.
const callback = () => ((value: never) => value) as unknown as AnyType
const caseValue = (tag: string, payload?: Record<string, AnyType>) =>
	createCase(tag, payload) as unknown as AnyType

// `Number` and `Ordering` are read out of the standard library, so the table
// describes the Types real Programs match on.
const stdlibTypes = loadStdlib().types

// `Optional` too, with its Type Argument substituted into the real
// declaration.
function optionalOf(itemType: common.Type): common.Type {
	let optional = stdlibTypes.Optional

	if (optional.type !== "GenericAlias") {
		throw new Error("`Optional` is no longer a generic Type Alias")
	}

	return applyGenericBindings(
		optional.aliasedType,
		new Map([["ItemType", itemType]]),
	)
}

let samples: Array<Sample> = [
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
		// √2. `createAlgebraic` answers a Rational for a radicand that
		// collapses, which the sampling spec would catch.
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
		// π, as the single-term span `0 + 1·π`.
		values: [
			createTranscendental({ numerator: 0n, denominator: 1n }, [
				{ base: "π", coefficient: { numerator: 1n, denominator: 1n } },
			]),
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
	// `Optional` is a Choice, so the edges agree about a Union of two Cases
	// whose tags the runtime reads off the value.
	{
		name: "Optional<Integer>",
		type: optionalOf(integerType),
		values: [
			createValue(createInteger(1n)) as unknown as AnyType,
			createEmpty() as unknown as AnyType,
		],
	},
	{
		name: "Optional<String>",
		type: optionalOf(stringType),
		values: [
			createValue(createString("here")) as unknown as AnyType,
			createEmpty() as unknown as AnyType,
		],
	},
	// A GenericUse and an Unknown carry no values of their own. As a Matcher
	// each takes every value in the table. As a member Type neither names a
	// value, and `overlapsAtRuntime` does not count it as an overlap.
	{
		name: "ItemType",
		type: { type: "GenericUse", name: "ItemType" },
		values: [],
	},
	{ name: "Unknown", type: { type: "Unknown" }, values: [] },
]

describe("Runtime Agreement", () => {
	// The premise of the agreement specs: a value sampled under the wrong Type
	// would let them pass vacuously.
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

		// An edge that answered false everywhere would ask the runtime
		// nothing, so the questions are counted too.
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

	// An empty List is a value of every List Type, so `case List<String>`
	// before `case List<Integer>` takes an empty `List<Integer>`.
	it("should leave the empty List between the two edges", () => {
		let strings: common.Type = { type: "List", itemType: stringType }

		expect(acceptsAllAtRuntime(strings, integerListType)).toBe(false)
		expect(overlapsAtRuntime(strings, integerListType)).toBe(true)

		expect(isValueOfType(createList([]), strings)).toBe(true)
		expect(isValueOfType(createList([createInteger(1n)]), strings)).toBe(
			false,
		)
	})

	// No value reaches the runtime under a refinement, so it is not sampled.
	// Both edges must answer about one exactly as about its base.
	describe("A checked refinement", () => {
		function refined(base: common.Type): common.Type {
			return {
				type: "Refinement",
				name: "Proven",
				base,
				conjuncts: [
					{
						namespaceName: "Integer",
						methodName: "is",
						negated: true,
						args: ["0"],
					},
				],
			}
		}

		// Every base against every Type, on both sides of both edges, since a
		// refinement can stand wherever its base can.
		it("should answer at both edges exactly as its base does", () => {
			let disagreements: Array<string> = []

			for (let base of samples) {
				for (let other of samples) {
					let asked: Array<
						[
							string,
							(
								matcher: common.Type,
								member: common.Type,
							) => boolean,
						]
					> = [
						["accepts all", acceptsAllAtRuntime],
						["overlaps", overlapsAtRuntime],
					]

					for (let [edge, ask] of asked) {
						if (
							ask(refined(base.type), other.type) !==
							ask(base.type, other.type)
						) {
							disagreements.push(
								`'${base.name}' refined ${edge} '${other.name}' differently as a Matcher`,
							)
						}

						if (
							ask(other.type, refined(base.type)) !==
							ask(other.type, base.type)
						) {
							disagreements.push(
								`'${other.name}' ${edge} a refined '${base.name}' differently as a member Type`,
							)
						}
					}
				}
			}

			expect(disagreements).toEqual([])
		})

		// Each edge erases the whole Type, so a List of refined items is a
		// `List<Integer>` to both.
		it("should answer the same for one buried in a List", () => {
			let refinedItems: common.Type = {
				type: "List",
				itemType: refined(integerType),
			}

			expect(acceptsAllAtRuntime(refinedItems, integerListType)).toBe(
				true,
			)
			expect(acceptsAllAtRuntime(integerListType, refinedItems)).toBe(
				true,
			)
			expect(
				acceptsAllAtRuntime(refinedItems, {
					type: "List",
					itemType: stringType,
				}),
			).toBe(false)
		})
	})
})
