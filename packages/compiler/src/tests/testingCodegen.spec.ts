import { describe, expect, it } from "bun:test"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { fixturePath } from "@essence-lang/fixtures"
import type { entryPoints, TestEvent } from "@essence-lang/runtime/Testing"
import { registry, registryOf } from "@essence-lang/runtime/Testing"

import { containsErrors } from "../diagnostics/index"
import { compileToMemory } from "../embed/index"
import { enrich } from "../enricher/index"
import { optimise } from "../optimiser/index"
import { parseWithDiagnostics } from "../parser/index"
import { rewrite } from "../rewriter/index"
import { simplify } from "../simplifier/index"
import { validate } from "../validator/index"

// NOTE: What a `tests { … }` block becomes, and what it does when it runs. The
// two halves are here together on purpose: a golden that says what was emitted
// proves nothing on its own, and a run that passes says nothing about the shape
// somebody has to read when it stops passing.

// NOTE: The stages the CLI runs, with the tests asked for — `simplify` is
// handed the source because the span table carries the text of every
// instrumented point.
function generate(source: string): string {
	let parsed = parseWithDiagnostics(source)

	expect(containsErrors(parsed.diagnostics)).toBe(false)

	let enriched = enrich(parsed.program, { tests: true })

	expect(containsErrors(enriched.diagnostics)).toBe(false)
	expect(containsErrors(validate(enriched.program))).toBe(false)

	return rewrite(optimise(simplify(enriched.program, { source })))
}

// NOTE: The same, with the tests left alone — what `essence build` emits.
function build(source: string): string {
	let parsed = parseWithDiagnostics(source)
	let enriched = enrich(parsed.program)

	return rewrite(optimise(simplify(enriched.program)))
}

// NOTE: Everything from `$testing.register(` on, which is the whole of what a
// tests section emits. Snapshotting the file would snapshot the standard
// library prelude with it, and every unrelated change to that would rewrite
// this golden.
function registration(javaScript: string): string {
	let start = javaScript.indexOf("$testing.register(")

	expect(start).toBeGreaterThan(-1)

	return javaScript.slice(start)
}

type Loaded = { $tests: typeof entryPoints }

// NOTE: Writes the emitted Program to a throwaway module and imports it, the
// way `codeGeneration.spec.ts` does — the emitted imports are absolute paths
// into this repo's runtime, so the module resolves from anywhere.
//
// NOTE: The run is driven through the bundle's OWN `$tests`, never through this
// package's copy of the test runtime. Every Essence value carries a hidden Type
// key that is a `Symbol` of the runtime instance that built it, so a diff or a
// rendering asked from outside would read `undefined` off every value it was
// handed.
async function load(
	javaScript: string,
	extension = ".ts",
): Promise<{ loaded: Loaded; dispose: () => void }> {
	let directory = mkdtempSync(join(tmpdir(), "essence-tests-"))
	let file = join(directory, `program${extension}`)

	writeFileSync(file, javaScript)

	return {
		loaded: (await import(file)) as Loaded,
		dispose: () => rmSync(directory, { recursive: true, force: true }),
	}
}

type Run = {
	events: Array<TestEvent>
	summary: ReturnType<typeof entryPoints.run>
}

// NOTE: An emitted `.ts` program imports the runtime by its absolute path, which
// is the very module this spec file imports — so every program loaded ANYWHERE
// in this process registers into ONE array, and a run has to be given the
// Modules its own program put there. The count is read immediately before the
// load rather than kept between runs, because another spec file sharing this
// process registers into the same array and would otherwise be run by this one.
// A bundle has no such trouble: esbuild inlines a runtime of its own.

