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

// NOTE: `test "…" for any (…)` end to end — what the Enricher DERIVES from each
// Parameter's Type, what it refuses, what the emission looks like, and what a
// run of a hundred generated cases actually reports. The generator interpreter
// itself is `packages/runtime/src/tests/generators.spec.ts`; what a Type says to
// build is here.

function analyse(source: string): {
	program: common.typed.Program
	diagnostics: Array<common.Diagnostic>
} {
	let parsed = parseWithDiagnostics(source)

	expect(parsed.diagnostics).toEqual([])

	let enriched = enrich(parsed.program, { tests: true, source })
	let diagnostics = [...enriched.diagnostics]

	if (!containsErrors(diagnostics)) {
		diagnostics.push(...validate(enriched.program))
	}

	return { program: enriched.program, diagnostics }
}

function codesOf(source: string): Array<string> {
	return analyse(source).diagnostics.map((diagnostic) => diagnostic.code)
}

// NOTE: A section with one property test in it, wrapped so every case below is
// the `for any (…)` and its body and nothing else.
function sectionOf(parameters: string, body = "expect true"): string {
	return `tests {
		test "a property" for any (${parameters}) {
			${body}
		}
	}`
}

function propertiesOf(source: string): common.typed.TestPropertiesNode {
	let { program, diagnostics } = analyse(source)

	expect(diagnostics.map((diagnostic) => diagnostic.code)).toEqual([])

	let [test] = (program.tests?.nodes ?? []).filter(
		(node) => node.nodeType === "Test",
	)

	expect(test?.nodeType).toBe("Test")
	expect((test as common.typed.TestNode).properties).not.toBeNull()

	return (test as common.typed.TestNode)
		.properties as common.typed.TestPropertiesNode
}

function generatorOf(
	parameters: string,
	declarations = "",
): common.typed.TestGenerator {
	let source = `implementation {
		${declarations}
	}

	${sectionOf(parameters)}`

	return propertiesOf(source).parameters[0]!.generator
}

// NOTE: The generator with its Expressions replaced by a word, because what
// this asks about is the SHAPE — an enriched Expression is a tree nobody wants
// to read in an assertion.
// NOTE: A witness is a whole resolved conformance and reads as a wall of method
// names, so it is shown as the NAMESPACE it resolved to — which is the only
// thing about it these tests are claims about: whose `is` a drawn Dictionary
// compares its keys with.
function shapeOf(generator: common.typed.TestGenerator): unknown {
	return JSON.parse(
		JSON.stringify(generator, (key, value: unknown) => {
			if (key === "call") {
				return "<call>"
			}

			if (key === "checks") {
				return (value as Array<unknown>).length
			}

			if (key === "keyConformance") {
				let source = (value as common.Conformance).source

				return source.kind === "namespace"
					? `<${source.name}>`
					: `<parameter ${source.name}>`
			}

			return value
		}),
	) as unknown
}

function generate(source: string): string {
	let parsed = parseWithDiagnostics(source)

	expect(containsErrors(parsed.diagnostics)).toBe(false)

	let enriched = enrich(parsed.program, { tests: true, source })

	expect(containsErrors(enriched.diagnostics)).toBe(false)
	expect(containsErrors(validate(enriched.program))).toBe(false)

	return rewrite(optimise(simplify(enriched.program, { source })))
}

type Loaded = { $tests: typeof entryPoints }

type Run = { events: Array<TestEvent> }

// NOTE: The whole pipeline and then the run, driven through the loaded
// program's OWN `$tests` — every Essence value carries a hidden Type key that
// belongs to the runtime instance that built it, so anything asked from this
// package's copy would read `undefined` off every generated value.
async function run(
	source: string,
	options: { seed?: string; cases?: number } = {},
): Promise<Run> {
	let javaScript = generate(source)
	let directory = mkdtempSync(join(tmpdir(), "essence-properties-"))
	let file = join(directory, "program.ts")

	writeFileSync(file, javaScript)

	// NOTE: Read immediately before the load: an emitted `.ts` program imports
	// the runtime by absolute path, so every program loaded anywhere in this
	// process registers into ONE array.
	let before = registry().modules.length
	let loaded = (await import(file)) as Loaded
	let scoped = registryOf(loaded.$tests.registry().modules.slice(before))
	let events: Array<TestEvent> = []

	try {
		loaded.$tests.run(scoped, {
			sink: (event) => events.push(event),
			now: () => 0,
			seed: options.seed ?? "deadbeef",
			cases: options.cases,
		})

		return { events }
	} finally {
		rmSync(directory, { recursive: true, force: true })
	}
}

