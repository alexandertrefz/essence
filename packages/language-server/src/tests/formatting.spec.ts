import { describe, expect, it } from "bun:test"
import * as path from "node:path"

import { STDLIB_DIRECTORY } from "@essence/stdlib"

import { findFormattingEdits } from "../formatting"

describe("Document Formatting", () => {
	// NOTE: The untouched lead and tail are pared off, so fixing one line does
	// not replace the whole buffer under the cursor. Here only the four spaces
	// of indentation become a tab.
	it("should narrow the edit to the changed span", () => {
		let source = "implementation {\n    constant a = 1\n}\n"
		let { edits } = findFormattingEdits(source)

		expect(edits).toEqual([
			{
				range: {
					start: { line: 1, character: 0 },
					end: { line: 1, character: 4 },
				},
				newText: "\t",
			},
		])
	})

	it("should insert at the very end when only the tail changes", () => {
		let { edits } = findFormattingEdits(
			"implementation {\n\tconstant a = 1\n}",
		)

		expect(edits).toEqual([
			{
				range: {
					start: { line: 2, character: 1 },
					end: { line: 2, character: 1 },
				},
				newText: "\n",
			},
		])
	})

	// NOTE: An editor that formats on save would otherwise mark an untouched
	// buffer dirty on every save of an already formatted file.
	it("should offer no edit when the document is already formatted", () => {
		expect(
			findFormattingEdits("implementation {\n\tconstant a = 1\n}\n"),
		).toEqual({ edits: null, warning: null })
	})

	// NOTE: Most keystrokes leave the document unparseable, and a request that
	// lands then should do nothing rather than report — the Diagnostics already
	// say what is wrong.
	it("should offer no edit and no warning while the document does not parse", () => {
		expect(
			findFormattingEdits("implementation {\n\tconstant = = =\n}\n"),
		).toEqual({ edits: null, warning: null })
	})

	it("should offer no edit for an empty document", () => {
		expect(findFormattingEdits("").edits).toBeNull()
	})

	// NOTE: An `unsafe` refusal means the formatter distrusted its own output — a
	// formatter bug, which the editor must surface rather than swallow. No
	// real source can produce one on demand (that is what the corpus sweep
	// proves), so the formatter is stubbed through the seam.
	it("should carry an unsafe refusal's message as a warning", () => {
		let source = "implementation {\n\tconstant a = 1\n}\n"
		let result = findFormattingEdits(source, undefined, (text) => ({
			text,
			changed: false,
			refusal: {
				kind: "unsafe",
				message:
					"Formatting is not stable — a second pass changes the result.",
				diagnostics: [],
			},
		}))

		expect(result.edits).toBeNull()
		expect(result.warning).toContain("not stable")
	})

	// NOTE: `declarations { … }` only parses for a standard library document,
	// and the Language Server identifies one by the URI it was opened with — so
	// the path has to reach the formatter for the library to be formattable at
	// all in the editor.
	it("should format a standard library document by its file URI", () => {
		let source = "declarations {\n  namespace A for Integer {}\n}\n"
		let uri = "file://" + path.join(STDLIB_DIRECTORY, "Scratch.es")

		expect(findFormattingEdits(source, uri).edits).not.toBeNull()
	})

	it("should refuse the same source when it is not a standard library path", () => {
		let source = "declarations {\n  namespace A for Integer {}\n}\n"

		expect(
			findFormattingEdits(source, "file:///tmp/Scratch.es").edits,
		).toBeNull()
	})
})
