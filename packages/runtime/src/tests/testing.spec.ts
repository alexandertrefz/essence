import { describe, expect, test } from "bun:test"

import { createBoolean } from "../Boolean"
import { createInteger } from "../Integer"
import { createList } from "../List"
import { createRecord } from "../Record"
import type { StreamType } from "../Stream"
import { createString } from "../String"
import { inspect, write, withOutputSink } from "../Terminal"
import {
	beginCoverageRun,
	benchmark,
	benchmarkRows,
	coverage,
	counters,
	createContext,
	entry,
	expected,
	probe,
	randomSeed,
	type Range,
	registryOf,
	required,
	runTests,
	selectTests,
	type Span,
	structuralDiff,
	type TestContext,
	type TestEvent,
	type TestManifestEntry,
	type TestModule,
	trace,
} from "../Testing"
import { type AnyType, createCase } from "../type"

// NOTE: The test runtime, asked the way the emitted JavaScript asks it. Nothing
// here compiles anything — a Module's manifest is plain data and its `run` is a
// Function of the context, so the whole of what a compiled `tests` section IS
// can be written out by hand and driven exactly as one.

const integer = (value: number) => createInteger(BigInt(value))
const string = (value: string) => createString(value)

// NOTE: A Case value is deliberately not part of `AnyType` — its `[typeKey]:
// string` would defeat the tag narrowing every runtime helper rests on — so a
// spec that hands one to a helper says so here rather than at every site.
const caseValue = (tag: string, payload?: Record<string, AnyType>): AnyType =>
	createCase(tag, payload) as unknown as AnyType

const outputStream = caseValue("Stream#Output") as unknown as StreamType

const nowhere: Range = {
	start: { line: 1, column: 1 },
	end: { line: 1, column: 1 },
}

function span(source: string): Span {
	return { ...nowhere, source }
}

function manifest(
	id: string,
	overrides: Partial<TestManifestEntry> = {},
): TestManifestEntry {
	return {
		id,
		name: id,
		interpolated: false,
		row: null,
		suitePath: [],
		tags: [],
		focused: false,
		skipped: null,
		benchmark: false,
		position: nowhere,
		keywordPosition: nowhere,
		...overrides,
	}
}

function module(
	tests: Array<TestManifestEntry>,
	run: (context: TestContext) => void,
	spans: Array<Span> = [],
): TestModule {
	return { module: "/Season.es", spans, tests, run }
}

function collect(registry: ReturnType<typeof registryOf>): {
	events: Array<TestEvent>
	summary: ReturnType<typeof runTests>
} {
	let events: Array<TestEvent> = []
	let summary = runTests(registry, {
		sink: (event) => events.push(event),
		now: () => 0,
	})

	return { events, summary }
}

function kinds(events: Array<TestEvent>): Array<string> {
	return events.map((event) => event.kind)
}

describe("The test registry", () => {
	test("indexes every Module's tests by structural id", () => {
		let first = module([manifest("/a"), manifest("/b")], () => {})
		let second = module([manifest("/c")], () => {})
		let registry = registryOf([first, second])

		expect(registry.tests.map((entry) => entry.entry.id)).toEqual([
			"/a",
			"/b",
			"/c",
		])
		expect(registry.byId.get("/b")?.index).toBe(1)
		expect(registry.byId.get("/c")?.index).toBe(0)
		expect(registry.byId.get("/c")?.module).toBe(second)
	})

	test("answers with no test where nothing registered", () => {
		expect(registryOf([]).tests).toEqual([])
	})
})

