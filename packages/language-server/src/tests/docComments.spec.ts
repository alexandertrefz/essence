import { describe, expect, it } from "bun:test"

import { enrich } from "@essence-lang/compiler/enricher"
import { parseWithDiagnostics } from "@essence-lang/compiler/parser"
import type { common } from "@essence-lang/interfaces"

import { findCompletions } from "../completion"
import { findHover } from "../hover"
import { findSignatureHelp } from "../signatureHelp"

function hover(source: string, cursor: common.Cursor) {
	let { program } = parseWithDiagnostics(source)
	let { program: enrichedProgram } = enrich(program)

	return findHover(enrichedProgram, cursor)
}

describe("Documentation Comments", () => {
	it("should attach a `§§` block to the Function below it", () => {
		let source = [
			"implementation {",
			"\t§§ Greets a subject by name.",
			"\t§§",
			"\t§§ Supports **markdown**.",
			"\tfunction greet (subject: String) -> String {",
			"\t\t<- subject",
			"\t}",
			"}",
		].join("\n")

		expect(hover(source, { line: 5, column: 11 })?.documentation).toBe(
			"Greets a subject by name.\n\nSupports **markdown**.",
		)
	})

	it("should not treat an ordinary `§` Comment as Documentation", () => {
		let source = [
			"implementation {",
			"\t§ a private note, not documentation",
			'\tconstant name = "Essence"',
			"}",
		].join("\n")

		expect(hover(source, { line: 3, column: 12 })?.documentation).toBeNull()
	})

	it("should not attach a block that a blank line separates", () => {
		let source = [
			"implementation {",
			"\t§§ This documents nothing.",
			"",
			'\tconstant name = "Essence"',
			"}",
		].join("\n")

		expect(hover(source, { line: 4, column: 12 })?.documentation).toBeNull()
	})

	it("should document Constants, Types and Namespaces", () => {
		let source = [
			"implementation {",
			"\t§§ The name this program greets.",
			'\tconstant name = "Essence"',
			"\t§§ Anything that can be shown to a person.",
			"\ttype Showable = Integer | String",
			"\t§§ Turns Integers into text.",
			"\tnamespace Stringify for Integer {",
			"\t\tstring() -> String {",
			'\t\t\t<- "one"',
			"\t\t}",
			"\t}",
			"}",
		].join("\n")

		expect(hover(source, { line: 3, column: 12 })?.documentation).toBe(
			"The name this program greets.",
		)
		expect(hover(source, { line: 5, column: 8 })?.documentation).toBe(
			"Anything that can be shown to a person.",
		)
		expect(hover(source, { line: 7, column: 12 })?.documentation).toBe(
			"Turns Integers into text.",
		)
	})

	it("should render `@param` and `@returns` into the Hover", () => {
		let source = [
			"implementation {",
			"\t§§ Greets a subject.",
			"\t§§ @param subject — who to greet",
			"\t§§ @returns — the greeting",
			"\tfunction greet (subject: String) -> String {",
			"\t\t<- subject",
			"\t}",
			"}",
		].join("\n")

		expect(hover(source, { line: 5, column: 11 })?.documentation).toBe(
			"Greets a subject.\n\n**subject** — who to greet\n\n**Returns** — the greeting",
		)
	})

	it("should show a positional Parameter under the name its body reads", () => {
		// NOTE: The line is written `_`, the way the signature writes the
		// Parameter. What a reader is shown is the name the signature shows
		// next to it, since `_` names nothing on its own.
		let source = [
			"implementation {",
			"\t§§ Greets a subject.",
			"\t§§ @param _ — who to greet",
			"\tfunction greet (_ subject: String) -> String {",
			"\t\t<- subject",
			"\t}",
			"}",
		].join("\n")

		expect(hover(source, { line: 4, column: 11 })?.documentation).toBe(
			"Greets a subject.\n\n**subject** — who to greet",
		)
	})

	it("should render a positionally matched Parameter under its label", () => {
		// NOTE: The line names the internal name, which the strict rule reports
		// as `misnamed-documentation-parameter`. Rendering is the separate
		// question asked here: a tag documents the Parameter at its position
		// whatever it names, and what a Hover shows is the label a call site
		// writes.
		let source = [
			"implementation {",
			"\t§§ Greets a subject.",
			"\t§§ @param subject — who to greet",
			"\tfunction greet (to subject: String) -> String {",
			"\t\t<- subject",
			"\t}",
			"}",
		].join("\n")

		expect(hover(source, { line: 4, column: 11 })?.documentation).toBe(
			"Greets a subject.\n\n**to** — who to greet",
		)
	})

	it("should match `@param` lines to Parameters by position", () => {
		let source = [
			"implementation {",
			"\t§§ Joins two Strings.",
			"\t§§ @param _ — the text to put first",
			"\t§§ @param _ — the text to put after it",
			"\tfunction join (_ left: String, _ right: String) -> String {",
			"\t\t<- left::append(right)",
			"\t}",
			"\tjoin(",
			"}",
		].join("\n")

		let signature = findSignatureHelp(source, { line: 8, column: 7 })
			?.signatures[0]

		expect(signature?.parameters[0].documentation).toBe(
			"the text to put first",
		)
		expect(signature?.parameters[1].documentation).toBe(
			"the text to put after it",
		)
	})

	it("should show a `@param` next to the Parameter in Signature Help", () => {
		let source = [
			"implementation {",
			"\t§§ Greets a subject.",
			"\t§§ @param subject — who to greet",
			"\tfunction greet (subject: String) -> String {",
			"\t\t<- subject",
			"\t}",
			"\tgreet(",
			"}",
		].join("\n")

		let signature = findSignatureHelp(source, { line: 7, column: 8 })
			?.signatures[0]

		// NOTE: The tagged sections are lifted out of the description — the
		// Parameter's text belongs next to the Parameter, not underneath the
		// signature where it would be said twice.
		expect(signature?.documentation).toBe("Greets a subject.")
		expect(signature?.parameters[0].documentation).toBe("who to greet")
	})

	it("should let a Parameter on its own line carry its own block", () => {
		let source = [
			"implementation {",
			"\tfunction greet (",
			"\t\t§§ who to greet",
			"\t\tsubject: String,",
			"\t) -> String {",
			"\t\t<- subject",
			"\t}",
			"\tgreet(",
			"}",
		].join("\n")

		let signature = findSignatureHelp(source, { line: 8, column: 8 })
			?.signatures[0]

		expect(signature?.parameters[0].documentation).toBe("who to greet")
	})

	it("should not let the first Parameter claim the Function's own block", () => {
		let source = [
			"implementation {",
			"\t§§ Greets a subject.",
			"\tfunction greet (subject: String) -> String {",
			"\t\t<- subject",
			"\t}",
			"\tgreet(",
			"}",
		].join("\n")

		let signature = findSignatureHelp(source, { line: 6, column: 8 })
			?.signatures[0]

		expect(signature?.documentation).toBe("Greets a subject.")
		expect(signature?.parameters[0].documentation).toBeNull()
	})

	it("should document each Overload separately, falling back to the set", () => {
		let source = [
			"implementation {",
			"\tnamespace Thing for Integer {",
			"\t\t§§ Combines with another value.",
			"\t\toverload combine {",
			"\t\t\t§§ Adds an Integer.",
			"\t\t\t(_ other: Integer) -> Integer {",
			"\t\t\t\t<- 42",
			"\t\t\t}",
			"\t\t\t(_ other: Integer, _ third: Integer) -> Integer {",
			"\t\t\t\t<- 42",
			"\t\t\t}",
			"\t\t}",
			"\t}",
			"\t1::combine(",
			"}",
		].join("\n")

		let help = findSignatureHelp(source, { line: 14, column: 13 })

		expect(help?.signatures[0].documentation).toBe("Adds an Integer.")
		// NOTE: The second Overload says nothing of its own, so what documents
		// the whole `overload` block applies to it.
		expect(help?.signatures[1].documentation).toBe(
			"Combines with another value.",
		)
	})

	it("should document a Namespace's static Property", () => {
		let source = [
			"implementation {",
			"\tnamespace Thing {",
			"\t\t§§ The greeting used when nothing else fits.",
			'\t\tstatic fallback = "Hello, stranger!"',
			"\t}",
			"}",
		].join("\n")

		expect(hover(source, { line: 4, column: 11 })?.documentation).toBe(
			"The greeting used when nothing else fits.",
		)
	})

	it("should document a Method where its name is declared", () => {
		let source = [
			"implementation {",
			"\tnamespace Stringify for Integer {",
			"\t\t§§ Spells this Integer out as text.",
			"\t\ttext() -> String {",
			"\t\t\t<- @::toString()",
			"\t\t}",
			"\t}",
			"}",
		].join("\n")

		expect(hover(source, { line: 4, column: 4 })?.documentation).toBe(
			"Spells this Integer out as text.",
		)
	})

	it("should carry Documentation on the builtin Namespaces", () => {
		let source = [
			"implementation {",
			'\tTerminal.inspect("a"::append("b"))',
			"}",
		].join("\n")

		expect(hover(source, { line: 2, column: 24 })?.documentation).toContain(
			"Joins another String onto the end of this one.",
		)

		// NOTE: The Documentation offered is the one the entry the call would
		// REACH carries: a written `1` proves it is above zero, and
		// `namespace PositiveInteger` declares a sum of its own.
		let entry = findCompletions(
			["implementation {", "\t1::", "}"].join("\n"),
			{ line: 2, column: 5 },
		).find((completion) => completion.label === "add")

		expect(entry?.documentation).toContain(
			"Adds an Integer proven not to be negative to this PositiveInteger.",
		)
	})
})
