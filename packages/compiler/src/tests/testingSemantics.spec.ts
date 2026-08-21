import { describe, expect, it } from "bun:test"
import { readFileSync } from "node:fs"

import { fixturePath } from "@essence-lang/fixtures"
import type { common } from "@essence-lang/interfaces"

import { containsErrors } from "../diagnostics/index"
import { enrich } from "../enricher/index"
import { testIdentityKey } from "../enricher/tests"
import { optimise } from "../optimiser/index"
import { parseWithDiagnostics } from "../parser/index"
import { rewrite } from "../rewriter/index"
import { simplify } from "../simplifier/index"
import { validate } from "../validator/index"

// NOTE: What a tests section MEANS — the Scopes it opens, the vocabulary its
// Modifiers are read against, what an assertion demands of what it asserts, and
// the identity every test carries. The grammar alone is `testing.spec.ts`.
//
// Everything here enriches with `tests: true`, because that is the one thing
// that makes a `tests { … }` block anything but parsed text. The last describe
// block is the other half of that: with the flag off, the section is not there.

function analyse(
	source: string,
	options: { tests?: boolean } = {},
): {
	program: common.typed.Program
	diagnostics: Array<common.Diagnostic>
} {
	let parsed = parseWithDiagnostics(source)

	expect(parsed.diagnostics).toEqual([])

	let enriched = enrich(parsed.program, { tests: options.tests ?? true })
	let diagnostics = [...enriched.diagnostics]

	if (!containsErrors(diagnostics)) {
		diagnostics.push(...validate(enriched.program))
	}

	return { program: enriched.program, diagnostics }
}

function codesOf(source: string): Array<string> {
	return analyse(source).diagnostics.map((diagnostic) => diagnostic.code)
}

function diagnosticsOf(source: string): Array<common.Diagnostic> {
	return analyse(source).diagnostics
}

function sectionOf(source: string): common.typed.TestsSectionNode {
	let { program, diagnostics } = analyse(source)

	expect(diagnostics.map((diagnostic) => diagnostic.code)).toEqual([])
	expect(program.tests).not.toBeNull()

	return program.tests as common.typed.TestsSectionNode
}

// NOTE: Every test of a section, nested suites included, in source order.
function testsOf(
	nodes: Array<common.typed.TestsNode>,
): Array<common.typed.TestNode> {
	return nodes.flatMap((node) =>
		node.nodeType === "Test"
			? [node]
			: node.nodeType === "Suite"
				? testsOf(node.nodes)
				: [],
	)
}

function suitesOf(
	nodes: Array<common.typed.TestsNode>,
): Array<common.typed.SuiteNode> {
	return nodes.flatMap((node) =>
		node.nodeType === "Suite" ? [node, ...suitesOf(node.nodes)] : [],
	)
}

