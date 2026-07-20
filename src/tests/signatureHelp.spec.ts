import { describe, expect, it } from "bun:test"

import { findSignatureHelp } from "../lsp/signatureHelp"

describe("Signature Help", () => {
	it("should show a Function's signature right after the opening paren", () => {
		let source = [
			"implementation {",
			"\tfunction greet (subject: String) -> String {",
			"\t\t<- subject",
			"\t}",
			"\tgreet(",
			"}",
		].join("\n")

		let help = findSignatureHelp(source, { line: 5, column: 8 })

		expect(help).not.toBeNull()
		expect(help?.signatures).toHaveLength(1)
		expect(help?.signatures[0].label).toBe("(subject: String) -> String")
		expect(help?.activeParameter).toBe(0)
	})

	it("should advance the active Parameter across commas", () => {
		let source = [
			"implementation {",
			"\tfunction combine (first: Integer, second: Integer) -> Integer {",
			"\t\t<- first",
			"\t}",
			"\tcombine(1, ",
			"}",
		].join("\n")

		let help = findSignatureHelp(source, { line: 5, column: 13 })

		expect(help?.activeParameter).toBe(1)
	})

	it("should not count commas inside a String Literal argument", () => {
		let source = [
			"implementation {",
			"\tfunction combine (first: String, second: String) -> String {",
			"\t\t<- first",
			"\t}",
			'\tcombine("hello, world", ',
			"}",
		].join("\n")

		let help = findSignatureHelp(source, { line: 5, column: 25 })

		expect(help?.activeParameter).toBe(1)
	})

	it("should not let a bracket inside a String Literal cut the scan short", () => {
		let source = [
			"implementation {",
			"\tfunction three (a: String, b: String, c: String) -> String {",
			"\t\t<- a",
			"\t}",
			'\tthree("x", "(", ',
			"}",
		].join("\n")

		let help = findSignatureHelp(source, { line: 5, column: 18 })

		expect(help?.activeParameter).toBe(2)
	})

	it("should resolve to the innermost call and count only its own commas", () => {
		let source = [
			"implementation {",
			"\tfunction pair (first: Integer, second: Integer) -> Integer {",
			"\t\t<- first",
			"\t}",
			"\tfunction identity (value: Integer, extra: Integer) -> Integer {",
			"\t\t<- value",
			"\t}",
			"\tpair(identity(1, ",
			"}",
		].join("\n")

		// NOTE: The cursor is inside `identity`'s parens — Signature Help
		// resolves to it, not to the outer `pair` call, and the comma so far
		// is `identity`'s own, advancing its second Parameter.
		let help = findSignatureHelp(source, { line: 8, column: 20 })

		expect(help?.signatures[0].label).toBe(
			"(value: Integer, extra: Integer) -> Integer",
		)
		expect(help?.activeParameter).toBe(1)
	})

	it("should show every Overload and mark the resolved one active", () => {
		let source = [
			"implementation {",
			"\tnamespace Thing for Integer {",
			"\t\toverload combine {",
			"\t\t\t(_ other: Integer) -> Integer {",
			"\t\t\t\t<- 42",
			"\t\t\t}",
			"\t\t\t(_ other: Integer, _ third: Integer) -> Integer {",
			"\t\t\t\t<- 42",
			"\t\t\t}",
			"\t\t}",
			"\t}",
			"\t1::combine(2, ",
			"}",
		].join("\n")

		let help = findSignatureHelp(source, { line: 12, column: 16 })

		expect(help?.signatures).toHaveLength(2)
		expect(help?.signatures[1].label).toBe(
			"(_ Integer, _ Integer) -> Integer",
		)
	})

	it("should strip Self from a Simple Method's signature", () => {
		let source = ["implementation {", '\t"Hello"::append(', "}"].join("\n")

		let help = findSignatureHelp(source, { line: 2, column: 18 })

		expect(help?.signatures[0].label).toBe("(_ String) -> String")
	})

	it("should return null outside of any invocation", () => {
		let source = ["implementation {", "\tconstant value = 1", "}"].join(
			"\n",
		)

		expect(findSignatureHelp(source, { line: 2, column: 5 })).toBeNull()
	})

	it("should return null for an unknown callee", () => {
		let source = ["implementation {", "\tnotAFunction(", "}"].join("\n")

		expect(findSignatureHelp(source, { line: 2, column: 15 })).toBeNull()
	})
})
