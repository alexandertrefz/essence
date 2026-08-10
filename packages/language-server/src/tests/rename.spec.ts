import { describe, expect, it } from "bun:test"

import { enrich } from "@essence-lang/compiler/enricher"
import { parseWithDiagnostics } from "@essence-lang/compiler/parser"
import type { common } from "@essence-lang/interfaces"

import {
	findOccurrence as findAnyOccurrence,
	findDefinition,
	findOccurrences,
	findRenameableOccurrence,
	identifierPattern,
	isValidIdentifierName,
	isValidLabelName,
	renameEdits,
} from "../rename"

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

	// NOTE: Applied through `renameEdits`, which is what the Server applies —
	// so a Pattern's shorthand expansion is exercised here rather than only
	// described. One site can write more than one edit, and an edit's span is
	// its own: a binder added after a Type is an INSERTION at an empty span.
	let edits = occurrence.declaration.occurrences
		.flatMap((site) => renameEdits(site, newName))
		.sort(
			(a, b) =>
				b.position.start.line - a.position.start.line ||
				b.position.start.column - a.position.start.column,
		)

	for (let { position, newText } of edits) {
		let line = lines[position.start.line - 1]

		lines[position.start.line - 1] =
			line.slice(0, position.start.column - 1) +
			newText +
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
			"\t\t<- items::item(at 0)",
			"\t}",
			"}",
		].join("\n")

		expect(rename(source, { line: 2, column: 17 }, "Item")).toBe(
			[
				"implementation {",
				"\tfunction first<Item>(_ items: List<Item>) -> Item {",
				"\t\t<- items::item(at 0)",
				"\t}",
				"}",
			].join("\n"),
		)
	})

	it("should rename a generic Choice's Type Parameter from its declaration", () => {
		let source = [
			"implementation {",
			"\tchoice Box<Value> {",
			"\t\tHolding { value: Value },",
			"\t\tEmpty,",
			"\t}",
			"}",
		].join("\n")

		// NOTE: The header's `Value` and its use in the payload move together;
		// the member name `value` is a separate symbol and stays put.
		expect(rename(source, { line: 2, column: 13 }, "Element")).toBe(
			[
				"implementation {",
				"\tchoice Box<Element> {",
				"\t\tHolding { value: Element },",
				"\t\tEmpty,",
				"\t}",
				"}",
			].join("\n"),
		)
	})

	it("should rename a generic Choice's Type Parameter from a payload use", () => {
		let source = [
			"implementation {",
			"\tchoice Box<Value> {",
			"\t\tHolding { value: Value },",
			"\t\tEmpty,",
			"\t}",
			"}",
		].join("\n")

		expect(rename(source, { line: 3, column: 20 }, "Element")).toBe(
			[
				"implementation {",
				"\tchoice Box<Element> {",
				"\t\tHolding { value: Element },",
				"\t\tEmpty,",
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
			"\tTerminal.inspect(name)",
			"}",
		].join("\n")

		// NOTE: `String` in the Type Annotation, `Terminal` as a value.
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

	// NOTE: `with` is a Keyword the grammar's Identifier rule reads as an
	// ordinary Identifier in label position — the standard library's own
	// dominant label — so a label may be renamed to it and the result parses.
	it("should rename an explicit label to a Keyword the grammar accepts there", () => {
		let source = [
			"implementation {",
			"\tfunction pad (using filler: String) -> String {",
			"\t\t<- filler",
			"\t}",
			"",
			'\tpad(using "-")',
			"}",
		].join("\n")

		let renamed = rename(source, { line: 2, column: 16 }, "with")

		expect(renamed).toBe(
			[
				"implementation {",
				"\tfunction pad (with filler: String) -> String {",
				"\t\t<- filler",
				"\t}",
				"",
				'\tpad(with "-")',
				"}",
			].join("\n"),
		)
		expect(parseWithDiagnostics(renamed!).diagnostics).toEqual([])
	})
})

describe("Rename in an overload function block", () => {
	// NOTE: `overload function` is a declarations-mode form — the standard
	// library's alone — so these parse with its header and rename off the
	// Parser index, exactly as the Server indexes a standard library source.
	function renameDeclarations(
		source: string,
		cursor: common.Cursor,
		newName: string,
	) {
		let { program } = parseWithDiagnostics(source, {
			allowDeclarationsHeader: true,
		})
		let occurrence = findRenameableOccurrence(program, cursor)

		if (occurrence === null) {
			return null
		}

		let lines = source.split("\n")
		let edits = occurrence.declaration.occurrences
			.flatMap((site) => renameEdits(site, newName))
			.sort(
				(a, b) =>
					b.position.start.line - a.position.start.line ||
					b.position.start.column - a.position.start.column,
			)

		for (let { position, newText } of edits) {
			let line = lines[position.start.line - 1]

			lines[position.start.line - 1] =
				line.slice(0, position.start.column - 1) +
				newText +
				line.slice(position.end.column - 1)
		}

		return lines.join("\n")
	}

	let source = [
		"declarations {",
		"\toverload function double {",
		"\t\t(_ value: Integer) -> Integer",
		"",
		"\t\t(over values: Integer) -> Integer {",
		"\t\t\t<- double(values)",
		"\t\t}",
		"\t}",
		"}",
	].join("\n")

	it("should rename a Parameter used inside an overload body", () => {
		expect(
			renameDeclarations(source, { line: 5, column: 9 }, "amounts"),
		).toBe(
			[
				"declarations {",
				"\toverload function double {",
				"\t\t(_ value: Integer) -> Integer",
				"",
				"\t\t(over amounts: Integer) -> Integer {",
				"\t\t\t<- double(amounts)",
				"\t\t}",
				"\t}",
				"}",
			].join("\n"),
		)
	})

	it("should rename the overloaded Function together with its calls", () => {
		expect(
			renameDeclarations(source, { line: 2, column: 20 }, "twice"),
		).toBe(
			[
				"declarations {",
				"\toverload function twice {",
				"\t\t(_ value: Integer) -> Integer",
				"",
				"\t\t(over values: Integer) -> Integer {",
				"\t\t\t<- twice(values)",
				"\t\t}",
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
			"\tTerminal.inspect(1::<Stringify>string())",
			"\tTerminal.inspect(1::string())",
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
			"\tTerminal.inspect(1::<Stringify>stringify())",
			"\tTerminal.inspect(1::stringify())",
			"}",
		].join("\n")

		// NOTE: From the declaration and from both invocation forms.
		expect(rename(source, { line: 3, column: 4 }, "stringify")).toBe(
			renamed,
		)
		expect(rename(source, { line: 8, column: 34 }, "stringify")).toBe(
			renamed,
		)
		expect(rename(source, { line: 9, column: 23 }, "stringify")).toBe(
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
			"\tTerminal.inspect(Config.version)",
			"}",
		].join("\n")

		let renamed = [
			"implementation {",
			"\tnamespace Config {",
			'\t\tstatic release = "1"',
			"\t}",
			"",
			"\tTerminal.inspect(Config.release)",
			"}",
		].join("\n")

		expect(rename(source, { line: 3, column: 10 }, "release")).toBe(renamed)
		expect(rename(source, { line: 6, column: 26 }, "release")).toBe(renamed)
	})

	it("should rename Record members across Type, literal and Lookup", () => {
		let source = [
			"implementation {",
			"\ttype Person = { firstName: String, lastName: String }",
			"",
			'\tconstant person: Person = { firstName = "Ada", lastName = "Lovelace" }',
			"",
			"\tTerminal.inspect(person.firstName)",
			"}",
		].join("\n")

		let renamed = [
			"implementation {",
			"\ttype Person = { givenName: String, lastName: String }",
			"",
			'\tconstant person: Person = { givenName = "Ada", lastName = "Lovelace" }',
			"",
			"\tTerminal.inspect(person.givenName)",
			"}",
		].join("\n")

		expect(rename(source, { line: 2, column: 19 }, "givenName")).toBe(
			renamed,
		)
		expect(rename(source, { line: 4, column: 31 }, "givenName")).toBe(
			renamed,
		)
		expect(rename(source, { line: 6, column: 27 }, "givenName")).toBe(
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
			'\tTerminal.inspect(describe({ name = "Essence" }))',
			"}",
		].join("\n")

		expect(rename(source, { line: 2, column: 34 }, "title")).toBe(
			[
				"implementation {",
				"\tfunction describe (_ subject: { title: String }) -> String {",
				"\t\t<- subject.title",
				"\t}",
				"",
				'\tTerminal.inspect(describe({ title = "Essence" }))',
				"}",
			].join("\n"),
		)
	})

	it("should keep unrelated Record shapes apart", () => {
		let source = [
			"implementation {",
			'\tconstant box = { name = "box", size = 1 }',
			'\tconstant person = { name = "Ada", age = 36 }',
			"\tTerminal.inspect(box.name)",
			"}",
		].join("\n")

		// NOTE: `person` also has a `name`, but its shape is neither a
		// subset nor a superset of `box` — it stays untouched.
		expect(rename(source, { line: 4, column: 23 }, "label")).toBe(
			[
				"implementation {",
				'\tconstant box = { label = "box", size = 1 }',
				'\tconstant person = { name = "Ada", age = 36 }',
				"\tTerminal.inspect(box.label)",
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

	// NOTE: Both bind in the typed pass, which used to see nothing but a
	// Handler's body — a Method invoked only from a Guard renamed at its
	// declaration and nowhere else, which silently broke the Program.
	it("should rename a Method invoked from a Match Guard", () => {
		let source = [
			"implementation {",
			"\tnamespace Checks for Integer {",
			"\t\tisSmall() -> Boolean {",
			"\t\t\t<- @::isLessThan(10)",
			"\t\t}",
			"\t}",
			"",
			"\tconstant amount: Integer | String = 4",
			"\tconstant label = match amount -> String {",
			'\t\tcase Integer where @::isSmall() { <- "small" }',
			'\t\tcase Integer { <- "big" }',
			"\t\tcase String { <- @ }",
			"\t}",
			"}",
		].join("\n")

		let renamed = [
			"implementation {",
			"\tnamespace Checks for Integer {",
			"\t\tisTiny() -> Boolean {",
			"\t\t\t<- @::isLessThan(10)",
			"\t\t}",
			"\t}",
			"",
			"\tconstant amount: Integer | String = 4",
			"\tconstant label = match amount -> String {",
			'\t\tcase Integer where @::isTiny() { <- "small" }',
			'\t\tcase Integer { <- "big" }',
			"\t\tcase String { <- @ }",
			"\t}",
			"}",
		].join("\n")

		expect(rename(source, { line: 3, column: 4 }, "isTiny")).toBe(renamed)
		expect(rename(source, { line: 10, column: 25 }, "isTiny")).toBe(renamed)
	})

	it("should rename a Case Matcher's payload binding from Matcher, Guard and body", () => {
		// NOTE: The Case's own member keeps its name — a payload binding is a
		// local name for the value, not a second spelling of the member.
		let source = [
			"implementation {",
			"\tchoice Shape {",
			"\t\tCircle { radius: Integer },",
			"\t\tDot,",
			"\t}",
			"",
			"\tconstant drawn: Shape = #Circle(3)",
			"\tconstant size = match drawn -> Integer {",
			"\t\tcase #Circle(radius) where radius::isLessThan(2) { <- radius }",
			"\t\tcase #Circle { <- 0 }",
			"\t\tcase #Dot { <- 0 }",
			"\t}",
			"}",
		].join("\n")

		let renamed = [
			"implementation {",
			"\tchoice Shape {",
			"\t\tCircle { radius: Integer },",
			"\t\tDot,",
			"\t}",
			"",
			"\tconstant drawn: Shape = #Circle(3)",
			"\tconstant size = match drawn -> Integer {",
			"\t\tcase #Circle(span) where span::isLessThan(2) { <- span }",
			"\t\tcase #Circle { <- 0 }",
			"\t\tcase #Dot { <- 0 }",
			"\t}",
			"}",
		].join("\n")

		expect(rename(source, { line: 9, column: 16 }, "span")).toBe(renamed)
		expect(rename(source, { line: 9, column: 30 }, "span")).toBe(renamed)
		expect(rename(source, { line: 9, column: 57 }, "span")).toBe(renamed)
	})

	it("should rename a Record member looked up in a Match Guard", () => {
		let source = [
			"implementation {",
			"\ttype Point = { x: Integer, y: Integer }",
			"",
			"\tconstant point: Point | String = { x = 0, y = 7 }",
			"\tconstant label = match point -> String {",
			'\t\tcase Point where @.x::isNegative() { <- "left of the axis" }',
			'\t\tcase Point { <- "on it or right of it" }',
			"\t\tcase String { <- @ }",
			"\t}",
			"}",
		].join("\n")

		expect(rename(source, { line: 2, column: 17 }, "horizontal")).toBe(
			[
				"implementation {",
				"\ttype Point = { horizontal: Integer, y: Integer }",
				"",
				"\tconstant point: Point | String = { horizontal = 0, y = 7 }",
				"\tconstant label = match point -> String {",
				'\t\tcase Point where @.horizontal::isNegative() { <- "left of the axis" }',
				'\t\tcase Point { <- "on it or right of it" }',
				"\t\tcase String { <- @ }",
				"\t}",
				"}",
			].join("\n"),
		)
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
			"\tTerminal.inspect(1::string())",
			"}",
		].join("\n")

		expect(definitionOf(source, { line: 8, column: 23 })).toEqual({
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
		expect(isValidIdentifierName("choice")).toBe(false)
		expect(isValidIdentifierName("true")).toBe(false)
	})
})

describe("isValidLabelName", () => {
	it("should accept the Keywords the grammar's Identifier rule admits", () => {
		expect(isValidLabelName("with")).toBe(true)
		expect(isValidLabelName("from")).toBe(true)
		expect(isValidLabelName("as")).toBe(true)
		expect(isValidLabelName("case")).toBe(true)
	})

	it("should accept everything a plain Identifier accepts", () => {
		expect(isValidLabelName("value")).toBe(true)
		expect(isValidLabelName("Name2")).toBe(true)
	})

	it("should keep refusing what no Identifier Token can spell", () => {
		expect(isValidLabelName("for")).toBe(false)
		expect(isValidLabelName("match")).toBe(false)
		expect(isValidLabelName("true")).toBe(false)
		expect(isValidLabelName("two words")).toBe(false)
		expect(isValidLabelName("1value")).toBe(false)
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
			"\tTerminal.inspect(value)",
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
			'\tTerminal.inspect("one")',
			'\tTerminal.inspect("two")',
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
			"\tTerminal.inspect(1::string())",
			"\tTerminal.inspect(2::<Stringify>string())",
			"}",
		].join("\n")

		let occurrence = occurrencesOf(source, { line: 7, column: 23 })

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
			"\tTerminal.inspect(count)",
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

	// NOTE: The Server's Document Highlight falls back to this for anything
	// the workspace join has no symbol for — a builtin above all — so builtins
	// highlight exactly as References already finds them.
	it("should report occurrences of builtins, like References", () => {
		let source = [
			"implementation {",
			'\tTerminal.inspect("one")',
			'\tTerminal.inspect("two")',
			"}",
		].join("\n")

		let occurrences = occurrencesOf(source, { line: 2, column: 3 })

		expect(occurrences).toHaveLength(2)
		expect(
			occurrences.map((occurrence) => [
				occurrence.position.start.line,
				occurrence.access,
			]),
		).toEqual([
			[2, "read"],
			[3, "read"],
		])
	})
})

describe("identifierPattern", () => {
	// NOTE: Editors get this as a word pattern, so it has to agree with
	// `isValidIdentifierName` on what one whole Identifier is.
	function wholeMatch(text: string) {
		return new RegExp(`^(?:${identifierPattern})$`).test(text)
	}

	it("should match a whole plain Identifier", () => {
		expect(wholeMatch("value")).toBe(true)
		expect(wholeMatch("Name2")).toBe(true)
	})

	it("should stop at the Symbols the Lexer treats as separators", () => {
		expect(wholeMatch("with_underscore")).toBe(false)
		expect(wholeMatch("with-dash")).toBe(false)
		expect(wholeMatch("a.b")).toBe(false)
		expect(wholeMatch("two words")).toBe(false)
	})

	it("should select only the Identifier out of surrounding syntax", () => {
		expect(
			"person.firstName".match(new RegExp(identifierPattern, "g")),
		).toEqual(["person", "firstName"])
		expect(
			"42::string()".match(new RegExp(identifierPattern, "g")),
		).toEqual(["42", "string"])
	})
	describe("Protocols", () => {
		it("should rename a Protocol together with its Conformance Clauses and bounds", () => {
			let source = [
				"implementation {",
				"\tprotocol Sizable {",
				"\t\tsize() -> Integer",
				"\t}",
				"\tnamespace IntegerSizable for Integer is Sizable {",
				"\t\tsize() -> Integer {",
				"\t\t\t<- 1",
				"\t\t}",
				"\t}",
				"\tfunction measure <infer Value is Sizable>(_ value: Value) -> Integer {",
				"\t\t<- value::size()",
				"\t}",
				"}",
			].join("\n")

			expect(rename(source, { line: 2, column: 12 }, "Measurable")).toBe(
				[
					"implementation {",
					"\tprotocol Measurable {",
					"\t\tsize() -> Integer",
					"\t}",
					"\tnamespace IntegerSizable for Integer is Measurable {",
					"\t\tsize() -> Integer {",
					"\t\t\t<- 1",
					"\t\t}",
					"\t}",
					"\tfunction measure <infer Value is Measurable>(_ value: Value) -> Integer {",
					"\t\t<- value::size()",
					"\t}",
					"}",
				].join("\n"),
			)
		})

		it("should not rename a builtin Protocol", () => {
			let source = [
				"implementation {",
				"\tnamespace Wrapper for Integer is Printable {",
				"\t\ttoString() -> String {",
				'\t\t\t<- "one"',
				"\t\t}",
				"\t}",
				"}",
			].join("\n")

			expect(findOccurrence(source, { line: 2, column: 38 })).toBeNull()
		})
	})
})

describe("Rename through where clauses", () => {
	let conditionalSource = [
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

	it("should rename a Namespace Generic from its declaration through the where clause", () => {
		expect(
			rename(conditionalSource, { line: 2, column: 23 }, "Element"),
		).toBe(conditionalSource.replaceAll("Item", "Element"))
	})

	it("should rename a Namespace Generic from its where-clause mention", () => {
		expect(
			rename(conditionalSource, { line: 3, column: 24 }, "Element"),
		).toBe(conditionalSource.replaceAll("Item", "Element"))
	})

	it("should rename a Protocol through clause and condition mentions", () => {
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

		expect(rename(source, { line: 6, column: 7 }, "Measurable")).toBe(
			source.replaceAll("Sizable", "Measurable"),
		)
	})
})

// NOTE: A Pattern's bare member names TWO things with one Identifier — the
// Record's member and the local it binds — so renaming either end has to spell
// the other out beside it. Everything here is about that one fact; a Pattern
// that already writes its binder needs nothing special and is asserted to stay
// ordinary.
describe("Rename with Patterns", () => {
	const declaration = [
		"implementation {",
		"\tconstant box = { width = 1, height = 2 }",
		"",
		"\tconstant { width, height } = box",
		"",
		"\tTerminal.print(width::add(height))",
		"}",
	].join("\n")

	it("expands a shorthand binder when the LOCAL is renamed", () => {
		expect(rename(declaration, { line: 4, column: 13 }, "w")).toBe(
			[
				"implementation {",
				"\tconstant box = { width = 1, height = 2 }",
				"",
				"\tconstant { width as w, height } = box",
				"",
				"\tTerminal.print(w::add(height))",
				"}",
			].join("\n"),
		)
	})

	it("expands a shorthand binder the other way when the MEMBER is renamed", () => {
		// NOTE: Started from the Record literal, because a cursor ON the binder
		// always finds the local first — the member half is reached from any of
		// the sites that write the member itself.
		expect(rename(declaration, { line: 2, column: 19 }, "breadth")).toBe(
			[
				"implementation {",
				"\tconstant box = { breadth = 1, height = 2 }",
				"",
				"\tconstant { breadth as width, height } = box",
				"",
				"\tTerminal.print(width::add(height))",
				"}",
			].join("\n"),
		)
	})

	it("writes an annotated member's binder after its Type", () => {
		let source = [
			"implementation {",
			"\tconstant box = { width = 1 }",
			"",
			"\tconstant { width: Integer } = box",
			"",
			"\tTerminal.print(width)",
			"}",
		].join("\n")

		expect(rename(source, { line: 4, column: 13 }, "w")).toBe(
			[
				"implementation {",
				"\tconstant box = { width = 1 }",
				"",
				"\tconstant { width: Integer as w } = box",
				"",
				"\tTerminal.print(w)",
				"}",
			].join("\n"),
		)
	})

	it("renames a written binder without expanding anything", () => {
		let source = [
			"implementation {",
			"\tconstant box = { width = 1 }",
			"",
			"\tconstant { width as measure } = box",
			"",
			"\tTerminal.print(measure)",
			"}",
		].join("\n")

		expect(rename(source, { line: 4, column: 22 }, "size")).toBe(
			[
				"implementation {",
				"\tconstant box = { width = 1 }",
				"",
				"\tconstant { width as size } = box",
				"",
				"\tTerminal.print(size)",
				"}",
			].join("\n"),
		)
	})

	it("renames a Matcher's binding across its Guard and its body", () => {
		let source = [
			"implementation {",
			"\tconstant point: { x: Integer } | { key: String } = { x = 1 }",
			"",
			"\tconstant read = match point -> Integer {",
			"\t\tcase { x } where x::isPositive() { <- x }",
			"\t\tcase _ { <- 0 }",
			"\t}",
			"}",
		].join("\n")

		expect(rename(source, { line: 5, column: 10 }, "across")).toBe(
			[
				"implementation {",
				"\tconstant point: { x: Integer } | { key: String } = { x = 1 }",
				"",
				"\tconstant read = match point -> Integer {",
				"\t\tcase { x as across } where across::isPositive() { <- across }",
				"\t\tcase _ { <- 0 }",
				"\t}",
				"}",
			].join("\n"),
		)
	})

	it("renames a Pattern Parameter's binding", () => {
		let source = [
			"implementation {",
			"\tfunction area(of { width, height }: {",
			"\t\twidth: Integer,",
			"\t\theight: Integer,",
			"\t}) -> Integer {",
			"\t\t<- width::multiply(with height)",
			"\t}",
			"}",
		].join("\n")

		expect(rename(source, { line: 2, column: 21 }, "w")).toBe(
			[
				"implementation {",
				"\tfunction area(of { width as w, height }: {",
				"\t\twidth: Integer,",
				"\t\theight: Integer,",
				"\t}) -> Integer {",
				"\t\t<- w::multiply(with height)",
				"\t}",
				"}",
			].join("\n"),
		)
	})

	// NOTE: `as` separates a member from the name it binds under, so a binder
	// renamed to it would read as the separator it is.
	it("refuses 'as' as a rename target", () => {
		expect(isValidIdentifierName("as")).toBe(false)
	})

	// NOTE: The grammar is `Identifier ":" Type "as" Binder`, so the binder goes
	// after the Type. Writing it straight after the name produced
	// `{ breadth as width: Integer }`, which is not a Pattern — a plain rename
	// turned a clean file into a syntax error.
	it("writes the expansion AFTER the Type when the member is renamed", () => {
		let source = [
			"implementation {",
			"\tconstant box = { width = 1 }",
			"",
			"\tconstant { width: Integer } = box",
			"",
			"\tTerminal.print(width)",
			"}",
		].join("\n")

		expect(rename(source, { line: 2, column: 19 }, "breadth")).toBe(
			[
				"implementation {",
				"\tconstant box = { breadth = 1 }",
				"",
				"\tconstant { breadth: Integer as width } = box",
				"",
				"\tTerminal.print(width)",
				"}",
			].join("\n"),
		)
	})

	// NOTE: Every step of a spine carries the span it was WRITTEN at. Given the
	// innermost binder's span instead, renaming the outer member overwrote the
	// inner binders and destroyed the whole Pattern.
	it("renames a nested Pattern's outer member without touching its binders", () => {
		let source = [
			"implementation {",
			"\tconstant point = { origin = { x = 1, y = 2 } }",
			"",
			"\tconstant { origin as { x, y } } = point",
			"",
			"\tTerminal.print(x::add(y))",
			"}",
		].join("\n")

		expect(rename(source, { line: 2, column: 21 }, "start")).toBe(
			[
				"implementation {",
				"\tconstant point = { start = { x = 1, y = 2 } }",
				"",
				"\tconstant { start as { x, y } } = point",
				"",
				"\tTerminal.print(x::add(y))",
				"}",
			].join("\n"),
		)
	})

	// NOTE: A Guard's use of a binding lowers to a Lookup off `@`, and that
	// Lookup is indexed. Given the USE's span for its member step, renaming the
	// member overwrote the Guard's own identifier and left the binder behind.
	it("renames a member without rewriting a Guard's use of the binding", () => {
		let source = [
			"implementation {",
			"\ttype Inner = { index: Integer, total: Integer }",
			"\ttype Other = { key: String }",
			"",
			"\tconstant value: Inner | Other = { index = 1, total = 2 }",
			"",
			"\tTerminal.print(match value -> String {",
			'\t\tcase { index, total } where index::isLessThan(total) { <- "rising" }',
			'\t\tcase _ { <- "other" }',
			"\t})",
			"}",
		].join("\n")

		expect(rename(source, { line: 2, column: 17 }, "position")).toBe(
			[
				"implementation {",
				"\ttype Inner = { position: Integer, total: Integer }",
				"\ttype Other = { key: String }",
				"",
				"\tconstant value: Inner | Other = { position = 1, total = 2 }",
				"",
				"\tTerminal.print(match value -> String {",
				'\t\tcase { position as index, total } where index::isLessThan(total) { <- "rising" }',
				'\t\tcase _ { <- "other" }',
				"\t})",
				"}",
			].join("\n"),
		)
	})

	// NOTE: An annotation inside a nested Pattern is a Type reference like any
	// other; one left out of the index is one a rename leaves dangling.
	it("renames a Type named inside a nested Pattern", () => {
		let source = [
			"implementation {",
			"\ttype Len = Integer",
			"",
			"\tconstant point = { origin = { x = 1, y = 2 } }",
			"",
			"\tconstant { origin as { x: Len, y } } = point",
			"",
			"\tTerminal.print(x::add(y))",
			"}",
		].join("\n")

		expect(rename(source, { line: 2, column: 7 }, "Length")).toBe(
			source.replaceAll("Len", "Length"),
		)
	})
})

// NOTE: One file's own view of the two Module sections. What crosses a file
// boundary is the workspace index's business — `workspace.spec.ts` — and what
// is asserted here is the half that has to hold without one: an entry binds a
// name, uses of it resolve to that entry, and an export entry reads the
// declaration it publishes.
describe("Rename through the Module sections", () => {
	it("should rename an import entry together with every use of it", () => {
		let source = [
			"import {",
			'\tRectangle from "./Geometry.es"',
			"}",
			"implementation {",
			"\tfunction widthOf(_ shape: Rectangle) -> Integer {",
			"\t\t<- shape.width",
			"\t}",
			"}",
		].join("\n")

		expect(rename(source, { line: 5, column: 29 }, "Box")).toBe(
			source.replaceAll("Rectangle", "Box"),
		)
	})

	it("should rename from the entry as well as from a use", () => {
		let source = [
			"import {",
			'\tsquare from "./Math.es"',
			"}",
			"implementation {",
			"\tconstant nine = square(3)",
			"}",
		].join("\n")

		expect(rename(source, { line: 2, column: 3 }, "squared")).toBe(
			source.replaceAll("square", "squared"),
		)
	})

	// NOTE: An aliased entry binds the alias and nothing else — the name on the
	// other side of the `as` is what the exporting Module publishes, and one
	// file has no business renaming that.
	it("should bind an aliased import under its alias alone", () => {
		let source = [
			"import {",
			'\tPI as Pi from "./Math.es"',
			"}",
			"implementation {",
			"\tconstant doubled = Pi::multiply(with 2/1)",
			"}",
		].join("\n")

		expect(rename(source, { line: 5, column: 22 }, "Ratio")).toBe(
			[
				"import {",
				'\tPI as Ratio from "./Math.es"',
				"}",
				"implementation {",
				"\tconstant doubled = Ratio::multiply(with 2/1)",
				"}",
			].join("\n"),
		)
	})

	it("should rename an export entry with the declaration it publishes", () => {
		let source = [
			"implementation {",
			"\tfunction squared(_ value: Integer) -> Integer {",
			"\t\t<- value::multiply(with value)",
			"\t}",
			"}",
			"export {",
			"\tsquared",
			"}",
		].join("\n")

		expect(rename(source, { line: 7, column: 3 }, "powered")).toBe(
			source.replaceAll("squared", "powered"),
		)
	})

	// NOTE: A local declaration wins the name over an entry that also binds it —
	// the Compiler refuses that entry, so a use of the name resolves to the
	// declaration, and renaming it must not reach into the import block.
	it("should let a declaration of the same name win over an entry", () => {
		let source = [
			"import {",
			'\tvalue from "./Other.es"',
			"}",
			"implementation {",
			"\tconstant value = 1",
			"\tconstant doubled = value",
			"}",
		].join("\n")

		expect(rename(source, { line: 6, column: 21 }, "amount")).toBe(
			[
				"import {",
				'\tvalue from "./Other.es"',
				"}",
				"implementation {",
				"\tconstant amount = 1",
				"\tconstant doubled = amount",
				"}",
			].join("\n"),
		)
	})
})
