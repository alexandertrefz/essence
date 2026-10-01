import { describe, expect, it } from "bun:test"
import * as path from "node:path"

import { enrichDocument, parseDocument } from "@essence-lang/compiler/documents"
import { enrich } from "@essence-lang/compiler/enricher"
import { parseWithDiagnostics } from "@essence-lang/compiler/parser"
import { STDLIB_DIRECTORY } from "@essence-lang/standard-library"

import {
	type DocumentSymbolEntry,
	findDocumentSymbols,
} from "../documentSymbols"

function symbolsOf(source: string) {
	let { program } = parseWithDiagnostics(source)

	return findDocumentSymbols(program)
}

// The server enriches the tests section too, which a build drops unless asked.
function detailedSymbolsOf(source: string, options: { tests?: boolean } = {}) {
	let { program } = parseWithDiagnostics(source)
	let { program: enrichedProgram } = enrich(program, options)

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
			["implementation {", '\tTerminal.inspect("Hello")', "}"].join("\n"),
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

	// The label stays the bare name, as a Type Alias's does. The generics
	// clause must leave the Cases in place.
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

		// An `if` has no name of its own, so its body's declarations join
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

		// A Match arm is not an entry of its own either, since one per arm would
		// crowd out the declarations.
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
				["implementation {", '\tTerminal.inspect("Hello")', "}"].join(
					"\n",
				),
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

		// The detail leaves the name out, since the outline shows it beside the
		// detail.
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

		// The outline still lists every entry while the Program does not type
		// check.
		it("should leave every detail null without an enriched Program", () => {
			let symbols = flatten(symbolsOf(source))

			expect(symbols.length).toBeGreaterThan(0)
			expect(symbols.every((symbol) => symbol.detail === null)).toBe(true)
		})

		// A Guard sits outside its Handler's body, so a walk of bodies alone
		// would leave its declarations without a detail.
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

		// A test's own detail is its Modifiers, which the Types leave in place.
		it("should detail a declaration made inside a test", () => {
			let symbols = detailedSymbolsOf(
				[
					"implementation {",
					"\tconstant one = 1",
					"}",
					"",
					"tests {",
					'\ttest "counts" skipped "later" {',
					"\t\tconstant expected = 3",
					"",
					"\t\texpect expected::is(3)",
					"\t}",
					"}",
				].join("\n"),
				{ tests: true },
			)

			expect(detailOf(symbols, "expected")).toBe("Integer")
			expect(detailOf(symbols, "counts")).toBe("skipped")
		})
	})
})

describe("The export block", () => {
	it("should list what a Module publishes, under one entry", () => {
		let symbols = symbolsOf(
			[
				"implementation {",
				"\tfunction squared(_ value: Integer) -> Integer {",
				"\t\t<- value::multiply(with value)",
				"\t}",
				"}",
				"export {",
				"\tsquared as square",
				'\tfrom "./Geometry.es" { Rectangle }',
				"}",
			].join("\n"),
		)

		let section = symbols[symbols.length - 1]

		expect(section?.name).toBe("export")
		expect(section?.kind).toBe("export")
		expect(
			section?.children.map((child) => [child.name, child.detail]),
		).toEqual([
			["square", "squared"],
			["Rectangle", 'from "./Geometry.es"'],
		])
	})

	it("should add nothing to a Program that exports nothing", () => {
		expect(
			symbolsOf(
				["implementation {", "\tconstant one = 1", "}"].join("\n"),
			).map((symbol) => symbol.kind),
		).toEqual(["constant"])
	})

	// The outline's entries come from the parsed Program, so the tests section
	// is in it even where a build strips the block.
	it("should list the tests below the implementation", () => {
		let symbols = symbolsOf(
			[
				"implementation {",
				"\tconstant one = 1",
				"}",
				"",
				"tests {",
				'\tsuite "Standing" tagged slow {',
				'\t\ttest "counts a win" {',
				"\t\t\tconstant expected = 3",
				"",
				"\t\t\texpect expected::is(3)",
				"\t\t}",
				"\t}",
				"",
				'\ttest "{scored} is a win" skipped "the redesign" {',
				"\t\texpect true",
				"\t}",
				"}",
			].join("\n"),
		)

		expect(symbols.map((symbol) => [symbol.name, symbol.kind])).toEqual([
			["one", "constant"],
			["Standing", "suite"],
			["{scored} is a win", "test"],
		])

		let suite = symbols[1]

		expect(suite?.detail).toBe("tagged")
		expect(
			suite?.children.map((child) => [child.name, child.kind]),
		).toEqual([["counts a win", "test"]])
		expect(
			suite?.children[0]?.children.map((child) => [
				child.name,
				child.kind,
			]),
		).toEqual([["expected", "constant"]])
		expect(symbols[2]?.detail).toBe("skipped")
	})
})

