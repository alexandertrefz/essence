import { describe, expect, it } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import type { common } from "@essence-lang/interfaces"
import type { entryPoints, TestEvent } from "@essence-lang/runtime/Testing"
import { registry, registryOf } from "@essence-lang/runtime/Testing"

import { containsErrors } from "../diagnostics/index"
import { enrich } from "../enricher/index"
import { optimise } from "../optimiser/index"
import { parseWithDiagnostics } from "../parser/index"
import { rewrite } from "../rewriter/index"
import { simplify } from "../simplifier/index"
import { validate } from "../validator/index"

// NOTE: `essence test --contracts` end to end — what the Enricher synthesizes
// out of a Namespace's own declarations, what it refuses to synthesize, and
// what a run of the goals reports. The property machinery underneath is
// `testingProperties.spec.ts`; what a DECLARATION says to test is here.

function analyse(
	source: string,
	options: { contracts?: boolean } = {},
): {
	program: common.typed.Program
	diagnostics: Array<common.Diagnostic>
} {
	let parsed = parseWithDiagnostics(source)

	expect(parsed.diagnostics).toEqual([])

	let enriched = enrich(parsed.program, {
		tests: true,
		contracts: options.contracts ?? true,
		source,
	})
	let diagnostics = [...enriched.diagnostics]

	if (!containsErrors(diagnostics)) {
		diagnostics.push(...validate(enriched.program))
	}

	return { program: enriched.program, diagnostics }
}

// NOTE: A Module with one Namespace in it and a written test beside it, so
// every case below is the declarations and nothing else. The written test is
// there on purpose: a contract run runs what a project WROTE as well, and the
// goals are appended after it.
function moduleOf(declarations: string): string {
	return `implementation {
${declarations}
}

tests {
	test "written" {
		expect true
	}
}`
}

function suiteOf(
	program: common.typed.Program,
): common.typed.SuiteNode | undefined {
	return (program.tests?.nodes ?? []).find(
		(node): node is common.typed.SuiteNode =>
			node.nodeType === "Suite" && node.identity.name === "contracts",
	)
}

function goalsOf(source: string): Array<common.typed.TestNode> {
	let { program, diagnostics } = analyse(source)

	expect(
		diagnostics
			.filter((diagnostic) => diagnostic.severity === "error")
			.map((diagnostic) => diagnostic.message),
	).toEqual([])

	return (suiteOf(program)?.nodes ?? []).filter(
		(node): node is common.typed.TestNode => node.nodeType === "Test",
	)
}

function namesOf(source: string): Array<string> {
	return goalsOf(source).map((goal) => goal.identity.name)
}

function codesOf(source: string): Array<string> {
	return analyse(source).diagnostics.map((diagnostic) => diagnostic.code)
}

function generate(source: string): string {
	let parsed = parseWithDiagnostics(source)

	expect(containsErrors(parsed.diagnostics)).toBe(false)

	let enriched = enrich(parsed.program, {
		tests: true,
		contracts: true,
		source,
	})

	expect(containsErrors(enriched.diagnostics)).toBe(false)
	expect(containsErrors(validate(enriched.program))).toBe(false)

	return rewrite(optimise(simplify(enriched.program, { source })))
}

type Loaded = { $tests: typeof entryPoints }

// NOTE: The whole pipeline and then the run, driven through the loaded
// program's OWN `$tests` — see `testingProperties.spec.ts`, which says why.
async function run(
	source: string,
	options: { cases?: number } = {},
): Promise<Array<TestEvent>> {
	let javaScript = generate(source)
	let directory = mkdtempSync(join(tmpdir(), "essence-contracts-"))
	let file = join(directory, "program.ts")

	writeFileSync(file, javaScript)

	let before = registry().modules.length
	let loaded = (await import(file)) as Loaded
	let scoped = registryOf(loaded.$tests.registry().modules.slice(before))
	let events: Array<TestEvent> = []

	try {
		loaded.$tests.run(scoped, {
			sink: (event) => events.push(event),
			now: () => 0,
			seed: "deadbeef",
			cases: options.cases ?? 5,
		})

		return events
	} finally {
		rmSync(directory, { recursive: true, force: true })
	}
}

function passedNames(events: Array<TestEvent>): Array<string> {
	return events
		.filter((event) => event.kind === "test-pass")
		.map((event) => event.name)
}

function failed(
	events: Array<TestEvent>,
): Array<Extract<TestEvent, { kind: "test-fail" }>> {
	return events.filter((event) => event.kind === "test-fail")
}

