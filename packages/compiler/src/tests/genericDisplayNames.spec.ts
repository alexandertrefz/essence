import { describe, expect, it } from "bun:test"

import { enrich } from "../enricher/index"
import { describeType, displayGenericName } from "../helpers/index"
import { findInlayHints } from "../lsp/inlayHints"
import { printType } from "../lsp/printType"
import { parseWithDiagnostics } from "../parser/index"

function hintsOf(source: string) {
	let { program } = parseWithDiagnostics(source)
	let { program: enrichedProgram } = enrich(program)

	return findInlayHints(enrichedProgram)
}

// NOTE: `createFreshenedInference` alpha-renames a callee's Generics for the
// span of one invocation — `T` is matched as `T`, a zero-width space and a
// counter — so a caller's same-named Generic can not collide with them. A
// Generic that never binds is left in the Types stamped onto the Argument
// Nodes, which is what Inlay Hints and Hover read their Types back from: shown
// verbatim the reader gets `T117`, since only the separator is invisible. The
// counter is per process, so the digits are not even stable between sessions.
describe("Display names of freshened Generics", () => {
	// NOTE: The lambda's Parameter and return Type come from the signature it
	// is passed to and appear nowhere in the source, so these hints are the
	// only place the reader sees them. `T` occurs ONLY inside the callback, so
	// no Argument can name it: it stays unbound, and the lambda is typed in the
	// fresh Generic itself.
	const source = [
		"implementation {",
		"\tfunction apply <infer T>(_ f: (_: T) -> T, times n: Integer) -> Nothing {",
		"\t\t<- nothing",
		"\t}",
		"\tconstant r = apply((x) { <- x }, times 5)",
		"}",
	].join("\n")

	it("should hint a contextually typed lambda under the Generic the source wrote", () => {
		expect(hintsOf(source).map((hint) => hint.label)).toEqual([
			": Nothing",
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

	// NOTE: The Diagnostics-oriented sibling of `printType`. The Validator
	// reports against the signature's own Parameter Types, which are never
	// freshened — this keeps the renderer honest all the same, since a
	// freshened Type reaching a Diagnostic would name a Generic the reader can
	// not find anywhere in their source.
	it("should describe a freshened Generic under its original name", () => {
		expect(
			describeType({ type: "GenericUse", name: "ItemType\u200B9" }),
		).toBe("ItemType")
	})

	// NOTE: Only the fresh suffix goes — a source Generic may well end in
	// digits, and `T2` is a name somebody wrote.
	it("should leave a name the source spelled alone", () => {
		expect(displayGenericName("T")).toBe("T")
		expect(displayGenericName("T2")).toBe("T2")
		expect(displayGenericName("ItemType")).toBe("ItemType")
		expect(printType({ type: "GenericUse", name: "T2" })).toBe("T2")
	})
})
