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
import { compiles } from "./followedHelps"

// `test "…" for any (…)` end to end: the generator the Enricher derives from
// each Parameter's Type, what it refuses, the emission, and what a run reports.
// `packages/runtime/src/tests/generators.spec.ts` covers the interpreter.

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

// A section holding one property test, so a spec writes only the `for any (…)`
// and its body.
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

// The generator's shape, with each Expression replaced by a word. A key
// witness shows as the Namespace it resolved to, which says whose `is` compares
// a drawn Dictionary's keys.
function shapeOf(generator: common.typed.TestGenerator): unknown {
	return JSON.parse(
		JSON.stringify(generator, (key, value: unknown) => {
			if (key === "call" || key === "shrink") {
				return `<${key}>`
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

// Runs through the loaded program's own `$tests`. A value's hidden Type key
// belongs to the runtime instance that built it, so this package's copy would
// read `undefined` off it.
async function run(
	source: string,
	options: { seed?: string; cases?: number } = {},
): Promise<Run> {
	let javaScript = generate(source)
	let directory = mkdtempSync(join(tmpdir(), "essence-properties-"))
	let file = join(directory, "program.ts")

	writeFileSync(file, javaScript)

	// Read just before the load, since every program this process loads
	// registers into one array.
	let before = registry().modules.length
	let loaded = (await import(file)) as Loaded
	let scoped = registryOf(loaded.$tests.registry().modules.slice(before))
	let events: Array<TestEvent> = []

	try {
		await loaded.$tests.run(scoped, {
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

		// Each slot is derived on its own, never read off the other.
		it("derives a Dictionary from both of its slots", () => {
			expect(
				shapeOf(generatorOf("entries: Dictionary<String, Integer>")),
			).toEqual({
				kind: "dictionary",
				key: { kind: "string" },
				value: { kind: "integer" },
				// The key Type's own Equatable compares the drawn keys, as it
				// does a written Dictionary's.
				keyConformance: "<String>",
			})
		})

		// A bare Dictionary decides neither slot, so both take the ladder of
		// "instantiates an unapplied generic over Integer, String and a Record".
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

		// An unapplied Type Parameter draws a scalar, a String or a Record,
		// standing for what a use site could instantiate it with.
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
		// `NonEmptyList<ItemType> = List<ItemType> where @::hasItems()`.
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

		// `NonEmptyDictionary<KeyType, ValueType> = Dictionary<KeyType,
		// ValueType> where @::hasEntries()`. A Dictionary's length counts
		// entries, so `minimumLength` narrows it as it narrows a List. The key
		// witness is the same as without the refinement.
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

		// `NonZeroInteger = Integer where @::isNot(0)`.
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

		// A predicate no narrowing holds becomes a check: the Boolean
		// Expression an author could have written about the value.
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

		// A refinement flows into its base, so the base's Namespace is offered
		// for the refinement. Taking it whole would draw impossible values.
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
				// The base still draws through the conformance, which suits the
				// refinement too, and the predicate filters what it drew.
				base: { kind: "generated", name: "Counter" },
				checks: 1,
			})
		})

		// A Program's own Namespace may mean something else by a name the
		// narrowing table knows. This `isLessThan` body is a chain with no leaf
		// to resolve to, so the predicate stays a check.
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

		// A body that forwards its Argument is read through to the leaf.
		// `Weird::isLessThan` is `@::isGreaterThan(other)`, so the refinement
		// narrows to values above zero.
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

		// `Weird::isPositive` is one call on `@`, so the predicate is that call,
		// a value below zero, held by construction. The Method's name decides
		// nothing.
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
				// `Generatable` provides a `shrink` answering no candidates, so a
				// Namespace that writes none still carries the call.
				shrinkBinding: expect.any(String) as unknown as string,
				shrink: "<shrink>",
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

		// One Namespace with and without a `shrink`, so the reports differ by
		// that Method alone. Every value it draws fails the property.
		function counting(shrinking = ""): string {
			return `type Counter = { count: Integer }

				namespace Counter for Counter is Generatable {
					static generate(from source: Randomness) -> Counter {
						<- { count = source::drawInteger(between 50, and 100) }
					}

					${shrinking}
				}`
		}

		// A written `shrink` supplies the smaller candidates, and the runner keeps
		// the first that still fails and asks it again. This `shrink` steps down by
		// one, so the report names the smallest failing count.
		it("shrinks a counterexample through the conformance's own shrink", async () => {
			let { events } = await run(`implementation {
				${counting(`shrink() -> List<Counter> {
					if @.count::isGreaterThan(0) {
						<- [{ count = @.count::subtract(1) }]
					} else {
						<- []
					}
				}`)}
			}

			tests {
				test "a counter is small" for any (counter: Counter) {
					expect counter.count::isLessThan(10)
				}
			}`)
			let [property] = propertyEvents(events)

			expect(counterexampleOf(events).counter).toBe("{ count = 10 }")
			expect(property?.shrinks).toBeGreaterThan(0)
		})

		// Without a written `shrink`, `Generatable`'s own body answers no
		// candidates, so the value is reported as drawn.
		it("reports a drawn value as it stands where the Namespace writes no shrink", async () => {
			let { events } = await run(`implementation {
				${counting()}
			}

			tests {
				test "a counter is small" for any (counter: Counter) {
					expect counter.count::isLessThan(10)
				}
			}`)
			let [property] = propertyEvents(events)

			expect(property?.shrinks).toBe(0)
			expect(counterexampleOf(events).counter).toMatch(
				/^\{ count = (5|6|7|8|9|10)[0-9] \}$/,
			)
		})

		// A generic Namespace's `generate` takes only a `Randomness`, so nothing
		// at the call binds its Type Parameters. The conformance is refused rather
		// than silently replaced by the structural draw and shrink.
		const pair = `type Twin = { first: Integer, second: Integer }

			type Pair<Item> = { held: Item, mark: Integer }

			namespace Twin for Twin is Generatable {
				static generate(from source: Randomness) -> Twin {
					<- { first = 7, second = 7 }
				}

				shrink() -> List<Twin> {
					<- []
				}
			}

			namespace Pair<infer Item> for Pair<Item>
				is Generatable where Item is Generatable
			{
				static generate(from source: Randomness) -> Pair<Item> {
					<- { held = Item.generate(from source), mark = 42 }
				}

				shrink() -> List<Pair<Item>> {
					<- []
				}
			}`

		it("refuses a generic Namespace's conformance rather than passing it over", () => {
			let source = `implementation {
				${pair}
			}

			tests {
				test "a pair is marked" for any (pair: Pair<Twin>) {
					expect pair.mark::is(0)
				}
			}`

			expect(codesOf(source)).toEqual(["unreachable-conformance"])
			expect(
				analyse(source).diagnostics.flatMap(
					(diagnostic) => diagnostic.helps,
				),
			).toEqual([
				"Declare 'Generatable' on a Namespace whose target Type is already applied, rather than on a generic one.",
			])
		})

		// A Namespace over the applied Type, as the Help asks, answers beside
		// the generic one: its draw is used and nothing is refused.
		it("takes a Namespace over the applied Type beside a generic one", async () => {
			let { events } = await run(`implementation {
				${pair}

				namespace TwinPair for Pair<Twin> is Generatable {
					static generate(from source: Randomness) -> Pair<Twin> {
						<- { held = { first = 3, second = 3 }, mark = 99 }
					}

					shrink() -> List<Pair<Twin>> {
						<- []
					}
				}
			}

			tests {
				test "a pair is marked" for any (pair: Pair<Twin>) {
					expect pair.mark::is(0)
				}
			}`)
			let [property] = propertyEvents(events)

			expect(property?.shrinks).toBe(0)
			expect(counterexampleOf(events).pair).toBe(
				"{ held = { first = 3, second = 3 }, mark = 99 }",
			)
		})
	})

	// A `require` takes a drawn value apart like any other. A case that misses
	// fails the property on that draw.
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

		// The Parser reads one written word as the name. Whether the word
		// resolves to a Type decides whether the name or the Type is missing.
		// Nothing says which Type was meant, so the Help leaves it blank.
		it("asks for a name where the one word written is a Type", () => {
			expect(analyse(sectionOf("Integer")).diagnostics[0]?.helps).toEqual(
				["Write a name for it: 'for any (value: Integer)'."],
			)

			expect(analyse(sectionOf("n")).diagnostics[0]?.helps).toEqual([
				"Write the Type: 'for any (n: …)'.",
			])
		})

		it("compiles once the missing half is written", () => {
			let body = 'expect "{value}"::hasCharacters()'

			expect(
				compiles(sectionOf("value: Integer", body), { tests: true }),
			).toBe(true)
			expect(
				compiles(sectionOf("a: String, b: String", "expect a::is(a)"), {
					tests: true,
				}),
			).toBe(true)
		})

		// A `_` names no value for a counterexample to stand beside, and a
		// label before it is a label still.
		it("refuses a '_' where a name belongs", () => {
			expect(analyse(sectionOf("_: Integer")).diagnostics).toMatchObject([
				{
					code: "property-parameters",
					message: "A generated Parameter has to be a name",
					helps: ["Name the value — 'for any (value: Integer)'."],
				},
			])
			expect(
				analyse(sectionOf("on _: Integer")).diagnostics.map(
					(diagnostic) => [diagnostic.message, diagnostic.helps],
				),
			).toEqual([
				[
					"A generated Parameter has to be a name",
					["Name the value — 'for any (value: Integer)'."],
				],
				[
					"A generated Parameter takes no label",
					["Write the name alone: 'for any (value: …)'."],
				],
			])
			expect(
				compiles(
					sectionOf("value: Integer", "expect value::is(value)"),
					{
						tests: true,
					},
				),
			).toBe(true)
		})

		it("refuses a Pattern where a name belongs", () => {
			expect(codesOf(sectionOf("{ name }: { name: String }"))).toEqual([
				"property-parameters",
			])
		})

		// Each name the Pattern would have bound is bound at its member's Type.
		// So the body reading it is not reported again, and a mistake the body
		// makes with it still is.
		it("binds the names of a refused Pattern, so the body does not cascade", () => {
			expect(
				codesOf(
					sectionOf(
						"{ name }: { name: String }",
						"expect name::is(name)",
					),
				),
			).toEqual(["property-parameters"])
			expect(
				codesOf(
					sectionOf(
						"{ name }: { name: String }",
						"expect name::frobnicate()",
					),
				),
			).toEqual(["property-parameters", "unknown-method"])
		})

		// A member the Pattern annotates is bound at the annotation, which
		// narrows it as it would in a Matcher.
		it("binds an annotated member of a refused Pattern at its annotation", () => {
			expect(
				codesOf(
					sectionOf(
						"{ score: Integer }: { score: Integer | String }",
						"expect score::isGreaterThan(0)",
					),
				),
			).toEqual(["property-parameters"])
		})

		// A name another Parameter writes is that Parameter's, so the Pattern
		// does not bind it a second time.
		it("binds no name of a refused Pattern that another Parameter writes", () => {
			expect(
				codesOf(sectionOf("{ name }: { name: String }, name: String")),
			).toEqual(["property-parameters"])
		})

		// The Help names the whole value at the Type the reader wrote.
		it("spells the Type a Pattern was written at", () => {
			expect(
				analyse(sectionOf("{ name }: { name: String }")).diagnostics[0]
					?.helps,
			).toEqual([
				"Name the whole value — 'for any (value: { name: String })' — and take it apart inside the body.",
			])
			expect(
				compiles(
					sectionOf(
						"value: { name: String }",
						"constant { name } = value\n\n\t\t\texpect name::is(name)",
					),
					{ tests: true },
				),
			).toBe(true)
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

		// The conformance the Help asks for, with the `shrink` its second Help
		// asks for, written for the Function Type and for a Record holding one.
		it("compiles once a Generatable conformance builds the value", () => {
			expect(
				analyse(sectionOf("read: (_: String) -> Integer"))
					.diagnostics[0]?.helps,
			).toEqual([
				"Write a Type a value can be built of, or declare a 'Generatable' conformance for this one.",
				"Write 'shrink' in the conformance as well: 'Generatable' provides one that answers no candidates, and a counterexample is otherwise reported as it was drawn.",
			])
			expect(
				compiles(
					`implementation {
						namespace Readers for (_: String) -> Integer is Generatable {
							static generate(from source: Randomness) -> (_: String) -> Integer {
								<- (_ text: String) -> Integer { <- 1 }
							}

							shrink() -> List<(_: String) -> Integer> {
								<- []
							}
						}
					}

					${sectionOf("read: (_: String) -> Integer", 'expect read("a")::is(1)')}`,
					{ tests: true },
				),
			).toBe(true)
			expect(
				compiles(
					`implementation {
						type Reader = { read: (_: String) -> Integer, name: String }

						namespace Readers for Reader is Generatable {
							static generate(from source: Randomness) -> Reader {
								<- { read = (_ text: String) -> Integer { <- 1 }, name = "one" }
							}

							shrink() -> List<Reader> {
								<- []
							}
						}
					}

					${sectionOf("reader: Reader", "expect reader.name::is(reader.name)")}`,
					{ tests: true },
				),
			).toBe(true)
		})

		// The language refuses a Type that names itself before any generator
		// is derived. The derivation still guards against one.
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

		// A predicate is rebuilt as a call in the test's Scope. Where that Scope
		// does not name the Namespace, nothing can check a drawn value.
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

		// Only drawing finds the predicate empty, so the compile accepts the
		// test and the run refuses it.
		it("refuses a refinement whose predicate describes no value when it runs", async () => {
			let source = `implementation {
				type Never = Integer where @::isGreaterThan(10)::and(@::isLessThan(5))
			}

			${sectionOf("n: Never")}`

			expect(codesOf(source)).toEqual([])

			let { events } = await run(source)
			let [failure] = events.filter((event) => event.kind === "test-fail")

			expect((failure as { error: string | null }).error).toBe(
				"Could not generate a value of 'Never'. Its predicate describes no value at all.",
			)
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

		// A refused Parameter is still bound, so the body does not report the
		// name again.
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

		// A property's values are drawn per case, so a test name cannot read
		// one.
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

		// Each half of the conformance is a closure of the name it binds. One
		// reads the draw's source, the other the value to shrink. This Namespace
		// writes no `shrink`, so the Protocol's provided body is called.
		it("emits a Generatable conformance as closures of its two halves", () => {
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
			expect(javaScript).toContain("shrink:")
			expect(javaScript).toContain("$es_Generatable__shrink(")
		})

		// A written `shrink` overrides the provided one, as for any provided
		// Method.
		it("emits a written shrink as the Namespace's own call", () => {
			let javaScript = generate(
				`implementation {
					type Team = { name: String }

					namespace Team for Team is Generatable {
						static generate(from source: Randomness) -> Team {
							<- { name = "Lions" }
						}

						shrink() -> List<Team> {
							<- [{ name = "Ants" }]
						}
					}
				}

				${sectionOf("team: Team", "expect team.name::is(team.name)")}`,
			)

			expect(javaScript).toContain("Team.shrink(")
			expect(javaScript).not.toContain("$es_Generatable__shrink(")
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

		// A Dictionary compares keys by the key Type's own `is`, so a drawn one
		// must never hold two keys `Tags` calls equal. The seed and case count are
		// fixed, so every run is the same run.
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

		// The Dictionary generator end to end: each case builds one and the run
		// reports rather than throwing.
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

		// 500 is the smallest Integer whose double is not below 1000, and
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

		// The draw size grows with the case number over the whole run, so a
		// replay must name the case count as well as the seed.
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

		// The buffers are cut back after each passing case, so a failure reports
		// only its own case's recordings.
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

		// No case ever runs with a value the Type says is impossible.
		it("never runs a case with an empty non-empty List", async () => {
			let { events } = await run(`tests {
				test "never empty" for any (items: NonEmptyList<Integer>) {
					expect items::hasItems()
				}
			}`)

			expect(propertyEvents(events)[0]?.counterexample).toBeNull()
		})

		// A Dictionary's length must be spent on distinct keys. A draw that
		// repeated one key would answer fewer entries than it drew.
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

		// `Result` is an ordinary generic Choice, so a property draws both
		// Cases. Each direction has its own spec, since a generator drawing one
		// Case alone would fail only one of them.
		it("draws the failed Case of a Result", async () => {
			let { events } = await run(`tests {
				test "every Result holds a value" for any (answered: Result<Integer, String>) {
					expect answered::hasValue()
				}
			}`)

			expect(counterexampleOf(events).answered).toBe('Result#Failure("")')
		})

		it("draws the value Case of a Result too", async () => {
			let { events } = await run(`tests {
				test "every Result failed" for any (answered: Result<Integer, String>) {
					expect answered::hasFailed()
				}
			}`)

			expect(counterexampleOf(events).answered).toBe("Result#Value(0)")
		})

		// The payload shrinks as any Case's does.
		it("shrinks a Result's payload to the smallest one that still fails", async () => {
			let { events } = await run(`tests {
				test "small answers" for any (answered: Result<Integer, String>) {
					expect answered::value(defaultingTo 0)::isLessThan(4)
				}
			}`)

			expect(counterexampleOf(events).answered).toBe("Result#Value(4)")
		})

		// A refinement nothing satisfies fails the run rather than the property.
		// The test asserted nothing, so it must not report a pass.
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
