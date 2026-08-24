import { describe, expect, test } from "bun:test"

import { createBoolean } from "../Boolean"
import { decode, type Generator } from "../Generators"
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
	beginCoverageSpan,
	touchedGround,
	type CorpusStore,
	coverage,
	counters,
	createContext,
	entry,
	expected,
	probe,
	properties,
	type PropertyParameter,
	randomSeed,
	type Range,
	registryOf,
	required,
	type RunOptions,
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
		cases: null,
		// NOTE: The id doubles as the key here the way it doubles as the name:
		// a spec that cares about the real spelling overrides it.
		key: id,
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

	// NOTE: What the measurement batches turn off. Recording is bookkeeping;
	// what a `require` DOES — end the run where it failed — is not, and holds
	// whatever the flag says.
	test("writes nothing down while recording is off, but still unwinds", () => {
		let context = createContext(0)

		context.recording = false
		trace(context, 1, integer(3))
		probe(context, 2, integer(4))
		expected(context, 0, false, null)

		let ended = false

		try {
			required(context, 3, false, null)
		} catch {
			ended = true
		}

		expect(ended).toBe(true)
		expect(context.traces).toEqual([])
		expect(context.probes).toEqual([])
		expect(context.expectations).toEqual([])
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
		coverage?: boolean
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
		coverage: options.coverage,
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
		[
			manifest("/bench", {
				benchmark: true,
				key: "doubling",
				...overrides,
			}),
		],
		(context) => {
			benchmark(context, 0, null, () => {
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

		// NOTE: The stream's copy of the reason. A consumer is told to ignore
		// the `benchmark` kind it may not know, so a regression that left
		// `error` empty would be a failure with no stated reason anywhere a
		// stranger reads.
		let failed = events.find((event) => event.kind === "test-fail")

		expect(failed).toMatchObject({ failures: [] })
		expect(
			(failed as Extract<TestEvent, { kind: "test-fail" }>).error,
		).toContain("slower than its baseline")
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
				benchmark(context, 0, null, () => {
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
	// NOTE: Seven batches of a body that takes seconds is a minute nobody
	// asked to wait — and the editor's run-by-id door has a session deadline
	// behind it. The tiers are arithmetic over the injected clock, like
	// everything else here.
	test("takes fewer samples of a body no batching helped", () => {
		let { clock, tick } = workClock(300)
		let { measured } = measure(registryOf([benchmarkModule(tick)]), {
			clock,
			filters: { bench: true },
		})

		expect(measured[0]).toMatchObject({
			iterations: 1,
			samples: 3,
			nanoseconds: 300_000_000,
		})
	})

	test("takes one sample of a body whose one run is the measurement", () => {
		let { clock, tick } = workClock(1_200)
		let { measured } = measure(registryOf([benchmarkModule(tick)]), {
			clock,
			filters: { bench: true },
		})

		expect(measured[0]).toMatchObject({ iterations: 1, samples: 1 })
	})

	// NOTE: A coverage run counts every branch the body takes, so a
	// measurement of it would be about the counters — and a baseline recorded
	// off one would fail the first uninstrumented run. The body still runs
	// once, as a test's would, so its lines are covered.
	test("runs a benchmark once, unmeasured, under coverage", () => {
		let ran = 0
		let { clock } = workClock(1)
		let registry = registryOf([
			module([manifest("/bench", { benchmark: true })], (context) => {
				benchmark(context, 0, null, () => {
					ran += 1
					expected(context, 0, true, null)
				})
			}),
		])
		let { measured, summary } = measure(registry, {
			clock,
			filters: { bench: true },
			coverage: true,
		})

		expect(measured).toEqual([])
		expect(ran).toBe(1)
		expect(summary.passed).toBe(1)
	})

	// turn could only ever match the last row that ran.
	test("keeps one stored entry per row of a table benchmark", () => {
		let { clock, tick } = workClock(1)
		let registry = registryOf([
			module(
				[
					manifest("/rows/0", {
						benchmark: true,
						row: 0,
						key: "sorts {size} rows/0",
					}),
					manifest("/rows/1", {
						benchmark: true,
						row: 1,
						key: "sorts {size} rows/1",
					}),
				],
				(context) => {
					benchmarkRows(
						context,
						0,
						[integer(1), integer(2)],
						null,
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
				"/Season.es": { "sorts {size} rows/1": 500_000 },
			},
		})

		expect(measured.map((event) => [event.key, event.status])).toEqual([
			["sorts {size} rows/0", "written"],
			["sorts {size} rows/1", "regressed"],
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

	// NOTE: Absolutes, because a span RESETS — that is the whole design: what
	// a case reaches is measured from the start of its own test, not from
	// whatever the process has touched before.
	test("counts a span's new ground once, however often it is walked", () => {
		let count = counters({
			module: "/Stamped.es",
			points: [point(1), point(2)],
			choices: [],
		})

		beginCoverageSpan()
		count(0)

		expect(touchedGround()).toBe(1)

		count(0)
		count(0)

		expect(touchedGround()).toBe(1)

		count(1)

		expect(touchedGround()).toBe(2)

		// NOTE: A new span starts from nothing, and the SAME points count as
		// fresh ground again — reached is a fact about the span, not about the
		// bundle.
		beginCoverageSpan()

		expect(touchedGround()).toBe(0)

		count(0)

		expect(touchedGround()).toBe(1)
	})

	// NOTE: The inverse of the affected-set map, per test: the run copies the
	// counts around each test and says which points moved. Only where it was
	// asked — the copy is every counter, per test.
	test("says which points each test touched, where the run asked", () => {
		let count = counters({
			module: "/Attributed.es",
			points: [point(1), point(2), point(3)],
			choices: [],
		})
		let one = module(
			[manifest("/first"), manifest("/second")],
			(context) => {
				entry(context, 0, null, () => {
					count(0)
					expected(context, 0, true, null)
				})
				entry(context, 1, null, () => {
					count(1)
					count(2)
					expected(context, 0, true, null)
				})
			},
		)
		let events: Array<TestEvent> = []

		runTests(registryOf([one]), {
			sink: (event) => events.push(event),
			now: () => 0,
			coverageByTest: true,
		})

		let attributed = events.filter(
			(event) =>
				event.kind === "test-coverage" &&
				event.module === "/Attributed.es",
		) as Array<Extract<TestEvent, { kind: "test-coverage" }>>

		expect(attributed.map((event) => [event.id, event.points])).toEqual([
			["/first", [0]],
			["/second", [1, 2]],
		])
	})

	test("attributes nothing where nobody asked", () => {
		let count = counters({
			module: "/Unasked.es",
			points: [point(1)],
			choices: [],
		})
		let one = module([manifest("/only")], (context) => {
			entry(context, 0, null, () => {
				count(0)
				expected(context, 0, true, null)
			})
		})
		let { events } = collect(registryOf([one]))

		expect(
			events.filter((event) => event.kind === "test-coverage"),
		).toEqual([])
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

// NOTE: The failing-example corpus, driven the way the emitted JavaScript
// drives it: a property test is `properties` standing where it was written, and
// what a run was told about the values it has failed on before is one more
// member of `RunOptions`.
describe("The failing-example corpus", () => {
	const integers: Generator = { kind: "integer" }
	const whole = (digits: string) =>
		({ kind: "integer", value: digits }) as const

	function wholeOf(value: AnyType): bigint {
		return BigInt((value as unknown as { value: number | bigint }).value)
	}

	// NOTE: One property test whose body decides for itself whether the case
	// held, so that no assertion below depends on which value was drawn.
	function property(
		holds: (value: AnyType) => boolean,
		options: {
			overrides?: Partial<TestManifestEntry>
			parameter?: PropertyParameter
			seen?: Array<AnyType>
		} = {},
	): TestModule {
		let parameter = options.parameter ?? {
			name: "n",
			generator: integers,
		}

		return module(
			[
				manifest("/a", {
					name: "stays small",
					key: "stays small",
					...options.overrides,
				}),
			],
			(context) => {
				properties(context, 0, null, [parameter], (value) => {
					options.seen?.push(value!)
					expected(context, 0, holds(value!), null)
				})
			},
		)
	}

	function runWith(
		one: TestModule,
		options: Partial<RunOptions> = {},
	): Array<TestEvent> {
		let events: Array<TestEvent> = []

		runTests(registryOf([one]), {
			sink: (event) => events.push(event),
			now: () => 0,
			seed: "deadbeef",
			cases: 5,
			...options,
		})

		return events
	}

	function reported(
		events: Array<TestEvent>,
	): Extract<TestEvent, { kind: "property" }> {
		let event = events.find((each) => each.kind === "property")

		expect(event).toBeDefined()

		return event as Extract<TestEvent, { kind: "property" }>
	}

	function corpus(entries: CorpusStore): Record<string, CorpusStore> {
		return { "/Season.es": entries }
	}

	// NOTE: THE point of a corpus. A value a search found once is the first
	// thing the next run asks about, so the regression is caught before any
	// randomness is spent — and reported as the value that is known to find it
	// rather than as whatever a fresh hundred cases turn up.
	test("re-runs a stored counterexample before it draws anything", () => {
		let seen: Array<AnyType> = []
		let events = runWith(
			property(() => false, { seen }),
			{
				counterexamples: corpus({
					"stays small": [
						{ values: [{ name: "n", data: whole("500") }] },
					],
				}),
			},
		)

		expect(reported(events)).toMatchObject({
			cases: 0,
			replayed: 1,
			stale: [],
			fromCorpus: true,
		})
		expect(wholeOf(seen[0]!)).toBe(500n)
		expect(kinds(events)).toContain("test-fail")
	})

	// NOTE: Still shrunk, rather than reported as it was stored: the code has
	// changed since the entry was written down, and it may now fail on
	// something smaller than what broke it the first time.
	test("shrinks a replayed failure the way it shrinks a drawn one", () => {
		let events = runWith(
			property(() => false),
			{
				counterexamples: corpus({
					"stays small": [
						{ values: [{ name: "n", data: whole("500") }] },
					],
				}),
			},
		)

		expect(reported(events).counterexample).toEqual([
			{ name: "n", value: "0" },
		])
	})

	test("draws its cases where every stored counterexample holds", () => {
		let events = runWith(
			property(() => true),
			{
				counterexamples: corpus({
					"stays small": [
						{ values: [{ name: "n", data: whole("500") }] },
					],
				}),
			},
		)

		expect(reported(events)).toMatchObject({
			cases: 5,
			replayed: 1,
			stale: [],
			fromCorpus: false,
			counterexample: null,
			encoded: null,
		})
		expect(kinds(events)).toContain("test-pass")
	})

	test("runs the stored cases in the order they were stored", () => {
		let seen: Array<AnyType> = []

		runWith(
			property(() => true, { seen }),
			{
				cases: 0,
				counterexamples: corpus({
					"stays small": [
						{ values: [{ name: "n", data: whole("7") }] },
						{ values: [{ name: "n", data: whole("9") }] },
					],
				}),
			},
		)

		expect(seen.map(wholeOf)).toEqual([7n, 9n])
	})

	// NOTE: The Types moved under the entry — here a Parameter that is a String
	// now and held an Integer when it was written down. It is not a
	// counterexample and not a failure: it is an entry the runner drops.
	test("says which stored entries no longer read back", () => {
		let events = runWith(
			property(() => true, {
				parameter: { name: "n", generator: { kind: "string" } },
			}),
			{
				counterexamples: corpus({
					"stays small": [
						{ values: [{ name: "n", data: whole("500") }] },
						{
							values: [
								{
									name: "n",
									data: { kind: "string", value: "held" },
								},
							],
						},
					],
				}),
			},
		)

		expect(reported(events)).toMatchObject({
			cases: 5,
			replayed: 1,
			stale: [0],
			fromCorpus: false,
		})
	})

	test("refuses a stored entry whose Parameters are no longer these", () => {
		let events = runWith(
			property(() => true),
			{
				counterexamples: corpus({
					"stays small": [
						{ values: [{ name: "count", data: whole("1") }] },
						{ values: [] },
						{
							values: [
								{ name: "n", data: whole("1") },
								{ name: "m", data: whole("2") },
							],
						},
					],
				}),
			},
		)

		expect(reported(events)).toMatchObject({
			replayed: 0,
			stale: [0, 1, 2],
		})
	})

	test("writes the shrunk counterexample down on a fresh failure", () => {
		let event = reported(runWith(property(() => false)))

		expect(event).toMatchObject({ fromCorpus: false, replayed: 0 })
		expect(event.encoded).toEqual([{ name: "n", data: whole("0") }])
		expect(decode(integers, event.encoded![0]!.data)).toEqual(
			createInteger(0n),
		)
	})

	// NOTE: A Namespace's own generator says how to BUILD a value and nothing
	// about what one is made of, so there is nothing to write down — and one
	// such Parameter costs the whole test its corpus, because half a case is
	// not a case.
	test("writes nothing down for a Parameter a Namespace generates", () => {
		let event = reported(
			runWith(
				property(() => false, {
					parameter: {
						name: "team",
						generator: {
							kind: "generated",
							name: "Team",
							generate: () => string("Lions"),
						},
					},
				}),
			),
		)

		expect(event.counterexample).toEqual([
			{ name: "team", value: '"Lions"' },
		])
		expect(event.encoded).toBeNull()
	})

	// NOTE: The key the Compiler's `relativeIdentityKey` spells, worked out
	// again here because a bundle imports nothing from the Compiler. The two
	// are pinned to each other by this string and its twin in the Compiler's
	// own spec.
	// NOTE: The key is the Compiler's, read off the manifest — the runtime
	// derives nothing, so the escaping exists in exactly one place and the
	// event repeats what the entry already said.
	test("names an entry by the key the Compiler spelled for it", () => {
		let event = reported(
			runWith(
				property(() => true, {
					overrides: { key: "table/a\\/b/2" },
				}),
			),
		)

		expect(event.module).toBe("/Season.es")
		expect(event.key).toBe("table/a\\/b/2")
	})

	// NOTE: The entry's own budget — a synthesized goal's — loses to an
	// explicit `--cases` and beats the silent default, in that order.
	test("runs an entry's own case budget unless the run named one", () => {
		let budgeted = property(() => true, { overrides: { cases: 7 } })

		expect(reported(runWith(budgeted, { cases: undefined }))).toMatchObject(
			{ cases: 7, requested: 7 },
		)
		expect(reported(runWith(budgeted, { cases: 3 }))).toMatchObject({
			cases: 3,
			requested: 3,
		})
	})

	test("replays nothing where the run was told about nothing", () => {
		expect(reported(runWith(property(() => true)))).toMatchObject({
			cases: 5,
			replayed: 0,
			stale: [],
			fromCorpus: false,
		})
	})
})

// NOTE: The coverage-guided search, driven the way the emitted JavaScript
// drives it: a property test is `properties` standing where it was written, and
// an instrumented bundle is one whose Module asked for `counters` and whose body
// calls them. There is no flag to turn any of this on — a bundle that counts
// nothing never fills the pool, which is what makes the modules below an A/B
// rather than two configurations.
describe("The coverage-guided search", () => {
	const integers: Generator = { kind: "integer" }

	function wholeOf(value: AnyType): bigint {
		return BigInt((value as unknown as { value: number | bigint }).value)
	}

	// NOTE: The guards are written as residues so that how OFTEN one holds is
	// the same whatever size the case was drawn at — the size ramp would
	// otherwise make an early case and a late one two different experiments.
	const MODULUS = 60n

	function residue(value: AnyType, wanted: bigint): boolean {
		return ((wholeOf(value) % MODULUS) + MODULUS) % MODULUS === wanted
	}

	function coveragePoint(kind: "statement" | "branch") {
		return {
			kind,
			label: "",
			scope: "",
			position: nowhere,
			refinement: false,
			tag: null,
		} as const
	}

	// NOTE: ONE property over two Parameters that fails only where BOTH of them
	// are inside a narrow guard — a case a blind search has to meet at once and
	// a guided one climbs to, holding whichever guard a kept case already met.
	//
	// `instrumented` is whether the Module registered counters at all, and
	// `gated` is whether the point it counts depends on a VALUE. The three
	// combinations are the whole experiment: only a counter that moves on a
	// value can tell the search that a case reached somewhere new.
	function pairing(options: {
		instrumented: boolean
		gated: boolean
		guardsA?: (value: AnyType) => boolean
	}): TestModule {
		let guardsA = options.guardsA ?? ((value) => residue(value, 13n))
		let count = options.instrumented
			? counters({
					module: "/Guided.es",
					points: [
						coveragePoint("statement"),
						coveragePoint("branch"),
					],
					choices: [],
				})
			: null

		return module([manifest("/pair", { key: "pair" })], (context) => {
			properties(
				context,
				0,
				null,
				[
					{ name: "a", generator: integers },
					{ name: "b", generator: integers },
				],
				(a, b) => {
					count?.(0)

					if (count !== null && options.gated && guardsA(a!)) {
						count(1)
					}

					required(
						context,
						0,
						!(guardsA(a!) && residue(b!, 41n)),
						null,
					)
				},
			)
		})
	}

	// NOTE: The seed and the case budget are PINNED, and the numbers below are
	// pinned to them: they were found by running the three modules over a sweep
	// of seeds and keeping one where the guided search finds the conjunction
	// well inside the budget and neither control finds it at all. Any change to
	// what the search draws, or in what order, moves them — which is the point
	// of writing them down.
	const SEED = "4e93e921"
	const BUDGET = 1200

	function search(
		one: TestModule,
		options: Partial<RunOptions> = {},
	): { found: boolean; cases: number; events: Array<TestEvent> } {
		let events: Array<TestEvent> = []

		runTests(registryOf([one]), {
			sink: (event) => events.push(event),
			now: () => 0,
			seed: SEED,
			cases: BUDGET,
			...options,
		})

		let event = events.find((each) => each.kind === "property") as
			| Extract<TestEvent, { kind: "property" }>
			| undefined

		return {
			found: event !== undefined && event.counterexample !== null,
			cases: event?.cases ?? -1,
			events,
		}
	}

	// NOTE: Instrumentation on its own is not guidance. Both modules here count,
	// and only the one whose counter depends on a VALUE ever reaches ground a
	// case can be credited with — so only that one fills the pool, and only that
	// one finds the conjunction. Asserted through the search's OUTCOME, because
	// the pool is the driver's own business and nothing exports it.
	test("fills its pool only where a case reached new ground", () => {
		let guided = search(pairing({ instrumented: true, gated: true }))
		let ungated = search(pairing({ instrumented: true, gated: false }))

		expect(guided.found).toBe(true)
		expect(guided.cases).toBe(806)
		expect(ungated.found).toBe(false)
		expect(ungated.cases).toBe(BUDGET)
	})

	// NOTE: THE value proof. The identical property, once in a Module that
	// counts and once in a Module that does not — which is the control the
	// no-flag design gives away for free, since a bundle with no counters in it
	// can not fill a pool however the driver is written. Same seed, same budget,
	// same generators: the only difference is whether anything told the search
	// where it had been.
	test("finds a conjunction the blind search does not, at one seed", () => {
		let guided = search(pairing({ instrumented: true, gated: true }))
		let blind = search(pairing({ instrumented: false, gated: false }))

		expect(guided.found).toBe(true)
		expect(guided.cases).toBe(806)
		expect(blind.found).toBe(false)
		expect(blind.cases).toBe(BUDGET)
	})

	// NOTE: A stored counterexample is asked before anything is drawn, and one
	// that reaches new ground is exactly the neighbourhood worth searching — so
	// the corpus does not only catch the bug it was written for, it hands the
	// search a place to start. Here the guard on `a` is a single value no draw
	// ever answers, so the pool can be seeded by the replay and by nothing else.
	test("searches around a stored value that broke new ground", () => {
		let narrow = () =>
			pairing({
				instrumented: true,
				gated: true,
				guardsA: (value) => wholeOf(value) === 12345n,
			})
		let corpus = {
			"/Season.es": {
				pair: [
					{
						values: [
							{
								name: "a",
								data: { kind: "integer", value: "12345" },
							} as const,
							{
								name: "b",
								data: { kind: "integer", value: "0" },
							} as const,
						],
					},
				],
			},
		}
		let seeded = search(narrow(), {
			seed: "2fedcba2",
			counterexamples: corpus,
		})
		let control = search(narrow(), { seed: "2fedcba2" })

		expect(seeded.found).toBe(true)
		expect(seeded.cases).toBe(339)
		// NOTE: The same run without the corpus. Nothing ever draws the value
		// the guard names, so the gated point is never counted, the pool never
		// holds a case worth searching around, and the conjunction is never met.
		expect(control.found).toBe(false)
		expect(control.cases).toBe(BUDGET)
	})

	// NOTE: The coin, the pick and the neighbour are all drawn from the test's
	// own seeded source, so `--seed` replays a guided run exactly — which is
	// what the command a failure prints promises.
	test("draws the same guided run twice for one seed", () => {
		let first = search(pairing({ instrumented: true, gated: true }))
		let again = search(pairing({ instrumented: true, gated: true }))

		expect(first.events).toEqual(again.events)
	})
})
