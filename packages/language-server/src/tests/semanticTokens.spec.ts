import { describe, expect, it } from "bun:test"

import { enrich } from "@essence/compiler/enricher"
import { parseWithDiagnostics } from "@essence/compiler/parser"

import {
	encodeSemanticTokens,
	findSemanticTokens,
	semanticTokenModifiers,
	semanticTokenTypes,
} from "../semanticTokens"

function tokensOf(source: string) {
	let { program } = parseWithDiagnostics(source)
	let { program: enrichedProgram } = enrich(program)

	return findSemanticTokens(program, enrichedProgram)
}

function tokenAt(source: string, line: number, column: number) {
	return tokensOf(source).find(
		(token) => token.line === line && token.column === column,
	)
}

describe("Semantic Tokens", () => {
	it("should classify a Constant as a readonly variable declaration", () => {
		let source = ["implementation {", "\tconstant value = 1", "}"].join(
			"\n",
		)

		let token = tokenAt(source, 2, 11)

		expect(token?.type).toBe("variable")
		expect(token?.modifiers).toContain("readonly")
		expect(token?.modifiers).toContain("declaration")
	})

	it("should not mark a Variable readonly, and not mark uses as declarations", () => {
		let source = [
			"implementation {",
			"\tvariable count = 1",
			"\tconstant other = count",
			"}",
		].join("\n")

		let declaration = tokenAt(source, 2, 11)
		let use = tokenAt(source, 3, 19)

		expect(declaration?.modifiers).not.toContain("readonly")
		expect(declaration?.modifiers).toContain("declaration")
		expect(use?.type).toBe("variable")
		expect(use?.modifiers).not.toContain("declaration")
	})

	it("should distinguish Namespaces, Types and Generics", () => {
		let source = [
			"implementation {",
			"\ttype Name = String",
			"\tnamespace Stringify for Integer {",
			"\t\tstring() -> String {",
			'\t\t\t<- "one"',
			"\t\t}",
			"\t}",
			"\tfunction first<T>(_ items: List<T>) -> T {",
			"\t\t<- items::item(at 0)",
			"\t}",
			"}",
		].join("\n")

		expect(tokenAt(source, 2, 7)?.type).toBe("type")
		expect(tokenAt(source, 3, 12)?.type).toBe("namespace")
		expect(tokenAt(source, 8, 17)?.type).toBe("typeParameter")
	})

	it("should classify a generic Choice's Type Parameters like a Type Alias's", () => {
		let source = [
			"implementation {",
			"\tchoice Box<Value> {",
			"\t\tHolding { value: Value },",
			"\t\tEmpty,",
			"\t}",
			"}",
		].join("\n")

		// NOTE: `Box` is the Choice's Type; `Value` in the header and in the
		// payload are its Type Parameter; `value` is a Record member Property.
		expect(tokenAt(source, 2, 9)?.type).toBe("type")
		expect(tokenAt(source, 2, 13)?.type).toBe("typeParameter")
		expect(tokenAt(source, 3, 13)?.type).toBe("property")
		expect(tokenAt(source, 3, 20)?.type).toBe("typeParameter")
	})

	it("should classify Parameters and Methods", () => {
		let source = [
			"implementation {",
			"\tnamespace Thing for Integer {",
			"\t\tshow(subject: String) -> String {",
			"\t\t\t<- subject",
			"\t\t}",
			"\t\tstatic create() -> Integer {",
			"\t\t\t<- 42",
			"\t\t}",
			"\t}",
			"}",
		].join("\n")

		expect(tokenAt(source, 3, 3)?.type).toBe("method")
		expect(tokenAt(source, 3, 8)?.type).toBe("parameter")

		let staticToken = tokenAt(source, 6, 10)

		expect(staticToken?.type).toBe("method")
		expect(staticToken?.modifiers).toContain("static")
	})

	it("should emit Tokens sorted by Position without overlaps", () => {
		let source = [
			"implementation {",
			"\tconstant a = 1",
			"\tconstant b = a",
			"\tconstant c = b",
			"}",
		].join("\n")

		let tokens = tokensOf(source)

		for (let index = 1; index < tokens.length; index++) {
			let previous = tokens[index - 1]
			let current = tokens[index]

			expect(
				current.line > previous.line ||
					(current.line === previous.line &&
						current.column > previous.column),
			).toBe(true)
		}
	})

	describe("encoding", () => {
		it("should encode Tokens as deltas in quintuples", () => {
			let data = encodeSemanticTokens([
				{
					line: 2,
					column: 11,
					length: 5,
					type: "variable",
					modifiers: ["declaration"],
				},
				{
					line: 2,
					column: 20,
					length: 3,
					type: "function",
					modifiers: [],
				},
				{
					line: 4,
					column: 2,
					length: 4,
					type: "type",
					modifiers: [],
				},
			])

			expect(data).toEqual([
				// NOTE: First Token — deltas are from line 1, column 1.
				1,
				10,
				5,
				semanticTokenTypes.indexOf("variable"),
				0b001,
				// NOTE: Same line, so the column delta is relative.
				0,
				9,
				3,
				semanticTokenTypes.indexOf("function"),
				0,
				// NOTE: New line, so the column delta is absolute.
				2,
				1,
				4,
				semanticTokenTypes.indexOf("type"),
				0,
			])
		})

		it("should encode an empty Token list as no data", () => {
			expect(encodeSemanticTokens([])).toEqual([])
		})
	})
})

