import { describe, expect, it } from "bun:test"

import type { common, parser } from "@essence-lang/interfaces"

import { parseWithDiagnostics } from "../parser/index"
import { compiles } from "./followedHelps"

// The grammar of the `tests { … }` section and what is written only there:
// `test` and `suite`, their Modifiers, and the assertions. Only the followed
// Helps are compiled.

function parse(source: string): {
	program: parser.Program
	diagnostics: Array<common.Diagnostic>
} {
	return parseWithDiagnostics(source)
}

function testsOf(source: string): parser.TestsSectionNode {
	let { program, diagnostics } = parse(source)

	expect(diagnostics).toEqual([])
	expect(program.tests).not.toBeNull()

	return program.tests as parser.TestsSectionNode
}

function testAt(
	section: parser.TestsSectionNode,
	index: number,
): parser.TestNode {
	let node = section.nodes[index]

	expect(node?.nodeType).toBe("Test")

	return node as parser.TestNode
}

function nameOf(node: parser.TestNode | parser.SuiteNode): string {
	expect(node.name.nodeType).toBe("StringValue")

	return (node.name as parser.StringValueNode).value
}

function modifierNames(
	node: parser.TestNode | parser.SuiteNode,
): Array<string> {
	return node.modifiers.map((modifier) => modifier.name.content)
}

function argumentsOf(modifier: parser.TestModifierNode): Array<string> {
	return modifier.arguments.map((argument) => {
		switch (argument.nodeType) {
			case "Identifier":
				return argument.content
			case "RationalValue":
				return `${argument.numerator}/${argument.denominator}`
			default:
				return `${argument.value}`
		}
	})
}