describe("Tests Section Semantics", () => {
	describe("Scope", () => {
		it("should see what the implementation declares", () => {
			expect(
				codesOf(
					`implementation {
						function double(_ value: Integer) -> Integer {
							<- value::multiply(with 2)
						}
					}

					tests {
						test "doubles" {
							expect double(2)::is(4)
						}
					}`,
				),
			).toEqual([])
		})

		it("should let a tests section shadow an implementation name", () => {
			expect(
				codesOf(
					`implementation {
						constant table = [1]
					}

					tests {
						constant table = [1, 2]

						test "counts" {
							expect table::length()::is(2)
						}
					}`,
				),
			).toEqual([])
		})

		it("should keep what a test declares out of the next test", () => {
			expect(
				codesOf(
					`implementation {}

					tests {
						test "declares" {
							constant local = 1

							expect local::is(1)
						}

						test "can not see it" {
							expect local::is(1)
						}
					}`,
				),
			).toEqual(["unknown-name"])
		})

		it("should keep what a suite declares out of its siblings", () => {
			expect(
				codesOf(
					`implementation {}

					tests {
						suite "one" {
							constant shared = 1

							test "sees it" {
								expect shared::is(1)
							}
						}

						suite "two" {
							test "does not" {
								expect shared::is(1)
							}
						}
					}`,
				),
			).toEqual(["unknown-name"])
		})

		it("should keep a tests section helper out of the implementation", () => {
			expect(
				codesOf(
					`implementation {
						constant unused = helper()
					}

					tests {
						function helper() -> Integer {
							<- 1
						}

						test "uses it" {
							expect helper()::is(1)
						}
					}`,
				),
			).toEqual(["unknown-name"])
		})

		it("should refuse a value returned out of a test body", () => {
			expect(
				codesOf(
					`implementation {}

					tests {
						test "answers" {
							<- 1
						}
					}`,
				),
			).toEqual(["top-level-return"])
		})
	})

	describe("Identity", () => {
		it("should build a path out of the suites around a test", () => {
			let section = sectionOf(
				`implementation {}

				tests {
					suite "Standing" {
						suite "record" {
							test "counts a win" {
								expect true
							}
						}
					}
				}`,
			)

			expect(testsOf(section.nodes)[0]?.identity).toEqual({
				modulePath: null,
				suitePath: ["Standing", "record"],
				name: "counts a win",
			})
		})

		it("should key an identity on the name as written", () => {
			let section = sectionOf(
				`implementation {}

				tests {
					constant scored = 2

					test "{scored} is a win" {
						expect scored::is(2)
					}
				}`,
			)

			expect(testsOf(section.nodes)[0]?.identity.name).toBe(
				"{scored} is a win",
			)
		})

		it("should spell an identity as one escaped key", () => {
			expect(
				testIdentityKey({
					modulePath: null,
					suitePath: ["a/b"],
					name: "c",
				}),
			).toBe("/a\\/b/c")
		})

		it("should refuse two tests of one scope with one name", () => {
			expect(
				codesOf(
					`implementation {}

					tests {
						test "ranks the table" { expect true }
						test "ranks the table" { expect true }
					}`,
				),
			).toEqual(["duplicate-test-name"])
		})

		it("should refuse two suites of one scope with one name", () => {
			expect(
				codesOf(
					`implementation {}

					tests {
						suite "Standing" {}
						suite "Standing" {}
					}`,
				),
			).toEqual(["duplicate-test-name"])
		})

		it("should allow one name in two different suites", () => {
			expect(
				codesOf(
					`implementation {}

					tests {
						suite "one" {
							test "works" { expect true }
						}

						suite "two" {
							test "works" { expect true }
						}
					}`,
				),
			).toEqual([])
		})

		it("should allow a test and a suite of one name", () => {
			expect(
				codesOf(
					`implementation {}

					tests {
						test "Standing" { expect true }
						suite "Standing" {}
					}`,
				),
			).toEqual([])
		})
	})

	describe("Modifiers", () => {
		it("should read focused, skipped and tagged", () => {
			let section = sectionOf(
				`implementation {}

				tests {
					test "focused" focused { expect true }
					test "skipped" skipped "waiting" { expect true }
					test "tagged" tagged slow, network { expect true }
				}`,
			)
			let tests = testsOf(section.nodes)

			expect(tests[0]?.focused).not.toBeNull()
			expect(tests[0]?.skipped).toBeNull()
			expect(tests[1]?.skipped?.reason).toBe("waiting")
			expect(tests[2]?.tags).toEqual(["slow", "network"])
		})

		it("should give a test its enclosing suites' tags", () => {
			let section = sectionOf(
				`implementation {}

				tests {
					suite "outer" tagged slow {
						suite "inner" tagged network {
							test "one" tagged flaky { expect true }
						}
					}
				}`,
			)

			expect(testsOf(section.nodes)[0]?.tags).toEqual([
				"slow",
				"network",
				"flaky",
			])
		})

		it("should not repeat a tag a suite and its test both carry", () => {
			let section = sectionOf(
				`implementation {}

				tests {
					suite "outer" tagged slow {
						test "one" tagged slow { expect true }
					}
				}`,
			)

			expect(testsOf(section.nodes)[0]?.tags).toEqual(["slow"])
		})

		it("should skip every test of a skipped suite", () => {
			let section = sectionOf(
				`implementation {}

				tests {
					suite "outer" skipped "the redesign" {
						test "one" { expect true }
					}
				}`,
			)

			expect(suitesOf(section.nodes)[0]?.skipped?.reason).toBe(
				"the redesign",
			)
			expect(testsOf(section.nodes)[0]?.skipped?.reason).toBe(
				"the redesign",
			)
		})

		it("should focus every test of a focused suite", () => {
			let section = sectionOf(
				`implementation {}

				tests {
					suite "outer" focused {
						test "one" { expect true }
					}
				}`,
			)

			expect(testsOf(section.nodes)[0]?.focused).not.toBeNull()
		})

		it("should refuse a skip with no reason", () => {
			expect(
				codesOf(
					`implementation {}

					tests {
						test "one" skipped { expect true }
					}`,
				),
			).toEqual(["skipped-without-reason"])
		})

		it("should refuse a skip whose reason is no String", () => {
			expect(
				codesOf(
					`implementation {}

					tests {
						test "one" skipped 3 { expect true }
					}`,
				),
			).toEqual(["malformed-modifier"])
		})

		it("should refuse arguments on focused", () => {
			expect(
				codesOf(
					`implementation {}

					tests {
						test "one" focused "why" { expect true }
					}`,
				),
			).toEqual(["malformed-modifier"])
		})

		it("should refuse a tagged that names nothing", () => {
			expect(
				codesOf(
					`implementation {}

					tests {
						test "one" tagged { expect true }
					}`,
				),
			).toEqual(["malformed-modifier"])
		})

		it("should refuse a tag that is no bare name", () => {
			expect(
				codesOf(
					`implementation {}

					tests {
						test "one" tagged "slow" { expect true }
					}`,
				),
			).toEqual(["malformed-modifier"])
		})

		it("should refuse a tag that is not lower case", () => {
			expect(
				codesOf(
					`implementation {}

					tests {
						test "one" tagged Slow { expect true }
					}`,
				),
			).toEqual(["malformed-modifier"])
		})

		it("should refuse a Modifier written twice", () => {
			expect(
				codesOf(
					`implementation {}

					tests {
						test "one" focused focused { expect true }
					}`,
				),
			).toEqual(["duplicate-modifier"])
		})

		// NOTE: The Parser reads `tagged slow focused` as three Modifiers —
		// see `regrouped`. The vocabulary is what puts it back together, and
		// the test is here because getting it wrong is silent: a swallowed
		// `focused` is a test nobody notices has stopped running.
		it("should adopt a bare name a tagged was written without", () => {
			let section = sectionOf(
				`implementation {}

				tests {
					test "one" tagged slow focused { expect true }
				}`,
			)
			let one = testsOf(section.nodes)[0]

			expect(one?.tags).toEqual(["slow"])
			expect(one?.focused).not.toBeNull()
		})

		it("should not adopt a name that misspells a Modifier", () => {
			expect(
				codesOf(
					`implementation {}

					tests {
						test "one" tagged slow focussed { expect true }
					}`,
				),
			).toEqual(["unknown-modifier"])
		})

		// NOTE: A tag is any bare name, and plenty of ordinary ones sit within a
		// typo's distance of a Modifier. Only a name that IS one is read as a
		// Modifier written in the wrong place.
		it("should take a tag that merely looks like a Modifier", () => {
			let section = sectionOf(
				`implementation {}

				tests {
					test "one" tagged focus { expect true }
				}`,
			)

			expect(testsOf(section.nodes)[0]?.tags).toEqual(["focus"])
		})

		it("should refuse a Modifier nobody declared", () => {
			expect(
				codesOf(
					`implementation {}

					tests {
						test "one" slowly { expect true }
					}`,
				),
			).toEqual(["unknown-modifier"])
		})

		it("should suggest the Modifier a misspelling meant", () => {
			expect(
				diagnosticsOf(
					`implementation {}

					tests {
						test "one" focussed { expect true }
					}`,
				)[0]?.data,
			).toEqual({ kind: "suggestion", suggestion: "focused" })
		})

		it("should refuse a focused skip", () => {
			expect(
				codesOf(
					`implementation {}

					tests {
						test "one" focused skipped "why" { expect true }
					}`,
				),
			).toEqual(["contradictory-modifiers"])
		})

		it("should read the same vocabulary on a suite", () => {
			expect(
				codesOf(
					`implementation {}

					tests {
						suite "one" skipped {}
					}`,
				),
			).toEqual(["skipped-without-reason"])
		})
	})

	describe("expect and require", () => {
		it("should demand a Boolean", () => {
			expect(
				codesOf(
					`implementation {}

					tests {
						test "one" {
							expect 1
						}
					}`,
				),
			).toEqual(["expect-not-boolean"])
		})

		it("should demand a Boolean of a require as well", () => {
			expect(
				codesOf(
					`implementation {}

					tests {
						test "one" {
							require "no"
						}
					}`,
				),
			).toEqual(["expect-not-boolean"])
		})

		it("should demand nothing of the form that takes a value apart", () => {
			expect(
				codesOf(
					`implementation {
						constant rows = [1, 2]
					}

					tests {
						test "one" {
							require #Value(first) = rows::firstItem()
						}
					}`,
				),
			).toEqual([])
		})

		it("should assert inside the blocks nested in a test", () => {
			expect(
				codesOf(
					`implementation {}

					tests {
						test "one" {
							if true {
								expect 1
							}
						}
					}`,
				),
			).toEqual(["expect-not-boolean"])
		})

		it("should let a require's bindings flow into the rest of the block", () => {
			expect(
				codesOf(
					`implementation {
						constant rows = [1, 2]
					}

					tests {
						test "one" {
							require #Value(first) = rows::firstItem()

							expect first::is(1)
						}
					}`,
				),
			).toEqual([])
		})

		// NOTE: What a `require` binds is typed AT the Matcher, not at what the
		// value was declared as: below the assertion the value IS the Case the
		// Matcher named, which is the whole reason a test writes one.
		it("should type what it binds at the Matcher", () => {
			let section = sectionOf(
				`implementation {
					constant rows = [1, 2]
				}

				tests {
					test "one" {
						require #Value(first) = rows::firstItem()
					}
				}`,
			)
			let body = testsOf(section.nodes)[0]?.body ?? []

			expect(body.map((node) => node.nodeType)).toEqual([
				"ConstantDeclarationStatement",
				"RequireStatement",
				"ConstantDeclarationStatement",
			])

			let binding =
				body[2] as common.typed.ConstantDeclarationStatementNode

			expect(binding.synthesized).toBe("binding")
			expect(binding.name.content).toBe("first")
			expect(binding.type).toEqual({ type: "Integer" })
		})

		// NOTE: A Matcher that names nothing is still a question about the
		// value — and the only question a bare Case asks.
		it("should take a value apart with a Matcher that binds nothing", () => {
			expect(
				codesOf(
					`implementation {
						constant rows = [1, 2]
					}

					tests {
						test "one" {
							require #Empty = rows::item(at 9)
						}
					}`,
				),
			).toEqual([])
		})

		it("should read a Matcher the way a Handler reads one", () => {
			expect(
				codesOf(
					`implementation {
						constant rows = [1, 2]
					}

					tests {
						test "one" {
							require #Nope(first) = rows::firstItem()
						}
					}`,
				),
			).toEqual(["unknown-case"])
		})

		it("should take a Record apart with a Pattern", () => {
			expect(
				codesOf(
					`implementation {
						constant standing = { team = "Lions", points = 3 }
					}

					tests {
						test "one" {
							require { team, points } = standing

							expect team::is("Lions")
							expect points::is(3)
						}
					}`,
				),
			).toEqual([])
		})

		// NOTE: The members a Pattern may hold, all three of them: one bound
		// under its own name, one bound at a Type, and one constrained by a
		// written value, which binds nothing and is a question about the value
		// instead.
		it("should read every kind of Pattern member", () => {
			expect(
				codesOf(
					`implementation {
						constant standing = { team = "Lions", points = 3 }
					}

					tests {
						test "one" {
							require { team, points: Integer } = standing
							require { points = 3 } = standing

							expect team::is("Lions")
							expect points::is(3)
						}
					}`,
				),
			).toEqual([])
		})

		it("should name the whole of what it takes apart", () => {
			expect(
				codesOf(
					`implementation {
						constant standing = { team = "Lions", points = 3 }
					}

					tests {
						test "one" {
							require { team, points } as whole = standing

							expect team::is("Lions")
							expect whole.points::is(3)
						}
					}`,
				),
			).toEqual([])
		})

		it("should hold what it asserted under one name", () => {
			let section = sectionOf(
				`implementation {
					function rows() -> List<Integer> {
						<- [1]
					}
				}

				tests {
					test "one" {
						require List<Integer> = rows()
					}
				}`,
			)
			let body = testsOf(section.nodes)[0]?.body ?? []

			expect(body[0]?.nodeType).toBe("ConstantDeclarationStatement")
			expect(body[1]?.nodeType).toBe("RequireStatement")

			let assertion = body[1] as common.typed.RequireStatementNode

			expect(assertion.value.nodeType).toBe("Identifier")
			expect(assertion.matcher).not.toBeNull()
		})

		it("should read a Boolean assertion as itself", () => {
			let section = sectionOf(
				`implementation {}

				tests {
					test "one" {
						expect true
					}
				}`,
			)
			let body = testsOf(section.nodes)[0]?.body ?? []

			expect(body.length).toBe(1)
			expect(body[0]?.nodeType).toBe("ExpectStatement")
			expect(
				(body[0] as common.typed.ExpectStatementNode).matcher,
			).toBeNull()
		})
	})

	describe("Table tests", () => {
		let source = `implementation {
			choice Outcome {
				Win,
				Draw,
				Loss,
			}
		}

		tests {
			type Scoreline = { scored: Integer, conceded: Integer, expected: Outcome }

			test "{scored}–{conceded}" across [
				{ scored = 2, conceded = 1, expected = #Win },
				{ scored = 1, conceded = 1, expected = #Draw },
			] ({ scored, conceded, expected }: Scoreline) {
				expect scored::isGreaterThanOrEqualTo(conceded)
			}
		}`

		it("should read one row per written item", () => {
			let table = testsOf(sectionOf(source).nodes)[0]
				?.table as common.typed.TestTableNode

			expect(table.rows).toHaveLength(2)
			expect(table.type.type).toBe("Record")
		})

		// NOTE: The whole reason a Parameter is annotated at all — the rows are
		// read against what it declared, so a bare Case resolves the way it
		// does under any other annotation.
		it("should resolve a bare Case in a row against the annotation", () => {
			let table = testsOf(sectionOf(source).nodes)[0]
				?.table as common.typed.TestTableNode
			let row = table.rows[0] as common.typed.RecordValueNode

			expect(row.members["expected"]?.type).toEqual({
				type: "Case",
				choice: "Outcome",
				name: "Win",
				members: {},
				unitChoice: true,
			})
		})

		it("should bind a Pattern Parameter off the row", () => {
			let table = testsOf(sectionOf(source).nodes)[0]
				?.table as common.typed.TestTableNode

			expect(
				table.bindings.map((binding) =>
					binding.nodeType === "ConstantDeclarationStatement"
						? binding.name.content
						: binding.nodeType,
				),
			).toEqual(["scored", "conceded", "expected"])
		})

		it("should number a row's identity", () => {
			let section = simplifiedSectionOf(source)

			expect(section.tests.map((entry) => [entry.id, entry.row])).toEqual(
				[
					["/{scored}–{conceded}/0", 0],
					["/{scored}–{conceded}/1", 1],
				],
			)
		})

		it("should keep the template on every row", () => {
			let section = simplifiedSectionOf(source)

			expect(
				section.tests.map((entry) => [entry.name, entry.interpolated]),
			).toEqual([
				["{scored}–{conceded}", true],
				["{scored}–{conceded}", true],
			])
		})

		it("should emit one node for the whole table", () => {
			let section = simplifiedSectionOf(source)
			let rows = section.nodes.find(
				(node) => node.nodeType === "TestRows",
			) as common.typedSimple.TestRowsNode

			expect(rows.first).toBe(0)
			expect(rows.rows).toHaveLength(2)
			expect(rows.bindings).toHaveLength(3)
			expect(rows.name).not.toBeNull()
		})

		it("should let a named Parameter bind the row itself", () => {
			let table = testsOf(
				sectionOf(
					`implementation {}

					tests {
						test "rows" across [1, 2] (n: Integer) {
							expect n::isGreaterThan(0)
						}
					}`,
				).nodes,
			)[0]?.table as common.typed.TestTableNode

			expect(table.binding).toBe("n")
			expect(table.bindings).toEqual([])
			expect(table.type).toEqual({ type: "Integer" })
		})

		// NOTE: A row is a value like any other, so a `require` takes it apart
		// where it stands — and what it binds is read by the rest of that row's
		// own run of the body.
		it("should take a row apart with a Matcher", () => {
			expect(
				codesOf(
					`implementation {}

					tests {
						test "rows" across [
							[1],
							[2],
						] (row: List<Integer>) {
							require #Value(first) = row::firstItem()

							expect first::isGreaterThan(0)
						}
					}`,
				),
			).toEqual([])
		})

		it("should infer the row Type where nothing was annotated", () => {
			let table = testsOf(
				sectionOf(
					`implementation {}

					tests {
						test "rows" across [1, 2] (n) {
							expect n::isGreaterThan(0)
						}
					}`,
				).nodes,
			)[0]?.table as common.typed.TestTableNode

			expect(table.type).toEqual({ type: "Integer" })
		})

		it("should refuse rows that are not written here", () => {
			expect(
				codesOf(
					`implementation {
						constant scorelines: List<Integer> = [1, 2]
					}

					tests {
						test "rows" across scorelines (n: Integer) {
							expect n::isGreaterThan(0)
						}
					}`,
				),
			).toEqual(["table-not-written"])
		})

		it("should refuse a row taken by several Parameters", () => {
			expect(
				codesOf(
					`implementation {}

					tests {
						test "rows" across [1] (a: Integer, b: Integer) {
							expect a::isGreaterThan(b)
						}
					}`,
				),
			).toEqual(["table-parameters"])
		})

		// NOTE: The rows and the Constants a Pattern Parameter binds off them are
		// Statements of the test like any other, and the Validator has to walk
		// them: a non-exhaustive `match` in a row would otherwise compile in
		// silence while the identical one a line below is refused.
		it("should hold a row to what the Validator asks of every Expression", () => {
			expect(
				codesOf(
					`implementation {
						choice Colour {
							Red,
							Blue,
						}
					}

					tests {
						constant colour: Colour = #Red

						test "reads {n}" across [
							match colour -> Integer {
								case #Red { <- 1 }
							},
						] (n: Integer) {
							expect n::isGreaterThan(0)
						}
					}`,
				),
			).toEqual(["missing-case"])
		})

		// NOTE: Every row runs the same body, so an inline snapshot written in
		// one would hold a value per row and one slot to write them into.
		it("should refuse an inline snapshot in a table test", () => {
			expect(
				codesOf(
					`implementation {}

					tests {
						test "reads {n}" across [1, 2] (n: Integer) {
							expect n::toString() matches snapshot
						}
					}`,
				),
			).toEqual(["inline-snapshot-in-table"])
		})

		it("should take a named snapshot in a table test", () => {
			expect(
				codesOf(
					`implementation {}

					tests {
						test "reads {n}" across [1, 2] (n: Integer) {
							expect n::toString() matches snapshot from "read"
						}
					}`,
				),
			).toEqual([])
		})

		it("should refuse a table that names no row", () => {
			expect(
				codesOf(
					`implementation {}

					tests {
						test "rows" across [1] () {
							expect true
						}
					}`,
				),
			).toEqual(["table-parameters"])
		})
	})

	describe("Snapshots", () => {
		let source = `implementation {
			function greeting(_ name: String) -> String {
				<- "Hello, {name}"
			}
		}

		tests {
			test "renders" {
				expect greeting("Lions") matches snapshot
				expect greeting("Tigers") matches snapshot "Hello, Tigers"
				expect greeting("Bears") matches snapshot from "bears"
			}
		}`

		function snapshotsOf(): Array<common.typed.SnapshotNode> {
			let body = testsOf(sectionOf(source).nodes)[0]?.body ?? []

			return body.map(
				(node) =>
					(node as common.typed.ExpectStatementNode)
						.snapshot as common.typed.SnapshotNode,
			)
		}

		it("reads the three shapes apart", () => {
			expect(
				snapshotsOf().map((snapshot) => [
					snapshot.name,
					snapshot.recorded,
				]),
			).toEqual([
				[null, null],
				[null, "Hello, Tigers"],
				["bears", null],
			])
		})

		// NOTE: What a snapshot records is the value RENDERED, which is
		// `Printable::toString` — built as the interpolation an author could
		// have written, so the witness and the lowering are the ones the
		// language already has.
		it("records the value through Printable", () => {
			let body = testsOf(sectionOf(source).nodes)[0]?.body ?? []
			let asserted = (body[0] as common.typed.ExpectStatementNode).value

			expect(asserted.nodeType).toBe("InterpolatedStringValue")
			expect(asserted.type).toEqual({ type: "String" })
		})

		it("asks nothing about Booleans", () => {
			expect(codesOf(source)).toEqual([])
		})

		it("refuses a value with nothing to render", () => {
			expect(
				codesOf(
					`implementation {
						choice Colour {
							Red,
							Blue,
						}
					}

					tests {
						test "renders" {
							expect Colour#Red matches snapshot
						}
					}`,
				),
			).toEqual(["snapshot-not-printable"])
		})
	})

	describe("The compile mode", () => {
		let source = `implementation {
			constant shipped = 1
		}

		tests {
			test "one" {
				expect shipped::is(1)
			}
		}`

		it("should enrich the section only where a compile asked for it", () => {
			expect(analyse(source).program.tests).not.toBeNull()
			expect(analyse(source, { tests: false }).program.tests).toBeNull()
		})

		it("should not report about a section it did not ask for", () => {
			let broken = `implementation {}

				tests {
					test "one" nonsense {
						expect nothing
					}
				}`

			expect(codesOf(broken)).toEqual([
				"unknown-modifier",
				"unknown-name",
			])
			expect(analyse(broken, { tests: false }).diagnostics).toEqual([])
		})

		it("should leave nothing of the section in the implementation", () => {
			let simplified = simplify(analyse(source).program)

			// NOTE: The section is carried BESIDE the implementation rather
			// than folded into it — a build's implementation is byte for byte
			// what it would have been with no `tests` block written at all,
			// which is what the golden below proves the whole way down.
			expect(simplified.implementation.nodes.length).toBe(1)
			expect(simplified.tests).not.toBeNull()
			expect(
				simplify(analyse(source, { tests: false }).program).tests,
			).toBeNull()
		})

		// NOTE: The claim "a test costs a shipped Program nothing", stated as
		// the only thing that could prove it: the JavaScript a build writes for
		// the fixture is byte for byte the JavaScript it writes for the same
		// file with the whole block deleted.
		it("should build the fixture into what the same file without tests builds into", () => {
			let text = readFileSync(fixturePath("Tests.es"), "utf8")

			expect(build(text)).toBe(build(withoutTestsSection(text)))
		})
	})
})

