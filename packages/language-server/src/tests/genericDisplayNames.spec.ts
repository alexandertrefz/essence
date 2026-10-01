import { describe, expect, it } from "bun:test"

import { enrich } from "@essence-lang/compiler/enricher"
import {
	describeType,
	displayGenericName,
} from "@essence-lang/compiler/helpers"
import { parseWithDiagnostics } from "@essence-lang/compiler/parser"
import { printType } from "@essence-lang/compiler/printType"

import { findInlayHints } from "../inlayHints"

function hintsOf(source: string) {
	let { program } = parseWithDiagnostics(source)
	let { program: enrichedProgram } = enrich(program)

	return findInlayHints(enrichedProgram)
}

// `createFreshenedInference` renames a callee's Generics for one invocation:
// the name, a zero-width space and a counter. A Generic that never binds stays
// in the Types that Inlay Hints and Hover read, where it would show as T117.
describe("Display names of freshened Generics", () => {
	// `T` occurs only inside the callback, so no Argument binds it and the
	// lambda is typed in the fresh Generic. These hints are the only place a
	// reader sees those Types.
	const source = [
		"implementation {",
		"\tfunction apply <infer T>(_ f: (_: T) -> T, times n: Integer) -> {} {",
		"\t\t<- {}",
		"\t}",
		"\tconstant r = apply((x) { <- x }, times 5)",
		"}",
	].join("\n")

	it("should hint a contextually typed lambda under the Generic the source wrote", () => {
		// The first hint is `r`'s own Type: `apply` answers nothing
		// useful, which is the unit Type, the empty Record.
		expect(hintsOf(source).map((hint) => hint.label)).toEqual([
			": {}",
			": T",
			" -> T",
		])
	})

	it("should print a freshened Generic under its original name", () => {
		expect(printType({ type: "GenericUse", name: "T\u200B117" })).toBe("T")
		expect(
			printType({
				type: "Function",
				parameterTypes: [
					{
						name: null,
						type: { type: "GenericUse", name: "T\u200B4" },
					},
				],
				returnType: { type: "GenericUse", name: "T\u200B4" },
				generics: [],
			}),
		).toBe("(_ T) -> T")
	})

	// `describeType` prints Types for Diagnostics. The Validator reports the
	// signature's own Types, which are never freshened, but a fresh name must
	// still read as the source's.
	it("should describe a freshened Generic under its original name", () => {
		expect(
			describeType({ type: "GenericUse", name: "ItemType\u200B9" }),
		).toBe("ItemType")
	})

	// Only the fresh suffix goes, since a source Generic may end in digits.
	it("should leave a name the source spelled alone", () => {
		expect(displayGenericName("T")).toBe("T")
		expect(displayGenericName("T2")).toBe("T2")
		expect(displayGenericName("ItemType")).toBe("ItemType")
		expect(printType({ type: "GenericUse", name: "T2" })).toBe("T2")
	})
})