// A `define` declares nothing itself. The outline reaches what a Function
// literal written as an arm's value declares.
describe("Document Symbols inside a define", () => {
	let source = [
		"implementation {",
		"\tconstant chosen = define {",
		"\t\tas (_ value: Integer) -> Integer {",
		"\t\t\tconstant doubled = value",
		"\t\t\t<- doubled",
		"\t\t} if true",
		"\t\tas (_ value: Integer) -> Integer { <- value } otherwise",
		"\t}",
		"}",
	].join("\n")

	it("should outline a declaration inside an arm's value", () => {
		expect(
			flatten(symbolsOf(source)).map((symbol) => symbol.name),
		).toContain("doubled")
	})

	it("should put the inferred Type beside it", () => {
		expect(detailOf(detailedSymbolsOf(source), "doubled")).toBe("Integer")
	})
})

// What a Function literal under `start` declares belongs under the Constant
// holding the work. A walk with no case for `start` and `complete` misses it.
describe("Document Symbols under start and complete", () => {
	let source = [
		"implementation {",
		"\tconstant running = start Async.deferred(() {",
		"\t\tconstant inner = 41",
		"",
		"\t\t<- inner::add(1)",
		"\t})",
		"\tTerminal.inspect(complete running)",
		"}",
	].join("\n")

	it("should list what a body written under the Keyword declares", () => {
		expect(flatten(symbolsOf(source)).map((symbol) => symbol.name)).toEqual(
			["running", "inner"],
		)
	})

	it("should detail the Constant with the work it holds", () => {
		expect(detailOf(detailedSymbolsOf(source), "running")).toBe(
			"Started<Integer>",
		)
		expect(detailOf(detailedSymbolsOf(source), "inner")).toBe("Integer")
	})
})

describe("Document Symbols inside a Protocol-provided Method body", () => {
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

	it("should nest what the body declares under the Method", () => {
		let [protocol] = symbolsOf(source)

		expect(
			protocol.children.map((child) => [
				child.name,
				child.children.map((nested) => nested.name),
			]),
		).toEqual([
			["isAbove", []],
			["isAtMost", ["flipped"]],
		])
	})

	it("should put the inferred Type beside it", () => {
		expect(detailOf(detailedSymbolsOf(source), "flipped")).toBe("Boolean")
	})
})

describe("Document Symbols inside a refused value", () => {
	let source = [
		"implementation {",
		"\tconstant kept = [1]::removeEvery(where (item) {",
		"\t\tconstant inner = item::isGreaterThan(0)",
		"",
		"\t\t<- inner",
		"\t})[0]",
		"}",
	].join("\n")

	it("should list what a body in front of the brackets declares", () => {
		expect(flatten(symbolsOf(source)).map((symbol) => symbol.name)).toEqual(
			["kept", "inner"],
		)
	})

	it("should put the inferred Type beside it", () => {
		expect(detailOf(detailedSymbolsOf(source), "inner")).toBe("Boolean")
	})
})

// An assertion is a Statement of the test body, and a Function literal it holds
// outlines as one anywhere else does.
describe("Document Symbols inside an assertion", () => {
	let source = [
		"implementation {}",
		"",
		"tests {",
		'\ttest "checks" {',
		"\t\texpect [1]::hasOnlyItems(where (item) {",
		"\t\t\tconstant expected = item::isGreaterThan(0)",
		"",
		"\t\t\t<- expected",
		"\t\t})",
		"",
		"\t\trequire [2]::hasOnlyItems(where (item) {",
		"\t\t\tconstant required = item::isGreaterThan(0)",
		"",
		"\t\t\t<- required",
		"\t\t})",
		"\t}",
		"}",
	].join("\n")

	it("should list what a Function literal in an expect or a require declares", () => {
		let [test] = symbolsOf(source)

		expect(test.children.map((child) => child.name)).toEqual([
			"expected",
			"required",
		])
	})

	it("should put the inferred Type beside it", () => {
		let symbols = detailedSymbolsOf(source, { tests: true })

		expect(detailOf(symbols, "expected")).toBe("Boolean")
		expect(detailOf(symbols, "required")).toBe("Boolean")
	})
})