describe("The per-test context", () => {
	test("runs only the entry its index names", () => {
		let ran: Array<number> = []
		let context = createContext(1)

		entry(context, 0, null, () => ran.push(0))
		entry(context, 1, null, () => ran.push(1))
		entry(context, 2, null, () => ran.push(2))

		expect(ran).toEqual([1])
	})

	test("records an interpolated name whether or not the test runs", () => {
		let context = createContext(-1)

		entry(context, 0, string("2–0 is a win"), () => {})
		entry(context, 1, null, () => {})

		expect(context.names.get(0)).toBe("2–0 is a win")
		expect(context.names.has(1)).toBe(false)
	})

	test("answers with the very value it traced", () => {
		let context = createContext(0)
		let value = integer(19)

		expect(trace(context, 3, value)).toBe(value)
		expect(context.traces).toEqual([{ point: 3, value }])
	})

	test("drains the trace buffer into the assertion that evaluated it", () => {
		let context = createContext(0)

		trace(context, 1, integer(19))
		trace(context, 2, integer(16))
		expected(context, 0, false, null)
		trace(context, 4, integer(3))
		expected(context, 3, true, null)

		expect(context.traces).toEqual([])
		expect(
			context.expectations.map((expectation) =>
				expectation.traces.map((entry) => entry.point),
			),
		).toEqual([[1, 2], [4]])
	})

	test("resolves a comparison's operands out of the traces", () => {
		let context = createContext(0)
		let left = integer(3)
		let right = integer(2)

		trace(context, 1, left)
		trace(context, 2, right)
		expected(context, 0, false, { kind: "is", left: 1, right: 2 })

		expect(context.expectations[0]?.comparison).toEqual({
			kind: "is",
			left,
			right,
		})
	})

	test("lets the test carry on past a require that held", () => {
		let context = createContext(0)

		required(context, 0, true, null)

		expect(
			context.expectations.map((expectation) => expectation.form),
		).toEqual(["require"])
	})

	test("unwinds the test at a require that did not hold", () => {
		let context = createContext(0)
		let ended = false

		try {
			required(context, 0, false, null)
		} catch {
			ended = true
		}

		expect(ended).toBe(true)
		expect(context.expectations[0]).toMatchObject({
			form: "require",
			passed: false,
		})
	})

	test("keeps a probed value out of the assertion that followed it", () => {
		let context = createContext(0)
		let value = integer(19)

		expect(probe(context, 5, value)).toBe(value)
		expected(context, 0, true, null)

		expect(context.probes).toEqual([{ point: 5, value }])
		expect(context.expectations[0]?.traces).toEqual([])
	})
})

describe("The structural diff", () => {
	test("says nothing about two equal values", () => {
		expect(structuralDiff(integer(1), integer(1))).toEqual([])
	})

	test("says nothing where an operand was never recorded", () => {
		expect(structuralDiff(undefined, integer(1))).toEqual([])
	})

	test("renders two scalars as the pair they are", () => {
		expect(structuralDiff(integer(3), integer(2))).toEqual([
			{ kind: "left", text: "3" },
			{ kind: "right", text: "2" },
		])
	})

	test("walks a Record member by member", () => {
		let left = createRecord({ team: string("Lions"), points: integer(19) })
		let right = createRecord({ team: string("Lions"), points: integer(16) })

		expect(structuralDiff(left, right)).toEqual([
			{ kind: "same", text: "{" },
			{ kind: "same", text: '    team = "Lions",' },
			{ kind: "left", text: "    points = 19," },
			{ kind: "right", text: "    points = 16," },
			{ kind: "same", text: "}" },
		])
	})

	test("names a member only one of them has", () => {
		let left = createRecord({ team: string("Lions") })
		let right = createRecord({ points: integer(16) })

		expect(structuralDiff(left, right)).toEqual([
			{ kind: "same", text: "{" },
			{ kind: "left", text: '    team = "Lions",' },
			{ kind: "right", text: "    points = 16," },
			{ kind: "same", text: "}" },
		])
	})

	test("walks a List index by index", () => {
		let left = createList([integer(1), integer(2)])
		let right = createList([integer(1), integer(3)])

		expect(structuralDiff(left, right)).toEqual([
			{ kind: "same", text: "[" },
			{ kind: "same", text: "    1," },
			{ kind: "left", text: "    2," },
			{ kind: "right", text: "    3," },
			{ kind: "same", text: "]" },
		])
	})

	test("walks the payload of two Cases carrying the same tag", () => {
		let left = caseValue("Optional#Value", { item: integer(1) })
		let right = caseValue("Optional#Value", { item: integer(2) })

		expect(structuralDiff(left, right)).toEqual([
			{ kind: "same", text: "Optional#Value {" },
			{ kind: "left", text: "    item = 1," },
			{ kind: "right", text: "    item = 2," },
			{ kind: "same", text: "}" },
		])
	})

	test("reads two differing tags as the pair they are", () => {
		let left = caseValue("Optional#Value", { item: integer(1) })
		let right = caseValue("Optional#Empty")

		expect(structuralDiff(left, right)).toEqual([
			{ kind: "left", text: "Optional#Value(1)" },
			{ kind: "right", text: "Optional#Empty" },
		])
	})

	test("descends into a nested Record", () => {
		let left = createRecord({
			home: createRecord({ team: string("Lions"), goals: integer(2) }),
		})
		let right = createRecord({
			home: createRecord({ team: string("Lions"), goals: integer(1) }),
		})

		expect(structuralDiff(left, right)).toEqual([
			{ kind: "same", text: "{" },
			{ kind: "same", text: "    home = {" },
			{ kind: "same", text: '        team = "Lions",' },
			{ kind: "left", text: "        goals = 2," },
			{ kind: "right", text: "        goals = 1," },
			{ kind: "same", text: "    }," },
			{ kind: "same", text: "}" },
		])
	})
})

