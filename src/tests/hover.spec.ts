import { describe, expect, it } from "bun:test"

import { enrich } from "../enricher/index"
import type { common } from "../interfaces/index"
import { findHover } from "../lsp/hover"
import { parseWithDiagnostics } from "../parser/index"

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

		// NOTE: Callables read back as their declaration rather than as a
		// name bound to a Function Type.
		expect(hover(source, { line: 2, column: 11 })).toBe(
			"function greet(subject: String) -> String",
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

	it("should describe an aliased Union Type by its Alias's name", () => {
		let source = [
			"implementation {",
			"\ttype Value = Integer | String",
			"\tconstant something: Value = 42",
			"\t__print(something)",
			"}",
		].join("\n")

		expect(hover(source, { line: 4, column: 10 })).toBe("something: Value")
	})

	it("should describe an anonymous Union Type member by member", () => {
		let source = [
			"implementation {",
			"\tconstant something: Integer | String = 42",
			"\t__print(something)",
			"}",
		].join("\n")

		expect(hover(source, { line: 3, column: 10 })).toBe(
			"something: Integer | String",
		)
	})

	it("should print a flat fallible Union exactly as written", () => {
		// NOTE: `Integer | Rational | Nothing` is built canonical — payload
		// nested beside `Nothing` — but the nesting is anonymous, so the
		// Hover still spells the members out just as the source does.
		let source = [
			"implementation {",
			"\tconstant something: Integer | Rational | Nothing = 42",
			"\t__print(something)",
			"}",
		].join("\n")

		expect(hover(source, { line: 3, column: 10 })).toBe(
			"something: Integer | Rational | Nothing",
		)
	})

	it("should keep a named Alias by name inside a wider Union", () => {
		let source = [
			"implementation {",
			"\ttype MaybeInt = Integer | Nothing",
			"\tconstant mixed: MaybeInt | Rational = 1",
			"\t__print(mixed)",
			"}",
		].join("\n")

		expect(hover(source, { line: 4, column: 10 })).toBe(
			"mixed: MaybeInt | Rational",
		)
	})

	it("should keep `Number` by name inside a Union Type", () => {
		let source = [
			"implementation {",
			"\tconstant something: Number | Nothing = 42",
			"\t__print(something)",
			"}",
		].join("\n")

		expect(hover(source, { line: 3, column: 10 })).toBe(
			"something: Number | Nothing",
		)
	})

	it("should describe the builtin `Optional` as applied", () => {
		let source = [
			"implementation {",
			"\tconstant something: Optional<Integer> = nothing",
			"\t__print(something)",
			"}",
		].join("\n")

		expect(hover(source, { line: 3, column: 10 })).toBe(
			"something: Optional<Integer>",
		)
	})

	it("should describe a userland Generic Alias as applied", () => {
		let source = [
			"implementation {",
			"\ttype Fallible<Value> = Value | String",
			"\tconstant something: Fallible<Integer> = 42",
			"\t__print(something)",
			"}",
		].join("\n")

		expect(hover(source, { line: 4, column: 10 })).toBe(
			"something: Fallible<Integer>",
		)
	})

	it("should keep an untouched `Number` by name when a wildcard narrows", () => {
		let source = [
			"implementation {",
			"\tconstant value: Number | Nothing = 42",
			"\t__print(match value -> Number {",
			"\t\tcase Nothing { <- 0 }",
			"\t\tcase _ { <- @ }",
			"\t})",
			"}",
		].join("\n")

		expect(hover(source, { line: 5, column: 15 })).toBe("@: Number")
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
			"append(_ String) -> String",
		)
	})

	it("should describe a Static Method with its keyword", () => {
		let source = [
			"implementation {",
			"\tnamespace Thing {",
			"\t\tstatic show(value: Integer) -> String {",
			'\t\t\t<- "42"',
			"\t\t}",
			"\t}",
			"}",
		].join("\n")

		expect(hover(source, { line: 3, column: 14 })).toBe(
			"static show(value: Integer) -> String",
		)
	})

	it("should describe a Method by its name in its declaration", () => {
		let source = [
			"implementation {",
			"\tnamespace Stringify for Integer {",
			"\t\tlabel(_ prefix: String) -> String {",
			"\t\t\t<- prefix",
			"\t\t}",
			"\t}",
			"}",
		].join("\n")

		// NOTE: The cursor is on `label` itself, which the Namespace also
		// contains — the Method's name is the smaller node, so it wins.
		expect(hover(source, { line: 3, column: 4 })).toBe(
			"label(_ String) -> String",
		)
	})

	it("should describe every Overload by the name they share", () => {
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
			"}",
		].join("\n")

		expect(hover(source, { line: 3, column: 13 })).toBe(
			"combine(_ Integer) -> Integer\ncombine(_ Integer, _ Integer) -> Integer",
		)
	})

	it("should describe a Namespace's static Property by its name", () => {
		let source = [
			"implementation {",
			"\tnamespace Thing {",
			'\t\tstatic label = "hi"',
			"\t}",
			"}",
		].join("\n")

		expect(hover(source, { line: 3, column: 11 })).toBe(
			"static label: String",
		)
	})

	it("should describe a Static Method invocation", () => {
		let source = [
			"implementation {",
			"\tnamespace Thing {",
			"\t\tstatic show(value: Integer) -> String {",
			'\t\t\t<- "42"',
			"\t\t}",
			"\t}",
			"\tThing.show(1)",
			"}",
		].join("\n")

		expect(hover(source, { line: 7, column: 9 })).toBe(
			"show(value: Integer) -> String",
		)
	})

	it("should narrow an Overloaded Method to the invoked signature", () => {
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
			"\t__print(1::combine(2))",
			"}",
		].join("\n")

		// NOTE: The Arguments pick the first Overload, so only that one is
		// shown — the others are noise once the call resolved.
		expect(hover(source, { line: 12, column: 14 })).toBe(
			"combine(_ Integer) -> Integer",
		)
	})

	it("should pick the Overload the Arguments selected, not the first one", () => {
		let source = ["implementation {", "\t__print(1::add(2/1))", "}"].join(
			"\n",
		)

		expect(hover(source, { line: 2, column: 13 })).toBe(
			"add(_ Rational) -> Rational",
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

	it("should describe a Protocol declaration with its requirements", () => {
		let source = [
			"implementation {",
			"\tprotocol Sizable {",
			"\t\tsize() -> Integer",
			"\t}",
			"}",
		].join("\n")

		expect(hover(source, { line: 2, column: 12 })).toBe(
			"protocol Sizable\nsize() -> Integer",
		)
	})

	it("should return null outside of any typed node", () => {
		let source = ["implementation {", "\tconstant a = 1", "}"].join("\n")

		expect(hover(source, { line: 1, column: 1 })).toBeNull()
	})
})
