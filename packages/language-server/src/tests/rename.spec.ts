import { describe, expect, it } from "bun:test"
import { readdirSync, readFileSync } from "node:fs"
import * as path from "node:path"

import { enrich } from "@essence-lang/compiler/enricher"
import { parseWithDiagnostics } from "@essence-lang/compiler/parser"
import {
	forEachParserChild,
	type ParserNode,
} from "@essence-lang/compiler/visitor"
import { FIXTURES_DIRECTORY, fixturePath } from "@essence-lang/fixtures"
import type { common } from "@essence-lang/interfaces"

import {
	findOccurrence as findAnyOccurrence,
	findDefinition,
	findOccurrences,
	findRenameableOccurrence,
	identifierPattern,
	identifierRoles,
	isValidIdentifierName,
	isValidBindingLabelName,
	isValidLabelName,
	renameEdits,
	walkedKinds,
} from "../rename"

function findOccurrence(source: string, cursor: common.Cursor) {
	let { program } = parseWithDiagnostics(source)
	let { program: enrichedProgram } = enrich(program)

	return findRenameableOccurrence(program, cursor, enrichedProgram)
}

// Applies a rename textually, so an expectation can state a whole Program
// rather than a list of Positions.
function rename(source: string, cursor: common.Cursor, newName: string) {
	let occurrence = findOccurrence(source, cursor)

	if (occurrence === null) {
		return null
	}

	let lines = source.split("\n")

	// Applied through `renameEdits`, as the Server applies it, so a shorthand
	// expansion is exercised. One site may write several edits, and a binder
	// added after a Type is an insertion at an empty span.
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
	// A file being edited holds refusals. The name in front of a refused index
	// is an occurrence a reader can see. Skipped, it would name a second thing.
	it("should reach the name a refused index was written on", () => {
		let source = [
			"implementation {",
			"\tconstant primes = [2, 3, 5]",
			"\tconstant first = primes[0]",
			"\tTerminal.print(primes::length())",
			"}",
		].join("\n")

		expect(rename(source, { line: 2, column: 11 }, "numbers")).toBe(
			[
				"implementation {",
				"\tconstant numbers = [2, 3, 5]",
				"\tconstant first = numbers[0]",
				"\tTerminal.print(numbers::length())",
				"}",
			].join("\n"),
		)
	})

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

		// Renaming the Parameter must leave the outer Constant alone.
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

		// And renaming the outer Constant must leave the Parameter alone.
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

	// A Method bounding the Namespace's Parameter mentions it rather than
	// declaring it, so the rename reaches into the Method's `<…>` as well.
	it("should rename a per-Method bound along with the Parameter", () => {
		let source = [
			"implementation {",
			"\tnamespace Boxes<infer Item> for { items: List<Item> } {",
			"\t\tbiggest<Item is Comparable>() -> Optional<Item> {",
			"\t\t\t<- @.items::sort()::lastItem()",
			"\t\t}",
			"\t}",
			"}",
		].join("\n")

		expect(rename(source, { line: 2, column: 24 }, "Held")).toBe(
			[
				"implementation {",
				"\tnamespace Boxes<infer Held> for { items: List<Held> } {",
				"\t\tbiggest<Held is Comparable>() -> Optional<Held> {",
				"\t\t\t<- @.items::sort()::lastItem()",
				"\t\t}",
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

		// The header's `Value` and its use in the payload move together;
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

		// `String` in the Type Annotation, `Terminal` as a value.
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

		// The Parameter, the body and the call site label all rename the same
		// symbol.
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

		// Renaming the internal name never touches the label.
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

		// Renaming the label, from its declaration or the call site, never
		// touches the internal name.
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

	// `using _` binds no name, so only the label is a symbol.
	it("should rename the label of a Parameter that binds no name", () => {
		let source = [
			"implementation {",
			"\tfunction apply (using _: Integer) -> Integer {",
			"\t\t<- 1",
			"\t}",
			"",
			"\tapply(using 1)",
			"\tconstant flat = (on _: Integer) -> Integer { <- 2 }",
			"\tflat(on 3)",
			"}",
		].join("\n")

		let renamed = source.replaceAll("using", "via")

		expect(rename(source, { line: 2, column: 18 }, "via")).toBe(renamed)
		expect(rename(source, { line: 6, column: 8 }, "via")).toBe(renamed)
		expect(rename(source, { line: 8, column: 7 }, "at")).toBe(
			source.replace("(on _", "(at _").replace("(on 3", "(at 3"),
		)
		expect(findOccurrence(source, { line: 2, column: 24 })).toBeNull()
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

		expect(rename(source, { line: 4, column: 20 }, "amount")).toBe(
			[
				"implementation {",
				"\tconstant result = compute(amount 1)",
				"",
				"\tfunction compute (amount: Integer) -> Integer {",
				"\t\t<- amount",
				"\t}",
				"}",
			].join("\n"),
		)
	})

	// One Identifier is both the binding and the call site label, so a rename
	// to `start` would write `compute(start 1)`, a `start` of `1`. The mark picks
	// the stricter of the two rules.
	it("should mark a Parameter whose name doubles as its label", () => {
		let source = [
			"implementation {",
			"\tconstant result = compute(seed 1)",
			"",
			"\tfunction compute (seed: Integer) -> Integer {",
			"\t\t<- seed",
			"\t}",
			"}",
		].join("\n")
		let occurrence = findOccurrence(source, { line: 4, column: 20 })

		expect(occurrence?.declaration.kind).toBe("parameter")
		expect(occurrence?.declaration.labelled).toBe(true)
		expect(isValidBindingLabelName("start")).toBe(false)
		expect(isValidBindingLabelName("complete")).toBe(false)
		expect(isValidBindingLabelName("amount")).toBe(true)
	})

	// A Parameter with a label of its own is two symbols. Renaming the binding
	// never touches a call site, so either word is a name it may take.
	it("should leave a Parameter behind its own label unmarked", () => {
		let source = [
			"implementation {",
			"\tconstant result = compute(of 1)",
			"",
			"\tfunction compute (of seed: Integer) -> Integer {",
			"\t\t<- seed",
			"\t}",
			"}",
		].join("\n")
		let occurrence = findOccurrence(source, { line: 4, column: 23 })

		expect(occurrence?.declaration.kind).toBe("parameter")
		expect(occurrence?.declaration.labelled).toBeUndefined()
	})

	// The grammar reads `with` as an Identifier in label position, as the
	// standard library writes it, so a label may be renamed to it.
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
	// `overload function` is the standard library's form alone, so these parse
	// with its header and rename off the Parser index, as the Server does there.
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

		// From the declaration and from both invocation forms.
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

		// `person` also has a `name`, but its shape is neither a subset nor a
		// superset of `box`, so it stays untouched.
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

	// The typed pass walks a Guard as well as a Handler's body, so a Method
	// invoked only from a Guard renames there too.
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

	it("should rename a Method a checked refinement's predicate calls", () => {
		let source = [
			"implementation {",
			"\tnamespace Checks for Integer {",
			"\t\tisSmall() -> Boolean {",
			"\t\t\t<- @::isLessThan(10)",
			"\t\t}",
			"\t}",
			"",
			"\ttype Small = Integer where @::isSmall()",
			"",
			"\tTerminal.inspect(4::isSmall())",
			"}",
		].join("\n")

		expect(rename(source, { line: 3, column: 4 }, "isTiny")).toBe(
			source.replaceAll("isSmall", "isTiny"),
		)
		expect(rename(source, { line: 8, column: 33 }, "isTiny")).toBe(
			source.replaceAll("isSmall", "isTiny"),
		)
	})

	it("should rename a Case Matcher's payload binding from Matcher, Guard and body", () => {
		// The Case's own member keeps its name, since a payload binding is a
		// local name for the value.
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

	// The Type's members are declared before the literal's, so they are the
	// definitions the literal's members join.
	it("should point a typed Record literal's member at its Type's", () => {
		let source = [
			"implementation {",
			"\tconstant point = { x: Integer, y: Integer } ~> { x = 1, y = 2 }",
			"\tTerminal.inspect(point.x)",
			"}",
		].join("\n")

		expect(definitionOf(source, { line: 3, column: 25 })).toEqual({
			start: { line: 2, column: 21 },
			end: { line: 2, column: 22 },
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
		// `define` opens an Expression, so `constant define = 1` is a syntax
		// error, and so is every line that names it.
		expect(isValidIdentifierName("define")).toBe(false)
	})

	// The asynchrony Keywords are contextual, read as Keywords only in front
	// of an Expression, so a binding may carry either name. The standard library
	// binds `start`.
	it("should accept the two asynchrony Keywords", () => {
		expect(isValidIdentifierName("start")).toBe(true)
		expect(isValidIdentifierName("complete")).toBe(true)
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

	// A label stands directly in front of its value, where the prefix form
	// opens, so `compute(start 1)` is a `start` of `1`. See "Names a rename may
	// write" in packages/language-server/DEVELOPMENT.md.
	it("should refuse the two asynchrony Keywords a binding may take", () => {
		expect(isValidLabelName("start")).toBe(false)
		expect(isValidLabelName("complete")).toBe(false)
		expect(isValidIdentifierName("start")).toBe(true)
	})
})

// A Parameter whose name doubles as its label may take only what both rules
// admit: `with` binds nothing and `start` labels nothing.
describe("isValidBindingLabelName", () => {
	it("should refuse what only a label may be", () => {
		expect(isValidBindingLabelName("with")).toBe(false)
		expect(isValidBindingLabelName("as")).toBe(false)
		expect(isValidBindingLabelName("case")).toBe(false)
		expect(isValidLabelName("with")).toBe(true)
	})

	it("should refuse what only a binding may be", () => {
		expect(isValidBindingLabelName("start")).toBe(false)
		expect(isValidBindingLabelName("complete")).toBe(false)
	})

	it("should accept an ordinary Identifier", () => {
		expect(isValidBindingLabelName("amount")).toBe(true)
		expect(isValidBindingLabelName("Name2")).toBe(true)
	})
})

// What the rename writes must still be the Program it was. Both words read as
// Keywords in front of an Expression, so every result is parsed again.
describe("Rename to an asynchrony Keyword", () => {
	function parsesCleanly(source: string): Array<common.Diagnostic> {
		return parseWithDiagnostics(source).diagnostics
	}

	it("renames a Constant and its reads to `start`", () => {
		let source = [
			"implementation {",
			"\tconstant seed = 1",
			"",
			"\tTerminal.print(seed::toString())",
			"}",
		].join("\n")
		let renamed = rename(source, { line: 2, column: 11 }, "start")

		expect(renamed).toBe(
			[
				"implementation {",
				"\tconstant start = 1",
				"",
				"\tTerminal.print(start::toString())",
				"}",
			].join("\n"),
		)
		expect(parsesCleanly(renamed!)).toEqual([])
	})

	it("renames a Record member and its reads to `complete`", () => {
		let source = [
			"implementation {",
			"\tconstant span = { filled = 1 }",
			"",
			"\tTerminal.print(span.filled::toString())",
			"}",
		].join("\n")
		let renamed = rename(source, { line: 2, column: 20 }, "complete")

		expect(renamed).toBe(
			[
				"implementation {",
				"\tconstant span = { complete = 1 }",
				"",
				"\tTerminal.print(span.complete::toString())",
				"}",
			].join("\n"),
		)
		expect(parsesCleanly(renamed!)).toEqual([])
	})
})

// A provided body is a Method body like any other, so its call to another
// Method of its Protocol is an occurrence of that Method.
const PROVIDED_BODY_CALL = [
	"implementation {",
	"\tprotocol Sizable {",
	"\t\tsize() -> Integer",
	"",
	"\t\tisEmpty() -> Boolean {",
	"\t\t\t<- @::size()::is(0)",
	"\t\t}",
	"",
	"\t\thasItems() -> Boolean {",
	"\t\t\t<- @::isEmpty()::negate()",
	"\t\t}",
	"\t}",
	"",
	"\ttype Bag = { count: Integer }",
	"",
	"\tnamespace Bags for Bag is Sizable {",
	"\t\tsize() -> Integer {",
	"\t\t\t<- @.count",
	"\t\t}",
	"\t}",
	"",
	"\tconstant bag: Bag = { count = 0 }",
	"",
	"\tTerminal.inspect(bag::isEmpty())",
	"}",
].join("\n")

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

	it("should report the call a provided body makes to a provided Method", () => {
		let occurrence = occurrencesOf(PROVIDED_BODY_CALL, {
			line: 24,
			column: 24,
		})

		expect(
			occurrence?.declaration.occurrences.map((site) => [
				site.position.start.line,
				site.position.start.column,
			]),
		).toEqual([
			[5, 3],
			[10, 10],
			[24, 24],
		])
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

	// Document Highlight falls back to this where the workspace join has no
	// symbol, as for a builtin, so builtins highlight as References finds them.
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

	it("should highlight the call a provided body makes to a provided Method", () => {
		let occurrences = occurrencesOf(PROVIDED_BODY_CALL, {
			line: 10,
			column: 10,
		})

		expect(
			occurrences.map((occurrence) => [
				occurrence.position.start.line,
				occurrence.access,
			]),
		).toEqual([
			[5, "write"],
			[10, "read"],
			[24, "read"],
		])
	})
})

describe("identifierPattern", () => {
	// Editors get this as a word pattern, so it has to agree with
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

		it("should rename a Protocol through an extension list", () => {
			let source = [
				"implementation {",
				"\tprotocol Sizable {",
				"\t\tsize() -> Integer",
				"\t}",
				"\tprotocol Listed is Sizable {",
				"\t\tfirst() -> Integer",
				"\t}",
				"}",
			].join("\n")

			expect(rename(source, { line: 5, column: 22 }, "Measurable")).toBe(
				source.replaceAll("Sizable", "Measurable"),
			)
		})

		// Declared inside the body, since a provided Method may not read what
		// the Program declares around it.
		it("should rename a Constant a provided Method's body reads", () => {
			let source = [
				"implementation {",
				"\tprotocol Sizable {",
				"\t\tsize() -> Integer",
				"",
				"\t\tdoubled() -> Integer {",
				"\t\t\tconstant unit = 2",
				"",
				"\t\t\t<- @::size()::multiply(with unit)",
				"\t\t}",
				"\t}",
				"}",
			].join("\n")

			expect(rename(source, { line: 6, column: 13 }, "step")).toBe(
				source.replaceAll("unit", "step"),
			)
		})

		// A provided Method is a Method of every conformer, so a rename asked at
		// a call moves the Protocol's declaration and every other call. The call
		// resolves through the Protocol's members.
		const SIZABLE = [
			"implementation {",
			"\tprotocol Sizable {",
			"\t\tsize() -> Integer",
			"",
			"\t\tisEmpty() -> Boolean {",
			"\t\t\t<- @::size()::is(0)",
			"\t\t}",
			"\t}",
			"",
			"\ttype Bag = { count: Integer }",
			"",
			"\tnamespace Bags for Bag is Sizable {",
			"\t\tsize() -> Integer {",
			"\t\t\t<- @.count",
			"\t\t}",
			"\t}",
			"",
			"\tconstant bag: Bag = { count = 0 }",
			"",
			"\tTerminal.inspect(bag::isEmpty())",
			"\tTerminal.inspect(Bags.isEmpty(bag))",
			"}",
		].join("\n")

		it("should rename a provided Method from its declaration", () => {
			expect(rename(SIZABLE, { line: 5, column: 3 }, "vacant")).toBe(
				SIZABLE.replaceAll("isEmpty", "vacant"),
			)
		})

		it("should rename a provided Method from a call site", () => {
			expect(rename(SIZABLE, { line: 20, column: 24 }, "vacant")).toBe(
				SIZABLE.replaceAll("isEmpty", "vacant"),
			)
		})

		// The Namespace spelling reads the same Method off the conforming
		// Namespace, so it moves with the rest.
		it("should rename a provided Method from its Namespace spelling", () => {
			expect(rename(SIZABLE, { line: 21, column: 24 }, "vacant")).toBe(
				SIZABLE.replaceAll("isEmpty", "vacant"),
			)
		})

		it("should rename the call a provided body makes to a provided Method", () => {
			expect(
				rename(PROVIDED_BODY_CALL, { line: 5, column: 3 }, "vacant"),
			).toBe(PROVIDED_BODY_CALL.replaceAll("isEmpty", "vacant"))
		})

		it("should rename a provided Method from a call inside a provided body", () => {
			expect(
				rename(PROVIDED_BODY_CALL, { line: 10, column: 10 }, "vacant"),
			).toBe(PROVIDED_BODY_CALL.replaceAll("isEmpty", "vacant"))
		})

		it("should not rename a builtin Protocol's provided Method", () => {
			let source = [
				"implementation {",
				"\tTerminal.inspect(1::isNot(2))",
				"}",
			].join("\n")

			expect(findOccurrence(source, { line: 2, column: 21 })).toBeNull()
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

		// The member is declared in the standard library, which no rename
		// reaches, so renaming the Method alone would break the conformance.
		// `Boxes` conforms through an extension.
		it("should not rename a Method that answers a builtin Protocol's member", () => {
			let source = [
				"implementation {",
				"\tprotocol Showable is Printable {",
				"\t\tdescribe() -> String",
				"\t}",
				"",
				"\ttype Bag = { count: Integer }",
				"",
				"\tnamespace Bags for Bag is Printable {",
				"\t\ttoString() -> String {",
				'\t\t\t<- "bag"',
				"\t\t}",
				"\t}",
				"",
				"\ttype Box = { count: Integer }",
				"",
				"\tnamespace Boxes for Box is Showable {",
				"\t\ttoString() -> String {",
				'\t\t\t<- "box"',
				"\t\t}",
				"",
				"\t\tdescribe() -> String {",
				'\t\t\t<- "a box"',
				"\t\t}",
				"\t}",
				"",
				"\tconstant bag: Bag = { count = 0 }",
				"",
				"\tTerminal.inspect(bag::toString())",
				"}",
			].join("\n")

			expect(findOccurrence(source, { line: 9, column: 3 })).toBeNull()
			expect(findOccurrence(source, { line: 17, column: 3 })).toBeNull()
			expect(findOccurrence(source, { line: 28, column: 24 })).toBeNull()
			expect(
				findOccurrence(source, { line: 21, column: 3 }),
			).not.toBeNull()
		})

		// Every JavaScript object carries `toString` and `valueOf`, but
		// `Equatable` declares neither.
		it("should rename a Method that a builtin Protocol it conforms to does not declare", () => {
			let source = [
				"implementation {",
				"\ttype Bag = { count: Integer }",
				"",
				"\tnamespace Bags for Bag is Equatable {",
				"\t\tis(_ other: Bag) -> Boolean {",
				"\t\t\t<- @.count::is(other.count)",
				"\t\t}",
				"",
				"\t\ttoString() -> String {",
				'\t\t\t<- "bag"',
				"\t\t}",
				"",
				"\t\tvalueOf() -> Integer {",
				"\t\t\t<- @.count",
				"\t\t}",
				"\t}",
				"",
				"\tconstant bag: Bag = { count = 0 }",
				"",
				"\tTerminal.inspect(bag::toString())",
				"\tTerminal.inspect(bag::valueOf())",
				"}",
			].join("\n")

			expect(rename(source, { line: 9, column: 3 }, "describe")).toBe(
				source.replaceAll("toString", "describe"),
			)
			expect(rename(source, { line: 13, column: 3 }, "total")).toBe(
				source.replaceAll("valueOf", "total"),
			)
			expect(findOccurrence(source, { line: 5, column: 3 })).toBeNull()
		})

		// A requirement and its conformers' Methods rename as one. `Pairs`
		// conforms through an extension, and `measure` and the provided body
		// call through a bounded Type.
		const REQUIREMENTS = [
			"implementation {",
			"\tprotocol Sizable {",
			"\t\tsize() -> Integer",
			"\t\tstatic empty() -> Self",
			"",
			"\t\tisEmpty() -> Boolean {",
			"\t\t\t<- @::size()::is(0)",
			"\t\t}",
			"\t}",
			"",
			"\tprotocol Listed is Sizable {",
			"\t\tfirst() -> Integer",
			"\t}",
			"",
			"\ttype Bag = { count: Integer }",
			"",
			"\tnamespace Bags for Bag is Sizable {",
			"\t\tsize() -> Integer {",
			"\t\t\t<- @.count",
			"\t\t}",
			"",
			"\t\tstatic empty() -> Bag {",
			"\t\t\t<- { count = 0 }",
			"\t\t}",
			"",
			"\t\tisEmpty() -> Boolean {",
			"\t\t\t<- @.count::is(0)",
			"\t\t}",
			"\t}",
			"",
			"\ttype Pair = { left: Integer, right: Integer }",
			"",
			"\tnamespace Pairs for Pair is Listed {",
			"\t\tsize() -> Integer {",
			"\t\t\t<- 2",
			"\t\t}",
			"",
			"\t\tstatic empty() -> Pair {",
			"\t\t\t<- { left = 0, right = 0 }",
			"\t\t}",
			"",
			"\t\tfirst() -> Integer {",
			"\t\t\t<- @.left",
			"\t\t}",
			"\t}",
			"",
			"\tfunction measure <infer Value is Listed>(_ value: Value) -> Integer {",
			"\t\t<- value::size()::add(Value.empty()::size())",
			"\t}",
			"",
			"\tconstant bag: Bag = { count = 0 }",
			"",
			"\tTerminal.inspect(bag::size())",
			"\tTerminal.inspect(Bags.size(bag))",
			"\tTerminal.inspect(bag::isEmpty())",
			"\tTerminal.inspect(measure({ left = 1, right = 2 }))",
			"}",
		].join("\n")

		it("should rename every conformer's implementation with a requirement", () => {
			expect(rename(REQUIREMENTS, { line: 3, column: 3 }, "extent")).toBe(
				REQUIREMENTS.replaceAll("size", "extent"),
			)
		})

		it("should rename a requirement from a conformer's implementation", () => {
			expect(
				rename(REQUIREMENTS, { line: 18, column: 3 }, "extent"),
			).toBe(REQUIREMENTS.replaceAll("size", "extent"))
			expect(
				rename(REQUIREMENTS, { line: 34, column: 3 }, "extent"),
			).toBe(REQUIREMENTS.replaceAll("size", "extent"))
		})

		it("should rename a requirement from a call through a bounded Type", () => {
			expect(
				rename(REQUIREMENTS, { line: 48, column: 13 }, "extent"),
			).toBe(REQUIREMENTS.replaceAll("size", "extent"))
			expect(
				rename(REQUIREMENTS, { line: 7, column: 10 }, "extent"),
			).toBe(REQUIREMENTS.replaceAll("size", "extent"))
		})

		it("should rename a static requirement with its conformers and a bounded Type's call", () => {
			expect(rename(REQUIREMENTS, { line: 4, column: 10 }, "blank")).toBe(
				REQUIREMENTS.replaceAll("empty", "blank"),
			)
			expect(
				rename(REQUIREMENTS, { line: 48, column: 31 }, "blank"),
			).toBe(REQUIREMENTS.replaceAll("empty", "blank"))
		})

		// Left behind, the override would stop overriding, and every call
		// through `Sizable` would run the provided body.
		it("should rename a conformer's override of a provided Method with it", () => {
			expect(rename(REQUIREMENTS, { line: 6, column: 3 }, "vacant")).toBe(
				REQUIREMENTS.replaceAll("isEmpty", "vacant"),
			)
			expect(
				rename(REQUIREMENTS, { line: 55, column: 24 }, "vacant"),
			).toBe(REQUIREMENTS.replaceAll("isEmpty", "vacant"))
		})

		it("should rename an overloaded requirement with every Overload a conformer writes", () => {
			let source = [
				"implementation {",
				"\tprotocol Growable {",
				"\t\toverload grow {",
				"\t\t\t(_ other: Self) -> Self",
				"\t\t\t(by amount: Integer) -> Self",
				"\t\t}",
				"\t}",
				"",
				"\ttype Bag = { count: Integer }",
				"",
				"\tnamespace Bags for Bag is Growable {",
				"\t\toverload grow {",
				"\t\t\t(_ other: Bag) -> Bag {",
				"\t\t\t\t<- { count = @.count::add(other.count) }",
				"\t\t\t}",
				"",
				"\t\t\t(by amount: Integer) -> Bag {",
				"\t\t\t\t<- { count = @.count::add(amount) }",
				"\t\t\t}",
				"\t\t}",
				"\t}",
				"",
				"\tfunction twice <infer Value is Growable>(_ value: Value) -> Value {",
				"\t\t<- value::grow(value)::grow(by 1)",
				"\t}",
				"",
				"\tconstant bag: Bag = { count = 1 }",
				"",
				"\tTerminal.inspect(bag::grow(by 2))",
				"\tTerminal.inspect(twice(bag))",
				"}",
			].join("\n")

			expect(rename(source, { line: 3, column: 12 }, "enlarge")).toBe(
				source.replaceAll("grow", "enlarge"),
			)
			expect(rename(source, { line: 29, column: 24 }, "enlarge")).toBe(
				source.replaceAll("grow", "enlarge"),
			)
		})

		it("should leave a same-named Method of a Namespace that does not conform alone", () => {
			let source = [
				"implementation {",
				"\tprotocol Sizable {",
				"\t\tsize() -> Integer",
				"\t}",
				"",
				"\ttype Bag = { count: Integer }",
				"",
				"\tnamespace Bags for Bag is Sizable {",
				"\t\tsize() -> Integer {",
				"\t\t\t<- @.count",
				"\t\t}",
				"\t}",
				"",
				"\tnamespace Unrelated for Integer {",
				"\t\tsize() -> Integer {",
				"\t\t\t<- @",
				"\t\t}",
				"\t}",
				"",
				"\tTerminal.inspect(3::size())",
				"}",
			].join("\n")

			let lines = source.split("\n")
			let renamedAt = (renamed: Array<number>) =>
				lines
					.map((line, index) =>
						renamed.includes(index + 1)
							? line.replace("size", "extent")
							: line,
					)
					.join("\n")

			expect(rename(source, { line: 3, column: 3 }, "extent")).toBe(
				renamedAt([3, 9]),
			)
			expect(rename(source, { line: 15, column: 3 }, "extent")).toBe(
				renamedAt([15, 20]),
			)
		})

		// The `Sized` declared in `inner` shadows the top-level one and is
		// another Protocol, so each requirement renames with its own conformer
		// and bounded call alone.
		it("should keep a Protocol declared in a body apart from one of its name", () => {
			let source = [
				"implementation {",
				"\tprotocol Sized {",
				"\t\tsize() -> Integer",
				"\t}",
				"",
				"\tnamespace IntegerSized for Integer is Sized {",
				"\t\tsize() -> Integer {",
				"\t\t\t<- @",
				"\t\t}",
				"\t}",
				"",
				"\tfunction inner() -> Integer {",
				"\t\tprotocol Sized {",
				"\t\t\tsize() -> Integer",
				"\t\t}",
				"",
				"\t\tnamespace StringSized for String is Sized {",
				"\t\t\tsize() -> Integer {",
				"\t\t\t\t<- 1",
				"\t\t\t}",
				"\t\t}",
				"",
				"\t\tfunction gauge <infer Item is Sized>(_ item: Item) -> Integer {",
				"\t\t\t<- item::size()",
				"\t\t}",
				"",
				'\t\t<- gauge("a")',
				"\t}",
				"",
				"\tfunction outer <infer Item is Sized>(_ item: Item) -> Integer {",
				"\t\t<- item::size()",
				"\t}",
				"",
				"\tTerminal.inspect(outer(3)::add(inner()))",
				"}",
			].join("\n")

			let lines = source.split("\n")
			let renamedAt = (renamed: Array<number>) =>
				lines
					.map((line, index) =>
						renamed.includes(index + 1)
							? line.replace("size", "extent")
							: line,
					)
					.join("\n")

			expect(rename(source, { line: 3, column: 3 }, "extent")).toBe(
				renamedAt([3, 7, 31]),
			)
			expect(rename(source, { line: 14, column: 4 }, "extent")).toBe(
				renamedAt([14, 18, 24]),
			)
		})

		// Each Function declares its own `Tagged` and its own
		// `IntegerTagged`, and a Method of one is no Method of the other.
		it("should keep same-named Namespaces two bodies declare apart", () => {
			let declaring = (name: string, value: string) => [
				`\tfunction ${name}() -> Integer {`,
				"\t\tprotocol Tagged {",
				"\t\t\ttag() -> Integer",
				"\t\t}",
				"",
				"\t\tnamespace IntegerTagged for Integer is Tagged {",
				"\t\t\ttag() -> Integer {",
				`\t\t\t\t<- ${value}`,
				"\t\t\t}",
				"\t\t}",
				"",
				"\t\tfunction read <infer Item is Tagged>(_ item: Item) -> Integer {",
				"\t\t\t<- item::tag()",
				"\t\t}",
				"",
				"\t\t<- read(3)::add(IntegerTagged.tag(4))",
				"\t}",
				"",
			]
			let source = [
				"implementation {",
				...declaring("one", "@"),
				...declaring("two", "1"),
				"\tTerminal.inspect(one()::add(two()))",
				"}",
			].join("\n")

			let lines = source.split("\n")
			let renamedAt = (renamed: Array<number>) =>
				lines
					.map((line, index) =>
						renamed.includes(index + 1)
							? line.replaceAll("tag(", "label(")
							: line,
					)
					.join("\n")

			expect(rename(source, { line: 8, column: 4 }, "label")).toBe(
				renamedAt([4, 8, 14, 17]),
			)
			expect(rename(source, { line: 35, column: 33 }, "label")).toBe(
				renamedAt([22, 26, 32, 35]),
			)
		})

		// The top level call stands above the Namespace it reaches, and a
		// body declares another of that name.
		it("should bind a call above its Namespace past a body's same-named one", () => {
			let source = [
				"implementation {",
				"\tTerminal.inspect(3::tag()::add(Tags.tag(4)))",
				"",
				"\tfunction inner() -> Integer {",
				"\t\tnamespace Tags for String {",
				"\t\t\ttag() -> Integer {",
				"\t\t\t\t<- 1",
				"\t\t\t}",
				"\t\t}",
				"",
				'\t\t<- "a"::tag()::add(Tags.tag("b"))',
				"\t}",
				"",
				"\tnamespace Tags for Integer {",
				"\t\ttag() -> Integer {",
				"\t\t\t<- @",
				"\t\t}",
				"\t}",
				"}",
			].join("\n")

			let lines = source.split("\n")
			let renamedAt = (renamed: Array<number>) =>
				lines
					.map((line, index) =>
						renamed.includes(index + 1)
							? line.replaceAll("tag(", "label(")
							: line,
					)
					.join("\n")

			expect(rename(source, { line: 2, column: 22 }, "label")).toBe(
				renamedAt([2, 15]),
			)
			expect(rename(source, { line: 6, column: 4 }, "label")).toBe(
				renamedAt([6, 11]),
			)
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

// A Pattern's bare member names the Record's member and the local it binds,
// so renaming either end spells the other out beside it. See "Shorthand
// edits" in packages/language-server/DEVELOPMENT.md.
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
		// Started from the Record literal, since a cursor on the binder finds
		// the local first.
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

	// The desugared Lookup reaches the binder again after many reads of the
	// member, and is still the same site.
	it("expands a shorthand binder once for a member read many times", () => {
		let reads = Array.from({ length: 20 }, () => "box.width").join(", ")
		let source = [
			"implementation {",
			"\tconstant box = { width = 1, height = 2 }",
			`\tconstant widths = [${reads}]`,
			"\tconstant { width, height } = box",
			"",
			"\tTerminal.print(width::add(height))",
			"}",
		].join("\n")

		expect(rename(source, { line: 2, column: 19 }, "breadth")).toBe(
			source
				.replace("{ width = 1,", "{ breadth = 1,")
				.replaceAll("box.width", "box.breadth")
				.replace("{ width, height }", "{ breadth as width, height }"),
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

	// `as` separates a member from the name it binds under, so a binder
	// renamed to it would read as the separator.
	it("refuses 'as' as a rename target", () => {
		expect(isValidIdentifierName("as")).toBe(false)
	})

	// The grammar is `Identifier ":" Type "as" Binder`, so the binder goes
	// after the Type. `{ breadth as width: Integer }` is not a Pattern.
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

	// Every step of a spine carries the span it was written at, so renaming
	// the outer member leaves the inner binders alone.
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

	// A Guard's use of a binding lowers to an indexed Lookup off `@`. Its
	// member step must not carry the use's span, or renaming the member would
	// overwrite the Guard's own Identifier.
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

	// An annotation inside a nested Pattern is a Type reference like any
	// other, and one left out of the index would dangle.
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

// A Record Literal's bare member writes the member and reads a value with one
// Identifier, so renaming either end spells the other out beside it. See
// "Shorthand edits" in packages/language-server/DEVELOPMENT.md.
describe("Rename with Record shorthand", () => {
	const source = [
		"implementation {",
		"\ttype Point = { x: Integer, y: Integer }",
		"",
		"\tconstant x = 1",
		"\tconstant y = 2",
		"",
		"\tconstant point: Point = { x, y }",
		"",
		"\tTerminal.print(point.x::add(point.y))",
		"}",
	].join("\n")

	it("expands a shorthand member when the VALUE is renamed", () => {
		expect(rename(source, { line: 7, column: 28 }, "across")).toBe(
			[
				"implementation {",
				"\ttype Point = { x: Integer, y: Integer }",
				"",
				"\tconstant across = 1",
				"\tconstant y = 2",
				"",
				"\tconstant point: Point = { x = across, y }",
				"",
				"\tTerminal.print(point.x::add(point.y))",
				"}",
			].join("\n"),
		)
	})

	it("expands a shorthand member the other way when the MEMBER is renamed", () => {
		// Started from the Type, since a cursor on the member finds the value
		// first, as it finds a Pattern's local first.
		expect(rename(source, { line: 2, column: 17 }, "across")).toBe(
			[
				"implementation {",
				"\ttype Point = { across: Integer, y: Integer }",
				"",
				"\tconstant x = 1",
				"\tconstant y = 2",
				"",
				"\tconstant point: Point = { across = x, y }",
				"",
				"\tTerminal.print(point.across::add(point.y))",
				"}",
			].join("\n"),
		)
	})

	// The rename starts at another use of the value, far from the shorthand,
	// and the shorthand still expands.
	it("expands from a use of the value elsewhere in the file", () => {
		let elsewhere = [
			"implementation {",
			"\tconstant width = 1",
			"",
			"\tconstant box = { width }",
			"",
			"\tTerminal.print(width::add(box.width))",
			"}",
		].join("\n")

		expect(rename(elsewhere, { line: 6, column: 17 }, "measure")).toBe(
			[
				"implementation {",
				"\tconstant measure = 1",
				"",
				"\tconstant box = { width = measure }",
				"",
				"\tTerminal.print(measure::add(box.width))",
				"}",
			].join("\n"),
		)
	})

	it("renames a member that spelled its value without expanding anything", () => {
		let written = [
			"implementation {",
			"\tconstant width = 1",
			"",
			"\tconstant box = { width = width }",
			"",
			"\tTerminal.print(box.width)",
			"}",
		].join("\n")

		expect(rename(written, { line: 4, column: 27 }, "measure")).toBe(
			[
				"implementation {",
				"\tconstant measure = 1",
				"",
				"\tconstant box = { width = measure }",
				"",
				"\tTerminal.print(box.width)",
				"}",
			].join("\n"),
		)
	})

	// The two ends stay two symbols at one Position, so highlighting the value
	// does not light up the member's other sites.
	it("keeps the member and the value apart in Document Highlight", () => {
		let { program } = parseWithDiagnostics(source)
		let { program: enrichedProgram } = enrich(program)

		let occurrences = findOccurrences(
			program,
			{ line: 7, column: 28 },
			enrichedProgram,
		)

		expect(
			occurrences.map((occurrence) => occurrence.position.start.line),
		).toEqual([4, 7])
	})

	// A shorthand inside an update's braced right-hand side is a Record
	// Literal like any other. A bare key list cannot hold one.
	it("expands a shorthand inside an update's braced right-hand side", () => {
		let merged = [
			"implementation {",
			"\tconstant port = 8080",
			"",
			'\tconstant base = { host = "local", port = 80 }',
			"\tconstant moved = { base with { port } }",
			"",
			"\tTerminal.print(moved.port)",
			"}",
		].join("\n")

		expect(rename(merged, { line: 2, column: 11 }, "chosen")).toBe(
			[
				"implementation {",
				"\tconstant chosen = 8080",
				"",
				'\tconstant base = { host = "local", port = 80 }',
				"\tconstant moved = { base with { port = chosen } }",
				"",
				"\tTerminal.print(moved.port)",
				"}",
			].join("\n"),
		)
	})
})

// One file's own view of the Module sections: an entry binds a name, its uses
// resolve to it, and an export entry reads its declaration. `workspace.spec.ts`
// covers what crosses files.
describe("Rename through the Module sections", () => {
	it("should rename an import entry together with every use of it", () => {
		let source = [
			"import {",
			'\tfrom "./Geometry.es" { Rectangle }',
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
			'\tfrom "./Math.es" { square }',
			"}",
			"implementation {",
			"\tconstant nine = square(3)",
			"}",
		].join("\n")

		expect(rename(source, { line: 2, column: 22 }, "squared")).toBe(
			source.replaceAll("square", "squared"),
		)
	})

	// An aliased entry binds the alias alone. The name before the `as` is what
	// the exporting Module publishes.
	it("should bind an aliased import under its alias alone", () => {
		let source = [
			"import {",
			'\tfrom "./Math.es" { PI as Pi }',
			"}",
			"implementation {",
			"\tconstant doubled = Pi::multiply(with 2/1)",
			"}",
		].join("\n")

		expect(rename(source, { line: 5, column: 22 }, "Ratio")).toBe(
			[
				"import {",
				'\tfrom "./Math.es" { PI as Ratio }',
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

	// The Compiler refuses an entry that a local declaration also binds. A use
	// resolves to the declaration, and the rename stays out of the import block.
	it("should let a declaration of the same name win over an entry", () => {
		let source = [
			"import {",
			'\tfrom "./Other.es" { value }',
			"}",
			"implementation {",
			"\tconstant value = 1",
			"\tconstant doubled = value",
			"}",
		].join("\n")

		expect(rename(source, { line: 6, column: 21 }, "amount")).toBe(
			[
				"import {",
				'\tfrom "./Other.es" { value }',
				"}",
				"implementation {",
				"\tconstant amount = 1",
				"\tconstant doubled = amount",
				"}",
			].join("\n"),
		)
	})
})

// A default is an Expression written outside every body, so a walk of bodies
// alone would leave the occurrence inside `= …` behind.
describe("Rename of a name a default reads", () => {
	it("renames a module Constant read by a default", () => {
		let source = [
			"implementation {",
			"\tconstant fallback = 1",
			"",
			"\tfunction scaled(_ factor: Integer = fallback) -> Integer {",
			"\t\t<- factor",
			"\t}",
			"}",
		].join("\n")

		expect(rename(source, { line: 2, column: 11 }, "base")).toBe(
			[
				"implementation {",
				"\tconstant base = 1",
				"",
				"\tfunction scaled(_ factor: Integer = base) -> Integer {",
				"\t\t<- factor",
				"\t}",
				"}",
			].join("\n"),
		)
	})

	// A default sees the Parameters before it, so one of them can be renamed
	// from inside it.
	it("renames a Parameter a later default reads", () => {
		let source = [
			"implementation {",
			"\tfunction pick(_ first: Integer, to second: Integer = first) -> Integer {",
			"\t\t<- second",
			"\t}",
			"}",
		].join("\n")

		expect(rename(source, { line: 2, column: 55 }, "start")).toBe(
			[
				"implementation {",
				"\tfunction pick(_ start: Integer, to second: Integer = start) -> Integer {",
				"\t\t<- second",
				"\t}",
				"}",
			].join("\n"),
		)
	})
})

// A Method or a Record member resolves only in the typed pass, which has to
// look inside a Case value's payload.
describe("Rename of a name a Case payload reads", () => {
	let source = [
		"implementation {",
		"\tchoice Tank {",
		"\t\tFull { level: Integer },",
		"\t\tEmpty,",
		"\t}",
		"",
		"\tnamespace Gauge for Integer {",
		"\t\tdoubled() -> Integer {",
		"\t\t\t<- @::multiply(with 2)",
		"\t\t}",
		"\t}",
		"",
		"\tconstant reading = { amount = 3 }",
		"\tconstant first: Tank = #Full(reading.amount::doubled())",
		"\tconstant second: Tank = #Full({ level = 3::doubled() })",
		"}",
	].join("\n")

	it("renames a Method called inside a payload", () => {
		expect(rename(source, { line: 8, column: 3 }, "twice")).toBe(
			[
				"implementation {",
				"\tchoice Tank {",
				"\t\tFull { level: Integer },",
				"\t\tEmpty,",
				"\t}",
				"",
				"\tnamespace Gauge for Integer {",
				"\t\ttwice() -> Integer {",
				"\t\t\t<- @::multiply(with 2)",
				"\t\t}",
				"\t}",
				"",
				"\tconstant reading = { amount = 3 }",
				"\tconstant first: Tank = #Full(reading.amount::twice())",
				"\tconstant second: Tank = #Full({ level = 3::twice() })",
				"}",
			].join("\n"),
		)
	})

	it("renames a Record member read inside a payload", () => {
		expect(rename(source, { line: 13, column: 23 }, "volume")).toBe(
			[
				"implementation {",
				"\tchoice Tank {",
				"\t\tFull { level: Integer },",
				"\t\tEmpty,",
				"\t}",
				"",
				"\tnamespace Gauge for Integer {",
				"\t\tdoubled() -> Integer {",
				"\t\t\t<- @::multiply(with 2)",
				"\t\t}",
				"\t}",
				"",
				"\tconstant reading = { volume = 3 }",
				"\tconstant first: Tank = #Full(reading.volume::doubled())",
				"\tconstant second: Tank = #Full({ level = 3::doubled() })",
				"}",
			].join("\n"),
		)
	})
})

// The Enricher refuses a name as a predicate's Argument, and the read must
// still be found, or a rename leaves it naming nothing.
describe("Rename of a name a refinement's predicate reads", () => {
	it("renames a Constant read by a predicate", () => {
		let source = [
			"implementation {",
			"\tconstant limit = 10",
			"",
			"\ttype Small = Integer where @::isLessThan(limit)",
			"}",
		].join("\n")

		expect(rename(source, { line: 2, column: 11 }, "bound")).toBe(
			[
				"implementation {",
				"\tconstant bound = 10",
				"",
				"\ttype Small = Integer where @::isLessThan(bound)",
				"}",
			].join("\n"),
		)
	})
})

// A Case payload's `= { … }` is written outside every body too.
describe("Rename of a name a Case payload default reads", () => {
	it("renames a module Constant read by a payload default", () => {
		let source = [
			"implementation {",
			"\tconstant none = 0",
			"",
			"\tchoice Fetch {",
			"\t\tGet { url: String, retries: Integer } = { retries = none },",
			"\t}",
			"}",
		].join("\n")

		expect(rename(source, { line: 2, column: 11 }, "zero")).toBe(
			[
				"implementation {",
				"\tconstant zero = 0",
				"",
				"\tchoice Fetch {",
				"\t\tGet { url: String, retries: Integer } = { retries = zero },",
				"\t}",
				"}",
			].join("\n"),
		)
	})

	// Renamed from inside the default, which works only if the walk bound the
	// occurrence there.
	it("renames from the occurrence inside the default", () => {
		let source = [
			"implementation {",
			"\tconstant none = 0",
			"",
			"\tchoice Fetch {",
			"\t\tGet { url: String, retries: Integer } = { retries = none },",
			"\t}",
			"}",
		].join("\n")

		expect(rename(source, { line: 5, column: 56 }, "zero")).toBe(
			[
				"implementation {",
				"\tconstant zero = 0",
				"",
				"\tchoice Fetch {",
				"\t\tGet { url: String, retries: Integer } = { retries = zero },",
				"\t}",
				"}",
			].join("\n"),
		)
	})
})

// A path is indexed off the Lookups the Enricher synthesizes for it, each
// at the span of its step. Rename relies on that, so it is pinned from both
// ends.
describe("member paths", () => {
	let source = [
		"implementation {",
		"\ttype Product = { name: String, price: Integer }",
		"\tconstant products: List<Product> = []",
		"\tconstant prices = products::map(.price)",
		"}",
	].join("\n")

	let renamed = [
		"implementation {",
		"\ttype Product = { name: String, cost: Integer }",
		"\tconstant products: List<Product> = []",
		"\tconstant prices = products::map(.cost)",
		"}",
	].join("\n")

	it("renames the member a path spells", () => {
		expect(rename(source, { line: 4, column: 35 }, "cost")).toBe(renamed)
	})

	it("reaches a path from the member's declaration", () => {
		expect(rename(source, { line: 2, column: 33 }, "cost")).toBe(renamed)
	})
})

// Every step of a dotted key is a member occurrence. The first is a key of
// the written list, the middle ones are synthesized Lookups at the steps'
// spans, and `memberPositions` carries the last.
describe("path keys", () => {
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

	it("renames the first step", () => {
		expect(rename(source, { line: 10, column: 32 }, "listener")).toBe(
			source.replaceAll("server", "listener"),
		)
	})

	it("renames a step in the middle", () => {
		expect(rename(source, { line: 10, column: 39 }, "security")).toBe(
			source
				.replace("tls: Tls }", "security: Tls }")
				.replace("tls = { enabled", "security = { enabled")
				.replace("server.tls.enabled", "server.security.enabled"),
		)
	})

	it("renames the last step", () => {
		expect(rename(source, { line: 10, column: 43 }, "on")).toBe(
			source.replaceAll("enabled", "on"),
		)
	})

	it("reaches a path key from the member's declaration", () => {
		expect(rename(source, { line: 2, column: 15 }, "on")).toBe(
			source.replaceAll("enabled", "on"),
		)
	})

	// A braced descend's keys are a written list the lexical walk sees, and
	// a path inside it goes on through the Lookups the desugar wrote.
	it("renames a member a braced descend writes", () => {
		let descended = [
			"implementation {",
			"\ttype Tls = { enabled: Boolean }",
			"\ttype Server = { host: String, port: Integer, tls: Tls }",
			"\ttype Config = { name: String, server: Server }",
			"",
			"\tconstant config: Config = {",
			'\t\tname = "api",',
			'\t\tserver = { host = "h", port = 80, tls = { enabled = false } },',
			"\t}",
			"\tconstant deep = { config with server.{ tls.{ enabled = true } } }",
			"}",
		].join("\n")

		expect(rename(descended, { line: 10, column: 47 }, "on")).toBe(
			descended.replaceAll("enabled", "on"),
		)
	})

	// The update's first step is reached twice, after the member's sites
	// outgrew a scan, and is still one site.
	it("renames an update's key once after the member is written many times", () => {
		let written = [
			"implementation {",
			...Array.from(
				{ length: 17 },
				(_, index) =>
					`\tconstant config${index} = { server = { port = ${index} }, name = "x" }`,
			),
			"\tconstant moved = { config0 with server.port = 2 }",
			"",
			"\tTerminal.inspect(moved.server.port)",
			"}",
		].join("\n")

		expect(rename(written, { line: 2, column: 23 }, "host")).toBe(
			written.replaceAll("server", "host"),
		)
	})

	// A bare path key is refused, and its last step is also the value it
	// reads. Renaming either end spells the other out, as a shorthand does.
	describe("written bare", () => {
		let bare = [
			"implementation {",
			"\ttype Server = { host: String, port: Integer }",
			"\ttype Config = { name: String, server: Server }",
			"",
			"\tconstant port = 8080",
			'\tconstant config: Config = { name = "a", server = { host = "h", port = 80 } }',
			'\tconstant moved = { config with server.port, name = "b" }',
			"}",
		].join("\n")

		it("keeps the key when the value is renamed", () => {
			expect(rename(bare, { line: 5, column: 11 }, "chosen")).toBe(
				bare
					.replace("constant port", "constant chosen")
					.replace("server.port,", "server.port = chosen,"),
			)
		})

		it("keeps the value when the member is renamed", () => {
			expect(rename(bare, { line: 2, column: 32 }, "chosen")).toBe(
				bare
					.replace("port: Integer", "chosen: Integer")
					.replace("port = 80 }", "chosen = 80 }")
					.replace("server.port,", "server.chosen = port,"),
			)
		})

		it("keeps the key in an Argument merged into a default", () => {
			let merged = [
				"implementation {",
				"\ttype Server = { host: String, port: Integer }",
				"\ttype Config = { server: Server }",
				"",
				"\t§§ Answers the host.",
				"\t§§",
				"\t§§ @param using — where to connect.",
				"\t§§ @returns — the host.",
				"\tfunction connect(",
				'\t\tusing config: Config = { server = { host = "h", port = 80 } },',
				"\t) -> String {",
				"\t\t<- config.server.host",
				"\t}",
				"",
				"\tconstant port = 8080",
				"\tconstant moved = connect(using { server.port })",
				"}",
			].join("\n")

			expect(rename(merged, { line: 15, column: 11 }, "chosen")).toBe(
				merged
					.replace("constant port", "constant chosen")
					.replace("server.port }", "server.port = chosen }"),
			)
		})
	})

	// An Argument merged into a default has path keys but no synthesized
	// Lookups, so `memberPositions` alone carries every step after the
	// first.
	describe("in an Argument merged into a default", () => {
		let merged = [
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

		it("renames the first step", () => {
			expect(rename(merged, { line: 19, column: 34 }, "listener")).toBe(
				merged.replaceAll("server", "listener"),
			)
		})

		it("renames a step in the middle", () => {
			expect(rename(merged, { line: 19, column: 41 }, "security")).toBe(
				merged
					.replace("tls: Tls }", "security: Tls }")
					.replace("tls = { enabled", "security = { enabled")
					.replace("server.tls.enabled", "server.security.enabled"),
			)
		})

		it("renames the last step", () => {
			expect(rename(merged, { line: 19, column: 45 }, "on")).toBe(
				merged.replaceAll("enabled", "on"),
			)
		})

		it("reaches the last step from the member's declaration", () => {
			expect(rename(merged, { line: 2, column: 15 }, "on")).toBe(
				merged.replaceAll("enabled", "on"),
			)
		})
	})
})

// A `define` opens no Scope of its own, so every name written in an arm is an
// occurrence of a Declaration made outside it.
describe("Rename inside a define", () => {
	it("should rename a Parameter read in both halves of an arm", () => {
		let source = [
			"implementation {",
			"\tfunction grade (_ score: Integer) -> String {",
			"\t\t<- define {",
			"\t\t\tas score::toString() if score::isGreaterThan(90)",
			'\t\t\tas "F" otherwise',
			"\t\t}",
			"\t}",
			"}",
		].join("\n")

		expect(rename(source, { line: 4, column: 7 }, "points")).toBe(
			[
				"implementation {",
				"\tfunction grade (_ points: Integer) -> String {",
				"\t\t<- define {",
				"\t\t\tas points::toString() if points::isGreaterThan(90)",
				'\t\t\tas "F" otherwise',
				"\t\t}",
				"\t}",
				"}",
			].join("\n"),
		)
	})

	it("should rename a Function called from the otherwise arm's value", () => {
		let source = [
			"implementation {",
			"\tfunction fallback () -> String {",
			'\t\t<- "F"',
			"\t}",
			"\tfunction grade (_ score: Integer) -> String {",
			"\t\t<- define {",
			'\t\t\tas "A" if score::isGreaterThan(90)',
			"\t\t\tas fallback() otherwise",
			"\t\t}",
			"\t}",
			"}",
		].join("\n")

		expect(rename(source, { line: 8, column: 7 }, "lowest")).toBe(
			[
				"implementation {",
				"\tfunction lowest () -> String {",
				'\t\t<- "F"',
				"\t}",
				"\tfunction grade (_ score: Integer) -> String {",
				"\t\t<- define {",
				'\t\t\tas "A" if score::isGreaterThan(90)',
				"\t\t\tas lowest() otherwise",
				"\t\t}",
				"\t}",
				"}",
			].join("\n"),
		)
	})
})

// A name read under `start` or `complete` is a read like any other. A walk
// that stopped at the Keyword would leave the use behind.
describe("Rename through start and complete", () => {
	it("should rewrite a name read under either Keyword", () => {
		let source = [
			"implementation {",
			"\tfunction doubled(_ value: Integer) -> Future<Integer> {",
			"\t\t<- complete Async.deferred(() { <- value })",
			"\t}",
			"",
			"\tconstant answer = complete doubled(21)",
			"\tconstant running = start doubled(21)",
			"}",
		].join("\n")

		expect(rename(source, { line: 2, column: 11 }, "twice")).toBe(
			[
				"implementation {",
				"\tfunction twice(_ value: Integer) -> Future<Integer> {",
				"\t\t<- complete Async.deferred(() { <- value })",
				"\t}",
				"",
				"\tconstant answer = complete twice(21)",
				"\tconstant running = start twice(21)",
				"}",
			].join("\n"),
		)
	})

	// The typed walk indexes a Method resolved through its receiver's Type.
	// The Keyword takes the whole postfix chain, so the call sits inside the
	// operand.
	it("should rewrite a Method called inside the operand", () => {
		let source = [
			"implementation {",
			"\tnamespace Doubling for Integer {",
			"\t\tdoubled() -> Integer {",
			"\t\t\t<- @::multiply(with 2)",
			"\t\t}",
			"\t}",
			"",
			"\tfunction held(_ value: Integer) -> Future<Integer> {",
			"\t\t<- complete Async.deferred(() { <- value })",
			"\t}",
			"",
			"\tTerminal.inspect(complete held(21::doubled()))",
			"}",
		].join("\n")

		expect(rename(source, { line: 3, column: 3 }, "twice")).toContain(
			"\tTerminal.inspect(complete held(21::twice()))",
		)
	})
})

// A label, a member, a Case and a path step are spelled like a value's name,
// and resolve through Types or the call instead. A Pattern's binder declares a
// name of its own. Renaming a Constant of that name must leave each alone.
describe("Rename of a Constant spelled like a label, a member, a Case or a binder", () => {
	let source = [
		"implementation {",
		"\tchoice Tank {",
		"\t\tFull { level: Integer },",
		"\t\tEmpty,",
		"\t}",
		"",
		"\tconstant level = 2",
		"\tconstant by = 1",
		"\tconstant Full = 3",
		"\tconstant apply: (level: Integer) -> Integer = (level: Integer) -> Integer {",
		"\t\t<- level",
		"\t}",
		"\tconstant tank = Tank#Full({ level })",
		'\tconstant spaced = "a"::indent(by level)',
		"\tconstant read = { level = level }.level",
		"\tconstant depths = [{ level = 1 }]::map(.level)",
		"",
		"\tTerminal.inspect(apply(level by))",
		"\tTerminal.inspect(Full)",
		"}",
	].join("\n")

	it("should leave a Function Type's label, a Case's member and a Lookup alone", () => {
		expect(rename(source, { line: 7, column: 11 }, "depth")).toBe(
			[
				"implementation {",
				"\tchoice Tank {",
				"\t\tFull { level: Integer },",
				"\t\tEmpty,",
				"\t}",
				"",
				"\tconstant depth = 2",
				"\tconstant by = 1",
				"\tconstant Full = 3",
				"\tconstant apply: (level: Integer) -> Integer = (level: Integer) -> Integer {",
				"\t\t<- level",
				"\t}",
				"\tconstant tank = Tank#Full({ level = depth })",
				'\tconstant spaced = "a"::indent(by depth)',
				"\tconstant read = { level = depth }.level",
				"\tconstant depths = [{ level = 1 }]::map(.level)",
				"",
				"\tTerminal.inspect(apply(level by))",
				"\tTerminal.inspect(Full)",
				"}",
			].join("\n"),
		)
	})

	it("should leave a Method call's label alone", () => {
		expect(rename(source, { line: 8, column: 11 }, "step")).toBe(
			source
				.replace("\tconstant by = 1", "\tconstant step = 1")
				.replace("apply(level by)", "apply(level step)"),
		)
	})

	it("should leave a Case of the Constant's name alone", () => {
		expect(rename(source, { line: 9, column: 11 }, "Count")).toBe(
			source
				.replace("\tconstant Full = 3", "\tconstant Count = 3")
				.replace("Terminal.inspect(Full)", "Terminal.inspect(Count)"),
		)
	})

	it("should leave a Pattern binder that shadows the Constant alone", () => {
		let shadowed = [
			"implementation {",
			"\tconstant outer = 1",
			"\tconstant box = { width = 1, height = 2 }",
			"",
			"\tfunction measure() -> Integer {",
			"\t\tconstant { width as outer } = box",
			"",
			"\t\t<- outer",
			"\t}",
			"",
			"\tTerminal.inspect(measure()::add(outer))",
			"}",
		].join("\n")

		expect(rename(shadowed, { line: 2, column: 11 }, "base")).toBe(
			shadowed
				.replace("\tconstant outer = 1", "\tconstant base = 1")
				.replace("add(outer)", "add(base)"),
		)
	})
})

describe("Rename of a Type Alias through every Type position", () => {
	it("should reach Function Types, Type Arguments, a Pattern and return Types", () => {
		let source = [
			"implementation {",
			"\ttype Amount = Integer",
			"",
			"\tchoice Holder<Item> {",
			"\t\tFull { item: Item },",
			"\t\tEmpty,",
			"\t}",
			"",
			"\tconstant convert: (value: Amount) -> List<Amount> = (value: Amount) -> List<Amount> {",
			"\t\t<- [value]",
			"\t}",
			"\tconstant held: Holder<Amount> = Holder<Amount>#Full({ item = 1 })",
			"\tconstant picked = match held -> Amount {",
			"\t\tcase #Full({ item: Amount }) { <- item }",
			"\t\tcase _ { <- 0 }",
			"\t}",
			"\tconstant chosen = define -> Amount {",
			"\t\tas 1 if picked::isGreaterThan(0)",
			"\t\tas 2 otherwise",
			"\t}",
			"}",
		].join("\n")

		expect(rename(source, { line: 2, column: 7 }, "Money")).toBe(
			source.replaceAll("Amount", "Money"),
		)
	})
})

// Only the typed walk knows which Namespace answered a Method call, so it has
// to reach every value a call can stand in.
describe("Rename of a Method called inside a value", () => {
	it("should reach a condition, an interpolation, a List, a Dictionary and an update", () => {
		let source = [
			"implementation {",
			"\tnamespace Gauge for Integer {",
			"\t\tdoubled() -> Integer {",
			"\t\t\t<- @::multiply(with 2)",
			"\t\t}",
			"\t}",
			"",
			"\tfunction report(_ amount: Integer) -> String {",
			"\t\tif amount::doubled()::isGreaterThan(4) {",
			'\t\t\t<- "{amount::doubled()} is large"',
			"\t\t}",
			"",
			'\t\t<- "{amount}"',
			"\t}",
			"",
			"\tconstant readings = [1::doubled(), 2]",
			'\tconstant labels = ["one" = 1::doubled(), "two" = 2]',
			"\tconstant base = { size = 1 }",
			"\tconstant merged = { base with size = 2::doubled() }",
			"}",
		].join("\n")

		expect(rename(source, { line: 3, column: 3 }, "twice")).toBe(
			source.replaceAll("doubled", "twice"),
		)
	})
})

// The type checker holds `identifierRoles` to the node types. A tree the
// Parser recovers, as a showcase's is, is held to it here.
describe("Rename's Identifier roles", () => {
	it("give a role to every Identifier the parser walk hands on, in every fixture", () => {
		let walked = new Set<string>(walkedKinds)
		let roles: Partial<Record<string, Partial<Record<string, string>>>> =
			identifierRoles
		let missing = new Set<string>()
		let visit = (node: ParserNode) =>
			forEachParserChild(node, (child, _state, field) => {
				if (
					child.nodeType === "Identifier" &&
					!walked.has(node.nodeType) &&
					roles[node.nodeType]?.[field] === undefined
				) {
					missing.add(`${node.nodeType}.${field}`)
				}

				visit(child)
			})
		let files = [FIXTURES_DIRECTORY, fixturePath("diagnostics")].flatMap(
			(directory) =>
				readdirSync(directory)
					.filter((name) => name.endsWith(".es"))
					.map((name) => path.join(directory, name)),
		)

		for (let file of files) {
			visit(parseWithDiagnostics(readFileSync(file, "utf-8")).program)
		}

		expect([...missing]).toEqual([])
	})
})
