import { describe, expect, it } from "bun:test"

import type { parser } from "@essence/interfaces"

import { containsErrors } from "../diagnostics/index"
import { parseWithDiagnostics } from "../parser/index"

// NOTE: The Diagnostics the Lexer and the Parser report about a Program that
// is wrong in a way they can still read past — a Number holding letters, a
// name defined twice. Each of these was once accepted in silence, which is
// what makes them worth a test of their own: the Program compiled, and did
// something other than what it said.

function firstNode(source: string): parser.ImplementationNode | undefined {
	return parseWithDiagnostics(source).program.implementation.nodes[0]
}

function declaredValue(
	node: parser.ImplementationNode | undefined,
): parser.ExpressionNode | undefined {
	if (node?.nodeType !== "ConstantDeclarationStatement") {
		return undefined
	}

	return node.value
}

describe("Parser Diagnostics", () => {
	describe("Number Literals", () => {
		it("should report a Number Literal that holds letters", () => {
			let { diagnostics } = parseWithDiagnostics(
				"implementation { __print(0xFF::toString()) }",
			)

			expect(diagnostics).toHaveLength(1)
			expect(diagnostics[0].severity).toBe("error")
			expect(diagnostics[0].code).toBe("invalid-number")
			expect(diagnostics[0].message).toBe("'0xFF' is not a valid Number")
			expect(diagnostics[0].labels).toHaveLength(1)
			expect(diagnostics[0].labels[0]?.kind).toBe("primary")
			expect(diagnostics[0].position).toEqual({
				start: { line: 1, column: 26 },
				end: { line: 1, column: 30 },
			})
		})

		it("should report an exponent form instead of failing in the Rewriter", () => {
			let { program, diagnostics } = parseWithDiagnostics(
				`implementation {
					constant x = 1e5
					constant y = 5
				}`,
			)

			expect(diagnostics).toHaveLength(1)
			expect(diagnostics[0].code).toBe("invalid-number")

			// NOTE: The malformed Literal ends its own Token and nothing else —
			// the Statements around it are read as written, and the Token that
			// is left behind holds digits, so no later stage sees `1e5`.
			let nodes = program.implementation.nodes

			expect(nodes).toHaveLength(2)
			expect(declaredValue(nodes[0])).toMatchObject({
				nodeType: "IntegerValue",
				value: "1",
			})
		})

		it("should not report a Number written in digits", () => {
			let { diagnostics } = parseWithDiagnostics(
				"implementation { 1_000_000 }",
			)

			expect(diagnostics).toEqual([])
		})
	})

	describe("Number Literal joining", () => {
		it("should not join a '_' group on the next line", () => {
			let { program, diagnostics } = parseWithDiagnostics(
				`implementation {
					constant x = 1
_ 2
				}`,
			)

			expect(containsErrors(diagnostics)).toBe(true)
			expect(
				declaredValue(program.implementation.nodes[0]),
			).toMatchObject({
				nodeType: "IntegerValue",
				value: "1",
			})
		})

		it("should not join a '/' denominator on the next line", () => {
			let { program, diagnostics } = parseWithDiagnostics(
				`implementation {
					constant a = 1
/ 2
				}`,
			)

			expect(containsErrors(diagnostics)).toBe(true)
			expect(
				declaredValue(program.implementation.nodes[0]),
			).toMatchObject({
				nodeType: "IntegerValue",
				value: "1",
			})
		})

		it("should not join a '_' group written apart on one line", () => {
			let { program, diagnostics } = parseWithDiagnostics(
				"implementation { constant x = 1 _ 000 }",
			)

			expect(containsErrors(diagnostics)).toBe(true)
			expect(
				declaredValue(program.implementation.nodes[0]),
			).toMatchObject({
				nodeType: "IntegerValue",
				value: "1",
			})
		})

		it("should not join a '/' denominator written apart on one line", () => {
			let { program, diagnostics } = parseWithDiagnostics(
				"implementation { constant a = 3 / 2 }",
			)

			expect(containsErrors(diagnostics)).toBe(true)
			expect(
				declaredValue(program.implementation.nodes[0]),
			).toMatchObject({
				nodeType: "IntegerValue",
				value: "3",
			})
		})

		it("should join the parts of a Number written flush", () => {
			let { program, diagnostics } = parseWithDiagnostics(
				"implementation { constant a = 1_000/9 }",
			)

			expect(diagnostics).toEqual([])
			expect(
				declaredValue(program.implementation.nodes[0]),
			).toMatchObject({
				nodeType: "RationalValue",
				numerator: "1000",
				denominator: "9",
			})
		})
	})

	describe("Record Matchers", () => {
		it("should report a member value that is not a literal", () => {
			let { diagnostics } = parseWithDiagnostics(
				`implementation {
					constant expected = 5
					constant result = match value -> String {
						case { size = expected } { <- "matched" }
						case _ { <- "other" }
					}
				}`,
			)

			expect(diagnostics).toHaveLength(1)
			expect(diagnostics[0].severity).toBe("error")
			expect(diagnostics[0].code).toBe("syntax-error")
			expect(diagnostics[0].message).toBe(
				"Expected a literal value but found 'expected'.",
			)
			expect(diagnostics[0].labels[0]?.message).toBe(
				"expected a Number, a String, a Boolean or 'nothing'",
			)
		})

		it("should report a member value that is a Case", () => {
			let { diagnostics } = parseWithDiagnostics(
				`implementation {
					constant result = match value -> String {
						case { state = #Open } { <- "open" }
						case _ { <- "other" }
					}
				}`,
			)

			expect(diagnostics).toHaveLength(1)
			expect(diagnostics[0].code).toBe("syntax-error")
			expect(diagnostics[0].message).toBe(
				"Expected a literal value but found '#'.",
			)
		})

		it("should parse the literal member values", () => {
			let { diagnostics } = parseWithDiagnostics(
				`implementation {
					constant result = match value -> String {
						case { size = 5, name = "a", flag = true } { <- "one" }
						case { size = -3/2, missing = nothing } { <- "two" }
						case { size: Integer } { <- "three" }
						case _ { <- "other" }
					}
				}`,
			)

			expect(diagnostics).toEqual([])
		})
	})

	describe("Error Recovery", () => {
		it("should resynchronise on a protocol declaration", () => {
			let { program, diagnostics } = parseWithDiagnostics(
				`implementation {
					constant broken =
					protocol Sizeable {
						size () -> Integer
					}
					constant fine = 5
				}`,
			)

			expect(diagnostics).toHaveLength(1)
			expect(diagnostics[0].message).toBe(
				"Expected an Expression but found 'protocol'.",
			)

			// NOTE: The Protocol survives the broken Statement above it —
			// skipping it would take every `is Sizeable` in the file down with
			// it, none of which is what went wrong.
			let nodes = program.implementation.nodes

			expect(nodes).toHaveLength(2)
			expect(nodes[0].nodeType).toBe("ProtocolDeclarationStatement")
			expect(nodes[1].nodeType).toBe("ConstantDeclarationStatement")
		})
	})

	describe("Duplicate Definitions", () => {
		it("should report a Method defined twice in a Namespace", () => {
			let { diagnostics } = parseWithDiagnostics(
				`implementation {
					namespace Ladder for Integer {
						steps (_ count: Integer) -> Integer {
							<- @::steps(count)
						}

						steps () -> Integer {
							<- @
						}
					}
				}`,
			)

			expect(diagnostics).toHaveLength(1)
			expect(diagnostics[0].severity).toBe("error")
			expect(diagnostics[0].code).toBe("duplicate-method")
			expect(diagnostics[0].message).toBe(
				"Method 'steps' is already defined",
			)
			expect(diagnostics[0].labels).toHaveLength(2)
			expect(diagnostics[0].labels[0]?.kind).toBe("primary")
			expect(diagnostics[0].labels[1]?.kind).toBe("secondary")
			expect(diagnostics[0].helps).toHaveLength(1)
		})

		it("should report a static Method that shares a Method's name", () => {
			let { diagnostics } = parseWithDiagnostics(
				`implementation {
					namespace Ladder for Integer {
						steps () -> Integer {
							<- @
						}

						static steps () -> Integer {
							<- 0
						}
					}
				}`,
			)

			expect(diagnostics).toHaveLength(1)
			expect(diagnostics[0].code).toBe("duplicate-method")
		})

		it("should report an overload block that shares a Method's name", () => {
			let { diagnostics } = parseWithDiagnostics(
				`implementation {
					namespace Ladder for Integer {
						steps () -> Integer {
							<- @
						}

						overload steps {
							(_ count: Integer) -> Integer {
								<- count
							}
						}
					}
				}`,
			)

			expect(diagnostics).toHaveLength(1)
			expect(diagnostics[0].code).toBe("duplicate-method")
		})

		it("should report a Method signature defined twice in a Protocol", () => {
			let { diagnostics } = parseWithDiagnostics(
				`implementation {
					protocol Sizeable {
						size () -> Integer
						size () -> String
					}
				}`,
			)

			expect(diagnostics).toHaveLength(1)
			expect(diagnostics[0].code).toBe("duplicate-method")
			expect(diagnostics[0].message).toBe(
				"Method 'size' is already defined",
			)
		})

		it("should report a static Property defined twice", () => {
			let { diagnostics } = parseWithDiagnostics(
				`implementation {
					namespace Ladder for Integer {
						static rungs = 3
						static rungs = 4
					}
				}`,
			)

			expect(diagnostics).toHaveLength(1)
			expect(diagnostics[0].code).toBe("duplicate-property")
			expect(diagnostics[0].message).toBe(
				"Property 'rungs' is already defined",
			)
		})

		it("should not report a Property and a Method sharing a name", () => {
			// NOTE: They are built into two separate name-keyed Records, so
			// neither definition is lost — the Parser has nothing to report.
			let { diagnostics } = parseWithDiagnostics(
				`implementation {
					namespace Ladder for Integer {
						static rungs = 3

						rungs () -> Integer {
							<- @
						}
					}
				}`,
			)

			expect(diagnostics).toEqual([])
		})

		it("should report a Record Literal member written twice", () => {
			let { diagnostics } = parseWithDiagnostics(
				`implementation {
					constant r = { a = noisy(), a = 2 }
				}`,
			)

			expect(diagnostics).toHaveLength(1)
			expect(diagnostics[0].severity).toBe("error")
			expect(diagnostics[0].code).toBe("duplicate-member")
			expect(diagnostics[0].message).toBe("Member 'a' is already defined")
			expect(diagnostics[0].labels).toHaveLength(2)
		})

		it("should report a member written twice in a Combination", () => {
			let { diagnostics } = parseWithDiagnostics(
				`implementation {
					constant base = { a = 1 }
					constant r = { base with a = 1, a = 2 }
				}`,
			)

			expect(diagnostics).toHaveLength(1)
			expect(diagnostics[0].code).toBe("duplicate-member")
		})

		it("should report a Record Type member written twice", () => {
			let { diagnostics } = parseWithDiagnostics(
				`implementation {
					type Broken = { a: Integer, a: String }
				}`,
			)

			expect(diagnostics).toHaveLength(1)
			expect(diagnostics[0].code).toBe("duplicate-member")
		})

		it("should report a Record Matcher member written twice", () => {
			let { diagnostics } = parseWithDiagnostics(
				`implementation {
					constant result = match value -> String {
						case { a: Integer, a = 5 } { <- "one" }
						case _ { <- "other" }
					}
				}`,
			)

			expect(diagnostics).toHaveLength(1)
			expect(diagnostics[0].code).toBe("duplicate-member")
		})

		it("should not report members that only differ in kind", () => {
			let { diagnostics } = parseWithDiagnostics(
				`implementation {
					constant r = { a = 1, b = 2 }
					type T = { a: Integer, b: String }
				}`,
			)

			expect(diagnostics).toEqual([])
		})
	})

	describe("Speculative parsing", () => {
		it("should report a duplicate in an annotation exactly once", () => {
			let { diagnostics } = parseWithDiagnostics(
				`implementation {
					constant x: { a: Integer, a: String } = 5
				}`,
			)

			expect(diagnostics).toHaveLength(1)
			expect(diagnostics[0].code).toBe("duplicate-member")
		})

		it("should not report a Diagnostic from a reading it threw away", () => {
			// NOTE: A Record in Expression position is first tried as a typed
			// Record Literal, which reads `{ a: Integer, a: String }` as a
			// Record Type — duplicate and all — before failing on the missing
			// `~>`. That reading was thrown away, so what it found about it
			// must be thrown away with it; only the error of the reading that
			// was kept is left.
			let { diagnostics } = parseWithDiagnostics(
				`implementation {
					{ a: Integer, a: String }
				}`,
			)

			expect(diagnostics).toHaveLength(1)
			expect(diagnostics[0].code).toBe("syntax-error")
		})
	})
})

describe("Parser AST", () => {
	it("should keep a Number Literal whole when it is written flush", () => {
		expect(
			declaredValue(firstNode("implementation { constant x = 1_000 }")),
		).toMatchObject({ nodeType: "IntegerValue", value: "1000" })
	})
})
