import { describe, expect, it } from "bun:test"

import type { common } from "@essence-lang/interfaces"

import { analysedDiagnosticsFor, compiles } from "./followedHelps"

// A Record Literal written where a Type is declared names only the members that
// Type declares. A value passed along still widens. See "Undeclared members" in
// packages/compiler/src/helpers/DEVELOPMENT.md.

const declarations = `
	type Options = { retries: Integer, host: String }
	type Server = { host: String, port: Integer }
	type Config = { name: String, server: Server }
	type Point = { x: Integer, y: Integer }

	function connect(using settings: Options = { retries = 3 }) -> Options {
		<- settings
	}

	function serve(_ config: Config) -> String {
		<- config.name
	}

	function describe(_ point: Point) -> String {
		<- "({point.x}, {point.y})"
	}

	function anything(_ value: {}) -> String {
		<- "any"
	}

	function countAll(_ rows: List<{ a: Integer }>) -> Integer {
		<- rows::length()
	}

	function sized(_ rows: Dictionary<String, { a: Integer }>) -> Integer {
		<- 1
	}

	function applyOne(_ make: (_: Integer) -> { a: Integer }) -> { a: Integer } {
		<- make(1)
	}

	choice Call {
		Post { server: String, body: String } = { server = "localhost" },
		Bound { label: String, server: Server },
	}

	namespace Points for Point {
		farFrom(_ other: Point) -> Boolean {
			<- @.x::isGreaterThan(other.x)
		}
	}

	constant base: Config = { name = "a", server = { host = "h", port = 1 } }
	constant origin: Point = { x = 0, y = 0 }
`

function program(statement: string): string {
	return `implementation {${declarations}\n\t${statement}\n}`
}

function errorsOf(statement: string): Array<common.Diagnostic> {
	return analysedDiagnosticsFor(program(statement)).filter(
		(diagnostic) => diagnostic.severity === "error",
	)
}