// A default stands outside the body it belongs to, written before it.
describe("Document Symbols inside a default value", () => {
	let source = [
		"implementation {",
		"\tfunction run(_ f: () -> Integer = () -> Integer {",
		"\t\tconstant inner = 1",
		"",
		"\t\t<- inner",
		"\t}) -> Integer {",
		"\t\t<- f()",
		"\t}",
		"",
		"\tnamespace Runs for Integer {",
		"\t\ttwice(_ h: () -> Integer = () -> Integer {",
		"\t\t\tconstant held = 3",
		"",
		"\t\t\t<- held",
		"\t\t}) -> Integer {",
		"\t\t\t<- h()",
		"\t\t}",
		"\t}",
		"}",
	].join("\n")

	it("should nest what a Parameter's default declares under its Function", () => {
		expect(flatten(symbolsOf(source)).map((symbol) => symbol.name)).toEqual(
			["run", "inner", "Runs", "twice", "held"],
		)
	})

	it("should put the inferred Type beside it", () => {
		let symbols = detailedSymbolsOf(source)

		expect(detailOf(symbols, "inner")).toBe("Integer")
		expect(detailOf(symbols, "held")).toBe("Integer")
	})

	// Only the standard library declares natives, so the document is analysed
	// as one of its files.
	it("should nest what a native Method's default declares under it", () => {
		let documentPath = path.join(STDLIB_DIRECTORY, "Sizes.es")
		let { program } = parseDocument(
			[
				"declarations {",
				"\tnamespace Sizes for Integer {",
				"\t\tmeasured(to end: Integer = [1]::map((item) {",
				"\t\t\tconstant held = item::add(1)",
				"",
				"\t\t\t<- held",
				"\t\t})::length()) -> Integer",
				"",
				"\t\toverload scaled {",
				"\t\t\t(by factor: Integer = [2]::map((item) {",
				"\t\t\t\tconstant kept = item::add(2)",
				"",
				"\t\t\t\t<- kept",
				"\t\t\t})::length()) -> Integer",
				"\t\t\t(text factor: String) -> Integer",
				"\t\t}",
				"\t}",
				"}",
			].join("\n"),
			documentPath,
		)
		let { program: enrichedProgram } = enrichDocument(program, documentPath)
		let [namespace] = findDocumentSymbols(program, enrichedProgram)

		expect(
			namespace.children.map((member) => [
				member.name,
				member.children.map((child) => [child.name, child.detail]),
			]),
		).toEqual([
			["measured", [["held", "Integer"]]],
			["scaled", [["kept", "Integer"]]],
		])
	})

	// The default is refused, but the outline shows what is written.
	it("should nest what a Case's payload default declares under the Case", () => {
		let [choice] = symbolsOf(
			[
				"implementation {",
				"\tchoice Shape {",
				"\t\tCircle { grow: (_ size: Integer) -> Integer } = { grow = (_ size: Integer) -> Integer {",
				"\t\t\tconstant doubled = size",
				"",
				"\t\t\t<- doubled",
				"\t\t} },",
				"\t\tDot,",
				"\t}",
				"}",
			].join("\n"),
		)
		let [circle] = choice.children

		expect(circle.children.map((child) => child.name)).toEqual([
			"grow",
			"doubled",
		])
		expect(circle.range.end).toEqual({ line: 7, column: 6 })
	})
})

// A test's head, its name and table, stands outside its body.
describe("Document Symbols inside a test's head", () => {
	let source = [
		"implementation {}",
		"",
		"tests {",
		'\ttest "row" across [',
		"\t\t[1]::map((item) {",
		"\t\t\tconstant tripled = item::add(3)",
		"",
		"\t\t\t<- tripled",
		"\t\t}),",
		"\t] (row: List<Integer>) {",
		"\t\texpect row::isEmpty()::negate()",
		"\t}",
		"}",
	].join("\n")

	it("should nest what a table's rows declare under the test", () => {
		let [test] = symbolsOf(source)

		expect(test.children.map((child) => child.name)).toEqual(["tripled"])
	})

	it("should put the inferred Type beside it", () => {
		expect(
			detailOf(detailedSymbolsOf(source, { tests: true }), "tripled"),
		).toBe("Integer")
	})

	// The default is refused, but the outline shows what is written.
	it("should nest what a generated Parameter's default declares under the test", () => {
		let [test] = symbolsOf(
			[
				"implementation {}",
				"",
				"tests {",
				'\ttest "any" for any (count: Integer = [2]::map((item) {',
				"\t\tconstant doubled = item::add(2)",
				"",
				"\t\t<- doubled",
				"\t})::length()) {",
				"\t\texpect count::is(count)",
				"\t}",
				"}",
			].join("\n"),
		)

		expect(test.children.map((child) => child.name)).toEqual(["doubled"])
	})
})

// A Function literal in a predicate is refused, but the outline shows what is
// written and the Type the enricher still gives it.
describe("Document Symbols inside a refinement's predicate", () => {
	let source = [
		"implementation {",
		"\ttype Small = List<Integer> where @::hasOnlyItems(where (item) {",
		"\t\tconstant limit = 10",
		"",
		"\t\t<- item::isLessThan(limit)",
		"\t})",
		"}",
	].join("\n")

	it("should nest what the predicate declares under the Type Alias", () => {
		let [alias] = symbolsOf(source)

		expect(alias.children.map((child) => child.name)).toEqual(["limit"])
	})

	it("should put the inferred Type beside it", () => {
		expect(detailOf(detailedSymbolsOf(source), "limit")).toBe("Integer")
	})
})
