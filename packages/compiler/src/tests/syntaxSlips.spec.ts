import { describe, expect, it } from "bun:test"

import type { common } from "@essence-lang/interfaces"

import { parseWithDiagnostics } from "../parser/index"

// The common ways a file is first broken: a bracket left open, one too many,
// a `{` a block needs and did not get. What matters is where each is reported,
// since a speculating Parser can answer a mistake on line 6 at a Token on line
// 4. So each slip pins the code, the sentence and the Position.
//
// Habits from other languages, such as `{ x: 0 }`, `==`, `=>`, `;` and `//`,
// are left out. They get refusals of their own where the Token is first seen.

type Slip = {
	name: string
	source: string
	code: common.DiagnosticCode
	message: string
	at: common.Cursor
	// Where the missing bracket's opener stands, for a slip noticed a line or
	// more later.
	openedAt?: common.Cursor
	// Where the `}` that took a block's brace stands, for a block left open,
	// which is reported about the block. See `outdentedClose`.
	closedAt?: common.Cursor
}

const SLIPS: Array<Slip> = [
	{
		name: "a call missing its ')'",
		source: `implementation {
	Terminal.print("hello"
	Terminal.print("after")
}`,
		code: "syntax-error",
		message: "Expected ')' but found 'Terminal'.",
		at: { line: 3, column: 2 },
		openedAt: { line: 2, column: 16 },
	},
	{
		name: "a nested call missing its ')'",
		source: `implementation {
	Terminal.print(names::map((name) { <- name::length() })
	Terminal.print("after")
}`,
		code: "syntax-error",
		message: "Expected ')' but found 'Terminal'.",
		at: { line: 3, column: 2 },
		openedAt: { line: 2, column: 16 },
	},
	{
		name: "a call missing its ')' in front of the next Statement",
		source: `implementation {
	constant sum = add(1, 2
	constant other = 3
}`,
		code: "syntax-error",
		message: "Expected ')' but found 'constant'.",
		at: { line: 3, column: 2 },
		openedAt: { line: 2, column: 20 },
	},
	{
		name: "a List missing its ']'",
		source: `implementation {
	constant names = ["ada", "alan"
	Terminal.print(names)
}`,
		code: "syntax-error",
		message: "Expected ']' but found 'Terminal'.",
		at: { line: 3, column: 2 },
		openedAt: { line: 2, column: 19 },
	},
	{
		name: "a Record missing its '}'",
		source: `implementation {
	constant point = { x = 1, y = 2
	Terminal.print(point)
}`,
		code: "syntax-error",
		message: "Expected '}' but found 'Terminal'.",
		at: { line: 3, column: 2 },
		openedAt: { line: 2, column: 19 },
	},
	{
		name: "a Function body missing its '}'",
		source: `implementation {
	function f() -> Integer {
		<- 1

	Terminal.print(2)
}`,
		code: "unclosed-block",
		message: "This block is never closed",
		at: { line: 2, column: 26 },
		closedAt: { line: 6, column: 1 },
	},
	{
		name: "a ')' where a ']' belongs",
		source: `implementation {
	constant names = ["ada", "alan")
	Terminal.print(names)
}`,
		code: "syntax-error",
		message: "Expected ']' but found ')'.",
		at: { line: 2, column: 33 },
	},
	{
		name: "a ')' too many",
		source: `implementation {
	Terminal.print("hello"))
}`,
		code: "syntax-error",
		message: "Expected an Expression but found ')'.",
		at: { line: 2, column: 25 },
	},
	{
		name: "a '}' after the end of the Program",
		source: `implementation {
	constant x = 1 }
}`,
		code: "unexpected-token",
		message: "Unexpected '}' after the end of the Program",
		at: { line: 3, column: 1 },
	},
	{
		name: "a missing ',' between Arguments",
		source: `implementation {
	constant t = slice(from 1 to 3)
}`,
		code: "syntax-error",
		message: "Expected ')' but found 'to'.",
		at: { line: 2, column: 28 },
	},
	{
		name: "a missing '{' after an 'if'",
		source: `implementation {
	if flag
		Terminal.print(1)
}`,
		code: "syntax-error",
		message: "Expected '{' but found 'Terminal'.",
		at: { line: 3, column: 3 },
	},
	{
		name: "a missing '{' after an 'else'",
		source: `implementation {
	if flag { Terminal.print(1) } else Terminal.print(2)
}`,
		code: "syntax-error",
		message: "Expected '{' but found 'Terminal'.",
		at: { line: 2, column: 37 },
	},
	{
		name: "a '<-' with no value behind it",
		source: `implementation {
	function f() -> Integer {
		<-
	}
}`,
		code: "syntax-error",
		message: "Expected an Expression but found '}'.",
		at: { line: 4, column: 2 },
	},
	{
		name: "a String that is never closed",
		source: `implementation {
	constant greeting = "Hello
	Terminal.print(greeting)
}`,
		code: "unclosed-string",
		message: "This String Literal is never closed",
		at: { line: 4, column: 2 },
		openedAt: { line: 2, column: 22 },
	},
	{
		name: "an '=' written into a call",
		source: `implementation {
	Terminal.print(greeting = "hi")
}`,
		code: "syntax-error",
		message: "Expected an Expression but found '='.",
		at: { line: 2, column: 26 },
	},
]

