import { describe, expect, it } from "bun:test"

import type { common, parser } from "@essence-lang/interfaces"

import { parseWithDiagnostics } from "../parser/index"

// NOTE: The `tests { … }` section and everything only written in it — the two
// items, their Modifiers and the two assertions. This covers the GRAMMAR
// alone: nothing here is enriched, and a tests section costs a compiled
// Program nothing until `essence test` asks for it.

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

		// NOTE: The `Season.tests.es` convention — imports and tests and no
		// implementation block at all. The Program still carries an
		// implementation section so that everything walking Statements walks
		// one shape; `kind` is what says the block was never written.
		it("should read a file that is nothing but tests", () => {
			let { program, diagnostics } = parse(
				`import {
					x from "./Other.es"
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

		// NOTE: A tests block first reads as a file that is nothing but tests
		// until the implementation block turns up behind it. The Diagnostic has
		// to be about the block that moved, rather than "unexpected
		// 'implementation'" about the one that did not.
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
			expect(diagnostics[0].position.start.line).toBe(1)
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

			// NOTE: Kept rather than dropped — one Diagnostic about an order
			// beats a cascade of "unknown name" about everything inside it.
			expect(program.tests?.nodes).toHaveLength(1)
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

		// NOTE: The Keyword's own span, for a Code Lens to sit on — the
		// Position of the item spans the whole form, which is what a Diagnostic
		// about the test underlines instead.
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

		// NOTE: The whole item is read before it is refused, so the Statement
		// written after it is still read as itself.
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

	// NOTE: Error recovery resynchronises on the Tokens a Statement can begin
	// with, so a Keyword missing from that list is not a Statement start to the
	// recovery — and the whole item it opens, braces and all, is skipped
	// without a word. That is what these hold: a broken Statement inside a
	// test's body must cost that Statement and nothing around it.
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

		// NOTE: A bare name is the one shape a Modifier and its own argument
		// share. It is an argument where a comma or the body follows it, and a
		// Modifier of its own everywhere else — which is what keeps
		// `focused tagged slow` from reading as `focused(tagged)`.
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

		// NOTE: A Match Handler refuses `} as name` because `@` already names
		// the whole value. An assertion has no `@`, and what it takes apart is
		// often a computed value with no name of its own, so the binder is
		// allowed here — the one place a Matcher's Pattern may carry one.
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

		// NOTE: The reading a cover grammar could not give back: `{ name }` and
		// `#Value(second)` are Expressions as well, and only the `=` behind the
		// Matcher says which was written. What is not a Matcher is read as the
		// Expression it is, and nothing the Matcher reading touched is left
		// behind.
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

			// NOTE: Through the end of the value, which is where the Statement
			// ends — the span is drawn under a failed assertion, and one that
			// stopped at the Matcher would leave a reader looking at what the
			// value was supposed to be with no sight of what it was.
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
			expect(diagnostics[0].helps).toEqual([
				"Compare instead: 'require x::is(3)'.",
			])
		})

		// NOTE: An `expect` records its result and the test carries on, so
		// there is no line below it that only runs where the Matcher matched —
		// which is the only place a name it bound would be true.
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

			// NOTE: From the `is` through the end of the Matcher — the whole of
			// what the language does not have, rather than the Token that
			// opened it.
			expect(diagnostics[0].position).toEqual({
				start: { line: 5, column: 21 },
				end: { line: 5, column: 38 },
			})
		})

		// NOTE: A snapshot records a value, and the line it is written on took
		// one apart — so what there is to record is the name it introduced, on
		// a line of its own.
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

			// NOTE: From `matches` through the end of the recorded text — the
			// whole snapshot, read to its end before the report so no tail of
			// it is left to be read as a Statement of its own.
			expect(diagnostics[0].position).toEqual({
				start: { line: 5, column: 38 },
				end: { line: 5, column: 60 },
			})
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

			// NOTE: The test below is read whole — the refusal drops the
			// assertion and nothing else.
			let section = program.tests as parser.TestsSectionNode

			expect(section.nodes).toHaveLength(2)
			expect(
				(section.nodes[1] as parser.TestNode).body.map(
					(node) => node.nodeType,
				),
			).toEqual(["ExpectStatement"])
		})

		// NOTE: A refused assertion is DROPPED, as every broken Statement is,
		// and the Statements around it are still read.
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

		// NOTE: The boundary the rule is really about — a Function literal
		// written in a test body runs wherever it is handed to, which is not
		// something the test can answer for.
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

		// NOTE: `(` after an Expression is a call everywhere else, so the one
		// thing that says the Parameter list is a Parameter list is the block
		// behind it.
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
