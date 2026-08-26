import { describe, expect, it } from "bun:test"

import type { parser } from "@essence-lang/interfaces"

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
				"implementation { Terminal.inspect(0xFF::toString()) }",
			)

			expect(diagnostics).toHaveLength(1)
			expect(diagnostics[0].severity).toBe("error")
			expect(diagnostics[0].code).toBe("invalid-number")
			expect(diagnostics[0].message).toBe("'0xFF' is not a valid Number")
			expect(diagnostics[0].labels).toHaveLength(1)
			expect(diagnostics[0].labels[0]?.kind).toBe("primary")
			expect(diagnostics[0].position).toEqual({
				start: { line: 1, column: 35 },
				end: { line: 1, column: 39 },
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

	describe("String escapes", () => {
		it("should report an unknown escape without truncating the String", () => {
			let { program, diagnostics } = parseWithDiagnostics(
				`implementation {
					constant x = "bad \\q here"
					constant y = 5
				}`,
			)

			expect(diagnostics).toHaveLength(1)
			expect(diagnostics[0].severity).toBe("error")
			expect(diagnostics[0].code).toBe("invalid-escape")

			// NOTE: The bad escape ends nothing — the character is read as itself
			// and the Statements around it are read as written.
			let nodes = program.implementation.nodes
			expect(nodes).toHaveLength(2)
			expect(declaredValue(nodes[0])).toMatchObject({
				nodeType: "StringValue",
				value: "bad q here",
			})
		})

		it("should not report a known escape", () => {
			let { diagnostics } = parseWithDiagnostics(
				'implementation { constant x = "a\\nb\\t\\"c\\\\d\\{e\\}" }',
			)

			expect(diagnostics).toEqual([])
		})
	})

	describe("Interpolation holes", () => {
		it("should refuse a Comment inside a hole without swallowing the String", () => {
			let { program, diagnostics } = parseWithDiagnostics(
				`implementation {
	constant s = "a{ 1 § note }"
	constant t = 2
}`,
			)

			expect(diagnostics).toHaveLength(1)
			expect(diagnostics[0].severity).toBe("error")
			expect(diagnostics[0].code).toBe("comment-in-hole")
			expect(diagnostics[0].position).toEqual({
				start: { line: 2, column: 21 },
				end: { line: 2, column: 28 },
			})

			// NOTE: The Comment ends at the hole's '}', so the String closes
			// where it was written and the Statement after it survives.
			let nodes = program.implementation.nodes

			expect(nodes).toHaveLength(2)
			expect(declaredValue(nodes[1])).toMatchObject({
				nodeType: "IntegerValue",
				value: "2",
			})
		})
	})

	describe("Line endings", () => {
		it("should parse a file with Windows line endings", () => {
			let { diagnostics } = parseWithDiagnostics(
				"implementation {\r\n\tconstant x = 1\r\n}\r\n",
			)

			expect(diagnostics).toEqual([])
		})

		it("should parse a file opening with a byte order mark", () => {
			let { diagnostics } = parseWithDiagnostics(
				"\uFEFFimplementation { constant x = 1 }",
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

		it("should not join the ':' of a Method call written apart", () => {
			let { diagnostics } = parseWithDiagnostics(
				"implementation { constant x = a :  : b() }",
			)

			expect(containsErrors(diagnostics)).toBe(true)
		})

		it("should not join the ':' of a Method call split across lines", () => {
			let { diagnostics } = parseWithDiagnostics(
				`implementation {
					constant x = a :
: b()
				}`,
			)

			expect(containsErrors(diagnostics)).toBe(true)
		})

		it("should read a '::' written flush as a Method call", () => {
			let { program, diagnostics } = parseWithDiagnostics(
				"implementation { constant x = a::b() }",
			)

			expect(diagnostics).toEqual([])
			expect(
				declaredValue(program.implementation.nodes[0]),
			).toMatchObject({ nodeType: "MethodInvocation" })
		})
	})

	// NOTE: A decimal is a Rational written a second way, so what these hold
	// the Parser to is the FRACTION each spelling stands for — there is no
	// Node of its own to check, and no scale on the side: `1.50` and `1.5` are
	// two ways of writing one value, and both reduce to it on read.
	describe("Decimal Literals", () => {
		let numberOf = (source: string) =>
			declaredValue(
				firstNode(`implementation { constant a = ${source} }`),
			)

		it("should read a decimal as its fraction", () => {
			expect(numberOf("0.75")).toMatchObject({
				nodeType: "RationalValue",
				numerator: "75",
				denominator: "100",
			})
			expect(numberOf("19.99")).toMatchObject({
				nodeType: "RationalValue",
				numerator: "1999",
				denominator: "100",
			})
		})

		it("should keep the sign on the numerator", () => {
			expect(numberOf("-0.5")).toMatchObject({
				nodeType: "RationalValue",
				numerator: "-5",
				denominator: "10",
			})
		})

		// NOTE: `2.0` is a Rational the way `4/2` is one — the spelling says
		// what was written, and the runtime reduces it on read.
		it("should read a whole decimal as a Rational", () => {
			expect(numberOf("2.0")).toMatchObject({
				nodeType: "RationalValue",
				numerator: "20",
				denominator: "10",
			})
		})

		// NOTE: No scale is kept, so `1.50` and `1.5` are the same value —
		// which is what makes `1.50::is(1.5)` true.
		it("should keep a trailing zero out of the value", () => {
			expect(numberOf("1.50")).toMatchObject({
				nodeType: "RationalValue",
				numerator: "150",
				denominator: "100",
			})
		})

		it("should join '_' groups on both sides of the point", () => {
			expect(numberOf("1_000.000_1")).toMatchObject({
				nodeType: "RationalValue",
				numerator: "10000001",
				denominator: "10000",
			})
		})

		// NOTE: The numerator goes through `BigInt`, because every stage
		// behind the Parser reads it as plain digits — the Optimiser folds a
		// Literal only where it matches `/^-?[0-9]+$/`, and the Rewriter hands
		// the string straight to `BigInt`.
		it("should normalise a leading zero out of the numerator", () => {
			expect(numberOf("0.05")).toMatchObject({
				nodeType: "RationalValue",
				numerator: "5",
				denominator: "100",
			})
		})

		it("should leave no sign on a zero", () => {
			expect(numberOf("-0.0")).toMatchObject({
				nodeType: "RationalValue",
				numerator: "0",
				denominator: "10",
			})
		})

		it("should span the Literal from its sign to its last digit", () => {
			let { diagnostics } = parseWithDiagnostics(
				"implementation { constant a = -0.5 }",
			)

			expect(diagnostics).toEqual([])
			expect(numberOf("-0.5")).toMatchObject({
				position: {
					start: { line: 1, column: 31 },
					end: { line: 1, column: 35 },
				},
			})
		})

		it("should refuse a fraction written onto a decimal", () => {
			let { diagnostics } = parseWithDiagnostics(
				"implementation { constant a = 1.5/2 }",
			)

			expect(diagnostics).toHaveLength(1)
			expect(diagnostics[0].code).toBe("mixed-rational-literal")
			expect(diagnostics[0].labels[0]?.message).toBe(
				"'/' can not follow a decimal",
			)
			// NOTE: The whole Literal is underlined, not the tail alone — the
			// tail is read before it is refused so that nothing is left behind
			// to be read again as a Statement of its own.
			expect(diagnostics[0].position).toEqual({
				start: { line: 1, column: 31 },
				end: { line: 1, column: 36 },
			})
		})

		it("should refuse a decimal written onto a fraction", () => {
			let { diagnostics } = parseWithDiagnostics(
				"implementation { constant a = 1/2.5 }",
			)

			expect(diagnostics).toHaveLength(1)
			expect(diagnostics[0].code).toBe("mixed-rational-literal")
			expect(diagnostics[0].labels[0]?.message).toBe(
				"'.' can not follow a fraction",
			)
		})

		it("should refuse a decimal with nothing before the point", () => {
			let { diagnostics } = parseWithDiagnostics(
				"implementation { constant a = .5 }",
			)

			expect(diagnostics).toHaveLength(1)
			expect(diagnostics[0].code).toBe("partial-decimal-literal")
			expect(diagnostics[0].message).toBe(
				"A decimal Literal has digits on both sides of the dot",
			)
			expect(diagnostics[0].labels[0]?.message).toBe(
				"nothing stands before the point",
			)
			expect(diagnostics[0].helps).toContain(
				"Write the digits before the point: '0.5'.",
			)
		})

		it("should refuse a decimal with nothing behind the point", () => {
			let { diagnostics } = parseWithDiagnostics(
				"implementation { constant a = 1. }",
			)

			expect(diagnostics).toHaveLength(1)
			expect(diagnostics[0].code).toBe("partial-decimal-literal")
			expect(diagnostics[0].labels[0]?.message).toBe(
				"no digits stand flush behind the point",
			)
			expect(diagnostics[0].helps).toContain(
				"Write the digits behind the point: '1.0'.",
			)
		})

		// NOTE: The digits have to be flush against the point, exactly as the
		// denominator of `1/2` has to be flush against the `/`.
		it("should refuse digits pushed off the point", () => {
			let { diagnostics } = parseWithDiagnostics(
				"implementation { constant a = 1. 5 }",
			)

			expect(diagnostics[0].code).toBe("partial-decimal-literal")
		})

		it("should not read a spaced '.' as a decimal point", () => {
			for (let source of ["1 . 5", "1 .5"]) {
				let { program, diagnostics } = parseWithDiagnostics(
					`implementation { constant a = ${source} }`,
				)

				expect(containsErrors(diagnostics)).toBe(true)
				expect(
					diagnostics.some(
						(diagnostic) =>
							diagnostic.code === "partial-decimal-literal",
					),
				).toBe(false)
				expect(
					JSON.stringify(program.implementation.nodes),
				).not.toContain("RationalValue")
			}
		})

		// NOTE: The reading a decimal must not take away. A flush `.` behind
		// an Integer opened a Lookup long before decimals existed, and it
		// still does wherever a member name rather than digits follows it.
		it("should still read a flush member off an Integer", () => {
			let { program, diagnostics } = parseWithDiagnostics(
				"implementation { constant a = 1.foo }",
			)

			expect(diagnostics).toEqual([])
			expect(
				declaredValue(program.implementation.nodes[0]),
			).toMatchObject({ nodeType: "Lookup" })
		})

		it("should still read a flush member off a fraction", () => {
			let { program, diagnostics } = parseWithDiagnostics(
				"implementation { constant a = 1/2.foo }",
			)

			expect(diagnostics).toEqual([])
			expect(
				declaredValue(program.implementation.nodes[0]),
			).toMatchObject({ nodeType: "Lookup" })
		})

		// NOTE: A `.` that opens an Expression is still a member path — the
		// refusal above it reads the digits, and nothing else.
		it("should still read a member path", () => {
			let { program, diagnostics } = parseWithDiagnostics(
				"implementation { constant a = .price }",
			)

			expect(diagnostics).toEqual([])
			expect(
				declaredValue(program.implementation.nodes[0]),
			).toMatchObject({ nodeType: "MemberPath" })
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
				"expected a Number, a String or a Boolean",
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

		// NOTE: `nothing` is no longer a Literal — it is not even a Keyword —
		// so it reaches this the same way any other bare name does, and is
		// turned away for the same reason `expected` is above. Pinned on its
		// own because it used to be accepted here, and a Matcher that silently
		// started reading `nothing` as a Constant lookup would invert what the
		// `case` was written to say.
		it("should report 'nothing' as a member value, now that it is an ordinary Identifier", () => {
			let { diagnostics } = parseWithDiagnostics(
				`implementation {
					constant result = match value -> String {
						case { missing = nothing } { <- "missing" }
						case _ { <- "other" }
					}
				}`,
			)

			expect(diagnostics).toHaveLength(1)
			expect(diagnostics[0].severity).toBe("error")
			expect(diagnostics[0].code).toBe("syntax-error")
			expect(diagnostics[0].message).toBe(
				"Expected a literal value but found 'nothing'.",
			)
		})

		it("should parse the literal member values", () => {
			let { diagnostics } = parseWithDiagnostics(
				`implementation {
					constant result = match value -> String {
						case { size = 5, name = "a", flag = true } { <- "one" }
						case { size = -3/2, flag = false } { <- "two" }
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

	describe("Documentation", () => {
		it("should report a tag that runs into its text", () => {
			let { diagnostics } = parseWithDiagnostics(
				`implementation {
§§ @param subject who to greet
function greet(subject: String) -> String { <- subject }
}`,
			)

			expect(diagnostics).toHaveLength(1)
			expect(diagnostics[0].severity).toBe("warning")
			expect(diagnostics[0].code).toBe("missing-documentation-separator")
			expect(diagnostics[0].message).toBe(
				"This '@param' tag is not separated from its text",
			)
			expect(diagnostics[0].helps).toEqual([
				"Write '@param subject —' before the text.",
			])
			// NOTE: The text alone, rather than the whole Comment — the
			// em-dash is missing exactly where 'who' begins.
			expect(diagnostics[0].position).toEqual({
				start: { line: 2, column: 19 },
				end: { line: 2, column: 31 },
			})
		})

		it("should report nothing for a separated or a bare tag", () => {
			let { diagnostics } = parseWithDiagnostics(
				`implementation {
§§ @param subject — who to greet
§§ @returns
§§ the greeting
function greet(subject: String) -> String { <- subject }
}`,
			)

			expect(diagnostics).toEqual([])
		})

		it("should report a tag it read only once", () => {
			// NOTE: The Documentation of a Declaration inside a Namespace is
			// reached through readings the Parser abandons; the Diagnostic
			// must survive the kept one exactly once all the same.
			let { diagnostics } = parseWithDiagnostics(
				`implementation {
namespace Greeting for String {
§§ @returns the greeting
greet() -> String { <- @ }
}
}`,
			)

			expect(diagnostics).toHaveLength(1)
			expect(diagnostics[0].code).toBe("missing-documentation-separator")
			expect(diagnostics[0].helps).toEqual([
				"Write '@returns —' before the text.",
			])
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

	it("should span a Combination from brace to brace", () => {
		// NOTE: Like the Record Literal branches — the Formatter reads the
		// span as the braces it claims trailing trivia behind, so a span
		// ending before the closing brace left a Comment on the '}' line
		// unclaimed and made it refuse the file.
		let node = declaredValue(
			firstNode(
				`implementation { constant a = { base with
	x = 1,
	y = 2
} }`,
			),
		)

		expect(node).toMatchObject({ nodeType: "Combination" })
		expect(node?.position).toEqual({
			start: { line: 1, column: 31 },
			end: { line: 4, column: 2 },
		})
	})

	describe("Member paths", () => {
		it("should refuse a Method call after a path", () => {
			let { diagnostics } = parseWithDiagnostics(
				"implementation { call(.total::rounded()) }",
			)

			expect(diagnostics).toHaveLength(1)
			expect(diagnostics[0].code).toBe("path-is-members-only")
			expect(diagnostics[0].labels[0]?.message).toBe(
				"'::' can not follow a path",
			)
			expect(diagnostics[0].labels[0]?.position).toEqual({
				start: { line: 1, column: 29 },
				end: { line: 1, column: 30 },
			})
		})

		it("should refuse an invocation after a path", () => {
			let { diagnostics } = parseWithDiagnostics(
				"implementation { call(.total()) }",
			)

			expect(diagnostics).toHaveLength(1)
			expect(diagnostics[0].code).toBe("path-is-members-only")
			expect(diagnostics[0].labels[0]?.message).toBe(
				"'(' can not follow a path",
			)
		})

		// NOTE: Two colons written apart are not a `::` anywhere else in the
		// grammar, and they are not one here either — the refusal reads the
		// lexeme, not the Token.
		it("should leave a spaced colon pair to the rest of the grammar", () => {
			let { diagnostics } = parseWithDiagnostics(
				"implementation { call(.total : :rounded()) }",
			)

			expect(
				diagnostics.some(
					(diagnostic) => diagnostic.code === "path-is-members-only",
				),
			).toBe(false)
		})

		it("should refuse a brace where a step was expected", () => {
			let { diagnostics } = parseWithDiagnostics(
				"implementation { call(.total.{ a = 1 }) }",
			)

			expect(diagnostics).toHaveLength(1)
			expect(diagnostics[0].message).toBe(
				"Expected an Identifier but found '{'.",
			)
		})
	})

	it("should span an Expression Combination from brace to brace", () => {
		let node = declaredValue(
			firstNode("implementation { constant a = { base with other } }"),
		)

		expect(node).toMatchObject({ nodeType: "Combination" })
		expect(node?.position).toEqual({
			start: { line: 1, column: 31 },
			end: { line: 1, column: 50 },
		})
	})
})