describe("Tests Section", () => {
	describe("The section", () => {
		it("should read a tests section below the implementation", () => {
			let section = testsOf(
				`implementation {
					constant x = 1
				}

				tests {
					test "reads" {
						expect true
					}
				}`,
			)

			expect(section.nodes).toHaveLength(1)
			expect(nameOf(testAt(section, 0))).toBe("reads")
		})

		it("should read a tests section below the exports", () => {
			let { program, diagnostics } = parse(
				`implementation {
					constant x = 1
				}

				export {
					x
				}

				tests {
					test "reads" {
						expect true
					}
				}`,
			)

			expect(diagnostics).toEqual([])
			expect(program.tests?.nodes).toHaveLength(1)
			expect(program.exports?.entries).toHaveLength(1)
		})

		// A `Season.tests.es` file holds imports and tests only. The Program
		// still carries an empty implementation section, and `kind` says it was
		// never written.
		it("should read a file that is nothing but tests", () => {
			let { program, diagnostics } = parse(
				`import {
					from "./Other.es" { x }
				}

				tests {
					test "reads" {
						expect x
					}
				}`,
			)

			expect(diagnostics).toEqual([])
			expect(program.kind).toBe("tests")
			expect(program.imports?.entries).toHaveLength(1)
			expect(program.implementation.nodes).toEqual([])
			expect(program.tests?.nodes).toHaveLength(1)
			expect(program.implementation.position).toEqual(
				program.tests?.position as common.Position,
			)
		})

		it("should leave the section null where none was written", () => {
			let { program, diagnostics } = parse(
				"implementation { constant x = 1 }",
			)

			expect(diagnostics).toEqual([])
			expect(program.kind).toBe("implementation")
			expect(program.tests).toBeNull()
		})

		it("should take ordinary Statements alongside its tests", () => {
			let section = testsOf(
				`implementation {}

				tests {
					constant lions = { name = "Lions" }

					function twice(_ value: Integer) -> Integer {
						<- value::add(value)
					}

					test "reads" {
						expect true
					}
				}`,
			)

			expect(section.nodes.map((node) => node.nodeType)).toEqual([
				"ConstantDeclarationStatement",
				"FunctionStatement",
				"Test",
			])
		})

		it("should keep 'tests' usable as a name", () => {
			let { program, diagnostics } = parse(
				`implementation {
					constant tests = [1, 2]
					constant length = tests::length()
				}`,
			)

			expect(diagnostics).toEqual([])
			expect(program.tests).toBeNull()
			expect(program.implementation.nodes).toHaveLength(2)
		})

		// The report is about the tests block that moved, not the
		// implementation block behind it.
		it("should report a tests section written above the implementation", () => {
			let { program, diagnostics } = parse(
				`tests {
					test "reads" {
						expect x
					}
				}

				implementation {
					constant x = true
				}`,
			)

			expect(diagnostics).toHaveLength(1)
			expect(diagnostics[0].code).toBe("misplaced-tests-section")
			expect(diagnostics[0].position?.start.line).toBe(1)
			expect(program.tests?.nodes).toHaveLength(1)
			expect(program.implementation.nodes).toHaveLength(1)
		})

		it("should report a tests section written above the exports", () => {
			let { program, diagnostics } = parse(
				`implementation {
					constant x = 1
				}

				tests {
					test "reads" {
						expect true
					}
				}

				export {
					x
				}`,
			)

			expect(diagnostics).toHaveLength(1)
			expect(diagnostics[0].code).toBe("misplaced-tests-section")
			expect(diagnostics[0].severity).toBe("error")
			expect(diagnostics[0].labels).toHaveLength(2)

			// Kept, so one Diagnostic about the order replaces a cascade of
			// unknown names.
			expect(program.tests?.nodes).toHaveLength(1)
		})

		it("should compile with the tests section moved where each Help says", () => {
			let implementation = `implementation {
					constant x = 1
				}`
			let tests = `tests {
					test "reads" {
						expect x::is(1)
					}
				}`
			let exports = `export {
					x
				}`

			expect(
				parse(`${tests}\n\n${implementation}\n\n${exports}`)
					.diagnostics[0]?.helps,
			).toEqual([
				"Move the 'tests { … }' block below 'implementation { … }', and below anything the Module exports.",
			])
			expect(
				parse(`${implementation}\n\n${tests}\n\n${exports}`)
					.diagnostics[0]?.helps,
			).toEqual(["Move the 'tests { … }' block below 'export { … }'."])
			expect(
				compiles(`${implementation}\n\n${exports}\n\n${tests}`, {
					tests: true,
				}),
			).toBe(true)
		})
	})

	describe("test and suite", () => {
		it("should read a suite that nests suites and tests", () => {
			let section = testsOf(
				`implementation {}

				tests {
					suite "Standing" {
						test "records a win" {
							expect true
						}

						suite "nested" {
							test "still reads" {
								expect true
							}
						}
					}
				}`,
			)

			let suite = section.nodes[0] as parser.SuiteNode

			expect(suite.nodeType).toBe("Suite")
			expect(nameOf(suite)).toBe("Standing")
			expect(suite.nodes.map((node) => node.nodeType)).toEqual([
				"Test",
				"Suite",
			])
		})

		it("should read an interpolated name", () => {
			let section = testsOf(
				`implementation {}

				tests {
					constant scored = 2

					test "{scored} is a win" {
						expect true
					}
				}`,
			)

			let node = section.nodes[1] as parser.TestNode

			expect(node.name.nodeType).toBe("InterpolatedStringValue")
		})

		// The Keyword's span is where a Code Lens sits. A Diagnostic about the
		// test underlines the whole item.
		it("should carry the Keyword's Position apart from the item's", () => {
			let section = testsOf(
				`implementation {}

				tests {
					test "reads" {
						expect true
					}
				}`,
			)

			let node = testAt(section, 0)

			expect(node.keywordPosition).toEqual({
				start: { line: 4, column: 6 },
				end: { line: 4, column: 10 },
			})
			expect(node.position.start).toEqual(node.keywordPosition.start)
			expect(node.position.end.line).toBe(6)
		})

		it("should keep 'test' and 'suite' usable as names", () => {
			let { program, diagnostics } = parse(
				`implementation {
					variable test = 1
					constant suite = 2

					test = suite
				}`,
			)

			expect(diagnostics).toEqual([])
			expect(
				program.implementation.nodes.map((node) => node.nodeType),
			).toEqual([
				"VariableDeclarationStatement",
				"ConstantDeclarationStatement",
				"VariableAssignmentStatement",
			])
		})

		it("should report a test written outside every tests section", () => {
			let { diagnostics } = parse(
				`implementation {
					test "nope" {
						expect true
					}
				}`,
			)

			expect(diagnostics).toHaveLength(1)
			expect(diagnostics[0].code).toBe("test-outside-tests")
			expect(diagnostics[0].labels).toHaveLength(1)
			expect(diagnostics[0].position?.start).toEqual({
				line: 2,
				column: 6,
			})
		})

		it("should read on past a refused test", () => {
			let { program, diagnostics } = parse(
				`implementation {
					suite "nope" {
						test "inner" {
							expect true
						}
					}

					constant after = 1
				}`,
			)

			expect(diagnostics).toHaveLength(1)
			expect(diagnostics[0].code).toBe("test-outside-tests")
			expect(program.implementation.nodes).toHaveLength(1)
			expect(program.implementation.nodes[0]?.nodeType).toBe(
				"ConstantDeclarationStatement",
			)
		})

		it("should report a test nested in another test's body", () => {
			let { diagnostics } = parse(
				`implementation {}

				tests {
					test "outer" {
						test "inner" {
							expect true
						}
					}
				}`,
			)

			expect(diagnostics).toHaveLength(1)
			expect(diagnostics[0].code).toBe("test-outside-tests")
		})

		it("should refuse a name that is not a String", () => {
			let { diagnostics } = parse(
				`implementation {}

				tests {
					test reads {
						expect true
					}
				}`,
			)

			expect(diagnostics.length).toBeGreaterThan(0)
			expect(diagnostics[0].code).toBe("syntax-error")
		})
	})

	describe("benchmark", () => {
		it("should read a benchmark as a test whose form says so", () => {
			let section = testsOf(
				`implementation {}

				tests {
					test "records a win" {
						expect true
					}

					benchmark "sorts ten thousand rows" {
						expect true
					}
				}`,
			)

			expect(testAt(section, 0).form).toBe("test")

			let node = testAt(section, 1)

			expect(node.form).toBe("benchmark")
			expect(nameOf(node)).toBe("sorts ten thousand rows")
		})

		it("should read a benchmark's Modifiers and rows the way a test's read", () => {
			let section = testsOf(
				`implementation {}

				tests {
					benchmark "sorts {size} rows" tagged slow across [100, 10000] (size: Integer) {
						expect true
					}
				}`,
			)

			let node = testAt(section, 0)

			expect(node.form).toBe("benchmark")
			expect(modifierNames(node)).toEqual(["tagged"])
			expect(node.table).not.toBeNull()
		})

		it("should keep 'benchmark' usable as a name", () => {
			let { program, diagnostics } = parse(
				`implementation {
					constant benchmark = 1
					constant doubled = benchmark
				}`,
			)

			expect(diagnostics).toEqual([])
			expect(
				program.implementation.nodes.map((node) => node.nodeType),
			).toEqual([
				"ConstantDeclarationStatement",
				"ConstantDeclarationStatement",
			])
		})

		it("should report a benchmark written outside every tests section", () => {
			let { diagnostics } = parse(
				`implementation {
					benchmark "nope" {
						expect true
					}
				}`,
			)

			expect(diagnostics).toHaveLength(1)
			expect(diagnostics[0].code).toBe("test-outside-tests")
		})
	})

	// Recovery resynchronises on the Tokens a Statement can begin with, and
	// skips an item opened by any other Keyword. A broken Statement in a test's
	// body must cost that Statement alone.
	describe("Error recovery", () => {
		it("should read the next test after a broken Statement in a body", () => {
			let { program, diagnostics } = parse(
				`implementation {}

				tests {
					test "broken" {
						constant x =
					}

					test "after" {
						expect true
					}
				}`,
			)

			expect(diagnostics.length).toBeGreaterThan(0)

			let nodes = program.tests?.nodes as Array<parser.TestsNode>

			expect(nodes.map((node) => node.nodeType)).toEqual(["Test", "Test"])
			expect(nameOf(nodes[1] as parser.TestNode)).toBe("after")
		})

		it("should read the next test after a broken Statement in a suite", () => {
			let { program, diagnostics } = parse(
				`implementation {}

				tests {
					suite "outer" {
						constant =

						test "after" {
							expect true
						}
					}
				}`,
			)

			expect(diagnostics.length).toBeGreaterThan(0)

			let suite = program.tests?.nodes[0] as parser.SuiteNode

			expect(suite.nodes).toHaveLength(1)
			expect(suite.nodes[0]?.nodeType).toBe("Test")
		})

		it("should report a tests section that is never closed", () => {
			let { diagnostics } = parse(
				`implementation {}

				tests {
					test "reads" {
						expect true
					}`,
			)

			expect(diagnostics).toHaveLength(1)
			expect(diagnostics[0].code).toBe("unclosed-block")
		})
	})

	describe("Modifiers", () => {
		it("should read a Modifier with no arguments", () => {
			let section = testsOf(
				`implementation {}

				tests {
					test "reads" focused {
						expect true
					}
				}`,
			)

			let node = testAt(section, 0)

			expect(modifierNames(node)).toEqual(["focused"])
			expect(node.modifiers[0]?.arguments).toEqual([])
		})

		it("should read a Modifier with a String argument", () => {
			let section = testsOf(
				`implementation {}

				tests {
					test "reads" skipped "waiting on the redesign" {
						expect true
					}
				}`,
			)

			let modifier = testAt(section, 0)
				.modifiers[0] as parser.TestModifierNode

			expect(modifier.name.content).toBe("skipped")
			expect(argumentsOf(modifier)).toEqual(["waiting on the redesign"])
			expect(modifier.position).toEqual({
				start: { line: 4, column: 19 },
				end: { line: 4, column: 52 },
			})
		})

		it("should read a Modifier with several bare-name arguments", () => {
			let section = testsOf(
				`implementation {}

				tests {
					test "reads" tagged slow, network {
						expect true
					}
				}`,
			)

			let modifier = testAt(section, 0)
				.modifiers[0] as parser.TestModifierNode

			expect(modifier.name.content).toBe("tagged")
			expect(argumentsOf(modifier)).toEqual(["slow", "network"])
		})

		it("should read a Number argument, for the vocabulary that comes later", () => {
			let section = testsOf(
				`implementation {}

				tests {
					test "reads" retries 3 {
						expect true
					}
				}`,
			)

			let modifier = testAt(section, 0)
				.modifiers[0] as parser.TestModifierNode

			expect(modifier.name.content).toBe("retries")
			expect(modifier.arguments[0]?.nodeType).toBe("IntegerValue")
		})

		it("should read several Modifiers in a row", () => {
			let section = testsOf(
				`implementation {}

				tests {
					test "reads" skipped "waiting" tagged slow, network {
						expect true
					}
				}`,
			)

			let node = testAt(section, 0)

			expect(modifierNames(node)).toEqual(["skipped", "tagged"])
			expect(
				argumentsOf(node.modifiers[1] as parser.TestModifierNode),
			).toEqual(["slow", "network"])
		})

		// A bare name is an argument where a comma or the body follows it, and
		// a Modifier elsewhere, so `focused tagged slow` is not `focused(tagged)`.
		it("should leave a bare name in front of another Modifier alone", () => {
			let section = testsOf(
				`implementation {}

				tests {
					test "reads" focused tagged slow {
						expect true
					}
				}`,
			)

			let node = testAt(section, 0)

			expect(modifierNames(node)).toEqual(["focused", "tagged"])
			expect(node.modifiers[0]?.arguments).toEqual([])
			expect(
				argumentsOf(node.modifiers[1] as parser.TestModifierNode),
			).toEqual(["slow"])
		})

		it("should leave a bare name in front of a literal alone", () => {
			let section = testsOf(
				`implementation {}

				tests {
					test "reads" focused skipped "waiting" {
						expect true
					}
				}`,
			)

			let node = testAt(section, 0)

			expect(modifierNames(node)).toEqual(["focused", "skipped"])
			expect(node.modifiers[0]?.arguments).toEqual([])
		})

		it("should carry Modifiers on a suite too", () => {
			let section = testsOf(
				`implementation {}

				tests {
					suite "slow ones" tagged slow {
						test "reads" {
							expect true
						}
					}
				}`,
			)

			let suite = section.nodes[0] as parser.SuiteNode

			expect(modifierNames(suite)).toEqual(["tagged"])
		})

		it("should refuse an interpolated String as an argument", () => {
			let { diagnostics } = parse(
				`implementation {}

				tests {
					constant reason = "later"

					test "reads" skipped "{reason}" {
						expect true
					}
				}`,
			)

			expect(diagnostics.length).toBeGreaterThan(0)
			expect(diagnostics[0].code).toBe("syntax-error")
			expect(diagnostics[0].message).toContain("interpolated String")
		})
	})

	describe("expect and require", () => {
		it("should read the Boolean form of both", () => {
			let section = testsOf(
				`implementation {}

				tests {
					test "reads" {
						expect true
						require false
					}
				}`,
			)

			expect(
				testAt(section, 0).body.map((node) => node.nodeType),
			).toEqual(["ExpectStatement", "RequireStatement"])
		})

		it("should read a Matcher left of '='", () => {
			let section = testsOf(
				`implementation {}

				tests {
					test "reads" {
						require #Value(second) = first
						require { name = "Lions" } = second
						require { name: String } = second
						require Integer = second
						require #Empty = third
					}
				}`,
			)

			let body = testAt(section, 0)
				.body as Array<parser.RequireStatementNode>

			expect(body.map((node) => node.matcher?.nodeType)).toEqual([
				"CaseMatcher",
				"Pattern",
				"Pattern",
				"IdentifierTypeDeclaration",
				"CaseMatcher",
			])
		})

		// A Match Handler refuses `} as name` because `@` names the whole value.
		// An assertion has no `@` and often takes apart a computed value, so the
		// binder is allowed here.
		it("should let a Pattern name the whole value", () => {
			let section = testsOf(
				`implementation {}

				tests {
					test "reads" {
						require { name } as row = rows::item(at 1)
						expect name::is("Lions")
						expect row.name::is("Lions")
					}
				}`,
			)

			let node = testAt(section, 0).body[0] as parser.RequireStatementNode
			let matcher = node.matcher as parser.PatternNode

			expect(matcher.nodeType).toBe("Pattern")
			expect(matcher.binder?.content).toBe("row")
		})

		// `{ name }` and `#Value(second)` are Expressions too, and only an `=`
		// behind them makes a Matcher. Without one they read as the asserted
		// Expression.
		it("should read what is no Matcher as the asserted Expression", () => {
			let section = testsOf(
				`implementation {}

				tests {
					test "reads" {
						expect { name = "Lions" }.name::is("Lions")
						expect #Value(1)::is(first)
					}
				}`,
			)

			let body = testAt(section, 0)
				.body as Array<parser.ExpectStatementNode>

			expect(body.map((node) => node.nodeType)).toEqual([
				"ExpectStatement",
				"ExpectStatement",
			])
			expect(body.map((node) => node.matcher)).toEqual([null, null])
			expect(body.map((node) => node.value.nodeType)).toEqual([
				"MethodInvocation",
				"MethodInvocation",
			])
		})

		it("should span the Keyword through the value", () => {
			let section = testsOf(
				`implementation {}

				tests {
					test "reads" {
						require #Value(second) = first
					}
				}`,
			)

			let node = testAt(section, 0).body[0] as parser.RequireStatementNode

			// A failed assertion is underlined through the value, not only
			// the Matcher.
			expect(node.position).toEqual({
				start: { line: 5, column: 7 },
				end: { line: 5, column: 37 },
			})
		})

		it("should refuse a wildcard Matcher", () => {
			let { diagnostics } = parse(
				`implementation {}

				tests {
					test "reads" {
						require _ = first
					}
				}`,
			)

			expect(diagnostics).toHaveLength(1)
			expect(diagnostics[0].code).toBe("wildcard-in-require")
		})

		it("should refuse a literal Matcher", () => {
			let { diagnostics } = parse(
				`implementation {}

				tests {
					test "reads" {
						require 3 = first
					}
				}`,
			)

			expect(diagnostics).toHaveLength(1)
			expect(diagnostics[0].code).toBe("literal-in-require")
			// Built from the name and the literal as written, as the Quick Fix
			// builds its edit.
			expect(diagnostics[0].helps).toEqual([
				"Compare instead: 'first::is(3)'.",
			])
		})

		it("should spell the literal a String Matcher wrote", () => {
			let { diagnostics } = parse(
				`implementation {}

				tests {
					test "reads" {
						require "Lions" = name
					}
				}`,
			)

			expect(diagnostics[0].helps).toEqual([
				`Compare instead: 'name::is("Lions")'.`,
			])
		})

		// Read off the source, since a String Node holds the value its escapes
		// stand for. Without its escape, the `{` of `\\{` would open an
		// interpolation hole.
		it("should spell a String Matcher's escapes as they were written", () => {
			let source = `implementation {
				constant body = "a"
			}

			tests {
				test "reads" {
					require "\\{\\"a\\": 1\\}" = body
				}
			}`

			expect(parse(source).diagnostics[0]?.helps).toEqual([
				`Compare instead: 'body::is("\\{\\"a\\": 1\\}")'.`,
			])
			expect(
				compiles(
					`implementation {
				constant body = "a"
			}

			tests {
				test "reads" {
					require body::is("\\{\\"a\\": 1\\}")
				}
			}`,
					{ tests: true },
				),
			).toBe(true)
		})

		it("should spell a backslash the way it was written", () => {
			let source = `implementation {
				constant path = "a"
			}

			tests {
				test "reads" {
					require "a\\\\b" = path
				}
			}`

			expect(parse(source).diagnostics[0]?.helps).toEqual([
				`Compare instead: 'path::is("a\\\\b")'.`,
			])
			expect(
				compiles(
					`implementation {
				constant path = "a"
			}

			tests {
				test "reads" {
					require path::is("a\\\\b")
				}
			}`,
					{ tests: true },
				),
			).toBe(true)
		})

		// A Rational Node has two spellings, and the reader gets back the one
		// they wrote.
		it("should spell a Rational Matcher the way it was written", () => {
			let source = `implementation {
				constant ratio = 0.5
			}

			tests {
				test "reads" {
					require 0.75 = ratio
				}
			}`

			expect(parse(source).diagnostics[0]?.helps).toEqual([
				"Compare instead: 'ratio::is(0.75)'.",
			])
			expect(
				compiles(
					`implementation {
				constant ratio = 0.5
			}

			tests {
				test "reads" {
					require ratio::is(0.75)
				}
			}`,
					{ tests: true },
				),
			).toBe(true)
		})

		it("should compile the comparison it spells for a Number", () => {
			expect(
				compiles(
					`implementation {
				constant first = 3
			}

			tests {
				test "reads" {
					require first::is(3)
				}
			}`,
					{ tests: true },
				),
			).toBe(true)
		})

		// A Help is one line, so a String written across two lines becomes a
		// schematic.
		it("should write a schematic where the literal spans lines", () => {
			let { diagnostics } = parse(
				`implementation {}

				tests {
					test "reads" {
						require "line one
line two" = body
					}
				}`,
			)

			expect(diagnostics[0]?.helps).toEqual([
				"Compare instead: 'body::is(…)'.",
			])
		})

		// The Parser keeps no text for a value that is not a name, so it is
		// written as a schematic.
		it("should write a schematic where the value is no name", () => {
			let { diagnostics } = parse(
				`implementation {}

				tests {
					test "reads" {
						require 3 = scores::first()
					}
				}`,
			)

			expect(diagnostics[0].helps).toEqual([
				"Compare instead: '…::is(3)'.",
			])
		})

		// The test carries on past a failed `expect`, so a name its Matcher
		// bound would not be true on the lines after it.
		it("should refuse a Matcher on an expect", () => {
			let { diagnostics } = parse(
				`implementation {}

				tests {
					test "reads" {
						expect #Value(second) = first
					}
				}`,
			)

			expect(diagnostics).toHaveLength(1)
			expect(diagnostics[0].code).toBe("matcher-on-expect")
		})

		it("should report the Matcher written after the value", () => {
			let { diagnostics } = parse(
				`implementation {}

				tests {
					test "reads" {
						require first is #Value(second)
						expect first is { name = "Lions" }
					}
				}`,
			)

			expect(diagnostics.map((diagnostic) => diagnostic.code)).toEqual([
				"matcher-after-value",
				"matcher-after-value",
			])

			// From the `is` through the end of the Matcher, the whole of what
			// the language does not have.
			expect(diagnostics[0].position).toEqual({
				start: { line: 5, column: 21 },
				end: { line: 5, column: 38 },
			})
		})

		// A snapshot records a value, so on a line that takes one apart, the
		// name it introduced is recorded on a line of its own.
		it("should refuse a snapshot on a line that takes a value apart", () => {
			let { diagnostics } = parse(
				`implementation {}

				tests {
					test "reads" {
						require #Value(second) = first matches snapshot "one"
					}
				}`,
			)

			expect(diagnostics).toHaveLength(1)
			expect(diagnostics[0].code).toBe("snapshot-after-matcher")

			// From `matches` through the end of the recorded text, so no tail
			// is read as a Statement of its own.
			expect(diagnostics[0].position).toEqual({
				start: { line: 5, column: 38 },
				end: { line: 5, column: 60 },
			})
		})

		// The Statement is dropped, so its Quick Fix reads the names it
		// introduced off the Diagnostic.
		it("should carry the names the refused Matcher introduced", () => {
			let { diagnostics } = parse(
				`implementation {}

				tests {
					test "reads" {
						require #Value(second) = first matches snapshot
						require { points, played } = row matches snapshot
						require Integer = count matches snapshot
					}
				}`,
			)

			expect(diagnostics.map((diagnostic) => diagnostic.data)).toEqual([
				{ kind: "introduced-names", names: ["second"] },
				{ kind: "introduced-names", names: ["points", "played"] },
				{ kind: "introduced-names", names: [] },
			])
		})

		it("should refuse a snapshot that has never run the same way", () => {
			let { program, diagnostics } = parse(
				`implementation {}

				tests {
					test "reads" {
						require #Value(second) = first matches snapshot
					}

					test "reads again" {
						expect true
					}
				}`,
			)

			expect(diagnostics.map((diagnostic) => diagnostic.code)).toEqual([
				"snapshot-after-matcher",
			])

			// The refusal drops the assertion and nothing else.
			let section = program.tests as parser.TestsSectionNode

			expect(section.nodes).toHaveLength(2)
			expect(
				(section.nodes[1] as parser.TestNode).body.map(
					(node) => node.nodeType,
				),
			).toEqual(["ExpectStatement"])
		})

		it("should read the rest of the test past a refused assertion", () => {
			let { program, diagnostics } = parse(
				`implementation {}

				tests {
					test "reads" {
						expect true
						require _ = first
						expect false
					}
				}`,
			)

			expect(diagnostics).toHaveLength(1)

			let test = (program.tests as parser.TestsSectionNode)
				.nodes[0] as parser.TestNode

			expect(test.body.map((node) => node.nodeType)).toEqual([
				"ExpectStatement",
				"ExpectStatement",
			])
		})

		it("should read an assertion in a block nested in the test", () => {
			let section = testsOf(
				`implementation {}

				tests {
					test "reads" {
						if true {
							expect true
						}

						match first -> Boolean {
							case _ {
								expect true

								<- true
							}
						}
					}
				}`,
			)

			expect(testAt(section, 0).body).toHaveLength(2)
		})

		it("should keep 'expect' and 'require' usable as names", () => {
			let { program, diagnostics } = parse(
				`implementation {
					constant expect = 6
					constant require = expect::is(6)
				}`,
			)

			expect(diagnostics).toEqual([])
			expect(program.implementation.nodes).toHaveLength(2)
		})

		it("should keep a call of a Function named 'expect' a call", () => {
			let { program, diagnostics } = parse(
				`implementation {
					function expect(_ value: Boolean) -> {} {}

					expect(true)
				}`,
			)

			expect(diagnostics).toEqual([])
			expect(program.implementation.nodes[1]?.nodeType).toBe(
				"FunctionInvocation",
			)
		})

		it("should keep a member read off a value named 'require' a read", () => {
			let { program, diagnostics } = parse(
				`implementation {
					constant require = { a = 1 }
					constant read = require.a
				}`,
			)

			expect(diagnostics).toEqual([])
			expect(program.implementation.nodes).toHaveLength(2)
		})

		it("should keep a Case of a Choice named 'expect' a Case", () => {
			let { program, diagnostics } = parse(
				`implementation {
					choice expect {
						Win
					}

					constant won = expect#Win
				}`,
			)

			expect(diagnostics).toEqual([])
			expect(program.implementation.nodes).toHaveLength(2)
		})

		it("should report an assertion written outside every test", () => {
			let { diagnostics } = parse(
				`implementation {
					constant x = 1

					expect x::is(1)
				}`,
			)

			expect(diagnostics).toHaveLength(1)
			expect(diagnostics[0].code).toBe("expect-outside-test")
			expect(diagnostics[0].severity).toBe("error")
			expect(diagnostics[0].labels).toHaveLength(1)
		})

		it("should report an assertion written in a suite's own body", () => {
			let { diagnostics } = parse(
				`implementation {}

				tests {
					suite "outer" {
						expect true

						test "reads" {
							expect true
						}
					}
				}`,
			)

			expect(diagnostics).toHaveLength(1)
			expect(diagnostics[0].code).toBe("expect-outside-test")
		})

		// A Function literal in a test body runs wherever it is handed, which
		// the test can not answer for.
		it("should report an assertion written in a Function literal", () => {
			let { diagnostics } = parse(
				`implementation {}

				tests {
					test "reads" {
						expect items::every((item) {
							expect item

							<- true
						})
					}
				}`,
			)

			expect(diagnostics).toHaveLength(1)
			expect(diagnostics[0].code).toBe("expect-outside-test")
			expect(diagnostics[0].position?.start).toEqual({
				line: 6,
				column: 8,
			})
		})

		it("should report an assertion in a Function declared in a test body", () => {
			let { diagnostics } = parse(
				`implementation {}

				tests {
					test "reads" {
						function check(_ value: Boolean) -> Boolean {
							expect value

							<- value
						}

						expect check(true)
					}
				}`,
			)

			expect(diagnostics).toHaveLength(1)
			expect(diagnostics[0].code).toBe("expect-outside-test")
		})

		// Either half of the Help: the assertion moves into a test, or the
		// literal returns the value and the test asserts on it.
		it("should compile with the assertion moved where the Help says", () => {
			expect(
				parse(`implementation {
					constant x = 1

					expect x::is(1)
				}`).diagnostics[0]?.helps,
			).toEqual([
				"Move it into a 'test \"…\" { … }' block, or return the value and assert on it there.",
			])
			expect(
				compiles(
					`implementation {
					constant x = 1
				}

				tests {
					test "reads" {
						expect x::is(1)
					}
				}`,
					{ tests: true },
				),
			).toBe(true)
			expect(
				compiles(
					`implementation {
					function double(_ number: Integer) -> Integer {
						<- number::multiply(with 2)
					}
				}

				tests {
					test "doubles" {
						constant check = (_ number: Integer) -> Integer {
							<- double(number)
						}

						expect check(2)::isPositive()
					}
				}`,
					{ tests: true },
				),
			).toBe(true)
		})
	})

	describe("Table tests", () => {
		it("should read the rows and the row Parameter", () => {
			let section = testsOf(
				`implementation {}

				tests {
					test "{scored}–{conceded}" across [
						{ scored = 2, conceded = 1 },
						{ scored = 1, conceded = 1 },
					] ({ scored, conceded }: Scoreline) {
						expect true
					}
				}`,
			)

			let table = testAt(section, 0).table as parser.TestTableNode

			expect(table.nodeType).toBe("TestTable")
			expect(table.value.nodeType).toBe("ListValue")
			expect((table.value as parser.ListValueNode).values).toHaveLength(2)
			expect(table.parameters).toHaveLength(1)
			expect(table.parameters[0]?.internalName?.nodeType).toBe("Pattern")
		})

		it("should read a named row Parameter", () => {
			let section = testsOf(
				`implementation {}

				tests {
					test "rows" across [1, 2] (n: Integer) {
						expect true
					}
				}`,
			)

			let table = testAt(section, 0).table as parser.TestTableNode
			let parameter = table.parameters[0] as parser.ParameterNode

			expect(
				(parameter.internalName as parser.IdentifierNode).content,
			).toBe("n")
		})

		// `(` after an Expression is a call everywhere else, so only the block
		// behind it makes a Parameter list.
		it("should let the rows be a call", () => {
			let section = testsOf(
				`implementation {}

				tests {
					test "rows" across rowsOf(table) (n: Integer) {
						expect true
					}
				}`,
			)

			let table = testAt(section, 0).table as parser.TestTableNode

			expect(table.value.nodeType).toBe("FunctionInvocation")
			expect(table.parameters).toHaveLength(1)
		})

		it("should read Modifiers in front of the rows", () => {
			let section = testsOf(
				`implementation {}

				tests {
					test "rows" tagged slow across [1] (n: Integer) {
						expect true
					}
				}`,
			)

			let node = testAt(section, 0)

			expect(modifierNames(node)).toEqual(["tagged"])
			expect(
				argumentsOf(node.modifiers[0] as parser.TestModifierNode),
			).toEqual(["slow"])
			expect(node.table).not.toBeNull()
		})

		it("should leave 'across' an ordinary name", () => {
			let { diagnostics, program } = parse(
				`implementation {
					constant across = 1
				}`,
			)

			expect(diagnostics).toEqual([])
			expect(program.implementation.nodes).toHaveLength(1)
		})

		it("should span the Keyword through the Parameter list", () => {
			let section = testsOf(
				`implementation {}

				tests {
					test "rows" across [1] (n: Integer) {
						expect true
					}
				}`,
			)

			let table = testAt(section, 0).table as parser.TestTableNode

			expect(table.position).toEqual({
				start: { line: 4, column: 18 },
				end: { line: 4, column: 41 },
			})
		})
	})

	describe("Property tests", () => {
		it("should read the Parameters the runner generates", () => {
			let section = testsOf(
				`implementation {}

				tests {
					test "add commutes" for any (a: Integer, b: Integer) {
						expect true
					}
				}`,
			)

			let properties = testAt(section, 0)
				.properties as parser.TestPropertiesNode

			expect(properties.nodeType).toBe("TestProperties")
			expect(properties.parameters).toHaveLength(2)
			expect(
				properties.parameters.map(
					(parameter) =>
						(parameter.internalName as parser.IdentifierNode)
							.content,
				),
			).toEqual(["a", "b"])
		})

		it("should read an applied Type on a Parameter", () => {
			let section = testsOf(
				`implementation {}

				tests {
					test "keeps every team" for any (teams: NonEmptyList<String>) {
						expect true
					}
				}`,
			)

			let properties = testAt(section, 0)
				.properties as parser.TestPropertiesNode

			expect(properties.parameters).toHaveLength(1)
			expect(properties.parameters[0]?.type?.nodeType).toBe(
				"GenericTypeDeclaration",
			)
		})

		it("should read Modifiers in front of the Parameters", () => {
			let section = testsOf(
				`implementation {}

				tests {
					test "holds" tagged slow for any (a: Integer) {
						expect true
					}
				}`,
			)

			let node = testAt(section, 0)

			expect(modifierNames(node)).toEqual(["tagged"])
			expect(
				argumentsOf(node.modifiers[0] as parser.TestModifierNode),
			).toEqual(["slow"])
			expect(node.properties).not.toBeNull()
		})

		it("should leave 'any' an ordinary name", () => {
			let { diagnostics, program } = parse(
				`implementation {
					constant any = 1
					constant other = any
				}`,
			)

			expect(diagnostics).toEqual([])
			expect(program.implementation.nodes).toHaveLength(2)
		})

		it("should span the Keyword through the Parameter list", () => {
			let section = testsOf(
				`implementation {}

				tests {
					test "holds" for any (a: Integer) {
						expect true
					}
				}`,
			)

			let properties = testAt(section, 0)
				.properties as parser.TestPropertiesNode

			expect(properties.position).toEqual({
				start: { line: 4, column: 19 },
				end: { line: 4, column: 39 },
			})
		})

		it("should read a test with neither a table nor Parameters", () => {
			let section = testsOf(
				`implementation {}

				tests {
					test "plain" {
						expect true
					}
				}`,
			)

			expect(testAt(section, 0).properties).toBeNull()
			expect(testAt(section, 0).table).toBeNull()
		})
	})

	describe("Snapshots", () => {
		it("should read a snapshot that has never run", () => {
			let section = testsOf(
				`implementation {}

				tests {
					test "renders" {
						expect table matches snapshot
					}
				}`,
			)

			let node = testAt(section, 0).body[0] as parser.ExpectStatementNode
			let snapshot = node.snapshot as parser.SnapshotNode

			expect(snapshot.name).toBeNull()
			expect(snapshot.value).toBeNull()
			expect(node.matcher).toBeNull()
		})

		it("should read a recorded inline snapshot", () => {
			let section = testsOf(
				`implementation {}

				tests {
					test "renders" {
						expect table matches snapshot "Lions 19"
					}
				}`,
			)

			let node = testAt(section, 0).body[0] as parser.ExpectStatementNode
			let snapshot = node.snapshot as parser.SnapshotNode

			expect(snapshot.name).toBeNull()
			expect(snapshot.value?.value).toBe("Lions 19")
			expect(snapshot.valuePosition).toEqual(
				snapshot.value?.position as common.Position,
			)
		})

		it("should read a stored snapshot by name", () => {
			let section = testsOf(
				`implementation {}

				tests {
					test "renders" {
						expect table matches snapshot from "season-report"
					}
				}`,
			)

			let node = testAt(section, 0).body[0] as parser.ExpectStatementNode
			let snapshot = node.snapshot as parser.SnapshotNode

			expect(snapshot.name?.value).toBe("season-report")
			expect(snapshot.value).toBeNull()
		})

		it("should read a snapshot after 'require'", () => {
			let section = testsOf(
				`implementation {}

				tests {
					test "renders" {
						require table matches snapshot
					}
				}`,
			)

			let node = testAt(section, 0).body[0] as parser.RequireStatementNode

			expect(node.nodeType).toBe("RequireStatement")
			expect(node.snapshot).not.toBeNull()
		})

		it("should refuse an interpolated snapshot", () => {
			let { diagnostics } = parse(
				`implementation {}

				tests {
					test "renders" {
						expect table matches snapshot "{name}"
					}
				}`,
			)

			expect(diagnostics.length).toBeGreaterThan(0)
			expect(diagnostics[0].code).toBe("syntax-error")
		})

		it("should leave 'matches' an ordinary name", () => {
			let { diagnostics, program } = parse(
				`implementation {
					constant matches = 1
				}`,
			)

			expect(diagnostics).toEqual([])
			expect(program.implementation.nodes).toHaveLength(1)
		})
	})
})
