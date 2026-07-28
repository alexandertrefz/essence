import { describe, expect, it } from "bun:test"

import { enrich } from "@essence-lang/compiler/enricher"
import { parseWithDiagnostics } from "@essence-lang/compiler/parser"
import type { common } from "@essence-lang/interfaces"

import { findHover } from "../hover"

// NOTE: Both Programs and the annotation index, which is what the Language
// Server hands `findHover` for every document — see `connection.onHover`.
function hoverInfo(source: string, cursor: common.Cursor) {
	let { program } = parseWithDiagnostics(source)
	let { program: enrichedProgram, annotations } = enrich(program, {
		annotations: true,
	})

	return findHover(enrichedProgram, cursor, program, annotations)
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

	// NOTE: A callee's Generics are alpha-renamed for the span of one
	// invocation, so a caller's same-named Generic can not collide with them —
	// `T` is matched as `T`, a zero-width space and a counter. One that never
	// binds stays under that fresh name in the Types stamped onto the
	// Argument, and Hover reads its Types back from exactly there: rendered
	// verbatim the reader is shown `T117`, since only the separator is
	// invisible. `T` here occurs ONLY inside the callback, so no Argument can
	// name it and it stays unbound for the whole invocation.
	it("should describe a Generic under the name the source wrote", () => {
		let source = [
			"implementation {",
			"\tfunction apply <infer T>(_ f: (_: T) -> T, times n: Integer) -> Nothing {",
			"\t\t<- nothing",
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

// NOTE: The typed AST erases annotations — a resolved Type carries no Position
// — so before the annotation index every one of these answered with the
// enclosing declaration, whatever it was aimed at.
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
		// NOTE: The Parameter's own name still wins over the annotation beside
		// it — the index adds candidates, it does not outrank the typed tree.
		expect(hover(source, { line: 2, column: 20 })).toBe("subject: String")
	})

	it("should describe a Constant's annotation, and the Type inside it", () => {
		let source = [
			"implementation {",
			"\tconstant xs: List<Integer> = [1]",
			"\t__print(xs)",
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
			"\t\tcompareTo(_ other: { value: Item }) -> Ordering {",
			"\t\t\t<- @.value::compareTo(other.value)",
			"\t\t}",
			"\t}",
			"}",
		].join("\n")

		expect(hover(source, { line: 2, column: 33 })).toBe("{ value: Item }")
		expect(hover(source, { line: 5, column: 23 })).toBe("{ value: Item }")
		expect(hover(source, { line: 5, column: 32 })).toBe("Item")
		expect(hover(source, { line: 5, column: 42 })).toBe("Ordering")
	})

	// NOTE: These four are the reason the collector is opened ONCE around the
	// whole enrichment rather than per speculative hoisting round. `enrichStatement`
	// reuses the hoisted Type for every one of these declarations, so their
	// annotations are resolved ONLY inside a speculation and a per-round
	// collector would throw all of them away.
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

		// NOTE: A Union annotation, and each of its members on its own.
		expect(hover(source, { line: 2, column: 16 })).toBe("Integer")
		expect(hover(source, { line: 2, column: 26 })).toBe("String")
		expect(hover(source, { line: 2, column: 23 })).toBe("Integer | String")
		// NOTE: A Protocol requirement's return Type — the Protocol's body is
		// otherwise entirely opaque to Hover.
		expect(hover(source, { line: 4, column: 14 })).toBe("Integer")
		// NOTE: A generic Choice's payload member.
		expect(hover(source, { line: 7, column: 21 })).toBe("Item")
	})
})

// NOTE: All of these had a Position in the typed AST already — Hover simply
// never offered them as candidates, so the enclosing declaration answered.
describe("Hover of declaration parts", () => {
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

	it("should describe a Parameter the cursor sits on but not inside", () => {
		let source = [
			"implementation {",
			"\tfunction firstOr <infer Item is Printable>(_ items: List<Item>) -> String {",
			'\t\t<- "x"',
			"\t}",
			"}",
		].join("\n")

		// NOTE: The bare `_` binds no name, so there is no Identifier under the
		// cursor — the Parameter itself is what answers.
		expect(hover(source, { line: 2, column: 45 })).toBe("List<Item>")
	})

	it("should describe a conformance clause as the Protocol it names", () => {
		let source = [
			"implementation {",
			"\tnamespace Box<infer Item> for { value: Item }",
			"\t\tis Comparable where Item is Comparable",
			"\t{",
			"\t\tcompareTo(_ other: { value: Item }) -> Ordering {",
			"\t\t\t<- @.value::compareTo(other.value)",
			"\t\t}",
			"\t}",
			"}",
		].join("\n")

		expect(hover(source, { line: 3, column: 10 })).toBe(
			"protocol Comparable\ncompareTo(_ Self) -> Ordering",
		)
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
			"\t\tcompareTo(_ other: { value: Item }) -> Ordering {",
			"\t\t\t<- @.value::compareTo(other.value)",
			"\t\t}",
			"\t}",
			"}",
		].join("\n")

		expect(hover(source, { line: 3, column: 24 })).toBe("infer Item")
		expect(hover(source, { line: 3, column: 33 })).toBe(
			"protocol Comparable\ncompareTo(_ Self) -> Ordering",
		)
	})
})