describe("Semantic Tokens for Cases", () => {
	let source = [
		"implementation {",
		"\tchoice Operation {",
		"\t\tAdd { amount: Integer },",
		"\t\tClear,",
		"\t}",
		"\tfunction weigh(_ operation: Operation) -> Integer {",
		"\t\tconstant weight = match operation -> Integer {",
		"\t\t\tcase #Add { <- 1 }",
		"\t\t\tcase Operation#Clear { <- 0 }",
		"\t\t}",
		"\t\t<- weight",
		"\t}",
		"\tconstant added = Operation#Add({ amount = 1 })",
		"\tconstant cleared = #Clear",
		"}",
	].join("\n")

	it("should classify a declared Case as an enumMember declaration", () => {
		let add = tokenAt(source, 3, 3)
		let clear = tokenAt(source, 4, 3)

		expect(add?.type).toBe("enumMember")
		expect(add?.modifiers).toContain("declaration")
		expect(clear?.type).toBe("enumMember")
		expect(clear?.modifiers).toContain("declaration")
	})

	it("should classify a constructed Case as an enumMember", () => {
		let qualified = tokenAt(source, 13, 29)
		let bare = tokenAt(source, 14, 22)

		expect(qualified?.type).toBe("enumMember")
		expect(qualified?.modifiers).not.toContain("declaration")
		expect(bare?.type).toBe("enumMember")
	})

	it("should classify a Case Matcher as an enumMember", () => {
		expect(tokenAt(source, 8, 10)?.type).toBe("enumMember")
		expect(tokenAt(source, 9, 19)?.type).toBe("enumMember")
	})

	it("should leave the Choice prefix of a qualified Case a Type", () => {
		// NOTE: The `#` sits between the two Tokens and belongs to neither —
		// the Case's Position covers its name alone, exactly as at its
		// declaration.
		let value = tokenAt(source, 13, 19)
		let matcher = tokenAt(source, 9, 9)

		expect(value?.type).toBe("type")
		expect(value?.length).toBe("Operation".length)
		expect(matcher?.type).toBe("type")
		expect(tokenAt(source, 13, 28)).toBeUndefined()
		expect(tokenAt(source, 14, 21)).toBeUndefined()
	})

	it("should keep the merged Tokens sorted and free of overlaps", () => {
		let tokens = tokensOf(source)

		for (let index = 1; index < tokens.length; index++) {
			let previous = tokens[index - 1]
			let current = tokens[index]

			expect(
				current.line > previous.line ||
					(current.line === previous.line &&
						current.column > previous.column),
			).toBe(true)
		}
	})
})

describe("Semantic Tokens for the standard library", () => {
	it("should mark builtin Types and Namespaces as defaultLibrary", () => {
		let source = [
			"implementation {",
			"\tconstant text: String = String.from(1)",
			"}",
		].join("\n")

		let type = tokenAt(source, 2, 17)
		let namespace = tokenAt(source, 2, 26)

		expect(type?.type).toBe("type")
		expect(type?.modifiers).toContain("defaultLibrary")
		expect(namespace?.type).toBe("namespace")
		expect(namespace?.modifiers).toContain("defaultLibrary")
	})

	it("should not mark the user's own names as defaultLibrary", () => {
		let source = [
			"implementation {",
			"\ttype Text = String",
			'\tconstant text: Text = "hi"',
			"}",
		].join("\n")

		expect(tokenAt(source, 2, 7)?.modifiers).not.toContain("defaultLibrary")
		expect(tokenAt(source, 3, 11)?.modifiers).not.toContain(
			"defaultLibrary",
		)
		expect(tokenAt(source, 3, 17)?.modifiers).not.toContain(
			"defaultLibrary",
		)
	})
})

describe("the Semantic Token legend", () => {
	// NOTE: Tokens are encoded as indices into these arrays, so entries may
	// only ever be appended — an insertion recolours everything past it.
	it("should carry the new entries at its end", () => {
		expect(semanticTokenTypes.at(-1)).toBe("enumMember")
		expect(semanticTokenModifiers.at(-1)).toBe("defaultLibrary")
	})

	it("should keep the indices the encoding depends on stable", () => {
		expect(semanticTokenTypes.slice(0, 8)).toEqual([
			"namespace",
			"type",
			"typeParameter",
			"parameter",
			"variable",
			"property",
			"function",
			"method",
		])
		expect(semanticTokenModifiers.slice(0, 3)).toEqual([
			"declaration",
			"readonly",
			"static",
		])
	})
})

describe("Semantic Tokens in where clauses", () => {
	it("should classify where-clause mentions as Generics and Protocols", () => {
		let source = [
			"implementation {",
			"\tprotocol Sizable {",
			"\t\tsize() -> Integer",
			"\t}",
			"\tnamespace Boxy<infer Item> for { value: Item }",
			"\t\tis Sizable where Item is Sizable",
			"\t{",
			"\t\tsize() -> Integer {",
			"\t\t\t<- @.value::size()",
			"\t\t}",
			"\t}",
			"}",
		].join("\n")

		expect(tokenAt(source, 6, 6)?.type).toBe("type")
		expect(tokenAt(source, 6, 20)?.type).toBe("typeParameter")
		expect(tokenAt(source, 6, 28)?.type).toBe("type")
	})
})
