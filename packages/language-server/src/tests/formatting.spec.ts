import { describe, expect, it } from "bun:test"
import * as path from "node:path"

import { STDLIB_DIRECTORY } from "@essence/stdlib"

import { findFormattingEdits } from "../formatting"

describe("Document Formatting", () => {
	it("should replace the whole document with the formatted source", () => {
		let source = "implementation {\n    constant a = 1\n}\n"
		let edits = findFormattingEdits(source)

		expect(edits).toEqual([
			{
				range: {
					start: { line: 0, character: 0 },
					end: { line: 3, character: 0 },
				},
				newText: "implementation {\n\tconstant a = 1\n}\n",
			},
		])
	})

	it("should end the range at the last character when there is no trailing newline", () => {
		let edits = findFormattingEdits("implementation {\n  constant a = 1\n}")

		expect(edits?.[0]?.range.end).toEqual({ line: 2, character: 1 })
	})

	// NOTE: An editor that formats on save would otherwise mark an untouched
	// buffer dirty on every save of an already formatted file.
	it("should offer no edit when the document is already formatted", () => {
		expect(
			findFormattingEdits("implementation {\n\tconstant a = 1\n}\n"),
		).toBeNull()
	})

	// NOTE: Most keystrokes leave the document unparseable, and a request that
	// lands then should do nothing rather than report — the Diagnostics already
	// say what is wrong.
	it("should offer no edit while the document does not parse", () => {
		expect(
			findFormattingEdits("implementation {\n\tconstant = = =\n}\n"),
		).toBeNull()
	})

	it("should offer no edit for an empty document", () => {
		expect(findFormattingEdits("")).toBeNull()
	})

	// NOTE: `declarations { … }` only parses for a standard library document,
	// and the Language Server identifies one by the URI it was opened with — so
	// the path has to reach the formatter for the library to be formattable at
	// all in the editor.
	it("should format a standard library document by its file URI", () => {
		let source = "declarations {\n  namespace A for Integer {}\n}\n"
		let uri = "file://" + path.join(STDLIB_DIRECTORY, "Scratch.es")

		expect(findFormattingEdits(source, uri)).not.toBeNull()
	})

	it("should refuse the same source when it is not a standard library path", () => {
		let source = "declarations {\n  namespace A for Integer {}\n}\n"

		expect(findFormattingEdits(source, "file:///tmp/Scratch.es")).toBeNull()
	})
})
