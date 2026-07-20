import { describe, expect, it } from "bun:test"

import { enrich } from "../enricher"
import type { common } from "../interfaces"
import { findHover } from "../lsp/hover"
import { parseWithDiagnostics } from "../parser"

function hover(source: string, cursor: common.Cursor): string | null {
	let { program } = parseWithDiagnostics(source)
	let { program: enrichedProgram } = enrich(program)

	return findHover(enrichedProgram, cursor)?.content ?? null
}

describe("Hover", () => {
	it("should describe Identifiers with their inferred Type", () => {
		let source = [
			"implementation {",
			'\tconstant name = "Essence"',
			"\t__print(name)",
			"}",
		].join("\n")

		expect(hover(source, { line: 3, column: 10 })).toBe("name: String")
	})

	it("should describe Functions with their full signature", () => {
		let source = [
			"implementation {",
			"\tfunction greet (subject: String) -> String {",
			"\t\t<- subject",
			"\t}",
			"}",
		].join("\n")

		expect(hover(source, { line: 2, column: 11 })).toBe(
			"greet: (subject: String) -> String",
		)
	})

	it("should describe Parameters", () => {
		let source = [
			"implementation {",
			"\tfunction greet (subject: String) -> String {",
			"\t\t<- subject",
			"\t}",
			"}",
		].join("\n")

		expect(hover(source, { line: 2, column: 18 })).toBe("subject: String")
	})

	it("should describe literals", () => {
		let source = ["implementation {", "\tconstant a = 42", "}"].join("\n")

		expect(hover(source, { line: 2, column: 15 })).toBe("Integer")
	})

	it("should describe Union Types", () => {
		let source = [
			"implementation {",
			"\ttype Value = Integer | String",
			"\tconstant something: Value = 42",
			"\t__print(something)",
			"}",
		].join("\n")

		expect(hover(source, { line: 4, column: 10 })).toBe(
			"something: Integer | String",
		)
	})

	it("should describe Method invocations", () => {
		let source = [
			"implementation {",
			'\t__print("Hello"::append("!"))',
			"}",
		].join("\n")

		// NOTE: Self is stripped from the signature — `append` takes two
		// Strings internally, but a call site only passes one.
		expect(hover(source, { line: 2, column: 20 })).toBe(
			"append: (_ String) -> String",
		)
	})

	it("should describe Self", () => {
		let source = [
			"implementation {",
			"\tnamespace Stringify for Integer {",
			"\t\tstring() -> String {",
			"\t\t\t<- @::toString()",
			"\t\t}",
			"\t}",
			"}",
		].join("\n")

		expect(hover(source, { line: 4, column: 7 })).toBe("@: Integer")
	})

	it("should prefer the innermost typed node", () => {
		let source = [
			"implementation {",
			'\tconstant greeting = "Hello"::append("!")',
			"}",
		].join("\n")

		// NOTE: Hovering the argument literal must not show the invocation.
		expect(hover(source, { line: 2, column: 39 })).toBe("String")
	})

	it("should return null outside of any typed node", () => {
		let source = ["implementation {", "\tconstant a = 1", "}"].join("\n")

		expect(hover(source, { line: 1, column: 1 })).toBeNull()
	})
})
