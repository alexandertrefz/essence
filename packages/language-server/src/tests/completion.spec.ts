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
	// NOTE: A dotted key names members of the value being UPDATED, one level
	// at a time — which is a different question from what a name in Scope
	// happens to hold, and has to be asked as its own reading.
	describe("Path keys", () => {
		const config = [
			"implementation {",
			"\ttype Tls = { enabled: Boolean }",
			"\ttype Server = { host: String, port: Integer, tls: Tls }",
			"\ttype Config = { name: String, server: Server }",
			"",
			"\tconstant config: Config = {",
			'\t\tname = "api",',
			'\t\tserver = { host = "h", port = 80, tls = { enabled = false } },',
			"\t}",
		]

		let after = (key: string) =>
			[...config, `\tconstant deep = { config with ${key} }`, "}"].join(
				"\n",
			)

		it("should list the members one step in", () => {
			expect(
				labelsOf(after("server."), { line: 10, column: 39 }),
			).toEqual(["host", "port", "tls"])
		})

		it("should list the members two steps in", () => {
			expect(
				labelsOf(after("server.tls."), { line: 10, column: 43 }),
			).toEqual(["enabled"])
		})

		it("should list them with a step already half typed", () => {
			expect(
				labelsOf(after("server.po"), { line: 10, column: 41 }),
			).toEqual(["host", "port", "tls"])
		})

		// NOTE: The reading that makes the key reading necessary rather than
		// merely nicer — read as an ordinary member access, `server.` here
		// answers the Constant's members, which have nothing to do with the
		// update.
		it("should read the value updated rather than a name in Scope", () => {
			let source = [
				...config,
				"\tconstant server = { unrelated = 1 }",
				"\tconstant deep = { config with server. }",
				"}",
			].join("\n")

			expect(labelsOf(source, { line: 11, column: 39 })).toEqual([
				"host",
				"port",
				"tls",
			])
		})

		it("should list the members inside a braced descend", () => {
			let source = [
				...config,
				"\tconstant deep = { config with server.{ tls. } }",
				"}",
			].join("\n")

			expect(labelsOf(source, { line: 10, column: 45 })).toEqual([
				"enabled",
			])
		})

		it("should list the members a descend is about to open on", () => {
			let source = [
				...config,
				"\tconstant deep = { config with server. }",
				"}",
			].join("\n")

			expect(labelsOf(source, { line: 10, column: 39 })).toEqual([
				"host",
				"port",
				"tls",
			])
		})

		it("should leave an ordinary member access alone", () => {
			let source = [
				...config,
				"\tconstant port = config.server.",
				"}",
			].join("\n")

			expect(labelsOf(source, { line: 10, column: 32 })).toEqual([
				"host",
				"port",
				"tls",
			])
		})

		// NOTE: An Argument and a Case payload are merged into a DEFAULT, so
		// what a path key inside one reaches into is the Parameter's Record or
		// the Case's — there is no value written beside it to read them off.
		describe("in a Literal merged into a default", () => {
			const connect = [
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
			]

			it("should list the members one step into an Argument", () => {
				let source = [
					...connect,
					"\tconstant deep = connect(using { server. })",
					"}",
				].join("\n")

				expect(labelsOf(source, { line: 19, column: 41 })).toEqual([
					"host",
					"port",
					"tls",
				])
			})

			it("should list the members two steps in", () => {
				let source = [
					...connect,
					"\tconstant deep = connect(using { server.tls. })",
					"}",
				].join("\n")

				expect(labelsOf(source, { line: 19, column: 45 })).toEqual([
					"enabled",
				])
			})

			it("should list the members inside a braced descend", () => {
				let source = [
					...connect,
					"\tconstant deep = connect(using { server.{ tls. } })",
					"}",
				].join("\n")

				expect(labelsOf(source, { line: 19, column: 47 })).toEqual([
					"enabled",
				])
			})

			it("should list the members one step into a payload", () => {
				let source = [
					"implementation {",
					"\ttype Limits = { calls: Integer, burst: Integer }",
					"",
					"\tchoice Fetch {",
					"\t\tGet { url: String, limits: Limits } = {",
					"\t\t\tlimits = { calls = 1, burst = 2 },",
					"\t\t},",
					"\t}",
					"",
					'\tconstant a: Fetch = #Get({ url = "/x", limits. })',
					"}",
				].join("\n")

				expect(labelsOf(source, { line: 10, column: 48 })).toEqual([
					"calls",
					"burst",
				])
			})
		})
	})

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

		// NOTE: The head of an `if` closed with the brackets alone is an `if`
		// with no body, which the Parser drops whole — and the member access
		// with it. A further reading gives it one.
		it("should work in the head of an if", () => {
			let source = [
				"implementation {",
				"\tconstant cell = { alive = true, age = 3 }",
				"\tfunction check() -> Boolean {",
				"\t\tif cell.",
				"\t\t<- true",
				"\t}",
				"}",
			].join("\n")

			expect(labelsOf(source, { line: 4, column: 11 })).toEqual([
				"alive",
				"age",
			])
		})

		it("should work in the head of an else if", () => {
			let source = [
				"implementation {",
				"\tconstant cell = { alive = true, age = 3 }",
				"\tif true {",
				"\t} else if cell.",
				"}",
			].join("\n")

			expect(labelsOf(source, { line: 4, column: 17 })).toEqual([
				"alive",
				"age",
			])
		})

		// NOTE: A `match` wants its return Type before its block, so its head
		// is a reading of its own.
		it("should work in the head of a match", () => {
			let source = [
				"implementation {",
				"\tconstant cell = { alive = true, age = 3 }",
				"\tconstant answer = match cell.",
				"}",
			].join("\n")

			expect(labelsOf(source, { line: 3, column: 31 })).toEqual([
				"alive",
				"age",
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

		// NOTE: A Protocol's PROVIDED Methods are Methods of every conformer,
		// so they are offered beside the written ones — and withheld where the
		// Namespace wrote one of the name, which is the override rule.
		it("should list a Protocol's provided Methods beside the written ones", () => {
			let source = [
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
				"\tsquare::",
				"}",
			].join("\n")

			let labels = labelsOf(source, { line: 19, column: 10 })

			expect(labels).toContain("area")
			expect(labels).toContain("describe")
		})

		it("should list a provided Method inherited from an extended Protocol", () => {
			let source = [
				"implementation {",
				"\tprotocol Sized {",
				"\t\tsize() -> Integer",
				"",
				"\t\tisEmpty() -> Boolean {",
				"\t\t\t<- @::size()::is(0)",
				"\t\t}",
				"\t}",
				"",
				"\tprotocol Listed is Sized {",
				"\t\tfirst() -> Integer",
				"\t}",
				"",
				"\ttype Bag = { count: Integer }",
				"",
				"\tnamespace Bags for Bag is Listed {",
				"\t\tsize() -> Integer {",
				"\t\t\t<- @.count",
				"\t\t}",
				"",
				"\t\tfirst() -> Integer {",
				"\t\t\t<- 0",
				"\t\t}",
				"\t}",
				"",
				"\tconstant bag: Bag = { count = 2 }",
				"\tbag::",
				"}",
			].join("\n")

			let labels = labelsOf(source, { line: 27, column: 7 })

			expect(labels).toContain("size")
			expect(labels).toContain("first")
			expect(labels).toContain("isEmpty")
		})

		it("should offer the written Method where a Namespace overrode a provided one", () => {
			let source = [
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
				"",
				"\t\tdescribe() -> String {",
				'\t\t\t<- "a square"',
				"\t\t}",
				"\t}",
				"",
				"\tconstant square: Square = { side = 3/1 }",
				"\tsquare::",
				"}",
			].join("\n")

			let entries = findCompletions(source, {
				line: 23,
				column: 10,
			}).filter((entry) => entry.label === "describe")

			expect(entries.length).toBe(1)
		})

		it("should list the provided Methods of a bounded Type Parameter", () => {
			let source = [
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
				"\t\t<- item::",
				"\t}",
				"}",
			].join("\n")

			let labels = labelsOf(source, { line: 11, column: 12 })

			expect(labels).toContain("area")
			expect(labels).toContain("describe")
		})

		// NOTE: The builtin `for List<ItemType>` is listed first, but the call
		// dispatches to the narrower `for List<Integer>` — so listing the
		// builtin's `Optional<ItemType>` signature would describe a Method
		// that is never the one invoked.
		it("should show the signature of the Namespace the call resolves to", () => {
			let source = [
				"implementation {",
				"\tnamespace IntegerTally for List<Integer> {",
				"\t\tfirstItem() -> Integer {",
				"\t\t\t<- 0",
				"\t\t}",
				"\t}",
				"\tconstant numbers: List<Integer> = [1, 2]",
				"\tnumbers::",
				"}",
			].join("\n")

			let entries = findCompletions(source, {
				line: 8,
				column: 11,
			}).filter((entry) => entry.label === "firstItem")

			expect(entries.map((entry) => entry.detail)).toEqual([
				"() -> Integer",
			])
		})

		it("should keep every Overload where no Namespace is more specific", () => {
			let source = [
				"implementation {",
				"\tconstant numbers: List<Integer> = [1, 2]",
				"\tnumbers::",
				"}",
			].join("\n")

			let entries = findCompletions(source, {
				line: 3,
				column: 11,
			}).filter((entry) => entry.label === "firstItem")

			expect(entries.map((entry) => entry.detail)).toEqual([
				"<ItemType>() -> Optional<ItemType>",
				"<ItemType>(where: (_ ItemType) -> Boolean) -> Optional<ItemType>",
				"<ItemType>(defaultingTo: ItemType) -> ItemType",
				"<ItemType>(where: (_ ItemType) -> Boolean, defaultingTo: ItemType) -> ItemType",
			])
		})

		// NOTE: The Enricher refuses this call — a `List<Unknown>` receiver is
		// matched by both Namespaces and nothing but the Unknown would pick
		// between them. Completion is written while the receiver is still
		// undecided, though, so it keeps offering what either Namespace has:
		// going silent would answer "your Type is not known yet" with no list
		// at all, which is the least useful moment to have none.
		it("should still list Methods for an undecided receiver", () => {
			let source = [
				"implementation {",
				"\tnamespace FlatTag<infer ItemType> for List<ItemType> {",
				"\t\ttag() -> String {",
				'\t\t\t<- "flat"',
				"\t\t}",
				"\t}",
				"\tnamespace NestedTag<infer ItemType> for List<List<ItemType>> {",
				"\t\ttag() -> Integer {",
				"\t\t\t<- 1",
				"\t\t}",
				"\t}",
				"\tconstant items = []",
				"\titems::",
				"}",
			].join("\n")

			let labels = labelsOf(source, { line: 13, column: 9 })

			expect(labels).toContain("tag")
			expect(labels).toContain("isEmpty")
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

		// NOTE: Printing is derived on narrower terms than equality — the
		// Namespace has to declare `is Printable` — so Completion has to mirror
		// both halves of the rule or it offers a Method no call site can reach.
		it("should list a Choice's derived 'toString' where a Namespace declares 'is Printable'", () => {
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
				"\tred::",
				"}",
			].join("\n")

			expect(labelsOf(source, { line: 10, column: 7 })).toContain(
				"toString",
			)
		})

		it("should not list 'toString' where no Namespace declares it Printable", () => {
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

			expect(labelsOf(source, { line: 8, column: 7 })).not.toContain(
				"toString",
			)
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

		// NOTE: A `::` cursor is a Method receiver, so the probe writes one — and
		// a written value proves what it can about itself there. `4::` offers
		// the Methods of every Namespace the proof reaches, and the entry a
		// refined Namespace answers with is the one described.
		describe("on a written receiver", () => {
			const evenInteger = [
				"implementation {",
				"	type Even = Integer where @::isEven()",
				"",
				"	namespace EvenInteger for Even {",
				"		halved() -> String {",
				'			<- "half"',
				"		}",
				"	}",
				"",
			]

			it("should offer a refined Namespace's Methods", () => {
				let source = [...evenInteger, "\t4::", "}"].join("\n")

				expect(labelsOf(source, { line: 10, column: 5 })).toContain(
					"halved",
				)
			})

			it("should withhold them from a receiver the proof misses", () => {
				let source = [...evenInteger, "\t3::", "}"].join("\n")

				expect(labelsOf(source, { line: 10, column: 5 })).not.toContain(
					"halved",
				)
			})

			it("should withhold them from a computed receiver", () => {
				let source = [
					...evenInteger,
					"\tconstant four = 2::add(2)",
					"\tfour::",
					"}",
				].join("\n")

				expect(labelsOf(source, { line: 11, column: 8 })).not.toContain(
					"halved",
				)
			})

			// NOTE: The signature offered is the one the call would reach — the
			// total entry `namespace PositiveInteger` writes, and not
			// `Integer`'s, which answers an Optional for a receiver that might
			// be negative.
			it("should describe the entry the proof reaches", () => {
				let source = ["implementation {", "\t4::", "}"].join("\n")

				expect(
					entryFor(source, { line: 2, column: 5 }, "squareRoot")
						?.detail,
				).toBe("() -> PositiveInteger | Algebraic")
			})

			// NOTE: The receiver is a DIFFERENCE, which is the arithmetic no
			// refinement of Integer closes over: a sum of two written Integers
			// answers a `PositiveInteger` and would carry the proof here.
			it("should describe the base entry for a computed receiver", () => {
				let source = [
					"implementation {",
					"\tconstant four = 6::subtract(2)",
					"\tfour::",
					"}",
				].join("\n")

				expect(
					entryFor(source, { line: 3, column: 8 }, "squareRoot")
						?.detail,
				).toBe("() -> Optional<Integer | Algebraic>")
			})
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
			// NOTE: Both members are Printable and Equatable, so `toString` and
			// `is` dispatch across the Union; `add` belongs to Integer alone and
			// a String receiver would find nothing to run.
			let source = [
				"implementation {",
				"\tconstant value: Integer | String = 5",
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
			expect(labels).toContain("Terminal")
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
			expect(labels).not.toContain("Terminal")
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

	// NOTE: A member and a binding of the same name are ONE offer, not two —
	// both insert the same characters, because a bare name in a Record Literal
	// is the whole member. What the shorthand adds is the sentence saying so.
	describe("Record literal members that a binding can fill", () => {
		it("says a member can be written as its name alone", () => {
			let source = [
				"implementation {",
				"\ttype Person = { firstName: String, lastName: String }",
				'\tconstant firstName = "Ada"',
				"\tconstant person: Person = {  }",
				"}",
			].join("\n")

			let entries = findCompletions(source, { line: 4, column: 29 })

			expect(
				entries.find((entry) => entry.label === "firstName")?.detail,
			).toBe("String (or 'firstName' alone)")
			expect(
				entries.find(
					(entry) =>
						entry.label === "lastName" && entry.kind === "member",
				)?.detail,
			).toBe("String")
		})

		it("offers the member exactly once", () => {
			let source = [
				"implementation {",
				"\ttype Person = { firstName: String }",
				'\tconstant firstName = "Ada"',
				"\tconstant person: Person = {  }",
				"}",
			].join("\n")

			let entries = findCompletions(source, { line: 4, column: 29 })

			expect(
				entries.filter(
					(entry) =>
						entry.label === "firstName" && entry.kind === "member",
				),
			).toHaveLength(1)
		})

		// NOTE: The braces of an update's key list are the one member list the
		// shorthand does not reach, so the sentence must not appear there —
		// `{ base with firstName }` is refused outright. A key still being
		// typed is exactly the shape the third reading recovers, which is what
		// puts a cursor inside the list at all: the list's own span ends at its
		// last value, since it has no braces of its own to end at.
		it("says nothing of the sort inside an update's key list", () => {
			let source = [
				"implementation {",
				'\tconstant person = { firstName = "Ada", lastName = "L" }',
				'\tconstant firstName = "Grace"',
				'\tconstant renamed = { person with lastName = "M", first }',
				"}",
			].join("\n")

			let entries = findCompletions(source, { line: 4, column: 55 })

			expect(
				entries.find(
					(entry) =>
						entry.label === "firstName" && entry.kind === "member",
				)?.detail,
			).toBe("String")
		})

		// NOTE: The braced right-hand side IS a Record Literal — it is the only
		// spelling the shorthand merge has — and its members come from the LEFT
		// side's Type, which nothing else in the update supplies.
		it("offers the left side's members inside a braced right-hand side", () => {
			let source = [
				"implementation {",
				'\tconstant person = { firstName = "Ada", lastName = "L" }',
				'\tconstant firstName = "Grace"',
				"\tconstant renamed = { person with {  } }",
				"}",
			].join("\n")

			let entries = findCompletions(source, { line: 4, column: 37 })

			expect(
				entries.find((entry) => entry.label === "firstName")?.detail,
			).toBe("String (or 'firstName' alone)")
			expect(entries.map((entry) => entry.label)).toContain("lastName")
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

		// NOTE: `Number.compare(3, to Number.Pi)` — reached through the
		// Namespace the receiver rides along as the first Argument, so the
		// Self Parameter a `::` call site never writes is written here.
		//
		// NOTE: A WRITTEN Method, deliberately. A Protocol's provided Method
		// is reached through the receiver and never through the Namespace
		// spelling, so it is offered under neither name here.
		it("should keep the receiver Parameter when a Method is reached through the Namespace", () => {
			let source = ["implementation {", "\tNumber.", "}"].join("\n")

			expect(
				entryFor(source, { line: 2, column: 9 }, "compare")?.snippet,
			).toBe("compare(${1}, to ${2})")
		})

		it("should strip the receiver Parameter for the same Method through ::", () => {
			let source = ["implementation {", "\t5::", "}"].join("\n")

			expect(
				entryFor(source, { line: 2, column: 5 }, "compare")?.snippet,
			).toBe("compare(to ${1})")
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

		// NOTE: The shortest call a defaulted signature accepts is the one it
		// was given defaults for, so a TRAILING run of omittable Parameters is
		// left out of the snippet entirely. One with a required Parameter after
		// it stays: leaving it out there would put the tabstops in the wrong
		// places, since the Argument after it needs its own label written.
		it("should leave a trailing default out of the snippet", () => {
			expect(
				buildCallSnippet("scaled", {
					generics: [],
					parameterTypes: [
						{ name: null, type: { type: "Integer" } },
						{
							name: "by",
							type: { type: "Integer" },
							hasDefault: true,
						},
					],
					returnType: { type: "Integer" },
				}),
			).toBe("scaled(${1})")
		})

		it("should keep a default a required Parameter follows", () => {
			expect(
				buildCallSnippet("cut", {
					generics: [],
					parameterTypes: [
						{
							name: "from",
							type: { type: "Integer" },
							hasDefault: true,
						},
						{ name: "to", type: { type: "Integer" } },
					],
					returnType: { type: "Integer" },
				}),
			).toBe("cut(from ${1}, to ${2})")
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
				"define",
				"true",
				"false",
				"nothing",
			])
		})

		// NOTE: `as` and `otherwise` are the middle and the end of a `define`
		// arm rather than the start of an Expression, and this list is the
		// starts — see the NOTE on `expressionKeywords`.
		it("should not offer the words a define arm is continued with", () => {
			let source = ["implementation {", "\tconstant value = ", "}"].join(
				"\n",
			)

			let keywords = keywordsOf(source, { line: 2, column: 19 })

			expect(keywords).not.toContain("as")
			expect(keywords).not.toContain("otherwise")
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
			expect(labels).not.toContain("Terminal")
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
			expect(labels).not.toContain("Terminal")
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
			expect(labels).not.toContain("Terminal")
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
				"Terminal",
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
				"Terminal",
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
			expect(entryFor(source, inBody, "Terminal")?.tier).toBe(4)
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
// the same receiver with start winning the dedupe.
//
// The rule has two halves, and they need two receivers to see. `Boolean` is
// the first Namespace converted, and it shows the WITHIN-Namespace half: what
// Completion offers is the order `Boolean.es` writes its Methods in, not the
// order the Scope happened to be assembled in. It used to show the
// BETWEEN-Namespace half too — `otherwise`, `hasValue` and `isNothing`
// trailed its own Methods back when `Optional` was a Type Alias for
// `ItemType | Nothing`, which made every Type in the language an
// `Optional<…>` and put Optional's Namespace on every receiver. `Optional` is
// a nominal Choice now, a Boolean is not one, and a Boolean receiver reaches
// nothing but `Boolean`. A nested Optional carries that half instead: it is
// the receiver two converted Namespaces cover, and `builtinMemberOrder` is
// what decides which of the two is met first.
describe("Completion of a converted standard library Namespace", () => {
	it("should offer Boolean's own Methods in the order it declares them", () => {
		let source = ["implementation {", "\ttrue::", "}"].join("\n")

		// NOTE: The canonical member order — `packages/standard-library/DEVELOPMENT.md`,
		// Member order — puts the Protocol witnesses first and the Methods
		// answering a Boolean after them, so this list is `is`, `compare`,
		// `toString` and then the four operations.
		// `packages/compiler/src/tests/stdlibMemberOrder.spec.ts`
		// is what holds the sources to it.
		//
		// NOTE: And the PROVIDED Methods last, which is where they go. A
		// Namespace declares the Methods it writes and says nothing about
		// the ones a conformance hands it, so there is no position in the file to
		// read one off — they are appended per Protocol, in
		// `builtinProtocolOrder`, after everything written and everything
		// derived. A reader then meets what the Namespace says about itself
		// first, and what conforming added after it. `Equatable` comes before
		// `Comparable` in that table, so `isNot` leads the four inequalities.
		expect(labelsOf(source, { line: 2, column: 8 })).toEqual([
			"is",
			"compare",
			"toString",
			"negate",
			"and",
			"or",
			"exclusiveOr",
			"isNot",
			"isLessThan",
			"isLessThanOrEqualTo",
			"isGreaterThan",
			"isGreaterThanOrEqualTo",
		])
	})

	it("should offer Optional's own Methods ahead of the ones a nested Optional adds", () => {
		let source = [
			"implementation {",
			"\tconstant value: Optional<Optional<Integer>> = #Value(#Value(1))",
			"\tvalue::",
			"}",
		].join("\n")

		// NOTE: `flatten` sits after everything `Optional` declares because
		// `NestedOptional` is listed after `Optional` — the extra a nested
		// Optional has, offered as an extra. `is` and `isNot` sit among the
		// declared Methods, in declaration order, because `Optional` writes
		// them: the derived Namespace a Choice would otherwise offer is only
		// reached once no declared Namespace answers the name. `is`, `isNot`
		// and `hasValue` are each an Overload of two entries, and an Overload
		// completes once per entry.
		expect(labelsOf(source, { line: 3, column: 9 })).toEqual([
			"is",
			"is",
			"isNot",
			"isNot",
			"toString",
			"hasValue",
			"hasValue",
			"isEmpty",
			"value",
			"map",
			"andThen",
			"keep",
			"or",
			"pair",
			"toList",
			"toResult",
			"flatten",
		])
	})
})

// NOTE: A label a call may leave out is still offered — the writer is being
// shown what CAN be written — but it says so, and it sorts below the labels the
// call still has to write.
// NOTE: `cases` is declared by no Namespace — the Compiler derives it for a
// Choice whose Cases carry no payload — so a listing built from the written
// members alone would offer less than `Side.` answers. It is a static, and
// belongs in no `::` listing for that reason.
describe("Completion of a Choice's derived Case listing", () => {
	it("should offer the derived static on a builtin mode Choice", () => {
		let source = ["implementation {", "\tSide.", "}"].join("\n")

		expect(entryFor(source, { line: 2, column: 7 }, "cases")).toMatchObject(
			{
				kind: "staticMethod",
				detail: "() -> NonEmptyList<Side>",
			},
		)
	})

	it("should offer it on a Namespace a Program wrote over its own Choice", () => {
		let source = [
			"implementation {",
			"\tchoice Colour {",
			"\t\tRed,",
			"\t\tGreen,",
			"\t}",
			"",
			"\tnamespace Colour for Colour is Printable { }",
			"",
			"\tColour.",
			"}",
		].join("\n")

		expect(entryFor(source, { line: 9, column: 9 }, "cases")?.detail).toBe(
			"() -> NonEmptyList<Colour>",
		)
	})

	it("should not offer it through '::'", () => {
		let source = [
			"implementation {",
			"\tconstant side: Side = #Start",
			"\tside::",
			"}",
		].join("\n")

		expect(labelsOf(source, { line: 3, column: 8 })).not.toContain("cases")
	})

	it("should not offer it on a Namespace over a Choice with a payload", () => {
		let source = [
			"implementation {",
			"\tchoice Shape {",
			"\t\tCircle { radius: Integer },",
			"\t}",
			"",
			"\tnamespace Shape for Shape { }",
			"",
			"\tShape.",
			"}",
		].join("\n")

		expect(labelsOf(source, { line: 8, column: 8 })).not.toContain("cases")
	})
})

describe("Completion of a label a call may leave out", () => {
	let source = [
		"implementation {",
		"\tfunction cut (from start: Integer = 0, to end: Integer) -> Integer {",
		"\t\t<- end",
		"\t}",
		"\tcut(",
		"}",
	].join("\n")

	it("should offer it, marked as omittable", () => {
		expect(entryFor(source, { line: 5, column: 6 }, "from")?.detail).toBe(
			"Integer (may be left out)",
		)
	})

	it("should rank it below a label the call still needs", () => {
		let entries = findCompletions(source, { line: 5, column: 6 })
		let from = entries.find((entry) => entry.label === "from")
		let to = entries.find((entry) => entry.label === "to")

		expect(from?.tier).toBeGreaterThan(to!.tier)
	})
})

// NOTE: The same thing one level down. A member the Parameter's own default
// fills in is offered like any other, says so, and ranks below the members the
// Argument still has to write.
describe("Completion of a member a default fills in", () => {
	let source = [
		"implementation {",
		"	type Options = { host: String, retries: Integer }",
		"",
		"	function connect(using options: Options = { retries = 3 }) -> String {",
		"		<- options.host",
		"	}",
		"",
		"	constant open = connect(using { ",
		"}",
	].join("\n")

	it("should offer it, marked as omittable", () => {
		expect(
			entryFor(source, { line: 8, column: 34 }, "retries")?.detail,
		).toBe("Integer (may be left out)")
	})

	it("should leave a member the default does not fill in alone", () => {
		expect(entryFor(source, { line: 8, column: 34 }, "host")?.detail).toBe(
			"String",
		)
	})

	it("should rank it below a member the Argument still needs", () => {
		let entries = findCompletions(source, { line: 8, column: 34 })
		let retries = entries.find((entry) => entry.label === "retries")
		let host = entries.find((entry) => entry.label === "host")

		expect(retries?.tier).toBeGreaterThan(host!.tier)
	})
})

// NOTE: A `= expression` default is an Expression position a writer types in
// like any other. The probe walkers reached bodies only, so completion inside a
// default answered with nothing at all.
describe("Completion inside a Parameter's default", () => {
	it("should list a Record's members after a dot", () => {
		let source = [
			"implementation {",
			'	constant person = { firstName = "Ada", lastName = "Lovelace" }',
			"",
			"	function greet(_ name: String = person.) -> String {",
			"		<- name",
			"	}",
			"}",
		].join("\n")

		expect(labelsOf(source, { line: 4, column: 41 })).toEqual([
			"firstName",
			"lastName",
		])
	})

	it("should list Methods after a ::", () => {
		let source = [
			"implementation {",
			'	function greet(_ name: String = "x"::) -> String {',
			"		<- name",
			"	}",
			"}",
		].join("\n")

		expect(labelsOf(source, { line: 2, column: 39 })).toContain("trim")
	})

	// NOTE: A default is read against its own Parameter's Type, which is what
	// makes a bare Case offer that Parameter's Choice.
	it("should offer the Parameter's own Choice for a bare Case", () => {
		let source = [
			"implementation {",
			"	choice Edge {",
			"		Front,",
			"		Back,",
			"	}",
			"",
			"	function edge(at side: Edge = #) -> Edge {",
			"		<- side",
			"	}",
			"}",
		].join("\n")

		expect(labelsOf(source, { line: 7, column: 33 })).toEqual([
			"Front",
			"Back",
		])
	})
})

// NOTE: A call written inside a default is a call being written like any other,
// and the labels it may still be given are the same ones.
describe("Completion of a label inside a Parameter's default", () => {
	it("should offer the labels of a call written in a default", () => {
		let source = [
			"implementation {",
			"\tfunction cut(from start: Integer, to end: Integer) -> Integer {",
			"\t\t<- end::subtract(start)",
			"\t}",
			"",
			"\tfunction span(_ width: Integer = cut(from 0, ) -> Integer {",
			"\t\t<- width",
			"\t}",
			"}",
		].join("\n")

		expect(labelsOf(source, { line: 6, column: 46 })).toContain("to")
	})
})

// NOTE: A `#` inside a Case payload's default has an expected Type just as one
// inside a Parameter's does — the member of the payload it is filling in — and
// without the walk reaching there it has none at all.
describe("Case completion inside a Case payload default", () => {
	// NOTE: A default may name a Constant of this Module, so what is in Scope is
	// an answer here and not only what a `#` opens. Nothing in Completion knows
	// that: the default is an Expression on the walk, and a name in one probes
	// exactly as a name anywhere else does.
	it("should offer a Constant a default may name", () => {
		let source = [
			"implementation {",
			'\tconstant standardHeaders: List<String> = ["Accept"]',
			"",
			"\tchoice Fetch {",
			"\t\tGet { url: String, headers: List<String> } = { headers = stand },",
			"\t}",
			"}",
		].join("\n")

		expect(labelsOf(source, { line: 5, column: 62 })).toContain(
			"standardHeaders",
		)
	})

	it("should offer the member's own Choice after a bare #", () => {
		let source = [
			"implementation {",
			"\tchoice Edge {",
			"\t\tStart,",
			"\t\tEnd,",
			"\t}",
			"",
			"\tchoice Move {",
			"\t\tStep { at: Edge, by: Integer } = { at = # },",
			"\t}",
			"}",
		].join("\n")

		expect(labelsOf(source, { line: 8, column: 44 })).toEqual([
			"Start",
			"End",
		])
	})

	// NOTE: A leading dot needs nothing of Completion's own. It probes as
	// `.lspProbeMember` like every other dot, and the Enricher desugars the
	// path into the Function it stands for — so the probe meets an ordinary
	// member Lookup off the Parameter Type the position named. What each of
	// these pins is that the desugar keeps standing.
	describe("member paths", () => {
		let head = [
			"implementation {",
			"\ttype Maker = { town: String, founded: Integer }",
			"\ttype Product = { name: String, maker: Maker, tags: List<String> }",
			"\tconstant products: List<Product> = []",
		]

		let after = (line: string) =>
			labelsOf([...head, line, "}"].join("\n"), {
				line: head.length + 1,
				column: line.length + 1,
			})

		it("lists the members a leading dot can name", () => {
			expect(after("\tconstant x = products::map(.")).toEqual([
				"name",
				"maker",
				"tags",
			])
		})

		it("lists the members a step further in", () => {
			expect(after("\tconstant x = products::map(.maker.")).toEqual([
				"town",
				"founded",
			])
		})

		it("lists them for a path being typed", () => {
			expect(after("\tconstant x = products::map(.ma")).toEqual([
				"name",
				"maker",
				"tags",
			])
		})

		it("lists them behind a label", () => {
			expect(after("\tconstant x = products::everyItem(where .")).toEqual(
				["name", "maker", "tags"],
			)
		})

		it("lists them under an annotation", () => {
			expect(after("\tconstant f: (_: Product) -> String = .")).toEqual([
				"name",
				"maker",
				"tags",
			])
		})

		it("lists them where the Parameter Type is still being inferred", () => {
			let source = [
				...head,
				"\tfunction keyed<infer Item, infer Key>(",
				"\t\t_ items: List<Item>,",
				"\t\ton key: (_: Item) -> Key,",
				"\t) -> List<Key> {",
				"\t\t<- items::map(key)",
				"\t}",
				"\tconstant x = keyed(products, on .",
				"}",
			]

			expect(
				labelsOf(source.join("\n"), {
					line: source.length - 1,
					column: (source[source.length - 2] ?? "").length + 1,
				}),
			).toEqual(["name", "maker", "tags"])
		})

		it("offers nothing where the position names no Function", () => {
			expect(after("\tconstant x = .")).toEqual([])
			expect(after("\tconstant x = products::sort(by .")).toEqual([])
		})

		it("offers nothing off a step that has no members", () => {
			expect(after("\tconstant x = products::map(.tags.")).toEqual([])
		})
	})
})

// NOTE: A cursor in an arm stands in a `define` that has not been written to its
// end, and a `define` with no `otherwise` arm is REFUSED rather than recovered
// from — so every reading below rests on the arm tails `probe.ts` appends. Both
// halves of an arm are covered: `as VALUE if CONDITION` is two Expression
// positions, and the tail that closes the block differs between them.
describe("Completion inside a define arm", () => {
	it("should complete a Method on a receiver in an arm's value", () => {
		let source = [
			"implementation {",
			"\tfunction shout (_ name: String) -> String {",
			"\t\t<- define {",
			"\t\t\tas name::",
			'\t\t\tas "" otherwise',
			"\t\t}",
			"\t}",
			"}",
		].join("\n")

		let labels = labelsOf(source, { line: 4, column: 13 })

		expect(labels).toContain("isEmpty")
		expect(labels).toContain("hasCharacters")
	})

	it("should complete a Method on a receiver in an arm's condition", () => {
		let source = [
			"implementation {",
			"\tfunction grade (_ score: Integer) -> String {",
			"\t\t<- define {",
			'\t\t\tas "A" if score::',
			'\t\t\tas "F" otherwise',
			"\t\t}",
			"\t}",
			"}",
		].join("\n")

		let labels = labelsOf(source, { line: 4, column: 21 })

		expect(labels).toContain("add")
		expect(labels).toContain("isNot")
	})

	// NOTE: The `otherwise` arm's own value is the LAST thing written, so the
	// head truncated at the cursor has lost the word that closes the block —
	// which is the reading ` otherwise` is there for.
	it("should complete a member in the otherwise arm's value", () => {
		let source = [
			"implementation {",
			"\ttype Team = { name: String, points: Integer }",
			"\tfunction show (_ team: Team) -> String {",
			"\t\t<- define {",
			'\t\t\tas "none" if true',
			"\t\t\tas team.",
			"\t\t}",
			"\t}",
			"}",
		].join("\n")

		expect(labelsOf(source, { line: 6, column: 12 })).toEqual([
			"name",
			"points",
		])
	})

	// NOTE: An arm's own halves may open braces of their own, and then the
	// innermost `{` is no longer the `define`'s — writing the tail there closes
	// the Record Literal being typed with an arm inside it, which finishes
	// nothing, so the Parser dropped the Statement and the cursor was answered
	// by no reading at all. The `define`'s block is the one the tail belongs at
	// the end of, whether or not it is the innermost.
	it("should complete inside a brace an arm's value opened", () => {
		let source = [
			"implementation {",
			"\ttype Team = { name: String, points: Integer }",
			"\tfunction show (_ team: Team) -> { label: String } {",
			"\t\t<- define {",
			"\t\t\tas { label = team.",
			"\t\t}",
			"\t}",
			"}",
		].join("\n")

		expect(labelsOf(source, { line: 5, column: 22 })).toEqual([
			"name",
			"points",
		])
	})

	// NOTE: And a `define` written inside an arm of another one wants both
	// blocks closed — the inner by the tail the cursor needs, the outer by the
	// `otherwise` its own arm is one word short of.
	it("should complete inside a define written inside an arm", () => {
		let source = [
			"implementation {",
			"\ttype Team = { name: String, points: Integer }",
			"\tfunction show (_ team: Team) -> String {",
			"\t\t<- define {",
			"\t\t\tas define {",
			"\t\t\t\tas team.",
			"\t\t}",
			"\t}",
			"}",
		].join("\n")

		expect(labelsOf(source, { line: 6, column: 13 })).toEqual([
			"name",
			"points",
		])
	})

	// NOTE: A `#` keeps the whole document — the probe writes a stand-in Case
	// where the sigil is rather than truncating — so this reads the expected
	// Type off the arm, not off a padded tail.
	it("should offer the expected Choice's Cases in an arm's value", () => {
		let source = [
			"implementation {",
			"\tchoice Grade {",
			"\t\tPass,",
			"\t\tFail,",
			"\t}",
			"",
			"\tfunction grade (_ score: Integer) -> Grade {",
			"\t\t<- define {",
			"\t\t\tas # if score::isGreaterThan(90)",
			"\t\t\tas #Fail otherwise",
			"\t\t}",
			"\t}",
			"}",
		].join("\n")

		expect(labelsOf(source, { line: 9, column: 8 })).toEqual([
			"Pass",
			"Fail",
		])
	})
})