describe("Selection", () => {
	test("runs everything where nothing is focused or tagged", () => {
		let registry = registryOf([
			module([manifest("/a"), manifest("/b")], () => {}),
		])
		let { selections, focused } = selectTests(registry)

		expect(focused).toBe(false)
		expect(selections.map((selection) => selection.state)).toEqual([
			"run",
			"run",
		])
	})

	test("runs only the focused tests while one exists", () => {
		let registry = registryOf([
			module(
				[manifest("/a"), manifest("/b", { focused: true })],
				() => {},
			),
		])
		let { selections, focused } = selectTests(registry)

		expect(focused).toBe(true)
		expect(selections[0]).toEqual({
			test: registry.tests[0]!,
			state: "deselected",
			reason: "not-focused",
		})
		expect(selections[1]?.state).toBe("run")
	})

	test("reports a skipped test with its reason before anything else", () => {
		let registry = registryOf([
			module(
				[
					manifest("/a", { skipped: "waiting on the redesign" }),
					manifest("/b", { focused: true }),
				],
				() => {},
			),
		])
		let { selections } = selectTests(registry)

		expect(selections[0]).toEqual({
			test: registry.tests[0]!,
			state: "skip",
			reason: "waiting on the redesign",
		})
	})

	test("does not count a skipped test as a focused one", () => {
		let registry = registryOf([
			module(
				[
					manifest("/a"),
					manifest("/b", { focused: true, skipped: "later" }),
				],
				() => {},
			),
		])

		expect(selectTests(registry).focused).toBe(false)
	})

	test("selects by tag, and lets a skipped tag win over a named one", () => {
		let registry = registryOf([
			module(
				[
					manifest("/a", { tags: ["slow"] }),
					manifest("/b", { tags: ["slow", "network"] }),
					manifest("/c", { tags: ["fast"] }),
				],
				() => {},
			),
		])
		let { selections } = selectTests(registry, {
			tags: ["slow"],
			skipTags: ["network"],
		})

		expect(
			selections.map((selection) =>
				selection.state === "deselected"
					? selection.reason
					: selection.state,
			),
		).toEqual(["run", "tag", "tag"])
	})

	// NOTE: What a reader types is what a reader SAW, and what a reader saw is
	// the rendered name — a row of a table test, or a name with a hole in it.
	// The template still matches, so a filter written against the source works
	// as well.
	test("filters on the name a run renders", () => {
		let registry = registryOf([
			module(
				[
					manifest("/a", {
						name: "{scored}–{conceded} is a win",
						interpolated: true,
					}),
					manifest("/b"),
				],
				(context) => {
					entry(context, 0, string("2–0 is a win"), () => {})
				},
			),
		])
		let rendered = selectTests(registry, { filter: "2–0" })
		let template = selectTests(registry, { filter: "{scored}" })
		let neither = selectTests(registry, { filter: "3–1" })

		expect(rendered.selections[0]?.state).toBe("run")
		expect(rendered.matched).toBe(1)
		expect(template.selections[0]?.state).toBe("run")
		expect(neither.selections[0]?.state).toBe("deselected")
		expect(neither.matched).toBe(0)
	})

	test("filters on the name template", () => {
		let registry = registryOf([
			module(
				[manifest("/a", { name: "the leader" }), manifest("/b")],
				() => {},
			),
		])
		let { selections } = selectTests(registry, { filter: "leader" })

		expect(
			selections.map((selection) =>
				selection.state === "deselected"
					? selection.reason
					: selection.state,
			),
		).toEqual(["run", "filter"])
	})
})