type PropertyEvent = Extract<TestEvent, { kind: "property" }>

function propertyEvents(events: Array<TestEvent>): Array<PropertyEvent> {
	return events.filter(
		(event): event is PropertyEvent => event.kind === "property",
	)
}

function counterexampleOf(events: Array<TestEvent>): Record<string, string> {
	let [property] = propertyEvents(events)
	let values: Record<string, string> = {}

	for (let entry of property?.counterexample ?? []) {
		values[entry.name] = entry.value
	}

	return values
}

describe("Property tests", () => {
	describe("What a Type says to generate", () => {
		it("derives the scalar generators", () => {
			expect(shapeOf(generatorOf("n: Integer"))).toEqual({
				kind: "integer",
			})
			expect(shapeOf(generatorOf("r: Rational"))).toEqual({
				kind: "rational",
			})
			expect(shapeOf(generatorOf("s: String"))).toEqual({
				kind: "string",
			})
			expect(shapeOf(generatorOf("b: Boolean"))).toEqual({
				kind: "boolean",
			})
		})

		it("derives a List from its item Type", () => {
			expect(shapeOf(generatorOf("items: List<String>"))).toEqual({
				kind: "list",
				item: { kind: "string" },
			})
		})

		// NOTE: Both slots, drawn apart — a Dictionary is the first Type with
		// two of them, and what the derivation must not do is read one off the
		// other.
		it("derives a Dictionary from both of its slots", () => {
			expect(
				shapeOf(generatorOf("entries: Dictionary<String, Integer>")),
			).toEqual({
				kind: "dictionary",
				key: { kind: "string" },
				value: { kind: "integer" },
				// NOTE: And the key Type's own Equatable rides along, because a
				// Dictionary's keys are compared by it and the drawn one has to
				// agree with the written one about which two keys are one key.
				keyConformance: "<String>",
			})
		})

		// NOTE: A bare Dictionary decides neither slot, so BOTH take the ladder
		// an unapplied generic's items take — see the List test below, which is
		// the same answer for the one slot a List has.
		it("derives a bare Dictionary as that ladder in both slots", () => {
			let ladder = {
				kind: "union",
				members: [
					{ kind: "integer" },
					{ kind: "string" },
					{
						kind: "record",
						members: [
							{ name: "name", generator: { kind: "string" } },
							{ name: "count", generator: { kind: "integer" } },
						],
					},
				],
			}

			expect(shapeOf(generatorOf("entries: Dictionary"))).toEqual({
				kind: "dictionary",
				key: ladder,
				value: ladder,
			})
		})

		it("derives a Record member by member", () => {
			expect(
				shapeOf(generatorOf("row: { name: String, score: Integer }")),
			).toEqual({
				kind: "record",
				members: [
					{ name: "name", generator: { kind: "string" } },
					{ name: "score", generator: { kind: "integer" } },
				],
			})
		})

		it("derives a Choice as a Union of its Cases", () => {
			expect(
				shapeOf(
					generatorOf(
						"shade: Shade",
						`choice Shade {
							Light,
							Dark { level: Integer },
						}`,
					),
				),
			).toEqual({
				kind: "union",
				members: [
					{ kind: "case", tag: "Shade#Light", members: [] },
					{
						kind: "case",
						tag: "Shade#Dark",
						members: [
							{ name: "level", generator: { kind: "integer" } },
						],
					},
				],
			})
		})

		it("derives an Optional as the Choice it is", () => {
			expect(shapeOf(generatorOf("maybe: Optional<Integer>"))).toEqual({
				kind: "union",
				members: [
					{
						kind: "case",
						tag: "Optional#Value",
						members: [
							{ name: "item", generator: { kind: "integer" } },
						],
					},
					{ kind: "case", tag: "Optional#Empty", members: [] },
				],
			})
		})

		it("derives a written Union arm by arm", () => {
			expect(shapeOf(generatorOf("value: Integer | String"))).toEqual({
				kind: "union",
				members: [{ kind: "integer" }, { kind: "string" }],
			})
		})

		// NOTE: The design's own answer for a Type Parameter: whatever a use
		// site could instantiate it with, which is a scalar, a sequence of
		// characters and a structure.
		it("instantiates an unapplied generic over Integer, String and a Record", () => {
			expect(shapeOf(generatorOf("items: List"))).toEqual({
				kind: "list",
				item: {
					kind: "union",
					members: [
						{ kind: "integer" },
						{ kind: "string" },
						{
							kind: "record",
							members: [
								{
									name: "name",
									generator: { kind: "string" },
								},
								{
									name: "count",
									generator: { kind: "integer" },
								},
							],
						},
					],
				},
			})
		})
	})

	describe("What a refinement adds", () => {
		// NOTE: `NonEmptyList<ItemType> = List<ItemType> where @::hasItems()`.
		it("holds the standard library's NonEmptyList by construction", () => {
			expect(shapeOf(generatorOf("items: NonEmptyList<String>"))).toEqual(
				{
					kind: "refined",
					name: "NonEmptyList",
					base: { kind: "list", item: { kind: "string" } },
					binding: expect.any(String) as unknown as string,
					checks: 0,
					narrowing: { minimumLength: 1 },
				},
			)
		})

		// NOTE: `NonEmptyDictionary<KeyType, ValueType> = Dictionary<KeyType,
		// ValueType> where @::hasEntries()`. A Dictionary is counted in
		// ENTRIES, so the same `minimumLength` rule a List narrows by is what
		// says a drawn one holds something — and the key witness rides along
		// exactly as it does for the unrefined Dictionary above, because what
		// decides two drawn keys are one key is no different for having a
		// proof.
		it("holds the standard library's NonEmptyDictionary by construction", () => {
			expect(
				shapeOf(generatorOf("d: NonEmptyDictionary<String, Integer>")),
			).toEqual({
				kind: "refined",
				name: "NonEmptyDictionary",
				base: {
					kind: "dictionary",
					key: { kind: "string" },
					value: { kind: "integer" },
					keyConformance: "<String>",
				},
				binding: expect.any(String) as unknown as string,
				checks: 0,
				narrowing: { minimumLength: 1 },
			})
		})

		// NOTE: `NonZeroInteger = Integer where @::isNot(0)`.
		it("holds the standard library's NonZeroInteger by construction", () => {
			expect(shapeOf(generatorOf("n: NonZeroInteger"))).toEqual({
				kind: "refined",
				name: "NonZeroInteger",
				base: { kind: "integer" },
				binding: expect.any(String) as unknown as string,
				checks: 0,
				narrowing: { notEqualTo: ["0"] },
			})
		})

		it("narrows a bound a predicate states", () => {
			expect(
				shapeOf(
					generatorOf(
						"n: Positive",
						"type Positive = Integer where @::isGreaterThan(0)",
					),
				),
			).toMatchObject({
				kind: "refined",
				name: "Positive",
				checks: 0,
				narrowing: { atLeast: "1" },
			})
		})

		it("narrows both ends of a conjunction", () => {
			expect(
				shapeOf(
					generatorOf(
						"n: Digit",
						"type Digit = Integer where @::isGreaterThanOrEqualTo(0)::and(@::isLessThanOrEqualTo(9))",
					),
				),
			).toMatchObject({
				checks: 0,
				narrowing: { atLeast: "0", atMost: "9" },
			})
		})

		// NOTE: A predicate no narrowing holds becomes the FILTER: the
		// Enricher enriches it as the Boolean Expression an author could have
		// written about the value.
		it("enriches a predicate it can not narrow as a check", () => {
			expect(
				shapeOf(
					generatorOf(
						"n: EvenInteger",
						"type EvenInteger = Integer where @::isEven()",
					),
				),
			).toMatchObject({
				kind: "refined",
				name: "EvenInteger",
				base: { kind: "integer" },
				checks: 1,
				narrowing: {},
			})
		})

		// NOTE: A refinement flows freely into its base, so a Namespace
		// declared for the BASE is offered for the refinement — and taking it
		// would generate values the refinement says are impossible.
		it("does not let a conformance for the base claim a refinement", () => {
			expect(
				shapeOf(
					generatorOf(
						"n: EvenInteger",
						`type EvenInteger = Integer where @::isEven()

						namespace Counter for Integer is Generatable {
							static generate(from source: Randomness) -> Integer {
								<- 7
							}
						}`,
					),
				),
			).toMatchObject({
				kind: "refined",
				name: "EvenInteger",
				// NOTE: The BASE still generates through the conformance —
				// a Namespace declared for a Type is usually declared because
				// the structural generator is wrong for it, and a refinement of
				// that Type wants the same values. What the fix is about is the
				// predicate: the refinement filters what the conformance drew
				// rather than being replaced by it.
				base: { kind: "generated", name: "Counter" },
				checks: 1,
			})
		})

		// NOTE: A Program may declare `namespace Weird for Integer` and mean
		// something else by a word the narrowing table knows. Reading the name
		// alone would narrow by a promise nobody made — and drop the check that
		// would have caught it. `isLessThan` is one of the words the table
		// knows, and the body below reads a CHAIN, so there is nothing to
		// resolve it to and the leaf stays this Namespace's own question.
		it("narrows only by the base's own Namespace", () => {
			expect(
				shapeOf(
					generatorOf(
						"n: Odd",
						`namespace Weird for Integer {
							isLessThan(_ other: Integer) -> Boolean {
								<- @::absolute()::isGreaterThan(other)
							}
						}

						type Odd = Integer where @::<Weird>isLessThan(0)`,
					),
				),
			).toMatchObject({ kind: "refined", checks: 1, narrowing: {} })
		})

		// NOTE: And a body that forwards the Argument it was handed is read
		// through to the same leaf a written bound reaches. `Weird::isLessThan`
		// is `@::isGreaterThan(other)`, so the refinement below asks for a value
		// above zero and the generator draws one — under the name of the
		// opposite comparison, which decides nothing.
		it("narrows by the leaf a forwarded Argument reaches", () => {
			expect(
				shapeOf(
					generatorOf(
						"n: Odd",
						`namespace Weird for Integer {
							isLessThan(_ other: Integer) -> Boolean {
								<- @::isGreaterThan(other)
							}
						}

						type Odd = Integer where @::<Weird>isLessThan(0)`,
					),
				),
			).toMatchObject({
				kind: "refined",
				checks: 0,
				narrowing: { atLeast: "1" },
			})
		})

		// NOTE: What a Namespace's own body says IS read, which is the other
		// half of the same rule. `Weird::isPositive` is written as one call on
		// `@`, so the predicate it stands for is that call — a value below zero
		// — and the generator holds it by construction rather than by drawing
		// and checking. The name it was given decides nothing either way.
		it("narrows by the leaf a Namespace's own body forwards to", () => {
			expect(
				shapeOf(
					generatorOf(
						"n: Odd",
						`namespace Weird for Integer {
							isPositive() -> Boolean { <- @::isLessThan(0) }
						}

						type Odd = Integer where @::<Weird>isPositive()`,
					),
				),
			).toMatchObject({
				kind: "refined",
				checks: 0,
				narrowing: { atMost: "-1" },
			})
		})

		it("enriches a predicate with a literal Argument as a check", () => {
			expect(
				shapeOf(
					generatorOf(
						"s: Prefixed",
						'type Prefixed = String where @::starts(with "a")',
					),
				),
			).toMatchObject({ kind: "refined", checks: 1 })
		})
	})

	describe("What a Generatable conformance replaces", () => {
		const team = `type Team = { name: String }

			namespace Team for Team is Generatable {
				static generate(from source: Randomness) -> Team {
					<- { name = source::pick(from ["Lions", "Tigers"]) }
				}
			}`

		it("generates through the Namespace rather than structurally", () => {
			expect(shapeOf(generatorOf("team: Team", team))).toEqual({
				kind: "generated",
				name: "Team",
				binding: expect.any(String) as unknown as string,
				call: "<call>",
			})
		})

		it("draws only what the conformance builds", async () => {
			let { events } = await run(`implementation {
				${team}
			}

			tests {
				test "a team is named" for any (team: Team) {
					expect team.name::is("Sharks")
				}
			}`)

			expect(counterexampleOf(events).team).toMatch(/"(Lions|Tigers)"/)
		})
	})

	// NOTE: A drawn value is a value like any other, so a `require` takes it
	// apart where it stands — and a case that misses ends there, which is what
	// makes the property fail on that draw rather than run on with a name that
	// stands for nothing.
	describe("Taking a drawn value apart", () => {
		it("binds what a Matcher named and shrinks on the miss", async () => {
			let { events } = await run(`tests {
				test "every list has a first" for any (items: List<Integer>) {
					require #Value(first) = items::firstItem()

					expect first::isGreaterThan(-1)
				}
			}`)

			expect(counterexampleOf(events).items).toBe("[]")
		})
	})

	describe("What a property test may not say", () => {
		it("refuses a Parameter with no Type", () => {
			expect(codesOf(sectionOf("n"))).toEqual(["property-parameters"])
		})

		it("refuses a Pattern where a name belongs", () => {
			expect(codesOf(sectionOf("{ name }: { name: String }"))).toEqual([
				"property-parameters",
			])
		})

		it("refuses a label", () => {
			expect(codesOf(sectionOf("of n: Integer"))).toEqual([
				"property-parameters",
			])
		})

		it("refuses a default", () => {
			expect(codesOf(sectionOf("n: Integer = 1"))).toEqual([
				"property-parameters",
			])
		})

		it("refuses generating nothing at all", () => {
			expect(codesOf(sectionOf(""))).toEqual(["property-parameters"])
		})

		it("refuses a Type nothing can build a value of", () => {
			expect(codesOf(sectionOf("read: (_: String) -> Integer"))).toEqual([
				"ungeneratable-type",
			])
		})

		// NOTE: A Type that names itself is refused by the language before a
		// generator is ever derived from it. The derivation carries a guard of
		// its own all the same — a descriptor is finite data, and a Compiler
		// that overflowed its stack would be worse than one line of insurance.
		it("leaves a Choice that names itself to the language", () => {
			expect(
				codesOf(
					`implementation {
						choice Tree {
							Leaf,
							Node { left: Tree, right: Tree },
						}
					}

					${sectionOf("tree: Tree")}`,
				),
			).toEqual(["recursive-type-declaration"])
		})

		// NOTE: A predicate is rebuilt as the call an author could have
		// written, in the Scope the TEST stands in — so a Namespace that Scope
		// does not name is a predicate nothing can check, and a value nothing
		// can check is not one to generate.
		it("refuses a refinement whose Namespace the test does not name", () => {
			expect(
				codesOf(
					`implementation {
						type Chosen = List<Integer> where @::contains(1)
					}

					tests {
						constant List = 1

						test "a property" for any (items: Chosen) {
							expect true
						}
					}`,
				),
			).toEqual(["ungeneratable-type"])
		})

		it("refuses a refinement whose predicate describes no value", () => {
			expect(
				codesOf(
					`implementation {
						type Never = Integer where @::isGreaterThan(10)::and(@::isLessThan(5))
					}

					${sectionOf("n: Never")}`,
				),
			).toEqual([])
		})

		it("refuses a test that is both a table and a property", () => {
			expect(
				codesOf(
					`tests {
						test "both" across [1] (row: Integer) for any (n: Integer) {
							expect n::is(n)
						}
					}`,
				),
			).toEqual(["contradictory-test-forms"])
		})

		it("refuses a snapshot inside a property test", () => {
			expect(
				codesOf(
					sectionOf(
						"n: Integer",
						'expect n matches snapshot from "drawn"',
					),
				),
			).toEqual(["snapshot-in-property"])
		})

		// NOTE: A Parameter that was reported is still BOUND, so the body
		// reports what IT says rather than a cascade about a name that vanished.
		it("binds a Parameter it refused, so the body does not cascade", () => {
			expect(codesOf(sectionOf("n", "expect n::is(n)"))).toEqual([
				"property-parameters",
			])
		})

		it("reports two Parameters of one name where the second stands", () => {
			let [diagnostic] = analyse(
				sectionOf("a: Integer, a: String"),
			).diagnostics

			expect(diagnostic?.code).toBe("duplicate-variable")
			expect(diagnostic?.position).not.toBeNull()
			expect(diagnostic?.labels).not.toEqual([])
		})

		it("binds every Parameter in the body", () => {
			expect(
				codesOf(sectionOf("a: Integer, b: Integer", "expect a::is(b)")),
			).toEqual([])
		})

		// NOTE: A property's values are made up per case, so a name that read
		// one could not be worked out before anything ran.
		it("does not bind a Parameter in the name", () => {
			expect(
				codesOf(
					`tests {
						test "over {n}" for any (n: Integer) {
							expect n::is(n)
						}
					}`,
				),
			).toEqual(["unknown-name"])
		})
	})

	describe("What a property test emits", () => {
		it("calls the runtime with a generator per Parameter", () => {
			let javaScript = generate(
				sectionOf("a: Integer, b: String", "expect a::is(a)"),
			)

			expect(javaScript).toContain("$testing.properties($context, 0,")
			expect(javaScript).toContain('name: "a"')
			expect(javaScript).toContain('name: "b"')
			expect(javaScript).toContain('kind: "integer"')
			expect(javaScript).toContain('kind: "string"')
		})

		it("emits a refinement's check as a closure of the candidate", () => {
			let javaScript = generate(
				`implementation {
					type EvenInteger = Integer where @::isEven()
				}

				${sectionOf("n: EvenInteger", "expect n::is(n)")}`,
			)

			expect(javaScript).toContain('kind: "refined"')
			expect(javaScript).toContain("checks: [")
			expect(javaScript).toContain("$es_Integer_isEven($candidate")
		})

		it("emits a Generatable conformance as a closure of the source", () => {
			let javaScript = generate(
				`implementation {
					type Team = { name: String }

					namespace Team for Team is Generatable {
						static generate(from source: Randomness) -> Team {
							<- { name = "Lions" }
						}
					}
				}

				${sectionOf("team: Team", "expect team.name::is(team.name)")}`,
			)

			expect(javaScript).toContain('kind: "generated"')
			expect(javaScript).toContain("generate:")
			expect(javaScript).toContain("Team.generate(")
		})
	})

	describe("What a run reports", () => {
		const doubling = `implementation {
			function double(_ n: Integer) -> Integer { <- n::add(n) }
		}

		tests {
			test "doubling stays small" for any (n: Integer) {
				expect double(n)::isLessThan(1000)
			}
		}`

		it("runs a hundred cases by default and says so", async () => {
			let { events } = await run(`tests {
				test "add commutes" for any (a: Integer, b: Integer) {
					expect a::add(b)::is(b::add(a))
				}
			}`)
			let [property] = propertyEvents(events)

			expect(property?.cases).toBe(100)
			expect(property?.counterexample).toBeNull()
			expect(property?.seed).toBe("deadbeef")
			expect(events.some((event) => event.kind === "test-pass")).toBe(
				true,
			)
		})

		// NOTE: THE claim a drawn Dictionary has to keep. A Dictionary's keys
		// are compared by the keys' OWN `is` — that is the ratified design,
		// and every construction the Compiler emits threads a witness for it —
		// so a key Type whose Namespace writes its own `is` decides which two
		// drawn keys are ONE key. Built through a universal comparison instead,
		// a drawn Dictionary holds two entries the Program calls one key: every
		// Method that looks one up reaches the first of them and `length()`
		// counts both.
		//
		// A fixed seed and a fixed case count, so the run is the same run every
		// time. The property is a claim about EVERY drawn Dictionary, so any
		// seed that finds a counterexample is as good as another; this one
		// found one in a few cases.
		it("draws a Dictionary through the key Type's own equality", async () => {
			let { events } = await run(
				`implementation {
					type Tag = { name: String, note: String }

					namespace Tags for Tag is Equatable {
						is(_ other: Tag) -> Boolean { <- @.name::is(other.name) }
					}

					function distinctKeys(of d: Dictionary<Tag, Integer>) -> Integer {
						constant none: List<Tag> = []

						<- d::keys()::reduce(startingWith none, (seen, key) {
							if seen::contains(key) {
								<- seen
							} else {
								<- seen::append(key)
							}
						})::length()
					}
				}

				tests {
					test "one value per key" for any (d: Dictionary<Tag, Integer>) {
						expect distinctKeys(of d)::is(d::length())
					}
				}`,
				{ seed: "8fb9735e", cases: 200 },
			)
			let [property] = propertyEvents(events)

			expect(property?.counterexample).toBeNull()
			expect(events.some((event) => event.kind === "test-pass")).toBe(
				true,
			)
		})

		// NOTE: The Dictionary generator end to end — derived, lowered, emitted
		// and interpreted. What is under test is that a hundred cases BUILD one
		// and the run reports on them rather than throwing somewhere in the
		// interpreter.
		it("draws a Dictionary for every case of a property", async () => {
			let { events } = await run(`tests {
				test "a Dictionary can be drawn" for any (entries: Dictionary<String, Integer>) {
					expect true
				}
			}`)
			let [property] = propertyEvents(events)

			expect(property?.cases).toBe(100)
			expect(property?.counterexample).toBeNull()
			expect(events.some((event) => event.kind === "test-pass")).toBe(
				true,
			)
		})

		it("runs as many cases as it was asked for", async () => {
			let { events } = await run(
				`tests {
					test "add commutes" for any (a: Integer, b: Integer) {
						expect a::add(b)::is(b::add(a))
					}
				}`,
				{ cases: 7 },
			)

			expect(propertyEvents(events)[0]?.cases).toBe(7)
		})

		// NOTE: 500 is the smallest Integer whose double is not below 1000, and
		// the shrink has to reach exactly it.
		it("shrinks a failure to the smallest value that still fails", async () => {
			let { events } = await run(doubling)
			let [property] = propertyEvents(events)

			expect(counterexampleOf(events)).toEqual({ n: "500" })
			expect(property?.shrinks).toBeGreaterThan(0)
			expect(events.some((event) => event.kind === "test-fail")).toBe(
				true,
			)
		})

		it("reports the same counterexample for the same seed", async () => {
			let first = await run(doubling, { seed: "cafe" })
			let again = await run(doubling, { seed: "cafe" })

			expect(propertyEvents(first.events)[0]).toEqual(
				propertyEvents(again.events)[0]!,
			)
		})

		// NOTE: The size a case is drawn at grows with the case number over the
		// WHOLE run, so a hundred cases and four hundred draw two different
		// sequences from one seed — which is why a replay has to name the count.
		it("names --cases in the replay where it is not the default", async () => {
			let { events } = await run(doubling, { cases: 400 })
			let [property] = propertyEvents(events)

			expect(property?.requested).toBe(400)
		})

		it("says a hundred cases were asked for where nobody said", async () => {
			let { events } = await run(doubling)

			expect(propertyEvents(events)[0]?.requested).toBe(100)
		})

		it("reports a different run for a different seed", async () => {
			let first = await run(doubling, { seed: "one" })
			let other = await run(doubling, { seed: "two" })

			expect(propertyEvents(first.events)[0]?.cases).not.toBe(
				propertyEvents(other.events)[0]?.cases,
			)
		})

		// NOTE: A hundred cases that all held leave NOTHING behind — the
		// buffers are cut back after each one, so what a failure reports is the
		// failing case's own recordings.
		it("reports one expectation for a hundred passing cases", async () => {
			let { events } = await run(`tests {
				test "add commutes" for any (a: Integer, b: Integer) {
					expect a::add(b)::is(b::add(a))
				}
			}`)
			let [pass] = events.filter((event) => event.kind === "test-pass")

			expect((pass as { expectations: number }).expectations).toBe(1)
		})

		it("shrinks a List to the shortest one that still fails", async () => {
			let { events } = await run(`tests {
				test "a list is short" for any (items: NonEmptyList<Integer>) {
					expect items::length()::isLessThan(3)
				}
			}`)

			expect(counterexampleOf(events).items).toBe("[ 0, 0, 0 ]")
		})

		// NOTE: THE claim a refinement rests on: no case is ever run with a
		// value the Type says is impossible.
		it("never runs a case with an empty non-empty List", async () => {
			let { events } = await run(`tests {
				test "never empty" for any (items: NonEmptyList<Integer>) {
					expect items::hasItems()
				}
			}`)

			expect(propertyEvents(events)[0]?.counterexample).toBeNull()
		})

		// NOTE: The same claim over the second container, and the reason it is
		// worth a case of its own: a Dictionary is narrowed by a length the
		// generator has to spend on distinct KEYS, so a draw that met the
		// minimum by repeating one key would answer a Dictionary with fewer
		// entries than it drew.
		it("never runs a case with an empty non-empty Dictionary", async () => {
			let { events } = await run(`tests {
				test "never empty" for any (d: NonEmptyDictionary<String, Integer>) {
					expect d::hasEntries()
				}
			}`)

			expect(propertyEvents(events)[0]?.counterexample).toBeNull()
		})

		it("never runs a case with a zero non-zero Integer", async () => {
			let { events } = await run(`tests {
				test "never zero" for any (n: NonZeroInteger) {
					expect n::isNot(0)
				}
			}`)

			expect(propertyEvents(events)[0]?.counterexample).toBeNull()
		})

		it("never runs a case a filtered predicate refuses", async () => {
			let { events } = await run(`implementation {
				type EvenInteger = Integer where @::isEven()
			}

			tests {
				test "always even" for any (n: EvenInteger) {
					expect n::isEven()
				}
			}`)

			expect(propertyEvents(events)[0]?.counterexample).toBeNull()
		})

		it("shrinks a Record one member at a time", async () => {
			let { events } = await run(`tests {
				test "small scores" for any (row: { name: String, score: Integer }) {
					expect row.score::isLessThan(4)
				}
			}`)

			expect(counterexampleOf(events).row).toBe(
				'{ name = "", score = 4 }',
			)
		})

		it("shrinks a Choice towards a Case that carries nothing", async () => {
			let { events } = await run(`implementation {
				choice Shade {
					Light,
					Dark { level: Integer },
				}
			}

			tests {
				test "never dark" for any (shade: Shade) {
					expect shade::is(#Light)
				}
			}`)

			expect(counterexampleOf(events).shade).toBe("Shade#Dark(0)")
		})

		// NOTE: A refinement nothing satisfies is a failure of the RUN rather
		// than of the property — the test asserted nothing, and a report saying
		// it passed would be claiming otherwise.
		it("ends the test where nothing could be generated", async () => {
			let { events } = await run(`implementation {
				type Never = Integer where @::isGreaterThan(10)::and(@::isLessThan(5))
			}

			tests {
				test "impossible" for any (n: Never) {
					expect n::is(n)
				}
			}`)
			let [failure] = events.filter((event) => event.kind === "test-fail")
			let [property] = propertyEvents(events)

			expect((failure as { error: string | null }).error).toContain(
				"Never",
			)
			expect(property?.cases).toBe(0)
			expect(property?.counterexample).toBeNull()
		})

		it("ends the whole test at the first failing case", async () => {
			let { events } = await run(doubling)
			let starts = events.filter((event) => event.kind === "test-start")

			expect(starts).toHaveLength(1)
		})
	})
})
