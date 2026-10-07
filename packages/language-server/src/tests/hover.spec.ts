import { describe, expect, it } from "bun:test"

import { enrich } from "@essence-lang/compiler/enricher"
import { parseWithDiagnostics } from "@essence-lang/compiler/parser"
import type { common } from "@essence-lang/interfaces"

import { findHover } from "../hover"

// Both Programs and the annotation index, which `connection.onHover` hands
// `findHover` for every document.
function hoverInfo(source: string, cursor: common.Cursor) {
	let { program } = parseWithDiagnostics(source)
	let { program: enrichedProgram, annotations } = enrich(program, {
		annotations: true,
	})

	return findHover(enrichedProgram, cursor, program, annotations, source)
}

function hover(source: string, cursor: common.Cursor): string | null {
	return hoverInfo(source, cursor)?.content ?? null
}

function hoverDocumentation(
	source: string,
	cursor: common.Cursor,
): string | null {
	return hoverInfo(source, cursor)?.documentation ?? null
}

// The same, with the `tests` block enriched.
function testsHover(source: string, cursor: common.Cursor): string | null {
	let { program } = parseWithDiagnostics(source)
	let { program: enrichedProgram, annotations } = enrich(program, {
		annotations: true,
		tests: true,
	})

	return (
		findHover(enrichedProgram, cursor, program, annotations, source)
			?.content ?? null
	)
}