describe("Undeclared members", () => {
	// Each refusal names the member, and following its Help compiles.
	it.each([
		[
			'constant call = Call#Post({ body = "x", draft = true })',
			"payload-type-mismatch",
			"'draft' is not a member of '#Post'",
			["Remove 'draft'."],
			'constant call = Call#Post({ body = "x" })',
		],
		[
			'constant call = Call#Post({ server = "s", body = "x", draft = true })',
			"payload-type-mismatch",
			"'draft' is not a member of '#Post'",
			["Remove 'draft'."],
			'constant call = Call#Post({ server = "s", body = "x" })',
		],
		[
			'constant bound = Call#Bound({ label = "l", server = { host = "h", port = 1, extra = 2 } })',
			"payload-type-mismatch",
			"'server.extra' is not a member of Server",
			["Remove 'server.extra'."],
			'constant bound = Call#Bound({ label = "l", server = { host = "h", port = 1 } })',
		],
		// A shorthand payload's path is the reader's, not the Case's member.
		[
			"constant held: Optional<{ a: Integer }> = #Value({ a = 1, b = 2 })",
			"payload-type-mismatch",
			"'b' is not a member of",
			["Remove 'b'."],
			"constant held: Optional<{ a: Integer }> = #Value({ a = 1 })",
		],
		[
			"constant held: { o: Optional<{ a: Integer }> } = { o = #Value({ a = 1, b = 2 }) }",
			"payload-type-mismatch",
			"'b' is not a member of",
			["Remove 'b'."],
			"constant held: { o: Optional<{ a: Integer }> } = { o = #Value({ a = 1 }) }",
		],
		[
			'constant options = connect(using { host = "z", extra = 1 })',
			"argument-type-mismatch",
			"'extra' is not a member of Options",
			["Remove 'extra'."],
			'constant options = connect(using { host = "z" })',
		],
		[
			'constant options = connect(using { retries = 1, host = "z", extra = 1 })',
			"argument-type-mismatch",
			"'extra' is not a member of Options",
			["Remove 'extra'."],
			'constant options = connect(using { retries = 1, host = "z" })',
		],
		[
			'constant name = serve({ name = "n", server = { host = "h", port = 1, extra = 2 } })',
			"argument-type-mismatch",
			"'server.extra' is not a member of Server",
			["Remove 'server.extra'."],
			'constant name = serve({ name = "n", server = { host = "h", port = 1 } })',
		],
		[
			"constant count = countAll([{ a = 1, b = 2 }])",
			"argument-type-mismatch",
			"'b' is not a member of",
			["Remove 'b'."],
			"constant count = countAll([{ a = 1 }])",
		],
		[
			'constant count = sized(["k" = { a = 1, b = 2 }])',
			"argument-type-mismatch",
			"'b' is not a member of",
			["Remove 'b'."],
			'constant count = sized(["k" = { a = 1 }])',
		],
		[
			"constant far = origin::farFrom({ x = 1, y = 2, z = 3 })",
			"no-matching-overload",
			"'z' is not a member of Point",
			["Remove 'z'."],
			"constant far = origin::farFrom({ x = 1, y = 2 })",
		],
		// A bound generic Method is held to its bound Type.
		[
			"constant points = [origin]::append({ x = 1, y = 2, z = 3 })",
			"no-matching-overload",
			"'z' is not a member of Point",
			["Remove 'z'."],
			"constant points = [origin]::append({ x = 1, y = 2 })",
		],
		[
			"function first(on row: { a: Integer } = { a = 1, b = 2 }) -> Integer {\n\t\t<- row.a\n\t}",
			"default-type-mismatch",
			"'b' is not a member of",
			["Remove 'b'.", "Write a value of Type { a: Integer }."],
			"function first(on row: { a: Integer } = { a = 1 }) -> Integer {\n\t\t<- row.a\n\t}",
		],
		[
			'constant start: Point = { x = 1, y = 2, label = "start" }',
			"assignment-type-mismatch",
			"'label' is not a member of",
			["Remove 'label'."],
			"constant start: Point = { x = 1, y = 2 }",
		],
		[
			"constant points: List<Point> = [{ x = 1, y = 2, z = 3 }]",
			"assignment-type-mismatch",
			"'z' is not a member of",
			["Remove 'z'."],
			"constant points: List<Point> = [{ x = 1, y = 2 }]",
		],
		[
			"variable at: Point = { x = 1, y = 2, z = 3 }",
			"assignment-type-mismatch",
			"'z' is not a member of",
			["Remove 'z'."],
			"variable at: Point = { x = 1, y = 2 }",
		],
		[
			"variable at: Point = origin\n\tat = { x = 1, y = 2, z = 3 }",
			"assignment-type-mismatch",
			"'z' is not a member of",
			["Remove 'z'."],
			"variable at: Point = origin\n\tat = { x = 1, y = 2 }",
		],
		[
			"function made() -> Point {\n\t\t<- { x = 1, y = 2, z = 3 }\n\t}",
			"return-type-mismatch",
			"'z' is not a member of",
			["Remove 'z'."],
			"function made() -> Point {\n\t\t<- { x = 1, y = 2 }\n\t}",
		],
		// A `define` answers with each arm, so each is held to the Type.
		[
			"constant p: { a: Integer } = define {\n\t\tas { a = 1, b = 2 } if true\n\t\tas { a = 2 } otherwise\n\t}",
			"assignment-type-mismatch",
			"'b' is not a member of",
			["Remove 'b'."],
			"constant p: { a: Integer } = define {\n\t\tas { a = 1 } if true\n\t\tas { a = 2 } otherwise\n\t}",
		],
		[
			"function made() -> { a: Integer } {\n\t\t<- define {\n\t\t\tas { a = 1, b = 2 } if true\n\t\t\tas { a = 2 } otherwise\n\t\t}\n\t}",
			"return-type-mismatch",
			"'b' is not a member of",
			["Remove 'b'."],
			"function made() -> { a: Integer } {\n\t\t<- define {\n\t\t\tas { a = 1 } if true\n\t\t\tas { a = 2 } otherwise\n\t\t}\n\t}",
		],
		[
			"constant count = countAll([define {\n\t\tas { a = 1, b = 2 } if true\n\t\tas { a = 2 } otherwise\n\t}])",
			"argument-type-mismatch",
			"'b' is not a member of",
			["Remove 'b'."],
			"constant count = countAll([define {\n\t\tas { a = 1 } if true\n\t\tas { a = 2 } otherwise\n\t}])",
		],
		[
			"variable at: { a: Integer } = { a = 1 }\n\tat = define {\n\t\tas { a = 1, b = 2 } if true\n\t\tas { a = 2 } otherwise\n\t}",
			"assignment-type-mismatch",
			"'b' is not a member of",
			["Remove 'b'."],
			"variable at: { a: Integer } = { a = 1 }\n\tat = define {\n\t\tas { a = 1 } if true\n\t\tas { a = 2 } otherwise\n\t}",
		],
		[
			"constant arrowed = define -> { a: Integer } {\n\t\tas { a = 1, b = 2 } if true\n\t\tas { a = 2 } otherwise\n\t}",
			"return-type-mismatch",
			"'b' is not a member of",
			["Remove 'b'."],
			"constant arrowed = define -> { a: Integer } {\n\t\tas { a = 1 } if true\n\t\tas { a = 2 } otherwise\n\t}",
		],
		// The signature a literal is passed to fixed its return Type.
		[
			"constant applied = applyOne((x) { <- { a = x, b = 1 } })",
			"return-type-mismatch",
			"'b' is not a member of",
			["Remove 'b'."],
			"constant applied = applyOne((x) { <- { a = x } })",
		],
		[
			'constant moved = { base with server = { host = "h", port = 2, extra = 3 } }',
			"partial-type-mismatch",
			"'server.extra' is not a member of Server",
			["Remove 'server.extra'."],
			'constant moved = { base with server = { host = "h", port = 2 } }',
		],
		[
			'constant moved = { base with name = "b", extra = 1 }',
			"partial-type-mismatch",
			"'extra' is not a member of Config",
			["Remove 'extra'."],
			'constant moved = { base with name = "b" }',
		],
	])("refuses %s", (written, code, label, helps, followed) => {
		let errors = errorsOf(written)
		// A Label names the member, or a note where both Labels name the call.
		let named = [
			...errors[0]!.labels.map((each) => each.message),
			...errors[0]!.notes,
		]

		expect(errors.map((error) => error.code as string)).toEqual([code])
		expect(named.some((text) => text.startsWith(label))).toBe(true)
		expect(errors[0]!.helps).toEqual(helps)
		expect(compiles(program(followed))).toBe(true)
	})

	// A misspelled member is named as the near miss, with no Help to remove
	// it and no word about the shorthand.
	it("answers a misspelled payload member with its near miss alone", () => {
		let errors = errorsOf('constant call = Call#Post({ bod = "x" })')

		expect(errors.map((error) => error.helps)).toEqual([
			["Did you mean 'body'?"],
		])
	})

	// A literal answers to the shape its Parameter declared, Type Parameters
	// left open, whichever Argument bound them first.
	it.each([
		"function apply<infer T>(_ x: T, _ f: (_: T) -> { a: T }) -> { a: T } {\n\t\t<- f(x)\n\t}\n\tconstant applied = apply(1, (x) { <- { a = x, b = 2 } })",
		"function apply<infer T>(_ f: (_: Integer) -> { a: T }, _ x: T) -> { a: T } {\n\t\t<- f(1)\n\t}\n\tconstant applied = apply((x) { <- { a = x, b = 2 } }, 5)",
	])("refuses what a declared return shape lacks in %s", (written) => {
		let errors = errorsOf(written)

		expect(errors.map((error) => [error.code, error.helps])).toEqual([
			["return-type-mismatch", ["Remove 'b'."]],
		])
		expect(compiles(program(written.replace(", b = 2", "")))).toBe(true)
	})

	// A bare Type Parameter declares nothing, so the literal's own Record is
	// what it binds.
	it("leaves a return the signature leaves open to width", () => {
		expect(
			compiles(
				program(
					[
						"function twice<infer T>(_ x: T, _ f: (_: T) -> T) -> T {",
						"\t<- f(f(x))",
						"}",
						"constant start: { a: Integer } = { a = 1 }",
						"constant twiced = twice(start, (r) { <- { a = r.a::add(1), b = 9 } })",
						"constant summed = [1, 2]::reduce(startingWith { total = 0 }, (sum, x) {",
						"\t<- { total = sum.total::add(x), extra = 1 }",
						"})",
						"Terminal.inspect([twiced])",
						"Terminal.inspect([summed])",
					].join("\n\t"),
				),
			),
		).toBe(true)
	})

	// Where no Type is declared, the Literal's own Type is the one it has.
	it("leaves a Type worked out from the value to width", () => {
		expect(
			compiles(
				program(
					[
						"constant loose = define {",
						"\tas { a = 1, b = 2 } if true",
						"\tas { a = 2 } otherwise",
						"}",
						"constant mapped = [1, 2]::map((x) { <- { a = x, b = 1 } })",
						"constant mixed = [1, 2]::map((x) {",
						"\tif x::isEven() {",
						"\t\t<- { a = x }",
						"\t}",
						"",
						"\t<- { a = x, b = 1 }",
						"})",
						"Terminal.inspect([loose])",
						"Terminal.inspect([mapped, mixed])",
					].join("\n\t"),
				),
			),
		).toBe(true)
	})

	it("still widens a value passed along", () => {
		expect(
			compiles(
				program(
					[
						'constant labelled = { x = 1, y = 2, label = "start" }',
						"constant start: Point = labelled",
						"variable at: Point = labelled",
						"at = labelled",
						"constant points: List<Point> = [labelled]",
						'constant server = { host = "h", port = 1, extra = 2 }',
						"Terminal.print(describe(start))",
						'Terminal.print(serve({ name = "n", server }))',
						'Terminal.inspect(Call#Bound({ label = "l", server }))',
						'Terminal.print(anything({ name = "Ada" }))',
						"Terminal.inspect(points)",
					].join("\n\t"),
				),
			),
		).toBe(true)
	})
})

