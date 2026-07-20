import { describe, expect, it } from "bun:test"

import { enrich } from "../enricher"
import type { common } from "../interfaces"
import {
	findOccurrence as findAnyOccurrence,
	findDefinition,
	findOccurrences,
	findRenameableOccurrence,
	isValidIdentifierName,
} from "../lsp/rename"
import { parseWithDiagnostics } from "../parser"

function findOccurrence(source: string, cursor: common.Cursor) {
	let { program } = parseWithDiagnostics(source)
	let { program: enrichedProgram } = enrich(program)

	return findRenameableOccurrence(program, cursor, enrichedProgram)
}

// NOTE: Applies a rename textually so that the expectations below can state
// full programs instead of position lists.
function rename(source: string, cursor: common.Cursor, newName: string) {
	let occurrence = findOccurrence(source, cursor)

	if (occurrence === null) {
		return null
	}

	let lines = source.split("\n")

	let sortedOccurrences = [...occurrence.declaration.occurrences].sort(
		(a, b) =>
			b.start.line - a.start.line || b.start.column - a.start.column,
	)

	for (let position of sortedOccurrences) {
		let line = lines[position.start.line - 1]

		lines[position.start.line - 1] =
			line.slice(0, position.start.column - 1) +
			newName +
			line.slice(position.end.column - 1)
	}

	return lines.join("\n")
}

describe("Rename", () => {
	it("should rename a Variable across declaration, reference and assignment", () => {
		let source = [
			"implementation {",
			'\tvariable name = "World"',
			'\tname = "Essence"',
			"\tconstant greeting = name",
			"}",
		].join("\n")

		expect(rename(source, { line: 2, column: 11 }, "subject")).toBe(
			[
				"implementation {",
				'\tvariable subject = "World"',
				'\tsubject = "Essence"',
				"\tconstant greeting = subject",
				"}",
			].join("\n"),
		)
	})

	it("should rename from a reference as well as from the declaration", () => {
		let source = [
			"implementation {",
			"\tconstant value = 1",
			"\tconstant other = value",
			"}",
		].join("\n")

		expect(rename(source, { line: 3, column: 19 }, "renamed")).toBe(
			rename(source, { line: 2, column: 11 }, "renamed"),
		)
	})

	it("should respect shadowing", () => {
		let source = [
			"implementation {",
			"\tconstant value = 1",
			"\tfunction show (value: String) -> String {",
			"\t\t<- value",
			"\t}",
			"}",
		].join("\n")

		// NOTE: Renaming the Parameter must leave the outer Constant alone.
		expect(rename(source, { line: 4, column: 6 }, "text")).toBe(
			[
				"implementation {",
				"\tconstant value = 1",
				"\tfunction show (text: String) -> String {",
				"\t\t<- text",
				"\t}",
				"}",
			].join("\n"),
		)

		// NOTE: And renaming the outer Constant must leave the Parameter alone.
		expect(rename(source, { line: 2, column: 11 }, "outer")).toBe(
			[
				"implementation {",
				"\tconstant outer = 1",
				"\tfunction show (value: String) -> String {",
				"\t\t<- value",
				"\t}",
				"}",
			].join("\n"),
		)
	})

	it("should rename hoisted Functions used before their declaration", () => {
		let source = [
			"implementation {",
			"\tconstant result = compute()",
			"\tfunction compute () -> Integer {",
			"\t\t<- 1",
			"\t}",
			"}",
		].join("\n")

		expect(rename(source, { line: 2, column: 20 }, "calculate")).toBe(
			[
				"implementation {",
				"\tconstant result = calculate()",
				"\tfunction calculate () -> Integer {",
				"\t\t<- 1",
				"\t}",
				"}",
			].join("\n"),
		)
	})

	it("should rename Type Aliases in the Type space", () => {
		let source = [
			"implementation {",
			"\ttype Name = String",
			'\tconstant name: Name = "Essence"',
			"}",
		].join("\n")

		expect(rename(source, { line: 3, column: 17 }, "Title")).toBe(
			[
				"implementation {",
				"\ttype Title = String",
				'\tconstant name: Title = "Essence"',
				"}",
			].join("\n"),
		)
	})

	it("should not confuse the value and the Type space", () => {
		let source = [
			"implementation {",
			"\ttype Name = String",
			'\tconstant Name = "Essence"',
			"}",
		].join("\n")

		let typeOccurrence = findOccurrence(source, { line: 2, column: 7 })
		let valueOccurrence = findOccurrence(source, { line: 3, column: 11 })

		expect(typeOccurrence).not.toBeNull()
		expect(valueOccurrence).not.toBeNull()

		if (typeOccurrence !== null && valueOccurrence !== null) {
			expect(typeOccurrence.declaration).not.toBe(
				valueOccurrence.declaration,
			)
		}
	})

	it("should rename Generic Type Parameters", () => {
		let source = [
			"implementation {",
			"\tfunction first<T>(_ items: List<T>) -> T {",
			"\t\t<- items::itemAt(0)",
			"\t}",
			"}",
		].join("\n")

		expect(rename(source, { line: 2, column: 17 }, "Item")).toBe(
			[
				"implementation {",
				"\tfunction first<Item>(_ items: List<Item>) -> Item {",
				"\t\t<- items::itemAt(0)",
				"\t}",
				"}",
			].join("\n"),
		)
	})

	it("should rename a Namespace including its use as a specifier", () => {
		let source = [
			"implementation {",
			"\tnamespace StringForInteger for Integer {",
			"\t\tstring() -> String {",
			'\t\t\t<- "1"',
			"\t\t}",
			"\t}",
			"\t1::<StringForInteger>string()",
			"}",
		].join("\n")

		expect(rename(source, { line: 7, column: 6 }, "Stringify")).toBe(
			[
				"implementation {",
				"\tnamespace Stringify for Integer {",
				"\t\tstring() -> String {",
				'\t\t\t<- "1"',
				"\t\t}",
				"\t}",
				"\t1::<Stringify>string()",
				"}",
			].join("\n"),
		)
	})

	it("should work with the cursor directly behind the Identifier", () => {
		let source = ["implementation {", "\tconstant value = 1", "}"].join(
			"\n",
		)

		expect(rename(source, { line: 2, column: 16 }, "renamed")).toBe(
			["implementation {", "\tconstant renamed = 1", "}"].join("\n"),
		)
	})

	it("should reject renaming builtins", () => {
		let source = [
			"implementation {",
			'\tconstant name: String = "Essence"',
			"\t__print(name)",
			"}",
		].join("\n")

		// NOTE: `String` in the Type Annotation, `__print` as a value.
		expect(findOccurrence(source, { line: 2, column: 17 })).toBeNull()
		expect(findOccurrence(source, { line: 3, column: 3 })).toBeNull()
	})

	it("should reject renaming Method names", () => {
		let source = [
			"implementation {",
			'\tconstant greeting = "Hello"::append("!")',
			"}",
		].join("\n")

		expect(findOccurrence(source, { line: 2, column: 31 })).toBeNull()
	})

	it("should reject positions without an Identifier", () => {
		let source = ["implementation {", "\tconstant value = 1", "}"].join(
			"\n",
		)

		expect(findOccurrence(source, { line: 2, column: 2 })).toBeNull()
	})
})

