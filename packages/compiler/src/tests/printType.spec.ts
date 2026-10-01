import { describe, expect, it } from "bun:test"

import type { common } from "@essence-lang/interfaces"

import {
	caseHeader,
	describeSignature,
	printCaseWithPayload,
	printRecordWithMembers,
	printSignatureSummary,
	printType,
	signaturesOf,
} from "../printType"

let integer: common.Type = { type: "Integer" }
let string: common.Type = { type: "String" }

function genericUse(name: string): common.GenericUse {
	return { type: "GenericUse", name }
}

describe("printType", () => {
	describe("Cases of a generic Choice", () => {
		it("should print an instantiated Case with its applied Type Arguments", () => {
			let done: common.CaseType = {
				type: "Case",
				choice: "Step",
				name: "Done",
				members: { value: string },
				typeArguments: [integer, string],
			}

			expect(printType(done)).toBe("Step<Integer, String>#Done")
			expect(caseHeader(done)).toBe("Step<Integer, String>#Done")
			expect(printCaseWithPayload(done)).toBe(
				"Step<Integer, String>#Done { value: String }",
			)
		})

		it("should print a partly bound Case, keeping the open Parameter's name", () => {
			let done: common.CaseType = {
				type: "Case",
				choice: "Step",
				name: "Done",
				members: { value: genericUse("Result") },
				typeArguments: [integer, genericUse("Result")],
			}

			expect(printType(done)).toBe("Step<Integer, Result>#Done")
		})

		// A declared Case has no `typeArguments`, and a fully unbound one holds
		// only same-named GenericUses. Neither prints a `<…>` that echoes the header.
		it("should print a declared Case tersely", () => {
			let declared: common.CaseType = {
				type: "Case",
				choice: "Step",
				name: "Done",
				members: { value: genericUse("Result") },
				choiceGenerics: [
					{ name: "State", infer: false, defaultType: null },
					{ name: "Result", infer: false, defaultType: null },
				],
			}

			expect(printType(declared)).toBe("Step#Done")
		})

		it("should print a fully unbound instantiation tersely", () => {
			let unbound: common.CaseType = {
				type: "Case",
				choice: "Step",
				name: "Done",
				members: { value: genericUse("Result") },
				typeArguments: [genericUse("State"), genericUse("Result")],
			}

			expect(printType(unbound)).toBe("Step#Done")
		})

		it("should leave a non-generic Case untouched", () => {
			let red: common.CaseType = {
				type: "Case",
				choice: "Colour",
				name: "Red",
				members: {},
			}

			expect(printType(red)).toBe("Colour#Red")
			expect(printCaseWithPayload(red)).toBe("Colour#Red")
		})

		it("should print a payload-less instantiated Case without braces", () => {
			let empty: common.CaseType = {
				type: "Case",
				choice: "Box",
				name: "Empty",
				members: {},
				typeArguments: [integer],
			}

			expect(printCaseWithPayload(empty)).toBe("Box<Integer>#Empty")
		})
	})

	// A Module's Case is identified by the Module's canonical path, which
	// readers never see. Hover, Completion and Document Symbols print a Case
	// through these, so the Choice is named as the declaration wrote it.
	describe("Cases of a Module's Choice", () => {
		it("should print the Choice's name without its Module path", () => {
			let red: common.CaseType = {
				type: "Case",
				choice: "/modules/Colour.es#Colour",
				name: "Red",
				members: {},
			}

			expect(printType(red)).toBe("Colour#Red")
			expect(caseHeader(red)).toBe("Colour#Red")
			expect(printCaseWithPayload(red)).toBe("Colour#Red")
		})

		it("should print an instantiated Case of one under its applied spelling", () => {
			let full: common.CaseType = {
				type: "Case",
				choice: "/modules/Box.es#Box",
				name: "Full",
				members: { value: integer },
				typeArguments: [integer],
			}

			expect(printCaseWithPayload(full)).toBe(
				"Box<Integer>#Full { value: Integer }",
			)
		})
	})

	// An overloaded free Function such as `loop` resolves to an
	// `OverloadedStaticMethod` callee, which Hover and Signature Help print. A
	// Program cannot declare one, so the fixture is built by hand.
	describe("Overloaded free Functions", () => {
		let overloaded: common.OverloadedStaticMethodType = {
			type: "OverloadedStaticMethod",
			overloads: [
				{
					parameterTypes: [{ name: null, type: integer }],
					generics: [],
					returnType: integer,
				},
				{
					parameterTypes: [
						{ name: null, type: integer },
						{ name: "and", type: integer },
					],
					generics: [],
					returnType: integer,
				},
			],
		}

		it("should expand to one signature per Overload", () => {
			expect(signaturesOf(overloaded)).toHaveLength(2)
		})

		it("should summarise as the first signature plus a count", () => {
			expect(printType(overloaded)).toBe(
				"(_ Integer) -> Integer (+1 overload)",
			)
			expect(printSignatureSummary(overloaded.overloads, "loop")).toBe(
				"loop(_ Integer) -> Integer (+1 overload)",
			)
		})

		it("should describe each Overload on its own", () => {
			expect(
				(signaturesOf(overloaded) ?? []).map(
					(signature) => describeSignature(signature, "loop").label,
				),
			).toEqual([
				"loop(_ Integer) -> Integer",
				"loop(_ Integer, and: Integer) -> Integer",
			])
		})
	})

	// A checked refinement prints under its name, never as its predicate such
	// as `Integer where @::isNot(0)`, which belongs to the declaration.
	describe("Checked refinements", () => {
		let nonZeroInteger: common.Type = {
			type: "Refinement",
			name: "NonZeroInteger",
			base: integer,
			conjuncts: [
				{
					namespaceName: "Integer",
					methodName: "is",
					negated: true,
					args: ["0"],
				},
			],
		}

		it("should print under the alias name", () => {
			expect(printType(nonZeroInteger)).toBe("NonZeroInteger")
		})

		it("should print inside the Types that hold one", () => {
			expect(printType({ type: "List", itemType: nonZeroInteger })).toBe(
				"List<NonZeroInteger>",
			)
			expect(
				printType({
					type: "Record",
					members: { divisor: nonZeroInteger },
				}),
			).toBe("{ divisor: NonZeroInteger }")
		})

		it("should print a Signature taking and answering one", () => {
			expect(
				describeSignature(
					{
						parameterTypes: [{ name: "by", type: nonZeroInteger }],
						generics: [],
						returnType: nonZeroInteger,
					},
					"divide",
				).label,
			).toBe("divide(by: NonZeroInteger) -> NonZeroInteger")
		})

		// An applied generic refinement prints as applied, since `NonEmptyList`
		// alone names half a Type. One whose Arguments are all Type Parameters
		// stays terse, the way an unbound Case does.
		describe("applied to a generic Alias", () => {
			function nonEmptyOf(itemType: common.Type): common.Type {
				return {
					type: "Refinement",
					name: "NonEmptyList",
					base: { type: "List", itemType },
					conjuncts: [
						{
							namespaceName: "List",
							methodName: "hasItems",
							negated: false,
							args: [],
						},
					],
					typeArguments: [itemType],
				}
			}

			it("should print the Type Arguments it was applied to", () => {
				expect(printType(nonEmptyOf({ type: "String" }))).toBe(
					"NonEmptyList<String>",
				)
				expect(printType(nonEmptyOf(nonZeroInteger))).toBe(
					"NonEmptyList<NonZeroInteger>",
				)
			})

			it("should stay terse where every Argument is a Type Parameter", () => {
				expect(
					printType(nonEmptyOf({ type: "GenericUse", name: "Item" })),
				).toBe("NonEmptyList")
			})

			it("should print inside the Types that hold one", () => {
				expect(
					printType({
						type: "List",
						itemType: nonEmptyOf({ type: "String" }),
					}),
				).toBe("List<NonEmptyList<String>>")
			})
		})
	})

	// The `?` on a Parameter a call may leave out appears in signatures only,
	// never in `printType`. Inlay Hints print through `printType` and are offered
	// as edits, and to the Lexer `from?` is a label.
	describe("A Parameter a call may leave out", () => {
		let defaulted: common.FunctionType = {
			type: "Function",
			generics: [],
			parameterTypes: [
				{ name: "from", type: integer, hasDefault: true },
				{ name: "to", type: integer },
			],
			returnType: integer,
		}

		it("should be marked in a signature", () => {
			expect(describeSignature(defaulted, "cut").label).toBe(
				"cut(from?: Integer, to: Integer) -> Integer",
			)
		})

		it("should be marked in an Overload summary", () => {
			expect(printSignatureSummary([defaulted], "cut")).toBe(
				"cut(from?: Integer, to: Integer) -> Integer",
			)
		})

		it("should NOT be marked where a Type is printed", () => {
			expect(printType(defaulted)).toBe(
				"(from: Integer, to: Integer) -> Integer",
			)
		})

		it("should not be marked in an Overloaded Method's Type either", () => {
			expect(
				printType({
					type: "OverloadedStaticMethod",
					overloads: [defaulted],
				}),
			).toBe("(from: Integer, to: Integer) -> Integer")
		})

		// A partial Record default still needs the Argument written, so it gets
		// no `?`. Which members may be left out is for Hover's prose.
		it("should not be marked for a partial Record default", () => {
			let partial: common.FunctionType = {
				type: "Function",
				generics: [],
				parameterTypes: [
					{
						name: "using",
						type: {
							type: "Record",
							members: { host: string, retries: integer },
						},
						defaultMembers: ["retries"],
					},
				],
				returnType: integer,
			}

			expect(describeSignature(partial, "connect").label).toBe(
				"connect(using: { host: String, retries: Integer }) -> Integer",
			)
		})
	})

	// Both slots print in declaration order, and a bare Dictionary prints as
	// its name the way a bare List does.
	describe("Dictionaries", () => {
		it("should print both slots of an applied Dictionary", () => {
			expect(
				printType({
					type: "Dictionary",
					keyType: string,
					valueType: integer,
				}),
			).toBe("Dictionary<String, Integer>")
		})

		it("should print a nested Dictionary through both slots", () => {
			expect(
				printType({
					type: "Dictionary",
					keyType: string,
					valueType: {
						type: "Dictionary",
						keyType: integer,
						valueType: { type: "List", itemType: string },
					},
				}),
			).toBe("Dictionary<String, Dictionary<Integer, List<String>>>")
		})

		it("should print an unapplied Dictionary as its name", () => {
			expect(
				printType({
					type: "GenericDictionary",
					generics: [
						{ name: "KeyType", defaultType: { type: "Unknown" } },
						{ name: "ValueType", defaultType: { type: "Unknown" } },
					],
				}),
			).toBe("Dictionary")
		})

		// An open slot prints under the name the source wrote, as a Hover inside
		// a generic Namespace shows it.
		it("should print an open slot under its Parameter's name", () => {
			expect(
				printType({
					type: "Dictionary",
					keyType: genericUse("Key"),
					valueType: genericUse("Value"),
				}),
			).toBe("Dictionary<Key, Value>")
		})
	})

	// A Record Alias prints under its name, as a named Union does. The members
	// stay reachable for a Hover on the Alias itself.
	describe("a named Record", () => {
		let team: common.RecordType = {
			type: "Record",
			name: "Team",
			members: { name: string, code: string },
		}
		let standing: common.RecordType = {
			type: "Record",
			name: "Standing",
			members: { team, points: integer },
		}

		it("should print under its Alias's name", () => {
			expect(printType(standing)).toBe("Standing")
		})

		it("should print an applied generic Alias as applied", () => {
			expect(
				printType({
					type: "Record",
					alias: { name: "Pair", typeArguments: [integer] },
					members: { first: integer, second: integer },
				}),
			).toBe("Pair<Integer>")
		})

		it("should print inside the Types that hold one", () => {
			expect(printType({ type: "List", itemType: standing })).toBe(
				"List<Standing>",
			)
		})

		it("should spell a Record nobody named", () => {
			expect(printType({ type: "Record", members: { x: integer } })).toBe(
				"{ x: Integer }",
			)
			expect(printType({ type: "Record", members: {} })).toBe("{}")
		})

		// Only one level is spelled out. A member that is an Alias stays named,
		// since expanding it describes a Declaration the reader is not looking at.
		it("should spell its members out where it is the subject", () => {
			expect(printRecordWithMembers(standing)).toBe(
				"{ team: Team, points: Integer }",
			)
		})
	})
})
