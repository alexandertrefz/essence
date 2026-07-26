import { describe, expect, it } from "bun:test"

import { buildCallSnippet } from "../callSnippets"
import { findCompletions } from "../completion"

function labelsOf(source: string, cursor: { line: number; column: number }) {
	return findCompletions(source, cursor).map((entry) => entry.label)
}

function entryFor(
	source: string,
	cursor: { line: number; column: number },
	label: string,
) {
	return findCompletions(source, cursor).find(
		(entry) => entry.label === label,
	)
}

function kindsOf(source: string, cursor: { line: number; column: number }) {
	return findCompletions(source, cursor).map((entry) => entry.kind)
}

function keywordsOf(source: string, cursor: { line: number; column: number }) {
	return findCompletions(source, cursor)
		.filter((entry) => entry.kind === "keyword")
		.map((entry) => entry.label)
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
				tier: 2,
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

		// NOTE: Nobody declares these — the Choice derives them — so without
		// the Language Server mirroring that rule they would work at every call
		// site and be offered at none.
		it("should list a Choice's derived 'is' and 'isNot'", () => {
			let source = [
				"implementation {",
				"\tchoice Colour {",
				"\t\tRed,",
				"\t\tGreen,",
				"\t}",
				"",
				"\tconstant red: Colour = #Red",
				"\tred::",
				"}",
			].join("\n")

			let labels = labelsOf(source, { line: 8, column: 7 })

			expect(labels).toContain("is")
			expect(labels).toContain("isNot")
		})

		it("should list a written 'is' once, not beside the derived one", () => {
			let source = [
				"implementation {",
				"\tchoice Colour {",
				"\t\tRed,",
				"\t\tGreen,",
				"\t}",
				"",
				"\tnamespace Colour for Colour {",
				"\t\tis(_ other: Colour) -> Boolean {",
				"\t\t\t<- true",
				"\t\t}",
				"\t}",
				"",
				"\tconstant red: Colour = #Red",
				"\tred::",
				"}",
			].join("\n")

			let labels = labelsOf(source, { line: 14, column: 7 })

			expect(labels.filter((label) => label === "is")).toEqual(["is"])
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

	describe("Case completion after #", () => {
		let boxChoice = [
			"implementation {",
			"\tchoice Box<Value> {",
			"\t\tHolding { value: Value },",
			"\t\tEmpty,",
			"\t}",
		]

		it("should offer an applied Choice's Cases with instantiated payloads under an annotation", () => {
			let source = [
				...boxChoice,
				"\tconstant b: Box<Integer> = #",
				"}",
			].join("\n")

			let entries = findCompletions(source, { line: 6, column: 30 })

			expect(entries.map((entry) => [entry.label, entry.detail])).toEqual(
				[
					["Holding", "Box<Integer>#Holding { value: Integer }"],
					["Empty", "Box<Integer>#Empty"],
				],
			)
			expect(entries.every((entry) => entry.kind === "case")).toBe(true)
		})

		it("should complete a partially typed Case name, still instantiated", () => {
			let source = [
				...boxChoice,
				"\tconstant b: Box<Integer> = #Ho",
				"}",
			].join("\n")

			let entries = findCompletions(source, { line: 6, column: 32 })

			expect(entries.map((entry) => entry.label)).toContain("Holding")
			expect(
				entries.find((entry) => entry.label === "Holding")?.detail,
			).toBe("Box<Integer>#Holding { value: Integer }")
		})

		// NOTE: With no expectation the scan mirrors the Enricher's
		// `findCaseTypesInScope` — a generic Choice (a Generic Alias) offers its
		// declared Cases, their payloads still abstract (`value: Value`).
		it("should offer a generic Choice's Cases for a bare # with no expectation", () => {
			let source = [...boxChoice, "\tconstant b = #", "}"].join("\n")

			let entries = findCompletions(source, { line: 6, column: 16 })

			expect(entries.map((entry) => [entry.label, entry.detail])).toEqual(
				[
					["Holding", "Box#Holding { value: Value }"],
					["Empty", "Box#Empty"],
				],
			)
		})

		it("should narrow to one Choice after a written prefix", () => {
			let source = [
				"implementation {",
				"\tchoice Box<Value> {",
				"\t\tHolding { value: Value },",
				"\t\tEmpty,",
				"\t}",
				"\tchoice Colour {",
				"\t\tRed,",
				"\t\tGreen,",
				"\t}",
				"\tconstant b = Colour#",
				"}",
			].join("\n")

			expect(
				findCompletions(source, { line: 10, column: 22 }).map(
					(entry) => entry.label,
				),
			).toEqual(["Red", "Green"])
		})

		it("should preselect the first Case once an expectation names one Choice", () => {
			let source = [
				...boxChoice,
				"\tconstant b: Box<Integer> = #",
				"}",
			].join("\n")

			let entries = findCompletions(source, { line: 6, column: 30 })

			expect(entries.map((entry) => entry.preselect)).toEqual([
				true,
				false,
			])
		})

		// NOTE: A scan over every Choice in scope has no basis for a
		// preselection — the first entry is the first Choice's first Case,
		// which is nothing but declaration order.
		it("should preselect nothing for a bare # with no expectation", () => {
			let source = [...boxChoice, "\tconstant b = #", "}"].join("\n")

			expect(
				findCompletions(source, { line: 6, column: 16 }).some(
					(entry) => entry.preselect,
				),
			).toBe(false)
		})

		it("should offer Cases from every Choice in scope for a bare #", () => {
			let source = [
				"implementation {",
				"\tchoice Box<Value> {",
				"\t\tHolding { value: Value },",
				"\t\tEmpty,",
				"\t}",
				"\tchoice Colour {",
				"\t\tRed,",
				"\t\tGreen,",
				"\t}",
				"\tconstant b = #",
				"}",
			].join("\n")

			let labels = findCompletions(source, { line: 10, column: 16 }).map(
				(entry) => entry.label,
			)

			expect(labels).toContain("Holding")
			expect(labels).toContain("Red")
			expect(labels).toContain("Green")
		})

		it("should instantiate a non-generic Choice's Cases too", () => {
			let source = [
				"implementation {",
				"\tchoice Colour {",
				"\t\tRed,",
				"\t\tGreen,",
				"\t}",
				"\tconstant c: Colour = #",
				"}",
			].join("\n")

			expect(
				findCompletions(source, { line: 6, column: 24 }).map(
					(entry) => entry.label,
				),
			).toEqual(["Red", "Green"])
		})

		// NOTE: A Guard is an ordinary Expression, so the Argument it is being
		// written into pins the Choice down just as it would anywhere else —
		// `Shape` is in scope and stays out of the list.
		it("should narrow to the expected Choice inside a Match Guard", () => {
			let source = [
				"implementation {",
				"\tchoice Colour {",
				"\t\tRed,",
				"\t\tGreen,",
				"\t}",
				"\tchoice Shape {",
				"\t\tCircle,",
				"\t\tSquare,",
				"\t}",
				"",
				"\tfunction isRed (_ colour: Colour) -> Boolean {",
				"\t\t<- match colour -> Boolean {",
				"\t\t\tcase #Red { <- true }",
				"\t\t\tcase _    { <- false }",
				"\t\t}",
				"\t}",
				"",
				"\tconstant amount: Integer | String = 4",
				"\tconstant label = match amount -> String {",
				'\t\tcase Integer where isRed(#) { <- "red" }',
				'\t\tcase Integer { <- "other" }',
				"\t\tcase String { <- @ }",
				"\t}",
				"}",
			].join("\n")

			expect(
				findCompletions(source, { line: 20, column: 29 }).map(
					(entry) => entry.label,
				),
			).toEqual(["Red", "Green"])
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

	describe("Call snippets", () => {
		let thing = [
			"implementation {",
			"\tnamespace Thing {",
			"\t\tstatic create() -> Integer {",
			"\t\t\t<- 42",
			"\t\t}",
			"\t\tstatic greet(subject: String) -> String {",
			"\t\t\t<- subject",
			"\t\t}",
			"\t\tstatic show(_ value: Integer) -> Integer {",
			"\t\t\t<- value",
			"\t\t}",
			"\t\tstatic pair(_ first: Integer, and second: Integer) -> Integer {",
			"\t\t\t<- first",
			"\t\t}",
			"\t}",
			"\tThing.",
			"}",
		].join("\n")
		let afterThing = { line: 16, column: 8 }

		it("should write a labelled Parameter's label and leave its value a tabstop", () => {
			expect(entryFor(thing, afterThing, "greet")?.snippet).toBe(
				"greet(subject ${1})",
			)
		})

		it("should write a label-less Parameter as a bare tabstop", () => {
			expect(entryFor(thing, afterThing, "show")?.snippet).toBe(
				"show(${1})",
			)
		})

		it("should write a mixed Parameter list", () => {
			expect(entryFor(thing, afterThing, "pair")?.snippet).toBe(
				"pair(${1}, and ${2})",
			)
		})

		it("should write bare parentheses for a callable without Parameters", () => {
			expect(entryFor(thing, afterThing, "create")?.snippet).toBe(
				"create()",
			)
		})

		// NOTE: `Number.isBetween(5, 1, and 10)` — reached through the
		// Namespace the receiver rides along as the first Argument, so the
		// Self Parameter a `::` call site never writes is written here.
		it("should keep the receiver Parameter when a Method is reached through the Namespace", () => {
			let source = ["implementation {", "\tNumber.", "}"].join("\n")

			expect(
				entryFor(source, { line: 2, column: 9 }, "isBetween")?.snippet,
			).toBe("isBetween(${1}, ${2}, and ${3})")
		})

		it("should strip the receiver Parameter for the same Method through ::", () => {
			let source = ["implementation {", "\t5::", "}"].join("\n")

			expect(
				entryFor(source, { line: 2, column: 5 }, "isBetween")?.snippet,
			).toBe("isBetween(${1}, and ${2})")
		})

		it("should write the labels of a Function in Scope", () => {
			let source = [
				"implementation {",
				"\tfunction greet (subject: String) -> String {",
				"\t\t<- subject",
				"\t}",
				"\t",
				"}",
			].join("\n")

			expect(entryFor(source, { line: 5, column: 2 }, "greet")).toEqual({
				label: "greet",
				kind: "function",
				detail: "(subject: String) -> String",
				documentation: null,
				snippet: "greet(subject ${1})",
				labelDetail: null,
				tier: 3,
			})
		})

		// NOTE: A Constant may hold a Function Value, but its name is as often
		// passed on as it is called — nothing is inserted for it.
		it("should not write a call for a Constant holding a Function", () => {
			let source = [
				"implementation {",
				"\tconstant greet = (subject: String) -> String {",
				"\t\t<- subject",
				"\t}",
				"\t",
				"}",
			].join("\n")

			expect(
				entryFor(source, { line: 5, column: 2 }, "greet")?.snippet,
			).toBe(null)
		})

		it("should escape the snippet syntax a name could contain", () => {
			expect(
				buildCallSnippet("call", {
					generics: [],
					parameterTypes: [
						{ name: "with$}", type: { type: "String" } },
					],
					returnType: { type: "String" },
				}),
			).toBe("call(with\\$\\} ${1})")
		})

		describe("Overloads", () => {
			let shout = [
				"implementation {",
				"\tnamespace Shout for String {",
				"\t\toverload twice {",
				"\t\t\t() -> String {",
				"\t\t\t\t<- @",
				"\t\t\t}",
				"",
				"\t\t\t(with separator: String) -> String {",
				"\t\t\t\t<- @",
				"\t\t\t}",
				"\t\t}",
				"\t}",
				'\t"hi"::',
				"}",
			].join("\n")

			it("should offer one item per Overload, each with its own snippet", () => {
				let entries = findCompletions(shout, {
					line: 13,
					column: 8,
				}).filter((entry) => entry.label === "twice")

				expect(entries.map((entry) => entry.snippet)).toEqual([
					"twice()",
					"twice(with ${1})",
				])
			})

			// NOTE: The label is the same on purpose — the Editor filters both
			// on what was typed — so the signature tail is the only thing that
			// can tell them apart in the list.
			it("should tell the Overloads apart by their signature tails", () => {
				let entries = findCompletions(shout, {
					line: 13,
					column: 8,
				}).filter((entry) => entry.label === "twice")

				expect(entries.map((entry) => entry.labelDetail)).toEqual([
					"() -> String",
					"(with: String) -> String",
				])
			})

			it("should leave a Method with one signature without a label detail", () => {
				expect(entryFor(thing, afterThing, "greet")?.labelDetail).toBe(
					null,
				)
			})
		})
	})

	describe("Keywords", () => {
		it("should offer the Statement Keywords at the start of a Statement", () => {
			let source = ["implementation {", "\t", "}"].join("\n")

			let keywords = keywordsOf(source, { line: 2, column: 2 })

			expect(keywords).toContain("constant")
			expect(keywords).toContain("function")
			expect(keywords).toContain("match")
			expect(keywords).not.toContain("true")
		})

		it("should offer the Expression Keywords inside an Expression", () => {
			let source = ["implementation {", "\tconstant value = ", "}"].join(
				"\n",
			)

			expect(keywordsOf(source, { line: 2, column: 19 })).toEqual([
				"match",
				"true",
				"false",
				"nothing",
			])
		})

		it("should not offer Keywords after a dot", () => {
			let source = [
				"implementation {",
				'\tconstant person = { firstName = "Ada" }',
				"\tperson.",
				"}",
			].join("\n")

			expect(kindsOf(source, { line: 3, column: 9 })).not.toContain(
				"keyword",
			)
		})

		it("should not offer Keywords after ::", () => {
			let source = ["implementation {", '\t"Hello"::', "}"].join("\n")

			expect(kindsOf(source, { line: 2, column: 11 })).not.toContain(
				"keyword",
			)
		})

		it("should not offer Keywords after #", () => {
			let source = [
				"implementation {",
				"\tchoice Colour {",
				"\t\tRed,",
				"\t\tGreen,",
				"\t}",
				"\tconstant c: Colour = #",
				"}",
			].join("\n")

			expect(kindsOf(source, { line: 6, column: 24 })).not.toContain(
				"keyword",
			)
		})

		// NOTE: No Keyword names a Type, so the Type space offers none.
		it("should not offer Keywords in the Type space", () => {
			let source = ["implementation {", "\tconstant value: ", "}"].join(
				"\n",
			)

			expect(keywordsOf(source, { line: 2, column: 18 })).toEqual([])
		})
	})

	describe("The Type space", () => {
		it("should switch after a conformance clause's 'is'", () => {
			let source = [
				"implementation {",
				"\ttype Name = String",
				"\tnamespace Thing for Integer is ",
				"}",
			].join("\n")

			let labels = labelsOf(source, { line: 3, column: 33 })

			expect(labels).toContain("Printable")
			expect(labels).not.toContain("__print")
		})

		it("should switch after a Generic bound's 'is'", () => {
			let source = [
				"implementation {",
				"\tfunction show <infer Value is ",
				"}",
			].join("\n")

			expect(labelsOf(source, { line: 2, column: 32 })).toContain(
				"Printable",
			)
		})

		// NOTE: `parseType` is the only place the Parser consumes a Pipe, so
		// one can never mean anything but a Union.
		it("should switch after a Union's pipe", () => {
			let source = [
				"implementation {",
				"\ttype Name = String",
				"\tconstant value: Integer | ",
				"}",
			].join("\n")

			let labels = labelsOf(source, { line: 3, column: 28 })

			expect(labels).toContain("Name")
			expect(labels).not.toContain("__print")
		})

		it("should switch after a comma inside a Generic Argument list", () => {
			let source = [
				"implementation {",
				"\ttype Name = String",
				"\tconstant pair: Dictionary<String, ",
				"}",
			].join("\n")

			let labels = labelsOf(source, { line: 3, column: 36 })

			expect(labels).toContain("Name")
			expect(labels).not.toContain("__print")
		})

		it("should stay in the value space after a comma inside an Argument list", () => {
			let source = [
				"implementation {",
				"\tfunction pair (first: Integer, second: Integer) -> Integer {",
				"\t\t<- first",
				"\t}",
				"\tpair(first 1, ",
				"}",
			].join("\n")

			expect(labelsOf(source, { line: 5, column: 16 })).toContain(
				"__print",
			)
		})

		// NOTE: A Comment runs to the end of its line and a String may span
		// several, so both are blanked out before anything is read off the
		// text — otherwise the `is` of a sentence would switch spaces.
		it("should ignore an 'is' written inside a Comment", () => {
			let source = [
				"implementation {",
				"\tconstant value = 1 § which is ",
				"\t",
				"}",
			].join("\n")

			expect(labelsOf(source, { line: 3, column: 2 })).toContain(
				"__print",
			)
		})
	})

	describe("Scope entry detail and documentation", () => {
		it("should carry a Constant's Type and its §§ description", () => {
			let source = [
				"implementation {",
				"\t§§ The name of the world.",
				'\tconstant worldName = "World"',
				"\t",
				"}",
			].join("\n")

			expect(
				entryFor(source, { line: 4, column: 2 }, "worldName"),
			).toEqual({
				label: "worldName",
				kind: "constant",
				detail: "String",
				documentation: "The name of the world.",
				snippet: null,
				labelDetail: null,
				tier: 3,
			})
		})

		it("should carry a Parameter's Type and its @param text", () => {
			let source = [
				"implementation {",
				"\t§§ Greets someone.",
				"\t§§",
				"\t§§ @param subject — who to greet",
				"\tfunction greet (subject: String) -> String {",
				"\t\t<- ",
				"\t}",
				"}",
			].join("\n")

			let entry = entryFor(source, { line: 6, column: 6 }, "subject")

			expect(entry?.kind).toBe("parameter")
			expect(entry?.detail).toBe("String")
			expect(entry?.documentation).toBe("who to greet")
		})

		// NOTE: A Namespace prints as its own name, which the label already
		// says — its target Type is what a single line can add instead.
		it("should carry a Namespace's target Type", () => {
			let source = [
				"implementation {",
				"\tnamespace Stringify for Integer {",
				"\t\tstring() -> String {",
				'\t\t\t<- "one"',
				"\t\t}",
				"\t}",
				"\t",
				"}",
			].join("\n")

			expect(
				entryFor(source, { line: 7, column: 2 }, "Stringify")?.detail,
			).toBe("for Integer")
		})

		it("should carry a Type Alias's aliased Type", () => {
			let source = [
				"implementation {",
				"\ttype Name = String",
				"\tconstant value: ",
				"}",
			].join("\n")

			expect(
				entryFor(source, { line: 3, column: 18 }, "Name")?.detail,
			).toBe("String")
		})

		// NOTE: A Namespace Type keeps only each Property's Type, so a
		// Property's `§§` block has to be read off the declaration itself.
		it("should carry a Namespace Property's §§ description", () => {
			let source = [
				"implementation {",
				"\tnamespace Thing {",
				"\t\t§§ What to greet with.",
				'\t\tstatic label = "hi"',
				"\t}",
				"\tThing.",
				"}",
			].join("\n")

			let entry = entryFor(source, { line: 6, column: 8 }, "label")

			expect(entry?.kind).toBe("property")
			expect(entry?.documentation).toBe("What to greet with.")
		})
	})

	describe("Sorting tiers", () => {
		let source = [
			"implementation {",
			'\tconstant worldName = "World"',
			"\tfunction greet (subject: String) -> String {",
			"\t\t<- ",
			"\t}",
			"}",
		].join("\n")
		let inBody = { line: 4, column: 6 }

		it("should rank a Parameter above a top level Declaration above a builtin", () => {
			expect(entryFor(source, inBody, "subject")?.tier).toBe(1)
			expect(entryFor(source, inBody, "worldName")?.tier).toBe(3)
			expect(entryFor(source, inBody, "greet")?.tier).toBe(3)
			expect(entryFor(source, inBody, "__print")?.tier).toBe(4)
		})

		it("should rank Keywords last", () => {
			expect(entryFor(source, inBody, "match")?.tier).toBe(5)
		})

		it("should rank a Method beside the Scope it was reached through", () => {
			let receiver = ["implementation {", '\t"Hello"::', "}"].join("\n")

			expect(
				entryFor(receiver, { line: 2, column: 11 }, "append")?.tier,
			).toBe(2)
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
			"hasValue",
			"isNothing",
		])
	})
})