// NOTE: Essence source in, the events its tests emitted out — the whole
// pipeline, then the run, which is the only way to be sure the emitted shape
// asserted on above is a shape that WORKS.
async function run(
	source: string,
	filters?: Parameters<typeof entryPoints.run>[1]["filters"],
): Promise<Run> {
	let before = registry().modules.length
	let { loaded, dispose } = await load(generate(source))
	let modules = loaded.$tests.registry().modules
	// NOTE: `registryOf` only indexes what it is handed — no Essence value is
	// read — so this spec's copy of it answers for a Module whichever runtime
	// instance registered it. The RUN goes through the loaded program's own
	// `$tests`, which is where the values belong.
	let scoped = registryOf(modules.slice(before))
	let events: Array<TestEvent> = []

	try {
		let summary = loaded.$tests.run(scoped, {
			sink: (event) => events.push(event),
			now: () => 0,
			filters,
		})

		return { events, summary }
	} finally {
		dispose()
	}
}

function eventsOf(events: Array<TestEvent>, kind: string): Array<TestEvent> {
	return events.filter((event) => event.kind === kind)
}

const twoTests = `implementation {
	constant shipped = 2
}

tests {
	constant doubled = shipped::multiply(with 2)

	suite "arithmetic" {
		test "doubles" {
			expect doubled::is(4)
		}
	}

	test "carries the constant" tagged slow {
		expect shipped::is(2)
	}
}`

const tableTest = `implementation {
	function twice(_ n: Integer) -> Integer {
		<- n::multiply(with 2)
	}
}

tests {
	test "{n} doubled" across [1, 2, 3] (n: Integer) {
		expect twice(n)::isLessThan(6)
	}
}`