describe("Hover", () => {
	// A step a dotted key reaches through answers as the member it names, since
	// the synthesized Lookup's member stands where the step was written.
	it("should answer a path key's step with the member it names", () => {
		let source = [
			"implementation {",
			"\ttype Tls = { enabled: Boolean }",
			"\ttype Server = { host: String, port: Integer, tls: Tls }",
			"\ttype Config = { name: String, server: Server }",
			"",
			"\tconstant config: Config = {",
			'\t\tname = "api",',
			'\t\tserver = { host = "h", port = 80, tls = { enabled = false } },',
			"\t}",
			"\tconstant deep = { config with server.tls.enabled = true }",
			"}",
		].join("\n")

		expect(hover(source, { line: 10, column: 32 })).toBe("server: Server")
		expect(hover(source, { line: 10, column: 39 })).toBe("tls: Tls")
	})

	// A path key in a Literal merged into a default has no synthesized Lookup.
	// A step answers with the level it is a key of, as a plain key does.
	it("should answer a merged path key's step with the level it writes", () => {
		let source = [
			"implementation {",
			"\ttype Tls = { enabled: Boolean }",
			"\ttype Server = { host: String, port: Integer, tls: Tls }",
			"\ttype Config = { name: String, server: Server }",
			"",
			"\t§§ Answers the host.",
			"\t§§",
			"\t§§ @param using — how to connect.",
			"\t§§ @returns — the host.",
			"\tfunction connect(",
			"\t\tusing config: Config = {",
			'\t\t\tname = "api",',
			'\t\t\tserver = { host = "h", port = 80, tls = { enabled = false } },',
			"\t\t},",
			"\t) -> String {",
			"\t\t<- config.server.host",
			"\t}",
			"",
			"\tconstant deep = connect(using { server.tls.enabled = true })",
			"}",
		].join("\n")

		expect(hover(source, { line: 19, column: 34 })).toBe(
			"{ server: { tls: { enabled: Boolean } } }",
		)
		expect(hover(source, { line: 19, column: 41 })).toBe(
			"{ tls: { enabled: Boolean } }",
		)
	})

	it("should describe Identifiers with their inferred Type", () => {
		let source = [
			"implementation {",
			'\tconstant name = "Essence"',
			"\tTerminal.inspect(name)",
			"}",
		].join("\n")

		expect(hover(source, { line: 3, column: 19 })).toBe("name: String")
	})

	it("should describe Functions with their full signature", () => {
		let source = [
			"implementation {",
			"\tfunction greet (subject: String) -> String {",
			"\t\t<- subject",
			"\t}",
			"}",
		].join("\n")

		// Callables read back as their declaration rather than as a
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
		let source = [
			"implementation {",
			"\tconstant a = 42",
			"\tconstant b = 0.75",
			"}",
		].join("\n")

		expect(hover(source, { line: 2, column: 15 })).toBe("Integer")
		// A decimal is one Rational Literal, not an Integer and a member path,
		// so a cursor past the dot answers as one before it.
		expect(hover(source, { line: 3, column: 15 })).toBe("Rational")
		expect(hover(source, { line: 3, column: 17 })).toBe("Rational")
	})

	it("should describe an aliased Union Type by its Alias's name", () => {
		let source = [
			"implementation {",
			"\ttype Value = Integer | String",
			"\tconstant something: Value = 42",
			"\tTerminal.inspect(something)",
			"}",
		].join("\n")

		expect(hover(source, { line: 4, column: 19 })).toBe("something: Value")
	})

	// A value of a Record Alias answers with the Alias's name. The word itself,
	// on a Declaration, annotation or import entry, answers with the members.
	it("should describe a value of a Record Alias by the Alias's name", () => {
		let source = [
			"implementation {",
			"\ttype Team = { name: String, code: String }",
			"\ttype Standing = { team: Team, points: Integer }",
			'\tconstant blank: Standing = { team = { name = "a", code = "b" }, points = 0 }',
			"\tTerminal.inspect(blank)",
			"}",
		].join("\n")

		expect(hover(source, { line: 5, column: 19 })).toBe("blank: Standing")
	})

	it("should describe the Alias's own Declaration by its members", () => {
		let source = [
			"implementation {",
			"\ttype Team = { name: String, code: String }",
			"\ttype Standing = { team: Team, points: Integer }",
			"}",
		].join("\n")

		// One level only: `team` stays `Team`, since expanding it would answer
		// a Declaration the cursor is not on.
		expect(hover(source, { line: 3, column: 8 })).toBe(
			"Standing: { team: Team, points: Integer }",
		)
	})

	it("should describe an annotation naming a Record Alias by its members", () => {
		let source = [
			"implementation {",
			"\ttype Point = { x: Integer, y: Integer }",
			"\tconstant here: Point = { x = 0, y = 0 }",
			"}",
		].join("\n")

		expect(hover(source, { line: 3, column: 17 })).toBe(
			"{ x: Integer, y: Integer }",
		)
	})

	it("should describe a generic Record Alias by its body", () => {
		let source = [
			"implementation {",
			"\ttype Pair<Held> = { first: Held, second: Held }",
			"}",
		].join("\n")

		expect(hover(source, { line: 2, column: 8 })).toBe(
			"Pair: { first: Held, second: Held }",
		)
	})

	it("should describe an applied generic Record Alias as applied", () => {
		let source = [
			"implementation {",
			"\ttype Pair<Held> = { first: Held, second: Held }",
			"\tconstant both: Pair<Integer> = { first = 1, second = 2 }",
			"\tTerminal.inspect(both)",
			"}",
		].join("\n")

		expect(hover(source, { line: 4, column: 19 })).toBe(
			"both: Pair<Integer>",
		)
	})

	it("should describe an anonymous Union Type member by member", () => {
		let source = [
			"implementation {",
			"\tconstant something: Integer | String = 42",
			"\tTerminal.inspect(something)",
			"}",
		].join("\n")

		expect(hover(source, { line: 3, column: 19 })).toBe(
			"something: Integer | String",
		)
	})

	it("should print a wide anonymous Union exactly as written", () => {
		// `buildUnion` dedupes and flattens but does not regroup, so an
		// anonymous Union reads back flat, in the written order.
		let source = [
			"implementation {",
			"\tconstant something: Integer | Rational | String = 42",
			"\tTerminal.inspect(something)",
			"}",
		].join("\n")

		expect(hover(source, { line: 3, column: 19 })).toBe(
			"something: Integer | Rational | String",
		)
	})

	it("should keep a named Alias by name inside a wider Union", () => {
		// Only an anonymous nested Union is flattened. A member with a name of
		// its own stays whole, so the reader sees the name they wrote.
		let source = [
			"implementation {",
			"\ttype IntOrText = Integer | String",
			"\tconstant mixed: IntOrText | Rational = 1",
			"\tTerminal.inspect(mixed)",
			"}",
		].join("\n")

		expect(hover(source, { line: 4, column: 19 })).toBe(
			"mixed: IntOrText | Rational",
		)
	})

	it("should keep `Number` by name inside a Union Type", () => {
		// `Number` is a named Union from the standard library, so the same holds
		// for a builtin Alias.
		let source = [
			"implementation {",
			"\tconstant something: Number | String = 42",
			"\tTerminal.inspect(something)",
			"}",
		].join("\n")

		expect(hover(source, { line: 3, column: 19 })).toBe(
			"something: Number | String",
		)
	})

	it("should describe the builtin `Optional` as applied", () => {
		let source = [
			"implementation {",
			"\tconstant something: Optional<Integer> = #Empty",
			"\tTerminal.inspect(something)",
			"}",
		].join("\n")

		expect(hover(source, { line: 3, column: 19 })).toBe(
			"something: Optional<Integer>",
		)
	})

	it("should describe a userland Generic Alias as applied", () => {
		let source = [
			"implementation {",
			"\ttype Fallible<Value> = Value | String",
			"\tconstant something: Fallible<Integer> = 42",
			"\tTerminal.inspect(something)",
			"}",
		].join("\n")

		expect(hover(source, { line: 4, column: 19 })).toBe(
			"something: Fallible<Integer>",
		)
	})

	it("should keep an untouched `Number` by name when a wildcard narrows", () => {
		// The wildcard's `@` is the scrutinee minus what earlier Handlers
		// claimed. What is left shows under the name the source wrote, not as
		// `Number`'s members.
		let source = [
			"implementation {",
			"\tconstant value: Number | String = 42",
			"\tTerminal.inspect(match value -> Number {",
			"\t\tcase String { <- 0 }",
			"\t\tcase _ { <- @ }",
			"\t})",
			"}",
		].join("\n")

		expect(hover(source, { line: 5, column: 15 })).toBe("@: Number")
	})

	it("should describe Method invocations", () => {
		let source = [
			"implementation {",
			'\tTerminal.inspect("Hello"::append("!"))',
			"}",
		].join("\n")

		// Self is stripped from the signature, since a call site passes one
		// String to `append`.
		expect(hover(source, { line: 2, column: 29 })).toBe(
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

		// The cursor is on `label`, which the Namespace also contains. The
		// Method's name is the smaller node, so it wins.
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

	// The refusal is an Error to every reader, but the name still names the
	// Namespace, as it does where a Method is read off it.
	it("should describe a Namespace refused as a value as the Namespace", () => {
		let source = [
			"implementation {",
			"\tnamespace Clock {",
			"\t\tstatic now() -> Integer {",
			"\t\t\t<- 1",
			"\t\t}",
			"\t}",
			"\tTerminal.inspect(Clock)",
			"\tTerminal.inspect(Clock.now())",
			"}",
		].join("\n")

		expect(hover(source, { line: 7, column: 20 })).toBe("Clock: Clock")
		expect(hover(source, { line: 8, column: 20 })).toBe("Clock: Clock")
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

	// A derived Method has no declaration to read a `§§` off, so the
	// Protocol's requirement, which the derive is built from, documents it.
	it("should describe a Choice's derived Case listing", () => {
		let source = [
			"implementation {",
			"\tTerminal.print(Side.cases()::length())",
			"}",
		].join("\n")

		expect(hover(source, { line: 2, column: 23 })).toBe(
			"cases() -> NonEmptyList<Side>",
		)
		expect(hoverDocumentation(source, { line: 2, column: 23 })).toContain(
			"Answers every value of the Type.",
		)
	})

	// The base answers as the Choice the author named, not the Namespace the
	// Compiler made to read the Method off. So does a Type Parameter a bounded
	// body calls the static on.
	it("should describe the base of a derived static as what it names", () => {
		let source = [
			"implementation {",
			"\tchoice Colour { Red, Green, }",
			"\tfunction count<infer Mode is Enumerable>(_ example: Mode) -> Integer {",
			"\t\t<- Mode.cases()::length()",
			"\t}",
			"\tconstant red: Colour = #Red",
			"\tTerminal.print(count(red))",
			"}",
		].join("\n")

		expect(hover(source, { line: 4, column: 7 })).toBe("Mode: Mode")
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
			"\tTerminal.inspect(1::combine(2))",
			"}",
		].join("\n")

		// The Arguments pick the first Overload, so only that one is shown.
		expect(hover(source, { line: 12, column: 23 })).toBe(
			"combine(_ Integer) -> Integer",
		)
	})

	it("should pick the Overload the Arguments selected, not the first one", () => {
		let source = [
			"implementation {",
			"\tTerminal.inspect(1::add(2/1))",
			"}",
		].join("\n")

		expect(hover(source, { line: 2, column: 22 })).toBe(
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

		// Hovering the argument literal must not show the invocation.
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

	// A callee's Generics are renamed for one invocation with a zero-width
	// space and a counter. `T` occurs only inside the callback, so it stays
	// unbound and Hover must print it as written.
	it("should describe a Generic under the name the source wrote", () => {
		let source = [
			"implementation {",
			"\tfunction apply <infer T>(_ f: (_: T) -> T, times n: Integer) -> {} {",
			"\t\t<- {}",
			"\t}",
			"\tconstant r = apply((x) { <- x }, times 5)",
			"}",
		].join("\n")

		expect(hover(source, { line: 5, column: 22 })).toBe("x: T")
		expect(hover(source, { line: 5, column: 21 })).toBe("(_ T) -> T")
	})

	it("should return null outside of any typed node", () => {
		let source = ["implementation {", "\tconstant a = 1", "}"].join("\n")

		expect(hover(source, { line: 1, column: 1 })).toBeNull()
	})
})

// A line's margins have no Hover: its indentation, the blank after its last
// character, and a blank line. A space between two tokens answers as what
// spans them.
describe("Hover in a line's margins", () => {
	const source = [
		"implementation {",
		// Three trailing spaces after the call.
		"\tconstant total = 1::add(2)   ",
		"\tconstant person = {",
		'\t\tname = "Ada Lovelace",',
		"",
		"\t\tage = 36,",
		"\t}",
		"}",
	].join("\n")

	it("says nothing in the indentation", () => {
		expect(hover(source, { line: 2, column: 1 })).toBeNull()
		expect(hover(source, { line: 6, column: 2 })).toBeNull()
	})

	it("says nothing after the last character of a line", () => {
		expect(hover(source, { line: 2, column: 29 })).toBeNull()
		expect(hover(source, { line: 2, column: 40 })).toBeNull()
	})

	it("says nothing on a blank line inside a Literal", () => {
		expect(hover(source, { line: 5, column: 1 })).toBeNull()
		expect(hover(source, { line: 6, column: 3 })).toBe(
			"{ name: String, age: Integer }",
		)
	})

	it("answers between two tokens with what spans them", () => {
		// The space between `constant` and `total` is in the
		// declaration's head, and the head answers for it.
		expect(hover(source, { line: 2, column: 10 })).toBe(
			"total: PositiveInteger",
		)
		expect(hover(source, { line: 4, column: 14 })).toBe("String")
	})
})

// The typed tree erases annotations, so these are answered from the
// annotations the Enricher lists beside the Program. See "What the typed tree
// lacks" in packages/language-server/DEVELOPMENT.md.
describe("Hover of Type annotations", () => {
	it("should describe a Function's Parameter and return annotations", () => {
		let source = [
			"implementation {",
			"\tfunction greet (subject: String) -> String {",
			"\t\t<- subject",
			"\t}",
			"}",
		].join("\n")

		expect(hover(source, { line: 2, column: 27 })).toBe("String")
		expect(hover(source, { line: 2, column: 38 })).toBe("String")
		// The Parameter's name still wins over the annotation beside it, since
		// the index adds candidates and does not outrank the typed tree.
		expect(hover(source, { line: 2, column: 20 })).toBe("subject: String")
	})

	it("should describe a Constant's annotation, and the Type inside it", () => {
		let source = [
			"implementation {",
			"\tconstant xs: List<Integer> = [1]",
			"\tTerminal.inspect(xs)",
			"}",
		].join("\n")

		expect(hover(source, { line: 2, column: 16 })).toBe("List<Integer>")
		expect(hover(source, { line: 2, column: 22 })).toBe("Integer")
	})

	it("should describe a Namespace's target Type and its Methods' annotations", () => {
		let source = [
			"implementation {",
			"\tnamespace Boxes<infer Item> for List<Item> {",
			"\t\tfirst(fallback: Item) -> Item {",
			"\t\t\t<- fallback",
			"\t\t}",
			"\t}",
			"}",
		].join("\n")

		expect(hover(source, { line: 2, column: 35 })).toBe("List<Item>")
		expect(hover(source, { line: 2, column: 40 })).toBe("Item")
		expect(hover(source, { line: 3, column: 20 })).toBe("Item")
		expect(hover(source, { line: 3, column: 29 })).toBe("Item")
	})

	it("should describe a Record annotation and the Types within it", () => {
		let source = [
			"implementation {",
			"\tnamespace Box<infer Item> for { value: Item }",
			"\t\tis Comparable where Item is Comparable",
			"\t{",
			"\t\tcompare(to other: { value: Item }) -> Ordering {",
			"\t\t\t<- @.value::compare(to other.value)",
			"\t\t}",
			"\t}",
			"}",
		].join("\n")

		expect(hover(source, { line: 2, column: 33 })).toBe("{ value: Item }")
		expect(hover(source, { line: 5, column: 23 })).toBe("{ value: Item }")
		expect(hover(source, { line: 5, column: 32 })).toBe("Item")
		expect(hover(source, { line: 5, column: 42 })).toBe("Ordering")
	})

	// The collector is opened once around the whole enrichment. `enrichStatement`
	// reuses the hoisted Type for these declarations, so their annotations are
	// resolved only while hoisting.
	it("should describe annotations that are only ever resolved while hoisting", () => {
		let source = [
			"implementation {",
			"\ttype Value = Integer | String",
			"\tprotocol Sizable {",
			"\t\tsize() -> Integer",
			"\t}",
			"\tchoice Box<Item> {",
			"\t\tHolding { value: Item },",
			"\t\tEmpty,",
			"\t}",
			"}",
		].join("\n")

		// A Union annotation, and each of its members on its own.
		expect(hover(source, { line: 2, column: 16 })).toBe("Integer")
		expect(hover(source, { line: 2, column: 26 })).toBe("String")
		expect(hover(source, { line: 2, column: 23 })).toBe("Integer | String")
		// A Protocol requirement's return Type.
		expect(hover(source, { line: 4, column: 14 })).toBe("Integer")
		// A generic Choice's payload member.
		expect(hover(source, { line: 7, column: 21 })).toBe("Item")
	})
})

// Each of these has a Position in the typed tree and is offered as a
// candidate.
describe("Hover of declaration parts", () => {
	// One declaration, one answer. The keyword and the name answer alike for
	// a Record Alias, though the Statement carries the shape and the binding
	// carries the Alias.
	it("should answer the same on the keyword as on the name", () => {
		let source = [
			"implementation {",
			"\ttype Team = { name: String }",
			"",
			'\tconstant t: Team = { name = "Rovers" }',
			"}",
		].join("\n")

		expect(hover(source, { line: 4, column: 3 })).toBe("t: Team")
		expect(hover(source, { line: 4, column: 11 })).toBe("t: Team")
	})

	it("should describe a Type Parameter as it was declared", () => {
		let source = [
			"implementation {",
			"\tfunction firstOr <infer Item is Printable>(_ items: List<Item>) -> String {",
			'\t\t<- "x"',
			"\t}",
			"}",
		].join("\n")

		expect(hover(source, { line: 2, column: 25 })).toBe(
			"infer Item is Printable",
		)
	})

	// `_: Integer` has neither label nor name, so the Parameter answers.
	it("should describe a Parameter that binds no name", () => {
		let source = [
			"implementation {",
			"\tconstant flat = (_: Integer, on _: String) -> Integer { <- 1 }",
			"}",
		].join("\n")

		expect(hover(source, { line: 2, column: 19 })).toBe("Integer")
		expect(hover(source, { line: 2, column: 34 })).toBe("String")
		expect(hover(source, { line: 2, column: 31 })).toBe("on: String")
	})

	it("should describe a Parameter the cursor sits on but not inside", () => {
		let source = [
			"implementation {",
			"\tfunction firstOr <infer Item is Printable>(_ items: List<Item>) -> String {",
			'\t\t<- "x"',
			"\t}",
			"}",
		].join("\n")

		// The bare `_` binds no name, so the Parameter itself answers.
		expect(hover(source, { line: 2, column: 45 })).toBe("List<Item>")
	})

	// The requirement and the inequalities `Comparable` provides over it,
	// listed as a Namespace's members are.
	const COMPARABLE_HOVER = [
		"protocol Comparable",
		"compare(to: Self) -> Ordering",
		"isLessThan(_ Self) -> Boolean",
		"isLessThanOrEqualTo(_ Self) -> Boolean",
		"isGreaterThan(_ Self) -> Boolean",
		"isGreaterThanOrEqualTo(_ Self) -> Boolean",
	].join("\n")

	it("should describe a conformance clause as the Protocol it names", () => {
		let source = [
			"implementation {",
			"\tnamespace Box<infer Item> for { value: Item }",
			"\t\tis Comparable where Item is Comparable",
			"\t{",
			"\t\tcompare(to other: { value: Item }) -> Ordering {",
			"\t\t\t<- @.value::compare(to other.value)",
			"\t\t}",
			"\t}",
			"}",
		].join("\n")

		expect(hover(source, { line: 3, column: 10 })).toBe(COMPARABLE_HOVER)
	})

	it("should describe what a Return Statement returns", () => {
		let source = [
			"implementation {",
			"\tfunction greet (subject: String) -> String {",
			"\t\t<- subject",
			"\t}",
			"}",
		].join("\n")

		expect(hover(source, { line: 3, column: 4 })).toBe("String")
	})

	it("should describe both halves of a where condition", () => {
		let source = [
			"implementation {",
			"\tnamespace Box<infer Item> for { value: Item }",
			"\t\tis Comparable where Item is Comparable",
			"\t{",
			"\t\tcompare(to other: { value: Item }) -> Ordering {",
			"\t\t\t<- @.value::compare(to other.value)",
			"\t\t}",
			"\t}",
			"}",
		].join("\n")

		expect(hover(source, { line: 3, column: 24 })).toBe("infer Item")
		expect(hover(source, { line: 3, column: 33 })).toBe(COMPARABLE_HOVER)
	})
})

// A declaration answers on its head, not across its whole Position, so its
// body's blank lines and indentation answer nothing.
describe("Hover inside a declaration's body", () => {
	it("should answer nothing on blank lines and body indentation", () => {
		let source = [
			"implementation {",
			"\tfunction f (n: Integer) -> Integer {",
			"",
			"\t\tif n::isGreaterThan(1) {",
			"\t\t\tTerminal.inspect(n)",
			"\t\t}",
			"",
			"\t\t<- n",
			"\t}",
			"}",
		].join("\n")

		// A blank line inside the body, at any column.
		expect(hover(source, { line: 3, column: 1 })).toBeNull()
		expect(hover(source, { line: 7, column: 4 })).toBeNull()
		// The indentation before a Statement, and a nested block's closing
		// brace.
		expect(hover(source, { line: 4, column: 2 })).toBeNull()
		expect(hover(source, { line: 6, column: 3 })).toBeNull()
		// The head itself still answers.
		expect(hover(source, { line: 2, column: 3 })).toBe(
			"function f(n: Integer) -> Integer",
		)
	})

	it("should answer nothing between a Namespace's Methods", () => {
		let source = [
			"implementation {",
			"\tnamespace Thing {",
			"",
			"\t\tstatic show(value: Integer) -> String {",
			'\t\t\t<- "42"',
			"\t\t}",
			"",
			"\t}",
			"}",
		].join("\n")

		expect(hover(source, { line: 3, column: 1 })).toBeNull()
		expect(hover(source, { line: 7, column: 2 })).toBeNull()
		expect(hover(source, { line: 2, column: 3 })).toBe("Thing: Thing")
	})

	// The margin is read off the cursor's own line, the first and the last
	// included. Both margins lie inside the List's span, which would answer
	// without the rule.
	it("should read the margin of the first and the last line", () => {
		let source = [
			"implementation { constant total = [",
			"\t1,",
			"\t2 ] }",
		].join("\n")

		expect(hover(source, { line: 1, column: 35 })).toBe("List<Integer>")
		expect(hover(source, { line: 1, column: 36 })).toBeNull()
		expect(hover(source, { line: 3, column: 1 })).toBeNull()
		expect(hover(source, { line: 3, column: 2 })).toBe("Integer")
		expect(hover(source, { line: 4, column: 1 })).toBeNull()
	})
})

// A literal Matcher's value, a Record Matcher's by-value members and the
// Guard are Expressions like any other, each answering for itself.
describe("Hover inside a Match Handler", () => {
	let source = [
		"implementation {",
		"\ttype Point = { x: Integer, y: Integer }",
		"",
		"\tfunction describe (_ value: Integer | Point) -> String {",
		"\t\t<- match value -> String {",
		'\t\t\tcase 0 { <- "zero" }',
		'\t\t\tcase Integer where @::isNegative() { <- "negative" }',
		'\t\t\tcase Integer { <- "positive" }',
		'\t\t\tcase { x = 0, y: Integer } { <- "the y axis" }',
		'\t\t\tcase { x: Integer, y: Integer } { <- "elsewhere" }',
		"\t\t}",
		"\t}",
		"}",
	].join("\n")

	it("should describe a literal Matcher's value", () => {
		expect(hover(source, { line: 6, column: 9 })).toBe("Integer")
	})

	it("should describe a Record Matcher's member literal", () => {
		expect(hover(source, { line: 9, column: 15 })).toBe("Integer")
	})

	it("should describe a Guard's scrutinee and the Method it invokes", () => {
		// `@` is narrowed to what the Matcher established, and to
		// `NonZeroInteger`, since an earlier Case named `0`. The Hover says the
		// name the evidence has.
		expect(hover(source, { line: 7, column: 23 })).toBe("@: NonZeroInteger")
		expect(hover(source, { line: 7, column: 30 })).toBe(
			"isNegative() -> Boolean",
		)
	})
})

// A `require` Matcher's by-value members answer as a Match Handler's do.
describe("Hover inside a require Matcher", () => {
	it("should describe a Record Matcher's member literal", () => {
		let source = [
			"implementation {",
			"\ttype Standing = { team: String, points: Integer }",
			"}",
			"",
			"tests {",
			'\ttest "a new team has no points" {',
			'\t\tconstant standing: Standing = { team = "Lions", points = 0 }',
			"",
			"\t\trequire { team: String, points = 0 } = standing",
			"\t}",
			"}",
		].join("\n")

		expect(testsHover(source, { line: 9, column: 36 })).toBe("Integer")
	})
})

// A `require` reads its subject through a Constant the Compiler named at the
// subject's span. A table test's row Pattern takes apart a row the Compiler
// named at the Pattern's span. Neither name answers.
describe("Hover over a value the Compiler named in a test", () => {
	let source = [
		"implementation {",
		"\ttype Standing = { team: String, points: Integer }",
		"}",
		"",
		"tests {",
		'\ttest "a team is found" {',
		'\t\tconstant found: Optional<Standing> = #Value({ team = "Lions", points = 0 })',
		"",
		"\t\trequire #Value(standing) = found",
		"\t}",
		"",
		'\ttest "{team} starts at {points}" across [',
		'\t\t{ team = "Lions", points = 0 },',
		"\t] ({ team, points }: Standing) {",
		"\t\texpect points::is(0)",
		"\t}",
		"}",
	].join("\n")

	it("answers for a require subject with the subject", () => {
		expect(testsHover(source, { line: 9, column: 30 })).toBe(
			"found: Optional<Standing>",
		)
	})

	it("says nothing over the braces of a table test's row Pattern", () => {
		expect(testsHover(source, { line: 14, column: 5 })).toBeNull()
	})
})

// A Protocol's requirements and a Choice's payload members survive enrichment
// as plain Type Records, so Hover pairs them with the parsed declaration. See
// "What the typed tree lacks" in packages/language-server/DEVELOPMENT.md.
describe("Hover inside a Protocol or Choice declaration", () => {
	it("should describe each of a Protocol's requirements", () => {
		let source = [
			"implementation {",
			"\tprotocol Sizable {",
			"\t\tsize() -> Integer",
			"",
			"\t\tresize(_ to: Integer) -> Self",
			"\t}",
			"}",
		].join("\n")

		expect(hover(source, { line: 3, column: 4 })).toBe("size() -> Integer")
		expect(hover(source, { line: 3, column: 14 })).toBe("Integer")
		expect(hover(source, { line: 5, column: 4 })).toBe(
			"resize(_ Integer) -> Self",
		)
		expect(hover(source, { line: 5, column: 13 })).toBe("to: Integer")
		expect(hover(source, { line: 5, column: 17 })).toBe("Integer")
		expect(hover(source, { line: 5, column: 29 })).toBe("Self")
		// The declaration itself still reads back whole, on its head.
		expect(hover(source, { line: 2, column: 3 })).toBe(
			"protocol Sizable\nsize() -> Integer\nresize(_ Integer) -> Self",
		)
	})

	it("should describe what a provided Method's body reads", () => {
		let source = [
			"implementation {",
			"\tprotocol Ranked {",
			"\t\tisAbove(_ mark: Integer) -> Boolean",
			"",
			"\t\tisAtMost(_ mark: Integer) -> Boolean {",
			"\t\t\tconstant flipped = @::isAbove(mark)::negate()",
			"\t\t\t<- flipped",
			"\t\t}",
			"\t}",
			"}",
		].join("\n")

		expect(hover(source, { line: 6, column: 14 })).toBe("flipped: Boolean")
		expect(hover(source, { line: 6, column: 28 })).toBe(
			"isAbove(_ Integer) -> Boolean",
		)
		expect(hover(source, { line: 6, column: 35 })).toBe("mark: Integer")
		expect(hover(source, { line: 7, column: 8 })).toBe("flipped: Boolean")
		expect(hover(source, { line: 5, column: 15 })).toBe("mark: Integer")
	})

	it("should describe a Choice's Type Parameters and payload members", () => {
		let source = [
			"implementation {",
			"\tchoice Step<State, Result> {",
			"\t\tContinue { state: State },",
			"\t\tDone { value: Result },",
			"\t}",
			"}",
		].join("\n")

		expect(hover(source, { line: 2, column: 14 })).toBe("State")
		expect(hover(source, { line: 2, column: 21 })).toBe("Result")
		expect(hover(source, { line: 3, column: 15 })).toBe("state: State")
		expect(hover(source, { line: 3, column: 22 })).toBe("State")
		expect(hover(source, { line: 4, column: 11 })).toBe("value: Result")
		expect(hover(source, { line: 4, column: 18 })).toBe("Result")
	})

	// Each declaration pairs with the one written where it starts, so two
	// Choices of one name in two bodies keep their own payloads.
	it("should describe requirements and payload members declared in a body", () => {
		let source = [
			"implementation {",
			"\tfunction circles() -> Integer {",
			"\t\tprotocol Sized {",
			"\t\t\tsize() -> Integer",
			"\t\t}",
			"",
			"\t\tchoice Shape {",
			"\t\t\tCircle { radius: Integer },",
			"\t\t}",
			"",
			"\t\t<- 1",
			"\t}",
			"",
			"\tfunction labels() -> Integer {",
			"\t\tchoice Shape {",
			"\t\t\tCircle { radius: String },",
			"\t\t}",
			"",
			"\t\t<- 2",
			"\t}",
			"}",
		].join("\n")

		expect(hover(source, { line: 4, column: 4 })).toBe("size() -> Integer")
		expect(hover(source, { line: 8, column: 13 })).toBe("radius: Integer")
		expect(hover(source, { line: 16, column: 13 })).toBe("radius: String")
	})

	it("should describe a Type Alias's Type Parameter", () => {
		let source = [
			"implementation {",
			"\ttype Fallible<Result> = Result | String",
			"}",
		].join("\n")

		expect(hover(source, { line: 2, column: 17 })).toBe("Result")
		expect(hover(source, { line: 2, column: 27 })).toBe("Result")
		expect(hover(source, { line: 2, column: 36 })).toBe("String")
	})

	// A checked refinement reads back as its base on its own Declaration,
	// where its name would only repeat itself. A value of it reads back as the
	// name, the Type the value has.
	it("should describe a checked refinement", () => {
		let source = [
			"implementation {",
			"\ttype NonZero = Integer where @::isNot(0)",
			"",
			"\tfunction doubled(_ n: NonZero) -> Integer {",
			"\t\t<- n::multiply(with 2)",
			"\t}",
			"}",
		].join("\n")

		expect(hover(source, { line: 2, column: 10 })).toBe("NonZero: Integer")
		expect(hover(source, { line: 2, column: 19 })).toBe("Integer")
		expect(hover(source, { line: 4, column: 27 })).toBe("NonZero")
		expect(hover(source, { line: 5, column: 7 })).toBe("n: NonZero")
	})

	// A generic refined Alias wraps the refinement in a Generic Alias, so its
	// Declaration looks one level further in for the base. A value of one reads
	// back applied.
	it("should describe a generic checked refinement", () => {
		let source = [
			"implementation {",
			"\ttype Filled<Item> = List<Item> where @::hasItems()",
			"",
			"\tfunction countOf(_ items: Filled<String>) -> Integer {",
			"\t\t<- items::length()",
			"\t}",
			"}",
		].join("\n")

		expect(hover(source, { line: 2, column: 10 })).toBe(
			"Filled: List<Item>",
		)
		expect(hover(source, { line: 4, column: 31 })).toBe("Filled<String>")
		expect(hover(source, { line: 5, column: 8 })).toBe(
			"items: Filled<String>",
		)
	})

	// The predicate is typed with `@` as the base, so its calls answer as a
	// body's do rather than as the whole Declaration.
	it("should describe a refinement predicate's receiver and Method", () => {
		let source = [
			"implementation {",
			"\tnamespace Checks for Integer {",
			"\t\tisSmall() -> Boolean {",
			"\t\t\t<- @::isLessThan(10)",
			"\t\t}",
			"\t}",
			"",
			"\ttype Small = Integer where @::isSmall()",
			"}",
		].join("\n")

		expect(hover(source, { line: 8, column: 29 })).toBe("@: Integer")
		expect(hover(source, { line: 8, column: 34 })).toBe(
			"isSmall() -> Boolean",
		)
	})

	// The standard library's own refinement, which nothing in the source names.
	// A List that answered `hasItems` reads back as the applied `NonEmptyList`,
	// and its Method reads back as declared, answering an item.
	it("should describe a List a branch proved has something in it", () => {
		let source = [
			"implementation {",
			'\tconstant words = ["essence"]',
			"",
			"\tif words::hasItems() {",
			"\t\tTerminal.inspect(words::firstItem())",
			"\t}",
			"}",
		].join("\n")

		expect(hover(source, { line: 5, column: 21 })).toBe(
			"words: NonEmptyList<String>",
		)
		expect(hover(source, { line: 5, column: 28 })).toBe(
			"firstItem<ItemType>() -> ItemType",
		)
	})

	// A predicate that takes Arguments is read off its body like any other.
	// `isBelow` is `isAtLeast` negated because the two bodies say so, so the
	// `else` branch of one proves the refinement written on the other.
	it("should describe a value a Program's own parameterised predicate proved", () => {
		let source = [
			"implementation {",
			"\tnamespace Stock for Integer {",
			"\t\tisAtLeast(_ count: Integer) -> Boolean {",
			"\t\t\t<- @::isGreaterThanOrEqualTo(count)",
			"\t\t}",
			"",
			"\t\tisBelow(_ count: Integer) -> Boolean {",
			"\t\t\t<- @::isGreaterThanOrEqualTo(count)::negate()",
			"\t\t}",
			"\t}",
			"",
			"\ttype Healthy = Integer where @::isAtLeast(5)",
			"",
			"\tconstant units = 12",
			"",
			"\tif units::isBelow(5) {",
			"\t\tTerminal.inspect(0)",
			"\t} else {",
			"\t\tTerminal.inspect(units)",
			"\t}",
			"}",
		].join("\n")

		expect(hover(source, { line: 12, column: 7 })).toBe("Healthy: Integer")
		expect(hover(source, { line: 16, column: 6 })).toBe("units: Integer")
		expect(hover(source, { line: 19, column: 21 })).toBe("units: Healthy")
	})

	// A Protocol's provided body is read where it is written, with the
	// conformer filling in what it asks. `Rank` answers `isAbove` with a
	// comparison, and the `else` of `isAtMost` proves the refinement on it.
	it("should describe a value a Protocol's provided predicate proved", () => {
		let source = [
			"implementation {",
			"\tprotocol Ranked {",
			"\t\tisAbove(_ mark: Integer) -> Boolean",
			"",
			"\t\tisAtMost(_ mark: Integer) -> Boolean {",
			"\t\t\t<- @::isAbove(mark)::negate()",
			"\t\t}",
			"\t}",
			"",
			"\tnamespace Rank for Integer is Ranked {",
			"\t\tisAbove(_ mark: Integer) -> Boolean {",
			"\t\t\t<- @::isGreaterThan(mark)",
			"\t\t}",
			"\t}",
			"",
			"\ttype Above = Integer where @::isGreaterThan(3)",
			"",
			"\tconstant score = 12",
			"",
			"\tif score::isAtMost(3) {",
			"\t\tTerminal.inspect(0)",
			"\t} else {",
			"\t\tTerminal.inspect(score)",
			"\t}",
			"}",
		].join("\n")

		expect(hover(source, { line: 16, column: 7 })).toBe("Above: Integer")
		expect(hover(source, { line: 23, column: 21 })).toBe("score: Above")
	})
})

describe("Hover of conformance clauses", () => {
	it("should describe a Namespace with its conformance clauses", () => {
		let source = [
			"implementation {",
			"\tnamespace Box<infer Item> for { value: Item }",
			"\t\tis Comparable where Item is Comparable",
			"\t{",
			"\t\tcompare(to other: { value: Item }) -> Ordering {",
			"\t\t\t<- @.value::compare(to other.value)",
			"\t\t}",
			"\t}",
			"}",
		].join("\n")

		expect(hover(source, { line: 2, column: 13 })).toBe(
			"namespace Box<infer Item> for { value: Item } is Comparable where Item is Comparable",
		)
	})

	// A clause in a body may name a Protocol that body declares, which can
	// shadow one of the same name outside it.
	it("should describe a clause naming a Protocol declared in a body", () => {
		let source = [
			"implementation {",
			"\tprotocol Sized {",
			"\t\tsize() -> Integer",
			"\t}",
			"",
			"\tfunction measure() -> Integer {",
			"\t\tprotocol Sized {",
			"\t\t\tbulk() -> Integer",
			"\t\t}",
			"",
			"\t\tnamespace Crates<infer Item> for List<Item>",
			"\t\t\tis Sized where Item is Sized",
			"\t\t{",
			"\t\t\tbulk() -> Integer {",
			"\t\t\t\t<- @::length()",
			"\t\t\t}",
			"\t\t}",
			"",
			"\t\t<- 1",
			"\t}",
			"}",
		].join("\n")
		let bodyProtocol = ["protocol Sized", "bulk() -> Integer"].join("\n")

		expect(hover(source, { line: 12, column: 7 })).toBe(bodyProtocol)
		expect(hover(source, { line: 12, column: 27 })).toBe(bodyProtocol)
	})

	it("should describe a clause naming a Protocol only a body declares", () => {
		let source = [
			"implementation {",
			"\tfunction measure() -> Integer {",
			"\t\tprotocol Weighed {",
			"\t\t\tweight() -> Integer",
			"\t\t}",
			"",
			"\t\tnamespace Pounds for Integer is Weighed {",
			"\t\t\tweight() -> Integer {",
			"\t\t\t\t<- @",
			"\t\t\t}",
			"\t\t}",
			"",
			"\t\t<- 3::weight()",
			"\t}",
			"}",
		].join("\n")

		expect(hover(source, { line: 7, column: 35 })).toBe(
			["protocol Weighed", "weight() -> Integer"].join("\n"),
		)
	})

	// The receiver is bound to a `List` Type, since a written List reaches
	// `namespace NonEmptyList`, whose `sort` has a signature of its own.
	it("should show a Method's Protocol bound", () => {
		let source = [
			"implementation {",
			"\tconstant numbers: List<Integer> = [3, 1]",
			"\tnumbers::sort()",
			"}",
		].join("\n")

		expect(hover(source, { line: 3, column: 12 })).toBe(
			"sort<ItemType is Comparable>(in?: SortOrder) -> List<ItemType>",
		)
	})
})

// Boolean stands in for the standard library. What an Editor shows for a
// builtin comes from the `§§` block in `Boolean.es`, which must reach Hover
// intact.
describe("Hover of a standard library Method", () => {
	let source = [
		"implementation {",
		"\tTerminal.inspect(true::negate())",
		"\tTerminal.inspect(true::is(false))",
		"}",
	].join("\n")

	it("should describe a Method declared in Essence", () => {
		expect(hover(source, { line: 2, column: 26 })).toBe(
			"negate() -> Boolean",
		)
		expect(hoverDocumentation(source, { line: 2, column: 26 })).toBe(
			"Answers the opposite truth value: `false` for `true`, and `true` for `false`.",
		)
	})

	// A `@param` reaches Hover as a section of its own, under the Parameter's
	// internal name, though the source writes `@param _`. The description
	// carries no copy of it.
	it("should show a Parameter's text and the return text", () => {
		expect(hoverDocumentation(source, { line: 3, column: 26 })).toBe(
			[
				"Answers whether the Boolean has the same truth value as another.",
				"**other** — the Boolean to compare against",
				"**Returns** — `true` when both are equal.",
			].join("\n\n"),
		)
	})

	describe("Generic Choices", () => {
		let step = [
			"implementation {",
			"\tchoice Step<State, Result> {",
			"\t\tContinue { state: State },",
			"\t\tDone { value: Result },",
			"\t}",
			"}",
		].join("\n")

		it("should spell a generic Choice's declaration head with its Type Parameters", () => {
			expect(hover(step, { line: 2, column: 9 })).toBe(
				[
					"choice Step<State, Result>",
					"#Continue { state: State }",
					"#Done { value: Result }",
				].join("\n"),
			)
		})

		let box = [
			"implementation {",
			"\tchoice Box<Value> {",
			"\t\tHolding { value: Value },",
			"\t\tEmpty,",
			"\t}",
			"\tconstant b: Box<Integer> = #Holding({ value = 5 })",
			"}",
		].join("\n")

		it("should show a constructed Case value's instantiated payload", () => {
			expect(hover(box, { line: 6, column: 31 })).toBe(
				"Box<Integer>#Holding { value: Integer }",
			)
		})

		it("should show a Case Matcher's instantiated payload", () => {
			let source = [
				"implementation {",
				"\tchoice Box<Value> {",
				"\t\tHolding { value: Value },",
				"\t\tEmpty,",
				"\t}",
				"\tconstant b: Box<Integer> = #Empty",
				"\tTerminal.inspect(match b -> Integer {",
				"\t\tcase #Holding { <- 0 }",
				"\t\tcase #Empty { <- 1 }",
				"\t})",
				"}",
			].join("\n")

			expect(hover(source, { line: 8, column: 9 })).toBe(
				"Box<Integer>#Holding { value: Integer }",
			)
		})
	})
})

// A Pattern's bindings read off a Constant the Compiler named at the Pattern's
// span. That name answers nothing, and the bindings answer for their spans.
describe("Hover of a Pattern", () => {
	const source = [
		"implementation {",
		"\tconstant { width, height } = { width = 1, height = 2 }",
		"",
		"\tfunction area(of { w, h }: { w: Integer, h: Integer }) -> Integer {",
		"\t\t<- w::multiply(with h)",
		"\t}",
		"",
		"\tTerminal.print(area(of { w = width, h = height }))",
		"}",
	].join("\n")

	it("says nothing over the braces of a Declaration Pattern", () => {
		expect(hover(source, { line: 2, column: 11 })).toBeNull()
	})

	it("answers for a binder with the binder", () => {
		expect(hover(source, { line: 2, column: 13 })).toBe("width: Integer")
	})

	// A Parameter taken apart by a Pattern has a Compiler-made internal name
	// over the Pattern's span. The label is what a reader wrote there.
	it("answers for a Parameter Pattern with its label", () => {
		expect(hover(source, { line: 4, column: 18 })).toBe(
			"of: { w: Integer, h: Integer }",
		)
	})
})

// A default is an Expression written where it stands. The cursor inside one
// answers with what it reads, not with the Parameter.
describe("Default Parameter Values", () => {
	it("should describe a call written inside a default", () => {
		let source = [
			"implementation {",
			"\tnamespace Windows for List<Integer> {",
			"\t\tupTo(_ end: Integer = @::length()) -> Integer {",
			"\t\t\t<- end",
			"\t\t}",
			"\t}",
			"}",
		].join("\n")

		expect(hover(source, { line: 3, column: 30 })).toBe(
			"length<ItemType>() -> NonNegativeInteger",
		)
	})

	it("should still describe the Parameter itself", () => {
		let source = [
			"implementation {",
			"\tfunction scaled(_ factor: Integer = 2) -> Integer {",
			"\t\t<- factor",
			"\t}",
			"}",
		].join("\n")

		expect(hover(source, { line: 2, column: 21 })).toBe("factor: Integer")
	})
})

// The Compiler writes a derived Method's Namespace and its `§§` text, and
// Hover is where that text arrives.
describe("Hover of a Choice's derived 'toString'", () => {
	let source = [
		"implementation {",
		"\tchoice Colour {",
		"\t\tRed,",
		"\t\tGreen,",
		"\t}",
		"",
		"\tnamespace Colour for Colour is Printable { }",
		"",
		"\tconstant red: Colour = #Red",
		"\tTerminal.inspect(red::toString())",
		"}",
	].join("\n")

	it("should describe it with the signature the derive carries", () => {
		expect(hover(source, { line: 10, column: 26 })).toBe(
			"toString() -> String",
		)
	})

	it("should describe it with the documentation the derive carries", () => {
		expect(hoverDocumentation(source, { line: 10, column: 26 })).toBe(
			[
				"Answers the Case's name as a String.",
				"**Returns** — the name of the Case, without its `#`.",
			].join("\n\n"),
		)
	})
})

describe("Hover of a Protocol-provided Method", () => {
	let source = [
		"implementation {",
		"\tprotocol Shape {",
		"\t\tarea() -> Rational",
		"",
		"\t\t§§ Answers a sentence about the Shape.",
		"\t\t§§",
		"\t\t§§ @returns — the sentence.",
		"\t\tdescribe() -> String {",
		'\t\t\t<- "area {@::area()}"',
		"\t\t}",
		"\t}",
		"",
		"\ttype Square = { side: Rational }",
		"",
		"\tnamespace Squares for Square is Shape {",
		"\t\tarea() -> Rational {",
		"\t\t\t<- @.side",
		"\t\t}",
		"\t}",
		"",
		"\tconstant square: Square = { side = 3/1 }",
		"\tTerminal.inspect(square::describe())",
		"}",
	].join("\n")

	it("should describe it with the signature the Protocol declares", () => {
		expect(hover(source, { line: 22, column: 28 })).toBe(
			"describe() -> String",
		)
	})

	it("should describe it with the Protocol's own documentation", () => {
		expect(hoverDocumentation(source, { line: 22, column: 28 })).toBe(
			[
				"Answers a sentence about the Shape.",
				"**Returns** — the sentence.",
				"Provided by `Shape`.",
			].join("\n\n"),
		)
	})

	it("should say which Protocol provided it on a bounded receiver", () => {
		let bounded = [
			"implementation {",
			"\tprotocol Shape {",
			"\t\tarea() -> Rational",
			"",
			"\t\tdescribe() -> String {",
			'\t\t\t<- "area {@::area()}"',
			"\t\t}",
			"\t}",
			"",
			"\tfunction say<infer Item is Shape>(_ item: Item) -> String {",
			"\t\t<- item::describe()",
			"\t}",
			"}",
		].join("\n")

		expect(hoverDocumentation(bounded, { line: 11, column: 16 })).toBe(
			"Provided by `Shape`.",
		)
	})

	// The Namespace spelling reads the same Method off the conforming
	// Namespace, which declares nothing of the sort, so the Protocol is named.
	it("should say which Protocol provided it on the Namespace spelling", () => {
		let spelled = [
			"implementation {",
			"\tprotocol Shape {",
			"\t\tarea() -> Rational",
			"",
			"\t\tdescribe() -> String {",
			'\t\t\t<- "area {@::area()}"',
			"\t\t}",
			"\t}",
			"",
			"\ttype Square = { side: Rational }",
			"",
			"\tnamespace Squares for Square is Shape {",
			"\t\tarea() -> Rational {",
			"\t\t\t<- @.side",
			"\t\t}",
			"\t}",
			"",
			"\tconstant square: Square = { side = 3/1 }",
			"\tTerminal.inspect(Squares.describe(square))",
			"}",
		].join("\n")

		expect(hoverDocumentation(spelled, { line: 19, column: 28 })).toBe(
			"Provided by `Shape`.",
		)
	})
})

// The signature marks a Parameter `?` only where the whole Argument may be
// left out. The prose under the Parameter says what a partial default fills.
describe("A Record Parameter with a default", () => {
	let source = [
		"implementation {",
		"\ttype Options = { host: String, retries: Integer }",
		"",
		"\tfunction connect(using options: Options = { retries = 3 }) -> String {",
		"\t\t<- options.host",
		"\t}",
		"",
		'\tTerminal.inspect(connect(using { host = "h" }))',
		"}",
	].join("\n")

	it("should say which members a call may leave out", () => {
		expect(hoverDocumentation(source, { line: 4, column: 19 })).toBe(
			"A call may leave `retries` out of this Record.",
		)
	})

	it("should print the Parameter's Type as it always did", () => {
		expect(hover(source, { line: 4, column: 19 })).toBe("using: Options")
	})

	// Which members a path key may reach into. The default writes those out
	// member by member, so an Argument may merge into them.
	it("should say which members a path key may reach into", () => {
		let nested = [
			"implementation {",
			"\ttype Server = { host: String, port: Integer }",
			"\ttype Options = { retries: Integer, server: Server }",
			"",
			'\tfunction connect(using options: Options = { retries = 3, server = { host = "d", port = 80 } }) -> String {',
			"\t\t<- options.server.host",
			"\t}",
			"",
			"\tTerminal.inspect(connect(using { server.port = 1 }))",
			"}",
		].join("\n")

		expect(hoverDocumentation(nested, { line: 5, column: 20 })).toBe(
			"A call may leave `retries`, `server` out of this Record. It may reach into `server` with a path key.",
		)
	})

	// The sentence is the same on the Parameter's span, its label, and the
	// name the body reads it under.
	it("should say it under the internal name too", () => {
		expect(hoverDocumentation(source, { line: 4, column: 26 })).toBe(
			"A call may leave `retries` out of this Record.",
		)
	})

	it("should say nothing about a Parameter with a scalar default", () => {
		let scalar = [
			"implementation {",
			"\tfunction scaled(_ value: Integer = 1) -> Integer {",
			"\t\t<- value",
			"\t}",
			"",
			"\tTerminal.inspect(scaled())",
			"}",
		].join("\n")

		expect(hoverDocumentation(scalar, { line: 2, column: 18 })).toBeNull()
	})
})

// A Case payload's `= { … }` is written outside every body, and the cursor
// inside one answers with what is under it.
describe("Hover inside a Case payload default", () => {
	it("should describe the value under the cursor rather than the Choice", () => {
		let source = [
			"implementation {",
			"\tchoice Fetch {",
			"\t\tGet { url: String, retries: Integer } = { retries = 0 },",
			"\t}",
			"}",
		].join("\n")

		expect(hover(source, { line: 3, column: 55 })).toBe("Integer")
	})

	// A default that names a Constant is baked into the Case Type as its
	// value. Hover still answers with the name, as on a Parameter's default.
	it("should answer a name in the default with the Constant it names", () => {
		let source = [
			"implementation {",
			'\tconstant standardHeaders: List<String> = ["Accept"]',
			"",
			"\tchoice Fetch {",
			"\t\tGet { url: String, headers: List<String> } = {",
			"\t\t\theaders = standardHeaders,",
			"\t\t},",
			"\t}",
			"}",
		].join("\n")

		expect(hover(source, { line: 6, column: 16 })).toBe(
			"standardHeaders: List<String>",
		)
	})

	// A member path is a Function literal the Compiler wrote. The path and
	// each step answer, and the Parameter the Compiler named never does.
	describe("member paths", () => {
		let source = [
			"implementation {",
			"\ttype Maker = { town: String }",
			"\ttype Product = { name: String, maker: Maker }",
			"\tconstant products: List<Product> = []",
			"\tconstant towns = products::map(.maker.town)",
			"}",
		].join("\n")

		it("describes the path as the Function it stands for", () => {
			expect(hover(source, { line: 5, column: 33 })).toBe(
				"(_ Product) -> String",
			)
		})

		it("describes each step as the member it reads", () => {
			expect(hover(source, { line: 5, column: 36 })).toBe("maker: Maker")
			expect(hover(source, { line: 5, column: 41 })).toBe("town: String")
		})

		it("never answers with the name the Compiler gave the Parameter", () => {
			for (let column = 33; column <= 44; column++) {
				expect(hover(source, { line: 5, column })).not.toContain("_0")
			}
		})
	})
})

// A written value proves what it can about itself where a Method is looked up
// on it. The receiver's Hover names the proof, and the Method's names the entry.
describe("Hover over a written receiver", () => {
	it("names the refinement the value proved", () => {
		let source = [
			"implementation {",
			"\tconstant root = 4::squareRoot()",
			"}",
		].join("\n")

		expect(hover(source, { line: 2, column: 18 })).toBe("PositiveInteger")
		expect(hover(source, { line: 2, column: 22 })).toBe(
			"squareRoot() -> PositiveInteger | Algebraic",
		)
	})

	it("names a generic refinement as the items decided it", () => {
		let source = [
			"implementation {",
			"\tconstant first = [1, 2]::firstItem()",
			"}",
		].join("\n")

		expect(hover(source, { line: 2, column: 19 })).toBe(
			"NonEmptyList<Integer>",
		)
	})

	// A written String proves `NonEmptyString`, whose Namespace declares no
	// `trim`, so the call still reaches `String`'s own Method.
	it("names a proof the refined Namespace does not spend", () => {
		let source = [
			"implementation {",
			'\tconstant text = "abc"::trim()',
			"}",
		].join("\n")

		expect(hover(source, { line: 2, column: 20 })).toBe("NonEmptyString")
		expect(hover(source, { line: 2, column: 26 })).toBe(
			"trim(at?: Side) -> String",
		)
	})

	// The entry the proof does reach, under the Namespace that spends it.
	it("names the entry a String's proof reaches", () => {
		let source = [
			"implementation {",
			'\tconstant count = "abc"::length()',
			"}",
		].join("\n")

		expect(hover(source, { line: 2, column: 21 })).toBe("NonEmptyString")
		expect(hover(source, { line: 2, column: 29 })).toBe(
			"length() -> PositiveInteger",
		)
	})

	// Where no declared Alias proves the whole conjunction, the Hover
	// spells the Declaration a reader would have to write for it.
	it("spells a conjunction no declared name covers", () => {
		let source = [
			"implementation {",
			"\ttype Even = Integer where @::isEven()",
			"\ttype Big = Integer where @::isGreaterThan(10)",
			"",
			"\tconstant sum = 12::add(1)",
			"}",
		].join("\n")

		expect(hover(source, { line: 5, column: 17 })).toBe(
			"Integer where @::isNot(0)::and(@::isEven())::and(@::isPositive())::and(@::isGreaterThan(10))::and(@::isGreaterThanOrEqualTo(0))",
		)
	})

	// Each conjunct is spelled as the reader wrote it, not as it resolved.
	// `@::isAtLeast(5)` stays itself rather than `@::isLessThan(5)` negated.
	it("spells each conjunct as its predicate was written", () => {
		let source = [
			"implementation {",
			"	namespace Stock for Integer {",
			"		isAtLeast(_ count: Integer) -> Boolean {",
			"			<- @::isGreaterThanOrEqualTo(count)",
			"		}",
			"	}",
			"",
			"	type Healthy = Integer where @::isAtLeast(5)",
			"",
			"	constant next = 12::add(1)",
			"}",
		].join("\n")

		expect(hover(source, { line: 10, column: 18 })).toBe(
			"Integer where @::isNot(0)::and(@::isPositive())::and(@::isGreaterThanOrEqualTo(0))::and(@::isAtLeast(5))",
		)
	})

	// A proof standing as a Type Argument is spelled where it stands, and the
	// Method reads back as declared. Only the receiver says what `ItemType` was
	// bound to.
	it("spells a proof standing as a Type Argument", () => {
		let source = [
			"implementation {",
			"\tconstant groups: List<NonEmptyList<Integer>> = [[1], [2, 3]]",
			"\tconstant first = groups::firstItem()",
			"}",
		].join("\n")

		expect(hover(source, { line: 3, column: 20 })).toBe(
			"groups: List<NonEmptyList<Integer>>",
		)
		expect(hover(source, { line: 3, column: 28 })).toBe(
			"firstItem<ItemType>() -> Optional<ItemType>",
		)
	})

	// A computed value proves nothing, so its name hovers as the Type it was
	// computed to. A difference, since a sum of two written Integers is proven.
	it("leaves a computed receiver as the Type it was computed to", () => {
		let source = [
			"implementation {",
			"\tconstant two = 3::subtract(1)",
			"\tconstant root = two::squareRoot()",
			"}",
		].join("\n")

		expect(hover(source, { line: 3, column: 19 })).toBe("two: Integer")
	})
})

// A `define` in a nested position rather than at a `<-`, so the enclosing
// Statement answers with a Type of its own.
describe("Hover inside a define", () => {
	let source = [
		"implementation {",
		"\tfunction grade (_ score: Integer) -> String {",
		"\t\tconstant band = define {",
		"\t\t\tas 1 if score::isGreaterThan(90)",
		"\t\t\tas 0 otherwise",
		"\t\t}",
		"",
		"\t\t<- band::toString()",
		"\t}",
		"}",
	].join("\n")

	// The Keyword answers with the Type the arms produce, as a `match` does.
	it("should answer the Keyword with the Type the arms produce", () => {
		expect(hover(source, { line: 3, column: 19 })).toBe("Integer")
	})

	it("should answer a name written in an arm's condition", () => {
		expect(hover(source, { line: 4, column: 12 })).toBe("score: Integer")
	})

	it("should answer a Method called in an arm's condition", () => {
		expect(hover(source, { line: 4, column: 19 })).toBe(
			"isGreaterThan(_ Integer) -> Boolean",
		)
	})

	it("should answer a value written in the otherwise arm", () => {
		expect(hover(source, { line: 5, column: 7 })).toBe("Integer")
	})
})

// Both Keywords answer with what they produce, as a Return's `<-` does:
// `complete` with the value it waited for and `start` with its `Started`. The
// operand, the smaller span, keeps its own Hover.
describe("Hover over start and complete", () => {
	let source = [
		"implementation {",
		"\tfunction doubled(_ value: Integer) -> Future<Integer> {",
		"\t\tconstant held = complete Async.deferred(() { <- value })",
		"",
		"\t\t<- held::add(held)",
		"\t}",
		"",
		"\tconstant answer = complete doubled(21)",
		"\tconstant running = start doubled(21)",
		"}",
	].join("\n")

	it("should answer a complete with the value it waited for", () => {
		expect(hover(source, { line: 8, column: 20 })).toBe("Integer")
	})

	it("should answer a start with the Started it put in flight", () => {
		expect(hover(source, { line: 9, column: 21 })).toBe("Started<Integer>")
	})

	it("should leave the operand its own answer", () => {
		expect(hover(source, { line: 8, column: 29 })).toBe(
			"doubled(_ Integer) -> Future<Integer>",
		)
	})

	// A name written inside the operand answers only if the walk descends
	// into the Keyword.
	it("should reach a name written under the Keyword", () => {
		expect(hover(source, { line: 3, column: 51 })).toBe("value: Integer")
		expect(hover(source, { line: 3, column: 34 })).toBe(
			"deferred<Value>(_ () -> Value) -> Future<Value>",
		)
	})

	it("should answer the declared Future as the Type it is", () => {
		expect(hover(source, { line: 2, column: 40 })).toBe("Future<Integer>")
	})
})

describe("Hover inside a refused value", () => {
	let source = [
		"implementation {",
		"\tconstant primes = [2, 3, 5]",
		"\tconstant first = primes::reverse()[0]",
		"}",
	].join("\n")

	it("should describe what was written in front of the brackets", () => {
		expect(hover(source, { line: 3, column: 19 })).toBe(
			"primes: List<Integer>",
		)
		expect(hover(source, { line: 3, column: 28 })).toBe(
			"reverse<ItemType>() -> List<ItemType>",
		)
	})

	it("should say nothing about the brackets themselves", () => {
		expect(hover(source, { line: 3, column: 37 })).toBeNull()
	})
})
