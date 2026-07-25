import { describe, expect, it } from "bun:test"

import type { common } from "../interfaces/index"
import {
	caseHeader,
	describeSignature,
	printCaseWithPayload,
	printSignatureSummary,
	printType,
	signaturesOf,
} from "../lsp/printType"

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

		// NOTE: A DECLARED Case abstracts over its Parameters (no `typeArguments`
		// yet); a fully unbound instantiation carries only same-named GenericUses.
		// Neither adds a `<…>` that would just echo the header.
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

	// NOTE: An overloaded native free Function (WP5) resolves at a call site to
	// an `OverloadedStaticMethod` callee — the same shape a future `loop` has.
	// Hover and Signature Help both render it through these, so they must spell
	// every Overload without collapsing or crashing. Implementation mode cannot
	// declare one, so the fixture is built by hand.
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
})
