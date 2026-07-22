import { describe, expect, it } from "bun:test"

import { enrich } from "../enricher/index"
import {
	encodeSemanticTokens,
	findSemanticTokens,
	semanticTokenTypes,
} from "../lsp/semanticTokens"
import { parseWithDiagnostics } from "../parser/index"

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
			"\t\t<- items::itemAt(0)",
			"\t}",
			"}",
		].join("\n")

		expect(tokenAt(source, 2, 7)?.type).toBe("type")
		expect(tokenAt(source, 3, 12)?.type).toBe("namespace")
		expect(tokenAt(source, 8, 17)?.type).toBe("typeParameter")
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