describe("Contract tests", () => {
	describe("What a declaration says to test", () => {
		it("synthesizes nothing where the run did not ask", () => {
			let { program } = analyse(
				moduleOf(`	type Positive = Integer where @::isGreaterThan(0)

	namespace Counting for Integer {
		up() -> Positive {
			<- @::absolute()::add(1)
		}
	}`),
				{ contracts: false },
			)

			expect(suiteOf(program)).toBeUndefined()
		})

		it("makes one goal per Method, named as the Method is spelled", () => {
			expect(
				namesOf(
					moduleOf(`	namespace Counting for Integer {
		up() -> Integer {
			<- @::add(1)
		}

		by(step other: Integer) -> Integer {
			<- @::add(other)
		}

		static origin() -> Integer {
			<- 0
		}
	}`),
				),
			).toEqual([
				"Counting::up()",
				"Counting::by(step:)",
				"Counting.origin()",
			])
		})

		it("numbers the entries of an overload", () => {
			expect(
				namesOf(
					moduleOf(`	namespace Counting for Integer {
		overload up {
			() -> Integer {
				<- @::add(1)
			}

			(by other: Integer) -> Integer {
				<- @::add(other)
			}
		}
	}`),
				),
			).toEqual([
				"Counting::up() overload 1",
				"Counting::up(by:) overload 2",
			])
		})

		it("generates the receiver and every Parameter", () => {
			let [goal] = goalsOf(
				moduleOf(`	namespace Counting for Integer {
		between(_ low: Integer, and high: String) -> Integer {
			<- @::add(low)::add(high::length())
		}
	}`),
			)

			expect(
				goal?.properties?.parameters.map((parameter) => ({
					name: parameter.name,
					kind: parameter.generator.kind,
				})),
			).toEqual([
				{ name: "receiver", kind: "integer" },
				{ name: "argument2", kind: "integer" },
				{ name: "and", kind: "string" },
			])
		})

		it("leaves a static without a receiver", () => {
			let [goal] = goalsOf(
				moduleOf(`	namespace Counting for Integer {
		static of(_ digits: String) -> Integer {
			<- digits::length()
		}
	}`),
			)

			expect(
				goal?.properties?.parameters.map((parameter) => parameter.name),
			).toEqual(["argument1"])
		})

		it("runs a Method that takes nothing exactly once", () => {
			let [goal] = goalsOf(
				moduleOf(`	namespace Counting for Integer {
		static origin() -> Integer {
			<- 0
		}
	}`),
			)

			expect(goal?.properties).toBeNull()
			expect(goal?.table).toBeNull()
		})
	})

	describe("What the goal's body asserts", () => {
		it("expects one conjunct of the return Type at a time", () => {
			let [goal] = goalsOf(
				moduleOf(`	type Small = Integer where @::isGreaterThan(0)::and(@::isLessThan(100))

	namespace Counting for Integer {
		small() -> Small {
			<- 1
		}
	}`),
			)

			expect(goal?.body.map((node) => node.nodeType)).toEqual([
				"ConstantDeclarationStatement",
				"ExpectStatement",
				"ExpectStatement",
			])
		})

		// NOTE: What the expects ASK, spelled out — the answer is bound, and
		// each conjunct is the predicate a reader could have written about it.
		// A goal that bound the answer and asked nothing of it would pass every
		// run without saying so.
		it("asks each conjunct of the bound answer", () => {
			let [goal] = goalsOf(
				moduleOf(`	type Small = Integer where @::isGreaterThan(0)::and(@::isLessThan(100))

	namespace Counting for Integer {
		small() -> Small {
			<- 1
		}
	}`),
			)

			expect(
				goal?.body
					.filter((node) => node.nodeType === "ExpectStatement")
					.map((node) =>
						node.value.nodeType === "MethodInvocation"
							? {
									member: node.value.member.name,
									base:
										node.value.base.nodeType ===
										"Identifier"
											? node.value.base.content
											: node.value.base.nodeType,
								}
							: node.value.nodeType,
					),
			).toEqual([
				{ member: "isGreaterThan", base: "$answer" },
				{ member: "isLessThan", base: "$answer" },
			])
		})

		// NOTE: Totality over the declared domain is the contract every Method
		// makes, refinement or none — so a Method whose answer refines nothing
		// still has a goal, and the call still has to survive it.
		it("still calls a Method whose answer promises nothing", () => {
			let [goal] = goalsOf(
				moduleOf(`	namespace Counting for Integer {
		up() -> Integer {
			<- @::add(1)
		}
	}`),
			)

			expect(goal?.body.map((node) => node.nodeType)).toEqual([
				"MethodInvocation",
			])
		})
	})

	describe("What a goal carries", () => {
		// NOTE: The ratified budget: a Namespace is dozens of goals, and a
		// hundred cases each is a run nobody asked to wait for.
		it("budgets a generated goal at twenty-five cases", () => {
			let [goal] = goalsOf(
				moduleOf(`	namespace Counting for Integer {
		up() -> Integer {
			<- @::add(1)
		}
	}`),
			)

			expect(goal?.cases).toBe(25)
			expect(goal?.properties).not.toBeNull()
		})
	})

	describe("What it refuses to synthesize", () => {
		it("says once per Namespace what got no goal", () => {
			expect(
				codesOf(
					moduleOf(`	namespace Counting for Integer {
		reading(with read: (_ text: String) -> Integer) -> Integer {
			<- read("x")
		}

		other(with read: (_ text: String) -> Integer) -> Integer {
			<- read("y")
		}
	}`),
				),
			).toEqual(["ungeneratable-contract"])
		})

		it("reports a skipped goal as a remark rather than a mistake", () => {
			let [diagnostic] = analyse(
				moduleOf(`	namespace Counting for Integer {
		reading(with read: (_ text: String) -> Integer) -> Integer {
			<- read("x")
		}
	}`),
			).diagnostics

			expect(diagnostic?.severity).toBe("information")
			expect(diagnostic?.message).toContain("Counting")
			expect(diagnostic?.notes.join(" ")).toContain(
				"Counting::reading(with:)",
			)
		})

		// NOTE: The speculative synthesis reports what it can not build and
		// what does not typecheck, about code nobody wrote. Every one of those
		// is answered once, about the Namespace, and none of them leaks.
		it("leaves no stray Diagnostic behind a skipped goal", () => {
			let messages = analyse(
				moduleOf(`	namespace Counting for Integer {
		reading(with read: (_ text: String) -> Integer) -> Integer {
			<- read("x")
		}
	}`),
			).diagnostics.map((diagnostic) => diagnostic.code)

			expect(messages).toEqual(["ungeneratable-contract"])
		})

		// NOTE: Without a remark, deliberately: the rule is documented, and the
		// only help a remark could offer — a Generatable conformance — could
		// never make a generic Method eligible.
		it("leaves a generic Method alone, and says nothing about it", () => {
			expect(
				namesOf(
					moduleOf(`	namespace Counting for Integer {
		up() -> Integer {
			<- @::add(1)
		}
	}`),
				),
			).toEqual(["Counting::up()"])

			expect(
				codesOf(
					moduleOf(`	namespace Boxing for Integer {
		wrapped<Item>(_ item: Item) -> Integer {
			<- @
		}
	}`),
				),
			).toEqual([])
		})

		// NOTE: The Scope answers with the MERGED Namespace, so without the
		// own-members filter a second declaration of one name would goal an
		// inherited Method once per statement — one spelled name, twice in one
		// manifest, colliding in everything the identity anchors.
		// NOTE: A second same-file declaration of one Namespace is its own
		// compile error, but the enrichment carries on — and the Scope answers
		// BOTH statements with the SURVIVING Namespace, so without the
		// own-members filter its Methods would goal once per statement: one
		// spelled name, twice in one manifest, colliding in everything the
		// identity anchors. The same filter is what keeps a Module that
		// EXTENDS an imported Namespace — the legal, cross-Module spelling of
		// this shape — from re-goaling the base Module's Methods under names
		// the base already answers for.
		it("goals each statement's own members, never the merged table", () => {
			let { program, diagnostics } = analyse(
				moduleOf(`	namespace Counting for Integer {
		up() -> Integer {
			<- @::add(1)
		}
	}

	namespace Counting for Integer {
		down() -> Integer {
			<- @::subtract(1)
		}
	}`),
			)

			expect(
				diagnostics.map((diagnostic) => diagnostic.message),
			).toContain("Variable 'Counting' is already declared")
			expect(
				(suiteOf(program)?.nodes ?? []).map(
					(node) => (node as common.typed.TestNode).identity.name,
				),
			).toEqual(["Counting::down()"])
		})

		it("refuses a written suite under the synthesized name", () => {
			let { diagnostics } = analyse(
				`implementation {
	namespace Counting for Integer {
		up() -> Integer {
			<- @::add(1)
		}
	}
}

tests {
	suite "contracts" {
		test "mine" {
			expect true
		}
	}
}`,
			)

			expect(diagnostics.map((diagnostic) => diagnostic.code)).toContain(
				"reserved-suite-name",
			)
		})
	})

	describe("What a run of the goals reports", () => {
		it("passes a contract the implementation keeps", async () => {
			let events = await run(
				moduleOf(`	type Positive = Integer where @::isGreaterThan(0)

	namespace Counting for Integer {
		up() -> Positive {
			<- 1
		}
	}`),
			)

			expect(passedNames(events).sort()).toEqual([
				"Counting::up()",
				"written",
			])
			expect(failed(events)).toEqual([])
		})

		// NOTE: A goal reports under the Method's own spelling and under the
		// synthetic suite, which is what makes it findable with `--filter` and
		// what a stored counterexample is keyed by.
		it("reports a goal under the contracts suite", async () => {
			let events = await run(
				moduleOf(`	namespace Counting for Integer {
		up() -> Integer {
			<- @::add(1)
		}
	}`),
			)
			let [start] = events.filter((event) => event.kind === "test-start")

			expect(
				events
					.filter((event) => event.kind === "test-start")
					.map((event) => event.suitePath),
			).toEqual([[], ["contracts"]])
			expect(start?.name).toBe("written")
		})
	})
})
