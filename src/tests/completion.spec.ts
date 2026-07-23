import { describe, expect, it } from "bun:test"

import { findCompletions } from "../lsp/completion"

function labelsOf(source: string, cursor: { line: number; column: number }) {
	return findCompletions(source, cursor).map((entry) => entry.label)
}

describe("Completion", () => {
	describe("Record members", () => {
		it("should list members after a bare dot", () => {
			let source = [
				"implementation {",
				'\tconstant person = { firstName = "Ada", lastName = "Lovelace" }',
				"\tperson.",
				"}",
			].join("\n")

			expect(labelsOf(source, { line: 3, column: 9 })).toEqual([
				"firstName",
				"lastName",
			])
		})

		it("should list members with a partial name already typed", () => {
			let source = [
				"implementation {",
				'\tconstant person = { firstName = "Ada", lastName = "Lovelace" }',
				"\tperson.fir",
				"}",
			].join("\n")

			expect(labelsOf(source, { line: 3, column: 12 })).toEqual([
				"firstName",
				"lastName",
			])
		})

		it("should work nested inside an open call", () => {
			let source = [
				"implementation {",
				'\tconstant person = { firstName = "Ada" }',
				"\tfunction show (value: String) -> String {",
				"\t\t<- value",
				"\t}",
				"\tshow(person.",
				"}",
			].join("\n")

			expect(labelsOf(source, { line: 6, column: 14 })).toEqual([
				"firstName",
			])
		})

		it("should carry the member's Type as detail", () => {
			let source = [
				"implementation {",
				'\tconstant person = { firstName = "Ada" }',
				"\tperson.",
				"}",
			].join("\n")

			let entries = findCompletions(source, { line: 3, column: 9 })

			expect(entries[0]).toEqual({
				label: "firstName",
				kind: "member",
				detail: "String",
			})
		})
	})

	describe("Namespace static access", () => {
		it("should list Properties and Methods after a dot", () => {
			let source = [
				"implementation {",
				"\tnamespace Thing {",
				'\t\tstatic label = "hi"',
				"\t\tstatic show() -> String {",
				'\t\t\t<- "42"',
				"\t\t}",
				"\t}",
				"\tThing.",
				"}",
			].join("\n")

			expect(labelsOf(source, { line: 8, column: 8 })).toEqual([
				"label",
				"show",
			])
		})
	})

	describe("Methods after ::", () => {
		it("should list a builtin Type's Methods", () => {
			let source = ["implementation {", '\t"Hello"::', "}"].join("\n")

			let labels = labelsOf(source, { line: 2, column: 11 })

			expect(labels).toContain("append")
			expect(labels).toContain("isEmpty")
		})

		it("should union builtin and custom Namespace Methods for the same Type", () => {
			let source = [
				"implementation {",
				"\tnamespace Stringify for Integer {",
				"\t\tstring() -> String {",
				'\t\t\t<- "one"',
				"\t\t}",
				"\t}",
				"\t42::",
				"}",
			].join("\n")

			let labels = labelsOf(source, { line: 7, column: 6 })

			expect(labels).toContain("string")
			expect(labels).toContain("add")
		})

		it("should see a Namespace declared after the cursor", () => {
			let source = [
				"implementation {",
				"\t42::",
				"\tnamespace Stringify for Integer {",
				"\t\tstring() -> String {",
				'\t\t\t<- "one"',
				"\t\t}",
				"\t}",
				"}",
			].join("\n")

			expect(labelsOf(source, { line: 2, column: 6 })).toContain("string")
		})

		it("should list Protocol Methods on a bounded Type Parameter", () => {
			let source = [
				"implementation {",
				"\tfunction describeValue <infer Value is Printable>(_ value: Value) -> String {",
				"\t\t<- value::",
				"\t}",
				"}",
			].join("\n")

			let labels = labelsOf(source, { line: 3, column: 13 })

			expect(labels).toContain("toString")
		})

		it("should list a user Protocol's Methods on a bounded Type Parameter", () => {
			let source = [
				"implementation {",
				"\tprotocol Sizable {",
				"\t\tsize() -> Integer",
				"\t}",
				"\tfunction measure <infer Value is Sizable>(_ value: Value) -> Integer {",
				"\t\t<- value::",
				"\t}",
				"}",
			].join("\n")

			expect(labelsOf(source, { line: 6, column: 13 })).toContain("size")
		})

		it("should filter by an explicit Namespace specifier", () => {
			let source = [
				"implementation {",
				"\tnamespace Stringify for Integer {",
				"\t\tstring() -> String {",
				'\t\t\t<- "one"',
				"\t\t}",
				"\t}",
				"\t42::<Stringify>",
				"}",
			].join("\n")

			expect(labelsOf(source, { line: 7, column: 18 })).toEqual([
				"string",
			])
		})

		it("should not offer static Methods through ::", () => {
			let source = [
				"implementation {",
				"\tnamespace Thing {",
				"\t\tstatic create() -> Integer {",
				"\t\t\t<- 42",
				"\t\t}",
				"\t}",
				"\t1::",
				"}",
			].join("\n")

			expect(labelsOf(source, { line: 7, column: 4 })).not.toContain(
				"create",
			)
		})

		it("should strip Self from the displayed signature", () => {
			let source = ["implementation {", '\t"Hello"::', "}"].join("\n")

			let entries = findCompletions(source, { line: 2, column: 11 })
			let append = entries.find((entry) => entry.label === "append")

			expect(append?.detail).toBe("(_ String) -> String")
		})

		it("should offer only dispatchable Methods on a Union-typed receiver", () => {
			let source = [
				"implementation {",
				"\tconstant value: Integer | Nothing = 5",
				"\tvalue::",
				"}",
			].join("\n")

			let labels = labelsOf(source, { line: 3, column: 9 })

			expect(labels).toContain("toString")
			expect(labels).toContain("is")
			expect(labels).not.toContain("add")
		})

		it("should offer member Methods on a Number receiver", () => {
			let source = [
				"implementation {",
				"\tconstant number: Number = 5",
				"\tnumber::",
				"}",
			].join("\n")

			let labels = labelsOf(source, { line: 3, column: 10 })

			expect(labels).toContain("multiply")
			expect(labels).toContain("toString")
		})
	})

	describe("Scope completion", () => {
		it("should list names visible at the cursor, including builtins", () => {
			let source = [
				"implementation {",
				'\tconstant worldName = "World"',
				"\tfunction greet (subject: String) -> String {",
				"\t\t<- ",
				"\t}",
				"}",
			].join("\n")

			let labels = labelsOf(source, { line: 4, column: 6 })

			expect(labels).toContain("subject")
			expect(labels).toContain("worldName")
			expect(labels).toContain("greet")
			expect(labels).toContain("__print")
		})

		it("should respect shadowing — the Parameter wins over the outer Constant", () => {
			let source = [
				"implementation {",
				"\tconstant value = 1",
				"\tfunction show (value: String) -> String {",
				"\t\t<- ",
				"\t}",
				"}",
			].join("\n")

			let entries = findCompletions(source, { line: 4, column: 6 })
			let matches = entries.filter((entry) => entry.label === "value")

			expect(matches).toHaveLength(1)
			expect(matches[0].kind).toBe("parameter")
		})

		it("should switch to the Type space after a colon", () => {
			let source = [
				"implementation {",
				"\ttype Name = String",
				"\tconstant value: ",
				"}",
			].join("\n")

			let labels = labelsOf(source, { line: 3, column: 18 })

			expect(labels).toContain("Name")
			expect(labels).toContain("String")
			expect(labels).not.toContain("__print")
		})

		it("should see a hoisted Function used before its declaration", () => {
			let source = [
				"implementation {",
				"\tconstant result = ",
				"\tfunction compute () -> Integer {",
				"\t\t<- 1",
				"\t}",
				"}",
			].join("\n")

			expect(labelsOf(source, { line: 2, column: 20 })).toContain(
				"compute",
			)
		})

		it("should not offer a Constant declared after the cursor", () => {
			let source = [
				"implementation {",
				"\tconstant early = 1",
				"",
				"\tconstant later = 2",
				"}",
			].join("\n")

			let labels = labelsOf(source, { line: 3, column: 2 })

			expect(labels).toContain("early")
			expect(labels).not.toContain("later")
		})

		it("should not offer a Constant to its own value Expression", () => {
			let source = ["implementation {", "\tconstant value = ", "}"].join(
				"\n",
			)

			expect(labelsOf(source, { line: 2, column: 19 })).not.toContain(
				"value",
			)
		})

		it("should fall through to an outer name the inner one will shadow", () => {
			let source = [
				"implementation {",
				"\tconstant value = 1",
				"\tfunction show () -> Integer {",
				"",
				"\t\tconstant value = 2",
				"\t\t<- value",
				"\t}",
				"}",
			].join("\n")

			// NOTE: The inner `value` is not declared yet, so the outer one is
			// what resolves here.
			expect(labelsOf(source, { line: 4, column: 3 })).toContain("value")
		})
	})

	describe("Argument labels", () => {
		it("should offer the callee's Parameter labels inside a call", () => {
			let source = [
				"implementation {",
				"\tfunction greet (subject: String) -> String {",
				"\t\t<- subject",
				"\t}",
				"\tgreet()",
				"}",
			].join("\n")

			let entries = findCompletions(source, { line: 5, column: 8 })
			let label = entries.find((entry) => entry.label === "subject")

			expect(label?.kind).toBe("label")
			expect(label?.detail).toBe("String")
		})

		it("should still offer the names in Scope alongside the labels", () => {
			let source = [
				"implementation {",
				"\tfunction greet (subject: String) -> String {",
				"\t\t<- subject",
				"\t}",
				'\tconstant worldName = "World"',
				"\tgreet()",
				"}",
			].join("\n")

			expect(labelsOf(source, { line: 6, column: 8 })).toContain(
				"worldName",
			)
		})

		it("should not offer a label that is already used at the call site", () => {
			let source = [
				"implementation {",
				"\tfunction pair (first: Integer, second: Integer) -> Integer {",
				"\t\t<- first",
				"\t}",
				"\tpair(first 1, )",
				"}",
			].join("\n")

			let labels = labelsOf(source, { line: 5, column: 16 })

			expect(labels).toContain("second")
			expect(labels).not.toContain("first")
		})

		it("should not offer labels for a label-less Parameter", () => {
			let source = [
				"implementation {",
				"\tfunction show (_ value: Integer) -> Integer {",
				"\t\t<- value",
				"\t}",
				"\tshow()",
				"}",
			].join("\n")

			expect(
				findCompletions(source, { line: 5, column: 7 }).some(
					(entry) => entry.kind === "label",
				),
			).toBe(false)
		})
	})

	describe("Record literal members", () => {
		it("should offer the members of the annotated Record Type", () => {
			let source = [
				"implementation {",
				"\ttype Person = { firstName: String, lastName: String }",
				"\tconstant person: Person = {  }",
				"}",
			].join("\n")

			let entries = findCompletions(source, { line: 3, column: 29 })
			let member = entries.find((entry) => entry.label === "firstName")

			expect(member?.kind).toBe("member")
			expect(member?.detail).toBe("String")
			expect(entries.map((entry) => entry.label)).toContain("lastName")
		})

		it("should not offer a member that is already written", () => {
			let source = [
				"implementation {",
				"\ttype Person = { firstName: String, lastName: String }",
				'\tconstant person: Person = { firstName = "Ada",  }',
				"}",
			].join("\n")

			let labels = labelsOf(source, { line: 3, column: 48 })

			expect(labels).toContain("lastName")
			expect(labels).not.toContain("firstName")
		})

		it("should offer members for a Record passed as an Argument", () => {
			let source = [
				"implementation {",
				"\ttype Person = { firstName: String }",
				"\tfunction show (_ person: Person) -> String {",
				"\t\t<- person.firstName",
				"\t}",
				"\tshow({  })",
				"}",
			].join("\n")

			expect(labelsOf(source, { line: 6, column: 9 })).toContain(
				"firstName",
			)
		})
	})

	describe("Namespace specifiers after ::<", () => {
		it("should offer Namespaces matching the receiver, not Types", () => {
			let source = [
				"implementation {",
				"\tnamespace Stringify for Integer {",
				"\t\tstring() -> String {",
				'\t\t\t<- "one"',
				"\t\t}",
				"\t}",
				"\t42::<",
				"}",
			].join("\n")

			let entries = findCompletions(source, { line: 7, column: 7 })

			expect(entries.map((entry) => entry.label)).toContain("Stringify")
			expect(entries.every((entry) => entry.kind === "namespace")).toBe(
				true,
			)
		})

		it("should offer Namespaces with a partial specifier typed", () => {
			let source = [
				"implementation {",
				"\tnamespace Stringify for Integer {",
				"\t\tstring() -> String {",
				'\t\t\t<- "one"',
				"\t\t}",
				"\t}",
				"\t42::<Str",
				"}",
			].join("\n")

			expect(labelsOf(source, { line: 7, column: 10 })).toContain(
				"Stringify",
			)
		})

		it("should not offer a Namespace whose target Type does not match", () => {
			let source = [
				"implementation {",
				"\tnamespace Stringify for Integer {",
				"\t\tstring() -> String {",
				'\t\t\t<- "one"',
				"\t\t}",
				"\t}",
				'\t"text"::<',
				"}",
			].join("\n")

			expect(labelsOf(source, { line: 7, column: 11 })).not.toContain(
				"Stringify",
			)
		})
	})
})

// NOTE: What a converted Namespace must NOT change. The standard library is
// moving out of TypeScript and into Essence one Namespace at a time, and a
// source declaration is enriched INTO the builtin Scope rather than spread
// into it — so without `builtinMemberOrder` a conversion moves its Namespace
// to the end of the member table, and the members another Namespace covers
// the same receiver with start winning the dedupe. `Boolean` is the first one
// converted; `otherwise` comes from Optional, which covers every Type.
describe("Completion of a converted standard library Namespace", () => {
	it("should offer Boolean's own Methods ahead of the ones it inherits", () => {
		let source = ["implementation {", "\ttrue::", "}"].join("\n")

		expect(labelsOf(source, { line: 2, column: 8 })).toEqual([
			"negate",
			"is",
			"isNot",
			"and",
			"or",
			"exclusiveOr",
			"toString",
			"otherwise",
		])
	})
})
