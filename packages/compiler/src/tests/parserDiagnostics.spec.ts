import { describe, expect, it } from "bun:test"

import type { common, parser } from "@essence-lang/interfaces"

import { containsErrors } from "../diagnostics/index"
import { enrich } from "../enricher/index"
import { parseWithDiagnostics } from "../parser/index"

// NOTE: The Diagnostics the Lexer and the Parser report about a Program that
// is wrong in a way they can still read past — a Number holding letters, a
// name defined twice. Each of these was once accepted in silence, which is
// what makes them worth a test of their own: the Program compiled, and did
// something other than what it said.

function firstNode(source: string): parser.ImplementationNode | undefined {
	return parseWithDiagnostics(source).program.implementation.nodes[0]
}

function helpsOf(source: string): Array<string> {
	return parseWithDiagnostics(source).diagnostics.flatMap(
		(diagnostic) => diagnostic.helps,
	)
}

// NOTE: What a Help promises, checked by compiling it. Enriched as well as
// parsed, because a Help that reads cleanly and then fails a name lookup has
// sent a reader from one refusal to the next.
function compiles(source: string): boolean {
	let parsed = parseWithDiagnostics(source)

	if (containsErrors(parsed.diagnostics)) {
		return false
	}

	return !containsErrors(enrich(parsed.program).diagnostics)
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

	// NOTE: The Lexer reads the whole file before the Parser reads a Token of
	// it, so everything the Lexer had to say stood above everything the Parser
	// did, whatever line each of them was about — a bad escape on line 4 printed
	// over a Number on line 2. Reading a report is reading a file.
	describe("The order a report is read in", () => {
		it("should print the Diagnostics in the order the lines are written", () => {
			let { diagnostics } = parseWithDiagnostics(
				`implementation {
	constant n = 0xFF
	constant m = 1e5
	constant s = "bad \\q here"
	constant t = 2px
}`,
			)

			expect(
				diagnostics.map((diagnostic) => [
					diagnostic.code,
					diagnostic.position?.start.line,
				]),
			).toEqual([
				["invalid-number", 2],
				["invalid-number", 3],
				["invalid-escape", 4],
				["invalid-number", 5],
			])
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

		// NOTE: The Statement is DROPPED rather than left holding the `3` alone,
		// because a `/` behind a finished Expression on its own line is division
		// written the way another language writes it — see `foreignTextAhead`.
		// What the joining rule claims is unchanged: the two parts did not become
		// a Rational.
		it("should not join a '/' denominator written apart on one line", () => {
			let { program, diagnostics } = parseWithDiagnostics(
				"implementation { constant a = 3 / 2 }",
			)

			expect(diagnostics.map((diagnostic) => diagnostic.code)).toEqual([
				"operator-not-supported",
			])
			expect(program.implementation.nodes).toEqual([])
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
			//
			// NOTE: That error is the `:` standing where a Record Literal's `=`
			// belongs, which is a refusal of the text and travels out of the
			// speculation rather than being given back — the duplicate the
			// abandoned reading found is still nowhere in the report, which is
			// the whole of what this is about.
			let { diagnostics } = parseWithDiagnostics(
				`implementation {
					{ a: Integer, a: String }
				}`,
			)

			expect(diagnostics).toHaveLength(1)
			expect(diagnostics[0].code).toBe("foreign-syntax")
		})

		// NOTE: `{ x = .5 }` is read as a Record Literal first and as a
		// Combination second, and it is the FIRST reading that meets the
		// half-written decimal. A refusal carrying a code is a verdict about
		// the text rather than "this reading was not the one written", so the
		// speculation lets it through instead of giving it back: without that
		// the author was answered "Expected 'with' but found '='" — a message
		// from the reading that never reached the Literal at all.
		it("should let a coded refusal out of the reading that met it", () => {
			let { diagnostics } = parseWithDiagnostics(
				"implementation { constant a = { x = .5 } }",
			)

			expect(diagnostics).toHaveLength(1)
			expect(diagnostics[0].code).toBe("partial-decimal-literal")
			expect(diagnostics[0].message).toBe(
				"A decimal Literal has digits on both sides of the dot",
			)
			expect(diagnostics[0].position).toEqual({
				start: { line: 1, column: 37 },
				end: { line: 1, column: 39 },
			})
		})

		it("should refuse every half-written Rational in a member value", () => {
			let members: Array<[string, common.DiagnosticCode]> = [
				["{ x = .5 }", "partial-decimal-literal"],
				["{ x = 1. }", "partial-decimal-literal"],
				["{ x = 1.5/2 }", "mixed-rational-literal"],
				["{ x = 1/2.5 }", "mixed-rational-literal"],
			]

			for (let [member, code] of members) {
				let { diagnostics } = parseWithDiagnostics(
					`implementation { constant a = ${member} }`,
				)

				expect(diagnostics).toHaveLength(1)
				expect(diagnostics[0].code).toBe(code)
			}
		})

		// NOTE: The constructs a Record Literal stands inside — an Argument, a
		// Case payload, a typed Record Literal, an item of a List, the members
		// of a `with` — each of which reads it through at least one
		// speculation, and one that nests two of them, where the refusal has
		// to travel out of both to be reported once.
		it("should refuse it wherever the Record Literal stands", () => {
			let expressions = [
				"f({ x = .5 })",
				"f(g({ x = .5 }))",
				"#Full({ x = .5 })",
				"Point ~> { x = .5 }",
				"[{ x = .5 }]",
				"{ base with x = .5 }",
			]

			for (let expression of expressions) {
				let { diagnostics } = parseWithDiagnostics(
					`implementation { constant a = ${expression} }`,
				)

				expect(diagnostics).toHaveLength(1)
				expect(diagnostics[0].code).toBe("partial-decimal-literal")
			}
		})

		// NOTE: `require MATCHER = EXPR` reads its Matcher speculatively and
		// reads an Expression where that is not what was written, so a Record
		// Matcher's member values stand behind a speculation too — and both
		// readings meet the same Literal.
		it("should refuse a half-written decimal in a Record Matcher", () => {
			let { diagnostics } = parseWithDiagnostics(
				`implementation { }
				tests {
					test "prices" {
						require { price = 1. } = order
					}
				}`,
			)

			expect(diagnostics).toHaveLength(1)
			expect(diagnostics[0].code).toBe("partial-decimal-literal")
		})

		// NOTE: A path is refused where it is READ, which inside a member
		// value is inside the Record Literal reading.
		it("should refuse a call on a path in a member value", () => {
			for (let member of [
				"{ x = .price::rounded() }",
				"{ x = .total() }",
			]) {
				let { diagnostics } = parseWithDiagnostics(
					`implementation { constant a = ${member} }`,
				)

				expect(diagnostics).toHaveLength(1)
				expect(diagnostics[0].code).toBe("path-is-members-only")
			}
		})

		// NOTE: The other half of the rule. A generic failure IS "this reading
		// was not the one written", so it is still given back and the readings
		// behind it still run — and both of these are refused by the LAST of
		// them, at the `=` of the first member, which is the Token the update
		// reading needs a `with` at and nobody wrote either of these files
		// about. What is reported is the reading that got FURTHEST instead: the
		// Literal one, which died on the member value, where the mistake is.
		it("should still give a generic failure back to the next reading", () => {
			let members: Array<[string, string]> = [
				["{ x = ] }", "Expected an Expression but found ']'."],
				["{ x = y. }", "Expected an Identifier but found '}'."],
			]

			for (let [member, message] of members) {
				let { diagnostics } = parseWithDiagnostics(
					`implementation { constant a = ${member} }`,
				)

				expect(diagnostics).toHaveLength(1)
				expect(diagnostics[0].code).toBe("syntax-error")
				expect(diagnostics[0].message).toBe(message)
			}
		})

		// NOTE: The shapes the speculations are there for, read together so
		// that one of them turning into an error is a failure here rather than
		// a snapshot nobody looks at twice.
		it("should still read the shapes the speculations are there for", () => {
			let { program, diagnostics } = parseWithDiagnostics(
				`implementation {
					constant a = { x = 1 }
					constant b = { a with x = 2 }
					constant c = Point ~> { x = 3 }
					constant d = Holder<Integer>#Full(1)
				}`,
			)

			expect(diagnostics).toEqual([])
			expect(
				program.implementation.nodes.map(
					(node) => declaredValue(node)?.nodeType,
				),
			).toEqual([
				"RecordValue",
				"Combination",
				"RecordValue",
				"CaseValue",
			])
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

	// NOTE: Where several readings of one piece of text all fail, the one
	// reported is the one that got FURTHEST — not the last one tried, which is
	// the fallback and by construction the reading that got least far. Each of
	// these was answered, before that rule, at the Token the FALLBACK died on:
	// two Tokens into a Statement whose mistake is four lines below it.
	describe("The furthest reading", () => {
		// NOTE: The unlabelled reading of `names::map(…)` spans the Argument and
		// runs on to the `Terminal` of the next Statement; the labelled reading
		// behind it takes `names` for a label and dies on the `:` of the `::`.
		// That `:` is what a missing ')' used to be reported at.
		it("should report a call missing its ')' at the call, not at a label", () => {
			let { diagnostics } = parseWithDiagnostics(
				`implementation {
	constant names = ["ada", "alan"]

	Terminal.print(names::map((name) { <- name::length() })

	Terminal.print("after")
}`,
			)

			expect(diagnostics).toHaveLength(1)
			expect(diagnostics[0].code).toBe("syntax-error")
			expect(diagnostics[0].message).toBe(
				"Expected ')' but found 'Terminal'.",
			)
			expect(diagnostics[0].position).toEqual({
				start: { line: 6, column: 2 },
				end: { line: 6, column: 10 },
			})
			expect(diagnostics[0].labels[1]?.message).toBe("opened here")
			expect(diagnostics[0].labels[1]?.position).toEqual({
				start: { line: 4, column: 16 },
				end: { line: 4, column: 17 },
			})
		})

		// NOTE: The Literal reading of the braces meets the stray ')' four lines
		// down; the update reading behind it needs a `with` where the first
		// member's `=` stands, and that `=` is what the whole family of mistakes
		// inside a Record used to be answered at.
		it("should report a Record's mistake where it stands, not as a missing 'with'", () => {
			let { diagnostics } = parseWithDiagnostics(
				`implementation {
	constant game = { moves = 0, carried = ["lamp"] }

	constant turn = {
		game = {
			game with
				moves = game.moves::add(1),
				carried = game.carried::append("key")),
		},
		message = "You take the key.",
	}
}`,
			)

			expect(diagnostics).toHaveLength(1)
			expect(diagnostics[0].code).toBe("syntax-error")
			expect(diagnostics[0].message).toBe("Expected '}' but found ')'.")
			expect(diagnostics[0].position).toEqual({
				start: { line: 8, column: 42 },
				end: { line: 8, column: 43 },
			})
		})

		// NOTE: Every Diagnostic each of these produces is listed, not just the
		// first. The third member closes the Record early, so the `}` that was
		// meant to close it stands behind the whole Program — which is a second
		// mistake in the same source and belongs on the page.
		it("should report a mistake inside a Record wherever it stands", () => {
			let members: Array<[string, Array<string>, number]> = [
				[
					"{ x = 1, y = }",
					["Expected an Expression but found '}'."],
					44,
				],
				["{ x = [1, 2, y = 3 }", ["Expected ']' but found '='."], 46],
				[
					"{ x = 1, }, y = 2 }",
					[
						"Expected an Expression but found ','.",
						"Unexpected '}' after the end of the Program",
					],
					41,
				],
			]

			for (let [member, messages, column] of members) {
				let { diagnostics } = parseWithDiagnostics(
					`implementation { constant a = ${member} }`,
				)

				expect(
					diagnostics.map((diagnostic) => diagnostic.message),
				).toEqual(messages)
				expect(diagnostics[0].position?.start.column).toBe(column)
			}
		})

		// NOTE: The Dictionary readings share the brackets with the List one and
		// are told apart by a Token of lookahead rather than by speculation, so
		// nothing here is read twice — these are here to hold that, not to prove
		// a swap.
		it("should report a mistake inside a Dictionary wherever it stands", () => {
			let literals: Array<[string, string]> = [
				[`["x" = 1, "y" = ]`, "Expected an Expression but found ']'."],
				[`["x" = [1, 2, "y" = 3]`, "Expected ']' but found '='."],
				[`[d with "x" = ]`, "Expected an Expression but found ']'."],
			]

			for (let [literal, message] of literals) {
				let { diagnostics } = parseWithDiagnostics(
					`implementation { constant a = ${literal} }`,
				)

				expect(diagnostics).toHaveLength(1)
				expect(diagnostics[0].message).toBe(message)
			}
		})

		// NOTE: `nesting-too-deep` is given BACK by a speculation rather than
		// raised out of it, so an attempt that exhausted the budget is a reading
		// thrown away like any other — and it is still the true account of this
		// Record, whose member really is nested past what the Parser reads. It
		// was answered with "Expected 'with' but found '='" at the first member,
		// from the update reading that never got past it.
		it("should report the budget an abandoned reading exhausted", () => {
			let deep = `${"[".repeat(1030)}1${"]".repeat(1030)}`
			let { diagnostics } = parseWithDiagnostics(
				`implementation { constant a = { x = ${deep} } }`,
			)

			expect(diagnostics).toHaveLength(1)
			expect(diagnostics[0].code).toBe("nesting-too-deep")
		})

		// NOTE: A coded refusal is a verdict about written text and outranks a
		// reading that merely got further — it never becomes a thrown-away
		// reading in the first place, because `refusesTheText` raises it out of
		// the speculation instead of giving it back.
		it("should leave a coded refusal ahead of the furthest reading", () => {
			let refusals: Array<[string, common.DiagnosticCode]> = [
				["{ x = .5 }", "partial-decimal-literal"],
				[
					"{ found = define { as 1 if flag } }",
					"define-without-otherwise",
				],
				["{ x = .price::rounded() }", "path-is-members-only"],
			]

			for (let [source, code] of refusals) {
				let { diagnostics } = parseWithDiagnostics(
					`implementation { constant a = ${source} }`,
				)

				expect(diagnostics).toHaveLength(1)
				expect(diagnostics[0].code).toBe(code)
			}
		})

		// NOTE: A reading that HELD answers for the ones tried beside it. The
		// Literal reading of these braces runs out at the `with`, four Tokens
		// ahead of where the Combination that IS written ends — and the mistake
		// below it is the one that has to be reported.
		it("should not answer a later mistake with a reading that was replaced", () => {
			let { diagnostics } = parseWithDiagnostics(
				`implementation {
	constant b = { a with other }::merge(1 2)
}`,
			)

			expect(diagnostics).toHaveLength(1)
			expect(diagnostics[0].message).toBe("Expected ')' but found '2'.")
			expect(diagnostics[0].position?.start.line).toBe(2)
		})

		// NOTE: And a Statement that was read answers for them too. Two things
		// hold this: the Record Literal reading of the first Statement HELD, so
		// the update reading it replaced is dropped where every replaced
		// reading is, and the record would have to stand further into the input
		// than the second Statement's own failure to be reported at all. The
		// clear at the head of the Statement loop is a third, and is defensive
		// — see the NOTE on it. What this pins is the answer, not which of the
		// three produced it.
		it("should not answer one Statement with a reading thrown away for another", () => {
			let { diagnostics } = parseWithDiagnostics(
				`implementation {
	constant a = { x = 1, y = 2 }
	constant b = ]
}`,
			)

			expect(diagnostics).toHaveLength(1)
			expect(diagnostics[0].message).toBe(
				"Expected an Expression but found ']'.",
			)
			expect(diagnostics[0].position?.start.line).toBe(3)
		})
	})

	// NOTE: A bracket is noticed as missing at the first Token that can not
	// carry its contents on, which is a line — or a screen — away from the
	// bracket itself. The Label is what closes that distance, and it is written
	// only where there IS one: a pair on a single line is under the reader's eye
	// already.
	describe("An unclosed bracket", () => {
		it("should point at the '(' a call never closed", () => {
			let { diagnostics } = parseWithDiagnostics(
				`implementation {
	constant total = Math.sum(
		1,
		2
	Terminal.print(total)
}`,
			)

			expect(diagnostics).toHaveLength(1)
			expect(diagnostics[0].code).toBe("syntax-error")
			expect(diagnostics[0].message).toBe(
				"Expected ')' but found 'Terminal'.",
			)
			expect(diagnostics[0].labels).toHaveLength(2)
			expect(diagnostics[0].labels[1]?.kind).toBe("secondary")
			expect(diagnostics[0].labels[1]?.message).toBe("opened here")
			expect(diagnostics[0].labels[1]?.position).toEqual({
				start: { line: 2, column: 27 },
				end: { line: 2, column: 28 },
			})
		})

		it("should point at the '[' a List never closed", () => {
			let { diagnostics } = parseWithDiagnostics(
				`implementation {
	constant names = [
		"ada",
		"alan"
	Terminal.print(names)
}`,
			)

			expect(diagnostics).toHaveLength(1)
			expect(diagnostics[0].message).toBe(
				"Expected ']' but found 'Terminal'.",
			)
			expect(diagnostics[0].labels[1]?.message).toBe("opened here")
			expect(diagnostics[0].labels[1]?.position).toEqual({
				start: { line: 2, column: 19 },
				end: { line: 2, column: 20 },
			})
		})

		// NOTE: The pair written on one line keeps the Diagnostic it has always
		// had, with one Label: the bracket is under the reader's eye already.
		// The mistake is a second Argument written without a comma, because an
		// operator written there — `1 + 2` — is answered by
		// `operator-not-supported` before the bracket is ever missed.
		it("should stay silent about a bracket on the line of the mistake", () => {
			let { diagnostics } = parseWithDiagnostics(
				"implementation { Terminal.print(1 2) }",
			)

			expect(diagnostics).toHaveLength(1)
			expect(diagnostics[0].message).toBe("Expected ')' but found '2'.")
			expect(diagnostics[0].labels).toHaveLength(1)
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

	// NOTE: The Helps that used to print an EXAMPLE where the reader's own text
	// was in hand. Each named something nothing in the file declared — a Type
	// called `SomeType`, a Case called `#Rectangle`, a value called `base` — so
	// a reader who followed one arrived at a report about a name they had never
	// written. Every Help asserted here is written back into its own probe and
	// compiled: a promise like this is only worth making where it holds.
	describe("Helps built from the text that was written", () => {
		it("spells the reader's own path and call in the Function literal", () => {
			let source = `implementation {
	constant names = [{ title = "Ada" }]::map(.title::uppercase())
	Terminal.inspect(names)
}`

			expect(helpsOf(source)).toEqual([
				"Write the Function literal instead: '(_ item) { <- item.title::uppercase() }'.",
			])
			expect(
				compiles(`implementation {
	constant names = [{ title = "Ada" }]::map((_ item) { <- item.title::uppercase() })
	Terminal.inspect(names)
}`),
			).toBe(true)
		})

		// NOTE: Unannotated on purpose. A literal handed to a Method reads its
		// Parameter's Type off the Argument it is passed, and the annotation
		// this used to print named a Type nothing declares.
		it("leaves the offered literal's Parameter unannotated", () => {
			expect(
				helpsOf("implementation { call(.total::rounded()) }"),
			).toEqual([
				"Write the Function literal instead: '(_ item) { <- item.total::rounded() }'.",
			])
		})

		it("prints the Argument a called path was written with", () => {
			expect(helpsOf("implementation { call(.total(2)) }")).toEqual([
				"Write the Function literal instead: '(_ item) { <- item.total(2) }'.",
			])
		})

		// NOTE: `'(n: Integer)'` declares a LABELLED Parameter, so a reader who
		// followed this Help and then called what they had written was answered
		// `This Argument is not labelled 'n'`.
		it("writes the arrow literal's Parameter unlabelled", () => {
			let source = `implementation {
	constant double = (n: Integer) => n
	Terminal.inspect(double(2))
}`

			expect(helpsOf(source)).toEqual([
				"Write '(_ n: Integer) -> Integer { <- n }'.",
			])
			expect(
				compiles(`implementation {
	constant double = (_ n: Integer) -> Integer { <- n }
	Terminal.inspect(double(2))
}`),
			).toBe(true)
		})

		// NOTE: A `=>` behind a String or a Number is the hash rocket and not an
		// arrow: no language writes a Parameter list as a Literal.
		it("answers a hash rocket as the Dictionary entry it is", () => {
			let source = `implementation {
	constant ages = ["kim" => 7, "ada" => 36]
	Terminal.inspect(ages)
}`
			let { diagnostics } = parseWithDiagnostics(source)

			expect(diagnostics[0]?.code).toBe("dictionary-entry-syntax")
			expect(diagnostics[0]?.helps).toEqual([
				"Write '=' in place of '=>'.",
			])
			expect(
				compiles(`implementation {
	constant ages = ["kim" = 7, "ada" = 36]
	Terminal.inspect(ages)
}`),
			).toBe(true)
		})

		// NOTE: A NAME on the left is genuinely both habits at once — `x => x`
		// is a Function in one language and a key in another — so the Function
		// literal is what stays answered there.
		it("leaves a named left operand to the Function literal", () => {
			let { diagnostics } = parseWithDiagnostics(
				"implementation { constant ages = [key => 7] }",
			)

			expect(diagnostics[0]?.code).toBe("foreign-syntax")
			expect(diagnostics[0]?.message).toBe(
				"A Function literal has no '=>'",
			)
		})

		// NOTE: "or drop the key" was a dead end where the key is the ONLY one:
		// `{ config with server.{ } }` dropped down to `{ config with }`.
		it("names the value an only descend would leave behind", () => {
			let source = `implementation {
	constant config = { server = { port = 80 } }
	constant same = { config with server.{ } }
	Terminal.inspect(same)
}`

			expect(helpsOf(source)).toEqual([
				"Write the members to update inside it.",
				"Or drop the key — and where it is the only one, drop the update with it and write 'config' on its own.",
			])
			expect(
				compiles(`implementation {
	constant config = { server = { port = 80 } }
	constant same = config
	Terminal.inspect(same)
}`),
			).toBe(true)
		})

		// NOTE: Each report used to offer a Record holding only its OWN name, so
		// a reader who followed one dropped every other key without being told.
		it("gathers every bare key into the Record it offers", () => {
			let source = `implementation {
	constant base = { port = 80, host = "localhost" }
	constant port = 8080
	constant host = "example.com"
	constant server = { base with port, host }
	Terminal.inspect(server)
}`
			let merged =
				"Or merge a whole Record: '{ base with { port, host } }'."

			expect(helpsOf(source)).toEqual([
				"Write 'port = port'.",
				merged,
				"Write 'host = host'.",
				merged,
			])
			expect(
				compiles(`implementation {
	constant base = { port = 80, host = "localhost" }
	constant port = 8080
	constant host = "example.com"
	constant server = { base with { port, host } }
	Terminal.inspect(server)
}`),
			).toBe(true)
		})

		// NOTE: The Help and the Quick Fix read one computation now. `'3/4' or
		// '0.75'` was printed whatever was written, so `2.5/3` — five sixths —
		// was answered with a Help that quietly changed the number while the fix
		// beside it offered `5/6`.
		it("offers the value the two mixed spellings say between them", () => {
			expect(helpsOf("implementation { constant a = 1.5/2 }")).toEqual([
				"Write it as '3/4' — or as '0.75', which is the same value written the other way.",
			])
			expect(helpsOf("implementation { constant a = 2.5/3 }")).toEqual([
				"Write it as '5/6', which is the value the two spellings say between them.",
			])
		})

		// NOTE: Two shapes reach one refusal. A trailing comma is dropped; a
		// SECOND value can not be, and the Record that carries both is spelled
		// with the Case the reader wrote rather than with `#Rectangle`.
		it("tells a trailing comma from a second payload", () => {
			expect(
				helpsOf("implementation { constant x = Optional#Value(1,) }"),
			).toEqual(["Drop the ','."])

			let two = `implementation {
	choice Shape {
		Rect { width: Integer, height: Integer },
		Dot,
	}

	constant s: Shape = #Rect(2, 3)
	Terminal.inspect(s)
}`

			expect(helpsOf(two)).toEqual([
				"Carry the values as one Record: '#Rect({ … })', with a member for each of them.",
			])
			expect(
				compiles(`implementation {
	choice Shape {
		Rect { width: Integer, height: Integer },
		Dot,
	}

	constant s: Shape = #Rect({ width = 2, height = 3 })
	Terminal.inspect(s)
}`),
			).toBe(true)
		})

		// NOTE: The literal is often passed to nothing at all, or to a Method of
		// the standard library — so "write the default on the Function this is
		// passed to" was an edit in a Declaration the reader has not got. The
		// Help is the edit the Quick Fix beside it makes.
		it("offers the removal the Quick Fix makes", () => {
			let source = `implementation {
	constant double = (_ number: Integer = 1) -> Integer { <- number::multiply(with 2) }
	Terminal.inspect(double(2))
}`

			expect(helpsOf(source)).toEqual(["Remove the default."])
			expect(
				compiles(`implementation {
	constant double = (_ number: Integer) -> Integer { <- number::multiply(with 2) }
	Terminal.inspect(double(2))
}`),
			).toBe(true)
		})
	})
})