describe("The event stream", () => {
	test("brackets a passing run with run-start and run-end", () => {
		let registry = registryOf([
			module([manifest("/a")], (context) => {
				entry(context, 0, null, () => {
					expected(context, 0, true, null)
				})
			}),
		])
		let { events, summary } = collect(registry)

		expect(kinds(events)).toEqual([
			"run-start",
			"test-start",
			"expect",
			"test-pass",
			"run-end",
		])
		expect(events[0]).toEqual({
			schema: 1,
			kind: "run-start",
			tests: 1,
			focused: false,
		})
		expect(summary).toEqual({
			passed: 1,
			failed: 0,
			skipped: 0,
			deselected: 0,
			duration: 0,
			focused: false,
			failedIds: [],
		})
	})

	test("reports one probe per point, with the last value it held", () => {
		let registry = registryOf([
			module(
				[manifest("/a")],
				(context) => {
					entry(context, 0, null, () => {
						probe(context, 0, integer(1))
						probe(context, 0, integer(2))
						probe(context, 1, string("last"))
						expected(context, 2, true, null)
					})
				},
				[span("count"), span("word"), span("expect")],
			),
		])
		let { events } = collect(registry)
		let probes = events.filter((event) => event.kind === "probe")

		expect(probes).toEqual([
			{
				schema: 1,
				kind: "probe",
				id: "/a",
				point: 0,
				span: span("count"),
				value: "2",
			},
			{
				schema: 1,
				kind: "probe",
				id: "/a",
				point: 1,
				span: span("word"),
				value: '"last"',
			},
		])
	})

	test("reports a probe of a test that failed as well", () => {
		let registry = registryOf([
			module(
				[manifest("/a")],
				(context) => {
					entry(context, 0, null, () => {
						probe(context, 0, integer(7))
						expected(context, 1, false, null)
					})
				},
				[span("seven"), span("expect")],
			),
		])
		let { events } = collect(registry)

		expect(kinds(events)).toEqual([
			"run-start",
			"test-start",
			"probe",
			"expect",
			"test-fail",
			"run-end",
		])
	})

	test("stamps every event with the schema version", () => {
		let registry = registryOf([
			module([manifest("/a")], (context) => {
				entry(context, 0, null, () => expected(context, 0, true, null))
			}),
		])

		for (let event of collect(registry).events) {
			expect(event.schema).toBe(1)
		}
	})

	test("carries a failure's values and span, resolved against the table", () => {
		let registry = registryOf([
			module(
				[manifest("/a")],
				(context) => {
					entry(context, 0, null, () => {
						trace(context, 1, integer(19))
						expected(context, 0, false, null)
					})
				},
				[span("leader.points::is(2)"), span("leader.points")],
			),
		])
		let { events, summary } = collect(registry)
		let failure = events.find((event) => event.kind === "test-fail")

		expect(summary.failed).toBe(1)
		expect(summary.failedIds).toEqual(["/a"])
		expect(failure).toMatchObject({
			id: "/a",
			expectations: 1,
			error: null,
			failures: [
				{
					form: "expect",
					span: { source: "leader.points::is(2)" },
					values: [
						{
							point: 1,
							span: { source: "leader.points" },
							value: "19",
						},
					],
					comparison: null,
				},
			],
		})
	})

	test("renders no value for an assertion that held", () => {
		let registry = registryOf([
			module(
				[manifest("/a")],
				(context) => {
					entry(context, 0, null, () => {
						trace(context, 1, integer(19))
						expected(context, 0, true, null)
					})
				},
				[span("leader.points::is(19)"), span("leader.points")],
			),
		])
		let recorded = collect(registry).events.find(
			(event) => event.kind === "expect",
		)

		expect(recorded).toMatchObject({ passed: true, values: [] })
	})

	test("diffs the two operands of a failed comparison", () => {
		let registry = registryOf([
			module(
				[manifest("/a")],
				(context) => {
					entry(context, 0, null, () => {
						trace(context, 1, integer(3))
						trace(context, 2, integer(2))
						expected(context, 0, false, {
							kind: "is",
							left: 1,
							right: 2,
						})
					})
				},
				[span("a::is(b)"), span("a"), span("b")],
			),
		])
		let recorded = collect(registry).events.find(
			(event) => event.kind === "expect",
		)

		expect(recorded).toMatchObject({
			comparison: {
				kind: "is",
				left: "3",
				right: "2",
				diff: [
					{ kind: "left", text: "3" },
					{ kind: "right", text: "2" },
				],
			},
		})
	})

	test("reports a skipped test with its reason and runs nothing", () => {
		let ran = false
		let registry = registryOf([
			module([manifest("/a", { skipped: "not yet" })], (context) => {
				entry(context, 0, null, () => {
					ran = true
				})
			}),
		])
		let { events, summary } = collect(registry)

		expect(ran).toBe(false)
		expect(summary.skipped).toBe(1)
		expect(events.find((event) => event.kind === "test-skip")).toEqual({
			schema: 1,
			kind: "test-skip",
			row: null,
			id: "/a",
			name: "/a",
			suitePath: [],
			module: "/Season.es",
			reason: "not yet",
		})
	})

	test("counts a deselected test rather than failing it", () => {
		let registry = registryOf([
			module([manifest("/a", { tags: ["slow"] })], () => {}),
		])
		let events: Array<TestEvent> = []
		let summary = runTests(registry, {
			sink: (event) => events.push(event),
			now: () => 0,
			filters: { skipTags: ["slow"] },
		})

		expect(summary).toMatchObject({ passed: 0, failed: 0, deselected: 1 })
		expect(
			events.find((event) => event.kind === "test-deselected"),
		).toEqual({
			schema: 1,
			kind: "test-deselected",
			row: null,
			id: "/a",
			name: "/a",
			suitePath: [],
			module: "/Season.es",
			reason: "tag",
		})
	})

	test("fails a test whose body threw, and says what threw", () => {
		let registry = registryOf([
			module([manifest("/a")], (context) => {
				entry(context, 0, null, () => {
					throw new Error("no such row")
				})
			}),
		])
		let { events, summary } = collect(registry)
		let failure = events.find((event) => event.kind === "test-fail")

		expect(summary.failed).toBe(1)
		expect(failure?.kind === "test-fail" ? failure.error : null).toContain(
			"no such row",
		)
	})

	test("ends a test at a failed require without calling it an error", () => {
		let reached = false
		let registry = registryOf([
			module([manifest("/a")], (context) => {
				entry(context, 0, null, () => {
					// NOTE: The arrow stands for the one shape an early return
					// could not have ended — a `match` used as an Expression,
					// emitted as a call to a Function of its own.
					;(() => {
						required(context, 0, false, null)
					})()

					reached = true
				})
			}),
		])
		let { events, summary } = collect(registry)
		let failure = events.find((event) => event.kind === "test-fail")

		expect(reached).toBe(false)
		expect(summary.failed).toBe(1)
		expect(failure).toMatchObject({ error: null })
		expect(
			failure?.kind === "test-fail" ? failure.failures : [],
		).toHaveLength(1)
	})

	test("renders an interpolated name from the enumeration pass", () => {
		let registry = registryOf([
			module(
				[
					manifest("/a", {
						name: "{scored}–{conceded} is a win",
						interpolated: true,
					}),
				],
				(context) => {
					entry(context, 0, string("2–0 is a win"), () => {
						expected(context, 0, true, null)
					})
				},
			),
		])
		let started = collect(registry).events.find(
			(event) => event.kind === "test-start",
		)

		expect(started).toMatchObject({ name: "2–0 is a win" })
	})

	// NOTE: A brace is an ordinary character in a plain name, and a run that
	// read one as a hole would evaluate the whole section once for nothing.
	test("does not enumerate a Module whose names only look interpolated", () => {
		let evaluations = 0
		let registry = registryOf([
			module(
				[manifest("/a", { name: "handles { braces" })],
				(context) => {
					evaluations += 1
					entry(context, 0, null, () => {
						expected(context, 0, true, null)
					})
				},
			),
		])
		let started = collect(registry).events.find(
			(event) => event.kind === "test-start",
		)

		expect(evaluations).toBe(1)
		expect(started).toMatchObject({ name: "handles { braces" })
	})

	test("keeps a test's output to that test", () => {
		let registry = registryOf([
			module([manifest("/a"), manifest("/b")], (context) => {
				entry(context, 0, null, () => {
					context.output.push({ stream: "output", text: "first\n" })
				})
				entry(context, 1, null, () => {
					context.output.push({ stream: "error", text: "second\n" })
				})
			}),
		])
		let output = collect(registry).events.filter(
			(event) => event.kind === "output",
		)

		expect(output).toEqual([
			{
				schema: 1,
				kind: "output",
				id: "/a",
				stream: "output",
				text: "first\n",
			},
			{
				schema: 1,
				kind: "output",
				id: "/b",
				stream: "error",
				text: "second\n",
			},
		])
	})
})