// NOTE: A declaration is anchored to its HEAD, not to its whole Position. Every
// one of these used to answer with the enclosing declaration, so moving the
// mouse across the indentation of a long Namespace popped its whole head up.
describe("Hover inside a declaration's body", () => {
	it("should answer nothing on blank lines and body indentation", () => {
		let source = [
			"implementation {",
			"\tfunction f (n: Integer) -> Integer {",
			"",
			"\t\tif n::isGreaterThan(1) {",
			"\t\t\t__print(nothing)",
			"\t\t}",
			"",
			"\t\t<- n",
			"\t}",
			"}",
		].join("\n")

		// NOTE: A blank line inside the body, at any column.
		expect(hover(source, { line: 3, column: 1 })).toBeNull()
		expect(hover(source, { line: 7, column: 4 })).toBeNull()
		// NOTE: The indentation before a Statement, and a nested block's own
		// closing brace — neither of which the Function should answer for.
		expect(hover(source, { line: 4, column: 2 })).toBeNull()
		expect(hover(source, { line: 6, column: 3 })).toBeNull()
		// NOTE: The head itself still answers, which is the point of keeping one.
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
})

// NOTE: A Handler is not only its body — the value a literal Matcher compares
// against, a Record Matcher's by-value members and the Guard are Expressions
// like any other, and every one of them used to answer with the whole Match.
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
		// NOTE: `@` is narrowed to what the Matcher established, which is what
		// makes the Guard's Method resolve at all.
		expect(hover(source, { line: 7, column: 23 })).toBe("@: Integer")
		expect(hover(source, { line: 7, column: 30 })).toBe(
			"isNegative() -> Boolean",
		)
	})
})

// NOTE: A Protocol's requirements and a Choice's payload members survive
// enrichment as plain Type Records with no Position in them, so every name
// inside either declaration used to answer with the declaration itself. Inside
// a Protocol that was EVERY column.
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
		// NOTE: The declaration itself still reads back whole, on its head.
		expect(hover(source, { line: 2, column: 3 })).toBe(
			"protocol Sizable\nsize() -> Integer\nresize(_ Integer) -> Self",
		)
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
})

describe("Hover of conformance clauses", () => {
	it("should describe a Namespace with its conformance clauses", () => {
		let source = [
			"implementation {",
			"\tnamespace Box<infer Item> for { value: Item }",
			"\t\tis Comparable where Item is Comparable",
			"\t{",
			"\t\tcompareTo(_ other: { value: Item }) -> Ordering {",
			"\t\t\t<- @.value::compareTo(other.value)",
			"\t\t}",
			"\t}",
			"}",
		].join("\n")

		expect(hover(source, { line: 2, column: 13 })).toBe(
			"namespace Box<infer Item> for { value: Item } is Comparable where Item is Comparable",
		)
	})

	it("should show a Method's Protocol bound", () => {
		let source = ["implementation {", "\t[3, 1]::sort()", "}"].join("\n")

		expect(hover(source, { line: 2, column: 11 })).toBe(
			"sort<ItemType is Comparable>() -> List<ItemType>",
		)
	})
})

// NOTE: Boolean stands in for the standard library as a whole here
// (`packages/stdlib/sources/Boolean.es`). What an Editor shows for a builtin comes from the
// `§§` block in that source and nowhere else — the documentation an Essence
// declaration carries has to reach Hover intact.
describe("Hover of a standard library Method", () => {
	let source = [
		"implementation {",
		"\t__print(true::negate())",
		"\t__print(true::is(false))",
		"}",
	].join("\n")

	it("should describe a Method declared in Essence", () => {
		expect(hover(source, { line: 2, column: 17 })).toBe(
			"negate() -> Boolean",
		)
		expect(hoverDocumentation(source, { line: 2, column: 17 })).toBe(
			"The opposite truth value — `false` for `true`, `true` for `false`.",
		)
	})

	// NOTE: A `@param` reaches Hover as a section of its own.
	//
	// NOTE: A DELIBERATE decision, and the convention for every standard
	// library Method. The name in that section is the Parameter's INTERNAL one —
	// `other`, which no call site can write, since `_ other: Boolean` takes
	// its Argument positionally and Signature Help labels it `_`. Naming it
	// anyway beats an anonymous section: it is the name the standard library
	// author wrote, the prose reads as being about `other`, and the
	// alternative — dropping the section — would put the text back where only
	// Signature Help can reach it. Nothing is said twice; the description
	// carries no copy of it.
	it("should show a Parameter's text and the return text", () => {
		expect(hoverDocumentation(source, { line: 3, column: 17 })).toBe(
			[
				"Checks whether the Boolean has the same truth value as another.",
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
				"\t__print(match b -> Integer {",
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