// A written Union may take a wider Record arm in by width. That arm's members
// are still declared, at the top and below it, and in an update.
describe("Undeclared members of a written Union", () => {
	let shapes = `implementation {
	type Shape = { kind: String } | { kind: String, radius: Integer }
	type Nested = { a: Integer, b: { x: Integer } } | { a: Integer, b: { x: Integer, y: Integer } }

	function kindOf(_ shape: Shape) -> String {
		<- shape.kind
	}

	function aOf(_ nested: Nested) -> Integer {
		<- nested.a
	}

	constant held: Nested = { a = 1, b = { x = 1 } }
`

	it("takes a member any written arm declares", () => {
		expect(
			compiles(`${shapes}
	constant circle: Shape = { kind = "circle", radius = 2 }
	constant moved = { held with b = { x = 2, y = 3 } }

	Terminal.print(kindOf({ kind = "circle", radius = 2 }))
	Terminal.print(aOf({ a = 1, b = { x = 2, y = 3 } }))
	Terminal.print(kindOf(circle))
	Terminal.print(moved.a)
}`),
		).toBe(true)
	})

	// A written Union named inside another keeps the arms it took in, in
	// either order, and beside a wider arm of its own.
	it.each([
		"Shape | { kind: String }",
		"{ kind: String } | Shape",
		"Shape | { kind: String, color: String }",
	])("keeps the written arms of %s", (union) => {
		expect(
			compiles(`${shapes}
	type Again = ${union}

	constant circle: Again = { kind = "c", radius = 2 }

	Terminal.print(circle.kind)
}`),
		).toBe(true)
	})

	// Only what no arm declares is named, and a Type Parameter a wider arm
	// mentions is still left to be inferred.
	it("names only what no written arm declares", () => {
		let errors = analysedDiagnosticsFor(`${shapes}
	type Box<T> = { kind: String } | { kind: String, value: T }

	function kindIn<infer T>(_ box: Box<T>) -> String {
		<- box.kind
	}

	constant extra: Shape = { kind = "c", radius = 2, extra = 1 }
	constant boxed = kindIn({ kind = "c", value = 2 })
}`).filter((diagnostic) => diagnostic.severity === "error")

		expect(
			errors.map((error) => [
				error.code,
				error.labels.map((label) => label.message),
				error.helps,
			]),
		).toEqual([
			[
				"assignment-type-mismatch",
				["'extra' is not a member of Shape"],
				["Remove 'extra'."],
			],
			[
				"uninferable-type-parameter",
				["nothing here determines what it binds to"],
				[
					"Give the Type Parameter a place among the Parameters, so that an Argument binds it.",
				],
			],
		])
	})

	it("refuses a member no written arm declares", () => {
		let errors = analysedDiagnosticsFor(`${shapes}
	constant sized = kindOf({ kind = "circle", size = 2 })
	constant deep = aOf({ a = 1, b = { x = 2, z = 3 } })
}`).filter((diagnostic) => diagnostic.severity === "error")

		expect(errors.map((error) => error.helps)).toEqual([
			["Remove 'size'."],
			["Remove 'b.z'."],
		])
	})
})
