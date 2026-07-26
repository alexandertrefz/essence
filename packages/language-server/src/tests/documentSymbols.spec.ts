import { describe, expect, it } from "bun:test"

import { enrich } from "@essence/compiler/enricher"
import { parseWithDiagnostics } from "@essence/compiler/parser"

import {
	type DocumentSymbolEntry,
	findDocumentSymbols,
} from "../documentSymbols"

function symbolsOf(source: string) {
	let { program } = parseWithDiagnostics(source)

	return findDocumentSymbols(program)
}

function detailedSymbolsOf(source: string) {
	let { program } = parseWithDiagnostics(source)
	let { program: enrichedProgram } = enrich(program)

	return findDocumentSymbols(program, enrichedProgram)
}

function flatten(
	symbols: Array<DocumentSymbolEntry>,
): Array<DocumentSymbolEntry> {
	return symbols.flatMap((symbol) => [symbol, ...flatten(symbol.children)])
}

function detailOf(symbols: Array<DocumentSymbolEntry>, name: string) {
	return flatten(symbols).find((symbol) => symbol.name === name)?.detail
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
	it("should list a Protocol with its Method requirements", () => {
		let symbols = symbolsOf(
			[
				"implementation {",
				"\tprotocol Creatable {",
				"\t\ttoText() -> String",
				"\t\tstatic create() -> Self",
				"\t}",
				"}",
			].join("\n"),
		)

		expect(symbols).toHaveLength(1)

		let protocol = symbols[0]

		expect(protocol.name).toBe("Creatable")
		expect(protocol.kind).toBe("protocol")
		expect(
			protocol.children.map((child) => [child.name, child.kind]),
		).toEqual([
			["toText", "method"],
			["create", "staticMethod"],
		])
	})

	// NOTE: The label stays the bare name — a Type Alias's does the same, so a
	// generic Choice's Type Parameters do not join its outline entry. What
	// matters is that the generics clause does not break the Cases underneath.
	it("should list a generic Choice with its Cases as children", () => {
		let symbols = symbolsOf(
			[
				"implementation {",
				"\tchoice Box<Value> {",
				"\t\tHolding { value: Value },",
				"\t\tEmpty,",
				"\t}",
				"}",
			].join("\n"),
		)

		expect(symbols).toHaveLength(1)
		expect([symbols[0].name, symbols[0].kind]).toEqual(["Box", "choice"])
		expect(
			symbols[0].children.map((child) => [child.name, child.kind]),
		).toEqual([
			["#Holding", "case"],
			["#Empty", "case"],
		])
	})

	describe("Nested declarations", () => {
		it("should nest a Function declared inside a Function", () => {
			let symbols = symbolsOf(
				[
					"implementation {",
					"\tfunction greet (subject: String) -> String {",
					"\t\tfunction shout (of text: String) -> String {",
					"\t\t\t<- text",
					"\t\t}",
					"\t\t<- shout(of subject)",
					"\t}",
					"}",
				].join("\n"),
			)

			expect(symbols.map((symbol) => symbol.name)).toEqual(["greet"])
			expect(
				symbols[0].children.map((child) => [child.name, child.kind]),
			).toEqual([["shout", "function"]])
		})

		it("should nest a declaration made inside a Method body", () => {
			let symbols = symbolsOf(
				[
					"implementation {",
					"\tnamespace Thing for Integer {",
					"\t\tshow() -> String {",
					'\t\t\tconstant text = "42"',
					"\t\t\t<- text",
					"\t\t}",
					"\t}",
					"}",
				].join("\n"),
			)

			expect(
				symbols[0].children[0].children.map((child) => child.name),
			).toEqual(["text"])
		})

		// NOTE: An `if` has no name of its own, so its body's declarations join
		// the Function around it rather than hiding under an unnameable entry.
		it("should list a declaration made inside an `if` flat", () => {
			let symbols = symbolsOf(
				[
					"implementation {",
					"\tfunction pick () -> Integer {",
					"\t\tif true {",
					"\t\t\tconstant chosen = 1",
					"\t\t\t<- chosen",
					"\t\t} else {",
					"\t\t\tconstant fallback = 0",
					"\t\t\t<- fallback",
					"\t\t}",
					"\t}",
					"}",
				].join("\n"),
			)

			expect(
				symbols[0].children.map((child) => [child.name, child.kind]),
			).toEqual([
				["chosen", "constant"],
				["fallback", "constant"],
			])
		})

		// NOTE: A Match arm is not an entry of its own either — one per arm
		// would outnumber everything the outline is actually for.
		it("should list a declaration made inside a Match arm flat", () => {
			let symbols = symbolsOf(
				[
					"implementation {",
					"\tconstant described = match 1 -> String {",
					"\t\tcase Integer {",
					'\t\t\tconstant text = "one"',
					"\t\t\t<- text",
					"\t\t}",
					"\t}",
					"}",
				].join("\n"),
			)

			expect(symbols.map((symbol) => symbol.name)).toEqual(["described"])
			expect(symbols[0].children.map((child) => child.name)).toEqual([
				"text",
			])
		})

		it("should still produce no symbols for a top level Expression", () => {
			let symbols = symbolsOf(
				["implementation {", '\t__print("Hello")', "}"].join("\n"),
			)

			expect(symbols).toEqual([])
		})
	})

	describe("Details", () => {
		let source = [
			"implementation {",
			'\tconstant worldName = "World"',
			"\tvariable counter = 0",
			"\tfunction greet (subject: String) -> String {",
			"\t\t<- subject",
			"\t}",
			"\tnamespace Thing for Integer {",
			'\t\tstatic label = "thing"',
			"\t\tshow() -> String {",
			'\t\t\t<- "42"',
			"\t\t}",
			"\t\toverload combine {",
			"\t\t\t(_ other: Integer) -> Integer { <- 42 }",
			"\t\t\t(text other: String) -> Integer { <- 42 }",
			"\t\t}",
			"\t}",
			"\tchoice Shape {",
			"\t\tCircle { radius: Integer },",
			"\t\tPoint,",
			"\t}",
			"}",
		].join("\n")

		it("should print the Type of a Constant, a Variable and a Property", () => {
			let symbols = detailedSymbolsOf(source)

			expect(detailOf(symbols, "worldName")).toBe("String")
			expect(detailOf(symbols, "counter")).toBe("Integer")
			expect(detailOf(symbols, "label")).toBe("String")
		})

		// NOTE: Nameless — the name is right beside the detail in the outline.
		it("should summarise the signature of a Function and a Method", () => {
			let symbols = detailedSymbolsOf(source)

			expect(detailOf(symbols, "greet")).toBe(
				"(subject: String) -> String",
			)
			expect(detailOf(symbols, "show")).toBe("() -> String")
			expect(detailOf(symbols, "combine")).toBe(
				"(_ Integer) -> Integer (+1 overload)",
			)
		})

		it("should render a Case with its payload", () => {
			let symbols = detailedSymbolsOf(source)

			expect(detailOf(symbols, "#Circle")).toBe(
				"Shape#Circle { radius: Integer }",
			)
			expect(detailOf(symbols, "#Point")).toBe("Shape#Point")
		})

		it("should detail a declaration nested inside a Function body", () => {
			let symbols = detailedSymbolsOf(
				[
					"implementation {",
					"\tfunction greet (subject: String) -> String {",
					"\t\tconstant greeting = subject",
					"\t\t<- greeting",
					"\t}",
					"}",
				].join("\n"),
			)

			expect(detailOf(symbols, "greeting")).toBe("String")
		})

		// NOTE: The Parser-only contract — an outline is still an outline while
		// the Program does not type check, and that is when it is needed most.
		it("should leave every detail null without an enriched Program", () => {
			let symbols = flatten(symbolsOf(source))

			expect(symbols.length).toBeGreaterThan(0)
			expect(symbols.every((symbol) => symbol.detail === null)).toBe(true)
		})

		// NOTE: A Guard is walked for entries but sits outside the Handler's
		// body, so it is the one place a detail can go missing while every
		// other entry in the same outline has one.
		it("should detail a declaration made inside a Match Guard", () => {
			let symbols = detailedSymbolsOf(
				[
					"implementation {",
					"\tconstant value: Integer | String = 1",
					"\tconstant described = match value -> String {",
					"\t\tcase Integer where [1]::removeEvery(where (item) { constant threshold = 0",
					"\t\t\t<- item::isGreaterThan(threshold) })::hasItems() {",
					'\t\t\t<- "number"',
					"\t\t}",
					'\t\tcase String { <- "string" }',
					"\t}",
					"}",
				].join("\n"),
			)

			expect(detailOf(symbols, "threshold")).toBe("Integer")
		})

		it("should leave a Type that could not be inferred without a detail", () => {
			let symbols = detailedSymbolsOf(
				[
					"implementation {",
					"\tconstant broken = missingName",
					"}",
				].join("\n"),
			)

			expect(detailOf(symbols, "broken")).toBeNull()
		})
	})
})
