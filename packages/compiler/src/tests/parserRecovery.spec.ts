import { describe, expect, it } from "bun:test"

import type { parser } from "@essence-lang/interfaces"

import { parseWithDiagnostics } from "../parser/index"
import { testDiagnostic } from "./diagnosticFactory"
import { compiles } from "./followedHelps"

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

	// See "Error recovery" in packages/compiler/src/parser/DEVELOPMENT.md.
	describe("a Statement that begins with a name", () => {
		it("should read a Statement that begins with a name after a broken one", () => {
			let { program, diagnostics } = parseWithDiagnostics(
				`implementation {
					constant d = f(total + tax
					const price = 12
				}`,
			)

			expect(diagnostics.map((diagnostic) => diagnostic.message)).toEqual(
				[
					"Essence has no '+' operator",
					"'const' is not how Essence declares a binding",
				],
			)

			let nodes = program.implementation.nodes

			expect(nodes).toHaveLength(1)
			expect(nodes[0].nodeType).toBe("ConstantDeclarationStatement")

			if (nodes[0].nodeType === "ConstantDeclarationStatement") {
				expect((nodes[0].name as parser.IdentifierNode).content).toBe(
					"price",
				)
			}
		})

		it("should report a broken Statement that begins with a name after a broken one", () => {
			let { diagnostics } = parseWithDiagnostics(
				`implementation {
					class Money { constant q = ) }
					user.name = "Ada"
				}`,
			)

			expect(diagnostics.map((diagnostic) => diagnostic.message)).toEqual(
				[
					"'class' declares nothing in Essence",
					"A Record's member can not be assigned",
				],
			)
		})

		it("should keep a call broken over lines to one Diagnostic", () => {
			let { program, diagnostics } = parseWithDiagnostics(
				`implementation {
					constant total = compute(
						first + 1,
						second,
					)
					Terminal.print(total)
				}`,
			)

			expect(diagnostics.map((diagnostic) => diagnostic.message)).toEqual(
				["Essence has no '+' operator"],
			)
			expect(
				program.implementation.nodes.map((node) => node.nodeType),
			).toEqual(["FunctionInvocation"])
		})

		// A stray `)` closes the call, so the Statement after it shares a line
		// with the call and gives no indentation to compare.
		it("should not resume at a name below a broken Statement that shares its line", () => {
			let { diagnostics } = parseWithDiagnostics(
				`implementation {
					constant range = compute(
						) from 1,
						to 3,
					)
					constant after = 2
				}`,
			)

			expect(diagnostics).toHaveLength(1)
		})

		// The Lexer counts a tab as one column, so the Arguments' two tabs stand
		// left of the four spaces. By text neither indentation begins the other.
		it("should not resume where a line's indentation can not be compared with the broken one", () => {
			let { diagnostics } = parseWithDiagnostics(
				[
					"implementation {",
					"\tconstant tiles = [1, 2, 3]",
					"    constant total tiles::reduce(",
					"\t\tstartingWith 0,",
					"\t\tstep (sum, tile) { <- sum::add(tile) },",
					"\t)",
					"\tTerminal.print(total)",
					"}",
				].join("\n"),
			)

			expect(diagnostics.map((diagnostic) => diagnostic.message)).toEqual(
				["Expected '=' but found 'tiles'."],
			)
		})

		it("should not resume at a 'with' that continues a Dictionary base", () => {
			let { program, diagnostics } = parseWithDiagnostics(
				`implementation {
					constant scores = ["kim" = 1]
					constant updated = [scores +
					with "kim" = 7]
					Terminal.print(updated)
				}`,
			)

			expect(diagnostics.map((diagnostic) => diagnostic.message)).toEqual(
				["Essence has no '+' operator"],
			)
			expect(
				program.implementation.nodes.map((node) => node.nodeType),
			).toEqual(["ConstantDeclarationStatement", "FunctionInvocation"])
		})

		it("should resume at a name but not at another language's operator that opens a line", () => {
			let { program, diagnostics } = parseWithDiagnostics(
				`implementation {
					if a::isGreaterThan(1)
					&& b {
						Terminal.print(1)
					}
					$total = 2
				}`,
			)

			expect(diagnostics.map((diagnostic) => diagnostic.message)).toEqual(
				["Expected '{' but found '&&'."],
			)
			expect(
				program.implementation.nodes.map((node) => node.nodeType),
			).toEqual(["VariableAssignmentStatement"])
		})

		it("should not resume at an 'is' that continues a Namespace's head", () => {
			let { diagnostics } = parseWithDiagnostics(
				`implementation {
					namespace Checks for Integer +
					is Equatable {
						is(_ other: Integer) -> Boolean {
							<- true
						}
					}
					constant x = 1
				}`,
			)

			expect(diagnostics.map((diagnostic) => diagnostic.message)).toEqual(
				["Expected '{' but found '+'."],
			)
		})

		it("should resume at a Method named 'is' after a broken Method", () => {
			let { program, diagnostics } = parseWithDiagnostics(
				`implementation {
					namespace Checks for Integer {
						isSmall(limit: Integer +) -> Boolean {
							<- true
						}
						is(_ other: Integer) -> Boolean {
							<- true
						}
					}
				}`,
			)

			expect(diagnostics.map((diagnostic) => diagnostic.message)).toEqual(
				["Expected ')' but found '+'."],
			)

			let namespace = program.implementation.nodes[0]

			expect(namespace?.nodeType).toBe("NamespaceDefinitionStatement")

			if (namespace?.nodeType === "NamespaceDefinitionStatement") {
				expect(Object.keys(namespace.methods)).toEqual(["is"])
			}
		})
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

	it("should compile once the missing '}' is added", () => {
		let source = 'implementation {\n\tconstant greeting = "Hello"'
		let { diagnostics } = parseWithDiagnostics(source)

		expect(diagnostics.map((diagnostic) => diagnostic.code)).toEqual([
			"unclosed-block",
		])
		expect(diagnostics[0].helps).toEqual(["Add the missing '}'."])
		expect(compiles(`${source}\n}`)).toBe(true)
	})

	// One report stands for every block the input ends inside, so one `}`
	// would only meet it again.
	it("should count the blocks a file ends inside", () => {
		let source = `implementation {
	function double(_ value: Integer) -> String {
		<- "{value}{value}"`
		let { diagnostics } = parseWithDiagnostics(source)

		expect(diagnostics.map((diagnostic) => diagnostic.code)).toEqual([
			"unclosed-block",
		])
		expect(diagnostics[0].helps).toEqual([
			"Add a '}' for each of the 2 blocks still open.",
		])
		expect(compiles(`${source}\n}`)).toBe(false)
		expect(compiles(`${source}\n\t}\n}`)).toBe(true)
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

	// The String that spans lines is named as the culprit. See "Which quote is
	// missing" in packages/compiler/src/lexer/DEVELOPMENT.md.
	it("should name the String that swallowed the lines below it", () => {
		let { diagnostics } = parseWithDiagnostics(
			`implementation {
	constant greeting = "Hello
	constant name = "Ada"

	Terminal.print(greeting)
	Terminal.print(name)
}`,
		)

		expect(diagnostics).toHaveLength(1)
		expect(diagnostics[0].code).toBe("unclosed-string")
		expect(diagnostics[0].position).toEqual({
			start: { line: 2, column: 22 },
			end: { line: 2, column: 23 },
		})
		expect(diagnostics[0].labels).toHaveLength(3)
		expect(diagnostics[0].labels[0]).toMatchObject({
			kind: "primary",
			message: "opened here",
		})
		expect(diagnostics[0].labels[1]).toMatchObject({
			kind: "secondary",
			position: {
				start: { line: 3, column: 18 },
				end: { line: 3, column: 19 },
			},
		})
		expect(diagnostics[0].labels[2]?.message).toBe(
			"and the input ends inside that one",
		)
		expect(diagnostics[0].helps[0]).toBe(
			`Add the missing '"' at the end of line 2.`,
		)
		// One Help only. A quote at the end of the input reaches no Program,
		// so that reading is a Note.
		expect(diagnostics[0].helps).toHaveLength(1)
		expect(diagnostics[0].notes[1]).toContain(
			"at the end of line 2 the lines below are Statements, and at the end of the input they are text",
		)
	})

	// `"{\"a\": 1}"` is JSON with the quotes escaped and the braces not. The
	// `{` opens a hole, so a missing quote is not the problem.
	it("should answer the hole a String's '{' opened", () => {
		let { diagnostics } = parseWithDiagnostics(
			`implementation {
	constant body = "{\\"a\\": 1}"
	Terminal.print(body)
}`,
		)

		expect(diagnostics).toHaveLength(1)
		expect(diagnostics[0].code).toBe("unclosed-string")
		expect(diagnostics[0].labels[1]?.message).toBe(
			"opened here, and a '{' inside it opens a hole",
		)
		expect(diagnostics[0].helps).toEqual([
			"Write '\\{' and '\\}' for the braces that stand for themselves.",
		])
	})

	// The quote in `"a } b { c"` stands in the hole, where it opens a String
	// of its own. A quote at the end of the line would open one more, so each
	// Help is followed until the file compiles. Below the hole, the first
	// quote in it is still the one labelled.
	it("should answer a quote that stands in a hole", () => {
		let source = `implementation {
	constant s = "a } b { c"
	Terminal.print(s)
}`
		let { diagnostics } = parseWithDiagnostics(source)

		expect(diagnostics).toHaveLength(1)
		expect(diagnostics[0].code).toBe("unclosed-string")
		expect(
			diagnostics[0].labels.map((label) => [
				label.message,
				label.position.start,
			]),
		).toEqual([
			["the input ends here", { line: 4, column: 2 }],
			["this '{' opens a hole", { line: 2, column: 22 }],
			[
				"and this quote opens a String inside it",
				{ line: 2, column: 25 },
			],
		])
		expect(diagnostics[0].helps).toEqual([
			"Write '\\{' for a brace that stands for itself.",
			"Or end the hole with a '}' in front of that quote, where it holds an Expression.",
		])
		expect(compiles(source.replace("b { c", "b \\{ c"))).toBe(true)
		expect(compiles(source.replace('"a } b { c"', '"a } b { c""'))).toBe(
			false,
		)

		let name = `implementation {
	constant name = "Ada"
	constant greeting = "Hello, {name"
	Terminal.print("{greeting}!")
}`
		let [missingBrace] = parseWithDiagnostics(name).diagnostics

		expect(missingBrace?.helps).toEqual(diagnostics[0].helps)
		expect(missingBrace?.labels[2]?.position.start).toEqual({
			line: 3,
			column: 35,
		})
		expect(compiles(name.replace("{name", "{name}"))).toBe(true)
	})

	// The `", "` is an Argument the hole holds and closes on its own line. The
	// quote after the call is the one that ran on, so it is labelled, and the
	// hole's `}` belongs in front of it.
	it("should label the quote that runs on past a String the hole holds", () => {
		let source = `implementation {
	constant names = ["a", "b"]
	constant s = "{names::join(with ", ")"
	Terminal.print(s)
}`
		let [report] = parseWithDiagnostics(source).diagnostics

		expect(report?.code).toBe("unclosed-string")
		expect(report?.labels[2]?.position.start).toEqual({
			line: 3,
			column: 39,
		})
		expect(compiles(source.replace(`", ")"`, `", ")}"`))).toBe(true)
	})

	// A hole holding a name was meant, so the String really is one quote
	// short.
	it("should keep the missing quote where the hole holds a name", () => {
		let { diagnostics } = parseWithDiagnostics(
			`implementation {
	constant name = "Ada"
	constant greeting = "Hello, {name}
}`,
		)

		expect(diagnostics).toHaveLength(1)
		expect(diagnostics[0].code).toBe("unclosed-string")
		expect(diagnostics[0].helps).toEqual([
			`Add the missing '"' at the end of line 3.`,
		])
	})

	// A quote at the end of the input would close a String holding every
	// later line, so the Help names the opening line.
	it("should name the line the missing quote goes on", () => {
		let source = `implementation {
	constant greeting = "Hello
	Terminal.print(greeting)
}`

		expect(parseWithDiagnostics(source).diagnostics[0]?.helps).toEqual([
			`Add the missing '"' at the end of line 2.`,
		])
		expect(compiles(source.replace('"Hello', '"Hello"'))).toBe(true)
		expect(compiles(`${source}"`)).toBe(false)
	})

	// An even number of forgotten quotes leaves nothing unterminated, only the
	// name behind the quote that closed the String above it.
	it("should name the String that swallowed a line where nothing is left open", () => {
		let { diagnostics } = parseWithDiagnostics(
			`implementation {
	constant a = "one
	constant b = "two
	constant c = "three"

	Terminal.print(a)
}`,
		)

		expect(diagnostics).toHaveLength(1)
		expect(diagnostics[0].code).toBe("unclosed-string")
		expect(diagnostics[0].position).toEqual({
			start: { line: 2, column: 15 },
			end: { line: 2, column: 16 },
		})
		expect(diagnostics[0].labels[0]).toMatchObject({
			kind: "primary",
			message: "opened here",
		})
		expect(diagnostics[0].labels[2]?.message).toBe(
			"and this is what that quote left standing",
		)
		expect(diagnostics[0].helps).toEqual([
			`Add the missing '"' at the end of line 2.`,
		])
	})

	// A String written to span lines stays silent. A name behind the closing
	// quote on its line tells the two apart, since two Expressions never stand
	// side by side.
	it("should leave a String that really does span lines alone", () => {
		let sources = [
			`implementation {
	constant poem = "Roses
are red"

	Terminal.print(poem)
}`,
			`implementation {
	constant poem = "Roses
are red"::append("!")

	Terminal.print(poem)
}`,
			`implementation {
	constant poem = "Roses
are red"
	constant name = "Ada"

	Terminal.print(poem::append(name))
}`,
		]

		for (let source of sources) {
			expect(parseWithDiagnostics(source).diagnostics).toEqual([])
		}
	})

	// The claim needs the String that closed directly before the unclosed one,
	// on its line. A one-line String between them, or a line break, clears it.
	it("should keep the plain report where the evidence is not there", () => {
		let sources = [
			`implementation {
	constant poem = "Roses
are red"
	constant name = "Ada"
	constant note = "unclosed
}`,
			`implementation {
	constant poem = "Roses
are red"::append("x")
	constant note = "unclosed
}`,
		]

		for (let source of sources) {
			let { diagnostics } = parseWithDiagnostics(source)

			expect(diagnostics).toHaveLength(1)
			expect(diagnostics[0].code).toBe("unclosed-string")
			expect(diagnostics[0].labels).toHaveLength(2)
			expect(diagnostics[0].labels[0]?.message).toBe(
				"the input ends here",
			)
		}
	})

	// The Lexer stops one line past the last when the file ends in a newline.
	// The position is clamped to just after the last visible character.
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
		// The speculative reading of `f(g(match …` runs to the end of the input
		// and latches the cascade suppression. `backtrack` must unlatch it.
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

	// Expressions, Types and blocks share one nesting budget. It is wide enough
	// for a machine-generated tree and for depths that sum past a few hundred.
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

	// `nesting-too-deep` is about the reading, not the text, so a speculation
	// gives it back. A speculation recurs one level deeper than the reading it
	// stands in for. See "Speculation" in
	// packages/compiler/src/parser/DEVELOPMENT.md.
	it("should give the depth guard back to the reading that fits", () => {
		// The innermost value is a name, which the typed Record Literal is
		// speculated on when a `~` stands ahead.
		let nest = (depth: number, tilde: boolean) =>
			parseWithDiagnostics(
				`implementation {
					constant x = ${"[".repeat(depth)}value${"]".repeat(depth)}
					${tilde ? "constant t = Integer ~> { }" : ""}
				}`,
			).diagnostics

		// The deepest nesting the Parser accepts, found by search so the spec
		// holds whatever the budget is.
		let deepest = 1
		let tooDeep = 4096

		while (tooDeep - deepest > 1) {
			let middle = Math.floor((deepest + tooDeep) / 2)

			if (nest(middle, false).length === 0) {
				deepest = middle
			} else {
				tooDeep = middle
			}
		}

		expect(nest(deepest, false)).toEqual([])
		expect(nest(deepest, true)).toEqual([])
		expect(nest(tooDeep, true)[0]?.code).toBe("nesting-too-deep")
	})

	// A coded refusal raised out of a speculation drops its Statement like any
	// other ParseError. What the abandoned reading consumed stays consumed, so
	// resynchronisation resumes past the Literal.
	it("should keep parsing after a refusal raised inside a speculation", () => {
		let { program, diagnostics } = parseWithDiagnostics(
			`implementation {
				constant broken = { x = .5 }
				constant good = 42
				constant alsoBroken = { y = ] }
			}`,
		)

		expect(diagnostics).toHaveLength(2)
		expect(diagnostics[0].code).toBe("partial-decimal-literal")
		expect(diagnostics[1].code).toBe("syntax-error")

		let nodes = program.implementation.nodes

		expect(nodes).toHaveLength(1)
		expect(nodes[0].nodeType).toBe("ConstantDeclarationStatement")

		if (nodes[0].nodeType === "ConstantDeclarationStatement") {
			expect((nodes[0].name as parser.IdentifierNode).content).toBe(
				"good",
			)
			expect(nodes[0].value.nodeType).toBe("IntegerValue")
		}
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

	// A `define` arm is recovered from by its own loop, since an `as` is no
	// Statement start. See "Define" in packages/compiler/src/parser/DEVELOPMENT.md.
	it("should keep reading arms after a broken define arm", () => {
		let { program, diagnostics } = parseWithDiagnostics(
			`implementation {
				constant grade = define {
					as if flag
					as 2 if other
					as 0 otherwise
				}
			}`,
		)

		expect(diagnostics).toHaveLength(1)
		expect(diagnostics[0].severity).toBe("error")
		expect(diagnostics[0].message).toBe(
			"Expected an Expression but found 'if'.",
		)

		let nodes = program.implementation.nodes

		expect(nodes).toHaveLength(1)
		expect(nodes[0].nodeType).toBe("ConstantDeclarationStatement")

		if (
			nodes[0].nodeType === "ConstantDeclarationStatement" &&
			nodes[0].value.nodeType === "Define"
		) {
			expect(nodes[0].value.arms).toHaveLength(1)
			expect(nodes[0].value.arms[0].condition.nodeType).toBe("Identifier")
			expect(nodes[0].value.otherwise.value.nodeType).toBe("IntegerValue")
		}
	})

	// A broken arm that opened braces of its own is skipped whole, as a broken
	// Statement is.
	it("should skip a broken define arm's own braces", () => {
		let { program, diagnostics } = parseWithDiagnostics(
			`implementation {
				constant grade = define {
					as { a = } if flag
					as 2 if other
					as 0 otherwise
				}
			}`,
		)

		expect(diagnostics).toHaveLength(1)
		expect(diagnostics[0].severity).toBe("error")

		let nodes = program.implementation.nodes

		expect(nodes).toHaveLength(1)

		if (
			nodes[0].nodeType === "ConstantDeclarationStatement" &&
			nodes[0].value.nodeType === "Define"
		) {
			expect(nodes[0].value.arms).toHaveLength(1)
		}
	})

	// `otherwise` is a valid Identifier, so `as otherwise` is an arm whose
	// value is a name and whose follower is missing. The report asks for the
	// follower, and the next arm still reads.
	it("should ask for a follower where an arm's value is a name spelled otherwise", () => {
		let { program, diagnostics } = parseWithDiagnostics(
			`implementation {
				constant grade = define {
					as otherwise
					as 0 otherwise
				}
			}`,
		)

		expect(diagnostics).toHaveLength(1)
		expect(diagnostics[0].severity).toBe("error")
		expect(diagnostics[0].message).toBe(
			"Expected 'if' or 'otherwise' but found 'as'.",
		)
		expect(diagnostics[0].labels[0]?.message).toBe(
			"expected 'if' or 'otherwise'",
		)

		let nodes = program.implementation.nodes

		expect(nodes).toHaveLength(1)

		if (
			nodes[0].nodeType === "ConstantDeclarationStatement" &&
			nodes[0].value.nodeType === "Define"
		) {
			expect(nodes[0].value.arms).toHaveLength(0)
			expect(nodes[0].value.otherwise.value.nodeType).toBe("IntegerValue")
		}
	})

	it("should refuse a define with no otherwise arm and carry on", () => {
		let { program, diagnostics } = parseWithDiagnostics(
			`implementation {
				constant grade = define {
					as 1 if flag
				}
				constant y = 3
			}`,
		)

		expect(diagnostics).toHaveLength(1)
		expect(diagnostics[0].severity).toBe("error")
		expect(diagnostics[0].code).toBe("define-without-otherwise")
		expect(diagnostics[0].message).toBe(
			"This 'define' has no 'otherwise' arm",
		)
		expect(diagnostics[0].labels[0]?.message).toBe(
			"every value here has a condition on it",
		)
		expect(diagnostics[0].helps).toEqual([
			"Write the last arm as 'as <value> otherwise'.",
		])

		let nodes = program.implementation.nodes

		expect(nodes).toHaveLength(1)

		if (nodes[0].nodeType === "ConstantDeclarationStatement") {
			expect((nodes[0].name as parser.IdentifierNode).content).toBe("y")
		}
	})

	// An empty block wrote no values, so it is short of every arm, not of the
	// last one.
	it("should refuse an empty define in its own words", () => {
		let { diagnostics } = parseWithDiagnostics(
			`implementation {
				constant grade = define { }
			}`,
		)

		expect(diagnostics).toHaveLength(1)
		expect(diagnostics[0].code).toBe("define-without-otherwise")
		expect(diagnostics[0].labels[0]?.message).toBe(
			"there are no arms here at all",
		)
		expect(diagnostics[0].helps).toEqual([
			"Write an arm: 'as <value> otherwise'.",
		])
	})

	// A written `otherwise` arm answers when every condition fails.
	it("should compile once the 'otherwise' arm is written", () => {
		for (let arms of [
			["as 1 if flag", "as 0 otherwise"],
			["as 0 otherwise"],
		]) {
			expect(
				compiles(`implementation {
				constant flag = true
				constant grade = define {
					${arms.join("\n\t\t\t\t\t")}
				}
			}`),
			).toBe(true)
		}
	})

	// Reported and dropped rather than thrown, so the `define` and its
	// Statement stay.
	it("should refuse an arm written below the otherwise arm", () => {
		let { program, diagnostics } = parseWithDiagnostics(
			`implementation {
				constant grade = define {
					as 1 if flag
					as 0 otherwise
					as 2 if other
				}

				constant y = 3
			}`,
		)

		expect(diagnostics).toHaveLength(1)
		expect(diagnostics[0].severity).toBe("error")
		expect(diagnostics[0].code).toBe("unreachable-define-arm")
		expect(diagnostics[0].message).toBe(
			"This arm stands below the 'otherwise' arm",
		)
		expect(diagnostics[0].labels[0]?.message).toBe(
			"nothing here can ever be reached",
		)

		let nodes = program.implementation.nodes

		expect(nodes).toHaveLength(2)

		if (
			nodes[0].nodeType === "ConstantDeclarationStatement" &&
			nodes[0].value.nodeType === "Define"
		) {
			// The unreachable arm is never recorded, so the `otherwise` arm is
			// last in every Node.
			expect(nodes[0].value.arms).toHaveLength(1)
		}
	})

	// The refusal has a code of its own, so it survives the speculation
	// rather than being rewound.
	it("should raise a define refusal out of a speculation", () => {
		let { diagnostics } = parseWithDiagnostics(
			`implementation {
				constant row = { found = define {
					as 1 if flag
				} }
			}`,
		)

		expect(diagnostics).toHaveLength(1)
		expect(diagnostics[0].code).toBe("define-without-otherwise")
	})

	// A coded refusal is raised out of the arm loop to the Statement loop, so
	// the text is answered once.
	it("should let a coded refusal out of a define arm", () => {
		let { diagnostics } = parseWithDiagnostics(
			`implementation {
				constant grade = define {
					as .5 if flag
					as 0 otherwise
				}
			}`,
		)

		expect(diagnostics).toHaveLength(1)
		expect(diagnostics[0].code).toBe("partial-decimal-literal")
	})

	// The missing-`otherwise` refusal is made only when the arms were read
	// cleanly. Each source here writes an `otherwise` arm, or ends before one
	// would stand.
	describe("a define whose arms were not read cleanly", () => {
		// The arm opens a `{` it never closes, so the Statement goes. The one
		// Diagnostic is about the brace, where the Literal reading of `{ a = 1`
		// runs out at the `if`.
		it("should not refuse an otherwise arm its own recovery skipped", () => {
			let { diagnostics } = parseWithDiagnostics(
				`implementation {
					constant flag = true
					constant x = define {
						as { a = 1 if flag
						as 2 otherwise
					}
					Terminal.print("after")
				}`,
			)

			expect(diagnostics).toHaveLength(1)
			expect(diagnostics[0].code).toBe("syntax-error")
			expect(diagnostics[0].message).toBe("Expected '}' but found 'if'.")
		})

		// A Token where an `as` belongs read nothing, so only that Token is
		// dropped. Scanning on would step into the brace it opens.
		it("should keep the block a stray brace below the arms stands in", () => {
			let { program, diagnostics } = parseWithDiagnostics(
				`implementation {
					constant flag = true
					constant x = define {
						as 1 if flag
						as 2 otherwise
						{
					}
					Terminal.print("after")
				}`,
			)

			expect(diagnostics).toHaveLength(1)
			expect(diagnostics[0].code).toBe("syntax-error")
			expect(diagnostics[0].message).toBe("Expected 'as' but found '{'.")
			expect(
				program.implementation.nodes.map((node) => node.nodeType),
			).toEqual([
				"ConstantDeclarationStatement",
				"ConstantDeclarationStatement",
				"FunctionInvocation",
			])
		})

		// `nesting-too-deep` is about the reading, so the arm loop recovers from
		// it like any broken arm, and the skipped arms prove nothing.
		it("should not refuse a define its own depth budget broke", () => {
			let nested = "1"

			for (let level = 0; level < 600; level++) {
				nested = `define { as ${nested} if flag as 0 otherwise }`
			}

			let { diagnostics } = parseWithDiagnostics(
				`implementation {
					constant flag = true
					constant x = define {
						as ${nested} if flag
						as 9 otherwise
					}
				}`,
			)

			expect(
				diagnostics.map((diagnostic) => diagnostic.code),
			).not.toContain("define-without-otherwise")
			expect(
				diagnostics.every(
					(diagnostic) => diagnostic.code === "nesting-too-deep",
				),
			).toBe(true)
		})

		// The arm loop is a recovery loop, not a candidate reading, so a
		// speculation the refusal escapes must not rewind its report.
		it("should report a broken arm the same inside a speculation", () => {
			const ARMS = `define {
						as ] if flag
					}`

			let bare = parseWithDiagnostics(
				`implementation {
					constant flag = true
					constant x = ${ARMS}
				}`,
			)
			let speculated = parseWithDiagnostics(
				`implementation {
					constant flag = true
					constant x = { found = ${ARMS} }
				}`,
			)

			expect(
				bare.diagnostics.map((diagnostic) => diagnostic.code),
			).toEqual(["syntax-error"])
			expect(
				speculated.diagnostics.map((diagnostic) => diagnostic.message),
			).toEqual(bare.diagnostics.map((diagnostic) => diagnostic.message))
		})

		// The `unclosed-block` the brace reports survives the speculation.
		it("should keep the unclosed block a define ran to the end of", () => {
			let { diagnostics } = parseWithDiagnostics(
				`implementation {
					constant flag = true
					constant x = { found = define {
						as 1 if flag`,
			)

			expect(diagnostics.map((diagnostic) => diagnostic.code)).toEqual([
				"unclosed-block",
			])
		})
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