describe("Syntax slips", () => {
	it("should have fifteen of them", () => {
		expect(SLIPS).toHaveLength(15)
	})

	for (let slip of SLIPS) {
		describe(slip.name, () => {
			let { diagnostics } = parseWithDiagnostics(slip.source)

			it("should be the one thing reported", () => {
				expect(diagnostics).toHaveLength(1)
				expect(diagnostics[0].code).toBe(slip.code)
				expect(diagnostics[0].message).toBe(slip.message)
			})

			it("should be reported where the mistake is", () => {
				expect(diagnostics[0].position?.start).toEqual(slip.at)
			})

			if (slip.openedAt !== undefined) {
				it("should point at the bracket it is short of", () => {
					let opened = diagnostics[0].labels.find(
						(label) => label.kind === "secondary",
					)

					expect(opened?.message).toBe("opened here")
					expect(opened?.position.start).toEqual(
						slip.openedAt as common.Cursor,
					)
				})
			}

			if (slip.closedAt !== undefined) {
				it("should point at the '}' that took its brace", () => {
					let closed = diagnostics[0].labels.find(
						(label) => label.kind === "secondary",
					)

					expect(closed?.message).toBe(
						"this '}' is written further out, so it closes the block around it",
					)
					expect(closed?.position.start).toEqual(
						slip.closedAt as common.Cursor,
					)
				})
			}
		})
	}

	// Which block a `}` closes is counted, so a file one brace short hands each
	// later `}` to the enclosing block. The report must still name the inner
	// block, or its Help would put the `}` at the end of the file.
	describe("a block whose '}' another block took", () => {
		let blocks: Array<[string, string, common.Cursor, common.Cursor]> = [
			[
				"an 'if' inside the implementation",
				`implementation {
	constant count = 5

	if count::isGreaterThan(3) {
		Terminal.print("many")

	Terminal.print("done")
}`,
				{ line: 4, column: 29 },
				{ line: 8, column: 1 },
			],
			[
				"the inner of two nested 'if's",
				`implementation {
	function outer(_ n: Integer) -> Integer {
		if n::isPositive() {
			if n::isEven() {
				<- n

		<- 0
	}

	Terminal.print(outer(2))
}`,
				{ line: 4, column: 19 },
				{ line: 8, column: 2 },
			],
			[
				"a 'match' arm",
				`implementation {
	choice Light { Red, Green }

	function name(_ light: Light) -> String {
		<- match light -> String {
			case #Red {
				<- "red"

			case #Green { <- "green" }
		}
	}

	Terminal.print(name(#Red))
}`,
				{ line: 6, column: 14 },
				{ line: 10, column: 3 },
			],
		]

		for (let [name, source, opened, closed] of blocks) {
			describe(name, () => {
				// The file's one `unclosed-block`. An arm read past its missing
				// brace can add Diagnostics of its own.
				let report = parseWithDiagnostics(source).diagnostics.find(
					(diagnostic) => diagnostic.code === "unclosed-block",
				)

				it("should be reported about the block, not the end of the input", () => {
					expect(report?.position?.start).toEqual(opened)
					expect(report?.labels[0]?.message).toBe(
						"this block is never closed",
					)
				})

				it("should name the '}' that closed it instead", () => {
					expect(report?.labels[1]?.position.start).toEqual(closed)
				})

				it("should say where the brace goes", () => {
					expect(report?.helps).toEqual([
						"Write the '}' where this block's Statements end.",
					])
				})
			})
		}
	})

	// Every list answers a wrong closing bracket behind a trailing comma
	// alike, keeping the "opened here" Label.
	describe("a list closed by the wrong bracket behind a trailing comma", () => {
		let lists: Array<[string, string, string, common.Cursor]> = [
			[
				"a Record Literal",
				"implementation {\n\tconstant point = {\n\t\tx = 1,\n\t\ty = 2,\n\t)\n}",
				"Expected '}' but found ')'.",
				{ line: 2, column: 19 },
			],
			[
				"a List Literal",
				"implementation {\n\tconstant items = [\n\t\t1,\n\t\t2,\n\t)\n}",
				"Expected ']' but found ')'.",
				{ line: 2, column: 19 },
			],
			[
				"a Dictionary Literal",
				'implementation {\n\tconstant ages = [\n\t\t"a" = 1,\n\t\t"b" = 2,\n\t)\n}',
				"Expected ']' but found ')'.",
				{ line: 2, column: 18 },
			],
			[
				"an Argument list",
				"implementation {\n\tTerminal.print(\n\t\t1,\n\t\t2,\n\t]\n}",
				"Expected ')' but found ']'.",
				{ line: 2, column: 16 },
			],
			[
				"a Parameter list",
				"implementation {\n\tfunction f(\n\t\t_ a: Integer,\n\t\t_ b: Integer,\n\t] -> Integer { <- a }\n}",
				"Expected ')' but found ']'.",
				{ line: 2, column: 12 },
			],
			[
				"a Record Type",
				"implementation {\n\ttype P = {\n\t\tx: Integer,\n\t\ty: Integer,\n\t)\n}",
				"Expected '}' but found ')'.",
				{ line: 2, column: 11 },
			],
			[
				"a Choice's Cases",
				"implementation {\n\tchoice C {\n\t\tRed,\n\t\tGreen,\n\t)\n}",
				"Expected '}' but found ')'.",
				{ line: 2, column: 11 },
			],
			[
				"a Pattern",
				"implementation {\n\tconstant p = { x = 1, y = 2 }\n\tconstant {\n\t\tx,\n\t\ty,\n\t) = p\n}",
				"Expected '}' but found ')'.",
				{ line: 3, column: 11 },
			],
		]

		for (let [name, source, message, openedAt] of lists) {
			it(`should name the bracket ${name} is short of`, () => {
				let { diagnostics } = parseWithDiagnostics(source)

				expect(diagnostics).toHaveLength(1)
				expect(diagnostics[0].message).toBe(message)

				let opened = diagnostics[0].labels.find(
					(label) => label.kind === "secondary",
				)

				expect(opened?.message).toBe("opened here")
				expect(opened?.position.start).toEqual(openedAt)
			})
		}

		it("should keep a trailing comma in front of the right bracket", () => {
			let sources = [
				"implementation {\n\tconstant point = {\n\t\tx = 1,\n\t\ty = 2,\n\t}\n\tTerminal.print(point.x)\n}",
				"implementation {\n\tconstant items = [\n\t\t1,\n\t\t2,\n\t]\n\tTerminal.print(items)\n}",
				'implementation {\n\tconstant ages = [\n\t\t"a" = 1,\n\t\t"b" = 2,\n\t]\n\tTerminal.inspect(ages)\n}',
				"implementation {\n\tTerminal.print(\n\t\t1,\n\t)\n}",
				"implementation {\n\tfunction f(\n\t\t_ a: Integer,\n\t) -> Integer { <- a }\n\tTerminal.print(f(1))\n}",
				"implementation {\n\ttype P = {\n\t\tx: Integer,\n\t}\n\tconstant p: P = { x = 1 }\n\tTerminal.print(p.x)\n}",
				"implementation {\n\tchoice C {\n\t\tRed,\n\t\tGreen,\n\t}\n\tconstant c: C = #Red\n\tTerminal.print(c::is(#Red))\n}",
			]

			for (let source of sources) {
				expect(parseWithDiagnostics(source).diagnostics).toEqual([])
			}
		})
	})

	// A Comment runs to the end of its line, so none is ever left open.
	it("should end a '§' Comment at its line and never leave one open", () => {
		let sources = [
			`implementation {
	Terminal.print(1) § a note
}`,
			`implementation {
	Terminal.print(1)
}
§ a trailing note`,
		]

		for (let source of sources) {
			expect(parseWithDiagnostics(source).diagnostics).toEqual([])
		}
	})
})