describe("Rename of argument labels", () => {
	it("should rename call site labels together with a label-less Parameter", () => {
		let source = [
			"implementation {",
			"\tfunction greet (subject: String) -> String {",
			"\t\t<- subject",
			"\t}",
			"",
			'\tgreet(subject "World")',
			"}",
		].join("\n")

		let renamed = [
			"implementation {",
			"\tfunction greet (name: String) -> String {",
			"\t\t<- name",
			"\t}",
			"",
			'\tgreet(name "World")',
			"}",
		].join("\n")

		// NOTE: From the Parameter, from the body and from the call site
		// label — all three rename the same symbol.
		expect(rename(source, { line: 2, column: 18 }, "name")).toBe(renamed)
		expect(rename(source, { line: 3, column: 6 }, "name")).toBe(renamed)
		expect(rename(source, { line: 6, column: 8 }, "name")).toBe(renamed)
	})

	it("should treat an explicit external name as its own symbol", () => {
		let source = [
			"implementation {",
			"\tfunction apply (using value: Integer) -> Integer {",
			"\t\t<- value",
			"\t}",
			"",
			"\tapply(using 1)",
			"}",
		].join("\n")

		// NOTE: Renaming the internal name never touches the label…
		expect(rename(source, { line: 3, column: 6 }, "amount")).toBe(
			[
				"implementation {",
				"\tfunction apply (using amount: Integer) -> Integer {",
				"\t\t<- amount",
				"\t}",
				"",
				"\tapply(using 1)",
				"}",
			].join("\n"),
		)

		// NOTE: …and renaming the label — from its declaration or from the
		// call site — never touches the internal name.
		let labelRenamed = [
			"implementation {",
			"\tfunction apply (via value: Integer) -> Integer {",
			"\t\t<- value",
			"\t}",
			"",
			"\tapply(via 1)",
			"}",
		].join("\n")

		expect(rename(source, { line: 2, column: 18 }, "via")).toBe(
			labelRenamed,
		)
		expect(rename(source, { line: 6, column: 8 }, "via")).toBe(labelRenamed)
	})

	it("should link labels of Function Values bound to Constants", () => {
		let source = [
			"implementation {",
			"\tconstant double = (amount: Integer) -> Integer {",
			"\t\t<- amount",
			"\t}",
			"",
			"\tdouble(amount 2)",
			"}",
		].join("\n")

		expect(rename(source, { line: 6, column: 9 }, "value")).toBe(
			[
				"implementation {",
				"\tconstant double = (value: Integer) -> Integer {",
				"\t\t<- value",
				"\t}",
				"",
				"\tdouble(value 2)",
				"}",
			].join("\n"),
		)
	})

	it("should link labels of hoisted Functions invoked before their declaration", () => {
		let source = [
			"implementation {",
			"\tconstant result = compute(seed 1)",
			"",
			"\tfunction compute (seed: Integer) -> Integer {",
			"\t\t<- seed",
			"\t}",
			"}",
		].join("\n")

		expect(rename(source, { line: 4, column: 20 }, "start")).toBe(
			[
				"implementation {",
				"\tconstant result = compute(start 1)",
				"",
				"\tfunction compute (start: Integer) -> Integer {",
				"\t\t<- start",
				"\t}",
				"}",
			].join("\n"),
		)
	})
})

