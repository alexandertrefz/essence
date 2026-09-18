import { describe, expect, it } from "bun:test"

import type { common } from "@essence-lang/interfaces"

import { parseWithDiagnostics } from "../parser/index"

// NOTE: The fifteen ways a file is first broken — a bracket left open, one too
// many, a `{` that a block needs and did not get. None of them is interesting
// on its own; what is interesting is WHERE each is reported, because a Parser
// that speculates can answer a mistake on line 6 at a Token on line 4 and be
// green in every other test it has. So each of these pins the code, the
// sentence and the Position, and a change that moves one says so here.
//
// NOTE: Deliberately no habit from another language — `{ x: 0 }`, `==`, `=>`,
// `;`, `//`. Those are answered by refusals of their own, written where the
// Token is first seen, and a corpus that pinned their generic messages would
// have to be rewritten the day each one arrives.

type Slip = {
	name: string
	source: string
	code: common.DiagnosticCode
	message: string
	at: common.Cursor
	// NOTE: Where the bracket this one is short of was opened, for the slips
	// that are noticed a line or more below it.
	openedAt?: common.Cursor
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
		at: { line: 6, column: 2 },
		openedAt: { line: 1, column: 16 },
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
		})
	}

	// NOTE: A Comment runs to the end of its line and no further, so there is
	// no such thing as one that is never closed — the question a reader coming
	// from a language with `/* … */` asks, answered by the two files below
	// parsing clean rather than by a Diagnostic that can not exist.
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