// NOTE: A clock that ticks with the WORK rather than with the wall: a fixed
// number of milliseconds per run of the body, and nothing at all between two
// runs. What comes out of a measurement read off it is exactly what the
// arithmetic says, so every assertion below is about the RUNNER — a spec that
// timed a real body would be asserting something about this machine today.
function workClock(milliseconds: number): {
	clock: () => number
	tick: () => void
} {
	let now = 0

	return {
		clock: () => now,
		tick: () => {
			now += milliseconds
		},
	}
}

type BenchmarkEvent = Extract<TestEvent, { kind: "benchmark" }>

function measure(
	registry: ReturnType<typeof registryOf>,
	options: {
		clock: () => number
		filters?: Parameters<typeof runTests>[1]["filters"]
		benchmarks?: Parameters<typeof runTests>[1]["benchmarks"]
		update?: boolean
	},
): {
	events: Array<TestEvent>
	measured: Array<BenchmarkEvent>
	summary: ReturnType<typeof runTests>
} {
	let events: Array<TestEvent> = []
	let summary = runTests(registry, {
		sink: (event) => events.push(event),
		now: () => 0,
		clock: options.clock,
		filters: options.filters,
		benchmarks: options.benchmarks,
		update: options.update,
	})

	return {
		events,
		measured: events.filter(
			(event): event is BenchmarkEvent => event.kind === "benchmark",
		),
		summary,
	}
}