describe("Rename of Methods and Record members", () => {
	it("should rename Methods across declaration and invocations", () => {
		let source = [
			"implementation {",
			"\tnamespace Stringify for Integer {",
			"\t\tstring() -> String {",
			'\t\t\t<- "one"',
			"\t\t}",
			"\t}",
			"",
			"\t__print(1::<Stringify>string())",
			"\t__print(1::string())",
			"}",
		].join("\n")

		let renamed = [
			"implementation {",
			"\tnamespace Stringify for Integer {",
			"\t\tstringify() -> String {",
			'\t\t\t<- "one"',
			"\t\t}",
			"\t}",
			"",
			"\t__print(1::<Stringify>stringify())",
			"\t__print(1::stringify())",
			"}",
		].join("\n")

		// NOTE: From the declaration and from both invocation forms.
		expect(rename(source, { line: 3, column: 4 }, "stringify")).toBe(
			renamed,
		)
		expect(rename(source, { line: 8, column: 25 }, "stringify")).toBe(
			renamed,
		)
		expect(rename(source, { line: 9, column: 14 }, "stringify")).toBe(
			renamed,
		)
	})

	it("should rename static Namespace properties across Lookups", () => {
		let source = [
			"implementation {",
			"\tnamespace Config {",
			'\t\tstatic version = "1"',
			"\t}",
			"",
			"\t__print(Config.version)",
			"}",
		].join("\n")

		let renamed = [
			"implementation {",
			"\tnamespace Config {",
			'\t\tstatic release = "1"',
			"\t}",
			"",
			"\t__print(Config.release)",
			"}",
		].join("\n")

		expect(rename(source, { line: 3, column: 10 }, "release")).toBe(renamed)
		expect(rename(source, { line: 6, column: 17 }, "release")).toBe(renamed)
	})

	it("should rename Record members across Type, literal and Lookup", () => {
		let source = [
			"implementation {",
			"\ttype Person = { firstName: String, lastName: String }",
			"",
			'\tconstant person: Person = { firstName = "Ada", lastName = "Lovelace" }',
			"",
			"\t__print(person.firstName)",
			"}",
		].join("\n")

		let renamed = [
			"implementation {",
			"\ttype Person = { givenName: String, lastName: String }",
			"",
			'\tconstant person: Person = { givenName = "Ada", lastName = "Lovelace" }',
			"",
			"\t__print(person.givenName)",
			"}",
		].join("\n")

		expect(rename(source, { line: 2, column: 19 }, "givenName")).toBe(
			renamed,
		)
		expect(rename(source, { line: 4, column: 31 }, "givenName")).toBe(
			renamed,
		)
		expect(rename(source, { line: 6, column: 18 }, "givenName")).toBe(
			renamed,
		)
	})

	it("should follow Record members through subset shapes", () => {
		let source = [
			"implementation {",
			"\tfunction describe (_ subject: { name: String }) -> String {",
			"\t\t<- subject.name",
			"\t}",
			"",
			'\t__print(describe({ name = "Essence" }))',
			"}",
		].join("\n")

		expect(rename(source, { line: 2, column: 34 }, "title")).toBe(
			[
				"implementation {",
				"\tfunction describe (_ subject: { title: String }) -> String {",
				"\t\t<- subject.title",
				"\t}",
				"",
				'\t__print(describe({ title = "Essence" }))',
				"}",
			].join("\n"),
		)
	})

	it("should keep unrelated Record shapes apart", () => {
		let source = [
			"implementation {",
			'\tconstant box = { name = "box", size = 1 }',
			'\tconstant person = { name = "Ada", age = 36 }',
			"\t__print(box.name)",
			"}",
		].join("\n")

		// NOTE: `person` also has a `name`, but its shape is neither a
		// subset nor a superset of `box` — it stays untouched.
		expect(rename(source, { line: 4, column: 14 }, "label")).toBe(
			[
				"implementation {",
				'\tconstant box = { label = "box", size = 1 }',
				'\tconstant person = { name = "Ada", age = 36 }',
				"\t__print(box.label)",
				"}",
			].join("\n"),
		)
	})

	it("should still reject Methods of builtin Namespaces", () => {
		let source = [
			"implementation {",
			'\tconstant greeting = "Hello"::append("!")',
			"}",
		].join("\n")

		expect(findOccurrence(source, { line: 2, column: 31 })).toBeNull()
	})
})

