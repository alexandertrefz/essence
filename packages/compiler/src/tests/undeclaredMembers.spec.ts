import { describe, expect, it } from "bun:test"

import type { common } from "@essence-lang/interfaces"

import { analysedDiagnosticsFor, compiles } from "./followedHelps"

// A Record Literal written as an Argument or a payload names only the members
// its Type declares. A value passed along still widens. See "Undeclared
// members" in packages/compiler/src/helpers/DEVELOPMENT.md.

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
			"Remove 'draft'.",
			'constant call = Call#Post({ body = "x" })',
		],
		[
			'constant call = Call#Post({ server = "s", body = "x", draft = true })',
			"payload-type-mismatch",
			"'draft' is not a member of '#Post'",
			"Remove 'draft'.",
			'constant call = Call#Post({ server = "s", body = "x" })',
		],
		[
			'constant bound = Call#Bound({ label = "l", server = { host = "h", port = 1, extra = 2 } })',
			"payload-type-mismatch",
			"'server.extra' is not a member of Server",
			"Remove 'server.extra'.",
			'constant bound = Call#Bound({ label = "l", server = { host = "h", port = 1 } })',
		],
		[
			'constant options = connect(using { host = "z", extra = 1 })',
			"argument-type-mismatch",
			"'extra' is not a member of Options",
			"Remove 'extra'.",
			'constant options = connect(using { host = "z" })',
		],
		[
			'constant options = connect(using { retries = 1, host = "z", extra = 1 })',
			"argument-type-mismatch",
			"'extra' is not a member of Options",
			"Remove 'extra'.",
			'constant options = connect(using { retries = 1, host = "z" })',
		],
		[
			'constant name = serve({ name = "n", server = { host = "h", port = 1, extra = 2 } })',
			"argument-type-mismatch",
			"'server.extra' is not a member of Server",
			"Remove 'server.extra'.",
			'constant name = serve({ name = "n", server = { host = "h", port = 1 } })',
		],
		[
			"constant far = origin::farFrom({ x = 1, y = 2, z = 3 })",
			"no-matching-overload",
			"'z' is not a member of Point",
			"Remove 'z'.",
			"constant far = origin::farFrom({ x = 1, y = 2 })",
		],
		[
			'constant moved = { base with server = { host = "h", port = 2, extra = 3 } }',
			"partial-type-mismatch",
			"'server.extra' is not a member of Server",
			"Remove 'server.extra'.",
			'constant moved = { base with server = { host = "h", port = 2 } }',
		],
		[
			'constant moved = { base with name = "b", extra = 1 }',
			"partial-type-mismatch",
			"'extra' is not a member of Config",
			"Remove 'extra'.",
			'constant moved = { base with name = "b" }',
		],
	])("refuses %s", (written, code, label, help, followed) => {
		let errors = errorsOf(written)
		// A Label names the member, or a note where both Labels name the call.
		let named = [
			...errors[0]!.labels.map((each) => each.message),
			...errors[0]!.notes,
		]

		expect(errors.map((error) => error.code as string)).toEqual([code])
		expect(named.some((text) => text.startsWith(label))).toBe(true)
		expect(errors[0]!.helps).toEqual([help])
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

	it("still widens a value passed along", () => {
		expect(
			compiles(
				program(
					[
						'constant start: Point = { x = 1, y = 2, label = "start" }',
						'constant server = { host = "h", port = 1, extra = 2 }',
						"Terminal.print(describe(start))",
						'Terminal.print(serve({ name = "n", server }))',
						'Terminal.inspect(Call#Bound({ label = "l", server }))',
						'Terminal.print(anything({ name = "Ada" }))',
					].join("\n\t"),
				),
			),
		).toBe(true)
	})
})