// NOTE: One Module holding one benchmark whose body costs the clock one tick.
// The calibration doubles until a batch takes five milliseconds, which is eight
// runs of a one-millisecond body — so a measurement of it is one million
// nanoseconds, every time, on every machine.
function benchmarkModule(
	tick: () => void,
	overrides: Partial<TestManifestEntry> = {},
): TestModule {
	return module(
		[manifest("/bench", { benchmark: true, ...overrides })],
		(context) => {
			benchmark(context, 0, null, "doubling", () => {
				tick()
				expected(context, 0, true, null)
			})
		},
	)
}

describe("Benchmarks", () => {
	test("is left out of a run that did not ask to measure", () => {
		let { clock } = workClock(1)
		let registry = registryOf([
			module(
				[manifest("/a"), manifest("/bench", { benchmark: true })],
				() => {},
			),
		])
		let { selections } = selectTests(registry)

		expect(selections[0]?.state).toBe("run")
		expect(selections[1]).toEqual({
			test: registry.tests[1]!,
			state: "deselected",
			reason: "bench",
		})
		expect(measure(registry, { clock }).measured).toEqual([])
	})

	test("measures it where the run asked, and keeps running the tests", () => {
		let { clock, tick } = workClock(1)
		let registry = registryOf([
			benchmarkModule(tick),
			module([manifest("/a")], (context) => {
				entry(context, 0, null, () => {
					expected(context, 0, true, null)
				})
			}),
		])
		let { measured, summary } = measure(registry, {
			clock,
			filters: { bench: true },
		})

		expect(measured).toHaveLength(1)
		expect(summary.passed).toBe(2)
		expect(summary.deselected).toBe(0)
	})

	// NOTE: The one door a measurement has without a flag. An Editor's "run this
	// one" names a test by its id, and naming a benchmark is asking for it.
	test("measures one somebody named, whatever the run asked for", () => {
		let { clock, tick } = workClock(1)
		let registry = registryOf([benchmarkModule(tick)])
		let { measured } = measure(registry, {
			clock,
			filters: { ids: ["/bench"] },
		})

		expect(measured.map((event) => event.status)).toEqual(["written"])
	})

	test("calibrates a batch and answers with the time of one run", () => {
		let { clock, tick } = workClock(1)
		let { measured } = measure(registryOf([benchmarkModule(tick)]), {
			clock,
			filters: { bench: true },
		})

		expect(measured[0]).toEqual({
			schema: 1,
			kind: "benchmark",
			id: "/bench",
			name: "/bench",
			module: "/Season.es",
			key: "doubling",
			nanoseconds: 1_000_000,
			iterations: 8,
			samples: 7,
			baseline: null,
			ratio: null,
			status: "written",
		})
	})

	test("records a measurement nothing had a baseline for", () => {
		let { clock, tick } = workClock(1)
		let { measured, summary } = measure(
			registryOf([benchmarkModule(tick)]),
			{ clock, filters: { bench: true } },
		)

		expect(measured[0]?.status).toBe("written")
		expect(summary.failed).toBe(0)
	})

	test("fails a measurement that ran away from its baseline", () => {
		let { clock, tick } = workClock(1)
		let { events, measured, summary } = measure(
			registryOf([benchmarkModule(tick)]),
			{
				clock,
				filters: { bench: true },
				benchmarks: { "/Season.es": { doubling: 500_000 } },
			},
		)

		expect(measured[0]).toMatchObject({
			status: "regressed",
			baseline: 500_000,
			ratio: 2,
		})
		expect(summary.failed).toBe(1)
		expect(summary.failedIds).toEqual(["/bench"])
		expect(
			events.find((event) => event.kind === "test-fail"),
		).toMatchObject({ failures: [], error: null })
	})

	// NOTE: Faster is news rather than a problem, and the baseline stands until
	// somebody says to move it — a run that quietly recorded every improvement
	// would ratchet a benchmark down to whatever the fastest machine reached.
	test("passes a measurement that got faster, and says so", () => {
		let { clock, tick } = workClock(1)
		let { measured, summary } = measure(
			registryOf([benchmarkModule(tick)]),
			{
				clock,
				filters: { bench: true },
				benchmarks: { "/Season.es": { doubling: 2_000_000 } },
			},
		)

		expect(measured[0]).toMatchObject({ status: "improved", ratio: 0.5 })
		expect(summary.passed).toBe(1)
		expect(summary.failed).toBe(0)
	})

	test("says nothing about a measurement inside its band", () => {
		let { clock, tick } = workClock(1)
		let { measured, summary } = measure(
			registryOf([benchmarkModule(tick)]),
			{
				clock,
				filters: { bench: true },
				benchmarks: { "/Season.es": { doubling: 900_000 } },
			},
		)

		expect(measured[0]?.status).toBe("matched")
		expect(summary.passed).toBe(1)
	})

	test("records a measurement outside its band where it was told to", () => {
		let { clock, tick } = workClock(1)
		let { measured, summary } = measure(
			registryOf([benchmarkModule(tick)]),
			{
				clock,
				filters: { bench: true },
				benchmarks: { "/Season.es": { doubling: 500_000 } },
				update: true,
			},
		)

		expect(measured[0]).toMatchObject({ status: "written", ratio: 2 })
		expect(summary.failed).toBe(0)
	})

	// NOTE: Timing something that is wrong measures the wrong thing, and the
	// number would go into a baseline as if it meant something. The body runs
	// exactly twice: once to be judged, and once to leave the recordings the
	// report is built from.
	test("reports a body that did not hold, and never times it", () => {
		let { clock } = workClock(1)
		let ran = 0
		let registry = registryOf([
			module([manifest("/bench", { benchmark: true })], (context) => {
				benchmark(context, 0, null, "doubling", () => {
					ran += 1
					expected(context, 0, false, null)
				})
			}),
		])
		let { events, measured, summary } = measure(registry, {
			clock,
			filters: { bench: true },
		})

		expect(measured).toEqual([])
		expect(ran).toBe(2)
		expect(summary.failed).toBe(1)
		expect(events.filter((event) => event.kind === "expect")).toHaveLength(
			1,
		)
	})

	// NOTE: A focus left on a benchmark silences nothing while the run is not
	// measuring — it would otherwise take a whole project's tests away over
	// something that was never going to run.
	test("does not silence the tests with a focus nobody is running", () => {
		let registry = registryOf([
			module(
				[
					manifest("/a"),
					manifest("/bench", { benchmark: true, focused: true }),
				],
				() => {},
			),
		])
		let plain = selectTests(registry)
		let measuring = selectTests(registry, { bench: true })

		expect(plain.focused).toBe(false)
		expect(plain.selections.map((selection) => selection.state)).toEqual([
			"run",
			"deselected",
		])
		expect(measuring.focused).toBe(true)
		expect(
			measuring.selections.map((selection) => selection.state),
		).toEqual(["deselected", "run"])
	})

	// NOTE: Every row is a benchmark in its own right, held to a baseline of its
	// own — the rows share one body and one key, so an entry they overwrote in
	// turn could only ever match the last row that ran.
	test("keeps one stored entry per row of a table benchmark", () => {
		let { clock, tick } = workClock(1)
		let registry = registryOf([
			module(
				[
					manifest("/rows/0", { benchmark: true, row: 0 }),
					manifest("/rows/1", { benchmark: true, row: 1 }),
				],
				(context) => {
					benchmarkRows(
						context,
						0,
						[integer(1), integer(2)],
						null,
						"sorts {size} rows",
						() => {
							tick()
							expected(context, 0, true, null)
						},
					)
				},
			),
		])
		let { measured } = measure(registry, {
			clock,
			filters: { bench: true },
			benchmarks: {
				"/Season.es": { "sorts {size} rows [1]": 500_000 },
			},
		})

		expect(measured.map((event) => [event.key, event.status])).toEqual([
			["sorts {size} rows [0]", "written"],
			["sorts {size} rows [1]", "regressed"],
		])
	})
})