describe("findDefinition", () => {
	function definitionOf(source: string, cursor: common.Cursor) {
		let { program } = parseWithDiagnostics(source)
		let { program: enrichedProgram } = enrich(program)

		return findDefinition(program, cursor, enrichedProgram)
	}

	it("should point Method invocations at the Method declaration", () => {
		let source = [
			"implementation {",
			"\tnamespace Stringify for Integer {",
			"\t\tstring() -> String {",
			'\t\t\t<- "one"',
			"\t\t}",
			"\t}",
			"",
			"\t__print(1::string())",
			"}",
		].join("\n")

		expect(definitionOf(source, { line: 8, column: 14 })).toEqual({
			start: { line: 3, column: 3 },
			end: { line: 3, column: 9 },
		})
	})

	it("should point references at their declaration", () => {
		let source = [
			"implementation {",
			"\tconstant value = 1",
			"\tconstant other = value",
			"}",
		].join("\n")

		expect(definitionOf(source, { line: 3, column: 19 })).toEqual({
			start: { line: 2, column: 11 },
			end: { line: 2, column: 16 },
		})
	})

	it("should point hoisted references at the later declaration", () => {
		let source = [
			"implementation {",
			"\tconstant result = compute()",
			"",
			"\tfunction compute () -> Integer {",
			"\t\t<- 1",
			"\t}",
			"}",
		].join("\n")

		expect(definitionOf(source, { line: 2, column: 20 })).toEqual({
			start: { line: 4, column: 11 },
			end: { line: 4, column: 18 },
		})
	})

	it("should point call site labels at the Parameter declaring them", () => {
		let source = [
			"implementation {",
			"\tfunction apply (using value: Integer) -> Integer {",
			"\t\t<- value",
			"\t}",
			"",
			"\tapply(using 1)",
			"}",
		].join("\n")

		expect(definitionOf(source, { line: 6, column: 8 })).toEqual({
			start: { line: 2, column: 18 },
			end: { line: 2, column: 23 },
		})
	})

	it("should return null for builtins", () => {
		let source = [
			"implementation {",
			'\tconstant name: String = "Essence"',
			"}",
		].join("\n")

		expect(definitionOf(source, { line: 2, column: 17 })).toBeNull()
	})
})

