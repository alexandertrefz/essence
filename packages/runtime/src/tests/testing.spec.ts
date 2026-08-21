import { describe, expect, test } from "bun:test"

import { createBoolean } from "../Boolean"
import { createInteger } from "../Integer"
import { createList } from "../List"
import { createRecord } from "../Record"
import type { StreamType } from "../Stream"
import { createString } from "../String"
import { inspect, write, withOutputSink } from "../Terminal"
import {
	createContext,
	entry,
	expected,
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
		suitePath: [],
		tags: [],
		focused: false,
		skipped: null,
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