// NOTE: The counters as the emitted JavaScript uses them: one call per Module
// answering a Function, and that Function called wherever control arrives.
// Nothing here compiles anything — a coverage table is plain data.
describe("The coverage counters", () => {
	const point = (line: number, overrides = {}) => ({
		kind: "statement" as const,
		label: "",
		scope: "",
		position: {
			start: { line, column: 1 },
			end: { line, column: 9 },
		},
		refinement: false,
		tag: null,
		...overrides,
	})

	test("counts a point every time control arrives at it", () => {
		let count = counters({
			module: "/Counted.es",
			points: [point(1), point(2)],
			choices: [],
		})

		count(0)
		count(0)
		count(1)

		let report = coverage().find((each) => each.module === "/Counted.es")

		expect(report?.points.map((each) => each.count)).toEqual([2, 1])
	})

	test("answers with the very value it was handed", () => {
		let count = counters({
			module: "/Answering.es",
			points: [point(1, { kind: "construction", tag: "Colour#Red" })],
			choices: [],
		})
		let value = integer(7)

		expect(count(0, value)).toBe(value)
	})

	test("is queryable from a running test's context", () => {
		let count = counters({
			module: "/Asked.es",
			points: [point(1)],
			choices: [],
		})
		// NOTE: A holder rather than a bare binding, so that TypeScript does
		// not narrow it to what it was initialised with — the write happens
		// inside a closure it does not follow.
		let seen: { count: number | undefined } = { count: undefined }
		let one = module([manifest("/asks")], (context) => {
			entry(context, 0, null, () => {
				count(0)
				seen.count = context
					.coverage()
					.find(
						(each) => each.module === "/Asked.es",
					)?.points[0]?.count
			})
		})

		runTests(registryOf([one]), { sink: () => {}, now: () => 0 })

		// NOTE: Asked from INSIDE the test, while it is running — coverage is
		// not a thing that is only dumped when everything is over.
		expect(seen.count).toBe(1)
	})

	test("writes a coverage event per Module, only where it was asked", () => {
		counters({
			module: "/Reported.es",
			points: [point(1)],
			choices: [
				{ name: "Colour", cases: ["Colour#Red"], position: nowhere },
			],
		})

		let one = module([manifest("/a")], (context) => {
			entry(context, 0, null, () => {})
		})
		let silent: Array<TestEvent> = []
		let loud: Array<TestEvent> = []

		runTests(registryOf([one]), {
			sink: (event) => silent.push(event),
			now: () => 0,
		})
		runTests(registryOf([one]), {
			sink: (event) => loud.push(event),
			now: () => 0,
			coverage: true,
		})

		expect(kinds(silent)).not.toContain("coverage")

		let reported = loud.filter((event) => event.kind === "coverage")

		expect(reported.length).toBeGreaterThan(0)
		expect(reported.some((event) => event.module === "/Reported.es")).toBe(
			true,
		)
		// NOTE: Before the run is declared over, so a consumer folding the
		// stream has every Module's counts in hand by then.
		expect(kinds(loud).indexOf("coverage")).toBeLessThan(
			kinds(loud).indexOf("run-end"),
		)
	})

	test("starts a second run where loading the Module left it", () => {
		let count = counters({
			module: "/Twice.es",
			points: [point(1), point(2)],
			choices: [],
		})
		let countsOf = () =>
			coverage()
				.find((each) => each.module === "/Twice.es")
				?.points.map((each) => each.count)

		// NOTE: What a Module's top-level Statements did as it was evaluated.
		count(0)

		beginCoverageRun()
		count(1)

		expect(countsOf()).toEqual([1, 1])

		beginCoverageRun()

		// NOTE: The load's count survives; the run's does not. A Module is
		// evaluated once however many times its tests are run, and zeroing what
		// it did would report every top-level Statement as never executed.
		expect(countsOf()).toEqual([1, 0])
	})
})

describe("Terminal capture", () => {
	test("hands what a Program writes to the sink installed around it", () => {
		let captured: Array<[string, string]> = []

		withOutputSink(
			(text, stream) => captured.push([stream, text]),
			() => {
				write(string("hello"), outputStream)
				inspect(createBoolean(true))
			},
		)

		expect(captured).toEqual([
			["output", "hello"],
			["output", "true\n"],
		])
	})

	test("puts the binding back when the call it wrapped is over", () => {
		let captured: Array<string> = []

		withOutputSink(
			(text) => captured.push(text),
			() => {
				withOutputSink(null, () => {})
				write(string("inner"), outputStream)
			},
		)

		expect(captured).toEqual(["inner"])
	})
})

describe("The made-up seed", () => {
	// NOTE: The eight hexadecimal characters are the contract `--seed` reads
	// back, so the format is pinned here even though the word inside it is the
	// machine's.
	test("answers eight hexadecimal characters", () => {
		expect(randomSeed()).toMatch(/^[0-9a-f]{8}$/)
	})
})
