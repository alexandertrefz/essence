import { describe, expect, it } from "bun:test"

import type { parser } from "@essence-lang/interfaces"

import { parseWithDiagnostics } from "../parser/index"
import { testDiagnostic } from "./diagnosticFactory"

describe("Parser Recovery", () => {
	it("should report zero diagnostics for a valid program", () => {
		let { diagnostics } = parseWithDiagnostics(
			`implementation {
				constant x = 1
				function f (value: Number) -> Number {
					<- value
				}
				f(x)
			}`,
		)

		expect(diagnostics).toEqual([])
	})

	it("should report a positioned diagnostic for an unexpected token", () => {
		let { diagnostics } = parseWithDiagnostics(
			"implementation { constant x 1 }",
		)

		expect(diagnostics).toEqual([
			testDiagnostic({
				severity: "error",
				message: "Expected '=' but found '1'.",
				position: {
					start: { line: 1, column: 29 },
					end: { line: 1, column: 30 },
				},
				code: "syntax-error",
				labels: [
					{
						position: {
							start: { line: 1, column: 29 },
							end: { line: 1, column: 30 },
						},
						message: "expected '='",
						kind: "primary",
					},
				],
			}),
		])
	})

	it("should keep parsing statements after a broken statement", () => {
		let { program, diagnostics } = parseWithDiagnostics(
			`implementation {
				constant x =
				constant y = 5
			}`,
		)

		expect(diagnostics).toHaveLength(1)
		expect(diagnostics[0].severity).toBe("error")
		expect(diagnostics[0].message).toBe(
			"Expected an Expression but found 'constant'.",
		)

		let nodes = program.implementation.nodes

		expect(nodes).toHaveLength(1)
		expect(nodes[0].nodeType).toBe("ConstantDeclarationStatement")

		if (nodes[0].nodeType === "ConstantDeclarationStatement") {
			expect((nodes[0].name as parser.IdentifierNode).content).toBe("y")
			expect(nodes[0].value.nodeType).toBe("IntegerValue")
		}
	})

	it("should keep statements that parsed before the broken statement", () => {
		let { program, diagnostics } = parseWithDiagnostics(
			`implementation {
				constant x = 1
				variable y =
			}`,
		)

		expect(diagnostics).toHaveLength(1)

		let nodes = program.implementation.nodes

		expect(nodes).toHaveLength(1)
		expect(nodes[0].nodeType).toBe("ConstantDeclarationStatement")
	})

	it("should recover inside nested blocks", () => {
		let { program, diagnostics } = parseWithDiagnostics(
			`implementation {
				function f (value: Number) -> Number {
					constant broken 5
					<- value
				}
			}`,
		)

		expect(diagnostics).toHaveLength(1)

		let nodes = program.implementation.nodes

		expect(nodes).toHaveLength(1)
		expect(nodes[0].nodeType).toBe("FunctionStatement")

		if (nodes[0].nodeType === "FunctionStatement") {
			expect(nodes[0].value.body).toHaveLength(1)
			expect(nodes[0].value.body[0].nodeType).toBe("ReturnStatement")
		}
	})

	it("should report exactly one diagnostic per broken statement", () => {
		let { program, diagnostics } = parseWithDiagnostics(
			`implementation {
				constant x =
				constant y = 5
				variable z 10
				variable w = 6
			}`,
		)

		expect(diagnostics).toHaveLength(2)
		expect(diagnostics[0].message).toBe(
			"Expected an Expression but found 'constant'.",
		)
		expect(diagnostics[1].message).toBe("Expected '=' but found '10'.")

		let nodes = program.implementation.nodes

		expect(nodes).toHaveLength(2)
		expect(nodes[0].nodeType).toBe("ConstantDeclarationStatement")
		expect(nodes[1].nodeType).toBe("VariableDeclarationStatement")
	})

	it("should report a torn-open block once and terminate", () => {
		let { program, diagnostics } = parseWithDiagnostics(
			`implementation {
				function f (value: Number) -> Number {
					<- value`,
		)

		expect(diagnostics).toHaveLength(1)
		expect(diagnostics[0].code).toBe("unclosed-block")

		let nodes = program.implementation.nodes

		expect(nodes).toHaveLength(1)
		expect(nodes[0].nodeType).toBe("FunctionStatement")
	})

	it("should report an unterminated String Literal once", () => {
		let { diagnostics } = parseWithDiagnostics(
			'implementation { constant x = "abc }',
		)

		expect(diagnostics).toHaveLength(1)
		expect(diagnostics[0].severity).toBe("error")
		expect(diagnostics[0].code).toBe("unclosed-string")
		expect(diagnostics[0].position).not.toBeNull()
	})

	it("should point an unterminated String Literal at the end of the input and at its quote", () => {
		let { diagnostics } = parseWithDiagnostics(
			'implementation {\nconstant x = "abc\n}',
		)

		expect(diagnostics).toHaveLength(1)
		expect(diagnostics[0].code).toBe("unclosed-string")
		expect(diagnostics[0].position).toEqual({
			start: { line: 3, column: 2 },
			end: { line: 3, column: 2 },
		})
		expect(diagnostics[0].labels).toHaveLength(2)
		expect(diagnostics[0].labels[0]).toMatchObject({
			kind: "primary",
			message: "the input ends here",
		})
		expect(diagnostics[0].labels[1]).toMatchObject({
			kind: "secondary",
			message: "opened here",
			position: {
				start: { line: 2, column: 14 },
				end: { line: 2, column: 15 },
			},
		})
	})

	// NOTE: The Lexer stops one line PAST the last one when the file ends in a
	// newline — a label there has no text to point at and renders dangling, so
	// the position is clamped to just after the last visible character.
	it("should keep an unterminated String Literal's label on the last line of content", () => {
		let { diagnostics } = parseWithDiagnostics(
			'implementation {\nconstant x = "abc\n}\n',
		)

		expect(diagnostics).toHaveLength(1)
		expect(diagnostics[0].code).toBe("unclosed-string")
		expect(diagnostics[0].position).toEqual({
			start: { line: 3, column: 2 },
			end: { line: 3, column: 2 },
		})
	})

	it("should keep reporting after a speculative parse ran to the end of the input", () => {
		// NOTE: The speculative reading of `f(g(match …` runs to the end of
		// the input during its own recovery and latches the suppression that
		// keeps cascades quiet — `backtrack` has to unlatch it along with
		// everything else, or the whole broken file parses in silence.
		let { program, diagnostics } = parseWithDiagnostics(
			`implementation {
	variable u: Integer | String = 1
	Terminal.print(99)
	constant x = f(g(match u -> Integer { case Integer { <- 1 } case String { <- 2`,
		)

		expect(diagnostics.length).toBeGreaterThan(0)
		expect(
			diagnostics.some((diagnostic) => diagnostic.severity === "error"),
		).toBeTrue()
		expect(program.implementation.nodes).toHaveLength(3)
	})

	it("should refuse nesting past the depth limit with a Diagnostic instead of overflowing", () => {
		let source = `implementation { constant x = ${"[".repeat(20000)}1${"]".repeat(20000)} }`

		let { diagnostics } = parseWithDiagnostics(source)

		expect(diagnostics).toHaveLength(1)
		expect(diagnostics[0].severity).toBe("error")
		expect(diagnostics[0].code).toBe("nesting-too-deep")
		expect(diagnostics[0].position).not.toBeNull()
		expect(diagnostics[0].notes.length).toBeGreaterThan(0)
		expect(diagnostics[0].helps.length).toBeGreaterThan(0)
	})

	it("should parse ordinary nesting nowhere near the limit unbothered", () => {
		let source = `implementation { constant x = ${"[".repeat(100)}1${"]".repeat(100)} }`

		let { diagnostics } = parseWithDiagnostics(source)

		expect(diagnostics).toEqual([])
	})

	// NOTE: The budget is shared across Expressions, Types and blocks because
	// the three recur into each other on the one call stack — so it has to be
	// wide enough that a machine-generated file (a serialized tree nests one
	// level per node) does not spend it on a single construct, and that blocks
	// and Expressions merely SUMMING past a few hundred levels stay a program
	// rather than an error.
	it("should parse machine-generated nesting several hundred levels deep", () => {
		let source = `implementation { constant x = ${"[".repeat(600)}1${"]".repeat(600)} }`

		let { diagnostics } = parseWithDiagnostics(source)

		expect(diagnostics).toEqual([])
	})

	it("should parse blocks and Expressions whose depths sum past a few hundred", () => {
		let source = `implementation { ${"if true { ".repeat(300)}constant x = ${"[".repeat(200)}1${"]".repeat(200)} ${"}".repeat(300)} }`

		let { diagnostics } = parseWithDiagnostics(source)

		expect(diagnostics).toEqual([])
	})

	it("should report a missing implementation section", () => {
		let { program, diagnostics } = parseWithDiagnostics("constant x = 1")

		expect(diagnostics).toHaveLength(1)
		expect(diagnostics[0].message).toBe(
			"Expected 'implementation' but found 'constant'.",
		)
		expect(program.implementation.nodes).toHaveLength(0)
	})

	it("should recover from a broken match handler", () => {
		let { program, diagnostics } = parseWithDiagnostics(
			`implementation {
				constant x = match 1 -> Number {
					case : {}
					case Number { <- 2 }
				}
				constant y = 3
			}`,
		)

		expect(diagnostics).toHaveLength(1)

		let nodes = program.implementation.nodes

		expect(nodes).toHaveLength(2)
		expect(nodes[0].nodeType).toBe("ConstantDeclarationStatement")
		expect(nodes[1].nodeType).toBe("ConstantDeclarationStatement")

		if (nodes[0].nodeType === "ConstantDeclarationStatement") {
			expect(nodes[0].value.nodeType).toBe("Match")

			if (nodes[0].value.nodeType === "Match") {
				expect(nodes[0].value.handlers).toHaveLength(1)
			}
		}
	})

	it("should ask for 'is' before each conformance", () => {
		let { diagnostics } = parseWithDiagnostics(
			`implementation {
				namespace IntegerEquatable for Integer is Equatable, Printable {}
			}`,
		)

		expect(diagnostics).toHaveLength(1)
		expect(diagnostics[0].severity).toBe("error")
		expect(diagnostics[0].message).toBe(
			"Each conformance needs its own 'is' — write 'is Equatable, is Printable'",
		)
		expect(diagnostics[0].labels).toHaveLength(1)
		expect(diagnostics[0].labels[0]?.kind).toBe("primary")
		expect(diagnostics[0].labels[0]?.message).toBe(
			"expected 'is' before this Protocol",
		)
	})

	it("should ask for a condition after where", () => {
		let { diagnostics } = parseWithDiagnostics(
			`implementation {
				namespace Box<infer Item> for List<Item> is Comparable where {}
			}`,
		)

		expect(diagnostics).toHaveLength(1)
		expect(diagnostics[0].severity).toBe("error")
		expect(diagnostics[0].message).toBe(
			"Expected an Identifier but found '{'.",
		)
	})

	it("should ask for is in a where condition", () => {
		let { diagnostics } = parseWithDiagnostics(
			`implementation {
				namespace Box<infer Item> for List<Item> is Comparable where Item Comparable {}
			}`,
		)

		expect(diagnostics).toHaveLength(1)
		expect(diagnostics[0].severity).toBe("error")
		expect(diagnostics[0].message).toBe(
			"A 'where' condition reads 'Generic is Protocol'",
		)
		expect(diagnostics[0].labels[0]?.message).toBe("expected 'is' here")
	})

	it("should recover from a broken Generic list", () => {
		let { program, diagnostics } = parseWithDiagnostics(
			`implementation {
				namespace Broken<infer for List<Item> {
					first() -> Optional<Item> {
						<- @::firstItem()
					}
				}
				constant y = 3
			}`,
		)

		expect(diagnostics).toHaveLength(1)
		expect(diagnostics[0].severity).toBe("error")

		let nodes = program.implementation.nodes

		expect(nodes).toHaveLength(1)
		expect(nodes[0].nodeType).toBe("ConstantDeclarationStatement")

		if (nodes[0].nodeType === "ConstantDeclarationStatement") {
			expect((nodes[0].name as parser.IdentifierNode).content).toBe("y")
		}
	})
})