describe("isValidIdentifierName", () => {
	it("should accept plain names", () => {
		expect(isValidIdentifierName("value")).toBe(true)
		expect(isValidIdentifierName("Name2")).toBe(true)
	})

	it("should reject names the Lexer would not produce as one Identifier", () => {
		expect(isValidIdentifierName("")).toBe(false)
		expect(isValidIdentifierName("two words")).toBe(false)
		expect(isValidIdentifierName("with-dash")).toBe(false)
		expect(isValidIdentifierName("with_underscore")).toBe(false)
		expect(isValidIdentifierName("a.b")).toBe(false)
		expect(isValidIdentifierName("1value")).toBe(false)
		expect(isValidIdentifierName('quo"te')).toBe(false)
	})

	it("should reject reserved words", () => {
		expect(isValidIdentifierName("constant")).toBe(false)
		expect(isValidIdentifierName("match")).toBe(false)
		expect(isValidIdentifierName("nothing")).toBe(false)
		expect(isValidIdentifierName("true")).toBe(false)
	})
})

describe("findOccurrence (References)", () => {
	function occurrencesOf(source: string, cursor: common.Cursor) {
		let { program } = parseWithDiagnostics(source)
		let { program: enrichedProgram } = enrich(program)

		return findAnyOccurrence(program, cursor, enrichedProgram)
	}

	it("should report every occurrence of a Constant", () => {
		let source = [
			"implementation {",
			"\tconstant value = 1",
			"\tconstant other = value",
			"\t__print(value)",
			"}",
		].join("\n")

		let occurrence = occurrencesOf(source, { line: 3, column: 19 })

		expect(occurrence).not.toBeNull()
		expect(occurrence?.declaration.occurrences).toHaveLength(3)
		expect(occurrence?.declaration.definition).toEqual({
			start: { line: 2, column: 11 },
			end: { line: 2, column: 16 },
		})
	})

	it("should report occurrences of builtins, unlike renaming", () => {
		let source = [
			"implementation {",
			'\t__print("one")',
			'\t__print("two")',
			"}",
		].join("\n")

		let occurrence = occurrencesOf(source, { line: 2, column: 3 })

		expect(occurrence?.declaration.builtin).toBe(true)
		expect(occurrence?.declaration.definition).toBeNull()
		expect(occurrence?.declaration.occurrences).toHaveLength(2)

		expect(findOccurrence(source, { line: 2, column: 3 })).toBeNull()
	})

	it("should report Method occurrences across declaration and invocations", () => {
		let source = [
			"implementation {",
			"\tnamespace Stringify for Integer {",
			"\t\tstring() -> String {",
			'\t\t\t<- "one"',
			"\t\t}",
			"\t}",
			"\t__print(1::string())",
			"\t__print(2::<Stringify>string())",
			"}",
		].join("\n")

		let occurrence = occurrencesOf(source, { line: 7, column: 14 })

		expect(occurrence?.declaration.occurrences).toHaveLength(3)
	})
})

describe("findOccurrences (Document Highlight)", () => {
	function occurrencesOf(source: string, cursor: common.Cursor) {
		let { program } = parseWithDiagnostics(source)
		let { program: enrichedProgram } = enrich(program)

		return findOccurrences(program, cursor, enrichedProgram)
	}

	it("should mark the declaration and assignments as writes, uses as reads", () => {
		let source = [
			"implementation {",
			"\tvariable count = 1",
			"\tcount = 2",
			"\t__print(count)",
			"}",
		].join("\n")

		let occurrences = occurrencesOf(source, { line: 2, column: 11 })

		expect(
			occurrences.map((occurrence) => [
				occurrence.position.start.line,
				occurrence.access,
			]),
		).toEqual([
			[2, "write"],
			[3, "write"],
			[4, "read"],
		])
	})

	it("should mark a Parameter's declaration as a write and its uses as reads", () => {
		let source = [
			"implementation {",
			"\tfunction greet (subject: String) -> String {",
			"\t\t<- subject",
			"\t}",
			"}",
		].join("\n")

		let occurrences = occurrencesOf(source, { line: 3, column: 6 })

		expect(occurrences.map((occurrence) => occurrence.access)).toEqual([
			"write",
			"read",
		])
	})

	it("should return nothing when there is no Identifier at the cursor", () => {
		let source = ["implementation {", "\tconstant value = 1", "}"].join(
			"\n",
		)

		expect(occurrencesOf(source, { line: 2, column: 2 })).toEqual([])
	})
})
