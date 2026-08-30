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

	// NOTE: The one coded refusal a speculation still gives back. Every other
	// one is a verdict about text that was written, and travels out to the
	// Statement loop; `nesting-too-deep` is about the READING instead — a
	// speculation recurs a level deeper than the reading it stands in for, so
	// at the deepest nesting the Parser accepts, the attempt runs out of
	// budget where the reading that is kept fits inside it. The attempt here
	// is the typed Record Literal, read for every Identifier with a `~`
	// somewhere ahead of it: re-raised, its refusal would turn a Program into
	// an error over a `~` written on another line.
	it("should give the depth guard back to the reading that fits", () => {
		// NOTE: The innermost value is a NAME, because that is what the typed
		// Record Literal is speculated on — a Number Literal begins nothing
		// the speculation could read, and the `~` would then make no
		// difference at all.
		let nest = (depth: number, tilde: boolean) =>
			parseWithDiagnostics(
				`implementation {
					constant x = ${"[".repeat(depth)}value${"]".repeat(depth)}
					${tilde ? "constant t = Integer ~> { }" : ""}
				}`,
			).diagnostics

		// NOTE: The deepest nesting the Parser accepts, found rather than
		// written down, so this says what it means whatever the budget is set
		// to. One nesting deeper is where the guard fires.
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

	// NOTE: A coded refusal raised out of a speculation lands in the Statement
	// loop like any other ParseError: the Statement holding it is dropped, the
	// Statement below it is read as written, and the one below that reports
	// its own failure. What the abandoned reading consumed stays consumed —
	// a refusal site reads what it is refusing before it throws — so
	// resynchronisation resumes past the Literal rather than walking into it
	// again.
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

	// NOTE: A `define` arm is recovered from by its own loop rather than by the
	// Statement resynchronisation — an `as` is no Statement start, so the shared
	// one would skip every arm below the broken one and the `define` would then
	// be refused for an `otherwise` arm that WAS written.
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

	// NOTE: A broken arm that opened braces of its own is skipped over whole,
	// exactly as a broken Statement is — the arm below it is read, not the
	// leftovers of the one above.
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

		let nodes = program.implementation.nodes

		expect(nodes).toHaveLength(1)

		if (nodes[0].nodeType === "ConstantDeclarationStatement") {
			expect((nodes[0].name as parser.IdentifierNode).content).toBe("y")
		}
	})

	// NOTE: The same refusal about different text. "Every value here has a
	// condition on it" is a remark about the values that were WRITTEN, and an
	// empty block wrote none — it is short of every arm, not of the last one.
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

	// NOTE: Reported and DROPPED rather than thrown, which is what keeps the
	// `define` and the Statement it stands in: the arm reads perfectly well, and
	// what is wrong with it is where it stands.
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
			// NOTE: The unreachable arm is never recorded, which is what keeps
			// "the `otherwise` arm is last" true of every Node that can be
			// built rather than of the ones the Parser happened to like.
			expect(nodes[0].value.arms).toHaveLength(1)
		}
	})

	// NOTE: A `define` missing its `otherwise` arm inside a SPECULATION. The
	// refusal used to carry the generic `syntax-error`, which `rewoundCodes`
	// hands back — so the Record reading rewound, the Dictionary reading behind
	// it answered for the same text, and what a reader was told about a `define`
	// with no `otherwise` arm was "Expected 'with' but found '='". With a code of
	// its own `refusesTheText` raises it instead, and the verdict survives.
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

	// NOTE: A coded refusal is a verdict about the text, so it is raised out of
	// the arm loop to the Statement loop that reports such things — reporting it
	// here and reading on would answer the same text twice.
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

	// NOTE: A totality refusal is a claim about text that was READ, so the arm
	// loop's own recovery is what decides whether it may be made at all. Every
	// source below visibly ends in an `otherwise` arm, or never got as far as
	// where one would stand — and used to be told that every value in it has a
	// condition on it.
	describe("a define whose arms were not read cleanly", () => {
		// NOTE: The arm opens a `{` it never closes, so the `}` the author wrote
		// for the `define` closes the Record instead and resynchronisation
		// carries on past the arm below it. What is left of the file is one
		// brace short whichever way it is read, so the Statement goes — but the
		// one Diagnostic about it is the one that is true.
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
			expect(diagnostics[0].message).toBe(
				"Expected 'with' but found '='.",
			)
		})

		// NOTE: A Token where an `as` belongs read NOTHING, so there are no
		// leftovers between it and the next arm — and scanning for one stepped
		// into the brace it opens, skipped the `define`'s own `}`, ate the
		// `implementation` block's, and then reported that block as never
		// closed. Everything below the `define` is still text this Parser can
		// read.
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

		// NOTE: `nesting-too-deep` is about the READING rather than about the
		// text — a speculation hands it back by name — so the arm loop recovers
		// from it like any other broken arm, and the arms it skipped on the way
		// out are no evidence about what was written either.
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

		// NOTE: The arm loop is a RECOVERY loop and not a candidate reading, so
		// what it reports is a verdict about text that was written — and a
		// speculation the refusal escapes must not rewind it. The same `define`
		// in and out of a Record literal used to be answered differently: inside
		// one, the broken arm's Diagnostic was rewound and only the refusal
		// behind it survived.
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

		// NOTE: The refusal used to be thrown from BEHIND `parseClosingBrace`,
		// which is the one place a coded refusal peeks no Token — so it spoke
		// for an input that had ENDED, and the accurate `unclosed-block` the
		// brace had just reported was rewound by the speculation it escaped.
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
