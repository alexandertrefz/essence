import { describe, expect, it } from "bun:test"

import { findDocumentSymbols } from "../lsp/documentSymbols"
import { parseWithDiagnostics } from "../parser"

function symbolsOf(source: string) {
	let { program } = parseWithDiagnostics(source)

	return findDocumentSymbols(program)
}

describe("Document Symbols", () => {
	it("should list top level declarations in source order", () => {
		let symbols = symbolsOf(
			[
				"implementation {",
				"\ttype Name = String",
				'\tconstant worldName: Name = "World"',
				"\tvariable counter = 0",
				"\tfunction greet (subject: Name) -> String {",
				'\t\t<- "Hello"',
				"\t}",
				"\tnamespace Stringify for Integer {",
				"\t\tstring() -> String {",
				'\t\t\t<- "one"',
				"\t\t}",
				"\t}",
				"}",
			].join("\n"),
		)

		expect(symbols.map((symbol) => [symbol.name, symbol.kind])).toEqual([
			["Name", "typeAlias"],
			["worldName", "constant"],
			["counter", "variable"],
			["greet", "function"],
			["Stringify", "namespace"],
		])
	})

	it("should not produce symbols for top level Expressions", () => {
		let symbols = symbolsOf(
			["implementation {", '\t__print("Hello")', "}"].join("\n"),
		)

		expect(symbols).toEqual([])
	})

	it("should list Record Type Alias members as children", () => {
		let symbols = symbolsOf(
			[
				"implementation {",
				"\ttype Person = { firstName: String, lastName: String }",
				"}",
			].join("\n"),
		)

		expect(
			symbols[0].children.map((child) => [child.name, child.kind]),
		).toEqual([
			["firstName", "member"],
			["lastName", "member"],
		])
	})

	it("should list Namespace Properties and Methods as children", () => {
		let symbols = symbolsOf(
			[
				"implementation {",
				"\tnamespace Thing for Integer {",
				'\t\tstatic label = "thing"',
				"\t\tshow() -> String {",
				'\t\t\t<- "42"',
				"\t\t}",
				"\t\tstatic create() -> Integer {",
				"\t\t\t<- 42",
				"\t\t}",
				"\t\toverload combine {",
				"\t\t\t(_ other: Integer) -> Integer {",
				"\t\t\t\t<- 42",
				"\t\t\t}",
				"\t\t\t(text other: String) -> Integer {",
				"\t\t\t\t<- 42",
				"\t\t\t}",
				"\t\t}",
				"\t}",
				"}",
			].join("\n"),
		)

		expect(
			symbols[0].children.map((child) => [child.name, child.kind]),
		).toEqual([
			["label", "property"],
			["show", "method"],
			["create", "staticMethod"],
			["combine", "method"],
		])
	})

	it("should span the whole Statement and select just the name", () => {
		let symbols = symbolsOf(
			[
				"implementation {",
				"\tfunction greet () -> String {",
				'\t\t<- "Hello"',
				"\t}",
				"}",
			].join("\n"),
		)

		expect(symbols[0].selectionRange).toEqual({
			start: { line: 2, column: 11 },
			end: { line: 2, column: 16 },
		})
		expect(symbols[0].range.start.line).toBe(2)
		expect(symbols[0].range.end.line).toBe(4)
	})

	it("should span an overloaded Method from its name to the last overload", () => {
		let symbols = symbolsOf(
			[
				"implementation {",
				"\tnamespace Thing for Integer {",
				"\t\toverload combine {",
				"\t\t\t(_ other: Integer) -> Integer {",
				"\t\t\t\t<- 42",
				"\t\t\t}",
				"\t\t\t(text other: String) -> Integer {",
				"\t\t\t\t<- 42",
				"\t\t\t}",
				"\t\t}",
				"\t}",
				"}",
			].join("\n"),
		)

		let combine = symbols[0].children[0]

		expect(combine.range.start.line).toBe(3)
		expect(combine.range.end.line).toBe(9)
	})
})