describe("Test codegen — the emitted shape", () => {
	it("registers one manifest for the Module and publishes the way in", () => {
		let javaScript = generate(twoTests)

		expect(javaScript).toContain("$testing.register({")
		expect(javaScript).toContain(
			"export const $tests = $testing.entryPoints;",
		)
		expect(javaScript).toContain('import * as $testing from "')
	})

	it("emits nothing at all for a build", () => {
		let javaScript = build(twoTests)

		expect(javaScript).not.toContain("$testing")
		expect(javaScript).not.toContain("$tests")
	})

	it("writes the section as one Function of the per-test context", () => {
		expect(generate(twoTests)).toContain("run: $context => {")
	})

	it("numbers each test and registers it where it was written", () => {
		let emitted = registration(generate(twoTests))

		expect(emitted).toContain("$testing.entry($context, 0, null, () => {")
		expect(emitted).toContain("$testing.entry($context, 1, null, () => {")
	})

	it("keeps the golden shape of a whole registration", () => {
		expect(registration(generate(twoTests))).toMatchSnapshot()
	})

	it("hands an interpolated name over where the test stands", () => {
		let javaScript = generate(`implementation {
			constant scored = 2
		}

		tests {
			test "{scored} is a win" {
				expect scored::is(2)
			}
		}`)

		expect(javaScript).toContain(
			'$testing.entry($context, 0, String.createString("" + Integer.toString(scored).value + " is a win"), () => {',
		)
	})

	it("traces a call and a member read, and leaves a name alone", () => {
		let javaScript = generate(`implementation {
			type Standing = { team: String, points: Integer }

			function leader() -> Standing {
				<- { team = "Lions", points = 19 }
			}
		}

		tests {
			test "one" {
				expect leader().points::isGreaterThan(10)
			}
		}`)

		expect(javaScript).toContain("$testing.trace($context, 1, leader())")
		expect(javaScript).toMatch(
			/\$testing\.trace\(\$context, 2, \$testing\.trace\(\$context, 1, leader\(\)\)\.points\)/,
		)
	})

	it("ends the test at a failed require and binds after it", () => {
		let javaScript = generate(`implementation {
			constant rows = [1, 2]
		}

		tests {
			test "one" {
				require #Value(first) = rows::firstItem()

				expect first::is(1)
			}
		}`)

		// NOTE: One call rather than a guarded early return — the runtime
		// unwinds a failed `require`, so the Constants the Matcher binds below
		// it are never reached however deep in the lowering the assertion
		// stands.
		expect(javaScript).toMatch(
			/\$testing\.required\(\$context, 0, [\s\S]*?\);\n\s*const first =/,
		)
		expect(javaScript).not.toContain("!$testing.required")
	})

	// NOTE: An assertion's Matcher is a Match Handler standing on its own, so
	// `compile-type-tests` has to reach it where it stands — the same question
	// asked the general way here and the cheap way in the `match` this is
	// spelled like is exactly the drift the shared node was for.
	it("compiles an assertion's Matcher to the tag test a Handler gets", () => {
		let javaScript = generate(`implementation {
			constant rows = [1, 2]
		}

		tests {
			test "one" {
				require #Value(first) = rows::firstItem()

				expect first::is(1)
			}
		}`)

		expect(javaScript).toContain(
			'(_self => _self[$type.typeKeySymbol] === "Optional#Value")' +
				"($assertion_7_29)",
		)
		expect(javaScript).not.toContain("$type.isValueOfType($assertion")
	})

	it("says which two values a comparison compared", () => {
		let javaScript = generate(`implementation {}

		tests {
			test "one" {
				expect 3::is(3)
			}
		}`)

		expect(javaScript).toMatch(
			/\{\n\s*kind: "is",\n\s*left: 1,\n\s*right: 2\n\s*\}/,
		)
	})

	it("says nothing about a comparison an assertion is not", () => {
		let javaScript = generate(`implementation {}

		tests {
			test "one" {
				expect true
			}
		}`)

		expect(javaScript).toContain(
			"$testing.expected($context, 0, Boolean.createBoolean(true).value, null)",
		)
	})

	it("emits a suite as a block, so its Constants can shadow", () => {
		let javaScript = generate(`implementation {}

		tests {
			constant rows = 1

			suite "inner" {
				constant rows = 2

				test "one" {
					expect rows::is(2)
				}
			}
		}`)

		expect(javaScript).toMatch(
			/const rows = \$pool_\d+;\n\s*\{\n\s*const rows = \$pool_\d+;/,
		)
	})
})

describe("Test codegen — the span table", () => {
	it("carries the source of every instrumented point", () => {
		let javaScript = generate(`implementation {
			constant shipped = 2
		}

		tests {
			test "one" {
				expect shipped::is(2)
			}
		}`)
		let emitted = registration(javaScript)

		expect(emitted).toContain('source: "shipped::is(2)"')
		expect(emitted).toContain('source: "shipped"')
		expect(emitted).toContain('source: "2"')
	})

	it("spans the Matcher and the value of an assertion that takes one apart", () => {
		let javaScript = generate(`implementation {
			constant shipped = 2
		}

		tests {
			test "one" {
				require Integer = shipped
			}
		}`)

		expect(registration(javaScript)).toContain(
			'source: "Integer = shipped"',
		)
	})

	it("has no source to carry where the Module's text was not handed over", () => {
		let source = `implementation {
			constant shipped = 2
		}

		tests {
			test "one" {
				expect shipped::is(2)
			}
		}`
		let parsed = parseWithDiagnostics(source)
		let enriched = enrich(parsed.program, { tests: true })
		let javaScript = rewrite(optimise(simplify(enriched.program)))

		expect(registration(javaScript)).toContain('source: ""')
	})
})

describe("Test codegen — running what was emitted", () => {
	it("runs each test and reports what it did", async () => {
		let { events, summary } = await run(twoTests)

		expect(summary).toMatchObject({ passed: 2, failed: 0, skipped: 0 })
		expect(
			eventsOf(events, "test-start").map((event) =>
				event.kind === "test-start" ? event.name : "",
			),
		).toEqual(["doubles", "carries the constant"])
	})

	it("folds a suite into the identity and the reported path", async () => {
		let { events } = await run(twoTests)
		let started = eventsOf(events, "test-start")[0]

		expect(started).toMatchObject({
			id: "/arithmetic/doubles",
			suitePath: ["arithmetic"],
		})
	})

	it("carries a test's effective tags into selection", async () => {
		let { summary } = await run(twoTests, { skipTags: ["slow"] })

		expect(summary).toMatchObject({ passed: 1, deselected: 1 })
	})

	it("explains a failure out of the values it was built from", async () => {
		let { events } = await run(`implementation {
			type Standing = { team: String, points: Integer }

			function leader() -> Standing {
				<- { team = "Lions", points = 19 }
			}

			function second() -> Standing {
				<- { team = "Tigers", points = 16 }
			}
		}

		tests {
			test "the leader is two points clear" {
				expect leader().points::subtract(second().points)::is(2)
			}
		}`)
		let failure = eventsOf(events, "test-fail")[0]

		expect(failure).toMatchObject({
			failures: [
				{
					form: "expect",
					span: {
						source: "leader().points::subtract(second().points)::is(2)",
					},
					values: [
						{ span: { source: "leader()" } },
						{ span: { source: "leader().points" }, value: "19" },
						{ span: { source: "second()" } },
						{ span: { source: "second().points" }, value: "16" },
						{
							span: {
								source: "leader().points::subtract(second().points)",
							},
							value: "3",
						},
						{ span: { source: "2" }, value: "2" },
					],
					comparison: { kind: "is", left: "3", right: "2" },
				},
			],
		})
	})

	it("diffs the two Records an `is` compared", async () => {
		let { events } = await run(`implementation {
			type Standing = { team: String, points: Integer }

			function leader() -> Standing {
				<- { team = "Lions", points = 19 }
			}
		}

		tests {
			test "one" {
				expect leader()::is({ team = "Lions", points = 20 })
			}
		}`)
		let failure = eventsOf(events, "test-fail")[0]

		expect(
			failure?.kind === "test-fail"
				? failure.failures[0]?.comparison?.diff
				: null,
		).toEqual([
			{ kind: "same", text: "{" },
			{ kind: "same", text: '    team = "Lions",' },
			{ kind: "left", text: "    points = 19," },
			{ kind: "right", text: "    points = 20," },
			{ kind: "same", text: "}" },
		])
	})

	it("records every failed expect and carries on", async () => {
		let { events, summary } = await run(`implementation {}

		tests {
			test "one" {
				expect false
				expect true
				expect false
			}
		}`)

		expect(summary.failed).toBe(1)
		expect(eventsOf(events, "expect").length).toBe(3)
		expect(
			events.find((event) => event.kind === "test-fail"),
		).toMatchObject({ expectations: 3 })
	})

	it("stops the test at a failed require", async () => {
		let { events, summary } = await run(`implementation {
			constant rows: List<Integer> = []
		}

		tests {
			test "one" {
				require #Value(first) = rows::firstItem()

				expect first::is(1)
			}
		}`)

		expect(summary.failed).toBe(1)
		expect(eventsOf(events, "expect").length).toBe(1)
	})

	it("binds through a Matcher when the require holds", async () => {
		let { summary } = await run(`implementation {
			constant rows = [1, 2]
		}

		tests {
			test "one" {
				require #Value(first) = rows::firstItem()

				expect first::is(1)
			}
		}`)

		expect(summary).toMatchObject({ passed: 1, failed: 0 })
	})

	it("registers a skipped test with its reason and never runs it", async () => {
		let { events, summary } = await run(`implementation {}

		tests {
			test "one" skipped "waiting on the redesign" {
				expect false
			}
		}`)

		expect(summary).toMatchObject({ passed: 0, failed: 0, skipped: 1 })
		expect(
			events.find((event) => event.kind === "test-skip"),
		).toMatchObject({ reason: "waiting on the redesign" })
	})

	it("runs only the focused tests, and says the run had one", async () => {
		let { events, summary } = await run(`implementation {}

		tests {
			test "one" {
				expect true
			}

			test "two" focused {
				expect true
			}
		}`)

		expect(summary).toMatchObject({
			passed: 1,
			deselected: 1,
			focused: true,
		})
		expect(
			events.find((event) => event.kind === "test-deselected"),
		).toMatchObject({ reason: "not-focused" })
	})

	it("renders an interpolated name for the report", async () => {
		let { events } = await run(`implementation {}

		tests {
			constant scored = 2
			constant conceded = 0

			test "{scored}-{conceded} is a win" {
				expect true
			}
		}`)

		expect(
			events.find((event) => event.kind === "test-start"),
		).toMatchObject({
			id: "/{scored}-{conceded} is a win",
			name: "2-0 is a win",
		})
	})

	it("evaluates the setup afresh for every test", async () => {
		let { events } = await run(`implementation {}

		tests {
			§ Printing is the one thing in the setup that can SEE how often the
			§ setup ran — the values are immutable, so nothing else could tell.
			constant greeting = Terminal.print("setup")

			test "one" {
				expect true
			}

			test "two" {
				expect true
			}
		}`)

		expect(
			eventsOf(events, "output").map((event) =>
				event.kind === "output" ? event.id : "",
			),
		).toEqual(["/one", "/two"])
	})

	it("keeps a Constant nothing but a test reads", async () => {
		// NOTE: `eliminate-dead-code` decides what a Program READS, and a test
		// body is where the only read of `shipped` is. A pass that did not walk
		// the section would drop the Constant out from under the test that
		// names it, and the run below would be a `ReferenceError` rather than a
		// failure.
		let { summary } = await run(twoTests)

		expect(summary).toMatchObject({ passed: 2, failed: 0 })
	})

	it("asserts from inside a Match Handler of a test body", async () => {
		let { summary } = await run(`implementation {
			choice Outcome { Win, Draw, Loss }
		}

		tests {
			function pointsFor(_ outcome: Outcome) -> Integer {
				<- match outcome -> Integer {
					case #Win  { <- 3 }
					case #Draw { <- 1 }
					case #Loss { <- 0 }
				}
			}

			namespace Helper for Integer {
				static three() -> Integer {
					<- 3
				}
			}

			constant outcome: Outcome = #Win

			test "one" {
				match outcome -> {} {
					case #Win {
						expect pointsFor(outcome)::is(Helper.three())

						<- {}
					}
					case _ {
						expect false

						<- {}
					}
				}
			}
		}`)

		expect(summary).toMatchObject({ passed: 1, failed: 0 })
	})

	it("keeps what a test wrote to itself", async () => {
		let { events } = await run(`implementation {}

		tests {
			test "one" {
				Terminal.print("from the test")

				expect true
			}

			test "two" {
				expect true
			}
		}`)

		expect(eventsOf(events, "output")).toEqual([
			{
				schema: 1,
				kind: "output",
				id: "/one",
				stream: "output",
				text: "from the test\n",
			},
		])
	})
})

describe("Test codegen — a graph of Modules", () => {
	it("publishes one way in for every Module of the bundle", async () => {
		let directory = mkdtempSync(join(tmpdir(), "essence-graph-"))
		let implementation = join(directory, "Standings.es")
		let tests = join(directory, "Standings.tests.es")

		writeFileSync(
			implementation,
			`implementation {
				type Standing = { team: String, points: Integer }

				function leader() -> Standing {
					<- { team = "Lions", points = 19 }
				}
			}

			export {
				Standing
				leader
			}`,
		)
		writeFileSync(
			tests,
			`import {
				leader from "./Standings.es"
			}

			tests {
				test "the leader is the Lions" {
					expect leader().team::is("Lions")
				}
			}`,
		)

		let compiled = await compileToMemory(tests, { tests: true })

		expect(compiled.diagnostics).toEqual([])

		let { loaded, dispose } = await load(compiled.code, ".mjs")
		let events: Array<TestEvent> = []

		try {
			let summary = loaded.$tests.run(loaded.$tests.registry(), {
				sink: (event) => events.push(event),
				now: () => 0,
			})

			expect(summary).toMatchObject({ passed: 1, failed: 0 })
			expect(
				events.find((event) => event.kind === "test-start"),
			).toMatchObject({
				module: expect.stringContaining("Standings.tests.es"),
			})
		} finally {
			dispose()
			rmSync(directory, { recursive: true, force: true })
		}
	})

	it("names a test compile's bundle differently from a build's", async () => {
		let directory = mkdtempSync(join(tmpdir(), "essence-graph-"))
		let entry = join(directory, "Only.es")

		writeFileSync(
			entry,
			`implementation {
				constant shipped = 1
			}

			tests {
				test "one" {
					expect shipped::is(1)
				}
			}`,
		)

		try {
			let tested = await compileToMemory(entry, { tests: true })
			let built = await compileToMemory(entry)

			expect(tested.bundleHash).not.toBe(built.bundleHash)
			expect(built.code).not.toContain("$testing")
		} finally {
			rmSync(directory, { recursive: true, force: true })
		}
	})
})

describe("Test codegen — the Tests.es fixture", () => {
	it("runs end to end, focused test and all", async () => {
		let source = readFileSync(fixturePath("Tests.es"), "utf8")
		let { events, summary } = await run(source)

		// NOTE: The fixture writes one `focused` test, so a plain run of it
		// runs exactly that one and reports the rest as not focused — which is
		// the whole of what `focused` promises.
		expect(summary).toMatchObject({
			passed: 1,
			failed: 0,
			skipped: 1,
			deselected: 9,
			focused: true,
		})
		expect(
			events.find((event) => event.kind === "test-start"),
		).toMatchObject({
			id: "/Standing/outcomeOf/calls a lower score a loss",
			suitePath: ["Standing", "outcomeOf"],
		})
		expect(
			events.find((event) => event.kind === "test-skip"),
		).toMatchObject({ reason: "waiting on the Table redesign" })
	})

	it("runs every test in it once nothing is focused", async () => {
		let source = readFileSync(fixturePath("Tests.es"), "utf8")
		let { summary } = await run(source.replace(" focused {", " {"))

		expect(summary).toMatchObject({
			passed: 10,
			failed: 0,
			skipped: 1,
			deselected: 0,
			focused: false,
		})
	})
})

describe("Test codegen — value comments", () => {
	const probed = `implementation {
	function double(_ value: Integer) -> Integer {
		<- value::multiply(with 2)
	}
}

tests {
	constant setup = double(1) §? the setup

	test "answers a line" {
		constant doubled = double(21) §? what came out

		expect doubled::is(42)
	}
}`

	it("records a probed line into the buffer no assertion drains", () => {
		let emitted = registration(generate(probed))

		expect(emitted).toContain("$testing.probe($context,")
		expect(emitted).toContain("$testing.trace($context,")
	})

	it("emits nothing for a build", () => {
		expect(build(probed)).not.toContain("$testing.probe")
	})

	it("reports the value of the line, with the span of the Expression", async () => {
		let { events } = await run(probed)
		let probes = eventsOf(events, "probe")

		expect(probes).toHaveLength(2)
		expect(probes[0]).toMatchObject({
			kind: "probe",
			span: {
				start: { line: 8, column: 19 },
				end: { line: 8, column: 28 },
				source: "double(1)",
			},
			value: "2",
		})
		expect(probes[1]).toMatchObject({
			kind: "probe",
			span: { source: "double(21)" },
			value: "42",
		})
	})

	it("leaves the assertion's own values to the assertion", async () => {
		let { events } = await run(probed)
		let expectations = eventsOf(events, "expect")

		expect(expectations).toHaveLength(1)
		expect(expectations[0]).toMatchObject({ passed: true, values: [] })
	})

	it("answers a bare Expression Statement as well as a Declaration", async () => {
		let { events } = await run(`implementation {
	function double(_ value: Integer) -> Integer {
		<- value::multiply(with 2)
	}
}

tests {
	test "answers an Expression" {
		double(3) §?

		expect true
	}
}`)

		expect(eventsOf(events, "probe")[0]).toMatchObject({
			value: "6",
			span: { source: "double(3)" },
		})
	})

	it("answers a line inside a conditional with the turn that ran", async () => {
		let { events } = await run(`implementation {
	function double(_ value: Integer) -> Integer {
		<- value::multiply(with 2)
	}
}

tests {
	test "answers a nested line" {
		if true {
			constant nested = double(5) §?

			expect nested::is(10)
		} else {
			constant other = double(6) §?

			expect other::is(12)
		}
	}
}`)
		let probes = eventsOf(events, "probe")

		expect(probes).toHaveLength(1)
		expect(probes[0]).toMatchObject({ value: "10" })
	})

	it("hands one point out per line, however the line was desugared", async () => {
		let { events } = await run(`implementation {
	constant lions = { team = "Lions", points = 19 }
}

tests {
	test "answers a matched line" {
		require { points = 19 } = lions §?

		expect true
	}
}`)

		expect(eventsOf(events, "probe")).toHaveLength(1)
	})

	it("says nothing about a `§?` written inside a String", async () => {
		let { events } = await run(`tests {
	constant text = "§? not a comment"

	test "writes a value comment" {
		expect text::is("§? not a comment")
	}
}`)

		expect(eventsOf(events, "probe")).toHaveLength(0)
	})

	it("answers every Constant a test body wrote, asked or not", async () => {
		let { events } = await run(`implementation {
	function double(_ value: Integer) -> Integer {
		<- value::multiply(with 2)
	}
}

tests {
	constant setup = double(1)

	test "answers its own Constants" {
		constant first = double(2)
		constant second = double(first)

		expect second::is(8)
	}
}`)

		expect(
			eventsOf(events, "probe").map((event) =>
				event.kind === "probe" ? [event.span?.source, event.value] : [],
			),
		).toEqual([
			["double(2)", "4"],
			["double(first)", "8"],
		])
	})

	it("emits one call for a whole table and one entry per row", async () => {
		let emitted = registration(generate(tableTest))

		expect(emitted).toContain("$testing.rows($context, 0, [")
		expect(emitted.match(/\$testing\.rows\(/g)).toHaveLength(1)
		expect(emitted).toContain('id: "/{n} doubled/0"')
		expect(emitted).toContain('id: "/{n} doubled/2"')
		expect(emitted).not.toContain('id: "/{n} doubled/3"')
	})

	it("runs the body once per row, under the name that row renders", async () => {
		let { events, summary } = await run(tableTest)

		expect(summary.passed).toBe(2)
		expect(summary.failed).toBe(1)
		expect(
			eventsOf(events, "test-start").map((event) =>
				event.kind === "test-start"
					? [event.name, event.suitePath]
					: [],
			),
		).toEqual([
			["1 doubled", ["{n} doubled"]],
			["2 doubled", ["{n} doubled"]],
			["3 doubled", ["{n} doubled"]],
		])
	})

	// NOTE: A row that is not the one running costs nothing but its own value —
	// the body is one closure, and the name is worked out for the row being
	// enumerated or run.
	it("evaluates one row's body per test", async () => {
		let { events } = await run(`implementation {
	function twice(_ n: Integer) -> Integer {
		<- n::multiply(with 2)
	}
}

tests {
	test "{n} doubled" across [1, 2, 3] (n: Integer) {
		Terminal.print("ran {n}")

		expect twice(n)::isGreaterThan(0)
	}
}`)

		expect(
			eventsOf(events, "output").map((event) =>
				event.kind === "output" ? event.text : "",
			),
		).toEqual(["ran 1\n", "ran 2\n", "ran 3\n"])
	})

	it("selects a row by its own id", async () => {
		let { events } = await run(tableTest, { ids: ["/{n} doubled/1"] })

		expect(
			eventsOf(events, "test-start").map((event) =>
				event.kind === "test-start" ? event.name : "",
			),
		).toEqual(["2 doubled"])
	})

	it("leaves the Constant a Matcher's assertion synthesized alone", async () => {
		let { events } = await run(`implementation {
	constant lions = { team = "Lions", points = 19 }
}

tests {
	test "matches" {
		require { points = 19 } = lions
	}
}`)

		expect(eventsOf(events, "probe")).toHaveLength(0)
	})
})
