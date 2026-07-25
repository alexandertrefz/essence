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
		expect(help?.signatures[0].label).toBe(
			"greet(subject: String) -> String",
		)
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
			"identity(value: Integer, extra: Integer) -> Integer",
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
			"combine(_ Integer, _ Integer) -> Integer",
		)

		// NOTE: The Enricher resolves the half written call to the one
		// Parameter Overload — the second Argument has already ruled it out,
		// so the Overload that can still take it is the active one.
		expect(help?.activeSignature).toBe(1)
	})

	it("should highlight repeat Parameters by range, not by their text", () => {
		let source = [
			"implementation {",
			"\tfunction pair (first: Integer, second: Integer) -> Integer {",
			"\t\t<- first",
			"\t}",
			"\tpair(",
			"}",
		].join("\n")

		let help = findSignatureHelp(source, { line: 5, column: 7 })

		let signature = help?.signatures[0]

		expect(
			signature?.parameters.map((parameter) => parameter.range),
		).toEqual([
			[5, 19],
			[21, 36],
		])

		// NOTE: The ranges must index into the label the Editor is shown.
		expect(
			signature?.parameters.map(({ range: [start, end] }) =>
				signature.label.slice(start, end),
			),
		).toEqual(["first: Integer", "second: Integer"])
	})

	it("should show a Static Method invoked through its Namespace", () => {
		let source = [
			"implementation {",
			"\tnamespace Thing {",
			"\t\tstatic show(value: Integer) -> String {",
			'\t\t\t<- "42"',
			"\t\t}",
			"\t}",
			"\tThing.show(",
			"}",
		].join("\n")

		let help = findSignatureHelp(source, { line: 7, column: 13 })

		expect(help?.signatures[0].label).toBe(
			"Thing.show(value: Integer) -> String",
		)
	})

	it("should qualify the Namespace when more than one provides the Method", () => {
		let source = [
			"implementation {",
			"\tnamespace First for Integer {",
			"\t\ttag(_ label: String) -> String {",
			"\t\t\t<- label",
			"\t\t}",
			"\t}",
			"\tnamespace Second for Integer {",
			"\t\ttag(_ level: Integer) -> String {",
			'\t\t\t<- "x"',
			"\t\t}",
			"\t}",
			"\t1::tag(",
			"}",
		].join("\n")

		let help = findSignatureHelp(source, { line: 12, column: 9 })

		// NOTE: `1::<First>tag(…)` is how a call site picks one, so the label
		// is qualified the same way.
		expect(help?.signatures.map((signature) => signature.label)).toEqual([
			"<First>tag(_ String) -> String",
			"<Second>tag(_ Integer) -> String",
		])
	})

	it("should strip Self from a Simple Method's signature", () => {
		let source = ["implementation {", '\t"Hello"::append(', "}"].join("\n")

		let help = findSignatureHelp(source, { line: 2, column: 18 })

		expect(help?.signatures[0].label).toBe("append(_ String) -> String")
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

describe("Signature Help for bounded Methods", () => {
	it("should render the Protocol bound and keep parameter ranges aligned", () => {
		let source = ["implementation {", "\t[3, 1]::compareTo(", "}"].join(
			"\n",
		)

		let help = findSignatureHelp(source, { line: 2, column: 20 })
		let signature = help?.signatures[0]

		expect(signature?.label).toBe(
			"compareTo<ItemType is Comparable>(_ List<ItemType>) -> Ordering",
		)

		// NOTE: The bound widens the generics prefix — the range has to keep
		// pointing at the Parameter, not at a stale offset.
		let parameter = signature?.parameters[0]

		expect(parameter).toBeDefined()
		expect(
			signature?.label.slice(parameter!.range[0], parameter!.range[1]),
		).toBe("_ List<ItemType>")
		expect(help?.activeParameter).toBe(0)
	})
})

// NOTE: Boolean stands in for the standard library as a whole here
// (`src/stdlib/Boolean.es`). Signature Help reads a Parameter's text off the
// Parameter itself, so the `@param other` tag in the source has to be split out
// of the `§§` block and attached to the Parameter it names, not left in the
// Method's description.
describe("Signature Help for a standard library Method", () => {
	it("should describe the Parameter of a Method declared in Essence", () => {
		let source = ["implementation {", "\ttrue::is(", "}"].join("\n")

		let help = findSignatureHelp(source, { line: 2, column: 11 })
		let signature = help?.signatures[0]

		expect(signature?.label).toBe("is(_ Boolean) -> Boolean")
		expect(signature?.documentation).toBe(
			"Checks whether the Boolean has the same truth value as another.",
		)
		expect(signature?.parameters[0]?.documentation).toBe(
			"the Boolean to compare against",
		)
	})
})