function build(source: string): string {
	let parsed = parseWithDiagnostics(source)

	expect(parsed.diagnostics).toEqual([])

	let enriched = enrich(parsed.program)

	expect(enriched.diagnostics).toEqual([])
	expect(enriched.program.tests).toBeNull()
	expect(validate(enriched.program)).toEqual([])

	return rewrite(optimise(simplify(enriched.program)))
}

// NOTE: The section as the lowering leaves it — the manifest and the Nodes a
// runner is registered with, which is where a table test's rows become tests.
function simplifiedSectionOf(
	source: string,
): common.typedSimple.TestsSectionNode {
	let { program, diagnostics } = analyse(source)

	expect(diagnostics.map((diagnostic) => diagnostic.code)).toEqual([])

	let simplified = simplify(program, { source })

	expect(simplified.tests).not.toBeNull()

	return simplified.tests as common.typedSimple.TestsSectionNode
}

// NOTE: The block cut out by its own Position, lines and all, rather than by
// searching the text for it — the Parser is what knows where the block ends.
function withoutTestsSection(source: string): string {
	let { program } = parseWithDiagnostics(source)
	let section = program.tests

	expect(section).not.toBeNull()

	let lines = source.split("\n")

	lines.splice(
		section!.position.start.line - 1,
		section!.position.end.line - section!.position.start.line + 1,
	)

	return lines.join("\n")
}
